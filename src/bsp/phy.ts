// Studio model collision (.phy "VCollide" files) and the collision hulls of the map's props.
//
// Clean-room reader written from the public descriptions of the format:
//
//   file header   int headerSize (16), int id, int solidCount, long checksum (the .mdl's checksum)
//   solidCount x  int size, then `size` bytes of collide data:
//                   modern:  "VPHY" header (int id, short version, short modelType 0 = compact surface,
//                            int surfaceSize, Vector dragAxisAreas, int axisMapSize) = 28 bytes, followed by
//                   legacy:  (no header) directly
//                 an IVP compact surface:
//                   float mass_center[3], rotation_inertia[3], upper_limit_radius,
//                   int max_factor_surface_deviation:8 | byte_size:24, int offset_ledgetree_root,
//                   int dummy[3] (the last one is "IVPS")                                          = 48 bytes
//                 compact ledges (convex hulls), each: int point_offset (from the ledge), int client data,
//                   int flags (has_children:2 | is_compact:2 | dummy:4 | size_div_16:24), short n_triangles,
//                   short reserved, then n_triangles x 16-byte triangles (int index bits, then three 4-byte
//                   edges whose low 16 bits are the edge's start point index);
//                 the shared point array (float x, y, z, w per point, in IVP space);
//                 the ledge tree: 28-byte nodes (int offset_right_node (0 = leaf), int offset_compact_ledge,
//                   float center[3], float radius, byte box_sizes[3], byte pad). The left child follows its
//                   parent; inner nodes reference the convex hull of their subtree, leaves the real ledges.
//   text          keyvalues blocks after the last solid (solid { "index" .. "surfaceprop" .. } editparams {...})
//
// IVP space is metric and Y-down: Source (x, y, z) = (ivp.x, ivp.z, -ivp.y) / 0.0254 (verified against the
// .mdl hull bounds of every packed model of the test maps).
//
// Prop collision (buildPropCollision) follows the engine's traces: a prop_static whose solid type is
// SOLID_VPHYSICS (6) collides with the convex pieces of the first solid of its model's .phy, placed by the prop's
// origin, angles and (sprp v11+) uniform scale; without a collision model nothing is traced (a SOLID_VPHYSICS
// model with no .phy is not solid); SOLID_BBOX (2) props collide with the world-aligned box around their model
// bounds. Model entities (prop_dynamic...) do the same with their "solid" keyvalue. Every hull becomes a convex
// Brush with bevel planes, so box traces against props behave exactly like traces against brushes: contents
// from the model's $contents (CONTENTS_SOLID), brush model PROP_COLLISION_MODEL (treated as world by the game,
// switchable as a group). Model hulls are built once per model and only placed per prop. Nothing here may break
// map loading: unparseable data is skipped.
import type { QAngle } from '../core/angles';
import { Vec3, v3 } from '../core/vec3';
import type { MapEntity } from '../map/types';
import { brushFromBox, brushFromPlanes, brushWindings } from '../physics/brushbuild';
import { Brush, BrushSide, CONTENTS_SOLID, Plane } from '../physics/types';
import { normalizePakPath } from './pakfile';
import { PROP_COLLISION_MODEL, parseStaticPropLump, readStudioHeader, StudioHeader } from './props';
import type { BspFile } from './types';

export { PROP_COLLISION_MODEL };

/** Inches per IVP unit (metres). */
export const IVP_TO_INCHES = 1 / 0.0254;

const VPHY_ID = 0x59485056; // "VPHY" little-endian
const IVPS_ID = 0x53505649; // "IVPS"
const COMPACT_SURFACE_SIZE = 48;
const LEDGE_HEADER_SIZE = 16;
const TRIANGLE_SIZE = 16;
const POINT_SIZE = 16;
const NODE_SIZE = 28;

/** One convex piece of a collide solid (an IVP compact ledge), in Source model space. */
export interface PhyConvex {
  /** Hull vertices (inches, Source axes), xyz per vertex; only the points the triangles use. */
  points: Float64Array;
  /** Hull triangles, three indices into `points` each (winding as stored). */
  triangles: Uint32Array;
}

export interface PhySolid {
  /** Index of the solid in the file. */
  index: number;
  /** True for the legacy layout (no "VPHY" header). */
  legacy: boolean;
  convexes: PhyConvex[];
  /** Bounds of all convex points (inches); mins > maxs when there are none. */
  mins: Vec3;
  maxs: Vec3;
  /** "surfaceprop" of the solid's keyvalues block, when present. */
  surfaceprop?: string;
}

export interface PhyFile {
  /** Solid count from the header. */
  solidCount: number;
  /** Checksum from the header (matches the .mdl's). */
  checksum: number;
  /** The solids that could be read (unsupported or broken ones are left out: see warnings). */
  solids: PhySolid[];
  /** The keyvalues text after the solids. */
  text: string;
  warnings: string[];
}

interface Reader {
  dv: DataView;
  len: number;
}

function i32(r: Reader, o: number): number {
  return o >= 0 && o + 4 <= r.len ? r.dv.getInt32(o, true) : 0;
}

/**
 * Reads one compact ledge at `l` (bounded by `end`) as a convex: the points its triangles use, converted to
 * Source space. Null when the ledge is malformed.
 */
