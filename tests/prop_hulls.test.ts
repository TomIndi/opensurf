// Static-prop collision hulls (brush model PROP_HULL_MODEL, built from the props' .phy) keep Quake 3's touch rule
// while brushes follow Source's CM_ClipBoxToBrush (see src/physics/collision.ts). Source traces props through
// VPhysics, not the brush clipper, and KSF world-record replays on surf_summer_ksf's curved prop ramps follow the
// old rule on the prop facets: a move that ends within DIST_EPSILON of the next facet already clips the velocity on
// it (css#5, frame 3894 -> 3895: a hit at fraction 0.9989, velocity (-29.7, 1317.0, -1062.1) = the replay's), where
// the brush rule misses the facet, clips a tick later and is 0.66 units off the replay at frame 3896. Each check
// below runs the same geometry as a brush and as a prop hull.
//
// The opt-in part replays that stretch of surf_summer_ksf:
//   SURF_TEST_MAPS=<dir with surf_summer_ksf.bsp> SURF_TEST_KSF_REPLAYS=<dir> npx vitest run tests/prop_hulls.test.ts
// (SURF_TEST_KSF_REPLAYS as for tests/ramp_seams_maps.test.ts: records_surf_summer_ksf_css.json + the replay files.)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vec3, v3 } from '../src/core/vec3';
import { PROP_COLLISION_MODEL } from '../src/bsp/phy';
import { parseKsfReplay } from '../src/maps/ksfreplay';
import { brushFromBox } from '../src/physics/brushbuild';
import { CollisionWorld, PROP_HULL_MODEL } from '../src/physics/collision';
import { defaultMoveVars, playerMove } from '../src/physics/movement';
import { HULL_MAXS, HULL_MINS, newMoveEvents, newUserCmd } from '../src/physics/playertypes';
import { Brush, CONTENTS_SOLID, DIST_EPSILON, MASK_PLAYERSOLID, TraceResult } from '../src/physics/types';
import { LogWorld, cmdFromFrame, loadCollisionWorld, stateFromFrame } from './helpers/ramp_diff';

const MINS = v3(HULL_MINS.x, HULL_MINS.y, HULL_MINS.z);
const MAXS = v3(HULL_MAXS.x, HULL_MAXS.y, HULL_MAXS.z);
/** x where the hull's +x face touches the block's -x face (x = 100). */
const TOUCH_X = 100 - 16;

/** The block x 100..200, y -50..50, z -100..0, as a world brush or as a static-prop hull. */
const block = (model: number, x0 = 100): Brush => brushFromBox(v3(x0, -50, -100), v3(x0 + 100, 50, 0), CONTENTS_SOLID, model);
const worlds = () => ({ brush: new CollisionWorld([block(0)]), prop: new CollisionWorld([block(PROP_HULL_MODEL)]) });
const trace = (w: CollisionWorld, a: Vec3, b: Vec3): TraceResult => w.traceBox(a, b, MINS, MAXS, MASK_PLAYERSOLID);

