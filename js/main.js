// Diorama Crane, web version: page set-up, settings, input and the frame loop.
import { DEG, clamp } from './math.js';
import { makeRig, Calibration } from './rig.js';
import { Renderer } from './renderer.js';
import { World, makeRoom, sameRoom } from './world.js';
import { EyeController } from './eye.js';
import { Joystick, KeyStick, pressButton } from './hud.js';
import { HeadTracker } from './tracker.js';

// Shown at the bottom of the menu, so it is clear which copy a phone is running: a web host and
// a Home Screen icon can both hold on to an older one for a while.
const BUILD = '2026-11-22.1';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

// ---- Options from the address bar, for repeatable runs:
//   ?eyeAz=-20&eyeEl=10&demo=0&stereo=anaglyph&fold=110&markers=1&empty=1&hud=0
const query = new URLSearchParams(location.search);
const param = {
  has: (k) => query.has(k),
  num: (k) => (query.has(k) && query.get(k) !== '' && Number.isFinite(Number(query.get(k))) ? Number(query.get(k)) : null),
  bool: (k) => (query.has(k) ? !/^(0|no|false|off)$/i.test(query.get(k)) : null),
  str: (k) => query.get(k),
};

// ---- Settings the player can change, remembered between visits.
const STORE = 'dioramaCrane.settings.v1';
const settings = {
  camera: false,
  sweep: true,
  foldOn: false,
  foldAngle: 110,
  foldNudge: { vertical: 0, horizontal: 0 },
  anaglyph: false,
  foldPreview: false,
  autoplay: true,
  invertX: false,
  invertY: false,
  distanceScale: 1,
};
try {
  if (query.has('reset')) localStorage.removeItem(STORE);   // ?reset=1 forgets saved settings
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(settings)) {
      if (typeof saved[key] === typeof settings[key]) settings[key] = saved[key];
    }
    settings.foldNudge = { vertical: Number(saved.foldNudge?.vertical) || 0, horizontal: Number(saved.foldNudge?.horizontal) || 0 };
  }
} catch (_) { /* private browsing, or nothing saved */ }
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (_) { /* not available */ }
}

// Address-bar options win over saved settings, without being saved themselves.
if (param.bool('demo') !== null) settings.sweep = param.bool('demo');
if (param.bool('autoplay') !== null) settings.autoplay = param.bool('autoplay');
if (param.bool('foldPreview') !== null) settings.foldPreview = param.bool('foldPreview');
if (param.bool('camera') !== null) settings.camera = param.bool('camera');
if (param.has('stereo')) settings.anaglyph = param.str('stereo') === 'anaglyph';
if (param.has('fold')) {
  const angle = param.num('fold');
  settings.foldOn = angle !== null && angle > 0 && angle < 179.5;
  if (settings.foldOn) settings.foldAngle = clamp(angle, 30, 179);
}
const frozen = param.bool('freeze') === true;
const dumpEnabled = param.bool('markers') === true || param.bool('dump') === true;
const fixedScale = param.num('scale');
if (param.bool('hud') === false) document.body.classList.add('nohud');

// ---- Physical scale. One CSS pixel is one point on an iPhone; other screens are coarser.
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const pointsPerMetre = param.num('ppi') ? param.num('ppi') / 0.0254 : (isIOS ? Calibration.pointsPerMetre : 110 / 0.0254);
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
if (standalone) document.documentElement.classList.add('standalone');

// ---- Renderer.
let renderer;
try {
  renderer = new Renderer(canvas, { antialias: param.num('msaa') !== 0 });
} catch (error) {
  const notice = $('notice');
  notice.textContent = 'Diorama Crane needs WebGL2, which this browser did not provide. (' + error.message + ')';
  notice.hidden = false;
  throw error;
}

const eye = new EyeController();
const joystick = new Joystick($('stick'), $('knob'));
const keys = new KeyStick();
const tracker = new HeadTracker($('camera'));
let world = null;
let rig = null;
let previewActive = false;
let renderScale = fixedScale ? clamp(fixedScale, 0.3, 1) : 1;

