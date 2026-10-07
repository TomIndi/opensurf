// ShaderMaterials for map surfaces (world/brush-entity batches, props, water, sky masks) built from MaterialDefs.
//
// Uniform values that change per frame or per setting (time, fog, brightness, fullbright, sun, sky) are shared
// objects referenced by every material, so updating them is a handful of assignments per frame. Brush entity
// models get their own material instances so their alpha / colour can change at runtime.
import {
  CustomBlending,
  DoubleSide,
  FrontSide,
  GLSL3,
  Matrix3,
  NoBlending,
  NormalBlending,
  OneFactor,
  ShaderMaterial,
  SrcAlphaFactor,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  AddEquation,
} from 'three';
import type { MaterialDef } from '../map/types';
import { MASK_FRAGMENT, MASK_VERTEX, WATER_FRAGMENT, WORLD_FRAGMENT, WORLD_VERTEX } from './shaders';
import type { TextureCache } from './textures';

export interface U<T> {
  value: T;
}

/** Uniform objects shared by all map materials of one pass. */
export interface FogUniforms {
  uFogColor: U<Vector3>;
  uFog: U<Vector4>;
  uFogScale: U<number>;
}

export interface SharedUniforms {
  uTime: U<number>;
  uBrightness: U<number>;
  uFullbright: U<number>;
  uSunDir: U<Vector3>;
  uSunColor: U<Vector3>;
  /** Sun light for synthetic shading (maps without lightmaps). */
  uSunLight: U<Vector3>;
  uSunDisc: U<number>;
  uAmbSky: U<Vector3>;
  uAmbGround: U<Vector3>;
  skyCube: U<Texture | null>;
  uSkyProcedural: U<number>;
  uSkyZenith: U<Vector3>;
  uSkyHorizon: U<Vector3>;
  uSkyGround: U<Vector3>;
  uCloudCover: U<number>;
  uCloudColor: U<Vector3>;
  uStars: U<number>;
  uHazeColor: U<Vector3>;
  uHaze: U<number>;
  /** Fog of the main view. */
  world: FogUniforms;
  /** Fog of the 3D skybox view. */
  sky3d: FogUniforms;
}

export function createFogUniforms(): FogUniforms {
  return { uFogColor: { value: new Vector3() }, uFog: { value: new Vector4(0, 1, 0, 0) }, uFogScale: { value: 1 } };
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uBrightness: { value: 1 },
    uFullbright: { value: 0 },
    uSunDir: { value: new Vector3(0.4, 0.3, 0.866).normalize() },
    uSunColor: { value: new Vector3(1, 0.95, 0.85) },
    uSunLight: { value: new Vector3(0.6, 0.57, 0.5) },
    uSunDisc: { value: 0.99993 },
    uAmbSky: { value: new Vector3(0.45, 0.5, 0.6) },
    uAmbGround: { value: new Vector3(0.25, 0.24, 0.22) },
    skyCube: { value: null },
    uSkyProcedural: { value: 1 },
    uSkyZenith: { value: new Vector3(0.05, 0.2, 0.6) },
    uSkyHorizon: { value: new Vector3(0.5, 0.65, 0.8) },
    uSkyGround: { value: new Vector3(0.1, 0.1, 0.1) },
    uCloudCover: { value: 0.4 },
    uCloudColor: { value: new Vector3(1, 1, 1) },
    uStars: { value: 0 },
    uHazeColor: { value: new Vector3(0.6, 0.7, 0.8) },
    uHaze: { value: 0 },
    world: createFogUniforms(),
    sky3d: createFogUniforms(),
  };
}

