// Material system for BSP maps: resolves every texdata material name to a MaterialDef using the map's
// pakfile (VMT → VTF), and builds convincing procedural stand-ins for stock CS:S / HL2 content that isn't
// packed in the map (we never have the game's VPKs unless the player links them).
//
//   buildMaterials(bsp, pak, opts?)   one MaterialDef per texdata name (opts: max texture size, extra file
//                                     sources, compressed DXT output, detail/animated textures)
//   MaterialLoader                    the same resolution with shared caches, for any material name (static
//                                     prop materials via loadModelMaterial(name, $cdmaterials))
//   fallbackMaterial(name, ...)       procedural material from a name (+ vrad reflectivity); also used by
//                                     built-in maps ("builtin/ramp_cyan", "builtin/floor_dark", ...)
//   loadSky(skyName, pak)             the six 2D skybox faces (LDR preferred, HDR tone-mapped as a fallback)
//   proceduralSky(skyName)            gradient stand-in for stock skies that aren't packed
//   prefetchMaterialFiles(...)        pulls the files a map needs from linked game content (VPKs)
//
// What a VMT contributes: shader (unlit/water/refract/decal handling), $basetexture (+ $color/$color2 tint,
// $basetexturetransform, AnimatedTexture frames, TextureScroll), $translucent/$additive/$alpha/$alphatest/
// $nocull/$selfillum, water fog colour, WorldVertexTransition's $basetexture2 and $detail. Tool and sky
// materials are recognised by name, %compile* keys and the BSP's texinfo flags. Materials without a VMT (stock
// content) are classified from their name plus texinfo flags (SURF_NOLIGHT → unlit, SURF_TRANS → translucent,
// SURF_WARP / water brushes → water).
//
// Procedural fallbacks: a tileable image whose average colour equals the material's average colour (from the
// texdata reflectivity that vbsp stored, converted from linear to sRGB) with a pattern chosen from the material
// name (concrete formwork panels / floor slabs / ceiling tiles, brushed metal, wood planks, brick bond, tiles,
// glass, grass/dirt/rock, dev grids...). The detail is fine-grained and low in contrast, with no large
// low-frequency blotches: tiled over a big surf wall those read as fog or dirt rather than a surface. Everything is
// deterministic (seeded by the name).
import type { Vec3 } from '../core/vec3';
import type { CubemapDef, DecodedImage, MaterialDef, MaterialEnvmap, SkyDef } from '../map/types';
import { PakFile, normalizePakPath } from './pakfile';
import {
  BspFile,
  LUMP_CUBEMAPS,
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

/**
 * Noise fields for one W×H procedural image. Every field tiles seamlessly (lattice periods wrap) and is
 * evaluated at pixel centres u = (x + 0.5) / W, v = (y + 0.5) / H. Fields are precomputed per image, which
 * keeps the per-pixel shading to a few array reads.
 */
class NoiseFields {
  private readonly cache = new Map<string, Float32Array>();
  constructor(
    readonly W: number,
    readonly H: number,
    readonly seed: number,
  ) {}

  /** Adds amp × value noise with lattice periods px × py into `out`. */
  private addValueNoise(out: Float32Array, px: number, py: number, s: number, amp: number): void {
    const { W, H } = this;
    const lat = new Float32Array(px * py);
    for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) lat[j * px + i] = rnd(i, j, s);
    const x0 = new Int32Array(W);
    const x1 = new Int32Array(W);
    const sx = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const f = ((x + 0.5) / W) * px;
      const xi = Math.floor(f);
      const t = f - xi;
      x0[x] = imod(xi, px);
      x1[x] = imod(xi + 1, px);
      sx[x] = t * t * (3 - 2 * t);
    }
    for (let y = 0; y < H; y++) {
      const f = ((y + 0.5) / H) * py;
      const yi = Math.floor(f);
      const t = f - yi;
      const r0 = imod(yi, py) * px;
      const r1 = imod(yi + 1, py) * px;
      const sy = t * t * (3 - 2 * t);
      let o = y * W;
      for (let x = 0; x < W; x++, o++) {
        const a = lat[r0 + x0[x]];
        const b = lat[r0 + x1[x]];
        const c = lat[r1 + x0[x]];
        const d = lat[r1 + x1[x]];
        const s1 = sx[x];
        out[o] += amp * (a + (b - a) * s1 + (c - a) * sy + (a - b - c + d) * s1 * sy);
      }
    }
  }

  /** Fractal value noise in [0,1]; the period doubles per octave; `yMul` stretches the y period. */
  fbm(period: number, octaves: number, salt: number, yMul = 1): Float32Array {
    const key = `f${period}:${octaves}:${salt}:${yMul}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out = new Float32Array(this.W * this.H);
    let amp = 1;
    let norm = 0;
    let p = period;
    for (let o = 0; o < octaves; o++) {
      this.addValueNoise(out, p, Math.max(1, Math.round(p * yMul)), this.seed + salt + o * 1013, amp);
      norm += amp;
      amp *= 0.5;
      p *= 2;
    }
    const k = 1 / norm;
    for (let i = 0; i < out.length; i++) out[i] *= k;
    this.cache.set(key, out);
    return out;
  }

  /** Single-octave value noise with independent x/y periods. */
  noise(px: number, py: number, salt: number): Float32Array {
    const key = `n${px}:${py}:${salt}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out = new Float32Array(this.W * this.H);
    this.addValueNoise(out, px, py, this.seed + salt, 1);
    this.cache.set(key, out);
    return out;
  }

  /** Per-pixel white noise in [0,1). */
  white(salt: number): Float32Array {
    const key = `w${salt}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out = new Float32Array(this.W * this.H);
    const s = this.seed + salt;
    for (let y = 0, o = 0; y < this.H; y++) for (let x = 0; x < this.W; x++, o++) out[o] = rnd(x, y, s);
    this.cache.set(key, out);
    return out;
  }

  /** Tileable Worley noise: nearest / second-nearest feature distance (cell units) and nearest cell id. */
  worley(period: number, salt: number): { f1: Float32Array; f2: Float32Array; id: Int32Array } {
    const { W, H } = this;
    const s = this.seed + salt;
    const n = period * period;
    const fx = new Float32Array(n);
    const fy = new Float32Array(n);
    for (let j = 0; j < period; j++) {
      for (let i = 0; i < period; i++) {
        fx[j * period + i] = 0.15 + 0.7 * rnd(i, j, s);
        fy[j * period + i] = 0.15 + 0.7 * rnd(i, j, s + 1);
      }
    }
    const f1 = new Float32Array(W * H);
    const f2 = new Float32Array(W * H);
    const id = new Int32Array(W * H);
    for (let y = 0, o = 0; y < H; y++) {
      const py = ((y + 0.5) / H) * period;
      const yi = Math.floor(py);
      for (let x = 0; x < W; x++, o++) {
        const px = ((x + 0.5) / W) * period;
        const xi = Math.floor(px);
        let d1 = 1e9;
        let d2 = 1e9;
        let best = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const cy = yi + dy;
          const wy = imod(cy, period);
          for (let dx = -1; dx <= 1; dx++) {
            const cx = xi + dx;
            const c = wy * period + imod(cx, period);
            const ddx = cx + fx[c] - px;
            const ddy = cy + fy[c] - py;
            const d = ddx * ddx + ddy * ddy;
            if (d < d1) {
              d2 = d1;
              d1 = d;
              best = c;
            } else if (d < d2) {
              d2 = d;
            }
          }
        }
        f1[o] = Math.sqrt(d1);
        f2[o] = Math.sqrt(d2);
        id[o] = best;
      }
    }
    return { f1, f2, id };
  }
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
  | 'sprite'
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
  sprite: [1, 0.95, 0.85],
  grid: [0.5, 0.5, 0.52],
  ramp: [0.5, 0.5, 0.52],
  floor: [0.32, 0.33, 0.35],
  wall: [0.46, 0.47, 0.5],
  glow: [0.9, 0.9, 0.9],
};

const BUILTIN_PATTERNS: MaterialFamily[] = ['grid', 'ramp', 'floor', 'wall', 'glow'];

/** Keyword rules, most specific first. Applied to the file name, then to the whole path. */
const FAMILY_RULES: [RegExp, MaterialFamily][] = [
  [/light_glow|lensflare|^glow\d|flare/, 'sprite'],
  [/glass|window(?!frame)|windshield/, 'glass'],
  [/ladder/, 'ladder'],
  [/chainlink|fence/, 'fence'],
  [/grate|grating|mesh|catwalk|^\{/, 'grate'],
  [/water|liquid|slime|lava|swamp|sewage/, 'water'],
  [/^dev_|measuregeneric|measurewall|measurecrate/, 'dev'],
  [/fluorescent|lightpanel|light_panel/, 'light'],
  [/brick/, 'brick'],
  [/tile|bathroom/, 'tile'],
  [/wood|plank|shingle|crate|parquet|bark/, 'wood'],
  [/marble/, 'marble'],
  [/carpet|(^|_)rug|fabric|cloth/, 'carpet'],
  [/metal|steel|iron|hull|pipe|citadel|alum|chrome|rust|duct|vent|copper|brass|corrugat/, 'metal'],
  [/grass|moss|lawn|hedge|foliage|leaves|turf/, 'grass'],
  [/stonewall|cobble|cbble|cellarwall|castle|stonebrick|flagstone|stoneblock/, 'stonewall'],
  [/stone|rock|cliff|boulder|granite|basalt|crag|mountain/, 'stone'],
  [/sand|beach|dune|desert/, 'sand'],
  [/dirt|mud|ground|soil|gravel|earth|terrain|blend|forest/, 'dirt'],
  [/plaster|stucco|drywall|paint/, 'plaster'],
  [/concrete|cement|asphalt|road|pavement|sidewalk|curb|wall|floor|ceiling|pillar|column/, 'concrete'],
  [/(^|[/_])(white|black|grey|gray|colou?rs?|neon|solid|plain|flat|red|green|blue|yellow|orange|purple|pink|cyan)(\d|_|\/|$)/, 'flat'],
];

/** Folders that decide the family on their own (stock content layout). */
const FOLDER_FAMILIES: [RegExp, MaterialFamily][] = [
  [/^sprites?\//, 'sprite'],
  [/^lights?\//, 'light'],
  [/^(liquids|water)\//, 'water'],
  [/^glass\//, 'glass'],
];

function matchFamily(s: string): MaterialFamily | null {
  for (const [re, fam] of FAMILY_RULES) if (re.test(s)) return fam;
  return null;
}

/**
 * Picks a procedural family from a (normalized) material or texture name: a few decisive folders first
 * ("lights/", "liquids/", "glass/"), then keywords in the file name, then keywords anywhere in the path
 * (so "de_cbble/grassdirt_blend" is grass, "wood/milflr003" is wood).
 */
export function classifyMaterial(name: string): MaterialFamily {
  const n = normalizeMaterialName(name);
  if (n.startsWith('builtin/')) {
    const words = n.slice(8).split(/[/_\-\s.]+/);
    for (const p of BUILTIN_PATTERNS) if (words.includes(p)) return p;
    return 'grid';
  }
  // Cubemap-patched names ("maps/<map>/<orig>_x_y_z") classify by the original material path.
  const path = n.replace(/^maps\/[^/]+\//, '');
  for (const [re, fam] of FOLDER_FAMILIES) {
    if (!re.test(path)) continue;
    const base = path.slice(path.lastIndexOf('/') + 1);
    // ...unless the file name clearly says water/glass (e.g. "lights/..." never does).
    const b = matchFamily(base);
    return b === 'water' || b === 'glass' ? b : fam;
  }
  const base = path.slice(path.lastIndexOf('/') + 1);
  const fromBase = matchFamily(base);
  if (fromBase && fromBase !== 'flat') return fromBase;
  if (/^dev\//.test(path)) return 'dev';
  const fromPath = matchFamily(path);
  if (fromPath) return fromPath;
  return fromBase ?? 'generic';
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

/** Per-pixel shading: i = pixel index, (u, v) = pixel centre in [0,1), (x, y) = pixel coordinates. */
type PixelFn = (i: number, u: number, v: number, x: number, y: number, p: Px) => void;
/** A family shader: precomputes its noise fields for the image, returns the per-pixel function. */
type ShaderFactory = (nf: NoiseFields, name: string) => PixelFn;

/** Distance in pixels from (u·n) to the nearest integer grid line, for a grid of n cells over `size` px. */
function gridDist(t: number, n: number, size: number): number {
  const f = frac(t * n);
  return Math.min(f, 1 - f) * (size / n);
}

function metalFields(nf: NoiseFields): (i: number) => number {
  const streak = nf.fbm(2, 4, 0, 24);
  const blotch = nf.fbm(8, 2, 5);
  const w = nf.white(3);
  return (i) => 1 + 0.2 * (streak[i] - 0.5) + 0.06 * (blotch[i] - 0.5) + 0.04 * (w[i] - 0.5);
}

/**
 * Fine surface grain shared by the plain families: pores/aggregate (white noise), fine mottling and a faint
 * mid-frequency variation. Deliberately no low-frequency blotches: tiled over a big wall they read as fog or
 * dirt, while fine grain mips down to the flat average colour at a distance like real stock textures.
 */
function grainFields(nf: NoiseFields, amount = 1): (i: number) => number {
  const w = nf.white(3);
  const fine = nf.fbm(48, 2, 1);
  const mid = nf.fbm(12, 2, 2);
  return (i) => 1 + amount * (0.07 * (w[i] - 0.5) + 0.08 * (fine[i] - 0.5) + 0.05 * (mid[i] - 0.5));
}

const SHADERS: Record<MaterialFamily, ShaderFactory> = {
  concrete(nf, name) {
    const { W, H, seed } = nf;
    const grain = grainFields(nf);
    const pits = nf.white(11);
    const base = name.slice(name.lastIndexOf('/') + 1);
    const ceiling = /ceiling/.test(base);
    const floor = !ceiling && /floor|ground|road|pavement|sidewalk|asphalt|curb/.test(base);
    const wall = !ceiling && !floor && /wall|pillar|column/.test(base);
    // Walls: 2x2 formwork panels with 3x3 tie holes and faint rain streaks; floors: 2x2 saw-cut slabs;
    // ceilings: 4x4 acoustic tiles; anything else: faint 2x2 panel seams.
    const P = ceiling ? 4 : 2;
    const streak = wall ? nf.noise(32, 2, 21) : null;
    const lw = Math.max(0.8, W / 320);
    const holeR = Math.max(1.1, W / 160);
    const seamDark = ceiling ? 0.72 : floor ? 0.8 : wall ? 0.84 : 0.9;
    return (i, u, v, x, y, p) => {
      let m = grain(i);
      const pt = pits[i];
      if (pt < 0.012) m *= 0.8; // air pockets
      else if (pt > 0.993) m *= 1.07; // aggregate
      if (streak) m *= 1 + 0.05 * (streak[i] - 0.5);
      m *= 1 + 0.04 * (rnd(Math.floor(u * P), Math.floor(v * P), seed + 5) - 0.5);
      const e = Math.min(gridDist(u, P, W), gridDist(v, P, H));
      if (e < lw) m *= seamDark;
      else if (e < lw + 1) m *= 1.03;
      else if (wall) {
        const cu = (frac(u * P * 3) - 0.5) * (W / (P * 3));
        const cv = (frac(v * P * 3) - 0.5) * (H / (P * 3));
        const d2 = cu * cu + cv * cv;
        if (d2 < holeR * holeR) m *= cv < 0 ? 0.62 : 0.75;
        else if (d2 < (holeR + 1) * (holeR + 1)) m *= 1.04;
      }
      p.m = m;
    };
  },
  plaster(nf) {
    const grain = grainFields(nf, 0.8);
    const trowel = nf.noise(10, 40, 4);
    return (i, u, v, x, y, p) => {
      p.m = grain(i) * (1 + 0.035 * (trowel[i] - 0.5));
    };
  },
  metal(nf, name) {
    const base = metalFields(nf);
    const { W, H, seed } = nf;
    const tread = /floor|tread|diamond|plate/.test(name);
    return (i, u, v, x, y, p) => {
      let m = base(i);
      m *= 1 + 0.07 * (rnd(Math.floor(u * 2), Math.floor(v * 2), seed + 9) - 0.5);
      const ex = gridDist(u, 2, W);
      const ey = gridDist(v, 2, H);
      const e = Math.min(ex, ey);
      if (e < 1) m *= 0.55;
      else if (e < 2) m *= 1.12;
      else if (tread) {
        // diamond tread plate
        const cu = frac(u * 12);
        const cv = frac(v * 12);
        const par = (Math.floor(u * 12) + Math.floor(v * 12)) & 1;
        const a = par ? cu - cv : cu + cv - 1;
        const b = par ? cu + cv - 1 : cu - cv;
        const q = (a / 0.55) * (a / 0.55) + (b / 0.16) * (b / 0.16);
        if (q < 1) m *= 1.1 + 0.1 * (b < 0 ? 1 : -1) * (1 - q);
      } else {
        // rivets 6 px in from each panel corner
        const dx = ex - 6;
        const dy = ey - 6;
        if (dx * dx + dy * dy < 4) m *= dy < 0 ? 1.25 : 0.8;
      }
      p.m = m;
      p.desat = 0.1;
    };
  },
  wood(nf, name) {
    const { W, H, seed } = nf;
    const N = /shingle|roof/.test(name) ? 8 : 6;
    const fine = nf.fbm(4, 3, 3, 16);
    const w = nf.white(5);
    // One grain field, read with a different horizontal offset per plank so neighbouring planks differ.
    const grainF = nf.fbm(2, 4, 13, 4);
    const shift: number[] = [];
    const tones: number[] = [];
    for (let k = 0; k < N; k++) {
      shift.push(Math.floor(rnd(k, 7, seed) * W));
      tones.push(1 + 0.16 * (rnd(k, 0, seed + 1) - 0.5));
    }
    const joints = N >= 8 ? 2 : 1;
    const jointU: number[][] = [];
    for (let k = 0; k < N; k++) {
      const row: number[] = [];
      for (let j = 0; j < joints; j++) row.push(frac(rnd(k, 1 + j, seed + 2) + j / joints));
      jointU.push(row);
    }
    return (i, u, v, x, y, p) => {
      const k = Math.min(N - 1, Math.floor(v * N));
      const vy = v * N - k;
      const tone = tones[k];
      const gi = y * W + ((x + shift[k]) % W);
      const grain = 0.5 + 0.5 * Math.sin(2 * Math.PI * (vy * 5 + 3 * grainF[gi]));
      let m = tone * (1 + 0.18 * (grain - 0.5) + 0.1 * (fine[i] - 0.5) + 0.04 * (w[i] - 0.5));
      const py = vy * (H / N);
      if (py < 1 || H / N - py < 1) m *= 0.45;
      for (const ju of jointU[k]) {
        let du = Math.abs(u - ju);
        du = Math.min(du, 1 - du) * W;
        if (du < 1) m *= 0.5;
      }
      p.m = m;
      p.r = 1 + 0.04 * (grain - 0.5);
    };
  },
  brick(nf) {
    const { W, H, seed } = nf;
    const R = Math.max(2, Math.round((12 * H) / W / 2) * 2);
    const C = Math.max(1, Math.round((3 * W) / H));
    const n = nf.fbm(16, 3, 6);
    const w = nf.white(8);
    const mw = nf.white(4);
    const mt = Math.max(1, W / 128);
    return (i, u, v, x, y, p) => {
      const rowF = v * R;
      const row = Math.floor(rowF);
      const cu = u * C + (row & 1 ? 0.5 : 0);
      const col = imod(Math.floor(cu), C);
      const lx = frac(cu);
      const ly = rowF - row;
      const pxX = Math.min(lx, 1 - lx) * (W / C);
      const pxY = Math.min(ly, 1 - ly) * (H / R);
      if (pxX < mt || pxY < mt) {
        p.m = 1.35 + 0.1 * (mw[i] - 0.5);
        p.desat = 0.7;
        return;
      }
      const id = col * 977 + row;
      const tone = 1 + 0.22 * (rnd(id, 0, seed) - 0.5);
      let m = tone * (1 + 0.16 * (n[i] - 0.5) + 0.08 * (w[i] - 0.5));
      if (pxX < mt + 1.5 || pxY < mt + 1.5) m *= 0.9;
      p.m = m;
      p.r = 1 + 0.08 * (rnd(id, 1, seed) - 0.5);
      p.b = 1 - 0.05 * (rnd(id, 2, seed) - 0.5);
    };
  },
  tile(nf, name) {
    const { W, H, seed } = nf;
    const TX = /wall/.test(name) ? 8 : 4;
    const TY = Math.max(1, Math.round((TX * H) / W));
    const cw = W / TX;
    const ch = H / TY;
    const gw = Math.max(1, W / 170);
    const n = nf.fbm(8, 3, 5);
    const w = nf.white(7);
    const gn = nf.white(2);
    return (i, u, v, x, y, p) => {
      const lx = frac(u * TX);
      const ly = frac(v * TY);
      const gx = Math.min(lx, 1 - lx) * cw;
      const gy = Math.min(ly, 1 - ly) * ch;
      if (gx < gw || gy < gw) {
        p.m = 0.62 + 0.06 * (gn[i] - 0.5);
        p.desat = 0.6;
        return;
      }
      const tone = 1 + 0.07 * (rnd(Math.floor(u * TX), Math.floor(v * TY), seed) - 0.5);
      let m = tone * (1 + 0.06 * (n[i] - 0.5) + 0.03 * (w[i] - 0.5));
      if (lx * cw < gw + 2 || ly * ch < gw + 2) m *= 1.07;
      else if ((1 - lx) * cw < gw + 2 || (1 - ly) * ch < gw + 2) m *= 0.93;
      p.m = m;
    };
  },
  stone(nf) {
    const { W, seed } = nf;
    const n = nf.fbm(6, 4, 0);
    const fine = nf.fbm(32, 2, 9);
    const w = nf.white(2);
    const c = nf.worley(5, 11);
    const cell = W / 5;
    return (i, u, v, x, y, p) => {
      const id = c.id[i];
      // Angular rock faces: per-cell tone and a tilt that brightens one side of each facet.
      const tone = 1 + 0.09 * (rnd(id, 0, seed + 3) - 0.5);
      const edge = (c.f2[i] - c.f1[i]) * cell;
      const facet = 1 + 0.1 * (rnd(id, 1, seed + 3) - 0.5) * Math.min(1, edge / (cell * 0.3));
      let m = tone * facet * (1 + 0.12 * (n[i] - 0.5) + 0.12 * (fine[i] - 0.5) + 0.08 * (w[i] - 0.5));
      m *= 1 + 0.04 * Math.sin(2 * Math.PI * (v * 8 + 0.8 * n[i]));
      if (edge < 1.2 && rnd(id, 2, seed + 3) < 0.6) m *= 0.74;
      p.m = m;
    };
  },
  stonewall(nf, name) {
    const { W, seed } = nf;
    const P = /cobble|cbble/.test(name) ? 8 : 5;
    const c = nf.worley(P, 0);
    const n = nf.fbm(12, 3, 4);
    const w = nf.white(5);
    const mw = nf.white(3);
    const cell = W / P;
    return (i, u, v, x, y, p) => {
      const edgePx = ((c.f2[i] - c.f1[i]) * cell) / 2;
      if (edgePx < 1.5) {
        p.m = 0.6 + 0.08 * (mw[i] - 0.5);
        p.desat = 0.5;
        return;
      }
      const id = c.id[i];
      const tone = 1 + 0.26 * (rnd(id, 0, seed + 1) - 0.5);
      const dome = Math.min(1, edgePx / (cell * 0.25));
      p.m = tone * (0.86 + 0.14 * dome) * (1 + 0.14 * (n[i] - 0.5) + 0.05 * (w[i] - 0.5));
      p.r = 1 + 0.05 * (rnd(id, 1, seed) - 0.5);
    };
  },
  grass(nf) {
    const n = nf.fbm(8, 3, 0);
    const blades = nf.noise(128, 24, 9);
    const blades2 = nf.noise(96, 16, 19);
    const w = nf.white(3);
    const clump = nf.white(13);
    const yel = nf.fbm(8, 2, 17);
    return (i, u, v, x, y, p) => {
      let m = 1 + 0.12 * (n[i] - 0.5) + 0.22 * (blades[i] - 0.5) + 0.14 * (blades2[i] - 0.5) + 0.16 * (w[i] - 0.5);
      if (clump[i] < 0.03) m *= 0.8;
      p.m = m;
      p.r = 1 + 0.16 * (yel[i] - 0.5);
      p.b = 1 - 0.1 * (yel[i] - 0.5);
    };
  },
  dirt(nf) {
    const { seed } = nf;
    const grain = grainFields(nf, 1.3);
    const n = nf.fbm(8, 2, 0);
    const c = nf.worley(24, 7);
    return (i, u, v, x, y, p) => {
      let m = grain(i) * (1 + 0.1 * (n[i] - 0.5));
      // pebbles: a lit top and a shaded bottom
      const f1 = c.f1[i];
      if (f1 < 0.26 && rnd(c.id[i], 0, seed + 8) < 0.45) {
        const k = 1 - f1 / 0.26;
        m *= 1 + (rnd(c.id[i], 1, seed + 8) > 0.5 ? 0.16 : -0.14) * k;
      }
      p.m = m;
    };
  },
  sand(nf) {
    const n = nf.fbm(8, 3, 0);
    const r = nf.fbm(4, 2, 3);
    const w = nf.white(3);
    return (i, u, v, x, y, p) => {
      p.m = 1 + 0.07 * (n[i] - 0.5) + 0.14 * (w[i] - 0.5) + 0.05 * Math.sin(2 * Math.PI * (v * 8 + u + 0.8 * r[i]));
    };
  },
  marble(nf, name) {
    const { W, H } = nf;
    const n = nf.fbm(2, 6, 0);
    const n2 = nf.fbm(6, 3, 3);
    const w = nf.white(4);
    const floor = /floor/.test(name);
    return (i, u, v, x, y, p) => {
      const t = Math.sin(2 * Math.PI * (u + 2 * v + 2.2 * n[i]));
      const a = 1 - Math.abs(t);
      const a2 = a * a;
      const a4 = a2 * a2;
      const vein = a4 * a4 * a2;
      let m = 1 + 0.1 * (n2[i] - 0.5) + 0.03 * (w[i] - 0.5) - 0.35 * vein + 0.05 * (n[i] - 0.5);
      if (floor && Math.min(gridDist(u, 2, W), gridDist(v, 2, H)) < 1) m *= 0.75;
      p.m = m;
    };
  },
  carpet(nf) {
    const n = nf.fbm(8, 3, 0);
    const w = nf.white(3);
    return (i, u, v, x, y, p) => {
      p.m = 1 + 0.12 * (n[i] - 0.5) + 0.22 * (w[i] - 0.5);
    };
  },
  glass(nf) {
    const n = nf.fbm(2, 4, 0);
    const an = nf.fbm(3, 3, 5);
    return (i, u, v, x, y, p) => {
      const band = Math.max(0, Math.sin(2 * Math.PI * (u + v + 0.3 * n[i])));
      const b2 = band * band;
      const hl = b2 * b2;
      p.m = 1 + 0.12 * (n[i] - 0.5) + 0.1 * hl;
      p.a = 255 * (0.38 + 0.12 * (an[i] - 0.5) + 0.15 * hl);
    };
  },
  grate(nf) {
    const base = metalFields(nf);
    const { W, H } = nf;
    const TX = 8;
    const TY = Math.max(1, Math.round((8 * H) / W));
    return (i, u, v, x, y, p) => {
      const lx = frac(u * TX);
      const ly = frac(v * TY);
      const solid = Math.min(lx, 1 - lx) < 0.11 || Math.min(ly, 1 - ly) < 0.11;
      p.m = base(i);
      p.a = solid ? 255 : 0;
    };
  },
  fence(nf) {
    const w = nf.white(0);
    return (i, u, v, x, y, p) => {
      const d1 = frac((u + v) * 12);
      const d2 = frac((u - v) * 12);
      const wire = Math.min(d1, 1 - d1) < 0.06 || Math.min(d2, 1 - d2) < 0.06;
      p.m = 1 + 0.1 * (w[i] - 0.5);
      p.a = wire ? 255 : 0;
    };
  },
  ladder(nf) {
    const base = metalFields(nf);
    return (i, u, v, x, y, p) => {
      const ly = frac(v * 6);
      const rung = ly > 0.4 && ly < 0.58;
      const rail = (u > 0.06 && u < 0.16) || (u > 0.84 && u < 0.94);
      p.m = base(i) * (rung && ly < 0.45 ? 1.15 : 1);
      p.a = rung || rail ? 255 : 0;
    };
  },
  dev(nf) {
    const { W, H } = nf;
    const w = nf.white(0);
    return (i, u, v, x, y, p) => {
      const dMinor = Math.min(gridDist(u, 16, W), gridDist(v, 16, H));
      const dMajor = Math.min(gridDist(u, 4, W), gridDist(v, 4, H));
      let m = 1 + 0.02 * (w[i] - 0.5);
      if (dMajor < 1.5) m *= 0.72;
      else if (dMinor < 0.75) m *= 0.86;
      p.m = m;
    };
  },
  light(nf) {
    const { W, H } = nf;
    return (i, u, v, x, y, p) => {
      const c = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
      let m = 1 + 0.06 * (1 - c);
      const e = Math.min(Math.min(u, 1 - u) * W, Math.min(v, 1 - v) * H);
      if (e < W / 32) m *= 0.85;
      p.m = m;
    };
  },
  water(nf) {
    const n = nf.fbm(3, 4, 0);
    const warp = nf.fbm(2, 3, 7);
    return (i, u, v, x, y, p) => {
      const w = warp[i];
      const w1 = Math.sin(2 * Math.PI * (3 * u + v + 1.5 * w));
      const w2 = Math.sin(2 * Math.PI * (-2 * u + 4 * v + 1.2 * n[i]));
      const w3 = Math.sin(2 * Math.PI * (5 * u - 3 * v + 0.8 * w));
      const c = Math.max(0, w1 * w2);
      const c2 = c * c;
      p.m = 1 + 0.12 * (n[i] - 0.5) + 0.05 * w1 + 0.04 * w2 + 0.03 * w3 + 0.18 * c2 * c2;
      p.b = 1.02;
    };
  },
  flat(nf) {
    const n = nf.fbm(4, 3, 0);
    const w = nf.white(0);
    return (i, u, v, x, y, p) => {
      p.m = 1 + 0.04 * (n[i] - 0.5) + 0.015 * (w[i] - 0.5);
    };
  },
  sprite(nf) {
    return (i, u, v, x, y, p) => {
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const f = (1 - r) * (1 - r);
      p.m = f;
      p.a = 255 * f;
    };
  },
  generic(nf) {
    const { W, H, seed } = nf;
    const grain = grainFields(nf);
    const lw = Math.max(0.8, W / 320);
    return (i, u, v, x, y, p) => {
      // Fine grain on faint 2x2 panels: reads as a surface (and gives a sense of scale and speed) without
      // detail that could contradict the real texture.
      let m = grain(i) * (1 + 0.035 * (rnd(Math.floor(u * 2), Math.floor(v * 2), seed + 5) - 0.5));
      if (Math.min(gridDist(u, 2, W), gridDist(v, 2, H)) < lw) m *= 0.9;
      p.m = m;
    };
  },
  grid(nf) {
    const { W, H } = nf;
    const lw = Math.max(1, W / 256);
    const n = nf.fbm(4, 3, 0);
    const w = nf.white(0);
    return (i, u, v, x, y, p) => {
      const dMinor = Math.min(gridDist(u, 8, W), gridDist(v, 8, H));
      const dBorder = Math.min(Math.min(u, 1 - u) * W, Math.min(v, 1 - v) * H);
      let m = 1 + 0.03 * (n[i] - 0.5) + 0.01 * (w[i] - 0.5);
      if (dBorder < 2 * lw) m *= 1.5;
      else if (dMinor < lw) m *= 1.3;
      p.m = m;
    };
  },
  ramp(nf) {
    const { W } = nf;
    const n = nf.fbm(3, 4, 0);
    const w = nf.white(0);
    const lw = Math.max(1, W / 256);
    return (i, u, v, x, y, p) => {
      let m = 1 + 0.06 * (n[i] - 0.5) + 0.06 * Math.cos(2 * Math.PI * v) + 0.01 * (w[i] - 0.5);
      if (gridDist(u, 4, W) < lw) m *= 1.12;
      p.m = m;
    };
  },
  floor(nf) {
    const { W, H, seed } = nf;
    const n = nf.fbm(8, 3, 2);
    const lw = Math.max(1, W / 256);
    return (i, u, v, x, y, p) => {
      const e = Math.min(gridDist(u, 4, W), gridDist(v, 4, H));
      let m = (1 + 0.04 * (rnd(Math.floor(u * 4), Math.floor(v * 4), seed) - 0.5)) * (1 + 0.05 * (n[i] - 0.5));
      if (e < lw) m *= 0.72;
      else if (e < lw + 2) m *= 1.05;
      p.m = m;
    };
  },
  wall(nf) {
    const { W, H } = nf;
    const n = nf.fbm(4, 4, 0);
    const w = nf.white(1);
    const lw = Math.max(1, W / 256);
    return (i, u, v, x, y, p) => {
      let m = 1 + 0.12 * (n[i] - 0.5) + 0.03 * (w[i] - 0.5);
      if (Math.min(gridDist(u, 2, W), gridDist(v, 2, H)) < lw) m *= 0.7;
      p.m = m;
    };
  },
  glow(nf) {
    const { W, H } = nf;
    const n = nf.fbm(4, 2, 0);
    return (i, u, v, x, y, p) => {
      const e = Math.min(Math.min(u, 1 - u) * W, Math.min(v, 1 - v) * H);
      p.m = (1 + 0.02 * (n[i] - 0.5)) * (e < W / 32 ? 1.08 : 1);
    };
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
  const W = Math.max(4, Math.min(1024, Math.round(opts.width ?? 256)));
  const H = Math.max(4, Math.min(1024, Math.round(opts.height ?? 256)));
  const factory = SHADERS[opts.family] ?? SHADERS.generic;
  const name = opts.name ?? '';
  const n = W * H;
  const target = [clamp01(opts.color[0]) * 255, clamp01(opts.color[1]) * 255, clamp01(opts.color[2]) * 255];
  const tl = (0.2126 * target[0] + 0.7152 * target[1] + 0.0722 * target[2]) / 255;
  // Bright colours have no headroom: reduce the pattern contrast so it doesn't clip into a flat white.
  const contrast = opts.family === 'sprite' ? 1 : tl > 0.7 ? Math.max(0.35, 1 - (tl - 0.7) * 2.2) : 1;
  const shade = factory(new NoiseFields(W, H, opts.seed | 0), name);
  const rgb = new Float32Array(n * 3);
  const alpha = new Uint8Array(n);
  const p: Px = { m: 1, r: 1, g: 1, b: 1, desat: 0, a: 255 };
  for (let y = 0, i = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++, i++) {
      const u = (x + 0.5) / W;
      p.m = 1;
      p.r = 1;
      p.g = 1;
      p.b = 1;
      p.desat = 0;
      p.a = 255;
      shade(i, u, v, x, y, p);
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
      rgb[i * 3] = r < 0 ? 0 : r > 255 ? 255 : r;
      rgb[i * 3 + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      rgb[i * 3 + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      alpha[i] = p.a <= 0 ? 0 : p.a >= 255 ? 255 : Math.round(p.a);
    }
  }
  if (opts.family === 'sprite') {
    // Glow sprites are drawn additively: colour premultiplied by a radial falloff, no mean normalization.
    const data = new Uint8Array(n * 4);
    for (let i = 0, o = 0, q = 0; i < n; i++, o += 4, q += 3) {
      data[o] = (rgb[q] + 0.5) | 0;
      data[o + 1] = (rgb[q + 1] + 0.5) | 0;
      data[o + 2] = (rgb[q + 2] + 0.5) | 0;
      data[o + 3] = alpha[i];
    }
    PROCEDURAL.add(data);
    return { width: W, height: H, data, hasAlpha: true };
  }
  // Normalize the mean over visible pixels (alpha >= 128, or all if none) to the target colour:
  // multiplicative passes keep the pattern's relative contrast, additive passes remove the clipping residue.
  const vis = new Uint8Array(n);
  let visCount = 0;
  for (let i = 0; i < n; i++) {
    if (alpha[i] >= 128) {
      vis[i] = 1;
      visCount++;
    }
  }
  if (visCount === 0) {
    vis.fill(1);
    visCount = n;
  }
  const mean = [0, 0, 0];
  const measure = () => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      if (!vis[i]) continue;
      r += rgb[o];
      g += rgb[o + 1];
      b += rgb[o + 2];
    }
    mean[0] = r / visCount;
    mean[1] = g / visCount;
    mean[2] = b / visCount;
  };
  for (let pass = 0; pass < 6; pass++) {
    measure();
    const err = Math.max(Math.abs(mean[0] - target[0]), Math.abs(mean[1] - target[1]), Math.abs(mean[2] - target[2]));
    if (err < 0.05) break;
    const additive = pass >= 2;
    for (let ch = 0; ch < 3; ch++) {
      const k = mean[ch] > 1e-6 ? target[ch] / mean[ch] : 1;
      const d = target[ch] - mean[ch];
      for (let o = ch; o < n * 3; o += 3) {
        const val = additive ? rgb[o] + d : rgb[o] * k;
        rgb[o] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
    }
  }
  const data = new Uint8Array(n * 4);
  let hasAlpha = false;
  const fill = [Math.round(target[0]), Math.round(target[1]), Math.round(target[2])];
  for (let i = 0, o = 0, q = 0; i < n; i++, o += 4, q += 3) {
    const a = alpha[i];
    if (a === 0) {
      // Fully transparent texels carry the average colour so filtering doesn't produce dark fringes.
      data[o] = fill[0];
      data[o + 1] = fill[1];
      data[o + 2] = fill[2];
    } else {
      data[o] = (rgb[q] + 0.5) | 0;
      data[o + 1] = (rgb[q + 1] + 0.5) | 0;
      data[o + 2] = (rgb[q + 2] + 0.5) | 0;
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
  const base = family === 'flat' || family === 'light' || family === 'glow' || family === 'sprite' ? 64 : 256;
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
  return [clamp01(color[0] * 0.5 + 0.03), clamp01(color[1] * 0.6 + 0.07), clamp01(color[2] * 0.6 + 0.09)];
}

const WATER_COLOR: RGB = [0.16, 0.3, 0.36];

/**
 * Surface colour for water. Source water has no albedo texture, and vbsp stores a neutral 0.2 grey
 * reflectivity for it, so a grey reflectivity means "unknown": use a generic blue-green. A coloured
 * reflectivity (custom water with a base texture) tints it.
 */
function waterSurfaceColor(reflectivity: Vec3 | null | undefined): RGB {
  if (!reflectivity) return [...WATER_COLOR];
  const c = reflectivityToSrgb(reflectivity);
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  if (mx - mn < 0.04) return [...WATER_COLOR];
  return [(c[0] + WATER_COLOR[0]) / 2, (c[1] + WATER_COLOR[1]) / 2, (c[2] + WATER_COLOR[2]) / 2];
}

/** Opacity hint for water surfaces (they refract what's below in Source). */
const WATER_ALPHA = 0.85;

/** Procedural images shared within one buildMaterials call (cubemap patches of one stock material, etc.). */
type ProcCache = Map<string, DecodedImage>;

function proceduralImage(cache: ProcCache | null, family: MaterialFamily, color: RGB, w: number, h: number, name: string): DecodedImage {
  const key = `${family}|${name}|${color.map((c) => Math.round(c * 1000)).join(',')}|${w}x${h}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const img = generateProceduralImage({ family, color, seed: hashString(name), width: w, height: h, name });
  cache?.set(key, img);
  return img;
}

