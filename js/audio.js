/* STARFALL — audio.js
   Every sound is synthesised at runtime: no audio files ship with the game.
   Safe to import in a headless harness — if there is no AudioContext, every
   call is a no-op. */

import { clamp, clamp01, lerp } from './util.js';

const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

class AudioEngine {
  constructor() {
    this.ok = false;
    this.ctx = null;
    this.listener = { x: 0, y: 0, z: 0 };
    this.muted = false;
    this.masterVol = 0.75;
    this._musicState = 'calm';
    this._chordT = 0;
    this._chordI = 0;
    this._pulseT = 0;
    this._combat = 0;     // 0..1 blend toward the combat bed
    this._lastFoot = 0;
  }

  init() {
    if (this.ok || !AC) return false;
    try {
      this.ctx = new AC();
      const ctx = this.ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.masterVol;

      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 9;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.22;

      this.master.connect(this.comp);
      this.comp.connect(ctx.destination);

      // Buses so music can duck under gunfire without touching SFX levels.
      this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 1; this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.34; this.musicBus.connect(this.master);

      // One shared noise buffer; everything gritty is a filtered slice of it.
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      // Cheap plate-ish reverb for weapon tails.
      const rlen = Math.floor(ctx.sampleRate * 1.1);
      const rb = ctx.createBuffer(2, rlen, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const ch = rb.getChannelData(c);
        for (let i = 0; i < rlen; i++) {
          const t = i / rlen;
          ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
        }
      }
      this.verb = ctx.createConvolver();
      this.verb.buffer = rb;
      this.verbGain = ctx.createGain();
      this.verbGain.gain.value = 0.22;
      this.verb.connect(this.verbGain);
      this.verbGain.connect(this.master);

      this._startMusic();
      this.ok = true;
      return true;
    } catch (e) {
      this.ok = false;
      return false;
    }
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setMuted(m) { this.muted = m; if (this.ok) this.master.gain.value = m ? 0 : this.masterVol; }
  setVolume(v) { this.masterVol = clamp01(v); if (this.ok && !this.muted) this.master.gain.value = this.masterVol; }
  get now() { return this.ok ? this.ctx.currentTime : 0; }

  setListener(pos) { this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z; }

  /** Distance attenuation + air absorption, returns {gain, cutoff} or null if inaudible. */
  _spatial(pos, refDist = 14, maxDist = 150) {
    if (!pos) return { gain: 1, cutoff: 20000 };
    const dx = pos.x - this.listener.x, dy = pos.y - this.listener.y, dz = pos.z - this.listener.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > maxDist) return null;
    const g = refDist / (refDist + d * 1.05);
    const cutoff = lerp(19000, 1200, clamp01(d / maxDist));
    return { gain: g, cutoff };
  }

  /* ---------------------------------------------------------- primitives */

