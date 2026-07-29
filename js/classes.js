/* STARFALL — classes.js
   Three classes, each with a grenade, a melee, a class ability and a super.

   The loop this serves: gunfight -> ability -> ability kills make Orbs of Light
   -> orbs charge everyone's super -> super resets the fight. Abilities are on
   real cooldowns so they stay decisions, not rotations. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, TAU, swapRemove } from './util.js';
import Combat, { FACTION } from './combat.js';
import { Projectiles } from './weapons.js';
import World from './world.js';
import FX from './fx.js';
import Audio from './audio.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/* ------------------------------------------------------------- classes  */

export const CLASSES = {
  warden: {
    id: 'warden', name: 'Warden', title: 'Titan of the Rally', color: 0xff7a4c, css: '#ff7a4c',
    blurb: 'Walks into the room first. Shields hold longer, boots hit harder.',
    shieldMul: 1.18, recoveryMul: 1.0, speedMul: 0.97, sprintMul: 1.0, jumpMul: 0.98,
    grenadeMul: 1.0, meleeMul: 0.9, classMul: 1.0, superMul: 1.0,
    jumps: 1, jumpStyle: 'lift',
    grenade: { id: 'pulse_grenade', name: 'Pulse Grenade', desc: 'Sticks and detonates five times.' },
    melee: { id: 'seismic', name: 'Seismic Slam', desc: 'Shoulder-charge dash. Knocks fodder off their feet.' },
    classAbility: { id: 'bulwark', name: 'Bulwark', desc: 'Deployable wall. Real cover — bullets stop at it.' },
    traversal: { id: 'thrust', name: 'Thrusters', cd: 4.2, desc: 'Rocket-assisted leap. Shoves anything you land on.' },
    super: { id: 'ram', name: 'RAM', desc: 'Armour up and charge. Slam to end it.', duration: 9.5 },
    passive: 'Shields recharge 15% faster after a melee kill.'
  },
  oracle: {
    id: 'oracle', name: 'Oracle', title: 'Warlock of the Hollow Choir', color: 0xc39dff, css: '#c39dff',
    blurb: 'Rewrites the room. Slower on foot, better at staying alive in it.',
    shieldMul: 1.0, recoveryMul: 0.9, speedMul: 0.98, sprintMul: 0.98, jumpMul: 1.0,
    grenadeMul: 0.88, meleeMul: 1.0, classMul: 1.0, superMul: 0.92,
    jumps: 1, jumpStyle: 'glide',
    grenade: { id: 'vortex', name: 'Vortex Grenade', desc: 'A hole in the floor that keeps eating.' },
    melee: { id: 'palm', name: 'Void Palm', desc: 'Ranged blast that heals you on hit.' },
    classAbility: { id: 'wellspring', name: 'Wellspring', desc: 'Rift: heals, or empowers your damage. Hold to switch.' },
    traversal: { id: 'blink', name: 'Blink', cd: 3.6, desc: 'Short teleport where you are looking. Goes through gaps.' },
    super: { id: 'nova', name: 'NOVA BLOOM', desc: 'Throw the bomb. It opens.', duration: 7 },
    passive: 'Ability kills return 12% grenade energy.'
  },
  phantom: {
    id: 'phantom', name: 'Phantom', title: 'Hunter of the Last Signal', color: 0x6fe0ff, css: '#6fe0ff',
    blurb: 'Fastest thing on the shore. Two jumps, a dodge, and one perfect shot.',
    shieldMul: 0.92, recoveryMul: 1.0, speedMul: 1.05, sprintMul: 1.06, jumpMul: 1.06,
    grenadeMul: 1.0, meleeMul: 0.95, classMul: 0.88, superMul: 1.05,
    jumps: 2, jumpStyle: 'double',
    grenade: { id: 'tripmine', name: 'Tripmine', desc: 'Sticks where you throw it. Waits.' },
    melee: { id: 'kunai', name: 'Kunai', desc: 'Thrown knife. Precision kills ignite.' },
    classAbility: { id: 'fade', name: 'Fade', desc: 'Dodge: reloads your weapon and breaks their aim.' },
    traversal: { id: 'skate', name: 'Slipstream', cd: 3.0, desc: 'Long air dash. Chains with your double jump.' },
    super: { id: 'edge', name: 'UMBRAL EDGE', desc: 'Three shots. Make them precision.', duration: 9 },
    passive: 'Dodging near an enemy refunds melee energy.'
  }
};
export const CLASS_LIST = Object.keys(CLASSES);

