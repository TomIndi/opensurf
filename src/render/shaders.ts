// GLSL ES 3.00 shaders (three.js ShaderMaterial, glslVersion GLSL3). three.js prepends the matrices, the
// position/normal/uv attributes, the log-depth defines and linearToOutputTexel(); everything else is here.
//
// Colour pipeline: albedo textures are sRGB and decoded by the sampler, lightmaps are linear (1 = fully lit),
// all shading happens in linear space and linearToOutputTexel() encodes for the target (identity when the
// renderer draws into its sRGB render target, which encodes in hardware).

/** Value noise + fbm + hashes shared by the sky, water and ghost shaders. */
const NOISE = /* glsl */ `
float surfHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float surfHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float surfNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = surfHash12(i);
  float b = surfHash12(i + vec2(1.0, 0.0));
  float c = surfHash12(i + vec2(0.0, 1.0));
  float d = surfHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float surfFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * surfNoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.0;
    a *= 0.5;
  }
  return s;
}
`;

/** Sky colour along a world direction: the map's skybox cube or the procedural sky. */
export const SKY_FUNCS = /* glsl */ `
uniform samplerCube skyCube;
uniform float uSkyProcedural;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunDisc;
uniform float uCloudCover;
uniform vec3 uCloudColor;
uniform float uStars;
uniform vec3 uHazeColor;
uniform float uHaze;
uniform float uTime;
${NOISE}
vec3 proceduralSky(vec3 d, float detail) {
  float e = d.z;
  vec3 col;
  if (e >= 0.0) col = mix(uSkyHorizon, uSkyZenith, pow(clamp(e, 0.0, 1.0), 0.48));
  else col = mix(uSkyHorizon, uSkyGround, pow(clamp(-e, 0.0, 1.0), 0.32));
  // haze band hugging the horizon (blends into the map fog colour)
  float band = exp(-abs(e) * 9.0);
  col = mix(col, uHazeColor, band * uHaze);
  float sd = max(dot(d, uSunDir), 0.0);
  // broad scattering glow around the sun
  col += uSunColor * (0.10 * pow(sd, 6.0) + 0.22 * pow(sd, 48.0));
  if (detail > 0.0) {
    if (uStars > 0.0 && e > 0.0) {
      vec3 g = d * 220.0;
      vec3 cell = floor(g);
      float h = surfHash13(cell);
      if (h > 0.9965) {
        vec3 f = fract(g) - 0.5;
        float r = length(f);
        float tw = 0.65 + 0.35 * sin(uTime * (1.5 + 3.0 * fract(h * 91.0)) + h * 50.0);
        col += vec3(0.85, 0.9, 1.0) * smoothstep(0.32, 0.0, r) * tw * uStars * smoothstep(0.0, 0.25, e) * (0.4 + 2.5 * fract(h * 313.0));
      }
    }
    if (uCloudCover > 0.0 && e > 0.005) {
      vec2 p = d.xy / (e + 0.12) * 1.35 + vec2(uTime * 0.0045, uTime * 0.0021);
      float n = surfFbm(p * 1.6);
      float n2 = surfFbm(p * 4.1 + 3.7);
      float c = smoothstep(1.0 - uCloudCover, 1.05 - uCloudCover * 0.45, n * 0.75 + n2 * 0.3);
      c *= smoothstep(0.0, 0.18, e);
      float lit = 0.55 + 0.45 * pow(sd, 3.0);
      vec3 cc = mix(uCloudColor * 0.62, uCloudColor, lit) + uSunColor * 0.25 * pow(sd, 12.0);
      col = mix(col, cc, c * 0.9);
    }
    // the sun disc itself (bright, slightly soft edge)
    float disc = smoothstep(uSunDisc, uSunDisc + 0.00005, sd);
    col += uSunColor * disc * 6.0;
  }
  return col;
}
vec3 skyColor(vec3 d, float detail) {
  if (uSkyProcedural > 0.5) return proceduralSky(d, detail);
  return texture(skyCube, vec3(d.x, d.z, d.y)).rgb;
}
`;

const FOG_FUNCS = /* glsl */ `
uniform vec3 uFogColor;
uniform vec4 uFog; // start, end, max density, enabled (0/1)
uniform float uFogScale; // eye distance -> fog distance (1, or 1/scale in the 3D skybox)
float fogFactor(float depth) {
  float z = depth * uFogScale;
  float f = clamp((z - uFog.x) / max(uFog.y - uFog.x, 1.0), 0.0, 1.0);
  return min(f, uFog.z) * uFog.w;
}
`;

