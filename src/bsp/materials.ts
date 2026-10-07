// Material system for BSP maps: resolves every texdata material name to a MaterialDef using the map's
// pakfile (VMT → VTF), and builds convincing procedural stand-ins for stock CS:S / HL2 content that isn't
// packed in the map (we never have the game's VPKs unless the player links them).
//
//   buildMaterials(bsp, pak)     one MaterialDef per texdata name
//   fallbackMaterial(name, ...)  procedural material from a name (+ vrad reflectivity); also used by built-in maps
//   loadSky(skyName, pak)        the six 2D skybox faces (LDR preferred, HDR tone-mapped as a fallback)
//
// Procedural fallbacks: a tileable image whose average colour equals the material's average colour (from the
// texdata reflectivity that vbsp stored, converted from linear to sRGB) with a pattern chosen from the material
// name (concrete speckle, brushed metal, wood planks, brick bond, tiles, glass, grass/dirt/rock noise, dev
// grids...). Everything is deterministic (seeded by the name).
import type { Vec3 } from '../core/vec3';
import type { DecodedImage, MaterialDef, SkyDef } from '../map/types';
import { PakFile, normalizePakPath } from './pakfile';
import {
  BspFile,
  SURF_HINT,
  SURF_NODRAW,
  SURF_NOLIGHT,
  SURF_SKIP,
  SURF_SKY,
  SURF_SKY2D,
  SURF_TRANS,
  SURF_TRIGGER,
  SURF_WARP,
} from './types';
import { decodeVtf, decodeVtfFrames, linearToSrgb, parseVtfHeader, VtfFormat } from './vtf';
import { KeyValues, parseTextureTransform, parseVmt, VmtInfo, vmtBool, vmtNumber, vmtVector } from './vmt';

const CONTENTS_SLIME = 0x10;
const CONTENTS_WATER = 0x20;

// ======================================================================== names & file sources

/** Lower-case, '\' → '/', no leading "materials/" (or "/"), no trailing ".vmt". */
export function normalizeMaterialName(name: string): string {
  let n = normalizePakPath(name ?? '');
  if (n.startsWith('materials/')) n = n.slice('materials/'.length);
  if (n.endsWith('.vmt')) n = n.slice(0, -4);
  return n;
}

/** Normalizes a texture reference from a VMT ($basetexture "Concrete\Wall01.vtf") to "concrete/wall01". */
export function normalizeTextureName(name: string): string {
  let n = normalizeMaterialName(name);
  if (n.endsWith('.vtf')) n = n.slice(0, -4);
  return n;
}

/** Synchronous file source searched for materials/textures (the pakfile, prefetched game content...). */
export interface MaterialFileSource {
  read(path: string): Uint8Array | null;
}

/** Asynchronous file source (e.g. src/maps/vpk.ts GameContent). */
export interface AsyncMaterialFileSource {
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array | null>;
}

/** Wraps a Map of (any-case) paths → bytes as a MaterialFileSource. */
export function mapFileSource(files: Map<string, Uint8Array>): MaterialFileSource {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of files) m.set(normalizePakPath(k), v);
  return { read: (p) => m.get(normalizePakPath(p)) ?? null };
}

function bytesToText(d: Uint8Array): string {
  let start = 0;
  if (d.length >= 3 && d[0] === 0xef && d[1] === 0xbb && d[2] === 0xbf) start = 3;
  let end = d.length;
  while (end > start && d[end - 1] === 0) end--;
  const b = d.subarray(start, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    let s = '';
    for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 4096)));
    return s;
  }
}

class Files {
  private readonly textCache = new Map<string, string | null>();
  constructor(private readonly sources: MaterialFileSource[]) {}

  read(path: string): Uint8Array | null {
    for (const s of this.sources) {
      try {
        const d = s.read(path);
        if (d) return d;
      } catch {
        // a broken source must not break material loading
      }
    }
    return null;
  }

  readText(path: string): string | null {
    const key = normalizePakPath(path);
    if (this.textCache.has(key)) return this.textCache.get(key)!;
    const d = this.read(key);
    const t = d ? bytesToText(d) : null;
    this.textCache.set(key, t);
    return t;
  }
}

function sourcesFor(pak: PakFile | null, extra?: MaterialFileSource[]): MaterialFileSource[] {
  const s: MaterialFileSource[] = [];
  if (pak) s.push(pak);
  if (extra) s.push(...extra);
  return s;
}

// ======================================================================== colour helpers

type RGB = [number, number, number];

function clamp01(x: number): number {
  return x <= 0 || !(x === x) ? 0 : x >= 1 ? 1 : x;
}

/** Linear reflectivity (vrad's average texture colour) → sRGB 0..1. */
export function reflectivityToSrgb(r: Vec3 | [number, number, number]): RGB {
  const v = Array.isArray(r) ? r : [r.x, r.y, r.z];
  return [linearToSrgb(clamp01(v[0])), linearToSrgb(clamp01(v[1])), linearToSrgb(clamp01(v[2]))];
}

/** Average sRGB colour (0..1) of an image, over pixels with alpha >= 128 when any exist (sampled). */
export function imageAverage(img: DecodedImage): RGB {
  const d = img.data;
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 65536));
  let r = 0;
  let g = 0;
  let b = 0;
  let c = 0;
  let r2 = 0;
  let g2 = 0;
  let b2 = 0;
  let c2 = 0;
  for (let i = 0; i < n; i += step) {
    const o = i << 2;
    r2 += d[o];
    g2 += d[o + 1];
    b2 += d[o + 2];
    c2++;
    if (d[o + 3] >= 128) {
      r += d[o];
      g += d[o + 1];
      b += d[o + 2];
      c++;
    }
  }
  if (c === 0) {
    r = r2;
    g = g2;
    b = b2;
    c = Math.max(1, c2);
  }
  return [r / c / 255, g / c / 255, b / c / 255];
}

// ======================================================================== deterministic noise

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Uniform [0,1) from three integers. */
function rnd(a: number, b: number, c: number): number {
  return hash3(a, b, c) / 4294967296;
}

