/* STARFALL — world.js
   ONE continuous world. There is no "load into an activity": the dungeon is a
   cave you walk into and the raid is a spire you climb. Everything below lives
   in a single scene graph, streamed by distance.

   Terrain is an analytic heightfield (heightAt is a pure function), so bullets,
   AI and physics can query it without touching a mesh. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, fbm, ridged, hash2, makeRNG, rayBox } from './util.js';
import { buildInteriors } from './interiors.js';

export const WORLD = {
  size: 900,          // world spans -450..450 on x and z
  chunk: 60,          // heightfield mesh chunk size
  chunkRes: 16,       // quads per chunk edge
  seaLevel: -7,
  viewDist: 330,
  propDist: 360
};

const HALF = WORLD.size / 2;
const NCH = Math.round(WORLD.size / WORLD.chunk);   // chunks per axis (15)

/* --------------------------------------------------------------- regions */

export const REGIONS = [
  {
    id: 'rally', name: 'The Rally', x: 0, z: 0, r: 78, safe: true,
    ground: 0x6d6a78, rock: 0x565361, accent: 0x8fd8ff,
    fog: 0x2b3350, sky: 0x1a2140, blurb: 'Last standing outpost. Vendors, transmat, and a view of the Spire.'
  },
  {
    id: 'ashfall', name: 'Ashfall Flats', x: -150, z: 120, r: 165,
    ground: 0x8a6b4a, rock: 0x6b503a, accent: 0xffa552,
    fog: 0x4a3327, sky: 0x2a1c18, blurb: 'Dunes of powdered rock. Riven scavenger patrols, and the wind never stops.'
  },
  {
    id: 'rift', name: 'Verdant Rift', x: 175, z: 135, r: 170,
    ground: 0x3f6b3a, rock: 0x39463a, accent: 0x9dff7a,
    fog: 0x22331f, sky: 0x16261c, blurb: 'A drowned canyon gone green. The Riven drop hardest here.'
  },
  {
    id: 'frost', name: 'Frost Spire Reach', x: -165, z: -180, r: 170,
    ground: 0xa9bacb, rock: 0x5d6a7a, accent: 0x9fe8ff,
    fog: 0x53627a, sky: 0x27334a, blurb: 'Highlands under permanent snow. Marksmen hold the ridges.'
  },
  {
    id: 'maw', name: 'The Maw', x: 185, z: -195, r: 150,
    ground: 0x4a3038, rock: 0x33232a, accent: 0xff5d3c,
    fog: 0x3a1a18, sky: 0x1e0f10, blurb: 'A crater burned into the shore. Something sings underneath it.'
  },
  {
    id: 'spire', name: 'The Sundered Sky', x: 0, z: -330, r: 130,
    ground: 0x4a4560, rock: 0x353048, accent: 0xc39dff,
    fog: 0x2a2140, sky: 0x160f28, blurb: 'The Spire. It fell here, and it is still falling.'
  }
];

const REGION_BY_ID = {};
for (const r of REGIONS) REGION_BY_ID[r.id] = r;
export const regionById = id => REGION_BY_ID[id];

/** Smooth 0..1 influence of a region at a point. */
function regionMask(reg, x, z) {
  const d = Math.hypot(x - reg.x, z - reg.z);
  return 1 - smoothstep(clamp01((d - reg.r * 0.45) / (reg.r * 0.75)));
}

export function regionAt(x, z) {
  let best = REGIONS[0], bestW = -1;
  for (const r of REGIONS) {
    const w = regionMask(r, x, z);
    if (w > bestW) { bestW = w; best = r; }
  }
  return best;
}

/* ------------------------------------------------------------- landmarks */

// The dungeon mouth sits on the inner wall of the Maw crater.
export const MAW = { x: 185, z: -195, r: 118, depth: 46 };
export const DUNGEON_MOUTH = { x: MAW.x - 74, z: MAW.z + 26 };
// The raid spire: a 165-unit tower you can see from spawn.
export const SPIRE = { x: 0, z: -330, r: 92, height: 168 };
export const LOST_SECTOR = { x: -150, z: -150 };

/* -------------------------------------------------------------- height   */

let SEED = 1337;