/* -------------------------------------------------------------- effects */

/** Anything an ability leaves in the world: grenades, rifts, walls, orbs. */
class EffectSystem {
  constructor() {
    this.items = [];
    this.orbs = [];
    this.scene = null;
    this.ready = false;
  }

  init(scene) {
    this.scene = scene;
    this.orbGeo = new THREE.IcosahedronGeometry(0.42, 0);
    this.orbMat = new THREE.MeshBasicMaterial({ color: 0xdff3ff });
    this.ready = true;
  }

  add(e) { this.items.push(e); return e; }

  update(dt, player) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i];
      e.t += dt;
      let done = false;
      try { done = e.update(dt, e) === false || e.t >= e.life; } catch (err) { done = true; }
      if (done) {
        if (e.dispose) e.dispose();
        if (e.mesh) this.scene.remove(e.mesh);
        if (e.box) World.removeCollider(e.box);
        swapRemove(this.items, i);
      }
    }
    // Orbs drift up, then home in when you get close: they should feel wanted.
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.t += dt;
      o.life -= dt;
      o.mesh.rotation.y += dt * 2.2;
      o.mesh.rotation.x += dt * 1.1;
      o.mesh.position.y = o.y + Math.sin(o.t * 2.4) * 0.18;
      if (player && player.alive) {
        const d = Math.hypot(player.pos.x - o.mesh.position.x, player.pos.y + 1 - o.mesh.position.y, player.pos.z - o.mesh.position.z);
        if (d < 9) {
          const k = clamp01((9 - d) / 9) * 9 * dt;
          o.mesh.position.x = lerp(o.mesh.position.x, player.pos.x, k);
          o.mesh.position.y = lerp(o.mesh.position.y, player.pos.y + 1, k);
          o.mesh.position.z = lerp(o.mesh.position.z, player.pos.z, k);
          o.y = o.mesh.position.y;
        }
        if (d < 1.7) {
          player.abilities.addSuper(0.13);
          player.vitals.heal(12);
          Audio.play('orb', { vol: 0.7 });
          FX.burst(o.mesh.position, { count: 10, speed: 3, color: 0xdff3ff, life: 0.4, size: 0.12 });
          this.scene.remove(o.mesh);
          swapRemove(this.orbs, i);
          continue;
        }
      }
      if (o.life <= 0) { this.scene.remove(o.mesh); swapRemove(this.orbs, i); }
    }
  }

  spawnOrb(x, y, z, count = 1) {
    if (!this.ready) return;
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.orbGeo, this.orbMat);
      mesh.position.set(x + (Math.random() - 0.5) * 1.4, y + 0.6, z + (Math.random() - 0.5) * 1.4);
      this.scene.add(mesh);
      this.orbs.push({ mesh, y: mesh.position.y, t: Math.random() * 3, life: 24 });
      FX.burst(mesh.position, { count: 6, speed: 2.4, color: 0xdff3ff, life: 0.5, size: 0.1 });
    }
  }

  clear() {
    for (const e of this.items) {
      if (e.dispose) e.dispose();
      if (e.mesh) this.scene.remove(e.mesh);
      if (e.box) World.removeCollider(e.box);
    }
    this.items.length = 0;
    for (const o of this.orbs) this.scene.remove(o.mesh);
    this.orbs.length = 0;
  }
}

export const Effects = new EffectSystem();

/* -------------------------------------------------------- ability state */

export class Abilities {
  constructor(player, classDef) {
    this.p = player;
    this.def = classDef;
    this.grenadeCd = 0;
    this.meleeCd = 0;
    this.classCd = 0;
    this.traversalCd = 0;
    this.superEnergy = 0;       // 0..1
    this.superActive = null;
    this.riftMode = 'heal';     // Oracle toggle
    this.dodgeT = 0;
    this.invisT = 0;
    this.stats = null;          // set by the player from gear
  }