function imod(a: number, m: number): number {
  const r = a % m;
  return r < 0 ? r + m : r;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Tileable value noise on [0,1)² with lattice periods px × py. Returns [0,1]. */
function vnoise(u: number, v: number, px: number, py: number, seed: number): number {
  const x = u * px;
  const y = v * py;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = imod(xi, px);
  const x1 = imod(xi + 1, px);
  const y0 = imod(yi, py);
  const y1 = imod(yi + 1, py);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = rnd(x0, y0, seed);
  const b = rnd(x1, y0, seed);
  const c = rnd(x0, y1, seed);
  const d = rnd(x1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Tileable fractal value noise (period doubles per octave). `yMul` stretches the y period (anisotropy). */
function fbm(u: number, v: number, period: number, octaves: number, seed: number, yMul = 1): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(u, v, p, Math.max(1, Math.round(p * yMul)), seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

interface Cell {
  f1: number;
  f2: number;
  id: number;
}

/** Tileable Worley noise: distances (in cell units) to the nearest and second nearest feature point. */
function worley(u: number, v: number, period: number, seed: number, out: Cell): Cell {
  const x = u * period;
  const y = v * period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = imod(cx, period);
      const wy = imod(cy, period);
      const px = cx + 0.15 + 0.7 * rnd(wx, wy, seed);
      const py = cy + 0.15 + 0.7 * rnd(wx, wy, seed + 1);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = wy * period + wx;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  out.f1 = Math.sqrt(f1);
  out.f2 = Math.sqrt(f2);
  out.id = id;
  return out;
}

// ======================================================================== material families

export type MaterialFamily =
  | 'concrete'
  | 'plaster'
  | 'metal'
  | 'wood'
  | 'brick'
  | 'tile'
  | 'stone'
  | 'stonewall'
  | 'grass'
  | 'dirt'
  | 'sand'
  | 'marble'
  | 'carpet'
  | 'glass'
  | 'grate'
  | 'fence'
  | 'ladder'
  | 'dev'
  | 'light'
  | 'water'
  | 'flat'
  | 'generic'
  // built-in map patterns
  | 'grid'
  | 'ramp'
  | 'floor'
  | 'wall'
  | 'glow';

const BUILTIN_COLORS: Record<string, RGB> = {
  cyan: [0.1, 0.78, 0.86],
  blue: [0.16, 0.38, 0.9],
  red: [0.86, 0.18, 0.16],
  green: [0.22, 0.78, 0.3],
  orange: [0.95, 0.52, 0.12],
  purple: [0.56, 0.3, 0.86],
  pink: [0.95, 0.42, 0.72],
  yellow: [0.95, 0.84, 0.2],
  white: [0.88, 0.88, 0.88],
  dark: [0.16, 0.17, 0.19],
  grey: [0.5, 0.5, 0.52],
  gray: [0.5, 0.5, 0.52],
  black: [0.04, 0.04, 0.05],
};

/** Typical colours used when no reflectivity is known. */
const FAMILY_COLORS: Record<MaterialFamily, RGB> = {
  concrete: [0.55, 0.54, 0.52],
  plaster: [0.72, 0.69, 0.64],
  metal: [0.5, 0.52, 0.54],
  wood: [0.5, 0.36, 0.23],
  brick: [0.56, 0.32, 0.25],
  tile: [0.72, 0.72, 0.7],
  stone: [0.48, 0.45, 0.41],
  stonewall: [0.5, 0.47, 0.43],
  grass: [0.3, 0.42, 0.18],
  dirt: [0.42, 0.33, 0.24],
  sand: [0.74, 0.65, 0.48],
  marble: [0.78, 0.76, 0.73],
  carpet: [0.45, 0.2, 0.18],
  glass: [0.55, 0.65, 0.7],
  grate: [0.45, 0.45, 0.45],
  fence: [0.55, 0.56, 0.57],
  ladder: [0.45, 0.45, 0.45],
  dev: [0.85, 0.5, 0.15],
  light: [0.97, 0.96, 0.92],
  water: [0.16, 0.3, 0.36],
  flat: [0.6, 0.6, 0.6],
  generic: [0.55, 0.55, 0.55],
  grid: [0.5, 0.5, 0.52],
  ramp: [0.5, 0.5, 0.52],
  floor: [0.32, 0.33, 0.35],
  wall: [0.46, 0.47, 0.5],
  glow: [0.9, 0.9, 0.9],
};

const BUILTIN_PATTERNS: MaterialFamily[] = ['grid', 'ramp', 'floor', 'wall', 'glow'];

/** Picks a procedural family from a (normalized) material or texture name. */
export function classifyMaterial(name: string): MaterialFamily {
  const n = normalizeMaterialName(name);
  if (n.startsWith('builtin/')) {
    const words = n.slice(8).split(/[/_\-\s.]+/);
    for (const p of BUILTIN_PATTERNS) if (words.includes(p)) return p;
    return 'grid';
  }
  const t = (re: RegExp) => re.test(n);
  if (t(/glass|window(?!frame)|windshield/)) return 'glass';
  if (t(/ladder/)) return 'ladder';
  if (t(/chainlink|fence/)) return 'fence';
  if (t(/grate|grating|mesh|catwalk|(^|\/)\{/)) return 'grate';
  if (t(/water|liquid|slime|lava|swamp|sewage/)) return 'water';
  if (t(/(^|\/)dev\/|(^|\/)dev_|measuregeneric|measurewall|measurecrate/)) return 'dev';
  if (t(/(^|\/)lights?\/|fluorescent|lightpanel|light_panel/)) return 'light';
  if (t(/brick/)) return 'brick';
  if (t(/tile|bathroom/)) return 'tile';
  if (t(/(^|\/)wood\/|wood|plank|shingle|crate|parquet|bark/)) return 'wood';
  if (t(/marble/)) return 'marble';
  if (t(/carpet|(^|[/_])rug|fabric|cloth/)) return 'carpet';
  if (t(/metal|steel|iron|hull|pipe|citadel|alum|chrome|rust|duct|vent|copper|brass|corrugat/)) return 'metal';
  if (t(/stonewall|cobble|cbble|cellarwall|castle|stonebrick|flagstone|stoneblock/)) return 'stonewall';
  if (t(/stone|rock|cliff|boulder|granite|basalt|crag|mountain/)) return 'stone';
  if (t(/sand|beach|dune|desert/)) return 'sand';
  if (t(/grass|moss|lawn|hedge|foliage|leaves|turf/)) return 'grass';
  if (t(/dirt|mud|ground|soil|gravel|earth|terrain|blend|forest/)) return 'dirt';
  if (t(/plaster|stucco|drywall|paint/)) return 'plaster';
  if (t(/concrete|cement|asphalt|road|pavement|sidewalk|curb|wall|floor|ceiling|pillar|column/)) return 'concrete';
  if (t(/(^|[/_])(white|black|grey|gray|colou?rs?|neon|solid|plain|flat|red|green|blue|yellow|orange|purple|pink|cyan)(\d|_|\/|$)/)) {
    return 'flat';
  }
  return 'generic';
}

/** Colour word of a built-in material name ("builtin/ramp_cyan" → cyan), or null. */
function builtinColor(name: string): RGB | null {
  const words = normalizeMaterialName(name).split(/[/_\-\s.]+/);
  for (const w of words) if (BUILTIN_COLORS[w]) return BUILTIN_COLORS[w];
  return null;
}

// ======================================================================== procedural images

interface Px {
  m: number;
  r: number;
  g: number;
  b: number;
  desat: number;
  a: number;
}

type ShadeFn = (u: number, v: number, x: number, y: number, W: number, H: number, s: number, p: Px, name: string) => void;

const cellTmp: Cell = { f1: 0, f2: 0, id: 0 };

function metalBase(u: number, v: number, x: number, y: number, s: number): number {
  const streak = fbm(u, v, 2, 4, s, 24);
  return 1 + 0.25 * (streak - 0.5) + 0.18 * (fbm(u, v, 3, 3, s + 5) - 0.5) + 0.04 * (rnd(x, y, s + 3) - 0.5);
}

const SHADERS: Record<MaterialFamily, ShadeFn> = {
  concrete(u, v, x, y, W, H, s, p) {
    let m = 1 + 0.3 * (fbm(u, v, 4, 5, s) - 0.5) + 0.16 * (fbm(u, v, 32, 2, s + 7) - 0.5) + 0.07 * (rnd(x, y, s + 3) - 0.5);
    if (rnd(x, y, s + 11) < 0.015) m *= 0.8;
    const st = fbm(u, v, 2, 3, s + 21);
    if (st > 0.6) m *= 1 - (st - 0.6) * 0.3;
    p.m = m;
  },
  plaster(u, v, x, y, W, H, s, p) {
    p.m = 1 + 0.2 * (fbm(u, v, 3, 4, s) - 0.5) + 0.06 * (fbm(u, v, 24, 2, s + 4) - 0.5) + 0.05 * (rnd(x, y, s + 3) - 0.5);
  },
  metal(u, v, x, y, W, H, s, p, name) {
    let m = metalBase(u, v, x, y, s);
    const pu = Math.floor(u * 2);
    const pv = Math.floor(v * 2);
    m *= 1 + 0.07 * (rnd(pu, pv, s + 9) - 0.5);
    const lx = frac(u * 2);
    const ly = frac(v * 2);
    const ex = Math.min(lx, 1 - lx) * (W / 2);
    const ey = Math.min(ly, 1 - ly) * (H / 2);
    const e = Math.min(ex, ey);
    if (e < 1) m *= 0.55;
    else if (e < 2) m *= 1.12;
    else if (/floor|tread|diamond|plate/.test(name)) {
      // diamond tread plate
      const cu = frac(u * 12);
      const cv = frac(v * 12);
      const par = (Math.floor(u * 12) + Math.floor(v * 12)) & 1;
      const a = par ? cu - cv : cu + cv - 1;
      const b = par ? cu + cv - 1 : cu - cv;
      const q = (a / 0.55) * (a / 0.55) + (b / 0.16) * (b / 0.16);
      if (q < 1) m *= 1.1 + 0.1 * (b < 0 ? 1 : -1) * (1 - q);
    } else {
      // rivets near panel corners
      const rx = Math.min(ex, (W / 2) - ex);
      const ry = Math.min(ey, (H / 2) - ey);
      const dx = Math.min(lx, 1 - lx) * (W / 2) - 6;
      const dy = Math.min(ly, 1 - ly) * (H / 2) - 6;
      if (rx >= 0 && ry >= 0 && dx * dx + dy * dy < 4) m *= dy < 0 ? 1.25 : 0.8;
    }
    p.m = m;
    p.desat = 0.1;
  },
  wood(u, v, x, y, W, H, s, p, name) {
    const N = /shingle|roof/.test(name) ? 8 : 4;
    const k = Math.floor(v * N);
    const vy = v * N - k;
    const tone = 1 + 0.16 * (rnd(k, 0, s + 1) - 0.5);
    const grain = 0.5 + 0.5 * Math.sin(2 * Math.PI * (vy * 5 + 3 * fbm(u, v, 2, 4, s + 13 + k * 31, 4)));
    let m = tone * (1 + 0.18 * (grain - 0.5) + 0.1 * (fbm(u, v, 4, 3, s + 3, 16) - 0.5) + 0.04 * (rnd(x, y, s + 5) - 0.5));
    const py = vy * (H / N);
    if (py < 1 || H / N - py < 1) m *= 0.45;
    const joints = N > 4 ? 2 : 1;
    for (let j = 0; j < joints; j++) {
      const ju = frac(rnd(k, 1 + j, s + 2) + j / joints);
      let du = Math.abs(u - ju);
      du = Math.min(du, 1 - du) * W;
      if (du < 1) m *= 0.5;
    }
    p.m = m;
    p.r = 1 + 0.04 * (grain - 0.5);
  },
  brick(u, v, x, y, W, H, s, p) {
    const R = Math.max(2, Math.round((12 * H) / W / 2) * 2);
    const C = Math.max(1, Math.round((3 * W) / H)) || 3;
    const rowF = v * R;
    const row = Math.floor(rowF);
    const cu = u * C + (row & 1 ? 0.5 : 0);
    const col = imod(Math.floor(cu), C);
    const lx = frac(cu);
    const ly = rowF - row;
    const mt = Math.max(1, W / 128);
    const pxX = Math.min(lx, 1 - lx) * (W / C);
    const pxY = Math.min(ly, 1 - ly) * (H / R);
    if (pxX < mt || pxY < mt) {
      p.m = 1.35 + 0.1 * (rnd(x, y, s + 4) - 0.5);
      p.desat = 0.7;
      return;
    }
    const id = col * 977 + row;
    const tone = 1 + 0.22 * (rnd(id, 0, s) - 0.5);
    let m = tone * (1 + 0.16 * (fbm(u, v, 16, 3, s + 6) - 0.5) + 0.08 * (rnd(x, y, s + 8) - 0.5));
    if (pxX < mt + 1.5 || pxY < mt + 1.5) m *= 0.9;
    p.m = m;
    p.r = 1 + 0.08 * (rnd(id, 1, s) - 0.5);
    p.b = 1 - 0.05 * (rnd(id, 2, s) - 0.5);
  },
  tile(u, v, x, y, W, H, s, p, name) {
    const T = /wall/.test(name) ? 8 : 4;
    const TX = T;
    const TY = Math.max(1, Math.round((T * H) / W));
    const lx = frac(u * TX);
    const ly = frac(v * TY);
    const cw = W / TX;
    const ch = H / TY;
    const gw = Math.max(1, W / 170);
    const gx = Math.min(lx, 1 - lx) * cw;
    const gy = Math.min(ly, 1 - ly) * ch;
    if (gx < gw || gy < gw) {
      p.m = 0.62 + 0.06 * (rnd(x, y, s + 2) - 0.5);
      p.desat = 0.6;
      return;
    }
    const tone = 1 + 0.07 * (rnd(Math.floor(u * TX), Math.floor(v * TY), s) - 0.5);
    let m = tone * (1 + 0.06 * (fbm(u, v, 8, 3, s + 5) - 0.5) + 0.03 * (rnd(x, y, s + 7) - 0.5));
    if (lx * cw < gw + 2 || ly * ch < gw + 2) m *= 1.07;
    else if ((1 - lx) * cw < gw + 2 || (1 - ly) * ch < gw + 2) m *= 0.93;
    p.m = m;
  },
  stone(u, v, x, y, W, H, s, p) {
    const n = fbm(u, v, 3, 6, s);
    const ridged = 1 - Math.abs(2 * fbm(u, v, 4, 5, s + 5) - 1);
    let m = 1 + 0.45 * (n - 0.5) + 0.12 * (fbm(u, v, 16, 3, s + 9) - 0.5) + 0.06 * (rnd(x, y, s + 2) - 0.5);
    m *= 1 + 0.08 * Math.sin(2 * Math.PI * (v * 4 + 0.8 * n));
    m *= 1 - 0.35 * smoothstep(0.88, 0.97, ridged);
    p.m = m;
  },
  stonewall(u, v, x, y, W, H, s, p, name) {
    const P = /cobble|cbble/.test(name) ? 8 : 5;
    const c = worley(u, v, P, s, cellTmp);
    const edgePx = ((c.f2 - c.f1) * (W / P)) / 2;
    if (edgePx < 1.5) {
      p.m = 0.6 + 0.08 * (rnd(x, y, s + 3) - 0.5);
      p.desat = 0.5;
      return;
    }
    const tone = 1 + 0.26 * (rnd(c.id, 0, s + 1) - 0.5);
    const dome = Math.min(1, edgePx / ((W / P) * 0.25));
    p.m = tone * (0.86 + 0.14 * dome) * (1 + 0.14 * (fbm(u, v, 12, 3, s + 4) - 0.5) + 0.05 * (rnd(x, y, s + 5) - 0.5));
    p.r = 1 + 0.05 * (rnd(c.id, 1, s) - 0.5);
  },
  grass(u, v, x, y, W, H, s, p) {
    const n = fbm(u, v, 6, 4, s);
    const blades = vnoise(u, v, 96, 24, s + 9);
    let m = 1 + 0.4 * (n - 0.5) + 0.3 * (blades - 0.5) + 0.2 * (rnd(x, y, s + 3) - 0.5);
    if (rnd(x, y, s + 13) < 0.03) m *= 0.75;
    const yel = fbm(u, v, 3, 3, s + 17);
    p.m = m;
    p.r = 1 + 0.25 * (yel - 0.5);
    p.b = 1 - 0.15 * (yel - 0.5);
  },
  dirt(u, v, x, y, W, H, s, p) {
    let m = 1 + 0.45 * (fbm(u, v, 5, 5, s) - 0.5) + 0.12 * (rnd(x, y, s + 3) - 0.5) + 0.1 * (fbm(u, v, 20, 2, s + 4) - 0.5);
    const c = worley(u, v, 16, s + 7, cellTmp);
    if (c.f1 < 0.22 && rnd(c.id, 0, s + 8) < 0.5) {
      const shade = rnd(c.id, 1, s + 8) > 0.5 ? 1.2 : 0.8;
      m *= 1 + (shade - 1) * (1 - c.f1 / 0.22);
    }
    p.m = m;
  },
  sand(u, v, x, y, W, H, s, p) {
    p.m =
      1 +
      0.18 * (fbm(u, v, 3, 4, s) - 0.5) +
      0.14 * (rnd(x, y, s + 3) - 0.5) +
      0.06 * Math.sin(2 * Math.PI * (v * 6 + u + 1.5 * fbm(u, v, 2, 2, s + 3)));
  },
  marble(u, v, x, y, W, H, s, p, name) {
    const n = fbm(u, v, 2, 6, s);
    const t = Math.sin(2 * Math.PI * (u + 2 * v + 2.2 * n));
    const vein = Math.pow(1 - Math.abs(t), 10);
    let m = 1 + 0.1 * (fbm(u, v, 6, 3, s + 3) - 0.5) + 0.03 * (rnd(x, y, s + 4) - 0.5) - 0.35 * vein + 0.05 * (n - 0.5);
    if (/floor/.test(name)) {
      const ex = Math.min(frac(u * 2), 1 - frac(u * 2)) * (W / 2);
      const ey = Math.min(frac(v * 2), 1 - frac(v * 2)) * (H / 2);
      if (Math.min(ex, ey) < 1) m *= 0.75;
    }
    p.m = m;
  },
  carpet(u, v, x, y, W, H, s, p) {
    p.m = 1 + 0.12 * (fbm(u, v, 8, 3, s) - 0.5) + 0.22 * (rnd(x, y, s + 3) - 0.5);
  },
  glass(u, v, x, y, W, H, s, p) {
    const n = fbm(u, v, 2, 4, s);
    const band = Math.max(0, Math.sin(2 * Math.PI * (u + v + 0.3 * n)));
    const hl = band * band * band * band;
    p.m = 1 + 0.12 * (n - 0.5) + 0.1 * hl;
    p.a = 255 * (0.38 + 0.12 * (fbm(u, v, 3, 3, s + 5) - 0.5) + 0.15 * hl);
  },
  grate(u, v, x, y, W, H, s, p) {
    const TX = 8;
    const TY = Math.max(1, Math.round((8 * H) / W));
    const lx = frac(u * TX);
    const ly = frac(v * TY);
    const solid = Math.min(lx, 1 - lx) < 0.11 || Math.min(ly, 1 - ly) < 0.11;
    p.m = metalBase(u, v, x, y, s);
    p.a = solid ? 255 : 0;
  },
  fence(u, v, x, y, W, H, s, p) {
    const d1 = frac((u + v) * 12);
    const d2 = frac((u - v) * 12);
    const wire = Math.min(d1, 1 - d1) < 0.06 || Math.min(d2, 1 - d2) < 0.06;
    p.m = 1 + 0.1 * (rnd(x, y, s) - 0.5);
    p.a = wire ? 255 : 0;
  },
  ladder(u, v, x, y, W, H, s, p) {
    const ly = frac(v * 6);
    const rung = ly > 0.4 && ly < 0.58;
    const rail = (u > 0.06 && u < 0.16) || (u > 0.84 && u < 0.94);
    p.m = metalBase(u, v, x, y, s) * (rung && ly < 0.45 ? 1.15 : 1);
    p.a = rung || rail ? 255 : 0;
  },
  dev(u, v, x, y, W, H, s, p) {
    const dMinor = Math.min(Math.min(frac(u * 16), 1 - frac(u * 16)) * (W / 16), Math.min(frac(v * 16), 1 - frac(v * 16)) * (H / 16));
    const dMajor = Math.min(Math.min(frac(u * 4), 1 - frac(u * 4)) * (W / 4), Math.min(frac(v * 4), 1 - frac(v * 4)) * (H / 4));
    let m = 1 + 0.02 * (rnd(x, y, s) - 0.5);
    if (dMajor < 1.5) m *= 0.72;
    else if (dMinor < 0.75) m *= 0.86;
    p.m = m;
  },
  light(u, v, x, y, W, H, s, p) {
    const c = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
    let m = 1 + 0.06 * (1 - c);
    const e = Math.min(Math.min(u, 1 - u) * W, Math.min(v, 1 - v) * H);
    if (e < W / 32) m *= 0.85;
    p.m = m;
  },
  water(u, v, x, y, W, H, s, p) {
    const n = fbm(u, v, 3, 4, s);
    const c = 1 - Math.abs(2 * fbm(u, v, 6, 3, s + 5) - 1);
    p.m = 1 + 0.25 * (n - 0.5) + 0.25 * Math.pow(c, 6);
    p.b = 1.02;
  },
  flat(u, v, x, y, W, H, s, p) {
    p.m = 1 + 0.04 * (fbm(u, v, 4, 3, s) - 0.5) + 0.015 * (rnd(x, y, s) - 0.5);
  },
  generic(u, v, x, y, W, H, s, p) {
    p.m = 1 + 0.22 * (fbm(u, v, 4, 5, s) - 0.5) + 0.08 * (fbm(u, v, 16, 2, s + 5) - 0.5) + 0.06 * (rnd(x, y, s + 3) - 0.5);
  },
  grid(u, v, x, y, W, H, s, p) {
    const lw = Math.max(1, W / 256);
    const dMinor = Math.min(Math.min(frac(u * 8), 1 - frac(u * 8)) * (W / 8), Math.min(frac(v * 8), 1 - frac(v * 8)) * (H / 8));
    const dBorder = Math.min(Math.min(u, 1 - u) * W, Math.min(v, 1 - v) * H);
    let m = 1 + 0.03 * (fbm(u, v, 4, 3, s) - 0.5) + 0.01 * (rnd(x, y, s) - 0.5);
    if (dBorder < 2 * lw) m *= 1.5;
    else if (dMinor < lw) m *= 1.3;
    p.m = m;
  },
  ramp(u, v, x, y, W, H, s, p) {
    let m = 1 + 0.06 * (fbm(u, v, 3, 4, s) - 0.5) + 0.06 * Math.cos(2 * Math.PI * v) + 0.01 * (rnd(x, y, s) - 0.5);
    const d = Math.min(frac(u * 4), 1 - frac(u * 4)) * (W / 4);
    if (d < Math.max(1, W / 256)) m *= 1.12;
    p.m = m;
  },
  floor(u, v, x, y, W, H, s, p) {
    const lx = frac(u * 4);
    const ly = frac(v * 4);
    const e = Math.min(Math.min(lx, 1 - lx) * (W / 4), Math.min(ly, 1 - ly) * (H / 4));
    let m = (1 + 0.04 * (rnd(Math.floor(u * 4), Math.floor(v * 4), s) - 0.5)) * (1 + 0.05 * (fbm(u, v, 8, 3, s + 2) - 0.5));
    if (e < Math.max(1, W / 256)) m *= 0.72;
    else if (e < Math.max(1, W / 256) + 2) m *= 1.05;
    p.m = m;
  },
  wall(u, v, x, y, W, H, s, p) {
    const lx = frac(u * 2);
    const ly = frac(v * 2);
    const e = Math.min(Math.min(lx, 1 - lx) * (W / 2), Math.min(ly, 1 - ly) * (H / 2));
    let m = 1 + 0.12 * (fbm(u, v, 4, 4, s) - 0.5) + 0.03 * (rnd(x, y, s + 1) - 0.5);
    if (e < Math.max(1, W / 256)) m *= 0.7;
    p.m = m;
  },
  glow(u, v, x, y, W, H, s, p) {
    const e = Math.min(Math.min(u, 1 - u) * W, Math.min(v, 1 - v) * H);
    p.m = (1 + 0.02 * (fbm(u, v, 4, 2, s) - 0.5)) * (e < W / 32 ? 1.08 : 1);
  },
};

/** Pixel buffers created by generateProceduralImage (lets callers tell real textures from stand-ins). */
const PROCEDURAL = new WeakSet<Uint8Array>();

export interface ProceduralOptions {
  family: MaterialFamily;
  /** Target average colour, sRGB 0..1 (over opaque pixels). */
  color: RGB;
  /** Seed (e.g. hashString(name)). */
  seed: number;
  width?: number;
  height?: number;
  /** Name, used for sub-variants (tile walls, wood shingles, metal tread...). */
  name?: string;
}

/**
 * Generates a tileable procedural texture whose average colour (over pixels with alpha >= 128) equals
 * `color`. Glass gets partial alpha (~0.4), grates/fences/ladders get binary alpha for alpha testing.
 */
export function generateProceduralImage(opts: ProceduralOptions): DecodedImage {
  const W = Math.max(4, Math.min(1024, opts.width ?? 256));
  const H = Math.max(4, Math.min(1024, opts.height ?? 256));
  const shade = SHADERS[opts.family] ?? SHADERS.generic;
  const name = opts.name ?? '';
  const seed = opts.seed | 0;
  const n = W * H;
  const target = [clamp01(opts.color[0]) * 255, clamp01(opts.color[1]) * 255, clamp01(opts.color[2]) * 255];
  const tl = (0.2126 * target[0] + 0.7152 * target[1] + 0.0722 * target[2]) / 255;
  // Bright colours have no headroom: reduce the pattern contrast so it doesn't clip into a flat white.
  const contrast = tl > 0.7 ? Math.max(0.35, 1 - (tl - 0.7) * 2.2) : 1;
  const rgb = new Float32Array(n * 3);
  const alpha = new Uint8Array(n);
  const p: Px = { m: 1, r: 1, g: 1, b: 1, desat: 0, a: 255 };
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      p.m = 1;
      p.r = 1;
      p.g = 1;
      p.b = 1;
      p.desat = 0;
      p.a = 255;
      shade(u, v, x, y, W, H, seed, p, name);
      const i = y * W + x;
      const m = 1 + (p.m - 1) * contrast;
      let r = target[0] * m * (1 + (p.r - 1) * contrast);
      let g = target[1] * m * (1 + (p.g - 1) * contrast);
      let b = target[2] * m * (1 + (p.b - 1) * contrast);
      if (p.desat > 0) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r += (l - r) * p.desat;
        g += (l - g) * p.desat;
        b += (l - b) * p.desat;
      }
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
      alpha[i] = p.a <= 0 ? 0 : p.a >= 255 ? 255 : Math.round(p.a);
    }
  }
  // Normalize the mean over "visible" pixels to the target: two multiplicative passes, then an additive one.
  let weightSum = 0;
  for (let i = 0; i < n; i++) if (alpha[i] >= 128) weightSum++;
  const useAll = weightSum === 0;
  const visible = (i: number) => useAll || alpha[i] >= 128;
  const means = (): number[] => {
    let r = 0;
    let g = 0;
    let b = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (!visible(i)) continue;
      r += Math.min(255, Math.max(0, rgb[i * 3]));
      g += Math.min(255, Math.max(0, rgb[i * 3 + 1]));
      b += Math.min(255, Math.max(0, rgb[i * 3 + 2]));
      c++;
    }
    c = Math.max(1, c);
    return [r / c, g / c, b / c];
  };
  for (let pass = 0; pass < 3; pass++) {
    const mean = means();
    for (let ch = 0; ch < 3; ch++) {
      const k = mean[ch] > 1e-6 ? target[ch] / mean[ch] : 1;
      for (let i = ch; i < n * 3; i += 3) rgb[i] = Math.min(255, Math.max(0, rgb[i] * k));
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    const mean = means();
    for (let ch = 0; ch < 3; ch++) {
      const d = target[ch] - mean[ch];
      if (Math.abs(d) < 0.05) continue;
      for (let i = ch; i < n * 3; i += 3) rgb[i] = Math.min(255, Math.max(0, rgb[i] + d));
    }
  }
  const data = new Uint8Array(n * 4);
  let hasAlpha = false;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = alpha[i];
    if (a < 128 && !useAll && a === 0) {
      // Fully transparent texels carry the average colour so filtering doesn't produce dark fringes.
      data[o] = Math.round(target[0]);
      data[o + 1] = Math.round(target[1]);
      data[o + 2] = Math.round(target[2]);
    } else {
      data[o] = Math.round(rgb[i * 3]);
      data[o + 1] = Math.round(rgb[i * 3 + 1]);
      data[o + 2] = Math.round(rgb[i * 3 + 2]);
    }
    data[o + 3] = a;
    if (a !== 255) hasAlpha = true;
  }
  PROCEDURAL.add(data);
  return { width: W, height: H, data, hasAlpha };
}

// ======================================================================== material classification

/** Per-texdata information derived from the BSP (texinfo flags, brush contents). */
export interface SurfaceHints {
  /** OR of the SURF_* flags of every texinfo using this texdata. */
  orFlags: number;
  /** AND of the SURF_* flags of every texinfo using this texdata (0 when unused). */
  andFlags: number;
  /** Number of texinfos using it. */
  texinfoCount: number;
  /** Used on a side of a water/slime brush. */
  onWaterBrush: boolean;
}

/** Computes SurfaceHints for every texdata of a BSP. */
export function computeSurfaceHints(bsp: BspFile): SurfaceHints[] {
  const n = bsp.texdata.length;
  const hints: SurfaceHints[] = [];
  for (let i = 0; i < n; i++) hints.push({ orFlags: 0, andFlags: 0, texinfoCount: 0, onWaterBrush: false });
  for (const ti of bsp.texinfo) {
    const h = hints[ti.texData];
    if (!h) continue;
    h.andFlags = h.texinfoCount === 0 ? ti.flags : h.andFlags & ti.flags;
    h.orFlags |= ti.flags;
    h.texinfoCount++;
  }
  for (const br of bsp.brushes) {
    if (!(br.contents & (CONTENTS_WATER | CONTENTS_SLIME))) continue;
    for (let s = br.firstSide; s < br.firstSide + br.numSides; s++) {
      const side = bsp.brushSides[s];
      if (!side || side.texInfo < 0) continue;
      const ti = bsp.texinfo[side.texInfo];
      const h = ti && hints[ti.texData];
      if (h) h.onWaterBrush = true;
    }
  }
  return hints;
}

const TOOL_COMPILE_KEYS = [
  '%compilenodraw',
  '%compileclip',
  '%compileplayerclip',
  '%compilenpcclip',
  '%compiletrigger',
  '%compileskip',
  '%compilehint',
  '%compileinvisible',
  '%compileorigin',
  '%compileareaportal',
  '%compileoccluder',
  '%compilefog',
  '%compilegrenadeclip',
  '%compiledroneclip',
];

const UNLIT_SHADERS = new Set([
  'unlitgeneric',
  'unlittwotexture',
  'sky',
  'sprite',
  'spritecard',
  'modulate',
  'monitorscreen',
  'wireframe',
  'refract',
  'screenspace_general',
  'teeth', // never on world faces; harmless
]);

function isSkyName(n: string): boolean {
  return n === 'tools/toolsskybox' || n === 'tools/toolsskybox2d' || n.startsWith('skybox/');
}

function isToolName(n: string): boolean {
  return n.startsWith('tools/') && !n.startsWith('tools/toolsskybox') && n !== 'tools/toolsblack' && n !== 'tools/toolsblack_noportal';
}

function isDecalName(n: string): boolean {
  return n.startsWith('decals/') || n.startsWith('overlays/') || /(^|\/)decal|decal(\d|_|$)/.test(n);
}

const TOOL_SURF = SURF_NODRAW | SURF_TRIGGER | SURF_SKIP | SURF_HINT;

function baseDef(name: string, width: number, height: number): MaterialDef {
  return {
    name,
    shader: '',
    image: null,
    fallbackColor: [0.5, 0.5, 0.5],
    width,
    height,
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
  };
}

function procSizeFor(family: MaterialFamily, texW: number, texH: number): [number, number] {
  const base = family === 'flat' || family === 'light' || family === 'glow' ? 64 : 256;
  const w = texW > 0 ? texW : 512;
  const h = texH > 0 ? texH : 512;
  if (w === h) return [base, base];
  if (w > h) return [base, Math.max(16, Math.min(base, pow2(Math.round((base * h) / w))))];
  return [Math.max(16, Math.min(base, pow2(Math.round((base * w) / h)))), base];
}

function pow2(x: number): number {
  return 1 << Math.max(0, Math.round(Math.log2(Math.max(1, x))));
}

function defaultWaterFog(color: RGB): RGB {
  // Murky blue-green derived from the surface colour.
  return [color[0] * 0.5 + 0.03, color[1] * 0.6 + 0.07, color[2] * 0.6 + 0.09];
}

interface FallbackInputs {
  /** Name used for family heuristics (texture or included material name). */
  hintName: string;
  reflectivity?: Vec3 | null;
  hints?: SurfaceHints | null;
  /** True when no VMT was available (flags come from heuristics/hints). */
  noVmt: boolean;
}

/**
 * Builds a procedural MaterialDef for `name`. Flags come from the name (tools, sky, water, glass, lights,
 * grates) and, for BSP materials, from the texinfo flags (`hints`).
 */
function proceduralMaterial(def: MaterialDef, inp: FallbackInputs): MaterialDef {
  const n = def.name;
  const hn = inp.hintName || n;
  const family = classifyMaterial(hn);
  const hints = inp.hints;

  // ---- colour
  let color: RGB;
  const bc = n.startsWith('builtin/') ? builtinColor(n) : null;
  if (bc) color = [...bc];
  else if (inp.reflectivity) color = reflectivityToSrgb(inp.reflectivity);
  else color = [...FAMILY_COLORS[family]];
  if (family === 'light' && color[0] + color[1] + color[2] < 0.15) color = [...FAMILY_COLORS.light];
  def.fallbackColor = color;

  if (inp.noVmt) {
    if (isSkyName(n) || (hints && hints.orFlags & (SURF_SKY | SURF_SKY2D))) def.isSky = true;
    else if (n === 'tools/toolsblack' || n === 'tools/toolsblack_noportal') {
      def.unlit = true;
      def.fallbackColor = [0, 0, 0];
    } else if (isToolName(n) || (hints && hints.texinfoCount > 0 && hints.andFlags & TOOL_SURF)) def.isTool = true;
    else if (isDecalName(n) || isDecalName(hn)) def.isTool = true; // missing overlay/decal art: don't draw a grey quad
    else {
      if (family === 'water' || (hints && (hints.orFlags & SURF_WARP || hints.onWaterBrush))) def.isWater = true;
      if (family === 'glass') def.translucent = true;
      if (family === 'grate' || family === 'fence' || family === 'ladder') def.alphaTest = true;
      else if (hints && hints.orFlags & SURF_TRANS && !def.isWater) def.translucent = true;
      if (family === 'light' || family === 'glow') def.unlit = true;
      if (hints && hints.texinfoCount > 0 && hints.andFlags & SURF_NOLIGHT && !def.isWater) def.unlit = true;
      if (def.isWater) {
        def.translucent = true;
        def.waterFogColor = defaultWaterFog(color);
      }
    }
  }
  if (def.isTool || def.isSky) return def;

  // ---- image
  let fam = family;
  if (def.isWater && fam !== 'water') fam = 'water';
  if (def.translucent && !def.isWater && fam !== 'glass' && inp.noVmt) {
    // Unknown translucent material: show it as a tinted, partly transparent pane.
    fam = 'glass';
  }
  if (bc === null && n.startsWith('builtin/') && fam !== 'glow') {
    // builtin name without a colour word: keep the family colour
  }
  const [w, h] = procSizeFor(fam, def.width, def.height);
  const img = generateProceduralImage({ family: fam, color: def.fallbackColor, seed: hashString(n), width: w, height: h, name: hn });
  def.image = img;
  if (BUILTIN_PATTERNS.includes(family)) def.pattern = family;
  return def;
}

/**
 * Procedural material for a name that has no VMT/texture (stock CS:S/HL2 content, built-in maps).
 * `reflectivity` is the linear average colour vbsp stored in the texdata. Built-in names like
 * "builtin/ramp_cyan", "builtin/floor_dark", "builtin/wall_grid", "builtin/glow_green" pick a colour word
 * (cyan blue red green orange purple pink yellow white dark grey) and a pattern (grid ramp floor wall glow).
 */
export function fallbackMaterial(name: string, reflectivity?: Vec3, width?: number, height?: number): MaterialDef {
  const n = normalizeMaterialName(name);
  const def = baseDef(n, width && width > 0 ? width : 512, height && height > 0 ? height : 512);
  proceduralMaterial(def, { hintName: n, reflectivity: reflectivity ?? null, noVmt: true });
  if (def.pattern === 'glow') def.unlit = true;
  return def;
}

// ======================================================================== texture loading

interface TexCache {
  images: Map<string, DecodedImage | null>;
}

function vtfPath(tex: string): string {
  return `materials/${normalizeTextureName(tex)}.vtf`;
}

function loadTexture(files: Files, cache: TexCache, tex: string, maxSize: number): DecodedImage | null {
  if (!tex) return null;
  const path = vtfPath(tex);
  if (cache.images.has(path)) return cache.images.get(path)!;
  const data = files.read(path);
  const img = data ? decodeVtf(data, { maxSize }) : null;
  cache.images.set(path, img);
  return img;
}

/** Multiplies an image's colour by `tint` (sRGB-space multiply ≈ Source's gamma-space $color). */
function tintImage(img: DecodedImage, tint: number[]): DecodedImage {
  const out = new Uint8Array(img.data.length);
  const tr = Math.max(0, tint[0]);
  const tg = Math.max(0, tint[1]);
  const tb = Math.max(0, tint[2]);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    out[i] = Math.min(255, Math.round(d[i] * tr));
    out[i + 1] = Math.min(255, Math.round(d[i + 1] * tg));
    out[i + 2] = Math.min(255, Math.round(d[i + 2] * tb));
    out[i + 3] = d[i + 3];
  }
  return { width: img.width, height: img.height, data: out, hasAlpha: img.hasAlpha };
}

