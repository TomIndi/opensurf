// Baked lightmaps: decoding vrad's ColorRGBExp32 samples and packing every lit face into one atlas.
//
// Format (public bspfile.h documentation): each lit face stores, per light style, (w+1)*(h+1) samples where
// (w, h) = lightmapTextureSizeInLuxels; SURF_BUMPLIGHT faces store four lightmaps per style (the unbumped one
// first, then the three bump basis directions). A sample is 4 bytes: r, g, b (u8) and a signed exponent (i8);
// the linear light is c * 2^exp / 255, where 1.0 means "fully lit" (albedo is multiplied by it, values above 1
// are overbright). Samples sit at integer luxel coordinates: luxel (s, t) of a face is at lightmap-space
// position (mins[0] + s, mins[1] + t).
//
// Atlas layout: every face gets a rect of (w+1) x (h+1) sample texels plus a 1-texel border that replicates
// the edge samples, so bilinear filtering never bleeds a neighbour's light into a face. Rects are packed with
// a skyline bottom-left packer (sorted by height) into an atlas of at most maxSize x maxSize (default 4096).
// Texel (x, y) lives at data[(y * width + x) * 4] and is sampled at uv ((x + 0.5) / width, (y + 0.5) / height)
// (row 0 at v = 0: upload without flipping).
//
// Overflow handling: when the rects do not fit into maxSize x maxSize even at the widest atlas, every face's
// lightmap is resampled at half the luxel density (then a quarter, ...) - each face keeps its own rect, it
// only has fewer texels, and lightmapUV() maps luxel coordinates through the per-face scale. The real KSF maps
// need at most ~2048 x 2048, so this only kicks in for pathological inputs.
import type { LightmapAtlas } from '../map/types';
import { BspFace, BspFile, LUMP_FACES, LUMP_FACES_HDR, SURF_BUMPLIGHT } from './types';

/** Linear light per ColorRGBExp32 exponent byte (index = unsigned byte): 2^(signed exponent) / 255. */
const EXP_SCALE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = Math.pow(2, i < 128 ? i : i - 256) / 255;
  return t;
})();

/** Writes the linear RGB of the ColorRGBExp32 sample at `src[o..o+3]` into `out[oo..oo+2]`. */
export function decodeRgbExp32(src: Uint8Array, o: number, out: Float32Array | number[], oo: number): void {
  const k = EXP_SCALE[src[o + 3]];
  out[oo] = src[o] * k;
  out[oo + 1] = src[o + 1] * k;
  out[oo + 2] = src[o + 2] * k;
}

/** Linear value of one ColorRGBExp32 channel (c in 0..255, exp signed). */
export function rgbExp32Channel(c: number, exp: number): number {
  return (c * Math.pow(2, exp)) / 255;
}

// ------------------------------------------------------------------------------------------ light source

/** The lighting lump the faces' lightOfs index, plus per-face offset overrides. */
export interface LightingSource {
  data: Uint8Array;
  hdr: boolean;
  /**
   * Per-face light offsets to use instead of face.lightOfs (only when the LDR face lump came with HDR-only
   * lighting and the HDR face lump - whose offsets index the HDR lump - was read for its offsets), else null.
   */
  offsets: Int32Array | null;
}

const FACE_SIZE = 56;

/**
 * Picks the lighting lump that matches `bsp.faces`: LDR faces use the LDR lighting lump, faces read from
 * LUMP_FACES_HDR use the HDR lump. When the LDR faces exist but only HDR lighting was compiled (or
 * `preferHdr` asks for HDR), the HDR face lump's light offsets are used (same face order), or the LDR offsets
 * as a last resort. Null without lighting.
 */
export function selectLightingSource(bsp: BspFile, preferHdr = false): LightingSource | null {
  const facesLump = bsp.facesLump ?? LUMP_FACES;
  const ldr = bsp.lighting && bsp.lighting.length > 0 ? bsp.lighting : null;
  const hdr = bsp.lightingHDR && bsp.lightingHDR.length > 0 ? bsp.lightingHDR : null;
  if (facesLump === LUMP_FACES_HDR) return hdr ? { data: hdr, hdr: true, offsets: null } : null;
  if (ldr && !(preferHdr && hdr)) return { data: ldr, hdr: false, offsets: null };
  if (!hdr) return null;
  // LDR faces with HDR lighting: take the offsets from the HDR face lump when it matches.
  let hdrFaces: Uint8Array;
  try {
    hdrFaces = bsp.getLump(LUMP_FACES_HDR);
  } catch {
    hdrFaces = new Uint8Array(0);
  }
  if (hdrFaces.length === bsp.faces.length * FACE_SIZE && hdrFaces.length > 0) {
    const dv = new DataView(hdrFaces.buffer, hdrFaces.byteOffset, hdrFaces.byteLength);
    const offsets = new Int32Array(bsp.faces.length);
    for (let i = 0; i < offsets.length; i++) offsets[i] = dv.getInt32(i * FACE_SIZE + 20, true);
    return { data: hdr, hdr: true, offsets };
  }
  if (ldr) return { data: ldr, hdr: false, offsets: null }; // no HDR offsets to pair with: stay LDR
  return { data: hdr, hdr: true, offsets: null };
}

