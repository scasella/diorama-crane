// Finds the viewer's eyes with the front camera, entirely in the browser. Frames are analysed on
// the device and dropped; nothing is stored or sent anywhere.
//
// The browser has no face detector of its own (Safari ships none), so the landmark model comes
// from Google's MediaPipe Tasks library. It is fetched the first time head tracking is switched
// on, from the two URLs below. To serve it yourself, copy those files next to the page and
// change the URLs.
//
// NOTE: this has run against a synthetic video stream (web/dev/tracker.html) but never against a
// real camera on a real iPhone. The axis conventions below assume what Safari normally delivers:
// frames upright for the current orientation and not mirrored. If a device proves otherwise the
// menu's "Flip left/right", "Flip up/down" and "Viewing distance" correct it without a rebuild.

export const TrackerSources = {
  vision: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3',
  model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

export const TrackerOptics = {
  /** Field of view along the frame's longer side, in degrees. A browser cannot ask the camera
   *  for this, so it is an estimate; it only scales the measured distance, never the direction. */
  longSideFov: 68,
  interpupillary: 0.063,
};

// MediaPipe face mesh indices: iris centres, and the eye corners as a fallback.
const IRIS_A = 468, IRIS_B = 473;
const CORNERS_A = [33, 133], CORNERS_B = [362, 263];

/**
 * Turns one face's landmarks into two eye positions in the camera's frame as the page sees it:
 * +x to the page's right, +y up, +z straight out of the glass towards the viewer, in metres.
 *
 * landmarks: MediaPipe normalised landmarks (x, y in 0...1 of the frame, origin top-left).
 * mirrored: true if the frame is a mirror image (a selfie preview); camera frames normally are not.
 * Returns { left, right } (viewer's left and right as seen from the screen) or null.
 */
export function eyesFromLandmarks(landmarks, width, height, { longSideFov = TrackerOptics.longSideFov, interpupillary = TrackerOptics.interpupillary, mirrored = false } = {}) {
  if (!landmarks || landmarks.length < 264) return null;
  const pixel = (lm) => [lm.x * width, lm.y * height];
  const mid = (i, j) => {
    const a = pixel(landmarks[i]), b = pixel(landmarks[j]);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const hasIris = landmarks.length > IRIS_B;
  const a = hasIris ? pixel(landmarks[IRIS_A]) : mid(...CORNERS_A);
  const b = hasIris ? pixel(landmarks[IRIS_B]) : mid(...CORNERS_B);
  if (![...a, ...b].every(Number.isFinite)) return null;

  // Focal length in pixels. Rotating the frame does not change the pixel scale, so the long
  // side and its field of view give it directly.
  const focal = (Math.max(width, height) / 2) / Math.tan(longSideFov * Math.PI / 360);
  const gap = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]));
  const distance = interpupillary * focal / gap;
  // The camera looks back at the viewer, so in an unmirrored frame the frame's right is the
  // page's left. Image y runs downwards.
  const sx = mirrored ? 1 : -1;
  const toCamera = (p) => [sx * (p[0] - width / 2) / focal * distance, -(p[1] - height / 2) / focal * distance, distance];
  const ea = toCamera(a), eb = toCamera(b);
  return ea[0] <= eb[0] ? { left: ea, right: eb } : { left: eb, right: ea };
}

let landmarkerPromise = null;
let landmarkerDelegate = null;

