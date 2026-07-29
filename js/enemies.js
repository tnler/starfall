/* STARFALL — enemies.js
   The Riven: a faction built the Halo way, out of roles rather than reskins.
   Fodder that panics, ranged units that use cover, a marksman that telegraphs,
   a shielded captain you have to break, a servitor that buffs everything near
   it, and heavies that make you move.

   Each enemy is one merged mesh (one draw call) with a head sphere for
   precision hits. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, angleDelta, swapRemove, makeRNG, TAU } from './util.js';
import Combat, { FACTION, Vitals, powerScale } from './combat.js';
import { enemyShot, Projectiles } from './weapons.js';
import World, { heightAt } from './world.js';
import FX from './fx.js';
import Audio from './audio.js';
import { Effects } from './classes.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/* ------------------------------------------------------------ geometry  */

/** Merge parts into one geometry with baked vertex colours: 1 draw per enemy. */
export function mergeParts(parts) {
  let vCount = 0, iCount = 0;
  const prepared = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    g.applyMatrix4(p.matrix);
    g.computeVertexNormals();
    const pos = g.attributes.position;
    vCount += pos.count;
    iCount += pos.count;
    prepared.push({ g, color: new THREE.Color(p.color) });
  }
  const position = new Float32Array(vCount * 3);
  const normal = new Float32Array(vCount * 3);
  const color = new Float32Array(vCount * 3);
  let o = 0;
  for (const { g, color: c } of prepared) {
    const pos = g.attributes.position, nor = g.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      position[(o + i) * 3] = pos.getX(i);
      position[(o + i) * 3 + 1] = pos.getY(i);
      position[(o + i) * 3 + 2] = pos.getZ(i);
      normal[(o + i) * 3] = nor.getX(i);
      normal[(o + i) * 3 + 1] = nor.getY(i);
      normal[(o + i) * 3 + 2] = nor.getZ(i);
      color[(o + i) * 3] = c.r;
      color[(o + i) * 3 + 1] = c.g;
      color[(o + i) * 3 + 2] = c.b;
    }
    o += pos.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.computeBoundingSphere();
  return out;
}

const M = (x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ry = 0) => {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(sx, sy, sz));
  return m;
};
const BOX = new THREE.BoxGeometry(1, 1, 1);
const SPH = new THREE.SphereGeometry(0.5, 8, 6);
const CONE = new THREE.ConeGeometry(0.5, 1, 6);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 7);
const OCTA = new THREE.OctahedronGeometry(0.5, 0);

/* --------------------------------------------------------------- types  */

