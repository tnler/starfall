/* STARFALL — interiors.js
   The dungeon and the raid are not separate maps. They are built into the same
   scene as the overworld: the dungeon is carved under the Maw crater and reached
   by walking into a cave, the raid is a tower you can see from spawn and climb.

   This file only builds geometry and hands back anchor points. All the
   encounter logic lives in activities.js. */

import * as THREE from 'three';
import { heightAt, DUNGEON_MOUTH, SPIRE, LOST_SECTOR, MAW } from './world.js';

const GLOW = c => new THREE.MeshBasicMaterial({ color: c });

export function buildInteriors(W, scene) {
  const spec = {};
  spec.dungeon = buildDungeon(W, scene);
  spec.raid = buildRaid(W, scene);
  spec.lostSector = buildLostSector(W, scene);
  return spec;
}

/* ------------------------------------------------------------ primitives */

/** A rectangular room with optional door gaps. Returns useful anchors. */
function room(W, opts) {
  const {
    x, y, z, w, d, h,
    doors = [],           // [{side:'n'|'s'|'e'|'w', width, offset}]
    mat = 'vex', floorMat = null, ceiling = true, tag = 'room', pillars = 0,
    glow = 0x6f5bd0, group = null
  } = opts;
  const T = 2;            // wall thickness
  const parts = { walls: [], floor: null, ceiling: null };

  parts.floor = W.addStructure(x, y - T / 2, z, w, T, d, { mat: floorMat || mat, tag: tag + '_floor', parent: group });
  if (ceiling) parts.ceiling = W.addStructure(x, y + h + T / 2, z, w, T, d, { mat, tag: tag + '_ceil', parent: group });

  const sideDoors = s => doors.filter(dd => dd.side === s);

  const wallRun = (side, cx, cz, len, along) => {
    // along: 'x' or 'z'. Build segments, skipping door gaps.
    const gaps = sideDoors(side).map(g => ({ a: g.offset - g.width / 2, b: g.offset + g.width / 2, h: g.height || h }));
    gaps.sort((p, q) => p.a - q.a);
    let cursor = -len / 2;
    const segs = [];
    for (const g of gaps) {
      const a = Math.max(-len / 2, g.a), b = Math.min(len / 2, g.b);
      if (a > cursor) segs.push([cursor, a]);
      cursor = Math.max(cursor, b);
      // Lintel above the doorway keeps the wall reading as solid.
      if (g.h < h) {
        const mid = (a + b) / 2, gw = b - a;
        const lh = h - g.h;
        if (along === 'x') W.addStructure(cx + mid, y + g.h + lh / 2, cz, gw, lh, T, { mat, tag: tag + '_wall', parent: group });
        else W.addStructure(cx, y + g.h + lh / 2, cz + mid, T, lh, gw, { mat, tag: tag + '_wall', parent: group });
      }
    }
    if (cursor < len / 2) segs.push([cursor, len / 2]);
    for (const [a, b] of segs) {
      const segLen = b - a;
      if (segLen <= 0.01) continue;
      const mid = (a + b) / 2;
      if (along === 'x') parts.walls.push(W.addStructure(cx + mid, y + h / 2, cz, segLen, h, T, { mat, tag: tag + '_wall', parent: group }));
      else parts.walls.push(W.addStructure(cx, y + h / 2, cz + mid, T, h, segLen, { mat, tag: tag + '_wall', parent: group }));
    }
  };

  wallRun('n', x, z - d / 2, w, 'x');
  wallRun('s', x, z + d / 2, w, 'x');
  wallRun('w', x - w / 2, z, d, 'z');
  wallRun('e', x + w / 2, z, d, 'z');

  for (let i = 0; i < pillars; i++) {
    const a = (i / pillars) * Math.PI * 2;
    const px = x + Math.cos(a) * w * 0.31, pz = z + Math.sin(a) * d * 0.31;
    W.addStructure(px, y + h / 2, pz, 2.6, h, 2.6, { mat, tag: tag + '_pillar', parent: group });
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.4, h * 0.7, 0.4), GLOW(glow));
    strip.position.set(px + 1.4, y + h * 0.45, pz);
    (group || W.scene).add(strip);
  }

  // Glowing floor trim: the only light source down here, so make it read.
  const trim = new THREE.Mesh(new THREE.BoxGeometry(w - 4, 0.18, 0.5), GLOW(glow));
  trim.position.set(x, y + 0.14, z - d / 2 + 1.6);
  (group || W.scene).add(trim);
  const trim2 = trim.clone();
  trim2.position.z = z + d / 2 - 1.6;
  (group || W.scene).add(trim2);

  W.addInteriorVolume(x, y + h / 2, z, w / 2 + 2.5, h / 2 + 8, d / 2 + 2.5, tag);

  parts.center = new THREE.Vector3(x, y, z);
  parts.w = w; parts.d = d; parts.h = h;
  return parts;
}

