// Convex brush construction: face windings, tight bounds, q3map/qbsp-style bevel planes, and brushes
// built from plane sets, axial boxes or point clouds (convex hull).
//
// A brush is the intersection of the half-spaces { p : dot(p, n) <= dist } of its sides. "Bevel" sides
// are extra supporting planes (they never cut into the brush) that make the plane set describe the
// Minkowski sum of the brush and an axis-aligned box exactly once each plane is pushed out by the box
// extents - this is what keeps box traces from snagging on invisible corners past brush edges.
//
// Written from the public descriptions of the Quake/Source brush-bevel and winding-clipping algorithms.
// All math is float64.
import { Vec3, v3 } from '../core/vec3';
import { Brush, BrushSide, Plane } from './types';

/** Half-size of the square initially laid on every brush plane before clipping. */
const WINDING_EXTENT = 262144;
/** A winding point beyond this coordinate is the remnant of an open (unbounded) plane set. */
const BOGUS_RANGE = 65536;
/** Point-vs-plane classification epsilon used while clipping windings. */
const CLIP_EPSILON = 0.01;
/** Normals closer than this (per component) are considered identical. */
const NORMAL_EPSILON = 1e-5;
/** Plane distances closer than this are considered identical (with identical normals). */
const DIST_EQUAL_EPSILON = 0.01;
/** Normals within this of an axis are treated as exactly axial. */
const AXIAL_EPSILON = 1e-9;
/** Edge bevels: ignore winding edges shorter than this. */
const BEVEL_MIN_EDGE = 0.01;
/** Edge bevels: ignore edges this close to parallel with the axis (|cross| = sin(angle)). */
const BEVEL_MIN_CROSS = 1e-3;
/** Edge bevels: the edge must lie within this distance of the supporting plane. */
const BEVEL_ON_EPSILON = 0.01;
/** Convex hull: points within this distance of a candidate face plane count as on it. */
const HULL_EPSILON = 0.01;
/** Convex hull: input points closer than this are merged. */
const HULL_MERGE_EPSILON = 1e-4;

/** Flat xyz triples. */
type FlatWinding = number[];

// ---------------------------------------------------------------------------------------------- windings

/** A huge square on the plane, counter-clockwise when viewed from the front (normal toward viewer). */
function baseWinding(nx: number, ny: number, nz: number, dist: number): FlatWinding {
  const len2 = nx * nx + ny * ny + nz * nz;
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  // "up" reference: world Z unless the plane is mostly horizontal, then world X.
  let ux = 0;
  let uz = 0;
  if (az >= ax && az >= ay) ux = 1;
  else uz = 1;
  const proj = (ux * nx + uz * nz) / len2;
  let vx = ux - nx * proj;
  let vy = -ny * proj;
  let vz = uz - nz * proj;
  const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
  vx /= vl;
  vy /= vl;
  vz /= vl;
  const invn = 1 / Math.sqrt(len2);
  // r = v x n̂, so (r, v, n̂) is right-handed and r x v = n̂.
  let rx = (vy * nz - vz * ny) * invn;
  let ry = (vz * nx - vx * nz) * invn;
  let rz = (vx * ny - vy * nx) * invn;
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  rx /= rl;
  ry /= rl;
  rz /= rl;
  const s = dist / len2;
  const ox = nx * s;
  const oy = ny * s;
  const oz = nz * s;
  const E = WINDING_EXTENT;
  rx *= E;
  ry *= E;
  rz *= E;
  vx *= E;
  vy *= E;
  vz *= E;
  return [
    ox - rx - vx, oy - ry - vy, oz - rz - vz,
    ox + rx - vx, oy + ry - vy, oz + rz - vz,
    ox + rx + vx, oy + ry + vy, oz + rz + vz,
    ox - rx + vx, oy - ry + vy, oz - rz + vz,
  ];
}

const clipDists: number[] = [];
const clipSides: number[] = [];

/**
 * Keeps the part of the winding behind the plane (dot(p, n) - dist <= eps). Returns the input when
 * nothing is in front, null when nothing remains behind.
 */