  get grenadeReady() { return this.grenadeCd <= 0; }
  get meleeReady() { return this.meleeCd <= 0; }
  get classReady() { return this.classCd <= 0; }
  get traversalReady() { return this.traversalCd <= 0; }
  get superReady() { return this.superEnergy >= 1 && !this.superActive; }

  addSuper(frac) {
    if (this.superActive) return;
    const before = this.superEnergy;
    this.superEnergy = clamp01(this.superEnergy + frac * (this.stats ? this.stats.superRate : 1));
    if (before < 1 && this.superEnergy >= 1) Audio.play('superready', { vol: 0.9 });
  }
  addGrenade(frac) { this.grenadeCd = Math.max(0, this.grenadeCd - (this.stats ? this.stats.grenadeCd : 10) * frac); }
  addMelee(frac) { this.meleeCd = Math.max(0, this.meleeCd - (this.stats ? this.stats.meleeCd : 9) * frac); }

  update(dt) {
    this.grenadeCd = Math.max(0, this.grenadeCd - dt);
    this.meleeCd = Math.max(0, this.meleeCd - dt);
    this.classCd = Math.max(0, this.classCd - dt);
    this.traversalCd = Math.max(0, this.traversalCd - dt);
    this.dodgeT = Math.max(0, this.dodgeT - dt);
    this.invisT = Math.max(0, this.invisT - dt);
    if (!this.superActive) this.addSuper(0.0055 * dt);   // slow trickle so you always get one eventually
    if (this.superActive) {
      this.superActive.t -= dt;
      if (this.superActive.t <= 0) this.endSuper();
    }
  }

  endSuper() {
    if (!this.superActive) return;
    const s = this.superActive;
    this.superActive = null;
    this.superEnergy = 0;
    if (s.id === 'ram') {
      this.p.vitals.overshield = 0;
      this.p.vitals.dr = 1;
    }
  }

  /* ------------------------------------------------------------ casting */

  useGrenade() {
    if (!this.grenadeReady || this.p.dead) return false;
    this.grenadeCd = this.stats ? this.stats.grenadeCd : 10;
    const p = this.p;
    const dir = p.aimDir;
    const from = p.eyePos;
    Audio.play('grenade', { pos: from, vol: 0.9 });
    const id = this.def.grenade.id;

    if (id === 'pulse_grenade') {
      Projectiles.spawn({
        x: from.x, y: from.y, z: from.z,
        vx: dir.x * 26 + p.velocity.x, vy: dir.y * 26 + 3 + p.velocity.y, vz: dir.z * 26 + p.velocity.z,
        gravity: 20, radius: 0.28, damage: 0, mask: FACTION.ENEMY, owner: p,
        color: 0xff7a4c, trail: 0xffb45c, bounce: 0.28, fuse: 0.9, power: p.power,
        onHit: (x, y, z) => pulseGrenade(x, y, z, p)
      });
    } else if (id === 'vortex') {
      Projectiles.spawn({
        x: from.x, y: from.y, z: from.z,
        vx: dir.x * 30 + p.velocity.x, vy: dir.y * 30 + 2 + p.velocity.y, vz: dir.z * 30 + p.velocity.z,
        gravity: 18, radius: 0.3, damage: 0, mask: FACTION.ENEMY, owner: p,
        color: 0xc39dff, trail: 0x9a6bff, fuse: 0, power: p.power,
        onHit: (x, y, z) => vortexGrenade(x, y, z, p)
      });
    } else {
      Projectiles.spawn({
        x: from.x, y: from.y, z: from.z,
        vx: dir.x * 34 + p.velocity.x, vy: dir.y * 34 + p.velocity.y, vz: dir.z * 34 + p.velocity.z,
        gravity: 8, radius: 0.26, damage: 0, mask: FACTION.ENEMY, owner: p,
        color: 0x6fe0ff, trail: 0x6fe0ff, power: p.power,
        onHit: (x, y, z) => tripmine(x, y, z, p)
      });
    }
    return true;
  }