/** Flat corridor between two rooms, running along x or z. */
function corridor(W, { x, y, z, len, width = 10, h = 9, along = 'x', mat = 'vex', glow = 0x6f5bd0, group = null }) {
  const T = 2;
  const w = along === 'x' ? len : width;
  const d = along === 'x' ? width : len;
  W.addStructure(x, y - T / 2, z, w, T, d, { mat, tag: 'cor_floor', parent: group });
  W.addStructure(x, y + h + T / 2, z, w, T, d, { mat, tag: 'cor_ceil', parent: group });
  if (along === 'x') {
    W.addStructure(x, y + h / 2, z - width / 2, len, h, T, { mat, tag: 'cor_wall', parent: group });
    W.addStructure(x, y + h / 2, z + width / 2, len, h, T, { mat, tag: 'cor_wall', parent: group });
  } else {
    W.addStructure(x - width / 2, y + h / 2, z, T, h, len, { mat, tag: 'cor_wall', parent: group });
    W.addStructure(x + width / 2, y + h / 2, z, T, h, len, { mat, tag: 'cor_wall', parent: group });
  }
  const strip = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? len - 2 : 0.3, 0.16, along === 'x' ? 0.3 : len - 2), GLOW(glow));
  strip.position.set(x, y + 0.12, z);
  (group || W.scene).add(strip);
  W.addInteriorVolume(x, y + h / 2, z, w / 2 + 2.5, h / 2 + 6, d / 2 + 2.5, 'corridor');
  return { x, y, z, len, width, h };
}

/** A grav lift: stand in the column and get carried. Destiny/Halo staple. */
function gravLift(W, scene, { x, y, z, r = 3.6, height = 30, up = true, color = 0x8fd8ff }) {
  const geo = new THREE.CylinderGeometry(r, r * 0.8, height, 18, 1, true);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false
  }));
  mesh.position.set(x, y + height / 2, z);
  mesh.renderOrder = 4;
  scene.add(mesh);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.16, 6, 24), GLOW(color));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, y + 0.3, z);
  scene.add(ring);
  const lift = { x, y, z, r, height, up, mesh, ring, kind: 'lift' };
  W.triggers.push(lift);
  return lift;
}

/** A blocking gate that encounters open. */
function gate(W, { x, y, z, w, h, d = 2.4, yaw = 0, color = 0xff5d3c, group = null }) {
  const mesh = W.addStructure(x, y + h / 2, z, w, h, d, { yaw, mat: 'metalDark', tag: 'gate', parent: group });
  const box = W.grid.all[W.grid.all.length - 1];
  const bars = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.3, d + 0.3), GLOW(color));
  bars.position.set(x, y + h * 0.55, z);
  bars.rotation.y = yaw;
  (group || W.scene).add(bars);
  return {
    mesh, box, bars, open: false,
    setOpen(o) {
      this.open = o;
      this.mesh.visible = !o;
      this.bars.visible = !o;
      this.box.enabled = !o;
    }
  };
}