function readLedge(r: Reader, l: number, end: number): PhyConvex | null {
  if (l < 0 || l + LEDGE_HEADER_SIZE > end) return null;
  const pointBase = l + r.dv.getInt32(l, true);
  const nTri = r.dv.getInt16(l + 12, true);
  if (nTri <= 0 || l + LEDGE_HEADER_SIZE + nTri * TRIANGLE_SIZE > end) return null;
  const remap = new Map<number, number>();
  const tris = new Uint32Array(nTri * 3);
  const used: number[] = [];
  for (let t = 0; t < nTri; t++) {
    const to = l + LEDGE_HEADER_SIZE + t * TRIANGLE_SIZE;
    for (let e = 0; e < 3; e++) {
      const idx = r.dv.getUint16(to + 4 + e * 4, true);
      let k = remap.get(idx);
      if (k === undefined) {
        k = used.length;
        remap.set(idx, k);
        used.push(idx);
      }
      tris[t * 3 + e] = k;
    }
  }
  const points = new Float64Array(used.length * 3);
  for (let k = 0; k < used.length; k++) {
    const po = pointBase + used[k] * POINT_SIZE;
    if (po < 0 || po + 12 > end) return null;
    const x = r.dv.getFloat32(po, true);
    const y = r.dv.getFloat32(po + 4, true);
    const z = r.dv.getFloat32(po + 8, true);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    points[k * 3] = x * IVP_TO_INCHES;
    points[k * 3 + 1] = z * IVP_TO_INCHES;
    points[k * 3 + 2] = -y * IVP_TO_INCHES;
  }
  return { points, triangles: tris };
}

/** Leaf ledge offsets of the ledge tree rooted at `root`, or null when the tree is unusable. */
function treeLedges(r: Reader, root: number, start: number, end: number): number[] | null {
  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n < start || n + NODE_SIZE > end || seen.has(n)) return null;
    seen.add(n);
    if (seen.size > 1 << 20) return null;
    const right = r.dv.getInt32(n, true);
    const ledge = r.dv.getInt32(n + 4, true);
    if (right === 0) {
      out.push(n + ledge);
    } else {
      stack.push(n + right);
      stack.push(n + NODE_SIZE);
    }
  }
  return out;
}

/** Ledges laid out back to back after the compact surface header (used when there is no usable tree). */
function sequentialLedges(r: Reader, start: number, end: number): number[] {
  const out: number[] = [];
  let limit = end;
  let l = start + COMPACT_SURFACE_SIZE;
  while (l + LEDGE_HEADER_SIZE <= limit) {
    const pointBase = l + r.dv.getInt32(l, true);
    const flags = r.dv.getUint32(l + 8, true);
    const nTri = r.dv.getInt16(l + 12, true);
    if (nTri <= 0 || pointBase <= l || pointBase > end) break;
    limit = Math.min(limit, pointBase);
    if ((flags & 3) === 0) out.push(l);
    l += LEDGE_HEADER_SIZE + nTri * TRIANGLE_SIZE;
  }
  return out;
}

/** Parses the compact surface at `s` (collide data ends at `end`). */
function readCompactSurface(r: Reader, s: number, end: number, index: number, legacy: boolean, warnings: string[]): PhySolid | null {
  if (s + COMPACT_SURFACE_SIZE > end) {
    warnings.push(`solid ${index}: truncated compact surface`);
    return null;
  }
  const byteSize = r.dv.getUint32(s + 28, true) >>> 8;
  const surfEnd = byteSize >= COMPACT_SURFACE_SIZE && s + byteSize <= end ? s + byteSize : end;
  const rootOff = r.dv.getInt32(s + 32, true);
  let ledges: number[] | null = null;
  if (rootOff >= COMPACT_SURFACE_SIZE && s + rootOff + NODE_SIZE <= surfEnd) ledges = treeLedges(r, s + rootOff, s + COMPACT_SURFACE_SIZE, surfEnd);
  if (!ledges || !ledges.length) ledges = sequentialLedges(r, s, surfEnd);
  const convexes: PhyConvex[] = [];
  const mins = v3(Infinity, Infinity, Infinity);
  const maxs = v3(-Infinity, -Infinity, -Infinity);
  let bad = 0;
  const seen = new Set<number>();
  for (const l of ledges) {
    if (seen.has(l)) continue;
    seen.add(l);
    const c = readLedge(r, l, surfEnd);
    if (!c) {
      bad++;
      continue;
    }
    convexes.push(c);
    const p = c.points;
    for (let k = 0; k < p.length; k += 3) {
      if (p[k] < mins.x) mins.x = p[k];
      if (p[k] > maxs.x) maxs.x = p[k];
      if (p[k + 1] < mins.y) mins.y = p[k + 1];
      if (p[k + 1] > maxs.y) maxs.y = p[k + 1];
      if (p[k + 2] < mins.z) mins.z = p[k + 2];
      if (p[k + 2] > maxs.z) maxs.z = p[k + 2];
    }
  }
  if (bad) warnings.push(`solid ${index}: ${bad} unreadable convex pieces skipped`);
  if (!convexes.length) {
    warnings.push(`solid ${index}: no convex pieces`);
    return null;
  }
  return { index, legacy, convexes, mins, maxs };
}