if (param.num('eyeAz') !== null || param.num('eyeEl') !== null) {
  eye.fixedPose = { az: (param.num('eyeAz') || 0) * DEG, el: (param.num('eyeEl') || 0) * DEG, dist: param.num('eyeDist') || 1 };
}
if (param.str('delegate')) tracker.delegate = param.str('delegate').toUpperCase() === 'CPU' ? 'CPU' : 'GPU';

function applySettings() {
  eye.settings.demoSweep = settings.sweep;
  eye.settings.invertX = settings.invertX;
  eye.settings.invertY = settings.invertY;
  eye.settings.distanceScale = settings.distanceScale;
  if (world) world.autoplay = settings.autoplay;
}
applySettings();

// ---- Layout: how the page sits on the physical screen.
//
// Safari tells a page nothing about the fold: no hinge angle, no posture, no fold position. What
// a page can see is its own viewport and the size of the window around it. The fold runs through
// the middle of the screen's longer side, and Safari's toolbar sits above the page, so in
// portrait the fold is NOT at the middle of the viewport. Added to the Home Screen the page
// starts at the top of the screen and covers all of it, so there the two coincide.
// (Measured in the iPhone Duo simulator: outerHeight is the screen, and everything Safari adds
// is above the page. In Home Screen mode innerHeight is still short, by the top safe area, but
// nothing is above the page; see style.css.)
function layout() {
  const iw = window.innerWidth, ih = window.innerHeight;
  let ow = iw, oh = ih;
  if (isIOS && window.outerWidth >= iw && window.outerHeight >= ih) {
    ow = window.outerWidth;
    oh = window.outerHeight;
  }
  const chromeTop = standalone ? 0 : clamp(oh - ih, 0, 260);
  const axis = ow >= oh ? 'vertical' : 'horizontal';
  const explicit = param.num('foldPos');
  let fold;
  if (explicit !== null) fold = explicit;
  else if (axis === 'vertical') fold = iw / 2 + settings.foldNudge.vertical;
  else fold = oh / 2 - chromeTop + settings.foldNudge.horizontal;
  // Only the Duo's inner screen folds; its long side is 951 points, the outer screen's 678.
  const foldable = param.has('fold') || !isIOS || Math.max(ow, oh) >= 800;
  let cameraEdge = 'top';
  if (axis === 'vertical') {
    const type = screen.orientation && screen.orientation.type;
    const angle = typeof window.orientation === 'number' ? window.orientation : null;
    // Turned anticlockwise (landscape-primary, 90) the top of the phone, and its camera, is on the left.
    cameraEdge = (type === 'landscape-secondary' || angle === -90 || angle === 270) ? 'right' : 'left';
  }
  return { iw, ih, ow, oh, chromeTop, axis, fold, foldable, cameraEdge };
}

