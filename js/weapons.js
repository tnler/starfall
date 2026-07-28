/* STARFALL — weapons.js
   The sandbox. Ten archetypes that each want a different range and a different
   trigger discipline, plus the projectile system every explosive shares.

   Slots follow the Destiny shape: kinetic (always loaded), energy (special,
   scarce), power (heavy, scarcer). Ammo for the last two drops off enemies. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, makeRNG } from './util.js';
import Combat, { FACTION, falloff, powerScale } from './combat.js';
import World from './world.js';
import FX from './fx.js';
import Audio from './audio.js';

export const SLOT = { KINETIC: 'kinetic', ENERGY: 'energy', POWER: 'power' };

/* ---------------------------------------------------------- archetypes  */

export const ARCHETYPES = {
  auto: {
    id: 'auto', label: 'Auto Rifle', slot: SLOT.KINETIC, mode: 'auto',
    rpm: 600, damage: 13, crit: 1.5, mag: 36, reserves: 210, reload: 2.1,
    falloff: [30, 56], hipSpread: 1.35, adsSpread: 0.22, recoil: [0.55, 0.34],
    zoom: 0.86, adsTime: 0.22, swap: 0.55, sound: 'auto', ammo: 'primary',
    blurb: 'Forgiving. Holds a lane.'
  },
  smg: {
    id: 'smg', label: 'Submachine Gun', slot: SLOT.KINETIC, mode: 'auto',
    rpm: 900, damage: 9.4, crit: 1.4, mag: 44, reserves: 260, reload: 1.85,
    falloff: [16, 32], hipSpread: 1.7, adsSpread: 0.5, recoil: [0.42, 0.5],
    zoom: 0.92, adsTime: 0.16, swap: 0.42, sound: 'smg', ammo: 'primary',
    blurb: 'Close, fast, greedy with ammo.'
  },
  pulse: {
    id: 'pulse', label: 'Pulse Rifle', slot: SLOT.KINETIC, mode: 'burst',
    burst: 3, burstRpm: 900, rpm: 380, damage: 18, crit: 1.6, mag: 33, reserves: 190, reload: 2.3,
    falloff: [36, 62], hipSpread: 1.1, adsSpread: 0.14, recoil: [0.8, 0.3],
    zoom: 0.8, adsTime: 0.24, swap: 0.6, sound: 'pulse', ammo: 'primary',
    blurb: 'Three-round bursts. Rewards a steady hand.'
  },
  scout: {
    id: 'scout', label: 'Scout Rifle', slot: SLOT.KINETIC, mode: 'semi',
    rpm: 180, damage: 31, crit: 1.9, mag: 17, reserves: 140, reload: 2.0,
    falloff: [52, 88], hipSpread: 1.0, adsSpread: 0.06, recoil: [0.95, 0.25],
    zoom: 0.66, adsTime: 0.26, swap: 0.62, sound: 'scout', ammo: 'primary',
    blurb: 'Long range, no drop-off. Kill from the ridge.'
  },
  handcannon: {
    id: 'handcannon', label: 'Hand Cannon', slot: SLOT.KINETIC, mode: 'semi',
    rpm: 140, damage: 46, crit: 2.1, mag: 9, reserves: 96, reload: 1.75,
    falloff: [32, 54], hipSpread: 1.5, adsSpread: 0.1, recoil: [1.7, 0.7],
    zoom: 0.78, adsTime: 0.22, swap: 0.5, sound: 'cannon', ammo: 'primary',
    blurb: 'Nine shots that matter.'
  },
  shotgun: {
    id: 'shotgun', label: 'Shotgun', slot: SLOT.ENERGY, mode: 'semi',
    rpm: 75, damage: 15, crit: 1.35, pellets: 10, mag: 6, reserves: 26, reload: 2.6,
    falloff: [7, 15], falloffFloor: 0.18, hipSpread: 5.2, adsSpread: 3.4, recoil: [2.4, 0.8],
    zoom: 0.95, adsTime: 0.2, swap: 0.55, sound: 'shotgun', ammo: 'special',
    blurb: 'Answer to anything that got close.'
  },
  sniper: {
    id: 'sniper', label: 'Sniper Rifle', slot: SLOT.ENERGY, mode: 'semi',
    rpm: 60, damage: 95, crit: 3.0, mag: 4, reserves: 18, reload: 3.0,
    falloff: [200, 260], hipSpread: 6, adsSpread: 0.0, recoil: [3.2, 0.6],
    zoom: 0.34, adsTime: 0.34, swap: 0.8, sound: 'sniper', ammo: 'special',
    scope: true,
    blurb: 'One shot per breath.'
  },
  fusion: {
    id: 'fusion', label: 'Fusion Rifle', slot: SLOT.ENERGY, mode: 'charge',
    charge: 0.62, bolts: 7, damage: 22, crit: 1.3, mag: 5, reserves: 22, reload: 2.6,
    falloff: [16, 30], falloffFloor: 0.3, hipSpread: 3.4, adsSpread: 1.5, recoil: [1.6, 0.5],
    zoom: 0.9, adsTime: 0.24, swap: 0.62, sound: 'fusion', ammo: 'special',
    blurb: 'Hold. Hold. Now.'
  },
  rocket: {
    id: 'rocket', label: 'Rocket Launcher', slot: SLOT.POWER, mode: 'semi',
    rpm: 45, damage: 140, crit: 1, mag: 1, reserves: 8, reload: 3.1,
    projectile: { speed: 48, gravity: 0, radius: 0.45, color: 0xffa14c, trail: 0xff7a2c },
    splash: { radius: 7.5, damage: 120 },
    hipSpread: 0.5, adsSpread: 0.2, recoil: [3.5, 0.5], zoom: 0.9, adsTime: 0.3, swap: 0.9,
    sound: 'rocket', ammo: 'heavy',
    blurb: 'Deletes a room. Bring more.'
  },
  gl: {
    id: 'gl', label: 'Grenade Launcher', slot: SLOT.POWER, mode: 'semi',
    rpm: 90, damage: 70, crit: 1, mag: 6, reserves: 24, reload: 2.9,
    projectile: { speed: 40, gravity: 16, radius: 0.4, bounce: 0.42, fuse: 1.6, color: 0x9dff7a, trail: 0x6fe0ff },
    splash: { radius: 6, damage: 95 },
    hipSpread: 0.8, adsSpread: 0.3, recoil: [2.2, 0.6], zoom: 0.9, adsTime: 0.26, swap: 0.75,
    sound: 'rocket', ammo: 'heavy',
    blurb: 'Bank it off the ceiling.'
  },
  bow: {
    id: 'bow', label: 'Combat Bow', slot: SLOT.KINETIC, mode: 'charge',
    charge: 0.55, rpm: 80, damage: 80, crit: 2.2, mag: 1, reserves: 60, reload: 0.85,
    falloff: [60, 90], hipSpread: 2.4, adsSpread: 0.0, recoil: [1.2, 0.3],
    zoom: 0.72, adsTime: 0.26, swap: 0.5, sound: 'bow', ammo: 'primary',
    pierce: 2,
    blurb: 'Silent, and it goes through two of them.'
  }
};

