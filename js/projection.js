// Head-coupled perspective. Plain geometry in metres; no DOM, so the same module runs under node
// in Tests/web/.
import { V, M } from './math.js';

/** One flat piece of glass. Each half of the Duo's display is a Panel. */
export class Panel {
  /**
   * @param origin  lower-left corner as the viewer sees it, in world space
   * @param right   full-width edge, pointing to the viewer's right
   * @param up      full-height edge, pointing to the viewer's up
   * @param viewport where this panel sits in the canvas: {x, y, width, height} in device pixels,
   *                 origin top-left (the renderer flips it for WebGL)
   */
  constructor(origin, right, up, viewport) {
    this.origin = origin;
    this.right = right;
    this.up = up;
    this.viewport = viewport;
  }
  /** Unit normal, pointing out of the glass towards the viewer. */
  get normal() { return V.norm(V.cross(this.right, this.up)); }
  get center() { return V.mad(V.mad(this.origin, this.right, 0.5), this.up, 0.5); }
  /** A point on the glass from normalised panel coordinates (0...1 each way). */
  point(u, v) { return V.mad(V.mad(this.origin, this.right, u), this.up, v); }
  /** Signed distance of a point in front of (+) or behind (-) the glass. */
  distance(p) { return V.dot(V.sub(p, this.origin), this.normal); }
}

/**
 * Generalised (off-axis) perspective projection: the frustum whose apex is the eye and whose four
 * side planes pass exactly through the four edges of the panel. Anything drawn with it lands on
 * the glass where the straight line from the eye to that point crosses the glass, which is what
 * makes a screen behave like a window instead of a picture.
 *
 * Clip space follows WebGL: x, y and depth all in -1...1.
 * Returns null when the eye is on or behind the plane of the glass.
 */
export function offAxisView(panel, eye, far = 4.0) {
  const vr = V.norm(panel.right);
  const vu = V.norm(panel.up);
  const vn = V.norm(V.cross(vr, vu));

  const va = V.sub(panel.origin, eye);
  const vb = V.sub(V.add(panel.origin, panel.right), eye);
  const vc = V.sub(V.add(panel.origin, panel.up), eye);

  const d = -V.dot(va, vn);
  if (!(d > 0.005)) return null;

  // Near plane is parallel to the glass. Keep it well in front of the glass so that things that
  // pop out of the screen are not clipped, but not so close that depth precision suffers.
  const n = Math.max(0.004, Math.min(0.03, d * 0.12));
  const f = d + far;

  const l = V.dot(vr, va) * n / d;
  const r = V.dot(vr, vb) * n / d;
  const b = V.dot(vu, va) * n / d;
  const t = V.dot(vu, vc) * n / d;

  const proj = [
    2 * n / (r - l), 0, 0, 0,
    0, 2 * n / (t - b), 0, 0,
    (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1,
    0, 0, -2 * f * n / (f - n), 0,
  ];

  // Rotate world into the panel's own axes, then move the eye to the origin.
  const view = [
    vr[0], vu[0], vn[0], 0,
    vr[1], vu[1], vn[1], 0,
    vr[2], vu[2], vn[2], 0,
    -V.dot(vr, eye), -V.dot(vu, eye), -V.dot(vn, eye), 1,
  ];

  return { view, proj, viewProj: M.mul(proj, view), eyeDistance: d };
}

/**
 * Where the straight line from `eye` through `point` crosses the plane of `panel`, in the panel's
 * normalised coordinates. Used by the tests.
 */
export function sightline(eye, point, panel) {
  const n = panel.normal;
  const dir = V.sub(point, eye);
  const denom = V.dot(dir, n);
  if (Math.abs(denom) <= 1e-7) return null;
  const s = V.dot(V.sub(panel.origin, eye), n) / denom;
  if (!(s > 0)) return null;
  const hit = V.sub(V.mad(eye, dir, s), panel.origin);
  return [V.dot(hit, panel.right) / V.len2(panel.right), V.dot(hit, panel.up) / V.len2(panel.up)];
}