function proxyBlock(proxies: KeyValues | null, name: string): KeyValues | null {
  if (!proxies) return null;
  const v = proxies[name];
  return typeof v === 'object' && v !== null ? v : null;
}

function kvString(kv: KeyValues | null, key: string): string | undefined {
  if (!kv) return undefined;
  const v = kv[key];
  return typeof v === 'string' ? v : undefined;
}

/** [u, v] scroll per second from a TextureScroll proxy (rate in texture units/s, angle in degrees). */
function textureScroll(proxies: KeyValues | null, vars: string[]): [number, number] | null {
  const ts = proxyBlock(proxies, 'texturescroll');
  if (!ts) return null;
  const target = (kvString(ts, 'texturescrollvar') ?? '').trim().toLowerCase();
  if (!vars.includes(target)) return null;
  const rate = vmtNumber(kvString(ts, 'texturescrollrate'), 1);
  const angle = vmtNumber(kvString(ts, 'texturescrollangle'), 0);
  if (!rate) return null;
  const a = (angle * Math.PI) / 180;
  const su = Math.cos(a) * rate;
  const sv = Math.sin(a) * rate;
  return [Math.abs(su) < 1e-9 ? 0 : su, Math.abs(sv) < 1e-9 ? 0 : sv];
}

function isIdentityTransform(m: number[]): boolean {
  return Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && Math.abs(m[3]) < 1e-6 && Math.abs(m[4] - 1) < 1e-6 && Math.abs(m[5]) < 1e-6;
}