export const ARCH_LIST = Object.keys(ARCHETYPES);

/* ------------------------------------------------------------ projectiles */

const MAX_PROJ = 64;
const _v = new THREE.Vector3();

class ProjectileSystem {
  constructor() {
    this.items = [];
    this.ready = false;
  }
  init(scene) {
    this.scene = scene;
    const geo = new THREE.SphereGeometry(1, 8, 6);
    for (let i = 0; i < MAX_PROJ; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      mesh.visible = false;
      scene.add(mesh);
      this.items.push({
        mesh, alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        gravity: 0, radius: 0.3, damage: 0, splash: null, mask: FACTION.ENEMY,
        owner: null, life: 0, fuse: 0, bounce: 0, trail: 0, color: 0xffffff, power: 0, kind: 'proj'
      });
    }
    this.head = 0;
    this.ready = true;
  }

  spawn(opts) {
    if (!this.ready) return null;
    let p = null;
    for (let i = 0; i < MAX_PROJ; i++) {
      const cand = this.items[(this.head + i) % MAX_PROJ];
      if (!cand.alive) { p = cand; this.head = (this.head + i + 1) % MAX_PROJ; break; }
    }
    if (!p) { p = this.items[this.head]; this.head = (this.head + 1) % MAX_PROJ; }
    Object.assign(p, {
      alive: true, life: opts.life || 6, fuse: opts.fuse || 0,
      x: opts.x, y: opts.y, z: opts.z,
      vx: opts.vx, vy: opts.vy, vz: opts.vz,
      gravity: opts.gravity || 0, radius: opts.radius || 0.3,
      damage: opts.damage || 0, splash: opts.splash || null,
      mask: opts.mask == null ? FACTION.ENEMY : opts.mask,
      owner: opts.owner || null, bounce: opts.bounce || 0,
      color: opts.color || 0xffd166, trail: opts.trail || opts.color || 0xffd166,
      power: opts.power || 0, kind: opts.kind || 'proj', onHit: opts.onHit || null,
      homing: opts.homing || 0, target: opts.target || null
    });
    p.mesh.material.color.setHex(p.color);
    p.mesh.scale.setScalar(p.radius * (opts.visualScale || 1.6));
    p.mesh.position.set(p.x, p.y, p.z);
    p.mesh.visible = true;
    return p;
  }

