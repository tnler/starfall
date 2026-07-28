/* STARFALL — loot.js
   Gear, rolls, power level and the stat spread that turns armour into a build.

   Power is a soft gate, not a wall: fighting above your level costs damage
   (see powerScale in combat.js) but never locks you out of an activity. */

import { clamp, clamp01, lerp, makeRNG, roman } from './util.js';
import { ARCHETYPES, ARCH_LIST, PERK_LIST, weaponName } from './weapons.js';

export const RARITY = {
  common: { id: 'common', name: 'Common', color: 0xc9c9c9, css: '#c9c9c9', perks: 0, statTotal: 8, weight: 30 },
  uncommon: { id: 'uncommon', name: 'Uncommon', color: 0x4fd06a, css: '#4fd06a', perks: 1, statTotal: 12, weight: 32 },
  rare: { id: 'rare', name: 'Rare', color: 0x5a8cff, css: '#5a8cff', perks: 1, statTotal: 17, weight: 24 },
  legendary: { id: 'legendary', name: 'Legendary', color: 0xa855f7, css: '#c084fc', perks: 2, statTotal: 24, weight: 12 },
  exotic: { id: 'exotic', name: 'Exotic', color: 0xf5c542, css: '#f5c542', perks: 3, statTotal: 30, weight: 2 }
};
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'legendary', 'exotic'];

export const ARMOR_SLOTS = ['helmet', 'gauntlets', 'chest', 'boots', 'mark'];
export const WEAPON_SLOTS = ['kinetic', 'energy', 'power'];
export const ALL_SLOTS = [...WEAPON_SLOTS, ...ARMOR_SLOTS];

export const STATS = {
  resilience: { name: 'Resilience', blurb: 'Shield capacity' },
  recovery: { name: 'Recovery', blurb: 'Shield recharge' },
  mobility: { name: 'Mobility', blurb: 'Move and jump' },
  discipline: { name: 'Discipline', blurb: 'Grenade cooldown' },
  intellect: { name: 'Intellect', blurb: 'Super charge rate' },
  strength: { name: 'Strength', blurb: 'Melee cooldown' }
};
export const STAT_LIST = Object.keys(STATS);

/* Weapon rolls tune handling, never the archetype's fire rate. */
const WEAPON_STAT_LIST = ['range', 'stability', 'handling', 'reload', 'magazine', 'aim'];

/* Armour naming, per class, so a set reads as a set. */
const ARMOR_SETS = {
  warden: ['Ashwake', 'Bulwark', 'Ironrest', 'Sundered Watch'],
  oracle: ['Verse', 'Quietlight', 'Hollow Choir', 'Nine Hymns'],
  phantom: ['Longshadow', 'Vagrant', 'Cinderstep', 'Last Signal']
};
const ARMOR_PIECE = {
  helmet: ['Helm', 'Cowl', 'Mask'],
  gauntlets: ['Grips', 'Gauntlets', 'Wraps'],
  chest: ['Plate', 'Vest', 'Robes'],
  boots: ['Greaves', 'Strides', 'Boots'],
  mark: ['Mark', 'Bond', 'Cloak']
};

let SERIAL = 1;

/* ------------------------------------------------------------- rolling  */

export function rollRarity(rng, bias = 0) {
  // bias shifts the table toward the top end (dungeon/raid sources).
  const table = RARITY_ORDER.map(id => {
    const r = RARITY[id];
    const idx = RARITY_ORDER.indexOf(id);
    const w = r.weight * Math.pow(1 + bias, idx);
    return [id, w];
  });
  return rng.weighted(table);
}

export function rollWeapon(rng, { power = 100, slot = null, rarity = null, archId = null } = {}) {
  const rar = rarity || rollRarity(rng);
  const info = RARITY[rar];
  let arch = archId;
  if (!arch) {
    const pool = slot ? ARCH_LIST.filter(a => ARCHETYPES[a].slot === slot) : ARCH_LIST;
    arch = rng.pick(pool);
  }
  const def = ARCHETYPES[arch];
  const stats = {};
  let budget = info.statTotal;
  const pool = rng.shuffle(WEAPON_STAT_LIST.slice());
  for (const s of pool) {
    const take = Math.min(budget, rng.int(0, Math.min(10, budget)));
    stats[s] = take;
    budget -= take;
    if (budget <= 0) break;
  }
  const perks = [];
  const perkPool = rng.shuffle(PERK_LIST.slice());
  for (let i = 0; i < info.perks && i < perkPool.length; i++) perks.push(perkPool[i]);

  return {
    uid: SERIAL++,
    kind: 'weapon',
    archId: arch,
    slot: def.slot,
    name: weaponName(arch, rar, rng),
    rarity: rar,
    power: Math.round(power),
    stats,
    perks,
    damageBonus: rar === 'exotic' ? 0.12 : rar === 'legendary' ? 0.06 : rar === 'rare' ? 0.03 : 0,
    label: def.label
  };
}