// ------------------------------------------------------------------------------------------ world

export const WORLD_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform mat3 uUvTransform;
out vec2 vUv;
out vec3 vNormalW;
out vec3 vPosW;
out float vViewDepth;
#ifdef USE_LIGHTMAP
in vec2 lmuv;
out vec2 vLmUv;
#endif
#ifdef USE_VERTEX_LIGHT
in vec3 vlight;
out vec3 vLight;
#endif
#ifdef USE_BLEND2
in float blendAlpha;
uniform mat3 uUvTransform2;
out float vBlend;
out vec2 vUv2;
#endif
#ifdef USE_DETAIL
uniform vec2 uDetailScale;
out vec2 vDetailUv;
#endif
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  vPosW = wp.xyz;
  vViewDepth = -mv.z;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vUv = (uUvTransform * vec3(uv, 1.0)).xy;
#ifdef USE_LIGHTMAP
  vLmUv = lmuv;
#endif
#ifdef USE_VERTEX_LIGHT
  vLight = vlight;
#endif
#ifdef USE_BLEND2
  vBlend = blendAlpha;
  vUv2 = (uUvTransform2 * vec3(uv, 1.0)).xy;
#endif
#ifdef USE_DETAIL
  vDetailUv = uv * uDetailScale;
#endif
#include <logdepthbuf_vertex>
}
`;

export const WORLD_FRAGMENT = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
layout(location = 0) out vec4 fragColor;
uniform sampler2D map;
uniform float uAlpha;      // material $alpha x model alpha
uniform float uTexAlpha;   // 1: output the texture alpha (translucent), 0: opaque
uniform float uAdditive;   // 1: additive (fog fades it out instead of tinting)
uniform vec3 uTint;        // model rendercolor (linear)
uniform float uBrightness;
uniform float uFullbright;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
${FOG_FUNCS}
${SKY_FUNCS}
in vec2 vUv;
in vec3 vNormalW;
in vec3 vPosW;
in float vViewDepth;
#ifdef USE_LIGHTMAP
uniform sampler2D lightmap;
in vec2 vLmUv;
#endif
#ifdef USE_VERTEX_LIGHT
in vec3 vLight;
#endif
#ifdef USE_ALPHATEST
uniform float uAlphaRef;
#endif
#ifdef USE_BLEND2
uniform sampler2D map2;
in float vBlend;
in vec2 vUv2;
#endif
#ifdef USE_DETAIL
uniform sampler2D detailMap;
uniform float uDetailBlend;
in vec2 vDetailUv;
#endif
#ifdef USE_ENVMAP
uniform samplerCube envMap;
uniform float uEnvFromSky;  // 1: no baked cubemap, reflect the sky
uniform vec3 uEnvTint;
uniform vec3 uEnvParams;    // contrast, saturation, fresnel reflection (1 = no fresnel)
#if ENVMASK_MODE == 2
uniform sampler2D envMask;
#endif
#endif

vec3 synthLight(vec3 n) {
  // Built-in maps have no baked lighting: hemisphere ambient + a soft sun (wrapped Lambert) + a cool fill from
  // the opposite side, so the two faces of a ramp always read differently.
  float hemi = n.z * 0.5 + 0.5;
  vec3 amb = mix(uAmbGround, uAmbSky, hemi);
  float ndl = dot(n, uSunDir);
  float sun = max(ndl * 0.8 + 0.2, 0.0);
  float fill = max(-dot(n, vec3(uSunDir.xy, 0.0)), 0.0) * 0.18;
  float facing = 0.94 + 0.06 * sin(atan(n.y, n.x) * 2.0 + 0.7) * (1.0 - abs(n.z));
  return (amb + uSunColor * sun + uAmbSky * fill) * facing;
}

void main() {
#include <logdepthbuf_fragment>
  vec4 albedo = texture(map, vUv);
#ifdef USE_BLEND2
  vec4 albedo2 = texture(map2, vUv2);
  albedo = mix(albedo, albedo2, clamp(vBlend, 0.0, 1.0));
#endif
#ifdef USE_ALPHATEST
  if (albedo.a < uAlphaRef) discard;
#endif
#ifdef USE_DETAIL
  vec4 det = texture(detailMap, vDetailUv);
#if DETAIL_MODE == 1
  albedo.rgb += det.rgb * uDetailBlend;
#elif DETAIL_MODE == 2
  albedo.rgb = mix(albedo.rgb, det.rgb, det.a * uDetailBlend);
#else
  albedo.rgb *= mix(vec3(1.0), det.rgb * 2.0, uDetailBlend);
#endif
#endif
  albedo.rgb *= uTint;
  vec3 n = normalize(vNormalW);
#ifdef DOUBLE_SIDED
  if (!gl_FrontFacing) n = -n;
#endif
#if defined(USE_LIGHTMAP)
  vec3 light = mix(texture(lightmap, vLmUv).rgb, vec3(1.0), uFullbright);
#elif defined(USE_VERTEX_LIGHT)
  vec3 light = mix(vLight, vec3(1.0), uFullbright);
#elif defined(USE_SYNTH_LIGHT)
  vec3 light = mix(synthLight(n), vec3(1.0), uFullbright);
#else
  vec3 light = vec3(1.0);
#endif
  vec3 col = albedo.rgb * light;
#ifdef USE_ENVMAP
  vec3 V = normalize(vPosW - cameraPosition);
  vec3 R = reflect(V, n);
  vec3 env = uEnvFromSky > 0.5 ? skyColor(R, 0.0) * 0.6 : texture(envMap, R).rgb;
  env = mix(env, env * env, uEnvParams.x);
  float lum = dot(env, vec3(0.2126, 0.7152, 0.0722));
  env = mix(vec3(lum), env, uEnvParams.y);
  float fres = pow(1.0 - clamp(dot(-V, n), 0.0, 1.0), 5.0);
  float fresnel = mix(fres, 1.0, uEnvParams.z);
#if ENVMASK_MODE == 1
  float mask = albedo.a;
#elif ENVMASK_MODE == 2
  float mask = texture(envMask, vUv).r;
#else
  float mask = 1.0;
#endif
  col += env * uEnvTint * mask * fresnel;
#endif
  col *= uBrightness;
  float alpha = mix(1.0, albedo.a, uTexAlpha) * uAlpha;
  float f = fogFactor(vViewDepth);
  col = mix(col, uFogColor, f * (1.0 - uAdditive));
  col *= 1.0 - f * uAdditive;
  fragColor = linearToOutputTexel(vec4(col, alpha));
}
`;

