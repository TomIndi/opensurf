// Valve Texture Format (VTF 7.0 – 7.5) decoder, written from the public format description.
//
// File layout:
//   header (headerSize bytes; 7.3+ ends with a resource directory)
//   low-res thumbnail (usually DXT1 16x16)               — 7.0–7.2: right after the header
//   high-res image data                                  — 7.3+: located through the resource directory
//     for each mip, smallest first:
//       for each frame: for each face: for each depth slice: one 2D image
//
// decodeVtf() picks frame 0 / face 0 / slice 0 of the largest mip that fits `maxSize` and converts it to RGBA8
// (sRGB colour, straight alpha). HDR formats are tone-mapped to sRGB8. It never throws on bad input.
import type { DecodedImage } from '../map/types';

/** VTF image formats (values of the header's highResImageFormat / lowResImageFormat). */
export const VtfFormat = {
  NONE: -1,
  RGBA8888: 0,
  ABGR8888: 1,
  RGB888: 2,
  BGR888: 3,
  RGB565: 4,
  I8: 5,
  IA88: 6,
  P8: 7,
  A8: 8,
  RGB888_BLUESCREEN: 9,
  BGR888_BLUESCREEN: 10,
  ARGB8888: 11,
  BGRA8888: 12,
  DXT1: 13,
  DXT3: 14,
  DXT5: 15,
  BGRX8888: 16,
  BGR565: 17,
  BGRX5551: 18,
  BGRA4444: 19,
  DXT1_ONEBITALPHA: 20,
  BGRA5551: 21,
  UV88: 22,
  UVWQ8888: 23,
  RGBA16161616F: 24,
  RGBA16161616: 25,
  UVLX8888: 26,
  R32F: 27,
  RGB323232F: 28,
  RGBA32323232F: 29,
  NV_DST16: 30,
  NV_DST24: 31,
  NV_INTZ: 32,
  NV_RAWZ: 33,
  ATI_DST16: 34,
  ATI_DST24: 35,
  NV_NULL: 36,
  ATI2N: 37,
  ATI1N: 38,
} as const;

const FORMAT_NAMES: string[] = [];
for (const [k, v] of Object.entries(VtfFormat)) if (v >= 0) FORMAT_NAMES[v] = k;

/** Human-readable format name ("DXT1", "BGRA8888", ...), or "UNKNOWN(n)". */
export function vtfFormatName(format: number): string {
  return FORMAT_NAMES[format] ?? (format === -1 ? 'NONE' : `UNKNOWN(${format})`);
}

/** Texture flags (subset). */
export const VTF_FLAG_POINTSAMPLE = 0x1;
export const VTF_FLAG_CLAMPS = 0x4;
export const VTF_FLAG_CLAMPT = 0x8;
export const VTF_FLAG_NORMAL = 0x80;
export const VTF_FLAG_NOMIP = 0x100;
export const VTF_FLAG_ONEBITALPHA = 0x1000;
export const VTF_FLAG_EIGHTBITALPHA = 0x2000;
export const VTF_FLAG_ENVMAP = 0x4000;
export const VTF_FLAG_SSBUMP = 0x8000000;

interface FormatInfo {
  /** Bytes per pixel, or bytes per 4x4 block for block-compressed formats. */
  bytes: number;
  block: boolean;
  /** Whether the format carries alpha at all. */
  alpha: boolean;
  /** Whether decodeVtf can convert it to RGBA8. */
  decodable: boolean;
}

function fi(bytes: number, block: boolean, alpha: boolean, decodable = true): FormatInfo {
  return { bytes, block, alpha, decodable };
}

const FORMATS: FormatInfo[] = [
  fi(4, false, true), // RGBA8888
  fi(4, false, true), // ABGR8888
  fi(3, false, false), // RGB888
  fi(3, false, false), // BGR888
  fi(2, false, false), // RGB565
  fi(1, false, false), // I8
  fi(2, false, true), // IA88
  fi(1, false, false, false), // P8 (palette never shipped)
  fi(1, false, true), // A8
  fi(3, false, true), // RGB888_BLUESCREEN
  fi(3, false, true), // BGR888_BLUESCREEN
  fi(4, false, true), // ARGB8888
  fi(4, false, true), // BGRA8888
  fi(8, true, true), // DXT1 (3-colour blocks can punch through)
  fi(16, true, true), // DXT3
  fi(16, true, true), // DXT5
  fi(4, false, false), // BGRX8888
  fi(2, false, false), // BGR565
  fi(2, false, false), // BGRX5551
  fi(2, false, true), // BGRA4444
  fi(8, true, true), // DXT1_ONEBITALPHA
  fi(2, false, true), // BGRA5551
  fi(2, false, false), // UV88
  fi(4, false, false), // UVWQ8888
  fi(8, false, true), // RGBA16161616F
  fi(8, false, true), // RGBA16161616
  fi(4, false, false), // UVLX8888
  fi(4, false, false), // R32F
  fi(12, false, false), // RGB323232F
  fi(16, false, true), // RGBA32323232F
  fi(2, false, false, false), // NV_DST16
  fi(3, false, false, false), // NV_DST24
  fi(4, false, false, false), // NV_INTZ
  fi(4, false, false, false), // NV_RAWZ
  fi(2, false, false, false), // ATI_DST16
  fi(3, false, false, false), // ATI_DST24
  fi(0, false, false, false), // NV_NULL (no memory)
  fi(16, true, false), // ATI2N (BC5)
  fi(8, true, false), // ATI1N (BC4)
];

