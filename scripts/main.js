// 禅境花园优化 —— 1.0.0
//
// 功能：
//   1. 新增花园页：复制默认第一页（ZenMainGARDEN），多出一整页可种植位置。
//   2. 同种植物相邻：整理时把同种植物排在视觉上连续的槽位。
//   3. 自动位置整理：一键按植物种类重排当前页。
//   4. 手套 / 推车可以搬运「等待浇水」的植物（原版要等它进入下一阶段才行）。
//   5. 删除花园页时，页内植物按页序依次落到各花园的空位上。
//
// 实现要点：
//   - 额外页使用枚举外的 ID=4，通过给 zenGardenScene.getPlants / getSlotProps
//     打补丁来提供数据；原版 switch 只有 0~3 四个分支。
//   - 页面节点用 cc.instantiate 克隆，Cocos 会正确重映射 48 个槽位组件和所有层引用。
//   - 整理只重排「植物 -> 槽位」的绑定，不改动槽位自身的花盆/浮床装饰；
//     但必须同时把槽位的植物特性表（PF）和残留的幼苗节点一起换掉，
//     否则原版判定会认为这株植物「还在长」，手套 / 推车就选不中它。
//   - 可种植性判定直接调用游戏原生的 garden.judgePlantableInSlot，避免复刻规则。

const MOD_ID = 'zen-garden-optimize';
const MOD_VERSION = '1.0.0';

const ZEN_SCENE_MODULE = 'chunks:///_virtual/zenGardenScene.ts';
const ZEN_MODULE = 'chunks:///_virtual/ZenGarden.ts';
const ZEN_FEATURES_MODULE = 'chunks:///_virtual/ZenGardenFeatures.ts';
const PLAYER_PROPS_MODULE = 'chunks:///_virtual/PlayerProperties.ts';
const PLANTS_MODULE = 'chunks:///_virtual/Plants.ts';
const KEY_LISTENER_MODULE = 'chunks:///_virtual/KeyListener.ts';
const ARRAY_GET_MODULE = 'chunks:///_virtual/ArrayGet.ts';
const SPROUT_COUNT_MODULE = 'chunks:///_virtual/SproutCount.ts';

const EXTRA_PAGE_ID = 4;
const EXTRA_PAGE_NODE_NAME = 'ZenMainGARDEN_EXTRA';
const EXTRA_PAGES_KEY = 'extraPages';
const LEGACY_SLOTS_KEY = 'slotsInExtra';
const LEGACY_PLANTS_KEY = 'plantsInExtra';
const MAIN_PAGE_ID = 0;
const MAX_PAGE_NAME_LENGTH = 20;

const UI_ID = 'zge-toolbox';
const UI_STYLE_ID = 'zge-toolbox-style';
const PANEL_ID = 'zge-pages';
const MODAL_ID = 'zge-modal';
const POLL_INTERVAL_MS = 500;
const UI_VISIBILITY_INTERVAL_MS = 50;
const PATCH_VERSION = 4;   // 改动 getPlants/getSlotProps 补丁逻辑时 +1
const TOOL_PATCH_VERSION = 5;   // 改动手套 / 推车适配补丁时 +1

let ctx = null;
let cc = null;
let modules = null;
let pollTimer = null;
let uiVisibilityTimer = null;
let uiRoot = null;
let uiButtons = null;
let panelRoot = null;
let panelList = null;
let panelSelected = null;
let activeScene = null;
const extraPages = new Map();   // id -> ZenGarden 组件
let busy = false;
let stopped = false;
let restored = false;
let sessionToken = 0;      // 每次 setup/cleanup 递增，用于作废过期的异步创建
let rebuilding = false;     // 重建额外页期间，避免与新增/删除操作打架
let repairing = false;      // 坏状态修复进行中，避免和整理 / 页面重建打架

function log(level, message) {
  const line = `[${MOD_ID}] ${message}`;
  try {
    const target = ctx && ctx.log && ctx.log[level];
    if (typeof target === 'function') {
      target.call(ctx.log, line);
      return;
    }
  } catch (_) {
    // fall through
  }
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  try {
    console[method](line);
  } catch (_) {
    // 日志失败不能影响事务
  }
}

function toast(message, type) {
  try {
    if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') {
      ctx.ui.toast(message, type || 'info');
    }
  } catch (error) {
    log('warn', `toast failed: ${String(error)}`);
  }
}

async function loadSystemModule(path) {
  const engine = ctx && ctx.unsafe && ctx.unsafe.engine;
  if (engine && typeof engine.getSystemModule === 'function') {
    const result = await engine.getSystemModule(path);
    if (result) return result;
  }
  const system = globalThis.System;
  if (system && typeof system.import === 'function') return system.import(path);
  throw new Error(`system module unavailable: ${path}`);
}

function collectComponents(node, className, acc) {
  if (!node) return acc;
  for (const component of node.components || []) {
    if (component && component.__classname__ === className) acc.push(component);
  }
  for (const child of node.children || []) collectComponents(child, className, acc);
  return acc;
}

function findZenScene() {
  const scene = cc && cc.director && cc.director.getScene();
  if (!scene) return null;
  const found = collectComponents(scene, 'zenGardenScene', []);
  return found.length ? found[0] : null;
}

function getPlayer() {
  const props = modules && modules.playerProps && modules.playerProps.AllPlayerProperties;
  return props ? props.currentPlayer : null;
}

function ensureExtraStorage() {
  const player = getPlayer();
  if (!player || !player.zengarden) return null;
  const zengarden = player.zengarden;
  if (!Array.isArray(zengarden[EXTRA_PAGES_KEY])) {
    zengarden[EXTRA_PAGES_KEY] = [];
    // 早期开发版本用的是固定 key，这里做一次迁移。
    if (Array.isArray(zengarden[LEGACY_PLANTS_KEY]) && zengarden[LEGACY_PLANTS_KEY].length) {
      zengarden[EXTRA_PAGES_KEY].push({
        id: EXTRA_PAGE_ID,
        slots: Array.isArray(zengarden[LEGACY_SLOTS_KEY]) ? zengarden[LEGACY_SLOTS_KEY] : [],
        plants: zengarden[LEGACY_PLANTS_KEY],
      });
    }
  }
  // 旧版本的固定 key 必须无条件清掉，否则会被仍在运行的旧补丁继续写入。
  delete zengarden[LEGACY_SLOTS_KEY];
  delete zengarden[LEGACY_PLANTS_KEY];
  return player.zengarden;
}

function findExtraPageRecord(storage, id) {
  if (!storage) return null;
  const list = storage[EXTRA_PAGES_KEY] || [];
  return list.find((page) => page && page.id === id) || null;
}

// 页面内植物在存档里按位置排序，这样查看存档 JSON 时和看到的一致。
function sortPagePlants(storage, id) {
  const record = findExtraPageRecord(storage, id);
  if (!record || !Array.isArray(record.plants)) return;
  record.plants.sort((a, b) => Number(a && a.pos || 0) - Number(b && b.pos || 0));
}

function nextExtraPageId(storage) {
  const list = (storage && storage[EXTRA_PAGES_KEY]) || [];
  // 紧凑分配：优先复用被删掉的低位 ID，避免出现「新增页 1/2/4」这种跳号。
  const used = new Set();
  for (const page of list) {
    const id = Number(page && page.id);
    if (Number.isFinite(id)) used.add(id);
  }
  let id = EXTRA_PAGE_ID;
  while (used.has(id)) id++;
  return id;
}

function savePlayer() {
  const props = modules && modules.playerProps && modules.playerProps.AllPlayerProperties;
  if (props && typeof props.savePP === 'function') props.savePP();
}

// ---------------------------------------------------------------- 额外页

function patchZenScene(zenScene) {
  if (!zenScene) return;
  const proto = Object.getPrototypeOf(zenScene);
  if (!proto) return;
  // 补丁版本化：逻辑变更后版本号 +1，避免旧补丁残留导致新补丁装不上。
  if (proto.__zgePatched && proto.__zgePatchVersion === PATCH_VERSION) return;
  if (typeof proto.__zgeRestore === 'function') {
    try {
      proto.__zgeRestore();
    } catch (error) {
      log('warn', `restore previous patch failed: ${String(error)}`);
    }
  }

  const originalGetPlants = proto.getPlants;
  const originalGetSlotProps = proto.getSlotProps;

  proto.getPlants = function getPlants(type) {
    const record = findExtraPageRecord(ensureExtraStorage(), type);
    if (record) return record.plants;
    return originalGetPlants.call(this, type);
  };

  proto.getSlotProps = function getSlotProps(type) {
    const record = findExtraPageRecord(ensureExtraStorage(), type);
    if (record) return record.slots;
    return originalGetSlotProps.call(this, type);
  };

  proto.__zgePatched = true;
  proto.__zgePatchVersion = PATCH_VERSION;
  proto.__zgeRestore = function restore() {
    proto.getPlants = originalGetPlants;
    proto.getSlotProps = originalGetSlotProps;
    delete proto.__zgePatched;
    delete proto.__zgePatchVersion;
    delete proto.__zgeRestore;
  };
  log('info', 'patched zenGardenScene.getPlants / getSlotProps');
}

function unpatchZenScene() {
  const proto = activeScene && Object.getPrototypeOf(activeScene);
  if (proto && typeof proto.__zgeRestore === 'function') {
    proto.__zgeRestore();
    log('info', 'restored zenGardenScene prototype');
  }
}

// ------------------------------------------------- 手套 / 推车：待浇水的植物
//
// 原版把「等待浇水 / 肥料」阶段的植物判为不可操作：
//   手套：ZenGardenSlot.judgeSelection 里 `this.plant && this.stuck` 直接把槽位置灰；
//   推车：`this.plant && !this.stuck && !this.sprout` 反过来把待浇水的排除掉；
//   zenGardenScene.cart 里还会用 `willMovePlantSlot.stuck` 把手上的植物退回去。
// 而 stuck 恰好就是「花盆冒金光」之前的那个阶段（stuck 时花盆播 Idle，
// 进入下一阶段后播 Idle_Golden），所以这类植物既拿不起来也推不走。
//
// 这里把限制放开，并且保证搬动之后仍然是「待浇水」状态，需求图标也跟着走。

// 手套 / 推车处于「选择源植物」阶段，而不是已经拿着植物选目标位。
function sourceSelectionActive() {
  const scene = activeScene;
  if (!scene) return false;
  if (scene.isGloving && !scene.willMovePlantSlot) return true;
  if (scene.isCarting && !scene.plantInCart) return true;
  return false;
}

function setSlotEnabledColor(slot) {
  if (!cc || !cc.Color) return;
  const color = new cc.Color(255, 255, 255, 255);
  if (slot.pot) slot.pot.color = color;
  if (slot.floater) slot.floater.color = color;
  if (slot.sprout && slot.sprout.db) slot.sprout.db.color = color;
  if (slot.plantAnmControl && slot.plantAnmControl.db) slot.plantAnmControl.db.color = color;
}