// ======================================================================== buildMaterials

export interface BuildMaterialsOptions {
  /** Largest texture dimension kept (bigger textures use a smaller mip). Default 2048. */
  maxTextureSize?: number;
  /** Extra sources searched after the pakfile (e.g. prefetched game content, see prefetchMaterialFiles). */
  extraSources?: MaterialFileSource[];
  /** Decode $detail textures (default true). */
  detailTextures?: boolean;
  /** Decode AnimatedTexture frames (default true). */
  animatedTextures?: boolean;
}

interface BuildContext {
  files: Files;
  cache: TexCache;
  maxSize: number;
  detail: boolean;
  animated: boolean;
}

/** Result statistics of the last buildMaterials call (for diagnostics / tests). */
export interface MaterialStats {
  total: number;
  withVmt: number;
  withImage: number;
  procedural: number;
  tools: number;
  sky: number;
  water: number;
  missingIncludes: number;
}

function buildMaterial(
  ctx: BuildContext,
  name: string,
  texW: number,
  texH: number,
  reflectivity: Vec3 | null,
  hints: SurfaceHints | null,
): { def: MaterialDef; info: VmtInfo | null } {
  const def = baseDef(name, texW > 0 ? texW : 512, texH > 0 ? texH : 512);
  const files = ctx.files;
  const text = files.readText(`materials/${name}.vmt`);
  const info = text != null ? parseVmt(text, (p) => files.readText(p)) : null;

  // A patch whose base material isn't available behaves like a missing VMT for the base's name.
  const resolved = info && info.shader && info.shader !== 'patch' ? info : null;
  const hintName = info?.includeMissing ? normalizeMaterialName(info.includeMissing) : name;
  if (!resolved) {
    proceduralMaterial(def, { hintName, reflectivity, hints, noVmt: true });
    // Patch params (insert/replace) of a missing include still count (rare: $basetexture overrides).
    const bt = info?.params['$basetexture'];
    if (bt && !def.isTool && !def.isSky) {
      const img = loadTexture(files, ctx.cache, bt, ctx.maxSize);
      if (img) {
        def.image = img;
        def.fallbackColor = imageAverage(img);
      }
    }
    return { def, info };
  }

  const P = resolved.params;
  const shader = resolved.shader;
  def.shader = shader;

  // ---- classification
  const compileWater = vmtBool(P['%compilewater']) || vmtBool(P['%compileslime']);
  const compileSky = vmtBool(P['%compilesky']) || vmtBool(P['%compile2dsky']);
  const compileTool = TOOL_COMPILE_KEYS.some((k) => vmtBool(P[k]));
  def.isSky = isSkyName(name) || compileSky;
  def.isWater = !def.isSky && (shader === 'water' || compileWater);
  def.isTool = !def.isSky && !def.isWater && (isToolName(name) || compileTool);
  if (name === 'tools/toolsblack' || name === 'tools/toolsblack_noportal') def.isTool = false;

  def.translucent = vmtBool(P['$translucent']);
  def.additive = vmtBool(P['$additive']);
  def.alphaTest = vmtBool(P['$alphatest']);
  const ref = vmtNumber(P['$alphatestreference'], 0.5);
  def.alphaTestRef = clamp01(ref);
  def.alpha = clamp01(vmtNumber(P['$alpha'], 1));
  if (def.alpha < 1) def.translucent = true;
  def.noCull = vmtBool(P['$nocull']);
  def.unlit = UNLIT_SHADERS.has(shader) || vmtBool(P['$selfillum']) || name === 'tools/toolsblack';
  if (shader === 'refract') {
    def.translucent = true;
    if (!P['$alpha']) def.alpha = 0.35;
  }

  const scrollVars = shader === 'refract' ? ['$basetexturetransform', '$bumptransform'] : ['$basetexturetransform'];
  def.scroll = textureScroll(resolved.proxies, scrollVars);
  const tt = parseTextureTransform(P['$basetexturetransform']);
  if (tt && !isIdentityTransform(tt)) def.textureTransform = tt;

  if (def.isWater) {
    def.translucent = true;
    const fog = vmtVector(P['$fogcolor']);
    def.waterFogColor = fog ? [clamp01(fog[0]), clamp01(fog[1]), clamp01(fog[2])] : null;
  }

  if (def.isTool || def.isSky) {
    def.fallbackColor = reflectivity ? reflectivityToSrgb(reflectivity) : [0.5, 0.5, 0.5];
    if (name === 'tools/toolsblack') def.fallbackColor = [0, 0, 0];
    return { def, info };
  }

  // ---- base texture
  let baseTex = P['$basetexture'] ?? '';
  let image = baseTex ? loadTexture(files, ctx.cache, baseTex, ctx.maxSize) : null;
  if (!image) {
    // HDR / DX9 fallback blocks may point somewhere else than the root parameter.
    const root = resolved.body?.['$basetexture'];
    if (typeof root === 'string' && root !== baseTex) {
      const img = loadTexture(files, ctx.cache, root, ctx.maxSize);
      if (img) {
        image = img;
        baseTex = root;
      }
    }
  }

  // AnimatedTexture proxy on the base texture.
  const anim = proxyBlock(resolved.proxies, 'animatedtexture');
  if (image && ctx.animated && anim && (kvString(anim, 'animatedtexturevar') ?? '').trim().toLowerCase() === '$basetexture') {
    const data = files.read(vtfPath(baseTex));
    const h = data ? parseVtfHeader(data) : null;
    if (data && h && h.frames > 1) {
      const frames = decodeVtfFrames(data, { maxSize: ctx.maxSize });
      if (frames && frames.length > 1) {
        image = frames[0];
        def.frames = frames;
        def.frameRate = vmtNumber(kvString(anim, 'animatedtextureframerate'), 15);
      }
    }
  }

  const tint = vmtVector(P['$color']);
  const hasTint = !!tint && (Math.abs(tint[0] - 1) > 1e-3 || Math.abs(tint[1] - 1) > 1e-3 || Math.abs(tint[2] - 1) > 1e-3);

  if (image) {
    if (hasTint) {
      image = tintImage(image, tint!);
      if (def.frames) def.frames = def.frames.map((f) => tintImage(f, tint!));
    }
    // For opaque materials the alpha channel is a mask (self-illum, envmap...), not transparency.
    if (image.hasAlpha && !def.translucent && !def.alphaTest) image = { ...image, hasAlpha: false };
    def.image = image;
    def.fallbackColor = imageAverage(image);
  } else {
    // Texture not packed: procedural stand-in named after the texture (better family hints than the material).
    const texName = baseTex ? normalizeTextureName(baseTex) : name;
    const fam = classifyMaterial(texName);
    let color: RGB = reflectivity ? reflectivityToSrgb(reflectivity) : [...FAMILY_COLORS[fam]];
    if (fam === 'light' && color[0] + color[1] + color[2] < 0.15) color = [...FAMILY_COLORS.light];
    if (hasTint && !reflectivity) color = [clamp01(color[0] * tint![0]), clamp01(color[1] * tint![1]), clamp01(color[2] * tint![2])];
    def.fallbackColor = color;
    let pfam: MaterialFamily = fam;
    if (def.isWater) pfam = 'water';
    else if (shader === 'refract') pfam = 'glass';
    else if (def.translucent && fam !== 'glass' && !def.alphaTest) pfam = 'glass';
    else if (def.alphaTest && fam !== 'grate' && fam !== 'fence' && fam !== 'ladder') pfam = 'grate';
    if (shader === 'refract') {
      const rt = vmtVector(P['$refracttint']);
      if (rt) def.fallbackColor = color = [clamp01(rt[0] * 0.85), clamp01(rt[1] * 0.85), clamp01(rt[2] * 0.9)];
      else def.fallbackColor = color = [0.75, 0.82, 0.88];
    }
    if (def.isWater) {
      // Water has no albedo texture in Source; derive the look from the fog colour when present.
      if (def.waterFogColor) {
        const f = def.waterFogColor;
        def.fallbackColor = color = [clamp01(f[0] * 1.6 + 0.04), clamp01(f[1] * 1.6 + 0.06), clamp01(f[2] * 1.6 + 0.08)];
      }
      if (!def.waterFogColor) def.waterFogColor = defaultWaterFog(color);
    }
    const [w, h] = procSizeFor(pfam, def.width, def.height);
    def.image = generateProceduralImage({ family: pfam, color, seed: hashString(texName), width: w, height: h, name: texName });
    if (!def.translucent && !def.alphaTest && def.image.hasAlpha) def.image = { ...def.image, hasAlpha: false };
  }

  // ---- WorldVertexTransition second texture (displacement blend)
  if (shader === 'worldvertextransition' || P['$basetexture2']) {
    const t2 = P['$basetexture2'];
    if (t2) {
      let img2 = loadTexture(files, ctx.cache, t2, ctx.maxSize);
      const t2name = normalizeTextureName(t2);
      if (img2) {
        if (hasTint) img2 = tintImage(img2, tint!);
        if (img2.hasAlpha) img2 = { ...img2, hasAlpha: false };
        def.image2 = img2;
        def.fallbackColor2 = imageAverage(img2);
      } else {
        const fam2 = classifyMaterial(t2name);
        const c2: RGB = [...FAMILY_COLORS[fam2]];
        def.fallbackColor2 = c2;
        const [w, h] = procSizeFor(fam2, def.width, def.height);
        const g = generateProceduralImage({ family: fam2, color: c2, seed: hashString(t2name), width: w, height: h, name: t2name });
        def.image2 = { ...g, hasAlpha: false };
      }
      const tt2 = parseTextureTransform(P['$basetexturetransform2']);
      if (tt2 && !isIdentityTransform(tt2)) def.textureTransform2 = tt2;
    }
  }

  // ---- detail texture
  if (ctx.detail && P['$detail']) {
    const dimg = loadTexture(files, ctx.cache, P['$detail'], Math.min(ctx.maxSize, 1024));
    if (dimg) {
      const sc = vmtVector(P['$detailscale'], 2) ?? [4, 4];
      def.detail = {
        image: dimg,
        scale: [sc[0] || 4, sc[1] || sc[0] || 4],
        blendFactor: clamp01(vmtNumber(P['$detailblendfactor'], 1)),
        blendMode: Math.max(0, Math.round(vmtNumber(P['$detailblendmode'], 0))),
      };
    }
  }

  return { def, info };
}