/** True for formats decodeVtf can convert. */
export function vtfFormatSupported(format: number): boolean {
  return FORMATS[format]?.decodable ?? false;
}

/** Bytes used by one w×h×d image of `format` (DXT: 4x4 blocks, at least one), or -1 for unknown formats. */
export function vtfImageSize(format: number, width: number, height: number, depth = 1): number {
  if (format === -1) return 0;
  const f = FORMATS[format];
  if (!f) return -1;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const d = Math.max(1, depth);
  if (f.block) return ((w + 3) >> 2) * ((h + 3) >> 2) * f.bytes * d;
  return w * h * d * f.bytes;
}

export interface VtfResource {
  /** 3-byte tag as a number: tag[0] | tag[1] << 8 | tag[2] << 16. */
  tag: number;
  flags: number;
  /** Offset into the file (or inline data when flags & 2). */
  data: number;
}

export const VTF_RSRC_LOWRES = 0x01;
export const VTF_RSRC_HIGHRES = 0x30;

export interface VtfHeader {
  versionMajor: number;
  versionMinor: number;
  headerSize: number;
  width: number;
  height: number;
  flags: number;
  frames: number;
  firstFrame: number;
  /** Average linear colour computed by vtex. */
  reflectivity: [number, number, number];
  bumpScale: number;
  format: number;
  mipCount: number;
  lowResFormat: number;
  lowResWidth: number;
  lowResHeight: number;
  depth: number;
  resources: VtfResource[];
  /** 1, or 6/7 for cube maps (7 = old-style cubemap with a trailing sphere map face). */
  faces: number;
  /** File offset of the high-res image data. */
  highResOffset: number;
  /** File offset of the low-res thumbnail, or -1. */
  lowResOffset: number;
  /** True when the high-res data (all mips/frames/faces) fits inside the file. */
  complete: boolean;
}

const SIGNATURE = 0x00465456; // "VTF\0" little-endian

/** Size of all high-res mips for the given layout, or -1 when the format is unknown. */
function highResTotal(format: number, w: number, h: number, d: number, mips: number, frames: number, faces: number): number {
  let total = 0;
  for (let m = 0; m < mips; m++) {
    const s = vtfImageSize(format, Math.max(1, w >> m), Math.max(1, h >> m), Math.max(1, d >> m));
    if (s < 0) return -1;
    total += s * frames * faces;
  }
  return total;
}