/** Pure analytic terrain height. Everything in the game trusts this. */
export function heightAt(x, z) {
  const s = SEED;
  let h = fbm(x * 0.0017, z * 0.0017, { octaves: 4, seed: s }) * 26;
  h += fbm(x * 0.0062, z * 0.0062, { octaves: 3, seed: s + 91 }) * 7.5;
  h += fbm(x * 0.021, z * 0.021, { octaves: 2, seed: s + 411 }) * 1.7;

  // Frost highlands: ridged spines.
  const frost = regionMask(REGION_BY_ID.frost, x, z);
  if (frost > 0.001) {
    h += ridged(x * 0.0055, z * 0.0055, { octaves: 4, seed: s + 77 }) * 46 * frost;
    h += 10 * frost;
  }

  // Verdant Rift: a canyon cut along a wandering line.
  const rift = regionMask(REGION_BY_ID.rift, x, z);
  if (rift > 0.001) {
    const spine = Math.sin(x * 0.013 + 1.4) * 26 + Math.cos(x * 0.006) * 18;
    const d = Math.abs((z - REGION_BY_ID.rift.z) - spine);
    const cut = 1 - smoothstep(clamp01((d - 12) / 46));
    h += 13 * rift;
    h -= 30 * cut * rift;
  }

  // Ashfall: long dunes.
  const ash = regionMask(REGION_BY_ID.ashfall, x, z);
  if (ash > 0.001) {
    h += Math.sin(x * 0.028 + Math.cos(z * 0.011) * 2.2) * 4.4 * ash;
    h -= 4 * ash;
  }

  // The Maw: crater bowl with a raised rim.
  const dm = Math.hypot(x - MAW.x, z - MAW.z);
  if (dm < MAW.r * 1.6) {
    const t = clamp01(dm / MAW.r);
    const bowl = -MAW.depth * (1 - t * t) * (1 - smoothstep(clamp01((dm - MAW.r * 0.92) / (MAW.r * 0.3))));
    const rim = 16 * Math.exp(-Math.pow((dm - MAW.r * 1.02) / (MAW.r * 0.22), 2));
    h += bowl + rim;
  }

  // The Spire: a tall cone with a broad skirt. Raid platforms attach to it.
  const ds = Math.hypot(x - SPIRE.x, z - SPIRE.z);
  if (ds < SPIRE.r * 2.4) {
    const skirt = 26 * Math.exp(-Math.pow(ds / (SPIRE.r * 1.5), 2));
    const cone = ds < SPIRE.r ? Math.pow(1 - ds / SPIRE.r, 2.1) * SPIRE.height : 0;
    h += skirt + cone;
  }

  // The Rally: flatten a plateau so the hub reads as built, not grown.
  const dr = Math.hypot(x, z);
  if (dr < 130) {
    const flat = 1 - smoothstep(clamp01((dr - 58) / 62));
    h = lerp(h, 9, flat);
  }

  return h;
}

/** Surface normal by central differences — used for slopes and impact FX. */
export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 1.2;
  const hl = heightAt(x - e, z), hr = heightAt(x + e, z);
  const hd = heightAt(x, z - e), hu = heightAt(x, z + e);
  out.set(hl - hr, 2 * e, hd - hu).normalize();
  return out;
}

export function slopeAt(x, z) {
  const n = normalAt(x, z, _tmpN);
  return 1 - n.y;   // 0 flat, ~1 vertical
}
const _tmpN = new THREE.Vector3();

/* ------------------------------------------------------------- colliders */

/** Oriented box collider. One type for every solid thing in the game. */
export class Box {
  constructor(x, y, z, hx, hy, hz, yaw = 0, tag = '') {
    this.x = x; this.y = y; this.z = z;
    this.hx = hx; this.hy = hy; this.hz = hz;
    this.yaw = yaw;
    this.s = Math.sin(yaw); this.c = Math.cos(yaw);
    this.tag = tag;
    this.enabled = true;
    this.top = y + hy;
  }
  /** World point -> box local space. */
  toLocal(px, py, pz, out) {
    const dx = px - this.x, dz = pz - this.z;
    out.x = dx * this.c + dz * this.s;
    out.y = py - this.y;
    out.z = -dx * this.s + dz * this.c;
    return out;
  }
  containsXZ(px, pz, pad = 0) {
    const dx = px - this.x, dz = pz - this.z;
    const lx = dx * this.c + dz * this.s;
    const lz = -dx * this.s + dz * this.c;
    return Math.abs(lx) <= this.hx + pad && Math.abs(lz) <= this.hz + pad;
  }
  contains(px, py, pz, pad = 0) {
    return this.containsXZ(px, pz, pad) && py >= this.y - this.hy - pad && py <= this.y + this.hy + pad;
  }
}

const _l = new THREE.Vector3();