/** Per-solid "surfaceprop" from the keyvalues text ("solid { "index" "0" ... "surfaceprop" "metal" }"). */
function solidSurfaceProps(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const tokens = text.match(/"[^"]*"|[{}]|[^\s{}"]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() !== 'solid' || tokens[i + 1] !== '{') continue;
    let index = -1;
    let prop: string | undefined;
    let j = i + 2;
    for (; j + 1 < tokens.length && tokens[j] !== '}'; j += 2) {
      const k = tokens[j].replace(/"/g, '').toLowerCase();
      const v = tokens[j + 1].replace(/"/g, '');
      if (k === 'index') index = parseInt(v, 10);
      else if (k === 'surfaceprop') prop = v;
    }
    if (index >= 0 && prop !== undefined && !out.has(index)) out.set(index, prop);
    i = j;
  }
  return out;
}

/**
 * Parses a .phy file. Returns null when the data isn't a collide file at all; solids that can't be read
 * (unsupported model types, corrupt data) are skipped with a warning. Never throws.
 */
export function parsePhy(data: Uint8Array): PhyFile | null {
  try {
    return parsePhyUnsafe(data);
  } catch {
    return null;
  }
}

function parsePhyUnsafe(data: Uint8Array): PhyFile | null {
  if (data.length < 16) return null;
  const r: Reader = { dv: new DataView(data.buffer, data.byteOffset, data.byteLength), len: data.length };
  const headerSize = i32(r, 0);
  const solidCount = i32(r, 8);
  const checksum = i32(r, 12);
  if (headerSize < 16 || headerSize > 1024 || headerSize >= data.length || solidCount < 0 || solidCount > 1024) return null;
  const warnings: string[] = [];
  const solids: PhySolid[] = [];
  let o = headerSize;
  for (let s = 0; s < solidCount; s++) {
    if (o + 4 > data.length) {
      warnings.push(`solid ${s}: truncated file`);
      break;
    }
    const size = r.dv.getInt32(o, true);
    const blob = o + 4;
    const end = blob + size;
    if (size <= 0 || end > data.length) {
      warnings.push(`solid ${s}: bad size ${size}`);
      break;
    }
    o = end;
    let solid: PhySolid | null = null;
    if (size >= 28 && r.dv.getUint32(blob, true) === VPHY_ID) {
      const modelType = r.dv.getInt16(blob + 6, true);
      if (modelType !== 0) {
        warnings.push(`solid ${s}: unsupported collide model type ${modelType}`);
        continue;
      }
      solid = readCompactSurface(r, blob + 28, end, s, false, warnings);
    } else {
      // legacy layout: the compact surface starts right away ("IVPS" in its last header word)
      if (size >= COMPACT_SURFACE_SIZE && r.dv.getUint32(blob + 44, true) !== IVPS_ID) warnings.push(`solid ${s}: legacy collide without IVPS id`);
      solid = readCompactSurface(r, blob, end, s, true, warnings);
    }
    if (solid) solids.push(solid);
  }
  let text = '';
  if (o < data.length) {
    let e = data.length;
    while (e > o && data[e - 1] === 0) e--;
    for (let i = o; i < e; i++) text += String.fromCharCode(data[i]);
  }
  if (text) {
    const props = solidSurfaceProps(text);
    for (const s of solids) {
      const p = props.get(s.index);
      if (p !== undefined) s.surfaceprop = p;
    }
  }
  return { solidCount, checksum, solids, text, warnings };
}

// ------------------------------------------------------------------------------------------ hull planes

/** Triangles whose doubled area is below this (square inches) don't define a face plane. */
const MIN_TRI_CROSS = 1e-6;
/** A triangle whose corners all lie within this distance of a face plane already found belongs to that face. */
const FACE_ON_EPSILON = 0.01;
/** ... provided its normal is this close (cosine) to the face's. */
const FACE_MERGE_COS = 0.99;

/**
 * Outward face planes of a convex piece (model space). The hull triangles are grouped into faces - largest
 * first, a triangle joins a face when its corners lie on the face plane (within FACE_ON_EPSILON): the stored
 * points are float metres, so the triangles of one flat face disagree slightly, and nearly parallel duplicate
 * planes would make the brush builder drop real faces. Each face gets the area-weighted normal of its
 * triangles, at the support distance of the hull points (every point lies on or behind every plane).
 */