describe('static-prop hulls keep the Quake 3 touch rule, brushes follow Source', () => {
  it('PROP_HULL_MODEL is the prop hulls\' brush model', () => {
    expect(PROP_HULL_MODEL).toBe(PROP_COLLISION_MODEL);
  });

  it('a move that ends within DIST_EPSILON of a face without reaching it: no hit on a brush, a hit on a prop hull', () => {
    const { brush, prop } = worlds();
    const start = v3(0, 0, -50);
    const end = v3(TOUCH_X - 0.01, 0, -50);
    const b = trace(brush, start, end);
    expect(b.fraction).toBe(1);
    expect(b.endpos).toEqual(end);
    const p = trace(prop, start, end);
    expect(p.fraction).toBeLessThan(1);
    expect(p.endpos.x).toBeCloseTo(TOUCH_X - DIST_EPSILON, 10); // pulled back to the epsilon shell
    expect(p.plane.normal).toEqual(v3(-1, 0, 0));
    expect(p.plane.dist).toBe(-100);
    expect(p.model).toBe(PROP_HULL_MODEL);
    expect(p.contents).toBe(CONTENTS_SOLID);
    // ending on the shell within float noise (CLIP_NOISE) or further away misses the prop hull too
    for (const x of [TOUCH_X - DIST_EPSILON + 1e-7, TOUCH_X - DIST_EPSILON, TOUCH_X - 0.04]) {
      expect(trace(prop, start, v3(x, 0, -50)).fraction).toBe(1);
      expect(trace(brush, start, v3(x, 0, -50)).fraction).toBe(1);
    }
    // reaching the face is a hit on both, pulled back to the shell
    for (const w of [brush, prop]) {
      const tr = trace(w, start, v3(TOUCH_X + 0.001, 0, -50));
      expect(tr.fraction).toBeLessThan(1);
      expect(tr.endpos.x).toBeCloseTo(TOUCH_X - DIST_EPSILON, 10);
    }
  });

  it('point traces too', () => {
    const { brush, prop } = worlds();
    const end = v3(100 - 0.01, 0, -50);
    expect(brush.traceRay(v3(0, 0, -50), end, MASK_PLAYERSOLID).fraction).toBe(1);
    const p = prop.traceRay(v3(0, 0, -50), end, MASK_PLAYERSOLID);
    expect(p.fraction).toBeLessThan(1);
    expect(p.endpos.x).toBeCloseTo(100 - DIST_EPSILON, 10);
  });

  it('sliding along a face from inside its epsilon shell never hits it; moving into it stops at 0 on both', () => {
    const { brush, prop } = worlds();
    for (const gap of [DIST_EPSILON, 0.02, 1e-4]) {
      const at = v3(TOUCH_X - gap, -10, -50);
      for (const w of [brush, prop]) {
        expect(trace(w, at, v3(at.x, 30, -50)).fraction).toBe(1); // parallel
        expect(trace(w, at, v3(at.x - 0.005, 30, -40)).fraction).toBe(1); // drifting away
        const into = trace(w, at, v3(at.x + 2, 30, -50));
        expect(into.fraction).toBe(0);
        expect(into.startsolid).toBe(false);
        expect(into.endpos).toEqual(at);
        expect(into.plane.normal).toEqual(v3(-1, 0, 0));
      }
    }
  });

  // The hull starts 0.02 off the block's -x face and 0.01 above its top (inside both epsilon shells, outside the
  // block) and moves into both: +x by 10 (crossing the -x face after 0.2%), down by 1 (crossing the top after 1%).
  const corner = { start: v3(TOUCH_X - 0.02, 0, 0.01), end: v3(TOUCH_X + 9.98, 0, -0.99) };

  it('starting inside two faces\' epsilon shells: a brush reports the face really crossed last, a prop hull the one whose pulled-back crossing is last', () => {
    const { brush, prop } = worlds();
    const b = trace(brush, corner.start, corner.end);
    expect(b.fraction).toBe(0);
    expect(b.startsolid).toBe(false);
    expect(b.plane.normal).toEqual(v3(0, 0, 1)); // the top (Source by side order; here: really crossed last)
    const p = trace(prop, corner.start, corner.end);
    expect(p.fraction).toBe(0);
    expect(p.startsolid).toBe(false);
    expect(p.endpos).toEqual(corner.start);
    // pulled-back crossings: -x face (0.02 - 1/32) / 10 = -0.0011, top (0.01 - 1/32) / 1 = -0.021
    expect(p.plane.normal).toEqual(v3(-1, 0, 0));
    expect(p.model).toBe(PROP_HULL_MODEL);
  });

  it('a brush hit at 0 wins over a prop hull hit at 0 (whatever the order); otherwise the nearer hit wins', () => {
    for (const list of [
      [block(0), block(PROP_HULL_MODEL)],
      [block(PROP_HULL_MODEL), block(0)],
    ]) {
      const tr = trace(new CollisionWorld(list), corner.start, corner.end);
      expect(tr.fraction).toBe(0);
      expect(tr.model).toBe(0);
      expect(tr.plane.normal).toEqual(v3(0, 0, 1));
    }
    // a prop hull in front of a brush stops the move first, and the other way round
    const start = v3(0, 0, -50);
    const end = v3(400, 0, -50);
    const near = trace(new CollisionWorld([block(0, 150), block(PROP_HULL_MODEL)]), start, end);
    expect(near.model).toBe(PROP_HULL_MODEL);
    expect(near.endpos.x).toBeCloseTo(TOUCH_X - DIST_EPSILON, 10);
    const far = trace(new CollisionWorld([block(PROP_HULL_MODEL, 150), block(0)]), start, end);
    expect(far.model).toBe(0);
    expect(far.endpos.x).toBeCloseTo(TOUCH_X - DIST_EPSILON, 10);
  });
});