/* ---------------------------------------------------------------- dungeon */

function buildDungeon(W, scene) {
  const mx = DUNGEON_MOUTH.x, mz = DUNGEON_MOUTH.z;
  const mouthY = heightAt(mx, mz);
  const g = new THREE.Group();
  scene.add(g);

  const MAT = 'vex';
  const GLOWC = 0x8b6bff;
  const floorY = mouthY - 34;

  /* Cave mouth: an arch on the crater wall, then a stepped ramp down. */
  W.addStructure(mx, mouthY + 5.5, mz, 16, 11, 3, { mat: 'rock', tag: 'mouth', parent: g, color: 0x2e2028 });
  W.addStructure(mx, mouthY + 8.5, mz - 6, 20, 5, 14, { mat: 'rock', tag: 'mouth', parent: g, color: 0x2e2028 });
  W.addStructure(mx - 1, mouthY + 3, mz - 7, 3, 6, 3, { collide: false, mat: 'rock', parent: g, color: 0x241a20 });
  const sigil = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.22, 6, 20), GLOW(GLOWC));
  sigil.position.set(mx, mouthY + 7.4, mz + 1.6);
  g.add(sigil);

  // Entry corridor slopes in as steps (step height stays under the step-up limit).
  const steps = 14;
  let sx = mx, sy = mouthY, sz = mz - 3;
  for (let i = 0; i < steps; i++) {
    sy -= 0.72;
    sx -= 3.0;
    W.addStructure(sx, sy - 0.6, sz, 4.2, 1.4, 11, { mat: 'rock', tag: 'stair', parent: g, color: 0x2a1f26 });
    W.addStructure(sx, sy + 5, sz - 6, 4.4, 12, 2, { mat: 'rock', tag: 'stair_wall', parent: g, color: 0x241a20 });
    W.addStructure(sx, sy + 5, sz + 6, 4.4, 12, 2, { mat: 'rock', tag: 'stair_wall', parent: g, color: 0x241a20 });
    W.addStructure(sx, sy + 11.5, sz, 4.4, 2, 12, { mat: 'rock', tag: 'stair_ceil', parent: g, color: 0x1d1519 });
    W.addInteriorVolume(sx, sy + 5, sz, 3.4, 8, 7, 'tunnel');
  }
  const shaftX = sx - 8, shaftZ = sz;
  const shaftTop = sy;

  /* Vertical shaft with a descent stream (fall slowly, ride back up). */
  const shaftH = shaftTop - floorY;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    W.addStructure(shaftX + Math.cos(a) * 9, floorY + shaftH / 2, shaftZ + Math.sin(a) * 9, 8, shaftH, 8, {
      yaw: -a, mat: MAT, tag: 'shaft', parent: g
    });
  }
  W.addInteriorVolume(shaftX, floorY + shaftH / 2, shaftZ, 9, shaftH / 2 + 4, 9, 'shaft');
  const descend = gravLift(W, scene, { x: shaftX, y: floorY, z: shaftZ, r: 4.4, height: shaftH, up: false, color: GLOWC });
  descend.twoWay = true;

  /* Encounter rooms, west of the shaft, all on one floor. */
  const anteX = shaftX - 44;
  const ante = room(W, {
    x: anteX, y: floorY, z: shaftZ, w: 46, d: 46, h: 15, mat: MAT, glow: GLOWC,
    tag: 'd_ante', pillars: 4, group: g,
    doors: [{ side: 'e', width: 9, offset: 0, height: 8 }, { side: 'w', width: 10, offset: 0, height: 9 }]
  });
  corridor(W, { x: shaftX - 12, y: floorY, z: shaftZ, len: 22, width: 9, h: 8, along: 'x', mat: MAT, glow: GLOWC, group: g });

  const antePlates = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    const px = anteX + Math.cos(a) * 15, pz = shaftZ + Math.sin(a) * 15;
    const pm = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.8, 0.4, 20), new THREE.MeshLambertMaterial({ color: 0x2b2740, emissive: 0x120c22 }));
    pm.position.set(px, floorY + 0.2, pz);
    g.add(pm);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.13, 6, 22), GLOW(0x4b3d7a));
    halo.rotation.x = Math.PI / 2;
    halo.position.set(px, floorY + 0.45, pz);
    g.add(halo);
    antePlates.push({ x: px, y: floorY, z: pz, mesh: pm, halo, r: 3.0 });
  }
  const anteGate = gate(W, { x: anteX - 23, y: floorY, z: shaftZ, w: 10, h: 9, color: GLOWC, group: g });

  const corr1 = corridor(W, { x: anteX - 40, y: floorY, z: shaftZ, len: 34, width: 10, h: 9, along: 'x', mat: MAT, glow: GLOWC, group: g });

  /* Encounter 2: the Weavers — two linked bosses, a bridge over a pit. */
  const weaveX = anteX - 84;
  const weavers = room(W, {
    x: weaveX, y: floorY, z: shaftZ, w: 58, d: 52, h: 18, mat: MAT, glow: 0x6fe0ff,
    tag: 'd_weave', pillars: 6, group: g,
    doors: [{ side: 'e', width: 10, offset: 0, height: 9 }, { side: 'w', width: 10, offset: 0, height: 9 }]
  });
  // Raised side platforms give the fight verticality.
  W.addStructure(weaveX - 18, floorY + 3, shaftZ - 17, 16, 6, 12, { mat: MAT, tag: 'ledge', parent: g });
  W.addStructure(weaveX + 18, floorY + 3, shaftZ + 17, 16, 6, 12, { mat: MAT, tag: 'ledge', parent: g });
  const weaveAnchors = [
    { x: weaveX - 15, y: floorY, z: shaftZ + 9 },
    { x: weaveX + 15, y: floorY, z: shaftZ - 9 }
  ];
  const weaveGate = gate(W, { x: weaveX - 29, y: floorY, z: shaftZ, w: 10, h: 9, color: 0x6fe0ff, group: g });

  corridor(W, { x: weaveX - 46, y: floorY, z: shaftZ, len: 34, width: 10, h: 9, along: 'x', mat: MAT, glow: GLOWC, group: g });

  /* Encounter 3: the Choir Hall — boss arena with three dunk pylons. */
  const choirX = weaveX - 100;
  const choir = room(W, {
    x: choirX, y: floorY, z: shaftZ, w: 78, d: 74, h: 26, mat: MAT, glow: 0xff5d3c,
    tag: 'd_choir', pillars: 8, group: g,
    doors: [{ side: 'e', width: 10, offset: 0, height: 9 }]
  });
  // Dais: the boss holds the high ground, you have to push in.
  W.addStructure(choirX - 24, floorY + 1.5, shaftZ, 22, 3, 34, { mat: MAT, tag: 'dais', parent: g });
  W.addStructure(choirX - 13, floorY + 0.75, shaftZ, 2.5, 1.5, 34, { mat: MAT, tag: 'dais_step', parent: g });
  const pylons = [];
  for (let i = 0; i < 3; i++) {
    const pz = shaftZ + (i - 1) * 22;
    const px = choirX + 22;
    W.addStructure(px, floorY + 4, pz, 3.2, 8, 3.2, { mat: 'metalDark', tag: 'pylon', parent: g });
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 1), GLOW(0x3a2a44));
    orb.position.set(px, floorY + 9, pz);
    g.add(orb);
    pylons.push({ x: px, y: floorY, z: pz, orb, r: 3.4, charged: false });
  }
  const bossAnchor = { x: choirX - 24, y: floorY + 3, z: shaftZ };

  // Safe pool for the boss's room-wide attack.
  const poolMesh = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.2, 26), new THREE.MeshBasicMaterial({ color: 0x6fe0ff, transparent: true, opacity: 0.22 }));
  poolMesh.position.set(choirX + 6, floorY + 0.12, shaftZ);
  poolMesh.visible = false;
  g.add(poolMesh);

  // Loot room behind the boss.
  const chestPos = { x: choirX - 32, y: floorY + 3, z: shaftZ };

  return {
    group: g,
    mouth: { x: mx, y: mouthY, z: mz },
    floorY,
    shaft: { x: shaftX, y: floorY, z: shaftZ, top: shaftTop, lift: descend },
    entryTrigger: { x: mx - 6, y: mouthY, z: mz, r: 9 },
    rooms: {
      ante: { x: anteX, y: floorY, z: shaftZ, w: 46, d: 46, parts: ante },
      weavers: { x: weaveX, y: floorY, z: shaftZ, w: 58, d: 52, parts: weavers },
      choir: { x: choirX, y: floorY, z: shaftZ, w: 78, d: 74, parts: choir }
    },
    plates: antePlates,
    gates: { ante: anteGate, weavers: weaveGate },
    weaveAnchors,
    pylons,
    bossAnchor,
    safePool: poolMesh,
    chestPos,
    corridors: [corr1]
  };
}