let lastStats: MaterialStats | null = null;

/** Statistics of the most recent buildMaterials() call. */
export function lastMaterialStats(): MaterialStats | null {
  return lastStats;
}

/**
 * Builds one MaterialDef per texdata material name (keyed by normalizeMaterialName). Uses the pakfile's VMTs
 * and VTFs (and `opts.extraSources`); materials whose textures aren't available get procedural images.
 */
export function buildMaterials(bsp: BspFile, pak: PakFile | null, opts: BuildMaterialsOptions = {}): Map<string, MaterialDef> {
  const ctx: BuildContext = {
    files: new Files(sourcesFor(pak, opts.extraSources)),
    cache: { images: new Map() },
    maxSize: Math.max(1, opts.maxTextureSize ?? 2048),
    detail: opts.detailTextures ?? true,
    animated: opts.animatedTextures ?? true,
  };
  let hints: SurfaceHints[] = [];
  try {
    hints = computeSurfaceHints(bsp);
  } catch {
    hints = [];
  }
  const out = new Map<string, MaterialDef>();
  const stats: MaterialStats = { total: 0, withVmt: 0, withImage: 0, procedural: 0, tools: 0, sky: 0, water: 0, missingIncludes: 0 };
  const names = bsp.texdataNames ?? [];
  for (let i = 0; i < Math.max(names.length, bsp.texdata.length); i++) {
    const raw = names[i];
    if (raw == null) continue;
    const name = normalizeMaterialName(raw);
    if (!name || out.has(name)) continue;
    const td = bsp.texdata[i];
    let def: MaterialDef;
    let info: VmtInfo | null = null;
    try {
      const r = buildMaterial(ctx, name, td?.width ?? 0, td?.height ?? 0, td ? td.reflectivity : null, hints[i] ?? null);
      def = r.def;
      info = r.info;
    } catch {
      def = fallbackMaterial(name, td?.reflectivity, td?.width, td?.height);
    }
    out.set(name, def);
    stats.total++;
    if (info) stats.withVmt++;
    if (info?.includeMissing) stats.missingIncludes++;
    if (def.isTool) stats.tools++;
    else if (def.isSky) stats.sky++;
    if (def.isWater) stats.water++;
    if (def.image) {
      if (isProceduralImage(def.image)) stats.procedural++;
      else stats.withImage++;
    }
  }
  lastStats = stats;
  return out;
}

