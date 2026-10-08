import { CustomBlending, DoubleSide, FrontSide, Matrix3, NoBlending, NormalBlending, OneFactor, SrcAlphaFactor, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fallbackMaterial } from '../src/bsp/materials';
import type { MaterialDef } from '../src/map/types';
import { TextureCache } from '../src/render/textures';
import {
  SurfaceMaterials,
  SurfaceVariant,
  applyModelAlpha,
  createModelUniforms,
  createSharedUniforms,
  gammaToLinear,
  scrollOffset,
  setModelTint,
  setUvTransform,
  srgbToLinear,
} from '../src/render/worldmaterials';

const caps = { maxAnisotropy: 8, s3tc: false, maxTextureSize: 4096 };

export function testMaterial(name: string, over: Partial<MaterialDef> = {}): MaterialDef {
  return {
    name,
    shader: 'lightmappedgeneric',
    image: { width: 4, height: 4, data: new Uint8Array(64).fill(180), hasAlpha: false },
    fallbackColor: [0.5, 0.5, 0.5],
    width: 128,
    height: 128,
    translucent: false,
    additive: false,
    alphaTest: false,
    alphaTestRef: 0.5,
    alpha: 1,
    noCull: false,
    unlit: false,
    isWater: false,
    waterFogColor: null,
    isSky: false,
    isTool: false,
    scroll: null,
    ...over,
  };
}

const variant = (over: Partial<SurfaceVariant> = {}): SurfaceVariant => ({
  lightmap: null,
  vertexLight: false,
  synthLight: false,
  blend: false,
  decal: false,
  envCube: null,
  pass: 'world',
  ...over,
});

function factory() {
  const textures = new TextureCache(caps);
  const shared = createSharedUniforms();
  return { textures, shared, mats: new SurfaceMaterials({ textures, shared }) };
}

describe('colour helpers', () => {
  it('srgbToLinear matches the sRGB curve', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 9);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 3);
    expect(srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 9);
  });
  it('gammaToLinear handles $envmaptint values above 1', () => {
    expect(gammaToLinear(0.5)).toBeCloseTo(0.214, 3);
    expect(gammaToLinear(2)).toBeCloseTo(Math.pow(2, 2.2), 6);
    expect(gammaToLinear(-1)).toBe(0);
    expect(gammaToLinear(NaN)).toBe(0);
  });
});

describe('texture transform + scroll', () => {
  it('maps Source 2x3 transforms into a Matrix3 (u\' = a u + b v + c)', () => {
    const m = setUvTransform(new Matrix3(), [2, 0, 0.5, 0, 3, 0.25], 0.1, 0.2);
    const p = new Vector3(0.5, 0.5, 1).applyMatrix3(m);
    expect(p.x).toBeCloseTo(2 * 0.5 + 0.5 + 0.1, 9);
    expect(p.y).toBeCloseTo(3 * 0.5 + 0.25 + 0.2, 9);
    const id = setUvTransform(new Matrix3(), null, 0, 0);
    expect(id.elements).toEqual(new Matrix3().elements);
  });
  it('scroll offsets wrap into [0,1) for precision', () => {
    expect(scrollOffset(0.5, 3)).toBeCloseTo(0.5, 9);
    expect(scrollOffset(-0.25, 1)).toBeCloseTo(0.75, 9);
    const big = scrollOffset(1.3, 1e6 + 0.5);
    expect(big).toBeGreaterThanOrEqual(0);
    expect(big).toBeLessThan(1);
  });
});

