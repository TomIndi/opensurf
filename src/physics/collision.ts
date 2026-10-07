// Brush collision world: Source/Quake-style swept AABB traces against convex brushes, accelerated by a
// BVH over brush bounds. Everything the player movement touches lives here, so the hot paths are
// allocation-free and operate on flat typed arrays.
//
// Trace semantics follow the classic brush clipping algorithm (described publicly for Quake/Source):
// each brush plane is pushed out by the box half-extents, the box center is clipped against the
// resulting convex volume, and the reported fraction stops DIST_EPSILON short of the surface along the
// plane normal. Bevel planes are used for box traces only. A trace starting inside a brush reports
// startsolid (touching counts as inside) and that brush does not block it; one that never leaves
// reports allsolid with fraction 0 and endpos = start.
//
// Properties the movement code can rely on (all covered by tests/collision.test.ts):
//  - A hit leaves endpos exactly DIST_EPSILON off the hit plane (pushed out by the box), measured along
//    its normal; plane is the brush side's ORIGINAL plane (not expanded). fraction 1 => endpos === end.
//  - Sliding parallel to a surface from that position never re-hits it, and adjacent brushes sharing
//    the same plane (ramp seams) are never hit (see CLIP_NOISE).
//  - Like Source, sweeping past a brush corner shallower than DIST_EPSILON is not a hit ("corner
//    shaving"), so a trace stopped by one brush can end inside a grazed neighbour by at most
//    DIST_EPSILON. The next trace then reports startsolid; Source's CheckStuck (unstuckPlayer) handles it.
//  - Real-map brushes should keep the compiler's bevel sides (Source-exact edge behaviour);
//    addBrushBevels never removes them, it only adds missing ones.
//
// Triangle meshes (displacement terrain, CollisionWorldOptions.triangles) live in a second BVH and are
// traced with the same clipping rules: for box traces every triangle is a zero-thickness convex hull whose
// planes are the triangle plane facing each way plus the bevels that make plane pushing exact (the box's
// axial planes and the edge x axis planes, i.e. the separating axes of a box and a triangle), clipped
// exactly like a brush (DIST_EPSILON pull-back, startsolid/allsolid, corner shaving). Triangles are
// TWO-SIDED: a box is stopped DIST_EPSILON in front of whichever face it approaches, so terrain can't be
// passed from above or below. (Source's displacements are solid from the front only; the old prism
// brushes were two-sided too.) A zero-thickness hull would let degenerate flat boxes slip through, because
// the pulled-in leave fraction equals the enter fraction; for those the far face is moved
// TRI_MIN_THICKNESS behind the triangle (as seen from the trace start). Point traces use a plain two-sided
// segment/triangle test with the same face-plane rules and edges included, so rays don't leak through
// the seams between triangles the way they do between thin brushes.
// Triangles have no volume: pointContents ignores them (like Source, where displacements aren't part of
// the BSP contents), while testBox/traceBox see them (touching counts as inside, as for brushes).
//
// Implemented from the algorithm descriptions; no engine code was used.
import { Vec3, v3 } from '../core/vec3';
import { computeBrushBounds } from './brushbuild';
import { Brush, BrushSide, CONTENTS_SOLID, DIST_EPSILON, MASK_ALL, TraceResult, TraceWorld, newTrace } from './types';

/**
 * Extra slack added to every broad-phase box (BVH nodes and brush AABBs). Plane clipping with the
 * DIST_EPSILON offsets can register a hit slightly outside the expanded brush AABB (up to
 * DIST_EPSILON for box traces; a bit more near sharp edges for point traces, which ignore bevels).
 * Purely a culling margin: the exact result comes from the planes.
 */
const BROAD_MARGIN = 1.0;
/**
 * Float noise allowance for the "clearly in front of this plane" test. A box that ended a previous
 * move DIST_EPSILON off a surface and now slides parallel to it has d1 ~= d2 ~= DIST_EPSILON; rounding
 * could make d2 a hair below DIST_EPSILON while d1 - d2 is ~1e-15, which turns
 * (d1 - eps) / (d1 - d2) into an arbitrary fraction and stops the player mid-ramp (a "ramp bug").
 * Treating anything within 1e-6 of the epsilon shell as outside removes that failure mode while being
 * five orders of magnitude below anything observable.
 */
const CLIP_NOISE = 1e-6;
/** Boxes with extents smaller than this (length^2 < 1e-6) are traced as rays (like Source's Ray_t). */
const POINT_EXTENT_SQ = 1e-6;
const LEAF_MAX = 4;
const TRI_LEAF_MAX = 4;
const SAH_BINS = 16;

const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * Triangle mesh collision input (e.g. displacement terrain). Each triangle collides as a two-sided,
 * zero-thickness convex hull (see the header comment); degenerate triangles (area ~0) are dropped.
 * Triangle numbers used by the query API run over all soups in order (soup 0 first).
 */
export interface TriangleSoup {
  /** Vertex positions, xyz per vertex. */
  positions: Float32Array | Float64Array | ArrayLike<number>;
  /** Three vertex indices per triangle. The winding defines the front: normal = (b - a) x (c - a). */
  indices: Uint32Array | Int32Array | ArrayLike<number>;
  /** Contents of all triangles (default CONTENTS_SOLID), or one value per triangle. */
  contents?: number | Int32Array | ArrayLike<number>;
  /** Owning brush model of all triangles (default 0 = world), or one value per triangle. */
  model?: number | Int32Array | ArrayLike<number>;
}

export interface CollisionWorldOptions {
  /** Triangle meshes collided natively (two-sided triangles) alongside the brushes. */
  triangles?: TriangleSoup | readonly TriangleSoup[] | null;
}

/**
 * For degenerate (flat) boxes the zero-thickness triangle hull is extended this far behind the triangle,
 * as seen from the trace start (see the header comment). 2 units = the thickness of the displacement
 * prisms this replaces. Real hulls have a half extent far above it along every normal.
 */
const TRI_MIN_THICKNESS = 2;
/** Point traces count contacts up to this far (units) outside a triangle's edges: no cracks at seams. */
const TRI_EDGE_TOLERANCE = 1e-3;
// Edge bevel tolerances (the same ones the brush bevel builders use).
const BEVEL_MIN_EDGE = 0.01;
const BEVEL_MIN_CROSS = 1e-3;
const BEVEL_ON_EPSILON = 0.01;
const AXIAL_LIMIT = 1 - 1e-9;
/** Triangles whose doubled area (|(b - a) x (c - a)|) is below this are dropped (as the prism builder did). */
const TRI_MIN_CROSS = 1e-6;

// ------------------------------------------------------------------------------------- triangle clipping
// Module-scope clip state for one triangle (traces are synchronous and never re-enter): start/end box
// centres, the enter/leave fractions and the leading (unexpanded) plane. Same rules as the brush loop in
// CollisionWorld.traceBox.
let kSx = 0;
let kSy = 0;
let kSz = 0;
let kTx = 0;
let kTy = 0;
let kTz = 0;
let kEnter = -1;
let kLeave = 1;
let kStartOut = false;
let kGetOut = false;
let kLnx = 0;
let kLny = 0;
let kLnz = 0;
let kLd = 0;
/** The trace's current best fraction: a triangle entered at or after it can't change the result. */
let kBest = 1;

/**
 * One half-space n.p <= dist (dist already pushed out by the box; `support` = the unexpanded plane
 * distance reported on a hit). Returns false when the move misses the hull (clearly in front of it).
 */
function clipPlane(nx: number, ny: number, nz: number, dist: number, support: number): boolean {
  const d1 = nx * kSx + ny * kSy + nz * kSz - dist;
  const d2 = nx * kTx + ny * kTy + nz * kTz - dist;
  if (d2 > 0) kGetOut = true;
  if (d1 > 0) {
    kStartOut = true;
    if (d2 >= DIST_EPSILON - CLIP_NOISE || d2 >= d1) return false;
  } else if (d2 <= 0) {
    return true;
  }
  if (d1 > d2) {
    const f = (d1 - DIST_EPSILON) / (d1 - d2);
    if (f > kEnter) {
      kEnter = f;
      kLnx = nx;
      kLny = ny;
      kLnz = nz;
      kLd = support;
      // (an entering plane means the start is outside: no startsolid either)
      if (f >= kBest) return false;
    }
  } else {
    const f = (d1 + DIST_EPSILON) / (d1 - d2);
    if (f < kLeave) kLeave = f;
  }
  // enter/leave only move towards each other: once crossed (and started outside) it's a miss
  return !(kStartOut && kEnter >= kLeave);
}

/**
 * A pair of opposite axial planes lo <= p[axis] <= hi of the triangle, pushed out by the half extent e.
 * When the pair is thinner than TRI_MIN_THICKNESS (flat boxes against an axis-aligned triangle), the
 * side away from the start centre `s` is moved back so the hull keeps that thickness.
 */
function clipAxial(axis: number, lo: number, hi: number, e: number, s: number): boolean {
  let lp = -lo + e; // -axis plane, pushed
  let hp = hi + e; // +axis plane, pushed
  const thick = hi - lo + 2 * e;
  if (thick < TRI_MIN_THICKNESS) {
    if (s >= (lo + hi) * 0.5) lp += TRI_MIN_THICKNESS - thick;
    else hp += TRI_MIN_THICKNESS - thick;
  }
  if (axis === 0) return clipPlane(-1, 0, 0, lp, -lo) && clipPlane(1, 0, 0, hp, hi);
  if (axis === 1) return clipPlane(0, -1, 0, lp, -lo) && clipPlane(0, 1, 0, hp, hi);
  return clipPlane(0, 0, -1, lp, -lo) && clipPlane(0, 0, 1, hp, hi);
}

/**
 * The edge x axis bevels of triangle slot t, from its cached bevel data (see computeBevels): for edge i
 * (vertex i -> i+1) and axis a, normal c = (unit edge x axis) * inv, kept in the direction(s) flagged
 * where the edge supports the triangle; the plane distance is the triangle's support along it.
 */