  update(dt) {
    if (!this.ready) return;
    for (const p of this.items) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.fuse > 0) {
        p.fuse -= dt;
        if (p.fuse <= 0) { this._detonate(p, p.x, p.y, p.z, null); continue; }
      }
      if (p.life <= 0) { this._detonate(p, p.x, p.y, p.z, null); continue; }

      if (p.homing && p.target && p.target.alive) {
        const tx = p.target.pos.x - p.x, ty = p.target.pos.y + p.target.height * 0.5 - p.y, tz = p.target.pos.z - p.z;
        const l = Math.hypot(tx, ty, tz) || 1;
        const sp = Math.hypot(p.vx, p.vy, p.vz);
        p.vx = lerp(p.vx, (tx / l) * sp, clamp01(p.homing * dt));
        p.vy = lerp(p.vy, (ty / l) * sp, clamp01(p.homing * dt));
        p.vz = lerp(p.vz, (tz / l) * sp, clamp01(p.homing * dt));
      }

      p.vy -= p.gravity * dt;
      let dx = p.vx * dt, dy = p.vy * dt, dz = p.vz * dt;
      let step = Math.hypot(dx, dy, dz);
      if (step < 1e-6) continue;
      const nx = dx / step, ny = dy / step, nz = dz / step;

      // Targets first (a rocket should hit the body, not the wall behind it).
      const hitT = Combat.raycastTargets(p.x, p.y, p.z, nx, ny, nz, step + p.radius, p.mask, p.owner);
      const hitW = World.raycast(p.x, p.y, p.z, nx, ny, nz, step + p.radius);
      if (hitT && (!hitW || hitT.dist <= hitW.dist)) {
        this._detonate(p, hitT.point.x, hitT.point.y, hitT.point.z, hitT.target, hitT.crit);
        continue;
      }
      if (hitW) {
        if (p.bounce > 0) {
          const n = hitW.normal;
          const dot = p.vx * n.x + p.vy * n.y + p.vz * n.z;
          p.vx = (p.vx - 2 * dot * n.x) * p.bounce;
          p.vy = (p.vy - 2 * dot * n.y) * p.bounce;
          p.vz = (p.vz - 2 * dot * n.z) * p.bounce;
          p.x = hitW.point.x + n.x * (p.radius + 0.05);
          p.y = hitW.point.y + n.y * (p.radius + 0.05);
          p.z = hitW.point.z + n.z * (p.radius + 0.05);
          p.mesh.position.set(p.x, p.y, p.z);
          if (p.fuse <= 0) p.fuse = 1.2;
          Audio.play('grenade', { pos: p.mesh.position, vol: 0.4 });
          continue;
        }
        this._detonate(p, hitW.point.x, hitW.point.y, hitW.point.z, null);
        continue;
      }