export const ENEMY_TYPES = {
  chitter: {
    id: 'chitter', name: 'Chitter', tier: 'minor',
    health: 90, shield: 0, speed: 7.4, radius: 0.42, height: 1.5, headY: 1.28, headR: 0.3,
    damage: 14, range: 2.0, melee: true, fireInterval: 1.0, aggro: 55,
    color: 0x8b6a4a, hitColor: 0xa8ff6a, orbChance: 0.03, panics: true, score: 10,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 0.72, 0, 0.55, 0.72, 0.42), color: 0x6d5238 },
      { geo: SPH.clone(), matrix: M(0, 1.3, 0.08, 0.52, 0.5, 0.55), color: 0x9d7a52 },
      { geo: CONE.clone(), matrix: M(0, 1.5, 0.1, 0.34, 0.4, 0.34), color: 0xa8ff6a },
      { geo: BOX.clone(), matrix: M(-0.34, 0.75, 0, 0.16, 0.62, 0.16), color: 0x4d3a28 },
      { geo: BOX.clone(), matrix: M(0.34, 0.75, 0, 0.16, 0.62, 0.16), color: 0x4d3a28 }
    ])
  },
  skirmisher: {
    id: 'skirmisher', name: 'Skirmisher', tier: 'minor',
    health: 150, shield: 0, speed: 5.0, radius: 0.46, height: 1.85, headY: 1.62, headR: 0.3,
    damage: 9, range: 22, fireInterval: 1.5, burst: 3, burstGap: 0.13, spread: 2.6, aggro: 70,
    color: 0x6b7a8c, hitColor: 0x9fe8ff, cover: true, orbChance: 0.05, score: 20,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 0.95, 0, 0.62, 0.95, 0.44), color: 0x4d5a68 },
      { geo: SPH.clone(), matrix: M(0, 1.66, 0.05, 0.46, 0.46, 0.5), color: 0x8b9aa8 },
      { geo: BOX.clone(), matrix: M(0.02, 1.68, 0.24, 0.3, 0.12, 0.1), color: 0x9fe8ff },
      { geo: BOX.clone(), matrix: M(0.42, 1.1, 0.3, 0.16, 0.16, 0.9), color: 0x2f3740 },
      { geo: BOX.clone(), matrix: M(-0.28, 0.42, 0, 0.2, 0.84, 0.22), color: 0x3a444f },
      { geo: BOX.clone(), matrix: M(0.28, 0.42, 0, 0.2, 0.84, 0.22), color: 0x3a444f }
    ])
  },
  marksman: {
    id: 'marksman', name: 'Marksman', tier: 'minor',
    health: 170, shield: 0, speed: 3.4, radius: 0.46, height: 1.95, headY: 1.72, headR: 0.3,
    damage: 42, range: 65, fireInterval: 3.0, telegraph: 1.1, spread: 0.4, aggro: 110,
    color: 0x7a6b8c, hitColor: 0xc39dff, keepDistance: 40, orbChance: 0.06, score: 30,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 1.0, 0, 0.58, 1.0, 0.42), color: 0x504760 },
      { geo: SPH.clone(), matrix: M(0, 1.76, 0.05, 0.44, 0.44, 0.48), color: 0x8f80a8 },
      { geo: BOX.clone(), matrix: M(0.04, 1.78, 0.26, 0.34, 0.1, 0.1), color: 0xc39dff },
      { geo: BOX.clone(), matrix: M(0.44, 1.2, 0.5, 0.12, 0.12, 1.5), color: 0x2b2536 },
      { geo: BOX.clone(), matrix: M(-0.26, 0.44, 0, 0.2, 0.88, 0.22), color: 0x3b3448 },
      { geo: BOX.clone(), matrix: M(0.26, 0.44, 0, 0.2, 0.88, 0.22), color: 0x3b3448 }
    ])
  },
  shank: {
    id: 'shank', name: 'Shank', tier: 'minor', flying: true, hover: 3.2,
    health: 110, shield: 0, speed: 6.2, radius: 0.5, height: 1.0, headY: 0.5, headR: 0.34,
    damage: 8, range: 18, fireInterval: 1.2, burst: 2, burstGap: 0.16, spread: 3.2, aggro: 60,
    color: 0x8c7a4a, hitColor: 0xffd166, orbChance: 0.04, score: 15,
    build: () => mergeParts([
      { geo: OCTA.clone(), matrix: M(0, 0.5, 0, 1.1, 0.9, 1.1), color: 0x6a5c38 },
      { geo: SPH.clone(), matrix: M(0, 0.5, 0.36, 0.32, 0.32, 0.32), color: 0xffd166 },
      { geo: BOX.clone(), matrix: M(-0.55, 0.5, 0, 0.5, 0.12, 0.16), color: 0x3f3722 },
      { geo: BOX.clone(), matrix: M(0.55, 0.5, 0, 0.5, 0.12, 0.16), color: 0x3f3722 }
    ])
  },
  captain: {
    id: 'captain', name: 'Riven Captain', tier: 'major',
    health: 620, shield: 380, speed: 5.2, radius: 0.58, height: 2.3, headY: 2.0, headR: 0.34,
    damage: 16, range: 16, fireInterval: 1.6, burst: 4, burstGap: 0.11, spread: 3.4, aggro: 90,
    color: 0x9c4a6a, hitColor: 0xff6fb0, blink: true, orbChance: 0.85, score: 120,
    shieldColor: 0x6fe0ff,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 1.15, 0, 0.86, 1.15, 0.56), color: 0x6b2f48 },
      { geo: SPH.clone(), matrix: M(0, 2.05, 0.05, 0.54, 0.54, 0.58), color: 0xb05f80 },
      { geo: BOX.clone(), matrix: M(0, 2.08, 0.3, 0.42, 0.14, 0.12), color: 0xff6fb0 },
      { geo: BOX.clone(), matrix: M(-0.72, 1.5, 0, 0.34, 0.9, 0.5, 0.3), color: 0x50223a },
      { geo: BOX.clone(), matrix: M(0.72, 1.5, 0, 0.34, 0.9, 0.5, -0.3), color: 0x50223a },
      { geo: BOX.clone(), matrix: M(0.6, 1.3, 0.4, 0.2, 0.2, 1.1), color: 0x2c1522 },
      { geo: BOX.clone(), matrix: M(-0.32, 0.5, 0, 0.26, 1.0, 0.28), color: 0x431c2e },
      { geo: BOX.clone(), matrix: M(0.32, 0.5, 0, 0.26, 1.0, 0.28), color: 0x431c2e }
    ])
  },
  servitor: {
    id: 'servitor', name: 'Servitor', tier: 'major', flying: true, hover: 4.6,
    health: 700, shield: 0, speed: 3.0, radius: 1.1, height: 2.2, headY: 1.1, headR: 0.55,
    damage: 30, range: 30, fireInterval: 2.2, spread: 1.2, aggro: 80,
    projectile: { speed: 26, gravity: 0, radius: 0.4, homing: 0.9 },
    color: 0x4a3a6a, hitColor: 0xc39dff, buffs: true, orbChance: 0.9, score: 140,
    build: () => mergeParts([
      { geo: SPH.clone(), matrix: M(0, 1.1, 0, 2.0, 2.0, 2.0), color: 0x3b2f56 },
      { geo: SPH.clone(), matrix: M(0, 1.1, 0.85, 0.7, 0.7, 0.5), color: 0xc39dff },
      { geo: CYL.clone(), matrix: M(0, 1.1, 0, 2.35, 0.16, 2.35), color: 0x241c36 }
    ])
  },
  bulwark: {
    id: 'bulwark', name: 'Bulwark', tier: 'major',
    health: 1500, shield: 0, speed: 2.6, radius: 0.95, height: 3.1, headY: 2.72, headR: 0.42,
    damage: 11, range: 26, fireInterval: 2.6, burst: 10, burstGap: 0.09, spread: 4.0, aggro: 95,
    color: 0x5a4a3a, hitColor: 0xffb45c, heavy: true, orbChance: 0.9, score: 200,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 1.6, 0, 1.5, 1.6, 1.0), color: 0x413528 },
      { geo: SPH.clone(), matrix: M(0, 2.78, 0.1, 0.7, 0.66, 0.7), color: 0x6d5a44 },
      { geo: BOX.clone(), matrix: M(0, 2.8, 0.42, 0.5, 0.16, 0.14), color: 0xffb45c },
      { geo: CYL.clone(), matrix: M(1.05, 1.9, 0.5, 0.44, 1.6, 0.44), color: 0x2a2018 },
      { geo: BOX.clone(), matrix: M(-1.1, 1.7, 0, 0.5, 1.3, 0.9), color: 0x33291e },
      { geo: BOX.clone(), matrix: M(-0.5, 0.5, 0, 0.42, 1.0, 0.5), color: 0x35291d },
      { geo: BOX.clone(), matrix: M(0.5, 0.5, 0, 0.42, 1.0, 0.5), color: 0x35291d }
    ])
  },

  /* ---- named encounter units ---- */
  weaver: {
    id: 'weaver', name: 'Weaver', tier: 'boss',
    health: 3200, shield: 0, speed: 4.4, radius: 0.8, height: 2.6, headY: 2.26, headR: 0.4,
    damage: 22, range: 20, fireInterval: 1.5, burst: 4, burstGap: 0.12, spread: 3.0, aggro: 120,
    color: 0x3f6b6a, hitColor: 0x6fe0ff, orbChance: 1, score: 500, linked: true,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 1.3, 0, 0.95, 1.3, 0.6), color: 0x2c4a4a },
      { geo: OCTA.clone(), matrix: M(0, 2.3, 0.05, 1.1, 1.1, 1.1), color: 0x4f8280 },
      { geo: BOX.clone(), matrix: M(0, 2.3, 0.42, 0.5, 0.14, 0.14), color: 0x6fe0ff },
      { geo: CYL.clone(), matrix: M(-0.85, 1.7, 0, 0.28, 1.5, 0.28), color: 0x1e3434 },
      { geo: CYL.clone(), matrix: M(0.85, 1.7, 0, 0.28, 1.5, 0.28), color: 0x1e3434 },
      { geo: BOX.clone(), matrix: M(-0.34, 0.55, 0, 0.28, 1.1, 0.3), color: 0x243c3c },
      { geo: BOX.clone(), matrix: M(0.34, 0.55, 0, 0.28, 1.1, 0.3), color: 0x243c3c }
    ])
  },
  chorister: {
    id: 'chorister', name: 'Chorister', tier: 'major',
    health: 520, shield: 120, speed: 5.6, radius: 0.5, height: 2.0, headY: 1.76, headR: 0.32,
    damage: 12, range: 18, fireInterval: 1.6, burst: 3, burstGap: 0.12, spread: 3.0, aggro: 100,
    color: 0xb05f30, hitColor: 0xffb45c, carriesOrb: true, orbChance: 0.5, score: 160,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 1.0, 0, 0.6, 1.0, 0.44), color: 0x7a3e1e },
      { geo: SPH.clone(), matrix: M(0, 1.8, 0.05, 0.48, 0.48, 0.5), color: 0xc4703c },
      { geo: OCTA.clone(), matrix: M(0, 2.35, 0, 0.6, 0.6, 0.6), color: 0xffb45c },
      { geo: BOX.clone(), matrix: M(-0.28, 0.46, 0, 0.22, 0.92, 0.24), color: 0x5e2f16 },
      { geo: BOX.clone(), matrix: M(0.28, 0.46, 0, 0.22, 0.92, 0.24), color: 0x5e2f16 }
    ])
  },
  choirmaster: {
    id: 'choirmaster', name: 'Choirmaster Ur', tier: 'boss',
    health: 14000, shield: 0, speed: 3.6, radius: 1.3, height: 4.2, headY: 3.6, headR: 0.6,
    damage: 30, range: 30, fireInterval: 2.0, burst: 5, burstGap: 0.14, spread: 3.2, aggro: 200,
    projectile: { speed: 32, gravity: 6, radius: 0.5, splash: { radius: 4.5, damage: 55 } },
    color: 0x6b2f48, hitColor: 0xff6fb0, orbChance: 1, score: 3000, immuneAtStart: true,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 2.1, 0, 1.9, 2.1, 1.1), color: 0x4a1f33 },
      { geo: SPH.clone(), matrix: M(0, 3.7, 0.1, 1.1, 1.0, 1.1), color: 0x8c3f5e },
      { geo: OCTA.clone(), matrix: M(0, 4.7, 0, 1.2, 1.4, 1.2), color: 0xff6fb0 },
      { geo: CYL.clone(), matrix: M(-1.6, 2.4, 0, 0.5, 2.0, 0.5), color: 0x331623 },
      { geo: CYL.clone(), matrix: M(1.6, 2.4, 0, 0.5, 2.0, 0.5), color: 0x331623 },
      { geo: BOX.clone(), matrix: M(-0.7, 0.75, 0, 0.5, 1.5, 0.6), color: 0x3d1a2b },
      { geo: BOX.clone(), matrix: M(0.7, 0.75, 0, 0.5, 1.5, 0.6), color: 0x3d1a2b }
    ])
  },
  namebearer: {
    id: 'namebearer', name: 'Name-Bearer', tier: 'major',
    health: 1400, shield: 300, speed: 5.4, radius: 0.6, height: 2.4, headY: 2.1, headR: 0.34,
    damage: 18, range: 24, fireInterval: 1.4, burst: 5, burstGap: 0.1, spread: 3.0, aggro: 130,
    color: 0x6a4a9c, hitColor: 0xc39dff, orbChance: 1, score: 400, shieldColor: 0xc39dff,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 1.2, 0, 0.8, 1.2, 0.5), color: 0x4a3070 },
      { geo: SPH.clone(), matrix: M(0, 2.14, 0.05, 0.52, 0.52, 0.56), color: 0x8f6fd0 },
      { geo: OCTA.clone(), matrix: M(0, 2.75, 0, 0.5, 0.7, 0.5), color: 0xc39dff },
      { geo: BOX.clone(), matrix: M(0.62, 1.4, 0.4, 0.2, 0.2, 1.2), color: 0x2a1c40 },
      { geo: BOX.clone(), matrix: M(-0.3, 0.55, 0, 0.26, 1.1, 0.28), color: 0x3a2658 },
      { geo: BOX.clone(), matrix: M(0.3, 0.55, 0, 0.26, 1.1, 0.28), color: 0x3a2658 }
    ])
  },
  aetheron: {
    id: 'aetheron', name: 'Aetheron, the Sundered', tier: 'boss',
    health: 42000, shield: 0, speed: 3.2, radius: 1.8, height: 5.4, headY: 4.6, headR: 0.8,
    damage: 34, range: 40, fireInterval: 1.8, burst: 6, burstGap: 0.12, spread: 3.0, aggro: 300,
    projectile: { speed: 34, gravity: 4, radius: 0.6, splash: { radius: 5.5, damage: 70 } },
    color: 0x4a4368, hitColor: 0xc39dff, orbChance: 1, score: 12000, immuneAtStart: true,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 2.7, 0, 2.4, 2.7, 1.4), color: 0x352f4d },
      { geo: OCTA.clone(), matrix: M(0, 4.7, 0.1, 1.8, 1.9, 1.8), color: 0x6b5f9c },
      { geo: SPH.clone(), matrix: M(0, 4.7, 0.7, 0.7, 0.7, 0.5), color: 0xffd166 },
      { geo: CYL.clone(), matrix: M(-2.1, 3.2, 0, 0.6, 2.6, 0.6), color: 0x241f38 },
      { geo: CYL.clone(), matrix: M(2.1, 3.2, 0, 0.6, 2.6, 0.6), color: 0x241f38 },
      { geo: CONE.clone(), matrix: M(0, 6.4, 0, 1.6, 1.8, 1.6), color: 0xc39dff },
      { geo: BOX.clone(), matrix: M(-0.9, 0.95, 0, 0.6, 1.9, 0.8), color: 0x2c2642 },
      { geo: BOX.clone(), matrix: M(0.9, 0.95, 0, 0.6, 1.9, 0.8), color: 0x2c2642 }
    ])
  },
  sectorboss: {
    id: 'sectorboss', name: 'Vault-Keeper Skarn', tier: 'boss',
    health: 4200, shield: 900, speed: 4.6, radius: 0.9, height: 2.8, headY: 2.45, headR: 0.4,
    damage: 20, range: 18, fireInterval: 1.3, burst: 5, burstGap: 0.1, spread: 3.6, aggro: 140,
    color: 0x9c4a6a, hitColor: 0xff6fb0, blink: true, orbChance: 1, score: 900, shieldColor: 0x6fe0ff,
    build: () => ENEMY_TYPES.captain.build()
  },

  /* ---- second wave of Riven. Each one exists to punish a habit the first
     roster let you keep: standing still, backing up, hugging cover, and
     ignoring the sky. ---- */

  stalker: {
    id: 'stalker', name: 'Stalker', tier: 'minor',
    health: 150, shield: 0, speed: 10.6, radius: 0.4, height: 1.75, headY: 1.5, headR: 0.28,
    damage: 22, range: 2.2, melee: true, fireInterval: 0.8, aggro: 70,
    color: 0x3d2f52, hitColor: 0xc39dff, blink: true, orbChance: 0.06, score: 30,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 0.9, 0, 0.42, 0.9, 0.34), color: 0x2e2440 },
      { geo: SPH.clone(), matrix: M(0, 1.58, 0.05, 0.34, 0.36, 0.38), color: 0x4a3a66 },
      { geo: BOX.clone(), matrix: M(0, 1.6, 0.26, 0.26, 0.07, 0.1), color: 0xc39dff },
      { geo: BOX.clone(), matrix: M(-0.36, 1.0, 0.1, 0.12, 0.7, 0.14, 0.4), color: 0x241c33 },
      { geo: BOX.clone(), matrix: M(0.36, 1.0, 0.1, 0.12, 0.7, 0.14, -0.4), color: 0x241c33 },
      { geo: BOX.clone(), matrix: M(0.42, 1.15, -0.2, 0.06, 0.5, 0.06), color: 0xc39dff },
      { geo: BOX.clone(), matrix: M(-0.2, 0.4, 0, 0.16, 0.8, 0.2), color: 0x2a2038 },
      { geo: BOX.clone(), matrix: M(0.2, 0.4, 0, 0.16, 0.8, 0.2), color: 0x2a2038 }
    ])
  },

  howler: {
    id: 'howler', name: 'Howler', tier: 'minor',
    health: 130, shield: 0, speed: 9.2, radius: 0.5, height: 1.6, headY: 1.35, headR: 0.34,
    damage: 0, range: 3.4, fireInterval: 0.5, aggro: 80,
    detonate: { fuse: 0.75, radius: 7.5, damage: 88, trigger: 3.6 },
    color: 0x7a3a1e, hitColor: 0xff8a3c, orbChance: 0.05, score: 35, panics: false,
    build: () => mergeParts([
      { geo: SPH.clone(), matrix: M(0, 0.85, 0, 0.62, 0.7, 0.62), color: 0x6b3319 },
      { geo: SPH.clone(), matrix: M(0, 1.38, 0.04, 0.34, 0.32, 0.36), color: 0x8c4522 },
      { geo: SPH.clone(), matrix: M(0, 0.9, 0.34, 0.3, 0.3, 0.24), color: 0xff8a3c },
      { geo: BOX.clone(), matrix: M(-0.3, 0.42, 0, 0.16, 0.72, 0.18), color: 0x4e2412 },
      { geo: BOX.clone(), matrix: M(0.3, 0.42, 0, 0.16, 0.72, 0.18), color: 0x4e2412 },
      { geo: CONE.clone(), matrix: M(0, 1.62, 0, 0.22, 0.28, 0.22), color: 0xffc978 }
    ])
  },

  sentinel: {
    id: 'sentinel', name: 'Sentinel', tier: 'minor', flying: true, hover: 5.4,
    health: 190, shield: 60, speed: 6.4, radius: 0.46, height: 1.1, headY: 0.6, headR: 0.34,
    damage: 11, range: 30, fireInterval: 2.0, burst: 3, burstGap: 0.14, spread: 2.4,
    keepDistance: 18, aggro: 95,
    color: 0x2f4a58, hitColor: 0x6fe0ff, shieldColor: 0x6fe0ff, orbChance: 0.12, score: 45,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 0.6, 0, 0.7, 0.26, 0.7, 0.78), color: 0x28414e },
      { geo: SPH.clone(), matrix: M(0, 0.6, 0, 0.34, 0.34, 0.34), color: 0x1c2c36 },
      { geo: SPH.clone(), matrix: M(0, 0.6, 0.3, 0.16, 0.16, 0.16), color: 0x6fe0ff },
      { geo: BOX.clone(), matrix: M(-0.6, 0.6, 0, 0.1, 0.1, 0.5), color: 0x3d5c6c },
      { geo: BOX.clone(), matrix: M(0.6, 0.6, 0, 0.1, 0.1, 0.5), color: 0x3d5c6c }
    ])
  },

  lancer: {
    id: 'lancer', name: 'Riven Lancer', tier: 'major',
    health: 420, shield: 220, speed: 4.6, radius: 0.52, height: 2.2, headY: 1.95, headR: 0.3,
    damage: 68, range: 70, fireInterval: 3.1, telegraph: 1.1, spread: 0.3,
    keepDistance: 42, aggro: 150,
    color: 0x4a4470, hitColor: 0xc39dff, shieldColor: 0xc39dff, orbChance: 0.8, score: 140,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 1.1, 0, 0.66, 1.1, 0.44), color: 0x35305a },
      { geo: SPH.clone(), matrix: M(0, 1.96, 0.04, 0.42, 0.42, 0.46), color: 0x4d4780 },
      { geo: BOX.clone(), matrix: M(0, 2.0, 0.3, 0.34, 0.08, 0.12), color: 0xc39dff },
      { geo: BOX.clone(), matrix: M(0.5, 1.5, 0.5, 0.1, 0.1, 1.6), color: 0x1f1b33 },
      { geo: BOX.clone(), matrix: M(0.5, 1.5, 1.3, 0.05, 0.05, 0.3), color: 0xc39dff },
      { geo: BOX.clone(), matrix: M(-0.28, 0.5, 0, 0.22, 1.0, 0.26), color: 0x2a2648 },
      { geo: BOX.clone(), matrix: M(0.28, 0.5, 0, 0.22, 1.0, 0.26), color: 0x2a2648 }
    ])
  },

  ravager: {
    id: 'ravager', name: 'Ravager', tier: 'major',
    health: 1150, shield: 240, speed: 6.8, radius: 0.78, height: 2.7, headY: 2.3, headR: 0.36,
    damage: 46, range: 3.0, melee: true, fireInterval: 1.4, aggro: 120,
    color: 0x6b2f22, hitColor: 0xff7a4c, shieldColor: 0xff9a3c, orbChance: 0.9, score: 200,
    build: () => mergeParts([
      { geo: BOX.clone(), matrix: M(0, 1.4, 0, 1.15, 1.35, 0.72), color: 0x53241a },
      { geo: SPH.clone(), matrix: M(0, 2.36, 0.06, 0.5, 0.46, 0.52), color: 0x7d3a29 },
      { geo: BOX.clone(), matrix: M(0, 2.4, 0.34, 0.4, 0.1, 0.12), color: 0xff7a4c },
      { geo: BOX.clone(), matrix: M(-1.0, 1.7, 0, 0.42, 1.0, 0.6), color: 0x3d1a13 },
      { geo: BOX.clone(), matrix: M(1.0, 1.7, 0, 0.42, 1.0, 0.6), color: 0x3d1a13 },
      { geo: BOX.clone(), matrix: M(-1.15, 0.95, 0.3, 0.3, 0.3, 0.9), color: 0x2b120d },
      { geo: BOX.clone(), matrix: M(1.15, 0.95, 0.3, 0.3, 0.3, 0.9), color: 0x2b120d },
      { geo: BOX.clone(), matrix: M(-0.42, 0.6, 0, 0.34, 1.2, 0.36), color: 0x431a12 },
      { geo: BOX.clone(), matrix: M(0.42, 0.6, 0, 0.34, 1.2, 0.36), color: 0x431a12 }
    ])
  },

  seraph: {
    id: 'seraph', name: 'Seraph', tier: 'major', flying: true, hover: 8.5,
    health: 700, shield: 400, speed: 7.6, radius: 0.6, height: 1.8, headY: 1.2, headR: 0.36,
    damage: 34, range: 34, fireInterval: 2.4, spread: 1.2, keepDistance: 24, aggro: 150,
    projectile: { speed: 30, gravity: 0, radius: 0.45, homing: 1.3, splash: { radius: 4, damage: 40 } },
    color: 0x584070, hitColor: 0xff6fb0, shieldColor: 0xff6fb0, orbChance: 0.9, score: 220,
    build: () => mergeParts([
      { geo: SPH.clone(), matrix: M(0, 1.0, 0, 0.62, 0.62, 0.62), color: 0x40305c },
      { geo: SPH.clone(), matrix: M(0, 1.0, 0.28, 0.24, 0.24, 0.24), color: 0xff6fb0 },
      { geo: BOX.clone(), matrix: M(-0.95, 1.25, -0.1, 0.75, 0.08, 0.42, 0.35), color: 0x543f74 },
      { geo: BOX.clone(), matrix: M(0.95, 1.25, -0.1, 0.75, 0.08, 0.42, -0.35), color: 0x543f74 },
      { geo: BOX.clone(), matrix: M(0, 0.5, 0, 0.28, 0.5, 0.28), color: 0x2e2244 }
    ])
  }
};

