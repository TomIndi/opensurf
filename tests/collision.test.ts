import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vec3, v3 } from '../src/core/vec3';
import {
  addBrushBevels,
  brushFromBox,
  brushFromPlanes,
  brushFromPoints,
  brushWindings,
  computeBrushBounds,
} from '../src/physics/brushbuild';
import { CollisionWorld, boxIntersectsBrush } from '../src/physics/collision';
import {
  Brush,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  CONTENTS_WINDOW,
  DIST_EPSILON,
  MASK_ALL,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  MASK_WATER,
  Plane,
  newTrace,
} from '../src/physics/types';
import { HULL_MAXS, HULL_MINS } from '../src/physics/playertypes';
import { readBspBrushes } from './helpers/collision_bsp';
import { boxBrushGap, hullRef, mulberry32, planeDepth, slideMove, sweptGap, worldDepth } from './helpers/collision_ref';

const MINS = v3(HULL_MINS.x, HULL_MINS.y, HULL_MINS.z);
const MAXS = v3(HULL_MAXS.x, HULL_MAXS.y, HULL_MAXS.z);
const HALF = v3(16, 16, 36);
const ZERO = v3(0, 0, 0);

function rotZ(p: Vec3, deg: number, t: Vec3 = ZERO): Vec3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return v3(p.x * c - p.y * s + t.x, p.x * s + p.y * c + t.y, p.z + t.z);
}

/** Triangular ramp prism along X from x0 to x1: cross-section (y=0,z=0) (y=L,z=0) (y=0,z=H); slope faces +y+z. */
function rampPoints(x0: number, x1: number, L: number, H: number, zBase = 0): Vec3[] {
  return [
    v3(x0, 0, zBase),
    v3(x0, L, zBase),
    v3(x0, 0, zBase + H),
    v3(x1, 0, zBase),
    v3(x1, L, zBase),
    v3(x1, 0, zBase + H),
  ];
}

function newell(w: Vec3[]): Vec3 {
  const n = v3();
  for (let i = 0; i < w.length; i++) {
    const a = w[i];
    const b = w[(i + 1) % w.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n;
}

function allVerts(b: Brush): Vec3[] {
  return brushWindings(b).flat();
}

function realSides(b: Brush) {
  return b.sides.filter((s) => !s.bevel);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function center(mins: Vec3, maxs: Vec3, at: Vec3): Vec3 {
  return v3(at.x + (mins.x + maxs.x) / 2, at.y + (mins.y + maxs.y) / 2, at.z + (mins.z + maxs.z) / 2);
}

function randomHull(rnd: () => number, c: Vec3, size: number, count = 10): Brush | null {
  const pts: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    pts.push(v3(c.x + (rnd() - 0.5) * size, c.y + (rnd() - 0.5) * size, c.z + (rnd() - 0.5) * size));
  }
  return brushFromPoints(pts, CONTENTS_SOLID);
}

// =====================================================================================================
describe('brushbuild: boxes, windings, bounds', () => {
  it('brushFromBox makes six axial sides in -x +x -y +y -z +z order', () => {
    const b = brushFromBox(v3(10, 20, 30), v3(-10, 40, 50), CONTENTS_SOLID, 3);
    expect(b.model).toBe(3);
    expect(b.mins).toEqual(v3(-10, 20, 30));
    expect(b.maxs).toEqual(v3(10, 40, 50));
    const ns = b.sides.map((s) => [s.plane.normal.x, s.plane.normal.y, s.plane.normal.z, s.plane.dist]);
    expect(ns).toEqual([
      [-1, 0, 0, 10],
      [1, 0, 0, 10],
      [0, -1, 0, -20],
      [0, 1, 0, 40],
      [0, 0, -1, -30],
      [0, 0, 1, 50],
    ]);
    expect(b.sides.every((s) => !s.bevel)).toBe(true);
  });

  it('box windings: 4 exact corners per face, on-plane, CCW seen from outside', () => {
    const b = brushFromBox(v3(-8, -16, 0), v3(8, 16, 64), CONTENTS_SOLID);
    const ws = brushWindings(b);
    expect(ws.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      const w = ws[i];
      const p = b.sides[i].plane;
      expect(w.length).toBe(4);
      for (const v of w) {
        expect(dot(v, p.normal) - p.dist).toBe(0);
        expect([-8, 8]).toContain(v.x);
        expect([-16, 16]).toContain(v.y);
        expect([0, 64]).toContain(v.z);
      }
      const nw = newell(w);
      expect(dot(nw, p.normal)).toBeGreaterThan(0);
    }
  });

  it('windings of a sloped prism are CCW from outside and lie inside every other plane', () => {
    const b = brushFromPoints(rampPoints(0, 512, 256, 443), CONTENTS_SOLID)!;
    expect(b).not.toBeNull();
    const ws = brushWindings(b);
    let faces = 0;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (b.sides[i].bevel) {
        expect(w).toEqual([]);
        continue;
      }
      faces++;
      expect(w.length).toBeGreaterThanOrEqual(3);
      const nw = newell(w);
      const len = Math.hypot(nw.x, nw.y, nw.z);
      expect(dot(nw, b.sides[i].plane.normal) / len).toBeCloseTo(1, 9);
      for (const v of w) {
        for (const s of realSides(b)) expect(dot(v, s.plane.normal) - s.plane.dist).toBeLessThan(1e-6);
      }
    }
    expect(faces).toBe(5);
  });

  it('computeBrushBounds: tight AABB; false for open, empty and flat plane sets', () => {
    const b = brushFromPoints(rampPoints(0, 512, 256, 443), CONTENTS_SOLID)!;
    b.mins = v3(-1e9, 0, 0);
    expect(computeBrushBounds(b)).toBe(true);
    expect(b.mins.x).toBeCloseTo(0, 9);
    expect(b.mins.y).toBeCloseTo(0, 9);
    expect(b.mins.z).toBeCloseTo(0, 9);
    expect(b.maxs.x).toBeCloseTo(512, 9);
    expect(b.maxs.y).toBeCloseTo(256, 9);
    expect(b.maxs.z).toBeCloseTo(443, 9);

    const mk = (planes: [number, number, number, number][]): Brush => ({
      sides: planes.map(([x, y, z, d]) => ({ plane: { normal: v3(x, y, z), dist: d }, bevel: false })),
      contents: 1,
      mins: v3(),
      maxs: v3(),
      model: 0,
    });
    // open: missing the -z side
    expect(computeBrushBounds(mk([[1, 0, 0, 10], [-1, 0, 0, 10], [0, 1, 0, 10], [0, -1, 0, 10], [0, 0, 1, 10]]))).toBe(false);
    // empty: x <= -5 and x >= 5
    expect(computeBrushBounds(mk([[1, 0, 0, -5], [-1, 0, 0, -5], [0, 1, 0, 10], [0, -1, 0, 10], [0, 0, 1, 10], [0, 0, -1, 10]]))).toBe(false);
    // flat: z <= 0 and z >= 0
    expect(computeBrushBounds(mk([[1, 0, 0, 5], [-1, 0, 0, 5], [0, 1, 0, 10], [0, -1, 0, 10], [0, 0, 1, 0], [0, 0, -1, 0]]))).toBe(false);
    // bevel-only sides don't make a volume
    const bev = mk([[1, 0, 0, 5], [-1, 0, 0, 5], [0, 1, 0, 10], [0, -1, 0, 10], [0, 0, 1, 1], [0, 0, -1, 1]]);
    for (const s of bev.sides) s.bevel = true;
    expect(computeBrushBounds(bev)).toBe(false);
    expect(brushWindings(bev).every((w) => w.length === 0)).toBe(true);
  });

  it('duplicate sides get an empty winding', () => {
    const b = brushFromBox(v3(0, 0, 0), v3(10, 10, 10), 1);
    b.sides.push({ plane: { normal: v3(0, 0, 1), dist: 10 }, bevel: false });
    const ws = brushWindings(b);
    expect(ws[5].length).toBe(4);
    expect(ws[6]).toEqual([]);
    expect(computeBrushBounds(b)).toBe(true);
  });
});

// =====================================================================================================
describe('brushbuild: planes, bevels, hulls', () => {
  it('brushFromPlanes drops non-touching planes and adds bevels + bounds', () => {
    const planes: Plane[] = [
      { normal: v3(1, 0, 0), dist: 10 },
      { normal: v3(-1, 0, 0), dist: 10 },
      { normal: v3(0, 1, 0), dist: 10 },
      { normal: v3(0, -1, 0), dist: 10 },
      { normal: v3(0, 0, 2), dist: 20 }, // non-unit normal: z <= 10
      { normal: v3(0, 0, -1), dist: 10 },
      { normal: v3(1, 1, 0), dist: 1000 }, // far outside: dropped
    ];
    const b = brushFromPlanes(planes, CONTENTS_SOLID, 7)!;
    expect(b).not.toBeNull();
    expect(b.model).toBe(7);
    expect(b.sides.length).toBe(6);
    expect(b.sides[5].plane.normal).toEqual(v3(0, 0, 1));
    expect(b.sides[5].plane.dist).toBe(10);
    expect(b.mins).toEqual(v3(-10, -10, -10));
    expect(b.maxs).toEqual(v3(10, 10, 10));
    expect(brushFromPlanes(planes.slice(0, 5), 1)).toBeNull(); // open
  });

  it('rotated box: axial bevels at the AABB, edge bevels are supporting planes, all marked bevel', () => {
    const pts: Vec3[] = [];
    for (const x of [-32, 32]) for (const y of [-64, 64]) for (const z of [0, 50]) pts.push(rotZ(v3(x, y, z), 30, v3(100, 200, 0)));
    const b = brushFromPoints(pts, CONTENTS_SOLID)!;
    expect(b).not.toBeNull();
    expect(realSides(b).length).toBe(6);
    // first six are axial in -x +x -y +y -z +z order
    const axial = [v3(-1, 0, 0), v3(1, 0, 0), v3(0, -1, 0), v3(0, 1, 0), v3(0, 0, -1), v3(0, 0, 1)];
    for (let i = 0; i < 6; i++) expect(b.sides[i].plane.normal).toEqual(axial[i]);
    expect(b.sides[0].bevel && b.sides[1].bevel && b.sides[2].bevel && b.sides[3].bevel).toBe(true);
    expect(b.sides[4].bevel || b.sides[5].bevel).toBe(false); // top/bottom are real faces
    expect(b.sides[1].plane.dist).toBeCloseTo(b.maxs.x, 9);
    expect(b.sides[0].plane.dist).toBeCloseTo(-b.mins.x, 9);
    const verts = allVerts(b);
    for (const s of b.sides) {
      const ds = verts.map((v) => dot(v, s.plane.normal) - s.plane.dist);
      expect(Math.max(...ds)).toBeLessThan(1e-6); // supporting: nothing in front
      expect(Math.max(...ds)).toBeGreaterThan(-1e-6); // and touching
    }
    // no duplicate normals
    for (let i = 0; i < b.sides.length; i++)
      for (let j = i + 1; j < b.sides.length; j++) {
        const a = b.sides[i].plane.normal;
        const c = b.sides[j].plane.normal;
        expect(Math.abs(a.x - c.x) + Math.abs(a.y - c.y) + Math.abs(a.z - c.z)).toBeGreaterThan(1e-6);
      }
  });

  it('ramp prism: real slope normal z ~ 0.5, bevels supporting, addBrushBevels idempotent', () => {
    const b = brushFromPoints(rampPoints(0, 512, 256, 443), CONTENTS_SOLID)!;
    const slope = realSides(b).find((s) => s.plane.normal.y > 0.1 && s.plane.normal.z > 0.1)!;
    expect(slope.plane.normal.z).toBeCloseTo(256 / Math.hypot(256, 443), 12);
    expect(slope.plane.normal.y).toBeCloseTo(443 / Math.hypot(256, 443), 12);
    expect(slope.plane.normal.x).toBe(0);
    const before = JSON.stringify(b.sides);
    addBrushBevels(b);
    expect(JSON.stringify(b.sides)).toBe(before);
    addBrushBevels(b);
    expect(JSON.stringify(b.sides)).toBe(before);
  });

  it('addBrushBevels on a raw plane brush: idempotent and reorders axial first', () => {
    const n = (x: number, y: number, z: number) => {
      const l = Math.hypot(x, y, z);
      return v3(x / l, y / l, z / l);
    };
    const b: Brush = {
      sides: [
        { plane: { normal: n(1, 1, 1), dist: 50 }, bevel: false },
        { plane: { normal: v3(0, 0, -1), dist: 0 }, bevel: false },
        { plane: { normal: v3(-1, 0, 0), dist: 0 }, bevel: false },
        { plane: { normal: v3(0, -1, 0), dist: 0 }, bevel: false },
      ],
      contents: 1,
      mins: v3(),
      maxs: v3(),
      model: 0,
    };
    expect(computeBrushBounds(b)).toBe(true); // tetrahedron corner
    addBrushBevels(b);
    expect(b.sides[0].plane.normal).toEqual(v3(-1, 0, 0));
    expect(b.sides[0].bevel).toBe(false);
    expect(b.sides[1].plane.normal).toEqual(v3(1, 0, 0));
    expect(b.sides[1].bevel).toBe(true);
    expect(b.sides[1].plane.dist).toBeCloseTo(50 * Math.sqrt(3), 9);
    expect(b.sides[4].plane.normal).toEqual(v3(0, 0, -1));
    const snap = JSON.stringify(b.sides);
    addBrushBevels(b);
    expect(JSON.stringify(b.sides)).toBe(snap);
    expect(b.sides.filter((s) => !s.bevel).length).toBe(4);
    // degenerate brush: untouched
    const open: Brush = { sides: b.sides.slice(0, 2), contents: 1, mins: v3(), maxs: v3(), model: 0 };
    const openSnap = JSON.stringify(open.sides);
    addBrushBevels(open);
    expect(JSON.stringify(open.sides)).toBe(openSnap);
  });

  it('hull of a cube with interior and duplicate points', () => {
    const pts: Vec3[] = [];
    for (const x of [0, 64]) for (const y of [0, 64]) for (const z of [0, 64]) pts.push(v3(x, y, z));
    // interior, exact and near duplicates (merged), on-face points
    pts.push(v3(32, 32, 32), v3(10, 50, 20), v3(64, 64, 64), v3(64, 64, 64.00001), v3(32, 32, 64), v3(0, 32, 32));
    const b = brushFromPoints(pts, CONTENTS_SOLID)!;
    expect(b.sides.length).toBe(6);
    expect(b.sides.every((s) => !s.bevel)).toBe(true);
    expect(b.mins).toEqual(v3(0, 0, 0));
    expect(b.maxs).toEqual(v3(64, 64, 64));
    expect(new Set(b.sides.map((s) => JSON.stringify(s.plane.normal))).size).toBe(6);
  });

  it('hull of a prism and a tetrahedron', () => {
    expect(realSides(brushFromPoints(rampPoints(0, 100, 50, 80), 1)!).length).toBe(5);
    const t = brushFromPoints([v3(0, 0, 0), v3(100, 0, 0), v3(0, 100, 0), v3(0, 0, 100)], 1)!;
    expect(realSides(t).length).toBe(4);
    expect(t.mins).toEqual(v3(0, 0, 0));
    expect(t.maxs.x).toBeCloseTo(100, 9);
  });

  it('large point clouds: iterative hull refinement matches the cloud', () => {
    const rnd = mulberry32(4321);
    for (const n of [60, 150, 600]) {
      const pts: Vec3[] = [];
      for (let i = 0; i < n; i++) {
        // mostly interior points plus a few dozen on an ellipsoid-ish shell
        const u = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
        const l = Math.hypot(u.x, u.y, u.z);
        const r = i % 10 === 0 ? 1 : rnd() * 0.8;
        pts.push(v3(1000 + (u.x / l) * r * 300, -500 + (u.y / l) * r * 200, 64 + (u.z / l) * r * 120));
      }
      const t0 = performance.now();
      const b = brushFromPoints(pts, 1)!;
      const ms = performance.now() - t0;
      expect(b).not.toBeNull();
      expect(ms).toBeLessThan(5000);
      const verts = allVerts(b);
      for (const s of realSides(b)) {
        for (const p of pts) expect(dot(p, s.plane.normal) - s.plane.dist).toBeLessThan(1e-6);
      }
      for (let k = 0; k < 50; k++) {
        const u = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
        const hp = Math.max(...pts.map((p) => dot(p, u)));
        const hv = Math.max(...verts.map((p) => dot(p, u)));
        expect(Math.abs(hp - hv)).toBeLessThan(0.05);
      }
    }
  });

  it('degenerate hulls return null', () => {
    expect(brushFromPoints([v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0)], 1)).toBeNull();
    expect(brushFromPoints([v3(0, 0, 0), v3(10, 0, 0), v3(0, 10, 0), v3(10, 10, 0), v3(5, 5, 0)], 1)).toBeNull(); // coplanar
    expect(brushFromPoints([v3(0, 0, 0), v3(10, 0, 0), v3(20, 0, 0), v3(30, 0, 0)], 1)).toBeNull(); // collinear
    expect(brushFromPoints([v3(0, 0, 0), v3(0, 0, 0), v3(0, 0, 0), v3(0, 0, 0)], 1)).toBeNull();
  });

  it('hulls of random point clouds contain every point and reach the extreme points', () => {
    const rnd = mulberry32(1234);
    for (let iter = 0; iter < 60; iter++) {
      const n = 4 + Math.floor(rnd() * 40);
      const pts: Vec3[] = [];
      const c = v3((rnd() - 0.5) * 8000, (rnd() - 0.5) * 8000, (rnd() - 0.5) * 8000);
      const sx = 1 + rnd() * 300;
      const sy = 1 + rnd() * 300;
      const sz = 1 + rnd() * 300;
      for (let i = 0; i < n; i++) pts.push(v3(c.x + (rnd() - 0.5) * sx, c.y + (rnd() - 0.5) * sy, c.z + (rnd() - 0.5) * sz));
      const b = brushFromPoints(pts, 1)!;
      expect(b).not.toBeNull();
      const real = realSides(b);
      expect(real.length).toBeGreaterThanOrEqual(4);
      for (const s of real) {
        let onPlane = 0;
        for (const p of pts) {
          const d = dot(p, s.plane.normal) - s.plane.dist;
          expect(d).toBeLessThan(1e-6);
          if (d > -0.011) onPlane++;
        }
        expect(onPlane).toBeGreaterThanOrEqual(3);
      }
      const verts = allVerts(b);
      for (let k = 0; k < 30; k++) {
        const u = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
        const l = Math.hypot(u.x, u.y, u.z);
        u.x /= l;
        u.y /= l;
        u.z /= l;
        const hp = Math.max(...pts.map((p) => dot(p, u)));
        const hv = Math.max(...verts.map((p) => dot(p, u)));
        expect(Math.abs(hp - hv)).toBeLessThan(0.05);
      }
      // AABB from windings matches the points' AABB
      expect(b.mins.x).toBeCloseTo(Math.min(...pts.map((p) => p.x)), 1);
      expect(b.maxs.z).toBeCloseTo(Math.max(...pts.map((p) => p.z)), 1);
      // every side is a supporting plane (winding vertices may poke out by the 0.01 clip ON-epsilon)
      for (const s of b.sides) {
        const m = Math.max(...verts.map((v) => dot(v, s.plane.normal) - s.plane.dist));
        expect(m).toBeLessThan(0.0101);
        expect(m).toBeGreaterThan(-0.02);
      }
    }
  });
});