/** Parses and sanity-checks a VTF header. Returns null for anything that isn't a usable VTF. */
export function parseVtfHeader(data: Uint8Array): VtfHeader | null {
  if (!data || data.length < 64) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== SIGNATURE) return null;
  const versionMajor = dv.getUint32(4, true);
  const versionMinor = dv.getUint32(8, true);
  if (versionMajor !== 7 || versionMinor > 6) return null;
  const headerSize = dv.getUint32(12, true);
  const width = dv.getUint16(16, true);
  const height = dv.getUint16(18, true);
  const flags = dv.getUint32(20, true);
  const frames = Math.max(1, dv.getUint16(24, true));
  const firstFrame = dv.getUint16(26, true);
  const reflectivity: [number, number, number] = [dv.getFloat32(32, true), dv.getFloat32(36, true), dv.getFloat32(40, true)];
  const bumpScale = dv.getFloat32(48, true);
  const format = dv.getInt32(52, true);
  let mipCount = data[56];
  const lowResFormat = dv.getInt32(57, true);
  const lowResWidth = data[61];
  const lowResHeight = data[62];
  let depth = 1;
  if (versionMinor >= 2 && data.length >= 65) depth = Math.max(1, dv.getUint16(63, true));
  if (width < 1 || height < 1 || width > 32768 || height > 32768) return null;
  if (depth > 8192) return null;
  if (!FORMATS[format]) return null;
  if (headerSize < 48 || headerSize > data.length) return null;
  const maxMips = 1 + Math.floor(Math.log2(Math.max(width, height, depth)));
  if (mipCount < 1) mipCount = 1;
  if (mipCount > maxMips) mipCount = maxMips;

  const resources: VtfResource[] = [];
  if (versionMinor >= 3 && data.length >= 80) {
    const n = dv.getUint32(68, true);
    if (n > 64) return null;
    for (let i = 0; i < n; i++) {
      const o = 80 + i * 8;
      if (o + 8 > data.length) break;
      resources.push({ tag: data[o] | (data[o + 1] << 8) | (data[o + 2] << 16), flags: data[o + 3], data: dv.getUint32(o + 4, true) });
    }
  }

  const lowResSize = lowResFormat === -1 || lowResWidth === 0 || lowResHeight === 0 ? 0 : vtfImageSize(lowResFormat, lowResWidth, lowResHeight);
  let lowResOffset = -1;
  let highResOffset = -1;
  if (resources.length) {
    for (const r of resources) {
      if (r.flags & 2) continue; // inline data, not an offset
      if (r.tag === VTF_RSRC_HIGHRES) highResOffset = r.data;
      else if (r.tag === VTF_RSRC_LOWRES) lowResOffset = r.data;
    }
  }
  if (highResOffset < 0) {
    if (lowResSize < 0) return null;
    if (lowResSize > 0) lowResOffset = headerSize;
    highResOffset = headerSize + Math.max(0, lowResSize);
  }
  if (highResOffset >= data.length) return null;

  // Face count: cube maps store 6 faces, plus a 7th sphere-map face in files older than 7.5 (unless the
  // firstFrame field holds the 0xFFFF "no sphere map" marker). Verify against the data actually present.
  let faces = 1;
  if (flags & VTF_FLAG_ENVMAP) {
    const preferred = versionMinor < 5 && firstFrame !== 0xffff ? 7 : 6;
    const other = preferred === 7 ? 6 : 7;
    const avail = data.length - highResOffset;
    const tp = highResTotal(format, width, height, depth, mipCount, frames, preferred);
    const to = highResTotal(format, width, height, depth, mipCount, frames, other);
    faces = tp >= 0 && tp <= avail ? preferred : to >= 0 && to <= avail ? other : preferred;
  }
  const total = highResTotal(format, width, height, depth, mipCount, frames, faces);
  const complete = total >= 0 && highResOffset + total <= data.length;

  return {
    versionMajor,
    versionMinor,
    headerSize,
    width,
    height,
    flags,
    frames,
    firstFrame,
    reflectivity,
    bumpScale,
    format,
    mipCount,
    lowResFormat,
    lowResWidth,
    lowResHeight,
    depth,
    resources,
    faces,
    highResOffset,
    lowResOffset,
    complete,
  };
}

/** Location of one 2D image inside the file. */
export interface VtfImageRef {
  mip: number;
  width: number;
  height: number;
  offset: number;
  size: number;
}

/**
 * Locates the 2D image (mip, frame, face, slice). Mips are counted from the largest (0). Returns null when the
 * indices are out of range or the data lies outside the file.
 */
export function vtfImageRef(h: VtfHeader, dataLength: number, mip: number, frame = 0, face = 0, slice = 0): VtfImageRef | null {
  if (mip < 0 || mip >= h.mipCount || frame < 0 || frame >= h.frames || face < 0 || face >= h.faces) return null;
  let offset = h.highResOffset;
  for (let m = h.mipCount - 1; m > mip; m--) {
    const s = vtfImageSize(h.format, Math.max(1, h.width >> m), Math.max(1, h.height >> m), Math.max(1, h.depth >> m));
    if (s < 0) return null;
    offset += s * h.frames * h.faces;
  }
  const w = Math.max(1, h.width >> mip);
  const hh = Math.max(1, h.height >> mip);
  const d = Math.max(1, h.depth >> mip);
  const s2 = vtfImageSize(h.format, w, hh);
  if (s2 < 0) return null;
  const z = Math.min(Math.max(0, slice), d - 1);
  offset += ((frame * h.faces + face) * d + z) * s2;
  if (offset + s2 > dataLength) return null;
  return { mip, width: w, height: hh, offset, size: s2 };
}

/** Index of the largest mip whose max(width, height) <= maxSize (the smallest stored mip if none fits). */
export function vtfPickMip(h: VtfHeader, maxSize: number): number {
  let mip = 0;
  while (mip < h.mipCount - 1 && Math.max(h.width >> mip, h.height >> mip) > maxSize) mip++;
  return mip;
}

// ------------------------------------------------------------------ colour helpers

