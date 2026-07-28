/* STARFALL — net.js
   The MMO layer, kept deliberately small and strictly additive: if the socket
   never opens, the game runs exactly as it does solo.

   Model: the server groups players into a shard and names one of them HOST.
   The host simulates enemies and activities and streams snapshots; everyone
   else mirrors them and sends damage upstream. Players themselves are always
   client-authoritative — this is co-op, not a competitive shooter. */

import * as THREE from 'three';
import { clamp01, lerp, damp } from './util.js';
import { CLASSES } from './classes.js';
import { mergeParts } from './enemies.js';

const SEND_HZ = 14;
const SNAP_HZ = 10;

function guardianGeo(color) {
  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const SPH = new THREE.SphereGeometry(0.5, 8, 6);
  const M = (x, y, z, sx, sy, sz) => {
    const m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
    return m;
  };
  return mergeParts([
    { geo: BOX.clone(), matrix: M(0, 1.0, 0, 0.66, 1.0, 0.42), color: 0x3a4250 },
    { geo: SPH.clone(), matrix: M(0, 1.68, 0.04, 0.44, 0.44, 0.48), color: 0x5a6470 },
    { geo: BOX.clone(), matrix: M(0, 1.7, 0.24, 0.3, 0.1, 0.1), color },
    { geo: BOX.clone(), matrix: M(-0.5, 1.2, 0, 0.2, 0.62, 0.24), color: 0x2e3540 },
    { geo: BOX.clone(), matrix: M(0.5, 1.2, 0, 0.2, 0.62, 0.24), color: 0x2e3540 },
    { geo: BOX.clone(), matrix: M(0.42, 1.15, 0.4, 0.14, 0.14, 0.8), color: 0x22272f },
    { geo: BOX.clone(), matrix: M(-0.24, 0.45, 0, 0.22, 0.9, 0.26), color: 0x333b46 },
    { geo: BOX.clone(), matrix: M(0.24, 0.45, 0, 0.22, 0.9, 0.26), color: 0x333b46 },
    { geo: BOX.clone(), matrix: M(0, 1.25, -0.32, 0.5, 0.7, 0.14), color }        // cloak/mark
  ]);
}

class NetClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.id = null;
    this.isHost = true;          // solo players are always their own host
    this.remotes = new Map();
    this.scene = null;
    this.game = null;
    this.sendT = 0;
    this.snapT = 0;
    this.pendingHits = [];
    this.status = 'offline';
    this.geoCache = new Map();
  }

  get fireteamSize() { return 1 + this.remotes.size; }

  init(scene, game) {
    this.scene = scene;
    this.game = game;
  }

  connect(url) {
    if (!url) { this.status = 'solo'; return; }
    if (url === 'auto') {
      if (typeof location === 'undefined' || !location.host) { this.status = 'solo'; return; }
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      url = `${proto}://${location.host}`;
    }
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.status = 'solo';
      return;
    }
    this.status = 'connecting';
    this.ws.onopen = () => {
      this.connected = true;
      this.status = 'connected';
      this.send({ t: 'hello', name: this.game.player.name, classId: this.game.player.classDef.id });
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.status = 'offline';
      this.isHost = true;
      for (const r of this.remotes.values()) this.scene.remove(r.mesh);
      this.remotes.clear();
      if (this.game && this.game.hud) this.game.hud.toast('FIRETEAM OFFLINE', '#ff5d3c', 'Playing solo');
    };
    this.ws.onerror = () => { this.status = 'offline'; };
    this.ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      this._handle(msg);
    };
  }

  send(obj) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* socket died mid-frame */ }
  }

  /* ------------------------------------------------------------ inbound */

  _handle(m) {
    const g = this.game;
    switch (m.t) {
      case 'welcome':
        this.id = m.id;
        this.isHost = !!m.host;
        if (g.hud) g.hud.toast(this.isHost ? 'SHARD HOST' : 'JOINED FIRETEAM', '#6fe0ff', `${m.count} guardian${m.count === 1 ? '' : 's'} on the shore`);
        for (const p of m.players || []) this._addRemote(p);
        break;
      case 'join':
        this._addRemote(m);
        if (g.hud) g.hud.chat(`${m.name} joined the fireteam`);
        break;
      case 'leave': {
        const r = this.remotes.get(m.id);
        if (r) { this.scene.remove(r.mesh); this.remotes.delete(m.id); }
        if (g.hud) g.hud.chat(`${m.name || 'A guardian'} left`);
        break;
      }
      case 'host':
        this.isHost = m.id === this.id;
        if (this.isHost && g.hud) g.hud.toast('YOU ARE THE HOST', '#ffd166', 'Simulating the shard');
        break;
      case 'states':
        for (const s of m.p) {
          if (s.id === this.id) continue;
          const r = this.remotes.get(s.id);
          if (!r) continue;
          r.target.set(s.x, s.y, s.z);
          r.yaw = s.yaw;
          r.healthPct = s.h;
          r.superOn = !!s.s;
          r.last = 0;
        }
        break;
      case 'chat':
        if (g.hud) g.hud.chat(`${m.name}: ${m.text}`);
        break;
      case 'esnap':
        if (!this.isHost) g.mirrorEnemies(m.e);
        break;
      case 'edie':
        if (!this.isHost) g.mirrorEnemyDeath(m.id);
        break;
      case 'ehit':
        if (this.isHost) g.applyRemoteHit(m);
        break;
      case 'obj':
        if (!this.isHost) g.remoteObjective = m.o || null;
        break;
      case 'banner':
        if (!this.isHost && g.activities) g.activities.banner(m.title, m.sub, 3);
        break;
    }
  }

  _addRemote(p) {
    if (p.id === this.id || this.remotes.has(p.id)) return;
    const cls = CLASSES[p.classId] || CLASSES.warden;
    let geo = this.geoCache.get(cls.id);
    if (!geo) { geo = guardianGeo(cls.color); this.geoCache.set(cls.id, geo); }
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.scene.add(mesh);
    this.remotes.set(p.id, {
      id: p.id, name: p.name || 'Guardian', classId: cls.id, color: cls.css,
      pos: new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0),
      target: new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0),
      yaw: 0, mesh, healthPct: 1, last: 0, superOn: false
    });
  }

  /* ----------------------------------------------------------- outbound */

  update(dt, player) {
    for (const r of this.remotes.values()) {
      r.last += dt;
      // Interpolate toward the last snapshot; hide anyone who went quiet.
      r.pos.x = damp(r.pos.x, r.target.x, 12, dt);
      r.pos.y = damp(r.pos.y, r.target.y, 12, dt);
      r.pos.z = damp(r.pos.z, r.target.z, 12, dt);
      r.mesh.position.copy(r.pos);
      r.mesh.rotation.y = r.yaw;
      r.mesh.visible = r.last < 4;
    }
    if (!this.connected) return;

    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 1 / SEND_HZ;
      this.send({
        t: 'state',
        x: +player.pos.x.toFixed(2), y: +player.pos.y.toFixed(2), z: +player.pos.z.toFixed(2),
        yaw: +player.yaw.toFixed(2),
        h: +clamp01(player.vitals.total / player.vitals.maxTotal).toFixed(2),
        s: player.abilities.superActive ? 1 : 0
      });
    }

    if (this.pendingHits.length) {
      for (const h of this.pendingHits) this.send({ t: 'ehit', id: h.id, d: h.d, c: h.c ? 1 : 0 });
      this.pendingHits.length = 0;
    }
  }

  reportHit(netId, dmg, crit) {
    if (!this.connected || this.isHost) return;
    this.pendingHits.push({ id: netId, d: Math.round(dmg), c: crit });
  }

  sendSnapshot(enemies) {
    if (!this.connected || !this.isHost) return;
    const e = [];
    for (const en of enemies) {
      if (!en.alive || !en.netId) continue;
      e.push([en.netId, en.type.id, +en.pos.x.toFixed(1), +en.pos.y.toFixed(1), +en.pos.z.toFixed(1),
        +en.yaw.toFixed(2), +clamp01(en.vitals.total / en.vitals.maxTotal).toFixed(2), en.level | 0]);
    }
    this.send({ t: 'esnap', e });
  }

  sendDeath(netId) {
    if (!this.connected || !this.isHost) return;
    this.send({ t: 'edie', id: netId });
  }

  sendObjective(o) {
    if (!this.connected || !this.isHost) return;
    this.send({ t: 'obj', o });
  }

  sendBanner(title, sub) {
    if (!this.connected || !this.isHost) return;
    this.send({ t: 'banner', title, sub });
  }

  chat(text) {
    if (!text) return;
    if (this.connected) this.send({ t: 'chat', text: text.slice(0, 140) });
    else if (this.game && this.game.hud) this.game.hud.chat(`You: ${text} (offline)`);
  }
}

export const Net = new NetClient();
export default Net;