export function convexPlanes(c: PhyConvex): Plane[] {
  const p = c.points;
  const n = p.length / 3;
  if (n < 4) return [];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let k = 0; k < n; k++) {
    cx += p[k * 3];
    cy += p[k * 3 + 1];
    cz += p[k * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const support = (nx: number, ny: number, nz: number): number => {
    let dist = -Infinity;
    for (let k = 0; k < n; k++) {
      const dd = nx * p[k * 3] + ny * p[k * 3 + 1] + nz * p[k * 3 + 2];
      if (dd > dist) dist = dd;
    }
    return dist;
  };
  const cand: { nx: number; ny: number; nz: number; area: number; a: number; b: number; d: number }[] = [];
  const T = c.triangles;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3;
    const b = T[t + 1] * 3;
    const d = T[t + 2] * 3;
    const e1x = p[b] - p[a];
    const e1y = p[b + 1] - p[a + 1];
    const e1z = p[b + 2] - p[a + 2];
    const e2x = p[d] - p[a];
    const e2y = p[d + 1] - p[a + 1];
    const e2z = p[d + 2] - p[a + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(l > MIN_TRI_CROSS)) continue;
    nx /= l;
    ny /= l;
    nz /= l;
    // outward: the centroid is behind the face
    if (nx * (cx - p[a]) + ny * (cy - p[a + 1]) + nz * (cz - p[a + 2]) > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    cand.push({ nx, ny, nz, area: l, a, b, d });
  }
  cand.sort((u, w) => w.area - u.area);
  const faces: { nx: number; ny: number; nz: number; dist: number; sx: number; sy: number; sz: number }[] = [];
  for (const f of cand) {
    let home = null;
    for (const q of faces) {
      if (q.nx * f.nx + q.ny * f.ny + q.nz * f.nz < FACE_MERGE_COS) continue;
      const on = (i: number) => Math.abs(q.nx * p[i] + q.ny * p[i + 1] + q.nz * p[i + 2] - q.dist) <= FACE_ON_EPSILON;
      if (on(f.a) && on(f.b) && on(f.d)) {
        home = q;
        break;
      }
    }
    if (home) {
      home.sx += f.nx * f.area;
      home.sy += f.ny * f.area;
      home.sz += f.nz * f.area;
    } else {
      faces.push({ nx: f.nx, ny: f.ny, nz: f.nz, dist: support(f.nx, f.ny, f.nz), sx: f.nx * f.area, sy: f.ny * f.area, sz: f.nz * f.area });
    }
  }
  const planes: Plane[] = [];
  for (const q of faces) {
    const l = Math.sqrt(q.sx * q.sx + q.sy * q.sy + q.sz * q.sz);
    const nx = snap(q.sx / l);
    const ny = snap(q.sy / l);
    const nz = snap(q.sz / l);
    planes.push({ normal: v3(nx, ny, nz), dist: support(nx, ny, nz) });
  }
  return planes;
}

function snap(c: number): number {
  if (Math.abs(c) < 1e-12) return 0;
  if (Math.abs(c - 1) < 1e-12) return 1;
  if (Math.abs(c + 1) < 1e-12) return -1;
  return c;
}

/** Brush of a convex piece in model space (bevels for the model axes), or null when degenerate. */
export function convexBrush(c: PhyConvex, contents = CONTENTS_SOLID, model = 0): Brush | null {
  return brushFromPlanes(convexPlanes(c), contents, model);
}

// ------------------------------------------------------------------------------------------ placement

/**
 * A rigid placement: world = R * (scale * local) + origin, R's columns being Source's forward, left and up
 * vectors of `angles` (AngleMatrix). `perm` marks a signed permutation matrix (rotations by multiples of 90
 * degrees about the axes): axial planes stay axial, so model-space bevels stay valid bevels.
 */
export interface Placement {
  origin: Vec3;
  /** Row-major 3x3. */
  m: number[];
  scale: number;
  perm: boolean;
}

function snapUnit(c: number): number {
  if (Math.abs(c) < 1e-9) return 0;
  if (Math.abs(c - 1) < 1e-9) return 1;
  if (Math.abs(c + 1) < 1e-9) return -1;
  return c;
}

export function placement(origin: Vec3, angles: QAngle, scale = 1): Placement {
  const d = Math.PI / 180;
  const sy = Math.sin(angles.yaw * d);
  const cy = Math.cos(angles.yaw * d);
  const sp = Math.sin(angles.pitch * d);
  const cp = Math.cos(angles.pitch * d);
  const sr = Math.sin(angles.roll * d);
  const cr = Math.cos(angles.roll * d);
  // columns: forward, left, up
  const F = [cp * cy, cp * sy, -sp];
  const L = [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp];
  const U = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  const m = [F[0], L[0], U[0], F[1], L[1], U[1], F[2], L[2], U[2]].map(snapUnit);
  const perm = m.every((x) => x === 0 || x === 1 || x === -1);
  return { origin: v3(origin.x, origin.y, origin.z), m, scale: scale > 0 && Number.isFinite(scale) ? scale : 1, perm };
}

/** World position of model-space point (x, y, z). */
function placePoint(t: Placement, x: number, y: number, z: number, out: Vec3): Vec3 {
  const m = t.m;
  const s = t.scale;
  out.x = (m[0] * x + m[1] * y + m[2] * z) * s + t.origin.x;
  out.y = (m[3] * x + m[4] * y + m[5] * z) * s + t.origin.y;
  out.z = (m[6] * x + m[7] * y + m[8] * z) * s + t.origin.z;
  return out;
}

/** World AABB of the placed model-space box [lo, hi]. */
function placedBounds(t: Placement, lo: Vec3, hi: Vec3): { mins: Vec3; maxs: Vec3 } {
  const mins = v3(Infinity, Infinity, Infinity);
  const maxs = v3(-Infinity, -Infinity, -Infinity);
  const w = v3();
  for (let i = 0; i < 8; i++) {
    placePoint(t, i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z, w);
    if (w.x < mins.x) mins.x = w.x;
    if (w.x > maxs.x) maxs.x = w.x;
    if (w.y < mins.y) mins.y = w.y;
    if (w.y > maxs.y) maxs.y = w.y;
    if (w.z < mins.z) mins.z = w.z;
    if (w.z > maxs.z) maxs.z = w.z;
  }
  return { mins, maxs };
}

function transformPlane(p: Plane, t: Placement): Plane {
  const m = t.m;
  const n = p.normal;
  const nx = m[0] * n.x + m[1] * n.y + m[2] * n.z;
  const ny = m[3] * n.x + m[4] * n.y + m[5] * n.z;
  const nz = m[6] * n.x + m[7] * n.y + m[8] * n.z;
  return { normal: v3(nx, ny, nz), dist: p.dist * t.scale + nx * t.origin.x + ny * t.origin.y + nz * t.origin.z };
}

/** A convex piece cached in model space. */
export interface CachedConvex {
  /** Face planes (model space). */
  planes: Plane[];
  /** Model-space brush with bevels (null when the planes don't enclose a volume). */
  brush: Brush | null;
  /** Real (non-bevel) sides of `brush`, model space. */
  faces: Plane[];
  /** Hull vertices (the corners of the face windings), xyz per vertex, model space. */
  verts: Float64Array;
  /** Hull edges as vertex index pairs (each edge once). */
  edges: Int32Array;
}

/** Vertices closer than this (model units) are the same hull corner. */
const VERT_WELD = 1e-3;

/**
 * Caches a convex piece (model space): its brush, faces, corners and edges; null when degenerate.
 * `planes` may be given instead of the piece (e.g. a box).
 */
export function cacheConvex(c: PhyConvex | Plane[], contents = CONTENTS_SOLID): CachedConvex | null {
  const planes = Array.isArray(c) ? c : convexPlanes(c);
  const brush = brushFromPlanes(planes, contents, 0);
  if (!brush) return null;
  const faces: Plane[] = [];
  const vx: number[] = [];
  const edgeSet = new Set<number>();
  const edges: number[] = [];
  const windings = brushWindings(brush);
  const vertex = (p: Vec3): number => {
    for (let k = 0; k < vx.length; k += 3) {
      if (Math.abs(vx[k] - p.x) < VERT_WELD && Math.abs(vx[k + 1] - p.y) < VERT_WELD && Math.abs(vx[k + 2] - p.z) < VERT_WELD) return k / 3;
    }
    vx.push(p.x, p.y, p.z);
    return vx.length / 3 - 1;
  };
  for (let i = 0; i < brush.sides.length; i++) {
    const s = brush.sides[i];
    if (s.bevel) continue;
    faces.push(s.plane);
    const w = windings[i];
    if (!w || w.length < 3) continue;
    const ids = w.map(vertex);
    for (let k = 0; k < ids.length; k++) {
      const a = ids[k];
      const b = ids[(k + 1) % ids.length];
      if (a === b) continue;
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push(a, b);
    }
  }
  if (vx.length < 12) return null;
  return { planes, brush, faces, verts: Float64Array.from(vx), edges: Int32Array.from(edges) };
}

// Bevel tolerances, as the brush builders use them (physics/brushbuild.ts).
const BEVEL_MIN_EDGE = 0.01;
const BEVEL_MIN_CROSS = 1e-3;
const BEVEL_ON_EPSILON = 0.01;
const AXIAL_EPSILON = 1e-9;
const NORMAL_EPSILON = 1e-5;
const DIST_EQUAL_EPSILON = 0.01;

const scratchVerts: { buf: Float64Array } = { buf: new Float64Array(3 * 256) };

/**
 * The world brush of a cached convex piece placed by `t`. Rotations by multiples of 90 degrees move the cached
 * brush (bevels included: they stay exact). Other rotations move the faces and hull corners and rebuild the
 * world-axis bevels from them, the way the brush builders do (axial planes at the bounds - reusing exactly axial
 * faces - first, then the faces, then the edge bevels: planes through a hull edge, parallel to a world axis,
 * that support the hull), without re-clipping the face windings.
 */
export function placeConvex(hull: CachedConvex, t: Placement, contents: number, model = 0): Brush | null {
  const b = hull.brush;
  if (!b) return null;
  if (t.perm) {
    const sides: BrushSide[] = b.sides.map((s) => ({ plane: transformPlane(s.plane, t), bevel: s.bevel }));
    const { mins, maxs } = placedBounds(t, b.mins, b.maxs);
    return { sides, contents, mins, maxs, model };
  }
  // world corners + bounds
  const nv = hull.verts.length / 3;
  if (scratchVerts.buf.length < nv * 3) scratchVerts.buf = new Float64Array(nv * 3 * 2);
  const W = scratchVerts.buf;
  const m = t.m;
  const s = t.scale;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < nv; k++) {
    const x = hull.verts[k * 3];
    const y = hull.verts[k * 3 + 1];
    const z = hull.verts[k * 3 + 2];
    for (let a = 0; a < 3; a++) {
      const w = (m[a * 3] * x + m[a * 3 + 1] * y + m[a * 3 + 2] * z) * s + (a === 0 ? t.origin.x : a === 1 ? t.origin.y : t.origin.z);
      W[k * 3 + a] = w;
      if (w < lo[a]) lo[a] = w;
      if (w > hi[a]) hi[a] = w;
    }
  }
  const faces = hull.faces.map((p) => transformPlane(p, t));
  // axial planes first (-x +x -y +y -z +z), reusing exactly axial faces at the bounds
  const used = new Uint8Array(faces.length);
  const sides: BrushSide[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let dir = -1; dir <= 1; dir += 2) {
      const extent = dir < 0 ? -lo[axis] : hi[axis];
      let found = -1;
      let foundErr = Infinity;
      for (let i = 0; i < faces.length; i++) {
        if (used[i]) continue;
        const n = faces[i].normal;
        const c = [n.x, n.y, n.z];
        if (Math.abs(c[axis] - dir) > AXIAL_EPSILON || Math.abs(c[(axis + 1) % 3]) > AXIAL_EPSILON || Math.abs(c[(axis + 2) % 3]) > AXIAL_EPSILON) continue;
        const err = Math.abs(faces[i].dist - extent);
        if (err <= DIST_EQUAL_EPSILON && err < foundErr) {
          found = i;
          foundErr = err;
        }
      }
      if (found >= 0) {
        used[found] = 1;
        sides.push({ plane: faces[found], bevel: false });
      } else {
        sides.push({ plane: { normal: v3(axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0), dist: extent }, bevel: true });
      }
    }
  }
  for (let i = 0; i < faces.length; i++) if (!used[i]) sides.push({ plane: faces[i], bevel: false });
  // edge bevels
  const E = hull.edges;
  for (let e = 0; e < E.length; e += 2) {
    const i = E[e] * 3;
    const j = E[e + 1] * 3;
    let ex = W[j] - W[i];
    let ey = W[j + 1] - W[i + 1];
    let ez = W[j + 2] - W[i + 2];
    const elen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (elen < BEVEL_MIN_EDGE) continue;
    ex /= elen;
    ey /= elen;
    ez /= elen;
    if (Math.abs(ex) < 1e-9) ex = 0;
    if (Math.abs(ey) < 1e-9) ey = 0;
    if (Math.abs(ez) < 1e-9) ez = 0;
    for (let axis = 0; axis < 3; axis++) {
      for (let dir = -1; dir <= 1; dir += 2) {
        // n = edge x (dir * axis)
        let nx: number;
        let ny: number;
        let nz: number;
        if (axis === 0) {
          nx = 0;
          ny = ez * dir;
          nz = -ey * dir;
        } else if (axis === 1) {
          nx = -ez * dir;
          ny = 0;
          nz = ex * dir;
        } else {
          nx = ey * dir;
          ny = -ex * dir;
          nz = 0;
        }
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl < BEVEL_MIN_CROSS) continue;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        if (Math.abs(nx) > 1 - AXIAL_EPSILON || Math.abs(ny) > 1 - AXIAL_EPSILON || Math.abs(nz) > 1 - AXIAL_EPSILON) continue;
        // the plane must touch the hull along this edge
        const d1 = W[i] * nx + W[i + 1] * ny + W[i + 2] * nz;
        const d2 = W[j] * nx + W[j + 1] * ny + W[j + 2] * nz;
        let dist = -Infinity;
        let ok = true;
        for (let k = 0; k < nv * 3; k += 3) {
          const d = W[k] * nx + W[k + 1] * ny + W[k + 2] * nz;
          if (d > dist) {
            dist = d;
            if (d1 < dist - BEVEL_ON_EPSILON || d2 < dist - BEVEL_ON_EPSILON) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) continue;
        let dup = false;
        for (let q = 0; q < sides.length; q++) {
          const on = sides[q].plane.normal;
          if (Math.abs(on.x - nx) < NORMAL_EPSILON && Math.abs(on.y - ny) < NORMAL_EPSILON && Math.abs(on.z - nz) < NORMAL_EPSILON) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
        sides.push({ plane: { normal: v3(nx, ny, nz), dist }, bevel: true });
      }
    }
  }
  return { sides, contents, mins: v3(lo[0] + 0, lo[1] + 0, lo[2] + 0), maxs: v3(hi[0] + 0, hi[1] + 0, hi[2] + 0), model };
}

