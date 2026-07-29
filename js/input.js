/* STARFALL — input.js
   Pointer-lock mouse look + edge-triggered action map.
   Game code never reads raw key codes; it asks for actions. */

const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'ControlRight'],
  traversal: ['KeyC'],   // not ShiftRight: that is already sprint
  reload: ['KeyR'],
  melee: ['KeyV'],
  grenade: ['KeyQ'],
  classAbility: ['KeyE'],
  interact: ['KeyF'],
  super: ['KeyX'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  swap: ['KeyG'],
  map: ['KeyM'],
  inventory: ['Tab'],
  roster: ['KeyO'],
  chat: ['Enter'],
  pause: ['Escape'],
  ping: ['KeyZ'],
  debug: ['Backquote']
};

/* Anything past this in one event is a glitch, not a flick. */
const SPIKE = 900;
const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const SENS_KEY = 'starfall.sens.v1';

class InputManager {
  constructor() {
    this.enabled = false;
    this.locked = false;
    this.keys = new Set();
    this.prevKeys = new Set();
    this.mouseDown = [false, false, false];
    this.prevMouseDown = [false, false, false];
    this.dx = 0; this.dy = 0;      // accumulated look delta for this frame
    this._dx = 0; this._dy = 0;    // accumulator between frames
    this.wheel = 0;
    this._wheel = 0;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.rawMouse = false;         // did unadjustedMovement take?
    this._settleT = 0;             // events to swallow after a lock change
    this.captureText = false;      // chat mode: swallow keys
    this.textBuffer = '';
    this.onText = null;            // (line|null) when chat closes
    this.el = null;
    this.bindings = BINDINGS;
    this._handlers = [];
  }

  /** 0.1 .. 3.0, where 1 is the default feel. Persisted across sessions. */
  get sensScale() { return this.sensitivity / 0.0022; }
  setSensScale(v) {
    this.sensitivity = 0.0022 * clampNum(v, 0.1, 3);
    try { localStorage.setItem(SENS_KEY, String(this.sensScale)); } catch (e) { /* private mode */ }
  }

  init(el) {
    if (typeof document === 'undefined') return;
    this.el = el;
    this.enabled = true;
    try {
      const saved = parseFloat(localStorage.getItem(SENS_KEY));
      if (isFinite(saved)) this.sensitivity = 0.0022 * clampNum(saved, 0.1, 3);
    } catch (e) { /* private mode */ }

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._handlers.push([target, type, fn]);
    };

