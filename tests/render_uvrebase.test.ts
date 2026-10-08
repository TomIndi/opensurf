// Texture coordinates rebased near zero per connected piece (src/render/uvrebase.ts): no texel changes, small
// interpolated values on big faces far from the map origin.
import { describe, expect, it } from 'vitest';
import type { MaterialDef } from '../src/map/types';
import { rebaseUvs, uvRebaseStep } from '../src/render/uvrebase';

function testMaterial(name: string, over: Partial<MaterialDef> = {}): MaterialDef {
  return {
    name,
    shader: 'lightmappedgeneric',
    image: null,
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

describe('uv rebase', () => {
  it('shifts each connected piece by whole repeats to sit around zero', () => {
    // two quads (separate vertices) far out in texture space, one triangle sharing nothing
    const uvs = new Float32Array([
      120.25, -93.5, 121.25, -93.5, 121.25, -92.5, 120.25, -92.5, // quad A
      -51.75, 58.125, -47.75, 58.125, -47.75, 62.125, -51.75, 62.125, // quad B (4 repeats wide)
      3.5, 0.25, 4.5, 0.25, 4, 1.25, // triangle C
    ]);
    const before = Array.from(uvs);
    const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10];
    expect(rebaseUvs(uvs, idx, 11)).toBe(3);
    for (let i = 0; i < uvs.length; i++) {
      // whole repeats only: the fractional part (the texel) is unchanged
      const d = before[i] - uvs[i];
      expect(Math.abs(d - Math.round(d))).toBeLessThan(1e-6);
      expect(Math.abs(uvs[i])).toBeLessThanOrEqual(3);
    }
    // a piece moves as one: its vertices keep their relative coordinates
    expect(uvs[2] - uvs[0]).toBeCloseTo(1, 6);
    expect(uvs[10] - uvs[8]).toBeCloseTo(4, 6);
    // already near zero: nothing to do
    expect(rebaseUvs(uvs, idx, 11)).toBe(0);
  });

  it('pieces joined through shared vertices move together; step keeps the shift on the transform lattice', () => {
    // a strip of two triangles sharing an edge, spanning u 10..12
    const uvs = new Float32Array([10, 0, 11, 0, 11, 1, 12, 1]);
    rebaseUvs(uvs, [0, 1, 2, 1, 3, 2], 4, 4);
    expect(Array.from(uvs)).toEqual([-2, 0, -1, 0, -1, 1, 0, 1]);
    // step 0: untouched
    const keep = new Float32Array([100, 100, 101, 100, 100, 101]);
    expect(rebaseUvs(keep, [0, 1, 2], 3, 0)).toBe(0);
    expect(keep[0]).toBe(100);
  });

  it('uvRebaseStep: the lattice of every lookup made from the coordinates', () => {
    expect(uvRebaseStep(testMaterial('plain'))).toBe(1);
    expect(uvRebaseStep(null)).toBe(1);
    // $basetexturetransform scale 0.25 (and 2): a shift by 4 repeats is 1 repeat of the transformed lookup
    expect(uvRebaseStep(testMaterial('t', { textureTransform: [0.25, 0, 0.5, 0, 2, 0] }))).toBe(4);
    // a rotation by an odd angle has no lattice: leave the coordinates alone
    const c = Math.cos(0.3);
    const sn = Math.sin(0.3);
    expect(uvRebaseStep(testMaterial('rot', { textureTransform: [c, -sn, 0, sn, c, 0] }))).toBe(0);
    // detail scale 2.5 needs steps of 2; water samples at half scale
    const detail: MaterialDef['detail'] = { image: { width: 1, height: 1, data: new Uint8Array(4), hasAlpha: false }, scale: [2.5, 2.5], blendFactor: 1, blendMode: 0 };
    expect(uvRebaseStep(testMaterial('d', { detail }))).toBe(2);
    expect(uvRebaseStep(testMaterial('w', { isWater: true }))).toBe(2);
  });
});