function clipWinding(w: FlatWinding, nx: number, ny: number, nz: number, dist: number, eps: number): FlatWinding | null {
  const np = w.length / 3;
  let front = 0;
  let back = 0;
  for (let i = 0; i < np; i++) {
    const d = w[i * 3] * nx + w[i * 3 + 1] * ny + w[i * 3 + 2] * nz - dist;
    clipDists[i] = d;
    if (d > eps) {
      clipSides[i] = 1;
      front++;
    } else if (d < -eps) {
      clipSides[i] = -1;
      back++;
    } else {
      clipSides[i] = 0;
    }
  }
  if (front === 0) return w;
  if (back === 0) return null;
  const out: FlatWinding = [];
  for (let i = 0; i < np; i++) {
    const s1 = clipSides[i];
    const i3 = i * 3;
    if (s1 <= 0) out.push(w[i3], w[i3 + 1], w[i3 + 2]);
    if (s1 === 0) continue;
    const j = i + 1 === np ? 0 : i + 1;
    const s2 = clipSides[j];
    if (s2 === 0 || s2 === s1) continue;
    // The edge crosses the plane: emit the intersection point.
    const d1 = clipDists[i];
    const t = d1 / (d1 - clipDists[j]);
    const j3 = j * 3;
    const mx = nx === 1 ? dist : nx === -1 ? -dist : w[i3] + t * (w[j3] - w[i3]);
    const my = ny === 1 ? dist : ny === -1 ? -dist : w[i3 + 1] + t * (w[j3 + 1] - w[i3 + 1]);
    const mz = nz === 1 ? dist : nz === -1 ? -dist : w[i3 + 2] + t * (w[j3 + 2] - w[i3 + 2]);
    out.push(mx, my, mz);
  }
  return out.length >= 9 ? out : null;
}

/** Removes consecutive duplicate points; returns null for degenerate (point/line/sliver) windings. */
function cleanWinding(w: FlatWinding): FlatWinding | null {
  const out: FlatWinding = [];
  const np = w.length / 3;
  for (let i = 0; i < np; i++) {
    const x = w[i * 3];
    const y = w[i * 3 + 1];
    const z = w[i * 3 + 2];
    const n = out.length;
    if (n >= 3) {
      const dx = x - out[n - 3];
      const dy = y - out[n - 2];
      const dz = z - out[n - 1];
      if (dx * dx + dy * dy + dz * dz < 1e-12) continue;
    }
    out.push(x, y, z);
  }
  // wrap-around duplicate
  while (out.length >= 6) {
    const n = out.length;
    const dx = out[0] - out[n - 3];
    const dy = out[1] - out[n - 2];
    const dz = out[2] - out[n - 1];
    if (dx * dx + dy * dy + dz * dz < 1e-12) out.length = n - 3;
    else break;
  }
  if (out.length < 9) return null;
  // Newell normal magnitude = 2 * area
  let ax = 0;
  let ay = 0;
  let az = 0;
  const m = out.length / 3;
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1;
    const x0 = out[i * 3];
    const y0 = out[i * 3 + 1];
    const z0 = out[i * 3 + 2];
    const x1 = out[j * 3];
    const y1 = out[j * 3 + 1];
    const z1 = out[j * 3 + 2];
    ax += (y0 - y1) * (z0 + z1);
    ay += (z0 - z1) * (x0 + x1);
    az += (x0 - x1) * (y0 + y1);
  }
  const area2 = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(area2 > 2e-6)) return null;
  return out;
}

function planesEqual(a: Plane, b: Plane): boolean {
  return (
    Math.abs(a.normal.x - b.normal.x) < NORMAL_EPSILON &&
    Math.abs(a.normal.y - b.normal.y) < NORMAL_EPSILON &&
    Math.abs(a.normal.z - b.normal.z) < NORMAL_EPSILON &&
    Math.abs(a.dist - b.dist) < DIST_EQUAL_EPSILON
  );
}

/** Flat windings for every side (null for bevels, duplicates and sides that don't touch the volume). */
function computeWindingsFlat(sides: readonly BrushSide[]): (FlatWinding | null)[] {
  const out: (FlatWinding | null)[] = new Array(sides.length);
  for (let i = 0; i < sides.length; i++) {
    const si = sides[i];
    if (si.bevel) {
      out[i] = null;
      continue;
    }
    const pn = si.plane.normal;
    let w: FlatWinding | null = baseWinding(pn.x, pn.y, pn.z, si.plane.dist);
    for (let j = 0; j < sides.length && w; j++) {
      if (j === i) continue;
      const sj = sides[j];
      if (sj.bevel) continue;
      if (planesEqual(sj.plane, si.plane)) {
        // Duplicate side: the first occurrence owns the face.
        if (j < i) w = null;
        continue;
      }
      const n = sj.plane.normal;
      w = clipWinding(w, n.x, n.y, n.z, sj.plane.dist, CLIP_EPSILON);
    }
    out[i] = w ? cleanWinding(w) : null;
  }
  return out;
}