describe('SurfaceMaterials', () => {
  it('opaque lightmapped: no blending, depth write, lightmap define + uniform, front faces', () => {
    const { mats, textures } = factory();
    const lm = textures.lightmap({ width: 1, height: 1, data: new Float32Array([1, 1, 1, 1]) });
    const m = mats.get(testMaterial('a'), variant({ lightmap: lm }), '', null, -1);
    expect(m.defines.USE_LIGHTMAP).toBe('');
    expect(m.uniforms.lightmap.value).toBe(lm);
    expect(m.transparent).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(m.blending).toBe(NoBlending);
    expect(m.side).toBe(FrontSide);
    expect(m.uniforms.uTexAlpha.value).toBe(0);
    // cached
    expect(mats.get(testMaterial('a'), variant({ lightmap: lm }), '', null, -1)).toBe(m);
  });

  it('unlit materials ignore lighting; synthetic light only for lit materials', () => {
    const { mats } = factory();
    const u = mats.get(testMaterial('glow', { unlit: true }), variant({ synthLight: true }), '', null, -1);
    expect(u.defines.USE_SYNTH_LIGHT).toBeUndefined();
    expect(u.defines.USE_LIGHTMAP).toBeUndefined();
    const s = mats.get(testMaterial('ramp'), variant({ synthLight: true }), '', null, -1);
    expect(s.defines.USE_SYNTH_LIGHT).toBe('');
    const p = mats.get(testMaterial('prop'), variant({ vertexLight: true }), 'prop', null, -1);
    expect(p.defines.USE_VERTEX_LIGHT).toBe('');
  });

  it('translucent / additive / alpha test / nocull states', () => {
    const { mats } = factory();
    const t = mats.get(testMaterial('glass', { translucent: true, alpha: 0.6 }), variant(), '', null, -1);
    expect(t.transparent).toBe(true);
    expect(t.depthWrite).toBe(false);
    expect(t.blending).toBe(NormalBlending);
    expect(t.uniforms.uTexAlpha.value).toBe(1);
    expect(t.uniforms.uAlpha.value).toBeCloseTo(0.6, 9);
    const a = mats.get(testMaterial('beam', { additive: true, translucent: true }), variant(), '', null, -1);
    expect(a.blending).toBe(CustomBlending);
    expect(a.blendSrc).toBe(SrcAlphaFactor);
    expect(a.blendDst).toBe(OneFactor);
    expect(a.uniforms.uAdditive.value).toBe(1);
    const at = mats.get(testMaterial('fence', { alphaTest: true, alphaTestRef: 0.7, noCull: true }), variant(), '', null, -1);
    expect(at.defines.USE_ALPHATEST).toBe('');
    expect(at.uniforms.uAlphaRef.value).toBeCloseTo(0.7, 9);
    expect(at.transparent).toBe(false);
    expect(at.side).toBe(DoubleSide);
    // maps whose faces aren't reliably wound: every surface double-sided (a separate cached instance)
    const one = mats.get(testMaterial('wall'), variant(), '', null, -1);
    const two = mats.get(testMaterial('wall'), variant({ doubleSided: true }), '', null, -1);
    expect(one.side).toBe(FrontSide);
    expect(two.side).toBe(DoubleSide);
    expect(two).not.toBe(one);
    expect(mats.get(testMaterial('wall'), variant({ doubleSided: true }), '', null, -1)).toBe(two);
  });

  it('decals: depth biased, no depth writes', () => {
    const { mats } = factory();
    const d = mats.get(testMaterial('overlay'), variant({ decal: true }), '', null, -1);
    expect(d.polygonOffset).toBe(true);
    expect(d.polygonOffsetFactor).toBeLessThan(0);
    expect(d.depthWrite).toBe(false);
  });

  it('detail, displacement blend and envmap features', () => {
    const { mats } = factory();
    const def = testMaterial('blend', {
      image2: { width: 2, height: 2, data: new Uint8Array(16).fill(40), hasAlpha: false },
      detail: { image: { width: 2, height: 2, data: new Uint8Array(16).fill(128), hasAlpha: false }, scale: [4, 4], blendFactor: 0.5, blendMode: 0 },
      envmap: { cubemap: 'env_cubemap', tint: [0.5, 0.5, 0.5], mask: 'basealpha', contrast: 0, saturation: 1, fresnel: 1 },
    });
    const m = mats.get(def, variant({ blend: true }), '', null, -1);
    expect(m.defines.USE_BLEND2).toBe('');
    expect(m.uniforms.map2.value).toBeTruthy();
    expect(m.defines.USE_DETAIL).toBe('');
    expect(m.defines.DETAIL_MODE).toBe(0);
    // mod2x detail is sampled raw (grey 128 = neutral)
    expect(m.uniforms.detailMap.value.colorSpace).toBe('');
    expect(m.defines.USE_ENVMAP).toBe('');
    expect(m.defines.ENVMASK_MODE).toBe(1);
    expect(m.uniforms.uEnvFromSky.value).toBe(1); // no baked cubemap: reflect the sky
    expect((m.uniforms.uEnvTint.value as Vector3).x).toBeCloseTo(srgbToLinear(0.5), 6);
    const noBlend = mats.get(def, variant({ blend: false }), '', null, -1);
    expect(noBlend.defines.USE_BLEND2).toBeUndefined();
    expect(noBlend).not.toBe(m);
  });

  it('water uses its own shader, translucent and double sided, coloured by the fog colour', () => {
    const { mats } = factory();
    const w = mats.get(testMaterial('water', { isWater: true, translucent: true, alpha: 0.85, waterFogColor: [0.1, 0.2, 0.3], shader: 'water' }), variant(), '', null, -1);
    expect(w.fragmentShader).toContain('waveGradient');
    expect(w.transparent).toBe(true);
    expect(w.side).toBe(DoubleSide);
    expect((w.uniforms.uWaterColor.value as Vector3).z).toBeCloseTo(srgbToLinear(0.3), 6);
    // one face of a top/bottom pair: one-sided (each side shows its own material)
    const pairFace = mats.get(testMaterial('water', { isWater: true, translucent: true }), variant({ doubleSided: false }), '', null, -1);
    expect(pairFace.side).toBe(FrontSide);
    // the shading normal always faces the viewer; "below" = looking at the surface from underneath
    expect(w.fragmentShader).toContain('if (dot(V, n0) > 0.0) n0 = -n0;');
  });

  it('brush entity instances share their model uniforms; alpha below 1 makes opaque materials blend', () => {
    const { mats } = factory();
    const mu = createModelUniforms();
    const def = testMaterial('door');
    const m = mats.get(def, variant(), 'm5', mu, -1);
    expect(mats.get(def, variant(), '', null, -1)).not.toBe(m);
    expect(m.uniforms.uTint).toBe(mu.uTint);
    setModelTint(mu, [1, 0.5, 0]);
    expect(mu.uTint.value.y).toBeCloseTo(srgbToLinear(0.5), 6);
    applyModelAlpha(m, 0.4);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.uniforms.uAlpha.value).toBeCloseTo(0.4, 9);
    applyModelAlpha(m, 1);
    expect(m.transparent).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(m.blending).toBe(NoBlending);
    applyModelAlpha(m, 0);
    expect(m.visible).toBe(false);
    applyModelAlpha(m, 1);
    expect(m.visible).toBe(true);
    // a translucent material keeps blending and multiplies its own $alpha
    const g = mats.get(testMaterial('glass', { translucent: true, alpha: 0.5 }), variant(), 'm5', mu, -1);
    applyModelAlpha(g, 0.5);
    expect(g.uniforms.uAlpha.value).toBeCloseTo(0.25, 9);
    applyModelAlpha(g, 1);
    expect(g.transparent).toBe(true);
  });

  it('sky masks write depth only', () => {
    const { mats } = factory();
    const m = mats.skyMask('world');
    expect(m.colorWrite).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(mats.skyMask('world')).toBe(m);
    expect(mats.skyMask('sky3d')).not.toBe(m);
  });

  it('fog uniforms: world and 3D sky passes use separate sets', () => {
    const { mats, shared } = factory();
    const w = mats.get(testMaterial('x'), variant(), '', null, -1);
    const s = mats.get(testMaterial('x'), variant({ pass: 'sky3d' }), '', null, -1);
    expect(w.uniforms.uFog).toBe(shared.world.uFog);
    expect(s.uniforms.uFog).toBe(shared.sky3d.uFog);
    expect(w.uniforms.uTime).toBe(shared.uTime);
  });

  it('wireframe toggles every surface (and hides sky masks), dispose clears', () => {
    const { mats } = factory();
    const a = mats.get(testMaterial('a'), variant(), '', null, -1);
    const mask = mats.skyMask('world');
    mats.setWireframe(true);
    expect(a.wireframe).toBe(true);
    expect(mask.visible).toBe(false);
    const b = mats.get(testMaterial('b'), variant(), '', null, -1);
    expect(b.wireframe).toBe(true);
    mats.setWireframe(false);
    expect(a.wireframe).toBe(false);
    expect(mask.visible).toBe(true);
    let n = 0;
    a.addEventListener('dispose', () => n++);
    mats.dispose();
    expect(n).toBe(1);
    expect(mats.materials).toHaveLength(0);
  });

  it('works with the procedural fallback materials of built-in maps', () => {
    const { mats } = factory();
    for (const name of ['builtin/ramp_cyan', 'builtin/glow_green', 'builtin/floor_dark', 'builtin/wall_grid']) {
      const def = fallbackMaterial(name);
      const m = mats.get(def, variant({ synthLight: true }), '', null, -1);
      expect(m.uniforms.map.value).toBeTruthy();
      if (def.unlit) expect(m.defines.USE_SYNTH_LIGHT).toBeUndefined();
    }
  });
});
