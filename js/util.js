/* STARFALL — util.js
   Math, seeded noise, small data structures. No Three.js in here on purpose:
   everything below is plain numbers so it can be unit-tested in bare Node. */

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invlerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = t => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = t => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };

/** Framerate-independent exponential approach. rate = "how much closes per second". */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export const sign = v => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const deg = r => (r * 180) / Math.PI;
export const rad = d => (d * Math.PI) / 180;

/** Shortest signed angle from a to b, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export function approachAngle(a, b, maxStep) {
  const d = angleDelta(a, b);
  return a + clamp(d, -maxStep, maxStep);
}

export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export const distSq3 = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

/* ---------------------------------------------------------------- random */

/** mulberry32 — small, fast, seedable. Same seed => same world, every time. */
export function makeRNG(seed) {
  let a = (seed >>> 0) || 1;
  const r = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.int = (lo, hi) => Math.floor(lo + r() * (hi - lo + 1));
  r.pick = arr => arr[Math.floor(r() * arr.length) % arr.length];
  r.chance = p => r() < p;
  r.sign = () => (r() < 0.5 ? -1 : 1);
  /** Weighted pick: entries is [[value, weight], ...]. */
  r.weighted = entries => {
    let total = 0;
    for (const e of entries) total += e[1];
    let n = r() * total;
    for (const e of entries) { n -= e[1]; if (n <= 0) return e[0]; }
    return entries[entries.length - 1][0];
  };
  r.shuffle = arr => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };
  return r;
}

/** Deterministic hash of two ints -> [0,1). Used for per-cell decisions. */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ----------------------------------------------------------------- noise */

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Value noise, seeded, tileless. Returns roughly [-1, 1]. */
export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = lerp(a, b, u), bot = lerp(c, d, u);
  return lerp(top, bot, v) * 2 - 1;
}

/** Fractal brownian motion over value noise. */
export function fbm(x, y, { octaves = 4, freq = 1, amp = 1, lacunarity = 2.03, gain = 0.5, seed = 0 } = {}) {
  let sum = 0, a = amp, f = freq, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * f, y * f, seed + i * 1013) * a;
    norm += a;
    f *= lacunarity;
    a *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Ridged noise — makes mountain spines instead of rolling hills. */
export function ridged(x, y, { octaves = 4, freq = 1, seed = 0 } = {}) {
  let sum = 0, a = 1, f = freq, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * f, y * f, seed + i * 733));
    sum += n * n * a;
    norm += a;
    f *= 2.07;
    a *= 0.5;
  }
  return norm > 0 ? sum / norm : 0;
}

/* ------------------------------------------------------------ containers */

/** Fixed-size ring of reusable objects. Never allocates during play. */
export class Pool {
  constructor(size, factory) {
    this.items = new Array(size);
    for (let i = 0; i < size; i++) this.items[i] = factory(i);
    this.head = 0;
  }
  next() {
    const it = this.items[this.head];
    this.head = (this.head + 1) % this.items.length;
    return it;
  }
  forEach(fn) { for (let i = 0; i < this.items.length; i++) fn(this.items[i], i); }
}

/** Swap-remove: O(1) removal when order does not matter. */
export function swapRemove(arr, i) {
  const last = arr.length - 1;
  if (i !== last) arr[i] = arr[last];
  arr.pop();
}

/* ------------------------------------------------------------ formatting */

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

export function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function roman(n) {
  let out = '';
  n = Math.max(1, Math.round(n));
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}

/* ------------------------------------------------------------- geometry  */

/** Closest point on segment ab to point p (all {x,y,z}), written into out. */
export function closestPointOnSegment(ax, ay, az, bx, by, bz, px, py, pz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2 : 0;
  t = clamp01(t);
  out.x = ax + abx * t; out.y = ay + aby * t; out.z = az + abz * t;
  return t;
}

/** Ray vs axis-aligned box slab test. Returns hit distance or -1. */
export function rayBox(ox, oy, oz, dx, dy, dz, min, max) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const lo = [min.x, min.y, min.z], hi = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < lo[i] || o[i] > hi[i]) return -1;
    } else {
      const inv = 1 / d[i];
      let t1 = (lo[i] - o[i]) * inv;
      let t2 = (hi[i] - o[i]) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** Ray vs sphere. Returns nearest positive hit distance or -1. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/** Ray vs vertical capsule (an upright cylinder with hemispherical caps). */
export function rayCapsule(ox, oy, oz, dx, dy, dz, cx, cyBottom, cz, height, r) {
  // Cylinder body (infinite), then clamp to the segment, then test the caps.
  const px = ox - cx, pz = oz - cz;
  const a = dx * dx + dz * dz;
  let best = -1;
  if (a > 1e-8) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < 0) continue;
        const y = oy + dy * t;
        if (y >= cyBottom && y <= cyBottom + height) { best = t; break; }
      }
    }
  }
  for (const capY of [cyBottom, cyBottom + height]) {
    const t = raySphere(ox, oy, oz, dx, dy, dz, cx, capY, cz, r);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/* ------------------------------------------------------------- misc      */

export function titleCase(s) {
  return s.replace(/\w\S*/g, t => t[0].toUpperCase() + t.slice(1).toLowerCase());
}

/** Stable id generator for entities. */
let _uid = 1;
export const uid = () => _uid++;

/** Rolling average, handy for perf counters. */
export class Avg {
  constructor(n = 60) { this.buf = new Float32Array(n); this.i = 0; this.n = 0; }
  push(v) { this.buf[this.i] = v; this.i = (this.i + 1) % this.buf.length; if (this.n < this.buf.length) this.n++; return this; }
  get value() { let s = 0; for (let i = 0; i < this.n; i++) s += this.buf[i]; return this.n ? s / this.n : 0; }
}
