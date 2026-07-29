/* STARFALL — hud.js
   One canvas overlay for everything diegetic: crosshair, shields, abilities,
   super, ammo, objectives, boss bars, waypoints, radar, damage numbers.

   Canvas (not DOM) because most of this is world-projected and changes every
   frame; DOM is reserved for the full-screen menus in ui.js. */

import * as THREE from 'three';
import { clamp, clamp01, lerp, fmtTime, fmtInt } from './util.js';
import Combat from './combat.js';
import { RARITY } from './loot.js';
import { LEVEL_CAP } from './progress.js';
import Enemies from './enemies.js';

const _p = new THREE.Vector3();
const _camDir = new THREE.Vector3();

class HUDSystem {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.W = 0; this.H = 0;
    this.dpr = 1;
    this.toasts = [];
    this.discovered = new Set();
    this.hitFade = 0;
    this.chatLog = [];
    this.showRadar = true;
  }

  init(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.resize();
  }

  resize() {
    if (!this.canvas) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.floor(this.W * this.dpr);
    this.canvas.height = Math.floor(this.H * this.dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
  }

  toast(text, color = '#dff3ff', sub = '') {
    this.toasts.push({ text, sub, color, t: 4.2 });
    if (this.toasts.length > 5) this.toasts.shift();
  }

  chat(line) {
    this.chatLog.push({ line, t: 14 });
    if (this.chatLog.length > 8) this.chatLog.shift();
  }

  /* ------------------------------------------------------------ helpers */

  project(x, y, z, camera) {
    _p.set(x, y, z);
    camera.getWorldDirection(_camDir);
    const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z;
    const behind = dx * _camDir.x + dy * _camDir.y + dz * _camDir.z <= 0.05;
    _p.project(camera);
    return {
      x: (_p.x * 0.5 + 0.5) * this.W,
      y: (-_p.y * 0.5 + 0.5) * this.H,
      behind,
      dist: Math.hypot(dx, dy, dz)
    };
  }

  bar(x, y, w, h, pct, color, bg = 'rgba(0,0,0,0.55)', skew = 0) {
    const c = this.ctx;
    c.fillStyle = bg;
    c.fillRect(x, y, w, h);
    c.fillStyle = color;
    c.fillRect(x, y, w * clamp01(pct), h);
  }

  text(str, x, y, { size = 14, color = '#dff3ff', align = 'left', weight = '600', shadow = true, font = 'Rajdhani, "Segoe UI", sans-serif', alpha = 1 } = {}) {
    const c = this.ctx;
    c.save();
    c.globalAlpha *= alpha;
    c.font = `${weight} ${size}px ${font}`;
    c.textAlign = align;
    c.textBaseline = 'alphabetic';
    if (shadow) {
      c.fillStyle = 'rgba(0,0,0,0.75)';
      c.fillText(str, x + 1.5, y + 1.5);
    }
    c.fillStyle = color;
    c.fillText(str, x, y);
    c.restore();
  }

  /* --------------------------------------------------------------- draw */

  draw(dt, game) {
    if (!this.ctx) return;
    const c = this.ctx;
    const { player, camera, activities, net } = game;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.W, this.H);

    for (let i = this.toasts.length - 1; i >= 0; i--) {
      this.toasts[i].t -= dt;
      if (this.toasts[i].t <= 0) this.toasts.splice(i, 1);
    }
    for (let i = this.chatLog.length - 1; i >= 0; i--) {
      this.chatLog[i].t -= dt;
      if (this.chatLog[i].t <= 0) this.chatLog.splice(i, 1);
    }

    this._damageNumbers(c, camera);
    this._nameplates(c, camera, game);
    this._waypoints(c, camera, activities, player);
    if (player.alive) this._crosshair(c, player);
    this._vitals(c, player);
    this._abilities(c, player);
    this._weapon(c, player);
    this._objective(c, activities);
    this._banners(c, activities);
    this._killFeed(c);
    this._toasts(c);
    if (this.showRadar) this._radar(c, player, game);
    this._compass(c, player);
    this._buffs(c, player);
    this._interact(c, player, game);
    this._chat(c, net);
    this._vignette(c, player);
    if (!player.alive) this._deathScreen(c, player, game);
  }

  /* ------------------------------------------------------------ pieces  */

  _crosshair(c, player) {
    const w = player.currentWeapon;
    const cx = this.W / 2, cy = this.H / 2;
    const moving = Math.hypot(player.velocity.x, player.velocity.z) > 2.5 || !player.grounded;
    const def = w ? w.def : null;
    let spread = def ? (player.ads > 0.6 ? def.adsSpread : def.hipSpread) : 1;
    spread *= moving ? 1.35 : 1;
    const gap = 5 + spread * 3.4 + (player.sprinting ? 6 : 0);
    const len = 6;
    const superOn = !!player.abilities.superActive;
    const col = superOn ? player.classDef.css : (def && def.scope && player.ads > 0.85 ? 'rgba(0,0,0,0)' : '#dff3ff');

    c.save();
    c.globalAlpha = player.sprinting ? 0.35 : 0.95;
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.beginPath();
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      c.moveTo(cx + dx * gap, cy + dy * gap);
      c.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
    }
    c.stroke();
    c.fillStyle = col;
    c.fillRect(cx - 1, cy - 1, 2, 2);

    // Sniper scope: a real scope overlay at full ADS.
    if (def && def.scope && player.ads > 0.8) {
      const k = clamp01((player.ads - 0.8) / 0.2);
      c.globalAlpha = k;
      const r = Math.min(this.W, this.H) * 0.36;
      c.fillStyle = 'rgba(0,0,0,0.92)';
      c.beginPath();
      c.rect(0, 0, this.W, this.H);
      c.arc(cx, cy, r, 0, Math.PI * 2, true);
      c.fill();
      c.strokeStyle = 'rgba(143,216,255,0.6)';
      c.lineWidth = 2;
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
      c.beginPath();
      c.moveTo(cx - r, cy); c.lineTo(cx - 12, cy);
      c.moveTo(cx + 12, cy); c.lineTo(cx + r, cy);
      c.moveTo(cx, cy - r); c.lineTo(cx, cy - 12);
      c.moveTo(cx, cy + 12); c.lineTo(cx, cy + r);
      c.stroke();
    }

    // Hitmarker.
    if (Combat.hitFlash > 0) {
      const k = clamp01(Combat.hitFlash / 0.24);
      c.globalAlpha = k;
      c.strokeStyle = Combat.hitKill ? '#ff5d3c' : Combat.hitCrit ? '#ffd166' : '#ffffff';
      c.lineWidth = Combat.hitKill ? 3 : 2;
      const g2 = 4, l2 = 8;
      c.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        c.moveTo(cx + dx * g2, cy + dy * g2);
        c.lineTo(cx + dx * (g2 + l2), cy + dy * (g2 + l2));
      }
      c.stroke();
    }
    c.restore();
  }

  _vitals(c, player) {
    const x = 34, y = this.H - 118;
    const v = player.vitals;
    const w = 260;

    // Shield above health, Halo order, with the overshield stacked on top.
    if (v.maxOvershield > 0 && v.overshield > 0) {
      this.bar(x, y - 16, w, 7, v.overshield / v.maxOvershield, '#ffd166', 'rgba(0,0,0,0.4)');
    }
    this.bar(x, y, w, 11, v.shieldPct, v.recharging ? '#bfe8ff' : '#6fb6ff');
    this.bar(x, y + 14, w, 7, v.healthPct, v.healthPct < 0.35 ? '#ff5d3c' : '#dff3ff');

    this.text(player.name.toUpperCase(), x, y - 24, { size: 13, color: '#9fb4c9', weight: '700' });
    this.text(`${player.classDef.name.toUpperCase()} · ${player.power}`, x + w, y - 24, { size: 13, color: player.classDef.css, align: 'right', weight: '700' });

    this._rank(c, player, x, y - 38, w);
  }

  /** Rank bar: sits above the name, the one number that only ever goes up. */
  _rank(c, player, x, y, w) {
    const pr = player.progress;
    if (!pr) return;
    const capped = pr.level >= LEVEL_CAP;
    this.bar(x, y, w, 5, pr.pct, capped ? '#f5c542' : '#ffd166', 'rgba(0,0,0,0.5)');
    this.text(`RANK ${pr.level}`, x, y - 6, { size: 12, color: '#ffd166', weight: '700' });
    this.text(capped ? 'MAX' : `${Math.round(pr.xp)} / ${pr.next}`, x + w, y - 6,
      { size: 11, color: '#7c8b9c', align: 'right', weight: '600' });

    // Floating "+XP" ticks, newest at the bottom, fading as they age.
    let ty = y - 20;
    for (let i = pr.recentXP.length - 1; i >= 0; i--) {
      const r = pr.recentXP[i];
      this.text(`+${r.amount} XP${r.label ? '  ' + r.label : ''}`, x, ty,
        { size: 11, color: '#ffd166', weight: '600', alpha: clamp01(r.t / 1.2) });
      ty -= 13;
    }
  }

  _abilities(c, player) {
    const a = player.abilities;
    const st = player.stats;
    const size = 44;
    const gap = 10;
    const x0 = 34;
    const y = this.H - 74;
    const trav = player.classDef.traversal;
    const items = [
      { key: 'Q', label: 'GRENADE', cd: a.grenadeCd, max: st.grenadeCd, color: '#ff9a3c' },
      { key: 'V', label: 'MELEE', cd: a.meleeCd, max: st.meleeCd, color: '#ffd166' },
      { key: 'E', label: player.classDef.classAbility.name.toUpperCase(), cd: a.classCd, max: st.classCd, color: player.classDef.css },
      { key: 'C', label: trav.name.toUpperCase(), cd: a.traversalCd, max: trav.cd, color: '#9dff7a' }
    ];
    items.forEach((it, i) => {
      const x = x0 + i * (size + gap);
      const ready = it.cd <= 0;
      c.save();
      c.fillStyle = 'rgba(6,10,18,0.72)';
      c.fillRect(x, y, size, size);
      if (!ready) {
        const k = clamp01(1 - it.cd / Math.max(0.001, it.max));
        c.fillStyle = 'rgba(255,255,255,0.14)';
        c.fillRect(x, y + size * (1 - k), size, size * k);
      } else {
        c.fillStyle = it.color;
        c.globalAlpha = 0.22;
        c.fillRect(x, y, size, size);
        c.globalAlpha = 1;
      }
      c.strokeStyle = ready ? it.color : 'rgba(255,255,255,0.25)';
      c.lineWidth = 2;
      c.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      c.restore();
      this.text(it.key, x + size / 2, y + size / 2 + 7, { size: 19, align: 'center', weight: '700', color: ready ? '#ffffff' : '#7e8ea0' });
      if (!ready) this.text(Math.ceil(it.cd) + 's', x + size / 2, y + size + 13, { size: 11, align: 'center', color: '#7e8ea0' });
    });

    // Super meter.
    const sx = x0, sy = y + size + 20, sw = 3 * size + 2 * gap;
    const full = a.superEnergy >= 1;
    const pulse = full ? 0.72 + Math.sin(performance.now() * 0.006) * 0.28 : 1;
    c.save();
    c.globalAlpha = pulse;
    this.bar(sx, sy, sw, 9, a.superActive ? a.superActive.t / a.superActive.dur : a.superEnergy,
      a.superActive ? '#ffffff' : player.classDef.css, 'rgba(0,0,0,0.6)');
    c.restore();
    this.text(a.superActive ? player.classDef.super.name : (full ? `X · ${player.classDef.super.name} READY` : player.classDef.super.name),
      sx, sy + 22, { size: 11, color: full || a.superActive ? player.classDef.css : '#7e8ea0', weight: '700' });
  }

  _weapon(c, player) {
    const w = player.currentWeapon;
    const x = this.W - 34;
    const y = this.H - 60;
    if (!w) return;
    const rar = RARITY[w.item.rarity];
    this.text(w.name.toUpperCase(), x, y - 44, { size: 16, align: 'right', color: rar.css, weight: '700' });
    this.text(w.def.label.toUpperCase(), x, y - 27, { size: 11, align: 'right', color: '#7e8ea0' });

    if (w.def.mode === 'melee') {
      // Blades have no ammo to count. Show what you are actually trading for.
      this.text('∞', x - 62, y + 4, { size: 40, align: 'right', color: '#9dff7a', weight: '700' });
      this.text(`+${Math.round((w.def.moveMul - 1) * 100)}% SPEED`, x, y + 4,
        { size: 14, align: 'right', color: '#9dff7a', weight: '700' });
    } else {
      const ammoCol = w.reloading > 0 ? '#ffd166' : (w.ammo / w.mag < 0.25 ? '#ff5d3c' : '#dff3ff');
      this.text(String(w.ammo), x - 62, y + 4, { size: 40, align: 'right', color: ammoCol, weight: '700' });
      this.text('/ ' + w.reserve, x, y + 4, { size: 18, align: 'right', color: '#7e8ea0', weight: '600' });
    }

    if (w.reloading > 0) {
      const k = 1 - w.reloading / w.reloadTime;
      this.bar(x - 150, y + 14, 150, 4, k, '#ffd166', 'rgba(0,0,0,0.5)');
      this.text('RELOADING', x - 150, y + 30, { size: 11, color: '#ffd166' });
    } else if (w.charge > 0) {
      this.bar(x - 150, y + 14, 150, 4, clamp01(w.charge / w.def.charge), '#6fe0ff', 'rgba(0,0,0,0.5)');
    }

    // Slot pips.
    const slots = ['kinetic', 'energy', 'power'];
    slots.forEach((s, i) => {
      const px = x - 150 + i * 26;
      const active = player.currentSlot === s;
      const has = !!player.weapons[s];
      c.save();
      c.globalAlpha = has ? 1 : 0.25;
      c.fillStyle = active ? '#dff3ff' : 'rgba(255,255,255,0.22)';
      c.fillRect(px, y - 66, 20, 4);
      c.restore();
    });

    // Perks, so a good roll is visible mid-fight.
    if (w.perks.length) {
      const names = w.perks.map(p => p.toUpperCase()).join(' · ');
      this.text(names, x, y + 30, { size: 10, align: 'right', color: 'rgba(223,243,255,0.45)' });
    }
    if (w.rampage > 0) this.text(`RAMPAGE x${w.rampage}`, x, y + 44, { size: 11, align: 'right', color: '#ff9a3c', weight: '700' });
  }

  _objective(c, activities) {
    const o = activities.objective;
    if (!o) return;
    const cx = this.W / 2;
    const y = 62;
    this.text(o.title, cx, y, { size: 15, align: 'center', color: o.urgent ? '#ffd166' : '#8fd8ff', weight: '700' });
    this.text(o.sub, cx, y + 20, { size: 13, align: 'center', color: '#dff3ff' });
    if (o.progress != null && o.progress > 0) {
      this.bar(cx - 130, y + 28, 260, 4, o.progress, o.urgent ? '#ffd166' : '#8fd8ff', 'rgba(0,0,0,0.5)');
    }
    if (o.timer != null && o.timer > 0) {
      this.text(fmtTime(o.timer), cx, y + 50, { size: 13, align: 'center', color: o.timer < 30 ? '#ff5d3c' : '#7e8ea0', weight: '700' });
    }
    if (o.boss) {
      const bw = 420;
      const by = y + 68;
      this.text(o.boss.name.toUpperCase(), cx, by - 6, { size: 14, align: 'center', color: '#ff6fb0', weight: '700' });
      this.bar(cx - bw / 2, by, bw, 12, o.boss.pct, o.boss.immune ? '#6b7280' : '#ff5d3c', 'rgba(0,0,0,0.6)');
      if (o.boss.immune) this.text('IMMUNE', cx, by + 26, { size: 11, align: 'center', color: '#9fb4c9', weight: '700' });
    }
  }

  _banners(c, activities) {
    const b = activities.banners[activities.banners.length - 1];
    if (!b) return;
    const k = clamp01(b.t / 0.6);
    const rise = (1 - clamp01(b.t / b.max)) * 6;
    c.save();
    c.globalAlpha = k;
    this.text(b.title, this.W / 2, this.H * 0.3 - rise, { size: 34, align: 'center', color: '#ffffff', weight: '700' });
    this.text(b.sub, this.W / 2, this.H * 0.3 + 22 - rise, { size: 15, align: 'center', color: '#8fd8ff' });
    c.restore();
  }

  _killFeed(c) {
    const x = this.W - 34;
    let y = 150;
    for (let i = Combat.killFeed.length - 1; i >= 0; i--) {
      const k = Combat.killFeed[i];
      const a = clamp01(k.life / 1.2);
      this.text(k.text, x, y, { size: 13, align: 'right', color: k.kind === 'boss' ? '#ffd166' : '#dff3ff', alpha: a });
      y += 19;
    }
  }

  _toasts(c) {
    let y = this.H / 2 + 120;
    for (const t of this.toasts) {
      const a = clamp01(t.t / 1.2);
      this.text(t.text, this.W / 2, y, { size: 17, align: 'center', color: t.color, weight: '700', alpha: a });
      if (t.sub) this.text(t.sub, this.W / 2, y + 17, { size: 12, align: 'center', color: '#9fb4c9', alpha: a });
      y += t.sub ? 42 : 26;
    }
  }

  _damageNumbers(c, camera) {
    for (const f of Combat.floaters) {
      const p = this.project(f.x + f.ox, f.y, f.z, camera);
      if (p.behind || p.dist > 120) continue;
      const a = clamp01(f.life / f.max);
      const scale = f.kind === 'crit' ? 1.35 : 1;
      const pop = 1 + (1 - clamp01((f.max - f.life) / 0.12)) * 0.5;
      const size = clamp(20 * scale * pop * (30 / Math.max(8, p.dist)) + 8, 10, 34);
      const color = f.kind === 'crit' ? '#ffd166' : f.kind === 'ability' ? '#c39dff' : f.kind === 'immune' ? '#9fb4c9' : '#ffffff';
      this.text(f.text, p.x, p.y, { size, align: 'center', color, weight: '700', alpha: a });
    }
  }

  _nameplates(c, camera, game) {
    // Majors and bosses get a plate so you can see the shield you must break.
    for (const e of Enemies.list) {
      if (!e.alive || e.tier === 'minor') continue;
      const p = this.project(e.pos.x, e.pos.y + e.height + 0.7, e.pos.z, camera);
      if (p.behind || p.dist > 90) continue;
      const w = 96;
      const a = clamp01((90 - p.dist) / 25);
      c.save();
      c.globalAlpha = a;
      this.text(e.name.toUpperCase(), p.x, p.y - 8, { size: 11, align: 'center', color: e.tier === 'boss' ? '#ffd166' : '#ff8a5c', weight: '700' });
      this.bar(p.x - w / 2, p.y, w, 5, e.vitals.healthPct, e.tier === 'boss' ? '#ff5d3c' : '#ff8a5c', 'rgba(0,0,0,0.6)');
      if (e.vitals.maxShield > 0 && e.vitals.shield > 0) {
        this.bar(p.x - w / 2, p.y - 6, w, 4, e.vitals.shieldPct, '#6fe0ff', 'rgba(0,0,0,0.5)');
      }
      if (e.immune) this.text('IMMUNE', p.x, p.y + 16, { size: 10, align: 'center', color: '#9fb4c9' });
      c.restore();
    }
    // Fireteam nameplates.
    if (game.net && game.net.remotes) {
      for (const r of game.net.remotes.values()) {
        if (!r.mesh || !r.mesh.visible) continue;
        const p = this.project(r.pos.x, r.pos.y + 2.3, r.pos.z, camera);
        if (p.behind || p.dist > 160) continue;
        c.save();
        c.globalAlpha = clamp01((160 - p.dist) / 40);
        this.text(r.name, p.x, p.y, { size: 12, align: 'center', color: r.color || '#8fd8ff', weight: '700' });
        this.bar(p.x - 30, p.y + 4, 60, 3, r.healthPct == null ? 1 : r.healthPct, '#6fb6ff', 'rgba(0,0,0,0.5)');
        c.restore();
      }
    }
  }

  _waypoints(c, camera, activities, player) {
    const list = activities.waypoints;
    for (const wp of list) {
      const p = this.project(wp.x, wp.y, wp.z, camera);
      const dist = Math.hypot(wp.x - player.pos.x, wp.y - player.pos.y, wp.z - player.pos.z);
      const color = '#' + (wp.color || 0x8fd8ff).toString(16).padStart(6, '0');
      let x = p.x, y = p.y;
      const margin = 46;
      const off = p.behind || x < margin || x > this.W - margin || y < margin || y > this.H - margin;
      if (off) {
        // Clamp to a ring so off-screen objectives still point somewhere.
        const cx = this.W / 2, cy = this.H / 2;
        let dx = x - cx, dy = y - cy;
        if (p.behind) { dx = -dx; dy = -dy; }
        const l = Math.hypot(dx, dy) || 1;
        const r = Math.min(this.W, this.H) * 0.36;
        x = cx + (dx / l) * r;
        y = cy + (dy / l) * r;
      }
      c.save();
      c.globalAlpha = off ? 0.55 : 0.95;
      c.strokeStyle = color;
      c.fillStyle = color;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x, y - 7); c.lineTo(x + 7, y); c.lineTo(x, y + 7); c.lineTo(x - 7, y);
      c.closePath();
      c.stroke();
      if (wp.kind === 'boss' || wp.kind === 'safe') { c.globalAlpha *= 0.5; c.fill(); }
      c.restore();
      if (!off) {
        this.text(`${wp.label}  ${Math.round(dist)}m`, x, y - 12, { size: 11, align: 'center', color });
      }
    }
  }

  _radar(c, player, game) {
    const r = 66;
    const cx = this.W - r - 40;
    const cy = r + 46;
    c.save();
    c.globalAlpha = 0.85;
    c.fillStyle = 'rgba(6,10,18,0.5)';
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(143,216,255,0.35)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(cx, cy, r * 0.5, 0, Math.PI * 2); c.stroke();

    const range = 70;
    const rot = -player.yaw;
    const plot = (wx, wz) => {
      const dx = wx - player.pos.x, dz = wz - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > range) return null;
      const a = Math.atan2(dx, dz) + rot;
      const rr = (d / range) * r;
      return [cx + Math.sin(a) * rr, cy - Math.cos(a) * rr];
    };

    for (const e of Enemies.list) {
      if (!e.alive) continue;
      const pt = plot(e.pos.x, e.pos.z);
      if (!pt) continue;
      const above = e.pos.y - player.pos.y;
      c.fillStyle = e.tier === 'boss' ? '#ffd166' : e.tier === 'major' ? '#ff8a5c' : '#ff5d3c';
      const s = e.tier === 'minor' ? 3 : 4.5;
      c.beginPath();
      if (above > 3) { c.moveTo(pt[0], pt[1] - s); c.lineTo(pt[0] + s, pt[1] + s); c.lineTo(pt[0] - s, pt[1] + s); }
      else if (above < -3) { c.moveTo(pt[0], pt[1] + s); c.lineTo(pt[0] + s, pt[1] - s); c.lineTo(pt[0] - s, pt[1] - s); }
      else c.arc(pt[0], pt[1], s, 0, Math.PI * 2);
      c.fill();
    }
    if (game.net && game.net.remotes) {
      for (const rp of game.net.remotes.values()) {
        const pt = plot(rp.pos.x, rp.pos.z);
        if (!pt) continue;
        c.fillStyle = '#6fe0ff';
        c.beginPath(); c.arc(pt[0], pt[1], 3.5, 0, Math.PI * 2); c.fill();
      }
    }
    // Player arrow.
    c.fillStyle = '#dff3ff';
    c.beginPath();
    c.moveTo(cx, cy - 6); c.lineTo(cx + 4.5, cy + 5); c.lineTo(cx, cy + 2.5); c.lineTo(cx - 4.5, cy + 5);
    c.closePath(); c.fill();
    c.restore();
  }

  _compass(c, player) {
    const cx = this.W / 2;
    const y = 26;
    const w = 300;
    c.save();
    c.globalAlpha = 0.75;
    const yaw = player.yaw;
    const marks = [['N', 0], ['E', -Math.PI / 2], ['S', Math.PI], ['W', Math.PI / 2]];
    c.strokeStyle = 'rgba(223,243,255,0.2)';
    c.beginPath(); c.moveTo(cx - w / 2, y + 6); c.lineTo(cx + w / 2, y + 6); c.stroke();
    for (const [label, ang] of marks) {
      let d = ang - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) > 1.2) continue;
      const x = cx + (d / 1.2) * (w / 2);
      this.text(label, x, y, { size: 13, align: 'center', color: '#dff3ff', weight: '700' });
    }
    c.restore();
    const reg = player.region;
    this.text(reg.name.toUpperCase(), cx, y + 24, { size: 12, align: 'center', color: '#7e8ea0', weight: '600' });
  }

  _buffs(c, player) {
    let x = this.W / 2 - 60;
    const y = this.H - 130;
    for (const [id, b] of player.buffs) {
      const col = b.kind === 'debuff' ? '#ff5d3c' : '#9dff7a';
      c.save();
      c.fillStyle = 'rgba(6,10,18,0.7)';
      c.fillRect(x, y, 118, 20);
      c.strokeStyle = col;
      c.lineWidth = 1;
      c.strokeRect(x + 0.5, y + 0.5, 117, 19);
      c.restore();
      this.text(`${b.name}${b.stacks > 1 ? ' x' + b.stacks : ''}`, x + 6, y + 14, { size: 11, color: col });
      x += 126;
    }
    if (player.carrying) {
      this.text(`CARRYING ${player.carrying.name.toUpperCase()}`, this.W / 2, this.H - 150, { size: 13, align: 'center', color: '#ffd166', weight: '700' });
    }
  }

  _interact(c, player, game) {
    const t = player.interactTarget;
    if (!t || !player.alive) return;
    const label = t.kind === 'vendor' ? `TALK TO ${t.name.toUpperCase()}` : `TRANSMAT · ${t.name.toUpperCase()}`;
    this.text(`[F] ${label}`, this.W / 2, this.H * 0.62, { size: 15, align: 'center', color: '#8fd8ff', weight: '700' });
  }

  _chat(c, net) {
    if (!this.chatLog.length) return;
    let y = this.H - 210;
    for (let i = this.chatLog.length - 1; i >= 0; i--) {
      const m = this.chatLog[i];
      this.text(m.line, 34, y, { size: 12, color: '#dff3ff', alpha: clamp01(m.t / 2) });
      y -= 17;
    }
  }

  _vignette(c, player) {
    const v = player.vitals;
    const hurt = player.hurtFlash || 0;
    const low = v.healthPct < 0.5 && v.shield <= 0 ? (1 - v.healthPct / 0.5) : 0;
    const amt = Math.max(hurt * 0.55, low * 0.5);
    if (amt <= 0.01) return;
    const g = c.createRadialGradient(this.W / 2, this.H / 2, Math.min(this.W, this.H) * 0.25, this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.62);
    g.addColorStop(0, 'rgba(255,40,30,0)');
    g.addColorStop(1, `rgba(255,30,20,${amt.toFixed(3)})`);
    c.fillStyle = g;
    c.fillRect(0, 0, this.W, this.H);
  }

  _deathScreen(c, player, game) {
    c.save();
    c.fillStyle = 'rgba(4,6,12,0.66)';
    c.fillRect(0, 0, this.W, this.H);
    this.text('YOU DIED', this.W / 2, this.H / 2 - 20, { size: 46, align: 'center', color: '#ff5d3c', weight: '700' });
    const wait = Math.max(0, (game.respawnDelay || 5) - player.deadT);
    this.text(wait > 0 ? `Reviving in ${wait.toFixed(1)}s` : 'Reviving…', this.W / 2, this.H / 2 + 18, { size: 17, align: 'center', color: '#dff3ff' });
    c.restore();
  }
}

export const HUD = new HUDSystem();
export default HUD;