// ------------------------------------------------------------------------------------------ water

export const WATER_FRAGMENT = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
layout(location = 0) out vec4 fragColor;
uniform sampler2D map;
uniform vec3 uWaterColor;   // linear water fog colour
uniform float uAlpha;
uniform float uBrightness;
uniform float uTexStrength;
uniform vec3 uTint;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform float uFullbright;
${FOG_FUNCS}
${SKY_FUNCS}
in vec2 vUv;
in vec3 vNormalW;
in vec3 vPosW;
in float vViewDepth;
#ifdef USE_LIGHTMAP
uniform sampler2D lightmap;
in vec2 vLmUv;
#endif

// Height field of gently moving swell: a few directional waves plus noise; returns the gradient.
vec2 waveGradient(vec2 p, float t) {
  vec2 g = vec2(0.0);
  const int N = 5;
  vec2 dirs[N];
  dirs[0] = vec2(0.80, 0.60);
  dirs[1] = vec2(-0.55, 0.83);
  dirs[2] = vec2(0.20, -0.98);
  dirs[3] = vec2(-0.93, -0.36);
  dirs[4] = vec2(0.66, -0.75);
  float freq = 0.018;
  float amp = 1.0;
  for (int i = 0; i < N; i++) {
    float ph = dot(dirs[i], p) * freq + t * (0.9 + 0.35 * float(i));
    g += dirs[i] * cos(ph) * freq * amp;
    freq *= 1.71;
    amp *= 0.62;
  }
  // fine ripples
  vec2 q = p * 0.06 + vec2(t * 0.11, -t * 0.07);
  float e = 0.35;
  float n0 = surfNoise(q);
  g += vec2(surfNoise(q + vec2(e, 0.0)) - n0, surfNoise(q + vec2(0.0, e)) - n0) * 0.06 / e;
  return g;
}