function patchToolMove() {
  const zenModule = modules && modules.zen;
  const sceneModule = modules && modules.zenScene;
  const SlotClass = zenModule && zenModule.ZenGardenSlot;
  const SceneClass = sceneModule && sceneModule.zenGardenScene;
  if (!SlotClass || !SceneClass) return;

  const slotProto = SlotClass.prototype;
  const sceneProto = SceneClass.prototype;
  if (slotProto.__zgeToolPatched && slotProto.__zgeToolPatchVersion === TOOL_PATCH_VERSION) return;
  if (typeof slotProto.__zgeToolRestore === 'function') {
    try {
      slotProto.__zgeToolRestore();
    } catch (error) {
      log('warn', `restore previous tool patch failed: ${String(error)}`);
    }
  }

  const originalJudgeSelection = slotProto.judgeSelection;
  const originalMovePlant = slotProto.movePlant;
  const originalReceivePlant = slotProto.receivePlant;
  const originalCart = sceneProto.cart;
  const cartDescriptor = Object.getOwnPropertyDescriptor(sceneProto, 'plantInCart');

  slotProto.judgeSelection = function judgeSelection() {
    // 不能在这里清理 sprout。原版 movePlant 会先调用 showSprout 重建源槽的
    // 空槽提示，而 showSprout 内部会立即执行 judgeSelection；此时旧 plant /
    // plantAnmControl 还没清空，把 sprout 当残留删除会正好抹掉空槽的种植 UI。
    const result = originalJudgeSelection.call(this);
    // 幼苗、成长中、成熟和待浇水植物的可搬运性统一：只要求在源选择阶段，
    // 且槽位已解锁。拿着植物选目标时仍完全沿用原版目标判定。
    if (this.plant && !this.Locked && sourceSelectionActive()) {
      this.disabled = false;
      setSlotEnabledColor(this);
    }
    return result;
  };

  // 所有生长阶段统一使用原版 removePlant / receivePlant 数据路径。
  // 原版 movePlant 只搬运成熟 plantAnmControl，幼苗没有该节点会静默失败。
  slotProto.movePlant = function movePlant(target) {
    const plant = this.plant;
    if (!plant || !target || target.plant || target.Locked) return;
    if (!this.sprout && !this.plantAnmControl) return;
    if (typeof this.removePlant !== 'function' || typeof target.receivePlant !== 'function') return;
    this.removePlant();
    const result = target.receivePlant(plant);
    Promise.resolve(result).catch((error) => {
      log('warn', `move plant failed: ${String(error && error.stack || error)}`);
    });
    return result;
  };

  // 手套选中任意生长阶段后直接切到推车：原版会因 stuck / sprout 拒绝。
  sceneProto.cart = function cart() {
    const slot = this.willMovePlantSlot;
    const plant = slot && slot.plant;
    if (slot && plant && !this.plantInCart) {
      this.plantInCart = plant;
      slot.removePlant();
      this.indexTo_1();
      this.isCarting = false;
      return;
    }
    return originalCart.call(this);
  };

  // receivePlant 会按目标槽的空状态重建显示，先记住 incoming plant 的待浇水状态，
  // 再交给原版；完成后恢复 stuck / 需求图标，保证幼苗与成熟植物的搬运语义一致。
  slotProto.receivePlant = function receivePlant(plant) {
    const wasStuck = !!(plant && plant.stuck);
    const requirement = plant && Number.isFinite(plant.requirement) ? plant.requirement : 0;
    const result = originalReceivePlant.call(this, plant);
    if (!wasStuck) return result;
    return Promise.resolve(result).then(() => {
      if (this.plant !== plant) return;
      this.stuck = true;
      if (!this.requirePar) this.addRequire(requirement);
      this.judgeSelection();
    }).catch((error) => {
      log('warn', `restore moved plant state failed: ${String(error && error.stack || error)}`);
    });
  };

  function destroyCartPreview(scene) {
    const preview = scene && scene.plantInCartAnm;
    if (preview && preview.node && preview.node.isValid) preview.node.destroy();
    if (scene) scene.plantInCartAnm = null;
  }

  function createCartSproutPreview(scene, plant) {
    if (!cc || !scene.sproutPar || !scene.plantInCartLayer) return false;
    const node = cc.instantiate(scene.sproutPar);
    node.parent = scene.plantInCartLayer;
    const sprout = (node.components || []).find((component) => (
      component && component.db && typeof component.db.playAnimation === 'function'
    ));
    if (!sprout) {
      node.destroy();
      return false;
    }
    sprout.db.timeScale = 0.9 + 0.2 * Math.random();
    sprout.db.playAnimation('Idle');
    scene.plantInCartAnm = sprout;
    const scale = 0.3;
    node.setScale(scale, scale, scale);
    if (scene.cartUI && scene.cartUI.node) {
      node.worldPosition = scene.cartUI.node.worldPosition.clone().add(new cc.Vec3(0, 20, 0));
    }
    return true;
  }

  if (cartDescriptor && cartDescriptor.get && cartDescriptor.set) {
    Object.defineProperty(sceneProto, 'plantInCart', {
      configurable: true,
      enumerable: cartDescriptor.enumerable,
      get: cartDescriptor.get,
      set: function plantInCart(plant) {
        if (!plant) {
          cartDescriptor.set.call(this, plant);
          return;
        }
        if (this._plantInCart === plant) return;
        const fullTime = modules && modules.zen && Number(modules.zen.ZenGardenPlantFullTime);
        const stage = fullTime > 0
          ? Math.floor(4 * (Number(plant.grownTime) || 0) / fullTime)
          : 1;
        // 阶段 0 在花园里本来就是通用幼苗，不能在推车里提前展示成熟植物。
        if (stage <= 0) {
          destroyCartPreview(this);
          if (createCartSproutPreview(this, plant)) {
            this._plantInCart = plant;
            const player = getPlayer();
            if (player && player.zengarden) player.zengarden.plantInCart = plant;
            savePlayer();
            return;
          }
        }
        cartDescriptor.set.call(this, plant);
      },
    });
  }

  const restore = function restore() {
    slotProto.judgeSelection = originalJudgeSelection;
    slotProto.movePlant = originalMovePlant;
    slotProto.receivePlant = originalReceivePlant;
    sceneProto.cart = originalCart;
    if (cartDescriptor) Object.defineProperty(sceneProto, 'plantInCart', cartDescriptor);
    delete slotProto.__zgeToolPatched;
    delete slotProto.__zgeToolPatchVersion;
    delete slotProto.__zgeToolRestore;
    delete sceneProto.__zgeToolRestore;
  };
  slotProto.__zgeToolPatched = true;
  slotProto.__zgeToolPatchVersion = TOOL_PATCH_VERSION;
  slotProto.__zgeToolRestore = restore;
  sceneProto.__zgeToolRestore = restore;
  log('info', 'patched glove / cart for stuck plants');
}

function unpatchToolMove() {
  const zenModule = modules && modules.zen;
  const SlotClass = zenModule && zenModule.ZenGardenSlot;
  if (!SlotClass) return;
  const proto = SlotClass.prototype;
  if (typeof proto.__zgeToolRestore === 'function') {
    proto.__zgeToolRestore();
    log('info', 'restored glove / cart patch');
  }
}

function makeSlotProps(count) {
  const factory = modules && modules.zenFeatures && modules.zenFeatures.ZenGardenSlotProperties;
  const props = [];
  for (let i = 0; i < count; i++) {
    const item = factory ? new factory() : {};
    item.unlocked = true;
    props.push(item);
  }
  return props;
}

async function createExtraPage(zenScene, record) {
  if (!zenScene || !record) return null;
  const token = sessionToken;
  const gardens = zenScene.ZenGardens || [];
  const main = gardens.find((garden) => garden.ID === MAIN_PAGE_ID);
  if (!main || !main.node) {
    log('warn', 'main garden not ready, extra page deferred');
    return null;
  }

  let clone = null;
  try {
    clone = cc.instantiate(main.node);
  } catch (error) {
    log('error', `instantiate failed: ${String(error && error.stack || error)}`);
    return null;
  }

  clone.name = `${EXTRA_PAGE_NODE_NAME}_${record.id}`;
  clone.parent = zenScene.zenParent;
  // 页面位置必须与主页面一致：镜头缩放/平移是按当前页的角点（NE/SW）算的，
  // 挪走会导致切到该页时视野里是空地。页面重叠没关系，switchZen 只会激活当前页。
  const base = main.node.position;
  clone.setPosition(base.x, base.y, base.z);
  clone.active = false;

  const garden = clone.getComponent && clone.getComponent('ZenGarden');
  if (!garden) {
    log('error', 'cloned node has no ZenGarden component');
    clone.destroy();
    return null;
  }

  garden.ID = record.id;
  // 顺带把历史遗留的乱序 plants 按位置排好。
  sortPagePlants(ensureExtraStorage(), record.id);

  const slots = garden.slots || [];

  // 关键：cc.instantiate 会把主页面运行时生成的子节点一起复制过来
  // （48 个花盆、48 个幼苗、以及主页面植物的显示节点）。
  // 必须清空，否则额外页会带着主页面植物的"幽灵副本"。
  clearRuntimeChildren(garden);
  slots.forEach((slot) => {
    slot.plant = null;
    slot.plantAnmControl = null;
    slot.sprout = null;
    slot.requirePar = null;
    slot.shade = null;
    slot.inZen = null;
  });
  garden.initialized = false;

  const slotProps = makeSlotProps(slots.length);
  record.slots = slotProps;
  slots.forEach((slot, index) => {
    slot.SlotProp = slotProps[index];
    slot.unlockOnInit = true;
  });

  zenScene.ZenGardens = gardens.concat([garden]);
  extraPages.set(record.id, garden);

  try {
    // 等待被销毁的旧节点真正出栈，避免和新建节点同帧共存。
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (token !== sessionToken || stopped) {
      // 期间模组已被停用或重建，丢弃这次创建。
      try {
        if (clone && clone.isValid) clone.destroy();
      } catch (_) {
        // ignore
      }
      extraPages.delete(record.id);
      return null;
    }
    if (typeof garden.initialize === 'function') await garden.initialize(record.plants);
  } catch (error) {
    log('warn', `extra page initialize failed: ${String(error && error.stack || error)}`);
  }

  savePlayer();
  log('info', `extra page created: id=${record.id} slots=${slots.length}`);
  return garden;
}

// 进入花园时按存档重建所有额外页。
async function rebuildExtraPages(zenScene) {
  if (!zenScene) return;
  rebuilding = true;
  purgeExtraPages(zenScene);
  const storage = ensureExtraStorage();
  if (!storage) {
    rebuilding = false;
    return;
  }
  const records = (storage[EXTRA_PAGES_KEY] || []).slice();
  for (const record of records) {
    if (!record || typeof record.id !== 'number') continue;
    if (!Array.isArray(record.plants)) record.plants = [];
    await createExtraPage(zenScene, record);
  }
  rebuilding = false;
  log('info', `extra pages rebuilt: ${extraPages.size}`);
}

// 新增一张额外页（复制默认第一页）。
async function addExtraPage(zenScene) {
  while (rebuilding) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const storage = ensureExtraStorage();
  if (!storage) {
    toast('存档不可用，无法新增页面', 'error');
    return null;
  }
  const id = nextExtraPageId(storage);
  const record = { id, slots: [], plants: [] };
  storage[EXTRA_PAGES_KEY].push(record);
  const garden = await createExtraPage(zenScene, record);
  if (!garden) {
    storage[EXTRA_PAGES_KEY] = storage[EXTRA_PAGES_KEY].filter((item) => item !== record);
    return null;
  }
  savePlayer();
  return garden;
}