/* --------------------------------------------------------------- states */

const S = { IDLE: 0, ALERT: 1, COMBAT: 2, FLEE: 3, STAGGER: 4, DEAD: 5 };

let ENEMY_ID = 1;

export class Enemy {
  constructor(mgr, type, x, y, z, opts = {}) {
    this.mgr = mgr;
    this.type = type;
    this.id = ENEMY_ID++;
    this.netId = opts.netId || null;
    this.level = opts.level || 1;
    this.tier = opts.tier || type.tier;
    this.activity = opts.activity || null;
    this.squad = opts.squad || null;
    this.anchor = new THREE.Vector3(x, y, z);
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.yaw = opts.yaw || Math.random() * TAU;
    this.faction = FACTION.ENEMY;
    this.isPlayer = false;
    this.alive = true;
    this.grounded = false;

    const lvlMul = 1 + (this.level - 1) * 0.16;
    const tierMul = opts.healthMul || 1;
    this.vitals = new Vitals({
      health: type.health * lvlMul * tierMul,
      shield: (type.shield || 0) * lvlMul * tierMul,
      rechargeDelay: 6, rechargeRate: 0.25
    });
    this.power = 95 + this.level * 5;
    this.damageMul = lvlMul;

    this.radius = type.radius;
    this.height = type.height;
    this.headY = type.headY;
    this.headR = type.headR;
    this.hitColor = type.hitColor;

    this.state = S.IDLE;
    this.stateT = 0;
    this.target = null;
    this.seesTarget = false;
    this.losTimer = Math.random() * 0.3;
    this.fireTimer = type.fireInterval * (0.5 + Math.random());
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.telegraphT = 0;
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.strafeT = 0;
    this.flinch = 0;
    this.immune = !!type.immuneAtStart;
    this.buffed = 0;
    this.blinkCd = 3 + Math.random() * 3;
    this.stuckT = 0;
    this.wanderT = 0;
    this.aggroRange = (type.aggro || 60) * (opts.aggroMul || 1);
    this.carriedOrb = !!type.carriesOrb;
    this.onDeath = opts.onDeath || null;
    this.name = opts.name || type.name;
    this.dropSource = opts.dropSource || (this.tier === 'boss' ? 'major' : this.tier === 'major' ? 'major' : 'trash');
    // Proxies are the host's enemies rendered on someone else's screen: they
    // are shootable, but they never think for themselves.
    this.isProxy = !!opts.proxy;
    this.netTarget = null;
    this.netYaw = this.yaw;

    // mesh
    this.mesh = new THREE.Mesh(mgr.geoFor(type), mgr.bodyMat);
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
    mgr.scene.add(this.mesh);
    if (opts.scale) this.mesh.scale.setScalar(opts.scale);

    if (type.shield && type.shieldColor) {
      this.shieldMesh = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(type.radius * 1.9, type.height * 0.62), 12, 9),
        new THREE.MeshBasicMaterial({ color: type.shieldColor, transparent: true, opacity: 0.2, depthWrite: false })
      );
      this.shieldMesh.position.set(0, type.height * 0.55, 0);
      this.mesh.add(this.shieldMesh);
    }
    if (this.carriedOrb) {
      this.orbMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
      this.orbMesh.position.set(0, type.height + 0.5, 0);
      this.mesh.add(this.orbMesh);
    }
    Combat.register(this);
  }

  /* ----------------------------------------------------------- damage   */

  applyDamage(amount, info = {}) {
    if (!this.alive) return 0;
    if (this.isProxy && info.source && info.source.isPlayer) {
      // Predict locally for feel; the host's snapshot is the truth.
      if (this.mgr.onProxyDamage) this.mgr.onProxyDamage(this, amount, !!info.crit);
    }
    if (this.immune) {
      if (!info.silent) Combat.pushFloater(this.pos.x, this.pos.y + this.height, this.pos.z, 'IMMUNE', 'immune');
      return 0;
    }
    const hadShield = this.vitals.shield > 0;
    const res = this.vitals.hit(amount * (this.buffed > 0 ? 0.6 : 1));
    this.aggroTo(info.source);
    // Flinch on precision hits: it makes headshots feel like they land.
    if (info.crit) this.flinch = Math.min(0.5, this.flinch + 0.22);
    if (this.type.heavy) this.flinch *= 0.3;
    if (res.brokeShield) {
      Audio.play('shieldpop', { pos: this.pos, vol: 0.9 });
      FX.ring(_v.set(this.pos.x, this.pos.y + this.height * 0.5, this.pos.z), { color: this.type.shieldColor || 0x6fe0ff, r1: 4, life: 0.4, up: false });
      if (this.shieldMesh) this.shieldMesh.visible = false;
    } else if (hadShield && this.shieldMesh) {
      this.shieldMesh.material.opacity = 0.45;
    }
    if (res.died) this.die(info);
    return res.dealt;
  }

  knockback(x, y, z) {
    if (this.type.heavy || this.tier === 'boss') { x *= 0.15; y *= 0.15; z *= 0.15; }
    this.vel.x += x; this.vel.y += y; this.vel.z += z;
    this.grounded = false;
    this.state = S.STAGGER;
    this.stateT = 0.5;
  }

  aggroTo(src) {
    if (!src || src.faction === this.faction) return;
    if (!this.target || this.state === S.IDLE) {
      this.target = src;
      if (this.state === S.IDLE) { this.state = S.ALERT; this.stateT = 0.35; }
    }
    if (this.squad) this.squad.alert(src);
  }

  die(info = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.state = S.DEAD;
    Combat.unregister(this);
    Audio.play('enemydeath', { pos: this.pos, vol: 0.8 });
    FX.burst(_v.set(this.pos.x, this.pos.y + this.height * 0.5, this.pos.z), {
      count: this.tier === 'boss' ? 60 : this.tier === 'major' ? 30 : 16,
      speed: this.tier === 'boss' ? 14 : 8, color: this.hitColor, life: 0.7, size: 0.2
    });
    if (this.tier !== 'minor') {
      FX.explosion(_v, this.tier === 'boss' ? 9 : 4.5, this.hitColor, { smoke: this.tier === 'boss' });
    }
    if (this.squad) this.squad.onDeath(this);
    if (Math.random() < (this.type.orbChance || 0)) {
      Effects.spawnOrb(this.pos.x, this.pos.y, this.pos.z, this.tier === 'boss' ? 6 : this.tier === 'major' ? 2 : 1);
    }
    if (this.onDeath) this.onDeath(this, info);
    this.mgr.onEnemyDeath(this, info);
  }

  dispose() {
    if (this.alive) Combat.unregister(this);
    this.alive = false;
    this.mgr.scene.remove(this.mesh);
  }

  /* ------------------------------------------------------------- update */

  update(dt, player) {
    if (!this.alive) return;
    if (this.isProxy) {
      if (this.netTarget) {
        this.pos.x = damp(this.pos.x, this.netTarget.x, 12, dt);
        this.pos.y = damp(this.pos.y, this.netTarget.y, 12, dt);
        this.pos.z = damp(this.pos.z, this.netTarget.z, 12, dt);
      }
      this.yaw += angleDelta(this.yaw, this.netYaw) * clamp01(10 * dt);
      if (this.netHp != null) {
        const want = this.netHp * this.vitals.maxTotal;
        if (want < this.vitals.total) {
          this.vitals.health = Math.max(0, want - this.vitals.shield);
        }
      }
      this.flinch = Math.max(0, this.flinch - dt * 1.6);
      this._animate(dt);
      return;
    }
    // Lit fuse: nothing stops it once it starts, including killing the owner.
    if (this.fuseT != null) {
      this.fuseT -= dt;
      const k = clamp01(this.fuseT / (this.type.detonate.fuse || 0.7));
      if (this.mesh) this.mesh.scale.setScalar(1 + (1 - k) * 0.35);
      if (this.fuseT <= 0) { this._detonate(); return; }
    }

    this.stateT -= dt;
    this.flinch = Math.max(0, this.flinch - dt * 1.6);
    this.buffed = Math.max(0, this.buffed - dt);
    this.vitals.update(dt);
    if (this.shieldMesh) {
      this.shieldMesh.visible = this.vitals.shield > 0;
      this.shieldMesh.material.opacity = damp(this.shieldMesh.material.opacity, 0.2, 4, dt);
    }

    // Perception on a stagger timer — LOS rays are the expensive part.
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.18 + Math.random() * 0.16;
      this._perceive(player);
    }

    switch (this.state) {
      case S.IDLE: this._idle(dt); break;
      case S.ALERT: this._alert(dt); break;
      case S.COMBAT: this._combat(dt); break;
      case S.FLEE: this._flee(dt); break;
      case S.STAGGER: if (this.stateT <= 0) this.state = this.target ? S.COMBAT : S.IDLE; break;
    }

    this._physics(dt);
    this._animate(dt);
  }

  _perceive(player) {
    const t = this.target && this.target.alive ? this.target : null;
    let cand = t;
    if (!cand && player && player.alive) {
      const d = this.pos.distanceTo(player.pos);
      if (d < this.aggroRange) cand = player;
    }
    if (!cand) { this.seesTarget = false; if (this.state === S.COMBAT) { this.state = S.IDLE; this.target = null; } return; }
    // Phantom invisibility drops you off the AI's radar for a moment.
    if (cand.abilities && cand.abilities.invisT > 0 && this.pos.distanceTo(cand.pos) > 8) { this.seesTarget = false; return; }
    const blocked = World.losBlocked(
      this.pos.x, this.pos.y + this.headY, this.pos.z,
      cand.pos.x, cand.pos.y + 1.4, cand.pos.z
    );
    this.seesTarget = !blocked;
    if (this.seesTarget) {
      this.target = cand;
      if (this.state === S.IDLE || this.state === S.ALERT) {
        if (this.state === S.IDLE) Audio.play('enemyshot', { pos: this.pos, vol: 0.25 });
        this.state = S.COMBAT;
      }
      this.lastSeen = this.lastSeen || new THREE.Vector3();
      this.lastSeen.copy(cand.pos);
      if (this.squad) this.squad.alert(cand);
    } else if (this.state === S.COMBAT && this.stateT < -4) {
      this.state = S.ALERT;
      this.stateT = 3;
    }
  }

  _idle(dt) {
    this.wanderT -= dt;
    if (this.wanderT <= 0) {
      this.wanderT = 2.5 + Math.random() * 3.5;
      const a = Math.random() * TAU;
      const r = 4 + Math.random() * 7;
      this.moveGoal = this.moveGoal || new THREE.Vector3();
      this.moveGoal.set(this.anchor.x + Math.cos(a) * r, this.anchor.y, this.anchor.z + Math.sin(a) * r);
    }
    if (this.moveGoal) this._steerTo(this.moveGoal, dt, this.type.speed * 0.35);
  }

  _alert(dt) {
    const goal = this.lastSeen || this.anchor;
    this._steerTo(goal, dt, this.type.speed * 0.8);
    this._faceTo(goal, dt, 6);
    if (this.stateT <= 0) { this.state = S.IDLE; this.target = null; }
  }

  _combat(dt) {
    const t = this.target;
    if (!t || !t.alive) { this.state = S.IDLE; this.target = null; return; }
    const type = this.type;
    const dist = this.pos.distanceTo(t.pos);

    this._faceTo(t.pos, dt, this.tier === 'boss' ? 2.6 : 5.5);

    // Position: melee closes, ranged holds a band, marksmen back off.
    const want = type.melee ? 1.4 : (type.keepDistance || type.range * 0.72);
    const band = type.melee ? 0.6 : 5;
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeT = 1.2 + Math.random() * 1.6; this.strafe *= -1; }

    const speed = type.speed * (this.buffed > 0 ? 1.15 : 1);
    if (dist > want + band) {
      this._steerTo(t.pos, dt, speed);
    } else if (dist < want - band) {
      _v.subVectors(this.pos, t.pos).setY(0).normalize().multiplyScalar(6).add(this.pos);
      this._steerTo(_v, dt, speed * 0.85);
    } else if (!type.melee) {
      // Strafe across the target: standing still in the open is how you die.
      _v.subVectors(t.pos, this.pos).setY(0).normalize();
      _v2.set(-_v.z, 0, _v.x).multiplyScalar(this.strafe * 5).add(this.pos);
      this._steerTo(_v2, dt, speed * 0.7);
    }

    if (type.blink && this.blinkCd > 0) this.blinkCd -= dt;
    if (type.blink && this.blinkCd <= 0 && dist < 22 && this.seesTarget && Math.random() < 0.4) {
      this.blinkCd = 5 + Math.random() * 4;
      this._blink(t);
    }

    // Firing.
    if (!this.seesTarget) { this.fireTimer = Math.max(this.fireTimer, 0.35); return; }
    this.fireTimer -= dt;
    this.burstTimer -= dt;
    if (this.telegraphT > 0) {
      this.telegraphT -= dt;
      // Laser sight: gives the player time to break line of sight.
      FX.tracer(
        _v.set(this.pos.x, this.pos.y + this.headY, this.pos.z),
        _v2.set(t.pos.x, t.pos.y + 1.3, t.pos.z),
        0xff3b3b, 0.06, 0.35
      );
      if (this.telegraphT <= 0) this._fire(t, true);
      return;
    }
    if (this.burstLeft > 0 && this.burstTimer <= 0) {
      this._fire(t);
      this.burstLeft--;
      this.burstTimer = type.burstGap || 0.12;
      if (this.burstLeft <= 0) this.fireTimer = type.fireInterval * (0.8 + Math.random() * 0.5);
      return;
    }
    if (this.fireTimer <= 0 && dist < type.range * 1.35) {
      if (type.detonate) {
        /* Suicide rushers. They close and blow up, which is the one pressure
           the roster had no answer for: everything else lets you back away and
           keep shooting. The fuse is deliberately audible and visible so it is
           a decision to kill it early, not an ambush. */
        if (dist < (type.detonate.trigger || 3.4) && this.fuseT == null) {
          this.fuseT = type.detonate.fuse || 0.7;
          Audio.play('charge', { pos: this.pos, vol: 0.8, dur: this.fuseT });
        }
      } else if (type.melee) {
        if (dist < 2.6) {
          this.fireTimer = type.fireInterval;
          Combat.damage(t, type.damage * this.damageMul, { source: this, kind: 'melee' });
          FX.burst(_v.set(t.pos.x, t.pos.y + 1, t.pos.z), { count: 8, speed: 5, color: this.hitColor, life: 0.3, size: 0.12 });
          Audio.play('melee', { pos: this.pos, vol: 0.7 });
        }
      } else if (type.telegraph) {
        this.telegraphT = type.telegraph;
        Audio.play('charge', { pos: this.pos, vol: 0.5, dur: type.telegraph });
      } else if (type.burst) {
        this.burstLeft = type.burst;
        this.burstTimer = 0;
      } else {
        this._fire(t);
        this.fireTimer = type.fireInterval * (0.8 + Math.random() * 0.5);
      }
    }
  }

  /** Go off. Hurts the player, and hurts whatever it was standing next to. */
  _detonate() {
    const d = this.type.detonate;
    const x = this.pos.x, y = this.pos.y + this.height * 0.5, z = this.pos.z;
    FX.explosion(_v.set(x, y, z), d.radius, this.hitColor || 0xff8a3c);
    Audio.play('explode', { pos: _v, vol: 1 });
    Combat.splash(x, y, z, d.radius, d.damage * this.damageMul, {
      source: this, kind: 'explosive', mask: FACTION.PLAYER, minFactor: 0.25
    });
    // Friendly fire on its own side: crowds of these should thin themselves.
    Combat.splash(x, y, z, d.radius * 0.7, d.damage * 0.4, {
      source: this, kind: 'explosive', mask: FACTION.ENEMY, minFactor: 0.2, ignore: this
    });
    this.die({ kind: 'detonate' });
  }

  _fire(t, heavy = false) {
    const type = this.type;
    const from = _v.set(this.pos.x, this.pos.y + this.headY * 0.92, this.pos.z);
    const to = _v2.set(t.pos.x, t.pos.y + 1.25, t.pos.z);
    const dir = to.sub(from).normalize();
    const dmg = type.damage * this.damageMul * (heavy ? 1 : 1) * (this.buffed > 0 ? 1.2 : 1);
    Audio.play('enemyshot', { pos: this.pos, vol: heavy ? 0.9 : 0.55 });
    enemyShot(from, dir, {
      damage: dmg,
      spreadDeg: heavy ? 0.4 : (type.spread || 2.5),
      range: type.range * 2,
      owner: this,
      color: this.hitColor,
      projectile: type.projectile || null,
      power: this.power
    });
    if (type.projectile && type.projectile.homing) {
      // homing shots need the target handed to the projectile system
      const p = Projectiles.items.find(pp => pp.alive && pp.owner === this && !pp.target);
      if (p) { p.target = t; p.homing = type.projectile.homing; }
    }
  }

  _blink(t) {
    const a = Math.random() * TAU;
    const r = 8 + Math.random() * 6;
    const x = t.pos.x + Math.cos(a) * r, z = t.pos.z + Math.sin(a) * r;
    const y = World.supportY(x, this.pos.y + 3, z);
    if (!isFinite(y)) return;
    FX.burst(this.pos, { count: 14, speed: 6, color: this.hitColor, life: 0.4, size: 0.14 });
    this.pos.set(x, y, z);
    FX.burst(this.pos, { count: 14, speed: 6, color: this.hitColor, life: 0.4, size: 0.14 });
    Audio.play('spawn', { pos: this.pos, vol: 0.5 });
  }

  _flee(dt) {
    const t = this.target;
    if (!t) { this.state = S.IDLE; return; }
    _v.subVectors(this.pos, t.pos).setY(0).normalize().multiplyScalar(14).add(this.pos);
    this._steerTo(_v, dt, this.type.speed * 1.25);
    this._faceTo(_v, dt, 8);
    if (this.stateT <= 0) this.state = S.COMBAT;
  }

  panic() {
    if (!this.type.panics || this.tier !== 'minor') return;
    this.state = S.FLEE;
    this.stateT = 2.5 + Math.random() * 2;
  }

  /* -------------------------------------------------------- locomotion */

  _steerTo(goal, dt, speed) {
    const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.4) return;
    let nx = dx / d, nz = dz / d;

    // Obstacle avoidance: probe ahead, then slide around what is there.
    const probe = 2.4;
    if (World.terrainBlocks(this.pos.x + nx * probe, this.pos.y, this.pos.z + nz * probe, 1.0)) {
      const s = this.strafe;
      const rx = -nz * s, rz = nx * s;
      if (!World.terrainBlocks(this.pos.x + rx * probe, this.pos.y, this.pos.z + rz * probe, 1.0)) {
        nx = rx; nz = rz;
      } else {
        nx = -nx; nz = -nz;
        this.strafe *= -1;
      }
    }
    const accel = 24;
    this.vel.x = damp(this.vel.x, nx * speed, accel / Math.max(1, speed), dt);
    this.vel.z = damp(this.vel.z, nz * speed, accel / Math.max(1, speed), dt);
  }

  _faceTo(p, dt, rate) {
    const want = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
    this.yaw += angleDelta(this.yaw, want) * clamp01(rate * dt);
  }

  _physics(dt) {
    const type = this.type;
    if (type.flying) {
      const groundY = World.supportY(this.pos.x, this.pos.y + 4, this.pos.z, 40);
      const base = isFinite(groundY) ? groundY : heightAt(this.pos.x, this.pos.z);
      const want = base + type.hover + Math.sin(performance.now() * 0.001 + this.id) * 0.35;
      this.vel.y = damp(this.vel.y, (want - this.pos.y) * 2.2, 6, dt);
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      this.pos.z += this.vel.z * dt;
      this.grounded = false;
      return;
    }

    this.vel.y -= 26 * dt;
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    // Horizontal: refuse to walk into terrain walls, slide instead.
    const stepUp = 1.1;
    if (!World.terrainBlocks(nx, this.pos.y, this.pos.z, stepUp) && !this._boxBlocked(nx, this.pos.y, this.pos.z)) this.pos.x = nx;
    else this.vel.x *= 0.2;
    if (!World.terrainBlocks(this.pos.x, this.pos.y, nz, stepUp) && !this._boxBlocked(this.pos.x, this.pos.y, nz)) this.pos.z = nz;
    else this.vel.z *= 0.2;

    this.pos.y += this.vel.y * dt;
    const support = World.supportY(this.pos.x, this.pos.y + stepUp, this.pos.z, stepUp);
    if (isFinite(support) && this.pos.y <= support) {
      this.pos.y = support;
      this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    if (this.pos.y < -300) this.die({ kind: 'void' });
  }

  _boxBlocked(x, y, z) {
    const boxes = World.nearbyColliders(x, z, this.radius + 1.2);
    for (const b of boxes) {
      if (b.tag === 'trigger') continue;
      if (!b.containsXZ(x, z, this.radius * 0.8)) continue;
      const top = b.y + b.hy, bot = b.y - b.hy;
      if (top > y + 1.1 && bot < y + this.height * 0.8) return true;
    }
    return false;
  }

  _animate(dt) {
    const m = this.mesh;
    m.position.copy(this.pos);
    m.rotation.y = this.yaw;
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this._bob = (this._bob || 0) + dt * (4 + sp * 1.4);
    if (!this.type.flying) {
      m.position.y += Math.abs(Math.sin(this._bob)) * Math.min(0.16, sp * 0.035);
      m.rotation.z = Math.sin(this._bob) * Math.min(0.09, sp * 0.02);
    } else {
      m.rotation.z = clamp(this.vel.x * 0.03, -0.3, 0.3);
      m.rotation.x = clamp(-this.vel.z * 0.03, -0.3, 0.3);
    }
    if (this.flinch > 0) {
      const f = 1 + this.flinch * 0.12;
      m.scale.setScalar(f);
      m.material = this.mgr.flashMat;
    } else if (m.material === this.mgr.flashMat) {
      m.material = this.mgr.bodyMat;
      m.scale.setScalar(1);
    }
    if (this.orbMesh) this.orbMesh.rotation.y += dt * 3;
  }
}