let halfTable: Float32Array | null = null;
function halfToFloatTable(): Float32Array {
  if (halfTable) return halfTable;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 31;
    const m = h & 1023;
    let v: number;
    if (e === 0) v = (m / 1024) * 2 ** -14;
    else if (e === 31) v = m ? NaN : Infinity;
    else v = (1 + m / 1024) * 2 ** (e - 15);
    t[h] = s * v;
  }
  halfTable = t;
  return t;
}

/** Linear 0..1 → sRGB 0..1 (IEC 61966-2-1). */
export function linearToSrgb(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** sRGB 0..1 → linear 0..1. */
export function srgbToLinear(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

const TONE_KNEE = 0.8;
/** Soft-shoulder tone curve: identity below the knee, smooth roll-off to 1 above it. */
export function tonemapLinear(x: number): number {
  if (!(x > 0)) return 0;
  if (x <= TONE_KNEE) return x;
  const r = 1 - TONE_KNEE;
  return TONE_KNEE + r * (1 - Math.exp(-(x - TONE_KNEE) / r));
}

let srgbLut: Uint8Array | null = null;
const LUT_SIZE = 4096;
function linearToSrgb8Lut(): Uint8Array {
  if (srgbLut) return srgbLut;
  const t = new Uint8Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) t[i] = Math.round(linearToSrgb(i / LUT_SIZE) * 255);
  srgbLut = t;
  return t;
}

/** HDR linear value → tone-mapped sRGB byte. */
function hdrToByte(x: number, lut: Uint8Array): number {
  const t = tonemapLinear(x);
  return lut[(t * LUT_SIZE + 0.5) | 0];
}

function clampByte(x: number): number {
  return x <= 0 ? 0 : x >= 255 ? 255 : (x + 0.5) | 0;
}

// ------------------------------------------------------------------ block decoders

/** Decodes BC1/BC2/BC3 (DXT1/3/5) data into RGBA8. */
function decodeDxt(src: Uint8Array, off: number, w: number, h: number, kind: 1 | 3 | 5, out: Uint8Array): void {
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  const blockBytes = kind === 1 ? 8 : 16;
  const pal = new Int32Array(16); // 4 colours × RGBA
  const alphas = new Uint8Array(16);
  const aPal = new Int32Array(8);
  let p = off;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, p += blockBytes) {
      // ---- alpha
      if (kind === 3) {
        for (let i = 0; i < 8; i++) {
          const b = src[p + i];
          alphas[i * 2] = (b & 15) * 17;
          alphas[i * 2 + 1] = (b >> 4) * 17;
        }
      } else if (kind === 5) {
        const a0 = src[p];
        const a1 = src[p + 1];
        aPal[0] = a0;
        aPal[1] = a1;
        if (a0 > a1) {
          for (let i = 1; i < 7; i++) aPal[i + 1] = (((7 - i) * a0 + i * a1 + 3) / 7) | 0;
        } else {
          for (let i = 1; i < 5; i++) aPal[i + 1] = (((5 - i) * a0 + i * a1 + 2) / 5) | 0;
          aPal[6] = 0;
          aPal[7] = 255;
        }
        // 16 × 3-bit indices, little-endian, in two 24-bit halves.
        const lo = src[p + 2] | (src[p + 3] << 8) | (src[p + 4] << 16);
        const hi = src[p + 5] | (src[p + 6] << 8) | (src[p + 7] << 16);
        for (let i = 0; i < 8; i++) {
          alphas[i] = aPal[(lo >> (3 * i)) & 7];
          alphas[i + 8] = aPal[(hi >> (3 * i)) & 7];
        }
      }
      // ---- colour
      const c = kind === 1 ? p : p + 8;
      const c0 = src[c] | (src[c + 1] << 8);
      const c1 = src[c + 2] | (src[c + 3] << 8);
      let r0 = (c0 >> 11) & 31;
      let g0 = (c0 >> 5) & 63;
      let b0 = c0 & 31;
      let r1 = (c1 >> 11) & 31;
      let g1 = (c1 >> 5) & 63;
      let b1 = c1 & 31;
      r0 = (r0 << 3) | (r0 >> 2);
      g0 = (g0 << 2) | (g0 >> 4);
      b0 = (b0 << 3) | (b0 >> 2);
      r1 = (r1 << 3) | (r1 >> 2);
      g1 = (g1 << 2) | (g1 >> 4);
      b1 = (b1 << 3) | (b1 >> 2);
      pal[0] = r0;
      pal[1] = g0;
      pal[2] = b0;
      pal[3] = 255;
      pal[4] = r1;
      pal[5] = g1;
      pal[6] = b1;
      pal[7] = 255;
      if (kind !== 1 || c0 > c1) {
        pal[8] = ((2 * r0 + r1 + 1) / 3) | 0;
        pal[9] = ((2 * g0 + g1 + 1) / 3) | 0;
        pal[10] = ((2 * b0 + b1 + 1) / 3) | 0;
        pal[11] = 255;
        pal[12] = ((r0 + 2 * r1 + 1) / 3) | 0;
        pal[13] = ((g0 + 2 * g1 + 1) / 3) | 0;
        pal[14] = ((b0 + 2 * b1 + 1) / 3) | 0;
        pal[15] = 255;
      } else {
        pal[8] = (r0 + r1 + 1) >> 1;
        pal[9] = (g0 + g1 + 1) >> 1;
        pal[10] = (b0 + b1 + 1) >> 1;
        pal[11] = 255;
        pal[12] = 0;
        pal[13] = 0;
        pal[14] = 0;
        pal[15] = 0; // punch-through
      }
      const idx = (src[c + 4] | (src[c + 5] << 8) | (src[c + 6] << 16) | (src[c + 7] << 24)) >>> 0;
      const x0 = bx << 2;
      const y0 = by << 2;
      const full = x0 + 4 <= w && y0 + 4 <= h;
      for (let i = 0; i < 16; i++) {
        const px = x0 + (i & 3);
        const py = y0 + (i >> 2);
        if (!full && (px >= w || py >= h)) continue;
        const k = ((idx >>> (2 * i)) & 3) << 2;
        const o = (py * w + px) << 2;
        out[o] = pal[k];
        out[o + 1] = pal[k + 1];
        out[o + 2] = pal[k + 2];
        out[o + 3] = kind === 1 ? pal[k + 3] : alphas[i];
      }
    }
  }
}

