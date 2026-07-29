/* STARFALL — player.js
   Movement first: this is a shooter, and the shooter is only as good as how it
   feels to move and look. Ground accel, air control, sprint, slide, class jump,
   step-up, recoil that recovers, ADS that zooms, and shields that pop.

   The player is also a Combat target, so enemy fire resolves through exactly
   the same code path player fire does. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, smoothstep, TAU } from './util.js';
import Combat, { FACTION, Vitals } from './combat.js';
import World, { heightAt, regionAt } from './world.js';
import { Weapon, ARCHETYPES, Projectiles } from './weapons.js';
import { CLASSES, Abilities, Effects } from './classes.js';
import { deriveStats, Inventory, WEAPON_SLOTS } from './loot.js';
import { mergeParts } from './enemies.js';
import { Progression } from './progress.js';
import FX from './fx.js';
import Audio from './audio.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const M4 = (x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rz = 0) => {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rz)), new THREE.Vector3(sx, sy, sz));
  return m;
};
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);

const GRAVITY = 26;
const EYE = 1.62;
const CROUCH_EYE = 1.05;
const RADIUS = 0.42;
const STEP = 0.92;

/* --------------------------------------------------------- view models  */

const VIEW_CACHE = new Map();

function viewModelFor(archId) {
  if (VIEW_CACHE.has(archId)) return VIEW_CACHE.get(archId);
  const d = ARCHETYPES[archId];
  const body = 0x2f333c, accent = 0x8fd8ff, metal = 0x5a6270;
  const parts = [];
  const L = {
    auto: [1.0, 0.16], smg: [0.7, 0.15], pulse: [1.05, 0.16], scout: [1.35, 0.14],
    handcannon: [0.62, 0.2], shotgun: [1.25, 0.22], sniper: [1.75, 0.14],
    fusion: [1.1, 0.26], rocket: [1.3, 0.3], gl: [0.95, 0.3], bow: [0.35, 0.1]
  }[archId] || [1.0, 0.16];

  /* Blades are built from a haft and a blade rather than the gun template —
     a scythe rendered as a receiver with a magazine is not a scythe. */
  if (d.mode === 'melee') {
    const steel = 0xc9d4e0, edge = 0xeaf4ff, wrap = 0x2a2118;
    if (d.id === 'knife') {
      parts.push({ geo: BOX.clone(), matrix: M4(0, -0.02, 0.06, 0.045, 0.05, 0.16), color: wrap });
      parts.push({ geo: BOX.clone(), matrix: M4(0, 0.01, -0.16, 0.035, 0.012, 0.28), color: steel });
      parts.push({ geo: BOX.clone(), matrix: M4(0, 0.01, -0.3, 0.014, 0.01, 0.06), color: edge });
    } else if (d.id === 'sword') {
      parts.push({ geo: BOX.clone(), matrix: M4(0, -0.04, 0.1, 0.035, 0.04, 0.2), color: wrap });
      parts.push({ geo: BOX.clone(), matrix: M4(0, 0, 0, 0.12, 0.03, 0.06), color: 0x3a4250 });   // guard
      parts.push({ geo: BOX.clone(), matrix: M4(0, 0.01, -0.5, 0.055, 0.016, 0.55), color: steel });
      parts.push({ geo: BOX.clone(), matrix: M4(0, 0.01, -0.98, 0.02, 0.012, 0.12), color: edge });
    } else if (d.id === 'axe') {
      parts.push({ geo: CYL.clone(), matrix: M4(0, -0.02, -0.16, 0.035, 0.42, 0.035, Math.PI / 2), color: wrap });
      parts.push({ geo: BOX.clone(), matrix: M4(0.1, 0.02, -0.5, 0.16, 0.02, 0.16), color: steel });
      parts.push({ geo: BOX.clone(), matrix: M4(0.22, 0.02, -0.5, 0.06, 0.014, 0.13), color: edge });
      parts.push({ geo: BOX.clone(), matrix: M4(0, 0.02, -0.62, 0.03, 0.02, 0.09), color: steel });
    } else {
      // scythe: long haft, blade sweeping out to one side
      parts.push({ geo: CYL.clone(), matrix: M4(0, -0.04, -0.3, 0.03, 0.62, 0.03, Math.PI / 2), color: wrap });
      parts.push({ geo: BOX.clone(), matrix: M4(0.12, 0.03, -0.86, 0.2, 0.018, 0.07), color: steel });
      parts.push({ geo: BOX.clone(), matrix: M4(0.34, 0.03, -0.76, 0.1, 0.016, 0.14, -0.5), color: steel });
      parts.push({ geo: BOX.clone(), matrix: M4(0.44, 0.03, -0.62, 0.05, 0.012, 0.08, -0.9), color: edge });
    }
    const geo = mergeParts(parts);
    VIEW_CACHE.set(archId, geo);
    return geo;
  }

  parts.push({ geo: BOX.clone(), matrix: M4(0, 0, -L[0] * 0.5, L[1] * 1.1, L[1] * 1.1, L[0]), color: body });
  parts.push({ geo: BOX.clone(), matrix: M4(0, -0.13, 0.06, 0.09, 0.26, 0.14, 0.22), color: 0x1e2128 });   // grip
  parts.push({ geo: BOX.clone(), matrix: M4(0, 0.075, -L[0] * 0.28, 0.05, 0.05, L[0] * 0.5), color: metal }); // rail
  if (d.id === 'sniper' || d.id === 'scout') {
    parts.push({ geo: CYL.clone(), matrix: M4(0, 0.14, -0.28, 0.06, 0.34, 0.06, Math.PI / 2), color: 0x14161b });
    parts.push({ geo: BOX.clone(), matrix: M4(0, 0.145, -0.44, 0.045, 0.045, 0.05), color: accent });
  }
  if (d.id === 'shotgun' || d.id === 'gl' || d.id === 'rocket') {
    parts.push({ geo: CYL.clone(), matrix: M4(0, 0, -L[0] * 0.55, 0.13, L[0] * 0.5, 0.13, Math.PI / 2), color: 0x23262d });
  }
  if (d.id === 'fusion') {
    for (let i = 0; i < 3; i++) {
      parts.push({ geo: CYL.clone(), matrix: M4(-0.08 + i * 0.08, 0.05, -L[0] * 0.55, 0.05, L[0] * 0.42, 0.05, Math.PI / 2), color: 0x1a2b33 });
    }
    parts.push({ geo: BOX.clone(), matrix: M4(0, -0.02, -0.2, 0.16, 0.06, 0.3), color: accent });
  }
  if (d.slot === 'power') parts.push({ geo: BOX.clone(), matrix: M4(0, 0.16, -0.1, 0.1, 0.1, 0.4), color: 0xff8a4c });
  else if (d.slot === 'energy') parts.push({ geo: BOX.clone(), matrix: M4(0, 0.02, -0.06, 0.14, 0.05, 0.2), color: accent });
  parts.push({ geo: BOX.clone(), matrix: M4(0, -0.06, -0.02, 0.11, 0.16, 0.22), color: 0x262a32 });          // mag

  const geo = mergeParts(parts);
  VIEW_CACHE.set(archId, geo);
  return geo;
}