interface Bounds {
  mins: Vec3;
  maxs: Vec3;
}

function boundsOfWindings(ws: readonly (FlatWinding | null)[]): Bounds | null {
  let minx = Infinity;
  let miny = Infinity;
  let minz = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  let maxz = -Infinity;
  let faces = 0;
  for (const w of ws) {
    if (!w) continue;
    faces++;
    for (let i = 0; i < w.length; i += 3) {
      const x = w[i];
      const y = w[i + 1];
      const z = w[i + 2];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (z < minz) minz = z;
      if (z > maxz) maxz = z;
    }
  }
  if (faces < 4) return null;
  if (!(Number.isFinite(minx) && Number.isFinite(miny) && Number.isFinite(minz))) return null;
  if (!(Number.isFinite(maxx) && Number.isFinite(maxy) && Number.isFinite(maxz))) return null;
  if (minx < -BOGUS_RANGE || miny < -BOGUS_RANGE || minz < -BOGUS_RANGE) return null;
  if (maxx > BOGUS_RANGE || maxy > BOGUS_RANGE || maxz > BOGUS_RANGE) return null;
  if (!(maxx - minx > 1e-6 && maxy - miny > 1e-6 && maxz - minz > 1e-6)) return null;
  // (+ 0 turns -0 into 0)
  return { mins: v3(minx + 0, miny + 0, minz + 0), maxs: v3(maxx + 0, maxy + 0, maxz + 0) };
}

/**
 * Windings (face polygons) of every side: windings[i] belongs to sides[i]. Bevel sides, duplicate
 * sides and sides that do not touch the brush volume get []. Vertices are counter-clockwise when
 * viewed from outside the brush (side normal pointing at the viewer).
 */
export function brushWindings(brush: Brush): Vec3[][] {
  const flat = computeWindingsFlat(brush.sides);
  const out: Vec3[][] = new Array(flat.length);
  for (let i = 0; i < flat.length; i++) {
    const w = flat[i];
    const pts: Vec3[] = [];
    if (w) for (let k = 0; k < w.length; k += 3) pts.push(v3(w[k] + 0, w[k + 1] + 0, w[k + 2] + 0));
    out[i] = pts;
  }
  return out;
}

/** Sets brush.mins/maxs to the AABB of its windings. Returns false (bounds untouched) if degenerate. */
export function computeBrushBounds(brush: Brush): boolean {
  const b = boundsOfWindings(computeWindingsFlat(brush.sides));
  if (!b) return false;
  brush.mins = b.mins;
  brush.maxs = b.maxs;
  return true;
}

// ---------------------------------------------------------------------------------------------- bevels

function axisComponent(n: Vec3, axis: number): number {
  return axis === 0 ? n.x : axis === 1 ? n.y : n.z;
}

function isExactlyAxial(n: Vec3, axis: number, dir: number): boolean {
  for (let k = 0; k < 3; k++) {
    const c = axisComponent(n, k);
    if (k === axis) {
      if (Math.abs(c - dir) > AXIAL_EPSILON) return false;
    } else if (Math.abs(c) > AXIAL_EPSILON) {
      return false;
    }
  }
  return true;
}