  useMelee() {
    if (!this.meleeReady || this.p.dead) return false;
    const p = this.p;
    const id = this.def.melee.id;
    this.meleeCd = this.stats ? this.stats.meleeCd : 9;
    Audio.play('melee', { pos: p.pos, vol: 0.9 });

    if (id === 'seismic') {
      // Dash forward, then hit everything in a short cone.
      const dir = _v.copy(p.aimDir); dir.y = 0; dir.normalize();
      p.velocity.x += dir.x * 21;
      p.velocity.z += dir.z * 21;
      p.velocity.y = Math.max(p.velocity.y, 2.2);
      p.meleeLunge = 0.34;
      const hits = Combat.queryTargets(p.pos.x + dir.x * 3, p.pos.y + 1, p.pos.z + dir.z * 3, 4.6, FACTION.ENEMY);
      for (const t of hits) {
        const dmg = 145;
        const before = t.alive;
        Combat.damage(t, dmg, { source: p, kind: 'ability', crit: false, power: p.power });
        if (t.knockback) t.knockback(dir.x * 14, 7, dir.z * 14);
        if (before && !t.alive) this._abilityKill(t);
      }
      FX.ring(_v2.set(p.pos.x + dir.x * 3, p.pos.y + 0.2, p.pos.z + dir.z * 3), { color: 0xff7a4c, r1: 5.5, life: 0.4 });
      FX.burst(_v2, { count: 18, speed: 9, color: 0xff9a3c, life: 0.4, size: 0.16, dir, spread: 0.7 });
      // Passive: a melee kill kickstarts the shield instead of waiting it out.
      if (hits.some(t => !t.alive)) this.p.vitals.sinceHit = this.p.vitals.rechargeDelay;
    } else if (id === 'palm') {
      const from = p.eyePos, dir = p.aimDir;
      const hit = Combat.raycastTargets(from.x, from.y, from.z, dir.x, dir.y, dir.z, 14, FACTION.ENEMY, p);
      FX.beam(from, _v.copy(from).addScaledVector(dir, hit ? hit.dist : 14), { color: 0xc39dff, width: 0.5, life: 0.22, alpha: 0.7 });
      if (hit) {
        const before = hit.target.alive;
        Combat.damage(hit.target, 130, { source: p, kind: 'ability', crit: hit.crit, power: p.power });
        p.vitals.heal(45);
        FX.burst(hit.point, { count: 16, speed: 7, color: 0xc39dff, life: 0.45, size: 0.16 });
        if (before && !hit.target.alive) this._abilityKill(hit.target);
      }
    } else {
      // Kunai: a real projectile, so it can miss.
      const from = p.eyePos, dir = p.aimDir;
      Projectiles.spawn({
        x: from.x, y: from.y, z: from.z,
        vx: dir.x * 62, vy: dir.y * 62, vz: dir.z * 62,
        gravity: 4, radius: 0.2, damage: 120, mask: FACTION.ENEMY, owner: p,
        color: 0x6fe0ff, trail: 0x6fe0ff, power: p.power, life: 3,
        onHit: (x, y, z, target) => {
          if (target && !target.alive) {
            burnGround(x, y, z, p, 0x6fe0ff);
            this._abilityKill(target);
          }
        }
      });
    }
    return true;
  }

  useClassAbility(held = false) {
    if (!this.classReady || this.p.dead) return false;
    const p = this.p;
    const id = this.def.classAbility.id;
    this.classCd = this.stats ? this.stats.classCd : 11;
    Audio.play('ability', { pos: p.pos, vol: 0.9 });

    if (id === 'bulwark') {
      const dir = _v.copy(p.aimDir); dir.y = 0; dir.normalize();
      const x = p.pos.x + dir.x * 2.4, z = p.pos.z + dir.z * 2.4;
      const y = World.supportY(x, p.pos.y + 1, z);
      barricade(x, isFinite(y) ? y : p.pos.y, z, Math.atan2(dir.x, dir.z), p);
    } else if (id === 'wellspring') {
      if (held) { this.riftMode = this.riftMode === 'heal' ? 'empower' : 'heal'; }
      rift(p.pos.x, p.pos.y, p.pos.z, this.riftMode, p);
    } else {
      // Fade: dodge in the current input direction, or backward if standing still.
      const mv = p.moveDir;
      const dir = (Math.abs(mv.x) + Math.abs(mv.z) > 0.01) ? _v.set(mv.x, 0, mv.z).normalize() : _v.copy(p.aimDir).setY(0).normalize().negate();
      p.velocity.x += dir.x * 22;
      p.velocity.z += dir.z * 22;
      this.dodgeT = 0.42;
      this.invisT = 1.6;
      const w = p.currentWeapon;
      if (w) { w.ammo = Math.min(w.mag, w.ammo + Math.max(1, Math.ceil(w.mag * 0.6))); }
      FX.burst(p.pos, { count: 16, speed: 6, color: 0x6fe0ff, life: 0.4, size: 0.14, flat: true });
      const near = Combat.nearestTarget(p.pos.x, p.pos.y, p.pos.z, 9, FACTION.ENEMY);
      if (near) this.addMelee(0.5);
    }
    return true;
  }