/* ------------------------------------------------------------- pickups  */

class PickupSystem {
  constructor() { this.items = []; this.ready = false; }
  init(scene) {
    this.scene = scene;
    this.geo = new THREE.BoxGeometry(0.5, 0.28, 0.5);
    this.mats = {
      special: new THREE.MeshBasicMaterial({ color: 0x4fd06a }),
      heavy: new THREE.MeshBasicMaterial({ color: 0xa855f7 })
    };
    this.ready = true;
  }
  /** Enemies drop bricks: special from majors, heavy from bosses/rarely. */
  dropFor(enemy) {
    if (!this.ready) return;
    let kind = null;
    if (enemy.tier === 'boss') kind = Math.random() < 0.8 ? 'heavy' : 'special';
    else if (enemy.tier === 'major') kind = Math.random() < 0.55 ? 'special' : (Math.random() < 0.25 ? 'heavy' : null);
    else if (Math.random() < 0.12) kind = 'special';
    if (!kind) return;
    this.spawn(enemy.pos.x, enemy.pos.y + 0.4, enemy.pos.z, kind);
  }
  spawn(x, y, z, kind) {
    const mesh = new THREE.Mesh(this.geo, this.mats[kind]);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.items.push({ mesh, kind, t: 0, life: 45, y });
  }
  update(dt, player) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      it.life -= dt;
      it.mesh.rotation.y += dt * 2.2;
      it.mesh.position.y = it.y + 0.35 + Math.sin(it.t * 2.4) * 0.12;
      if (player && player.alive && player.pos.distanceTo(it.mesh.position) < 2.2) {
        player.giveAmmo(it.kind);
        Audio.play('pickup', { vol: 0.6 });
        FX.burst(it.mesh.position, { count: 8, speed: 3, color: it.kind === 'heavy' ? 0xa855f7 : 0x4fd06a, life: 0.4, size: 0.12 });
        this.scene.remove(it.mesh);
        this.items.splice(i, 1);
        continue;
      }
      if (it.life <= 0) { this.scene.remove(it.mesh); this.items.splice(i, 1); }
    }
  }
  clear() { for (const it of this.items) this.scene.remove(it.mesh); this.items.length = 0; }
}
export const Pickups = new PickupSystem();

/* --------------------------------------------------------------- player */

