/* STARFALL — world.js
   ONE continuous world. There is no "load into an activity": the dungeon is a
   cave you walk into and the raid is a spire you climb. Everything below lives
   in a single scene graph, streamed by distance.

   Terrain is an analytic heightfield (heightAt is a pure function), so bullets,
   AI and physics can query it without touching a mesh. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, fbm, ridged, hash2, makeRNG, rayBox, swapRemove, TAU } from './util.js';
import { buildInteriors } from './interiors.js';

export const WORLD = {
  size: 3600,         // world spans -1800..1800 on x and z
  chunk: 180,         // heightfield mesh chunk size
  chunkRes: 30,       // quads per chunk edge (6 units per quad)
  seaLevel: -7,
  viewDist: 1400,     // terrain draw distance
  propDist: 620,
  buildDist: 1520,    // chunks are meshed inside this and freed outside it
  chunksPerFrame: 1   // one chunk is ~7ms; a sprint needs ~53 per 15s, so 1 keeps up
};

const HALF = WORLD.size / 2;
const NCH = Math.round(WORLD.size / WORLD.chunk);   // chunks per axis (30)

// The dome has to sit outside the far plane's useful range but inside it, and
// the fog has to reach the far towers without erasing them.
export const SKY_R = 9000;
const FOG_FAR = 2600;

/* --------------------------------------------------------------- regions */