      p.x += dx; p.y += dy; p.z += dz;
      p.mesh.position.set(p.x, p.y, p.z);
      if (Math.random() < 0.9) {
        FX.particle(p.x, p.y, p.z, 0, 0, 0, { color: p.trail, life: 0.28, size: p.radius * 1.5, sizeEnd: 0.02, gravity: 1.2, drag: 3, alpha: 0.8 });
      }
    }
  }

  _detonate(p, x, y, z, directTarget, crit = false) {
    p.alive = false;
    p.mesh.visible = false;
    if (p.onHit) p.onHit(x, y, z, directTarget);
    const info = { source: p.owner, kind: 'explosive', crit: false, power: p.power };
    if (directTarget && p.damage > 0) {
      Combat.damage(directTarget, p.damage * powerScale(p.power, directTarget.power), info);
    }
    if (p.splash) {
      FX.explosion(_v.set(x, y, z), p.splash.radius, p.color);
      Audio.play('explode', { pos: _v, vol: 0.9 });
      Combat.splash(x, y, z, p.splash.radius, p.splash.damage, {
        ...info, mask: p.mask, minFactor: 0.3, ignore: directTarget
      });
    } else {
      FX.impact(_v.set(x, y, z), { x: 0, y: 1, z: 0 }, p.color, 0.8);
    }
  }

  clear() {
    for (const p of this.items) { p.alive = false; p.mesh.visible = false; }
  }
}

export const Projectiles = new ProjectileSystem();

/* ----------------------------------------------------------------- perks */

export const PERKS = {
  rampage: { name: 'Rampage', desc: 'Kills stack +8% damage for 4s (x3).', kind: 'weapon' },
  outlaw: { name: 'Outlaw', desc: 'Precision kills massively boost reload.', kind: 'weapon' },
  kindling: { name: 'Kindling', desc: 'Precision kills detonate the target.', kind: 'weapon' },
  reclaim: { name: 'Reclaim', desc: 'Kills return rounds to the magazine.', kind: 'weapon' },
  zen: { name: 'Zen Moment', desc: 'Dealing damage steadies the weapon.', kind: 'weapon' },
  headseeker: { name: 'Headseeker', desc: 'Body shots boost precision damage for 1.5s.', kind: 'weapon' },
  vorpal: { name: 'Vorpal Weapon', desc: '+20% damage to majors and bosses.', kind: 'weapon' },
  frenzy: { name: 'Frenzy', desc: '+12% damage while in combat over 12s.', kind: 'weapon' }
};
export const PERK_LIST = Object.keys(PERKS);

/* ---------------------------------------------------------------- weapon */

export class Weapon {
  constructor(item) {
    this.item = item;
    this.def = ARCHETYPES[item.archId];
    const d = this.def;
    const s = item.stats || {};
    // Rolled stats nudge the archetype; they never rewrite its job.
    this.damage = d.damage * (1 + (item.damageBonus || 0));
    // Fire rate is the archetype's identity: rolls never touch it.
    this.rpm = d.rpm || 90;
    this.mag = Math.max(1, Math.round(d.mag * (1 + (s.magazine || 0) * 0.06)));
    this.reserveMax = Math.round(d.reserves * (1 + (s.magazine || 0) * 0.05));
    this.reloadTime = d.reload * (1 - (s.reload || 0) * 0.035);
    this.adsTime = d.adsTime * (1 - (s.handling || 0) * 0.03);
    this.swapTime = d.swap * (1 - (s.handling || 0) * 0.035);
    this.rangeMul = 1 + (s.range || 0) * 0.05;
    this.stability = clamp01(0.35 + (s.stability || 0) * 0.07);
    this.aim = clamp01((s.aim || 0) / 10);        // tightens the spread cone

    this.ammo = this.mag;
    this.reserve = this.reserveMax;
    this.cool = 0;
    this.reloading = 0;
    this.reloadStage = 0;
    this.charge = 0;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.equipTimer = 0;
    this.wasTrigger = false;

    // perk state
    this.rampage = 0; this.rampageT = 0;
    this.outlawT = 0;
    this.headseekerT = 0;
    this.frenzyT = 0;
    this.zen = 0;
    this.perks = item.perks || [];
  }