/* ------------------------------------------------------------------ raid */

function buildRaid(W, scene) {
  const g = new THREE.Group();
  scene.add(g);
  const bx = SPIRE.x, bz = SPIRE.z;
  const baseY = heightAt(bx, bz + SPIRE.r * 0.72);   // ground at the foot, off the cone
  const MAT = 'metalDark';
  const ACC = 0xc39dff;

  /* The spire itself: stacked tapering drums, so it reads as built. */
  for (let i = 0; i < 9; i++) {
    const t = i / 9;
    const r = 26 * (1 - t * 0.72);
    const y = baseY + 8 + i * 19;
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.06, 18, 12), new THREE.MeshLambertMaterial({ color: 0x3b3550, flatShading: true }));
    drum.position.set(bx, y, bz);
    drum.rotation.y = i * 0.3;
    g.add(drum);
    W.addCollider(bx, y, bz, r * 0.92, 9, r * 0.92, 0, 'spire');
    if (i % 2 === 0) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(r + 0.5, 0.3, 6, 18), GLOW(ACC));
      band.rotation.x = Math.PI / 2;
      band.position.set(bx, y + 9, bz);
      g.add(band);
    }
  }
  const cap = new THREE.Mesh(new THREE.ConeGeometry(9, 26, 10), new THREE.MeshLambertMaterial({ color: 0x4a4368, flatShading: true }));
  cap.position.set(bx, baseY + 8 + 9 * 19 + 10, bz);
  g.add(cap);

  /** Square arena platform floating off the spire. */
  const platform = (y, size, tag) => {
    W.addStructure(bx, y - 1.2, bz, size, 2.4, size, { mat: MAT, tag: 'raid_floor', parent: g });
    // Low lip so you can see the edge before you walk off it.
    const lip = 1.4;
    for (const [ox, oz, w, d] of [
      [0, -size / 2, size, 1.6], [0, size / 2, size, 1.6],
      [-size / 2, 0, 1.6, size], [size / 2, 0, 1.6, size]
    ]) {
      W.addStructure(bx + ox, y + lip / 2, bz + oz, w, lip, d, { mat: MAT, tag: 'raid_lip', parent: g });
    }
    const trim = new THREE.Mesh(new THREE.TorusGeometry(size * 0.5 - 1, 0.22, 6, 40), GLOW(ACC));
    trim.rotation.x = Math.PI / 2;
    trim.position.set(bx, y + 0.3, bz);
    g.add(trim);
    return { x: bx, y, z: bz, size, tag };
  };

  const p1y = baseY + 26, p2y = baseY + 74, p3y = baseY + 126;
  const p1 = platform(p1y, 72, 'ascent');
  const p2 = platform(p2y, 66, 'gauntlet');
  const p3 = platform(p3y, 88, 'aetheron');

  /* Encounter 1 — the Ascent: three conduit plates + a terminal. */
  const ascentPlates = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const px = bx + Math.cos(a) * 27, pz = bz + Math.sin(a) * 27;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.2, 0.5, 18), new THREE.MeshLambertMaterial({ color: 0x342c50, emissive: 0x150f28 }));
    m.position.set(px, p1y + 0.25, pz);
    g.add(m);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(3.1, 0.14, 6, 24), GLOW(0x5a4a90));
    halo.rotation.x = Math.PI / 2;
    halo.position.set(px, p1y + 0.6, pz);
    g.add(halo);
    ascentPlates.push({ x: px, y: p1y, z: pz, r: 3.4, mesh: m, halo, idx: i });
  }
  W.addStructure(bx, p1y + 2, bz + 30, 6, 4, 3, { mat: 'metal', tag: 'terminal', parent: g });
  const terminal = { x: bx, y: p1y, z: bz + 30, r: 4.5 };
  // Cover: shooting galleries need something to break line of sight.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    // 16 put these inside the spire, where they were solid rock nobody saw.
    W.addStructure(bx + Math.cos(a) * 28, p1y + 2, bz + Math.sin(a) * 28, 5, 4, 2, { yaw: -a, mat: MAT, tag: 'cover', parent: g });
  }

  /* Encounter 2 — Gauntlet of Names: the cleanse pillar + four alcoves.
     The arenas are terraces around a solid spire, so anything you have to
     stand next to has to live in the walkable ring, not on the axis — the
     drum at this height is ~16 units of rock. The pillar sits at +X, between
     two alcoves. */
  const pillarX = bx + 24, pillarZ = bz;
  const pillar = W.addStructure(pillarX, p2y + 5, pillarZ, 5, 10, 5, { mat: 'metal', tag: 'cleanse', parent: g });
  const pillarGlow = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 1), GLOW(0x9dff7a));
  pillarGlow.position.set(pillarX, p2y + 11.5, pillarZ);
  g.add(pillarGlow);
  const alcoves = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const ax = bx + Math.cos(a) * 24, az = bz + Math.sin(a) * 24;
    W.addStructure(ax, p2y + 3, az, 10, 6, 2, { yaw: -a, mat: MAT, tag: 'alcove', parent: g });
    alcoves.push({ x: ax, y: p2y, z: az, idx: i });
  }

  /* Encounter 3 — Aetheron: four shield anchors on the rim, open sky. */
  const anchors = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const ax = bx + Math.cos(a) * 34, az = bz + Math.sin(a) * 34;
    W.addStructure(ax, p3y + 3, az, 4, 6, 4, { yaw: -a, mat: 'metal', tag: 'anchor', parent: g });
    const orb = new THREE.Mesh(new THREE.OctahedronGeometry(1.7, 0), GLOW(0xffd166));
    orb.position.set(ax, p3y + 8, az);
    g.add(orb);
    anchors.push({ x: ax, y: p3y + 6, z: az, orb, idx: i, alive: true });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    W.addStructure(bx + Math.cos(a) * 20, p3y + 1.6, bz + Math.sin(a) * 20, 6, 3.2, 2, { yaw: -a, mat: MAT, tag: 'cover', parent: g });
  }
  // Clear of the spire drum (~12 units of rock at this height) so Aetheron
  // fights on the terrace instead of spawning inside the tower.
  const raidBossAnchor = { x: bx, y: p3y, z: bz - 24 };

  /* Grav lifts chain the platforms together — and the raid entrance. */
  const entry = { x: bx, y: baseY, z: bz + SPIRE.r * 0.86 };
  W.addStructure(entry.x, entry.y + 5, entry.z, 22, 10, 3, { mat: MAT, tag: 'raid_gate', parent: g });
  const arch = new THREE.Mesh(new THREE.TorusGeometry(6.5, 0.5, 8, 26, Math.PI), GLOW(ACC));
  arch.position.set(entry.x, entry.y + 4.5, entry.z - 1.8);
  g.add(arch);

  const lifts = [
    gravLift(W, scene, { x: bx + 30, y: baseY + 1, z: bz + 30, r: 4, height: p1y - baseY + 3, color: ACC }),
    gravLift(W, scene, { x: bx + 28, y: p1y, z: bz + 28, r: 4, height: p2y - p1y + 3, color: ACC }),
    gravLift(W, scene, { x: bx + 26, y: p2y, z: bz + 26, r: 4, height: p3y - p2y + 3, color: ACC })
  ];
  lifts[1].locked = true;
  lifts[2].locked = true;

  const chestPos = { x: bx - 12, y: p3y, z: bz - 26 };

  return {
    group: g, baseY, entry,
    platforms: { ascent: p1, gauntlet: p2, aetheron: p3 },
    plates: ascentPlates, terminal, alcoves, pillar: { x: pillarX, y: p2y, z: pillarZ, r: 5, mesh: pillar, glow: pillarGlow },
    anchors, bossAnchor: raidBossAnchor, lifts, chestPos
  };
}