class ColliderGrid {
  constructor(cell = 30) {
    this.cell = cell;
    this.map = new Map();
    this.all = [];
  }
  key(cx, cz) { return cx * 10007 + cz; }
  add(box) {
    this.all.push(box);
    // Bounding radius in XZ covers any yaw.
    const rad = Math.hypot(box.hx, box.hz);
    const x0 = Math.floor((box.x - rad) / this.cell), x1 = Math.floor((box.x + rad) / this.cell);
    const z0 = Math.floor((box.z - rad) / this.cell), z1 = Math.floor((box.z + rad) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz);
        let arr = this.map.get(k);
        if (!arr) { arr = []; this.map.set(k, arr); }
        arr.push(box);
      }
    }
    return box;
  }
  remove(box) {
    const i = this.all.indexOf(box);
    if (i >= 0) this.all.splice(i, 1);
    const rad = Math.hypot(box.hx, box.hz);
    const x0 = Math.floor((box.x - rad) / this.cell), x1 = Math.floor((box.x + rad) / this.cell);
    const z0 = Math.floor((box.z - rad) / this.cell), z1 = Math.floor((box.z + rad) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.map.get(this.key(cx, cz));
        if (!arr) continue;
        const j = arr.indexOf(box);
        if (j >= 0) arr.splice(j, 1);
      }
    }
  }

  /** Collect boxes near a point into `out` (deduped by a stamp). */
  query(x, z, radius, out) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - radius) / c), x1 = Math.floor((x + radius) / c);
    const z0 = Math.floor((z - radius) / c), z1 = Math.floor((z + radius) / c);
    this._stamp = (this._stamp || 0) + 1;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.map.get(this.key(cx, cz));
        if (!arr) continue;
        for (const b of arr) {
          if (b._stamp === this._stamp || !b.enabled) continue;
          b._stamp = this._stamp;
          out.push(b);
        }
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ main */

class WorldSystem {
  constructor() {
    this.ready = false;
    this.scene = null;
    this.grid = new ColliderGrid(30);
    this.noTerrain = [];      // volumes where the heightfield does not exist (interiors)
    this.chunks = [];
    this.propCells = [];
    this.pois = [];
    this.triggers = [];
    this.interiors = null;
    this._queryBuf = [];
    this._t = 0;
  }

  /* --------------------------------------------------------- build steps */

  /** Generator so the loading screen can show real progress. */
  *build(scene, seed = 1337) {
    SEED = seed >>> 0;
    this.scene = scene;
    this.rng = makeRNG(SEED);

    yield { msg: 'Charting the shore', p: 0.02 };
    this._materials();
    this._sky();

    let done = 0;
    const total = NCH * NCH;
    for (let cx = 0; cx < NCH; cx++) {
      for (let cz = 0; cz < NCH; cz++) {
        this._buildChunk(cx, cz);
        done++;
      }
      yield { msg: 'Raising terrain', p: 0.02 + 0.6 * (done / total) };
    }

    yield { msg: 'Seeding the wilds', p: 0.66 };
    this._buildProps();

    yield { msg: 'Building the Rally', p: 0.78 };
    this._buildHub();
    this._buildLandmarks();

    yield { msg: 'Opening the Maw', p: 0.86 };
    this.interiors = buildInteriors(this, scene);

    yield { msg: 'Lighting the sky', p: 0.96 };
    this._water();
    this.ready = true;
    yield { msg: 'Ready', p: 1 };
  }

  _materials() {
    this.mat = {
      terrain: new THREE.MeshLambertMaterial({ vertexColors: true }),
      rock: new THREE.MeshLambertMaterial({ color: 0x5b5a63, flatShading: true }),
      trunk: new THREE.MeshLambertMaterial({ color: 0x453425 }),
      leaf: new THREE.MeshLambertMaterial({ color: 0x3e7a35, flatShading: true }),
      ice: new THREE.MeshLambertMaterial({ color: 0xbfe9ff, flatShading: true, transparent: true, opacity: 0.82 }),
      crystal: new THREE.MeshLambertMaterial({ color: 0xff6a3c, emissive: 0x812009, flatShading: true }),
      metal: new THREE.MeshLambertMaterial({ color: 0x6d7480, flatShading: true }),
      metalDark: new THREE.MeshLambertMaterial({ color: 0x3a3f4a, flatShading: true }),
      hull: new THREE.MeshLambertMaterial({ color: 0x8d8577, flatShading: true }),
      glow: new THREE.MeshBasicMaterial({ color: 0x8fd8ff }),
      glowWarm: new THREE.MeshBasicMaterial({ color: 0xffb45c }),
      vex: new THREE.MeshLambertMaterial({ color: 0x4b4468, emissive: 0x160f28, flatShading: true })
    };
  }

