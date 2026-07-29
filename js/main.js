/* STARFALL — main.js
   Boot, the frame loop, and the wiring between systems. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, makeRNG, Avg } from './util.js';
import Input from './input.js';
import Audio from './audio.js';
import FX from './fx.js';
import World, { heightAt, regionAt, REGIONS, PIT } from './world.js';
import Combat from './combat.js';
import { Projectiles } from './weapons.js';
import Enemies, { ENEMY_TYPES } from './enemies.js';
import { Effects, CLASSES } from './classes.js';
import { Inventory } from './loot.js';
import Player, { Pickups } from './player.js';
import { XP, LEVEL_CAP, Progression } from './progress.js';
import Activities from './activities.js';
import HUD from './hud.js';
import UI from './ui.js';
import Net from './net.js';

const SAVE_KEY = 'starfall.save.v1';

const game = {
  scene: null, camera: null, renderer: null,
  player: null, activities: Activities, hud: HUD, input: Input, net: Net, ui: UI,
  respawnDelay: 5,
  remoteObjective: null,
  combatStats: Combat.stats,
  paused: false,
  time: 0,
  fps: new Avg(90)
};
window.STARFALL = game;

/* ------------------------------------------------------------------ boot */

function boot() {
  const canvas = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  game.renderer = renderer;

  const scene = new THREE.Scene();
  game.scene = scene;
  // Far plane has to clear the sky dome, or the top of the world gets clipped
  // the moment you look up from the bottom of the Descent.
  const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.08, 14000);
  scene.add(camera);
  game.camera = camera;

  HUD.init(document.getElementById('hud'), game);
  UI.init(game);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    HUD.resize();
  });

  UI.showClassSelect(opts => {
    Audio.init();
    Audio.resume();
    startGame(opts);
  });
}

function setBoot(msg, pct) {
  const b = document.getElementById('bootmsg');
  const bar = document.getElementById('bootbar');
  if (b) b.textContent = msg;
  if (bar) bar.style.width = Math.round(pct * 100) + '%';
}

function startGame(opts) {
  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.style.display = 'flex';

  const saved = loadSave();
  const sameGuardian = saved && saved.classId === opts.classId;
  const inventory = sameGuardian ? Inventory.fromJSON(saved.inventory) : null;
  // Rank belongs to the character, so it only carries over with the class.
  const progress = sameGuardian ? Progression.fromJSON(saved.progress) : null;

  const gen = World.build(game.scene, 20260726);
  const step = () => {
    const t0 = performance.now();
    let res;
    // Build in slices so the loading bar actually moves.
    do { res = gen.next(); } while (!res.done && performance.now() - t0 < 24);
    if (res.value) setBoot(res.value.msg + '…', res.value.p);
    if (!res.done) { requestAnimationFrame(step); return; }
    finishStart(opts, inventory, progress);
  };
  requestAnimationFrame(step);
}

