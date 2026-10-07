// Reference implementations used to cross-check the collision module in tests:
//  - exact separating-axis test of an AABB against a convex brush (from its windings),
//  - a small Source-like slide move (TryPlayerMove-style clipping) for seam/ramp tests,
//  - a seeded PRNG.
import { Vec3, v3 } from '../../src/core/vec3';
import { brushWindings } from '../../src/physics/brushbuild';
import type { CollisionWorld } from '../../src/physics/collision';
import { Brush, TraceResult, newTrace } from '../../src/physics/types';

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

export interface HullRef {
  verts: Vec3[];
  axes: Vec3[];
  /** Unit edge directions of the brush. */
  edges: Vec3[];
}

/** Candidate separating axes for box-vs-brush: box axes, brush face normals, edge x box-axis. */
export function hullRef(brush: Brush): HullRef {
  const ws = brushWindings(brush);
  const verts: Vec3[] = [];
  const axes: Vec3[] = [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)];
  const edges: Vec3[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w.length === 0) continue;
    axes.push(v3(brush.sides[i].plane.normal.x, brush.sides[i].plane.normal.y, brush.sides[i].plane.normal.z));
    for (let k = 0; k < w.length; k++) {
      verts.push(w[k]);
      const a = w[k];
      const b = w[(k + 1) % w.length];
      const e = v3(b.x - a.x, b.y - a.y, b.z - a.z);
      const el = Math.hypot(e.x, e.y, e.z);
      if (el < 1e-9) continue;
      edges.push(v3(e.x / el, e.y / el, e.z / el));
      for (const ax of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)]) {
        const c = v3(e.y * ax.z - e.z * ax.y, e.z * ax.x - e.x * ax.z, e.x * ax.y - e.y * ax.x);
        const cl = Math.hypot(c.x, c.y, c.z);
        if (cl < 1e-6 * el) continue;
        axes.push(v3(c.x / cl, c.y / cl, c.z / cl));
      }
    }
  }
  return { verts, axes, edges };
}

/**
 * Signed separation between the box (center c, half extents e) and the brush along the best candidate
 * axis: > 0 separated by at least that much, < 0 overlapping (penetration along the shallowest axis).
 */
export function boxBrushGap(c: Vec3, e: Vec3, h: HullRef): number {
  let best = -Infinity;
  for (const u of h.axes) {
    const r = Math.abs(u.x) * e.x + Math.abs(u.y) * e.y + Math.abs(u.z) * e.z;
    const cc = u.x * c.x + u.y * c.y + u.z * c.z;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of h.verts) {
      const d = u.x * v.x + u.y * v.y + u.z * v.z;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const gap = Math.max(lo - (cc + r), cc - r - hi);
    if (gap > best) best = gap;
  }
  return best;
}

