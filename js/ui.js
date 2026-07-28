/* STARFALL — ui.js
   Full-screen DOM menus: character select, inventory, world map, vendors,
   settings. Built in code so index.html stays a stub. */

import { CLASSES, CLASS_LIST } from './classes.js';
import { RARITY, ARMOR_SLOTS, WEAPON_SLOTS, STAT_LIST, STATS, itemSubtitle, dismantleValue, rollWeapon, rollArmor } from './loot.js';
import { ARCHETYPES, PERKS } from './weapons.js';
import World, { REGIONS, heightAt, WORLD, regionAt } from './world.js';
import { makeRNG, clamp01, fmtInt } from './util.js';
import { MILESTONES, LEVEL_CAP } from './progress.js';
import Audio from './audio.js';

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

class UISystem {
  constructor() {
    this.open = null;      // 'inventory' | 'map' | 'pause' | 'vendor' | null
    this.root = null;
    this.game = null;
    this.selected = null;
    this.vendorStock = new Map();
  }

  get isOpen() { return !!this.open; }

  init(game) {
    this.game = game;
    this.root = el('div', 'ui-root');
    document.body.appendChild(this.root);
    this.layer = el('div', 'ui-layer');
    this.root.appendChild(this.layer);
    this.chatBar = el('div', 'chatbar');
    this.chatBar.style.display = 'none';
    this.root.appendChild(this.chatBar);
  }

  /* --------------------------------------------------------- class pick */

  showClassSelect(onPick) {
    const wrap = el('div', 'screen boot');
    wrap.innerHTML = `
      <div class="boot-inner">
        <h1 class="title">STARFALL</h1>
        <p class="tagline">One shore. One spire. No loading screens.</p>
        <div class="classes"></div>
        <div class="bootrow">
          <label>Guardian name <input id="gname" maxlength="16" value="Guardian"></label>
          <label>Fireteam server <input id="gserver" value="auto" title="auto = this page's host; blank = solo"></label>
        </div>
        <button class="primary" id="startbtn">DROP IN</button>
        <p class="hint">WASD move · Shift sprint · Ctrl slide · Space jump (class jump in air) · LMB fire · RMB aim ·
          R reload · Q grenade · V melee · E class ability · X super · F interact · Tab inventory · M map · Enter chat</p>
      </div>`;
    const list = wrap.querySelector('.classes');
    let picked = 'warden';
    const cards = {};
    for (const id of CLASS_LIST) {
      const c = CLASSES[id];
      const card = el('div', 'card');
      card.style.setProperty('--accent', c.css);
      card.innerHTML = `
        <h2>${c.name.toUpperCase()}</h2>
        <div class="sub">${c.title}</div>
        <p>${c.blurb}</p>
        <ul>
          <li><b>Grenade</b> ${c.grenade.name} — ${c.grenade.desc}</li>
          <li><b>Melee</b> ${c.melee.name} — ${c.melee.desc}</li>
          <li><b>Class</b> ${c.classAbility.name} — ${c.classAbility.desc}</li>
          <li><b>Super</b> ${c.super.name} — ${c.super.desc}</li>
          <li><b>Jump</b> ${c.jumpStyle === 'double' ? 'Double jump' : c.jumpStyle === 'glide' ? 'Glide' : 'Lift'}</li>
        </ul>`;
      card.onclick = () => {
        picked = id;
        for (const k in cards) cards[k].classList.toggle('on', k === id);
        Audio.play('ui', { vol: 0.6 });
      };
      cards[id] = card;
      list.appendChild(card);
    }
    /* Deep links: ?class=phantom&name=Tyler prefills the form, and ?drop=phantom
       skips it entirely. One param does the whole job so the URL survives being
       pasted anywhere that mangles '&'. */
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    const wanted = (q.get('drop') || q.get('class') || '').toLowerCase();
    if (CLASSES[wanted]) picked = wanted;
    if (q.get('name')) wrap.querySelector('#gname').value = q.get('name').slice(0, 16);
    if (q.get('server') !== null) wrap.querySelector('#gserver').value = q.get('server');

    cards[picked].classList.add('on');
    this.layer.appendChild(wrap);
    const start = () => {
      const name = (wrap.querySelector('#gname').value || 'Guardian').slice(0, 16);
      const server = wrap.querySelector('#gserver').value.trim();
      wrap.remove();
      onPick({ classId: picked, name, server });
    };
    wrap.querySelector('#startbtn').onclick = start;
    wrap.addEventListener('keydown', e => { if (e.key === 'Enter') start(); });
    setTimeout(() => wrap.querySelector('#startbtn').focus(), 30);
    if (q.has('drop')) start();
  }