export class Player {
  constructor(classId = 'warden', inventory = null, progress = null) {
    this.classDef = CLASSES[classId];
    this.isPlayer = true;
    this.faction = FACTION.PLAYER;
    this.name = 'Guardian';

    this.pos = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = false;
    this.crouched = false;
    this.sprinting = false;
    this.sliding = 0;
    this.jumpsLeft = 0;
    this.gliding = false;
    this.eyeH = EYE;
    this.radius = RADIUS;
    this.height = 1.8;
    this.headY = 1.55;
    this.headR = 0.28;
    this.hitColor = 0x8fd8ff;
    this.power = 100;
    this.tier = 'player';

    this.vitals = new Vitals({ health: 100, shield: 140, rechargeDelay: 3.2, rechargeRate: 0.5 });
    this.alive = true;
    this.dead = false;
    this.deadT = 0;

    this.inventory = inventory || new Inventory(classId).starterKit(Date.now() & 0xffff);
    this.progress = progress || new Progression();
    this.onLevelCb = null;
    this.abilities = new Abilities(this, this.classDef);
    this.weapons = { kinetic: null, energy: null, power: null };
    this.slotOrder = WEAPON_SLOTS;
    this.slotIndex = 0;
    this.ads = 0;
    this.adsWant = false;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilVelP = 0;
    this.recoilVelY = 0;
    this.shake = 0;
    this.bob = 0;
    this.landDip = 0;
    this.fov = 78;
    this.carrying = null;
    this.buffs = new Map();
    this.empowerT = 0;
    this.meleeLunge = 0;
    this.interactTarget = null;
    this.travelUnlocked = new Set(['rally']);
    this.stats = null;
    this.kills = 0;
    this.respawnPoint = new THREE.Vector3(0, 12, 16);
    this.onLootCb = null;
    this.onDeathCb = null;
    this.aimDir = new THREE.Vector3(0, 0, -1);
    this.eyePos = new THREE.Vector3();
    this.moveDir = new THREE.Vector3();
    this.lastStep = 0;
    this.refreshGear();
    Combat.register(this);
  }

  /* --------------------------------------------------------------- gear */

  refreshGear() {
    const st = deriveStats(this.inventory.stats, this.classDef);
    // Rank perks ride on top of the gear-derived block, so every consumer of
    // player.stats picks them up without knowing progression exists.
    this.progress.applyPerks(st);
    this.stats = st;
    this.abilities.stats = st;
    this.vitals.maxShield = st.shieldMax;
    this.vitals.shield = Math.min(this.vitals.shield, st.shieldMax);
    this.vitals.rechargeDelay = st.rechargeDelay;
    this.vitals.rechargeRate = st.rechargeRate;
    this.power = this.inventory.power;
    for (const slot of WEAPON_SLOTS) {
      const item = this.inventory.equipped[slot];
      if (!item) { this.weapons[slot] = null; continue; }
      const cur = this.weapons[slot];
      if (!cur || cur.item !== item) {
        const w = new Weapon(item);
        if (cur) {
          if (cur.item.archId === item.archId) {
            // Same gun, better roll: keep the exact ammo state.
            w.ammo = Math.min(w.mag, cur.ammo);
            w.reserve = Math.min(w.reserveMax, cur.reserve);
          } else {
            // Different archetype: fresh mag, but carry the reserve fraction so
            // swapping heavies is not a free ammo refill.
            w.ammo = w.mag;
            w.reserve = Math.round(w.reserveMax * clamp01(cur.reserve / Math.max(1, cur.reserveMax)));
          }
        }
        this.weapons[slot] = w;
      }
    }
    if (!this.currentWeapon) this.slotIndex = 0;
    this._buildViewModel();
  }

  /* Rocket jumping. Your own explosive throws you away from the blast, with
     the vertical component boosted — otherwise firing at your feet does almost
     nothing, because the blast centre is level with them and the push comes out
     flat. Costs a little health so it is a real trade, not free flight. */
  blastImpulse(x, y, z, radius, power) {
    if (!this.alive) return 0;
    const cx = this.pos.x, cy = this.pos.y + this.height * 0.5, cz = this.pos.z;
    const d = Math.hypot(cx - x, cy - y, cz - z);
    if (d > radius * 1.15) return 0;

    const k = clamp01(1 - d / (radius * 1.15));
    const falloff = k * k;                    // punchy up close, nothing at the edge
    _v.set(cx - x, cy - y, cz - z);
    if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
    _v.normalize();
    _v.y = _v.y * 0.55 + 0.85;                // bias upward so a floor shot lifts you
    _v.normalize();

    const push = 30 * falloff;
    this.velocity.x += _v.x * push;
    this.velocity.z += _v.z * push;
    // Never let a blast slam you downward; a rocket under your feet should lift.
    this.velocity.y = Math.max(this.velocity.y + _v.y * push, _v.y * push * 0.85);
    this.grounded = false;
    this.jumpsLeft = Math.max(this.jumpsLeft, 0);

    const self = Math.round(power * 0.10 * falloff);
    if (self > 0) this.applyDamage(self, { kind: 'explosive', selfInflicted: true });
    this.shake = Math.max(this.shake, 0.7 * falloff);
    return push;
  }

  /* ---------------------------------------------------------- progression */

  /** The power the world rolls drops at: your gear, floored by your rank. */
  get dropPower() { return Math.max(this.inventory.power, this.progress.powerFloor); }

