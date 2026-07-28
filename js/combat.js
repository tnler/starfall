/* STARFALL — combat.js
   The shared damage layer. Everything that can be shot registers here, so
   player weapons, enemy weapons, abilities and splash all resolve the same way.

   The feel rules that matter (lifted straight from the Halo/Destiny loop):
     - shields sit on top of health and recharge after a delay, health does not
     - precision hits multiply damage and make a different noise
     - every hit gives a marker, every kill gives a louder one
     - damage falls off with range so archetypes have jobs */

import * as THREE from 'three';
import { clamp01, lerp, rayCapsule, raySphere, swapRemove } from './util.js';
import FX from './fx.js';
import Audio from './audio.js';

export const FACTION = { PLAYER: 1, ENEMY: 2, NEUTRAL: 4 };

class CombatSystem {
  constructor() {
    this.targets = [];
    this.floaters = [];        // damage numbers, drained by the HUD each frame
    this.hitFlash = 0;         // hitmarker timer
    this.hitCrit = false;
    this.hitKill = false;
    this.killFeed = [];
    this.stats = { shots: 0, hits: 0, crits: 0, kills: 0, damage: 0 };
    this.onKill = null;        // set by main: (target, info) => {}
    this.onPlayerDamaged = null;
  }

  reset() {
    this.targets.length = 0;
    this.floaters.length = 0;
    this.killFeed.length = 0;
  }

  register(t) {
    if (!t._registered) { this.targets.push(t); t._registered = true; }
    return t;
  }
  unregister(t) {
    const i = this.targets.indexOf(t);
    if (i >= 0) swapRemove(this.targets, i);
    t._registered = false;
  }

  /* ------------------------------------------------------------ raycast */

  /**
   * Nearest shootable target along a ray.
   * Bodies are vertical capsules; heads are spheres, so precision aim is a
   * real skill check rather than a random damage roll.
   */
  raycastTargets(ox, oy, oz, dx, dy, dz, maxDist, mask, ignore = null) {
    let best = null;
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (!t.alive || t === ignore) continue;
      if (!(t.faction & mask)) continue;
      const px = t.pos.x - ox, py = t.pos.y - oy, pz = t.pos.z - oz;
      const along = px * dx + py * dy + pz * dz;
      if (along < -t.radius || along > maxDist + t.height) continue;
      // Cheap reject: perpendicular distance from the ray line.
      const perp2 = px * px + py * py + pz * pz - along * along;
      const rr = (t.radius + 1.2) * (t.radius + 1.2);
      if (perp2 > rr + t.height * t.height * 0.25) continue;

      let d = rayCapsule(ox, oy, oz, dx, dy, dz, t.pos.x, t.pos.y, t.pos.z, t.height, t.radius);
      if (d < 0 || d > maxDist) continue;
      let crit = false;
      if (t.headY != null) {
        const hd = raySphere(ox, oy, oz, dx, dy, dz, t.pos.x, t.pos.y + t.headY, t.pos.z, t.headR || t.radius * 0.62);
        if (hd >= 0 && hd <= maxDist) { crit = true; d = Math.min(d, hd); }
      }
      if (!best || d < best.dist) {
        best = { target: t, dist: d, crit, point: { x: ox + dx * d, y: oy + dy * d, z: oz + dz * d } };
      }
    }
    return best;
  }

  /* ------------------------------------------------------------- damage */

  /**
   * @param info {crit, source, kind, dir, silent, color}
   * Returns the damage actually dealt.
   */
  damage(target, amount, info = {}) {
    if (!target || !target.alive || amount <= 0) return 0;
    const dealt = target.applyDamage(amount, info) || 0;
    const fromPlayer = info.source && info.source.isPlayer;

    if (dealt > 0 && fromPlayer) {
      this.stats.damage += dealt;
      this.stats.hits++;
      if (info.crit) this.stats.crits++;
      if (!info.silent) {
        this.pushFloater(target.pos.x, target.pos.y + (target.headY || target.height * 0.7), target.pos.z,
          Math.round(dealt), info.crit ? 'crit' : (info.kind === 'ability' ? 'ability' : 'normal'));
      }
      this.hitFlash = 0.14;
      this.hitCrit = info.crit || false;
      if (!target.alive) {
        this.hitKill = true;
        this.hitFlash = 0.24;
        this.stats.kills++;
        Audio.play('kill', { vol: 0.8 });
        if (this.onKill) this.onKill(target, info);
      } else {
        Audio.play(info.crit ? 'crit' : 'hit', { vol: 0.7 });
      }
    } else if (dealt > 0 && target.isPlayer) {
      if (this.onPlayerDamaged) this.onPlayerDamaged(dealt, info);
    }
    return dealt;
  }

  /** Radial damage with linear falloff. Used by grenades, rockets, supers. */
  splash(x, y, z, radius, maxDamage, info = {}) {
    const mask = info.mask == null ? FACTION.ENEMY : info.mask;
    let hits = 0;
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (!t.alive || !(t.faction & mask) || t === info.ignore) continue;
      const cx = t.pos.x, cy = t.pos.y + t.height * 0.5, cz = t.pos.z;
      const d = Math.hypot(cx - x, cy - y, cz - z);
      if (d > radius + t.radius) continue;
      const k = clamp01(1 - (d - t.radius) / radius);
      const amt = maxDamage * lerp(info.minFactor == null ? 0.35 : info.minFactor, 1, k);
      this.damage(t, amt, { ...info, crit: false, splash: true });
      hits++;
    }
    return hits;
  }

  /** Everything hostile within a radius — used by AI and objective logic. */
  queryTargets(x, y, z, radius, mask, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    for (const t of this.targets) {
      if (!t.alive || !(t.faction & mask)) continue;
      const dx = t.pos.x - x, dy = t.pos.y - y, dz = t.pos.z - z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(t);
    }
    return out;
  }

  nearestTarget(x, y, z, radius, mask) {
    let best = null, bestD = radius * radius;
    for (const t of this.targets) {
      if (!t.alive || !(t.faction & mask)) continue;
      const dx = t.pos.x - x, dy = t.pos.y - y, dz = t.pos.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) { bestD = d2; best = t; }
    }
    return best;
  }

  /* ------------------------------------------------------------ feedback */

  pushFloater(x, y, z, text, kind = 'normal') {
    if (this.floaters.length > 40) this.floaters.shift();
    this.floaters.push({
      x, y, z, text: String(text), kind,
      life: kind === 'crit' ? 1.0 : 0.8, max: kind === 'crit' ? 1.0 : 0.8,
      ox: (Math.random() - 0.5) * 0.9, vy: 1.5 + Math.random() * 0.6
    });
  }

  pushKillFeed(text, kind = 'kill') {
    this.killFeed.push({ text, kind, life: 4.2 });
    if (this.killFeed.length > 6) this.killFeed.shift();
  }

  update(dt) {
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    if (this.hitFlash <= 0) { this.hitCrit = false; this.hitKill = false; }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      f.y += f.vy * dt;
      f.vy -= 2.4 * dt;
      if (f.life <= 0) swapRemove(this.floaters, i);
    }
    for (let i = this.killFeed.length - 1; i >= 0; i--) {
      this.killFeed[i].life -= dt;
      if (this.killFeed[i].life <= 0) this.killFeed.splice(i, 1);
    }
  }
}