// ---------------------------------------------------------------------------------------------- opt-in, real map
const MAPS_DIR = process.env.SURF_TEST_MAPS;
const REPLAY_DIR = process.env.SURF_TEST_KSF_REPLAYS;
const isDir = (d: string | undefined): d is string => !!d && existsSync(d) && statSync(d).isDirectory();

function summerReplay(rank: number): { bsp: string; path: string; time: number } | null {
  if (!isDir(MAPS_DIR) || !isDir(REPLAY_DIR)) return null;
  const bsp = join(MAPS_DIR, 'surf_summer_ksf.bsp');
  const records = join(REPLAY_DIR, 'records_surf_summer_ksf_css.json');
  if (!existsSync(bsp) || !existsSync(records)) return null;
  try {
    const list = JSON.parse(readFileSync(records, 'utf8')) as { rank: number; file: string | null; time: number }[];
    const r = list.find((x) => x.rank === rank);
    if (!r || !r.file || !existsSync(join(REPLAY_DIR, r.file))) return null;
    return { bsp, path: join(REPLAY_DIR, r.file), time: r.time };
  } catch {
    return null;
  }
}

const CSS5 = summerReplay(5);

describe.skipIf(!CSS5)('surf_summer_ksf prop ramps vs a KSF replay (SURF_TEST_MAPS + SURF_TEST_KSF_REPLAYS)', () => {
  it('css#5 rides the curved prop ramp exactly where it reaches the next facet (frames 3866-3926)', () => {
    const world = loadCollisionWorld(CSS5!.bsp);
    const buf = readFileSync(CSS5!.path);
    const rep = parseKsfReplay(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { tickInterval: 0.015, expectedTime: CSS5!.time });
    // From the replay's state at frame K, our movement with the replay's commands must stay on the replay's path
    // (within 0.01 units) for 60 ticks. The move from frame 3894 to 3895 ends inside the next facet's epsilon shell
    // without reaching its face: the prop hull is touched there (fraction 0.9989) and the velocity clipped on that
    // facet, as in the replay; with the brush rule it is only clipped a tick later (0.66 units off at frame 3896).
    const K = 3866;
    const vars = defaultMoveVars();
    const lw = new LogWorld(world);
    lw.log = [];
    const ps = stateFromFrame(rep, K, lw, vars);
    const cmd = newUserCmd();
    const ev = newMoveEvents();
    const off: string[] = [];
    let propHits = 0;
    for (let i = 0; i < 60; i++) {
      const f = K + i + 1;
      lw.tick = i;
      playerMove(ps, cmdFromFrame(rep, f, cmd), lw, vars, rep.tickInterval, ev);
      const o = rep.origins;
      const e = Math.hypot(ps.origin.x - o[f * 3], ps.origin.y - o[f * 3 + 1], ps.origin.z - o[f * 3 + 2]);
      if (e > 0.01) off.push(`frame ${f}: ${e.toFixed(4)} off`);
    }
    for (const t of lw.log) if (t.fraction < 1 && world.brushes[t.brush]?.model === PROP_HULL_MODEL) propHits++;
    expect(propHits).toBeGreaterThan(60);
    expect(off.slice(0, 5)).toEqual([]);
  });
});