interface FallbackInputs {
  /** Name used for family heuristics (texture or included material name). */
  hintName: string;
  reflectivity?: Vec3 | null;
  hints?: SurfaceHints | null;
  /** True when no VMT was available (flags come from heuristics/hints). */
  noVmt: boolean;
  cache?: ProcCache | null;
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
      if (family === 'sprite') {
        def.translucent = true;
        def.additive = true;
        def.unlit = true;
        def.noCull = true;
      }
      if (hints && hints.texinfoCount > 0 && hints.andFlags & SURF_NOLIGHT && !def.isWater) def.unlit = true;
      if (def.isWater) {
        def.translucent = true;
        def.alpha = WATER_ALPHA;
        def.fallbackColor = waterSurfaceColor(inp.reflectivity);
        def.waterFogColor = defaultWaterFog(def.fallbackColor);
      }
    }
  }
  if (def.isTool || def.isSky) return def;

  // ---- image
  let fam = family;
  if (def.isWater && fam !== 'water') fam = 'water';
  if (def.translucent && !def.isWater && fam !== 'glass' && fam !== 'sprite' && inp.noVmt) {
    // Unknown translucent material: show it as a tinted, partly transparent pane.
    fam = 'glass';
  }
  const [w, h] = procSizeFor(fam, def.width, def.height);
  def.image = proceduralImage(inp.cache ?? null, fam, def.fallbackColor, w, h, hn);
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

