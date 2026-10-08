// Test-only collision world for the movement tests: a brute-force (no acceleration structure) Source-style
// brush tracer plus small brush builders (boxes, extruded convex prisms for ramps/wedges, stairs).
//
// Trace semantics (classic Quake 2 / Source CM_ClipBoxToBrush, written from the public algorithm description):
//  - every brush plane is pushed out by the box: dist' = dist - dot(ofs, n) with ofs the box corner that is
//    furthest behind the plane (mins/maxs per normal component sign); bevel sides only take part in box traces;
//  - d1/d2 = signed distances of start/end from the pushed plane; d1 > 0 && d2 > 0 for any plane means the
//    sweep never touches this brush; planes with both <= 0 are skipped;
//  - entering planes give (d1 - DIST_EPSILON) / (d1 - d2), clamped to >= 0 (a box starting inside a face's
//    epsilon shell enters it at 0), leaving planes (d1 + DIST_EPSILON) / (d1 - d2); the hit is the largest
//    enter fraction if it is below the smallest leave fraction. A hit at 0 (every entering face's shell holds
//    the start, where Source goes by side / BSP order) reports the face really crossed last (largest
//    d1 / (d1 - d2)), and of brushes hit at 0 the one really entered first wins. The enter fraction starts at
//    a NEVER_UPDATED sentinel (Source), so every entering plane counts, however small the move into it;
//  - a start inside a brush (no d1 > 0) reports startsolid and that brush does not block; if the end is also
//    inside, allsolid with fraction 0 and endpos = start;
//  - a zero-length trace is the TestPlayerPosition query: touching a face (d == 0) counts as inside.
import { Vec3, v3 } from '../../src/core/vec3';
import {
  Brush,
  BrushSide,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  DIST_EPSILON,
  MASK_ALL,
  Plane,
  TraceResult,
  TraceWorld,
  newTrace,
} from '../../src/physics/types';

const ZERO = v3();
const NEVER_UPDATED = -9999;

export class RefWorld implements TraceWorld {
  readonly brushes: Brush[];
  traces = 0;
  constructor(brushes: Brush[]) {
    this.brushes = brushes;
  }

  traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number, out?: TraceResult): TraceResult {
    this.traces++;
    const sx = start.x, sy = start.y, sz = start.z;
    const ex = end.x, ey = end.y, ez = end.z;
    const isPoint = mins.x === 0 && mins.y === 0 && mins.z === 0 && maxs.x === 0 && maxs.y === 0 && maxs.z === 0;
    let fraction = 1;
    let startsolid = false;
    let allsolid = false;
    let hitPlane: Plane | null = null;
    let hitBrush: Brush | null = null;
    let solidBrush: Brush | null = null;
    let bestIn = -1;
    for (const b of this.brushes) {
      if ((b.contents & mask) === 0) continue;
      let enterfrac = NEVER_UPDATED;
      let leavefrac = 1;
      let startout = false;
      let getout = false;
      let lead: Plane | null = null;
      let inT = -1;
      let inLead: Plane | null = null;
      let skip = false;
      for (const side of b.sides) {
        if (isPoint && side.bevel) continue;
        const n = side.plane.normal;
        const ox = n.x < 0 ? maxs.x : mins.x;
        const oy = n.y < 0 ? maxs.y : mins.y;
        const oz = n.z < 0 ? maxs.z : mins.z;
        const dist = side.plane.dist - (ox * n.x + oy * n.y + oz * n.z);
        const d1 = sx * n.x + sy * n.y + sz * n.z - dist;
        const d2 = ex * n.x + ey * n.y + ez * n.z - dist;
        if (d1 > 0 && d2 > 0) {
          skip = true;
          break;
        }
        if (d2 > 0) getout = true;
        if (d1 > 0) startout = true;
        if (d1 <= 0 && d2 <= 0) continue;
        if (d1 > d2) {
          // Source clamps a pulled-back crossing behind the start to 0; then the face really crossed last leads
          let f = (d1 - DIST_EPSILON) / (d1 - d2);
          if (f <= 0) {
            f = 0;
            const t = d1 / (d1 - d2);
            if (t > inT) {
              inT = t;
              inLead = side.plane;
            }
          }
          if (f > enterfrac) {
            enterfrac = f;
            lead = side.plane;
          }
        } else {
          const f = (d1 + DIST_EPSILON) / (d1 - d2);
          if (f < leavefrac) leavefrac = f;
        }
      }
      if (skip) continue;
      if (!startout) {
        startsolid = true;
        if (!solidBrush) solidBrush = b;
        if (!getout) {
          allsolid = true;
          solidBrush = b;
          break;
        }
        continue;
      }
      // a hit at 0 reports the face really crossed last, and the brush really entered first wins
      if (enterfrac < leavefrac && enterfrac > NEVER_UPDATED && (enterfrac < fraction || (enterfrac === 0 && fraction === 0 && inT < bestIn))) {
        fraction = enterfrac;
        bestIn = enterfrac === 0 ? inT : -1;
        hitPlane = enterfrac === 0 ? inLead : lead;
        hitBrush = b;
      }
    }
    const tr = out ?? newTrace();
    tr.startsolid = startsolid;
    tr.allsolid = allsolid;
    tr.plane.normal.x = 0;
    tr.plane.normal.y = 0;
    tr.plane.normal.z = 0;
    tr.plane.dist = 0;
    tr.contents = 0;
    tr.model = -1;
    if (allsolid) {
      tr.fraction = 0;
      tr.endpos.x = sx;
      tr.endpos.y = sy;
      tr.endpos.z = sz;
      tr.contents = solidBrush!.contents;
      tr.model = solidBrush!.model;
      return tr;
    }
    tr.fraction = fraction;
    if (hitBrush && hitPlane) {
      tr.plane.normal.x = hitPlane.normal.x;
      tr.plane.normal.y = hitPlane.normal.y;
      tr.plane.normal.z = hitPlane.normal.z;
      tr.plane.dist = hitPlane.dist;
      tr.contents = hitBrush.contents;
      tr.model = hitBrush.model;
    } else if (solidBrush) {
      tr.contents = solidBrush.contents;
      tr.model = solidBrush.model;
    }
    if (fraction === 1) {
      tr.endpos.x = ex;
      tr.endpos.y = ey;
      tr.endpos.z = ez;
    } else {
      tr.endpos.x = sx + fraction * (ex - sx);
      tr.endpos.y = sy + fraction * (ey - sy);
      tr.endpos.z = sz + fraction * (ez - sz);
    }
    return tr;
  }

  traceRay(start: Vec3, end: Vec3, mask: number, out?: TraceResult): TraceResult {
    return this.traceBox(start, end, ZERO, ZERO, mask, out);
  }

  /** OR of the contents of brushes strictly containing p (on-face points are outside, like a BSP leaf walk). */
  pointContents(p: Vec3, mask: number = MASK_ALL): number {
    let c = 0;
    for (const b of this.brushes) {
      if ((b.contents & mask) === 0) continue;
      let inside = true;
      for (const side of b.sides) {
        if (side.bevel) continue;
        const n = side.plane.normal;
        if (p.x * n.x + p.y * n.y + p.z * n.z - side.plane.dist >= 0) {
          inside = false;
          break;
        }
      }
      if (inside) c |= b.contents;
    }
    return c & mask;
  }

  /** Source TestPlayerPosition: box at origin inside or touching a brush. */
  testBox(origin: Vec3, mins: Vec3, maxs: Vec3, mask: number): boolean {
    for (const b of this.brushes) {
      if ((b.contents & mask) === 0) continue;
      let inside = true;
      for (const side of b.sides) {
        const n = side.plane.normal;
        const ox = n.x < 0 ? maxs.x : mins.x;
        const oy = n.y < 0 ? maxs.y : mins.y;
        const oz = n.z < 0 ? maxs.z : mins.z;
        const dist = side.plane.dist - (ox * n.x + oy * n.y + oz * n.z);
        if (origin.x * n.x + origin.y * n.y + origin.z * n.z - dist > 0) {
          inside = false;
          break;
        }
      }
      if (inside) return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------------------------------ brush building

function plane(nx: number, ny: number, nz: number, dist: number): Plane {
  const l = Math.hypot(nx, ny, nz);
  return { normal: v3(nx / l, ny / l, nz / l), dist: dist / l };
}

/** Plane with unit normal n through point p. */
export function planeThrough(n: Vec3, p: Vec3): Plane {
  const l = Math.hypot(n.x, n.y, n.z);
  const u = v3(n.x / l, n.y / l, n.z / l);
  return { normal: u, dist: u.x * p.x + u.y * p.y + u.z * p.z };
}

function intersect3(a: Plane, b: Plane, c: Plane): Vec3 | null {
  const n1 = a.normal, n2 = b.normal, n3 = c.normal;
  const c23 = cross(n2, n3);
  const det = dot(n1, c23);
  if (Math.abs(det) < 1e-9) return null;
  const c31 = cross(n3, n1);
  const c12 = cross(n1, n2);
  return v3(
    (a.dist * c23.x + b.dist * c31.x + c.dist * c12.x) / det,
    (a.dist * c23.y + b.dist * c31.y + c.dist * c12.y) / det,
    (a.dist * c23.z + b.dist * c31.z + c.dist * c12.z) / det,
  );
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Vertices of the convex volume bounded by the planes (brute force over plane triples). */
export function brushVertices(planes: Plane[]): Vec3[] {
  const verts: Vec3[] = [];
  for (let i = 0; i < planes.length; i++)
    for (let j = i + 1; j < planes.length; j++)
      for (let k = j + 1; k < planes.length; k++) {
        const p = intersect3(planes[i], planes[j], planes[k]);
        if (!p) continue;
        let ok = true;
        for (const pl of planes) {
          if (dot(pl.normal, p) - pl.dist > 1e-6) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (verts.some((v) => Math.abs(v.x - p.x) < 1e-6 && Math.abs(v.y - p.y) < 1e-6 && Math.abs(v.z - p.z) < 1e-6)) continue;
        verts.push(p);
      }
  return verts;
}

/**
 * Builds a brush from its face planes (outward normals), adding q3map-style bevels: axial planes at the
 * AABB and, for every non-axial edge, the planes containing the edge parallel to each axis that have the
 * whole brush behind them. Throws if the planes don't bound a volume.
 */
export function brushFromFacePlanes(faces: Plane[], contents = CONTENTS_SOLID, model = 0): Brush {
  const verts = brushVertices(faces);
  if (verts.length < 4) throw new Error('degenerate brush');
  const mins = v3(Infinity, Infinity, Infinity);
  const maxs = v3(-Infinity, -Infinity, -Infinity);
  for (const v of verts) {
    mins.x = Math.min(mins.x, v.x);
    mins.y = Math.min(mins.y, v.y);
    mins.z = Math.min(mins.z, v.z);
    maxs.x = Math.max(maxs.x, v.x);
    maxs.y = Math.max(maxs.y, v.y);
    maxs.z = Math.max(maxs.z, v.z);
  }
  const sides: BrushSide[] = faces.map((p) => ({ plane: p, bevel: false }));
  const has = (n: Vec3): boolean => sides.some((s) => dot(s.plane.normal, n) > 1 - 1e-9);
  // axial bevels
  const axial: [Vec3, number][] = [
    [v3(1, 0, 0), maxs.x],
    [v3(-1, 0, 0), -mins.x],
    [v3(0, 1, 0), maxs.y],
    [v3(0, -1, 0), -mins.y],
    [v3(0, 0, 1), maxs.z],
    [v3(0, 0, -1), -mins.z],
  ];
  for (const [n, d] of axial) if (!has(n)) sides.push({ plane: { normal: n, dist: d }, bevel: true });
  // edge bevels
  const axes = [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)];
  for (let i = 0; i < faces.length; i++)
    for (let j = i + 1; j < faces.length; j++) {
      const on = verts.filter(
        (v) => Math.abs(dot(faces[i].normal, v) - faces[i].dist) < 1e-6 && Math.abs(dot(faces[j].normal, v) - faces[j].dist) < 1e-6,
      );
      if (on.length < 2) continue;
      let dir = v3(on[1].x - on[0].x, on[1].y - on[0].y, on[1].z - on[0].z);
      const dl = Math.hypot(dir.x, dir.y, dir.z);
      dir = v3(dir.x / dl, dir.y / dl, dir.z / dl);
      if (Math.abs(dir.x) > 1 - 1e-9 || Math.abs(dir.y) > 1 - 1e-9 || Math.abs(dir.z) > 1 - 1e-9) continue;
      for (const ax of axes)
        for (const sgn of [1, -1]) {
          const c = cross(dir, v3(ax.x * sgn, ax.y * sgn, ax.z * sgn));
          const cl = Math.hypot(c.x, c.y, c.z);
          if (cl < 1e-6) continue;
          const n = v3(c.x / cl, c.y / cl, c.z / cl);
          const d = dot(n, on[0]);
          if (verts.some((v) => dot(n, v) - d > 1e-6)) continue;
          if (has(n)) continue;
          sides.push({ plane: { normal: n, dist: d }, bevel: true });
        }
    }
  return { sides, contents, mins, maxs, model };
}

export function boxBrush(mins: Vec3, maxs: Vec3, contents = CONTENTS_SOLID, model = 0): Brush {
  return brushFromFacePlanes(
    [
      plane(1, 0, 0, maxs.x),
      plane(-1, 0, 0, -mins.x),
      plane(0, 1, 0, maxs.y),
      plane(0, -1, 0, -mins.y),
      plane(0, 0, 1, maxs.z),
      plane(0, 0, -1, -mins.z),
    ],
    contents,
    model,
  );
}

export function waterBrush(mins: Vec3, maxs: Vec3): Brush {
  return boxBrush(mins, maxs, CONTENTS_WATER);
}

/**
 * Convex polygon in the XZ plane (counter-clockwise when viewed from -Y, i.e. x right / z up) extruded
 * along Y from y0 to y1. Surf ramps, wedges and slopes.
 */
export function prismXZ(poly: [number, number][], y0: number, y1: number, contents = CONTENTS_SOLID, model = 0): Brush {
  const faces: Plane[] = [plane(0, 1, 0, y1), plane(0, -1, 0, -y0)];
  const n = poly.length;
  // signed area to know the winding
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % n];
    area += ax * bz - bx * az;
  }
  const ccw = area > 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % n];
    const ex = bx - ax;
    const ez = bz - az;
    // outward normal of a CCW polygon edge is (ez, -ex)
    let nx = ez;
    let nz = -ex;
    if (!ccw) {
      nx = -nx;
      nz = -nz;
    }
    const l = Math.hypot(nx, nz);
    nx /= l;
    nz /= l;
    faces.push({ normal: v3(nx, 0, nz), dist: nx * ax + nz * az });
  }
  return brushFromFacePlanes(faces, contents, model);
}