void main() {
#include <logdepthbuf_fragment>
  vec3 V = normalize(vPosW - cameraPosition);
  vec3 n0 = normalize(vNormalW);
  bool below = dot(V, n0) > 0.0;
  // ripple strength fades with distance (avoids shimmering) and on steep faces
  float strength = 2.2 / (1.0 + vViewDepth / 1800.0) * smoothstep(0.5, 0.9, abs(n0.z));
  vec2 g = waveGradient(vPosW.xy, uTime) * strength;
  vec3 n = normalize(n0 + vec3(-g, 0.0) * sign(n0.z + 1e-4));
  if (below) n = -n;
  float cosv = clamp(dot(-V, n), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);
  vec3 R = reflect(V, n);
  R.z = abs(R.z);
  vec3 refl = skyColor(normalize(R), 0.0);
#ifdef USE_LIGHTMAP
  vec3 light = mix(texture(lightmap, vLmUv).rgb, vec3(1.0), uFullbright);
#else
  vec3 light = mix(mix(uAmbGround, uAmbSky, 0.75) + uSunColor * max(uSunDir.z, 0.0) * 0.6, vec3(1.0), uFullbright);
  light = max(light, vec3(0.45));
#endif
  vec3 tex = texture(map, vUv * 0.5 + g * 0.02).rgb;
  vec3 body = uWaterColor * mix(vec3(1.0), tex * 2.0, uTexStrength) * light * uTint;
  // light scattered inside the water: a little brighter looking down, darker at grazing angles
  body *= 0.75 + 0.5 * cosv;
  vec3 col;
  float alpha;
  if (below) {
    col = body * 0.8;
    alpha = 0.88;
  } else {
    col = mix(body, refl, fresnel * 0.85 + 0.05);
    // sun glint
    float sp = pow(max(dot(R, uSunDir), 0.0), 220.0);
    col += uSunColor * sp * 3.0 * (1.0 - uFullbright * 0.5);
    alpha = clamp(mix(uAlpha, 1.0, fresnel), 0.0, 1.0);
  }
  col *= uBrightness;
  float f = fogFactor(vViewDepth);
  col = mix(col, uFogColor, f);
  alpha = mix(alpha, 1.0, f);
  fragColor = linearToOutputTexel(vec4(col, alpha));
}
`;

// ------------------------------------------------------------------------------------------ depth-only masks

export const MASK_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  gl_Position = projectionMatrix * (viewMatrix * (modelMatrix * vec4(position, 1.0)));
#include <logdepthbuf_vertex>
}
`;

export const MASK_FRAGMENT = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
layout(location = 0) out vec4 fragColor;
void main() {
#include <logdepthbuf_fragment>
  fragColor = vec4(0.0);
}
`;

// ------------------------------------------------------------------------------------------ sky box

export const SKY_VERTEX = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  // inside every clip volume (GL -w..w, clip-control 0..w); depth is neither tested nor written
  gl_Position = vec4(p.xy, p.w * 0.5, p.w);
}
`;

export const SKY_FRAGMENT = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 fragColor;
uniform float uSkyBrightness;
${SKY_FUNCS}
in vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 c = skyColor(d, 1.0) * uSkyBrightness;
  fragColor = linearToOutputTexel(vec4(c, 1.0));
}
`;

// ------------------------------------------------------------------------------------------ zone beams

/**
 * Camera-facing glowing line segments: every segment is a quad whose vertices carry both endpoints; the
 * vertex shader extrudes it sideways (perpendicular to the segment and the view ray) by a world width that
 * never drops below a minimum on-screen width.
 */
export const BEAM_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
in vec3 aStart;
in vec3 aEnd;
in vec2 aCorner;      // x: 0 = start, 1 = end; y: side -1 / 1
in vec4 aColor;       // rgb (linear), intensity
in float aWidth;      // world half-width
in float aFade;       // intensity multiplier at the segment end (posts fade upward)
uniform float uPixelScale; // world units per pixel at distance 1
uniform float uMinPixels;
out vec4 vColor;
out float vSide;
out float vAlong;
void main() {
  vec3 p = mix(aStart, aEnd, aCorner.x);
  vec3 dir = aEnd - aStart;
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec3(0.0, 0.0, 1.0);
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 side = cross(dir, toCam / max(dist, 1e-3));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  float w = max(aWidth, dist * uPixelScale * uMinPixels);
  p += side * aCorner.y * w;
  // extend the ends a little so corners join without gaps
  p += dir * (aCorner.x * 2.0 - 1.0) * w * 0.5;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vColor = vec4(aColor.rgb, aColor.a * mix(1.0, aFade, aCorner.x));
  // keep thin far beams from flickering: fade intensity a bit when the width is clamped to pixels
  vColor.a *= clamp(aWidth / max(w, 1e-3), 0.55, 1.0);
  vSide = aCorner.y;
  vAlong = aCorner.x;
#include <logdepthbuf_vertex>
}
`;