/**
 * Decodes (cached) "materials/<tex>.vtf". In compressed mode DXT textures carry their mip chain and a
 * reduced RGBA fallback unless `full` asks for a full-resolution RGBA decode (needed to bake a tint).
 */
function loadTexture(ctx: BuildContext, tex: string, opts: { maxSize?: number; full?: boolean } = {}): DecodedImage | null {
  if (!tex) return null;
  const path = vtfPath(tex);
  const maxSize = opts.maxSize ?? ctx.maxSize;
  const compressed = ctx.compressed && !opts.full;
  const key = `${path}|${maxSize}|${compressed ? 'c' : 'f'}`;
  const cache = ctx.cache.images;
  if (cache.has(key)) return cache.get(key)!;
  const data = ctx.files.read(path);
  const img = data ? decodeVtf(data, { maxSize, compressed, rgbaMaxSize: ctx.rgbaFallbackSize }) : null;
  cache.set(key, img);
  return img;
}

/**
 * DecalModulate draws dst · 2·src (grey 128 = no change). For the usual darkening decals that equals plain
 * alpha blending of black with alpha = 1 − 2·src, which any renderer can draw; brightening texels clamp.
 */
function modulateToAlpha(img: DecodedImage): DecodedImage {
  const d = img.data;
  const out = new Uint8Array(d.length);
  let any = false;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
    const a = clamp01(1 - 2 * lum) * (d[i + 3] / 255);
    const ab = Math.round(a * 255);
    out[i + 3] = ab;
    if (ab !== 255) any = true;
  }
  return { width: img.width, height: img.height, data: out, hasAlpha: any };
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
  /**
   * Attach the original DXT mip chains (DecodedImage.compressed) for S3TC-capable renderers; the RGBA `data`
   * of those images is then decoded from a mip of at most `rgbaFallbackSize` (default 64). Default false.
   */
  compressedTextures?: boolean;
  rgbaFallbackSize?: number;
}

