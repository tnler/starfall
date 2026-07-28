/* STARFALL — activities.js
   Everything that gives the world a reason to exist: ambient patrols, a public
   event on a world timer, a lost sector, a three-encounter dungeon and a
   three-encounter raid.

   Encounters are written to scale down to one player without changing shape:
   plates hold their charge for a few seconds after you step off, timers are
   generous, and add counts scale with fireteam size. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, makeRNG, fmtTime, swapRemove, TAU } from './util.js';
import Combat, { FACTION } from './combat.js';
import Enemies, { servitorPass } from './enemies.js';
import World, { WORLD, REGIONS, regionAt, heightAt } from './world.js';
import { rollDrop, SOURCES } from './loot.js';
import { XP } from './progress.js';
import FX from './fx.js';
import Audio from './audio.js';

const _v = new THREE.Vector3();

/* Region spawn tables — what lives where, and how hard it hits. */
const REGION_TABLE = {
  rally: { level: 1, pool: [] },
  ashfall: { level: 2, pool: [['chitter', 4], ['skirmisher', 3], ['shank', 2], ['captain', 0.5]] },
  rift: { level: 5, pool: [['skirmisher', 4], ['chitter', 3], ['marksman', 2], ['captain', 1], ['servitor', 0.6]] },
  frost: { level: 4, pool: [['marksman', 3], ['skirmisher', 3], ['shank', 2], ['captain', 0.7]] },
  maw: { level: 7, pool: [['chitter', 4], ['skirmisher', 3], ['bulwark', 0.8], ['captain', 1]] },
  spire: { level: 9, pool: [['skirmisher', 3], ['marksman', 2], ['captain', 1.2], ['servitor', 0.5]] }
};

/* -------------------------------------------------------------- helpers */

function ringPoint(cx, cz, r, a) { return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r }; }

/** Marker post: a floating diamond that reads as "go here". */
function marker(scene, x, y, z, color) {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color }));
  m.position.set(x, y + 2.2, z);
  scene.add(m);
  return m;
}

class Carryable {
  constructor(scene, x, y, z, { color = 0xffd166, name = 'Conduit', onDeposit = null } = {}) {
    this.mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), new THREE.MeshBasicMaterial({ color }));
    this.mesh.position.set(x, y + 1.2, z);
    scene.add(this.mesh);
    this.scene = scene;
    this.name = name;
    this.color = color;
    this.holder = null;
    this.t = 0;
    this.dead = false;
    this.onDeposit = onDeposit;
    this.home = new THREE.Vector3(x, y, z);
  }
  update(dt, player) {
    this.t += dt;
    this.mesh.rotation.y += dt * 2;
    if (this.holder) {
      this.mesh.position.set(this.holder.pos.x, this.holder.pos.y + 2.4 + Math.sin(this.t * 3) * 0.1, this.holder.pos.z);
      if (!this.holder.alive) this.drop();
    } else {
      this.mesh.position.y = this.home.y + 1.2 + Math.sin(this.t * 2) * 0.18;
      if (player && player.alive && !player.carrying) {
        const d = Math.hypot(player.pos.x - this.mesh.position.x, player.pos.z - this.mesh.position.z);
        if (d < 2.2 && Math.abs(player.pos.y - this.home.y) < 4) this.pickUp(player);
      }
    }
  }
  pickUp(p) {
    this.holder = p;
    p.carrying = this;
    Audio.play('pickup', { vol: 0.8 });
  }
  drop() {
    if (this.holder) this.holder.carrying = null;
    this.holder = null;
    this.home.set(this.mesh.position.x, World.supportY(this.mesh.position.x, this.mesh.position.y + 2, this.mesh.position.z, 4), this.mesh.position.z);
    if (!isFinite(this.home.y)) this.home.y = heightAt(this.mesh.position.x, this.mesh.position.z);
  }
  dispose() {
    if (this.holder) this.holder.carrying = null;
    this.scene.remove(this.mesh);
    this.dead = true;
  }
}

/* ------------------------------------------------------------ encounters */

/** Base: trigger volume, wipe/reset, add-wave bookkeeping. */
class Encounter {
  constructor(dir, cfg) {
    this.dir = dir;
    Object.assign(this, cfg);
    this.state = 'idle';        // idle | active | done
    this.t = 0;
    this.phase = 0;
    this.tag = cfg.tag;
    this.startedOnce = false;
  }
  get player() { return this.dir.player; }
  inArena(p) {
    if (!p) return false;
    const d = Math.hypot(p.pos.x - this.center.x, p.pos.z - this.center.z);
    return d < this.radius && Math.abs(p.pos.y - this.center.y) < (this.vSpan || 22);
  }
  begin() {
    if (this.state === 'active' || this.state === 'done') return;
    this.state = 'active';
    this.t = 0;
    this.phase = 0;
    this.startedOnce = true;
    Audio.play('alarm', { vol: 0.7 });
    this.dir.banner(this.name, this.startLine || 'Encounter started', 3.2);
    if (this.onBegin) this.onBegin();
  }
  reset(reason = 'wipe') {
    Enemies.clearActivity(this.tag);
    this.state = 'idle';
    this.t = 0;
    this.phase = 0;
    if (this.onReset) this.onReset(reason);
    if (reason === 'wipe') {
      Audio.play('wipe', { vol: 0.9 });
      this.dir.banner(this.name, 'Wipe — encounter reset', 3.2);
    }
  }
  complete() {
    if (this.state === 'done') return;
    this.state = 'done';
    Enemies.clearActivity(this.tag);
    Audio.play('objective', { vol: 1 });
    this.dir.banner(this.name, 'Encounter complete', 3.4);
    // Raid encounters pay roughly double a dungeon's — they cost more to reach.
    this.dir.awardXP(this.tag[0] === 'r' ? XP.raidEncounter : XP.dungeonEncounter, this.name);
    if (this.onComplete) this.onComplete();
  }
  /** Keep a population alive around a point. */
  maintain(dt, { count, table, center, radius, level, interval = 2.2, tier = null }) {
    this._spawnT = (this._spawnT || 0) - dt;
    if (this._spawnT > 0) return;
    this._spawnT = interval;
    const live = Enemies.countActivity(this.tag);
    if (live >= count) return;
    const rng = this.dir.rng;
    const typeId = rng.weighted(table);
    const a = rng() * TAU;
    const r = radius * (0.55 + rng() * 0.45);
    const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
    const y = World.supportY(x, center.y + 12, z, 26);
    Enemies.spawn(typeId, x, isFinite(y) ? y : center.y, z, {
      level, activity: this.tag, tier,
      onDeath: this.onAddDeath ? (e, i) => this.onAddDeath(e, i) : null
    });
  }
}

/* --------------------------------------------------------------- director */

class ActivityDirector {
  constructor() {
    this.rng = makeRNG(4242);
    this.waypoints = [];
    this.banners = [];
    this.objective = null;
    this.events = [];
    this.ready = false;
  }

  init(scene, player, spec) {
    this.scene = scene;
    this.player = player;
    this.spec = spec;
    this.ambient = { t: 0, live: [] };
    this.patrols = this._makePatrols();
    this.publicEvent = this._makePublicEvent();
    this.lostSector = this._makeLostSector();
    this.dungeon = this._makeDungeon();
    this.raid = this._makeRaid();
    this.carryables = [];
    this.chests = [];
    this.ready = true;
  }