// 给一批植物找落脚点（干跑，不改动任何状态）。
// 按花园页的顺序依次找空位：主花园满了就去下一个页，直到所有页都没有位置。
// 返回 Map<植物对象, { slot, garden }>；分配不全时说明所有页都放不下。
function planMoveAcrossPages(zenScene, excludePageId, plants) {
  const assignment = new Map();
  if (!zenScene || !plants || !plants.length) return assignment;
  const gardens = (zenScene.ZenGardens || []).filter((item) => item && item.ID !== excludePageId);
  if (!gardens.length) return assignment;
  const used = new Set();
  for (const plant of plants) {
    const type = plant && plant.plant;
    if (!type) continue;
    let target = null;
    for (const garden of gardens) {
      const free = (garden.slots || []).filter((slot) => slot && !slot.plant && isUnlocked(slot));
      for (const slot of free) {
        const key = `${garden.ID}:${slot.pos}`;
        if (used.has(key)) continue;
        if (!canPlace(garden, slot, type)) continue;
        target = { slot, garden };
        used.add(key);
        break;
      }
      if (target) break;
    }
    if (!target) continue;
    assignment.set(plant, target);
  }
  return assignment;
}

// 找出当前持有这株植物的槽位。
function findSourceSlot(garden, plant) {
  if (!garden) return null;
  for (const slot of garden.slots || []) {
    if (slot && slot.plant === plant) return slot;
  }
  return null;
}

// 删除一张额外页（默认页不可删）。页内植物会搬到其它花园的空位，绝不随页消失。
// 异步：需要等植物真正落到主花园的槽位上。
async function removeExtraPageById(zenScene, id) {
  if (!zenScene || typeof id !== 'number' || id < EXTRA_PAGE_ID) {
    return { ok: false, reason: 'invalid' };
  }
  const storage = ensureExtraStorage();
  if (!storage) return { ok: false, reason: 'no-storage' };
  const record = findExtraPageRecord(storage, id);
  if (!record) return { ok: false, reason: 'not-found' };

  const garden = extraPages.get(id);
  const main = (zenScene.ZenGardens || []).find((item) => item.ID === MAIN_PAGE_ID);
  const pagePlants = Array.isArray(record.plants) ? record.plants.slice() : [];
  // 推车里那株如果原本属于本页，也要一起搬走，不能留下悬空引用。
  const cartPlant = zenScene.plantInCart && zenScene.plantInCart.inZen === id ? zenScene.plantInCart : null;
  const moving = cartPlant ? pagePlants.concat([cartPlant]) : pagePlants;

  let assignment = new Map();
  if (moving.length) {
    assignment = planMoveAcrossPages(zenScene, id, moving);
    if (assignment.size < moving.length) {
      // 所有花园页都放不下就拒绝删除：宁可让用户先腾位置，也不能把植物弄丢。
      return { ok: false, reason: 'no-space', moved: assignment.size, total: moving.length };
    }
  }

  // 需要搬植物时、或当前页就是即将删掉的页时，先切到承接植物的那一页（一般是主花园）。
  const landing = assignment.size
    ? assignment.values().next().value.garden
    : main;
  const needSwitch = landing && zenScene.currentZen && zenScene.currentZen.ID !== landing.ID;
  if (needSwitch) {
    const landingIndex = (zenScene.ZenGardens || []).indexOf(landing);
    if (landingIndex >= 0) {
      try {
        await zenScene.switchZen(landingIndex);
      } catch (error) {
        log('warn', `switch to landing page before removing page failed: ${String(error)}`);
      }
    }
  }

  let moved = 0;
  const movedPlants = [];
  for (const [plant, target] of assignment) {
    const slot = target.slot;
    const source = findSourceSlot(garden, plant);
    if (source) source.plant = null;
    try {
      // receivePlant 会正确设置 pos/inZen/PF、把植物显示出来并写入目标页的存档。
      await slot.receivePlant(plant);
      moved++;
      movedPlants.push(plant);
    } catch (error) {
      log('error', `move plant to main failed: ${String(error && error.stack || error)}`);
      // 搬失败就把植物放回原槽位，避免出现「存档里有、屏幕上没有」的幽灵植物。
      if (slot.plant === plant) slot.plant = null;
      if (source) source.plant = plant;
    }
  }
  // 已经搬走的植物要从本页记录里摘掉，否则这一页留下来时会变成重复的幽灵植物。
  if (movedPlants.length && Array.isArray(record.plants)) {
    const gone = new Set(movedPlants);
    record.plants = record.plants.filter((plant) => !gone.has(plant));
  }
  if (moved < moving.length) {
    // 理论上不会发生（前面已预检过位置）；发生了也不能删页，先把植物留在原页。
    log('error', `move incomplete: ${moved}/${moving.length}, page ${id} kept`);
    return { ok: false, reason: 'move-failed', moved, total: moving.length };
  }
  if (cartPlant) {
    try {
      zenScene.plantInCart = null;
    } catch (error) {
      log('warn', `clear plantInCart failed: ${String(error)}`);
    }
  }

  if (garden) {
    try {
      if (garden.node && garden.node.isValid) garden.node.destroy();
    } catch (error) {
      log('warn', `destroy extra page ${id} failed: ${String(error)}`);
    }
    zenScene.ZenGardens = (zenScene.ZenGardens || []).filter((item) => item !== garden);
  }
  extraPages.delete(id);
  storage[EXTRA_PAGES_KEY] = storage[EXTRA_PAGES_KEY].filter((item) => item !== record);
  savePlayer();
  log('info', `extra page removed: id=${id}, moved ${moved} plants to other gardens`);
  return { ok: true, moved, total: moving.length };
}

// 清掉页面各层里运行时生成的节点（花盆/幼苗/阴影/植物显示/选中框）。
function clearRuntimeChildren(garden) {
  const layers = [garden.PotLayer, garden.ShadeLayer, garden.PlantLayer, garden.UILayer, garden.droppingLayer];
  for (const layer of layers) {
    if (!layer) continue;
    const children = (layer.children || []).slice();
    for (const child of children) {
      try {
        child.destroy();
      } catch (error) {
        log('warn', `clear layer child failed: ${String(error)}`);
      }
    }
  }
}

function removeExtraPage() {
  const scene = activeScene;
  purgeExtraPages(scene);
  extraPages.clear();
}

// 清掉所有额外页条目（含已销毁但仍挂在数组里的僵尸）。
function purgeExtraPages(zenScene) {
  if (!zenScene || !Array.isArray(zenScene.ZenGardens)) return 0;
  const stale = zenScene.ZenGardens.filter((garden) => garden && garden.ID >= EXTRA_PAGE_ID);
  for (const garden of stale) {
    try {
      if (garden.node && garden.node.isValid) garden.node.destroy();
    } catch (error) {
      log('warn', `destroy extra page failed: ${String(error)}`);
    }
  }
  if (stale.length) {
    zenScene.ZenGardens = zenScene.ZenGardens.filter((garden) => garden.ID < EXTRA_PAGE_ID);
  }
  return stale.length;
}

// ---------------------------------------------------------------- 整理引擎

function orderSlots(slots) {
  return slots
    .map((slot, index) => ({
      slot: slot,
      index: index,
      x: slot.node && slot.node.position ? slot.node.position.x : 0,
      y: slot.node && slot.node.position ? slot.node.position.y : 0,
    }))
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) > 20) return b.y - a.y;
      return a.x - b.x;
    });
}

function groupPlantsByType(slots) {
  const groups = new Map();
  const plants = [];
  for (const slot of slots) {
    if (!slot.plant) continue;
    const type = slot.plant.plant;
    if (!type) continue;
    plants.push({ slot: slot, plant: slot.plant, type: type });
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(plants[plants.length - 1]);
  }
  return { groups: groups, plants: plants };
}

function canPlace(garden, slot, plantType) {
  try {
    // 注意：judgePlantableInSlot 是 ZenGarden 类上的静态方法，不是实例方法。
    const zenClass = modules && modules.zen && modules.zen.ZenGarden;
    if (!zenClass || typeof zenClass.judgePlantableInSlot !== 'function') return false;
    return !!zenClass.judgePlantableInSlot(slot, plantType);
  } catch (error) {
    return false;
  }
}

// 取植物特性表。PF 决定植物是「土里 / 浮床 / 飞行」，也决定显示节点的高度偏移，
// 必须跟着植物一起换，否则整理后植物会画错位置。
function getPlantFeatureByType(plantType) {
  const plantsModule = modules && modules.plants;
  const api = plantsModule && (plantsModule.plants || plantsModule);
  if (!api || typeof api.getPlantFeatureByType !== 'function') return null;
  try {
    return api.getPlantFeatureByType(plantType) || null;
  } catch (error) {
    return null;
  }
}

function isUnlocked(slot) {
  if (slot.unlockOnInit) return true;
  return !!(slot.SlotProp && slot.SlotProp.unlocked);
}

function planArrangement(garden) {
  const slots = garden.slots || [];
  const ordered = orderSlots(slots);
  const usable = ordered.filter((entry) => isUnlocked(entry.slot));
  const groups = groupPlantsByType(slots).groups;

  const types = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
  const assignment = new Map();
  const used = new Set();
  let cursor = 0;

  for (const type of types) {
    const members = groups.get(type);
    const picked = [];
    let scan = cursor;
    while (picked.length < members.length && scan < usable.length) {
      const entry = usable[scan];
      if (!used.has(entry.index) && canPlace(garden, entry.slot, type)) {
        picked.push(entry);
        used.add(entry.index);
      }
      scan++;
    }
    if (picked.length < members.length) {
      for (const entry of usable) {
        if (picked.length >= members.length) break;
        if (used.has(entry.index)) continue;
        if (!canPlace(garden, entry.slot, type)) continue;
        picked.push(entry);
        used.add(entry.index);
      }
    }
    members.forEach((item, i) => {
      const target = picked[i];
      if (target) assignment.set(item.plant, target.index);
    });
    if (picked.length) {
      const last = picked[picked.length - 1];
      const lastOrder = usable.findIndex((entry) => entry.index === last.index);
      cursor = Math.max(cursor, lastOrder + 1);
    }
  }

  return { assignment: assignment, usable: usable };
}

// 把槽位上的植物整个拆掉，语义对齐原版 ZenGardenSlot.removePlant：
// 需求图标和显示节点要清干净，否则原版判定会认为「这株还在长」，
// 手套 / 推车都选不中。
// 幼苗节点故意留着不动：它的销毁由原版 showPlant 负责（走的是游戏自己的
// 节点池回收路径），我们只负责在植物长成之后让它自己被收掉。
function clearSlotOccupant(slot) {
  try {
    if (slot.requirePar) {
      const node = slot.requirePar.node;
      slot.requirePar = null;
      if (node && node.isValid) node.destroy();
    }
    if (slot.plantAnmControl) {
      const node = slot.plantAnmControl.node;
      slot.plantAnmControl = null;
      if (node && node.isValid) node.destroy();
    }
    slot.plant = null;
    slot.stuck = false;
  } catch (error) {
    log('warn', `clear slot failed: ${String(error)}`);
  }
}