export const REGIONS = [
  {
    id: 'rally', name: 'The Rally', x: 0, z: 780, r: 150, safe: true,
    ground: 0x6d6a78, rock: 0x565361, accent: 0x8fd8ff,
    fog: 0x2b3350, sky: 0x1a2140, blurb: 'Last standing outpost, cut into the Descent’s south rim.'
  },
  {
    id: 'descent', name: 'The Descent', x: 0, z: 0, r: 620,
    ground: 0x3b3746, rock: 0x2a2733, accent: 0xffb45c,
    fog: 0x1a1626, sky: 0x0d0a16, blurb: 'The shaft to the core. Eight rings of city, and no bottom you can see.'
  },
  {
    id: 'skyreach', name: 'Skyreach', x: -760, z: 620, r: 460,
    ground: 0x4a4a5c, rock: 0x35354a, accent: 0x6fe0ff,
    fog: 0x232a44, sky: 0x141a30, blurb: 'Towers stacked on towers. The upper lanes still have power.'
  },
  {
    id: 'ashfall', name: 'Ashfall Flats', x: -640, z: 1240, r: 420,
    ground: 0x8a6b4a, rock: 0x6b503a, accent: 0xffa552,
    fog: 0x4a3327, sky: 0x2a1c18, blurb: 'Dunes of powdered rock. Riven scavenger patrols, and the wind never stops.'
  },
  {
    id: 'rift', name: 'Verdant Rift', x: 760, z: 1180, r: 430,
    ground: 0x3f6b3a, rock: 0x39463a, accent: 0x9dff7a,
    fog: 0x22331f, sky: 0x16261c, blurb: 'A drowned canyon gone green. The Riven drop hardest here.'
  },
  {
    id: 'frost', name: 'Frost Spire Reach', x: -880, z: -760, r: 450,
    ground: 0xa9bacb, rock: 0x5d6a7a, accent: 0x9fe8ff,
    fog: 0x53627a, sky: 0x27334a, blurb: 'Highlands under permanent snow. Marksmen hold the ridges.'
  },
  {
    id: 'maw', name: 'The Maw', x: 900, z: -820, r: 400,
    ground: 0x4a3038, rock: 0x33232a, accent: 0xff5d3c,
    fog: 0x3a1a18, sky: 0x1e0f10, blurb: 'A crater burned into the shore. Something sings underneath it.'
  },
  {
    id: 'spire', name: 'The Sundered Sky', x: 0, z: -1320, r: 380,
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
export const MAW = { x: 900, z: -820, r: 118, depth: 46 };
export const DUNGEON_MOUTH = { x: MAW.x - 74, z: MAW.z + 26 };
// The raid spire: a 165-unit tower you can see from spawn.
export const SPIRE = { x: 0, z: -1320, r: 92, height: 168 };
export const LOST_SECTOR = { x: -700, z: -320 };

/* The Descent: a shaft bored to the core, ringed by eight terraces of city.
   The terrain only makes the funnel — the rings, the spiral road and the towers
   are built geometry, because you have to be able to walk down it. */
export const PIT = {
  x: 0, z: 0,
  r: 620,             // where the funnel meets the surface
  floorR: 150,        // the flat floor the road lands on
  depth: 780,         // rim to the lowest ring
  rings: 8,
  rimLip: 26,
  wallExp: 0.55
};

/** The Rally plateau sits level with the pit apron, on the rim. */
export const HUB_Y = 42;

/** Height of the funnel wall at a distance from the pit centre. */
export function pitProfile(d) {
  if (d >= PIT.r) return 0;
  if (d <= PIT.floorR) return -PIT.depth;
  const t = (PIT.r - d) / (PIT.r - PIT.floorR);   // 0 at rim, 1 at the shaft
  /* Exponent below 1 on purpose. Above 1 gives a saucer that only plunges in
     the middle, and from the rim you see a wide shallow bowl instead of a
     shaft. This drops hard at the edge and then opens out, so the wall reads
     as a cliff the moment you step off. */
  return -PIT.depth * Math.pow(t, PIT.wallExp);
}

/* -------------------------------------------------------------- height   */

let SEED = 1337;

/** Pure analytic terrain height. Everything in the game trusts this. */
export function heightAt(x, z) {
  const s = SEED;
  // Long wavelengths for a world this size, or it reads as noise up close and
  // as flat nothing from the rim of the Descent.
  let h = fbm(x * 0.00052, z * 0.00052, { octaves: 5, seed: s }) * 74;
  h += fbm(x * 0.0017, z * 0.0017, { octaves: 4, seed: s + 91 }) * 22;
  h += fbm(x * 0.0062, z * 0.0062, { octaves: 3, seed: s + 411 }) * 6.5;
  h += fbm(x * 0.021, z * 0.021, { octaves: 2, seed: s + 733 }) * 1.6;

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

  /* The Descent. Everything else is decoration next to this: a funnel 620 wide
     that drops 780 to an open shaft. The lip is raised so you see the edge
     before you walk off it, and the walls outside the rim are pushed up so the
     pit reads as bored through a plateau rather than dented into a plain. */
  const dp = Math.hypot(x - PIT.x, z - PIT.z);
  if (dp < PIT.r * 2.1) {
    const apron = 1 - smoothstep(clamp01((dp - PIT.r) / (PIT.r * 1.05)));
    h = lerp(h, h * 0.25 + 34, apron * 0.85);
    if (dp < PIT.r) {
      const lip = PIT.rimLip * Math.exp(-Math.pow((dp - PIT.r * 0.985) / (PIT.r * 0.035), 2));
      h = h + pitProfile(dp) + lip;
    } else {
      h += PIT.rimLip * Math.exp(-Math.pow((dp - PIT.r * 0.985) / (PIT.r * 0.05), 2));
    }
  }

  // The Rally: flatten a plateau so the hub reads as built, not grown. It sits
  // level with the pit apron so the outpost reads as cut into the rim.
  const dr = Math.hypot(x - REGION_BY_ID.rally.x, z - REGION_BY_ID.rally.z);
  if (dr < 190) {
    const flat = 1 - smoothstep(clamp01((dr - 92) / 88));
    h = lerp(h, HUB_Y, flat);
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
  /* World point -> box local space.

     This has to be the exact inverse of what THREE does for `mesh.rotation.y`,
     which sends local +X to world (cos, 0, -sin). Using R(+yaw) here instead of
     R(-yaw) rotates every collider the opposite way from the box you can see —
     harmless for a square or a right angle, badly wrong for a long box at an
     arbitrary angle, which is most of the hub, the raid cover and the pit road. */
  toLocal(px, py, pz, out) {
    const dx = px - this.x, dz = pz - this.z;
    out.x = dx * this.c - dz * this.s;
    out.y = py - this.y;
    out.z = dx * this.s + dz * this.c;
    return out;
  }
  containsXZ(px, pz, pad = 0) {
    const dx = px - this.x, dz = pz - this.z;
    const lx = dx * this.c - dz * this.s;
    const lz = dx * this.s + dz * this.c;
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
    this.chunkMap = new Map();
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

    /* A 3600-unit world is 900 chunks. Meshing them all costs half a million
       heightAt calls and ~40MB of buffers for terrain you cannot see, so only
       the ring around the player is ever resident — update() pages the rest in
       as you walk. Seed the spawn ring here so the first frame is complete. */
    const spawn = REGION_BY_ID.rally;
    const seedR = Math.ceil(WORLD.buildDist / WORLD.chunk);
    const sc = this._chunkCoord(spawn.x, spawn.z);
    let done = 0;
    const wanted = [];
    for (let cx = sc.cx - seedR; cx <= sc.cx + seedR; cx++) {
      for (let cz = sc.cz - seedR; cz <= sc.cz + seedR; cz++) {
        if (cx < 0 || cz < 0 || cx >= NCH || cz >= NCH) continue;
        const c = this._chunkCenter(cx, cz);
        if (Math.hypot(c.x - spawn.x, c.z - spawn.z) > WORLD.buildDist) continue;
        wanted.push([cx, cz]);
      }
    }
    for (const [cx, cz] of wanted) {
      this._buildChunk(cx, cz);
      if (++done % 24 === 0) yield { msg: 'Raising terrain', p: 0.02 + 0.6 * (done / wanted.length) };
    }
    yield { msg: 'Raising terrain', p: 0.62 };

    yield { msg: 'Seeding the wilds', p: 0.66 };
    this._buildProps();

    yield { msg: 'Building the Rally', p: 0.74 };
    this._buildHub();
    this._buildLandmarks();

    yield { msg: 'Sinking the Descent', p: 0.80 };
    this._buildPit();
    this._flushStrips(this.pitGroup);

    yield { msg: 'Raising the skyline', p: 0.86 };
    this._buildCity();
    this._flushStrips();

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
      glowWarm: new THREE.MeshBasicMaterial({ color: 0xffb45c, fog: false }),
      vex: new THREE.MeshLambertMaterial({ color: 0x4b4468, emissive: 0x160f28, flatShading: true }),
      /* Lit windows and pit lighting. Basic (unlit) so they stay bright at the
         bottom of a 780-unit hole where nothing else reaches, and fog:false so
         they punch through it — with fog on, everything more than a couple of
         rings down washes to a flat purple and the shaft loses all its depth.
         Night city lights genuinely do read through haze, so this is the
         physical answer as well as the legible one. */
      window: new THREE.MeshBasicMaterial({ color: 0xffc978, fog: false }),
      windowCool: new THREE.MeshBasicMaterial({ color: 0x8fd8ff, fog: false }),
      pitRing: new THREE.MeshBasicMaterial({ color: 0xff8a3c, fog: false }),
      pitCore: new THREE.MeshBasicMaterial({ color: 0xffd08a, fog: false }),
      cityFar: new THREE.MeshLambertMaterial({ color: 0x2c3040, flatShading: true })
    };
  }

  _sky() {
    const scene = this.scene;
    /* One dome, one shader, no textures — the page has to stay a single
       dependency-free download. Everything here is analytic: a three-stop
       gradient, a sun with a halo, banded nebula from value noise, a ringed
       planet on the horizon, and a warm bloom off the Descent so the city
       lights the underside of the sky. */
    const geo = new THREE.SphereGeometry(SKY_R, 48, 32);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x070a1c) },
        mid: { value: new THREE.Color(0x1a2140) },
        bot: { value: new THREE.Color(0x6b3f4a) },
        nebulaA: { value: new THREE.Color(0x6a3f8f) },
        nebulaB: { value: new THREE.Color(0x1f5f86) },
        sunDir: { value: new THREE.Vector3(0.42, 0.22, -0.88).normalize() },
        planetDir: { value: new THREE.Vector3(-0.72, 0.13, 0.68).normalize() },
        glowDir: { value: new THREE.Vector3(0, -1, 0) },
        glowColor: { value: new THREE.Color(0xff8a3c) },
        glowAmt: { value: 0.0 },
        time: { value: 0 }
      },
      vertexShader: `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top, mid, bot, nebulaA, nebulaB;
        uniform vec3 sunDir, planetDir, glowDir, glowColor;
        uniform float glowAmt, time;
        varying vec3 vDir;

        float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float noise(vec3 p){
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float n = mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                            mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                        mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                            mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
          return n;
        }
        float fbm(vec3 p){
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; }
          return v;
        }

        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);

          // Base gradient, with a tight warm band right at the horizon.
          vec3 c = mix(bot, mid, smoothstep(0.40, 0.60, h));
          c = mix(c, top, smoothstep(0.58, 0.96, h));
          float horizon = exp(-pow((h - 0.5) * 14.0, 2.0));
          c += bot * horizon * 0.35;

          // Nebula: two tinted bands of fbm, faded out near the horizon so it
          // never fights the terrain silhouette.
          float n = fbm(d * 2.6 + vec3(0.0, time * 0.004, 0.0));
          float n2 = fbm(d * 5.1 - vec3(time * 0.003, 0.0, 0.0));
          float band = smoothstep(0.52, 0.95, h);
          c += nebulaA * pow(max(n - 0.42, 0.0), 1.6) * 1.5 * band;
          c += nebulaB * pow(max(n2 - 0.5, 0.0), 1.8) * 1.1 * band;

          // Stars punched through the nebula, denser high up.
          float sp = fbm(d * 190.0);
          float star = smoothstep(0.79, 0.84, sp) * band;
          float tw = 0.72 + 0.28 * sin(time * 2.1 + sp * 90.0);
          c += vec3(0.85, 0.9, 1.0) * star * tw * 0.9;

          // Sun: hard disc, soft halo, and a wide warm wash.
          float sd = max(dot(d, sunDir), 0.0);
          c += vec3(1.0, 0.78, 0.52) * (pow(sd, 900.0) * 3.4 + pow(sd, 24.0) * 0.30 + pow(sd, 4.0) * 0.07);

          // A ringed planet, because the sky is the one place you can put
          // something this big and have it cost nothing.
          float pd = dot(d, planetDir);
          float disc = smoothstep(0.9975, 0.9982, pd);
          vec3 pcol = mix(vec3(0.42, 0.30, 0.46), vec3(0.72, 0.55, 0.48),
                          fbm(d * 34.0 + 11.0));
          // Terminator: lit from the sun side.
          float lit = clamp(dot(normalize(sunDir - planetDir * 0.2), d) * 3.0 + 0.55, 0.06, 1.0);
          c = mix(c, pcol * lit, disc);
          float ring = smoothstep(0.9955, 0.9962, pd) * (1.0 - disc);
          c = mix(c, vec3(0.75, 0.66, 0.58) * lit, ring * 0.75);

          // The Descent throwing light up into the haze.
          float gd = max(dot(d, glowDir), 0.0);
          c += glowColor * pow(gd, 3.0) * glowAmt;

          gl_FragColor = vec4(c, 1.0);
        }`
    });
    this.skyDome = new THREE.Mesh(geo, mat);
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -100;
    scene.add(this.skyDome);
    this.skyMat = mat;

    this.sun = new THREE.DirectionalLight(0xffd9b0, 1.35);
    this.sun.position.set(220, 180, -420);
    scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x9db4ff, 0x3a2e2a, 0.62);
    scene.add(this.hemi);
    this.fog = new THREE.Fog(0x2b3350, 120, FOG_FAR);
    scene.fog = this.fog;
  }

  _water() {
    /* A ring, not a plane, and it does not follow the player. A full plane at
       sea level roofs straight over the Descent — from the overlook you see a
       flat sheet where the shaft should be, which is what "the pit isn't
       visible" turned out to be. The hole is cut wider than the rim so the
       edge is always hidden inside the funnel wall. */
    const g = new THREE.RingGeometry(PIT.r + 30, WORLD.size * 0.78, 96, 1);
    g.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      color: 0x1d3a52, transparent: true, opacity: 0.72, emissive: 0x08131e,
      side: THREE.DoubleSide
    }));
    this.water.position.set(PIT.x, WORLD.seaLevel, PIT.z);
    this.water.renderOrder = -1;
    this.scene.add(this.water);
  }

  /* -------------------------------------------------------------- chunks */

  _chunkCoord(x, z) {
    return {
      cx: clamp(Math.floor((x + HALF) / WORLD.chunk), 0, NCH - 1),
      cz: clamp(Math.floor((z + HALF) / WORLD.chunk), 0, NCH - 1)
    };
  }
  _chunkCenter(cx, cz) {
    return { x: -HALF + (cx + 0.5) * WORLD.chunk, z: -HALF + (cz + 0.5) * WORLD.chunk };
  }

  /** Page terrain in and out around the player. Cheap enough to run every frame. */
  _streamChunks(playerPos) {
    const cs = WORLD.chunk;
    const build2 = WORLD.buildDist * WORLD.buildDist;
    // Hysteresis: free further out than we build, so standing on a boundary
    // does not thrash a chunk in and out every frame.
    const free2 = Math.pow(WORLD.buildDist * 1.25, 2);

    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      const dx = c.cx - playerPos.x, dz = c.cz - playerPos.z;
      if (dx * dx + dz * dz > free2) {
        this.scene.remove(c.mesh);
        c.mesh.geometry.dispose();
        this.chunkMap.delete(c.key);
        swapRemove(this.chunks, i);
      }
    }

    const here = this._chunkCoord(playerPos.x, playerPos.z);
    const r = Math.ceil(WORLD.buildDist / cs);
    let budget = WORLD.chunksPerFrame;
    // Nearest-first, so what you are walking toward exists before the far ring.
    for (let ring = 0; ring <= r && budget > 0; ring++) {
      for (let cx = here.cx - ring; cx <= here.cx + ring && budget > 0; cx++) {
        for (let cz = here.cz - ring; cz <= here.cz + ring && budget > 0; cz++) {
          // Only the newly added shell of this ring.
          if (ring > 0 && Math.abs(cx - here.cx) !== ring && Math.abs(cz - here.cz) !== ring) continue;
          if (cx < 0 || cz < 0 || cx >= NCH || cz >= NCH) continue;
          const key = cx * NCH + cz;
          if (this.chunkMap.has(key)) continue;
          const c = this._chunkCenter(cx, cz);
          const dx = c.x - playerPos.x, dz = c.z - playerPos.z;
          if (dx * dx + dz * dz > build2) continue;
          this._buildChunk(cx, cz);
          budget--;
        }
      }
    }
  }

  _buildChunk(cx, cz) {
    const key = cx * NCH + cz;
    if (this.chunkMap.has(key)) return;
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
    const rec = { mesh, key, cx: ox + size / 2, cz: oz + size / 2 };
    this.chunks.push(rec);
    this.chunkMap.set(key, rec);
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
    // The Rally sits on the Descent's south rim, not at the origin — the origin
    // is a 780-unit hole now.
    const HX = REGION_BY_ID.rally.x, HZ = REGION_BY_ID.rally.z;
    const y = heightAt(HX, HZ);
    this.hubY = y;
    this.hubX = HX; this.hubZ = HZ;

    // Landing pad + ring wall.
    this.addStructure(HX, y - 0.35, HZ, 74, 1.1, 74, { mat: 'metalDark', tag: 'floor', parent: g });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = 36;
      this.addStructure(HX + Math.cos(a) * r, y + 1.6, HZ + Math.sin(a) * r, 6, 3.2, 1.6, { yaw: -a, mat: 'metal', tag: 'wall', parent: g });
    }
    // Central transmat obelisk — the visual anchor of the hub.
    this.addStructure(HX, y + 5, HZ, 4, 10, 4, { mat: 'metalDark', tag: 'obelisk', parent: g });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 1), this.mat.glow);
    core.position.set(HX, y + 12.4, HZ);
    g.add(core);
    this.hubCore = core;

    // Vendor kiosks: gunsmith / quartermaster / cryptarch.
    const kiosks = [
      { id: 'gunsmith', name: 'Gunsmith Vell', a: 0.4, color: 0xff8a4c },
      { id: 'quartermaster', name: 'Quartermaster Ryn', a: 2.5, color: 0x6fe0ff },
      { id: 'cryptarch', name: 'Cryptarch Ossa', a: 4.4, color: 0xc39dff }
    ];
    for (const k of kiosks) {
      const x = HX + Math.cos(k.a) * 22, z = HZ + Math.sin(k.a) * 22;
      this.addStructure(x, y + 1.3, z, 3.4, 2.6, 2.2, { yaw: -k.a, mat: 'metal', tag: 'kiosk', parent: g });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color: k.color }));
      lamp.position.set(x, y + 3.2, z);
      g.add(lamp);
      this.addPOI({ id: k.id, name: k.name, kind: 'vendor', x, y: y + 1.4, z, r: 3.6, color: k.color });
    }

    this.addPOI({ id: 'rally', name: 'The Rally', kind: 'travel', x: HX, y: y + 1, z: HZ + 6, r: 5, color: 0x8fd8ff, discovered: true });

    /* The overlook. A pier runs from the pad out past the rim lip and stops in
       mid-air 300 units above the funnel wall — you spawn on the tip of it, so
       the first thing a new guardian sees is the shaft falling away underneath
       them. Standing back on the rim you see a horizon; standing on a wide
       deck you see the deck. It has to be a narrow pier, and you have to be at
       the end of it. */
    const TIP = PIT.z + PIT.r - 84;         // well past the lip, over the void
    const BACK = HZ - 40;
    const oy = y + 2.5;
    this.addStructure(HX, oy - 1.2, (BACK + TIP) / 2, 22, 2.0, BACK - TIP,
      { mat: 'metalDark', tag: 'floor', parent: g });
    // Side rails stop short of the tip so nothing frames the drop itself.
    for (const sx of [-11, 11]) {
      this.addStructure(HX + sx, oy + 1.3, (BACK + TIP) / 2 + 12, 1.4, 2.6, BACK - TIP - 24,
        { mat: 'metal', tag: 'rail', parent: g });
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.4, 1.8), this.mat.glow);
      lamp.position.set(HX + sx, oy + 0.5, TIP + 10);
      lamp.matrixAutoUpdate = false; lamp.updateMatrix();
      g.add(lamp);
    }
    // A kerb, not a rail: at the lip even a waist-high rail sits across the
    // exact part of the screen the drop is supposed to fill.
    this.addStructure(HX, oy + 0.2, TIP + 0.6, 22, 0.4, 1.2, { mat: 'metal', tag: 'rail', parent: g });
    this.overlook = new THREE.Vector3(HX, oy, TIP + 8);
    this.spawnPoint = new THREE.Vector3(HX, oy + 0.4, TIP + 4);
  }

  /* Lit window bands are the single most numerous thing in the skyline — one
     per band per tower, thousands of them. As individual meshes they cost more
     draw calls than the entire rest of the world, and they never move, so they
     get collected during the build and flushed into one InstancedMesh each. */
  _strip(matName, x, y, z, yaw, sx, sy, sz) {
    this._strips = this._strips || new Map();
    let list = this._strips.get(matName);
    if (!list) { list = []; this._strips.set(matName, list); }
    list.push([x, y, z, yaw, sx, sy, sz]);
  }

  _flushStrips(parent) {
    if (!this._strips) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const [matName, list] of this._strips) {
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(geo, this.mat[matName], list.length);
      for (let i = 0; i < list.length; i++) {
        const [x, y, z, yaw, sx, sy, sz] = list[i];
        q.setFromAxisAngle(up, yaw);
        m.compose(pos.set(x, y, z), q, scl.set(sx, sy, sz));
        inst.setMatrixAt(i, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      (parent || this.scene).add(inst);
    }
    this._strips.clear();
  }

  /* ------------------------------------------------------------- city    */

  /* The skyline around the rim. Two tiers: near towers are real geometry with
     colliders you can fight around; everything past that is one InstancedMesh
     of silhouettes, which is what makes a horizon of towers affordable. */
  _buildCity() {
    const g = new THREE.Group();
    this.scene.add(g);
    const rng = makeRNG(SEED + 909);
    const hub = REGION_BY_ID.rally;

    const near = [];
    const far = [];
    const RING_IN = PIT.r + 70, RING_OUT = PIT.r + 1080;

    for (let i = 0; i < 1500; i++) {
      const a = rng() * TAU;
      // Bias toward the rim: the city is densest where the Descent is.
      const t = Math.pow(rng(), 1.7);
      const rad = lerp(RING_IN, RING_OUT, t);
      const x = PIT.x + Math.cos(a) * rad, z = PIT.z + Math.sin(a) * rad;
      // Keep the hub plaza, the spire and the Maw clear of skyscrapers.
      if (Math.hypot(x - hub.x, z - hub.z) < 210) continue;
      if (Math.hypot(x - SPIRE.x, z - SPIRE.z) < SPIRE.r * 2.2) continue;
      if (Math.hypot(x - MAW.x, z - MAW.z) < MAW.r * 1.9) continue;
      const y = heightAt(x, z);
      if (y < WORLD.seaLevel + 3) continue;
      const closeness = 1 - t;
      const h = lerp(34, 300, Math.pow(closeness, 1.35) * (0.45 + rng() * 0.75));
      const w = lerp(12, 46, rng()) * (0.6 + closeness * 0.7);
      const d = w * (0.65 + rng() * 0.7);
      const rec = { x, y, z, w, h, d, yaw: rng() * TAU, lit: rng() < 0.72 };
      if (rad < PIT.r + 420) near.push(rec); else far.push(rec);
    }

    for (const b of near) {
      this.addStructure(b.x, b.y + b.h / 2, b.z, b.w, b.h, b.d,
        { yaw: b.yaw, mat: 'metalDark', tag: 'tower', parent: g });
      if (!b.lit) continue;
      const bands = Math.max(1, Math.floor(b.h / 34));
      for (let k = 0; k < bands; k++) {
        this._strip(k % 3 === 0 ? 'windowCool' : 'window',
          b.x, b.y + 12 + (k / bands) * (b.h - 16), b.z, b.yaw,
          b.w * 1.02, 1.6, b.d * 0.72);
      }
    }

    if (far.length) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const inst = new THREE.InstancedMesh(geo, this.mat.cityFar, far.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < far.length; i++) {
        const b = far[i];
        q.setFromAxisAngle(up, b.yaw);
        m.compose(new THREE.Vector3(b.x, b.y + b.h / 2, b.z), q, new THREE.Vector3(b.w, b.h, b.d));
        inst.setMatrixAt(i, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = true;
      g.add(inst);
      this.cityFar = inst;
    }
    this.cityGroup = g;
  }

  /* ------------------------------------------------------------ the pit  */

  /** Terrain height just outside the rim — the road's zero. */
  get pitRimY() {
    if (this._pitRimY == null) this._pitRimY = heightAt(PIT.x + PIT.r + 60, PIT.z);
    return this._pitRimY;
  }

  /** Radius of the open shaft at a given depth below the rim. */
  _shaftRadius(depth) {
    const t = Math.pow(clamp01(depth / PIT.depth), 1 / PIT.wallExp);
    return PIT.r - t * (PIT.r - PIT.floorR);
  }

  /* Where the spiral road is, `turn` counting revolutions from the rim.

     The road is a viaduct, not a shelf: it hangs in the open air of the shaft
     rather than following the wall, because the wall averages 56° and no
     gradient cut into it would be walkable. Radius is derived from the shaft
     profile at the road's own depth, so it can never end up buried in rock —
     which is exactly what a linear descent did. */
  _roadAt(turn) {
    const u = clamp01(turn / PIT.rings);
    const depth = u * PIT.depth;
    // Always strictly inside the shaft, or the deck ends up embedded in the
    // wall near the throat where the funnel closes fastest.
    const shaft = this._shaftRadius(depth);
    const r = Math.max(30, Math.min(shaft * 0.86, shaft - 16));
    const a = turn * TAU + 0.6;
    return {
      x: PIT.x + Math.cos(a) * r,
      z: PIT.z + Math.sin(a) * r,
      y: this.pitRimY - depth,
      r, a, u, depth
    };
  }

  /* The Descent is the whole point of the skyline, so it is built, not noised:
     a spiral road you can actually walk from the rim to the shaft, eight ring
     terraces hung off it, towers growing out of the walls, and a core at the
     bottom that lights the entire hole from below. */
  _buildPit() {
    const g = new THREE.Group();
    this.scene.add(g);
    this.pitGroup = g;
    const rng = makeRNG(SEED + 4242);

    const ROAD_W = 26;
    const SEGS = 64;                       // segments per revolution
    const total = PIT.rings * SEGS;

    // --- the spiral road -------------------------------------------------
    for (let i = 0; i < total; i++) {
      const a0 = this._roadAt(i / SEGS);
      const a1 = this._roadAt((i + 1) / SEGS);
      const mx = (a0.x + a1.x) / 2, mz = (a0.z + a1.z) / 2, my = (a0.y + a1.y) / 2;
      const len = Math.hypot(a1.x - a0.x, a1.z - a0.z) * 1.12;
      const yaw = -Math.atan2(a1.z - a0.z, a1.x - a0.x);
      this.addStructure(mx, my - 1.2, mz, len, 2.4, ROAD_W,
        { yaw, mat: 'metalDark', tag: 'road', parent: g });
      // Outer kerb, so you can see the edge before you step off it.
      if (i % 2 === 0) {
        const ox = mx + Math.cos(a0.a) * (ROAD_W / 2 - 1), oz = mz + Math.sin(a0.a) * (ROAD_W / 2 - 1);
        this.addStructure(ox, my + 0.7, oz, len, 1.4, 1.4, { yaw, mat: 'metal', tag: 'kerb', parent: g });
      }
      // Lane lighting every so often — this is what makes it read at distance.
      if (i % 4 === 0) {
        this._strip('glowWarm',
          mx - Math.cos(a0.a) * (ROAD_W / 2 - 2), my + 0.4, mz - Math.sin(a0.a) * (ROAD_W / 2 - 2),
          yaw, len * 0.7, 0.4, 1.2);
      }
    }

    // --- support pylons ---------------------------------------------------
    // The viaduct has to look held up. Drop a leg to the wall every half turn.
    for (let i = 0; i < PIT.rings * 2; i++) {
      const p = this._roadAt(i / 2 + 0.25);
      const wallR = this._shaftRadius(p.depth);
      const wallY = this.pitRimY - p.depth;
      const legLen = Math.max(10, (wallR - p.r) * 1.15);
      const mx = p.x + Math.cos(p.a) * legLen * 0.5;
      const mz = p.z + Math.sin(p.a) * legLen * 0.5;
      this.addStructure(mx, wallY - 1.5, mz, legLen, 3.4, 5,
        { yaw: -p.a, mat: 'metal', tag: 'pylon', parent: g });
    }

    // --- ring terraces and the city that hangs off them -------------------
    const TOWER_MATS = ['metalDark', 'metal', 'hull'];
    for (let ring = 0; ring < PIT.rings; ring++) {
      const plats = 5 + ring;
      for (let k = 0; k < plats; k++) {
        // Anchor each platform to a point ON the road, then push it outward
        // toward the wall so it reads as a district built off the highway.
        const turn = ring + (k + 0.5) / plats;
        const p = this._roadAt(turn);
        const wallR = this._shaftRadius(p.depth);
        const out = Math.min(wallR - 6, p.r + 14 + rng() * 26);
        if (out <= p.r + 4) continue;
        const px = PIT.x + Math.cos(p.a) * out, pz = PIT.z + Math.sin(p.a) * out;
        const py = p.y;
        const w = 22 + rng() * 26, d = 18 + rng() * 20;
        this.addStructure(px, py - 1.4, pz, w, 2.2, d, { yaw: -p.a, mat: 'metalDark', tag: 'terrace', parent: g });

        // A tower on most of them. They grow UP out of the pit wall, which is
        // what sells the depth when you look across the shaft.
        if (rng() < 0.82) {
          const th = 26 + rng() * 120;
          const tw = Math.min(w * 0.62, 9 + rng() * 12);
          const mat = TOWER_MATS[(rng() * TOWER_MATS.length) | 0];
          this.addStructure(px, py + th / 2, pz, tw, th, tw * (0.7 + rng() * 0.6),
            { yaw: -p.a, mat, tag: 'tower', parent: g });
          const bands = Math.max(2, Math.floor(th / 16));
          for (let b = 0; b < bands; b++) {
            this._strip('window', px, py + 8 + (b / bands) * (th - 10), pz, -p.a,
              tw * 1.02, 1.1, tw * 0.74);
          }
          this._strip('glowWarm', px, py + th + 2.5, pz, 0, 1.1, 5, 1.1);
        }
      }

      // A ring of light around the shaft at every level: the stack of glowing
      // circles receding into the dark is the whole image.
      const lvl = this._roadAt(ring);
      const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(this._shaftRadius(lvl.depth) - 2, 1.1, 5, 96), this.mat.pitRing);
      ringMesh.rotation.x = Math.PI / 2;
      ringMesh.position.set(PIT.x, lvl.y + 1.5, PIT.z);
      ringMesh.matrixAutoUpdate = false; ringMesh.updateMatrix();
      g.add(ringMesh);
    }

    /* --- wall seams -------------------------------------------------------
       Without these the shaft is a black hole with a few orange rings floating
       in it: the wall faces away from the sun, so between the rings there is
       nothing for the eye to measure depth against. Lit seams running the full
       drop give the wall a scale and make the bottom feel far away rather than
       simply dark. They are batched, so 30 seams cost one draw call. */
    const SEAMS = 30;
    for (let sIdx = 0; sIdx < SEAMS; sIdx++) {
      const a = (sIdx / SEAMS) * TAU + 0.21;
      const steps = 30;
      for (let k = 1; k <= steps; k++) {
        const depth = (k / steps) * PIT.depth;
        const wr = this._shaftRadius(depth) - 1.5;
        const x = PIT.x + Math.cos(a) * wr, z = PIT.z + Math.sin(a) * wr;
        // Alternate warm and cool so the wall reads as inhabited, not a strip light.
        const cool = (sIdx + k) % 5 === 0;
        this._strip(cool ? 'windowCool' : 'window', x, this.pitRimY - depth, z, -a,
          1.6, 3.2 + (k % 3) * 1.4, 5.5);
      }
    }

    // --- the core --------------------------------------------------------
    const floorY = this._roadAt(PIT.rings).y - 26;
    this.addStructure(PIT.x, floorY - 3, PIT.z, PIT.floorR * 2.1, 6, PIT.floorR * 2.1,
      { mat: 'metalDark', tag: 'pitfloor', parent: g });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(PIT.floorR * 0.44, 2), this.mat.pitCore);
    core.position.set(PIT.x, floorY + PIT.floorR * 0.4, PIT.z);
    g.add(core);
    this.pitCore = core;
    this.pitFloorY = floorY;

    // A light down there so the bottom is lit from inside the hole.
    const coreLight = new THREE.PointLight(0xff9a3c, 3.2, PIT.depth * 1.4, 1.4);
    coreLight.position.set(PIT.x, floorY + 40, PIT.z);
    g.add(coreLight);
    this.pitLight = coreLight;

    this.addPOI({
      id: 'descent', name: 'The Descent', kind: 'travel',
      x: this._roadAt(0.04).x, y: this._roadAt(0.04).y + 1, z: this._roadAt(0.04).z,
      r: 7, color: 0xffb45c
    });
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
      const lx = rx * b.c - rz * b.s, lz = rx * b.s + rz * b.c;
      const ly = oy - b.y;
      const ldx = dx * b.c - dz * b.s, ldz = dx * b.s + dz * b.c;
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
    // back to world (transpose of toLocal's rotation)
    const wx = n.x * b.c + n.z * b.s;
    const wz = -n.x * b.s + n.z * b.c;
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

    // Page terrain around the player, then distance-cull what is resident.
    // Frustum culling handles the rest.
    this._streamChunks(playerPos);
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

    if (this.skyDome) this.skyDome.position.set(playerPos.x, playerPos.y, playerPos.z);
    if (this.water) this.water.position.y = WORLD.seaLevel + Math.sin(this._t * 0.6) * 0.12;
    if (this.hubCore) { this.hubCore.rotation.y = this._t * 0.6; this.hubCore.position.y = this.hubY + 12.4 + Math.sin(this._t * 1.2) * 0.3; }
    if (this.pitCore) {
      this.pitCore.rotation.y = this._t * 0.12;
      this.pitCore.rotation.x = Math.sin(this._t * 0.2) * 0.12;
      const pulse = 0.85 + Math.sin(this._t * 0.9) * 0.15;
      if (this.pitLight) this.pitLight.intensity = 3.2 * pulse;
    }

    // Fog and sky tint follow the region you are standing in.
    const reg = regionAt(playerPos.x, playerPos.z);
    if (reg !== this._lastRegion) this._lastRegion = reg;
    const target = new THREE.Color(reg.fog);
    this.fog.color.lerp(target, 1 - Math.exp(-0.8 * dt));
    if (this.skyMat) {
      const u = this.skyMat.uniforms;
      u.mid.value.lerp(_c1.setHex(reg.sky), 1 - Math.exp(-0.5 * dt));
      u.time.value = this._t;
      // Near the Descent the sky picks up the glow coming out of the hole.
      const dPit = Math.hypot(playerPos.x - PIT.x, playerPos.z - PIT.z);
      const wantGlow = clamp01(1 - dPit / (PIT.r * 2.4)) * 0.5;
      u.glowAmt.value = lerp(u.glowAmt.value, wantGlow, 1 - Math.exp(-1.5 * dt));
      // Point the bloom at the pit, so it sits in the right part of the sky.
      if (dPit > 1) {
        _vTmp.set(PIT.x - playerPos.x, -Math.max(40, playerPos.y - this.pitFloorY) * 0.5, PIT.z - playerPos.z).normalize();
        u.glowDir.value.lerp(_vTmp, 1 - Math.exp(-2 * dt));
      }
    }
    // Underground, pull the fog in tight: the dungeon should feel enclosed.
    const inside = !this.terrainActive(playerPos.x, playerPos.y, playerPos.z);
    this.inside = inside;
    const near = inside ? 2 : 120, far = inside ? 95 : FOG_FAR;
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
