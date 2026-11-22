// The physical glass, placed in world space. Plain geometry; no DOM.
import { V } from './math.js';
import { Panel } from './projection.js';

/** Physical numbers the depth effect depends on. Estimates until checked against a real iPhone Duo. */
export const Calibration = {
  /** Points (CSS pixels) per metre of glass: the usual 460 ppi iPhone panel at 3x. */
  pointsPerMetre: 460.0 / 3.0 / 0.0254,
  /** In the stage stance the lower half is a glass lid this far above the tray floor. */
  trayDepth: 0.012,
  /** Distance between a viewer's pupils. */
  interpupillary: 0.063,
  /** Stage stance below `stageEnter`; once in it, stay until `stageExit`. */
  stageEnter: 150 * Math.PI / 180,
  stageExit: 162 * Math.PI / 180,
};

/**
 * Builds the rig.
 *
 * input:
 *   sizePoints     [w, h] of the page's viewport in CSS pixels
 *   pixelsPerPoint device pixels per CSS pixel of the canvas
 *   hingeAngle     radians (pi = flat), or null when there is no fold to account for
 *   foldAxis       'vertical' (book) or 'horizontal' (laptop); default: vertical when w >= h
 *   foldPoints     where the fold crosses the viewport, in CSS pixels from its left edge (vertical
 *                  fold) or top edge (horizontal fold). Default: the midline. A browser's toolbar
 *                  makes the viewport shorter than the screen, so the fold is usually NOT at the
 *                  viewport's midline.
 *   cameraEdge     'top' | 'bottom' | 'left' | 'right': the viewport edge nearest the front camera
 *   chromeTop      CSS pixels of browser toolbar above the viewport (moves the camera estimate)
 *   pointsPerMetre defaults to Calibration.pointsPerMetre
 * previous: the stance of the last rig, for hysteresis.
 *
 * The world never changes shape with the hinge: only the panels move.
 */
export function makeRig(input, previous = null) {
  const ppm = input.pointsPerMetre ?? Calibration.pointsPerMetre;
  const ppp = input.pixelsPerPoint;
  const wp = input.sizePoints[0], hp = input.sizePoints[1];
  const w = wp / ppm, h = hp / ppm;
  const pw = wp * ppp, ph = hp * ppp;
  const edge = input.cameraEdge ?? 'top';
  const chrome = (input.chromeTop ?? 0) / ppm;
  const base = { size: [w, h] };

  if (input.hingeAngle == null) {
    const panel = new Panel([-w / 2, -h / 2, 0], [w, 0, 0], [0, h, 0], { x: 0, y: 0, width: pw, height: ph });
    return finish({ ...base, stance: 'window', axis: 'none', hingeAngle: Math.PI, panels: [panel], cameraPanel: 0,
      foldSplit: null }, edge, chrome);
  }

  const theta = Math.min(Math.max(input.hingeAngle, 0.5), Math.PI);
  const half = (Math.PI - theta) / 2;      // each half's tilt; 0 when flat
  const c = Math.cos(half), s = Math.sin(half);
  const axis = input.foldAxis ?? (w >= h ? 'vertical' : 'horizontal');

  if (axis === 'vertical') {
    // Book: both halves swing towards the viewer about the fold.
    const fp = Math.min(Math.max(input.foldPoints ?? wp / 2, 1), wp - 1);
    const a = fp / ppm, b = w - a;          // widths of the left and right parts
    const hx = a - w / 2;                   // where the fold sits when the display is flat
    const left = new Panel([hx - a * c, -h / 2, a * s], [a * c, 0, -a * s], [0, h, 0],
      { x: 0, y: 0, width: fp * ppp, height: ph });
    const right = new Panel([hx, -h / 2, 0], [b * c, 0, b * s], [0, h, 0],
      { x: fp * ppp, y: 0, width: pw - fp * ppp, height: ph });
    return finish({ ...base, stance: 'window', axis, hingeAngle: theta, panels: [left, right],
      cameraPanel: edge === 'left' ? 0 : 1, foldSplit: [a, b] }, edge, chrome);
  }

  // Fold is a horizontal line `fp` below the top of the viewport.
  const fp = Math.min(Math.max(input.foldPoints ?? hp / 2, 1), hp - 1);
  const t = fp / ppm, bt = h - t;           // heights of the top and bottom parts
  const stage = theta < Calibration.stageEnter || (previous === 'stage' && theta < Calibration.stageExit);
  const bottomViewport = { x: 0, y: fp * ppp, width: pw, height: ph - fp * ppp };
  const topViewport = { x: 0, y: 0, width: pw, height: fp * ppp };
  const cameraPanel = edge === 'bottom' ? 0 : 1;

  if (stage) {
    // Lower part lies flat `trayDepth` above the floor; upper part rises from the hinge.
    const g = Calibration.trayDepth;
    const floorPanel = new Panel([-w / 2, g, bt], [w, 0, 0], [0, 0, -bt], bottomViewport);
    const wallPanel = new Panel([-w / 2, g, 0], [w, 0, 0], [0, Math.sin(theta) * t, Math.cos(theta) * t], topViewport);
    return finish({ ...base, stance: 'stage', axis, hingeAngle: theta, panels: [floorPanel, wallPanel],
      cameraPanel, foldSplit: [bt, t] }, edge, chrome);
  }

  const hy = h / 2 - t;                     // where the fold sits when the display is flat
  const bottom = new Panel([-w / 2, hy - bt * c, bt * s], [w, 0, 0], [0, bt * c, -bt * s], bottomViewport);
  const top = new Panel([-w / 2, hy, 0], [w, 0, 0], [0, t * c, t * s], topViewport);
  return finish({ ...base, stance: 'window', axis, hingeAngle: theta, panels: [bottom, top],
    cameraPanel, foldSplit: [bt, t] }, edge, chrome);
}