export const BEAM_FRAGMENT = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
layout(location = 0) out vec4 fragColor;
uniform float uTime;
uniform float uPulse;
uniform float uOpacity;
in vec4 vColor;
in float vSide;
in float vAlong;
void main() {
#include <logdepthbuf_fragment>
  float d = abs(vSide);
  float core = 1.0 - smoothstep(0.0, 0.35, d);
  float glow = exp(-d * d * 5.0);
  float pulse = 1.0 + uPulse * sin(uTime * 2.6);
  float k = (core * 1.1 + glow * 0.75) * vColor.a * pulse * uOpacity;
  vec3 c = vColor.rgb * k + vec3(core * core * 0.35 * vColor.a);
  fragColor = linearToOutputTexel(vec4(c, 1.0));
}
`;

// ------------------------------------------------------------------------------------------ ghosts

export const GHOST_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
out vec3 vNormalW;
out vec3 vPosW;
out vec3 vLocal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  vLocal = position;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * (viewMatrix * wp);
#include <logdepthbuf_vertex>
}
`;

export const GHOST_FRAGMENT = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
layout(location = 0) out vec4 fragColor;
uniform vec3 uColor;      // linear
uniform float uOpacity;
uniform float uTime;
uniform vec3 uForward;    // facing direction (world)
uniform float uHeight;    // body height for the scanline effect
in vec3 vNormalW;
in vec3 vPosW;
in vec3 vLocal;
void main() {
#include <logdepthbuf_fragment>
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 n = normalize(vNormalW);
  float rim = pow(1.0 - clamp(abs(dot(V, n)), 0.0, 1.0), 2.2);
  float scan = 0.85 + 0.15 * sin(vLocal.z * 0.9 - uTime * 6.0);
  // a brighter visor on the front of the head shows where the ghost is looking
  float front = smoothstep(0.55, 0.85, dot(normalize(vec3(n.xy, 0.0) + 1e-5), uForward)) * step(uHeight - 14.0, vLocal.z);
  vec3 c = uColor * (0.35 + 1.6 * rim) * scan + uColor * front * 0.9 + vec3(0.12) * rim;
  float a = clamp((0.22 + 0.7 * rim + front * 0.4) * uOpacity, 0.0, 1.0);
  fragColor = linearToOutputTexel(vec4(c, a));
}
`;

export const TRAIL_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
in float aFade;
out float vFade;
out float vSide;
in float aSide;
void main() {
  vFade = aFade;
  vSide = aSide;
  gl_Position = projectionMatrix * (viewMatrix * vec4(position, 1.0));
#include <logdepthbuf_vertex>
}
`;

export const TRAIL_FRAGMENT = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
layout(location = 0) out vec4 fragColor;
uniform vec3 uColor;
uniform float uOpacity;
in float vFade;
in float vSide;
void main() {
#include <logdepthbuf_fragment>
  float d = abs(vSide);
  float k = (1.0 - smoothstep(0.2, 1.0, d)) * vFade * vFade * uOpacity;
  fragColor = linearToOutputTexel(vec4(uColor * k, 1.0));
}
`;

// ------------------------------------------------------------------------------------------ blit

export const BLIT_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const BLIT_FRAGMENT = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tColor;
in vec2 vUv;
void main() {
  vec4 c = texture(tColor, vUv);
  fragColor = linearToOutputTexel(vec4(c.rgb, 1.0));
}
`;

// ------------------------------------------------------------------------------------------ flat colour (clip brushes)

export const FLAT_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
out vec3 vNormalW;
void main() {
  vNormalW = normal;
  gl_Position = projectionMatrix * (viewMatrix * (modelMatrix * vec4(position, 1.0)));
#include <logdepthbuf_vertex>
}
`;

export const FLAT_FRAGMENT = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
layout(location = 0) out vec4 fragColor;
uniform vec3 uColor;
uniform float uOpacity;
in vec3 vNormalW;
void main() {
#include <logdepthbuf_fragment>
  float shade = 0.75 + 0.25 * abs(normalize(vNormalW).z);
  fragColor = linearToOutputTexel(vec4(uColor * shade, uOpacity));
}
`;
