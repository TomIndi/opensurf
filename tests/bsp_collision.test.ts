// BSP collision geometry tests: brush models, placement, displacement prisms, brush entity solidity.
import { describe, expect, it } from 'vitest';
import { qa } from '../src/core/angles';
import { v3 } from '../src/core/vec3';
import { MapEntity } from '../src/map/types';
import {
  PackedBrush,
  brushEntityPlacement,
  brushEntityStartsEnabled,
  brushFromBsp,
  buildBrushModels,
  collectCollisionBrushes,
  buildDisplacementBrushes,
  dispFlags,
  displacementSurface,
  isSolidBrushEntity,
  transformBrush,
  trianglePrismBrush,
  trianglePrismPlanes,
} from '../src/bsp/bspcollision';
import { parseEntities } from '../src/bsp/entities';
import { parseBsp } from '../src/bsp/reader';
import { BspFile } from '../src/bsp/types';
import { brushFromPlanes, computeBrushBounds } from '../src/physics/brushbuild';
import { CollisionWorld } from '../src/physics/collision';
import { Brush, CONTENTS_SOLID, MASK_PLAYERSOLID } from '../src/physics/types';
import { buildBoxWorld } from './fixtures/bsp_synth';

const close = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;
const vclose = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, eps = 1e-4) =>
  close(a.x, b.x, eps) && close(a.y, b.y, eps) && close(a.z, b.z, eps);

function inside(brush: Brush, p: { x: number; y: number; z: number }, eps = 1e-6): boolean {
  return brush.sides.every((s) => s.plane.normal.x * p.x + s.plane.normal.y * p.y + s.plane.normal.z * p.z <= s.plane.dist + eps);
}

describe('buildBrushModels', () => {
  const bsp = parseBsp(buildBoxWorld().buffer);

  it('builds world brushes with BSP planes, bevel flags, contents and bounds', () => {
    const models = buildBrushModels(bsp);
    expect(models.length).toBe(3);
    const w = models[0];
    expect(w.index).toBe(0);
    expect(w.brushes.length).toBe(1);
    expect(w.brushes[0]).toMatchObject({ contents: CONTENTS_SOLID, model: 0, mins: v3(-512, -512, -64), maxs: v3(512, 512, 0) });
    expect(w.brushes[0].sides.length).toBe(6); // no bevels added
    expect(w.mins).toEqual(v3(-512, -512, -64));
  });

  it('places brush entity models at their entity origin (translation keeps BSP bevels)', () => {
    const m1 = buildBrushModels(bsp)[1];
    expect(m1.origin).toEqual(v3(100, 0, 50));
    expect(m1.brushes.length).toBe(1);
    const b = m1.brushes[0];
    expect(b.model).toBe(1);
    expect(b.mins).toEqual(v3(84, -16, 34));
    expect(b.maxs).toEqual(v3(116, 16, 66));
    expect(m1.mins).toEqual(v3(84, -16, 34));
    expect(inside(b, { x: 100, y: 0, z: 50 })).toBe(true);
    expect(inside(b, { x: 0, y: 0, z: 0 })).toBe(false);
  });

  it('rotates brush entity models by the entity angles', () => {
    const m2 = buildBrushModels(bsp)[2];
    const b = m2.brushes[0];
    expect(b.contents).toBe(0x40000000);
    // 64x16x16 box yawed 90 degrees at (0, 300, 40)
    expect(vclose(b.mins, v3(-8, 268, 32))).toBe(true);
    expect(vclose(b.maxs, v3(8, 332, 48))).toBe(true);
    expect(inside(b, { x: 0, y: 330, z: 40 }, 1e-3)).toBe(true);
    expect(inside(b, { x: 30, y: 300, z: 40 }, 1e-3)).toBe(false);
    // bevels were rebuilt for the new orientation: exactly six axial planes at the bounds
    const axial = b.sides.filter((s) => Math.abs(Math.abs(s.plane.normal.x) + Math.abs(s.plane.normal.y) + Math.abs(s.plane.normal.z) - 1) < 1e-9);
    expect(axial.length).toBe(6);
  });

  it('keeps model space on request and accepts explicit entities', () => {
    const raw = buildBrushModels(bsp, { space: 'model' });
    expect(raw[1].brushes[0].mins).toEqual(v3(-16, -16, -16));
    expect(raw[1].origin).toEqual(v3(0, 0, 0));
    const ents = parseEntities(bsp.entitiesText);
    ents[2].origin = v3(0, 0, 1000);
    const moved = buildBrushModels(bsp, { entities: ents });
    expect(moved[1].brushes[0].mins).toEqual(v3(-16, -16, 984));
  });

  it('counts degenerate brushes and falls back to axial bounds for zero-thickness ones', () => {
    const planes = [
      { normal: v3(-1, 0, 0), dist: 0, type: 0 },
      { normal: v3(1, 0, 0), dist: 0, type: 0 }, // x == 0 slab
      { normal: v3(0, -1, 0), dist: 10, type: 1 },
      { normal: v3(0, 1, 0), dist: 10, type: 1 },
      { normal: v3(0, 0, -1), dist: 10, type: 2 },
      { normal: v3(0, 0, 1), dist: 10, type: 2 },
      { normal: v3(1, 0, 0), dist: -5, type: 0 }, // contradicts -x <= 0
    ];
    const side = (planeNum: number) => ({ planeNum, texInfo: 0, dispInfo: -1, bevel: false, thin: false });
    const fake = {
      planes,
      brushes: [
        { firstSide: 0, numSides: 6, contents: 1 },
        { firstSide: 6, numSides: 6, contents: 1 },
      ],
      brushSides: [0, 1, 2, 3, 4, 5, 0, 6, 2, 3, 4, 5].map(side),
    } as unknown as BspFile;
    const slab = brushFromBsp(fake, 0, 0)!;
    expect(slab).not.toBeNull();
    expect(slab.mins).toEqual(v3(0, -10, -10));
    expect(slab.maxs).toEqual(v3(0, 10, 10));
    expect(brushFromBsp(fake, 1, 0)).toBeNull();
  });

  it('transformBrush is a pure function', () => {
    const b = buildBrushModels(bsp, { space: 'model' })[1].brushes[0];
    const before = JSON.stringify(b);
    const moved = transformBrush(b, v3(1, 2, 3), qa(0, 45, 0));
    expect(JSON.stringify(b)).toBe(before);
    expect(computeBrushBounds({ ...moved, mins: v3(), maxs: v3() })).toBe(true);
  });
});