// ------------------------------------------------------------------------------------------ prop collision

/** Solid types (SolidType_t). */
export const SOLID_NONE = 0;
export const SOLID_BSP = 1;
export const SOLID_BBOX = 2;
export const SOLID_OBB = 3;
export const SOLID_VPHYSICS = 6;

/** Where model files come from (the pakfile, linked game content...). */
export interface ModelFileSource {
  read(path: string): Uint8Array | null;
}

/** Collision data of one model, shared by all its placements. */
export interface ModelCollision {
  header: StudioHeader | null;
  /** Convex pieces of the first collide solid; null without a usable .phy. */
  convexes: CachedConvex[] | null;
  /** The model bounds (studio hull box, else the view box), model space; null when empty. */
  boxMin: Vec3 | null;
  boxMax: Vec3 | null;
  /** Contents traces see ($contents of the model; CONTENTS_SOLID when only the .phy is available). */
  contents: number;
}

export interface PropCollisionOptions {
  /** Extra model sources after the given ones (e.g. linked game content). */
  extraSources?: ModelFileSource[];
  /** Brush model number of the hulls (default PROP_COLLISION_MODEL). */
  model?: number;
  warnings?: string[];
}

export interface PropCollisionStats {
  /** Solid prop placements considered (static props + model entities). */
  solidProps: number;
  /** Placements colliding with .phy convex hulls. */
  vphysics: number;
  /** Placements colliding with their model's box (SOLID_BBOX / SOLID_OBB). */
  boxes: number;
  /** SOLID_VPHYSICS placements whose model has no collision model (the engine traces nothing for them). */
  noCollisionModel: number;
  /** Placements whose model isn't available at all. */
  missingModel: number;
  /** Brushes produced. */
  brushes: number;
  /** Models with a readable .phy. */
  phyModels: number;
}