function projInterval(u: Vec3, verts: Vec3[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of verts) {
    const d = u.x * v.x + u.y * v.y + u.z * v.z;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/**
 * Exact separation between the box swept from center c0 to c1 (half extents e) and the brush:
 * > 0 means the swept volume never touches the brush (separated by at least that much).
 * Separating axes of convex polytope vs zonotope (box swept along d): brush faces, box axes,
 * d x axis, brush edges x axis, brush edges x d.
 */
export function sweptGap(c0: Vec3, c1: Vec3, e: Vec3, h: HullRef): number {
  const d = v3(c1.x - c0.x, c1.y - c0.y, c1.z - c0.z);
  const axes: Vec3[] = h.axes.slice();
  const add = (a: Vec3, b: Vec3) => {
    const c = v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    const cl = Math.hypot(c.x, c.y, c.z);
    const al = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z);
    if (cl > 1e-9 * al && cl > 0) axes.push(v3(c.x / cl, c.y / cl, c.z / cl));
  };
  if (Math.hypot(d.x, d.y, d.z) > 1e-9) {
    add(d, v3(1, 0, 0));
    add(d, v3(0, 1, 0));
    add(d, v3(0, 0, 1));
    for (const ed of h.edges) add(ed, d);
  }
  let best = -Infinity;
  for (const u of axes) {
    const r = Math.abs(u.x) * e.x + Math.abs(u.y) * e.y + Math.abs(u.z) * e.z;
    const p0 = u.x * c0.x + u.y * c0.y + u.z * c0.z;
    const p1 = u.x * c1.x + u.y * c1.y + u.z * c1.z;
    const smin = Math.min(p0, p1) - r;
    const smax = Math.max(p0, p1) + r;
    const [lo, hi] = projInterval(u, h.verts);
    const gap = Math.max(lo - smax, smin - hi);
    if (gap > best) best = gap;
  }
  return best;
}

export interface SlideResult {
  pos: Vec3;
  vel: Vec3;
  normals: Vec3[];
  fractions: number[];
  stuck: boolean;
  startsolid: boolean;
}

function clipVelocity(v: Vec3, n: Vec3): void {
  const back = v.x * n.x + v.y * n.y + v.z * n.z;
  v.x -= n.x * back;
  v.y -= n.y * back;
  v.z -= n.z * back;
  const adjust = v.x * n.x + v.y * n.y + v.z * n.z;
  if (adjust < 0) {
    v.x -= n.x * adjust;
    v.y -= n.y * adjust;
    v.z -= n.z * adjust;
  }
}

/** A compact TryPlayerMove-like slide: up to 4 bumps, velocity clipped against the touched planes. */
export function slideMove(
  world: CollisionWorld,
  pos: Vec3,
  vel: Vec3,
  dt: number,
  mins: Vec3,
  maxs: Vec3,
  mask: number,
  tr: TraceResult = newTrace(),
): SlideResult {
  const res: SlideResult = { pos: v3(pos.x, pos.y, pos.z), vel: v3(vel.x, vel.y, vel.z), normals: [], fractions: [], stuck: false, startsolid: false };
  const p = res.pos;
  const v = res.vel;
  const planes: Vec3[] = [];
  const original = v3(v.x, v.y, v.z);
  let timeLeft = dt;
  for (let bump = 0; bump < 4; bump++) {
    if (v.x === 0 && v.y === 0 && v.z === 0) break;
    const end = v3(p.x + v.x * timeLeft, p.y + v.y * timeLeft, p.z + v.z * timeLeft);
    world.traceBox(p, end, mins, maxs, mask, tr);
    res.fractions.push(tr.fraction);
    if (tr.startsolid) res.startsolid = true;
    if (tr.allsolid) {
      res.stuck = true;
      v.x = v.y = v.z = 0;
      break;
    }
    if (tr.fraction > 0) {
      p.x = tr.endpos.x;
      p.y = tr.endpos.y;
      p.z = tr.endpos.z;
      original.x = v.x;
      original.y = v.y;
      original.z = v.z;
      planes.length = 0;
    }
    if (tr.fraction === 1) break;
    const n = v3(tr.plane.normal.x, tr.plane.normal.y, tr.plane.normal.z);
    res.normals.push(n);
    timeLeft -= timeLeft * tr.fraction;
    planes.push(n);
    // find a velocity (original clipped by one plane) that doesn't go into any touched plane
    let ok = false;
    for (let i = 0; i < planes.length; i++) {
      const cand = v3(original.x, original.y, original.z);
      clipVelocity(cand, planes[i]);
      let good = true;
      for (let j = 0; j < planes.length; j++) {
        if (j !== i && cand.x * planes[j].x + cand.y * planes[j].y + cand.z * planes[j].z < 0) {
          good = false;
          break;
        }
      }
      if (good) {
        v.x = cand.x;
        v.y = cand.y;
        v.z = cand.z;
        ok = true;
        break;
      }
    }
    if (!ok) {
      if (planes.length === 2) {
        const a = planes[0];
        const b = planes[1];
        const d = v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
        const dl = Math.hypot(d.x, d.y, d.z);
        if (dl > 0) {
          d.x /= dl;
          d.y /= dl;
          d.z /= dl;
        }
        const s = d.x * v.x + d.y * v.y + d.z * v.z;
        v.x = d.x * s;
        v.y = d.y * s;
        v.z = d.z * s;
      } else {
        v.x = v.y = v.z = 0;
        break;
      }
    }
  }
  return res;
}