  _sky() {
    const scene = this.scene;
    const geo = new THREE.SphereGeometry(1400, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x0b0f22) },
        mid: { value: new THREE.Color(0x2a2350) },
        bot: { value: new THREE.Color(0x6b3f4a) },
        sunDir: { value: new THREE.Vector3(0.45, 0.28, -0.85).normalize() }
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 top, mid, bot; uniform vec3 sunDir; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 c = mix(bot, mid, smoothstep(0.42, 0.62, h));
          c = mix(c, top, smoothstep(0.6, 0.95, h));
          float sun = pow(max(dot(normalize(vDir), sunDir), 0.0), 220.0);
          float halo = pow(max(dot(normalize(vDir), sunDir), 0.0), 6.0) * 0.16;
          c += vec3(1.0, 0.76, 0.5) * (sun * 2.2 + halo);
          gl_FragColor = vec4(c, 1.0);
        }`
    });
    this.skyDome = new THREE.Mesh(geo, mat);
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -100;
    scene.add(this.skyDome);

    // Stars: cheap, and they sell the "sky is broken" premise.
    const N = 900;
    const pos = new Float32Array(N * 3);
    const rng = makeRNG(SEED + 7);
    for (let i = 0; i < N; i++) {
      const th = rng() * Math.PI * 2;
      const ph = Math.acos(rng() * 1.2 - 0.2);
      const r = 1300;
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * r;
      pos[i * 3 + 1] = Math.cos(ph) * r;
      pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe7ff, size: 3.4, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -99;
    scene.add(this.stars);

    this.sun = new THREE.DirectionalLight(0xffd9b0, 1.35);
    this.sun.position.set(220, 180, -420);
    scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x9db4ff, 0x3a2e2a, 0.62);
    scene.add(this.hemi);
    this.fog = new THREE.Fog(0x2b3350, 60, 520);
    scene.fog = this.fog;
  }

  _water() {
    const g = new THREE.PlaneGeometry(WORLD.size * 1.4, WORLD.size * 1.4, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      color: 0x1d3a52, transparent: true, opacity: 0.72, emissive: 0x08131e
    }));
    this.water.position.y = WORLD.seaLevel;
    this.water.renderOrder = -1;
    this.scene.add(this.water);
  }

  /* -------------------------------------------------------------- chunks */

  _buildChunk(cx, cz) {
    const res = WORLD.chunkRes;
    const size = WORLD.chunk;
    const ox = -HALF + cx * size;
    const oz = -HALF + cz * size;
    const verts = (res + 1) * (res + 1);
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    const idx = new Uint16Array(res * res * 6);

    const c = new THREE.Color();
    for (let j = 0; j <= res; j++) {
      for (let i = 0; i <= res; i++) {
        const k = j * (res + 1) + i;
        const x = ox + (i / res) * size;
        const z = oz + (j / res) * size;
        const y = heightAt(x, z);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        this._terrainColor(x, z, y, c);
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      }
    }
    let t = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = j * (res + 1) + i, b = a + 1, d = a + res + 1, e = d + 1;
        idx[t++] = a; idx[t++] = d; idx[t++] = b;
        idx[t++] = b; idx[t++] = d; idx[t++] = e;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, this.mat.terrain);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.chunks.push({ mesh, cx: ox + size / 2, cz: oz + size / 2 });
  }

  _terrainColor(x, z, y, out) {
    const reg = regionAt(x, z);
    const slope = slopeAt(x, z);
    out.setHex(reg.ground);
    // Rock shows through on steep faces; snow caps high ground in the north.
    const rockT = smoothstep(clamp01((slope - 0.16) / 0.4));
    out.lerp(_c1.setHex(reg.rock), rockT);
    if (reg.id === 'frost') out.lerp(_c1.setHex(0xf2f8ff), clamp01((y - 34) / 40) * (1 - rockT * 0.7));
    if (reg.id === 'maw') {
      const heat = clamp01((-y - 12) / 34);
      out.lerp(_c1.setHex(0xff5a24), heat * 0.55);
    }
    if (y < WORLD.seaLevel + 2.5) out.lerp(_c1.setHex(0x2e3b44), 0.55);
    // Break up flat colour with per-vertex noise so big fields do not look plastic.
    const n = 0.88 + 0.24 * hash2(Math.round(x * 0.8), Math.round(z * 0.8), SEED);
    out.multiplyScalar(n);
  }

  /* --------------------------------------------------------------- props */

  _buildProps() {
    const SC = 180;                       // prop super-cell
    const n = Math.ceil(WORLD.size / SC);
    const geoRock = new THREE.IcosahedronGeometry(1, 0);
    const geoTrunk = new THREE.CylinderGeometry(0.34, 0.5, 1, 6);
    geoTrunk.translate(0, 0.5, 0);
    const geoLeaf = new THREE.ConeGeometry(1, 1, 7);
    geoLeaf.translate(0, 0.5, 0);
    const geoShard = new THREE.ConeGeometry(1, 1, 5);
    geoShard.translate(0, 0.5, 0);

    for (let ix = 0; ix < n; ix++) {
      for (let iz = 0; iz < n; iz++) {
        const ox = -HALF + ix * SC, oz = -HALF + iz * SC;
        const rng = makeRNG(SEED + ix * 733 + iz * 977);
        const lists = { rock: [], trunk: [], leaf: [], shard: [], crystal: [] };
        const tries = 420;
        for (let i = 0; i < tries; i++) {
          const x = ox + rng() * SC, z = oz + rng() * SC;
          const reg = regionAt(x, z);
          const y = heightAt(x, z);
          if (y < WORLD.seaLevel + 1) continue;
          if (slopeAt(x, z) > 0.42) continue;
          if (Math.hypot(x, z) < 66) continue;              // keep the hub clear
          const yaw = rng() * Math.PI * 2;
          const roll = rng();
          if (reg.id === 'rift') {
            if (roll < 0.62) {
              const h = rng.range(4.5, 11);
              lists.trunk.push([x, y, z, 1, h, 1, yaw]);
              lists.leaf.push([x, y + h * 0.72, z, rng.range(2.2, 3.6), rng.range(4, 7), 0, yaw]);
              if (h > 7) this.grid.add(new Box(x, y + h / 2, z, 0.6, h / 2, 0.6, 0, 'tree'));
            } else if (roll < 0.78) {
              const s = rng.range(0.7, 2.4);
              lists.rock.push([x, y + s * 0.5, z, s, s * rng.range(0.6, 1.3), s, yaw]);
            }
          } else if (reg.id === 'frost') {
            if (roll < 0.34) {
              const s = rng.range(1.4, 4.4);
              lists.shard.push([x, y, z, s * 0.42, s * rng.range(2, 4), s * 0.42, yaw]);
              if (s > 3) this.grid.add(new Box(x, y + s, z, s * 0.4, s * 1.4, s * 0.4, yaw, 'ice'));
            } else if (roll < 0.55) {
              const s = rng.range(0.9, 3.4);
              lists.rock.push([x, y + s * 0.4, z, s, s * rng.range(0.5, 1.1), s, yaw]);
            }
          } else if (reg.id === 'maw') {
            if (roll < 0.3) {
              const s = rng.range(1, 3.6);
              lists.crystal.push([x, y, z, s * 0.5, s * rng.range(1.6, 3.2), s * 0.5, yaw]);
            } else if (roll < 0.5) {
              const s = rng.range(1.2, 3.8);
              lists.rock.push([x, y + s * 0.4, z, s, s * rng.range(0.5, 1.2), s, yaw]);
            }
          } else if (reg.id === 'spire') {
            if (roll < 0.32) {
              const s = rng.range(1.2, 4.2);
              lists.shard.push([x, y, z, s * 0.5, s * rng.range(2.2, 4.5), s * 0.5, yaw]);
            }
          } else {
            if (roll < 0.4) {
              const s = rng.range(0.8, 3.6);
              lists.rock.push([x, y + s * 0.35, z, s, s * rng.range(0.4, 1.0), s, yaw]);
              if (s > 2.8) this.grid.add(new Box(x, y + s * 0.4, z, s * 0.8, s * 0.6, s * 0.8, yaw, 'rock'));
            }
          }
        }
        const cellCenter = new THREE.Vector3(ox + SC / 2, 0, oz + SC / 2);
        const meshes = [];
        const mk = (geo, mat, arr) => {
          if (!arr.length) return;
          const im = new THREE.InstancedMesh(geo, mat, arr.length);
          const m = new THREE.Matrix4();
          const q = new THREE.Quaternion();
          const e = new THREE.Euler();
          for (let i = 0; i < arr.length; i++) {
            const [x, y, z, sx, sy, sz, yaw] = arr[i];
            e.set(0, yaw, 0);
            q.setFromEuler(e);
            m.compose(_vTmp.set(x, y, z), q, _vTmp2.set(sx, sy, sz));
            im.setMatrixAt(i, m);
          }
          im.instanceMatrix.needsUpdate = true;
          im.frustumCulled = true;
          this.scene.add(im);
          meshes.push(im);
        };
        mk(geoRock, this.mat.rock, lists.rock);
        mk(geoTrunk, this.mat.trunk, lists.trunk);
        mk(geoLeaf, this.mat.leaf, lists.leaf);
        mk(geoShard, this.mat.ice, lists.shard);
        mk(geoShard, this.mat.crystal, lists.crystal);
        if (meshes.length) this.propCells.push({ center: cellCenter, meshes });
      }
    }
  }

  /* ----------------------------------------------------------- structures */

  /** Add a solid box that is both visible and collidable. */
  addStructure(x, y, z, w, h, d, { yaw = 0, mat = 'metal', collide = true, tag = 'struct', parent = null, color = null } = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    let material = typeof mat === 'string' ? this.mat[mat] : mat;
    if (color != null) {
      // Cache by colour: interiors ask for the same few tints hundreds of times.
      this._colorMats = this._colorMats || new Map();
      material = this._colorMats.get(color);
      if (!material) {
        material = new THREE.MeshLambertMaterial({ color, flatShading: true });
        this._colorMats.set(color, material);
      }
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    (parent || this.scene).add(mesh);
    if (collide) this.grid.add(new Box(x, y, z, w / 2, h / 2, d / 2, yaw, tag));
    return mesh;
  }

  addCollider(x, y, z, hx, hy, hz, yaw = 0, tag = 'solid') {
    return this.grid.add(new Box(x, y, z, hx, hy, hz, yaw, tag));
  }

  /** Temporary colliders (a Warden barricade, a raid bridge) come back out. */
  removeCollider(box) {
    if (!box) return;
    box.enabled = false;
    this.grid.remove(box);
  }

  /** Volume where the heightfield is ignored (you are inside something). */
  addInteriorVolume(x, y, z, hx, hy, hz, id) {
    const b = new Box(x, y, z, hx, hy, hz, 0, id);
    this.noTerrain.push(b);
    return b;
  }

  addPOI(poi) { this.pois.push(poi); return poi; }

  _buildHub() {
    const g = new THREE.Group();
    this.scene.add(g);
    const y = heightAt(0, 0);
    this.hubY = y;

    // Landing pad + ring wall.
    this.addStructure(0, y - 0.35, 0, 74, 1.1, 74, { mat: 'metalDark', tag: 'floor', parent: g });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = 36;
      this.addStructure(Math.cos(a) * r, y + 1.6, Math.sin(a) * r, 6, 3.2, 1.6, { yaw: -a, mat: 'metal', tag: 'wall', parent: g });
    }
    // Central transmat obelisk — the visual anchor of the hub.
    this.addStructure(0, y + 5, 0, 4, 10, 4, { mat: 'metalDark', tag: 'obelisk', parent: g });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 1), this.mat.glow);
    core.position.set(0, y + 12.4, 0);
    g.add(core);
    this.hubCore = core;

    // Vendor kiosks: gunsmith / quartermaster / cryptarch.
    const kiosks = [
      { id: 'gunsmith', name: 'Gunsmith Vell', a: 0.4, color: 0xff8a4c },
      { id: 'quartermaster', name: 'Quartermaster Ryn', a: 2.5, color: 0x6fe0ff },
      { id: 'cryptarch', name: 'Cryptarch Ossa', a: 4.4, color: 0xc39dff }
    ];
    for (const k of kiosks) {
      const x = Math.cos(k.a) * 22, z = Math.sin(k.a) * 22;
      this.addStructure(x, y + 1.3, z, 3.4, 2.6, 2.2, { yaw: -k.a, mat: 'metal', tag: 'kiosk', parent: g });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color: k.color }));
      lamp.position.set(x, y + 3.2, z);
      g.add(lamp);
      this.addPOI({ id: k.id, name: k.name, kind: 'vendor', x, y: y + 1.4, z, r: 3.6, color: k.color });
    }

    this.addPOI({ id: 'rally', name: 'The Rally', kind: 'travel', x: 0, y: y + 1, z: 6, r: 5, color: 0x8fd8ff, discovered: true });
    this.spawnPoint = new THREE.Vector3(0, y + 2, 16);
  }

  _buildLandmarks() {
    // Ruined hulls scattered along the shore — cover to fight around.
    const rng = makeRNG(SEED + 555);
    for (let i = 0; i < 34; i++) {
      const x = rng.range(-HALF + 60, HALF - 60);
      const z = rng.range(-HALF + 60, HALF - 60);
      if (Math.hypot(x, z) < 95) continue;
      if (Math.hypot(x - SPIRE.x, z - SPIRE.z) < SPIRE.r * 1.1) continue;
      const y = heightAt(x, z);
      if (y < WORLD.seaLevel + 2 || slopeAt(x, z) > 0.3) continue;
      const w = rng.range(6, 16), h = rng.range(3, 9), d = rng.range(4, 10);
      const yaw = rng() * Math.PI;
      this.addStructure(x, y + h / 2 - 1, z, w, h, d, { yaw, mat: 'hull', tag: 'wreck' });
      if (rng.chance(0.5)) this.addStructure(x + Math.cos(yaw) * w * 0.6, y + h * 0.9, z + Math.sin(yaw) * w * 0.6, w * 0.4, h * 0.7, d * 0.6, { yaw: yaw + 0.4, mat: 'hull', tag: 'wreck' });
    }

    // Region discovery beacons double as fast-travel nodes once visited.
    for (const r of REGIONS) {
      if (r.id === 'rally') continue;
      const y = heightAt(r.x, r.z);
      this.addStructure(r.x, y + 2.2, r.z, 1.4, 4.4, 1.4, { mat: 'metalDark', tag: 'beacon' });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.62, 10, 8), new THREE.MeshBasicMaterial({ color: r.accent }));
      lamp.position.set(r.x, y + 5, r.z);
      this.scene.add(lamp);
      this.addPOI({ id: 'travel_' + r.id, name: r.name, kind: 'travel', x: r.x, y: y + 1, z: r.z, r: 5.5, color: r.accent, region: r.id });
    }
  }

  /* --------------------------------------------------------------- query */

  /** Is the heightfield present at this point? (false inside caves) */
  terrainActive(x, y, z) {
    for (const v of this.noTerrain) if (v.contains(x, y, z, 0)) return false;
    return true;
  }

  nearbyColliders(x, z, radius) {
    return this.grid.query(x, z, radius, this._queryBuf);
  }

  /** Highest walkable surface at or below `yTop`. Returns -Infinity if none. */
  supportY(x, y, z, step = 0.9) {
    let best = -Infinity;
    if (this.terrainActive(x, y, z)) {
      const h = heightAt(x, z);
      if (h <= y + step) best = h;
    }
    const boxes = this.grid.query(x, z, 2.2, this._queryBuf);
    for (const b of boxes) {
      if (b.tag === 'trigger' || b.tag === 'nowalk') continue;
      if (!b.containsXZ(x, z, 0.12)) continue;
      const top = b.y + b.hy;
      if (top <= y + step && top > best) best = top;
    }
    return best;
  }

  /** Terrain height treated as a wall for horizontal movement. */
  terrainBlocks(x, y, z, step = 0.9) {
    if (!this.terrainActive(x, y, z)) return false;
    return heightAt(x, z) > y + step;
  }

  /* -------------------------------------------------------------- raycast */

  /**
   * March a ray against terrain + colliders.
   * Returns null or {dist, point:{x,y,z}, normal:THREE.Vector3, box}.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 400) {
    let bestDist = maxDist;
    let hitBox = null;
    // Colliders: walk cells along the ray and slab-test.
    const boxes = this._rayBoxes(ox, oy, oz, dx, dy, dz, maxDist);
    for (const b of boxes) {
      if (b.tag === 'trigger') continue;
      // Transform ray into box space (yaw only).
      const rx = ox - b.x, rz = oz - b.z;
      const lx = rx * b.c + rz * b.s, lz = -rx * b.s + rz * b.c;
      const ly = oy - b.y;
      const ldx = dx * b.c + dz * b.s, ldz = -dx * b.s + dz * b.c;
      const t = rayBox(lx, ly, lz, ldx, dy, ldz,
        { x: -b.hx, y: -b.hy, z: -b.hz }, { x: b.hx, y: b.hy, z: b.hz });
      if (t >= 0 && t < bestDist) { bestDist = t; hitBox = b; }
    }

    // Terrain: fixed-step march, then bisect for the crossing point.
    let tHit = -1;
    const step = 0.9;
    let prevT = 0;
    let prevDiff = oy - heightAt(ox, oz);
    if (this.terrainActive(ox, oy, oz) && prevDiff < 0) prevDiff = 0.01;   // started under: ignore
    for (let t = step; t <= Math.min(bestDist, maxDist); t += step) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (!this.terrainActive(x, y, z)) { prevT = t; prevDiff = 1; continue; }
      const diff = y - heightAt(x, z);
      if (diff <= 0 && prevDiff > 0) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) * 0.5;
          const mx = ox + dx * mid, my = oy + dy * mid, mz = oz + dz * mid;
          if (my - heightAt(mx, mz) <= 0) hi = mid; else lo = mid;
        }
        tHit = hi;
        break;
      }
      prevT = t; prevDiff = diff;
    }

    if (tHit >= 0 && tHit < bestDist) {
      const x = ox + dx * tHit, y = oy + dy * tHit, z = oz + dz * tHit;
      return { dist: tHit, point: { x, y, z }, normal: normalAt(x, z, new THREE.Vector3()), box: null, terrain: true };
    }
    if (hitBox) {
      const x = ox + dx * bestDist, y = oy + dy * bestDist, z = oz + dz * bestDist;
      return { dist: bestDist, point: { x, y, z }, normal: this._boxNormal(hitBox, x, y, z), box: hitBox, terrain: false };
    }
    return null;
  }

  _rayBoxes(ox, oy, oz, dx, dy, dz, maxDist) {
    // Sample collider cells along the ray. Cheap and good enough at these ranges.
    const out = [];
    const seen = new Set();
    const stepLen = this.grid.cell * 0.7;
    const steps = Math.min(64, Math.ceil(maxDist / stepLen));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * maxDist;
      const x = ox + dx * t, z = oz + dz * t;
      const arr = this.grid.query(x, z, this.grid.cell, this._queryBuf);
      for (const b of arr) {
        if (seen.has(b)) continue;
        seen.add(b);
        out.push(b);
      }
    }
    return out;
  }

  _boxNormal(b, px, py, pz) {
    b.toLocal(px, py, pz, _l);
    const ax = Math.abs(_l.x) / b.hx, ay = Math.abs(_l.y) / b.hy, az = Math.abs(_l.z) / b.hz;
    const n = new THREE.Vector3();
    if (ax > ay && ax > az) n.set(Math.sign(_l.x), 0, 0);
    else if (ay > az) n.set(0, Math.sign(_l.y), 0);
    else n.set(0, 0, Math.sign(_l.z));
    // back to world
    const wx = n.x * b.c - n.z * b.s;
    const wz = n.x * b.s + n.z * b.c;
    return n.set(wx, n.y, wz).normalize();
  }

  /** Fast boolean line-of-sight test (used constantly by AI). */
  losBlocked(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.001) return false;
    const hit = this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.4);
    return !!hit;
  }

  /* -------------------------------------------------------------- update */

  update(dt, playerPos) {
    this._t += dt;
    if (!this.ready) return;

    // Distance culling. Frustum culling handles the rest.
    const vd = WORLD.viewDist, vd2 = vd * vd;
    for (const c of this.chunks) {
      const dx = c.cx - playerPos.x, dz = c.cz - playerPos.z;
      c.mesh.visible = dx * dx + dz * dz < vd2;
    }
    const pd2 = WORLD.propDist * WORLD.propDist;
    for (const cell of this.propCells) {
      const dx = cell.center.x - playerPos.x, dz = cell.center.z - playerPos.z;
      const vis = dx * dx + dz * dz < pd2;
      for (const m of cell.meshes) m.visible = vis;
    }

    if (this.skyDome) this.skyDome.position.set(playerPos.x, 0, playerPos.z);
    if (this.stars) { this.stars.position.set(playerPos.x, 0, playerPos.z); this.stars.rotation.y = this._t * 0.004; }
    if (this.water) this.water.position.set(playerPos.x, WORLD.seaLevel + Math.sin(this._t * 0.6) * 0.12, playerPos.z);
    if (this.hubCore) { this.hubCore.rotation.y = this._t * 0.6; this.hubCore.position.y = this.hubY + 12.4 + Math.sin(this._t * 1.2) * 0.3; }

    // Fog and sky tint follow the region you are standing in.
    const reg = regionAt(playerPos.x, playerPos.z);
    if (reg !== this._lastRegion) this._lastRegion = reg;
    const target = new THREE.Color(reg.fog);
    this.fog.color.lerp(target, 1 - Math.exp(-0.8 * dt));
    if (this.skyDome) this.skyDome.material.uniforms.mid.value.lerp(new THREE.Color(reg.sky), 1 - Math.exp(-0.5 * dt));
    // Underground, pull the fog in tight: the dungeon should feel enclosed.
    const inside = !this.terrainActive(playerPos.x, playerPos.y, playerPos.z);
    this.inside = inside;
    const near = inside ? 2 : 60, far = inside ? 95 : 520;
    this.fog.near = lerp(this.fog.near, near, 1 - Math.exp(-2 * dt));
    this.fog.far = lerp(this.fog.far, far, 1 - Math.exp(-2 * dt));
    if (inside) this.fog.color.lerp(new THREE.Color(0x120a14), 1 - Math.exp(-2 * dt));

    // No point lights underground — swing the ambient instead, so caves stay
    // readable without paying for another shadow-casting light.
    const k = 1 - Math.exp(-2.2 * dt);
    this.sun.intensity = lerp(this.sun.intensity, inside ? 0.12 : 1.35, k);
    this.hemi.intensity = lerp(this.hemi.intensity, inside ? 0.5 : 0.62, k);
    this.hemi.color.lerp(_c1.setHex(inside ? 0x6a4fd0 : 0x9db4ff), k);
    this.hemi.groundColor.lerp(_c1.setHex(inside ? 0x140c1e : 0x3a2e2a), k);
  }

  /** Safe spawn position on the surface near (x,z). */
  surfacePoint(x, z, out = new THREE.Vector3()) {
    return out.set(x, heightAt(x, z), z);
  }
}

const _c1 = new THREE.Color();
const _vTmp = new THREE.Vector3();
const _vTmp2 = new THREE.Vector3();

export const World = new WorldSystem();
export default World;