function finish(rig, edge, chrome) {
  const panel = rig.panels[rig.cameraPanel];
  // Estimated lens position: the middle of the camera edge, a little inside the glass. Browser
  // toolbar above the viewport pushes the real lens further out along that panel.
  let cam;
  const ru = V.norm(panel.up);
  switch (edge) {
    case 'bottom': cam = panel.point(0.5, 0.03); break;
    case 'left': cam = V.mad(panel.point(0.03, 0.5), ru, chrome / 2); break;
    case 'right': cam = V.mad(panel.point(0.97, 0.5), ru, chrome / 2); break;
    default: cam = V.mad(panel.point(0.5, 0.97), ru, chrome); break;
  }
  rig.cameraPosition = cam;
  rig.cameraEdge = edge;

  /** A comfortable resting viewpoint for this stance, used when there is no camera. */
  if (rig.stance === 'stage') {
    const reach = 0.36, elevation = 40 * Math.PI / 180;
    rig.defaultEye = [0, reach * Math.sin(elevation), reach * Math.cos(elevation)];
  } else {
    rig.defaultEye = [0, 0, 0.20 + Math.max(rig.size[0], rig.size[1])];
  }
  return rig;
}

/**
 * Converts an eye position measured by the camera into world space. The measurement is in the
 * camera's own frame: x to the viewport's right, y to its up, z straight out of the glass.
 */
export function worldEye(rig, e) {
  const p = rig.panels[rig.cameraPanel];
  let out = rig.cameraPosition;
  out = V.mad(out, V.norm(p.right), e[0]);
  out = V.mad(out, V.norm(p.up), e[1]);
  return V.mad(out, p.normal, e[2]);
}

/** Keeps an eye position on the viewer's side of every panel, so no frustum degenerates. */
export function clampedEye(rig, eye, margin = 0.03) {
  let e = eye;
  for (let pass = 0; pass < 2; pass++) {
    for (const p of rig.panels) {
      const d = p.distance(e);
      if (d < margin) e = V.mad(e, p.normal, margin - d);
    }
  }
  return e;
}
