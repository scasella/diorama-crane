// Decides where the viewer's eyes are each frame. Sources: the camera (real head tracking), a
// finger or mouse drag, a slow automatic sweep that shows the depth when nothing else is driving
// it, and a pinned pose for repeatable screenshots.
import { V, clamp } from './math.js';
import { Calibration, worldEye, clampedEye } from './rig.js';
import { OneEuroFilter3 } from './filters.js';

const now = () => performance.now() / 1000;

export class EyeController {
  constructor() {
    this.settings = {
      invertX: false,
      invertY: false,
      /** Multiplies the measured viewing distance. The browser cannot report the camera's field
       *  of view, so this is the one number that may need adjusting on a real device. */
      distanceScale: 1,
      /** Sweep the viewpoint automatically while nothing else is driving it. */
      demoSweep: true,
      /** How far ahead to extrapolate head motion, to hide camera and render latency. */
      predictionLead: 0.035,
    };
    this.source = 'demo';
    /** The camera currently sees a face. */
    this._cameraTracking = false;
    /** The camera is on, whether or not it sees a face right now. While it is on we never start
     *  the automatic sweep: if the face is lost we hold the last viewpoint, then settle to straight-on. */
    this.cameraRunning = false;
    /** A pinned viewpoint: { az, el } in radians and a distance scale. */
    this.fixedPose = null;

    this.dragAz = 0;
    this.dragEl = 0;
    this.dragging = false;
    this.lastDragTime = -100;
    this.demoPhase = 0;
    this.smoothed = null;
    this.transition = 0;
    this.filter = new OneEuroFilter3(1.1, 1.6);
    this.cameraSample = null;
    this.lastCameraTarget = null;
    this.recentre = [0, 0];
    this.pendingRecentre = false;
    this.lastSampleTime = 0;
  }

  get cameraTracking() { return this._cameraTracking; }
  set cameraTracking(on) {
    if (!on && this._cameraTracking) this.filter.reset();
    this._cameraTracking = on;
  }

  // ---- Inputs

  /** sample: { left, right, time } with eye positions in the camera frame, metres. */
  ingest(sample) {
    const dt = clamp(sample.time - this.lastSampleTime, 1 / 240, 0.1);
    this.lastSampleTime = sample.time;
    const s = this.settings;
    const flip = (v) => [s.invertX ? -v[0] : v[0], s.invertY ? -v[1] : v[1], v[2]];
    const c = flip(V.mul(V.add(sample.left, sample.right), 0.5));
    c[2] *= s.distanceScale;
    const filtered = this.filter.filter(c, dt);
    let half = flip(V.mul(V.sub(sample.right, sample.left), 0.5));
    if (this.cameraSample) half = V.lerp(this.cameraSample.halfAxis, half, 0.25);
    this.cameraSample = { center: filtered, halfAxis: half, time: sample.time };
  }

  drag(dx, dy) {
    this.dragging = true;
    this.lastDragTime = now();
    this.dragAz = clamp(this.dragAz + dx * 0.0042, -0.72, 0.72);
    this.dragEl = clamp(this.dragEl - dy * 0.0042, -0.42, 0.62);
  }

  endDrag() {
    this.dragging = false;
    this.lastDragTime = now();
  }

  /** Declares "I am looking straight at the screen now". Cancels any drag offset, and with the
   *  camera running also absorbs the unknown position of the lens on the device. */
  recenter() {
    this.dragAz = 0;
    this.dragEl = 0;
    this.lastDragTime = -100;
    this.pendingRecentre = true;
  }

  // ---- Output

  orbit(rig, az, el, dist) {
    const stage = rig.stance === 'stage';
    const pivot = stage ? [0, Calibration.trayDepth, 0.02] : [0, 0, 0];
    const offset = V.sub(rig.defaultEye, pivot);
    const radius = V.len(offset) * dist;
    const base = Math.atan2(offset[1], offset[2]);
    const e = clamp(base + el, 0.12 - (stage ? 0 : 1.0), 1.35);
    return V.add(pivot, V.mul([Math.sin(az) * Math.cos(e), Math.sin(e), Math.cos(az) * Math.cos(e)], radius));
  }

  /** Without a camera the resting viewpoint looks slightly down into the cabinet, so the prize
   *  floor is visible. (With a camera the viewer's real position decides.) */
  restLift(rig) { return rig.stance === 'stage' ? 0 : 0.17; }