  /* Traversal. Deliberately on a short cooldown and separate from the class
     ability: the world is 3600 units across with a 780-unit hole in the middle,
     and crossing it should not cost you your only defensive cast. Each of these
     works in the air, because the interesting places to reach are off the edge
     of something. */
  useTraversal() {
    if (!this.traversalReady || this.p.dead) return false;
    const p = this.p;
    const t = this.def.traversal;
    this.traversalCd = t.cd;
    Audio.play('ability', { pos: p.pos, vol: 0.75 });

    // Direction: where you are moving, else where you are looking.
    const mv = p.moveDir;
    const moving = Math.abs(mv.x) + Math.abs(mv.z) > 0.01;
    const dir = moving
      ? _v.set(mv.x, 0, mv.z).normalize()
      : _v.copy(p.aimDir).setY(0).normalize();

    if (t.id === 'thrust') {
      // Warden: goes UP more than out — the heavy's answer to a cliff.
      p.velocity.x += dir.x * 13;
      p.velocity.z += dir.z * 13;
      p.velocity.y = Math.max(p.velocity.y, 0) + 15.5;
      p.jumpsLeft = Math.max(p.jumpsLeft, 0);
      FX.burst(p.pos, { count: 20, speed: 7, color: 0xff7a4c, life: 0.5, size: 0.18, flat: true });
      FX.ring(p.pos, { color: 0xff7a4c, r1: 4.5, life: 0.4, alpha: 0.6 });
      // Shove anything standing right next to you as you go.
      Combat.splash(p.pos.x, p.pos.y + 1, p.pos.z, 4.2, 26,
        { source: p, kind: 'ability', mask: FACTION.ENEMY, minFactor: 0.4 });
    } else if (t.id === 'blink') {
      // Oracle: a real teleport, so it crosses gaps nothing else can. Step
      // along the aim ray and stop before anything solid — blinking into rock
      // would be the one thing worse than not having it.
      const aim = _v2.copy(p.aimDir).normalize();
      const MAX = 22;
      let dist = 0;
      // Probe the body, not a point, and only at chest and head height: testing
      // near the floor snags on every kerb and doorstep, and a blink that a
      // 40cm lip can cancel is not a traversal tool.
      for (let step = 1.5; step <= MAX; step += 1.5) {
        const nx = p.pos.x + aim.x * step;
        const ny = p.pos.y + aim.y * step;
        const nz = p.pos.z + aim.z * step;
        if (World.blocked(nx, ny + 1.0, nz, p.radius) ||
            World.blocked(nx, ny + p.height - 0.2, nz, p.radius)) break;
        dist = step;
      }
      if (dist > 1) {
        FX.burst(p.pos, { count: 18, speed: 5, color: 0xc39dff, life: 0.4, size: 0.16 });
        p.pos.set(p.pos.x + aim.x * dist, p.pos.y + aim.y * dist, p.pos.z + aim.z * dist);
        // Keep momentum but kill the fall, so blinking upward actually gains height.
        p.velocity.y = Math.min(p.velocity.y, 2.5);
        FX.burst(p.pos, { count: 22, speed: 6, color: 0xc39dff, life: 0.5, size: 0.18 });
      } else {
        this.traversalCd = t.cd * 0.35;   // refund most of it if it went nowhere
      }
    } else {
      // Phantom: long, flat, and it refreshes the second jump.
      p.velocity.x += dir.x * 30;
      p.velocity.z += dir.z * 30;
      if (p.velocity.y < 0) p.velocity.y *= 0.25;
      p.velocity.y += 5.5;
      p.jumpsLeft = Math.max(p.jumpsLeft, 1);
      p.dashTrail = 0.35;
      FX.burst(p.pos, { count: 16, speed: 8, color: 0x6fe0ff, life: 0.4, size: 0.14, flat: true });
    }
    return true;
  }