  /** Award XP and fire the level-up hook for anything that levelled. */
  awardXP(amount, label = '') {
    const gained = this.progress.add(amount, label);
    if (!gained) return 0;
    // Perks change derived stats, so the block has to be rebuilt on level.
    this.refreshGear();
    while (this.progress.pendingLevels.length) {
      const ev = this.progress.pendingLevels.shift();
      if (this.onLevelCb) this.onLevelCb(ev);
    }
    return gained;
  }

  get currentSlot() { return this.slotOrder[this.slotIndex]; }
  get currentWeapon() { return this.weapons[this.currentSlot]; }

  equip(item) {
    this.inventory.equip(item);
    this.refreshGear();
    Audio.play('swap', { vol: 0.8 });
  }

  switchSlot(i) {
    if (i === this.slotIndex) return;
    if (!this.weapons[this.slotOrder[i]]) return;
    this.slotIndex = i;
    const w = this.currentWeapon;
    if (w) w.onEquip();
    this.adsWant = false;
    Audio.play('swap', { vol: 0.7 });
    this._buildViewModel();
  }

  cycleSlot(dir) {
    for (let k = 1; k <= 3; k++) {
      const i = (this.slotIndex + dir * k + 9) % 3;
      if (this.weapons[this.slotOrder[i]]) { this.switchSlot(i); return; }
    }
  }

  giveAmmo(kind) {
    for (const slot of WEAPON_SLOTS) {
      const w = this.weapons[slot];
      if (!w) continue;
      if (kind === 'special' && w.ammoType === 'special') w.addAmmo(Math.ceil(w.reserveMax * 0.4));
      if (kind === 'heavy' && w.ammoType === 'heavy') w.addAmmo(Math.ceil(w.reserveMax * 0.5));
    }
  }

  onLoot(item) { if (this.onLootCb) this.onLootCb(item); }

  /* -------------------------------------------------------- view model  */

  attachCamera(camera) {
    this.camera = camera;
    this.vmRoot = new THREE.Group();
    camera.add(this.vmRoot);
    this._buildViewModel();
  }

  _buildViewModel() {
    if (!this.vmRoot) return;
    const w = this.currentWeapon;
    if (this.vm) { this.vmRoot.remove(this.vm); this.vm = null; }
    if (!w) return;
    const geo = viewModelFor(w.item.archId);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.vm = new THREE.Mesh(geo, mat);
    this.vm.frustumCulled = false;
    this.vm.renderOrder = 10;
    this.vmRoot.add(this.vm);
    this.vmBase = new THREE.Vector3(0.26, -0.22, -0.42);
    this.vmAds = new THREE.Vector3(0, -0.12, -0.3);
  }

  /* ---------------------------------------------------------- lifecycle */

  spawnAt(x, y, z) {
    this.pos.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.respawnPoint.set(x, y, z);
  }

  applyDamage(amount, info = {}) {
    if (!this.alive || this.godMode) return 0;
    // Ram's damage resist lives in vitals.dr, so it is applied once, in hit().
    const hadShield = this.vitals.shield > 0;
    const res = this.vitals.hit(amount);
    if (res.brokeShield) Audio.play('shieldbreak', { vol: 1 });
    else Audio.play('hurt', { vol: clamp01(amount / 40) * 0.8 });
    this.shake = Math.min(1.2, this.shake + clamp01(amount / 60) * 0.8);
    this.hurtFlash = 1;
    this.hurtDir = info.dir ? Math.atan2(info.dir.x, info.dir.z) : null;
    if (res.died) this.die(info);
    return res.dealt;
  }

  die(info = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.dead = true;
    this.deadT = 0;
    this.abilities.endSuper();
    if (this.carrying) { this.carrying.drop(); }
    Audio.play('fail', { vol: 0.9 });
    FX.burst(this.pos, { count: 26, speed: 7, color: 0x8fd8ff, life: 0.7, size: 0.2 });
    if (this.onDeathCb) this.onDeathCb(info);
  }

  respawn(x, y, z) {
    this.alive = true;
    this.dead = false;
    this.vitals.reset();
    this.velocity.set(0, 0, 0);
    this.pos.set(x, y, z);
    this.abilities.grenadeCd = Math.min(this.abilities.grenadeCd, 3);
    this.abilities.meleeCd = Math.min(this.abilities.meleeCd, 3);
    this.abilities.classCd = Math.min(this.abilities.classCd, 3);
    for (const s of WEAPON_SLOTS) {
      const w = this.weapons[s];
      // Clear the draw too, or a bow/fusion you died mid-charge comes back
      // half-drawn and fires the moment you let go.
      if (w) { w.ammo = w.mag; w.reloading = 0; w.charge = 0; w.burstLeft = 0; }
    }
    Combat.register(this);
    Audio.play('recharge', { vol: 0.8 });
  }

  /* -------------------------------------------------------------- buffs */