/** True when `img` was produced by the procedural generator (not decoded from a real texture). */
export function isProceduralImage(img: DecodedImage | null | undefined): boolean {
  return !!img && PROCEDURAL.has(img.data);
}

// ======================================================================== sky

const SKY_SUFFIXES = ['rt', 'lf', 'bk', 'ft', 'up', 'dn'] as const;
type SkySuffix = (typeof SKY_SUFFIXES)[number];

export interface LoadSkyOptions {
  extraSources?: MaterialFileSource[];
  /** Largest face size (default 2048). All faces are resampled to one common square size. */
  maxSize?: number;
}

/** Bilinear sample with clamp addressing; u,v in [0,1] over the image. Writes RGBA into out[o..]. */
function sampleClamp(img: DecodedImage, u: number, v: number, out: Uint8Array, o: number): void {
  const w = img.width;
  const h = img.height;
  const x = Math.min(w - 1, Math.max(0, u * w - 0.5));
  const y = Math.min(h - 1, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = img.data;
  const a = (y0 * w + x0) << 2;
  const b = (y0 * w + x1) << 2;
  const c = (y1 * w + x0) << 2;
  const e = (y1 * w + x1) << 2;
  for (let k = 0; k < 4; k++) {
    const top = d[a + k] + (d[b + k] - d[a + k]) * fx;
    const bot = d[c + k] + (d[e + k] - d[c + k]) * fx;
    out[o + k] = Math.round(top + (bot - top) * fy);
  }
}

/** Area-averaging downscale when shrinking a lot, bilinear otherwise; applies an optional UV transform. */
function resampleFace(img: DecodedImage, size: number, transform: number[] | null): DecodedImage {
  let src = img;
  // Pre-shrink by halving while the source is more than 2x the target (keeps bilinear sampling alias-free).
  while (!transform && (src.width >= size * 2 || src.height >= size * 2) && src.width > 1 && src.height > 1) {
    src = halve(src);
  }
  if (!transform && src.width === size && src.height === size) return { ...src, data: src.data.slice(), hasAlpha: false };
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      let su = u;
      let sv = v;
      if (transform) {
        su = transform[0] * u + transform[1] * v + transform[2];
        sv = transform[3] * u + transform[4] * v + transform[5];
      }
      sampleClamp(src, su, sv, out, (y * size + x) << 2);
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { width: size, height: size, data: out, hasAlpha: false };
}

function halve(img: DecodedImage): DecodedImage {
  const w = Math.max(1, img.width >> 1);
  const h = Math.max(1, img.height >> 1);
  const out = new Uint8Array(w * h * 4);
  const sw = img.width;
  const sh = img.height;
  const s = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(sh - 1, 2 * y);
    const y1 = Math.min(sh - 1, 2 * y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(sw - 1, 2 * x);
      const x1 = Math.min(sw - 1, 2 * x + 1);
      const o = (y * w + x) << 2;
      const a = (y0 * sw + x0) << 2;
      const b = (y0 * sw + x1) << 2;
      const c = (y1 * sw + x0) << 2;
      const d = (y1 * sw + x1) << 2;
      for (let k = 0; k < 4; k++) out[o + k] = (s[a + k] + s[b + k] + s[c + k] + s[d + k] + 2) >> 2;
    }
  }
  return { width: w, height: h, data: out, hasAlpha: img.hasAlpha };
}

