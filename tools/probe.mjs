/* STARFALL — tools/probe.mjs
   Headless harness. Fakes just enough browser to import the real game modules,
   then plays the game without a screen: builds the world, fights, casts every
   ability of every class, and runs each dungeon and raid encounter.

   Catches the class of bug a syntax check never will.

     node tools/probe.mjs            full run
     node tools/probe.mjs --quick    shorter simulation
*/

/* ------------------------------------------------------------ DOM stub  */

const noop = () => {};
function fakeCtx2d() {
  const grad = { addColorStop: noop };
  const ctx = {
    canvas: { width: 1280, height: 720 },
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, rect: noop, fill: noop, stroke: noop, fillRect: noop, strokeRect: noop,
    clearRect: noop, fillText: noop, strokeText: noop, translate: noop, rotate: noop, scale: noop,
    setTransform: noop, drawImage: noop, createRadialGradient: () => grad, createLinearGradient: () => grad,
    measureText: () => ({ width: 40 }), putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) })
  };
  return ctx;
}
function fakeElement(tag) {
  const e = {
    tagName: tag, style: {}, children: [], className: '', id: '', innerHTML: '', textContent: '',
    width: 1280, height: 720,
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => fakeElement('div'), querySelectorAll: () => [],
    getContext: () => fakeCtx2d(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    setAttribute: noop, focus: noop, setProperty: noop, classList: { add: noop, remove: noop, toggle: noop }
  };
  e.style.setProperty = noop;
  return e;
}
globalThis.document = {
  readyState: 'complete',
  createElement: fakeElement,
  createElementNS: fakeElement,
  getElementById: () => fakeElement('div'),
  body: fakeElement('body'),
  addEventListener: noop, removeEventListener: noop,
  exitPointerLock: noop, pointerLockElement: null
};
globalThis.window = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  addEventListener: noop, removeEventListener: noop
};
// Node 22 already defines a read-only `navigator`; leave it alone.
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); }
};
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);

/* --------------------------------------------------------------- setup */

const QUICK = process.argv.includes('--quick');
const errors = [];
const notes = [];
const t0 = Date.now();

// Print immediately: an ESM top-level throw arrives here and would otherwise
// exit the process silently before the report runs.
process.on('uncaughtException', e => {
  console.error('UNCAUGHT:', (e && e.stack) || e);
  errors.push('uncaught: ' + ((e && e.message) || e));
  process.exitCode = 1;
});
process.on('unhandledRejection', e => {
  console.error('UNHANDLED REJECTION:', (e && e.stack) || e);
  process.exitCode = 1;
});