  useSuper() {
    if (!this.superReady || this.p.dead) return false;
    const p = this.p;
    const id = this.def.super.id;
    Audio.play('super', { pos: p.pos, vol: 1 });
    FX.ring(p.pos, { color: this.def.color, r1: 14, life: 0.8, alpha: 0.9 });
    FX.burst(p.pos, { count: 40, speed: 14, color: this.def.color, life: 0.8, size: 0.24 });
    this.superActive = { id, t: this.def.super.duration, dur: this.def.super.duration, shots: id === 'edge' ? 3 : (id === 'nova' ? 1 : 0) };

    if (id === 'ram') {
      p.vitals.addOvershield(180, 180);
      p.vitals.dr = 0.55;
    }
    return true;
  }

  /** LMB while a super is up. Returns true if it consumed the click. */
  superFire() {
    const s = this.superActive;
    if (!s) return false;
    const p = this.p;
    if (s.id === 'ram') {
      // Ground slam.
      if (s.cool > 0) return true;
      s.cool = 0.9;
      const x = p.pos.x, y = p.pos.y, z = p.pos.z;
      Audio.play('explode', { pos: p.pos, vol: 1 });
      FX.ring(p.pos, { color: 0xff7a4c, r1: 11, life: 0.5, alpha: 0.9 });
      FX.explosion(_v.set(x, y + 0.4, z), 8, 0xff7a4c);
      const killed = [];
      const hits = Combat.queryTargets(x, y + 1, z, 9.5, FACTION.ENEMY);
      for (const t of hits) {
        const before = t.alive;
        Combat.damage(t, 320, { source: p, kind: 'super', power: p.power });
        if (t.knockback) {
          const dx = t.pos.x - x, dz = t.pos.z - z;
          const l = Math.hypot(dx, dz) || 1;
          t.knockback((dx / l) * 16, 9, (dz / l) * 16);
        }
        if (before && !t.alive) killed.push(t);
      }
      for (const t of killed) this._abilityKill(t, 2);
      p.velocity.y = Math.max(p.velocity.y, 4);
      return true;
    }
    if (s.id === 'nova') {
      if (s.shots <= 0) return true;
      s.shots--;
      const from = p.eyePos, dir = p.aimDir;
      Projectiles.spawn({
        x: from.x, y: from.y, z: from.z,
        vx: dir.x * 26, vy: dir.y * 26, vz: dir.z * 26,
        gravity: 1.5, radius: 0.9, visualScale: 2.2, damage: 260,
        splash: { radius: 9, damage: 340 }, mask: FACTION.ENEMY, owner: p,
        color: 0xc39dff, trail: 0x9a6bff, power: p.power, life: 6,
        onHit: (x, y, z) => novaSeekers(x, y, z, p)
      });
      this.superActive.t = Math.min(this.superActive.t, 1.2);
      return true;
    }
    if (s.id === 'edge') {
      if (s.cool > 0 || s.shots <= 0) return true;
      s.cool = 0.55;
      s.shots--;
      const from = p.eyePos, dir = p.aimDir;
      Audio.play('cannon', { pos: from, vol: 1.1 });
      const hit = Combat.raycastTargets(from.x, from.y, from.z, dir.x, dir.y, dir.z, 220, FACTION.ENEMY, p);
      const end = hit ? hit.point : { x: from.x + dir.x * 220, y: from.y + dir.y * 220, z: from.z + dir.z * 220 };
      FX.beam(from, _v.set(end.x, end.y, end.z), { color: 0x6fe0ff, width: 0.28, life: 0.3, alpha: 0.95 });
      FX.tracer(from, end, 0xbfe8ff, 0.2, 1);
      if (hit) {
        const before = hit.target.alive;
        Combat.damage(hit.target, hit.crit ? 900 : 620, { source: p, kind: 'super', crit: hit.crit, power: p.power });
        FX.explosion(_v.set(end.x, end.y, end.z), 4, 0x6fe0ff, { smoke: false });
        // Chain: the shot jumps to one nearby target.
        const chain = Combat.nearestTarget(end.x, end.y, end.z, 12, FACTION.ENEMY);
        if (chain && chain !== hit.target) {
          FX.beam(_v.set(end.x, end.y, end.z), _v2.set(chain.pos.x, chain.pos.y + chain.height * 0.6, chain.pos.z), { color: 0x6fe0ff, width: 0.16, life: 0.25 });
          Combat.damage(chain, 300, { source: p, kind: 'super', power: p.power });
          if (!chain.alive) this._abilityKill(chain, 2);
        }
        if (before && !hit.target.alive) this._abilityKill(hit.target, 2);
        if (hit.crit) this.superActive.t += 1.2;   // reward precision with uptime
      }
      if (s.shots <= 0) this.superActive.t = Math.min(this.superActive.t, 0.8);
      return true;
    }
    return false;
  }