// 把植物装回槽位，语义对齐原版 ZenGardenSlot.receivePlant：
// 先换 PF，再改 pos / inZen，最后重画。
function attachPlantToSlot(garden, slot, plant) {
  const feature = getPlantFeatureByType(plant.plant);
  if (feature) slot.PF = feature;
  slot.plant = plant;
  plant.pos = slot.pos;
  plant.inZen = garden.ID;
}

// 槽位显示出植物（对齐原版 initialize 的调用方式）。
async function showSlotPlant(garden, slot) {
  const layer = (slot.inZen && slot.inZen.PlantLayer) || garden.PlantLayer;
  await slot.showPlant(layer);
}

function currentSproutCount() {
  const component = modules?.sproutCount?.SproutCount?.component;
  if (component && Number.isFinite(Number(component.value))) return Number(component.value);
  const player = getPlayer();
  return player && Number.isFinite(Number(player.sprout)) ? Number(player.sprout) : 0;
}

function plantChoicesForSlot(slot) {
  const allProps = modules?.playerProps?.AllPlayerProperties;
  const zenClass = modules?.zen?.ZenGarden;
  if (!allProps || !zenClass || typeof allProps.getObtainedPlantTypes !== 'function') return [];
  const obtained = allProps.getObtainedPlantTypes();
  const zengarden = getPlayer() && getPlayer().zengarden;
  const choices = [];

  (obtained.Types || []).forEach((type, index) => {
    let weight = 8;
    const feature = getPlantFeatureByType(type);
    const fixedWeight = Number(feature?.ZENGARDEN?.FixedWeight);
    if (Number.isFinite(fixedWeight) && fixedWeight >= 0) {
      weight = fixedWeight;
    } else {
      let recent = 0;
      const progress = obtained.PPs && obtained.PPs[index];
      if (progress) {
        if (progress.medal) recent = 3;
        else recent += Number(progress.boost) || 0;
      }
      if (recent < 3) {
        if (zengarden?.plantInCart?.plant === type) recent++;
        for (const key of ['plantsInNight', 'plantsInBeach', 'plantsInMain', 'plantsInMushroom']) {
          if ((zengarden?.[key] || []).some((plant) => plant && plant.plant === type)) {
            recent++;
            if (recent >= 3) break;
          }
        }
      }
      if (recent === 1) weight = 32;
      else if (recent === 2) weight = 128;
      else if (recent >= 3) weight = 1;
    }
    if (weight > 0 && zenClass.judgePlantableInSlot(slot, type)) {
      choices.push({ weight: weight, props: { type: type } });
    }
  });

  // 与原版空槽点击一致：5% 概率给金盏花极高权重，用于持续引导解锁。
  if (Math.random() < 0.05 && choices.length
    && !choices.some((choice) => choice.props.type === 'marigold')) {
    choices[0] = { weight: 1000000, props: { type: 'marigold' } };
  }
  return choices;
}

function choosePlantType(choices) {
  if (!choices.length) return null;
  const arrayGet = modules?.arrayGet?.ArrayGet;
  const picked = typeof arrayGet?.getRandomByWeight === 'function'
    ? arrayGet.getRandomByWeight(choices)
    : choices[Math.floor(Math.random() * choices.length)];
  // ArrayGet.getRandomByWeight 返回的是内层 props：{ type }。
  // 这里兼容 props 包装，避免不同打包版本返回结构变化时静默不种。
  return picked && (picked.type || (picked.props && picked.props.type))
    ? (picked.type || picked.props.type)
    : null;
}