  applyBuff(id, name, dur, stacks = 1, kind = 'buff') {
    const b = this.buffs.get(id);
    if (b) { b.t = dur; b.stacks = stacks; b.name = name; }
    else this.buffs.set(id, { id, name, t: dur, stacks, kind });
  }
  clearBuff(id) { this.buffs.delete(id); }
  hasBuff(id) { return this.buffs.has(id); }

  /* ------------------------------------------------------------- update */

  update(dt, input, camera) {
    this.deadT += this.alive ? 0 : dt;
    this.progress.update(dt);
    this.abilities.update(dt);
    this.abilities.updateSuperCooldown(dt);
    this.empowerT = Math.max(0, this.empowerT - dt);
    this.meleeLunge = Math.max(0, this.meleeLunge - dt);
    this.shake = Math.max(0, this.shake - dt * 1.8);
    this.hurtFlash = Math.max(0, (this.hurtFlash || 0) - dt * 1.6);
    for (const [id, b] of this.buffs) {
      b.t -= dt;
      if (b.t <= 0) this.buffs.delete(id);
    }

    const wasRecharge = this.vitals.recharging;
    if (this.vitals.update(dt) && !wasRecharge) Audio.play('recharge', { vol: 0.55 });

    if (!this.alive) {
      this._updateCamera(dt, camera, input);
      return;
    }

    this._look(dt, input);
    this._move(dt, input);
    this._weapons(dt, input);
    this._abilities(dt, input);
    this._updateCamera(dt, camera, input);
    this._updateViewModel(dt);
  }

  _look(dt, input) {
    if (!input) return;
    const sensMul = this.ads > 0.5 ? lerp(1, 0.55, this.ads) : 1;
    this.yaw -= input.dx * sensMul;
    this.pitch -= input.dy * sensMul;
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    if (this.yaw > Math.PI) this.yaw -= TAU;
    if (this.yaw < -Math.PI) this.yaw += TAU;

    // Recoil: spring back toward zero, and let look input cancel it.
    const recover = 9;
    this.recoilPitch = damp(this.recoilPitch, 0, recover, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, recover, dt);
  }

