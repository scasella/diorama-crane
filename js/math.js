// Small vector, quaternion and matrix helpers. Vectors are plain arrays; matrices are arrays of
// 16 numbers in column-major order (the layout WebGL expects), so m[c * 4 + r].
//
// World space is right-handed: +x to the viewer's right, +y up, +z towards the viewer.

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  neg: (a) => [-a[0], -a[1], -a[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  len2: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
  /** a + b * s */
  mad: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

/** Quaternions are [x, y, z, w]. */
export const Q = {
  identity: () => [0, 0, 0, 1],
  axisAngle(angle, axis) {
    const a = V.norm(axis), s = Math.sin(angle / 2);
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
  },
  mul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  },
  normalize(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  },
  /** The shortest rotation that takes unit vector `a` onto unit vector `b`. */
  fromTo(a, b) {
    const d = V.dot(a, b);
    if (d < -0.999999) {
      let axis = V.cross([1, 0, 0], a);
      if (V.len(axis) < 1e-5) axis = V.cross([0, 1, 0], a);
      return Q.axisAngle(Math.PI, axis);
    }
    const c = V.cross(a, b);
    return Q.normalize([c[0], c[1], c[2], 1 + d]);
  },
};

export const M = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],

  mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  },

  /** Product of any number of matrices, left to right. */
  chain(...ms) {
    let o = ms[0];
    for (let i = 1; i < ms.length; i++) o = M.mul(o, ms[i]);
    return o;
  },

  translation: (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1],
  scale: (s) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1],
  uniformScale: (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1],

  rotationQ(q) {
    const [x, y, z, w] = q;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1,
    ];
  },
  rotation: (angle, axis) => M.rotationQ(Q.axisAngle(angle, axis)),

  /** Columns `right`, `up`, their unit normal, and a translation: places a unit quad in the world. */
  basis(right, up, centre) {
    const n = V.norm(V.cross(right, up));
    return [right[0], right[1], right[2], 0, up[0], up[1], up[2], 0, n[0], n[1], n[2], 0, centre[0], centre[1], centre[2], 1];
  },

  /** Orthographic projection in WebGL clip space (depth -1 near ... +1 far). */
  orthographic(l, r, b, t, n, f) {
    return [
      2 / (r - l), 0, 0, 0,
      0, 2 / (t - b), 0, 0,
      0, 0, -2 / (f - n), 0,
      -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
    ];
  },

  lookAt(eye, target, up) {
    const z = V.norm(V.sub(eye, target));
    const x = V.norm(V.cross(up, z));
    const y = V.cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -V.dot(x, eye), -V.dot(y, eye), -V.dot(z, eye), 1];
  },

  /** Transforms a point (w = 1); returns [x, y, z, w]. */
  point(m, p) {
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
    ];
  },

  /** Inverse transpose of the upper-left 3x3, as 9 numbers in column-major order. */
  normalMatrix(m) {
    const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    let det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-30) det = 1e-30;
    const s = 1 / det;
    // The cofactor matrix divided by the determinant is exactly the inverse transpose.
    return [
      A * s, B * s, C * s,
      (c * h - b * i) * s, (a * i - c * g) * s, (b * g - a * h) * s,
      (b * f - c * e) * s, (c * d - a * f) * s, (a * e - b * d) * s,
    ];
  },
};

export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
export const DEG = Math.PI / 180;