/** Convex polygon in the XY plane (either winding) extruded along Z from z0 to z1: angled walls/pillars. */
export function prismXY(poly: [number, number][], z0: number, z1: number, contents = CONTENTS_SOLID, model = 0): Brush {
  return brushFromFacePlanes([plane(0, 0, 1, z1), plane(0, 0, -1, -z0), ...polygonPlanes(poly, 'xy')], contents, model);
}

/** Outward side planes of a convex 2D polygon, embedded as vertical (xy) or y-extruded (xz) planes. */
function polygonPlanes(poly: [number, number][], kind: 'xy' | 'xz'): Plane[] {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % n];
    area += ax * by - bx * ay;
  }
  const out: Plane[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % n];
    let nx = by - ay;
    let ny = -(bx - ax);
    if (area < 0) {
      nx = -nx;
      ny = -ny;
    }
    const l = Math.hypot(nx, ny);
    nx /= l;
    ny /= l;
    const d = nx * ax + ny * ay;
    out.push(kind === 'xy' ? { normal: v3(nx, ny, 0), dist: d } : { normal: v3(nx, 0, ny), dist: d });
  }
  return out;
}

/**
 * prismXZ rotated about the vertical axis through (cx, cy) by `deg` degrees (counter-clockwise from above):
 * ramps facing arbitrary directions, with the bevels recomputed for the rotated geometry.
 */