/** Decodes one BC4-style (DXT5 alpha) block's 16 values into `vals`. */
function decodeBc4Block(src: Uint8Array, p: number, vals: Uint8Array): void {
  const a0 = src[p];
  const a1 = src[p + 1];
  const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) pal[i + 1] = (((7 - i) * a0 + i * a1 + 3) / 7) | 0;
  } else {
    for (let i = 1; i < 5; i++) pal[i + 1] = (((5 - i) * a0 + i * a1 + 2) / 5) | 0;
    pal[6] = 0;
    pal[7] = 255;
  }
  const lo = src[p + 2] | (src[p + 3] << 8) | (src[p + 4] << 16);
  const hi = src[p + 5] | (src[p + 6] << 8) | (src[p + 7] << 16);
  for (let i = 0; i < 8; i++) {
    vals[i] = pal[(lo >> (3 * i)) & 7];
    vals[i + 8] = pal[(hi >> (3 * i)) & 7];
  }
}

/** ATI1N (BC4, one channel) / ATI2N (BC5, two channels: normal map X/Y). */
function decodeAti(src: Uint8Array, off: number, w: number, h: number, two: boolean, out: Uint8Array): void {
  const bw = (w + 3) >> 2;
  const bh = (h + 3) >> 2;
  const xs = new Uint8Array(16);
  const ys = new Uint8Array(16);
  let p = off;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      decodeBc4Block(src, p, xs);
      if (two) decodeBc4Block(src, p + 8, ys);
      p += two ? 16 : 8;
      for (let i = 0; i < 16; i++) {
        const px = (bx << 2) + (i & 3);
        const py = (by << 2) + (i >> 2);
        if (px >= w || py >= h) continue;
        const o = (py * w + px) << 2;
        if (two) {
          const nx = xs[i] / 127.5 - 1;
          const ny = ys[i] / 127.5 - 1;
          const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          out[o] = xs[i];
          out[o + 1] = ys[i];
          out[o + 2] = clampByte((nz * 0.5 + 0.5) * 255);
        } else {
          out[o] = out[o + 1] = out[o + 2] = xs[i];
        }
        out[o + 3] = 255;
      }
    }
  }
}

// ------------------------------------------------------------------ image conversion

export interface ConvertOptions {
  /**
   * Treat BGRA8888 data as Valve "compressed HDR" (colour = rgb * alpha * 16 / 255, linear) and tone-map it.
   * Used for $hdrcompressedtexture skybox faces.
   */
  hdrCompressed?: boolean;
  /** Linear multiplier applied to HDR data before tone mapping (default 1). */
  exposure?: number;
}

/**
 * Converts one 2D image of `format` at `src[off..]` to RGBA8. Returns null for unsupported formats or when the
 * data is too short.
 */
