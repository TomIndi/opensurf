import {
  ClampToEdgeWrapping,
  CompressedTexture,
  CubeTexture,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBA_S3TC_DXT1_Format,
  RGBA_S3TC_DXT5_Format,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { describe, expect, it } from 'vitest';
import type { CompressedImage, DecodedImage } from '../src/map/types';
import { TextureCache, floatsToHalf, toHalf, validCompressedChain } from '../src/render/textures';

const img = (w: number, h: number, fill = 128): DecodedImage => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(fill), hasAlpha: false });
const caps = { maxAnisotropy: 16, s3tc: true, maxTextureSize: 4096 };

describe('half floats', () => {
  it('exact values round-trip', () => {
    for (const v of [0, 1, -1, 0.5, 2, 65504, -65504, 0.25, 1024, 6.103515625e-5 /* smallest normal */, 5.960464477539063e-8 /* smallest subnormal */]) {
      expect(DataUtils.fromHalfFloat(toHalf(v))).toBe(v);
    }
    expect(toHalf(-0)).toBe(0x8000);
  });

  it('overflow -> Inf, NaN stays NaN, tiny -> 0', () => {
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(-1e6)).toBe(0xfc00);
    expect(toHalf(Infinity)).toBe(0x7c00);
    expect(Number.isNaN(DataUtils.fromHalfFloat(toHalf(NaN)))).toBe(true);
    expect(toHalf(1e-10)).toBe(0);
  });

  it('rounds to nearest (never worse than three.js DataUtils.toHalfFloat, within half an ulp)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 20000; i++) {
      const e = Math.floor(rnd() * 40) - 26;
      const v = (rnd() * 2 - 1) * Math.pow(2, e);
      const mine = DataUtils.fromHalfFloat(toHalf(v));
      const ref = DataUtils.fromHalfFloat(DataUtils.toHalfFloat(v));
      expect(Math.abs(mine - v)).toBeLessThanOrEqual(Math.abs(ref - v) + 1e-12);
      const ulp = Math.max(Math.pow(2, Math.floor(Math.log2(Math.abs(v) || 1)) - 10), 5.960464477539063e-8);
      expect(Math.abs(mine - v)).toBeLessThanOrEqual(ulp / 2 + 1e-12);
    }
  });

  it('floatsToHalf converts arrays', () => {
    const h = floatsToHalf(new Float32Array([0, 1, 2.5, 0.75]));
    expect(Array.from(h, (x) => DataUtils.fromHalfFloat(x))).toEqual([0, 1, 2.5, 0.75]);
  });
});

describe('compressed chains', () => {
  const chain = (w: number, h: number, fmt: CompressedImage['format'], levels: number, bb = fmt === 'dxt1' ? 8 : 16): CompressedImage => {
    const mips = [];
    let x = w;
    let y = h;
    for (let i = 0; i < levels; i++) {
      mips.push({ width: x, height: y, data: new Uint8Array(Math.ceil(x / 4) * Math.ceil(y / 4) * bb) });
      x = Math.max(1, x >> 1);
      y = Math.max(1, y >> 1);
    }
    return { format: fmt, width: w, height: h, mips };
  };
  it('accepts well-formed chains (also partial ones)', () => {
    expect(validCompressedChain(chain(256, 128, 'dxt1', 9))).toBe(true);
    expect(validCompressedChain(chain(64, 64, 'dxt5', 3))).toBe(true);
  });
  it('rejects broken ones', () => {
    expect(validCompressedChain(chain(256, 128, 'dxt1', 9, 4))).toBe(false); // short data
    expect(validCompressedChain(chain(6, 8, 'dxt1', 1))).toBe(false); // not a block multiple
    const c = chain(64, 64, 'dxt3', 4);
    c.mips[2].width = 7;
    expect(validCompressedChain(c)).toBe(false);
    expect(validCompressedChain({ format: 'dxt1', width: 4, height: 4, mips: [] })).toBe(false);
  });
});

