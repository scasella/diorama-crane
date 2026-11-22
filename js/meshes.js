// Procedural meshes. Each is { vertices: Float32Array (position 3, normal 3, uv 2), indices: Uint16Array }.
import { V } from './math.js';

class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.indices = [];
  }
  get count() { return this.positions.length; }
  add(p, n, uv = [0, 0]) {
    this.positions.push(p);
    this.normals.push(V.norm(n));
    this.uvs.push(uv);
    return this.positions.length - 1;
  }
  tri(a, b, c) { this.indices.push(a, b, c); }
  /** A flat-shaded triangle with its own three vertices. */
  flatTri(a, b, c) {
    const n = V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
    this.tri(this.add(a, n), this.add(b, n), this.add(c, n));
  }
  flatQuad(a, b, c, d) {
    const n = V.norm(V.cross(V.sub(b, a), V.sub(d, a)));
    const i = this.add(a, n, [0, 0]), j = this.add(b, n, [1, 0]), k = this.add(c, n, [1, 1]), l = this.add(d, n, [0, 1]);
    this.tri(i, j, k);
    this.tri(i, k, l);
  }
  /** Makes every triangle counter-clockwise when seen from the side its normals point to, so
   *  back-face culling can never disagree with the shading normals. */
  fixWinding() {
    const ix = this.indices;
    for (let i = 0; i + 2 < ix.length; i += 3) {
      const a = ix[i], b = ix[i + 1], c = ix[i + 2];
      const face = V.cross(V.sub(this.positions[b], this.positions[a]), V.sub(this.positions[c], this.positions[a]));
      const avg = V.add(V.add(this.normals[a], this.normals[b]), this.normals[c]);
      if (V.dot(face, avg) < 0) { ix[i + 1] = c; ix[i + 2] = b; }
    }
  }
  build() {
    this.fixWinding();
    const vertices = new Float32Array(this.count * 8);
    for (let i = 0; i < this.count; i++) {
      vertices.set(this.positions[i], i * 8);
      vertices.set(this.normals[i], i * 8 + 3);
      vertices.set(this.uvs[i], i * 8 + 6);
    }
    return { vertices, indices: new Uint16Array(this.indices) };
  }
}

/** Unit square in XY, facing +z. */
function quad() {
  const m = new MeshBuilder();
  m.flatQuad([-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0]);
  return m;
}

/** Unit cube, centred. */
function box() {
  const m = new MeshBuilder(), h = 0.5;
  m.flatQuad([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]);
  m.flatQuad([h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]);
  m.flatQuad([h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]);
  m.flatQuad([-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]);
  m.flatQuad([-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]);
  m.flatQuad([-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]);
  return m;
}

/** Radius 0.5. */
function sphere(segments, rings) {
  const m = new MeshBuilder();
  for (let r = 0; r <= rings; r++) {
    const v = r / rings, phi = v * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const u = s / segments, theta = u * 2 * Math.PI;
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      m.add(V.mul(n, 0.5), n, [u, v]);
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s, b = a + 1, c = (r + 1) * row + s + 1, d = (r + 1) * row + s;
      if (r > 0) m.tri(a, b, c);
      if (r < rings - 1) m.tri(a, c, d);
    }
  }
  return m;
}

/** A faceted ball: reads as a cut gem from any side and rolls like the sphere it collides as. */
function gem() {
  const m = new MeshBuilder();
  const segments = 9, rings = 5;
  const point = (r, s) => {
    const phi = r / rings * Math.PI;
    // Twist alternate rings so the facets form triangles rather than a globe grid.
    const theta = (s + (r % 2 === 0 ? 0 : 0.5)) / segments * 2 * Math.PI;
    return [Math.sin(phi) * Math.cos(theta) * 0.5, Math.cos(phi) * 0.5, Math.sin(phi) * Math.sin(theta) * 0.5];
  };
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = point(r, s), b = point(r, s + 1), c = point(r + 1, s), d = point(r + 1, s + 1);
      if (r % 2 === 0) {
        if (r > 0) m.flatTri(a, b, d);
        if (r < rings - 1) m.flatTri(a, d, c);   // at the last ring c and d are both the pole
      } else {
        m.flatTri(a, b, c);
        if (r < rings - 1) m.flatTri(b, d, c);
      }
    }
  }
  // Make every facet's normal point away from the centre; winding is fixed up to match later.
  for (let i = 0; i < m.count; i += 3) {
    const centroid = V.mul(V.add(V.add(m.positions[i], m.positions[i + 1]), m.positions[i + 2]), 1 / 3);
    if (V.dot(m.normals[i], centroid) < 0) {
      const flipped = V.neg(m.normals[i]);
      for (let k = 0; k < 3; k++) m.normals[i + k] = flipped;
    }
  }
  return m;
}

