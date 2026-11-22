// WebGL2 renderer. It knows nothing about the game beyond a list of draw items:
//   { mesh, model, colorA, colorB?, shininess?, specular?, emissive?, pattern?, patternParams?, castsShadow? }
import { M, V } from './math.js';
import { offAxisView } from './projection.js';
import { makeMeshes } from './meshes.js';
import * as S from './shaders.js';

const SHADOW_SIZE = 2048;
const ZERO3 = [0, 0, 0], ZERO4 = [0, 0, 0, 0];

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader did not compile: ' + log);
  }
  return shader;
}

function link(gl, vertexSource, fragmentSource, uniformNames) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Program did not link: ' + gl.getProgramInfoLog(program));
  }
  const u = {};
  for (const name of uniformNames) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
}

export class Renderer {
  /** Throws if WebGL2 is unavailable or a shader fails to build. */
  constructor(canvas, { antialias = true } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias, alpha: false, depth: true, stencil: false, premultipliedAlpha: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('This browser does not offer WebGL2.');
    this.gl = gl;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.init(); this.lost = false; });
    this.init();
  }

  init() {
    const gl = this.gl;
    this.scene = link(gl, S.sceneVertex, S.sceneFragment, [
      'uViewProj', 'uLightViewProj', 'uModel', 'uNormalMatrix', 'uLightDir', 'uLightColor', 'uSkyColor', 'uGroundColor',
      'uLampPos', 'uLampColor', 'uRoomMin', 'uRoomMax', 'uFog', 'uParams', 'uSpheres[0]', 'uEye', 'uMode',
      'uColorA', 'uColorB', 'uMaterial', 'uPattern', 'uShadowMap']);
    this.shadow = link(gl, S.shadowVertex, S.shadowFragment, ['uLightViewProj', 'uModel']);
    this.preview = link(gl, S.previewVertex, S.previewFragment, ['uViewProj', 'uScene']);

    this.meshes = {};
    for (const [name, mesh] of Object.entries(makeMeshes())) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      this.meshes[name] = { vao, count: mesh.indices.length };
    }
    gl.bindVertexArray(null);

    // Shadow map: a depth texture read through a comparison sampler.
    this.shadowTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTexture, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Fold preview geometry.
    this.previewVao = gl.createVertexArray();
    gl.bindVertexArray(this.previewVao);
    this.previewBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.previewBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 64 * 6 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
    gl.bindVertexArray(null);

    this.offscreen = null;
    this.spheres = new Float32Array(S.SPHERE_CAPACITY * 4);
    this.mat4 = new Float32Array(16);
    this.mat3 = new Float32Array(9);
  }

  /** An offscreen target the size of the canvas, multisampled when the device allows it. */
  ensureOffscreen(width, height) {
    const gl = this.gl;
    if (this.offscreen && this.offscreen.width === width && this.offscreen.height === height) return this.offscreen;
    if (this.offscreen) {
      const o = this.offscreen;
      gl.deleteFramebuffer(o.drawFbo);
      if (o.resolveFbo !== o.drawFbo) gl.deleteFramebuffer(o.resolveFbo);
      gl.deleteTexture(o.texture);
      for (const rb of o.renderbuffers) gl.deleteRenderbuffer(rb);
      this.offscreen = null;
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const resolveFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const build = (samples) => {
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      const color = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      if (!ok) {
        gl.deleteFramebuffer(fbo);
        gl.deleteRenderbuffer(color);
        gl.deleteRenderbuffer(depth);
        return null;
      }
      return { fbo, renderbuffers: [color, depth] };
    };
    const target = build(Math.min(4, gl.getParameter(gl.MAX_SAMPLES))) || build(0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!target) return null;
    this.offscreen = { width, height, texture, resolveFbo, drawFbo: target.fbo, renderbuffers: target.renderbuffers };
    return this.offscreen;
  }

  /**
   * input: { rig, eyes: [{ position, mode }], draws, room, contactSpheres, time, foldPreview, previewEye }
   * Eye mode is 0 for a full-colour image, 1 for the red (left) half of an anaglyph, 2 for the cyan half.
   */
  render(input) {
    const gl = this.gl;
    if (this.lost) return;
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    if (width < 2 || height < 2) return;
    const draws = input.draws, room = input.room;

    // Per-object matrices, shared by the shadow pass and every view.
    const models = new Array(draws.length), normals = new Array(draws.length);
    for (let i = 0; i < draws.length; i++) {
      models[i] = new Float32Array(draws[i].model);
      normals[i] = new Float32Array(M.normalMatrix(draws[i].model));
    }

    // Light: one soft key light from above and slightly in front, plus the cabinet lamp.
    const toLight = V.norm([0.20, 1.0, 0.24]);
    const lo = [room.xMin, room.floorY - room.chuteDepth, room.zBack];
    const hi = [room.xMax, Math.min(room.ceilY, room.railY + 0.03), room.zFront];
    const centre = V.mul(V.add(lo, hi), 0.5);
    const lightView = M.lookAt(V.add(centre, toLight), centre, [0, 0, -1]);
    const minL = [Infinity, Infinity, Infinity], maxL = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      const v = M.point(lightView, [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
      for (let k = 0; k < 3; k++) {
        minL[k] = Math.min(minL[k], v[k]);
        maxL[k] = Math.max(maxL[k], v[k]);
      }
    }
    const pad = 0.01;
    const lightProj = M.orthographic(minL[0] - pad, maxL[0] + pad, minL[1] - pad, maxL[1] + pad, -maxL[2] - 0.05, -minL[2] + 0.05);
    const lightViewProj = new Float32Array(M.mul(lightProj, lightView));
    const stage = room.stance === 'stage';
    const lampPos = stage ? [0, 0.12, room.zFront * 0.35] : [0, room.ceilY - 0.012, room.zFront - 0.012];
    const reach = stage ? 0.30 : V.len(V.sub(hi, lo)) * 1.35;

    // ---- Shadow pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.disable(gl.SCISSOR_TEST);
    gl.depthRange(0, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2.0, 1.5);
    gl.useProgram(this.shadow.program);
    gl.uniformMatrix4fv(this.shadow.u.uLightViewProj, false, lightViewProj);
    for (let i = 0; i < draws.length; i++) {
      const d = draws[i], mesh = this.meshes[d.mesh];
      if (d.castsShadow === false || !mesh) continue;
      gl.uniformMatrix4fv(this.shadow.u.uModel, false, models[i]);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ---- Main pass: every eye, every panel, each through its own off-axis frustum.
    const previewTarget = input.foldPreview ? this.ensureOffscreen(width, height) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, previewTarget ? previewTarget.drawFbo : null);
    gl.viewport(0, 0, width, height);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.enable(gl.SCISSOR_TEST);

    const s = this.scene, u = s.u;
    gl.useProgram(s.program);
    gl.uniformMatrix4fv(u.uLightViewProj, false, lightViewProj);
    gl.uniform3fv(u.uLightDir, toLight);
    gl.uniform3f(u.uLightColor, 1.05, 0.987, 0.882);
    gl.uniform3f(u.uSkyColor, 0.46, 0.44, 0.58);
    gl.uniform3f(u.uGroundColor, 0.12, 0.10, 0.18);
    gl.uniform4f(u.uLampPos, lampPos[0], lampPos[1], lampPos[2], reach);
    gl.uniform3f(u.uLampColor, 0.95, 0.684, 0.437);
    gl.uniform3f(u.uRoomMin, room.xMin, room.floorY, room.zBack);
    gl.uniform3f(u.uRoomMax, room.xMax, room.ceilY, 10);
    gl.uniform4f(u.uFog, 0.035, 0.025, 0.07, 0.42);
    const sphereCount = Math.min(input.contactSpheres.length, S.SPHERE_CAPACITY);
    gl.uniform4f(u.uParams, input.time, sphereCount, 0.30, 0.34);
    this.spheres.fill(0);
    for (let i = 0; i < sphereCount; i++) this.spheres.set(input.contactSpheres[i], i * 4);
    gl.uniform4fv(u['uSpheres[0]'], this.spheres);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.uniform1i(u.uShadowMap, 0);

    const stereo = input.eyes.length > 1;
    // With two eyes the second-drawn eye gets the nearer half of the depth range, so it always
    // wins the depth test against the first without a second pass or a depth clear.
    for (let eyeIndex = input.eyes.length - 1; eyeIndex >= 0; eyeIndex--) {
      const eye = input.eyes[eyeIndex];
      if (stereo) gl.depthRange(eyeIndex === 0 ? 0.0 : 0.5, eyeIndex === 0 ? 0.5 : 1.0); else gl.depthRange(0, 1);
      if (eye.mode === 1) gl.colorMask(true, false, false, false);
      else if (eye.mode === 2) gl.colorMask(false, true, true, false);
      else gl.colorMask(true, true, true, true);
      gl.uniform3fv(u.uEye, eye.position);
      gl.uniform1f(u.uMode, eye.mode);

      for (const panel of input.rig.panels) {
        const vt = offAxisView(panel, eye.position);
        if (!vt) continue;
        // Panel viewports are top-left based; WebGL's are bottom-left based.
        const vp = panel.viewport;
        const x0 = Math.max(0, Math.round(vp.x)), x1 = Math.min(width, Math.round(vp.x + vp.width));
        const yTop = Math.max(0, Math.round(vp.y)), yBottom = Math.min(height, Math.round(vp.y + vp.height));
        if (x1 <= x0 || yBottom <= yTop) continue;
        gl.viewport(x0, height - yBottom, x1 - x0, yBottom - yTop);
        gl.scissor(x0, height - yBottom, x1 - x0, yBottom - yTop);
        this.mat4.set(vt.viewProj);
        gl.uniformMatrix4fv(u.uViewProj, false, this.mat4);

        for (let i = 0; i < draws.length; i++) {
          const d = draws[i], mesh = this.meshes[d.mesh];
          if (!mesh) continue;
          gl.uniformMatrix4fv(u.uModel, false, models[i]);
          gl.uniformMatrix3fv(u.uNormalMatrix, false, normals[i]);
          gl.uniform3fv(u.uColorA, d.colorA);
          gl.uniform3fv(u.uColorB, d.colorB || ZERO3);
          gl.uniform4f(u.uMaterial, d.shininess ?? 32, d.specular ?? 0, d.emissive ?? 0, d.pattern ?? 0);
          gl.uniform4fv(u.uPattern, d.patternParams || ZERO4);
          gl.bindVertexArray(mesh.vao);
          gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
        }
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthRange(0, 1);

    if (previewTarget) this.drawFoldPreview(input, previewTarget, width, height);
  }

  /** Stands each panel up where it physically is and photographs the pair from the eye. */
  drawFoldPreview(input, target, width, height) {
    const gl = this.gl;
    if (target.drawFbo !== target.resolveFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.drawFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolveFbo);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.viewport(0, 0, width, height);
    gl.clearColor(0.158, 0.155, 0.172, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const panels = input.rig.panels, eye = input.previewEye;
    const corners = [];
    for (const p of panels) corners.push(p.origin, V.add(p.origin, p.right), V.add(p.origin, p.up), V.add(V.add(p.origin, p.right), p.up));
    if (!corners.length) return;
    let centre = [0, 0, 0];
    for (const c of corners) centre = V.add(centre, c);
    centre = V.mul(centre, 1 / corners.length);
    const view = M.lookAt(eye, centre, [0, 1, 0]);

    // Field of view just wide enough to hold the whole device.
    const aspect = width / height;
    let tanX = 0.01, tanY = 0.01;
    for (const c of corners) {
      const v = M.point(view, c);
      const depth = Math.max(0.01, -v[2]);
      tanX = Math.max(tanX, Math.abs(v[0]) / depth);
      tanY = Math.max(tanY, Math.abs(v[1]) / depth);
    }
    const t = Math.max(tanY, tanX / aspect) * 1.10;
    const n = 0.02, f = 5;
    const proj = [1 / (aspect * t), 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, -2 * f * n / (f - n), 0];

    const verts = [];
    const quad = (a, b, c, d, ua, ub, uc, ud, kind) => {
      for (const [p, uv] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]]) verts.push(p[0], p[1], p[2], uv[0], uv[1], kind);
    };
    for (const p of panels) {
      const r = V.norm(p.right), up = V.norm(p.up), nrm = p.normal;
      const bezel = 0.004;
      // Body, slightly larger than the glass and just behind it.
      const o = V.mad(V.mad(V.mad(p.origin, r, -bezel), up, -bezel), nrm, -0.0006);
      const rr = V.mad(p.right, r, bezel * 2), uu = V.mad(p.up, up, bezel * 2);
      quad(o, V.add(o, rr), V.add(V.add(o, rr), uu), V.add(o, uu), [0, 0], [1, 0], [1, 1], [0, 1], 1);
      // Glass, textured with this panel's part of the frame (texture rows run bottom-up).
      const vp = p.viewport;
      const u0 = vp.x / width, u1 = (vp.x + vp.width) / width;
      const vBottom = 1 - (vp.y + vp.height) / height, vTop = 1 - vp.y / height;
      quad(p.origin, V.add(p.origin, p.right), V.add(V.add(p.origin, p.right), p.up), V.add(p.origin, p.up),
        [u0, vBottom], [u1, vBottom], [u1, vTop], [u0, vTop], 0);
    }
    if (verts.length > 64 * 6) return;

    gl.useProgram(this.preview.program);
    this.mat4.set(M.mul(proj, view));
    gl.uniformMatrix4fv(this.preview.u.uViewProj, false, this.mat4);
    gl.uniform1i(this.preview.u.uScene, 1);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.previewVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.previewBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(verts));
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