async function fillCurrentPage() {
  if (busy) {
    log('info', 'fill skipped: another operation is busy');
    return;
  }
  const zenScene = activeScene;
  if (!zenScene || !zenScene.currentZen) {
    toast('当前不在禅境花园', 'warn');
    return;
  }
  const garden = zenScene.currentZen;
  const emptySlots = (garden.slots || []).filter((slot) => (
    !slot.plant && !slot.Locked && isUnlocked(slot)
  ));
  const stock = currentSproutCount();
  const targetCount = Math.min(emptySlots.length, stock);
  if (!emptySlots.length) {
    log('info', 'fill skipped: no empty unlocked slot');
    toast('当前页没有空位', 'info');
    return;
  }
  if (stock <= 0) {
    log('info', 'fill skipped: sprout stock is empty');
    toast('植物余额已经用完', 'warn');
    return;
  }

  busy = true;
  setButtonsEnabled(false);
  let planted = 0;
  const plantedTypes = new Map();
  try {
    for (const slot of emptySlots) {
      if (planted >= targetCount || currentSproutCount() <= 0) break;
      const choices = plantChoicesForSlot(slot);
      if (!choices.length) continue;
      const type = choosePlantType(choices);
      if (!type) continue;
      slot.addPlant(type, garden.ID);
      if (!slot.plant) {
        log('warn', `fill planted nothing at slot ${slot.pos}`);
        break;
      }
      planted++;
      plantedTypes.set(type, (plantedTypes.get(type) || 0) + 1);
      if (slot.judgeSelection) slot.judgeSelection();
      if (planted % 8 === 0) {
        savePlayer();
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    }
    savePlayer();
    sortPagePlants(ensureExtraStorage(), garden.ID);
    if (planted > 0) {
      toast(`已种下 ${planted} 株植物（${plantedTypes.size} 种）`, 'success');
      log('info', `filled ${planted} plants, ${plantedTypes.size} types, stock left ${currentSproutCount()}`);
    } else {
      toast('没有可种植的植物类型', 'warn');
    }
  } catch (error) {
    log('error', `fill failed: ${String(error && error.stack || error)}`);
    toast('种满失败，详见模组日志', 'error');
  } finally {
    busy = false;
    setButtonsEnabled(true);
    focusGameCanvas();
  }
}

async function arrangeCurrentPage() {
  if (busy) return;
  const zenScene = activeScene;
  if (!zenScene || !zenScene.currentZen) {
    toast('当前不在禅境花园', 'warn');
    return;
  }
  const garden = zenScene.currentZen;
  const slots = garden.slots || [];
  const collected = groupPlantsByType(slots);
  const plants = collected.plants;
  if (!plants.length) {
    toast('当前页还没有植物', 'info');
    return;
  }

  busy = true;
  setButtonsEnabled(false);
  try {
    const plan = planArrangement(garden);
    const assignment = plan.assignment;

    // 分配不完整时直接放弃，绝不动槽位，避免植物被"洗掉"。
    if (assignment.size !== plants.length) {
      toast(`只有 ${assignment.size}/${plants.length} 株植物找到合适位置，已取消`, 'warn');
      log('warn', `assignment incomplete: ${assignment.size}/${plants.length}`);
      return;
    }

    for (const slot of slots) {
      if (slot.plant) clearSlotOccupant(slot);
    }

    for (const item of plants) {
      const targetIndex = assignment.get(item.plant);
      if (targetIndex === undefined) continue;
      const target = slots[targetIndex];
      if (!target) continue;
      attachPlantToSlot(garden, target, item.plant);
    }

    for (const slot of slots) {
      try {
        await showSlotPlant(garden, slot);
      } catch (error) {
        log('warn', `showPlant failed on slot ${slot.pos}: ${String(error)}`);
      }
      if (slot.judgeSelection) slot.judgeSelection();
    }

    savePlayer();
    // 存档里也按位置排一遍，整理后翻存档不会看到乱的顺序。
    sortPagePlants(ensureExtraStorage(), garden.ID);
    toast(`已整理 ${plants.length} 株植物（${collected.groups.size} 种）`, 'success');
    log('info', `arranged ${plants.length} plants, ${collected.groups.size} types`);
  } catch (error) {
    log('error', `arrange failed: ${String(error && error.stack || error)}`);
    toast('整理失败，详见模组日志', 'error');
  } finally {
    busy = false;
    setButtonsEnabled(true);
    focusGameCanvas();
  }
}

// ------------------------------------------------------------ 坏状态修复
//
// 1.3.x 的整理只改了「植物 -> 槽位」的绑定，漏了两件事：
//   a) 没换 slot.PF —— 原版 showPlant 里 `(this.PF.ZENGARDEN).Height` 会直接抛
//      TypeError（PF 是构造函数里的默认值，ZENGARDEN 是 null），
//      于是后面的代码全没跑：幼苗节点没被销毁、待浇水状态没恢复。
//      画面上就是植物和幼苗特效叠在一起，植物看起来浮在半空。
//   b) 没清幼苗节点 —— 原版判定里 `this.sprout` 非空就代表「还在长」，
//      于是手套 / 推车把整个槽位置灰。
// 这里在场景就绪后扫一遍，把这类坏状态修回来（只修真正坏了的槽位）。
async function repairGardenSlots(zenScene) {
  if (busy || rebuilding) return 0;
  const gardens = (zenScene && zenScene.ZenGardens) || [];
  let fixed = 0;
  for (const garden of gardens) {
    if (!garden.initialized) continue;
    for (const slot of (garden.slots || [])) {
      if (!slot.plant) {
        if (!isUnlocked(slot)) continue;
        const sproutValid = !!(slot.sprout && slot.sprout.node && slot.sprout.node.isValid);
        if (sproutValid) continue;
        // 早期开发版本曾在 movePlant 的动画过渡期间误删刚建好的空槽 sprout。
        // 空槽没有 sprout 时，原版既不显示种植提示，也无法进入正常种植分支。
        if (slot.sprout) slot.sprout = null;
        try {
          await slot.showPlant(garden.PlantLayer);
          fixed++;
        } catch (error) {
          log('warn', `restore empty slot ${slot.pos} failed: ${String(error)}`);
        }
        continue;
      }
      const feature = getPlantFeatureByType(slot.plant.plant);
      const brokenFeature = !slot.PF || !slot.PF.ZENGARDEN;
      const leftoverSprout = !!slot.sprout && !!slot.plantAnmControl;
      const missingDisplay = !slot.plantAnmControl && !slot.sprout;
      if (!brokenFeature && !leftoverSprout && !missingDisplay) continue;
      if (feature) slot.PF = feature;
      try {
        // 重新画一遍：PF 修好之后 showPlant 不会再抛异常，
        // 幼苗节点也会被原版自己回收掉。
        const node = slot.plantAnmControl && slot.plantAnmControl.node;
        slot.plantAnmControl = null;
        if (node && node.isValid) node.destroy();
        await showSlotPlant(garden, slot);
        fixed++;
      } catch (error) {
        log('warn', `repair slot ${slot.pos} failed: ${String(error)}`);
      }
    }
  }
  if (fixed) {
    log('info', `repaired ${fixed} broken slot(s)`);
    savePlayer();
  }
  return fixed;
}

// 每轮轮询都会尝试一次修复：花园刚进场景时 slots 还没初始化完，
// 那次会直接跳过，下一轮再来，直到真的修好或者没有坏状态为止。
function scheduleRepair(zenScene) {
  if (repairing) return;
  repairing = true;
  Promise.resolve()
    .then(() => repairGardenSlots(zenScene))
    .catch((error) => log('warn', `repair failed: ${String(error && error.stack || error)}`))
    .then(() => { repairing = false; });
}

// ---------------------------------------------------------------- 界面

function focusGameCanvas() {
  const canvas = cc?.game?.canvas || document.getElementById('GameCanvas');
  if (!canvas || typeof canvas.focus !== 'function') return;
  try {
    canvas.focus({ preventScroll: true });
  } catch (_) {
    try {
      canvas.focus();
    } catch (_) {
      // 焦点恢复失败不影响模组功能。
    }
  }
}

function ensureStyle() {
  const css = `
    #${UI_ID} {
      position: fixed;
      left: 0;
      top: 0;
      width: 0;
      height: 0;
      z-index: 900;
      font-family: "FBUSV8C5EI_LABEL", "Microsoft YaHei", sans-serif;
    }
    #${UI_ID} .zge-btn {
      position: absolute;
      width: var(--zge-size, 86px);
      height: var(--zge-size, 86px);
      margin-left: calc(var(--zge-size, 86px) / -2);
      border: calc(var(--zge-size, 86px) * 0.035) solid #2b1b0e;
      border-radius: 50%;
      background: linear-gradient(#f6e6bd, #d9b877);
      color: #3a2412;
      font-size: calc(var(--zge-size, 86px) * 0.30);
      font-weight: 700;
      line-height: calc(var(--zge-size, 86px) * 0.93);
      text-align: center;
      cursor: pointer;
      box-shadow: 0 calc(var(--zge-size, 86px) * 0.045) 0 #2b1b0e;
      transform: translateY(0);
      transform-origin: center 65%;
      transition:
        transform 0.1s ease,
        box-shadow 0.1s ease,
        filter 0.1s ease,
        background 0.1s ease;
      user-select: none;
    }
    #${UI_ID} .zge-btn:hover:not(.zge-disabled),
    #${UI_ID} .zge-btn:focus-visible:not(.zge-disabled) {
      transform: translateY(calc(var(--zge-size, 86px) * 0.045));
      box-shadow: 0 calc(var(--zge-size, 86px) * 0.008) 0 #2b1b0e;
      background: linear-gradient(#ecdbb2, #d0b273);
      filter: brightness(0.97);
    }
    #${UI_ID} .zge-btn:active:not(.zge-disabled) {
      transform: translateY(calc(var(--zge-size, 86px) * 0.06)) scale(0.96);
      box-shadow: 0 0 0 #2b1b0e;
      background: linear-gradient(#ddc79a, #bc9a60);
      filter: brightness(0.92);
    }
    #${UI_ID} .zge-btn.zge-disabled {
      opacity: 0.5;
      cursor: default;
      transform: translateY(0);
    }
    #${UI_ID}.zge-suspended,
    #${PANEL_ID}.zge-suspended,
    #${MODAL_ID}.zge-suspended {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }

    #${PANEL_ID} {
      position: fixed;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 910;
      display: none;
      align-items: center;
      justify-content: center;
      font-family: "FBUSV8C5EI_LABEL", "Microsoft YaHei", sans-serif;
    }
    #${PANEL_ID}.zge-open { display: flex; }
    #${PANEL_ID} .zge-panel {
      position: relative;
      width: max(380px, 31vw);
      max-height: 84vh;
      padding: 1.1vw 1.3vw 1.3vw;
      border-radius: 1.6vw;
      background: linear-gradient(#c78a4c 0%, #b3763c 55%, #9c6231 100%);
      border: 0.35vw solid #5e3413;
      box-shadow: 0 0.5vw 0 #5e3413, 0 1.2vw 2vw rgba(0, 0, 0, 0.45);
      color: #fff8e6;
    }
    #${PANEL_ID} .zge-panel-title {
      text-align: center;
      font-size: 2.4vw;
      color: #ffe9a8;
      font-weight: 700;
      /* 用八向阴影做外描边。不能用 -webkit-text-stroke：
         它会沿字形轮廓向内侵蚀，把这套细笔画游戏字体的间隙填死，糊成一团。 */
      text-shadow:
        0.09vw 0 0 #2b1b0e,
        -0.09vw 0 0 #2b1b0e,
        0 0.09vw 0 #2b1b0e,
        0 -0.09vw 0 #2b1b0e,
        0.064vw 0.064vw 0 #2b1b0e,
        -0.064vw 0.064vw 0 #2b1b0e,
        0.064vw -0.064vw 0 #2b1b0e,
        -0.064vw -0.064vw 0 #2b1b0e;
      letter-spacing: 0;
      margin: 0 0 0.8vw;
    }
    #${PANEL_ID} .zge-panel-close {
      position: absolute;
      right: 0.9vw;
      top: 0.7vw;
      width: 3.1vw;
      height: 3.1vw;
      min-width: 34px;
      min-height: 34px;
      border-radius: 50%;
      border: 0.22vw solid #6d2b1c;
      background: radial-gradient(circle at 35% 30%, #ff6a55, #cf2418 70%);
      color: #fff;
      font-size: 1.8vw;
      line-height: 1;
      cursor: pointer;
    }
    #${PANEL_ID} .zge-panel-list {
      background: #f4e9c8;
      border: 0.22vw solid #2fd8e6;
      border-radius: 0.5vw;
      padding: 0.4vw;
      height: 30vh;
      min-height: 160px;
      overflow-y: auto;
    }
    #${PANEL_ID} .zge-page-item {
      display: flex;
      align-items: baseline;
      gap: 0.7vw;
      padding: 0.45vw 0.8vw;
      margin-bottom: 0.25vw;
      border-radius: 0.35vw;
      border: 0.16vw solid transparent;
      cursor: pointer;
      color: #2b1b0e;
      font-size: 1.35vw;
      font-weight: 700;
    }
    #${PANEL_ID} .zge-page-item:hover { background: #fdf6d8; }
    #${PANEL_ID} .zge-page-item.zge-selected {
      background: #f9f3ab;
      border-color: #2fd8e6;
    }
    #${PANEL_ID} .zge-page-item .zge-page-name {
      color: #1f7a12;
      text-decoration: underline;
      font-weight: bold;
    }
    #${PANEL_ID} .zge-page-item .zge-page-meta {
      color: #6b4a22;
      font-size: 1.05vw;
    }
    #${PANEL_ID} .zge-page-move {
      display: flex;
      align-items: center;
      gap: 0.45vw;
      margin-left: auto;
      white-space: nowrap;
    }
    #${PANEL_ID} .zge-page-move button {
      padding: 0 0.15vw;
      border: 0;
      background: transparent;
      color: #b4231a;
      font-family: inherit;
      font-size: 1.05vw;
      font-weight: 700;
      cursor: pointer;
    }
    #${PANEL_ID} .zge-page-move button:hover:not(:disabled) {
      color: #e33a26;
      text-decoration: underline;
    }
    #${PANEL_ID} .zge-page-move button:disabled {
      color: rgba(107, 74, 34, 0.38);
      cursor: default;
    }
    #${PANEL_ID} .zge-page-item .zge-page-badge {
      margin-left: auto;
      padding: 0.1vw 0.5vw;
      border-radius: 0.3vw;
      background: #b3763c;
      color: #fff3d0;
      font-size: 0.95vw;
    }
    #${PANEL_ID} .zge-page-move + .zge-page-badge {
      margin-left: 0.6vw;
    }
    #${PANEL_ID} .zge-panel-buttons {
      display: flex;
      gap: 0.7vw;
      margin-top: 0.9vw;
      justify-content: center;
      flex-wrap: wrap;
    }
    #${PANEL_ID} .zge-pbtn {
      min-width: 8.2vw;
      padding: 0.45vw 1.1vw;
      border-radius: 0.7vw;
      border: 0.22vw solid #1b1b1b;
      color: #fff;
      font-size: 1.45vw;
      font-family: inherit;
      font-weight: 700;
      cursor: pointer;
      text-shadow: 0.12vw 0.12vw 0 rgba(0, 0, 0, 0.55);
    }
    #${PANEL_ID} .zge-pbtn.add { background: linear-gradient(#7ede3a, #3fa612); }
    #${PANEL_ID} .zge-pbtn.del { background: linear-gradient(#ff6a55, #cf2418); }
    #${PANEL_ID} .zge-pbtn.rename { background: linear-gradient(#62c5ff, #2478c8); }
    #${PANEL_ID} .zge-pbtn.close { background: linear-gradient(#9aa3ad, #5e666f); }
    #${PANEL_ID} .zge-pbtn[disabled] { opacity: 0.45; cursor: default; }
    #${PANEL_ID} .zge-panel-hint {
      margin-top: 0.6vw;
      text-align: center;
      color: #ffeec4;
      font-size: 1vw;
      font-weight: 700;
      min-height: 1.4vw;
    }

    #${MODAL_ID} {
      position: fixed;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 920;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(20, 12, 6, 0.55);
      font-family: "FBUSV8C5EI_LABEL", "Microsoft YaHei", sans-serif;
    }
    #${MODAL_ID}.zge-open { display: flex; }
    #${MODAL_ID} .zge-modal {
      width: max(320px, 26vw);
      padding: 1.1vw 1.3vw 1.2vw;
      border-radius: 1.2vw;
      background: linear-gradient(#c78a4c 0%, #b3763c 55%, #9c6231 100%);
      border: 0.32vw solid #5e3413;
      box-shadow: 0 0.45vw 0 #5e3413, 0 1.1vw 2vw rgba(0, 0, 0, 0.5);
      color: #fff8e6;
    }
    #${MODAL_ID} .zge-modal-title {
      text-align: center;
      font-size: 1.9vw;
      color: #ffe9a8;
      font-weight: 700;
      text-shadow:
        0.07vw 0 0 #2b1b0e,
        -0.07vw 0 0 #2b1b0e,
        0 0.07vw 0 #2b1b0e,
        0 -0.07vw 0 #2b1b0e,
        0.05vw 0.05vw 0 #2b1b0e,
        -0.05vw 0.05vw 0 #2b1b0e,
        0.05vw -0.05vw 0 #2b1b0e,
        -0.05vw -0.05vw 0 #2b1b0e;
      letter-spacing: 0;
      margin: 0 0 0.7vw;
    }
    #${MODAL_ID} .zge-modal-body {
      background: #f4e9c8;
      border: 0.2vw solid #2fd8e6;
      border-radius: 0.45vw;
      padding: 0.8vw 1vw;
      color: #2b1b0e;
      font-size: 1.25vw;
      line-height: 1.55;
      max-height: 46vh;
      overflow-y: auto;
    }
    #${MODAL_ID} .zge-modal-body .zge-modal-emph {
      color: #b4231a;
      font-weight: bold;
    }
    #${MODAL_ID} .zge-modal-body .zge-modal-list {
      margin: 0.5vw 0 0;
      padding-left: 1.4vw;
    }
    #${MODAL_ID} .zge-rename-input {
      width: 100%;
      box-sizing: border-box;
      padding: 0.7vw 0.8vw;
      border: 0.2vw solid #8a633a;
      border-radius: 0.4vw;
      background: #fffdf2;
      color: #2b1b0e;
      font: inherit;
      font-size: 1.3vw;
      outline: none;
    }
    #${MODAL_ID} .zge-rename-input:focus {
      border-color: #2fd8e6;
      box-shadow: 0 0 0 0.14vw rgba(47, 216, 230, 0.35);
    }
    #${MODAL_ID} .zge-modal-buttons {
      display: flex;
      gap: 0.8vw;
      margin-top: 0.9vw;
      justify-content: center;
      flex-wrap: wrap;
    }
    #${MODAL_ID} .zge-mbtn {
      min-width: 8vw;
      padding: 0.45vw 1.1vw;
      border-radius: 0.7vw;
      border: 0.22vw solid #1b1b1b;
      color: #fff;
      font-size: 1.35vw;
      font-family: inherit;
      font-weight: 700;
      cursor: pointer;
      text-shadow: 0.12vw 0.12vw 0 rgba(0, 0, 0, 0.55);
    }
    #${MODAL_ID} .zge-mbtn.ok { background: linear-gradient(#7ede3a, #3fa612); }
    #${MODAL_ID} .zge-mbtn.danger { background: linear-gradient(#ff6a55, #cf2418); }
    #${MODAL_ID} .zge-mbtn.cancel { background: linear-gradient(#9aa3ad, #5e666f); }
  `;
  // 模组热重载时旧样式仍在页面里，必须覆盖而不是直接跳过。
  let style = document.getElementById(UI_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = UI_STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

function ensureUi() {
  if (!document || !document.body) return;
  ensureStyle();
  if (uiRoot && uiRoot.isConnected) return;

  uiRoot = document.createElement('div');
  uiRoot.id = UI_ID;

  const arrange = document.createElement('div');
  arrange.className = 'zge-btn zge-arrange';
  arrange.textContent = '整理';
  arrange.title = '按种类重排当前页的植物（同种相邻）';
  arrange.setAttribute('role', 'button');
  arrange.setAttribute('aria-label', '整理当前花园');
  arrange.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (arrange.classList.contains('zge-disabled')) return;
    Promise.resolve(arrangeCurrentPage()).finally(focusGameCanvas);
  });

  const page = document.createElement('div');
  page.className = 'zge-btn zge-page';
  page.textContent = '总览';
  page.title = '查看、新增或删除花园总览';
  page.setAttribute('role', 'button');
  page.setAttribute('aria-label', '花园总览');
  page.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (page.classList.contains('zge-disabled')) return;
    openPanel();
  });

  const fill = document.createElement('div');
  fill.className = 'zge-btn zge-fill';
  fill.textContent = '种满';
  fill.title = '用植物余额种满当前页空位（沿用原版选苗权重）';
  fill.setAttribute('role', 'button');
  fill.setAttribute('aria-label', '批量种植当前花园');
  fill.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (fill.classList.contains('zge-disabled')) return;
    Promise.resolve(fillCurrentPage()).finally(focusGameCanvas);
  });

  uiRoot.appendChild(arrange);
  uiRoot.appendChild(page);
  uiRoot.appendChild(fill);
  document.body.appendChild(uiRoot);
  uiButtons = { arrange: arrange, page: page, fill: fill };
}