export interface PropCollision {
  brushes: Brush[];
  stats: PropCollisionStats;
}

/** One solid prop placement. */
export interface SolidPropPlacement {
  model: string;
  origin: Vec3;
  angles: QAngle;
  scale: number;
  solid: number;
  /** Model entity (true) or static prop (false). */
  entity: boolean;
}

/** Model entity classes that collide when their "solid" keyvalue says so. */
const SOLID_ENTITY_CLASSES = new Set([
  'prop_dynamic',
  'prop_dynamic_override',
  'prop_dynamic_glow',
  'dynamic_prop',
  'prop_physics',
  'prop_physics_override',
  'prop_physics_multiplayer',
  'physics_prop',
]);

/**
 * Solid placements of the map's static props (sprp lump, solid type per prop) and model entities (the classes
 * above with a .mdl model and "solid" != 0 - default 6, as Hammer writes it - unless StartDisabled; a
 * prop_physics_multiplayer in physicsmode 2/3 doesn't block players).
 */
export function solidPropPlacements(bsp: BspFile, entities: MapEntity[], warnings?: string[]): SolidPropPlacement[] {
  const out: SolidPropPlacement[] = [];
  const lump = bsp.gameLumps.find((g) => g.id === 'sprp');
  if (lump && lump.data.length >= 12) {
    try {
      const sp = parseStaticPropLump(lump.data, lump.version);
      for (const p of sp.props) {
        if (p.solid === SOLID_NONE || !p.model) continue;
        out.push({ model: p.model, origin: p.origin, angles: p.angles, scale: p.scale, solid: p.solid, entity: false });
      }
    } catch (e) {
      warnings?.push(`static prop collision: ${(e as Error).message}`);
    }
  }
  for (const e of entities) {
    const cls = e.classname.toLowerCase();
    if (!SOLID_ENTITY_CLASSES.has(cls)) continue;
    const model = (e.kv.model ?? '').trim();
    if (!/\.mdl$/i.test(model)) continue;
    if ((e.kv.startdisabled ?? '0').trim() === '1') continue;
    const solid = e.kv.solid !== undefined && e.kv.solid.trim() !== '' ? parseInt(e.kv.solid, 10) : SOLID_VPHYSICS;
    if (!Number.isFinite(solid) || solid === SOLID_NONE) continue;
    if (cls === 'prop_physics_multiplayer') {
      const mode = parseInt(e.kv.physicsmode ?? '0', 10) || 0;
      if (mode === 2 || mode === 3) continue;
    }
    const o = e.origin;
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) continue;
    out.push({
      model,
      origin: { x: o.x, y: o.y, z: o.z },
      angles: { pitch: e.angles.pitch || 0, yaw: e.angles.yaw || 0, roll: e.angles.roll || 0 },
      // the render-only "modelscale" doesn't scale collision
      scale: 1,
      solid,
      entity: true,
    });
  }
  return out;
}