/** Light offset of face `f` in `src` (-1 when unlit). */
export function faceLightOffset(src: LightingSource, bsp: BspFile, f: number): number {
  return src.offsets ? src.offsets[f] : bsp.faces[f].lightOfs;
}

/** Largest supported lightmap side in samples (vrad's limit is far lower; guards against corrupt faces). */
export const MAX_LUXELS_PER_SIDE = 1024;

/**
 * Byte offset of face `f`'s style-0 lightmap (the unbumped one for bump-lit faces) in `src.data`, or -1 when
 * the face has no usable lighting (no offset, bad size, data out of range). Faces whose first style is not 0
 * (only switchable/animated lights reach them) use their first style - those lights start on by default.
 */
export function faceLightmapOffset(src: LightingSource, bsp: BspFile, f: number, texFlags: number): number {
  const face: BspFace | undefined = bsp.faces[f];
  if (!face) return -1;
  const ofs = faceLightOffset(src, bsp, f);
  if (!(ofs >= 0)) return -1;
  const w = face.lightmapTextureSizeInLuxels[0] + 1;
  const h = face.lightmapTextureSizeInLuxels[1] + 1;
  if (!(w >= 1 && h >= 1 && w <= MAX_LUXELS_PER_SIDE && h <= MAX_LUXELS_PER_SIDE)) return -1;
  const perStyle = (texFlags & SURF_BUMPLIGHT ? 4 : 1) * w * h * 4;
  let slot = 0;
  for (let k = 0; k < 4; k++) {
    if (face.styles[k] === 0) {
      slot = k;
      break;
    }
    if (face.styles[k] === 255) break;
  }
  const start = ofs + slot * perStyle;
  if (start + w * h * 4 > src.data.length) return -1;
  return start;
}

// ------------------------------------------------------------------------------------------ packing

/**
 * Skyline bottom-left rectangle packer. The skyline is a list of horizontal segments covering [0, width);
 * a rect goes where its bottom is lowest (ties: leftmost).
 */
export class SkylinePacker {
  private xs: number[] = [0];
  private ys: number[] = [0];
  private ws: number[];
  /** Highest used y (the packed height). */
  usedHeight = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.ws = [width];
  }

  /** Places a w x h rect; returns its top-left corner, or null when it doesn't fit. */
  insert(w: number, h: number): { x: number; y: number } | null {
    if (w <= 0 || h <= 0 || w > this.width || h > this.height) return null;
    const xs = this.xs;
    const ys = this.ys;
    const ws = this.ws;
    const n = xs.length;
    let bestI = -1;
    let bestX = 0;
    let bestY = Infinity;
    for (let i = 0; i < n; i++) {
      const x = xs[i];
      if (x + w > this.width) break;
      // lowest y at which the rect rests on the segments spanning [x, x + w)
      let y = 0;
      let left = w;
      for (let j = i; left > 0 && j < n; j++) {
        if (ys[j] > y) y = ys[j];
        if (y >= bestY) break;
        left -= ws[j];
      }
      if (y >= bestY || y + h > this.height) continue;
      bestY = y;
      bestX = x;
      bestI = i;
      if (y === 0) break;
    }
    if (bestI < 0) return null;
    this.place(bestI, bestX, bestY + h, w);
    if (bestY + h > this.usedHeight) this.usedHeight = bestY + h;
    return { x: bestX, y: bestY };
  }

  /** Raises the skyline over [x, x + w) (starting at segment i) to `top`. */
  private place(i: number, x: number, top: number, w: number): void {
    const xs = this.xs;
    const ys = this.ys;
    const ws = this.ws;
    const end = x + w;
    // remove / trim the segments covered by [x, end)
    let j = i;
    while (j < xs.length && xs[j] < end) {
      const segEnd = xs[j] + ws[j];
      if (segEnd <= end) {
        j++;
        continue;
      }
      // partially covered: keep its right part
      ws[j] = segEnd - end;
      xs[j] = end;
      break;
    }
    xs.splice(i, j - i, x);
    ys.splice(i, j - i, top);
    ws.splice(i, j - i, w);
    // merge with equal-height neighbours
    if (i + 1 < xs.length && ys[i + 1] === top) {
      ws[i] += ws[i + 1];
      xs.splice(i + 1, 1);
      ys.splice(i + 1, 1);
      ws.splice(i + 1, 1);
    }
    if (i > 0 && ys[i - 1] === top) {
      ws[i - 1] += ws[i];
      xs.splice(i, 1);
      ys.splice(i, 1);
      ws.splice(i, 1);
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export interface PackResult {
  width: number;
  height: number;
  x: Int32Array;
  y: Int32Array;
}

/**
 * Packs rects (sizes in texels) into the smallest power-of-two width (<= maxSize) whose packing fits in
 * maxSize rows; the height is the used height rounded up to a multiple of 4. Rects are inserted sorted by
 * height (then width), tallest first. Null when they don't fit at maxSize x maxSize.
 */
export function packRects(ws: ArrayLike<number>, hs: ArrayLike<number>, maxSize: number): PackResult | null {
  const n = ws.length;
  let area = 0;
  let maxW = 1;
  let maxH = 1;
  for (let i = 0; i < n; i++) {
    area += ws[i] * hs[i];
    if (ws[i] > maxW) maxW = ws[i];
    if (hs[i] > maxH) maxH = hs[i];
  }
  if (maxW > maxSize || maxH > maxSize) return null;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => hs[b] - hs[a] || ws[b] - ws[a] || a - b);
  let width = Math.min(maxSize, Math.max(16, nextPow2(Math.max(maxW, Math.ceil(Math.sqrt(area / 0.9))))));
  for (;;) {
    const packer = new SkylinePacker(width, maxSize);
    const x = new Int32Array(n);
    const y = new Int32Array(n);
    let ok = true;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const p = packer.insert(ws[i], hs[i]);
      if (!p) {
        ok = false;
        break;
      }
      x[i] = p.x;
      y[i] = p.y;
    }
    if (ok) {
      const height = Math.min(maxSize, Math.max(4, Math.ceil(packer.usedHeight / 4) * 4));
      return { width, height, x, y };
    }
    if (width >= maxSize) return null;
    width = Math.min(maxSize, width * 2);
  }
}