/** sRGB 0..1 -> linear. */
export function srgbToLinear(c: number): number {
  const x = Math.max(0, c);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Gamma-space multiplier -> linear (sRGB curve up to 1, x^2.2 beyond). */
export function gammaToLinear(x: number): number {
  if (!(x > 0)) return 0;
  return x <= 1 ? srgbToLinear(x) : Math.pow(x, 2.2);
}

export function srgbToLinearVec(rgb: readonly number[], out: Vector3 = new Vector3()): Vector3 {
  return out.set(srgbToLinear(rgb[0] ?? 0), srgbToLinear(rgb[1] ?? 0), srgbToLinear(rgb[2] ?? 0));
}

/** Per brush-entity model render state (alpha, rendercolor) shared by that model's materials. */
export interface ModelUniforms {
  uTint: U<Vector3>;
  alpha: number;
}

export function createModelUniforms(): ModelUniforms {
  return { uTint: { value: new Vector3(1, 1, 1) }, alpha: 1 };
}

/** What a batch needs from its material. */
export interface SurfaceVariant {
  /** Lightmapped (lmuv attribute + atlas). */
  lightmap: Texture | null;
  /** Props: per-vertex light (vlight attribute). */
  vertexLight: boolean;
  /** Built-in maps (no baked lighting): synthetic sun + ambient. */
  synthLight: boolean;
  /** Displacement blend (blendAlpha attribute) with $basetexture2. */
  blend: boolean;
  /** info_overlay decal: depth-biased, no depth writes, after the opaque world. */
  decal: boolean;
  /** Env cubemap texture, or null (materials with $envmap then reflect the sky). */
  envCube: Texture | null;
  /** Fog set: main view or 3D skybox. */
  pass: 'world' | 'sky3d';
}

/** Runtime info kept on every map material (material.userData.surf). */
export interface SurfMaterialInfo {
  def: MaterialDef;
  /** The material's own transparency (before model alpha). */
  baseTransparent: boolean;
  baseDepthWrite: boolean;
  baseBlending: number;
  /** $alpha. */
  matAlpha: number;
  /** Texture transform + scroll: recomputed per frame for scrolling materials. */
  uvTransform: Matrix3;
  scroll: [number, number] | null;
  transform: [number, number, number, number, number, number] | null;
  /** AnimatedTexture frames (textures), or null. */
  frames: Texture[] | null;
  frameRate: number;
  decal: boolean;
  isWater: boolean;
  isMask: boolean;
}

/** Writes Source's $basetexturetransform (2x3) plus a scroll offset into a three.js Matrix3. */
export function setUvTransform(
  m: Matrix3,
  t: readonly number[] | null | undefined,
  su: number,
  sv: number,
): Matrix3 {
  if (t && t.length >= 6) m.set(t[0], t[1], t[2] + su, t[3], t[4], t[5] + sv, 0, 0, 1);
  else m.set(1, 0, su, 0, 1, sv, 0, 0, 1);
  return m;
}

/** Texture scroll offset at `time` (wrapped to [0, 1) to keep precision over long sessions). */
export function scrollOffset(rate: number, time: number): number {
  const v = rate * time;
  return v - Math.floor(v);
}

export interface MaterialFactoryOptions {
  /** Device anisotropy etc. are handled by the TextureCache. */
  textures: TextureCache;
  shared: SharedUniforms;
  /** Alpha-tested surfaces use alpha to coverage (only with an MSAA target). */
  alphaToCoverage?: boolean;
}

function variantDefines(def: MaterialDef, v: SurfaceVariant, hasImage2: boolean): Record<string, string | number | boolean> {
  const d: Record<string, string | number | boolean> = {};
  if (!def.unlit) {
    if (v.lightmap) d.USE_LIGHTMAP = '';
    else if (v.vertexLight) d.USE_VERTEX_LIGHT = '';
    else if (v.synthLight) d.USE_SYNTH_LIGHT = '';
  }
  if (def.alphaTest) d.USE_ALPHATEST = '';
  if (v.blend && hasImage2) d.USE_BLEND2 = '';
  if (def.detail && def.detail.image && def.detail.blendFactor > 0) {
    d.USE_DETAIL = '';
    const m = def.detail.blendMode;
    d.DETAIL_MODE = m === 1 || m === 5 ? 1 : m === 2 || m === 3 ? 2 : 0;
  }
  if (def.envmap && !def.isWater) {
    d.USE_ENVMAP = '';
    d.ENVMASK_MODE = def.envmap.mask === 'basealpha' ? 1 : (def.envmap.mask === 'texture' || def.envmap.mask === 'normalalpha') && def.envmap.maskImage ? 2 : 0;
  }
  return d;
}

/** Builds and caches surface materials. */
export class SurfaceMaterials {
  private readonly cache = new Map<string, ShaderMaterial>();
  private readonly all: ShaderMaterial[] = [];
  private maskWorld: ShaderMaterial | null = null;
  private maskSky: ShaderMaterial | null = null;
  private wireframe = false;

  constructor(private readonly opts: MaterialFactoryOptions) {}

  get materials(): readonly ShaderMaterial[] {
    return this.all;
  }

  /** Depth-only material for sky faces (colorWrite off): where they are, the skybox shows through. */
  skyMask(pass: 'world' | 'sky3d'): ShaderMaterial {
    const have = pass === 'world' ? this.maskWorld : this.maskSky;
    if (have) return have;
    const m = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: MASK_VERTEX,
      fragmentShader: MASK_FRAGMENT,
      side: DoubleSide,
    });
    m.colorWrite = false;
    m.depthWrite = true;
    m.depthTest = true;
    m.blending = NoBlending;
    m.userData.surf = { isMask: true } as Partial<SurfMaterialInfo>;
    this.all.push(m);
    if (pass === 'world') this.maskWorld = m;
    else this.maskSky = m;
    return m;
  }

  /**
   * The material for a surface of `def` drawn with variant `v`. Surfaces with their own runtime state (brush
   * entity models, translucent props) pass an `instanceKey` and their uniforms to get their own instance.
   */
  get(def: MaterialDef, v: SurfaceVariant, instanceKey: string, modelUniforms: ModelUniforms | null, envKey: number): ShaderMaterial {
    const key = [
      def.name,
      v.lightmap ? 'L' : v.vertexLight ? 'V' : v.synthLight ? 'S' : 'U',
      v.blend ? 'B' : '',
      v.decal ? 'D' : '',
      v.pass,
      instanceKey,
      envKey,
    ].join('|');
    const hit = this.cache.get(key);
    if (hit) return hit;
    const m = def.isWater ? this.createWater(def, v, modelUniforms) : this.createSurface(def, v, modelUniforms);
    this.cache.set(key, m);
    this.all.push(m);
    return m;
  }

  private baseTexture(def: MaterialDef): Texture {
    const t = this.opts.textures;
    if (def.image && def.image.width > 0 && def.image.height > 0) return t.image(def.image, { srgb: true, repeat: true });
    return t.solid(def.fallbackColor, 1);
  }

  private commonUniforms(def: MaterialDef, v: SurfaceVariant, mu: ModelUniforms | null): Record<string, U<unknown>> {
    const s = this.opts.shared;
    const fog = v.pass === 'world' ? s.world : s.sky3d;
    const info: Record<string, U<unknown>> = {
      map: { value: this.baseTexture(def) },
      uUvTransform: { value: new Matrix3() },
      uAlpha: { value: def.alpha * (mu ? mu.alpha : 1) },
      uTint: mu ? mu.uTint : { value: new Vector3(1, 1, 1) },
      uBrightness: s.uBrightness,
      uFullbright: s.uFullbright,
      uTime: s.uTime,
      uSunDir: s.uSunDir,
      uSunColor: s.uSunColor,
      uSunLight: s.uSunLight,
      uSunDisc: s.uSunDisc,
      uAmbSky: s.uAmbSky,
      uAmbGround: s.uAmbGround,
      skyCube: s.skyCube,
      uSkyProcedural: s.uSkyProcedural,
      uSkyZenith: s.uSkyZenith,
      uSkyHorizon: s.uSkyHorizon,
      uSkyGround: s.uSkyGround,
      uCloudCover: s.uCloudCover,
      uCloudColor: s.uCloudColor,
      uStars: s.uStars,
      uHazeColor: s.uHazeColor,
      uHaze: s.uHaze,
      uFogColor: fog.uFogColor,
      uFog: fog.uFog,
      uFogScale: fog.uFogScale,
    };
    if (v.lightmap) info.lightmap = { value: v.lightmap };
    return info;
  }

  private info(def: MaterialDef, m: ShaderMaterial, v: SurfaceVariant): SurfMaterialInfo {
    const uv = (m.uniforms.uUvTransform as U<Matrix3>).value;
    setUvTransform(uv, def.textureTransform ?? null, 0, 0);
    let frames: Texture[] | null = null;
    if (def.frames && def.frames.length > 1) {
      frames = def.frames.map((f) => this.opts.textures.image(f, { srgb: true, repeat: true }));
    }
    return {
      def,
      baseTransparent: m.transparent,
      baseDepthWrite: m.depthWrite,
      baseBlending: m.blending,
      matAlpha: def.alpha,
      uvTransform: uv,
      scroll: def.scroll && (def.scroll[0] || def.scroll[1]) ? [def.scroll[0], def.scroll[1]] : null,
      transform: def.textureTransform ?? null,
      frames,
      frameRate: def.frameRate && def.frameRate > 0 ? def.frameRate : 15,
      decal: v.decal,
      isWater: def.isWater,
      isMask: false,
    };
  }

  private createSurface(def: MaterialDef, v: SurfaceVariant, mu: ModelUniforms | null): ShaderMaterial {
    const t = this.opts.textures;
    const hasImage2 = !!(def.image2 || def.fallbackColor2);
    const defines = variantDefines(def, v, hasImage2);
    const uniforms = this.commonUniforms(def, v, mu);
    const translucent = def.translucent || def.additive;
    uniforms.uTexAlpha = { value: translucent && !def.alphaTest ? 1 : def.translucent ? 1 : 0 };
    uniforms.uAdditive = { value: def.additive ? 1 : 0 };
    if (defines.USE_ALPHATEST !== undefined) {
      uniforms.uAlphaRef = { value: Math.max(0.001, Math.min(1, def.alphaTestRef || 0.5)) };
      if (this.opts.alphaToCoverage && !translucent) defines.USE_A2C = '';
    }
    if (defines.USE_BLEND2 !== undefined) {
      uniforms.map2 = {
        value: def.image2 && def.image2.width > 0 ? t.image(def.image2, { srgb: true, repeat: true }) : t.solid(def.fallbackColor2 ?? def.fallbackColor),
      };
      const m2 = new Matrix3();
      setUvTransform(m2, def.textureTransform2 ?? def.textureTransform ?? null, 0, 0);
      uniforms.uUvTransform2 = { value: m2 };
    }
    if (defines.USE_DETAIL !== undefined && def.detail) {
      const mode = defines.DETAIL_MODE as number;
      uniforms.detailMap = { value: t.image(def.detail.image, { srgb: mode !== 0, repeat: true }) };
      uniforms.uDetailScale = { value: new Vector2(def.detail.scale[0], def.detail.scale[1]) };
      uniforms.uDetailBlend = { value: Math.max(0, Math.min(1, def.detail.blendFactor)) };
    }
    if (defines.USE_ENVMAP !== undefined && def.envmap) {
      const e = def.envmap;
      uniforms.envMap = { value: v.envCube };
      uniforms.uEnvFromSky = { value: v.envCube ? 0 : 1 };
      // $envmaptint is a gamma-space colour (the engine converts it to linear for the shader)
      uniforms.uEnvTint = { value: new Vector3(gammaToLinear(e.tint[0]), gammaToLinear(e.tint[1]), gammaToLinear(e.tint[2])) };
      uniforms.uEnvParams = { value: new Vector3(e.contrast, e.saturation, e.fresnel) };
      if (defines.ENVMASK_MODE === 2 && e.maskImage) uniforms.envMask = { value: t.image(e.maskImage, { srgb: false, repeat: true }) };
    }
    const m = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: WORLD_VERTEX,
      fragmentShader: WORLD_FRAGMENT,
      uniforms,
      defines,
      side: def.noCull ? DoubleSide : FrontSide,
    });
    m.name = def.name;
    m.wireframe = this.wireframe;
    if (def.additive) {
      m.transparent = true;
      m.depthWrite = false;
      m.blending = CustomBlending;
      m.blendEquation = AddEquation;
      m.blendSrc = SrcAlphaFactor;
      m.blendDst = OneFactor;
      m.blendSrcAlpha = OneFactor;
      m.blendDstAlpha = OneFactor;
    } else if (def.translucent || def.alpha < 1) {
      m.transparent = true;
      m.depthWrite = false;
      m.blending = NormalBlending;
    } else {
      m.transparent = false;
      m.depthWrite = true;
      m.blending = NoBlending;
    }
    if (defines.USE_A2C !== undefined) m.alphaToCoverage = true;
    if (v.decal) {
      m.depthWrite = false;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -4;
    }
    m.userData.surf = this.info(def, m, v);
    return m;
  }

  private createWater(def: MaterialDef, v: SurfaceVariant, mu: ModelUniforms | null): ShaderMaterial {
    const uniforms = this.commonUniforms(def, v, mu);
    const fogc = def.waterFogColor ?? [def.fallbackColor[0] * 0.5, def.fallbackColor[1] * 0.55, def.fallbackColor[2] * 0.6];
    uniforms.uWaterColor = { value: srgbToLinearVec(fogc, new Vector3()) };
    // procedural water images carry no information beyond the colour: use them only faintly
    uniforms.uTexStrength = { value: def.image && def.shader !== 'water' ? 0.35 : 0.0 };
    uniforms.uAlpha = { value: Math.max(0.55, Math.min(0.92, def.alpha < 1 ? def.alpha + 0.25 : 0.8)) * (mu ? mu.alpha : 1) };
    uniforms.envMap = { value: v.envCube };
    uniforms.uEnvFromSky = { value: v.envCube ? 0 : 1 };
    const defines: Record<string, string> = {};
    if (v.lightmap) defines.USE_LIGHTMAP = '';
    const m = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: WORLD_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      uniforms,
      defines,
      side: DoubleSide,
    });
    m.name = def.name;
    m.transparent = true;
    m.depthWrite = false;
    m.blending = NormalBlending;
    m.wireframe = this.wireframe;
    const info = this.info(def, m, v);
    info.matAlpha = (uniforms.uAlpha.value as number) / (mu ? mu.alpha || 1 : 1);
    m.userData.surf = info;
    return m;
  }

  /** mat_wireframe: draws every surface material as wireframe. */
  setWireframe(on: boolean): void {
    this.wireframe = on;
    for (const m of this.all) {
      const info = m.userData.surf as Partial<SurfMaterialInfo> | undefined;
      if (info?.isMask) {
        m.visible = !on; // sky masks would hide the wireframe behind them
        continue;
      }
      m.wireframe = on;
    }
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
    this.all.length = 0;
    this.cache.clear();
    this.maskWorld = null;
    this.maskSky = null;
  }
}

/**
 * Applies a brush entity's alpha to one of its materials: opaque materials become alpha-blended below 1
 * (rendermode with renderamt), and go back to opaque at 1.
 */
export function applyModelAlpha(m: ShaderMaterial, alpha: number): void {
  const info = m.userData.surf as SurfMaterialInfo | undefined;
  if (!info || info.isMask) return;
  const a = Math.max(0, Math.min(1, alpha));
  (m.uniforms.uAlpha as U<number>).value = info.matAlpha * a;
  if (a < 1 && !info.baseTransparent) {
    if (!m.transparent) {
      m.transparent = true;
      m.depthWrite = false;
      m.blending = NormalBlending;
      m.needsUpdate = true;
    }
  } else if (a >= 1 && m.transparent !== info.baseTransparent) {
    m.transparent = info.baseTransparent;
    m.depthWrite = info.baseDepthWrite;
    m.blending = info.baseBlending as typeof NormalBlending;
    m.needsUpdate = true;
  }
  m.visible = a > 0;
}

/** sRGB rendercolor -> linear tint. */
export function setModelTint(mu: ModelUniforms, rgb: readonly number[]): void {
  srgbToLinearVec(rgb, mu.uTint.value);
}