interface SkyFaceSrc {
  img: DecodedImage;
  transform: number[] | null;
}

function loadSkyFace(files: Files, base: string, suffix: SkySuffix, maxSize: number, allowHdr: boolean): SkyFaceSrc | null {
  const vmt = files.readText(`materials/skybox/${base}${suffix}.vmt`);
  const info = vmt != null ? parseVmt(vmt, (p) => files.readText(p)) : null;
  const P = info?.params ?? {};
  const transform = parseTextureTransform(P['$basetexturetransform']);
  const tf = transform && !isIdentityTransform(transform) ? transform : null;
  const tryTex = (tex: string | undefined, hdrCompressed: boolean | 'auto'): DecodedImage | null => {
    if (!tex) return null;
    const data = files.read(vtfPath(tex));
    if (!data) return null;
    const h = parseVtfHeader(data);
    if (!h) return null;
    const compressed = hdrCompressed === 'auto' ? h.format === VtfFormat.BGRA8888 && /_hdr/.test(normalizeTextureName(tex)) : hdrCompressed;
    return decodeVtf(data, { maxSize, hdrCompressed: compressed });
  };
  const ldrCandidates = [P['$basetexture'], `skybox/${base}${suffix}`];
  for (const c of ldrCandidates) {
    const img = tryTex(c, 'auto');
    if (img) return { img, transform: tf };
  }
  if (!allowHdr) return null;
  const hdrCandidates: [string | undefined, boolean | 'auto'][] = [
    [P['$hdrbasetexture'], false],
    [P['$hdrcompressedtexture'], true],
  ];
  for (const [c, comp] of hdrCandidates) {
    const img = tryTex(c, comp);
    if (img) return { img, transform: tf };
  }
  return null;
}