describe('TextureCache', () => {
  it('uploads each image once per colour space / wrap mode', () => {
    const tc = new TextureCache(caps);
    const a = img(64, 32);
    const t1 = tc.image(a, { srgb: true, repeat: true });
    expect(tc.image(a, { srgb: true, repeat: true })).toBe(t1);
    const t2 = tc.image(a, { srgb: false, repeat: true });
    expect(t2).not.toBe(t1);
    // same pixels, different DecodedImage object: still shared (keyed by the pixel buffer)
    expect(tc.image({ ...a }, { srgb: true, repeat: true })).toBe(t1);
    expect(tc.count).toBe(2);
    expect(t1).toBeInstanceOf(DataTexture);
    expect(t1.colorSpace).toBe(SRGBColorSpace);
    expect(t2.colorSpace).toBe(NoColorSpace);
    expect(t1.wrapS).toBe(RepeatWrapping);
    expect(t1.minFilter).toBe(LinearMipmapLinearFilter);
    expect(t1.generateMipmaps).toBe(true);
    expect(t1.flipY).toBe(false);
    const c = tc.image(a, { srgb: true, repeat: false });
    expect(c.wrapT).toBe(ClampToEdgeWrapping);
  });

  it('anisotropy is clamped to the device and applied to mipmapped textures', () => {
    const tc = new TextureCache({ ...caps, maxAnisotropy: 4 });
    const t = tc.image(img(8, 8), { srgb: true, repeat: true });
    const v0 = t.version;
    tc.setAnisotropy(16);
    expect(tc.getAnisotropy()).toBe(4);
    expect(t.anisotropy).toBe(4);
    expect(t.version).toBeGreaterThan(v0);
    tc.setAnisotropy(NaN);
    expect(tc.getAnisotropy()).toBe(1);
    const none = new TextureCache({ ...caps, maxAnisotropy: 1 });
    none.setAnisotropy(16);
    expect(none.getAnisotropy()).toBe(1);
  });

  it('uses the DXT chain when the device has S3TC, the RGBA image otherwise', () => {
    const mips = [
      { width: 8, height: 8, data: new Uint8Array(4 * 16) },
      { width: 4, height: 4, data: new Uint8Array(16) },
    ];
    const im: DecodedImage = { ...img(2, 2), compressed: { format: 'dxt5', width: 8, height: 8, mips } };
    const t = new TextureCache(caps).image(im, { srgb: true, repeat: true });
    expect(t).toBeInstanceOf(CompressedTexture);
    expect(t.format).toBe(RGBA_S3TC_DXT5_Format);
    expect(t.colorSpace).toBe(SRGBColorSpace);
    expect(t.generateMipmaps).toBe(false);
    const dxt1: DecodedImage = { ...img(2, 2), compressed: { format: 'dxt1', width: 8, height: 8, mips: [{ width: 8, height: 8, data: new Uint8Array(32) }] } };
    const t1 = new TextureCache(caps).image(dxt1, { srgb: true, repeat: true });
    expect(t1.format).toBe(RGBA_S3TC_DXT1_Format);
    expect(t1.minFilter).toBe(LinearFilter); // single level: no mip filtering
    const noS3 = new TextureCache({ ...caps, s3tc: false }).image(im, { srgb: true, repeat: true });
    expect(noS3).toBeInstanceOf(DataTexture);
    expect((noS3.image as { width: number }).width).toBe(2);
  });

  it('downsamples images bigger than the device limit and pads short data', () => {
    const tc = new TextureCache({ ...caps, maxTextureSize: 16 });
    const big = img(64, 32, 200);
    const t = tc.image(big, { srgb: true, repeat: true });
    const im = t.image as { width: number; height: number; data: Uint8Array };
    expect([im.width, im.height]).toEqual([16, 8]);
    expect(im.data[0]).toBe(200);
    const short: DecodedImage = { width: 4, height: 4, data: new Uint8Array(10), hasAlpha: false };
    const ts = tc.image(short, { srgb: true, repeat: true });
    expect((ts.image as { data: Uint8Array }).data.length).toBe(64);
  });

  it('solid colours are shared 1x1 textures', () => {
    const tc = new TextureCache(caps);
    const a = tc.solid([1, 0.5, 0]);
    expect(tc.solid([1, 0.5, 0])).toBe(a);
    expect((a.image as { data: Uint8Array }).data.slice(0, 4)).toEqual(new Uint8Array([255, 128, 0, 255]));
    expect(tc.solid([0, 0, 1])).not.toBe(a);
  });

  it('lightmap: RGBA half float, bilinear, clamped, no mips, not flipped, linear data', () => {
    const tc = new TextureCache(caps);
    const data = new Float32Array(4 * 3 * 4);
    for (let i = 0; i < data.length; i++) data[i] = i / 8;
    const t = tc.lightmap({ width: 4, height: 3, data });
    expect(t.type).toBe(HalfFloatType);
    expect(t.minFilter).toBe(LinearFilter);
    expect(t.magFilter).toBe(LinearFilter);
    expect(t.wrapS).toBe(ClampToEdgeWrapping);
    expect(t.generateMipmaps).toBe(false);
    expect(t.flipY).toBe(false);
    expect(t.colorSpace).toBe(NoColorSpace);
    const h = (t.image as { data: Uint16Array }).data;
    expect(DataUtils.fromHalfFloat(h[13])).toBeCloseTo(13 / 8, 3);
    // short atlas data is padded, never read out of bounds
    const t2 = tc.lightmap({ width: 4, height: 4, data: new Float32Array(8) });
    expect((t2.image as { data: Uint16Array }).data.length).toBe(64);
  });

  it('cube textures: six faces, sRGB, mipmapped, not flipped', () => {
    const tc = new TextureCache(caps);
    const faces = Array.from({ length: 6 }, () => new Uint8Array(4 * 4 * 4));
    const t = tc.cube(faces, 4);
    expect(t).toBeInstanceOf(CubeTexture);
    expect((t.image as unknown[]).length).toBe(6);
    expect(t.colorSpace).toBe(SRGBColorSpace);
    expect(t.flipY).toBe(false);
    expect(t.minFilter).toBe(LinearMipmapLinearFilter);
  });

  it('dispose releases everything', () => {
    const tc = new TextureCache(caps);
    const t = tc.image(img(4, 4), { srgb: true, repeat: true });
    let disposed = 0;
    t.addEventListener('dispose', () => disposed++);
    tc.lightmap({ width: 1, height: 1, data: new Float32Array(4) });
    tc.dispose();
    expect(disposed).toBe(1);
    expect(tc.count).toBe(0);
    expect(tc.textures()).toHaveLength(0);
  });
});