const NO_ROTATION: QAngle = { pitch: 0, yaw: 0, roll: 0 };

/**
 * Builds each model's collision once (parse .phy, hull planes, model-space brushes) and places it per prop.
 *
 * How a placement collides (engine trace semantics: a trace against a model tests the type its solid says):
 * - SOLID_VPHYSICS (6): the convex pieces of the first solid of the model's .phy at the placement. Without a
 *   collision model nothing is traced: no collision (surf_aircontrol_ksf flies the player through the middle
 *   of such a model's hull box).
 * - SOLID_BBOX (2): the world-aligned model box: for static props the bounds of the rotated box, for
 *   entities the unrotated box around the origin.
 * - SOLID_OBB (3): the oriented model box.
 * A model whose $contents is 0 never collides.
 */
export class PropCollisionBuilder {
  private readonly models = new Map<string, ModelCollision | null>();
  readonly brushes: Brush[] = [];
  readonly stats: PropCollisionStats = { solidProps: 0, vphysics: 0, boxes: 0, noCollisionModel: 0, missingModel: 0, brushes: 0, phyModels: 0 };
  private readonly missing = new Set<string>();
  private readonly noPhy = new Set<string>();

  /**
   * `sources`: where model files are read from, in order. `brushModel`: the brush model number of the hulls
   * (default PROP_COLLISION_MODEL).
   */
  constructor(
    private readonly sources: ModelFileSource[],
    private readonly brushModel = PROP_COLLISION_MODEL,
  ) {}

  private read(path: string): Uint8Array | null {
    for (const s of this.sources) {
      try {
        const d = s.read(path);
        if (d && d.length) return d;
      } catch {
        // next source
      }
    }
    return null;
  }

  /** Collision data of a model (cached; null when neither its .mdl nor its .phy can be read). */
  model(path: string): ModelCollision | null {
    const key = normalizePakPath(path);
    if (this.models.has(key)) return this.models.get(key)!;
    let mc: ModelCollision | null = null;
    try {
      mc = this.loadModel(key);
    } catch {
      mc = null;
    }
    this.models.set(key, mc);
    return mc;
  }