  has(p) { return this.perks.indexOf(p) >= 0; }
  get label() { return this.def.label; }
  get name() { return this.item.name; }
  get slot() { return this.def.slot; }
  get ammoType() { return this.def.ammo; }
  get isEmpty() { return this.ammo <= 0; }
  get canReload() { return this.ammo < this.mag && this.reserve > 0 && this.reloading <= 0; }
  get zoom() { return this.def.zoom; }
  get scoped() { return !!this.def.scope; }

  onEquip() { this.equipTimer = this.swapTime; this.charge = 0; this.burstLeft = 0; }

  /** Damage multiplier from live perk state. */
  perkDamageMul(target, crit) {
    let m = 1;
    if (this.rampage > 0) m *= 1 + 0.08 * this.rampage;
    if (this.frenzyT > 0) m *= 1.12;
    if (this.has('vorpal') && target && (target.tier === 'major' || target.tier === 'boss')) m *= 1.2;
    if (crit && this.headseekerT > 0) m *= 1.25;
    return m;
  }

  update(dt, ctx) {
    this.cool = Math.max(0, this.cool - dt);
    this.equipTimer = Math.max(0, this.equipTimer - dt);
    this.burstTimer = Math.max(0, this.burstTimer - dt);
    this.rampageT = Math.max(0, this.rampageT - dt);
    if (this.rampageT <= 0) this.rampage = 0;
    this.outlawT = Math.max(0, this.outlawT - dt);
    this.headseekerT = Math.max(0, this.headseekerT - dt);
    this.frenzyT = Math.max(0, this.frenzyT - dt);
    this.zen = Math.max(0, this.zen - dt * 0.8);

    // Empty and idle? Start the reload without waiting for a trigger pull.
    // (Charge weapons never pull the trigger when empty, so they relied on it.)
    if (this.ammo <= 0 && this.reloading <= 0 && this.reserve > 0) this.startReload();

    if (this.reloading > 0) {
      const speed = this.outlawT > 0 ? 2.2 : 1;
      this.reloading -= dt * speed;
      const stage = this.reloading < this.reloadTime * 0.35 ? 2 : this.reloading < this.reloadTime * 0.7 ? 1 : 0;
      if (stage !== this.reloadStage) { this.reloadStage = stage; Audio.play('reload', { stage, vol: 0.8 }); }
      if (this.reloading <= 0) {
        const need = this.mag - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.reloading = 0;
      }
    }

    // Burst continuation fires itself once started.
    if (this.burstLeft > 0 && this.burstTimer <= 0 && this.ammo > 0 && ctx) {
      this._shoot(ctx);
      this.burstLeft--;
      this.burstTimer = 60 / (this.def.burstRpm || 900);
      if (this.burstLeft <= 0) this.cool = 60 / this.rpm;
    }
  }