function resizeCanvas() {
  const dpr = (window.devicePixelRatio || 1) * renderScale;
  const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

// ---- Game set-up.
function ensureWorld(room) {
  if (!world) {
    world = new World(room, Math.max(1, Math.floor(param.num('seed') || 7)));
    world.autoplay = settings.autoplay;
    world.showMarkers = param.bool('markers') === true;
    if (param.bool('empty') === true) {
      world.debugEmpty = true;
      world.rebuild(room);
    }
    world.onScore = (score) => { $('score').textContent = 'WON ' + score; };
    return;
  }
  if (!sameRoom(room, world.room)) {
    world.rebuild(room);
    // The cabinet is laid out afresh for the new stance; a short dip hides the swap.
    canvas.classList.add('dip');
    requestAnimationFrame(() => requestAnimationFrame(() => canvas.classList.remove('dip')));
  }
}

// ---- Frame loop.
let lastTime = 0;
let frameCount = 0;
let fps = 0;
const fpsWindow = { start: 0, frames: 0 };
const pace = { frames: 0, slow: 0 };

function frame(timeMs) {
  requestAnimationFrame(frame);
  const dt = lastTime ? Math.min(0.1, Math.max(0.001, (timeMs - lastTime) / 1000)) : 1 / 60;
  lastTime = timeMs;

  resizeCanvas();
  const L = layout();
  const folded = settings.foldOn && L.foldable;
  // The cabinet is sized from the page (so a change of render scale never rebuilds it); the
  // panels' pixel rectangles come from the canvas.
  const dpr = canvas.width / canvas.clientWidth;
  // Snap the fold to a whole device pixel so the two WebGL viewports meet exactly on it.
  const foldPoints = Math.round(L.fold * dpr) / dpr;
  const input = {
    sizePoints: [canvas.clientWidth, canvas.clientHeight],
    pixelsPerPoint: dpr,
    hingeAngle: folded ? settings.foldAngle * DEG : null,
    foldAxis: L.axis,
    foldPoints,
    cameraEdge: L.cameraEdge,
    chromeTop: L.chromeTop,
    pointsPerMetre,
  };
  rig = makeRig(input, rig ? rig.stance : null);
  ensureWorld(makeRoom(rig));

  let sx = joystick.value[0] + keys.value[0], sy = joystick.value[1] + keys.value[1];
  const len = Math.hypot(sx, sy);
  if (len > 1) { sx /= len; sy /= len; }
  world.stick = [sx, sy];
  if (!frozen) world.update(dt);

  const eyes = eye.eyes(rig, dt, Calibration.interpupillary);
  const views = settings.anaglyph
    ? [{ position: eyes.left, mode: 1 }, { position: eyes.right, mode: 2 }]
    : [{ position: eyes.center, mode: 0 }];
  previewActive = settings.foldPreview && rig.axis !== 'none' && rig.hingeAngle < 172 * DEG;

  renderer.render({ rig, eyes: views, draws: world.buildDrawList(), room: world.room,
    contactSpheres: world.contactSpheres(), time: world.time, foldPreview: previewActive, previewEye: eyes.center });

  frameCount++;
  fpsWindow.frames++;
  if (!fpsWindow.start) fpsWindow.start = timeMs;
  if (timeMs - fpsWindow.start >= 1000) {
    fps = fpsWindow.frames * 1000 / (timeMs - fpsWindow.start);
    fpsWindow.start = timeMs;
    fpsWindow.frames = 0;
  }
  adaptQuality(dt);
  if (frameCount % 10 === 0) updateStatus();
  updateFoldLine(L, foldPoints, folded);
  if (dumpEnabled && frameCount % 15 === 0) dumpFrame(L, eyes);
}

/** If the device cannot keep up at full resolution, render a little smaller. Never steps back up. */
function adaptQuality(dt) {
  if (fixedScale || document.hidden) return;
  pace.frames++;
  if (pace.frames < 90) return;          // ignore start-up hitches
  if (dt > 1 / 40) pace.slow++;
  if (pace.frames >= 270) {
    if (pace.slow > 90 && renderScale > 0.62) renderScale = Math.max(0.6, renderScale - 0.15);
    pace.frames = 90;
    pace.slow = 0;
  }
}

function updateStatus() {
  let text;
  if (tracker.state === 'starting') text = tracker.detail;
  else if (eye.source === 'camera') text = tracker.state === 'tracking' ? 'Tracking your head' : 'Looking for your face…';
  else if (eye.source === 'fixed') text = 'Fixed viewpoint';
  else if (eye.source === 'drag') text = 'Drag to look around';
  else text = 'Auto sweep · drag to look around';
  if (previewActive) text = 'Fold preview · ' + text;
  const chip = $('status');
  if (chip.textContent !== text) chip.textContent = text;
}

// ---- Fold line guide, shown while the fold is being adjusted.
let foldGuideUntil = 0;
function updateFoldLine(L, foldPoints, folded) {
  const line = $('foldLine');
  const show = (folded && performance.now() < foldGuideUntil) || param.bool('showFold') === true;
  if (!show) {
    if (!line.hidden) line.hidden = true;
    return;
  }
  line.hidden = false;
  if (L.axis === 'vertical') line.style.cssText = `left:${foldPoints - 0.5}px;top:0;width:1px;height:100%`;
  else line.style.cssText = `top:${foldPoints - 0.5}px;left:0;height:1px;width:100%`;
}

// ---- Geometry dump for Tools/verify_markers.py (only with ?markers=1 or ?dump=1, and only to
// the development server that served the page).
function dumpFrame(L, eyes) {
  const dpr = window.devicePixelRatio || 1;
  const body = {
    stance: rig.stance,
    hingeDegrees: rig.hingeAngle / DEG,
    panels: rig.panels.map((p) => ({ origin: p.origin, right: p.right, up: p.up, viewport: [p.viewport.x, p.viewport.y, p.viewport.width, p.viewport.height] })),
    eye: eyes.center, leftEye: eyes.left, rightEye: eyes.right,
    markers: world.debugMarkers(),
    drawable: [canvas.width, canvas.height],
    // Where the canvas sits in a screenshot of the whole screen, in screenshot pixels.
    screenOffset: [Math.round((L.ow - L.iw) / 2 * dpr), Math.round(L.chromeTop * dpr)],
    screenScale: dpr / (canvas.width / canvas.clientWidth),
    claw: { x: world.claw.x, z: world.claw.z, hubY: world.claw.hubY, open: world.claw.open, phase: world.claw.phase, holding: world.claw.heldID !== null },
    score: world.score,
    prizes: world.prizes.length,
    prizeList: world.prizes.map((p) => [p.p[0], p.p[1], p.p[2], p.r]),
    keyStick: keys.value.slice(),
    lastKey,
    focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
    stick: world.stick.slice(),
    chute: [...world.room.chuteX, ...world.room.chuteZ],
    fps,
    eyeSource: eye.source,
    foldPreview: previewActive,
    anaglyph: settings.anaglyph,
    sweep: settings.sweep,
    page: { innerWidth: L.iw, innerHeight: L.ih, outerWidth: L.ow, outerHeight: L.oh, chromeTop: L.chromeTop, dpr, renderScale,
      foldAxis: L.axis, foldPoints: L.fold, standalone, cameraEdge: L.cameraEdge, userAgent: ua, metrics: pageMetrics() },
    tracker: { state: tracker.state, ...tracker.stats },
    settings,
    control: param.str('ctl'),
  };
  fetch('__report/frame.json', { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
}

function pageMetrics() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;left:0;top:0;width:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const safe = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
  const units = {};
  for (const unit of ['vh', 'lvh', 'svh', 'dvh']) {
    probe.style.cssText = `position:fixed;visibility:hidden;left:0;top:0;width:0;height:100${unit}`;
    units[unit] = parseFloat(getComputedStyle(probe).height);
  }
  probe.remove();
  const vv = window.visualViewport;
  const rect = canvas.getBoundingClientRect();
  return { safe, units, visual: vv ? [vv.width, vv.height, vv.offsetLeft, vv.offsetTop] : null,
    client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
    canvas: [rect.left, rect.top, rect.width, rect.height], screen: [screen.width, screen.height],
    navigatorStandalone: navigator.standalone, displayMode: ['standalone', 'fullscreen', 'browser'].filter((m) => matchMedia(`(display-mode: ${m})`).matches) };
}

// Test runs only: the development server (Tools/serve.py) can point this page at the next set of
// options, so a series of screenshots reuses one tab, and a copy added to the Home Screen can be
// driven too. Any other server answers 404 and the page stops asking.
if (dumpEnabled || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  const timer = setInterval(async () => {
    try {
      const response = await fetch('__report/control.json', { cache: 'no-store' });
      if (!response.ok) {
        if (!dumpEnabled) clearInterval(timer);
        return;
      }
      const next = await response.json();
      if (next.id && String(next.id) !== param.str('ctl')) location.replace('index.html?' + next.query + '&ctl=' + next.id);
    } catch (_) {
      if (!dumpEnabled) clearInterval(timer);
    }
  }, 600);
}

// ---- Input: drag to look, double tap to recenter.
const look = { pointer: null, x: 0, y: 0, startX: 0, startY: 0, startTime: 0, lastTap: 0, lastTapX: 0, lastTapY: 0 };
canvas.addEventListener('pointerdown', (e) => {
  closeMenu();
  if (look.pointer !== null) return;
  look.pointer = e.pointerId;
  look.x = look.startX = e.clientX;
  look.y = look.startY = e.clientY;
  look.startTime = performance.now();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
  // Keys from a hardware keyboard only reach the page while something in it has focus.
  if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
  wake();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== look.pointer) return;
  const dx = e.clientX - look.x, dy = e.clientY - look.y;
  look.x = e.clientX;
  look.y = e.clientY;
  // A tap wobbles by a few pixels; only a real drag should move the viewpoint.
  if (eye.dragging || Math.hypot(e.clientX - look.startX, e.clientY - look.startY) > 6) eye.drag(dx, dy);
});
const endLook = (e) => {
  if (e.pointerId !== look.pointer) return;
  look.pointer = null;
  const moved = Math.hypot(e.clientX - look.startX, e.clientY - look.startY);
  const now = performance.now();
  if (eye.dragging) eye.endDrag();
  if (e.type === 'pointerup' && moved < 10 && now - look.startTime < 300) {
    if (now - look.lastTap < 380 && Math.hypot(e.clientX - look.lastTapX, e.clientY - look.lastTapY) < 44) {
      eye.recenter();
      look.lastTap = 0;
    } else {
      look.lastTap = now;
      look.lastTapX = e.clientX;
      look.lastTapY = e.clientY;
    }
  }
};
canvas.addEventListener('pointerup', endLook);
canvas.addEventListener('pointercancel', endLook);

pressButton($('drop'), () => { world?.pressDrop(); wake(); });

// Keyboard: arrows or WASD move the claw, space or return drops it.
const keyMap = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [1, 1], ArrowDown: [1, -1], a: [0, -1], d: [0, 1], w: [1, 1], s: [1, -1] };
function onKey(e, down) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('#menu')) return;   // let sliders and switches have their keys
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (keyMap[key]) {
    if (!(down && e.repeat)) keys.set(keyMap[key][0], keyMap[key][1], down);
    e.preventDefault();
  } else if (key === ' ' || key === 'Enter') {
    if (down && !e.repeat) world?.pressDrop();
    e.preventDefault();
  } else if (key === 'Escape' && down) {
    closeMenu();
  }
}
let lastKey = null;
addEventListener('keydown', (e) => { lastKey = e.key; onKey(e, true); });
addEventListener('keyup', (e) => onKey(e, false));
addEventListener('blur', () => keys.reset());

