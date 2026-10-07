// Native triangle-mesh collision (displacement terrain): CollisionWorldOptions.triangles.
//
// Synthetic tests check the triangle hulls against an independent separating-axis overlap test and the
// documented trace semantics (DIST_EPSILON pull-back, startsolid/allsolid, two-sided faces, rays, masks,
// models). Real-map tests (SURF_TEST_MAPS, and SURF_TEST_MAPS_LARGE for surf_summer_ksf) compare the
// triangle world with the legacy prism-brush world on thousands of hull traces near displacement
// surfaces, drop hulls onto the terrain, and walk / surf players over it with playerMove.
//   SURF_TEST_MAPS=/path/to/maps npx vitest run tests/dispcoll.test.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CollisionBrushSet,
  DisplacementTriangles,
  buildBrushModels,
  buildDisplacementTriangles,
  collectCollisionBrushes,
  createCollisionWorld,
} from '../src/bsp/bspcollision';
import { parseEntities } from '../src/bsp/entities';
import { parseBsp } from '../src/bsp/reader';
import { qa } from '../src/core/angles';
import { Vec3, v3 } from '../src/core/vec3';
import { boxIntersectsBrush, CollisionWorld, TriangleSoup } from '../src/physics/collision';
import { categorizePosition, defaultMoveVars, playerHull, playerMove } from '../src/physics/movement';
import { IN_DUCK, IN_JUMP, PlayerState, createPlayerState, newMoveEvents, newUserCmd } from '../src/physics/playertypes';
import {
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  DIST_EPSILON,
  MASK_ALL,
  MASK_PLAYERSOLID,
  TraceResult,
  newTrace,
} from '../src/physics/types';
import { buildBoxWorld } from './fixtures/bsp_synth';
import { mulberry32 } from './helpers/movement_world';

const HULL_MINS = v3(-16, -16, 0);
const HULL_MAXS = v3(16, 16, 72);
const DUCK_MAXS = v3(16, 16, 54);

// ------------------------------------------------------------------------------------------ helpers

type Tri = [Vec3, Vec3, Vec3];

function soupOf(tris: Tri[], contents?: number | Int32Array, model?: number | Int32Array): TriangleSoup {
  const positions = new Float64Array(tris.length * 9);
  const indices = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => {
    t.forEach((p, k) => positions.set([p.x, p.y, p.z], i * 9 + k * 3));
    indices.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3);
  });
  return { positions, indices, contents, model };
}

const sub = (a: Vec3, b: Vec3) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const norm = (a: Vec3) => {
  const l = Math.hypot(a.x, a.y, a.z);
  return v3(a.x / l, a.y / l, a.z / l);
};

/**
 * Independent separating-axis test: the largest separation of the box (centre c, half extents e) from the
 * triangle over the 13 box/triangle axes. > 0: disjoint by at least that much; <= 0: overlapping, with
 * -result = the smallest penetration depth over the axes.
 */
function satSeparation(c: Vec3, e: Vec3, t: Tri): number {
  const axes: Vec3[] = [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1), norm(cross(sub(t[1], t[0]), sub(t[2], t[0])))];
  for (let i = 0; i < 3; i++) {
    const ed = sub(t[(i + 1) % 3], t[i]);
    for (const a of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)]) {
      const x = cross(ed, a);
      const l = Math.hypot(x.x, x.y, x.z);
      if (l > 1e-6 * Math.hypot(ed.x, ed.y, ed.z)) axes.push(v3(x.x / l, x.y / l, x.z / l));
    }
  }
  let best = -Infinity;
  for (const L of axes) {
    const p = t.map((q) => dot(q, L));
    const tmin = Math.min(...p);
    const tmax = Math.max(...p);
    const r = Math.abs(L.x) * e.x + Math.abs(L.y) * e.y + Math.abs(L.z) * e.z;
    const cl = dot(c, L);
    best = Math.max(best, tmin - (cl + r), cl - r - tmax);
  }
  return best;
}

function randomTri(rnd: () => number, size: number): Tri {
  const base = v3((rnd() - 0.5) * 200, (rnd() - 0.5) * 200, (rnd() - 0.5) * 200);
  const p = () => v3(base.x + (rnd() - 0.5) * size, base.y + (rnd() - 0.5) * size, base.z + (rnd() - 0.5) * size);
  return [p(), p(), p()];
}

// ------------------------------------------------------------------------------------------ synthetic