// ---------------------------------------------------------------- 页管理面板

const DEFAULT_PAGE_NAMES = {
  0: '主花园',
  1: '蘑菇园',
  2: '海滩园',
  3: '夜花园',
};

// 额外页的名字按「面板里的显示顺序」编号，跟页 ID 解耦。
// 这样删掉中间一页、ID 被复用之后，名字仍然是「新增页 1 / 新增页 2」这样连续的。
function normalizePageName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PAGE_NAME_LENGTH);
}

function extraPageLabel(id) {
  if (id < EXTRA_PAGE_ID) return DEFAULT_PAGE_NAMES[id] || `第 ${id + 1} 页`;
  const record = findExtraPageRecord(ensureExtraStorage(), id);
  const customName = normalizePageName(record && record.name);
  if (customName) return customName;
  const gardens = (activeScene && activeScene.ZenGardens) || [];
  let index = 0;
  for (const garden of gardens) {
    if (!garden || garden.ID < EXTRA_PAGE_ID) continue;
    index += 1;
    if (garden.ID === id) return `新增页 ${index}`;
  }
  return `新增页 ${id - EXTRA_PAGE_ID + 1}`;
}

function ensurePanel() {
  if (panelRoot && panelRoot.isConnected) return panelRoot;
  panelRoot = document.createElement('div');
  panelRoot.id = PANEL_ID;

  const frame = document.createElement('div');
  frame.className = 'zge-panel';

  const title = document.createElement('div');
  title.className = 'zge-panel-title';
  title.textContent = '花园总览';

  const closeX = document.createElement('button');
  closeX.className = 'zge-panel-close';
  closeX.textContent = '✕';
  closeX.title = '关闭';
  closeX.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  });

  panelList = document.createElement('div');
  panelList.className = 'zge-panel-list';

  const buttons = document.createElement('div');
  buttons.className = 'zge-panel-buttons';

  const addButton = document.createElement('button');
  addButton.className = 'zge-pbtn add';
  addButton.textContent = '新增页';
  addButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onAddPage();
  });

  const deleteButton = document.createElement('button');
  deleteButton.className = 'zge-pbtn del';
  deleteButton.textContent = '删除页';
  deleteButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onDeletePage();
  });

  const renameButton = document.createElement('button');
  renameButton.className = 'zge-pbtn rename';
  renameButton.textContent = '重命名';
  renameButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRenamePage();
  });

  buttons.appendChild(addButton);
  buttons.appendChild(deleteButton);
  buttons.appendChild(renameButton);

  const hint = document.createElement('div');
  hint.className = 'zge-panel-hint';

  frame.appendChild(title);
  frame.appendChild(closeX);
  frame.appendChild(panelList);
  frame.appendChild(buttons);
  frame.appendChild(hint);
  panelRoot.appendChild(frame);
  document.body.appendChild(panelRoot);
  panelRoot.__hint = hint;
  panelRoot.__deleteButton = deleteButton;
  panelRoot.__renameButton = renameButton;
  return panelRoot;
}

function closePanel() {
  if (panelRoot) panelRoot.classList.remove('zge-open');
  focusGameCanvas();
}

function openPanel() {
  ensurePanel();
  panelSelected = null;
  refreshPanel();
  panelRoot.classList.add('zge-open');
}

// ---------------------------------------------------------------- 确认弹窗

// 宿主把 window.confirm 改成了返回 Promise 的异步实现（结果永远 truthy），
// 靠它做「确认」等于没有确认，所以这里自己搭一个模态框。
let modalRoot = null;
let modalResolve = null;

function ensureModal() {
  if (modalRoot && modalRoot.isConnected) return modalRoot;
  modalRoot = document.createElement('div');
  modalRoot.id = MODAL_ID;

  const frame = document.createElement('div');
  frame.className = 'zge-modal';

  const title = document.createElement('div');
  title.className = 'zge-modal-title';

  const body = document.createElement('div');
  body.className = 'zge-modal-body';

  const buttons = document.createElement('div');
  buttons.className = 'zge-modal-buttons';

  const cancelButton = document.createElement('button');
  cancelButton.className = 'zge-mbtn cancel';
  cancelButton.textContent = '取消';

  const okButton = document.createElement('button');
  okButton.className = 'zge-mbtn ok';

  buttons.appendChild(cancelButton);
  buttons.appendChild(okButton);
  frame.appendChild(title);
  frame.appendChild(body);
  frame.appendChild(buttons);
  modalRoot.appendChild(frame);
  document.body.appendChild(modalRoot);

  modalRoot.__title = title;
  modalRoot.__body = body;
  modalRoot.__ok = okButton;
  modalRoot.__cancel = cancelButton;
  if (!modalRoot.__escBound) {
    modalRoot.__escBound = true;
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!modalRoot || !modalRoot.classList.contains('zge-open')) return;
      event.preventDefault();
      event.stopPropagation();
      closeModal(false);
    }, true);
  }
  return modalRoot;
}

function closeModal(result) {
  if (!modalRoot) return;
  modalRoot.classList.remove('zge-open');
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(result);
}

// 弹出确认框，返回 Promise<boolean>。
// options: { title, lines: [string], html: string, okText, cancelText, danger }
function showModal(options) {
  const opts = options || {};
  ensureStyle();
  const root = ensureModal();
  root.__title.textContent = opts.title || '确认';
  root.__ok.textContent = opts.okText || '确定';
  root.__cancel.textContent = opts.cancelText || '取消';
  // 危险按钮也保留 ok 类名，方便外部脚本/测试稳定定位「确定」按钮。
  root.__ok.className = `zge-mbtn ok${opts.danger ? ' danger' : ''}`;

  const body = root.__body;
  body.innerHTML = '';
  if (opts.html) {
    body.innerHTML = opts.html;
  } else {
    const lines = Array.isArray(opts.lines) ? opts.lines : [];
    for (const line of lines) {
      const p = document.createElement('div');
      p.textContent = line;
      body.appendChild(p);
    }
  }

  return new Promise((resolve) => {
    modalResolve = resolve;
    root.__ok.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeModal(true);
    };
    root.__cancel.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeModal(false);
    };
    root.onclick = (event) => {
      // 点遮罩等同取消。
      if (event.target === root) closeModal(false);
    };
    root.classList.add('zge-open');
  });
}

// 文本输入框，返回 Promise<string|null>。失败/取消返回 null。
function showTextPrompt(options) {
  const opts = options || {};
  ensureStyle();
  const root = ensureModal();
  root.__title.textContent = opts.title || '输入名称';
  root.__ok.textContent = opts.okText || '确定';
  root.__cancel.textContent = opts.cancelText || '取消';
  root.__ok.className = 'zge-mbtn ok';

  const body = root.__body;
  body.innerHTML = '';
  if (opts.description) {
    const description = document.createElement('div');
    description.textContent = opts.description;
    description.style.marginBottom = '0.65vw';
    body.appendChild(description);
  }
  const input = document.createElement('input');
  input.className = 'zge-rename-input';
  input.type = 'text';
  input.maxLength = opts.maxLength || MAX_PAGE_NAME_LENGTH;
  input.placeholder = opts.placeholder || '';
  input.value = opts.value || '';
  input.autocomplete = 'off';
  body.appendChild(input);
  root.__input = input;

  return new Promise((resolve) => {
    modalResolve = resolve;
    const submit = () => closeModal(input.value);
    root.__ok.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      submit();
    };
    root.__cancel.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeModal(null);
    };
    input.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeModal(null);
      }
    };
    root.onclick = (event) => {
      if (event.target === root) closeModal(null);
    };
    root.classList.add('zge-open');
    setTimeout(() => {
      if (!root.classList.contains('zge-open')) return;
      input.focus();
      input.select();
    }, 0);
  });
}

