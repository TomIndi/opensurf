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
// Which brushes a sweep touches is decided exactly like Source: a brush is skipped as soon as the box is
// in front of one of its (pushed) planes at both ends of the move (d1 > 0 && d2 > 0) - DIST_EPSILON only
// pulls a hit back, it never makes a brush bigger. (Quake 3's rule, d1 > 0 && (d2 >= epsilon || d2 >= d1),
// counts a move that ends within the epsilon of a face as touching that brush and then reports whichever face
// was entered last: every brush grows by DIST_EPSILON. A ramp's next brush whose face sits a few hundredths
// of a unit proud of the ramp - surf maps are full of them, e.g. the end cap on surf_utopia_njv's ramp into
// the box, 0.016 proud - then is a step the hull hovering DIST_EPSILON above the ramp runs into, and the
// player stops dead on that brush's end face while CS:S / CS:GO slide straight across.)
//
// Properties the movement code can rely on (all covered by tests/collision.test.ts):
//  - A hit leaves endpos exactly DIST_EPSILON off the hit plane (pushed out by the box), measured along
//    its normal; plane is the brush side's ORIGINAL plane (not expanded). fraction 1 => endpos === end.
//  - A move that ends within DIST_EPSILON of a face without reaching it is not a hit (Source): the box can
//    end anywhere in (0, DIST_EPSILON) off a surface (a soft landing, a step), and the next move into it
//    stops at fraction 0 there.
//  - Sliding parallel to a surface from on or inside its epsilon shell never re-hits it, and the next
//    brush along a ramp is not hit unless its face really sticks out above the hull: coplanar seams,
//    and faces proud by less than the hover height, are passed.
//  - As in Source, an entering face's fraction is clamped at 0: a box that starts within DIST_EPSILON of a
//    face and moves into it is stopped at fraction 0. When every face a brush is entered through is like
//    that (the box starts inside all their epsilon shells), Source's choice of the reported face and brush
//    comes down to side and BSP order; here it is the face the box really crosses last (where it would
//    really enter the brush - e.g. a ramp's next brush's top rather than its end face or edge bevel), and
//    of several brushes hit at 0 the one it really enters first.
//  - Like Source, sweeping past a brush corner shallower than DIST_EPSILON is not a hit ("corner
//    shaving"), so a trace stopped by one brush can end inside a grazed neighbour by at most
//    DIST_EPSILON. The next trace then reports startsolid; Source's CheckStuck (unstuckPlayer) handles it.
//  - Real-map brushes should keep the compiler's bevel sides (Source-exact edge behaviour);
//    addBrushBevels never removes them, it only adds missing ones.
//
// Static-prop collision hulls (brush model PROP_HULL_MODEL: the convex pieces of a prop's .phy) are not clipped
// by those rules. Source doesn't trace props with CM_ClipBoxToBrush but through VPhysics, and on curved prop ramps
// (surf_summer_ksf's) KSF world-record replays follow the rule this file used for every brush before (Quake 3's):
//  - a move that ends within DIST_EPSILON of a hull face without reaching it still touches the hull (and is pulled
//    back to DIST_EPSILON off it), while one that ends within CLIP_NOISE of that shell, or doesn't approach the
//    face, misses it;
//  - entering fractions are not clamped at 0 while the hull's faces are compared: the face whose pulled-back
//    crossing comes last is reported, even when that lies behind the start (the trace's fraction is then 0).
// Of hulls hit at 0, the last one checked whose pulled-back crossing lies behind the start wins (as before); a brush
// or triangle hit at 0 wins over a hull hit at 0 (Source traces the world first, and a prop only replaces a strictly
// shorter trace). Prop hulls never move: the moving-brush pass (setModelTransform) always uses the brush rules.
//
// Triangle meshes (displacement terrain, CollisionWorldOptions.triangles) live in their own BVH (a
// Morton-order tree: linear-time to build, which matters for the ~180k terrain triangles of the heaviest
// maps) and are traced with the same clipping rules as brushes: for box traces every triangle is a
// zero-thickness convex hull whose planes are the triangle plane facing each way, the triangle's axial
// bounds and its edge x axis bevels - the separating axes of a box and a triangle, so plane pushing is
// exact - clipped exactly like a brush (DIST_EPSILON pull-back, startsolid/allsolid, corner shaving). The
// reported plane is the triangle plane, or the axial / bevel plane that was entered last (edge and vertex
// contacts), as for brush bevels. A triangle's edge bevel planes are built the first time a box trace gets
// that far (and kept): most terrain triangles are never touched, so building the world stays cheap.
// Triangles are TWO-SIDED: a box is stopped DIST_EPSILON in front of whichever face it approaches, so
// terrain can't be passed from above or below. Source's displacement collision is solid from the front
// only; the 2-unit prism brushes this replaces were solid from both sides, and two-sided keeps that: a
// player who ends up under terrain (a teleport, a moving brush) can't fall through it from behind either.
// A zero-thickness hull would let degenerate flat boxes slip through, because the pulled-in leave
// fraction equals the enter fraction; for those the far face is moved TRI_MIN_THICKNESS behind the
// triangle (as seen from the trace start). Point traces use a plain two-sided segment/triangle test with
// the same face-plane rules and edges included, so rays don't leak through the seams between triangles
// the way they do between thin brushes.
// Triangles have no volume: pointContents ignores them (like Source, where displacements aren't part of
// the BSP contents), while testBox/traceBox see them (touching counts as inside, as for brushes). queryBox
// reports brushes only; queryTriangles / triangle / triangleBrush expose the triangles.
//
// Moving brush models (doors, rotators, trains: setModelTransform) leave the static BVH on their first move
// for a short list of RigidBrush records whose planes, bevels and bounds are re-derived from the base
// geometry for each new placement; every query visits that list after the BVH with the same clipping rules.
//
// Implemented from the algorithm descriptions; no engine code was used.
import type { QAngle } from '../core/angles';
import { Vec3, v3 } from '../core/vec3';
import { brushWindings, computeBrushBounds } from './brushbuild';
import { Brush, BrushSide, CONTENTS_SOLID, DIST_EPSILON, MASK_ALL, TraceResult, TraceWorld, newTrace } from './types';

/**
 * Extra slack added to every broad-phase box (BVH nodes and brush AABBs). Plane clipping with the
 * DIST_EPSILON offsets can register a hit slightly outside the expanded brush AABB (up to
 * DIST_EPSILON for box traces; a bit more near sharp edges for point traces, which ignore bevels).
 * Purely a culling margin: the exact result comes from the planes.
 */
const BROAD_MARGIN = 1.0;
/**
 * Brush model number of static-prop collision hulls (PROP_COLLISION_MODEL in bsp/props.ts; physics doesn't
 * depend on bsp, tests/prop_hulls.test.ts checks they agree). Their brushes keep Quake 3's touch rule (see the
 * file comment).
 */
export const PROP_HULL_MODEL = -2;
/**
 * Float noise allowance of the prop-hull "missed" test (d2 >= DIST_EPSILON - CLIP_NOISE). A box that ended a
 * previous move DIST_EPSILON off a hull face and now slides parallel to it has d1 ~= d2 ~= DIST_EPSILON; rounding
 * could make d2 a hair below DIST_EPSILON while d1 - d2 is ~1e-15, which would turn (d1 - eps) / (d1 - d2) into an
 * arbitrary fraction and stop the player mid-ramp. Five orders of magnitude below anything observable.
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
// Clip state for one triangle, shared by the clip helpers below (traces are synchronous and never
// re-enter); same rules as the brush loop in CollisionWorld.traceBox. The numbers live in a typed array:
// numbers kept in module-scope `let`s are boxed, so every store would allocate in the hottest loop.
//   KS[0..2]  start box centre         KS[3..5]  end box centre
//   KS[6]     enter fraction           KS[7]     leave fraction
//   KS[8..10] leading plane normal     KS[11]    leading plane distance (unexpanded)
//   KS[12]    the trace's best fraction so far: a triangle entered after it can't change the result
//   KS[13]    of the entering planes whose epsilon shell the move starts in: the latest real crossing
//             d1 / (d1 - d2); KS[14..17] that plane (normal, unexpanded distance)
const KS = new Float64Array(18);
/**
 * Initial enter fraction ("no entering plane yet", Source's "never updated" sentinel). Every entering plane
 * counts, however far before the start its pulled-back crossing lies: as in Source that fraction is clamped to
 * 0, so a box that starts within DIST_EPSILON of a face and moves into it is stopped at fraction 0 however small
 * the move (which face is reported then: see CollisionWorld.traceBox). With Quake 3's -1 instead, moves into a
 * face shorter than DIST_EPSILON - gap passed unchecked and a player sliding along a slightly slanted wall crept
 * into it; ignoring crossings pulled back by more than ~1e4 moves did the same to a player walking into a steep
 * displacement slope while friction slowed them down: each tick ended a little closer inside the slope's epsilon
 * shell (no hit: it stopped short), until a move of 2e-6 units crossed it and ended in solid.
 */