export function rotatedPrismXZ(
  poly: [number, number][],
  y0: number,
  y1: number,
  deg: number,
  cx: number,
  cy: number,
  contents = CONTENTS_SOLID,
): Brush {
  const faces = [plane(0, 1, 0, y1), plane(0, -1, 0, -y0), ...polygonPlanes(poly, 'xz')];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const rotated = faces.map((p) => {
    const n = p.normal;
    const rn = v3(n.x * c - n.y * s, n.x * s + n.y * c, n.z);
    // p' = R(p - C) + C  =>  n'.p' = d - n.C + n'.C
    const d = p.dist - (n.x * cx + n.y * cy) + (rn.x * cx + rn.y * cy);
    return { normal: rn, dist: d };
  });
  return brushFromFacePlanes(rotated, contents);
}

/** Same as prismXZ but the polygon lives in the YZ plane and is extruded along X. */
export function prismYZ(poly: [number, number][], x0: number, x1: number, contents = CONTENTS_SOLID, model = 0): Brush {
  const b = prismXZ(poly, x0, x1, contents, model);
  // swap x <-> y in every plane (a mirror): flip handedness is irrelevant for half-spaces
  const swap = (v: Vec3): Vec3 => v3(v.y, v.x, v.z);
  return brushFromFacePlanes(
    b.sides.filter((s) => !s.bevel).map((s) => ({ normal: swap(s.plane.normal), dist: s.plane.dist })),
    contents,
    model,
  );
}

/**
 * A surf ramp: triangular prism along Y whose slanted face has outward normal (-sin a, 0, cos a)
 * (normal.z = cos a), rising toward +X from (x0, z0) to height `height`.
 */
export function surfRamp(x0: number, z0: number, height: number, normalZ: number, y0: number, y1: number): Brush {
  const a = Math.acos(normalZ);
  const run = height / Math.tan(a);
  return prismXZ(
    [
      [x0, z0],
      [x0 + run, z0],
      [x0 + run, z0 + height],
    ],
    y0,
    y1,
  );
}

/** Stairs going up toward +X: `count` steps of the given rise and depth, `width` wide centered on y=0. */
export function stairs(x0: number, z0: number, rise: number, depth: number, count: number, width: number): Brush[] {
  const out: Brush[] = [];
  for (let i = 0; i < count; i++) {
    out.push(boxBrush(v3(x0 + i * depth, -width / 2, z0), v3(x0 + 4096, width / 2, z0 + (i + 1) * rise)));
  }
  return out;
}

/** A big flat floor with its top at z. */
export function floorBrush(z = 0, half = 16384): Brush {
  return boxBrush(v3(-half, -half, z - 64), v3(half, half, z));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