  /* ------------------------------------------------------------- panels */

  closeAll() {
    if (!this.open) return;
    this.layer.innerHTML = '';
    this.open = null;
    this.selected = null;
    Audio.play('ui', { vol: 0.4 });
  }

  toggle(which, arg) {
    if (this.open === which) { this.closeAll(); return; }
    this.layer.innerHTML = '';
    this.open = which;
    Audio.play('ui', { vol: 0.5 });
    if (which === 'inventory') this._buildInventory();
    else if (which === 'map') this._buildMap();
    else if (which === 'pause') this._buildPause();
    else if (which === 'vendor') this._buildVendor(arg);
  }

  refresh() {
    if (this.open === 'inventory') { this.layer.innerHTML = ''; this._buildInventory(); }
    else if (this.open === 'vendor') { const v = this._vendor; this.layer.innerHTML = ''; this._buildVendor(v); }
  }

  /* ---------------------------------------------------------- inventory */

  _itemCard(item, { compare = null, onClick = null, showPower = true } = {}) {
    const r = RARITY[item.rarity];
    const card = el('div', 'item');
    card.style.setProperty('--rar', r.css);
    const perkStr = (item.perks || []).map(p => (PERKS[p] ? PERKS[p].name : p)).join(' · ');
    let delta = '';
    if (compare) {
      const d = item.power - compare.power;
      delta = d === 0 ? '' : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>`;
    }
    card.innerHTML = `
      <div class="name">${item.name}</div>
      <div class="sub">${itemSubtitle(item)}</div>
      ${showPower ? `<div class="power">${item.power} ${delta}</div>` : ''}
      ${perkStr ? `<div class="perks">${perkStr}</div>` : ''}
      <div class="stats">${Object.keys(item.stats).filter(k => item.stats[k] > 0).map(k => `<span>${k.slice(0, 3).toUpperCase()} ${item.stats[k]}</span>`).join('')}</div>`;
    if (onClick) card.onclick = () => onClick(item);
    return card;
  }

  _buildInventory() {
    const g = this.game;
    const p = g.player;
    const inv = p.inventory;
    const wrap = el('div', 'screen inventory');
    const pr = p.progress;
    wrap.innerHTML = `<div class="panelhead"><h2>GUARDIAN</h2><div class="meta">RANK <b>${pr.level}</b> · POWER <b>${inv.power}</b> · GLIMMER <b>${fmtInt(inv.glimmer)}</b> · ${p.classDef.name}</div><div class="closehint">TAB to close</div></div>`;

    const body = el('div', 'invbody');
    const left = el('div', 'col equipped');
    left.appendChild(el('h3', null, 'EQUIPPED'));
    for (const slot of [...WEAPON_SLOTS, ...ARMOR_SLOTS]) {
      const item = inv.equipped[slot];
      const row = el('div', 'slotrow');
      row.appendChild(el('div', 'slotname', slot.toUpperCase()));
      if (item) row.appendChild(this._itemCard(item));
      else row.appendChild(el('div', 'item empty', '<div class="name">—</div>'));
      left.appendChild(row);
    }

    const st = inv.stats;
    const statsBox = el('div', 'statbox');
    statsBox.appendChild(el('h3', null, 'STATS'));
    for (const s of STAT_LIST) {
      const row = el('div', 'statrow');
      row.innerHTML = `<span>${STATS[s].name}</span><div class="pips">${
        Array.from({ length: 10 }, (_, i) => `<i class="${i < st[s] ? 'on' : ''}"></i>`).join('')
      }</div><em>${STATS[s].blurb}</em>`;
      statsBox.appendChild(row);
    }
    left.appendChild(statsBox);

    // Rank: the bar, and every perk with the earned ones lit.
    const rankBox = el('div', 'statbox rankbox');
    rankBox.appendChild(el('h3', null, `RANK ${pr.level}${pr.level >= LEVEL_CAP ? ' · MAX' : ''}`));
    const meter = el('div', 'rankmeter');
    meter.innerHTML = `<div class="fill" style="width:${Math.round(pr.pct * 100)}%"></div>`;
    rankBox.appendChild(meter);
    rankBox.appendChild(el('div', 'ranknote',
      `${pr.level >= LEVEL_CAP ? 'Maxed' : `${fmtInt(pr.xp)} / ${fmtInt(pr.next)} XP`} · power floor ${pr.powerFloor} · ${fmtInt(pr.total)} lifetime`));
    for (const m of MILESTONES) {
      const owned = m.level <= pr.level;
      const row = el('div', 'perkrow' + (owned ? ' on' : ''));
      row.innerHTML = `<b>${m.level}</b><span>${m.name}</span><em>${m.desc}</em>`;
      rankBox.appendChild(row);
    }
    left.appendChild(rankBox);

    const right = el('div', 'col bag');
    right.appendChild(el('h3', null, `BACKPACK (${inv.items.length})`));
    const grid = el('div', 'grid');
    if (!inv.items.length) grid.appendChild(el('div', 'empty-note', 'Nothing yet. Kill something.'));
    for (const item of inv.items) {
      grid.appendChild(this._itemCard(item, {
        compare: inv.equipped[item.slot],
        onClick: it => this._selectItem(it, wrap)
      }));
    }
    right.appendChild(grid);

    body.appendChild(left);
    body.appendChild(right);
    wrap.appendChild(body);

    const detail = el('div', 'detail');
    detail.id = 'itemdetail';
    wrap.appendChild(detail);
    this.layer.appendChild(wrap);
  }

  _selectItem(item, wrap) {
    const g = this.game;
    const inv = g.player.inventory;
    const detail = wrap.querySelector('#itemdetail');
    const cur = inv.equipped[item.slot];
    detail.innerHTML = '';
    const box = el('div', 'detailbox');
    box.appendChild(el('h3', null, item.name));
    box.appendChild(el('div', 'sub', itemSubtitle(item) + ' · Power ' + item.power));
    if (item.kind === 'weapon') {
      const d = ARCHETYPES[item.archId];
      box.appendChild(el('p', 'blurb', d.blurb));
      box.appendChild(el('div', 'sub', `${d.rpm ? d.rpm + ' RPM · ' : ''}${d.damage} base · x${d.crit} precision · ${d.mag} mag`));
    }
    for (const perk of item.perks || []) {
      if (!PERKS[perk]) continue;
      box.appendChild(el('div', 'perk', `<b>${PERKS[perk].name}</b> — ${PERKS[perk].desc}`));
    }
    if (cur) box.appendChild(el('div', 'sub', `Replacing: ${cur.name} (${cur.power})`));
    const row = el('div', 'btnrow');
    const eq = el('button', 'primary', 'EQUIP');
    eq.onclick = () => { g.player.equip(item); this.refresh(); };
    const dis = el('button', null, `DISMANTLE (+${dismantleValue(item)} glimmer)`);
    dis.onclick = () => { inv.dismantle(item); Audio.play('ui', { vol: 0.5 }); this.refresh(); };
    row.appendChild(eq);
    row.appendChild(dis);
    box.appendChild(row);
    detail.appendChild(box);
  }

  /* ---------------------------------------------------------------- map */

  _buildMap() {
    const g = this.game;
    const wrap = el('div', 'screen map');
    wrap.innerHTML = `<div class="panelhead"><h2>THE SUNDERED SHORE</h2><div class="meta">Click a discovered beacon to transmat</div><div class="closehint">M to close</div></div>`;
    const holder = el('div', 'mapholder');
    const canvas = el('canvas', 'mapcanvas');
    const size = Math.min(window.innerWidth * 0.7, window.innerHeight * 0.72);
    canvas.width = size; canvas.height = size;
    holder.appendChild(canvas);
    wrap.appendChild(holder);
    const legend = el('div', 'legend');
    legend.innerHTML = REGIONS.map(r => `<span style="--c:${'#' + r.accent.toString(16).padStart(6, '0')}">${r.name}</span>`).join('');
    wrap.appendChild(legend);
    this.layer.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    this._drawMap(ctx, size);

    const toWorld = (px, py) => ({
      x: (px / size) * WORLD.size - WORLD.size / 2,
      z: (py / size) * WORLD.size - WORLD.size / 2
    });
    canvas.onclick = e => {
      const rect = canvas.getBoundingClientRect();
      const w = toWorld(e.clientX - rect.left, e.clientY - rect.top);
      let best = null, bestD = 60;
      for (const poi of World.pois) {
        if (poi.kind !== 'travel') continue;
        const d = Math.hypot(poi.x - w.x, poi.z - w.z);
        if (d < bestD) { bestD = d; best = poi; }
      }
      if (best && g.player.travelUnlocked.has(best.region || 'rally')) {
        g.player.travelTo(best);
        this.closeAll();
        g.hud.toast('TRANSMAT', '#8fd8ff', best.name);
      } else if (best) {
        Audio.play('deny', { vol: 0.6 });
        g.hud.toast('NOT DISCOVERED', '#ff5d3c', 'Walk there once to unlock transmat');
      }
    };
  }

  _drawMap(ctx, size) {
    const g = this.game;
    if (!this._mapCache || this._mapCache.width !== size) {
      const off = document.createElement('canvas');
      off.width = off.height = size;
      const oc = off.getContext('2d');
      const N = 150;
      const cell = size / N;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const wx = (i / N) * WORLD.size - WORLD.size / 2;
          const wz = (j / N) * WORLD.size - WORLD.size / 2;
          const h = heightAt(wx, wz);
          const reg = regionAt(wx, wz);
          const base = reg.ground;
          let r = (base >> 16) & 255, gg = (base >> 8) & 255, b = base & 255;
          const k = clamp01((h + 40) / 150) * 0.7 + 0.3;
          if (h < WORLD.seaLevel) { r = 24; gg = 44; b = 66; }
          oc.fillStyle = `rgb(${Math.round(r * k)},${Math.round(gg * k)},${Math.round(b * k)})`;
          oc.fillRect(i * cell, j * cell, cell + 1, cell + 1);
        }
      }
      this._mapCache = off;
    }
    ctx.drawImage(this._mapCache, 0, 0);

    const toMap = (x, z) => [((x + WORLD.size / 2) / WORLD.size) * size, ((z + WORLD.size / 2) / WORLD.size) * size];

    // POIs.
    for (const poi of World.pois) {
      const [px, py] = toMap(poi.x, poi.z);
      const known = poi.kind !== 'travel' || g.player.travelUnlocked.has(poi.region || 'rally');
      ctx.save();
      ctx.globalAlpha = known ? 1 : 0.35;
      ctx.fillStyle = '#' + (poi.color || 0x8fd8ff).toString(16).padStart(6, '0');
      ctx.beginPath();
      ctx.arc(px, py, poi.kind === 'travel' ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#dff3ff';
      ctx.font = '600 11px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(known ? poi.name : '???', px, py - 10);
      ctx.restore();
    }
    // Activity anchors.
    const anchors = [
      { p: World.interiors.dungeon.mouth, label: 'THE HOLLOW CHOIR', c: '#8b6bff' },
      { p: World.interiors.raid.entry, label: 'SPIRE OF THE SUNDERED SKY', c: '#c39dff' },
      { p: World.interiors.lostSector.mouth, label: 'LOST SECTOR', c: '#9fe8ff' }
    ];
    for (const a of anchors) {
      const [px, py] = toMap(a.p.x, a.p.z);
      ctx.strokeStyle = a.c;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = a.c;
      ctx.font = '700 10px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(a.label, px, py + 22);
    }
    // Player.
    const [ax, ay] = toMap(g.player.pos.x, g.player.pos.z);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(-g.player.yaw);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------------------- vendor */

  _buildVendor(poi) {
    this._vendor = poi;
    const g = this.game;
    const inv = g.player.inventory;
    const wrap = el('div', 'screen vendor');
    wrap.innerHTML = `<div class="panelhead"><h2>${poi.name.toUpperCase()}</h2><div class="meta">GLIMMER <b>${fmtInt(inv.glimmer)}</b></div><div class="closehint">ESC to close</div></div>`;

    let stock = this.vendorStock.get(poi.id);
    if (!stock) {
      stock = this._rollStock(poi);
      this.vendorStock.set(poi.id, stock);
    }
    const grid = el('div', 'grid');
    for (const entry of stock) {
      const card = this._itemCard(entry.item, { compare: inv.equipped[entry.item.slot] });
      const buy = el('button', entry.sold ? '' : 'primary', entry.sold ? 'SOLD' : `BUY · ${fmtInt(entry.cost)}`);
      buy.disabled = entry.sold || inv.glimmer < entry.cost;
      buy.onclick = () => {
        if (inv.glimmer < entry.cost || entry.sold) { Audio.play('deny', { vol: 0.6 }); return; }
        inv.glimmer -= entry.cost;
        inv.add(entry.item);
        entry.sold = true;
        Audio.play('chest', { vol: 0.7 });
        g.hud.toast('PURCHASED', RARITY[entry.item.rarity].css, entry.item.name);
        this.refresh();
      };
      card.appendChild(buy);
      grid.appendChild(card);
    }
    wrap.appendChild(grid);

    const foot = el('div', 'vendorfoot');
    const reroll = el('button', null, 'REFRESH STOCK · 400');
    reroll.disabled = inv.glimmer < 400;
    reroll.onclick = () => {
      if (inv.glimmer < 400) return;
      inv.glimmer -= 400;
      this.vendorStock.set(poi.id, this._rollStock(poi));
      this.refresh();
    };
    foot.appendChild(reroll);
    if (poi.id === 'cryptarch') {
      const decode = el('button', 'primary', `DECODE ENGRAM (${inv.engrams})`);
      decode.disabled = inv.engrams <= 0;
      decode.onclick = () => {
        if (inv.engrams <= 0) return;
        inv.engrams--;
        const item = g.activities.grantLoot('event');
        if (item) g.hud.toast('DECODED', RARITY[item.rarity].css, item.name);
        this.refresh();
      };
      foot.appendChild(decode);
    }
    wrap.appendChild(foot);
    this.layer.appendChild(wrap);
  }

  _rollStock(poi) {
    const g = this.game;
    const rng = makeRNG((Date.now() / 60000 | 0) + poi.id.length * 977);
    const power = g.player.inventory.power;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const rarity = rng.chance(0.25) ? 'legendary' : 'rare';
      const item = poi.id === 'gunsmith'
        ? rollWeapon(rng, { power: power + rng.int(0, 3), rarity })
        : rollArmor(rng, { power: power + rng.int(0, 3), rarity, classId: g.player.classDef.id });
      out.push({ item, cost: rarity === 'legendary' ? 1800 : 700, sold: false });
    }
    return out;
  }

  /* -------------------------------------------------------------- pause */

  _buildPause() {
    const g = this.game;
    const wrap = el('div', 'screen pause');
    wrap.innerHTML = `<div class="panelhead"><h2>PAUSED</h2><div class="closehint">ESC to resume</div></div>`;
    const box = el('div', 'settings');

    const mkSlider = (label, min, max, step, value, fn, fmt = v => v.toFixed(2)) => {
      const row = el('div', 'setrow');
      row.innerHTML = `<span>${label}</span>`;
      const input = el('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step; input.value = value;
      const out = el('em', null, fmt(value));
      input.oninput = () => { const v = parseFloat(input.value); out.textContent = fmt(v); fn(v); };
      row.appendChild(input);
      row.appendChild(out);
      return row;
    };

    box.appendChild(mkSlider('Look sensitivity', 0.0005, 0.006, 0.0001, g.input.sensitivity,
      v => { g.input.sensitivity = v; }, v => (v * 1000).toFixed(1)));
    box.appendChild(mkSlider('Master volume', 0, 1, 0.05, Audio.masterVol, v => Audio.setVolume(v), v => Math.round(v * 100) + '%'));

    const invRow = el('div', 'setrow');
    invRow.innerHTML = '<span>Invert look</span>';
    const invBtn = el('button', null, g.input.invertY ? 'ON' : 'OFF');
    invBtn.onclick = () => { g.input.invertY = !g.input.invertY; invBtn.textContent = g.input.invertY ? 'ON' : 'OFF'; };
    invRow.appendChild(invBtn);
    box.appendChild(invRow);

    const radarRow = el('div', 'setrow');
    radarRow.innerHTML = '<span>Radar</span>';
    const radarBtn = el('button', null, g.hud.showRadar ? 'ON' : 'OFF');
    radarBtn.onclick = () => { g.hud.showRadar = !g.hud.showRadar; radarBtn.textContent = g.hud.showRadar ? 'ON' : 'OFF'; };
    radarRow.appendChild(radarBtn);
    box.appendChild(radarRow);

    const netRow = el('div', 'setrow');
    netRow.innerHTML = `<span>Fireteam</span>`;
    netRow.appendChild(el('em', null, g.net && g.net.connected ? `connected · ${g.net.remotes.size + 1} in shard` : 'solo (offline)'));
    box.appendChild(netRow);

    const stats = el('div', 'runstats');
    stats.innerHTML = `
      <div><b>${fmtInt(Combatish(g).kills)}</b><span>KILLS</span></div>
      <div><b>${fmtInt(Combatish(g).damage)}</b><span>DAMAGE</span></div>
      <div><b>${Math.round(Combatish(g).hits / Math.max(1, Combatish(g).shots) * 100)}%</b><span>ACCURACY</span></div>
      <div><b>${fmtInt(Combatish(g).crits)}</b><span>PRECISION</span></div>`;
    box.appendChild(stats);

    const keys = el('div', 'keys');
    keys.innerHTML = `<h3>CONTROLS</h3>
      <div><b>WASD</b> move · <b>Shift</b> sprint · <b>Ctrl</b> crouch/slide · <b>Space</b> jump</div>
      <div><b>LMB</b> fire · <b>RMB</b> aim · <b>R</b> reload · <b>1/2/3</b> weapons · <b>G</b> swap</div>
      <div><b>Q</b> grenade · <b>V</b> melee · <b>E</b> class ability (hold Ctrl+E to switch rift) · <b>X</b> super</div>
      <div><b>F</b> interact · <b>Tab</b> inventory · <b>M</b> map · <b>Enter</b> chat · <b>Esc</b> pause</div>`;
    box.appendChild(keys);

    wrap.appendChild(box);
    this.layer.appendChild(wrap);
  }

  /* --------------------------------------------------------------- chat */

  openChat(onSend) {
    this.chatBar.style.display = 'block';
    this.chatBar.innerHTML = '<span>SAY</span><span id="chattext"></span><i class="caret"></i>';
    this._chatSend = onSend;
  }
  updateChat(text) {
    const t = this.chatBar.querySelector('#chattext');
    if (t) t.textContent = text;
  }
  closeChat() { this.chatBar.style.display = 'none'; }
}

function Combatish(g) { return g.combatStats || { kills: 0, damage: 0, hits: 0, shots: 0, crits: 0 }; }

export const UI = new UISystem();
export default UI;