function bevelsInternal(brush: Brush, ws: readonly (FlatWinding | null)[], b: Bounds): void {
  const sides = brush.sides;
  // ---- (a) axial planes first, in -x +x -y +y -z +z order (like qbsp/vbsp output)
  const used = new Uint8Array(sides.length);
  const ordered: BrushSide[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let dir = -1; dir <= 1; dir += 2) {
      const extent = dir < 0 ? -axisComponent(b.mins, axis) : axisComponent(b.maxs, axis);
      let found = -1;
      let foundErr = Infinity;
      for (let i = 0; i < sides.length; i++) {
        if (used[i]) continue;
        const p = sides[i].plane;
        if (!isExactlyAxial(p.normal, axis, dir)) continue;
        const err = Math.abs(p.dist - extent);
        if (err <= DIST_EQUAL_EPSILON && err < foundErr) {
          found = i;
          foundErr = err;
        }
      }
      if (found >= 0) {
        used[found] = 1;
        ordered.push(sides[found]);
      } else {
        const n = v3(axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0);
        ordered.push({ plane: { normal: n, dist: extent }, bevel: true });
      }
    }
  }
  for (let i = 0; i < sides.length; i++) if (!used[i]) ordered.push(sides[i]);

  // ---- (b) edge bevels: planes through a brush edge, parallel to a world axis, supporting the brush
  const verts: number[] = [];
  for (const w of ws) if (w) for (let k = 0; k < w.length; k++) verts.push(w[k]);
  const nv = verts.length / 3;
  for (const w of ws) {
    if (!w) continue;
    const np = w.length / 3;
    for (let i = 0; i < np; i++) {
      const j = i + 1 === np ? 0 : i + 1;
      const p1x = w[i * 3];
      const p1y = w[i * 3 + 1];
      const p1z = w[i * 3 + 2];
      const p2x = w[j * 3];
      const p2y = w[j * 3 + 1];
      const p2z = w[j * 3 + 2];
      let ex = p2x - p1x;
      let ey = p2y - p1y;
      let ez = p2z - p1z;
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
          let dup = false;
          for (let s = 0; s < ordered.length; s++) {
            const on = ordered[s].plane.normal;
            if (Math.abs(on.x - nx) < NORMAL_EPSILON && Math.abs(on.y - ny) < NORMAL_EPSILON && Math.abs(on.z - nz) < NORMAL_EPSILON) {
              dup = true;
              break;
            }
          }
          if (dup) continue;
          let dist = -Infinity;
          for (let k = 0; k < nv; k++) {
            const d = verts[k * 3] * nx + verts[k * 3 + 1] * ny + verts[k * 3 + 2] * nz;
            if (d > dist) dist = d;
          }
          // Only a plane that actually touches the brush along this edge is an edge bevel.
          if (p1x * nx + p1y * ny + p1z * nz < dist - BEVEL_ON_EPSILON) continue;
          if (p2x * nx + p2y * ny + p2z * nz < dist - BEVEL_ON_EPSILON) continue;
          ordered.push({ plane: { normal: v3(nx, ny, nz), dist }, bevel: true });
        }
      }
    }
  }

  sides.length = 0;
  for (const s of ordered) sides.push(s);
}

/**
 * Adds q3map/qbsp-style bevel planes so that box traces (planes pushed out by the box extents) see the
 * exact Minkowski sum: (a) one axial plane per axis direction at the AABB extent (existing exactly-axial
 * sides are reused and moved to the front in -x,+x,-y,+y,-z,+z order), (b) edge bevels - planes through a
 * brush edge, parallel to a world axis, that support the brush. New sides are flagged bevel=true.
 * Idempotent. Does nothing for degenerate brushes.
 */
export function addBrushBevels(brush: Brush): void {
  const ws = computeWindingsFlat(brush.sides);
  const b = boundsOfWindings(ws);
  if (!b) return;
  bevelsInternal(brush, ws, b);
}

// ---------------------------------------------------------------------------------------------- builders

/**
 * Brush from half-spaces dot(p, normal) <= dist. Sides that don't touch the volume are dropped; bevels
 * and the AABB are added. Returns null if the planes don't enclose a non-degenerate bounded volume.
 */
export function brushFromPlanes(planes: Plane[], contents: number, model = 0): Brush | null {
  const sides: BrushSide[] = [];
  for (const p of planes) {
    let nx = p.normal.x;
    let ny = p.normal.y;
    let nz = p.normal.z;
    let dist = p.dist;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 1e-9) || !Number.isFinite(len) || !Number.isFinite(dist)) continue;
    if (Math.abs(len - 1) > 1e-12) {
      nx /= len;
      ny /= len;
      nz /= len;
      dist /= len;
    }
    sides.push({ plane: { normal: v3(nx, ny, nz), dist }, bevel: false });
  }
  if (sides.length < 4) return null;
  const ws = computeWindingsFlat(sides);
  const keptSides: BrushSide[] = [];
  const keptW: FlatWinding[] = [];
  for (let i = 0; i < sides.length; i++) {
    const w = ws[i];
    if (w) {
      keptSides.push(sides[i]);
      keptW.push(w);
    }
  }
  const b = boundsOfWindings(keptW);
  if (!b) return null;
  const brush: Brush = { sides: keptSides, contents, mins: b.mins, maxs: b.maxs, model };
  bevelsInternal(brush, keptW, b);
  return brush;
}

