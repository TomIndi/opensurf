// Prop collision: the .phy (VCollide) reader, hull planes / brushes, their placement, the prop collision builder
// and its use by the loader. Synthetic files first; then the real maps (SURF_TEST_MAPS, SURF_TEST_MAPS_LARGE for
// surf_summer_ksf), skipped when unset.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { qa } from '../src/core/angles';
import { Vec3, v3 } from '../src/core/vec3';
import { parseEntities } from '../src/bsp/entities';
import { loadBspMap } from '../src/bsp/loadmap';
import { PakFile } from '../src/bsp/pakfile';
import {
  IVP_TO_INCHES,
  PROP_COLLISION_MODEL,
  PhyConvex,
  Placement,
  buildPropCollision,
  cacheConvex,
  convexPlanes,
  parsePhy,
  placeConvex,
  placement,
  solidPropPlacements,
} from '../src/bsp/phy';
import { buildMapProps, readStudioHeader } from '../src/bsp/props';
import { parseBsp } from '../src/bsp/reader';
import { BspFile } from '../src/bsp/types';
import type { LoadedMap, MapEntity } from '../src/map/types';
import { brushFromPlanes, brushWindings } from '../src/physics/brushbuild';
import { CollisionWorld, boxIntersectsBrush } from '../src/physics/collision';
import { categorizePosition, defaultMoveVars, playerHull, playerMove, unstuckPlayer } from '../src/physics/movement';
import { HULL_MAXS, HULL_MINS, MOVETYPE_WALK, PlayerState, createPlayerState, newMoveEvents, newUserCmd } from '../src/physics/playertypes';
import { Brush, CONTENTS_SOLID, MASK_PLAYERSOLID, Plane, newTrace } from '../src/physics/types';
import { buildBoxWorld } from './fixtures/bsp_synth';
import { mulberry32 } from './helpers/collision_ref';

// ------------------------------------------------------------------------------------------ synthetic .phy

type P3 = [number, number, number];

interface LedgeSpec {
  /** IVP space (metres, Y down). */
  points: P3[];
  tris: [number, number, number][];
}

/** Triangles of the box [lo, hi] over its 8 corners (index = x | y << 1 | z << 2), wound arbitrarily. */
function boxLedge(lo: P3, hi: P3): LedgeSpec {
  const points: P3[] = [];
  for (let i = 0; i < 8; i++) points.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
  const quads = [
    [0, 2, 6, 4],
    [1, 5, 7, 3],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 1, 3, 2],
    [4, 6, 7, 5],
  ];
  const tris: [number, number, number][] = [];
  for (const q of quads) tris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
  return { points, tris };
}

interface PhyBuildOptions {
  legacy?: boolean;
  /** Write a ledge tree (default true); false leaves offset_ledgetree_root 0. */
  tree?: boolean;
  text?: string;
}

/**
 * Writes a .phy: one solid per entry; each solid = two leaf ledges (convex pieces) plus their parent hull ledge
 * (has_children) and a 3-node ledge tree, or a single leaf ledge.
 */
function buildPhy(solids: LedgeSpec[][], o: PhyBuildOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = new DataView(new ArrayBuffer(16));
  head.setInt32(0, 16, true);
  head.setInt32(4, 0, true);
  head.setInt32(8, solids.length, true);
  head.setInt32(12, 0x12345678, true);
  parts.push(new Uint8Array(head.buffer));
  for (const leaves of solids) {
    const ledges: { spec: LedgeSpec; children: number; base: number }[] = [];
    // shared point array: all leaf points, then the parent hull's
    let base = 0;
    for (const spec of leaves) {
      ledges.push({ spec, children: 0, base });
      base += spec.points.length;
    }
    if (leaves.length === 2) {
      const all = [...leaves[0].points, ...leaves[1].points];
      const lo: P3 = [0, 1, 2].map((k) => Math.min(...all.map((p) => p[k]))) as P3;
      const hi: P3 = [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k]))) as P3;
      ledges.push({ spec: boxLedge(lo, hi), children: 1, base });
      base += 8;
    }
    const ledgeBytes = ledges.reduce((n, l) => n + 16 + l.spec.tris.length * 16, 0);
    const pointsStart = 48 + ledgeBytes;
    const nodesStart = pointsStart + base * 16;
    const nodeCount = leaves.length === 2 && o.tree !== false ? 3 : leaves.length === 1 && o.tree !== false ? 1 : 0;
    const surfSize = nodesStart + nodeCount * 28;
    const hdr = o.legacy ? 0 : 28;
    const blob = new DataView(new ArrayBuffer(hdr + surfSize));
    if (!o.legacy) {
      blob.setUint32(0, 0x59485056, true); // VPHY
      blob.setInt16(4, 0x100, true);
      blob.setInt16(6, 0, true);
      blob.setInt32(8, surfSize, true);
    }
    const s = hdr;
    blob.setFloat32(s + 24, 1, true); // upper limit radius
    blob.setUint32(s + 28, ((surfSize << 8) | 0xfa) >>> 0, true);
    blob.setInt32(s + 32, nodeCount ? nodesStart : 0, true);
    blob.setUint32(s + 44, 0x53505649, true); // IVPS
    let l = s + 48;
    const ledgeAt: number[] = [];
    for (const ld of ledges) {
      ledgeAt.push(l);
      blob.setInt32(l, s + pointsStart + ld.base * 16 - l, true);
      blob.setUint32(l + 8, (ld.children | (1 << 2) | (((16 + ld.spec.tris.length * 16) >> 4) << 8)) >>> 0, true);
      blob.setInt16(l + 12, ld.spec.tris.length, true);
      ld.spec.tris.forEach((t, i) => {
        const to = l + 16 + i * 16;
        blob.setUint32(to, i, true);
        for (let e = 0; e < 3; e++) blob.setUint32(to + 4 + e * 4, t[e] & 0xffff, true);
      });
      l += 16 + ld.spec.tris.length * 16;
    }
    for (const ld of ledges) {
      ld.spec.points.forEach((p, i) => {
        const po = s + pointsStart + (ld.base + i) * 16;
        blob.setFloat32(po, p[0], true);
        blob.setFloat32(po + 4, p[1], true);
        blob.setFloat32(po + 8, p[2], true);
      });
    }
    const node = (i: number) => s + nodesStart + i * 28;
    if (nodeCount === 3) {
      blob.setInt32(node(0), node(2) - node(0), true); // right child
      blob.setInt32(node(0) + 4, ledgeAt[2] - node(0), true); // inner node -> the subtree's hull
      blob.setInt32(node(1) + 4, ledgeAt[0] - node(1), true);
      blob.setInt32(node(2) + 4, ledgeAt[1] - node(2), true);
    } else if (nodeCount === 1) {
      blob.setInt32(node(0) + 4, ledgeAt[0] - node(0), true);
    }
    const size = new DataView(new ArrayBuffer(4));
    size.setInt32(0, blob.byteLength, true);
    parts.push(new Uint8Array(size.buffer), new Uint8Array(blob.buffer));
  }
  parts.push(new TextEncoder().encode(o.text ?? 'solid {\n"index" "0"\n"name" "test"\n"surfaceprop" "metal"\n}\neditparams {\n"concave" "1"\n}\n\0'));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Two 1 m cubes side by side along IVP x (Source: x 0..2 m, y 0..1 m, z -1..0 m). */