  _move(dt, input) {
    const st = this.stats;
    const mv = input ? input.moveAxis(_v2) : { x: 0, z: 0 };
    // World-space desired direction, in the camera's basis:
    //   forward = (-sin, 0, -cos)   right = (cos, 0, -sin)
    // and moveAxis gives z=-1 for forward, so world = mv.x*right - mv.z*forward.
    // Getting these signs wrong only shows up once you turn — at yaw 0 the wrong
    // basis agrees with the right one, and at 90° it is exactly backwards.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = mv.x * cos + mv.z * sin;
    const wz = mv.z * cos - mv.x * sin;
    this.moveDir.set(wx, 0, wz);
    const moving = Math.abs(wx) + Math.abs(wz) > 0.01;

    const wantSprint = input && input.down('sprint') && moving && mv.z < -0.1 && !this.adsWant && !this.carrying;
    this.sprinting = wantSprint && this.grounded ? true : (wantSprint && this.sprinting);

    // Slide: crouch while sprinting for a burst of speed and a low profile.
    if (input && input.down('crouch') && this.sprinting && this.grounded && this.sliding <= 0 && this._slideCd <= 0) {
      this.sliding = 0.75;
      this._slideCd = 1.2;
      const l = Math.hypot(this.velocity.x, this.velocity.z) || 1;
      this.velocity.x += (this.velocity.x / l) * 6;
      this.velocity.z += (this.velocity.z / l) * 6;
      Audio.play('step', { pos: this.pos, vol: 0.9 });
      FX.burst(this.pos, { count: 10, speed: 3, color: 0xbfae90, life: 0.4, size: 0.16, flat: true });
    }
    this._slideCd = Math.max(0, (this._slideCd || 0) - dt);
    this.sliding = Math.max(0, this.sliding - dt);
    this.crouched = !!(input && input.down('crouch')) && this.sliding <= 0;

    let speed = st.moveSpeed;
    // Holding a blade is the trade: you give up a primary weapon for legs.
    const held = this.currentWeapon;
    if (held && held.def.moveMul) speed *= held.def.moveMul;
    if (this.sprinting) speed *= st.sprintMul;
    if (this.crouched) speed *= 0.55;
    if (this.carrying) speed *= 0.78;
    if (this.abilities.superActive && this.abilities.superActive.id === 'ram') speed *= 1.35;
    if (this.hasBuff('weight')) speed *= 1 - clamp01(this.buffs.get('weight').stacks * 0.03);
    if (this.sliding > 0) speed *= 1.25;

    const accel = this.grounded ? 62 : 22;
    const targetX = wx * speed, targetZ = wz * speed;
    if (this.grounded) {
      if (this.sliding > 0) {
        // Slides keep their momentum: only light steering.
        this.velocity.x = damp(this.velocity.x, targetX, 2.2, dt);
        this.velocity.z = damp(this.velocity.z, targetZ, 2.2, dt);
        this.velocity.x *= Math.exp(-1.3 * dt);
        this.velocity.z *= Math.exp(-1.3 * dt);
      } else if (moving) {
        this.velocity.x = damp(this.velocity.x, targetX, accel / Math.max(2, speed), dt);
        this.velocity.z = damp(this.velocity.z, targetZ, accel / Math.max(2, speed), dt);
      } else {
        const f = Math.exp(-12 * dt);
        this.velocity.x *= f;
        this.velocity.z *= f;
      }
    } else if (moving) {
      // Air control: enough to adjust a jump, not enough to fly.
      this.velocity.x = damp(this.velocity.x, targetX, 3.2, dt);
      this.velocity.z = damp(this.velocity.z, targetZ, 3.2, dt);
    }

    // Jumping, per class.
    if (input && input.pressed('jump')) {
      if (this.grounded) {
        this.velocity.y = st.jump;
        this.jumpsLeft = this.classDef.jumps - 1;
        this.grounded = false;
        this.sliding = 0;
        Audio.play('jump', { vol: 0.6 });
      } else if (this.jumpsLeft > 0) {
        this.jumpsLeft--;
        if (this.classDef.jumpStyle === 'lift') {
          this.velocity.y = st.jump * 0.92;
          FX.burst(this.pos, { count: 12, speed: 5, color: 0xff9a3c, life: 0.35, size: 0.14, flat: true });
        } else {
          this.velocity.y = st.jump * 0.86;
          FX.burst(this.pos, { count: 10, speed: 4, color: this.classDef.color, life: 0.35, size: 0.12, flat: true });
        }
        Audio.play('jump', { vol: 0.5 });
      }
    }
    // Warlock glide: hold jump to fall slowly.
    this.gliding = this.classDef.jumpStyle === 'glide' && !this.grounded &&
      !!(input && input.down('jump')) && this.velocity.y < 0.5 && this.jumpsLeft <= 0;

    // Grav lifts.
    const lift = this._liftAt(this.pos);
    if (lift) {
      if (lift.locked) {
        if (this.velocity.y < 0) this.velocity.y = Math.max(this.velocity.y, -4);
      } else if (lift.up) {
        this.velocity.y = damp(this.velocity.y, 21, 6, dt);
      } else {
        this.velocity.y = damp(this.velocity.y, -7.5, 6, dt);
      }
      this.jumpsLeft = this.classDef.jumps - 1;
    }

    const g = this.gliding ? GRAVITY * 0.22 : GRAVITY;
    this.velocity.y -= g * dt;
    if (this.gliding) this.velocity.y = Math.max(this.velocity.y, -3.2);

    this._collide(dt);

    // Footsteps
    const speed2 = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.grounded && speed2 > 2 && this.sliding <= 0) {
      const now = performance.now() / 1000;
      Audio.footstep(now, this.pos, this.sprinting ? 0.32 : 0.46, 0.6);
      this.bob += dt * speed2 * (this.sprinting ? 1.25 : 1.0);
    }
  }

  _liftAt(p) {
    for (const t of World.triggers) {
      if (t.kind !== 'lift') continue;
      const dx = p.x - t.x, dz = p.z - t.z;
      if (dx * dx + dz * dz > t.r * t.r) continue;
      if (p.y < t.y - 3 || p.y > t.y + t.height + 2) continue;
      return t;
    }
    return null;
  }

  _collide(dt) {
    const wasGrounded = this.grounded;
    const px = this.pos.x, pz = this.pos.z;
    let nx = px + this.velocity.x * dt;
    let nz = pz + this.velocity.z * dt;

    // Terrain walls: try each axis so you slide instead of sticking.
    if (World.terrainBlocks(nx, this.pos.y, pz, STEP)) { nx = px; this.velocity.x *= 0.4; }
    if (World.terrainBlocks(nx, this.pos.y, nz, STEP)) { nz = pz; this.velocity.z *= 0.4; }
    this.pos.x = nx;
    this.pos.z = nz;

    // Box colliders: push out of anything we ended up inside.
    const boxes = World.nearbyColliders(this.pos.x, this.pos.z, this.radius + 2.4);
    for (const b of boxes) {
      if (b.tag === 'trigger') continue;
      const top = b.y + b.hy;
      const bottom = b.y - b.hy;
      if (this.pos.y + STEP >= top) continue;              // we are on top of it
      if (this.pos.y + this.height <= bottom) continue;    // we are under it
      b.toLocal(this.pos.x, this.pos.y, this.pos.z, _v);
      const dx = Math.abs(_v.x) - (b.hx + this.radius);
      const dz = Math.abs(_v.z) - (b.hz + this.radius);
      if (dx >= 0 || dz >= 0) continue;
      // Push along the shallower axis.
      if (dx > dz) {
        _v.x += -dx * Math.sign(_v.x || 1);
      } else {
        _v.z += -dz * Math.sign(_v.z || 1);
      }
      const wx = _v.x * b.c - _v.z * b.s + b.x;
      const wz = _v.x * b.s + _v.z * b.c + b.z;
      this.pos.x = wx;
      this.pos.z = wz;
    }

    this.pos.y += this.velocity.y * dt;
    const support = World.supportY(this.pos.x, this.pos.y + STEP, this.pos.z, STEP);
    if (isFinite(support) && this.pos.y <= support + 0.001) {
      if (!wasGrounded && this.velocity.y < -9) {
        this.landDip = clamp01(-this.velocity.y / 26) * 0.35;
        Audio.play('land', { vol: clamp01(-this.velocity.y / 22) });
        FX.burst(this.pos, { count: 8, speed: 3, color: 0xbfae90, life: 0.35, size: 0.14, flat: true });
        // Fall damage past terminal-ish speeds keeps cliffs honest.
        if (this.velocity.y < -33) this.applyDamage((-this.velocity.y - 33) * 8, { kind: 'fall' });
      }
      this.pos.y = support;
      this.velocity.y = 0;
      this.grounded = true;
      this.jumpsLeft = this.classDef.jumps - 1;
    } else {
      this.grounded = false;
    }

    // Ceilings.
    const head = this.pos.y + this.height;
    for (const b of boxes) {
      if (b.tag === 'trigger') continue;
      if (!b.containsXZ(this.pos.x, this.pos.z, this.radius * 0.6)) continue;
      const bottom = b.y - b.hy;
      const top = b.y + b.hy;
      if (head > bottom && this.pos.y < bottom && this.velocity.y > 0) {
        this.pos.y = bottom - this.height - 0.02;
        this.velocity.y = 0;
      } else if (this.pos.y < top && this.pos.y > b.y && this.velocity.y <= 0) {
        // standing inside the top skin of a box: lift out
        this.pos.y = top;
        this.velocity.y = 0;
        this.grounded = true;
      }
    }

    if (this.pos.y < -260) {
      this.applyDamage(9999, { kind: 'void' });
    }
  }

  /* ------------------------------------------------------------ weapons */

  _weapons(dt, input) {
    const w = this.currentWeapon;
    if (!w) return;
    if (input) {
      if (input.pressed('slot1')) this.switchSlot(0);
      if (input.pressed('slot2')) this.switchSlot(1);
      if (input.pressed('slot3')) this.switchSlot(2);
      if (input.pressed('swap')) this.cycleSlot(1);
      if (input.wheel) this.cycleSlot(input.wheel > 0 ? 1 : -1);
      if (input.pressed('reload')) w.startReload();
      this.adsWant = !!input.ads && !this.sprinting;
    }
    const adsTarget = this.adsWant && w.reloading <= 0 ? 1 : 0;
    this.ads = damp(this.ads, adsTarget, 1 / Math.max(0.05, w.adsTime) * 0.8, dt);

    this.eyePos.set(this.pos.x, this.pos.y + this.eyeH, this.pos.z);
    this._computeAim();

    w.update(dt, this._fireCtx(dt));

    // Super fire takes the trigger.
    if (this.abilities.superActive) {
      if (input && input.firePressed) this.abilities.superFire();
      if (this.abilities.superActive && this.abilities.superActive.id === 'ram' && input && input.fire) this.abilities.superFire();
      return;
    }

    const firing = !!(input && input.fire) && !this.sprinting;
    const rec = w.trigger(firing, this._fireCtx(dt));
    if (rec) this._applyRecoil(rec);
  }

  _computeAim() {
    const cp = Math.cos(this.pitch + this.recoilPitch);
    this.aimDir.set(
      -Math.sin(this.yaw + this.recoilYaw) * cp,
      Math.sin(this.pitch + this.recoilPitch),
      -Math.cos(this.yaw + this.recoilYaw) * cp
    ).normalize();
  }

  _fireCtx(dt) {
    const muzzle = _v.copy(this.eyePos).addScaledVector(this.aimDir, 1.0);
    muzzle.y -= 0.12;
    return {
      dt,
      origin: this.eyePos,
      muzzle: { x: muzzle.x, y: muzzle.y, z: muzzle.z },
      dir: this.aimDir,
      owner: this,
      mask: FACTION.ENEMY,
      ads: this.ads > 0.6,
      moving: Math.hypot(this.velocity.x, this.velocity.z) > 2.5 || !this.grounded,
      power: this.power + (this.empowerT > 0 ? 12 : 0)
    };
  }

  _applyRecoil(rec) {
    this.recoilPitch += rec.pitch * 0.016;
    this.recoilYaw += rec.yaw * 0.012;
    this.shake = Math.min(1.4, this.shake + rec.kick * 0.22);
    this.vmKick = (this.vmKick || 0) + rec.kick * 0.5;
  }

  /* ---------------------------------------------------------- abilities */

  _abilities(dt, input) {
    if (!input) return;
    if (input.pressed('grenade')) this.abilities.useGrenade();
    if (input.pressed('melee') || input.meleeMouse) this.abilities.useMelee();
    if (input.pressed('classAbility')) this.abilities.useClassAbility(input.down('crouch'));
    if (input.pressed('traversal')) this.abilities.useTraversal();
    if (input.pressed('super')) {
      if (this.abilities.superReady) this.abilities.useSuper();
      else Audio.play('deny', { vol: 0.4 });
    }
  }

  /* ------------------------------------------------------------- camera */

  _updateCamera(dt, camera, input) {
    if (!camera) return;
    const targetEye = this.crouched || this.sliding > 0 ? CROUCH_EYE : EYE;
    this.eyeH = damp(this.eyeH, targetEye, 12, dt);
    this.landDip = damp(this.landDip, 0, 8, dt);

    const bobAmt = this.grounded && !this.crouched ? Math.min(0.055, Math.hypot(this.velocity.x, this.velocity.z) * 0.006) : 0;
    const bx = Math.sin(this.bob * 2) * bobAmt * (1 - this.ads * 0.7);
    const by = Math.abs(Math.cos(this.bob * 2)) * bobAmt * 0.8 * (1 - this.ads * 0.7);

    const shakeX = (Math.random() - 0.5) * this.shake * 0.035;
    const shakeY = (Math.random() - 0.5) * this.shake * 0.035;

    camera.position.set(
      this.pos.x + bx + shakeX,
      this.pos.y + this.eyeH - this.landDip + by + shakeY,
      this.pos.z
    );
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw + this.recoilYaw;
    camera.rotation.x = this.pitch + this.recoilPitch;
    camera.rotation.z = lerp(camera.rotation.z, this._camRoll(), 1 - Math.exp(-8 * dt));

    const w = this.currentWeapon;
    const zoom = w ? w.zoom : 0.85;
    const baseFov = this.sprinting ? 84 : 78;
    const want = lerp(baseFov, baseFov * zoom, this.ads);
    this.fov = damp(this.fov, want, 10, dt);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  _camRoll() {
    // Lean into strafes and slides — small, but it sells the movement.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const localX = this.velocity.x * cos + this.velocity.z * sin;
    let roll = -clamp(localX * 0.012, -0.06, 0.06);
    if (this.sliding > 0) roll += 0.07;
    if (this.abilities.dodgeT > 0) roll += 0.1;
    return roll;
  }

  _updateViewModel(dt) {
    if (!this.vm) return;
    const w = this.currentWeapon;
    this.vmKick = Math.max(0, (this.vmKick || 0) - dt * 7);
    const t = performance.now() / 1000;
    const sway = this.grounded ? Math.min(0.02, Math.hypot(this.velocity.x, this.velocity.z) * 0.0035) : 0.004;
    const base = this.vmBase, ads = this.vmAds;
    const k = smoothstep(this.ads);
    const px = lerp(base.x, ads.x, k) + Math.sin(this.bob * 2) * sway;
    const py = lerp(base.y, ads.y, k) + Math.abs(Math.cos(this.bob * 2)) * sway * 0.8 - this.vmKick * 0.03;
    const pz = lerp(base.z, ads.z, k) + this.vmKick * 0.06;
    this.vm.position.set(px, py, pz);
    this.vm.rotation.set(-this.vmKick * 0.4, 0, 0);
    // Reload: rock the gun down and back.
    if (w && w.reloading > 0) {
      const p = 1 - w.reloading / w.reloadTime;
      const dip = Math.sin(p * Math.PI);
      this.vm.position.y -= dip * 0.16;
      this.vm.rotation.x -= dip * 0.7;
      this.vm.rotation.z = dip * 0.35;
    } else if (w && w.charge > 0) {
      this.vm.position.z += Math.sin(t * 40) * 0.004 * w.charge;
    }
    const scale = this.ads > 0.5 ? 1 : 1;
    this.vm.scale.setScalar(scale);
    this.vm.visible = !this.abilities.superActive;
  }

  /* --------------------------------------------------------- interaction */

  /** Nearest interactable POI; HUD shows the prompt, main handles the press. */
  findInteract() {
    let best = null, bestD = 4.2;
    for (const poi of World.pois) {
      const d = Math.hypot(this.pos.x - poi.x, this.pos.z - poi.z);
      if (d < Math.max(bestD, poi.r) && Math.abs(this.pos.y - poi.y) < 6) {
        if (d < bestD) { bestD = d; best = poi; }
      }
    }
    this.interactTarget = best;
    return best;
  }

  travelTo(poi) {
    const y = World.supportY(poi.x, poi.y + 40, poi.z, 60);
    this.pos.set(poi.x, (isFinite(y) ? y : heightAt(poi.x, poi.z)) + 1, poi.z);
    this.velocity.set(0, 0, 0);
    this.respawnPoint.copy(this.pos);
    FX.burst(this.pos, { count: 24, speed: 6, color: 0x8fd8ff, life: 0.6, size: 0.18 });
    Audio.play('spawn', { vol: 0.9 });
  }

  get region() { return regionAt(this.pos.x, this.pos.z); }
}

export default Player;