  _osc(type, freq, t0, dur, gain, { sweep = null, detune = 0, dest = null, curve = 'exp' } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), t0 + dur);
    if (detune) o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.008, dur * 0.2));
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    else g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(dest || this.sfxBus);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    return { o, g };
  }

  _noise(t0, dur, gain, { type = 'lowpass', freq = 1200, q = 1, sweep = null, dest = null } = {}) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, sweep), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(dest || this.sfxBus);
    s.start(t0, Math.random() * 1.5);
    s.stop(t0 + dur + 0.02);
    return { s, g, f };
  }

  /** Per-sound spatial chain: everything positional runs through this. */
  _chan(pos, vol, refDist, maxDist, sendVerb = 0.25) {
    const sp = this._spatial(pos, refDist, maxDist);
    if (!sp) return null;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = sp.gain * vol;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = sp.cutoff;
    g.connect(f);
    f.connect(this.sfxBus);
    if (sendVerb > 0 && this.verb) {
      const sv = ctx.createGain();
      sv.gain.value = sendVerb * sp.gain;
      f.connect(sv);
      sv.connect(this.verb);
    }
    return g;
  }

  /* --------------------------------------------------------------- sfx   */

  play(name, opts = {}) {
    if (!this.ok || this.muted) return;
    const t = this.ctx.currentTime + 0.001;
    const vol = opts.vol == null ? 1 : opts.vol;
    const pos = opts.pos || null;
    const fn = this[`_s_${name}`];
    if (!fn) return;
    try { fn.call(this, t, vol, pos, opts); } catch (e) { /* never let audio kill a frame */ }
  }

  /* --- weapons: each archetype gets its own body so guns sound different */

  _s_auto(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.55, 16, 190); if (!ch) return;
    this._osc('square', 260, t, 0.09, 0.5, { sweep: 70, dest: ch });
    this._noise(t, 0.075, 0.55, { type: 'bandpass', freq: 2600, q: 0.8, sweep: 700, dest: ch });
    this._noise(t, 0.19, 0.13, { type: 'lowpass', freq: 700, sweep: 200, dest: ch });
  }
  _s_smg(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.42, 14, 160); if (!ch) return;
    this._osc('square', 340, t, 0.06, 0.42, { sweep: 110, dest: ch });
    this._noise(t, 0.05, 0.45, { type: 'bandpass', freq: 3400, q: 0.9, sweep: 1100, dest: ch });
  }
  _s_pulse(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.5, 16, 190); if (!ch) return;
    this._osc('sawtooth', 420, t, 0.07, 0.4, { sweep: 150, dest: ch });
    this._noise(t, 0.06, 0.4, { type: 'bandpass', freq: 3000, q: 1.2, sweep: 900, dest: ch });
  }
  _s_scout(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.7, 18, 240); if (!ch) return;
    this._osc('square', 200, t, 0.13, 0.55, { sweep: 55, dest: ch });
    this._noise(t, 0.11, 0.6, { type: 'bandpass', freq: 2100, q: 0.7, sweep: 480, dest: ch });
    this._noise(t, 0.3, 0.16, { type: 'lowpass', freq: 520, sweep: 150, dest: ch });
  }
  _s_cannon(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.9, 20, 280, 0.4); if (!ch) return;
    this._osc('square', 150, t, 0.2, 0.7, { sweep: 42, dest: ch });
    this._noise(t, 0.16, 0.8, { type: 'bandpass', freq: 1700, q: 0.6, sweep: 320, dest: ch });
    this._noise(t, 0.45, 0.22, { type: 'lowpass', freq: 420, sweep: 110, dest: ch });
  }
  _s_shotgun(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.95, 20, 260, 0.45); if (!ch) return;
    this._osc('sawtooth', 120, t, 0.25, 0.6, { sweep: 38, dest: ch });
    this._noise(t, 0.22, 0.95, { type: 'lowpass', freq: 2400, sweep: 240, dest: ch });
    this._noise(t, 0.5, 0.2, { type: 'lowpass', freq: 380, sweep: 90, dest: ch });
  }
  _s_sniper(t, vol, pos) {
    const ch = this._chan(pos, vol * 1.0, 24, 380, 0.55); if (!ch) return;
    this._osc('square', 180, t, 0.3, 0.62, { sweep: 30, dest: ch });
    this._noise(t, 0.13, 0.9, { type: 'highpass', freq: 1800, sweep: 4200, dest: ch });
    this._noise(t, 0.75, 0.24, { type: 'lowpass', freq: 500, sweep: 90, dest: ch });
  }
  _s_fusion(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.8, 18, 240); if (!ch) return;
    for (let i = 0; i < 5; i++) {
      const tt = t + i * 0.035;
      this._osc('sine', 700 + i * 40, tt, 0.09, 0.3, { sweep: 260, dest: ch });
      this._noise(tt, 0.06, 0.3, { type: 'bandpass', freq: 2400, q: 3, dest: ch });
    }
  }
  _s_charge(t, vol, pos, o) {
    const ch = this._chan(pos, vol * 0.5, 18, 120, 0.1); if (!ch) return;
    const dur = o.dur || 0.55;
    this._osc('sine', 180, t, dur, 0.28, { sweep: 1400, dest: ch, curve: 'lin' });
    this._osc('triangle', 90, t, dur, 0.18, { sweep: 700, dest: ch, curve: 'lin' });
  }
  _s_rocket(t, vol, pos) {
    const ch = this._chan(pos, vol * 1.0, 24, 340, 0.5); if (!ch) return;
    this._noise(t, 0.5, 0.8, { type: 'lowpass', freq: 1600, sweep: 300, dest: ch });
    this._osc('sawtooth', 90, t, 0.4, 0.5, { sweep: 40, dest: ch });
  }
  _s_bow(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.7, 18, 220); if (!ch) return;
    this._osc('triangle', 900, t, 0.12, 0.4, { sweep: 220, dest: ch });
    this._noise(t, 0.1, 0.4, { type: 'highpass', freq: 2600, dest: ch });
  }

  /* --- feedback -------------------------------------------------------- */

  _s_hit(t, vol) {                      // hitmarker: dry, close, no reverb
    const g = this.ctx.createGain(); g.gain.value = vol * 0.5; g.connect(this.sfxBus);
    this._osc('square', 1500, t, 0.035, 0.35, { sweep: 900, dest: g });
  }
  _s_crit(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.6; g.connect(this.sfxBus);
    this._osc('square', 2200, t, 0.05, 0.35, { sweep: 1500, dest: g });
    this._osc('sine', 3300, t + 0.02, 0.06, 0.2, { sweep: 2400, dest: g });
  }
  _s_kill(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.6; g.connect(this.sfxBus);
    this._osc('sine', 880, t, 0.09, 0.3, { dest: g });
    this._osc('sine', 1320, t + 0.05, 0.12, 0.26, { dest: g });
  }
  _s_shieldpop(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.9, 16, 160, 0.4); if (!ch) return;
    this._osc('triangle', 1600, t, 0.28, 0.35, { sweep: 300, dest: ch });
    this._noise(t, 0.3, 0.5, { type: 'highpass', freq: 2000, sweep: 600, dest: ch });
  }
  _s_hurt(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.8; g.connect(this.sfxBus);
    this._noise(t, 0.18, 0.5, { type: 'lowpass', freq: 900, sweep: 220, dest: g });
    this._osc('sine', 220, t, 0.2, 0.3, { sweep: 90, dest: g });
  }
  _s_shieldbreak(t, vol) {              // player's own shield collapsing
    const g = this.ctx.createGain(); g.gain.value = vol * 0.9; g.connect(this.sfxBus);
    this._osc('sawtooth', 420, t, 0.5, 0.3, { sweep: 70, dest: g });
    this._noise(t, 0.5, 0.55, { type: 'bandpass', freq: 1400, q: 0.7, sweep: 200, dest: g });
  }
  _s_recharge(t, vol) {                 // the Halo shield-back-up chime
    const g = this.ctx.createGain(); g.gain.value = vol * 0.55; g.connect(this.sfxBus);
    this._osc('sine', 500, t, 0.55, 0.22, { sweep: 1250, dest: g, curve: 'lin' });
    this._osc('sine', 750, t + 0.06, 0.5, 0.14, { sweep: 1600, dest: g, curve: 'lin' });
  }
  _s_lowhealth(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.35; g.connect(this.sfxBus);
    this._osc('sine', 1400, t, 0.16, 0.2, { sweep: 1100, dest: g });
  }

  /* --- movement / world ------------------------------------------------ */

  _s_step(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.3, 10, 60, 0.1); if (!ch) return;
    this._noise(t, 0.08, 0.4, { type: 'lowpass', freq: 700 + Math.random() * 400, sweep: 200, dest: ch });
  }
  _s_jump(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.4; g.connect(this.sfxBus);
    this._noise(t, 0.12, 0.3, { type: 'bandpass', freq: 900, q: 1, sweep: 1800, dest: g });
  }
  _s_land(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.55; g.connect(this.sfxBus);
    this._noise(t, 0.17, 0.5, { type: 'lowpass', freq: 600, sweep: 140, dest: g });
    this._osc('sine', 110, t, 0.16, 0.3, { sweep: 55, dest: g });
  }
  _s_reload(t, vol, pos, o) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.5; g.connect(this.sfxBus);
    const stage = (o && o.stage) || 0;
    const f = [1400, 900, 1900][stage % 3];
    this._noise(t, 0.06, 0.4, { type: 'bandpass', freq: f, q: 3, dest: g });
    this._osc('square', f * 0.5, t, 0.04, 0.14, { sweep: f * 0.25, dest: g });
  }
  _s_swap(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.45; g.connect(this.sfxBus);
    this._noise(t, 0.1, 0.35, { type: 'bandpass', freq: 1800, q: 2, sweep: 900, dest: g });
  }
  _s_explode(t, vol, pos) {
    const ch = this._chan(pos, vol * 1.1, 26, 400, 0.6); if (!ch) return;
    this._noise(t, 0.9, 0.9, { type: 'lowpass', freq: 1400, sweep: 90, dest: ch });
    this._osc('sine', 120, t, 0.8, 0.7, { sweep: 32, dest: ch });
    this._osc('sawtooth', 70, t, 0.5, 0.35, { sweep: 28, dest: ch });
  }
  _s_pickup(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.5; g.connect(this.sfxBus);
    [660, 990, 1320].forEach((f, i) => this._osc('sine', f, t + i * 0.05, 0.16, 0.2, { dest: g }));
  }
  _s_orb(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.5; g.connect(this.sfxBus);
    this._osc('sine', 520, t, 0.35, 0.24, { sweep: 1040, dest: g, curve: 'lin' });
    this._osc('triangle', 780, t + 0.04, 0.3, 0.12, { sweep: 1560, dest: g, curve: 'lin' });
  }
  _s_ui(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.35; g.connect(this.sfxBus);
    this._osc('square', 1200, t, 0.03, 0.2, { sweep: 1600, dest: g });
  }
  _s_deny(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.4; g.connect(this.sfxBus);
    this._osc('square', 300, t, 0.09, 0.25, { sweep: 160, dest: g });
  }

  /* --- abilities ------------------------------------------------------- */

  _s_ability(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.7, 16, 160, 0.3); if (!ch) return;
    this._osc('triangle', 300, t, 0.3, 0.35, { sweep: 900, dest: ch });
    this._noise(t, 0.3, 0.3, { type: 'bandpass', freq: 1200, q: 1.4, sweep: 2600, dest: ch });
  }
  _s_grenade(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.6, 14, 140, 0.25); if (!ch) return;
    this._osc('sine', 700, t, 0.2, 0.25, { sweep: 260, dest: ch });
    this._noise(t, 0.16, 0.3, { type: 'bandpass', freq: 2200, q: 2, sweep: 800, dest: ch });
  }
  _s_melee(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.8, 12, 120, 0.2); if (!ch) return;
    this._noise(t, 0.15, 0.6, { type: 'bandpass', freq: 1000, q: 0.9, sweep: 260, dest: ch });
    this._osc('square', 200, t, 0.14, 0.35, { sweep: 60, dest: ch });
  }
  _s_super(t, vol, pos) {               // the big one — riser, boom, tail
    const ch = this._chan(pos, vol * 1.2, 30, 500, 0.7); if (!ch) return;
    this._osc('sawtooth', 110, t, 0.9, 0.4, { sweep: 900, dest: ch, curve: 'lin' });
    this._osc('sine', 55, t, 1.3, 0.55, { sweep: 40, dest: ch });
    this._noise(t, 1.0, 0.55, { type: 'bandpass', freq: 500, q: 0.6, sweep: 5200, dest: ch });
    this._noise(t + 0.55, 1.1, 0.5, { type: 'lowpass', freq: 1800, sweep: 120, dest: ch });
  }
  _s_superready(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.7; g.connect(this.sfxBus);
    [523, 659, 784, 1047].forEach((f, i) => this._osc('sine', f, t + i * 0.07, 0.5, 0.18, { dest: g }));
  }

  /* --- enemies / world events ----------------------------------------- */

  _s_enemyshot(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.45, 14, 220); if (!ch) return;
    this._osc('sawtooth', 520, t, 0.1, 0.3, { sweep: 160, dest: ch });
    this._noise(t, 0.07, 0.25, { type: 'bandpass', freq: 1800, q: 2, dest: ch });
  }
  _s_enemydeath(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.6, 14, 180, 0.3); if (!ch) return;
    this._osc('sawtooth', 380, t, 0.35, 0.3, { sweep: 70, dest: ch });
    this._noise(t, 0.32, 0.35, { type: 'lowpass', freq: 1400, sweep: 200, dest: ch });
  }
  _s_spawn(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.7, 18, 220, 0.4); if (!ch) return;
    this._osc('sine', 120, t, 0.6, 0.35, { sweep: 620, dest: ch, curve: 'lin' });
    this._noise(t, 0.5, 0.3, { type: 'bandpass', freq: 700, q: 1.2, sweep: 3000, dest: ch });
  }
  _s_roar(t, vol, pos) {
    const ch = this._chan(pos, vol * 1.1, 30, 500, 0.6); if (!ch) return;
    this._osc('sawtooth', 70, t, 1.6, 0.55, { sweep: 42, dest: ch });
    this._osc('square', 105, t + 0.1, 1.3, 0.3, { sweep: 60, dest: ch });
    this._noise(t, 1.5, 0.4, { type: 'lowpass', freq: 900, sweep: 160, dest: ch });
  }
  _s_alarm(t, vol, pos) {
    const ch = this._chan(pos, vol * 0.8, 40, 600, 0.4); if (!ch) return;
    for (let i = 0; i < 3; i++) this._osc('square', 440, t + i * 0.3, 0.22, 0.22, { sweep: 660, dest: ch });
  }
  _s_objective(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.6; g.connect(this.sfxBus);
    [392, 523, 659].forEach((f, i) => this._osc('triangle', f, t + i * 0.09, 0.4, 0.2, { dest: g }));
  }
  _s_fail(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.6; g.connect(this.sfxBus);
    [440, 330, 220].forEach((f, i) => this._osc('sawtooth', f, t + i * 0.13, 0.4, 0.2, { dest: g }));
  }
  _s_wipe(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.9; g.connect(this.sfxBus);
    this._osc('sawtooth', 220, t, 2.2, 0.4, { sweep: 40, dest: g });
    this._noise(t, 2.0, 0.4, { type: 'lowpass', freq: 1200, sweep: 80, dest: g });
  }
  _s_chest(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.7; g.connect(this.sfxBus);
    [523, 659, 784, 1047, 1319].forEach((f, i) => this._osc('sine', f, t + i * 0.08, 0.55, 0.17, { dest: g }));
  }
  _s_exotic(t, vol) {
    const g = this.ctx.createGain(); g.gain.value = vol * 0.85; g.connect(this.sfxBus);
    [349, 523, 698, 1047, 1397].forEach((f, i) => {
      this._osc('sine', f, t + i * 0.1, 1.1, 0.16, { dest: g });
      this._osc('triangle', f * 1.5, t + i * 0.1, 0.8, 0.07, { dest: g });
    });
  }

  /* -------------------------------------------------------------- music */

  _startMusic() {
    this.padGain = this.ctx.createGain();
    this.padGain.gain.value = 0.0;
    this.padGain.connect(this.musicBus);
    this._chordT = 0;
    this._chordI = 0;
  }

  /** Called every frame. `intensity` 0..1 = how much combat is happening. */
  updateMusic(dt, intensity) {
    if (!this.ok || this.muted) return;
    this._combat = lerp(this._combat, clamp01(intensity), 1 - Math.exp(-1.2 * dt));
    this._chordT -= dt;
    if (this._chordT <= 0) {
      this._chordT = 7.5;
      this._playChord();
    }
    if (this._combat > 0.25) {
      this._pulseT -= dt;
      if (this._pulseT <= 0) {
        this._pulseT = lerp(0.62, 0.34, this._combat);
        this._playPulse();
      }
    }
  }

  // D minor-ish progression; the 4th chord is the "something is coming" one.
  static get PROG() {
    return [
      [146.83, 174.61, 220.0],   // Dm
      [130.81, 164.81, 196.0],   // C
      [116.54, 146.83, 174.61],  // Bb
      [110.0, 138.59, 164.81]    // A (major third: tension)
    ];
  }

  _playChord() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const chord = AudioEngine.PROG[this._chordI % 4];
    this._chordI++;
    const dur = 8.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 + this._combat * 0.1, t + 2.2);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500 + this._combat * 1800, t);
    g.connect(f); f.connect(this.musicBus);
    for (const base of chord) {
      for (const [mult, det, type, amp] of [[1, -6, 'sawtooth', 0.3], [1, 7, 'sawtooth', 0.3], [2, 0, 'sine', 0.16]]) {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = type;
        o.frequency.value = base * mult;
        o.detune.value = det;
        og.gain.value = amp;
        o.connect(og); og.connect(g);
        o.start(t); o.stop(t + dur + 0.1);
      }
    }
  }

  _playPulse() {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.value = 0.5 * this._combat;
    g.connect(this.musicBus);
    this._osc('sine', 62, t, 0.34, 0.6, { sweep: 42, dest: g });
    this._noise(t, 0.1, 0.12 * this._combat, { type: 'highpass', freq: 6000, dest: g });
  }

  /** Footstep throttle helper so movement code stays simple. */
  footstep(now, pos, interval, vol) {
    if (now - this._lastFoot < interval) return;
    this._lastFoot = now;
    this.play('step', { pos, vol });
  }
}

export const Audio = new AudioEngine();
export default Audio;