describe('displacements', () => {
  it('rebuilds the vertex grid (rows corner0->corner1, columns towards corner3) and CCW triangles', () => {
    const bsp = parseBsp(buildBoxWorld().buffer);
    const s = displacementSurface(bsp, 0)!;
    expect(s.size).toBe(3);
    const P = (r: number, c: number) => {
      const o = (r * 3 + c) * 3;
      return v3(s.positions[o], s.positions[o + 1], s.positions[o + 2]);
    };
    expect(P(0, 0)).toEqual(v3(0, 0, 0));
    expect(P(2, 0)).toEqual(v3(0, 64, 0)); // corner 1 (rows run along +y here)
    expect(P(0, 2)).toEqual(v3(64, 0, 0)); // corner 3
    expect(P(1, 1)).toEqual(v3(32, 32, 16)); // raised centre
    expect(s.triangles.length).toBe(8 * 3);
    // every triangle faces +z (the base face's front), and uses the alternating diagonals:
    // cell (0,0) (even) is split along (0,0)-(1,1), cell (0,1) (odd) along (0,2)-(1,1)
    for (let t = 0; t < 8; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => s.triangles[t * 3 + k]);
      const pa = P(Math.floor(a / 3), a % 3);
      const pb = P(Math.floor(b / 3), b % 3);
      const pc = P(Math.floor(c / 3), c % 3);
      const nz = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
      expect(nz).toBeGreaterThan(0);
    }
    const cell0 = new Set([...s.triangles.subarray(0, 6)]);
    expect([...cell0].sort()).toEqual([0, 1, 3, 4]);
    const tri0 = [...s.triangles.subarray(0, 3)].sort();
    const tri1 = [...s.triangles.subarray(3, 6)].sort();
    expect(tri0.includes(0) && tri0.includes(4) && tri1.includes(0) && tri1.includes(4)).toBe(true); // diagonal 0-4
    const t2 = [...s.triangles.subarray(6, 9)].sort();
    const t3 = [...s.triangles.subarray(9, 12)].sort();
    expect(t2.includes(2) && t2.includes(4) && t3.includes(2) && t3.includes(4)).toBe(true); // diagonal 2-4
  });

  it('builds one prism per triangle and honours the collision flags', () => {
    const bsp = parseBsp(buildBoxWorld().buffer);
    const prisms = buildDisplacementBrushes(bsp);
    expect(prisms.length).toBe(8);
    for (const p of prisms) {
      expect(p.model).toBe(0);
      expect(p.contents).toBe(CONTENTS_SOLID);
      expect(p.maxs.z).toBeLessThanOrEqual(16 + 1e-9);
      expect(p.mins.z).toBeGreaterThanOrEqual(-2 - 1e-9);
    }
    const w: string[] = [];
    const noHull = parseBsp(buildBoxWorld({ dispMinTess: 0x80000000 | 4 }).buffer);
    expect(buildDisplacementBrushes(noHull, { warnings: w }).length).toBe(0);
    expect(w).toEqual(['1 displacements flagged without hull collision']);
    const noPhys = parseBsp(buildBoxWorld({ dispMinTess: 0x80000000 | 2 }).buffer);
    expect(buildDisplacementBrushes(noPhys).length).toBe(8); // players still collide
    expect(buildDisplacementBrushes(noPhys, { skipNoPhysics: true }).length).toBe(0);
    expect(dispFlags(0x80000000 | 6)).toBe(6);
    expect(dispFlags(6)).toBe(0); // no magic bit: plain minTess, no flags
  });

  it('packed and plain prisms describe the same planes', () => {
    const bsp = parseBsp(buildBoxWorld().buffer);
    const packed = buildDisplacementBrushes(bsp);
    const plain = buildDisplacementBrushes(bsp, { packed: false });
    expect(packed[0]).toBeInstanceOf(PackedBrush);
    expect(plain[0]).not.toBeInstanceOf(PackedBrush);
    for (let i = 0; i < packed.length; i++) {
      expect(JSON.parse(JSON.stringify(packed[i].sides))).toEqual(JSON.parse(JSON.stringify(plain[i].sides)));
      expect(packed[i].mins).toEqual(plain[i].mins);
    }
    expect(JSON.parse(JSON.stringify(packed[1]))).toEqual(JSON.parse(JSON.stringify(plain[1])));
    // sides is a snapshot; assigning replaces it
    const p = packed[0] as PackedBrush;
    expect(p.sides).not.toBe(p.sides);
    const replacement = p.sides.slice(0, 3);
    p.sides = replacement;
    expect(p.sides).toBe(replacement);
  });
});