  /** Called every frame with the trigger state. Returns recoil impulse or null. */
  trigger(down, ctx) {
    const edge = down && !this.wasTrigger;
    const released = !down && this.wasTrigger;
    this.wasTrigger = down;
    if (this.equipTimer > 0) return null;

    const d = this.def;
    if (d.mode === 'charge') {
      if (down && this.ammo > 0 && this.reloading <= 0) {
        if (this.charge === 0) Audio.play('charge', { dur: d.charge, vol: 0.7 });
        this.charge += dt_(ctx);
        if (d.id === 'fusion' && this.charge >= d.charge) { const r = this._shoot(ctx); this.charge = 0; return r; }
      } else if (released) {
        if (this.charge >= d.charge * 0.75 && this.ammo > 0) { const r = this._shoot(ctx); this.charge = 0; return r; }
        this.charge = 0;
      }
      return null;
    }

    if (this.reloading > 0 || this.cool > 0 || this.burstLeft > 0) return null;
    if (this.ammo <= 0) {
      if (edge) { Audio.play('deny', { vol: 0.5 }); if (this.canReload) this.startReload(); }
      return null;
    }

    if (d.mode === 'auto') {
      if (!down) return null;
      const r = this._shoot(ctx);
      this.cool = 60 / this.rpm;
      return r;
    }
    if (d.mode === 'semi') {
      if (!edge) return null;
      const r = this._shoot(ctx);
      this.cool = 60 / this.rpm;
      return r;
    }
    if (d.mode === 'burst') {
      if (!edge) return null;
      const r = this._shoot(ctx);
      this.burstLeft = (d.burst || 3) - 1;
      this.burstTimer = 60 / (d.burstRpm || 900);
      return r;
    }
    return null;
  }

  startReload() {
    if (!this.canReload) return false;
    this.reloading = this.reloadTime;
    this.reloadStage = -1;
    this.burstLeft = 0;
    this.charge = 0;
    return true;
  }

  /* ------------------------------------------------------------- firing */

  _shoot(ctx) {
    const d = this.def;
    this.owner = ctx.owner;
    this.ammo--;
    Audio.play(d.sound, { pos: ctx.origin, vol: 1 });
    const spreadDeg = (ctx.ads ? d.adsSpread : d.hipSpread) *
      (1 - this.stability * 0.35) * (1 - this.aim * 0.3) * (ctx.moving ? 1.25 : 1);
    const pellets = d.pellets || 1;
    const rng = ctx.rng || Math.random;

    if (d.projectile) {
      const dir = coneDir(ctx.dir, spreadDeg, rng);
      const pr = d.projectile;
      Projectiles.spawn({
        x: ctx.muzzle.x, y: ctx.muzzle.y, z: ctx.muzzle.z,
        vx: dir.x * pr.speed, vy: dir.y * pr.speed, vz: dir.z * pr.speed,
        gravity: pr.gravity || 0, radius: pr.radius || 0.35,
        damage: this.damage * this.perkDamageMul(null, false),
        splash: d.splash ? { radius: d.splash.radius, damage: d.splash.damage * this.perkDamageMul(null, false) } : null,
        mask: ctx.mask, owner: ctx.owner, color: pr.color, trail: pr.trail,
        bounce: pr.bounce || 0, fuse: pr.fuse || 0, power: ctx.power, life: 8
      });
      FX.muzzle(ctx.muzzle, dir, { color: pr.color, scale: 1.6 });
    } else {
      const bolts = d.bolts || 1;
      for (let b = 0; b < bolts; b++) {
        for (let i = 0; i < pellets; i++) {
          this._hitscan(ctx, spreadDeg * (b > 0 ? 1.1 : 1), rng);
        }
      }
      FX.muzzle(ctx.muzzle, ctx.dir, { color: 0xffd28a, scale: d.id === 'sniper' || d.id === 'shotgun' ? 1.8 : 1 });
    }

    Combat.stats.shots++;
    if (this.ammo <= 0 && this.canReload) this.startReload();

    const rec = d.recoil;
    const stab = 1 - this.stability * 0.55 - (this.zen > 0 ? 0.15 : 0);
    return {
      pitch: rec[0] * stab * (ctx.ads ? 0.72 : 1),
      yaw: (rng() * 2 - 1) * rec[1] * stab * (ctx.ads ? 0.6 : 1),
      kick: (d.id === 'rocket' || d.id === 'shotgun' || d.id === 'sniper') ? 1 : 0.45
    };
  }