/**
 * Loads the six skybox faces "materials/skybox/<sky><rt|lf|bk|ft|up|dn>.vmt" (→ $basetexture, default
 * "skybox/<sky><suffix>"). LDR textures are preferred; HDR ones ($hdrbasetexture float, $hdrcompressedtexture
 * BGRA8888 with rgb·a·16 scaling, or "<sky>_hdr<suffix>" materials) are tone-mapped. $basetexturetransform
 * (e.g. "scale 1 2" half-height side textures) is applied. All faces are resampled to one square size.
 * A missing "dn" face is synthesized from the average of the side faces' bottom rows. faces is null unless
 * rt, lf, bk, ft and up are available.
 */
export function loadSky(skyName: string, pak: PakFile | null, opts: LoadSkyOptions = {}): SkyDef {
  const result: SkyDef = { name: skyName, faces: null };
  try {
    const name = normalizePakPath(skyName ?? '').replace(/^materials\//, '').replace(/^skybox\//, '').replace(/\.vmt$/, '');
    if (!name) return result;
    const files = new Files(sourcesFor(pak, opts.extraSources));
    const maxSize = Math.max(1, opts.maxSize ?? 2048);
    const ldrBase = name.endsWith('_hdr') ? name.slice(0, -4) : name;
    const bases = [ldrBase, `${ldrBase}_hdr`];
    const srcs: Partial<Record<SkySuffix, SkyFaceSrc>> = {};
    for (const suffix of SKY_SUFFIXES) {
      let face: SkyFaceSrc | null = null;
      // LDR first across both naming schemes, then HDR.
      for (const allowHdr of [false, true]) {
        for (const b of bases) {
          face = loadSkyFace(files, b, suffix, maxSize, allowHdr);
          if (face) break;
        }
        if (face) break;
      }
      if (face) srcs[suffix] = face;
    }
    if (!srcs.rt || !srcs.lf || !srcs.bk || !srcs.ft || !srcs.up) return result;

    // Common square size: the largest face dimension (after transforms), capped.
    let size = 1;
    for (const s of Object.values(srcs)) {
      if (!s) continue;
      size = Math.max(size, s.img.width, s.img.height);
    }
    size = Math.min(size, maxSize);
    const faces: Partial<Record<SkySuffix, DecodedImage>> = {};
    for (const suffix of SKY_SUFFIXES) {
      const s = srcs[suffix];
      if (s) faces[suffix] = resampleFace(s.img, size, s.transform);
    }
    if (!faces.dn) {
      // Synthesize the bottom face from the bottom rows of the four sides.
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      const rows = Math.max(1, Math.floor(size / 16));
      for (const k of ['rt', 'lf', 'bk', 'ft'] as const) {
        const f = faces[k]!;
        for (let y = size - rows; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const o = (y * size + x) << 2;
            r += f.data[o];
            g += f.data[o + 1];
            b += f.data[o + 2];
            c++;
          }
        }
      }
      const data = new Uint8Array(size * size * 4);
      const rr = Math.round(r / c);
      const gg = Math.round(g / c);
      const bb = Math.round(b / c);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = rr;
        data[i + 1] = gg;
        data[i + 2] = bb;
        data[i + 3] = 255;
      }
      faces.dn = { width: size, height: size, data, hasAlpha: false };
    }
    result.faces = faces as NonNullable<SkyDef['faces']>;
    return result;
  } catch {
    return result;
  }
}

// ======================================================================== optional game content prefetch

/** Texture/material paths referenced by a parsed VMT (base textures, detail, includes). */
function vmtDependencies(info: VmtInfo): string[] {
  const out: string[] = [];
  const P = info.params;
  for (const k of ['$basetexture', '$basetexture2', '$detail', '$hdrbasetexture', '$hdrcompressedtexture']) {
    if (P[k]) out.push(vtfPath(P[k]));
  }
  const root = info.body?.['$basetexture'];
  if (typeof root === 'string') out.push(vtfPath(root));
  return out;
}

/**
 * Fetches, from `content` (e.g. the player's linked CS:S/CS:GO VPKs), every file buildMaterials/loadSky would
 * need that the pakfile doesn't have: VMTs, patch includes, base/blend/detail textures and sky faces.
 * Pass the result as `extraSources: [mapFileSource(result)]`.
 */
export async function prefetchMaterialFiles(
  bsp: BspFile,
  pak: PakFile | null,
  content: AsyncMaterialFileSource,
  skyName?: string,
): Promise<Map<string, Uint8Array>> {
  const got = new Map<string, Uint8Array>();
  const pakHas = (p: string) => !!pak && pak.has(p);
  const sync: MaterialFileSource = {
    read: (p) => (pak ? pak.read(p) : null) ?? got.get(normalizePakPath(p)) ?? null,
  };
  const files = () => new Files([sync]);
  let pending = new Set<string>();
  const want = (p: string) => {
    const k = normalizePakPath(p);
    if (!pakHas(k) && !got.has(k) && content.has(k)) pending.add(k);
  };
  const vmtPaths: string[] = [];
  for (const raw of bsp.texdataNames ?? []) {
    const n = normalizeMaterialName(raw);
    if (n) vmtPaths.push(`materials/${n}.vmt`);
  }
  const sky = skyName ? normalizePakPath(skyName).replace(/^skybox\//, '') : '';
  if (sky) {
    const base = sky.endsWith('_hdr') ? sky.slice(0, -4) : sky;
    for (const b of [base, `${base}_hdr`]) {
      for (const s of SKY_SUFFIXES) {
        vmtPaths.push(`materials/skybox/${b}${s}.vmt`);
        want(`materials/skybox/${b}${s}.vtf`);
      }
    }
  }
  for (const p of vmtPaths) want(p);
  const seenVmts = new Set<string>();
  for (let round = 0; round < 6; round++) {
    // Fetch everything pending.
    const list = [...pending];
    pending = new Set();
    await Promise.all(
      list.map(async (p) => {
        try {
          const d = await content.read(p);
          if (d) got.set(p, d);
        } catch {
          // ignore unreadable files
        }
      }),
    );
    // Parse every reachable VMT and queue its dependencies.
    const f = files();
    for (const p of [...vmtPaths, ...[...got.keys()].filter((k) => k.endsWith('.vmt'))]) {
      const key = normalizePakPath(p);
      const text = f.readText(key);
      if (text == null || seenVmts.has(key)) continue;
      const missing: string[] = [];
      const info = parseVmt(text, (inc) => {
        const t = f.readText(inc);
        if (t == null) missing.push(inc);
        return t;
      });
      if (info.includeMissing) {
        // Try the include again next round once fetched.
        let inc = normalizePakPath(info.includeMissing);
        if (!inc.endsWith('.vmt')) inc += '.vmt';
        if (!inc.startsWith('materials/')) inc = `materials/${inc}`;
        want(inc);
        continue;
      }
      seenVmts.add(key);
      for (const dep of vmtDependencies(info)) want(dep);
    }
    if (!pending.size) break;
  }
  return got;
}