export function rollArmor(rng, { power = 100, slot = null, rarity = null, classId = 'warden' } = {}) {
  const rar = rarity || rollRarity(rng);
  const info = RARITY[rar];
  const sl = slot || rng.pick(ARMOR_SLOTS);
  const stats = {};
  for (const s of STAT_LIST) stats[s] = 0;
  let budget = info.statTotal;
  // Two "spikes" plus scatter reads better than a flat spread.
  const pool = rng.shuffle(STAT_LIST.slice());
  for (let i = 0; i < pool.length && budget > 0; i++) {
    const cap = i < 2 ? Math.min(10, budget) : Math.min(5, budget);
    const take = rng.int(i < 2 ? Math.min(3, cap) : 0, cap);
    stats[pool[i]] = take;
    budget -= take;
  }
  const set = rng.pick(ARMOR_SETS[classId] || ARMOR_SETS.warden);
  const piece = rng.pick(ARMOR_PIECE[sl]);
  return {
    uid: SERIAL++,
    kind: 'armor',
    slot: sl,
    classId,
    name: `${set} ${piece}`,
    rarity: rar,
    power: Math.round(power),
    stats,
    perks: rar === 'exotic' ? ['exotic_armor'] : [],
    label: sl[0].toUpperCase() + sl.slice(1)
  };
}

/** Source-aware drop: activity difficulty drives both power and rarity. */
export const SOURCES = {
  trash: { powerDelta: [-4, 1], bias: 0.0, chance: 0.09 },
  major: { powerDelta: [-1, 2], bias: 0.25, chance: 0.45 },
  patrol: { powerDelta: [0, 2], bias: 0.15, chance: 1 },
  event: { powerDelta: [1, 3], bias: 0.5, chance: 1 },
  lostSector: { powerDelta: [2, 4], bias: 0.7, chance: 1 },
  dungeon: { powerDelta: [3, 6], bias: 1.1, chance: 1 },
  dungeonBoss: { powerDelta: [5, 9], bias: 1.8, chance: 1 },
  raid: { powerDelta: [5, 8], bias: 1.6, chance: 1 },
  raidBoss: { powerDelta: [8, 13], bias: 2.6, chance: 1, guaranteeExotic: true }
};

export function rollDrop(rng, { power = 100, source = 'trash', classId = 'warden' } = {}) {
  const s = SOURCES[source] || SOURCES.trash;
  if (rng() > s.chance) return null;
  const p = clamp(power + rng.int(s.powerDelta[0], s.powerDelta[1]), 10, 400);
  let rarity = null;
  if (s.guaranteeExotic && rng.chance(0.55)) rarity = 'exotic';
  const isWeapon = rng.chance(0.45);
  const item = isWeapon
    ? rollWeapon(rng, { power: p, rarity: rarity || rollRarity(rng, s.bias) })
    : rollArmor(rng, { power: p, classId, rarity: rarity || rollRarity(rng, s.bias) });
  item.source = source;
  return item;
}

/* ---------------------------------------------------------- inventory   */

export class Inventory {
  constructor(classId = 'warden') {
    this.classId = classId;
    this.equipped = {};
    this.items = [];          // everything not equipped
    this.glimmer = 0;
    this.engrams = 0;
    this.maxItems = 60;
    this.newest = null;
  }

  starterKit(seed = 1) {
    const rng = makeRNG(seed);
    const base = 100;
    this.equip(rollWeapon(rng, { power: base, slot: 'kinetic', rarity: 'uncommon', archId: 'auto' }));
    this.equip(rollWeapon(rng, { power: base, slot: 'energy', rarity: 'uncommon', archId: 'shotgun' }));
    this.equip(rollWeapon(rng, { power: base, slot: 'power', rarity: 'uncommon', archId: 'rocket' }));
    for (const s of ARMOR_SLOTS) this.equip(rollArmor(rng, { power: base, slot: s, rarity: 'common', classId: this.classId }));
    this.glimmer = 500;
    return this;
  }

  equip(item) {
    if (!item) return null;
    const prev = this.equipped[item.slot] || null;
    this.equipped[item.slot] = item;
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    if (prev) this.add(prev, true);
    return prev;
  }