// ------------------------------------------------------------------------------------------ atlas

/** One face's lightmap to place in the atlas. */
export interface LightmapRequest {
  /** Byte offset of the samples in the lighting data (see faceLightmapOffset). */
  offset: number;
  /** Samples per row / column (lightmapTextureSizeInLuxels + 1). */
  w: number;
  h: number;
}

export interface LightmapBuild {
  atlas: LightmapAtlas;
  /** Per request: top-left corner of its rect (the border texel); the first sample is at (x + 1, y + 1). */
  rectX: Int32Array;
  rectY: Int32Array;
  /** Per request: samples stored per row/column in the atlas (== w/h unless reduced for overflow). */
  atlasW: Int32Array;
  atlasH: Int32Array;
  /** 1 normally; 2, 4, ... when every lightmap had to be stored at reduced density (overflow). */
  reduction: number;
  /** Atlas uv of the centre of a block of 1.0 texels (faces without lighting data use it: fullbright). */
  whiteU: number;
  whiteV: number;
}

const WHITE_BLOCK = 4;

function reducedSize(n: number, r: number): number {
  return r <= 1 || n <= 1 ? n : Math.max(2, Math.ceil((n - 1) / r) + 1);
}

/**
 * Decodes and packs the requested lightmaps into one RGBA float atlas (see the file comment for the layout and
 * the overflow handling). Null only when nothing fits even at 1/64 density.
 */