describe('trianglePrismBrush', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const tris: number[][] = [];
  for (let i = 0; i < 400; i++) {
    const base = [(rnd() - 0.5) * 30000, (rnd() - 0.5) * 30000, (rnd() - 0.5) * 30000];
    const s = i % 4 === 0 ? 2 : i % 4 === 1 ? 64 : 300;
    tris.push([0, 1, 2].flatMap(() => base.map((b) => b + (rnd() - 0.5) * s)));
  }
  // special cases: horizontal (both facings), vertical walls, axis-aligned edges, slivers
  tris.push([0, 0, 0, 64, 0, 0, 0, 64, 0], [0, 0, 0, 0, 64, 0, 64, 0, 0], [0, 0, 0, 64, 0, 0, 0, 0, 64], [0, 0, 0, 0, 0, 64, 0, 64, 0]);
  tris.push([10, 20, 30, 74, 20, 30, 74, 84, 46], [0, 0, 0, 100, 0, 0, 50, 0.5, 0.01], [-5, -5, 100, 5, -5, 100, 0, 5, 101]);

  it('matches brushFromPlanes on the same five planes', () => {
    let compared = 0;
    for (const t of tris) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
      const fast = trianglePrismBrush(ax, ay, az, bx, by, bz, cx, cy, cz, 2, CONTENTS_SOLID);
      const planes = trianglePrismPlanes(v3(ax, ay, az), v3(bx, by, bz), v3(cx, cy, cz), 2);
      const ref = planes ? brushFromPlanes(planes, CONTENTS_SOLID, 0) : null;
      expect(!!fast).toBe(!!ref);
      if (!fast || !ref) continue;
      compared++;
      expect(fast.sides.length).toBe(ref.sides.length);
      for (const s of fast.sides) {
        const match = ref.sides.some(
          (r) => vclose(r.plane.normal, s.plane.normal, 1e-6) && close(r.plane.dist, s.plane.dist, 1e-3) && r.bevel === s.bevel,
        );
        expect(match).toBe(true);
      }
      expect(vclose(fast.mins, ref.mins, 1e-3) && vclose(fast.maxs, ref.maxs, 1e-3)).toBe(true);
    }
    expect(compared).toBeGreaterThan(390);
  });

  it('is a thin slab under the triangle', () => {
    const b = trianglePrismBrush(0, 0, 0, 64, 0, 0, 0, 64, 0, 2, CONTENTS_SOLID)!;
    expect(b.mins).toEqual(v3(0, 0, -2));
    expect(b.maxs).toEqual(v3(64, 64, 0));
    expect(inside(b, { x: 10, y: 10, z: -1 })).toBe(true);
    expect(inside(b, { x: 10, y: 10, z: 0.5 })).toBe(false);
    expect(inside(b, { x: 10, y: 10, z: -2.5 })).toBe(false);
    expect(inside(b, { x: 40, y: 40, z: -1 })).toBe(false); // beyond the hypotenuse
    // clockwise input faces down: the slab is above the plane
    const flipped = trianglePrismBrush(0, 0, 0, 0, 64, 0, 64, 0, 0, 2, CONTENTS_SOLID)!;
    expect(flipped.mins.z).toBe(0);
    expect(flipped.maxs.z).toBe(2);
    expect(trianglePrismBrush(0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 1)).toBeNull(); // collinear
  });
});