// Keep Safari's own gestures (pinch zoom, double-tap zoom, rubber-band scrolling) out of the game.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (!(e.target instanceof Element && e.target.closest('#menu'))) e.preventDefault();
}, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Keep the screen awake while playing.
let wakeLock = null;
async function wake() {
  if (wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) { /* not allowed right now */ }
}
document.addEventListener('visibilitychange', () => {
  lastTime = 0;
  if (!document.hidden && frameCount > 0) wake();
});

// ---- Head tracking.
tracker.onSample = (sample) => eye.ingest(sample);
tracker.onStateChange = (state) => {
  eye.cameraTracking = state === 'tracking';
  eye.cameraRunning = state === 'tracking' || state === 'searching';
  if (state === 'denied' || state === 'unavailable' || state === 'error') settings.camera = false;
  refreshMenu();
};
function setCamera(on) {
  settings.camera = on;
  if (on) tracker.start(); else tracker.stop();
  refreshMenu();
}

// ---- Menu.
const menu = $('menu'), menuButton = $('menuButton');
function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
}
menuButton.addEventListener('click', () => {
  menu.hidden = !menu.hidden;
  menuButton.setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) refreshMenu();
});

function refreshMenu() {
  $('optCamera').checked = settings.camera && tracker.state !== 'idle';
  const note = { unavailable: tracker.detail, denied: 'Camera access is off for this page', error: tracker.detail, starting: tracker.detail,
    searching: 'On. Analysed on this device only.', tracking: 'On. Analysed on this device only.' }[tracker.state];
  $('cameraNote').textContent = note || (HeadTracker.supported
    ? 'Uses the front camera. Analysed on this device only. Loads a face model from Google and jsDelivr the first time.'
    : (window.isSecureContext ? 'This browser gives pages no camera.' : 'Needs an https address.'));
  $('optCamera').disabled = !HeadTracker.supported;
  $('optSweep').checked = settings.sweep;
  $('optFold').checked = settings.foldOn;
  $('foldAngleRow').hidden = !settings.foldOn;
  $('foldNudgeRow').hidden = !settings.foldOn;
  $('optFoldAngle').value = String(settings.foldAngle);
  $('foldAngleOut').textContent = settings.foldAngle + '°';
  const axis = layout().axis;
  const nudge = settings.foldNudge[axis];
  $('foldNudgeOut').textContent = (nudge > 0 ? '+' : '') + nudge + ' pt';
  $('optGlasses').checked = settings.anaglyph;
  $('optPreview').checked = settings.foldPreview;
  $('optAutoplay').checked = settings.autoplay;
  $('optFlipX').checked = settings.invertX;
  $('optFlipY').checked = settings.invertY;
  $('optDistance').value = String(Math.round(settings.distanceScale * 100));
  $('distanceOut').textContent = Math.round(settings.distanceScale * 100) + '%';
  $('installTip').hidden = !(isIOS && !standalone);
  $('buildInfo').textContent = 'Build ' + BUILD + (standalone ? ' · from the Home Screen' : '');
}