const TWO_CUBES = [boxLedge([0, 0, 0], [1, 1, 1]), boxLedge([1, 0, 0], [2, 1, 1])];
const M = IVP_TO_INCHES;

function boundsOf(c: PhyConvex): { lo: Vec3; hi: Vec3 } {
  const lo = v3(Infinity, Infinity, Infinity);
  const hi = v3(-Infinity, -Infinity, -Infinity);
  for (let k = 0; k < c.points.length; k += 3) {
    lo.x = Math.min(lo.x, c.points[k]);
    lo.y = Math.min(lo.y, c.points[k + 1]);
    lo.z = Math.min(lo.z, c.points[k + 2]);
    hi.x = Math.max(hi.x, c.points[k]);
    hi.y = Math.max(hi.y, c.points[k + 1]);
    hi.z = Math.max(hi.z, c.points[k + 2]);
  }
  return { lo, hi };
}

describe('parsePhy', () => {
  it('reads the leaf ledges of a modern (VPHY) collide in Source space, skipping subtree hulls', () => {
    const phy = parsePhy(buildPhy([TWO_CUBES]))!;
    expect(phy).toBeTruthy();
    expect(phy.solidCount).toBe(1);
    expect(phy.checksum).toBe(0x12345678);
    expect(phy.warnings).toEqual([]);
    expect(phy.solids.length).toBe(1);
    const s = phy.solids[0];
    expect(s.legacy).toBe(false);
    expect(s.surfaceprop).toBe('metal');
    expect(s.convexes.length).toBe(2); // the parent hull (has_children) is not a piece
    for (const c of s.convexes) {
      expect(c.points.length).toBe(8 * 3);
      expect(c.triangles.length).toBe(12 * 3);
    }
    // Source x = ivp x, y = ivp z, z = -ivp y (metres -> inches)
    const a = boundsOf(s.convexes[0]);
    expect(a.lo.x).toBeCloseTo(0, 4);
    expect(a.hi.x).toBeCloseTo(M, 3);
    expect(a.lo.y).toBeCloseTo(0, 4);
    expect(a.hi.y).toBeCloseTo(M, 3);
    expect(a.lo.z).toBeCloseTo(-M, 3);
    expect(a.hi.z).toBeCloseTo(0, 4);
    const b = boundsOf(s.convexes[1]);
    expect(b.lo.x).toBeCloseTo(M, 3);
    expect(b.hi.x).toBeCloseTo(2 * M, 3);
    expect(s.mins.x).toBeCloseTo(0, 4);
    expect(s.maxs.x).toBeCloseTo(2 * M, 3);
    expect(s.mins.z).toBeCloseTo(-M, 3);
    expect(phy.text).toMatch(/editparams/);
  });

  it('reads the legacy layout (no VPHY header), single-ledge trees and tree-less surfaces', () => {
    const legacy = parsePhy(buildPhy([TWO_CUBES], { legacy: true }))!;
    expect(legacy.solids.length).toBe(1);
    expect(legacy.solids[0].legacy).toBe(true);
    expect(legacy.solids[0].convexes.length).toBe(2);
    const single = parsePhy(buildPhy([[boxLedge([0, 0, 0], [1, 2, 3])]]))!;
    expect(single.solids[0].convexes.length).toBe(1);
    expect(single.solids[0].maxs.y).toBeCloseTo(3 * M, 3);
    expect(single.solids[0].mins.z).toBeCloseTo(-2 * M, 3);
    // no ledge tree: ledges are walked in order; the subtree hull (has_children) is still skipped
    const flat = parsePhy(buildPhy([TWO_CUBES], { tree: false }))!;
    expect(flat.solids[0].convexes.length).toBe(2);
    // several solids
    const two = parsePhy(buildPhy([TWO_CUBES, [boxLedge([0, 0, 0], [1, 1, 1])]]))!;
    expect(two.solidCount).toBe(2);
    expect(two.solids.map((s) => s.convexes.length)).toEqual([2, 1]);
  });

  it('never throws on corrupt or truncated data', () => {
    expect(parsePhy(new Uint8Array(0))).toBeNull();
    expect(parsePhy(new Uint8Array(10))).toBeNull();
    expect(parsePhy(new TextEncoder().encode('not a collide file at all, just text'))).toBeNull();
    const good = buildPhy([TWO_CUBES]);
    for (let n = 0; n < good.length; n += 7) expect(() => parsePhy(good.subarray(0, n))).not.toThrow();
    const rnd = mulberry32(5);
    for (let i = 0; i < 300; i++) {
      const bad = good.slice();
      for (let k = 0; k < 1 + Math.floor(rnd() * 8); k++) bad[Math.floor(rnd() * bad.length)] = Math.floor(rnd() * 256);
      expect(() => parsePhy(bad)).not.toThrow();
      const r = parsePhy(bad);
      if (r) for (const s of r.solids) for (const c of s.convexes) expect(c.points.every((x) => Number.isFinite(x))).toBe(true);
    }
    // an unsupported collide model type is skipped with a warning
    const mopp = buildPhy([TWO_CUBES]);
    new DataView(mopp.buffer).setInt16(16 + 4 + 6, 1, true);
    const r = parsePhy(mopp)!;
    expect(r.solids.length).toBe(0);
    expect(r.warnings.join()).toMatch(/model type 1/);
  });
});

// ------------------------------------------------------------------------------------------ hull brushes

/** A convex piece in Source space from points + hull triangles. */
function convex(points: P3[], tris: [number, number, number][]): PhyConvex {
  return { points: Float64Array.from(points.flat()), triangles: Uint32Array.from(tris.flat()) };
}