function moveCustomPage(zenScene, id, delta) {
  if (busy || !zenScene || id < EXTRA_PAGE_ID) return false;
  const storage = ensureExtraStorage();
  if (!storage || !Array.isArray(storage[EXTRA_PAGES_KEY])) return false;
  const records = storage[EXTRA_PAGES_KEY].slice();
  const customRecords = records.filter((record) => record && record.id >= EXTRA_PAGE_ID);
  const from = customRecords.findIndex((record) => record.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= customRecords.length) return false;

  const moved = customRecords.splice(from, 1)[0];
  customRecords.splice(to, 0, moved);
  storage[EXTRA_PAGES_KEY] = records
    .filter((record) => !record || record.id < EXTRA_PAGE_ID)
    .concat(customRecords);

  const defaults = (zenScene.ZenGardens || []).filter((garden) => garden.ID < EXTRA_PAGE_ID);
  const runtimeById = new Map(
    (zenScene.ZenGardens || [])
      .filter((garden) => garden.ID >= EXTRA_PAGE_ID)
      .map((garden) => [garden.ID, garden]),
  );
  const orderedCustom = customRecords.map((record) => runtimeById.get(record.id)).filter(Boolean);
  const leftover = (zenScene.ZenGardens || []).filter((garden) => (
    garden.ID >= EXTRA_PAGE_ID && !orderedCustom.includes(garden)
  ));
  zenScene.ZenGardens = defaults.concat(orderedCustom, leftover);
  savePlayer();
  log('info', `moved custom page ${id} ${delta < 0 ? 'up' : 'down'}`);
  return true;
}

function refreshPanel() {
  if (!panelList || !activeScene) return;
  const gardens = (activeScene.ZenGardens || []).slice();
  const customGardens = gardens.filter((garden) => garden.ID >= EXTRA_PAGE_ID);
  panelList.innerHTML = '';

  for (const garden of gardens) {
    const id = garden.ID;
    const isDefault = id < EXTRA_PAGE_ID;
    const name = extraPageLabel(id);
    const plantCount = (garden.slots || []).filter((slot) => slot.plant).length;

    const item = document.createElement('div');
    item.className = 'zge-page-item';
    item.dataset.pageId = String(id);
    const customIndex = customGardens.findIndex((garden) => garden.ID === id);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'zge-page-name';
    nameSpan.textContent = name;

    const meta = document.createElement('span');
    meta.className = 'zge-page-meta';
    meta.textContent = `${plantCount} 株植物 / ${(garden.slots || []).length} 个位置`;

    const badge = document.createElement('span');
    badge.className = 'zge-page-badge';
    badge.textContent = isDefault ? '默认' : '可删除';

    item.appendChild(nameSpan);
    item.appendChild(meta);
    if (!isDefault) {
      const move = document.createElement('span');
      move.className = 'zge-page-move';

      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '上移';
      up.title = '向前移动一个自定义页';
      up.disabled = customIndex <= 0;
      up.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (up.disabled) return;
        panelSelected = id;
        if (moveCustomPage(activeScene, id, -1)) {
          toast(`已上移「${extraPageLabel(id)}」`, 'info');
          refreshPanel();
        }
      });

      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '下移';
      down.title = '向后移动一个自定义页';
      down.disabled = customIndex >= customGardens.length - 1;
      down.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (down.disabled) return;
        panelSelected = id;
        if (moveCustomPage(activeScene, id, 1)) {
          toast(`已下移「${extraPageLabel(id)}」`, 'info');
          refreshPanel();
        }
      });

      move.appendChild(up);
      move.appendChild(down);
      item.appendChild(move);
    }
    item.appendChild(badge);
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      panelSelected = id;
      refreshPanel();
    });
    if (panelSelected === id) item.classList.add('zge-selected');
    panelList.appendChild(item);
  }

  const selected = gardens.find((garden) => garden.ID === panelSelected);
  const deleteButton = panelRoot && panelRoot.__deleteButton;
  const renameButton = panelRoot && panelRoot.__renameButton;
  const editable = !!(selected && selected.ID >= EXTRA_PAGE_ID);
  if (deleteButton) {
    deleteButton.disabled = !editable || busy;
  }
  if (renameButton) {
    renameButton.disabled = !editable || busy;
  }
  if (panelRoot && panelRoot.__hint) {
    if (selected && selected.ID >= EXTRA_PAGE_ID) {
      const count = (selected.slots || []).filter((slot) => slot.plant).length;
      panelRoot.__hint.textContent = count > 0
        ? `删除后该页的 ${count} 株植物会全部搬到其它花园，不会丢失。`
        : '该页没有植物，删除后不影响其他花园。';
    } else {
      panelRoot.__hint.textContent = '默认的四个花园不可重命名或删除。选中新增页可以重命名。';
    }
  }
}

async function onAddPage() {
  if (busy) return;
  busy = true;
  try {
    const garden = await addExtraPage(activeScene);
    if (garden) {
      panelSelected = garden.ID;
      toast(`已新增花园页（${(garden.slots || []).length} 个位置）`, 'success');
    } else {
      toast('新增失败，详见模组日志', 'error');
    }
  } finally {
    busy = false;
    refreshPanel();
  }
}

async function onRenamePage() {
  if (busy || panelSelected === null || panelSelected === undefined) return;
  const id = panelSelected;
  if (id < EXTRA_PAGE_ID) {
    toast('默认花园不能重命名', 'warn');
    return;
  }
  const storage = ensureExtraStorage();
  const record = findExtraPageRecord(storage, id);
  if (!record) {
    toast('找不到该花园页的存档记录', 'error');
    return;
  }
  const oldLabel = extraPageLabel(id);
  busy = true;
  refreshPanel();
  try {
    const rawName = await showTextPrompt({
      title: '重命名花园页',
      description: `为「${oldLabel}」设置一个新名称。原有四个花园页不能重命名。`,
      value: record.name || '',
      placeholder: oldLabel,
      okText: '保存名称',
      cancelText: '取消',
      maxLength: MAX_PAGE_NAME_LENGTH,
    });
    if (rawName === null) {
      toast('已取消重命名', 'info');
      return;
    }
    const name = normalizePageName(rawName);
    if (!name) {
      toast('花园名不能为空', 'warn');
      return;
    }
    const duplicate = (activeScene.ZenGardens || []).some((garden) => (
      garden && garden.ID !== id && extraPageLabel(garden.ID) === name
    ));
    if (duplicate) {
      toast(`已有名为「${name}」的花园页`, 'warn');
      return;
    }
    record.name = name;
    savePlayer();
    toast(`已重命名为「${name}」`, 'success');
    log('info', `renamed extra page ${id}: ${name}`);
  } catch (error) {
    log('error', `rename page ${id} failed: ${String(error && error.stack || error)}`);
    toast('重命名失败，详见模组日志', 'error');
  } finally {
    busy = false;
    refreshPanel();
    focusGameCanvas();
  }
}