/** Axis-aligned box brush: six real sides in -x,+x,-y,+y,-z,+z order. */
export function brushFromBox(mins: Vec3, maxs: Vec3, contents: number, model = 0): Brush {
  const lo = v3(Math.min(mins.x, maxs.x), Math.min(mins.y, maxs.y), Math.min(mins.z, maxs.z));
  const hi = v3(Math.max(mins.x, maxs.x), Math.max(mins.y, maxs.y), Math.max(mins.z, maxs.z));
  const side = (x: number, y: number, z: number, dist: number): BrushSide => ({
    plane: { normal: v3(x, y, z), dist },
    bevel: false,
  });
  return {
    sides: [
      side(-1, 0, 0, -lo.x),
      side(1, 0, 0, hi.x),
      side(0, -1, 0, -lo.y),
      side(0, 1, 0, hi.y),
      side(0, 0, -1, -lo.z),
      side(0, 0, 1, hi.z),
    ],
    contents,
    mins: lo,
    maxs: hi,
    model,
  };
}

/**
 * Convex hull of a point cloud as a brush (bevels + AABB added). Intended for small clouds (prisms,
 * wedges, displacement slabs; up to ~64 points - cost is O(n^4)). Returns null for degenerate input
 * (fewer than 4 non-coplanar points).
 */
export function brushFromPoints(points: Vec3[], contents: number, model = 0): Brush | null {
  // merge near-duplicate points
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const merge2 = HULL_MERGE_EPSILON * HULL_MERGE_EPSILON;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    let dup = false;
    for (let k = 0; k < px.length; k++) {
      const dx = px[k] - p.x;
      const dy = py[k] - p.y;
      const dz = pz[k] - p.z;
      if (dx * dx + dy * dy + dz * dz < merge2) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      px.push(p.x);
      py.push(p.y);
      pz.push(p.z);
    }
  }
  const n = px.length;
  if (n < 4) return null;

  interface Cand {
    nx: number;
    ny: number;
    nz: number;
    dist: number;
    area: number;
  }
  const cands: Cand[] = [];
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      const e1x = px[j] - px[i];
      const e1y = py[j] - py[i];
      const e1z = pz[j] - pz[i];
      const l1 = e1x * e1x + e1y * e1y + e1z * e1z;
      for (let k = j + 1; k < n; k++) {
        const e2x = px[k] - px[i];
        const e2y = py[k] - py[i];
        const e2z = pz[k] - pz[i];
        let cx = e1y * e2z - e1z * e2y;
        let cy = e1z * e2x - e1x * e2z;
        let cz = e1x * e2y - e1y * e2x;
        const c2 = cx * cx + cy * cy + cz * cz;
        const l2 = e2x * e2x + e2y * e2y + e2z * e2z;
        // reject (nearly) collinear triples: sin(angle) < 1e-6
        if (!(c2 > 1e-12 * l1 * l2) || c2 < 1e-20) continue;
        const cl = Math.sqrt(c2);
        cx /= cl;
        cy /= cl;
        cz /= cl;
        const dref = cx * px[i] + cy * py[i] + cz * pz[i];
        let dmax = -Infinity;
        let dmin = Infinity;
        for (let m = 0; m < n; m++) {
          const d = cx * px[m] + cy * py[m] + cz * pz[m];
          if (d > dmax) dmax = d;
          if (d < dmin) dmin = d;
        }
        if (dmax - dref <= HULL_EPSILON) {
          cands.push({ nx: cx, ny: cy, nz: cz, dist: dmax, area: cl });
        } else if (dref - dmin <= HULL_EPSILON) {
          cands.push({ nx: -cx, ny: -cy, nz: -cz, dist: -dmin, area: cl });
        }
      }
    }
  }
  // Best-conditioned (largest) triangles first; drop near-identical planes.
  cands.sort((a, b) => b.area - a.area);
  const planes: Plane[] = [];
  for (const c of cands) {
    let dup = false;
    for (const p of planes) {
      if (
        Math.abs(p.normal.x - c.nx) < NORMAL_EPSILON &&
        Math.abs(p.normal.y - c.ny) < NORMAL_EPSILON &&
        Math.abs(p.normal.z - c.nz) < NORMAL_EPSILON
      ) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    let nx = snap(c.nx);
    let ny = snap(c.ny);
    let nz = snap(c.nz);
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // exact supporting distance for the (snapped) normal
    let dist = -Infinity;
    for (let m = 0; m < n; m++) {
      const d = nx * px[m] + ny * py[m] + nz * pz[m];
      if (d > dist) dist = d;
    }
    planes.push({ normal: v3(nx, ny, nz), dist });
  }
  return brushFromPlanes(planes, contents, model);
}

/** Snaps tiny normal components to exactly 0 and near-unit ones to exactly +-1. */
function snap(c: number): number {
  if (Math.abs(c) < 1e-12) return 0;
  if (Math.abs(c - 1) < 1e-12) return 1;
  if (Math.abs(c + 1) < 1e-12) return -1;
  return c;
}