describe('triangle collision: basics', () => {
  const floor: Tri = [v3(0, 0, 0), v3(128, 0, 0), v3(0, 128, 0)]; // CCW from +z
  const world = new CollisionWorld([], { triangles: soupOf([floor]) });

  it('a dropped hull stops DIST_EPSILON above the triangle and reports its plane', () => {
    const tr = world.traceBox(v3(20, 20, 100), v3(20, 20, -100), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.endpos.z).toBeCloseTo(DIST_EPSILON, 9);
    expect(tr.plane.normal).toEqual(v3(0, 0, 1));
    expect(tr.plane.dist).toBeCloseTo(0, 12);
    expect(tr.startsolid).toBe(false);
    expect(tr.contents).toBe(CONTENTS_SOLID);
    expect(tr.model).toBe(0);
    expect(world.lastHitTriangle).toBe(0);
    expect(world.lastHitBrush).toBe(-1);
    // fraction 1 => endpos === end
    const miss = world.traceBox(v3(20, 20, 100), v3(20, 20, 50), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(miss.fraction).toBe(1);
    expect(miss.endpos).toEqual(v3(20, 20, 50));
    expect(world.lastHitTriangle).toBe(-1);
  });

  it('is two-sided: a hull rising from below stops DIST_EPSILON under it with the flipped plane', () => {
    const tr = world.traceBox(v3(20, 20, -200), v3(20, 20, 100), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.endpos.z + HULL_MAXS.z).toBeCloseTo(-DIST_EPSILON, 9);
    expect(tr.plane.normal).toEqual(v3(-0, -0, -1));
    expect(tr.plane.dist).toBeCloseTo(0, 12);
  });

  it('slides along the surface it rests on without re-hitting it', () => {
    const tr = newTrace();
    world.traceBox(v3(20, 20, 50), v3(20, 20, -50), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    const rest = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
    for (const [dx, dy] of [[50, 0], [0, 50], [30, 40], [-10, 5]]) {
      world.traceBox(rest, v3(rest.x + dx, rest.y + dy, rest.z), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
      expect(tr.fraction).toBe(1);
      expect(tr.startsolid).toBe(false);
    }
    expect(world.testBox(rest, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
  });

  it('startsolid / allsolid when the hull overlaps the triangle; testBox agrees; touching counts', () => {
    const embedded = v3(20, 20, -10);
    const tr = world.traceBox(embedded, v3(20, 20, -12), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.startsolid).toBe(true);
    expect(tr.allsolid).toBe(true);
    expect(tr.fraction).toBe(0);
    expect(tr.endpos).toEqual(embedded);
    // leaving: startsolid only, the triangle doesn't block
    const out = world.traceBox(embedded, v3(20, 20, 100), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(out.startsolid).toBe(true);
    expect(out.allsolid).toBe(false);
    expect(out.fraction).toBe(1);
    expect(world.testBox(embedded, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(true);
    // exactly touching from above / beside
    expect(world.testBox(v3(20, 20, 0), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(true);
    expect(world.testBox(v3(20, 20, 1e-9), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
    expect(world.testBox(v3(-16, 20, -10), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(true);
    expect(world.testBox(v3(-16.001, 20, -10), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
  });

  it('point traces hit both faces, miss beside the triangle and see no bevels', () => {
    const down = world.traceRay(v3(10, 10, 50), v3(10, 10, -50), MASK_ALL);
    expect(down.fraction).toBeCloseTo((50 - DIST_EPSILON) / 100, 12);
    expect(down.plane.normal).toEqual(v3(0, 0, 1));
    const up = world.traceRay(v3(10, 10, -50), v3(10, 10, 50), MASK_ALL);
    expect(up.endpos.z).toBeCloseTo(-DIST_EPSILON, 12);
    expect(up.plane.normal.z).toBe(-1);
    // beyond the hypotenuse x + y = 128 (a box would hit through the bevels)
    expect(world.traceRay(v3(70, 70, 50), v3(70, 70, -50), MASK_ALL).fraction).toBe(1);
    expect(world.traceBox(v3(70, 70, 50), v3(70, 70, -50), HULL_MINS, HULL_MAXS, MASK_ALL).fraction).toBeLessThan(1);
    // a point exactly on the triangle is inside (touching), like a point on a brush face
    expect(world.testBox(v3(10, 10, 0), v3(), v3(), MASK_ALL)).toBe(true);
    expect(world.traceRay(v3(10, 10, 0), v3(10, 10, 0), MASK_ALL).allsolid).toBe(true);
    // ... but has no volume for pointContents (Source's point contents don't see displacements)
    expect(world.pointContents(v3(10, 10, 0))).toBe(0);
    expect(world.pointContents(v3(10, 10, -0.5))).toBe(0);
  });

  it('rays cannot slip through the shared edges of a triangulated grid', () => {
    // 8x8 grid of 16-unit cells, alternating diagonals, gently bumped
    const tris: Tri[] = [];
    const h = (x: number, y: number) => 8 * Math.sin(x * 0.05) * Math.cos(y * 0.07);
    const P = (i: number, j: number) => v3(i * 16, j * 16, h(i * 16, j * 16));
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 8; j++) {
        if ((i + j) & 1) {
          tris.push([P(i, j), P(i + 1, j), P(i + 1, j + 1)], [P(i, j), P(i + 1, j + 1), P(i, j + 1)]);
        } else {
          tris.push([P(i, j), P(i + 1, j), P(i, j + 1)], [P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]);
        }
      }
    const grid = new CollisionWorld([], { triangles: soupOf(tris) });
    const rnd = mulberry32(5);
    let missed = 0;
    let n = 0;
    for (let k = 0; k < 4000; k++) {
      // aim exactly at grid lines / diagonals / vertices half of the time
      let x = 8 + rnd() * 112;
      let y = 8 + rnd() * 112;
      if (k % 4 === 0) x = Math.round(x / 16) * 16;
      if (k % 4 === 1) y = Math.round(y / 16) * 16;
      if (k % 4 === 2) y = Math.floor(y / 16) * 16 + (x % 16);
      const target = v3(x, y, h(x, y));
      const dir = norm(v3((rnd() - 0.5) * 2 * (k % 3), (rnd() - 0.5) * 2 * (k % 3), -1));
      const from = v3(target.x - dir.x * 40, target.y - dir.y * 40, target.z - dir.z * 40);
      const to = v3(target.x + dir.x * 40, target.y + dir.y * 40, target.z + dir.z * 40);
      n++;
      if (grid.traceRay(from, to, MASK_ALL).fraction >= 1) missed++;
      // and from below
      if (grid.traceRay(to, from, MASK_ALL).fraction >= 1) missed++;
    }
    expect(n).toBe(4000);
    expect(missed).toBe(0);
  });

  it('honours masks, per-triangle contents, models and setModelSolid', () => {
    const t1: Tri = [v3(0, 0, 0), v3(64, 0, 0), v3(0, 64, 0)];
    const t2: Tri = [v3(0, 0, 100), v3(64, 0, 100), v3(0, 64, 100)];
    const t3: Tri = [v3(0, 0, 200), v3(64, 0, 200), v3(0, 64, 200)];
    const w = new CollisionWorld([], {
      triangles: [soupOf([t1, t2], new Int32Array([CONTENTS_SOLID, CONTENTS_WATER])), soupOf([t3], CONTENTS_PLAYERCLIP, 7)],
    });
    expect(w.triangleCount).toBe(3);
    const down = (mask: number) => w.traceRay(v3(5, 5, 300), v3(5, 5, -50), mask);
    expect(down(MASK_PLAYERSOLID).endpos.z).toBeCloseTo(200 + DIST_EPSILON, 9);
    expect(down(MASK_PLAYERSOLID).model).toBe(7);
    expect(w.lastHitTriangle).toBe(2);
    expect(down(CONTENTS_WATER).endpos.z).toBeCloseTo(100 + DIST_EPSILON, 9);
    expect(down(CONTENTS_WATER).contents).toBe(CONTENTS_WATER);
    expect(w.lastHitTriangle).toBe(1);
    w.setModelSolid(7, false);
    expect(w.isModelSolid(7)).toBe(false);
    expect(down(MASK_PLAYERSOLID).endpos.z).toBeCloseTo(DIST_EPSILON, 9);
    expect(w.testBox(v3(5, 5, 190), HULL_MINS, HULL_MAXS, CONTENTS_PLAYERCLIP)).toBe(false);
    w.setModelSolid(7, true);
    expect(w.testBox(v3(5, 5, 190), HULL_MINS, HULL_MAXS, CONTENTS_PLAYERCLIP)).toBe(true);
    // brushes and triangles share one trace: the nearer one wins
    const st = w.stats();
    expect(st.triangles).toBe(3);
    expect(st.brushes).toBe(0);
  });

  it('drops degenerate triangles and bad indices; queries and accessors use triangle numbers', () => {
    const soup: TriangleSoup = {
      positions: [0, 0, 0, 64, 0, 0, 0, 64, 0, 128, 0, 0, NaN, 0, 0],
      indices: [0, 1, 2, 0, 1, 3, 0, 1, 9, 2, 1, 0, 0, 4, 1], // ok, collinear, bad index, ok (flipped), NaN
    };
    const w = new CollisionWorld([], { triangles: soup });
    expect(w.triangleCount).toBe(2);
    expect(w.triangle(1)).toBeNull();
    expect(w.triangle(2)).toBeNull();
    expect(w.triangle(4)).toBeNull();
    const t3 = w.triangle(3)!;
    expect(t3.normal).toEqual(v3(0, 0, -1)); // clockwise from +z: front faces down
    const seen: number[] = [];
    w.queryTriangles(v3(-1, -1, -1), v3(1, 1, 1), (t) => seen.push(t));
    expect(seen.sort()).toEqual([0, 3]);
    seen.length = 0;
    w.queryTriangles(v3(100, 100, -1), v3(200, 200, 1), (t) => seen.push(t));
    expect(seen).toEqual([]);
    // the zero-volume brush form works with brush code (trigger-style overlap)
    const br = w.triangleBrush(0)!;
    expect(boxIntersectsBrush(v3(4, 4, -10), v3(36, 36, 62), br)).toBe(true);
    expect(boxIntersectsBrush(v3(4, 4, 1), v3(36, 36, 73), br)).toBe(false);
    expect(boxIntersectsBrush(v3(60, 60, -10), v3(92, 92, 62), br)).toBe(false); // beyond the hypotenuse
  });

  it('a box sweep agrees with an independent separating-axis test (random triangles and sweeps)', () => {
    const rnd = mulberry32(42);
    let hits = 0;
    let misses = 0;
    let starts = 0;
    let worstShave = 0;
    for (let k = 0; k < 3000; k++) {
      const t = randomTri(rnd, k % 3 === 0 ? 8 : k % 3 === 1 ? 64 : 300);
      const w = new CollisionWorld([], { triangles: soupOf([t]) });
      const tri = w.triangle(0);
      if (!tri) continue;
      const e = v3(2 + rnd() * 20, 2 + rnd() * 20, 2 + rnd() * 40);
      const mins = v3(-e.x, -e.y, -e.z);
      const centre = v3((t[0].x + t[1].x + t[2].x) / 3, (t[0].y + t[1].y + t[2].y) / 3, (t[0].z + t[1].z + t[2].z) / 3);
      const s = v3(centre.x + (rnd() - 0.5) * 300, centre.y + (rnd() - 0.5) * 300, centre.z + (rnd() - 0.5) * 300);
      const aim = rnd() < 0.7;
      const end = aim
        ? v3(centre.x + (rnd() - 0.5) * 60 + (centre.x - s.x) * rnd(), centre.y + (rnd() - 0.5) * 60 + (centre.y - s.y) * rnd(), centre.z + (rnd() - 0.5) * 60 + (centre.z - s.z) * rnd())
        : v3(s.x + (rnd() - 0.5) * 400, s.y + (rnd() - 0.5) * 400, s.z + (rnd() - 0.5) * 400);
      const tr = w.traceBox(s, end, mins, e, MASK_ALL);
      const sep0 = satSeparation(s, e, t);
      expect(tr.startsolid).toBe(sep0 <= 0);
      expect(w.testBox(s, mins, e, MASK_ALL)).toBe(sep0 <= 0);
      if (tr.startsolid) {
        starts++;
        continue;
      }
      const len = Math.hypot(end.x - s.x, end.y - s.y, end.z - s.z);
      if (tr.fraction < 1) {
        hits++;
        // DIST_EPSILON off the reported (unexpanded) plane, pushed out by the box
        const n = tr.plane.normal;
        expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 9);
        const r = Math.abs(n.x) * e.x + Math.abs(n.y) * e.y + Math.abs(n.z) * e.z;
        if (tr.fraction > 0) expect(dot(tr.endpos, n) - tr.plane.dist - r).toBeCloseTo(DIST_EPSILON, 6);
        // the reported plane supports the triangle
        for (const p of t) expect(dot(p, n)).toBeLessThanOrEqual(tr.plane.dist + 1e-6);
        // the box never overlapped the triangle before stopping
        for (let i = 0; i <= 20; i++) {
          const f = (tr.fraction * i) / 20;
          const c = v3(s.x + (end.x - s.x) * f, s.y + (end.y - s.y) * f, s.z + (end.z - s.z) * f);
          expect(satSeparation(c, e, t)).toBeGreaterThan(-1e-7);
        }
        // and it did reach the triangle: a bit further along it would touch / overlap
        const fc = Math.min(1, tr.fraction + (2 * DIST_EPSILON) / Math.max(len, 1e-9) + 1e-9);
        const c2 = v3(s.x + (end.x - s.x) * fc, s.y + (end.y - s.y) * fc, s.z + (end.z - s.z) * fc);
        expect(satSeparation(c2, e, t)).toBeLessThan(DIST_EPSILON + 1e-6);
      } else {
        misses++;
        // no hit: at most a corner shave shallower than DIST_EPSILON anywhere along the sweep
        for (let i = 0; i <= 200; i++) {
          const f = i / 200;
          const c = v3(s.x + (end.x - s.x) * f, s.y + (end.y - s.y) * f, s.z + (end.z - s.z) * f);
          const sep = satSeparation(c, e, t);
          worstShave = Math.max(worstShave, -sep);
          expect(sep).toBeGreaterThan(-DIST_EPSILON - 1e-6);
        }
      }
    }
    expect(hits).toBeGreaterThan(500);
    expect(misses).toBeGreaterThan(500);
    expect(starts).toBeGreaterThan(20);
    expect(worstShave).toBeLessThan(DIST_EPSILON);
  });

  it('the synthetic BSP displacement collides like its prisms (top surface)', () => {
    const bsp = parseBsp(buildBoxWorld().buffer);
    const ents = parseEntities(bsp.entitiesText);
    const models = buildBrushModels(bsp, { entities: ents });
    const tri = collectCollisionBrushes(bsp, ents, models, { displacements: 'triangles' });
    const pri = collectCollisionBrushes(bsp, ents, models);
    expect(tri.triangles!.indices.length / 3).toBe(8);
    expect(tri.brushes.length).toBe(pri.brushes.length - 8);
    const wt = createCollisionWorld(tri);
    const wp = createCollisionWorld(pri);
    expect(wt.triangleCount).toBe(8);
    for (let x = 2; x < 64; x += 5)
      for (let y = 2; y < 64; y += 5) {
        const a = wt.traceBox(v3(x, y, 200), v3(x, y, -30), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
        const b = wp.traceBox(v3(x, y, 200), v3(x, y, -30), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
        expect(a.endpos.z).toBeCloseTo(b.endpos.z, 6);
        expect(a.plane.normal.z).toBeCloseTo(b.plane.normal.z, 6);
        const ra = wt.traceRay(v3(x, y, 200), v3(x, y, -30), MASK_PLAYERSOLID);
        const rb = wp.traceRay(v3(x, y, 200), v3(x, y, -30), MASK_PLAYERSOLID);
        expect(ra.endpos.z).toBeCloseTo(rb.endpos.z, 6);
      }
    // no-hull-collision displacements produce no triangles
    const w: string[] = [];
    expect(buildDisplacementTriangles(parseBsp(buildBoxWorld({ dispMinTess: 0x80000000 | 4 }).buffer), { warnings: w }).indices.length).toBe(0);
    expect(w).toEqual(['1 displacements flagged without hull collision']);
  });
});

// ------------------------------------------------------------------------------------------ real maps

function listMaps(env: string | undefined, names: string[] | null): string[] {
  if (!env || !existsSync(env)) return [];
  if (statSync(env).isFile()) return env.endsWith('.bsp') ? [env] : [];
  return readdirSync(env)
    .filter((f) => f.toLowerCase().endsWith('.bsp') && (!names || names.includes(basename(f, '.bsp').toLowerCase())))
    .sort()
    .map((f) => join(env, f));
}

const MAP_NAMES = ['surf_mesa_fixed', 'surf_rookie', 'surf_beginner', 'surf_ing', 'surf_aircontrol_ksf'];
const MAPS = [...listMaps(process.env.SURF_TEST_MAPS, MAP_NAMES), ...listMaps(process.env.SURF_TEST_MAPS_LARGE, ['surf_summer_ksf'])];

interface Sample {
  p: Vec3; // point on a triangle
  n: Vec3; // its front normal
  tri: number;
}

function sampleTriangle(soup: DisplacementTriangles, rnd: () => number, filter?: (n: Vec3) => boolean): Sample | null {
  const P = soup.positions;
  const I = soup.indices;
  const count = I.length / 3;
  for (let attempt = 0; attempt < 200; attempt++) {
    const t = Math.floor(rnd() * count);
    const a = v3(P[I[t * 3] * 3], P[I[t * 3] * 3 + 1], P[I[t * 3] * 3 + 2]);
    const b = v3(P[I[t * 3 + 1] * 3], P[I[t * 3 + 1] * 3 + 1], P[I[t * 3 + 1] * 3 + 2]);
    const c = v3(P[I[t * 3 + 2] * 3], P[I[t * 3 + 2] * 3 + 1], P[I[t * 3 + 2] * 3 + 2]);
    const n = norm(cross(sub(b, a), sub(c, a)));
    if (filter && !filter(n)) continue;
    let u = rnd();
    let v = rnd();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const p = v3(a.x + (b.x - a.x) * u + (c.x - a.x) * v, a.y + (b.y - a.y) * u + (c.y - a.y) * v, a.z + (b.z - a.z) * u + (c.z - a.z) * v);
    return { p, n, tri: t };
  }
  return null;
}

describe.skipIf(MAPS.length === 0)('displacement triangles vs prisms on real maps', () => {
  for (const path of MAPS) {
    const name = basename(path, '.bsp');
    describe(name, () => {
      let soup: DisplacementTriangles;
      let triSet: CollisionBrushSet;
      let worldT: CollisionWorld; // brushes + displacement triangles (the loader's default)
      let worldP: CollisionWorld; // brushes + 2-unit prisms (legacy)
      let worldThin: CollisionWorld; // brushes + 0.005-unit prisms (a triangle with walls, as a brush)
      let triOnly: CollisionWorld; // just the displacement triangles (fall-through detection)
      let empty = false;

      beforeAll(() => {
        const b = readFileSync(path);
        const bsp = parseBsp(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
        const ents = parseEntities(bsp.entitiesText);
        const models = buildBrushModels(bsp, { entities: ents });
        let t = performance.now();
        triSet = collectCollisionBrushes(bsp, ents, models, { displacements: 'triangles' });
        worldT = createCollisionWorld(triSet);
        const tTri = performance.now() - t;
        soup = triSet.triangles!;
        t = performance.now();
        const prismSet = collectCollisionBrushes(bsp, ents, models, { displacements: 'prisms' });
        worldP = createCollisionWorld(prismSet);
        const tPrism = performance.now() - t;
        worldThin = createCollisionWorld(collectCollisionBrushes(bsp, ents, models, { displacements: 'prisms', thickness: 0.005 }));
        triOnly = new CollisionWorld([], { triangles: soup });
        empty = soup.indices.length === 0;
        console.log(
          `[dispcoll] ${name}: ${soup.indices.length / 3} triangles / ${prismSet.brushes.length - triSet.brushes.length} prisms; ` +
            `collision build: triangles ${tTri.toFixed(0)} ms, prisms ${tPrism.toFixed(0)} ms`,
        );
        expect(prismSet.brushes.length - triSet.brushes.length).toBe(soup.indices.length / 3);
        expect(worldT.triangleCount).toBe(soup.indices.length / 3);
      }, 240000);

      afterAll(() => {
        worldP = worldThin = worldT = triOnly = undefined as unknown as CollisionWorld;
      });

      it('hull traces near displacement surfaces match the prism world', () => {
        if (empty) {
          // nothing collidable (e.g. every displacement flagged "no hull collision"): identical worlds
          expect(worldP.stats().brushes).toBe(worldT.stats().brushes);
          return;
        }
        const rnd = mulberry32(1234);
        const tT = newTrace();
        const tP = newTrace();
        const tThin = newTrace();
        const N = 6000;
        let traced = 0;
        let hitsT = 0;
        let agree = 0;
        let thickness = 0; // differs from the 2-unit prisms, agrees with zero-thickness ones: prism depth
        const odd: string[] = [];
        let unexplained = 0;
        let startDiff = 0;
        let normalDiff = 0;
        const pos = (tr: TraceResult) => tr.endpos;
        // identical: same start state, endpos within 0.01, same plane
        const identical = (a: TraceResult, b: TraceResult) => {
          if (a.startsolid !== b.startsolid || a.allsolid !== b.allsolid || (a.fraction < 1) !== (b.fraction < 1)) return false;
          const d = Math.hypot(pos(a).x - pos(b).x, pos(a).y - pos(b).y, pos(a).z - pos(b).z);
          if (d > 0.01) return false;
          return a.fraction >= 1 || dot(a.plane.normal, b.plane.normal) > 0.999 || d < 1e-3;
        };
        // equivalent up to a small shift of the hull planes: both stop on the same plane within `tol` of
        // each other measured along its normal (grazing sweeps amplify plane shifts along the path)
        const equivalent = (a: TraceResult, b: TraceResult, tol: number) => {
          if (identical(a, b)) return true;
          if (a.startsolid !== b.startsolid || a.allsolid !== b.allsolid || a.fraction >= 1 || b.fraction >= 1) return false;
          const n = a.plane.normal;
          if (dot(n, b.plane.normal) < 0.999) return false;
          return Math.abs(dot(sub(pos(a), pos(b)), n)) <= tol;
        };
        for (let k = 0; k < N; k++) {
          const s = sampleTriangle(soup, rnd);
          if (!s) break;
          const ducked = k % 5 === 0;
          const maxs = ducked ? DUCK_MAXS : HULL_MAXS;
          const half = maxs.z / 2;
          // start in front of the surface (box centre 0..96 units off it), sweep mostly into it
          const h = half * Math.abs(s.n.z) + 16 * (Math.abs(s.n.x) + Math.abs(s.n.y)) + rnd() * 96;
          const c = v3(s.p.x + s.n.x * h + (rnd() - 0.5) * 64, s.p.y + s.n.y * h + (rnd() - 0.5) * 64, s.p.z + s.n.z * h + (rnd() - 0.5) * 64);
          const dir = norm(v3(-s.n.x * 1.2 + (rnd() - 0.5) * 2, -s.n.y * 1.2 + (rnd() - 0.5) * 2, -s.n.z * 1.2 + (rnd() - 0.5) * 2));
          const len = rnd() < 0.2 ? rnd() * 8 : 20 + rnd() * 300;
          const start = v3(c.x, c.y, c.z - half);
          const end = v3(start.x + dir.x * len, start.y + dir.y * len, start.z + dir.z * len);
          worldT.traceBox(start, end, HULL_MINS, maxs, MASK_PLAYERSOLID, tT);
          worldP.traceBox(start, end, HULL_MINS, maxs, MASK_PLAYERSOLID, tP);
          traced++;
          if (tT.startsolid !== tP.startsolid) startDiff++;
          if (tT.fraction < 1) hitsT++;
          if (identical(tT, tP)) {
            agree++;
            continue;
          }
          worldThin.traceBox(start, end, HULL_MINS, maxs, MASK_PLAYERSOLID, tThin);
          if (equivalent(tT, tThin, 0.02)) {
            thickness++;
            continue;
          }
          if (tT.fraction < 1 && tThin.fraction < 1 && Math.abs(tT.fraction - tThin.fraction) * len < 0.05) {
            normalDiff++; // same stop, a different (tied) plane: an edge or vertex contact
            continue;
          }
          unexplained++;
          if (odd.length < 8) {
            odd.push(
              `start ${start.x.toFixed(2)},${start.y.toFixed(2)},${start.z.toFixed(2)} end ${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)} ` +
                `duck ${ducked}: tri f ${tT.fraction.toFixed(5)} n ${tT.plane.normal.z.toFixed(3)} ss ${tT.startsolid}; ` +
                `thin f ${tThin.fraction.toFixed(5)} n ${tThin.plane.normal.z.toFixed(3)} ss ${tThin.startsolid}; prism f ${tP.fraction.toFixed(5)}`,
            );
          }
        }
        console.log(
          `[dispcoll] ${name}: ${traced} hull traces (${hitsT} hits): ${agree} identical to the prisms, ${thickness} differ only by the ` +
            `prism depth, ${normalDiff} same stop on a tied edge plane, ${unexplained} unexplained; startsolid differs ${startDiff}` +
            (odd.length ? `\n  ${odd.join('\n  ')}` : ''),
        );
        expect(traced).toBeGreaterThan(Math.min(N, 1000));
        expect(hitsT).toBeGreaterThan(traced * 0.3);
        // most sweeps are bit-identical; the rest stop where a zero-thickness brush of the triangle stops
        // (the 2-unit prisms bulge past convex creases and grow edge bevels from their bottom vertices)
        expect(agree).toBeGreaterThan(traced * 0.8);
        expect(agree + thickness + normalDiff).toBeGreaterThanOrEqual(traced * 0.998);
        expect(unexplained).toBeLessThanOrEqual(Math.ceil(traced * 0.002));
      });

      it('a dropped hull lands on the terrain at random points (never falls through)', () => {
        if (empty) return;
        const rnd = mulberry32(99);
        const tT = newTrace();
        const tP = newTrace();
        let dropped = 0;
        let fell = 0;
        let lower = 0; // rests lower than on the prisms (their extra depth bulges past convex creases)
        let higher = 0; // rests higher than on the prisms: impossible, prism hulls contain the triangles
        let maxLower = 0;
        const notes: string[] = [];
        for (let k = 0; k < 1500; k++) {
          const s = sampleTriangle(soup, rnd);
          if (!s) break;
          const start = v3(s.p.x + (rnd() - 0.5) * 30, s.p.y + (rnd() - 0.5) * 30, s.p.z + 40 + rnd() * 200);
          if (worldT.testBox(start, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)) continue;
          const end = v3(start.x, start.y, s.p.z - 4000);
          worldT.traceBox(start, end, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tT);
          worldP.traceBox(start, end, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tP);
          dropped++;
          // the triangle point under the footprint, offset within the footprint, must stop the hull above it
          const footprintHit = Math.abs(start.x - s.p.x) <= 16 && Math.abs(start.y - s.p.y) <= 16;
          if (tT.startsolid || tT.fraction >= 1 || (footprintHit && tT.endpos.z < s.p.z)) {
            fell++;
            if (notes.length < 5) notes.push(`start ${start.x.toFixed(1)},${start.y.toFixed(1)},${start.z.toFixed(1)} p.z ${s.p.z.toFixed(2)} end z ${tT.endpos.z.toFixed(2)} f ${tT.fraction}`);
          }
          const dz = tT.endpos.z - tP.endpos.z;
          if (dz < -0.01) {
            lower++;
            maxLower = Math.max(maxLower, -dz);
          }
          if (dz > 0.01 && !tP.startsolid) {
            higher++;
            if (notes.length < 5) notes.push(`higher than prisms by ${dz.toFixed(3)} from ${start.x.toFixed(1)},${start.y.toFixed(1)},${start.z.toFixed(1)}`);
          }
        }
        console.log(
          `[dispcoll] ${name}: ${dropped} hull drops, ${fell} fell through; ${dropped - lower - higher} rest where they do on the prisms, ` +
            `${lower} lower (up to ${maxLower.toFixed(2)} units: the prisms' depth bulges past convex creases), ${higher} higher` +
            (notes.length ? `\n  ${notes.join('\n  ')}` : ''),
        );
        expect(dropped).toBeGreaterThan(100);
        expect(fell).toBe(0);
        expect(higher).toBe(0);
      });

      it('players walking and surfing on the terrain never end in solid or pass through it', () => {
        if (empty) return;
        const vars = defaultMoveVars();
        const FT = 0.01;
        const rnd = mulberry32(2024);
        const tr = newTrace();
        let players = 0;
        let ticks = 0;
        let inSolid = 0;
        let crossings = 0;
        let nan = 0;
        let groundTicks = 0;
        const notes: string[] = [];
        const inSolidAt = (ps: PlayerState) => {
          const h = playerHull(ps);
          return worldT.testBox(ps.origin, h.mins, h.maxs, MASK_PLAYERSOLID);
        };
        const prev = v3();
        const cur = v3();
        const nPlayers = 48;
        let surfers = 0;
        for (let k = 0; k < nPlayers * 4 && players < nPlayers; k++) {
          const surf = k % 2 === 1;
          // walkers start on walkable triangles, surfers on steep ones (surf ramps)
          const s = sampleTriangle(soup, rnd, surf ? (n) => n.z > 0.2 && n.z < 0.7 : (n) => n.z >= 0.7);
          if (!s) continue;
          const start = v3(s.p.x + s.n.x * 40, s.p.y + s.n.y * 40, s.p.z + s.n.z * 40 - 36 * (1 - s.n.z));
          worldT.traceBox(start, v3(start.x - s.n.x * 120, start.y - s.n.y * 120, start.z - s.n.z * 120), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
          if (tr.startsolid || tr.fraction >= 1) continue;
          players++;
          if (surf) surfers++;
          const ps = createPlayerState(v3(tr.endpos.x, tr.endpos.y, tr.endpos.z), qa(0, rnd() * 360, 0));
          const cmd = newUserCmd();
          const ev = newMoveEvents();
          let smove = 0;
          if (surf) {
            // along the ramp horizontally at surf speed, holding into it
            let tx = -s.n.y;
            let ty = s.n.x;
            const tl = Math.hypot(tx, ty) || 1;
            tx /= tl;
            ty /= tl;
            ps.velocity = v3(tx * 1000, ty * 1000, 0);
            const yaw = (Math.atan2(ty, tx) * 180) / Math.PI;
            cmd.viewangles.yaw = yaw;
            const rx = Math.sin((yaw * Math.PI) / 180);
            const ry = -Math.cos((yaw * Math.PI) / 180);
            smove = rx * -s.n.x + ry * -s.n.y > 0 ? 450 : -450;
          }
          categorizePosition(ps, worldT, vars);
          for (let i = 0; i < 800; i++) {
            if (surf) {
              cmd.sidemove = i % 75 < 50 ? smove : 0;
            } else if (i % 25 === 0) {
              cmd.forwardmove = rnd() < 0.7 ? 450 : 0;
              cmd.sidemove = rnd() < 0.4 ? (rnd() < 0.5 ? 450 : -450) : 0;
              cmd.buttons = (rnd() < 0.3 ? IN_JUMP : 0) | (rnd() < 0.15 ? IN_DUCK : 0);
              cmd.viewangles.yaw = rnd() * 360;
            }
            prev.x = ps.origin.x;
            prev.y = ps.origin.y;
            prev.z = ps.origin.z + 1;
            playerMove(ps, cmd, worldT, vars, FT, ev);
            ticks++;
            const o = ps.origin;
            if (!Number.isFinite(o.x + o.y + o.z)) {
              nan++;
              break;
            }
            if (ps.onGround) groundTicks++;
            if (inSolidAt(ps)) {
              inSolid++;
              if (notes.length < 6) notes.push(`in solid at ${o.x.toFixed(2)},${o.y.toFixed(2)},${o.z.toFixed(2)} (${surf ? 'surf' : 'walk'})`);
            }
            // a point 1 unit above the feet passing through a displacement triangle = the hull went through it
            cur.x = o.x;
            cur.y = o.y;
            cur.z = o.z + 1;
            triOnly.traceRay(prev, cur, MASK_ALL, tr);
            if (tr.fraction < 1 && !tr.startsolid) {
              crossings++;
              if (notes.length < 6) notes.push(`crossed terrain ${prev.x.toFixed(2)},${prev.y.toFixed(2)},${prev.z.toFixed(2)} -> ${cur.x.toFixed(2)},${cur.y.toFixed(2)},${cur.z.toFixed(2)}`);
            }
          }
        }
        console.log(
          `[dispcoll] ${name}: ${players} players (${surfers} surfing), ${ticks} ticks (${groundTicks} on ground): inSolid ${inSolid}, terrain crossings ${crossings}, NaN ${nan}` +
            (notes.length ? `\n  ${notes.join('\n  ')}` : ''),
        );
        expect(players).toBeGreaterThanOrEqual(Math.min(nPlayers / 2, 8));
        expect(nan).toBe(0);
        expect(inSolid).toBe(0);
        expect(crossings).toBe(0);
      });

      it('trace cost near terrain is comparable to the prism world', () => {
        if (empty) return;
        const rnd = mulberry32(77);
        const starts: Vec3[] = [];
        const ends: Vec3[] = [];
        for (let k = 0; k < 20000; k++) {
          const s = sampleTriangle(soup, rnd);
          if (!s) break;
          const c = v3(s.p.x + s.n.x * 40, s.p.y + s.n.y * 40, s.p.z + s.n.z * 40 - 36);
          starts.push(c);
          ends.push(v3(c.x + (rnd() - 0.5) * 40, c.y + (rnd() - 0.5) * 40, c.z - rnd() * 60));
        }
        const tr = newTrace();
        const time = (w: CollisionWorld) => {
          let best = Infinity;
          for (let rep = 0; rep < 3; rep++) {
            const t = performance.now();
            for (let i = 0; i < starts.length; i++) w.traceBox(starts[i], ends[i], HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
            best = Math.min(best, performance.now() - t);
          }
          return (best * 1000) / starts.length;
        };
        const usT = time(worldT);
        const usP = time(worldP);
        console.log(`[dispcoll] ${name}: hull trace near terrain: triangles ${usT.toFixed(2)} us, prisms ${usP.toFixed(2)} us`);
        expect(usT).toBeLessThan(Math.max(usP * 2, 20));
      });
    });
  }
});