function clipBevels(
  D: Float32Array, INV: Float32Array, F: Uint32Array, t: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  ex: number, ey: number, ez: number,
): boolean {
  const flags = F[t];
  if (flags === 0) return true;
  const o = t * 9;
  for (let i = 0; i < 3; i++) {
    const bits = (flags >>> (i * 6)) & 63;
    if (bits === 0) continue;
    const dx = D[o + i * 3];
    const dy = D[o + i * 3 + 1];
    const dz = D[o + i * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const dir = (bits >>> (k * 2)) & 3;
      if (dir === 0) continue;
      const inv = INV[o + i * 3 + k];
      let nx: number;
      let ny: number;
      let nz: number;
      if (k === 0) {
        nx = 0;
        ny = dz * inv;
        nz = -dy * inv;
      } else if (k === 1) {
        nx = -dz * inv;
        ny = 0;
        nz = dx * inv;
      } else {
        nx = dy * inv;
        ny = -dx * inv;
        nz = 0;
      }
      const sa = nx * ax + ny * ay + nz * az;
      const sb = nx * bx + ny * by + nz * bz;
      const sc = nx * cx + ny * cy + nz * cz;
      const r = (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
      if (dir & 1) {
        const d = sa > sb ? (sa > sc ? sa : sc) : sb > sc ? sb : sc;
        if (!clipPlane(nx, ny, nz, d + r, d)) return false;
      }
      if (dir & 2) {
        const d = -(sa < sb ? (sa < sc ? sa : sc) : sb < sc ? sb : sc);
        if (!clipPlane(-nx, -ny, -nz, d + r, d)) return false;
      }
    }
  }
  return true;
}

/**
 * Bevel data of triangle slot t (verts V, unit normal n) into D (unit edge directions, float32), INV
 * (1 / |unit edge x axis| for the float32 directions) and F (2 bits per edge/axis: 1 = +c supports the
 * triangle through the edge, 2 = -c does; 0 = no bevel: degenerate edge, edge along the axis, or a normal
 * that duplicates an axial or face plane). Same selection rules as the brush bevel builders.
 */
function computeBevels(V: Float64Array, t: number, nx: number, ny: number, nz: number, D: Float32Array, INV: Float32Array, F: Uint32Array): void {
  const o = t * 9;
  let flags = 0;
  for (let i = 0; i < 3; i++) {
    const p = o + i * 3;
    const q = o + ((i + 1) % 3) * 3;
    const kv = o + ((i + 2) % 3) * 3;
    let ex = V[q] - V[p];
    let ey = V[q + 1] - V[p + 1];
    let ez = V[q + 2] - V[p + 2];
    const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (!(len >= BEVEL_MIN_EDGE)) continue;
    D[o + i * 3] = ex / len;
    D[o + i * 3 + 1] = ey / len;
    D[o + i * 3 + 2] = ez / len;
    // the float32 direction is what the trace uses
    ex = D[o + i * 3];
    ey = D[o + i * 3 + 1];
    ez = D[o + i * 3 + 2];
    for (let k = 0; k < 3; k++) {
      let cx: number;
      let cy: number;
      let cz: number;
      if (k === 0) {
        cx = 0;
        cy = ez;
        cz = -ey;
      } else if (k === 1) {
        cx = -ez;
        cy = 0;
        cz = ex;
      } else {
        cx = ey;
        cy = -ex;
        cz = 0;
      }
      const l = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (l < BEVEL_MIN_CROSS) continue; // edge (nearly) along the axis
      INV[o + i * 3 + k] = 1 / l;
      const inv = INV[o + i * 3 + k];
      cx *= inv;
      cy *= inv;
      cz *= inv;
      // axial normals duplicate the axial planes, normals along the triangle normal the face planes
      if (cx > AXIAL_LIMIT || cx < -AXIAL_LIMIT || cy > AXIAL_LIMIT || cy < -AXIAL_LIMIT || cz > AXIAL_LIMIT || cz < -AXIAL_LIMIT) continue;
      const cn = cx * nx + cy * ny + cz * nz;
      if (cn > AXIAL_LIMIT || cn < -AXIAL_LIMIT) continue;
      const sp = cx * V[p] + cy * V[p + 1] + cz * V[p + 2];
      const sq = cx * V[q] + cy * V[q + 1] + cz * V[q + 2];
      const sk = cx * V[kv] + cy * V[kv + 1] + cz * V[kv + 2];
      const eMax = sp > sq ? sp : sq;
      const eMin = sp > sq ? sq : sp;
      let dir = 0;
      if (eMin >= sk - BEVEL_ON_EPSILON) dir |= 1;
      if (eMax <= sk + BEVEL_ON_EPSILON) dir |= 2;
      flags |= dir << (i * 6 + k * 2);
    }
  }
  F[t] = flags >>> 0;
}

/**
 * True when point p projects into the triangle (a, b, c) with unit normal n (counter-clockwise around n),
 * edges included with a TRI_EDGE_TOLERANCE margin, so a point on an edge shared by two triangles is inside
 * both even with rounding.
 */
function projectsInside(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  nx: number, ny: number, nz: number,
  px: number, py: number, pz: number,
): boolean {
  return (
    edgeInside(ax, ay, az, bx, by, bz, nx, ny, nz, px, py, pz) &&
    edgeInside(bx, by, bz, cx, cy, cz, nx, ny, nz, px, py, pz) &&
    edgeInside(cx, cy, cz, ax, ay, az, nx, ny, nz, px, py, pz)
  );
}

/** Signed in-plane distance of p from edge p0-p1 (positive inside) >= -TRI_EDGE_TOLERANCE. */
function edgeInside(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  nx: number, ny: number, nz: number,
  px: number, py: number, pz: number,
): boolean {
  const ex = x1 - x0;
  const ey = y1 - y0;
  const ez = z1 - z0;
  // n x edge points into a counter-clockwise triangle
  const ix = ny * ez - nz * ey;
  const iy = nz * ex - nx * ez;
  const iz = nx * ey - ny * ex;
  const d = ix * (px - x0) + iy * (py - y0) + iz * (pz - z0);
  return d >= -TRI_EDGE_TOLERANCE * Math.sqrt(ex * ex + ey * ey + ez * ez);
}

/**
 * Point trace against triangle slot `t`: the segment kS -> kT against the zero-thickness triangle, two-sided,
 * with the brush rules for the face planes (a hit stops DIST_EPSILON in front of the face that is approached;
 * ending within DIST_EPSILON of it counts; a start exactly on the triangle is startsolid). The contact must
 * project into the triangle, edges included (see projectsInside): unlike a clipped thin brush, whose
 * pulled-in leave fractions let rays through within DIST_EPSILON of its edges, a triangulated surface has no
 * seams for rays. Sets the k* state like clipTriangle.
 */
function clipTriangleRay(V: Float64Array, P: Float64Array, t: number): boolean {
  const p4 = t * 4;
  let nx = P[p4];
  let ny = P[p4 + 1];
  let nz = P[p4 + 2];
  let d = P[p4 + 3];
  let d1 = nx * kSx + ny * kSy + nz * kSz - d;
  let d2 = nx * kTx + ny * kTy + nz * kTz - d;
  const o = t * 9;
  const ax = V[o], ay = V[o + 1], az = V[o + 2];
  const bx = V[o + 3], by = V[o + 4], bz = V[o + 5];
  const cx = V[o + 6], cy = V[o + 7], cz = V[o + 8];
  if (d1 === 0) {
    // starting on the plane: inside (touching) when on the triangle, which then doesn't block
    if (!projectsInside(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, kSx, kSy, kSz)) return false;
    kStartOut = false;
    kGetOut = !(d2 === 0 && projectsInside(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, kTx, kTy, kTz));
    return true;
  }
  if (d1 < 0) {
    // behind: the back face is the one approached
    nx = -nx;
    ny = -ny;
    nz = -nz;
    d = -d;
    d1 = -d1;
    d2 = -d2;
  }
  if (d2 >= DIST_EPSILON - CLIP_NOISE || d2 >= d1) return false;
  const f = (d1 - DIST_EPSILON) / (d1 - d2);
  if (!(f > -1)) return false;
  // where the segment meets the plane (or its end, when that stops short within DIST_EPSILON)
  const fc = d2 > 0 ? 1 : d1 / (d1 - d2);
  const px = kSx + (kTx - kSx) * fc;
  const py = kSy + (kTy - kSy) * fc;
  const pz = kSz + (kTz - kSz) * fc;
  if (!projectsInside(ax, ay, az, bx, by, bz, cx, cy, cz, P[p4], P[p4 + 1], P[p4 + 2], px, py, pz)) return false;
  kStartOut = true;
  kGetOut = true;
  kEnter = f;
  kLeave = 1;
  kLnx = nx;
  kLny = ny;
  kLnz = nz;
  kLd = d;
  return true;
}

/**
 * Clips the swept box (centre kS -> kT, half extents ex/ey/ez; a point when isPoint) against triangle
 * slot `t` (verts: 9 per slot, plane: nx ny nz d per slot). Returns false when the move can't touch it;
 * otherwise kEnter/kLeave/kStartOut/kGetOut/kL* hold the result, exactly like a brush clip. Boxes clip
 * against the hull planes: both faces, the axial planes and the edge x axis bevels (the separating axes
 * of a box and a triangle, so plane pushing is exact). Points use clipTriangleRay.
 */
function clipTriangle(
  V: Float64Array, P: Float64Array, D: Float32Array, INV: Float32Array, F: Uint32Array,
  t: number, ex: number, ey: number, ez: number, isPoint: boolean,
): boolean {
  kEnter = -1;
  kLeave = 1;
  kStartOut = false;
  kGetOut = false;
  if (isPoint) return clipTriangleRay(V, P, t);
  const o = t * 9;
  const ax = V[o];
  const ay = V[o + 1];
  const az = V[o + 2];
  const bx = V[o + 3];
  const by = V[o + 4];
  const bz = V[o + 5];
  const cx = V[o + 6];
  const cy = V[o + 7];
  const cz = V[o + 8];
  const minx = ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx;
  const maxx = ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx;
  const miny = ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy;
  const maxy = ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy;
  const minz = az < bz ? (az < cz ? az : cz) : bz < cz ? bz : cz;
  const maxz = az > bz ? (az > cz ? az : cz) : bz > cz ? bz : cz;
  // broad phase: the swept box against the triangle's bounds (with the usual margin) within [0, best]
  {
    let tmin = 0;
    let tmax = kBest;
    const dx = kTx - kSx;
    const dy = kTy - kSy;
    const dz = kTz - kSz;
    const bx0 = minx - ex - BROAD_MARGIN - kSx;
    const bx1 = maxx + ex + BROAD_MARGIN - kSx;
    if (dx === 0) {
      if (bx0 > 0 || bx1 < 0) return false;
    } else {
      let t1 = bx0 / dx;
      let t2 = bx1 / dx;
      if (t1 > t2) {
        const q = t1;
        t1 = t2;
        t2 = q;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    const by0 = miny - ey - BROAD_MARGIN - kSy;
    const by1 = maxy + ey + BROAD_MARGIN - kSy;
    if (dy === 0) {
      if (by0 > 0 || by1 < 0) return false;
    } else {
      let t1 = by0 / dy;
      let t2 = by1 / dy;
      if (t1 > t2) {
        const q = t1;
        t1 = t2;
        t2 = q;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    const bz0 = minz - ez - BROAD_MARGIN - kSz;
    const bz1 = maxz + ez + BROAD_MARGIN - kSz;
    if (dz === 0) {
      if (bz0 > 0 || bz1 < 0) return false;
    } else {
      let t1 = bz0 / dz;
      let t2 = bz1 / dz;
      if (t1 > t2) {
        const q = t1;
        t1 = t2;
        t2 = q;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    if (tmin > tmax) return false;
  }
  const p4 = t * 4;
  const nx = P[p4];
  const ny = P[p4 + 1];
  const nz = P[p4 + 2];
  const d = P[p4 + 3];
  // the two faces: the one facing the start is exact, the far one is moved back for thin hulls
  const r = (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
  const rf = r < TRI_MIN_THICKNESS ? TRI_MIN_THICKNESS : r;
  if (nx * kSx + ny * kSy + nz * kSz - d >= 0) {
    if (!clipPlane(nx, ny, nz, d + r, d) || !clipPlane(-nx, -ny, -nz, rf - d, -d)) return false;
  } else if (!clipPlane(-nx, -ny, -nz, r - d, -d) || !clipPlane(nx, ny, nz, d + rf, d)) {
    return false;
  }
  // then the axial planes of the triangle bounds and the edge x axis bevels
  return (
    clipAxial(0, minx, maxx, ex, kSx) &&
    clipAxial(1, miny, maxy, ey, kSy) &&
    clipAxial(2, minz, maxz, ez, kSz) &&
    clipBevels(D, INV, F, t, ax, ay, az, bx, by, bz, cx, cy, cz, ex, ey, ez)
  );
}

interface TriangleSet {
  count: number;
  verts: Float64Array; // 9 per slot
  planes: Float64Array; // nx ny nz d per slot
  bevelDir: Float32Array;
  bevelInv: Float32Array;
  bevelFlags: Uint32Array;
  contents: Int32Array;
  model: Int32Array;
  index: Int32Array; // slot -> triangle number
  bvh: Bvh;
}

function asF64(a: ArrayLike<number>): Float64Array {
  return a instanceof Float64Array ? a : Float64Array.from(a);
}

function asI32(a: ArrayLike<number>): Int32Array | Uint32Array {
  return a instanceof Uint32Array || a instanceof Int32Array ? a : Int32Array.from(a);
}

/** A per-triangle attribute as a per-triangle Int32Array (null = the constant applies to all). */
function attrArray(v: number | ArrayLike<number> | undefined, triangles: number, def: number): { arr: Int32Array | null; value: number } {
  if (v === undefined) return { arr: null, value: def };
  if (typeof v === 'number') return { arr: null, value: v | 0 };
  const arr = v instanceof Int32Array ? v : Int32Array.from({ length: triangles }, (_, i) => (v[i] === undefined ? def : v[i] | 0));
  return { arr: arr.length >= triangles ? arr : Int32Array.from({ length: triangles }, (_, i) => (i < arr.length ? arr[i] : def)), value: def };
}

/**
 * Validates the triangles of all soups (bad indices, degenerate or non-finite triangles are dropped) and
 * lays them out in BVH leaf order: vertices, unit plane, attributes. The BVH is a Morton-order tree
 * (buildMortonTree) with node bounds from the triangle vertices. Allocation is kept low on purpose: this
 * runs on ~200k triangles during map load.
 */
function buildTriangleSet(soups: readonly TriangleSoup[]): TriangleSet {
  const pos = soups.map((s) => asF64(s.positions));
  const idx = soups.map((s) => asI32(s.indices));
  let total = 0;
  // vertex bounds of all soups: the Morton grid
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let si = 0; si < soups.length; si++) {
    total += Math.floor(idx[si].length / 3);
    const P = pos[si];
    for (let i = 0, e = P.length - 2; i < e; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (z < minz) minz = z;
      if (z > maxz) maxz = z;
    }
  }
  // cubic Morton cells over the vertex bounds; codes from 3x the centroid (no division)
  const ext = Math.max(maxx - minx, maxy - miny, maxz - minz);
  const scale = Number.isFinite(ext) && ext > 0 ? 1023.999 / (3 * ext) : 0;
  const ox = Number.isFinite(minx) ? 3 * minx : 0;
  const oy = Number.isFinite(miny) ? 3 * miny : 0;
  const oz = Number.isFinite(minz) ? 3 * minz : 0;

  // pass 1 (input order): keep good triangles, Morton code per kept triangle
  const keepSoup = soups.length > 1 ? new Uint16Array(total) : null;
  const keepTri = new Int32Array(total);
  const codes = new Uint32Array(total);
  const minCross2 = TRI_MIN_CROSS * TRI_MIN_CROSS;
  let n = 0;
  for (let si = 0; si < soups.length; si++) {
    const P = pos[si];
    const I = idx[si];
    const nv = Math.floor(P.length / 3);
    const nt = Math.floor(I.length / 3);
    for (let t = 0; t < nt; t++) {
      const ia = I[t * 3];
      const ib = I[t * 3 + 1];
      const ic = I[t * 3 + 2];
      if (!(ia >= 0 && ia < nv && ib >= 0 && ib < nv && ic >= 0 && ic < nv)) continue;
      const a3 = ia * 3;
      const b3 = ib * 3;
      const c3 = ic * 3;
      const ax = P[a3], ay = P[a3 + 1], az = P[a3 + 2];
      const bx = P[b3], by = P[b3 + 1], bz = P[b3 + 2];
      const cx = P[c3], cy = P[c3 + 1], cz = P[c3 + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const l2 = nx * nx + ny * ny + nz * nz;
      if (!(l2 > minCross2 && l2 < Infinity)) continue; // degenerate, NaN or non-finite
      const qx = ((ax + bx + cx - ox) * scale) | 0;
      const qy = ((ay + by + cy - oy) * scale) | 0;
      const qz = ((az + bz + cz - oz) * scale) | 0;
      codes[n] = ((spreadBits10(qx) << 2) | (spreadBits10(qy) << 1) | spreadBits10(qz)) >>> 0;
      if (keepSoup) keepSoup[n] = si;
      keepTri[n] = t;
      n++;
    }
  }
  const tree = buildMortonTree(codes, n, TRI_LEAF_MAX);

  // pass 2 (slot order): vertices, planes, attributes
  const soupBase: number[] = [];
  let acc = 0;
  for (const I of idx) {
    soupBase.push(acc);
    acc += Math.floor(I.length / 3);
  }
  const cAttr = soups.map((s, i) => attrArray(s.contents, Math.floor(idx[i].length / 3), CONTENTS_SOLID));
  const mAttr = soups.map((s, i) => attrArray(s.model, Math.floor(idx[i].length / 3), 0));
  const verts = new Float64Array(n * 9);
  const planes = new Float64Array(n * 4);
  const bevelDir = new Float32Array(n * 9);
  const bevelInv = new Float32Array(n * 9);
  const bevelFlags = new Uint32Array(n);
  const contents = new Int32Array(n);
  const model = new Int32Array(n);
  const index = new Int32Array(n);
  const order = tree.order;
  for (let slot = 0; slot < n; slot++) {
    const k = order[slot];
    const si = keepSoup ? keepSoup[k] : 0;
    const t = keepTri[k];
    const P = pos[si];
    const I = idx[si];
    index[slot] = soupBase[si] + t;
    const ca = cAttr[si];
    contents[slot] = ca.arr ? ca.arr[t] : ca.value;
    const ma = mAttr[si];
    model[slot] = ma.arr ? ma.arr[t] : ma.value;
    const a3 = I[t * 3] * 3;
    const b3 = I[t * 3 + 1] * 3;
    const c3 = I[t * 3 + 2] * 3;
    const ax = P[a3], ay = P[a3 + 1], az = P[a3 + 2];
    const bx = P[b3], by = P[b3 + 1], bz = P[b3 + 2];
    const cx = P[c3], cy = P[c3 + 1], cz = P[c3 + 2];
    const o9 = slot * 9;
    verts[o9] = ax;
    verts[o9 + 1] = ay;
    verts[o9 + 2] = az;
    verts[o9 + 3] = bx;
    verts[o9 + 4] = by;
    verts[o9 + 5] = bz;
    verts[o9 + 6] = cx;
    verts[o9 + 7] = cy;
    verts[o9 + 8] = cz;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len;
    ny /= len;
    nz /= len;
    const o4 = slot * 4;
    planes[o4] = nx;
    planes[o4 + 1] = ny;
    planes[o4 + 2] = nz;
    planes[o4 + 3] = (nx * (ax + bx + cx) + ny * (ay + by + cy) + nz * (az + bz + cz)) / 3;
    computeBevels(verts, slot, nx, ny, nz, bevelDir, bevelInv, bevelFlags);
  }

  // node bounds, bottom-up (children follow their parent in the pre-order layout)
  const nodeCount = tree.nodeCount;
  const nodeInfo = tree.nodeInfo;
  const nodeBounds = new Float64Array(Math.max(1, nodeCount) * 6);
  for (let node = nodeCount - 1; node >= 0; node--) {
    const a = nodeInfo[node * 2];
    const b = nodeInfo[node * 2 + 1];
    const o = node * 6;
    if (b > 0) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let v = a * 9, ve = (a + b) * 9; v < ve; v += 3) {
        const x = verts[v], y = verts[v + 1], z = verts[v + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      nodeBounds[o] = x0;
      nodeBounds[o + 1] = y0;
      nodeBounds[o + 2] = z0;
      nodeBounds[o + 3] = x1;
      nodeBounds[o + 4] = y1;
      nodeBounds[o + 5] = z1;
    } else {
      const l = (node + 1) * 6;
      const r = a * 6;
      nodeBounds[o] = nodeBounds[l] < nodeBounds[r] ? nodeBounds[l] : nodeBounds[r];
      nodeBounds[o + 1] = nodeBounds[l + 1] < nodeBounds[r + 1] ? nodeBounds[l + 1] : nodeBounds[r + 1];
      nodeBounds[o + 2] = nodeBounds[l + 2] < nodeBounds[r + 2] ? nodeBounds[l + 2] : nodeBounds[r + 2];
      nodeBounds[o + 3] = nodeBounds[l + 3] > nodeBounds[r + 3] ? nodeBounds[l + 3] : nodeBounds[r + 3];
      nodeBounds[o + 4] = nodeBounds[l + 4] > nodeBounds[r + 4] ? nodeBounds[l + 4] : nodeBounds[r + 4];
      nodeBounds[o + 5] = nodeBounds[l + 5] > nodeBounds[r + 5] ? nodeBounds[l + 5] : nodeBounds[r + 5];
    }
  }
  return { count: n, verts, planes, bevelDir, bevelInv, bevelFlags, contents, model, index, bvh: { ...tree, nodeBounds } };
}

interface Bvh {
  nodeBounds: Float64Array; // 6 per node: minx miny minz maxx maxy maxz
  /** 2 per node. Leaf: [firstSlot, count>0]. Internal: [rightChild, -(splitAxis+1)]; left child = node+1. */
  nodeInfo: Int32Array;
  nodeCount: number;
  /** order[slot] = index into the input arrays. */
  order: Int32Array;
  maxDepth: number;
}

/** Binned-SAH BVH over AABBs (bmin/bmax: 3 per item). Depth-first node layout. */
function buildBvh(count: number, bmin: Float64Array, bmax: Float64Array, leafMax = LEAF_MAX): Bvh {
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const maxNodes = Math.max(1, 2 * count - 1);
  const nodeBounds = new Float64Array(maxNodes * 6);
  const nodeInfo = new Int32Array(maxNodes * 2);
  if (count === 0) return { nodeBounds, nodeInfo, nodeCount: 0, order, maxDepth: 0 };

  const cent = new Float64Array(count * 3);
  for (let i = 0; i < count * 3; i++) cent[i] = (bmin[i] + bmax[i]) * 0.5;

  // scratch for binning
  const binCount = new Int32Array(SAH_BINS);
  const binB = new Float64Array(SAH_BINS * 6);
  const rightArea = new Float64Array(SAH_BINS);
  const rightCount = new Int32Array(SAH_BINS);

  // task stack: start, end, parent (-1 = left child / root), depth
  let taskCap = 64;
  let tasks = new Int32Array(taskCap * 4);
  let tsp = 0;
  const pushTask = (s: number, e: number, parent: number, depth: number): void => {
    if (tsp + 4 > tasks.length) {
      taskCap *= 2;
      const nt = new Int32Array(taskCap * 4);
      nt.set(tasks);
      tasks = nt;
    }
    tasks[tsp++] = s;
    tasks[tsp++] = e;
    tasks[tsp++] = parent;
    tasks[tsp++] = depth;
  };
  pushTask(0, count, -1, 1);
  let nodeCount = 0;
  let maxDepth = 0;

  while (tsp > 0) {
    const depth = tasks[--tsp];
    const parent = tasks[--tsp];
    const end = tasks[--tsp];
    const start = tasks[--tsp];
    const node = nodeCount++;
    if (parent >= 0) nodeInfo[parent * 2] = node;
    if (depth > maxDepth) maxDepth = depth;

    // node bounds and centroid bounds
    let nminx = Infinity, nminy = Infinity, nminz = Infinity;
    let nmaxx = -Infinity, nmaxy = -Infinity, nmaxz = -Infinity;
    let cminx = Infinity, cminy = Infinity, cminz = Infinity;
    let cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
    for (let k = start; k < end; k++) {
      const i3 = order[k] * 3;
      if (bmin[i3] < nminx) nminx = bmin[i3];
      if (bmin[i3 + 1] < nminy) nminy = bmin[i3 + 1];
      if (bmin[i3 + 2] < nminz) nminz = bmin[i3 + 2];
      if (bmax[i3] > nmaxx) nmaxx = bmax[i3];
      if (bmax[i3 + 1] > nmaxy) nmaxy = bmax[i3 + 1];
      if (bmax[i3 + 2] > nmaxz) nmaxz = bmax[i3 + 2];
      const cx = cent[i3], cy = cent[i3 + 1], cz = cent[i3 + 2];
      if (cx < cminx) cminx = cx;
      if (cy < cminy) cminy = cy;
      if (cz < cminz) cminz = cz;
      if (cx > cmaxx) cmaxx = cx;
      if (cy > cmaxy) cmaxy = cy;
      if (cz > cmaxz) cmaxz = cz;
    }
    const o6 = node * 6;
    nodeBounds[o6] = nminx;
    nodeBounds[o6 + 1] = nminy;
    nodeBounds[o6 + 2] = nminz;
    nodeBounds[o6 + 3] = nmaxx;
    nodeBounds[o6 + 4] = nmaxy;
    nodeBounds[o6 + 5] = nmaxz;

    const n = end - start;
    const makeLeaf = (): void => {
      nodeInfo[node * 2] = start;
      nodeInfo[node * 2 + 1] = n;
    };
    if (n <= 2) {
      makeLeaf();
      continue;
    }

    // split axis = largest centroid extent
    const ext0 = cmaxx - cminx, ext1 = cmaxy - cminy, ext2 = cmaxz - cminz;
    let axis = 0;
    let cext = ext0;
    if (ext1 > cext) {
      axis = 1;
      cext = ext1;
    }
    if (ext2 > cext) {
      axis = 2;
      cext = ext2;
    }
    const cmin = axis === 0 ? cminx : axis === 1 ? cminy : cminz;

    let mid = -1;
    if (cext > 1e-9) {
      // ---- binned SAH along `axis`
      binCount.fill(0);
      for (let b = 0; b < SAH_BINS; b++) {
        binB[b * 6] = Infinity;
        binB[b * 6 + 1] = Infinity;
        binB[b * 6 + 2] = Infinity;
        binB[b * 6 + 3] = -Infinity;
        binB[b * 6 + 4] = -Infinity;
        binB[b * 6 + 5] = -Infinity;
      }
      const scale = SAH_BINS / cext;
      for (let k = start; k < end; k++) {
        const i = order[k];
        const i3 = i * 3;
        let b = ((cent[i3 + axis] - cmin) * scale) | 0;
        if (b >= SAH_BINS) b = SAH_BINS - 1;
        binCount[b]++;
        const b6 = b * 6;
        if (bmin[i3] < binB[b6]) binB[b6] = bmin[i3];
        if (bmin[i3 + 1] < binB[b6 + 1]) binB[b6 + 1] = bmin[i3 + 1];
        if (bmin[i3 + 2] < binB[b6 + 2]) binB[b6 + 2] = bmin[i3 + 2];
        if (bmax[i3] > binB[b6 + 3]) binB[b6 + 3] = bmax[i3];
        if (bmax[i3 + 1] > binB[b6 + 4]) binB[b6 + 4] = bmax[i3 + 1];
        if (bmax[i3 + 2] > binB[b6 + 5]) binB[b6 + 5] = bmax[i3 + 2];
      }
      // sweep from the right
      let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity;
      let rc = 0;
      for (let b = SAH_BINS - 1; b > 0; b--) {
        const b6 = b * 6;
        if (binCount[b] > 0) {
          if (binB[b6] < rx0) rx0 = binB[b6];
          if (binB[b6 + 1] < ry0) ry0 = binB[b6 + 1];
          if (binB[b6 + 2] < rz0) rz0 = binB[b6 + 2];
          if (binB[b6 + 3] > rx1) rx1 = binB[b6 + 3];
          if (binB[b6 + 4] > ry1) ry1 = binB[b6 + 4];
          if (binB[b6 + 5] > rz1) rz1 = binB[b6 + 5];
        }
        rc += binCount[b];
        rightCount[b] = rc;
        rightArea[b] = rc > 0 ? halfArea(rx1 - rx0, ry1 - ry0, rz1 - rz0) : 0;
      }
      // sweep from the left, evaluating split after bin b (left = bins <= b)
      let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity;
      let lc = 0;
      let bestCost = Infinity;
      let bestSplit = -1;
      for (let b = 0; b < SAH_BINS - 1; b++) {
        const b6 = b * 6;
        if (binCount[b] > 0) {
          if (binB[b6] < lx0) lx0 = binB[b6];
          if (binB[b6 + 1] < ly0) ly0 = binB[b6 + 1];
          if (binB[b6 + 2] < lz0) lz0 = binB[b6 + 2];
          if (binB[b6 + 3] > lx1) lx1 = binB[b6 + 3];
          if (binB[b6 + 4] > ly1) ly1 = binB[b6 + 4];
          if (binB[b6 + 5] > lz1) lz1 = binB[b6 + 5];
        }
        lc += binCount[b];
        const rcount = rightCount[b + 1];
        if (lc === 0 || rcount === 0) continue;
        const cost = lc * halfArea(lx1 - lx0, ly1 - ly0, lz1 - lz0) + rcount * rightArea[b + 1];
        if (cost < bestCost) {
          bestCost = cost;
          bestSplit = b;
        }
      }
      const parentArea = halfArea(nmaxx - nminx, nmaxy - nminy, nmaxz - nminz);
      // SAH (traversal cost 1, intersection cost 1): split only if it beats a leaf, or the leaf is too big
      if (bestSplit >= 0 && n <= leafMax && parentArea > 0 && 1 + bestCost / parentArea >= n) {
        makeLeaf();
        continue;
      }
      if (bestSplit >= 0) {
        // partition
        let i = start;
        let j = end - 1;
        while (i <= j) {
          const ii = order[i];
          let b = ((cent[ii * 3 + axis] - cmin) * scale) | 0;
          if (b >= SAH_BINS) b = SAH_BINS - 1;
          if (b <= bestSplit) {
            i++;
          } else {
            order[i] = order[j];
            order[j] = ii;
            j--;
          }
        }
        mid = i;
        if (mid === start || mid === end) mid = -1;
      }
    }
    if (mid < 0) {
      if (n <= leafMax) {
        makeLeaf();
        continue;
      }
      // median split along the axis (all centroids equal or SAH failed)
      const sub = Array.from(order.subarray(start, end));
      sub.sort((a, b) => cent[a * 3 + axis] - cent[b * 3 + axis]);
      for (let k = 0; k < n; k++) order[start + k] = sub[k];
      mid = start + (n >> 1);
    }
    nodeInfo[node * 2 + 1] = -(axis + 1);
    // Right child is created later (and patches nodeInfo[node*2]); left child is popped next => node+1.
    pushTask(mid, end, node, depth + 1);
    pushTask(start, mid, -1, depth + 1);
  }
  // the node count is only known now (about count / 2 with small leaves): drop the unused tail
  return {
    nodeBounds: nodeCount * 6 < nodeBounds.length ? nodeBounds.slice(0, nodeCount * 6) : nodeBounds,
    nodeInfo: nodeCount * 2 < nodeInfo.length ? nodeInfo.slice(0, nodeCount * 2) : nodeInfo,
    nodeCount,
    order,
    maxDepth,
  };
}

function halfArea(dx: number, dy: number, dz: number): number {
  return dx * dy + dy * dz + dz * dx;
}

/**
 * Linear BVH topology from 30-bit Morton codes (one per item): items radix-sorted by code, then split
 * top-down at the highest differing code bit (ranges of identical codes at their middle), leaves of at
 * most `leafMax` items. O(n) and much cheaper than the binned SAH build, with near-SAH quality for big
 * sets of similar-sized items such as terrain triangles. Same node layout as buildBvh; node bounds are
 * left to the caller (children always follow their parent, so a reverse sweep can fill them).
 */
function buildMortonTree(codes: Uint32Array, count: number, leafMax: number): Omit<Bvh, 'nodeBounds'> {
  if (count === 0) return { nodeInfo: new Int32Array(2), nodeCount: 0, order: new Int32Array(0), maxDepth: 0 };
  // LSD radix sort, 3 x 10 bits
  let keys: Uint32Array = codes;
  let vals = new Int32Array(count);
  for (let i = 0; i < count; i++) vals[i] = i;
  let keys2: Uint32Array = new Uint32Array(count);
  let vals2 = new Int32Array(count);
  const hist = new Int32Array(1024);
  for (let shift = 0; shift < 30; shift += 10) {
    hist.fill(0);
    for (let i = 0; i < count; i++) hist[(keys[i] >>> shift) & 1023]++;
    let sum = 0;
    for (let b = 0; b < 1024; b++) {
      const c = hist[b];
      hist[b] = sum;
      sum += c;
    }
    for (let i = 0; i < count; i++) {
      const k = keys[i];
      const pos = hist[(k >>> shift) & 1023]++;
      keys2[pos] = k;
      vals2[pos] = vals[i];
    }
    const tk = keys;
    keys = keys2;
    keys2 = tk;
    const tv = vals;
    vals = vals2;
    vals2 = tv;
  }
  const order = vals;
  const sorted = keys;

  const nodeInfo = new Int32Array((2 * count - 1) * 2);
  // task stack: start, end, parent (-1 = left child / root), depth
  let tasks = new Int32Array(256);
  let tsp = 0;
  tasks[tsp++] = 0;
  tasks[tsp++] = count;
  tasks[tsp++] = -1;
  tasks[tsp++] = 1;
  let nodeCount = 0;
  let maxDepth = 0;
  while (tsp > 0) {
    const depth = tasks[--tsp];
    const parent = tasks[--tsp];
    const end = tasks[--tsp];
    const start = tasks[--tsp];
    const node = nodeCount++;
    if (parent >= 0) nodeInfo[parent * 2] = node;
    if (depth > maxDepth) maxDepth = depth;
    const n = end - start;
    if (n <= leafMax) {
      nodeInfo[node * 2] = start;
      nodeInfo[node * 2 + 1] = n;
      continue;
    }
    const first = sorted[start];
    const last = sorted[end - 1];
    let mid: number;
    let axis = 0;
    if (first === last) {
      mid = start + (n >> 1);
    } else {
      const bit = 31 - Math.clz32(first ^ last);
      const m3 = bit % 3;
      axis = m3 === 2 ? 0 : m3 === 1 ? 1 : 2;
      // first index whose code has `bit` set (codes in the range share every higher bit)
      let lo = start + 1;
      let hi = end - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if ((sorted[m] >>> bit) & 1) hi = m;
        else lo = m + 1;
      }
      mid = lo;
    }
    nodeInfo[node * 2 + 1] = -(axis + 1);
    if (tsp + 8 > tasks.length) {
      const nt = new Int32Array(tasks.length * 2);
      nt.set(tasks);
      tasks = nt;
    }
    // right child first: the left one is popped next and becomes node + 1
    tasks[tsp++] = mid;
    tasks[tsp++] = end;
    tasks[tsp++] = node;
    tasks[tsp++] = depth + 1;
    tasks[tsp++] = start;
    tasks[tsp++] = mid;
    tasks[tsp++] = -1;
    tasks[tsp++] = depth + 1;
  }
  return { nodeInfo: nodeInfo.slice(0, nodeCount * 2), nodeCount, order, maxDepth };
}

/** Spreads the low 10 bits of v to every third bit (Morton interleave). */
function spreadBits10(v: number): number {
  v &= 0x3ff;
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  v = (v | (v << 2)) & 0x09249249;
  return v;
}

function boundsValid(b: Brush): boolean {
  const lo = b.mins;
  const hi = b.maxs;
  if (!lo || !hi) return false;
  return (
    Number.isFinite(lo.x) && Number.isFinite(lo.y) && Number.isFinite(lo.z) &&
    Number.isFinite(hi.x) && Number.isFinite(hi.y) && Number.isFinite(hi.z) &&
    lo.x <= hi.x && lo.y <= hi.y && lo.z <= hi.z
  );
}

/**
 * The collision world: all player-solid geometry of a map (world brushes, solid brush entities,
 * playerclips, water volumes...). Brush objects stay available as public data; queries run on a
 * flattened copy, so mutating a Brush after construction has no effect.
 */
export class CollisionWorld implements TraceWorld {
  readonly brushes: readonly Brush[];
  /**
   * Index (into `brushes`) of the brush that produced the last traceBox/traceRay hit (fraction < 1 and
   * not allsolid), or -1. Debug aid (e.g. showing which brush a ramp bug came from).
   */
  lastHitBrush = -1;
  /**
   * Triangle number (see TriangleSoup) of the triangle that produced the last traceBox/traceRay hit, or
   * -1 (also -1 when a brush was hit). Debug aid like lastHitBrush.
   */
  lastHitTriangle = -1;

  // ---- per slot (BVH leaf order)
  private readonly slotCount: number;
  private readonly slotBrush: Int32Array;
  private readonly slotContents: Int32Array;
  private readonly slotModel: Int32Array;
  private readonly slotEnabled: Uint8Array;
  private readonly slotBounds: Float64Array; // 6 per slot
  private readonly slotSideStart: Int32Array; // slotCount + 1
  // ---- per side (grouped by slot, original side order within a brush)
  private readonly planes: Float64Array; // nx ny nz dist
  private readonly sideBevel: Uint8Array;
  // ---- BVH
  private readonly nodeBounds: Float64Array;
  private readonly nodeInfo: Int32Array;
  private readonly nodeCount: number;
  private readonly bvhDepth: number;
  private readonly stack: Int32Array;
  private queryStack: Int32Array;
  private queryBusy = false;
  // ---- models
  private readonly disabledModels = new Set<number>();
  private readonly modelSlots = new Map<number, number[]>();
  // ---- triangles (per triangle slot, in triangle-BVH leaf order)
  private readonly triCount: number;
  private readonly triVerts: Float64Array; // 9 per slot
  private readonly triBevelDir: Float32Array; // 9 per slot: unit edge directions
  private readonly triBevelInv: Float32Array; // 9 per slot: edge x axis normalizers
  private readonly triBevelFlags: Uint32Array; // bevel selection, see computeBevels
  private readonly triPlanes: Float64Array; // nx ny nz d per slot
  private readonly triContents: Int32Array;
  private readonly triModel: Int32Array;
  private readonly triEnabled: Uint8Array;
  private readonly triIndex: Int32Array; // slot -> triangle number
  private readonly triSlotOf: Int32Array; // triangle number -> slot (-1 = dropped)
  private readonly triModels = new Set<number>();
  private readonly triNodeBounds: Float64Array;
  private readonly triNodeInfo: Int32Array;
  private readonly triNodeCount: number;
  private readonly triDepth: number;
  private readonly triStack: Int32Array;

  /**
   * `brushes`: convex brushes (BVH over their AABBs). `opts.triangles`: triangle meshes collided as
   * two-sided triangles (displacement terrain), in their own BVH. Both are copied into flat arrays:
   * mutating the inputs afterwards has no effect.
   */
  constructor(brushes: Brush[], opts: CollisionWorldOptions = {}) {
    this.brushes = brushes;
    // gather valid brushes
    const valid: number[] = [];
    for (let i = 0; i < brushes.length; i++) {
      const b = brushes[i];
      if (!b || !b.sides || b.sides.length === 0) continue;
      if (!boundsValid(b) && !computeBrushBounds(b)) continue;
      valid.push(i);
    }
    const count = valid.length;
    const bmin = new Float64Array(count * 3);
    const bmax = new Float64Array(count * 3);
    for (let k = 0; k < count; k++) {
      const b = brushes[valid[k]];
      bmin[k * 3] = b.mins.x;
      bmin[k * 3 + 1] = b.mins.y;
      bmin[k * 3 + 2] = b.mins.z;
      bmax[k * 3] = b.maxs.x;
      bmax[k * 3 + 1] = b.maxs.y;
      bmax[k * 3 + 2] = b.maxs.z;
    }
    const bvh = buildBvh(count, bmin, bmax);
    this.nodeBounds = bvh.nodeBounds;
    this.nodeInfo = bvh.nodeInfo;
    this.nodeCount = bvh.nodeCount;
    this.bvhDepth = bvh.maxDepth;
    this.stack = new Int32Array(bvh.maxDepth * 2 + 8);
    this.queryStack = new Int32Array(bvh.maxDepth * 2 + 8);

    // flatten in slot order
    this.slotCount = count;
    this.slotBrush = new Int32Array(count);
    this.slotContents = new Int32Array(count);
    this.slotModel = new Int32Array(count);
    this.slotEnabled = new Uint8Array(count);
    this.slotBounds = new Float64Array(count * 6);
    this.slotSideStart = new Int32Array(count + 1);
    let totalSides = 0;
    for (let k = 0; k < count; k++) totalSides += brushes[valid[k]].sides.length;
    this.planes = new Float64Array(totalSides * 4);
    this.sideBevel = new Uint8Array(totalSides);
    let s = 0;
    for (let slot = 0; slot < count; slot++) {
      const k = bvh.order[slot];
      const bi = valid[k];
      const b = brushes[bi];
      this.slotBrush[slot] = bi;
      this.slotContents[slot] = b.contents | 0;
      const model = b.model | 0;
      this.slotModel[slot] = model;
      this.slotEnabled[slot] = 1;
      let list = this.modelSlots.get(model);
      if (!list) {
        list = [];
        this.modelSlots.set(model, list);
      }
      list.push(slot);
      const o6 = slot * 6;
      this.slotBounds[o6] = bmin[k * 3];
      this.slotBounds[o6 + 1] = bmin[k * 3 + 1];
      this.slotBounds[o6 + 2] = bmin[k * 3 + 2];
      this.slotBounds[o6 + 3] = bmax[k * 3];
      this.slotBounds[o6 + 4] = bmax[k * 3 + 1];
      this.slotBounds[o6 + 5] = bmax[k * 3 + 2];
      this.slotSideStart[slot] = s;
      for (const side of b.sides) {
        const n = side.plane.normal;
        this.planes[s * 4] = n.x;
        this.planes[s * 4 + 1] = n.y;
        this.planes[s * 4 + 2] = n.z;
        this.planes[s * 4 + 3] = side.plane.dist;
        this.sideBevel[s] = side.bevel ? 1 : 0;
        s++;
      }
    }
    this.slotSideStart[count] = s;

    // triangle meshes
    const soups: readonly TriangleSoup[] = !opts.triangles ? [] : Array.isArray(opts.triangles) ? opts.triangles : [opts.triangles as TriangleSoup];
    const ts = buildTriangleSet(soups);
    this.triCount = ts.count;
    this.triVerts = ts.verts;
    this.triBevelDir = ts.bevelDir;
    this.triBevelInv = ts.bevelInv;
    this.triBevelFlags = ts.bevelFlags;
    this.triPlanes = ts.planes;
    this.triContents = ts.contents;
    this.triModel = ts.model;
    this.triIndex = ts.index;
    this.triEnabled = new Uint8Array(ts.count).fill(1);
    let numbers = 0;
    for (const sp of soups) numbers += Math.floor(sp.indices.length / 3);
    this.triSlotOf = new Int32Array(numbers).fill(-1);
    let lastModel = NaN;
    for (let slot = 0; slot < ts.count; slot++) {
      this.triSlotOf[ts.index[slot]] = slot;
      const m = ts.model[slot];
      if (m !== lastModel) {
        this.triModels.add(m);
        lastModel = m;
      }
    }
    this.triNodeBounds = ts.bvh.nodeBounds;
    this.triNodeInfo = ts.bvh.nodeInfo;
    this.triNodeCount = ts.bvh.nodeCount;
    this.triDepth = ts.bvh.maxDepth;
    this.triStack = new Int32Array(ts.bvh.maxDepth * 2 + 8);
    const qs = Math.max(bvh.maxDepth, ts.bvh.maxDepth) * 2 + 8;
    if (this.queryStack.length < qs) this.queryStack = new Int32Array(qs);
  }

  /** BVH statistics (debugging / perf logging). */
  stats(): { brushes: number; sides: number; nodes: number; depth: number; triangles: number; triangleNodes: number; triangleDepth: number } {
    return {
      brushes: this.slotCount,
      sides: this.sideBevel.length,
      nodes: this.nodeCount,
      depth: this.bvhDepth,
      triangles: this.triCount,
      triangleNodes: this.triNodeCount,
      triangleDepth: this.triDepth,
    };
  }

  // ------------------------------------------------------------------------------------------- models

  /** func_brush style Enable/Disable: disabled models are ignored by every query. */
  setModelSolid(model: number, solid: boolean): void {
    if (solid) this.disabledModels.delete(model);
    else this.disabledModels.add(model);
    const slots = this.modelSlots.get(model);
    if (slots) for (const slot of slots) this.slotEnabled[slot] = solid ? 1 : 0;
    if (this.triModels.has(model)) {
      const m = this.triModel;
      for (let slot = 0; slot < this.triCount; slot++) if (m[slot] === model) this.triEnabled[slot] = solid ? 1 : 0;
    }
  }

  isModelSolid(model: number): boolean {
    return !this.disabledModels.has(model);
  }

  // ------------------------------------------------------------------------------------------- traces

  /**
   * Sweeps the box [mins, maxs] (relative to the origin) from start to end against enabled brushes whose
   * contents intersect `mask`. endpos is in the origin frame. Allocation-free when `out` is given.
   */
  traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number, out?: TraceResult): TraceResult {
    // Read every input before touching `out`: callers commonly pass out.endpos as the next start.
    const x0 = start.x;
    const y0 = start.y;
    const z0 = start.z;
    const x1 = end.x;
    const y1 = end.y;
    const z1 = end.z;
    // box center offset and half extents
    const ox = (mins.x + maxs.x) * 0.5;
    const oy = (mins.y + maxs.y) * 0.5;
    const oz = (mins.z + maxs.z) * 0.5;
    let ex = Math.abs(maxs.x - mins.x) * 0.5;
    let ey = Math.abs(maxs.y - mins.y) * 0.5;
    let ez = Math.abs(maxs.z - mins.z) * 0.5;
    const isPoint = ex * ex + ey * ey + ez * ez < POINT_EXTENT_SQ;
    if (isPoint) {
      ex = 0;
      ey = 0;
      ez = 0;
    }
    const sx = x0 + ox;
    const sy = y0 + oy;
    const sz = z0 + oz;
    const tx = x1 + ox;
    const ty = y1 + oy;
    const tz = z1 + oz;
    const dx = tx - sx;
    const dy = ty - sy;
    const dz = tz - sz;
    // inverse direction for slab tests (+-Infinity for 0 is handled by NaN-safe comparisons below)
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const bx = ex + BROAD_MARGIN;
    const by = ey + BROAD_MARGIN;
    const bz = ez + BROAD_MARGIN;

    const nodeBounds = this.nodeBounds;
    const nodeInfo = this.nodeInfo;
    const slotBounds = this.slotBounds;
    const slotContents = this.slotContents;
    const slotEnabled = this.slotEnabled;
    const slotSideStart = this.slotSideStart;
    const planes = this.planes;
    const sideBevel = this.sideBevel;
    const stack = this.stack;

    let best = 1;
    let hitSlot = -1;
    let hitSide = -1;
    let solidSlot = -1;
    let startsolid = false;
    let allsolid = false;

    let sp = 0;
    if (this.nodeCount > 0) stack[sp++] = 0;
    traverse: while (sp > 0) {
      const node = stack[--sp];
      // ---- node slab test against [0, best]
      {
        const o = node * 6;
        let tmin = 0;
        let tmax = best;
        let t1 = (nodeBounds[o] - bx - sx) * ix;
        let t2 = (nodeBounds[o + 3] + bx - sx) * ix;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (dx === 0 && (sx < nodeBounds[o] - bx || sx > nodeBounds[o + 3] + bx)) continue;
        t1 = (nodeBounds[o + 1] - by - sy) * iy;
        t2 = (nodeBounds[o + 4] + by - sy) * iy;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (dy === 0 && (sy < nodeBounds[o + 1] - by || sy > nodeBounds[o + 4] + by)) continue;
        t1 = (nodeBounds[o + 2] - bz - sz) * iz;
        t2 = (nodeBounds[o + 5] + bz - sz) * iz;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (dz === 0 && (sz < nodeBounds[o + 2] - bz || sz > nodeBounds[o + 5] + bz)) continue;
        if (tmin > tmax) continue;
      }
      const a = nodeInfo[node * 2];
      const b = nodeInfo[node * 2 + 1];
      if (b < 0) {
        // internal node: visit the child nearer to the start first
        const axis = -b - 1;
        const d = axis === 0 ? dx : axis === 1 ? dy : dz;
        if (d >= 0) {
          stack[sp++] = a;
          stack[sp++] = node + 1;
        } else {
          stack[sp++] = node + 1;
          stack[sp++] = a;
        }
        continue;
      }
      // ---- leaf: clip against each brush
      const slotEnd = a + b;
      for (let slot = a; slot < slotEnd; slot++) {
        if ((slotContents[slot] & mask) === 0 || slotEnabled[slot] === 0) continue;
        {
          const o = slot * 6;
          let tmin = 0;
          let tmax = best;
          let t1 = (slotBounds[o] - bx - sx) * ix;
          let t2 = (slotBounds[o + 3] + bx - sx) * ix;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dx === 0 && (sx < slotBounds[o] - bx || sx > slotBounds[o + 3] + bx)) continue;
          t1 = (slotBounds[o + 1] - by - sy) * iy;
          t2 = (slotBounds[o + 4] + by - sy) * iy;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dy === 0 && (sy < slotBounds[o + 1] - by || sy > slotBounds[o + 4] + by)) continue;
          t1 = (slotBounds[o + 2] - bz - sz) * iz;
          t2 = (slotBounds[o + 5] + bz - sz) * iz;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dz === 0 && (sz < slotBounds[o + 2] - bz || sz > slotBounds[o + 5] + bz)) continue;
          if (tmin > tmax) continue;
        }

        let enterfrac = -1;
        let leavefrac = 1;
        let startout = false;
        let getout = false;
        let lead = -1;
        let missed = false;
        const sEnd = slotSideStart[slot + 1];
        for (let s = slotSideStart[slot]; s < sEnd; s++) {
          if (isPoint && sideBevel[s] !== 0) continue;
          const p4 = s * 4;
          const nx = planes[p4];
          const ny = planes[p4 + 1];
          const nz = planes[p4 + 2];
          // plane pushed out by the box extents
          const dist =
            planes[p4 + 3] + (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
          const d1 = nx * sx + ny * sy + nz * sz - dist;
          const d2 = nx * tx + ny * ty + nz * tz - dist;
          if (d2 > 0) getout = true;
          if (d1 > 0) {
            startout = true;
            // completely in front of this face for the whole move: no contact with this brush
            if (d2 >= DIST_EPSILON - CLIP_NOISE || d2 >= d1) {
              missed = true;
              break;
            }
          } else if (d2 <= 0) {
            continue; // behind this face for the whole move
          }
          if (d1 > d2) {
            // entering
            const f = (d1 - DIST_EPSILON) / (d1 - d2);
            if (f > enterfrac) {
              enterfrac = f;
              lead = s;
            }
          } else {
            // leaving
            const f = (d1 + DIST_EPSILON) / (d1 - d2);
            if (f < leavefrac) leavefrac = f;
          }
        }
        if (missed) continue;
        if (!startout) {
          // the start position is inside this brush
          startsolid = true;
          if (solidSlot < 0) solidSlot = slot;
          if (!getout) {
            allsolid = true;
            solidSlot = slot;
            break traverse;
          }
          continue;
        }
        if (enterfrac < leavefrac && enterfrac > -1 && enterfrac < best) {
          best = enterfrac < 0 ? 0 : enterfrac;
          hitSlot = slot;
          hitSide = lead;
        }
      }
    }

    // ---- triangle meshes: same clipping rules, sharing `best` with the brushes
    let hitTri = -1;
    let solidTri = -1;
    let hnx = 0;
    let hny = 0;
    let hnz = 0;
    let hd = 0;
    if (!allsolid && this.triNodeCount > 0) {
      const tNodeBounds = this.triNodeBounds;
      const tNodeInfo = this.triNodeInfo;
      const tContents = this.triContents;
      const tEnabled = this.triEnabled;
      const tVerts = this.triVerts;
      const tDir = this.triBevelDir;
      const tInv = this.triBevelInv;
      const tFlags = this.triBevelFlags;
      const tPlanes = this.triPlanes;
      const tStack = this.triStack;
      kSx = sx;
      kSy = sy;
      kSz = sz;
      kTx = tx;
      kTy = ty;
      kTz = tz;
      kBest = best;
      sp = 0;
      tStack[sp++] = 0;
      triTraverse: while (sp > 0) {
        const node = tStack[--sp];
        {
          const o = node * 6;
          let tmin = 0;
          let tmax = best;
          let t1 = (tNodeBounds[o] - bx - sx) * ix;
          let t2 = (tNodeBounds[o + 3] + bx - sx) * ix;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dx === 0 && (sx < tNodeBounds[o] - bx || sx > tNodeBounds[o + 3] + bx)) continue;
          t1 = (tNodeBounds[o + 1] - by - sy) * iy;
          t2 = (tNodeBounds[o + 4] + by - sy) * iy;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dy === 0 && (sy < tNodeBounds[o + 1] - by || sy > tNodeBounds[o + 4] + by)) continue;
          t1 = (tNodeBounds[o + 2] - bz - sz) * iz;
          t2 = (tNodeBounds[o + 5] + bz - sz) * iz;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dz === 0 && (sz < tNodeBounds[o + 2] - bz || sz > tNodeBounds[o + 5] + bz)) continue;
          if (tmin > tmax) continue;
        }
        const a = tNodeInfo[node * 2];
        const b = tNodeInfo[node * 2 + 1];
        if (b < 0) {
          const axis = -b - 1;
          const d = axis === 0 ? dx : axis === 1 ? dy : dz;
          if (d >= 0) {
            tStack[sp++] = a;
            tStack[sp++] = node + 1;
          } else {
            tStack[sp++] = node + 1;
            tStack[sp++] = a;
          }
          continue;
        }
        const slotEnd = a + b;
        for (let slot = a; slot < slotEnd; slot++) {
          if ((tContents[slot] & mask) === 0 || tEnabled[slot] === 0) continue;
          // (leaves are small and tight: the triangle's own planes do the culling)
          if (!clipTriangle(tVerts, tPlanes, tDir, tInv, tFlags, slot, ex, ey, ez, isPoint)) continue;
          if (!kStartOut) {
            startsolid = true;
            if (solidSlot < 0 && solidTri < 0) solidTri = slot;
            if (!kGetOut) {
              allsolid = true;
              solidSlot = -1;
              solidTri = slot;
              break triTraverse;
            }
            continue;
          }
          if (kEnter < kLeave && kEnter > -1 && kEnter < best) {
            best = kEnter < 0 ? 0 : kEnter;
            kBest = best;
            hitSlot = -1;
            hitTri = slot;
            hnx = kLnx;
            hny = kLny;
            hnz = kLnz;
            hd = kLd;
          }
        }
      }
    }

    const tr = out ?? newTrace();
    const pn = tr.plane.normal;
    pn.x = 0;
    pn.y = 0;
    pn.z = 0;
    tr.plane.dist = 0;
    tr.startsolid = startsolid;
    tr.allsolid = false;
    tr.contents = 0;
    tr.model = -1;
    this.lastHitBrush = -1;
    this.lastHitTriangle = -1;
    const ep = tr.endpos;
    if (allsolid) {
      tr.allsolid = true;
      tr.fraction = 0;
      if (solidSlot >= 0) {
        tr.contents = this.slotContents[solidSlot];
        tr.model = this.slotModel[solidSlot];
      } else {
        tr.contents = this.triContents[solidTri];
        tr.model = this.triModel[solidTri];
      }
      ep.x = x0;
      ep.y = y0;
      ep.z = z0;
      return tr;
    }
    tr.fraction = best;
    if (hitTri >= 0) {
      tr.contents = this.triContents[hitTri];
      tr.model = this.triModel[hitTri];
      pn.x = hnx;
      pn.y = hny;
      pn.z = hnz;
      tr.plane.dist = hd;
      this.lastHitTriangle = this.triIndex[hitTri];
    } else if (hitSlot >= 0) {
      tr.contents = this.slotContents[hitSlot];
      tr.model = this.slotModel[hitSlot];
      const p4 = hitSide * 4;
      pn.x = planes[p4];
      pn.y = planes[p4 + 1];
      pn.z = planes[p4 + 2];
      tr.plane.dist = planes[p4 + 3];
      this.lastHitBrush = this.slotBrush[hitSlot];
    } else if (startsolid) {
      if (solidSlot >= 0) {
        tr.contents = this.slotContents[solidSlot];
        tr.model = this.slotModel[solidSlot];
      } else {
        tr.contents = this.triContents[solidTri];
        tr.model = this.triModel[solidTri];
      }
    }
    if (best === 1) {
      ep.x = x1;
      ep.y = y1;
      ep.z = z1;
    } else {
      ep.x = x0 + best * (x1 - x0);
      ep.y = y0 + best * (y1 - y0);
      ep.z = z0 + best * (z1 - z0);
    }
    return tr;
  }

  /** Point (ray) trace: bevel planes are ignored. */
  traceRay(start: Vec3, end: Vec3, mask: number, out?: TraceResult): TraceResult {
    return this.traceBox(start, end, ZERO, ZERO, mask, out);
  }

  // ------------------------------------------------------------------------------------------- queries

  /**
   * OR of the contents of all enabled brushes (matching `mask`) that strictly contain the point. Points
   * exactly on a face are outside (like a BSP tree walk, where on-plane points go to the front side).
   * Triangle meshes have no volume and never contribute (Source's point contents don't see displacements
   * either); testBox/traceBox do collide with them.
   */
  pointContents(p: Vec3, mask: number = MASK_ALL): number {
    const px = p.x;
    const py = p.y;
    const pz = p.z;
    const nodeBounds = this.nodeBounds;
    const nodeInfo = this.nodeInfo;
    const slotBounds = this.slotBounds;
    const planes = this.planes;
    const sideBevel = this.sideBevel;
    const stack = this.stack;
    let result = 0;
    let sp = 0;
    if (this.nodeCount > 0) stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      if (
        px < nodeBounds[o] || px > nodeBounds[o + 3] ||
        py < nodeBounds[o + 1] || py > nodeBounds[o + 4] ||
        pz < nodeBounds[o + 2] || pz > nodeBounds[o + 5]
      )
        continue;
      const a = nodeInfo[node * 2];
      const b = nodeInfo[node * 2 + 1];
      if (b < 0) {
        stack[sp++] = a;
        stack[sp++] = node + 1;
        continue;
      }
      for (let slot = a, e = a + b; slot < e; slot++) {
        const c = this.slotContents[slot];
        if ((c & mask) === 0 || this.slotEnabled[slot] === 0 || (result & c) === c) continue;
        const so = slot * 6;
        if (
          px < slotBounds[so] || px > slotBounds[so + 3] ||
          py < slotBounds[so + 1] || py > slotBounds[so + 4] ||
          pz < slotBounds[so + 2] || pz > slotBounds[so + 5]
        )
          continue;
        let inside = true;
        for (let s = this.slotSideStart[slot], se = this.slotSideStart[slot + 1]; s < se; s++) {
          if (sideBevel[s] !== 0) continue;
          const p4 = s * 4;
          if (planes[p4] * px + planes[p4 + 1] * py + planes[p4 + 2] * pz - planes[p4 + 3] >= 0) {
            inside = false;
            break;
          }
        }
        if (inside) result |= c;
      }
    }
    return result & mask;
  }

  /**
   * True if the box [origin+mins, origin+maxs] is in solid for traces: exactly the condition under
   * which traceBox(origin, origin, ...) reports startsolid (touching a face counts as inside).
   */
  testBox(origin: Vec3, mins: Vec3, maxs: Vec3, mask: number): boolean {
    const cx = origin.x + (mins.x + maxs.x) * 0.5;
    const cy = origin.y + (mins.y + maxs.y) * 0.5;
    const cz = origin.z + (mins.z + maxs.z) * 0.5;
    let ex = Math.abs(maxs.x - mins.x) * 0.5;
    let ey = Math.abs(maxs.y - mins.y) * 0.5;
    let ez = Math.abs(maxs.z - mins.z) * 0.5;
    const isPoint = ex * ex + ey * ey + ez * ez < POINT_EXTENT_SQ;
    if (isPoint) {
      ex = 0;
      ey = 0;
      ez = 0;
    }
    const bx = ex + BROAD_MARGIN;
    const by = ey + BROAD_MARGIN;
    const bz = ez + BROAD_MARGIN;
    const nodeBounds = this.nodeBounds;
    const nodeInfo = this.nodeInfo;
    const slotBounds = this.slotBounds;
    const planes = this.planes;
    const sideBevel = this.sideBevel;
    const stack = this.stack;
    let sp = 0;
    if (this.nodeCount > 0) stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      if (
        cx < nodeBounds[o] - bx || cx > nodeBounds[o + 3] + bx ||
        cy < nodeBounds[o + 1] - by || cy > nodeBounds[o + 4] + by ||
        cz < nodeBounds[o + 2] - bz || cz > nodeBounds[o + 5] + bz
      )
        continue;
      const a = nodeInfo[node * 2];
      const b = nodeInfo[node * 2 + 1];
      if (b < 0) {
        stack[sp++] = a;
        stack[sp++] = node + 1;
        continue;
      }
      for (let slot = a, e = a + b; slot < e; slot++) {
        if ((this.slotContents[slot] & mask) === 0 || this.slotEnabled[slot] === 0) continue;
        const so = slot * 6;
        if (
          cx < slotBounds[so] - bx || cx > slotBounds[so + 3] + bx ||
          cy < slotBounds[so + 1] - by || cy > slotBounds[so + 4] + by ||
          cz < slotBounds[so + 2] - bz || cz > slotBounds[so + 5] + bz
        )
          continue;
        let inside = true;
        for (let s = this.slotSideStart[slot], se = this.slotSideStart[slot + 1]; s < se; s++) {
          if (isPoint && sideBevel[s] !== 0) continue;
          const p4 = s * 4;
          const nx = planes[p4];
          const ny = planes[p4 + 1];
          const nz = planes[p4 + 2];
          const dist =
            planes[p4 + 3] + (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
          if (nx * cx + ny * cy + nz * cz - dist > 0) {
            inside = false;
            break;
          }
        }
        if (inside) return true;
      }
    }
    return this.triNodeCount > 0 && this.testTriangles(cx, cy, cz, ex, ey, ez, isPoint, mask);
  }

  /** testBox against the triangle meshes (box centre c, half extents e). */
  private testTriangles(cx: number, cy: number, cz: number, ex: number, ey: number, ez: number, isPoint: boolean, mask: number): boolean {
    const bx = ex + BROAD_MARGIN;
    const by = ey + BROAD_MARGIN;
    const bz = ez + BROAD_MARGIN;
    const nodeBounds = this.triNodeBounds;
    const nodeInfo = this.triNodeInfo;
    const stack = this.triStack;
    // a zero-length sweep: the triangle hull contains the box iff no plane separates them
    kBest = 1;
    kSx = cx;
    kSy = cy;
    kSz = cz;
    kTx = cx;
    kTy = cy;
    kTz = cz;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      if (
        cx < nodeBounds[o] - bx || cx > nodeBounds[o + 3] + bx ||
        cy < nodeBounds[o + 1] - by || cy > nodeBounds[o + 4] + by ||
        cz < nodeBounds[o + 2] - bz || cz > nodeBounds[o + 5] + bz
      )
        continue;
      const a = nodeInfo[node * 2];
      const b = nodeInfo[node * 2 + 1];
      if (b < 0) {
        stack[sp++] = a;
        stack[sp++] = node + 1;
        continue;
      }
      for (let slot = a, e = a + b; slot < e; slot++) {
        if ((this.triContents[slot] & mask) === 0 || this.triEnabled[slot] === 0) continue;
        if (clipTriangle(this.triVerts, this.triPlanes, this.triBevelDir, this.triBevelInv, this.triBevelFlags, slot, ex, ey, ez, isPoint)) return true;
      }
    }
    return false;
  }

  /** Calls cb for every enabled brush whose AABB overlaps (or touches) [mins, maxs]. Any contents. */
  queryBox(mins: Vec3, maxs: Vec3, cb: (b: Brush) => void): void {
    // re-entrant: a callback may run another query
    let stack = this.queryStack;
    const ownStack = !this.queryBusy;
    if (!ownStack) stack = new Int32Array(this.queryStack.length);
    this.queryBusy = true;
    try {
      const nodeBounds = this.nodeBounds;
      const nodeInfo = this.nodeInfo;
      const slotBounds = this.slotBounds;
      const x0 = mins.x, y0 = mins.y, z0 = mins.z, x1 = maxs.x, y1 = maxs.y, z1 = maxs.z;
      let sp = 0;
      if (this.nodeCount > 0) stack[sp++] = 0;
      while (sp > 0) {
        const node = stack[--sp];
        const o = node * 6;
        if (
          x1 < nodeBounds[o] || x0 > nodeBounds[o + 3] ||
          y1 < nodeBounds[o + 1] || y0 > nodeBounds[o + 4] ||
          z1 < nodeBounds[o + 2] || z0 > nodeBounds[o + 5]
        )
          continue;
        const a = nodeInfo[node * 2];
        const b = nodeInfo[node * 2 + 1];
        if (b < 0) {
          stack[sp++] = a;
          stack[sp++] = node + 1;
          continue;
        }
        for (let slot = a, e = a + b; slot < e; slot++) {
          if (this.slotEnabled[slot] === 0) continue;
          const so = slot * 6;
          if (
            x1 < slotBounds[so] || x0 > slotBounds[so + 3] ||
            y1 < slotBounds[so + 1] || y0 > slotBounds[so + 4] ||
            z1 < slotBounds[so + 2] || z0 > slotBounds[so + 5]
          )
            continue;
          cb(this.brushes[this.slotBrush[slot]]);
        }
      }
    } finally {
      if (ownStack) this.queryBusy = false;
    }
  }

  // ------------------------------------------------------------------------------------------- triangles

  /** Number of collidable triangles (degenerate input triangles are dropped). */
  get triangleCount(): number {
    return this.triCount;
  }

  /**
   * Calls cb with the triangle number (see TriangleSoup) of every enabled triangle whose AABB overlaps (or
   * touches) [mins, maxs]. Any contents. queryBox only reports brushes; use both to find everything solid
   * near a box. Re-entrant like queryBox.
   */
  queryTriangles(mins: Vec3, maxs: Vec3, cb: (tri: number) => void): void {
    if (this.triNodeCount === 0) return;
    const stack = new Int32Array(this.triDepth * 2 + 8);
    const nodeBounds = this.triNodeBounds;
    const nodeInfo = this.triNodeInfo;
    const V = this.triVerts;
    const x0 = mins.x, y0 = mins.y, z0 = mins.z, x1 = maxs.x, y1 = maxs.y, z1 = maxs.z;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      if (
        x1 < nodeBounds[o] || x0 > nodeBounds[o + 3] ||
        y1 < nodeBounds[o + 1] || y0 > nodeBounds[o + 4] ||
        z1 < nodeBounds[o + 2] || z0 > nodeBounds[o + 5]
      )
        continue;
      const a = nodeInfo[node * 2];
      const b = nodeInfo[node * 2 + 1];
      if (b < 0) {
        stack[sp++] = a;
        stack[sp++] = node + 1;
        continue;
      }
      for (let slot = a, e = a + b; slot < e; slot++) {
        if (this.triEnabled[slot] === 0) continue;
        const o = slot * 9;
        if (
          x1 < Math.min(V[o], V[o + 3], V[o + 6]) || x0 > Math.max(V[o], V[o + 3], V[o + 6]) ||
          y1 < Math.min(V[o + 1], V[o + 4], V[o + 7]) || y0 > Math.max(V[o + 1], V[o + 4], V[o + 7]) ||
          z1 < Math.min(V[o + 2], V[o + 5], V[o + 8]) || z0 > Math.max(V[o + 2], V[o + 5], V[o + 8])
        )
          continue;
        cb(this.triIndex[slot]);
      }
    }
  }

  /**
   * Vertices (a, b, c: 9 numbers, front = counter-clockwise), plane, contents and model of triangle `tri`,
   * or null if it was dropped (degenerate / bad indices) or doesn't exist.
   */
  triangle(tri: number): { verts: Float64Array; normal: Vec3; dist: number; contents: number; model: number } | null {
    const slot = tri >= 0 && tri < this.triSlotOf.length ? this.triSlotOf[tri] : -1;
    if (slot < 0) return null;
    const p = this.triPlanes;
    return {
      verts: this.triVerts.slice(slot * 9, slot * 9 + 9),
      normal: v3(p[slot * 4], p[slot * 4 + 1], p[slot * 4 + 2]),
      dist: p[slot * 4 + 3],
      contents: this.triContents[slot],
      model: this.triModel[slot],
    };
  }

  /**
   * Triangle `tri` as a zero-volume Brush (both faces, edge walls, axial and edge bevels; bounds = the
   * triangle's), for code that works on brushes (boxIntersectsBrush, debug drawing). Null if dropped.
   */
  triangleBrush(tri: number): Brush | null {
    const t = this.triangle(tri);
    if (!t) return null;
    const V = t.verts;
    const n = t.normal;
    const sides: BrushSide[] = [
      { plane: { normal: v3(n.x, n.y, n.z), dist: t.dist }, bevel: false },
      { plane: { normal: v3(-n.x, -n.y, -n.z), dist: -t.dist }, bevel: false },
    ];
    const mins = v3(Math.min(V[0], V[3], V[6]), Math.min(V[1], V[4], V[7]), Math.min(V[2], V[5], V[8]));
    const maxs = v3(Math.max(V[0], V[3], V[6]), Math.max(V[1], V[4], V[7]), Math.max(V[2], V[5], V[8]));
    for (let i = 0; i < 3; i++) {
      const p = i * 3;
      const q = ((i + 1) % 3) * 3;
      const ex = V[q] - V[p], ey = V[q + 1] - V[p + 1], ez = V[q + 2] - V[p + 2];
      const w = v3(ey * n.z - ez * n.y, ez * n.x - ex * n.z, ex * n.y - ey * n.x);
      const l = Math.hypot(w.x, w.y, w.z);
      if (!(l > 1e-12)) continue;
      w.x /= l;
      w.y /= l;
      w.z /= l;
      sides.push({ plane: { normal: w, dist: w.x * V[p] + w.y * V[p + 1] + w.z * V[p + 2] }, bevel: false });
    }
    const axial = [v3(-1, 0, 0), v3(1, 0, 0), v3(0, -1, 0), v3(0, 1, 0), v3(0, 0, -1), v3(0, 0, 1)];
    const ext = [-mins.x, maxs.x, -mins.y, maxs.y, -mins.z, maxs.z];
    for (let k = 0; k < 6; k++) sides.push({ plane: { normal: axial[k], dist: ext[k] }, bevel: true });
    // edge x axis bevels (same selection as the trace)
    for (let i = 0; i < 3; i++) {
      const p = i * 3;
      const q = ((i + 1) % 3) * 3;
      const k = ((i + 2) % 3) * 3;
      let ex = V[q] - V[p], ey = V[q + 1] - V[p + 1], ez = V[q + 2] - V[p + 2];
      const el = Math.hypot(ex, ey, ez);
      if (el < BEVEL_MIN_EDGE) continue;
      ex /= el;
      ey /= el;
      ez /= el;
      for (const c of [v3(0, ez, -ey), v3(-ez, 0, ex), v3(ey, -ex, 0)]) {
        const l = Math.hypot(c.x, c.y, c.z);
        if (l < BEVEL_MIN_CROSS) continue;
        c.x /= l;
        c.y /= l;
        c.z /= l;
        if (Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)) > AXIAL_LIMIT) continue;
        if (Math.abs(c.x * n.x + c.y * n.y + c.z * n.z) > AXIAL_LIMIT) continue;
        const sp = c.x * V[p] + c.y * V[p + 1] + c.z * V[p + 2];
        const sq = c.x * V[q] + c.y * V[q + 1] + c.z * V[q + 2];
        const sk = c.x * V[k] + c.y * V[k + 1] + c.z * V[k + 2];
        const eMax = Math.max(sp, sq);
        const eMin = Math.min(sp, sq);
        if (eMin >= sk - BEVEL_ON_EPSILON) sides.push({ plane: { normal: v3(c.x, c.y, c.z), dist: Math.max(eMax, sk) }, bevel: true });
        if (eMax <= sk + BEVEL_ON_EPSILON) sides.push({ plane: { normal: v3(-c.x, -c.y, -c.z), dist: -Math.min(eMin, sk) }, bevel: true });
      }
    }
    return { sides, contents: t.contents, mins, maxs, model: t.model };
  }
}