interface BuildContext {
  files: Files;
  cache: TexCache;
  proc: ProcCache;
  maxSize: number;
  detail: boolean;
  animated: boolean;
  compressed: boolean;
  rgbaFallbackSize: number;
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
  /** Bytes of distinct decoded/generated pixel buffers referenced by the materials (shared images count once). */
  imageBytes: number;
  /** Bytes of distinct compressed (DXT) mip chains (compressedTextures mode). */
  compressedBytes: number;
}

/** Copies an image's alpha channel into RGB (opaque), e.g. a normal map's alpha envmap mask. */
function alphaToMask(img: DecodedImage): DecodedImage {
  const d = img.data;
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = d[i + 3];
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out, hasAlpha: false };
}

/** $envmap parameters (null when the material has no reflection). Water reflections are the renderer's own. */
function parseEnvmap(ctx: BuildContext, P: Record<string, string>, isWater: boolean): MaterialEnvmap | null {
  const env = (P['$envmap'] ?? '').trim();
  if (!env || env === '0' || isWater) return null;
  const tint = vmtVector(P['$envmaptint']) ?? [1, 1, 1];
  const maskSize = Math.min(ctx.maxSize, 256);
  let mask: MaterialEnvmap['mask'] = 'none';
  let maskImage: DecodedImage | null = null;
  if (P['$envmapmask']) {
    mask = 'texture';
    const img = loadTexture(ctx, P['$envmapmask'], { maxSize: maskSize, full: true });
    maskImage = img ? { ...img, hasAlpha: false } : null;
  } else if (vmtBool(P['$basealphaenvmapmask'])) {
    mask = 'basealpha';
  } else if (vmtBool(P['$normalmapalphaenvmapmask'])) {
    mask = 'normalalpha';
    const nm = P['$bumpmap'] || P['$normalmap'];
    const img = nm ? loadTexture(ctx, nm, { maxSize: maskSize, full: true }) : null;
    maskImage = img ? alphaToMask(img) : null;
  }
  const sat = vmtVector(P['$envmapsaturation']);
  return {
    cubemap: env.toLowerCase() === 'env_cubemap' ? 'env_cubemap' : normalizeTextureName(env),
    tint: [Math.max(0, tint[0]), Math.max(0, tint[1]), Math.max(0, tint[2])],
    mask,
    maskImage,
    contrast: clamp01(vmtNumber(P['$envmapcontrast'], 0)),
    saturation: clamp01(sat ? sat[0] : 1),
    fresnel: clamp01(vmtNumber(P['$fresnelreflection'], 1)),
  };
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
    proceduralMaterial(def, { hintName, reflectivity, hints, noVmt: true, cache: ctx.proc });
    // Patch params (insert/replace) of a missing include still count (rare: $basetexture overrides).
    const bt = info?.params['$basetexture'];
    if (bt && !def.isTool && !def.isSky) {
      const img = loadTexture(ctx, bt);
      if (img) {
        def.image = img;
        def.fallbackColor = imageAverage(img);
      }
    }
    // vbsp only patches $envmap into materials that reflect: keep the reflection with a typical stock tint.
    const env = info?.params['$envmap'];
    if (env && !def.isTool && !def.isSky && !def.isWater) {
      const e = parseEnvmap(ctx, info!.params, false);
      if (e && !info!.params['$envmaptint']) {
        const fam = classifyMaterial(hintName);
        const k = fam === 'glass' ? 0.6 : fam === 'metal' || fam === 'grate' ? 0.3 : fam === 'tile' || fam === 'marble' ? 0.25 : 0.12;
        e.tint = [k, k, k];
      }
      if (e) def.envmap = e;
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
    if (P['$alpha'] == null) def.alpha = WATER_ALPHA;
    const fog = vmtVector(P['$fogcolor']);
    def.waterFogColor = fog ? [clamp01(fog[0]), clamp01(fog[1]), clamp01(fog[2])] : null;
    if (P['$fogstart'] != null || P['$fogend'] != null) {
      const start = Math.max(0, vmtNumber(P['$fogstart'], 0));
      const end = Math.max(start, vmtNumber(P['$fogend'], start));
      def.waterFogRange = [start, end];
    }
  }

  if (def.isTool || def.isSky) {
    def.fallbackColor = reflectivity ? reflectivityToSrgb(reflectivity) : [0.5, 0.5, 0.5];
    if (name === 'tools/toolsblack') def.fallbackColor = [0, 0, 0];
    return { def, info };
  }

  // ---- base texture
  let baseTex = P['$basetexture'] ?? '';
  let image = baseTex ? loadTexture(ctx, baseTex) : null;
  if (!image) {
    // HDR / DX9 fallback blocks may point somewhere else than the root parameter.
    const root = resolved.body?.['$basetexture'];
    if (typeof root === 'string' && root !== baseTex) {
      const img = loadTexture(ctx, root);
      if (img) {
        image = img;
        baseTex = root;
      }
    }
  }

  // $color tints any shader; $color2 is the model tint of VertexLitGeneric.
  let tint = vmtVector(P['$color']);
  const tint2 = shader === 'vertexlitgeneric' ? vmtVector(P['$color2']) : null;
  if (tint2) tint = tint ? tint.map((x, i) => x * tint2[i]) : tint2;
  const hasTint = !!tint && (Math.abs(tint[0] - 1) > 1e-3 || Math.abs(tint[1] - 1) > 1e-3 || Math.abs(tint[2] - 1) > 1e-3);

  // AnimatedTexture proxy on the base texture.
  const anim = proxyBlock(resolved.proxies, 'animatedtexture');
  if (image && ctx.animated && anim && (kvString(anim, 'animatedtexturevar') ?? '').trim().toLowerCase() === '$basetexture') {
    const data = files.read(vtfPath(baseTex));
    const h = data ? parseVtfHeader(data) : null;
    if (data && h && h.frames > 1) {
      const frames = decodeVtfFrames(data, { maxSize: ctx.maxSize, compressed: ctx.compressed && !hasTint, rgbaMaxSize: ctx.rgbaFallbackSize });
      if (frames && frames.length > 1) {
        image = frames[0];
        def.frames = frames;
        def.frameRate = vmtNumber(kvString(anim, 'animatedtextureframerate'), 15);
      }
    }
  }

  if (image && shader === 'decalmodulate') {
    if (image.compressed) image = loadTexture(ctx, baseTex, { full: true }) ?? image;
    image = modulateToAlpha(image);
    def.translucent = true;
    def.unlit = true;
  }

  if (image) {
    if (vmtBool(P['$decal']) && image.hasAlpha && !def.alphaTest) def.translucent = true;
    if (hasTint) {
      // A tint can't be baked into DXT blocks: use a full RGBA decode for tinted materials.
      if (image.compressed && !def.frames) image = loadTexture(ctx, baseTex, { full: true }) ?? image;
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
      } else {
        def.fallbackColor = color = waterSurfaceColor(reflectivity);
        def.waterFogColor = defaultWaterFog(color);
      }
    }
    const [w, h] = procSizeFor(pfam, def.width, def.height);
    def.image = proceduralImage(ctx.proc, pfam, color, w, h, texName);
    if (!def.translucent && !def.alphaTest && def.image.hasAlpha) def.image = { ...def.image, hasAlpha: false };
  }

  // ---- WorldVertexTransition second texture (displacement blend)
  if (shader === 'worldvertextransition' || P['$basetexture2']) {
    const t2 = P['$basetexture2'];
    if (t2) {
      let img2 = loadTexture(ctx, t2, { full: hasTint });
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
        const g = proceduralImage(ctx.proc, fam2, c2, w, h, t2name);
        def.image2 = { ...g, hasAlpha: false };
      }
      const tt2 = parseTextureTransform(P['$basetexturetransform2']);
      if (tt2 && !isIdentityTransform(tt2)) def.textureTransform2 = tt2;
    }
  }

  // ---- cubemap reflection
  const envmap = parseEnvmap(ctx, P, def.isWater);
  if (envmap) def.envmap = envmap;

  // ---- detail texture
  if (ctx.detail && P['$detail']) {
    const dimg = loadTexture(ctx, P['$detail'], { maxSize: Math.min(ctx.maxSize, 1024) });
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

/** Per-material inputs known from the BSP texdata/texinfo. */
export interface MaterialInputs {
  /** Texture size used by vbsp for texture coordinates (texdata width/height). */
  width?: number;
  height?: number;
  /** vrad's average linear colour (texdata reflectivity). */
  reflectivity?: Vec3 | null;
  hints?: SurfaceHints | null;
}

/**
 * Resolves material names to MaterialDefs with shared caches (decoded textures, procedural images, VMT text).
 * buildMaterials() uses one per map; the static-prop loader can use the same instance for model materials.
 */
export class MaterialLoader {
  private readonly ctx: BuildContext;
  private readonly defs = new Map<string, MaterialDef>();
  private readonly seenBuffers = new Set<Uint8Array>();
  readonly stats: MaterialStats = {
    total: 0,
    withVmt: 0,
    withImage: 0,
    procedural: 0,
    tools: 0,
    sky: 0,
    water: 0,
    missingIncludes: 0,
    imageBytes: 0,
    compressedBytes: 0,
  };

  constructor(pak: PakFile | null, opts: BuildMaterialsOptions = {}) {
    this.ctx = {
      files: new Files(sourcesFor(pak, opts.extraSources)),
      cache: { images: new Map() },
      proc: new Map(),
      maxSize: Math.max(1, opts.maxTextureSize ?? 2048),
      detail: opts.detailTextures ?? true,
      animated: opts.animatedTextures ?? true,
      compressed: opts.compressedTextures ?? false,
      rgbaFallbackSize: Math.max(1, opts.rgbaFallbackSize ?? 64),
    };
  }

  /** True when "materials/<name>.vmt" exists in the sources. */
  hasMaterial(name: string): boolean {
    return this.ctx.files.readText(`materials/${normalizeMaterialName(name)}.vmt`) != null;
  }

  /** The material `name` (normalized; cached by name — the first call's inputs win). Never throws. */
  load(name: string, inputs: MaterialInputs = {}): MaterialDef {
    const n = normalizeMaterialName(name);
    const hit = this.defs.get(n);
    if (hit) return hit;
    let def: MaterialDef;
    let info: VmtInfo | null = null;
    try {
      const r = buildMaterial(this.ctx, n, inputs.width ?? 0, inputs.height ?? 0, inputs.reflectivity ?? null, inputs.hints ?? null);
      def = r.def;
      info = r.info;
    } catch {
      def = fallbackMaterial(n, inputs.reflectivity ?? undefined, inputs.width, inputs.height);
    }
    this.defs.set(n, def);
    this.count(def, info);
    return def;
  }

  /**
   * A model's material: the first "materials/<dir>/<name>.vmt" that exists for the model's $cdmaterials
   * directories (in order), else a procedural fallback named after the first candidate.
   */
  loadModelMaterial(name: string, cdMaterials: string[]): MaterialDef {
    const candidates: string[] = [];
    for (const dir of cdMaterials.length ? cdMaterials : ['']) {
      const d = normalizeMaterialName(dir).replace(/\/+$/, '');
      candidates.push(normalizeMaterialName(d ? `${d}/${name}` : name));
    }
    for (const c of candidates) if (this.defs.has(c) || this.hasMaterial(c)) return this.load(c);
    return this.load(candidates[0]);
  }

  /** Decodes "materials/<name>.vtf" with this loader's settings and cache. */
  texture(name: string): DecodedImage | null {
    return loadTexture(this.ctx, name);
  }

  private count(def: MaterialDef, info: VmtInfo | null): void {
    const st = this.stats;
    st.total++;
    if (info) st.withVmt++;
    if (info?.includeMissing) st.missingIncludes++;
    if (def.isTool) st.tools++;
    else if (def.isSky) st.sky++;
    if (def.isWater) st.water++;
    if (def.image) {
      if (isProceduralImage(def.image)) st.procedural++;
      else st.withImage++;
    }
    const add = (img: DecodedImage | null | undefined) => {
      if (!img || this.seenBuffers.has(img.data)) return;
      this.seenBuffers.add(img.data);
      st.imageBytes += img.data.byteLength;
      if (img.compressed) for (const m of img.compressed.mips) st.compressedBytes += m.data.byteLength;
    };
    add(def.image);
    add(def.image2);
    add(def.detail?.image);
    add(def.envmap?.maskImage);
    if (def.frames) for (const f of def.frames) add(f);
  }
}

/**
 * Builds one MaterialDef per texdata material name (keyed by normalizeMaterialName). Uses the pakfile's VMTs
 * and VTFs (and `opts.extraSources`); materials whose textures aren't available get procedural images.
 */
export function buildMaterials(bsp: BspFile, pak: PakFile | null, opts: BuildMaterialsOptions = {}): Map<string, MaterialDef> {
  const loader = new MaterialLoader(pak, opts);
  let hints: SurfaceHints[] = [];
  try {
    hints = computeSurfaceHints(bsp);
  } catch {
    hints = [];
  }
  const out = new Map<string, MaterialDef>();
  const names = bsp.texdataNames ?? [];
  for (let i = 0; i < names.length; i++) {
    const raw = names[i];
    if (raw == null) continue;
    const name = normalizeMaterialName(raw);
    if (!name || out.has(name)) continue;
    const td = bsp.texdata[i];
    out.set(name, loader.load(name, { width: td?.width, height: td?.height, reflectivity: td?.reflectivity ?? null, hints: hints[i] ?? null }));
  }
  lastStats = loader.stats;
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
  if (!transform && src.width === size && src.height === size) {
    const data = src.data.slice();
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { width: size, height: size, data, hasAlpha: false };
  }
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

function loadSkyFace(
  files: Files,
  base: string,
  suffix: SkySuffix,
  maxSize: number,
  allowHdr: boolean,
  cache: Map<string, DecodedImage | null>,
): SkyFaceSrc | null {
  const vmt = files.readText(`materials/skybox/${base}${suffix}.vmt`);
  const info = vmt != null ? parseVmt(vmt, (p) => files.readText(p)) : null;
  const P = info?.params ?? {};
  const transform = parseTextureTransform(P['$basetexturetransform']);
  const tf = transform && !isIdentityTransform(transform) ? transform : null;
  const tryTex = (tex: string | undefined, hdrCompressed: boolean | 'auto'): DecodedImage | null => {
    if (!tex) return null;
    const path = vtfPath(tex);
    const key = `${path}|${hdrCompressed}`;
    if (cache.has(key)) return cache.get(key)!;
    let img: DecodedImage | null = null;
    const data = files.read(path);
    const h = data ? parseVtfHeader(data) : null;
    if (data && h) {
      const compressed = hdrCompressed === 'auto' ? h.format === VtfFormat.BGRA8888 && /_hdr/.test(normalizeTextureName(tex)) : hdrCompressed;
      img = decodeVtf(data, { maxSize, hdrCompressed: compressed });
    }
    cache.set(key, img);
    return img;
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
    const texCache = new Map<string, DecodedImage | null>();
    for (const suffix of SKY_SUFFIXES) {
      let face: SkyFaceSrc | null = null;
      // LDR first across both naming schemes, then HDR.
      for (const allowHdr of [false, true]) {
        for (const b of bases) {
          face = loadSkyFace(files, b, suffix, maxSize, allowHdr, texCache);
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

/** Colours of a procedural sky: straight up, at the horizon and straight down (sRGB 0..1). */
export interface SkyPalette {
  zenith: RGB;
  horizon: RGB;
  ground: RGB;
}

const SKY_PALETTES: [RegExp, SkyPalette][] = [
  [/night|borealis|black|dark|space|star|nebula|moon|midnight/, { zenith: [0.02, 0.03, 0.08], horizon: [0.09, 0.11, 0.2], ground: [0.02, 0.02, 0.03] }],
  [/dusk|sunset|sunrise|evening|twilight|dawn|sundown|day01_06|day01_08|day02_09/, { zenith: [0.22, 0.28, 0.5], horizon: [0.95, 0.62, 0.38], ground: [0.24, 0.18, 0.15] }],
  [/dust|desert|sand|wasteland|aztec|dune|mirage|inferno/, { zenith: [0.42, 0.58, 0.82], horizon: [0.86, 0.8, 0.68], ground: [0.5, 0.42, 0.32] }],
  [/overcast|cloudy|c17|rain|storm|fog|mist|grey|gray|militia|cobble|nuke|day02|tides|train/, { zenith: [0.5, 0.54, 0.6], horizon: [0.74, 0.76, 0.78], ground: [0.35, 0.36, 0.37] }],
];
const DEFAULT_SKY: SkyPalette = { zenith: [0.24, 0.47, 0.85], horizon: [0.72, 0.82, 0.92], ground: [0.35, 0.38, 0.4] };

/** Guesses a sky palette from a (stock) sky name: night, sunset, desert, overcast or a clear day. */
export function stockSkyPalette(skyName: string): SkyPalette {
  const n = (skyName ?? '').toLowerCase();
  for (const [re, pal] of SKY_PALETTES) if (re.test(n)) return pal;
  return DEFAULT_SKY;
}

/**
 * Procedural stand-in for a sky that isn't packed in the map (stock CS:S/HL2 skies): six faces with a
 * gradient that depends only on elevation (so it is seamless whatever face orientation the renderer uses),
 * coloured by stockSkyPalette(skyName). Use when loadSky() returns faces === null.
 */
export function proceduralSky(skyName: string, size = 256): SkyDef {
  const pal = stockSkyPalette(skyName);
  const S = Math.max(4, Math.min(2048, Math.round(size)));
  const seed = hashString(skyName ?? '');
  const face = (kind: 'side' | 'up' | 'dn'): DecodedImage => {
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      const b = 1 - (2 * (y + 0.5)) / S;
      for (let x = 0; x < S; x++) {
        const a = (2 * (x + 0.5)) / S - 1;
        // sin(elevation) of the direction through this texel of a unit cube face.
        const len = Math.sqrt(1 + a * a + b * b);
        const se = kind === 'side' ? b / len : kind === 'up' ? 1 / len : -1 / len;
        let c: RGB;
        if (se >= 0) {
          const t = Math.pow(se, 0.55);
          c = [0, 1, 2].map((k) => pal.horizon[k] + (pal.zenith[k] - pal.horizon[k]) * t) as RGB;
        } else {
          const t = Math.pow(-se, 0.35);
          c = [0, 1, 2].map((k) => pal.horizon[k] + (pal.ground[k] - pal.horizon[k]) * t) as RGB;
        }
        const o = (y * S + x) * 4;
        const dither = rnd(x, y, seed) - 0.5; // breaks up 8-bit banding in the smooth gradient
        data[o] = Math.max(0, Math.min(255, Math.round(c[0] * 255 + dither)));
        data[o + 1] = Math.max(0, Math.min(255, Math.round(c[1] * 255 + dither)));
        data[o + 2] = Math.max(0, Math.min(255, Math.round(c[2] * 255 + dither)));
        data[o + 3] = 255;
      }
    }
    PROCEDURAL.add(data);
    return { width: S, height: S, data, hasAlpha: false };
  };
  const side = face('side');
  return {
    name: skyName,
    faces: { rt: side, lf: side, bk: side, ft: side, up: face('up'), dn: face('dn') },
  };
}

// ======================================================================== baked cubemaps

export interface LoadCubemapOptions {
  extraSources?: MaterialFileSource[];
  /** Largest face size (default 256; baked cubemaps are usually 32). */
  maxSize?: number;
}

/**
 * Decodes the six faces (VTF order rt, lf, bk, ft, up, dn) of a baked cubemap texture such as
 * "maps/<map>/c0_0_0" (LDR "<name>.vtf" preferred, else "<name>.hdr.vtf" tone-mapped). Null when missing.
 */
export function loadCubemap(texture: string, pak: PakFile | null, opts: LoadCubemapOptions = {}): DecodedImage[] | null {
  return loadCubemapWith(new Files(sourcesFor(pak, opts.extraSources)), texture, Math.max(1, opts.maxSize ?? 256));
}

function loadCubemapWith(files: Files, texture: string, maxSize: number): DecodedImage[] | null {
  try {
    const base = normalizeTextureName(texture).replace(/\.hdr$/, '');
    if (!base) return null;
    for (const suffix of ['', '.hdr']) {
      const data = files.read(`materials/${base}${suffix}.vtf`);
      const h = data ? parseVtfHeader(data) : null;
      if (!data || !h || h.faces < 6) continue;
      const faces: DecodedImage[] = [];
      for (let f = 0; f < 6; f++) {
        const img = decodeVtf(data, { maxSize, face: f });
        if (!img) break;
        const d = img.data;
        for (let i = 3; i < d.length; i += 4) d[i] = 255;
        faces.push({ ...img, hasAlpha: false });
      }
      if (faces.length === 6) return faces;
    }
  } catch {
    // fall through
  }
  return null;
}

const CUBEMAP_TEX_RE = /^materials\/maps\/([^/]+)\/(c-?\d+_-?\d+_-?\d+|cubemapdefault)(\.hdr)?\.vtf$/;

/**
 * The map name used in "maps/<name>/..." paths (the name the BSP was compiled as, which may differ from the
 * file name: surf_utopia_njv.bsp uses "surf_utopia_v3_njv"), from packed cubemaps or patched material names.
 */
export function compiledMapName(bsp: BspFile, pak: PakFile | null): string | null {
  if (pak) {
    for (const k of pak.list()) {
      const m = CUBEMAP_TEX_RE.exec(k);
      if (m) return m[1];
    }
  }
  for (const raw of bsp.texdataNames ?? []) {
    const m = /^maps\/([^/]+)\//.exec(normalizeMaterialName(raw));
    if (m) return m[1];
  }
  return null;
}

/**
 * Baked env_cubemaps: LUMP_CUBEMAPS samples (origin, size) with their textures "maps/<map>/c<x>_<y>_<z>"
 * decoded from the pakfile (faces null when not packed — maps released without buildcubemaps). When the map
 * has no samples but packs "cubemapdefault", that one is returned at the origin.
 */
export function loadCubemaps(bsp: BspFile, pak: PakFile | null, opts: LoadCubemapOptions = {}): CubemapDef[] {
  const out: CubemapDef[] = [];
  try {
    const files = new Files(sourcesFor(pak, opts.extraSources));
    const maxSize = Math.max(1, opts.maxSize ?? 256);
    const name = compiledMapName(bsp, pak);
    const lump = bsp.getLump(LUMP_CUBEMAPS);
    const dv = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
    const n = Math.floor(lump.byteLength / 16);
    for (let i = 0; i < n; i++) {
      const x = dv.getInt32(i * 16, true);
      const y = dv.getInt32(i * 16 + 4, true);
      const z = dv.getInt32(i * 16 + 8, true);
      const size = dv.getInt32(i * 16 + 12, true);
      const texture = name ? `maps/${name}/c${x}_${y}_${z}` : '';
      out.push({ origin: { x, y, z }, size, texture, faces: texture ? loadCubemapWith(files, texture, maxSize) : null });
    }
    if (!out.length && name) {
      const texture = `maps/${name}/cubemapdefault`;
      const faces = loadCubemapWith(files, texture, maxSize);
      if (faces) out.push({ origin: { x: 0, y: 0, z: 0 }, size: 0, texture, faces });
    }
  } catch {
    // a broken lump only loses reflections
  }
  return out;
}

// ======================================================================== optional game content prefetch

export interface PrefetchOptions {
  /** worldspawn "skyname": its six faces (LDR, and HDR only for faces without an LDR texture). */
  skyName?: string;
  /** More material names to resolve besides the texdata names (e.g. model materials). */
  materials?: string[];
  /** Fetch $detail textures (default true; match BuildMaterialsOptions.detailTextures). */
  detailTextures?: boolean;
  /** Reads in flight at once (default 16). */
  concurrency?: number;
  /** Called after every file read with the number of files read and the number queued so far. */
  onProgress?: (done: number, total: number) => void;
  /** Stops queueing new reads (the files read so far are returned). */
  signal?: AbortSignal;
}

/**
 * Texture/material paths a parsed VMT needs, mirroring what buildMaterial reads: base textures (root and
 * fallback-block), the blend texture, detail, the envmap mask (or the normal map whose alpha is the mask), and
 * the HDR sky textures when `hdr`.
 */
function vmtDependencies(info: VmtInfo, detail: boolean, hdr: boolean): string[] {
  const out: string[] = [];
  const P = info.params;
  const add = (t: string | undefined) => {
    if (t && t.trim()) out.push(vtfPath(t));
  };
  add(P['$basetexture']);
  const root = info.body?.['$basetexture'];
  if (typeof root === 'string') add(root);
  add(P['$basetexture2']);
  if (detail) add(P['$detail']);
  const env = (P['$envmap'] ?? '').trim();
  if (env && env !== '0') {
    if (P['$envmapmask']) add(P['$envmapmask']);
    else if (!vmtBool(P['$basealphaenvmapmask']) && vmtBool(P['$normalmapalphaenvmapmask'])) add(P['$bumpmap'] || P['$normalmap']);
  }
  if (hdr) {
    add(P['$hdrbasetexture']);
    add(P['$hdrcompressedtexture']);
  }
  return out;
}

/** Normalized "materials/<x>.vmt" path of a patch include as written ("concrete/foo", "materials/Concrete/Foo.vmt"). */
function includeVmtPath(inc: string): string {
  let p = normalizePakPath(inc);
  if (!p.endsWith('.vmt')) p += '.vmt';
  if (!p.startsWith('materials/')) p = `materials/${p}`;
  return p;
}

/** True when buildMaterial never loads textures for this material (tools, sky, %compile tool keys). */
function texturelessMaterial(name: string, info: VmtInfo | null): boolean {
  if (isSkyName(name) || (isToolName(name) && name !== 'tools/toolsblack')) return true;
  if (!info) return false;
  const P = info.params;
  return vmtBool(P['%compilesky']) || vmtBool(P['%compile2dsky']) || TOOL_COMPILE_KEYS.some((k) => vmtBool(P[k]));
}

/**
 * Fetches, from `content` (e.g. the player's linked CS:S/CS:GO VPKs), every file buildMaterials/loadSky would
 * need that the pakfile doesn't have: VMTs, patch includes (iteratively: an include may live in the content and
 * include another), base/blend/detail textures, envmap masks and the sky faces (HDR ones only when a face has no
 * LDR texture). Pass the result as `extraSources: [mapFileSource(result)]` — the pakfile stays first, so files
 * packed in the map always win. Never throws for unreadable files (they are left out).
 * The 4th argument may be the sky name alone (older signature).
 */
export async function prefetchMaterialFiles(
  bsp: BspFile,
  pak: PakFile | null,
  content: AsyncMaterialFileSource,
  opts: PrefetchOptions | string = {},
): Promise<Map<string, Uint8Array>> {
  const o: PrefetchOptions = typeof opts === 'string' ? { skyName: opts } : opts;
  const detail = o.detailTextures ?? true;
  const concurrency = Math.max(1, o.concurrency ?? 16);
  const got = new Map<string, Uint8Array>();
  const has = (p: string) => (!!pak && pak.has(p)) || got.has(p);
  const sync: MaterialFileSource = {
    read: (p) => (pak ? pak.read(p) : null) ?? got.get(normalizePakPath(p)) ?? null,
  };
  const requested = new Set<string>();
  let pending: string[] = [];
  let pendingSet = new Set<string>();
  /**
   * Queues `p` when the content has it and nothing earlier in the search order does. 'have': already available;
   * 'queued': being fetched (this round); 'none': not available anywhere (or unreadable).
   */
  const want = (p: string): 'have' | 'queued' | 'none' => {
    const k = normalizePakPath(p);
    if (has(k)) return 'have';
    if (pendingSet.has(k)) return 'queued';
    if (requested.has(k)) return 'none';
    let available = false;
    try {
      available = content.has(k);
    } catch {
      available = false;
    }
    if (!available) return 'none';
    requested.add(k);
    pending.push(k);
    pendingSet.add(k);
    return 'queued';
  };

  let done = 0;
  const report = () => {
    try {
      o.onProgress?.(done, requested.size);
    } catch {
      // progress callbacks must not break loading
    }
  };
  const fetchPending = async () => {
    const list = pending;
    pending = [];
    pendingSet = new Set();
    if (!list.length) return;
    report();
    let i = 0;
    const worker = async () => {
      while (i < list.length && !o.signal?.aborted) {
        const p = list[i++];
        try {
          const d = await content.read(p);
          if (d) got.set(p, d);
        } catch {
          // unreadable file: left out (procedural stand-in)
        }
        done++;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  };

  // ---- the material VMTs (texdata names + extra names) and the sky faces' VMTs
  const materialVmts = new Map<string, string>(); // vmt path -> material name
  for (const raw of [...(bsp.texdataNames ?? []), ...(o.materials ?? [])]) {
    const n = normalizeMaterialName(raw ?? '');
    if (n) materialVmts.set(`materials/${n}.vmt`, n);
  }
  const sky = o.skyName ? normalizePakPath(o.skyName).replace(/^materials\//, '').replace(/^skybox\//, '').replace(/\.vmt$/, '') : '';
  const skyBase = sky.endsWith('_hdr') ? sky.slice(0, -4) : sky;
  const skyBases = sky ? [skyBase, `${skyBase}_hdr`] : [];
  const skyVmts: string[] = [];
  for (const b of skyBases) for (const s of SKY_SUFFIXES) skyVmts.push(`materials/skybox/${b}${s}.vmt`);
  for (const p of [...materialVmts.keys(), ...skyVmts]) want(p);

  let files = new Files([sync]);
  const settled = new Set<string>();
  /** The parsed VMT; null while it (or an include) is still being fetched; 'missing' when it doesn't exist. */
  const resolveVmt = (vmtPath: string): VmtInfo | null | 'missing' => {
    if (pendingSet.has(normalizePakPath(vmtPath))) return null;
    const text = files.readText(vmtPath);
    if (text == null) return 'missing';
    const info = parseVmt(text, (inc) => files.readText(inc));
    // An include that lives in the content: fetch it and parse again next round.
    if (info.includeMissing && want(includeVmtPath(info.includeMissing)) === 'queued') return null;
    return info;
  };

  for (let round = 0; round < 10 && !o.signal?.aborted; round++) {
    await fetchPending();
    files = new Files([sync]); // fresh text cache: files fetched this round must be visible
    for (const [vmtPath, name] of materialVmts) {
      if (settled.has(vmtPath)) continue;
      const info = resolveVmt(vmtPath);
      if (info === null) continue;
      settled.add(vmtPath);
      if (info === 'missing' || texturelessMaterial(name, info)) continue;
      for (const dep of vmtDependencies(info, detail, false)) want(dep);
    }
    let skyReady = true;
    for (const vmtPath of skyVmts) {
      if (settled.has(vmtPath)) continue;
      const info = resolveVmt(vmtPath);
      if (info === null) {
        skyReady = false;
        continue;
      }
      settled.add(vmtPath);
    }
    if (sky && skyReady) {
      // Sky faces, in loadSky's order: the first LDR texture of each face ($basetexture, else "skybox/<sky><face>",
      // under both names), else the first HDR one ($hdrbasetexture, $hdrcompressedtexture).
      for (const s of SKY_SUFFIXES) {
        const ldr: string[] = [];
        const hdr: string[] = [];
        for (const b of skyBases) {
          const text = files.readText(`materials/skybox/${b}${s}.vmt`);
          const info = text != null ? parseVmt(text, (inc) => files.readText(inc)) : null;
          const P = info?.params ?? {};
          if (P['$basetexture']) ldr.push(vtfPath(P['$basetexture']));
          ldr.push(vtfPath(`skybox/${b}${s}`));
          for (const t of [P['$hdrbasetexture'], P['$hdrcompressedtexture']]) if (t) hdr.push(vtfPath(t));
        }
        for (const p of [...ldr, ...hdr]) if (want(p) !== 'none') break;
      }
    }
    if (!pending.length) break;
  }
  return got;
}