/** Loads the library and model once. Tries the GPU first and falls back to the CPU. */
export function loadLandmarker(preferred = 'GPU') {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import(/* @vite-ignore */ `${TrackerSources.vision}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${TrackerSources.vision}/wasm`);
      const create = (delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: TrackerSources.model, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      const order = preferred === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
      let lastError;
      for (const delegate of order) {
        try {
          const landmarker = await create(delegate);
          landmarkerDelegate = delegate;
          return landmarker;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

/**
 * States: idle, starting (asking for the camera, loading the model), searching (running, no face
 * in view), tracking, unavailable (no camera, or the page is not on https), denied, error.
 */
export class HeadTracker {
  constructor(video) {
    this.video = video;
    this.state = 'idle';
    this.detail = '';
    this.onStateChange = null;
    /** Called for every frame in which both eyes were found: { left, right, time } (seconds). */
    this.onSample = null;
    this.stream = null;
    this.ownsStream = false;
    this.landmarker = null;
    this.running = false;
    this.generation = 0;
    this.lastSeen = 0;
    this.lastTimestamp = 0;
    this.mirrored = false;
    this.delegate = 'GPU';
    this.stats = { frames: 0, faces: 0, fps: 0, width: 0, height: 0, delegate: null, detectMs: 0 };
    this._fpsWindow = { start: 0, frames: 0 };
  }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  setState(state, detail = '') {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.onStateChange?.(state, detail);
  }

  /**
   * Starts tracking. Call it from a tap so the browser can show its camera prompt.
   * `stream` substitutes another video source for the camera (used by the test page).
   */
  async start({ stream = null } = {}) {
    if (this.running) return;
    const generation = ++this.generation;
    this.running = true;
    this.setState('starting', 'Starting camera…');
    try {
      if (stream) {
        this.stream = stream;
        this.ownsStream = false;
      } else {
        if (!HeadTracker.supported) {
          this.running = false;
          this.setState('unavailable', window.isSecureContext ? 'No camera access in this browser' : 'Needs an https page');
          return;
        }
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          // A small frame is plenty to find two pupils and keeps latency down.
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
        });
        this.ownsStream = true;
      }
      if (generation !== this.generation) { this.release(); return; }
      this.video.srcObject = this.stream;
      await this.video.play();
      this.setState('starting', 'Loading head tracking…');
      this.landmarker = await loadLandmarker(this.delegate);
      if (generation !== this.generation) { this.release(); return; }
      this.stats.delegate = landmarkerDelegate;
      this.lastSeen = 0;
      this.setState('searching');
      this.schedule(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.running = false;
      this.release();
      const name = error && error.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') this.setState('denied', 'Camera access is off');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') this.setState('unavailable', 'No camera here');
      else this.setState('error', 'Head tracking could not start');
      console.warn('Head tracking could not start:', error);
    }
  }

  stop() {
    this.generation++;
    this.running = false;
    this.release();
    this.setState('idle');
  }

  release() {
    if (this.stream && this.ownsStream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  schedule(generation) {
    const step = (now, metadata) => {
      if (generation !== this.generation) return;
      this.process(now, metadata);
      this.schedule(generation);
    };
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(step);
    else requestAnimationFrame((t) => step(t, null));
  }

  process(now, metadata) {
    const video = this.video;
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height || video.readyState < 2) return;
    // The model wants strictly increasing timestamps in milliseconds.
    const stamp = Math.max(performance.now(), this.lastTimestamp + 1);
    this.lastTimestamp = stamp;
    let result;
    const t0 = performance.now();
    try {
      result = this.landmarker.detectForVideo(video, stamp);
    } catch (error) {
      console.warn('Head tracking stopped:', error);
      this.generation++;
      this.running = false;
      this.release();
      this.setState('error', 'Head tracking stopped');
      return;
    }
    const t1 = performance.now();
    const s = this.stats;
    s.frames++;
    s.width = width;
    s.height = height;
    s.detectMs += (t1 - t0 - s.detectMs) * 0.1;
    const w = this._fpsWindow;
    w.frames++;
    if (t1 - w.start >= 1000) {
      s.fps = w.frames * 1000 / (t1 - w.start);
      w.start = t1;
      w.frames = 0;
    }

    const eyes = eyesFromLandmarks(result.faceLandmarks && result.faceLandmarks[0], width, height, { mirrored: this.mirrored });
    if (!eyes) {
      if (this.state === 'tracking' && t1 - this.lastSeen > 600) this.setState('searching');
      return;
    }
    s.faces++;
    this.lastSeen = t1;
    // Prefer the moment the frame was captured, so the eye controller can extrapolate to "now".
    let time = t1;
    const captured = metadata && (metadata.captureTime || metadata.expectedDisplayTime);
    if (captured && t1 - captured >= 0 && t1 - captured < 250) time = captured;
    this.setState('tracking');
    this.onSample?.({ left: eyes.left, right: eyes.right, time: time / 1000 });
  }
}