  banner(title, sub, dur = 3) {
    this.banners.push({ title, sub, t: dur, max: dur });
    if (this.banners.length > 3) this.banners.shift();
  }

  /* ------------------------------------------------------------- update */

  update(dt, player) {
    if (!this.ready) return;
    this.waypoints.length = 0;
    for (let i = this.banners.length - 1; i >= 0; i--) {
      this.banners[i].t -= dt;
      if (this.banners[i].t <= 0) this.banners.splice(i, 1);
    }
    for (let i = this.carryables.length - 1; i >= 0; i--) {
      const c = this.carryables[i];
      if (c.dead) { swapRemove(this.carryables, i); continue; }
      c.update(dt, player);
    }
    for (let i = this.chests.length - 1; i >= 0; i--) {
      const ch = this.chests[i];
      ch.t += dt;
      ch.mesh.rotation.y += dt * 0.8;
      ch.mesh.position.y = ch.y + 0.9 + Math.sin(ch.t * 1.6) * 0.16;
      this.waypoints.push({ x: ch.mesh.position.x, y: ch.mesh.position.y, z: ch.mesh.position.z, label: 'Chest', color: 0xffd166, kind: 'chest' });
      if (player.alive && player.pos.distanceTo(ch.mesh.position) < 3) {
        this.scene.remove(ch.mesh);
        swapRemove(this.chests, i);
        this.openChest(ch);
      }
    }

    this._ambient(dt, player);
    this._patrols(dt, player);
    this.publicEvent.update(dt, player);
    this.lostSector.update(dt, player);
    this.dungeon.update(dt, player);
    this.raid.update(dt, player);
    servitorPass(Enemies, dt);

    // Objective priority: whatever you are standing in wins the HUD.
    this.objective =
      this.raid.objective ||
      this.dungeon.objective ||
      this.lostSector.objective ||
      this.publicEvent.objective ||
      this.patrolObjective ||
      null;
  }