export function convertVtfImage(
  format: number,
  src: Uint8Array,
  off: number,
  w: number,
  h: number,
  opts: ConvertOptions = {},
): DecodedImage | null {
  const info = FORMATS[format];
  if (!info || !info.decodable) return null;
  const need = vtfImageSize(format, w, h);
  if (need < 0 || off < 0 || off + need > src.length) return null;
  const n = w * h;
  const out = new Uint8Array(n * 4);
  const exposure = opts.exposure ?? 1;
  const F = VtfFormat;
  let alphaCapable = info.alpha;

  switch (format) {
    case F.DXT1:
    case F.DXT1_ONEBITALPHA:
      decodeDxt(src, off, w, h, 1, out);
      break;
    case F.DXT3:
      decodeDxt(src, off, w, h, 3, out);
      break;
    case F.DXT5:
      decodeDxt(src, off, w, h, 5, out);
      break;
    case F.ATI1N:
    case F.ATI2N:
      decodeAti(src, off, w, h, format === F.ATI2N, out);
      break;
    case F.RGBA8888:
      out.set(src.subarray(off, off + n * 4));
      break;
    case F.ABGR8888:
      for (let i = 0, p = off; i < n; i++, p += 4) {
        const o = i << 2;
        out[o] = src[p + 3];
        out[o + 1] = src[p + 2];
        out[o + 2] = src[p + 1];
        out[o + 3] = src[p];
      }
      break;
    case F.ARGB8888:
      for (let i = 0, p = off; i < n; i++, p += 4) {
        const o = i << 2;
        out[o] = src[p + 1];
        out[o + 1] = src[p + 2];
        out[o + 2] = src[p + 3];
        out[o + 3] = src[p];
      }
      break;
    case F.BGRA8888:
      if (opts.hdrCompressed) {
        const lut = linearToSrgb8Lut();
        const k = (16 / 255 / 255) * exposure;
        for (let i = 0, p = off; i < n; i++, p += 4) {
          const o = i << 2;
          const s = src[p + 3] * k;
          out[o] = hdrToByte(src[p + 2] * s, lut);
          out[o + 1] = hdrToByte(src[p + 1] * s, lut);
          out[o + 2] = hdrToByte(src[p] * s, lut);
          out[o + 3] = 255;
        }
        alphaCapable = false;
      } else {
        for (let i = 0, p = off; i < n; i++, p += 4) {
          const o = i << 2;
          out[o] = src[p + 2];
          out[o + 1] = src[p + 1];
          out[o + 2] = src[p];
          out[o + 3] = src[p + 3];
        }
      }
      break;
    case F.BGRX8888:
      for (let i = 0, p = off; i < n; i++, p += 4) {
        const o = i << 2;
        out[o] = src[p + 2];
        out[o + 1] = src[p + 1];
        out[o + 2] = src[p];
        out[o + 3] = 255;
      }
      break;
    case F.RGB888:
    case F.RGB888_BLUESCREEN:
    case F.BGR888:
    case F.BGR888_BLUESCREEN: {
      const bgr = format === F.BGR888 || format === F.BGR888_BLUESCREEN;
      const blue = format === F.RGB888_BLUESCREEN || format === F.BGR888_BLUESCREEN;
      for (let i = 0, p = off; i < n; i++, p += 3) {
        const o = i << 2;
        const r = bgr ? src[p + 2] : src[p];
        const g = src[p + 1];
        const b = bgr ? src[p] : src[p + 2];
        if (blue && r === 0 && g === 0 && b === 255) {
          out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
        } else {
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = 255;
        }
      }
      break;
    }
    case F.RGB565:
    case F.BGR565:
      for (let i = 0, p = off; i < n; i++, p += 2) {
        const v = src[p] | (src[p + 1] << 8);
        const lo = v & 31;
        const g = (v >> 5) & 63;
        const hi = (v >> 11) & 31;
        const o = i << 2;
        const lo8 = (lo << 3) | (lo >> 2);
        const hi8 = (hi << 3) | (hi >> 2);
        // Valve names list components from the least significant bits: RGB565 = R in bits 0-4.
        out[o] = format === F.RGB565 ? lo8 : hi8;
        out[o + 1] = (g << 2) | (g >> 4);
        out[o + 2] = format === F.RGB565 ? hi8 : lo8;
        out[o + 3] = 255;
      }
      break;
    case F.BGRX5551:
    case F.BGRA5551:
      for (let i = 0, p = off; i < n; i++, p += 2) {
        const v = src[p] | (src[p + 1] << 8);
        const b = v & 31;
        const g = (v >> 5) & 31;
        const r = (v >> 10) & 31;
        const o = i << 2;
        out[o] = (r << 3) | (r >> 2);
        out[o + 1] = (g << 3) | (g >> 2);
        out[o + 2] = (b << 3) | (b >> 2);
        out[o + 3] = format === F.BGRA5551 ? (v & 0x8000 ? 255 : 0) : 255;
      }
      break;
    case F.BGRA4444:
      for (let i = 0, p = off; i < n; i++, p += 2) {
        const o = i << 2;
        const lo = src[p];
        const hi = src[p + 1];
        out[o] = (hi & 15) * 17;
        out[o + 1] = (lo >> 4) * 17;
        out[o + 2] = (lo & 15) * 17;
        out[o + 3] = (hi >> 4) * 17;
      }
      break;
    case F.I8:
      for (let i = 0, p = off; i < n; i++, p++) {
        const o = i << 2;
        out[o] = out[o + 1] = out[o + 2] = src[p];
        out[o + 3] = 255;
      }
      break;
    case F.IA88:
      for (let i = 0, p = off; i < n; i++, p += 2) {
        const o = i << 2;
        out[o] = out[o + 1] = out[o + 2] = src[p];
        out[o + 3] = src[p + 1];
      }
      break;
    case F.A8:
      for (let i = 0, p = off; i < n; i++, p++) {
        const o = i << 2;
        out[o] = out[o + 1] = out[o + 2] = 255;
        out[o + 3] = src[p];
      }
      break;
    case F.UV88:
      // Signed DuDv / normal offsets: show as a normal-map style colour.
      for (let i = 0, p = off; i < n; i++, p += 2) {
        const o = i << 2;
        out[o] = src[p] ^ 0x80;
        out[o + 1] = src[p + 1] ^ 0x80;
        out[o + 2] = 255;
        out[o + 3] = 255;
      }
      break;
    case F.UVWQ8888:
    case F.UVLX8888:
      for (let i = 0, p = off; i < n; i++, p += 4) {
        const o = i << 2;
        out[o] = src[p] ^ 0x80;
        out[o + 1] = src[p + 1] ^ 0x80;
        out[o + 2] = format === F.UVWQ8888 ? src[p + 2] ^ 0x80 : src[p + 2];
        out[o + 3] = 255;
      }
      break;
    case F.RGBA16161616F: {
      const ht = halfToFloatTable();
      const lut = linearToSrgb8Lut();
      const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      for (let i = 0, p = off; i < n; i++, p += 8) {
        const o = i << 2;
        out[o] = hdrToByte(ht[dv.getUint16(p, true)] * exposure, lut);
        out[o + 1] = hdrToByte(ht[dv.getUint16(p + 2, true)] * exposure, lut);
        out[o + 2] = hdrToByte(ht[dv.getUint16(p + 4, true)] * exposure, lut);
        out[o + 3] = clampByte(ht[dv.getUint16(p + 6, true)] * 255);
      }
      break;
    }
    case F.RGBA16161616: {
      const lut = linearToSrgb8Lut();
      const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      const k = exposure / 65535;
      for (let i = 0, p = off; i < n; i++, p += 8) {
        const o = i << 2;
        out[o] = hdrToByte(dv.getUint16(p, true) * k, lut);
        out[o + 1] = hdrToByte(dv.getUint16(p + 2, true) * k, lut);
        out[o + 2] = hdrToByte(dv.getUint16(p + 4, true) * k, lut);
        out[o + 3] = dv.getUint16(p + 6, true) >> 8;
      }
      break;
    }
    case F.R32F:
    case F.RGB323232F:
    case F.RGBA32323232F: {
      const lut = linearToSrgb8Lut();
      const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
      const ch = format === F.R32F ? 1 : format === F.RGB323232F ? 3 : 4;
      for (let i = 0, p = off; i < n; i++, p += ch * 4) {
        const o = i << 2;
        const r = dv.getFloat32(p, true) * exposure;
        if (ch === 1) {
          out[o] = out[o + 1] = out[o + 2] = hdrToByte(r, lut);
          out[o + 3] = 255;
          continue;
        }
        out[o] = hdrToByte(r, lut);
        out[o + 1] = hdrToByte(dv.getFloat32(p + 4, true) * exposure, lut);
        out[o + 2] = hdrToByte(dv.getFloat32(p + 8, true) * exposure, lut);
        out[o + 3] = ch === 4 ? clampByte(dv.getFloat32(p + 12, true) * 255) : 255;
      }
      break;
    }
    default:
      return null;
  }

  let hasAlpha = false;
  if (alphaCapable) {
    for (let i = 3; i < out.length; i += 4) {
      if (out[i] !== 255) {
        hasAlpha = true;
        break;
      }
    }
  }
  return { width: w, height: h, data: out, hasAlpha };
}