describe('collision world integration (synthetic map)', () => {
  it('traces hit the world floor, the placed func_brush, the rotated trigger and the displacement', () => {
    const bsp = parseBsp(buildBoxWorld().buffer);
    const models = buildBrushModels(bsp);
    const brushes = [...models[0].brushes, ...models[1].brushes, ...models[2].brushes, ...buildDisplacementBrushes(bsp)];
    const world = new CollisionWorld(brushes);
    const down = (x: number, y: number, mask = MASK_PLAYERSOLID) => {
      const tr = world.traceRay(v3(x, y, 200), v3(x, y, -30), mask);
      return tr.fraction < 1 ? tr.endpos.z : null;
    };
    // ray endpoints stop DIST_EPSILON (1/32 unit) before the surface, like Source
    const near = (z: number | null, expected: number) => z !== null && Math.abs(z - expected) <= 0.04;
    expect(near(down(-200, -200), 0)).toBe(true); // floor
    expect(near(down(100, 0), 66)).toBe(true); // func_brush top at origin z 50 + 16
    expect(near(down(32, 32), 16)).toBe(true); // displacement peak
    expect(down(48, 16)!).toBeGreaterThan(1); // on the displacement slope
    expect(near(down(0, 330, 0x40000000), 48)).toBe(true); // rotated trigger box, only with its contents mask
    expect(down(30, 300, 0x40000000)).toBeNull(); // outside the rotated box (the floor isn't in this mask)
    expect(near(down(0, 331, MASK_PLAYERSOLID), 0)).toBe(true); // trigger contents aren't player-solid
  });
});

describe('collectCollisionBrushes', () => {
  it('collects world, solid brush entities and displacement prisms; reports start-disabled models', () => {
    const bsp = parseBsp(buildBoxWorld().buffer);
    const ents = parseEntities(bsp.entitiesText);
    const set = collectCollisionBrushes(bsp, ents);
    // floor + func_brush cube + 8 displacement prisms; the trigger_push is left out
    expect(set.brushes.length).toBe(1 + 1 + 8);
    expect(set.solidModels).toEqual([1]);
    expect(set.disabledModels).toEqual([]);
    expect(set.brushes.some((b) => b.model === 2)).toBe(false);
    ents[2].kv.startdisabled = '1';
    const off = collectCollisionBrushes(bsp, ents);
    expect(off.disabledModels).toEqual([1]);
    const world = new CollisionWorld(off.brushes);
    for (const m of off.disabledModels) world.setModelSolid(m, false);
    const tr = world.traceRay(v3(100, 0, 200), v3(100, 0, -30), MASK_PLAYERSOLID);
    expect(Math.abs(tr.endpos.z - 0)).toBeLessThan(0.04); // falls through the disabled func_brush to the floor
  });
});