  _hitscan(ctx, spreadDeg, rng) {
    const dir = coneDir(ctx.dir, spreadDeg, rng);
    const range = 400;
    let pierceLeft = this.def.pierce || 0;
    let ox = ctx.origin.x, oy = ctx.origin.y, oz = ctx.origin.z;
    let traveled = 0;
    let endPoint = null;

    for (let iter = 0; iter <= pierceLeft; iter++) {
      const remaining = range - traveled;
      if (remaining <= 0) break;
      const hitT = Combat.raycastTargets(ox, oy, oz, dir.x, dir.y, dir.z, remaining, ctx.mask, ctx.owner);
      const hitW = World.raycast(ox, oy, oz, dir.x, dir.y, dir.z, remaining);

      if (hitT && (!hitW || hitT.dist <= hitW.dist)) {
        const dist = traveled + hitT.dist;
        const f = falloff(dist / this.rangeMul, this.def.falloff[0], this.def.falloff[1], this.def.falloffFloor);
        let dmg = this.damage * f * (hitT.crit ? this.def.crit : 1);
        dmg *= this.perkDamageMul(hitT.target, hitT.crit);
        dmg *= powerScale(ctx.power, hitT.target.power);
        const before = hitT.target.alive;
        Combat.damage(hitT.target, dmg, { crit: hitT.crit, source: ctx.owner, kind: 'bullet', dir, power: ctx.power });
        FX.bloodHit(hitT.point, dir, hitT.target.hitColor || 0x8fd8ff, hitT.crit ? 1.4 : 1);
        endPoint = hitT.point;
        if (this.zen >= 0) this.zen = Math.min(1.2, this.zen + 0.12);
        if (before && !hitT.target.alive) this._onKill(hitT.target, hitT.crit, hitT.point);
        if (hitT.crit === false && this.has('headseeker')) this.headseekerT = 1.5;
        traveled += hitT.dist + 0.15;
        ox = hitT.point.x + dir.x * 0.15; oy = hitT.point.y + dir.y * 0.15; oz = hitT.point.z + dir.z * 0.15;
        if (iter >= pierceLeft) break;
        continue;
      }
      if (hitW) {
        FX.impact(hitW.point, hitW.normal, hitW.terrain ? 0xd8b78a : 0xffd9a0, 1);
        endPoint = hitW.point;
      } else {
        endPoint = { x: ox + dir.x * remaining, y: oy + dir.y * remaining, z: oz + dir.z * remaining };
      }
      break;
    }

    if (endPoint) {
      FX.tracer(ctx.muzzle, endPoint, this.def.id === 'sniper' ? 0xbfe8ff : 0xffe6a8, 0.05, 0.75);
    }
  }

  _onKill(target, crit, point) {
    if (this.has('rampage')) { this.rampage = Math.min(3, this.rampage + 1); this.rampageT = 4; }
    if (this.has('reclaim')) { const back = Math.max(1, Math.round(this.mag * 0.15)); this.ammo = Math.min(this.mag, this.ammo + back); }
    if (crit && this.has('outlaw')) this.outlawT = 5;
    if (crit && this.has('kindling')) {
      FX.explosion(_v.set(point.x, point.y, point.z), 3.4, 0xff9a3c, { smoke: false });
      Combat.splash(point.x, point.y, point.z, 3.6, 42, { source: this.owner, kind: 'ability', mask: FACTION.ENEMY });
      Audio.play('explode', { pos: _v, vol: 0.45 });
    }
    if (this.has('frenzy')) this.frenzyT = 12;
  }

  addAmmo(n) {
    const before = this.reserve + this.ammo;
    this.reserve = Math.min(this.reserveMax, this.reserve + n);
    if (this.ammo === 0 && this.reserve > 0) this.startReload();
    return this.reserve + this.ammo - before;
  }
}

/* Charge weapons need dt; the trigger call site passes it on the context. */
function dt_(ctx) { return ctx && ctx.dt ? ctx.dt : 0.016; }