// =====================================================================================================
describe('CollisionWorld: box traces', () => {
  const block = brushFromBox(v3(100, -50, -50), v3(200, 50, 150), CONTENTS_SOLID);
  const world = new CollisionWorld([block]);

  it('hits each face exactly DIST_EPSILON short, reporting the original plane', () => {
    const cases: { start: Vec3; end: Vec3; normal: Vec3; dist: number; check: (e: Vec3) => void }[] = [
      { start: v3(0, 0, 0), end: v3(300, 0, 0), normal: v3(-1, 0, 0), dist: -100, check: (e) => expect(e.x).toBeCloseTo(100 - 16 - DIST_EPSILON, 10) },
      { start: v3(300, 0, 0), end: v3(0, 0, 0), normal: v3(1, 0, 0), dist: 200, check: (e) => expect(e.x).toBeCloseTo(200 + 16 + DIST_EPSILON, 10) },
      { start: v3(150, -200, 0), end: v3(150, 200, 0), normal: v3(0, -1, 0), dist: 50, check: (e) => expect(e.y).toBeCloseTo(-50 - 16 - DIST_EPSILON, 10) },
      { start: v3(150, 200, 0), end: v3(150, -200, 0), normal: v3(0, 1, 0), dist: 50, check: (e) => expect(e.y).toBeCloseTo(50 + 16 + DIST_EPSILON, 10) },
      { start: v3(150, 0, -300), end: v3(150, 0, 300), normal: v3(0, 0, -1), dist: 50, check: (e) => expect(e.z).toBeCloseTo(-50 - 72 - DIST_EPSILON, 10) },
      { start: v3(150, 0, 300), end: v3(150, 0, -300), normal: v3(0, 0, 1), dist: 150, check: (e) => expect(e.z).toBeCloseTo(150 + DIST_EPSILON, 10) },
    ];
    for (const c of cases) {
      const tr = world.traceBox(c.start, c.end, MINS, MAXS, MASK_PLAYERSOLID);
      expect(tr.fraction).toBeGreaterThan(0);
      expect(tr.fraction).toBeLessThan(1);
      expect(tr.startsolid).toBe(false);
      expect(tr.allsolid).toBe(false);
      expect(tr.plane.normal).toEqual(c.normal);
      expect(tr.plane.dist).toBe(c.dist);
      expect(tr.contents).toBe(CONTENTS_SOLID);
      expect(tr.model).toBe(0);
      c.check(tr.endpos);
      // endpos lies on the segment
      const f = tr.fraction;
      expect(tr.endpos.x).toBeCloseTo(c.start.x + f * (c.end.x - c.start.x), 9);
      expect(tr.endpos.y).toBeCloseTo(c.start.y + f * (c.end.y - c.start.y), 9);
      expect(tr.endpos.z).toBeCloseTo(c.start.z + f * (c.end.z - c.start.z), 9);
      // and is clear of the brush
      expect(world.testBox(tr.endpos, MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
    }
  });

  it('fraction formula matches (d1 - eps) / (d1 - d2)', () => {
    const tr = world.traceBox(v3(0, 0, 0), v3(300, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBeCloseTo((84 - DIST_EPSILON) / 300, 14);
  });

  it('misses when passing beside, ends exactly at end, clean result object', () => {
    const out = newTrace();
    out.startsolid = true;
    out.contents = 99;
    const tr = world.traceBox(v3(0, 100, 0), v3(300, 100, 0), MINS, MAXS, MASK_PLAYERSOLID, out);
    expect(tr).toBe(out);
    expect(tr.fraction).toBe(1);
    expect(tr.endpos).toEqual(v3(300, 100, 0));
    expect(tr.startsolid).toBe(false);
    expect(tr.contents).toBe(0);
    expect(tr.model).toBe(-1);
    expect(world.lastHitBrush).toBe(-1);
  });

  it('ending within DIST_EPSILON of a face pulls back to the epsilon shell', () => {
    // box face would end 0.01 short of the brush face
    const tr = world.traceBox(v3(0, 0, 0), v3(100 - 16 - 0.01, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.endpos.x).toBeCloseTo(100 - 16 - DIST_EPSILON, 10);
    // ending further than DIST_EPSILON away: no hit
    const tr2 = world.traceBox(v3(0, 0, 0), v3(100 - 16 - 0.04, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr2.fraction).toBe(1);
  });

  it('starting on the epsilon shell and moving in: fraction 0', () => {
    const p = v3(100 - 16 - DIST_EPSILON, 0, 0);
    const tr = world.traceBox(p, v3(150, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBe(0);
    expect(tr.startsolid).toBe(false);
    expect(tr.endpos).toEqual(p);
    expect(tr.plane.normal).toEqual(v3(-1, 0, 0));
    // starting a hair inside the shell (but outside the brush): still fraction 0, not startsolid
    const p2 = v3(100 - 16 - 0.001, 0, 0);
    const tr2 = world.traceBox(p2, v3(150, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr2.fraction).toBe(0);
    expect(tr2.startsolid).toBe(false);
    // moving away from the shell: free
    const tr3 = world.traceBox(p, v3(0, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr3.fraction).toBe(1);
  });

  it('startsolid / allsolid semantics', () => {
    // start inside, end outside
    const a = world.traceBox(v3(150, 0, 0), v3(400, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(a.startsolid).toBe(true);
    expect(a.allsolid).toBe(false);
    expect(a.fraction).toBe(1);
    expect(a.contents).toBe(CONTENTS_SOLID);
    expect(a.model).toBe(0);
    // start and end inside
    const b = world.traceBox(v3(150, 0, 0), v3(160, 10, 20), MINS, MAXS, MASK_PLAYERSOLID);
    expect(b.startsolid).toBe(true);
    expect(b.allsolid).toBe(true);
    expect(b.fraction).toBe(0);
    expect(b.endpos).toEqual(v3(150, 0, 0));
    // exactly touching counts as solid (Source semantics)
    const touch = v3(100 - 16, 0, 0);
    const c = world.traceBox(touch, touch, MINS, MAXS, MASK_PLAYERSOLID);
    expect(c.startsolid).toBe(true);
    expect(world.testBox(touch, MINS, MAXS, MASK_PLAYERSOLID)).toBe(true);
    // start inside one brush, hit another
    const w2 = new CollisionWorld([block, brushFromBox(v3(300, -50, -50), v3(400, 50, 150), CONTENTS_WINDOW, 2)]);
    const d = w2.traceBox(v3(150, 0, 0), v3(500, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(d.startsolid).toBe(true);
    expect(d.allsolid).toBe(false);
    expect(d.fraction).toBeCloseTo((300 - 16 - DIST_EPSILON - 150) / 350, 12);
    expect(d.contents).toBe(CONTENTS_WINDOW);
    expect(d.model).toBe(2);
  });

  it('out may alias the inputs (tr.endpos as the next start)', () => {
    const tr = newTrace();
    tr.endpos.x = 0;
    world.traceBox(tr.endpos, v3(300, 0, 0), MINS, MAXS, MASK_PLAYERSOLID, tr);
    expect(tr.endpos.x).toBeCloseTo(100 - 16 - DIST_EPSILON, 10);
    const f = tr.fraction;
    // continue from the endpos into the wall: fraction 0, endpos unchanged
    world.traceBox(tr.endpos, v3(300, 0, 0), MINS, MAXS, MASK_PLAYERSOLID, tr);
    expect(tr.fraction).toBe(0);
    expect(tr.endpos.x).toBeCloseTo(100 - 16 - DIST_EPSILON, 10);
    expect(f).toBeGreaterThan(0);
    // end aliasing out.endpos
    const tr2 = newTrace();
    tr2.endpos.x = 300;
    world.traceBox(v3(0, 0, 0), tr2.endpos, MINS, MAXS, MASK_PLAYERSOLID, tr2);
    expect(tr2.endpos.x).toBeCloseTo(100 - 16 - DIST_EPSILON, 10);
  });

  it('exact epsilon placement holds at extreme coordinates', () => {
    for (const base of [v3(15000, -15000, 15000), v3(-16000.5, 16000.25, -15999.75)]) {
      const b = brushFromBox(v3(base.x, base.y - 50, base.z - 50), v3(base.x + 100, base.y + 50, base.z + 150), CONTENTS_SOLID);
      const w = new CollisionWorld([b]);
      const tr = w.traceBox(v3(base.x - 300, base.y, base.z), v3(base.x + 50, base.y, base.z), MINS, MAXS, MASK_PLAYERSOLID);
      expect(tr.endpos.x).toBeCloseTo(base.x - 16 - DIST_EPSILON, 9);
      // sliding along the face from there never re-hits it
      for (let i = 0; i < 100; i++) {
        const p = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
        const r = w.traceBox(p, v3(p.x, p.y + 7.3, p.z + 1.1), MINS, MAXS, MASK_PLAYERSOLID, tr);
        expect(r.fraction).toBe(1);
      }
    }
  });

  it('Source corner shaving: grazing a corner shallower than DIST_EPSILON is not a hit', () => {
    const box = brushFromBox(v3(0, 0, 0), v3(100, 100, 100), CONTENTS_SOLID);
    const w1 = new CollisionWorld([box]);
    // the ray enters through x=0 while leaving the top plane at a grazing angle: inside for x in [0, 6.67]
    // but never deeper than 0.01 units
    const s0 = v3(-10, 50, 99.99);
    const e0 = v3(10, 50, 100.002);
    expect(w1.pointContents(v3(3, 50, 99.995))).toBe(CONTENTS_SOLID);
    const r = w1.traceRay(s0, e0, MASK_ALL);
    expect(r.fraction).toBe(1);
    expect(r.startsolid).toBe(false);
    // a slightly deeper cut (deeper than DIST_EPSILON) is a hit
    const r2 = w1.traceRay(v3(-10, 50, 99.9), v3(10, 50, 100.002), MASK_ALL);
    expect(r2.fraction).toBeLessThan(1);
    expect(r2.plane.normal).toEqual(v3(-1, 0, 0));
    // if another brush stops the ray inside the shaved sliver, the endpos is (shallowly) inside the box
    const wall = brushFromBox(v3(5, 0, 0), v3(6, 100, 200), CONTENTS_SOLID);
    const w2 = new CollisionWorld([box, wall]);
    const r3 = w2.traceRay(s0, e0, MASK_ALL);
    expect(r3.fraction).toBeLessThan(1);
    expect(r3.endpos.x).toBeCloseTo(5 - DIST_EPSILON, 9);
    expect(w2.testBox(r3.endpos, ZERO, ZERO, MASK_ALL)).toBe(true);
    const depth = planeDepth(box, r3.endpos, ZERO, ZERO);
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThanOrEqual(DIST_EPSILON);
    // the next trace starts solid in the box and ignores it (only allsolid would stop it)
    const r4 = w2.traceRay(r3.endpos, v3(r3.endpos.x - 20, 50, 100.5), MASK_ALL);
    expect(r4.startsolid).toBe(true);
    expect(r4.allsolid).toBe(false);
    expect(r4.fraction).toBe(1);
  });

  it('zero-length traces report startsolid only when overlapping', () => {
    const p = v3(0, 0, 0);
    const tr = world.traceBox(p, p, MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBe(1);
    expect(tr.startsolid).toBe(false);
  });

  it('diagonal hit onto an edge region: box traces collide with the Minkowski corner', () => {
    // moving diagonally toward the +x+y vertical edge of the block
    const tr = world.traceBox(v3(300, 150, 0), v3(150, 0, 0), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBeLessThan(1);
    const c = center(MINS, MAXS, tr.endpos);
    expect(boxBrushGap(c, HALF, hullRef(block))).toBeGreaterThan(0);
    expect(boxBrushGap(c, HALF, hullRef(block))).toBeLessThan(DIST_EPSILON + 1e-9);
  });
});

// =====================================================================================================
describe('CollisionWorld: rays and bevels', () => {
  it('ray traces ignore bevel planes, box traces use them', () => {
    // 100^3 box with a bogus "bevel" that cuts away x > 150. Rays must ignore it, boxes must not.
    const b = brushFromBox(v3(100, 100, 0), v3(200, 200, 100), CONTENTS_SOLID);
    b.sides.push({ plane: { normal: v3(1, 0, 0), dist: 150 }, bevel: true });
    const w = new CollisionWorld([b]);
    const ray = w.traceRay(v3(175, 150, 500), v3(175, 150, -500), MASK_ALL);
    expect(ray.fraction).toBeLessThan(1);
    expect(ray.endpos.z).toBeCloseTo(100 + DIST_EPSILON, 9);
    const tiny = v3(-0.5, -0.5, -0.5);
    const tinyMax = v3(0.5, 0.5, 0.5);
    const box = w.traceBox(v3(175, 150, 500), v3(175, 150, -500), tiny, tinyMax, MASK_ALL);
    expect(box.fraction).toBe(1);
    // boxes with tiny extents are rays (Source Ray_t: extents^2 < 1e-6)
    const almostPoint = w.traceBox(v3(175, 150, 500), v3(175, 150, -500), v3(-1e-4, -1e-4, 0), v3(1e-4, 1e-4, 0), MASK_ALL);
    expect(almostPoint.fraction).toBeLessThan(1);
    expect(w.pointContents(v3(175, 150, 50))).toBe(CONTENTS_SOLID);
    expect(w.testBox(v3(175, 150, 50), ZERO, ZERO, MASK_ALL)).toBe(true);
  });

  it('ray grazing a ramp near its top edge reports the face normal, not a bevel', () => {
    const b = brushFromPoints(rampPoints(0, 512, 256, 443), CONTENTS_SOLID)!;
    expect(b.sides.some((s) => s.bevel)).toBe(true);
    const w = new CollisionWorld([b]);
    const slope = realSides(b).find((s) => s.plane.normal.y > 0.1 && s.plane.normal.z > 0.1)!.plane;
    const rnd = mulberry32(77);
    for (let i = 0; i < 200; i++) {
      // aim at random points of the slope face from random outside directions
      const t = rnd();
      const target = v3(10 + rnd() * 492, t * 256, 443 - t * 443);
      const dir = v3(rnd() - 0.5, 0.2 + rnd(), 0.2 + rnd());
      const start = v3(target.x + dir.x * 300, target.y + dir.y * 300, target.z + dir.z * 300);
      const end = v3(target.x - dir.x * 10, target.y - dir.y * 10, target.z - dir.z * 10);
      const tr = w.traceRay(start, end, MASK_ALL);
      if (tr.fraction === 1) continue; // a few rays may clip the cap faces' extents first? (they shouldn't)
      if (tr.plane.normal.x !== 0) continue; // hit an end cap
      expect(tr.plane.normal).toEqual(slope.normal);
    }
  });

  it('sloped ramp prism: dropping the player hull lands on the slope plane', () => {
    const b = brushFromPoints(rampPoints(0, 512, 256, 443), CONTENTS_SOLID)!;
    const w = new CollisionWorld([b]);
    const tr = w.traceBox(v3(256, 128, 1000), v3(256, 128, -1000), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.plane.normal.z).toBeCloseTo(0.5, 2);
    expect(tr.plane.normal.z).toBeCloseTo(256 / Math.hypot(256, 443), 12);
    expect(tr.plane.normal.y).toBeGreaterThan(0.85);
    // the hull's lowest -y corner rests DIST_EPSILON (along the normal) off the slope
    const n = tr.plane.normal;
    const c = center(MINS, MAXS, tr.endpos);
    const expanded = tr.plane.dist + Math.abs(n.x) * 16 + Math.abs(n.y) * 16 + Math.abs(n.z) * 36;
    expect(dot(c, n) - expanded).toBeCloseTo(DIST_EPSILON, 9);
    expect(w.testBox(tr.endpos, MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
  });
});

// =====================================================================================================
describe('CollisionWorld: ramp seams (no snagging)', () => {
  const L = 256;
  const H = 443;

  function buildSegments(n: number, segLen: number, yaw: number, t: Vec3, oblique = 0): Brush[] {
    const out: Brush[] = [];
    for (let i = 0; i < n; i++) {
      const x0 = i * segLen;
      const x1 = (i + 1) * segLen;
      // oblique seams: the cut plane is skewed in y by `oblique` units across the ramp
      const pts = [
        v3(x0, 0, 0),
        v3(x0 + oblique, L, 0),
        v3(x0, 0, H),
        v3(x1, 0, 0),
        v3(x1 + oblique, L, 0),
        v3(x1, 0, H),
      ].map((p) => rotZ(p, yaw, t));
      const b = brushFromPoints(pts, CONTENTS_SOLID);
      expect(b).not.toBeNull();
      out.push(b!);
    }
    return out;
  }

  const configs = [
    { name: 'axis aligned', yaw: 0, t: v3(0, 0, 0), oblique: 0 },
    { name: 'rotated 37 deg, off-grid', yaw: 37, t: v3(1234.5, -987.25, 300.125), oblique: 0 },
    { name: 'rotated 122.5 deg, oblique seams', yaw: 122.5, t: v3(-3000.3, 2500.7, -1000), oblique: 90 },
    { name: 'axis aligned, oblique seams', yaw: 0, t: v3(0, 0, 0), oblique: -70 },
    { name: 'far from origin (+-15000), rotated 71.3 deg', yaw: 71.3, t: v3(15000.3, -14000.7, 12000.9), oblique: 33 },
  ];

  for (const cfg of configs) {
    it(`sliding along the ramp across seams never stops (${cfg.name})`, () => {
      const segs = buildSegments(8, 256, cfg.yaw, cfg.t, cfg.oblique);
      const w = new CollisionWorld(segs);
      const along = rotZ(v3(1, 0, 0), cfg.yaw);
      const slopeN = realSides(segs[0]).find((s) => s.plane.normal.z > 0.1 && s.plane.normal.z < 0.9)!.plane.normal;
      const rnd = mulberry32(99 + cfg.yaw);
      let crossings = 0;
      for (let run = 0; run < 40; run++) {
        // drop onto the first segment at a random height on the slope
        const ly = 40 + rnd() * 150;
        const lx = 40 + Math.max(0, cfg.oblique) + rnd() * 150;
        const top = rotZ(v3(lx, ly, 2000), cfg.yaw, cfg.t);
        const tr = w.traceBox(top, v3(top.x, top.y, top.z - 4000), MINS, MAXS, MASK_PLAYERSOLID);
        expect(tr.fraction).toBeLessThan(1);
        expect(tr.plane.normal.z).toBeCloseTo(slopeN.z, 9);
        const pos = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
        // pure parallel slide: direction along the ramp's horizontal edge (+ a little down-slope component)
        const downSlope = v3(-slopeN.z * slopeN.x / Math.hypot(slopeN.x, slopeN.y), -slopeN.z * slopeN.y / Math.hypot(slopeN.x, slopeN.y), 0);
        // make it exactly parallel to the plane: project out the normal
        const k = rnd() * 0.3;
        const dir = v3(along.x + downSlope.x * k, along.y + downSlope.y * k, -k * Math.hypot(slopeN.x, slopeN.y) * 0 + 0);
        // project dir onto plane
        const dn = dot(dir, slopeN);
        dir.x -= slopeN.x * dn;
        dir.y -= slopeN.y * dn;
        dir.z -= slopeN.z * dn;
        const speed = 2000 + rnd() * 1500;
        const dl = Math.hypot(dir.x, dir.y, dir.z);
        const step = (speed / dl) * (1 / 100);
        for (let tick = 0; tick < 300; tick++) {
          const end = v3(pos.x + dir.x * step, pos.y + dir.y * step, pos.z + dir.z * step);
          // stop before the far end of the last segment
          const local = rotZ(v3(end.x - cfg.t.x, end.y - cfg.t.y, 0), -cfg.yaw);
          if (local.x > 8 * 256 - 40 - Math.abs(cfg.oblique)) break;
          const before = rotZ(v3(pos.x - cfg.t.x, pos.y - cfg.t.y, 0), -cfg.yaw).x;
          const r = w.traceBox(pos, end, MINS, MAXS, MASK_PLAYERSOLID);
          if (r.fraction !== 1 || r.startsolid) {
            throw new Error(`snag at tick ${tick} run ${run}: fraction ${r.fraction} normal ${JSON.stringify(r.plane.normal)} startsolid ${r.startsolid}`);
          }
          if (Math.floor(before / 256) !== Math.floor(local.x / 256)) crossings++;
          pos.x = r.endpos.x;
          pos.y = r.endpos.y;
          pos.z = r.endpos.z;
        }
      }
      expect(crossings).toBeGreaterThan(40);
    });

    it(`surfing with gravity across seams only ever touches the slope plane (${cfg.name})`, () => {
      const segs = buildSegments(10, 256, cfg.yaw, cfg.t, cfg.oblique);
      const w = new CollisionWorld(segs);
      const along = rotZ(v3(1, 0, 0), cfg.yaw);
      const slopeN = realSides(segs[0]).find((s) => s.plane.normal.z > 0.1 && s.plane.normal.z < 0.9)!.plane.normal;
      const rnd = mulberry32(5 + cfg.yaw);
      const tr = newTrace();
      let hits = 0;
      for (let run = 0; run < 25; run++) {
        const top = rotZ(v3(30 + Math.max(0, cfg.oblique) + rnd() * 100, 60 + rnd() * 60, 2000), cfg.yaw, cfg.t);
        const drop = w.traceBox(top, v3(top.x, top.y, top.z - 4000), MINS, MAXS, MASK_PLAYERSOLID);
        expect(drop.plane.normal.z).toBeCloseTo(slopeN.z, 9);
        let pos = v3(drop.endpos.x, drop.endpos.y, drop.endpos.z);
        const speed = 1500 + rnd() * 2000;
        let vel = v3(along.x * speed, along.y * speed, 0);
        const dt = 1 / (64 + Math.floor(rnd() * 64));
        for (let tick = 0; tick < 400; tick++) {
          const local = rotZ(v3(pos.x - cfg.t.x, pos.y - cfg.t.y, 0), -cfg.yaw);
          if (local.x > 10 * 256 - 80 - Math.abs(cfg.oblique) || local.y > L - 40) break;
          vel.z -= 800 * dt;
          const alongBefore = dot(vel, along);
          const r = slideMove(w, pos, vel, dt, MINS, MAXS, MASK_PLAYERSOLID, tr);
          expect(r.stuck).toBe(false);
          expect(r.startsolid).toBe(false);
          for (const n of r.normals) {
            hits++;
            if (Math.abs(n.x - slopeN.x) > 1e-9 || Math.abs(n.y - slopeN.y) > 1e-9 || Math.abs(n.z - slopeN.z) > 1e-9) {
              throw new Error(`run ${run} tick ${tick}: touched non-slope plane ${JSON.stringify(n)} at ${JSON.stringify(local)}`);
            }
          }
          // clipping against the slope never removes speed along the ramp's horizontal edge
          expect(Math.abs(dot(r.vel, along) - alongBefore)).toBeLessThan(1e-6);
          pos = r.pos;
          vel = r.vel;
        }
      }
      expect(hits).toBeGreaterThan(500);
    });
  }

  it('the seam itself is not hit when sliding exactly along the epsilon shell (step sweep)', () => {
    // sweep many sub-unit start offsets around the seam for a non-rotated pair
    const segs = buildSegments(2, 512, 0, v3(0, 0, 0));
    const w = new CollisionWorld(segs);
    const slope = realSides(segs[0]).find((s) => s.plane.normal.z > 0.1 && s.plane.normal.z < 0.9)!.plane;
    for (let i = 0; i < 400; i++) {
      const x = 440 + i * 0.37;
      const top = v3(x, 120, 1000);
      const drop = w.traceBox(top, v3(x, 120, -1000), MINS, MAXS, MASK_PLAYERSOLID);
      expect(drop.plane.normal).toEqual(slope.normal);
      const r = w.traceBox(drop.endpos, v3(drop.endpos.x + 100, drop.endpos.y, drop.endpos.z), MINS, MAXS, MASK_PLAYERSOLID);
      expect(r.fraction).toBe(1);
    }
  });
});

// =====================================================================================================
describe('CollisionWorld: tunneling, models, masks, contents', () => {
  it('no tunneling through 1-unit brushes at 3500 u/s and 64 tick', () => {
    const wall = brushFromBox(v3(500, -1000, -1000), v3(501, 1000, 1000), CONTENTS_SOLID);
    const slab = brushFromPoints(
      [
        v3(0, 0, 0), v3(1, 0, 0), v3(0, 400, 0), v3(1, 400, 0),
        v3(0, 0, 400), v3(1, 0, 400), v3(0, 400, 400), v3(1, 400, 400),
      ].map((p) => rotZ(v3(p.x, p.y - 200, p.z - 200), 33, v3(2000, 0, 0))),
      CONTENTS_SOLID,
    )!;
    const w = new CollisionWorld([wall, slab]);
    const rnd = mulberry32(42);
    const step = 3500 / 64;
    for (let i = 0; i < 300; i++) {
      // box traces through the axial wall
      let p = v3(300 + rnd() * 150, (rnd() - 0.5) * 200, (rnd() - 0.5) * 200);
      const dir = v3(1, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4);
      const dl = Math.hypot(dir.x, dir.y, dir.z);
      for (let t = 0; t < 10; t++) {
        const end = v3(p.x + (dir.x / dl) * step, p.y + (dir.y / dl) * step, p.z + (dir.z / dl) * step);
        const tr = w.traceBox(p, end, MINS, MAXS, MASK_PLAYERSOLID);
        expect(tr.startsolid).toBe(false);
        p = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
      }
      expect(p.x + 16).toBeLessThan(500);
      expect(p.x + 16).toBeGreaterThan(500 - 0.05);
      // point traces too
      let q = v3(300 + rnd() * 150, (rnd() - 0.5) * 200, (rnd() - 0.5) * 200);
      for (let t = 0; t < 10; t++) {
        const tr = w.traceRay(q, v3(q.x + step, q.y, q.z), MASK_PLAYERSOLID);
        q = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
      }
      expect(q.x).toBeLessThan(500);
      // rotated thin slab (brushFromPoints) approached along its normal from either side
      const sn = realSides(slab).find((s) => Math.abs(s.plane.normal.z) < 0.01 && Math.abs(s.plane.normal.x) > 0.5)!.plane;
      const side = rnd() < 0.5 ? 1 : -1;
      const n = v3(sn.normal.x * side, sn.normal.y * side, 0);
      const c0 = rotZ(v3(0.5, (rnd() - 0.5) * 100, (rnd() - 0.5) * 100), 33, v3(2000, 0, 0));
      let r = v3(c0.x + n.x * (80 + rnd() * 100), c0.y + n.y * (80 + rnd() * 100), c0.z);
      const startSide = Math.sign(dot(v3(r.x - c0.x, r.y - c0.y, 0), n));
      for (let t = 0; t < 10; t++) {
        const tr = w.traceBox(r, v3(r.x - n.x * step, r.y - n.y * step, r.z), MINS, MAXS, MASK_PLAYERSOLID);
        expect(tr.startsolid).toBe(false);
        r = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
      }
      expect(Math.sign(dot(v3(r.x - c0.x, r.y - c0.y, 0), n))).toBe(startSide);
      expect(w.testBox(r, MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
    }
  });

  it('thin displacement-style triangle prisms: solid, no tunneling, smooth sliding over a gentle mesh', () => {
    // a gently curved height field triangulated, each triangle extruded 1 unit down (thin prisms)
    const rnd = mulberry32(606);
    const N = 8;
    const S = 64;
    const hgt = (i: number, j: number) => 20 * Math.sin(i * 0.4) + 12 * Math.cos(j * 0.3) + (rnd() - 0.5) * 0.01;
    const H: number[][] = [];
    for (let i = 0; i <= N; i++) {
      H.push([]);
      for (let j = 0; j <= N; j++) H[i].push(hgt(i, j));
    }
    const brushes: Brush[] = [];
    const tri = (a: Vec3, b: Vec3, c: Vec3) => {
      const pts = [a, b, c, v3(a.x, a.y, a.z - 1), v3(b.x, b.y, b.z - 1), v3(c.x, c.y, c.z - 1)];
      const br = brushFromPoints(pts, CONTENTS_SOLID);
      expect(br).not.toBeNull();
      brushes.push(br!);
    };
    const P = (i: number, j: number) => v3(1000.37 + i * S, -500.11 + j * S, 3000 + H[i][j]);
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        tri(P(i, j), P(i + 1, j), P(i + 1, j + 1));
        tri(P(i, j), P(i + 1, j + 1), P(i, j + 1));
      }
    const w = new CollisionWorld(brushes);
    // drops land on top, never fall through
    for (let k = 0; k < 300; k++) {
      const x = 1000.37 + 20 + rnd() * (N * S - 40);
      const y = -500.11 + 20 + rnd() * (N * S - 40);
      const tr = w.traceBox(v3(x, y, 3200), v3(x, y, 2800), MINS, MAXS, MASK_PLAYERSOLID);
      expect(tr.fraction).toBeLessThan(1);
      expect(tr.plane.normal.z).toBeGreaterThan(0.3);
      // point traces too (1-unit thick prisms)
      const r = w.traceRay(v3(x, y, 3200), v3(x, y, 2800), MASK_PLAYERSOLID);
      expect(r.fraction).toBeLessThan(1);
      expect(r.plane.normal.z).toBeGreaterThan(0.3);
    }
    // fast diagonal falls at 3500 u/s never tunnel through the 1-unit shell
    for (let k = 0; k < 200; k++) {
      let p = v3(1000.37 + 100 + rnd() * 300, -500.11 + 100 + rnd() * 300, 3150);
      const v = v3((rnd() - 0.5) * 1000, (rnd() - 0.5) * 1000, -3400);
      for (let t = 0; t < 10; t++) {
        const tr = w.traceBox(p, v3(p.x + v.x / 64, p.y + v.y / 64, p.z + v.z / 64), MINS, MAXS, MASK_PLAYERSOLID);
        expect(tr.startsolid).toBe(false);
        p = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
        if (tr.fraction < 1) break;
      }
      expect(p.z).toBeGreaterThan(2900);
      expect(w.testBox(p, MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
    }
    // sliding across the triangle mesh with gravity: never stuck or inside, always gets across. (A box that
    // is briefly airborne over a convex fold can legitimately catch a ridge edge with a vertical box edge -
    // that contact normal is horizontal, exactly like a box-vs-triangle test would give.)
    const trr = newTrace();
    let touches = 0;
    let topTouches = 0;
    let offEdges = 0;
    for (let k = 0; k < 60; k++) {
      const x = 1000.37 + 40 + rnd() * 100;
      const y = -500.11 + 40 + rnd() * (N * S - 80);
      const drop = w.traceBox(v3(x, y, 3200), v3(x, y, 2800), MINS, MAXS, MASK_PLAYERSOLID);
      let pos = v3(drop.endpos.x, drop.endpos.y, drop.endpos.z);
      let vel = v3(900, (rnd() - 0.5) * 300, 0);
      let offEdge = false;
      for (let t = 0; t < 100 && pos.x < 1000.37 + N * S - 40; t++) {
        if (pos.y < -500.11 + 20 || pos.y > -500.11 + N * S - 20) {
          offEdge = true; // slid off the side of the mesh
          break;
        }
        vel.z -= 800 / 100;
        const r = slideMove(w, pos, vel, 1 / 100, MINS, MAXS, MASK_PLAYERSOLID, trr);
        expect(r.stuck).toBe(false);
        // at most a Source-style shaved-corner sliver, never real penetration
        expect(worldDepth(w, r.pos, MINS, MAXS, MASK_PLAYERSOLID)).toBeLessThanOrEqual(DIST_EPSILON + 1e-9);
        for (const m of r.normals) {
          touches++;
          if (m.z > 0.9) topTouches++;
        }
        pos = r.pos;
        vel = r.vel;
        expect(pos.z).toBeGreaterThan(2960); // never fell through the shell
      }
      if (!offEdge) expect(pos.x).toBeGreaterThan(1000.37 + N * S - 60);
      else offEdges++;
    }
    expect(touches).toBeGreaterThan(500);
    expect(topTouches / touches).toBeGreaterThan(0.95);
    expect(offEdges).toBeLessThan(30);
  });

  it('disabled brush models are ignored by every query', () => {
    const door = brushFromBox(v3(100, -64, 0), v3(108, 64, 128), CONTENTS_SOLID, 3);
    const floor = brushFromBox(v3(-512, -512, -16), v3(512, 512, 0), CONTENTS_SOLID, 0);
    const w = new CollisionWorld([floor, door]);
    const start = v3(0, 0, 10);
    const end = v3(300, 0, 10);
    expect(w.isModelSolid(3)).toBe(true);
    expect(w.traceBox(start, end, MINS, MAXS, MASK_PLAYERSOLID).model).toBe(3);
    w.setModelSolid(3, false);
    expect(w.isModelSolid(3)).toBe(false);
    expect(w.isModelSolid(0)).toBe(true);
    expect(w.traceBox(start, end, MINS, MAXS, MASK_PLAYERSOLID).fraction).toBe(1);
    expect(w.pointContents(v3(104, 0, 64))).toBe(0);
    expect(w.testBox(v3(104, 0, 10), MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
    const seen: Brush[] = [];
    w.queryBox(v3(-1000, -1000, -1000), v3(1000, 1000, 1000), (b) => seen.push(b));
    expect(seen).toEqual([floor]);
    // the floor still works
    expect(w.traceBox(v3(0, 0, 100), v3(0, 0, -100), MINS, MAXS, MASK_PLAYERSOLID).endpos.z).toBeCloseTo(DIST_EPSILON, 10);
    w.setModelSolid(3, true);
    expect(w.traceBox(start, end, MINS, MAXS, MASK_PLAYERSOLID).fraction).toBeLessThan(1);
    expect(w.pointContents(v3(104, 0, 64))).toBe(CONTENTS_SOLID);
    // unknown models are remembered
    w.setModelSolid(42, false);
    expect(w.isModelSolid(42)).toBe(false);
  });

  it('masks: playerclip blocks players only; water is not player-solid', () => {
    const clip = brushFromBox(v3(100, -64, 0), v3(132, 64, 128), CONTENTS_PLAYERCLIP);
    const water = brushFromBox(v3(300, -64, -100), v3(400, 64, 100), CONTENTS_WATER);
    const w = new CollisionWorld([clip, water]);
    const a = w.traceBox(v3(0, 0, 10), v3(200, 0, 10), MINS, MAXS, MASK_PLAYERSOLID);
    expect(a.fraction).toBeLessThan(1);
    expect(a.contents).toBe(CONTENTS_PLAYERCLIP);
    expect(w.traceBox(v3(0, 0, 10), v3(200, 0, 10), MINS, MAXS, MASK_SOLID).fraction).toBe(1);
    expect(w.traceRay(v3(0, 0, 10), v3(200, 0, 10), MASK_SOLID).fraction).toBe(1);
    expect(w.traceBox(v3(250, 0, 0), v3(450, 0, 0), MINS, MAXS, MASK_PLAYERSOLID).fraction).toBe(1);
    const wt = w.traceBox(v3(250, 0, 0), v3(450, 0, 0), MINS, MAXS, MASK_WATER);
    expect(wt.fraction).toBeLessThan(1);
    expect(wt.contents).toBe(CONTENTS_WATER);
    expect(w.testBox(v3(350, 0, 0), MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
    expect(w.testBox(v3(350, 0, 0), MINS, MAXS, MASK_WATER)).toBe(true);
    expect(w.testBox(v3(116, 0, 0), MINS, MAXS, MASK_PLAYERSOLID)).toBe(true);
    expect(w.testBox(v3(116, 0, 0), MINS, MAXS, MASK_SOLID)).toBe(false);
  });

  it('pointContents: water, overlaps, strict boundaries, masks', () => {
    const water = brushFromBox(v3(0, 0, 0), v3(100, 100, 100), CONTENTS_WATER);
    const slime = brushFromBox(v3(50, 50, 50), v3(150, 150, 150), CONTENTS_SLIME);
    const ramp = brushFromPoints(rampPoints(200, 300, 100, 100), CONTENTS_SOLID)!;
    const w = new CollisionWorld([water, slime, ramp]);
    expect(w.pointContents(v3(10, 10, 10))).toBe(CONTENTS_WATER);
    expect(w.pointContents(v3(75, 75, 75))).toBe(CONTENTS_WATER | CONTENTS_SLIME);
    expect(w.pointContents(v3(75, 75, 75), MASK_WATER)).toBe(CONTENTS_WATER | CONTENTS_SLIME);
    expect(w.pointContents(v3(75, 75, 75), CONTENTS_WATER)).toBe(CONTENTS_WATER);
    expect(w.pointContents(v3(75, 75, 75), CONTENTS_SOLID)).toBe(0);
    expect(w.pointContents(v3(120, 120, 120))).toBe(CONTENTS_SLIME);
    expect(w.pointContents(v3(-1, 10, 10))).toBe(0);
    expect(w.pointContents(v3(10, 10, 100))).toBe(0); // on the water surface plane: outside
    expect(w.pointContents(v3(10, 10, 99.999))).toBe(CONTENTS_WATER);
    expect(w.pointContents(v3(250, 10, 10))).toBe(CONTENTS_SOLID);
    expect(w.pointContents(v3(250, 60, 50))).toBe(0); // above the slope (z = 100 - y)
    expect(w.pointContents(v3(250, 40, 50))).toBe(CONTENTS_SOLID);
  });

  it('queryBox reports enabled brushes overlapping or touching the AABB, any contents', () => {
    const rnd = mulberry32(3);
    const brushes: Brush[] = [];
    for (let i = 0; i < 500; i++) {
      const c = v3((rnd() - 0.5) * 4000, (rnd() - 0.5) * 4000, (rnd() - 0.5) * 4000);
      const s = v3(1 + rnd() * 200, 1 + rnd() * 200, 1 + rnd() * 200);
      brushes.push(brushFromBox(v3(c.x - s.x, c.y - s.y, c.z - s.z), v3(c.x + s.x, c.y + s.y, c.z + s.z), i % 3 === 0 ? CONTENTS_WATER : CONTENTS_SOLID, i % 7));
    }
    const w = new CollisionWorld(brushes);
    w.setModelSolid(5, false);
    for (let k = 0; k < 100; k++) {
      const c = v3((rnd() - 0.5) * 4000, (rnd() - 0.5) * 4000, (rnd() - 0.5) * 4000);
      const s = rnd() * 500;
      const lo = v3(c.x - s, c.y - s, c.z - s);
      const hi = v3(c.x + s, c.y + s, c.z + s);
      const got = new Set<Brush>();
      w.queryBox(lo, hi, (b) => {
        expect(got.has(b)).toBe(false);
        got.add(b);
      });
      const want = brushes.filter(
        (b) => b.model !== 5 && b.mins.x <= hi.x && b.maxs.x >= lo.x && b.mins.y <= hi.y && b.maxs.y >= lo.y && b.mins.z <= hi.z && b.maxs.z >= lo.z,
      );
      expect(got.size).toBe(want.length);
      for (const b of want) expect(got.has(b)).toBe(true);
    }
    // re-entrant
    let inner = 0;
    w.queryBox(v3(-2000, -2000, -2000), v3(2000, 2000, 2000), () => {
      w.queryBox(v3(-10, -10, -10), v3(10, 10, 10), () => inner++);
    });
    expect(inner).toBeGreaterThanOrEqual(0);
  });

  it('empty world and invalid brushes are handled', () => {
    const w = new CollisionWorld([]);
    const tr = w.traceBox(v3(0, 0, 0), v3(100, 0, 0), MINS, MAXS, MASK_ALL);
    expect(tr.fraction).toBe(1);
    expect(w.pointContents(v3(0, 0, 0))).toBe(0);
    expect(w.testBox(v3(0, 0, 0), MINS, MAXS, MASK_ALL)).toBe(false);
    const bad: Brush = { sides: [], contents: 1, mins: v3(), maxs: v3(), model: 0 };
    const nanB = brushFromBox(v3(0, 0, 0), v3(10, 10, 10), 1);
    nanB.mins = v3(NaN, 0, 0);
    const w2 = new CollisionWorld([bad, nanB]);
    expect(w2.stats().brushes).toBe(1); // bounds recomputed for nanB
    expect(nanB.mins).toEqual(v3(0, 0, 0));
    expect(w2.traceRay(v3(5, 5, 100), v3(5, 5, -100), MASK_ALL).fraction).toBeLessThan(1);
    expect(w2.brushes.length).toBe(2);
  });
});

// =====================================================================================================
describe('boxIntersectsBrush', () => {
  it('boxes: overlap, touching, separated', () => {
    const b = brushFromBox(v3(0, 0, 0), v3(100, 100, 100), CONTENTS_SOLID);
    expect(boxIntersectsBrush(v3(-10, -10, -10), v3(10, 10, 10), b)).toBe(true);
    expect(boxIntersectsBrush(v3(-10, -10, -10), v3(0, 10, 10), b)).toBe(false); // touching
    expect(boxIntersectsBrush(v3(100, 0, 0), v3(120, 10, 10), b)).toBe(false);
    expect(boxIntersectsBrush(v3(99.99, 0, 0), v3(120, 10, 10), b)).toBe(true);
    expect(boxIntersectsBrush(v3(-50, -50, -50), v3(-1, -1, -1), b)).toBe(false);
    expect(boxIntersectsBrush(v3(-50, -50, -50), v3(500, 500, 500), b)).toBe(true); // containing
    expect(boxIntersectsBrush(v3(40, 40, 40), v3(60, 60, 60), b)).toBe(true); // contained
  });

  it('near sloped faces and edges (bevels make it exact)', () => {
    const ramp = brushFromPoints(rampPoints(0, 512, 256, 443), CONTENTS_SOLID)!;
    // box above the slope: AABBs overlap, but no contact
    const slopeZ = (y: number) => 443 - (443 / 256) * y;
    const mk = (x: number, y: number, zBottom: number) => [v3(x - 16, y - 16, zBottom), v3(x + 16, y + 16, zBottom + 72)] as const;
    // the box's lowest-relevant corner is at y-16 (slope descends with +y)
    const [a0, a1] = mk(200, 128, slopeZ(128 - 16) + 0.5);
    expect(boxIntersectsBrush(a0, a1, ramp)).toBe(false);
    const [b0, b1] = mk(200, 128, slopeZ(128 - 16) - 0.5);
    expect(boxIntersectsBrush(b0, b1, ramp)).toBe(true);
    // near the top ridge (y=0, z=443): box beside the top edge, diagonally outside
    expect(boxIntersectsBrush(v3(100, -40, 450), v3(132, -8, 500), ramp)).toBe(false);
    expect(boxIntersectsBrush(v3(100, -40, 430), v3(132, -8, 500), ramp)).toBe(false); // beside the back face
    expect(boxIntersectsBrush(v3(100, -40, 430), v3(132, 1, 500), ramp)).toBe(true);
    // just past the lower lip (y=256, z=0)
    expect(boxIntersectsBrush(v3(100, 257, -10), v3(132, 289, 62), ramp)).toBe(false);
    expect(boxIntersectsBrush(v3(100, 250, -10), v3(132, 282, 62), ramp)).toBe(true);
  });

  it('rotated ramp: boxes in the edge regions that only bevels separate are not intersecting', () => {
    const ramp = brushFromPoints(rampPoints(0, 512, 256, 443).map((p) => rotZ(p, 30, v3(50, -20, 10))), CONTENTS_SOLID)!;
    const ref = hullRef(ramp);
    const real = realSides(ramp);
    const rnd = mulberry32(11);
    let bevelOnly = 0;
    for (let k = 0; k < 40000 && bevelOnly < 200; k++) {
      const c = v3(ramp.mins.x + rnd() * (ramp.maxs.x - ramp.mins.x), ramp.mins.y + rnd() * (ramp.maxs.y - ramp.mins.y), ramp.mins.z - 30 + rnd() * (ramp.maxs.z - ramp.mins.z + 60));
      const e = v3(16, 16, 36);
      const gap = boxBrushGap(c, e, ref);
      if (gap < 0.5) continue; // want clearly separated boxes
      // ...that the real faces alone (no bevels) would not separate
      let sepByReal = false;
      for (const s of real) {
        const n = s.plane.normal;
        if (dot(c, n) - (s.plane.dist + Math.abs(n.x) * e.x + Math.abs(n.y) * e.y + Math.abs(n.z) * e.z) >= 0) sepByReal = true;
      }
      if (sepByReal) continue;
      bevelOnly++;
      expect(boxIntersectsBrush(v3(c.x - e.x, c.y - e.y, c.z - e.z), v3(c.x + e.x, c.y + e.y, c.z + e.z), ramp)).toBe(false);
      const w = new CollisionWorld([ramp]);
      expect(w.testBox(v3(c.x, c.y, c.z - 36), MINS, MAXS, MASK_ALL)).toBe(false);
    }
    expect(bevelOnly).toBeGreaterThan(20);
  });

  it('matches an exact separating-axis reference on random hulls', () => {
    const rnd = mulberry32(2024);
    let checked = 0;
    let hits = 0;
    for (let iter = 0; iter < 80; iter++) {
      const b = randomHull(rnd, v3(0, 0, 0), 200, 6 + Math.floor(rnd() * 10))!;
      const ref = hullRef(b);
      for (let k = 0; k < 150; k++) {
        const c = v3((rnd() - 0.5) * 300, (rnd() - 0.5) * 300, (rnd() - 0.5) * 300);
        const e = v3(1 + rnd() * 40, 1 + rnd() * 40, 1 + rnd() * 60);
        const gap = boxBrushGap(c, e, ref);
        if (Math.abs(gap) < 1e-3) continue; // too close to call
        const got = boxIntersectsBrush(v3(c.x - e.x, c.y - e.y, c.z - e.z), v3(c.x + e.x, c.y + e.y, c.z + e.z), b);
        expect(got).toBe(gap < 0);
        checked++;
        if (got) hits++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(hits).toBeGreaterThan(1000);
  });
});

// =====================================================================================================
describe('CollisionWorld: randomized properties vs exact reference', () => {
  it('traces against random hulls stop DIST_EPSILON short of contact, never early, never inside', () => {
    const rnd = mulberry32(777);
    let hitsChecked = 0;
    let missesChecked = 0;
    let maxHitGap = 0;
    for (let iter = 0; iter < 150; iter++) {
      const b = randomHull(rnd, v3(0, 0, 0), 150 + rnd() * 200, 5 + Math.floor(rnd() * 12))!;
      const ref = hullRef(b);
      const w = new CollisionWorld([b]);
      for (let k = 0; k < 80; k++) {
        const point = rnd() < 0.2;
        const e = point ? v3(0, 0, 0) : v3(2 + rnd() * 20, 2 + rnd() * 20, 2 + rnd() * 40);
        const mins = v3(-e.x, -e.y, -rnd() * e.z * 2);
        const maxs = v3(e.x, e.y, mins.z + 2 * e.z);
        const off = v3(0, 0, (mins.z + maxs.z) / 2);
        const s = v3((rnd() - 0.5) * 900, (rnd() - 0.5) * 900, (rnd() - 0.5) * 900);
        // aim near the brush half of the time
        const t = rnd() < 0.5 ? v3((rnd() - 0.5) * 300, (rnd() - 0.5) * 300, (rnd() - 0.5) * 300) : v3((rnd() - 0.5) * 900, (rnd() - 0.5) * 900, (rnd() - 0.5) * 900);
        const sc = v3(s.x + off.x, s.y + off.y, s.z + off.z);
        const tc = v3(t.x + off.x, t.y + off.y, t.z + off.z);
        if (boxBrushGap(sc, e, ref) < 0.05) continue; // start clear of the brush
        const tr = w.traceBox(s, t, mins, maxs, MASK_ALL);
        expect(tr.startsolid).toBe(false);
        const ec = v3(tr.endpos.x + off.x, tr.endpos.y + off.y, tr.endpos.z + off.z);
        // never inside or touching
        const endGap = boxBrushGap(ec, e, ref);
        expect(endGap).toBeGreaterThan(0);
        expect(w.testBox(tr.endpos, mins, maxs, MASK_ALL)).toBe(false);
        // the swept part of the move never penetrates the brush beyond the DIST_EPSILON shell
        expect(sweptGap(sc, ec, e, ref)).toBeGreaterThan(-DIST_EPSILON - 1e-9);
        if (tr.fraction < 1) {
          hitsChecked++;
          const n = tr.plane.normal;
          const expd = tr.plane.dist + Math.abs(n.x) * e.x + Math.abs(n.y) * e.y + Math.abs(n.z) * e.z;
          if (tr.fraction > 0) expect(dot(ec, n) - expd).toBeCloseTo(DIST_EPSILON, 6);
          // stopped close to the real brush, not at a phantom corner (missing bevels would leave gaps ~ box size)
          if (!point) {
            expect(endGap).toBeLessThan(4 * DIST_EPSILON);
            if (endGap > maxHitGap) maxHitGap = endGap;
          }
        } else {
          missesChecked++;
          expect(sweptGap(sc, tc, e, ref)).toBeGreaterThan(-DIST_EPSILON - 1e-9);
        }
      }
    }
    console.log(`[collision] random hull traces: ${hitsChecked} hits, ${missesChecked} misses, max gap at hit ${maxHitGap.toFixed(5)}`);
    expect(hitsChecked).toBeGreaterThan(1500);
    expect(missesChecked).toBeGreaterThan(1500);
  });

  it('testBox agrees with traceBox startsolid, including near-touching placements', () => {
    const rnd = mulberry32(31337);
    const brushes: Brush[] = [];
    for (let i = 0; i < 60; i++) {
      const c = v3((rnd() - 0.5) * 2000, (rnd() - 0.5) * 2000, (rnd() - 0.5) * 2000);
      if (i % 2) brushes.push(randomHull(rnd, c, 100 + rnd() * 300, 8)!);
      else brushes.push(brushFromBox(v3(Math.round(c.x), Math.round(c.y), Math.round(c.z)), v3(Math.round(c.x) + 64, Math.round(c.y) + 64, Math.round(c.z) + 64), CONTENTS_SOLID));
    }
    const w = new CollisionWorld(brushes);
    let solid = 0;
    for (let k = 0; k < 20000; k++) {
      let p: Vec3;
      if (k % 2 === 0) {
        p = v3((rnd() - 0.5) * 2400, (rnd() - 0.5) * 2400, (rnd() - 0.5) * 2400);
      } else {
        // snap next to an axial box face exactly or within epsilon
        const b = brushes[2 * Math.floor(rnd() * 30)];
        const eps = [0, DIST_EPSILON, -DIST_EPSILON, 1e-9, -1e-9][Math.floor(rnd() * 5)];
        p = v3(b.maxs.x + 16 + eps, b.mins.y + rnd() * 64, b.mins.z + rnd() * 64 - 36);
      }
      const ts = w.traceBox(p, p, MINS, MAXS, MASK_ALL).startsolid;
      expect(w.testBox(p, MINS, MAXS, MASK_ALL)).toBe(ts);
      const tr = w.traceBox(p, v3(p.x + 50, p.y, p.z), MINS, MAXS, MASK_ALL);
      expect(tr.startsolid).toBe(ts);
      if (ts) solid++;
      // point
      const pc = w.traceRay(p, p, MASK_ALL).startsolid;
      expect(w.testBox(p, ZERO, ZERO, MASK_ALL)).toBe(pc);
    }
    expect(solid).toBeGreaterThan(100);
  });

  it('endpos of non-startsolid traces is never deeper than DIST_EPSILON in solid (dense random world)', () => {
    const rnd = mulberry32(8);
    const brushes: Brush[] = [];
    for (let i = 0; i < 400; i++) {
      const c = v3((rnd() - 0.5) * 3000, (rnd() - 0.5) * 3000, (rnd() - 0.5) * 3000);
      const r = rnd();
      if (r < 0.4) {
        const s = v3(1 + rnd() * 100, 1 + rnd() * 100, 1 + rnd() * 100);
        brushes.push(brushFromBox(v3(c.x - s.x, c.y - s.y, c.z - s.z), v3(c.x + s.x, c.y + s.y, c.z + s.z), CONTENTS_SOLID));
      } else if (r < 0.7) {
        brushes.push(brushFromPoints(rampPoints(0, 100 + rnd() * 400, 50 + rnd() * 200, 50 + rnd() * 400).map((p) => rotZ(p, rnd() * 360, c)), CONTENTS_SOLID)!);
      } else {
        brushes.push(randomHull(rnd, c, 50 + rnd() * 200, 6 + Math.floor(rnd() * 8))!);
      }
    }
    const w = new CollisionWorld(brushes);
    const tr = newTrace();
    let n = 0;
    let slivers = 0;
    for (let k = 0; k < 20000; k++) {
      const s = v3((rnd() - 0.5) * 3200, (rnd() - 0.5) * 3200, (rnd() - 0.5) * 3200);
      const t = v3(s.x + (rnd() - 0.5) * 800, s.y + (rnd() - 0.5) * 800, s.z + (rnd() - 0.5) * 800);
      w.traceBox(s, t, MINS, MAXS, MASK_PLAYERSOLID, tr);
      if (tr.startsolid) continue;
      n++;
      // Source semantics: a sweep stopped by one brush may end inside a corner sliver of another brush it
      // grazed (shallower than DIST_EPSILON); anything deeper would be a tunneling bug.
      if (w.testBox(tr.endpos, MINS, MAXS, MASK_PLAYERSOLID)) {
        slivers++;
        expect(worldDepth(w, tr.endpos, MINS, MAXS, MASK_PLAYERSOLID)).toBeLessThanOrEqual(DIST_EPSILON + 1e-9);
      }
      // retracing towards the same target from the endpos goes (almost) nowhere
      const again = w.traceBox(tr.endpos, t, MINS, MAXS, MASK_PLAYERSOLID);
      if (!again.startsolid && tr.fraction < 1) expect(again.fraction).toBeLessThan(0.5);
    }
    expect(n).toBeGreaterThan(10000);
    expect(slivers).toBeLessThan(n * 0.01);
  });

  it('BVH traces equal brute-force traces over each brush individually', () => {
    const rnd = mulberry32(55);
    const brushes: Brush[] = [];
    for (let i = 0; i < 300; i++) {
      const c = v3((rnd() - 0.5) * 2000, (rnd() - 0.5) * 2000, (rnd() - 0.5) * 2000);
      brushes.push(i % 2 ? randomHull(rnd, c, 50 + rnd() * 150, 8)! : brushFromBox(c, v3(c.x + rnd() * 100 + 1, c.y + rnd() * 100 + 1, c.z + rnd() * 100 + 1), 1 << (i % 3)));
    }
    const all = new CollisionWorld(brushes);
    const singles = brushes.map((b) => new CollisionWorld([b]));
    for (let k = 0; k < 2000; k++) {
      const s = v3((rnd() - 0.5) * 2200, (rnd() - 0.5) * 2200, (rnd() - 0.5) * 2200);
      const t = v3(s.x + (rnd() - 0.5) * 1500, s.y + (rnd() - 0.5) * 1500, s.z + (rnd() - 0.5) * 1500);
      const mask = k % 5 === 0 ? CONTENTS_SOLID : MASK_ALL;
      const point = k % 4 === 0;
      const tr = point ? all.traceRay(s, t, mask) : all.traceBox(s, t, MINS, MAXS, mask);
      let best = 1;
      let anyStart = false;
      let anyAll = false;
      for (const sw of singles) {
        const r = point ? sw.traceRay(s, t, mask) : sw.traceBox(s, t, MINS, MAXS, mask);
        if (r.allsolid) anyAll = true;
        if (r.startsolid) anyStart = true;
        if (r.fraction < best) best = r.fraction;
      }
      expect(tr.allsolid).toBe(anyAll);
      if (!anyAll) {
        expect(tr.startsolid).toBe(anyStart);
        expect(tr.fraction).toBe(best);
      }
    }
  });
});

// =====================================================================================================
describe('CollisionWorld: performance', () => {
  function randomBrushes(n: number, seed: number, spread: number): Brush[] {
    const rnd = mulberry32(seed);
    const out: Brush[] = [];
    while (out.length < n) {
      const c = v3((rnd() - 0.5) * spread, (rnd() - 0.5) * spread, (rnd() - 0.5) * spread * 0.5);
      const r = rnd();
      if (r < 0.6) {
        const s = v3(4 + rnd() * 150, 4 + rnd() * 150, 4 + rnd() * 150);
        out.push(brushFromBox(v3(c.x - s.x, c.y - s.y, c.z - s.z), v3(c.x + s.x, c.y + s.y, c.z + s.z), CONTENTS_SOLID));
      } else {
        const b = brushFromPoints(rampPoints(0, 64 + rnd() * 600, 32 + rnd() * 300, 32 + rnd() * 500).map((p) => rotZ(p, rnd() * 360, c)), CONTENTS_SOLID);
        if (b) out.push(b);
      }
    }
    return out;
  }

  it('builds 25k brushes / ~200k+ sides quickly', () => {
    const brushes = randomBrushes(25000, 1, 30000);
    const sides = brushes.reduce((a, b) => a + b.sides.length, 0);
    // warm up the JIT once on a smaller set
    new CollisionWorld(brushes.slice(0, 3000));
    const t0 = performance.now();
    const w = new CollisionWorld(brushes);
    const ms = performance.now() - t0;
    console.log(`[collision] build ${brushes.length} brushes / ${sides} sides: ${ms.toFixed(1)} ms, stats ${JSON.stringify(w.stats())}`);
    expect(w.stats().brushes).toBe(25000);
    expect(ms).toBeLessThan(1000);
  });

  it('20k random brushes + 100k random traces', () => {
    const brushes = randomBrushes(20000, 2, 20000);
    const t0 = performance.now();
    const w = new CollisionWorld(brushes);
    const buildMs = performance.now() - t0;
    const rnd = mulberry32(9);
    const starts: Vec3[] = [];
    const ends: Vec3[] = [];
    for (let i = 0; i < 100000; i++) {
      const s = v3((rnd() - 0.5) * 20000, (rnd() - 0.5) * 20000, (rnd() - 0.5) * 10000);
      // mostly movement-sized traces, some long ones
      const len = i % 10 === 0 ? 2000 : 60;
      starts.push(s);
      ends.push(v3(s.x + (rnd() - 0.5) * len, s.y + (rnd() - 0.5) * len, s.z + (rnd() - 0.5) * len));
    }
    const tr = newTrace();
    // warm-up
    for (let i = 0; i < 5000; i++) w.traceBox(starts[i], ends[i], MINS, MAXS, MASK_PLAYERSOLID, tr);
    const t1 = performance.now();
    let hits = 0;
    for (let i = 0; i < 100000; i++) {
      w.traceBox(starts[i], ends[i], MINS, MAXS, MASK_PLAYERSOLID, tr);
      if (tr.fraction < 1) hits++;
    }
    const traceMs = performance.now() - t1;
    const t2 = performance.now();
    for (let i = 0; i < 100000; i++) w.traceRay(starts[i], ends[i], MASK_PLAYERSOLID, tr);
    const rayMs = performance.now() - t2;
    const t3 = performance.now();
    let c = 0;
    for (let i = 0; i < 100000; i++) c |= w.pointContents(starts[i]);
    const pcMs = performance.now() - t3;
    console.log(
      `[collision] 20k brushes build ${buildMs.toFixed(1)} ms; 100k hull traces ${traceMs.toFixed(1)} ms (${hits} hits); ` +
        `100k rays ${rayMs.toFixed(1)} ms; 100k pointContents ${pcMs.toFixed(1)} ms (${c})`,
    );
    expect(traceMs).toBeLessThan(4000);
  });
});

// =====================================================================================================
const MAPS_DIR = process.env.SURF_TEST_MAPS;
const haveMaps = !!MAPS_DIR && existsSync(MAPS_DIR);
const mapFiles = haveMaps ? readdirSync(MAPS_DIR!).filter((f) => f.toLowerCase().endsWith('.bsp')).sort() : [];

describe.skipIf(!haveMaps)('CollisionWorld on real maps (SURF_TEST_MAPS)', () => {
  for (const file of mapFiles) {
    it(`${file}: builds, spawns stand on ground, traces never end in solid`, () => {
      const t0 = performance.now();
      const bsp = readBspBrushes(join(MAPS_DIR!, file));
      if (!bsp) {
        console.log(`[collision] ${file}: compressed or unsupported, skipped`);
        return;
      }
      const readMs = performance.now() - t0;
      const t1 = performance.now();
      const w = new CollisionWorld(bsp.world);
      const buildMs = performance.now() - t1;
      const st = w.stats();
      const bevels = bsp.world.reduce((a, b) => a + b.sides.filter((s) => s.bevel).length, 0);
      expect(bsp.world.length).toBeGreaterThan(bsp.rawWorldCount * 0.95);

      // bevel comparison: our bevels vs the compiler's
      let ourExtra = 0;
      let missing = 0;
      for (const b of bsp.world.slice(0, 3000)) {
        const copy: Brush = { sides: b.sides.filter((s) => !s.bevel).map((s) => ({ plane: s.plane, bevel: false })), contents: b.contents, mins: b.mins, maxs: b.maxs, model: 0 };
        addBrushBevels(copy);
        for (const s of b.sides) {
          if (!s.bevel) continue;
          const found = copy.sides.some((o) => Math.abs(o.plane.normal.x - s.plane.normal.x) < 1e-3 && Math.abs(o.plane.normal.y - s.plane.normal.y) < 1e-3 && Math.abs(o.plane.normal.z - s.plane.normal.z) < 1e-3);
          if (!found) missing++;
        }
        ourExtra += copy.sides.length - b.sides.length;
      }

      // spawn points: drop to the ground (some maps spawn players in the air above a floor)
      const tr = newTrace();
      let spawnOk = 0;
      let spawnTried = 0;
      for (const sp of bsp.spawns.slice(0, 64)) {
        const start = v3(sp.x, sp.y, sp.z + 1);
        w.traceBox(start, v3(sp.x, sp.y, sp.z - 8192), MINS, MAXS, MASK_PLAYERSOLID, tr);
        if (tr.startsolid) continue;
        spawnTried++;
        if (tr.fraction === 1) continue;
        spawnOk++;
        expect(tr.plane.normal.z).toBeGreaterThan(0.7);
        expect(w.testBox(tr.endpos, MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
      }
      if (spawnTried) expect(spawnOk).toBeGreaterThan(spawnTried * 0.5);

      // random traces inside the world bounds: endpos never in solid
      let wmin = v3(Infinity, Infinity, Infinity);
      let wmax = v3(-Infinity, -Infinity, -Infinity);
      for (const b of bsp.world) {
        wmin = v3(Math.min(wmin.x, b.mins.x), Math.min(wmin.y, b.mins.y), Math.min(wmin.z, b.mins.z));
        wmax = v3(Math.max(wmax.x, b.maxs.x), Math.max(wmax.y, b.maxs.y), Math.max(wmax.z, b.maxs.z));
      }
      const rnd = mulberry32(file.length * 7919);
      let free = 0;
      let hits = 0;
      let slivers = 0;
      const t2 = performance.now();
      const N = 30000;
      for (let i = 0; i < N; i++) {
        const s = v3(wmin.x + rnd() * (wmax.x - wmin.x), wmin.y + rnd() * (wmax.y - wmin.y), wmin.z + rnd() * (wmax.z - wmin.z));
        const len = i % 8 === 0 ? 3000 : 40;
        const e = v3(s.x + (rnd() - 0.5) * len, s.y + (rnd() - 0.5) * len, s.z + (rnd() - 0.5) * len);
        w.traceBox(s, e, MINS, MAXS, MASK_PLAYERSOLID, tr);
        if (tr.startsolid) continue;
        free++;
        if (tr.fraction < 1) hits++;
        if (w.testBox(tr.endpos, MINS, MAXS, MASK_PLAYERSOLID)) {
          // only a Source-style shaved-corner sliver is allowed
          const depth = worldDepth(w, tr.endpos, MINS, MAXS, MASK_PLAYERSOLID);
          if (depth > DIST_EPSILON + 1e-9) throw new Error(`endpos ${depth} deep in solid: ${JSON.stringify(s)} -> ${JSON.stringify(e)} f=${tr.fraction}`);
          slivers++;
        }
      }
      const traceMs = performance.now() - t2;
      console.log(
        `[collision] ${file}: v${bsp.version} read ${readMs.toFixed(0)} ms, build ${buildMs.toFixed(1)} ms, ` +
          `${st.brushes} brushes ${st.sides} sides (${bevels} compiler bevels), bvh depth ${st.depth}; ` +
          `bevels vs compiler (first 3000 brushes): ${missing} compiler bevels not reproduced, ${ourExtra} net extra; ` +
          `${bsp.spawns.length} spawns (${spawnOk} ok); ${N} traces ${traceMs.toFixed(0)} ms (${free} free, ${hits} hits, ${slivers} sliver ends)`,
      );
      expect(free).toBeGreaterThan(N * 0.05);
    });

    it(`${file}: surfing real ramps never snags on a neighbouring coplanar brush (compiler and regenerated bevels)`, () => {
      const bsp = readBspBrushes(join(MAPS_DIR!, file));
      if (!bsp) return;
      const regen: Brush[] = bsp.world.map((b) => {
        const c: Brush = { sides: b.sides.filter((s) => !s.bevel).map((s) => ({ plane: s.plane, bevel: false })), contents: b.contents, mins: b.mins, maxs: b.maxs, model: 0 };
        addBrushBevels(c);
        return c;
      });
      const worlds: [string, CollisionWorld, Brush[]][] = [
        ['compiler', new CollisionWorld(bsp.world), bsp.world],
        ['regenerated', new CollisionWorld(regen), regen],
      ];
      // surfable faces (0.1 < n.z < 0.7) of decent size
      const faces: { n: Vec3; w: Vec3[] }[] = [];
      for (const b of bsp.world) {
        if (!(b.contents & MASK_PLAYERSOLID)) continue;
        const ws = brushWindings(b);
        b.sides.forEach((s, i) => {
          const n = s.plane.normal;
          if (s.bevel || ws[i].length < 3 || n.z < 0.1 || n.z > 0.69) return;
          const nw = newell(ws[i]);
          if (Math.hypot(nw.x, nw.y, nw.z) / 2 > 128 * 128) faces.push({ n, w: ws[i] });
        });
      }
      const near = (a: Vec3, b: Vec3, eps: number) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < eps;
      const tr = newTrace();
      const summary: string[] = [];
      for (const [name, w, list] of worlds) {
        const rnd = mulberry32(17);
        let samples = 0;
        let ticks = 0;
        let losses = 0;
        let steps = 0;
        for (let k = 0; k < 250 && faces.length; k++) {
          const face = faces[Math.floor(rnd() * faces.length)];
          const fw = face.w;
          const t = 1 + Math.floor(rnd() * (fw.length - 2));
          let r1 = rnd();
          let r2 = rnd();
          if (r1 + r2 > 1) {
            r1 = 1 - r1;
            r2 = 1 - r2;
          }
          const p = v3(
            fw[0].x + (fw[t].x - fw[0].x) * r1 + (fw[t + 1].x - fw[0].x) * r2,
            fw[0].y + (fw[t].y - fw[0].y) * r1 + (fw[t + 1].y - fw[0].y) * r2,
            fw[0].z + (fw[t].z - fw[0].z) * r1 + (fw[t + 1].z - fw[0].z) * r2,
          );
          const fn = face.n;
          const start = v3(p.x + fn.x * 40, p.y + fn.y * 40, p.z + fn.z * 40 - 36);
          const sgn = rnd() < 0.5 ? 1 : -1;
          if (w.testBox(start, MINS, MAXS, MASK_PLAYERSOLID)) continue;
          w.traceBox(start, v3(start.x - fn.x * 80, start.y - fn.y * 80, start.z - fn.z * 80), MINS, MAXS, MASK_PLAYERSOLID, tr);
          if (tr.fraction === 1 || !near(tr.plane.normal, fn, 1e-3)) continue;
          // the plane we actually landed on (may belong to a neighbouring, nearly coplanar brush)
          const n = v3(tr.plane.normal.x, tr.plane.normal.y, tr.plane.normal.z);
          const rampD = tr.plane.dist;
          const hl = Math.hypot(n.x, n.y);
          samples++;
          let pos = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
          let vel = v3((-n.y / hl) * 1200 * sgn, (n.x / hl) * 1200 * sgn, 0);
          for (let tick = 0; tick < 60; tick++) {
            vel.z -= 800 * 0.01;
            const before = Math.hypot(vel.x, vel.y);
            const r = slideMove(w, pos, vel, 0.01, MINS, MAXS, MASK_PLAYERSOLID, tr);
            ticks++;
            const after = Math.hypot(r.vel.x, r.vel.y);
            const others = r.normals.filter((m) => !near(m, n, 1e-3));
            if (after < before * 0.98 && others.length) {
              losses++;
              // A legit stop is a wall / ramp end, or a map-geometry step (a neighbouring brush whose slope is
              // a fraction of a unit off ours - Source snags there too). Being stopped by a brush that
              // continues *exactly* our ramp plane would be a collision bug (seam snag).
              r.normals.forEach((m, i) => {
                if (near(m, n, 1e-3)) return;
                const hb = list[r.hitBrushes[i]];
                expect(hb).toBeDefined();
                if (hb.sides.some((s) => !s.bevel && near(s.plane.normal, n, 3e-6) && Math.abs(s.plane.dist - rampD) < 0.01)) {
                  throw new Error(`${name}: seam snag at ${JSON.stringify(r.pos)} normal ${JSON.stringify(m)}`);
                }
                if (hb.sides.some((s) => !s.bevel && near(s.plane.normal, n, 1e-3) && Math.abs(s.plane.dist - rampD) < 2)) steps++;
              });
              break;
            }
            if (!r.normals.some((m) => near(m, n, 1e-3))) break; // left the ramp
            pos = r.pos;
            vel = r.vel;
          }
        }
        summary.push(`${name}: ${samples} samples, ${ticks} ticks, ${losses} stops (${steps} on near-coplanar map steps)`);
        if (faces.length > 20) expect(samples).toBeGreaterThan(50);
      }
      console.log(`[collision] ${file} surf sim (${faces.length} ramp faces): ${summary.join('; ')}`);
    });
  }
});