/* -------------------------------------------------------------- shields  */

/**
 * The shield/health pair every combatant shares.
 * Shields eat damage first, break loudly, and only start refilling after a
 * quiet window — that delay is what makes fights breathe.
 */
export class Vitals {
  constructor({ health = 100, shield = 0, rechargeDelay = 3.2, rechargeRate = 0.5, overshield = 0 } = {}) {
    this.maxHealth = health;
    this.health = health;
    this.maxShield = shield;
    this.shield = shield;
    this.overshield = overshield;
    this.maxOvershield = overshield;
    this.rechargeDelay = rechargeDelay;
    this.rechargeRate = rechargeRate;   // fraction of max per second
    this.sinceHit = 99;
    this.recharging = false;
    this.dr = 1;                        // damage taken multiplier (buffs/debuffs)
  }
  get alive() { return this.health > 0; }
  get total() { return this.health + this.shield + this.overshield; }
  get maxTotal() { return this.maxHealth + this.maxShield + this.maxOvershield; }
  get shieldPct() { return this.maxShield > 0 ? this.shield / this.maxShield : 0; }
  get healthPct() { return this.health / this.maxHealth; }

  /** Returns {dealt, brokeShield, died}. */
  hit(amount) {
    amount *= this.dr;
    let left = amount;
    let brokeShield = false;
    this.sinceHit = 0;
    this.recharging = false;
    if (this.overshield > 0) {
      const used = Math.min(this.overshield, left);
      this.overshield -= used; left -= used;
    }
    if (this.shield > 0 && left > 0) {
      const used = Math.min(this.shield, left);
      this.shield -= used; left -= used;
      if (this.shield <= 0) brokeShield = true;
    }
    if (left > 0) this.health = Math.max(0, this.health - left);
    return { dealt: amount, brokeShield, died: this.health <= 0 };
  }

  heal(amount) { this.health = Math.min(this.maxHealth, this.health + amount); }
  addOvershield(amount, max) {
    this.maxOvershield = Math.max(this.maxOvershield, max || amount);
    this.overshield = Math.min(this.maxOvershield, this.overshield + amount);
  }

  update(dt) {
    this.sinceHit += dt;
    if (this.maxShield > 0 && this.shield < this.maxShield && this.sinceHit > this.rechargeDelay) {
      const wasRecharging = this.recharging;
      this.recharging = true;
      this.shield = Math.min(this.maxShield, this.shield + this.maxShield * this.rechargeRate * dt);
      return !wasRecharging;   // true on the frame recharge starts
    }
    return false;
  }

  reset() {
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.overshield = 0;
    this.sinceHit = 99;
  }
}

/* ------------------------------------------------------- damage helpers  */

/** Range falloff curve shared by every hitscan weapon. */
export function falloff(dist, start, end, floorFactor = 0.55) {
  if (dist <= start) return 1;
  if (dist >= end) return floorFactor;
  return lerp(1, floorFactor, (dist - start) / (end - start));
}

/**
 * Destiny-style power delta: fighting above your level hurts, and enemies
 * below you take a little more. Keeps the world's difficulty legible.
 */
export function powerScale(attackerPower, defenderPower) {
  const d = (attackerPower || 0) - (defenderPower || 0);
  if (d >= 0) return 1 + Math.min(0.25, d * 0.006);
  return Math.max(0.35, 1 + d * 0.012);
}

export const Combat = new CombatSystem();
export default Combat;