/* --------------------------------------------------------------- squads */

/** Fodder that watches its leader die and breaks. Straight out of Halo. */
export class Squad {
  constructor() { this.members = []; this.leader = null; }
  add(e) { this.members.push(e); e.squad = this; if (e.tier !== 'minor' && !this.leader) this.leader = e; return e; }
  alert(target) {
    for (const m of this.members) {
      if (m.alive && m.state === S.IDLE) { m.target = target; m.state = S.ALERT; m.stateT = 0.6; }
    }
  }
  onDeath(e) {
    const i = this.members.indexOf(e);
    if (i >= 0) swapRemove(this.members, i);
    if (e === this.leader) {
      this.leader = null;
      for (const m of this.members) if (m.alive) m.panic();
    }
  }
}

/* -------------------------------------------------------------- manager */

class EnemyManager {
  constructor() {
    this.list = [];
    this.geoCache = new Map();
    this.ready = false;
    this.onDeathHook = null;
    this.budget = 46;          // hard cap on live enemies
  }

  init(scene) {
    this.scene = scene;
    this.bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    // One instanced blob shadow pool grounds everything without shadow maps.
    const g = new THREE.CircleGeometry(1, 14);
    g.rotateX(-Math.PI / 2);
    this.shadowMesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false
    }), 80);
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.renderOrder = 2;
    scene.add(this.shadowMesh);
    this._m4 = new THREE.Matrix4();
    this.ready = true;
  }

  geoFor(type) {
    let g = this.geoCache.get(type.id);
    if (!g) { g = type.build(); this.geoCache.set(type.id, g); }
    return g;
  }

  spawn(typeId, x, y, z, opts = {}) {
    const type = ENEMY_TYPES[typeId];
    if (!type || !this.ready) return null;
    if (this.list.length >= this.budget && type.tier === 'minor') {
      // Recycle the furthest minor rather than refusing the spawn.
      let worst = null, worstD = -1;
      for (const e of this.list) {
        if (e.tier !== 'minor' || !e.alive) continue;
        const d = e.pos.distanceToSquared(this.playerPos || e.pos);
        if (d > worstD) { worstD = d; worst = e; }
      }
      if (worst && worstD > 3600) worst.dispose();
    }
    const e = new Enemy(this, type, x, y, z, opts);
    if (!e.netId) e.netId = (this._netSeq = (this._netSeq || 0) + 1);
    this.list.push(e);
    if (opts.spawnFX !== false) {
      FX.burst(e.pos, { count: 10, speed: 4, color: type.hitColor, life: 0.5, size: 0.16 });
      Audio.play('spawn', { pos: e.pos, vol: 0.45 });
    }
    return e;
  }

  /** Drop an enemy onto the ground at (x,z). */
  spawnAtGround(typeId, x, z, opts = {}) {
    const y = World.supportY(x, 400, z, 500);
    return this.spawn(typeId, x, isFinite(y) ? y : heightAt(x, z), z, opts);
  }

  onEnemyDeath(e, info) {
    if (this.onDeathHook) this.onDeathHook(e, info);
  }

  update(dt, player) {
    this.playerPos = player ? player.pos : null;
    let shadowN = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (!e.alive) {
        e.deadT = (e.deadT || 0) + dt;
        // Sink and fade rather than vanishing on the frame they die.
        e.mesh.position.y -= dt * 1.4;
        e.mesh.rotation.z += dt * 2.2;
        if (e.deadT > 1.1) { this.scene.remove(e.mesh); swapRemove(this.list, i); }
        continue;
      }
      e.update(dt, player);
      if (shadowN < 80 && !e.type.flying) {
        const gy = World.supportY(e.pos.x, e.pos.y + 0.5, e.pos.z, 0.8);
        if (isFinite(gy)) {
          this._m4.makeScale(e.radius * 1.7, 1, e.radius * 1.7);
          this._m4.setPosition(e.pos.x, gy + 0.05, e.pos.z);
          this.shadowMesh.setMatrixAt(shadowN++, this._m4);
        }
      }
    }
    // Park unused shadow instances out of sight.
    for (let i = shadowN; i < 80; i++) {
      this._m4.makeScale(0.0001, 0.0001, 0.0001);
      this._m4.setPosition(0, -9999, 0);
      this.shadowMesh.setMatrixAt(i, this._m4);
    }
    this.shadowMesh.count = 80;
    this.shadowMesh.instanceMatrix.needsUpdate = true;
  }

  aliveIn(x, z, radius, filter = null) {
    const out = [];
    const r2 = radius * radius;
    for (const e of this.list) {
      if (!e.alive) continue;
      if (filter && !filter(e)) continue;
      const dx = e.pos.x - x, dz = e.pos.z - z;
      if (dx * dx + dz * dz <= r2) out.push(e);
    }
    return out;
  }

  countActivity(tag) {
    let n = 0;
    for (const e of this.list) if (e.alive && e.activity === tag) n++;
    return n;
  }

  clearActivity(tag) {
    for (const e of this.list) if (e.activity === tag && e.alive) e.dispose();
  }

  despawnFar(pos, dist = 260) {
    const d2 = dist * dist;
    for (const e of this.list) {
      if (!e.alive || e.activity) continue;
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z;
      if (dx * dx + dz * dz > d2) e.dispose();
    }
  }

  clear() {
    for (const e of this.list) { if (e.alive) Combat.unregister(e); this.scene.remove(e.mesh); }
    this.list.length = 0;
  }
}

/* Servitors buff their friends; run it as a manager pass so the cost is one
   loop instead of one query per enemy. */
export function servitorPass(mgr, dt) {
  for (const s of mgr.list) {
    if (!s.alive || !s.type.buffs) continue;
    s._buffT = (s._buffT || 0) - dt;
    if (s._buffT > 0) continue;
    s._buffT = 0.5;
    for (const e of mgr.list) {
      if (!e.alive || e === s) continue;
      const d = e.pos.distanceTo(s.pos);
      if (d < 24) {
        e.buffed = 0.9;
        if (Math.random() < 0.25) {
          FX.tracer(
            _v.set(s.pos.x, s.pos.y + s.headY, s.pos.z),
            _v2.set(e.pos.x, e.pos.y + e.height * 0.6, e.pos.z),
            0xc39dff, 0.5, 0.25
          );
        }
      }
    }
  }
}

export const Enemies = new EnemyManager();
export default Enemies;