/** Random direction inside a cone of `deg` degrees around `dir`. */
const _tmpA = new THREE.Vector3(), _tmpB = new THREE.Vector3(), _out = new THREE.Vector3();
export function coneDir(dir, deg, rng = Math.random) {
  if (deg <= 0.0001) return _out.copy(dir);
  const rad = (deg * Math.PI) / 180;
  // Build a basis around dir.
  _tmpA.set(0, 1, 0);
  if (Math.abs(dir.y) > 0.95) _tmpA.set(1, 0, 0);
  _tmpB.crossVectors(dir, _tmpA).normalize();
  _tmpA.crossVectors(_tmpB, dir).normalize();
  const ang = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * rad;
  _out.copy(dir)
    .addScaledVector(_tmpB, Math.tan(r) * Math.cos(ang))
    .addScaledVector(_tmpA, Math.tan(r) * Math.sin(ang))
    .normalize();
  return _out;
}

/* ------------------------------------------------------- enemy shooting  */

/** Shared helper so enemies fire with the same rules the player does. */
export function enemyShot(from, dir, {
  damage = 8, spreadDeg = 1.6, range = 120, owner = null, color = 0xff7a4c,
  tracer = true, mask = FACTION.PLAYER, projectile = null, power = 0
} = {}) {
  if (projectile) {
    Projectiles.spawn({
      x: from.x, y: from.y, z: from.z,
      vx: dir.x * projectile.speed, vy: dir.y * projectile.speed, vz: dir.z * projectile.speed,
      gravity: projectile.gravity || 0, radius: projectile.radius || 0.28,
      damage, splash: projectile.splash || null, mask, owner,
      color, trail: color, power, life: 5, homing: projectile.homing || 0, target: projectile.target || null
    });
    return null;
  }
  const d = coneDir(dir, spreadDeg);
  const hitT = Combat.raycastTargets(from.x, from.y, from.z, d.x, d.y, d.z, range, mask, owner);
  const hitW = World.raycast(from.x, from.y, from.z, d.x, d.y, d.z, range);
  let end;
  if (hitT && (!hitW || hitT.dist <= hitW.dist)) {
    Combat.damage(hitT.target, damage * (hitT.crit ? 1.25 : 1), { source: owner, kind: 'bullet', dir: d, crit: false });
    end = hitT.point;
    FX.bloodHit(end, d, 0xff8a5c, 0.8);
  } else if (hitW) {
    end = hitW.point;
    FX.impact(end, hitW.normal, color, 0.7);
  } else {
    end = { x: from.x + d.x * range, y: from.y + d.y * range, z: from.z + d.z * range };
  }
  if (tracer) FX.tracer(from, end, color, 0.07, 0.85);
  return end;
}

/* --------------------------------------------------------------- naming  */

const PREFIX = ['Ash', 'Hollow', 'Sundered', 'Quiet', 'Last', 'Vagrant', 'Iron', 'Pale', 'Riven', 'Long', 'Bitter', 'First'];
const NOUN = ['Verdict', 'Choir', 'Reveler', 'Sight', 'Answer', 'Wolf', 'Hymn', 'Tide', 'Wake', 'Vigil', 'Ledger', 'Signal'];
const EXOTICS = {
  auto: 'ASHEN CHORUS', smg: 'SMALL MERCIES', pulse: 'TRIPTYCH', scout: 'LONGSIGHT',
  handcannon: 'LAST VERDICT', shotgun: 'CINDERBORE', sniper: 'PERIHELION',
  fusion: 'NOVA CHOIR', rocket: 'SUNDERING WOLF', gl: 'PARTING GIFT', bow: 'QUIET ARGUMENT'
};

export function weaponName(archId, rarity, rng) {
  if (rarity === 'exotic') return EXOTICS[archId] || 'THE UNNAMED';
  const r = rng || Math.random;
  const p = PREFIX[Math.floor(r() * PREFIX.length)];
  const n = NOUN[Math.floor(r() * NOUN.length)];
  return `${p} ${n}`;
}

export default { ARCHETYPES, Weapon, Projectiles, enemyShot, weaponName, PERKS };