describe('isSolidBrushEntity / brushEntityStartsEnabled', () => {
  const ent = (classname: string, kv: Record<string, string> = {}): MapEntity => ({
    index: 0,
    classname,
    targetname: '',
    kv: { classname, ...kv },
    outputs: [],
    origin: v3(),
    angles: qa(),
    model: 1,
  });

  it('classifies solid and non-solid classes', () => {
    for (const c of ['func_wall', 'func_wall_toggle', 'func_breakable', 'func_button', 'func_physbox', 'func_door', 'func_door_rotating', 'func_rotating', 'func_movelinear', 'func_tracktrain', 'func_conveyor', 'func_monitor', 'func_lod']) {
      expect(isSolidBrushEntity(ent(c)), c).toBe(true);
    }
    for (const c of ['func_illusionary', 'func_clip_vphysics', 'trigger_push', 'trigger_teleport', 'func_areaportal', 'func_ladder', 'func_buyzone', 'func_nav_blocker', 'func_dustmotes', 'func_precipitation', 'func_water_analog', 'info_target', 'some_custom_entity']) {
      expect(isSolidBrushEntity(ent(c)), c).toBe(false);
    }
  });

  it('honours solidity and "not solid"/"passable" spawnflags', () => {
    expect(isSolidBrushEntity(ent('func_brush'))).toBe(true);
    expect(isSolidBrushEntity(ent('func_brush', { solidity: '1' }))).toBe(false);
    expect(isSolidBrushEntity(ent('func_brush', { solidity: '2' }))).toBe(true);
    expect(isSolidBrushEntity(ent('func_rotating', { spawnflags: '64' }))).toBe(false);
    expect(isSolidBrushEntity(ent('func_rotating', { spawnflags: '1' }))).toBe(true);
    expect(isSolidBrushEntity(ent('func_door', { spawnflags: '8' }))).toBe(false);
    expect(isSolidBrushEntity(ent('func_door', { spawnflags: '4' }))).toBe(false);
    expect(isSolidBrushEntity(ent('func_door', { spawnflags: '256' }))).toBe(true);
    expect(isSolidBrushEntity(ent('func_movelinear', { spawnflags: '8' }))).toBe(false);
    expect(isSolidBrushEntity(ent('func_rot_button', { spawnflags: '1' }))).toBe(false);
    expect(isSolidBrushEntity(ent('func_conveyor', { spawnflags: '2' }))).toBe(false);
    expect(isSolidBrushEntity(ent('FUNC_WALL'))).toBe(true);
  });

  it('reports the initial enabled state', () => {
    expect(brushEntityStartsEnabled(ent('func_brush'))).toBe(true);
    expect(brushEntityStartsEnabled(ent('func_brush', { startdisabled: '1' }))).toBe(false);
    expect(brushEntityStartsEnabled(ent('func_brush', { startdisabled: '1', solidity: '2' }))).toBe(true);
    expect(brushEntityStartsEnabled(ent('func_wall_toggle', { spawnflags: '1' }))).toBe(false);
    expect(brushEntityStartsEnabled(ent('func_wall_toggle'))).toBe(true);
  });

  it('places move-direction classes without rotation', () => {
    const door = { ...ent('func_door'), origin: v3(1, 2, 3), angles: qa(0, 90, 0) };
    expect(brushEntityPlacement(door)).toEqual({ origin: v3(1, 2, 3), angles: qa(0, 0, 0) });
    const rot = { ...ent('func_rotating'), angles: qa(0, 90, 0) };
    expect(brushEntityPlacement(rot).angles).toEqual(qa(0, 90, 0));
  });
});