/** A slanted wedge (ramp-like) and a tetrahedron, in Source space. */
const WEDGE = convex(
  [
    [0, 0, 0],
    [300, 0, 0],
    [0, 500, 0],
    [300, 500, 0],
    [0, 0, 220],
    [0, 500, 220],
  ],
  [
    [0, 1, 3],
    [0, 3, 2],
    [0, 2, 5],
    [0, 5, 4],
    [1, 4, 5],
    [1, 5, 3],
    [0, 4, 1],
    [2, 3, 5],
  ],
);
const TETRA = convex(
  [
    [0, 0, 0],
    [100, 10, 0],
    [30, 90, 5],
    [40, 30, 80],
  ],
  [
    [0, 1, 2],
    [0, 1, 3],
    [1, 2, 3],
    [0, 2, 3],
  ],
);

function placedPlanes(planes: Plane[], t: Placement): Plane[] {
  const m = t.m;
  return planes.map((p) => {
    const n = p.normal;
    const nx = m[0] * n.x + m[1] * n.y + m[2] * n.z;
    const ny = m[3] * n.x + m[4] * n.y + m[5] * n.z;
    const nz = m[6] * n.x + m[7] * n.y + m[8] * n.z;
    return { normal: v3(nx, ny, nz), dist: p.dist * t.scale + nx * t.origin.x + ny * t.origin.y + nz * t.origin.z };
  });
}

function placedPoints(c: PhyConvex, t: Placement): number[][] {
  const out: number[][] = [];
  const m = t.m;
  for (let k = 0; k < c.points.length; k += 3) {
    const x = c.points[k] * t.scale;
    const y = c.points[k + 1] * t.scale;
    const z = c.points[k + 2] * t.scale;
    out.push([m[0] * x + m[1] * y + m[2] * z + t.origin.x, m[3] * x + m[4] * y + m[5] * z + t.origin.y, m[6] * x + m[7] * y + m[8] * z + t.origin.z]);
  }
  return out;
}