  _abilityKill(target, orbs = 1) {
    Effects.spawnOrb(target.pos.x, target.pos.y, target.pos.z, orbs);
    if (this.def.id === 'oracle') this.addGrenade(0.12);
  }

  updateSuperCooldown(dt) {
    if (this.superActive && this.superActive.cool > 0) this.superActive.cool -= dt;
  }
}

/* --------------------------------------------------------- ability defs */

function pulseGrenade(x, y, z, owner) {
  let pulses = 5;
  Effects.add({
    t: 0, life: 3.6, next: 0,
    update(dt, e) {
      e.next -= dt;
      if (e.next <= 0 && pulses > 0) {
        e.next = 0.7;
        pulses--;
        FX.explosion(_v.set(x, y + 0.3, z), 4.4, 0xff7a4c, { smoke: false });
        Audio.play('explode', { pos: _v, vol: 0.5 });
        const hits = Combat.queryTargets(x, y, z, 5, FACTION.ENEMY);
        for (const t of hits) {
          const before = t.alive;
          Combat.damage(t, 46, { source: owner, kind: 'ability', power: owner.power });
          if (before && !t.alive && owner.abilities) owner.abilities._abilityKill(t);
        }
      }
    }
  });
}

function vortexGrenade(x, y, z, owner) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(4.5, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x9a6bff, transparent: true, opacity: 0.22, depthWrite: false })
  );
  mesh.position.set(x, y + 1, z);
  Effects.scene.add(mesh);
  Effects.add({
    t: 0, life: 5.5, mesh, tick: 0,
    update(dt, e) {
      e.tick -= dt;
      mesh.rotation.y += dt * 1.6;
      mesh.scale.setScalar(1 + Math.sin(e.t * 6) * 0.05);
      mesh.material.opacity = 0.22 * clamp01((e.life - e.t) / 1.2);
      if (e.tick <= 0) {
        e.tick = 0.45;
        const hits = Combat.queryTargets(x, y + 1, z, 5.2, FACTION.ENEMY);
        for (const t of hits) {
          const before = t.alive;
          Combat.damage(t, 34, { source: owner, kind: 'ability', silent: true, power: owner.power });
          // Pull: the vortex should reposition the fight, not just tick damage.
          if (t.knockback) {
            const dx = x - t.pos.x, dz = z - t.pos.z;
            const l = Math.hypot(dx, dz) || 1;
            t.knockback((dx / l) * 2.6, 0.6, (dz / l) * 2.6);
          }
          if (before && !t.alive && owner.abilities) owner.abilities._abilityKill(t);
        }
        FX.burst(_v.set(x, y + 0.6, z), { count: 8, speed: -3.5, color: 0xc39dff, life: 0.5, size: 0.14, gravity: 0 });
      }
    }
  });
}