  add(item, silent = false) {
    if (!item) return null;
    this.items.unshift(item);
    if (!silent) this.newest = item;
    while (this.items.length > this.maxItems) {
      // Auto-dismantle the worst thing in the bag rather than blocking drops.
      let worstI = 0, worstScore = Infinity;
      for (let i = 0; i < this.items.length; i++) {
        const sc = itemScore(this.items[i]);
        if (sc < worstScore) { worstScore = sc; worstI = i; }
      }
      const [gone] = this.items.splice(worstI, 1);
      this.glimmer += dismantleValue(gone);
    }
    return item;
  }

  dismantle(item) {
    const i = this.items.indexOf(item);
    if (i < 0) return 0;
    this.items.splice(i, 1);
    const v = dismantleValue(item);
    this.glimmer += v;
    return v;
  }

  /** Average power across equipped gear — the Destiny power number. */
  get power() {
    let sum = 0, n = 0;
    for (const s of ALL_SLOTS) {
      const it = this.equipped[s];
      if (it) { sum += it.power; n++; }
    }
    return n ? Math.round(sum / n) : 0;
  }

  /** Summed armour stats, 0..10 each after the cap. */
  get stats() {
    const out = {};
    for (const s of STAT_LIST) out[s] = 0;
    for (const slot of ARMOR_SLOTS) {
      const it = this.equipped[slot];
      if (!it) continue;
      for (const s of STAT_LIST) out[s] += it.stats[s] || 0;
    }
    for (const s of STAT_LIST) out[s] = clamp(Math.round(out[s] / 5), 0, 10);
    return out;
  }

  weapon(slot) { return this.equipped[slot] || null; }

  toJSON() {
    return {
      classId: this.classId, glimmer: this.glimmer, engrams: this.engrams,
      equipped: this.equipped, items: this.items
    };
  }
  static fromJSON(o) {
    const inv = new Inventory(o.classId || 'warden');
    inv.glimmer = o.glimmer || 0;
    inv.engrams = o.engrams || 0;
    inv.equipped = o.equipped || {};
    inv.items = o.items || [];
    for (const k in inv.equipped) if (inv.equipped[k]) SERIAL = Math.max(SERIAL, inv.equipped[k].uid + 1);
    for (const it of inv.items) SERIAL = Math.max(SERIAL, it.uid + 1);
    return inv;
  }
}

export function itemScore(item) {
  const r = RARITY_ORDER.indexOf(item.rarity);
  let statSum = 0;
  for (const k in item.stats) statSum += item.stats[k];
  return item.power * 10 + r * 25 + statSum;
}

export function dismantleValue(item) {
  const r = RARITY_ORDER.indexOf(item.rarity);
  return 25 + r * 40 + Math.round(item.power * 0.4);
}

/* -------------------------------------------------- derived character    */

/** Turn armour stats into the numbers the player controller actually uses. */
export function deriveStats(statBlock, classDef) {
  const s = statBlock;
  const t = v => clamp01(v / 10);
  return {
    shieldMax: lerp(120, 205, t(s.resilience)) * (classDef.shieldMul || 1),
    rechargeDelay: lerp(3.6, 2.1, t(s.recovery)) * (classDef.recoveryMul || 1),
    rechargeRate: lerp(0.42, 0.8, t(s.recovery)),
    moveSpeed: lerp(6.9, 8.2, t(s.mobility)) * (classDef.speedMul || 1),
    sprintMul: lerp(1.44, 1.56, t(s.mobility)) * (classDef.sprintMul || 1),
    jump: lerp(9.4, 10.8, t(s.mobility)) * (classDef.jumpMul || 1),
    grenadeCd: lerp(11.5, 6.2, t(s.discipline)) * (classDef.grenadeMul || 1),
    meleeCd: lerp(9.5, 5.2, t(s.strength)) * (classDef.meleeMul || 1),
    classCd: lerp(12.5, 7.0, t(s.mobility) * 0.5 + t(s.recovery) * 0.5) * (classDef.classMul || 1),
    superRate: lerp(0.75, 1.5, t(s.intellect)) * (classDef.superMul || 1)
  };
}

/* ------------------------------------------------------------- display  */

export function itemSubtitle(item) {
  if (item.kind === 'weapon') return `${RARITY[item.rarity].name} ${ARCHETYPES[item.archId].label}`;
  return `${RARITY[item.rarity].name} ${item.label}`;
}

export function itemTierLabel(item) {
  return roman(clamp(Math.floor(item.power / 25), 1, 10));
}

export default { RARITY, rollWeapon, rollArmor, rollDrop, Inventory, deriveStats };