/** Complete separating-axis set of a box against a convex hull: box axes, hull face normals, hull edges x axes. */
function satAxes(P: number[][], c: PhyConvex): number[][] {
  const raw: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const T = c.triangles;
  for (let k = 0; k < T.length; k += 3) {
    const a = P[T[k]];
    const b = P[T[k + 1]];
    const d = P[T[k + 2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const e = [d[0] - b[0], d[1] - b[1], d[2] - b[2]];
    raw.push([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
    for (const ed of [u, w, e]) {
      for (const ax of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]) {
        raw.push([ed[1] * ax[2] - ed[2] * ax[1], ed[2] * ax[0] - ed[0] * ax[2], ed[0] * ax[1] - ed[1] * ax[0]]);
      }
    }
  }
  const axes: number[][] = [];
  for (const r of raw) {
    const l = Math.hypot(r[0], r[1], r[2]);
    if (l > 1e-6) axes.push([r[0] / l, r[1] / l, r[2] / l]);
  }
  return axes;
}

/** Exact distance between the box at `o` and the hull (positive = apart): the largest gap over the SAT axes. */
function separation(P: number[][], axes: number[][], o: Vec3, mins: Vec3, maxs: Vec3): number {
  let best = -Infinity;
  for (const n of axes) {
    let hi = -Infinity;
    let lo = Infinity;
    for (const p of P) {
      const d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
      if (d > hi) hi = d;
      if (d < lo) lo = d;
    }
    const blo = n[0] * (o.x + (n[0] > 0 ? mins.x : maxs.x)) + n[1] * (o.y + (n[1] > 0 ? mins.y : maxs.y)) + n[2] * (o.z + (n[2] > 0 ? mins.z : maxs.z));
    const bhi = n[0] * (o.x + (n[0] > 0 ? maxs.x : mins.x)) + n[1] * (o.y + (n[1] > 0 ? maxs.y : mins.y)) + n[2] * (o.z + (n[2] > 0 ? maxs.z : mins.z));
    best = Math.max(best, blo - hi, lo - bhi);
  }
  return best;
}

interface SweepStats {
  hits: number;
  early: number;
  deep: number;
  passThrough: number;
  worst: number;
}

/**
 * Sweeps player boxes at the placed hull (aimed at its corners, where bevels matter) and checks every result
 * against the exact geometry: a hit must end DIST_EPSILON (1/32) off the hull, a miss must not overlap it.
 */
function sweepCheck(c: PhyConvex, brush: Brush, t: Placement, rnd: () => number, n: number, st: SweepStats): void {
  const world = new CollisionWorld([brush]);
  const P = placedPoints(c, t);
  const axes = satAxes(P, c);
  const c0 = v3((brush.mins.x + brush.maxs.x) / 2, (brush.mins.y + brush.maxs.y) / 2, (brush.mins.z + brush.maxs.z) / 2);
  const R = Math.max(brush.maxs.x - brush.mins.x, brush.maxs.y - brush.mins.y, brush.maxs.z - brush.mins.z) / 2 + 80;
  const tr = newTrace();
  for (let k = 0; k < n; k++) {
    const s = v3(c0.x + (rnd() * 2 - 1) * R, c0.y + (rnd() * 2 - 1) * R, c0.z + (rnd() * 2 - 1) * R);
    if (separation(P, axes, s, HULL_MINS, HULL_MAXS) <= 0.05) continue;
    const q = P[Math.floor(rnd() * P.length)];
    const e = v3(q[0] + (q[0] - s.x) * 0.3 + (rnd() - 0.5) * 40, q[1] + (q[1] - s.y) * 0.3 + (rnd() - 0.5) * 40, q[2] - 36 + (q[2] - s.z) * 0.3 + (rnd() - 0.5) * 40);
    world.traceBox(s, e, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    if (tr.startsolid) continue;
    const sep = separation(P, axes, tr.endpos, HULL_MINS, HULL_MAXS);
    if (tr.fraction < 1) {
      st.hits++;
      if (sep > 0.07) st.early++;
      if (sep < 0.01) st.deep++;
      st.worst = Math.max(st.worst, Math.abs(sep - 0.03125));
    } else if (sep < 0) st.passThrough++;
  }
}

describe('hull brushes', () => {
  it('face planes: one per face of the hull, supporting every point', () => {
    const cube = parsePhy(buildPhy([[boxLedge([0, 0, 0], [1, 1, 1])]]))!.solids[0].convexes[0];
    const planes = convexPlanes(cube);
    expect(planes.length).toBe(6);
    for (const p of planes) {
      const n = p.normal;
      expect(Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z)).toBeCloseTo(1, 9); // axial
    }
    for (const c of [WEDGE, TETRA]) {
      const pl = convexPlanes(c);
      expect(pl.length).toBe(c === WEDGE ? 5 : 4);
      for (const p of pl) {
        for (let k = 0; k < c.points.length; k += 3) {
          expect(p.normal.x * c.points[k] + p.normal.y * c.points[k + 1] + p.normal.z * c.points[k + 2]).toBeLessThanOrEqual(p.dist + 1e-9);
        }
      }
    }
    // nearly coplanar triangles (float noise) make one face, not two nearly parallel planes
    const noisy = convex(
      [
        [0, 0, 0],
        [400, 0, 0.004],
        [0, 400, -0.003],
        [400, 400, 0.002],
        [0, 0, -50],
        [400, 0, -50],
        [0, 400, -50],
        [400, 400, -50],
      ],
      [
        [0, 1, 3],
        [0, 3, 2],
        [4, 7, 5],
        [4, 6, 7],
        [0, 4, 5],
        [0, 5, 1],
        [2, 3, 7],
        [2, 7, 6],
        [0, 2, 6],
        [0, 6, 4],
        [1, 5, 7],
        [1, 7, 3],
      ],
    );
    expect(convexPlanes(noisy).filter((p) => p.normal.z > 0.9).length).toBe(1);
  });

  it('cached hulls placed by any rotation collide exactly like the hull (and like brushFromPlanes)', () => {
    const rnd = mulberry32(11);
    const st: SweepStats = { hits: 0, early: 0, deep: 0, passThrough: 0, worst: 0 };
    let compared = 0;
    for (const c of [WEDGE, TETRA, parsePhy(buildPhy([TWO_CUBES]))!.solids[0].convexes[1]]) {
      const cc = cacheConvex(c)!;
      expect(cc).toBeTruthy();
      expect(cc.brush).toBeTruthy();
      for (let i = 0; i < 12; i++) {
        const axial = i < 4;
        const angles = axial ? qa(0, 90 * i, i === 3 ? 180 : 0) : qa(rnd() * 360 - 180, rnd() * 360, rnd() * 360 - 180);
        const t = placement(v3(rnd() * 4000 - 2000, rnd() * 4000 - 2000, rnd() * 4000 - 2000), angles, i % 3 === 2 ? 1.5 : 1);
        expect(t.perm).toBe(axial);
        const b = placeConvex(cc, t, CONTENTS_SOLID, PROP_COLLISION_MODEL)!;
        expect(b.model).toBe(PROP_COLLISION_MODEL);
        sweepCheck(c, b, t, rnd, 60, st);
        // same box-trace results as the generic builder on the placed face planes
        const ref = brushFromPlanes(placedPlanes(cc.planes, t), CONTENTS_SOLID, 0)!;
        const wa = new CollisionWorld([b]);
        const wb = new CollisionWorld([ref]);
        const ta = newTrace();
        const tb = newTrace();
        for (let k = 0; k < 40; k++) {
          const c0 = v3((ref.mins.x + ref.maxs.x) / 2, (ref.mins.y + ref.maxs.y) / 2, (ref.mins.z + ref.maxs.z) / 2);
          const s = v3(c0.x + (rnd() - 0.5) * 800, c0.y + (rnd() - 0.5) * 800, c0.z + (rnd() - 0.5) * 800);
          const e = v3(c0.x + (rnd() - 0.5) * 300, c0.y + (rnd() - 0.5) * 300, c0.z + (rnd() - 0.5) * 300);
          wa.traceBox(s, e, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, ta);
          wb.traceBox(s, e, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tb);
          expect(ta.startsolid).toBe(tb.startsolid);
          const len = Math.hypot(e.x - s.x, e.y - s.y, e.z - s.z);
          expect(Math.abs(ta.fraction - tb.fraction) * len).toBeLessThan(0.01);
          compared++;
        }
        for (const k of ['x', 'y', 'z'] as const) {
          expect(b.mins[k]).toBeCloseTo(ref.mins[k], 4);
          expect(b.maxs[k]).toBeCloseTo(ref.maxs[k], 4);
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(st.hits).toBeGreaterThan(500);
    expect(st.early).toBe(0);
    expect(st.deep).toBe(0);
    expect(st.passThrough).toBe(0);
  });

  it('degenerate pieces (flat, too few points) give no brush', () => {
    expect(cacheConvex(convex([[0, 0, 0], [10, 0, 0], [0, 10, 0]], [[0, 1, 2]]))).toBeNull();
    const flat = convex(
      [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
        [10, 10, 0],
      ],
      [
        [0, 1, 3],
        [0, 3, 2],
        [0, 3, 1],
        [0, 2, 3],
      ],
    );
    expect(cacheConvex(flat)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------ prop collision

/** A minimal studio header (what collision reads): hull box and $contents. */
function fakeMdl(hullMin: P3, hullMax: P3, contents = CONTENTS_SOLID): Uint8Array {
  const d = new DataView(new ArrayBuffer(408));
  [0x49, 0x44, 0x53, 0x54].forEach((c, i) => d.setUint8(i, c)); // IDST
  d.setInt32(4, 48, true);
  for (let k = 0; k < 3; k++) {
    d.setFloat32(104 + k * 4, hullMin[k], true);
    d.setFloat32(116 + k * 4, hullMax[k], true);
  }
  d.setInt32(156, 1, true);
  d.setInt32(332, contents, true);
  return new Uint8Array(d.buffer);
}

interface SprpProp {
  model: number;
  origin: P3;
  angles: P3;
  solid: number;
}

/** A v10 (72-byte record) static prop lump. */
function sprpLump(dict: string[], props: SprpProp[]): Uint8Array {
  const d = new DataView(new ArrayBuffer(4 + dict.length * 128 + 4 + 4 + props.length * 72));
  let o = 0;
  d.setInt32(o, dict.length, true);
  o += 4;
  for (const name of dict) {
    for (let i = 0; i < name.length; i++) d.setUint8(o + i, name.charCodeAt(i));
    o += 128;
  }
  d.setInt32(o, 0, true); // leaves
  o += 4;
  d.setInt32(o, props.length, true);
  o += 4;
  for (const p of props) {
    for (let k = 0; k < 3; k++) {
      d.setFloat32(o + k * 4, p.origin[k], true);
      d.setFloat32(o + 12 + k * 4, p.angles[k], true);
    }
    d.setUint16(o + 24, p.model, true);
    d.setUint8(o + 30, p.solid);
    o += 72;
  }
  return new Uint8Array(d.buffer);
}

function ent(index: number, classname: string, kv: Record<string, string>): MapEntity {
  const o = (kv.origin ?? '0 0 0').split(' ').map(Number);
  const a = (kv.angles ?? '0 0 0').split(' ').map(Number);
  return { index, classname, targetname: '', kv: { classname, ...kv }, outputs: [], origin: v3(o[0], o[1], o[2]), angles: qa(a[0], a[1], a[2]), model: -1 };
}

/** The synthetic box world with its static prop lump replaced. */
function boxWorldWithProps(sprp: Uint8Array): BspFile {
  const bsp = parseBsp(buildBoxWorld().buffer);
  bsp.gameLumps.splice(0, bsp.gameLumps.length, { id: 'sprp', flags: 0, version: 10, data: sprp });
  return bsp;
}

describe('buildPropCollision', () => {
  // models/cubes: the two cubes (Source x 0..78.7, y 0..39.4, z -39.4..0), hull box a bit larger
  const files = new Map<string, Uint8Array>([
    ['models/cubes.mdl', fakeMdl([-1, -1, -40.5], [80, 40.5, 1])],
    ['models/cubes.phy', buildPhy([TWO_CUBES])],
    ['models/nophy.mdl', fakeMdl([-10, -20, 0], [10, 20, 100])],
    ['models/notsolid.mdl', fakeMdl([-10, -10, 0], [10, 10, 10], 0)],
    ['models/notsolid.phy', buildPhy([TWO_CUBES])],
  ]);
  const source = { read: (p: string) => files.get(p.toLowerCase()) ?? null };
  const dict = ['models/cubes.mdl', 'models/nophy.mdl', 'models/missing.mdl', 'models/notsolid.mdl'];

  it('places .phy hulls of SOLID_VPHYSICS props, boxes for SOLID_BBOX, nothing for non-solid / hull-less models', () => {
    const bsp = boxWorldWithProps(
      sprpLump(dict, [
        { model: 0, origin: [1000, 2000, 300], angles: [0, 90, 0], solid: 6 }, // 2 pieces, rotated
        { model: 0, origin: [0, 0, 0], angles: [0, 0, 0], solid: 0 }, // not solid
        { model: 1, origin: [0, 0, 0], angles: [0, 0, 0], solid: 6 }, // no collision model: not solid
        { model: 1, origin: [500, 0, 0], angles: [0, 45, 0], solid: 2 }, // world-aligned box of the rotated hull
        { model: 2, origin: [0, 0, 0], angles: [0, 0, 0], solid: 6 }, // model not available
        { model: 3, origin: [0, 0, 0], angles: [0, 0, 0], solid: 6 }, // $contents 0
        { model: 0, origin: [-3000, 0, 50], angles: [20, 33, -10], solid: 6 }, // arbitrary rotation
      ]),
    );
    const warnings: string[] = [];
    const pc = buildPropCollision(bsp, [], [source], { warnings });
    expect(pc.stats.solidProps).toBe(6);
    expect(pc.stats.vphysics).toBe(2);
    expect(pc.stats.boxes).toBe(1);
    expect(pc.stats.noCollisionModel).toBe(1);
    expect(pc.stats.missingModel).toBe(1);
    expect(pc.brushes.length).toBe(2 + 1 + 2);
    expect(pc.brushes.every((b) => b.model === PROP_COLLISION_MODEL && b.contents === CONTENTS_SOLID)).toBe(true);
    expect(warnings.join('\n')).toMatch(/models\/missing\.mdl/);
    expect(warnings.join('\n')).toMatch(/without a collision model.*models\/nophy\.mdl/);
    // yaw 90: model x -> world y, model y -> world -x
    const [a, b] = pc.brushes;
    const lo = v3(Math.min(a.mins.x, b.mins.x), Math.min(a.mins.y, b.mins.y), Math.min(a.mins.z, b.mins.z));
    const hi = v3(Math.max(a.maxs.x, b.maxs.x), Math.max(a.maxs.y, b.maxs.y), Math.max(a.maxs.z, b.maxs.z));
    expect(lo.x).toBeCloseTo(1000 - M, 2);
    expect(hi.x).toBeCloseTo(1000, 2);
    expect(lo.y).toBeCloseTo(2000, 2);
    expect(hi.y).toBeCloseTo(2000 + 2 * M, 2);
    expect(lo.z).toBeCloseTo(300 - M, 2);
    expect(hi.z).toBeCloseTo(300, 2);
    // SOLID_BBOX: hull box [-10,10]x[-20,20]x[0,100] turned 45 degrees -> half extent (10 + 20) / sqrt 2
    const box = pc.brushes[2];
    const h = 30 / Math.SQRT2;
    expect(box.mins.x).toBeCloseTo(500 - h, 3);
    expect(box.maxs.x).toBeCloseTo(500 + h, 3);
    expect(box.mins.y).toBeCloseTo(-h, 3);
    expect(box.maxs.z).toBeCloseTo(100, 3);
    // the player stands on top of the rotated prop and is stopped by its side
    const world = new CollisionWorld(pc.brushes);
    const tr = world.traceBox(v3(1000 - 20, 2000 + 40, 400), v3(1000 - 20, 2000 + 40, 0), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.endpos.z).toBeCloseTo(300 + 1 / 32, 3);
    expect(tr.model).toBe(PROP_COLLISION_MODEL);
    const side = world.traceBox(v3(1100, 2040, 250), v3(900, 2040, 250), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(side.endpos.x).toBeCloseTo(1000 + 16 + 1 / 32, 3);
    expect(side.plane.normal.x).toBeCloseTo(1, 6);
  });

  it('model entities: solid prop_dynamic / prop_physics variants, unless non-solid, disabled or pushaway', () => {
    const bsp = boxWorldWithProps(sprpLump(dict, []));
    const ents = [
      ent(1, 'prop_dynamic', { model: 'models/cubes.mdl', solid: '6', origin: '0 0 100' }),
      ent(2, 'prop_dynamic_override', { model: 'models/cubes.mdl', origin: '0 500 100' }), // no "solid": 6
      ent(3, 'prop_dynamic', { model: 'models/cubes.mdl', solid: '0' }),
      ent(4, 'prop_dynamic', { model: 'models/cubes.mdl', solid: '6', startdisabled: '1' }),
      ent(5, 'prop_physics_multiplayer', { model: 'models/cubes.mdl', physicsmode: '2' }),
      ent(6, 'prop_physics_override', { model: 'models/cubes.mdl', origin: '0 900 0', modelscale: '3' }),
      ent(7, 'prop_dynamic', { model: 'models/nophy.mdl', solid: '2', origin: '2000 0 0', angles: '0 45 0' }),
      ent(8, 'prop_dynamic_ornament', { model: 'models/cubes.mdl', solid: '6' }),
      ent(9, 'func_brush', { model: '*1' }),
    ];
    const list = solidPropPlacements(bsp, ents);
    expect(list.map((p) => p.solid)).toEqual([6, 6, 6, 2]);
    expect(list.every((p) => p.entity && p.scale === 1)).toBe(true); // "modelscale" doesn't scale collision
    const pc = buildPropCollision(bsp, ents, [source]);
    expect(pc.stats.vphysics).toBe(3);
    expect(pc.stats.boxes).toBe(1);
    // entity SOLID_BBOX: world-aligned, not rotated with the entity
    const box = pc.brushes[pc.brushes.length - 1];
    expect(box.mins.x).toBeCloseTo(1990, 4);
    expect(box.maxs.y).toBeCloseTo(20, 4);
  });

  it('prop lighting rays ignore prop hulls while props are built', () => {
    const bsp = boxWorldWithProps(sprpLump(dict, []));
    const calls: string[] = [];
    let solid = true;
    const world = {
      traceRay: () => newTrace(),
      setModelSolid: (m: number, s: boolean) => {
        calls.push(`${m}:${s}`);
        if (m === PROP_COLLISION_MODEL) solid = s;
      },
      isModelSolid: (m: number) => (m === PROP_COLLISION_MODEL ? solid : true),
    };
    buildMapProps(bsp, [], null, new Map(), { world, materials: { extraSources: [source] } });
    expect(calls).toEqual([`${PROP_COLLISION_MODEL}:false`, `${PROP_COLLISION_MODEL}:true`]);
    expect(solid).toBe(true);
  });

  it('reads the studio header fields collision needs', () => {
    const h = readStudioHeader(fakeMdl([-1, -2, -3], [4, 5, 6], 8))!;
    expect(h.hullMin).toEqual({ x: -1, y: -2, z: -3 });
    expect(h.hullMax).toEqual({ x: 4, y: 5, z: 6 });
    expect(h.contents).toBe(8);
    expect(readStudioHeader(new Uint8Array(100))).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------ real maps

function listMaps(env: string | undefined): string[] {
  if (!env || !existsSync(env)) return [];
  if (statSync(env).isFile()) return env.endsWith('.bsp') ? [env] : [];
  return readdirSync(env)
    .filter((f) => f.toLowerCase().endsWith('.bsp'))
    .sort()
    .map((f) => join(env, f));
}

const MAPS = listMaps(process.env.SURF_TEST_MAPS);
const LARGE = listMaps(process.env.SURF_TEST_MAPS_LARGE);
const mapPath = (name: string) => [...MAPS, ...LARGE].find((p) => basename(p, '.bsp').toLowerCase() === name) ?? '';
const quiet = { log: () => {}, gameContent: null };

function readMap(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe.skipIf(MAPS.length + LARGE.length === 0)('real maps: packed collision models', () => {
  it('every packed .phy parses into brushes; hull bounds agree with the .mdl hull boxes', () => {
    let models = 0;
    let inside = 0;
    let exact = 0;
    const mismatches: string[] = [];
    for (const path of [...MAPS, ...LARGE]) {
      const bsp = parseBsp(readMap(path));
      if (!bsp.pakfile) continue;
      const pak = new PakFile(bsp.pakfile);
      for (const f of pak.list()) {
        if (!f.endsWith('.phy')) continue;
        const phy = parsePhy(pak.read(f)!);
        expect(phy, f).toBeTruthy();
        expect(phy!.solids.length, f).toBeGreaterThan(0);
        expect(phy!.warnings, f).toEqual([]);
        const s = phy!.solids[0];
        let brushes = 0;
        for (const c of s.convexes) if (cacheConvex(c)?.brush) brushes++;
        expect(brushes, f).toBeGreaterThanOrEqual(s.convexes.length - 3);
        const mdl = pak.read(f.replace(/\.phy$/, '.mdl'));
        const h = mdl ? readStudioHeader(mdl) : null;
        if (!h) continue;
        models++;
        const tol = 1;
        const ok =
          s.mins.x >= h.hullMin.x - tol &&
          s.mins.y >= h.hullMin.y - tol &&
          s.mins.z >= h.hullMin.z - tol &&
          s.maxs.x <= h.hullMax.x + tol &&
          s.maxs.y <= h.hullMax.y + tol &&
          s.maxs.z <= h.hullMax.z + tol;
        if (ok) inside++;
        else mismatches.push(`${basename(path)} ${f}`);
        const d = [s.mins.x - h.hullMin.x, s.mins.y - h.hullMin.y, s.mins.z - h.hullMin.z, s.maxs.x - h.hullMax.x, s.maxs.y - h.hullMax.y, s.maxs.z - h.hullMax.z];
        if (d.every((x) => Math.abs(x) < 1)) exact++;
      }
    }
    console.log(`[phy] ${models} models with .mdl: ${inside} collision boxes inside the hull box, ${exact} equal to it; outside: ${mismatches.join(', ')}`);
    // the rest are collision meshes deliberately bigger than the visible model (surf_lt_omnific's ramps)
    if (models) {
      expect(inside / models).toBeGreaterThanOrEqual(0.85);
      expect(exact / models).toBeGreaterThan(0.3);
    }
  });

  const mesa = mapPath('surf_mesa_fixed');
  it.skipIf(!mesa)('surf_mesa_fixed: rotated real hulls collide exactly (exact separating-axis reference)', () => {
    const bsp = parseBsp(readMap(mesa));
    const pak = new PakFile(bsp.pakfile!);
    const rnd = mulberry32(3);
    const st: SweepStats = { hits: 0, early: 0, deep: 0, passThrough: 0, worst: 0 };
    for (const f of pak.list()) {
      if (!f.endsWith('.phy')) continue;
      for (const c of parsePhy(pak.read(f)!)!.solids[0].convexes) {
        const cc = cacheConvex(c);
        if (!cc) continue;
        const t = placement(v3(rnd() * 2000 - 1000, rnd() * 2000 - 1000, rnd() * 2000 - 1000), qa(rnd() * 360 - 180, rnd() * 360, rnd() * 360 - 180));
        sweepCheck(c, placeConvex(cc, t, CONTENTS_SOLID)!, t, rnd, 12, st);
      }
    }
    console.log(`[phy] mesa hull sweeps: ${JSON.stringify(st)}`);
    expect(st.hits).toBeGreaterThan(500);
    expect(st.early).toBe(0);
    expect(st.deep).toBe(0);
    expect(st.passThrough).toBe(0);
  });

  const air = mapPath('surf_aircontrol_ksf');
  it.skipIf(!air)('surf_aircontrol_ksf: a SOLID_VPHYSICS model without a .phy is not solid (the boosters fly through it)', async () => {
    const map = await loadBspMap('surf_aircontrol_ksf', readMap(air), undefined, { ...quiet, props: false });
    expect(map.warnings.join('\n')).toMatch(/without a collision model.*course\.mdl/);
    expect(map.collision.brushes.some((b) => b.model === PROP_COLLISION_MODEL)).toBe(false);
    // trigger_push boosters inside course.mdl's hull box (x 9723..13203, y -8714..-3096, z 5922..10760)
    const pushes = map.entities.filter((e) => e.classname === 'trigger_push' && e.model > 0).map((e) => map.models[e.model]);
    const inBox = pushes.filter((m) => {
      const c = v3((m.mins.x + m.maxs.x) / 2, (m.mins.y + m.maxs.y) / 2, (m.mins.z + m.maxs.z) / 2);
      return c.x > 9723 && c.x < 13203 && c.y > -8714 && c.y < -3096 && c.z > 5922 && c.z < 10760;
    });
    expect(inBox.length).toBeGreaterThan(2);
    for (const m of inBox) {
      const c = v3((m.mins.x + m.maxs.x) / 2, (m.mins.y + m.maxs.y) / 2, m.mins.z + 1);
      expect(map.collision.testBox(c, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
    }
  });

  const omni = mapPath('surf_lt_omnific');
  it.skipIf(!omni)('surf_lt_omnific: props collide; prop lighting is unchanged by prop hulls', async () => {
    const withHulls = await loadBspMap('surf_lt_omnific', readMap(omni), undefined, quiet);
    const without = await loadBspMap('surf_lt_omnific', readMap(omni), undefined, { ...quiet, propCollision: false });
    const n = withHulls.collision.brushes.filter((b) => b.model === PROP_COLLISION_MODEL).length;
    expect(n).toBeGreaterThan(3000);
    expect(withHulls.collision.brushes.length).toBe(without.collision.brushes.length + n);
    expect(withHulls.collision.isModelSolid(PROP_COLLISION_MODEL)).toBe(true);
    // the light cache sees the world only: identical prop lighting
    expect(withHulls.render.props?.length).toBe(without.render.props?.length);
    const a = withHulls.render.props ?? [];
    const b = without.render.props ?? [];
    for (let i = 0; i < a.length; i++) expect(a[i].ambientCube).toEqual(b[i].ambientCube);
    // every static prop with SOLID_VPHYSICS is solid at its hull: a ray down onto the props' tops hits them
    let hits = 0;
    const tr = newTrace();
    for (const br of withHulls.collision.brushes) {
      if (br.model !== PROP_COLLISION_MODEL || hits >= 50) continue;
      const c = v3((br.mins.x + br.maxs.x) / 2, (br.mins.y + br.maxs.y) / 2, br.maxs.z + 64);
      withHulls.collision.traceRay(c, v3(c.x, c.y, br.mins.z - 1), MASK_PLAYERSOLID, tr);
      if (tr.fraction < 1 && tr.endpos.z <= br.maxs.z + 0.1 && tr.endpos.z >= br.mins.z - 0.1) hits++;
    }
    expect(hits).toBeGreaterThan(40);
  });
});

/** Standing still / surfing on a loaded map: per-tick checks. */
function inSolid(world: CollisionWorld, ps: PlayerState): boolean {
  const h = playerHull(ps);
  return world.testBox(ps.origin, h.mins, h.maxs, MASK_PLAYERSOLID);
}

interface Ramp {
  c: Vec3;
  n: Vec3;
  area: number;
}

/** Big surfable faces (0.3 <= n.z < 0.7) of the brushes `pick` selects, largest first. */
function rampFaces(world: CollisionWorld, pick: (b: Brush) => boolean, minArea: number): Ramp[] {
  const out: Ramp[] = [];
  for (const br of world.brushes) {
    if (!pick(br) || !(br.contents & MASK_PLAYERSOLID)) continue;
    const ws = brushWindings(br);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      const n = br.sides[i].plane.normal;
      if (w.length < 3 || br.sides[i].bevel || n.z < 0.3 || n.z >= 0.7) continue;
      let A = 0;
      const c = v3();
      for (let k = 1; k + 1 < w.length; k++) {
        const u = v3(w[k].x - w[0].x, w[k].y - w[0].y, w[k].z - w[0].z);
        const q = v3(w[k + 1].x - w[0].x, w[k + 1].y - w[0].y, w[k + 1].z - w[0].z);
        const a = Math.hypot(u.y * q.z - u.z * q.y, u.z * q.x - u.x * q.z, u.x * q.y - u.y * q.x) / 2;
        A += a;
        c.x += (a * (w[0].x + w[k].x + w[k + 1].x)) / 3;
        c.y += (a * (w[0].y + w[k].y + w[k + 1].y)) / 3;
        c.z += (a * (w[0].z + w[k].z + w[k + 1].z)) / 3;
      }
      if (A >= minArea) out.push({ c: v3(c.x / A, c.y / A, c.z / A), n: v3(n.x, n.y, n.z), area: A });
    }
  }
  return out.sort((a, b) => b.area - a.area);
}

interface SurfStats {
  ramps: number;
  ticks: number;
  inSolid: number;
  kills: number;
  stalls: number;
  onRamp: number;
  /** Mean speed change over a run (u/s). */
  meanGain: number;
}

/** Lands on each ramp face and surfs along it (holding into the ramp) for 150 ticks in each direction. */
function surfRamps(world: CollisionWorld, ramps: Ramp[]): SurfStats {
  const vars = defaultMoveVars();
  const tr = newTrace();
  const st: SurfStats = { ramps: 0, ticks: 0, inSolid: 0, kills: 0, stalls: 0, onRamp: 0, meanGain: 0 };
  let runs = 0;
  let gain = 0;
  for (const r of ramps) {
    const start = v3(r.c.x + r.n.x * 60, r.c.y + r.n.y * 60, r.c.z + r.n.z * 60 - 36 * r.n.z);
    world.traceBox(start, v3(start.x - r.n.x * 120, start.y - r.n.y * 120, start.z - r.n.z * 120), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    if (tr.startsolid || tr.fraction >= 1) continue;
    if (Math.abs(tr.plane.normal.x - r.n.x) + Math.abs(tr.plane.normal.y - r.n.y) + Math.abs(tr.plane.normal.z - r.n.z) > 1e-3) continue;
    st.ramps++;
    const land = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
    const tl = Math.hypot(r.n.x, r.n.y);
    const tx = -r.n.y / tl;
    const ty = r.n.x / tl;
    for (const dir of [1, -1]) {
      const ps = createPlayerState(v3(land.x, land.y, land.z));
      ps.moveType = MOVETYPE_WALK;
      ps.velocity = v3(tx * 900 * dir, ty * 900 * dir, 0);
      const cmd = newUserCmd();
      cmd.viewangles.yaw = (Math.atan2(ty * dir, tx * dir) * 180) / Math.PI;
      const yr = (cmd.viewangles.yaw * Math.PI) / 180;
      cmd.sidemove = Math.sin(yr) * -r.n.x - Math.cos(yr) * -r.n.y > 0 ? 450 : -450; // into the ramp
      const ev = newMoveEvents();
      let prevSpeed = 900;
      let prevAir = true;
      let prev = v3(ps.origin.x, ps.origin.y, ps.origin.z);
      for (let i = 0; i < 150; i++) {
        playerMove(ps, cmd, world, vars, 0.01, ev);
        st.ticks++;
        const o = ps.origin;
        if (inSolid(world, ps)) st.inSolid++;
        const speed = Math.hypot(ps.velocity.x, ps.velocity.y, ps.velocity.z);
        const air = !ps.onGround;
        if (air && prevAir && prevSpeed > 100) {
          if (speed < 1) st.kills++;
          if (Math.hypot(o.x - prev.x, o.y - prev.y, o.z - prev.z) < prevSpeed * 0.01 * 0.25) st.stalls++;
        }
        world.traceBox(o, v3(o.x - r.n.x * 2, o.y - r.n.y * 2, o.z - r.n.z * 2), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
        if (tr.fraction < 1 && Math.abs(tr.plane.normal.z - r.n.z) < 0.01) st.onRamp++;
        prevSpeed = speed;
        prevAir = air;
        prev = v3(o.x, o.y, o.z);
      }
      runs++;
      gain += prevSpeed - 900;
    }
  }
  st.meanGain = gain / Math.max(1, runs);
  return st;
}

const summer = mapPath('surf_summer_ksf');
describe.skipIf(!summer)('surf_summer_ksf (SURF_TEST_MAPS_LARGE): prop-built start room and ramps', () => {
  let map: LoadedMap;
  const load = async () => {
    if (!map) map = await loadBspMap('surf_summer_ksf', readMap(summer), undefined, { ...quiet, props: false });
    return map;
  };

  it('the start room floor is a prop: a player at the spawn lands on it and stands there', async () => {
    const m = await load();
    const world = m.collision;
    const spawn = v3(-13056, -5056, 12208.5);
    const tr = world.traceBox(spawn, v3(spawn.x, spawn.y, spawn.z - 4096), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.endpos.z).toBeCloseTo(12064 + 1 / 32, 2); // shack_floor.mdl at z 12064
    expect(tr.model).toBe(PROP_COLLISION_MODEL);
    expect(tr.plane.normal.z).toBeCloseTo(1, 6);
    // the trigger_teleport under the room (z 11232..11296) that used to catch the falling player
    const teles = m.entities
      .filter((e) => e.classname === 'trigger_teleport' && e.model > 0)
      .map((e) => m.models[e.model])
      .filter((b) => b.mins.x < spawn.x && b.maxs.x > spawn.x && b.mins.y < spawn.y && b.maxs.y > spawn.y && b.maxs.z < spawn.z);
    expect(teles.some((b) => b.mins.z === 11232)).toBe(true);
    const vars = defaultMoveVars();
    const ps = createPlayerState(spawn, qa(0, 90, 0));
    expect(unstuckPlayer(ps, world)).toBe(true);
    categorizePosition(ps, world, vars);
    const ev = newMoveEvents();
    const cmd = newUserCmd();
    let minZ = Infinity;
    let touches = 0;
    let ground = 0;
    for (let i = 0; i < 400; i++) {
      playerMove(ps, cmd, world, vars, 0.01, ev);
      minZ = Math.min(minZ, ps.origin.z);
      if (ps.onGround) ground++;
      const lo = v3(ps.origin.x + HULL_MINS.x, ps.origin.y + HULL_MINS.y, ps.origin.z + HULL_MINS.z);
      const hi = v3(ps.origin.x + HULL_MAXS.x, ps.origin.y + HULL_MAXS.y, ps.origin.z + HULL_MAXS.z);
      for (const t of teles) for (const b of t.brushes) if (boxIntersectsBrush(lo, hi, b)) touches++;
    }
    expect(minZ).toBeGreaterThan(12063.9);
    expect(ps.origin.z).toBeLessThan(12066);
    expect(ps.onGround).toBe(true);
    expect(ps.groundModel).toBe(0); // static props belong to the world
    expect(ground).toBeGreaterThan(300); // ~0.4 s falling from the spawn height first
    expect(touches).toBe(0);
    expect(inSolid(world, ps)).toBe(false);
  });

  it('the prop-built ramps are surfable like the brush ramps', async () => {
    const m = await load();
    const props = surfRamps(m.collision, rampFaces(m.collision, (b) => b.model === PROP_COLLISION_MODEL, 128 * 128).slice(0, 50));
    const brushes = surfRamps(m.collision, rampFaces(m.collision, (b) => b.model === 0, 128 * 128).slice(0, 50));
    console.log(`[phy] summer surf: props ${JSON.stringify(props)}; brush ramps ${JSON.stringify(brushes)}`);
    expect(props.ramps).toBeGreaterThan(25);
    expect(props.inSolid).toBe(0);
    expect(props.kills).toBe(0);
    // stalls: running into a wall at the end of a ramp (the brush ramps have them too)
    expect(props.stalls / props.ramps).toBeLessThanOrEqual(brushes.stalls / brushes.ramps + 0.05);
    expect(props.onRamp).toBeGreaterThan(props.ticks * 0.15);
    // speed over a run: gravity and the ramp's end make it vary, but not differently from brush ramps
    expect(props.meanGain).toBeGreaterThan(brushes.meanGain - 150);
  });
});