/**
 * Exact overlap test of an absolute AABB against a convex brush, using the brush planes (bevels
 * included) pushed out by the box half-extents. Touching faces do not count as intersecting.
 * Used for trigger touching.
 */
export function boxIntersectsBrush(boxMins: Vec3, boxMaxs: Vec3, brush: Brush): boolean {
  const bm = brush.mins;
  const bM = brush.maxs;
  // axial separation first (also covers brushes that lack axial bevels)
  if (boxMaxs.x <= bm.x || boxMins.x >= bM.x) return false;
  if (boxMaxs.y <= bm.y || boxMins.y >= bM.y) return false;
  if (boxMaxs.z <= bm.z || boxMins.z >= bM.z) return false;
  const cx = (boxMins.x + boxMaxs.x) * 0.5;
  const cy = (boxMins.y + boxMaxs.y) * 0.5;
  const cz = (boxMins.z + boxMaxs.z) * 0.5;
  const ex = Math.abs(boxMaxs.x - boxMins.x) * 0.5;
  const ey = Math.abs(boxMaxs.y - boxMins.y) * 0.5;
  const ez = Math.abs(boxMaxs.z - boxMins.z) * 0.5;
  const sides = brush.sides;
  for (let i = 0; i < sides.length; i++) {
    const p = sides[i].plane;
    const n = p.normal;
    const dist = p.dist + Math.abs(n.x) * ex + Math.abs(n.y) * ey + Math.abs(n.z) * ez;
    if (n.x * cx + n.y * cy + n.z * cz - dist >= 0) return false;
  }
  return true;
}
