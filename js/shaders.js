// GLSL ES 3.00 shaders. Lighting is done in linear light and encoded to sRGB on output, because a
// canvas is not an sRGB framebuffer.

export const SPHERE_CAPACITY = 24;

export const sceneVertex = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;

uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMatrix;

out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vLocalPos;
out vec4 vShadowPos;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  gl_Position = uViewProj * world;
  vWorldPos = world.xyz;
  vNormal = uNormalMatrix * aNormal;
  vLocalPos = aPosition;
  vShadowPos = uLightViewProj * world;
}
`;

export const shadowVertex = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uLightViewProj;
uniform mat4 uModel;
void main() {
  gl_Position = uLightViewProj * (uModel * vec4(aPosition, 1.0));
}
`;

export const shadowFragment = `#version 300 es
precision mediump float;
void main() {}
`;

export const sceneFragment = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DShadow;

in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vLocalPos;
in vec4 vShadowPos;

uniform vec3 uLightDir;      // unit vector towards the key light
uniform vec3 uLightColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec4 uLampPos;       // xyz: position of the cabinet lamp, w: reach in metres
uniform vec3 uLampColor;
uniform vec3 uRoomMin;       // inner faces of the cabinet, for corner darkening
uniform vec3 uRoomMax;
uniform vec4 uFog;           // rgb: colour, a: strength
uniform vec4 uParams;        // x: time, y: number of contact spheres, z: fog start (m from eye), w: fog range
uniform vec4 uSpheres[${SPHERE_CAPACITY}];   // xyz: centre, w: radius

uniform vec3 uEye;           // the real eye position in world space
uniform float uMode;         // 0 mono, 1 left eye (red), 2 right eye (cyan)

uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec4 uMaterial;      // x: shininess, y: specular strength, z: emissive, w: pattern id
uniform vec4 uPattern;       // pattern-specific numbers

uniform sampler2DShadow uShadowMap;

out vec4 fragColor;

float saturate(float x) { return clamp(x, 0.0, 1.0); }

// Anti-aliased grid line mask: 1 on a line, 0 between lines.
float gridMask(vec2 coord, float cell, float widthPx) {
  vec2 g = coord / cell;
  vec2 fw = max(fwidth(g), vec2(1e-5));
  vec2 d = abs(fract(g - 0.5) - 0.5) / fw;
  float line = min(d.x, d.y);
  return 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, line);
}

const vec2 taps[16] = vec2[16](
  vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725),
  vec2(-0.09418410, -0.92938870), vec2(0.34495938, 0.29387760),
  vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464),
  vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
  vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420),
  vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
  vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590),
  vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790));

float shadowFactor(vec4 shadowPos, vec3 n, vec3 l) {
  vec3 p = shadowPos.xyz / shadowPos.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) { return 1.0; }
  float bias = 0.0012 + 0.004 * (1.0 - saturate(dot(n, l)));
  float texel = 1.0 / float(textureSize(uShadowMap, 0).x);
  float sum = 0.0;
  // 16-tap disc for a soft penumbra; each tap is itself a hardware-filtered comparison.
  for (int i = 0; i < 16; i++) {
    sum += texture(uShadowMap, vec3(p.xy + taps[i] * texel * 2.6, p.z - bias));
  }
  return sum / 16.0;
}