const NEVER_UPDATED = -9999;
let kStartOut = false;
let kGetOut = false;

/**
 * Numbers per triangle slot in the triangle data array: vertices a, b, c (9; counter-clockwise around the
 * normal), unit normal (3), plane distance (1). One record per triangle keeps a leaf's data contiguous.
 */
const TRI_STRIDE = 13;
/** Most numbers triangleBevels writes for one triangle: the count + 18 planes. */
const TRI_BEVELS_MAX = 1 + 18 * 4;

/**
 * One half-space n.p <= dist (dist already pushed out by the box; `support` = the unexpanded plane
 * distance reported on a hit). Returns false when the move misses the hull (clearly in front of it).
 */
function clipPlane(nx: number, ny: number, nz: number, dist: number, support: number): boolean {
  const d1 = nx * KS[0] + ny * KS[1] + nz * KS[2] - dist;
  const d2 = nx * KS[3] + ny * KS[4] + nz * KS[5] - dist;
  if (d2 > 0) kGetOut = true;
  if (d1 > 0) {
    kStartOut = true;
    // in front of this plane at both ends: the move never touches the hull (Source)
    if (d2 > 0) return false;
  } else if (d2 <= 0) {
    return true;
  }
  if (d1 > d2) {
    let f = (d1 - DIST_EPSILON) / (d1 - d2);
    if (f <= 0) {
      // starts inside this plane's epsilon shell: enters at 0 (Source); keep the plane really crossed last
      f = 0;
      const t = d1 / (d1 - d2);
      if (t > KS[13]) {
        KS[13] = t;
        KS[14] = nx;
        KS[15] = ny;
        KS[16] = nz;
        KS[17] = support;
      }
    }
    if (f > KS[6]) {
      KS[6] = f;
      KS[8] = nx;
      KS[9] = ny;
      KS[10] = nz;
      KS[11] = support;
      // (an entering plane means the start is outside: no startsolid either)
      if (f > KS[12] || (f === KS[12] && f > 0)) return false;
    }
  } else {
    const f = (d1 + DIST_EPSILON) / (d1 - d2);
    if (f < KS[7]) KS[7] = f;
  }
  // enter/leave only move towards each other: once crossed (and started outside) it's a miss
  return !(kStartOut && KS[6] >= KS[7]);
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
 * The swept box (centre KS[0..2] -> KS[3..5], half extents ex/ey/ez) against the face and axial planes of
 * triangle slot `t` of T (TRI_STRIDE per slot), after a swept-bounds broad phase within [0, KS[12]]. Resets
 * the clip state first. Returns false when the move misses; otherwise the edge bevels (clipBevelPlanes)
 * complete the hull and then KS[6..11], kStartOut and kGetOut hold the result, exactly like a brush clip.
 * The planes are the separating axes of a box and a triangle, so plane pushing is exact.
 */
function clipTriangleHull(T: Float64Array, t: number, ex: number, ey: number, ez: number): boolean {
  KS[6] = NEVER_UPDATED;
  KS[7] = 1;
  KS[13] = -1;
  kStartOut = false;
  kGetOut = false;
  const o = t * TRI_STRIDE;
  const ax = T[o];
  const ay = T[o + 1];
  const az = T[o + 2];
  const bx = T[o + 3];
  const by = T[o + 4];
  const bz = T[o + 5];
  const cx = T[o + 6];
  const cy = T[o + 7];
  const cz = T[o + 8];
  const minx = ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx;
  const maxx = ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx;
  const miny = ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy;
  const maxy = ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy;
  const minz = az < bz ? (az < cz ? az : cz) : bz < cz ? bz : cz;
  const maxz = az > bz ? (az > cz ? az : cz) : bz > cz ? bz : cz;
  const sx = KS[0];
  const sy = KS[1];
  const sz = KS[2];
  // broad phase: the swept box against the triangle's bounds (with the usual margin) within [0, best]
  {
    let tmin = 0;
    let tmax = KS[12];
    const dx = KS[3] - sx;
    const dy = KS[4] - sy;
    const dz = KS[5] - sz;
    const bx0 = minx - ex - BROAD_MARGIN - sx;
    const bx1 = maxx + ex + BROAD_MARGIN - sx;
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
    const by0 = miny - ey - BROAD_MARGIN - sy;
    const by1 = maxy + ey + BROAD_MARGIN - sy;
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
    const bz0 = minz - ez - BROAD_MARGIN - sz;
    const bz1 = maxz + ez + BROAD_MARGIN - sz;
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
  const nx = T[o + 9];
  const ny = T[o + 10];
  const nz = T[o + 11];
  const d = T[o + 12];
  // the two faces: the one facing the start is exact, the far one is moved back for thin hulls
  const r = (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
  const rf = r < TRI_MIN_THICKNESS ? TRI_MIN_THICKNESS : r;
  if (nx * sx + ny * sy + nz * sz - d >= 0) {
    if (!clipPlane(nx, ny, nz, d + r, d) || !clipPlane(-nx, -ny, -nz, rf - d, -d)) return false;
  } else if (!clipPlane(-nx, -ny, -nz, r - d, -d) || !clipPlane(nx, ny, nz, d + rf, d)) {
    return false;
  }
  // then the axial planes of the triangle bounds
  return clipAxial(0, minx, maxx, ex, sx) && clipAxial(1, miny, maxy, ey, sy) && clipAxial(2, minz, maxz, ez, sz);
}

/**
 * The edge bevel planes of one triangle (see triangleBevels), stored in B at `off`: B[off] = count, then
 * count x (nx ny nz dist). Continues the clip clipTriangleHull started.
 */
function clipBevelPlanes(B: Float64Array, off: number, ex: number, ey: number, ez: number): boolean {
  const end = off + 1 + B[off] * 4;
  for (let o = off + 1; o < end; o += 4) {
    const nx = B[o];
    const ny = B[o + 1];
    const nz = B[o + 2];
    const d = B[o + 3];
    const r = (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
    if (!clipPlane(nx, ny, nz, d + r, d)) return false;
  }
  return true;
}

/**
 * Writes the edge x axis bevel planes of triangle slot t of T to out[o] = count, then count x (nx ny nz
 * dist); returns how many numbers it wrote (1 + 4 * count, at most TRI_BEVELS_MAX). For edge i (vertex i
 * -> i+1) and axis a, the unit normal c = unit edge x axis is kept in the direction(s) in which the edge
 * supports the triangle (within BEVEL_ON_EPSILON), at the triangle's support distance along it. Skipped:
 * short edges, edges (nearly) along the axis, and normals that duplicate an axial or a face plane. Same
 * selection rules as the brush bevel builders.
 */
function triangleBevels(T: Float64Array, t: number, out: Float64Array, o: number): number {
  const b = t * TRI_STRIDE;
  const nx = T[b + 9];
  const ny = T[b + 10];
  const nz = T[b + 11];
  let w = o + 1;
  for (let i = 0; i < 3; i++) {
    const p = b + i * 3;
    const q = b + ((i + 1) % 3) * 3;
    const k = b + ((i + 2) % 3) * 3;
    let ex = T[q] - T[p];
    let ey = T[q + 1] - T[p + 1];
    let ez = T[q + 2] - T[p + 2];
    const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (!(len >= BEVEL_MIN_EDGE)) continue;
    ex /= len;
    ey /= len;
    ez /= len;
    for (let a = 0; a < 3; a++) {
      let cx: number;
      let cy: number;
      let cz: number;
      if (a === 0) {
        cx = 0;
        cy = ez;
        cz = -ey;
      } else if (a === 1) {
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
      cx /= l;
      cy /= l;
      cz /= l;
      // axial normals duplicate the axial planes, normals along the triangle normal the face planes
      if (cx > AXIAL_LIMIT || cx < -AXIAL_LIMIT || cy > AXIAL_LIMIT || cy < -AXIAL_LIMIT || cz > AXIAL_LIMIT || cz < -AXIAL_LIMIT) continue;
      const cn = cx * nx + cy * ny + cz * nz;
      if (cn > AXIAL_LIMIT || cn < -AXIAL_LIMIT) continue;
      const sp = cx * T[p] + cy * T[p + 1] + cz * T[p + 2];
      const sq = cx * T[q] + cy * T[q + 1] + cz * T[q + 2];
      const sk = cx * T[k] + cy * T[k + 1] + cz * T[k + 2];
      const eMax = sp > sq ? sp : sq;
      const eMin = sp > sq ? sq : sp;
      if (eMin >= sk - BEVEL_ON_EPSILON) {
        out[w] = cx;
        out[w + 1] = cy;
        out[w + 2] = cz;
        out[w + 3] = eMax > sk ? eMax : sk;
        w += 4;
      }
      if (eMax <= sk + BEVEL_ON_EPSILON) {
        out[w] = -cx;
        out[w + 1] = -cy;
        out[w + 2] = -cz;
        out[w + 3] = -(eMin < sk ? eMin : sk);
        w += 4;
      }
    }
  }
  out[o] = (w - o - 1) / 4;
  return w - o;
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
 * Point trace against triangle slot `t` of T: the segment KS[0..2] -> KS[3..5] against the zero-thickness
 * triangle, two-sided, with the brush rules for the face planes (a hit stops DIST_EPSILON in front of the
 * face that is crossed; ending short of it is no hit; a start exactly on the triangle is startsolid). The
 * contact must project into the triangle, edges included (see projectsInside): unlike a clipped thin brush,
 * whose pulled-in leave fractions let rays through within DIST_EPSILON of its edges, a triangulated surface
 * has no seams for rays. Resets and sets the clip state like clipTriangleHull.
 */
function clipTriangleRay(T: Float64Array, t: number): boolean {
  KS[6] = NEVER_UPDATED;
  KS[7] = 1;
  KS[13] = -1;
  kStartOut = false;
  kGetOut = false;
  const o = t * TRI_STRIDE;
  const fnx = T[o + 9];
  const fny = T[o + 10];
  const fnz = T[o + 11];
  let nx = fnx;
  let ny = fny;
  let nz = fnz;
  let d = T[o + 12];
  let d1 = nx * KS[0] + ny * KS[1] + nz * KS[2] - d;
  let d2 = nx * KS[3] + ny * KS[4] + nz * KS[5] - d;
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
  const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  if (d1 === 0) {
    // starting on the plane: inside (touching) when on the triangle, which then doesn't block
    if (!projectsInside(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, KS[0], KS[1], KS[2])) return false;
    kGetOut = !(d2 === 0 && projectsInside(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, KS[3], KS[4], KS[5]));
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
  // d1 > 0 here: the segment must reach the plane (Source)
  if (d2 > 0) return false;
  const f = (d1 - DIST_EPSILON) / (d1 - d2);
  // where the segment meets the plane
  const fc = d1 / (d1 - d2);
  const px = KS[0] + (KS[3] - KS[0]) * fc;
  const py = KS[1] + (KS[4] - KS[1]) * fc;
  const pz = KS[2] + (KS[5] - KS[2]) * fc;
  if (!projectsInside(ax, ay, az, bx, by, bz, cx, cy, cz, fnx, fny, fnz, px, py, pz)) return false;
  kStartOut = true;
  kGetOut = true;
  KS[6] = f < 0 ? 0 : f;
  KS[13] = fc;
  KS[8] = nx;
  KS[9] = ny;
  KS[10] = nz;
  KS[11] = d;
  return true;
}

// ------------------------------------------------------------------------------------- triangle set build
// Runs once per map load on ~200k triangles, i.e. mostly before the JIT has warmed up: every pass is its
// own small function over typed arrays (one hot loop each, monomorphic), so it is optimized on its own and
// never deoptimizes on the next pass's code.

interface TriangleSet {
  count: number;
  /** TRI_STRIDE numbers per slot (BVH leaf order). */
  data: Float64Array;
  contents: Int32Array;
  model: Int32Array;
  /** Slot -> triangle number. */
  index: Int32Array;
  /** Triangle number -> slot (-1 = dropped). */
  slotOf: Int32Array;
  /** Distinct models of the triangles. */
  models: Set<number>;
  bvh: Bvh;
}

function asF64(a: ArrayLike<number>): Float64Array {
  return a instanceof Float64Array ? a : Float64Array.from(a);
}

/** Indices as a Uint32Array; anything that isn't a non-negative integer becomes an invalid index. */
function asU32(a: ArrayLike<number>): Uint32Array {
  if (a instanceof Uint32Array) return a;
  const out = new Uint32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    out[i] = v >= 0 && v < 0xffffffff && Math.floor(v) === v ? v : 0xffffffff;
  }
  return out;
}

/** A per-triangle attribute: a per-triangle Int32Array, or null when the constant applies to all. */
function attrArray(v: number | ArrayLike<number> | undefined, triangles: number, def: number): { arr: Int32Array | null; value: number } {
  if (v === undefined) return { arr: null, value: def };
  if (typeof v === 'number') return { arr: null, value: v | 0 };
  if (v instanceof Int32Array && v.length >= triangles) return { arr: v, value: def };
  const arr = new Int32Array(triangles);
  for (let i = 0; i < triangles; i++) arr[i] = i < v.length && v[i] !== undefined ? v[i] | 0 : def;
  return { arr, value: def };
}

/** Grows b (minx miny minz maxx maxy maxz) to the vertices of P. */
function vertexBounds(P: Float64Array, b: Float64Array): void {
  let x0 = b[0], y0 = b[1], z0 = b[2], x1 = b[3], y1 = b[4], z1 = b[5];
  for (let i = 0, e = P.length - 2; i < e; i += 3) {
    const x = P[i];
    const y = P[i + 1];
    const z = P[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  b[0] = x0;
  b[1] = y0;
  b[2] = z0;
  b[3] = x1;
  b[4] = y1;
  b[5] = z1;
}

/**
 * Pass 1 over one soup (input order): keeps the valid triangles (indices in range, finite, not degenerate)
 * and writes each one's soup / triangle number and 30-bit Morton code (of 3x its centroid, on the grid
 * g[0..2] = origin x3, g[3] = scale). Returns the new kept count.
 */
function keepTriangles(
  P: Float64Array, I: Uint32Array, si: number, n: number, g: Float64Array,
  keepSoup: Int32Array | null, keepTri: Int32Array, codes: Uint32Array,
): number {
  const nv = Math.floor(P.length / 3);
  const nt = Math.floor(I.length / 3);
  const minCross2 = TRI_MIN_CROSS * TRI_MIN_CROSS;
  const ox = g[0];
  const oy = g[1];
  const oz = g[2];
  const scale = g[3];
  for (let t = 0; t < nt; t++) {
    const ia = I[t * 3];
    const ib = I[t * 3 + 1];
    const ic = I[t * 3 + 2];
    if (!(ia < nv && ib < nv && ic < nv)) continue;
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
    if (keepSoup !== null) keepSoup[n] = si;
    keepTri[n] = t;
    n++;
  }
  return n;
}

/**
 * Pass 2 (slot = BVH leaf order): the triangle data records (vertices, unit normal, plane distance) and the
 * slot <-> triangle number maps.
 */
function fillTriangleData(
  order: Int32Array, n: number, keepSoup: Int32Array | null, keepTri: Int32Array,
  pos: Float64Array[], idx: Uint32Array[], soupBase: Int32Array,
  data: Float64Array, index: Int32Array, slotOf: Int32Array,
): void {
  for (let slot = 0; slot < n; slot++) {
    const k = order[slot];
    const si = keepSoup === null ? 0 : keepSoup[k];
    const t = keepTri[k];
    const P = pos[si];
    const I = idx[si];
    const num = soupBase[si] + t;
    index[slot] = num;
    slotOf[num] = slot;
    const a3 = I[t * 3] * 3;
    const b3 = I[t * 3 + 1] * 3;
    const c3 = I[t * 3 + 2] * 3;
    const ax = P[a3], ay = P[a3 + 1], az = P[a3 + 2];
    const bx = P[b3], by = P[b3 + 1], bz = P[b3 + 2];
    const cx = P[c3], cy = P[c3 + 1], cz = P[c3 + 2];
    const o = slot * TRI_STRIDE;
    data[o] = ax;
    data[o + 1] = ay;
    data[o + 2] = az;
    data[o + 3] = bx;
    data[o + 4] = by;
    data[o + 5] = bz;
    data[o + 6] = cx;
    data[o + 7] = cy;
    data[o + 8] = cz;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len;
    ny /= len;
    nz /= len;
    data[o + 9] = nx;
    data[o + 10] = ny;
    data[o + 11] = nz;
    data[o + 12] = (nx * (ax + bx + cx) + ny * (ay + by + cy) + nz * (az + bz + cz)) / 3;
  }
}

/** Pass 2 for one per-triangle attribute (contents, model) into `out` (slot order). */
function fillTriangleAttr(
  order: Int32Array, n: number, keepSoup: Int32Array | null, keepTri: Int32Array,
  attrs: { arr: Int32Array | null; value: number }[], out: Int32Array,
): void {
  if (n === 0) return;
  if (keepSoup === null && attrs[0].arr === null) {
    out.fill(attrs[0].value);
    return;
  }
  for (let slot = 0; slot < n; slot++) {
    const k = order[slot];
    const at = attrs[keepSoup === null ? 0 : keepSoup[k]];
    out[slot] = at.arr === null ? at.value : at.arr[keepTri[k]];
  }
}

/** The distinct values of a (each run of equal values counted once). */
function distinctRuns(a: Int32Array): Set<number> {
  const out = new Set<number>();
  let last = NaN;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== last) {
      last = a[i];
      out.add(last);
    }
  }
  return out;
}

/** BVH node bounds from the triangle vertices, bottom-up (children follow their parent in the layout). */
function triangleNodeBounds(nodeInfo: Int32Array, nodeCount: number, data: Float64Array): Float64Array {
  const nodeBounds = new Float64Array(Math.max(1, nodeCount) * 6);
  for (let node = nodeCount - 1; node >= 0; node--) {
    const a = nodeInfo[node * 2];
    const b = nodeInfo[node * 2 + 1];
    const o = node * 6;
    if (b > 0) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let slot = a; slot < a + b; slot++) {
        for (let v = slot * TRI_STRIDE, ve = v + 9; v < ve; v += 3) {
          const x = data[v];
          const y = data[v + 1];
          const z = data[v + 2];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
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
  return nodeBounds;
}

/**
 * Validates the triangles of all soups (bad indices, degenerate or non-finite triangles are dropped) and
 * lays them out in BVH leaf order (TRI_STRIDE records + attributes). The BVH is a Morton-order tree
 * (buildMortonTree) with node bounds from the triangle vertices. Edge bevels are not computed here: the
 * world computes them the first time a box reaches a triangle's bevel stage (most never are).
 */
function buildTriangleSet(soups: readonly TriangleSoup[]): TriangleSet {
  const pos = soups.map((s) => asF64(s.positions));
  const idx = soups.map((s) => asU32(s.indices));
  const soupBase = new Int32Array(soups.length);
  let total = 0;
  for (let si = 0; si < soups.length; si++) {
    soupBase[si] = total;
    total += Math.floor(idx[si].length / 3);
  }
  // cubic Morton cells over the vertex bounds of all soups; codes from 3x the centroid (no division)
  const vb = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (const P of pos) vertexBounds(P, vb);
  const ext = Math.max(vb[3] - vb[0], vb[4] - vb[1], vb[5] - vb[2]);
  const scale = ext > 0 && ext < Infinity ? 1023.999 / (3 * ext) : 0;
  const grid = new Float64Array([scale ? 3 * vb[0] : 0, scale ? 3 * vb[1] : 0, scale ? 3 * vb[2] : 0, scale]);

  const keepSoup = soups.length > 1 ? new Int32Array(total) : null;
  const keepTri = new Int32Array(total);
  const codes = new Uint32Array(total);
  let n = 0;
  for (let si = 0; si < soups.length; si++) n = keepTriangles(pos[si], idx[si], si, n, grid, keepSoup, keepTri, codes);
  const tree = buildMortonTree(codes, n, TRI_LEAF_MAX);

  const data = new Float64Array(n * TRI_STRIDE);
  const index = new Int32Array(n);
  const slotOf = new Int32Array(total).fill(-1);
  fillTriangleData(tree.order, n, keepSoup, keepTri, pos, idx, soupBase, data, index, slotOf);
  const contents = new Int32Array(n);
  const model = new Int32Array(n);
  const counts = idx.map((I) => Math.floor(I.length / 3));
  fillTriangleAttr(tree.order, n, keepSoup, keepTri, soups.map((s, i) => attrArray(s.contents, counts[i], CONTENTS_SOLID)), contents);
  fillTriangleAttr(tree.order, n, keepSoup, keepTri, soups.map((s, i) => attrArray(s.model, counts[i], 0)), model);
  const models = distinctRuns(model);
  const nodeBounds = triangleNodeBounds(tree.nodeInfo, tree.nodeCount, data);
  return { count: n, data, contents, model, index, slotOf, models, bvh: { ...tree, nodeBounds } };
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
function buildBvh(count: number, bmin: Float64Array, bmax: Float64Array): Bvh {
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
      if (bestSplit >= 0 && n <= LEAF_MAX && parentArea > 0 && 1 + bestCost / parentArea >= n) {
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
      if (n <= LEAF_MAX) {
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
  // LSD radix sort, 3 x 10 bits (codes is clobbered: the passes ping-pong between it and a second buffer)
  const vals = new Int32Array(count);
  for (let i = 0; i < count; i++) vals[i] = i;
  const keys2 = new Uint32Array(count);
  const vals2 = new Int32Array(count);
  const hist = new Int32Array(1024);
  radixPass(codes, vals, keys2, vals2, count, 0, hist);
  radixPass(keys2, vals2, codes, vals, count, 10, hist);
  radixPass(codes, vals, keys2, vals2, count, 20, hist);
  return mortonTopology(keys2, vals2, count, leafMax);
}

/** One stable counting-sort pass of (keys, vals) into (keys2, vals2) by the 10 key bits at `shift`. */
function radixPass(keys: Uint32Array, vals: Int32Array, keys2: Uint32Array, vals2: Int32Array, count: number, shift: number, hist: Int32Array): void {
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
}

/** The tree over Morton-sorted items (see buildMortonTree); `order` = item per sorted position. */
function mortonTopology(sorted: Uint32Array, order: Int32Array, count: number, leafMax: number): Omit<Bvh, 'nodeBounds'> {
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

// ------------------------------------------------------------------------------------- rigid transforms
// Moving brush models (func_door, func_rotating, trains...) are placed by an origin + Source Euler angles, like
// their entity places them (see bspcollision brushEntityPlacement). The helpers below are the shared math.

const DEG = Math.PI / 180;

/**
 * Row-major 3x3 rotation of Source Euler angles (degrees): its columns are the forward, left and up vectors
 * (AngleVectors), so world = M * local. Equals Rz(yaw) * Ry(pitch) * Rx(roll).
 */
export function anglesToMatrix(a: QAngle, out: Float64Array = new Float64Array(9)): Float64Array {
  const sp = Math.sin(a.pitch * DEG);
  const cp = Math.cos(a.pitch * DEG);
  const sy = Math.sin(a.yaw * DEG);
  const cy = Math.cos(a.yaw * DEG);
  const sr = Math.sin(a.roll * DEG);
  const cr = Math.cos(a.roll * DEG);
  // forward
  out[0] = cp * cy;
  out[3] = cp * sy;
  out[6] = -sp;
  // left (= -right)
  out[1] = sr * sp * cy - cr * sy;
  out[4] = sr * sp * sy + cr * cy;
  out[7] = sr * cp;
  // up
  out[2] = cr * sp * cy + sr * sy;
  out[5] = cr * sp * sy - sr * cy;
  out[8] = cr * cp;
  return out;
}

/** Source Euler angles (degrees) of a rotation matrix laid out like anglesToMatrix's (MatrixAngles). */
export function matrixToAngles(m: ArrayLike<number>, out: QAngle): QAngle {
  const fx = m[0];
  const fy = m[3];
  const fz = m[6];
  const xy = Math.sqrt(fx * fx + fy * fy);
  if (xy > 0.001) {
    out.yaw = Math.atan2(fy, fx) / DEG;
    out.pitch = Math.atan2(-fz, xy) / DEG;
    out.roll = Math.atan2(m[7], m[8]) / DEG; // left.z, up.z
  } else {
    // looking straight up/down: yaw from the left vector, no roll
    out.yaw = Math.atan2(-m[1], m[4]) / DEG;
    out.pitch = Math.atan2(-fz, xy) / DEG;
    out.roll = 0;
  }
  return out;
}

/** out = a * b (row-major 3x3). `out` may alias neither input. */
export function mulMatrix3(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): Float64Array {
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 3];
    const a1 = a[r * 3 + 1];
    const a2 = a[r * 3 + 2];
    out[r * 3] = a0 * b[0] + a1 * b[3] + a2 * b[6];
    out[r * 3 + 1] = a0 * b[1] + a1 * b[4] + a2 * b[7];
    out[r * 3 + 2] = a0 * b[2] + a1 * b[5] + a2 * b[8];
  }
  return out;
}

/** out = a * transpose(b) (row-major 3x3; for rotations: a * b^-1). `out` may alias neither input. */
export function mulMatrix3Transposed(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): Float64Array {
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 3];
    const a1 = a[r * 3 + 1];
    const a2 = a[r * 3 + 2];
    out[r * 3] = a0 * b[0] + a1 * b[1] + a2 * b[2];
    out[r * 3 + 1] = a0 * b[3] + a1 * b[4] + a2 * b[5];
    out[r * 3 + 2] = a0 * b[6] + a1 * b[7] + a2 * b[8];
  }
  return out;
}

/** True if the row-major 3x3 matrix is the identity within `eps`. */
export function isIdentityMatrix3(m: ArrayLike<number>, eps = 1e-12): boolean {
  return (
    Math.abs(m[0] - 1) <= eps && Math.abs(m[4] - 1) <= eps && Math.abs(m[8] - 1) <= eps &&
    Math.abs(m[1]) <= eps && Math.abs(m[2]) <= eps && Math.abs(m[3]) <= eps &&
    Math.abs(m[5]) <= eps && Math.abs(m[6]) <= eps && Math.abs(m[7]) <= eps
  );
}

/**
 * The rigid motion taking geometry built at placement (baseOrigin, baseRot) to placement (origin, rot):
 * p' = D * p + t with D = rot * baseRot^-1 and t = origin - D * baseOrigin. Writes D into `outD` and returns t
 * in `outT`; returns false when D is the identity (a pure translation).
 */
export function placementDelta(
  baseOrigin: Vec3,
  baseRot: ArrayLike<number>,
  origin: Vec3,
  rot: ArrayLike<number>,
  outD: Float64Array,
  outT: Vec3,
): boolean {
  mulMatrix3Transposed(rot, baseRot, outD);
  const ident = isIdentityMatrix3(outD);
  if (ident) {
    outT.x = origin.x - baseOrigin.x;
    outT.y = origin.y - baseOrigin.y;
    outT.z = origin.z - baseOrigin.z;
    return false;
  }
  outT.x = origin.x - (outD[0] * baseOrigin.x + outD[1] * baseOrigin.y + outD[2] * baseOrigin.z);
  outT.y = origin.y - (outD[3] * baseOrigin.x + outD[4] * baseOrigin.y + outD[5] * baseOrigin.z);
  outT.z = origin.z - (outD[6] * baseOrigin.x + outD[7] * baseOrigin.y + outD[8] * baseOrigin.z);
  return true;
}

const EDGE_PARALLEL = 1 - 1e-6;

/**
 * A convex brush that moves rigidly (a mover's brush). It keeps its base planes, vertices and edge directions
 * and re-derives the world-space planes, bevels and bounds for a rotation + translation of the base geometry:
 * - translations move every plane (the brush's own bevels stay exact);
 * - rotations rotate the real faces and rebuild the box-trace bevels: the six axial planes (the bounds) and
 *   the edge x axis planes at the rotated brush's support - the separating axes of a box and a convex
 *   polytope - so swept-box traces stay exact (no rounded-off or extended corners).
 * `planes` holds nx, ny, nz, dist per plane: the real faces first (`realCount`, used by point traces), then
 * the bevels (up to `count`). `brush` is a Brush view of the current planes (queries, trigger touch tests).
 */
export class RigidBrush {
  /** Static slot of the brush in its CollisionWorld (-1 for brushes outside one, e.g. triggers). */
  slot = -1;
  /** Enabled (the owning model is solid). */
  on = true;
  readonly contents: number;
  readonly model: number;
  readonly planes: Float64Array;
  count = 0;
  realCount = 0;
  /** Current bounds: minx, miny, minz, maxx, maxy, maxz. */
  readonly bounds = new Float64Array(6);
  private readonly baseReal: Float64Array;
  private readonly baseBevel: Float64Array;
  private readonly verts: Float64Array;
  private readonly edges: Float64Array;
  private readonly tv: Float64Array;
  private readonly baseBounds = new Float64Array(6);
  private readonly view: Brush;
  private readonly sidePool: BrushSide[] = [];
  private viewDirty = true;

  constructor(base: Brush) {
    this.contents = base.contents | 0;
    this.model = base.model | 0;
    const real: number[] = [];
    const bevel: number[] = [];
    for (const s of base.sides) {
      const n = s.plane.normal;
      (s.bevel ? bevel : real).push(n.x, n.y, n.z, s.plane.dist);
    }
    this.baseReal = Float64Array.from(real);
    this.baseBevel = Float64Array.from(bevel);
    // vertices and unique edge directions from the face windings (box corners when degenerate)
    const vs: number[] = [];
    const es: number[] = [];
    const addEdge = (dx: number, dy: number, dz: number): void => {
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(l > 1e-6)) return;
      dx /= l;
      dy /= l;
      dz /= l;
      for (let i = 0; i < es.length; i += 3) if (Math.abs(es[i] * dx + es[i + 1] * dy + es[i + 2] * dz) > EDGE_PARALLEL) return;
      es.push(dx, dy, dz);
    };
    for (const w of brushWindings(base)) {
      for (let i = 0; i < w.length; i++) {
        const a = w[i];
        const b = w[(i + 1) % w.length];
        vs.push(a.x, a.y, a.z);
        addEdge(b.x - a.x, b.y - a.y, b.z - a.z);
      }
    }
    const lo = base.mins;
    const hi = base.maxs;
    if (vs.length < 12) {
      vs.length = 0;
      es.length = 0;
      for (let i = 0; i < 8; i++) vs.push(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z);
      es.push(1, 0, 0, 0, 1, 0, 0, 0, 1);
    }
    this.verts = Float64Array.from(vs);
    this.edges = Float64Array.from(es);
    this.tv = new Float64Array(this.verts.length);
    const bb = this.baseBounds;
    bb[0] = lo.x;
    bb[1] = lo.y;
    bb[2] = lo.z;
    bb[3] = hi.x;
    bb[4] = hi.y;
    bb[5] = hi.z;
    const nr = this.baseReal.length / 4;
    const cap = nr + Math.max(this.baseBevel.length / 4, 6 + 6 * (this.edges.length / 3));
    this.planes = new Float64Array(cap * 4);
    this.view = { sides: [], contents: this.contents, mins: v3(), maxs: v3(), model: this.model };
    this.update(null, 0, 0, 0);
  }

  /**
   * Places the brush at p' = m * p + t of its base geometry; `m` null = no rotation (a pure translation).
   * `m` is row-major 3x3 (see placementDelta).
   */
  update(m: ArrayLike<number> | null, tx: number, ty: number, tz: number): void {
    const P = this.planes;
    const R = this.baseReal;
    const nr = R.length / 4;
    const B = this.bounds;
    this.viewDirty = true;
    if (!m) {
      for (let i = 0; i < R.length; i += 4) {
        P[i] = R[i];
        P[i + 1] = R[i + 1];
        P[i + 2] = R[i + 2];
        P[i + 3] = R[i + 3] + R[i] * tx + R[i + 1] * ty + R[i + 2] * tz;
      }
      const V = this.baseBevel;
      const o = R.length;
      for (let i = 0; i < V.length; i += 4) {
        P[o + i] = V[i];
        P[o + i + 1] = V[i + 1];
        P[o + i + 2] = V[i + 2];
        P[o + i + 3] = V[i + 3] + V[i] * tx + V[i + 1] * ty + V[i + 2] * tz;
      }
      this.realCount = nr;
      this.count = nr + V.length / 4;
      const bb = this.baseBounds;
      B[0] = bb[0] + tx;
      B[1] = bb[1] + ty;
      B[2] = bb[2] + tz;
      B[3] = bb[3] + tx;
      B[4] = bb[4] + ty;
      B[5] = bb[5] + tz;
      return;
    }
    // real faces: n' = m n, d' = d + n'.t
    for (let i = 0; i < R.length; i += 4) {
      const x = R[i];
      const y = R[i + 1];
      const z = R[i + 2];
      const nx = m[0] * x + m[1] * y + m[2] * z;
      const ny = m[3] * x + m[4] * y + m[5] * z;
      const nz = m[6] * x + m[7] * y + m[8] * z;
      P[i] = nx;
      P[i + 1] = ny;
      P[i + 2] = nz;
      P[i + 3] = R[i + 3] + nx * tx + ny * ty + nz * tz;
    }
    // vertices -> bounds
    const v = this.verts;
    const tv = this.tv;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i];
      const y = v[i + 1];
      const z = v[i + 2];
      const wx = m[0] * x + m[1] * y + m[2] * z + tx;
      const wy = m[3] * x + m[4] * y + m[5] * z + ty;
      const wz = m[6] * x + m[7] * y + m[8] * z + tz;
      tv[i] = wx;
      tv[i + 1] = wy;
      tv[i + 2] = wz;
      if (wx < x0) x0 = wx;
      if (wy < y0) y0 = wy;
      if (wz < z0) z0 = wz;
      if (wx > x1) x1 = wx;
      if (wy > y1) y1 = wy;
      if (wz > z1) z1 = wz;
    }
    B[0] = x0;
    B[1] = y0;
    B[2] = z0;
    B[3] = x1;
    B[4] = y1;
    B[5] = z1;
    let o = R.length;
    const axial = (nx: number, ny: number, nz: number, d: number): void => {
      P[o] = nx;
      P[o + 1] = ny;
      P[o + 2] = nz;
      P[o + 3] = d;
      o += 4;
    };
    axial(-1, 0, 0, -x0);
    axial(1, 0, 0, x1);
    axial(0, -1, 0, -y0);
    axial(0, 1, 0, y1);
    axial(0, 0, -1, -z0);
    axial(0, 0, 1, z1);
    // edge x axis bevels at the support of the rotated brush (both orientations)
    const e = this.edges;
    for (let i = 0; i < e.length; i += 3) {
      const ex = m[0] * e[i] + m[1] * e[i + 1] + m[2] * e[i + 2];
      const ey = m[3] * e[i] + m[4] * e[i + 1] + m[5] * e[i + 2];
      const ez = m[6] * e[i] + m[7] * e[i + 1] + m[8] * e[i + 2];
      for (let a = 0; a < 3; a++) {
        // n = e x axis
        let nx = a === 0 ? 0 : a === 1 ? -ez : ey;
        let ny = a === 0 ? ez : a === 1 ? 0 : -ex;
        let nz = a === 0 ? -ey : a === 1 ? ex : 0;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(l > 1e-6)) continue;
        nx /= l;
        ny /= l;
        nz /= l;
        if (Math.abs(nx) > AXIAL_LIMIT || Math.abs(ny) > AXIAL_LIMIT || Math.abs(nz) > AXIAL_LIMIT) continue;
        let hi = -Infinity;
        let lo = Infinity;
        for (let k = 0; k < tv.length; k += 3) {
          const d = nx * tv[k] + ny * tv[k + 1] + nz * tv[k + 2];
          if (d > hi) hi = d;
          if (d < lo) lo = d;
        }
        axial(nx, ny, nz, hi);
        axial(-nx, -ny, -nz, -lo);
      }
    }
    this.realCount = nr;
    this.count = o / 4;
  }

  /** The current planes as a Brush (bevel flags, bounds); the object is reused across updates. */
  get brush(): Brush {
    if (this.viewDirty) {
      this.viewDirty = false;
      const b = this.view;
      const P = this.planes;
      const pool = this.sidePool;
      b.sides.length = 0;
      for (let i = 0; i < this.count; i++) {
        let s = pool[i];
        if (!s) pool.push((s = { plane: { normal: v3(), dist: 0 }, bevel: false }));
        s.plane.normal.x = P[i * 4];
        s.plane.normal.y = P[i * 4 + 1];
        s.plane.normal.z = P[i * 4 + 2];
        s.plane.dist = P[i * 4 + 3];
        s.bevel = i >= this.realCount;
        b.sides.push(s);
      }
      const B = this.bounds;
      b.mins.x = B[0];
      b.mins.y = B[1];
      b.mins.z = B[2];
      b.maxs.x = B[3];
      b.maxs.y = B[4];
      b.maxs.z = B[5];
    }
    return this.view;
  }
}

/**
 * testBox's rule for one plane set (`n` planes nx, ny, nz, dist): true if the box (centre c, half extents e) is
 * inside or touching every plane pushed out by the box. `B` are the planes' bounds (broad phase).
 */
function boxInPlanes(P: Float64Array, n: number, B: Float64Array, cx: number, cy: number, cz: number, ex: number, ey: number, ez: number): boolean {
  if (
    cx < B[0] - ex - BROAD_MARGIN || cx > B[3] + ex + BROAD_MARGIN ||
    cy < B[1] - ey - BROAD_MARGIN || cy > B[4] + ey + BROAD_MARGIN ||
    cz < B[2] - ez - BROAD_MARGIN || cz > B[5] + ez + BROAD_MARGIN
  )
    return false;
  for (let i = 0; i < n; i++) {
    const p4 = i * 4;
    const nx = P[p4];
    const ny = P[p4 + 1];
    const nz = P[p4 + 2];
    const dist = P[p4 + 3] + (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
    if (nx * cx + ny * cy + nz * cz - dist > 0) return false;
  }
  return true;
}

/** A moving brush model: where its brushes were built and where they are now. */
interface DynamicModel {
  baseOrigin: Vec3;
  baseRot: Float64Array;
  origin: Vec3;
  angles: QAngle;
  placed: boolean;
  brushes: RigidBrush[];
}

const _dynRot = new Float64Array(9);
const _dynDelta = new Float64Array(9);
const _dynT = v3();

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
  // ---- moving models (setModelTransform): their brushes left the static BVH for this small list
  private readonly dynModels = new Map<number, DynamicModel>();
  private readonly dynBases = new Map<number, { origin: Vec3; rot: Float64Array }>();
  private readonly dynBrushes: RigidBrush[] = [];
  // ---- triangles (per triangle slot, in triangle-BVH leaf order)
  private readonly triCount: number;
  private readonly triData: Float64Array; // TRI_STRIDE per slot: vertices, unit normal, plane distance
  private readonly triContents: Int32Array;
  private readonly triActive: Int32Array; // contents, 0 while the triangle's model is disabled
  private readonly triModel: Int32Array;
  private readonly triIndex: Int32Array; // slot -> triangle number
  private readonly triSlotOf: Int32Array; // triangle number -> slot (-1 = dropped)
  private readonly triModels: Set<number>;
  // edge bevel planes, computed the first time a box gets that far (see addTriangleBevels)
  private readonly triBevelAt: Int32Array; // offset into triBevels, -1 = not computed yet
  private triBevels: Float64Array;
  private triBevelUsed = 0;
  private triBevelled = 0;
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
    this.triData = ts.data;
    this.triContents = ts.contents;
    this.triActive = ts.contents.slice();
    this.triModel = ts.model;
    this.triIndex = ts.index;
    this.triSlotOf = ts.slotOf;
    this.triModels = ts.models;
    this.triBevelAt = new Int32Array(ts.count).fill(-1);
    this.triBevels = new Float64Array(ts.count > 0 ? 4096 : 0);
    this.triNodeBounds = ts.bvh.nodeBounds;
    this.triNodeInfo = ts.bvh.nodeInfo;
    this.triNodeCount = ts.bvh.nodeCount;
    this.triDepth = ts.bvh.maxDepth;
    this.triStack = new Int32Array(ts.bvh.maxDepth * 2 + 8);
    const qs = Math.max(bvh.maxDepth, ts.bvh.maxDepth) * 2 + 8;
    if (this.queryStack.length < qs) this.queryStack = new Int32Array(qs);
  }

  /** BVH statistics (debugging / perf logging). */
  stats(): {
    brushes: number;
    sides: number;
    nodes: number;
    depth: number;
    triangles: number;
    triangleNodes: number;
    triangleDepth: number;
    /** Triangles whose edge bevels have been built so far (lazily, by box traces reaching them). */
    bevelledTriangles: number;
  } {
    return {
      brushes: this.slotCount,
      sides: this.sideBevel.length,
      nodes: this.nodeCount,
      depth: this.bvhDepth,
      triangles: this.triCount,
      triangleNodes: this.triNodeCount,
      triangleDepth: this.triDepth,
      bevelledTriangles: this.triBevelled,
    };
  }

  // ------------------------------------------------------------------------------------------- models

  /** func_brush style Enable/Disable: disabled models are ignored by every query. */
  setModelSolid(model: number, solid: boolean): void {
    if (solid) this.disabledModels.delete(model);
    else this.disabledModels.add(model);
    const dm = this.dynModels.get(model);
    if (dm) for (const rb of dm.brushes) rb.on = solid;
    const slots = dm ? undefined : this.modelSlots.get(model);
    if (slots) for (const slot of slots) this.slotEnabled[slot] = solid ? 1 : 0;
    if (this.triModels.has(model)) {
      const m = this.triModel;
      const active = this.triActive;
      const contents = this.triContents;
      for (let slot = 0; slot < this.triCount; slot++) if (m[slot] === model) active[slot] = solid ? contents[slot] : 0;
    }
  }

  isModelSolid(model: number): boolean {
    return !this.disabledModels.has(model);
  }

  /**
   * Declares the placement (origin + Source angles) the brushes of `model` were built at, which
   * setModelTransform is relative to. Default: origin 0, angles 0 (brushes in model space). loadBspMap builds
   * brush entities at their entity's placement (bspcollision brushEntityPlacement), so movers call this once
   * with that placement before moving them.
   */
  setModelBasePlacement(model: number, origin: Vec3, angles: QAngle): void {
    const base = { origin: v3(origin.x, origin.y, origin.z), rot: anglesToMatrix(angles) };
    this.dynBases.set(model, base);
    const dm = this.dynModels.get(model);
    if (dm) {
      dm.baseOrigin = base.origin;
      dm.baseRot = base.rot;
      if (dm.placed) {
        dm.placed = false;
        this.setModelTransform(model, v3(dm.origin.x, dm.origin.y, dm.origin.z), { ...dm.angles });
      }
    }
  }

  /**
   * Moves brush model `model` to the placement (origin, angles) - its entity's absolute origin and angles -
   * relative to its base placement (setModelBasePlacement). The model's brushes leave the static BVH for a
   * small list of moving brushes (on the first call) whose world-space planes, bevels and bounds are
   * re-derived here; every query (traceBox/traceRay, testBox, pointContents, queryBox, setModelSolid) honours
   * the new placement. Cheap for translations; rotations rebuild the box-trace bevels of each brush.
   */
  setModelTransform(model: number, origin: Vec3, angles: QAngle): void {
    const dm = this.dynamicModel(model);
    if (
      dm.placed &&
      dm.origin.x === origin.x && dm.origin.y === origin.y && dm.origin.z === origin.z &&
      dm.angles.pitch === angles.pitch && dm.angles.yaw === angles.yaw && dm.angles.roll === angles.roll
    )
      return;
    dm.placed = true;
    dm.origin.x = origin.x;
    dm.origin.y = origin.y;
    dm.origin.z = origin.z;
    dm.angles.pitch = angles.pitch;
    dm.angles.yaw = angles.yaw;
    dm.angles.roll = angles.roll;
    anglesToMatrix(angles, _dynRot);
    const rotated = placementDelta(dm.baseOrigin, dm.baseRot, origin, _dynRot, _dynDelta, _dynT);
    const m = rotated ? _dynDelta : null;
    for (const rb of dm.brushes) rb.update(m, _dynT.x, _dynT.y, _dynT.z);
  }

  /** The placement last given to setModelTransform (null for a model that never moved). */
  getModelTransform(model: number): { origin: Vec3; angles: QAngle } | null {
    const dm = this.dynModels.get(model);
    return dm && dm.placed ? { origin: v3(dm.origin.x, dm.origin.y, dm.origin.z), angles: { ...dm.angles } } : null;
  }

  /** True once setModelTransform moved `model` out of the static BVH. */
  isModelDynamic(model: number): boolean {
    return this.dynModels.has(model);
  }

  /**
   * True if the box [origin+mins, origin+maxs] is in solid against the enabled brushes of `model` only
   * (moving or static), with testBox's rules. Used by pushers to find what they move into.
   */
  testModelBox(model: number, origin: Vec3, mins: Vec3, maxs: Vec3, mask: number): boolean {
    if (this.disabledModels.has(model)) return false;
    const cx = origin.x + (mins.x + maxs.x) * 0.5;
    const cy = origin.y + (mins.y + maxs.y) * 0.5;
    const cz = origin.z + (mins.z + maxs.z) * 0.5;
    let ex = Math.abs(maxs.x - mins.x) * 0.5;
    let ey = Math.abs(maxs.y - mins.y) * 0.5;
    let ez = Math.abs(maxs.z - mins.z) * 0.5;
    const isPoint = ex * ex + ey * ey + ez * ez < POINT_EXTENT_SQ;
    if (isPoint) ex = ey = ez = 0;
    const dm = this.dynModels.get(model);
    if (dm) {
      for (const rb of dm.brushes) if ((rb.contents & mask) !== 0 && boxInPlanes(rb.planes, isPoint ? rb.realCount : rb.count, rb.bounds, cx, cy, cz, ex, ey, ez)) return true;
      return false;
    }
    const slots = this.modelSlots.get(model);
    if (!slots) return false;
    for (const slot of slots) {
      if ((this.slotContents[slot] & mask) === 0 || this.slotEnabled[slot] === 0) continue;
      const so = slot * 6;
      const b = this.slotBounds;
      if (
        cx < b[so] - ex - BROAD_MARGIN || cx > b[so + 3] + ex + BROAD_MARGIN ||
        cy < b[so + 1] - ey - BROAD_MARGIN || cy > b[so + 4] + ey + BROAD_MARGIN ||
        cz < b[so + 2] - ez - BROAD_MARGIN || cz > b[so + 5] + ez + BROAD_MARGIN
      )
        continue;
      let inside = true;
      for (let s = this.slotSideStart[slot], se = this.slotSideStart[slot + 1]; s < se; s++) {
        if (isPoint && this.sideBevel[s] !== 0) continue;
        const p4 = s * 4;
        const nx = this.planes[p4];
        const ny = this.planes[p4 + 1];
        const nz = this.planes[p4 + 2];
        const dist = this.planes[p4 + 3] + (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
        if (nx * cx + ny * cy + nz * cz - dist > 0) {
          inside = false;
          break;
        }
      }
      if (inside) return true;
    }
    return false;
  }

  /** Moving-model record for `model`, created (brushes moved out of the static BVH) on first use. */
  private dynamicModel(model: number): DynamicModel {
    let dm = this.dynModels.get(model);
    if (dm) return dm;
    const base = this.dynBases.get(model);
    dm = {
      baseOrigin: base ? base.origin : v3(),
      baseRot: base ? base.rot : anglesToMatrix({ pitch: 0, yaw: 0, roll: 0 }),
      origin: v3(),
      angles: { pitch: 0, yaw: 0, roll: 0 },
      placed: false,
      brushes: [],
    };
    const solid = !this.disabledModels.has(model);
    for (const slot of this.modelSlots.get(model) ?? []) {
      const rb = new RigidBrush(this.brushes[this.slotBrush[slot]]);
      rb.slot = slot;
      rb.on = solid;
      this.slotEnabled[slot] = 0; // the static pass never sees it again
      dm.brushes.push(rb);
      this.dynBrushes.push(rb);
    }
    this.dynModels.set(model, dm);
    return dm;
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

    const slotModel = this.slotModel;

    let best = 1;
    // for a hit at fraction 0: the real (not pulled back) crossing of the face it reports (see below); Infinity
    // for a prop hull, which every brush or triangle hit at 0 replaces
    let bestIn = -1;
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

        let enterfrac = NEVER_UPDATED;
        let leavefrac = 1;
        let startout = false;
        let getout = false;
        let lead = -1;
        // of the entering faces whose epsilon shell the box starts in: the one it really crosses last (and when)
        let inT = -1;
        let inLead = -1;
        let missed = false;
        // a static-prop hull: Quake 3's touch rule (see the file comment)
        const prop = slotModel[slot] === PROP_HULL_MODEL;
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
            // in front of this face at both ends of the move: no contact with this brush (Source; see the
            // file comment - ending within DIST_EPSILON of the face doesn't count). A prop hull is touched by a
            // move into the face that ends within DIST_EPSILON of it (Quake 3).
            if (d2 > 0 && (!prop || d2 >= DIST_EPSILON - CLIP_NOISE || d2 >= d1)) {
              missed = true;
              break;
            }
          } else if (d2 <= 0) {
            continue; // behind this face for the whole move
          }
          if (d1 > d2) {
            // entering; like Source, a pulled-back crossing behind the start (the box starts inside this face's
            // epsilon shell) counts as 0 (not for a prop hull: the latest pulled-back crossing leads, Quake 3)
            let f = (d1 - DIST_EPSILON) / (d1 - d2);
            if (f <= 0 && !prop) {
              f = 0;
              const t = d1 / (d1 - d2);
              if (t > inT) {
                inT = t;
                inLead = s;
              }
            }
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
        // A hit at 0 - every face the move enters has its pulled-back crossing behind the start - is where Source
        // leaves it to chance: all those fractions clamp to 0, so the first such side in the brush's list leads
        // and the first such brush in the BSP walk is the hit. Here the contact is the face the box really
        // crosses last (where it would really enter the brush: a ramp's next brush's top, not the end face or edge
        // bevel whose shell it also starts in, which would stop it dead), and of brushes hit at 0 the one entered
        // first. Fractions above 0 are Source's.
        if (enterfrac < leavefrac && enterfrac > NEVER_UPDATED) {
          if (prop) {
            // Quake 3: the fraction clamps to 0 only here, so a hull entered "before the start" replaces another
            // hull hit at 0 - but not a brush (see the file comment)
            if (enterfrac < best && (best > 0 || bestIn === Infinity)) {
              best = enterfrac < 0 ? 0 : enterfrac;
              bestIn = Infinity;
              hitSlot = slot;
              hitSide = lead;
            }
          } else if (enterfrac < best) {
            best = enterfrac;
            bestIn = enterfrac === 0 ? inT : -1;
            hitSlot = slot;
            hitSide = enterfrac === 0 ? inLead : lead;
          } else if (enterfrac === 0 && best === 0 && inT < bestIn) {
            bestIn = inT;
            hitSlot = slot;
            hitSide = inLead;
          }
        }
      }
    }

    // ---- moving brushes (setModelTransform): the same clipping, on their current planes
    let hitPlanes = planes;
    const dyn = this.dynBrushes;
    if (!allsolid && dyn.length > 0) {
      dynLoop: for (let di = 0; di < dyn.length; di++) {
        const rb = dyn[di];
        if (!rb.on || (rb.contents & mask) === 0) continue;
        {
          const o = rb.bounds;
          let tmin = 0;
          let tmax = best;
          let t1 = (o[0] - bx - sx) * ix;
          let t2 = (o[3] + bx - sx) * ix;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dx === 0 && (sx < o[0] - bx || sx > o[3] + bx)) continue;
          t1 = (o[1] - by - sy) * iy;
          t2 = (o[4] + by - sy) * iy;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dy === 0 && (sy < o[1] - by || sy > o[4] + by)) continue;
          t1 = (o[2] - bz - sz) * iz;
          t2 = (o[5] + bz - sz) * iz;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dz === 0 && (sz < o[2] - bz || sz > o[5] + bz)) continue;
          if (tmin > tmax) continue;
        }
        const P = rb.planes;
        const np = isPoint ? rb.realCount : rb.count;
        let enterfrac = NEVER_UPDATED;
        let leavefrac = 1;
        let startout = false;
        let getout = false;
        let lead = -1;
        let inT = -1;
        let inLead = -1;
        let missed = false;
        for (let s = 0; s < np; s++) {
          const p4 = s * 4;
          const nx = P[p4];
          const ny = P[p4 + 1];
          const nz = P[p4 + 2];
          const dist = P[p4 + 3] + (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
          const d1 = nx * sx + ny * sy + nz * sz - dist;
          const d2 = nx * tx + ny * ty + nz * tz - dist;
          if (d2 > 0) getout = true;
          if (d1 > 0) {
            startout = true;
            if (d2 > 0) {
              missed = true;
              break;
            }
          } else if (d2 <= 0) {
            continue;
          }
          if (d1 > d2) {
            let f = (d1 - DIST_EPSILON) / (d1 - d2);
            if (f <= 0) {
              f = 0;
              const t = d1 / (d1 - d2);
              if (t > inT) {
                inT = t;
                inLead = s;
              }
            }
            if (f > enterfrac) {
              enterfrac = f;
              lead = s;
            }
          } else {
            const f = (d1 + DIST_EPSILON) / (d1 - d2);
            if (f < leavefrac) leavefrac = f;
          }
        }
        if (missed) continue;
        if (!startout) {
          startsolid = true;
          if (solidSlot < 0) solidSlot = rb.slot;
          if (!getout) {
            allsolid = true;
            solidSlot = rb.slot;
            break dynLoop;
          }
          continue;
        }
        if (enterfrac < leavefrac && enterfrac > NEVER_UPDATED) {
          if (enterfrac < best || (enterfrac === 0 && best === 0 && inT < bestIn)) {
            bestIn = enterfrac === 0 ? inT : -1;
            best = enterfrac;
            hitSlot = rb.slot;
            hitSide = enterfrac === 0 ? inLead : lead;
            hitPlanes = P;
          }
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
      const tActive = this.triActive;
      const tData = this.triData;
      const tBevelAt = this.triBevelAt;
      let tBevels = this.triBevels;
      const tStack = this.triStack;
      KS[0] = sx;
      KS[1] = sy;
      KS[2] = sz;
      KS[3] = tx;
      KS[4] = ty;
      KS[5] = tz;
      KS[12] = best;
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
          if ((tActive[slot] & mask) === 0) continue;
          // (leaves are small and tight: the triangle's own planes do the culling)
          if (isPoint) {
            if (!clipTriangleRay(tData, slot)) continue;
          } else {
            if (!clipTriangleHull(tData, slot, ex, ey, ez)) continue;
            let off = tBevelAt[slot];
            if (off < 0) {
              off = this.addTriangleBevels(slot);
              tBevels = this.triBevels;
            }
            if (!clipBevelPlanes(tBevels, off, ex, ey, ez)) continue;
          }
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
          if (KS[6] < KS[7] && KS[6] > NEVER_UPDATED && (KS[6] < best || (KS[6] === 0 && best === 0 && KS[13] < bestIn))) {
            best = KS[6];
            KS[12] = best;
            hitSlot = -1;
            hitTri = slot;
            if (KS[6] === 0 && !isPoint) {
              bestIn = KS[13];
              hnx = KS[14];
              hny = KS[15];
              hnz = KS[16];
              hd = KS[17];
            } else {
              bestIn = KS[6] === 0 ? KS[13] : -1;
              hnx = KS[8];
              hny = KS[9];
              hnz = KS[10];
              hd = KS[11];
            }
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
      pn.x = hitPlanes[p4];
      pn.y = hitPlanes[p4 + 1];
      pn.z = hitPlanes[p4 + 2];
      tr.plane.dist = hitPlanes[p4 + 3];
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
    const dyn = this.dynBrushes;
    for (let di = 0; di < dyn.length; di++) {
      const rb = dyn[di];
      const c = rb.contents;
      if (!rb.on || (c & mask) === 0 || (result & c) === c) continue;
      const B = rb.bounds;
      if (px < B[0] || px > B[3] || py < B[1] || py > B[4] || pz < B[2] || pz > B[5]) continue;
      const P = rb.planes;
      let inside = true;
      for (let s = 0; s < rb.realCount; s++) {
        if (P[s * 4] * px + P[s * 4 + 1] * py + P[s * 4 + 2] * pz - P[s * 4 + 3] >= 0) {
          inside = false;
          break;
        }
      }
      if (inside) result |= c;
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
    const dyn = this.dynBrushes;
    for (let di = 0; di < dyn.length; di++) {
      const rb = dyn[di];
      if (!rb.on || (rb.contents & mask) === 0) continue;
      if (boxInPlanes(rb.planes, isPoint ? rb.realCount : rb.count, rb.bounds, cx, cy, cz, ex, ey, ez)) return true;
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
    const active = this.triActive;
    const data = this.triData;
    // a zero-length sweep: the triangle hull contains the box iff no plane separates them
    KS[12] = 1;
    KS[0] = cx;
    KS[1] = cy;
    KS[2] = cz;
    KS[3] = cx;
    KS[4] = cy;
    KS[5] = cz;
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
        if ((active[slot] & mask) === 0) continue;
        if (isPoint) {
          if (clipTriangleRay(data, slot)) return true;
          continue;
        }
        if (!clipTriangleHull(data, slot, ex, ey, ez)) continue;
        let off = this.triBevelAt[slot];
        if (off < 0) off = this.addTriangleBevels(slot);
        if (clipBevelPlanes(this.triBevels, off, ex, ey, ez)) return true;
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
      // moving brushes: their current placement (a Brush view of the live planes)
      const dyn = this.dynBrushes;
      for (let di = 0; di < dyn.length; di++) {
        const rb = dyn[di];
        if (!rb.on) continue;
        const B = rb.bounds;
        if (x1 < B[0] || x0 > B[3] || y1 < B[1] || y0 > B[4] || z1 < B[2] || z0 > B[5]) continue;
        cb(rb.brush);
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
    const T = this.triData;
    const disabled = this.disabledModels;
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
        if (disabled.size > 0 && disabled.has(this.triModel[slot])) continue;
        const v = slot * TRI_STRIDE;
        if (
          x1 < Math.min(T[v], T[v + 3], T[v + 6]) || x0 > Math.max(T[v], T[v + 3], T[v + 6]) ||
          y1 < Math.min(T[v + 1], T[v + 4], T[v + 7]) || y0 > Math.max(T[v + 1], T[v + 4], T[v + 7]) ||
          z1 < Math.min(T[v + 2], T[v + 5], T[v + 8]) || z0 > Math.max(T[v + 2], T[v + 5], T[v + 8])
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
    const T = this.triData;
    const o = slot * TRI_STRIDE;
    return {
      verts: T.slice(o, o + 9),
      normal: v3(T[o + 9], T[o + 10], T[o + 11]),
      dist: T[o + 12],
      contents: this.triContents[slot],
      model: this.triModel[slot],
    };
  }

  /**
   * Triangle `tri` as a zero-volume Brush (both faces, edge walls, axial and edge bevels - the planes its
   * box traces use; bounds = the triangle's), for code that works on brushes (boxIntersectsBrush, debug
   * drawing). Null if dropped.
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
    // edge x axis bevels (the trace's)
    const B = new Float64Array(TRI_BEVELS_MAX);
    triangleBevels(this.triData, this.triSlotOf[tri], B, 0);
    for (let i = 0, o = 1; i < B[0]; i++, o += 4) {
      sides.push({ plane: { normal: v3(B[o], B[o + 1], B[o + 2]), dist: B[o + 3] }, bevel: true });
    }
    return { sides, contents: t.contents, mins, maxs, model: t.model };
  }

  /**
   * Computes the edge bevel planes of triangle slot `slot` into triBevels (growing it) and returns their
   * offset. Called the first time a box trace reaches that triangle's bevel stage; most triangles never are.
   */
  private addTriangleBevels(slot: number): number {
    let B = this.triBevels;
    const at = this.triBevelUsed;
    if (at + TRI_BEVELS_MAX > B.length) {
      const grown = new Float64Array(Math.max(4096, B.length * 2));
      grown.set(B.subarray(0, at));
      this.triBevels = B = grown;
    }
    this.triBevelUsed = at + triangleBevels(this.triData, slot, B, at);
    this.triBevelAt[slot] = at;
    this.triBevelled++;
    return at;
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
