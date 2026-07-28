/* STARFALL — progress.js
   Guardian rank: the XP curve, the perks it unlocks, and the power floor that
   keeps gear climbing with you.

   Two separate things level up in this game and they do different jobs:

     Power   comes off your gear and gates damage against high-level content.
     Rank    comes off XP and is the thing you actually feel — it unlocks
             permanent perks and drags the power floor up so drops keep pace.

   Without the floor, a player who never opens a chest stays at their starter
   power forever and every drop rolls the same. The floor is the promise that
   playing at all makes you stronger. */

import { clamp } from './util.js';

export const LEVEL_CAP = 50;

/* XP per level: gentle early so the first ranks come fast, then linear. A
   fresh Guardian hits rank 5 in a few patrols; rank 50 is a long haul. */
export function xpForLevel(level) {
  if (level >= LEVEL_CAP) return Infinity;
  return Math.round(420 + (level - 1) * 240 + Math.pow(level - 1, 1.7) * 26);
}

/** What everything in the world is worth. */
export const XP = {
  minor: 14,
  major: 70,
  boss: 520,
  patrol: 260,
  event: 700,
  eventHeroic: 1100,
  lostSector: 900,
  dungeonEncounter: 1500,
  dungeonClear: 4000,
  raidEncounter: 2600,
  raidClear: 9000,
  discovery: 400
};

/* Milestone perks. Each one multiplies a number deriveStats() already
   produces, so nothing downstream has to know these exist. Cooldown keys are
   multiplied (lower = better); capacity keys are multiplied (higher = better). */
export const MILESTONES = [
  { level: 3, id: 'quickened', name: 'Quickened', desc: 'Grenade returns 12% faster.', mods: { grenadeCd: 0.88 } },
  { level: 5, id: 'secondwind', name: 'Second Wind', desc: 'Shields start recharging 15% sooner.', mods: { rechargeDelay: 0.85 } },
  { level: 8, id: 'heavyhands', name: 'Heavy Hands', desc: 'Melee returns 15% faster.', mods: { meleeCd: 0.85 } },
  { level: 12, id: 'focused', name: 'Focused Light', desc: 'Super charges 15% faster.', mods: { superRate: 1.15 } },
  { level: 16, id: 'surefooted', name: 'Surefooted', desc: 'Class ability returns 15% faster.', mods: { classCd: 0.85 } },
  { level: 20, id: 'stormcaller', name: 'Stormcaller', desc: 'Grenade returns another 15% faster.', mods: { grenadeCd: 0.85 } },
  { level: 25, id: 'unbroken', name: 'Unbroken', desc: '+12% shield capacity.', mods: { shieldMax: 1.12 } },
  { level: 30, id: 'fleet', name: 'Fleetfoot', desc: '+6% movement speed.', mods: { moveSpeed: 1.06 } },
  { level: 35, id: 'resolute', name: 'Resolute', desc: 'Shields refill 20% faster.', mods: { rechargeRate: 1.2 } },
  { level: 40, id: 'ascendant', name: 'Ascendant', desc: 'Super charges another 15% faster.', mods: { superRate: 1.15 } },
  { level: 45, id: 'ironclad', name: 'Ironclad', desc: '+12% shield capacity.', mods: { shieldMax: 1.12 } },
  { level: 50, id: 'paragon', name: 'Paragon', desc: 'Every ability returns 10% faster.', mods: { grenadeCd: 0.9, meleeCd: 0.9, classCd: 0.9 } }
];

/** The lowest power the world will roll for you, from rank alone. */
export function powerFloor(level) {
  return Math.round(96 + (level - 1) * 4.2);
}

export class Progression {
  constructor() {
    this.level = 1;
    this.xp = 0;              // into the current level
    this.total = 0;           // lifetime, for the stat screen
    this.pendingLevels = [];  // drained by whoever wants to announce them
    this.recentXP = [];       // {amount, label, t} for the HUD ticker
  }

  get next() { return xpForLevel(this.level); }
  get pct() { return this.level >= LEVEL_CAP ? 1 : clamp(this.xp / this.next, 0, 1); }
  get powerFloor() { return powerFloor(this.level); }

  /** Perks earned so far, in order. */
  get perks() { return MILESTONES.filter(m => m.level <= this.level); }

  /** Apply earned perks to a derived stat block, in place. */
  applyPerks(stats) {
    for (const m of this.perks) {
      for (const k in m.mods) {
        if (typeof stats[k] === 'number') stats[k] *= m.mods[k];
      }
    }
    return stats;
  }

  /** Award XP. Returns the levels gained so callers can celebrate. */
  add(amount, label = '') {
    if (!(amount > 0) || this.level >= LEVEL_CAP) return 0;
    amount = Math.round(amount);
    this.xp += amount;
    this.total += amount;
    this.recentXP.push({ amount, label, t: 2.6 });
    if (this.recentXP.length > 6) this.recentXP.shift();

    let gained = 0;
    while (this.level < LEVEL_CAP && this.xp >= this.next) {
      this.xp -= this.next;
      this.level++;
      gained++;
      const perk = MILESTONES.find(m => m.level === this.level) || null;
      this.pendingLevels.push({ level: this.level, perk });
    }
    if (this.level >= LEVEL_CAP) this.xp = 0;
    return gained;
  }

  update(dt) {
    for (let i = this.recentXP.length - 1; i >= 0; i--) {
      this.recentXP[i].t -= dt;
      if (this.recentXP[i].t <= 0) this.recentXP.splice(i, 1);
    }
  }

  toJSON() { return { level: this.level, xp: this.xp, total: this.total }; }

  static fromJSON(o) {
    const p = new Progression();
    if (!o) return p;
    p.level = clamp(o.level | 0 || 1, 1, LEVEL_CAP);
    p.xp = Math.max(0, o.xp | 0);
    p.total = Math.max(0, o.total | 0);
    return p;
  }
}

export default Progression;