function finishStart(opts, inventory, progress) {
  const scene = game.scene;
  FX.init(scene);
  Projectiles.init(scene);
  Effects.init(scene);
  Enemies.init(scene);
  Pickups.init(scene);

  const player = new Player(opts.classId, inventory, progress);
  player.name = opts.name || 'Guardian';
  const sp = World.spawnPoint.clone();
  // ?at=x,z drops you anywhere on the surface — for looking at the far side of
  // a 3600-unit world without walking there first.
  const at = new URLSearchParams(location.search).get('at');
  if (at) {
    const [ax, az] = at.split(',').map(Number);
    if (isFinite(ax) && isFinite(az)) {
      const y = World.supportY(ax, heightAt(ax, az) + 90, az, 220);
      sp.set(ax, (isFinite(y) ? y : heightAt(ax, az)) + 2.2, az);
    }
  }
  player.spawnAt(sp.x, sp.y, sp.z);
  // Face the Descent, and start tilted down over the rail. The first thing a
  // new guardian should see is the hole, not the horizon above it.
  player.yaw = Math.atan2(-(PIT.x - sp.x), -(PIT.z - sp.z));
  if (!at) player.pitch = -0.26;
  player.attachCamera(game.camera);
  game.player = player;

  Activities.init(scene, player, World.interiors);
  Net.init(scene, game);
  Net.connect(opts.server === '' ? null : (opts.server || 'auto'));

  wireHooks();

  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.style.display = 'none';

  Input.init(game.renderer.domElement);
  game.renderer.domElement.addEventListener('mousedown', () => {
    if (!UI.isOpen && !Input.captureText) Input.lock();
  });
  Input.lock();

  HUD.toast('THE SUNDERED SHORE', '#8fd8ff', 'Walk anywhere. The Spire is north.');
  Activities.banner('STARFALL', 'The shore is open', 4);

  game.running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------- wiring   */

function wireHooks() {
  const player = game.player;

  player.onLootCb = item => {
    const r = item.rarity;
    HUD.toast(item.name, r === 'exotic' ? '#f5c542' : r === 'legendary' ? '#c084fc' : r === 'rare' ? '#5a8cff' : '#c9c9c9',
      `${item.kind === 'weapon' ? 'Weapon' : 'Armour'} · Power ${item.power}`);
    Audio.play(r === 'exotic' ? 'exotic' : 'pickup', { vol: 0.9 });
    if (r === 'exotic') Activities.banner('EXOTIC', item.name, 4);
    // Auto-equip straight upgrades so the loop keeps moving.
    const cur = player.inventory.equipped[item.slot];
    if (!cur || item.power > cur.power + 1) {
      player.equip(item);
      HUD.toast('EQUIPPED', '#9dff7a', item.name);
    }
    saveGame();
  };

  player.onDeathCb = () => {
    Activities.onPlayerDeath();
    Combat.pushKillFeed('You were killed');
  };

  player.onLevelCb = ev => {
    const capped = ev.level >= LEVEL_CAP;
    Activities.banner(`RANK ${ev.level}`, ev.perk ? ev.perk.name : (capped ? 'Guardian maxed' : 'Power rising'), 3.4);
    HUD.toast(`RANK ${ev.level}`, '#ffd166', ev.perk ? ev.perk.desc : `Power floor ${player.progress.powerFloor}`);
    Audio.play(ev.perk ? 'exotic' : 'objective', { vol: 1 });
    FX.burst(player.pos, { count: 40, speed: 8, color: 0xffd166, life: 1.1, size: 0.22 });
    saveGame();
  };

  Combat.onKill = (target, info) => {
    player.kills++;
    const tier = target.tier || 'minor';
    player.abilities.addSuper(tier === 'boss' ? 0.24 : tier === 'major' ? 0.09 : 0.035);
    // Higher-level enemies are worth more — fighting up is the fast lane.
    const lvlMul = 1 + Math.max(0, (target.level || 1) - 1) * 0.05;
    player.awardXP((XP[tier] || XP.minor) * lvlMul, target.name || 'Riven');
    Combat.pushKillFeed(`${player.name} ▸ ${target.name || 'Riven'}`, tier === 'boss' ? 'boss' : 'kill');
    if (tier === 'boss') Activities.banner('TARGET DOWN', target.name || '', 2.6);
  };

  Combat.onPlayerDamaged = () => { /* HUD reads vitals directly */ };

  Enemies.onDeathHook = (enemy, info) => {
    Pickups.dropFor(enemy);
    Activities.onEnemyKilled(enemy, info);
    if (Net.isHost) Net.sendDeath(enemy.netId);
  };

  Enemies.onProxyDamage = (enemy, amount, crit) => Net.reportHit(enemy.netId, amount, crit);
}

/* -------------------------------------------------------------- persist */

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      classId: game.player.classDef.id,
      name: game.player.name,
      inventory: game.player.inventory.toJSON(),
      progress: game.player.progress.toJSON(),
      travel: [...game.player.travelUnlocked]
    }));
  } catch (e) { /* private mode, or full: not worth breaking the game over */ }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/* ------------------------------------------------------- net mirroring  */

game.mirrorEnemies = list => {
  const seen = new Set();
  for (const row of list) {
    const [netId, typeId, x, y, z, yaw, hp, level] = row;
    seen.add(netId);
    let e = game._proxies && game._proxies.get(netId);
    if (!e || !e.alive) {
      if (!ENEMY_TYPES[typeId]) continue;
      e = Enemies.spawn(typeId, x, y, z, { level: level || 1, proxy: true, netId, spawnFX: false });
      if (!e) continue;
      game._proxies = game._proxies || new Map();
      game._proxies.set(netId, e);
    }
    e.netTarget = e.netTarget || new THREE.Vector3();
    e.netTarget.set(x, y, z);
    e.netYaw = yaw;
    e.netHp = hp;
  }
  if (game._proxies) {
    for (const [id, e] of game._proxies) {
      if (!seen.has(id) && e.alive) { e.dispose(); game._proxies.delete(id); }
    }
  }
};

game.mirrorEnemyDeath = netId => {
  const e = game._proxies && game._proxies.get(netId);
  if (e && e.alive) { e.die({ kind: 'remote' }); game._proxies.delete(netId); }
};

game.applyRemoteHit = m => {
  for (const e of Enemies.list) {
    if (e.netId === m.id && e.alive) {
      Combat.damage(e, m.d, { crit: !!m.c, kind: 'bullet', source: { isPlayer: false, remote: true } });
      return;
    }
  }
};

/* ---------------------------------------------------------------- input */

