/* Minimal browser stub shared by the probe and scratch scripts. */
const noop = () => {};
const grad = { addColorStop: noop };
export function fakeCtx2d() {
  return {
    canvas: { width: 1280, height: 720 },
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, rect: noop, fill: noop, stroke: noop, fillRect: noop, strokeRect: noop,
    clearRect: noop, fillText: noop, strokeText: noop, translate: noop, rotate: noop, scale: noop,
    setTransform: noop, drawImage: noop, createRadialGradient: () => grad, createLinearGradient: () => grad,
    measureText: () => ({ width: 40 }), putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) })
  };
}
export function fakeElement(tag) {
  const e = {
    tagName: tag, style: {}, children: [], className: '', id: '', innerHTML: '', textContent: '',
    width: 1280, height: 720,
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => fakeElement('div'), querySelectorAll: () => [],
    getContext: () => fakeCtx2d(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    setAttribute: noop, focus: noop, classList: { add: noop, remove: noop, toggle: noop }
  };
  e.style.setProperty = noop;
  return e;
}
globalThis.document = {
  readyState: 'complete',
  createElement: fakeElement,
  createElementNS: fakeElement,
  getElementById: () => fakeElement('div'),
  body: fakeElement('body'),
  addEventListener: noop, removeEventListener: noop,
  exitPointerLock: noop, pointerLockElement: null
};
globalThis.window = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  addEventListener: noop, removeEventListener: noop
};
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); }
};
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);