  dropChest(x, y, z, source) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.1, 1.1),
      new THREE.MeshLambertMaterial({ color: 0x6b5a2a, emissive: 0x2a2008 })
    );
    mesh.position.set(x, y + 0.9, z);
    this.scene.add(mesh);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.08, 6, 18), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    halo.rotation.x = Math.PI / 2;
    mesh.add(halo);
    const ch = { mesh, x, y, z, t: 0, source };
    this.chests.push(ch);
    Audio.play('objective', { vol: 0.8 });
    return ch;
  }

  openChest(ch) {
    Audio.play('chest', { vol: 1 });
    FX.burst(ch.mesh.position, { count: 34, speed: 7, color: 0xffd166, life: 0.9, size: 0.2 });
    const n = ch.source === 'raidBoss' ? 3 : ch.source === 'dungeonBoss' ? 2 : 1;
    for (let i = 0; i < n; i++) this.grantLoot(ch.source);
    this.player.inventory.glimmer += 150 + Math.round(Math.random() * 250);
  }

  /** Route XP through the director so encounters need no player reference. */
  awardXP(amount, label = '') {
    if (this.player) this.player.awardXP(amount, label);
  }

  grantLoot(source) {
    const item = rollDrop(this.rng, {
      power: this.player.dropPower,
      source,
      classId: this.player.classDef.id
    });
    if (!item) return null;
    this.player.inventory.add(item);
    this.player.onLoot(item);
    return item;
  }

  /* ------------------------------------------------------------ ambient */

  _ambient(dt, player) {
    this.ambient.t -= dt;
    if (this.ambient.t > 0) return;
    this.ambient.t = 1.6;
    if (!player.alive) return;
    // Do not populate the world inside an activity space.
    if (this.dungeon.active || this.raid.active || this.lostSector.active) return;
    const reg = regionAt(player.pos.x, player.pos.z);
    const tbl = REGION_TABLE[reg.id];
    if (!tbl || !tbl.pool.length) return;

    Enemies.despawnFar(player.pos, 240);
    const nearby = Enemies.aliveIn(player.pos.x, player.pos.z, 150, e => !e.activity);
    const want = reg.id === 'rift' || reg.id === 'maw' ? 14 : 10;
    if (nearby.length >= want) return;

    // Spawn out of view: behind the player, or far enough to be a dot.
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = this.rng() * TAU;
      const r = 70 + this.rng() * 60;
      const x = player.pos.x + Math.cos(a) * r;
      const z = player.pos.z + Math.sin(a) * r;
      if (Math.hypot(x, z) < 90) continue;                 // never near the hub
      if (!World.terrainActive(x, heightAt(x, z) + 2, z)) continue;
      const y = heightAt(x, z);
      if (y < WORLD.seaLevel) continue;
      const typeId = this.rng.weighted(tbl.pool);
      const squadSize = typeId === 'chitter' ? 3 : typeId === 'captain' ? 1 : 2;
      for (let i = 0; i < squadSize; i++) {
        Enemies.spawnAtGround(typeId, x + (this.rng() - 0.5) * 10, z + (this.rng() - 0.5) * 10, {
          level: tbl.level, spawnFX: false
        });
      }
      break;
    }
  }

  /* ------------------------------------------------------------ patrols */

  _makePatrols() {
    const list = [];
    const rng = makeRNG(99);
    for (const reg of REGIONS) {
      if (reg.id === 'rally') continue;
      for (let i = 0; i < 2; i++) {
        const a = rng() * TAU;
        const r = reg.r * (0.3 + rng() * 0.45);
        const x = reg.x + Math.cos(a) * r, z = reg.z + Math.sin(a) * r;
        const y = heightAt(x, z);
        const mesh = marker(this.scene, x, y, z, reg.accent);
        list.push({
          id: `${reg.id}_${i}`, region: reg, x, y, z, mesh,
          active: false, kind: null, need: 0, have: 0, timer: 0, cooldown: 0
        });
      }
    }
    this.patrolObjective = null;
    return list;
  }

  _patrols(dt, player) {
    for (const p of this.patrols) {
      p.mesh.rotation.y += dt * 1.4;
      p.mesh.position.y = p.y + 2.2 + Math.sin(performance.now() * 0.002 + p.x) * 0.2;
      p.cooldown = Math.max(0, p.cooldown - dt);

      const d = Math.hypot(player.pos.x - p.x, player.pos.z - p.z);
      if (!p.active && d < 4 && p.cooldown <= 0 && !this.activePatrol && player.alive) {
        this._startPatrol(p, player);
      }
      if (!p.active && d < 120) {
        this.waypoints.push({ x: p.x, y: p.y + 2.4, z: p.z, label: 'Patrol', color: p.region.accent, kind: 'patrol' });
      }
    }

    const p = this.activePatrol;
    if (!p) { this.patrolObjective = null; return; }
    p.timer -= dt;
    this.updatePatrolExtras(dt, player);
    this.waypoints.push({ x: p.x, y: p.y + 2.4, z: p.z, label: 'Patrol', color: 0x9dff7a, kind: 'patrol' });
    this.patrolObjective = {
      title: 'PATROL — ' + p.region.name,
      sub: p.text,
      progress: p.need ? p.have / p.need : 0,
      timer: p.timer,
      kind: 'patrol'
    };
    if (p.have >= p.need) {
      p.active = false;
      p.cooldown = 40;
      this.activePatrol = null;
      this.banner('PATROL COMPLETE', p.region.name, 3);
      Audio.play('objective', { vol: 0.9 });
      this.awardXP(XP.patrol, 'Patrol');
      this.player.inventory.glimmer += 120;
      this.grantLoot('patrol');
    } else if (p.timer <= 0) {
      p.active = false;
      p.cooldown = 20;
      this.activePatrol = null;
      this.banner('PATROL FAILED', 'Out of time', 2.6);
      Audio.play('fail', { vol: 0.8 });
    }
  }

  _startPatrol(p, player) {
    const tbl = REGION_TABLE[p.region.id];
    const kinds = ['kill', 'kill', 'scan', 'survive'];
    p.kind = this.rng.pick(kinds);
    p.active = true;
    this.activePatrol = p;
    p.have = 0;
    if (p.kind === 'kill') {
      p.need = 8;
      p.timer = 180;
      p.text = `Cull the Riven — ${p.have}/${p.need}`;
    } else if (p.kind === 'scan') {
      p.need = 3;
      p.timer = 150;
      p.text = 'Scan three anomalies';
      p.scans = [];
      for (let i = 0; i < 3; i++) {
        const a = this.rng() * TAU;
        const r = 18 + this.rng() * 22;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        const y = heightAt(x, z);
        p.scans.push({ x, y, z, mesh: marker(this.scene, x, y, z, 0x9fe8ff), done: false });
      }
    } else {
      p.need = 1;
      p.timer = 60;
      p.text = 'Hold the beacon for 60s';
      for (let i = 0; i < 6; i++) {
        const a = this.rng() * TAU;
        Enemies.spawnAtGround(this.rng.weighted(tbl.pool), p.x + Math.cos(a) * 26, p.z + Math.sin(a) * 26, {
          level: tbl.level, activity: 'patrol'
        });
      }
    }
    Audio.play('objective', { vol: 0.8 });
    this.banner('PATROL ACCEPTED', p.region.name, 2.6);
  }

  notePatrolKill() {
    const p = this.activePatrol;
    if (p && p.kind === 'kill') {
      p.have++;
      p.text = `Cull the Riven — ${p.have}/${p.need}`;
    }
  }

  updatePatrolExtras(dt, player) {
    const p = this.activePatrol;
    if (!p) return;
    if (p.kind === 'scan') {
      for (const s of p.scans) {
        if (s.done) continue;
        this.waypoints.push({ x: s.x, y: s.y + 2.4, z: s.z, label: 'Scan', color: 0x9fe8ff, kind: 'scan' });
        s.mesh.rotation.y += dt * 3;
        if (Math.hypot(player.pos.x - s.x, player.pos.z - s.z) < 3.2) {
          s.done = true;
          this.scene.remove(s.mesh);
          p.have++;
          Audio.play('pickup', { vol: 0.8 });
        }
      }
    } else if (p.kind === 'survive') {
      if (Math.hypot(player.pos.x - p.x, player.pos.z - p.z) < 14) {
        p._hold = (p._hold || 0) + dt;
        p.text = `Hold the beacon — ${Math.ceil(Math.max(0, 60 - p._hold))}s`;
        if (p._hold >= 60) p.have = p.need;
      } else {
        p.text = 'Return to the beacon';
      }
      if (p.timer <= 0 && p._hold >= 55) p.have = p.need;
    }
  }

  /* ------------------------------------------------------- public event */

  _makePublicEvent() {
    const reg = REGIONS.find(r => r.id === 'rift');
    const x = reg.x, z = reg.z + 40;
    const y = heightAt(x, z);
    const self = {
      x, y, z, state: 'waiting', timer: 45, charge: 0, heroic: false, objective: null,
      servitorsKilled: 0, beacon: null, tag: 'event'
    };
    self.update = (dt, player) => this._eventUpdate(self, dt, player);
    return self;
  }

  _eventUpdate(ev, dt, player) {
    ev.objective = null;
    const dist = Math.hypot(player.pos.x - ev.x, player.pos.z - ev.z);

    if (ev.state === 'waiting') {
      ev.timer -= dt;
      if (dist < 220) {
        this.waypoints.push({ x: ev.x, y: ev.y + 3, z: ev.z, label: `Rift Fall ${fmtTime(Math.max(0, ev.timer))}`, color: 0x9dff7a, kind: 'event' });
      }
      if (ev.timer <= 0) this._eventStart(ev, player);
      return;
    }

    if (ev.state === 'active') {
      ev.timer -= dt;
      this.waypoints.push({ x: ev.x, y: ev.y + 3, z: ev.z, label: 'Rift Fall', color: 0x9dff7a, kind: 'event' });
      if (dist < 22 && player.alive) {
        ev.charge = clamp01(ev.charge + dt * 0.035 * (1 + (this.dirFireteamSize() - 1) * 0.4));
      }
      ev.beacon.rotation.y += dt * (1 + ev.charge * 4);
      ev.beacon.scale.setScalar(1 + ev.charge * 0.5);

      this._eventPopulate(ev, dt);

      ev.objective = {
        title: ev.heroic ? 'HEROIC — RIFT FALL' : 'PUBLIC EVENT — RIFT FALL',
        sub: ev.heroic ? 'Kill the Bulwark' : `Charge the beacon — ${Math.round(ev.charge * 100)}%`,
        progress: ev.heroic ? 0 : ev.charge,
        timer: ev.timer,
        kind: 'event'
      };

      if (!ev.heroic && ev.servitorsKilled >= 3 && ev.charge > 0.25) this._eventHeroic(ev);
      if (!ev.heroic && ev.charge >= 1) this._eventComplete(ev, false);
      if (ev.heroic && ev.boss && !ev.boss.alive) this._eventComplete(ev, true);
      if (ev.timer <= 0) this._eventFail(ev);
      return;
    }

    if (ev.state === 'cooldown') {
      ev.timer -= dt;
      if (ev.timer <= 0) { ev.state = 'waiting'; ev.timer = 150; }
    }
  }

  dirFireteamSize() { return this.fireteamSize || 1; }

  _eventStart(ev, player) {
    ev.state = 'active';
    ev.timer = 180;
    ev.charge = 0;
    ev.heroic = false;
    ev.servitorsKilled = 0;
    ev.boss = null;
    if (!ev.beacon) {
      ev.beacon = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2, 1), new THREE.MeshBasicMaterial({ color: 0x9dff7a }));
      ev.beacon.position.set(ev.x, ev.y + 2.4, ev.z);
      this.scene.add(ev.beacon);
      World.addCollider(ev.x, ev.y + 1.4, ev.z, 1.4, 1.6, 1.4, 0, 'beacon');
    }
    ev.beacon.visible = true;
    Audio.play('alarm', { vol: 0.8 });
    this.banner('RIFT FALL', 'A Riven skiff is dropping a beacon in the Verdant Rift', 4);
    // Three shielded servitors: kill them all before the charge finishes to go heroic.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      const p = ringPoint(ev.x, ev.z, 24, a);
      Enemies.spawnAtGround('servitor', p.x, p.z, {
        level: 6, activity: ev.tag,
        onDeath: () => { ev.servitorsKilled++; this.banner('SERVITOR DOWN', `${ev.servitorsKilled}/3`, 1.8); }
      });
    }
  }

  _eventPopulate(ev, dt) {
    ev._t = (ev._t || 0) - dt;
    if (ev._t > 0) return;
    ev._t = 3.2;
    const live = Enemies.countActivity(ev.tag);
    if (live > 12) return;
    const a = this.rng() * TAU;
    const p = ringPoint(ev.x, ev.z, 30 + this.rng() * 16, a);
    const typeId = this.rng.weighted([['skirmisher', 4], ['chitter', 3], ['marksman', 2], ['captain', 1]]);
    Enemies.spawnAtGround(typeId, p.x, p.z, { level: 6, activity: ev.tag });
  }

  _eventHeroic(ev) {
    ev.heroic = true;
    ev.timer = Math.max(ev.timer, 120);
    Audio.play('roar', { pos: _v.set(ev.x, ev.y, ev.z), vol: 1 });
    this.banner('HEROIC', 'The Bulwark answers', 3.4);
    ev.boss = Enemies.spawnAtGround('bulwark', ev.x + 12, ev.z + 12, {
      level: 9, activity: ev.tag, healthMul: 2.4, name: 'Bulwark Ordnance'
    });
  }

  _eventComplete(ev, heroic) {
    ev.state = 'cooldown';
    ev.timer = 90;
    ev.beacon.visible = false;
    Enemies.clearActivity(ev.tag);
    this.banner('EVENT COMPLETE', heroic ? 'Heroic clear' : 'Beacon charged', 3.4);
    Audio.play('objective', { vol: 1 });
    this.awardXP(heroic ? XP.eventHeroic : XP.event, 'Public event');
    this.dropChest(ev.x, ev.y, ev.z + 4, heroic ? 'lostSector' : 'event');
  }

  _eventFail(ev) {
    ev.state = 'cooldown';
    ev.timer = 60;
    ev.beacon.visible = false;
    Enemies.clearActivity(ev.tag);
    this.banner('EVENT FAILED', 'The beacon went dark', 2.8);
    Audio.play('fail', { vol: 0.8 });
  }

  /* -------------------------------------------------------- lost sector */

  _makeLostSector() {
    const ls = this.spec.lostSector;
    const self = {
      state: 'idle', objective: null, tag: 'lostsector', active: false,
      wave: 0, boss: null, cleared: false, cooldown: 0
    };
    self.update = (dt, player) => {
      self.objective = null;
      const c = ls.center;
      const inside = Math.hypot(player.pos.x - c.x, player.pos.z - c.z) < 30 && Math.abs(player.pos.y - c.y) < 14;
      self.active = inside && self.state === 'active';
      self.cooldown = Math.max(0, self.cooldown - dt);

      if (!inside) {
        this.waypoints.push({ x: ls.mouth.x, y: ls.mouth.y + 3, z: ls.mouth.z, label: 'Lost Sector', color: 0x9fe8ff, kind: 'lostsector' });
        if (self.state === 'active' && Math.hypot(player.pos.x - c.x, player.pos.z - c.z) > 70) {
          Enemies.clearActivity(self.tag);
          self.state = 'idle';
        }
        return;
      }
      if (self.state === 'idle' && self.cooldown <= 0) {
        self.state = 'active';
        self.wave = 0;
        self.cleared = false;
        Audio.play('alarm', { vol: 0.6 });
        this.banner('LOST SECTOR', 'Vault of the Quiet Hand', 3);
        self._spawnWave(1);
      }
      if (self.state !== 'active') return;

      const live = Enemies.countActivity(self.tag);
      self.objective = {
        title: 'LOST SECTOR — Vault of the Quiet Hand',
        sub: self.boss ? 'Kill Vault-Keeper Skarn' : `Clear the Riven — ${live} left`,
        progress: 0, kind: 'lostsector'
      };
      if (live === 0) {
        if (self.wave < 2) self._spawnWave(self.wave + 1);
        else if (!self.boss) self._spawnBoss();
        else if (!self.boss.alive && !self.cleared) {
          self.cleared = true;
          self.state = 'done';
          self.cooldown = 120;
          this.dropChest(ls.chestPos.x, ls.chestPos.y, ls.chestPos.z, 'lostSector');
          this.banner('SECTOR CLEARED', 'The vault opens', 3);
          this.awardXP(XP.lostSector, 'Lost Sector');
        }
      }
      if (self.boss && self.boss.alive) {
        this.waypoints.push({ x: self.boss.pos.x, y: self.boss.pos.y + 3, z: self.boss.pos.z, label: 'Skarn', color: 0xff6fb0, kind: 'boss' });
      }
    };
    self._spawnWave = n => {
      self.wave = n;
      const c = ls.center;
      const table = [['chitter', 4], ['skirmisher', 3], ['shank', 2], ['marksman', 1]];
      for (let i = 0; i < 5 + n * 2; i++) {
        const a = this.rng() * TAU;
        const r = 6 + this.rng() * 13;
        Enemies.spawn(this.rng.weighted(table), c.x + Math.cos(a) * r, c.y, c.z + Math.sin(a) * r, {
          level: 6, activity: self.tag
        });
      }
    };
    self._spawnBoss = () => {
      const b = ls.bossAnchor;
      self.boss = Enemies.spawn('sectorboss', b.x, b.y, b.z, { level: 8, activity: self.tag });
      Audio.play('roar', { pos: _v.set(b.x, b.y, b.z), vol: 1 });
      this.banner('VAULT-KEEPER SKARN', 'Break the shield', 3);
    };
    return self;
  }

  /* ------------------------------------------------------------ dungeon */

  _makeDungeon() {
    const D = this.spec.dungeon;
    const dir = this;
    const self = { objective: null, active: false, encounters: [], boss: null, cleared: false };

    /* --- E1: the Antechamber plates --- */
    const e1 = new Encounter(dir, {
      tag: 'd1', name: 'THE ANTECHAMBER', startLine: 'Charge three relays at once',
      center: { x: D.rooms.ante.x, y: D.floorY, z: D.rooms.ante.z }, radius: 26, vSpan: 16,
      onBegin() { D.gates.ante.setOpen(false); this.plateT = [0, 0, 0]; },
      onReset() { D.gates.ante.setOpen(false); this.plateT = [0, 0, 0]; },
      onComplete() { D.gates.ante.setOpen(true); dir.dropChest(D.rooms.ante.x - 14, D.floorY, D.rooms.ante.z + 14, 'dungeon'); }
    });
    e1.plateT = [0, 0, 0];
    e1.tick = function (dt, player) {
      this.maintain(dt, {
        count: 10 + dir.fireteamBonus(3), table: [['chitter', 4], ['skirmisher', 3], ['shank', 2], ['captain', 0.7]],
        center: this.center, radius: 20, level: 8, interval: 1.8
      });
      let charged = 0;
      for (let i = 0; i < D.plates.length; i++) {
        const pl = D.plates[i];
        const occupied = player.alive && Math.hypot(player.pos.x - pl.x, player.pos.z - pl.z) < pl.r && Math.abs(player.pos.y - pl.y) < 4;
        // Plates hold their charge briefly so one player can rotate all three.
        if (occupied) this.plateT[i] = Math.min(1, this.plateT[i] + dt * 0.6);
        else this.plateT[i] = Math.max(0, this.plateT[i] - dt * 0.16);
        if (this.plateT[i] >= 1) charged++;
        const c = this.plateT[i] >= 1 ? 0x9dff7a : this.plateT[i] > 0 ? 0xffd166 : 0x4b3d7a;
        pl.halo.material.color.setHex(c);
        pl.halo.scale.setScalar(0.9 + this.plateT[i] * 0.25);
        dir.waypoints.push({ x: pl.x, y: pl.y + 1.6, z: pl.z, label: `Relay ${i + 1}`, color: c, kind: 'plate' });
      }
      this.objective = {
        title: 'THE HOLLOW CHOIR — Antechamber',
        sub: `Relays charged ${charged}/3`,
        progress: (this.plateT[0] + this.plateT[1] + this.plateT[2]) / 3,
        kind: 'dungeon'
      };
      if (charged >= 3) this.complete();
    };

    /* --- E2: the Weavers (kill both within 5s) --- */
    const e2 = new Encounter(dir, {
      tag: 'd2', name: 'THE WEAVERS', startLine: 'They share a thread. Cut both.',
      center: { x: D.rooms.weavers.x, y: D.floorY, z: D.rooms.weavers.z }, radius: 30, vSpan: 18,
      onBegin() {
        D.gates.weavers.setOpen(false);
        this.pair = D.weaveAnchors.map((a, i) => Enemies.spawn('weaver', a.x, a.y, a.z, {
          level: 10, activity: this.tag, name: i === 0 ? 'Weaver Ith' : 'Weaver Oth'
        }));
        this.reviveT = 0;
      },
      onReset() { D.gates.weavers.setOpen(false); this.pair = null; },
      onComplete() { D.gates.weavers.setOpen(true); dir.dropChest(D.rooms.weavers.x - 18, D.floorY, D.rooms.weavers.z - 16, 'dungeon'); }
    });
    e2.tick = function (dt, player) {
      this.maintain(dt, {
        count: 8 + dir.fireteamBonus(2), table: [['chitter', 3], ['chorister', 2], ['skirmisher', 3]],
        center: this.center, radius: 22, level: 9, interval: 2.4
      });
      const pair = this.pair || [];
      const alive = pair.filter(e => e && e.alive);
      // Thread: while both live, they share damage. Kill one and the other
      // starts weaving it back unless you finish the job inside five seconds.
      if (alive.length === 2) {
        this.reviveT = 0;
        FX.tracer(
          _v.set(alive[0].pos.x, alive[0].pos.y + 1.6, alive[0].pos.z),
          new THREE.Vector3(alive[1].pos.x, alive[1].pos.y + 1.6, alive[1].pos.z),
          0x6fe0ff, 0.12, 0.35
        );
      } else if (alive.length === 1) {
        this.reviveT += dt;
        const left = Math.max(0, 5 - this.reviveT);
        if (this.reviveT >= 5) {
          const dead = pair.find(e => e && !e.alive);
          if (dead) {
            const anchor = D.weaveAnchors[pair.indexOf(dead)];
            const idx = pair.indexOf(dead);
            const revived = Enemies.spawn('weaver', anchor.x, anchor.y, anchor.z, {
              level: 10, activity: this.tag, name: dead.name
            });
            pair[idx] = revived;
            alive[0].vitals.heal(alive[0].vitals.maxHealth * 0.35);
            dir.banner('REWOVEN', 'You were too slow', 2.4);
            Audio.play('fail', { vol: 0.7 });
          }
          this.reviveT = 0;
        }
        this.objective = {
          title: 'THE HOLLOW CHOIR — The Weavers',
          sub: `Kill the other Weaver — ${left.toFixed(1)}s`,
          progress: 1 - left / 5, kind: 'dungeon', urgent: true
        };
      } else if (pair.length && alive.length === 0) {
        this.complete();
        return;
      }
      if (alive.length === 2) {
        this.objective = {
          title: 'THE HOLLOW CHOIR — The Weavers',
          sub: 'Kill both Weavers within five seconds of each other',
          progress: 1 - (alive[0].vitals.total + alive[1].vitals.total) / (alive[0].vitals.maxTotal + alive[1].vitals.maxTotal),
          kind: 'dungeon'
        };
      }
      for (const e of alive) {
        dir.waypoints.push({ x: e.pos.x, y: e.pos.y + 3.2, z: e.pos.z, label: e.name, color: 0x6fe0ff, kind: 'boss' });
      }
      this.bosses = alive;
    };

    /* --- E3: Choirmaster Ur --- */
    const e3 = new Encounter(dir, {
      tag: 'd3', name: 'CHOIRMASTER UR', startLine: 'Strip the choir. Then strip him.',
      center: { x: D.rooms.choir.x, y: D.floorY, z: D.rooms.choir.z }, radius: 40, vSpan: 26,
      onBegin() {
        this.boss = Enemies.spawn('choirmaster', D.bossAnchor.x, D.bossAnchor.y, D.bossAnchor.z, {
          level: 12, activity: this.tag
        });
        this.boss.immune = true;
        this.charged = 0;
        this.dmgWindow = 0;
        this.hymnT = 26;
        this.phaseCount = 0;
        for (const p of D.pylons) { p.charged = false; p.orb.material.color.setHex(0x3a2a44); }
        this._spawnChoristers();
      },
      onReset() {
        this.boss = null;
        for (const p of D.pylons) { p.charged = false; p.orb.material.color.setHex(0x3a2a44); }
        for (const c of dir.carryables) c.dispose();
        D.safePool.visible = false;
      },
      onComplete() {
        D.safePool.visible = false;
        dir.dropChest(D.chestPos.x, D.chestPos.y, D.chestPos.z, 'dungeonBoss');
        dir.banner('THE HOLLOW CHOIR', 'Dungeon complete', 5);
        dir.awardXP(XP.dungeonClear, 'Dungeon clear');
      }
    });
    e3._spawnChoristers = function () {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        const p = ringPoint(this.center.x + 10, this.center.z, 18, a);
        const e = Enemies.spawn('chorister', p.x, this.center.y, p.z, {
          level: 11, activity: this.tag,
          onDeath: (en) => {
            const c = new Carryable(dir.scene, en.pos.x, en.pos.y, en.pos.z, { color: 0xffd166, name: 'Light' });
            dir.carryables.push(c);
          }
        });
        if (e) e.name = 'Chorister';
      }
    };
    e3.tick = function (dt, player) {
      const boss = this.boss;
      if (!boss || !boss.alive) {
        if (this.startedOnce && boss && !boss.alive) { this.complete(); }
        return;
      }
      this.maintain(dt, {
        count: 8 + dir.fireteamBonus(3), table: [['chitter', 4], ['skirmisher', 3], ['shank', 1.5]],
        center: this.center, radius: 26, level: 10, interval: 2.6
      });

      // Dunk phase: carry light to a pylon.
      if (this.dmgWindow <= 0) {
        boss.immune = true;
        let charged = 0;
        for (const p of D.pylons) {
          if (p.charged) { charged++; continue; }
          dir.waypoints.push({ x: p.x, y: p.y + 4, z: p.z, label: 'Pylon', color: 0xffd166, kind: 'plate' });
          if (player.carrying && Math.hypot(player.pos.x - p.x, player.pos.z - p.z) < p.r && Math.abs(player.pos.y - p.y) < 4) {
            p.charged = true;
            p.orb.material.color.setHex(0x9dff7a);
            player.carrying.dispose();
            player.carrying = null;
            Audio.play('objective', { vol: 0.9 });
            dir.banner('PYLON CHARGED', `${charged + 1}/3`, 1.8);
          }
        }
        charged = D.pylons.filter(p => p.charged).length;
        if (charged >= 3) {
          this.dmgWindow = 22;
          this.phaseCount++;
          boss.immune = false;
          for (const p of D.pylons) { p.charged = false; p.orb.material.color.setHex(0x3a2a44); }
          Audio.play('superready', { vol: 1 });
          dir.banner('THE HYMN BREAKS', 'Damage phase', 2.6);
        }
        // Keep choristers coming so there is always light on the floor.
        if (Enemies.aliveIn(this.center.x, this.center.z, 60, e => e.type.id === 'chorister').length === 0 &&
            dir.carryables.length === 0) {
          this._spawnChoristers();
        }
        this.objective = {
          title: 'CHOIRMASTER UR', sub: `Carry Light to the pylons — ${charged}/3`,
          progress: charged / 3, kind: 'dungeon',
          boss: { name: 'Choirmaster Ur', pct: boss.vitals.total / boss.vitals.maxTotal, immune: true }
        };
      } else {
        this.dmgWindow -= dt;
        boss.immune = false;
        this.objective = {
          title: 'CHOIRMASTER UR', sub: `DAMAGE — ${this.dmgWindow.toFixed(1)}s`,
          progress: this.dmgWindow / 22, kind: 'dungeon', urgent: true,
          boss: { name: 'Choirmaster Ur', pct: boss.vitals.total / boss.vitals.maxTotal, immune: false }
        };
        if (this.dmgWindow <= 0) { boss.immune = true; this._spawnChoristers(); }
      }

      // The Hymn: a room-wide attack with one safe pool.
      this.hymnT -= dt;
      if (this.hymnT <= 4 && this.hymnT > 0) {
        if (!D.safePool.visible) {
          D.safePool.visible = true;
          const a = dir.rng() * TAU;
          D.safePool.position.set(this.center.x + Math.cos(a) * 16, D.floorY + 0.12, this.center.z + Math.sin(a) * 16);
          Audio.play('charge', { pos: boss.pos, vol: 0.9, dur: 4 });
          dir.banner('THE HYMN', 'Get in the pool', 2.4);
        }
        dir.waypoints.push({ x: D.safePool.position.x, y: D.floorY + 1, z: D.safePool.position.z, label: 'SAFE', color: 0x6fe0ff, kind: 'safe' });
      }
      if (this.hymnT <= 0) {
        this.hymnT = 30;
        const safe = player.alive && Math.hypot(player.pos.x - D.safePool.position.x, player.pos.z - D.safePool.position.z) < 7;
        D.safePool.visible = false;
        FX.ring(_v.set(boss.pos.x, D.floorY + 1, boss.pos.z), { color: 0xff6fb0, r1: 46, life: 1.1, alpha: 0.8 });
        Audio.play('roar', { pos: boss.pos, vol: 1 });
        if (!safe && player.alive) {
          Combat.damage(player, 9999, { source: boss, kind: 'wipe' });
          dir.banner('THE HYMN', 'You were not in the pool', 2.6);
        }
      }
      dir.waypoints.push({ x: boss.pos.x, y: boss.pos.y + 5, z: boss.pos.z, label: 'Choirmaster Ur', color: 0xff6fb0, kind: 'boss' });
    };

    self.encounters = [e1, e2, e3];
    self.update = (dt, player) => {
      self.objective = null;
      self.active = false;
      // Waypoint to the mouth from outside.
      const dm = Math.hypot(player.pos.x - D.mouth.x, player.pos.z - D.mouth.z);
      if (dm < 200 && !self.cleared) {
        this.waypoints.push({ x: D.mouth.x, y: D.mouth.y + 6, z: D.mouth.z, label: 'The Hollow Choir', color: 0x8b6bff, kind: 'dungeon' });
      }
      for (const e of self.encounters) {
        if (e.state === 'done') continue;
        const inside = e.inArena(player);
        if (inside) {
          self.active = true;
          if (e.state === 'idle') e.begin();
          if (e.state === 'active') {
            e.t += dt;
            e.tick(dt, player);
            if (e.objective) self.objective = e.objective;
          }
        } else if (e.state === 'active' && !inside) {
          // Leaving the arena resets it, the way an activity should — and
          // leaving upward (death, respawn, a long fall) counts as leaving.
          const far = Math.hypot(player.pos.x - e.center.x, player.pos.z - e.center.z) > e.radius + 22 ||
            Math.abs(player.pos.y - e.center.y) > (e.vSpan || 22) + 14;
          if (far) e.reset('leave');
        }
      }
      if (self.encounters.every(e => e.state === 'done') && !self.cleared) {
        self.cleared = true;
        this.banner('THE HOLLOW CHOIR', 'Cleared', 5);
      }
    };
    return self;
  }

  fireteamBonus(per) { return Math.round((this.dirFireteamSize() - 1) * per); }

  /* --------------------------------------------------------------- raid */

  _makeRaid() {
    const R = this.spec.raid;
    const dir = this;
    const self = { objective: null, active: false, encounters: [], cleared: false };

    /* --- E1: the Ascent --- */
    const e1 = new Encounter(dir, {
      tag: 'r1', name: 'THE ASCENT', startLine: 'Three conduits. One terminal.',
      center: { x: R.platforms.ascent.x, y: R.platforms.ascent.y, z: R.platforms.ascent.z }, radius: 40, vSpan: 20,
      onBegin() { this.deposited = 0; this.plateT = [0, 0, 0]; this.spawned = [false, false, false]; },
      onReset() {
        this.deposited = 0; this.plateT = [0, 0, 0]; this.spawned = [false, false, false];
        for (const c of dir.carryables) c.dispose();
      },
      onComplete() {
        R.lifts[1].locked = false;
        dir.dropChest(R.platforms.ascent.x - 20, R.platforms.ascent.y, R.platforms.ascent.z - 20, 'raid');
      }
    });
    e1.deposited = 0;
    e1.plateT = [0, 0, 0];
    e1.spawned = [false, false, false];
    e1.tick = function (dt, player) {
      this.maintain(dt, {
        count: 10 + dir.fireteamBonus(3), table: [['skirmisher', 4], ['chitter', 3], ['marksman', 2], ['captain', 0.8]],
        center: this.center, radius: 30, level: 13, interval: 2.0
      });
      for (let i = 0; i < R.plates.length; i++) {
        const pl = R.plates[i];
        if (this.spawned[i]) continue;
        const on = player.alive && Math.hypot(player.pos.x - pl.x, player.pos.z - pl.z) < pl.r && Math.abs(player.pos.y - pl.y) < 4;
        if (on) this.plateT[i] = Math.min(1, this.plateT[i] + dt * 0.55);
        else this.plateT[i] = Math.max(0, this.plateT[i] - dt * 0.2);
        pl.halo.material.color.setHex(this.plateT[i] >= 1 ? 0x9dff7a : this.plateT[i] > 0 ? 0xffd166 : 0x5a4a90);
        if (this.plateT[i] >= 1) {
          this.spawned[i] = true;
          const c = new Carryable(dir.scene, pl.x, pl.y, pl.z, { color: 0xc39dff, name: 'Conduit' });
          dir.carryables.push(c);
          Audio.play('spawn', { pos: _v.set(pl.x, pl.y, pl.z), vol: 0.9 });
          dir.banner('CONDUIT RELEASED', 'Carry it to the terminal', 2.2);
        }
        dir.waypoints.push({ x: pl.x, y: pl.y + 1.8, z: pl.z, label: `Plate ${i + 1}`, color: pl.halo.material.color.getHex(), kind: 'plate' });
      }
      // Carrying is a commitment: you get slower and you cannot sprint.
      if (player.carrying) {
        player.applyBuff('conduit', 'Carrying Conduit', 0.4, 1, 'debuff');
        dir.waypoints.push({ x: R.terminal.x, y: R.terminal.y + 2.5, z: R.terminal.z, label: 'Terminal', color: 0x9dff7a, kind: 'plate' });
        const d = Math.hypot(player.pos.x - R.terminal.x, player.pos.z - R.terminal.z);
        if (d < R.terminal.r && Math.abs(player.pos.y - R.terminal.y) < 4) {
          player.carrying.dispose();
          player.carrying = null;
          this.deposited++;
          Audio.play('objective', { vol: 1 });
          dir.banner('CONDUIT SET', `${this.deposited}/3`, 2);
        }
      }
      this.objective = {
        title: 'SPIRE OF THE SUNDERED SKY — The Ascent',
        sub: `Conduits delivered ${this.deposited}/3`,
        progress: this.deposited / 3, kind: 'raid'
      };
      if (this.deposited >= 3) this.complete();
    };

    /* --- E2: Gauntlet of Names --- */
    const e2 = new Encounter(dir, {
      tag: 'r2', name: 'GAUNTLET OF NAMES', startLine: 'Take their names. Give them to the pillar.',
      center: { x: R.platforms.gauntlet.x, y: R.platforms.gauntlet.y, z: R.platforms.gauntlet.z }, radius: 38, vSpan: 20,
      onBegin() {
        this.deposits = 0; this.stacks = 0; this.weightT = 12; this.weight = 0;
        this.bearers = [];
        this._spawnBearers();
      },
      onReset() { this.bearers = []; this.stacks = 0; this.weight = 0; if (dir.player) dir.player.clearBuff('weight'); },
      onComplete() {
        R.lifts[2].locked = false;
        if (dir.player) dir.player.clearBuff('weight');
        dir.dropChest(R.platforms.gauntlet.x + 18, R.platforms.gauntlet.y, R.platforms.gauntlet.z - 18, 'raid');
      }
    });
    e2._spawnBearers = function () {
      for (let i = 0; i < Math.min(4, 2 + dir.fireteamBonus(1)); i++) {
        const al = R.alcoves[i % R.alcoves.length];
        const e = Enemies.spawn('namebearer', al.x, al.y, al.z, {
          level: 15, activity: this.tag, name: ['Ith', 'Oth', 'Vel', 'Sarn'][i % 4] + ', a Name',
          onDeath: () => { this.stacks = Math.min(4, this.stacks + 1); dir.banner('NAME TAKEN', `${this.stacks} carried`, 1.6); }
        });
        if (e) this.bearers.push(e);
      }
    };
    e2.tick = function (dt, player) {
      this.maintain(dt, {
        count: 10 + dir.fireteamBonus(3), table: [['skirmisher', 4], ['chitter', 4], ['shank', 2], ['marksman', 1.5]],
        center: this.center, radius: 26, level: 14, interval: 2.0
      });
      // Sky's Weight: a stacking timer that kills you unless you cleanse.
      this.weightT -= dt;
      if (this.weightT <= 0) {
        this.weightT = 12;
        this.weight++;
        Audio.play('lowhealth', { vol: 0.8 });
        if (this.weight >= 10) {
          Combat.damage(player, 9999, { source: null, kind: 'wipe' });
          dir.banner("SKY'S WEIGHT", 'It crushed you', 2.6);
        }
      }
      if (player.alive) player.applyBuff('weight', "Sky's Weight", 13, this.weight, 'debuff');

      // The pillar is a solid block, so the cleanse zone is the ring around it
      // (and its roof) — not a point you could never stand on.
      const atPillar = player.alive &&
        Math.hypot(player.pos.x - R.pillar.x, player.pos.z - R.pillar.z) < R.pillar.r + 3.5 &&
        Math.abs(player.pos.y - R.pillar.y) < 13;
      if (atPillar) {
        this.weight = 0;
        this.weightT = 12;
        player.clearBuff('weight');
        if (this.stacks > 0) {
          this.deposits += this.stacks;
          dir.banner('NAMES GIVEN', `${Math.min(8, this.deposits)}/8`, 1.8);
          this.stacks = 0;
          Audio.play('objective', { vol: 0.9 });
        }
      }
      R.pillar.glow.material.color.setHex(atPillar ? 0x9dff7a : 0xffd166);
      dir.waypoints.push({ x: R.pillar.x, y: R.pillar.y + 6, z: R.pillar.z, label: 'Pillar', color: 0x9dff7a, kind: 'plate' });

      const aliveBearers = this.bearers.filter(b => b && b.alive);
      if (aliveBearers.length === 0 && this.deposits < 8) this._spawnBearers();
      for (const b of aliveBearers) {
        dir.waypoints.push({ x: b.pos.x, y: b.pos.y + 3.4, z: b.pos.z, label: b.name, color: 0xc39dff, kind: 'boss' });
      }

      this.objective = {
        title: 'SPIRE OF THE SUNDERED SKY — Gauntlet of Names',
        sub: `Names given ${Math.min(8, this.deposits)}/8 · carrying ${this.stacks} · weight ${this.weight}/10`,
        progress: Math.min(1, this.deposits / 8), kind: 'raid', urgent: this.weight >= 7
      };
      if (this.deposits >= 8) this.complete();
    };

    /* --- E3: Aetheron --- */
    const e3 = new Encounter(dir, {
      tag: 'r3', name: 'AETHERON, THE SUNDERED', startLine: 'Break the anchors. Then break him.',
      center: { x: R.platforms.aetheron.x, y: R.platforms.aetheron.y, z: R.platforms.aetheron.z }, radius: 52, vSpan: 26,
      onBegin() {
        this.boss = Enemies.spawn('aetheron', R.bossAnchor.x, R.bossAnchor.y, R.bossAnchor.z, {
          level: 20, activity: this.tag
        });
        this.boss.immune = true;
        this.dmgWindow = 0;
        this.enrage = 420;
        this.phaseCount = 0;
        this.sweepT = 34;
        this._spawnAnchors();
      },
      onReset() {
        this.boss = null;
        for (const a of R.anchors) { a.alive = true; a.orb.visible = true; a.enemy = null; }
      },
      onComplete() {
        dir.dropChest(R.chestPos.x, R.chestPos.y, R.chestPos.z, 'raidBoss');
        dir.banner('SPIRE OF THE SUNDERED SKY', 'RAID COMPLETE', 6);
        dir.awardXP(XP.raidClear, 'Raid clear');
        Audio.play('exotic', { vol: 1 });
      }
    });
    e3._spawnAnchors = function () {
      for (const a of R.anchors) {
        a.alive = true;
        a.orb.visible = true;
        a.enemy = Enemies.spawn('namebearer', a.x, a.y - 6, a.z, {
          level: 18, activity: this.tag, healthMul: 1.6, name: 'Shield Anchor',
          onDeath: () => { a.alive = false; a.orb.visible = false; Audio.play('shieldpop', { pos: _v.set(a.x, a.y, a.z), vol: 1 }); }
        });
      }
    };
    e3.tick = function (dt, player) {
      const boss = this.boss;
      if (!boss) return;
      if (!boss.alive) { this.complete(); return; }
      this.enrage -= dt;
      if (this.enrage <= 0) {
        Combat.damage(player, 9999, { source: boss, kind: 'wipe' });
        dir.banner('ENRAGE', 'The Spire finishes what it started', 3);
        return;
      }
      this.maintain(dt, {
        count: 12 + dir.fireteamBonus(4), table: [['skirmisher', 4], ['chitter', 4], ['shank', 2], ['captain', 1], ['servitor', 0.5]],
        center: this.center, radius: 34, level: 16, interval: 1.8
      });

      const anchorsLeft = R.anchors.filter(a => a.alive).length;
      if (this.dmgWindow <= 0) {
        boss.immune = true;
        for (const a of R.anchors) {
          if (!a.alive) continue;
          a.orb.rotation.y += dt * 2;
          dir.waypoints.push({ x: a.x, y: a.y + 2, z: a.z, label: 'Anchor', color: 0xffd166, kind: 'plate' });
        }
        if (anchorsLeft === 0) {
          this.dmgWindow = 26;
          this.phaseCount++;
          boss.immune = false;
          Audio.play('superready', { vol: 1 });
          dir.banner('SHIELD DOWN', 'Damage phase', 2.6);
        }
        this.objective = {
          title: 'AETHERON, THE SUNDERED',
          sub: `Destroy the shield anchors — ${4 - anchorsLeft}/4`,
          progress: (4 - anchorsLeft) / 4, kind: 'raid',
          boss: { name: 'Aetheron, the Sundered', pct: boss.vitals.total / boss.vitals.maxTotal, immune: true },
          timer: this.enrage
        };
      } else {
        this.dmgWindow -= dt;
        this.objective = {
          title: 'AETHERON, THE SUNDERED',
          sub: `DAMAGE — ${this.dmgWindow.toFixed(1)}s`,
          progress: this.dmgWindow / 26, kind: 'raid', urgent: true,
          boss: { name: 'Aetheron, the Sundered', pct: boss.vitals.total / boss.vitals.maxTotal, immune: false },
          timer: this.enrage
        };
        if (this.dmgWindow <= 0) {
          boss.immune = true;
          // He repositions across the platform, then the anchors come back.
          const a = dir.rng() * TAU;
          boss.pos.set(this.center.x + Math.cos(a) * 22, this.center.y, this.center.z + Math.sin(a) * 22);
          FX.burst(boss.pos, { count: 40, speed: 12, color: 0xc39dff, life: 0.8, size: 0.24 });
          this._spawnAnchors();
          dir.banner('HE MOVES', 'Anchors restored', 2.4);
        }
      }

      // Sweep: a room-wide attack that demands you keep moving.
      this.sweepT -= dt;
      if (this.sweepT <= 0) {
        this.sweepT = 30;
        Audio.play('roar', { pos: boss.pos, vol: 1 });
        dir.banner('SUNDERING SWEEP', 'Break line of sight', 2.4);
        const wave = { r: 2, t: 0 };
        this._sweep = wave;
      }
      if (this._sweep) {
        this._sweep.t += dt;
        this._sweep.r += dt * 26;
        FX.ring(_v.set(boss.pos.x, this.center.y + 1, boss.pos.z), { color: 0xffd166, r0: this._sweep.r - 1, r1: this._sweep.r, life: 0.12, alpha: 0.8 });
        const pd = Math.hypot(player.pos.x - boss.pos.x, player.pos.z - boss.pos.z);
        if (player.alive && Math.abs(pd - this._sweep.r) < 2.4 && Math.abs(player.pos.y - this.center.y) < 3.5) {
          Combat.damage(player, 120, { source: boss, kind: 'sweep' });
          this._sweep = null;
        } else if (this._sweep.r > 60) this._sweep = null;
      }

      dir.waypoints.push({ x: boss.pos.x, y: boss.pos.y + 6.5, z: boss.pos.z, label: 'Aetheron', color: 0xc39dff, kind: 'boss' });
    };

    self.encounters = [e1, e2, e3];
    self.update = (dt, player) => {
      self.objective = null;
      self.active = false;
      const de = Math.hypot(player.pos.x - R.entry.x, player.pos.z - R.entry.z);
      if (de < 260 && !self.cleared) {
        this.waypoints.push({ x: R.entry.x, y: R.entry.y + 8, z: R.entry.z, label: 'Spire of the Sundered Sky', color: 0xc39dff, kind: 'raid' });
      }
      for (const e of self.encounters) {
        if (e.state === 'done') continue;
        const inside = e.inArena(player);
        if (inside) {
          self.active = true;
          if (e.state === 'idle') e.begin();
          if (e.state === 'active') {
            e.t += dt;
            e.tick(dt, player);
            if (e.objective) self.objective = e.objective;
          }
        } else if (e.state === 'active') {
          const far = Math.hypot(player.pos.x - e.center.x, player.pos.z - e.center.z) > e.radius + 26 ||
            Math.abs(player.pos.y - e.center.y) > 40;
          if (far) e.reset('leave');
        }
      }
      if (self.encounters.every(e => e.state === 'done') && !self.cleared) {
        self.cleared = true;
      }
    };
    return self;
  }

  /** A player death inside an encounter wipes it (solo rules). */
  onPlayerDeath() {
    for (const group of [this.dungeon, this.raid]) {
      if (!group) continue;
      for (const e of group.encounters) if (e.state === 'active') e.reset('wipe');
    }
    if (this.lostSector.state === 'active') {
      Enemies.clearActivity(this.lostSector.tag);
      this.lostSector.state = 'idle';
      this.lostSector.cooldown = 5;
    }
    if (this.player && this.player.carrying) { this.player.carrying.dispose(); this.player.carrying = null; }
  }

  /** Kill hook: patrol counters, ammo bricks, world drops. */
  onEnemyKilled(enemy, info) {
    this.notePatrolKill();
    const src = enemy.tier === 'boss' ? 'major' : enemy.dropSource;
    if (Math.random() < (SOURCES[src] ? SOURCES[src].chance : 0.08)) {
      const item = rollDrop(this.rng, { power: this.player.dropPower, source: src, classId: this.player.classDef.id });
      if (item) { this.player.inventory.add(item); this.player.onLoot(item); }
    }
  }
}

export const Activities = new ActivityDirector();
export default Activities;