    on(document, 'keydown', e => this._keydown(e));
    on(document, 'keyup', e => this._keyup(e));
    on(document, 'mousedown', e => {
      if (!this.locked) return;
      if (e.button < 3) this.mouseDown[e.button] = true;
    });
    on(document, 'mouseup', e => { if (e.button < 3) this.mouseDown[e.button] = false; });
    on(document, 'mousemove', e => {
      if (!this.locked) return;
      let mx = e.movementX || 0, my = e.movementY || 0;
      // Chrome can deliver one enormous delta on the frame pointer lock engages
      // (and after alt-tab), which reads as the view being ripped away. A real
      // flick is well under this even on a high-DPI mouse.
      if (this._settleT > 0 || Math.abs(mx) > SPIKE || Math.abs(my) > SPIKE) {
        if (this._settleT > 0) this._settleT--;
        if (Math.abs(mx) > SPIKE || Math.abs(my) > SPIKE) return;
      }
      this._dx += mx;
      this._dy += my;
    });
    on(document, 'wheel', e => {
      if (!this.locked) return;
      this._wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      // Drop the first couple of events after (re)locking, and any look delta
      // that queued up while we were unlocked.
      this._settleT = 2;
      this._dx = 0; this._dy = 0;
      if (!this.locked) { this.keys.clear(); this.mouseDown = [false, false, false]; }
    });
    on(window, 'blur', () => { this.keys.clear(); this.mouseDown = [false, false, false]; });
    // Right click aims; never let the browser menu eat it.
    on(el, 'contextmenu', e => e.preventDefault());
  }

  dispose() {
    for (const [t, type, fn] of this._handlers) t.removeEventListener(type, fn);
    this._handlers.length = 0;
  }

  /* Raw input. Without unadjustedMovement the browser hands us deltas that
     Windows has already run through its pointer-acceleration curve, so the same
     physical flick turns a different amount depending how fast you moved. That
     is the "not smooth" everyone feels and no amount of sensitivity tuning
     fixes. It returns a promise that rejects where unsupported (Safari, older
     Chrome), so fall back to a plain lock. */
  lock() {
    if (!this.el || this.locked) return;
    let p;
    try {
      p = this.el.requestPointerLock({ unadjustedMovement: true });
    } catch (e) {
      p = null;
    }
    if (p && p.catch) {
      p.then(() => { this.rawMouse = true; }).catch(() => {
        this.rawMouse = false;
        try { const q = this.el.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch (e2) { /* gone */ }
      });
    }
  }
  unlock() { if (typeof document !== 'undefined' && document.exitPointerLock) document.exitPointerLock(); }

  _keydown(e) {
    if (this.captureText) {
      if (e.key === 'Enter') { const t = this.textBuffer; this.textBuffer = ''; this.captureText = false; if (this.onText) this.onText(t); }
      else if (e.key === 'Escape') { this.textBuffer = ''; this.captureText = false; if (this.onText) this.onText(null); }
      else if (e.key === 'Backspace') this.textBuffer = this.textBuffer.slice(0, -1);
      else if (e.key.length === 1 && this.textBuffer.length < 120) this.textBuffer += e.key;
      e.preventDefault();
      return;
    }
    // Tab and Space scroll/blur the page if we let them through.
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
  }

  _keyup(e) { this.keys.delete(e.code); }

  startTextEntry(cb) {
    this.captureText = true;
    this.textBuffer = '';
    this.onText = cb;
  }

  /** Snapshot edges + drain accumulators. Call once at the top of the frame. */
  beginFrame() {
    this.dx = this._dx * this.sensitivity;
    this.dy = this._dy * this.sensitivity * (this.invertY ? -1 : 1);
    this._dx = 0; this._dy = 0;
    this.wheel = this._wheel;
    this._wheel = 0;
  }

  /** Call at the very end of the frame so `pressed()` is one-frame accurate. */
  endFrame() {
    this.prevKeys = new Set(this.keys);
    this.prevMouseDown = this.mouseDown.slice();
  }

  _anyDown(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }
  _anyWasDown(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.prevKeys.has(c)) return true;
    return false;
  }

  down(action) { return this._anyDown(action); }
  pressed(action) { return this._anyDown(action) && !this._anyWasDown(action); }
  released(action) { return !this._anyDown(action) && this._anyWasDown(action); }

  get fire() { return this.mouseDown[0]; }
  get firePressed() { return this.mouseDown[0] && !this.prevMouseDown[0]; }
  get ads() { return this.mouseDown[2]; }
  get adsPressed() { return this.mouseDown[2] && !this.prevMouseDown[2]; }
  get meleeMouse() { return this.mouseDown[1] && !this.prevMouseDown[1]; }

  /** Movement vector in local space, already normalised. */
  moveAxis(out) {
    let x = 0, z = 0;
    if (this.down('forward')) z -= 1;
    if (this.down('back')) z += 1;
    if (this.down('left')) x -= 1;
    if (this.down('right')) x += 1;
    const l = Math.hypot(x, z);
    if (l > 1e-4) { x /= l; z /= l; }
    out.x = x; out.z = z;
    return out;
  }

  /** Test hook: lets the headless harness drive the game without a browser. */
  simulate({ keys = [], mouse = [false, false, false], dx = 0, dy = 0, wheel = 0 } = {}) {
    this.keys = new Set(keys);
    this.mouseDown = mouse.slice();
    this._dx = dx / (this.sensitivity || 1);
    this._dy = dy / (this.sensitivity || 1);
    this._wheel = wheel;
    this.locked = true;
  }
}

export const Input = new InputManager();
export default Input;