/** Radius 0.5, height 1 along y. */
function cylinder(segments) {
  const m = new MeshBuilder();
  for (let s = 0; s <= segments; s++) {
    const u = s / segments, a = u * 2 * Math.PI;
    const n = [Math.cos(a), 0, Math.sin(a)];
    m.add([n[0] * 0.5, 0.5, n[2] * 0.5], n, [u, 0]);
    m.add([n[0] * 0.5, -0.5, n[2] * 0.5], n, [u, 1]);
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
    m.tri(a, c, b);
    m.tri(b, c, d);
  }
  for (const [y, ny] of [[0.5, 1], [-0.5, -1]]) {
    const centre = m.add([0, y, 0], [0, ny, 0]);
    const rim = [];
    for (let s = 0; s <= segments; s++) {
      const a = s / segments * 2 * Math.PI;
      rim.push(m.add([Math.cos(a) * 0.5, y, Math.sin(a) * 0.5], [0, ny, 0]));
    }
    for (let s = 0; s < segments; s++) m.tri(centre, rim[s], rim[s + 1]);
  }
  return m;
}

/** Base radius 0.5 at y = -0.5, tip at y = +0.5. */
function cone(segments) {
  const m = new MeshBuilder();
  const sl = Math.hypot(1, 0.5), sx = 1 / sl, sy = 0.5 / sl;
  for (let s = 0; s < segments; s++) {
    const a0 = s / segments * 2 * Math.PI, a1 = (s + 1) / segments * 2 * Math.PI, am = (a0 + a1) / 2;
    const i = m.add([Math.cos(a0) * 0.5, -0.5, Math.sin(a0) * 0.5], [Math.cos(a0) * sx, sy, Math.sin(a0) * sx]);
    const j = m.add([Math.cos(a1) * 0.5, -0.5, Math.sin(a1) * 0.5], [Math.cos(a1) * sx, sy, Math.sin(a1) * sx]);
    const k = m.add([0, 0.5, 0], [Math.cos(am) * sx, sy, Math.sin(am) * sx]);
    m.tri(i, j, k);
  }
  const centre = m.add([0, -0.5, 0], [0, -1, 0]);
  const rim = [];
  for (let s = 0; s <= segments; s++) {
    const a = s / segments * 2 * Math.PI;
    rim.push(m.add([Math.cos(a) * 0.5, -0.5, Math.sin(a) * 0.5], [0, -1, 0]));
  }
  for (let s = 0; s < segments; s++) m.tri(centre, rim[s], rim[s + 1]);
  return m;
}

/** Flat annulus in XZ facing +y, outer radius 0.5. */
function ring(segments, inner) {
  const m = new MeshBuilder();
  for (let s = 0; s <= segments; s++) {
    const u = s / segments, a = u * 2 * Math.PI;
    m.add([Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5], [0, 1, 0], [u, 1]);
    m.add([Math.cos(a) * inner, 0, Math.sin(a) * inner], [0, 1, 0], [u, 0]);
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
    m.tri(a, b, c);
    m.tri(b, d, c);
  }
  return m;
}

/** Two-sided triangle hanging down from y = 0. */
function pennant() {
  const m = new MeshBuilder();
  const a = [-0.5, 0, 0], b = [0.5, 0, 0], c = [0, -1, 0];
  m.flatTri(a, c, b);
  m.flatTri(a, b, c);
  return m;
}

export function makeMeshes() {
  return {
    quad: quad().build(),
    box: box().build(),
    sphere: sphere(40, 24).build(),
    gem: gem().build(),
    cylinder: cylinder(28).build(),
    cone: cone(28).build(),
    ring: ring(48, 0.38).build(),
    pennant: pennant().build(),
  };
}