// ------------------------------------------------------------------ resampling

/** Halves an RGBA8 image with a 2x2 box filter (odd edges replicate). */
export function halveImage(img: DecodedImage): DecodedImage {
  const w = Math.max(1, img.width >> 1);
  const h = Math.max(1, img.height >> 1);
  const src = img.data;
  const out = new Uint8Array(w * h * 4);
  const sw = img.width;
  const sh = img.height;
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(sh - 1, y * 2);
    const y1 = Math.min(sh - 1, y * 2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(sw - 1, x * 2);
      const x1 = Math.min(sw - 1, x * 2 + 1);
      const a = (y0 * sw + x0) << 2;
      const b = (y0 * sw + x1) << 2;
      const c = (y1 * sw + x0) << 2;
      const d = (y1 * sw + x1) << 2;
      const o = (y * w + x) << 2;
      for (let k = 0; k < 4; k++) out[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
    }
  }
  return { width: w, height: h, data: out, hasAlpha: img.hasAlpha };
}

// ------------------------------------------------------------------ public decode API

export interface DecodeVtfOptions extends ConvertOptions {
  /** Largest allowed max(width, height) of the returned image (default 2048). */
  maxSize?: number;
  /** Animation frame (default 0, clamped). */
  frame?: number;
  /** Cube map face (default 0, clamped). */
  face?: number;
  /** Volume texture slice (default 0, clamped). */
  slice?: number;
}