  cameraFrame(world, rig) {
    const p = rig.panels[rig.cameraPanel];
    const d = V.sub(world, rig.cameraPosition);
    return [V.dot(d, V.norm(p.right)), V.dot(d, V.norm(p.up)), V.dot(d, p.normal)];
  }

  /** Returns { center, left, right } eye positions in world space. */
  eyes(rig, dt, separation) {
    const t = now();
    const s = this.settings;
    let target, halfAxis = null, source;
    const sample = this.cameraSample;
    const dragIdle = !this.dragging && t - this.lastDragTime > 2.5;

    if (this.fixedPose) {
      source = 'fixed';
      target = this.orbit(rig, this.fixedPose.az, this.fixedPose.el, this.fixedPose.dist);
    } else if (this.cameraTracking && sample && t - sample.time < 0.5 && dragIdle) {
      source = 'camera';
      if (this.pendingRecentre) {
        const want = this.cameraFrame(rig.defaultEye, rig);
        this.recentre = [want[0] - sample.center[0], want[1] - sample.center[1]];
      }
      // Extrapolate a few tens of milliseconds along the head's current velocity.
      const age = Math.min(0.08, t - sample.time);
      const c = V.mad(sample.center, this.filter.velocity, age + s.predictionLead);
      c[0] += this.recentre[0];
      c[1] += this.recentre[1];
      c[2] = Math.max(0.12, c[2]);
      target = worldEye(rig, c);
      this.lastCameraTarget = { eye: target, time: t };
      const p = rig.panels[rig.cameraPanel];
      halfAxis = V.add(V.add(V.mul(V.norm(p.right), sample.halfAxis[0]), V.mul(V.norm(p.up), sample.halfAxis[1])), V.mul(p.normal, sample.halfAxis[2]));
    } else if (this.cameraRunning && dragIdle) {
      // Face out of view: stay put briefly (a blink, a glance away), then ease to straight-on.
      source = 'camera';
      target = this.lastCameraTarget && t - this.lastCameraTarget.time < 1.5 ? this.lastCameraTarget.eye : this.orbit(rig, 0, 0, 1);
    } else if (this.dragging || t - this.lastDragTime < 4 || !s.demoSweep) {
      source = 'drag';
      target = this.orbit(rig, this.dragAz, this.dragEl + this.restLift(rig), 1);
    } else {
      source = 'demo';
      // Ease any leftover drag offset back to rest, then sweep on a slow ellipse.
      this.dragAz *= Math.max(0, 1 - 2 * dt);
      this.dragEl *= Math.max(0, 1 - 2 * dt);
      this.demoPhase += dt * 0.85;
      target = this.orbit(rig, this.dragAz + 0.30 * Math.sin(this.demoPhase),
        this.dragEl + this.restLift(rig) + 0.12 * Math.cos(this.demoPhase), 1 + 0.05 * Math.sin(this.demoPhase * 0.43));
    }
    this.pendingRecentre = false;

    if (source !== this.source) {
      this.source = source;
      this.transition = 0.4;
    }
    this.transition = Math.max(0, this.transition - dt);

    // The camera path is already filtered; everything else, and any change of source, is eased.
    const live = source === 'camera' && this.cameraTracking && this.transition === 0;
    const tau = live || source === 'fixed' ? 0 : (source === 'camera' ? 0.25 : 0.09);
    const center = this.smoothed && tau > 0 ? V.lerp(this.smoothed, target, 1 - Math.exp(-dt / tau)) : target;
    this.smoothed = center;
    const clamped = clampedEye(rig, center);

    // Eye-to-eye axis: measured when the camera sees both pupils, otherwise level and square to the view.
    const lookAt = rig.stance === 'stage' ? [0, Calibration.trayDepth, 0.02] : [0, 0, 0];
    const viewDir = V.norm(V.sub(lookAt, clamped));
    let axis = V.cross(viewDir, [0, 1, 0]);
    axis = V.len(axis) > 1e-4 ? V.norm(axis) : [1, 0, 0];
    const dir = halfAxis && V.len(halfAxis) > 1e-4 ? V.norm(halfAxis) : axis;
    const half = V.mul(dir, separation / 2);
    return { center: clamped, left: clampedEye(rig, V.sub(clamped, half)), right: clampedEye(rig, V.add(clamped, half)) };
  }
}