async function onDeletePage() {
  if (busy || panelSelected === null || panelSelected === undefined) return;
  const id = panelSelected;
  if (id < EXTRA_PAGE_ID) {
    toast('默认花园不能删除', 'warn');
    return;
  }
  busy = true;
  try {
    const storage = ensureExtraStorage();
    const record = findExtraPageRecord(storage, id);
    const plants = record && Array.isArray(record.plants) ? record.plants : [];
    const plantCount = plants.length;
    const typeCount = new Set(plants.map((plant) => plant && plant.plant).filter(Boolean)).size;
    const pageLabel = extraPageLabel(id);

    // 第一次确认：确认要删掉这一页。
    const firstOk = await showModal({
      title: '删除花园页',
      lines: plantCount > 0
        ? [`确定要删除「${pageLabel}」吗？`, `该页当前有 ${plantCount} 株植物（${typeCount} 种）。`]
        : [`确定要删除「${pageLabel}」吗？`],
      okText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!firstOk) {
      toast('已取消删除', 'info');
      return;
    }

    // 第二次确认：有植物时明确说明植物的去向，避免以为会被一起删掉。
    if (plantCount > 0) {
      const secondOk = await showModal({
        title: '植物搬回花园',
        html: `<div>「${pageLabel}」的 <span class="zge-modal-emph">${plantCount} 株植物</span> 会在删除页面前
          <span class="zge-modal-emph">全部搬回花园</span>，一株都不会丢。</div>
          <div style="margin-top:0.4vw">植物会依次落到主花园、其它花园的空位上，已有植物不会被挪动。确认继续？</div>`,
        okText: '搬回并删除',
        cancelText: '再想想',
        danger: true,
      });
      if (!secondOk) {
        toast('已取消删除', 'info');
        return;
      }
    }

    const result = await removeExtraPageById(activeScene, id);
    if (result && result.ok) {
      const movedText = result.total > 0 ? `，${result.moved} 株植物已搬回花园` : '';
      toast(`已删除「${pageLabel}」${movedText}`, 'success');
      panelSelected = null;
    } else {
      const reason = result && result.reason;
      if (reason === 'no-space') {
        toast(`所有花园页都放不下这 ${result.total} 株植物，页面已保留`, 'warn');
      } else if (reason === 'move-failed') {
        toast(`有植物没能搬回花园（${result.moved}/${result.total}），页面已保留`, 'error');
      } else {
        toast('删除失败，详见模组日志', 'error');
      }
    }
  } finally {
    busy = false;
    refreshPanel();
  }
}

// 把 Cocos 世界坐标（X）换算成 DOM 屏幕坐标。
function worldXToScreen(worldX) {
  try {
    const canvas = cc && cc.game && cc.game.canvas;
    const view = cc && cc.view;
    if (!canvas || !view) return null;
    const viewport = view.getViewportRect();
    const canvasRect = canvas.getBoundingClientRect();
    const pixelRatioX = canvas.width / canvasRect.width;
    if (!pixelRatioX) return null;
    const x = canvasRect.left + (viewport.x + worldX * view.getScaleX()) / pixelRatioX;
    return Number.isFinite(x) ? x : null;
  } catch (error) {
    return null;
  }
}

// 把 Cocos 世界坐标换算成 DOM 屏幕坐标（与 GP-Next 其它模组一致的做法）。
function getComponentByClass(node, className) {
  return ((node && node.components) || []).find((c) => c && c.__classname__ === className) || null;
}

function nodeScreenRect(node) {
  try {
    const canvas = cc && cc.game && cc.game.canvas;
    const view = cc && cc.view;
    if (!node || !canvas || !view || !node.activeInHierarchy) return null;
    const transform = getComponentByClass(node, 'cc.UITransform');
    if (!transform || typeof transform.getBoundingBoxToWorld !== 'function') return null;
    const box = transform.getBoundingBoxToWorld();
    const viewport = view.getViewportRect();
    const scaleX = view.getScaleX();
    const scaleY = view.getScaleY();
    const canvasRect = canvas.getBoundingClientRect();
    const pixelRatioX = canvas.width / canvasRect.width;
    const pixelRatioY = canvas.height / canvasRect.height;
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const width = box.width * scaleX / pixelRatioX;
    const height = box.height * scaleY / pixelRatioY;
    const left = canvasRect.left + (viewport.x + box.x * scaleX) / pixelRatioX;
    const top = canvasRect.top + canvasRect.height
      - (viewport.y + (box.y + box.height) * scaleY) / pixelRatioY;
    if (![width, height, left, top].every(Number.isFinite)) return null;
    return { left, top, width, height, bottom: top + height, centerX: left + width / 2 };
  } catch (error) {
    return null;
  }
}

// 收集界面锚点：左侧工具栏、左下资源栏。全部来自游戏原生节点，
// 因此窗口尺寸或画面比例变化时会自动跟随，不需要写死坐标。
function collectAnchors(zenScene) {
  const uiNode = zenScene && zenScene.uiNode;
  if (!uiNode) return null;
  const children = (uiNode.children || []).slice();
  const byName = (name) => {
    const hit = children.find((child) => child.name === name);
    return hit ? nodeScreenRect(hit) : null;
  };
  const shovel = zenScene.shovelUI && zenScene.shovelUI.node ? nodeScreenRect(zenScene.shovelUI.node) : null;
  const toolbar = byName('Buttons');
  const help = byName('buttonQuestion');
  const gem = byName('GemCount');
  const sprout = byName('SproutCount');
  const buttons = zenScene.uiNode.children || [];
  const fallback = buttons
    .map((child) => nodeScreenRect(child))
    .filter(Boolean);
  // 左侧工具列的安全右边界，用来避免新按钮压到原版工具上。
  // 注意：工具按钮被选中时会放大，直接量它们的边界会抖，
  // 所以这里用「容器基准缩放 × 按钮原始尺寸」算出不随高亮变化的位置。
  let toolbarRight = null;
  const toolbarNode = children.find((child) => child.name === 'Buttons');
  for (const child of (toolbarNode && toolbarNode.children) || []) {
    if (!getComponentByClass(child, 'cc.Button')) continue;
    const transform = getComponentByClass(child, 'cc.UITransform');
    if (!transform) continue;
    const baseScale = (toolbarNode && toolbarNode.worldScale && toolbarNode.worldScale.x) || 1;
    const worldRight = child.worldPosition.x + (transform.contentSize.width / 2) * baseScale;
    const screenRight = worldXToScreen(worldRight);
    if (screenRight === null) continue;
    if (toolbarRight === null || screenRight > toolbarRight) toolbarRight = screenRight;
  }
  const leftEdge = (toolbar && toolbar.left) || (shovel && shovel.left) || null;
  const bottomEdge = (gem && gem.top) || (sprout && sprout.top) || null;
  const unit = (shovel && Math.min(shovel.width, shovel.height))
    || (toolbar && Math.min(toolbar.width, toolbar.height))
    || (fallback[0] && Math.min(fallback[0].width, fallback[0].height))
    || 140;
  if (leftEdge === null || bottomEdge === null) return null;
  return {
    left: leftEdge,
    bottom: bottomEdge,
    unit: unit,
    help: help,
    toolbarRight: toolbarRight,
    canvasWidth: fallback[0] ? fallback[0].left : 0,
  };
}

// 摆放工具条：优先挂在 0.16 新增的帮助（圆形问号）按钮正下方，
// 水平中心与问号按钮对齐；若会压到左侧工具列，则自动向右让开。
// 没有问号按钮的旧版本退回到原来的「左下角」摆法。
function updateToolboxPlacement() {
  if (!uiRoot || !uiButtons || !activeScene) return;
  const anchors = collectAnchors(activeScene);
  if (!anchors) return;
  const help = anchors.help;
  const size = help
    ? Math.max(40, Math.min(120, Math.min(help.width, help.height) * 0.72))
    : Math.max(48, Math.min(120, anchors.unit * 0.62));
  const gap = Math.max(5, size * 0.14);
  const stackHeight = size * 3 + gap * 2;
  uiRoot.style.setProperty('--zge-size', `${size.toFixed(1)}px`);
  if (help) {
    let centerX = help.centerX;
    if (anchors.toolbarRight !== null) {
      const minX = anchors.toolbarRight + size / 2 + 6;
      if (centerX < minX) centerX = minX;
    }
    uiRoot.style.left = `${centerX.toFixed(1)}px`;
    uiRoot.style.top = `${Math.max(4, help.bottom + gap).toFixed(1)}px`;
  } else {
    const top = anchors.bottom - 18 - stackHeight;
    uiRoot.style.left = `${anchors.left.toFixed(1)}px`;
    uiRoot.style.top = `${Math.max(4, top).toFixed(1)}px`;
  }
  uiButtons.arrange.style.top = '0px';
  uiButtons.page.style.top = `${(size + gap).toFixed(1)}px`;
  uiButtons.fill.style.top = `${(size + gap) * 2}px`;
}

function setButtonsEnabled(enabled) {
  if (!uiButtons) return;
  uiButtons.arrange.disabled = !enabled;
  uiButtons.page.disabled = !enabled;
  uiButtons.fill.disabled = !enabled;
  uiButtons.arrange.classList.toggle('zge-disabled', !enabled);
  uiButtons.page.classList.toggle('zge-disabled', !enabled);
  uiButtons.fill.classList.toggle('zge-disabled', !enabled);
  uiButtons.arrange.setAttribute('aria-disabled', String(!enabled));
  uiButtons.page.setAttribute('aria-disabled', String(!enabled));
  uiButtons.fill.setAttribute('aria-disabled', String(!enabled));
}

function hostPanelOpen() {
  const overlay = document.getElementById('gp-overlay');
  if (!overlay) return false;
  const style = getComputedStyle(overlay);
  const rect = overlay.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && rect.right > 0
    && rect.left < window.innerWidth;
}

function gameOverlayActive(zenScene) {
  const splash = modules?.keyListener?.KeyListener?.cp?.screenSplash;
  if (splash && (splash.node?.activeInHierarchy || Number(splash.opacity) > 0)) return true;
  if (!zenScene) return false;
  return !!(
    zenScene.PlantMedalsWindow?.active
    || zenScene.PlantMedalsWindow?.activeInHierarchy
    || zenScene.shovelWindow?.active
    || zenScene.shovelWindow?.activeInHierarchy
    || zenScene.tutorialPage?.node?.activeInHierarchy
    || zenScene.tutorialPage?.isActive
  );
}

function syncUiVisibility(zenScene) {
  const suspended = hostPanelOpen() || gameOverlayActive(zenScene);
  for (const root of [uiRoot, panelRoot, modalRoot]) {
    if (root) root.classList.toggle('zge-suspended', suspended);
  }
}

function removeUi() {
  if (uiRoot && uiRoot.isConnected) uiRoot.remove();
  uiRoot = null;
  uiButtons = null;
  if (panelRoot && panelRoot.isConnected) panelRoot.remove();
  panelRoot = null;
  panelList = null;
  panelSelected = null;
  if (modalRoot && modalRoot.isConnected) modalRoot.remove();
  modalRoot = null;
  modalResolve = null;
}

// ---------------------------------------------------------------- 生命周期

function handleScene() {
  const zenScene = findZenScene();
  if (!zenScene) {
    if (activeScene) {
      activeScene = null;
      extraPages.clear();
      removeUi();
    }
    return;
  }
  if (zenScene === activeScene) {
    syncUiVisibility(zenScene);
    updateToolboxPlacement();
    scheduleRepair(zenScene);
    return;
  }

  activeScene = zenScene;
  extraPages.clear();
  patchZenScene(zenScene);
  // 热更新或冷启动时，推车里可能已经存着一株幼苗；用新 setter 重建预览，
  // 替换旧版本错误加载的成熟 plantDIS。
  if (zenScene.plantInCart) {
    const heldCartPlant = zenScene.plantInCart;
    zenScene.plantInCart = null;
    zenScene.plantInCart = heldCartPlant;
  }
  ensureUi();
  syncUiVisibility(zenScene);
  rebuildExtraPages(zenScene);
  scheduleRepair(zenScene);
  log('info', 'zen garden scene detected');
}

async function ensureModules() {
  if (modules) return modules;
  const engine = ctx && ctx.unsafe && ctx.unsafe.engine;
  cc = engine && engine.getCc ? engine.getCc() : globalThis.cc;
  if (!cc) throw new Error('Cocos runtime unavailable');
  const [
    zenSceneModule,
    zenModule,
    zenFeaturesModule,
    playerPropsModule,
    plantsModule,
    keyListenerModule,
    arrayGetModule,
    sproutCountModule,
  ] = await Promise.all([
    loadSystemModule(ZEN_SCENE_MODULE),
    loadSystemModule(ZEN_MODULE),
    loadSystemModule(ZEN_FEATURES_MODULE),
    loadSystemModule(PLAYER_PROPS_MODULE),
    loadSystemModule(PLANTS_MODULE),
    loadSystemModule(KEY_LISTENER_MODULE),
    loadSystemModule(ARRAY_GET_MODULE),
    loadSystemModule(SPROUT_COUNT_MODULE),
  ]);
  modules = {
    zenScene: zenSceneModule,
    zen: zenModule,
    zenFeatures: zenFeaturesModule,
    playerProps: playerPropsModule,
    plants: plantsModule,
    keyListener: keyListenerModule,
    arrayGet: arrayGetModule,
    sproutCount: sproutCountModule,
  };
  return modules;
}

export async function setup(context) {
  ctx = context;
  stopped = false;
  restored = false;
  sessionToken++;

  try {
    await ensureModules();
    // 手套 / 推车适配只依赖类原型，跟场景无关，模块就绪后即可打上。
    patchToolMove();
    log('info', `mod loaded v${MOD_VERSION}`);
  } catch (error) {
    log('error', `module load failed: ${String(error && error.stack || error)}`);
  }

  if (ctx && ctx.runtime && typeof ctx.runtime.setInterval === 'function') {
    uiVisibilityTimer = ctx.runtime.setInterval(() => {
      if (stopped) return;
      try {
        syncUiVisibility(activeScene);
      } catch (error) {
        log('warn', `ui visibility sync failed: ${String(error)}`);
      }
    }, UI_VISIBILITY_INTERVAL_MS, { label: 'zge-ui-visibility' });
    pollTimer = ctx.runtime.setInterval(() => {
      if (stopped) return;
      try {
        handleScene();
      } catch (error) {
        log('error', `scene poll failed: ${String(error && error.stack || error)}`);
      }
    }, POLL_INTERVAL_MS, { label: 'zge-poll' });
  }

  return cleanup;
}

function cleanup() {
  stopped = true;
  sessionToken++;
  if (uiVisibilityTimer && ctx && ctx.runtime && typeof ctx.runtime.clearInterval === 'function') {
    try {
      ctx.runtime.clearInterval(uiVisibilityTimer);
    } catch (error) {
      log('warn', `clear ui visibility interval failed: ${String(error)}`);
    }
  }
  uiVisibilityTimer = null;
  if (pollTimer && ctx && ctx.runtime && typeof ctx.runtime.clearInterval === 'function') {
    try {
      ctx.runtime.clearInterval(pollTimer);
    } catch (error) {
      log('warn', `clear interval failed: ${String(error)}`);
    }
  }
  pollTimer = null;
  if (!restored) {
    restored = true;
    // 每一步独立兜底：任何一步抛异常都不能影响后面的清理。
    // （曾因这里引用了已删除的变量而在严格模式下抛 ReferenceError，
    //   导致原型补丁没被还原，旧补丁一直残留。）
    try { removeExtraPage(); } catch (error) { log('warn', `remove extra page failed: ${String(error)}`); }
    try { unpatchZenScene(); } catch (error) { log('warn', `unpatch failed: ${String(error)}`); }
    try { unpatchToolMove(); } catch (error) { log('warn', `unpatch tool move failed: ${String(error)}`); }
    try { removeUi(); } catch (error) { log('warn', `remove ui failed: ${String(error)}`); }
    activeScene = null;
    extraPages.clear();
    log('info', 'mod unloaded');
  }
}

export function teardown() {
  cleanup();
}

export default { setup, teardown };