function tripmine(x, y, z, owner) {
  const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), new THREE.MeshBasicMaterial({ color: 0x6fe0ff }));
  mesh.position.set(x, y + 0.2, z);
  Effects.scene.add(mesh);
  let armed = 0.55;
  Effects.add({
    t: 0, life: 22, mesh,
    update(dt, e) {
      armed -= dt;
      mesh.rotation.y += dt * 3;
      if (armed > 0) return;
      const near = Combat.nearestTarget(x, y + 0.6, z, 4.4, FACTION.ENEMY);
      const expire = e.t >= e.life - 0.05;
      if (near || expire) {
        FX.explosion(_v.set(x, y + 0.5, z), 6.5, 0x6fe0ff);
        Audio.play('explode', { pos: _v, vol: 0.95 });
        const hits = Combat.queryTargets(x, y + 0.6, z, 6.5, FACTION.ENEMY);
        for (const t of hits) {
          const before = t.alive;
          Combat.damage(t, 300, { source: owner, kind: 'ability', power: owner.power });
          if (before && !t.alive && owner.abilities) owner.abilities._abilityKill(t);
        }
        return false;
      }
    }
  });
}

function burnGround(x, y, z, owner, color) {
  Effects.add({
    t: 0, life: 3.2, tick: 0,
    update(dt, e) {
      e.tick -= dt;
      if (e.tick <= 0) {
        e.tick = 0.4;
        FX.burst(_v.set(x, y + 0.2, z), { count: 5, speed: 2.2, color, life: 0.5, size: 0.16, gravity: 2 });
        const hits = Combat.queryTargets(x, y, z, 3.4, FACTION.ENEMY);
        for (const t of hits) Combat.damage(t, 22, { source: owner, kind: 'ability', silent: true, power: owner.power });
      }
    }
  });
}

function barricade(x, y, z, yaw, owner) {
  const w = 5.2, h = 3.0, d = 0.7;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: 0xff7a4c, emissive: 0x50210d, transparent: true, opacity: 0.92 })
  );
  mesh.position.set(x, y + h / 2, z);
  mesh.rotation.y = yaw;
  Effects.scene.add(mesh);
  const box = World.addCollider(x, y + h / 2, z, w / 2, h / 2, d / 2, yaw, 'barricade');
  Effects.add({
    t: 0, life: 16, mesh, box,
    update(dt, e) {
      const k = clamp01((e.life - e.t) / 1.5);
      mesh.material.opacity = 0.92 * k;
      // Standing behind your own wall tops your shields up faster.
      if (owner && owner.alive) {
        const dx = owner.pos.x - x, dz = owner.pos.z - z;
        if (dx * dx + dz * dz < 16) owner.vitals.sinceHit = Math.max(owner.vitals.sinceHit, owner.vitals.rechargeDelay * 0.9);
      }
    }
  });
}

function rift(x, y, z, mode, owner) {
  const color = mode === 'heal' ? 0x9dff7a : 0xffd166;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(4.2, 4.2, 0.12, 26),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false })
  );
  mesh.position.set(x, y + 0.08, z);
  Effects.scene.add(mesh);
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(4.2, 4.2, 5, 20, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false })
  );
  pillar.position.set(x, y + 2.5, z);
  Effects.scene.add(pillar);
  Effects.add({
    t: 0, life: 14, mesh, tick: 0,
    update(dt, e) {
      e.tick -= dt;
      mesh.rotation.y += dt * 0.7;
      const fade = clamp01((e.life - e.t) / 1.5);
      mesh.material.opacity = 0.3 * fade;
      pillar.material.opacity = 0.09 * fade;
      if (e.tick <= 0) {
        e.tick = 0.5;
        if (owner && owner.alive) {
          const dx = owner.pos.x - x, dz = owner.pos.z - z;
          if (dx * dx + dz * dz < 18) {
            if (mode === 'heal') { owner.vitals.heal(18); owner.vitals.sinceHit = 99; }
            else owner.empowerT = 1.1;
          }
        }
      }
    },
    dispose() { Effects.scene.remove(pillar); }
  });
}

function novaSeekers(x, y, z, owner) {
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const target = Combat.nearestTarget(x + Math.cos(a) * 6, y, z + Math.sin(a) * 6, 22, FACTION.ENEMY);
    Projectiles.spawn({
      x, y: y + 1, z,
      vx: Math.cos(a) * 12, vy: 3, vz: Math.sin(a) * 12,
      gravity: 2, radius: 0.35, damage: 120,
      splash: { radius: 4, damage: 110 }, mask: FACTION.ENEMY, owner,
      color: 0xc39dff, trail: 0x9a6bff, power: owner.power, life: 4,
      homing: target ? 3.5 : 0, target
    });
  }
}

export default { CLASSES, Abilities, Effects };