/* ------------------------------------------------------------ lost sector */

function buildLostSector(W, scene) {
  const g = new THREE.Group();
  scene.add(g);
  const x = LOST_SECTOR.x, z = LOST_SECTOR.z;
  const y = heightAt(x, z);
  const floorY = y - 13;

  W.addStructure(x, y + 4, z, 14, 9, 3, { mat: 'rock', tag: 'ls_mouth', parent: g, color: 0x3a4450 });
  const sigil = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.2, 6, 18), GLOW(0x9fe8ff));
  sigil.position.set(x, y + 6.4, z + 1.7);
  g.add(sigil);

  let sx = x, sz = z - 3, sy = y;
  for (let i = 0; i < 9; i++) {
    sy -= 1.45; sz -= 3.2;
    W.addStructure(sx, sy - 0.6, sz, 9, 1.4, 4.0, { mat: 'rock', tag: 'ls_stair', parent: g, color: 0x39424e });
    W.addStructure(sx - 5, sy + 4, sz, 2, 10, 4.2, { mat: 'rock', parent: g, tag: 'ls_wall', color: 0x2f3742 });
    W.addStructure(sx + 5, sy + 4, sz, 2, 10, 4.2, { mat: 'rock', parent: g, tag: 'ls_wall', color: 0x2f3742 });
    W.addStructure(sx, sy + 9.5, sz, 9, 2, 4.2, { mat: 'rock', parent: g, tag: 'ls_ceil', color: 0x262d36 });
    W.addInteriorVolume(sx, sy + 4.5, sz, 5, 7, 3, 'ls_tunnel');
  }

  const cz = sz - 22;
  const cave = room(W, {
    x: sx, y: floorY, z: cz, w: 40, d: 40, h: 14, mat: 'rock', glow: 0x9fe8ff,
    tag: 'ls_room', pillars: 3, group: g,
    doors: [{ side: 's', width: 9, offset: 0, height: 8 }]
  });
  for (let i = 0; i < 5; i++) {
    const a = i * 1.9;
    W.addStructure(sx + Math.cos(a) * 12, floorY + 1.6, cz + Math.sin(a) * 12, 4, 3.2, 4, { yaw: a, mat: 'rock', tag: 'ls_cover', parent: g, color: 0x424b57 });
  }

  return {
    group: g,
    mouth: { x, y, z },
    center: { x: sx, y: floorY, z: cz },
    bossAnchor: { x: sx - 8, y: floorY, z: cz - 8 },
    chestPos: { x: sx + 10, y: floorY, z: cz - 12 },
    room: cave
  };
}