/**
 * Decodes the base image of a VTF: the largest mip whose max(w, h) <= maxSize (images without a small enough
 * mip are box-downscaled), frame 0, face 0, slice 0. Returns null (never throws) for invalid/unsupported data.
 */
export function decodeVtf(data: Uint8Array, opts: DecodeVtfOptions = {}): DecodedImage | null {
  try {
    const h = parseVtfHeader(data);
    if (!h) return null;
    return decodeVtfWithHeader(data, h, opts);
  } catch {
    return null;
  }
}

function decodeVtfWithHeader(data: Uint8Array, h: VtfHeader, opts: DecodeVtfOptions): DecodedImage | null {
  const maxSize = Math.max(1, opts.maxSize ?? 2048);
  if (!vtfFormatSupported(h.format)) return null;
  const frame = Math.min(Math.max(0, opts.frame ?? 0), h.frames - 1);
  const face = Math.min(Math.max(0, opts.face ?? 0), h.faces - 1);
  // Prefer the requested mip; if it lies beyond the end of a truncated file, fall back to smaller mips.
  let mip = vtfPickMip(h, maxSize);
  let ref: VtfImageRef | null = null;
  for (; mip < h.mipCount; mip++) {
    ref = vtfImageRef(h, data.length, mip, frame, face, opts.slice ?? 0);
    if (ref) break;
  }
  if (!ref) return null;
  let img = convertVtfImage(h.format, data, ref.offset, ref.width, ref.height, opts);
  if (!img) return null;
  while (Math.max(img.width, img.height) > maxSize && (img.width > 1 || img.height > 1)) img = halveImage(img);
  return img;
}

/**
 * Decodes every animation frame (for AnimatedTexture proxies). At most `maxFrames` frames are returned and the
 * frame size is reduced (by picking a smaller mip) until frames × pixels stays under `maxTotalPixels`.
 */
export function decodeVtfFrames(
  data: Uint8Array,
  opts: DecodeVtfOptions & { maxFrames?: number; maxTotalPixels?: number } = {},
): DecodedImage[] | null {
  try {
    const h = parseVtfHeader(data);
    if (!h) return null;
    const count = Math.min(h.frames, Math.max(1, opts.maxFrames ?? 64));
    const budget = opts.maxTotalPixels ?? 16 * 1024 * 1024;
    let maxSize = Math.max(1, opts.maxSize ?? 2048);
    while (maxSize > 1) {
      const mip = vtfPickMip(h, maxSize);
      const px = Math.max(1, h.width >> mip) * Math.max(1, h.height >> mip);
      if (px * count <= budget) break;
      maxSize >>= 1;
    }
    const frames: DecodedImage[] = [];
    for (let f = 0; f < count; f++) {
      const img = decodeVtfWithHeader(data, h, { ...opts, maxSize, frame: f });
      if (!img) break;
      frames.push(img);
    }
    return frames.length ? frames : null;
  } catch {
    return null;
  }
}

/** Decodes the low-resolution thumbnail (usually 16x16 DXT1), or null. */
export function decodeVtfThumbnail(data: Uint8Array): DecodedImage | null {
  try {
    const h = parseVtfHeader(data);
    if (!h || h.lowResOffset < 0 || h.lowResFormat < 0) return null;
    return convertVtfImage(h.lowResFormat, data, h.lowResOffset, h.lowResWidth, h.lowResHeight);
  } catch {
    return null;
  }
}