function handleMenuInput() {
  const player = game.player;
  if (Input.captureText) return;

  if (Input.pressed('inventory')) { UI.toggle('inventory'); syncLock(); }
  if (Input.pressed('map')) { UI.toggle('map'); syncLock(); }
  if (Input.pressed('pause')) {
    if (UI.isOpen) UI.closeAll();
    else UI.toggle('pause');
    syncLock();
  }
  if (Input.pressed('chat')) {
    Input.unlock();
    UI.openChat();
    Input.startTextEntry(text => {
      UI.closeChat();
      if (text) Net.chat(text);
      if (!UI.isOpen) Input.lock();
    });
  }
  if (Input.pressed('interact') && player.alive && !UI.isOpen) {
    const t = player.findInteract();
    if (t) doInteract(t);
  }
}

function doInteract(poi) {
  const player = game.player;
  if (poi.kind === 'vendor') {
    UI.toggle('vendor', poi);
    syncLock();
  } else if (poi.kind === 'travel') {
    const key = poi.region || 'rally';
    if (!player.travelUnlocked.has(key)) {
      player.travelUnlocked.add(key);
      HUD.toast('TRANSMAT UNLOCKED', '#8fd8ff', poi.name);
      Audio.play('objective', { vol: 0.9 });
      saveGame();
    }
    player.respawnPoint.copy(player.pos);
    UI.toggle('map');
    syncLock();
  }
}

function syncLock() {
  if (UI.isOpen) Input.unlock();
  else Input.lock();
}

/* ----------------------------------------------------------------- loop */

let last = 0;
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - last) / 1000;
  last = now;
  const dt = clamp(rawDt, 0.0001, 0.05);
  game.fps.push(1 / Math.max(0.0001, rawDt));
  step(dt);
  game.renderer.render(game.scene, game.camera);
}

function step(dt) {
  const player = game.player;
  game.time += dt;
  Input.beginFrame();
  handleMenuInput();

  const menuOpen = UI.isOpen || Input.captureText;
  const inputForPlayer = menuOpen ? null : Input;

  player.update(dt, inputForPlayer, game.camera);
  if (!menuOpen && player.alive) player.findInteract();
  else player.interactTarget = null;

  // Host simulates the world; clients mirror it.
  const simulate = Net.isHost || !Net.connected;
  Activities.fireteamSize = Net.fireteamSize;
  if (Input.captureText) UI.updateChat(Input.textBuffer);

  if (simulate) {
    Enemies.update(dt, player);
    Activities.update(dt, player);
  } else {
    Enemies.update(dt, null);
    Activities.waypoints.length = 0;
    Activities.objective = game.remoteObjective;
  }

  Projectiles.update(dt);
  Effects.update(dt, player);
  Pickups.update(dt, player);
  FX.update(dt);
  Combat.update(dt);
  World.update(dt, player.pos);
  Net.update(dt, player);

  if (simulate && Net.connected) {
    game._snapT = (game._snapT || 0) - dt;
    if (game._snapT <= 0) {
      game._snapT = 0.1;
      Net.sendSnapshot(Enemies.list);
      Net.sendObjective(Activities.objective);
    }
  }

  // Audio listener and music intensity.
  Audio.setListener(game.camera.position);
  const threat = Enemies.aliveIn(player.pos.x, player.pos.z, 60).length;
  const inFight = player.vitals.sinceHit < 4 || threat > 0;
  Audio.updateMusic(dt, inFight ? clamp01(0.35 + threat * 0.08) : 0);

  discovery(player);
  deathAndRespawn(dt, player);

  HUD.draw(dt, game);
  Input.endFrame();
}

let lastRegion = null;
function discovery(player) {
  const reg = regionAt(player.pos.x, player.pos.z);
  if (reg === lastRegion) return;
  lastRegion = reg;
  if (!player.travelUnlocked.has(reg.id)) {
    player.travelUnlocked.add(reg.id);
    HUD.toast(reg.name.toUpperCase(), '#' + reg.accent.toString(16).padStart(6, '0'), reg.blurb);
    Audio.play('objective', { vol: 0.7 });
    player.awardXP(XP.discovery, 'Discovery');
    saveGame();
  } else {
    HUD.toast(reg.name.toUpperCase(), '#' + reg.accent.toString(16).padStart(6, '0'));
  }
}

function deathAndRespawn(dt, player) {
  if (player.alive) return;
  if (player.deadT < game.respawnDelay) return;
  // Respawn at the last safe point. Probe the support with a *small* tolerance:
  // a generous one snaps you to the terrain overhead when the point is in a cave.
  const p = player.respawnPoint;
  const y = World.supportY(p.x, p.y + 2.5, p.z, 3.5);
  player.respawn(p.x, (isFinite(y) ? y : p.y) + 0.6, p.z);
  HUD.toast('REVIVED', '#8fd8ff');
}

/* --------------------------------------------------------------- start  */

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

export default game;