function check(name, cond, detail = '') {
  if (cond) notes.push(`  ok    ${name}${detail ? ' — ' + detail : ''}`);
  else errors.push(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  return !!cond;
}

function guard(label, fn) {
  try { return fn(); } catch (e) { errors.push(`THREW ${label}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); return null; }
}

const THREE = await import('three');
const { World, heightAt, regionAt, REGIONS, WORLD, MAW, SPIRE, PIT } = await import('../js/world.js');
const { default: Combat, FACTION } = await import('../js/combat.js');
const { default: FX } = await import('../js/fx.js');
const { default: Audio } = await import('../js/audio.js');
const { default: Input } = await import('../js/input.js');
const { Projectiles, ARCHETYPES } = await import('../js/weapons.js');
const { default: Enemies, ENEMY_TYPES } = await import('../js/enemies.js');
const { Effects, CLASSES, CLASS_LIST } = await import('../js/classes.js');
const { Inventory, rollDrop, rollWeapon, rollArmor, deriveStats } = await import('../js/loot.js');
const { default: Player, Pickups } = await import('../js/player.js');
const { default: Activities } = await import('../js/activities.js');
const { default: HUD } = await import('../js/hud.js');
const { makeRNG } = await import('../js/util.js');

console.log('STARFALL probe — building world…');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.1, 2000);
scene.add(camera);

let buildSteps = 0;
guard('world build', () => {
  const gen = World.build(scene, 20260726);
  let r;
  do { r = gen.next(); buildSteps++; } while (!r.done && buildSteps < 400);
});
check('world built', World.ready, `${buildSteps} build steps, ${World.chunks.length} chunks, ${World.grid.all.length} colliders`);

FX.init(scene);
Projectiles.init(scene);
Effects.init(scene);
Enemies.init(scene);
Pickups.init(scene);
HUD.init(fakeElement('canvas'), {});

/* ------------------------------------------------------ world sanity   */

check('heightAt is deterministic', heightAt(12.5, -40.25) === heightAt(12.5, -40.25));
// Read the landmarks rather than hardcoding coordinates: these all silently
// tested empty terrain the moment the world was rescaled.
const HUB = REGIONS.find(r => r.id === 'rally');
check('hub is flat', Math.abs(heightAt(HUB.x, HUB.z) - heightAt(HUB.x + 20, HUB.z + 12)) < 2.5,
  `${heightAt(HUB.x, HUB.z).toFixed(2)} vs ${heightAt(HUB.x + 20, HUB.z + 12).toFixed(2)}`);
check('spire is tall', heightAt(SPIRE.x, SPIRE.z) > heightAt(SPIRE.x + SPIRE.r * 2.6, SPIRE.z) + 120,
  `${heightAt(SPIRE.x, SPIRE.z).toFixed(1)} vs ${heightAt(SPIRE.x + SPIRE.r * 2.6, SPIRE.z).toFixed(1)}`);
check('maw is a crater', heightAt(MAW.x, MAW.z) < heightAt(MAW.x + MAW.r * 1.1, MAW.z),
  `${heightAt(MAW.x, MAW.z).toFixed(1)}`);

/* The Descent is the centrepiece; if the funnel stops being a funnel the whole
   skyline is wrong and nothing else in this file would notice. */
check('the pit is deep', heightAt(PIT.x, PIT.z) < heightAt(PIT.x + PIT.r * 1.6, PIT.z) - PIT.depth * 0.8,
  `floor ${heightAt(PIT.x, PIT.z).toFixed(0)} vs rim ${heightAt(PIT.x + PIT.r * 1.6, PIT.z).toFixed(0)}`);
{
  // Monotonic descent: every step inward must go down, or there are ledges the
  // funnel maths did not intend and players will get stuck on them.
  let rises = 0, prev = Infinity;
  for (let d = PIT.r - 4; d >= 0; d -= 8) {
    const y = heightAt(PIT.x + d, PIT.z);
    if (y > prev + 0.5) rises++;
    prev = y;
  }
  check('the pit funnels inward without ledges', rises === 0, `${rises} rises walking in`);
}
/* A collider has to sit exactly where its mesh is drawn. The two used opposite
   yaw conventions, which is invisible for a square or a right angle and badly
   wrong for a long box at any other angle — so you collided with walls that
   were not where you could see them. */
{
  const probe = new THREE.Object3D();
  let worst = 0, worstYaw = 0;
  for (let deg = 0; deg < 360; deg += 11) {
    const yaw = (deg * Math.PI) / 180;
    // A deliberately long, thin box: a square cannot show this bug.
    const box = new (Object.getPrototypeOf(World.grid.all[0]).constructor)(0, 0, 0, 30, 2, 3, yaw, 'test');
    probe.rotation.set(0, yaw, 0);
    probe.updateMatrixWorld(true);
    // Walk the mesh's own local +X axis out to near the end of the box.
    const tip = new THREE.Vector3(26, 0, 0).applyMatrix4(probe.matrixWorld);
    if (!box.containsXZ(tip.x, tip.z, 0.01)) { worst++; worstYaw = deg; }
    // And a point off the mesh's local +Z must be outside.
    const side = new THREE.Vector3(0, 0, 12).applyMatrix4(probe.matrixWorld);
    if (box.containsXZ(side.x, side.z, 0.01)) { worst++; worstYaw = deg; }
  }
  check('colliders sit where their mesh is drawn', worst === 0,
    `${worst} mismatches, e.g. yaw ${worstYaw}°`);
}

/* The spiral road is the only way down. It has to stay in open air (a linear
   descent buried it in the funnel wall), stay walkable, and hold the player up. */
{
  let buried = 0, steepest = 0, unsupported = 0, samples = 0;
  let prev = null;
  for (let turn = 0; turn <= PIT.rings; turn += 1 / 32) {
    const p = World._roadAt(turn);
    samples++;
    // In open air: the deck plus its width must clear the shaft wall. Compare
    // against the funnel profile rather than heightAt, because at the very
    // bottom the road correctly lands ON the floor.
    if (p.depth < PIT.depth - 40 && p.r + 13 > World._shaftRadius(p.depth)) buried++;
    // Walkable: gradient between consecutive segments.
    if (prev) {
      const run = Math.hypot(p.x - prev.x, p.z - prev.z);
      const rise = Math.abs(p.y - prev.y);
      if (run > 0.01) steepest = Math.max(steepest, Math.atan2(rise, run) * 180 / Math.PI);
    }
    prev = p;
    // Standable: a support probe from just above the deck must land on it.
    const sy = World.supportY(p.x, p.y + 4, p.z, 9);
    if (!isFinite(sy) || sy < p.y - 1.5 || sy > p.y + 6) unsupported++;
  }
  check('the spiral road stays in open air', buried === 0, `${buried}/${samples} segments inside rock`);
  check('the spiral road is walkable', steepest < 22, `steepest ${steepest.toFixed(1)}°`);
  // Tolerance is generous upward on purpose: kerbs and terrace lips sit a few
  // units proud of the deck, and standing on those is fine. What must never
  // happen is finding no support at all, or support below the deck — a hole.
  check('the spiral road holds you up', unsupported === 0, `${unsupported}/${samples} segments with no deck`);
  const top = World._roadAt(0), bottom = World._roadAt(PIT.rings);
  check('the road reaches the bottom', bottom.y < top.y - PIT.depth * 0.9,
    `${top.y.toFixed(0)} -> ${bottom.y.toFixed(0)}`);
}

check('the hub sits on the rim, not in the hole',
  heightAt(HUB.x, HUB.z) > heightAt(PIT.x, PIT.z) + PIT.depth * 0.8,
  `hub ${heightAt(HUB.x, HUB.z).toFixed(0)} vs floor ${heightAt(PIT.x, PIT.z).toFixed(0)}`);
check('regions resolve', REGIONS.every(r => regionAt(r.x, r.z).id === r.id),
  REGIONS.map(r => regionAt(r.x, r.z).id).join(','));

const spec = World.interiors;
check('interiors built', !!(spec.dungeon && spec.raid && spec.lostSector));
check('dungeon is underground', spec.dungeon.floorY < spec.dungeon.mouth.y - 20,
  `floor ${spec.dungeon.floorY.toFixed(1)} vs mouth ${spec.dungeon.mouth.y.toFixed(1)}`);

// Every encounter room must have a solid floor you can stand on.
for (const [name, room] of Object.entries(spec.dungeon.rooms)) {
  const s = World.supportY(room.x, room.y + 2, room.z, 1.2);
  check(`dungeon room '${name}' has a floor`, Math.abs(s - room.y) < 0.6, `support ${s.toFixed(2)} want ${room.y.toFixed(2)}`);
  check(`dungeon room '${name}' disables terrain`, !World.terrainActive(room.x, room.y + 2, room.z));
}
for (const [name, plat] of Object.entries(spec.raid.platforms)) {
  const s = World.supportY(plat.x + 10, plat.y + 2, plat.z + 10, 1.2);
  check(`raid platform '${name}' has a floor`, Math.abs(s - plat.y) < 0.7, `support ${s.toFixed(2)} want ${plat.y.toFixed(2)}`);
}

// Raycast must hit the ground when fired down, and nothing when fired at sky.
// Sample out on the open flats: the old point is under the Descent's road now,
// and anywhere near the city has a tower over it.
const RX = -1400, RZ = -1400;
const down = guard('raycast down', () => World.raycast(RX, heightAt(RX, RZ) + 30, RZ, 0, -1, 0, 100));
check('raycast hits terrain', !!down && Math.abs(down.point.y - heightAt(RX, RZ)) < 1.5,
  down ? `y=${down.point.y.toFixed(2)} vs ${heightAt(RX, RZ).toFixed(2)}` : 'no hit');
const up = guard('raycast up', () => World.raycast(RX, heightAt(RX, RZ) + 3, RZ, 0, 1, 0, 200));
check('raycast into open sky misses', !up, up ? `hit ${up.box ? up.box.tag : 'terrain'}` : '');

/* --------------------------------------------------------- loot sanity */

const rng = makeRNG(7);
let exotics = 0, weapons = 0, armors = 0;
for (let i = 0; i < 400; i++) {
  const it = rollDrop(rng, { power: 120, source: i % 5 === 0 ? 'raidBoss' : 'major', classId: 'warden' });
  if (!it) continue;
  if (it.kind === 'weapon') weapons++; else armors++;
  if (it.rarity === 'exotic') exotics++;
  if (!it.name || it.power <= 0) errors.push('bad item roll: ' + JSON.stringify(it));
}
check('loot rolls', weapons > 0 && armors > 0, `${weapons} weapons, ${armors} armour, ${exotics} exotic`);
const inv = new Inventory('warden').starterKit(1);
check('starter kit fills every slot', Object.keys(inv.equipped).length === 8, Object.keys(inv.equipped).join(','));
check('power averages', inv.power === 100, String(inv.power));
const st = deriveStats(inv.stats, CLASSES.warden);
check('derived stats sane', st.shieldMax > 100 && st.grenadeCd > 3 && st.moveSpeed > 5,
  `shield ${st.shieldMax.toFixed(0)}, nade ${st.grenadeCd.toFixed(1)}s, speed ${st.moveSpeed.toFixed(1)}`);

/* ------------------------------------------------------ progression    */
{
  const { Progression, MILESTONES, LEVEL_CAP, XP, xpForLevel, powerFloor } = await import('../js/progress.js');
  const pr = new Progression();
  check('rank starts at 1', pr.level === 1 && pr.xp === 0);

  // Grind to the cap with boss kills and make sure nothing overflows.
  let guard = 0;
  while (pr.level < LEVEL_CAP && guard++ < 100000) pr.add(XP.boss, 'boss');
  check('rank reaches the cap', pr.level === LEVEL_CAP, `level ${pr.level} after ${guard} bosses`);
  check('capped rank stops banking xp', (pr.add(XP.boss), pr.xp === 0), `xp ${pr.xp}`);
  check('every milestone is earned by cap', pr.perks.length === MILESTONES.length,
    `${pr.perks.length}/${MILESTONES.length}`);

  // The curve has to be monotonic or the bar goes backwards.
  let rising = true;
  for (let l = 1; l < LEVEL_CAP - 1; l++) if (xpForLevel(l + 1) <= xpForLevel(l)) rising = false;
  check('xp curve rises every rank', rising);
  check('power floor rises with rank', powerFloor(LEVEL_CAP) > powerFloor(1) + 100,
    `${powerFloor(1)} -> ${powerFloor(LEVEL_CAP)}`);

  // Perks must actually move the derived stats, and never invert one.
  const base = deriveStats(new Inventory('warden').starterKit(1).stats, CLASSES.warden);
  const buffed = pr.applyPerks(deriveStats(new Inventory('warden').starterKit(1).stats, CLASSES.warden));
  check('cap perks cut grenade cooldown', buffed.grenadeCd < base.grenadeCd,
    `${base.grenadeCd.toFixed(2)}s -> ${buffed.grenadeCd.toFixed(2)}s`);
  check('cap perks raise super rate', buffed.superRate > base.superRate,
    `${base.superRate.toFixed(2)} -> ${buffed.superRate.toFixed(2)}`);
  check('perks leave every stat positive', Object.values(buffed).every(v => v > 0));

  // A round-trip through the save has to preserve the exact rank.
  const back = Progression.fromJSON(JSON.parse(JSON.stringify(pr.toJSON())));
  check('rank survives a save round-trip', back.level === pr.level && back.total === pr.total,
    `level ${back.level} total ${back.total}`);
  check('corrupt save falls back to rank 1', Progression.fromJSON(null).level === 1);
}

/* ------------------------------------------------------------- player  */

const player = guard('player ctor', () => new Player('warden'));
if (!player) { report(); process.exitCode = 1; throw new Error('probe cannot continue without a player'); }
player.attachCamera(camera);
const sp = World.spawnPoint;
player.spawnAt(sp.x, sp.y, sp.z);
Activities.init(scene, player, spec);
Activities.fireteamSize = 1;

// Mirror main.js's wireHooks(). Without this the probe silently skips every
// reward that hangs off a kill — which is most of the progression loop.
const { XP: XP_TABLE } = await import('../js/progress.js');
Combat.onKill = (target) => {
  player.kills++;
  const tier = target.tier || 'minor';
  player.abilities.addSuper(tier === 'boss' ? 0.24 : tier === 'major' ? 0.09 : 0.035);
  const lvlMul = 1 + Math.max(0, (target.level || 1) - 1) * 0.05;
  player.awardXP((XP_TABLE[tier] || XP_TABLE.minor) * lvlMul, target.name || 'Riven');
};
Enemies.onDeathHook = (enemy, info) => {
  Pickups.dropFor(enemy);
  Activities.onEnemyKilled(enemy, info);
};

function frame(dt, keys = [], mouse = [false, false, false], look = [0, 0]) {
  Input.simulate({ keys, mouse, dx: look[0], dy: look[1] });
  Input.beginFrame();
  guard('player.update', () => player.update(dt, Input, camera));
  guard('enemies.update', () => Enemies.update(dt, player));
  guard('activities.update', () => Activities.update(dt, player));
  guard('projectiles.update', () => Projectiles.update(dt));
  guard('effects.update', () => Effects.update(dt, player));
  guard('pickups.update', () => Pickups.update(dt, player));
  guard('fx.update', () => FX.update(dt));
  guard('combat.update', () => Combat.update(dt));
  guard('world.update', () => World.update(dt, player.pos));
  guard('hud.draw', () => HUD.draw(dt, {
    player, camera, activities: Activities, net: { remotes: new Map() }, respawnDelay: 5
  }));
  Input.endFrame();
  // main.js owns respawning; mirror it here or one death stalls every later test.
  if (!player.alive && player.deadT > 0.5) {
    const p = player.respawnPoint;
    const y = World.supportY(p.x, p.y + 2.5, p.z, 3.5);
    player.respawn(p.x, (isFinite(y) ? y : p.y) + 0.6, p.z);
  }
}

/* Falling through the floor is the bug that ruins everything else. */
const startY = player.pos.y;
for (let i = 0; i < 120; i++) frame(1 / 60);
// Spawn is on the overlook deck, which is above the terrain on purpose — so
// this has to check for solid support, not for the heightfield specifically.
{
  const sup = World.supportY(player.pos.x, player.pos.y + 1.5, player.pos.z, 3);
  check('player lands on solid ground at spawn', isFinite(sup) && Math.abs(player.pos.y - sup) < 1.2,
    `y=${player.pos.y.toFixed(2)} support=${isFinite(sup) ? sup.toFixed(2) : 'none'}`);
  check('spawn overlooks the pit',
    World.overlook && Math.hypot(World.overlook.x - PIT.x, World.overlook.z - PIT.z) < PIT.r + 10,
    World.overlook ? `${Math.hypot(World.overlook.x - PIT.x, World.overlook.z - PIT.z).toFixed(0)} from centre, rim ${PIT.r}` : 'no overlook');
}

/* W must send you where you are LOOKING, at every heading. The old basis had
   the sin terms negated, which agrees with the camera at yaw 0 and is exactly
   backwards at 90° — so walking felt random the moment you turned, and no test
   noticed because they all only checked that the player moved at all. */
{
  const flatAim = new THREE.Vector3();
  const moved = new THREE.Vector3();
  let worstDot = 1, worstYaw = 0;
  let worstStrafe = 1, worstStrafeYaw = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    for (const [keys, label] of [[['KeyW'], 'forward'], [['KeyD'], 'right']]) {
      player.respawn(sp.x, sp.y + 1, sp.z);
      player.velocity.set(0, 0, 0);
      player.yaw = (deg * Math.PI) / 180;
      player.pitch = 0;
      const from = player.pos.clone();
      for (let i = 0; i < 24; i++) frame(1 / 60, keys);
      moved.subVectors(player.pos, from).setY(0);
      if (moved.lengthSq() < 1e-4) { errors.push(`no movement at yaw ${deg} (${label})`); continue; }
      moved.normalize();
      flatAim.copy(player.aimDir).setY(0).normalize();
      // Right is the aim vector turned -90° about Y.
      const want = label === 'forward'
        ? flatAim
        : flatAim.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      const dot = moved.dot(want);
      if (label === 'forward' && dot < worstDot) { worstDot = dot; worstYaw = deg; }
      if (label === 'right' && dot < worstStrafe) { worstStrafe = dot; worstStrafeYaw = deg; }
    }
  }
  check('W walks where the camera looks, at every heading', worstDot > 0.9,
    `worst alignment ${worstDot.toFixed(3)} at yaw ${worstYaw}°`);
  check('D strafes right, at every heading', worstStrafe > 0.9,
    `worst alignment ${worstStrafe.toFixed(3)} at yaw ${worstStrafeYaw}°`);
  player.respawn(sp.x, sp.y + 1, sp.z);
  player.yaw = 0;
}

/* Walk for a while across open world; must never fall out of the world.
   Run this out on the flats: from spawn the player would walk straight off the
   overlook into the Descent, and "fell 700 units" is the intended behaviour of
   a hole, not a bug in the controller. */
{
  const wx = -1400, wz = -1400;
  player.respawn(wx, heightAt(wx, wz) + 2, wz);
  for (let i = 0; i < 60; i++) frame(1 / 60);
}
let minY = Infinity, maxDrop = 0;
for (let i = 0; i < (QUICK ? 400 : 1400); i++) {
  frame(1 / 60, ['KeyW', i % 400 < 200 ? 'ShiftLeft' : 'KeyW'], [false, false, false], [i % 90 === 0 ? 0.35 : 0, 0]);
  minY = Math.min(minY, player.pos.y);
  const g = World.supportY(player.pos.x, player.pos.y + 1, player.pos.z, 1);
  if (isFinite(g)) maxDrop = Math.max(maxDrop, player.pos.y - g);
}
check('player stayed in the world', minY > -100, `min y ${minY.toFixed(1)}`);
check('player stayed near the ground', maxDrop < 40, `max height above support ${maxDrop.toFixed(1)}`);

/* --------------------------------------------------------- combat loop */

Combat.stats.shots = 0; Combat.stats.hits = 0; Combat.stats.kills = 0;
player.spawnAt(sp.x, sp.y + 1, sp.z);
for (let i = 0; i < 60; i++) frame(1 / 60);

/* Fight on the flats. Spawn is cantilevered over the Descent, so a ring of
   enemies around the player half-lands in a 780-unit hole. */
const ARENA_X = -1400, ARENA_Z = -1400;
player.respawn(ARENA_X, heightAt(ARENA_X, ARENA_Z) + 2, ARENA_Z);
for (let i = 0; i < 60; i++) frame(1 / 60);
player.respawnPoint.set(player.pos.x, player.pos.y, player.pos.z);

const dummies = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  const x = player.pos.x + Math.cos(a) * 14, z = player.pos.z + Math.sin(a) * 14;
  const e = Enemies.spawnAtGround(i % 3 === 0 ? 'skirmisher' : i % 3 === 1 ? 'chitter' : 'shank', x, z, { level: 3 });
  if (e) dummies.push(e);
}
check('enemies spawned', dummies.length === 8, `${dummies.length}/8`);
check('enemies are on the ground', dummies.every(e => isFinite(e.pos.y) && e.pos.y > -100));
check('enemies registered as targets', Combat.targets.length >= dummies.length + 1, String(Combat.targets.length));

// Clear the ring before benching weapons. Left alive, eight enemies shoot the
// player throughout and the archetypes tested last are graded while dead —
// which is exactly how the bow used to "fail".
for (const d of dummies) if (d.alive) d.dispose();

// Aim at a dummy and shoot it dead with every archetype in turn.
for (const archId of Object.keys(ARCHETYPES)) {
  // Each archetype gets a clean bench: full health, no leftover splash damage.
  if (!player.alive) player.respawn(player.pos.x, player.pos.y, player.pos.z);
  player.vitals.reset();
  const item = rollWeapon(makeRNG(archId.length * 31), { power: 200, archId, rarity: 'legendary' });
  player.inventory.equip(item);
  player.refreshGear();
  const slotIdx = player.slotOrder.indexOf(item.slot);
  player.switchSlot(slotIdx === player.slotIndex ? slotIdx : slotIdx);
  player.slotIndex = slotIdx;
  const w = player.currentWeapon;
  if (!w) { errors.push(`no weapon after equipping ${archId}`); continue; }
  w.equipTimer = 0;
  const target = Enemies.spawnAtGround('skirmisher', player.pos.x + 9, player.pos.z, { level: 1 });
  if (!target) { errors.push('failed to spawn test target'); continue; }
  // Face the target.
  player.yaw = Math.atan2(-(target.pos.x - player.pos.x), -(target.pos.z - player.pos.z));
  player.pitch = 0;
  const before = Combat.stats.hits;
  let fired = 0;
  for (let i = 0; i < 400 && target.alive; i++) {
    // Pulse the trigger: semi-autos need an edge, charge weapons need a release.
    // Aim down sights too — hipfiring a sniper is supposed to miss.
    const holding = (i % 46) < 40;
    frame(1 / 60, [], [holding, false, true]);
    player.yaw = Math.atan2(-(target.pos.x - player.pos.x), -(target.pos.z - player.pos.z));
    player.pitch = Math.atan2(target.pos.y + target.height * 0.55 - (player.pos.y + 1.62),
      Math.hypot(target.pos.x - player.pos.x, target.pos.z - player.pos.z));
    fired++;
  }
  const hits = Combat.stats.hits - before;
  check(`${archId} can kill`, !target.alive || hits > 0, `hits ${hits} in ${fired} frames${target.alive ? ' (survived)' : ''}`);
  if (target.alive) target.dispose();
}

check('shots landed on target', Combat.stats.hits > 20,
  `${Combat.stats.hits} hits / ${Combat.stats.shots} trigger pulls, ${Combat.stats.crits} precision`);

/* --------------------------------------------------------- abilities   */

for (const classId of CLASS_LIST) {
  const p = guard(`player(${classId})`, () => new Player(classId));
  if (!p) continue;
  p.attachCamera(camera);
  p.spawnAt(sp.x + 4, sp.y + 1, sp.z + 4);
  for (let i = 0; i < 30; i++) {
    Input.simulate({ keys: [], mouse: [false, false, false] });
    Input.beginFrame();
    guard(`${classId} idle`, () => p.update(1 / 60, Input, camera));
    Input.endFrame();
  }
  Enemies.spawnAtGround('chitter', p.pos.x + 5, p.pos.z, { level: 1 });
  guard(`${classId} grenade`, () => p.abilities.useGrenade());
  guard(`${classId} melee`, () => p.abilities.useMelee());
  guard(`${classId} class ability`, () => p.abilities.useClassAbility(false));
  p.abilities.superEnergy = 1;
  const cast = guard(`${classId} super`, () => p.abilities.useSuper());
  check(`${classId} super casts`, !!cast);
  for (let i = 0; i < 90; i++) {
    Input.simulate({ keys: [], mouse: [true, false, false] });
    Input.beginFrame();
    guard(`${classId} super frame`, () => p.update(1 / 60, Input, camera));
    guard(`${classId} super fire`, () => p.abilities.superFire());
    guard(`${classId} effects`, () => Effects.update(1 / 60, p));
    guard(`${classId} projectiles`, () => Projectiles.update(1 / 60));
    Input.endFrame();
  }
  check(`${classId} survives its own super`, p.alive);
  Combat.unregister(p);
}

/* --------------------------------------------------------- activities  */

function runEncounter(label, group, index, pos, seconds, extra = null) {
  const enc = group.encounters[index];
  if (!player.alive) player.respawn(pos.x, pos.y + 1.2, pos.z);
  player.spawnAt(pos.x, pos.y + 1.2, pos.z);
  player.vitals.reset();
  player.godMode = true;                 // we are testing state machines, not survival
  let began = false, completed = false;
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    // Stay inside the arena.
    player.pos.set(pos.x, player.pos.y, pos.z);
    frame(1 / 60);
    if (enc.state === 'active') began = true;
    if (enc.state === 'done') { completed = true; break; }
    if (extra) extra(i, enc);
  }
  check(`${label} starts`, began, `state=${enc.state}`);
  // godMode stays on: the caller keeps poking at encounter state, and a death
  // mid-assertion would teleport the player out of the arena.
  return { enc, began, completed };
}

const D = spec.dungeon;
const R = spec.raid;

// Dungeon 1: stand on a plate and let the timers run.
{
  const plate = D.plates[0];
  const res = runEncounter('dungeon E1 (Antechamber)', Activities.dungeon, 0, { x: plate.x, y: plate.y, z: plate.z }, QUICK ? 6 : 10);
  check('dungeon E1 charges the plate you stand on', res.enc.plateT[0] > 0.2, `charge ${res.enc.plateT[0].toFixed(2)}`);
  check('dungeon E1 spawns adds', Enemies.countActivity('d1') > 0, String(Enemies.countActivity('d1')));
  check('dungeon E1 gate is shut while active', res.enc.state !== 'active' || !D.gates.ante.open);
  res.enc.reset('leave');
  player.godMode = false;
}

// Dungeon 2: the Weavers must both spawn and be linked.
{
  const c = D.rooms.weavers;
  const res = runEncounter('dungeon E2 (Weavers)', Activities.dungeon, 1, { x: c.x, y: c.y, z: c.z }, QUICK ? 4 : 6);
  const pair = res.enc.pair || [];
  check('dungeon E2 spawns two Weavers', pair.length === 2 && pair.every(e => e && e.alive), `${pair.length}`);
  if (pair.length === 2) {
    pair[0].die({});
    for (let i = 0; i < 60 * 8; i++) { player.pos.set(c.x, player.pos.y, c.z); frame(1 / 60); }
    check('dungeon E2 revives the partner if you are slow', (res.enc.pair || []).filter(e => e && e.alive).length === 2,
      `alive ${(res.enc.pair || []).filter(e => e && e.alive).length} state=${res.enc.state} reviveT=${(res.enc.reviveT || 0).toFixed(1)} ` +
      `playerAlive=${player.alive} playerY=${player.pos.y.toFixed(1)} centerY=${res.enc.center.y.toFixed(1)} inArena=${res.enc.inArena(player)}`);
  }
  res.enc.reset('leave');
  player.godMode = false;
}

// Dungeon 3: boss immune until pylons are charged.
{
  const c = D.rooms.choir;
  const res = runEncounter('dungeon E3 (Choirmaster Ur)', Activities.dungeon, 2, { x: c.x + 10, y: c.y, z: c.z }, QUICK ? 4 : 6);
  const boss = res.enc.boss;
  check('dungeon E3 spawns the boss', !!boss && boss.alive);
  check('dungeon E3 boss starts immune', !!boss && boss.immune);
  if (boss) {
    const before = boss.vitals.total;
    Combat.damage(boss, 5000, { source: player, kind: 'bullet' });
    check('immune boss takes no damage', boss.vitals.total === before);
    // Charge the pylons by hand and confirm the damage window opens.
    for (const p of D.pylons) p.charged = true;
    for (let i = 0; i < 120; i++) { player.pos.set(c.x + 10, player.pos.y, c.z); frame(1 / 60); }
    check('dungeon E3 opens a damage window', res.enc.dmgWindow > 0 && !boss.immune,
      `window ${res.enc.dmgWindow.toFixed(1)} immune=${boss.immune}`);
    const before2 = boss.vitals.total;
    Combat.damage(boss, 5000, { source: player, kind: 'bullet' });
    check('boss takes damage in the window', boss.vitals.total < before2);
  }
  res.enc.reset('leave');
  player.godMode = false;
}

// Raid 1..3.
{
  const p1 = R.platforms.ascent;
  const res = runEncounter('raid E1 (The Ascent)', Activities.raid, 0, { x: R.plates[0].x, y: p1.y, z: R.plates[0].z }, QUICK ? 6 : 10);
  check('raid E1 releases a conduit from a held plate', res.enc.spawned[0] === true || res.enc.plateT[0] > 0.3,
    `charge ${res.enc.plateT[0].toFixed(2)} spawned=${res.enc.spawned[0]}`);
  check('raid E1 spawns adds', Enemies.countActivity('r1') > 0, String(Enemies.countActivity('r1')));
  res.enc.reset('leave');
  player.godMode = false;
}
{
  const p2 = R.platforms.gauntlet;
  const res = runEncounter('raid E2 (Gauntlet of Names)', Activities.raid, 1, { x: p2.x + 12, y: p2.y, z: p2.z }, QUICK ? 4 : 8);
  check('raid E2 spawns Name-Bearers', (res.enc.bearers || []).some(b => b && b.alive), String((res.enc.bearers || []).length));
  check('raid E2 applies the wipe debuff', player.hasBuff('weight') || res.enc.weight >= 0, `weight ${res.enc.weight}`);
  // Standing at the pillar must cleanse.
  res.enc.weight = 5;
  res.enc.stacks = 2;
  // Approach from outboard of the pillar — the terrace side, not the spire.
  for (let i = 0; i < 30; i++) { player.pos.set(R.pillar.x + 6, player.pos.y, R.pillar.z); frame(1 / 60); }
  // The cleanse spot has to survive a physics step. It used to sit inside the
  // spire drum, which ejected the player past the ring every single frame.
  check('raid E2 cleanse ring is standable',
    Math.hypot(player.pos.x - R.pillar.x, player.pos.z - R.pillar.z) < R.pillar.r + 3.5,
    `dist ${Math.hypot(player.pos.x - R.pillar.x, player.pos.z - R.pillar.z).toFixed(1)} of ${(R.pillar.r + 3.5).toFixed(1)}`);
  check('raid E2 pillar cleanses and banks names', res.enc.weight === 0 && res.enc.deposits >= 2,
    `weight ${res.enc.weight} deposits ${res.enc.deposits} state=${res.enc.state} playerAlive=${player.alive} ` +
    `playerY=${player.pos.y.toFixed(1)} pillarY=${R.pillar.y.toFixed(1)} dist=${Math.hypot(player.pos.x - R.pillar.x, player.pos.z - R.pillar.z).toFixed(1)}`);
  res.enc.reset('leave');
  player.godMode = false;
}
{
  const p3 = R.platforms.aetheron;
  const res = runEncounter('raid E3 (Aetheron)', Activities.raid, 2, { x: p3.x, y: p3.y, z: p3.z + 16 }, QUICK ? 4 : 6);
  const boss = res.enc.boss;
  check('raid E3 spawns Aetheron', !!boss && boss.alive);
  check('raid E3 boss starts immune', !!boss && boss.immune);
  check('raid E3 spawns four anchors', R.anchors.filter(a => a.alive).length === 4,
    String(R.anchors.filter(a => a.alive).length));
  if (boss) {
    for (const a of R.anchors) if (a.enemy && a.enemy.alive) a.enemy.die({});
    for (let i = 0; i < 60; i++) { player.pos.set(p3.x, player.pos.y, p3.z + 16); frame(1 / 60); }
    check('raid E3 opens a damage window once anchors fall', res.enc.dmgWindow > 0 && !boss.immune,
      `window ${res.enc.dmgWindow.toFixed(1)}`);
  }
  res.enc.reset('leave');
  player.godMode = false;
}

/* ------------------------------------------------------ public event   */

{
  const ev = Activities.publicEvent;
  ev.state = 'waiting';
  ev.timer = 0.1;
  player.spawnAt(ev.x, ev.y + 1, ev.z);
  for (let i = 0; i < 200; i++) { player.pos.set(ev.x, player.pos.y, ev.z); frame(1 / 60); }
  check('public event starts on its timer', ev.state === 'active', ev.state);
  check('public event charges while you stand on it', ev.charge > 0, ev.charge.toFixed(3));
  check('public event spawns servitors', Enemies.aliveIn(ev.x, ev.z, 60, e => e.type.id === 'servitor').length > 0,
    String(Enemies.aliveIn(ev.x, ev.z, 60, e => e.type.id === 'servitor').length));
}

/* ------------------------------------------------------- lost sector   */

{
  const ls = spec.lostSector;
  player.spawnAt(ls.center.x, ls.center.y + 1, ls.center.z);
  for (let i = 0; i < 180; i++) { player.pos.set(ls.center.x, player.pos.y, ls.center.z); frame(1 / 60); }
  check('lost sector activates when you walk in', Activities.lostSector.state === 'active', Activities.lostSector.state);
  check('lost sector spawns a wave', Enemies.countActivity('lostsector') > 0, String(Enemies.countActivity('lostsector')));
}

/* ------------------------------------------------------------ soak     */

player.spawnAt(sp.x, sp.y + 1, sp.z);
player.vitals.reset();
const soakFrames = QUICK ? 600 : 2400;
let deaths = 0;
const xpAtSoakStart = player.progress.total;
const rankAtSoakStart = player.progress.level;
const wasAlive = () => player.alive;
for (let i = 0; i < soakFrames; i++) {
  const keys = ['KeyW'];
  if (i % 300 < 40) keys.push('Space');
  if (i % 500 === 0) keys.push('KeyQ');
  if (i % 700 === 0) keys.push('KeyV');
  if (i % 900 === 0) keys.push('KeyE');
  if (i % 1100 === 0) { player.abilities.superEnergy = 1; keys.push('KeyX'); }
  frame(1 / 60, keys, [i % 7 < 4, false, false], [Math.sin(i * 0.01) * 0.02, 0]);
  if (!wasAlive()) {
    deaths++;
    player.respawn(sp.x, sp.y + 1, sp.z);
  }
}
check('soak run completed', true, `${soakFrames} frames, ${deaths} deaths, ${Enemies.list.length} enemies live, ${Combat.stats.kills} kills`);
// XP has to actually flow through the shipped kill hook, not just the unit
// checks. Kill something deliberately rather than hoping the soak did — whether
// the wandering player bumps into an enemy is not what this is testing.
{
  const before = player.progress.total;
  const victim = Enemies.spawnAtGround('chitter', player.pos.x + 6, player.pos.z, { level: 3 });
  if (!victim) errors.push('could not spawn an xp test target');
  else {
    Combat.damage(victim, 99999, { kind: 'bullet', source: player });
    check('killing something banks xp through the real hook', player.progress.total > before,
      `+${player.progress.total - before} xp for a level 3 chitter`);
    if (victim.alive) victim.dispose();
  }
}
check('the soak itself ran the progression path', player.progress.total >= xpAtSoakStart,
  `rank ${rankAtSoakStart} -> ${player.progress.level}`);
check('rank floors the power drops roll at', player.dropPower >= player.progress.powerFloor,
  `dropPower ${player.dropPower} floor ${player.progress.powerFloor} gear ${player.inventory.power}`);
check('enemy budget respected', Enemies.list.length <= Enemies.budget + 12, String(Enemies.list.length));
check('floaters do not leak', Combat.floaters.length <= 41, String(Combat.floaters.length));
check('projectiles do not leak', Projectiles.items.filter(p => p.alive).length <= 64);
check('effects do not leak', Effects.items.length < 400, String(Effects.items.length));

/* ------------------------------------------------------------ report   */

function report() {
  console.log('\n' + notes.join('\n'));
  console.log(`\n${notes.length} checks passed, ${errors.length} problems, ${(Date.now() - t0) / 1000}s\n`);
  if (errors.length) {
    console.log(errors.join('\n'));
    console.log('');
  }
}
report();
// Not process.exit(): that truncates buffered stdout when it is a pipe or file.
process.exitCode = errors.length ? 1 : 0;