vec3 encodeSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 toEye = uEye - vWorldPos;
  float eyeDist = length(toEye);
  vec3 V = toEye / max(eyeDist, 1e-5);
  vec3 L = uLightDir;

  int patternId = int(uMaterial.w + 0.5);
  vec3 base = uColorA;
  float shininess = uMaterial.x;
  float specStrength = uMaterial.y;
  float emissive = uMaterial.z;
  float ao = 1.0;

  if (patternId == 1 || patternId == 2) {
    // Cabinet surfaces. Lines are locked to world space so they converge with perspective.
    vec3 an = abs(N);
    vec2 coord = an.y > 0.6 ? vWorldPos.xz : (an.x > 0.6 ? vWorldPos.zy : vWorldPos.xy);
    float cell = uPattern.x;
    if (patternId == 2) {
      vec2 c = floor(coord / cell);
      float checker = mod(abs(c.x + c.y), 2.0);
      base = mix(uColorA, uColorB, checker * uPattern.z);
      float fine = gridMask(coord, cell, 1.2);
      base = mix(base, uColorB * 1.35 + 0.04, fine * 0.55);
    } else {
      float fine = gridMask(coord, cell, 1.0);
      float coarse = gridMask(coord, cell * uPattern.y, 2.0);
      base = mix(base, uColorB, max(fine * 0.45, coarse * 0.95));
    }
    // Darken where surfaces meet: a cheap stand-in for ambient occlusion in the corners.
    vec3 d = min(vWorldPos - uRoomMin, uRoomMax - vWorldPos);
    float reach = 0.022;
    if (an.x < 0.6) { ao *= mix(0.58, 1.0, smoothstep(0.0, reach, d.x)); }
    if (an.y < 0.6) { ao *= mix(0.58, 1.0, smoothstep(0.0, reach, d.y)); }
    if (an.z < 0.6) { ao *= mix(0.62, 1.0, smoothstep(0.0, reach, d.z)); }
  } else if (patternId == 3) {
    // Two-tone capsule with a pale seam.
    float y = vLocalPos.y;
    float seam = 1.0 - smoothstep(0.018, 0.034, abs(y));
    base = mix(y > 0.0 ? uColorA : uColorB, vec3(0.93, 0.92, 0.88), seam);
  } else if (patternId == 4) {
    // Stripes around the equator.
    float s = smoothstep(-0.25, 0.25, sin(vLocalPos.y * uPattern.x));
    base = mix(uColorA, uColorB, s);
  } else if (patternId == 5) {
    // Dots.
    vec3 q = fract(vLocalPos * uPattern.x) - 0.5;
    float dotMask = 1.0 - smoothstep(0.20, 0.27, length(q));
    base = mix(uColorA, uColorB, dotMask);
  }

  // Soft contact shadows under every prize and under the claw, on anything facing up.
  if (N.y > 0.5) {
    int count = int(uParams.y + 0.5);
    float occ = 0.0;
    for (int i = 0; i < ${SPHERE_CAPACITY}; i++) {
      if (i >= count) { break; }
      vec4 s = uSpheres[i];
      vec3 d = s.xyz - vWorldPos;
      float h = max(d.y, 0.0);
      float dist2 = dot(d.xz, d.xz) + h * h;
      float r2 = s.w * s.w;
      if (dist2 > r2 * 0.9) {
        occ += (r2 / dist2) * (h / sqrt(dist2 + 1e-8));
      }
    }
    ao *= 1.0 - 0.62 * saturate(occ);
  }

  float shadow = shadowFactor(vShadowPos, N, L);
  float ndl = saturate(dot(N, L));
  vec3 ambient = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * ao;

  // Cabinet lamp: an unshadowed point light that falls off towards the back, so brightness
  // itself tells you how deep a surface is.
  vec3 toLamp = uLampPos.xyz - vWorldPos;
  float lampDist = length(toLamp);
  vec3 Lp = toLamp / max(lampDist, 1e-5);
  float fall = saturate(1.0 - lampDist / uLampPos.w);
  vec3 lamp = uLampColor * saturate(dot(N, Lp)) * fall * fall * ao;

  vec3 color = base * (ambient + uLightColor * ndl * shadow + lamp);

  // Highlights are computed from the viewer's actual eye, so they slide across glossy surfaces
  // as the head moves, exactly as they would on a real object.
  if (specStrength > 0.0) {
    vec3 H = normalize(L + V);
    float spec = pow(saturate(dot(N, H)), shininess) * shadow * ndl;
    vec3 Hp = normalize(Lp + V);
    float specLamp = pow(saturate(dot(N, Hp)), shininess * 0.6) * fall * 0.6;
    float fres = pow(1.0 - saturate(dot(N, V)), 4.0);
    color += specStrength * (uLightColor * spec + uLampColor * specLamp);
    color += fres * specStrength * 0.22 * uSkyColor;
  }

  color += base * emissive;

  // Aerial perspective: things further from the eye sink slightly into the cabinet's dark.
  float fogAmount = saturate((eyeDist - uParams.z) / uParams.w) * uFog.a;
  if (emissive < 0.5) { color = mix(color, uFog.rgb, fogAmount); }

  int mode = int(uMode + 0.5);
  if (mode == 1) {
    // Left eye: luminance-weighted into red only (the colour mask hides the other channels).
    color = vec3(dot(color, vec3(0.30, 0.52, 0.18)), 0.0, 0.0);
  } else if (mode == 2) {
    // Right eye: green and blue only.
    color = vec3(0.0, color.g, color.b);
  }
  fragColor = vec4(encodeSRGB(color), 1.0);
}
`;

// Fold preview: used when showing a folded device on a flat screen (the Simulator, a desktop
// browser). The scene has already been drawn into a texture exactly as the real panels would show
// it; here the two panels are stood up in 3D at the hinge angle and photographed from the eye.
export const previewVertex = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUV;
layout(location = 2) in float aKind;
uniform mat4 uViewProj;
out vec2 vUV;
out float vKind;
void main() {
  gl_Position = uViewProj * vec4(aPosition, 1.0);
  vUV = aUV;
  vKind = aKind;
}
`;

export const previewFragment = `#version 300 es
precision highp float;
in vec2 vUV;
in float vKind;
uniform sampler2D uScene;
out vec4 fragColor;
void main() {
  if (vKind > 0.5) {
    // Device body: near-black with a faint lift towards one edge so the outline reads.
    float lift = 0.10 + 0.07 * vUV.y;
    fragColor = vec4(lift, lift, lift * 1.08, 1.0);
  } else {
    // The scene texture already holds display-encoded colour.
    fragColor = vec4(texture(uScene, vUV).rgb, 1.0);
  }
}
`;
