/* STARFALL — fx.js
   Pooled GPU-friendly effects: particles, tracers, impacts, explosions,
   shockwaves, beams. Everything is preallocated; nothing allocates per shot. */

import * as THREE from 'three';
import { clamp01, lerp } from './util.js';

const MAX_PARTICLES = 3000;
const MAX_TRACERS = 192;
const MAX_BEAMS = 24;
const MAX_RINGS = 24;
const MAX_FLASHES = 4;

const PARTICLE_VS = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  float soft = 1.0 - smoothstep(0.04, 0.25, r);
  gl_FragColor = vec4(vColor, vAlpha * soft);
}`;

const LINE_VS = `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const LINE_FS = `
varying float vAlpha;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, vAlpha); }`;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

class FXSystem {
  constructor() {
    this.ready = false;
    this.scene = null;
    this.quality = 1;    // scaled down on weak GPUs
  }

  init(scene) {
    this.scene = scene;

    /* ---- particles ---- */
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.pAlpha = new Float32Array(MAX_PARTICLES);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3));
    pg.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    pg.setAttribute('aAlpha', new THREE.BufferAttribute(this.pAlpha, 1));
    pg.setDrawRange(0, MAX_PARTICLES);
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const pm = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.points = new THREE.Points(pg, pm);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    scene.add(this.points);

    this.parts = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.parts[i] = { life: 0, max: 1, vx: 0, vy: 0, vz: 0, g: 0, drag: 0, size: 1, sizeEnd: 0, a0: 1, glow: 0 };
    }
    this.pHead = 0;

    /* ---- tracers ---- */
    const tg = new THREE.BufferGeometry();
    this.tPos = new Float32Array(MAX_TRACERS * 6);
    this.tCol = new Float32Array(MAX_TRACERS * 6);
    this.tAlpha = new Float32Array(MAX_TRACERS * 2);
    tg.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3));
    tg.setAttribute('aColor', new THREE.BufferAttribute(this.tCol, 3));
    tg.setAttribute('aAlpha', new THREE.BufferAttribute(this.tAlpha, 1));
    tg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const tm = new THREE.ShaderMaterial({
      vertexShader: LINE_VS, fragmentShader: LINE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    this.tracers = new THREE.LineSegments(tg, tm);
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 7;
    scene.add(this.tracers);
    this.trac = new Array(MAX_TRACERS);
    for (let i = 0; i < MAX_TRACERS; i++) this.trac[i] = { life: 0, max: 1, a0: 1 };
    this.tHead = 0;

    /* ---- beams (thick, for boss lasers and super streams) ---- */
    this.beams = [];
    const bgeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    bgeo.translate(0, 0.5, 0);
    bgeo.rotateX(Math.PI / 2);      // now runs along +Z from origin
    for (let i = 0; i < MAX_BEAMS; i++) {
      const m = new THREE.Mesh(bgeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      }));
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 6;
      scene.add(m);
      this.beams.push({ mesh: m, life: 0, max: 1, a0: 1, w0: 1 });
    }
    this.bHead = 0;

    /* ---- rings / shockwaves ---- */
    this.rings = [];
    const rgeo = new THREE.RingGeometry(0.85, 1, 40);
    rgeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_RINGS; i++) {
      const m = new THREE.Mesh(rgeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
      }));
      m.visible = false;
      m.renderOrder = 6;
      scene.add(m);
      this.rings.push({ mesh: m, life: 0, max: 1, r0: 1, r1: 6, a0: 1, sphere: false });
    }
    this.rHead = 0;

    /* ---- pooled flash lights (fixed count: no shader recompiles) ---- */
    this.flashes = [];
    for (let i = 0; i < MAX_FLASHES; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 40, 2);
      l.visible = false;
      scene.add(l);
      this.flashes.push({ light: l, life: 0, max: 1, i0: 0 });
    }
    this.fHead = 0;

    this.ready = true;
  }

  /* ------------------------------------------------------------ spawners */

  particle(x, y, z, vx, vy, vz, opts = {}) {
    if (!this.ready) return;
    const i = this.pHead;
    this.pHead = (this.pHead + 1) % MAX_PARTICLES;
    const p = this.parts[i];
    p.life = p.max = opts.life || 0.6;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.g = opts.gravity == null ? -9 : opts.gravity;
    p.drag = opts.drag == null ? 1.6 : opts.drag;
    p.size = opts.size == null ? 0.14 : opts.size;
    p.sizeEnd = opts.sizeEnd == null ? p.size * 0.2 : opts.sizeEnd;
    p.a0 = opts.alpha == null ? 1 : opts.alpha;
    const c = opts.color != null ? opts.color : 0xffffff;
    const i3 = i * 3;
    this.pPos[i3] = x; this.pPos[i3 + 1] = y; this.pPos[i3 + 2] = z;
    this.pCol[i3] = ((c >> 16) & 255) / 255;
    this.pCol[i3 + 1] = ((c >> 8) & 255) / 255;
    this.pCol[i3 + 2] = (c & 255) / 255;
    this.pSize[i] = p.size;
    this.pAlpha[i] = p.a0;
  }

  burst(pos, opts = {}) {
    if (!this.ready) return;
    const n = Math.max(1, Math.round((opts.count || 10) * this.quality));
    const speed = opts.speed == null ? 6 : opts.speed;
    const spread = opts.spread == null ? 1 : opts.spread;   // 1 = full sphere
    const dir = opts.dir || null;
    for (let i = 0; i < n; i++) {
      let vx, vy, vz;
      if (dir) {
        vx = dir.x + (Math.random() * 2 - 1) * spread;
        vy = dir.y + (Math.random() * 2 - 1) * spread;
        vz = dir.z + (Math.random() * 2 - 1) * spread;
      } else {
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(Math.random() * 2 - 1);
        vx = Math.sin(ph) * Math.cos(th);
        vy = Math.cos(ph) * (opts.flat ? 0.25 : 1);
        vz = Math.sin(ph) * Math.sin(th);
      }
      const s = speed * (0.45 + Math.random() * 0.8);
      const l = Math.hypot(vx, vy, vz) || 1;
      this.particle(
        pos.x + (Math.random() - 0.5) * (opts.jitter || 0.1),
        pos.y + (Math.random() - 0.5) * (opts.jitter || 0.1),
        pos.z + (Math.random() - 0.5) * (opts.jitter || 0.1),
        (vx / l) * s, (vy / l) * s, (vz / l) * s,
        opts
      );
    }
  }

  /** Bullet impact: sparks along the reflected direction + a dust puff. */
  impact(pos, normal, color = 0xffd08a, scale = 1) {
    if (!this.ready) return;
    this.burst(pos, {
      count: 7 * scale, speed: 7 * scale, color, life: 0.32, size: 0.075 * scale,
      dir: normal, spread: 0.75, gravity: -16, drag: 3, jitter: 0.05
    });
    this.burst(pos, {
      count: 3 * scale, speed: 1.6, color: 0x6b6f78, life: 0.6, size: 0.3 * scale,
      sizeEnd: 0.75 * scale, gravity: 1.2, drag: 2.6, alpha: 0.45
    });
  }

  /** Flesh/shield hit: coloured spray, no dust. */
  bloodHit(pos, dir, color = 0x8fd8ff, scale = 1) {
    this.burst(pos, {
      count: 8 * scale, speed: 5.5, color, life: 0.3, size: 0.1 * scale,
      dir, spread: 0.9, gravity: -8, drag: 3
    });
  }

  tracer(from, to, color = 0xffe6a8, life = 0.06, alpha = 0.9) {
    if (!this.ready) return;
    const i = this.tHead;
    this.tHead = (this.tHead + 1) % MAX_TRACERS;
    const t = this.trac[i];
    t.life = t.max = life;
    t.a0 = alpha;
    const i6 = i * 6;
    this.tPos[i6] = from.x; this.tPos[i6 + 1] = from.y; this.tPos[i6 + 2] = from.z;
    this.tPos[i6 + 3] = to.x; this.tPos[i6 + 4] = to.y; this.tPos[i6 + 5] = to.z;
    const r = ((color >> 16) & 255) / 255, g = ((color >> 8) & 255) / 255, b = (color & 255) / 255;
    for (let k = 0; k < 2; k++) {
      this.tCol[i6 + k * 3] = r; this.tCol[i6 + k * 3 + 1] = g; this.tCol[i6 + k * 3 + 2] = b;
      this.tAlpha[i * 2 + k] = alpha;
    }
  }

  beam(from, to, { color = 0x9ad8ff, life = 0.12, width = 0.12, alpha = 0.85 } = {}) {
    if (!this.ready) return;
    const b = this.beams[this.bHead];
    this.bHead = (this.bHead + 1) % MAX_BEAMS;
    const len = _v.subVectors(to, from).length();
    b.mesh.position.copy(from);
    b.mesh.scale.set(width, width, Math.max(0.01, len));
    if (len > 1e-4) {
      _v2.copy(_v).normalize();
      b.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _v2);
    }
    b.mesh.material.color.setHex(color);
    b.mesh.material.opacity = alpha;
    b.mesh.visible = true;
    b.life = b.max = life;
    b.a0 = alpha;
    b.w0 = width;
  }

  ring(pos, { color = 0xffffff, life = 0.5, r0 = 0.5, r1 = 7, alpha = 0.8, up = true } = {}) {
    if (!this.ready) return;
    const r = this.rings[this.rHead];
    this.rHead = (this.rHead + 1) % MAX_RINGS;
    r.mesh.position.copy(pos);
    r.mesh.rotation.set(up ? 0 : Math.PI / 2, 0, 0);
    r.mesh.material.color.setHex(color);
    r.mesh.visible = true;
    r.life = r.max = life;
    r.r0 = r0; r.r1 = r1; r.a0 = alpha;
  }

  flash(pos, color = 0xffc070, intensity = 12, life = 0.12, distance = 30) {
    if (!this.ready) return;
    const f = this.flashes[this.fHead];
    this.fHead = (this.fHead + 1) % MAX_FLASHES;
    f.light.position.copy(pos);
    f.light.color.setHex(color);
    f.light.distance = distance;
    f.light.intensity = intensity;
    f.light.visible = true;
    f.life = f.max = life;
    f.i0 = intensity;
  }

  muzzle(pos, dir, { color = 0xffd28a, scale = 1 } = {}) {
    this.burst(pos, {
      count: 5 * scale, speed: 9, color, life: 0.09, size: 0.13 * scale,
      dir, spread: 0.4, gravity: 0, drag: 6
    });
    this.flash(pos, color, 6 * scale, 0.06, 14);
  }

  explosion(pos, radius = 5, color = 0xff9a3c, { smoke = true } = {}) {
    this.burst(pos, {
      count: 26, speed: radius * 2.4, color, life: 0.5, size: 0.3,
      sizeEnd: 0.05, gravity: -7, drag: 2.4, jitter: 0.4
    });
    if (smoke) {
      this.burst(pos, {
        count: 14, speed: radius * 0.8, color: 0x2c2c30, life: 1.4, size: 0.9,
        sizeEnd: 2.4, gravity: 1.4, drag: 1.6, alpha: 0.4
      });
    }
    this.ring(pos, { color, life: 0.42, r0: 0.4, r1: radius * 1.25, alpha: 0.75 });
    this.flash(pos, color, 26, 0.22, radius * 7);
  }

  /* -------------------------------------------------------------- update */

  update(dt) {
    if (!this.ready) return;

    // particles
    let anyP = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.parts[i];
      if (p.life <= 0) { if (this.pAlpha[i] !== 0) { this.pAlpha[i] = 0; anyP = true; } continue; }
      p.life -= dt;
      anyP = true;
      const t = clamp01(1 - p.life / p.max);
      const dragF = Math.exp(-p.drag * dt);
      p.vx *= dragF; p.vz *= dragF;
      p.vy = p.vy * dragF + p.g * dt;
      const i3 = i * 3;
      this.pPos[i3] += p.vx * dt;
      this.pPos[i3 + 1] += p.vy * dt;
      this.pPos[i3 + 2] += p.vz * dt;
      this.pSize[i] = lerp(p.size, p.sizeEnd, t);
      this.pAlpha[i] = p.life > 0 ? p.a0 * (1 - t * t) : 0;
    }
    if (anyP) {
      const g = this.points.geometry;
      g.attributes.position.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
      g.attributes.aAlpha.needsUpdate = true;
      g.attributes.aColor.needsUpdate = true;
    }

    // tracers
    let anyT = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.trac[i];
      if (t.life <= 0) { if (this.tAlpha[i * 2] !== 0) { this.tAlpha[i * 2] = this.tAlpha[i * 2 + 1] = 0; anyT = true; } continue; }
      t.life -= dt;
      anyT = true;
      const a = t.life > 0 ? t.a0 * (t.life / t.max) : 0;
      this.tAlpha[i * 2] = a * 0.35;   // tail dimmer than head: reads as motion
      this.tAlpha[i * 2 + 1] = a;
    }
    if (anyT) {
      this.tracers.geometry.attributes.position.needsUpdate = true;
      this.tracers.geometry.attributes.aAlpha.needsUpdate = true;
      this.tracers.geometry.attributes.aColor.needsUpdate = true;
    }

    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const k = clamp01(b.life / b.max);
      b.mesh.material.opacity = b.a0 * k;
      b.mesh.scale.x = b.mesh.scale.y = b.w0 * (0.5 + k * 0.5);
      if (b.life <= 0) b.mesh.visible = false;
    }

    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const t = clamp01(1 - r.life / r.max);
      const rad = lerp(r.r0, r.r1, t < 1 ? 1 - Math.pow(1 - t, 2.2) : 1);
      r.mesh.scale.setScalar(Math.max(0.001, rad));
      r.mesh.material.opacity = r.a0 * (1 - t);
      if (r.life <= 0) r.mesh.visible = false;
    }

    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = clamp01(f.life / f.max);
      f.light.intensity = f.i0 * k * k;
      if (f.life <= 0) { f.light.visible = false; f.light.intensity = 0; }
    }
  }

  /** Kill everything — used when teleporting between activity spaces. */
  clear() {
    if (!this.ready) return;
    for (let i = 0; i < MAX_PARTICLES; i++) { this.parts[i].life = 0; this.pAlpha[i] = 0; }
    for (let i = 0; i < MAX_TRACERS; i++) { this.trac[i].life = 0; this.tAlpha[i * 2] = this.tAlpha[i * 2 + 1] = 0; }
    for (const b of this.beams) { b.life = 0; b.mesh.visible = false; }
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false; }
    for (const f of this.flashes) { f.life = 0; f.light.visible = false; f.light.intensity = 0; }
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
    this.tracers.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

export const FX = new FXSystem();
export default FX;
