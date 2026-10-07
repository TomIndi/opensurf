// GPU textures for map data: material images (RGBA8 sRGB with mipmaps, or the original DXT chain when the
// device supports S3TC), the lightmap atlas (RGBA half float, linear), cubemaps (sky, env_cubemaps).
// Images shared by several materials are uploaded once (cached by pixel buffer identity).
import {
  ClampToEdgeWrapping,
  CompressedTexture,
  CubeTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RGBA_S3TC_DXT1_Format,
  RGBA_S3TC_DXT3_Format,
  RGBA_S3TC_DXT5_Format,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from 'three';
import type { CompressedImage, DecodedImage, LightmapAtlas } from '../map/types';

export interface TextureCaps {
  /** Largest anisotropy the device supports (1 = no EXT_texture_filter_anisotropic). */
  maxAnisotropy: number;
  /** WEBGL_compressed_texture_s3tc and WEBGL_compressed_texture_s3tc_srgb are both available. */
  s3tc: boolean;
  /** Largest texture side. */
  maxTextureSize: number;
}

export interface ImageTextureOptions {
  /** Colour data (sRGB-encoded, decoded to linear by the sampler) or raw data (masks, mod2x detail). */
  srgb: boolean;
  /** Repeat (material textures) or clamp. */
  repeat: boolean;
}

// ------------------------------------------------------------------------------------ half floats

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE 754 half float bits for a float (round to nearest even, overflow -> Inf, NaN preserved). */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow
  if (e <= 0) {
    // subnormal half (or zero)
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++; // may carry into the exponent: still correct (up to Inf)
  return sign | h;
}

/** Converts float data to half floats (for HalfFloatType uploads). */
export function floatsToHalf(src: Float32Array, out: Uint16Array = new Uint16Array(src.length)): Uint16Array {
  for (let i = 0; i < src.length; i++) out[i] = toHalf(src[i]);
  return out;
}

// ------------------------------------------------------------------------------------ DXT validation

const BLOCK_BYTES: Record<CompressedImage['format'], number> = { dxt1: 8, dxt3: 16, dxt5: 16 };

/** True when a compressed mip chain is well-formed (block sizes, halving dimensions, data lengths). */
export function validCompressedChain(c: CompressedImage): boolean {
  if (!c || !c.mips || !c.mips.length) return false;
  const bb = BLOCK_BYTES[c.format];
  if (!bb) return false;
  let w = c.mips[0].width;
  let h = c.mips[0].height;
  if (w !== c.width || h !== c.height || w <= 0 || h <= 0) return false;
  if (w % 4 !== 0 || h % 4 !== 0) return false;
  for (let i = 0; i < c.mips.length; i++) {
    const m = c.mips[i];
    if (m.width !== w || m.height !== h) return false;
    const need = Math.ceil(w / 4) * Math.ceil(h / 4) * bb;
    if (!m.data || m.data.length < need) return false;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return true;
}

// ------------------------------------------------------------------------------------ cache

interface Entry {
  tex: Texture;
  mipmapped: boolean;
}

export class TextureCache {
  private readonly entries = new Map<object, Map<string, Entry>>();
  private readonly all = new Set<Texture>();
  private anisotropy = 1;
  /** Bytes uploaded (approximate, for diagnostics). */
  bytes = 0;

  constructor(private readonly caps: TextureCaps) {}

  get count(): number {
    return this.all.size;
  }

  /** Requested anisotropy (clamped to the device maximum). Re-uploads mipmapped textures when it changes. */
  setAnisotropy(n: number): void {
    const a = Math.max(1, Math.min(this.caps.maxAnisotropy, Math.floor(Number.isFinite(n) ? n : 1)));
    if (a === this.anisotropy) return;
    this.anisotropy = a;
    for (const byOpts of this.entries.values()) {
      for (const e of byOpts.values()) {
        if (!e.mipmapped) continue;
        e.tex.anisotropy = a;
        e.tex.needsUpdate = true;
      }
    }
  }

  getAnisotropy(): number {
    return this.anisotropy;
  }

  private remember(key: object, sub: string, e: Entry): Texture {
    let m = this.entries.get(key);
    if (!m) this.entries.set(key, (m = new Map()));
    m.set(sub, e);
    this.all.add(e.tex);
    return e.tex;
  }

  private lookup(key: object, sub: string): Texture | null {
    return this.entries.get(key)?.get(sub)?.tex ?? null;
  }

  /** Texture for a decoded image (cached per pixel buffer + options). */
  image(img: DecodedImage, opts: ImageTextureOptions): Texture {
    const sub = `${opts.srgb ? 's' : 'l'}${opts.repeat ? 'r' : 'c'}`;
    const hit = this.lookup(img.data, sub);
    if (hit) return hit;
    const wrap = opts.repeat ? RepeatWrapping : ClampToEdgeWrapping;
    let tex: Texture | null = null;
    const c = img.compressed;
    if (c && this.caps.s3tc && validCompressedChain(c) && c.width <= this.caps.maxTextureSize && c.height <= this.caps.maxTextureSize) {
      const fmt = c.format === 'dxt1' ? RGBA_S3TC_DXT1_Format : c.format === 'dxt3' ? RGBA_S3TC_DXT3_Format : RGBA_S3TC_DXT5_Format;
      const mips = c.mips.map((m) => ({ data: m.data, width: m.width, height: m.height }));
      const ct = new CompressedTexture(mips as unknown as ImageData[], c.width, c.height, fmt, UnsignedByteType);
      ct.minFilter = mips.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
      ct.generateMipmaps = false;
      tex = ct;
      for (const m of c.mips) this.bytes += m.data.byteLength;
    }
    if (!tex) {
      const { width, height, data } = this.fitImage(img);
      const dt = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
      dt.generateMipmaps = true;
      dt.minFilter = LinearMipmapLinearFilter;
      tex = dt;
      this.bytes += Math.round(data.byteLength * 1.33);
    }
    tex.magFilter = LinearFilter;
    tex.wrapS = wrap;
    tex.wrapT = wrap;
    tex.flipY = false;
    tex.colorSpace = opts.srgb ? SRGBColorSpace : NoColorSpace;
    tex.anisotropy = this.anisotropy;
    tex.needsUpdate = true;
    return this.remember(img.data, sub, { tex, mipmapped: tex.minFilter === LinearMipmapLinearFilter });
  }

  /** Images larger than the device limit are box-downsampled (rare: maps normally stay <= 2048). */
  private fitImage(img: DecodedImage): { width: number; height: number; data: Uint8Array } {
    let { width, height, data } = img;
    const need = width * height * 4;
    if (data.length < need) {
      // malformed: pad (never index out of range on upload)
      const d = new Uint8Array(need);
      d.set(data.subarray(0, Math.min(data.length, need)));
      data = d;
    }
    const max = Math.max(1, this.caps.maxTextureSize);
    while (width > max || height > max) {
      const w2 = Math.max(1, width >> 1);
      const h2 = Math.max(1, height >> 1);
      const out = new Uint8Array(w2 * h2 * 4);
      for (let y = 0; y < h2; y++) {
        const y0 = Math.min(height - 1, y * 2);
        const y1 = Math.min(height - 1, y * 2 + 1);
        for (let x = 0; x < w2; x++) {
          const x0 = Math.min(width - 1, x * 2);
          const x1 = Math.min(width - 1, x * 2 + 1);
          for (let k = 0; k < 4; k++) {
            out[(y * w2 + x) * 4 + k] =
              (data[(y0 * width + x0) * 4 + k] + data[(y0 * width + x1) * 4 + k] + data[(y1 * width + x0) * 4 + k] + data[(y1 * width + x1) * 4 + k] + 2) >> 2;
          }
        }
      }
      width = w2;
      height = h2;
      data = out;
    }
    return { width, height, data };
  }

  /** 1x1 texture of an sRGB colour (materials without an image). */
  solid(rgb: [number, number, number], alpha = 1): Texture {
    const key = `solid:${rgb.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(',')},${Math.round(alpha * 255)}`;
    let holder = this.solids.get(key);
    if (!holder) {
      const d = new Uint8Array(4);
      d[0] = Math.round(Math.max(0, Math.min(1, rgb[0])) * 255);
      d[1] = Math.round(Math.max(0, Math.min(1, rgb[1])) * 255);
      d[2] = Math.round(Math.max(0, Math.min(1, rgb[2])) * 255);
      d[3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
      holder = { width: 1, height: 1, data: d, hasAlpha: alpha < 1 };
      this.solids.set(key, holder);
    }
    return this.image(holder, { srgb: true, repeat: true });
  }

  private readonly solids = new Map<string, DecodedImage>();

  /** The lightmap atlas as an RGBA half-float texture (bilinear, clamped, no mips, linear values). */
  lightmap(atlas: LightmapAtlas): DataTexture {
    const n = atlas.width * atlas.height * 4;
    const src = atlas.data.length >= n ? atlas.data : padFloats(atlas.data, n);
    const half = floatsToHalf(src.length === n ? src : src.subarray(0, n));
    const t = new DataTexture(half, atlas.width, atlas.height, RGBAFormat, HalfFloatType);
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.flipY = false;
    t.colorSpace = NoColorSpace;
    t.needsUpdate = true;
    this.all.add(t);
    this.bytes += half.byteLength;
    return t;
  }

  /**
   * A cube texture from six n×n RGBA8 faces in GL order (+X, -X, +Y, -Y, +Z, -Z), sRGB colour, mipmapped.
   */
  cube(faces: Uint8Array[], size: number, mipmaps = true): CubeTexture {
    const imgs = faces.map((d) => {
      const dt = new DataTexture(d, size, size, RGBAFormat, UnsignedByteType);
      dt.flipY = false;
      return dt;
    });
    const t = new CubeTexture(imgs as unknown as HTMLImageElement[]);
    t.format = RGBAFormat;
    t.type = UnsignedByteType;
    t.colorSpace = SRGBColorSpace;
    t.flipY = false;
    t.generateMipmaps = mipmaps;
    t.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter;
    t.magFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.needsUpdate = true;
    this.all.add(t);
    this.bytes += Math.round(size * size * 4 * 6 * (mipmaps ? 1.33 : 1));
    return t;
  }

  /** Every texture created so far (for pre-uploading). */
  textures(): Texture[] {
    return [...this.all];
  }

  dispose(): void {
    for (const t of this.all) t.dispose();
    this.all.clear();
    this.entries.clear();
    this.solids.clear();
    this.bytes = 0;
  }
}

function padFloats(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  out.set(src.subarray(0, Math.min(src.length, n)));
  return out;
}