export function buildLightmapAtlas(data: Uint8Array, requests: LightmapRequest[], maxSize = 4096): LightmapBuild | null {
  const n = requests.length;
  maxSize = Math.max(16, Math.floor(maxSize));
  let reduction = 1;
  let pack: PackResult | null = null;
  const aw = new Int32Array(n);
  const ah = new Int32Array(n);
  for (;;) {
    const ws = new Int32Array(n + 1);
    const hs = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      aw[i] = reducedSize(requests[i].w, reduction);
      ah[i] = reducedSize(requests[i].h, reduction);
      ws[i] = aw[i] + 2;
      hs[i] = ah[i] + 2;
    }
    ws[n] = WHITE_BLOCK;
    hs[n] = WHITE_BLOCK;
    pack = packRects(ws, hs, maxSize);
    if (pack) break;
    if (reduction >= 64) return null;
    reduction *= 2;
  }

  const W = pack.width;
  const H = pack.height;
  const out = new Float32Array(W * H * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 1;

  // white block
  {
    const bx = pack.x[n];
    const by = pack.y[n];
    for (let y = 0; y < WHITE_BLOCK; y++) {
      for (let x = 0; x < WHITE_BLOCK; x++) {
        const o = ((by + y) * W + bx + x) * 4;
        out[o] = 1;
        out[o + 1] = 1;
        out[o + 2] = 1;
      }
    }
  }

  let scratch = new Float32Array(0);
  for (let i = 0; i < n; i++) {
    const r = requests[i];
    const rx = pack.x[i];
    const ry = pack.y[i];
    const sw = aw[i];
    const sh = ah[i];
    if (sw === r.w && sh === r.h) {
      // straight copy
      for (let t = 0; t < sh; t++) {
        let so = r.offset + t * r.w * 4;
        let o = ((ry + 1 + t) * W + rx + 1) * 4;
        for (let s = 0; s < sw; s++, so += 4, o += 4) decodeRgbExp32(data, so, out, o);
      }
    } else {
      // reduced density: bilinear resample of the decoded samples at evenly spaced luxel positions
      const need = r.w * r.h * 3;
      if (scratch.length < need) scratch = new Float32Array(need);
      for (let k = 0; k < r.w * r.h; k++) decodeRgbExp32(data, r.offset + k * 4, scratch, k * 3);
      const fx = sw > 1 ? (r.w - 1) / (sw - 1) : 0;
      const fy = sh > 1 ? (r.h - 1) / (sh - 1) : 0;
      for (let t = 0; t < sh; t++) {
        const py = t * fy;
        const y0 = Math.min(Math.floor(py), r.h - 1);
        const y1 = Math.min(y0 + 1, r.h - 1);
        const ty = py - y0;
        for (let s = 0; s < sw; s++) {
          const px = s * fx;
          const x0 = Math.min(Math.floor(px), r.w - 1);
          const x1 = Math.min(x0 + 1, r.w - 1);
          const tx = px - x0;
          const o = ((ry + 1 + t) * W + rx + 1 + s) * 4;
          for (let c = 0; c < 3; c++) {
            const a = scratch[(y0 * r.w + x0) * 3 + c] * (1 - tx) + scratch[(y0 * r.w + x1) * 3 + c] * tx;
            const b = scratch[(y1 * r.w + x0) * 3 + c] * (1 - tx) + scratch[(y1 * r.w + x1) * 3 + c] * tx;
            out[o + c] = a * (1 - ty) + b * ty;
          }
        }
      }
    }
    replicateBorder(out, W, rx, ry, sw, sh);
  }

  return {
    atlas: { width: W, height: H, data: out },
    rectX: pack.x.subarray(0, n),
    rectY: pack.y.subarray(0, n),
    atlasW: aw,
    atlasH: ah,
    reduction,
    whiteU: (pack.x[n] + WHITE_BLOCK / 2) / W,
    whiteV: (pack.y[n] + WHITE_BLOCK / 2) / H,
  };
}

/** Copies the edge samples of the sw x sh block at (rx + 1, ry + 1) into its 1-texel border. */
function replicateBorder(out: Float32Array, W: number, rx: number, ry: number, sw: number, sh: number): void {
  const copy = (dx: number, dy: number, sx: number, sy: number): void => {
    const d = (dy * W + dx) * 4;
    const s = (sy * W + sx) * 4;
    out[d] = out[s];
    out[d + 1] = out[s + 1];
    out[d + 2] = out[s + 2];
  };
  const x0 = rx + 1;
  const y0 = ry + 1;
  const x1 = rx + sw; // last sample column
  const y1 = ry + sh; // last sample row
  for (let t = y0; t <= y1; t++) {
    copy(rx, t, x0, t);
    copy(x1 + 1, t, x1, t);
  }
  for (let s = rx; s <= x1 + 1; s++) {
    copy(s, ry, s, y0);
    copy(s, y1 + 1, s, y1);
  }
}

/**
 * Atlas uv for luxel coordinates (s, t) of request `i` (s = dot(p, lightmapVecs s) + offset - mins[0], in
 * 0..w-1 for points on the face). Luxel s maps to the centre of sample texel (rectX + 1 + s): the first and
 * last samples are hit exactly at their texel centres and points in between interpolate neighbouring samples,
 * just like the engine. s/t are clamped half a texel beyond the edge samples, so the bilinear footprint never
 * leaves the rect (the border replicates the edges).
 */
export function lightmapUV(b: LightmapBuild, i: number, w: number, h: number, s: number, t: number, out: Float32Array, o: number): void {
  const sw = b.atlasW[i];
  const sh = b.atlasH[i];
  let ss = sw === w ? s : w > 1 ? (s * (sw - 1)) / (w - 1) : 0;
  let tt = sh === h ? t : h > 1 ? (t * (sh - 1)) / (h - 1) : 0;
  if (!(ss >= -0.5)) ss = -0.5;
  else if (ss > sw - 0.5) ss = sw - 0.5;
  if (!(tt >= -0.5)) tt = -0.5;
  else if (tt > sh - 0.5) tt = sh - 0.5;
  const atlas = b.atlas;
  out[o] = (b.rectX[i] + 1.5 + ss) / atlas.width;
  out[o + 1] = (b.rectY[i] + 1.5 + tt) / atlas.height;
}