  private loadModel(key: string): ModelCollision | null {
    const base = key.replace(/\.mdl$/, '');
    const mdl = this.read(key);
    const header = mdl ? readStudioHeader(mdl) : null;
    const contents = header ? header.contents : CONTENTS_SOLID;
    const phyData = this.read(`${base}.phy`);
    if (!header && !phyData) return null;
    let convexes: CachedConvex[] | null = null;
    if (phyData) {
      // traces use the first solid (multi-solid models are ragdolls / jointed models)
      const solid = parsePhy(phyData)?.solids.find((s) => s.index === 0);
      if (solid) {
        convexes = [];
        for (const c of solid.convexes) {
          const cc = cacheConvex(c, contents);
          if (cc) convexes.push(cc);
        }
        if (convexes.length) this.stats.phyModels++;
        else convexes = null;
      }
    }
    let boxMin: Vec3 | null = null;
    let boxMax: Vec3 | null = null;
    if (header) {
      // the engine's model bounds are the studio hull box; models without one use the view box
      for (const [lo, hi] of [
        [header.hullMin, header.hullMax],
        [header.viewMin, header.viewMax],
      ]) {
        if (hi.x > lo.x && hi.y > lo.y && hi.z > lo.z) {
          boxMin = v3(lo.x, lo.y, lo.z);
          boxMax = v3(hi.x, hi.y, hi.z);
          break;
        }
      }
    }
    return { header, convexes, boxMin, boxMax, contents };
  }

  add(p: SolidPropPlacement): void {
    this.stats.solidProps++;
    const mc = this.model(p.model);
    if (!mc) {
      this.stats.missingModel++;
      this.missing.add(normalizePakPath(p.model));
      return;
    }
    if (!mc.contents) return;
    if (p.solid === SOLID_BBOX || p.solid === SOLID_OBB) {
      if (!mc.boxMin || !mc.boxMax) return;
      let b: Brush | null;
      if (p.solid === SOLID_OBB) {
        const box = cacheConvex(boxPlanes(mc.boxMin, mc.boxMax), mc.contents);
        b = box ? placeConvex(box, placement(p.origin, p.angles, p.scale), mc.contents, this.brushModel) : null;
      } else {
        const w = placedBounds(placement(p.origin, p.entity ? NO_ROTATION : p.angles, p.scale), mc.boxMin, mc.boxMax);
        b = brushFromBox(w.mins, w.maxs, mc.contents, this.brushModel);
      }
      if (b) {
        this.brushes.push(b);
        this.stats.brushes++;
        this.stats.boxes++;
      }
      return;
    }
    if (p.solid !== SOLID_VPHYSICS && p.solid !== SOLID_BSP) return;
    if (!mc.convexes) {
      this.stats.noCollisionModel++;
      this.noPhy.add(normalizePakPath(p.model));
      return;
    }
    const t = placement(p.origin, p.angles, p.scale);
    for (const c of mc.convexes) {
      const b = placeConvex(c, t, mc.contents, this.brushModel);
      if (b) {
        this.brushes.push(b);
        this.stats.brushes++;
      }
    }
    this.stats.vphysics++;
  }

  report(warnings?: string[]): void {
    if (!warnings) return;
    const list = (s: Set<string>) => [...s].slice(0, 3).join(', ') + (s.size > 3 ? ', ...' : '');
    if (this.missing.size) warnings.push(`${this.stats.missingModel} solid props use ${this.missing.size} models that are not available (no collision): ${list(this.missing)}`);
    if (this.noPhy.size) warnings.push(`${this.stats.noCollisionModel} solid props use ${this.noPhy.size} models without a collision model (not solid): ${list(this.noPhy)}`);
  }
}

/** Face planes of the box [mins, maxs]. */
function boxPlanes(mins: Vec3, maxs: Vec3): Plane[] {
  return [
    { normal: v3(-1, 0, 0), dist: -mins.x },
    { normal: v3(1, 0, 0), dist: maxs.x },
    { normal: v3(0, -1, 0), dist: -mins.y },
    { normal: v3(0, 1, 0), dist: maxs.y },
    { normal: v3(0, 0, -1), dist: -mins.z },
    { normal: v3(0, 0, 1), dist: maxs.z },
  ];
}

/**
 * Collision brushes (model 0) for every solid prop placement of the map (see solidPropPlacements and
 * PropCollisionBuilder), model files read from `sources` in order (the pakfile first), then
 * opts.extraSources. Never throws.
 */
export function buildPropCollision(bsp: BspFile, entities: MapEntity[], sources: ModelFileSource[], opts: PropCollisionOptions = {}): PropCollision {
  const all = [...sources, ...(opts.extraSources ?? [])];
  const b = new PropCollisionBuilder(all, opts.model ?? PROP_COLLISION_MODEL);
  let list: SolidPropPlacement[] = [];
  try {
    list = solidPropPlacements(bsp, entities, opts.warnings);
  } catch (e) {
    opts.warnings?.push(`prop collision: ${(e as Error).message}`);
  }
  for (const p of list) {
    try {
      b.add(p);
    } catch {
      // a broken model must not break loading
    }
  }
  b.report(opts.warnings);
  return { brushes: b.brushes, stats: b.stats };
}
