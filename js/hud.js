// On-screen controls. Pointer events cover touch, mouse and pen alike.

/** A thumb stick. `value` is x to the right and y away from the player, each in -1...1. */
export class Joystick {
  constructor(element, knob) {
    this.element = element;
    this.knob = knob;
    this.value = [0, 0];
    this.pointer = null;
    element.addEventListener('pointerdown', (e) => {
      if (this.pointer !== null) return;
      this.pointer = e.pointerId;
      element.setPointerCapture(e.pointerId);
      this.update(e);
      e.preventDefault();
    });
    element.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pointer) this.update(e);
    });
    const end = (e) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      this.set(0, 0);
    };
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
    element.addEventListener('lostpointercapture', end);
  }

  update(e) {
    const rect = this.element.getBoundingClientRect();
    const travel = rect.width * 0.30;
    let x = (e.clientX - (rect.left + rect.width / 2)) / travel;
    let y = ((rect.top + rect.height / 2) - e.clientY) / travel;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    this.set(x, y);
  }

  set(x, y) {
    this.value = [x, y];
    const travel = this.element.clientWidth * 0.30;
    this.knob.style.transform = `translate(${(x * travel).toFixed(1)}px, ${(-y * travel).toFixed(1)}px)`;
  }
}

/** Calls `action` the moment the button goes down (not on release), like an arcade button. */
export function pressButton(element, action) {
  element.addEventListener('pointerdown', (e) => {
    element.classList.add('down');
    try { element.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
    action();
    e.preventDefault();
  });
  const up = () => element.classList.remove('down');
  element.addEventListener('pointerup', up);
  element.addEventListener('pointercancel', up);
  element.addEventListener('lostpointercapture', up);
  // Keyboard and assistive activation arrive as a click with no pointer.
  element.addEventListener('click', (e) => { if (e.detail === 0) action(); });
}

/**
 * Arrow-key (and WASD) stick. A quick tap still counts as a short push, so one key press nudges
 * the claw instead of doing nothing.
 */
export class KeyStick {
  constructor() {
    this.value = [0, 0];
    this.generation = [0, 0];
    this.downTime = [0, 0];
    this.held = new Map();
  }
  set(axis, value, down) {
    const minimumHold = 120;
    const generation = ++this.generation[axis];
    if (down) {
      this.downTime[axis] = performance.now();
      this.value[axis] = value;
      return;
    }
    const release = () => {
      if (this.generation[axis] === generation) this.value[axis] = 0;
    };
    const held = performance.now() - this.downTime[axis];
    if (held >= minimumHold) release(); else setTimeout(release, minimumHold - held);
  }
  reset() {
    this.value = [0, 0];
    this.generation[0]++;
    this.generation[1]++;
  }
}