function bindToggle(id, key, after) {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    applySettings();
    after?.();
    save();
    refreshMenu();
  });
}
$('optCamera').addEventListener('change', (e) => { setCamera(e.target.checked); save(); });
bindToggle('optSweep', 'sweep');
bindToggle('optFold', 'foldOn', () => { foldGuideUntil = performance.now() + 2500; });
bindToggle('optGlasses', 'anaglyph');
bindToggle('optPreview', 'foldPreview');
bindToggle('optAutoplay', 'autoplay');
bindToggle('optFlipX', 'invertX');
bindToggle('optFlipY', 'invertY');
$('optRecenter').addEventListener('click', () => { eye.recenter(); closeMenu(); });
$('optFoldAngle').addEventListener('input', (e) => {
  settings.foldAngle = clamp(Math.round(Number(e.target.value)), 30, 179);
  $('foldAngleOut').textContent = settings.foldAngle + '°';
});
$('optFoldAngle').addEventListener('change', save);
function nudgeFold(by) {
  const axis = layout().axis;
  settings.foldNudge[axis] = clamp(settings.foldNudge[axis] + by, -120, 120);
  foldGuideUntil = performance.now() + 2500;
  save();
  refreshMenu();
}
$('foldNudgeMinus').addEventListener('click', () => nudgeFold(-1));
$('foldNudgePlus').addEventListener('click', () => nudgeFold(1));
$('optDistance').addEventListener('input', (e) => {
  settings.distanceScale = clamp(Number(e.target.value) / 100, 0.5, 1.8);
  $('distanceOut').textContent = Math.round(settings.distanceScale * 100) + '%';
  applySettings();
});
$('optDistance').addEventListener('change', save);

refreshMenu();

// Start head tracking straight away only if it was on last time and the browser already has
// permission; otherwise wait for the switch, so the camera prompt never appears unasked.
if (settings.camera) {
  const explicit = param.bool('camera') === true;
  settings.camera = false;
  (async () => {
    let granted = explicit;
    try {
      const status = await navigator.permissions.query({ name: 'camera' });
      granted = granted || status.state === 'granted';
    } catch (_) { /* cannot ask; wait for the switch */ }
    if (granted && HeadTracker.supported) setCamera(true); else refreshMenu();
  })();
}

// For poking at from a console or a test.
window.dioramaCrane = { settings, eye, tracker, get world() { return world; }, get rig() { return rig; }, get fps() { return fps; },
  get renderScale() { return renderScale; }, layout };

canvas.focus({ preventScroll: true });
requestAnimationFrame(frame);
