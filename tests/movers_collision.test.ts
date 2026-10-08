// Moving brush models in the collision world: CollisionWorld.setModelTransform / setModelBasePlacement and
// the RigidBrush helper (planes, bevels and bounds re-derived for each placement).
import { describe, expect, it } from 'vitest';
import { qa } from '../src/core/angles';
import { v3 } from '../src/core/vec3';
import { transformBrush } from '../src/bsp/bspcollision';
import { addBrushBevels, brushFromBox, brushFromPoints } from '../src/physics/brushbuild';
import { CollisionWorld, RigidBrush, anglesToMatrix, matrixToAngles, placementDelta } from '../src/physics/collision';
import { Brush, CONTENTS_SOLID, MASK_PLAYERSOLID, MASK_SOLID } from '../src/physics/types';

const HULL_MINS = v3(-16, -16, 0);
const HULL_MAXS = v3(16, 16, 72);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('rigid transform math', () => {
  it('anglesToMatrix columns are AngleVectors forward/left/up and matrixToAngles inverts it', () => {
    const r = rng(1);
    for (let i = 0; i < 200; i++) {
      const a = qa(r() * 178 - 89, r() * 360 - 180, r() * 360 - 180);
      const m = anglesToMatrix(a);
      const b = matrixToAngles(m, qa());
      const m2 = anglesToMatrix(b);
      for (let k = 0; k < 9; k++) expect(m2[k]).toBeCloseTo(m[k], 9);
    }
    // yaw 90: forward = +y, left = -x
    const m = anglesToMatrix(qa(0, 90, 0));
    expect(m[0]).toBeCloseTo(0, 12);
    expect(m[3]).toBeCloseTo(1, 12);
    expect(m[1]).toBeCloseTo(-1, 12);
    expect(m[8]).toBeCloseTo(1, 12);
  });

  it('placementDelta maps geometry built at one placement onto another', () => {
    const D = new Float64Array(9);
    const t = v3();
    const baseO = v3(10, 20, 30);
    const baseR = anglesToMatrix(qa(0, 30, 0));
    const o = v3(-5, 7, 100);
    const R = anglesToMatrix(qa(10, 120, 5));
    expect(placementDelta(baseO, baseR, o, R, D, t)).toBe(true);
    // a model-space point p sits at baseR p + baseO at the base, and must end at R p + o
    const p = v3(3, -4, 12);
    const w0 = v3(
      baseR[0] * p.x + baseR[1] * p.y + baseR[2] * p.z + baseO.x,
      baseR[3] * p.x + baseR[4] * p.y + baseR[5] * p.z + baseO.y,
      baseR[6] * p.x + baseR[7] * p.y + baseR[8] * p.z + baseO.z,
    );
    const w1 = v3(D[0] * w0.x + D[1] * w0.y + D[2] * w0.z + t.x, D[3] * w0.x + D[4] * w0.y + D[5] * w0.z + t.y, D[6] * w0.x + D[7] * w0.y + D[8] * w0.z + t.z);
    expect(w1.x).toBeCloseTo(R[0] * p.x + R[1] * p.y + R[2] * p.z + o.x, 9);
    expect(w1.y).toBeCloseTo(R[3] * p.x + R[4] * p.y + R[5] * p.z + o.y, 9);
    expect(w1.z).toBeCloseTo(R[6] * p.x + R[7] * p.y + R[8] * p.z + o.z, 9);
    // same rotation: a pure translation
    expect(placementDelta(baseO, baseR, o, baseR, D, t)).toBe(false);
    expect(t).toEqual(v3(-15, -13, 70));
  });
});

describe('CollisionWorld.setModelTransform', () => {
  function world(): CollisionWorld {
    const floor = brushFromBox(v3(-1000, -1000, -16), v3(1000, 1000, 0), CONTENTS_SOLID, 0);
    // a platform (model 1) built at its entity origin (0, 0, 64): 128 x 128 x 16
    const plat = brushFromBox(v3(-64, -64, 56), v3(64, 64, 72), CONTENTS_SOLID, 1);
    const w = new CollisionWorld([floor, plat]);
    w.setModelBasePlacement(1, v3(0, 0, 64), qa());
    return w;
  }

  it('translations move traces, testBox, pointContents and queryBox', () => {
    const w = world();
    let tr = w.traceBox(v3(0, 0, 300), v3(0, 0, -100), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.endpos.z).toBeCloseTo(72 + 0.03125, 4);
    expect(tr.model).toBe(1);
    w.setModelTransform(1, v3(0, 0, 164), qa());
    expect(w.isModelDynamic(1)).toBe(true);
    tr = w.traceBox(v3(0, 0, 300), v3(0, 0, -100), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.endpos.z).toBeCloseTo(172 + 0.03125, 4);
    expect(tr.model).toBe(1);
    expect(tr.plane.normal.z).toBeCloseTo(1, 9);
    expect(tr.plane.dist).toBeCloseTo(172, 9);
    // under the moved platform: free; inside it: solid
    expect(w.testBox(v3(0, 0, 80), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
    expect(w.testBox(v3(0, 0, 120), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(true);
    expect(w.pointContents(v3(0, 0, 160))).toBe(CONTENTS_SOLID);
    expect(w.pointContents(v3(0, 0, 64))).toBe(0);
    expect(w.testModelBox(1, v3(0, 0, 120), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(true);
    expect(w.testModelBox(1, v3(0, 0, 0), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
    const found: Brush[] = [];
    w.queryBox(v3(-10, -10, 150), v3(10, 10, 170), (b) => found.push(b));
    expect(found.length).toBe(1);
    expect(found[0].model).toBe(1);
    expect(found[0].mins.z).toBeCloseTo(156, 9);
    expect(found[0].maxs.z).toBeCloseTo(172, 9);
    // disabled: ignored by everything
    w.setModelSolid(1, false);
    expect(w.testBox(v3(0, 0, 120), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
    tr = w.traceBox(v3(0, 0, 300), v3(0, 0, -100), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.endpos.z).toBeCloseTo(0.03125, 4);
    w.setModelSolid(1, true);
    expect(w.testBox(v3(0, 0, 120), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(true);
    // back to the base placement
    w.setModelTransform(1, v3(0, 0, 64), qa());
    expect(w.testBox(v3(0, 0, 20), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(true);
    expect(w.getModelTransform(1)?.origin).toEqual(v3(0, 0, 64));
  });

  it('a start inside a moved brush reports startsolid with that model', () => {
    const w = world();
    w.setModelTransform(1, v3(300, 0, 64), qa());
    const tr = w.traceBox(v3(300, 0, 60), v3(300, 0, 300), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    expect(tr.startsolid).toBe(true);
    expect(tr.model).toBe(1);
  });

  it('rotations collide exactly like a brush built rotated (bevels rebuilt)', () => {
    // a thin wedge-ish convex brush and a long bar, rotated arbitrarily, compared with brushes built at that
    // placement (transformBrush + bevels) in a static world
    const bar = brushFromBox(v3(-200, -12, 0), v3(200, 12, 40), CONTENTS_SOLID, 1);
    const wedge = brushFromPoints([v3(0, 0, 0), v3(80, 0, 0), v3(0, 60, 0), v3(0, 0, 50), v3(30, 30, 70)], CONTENTS_SOLID, 1)!;
    expect(wedge).not.toBeNull();
    const r = rng(7);
    for (const base of [bar, wedge]) {
      for (let k = 0; k < 6; k++) {
        const ang = qa(r() * 120 - 60, r() * 360, r() * 90 - 45);
        const org = v3(r() * 200 - 100, r() * 200 - 100, r() * 100);
        const moving = new CollisionWorld([base]);
        moving.setModelTransform(1, org, ang);
        const ref = transformBrush(base, org, ang);
        addBrushBevels(ref);
        const fixed = new CollisionWorld([ref]);
        for (let i = 0; i < 150; i++) {
          const s = v3(org.x + r() * 600 - 300, org.y + r() * 600 - 300, org.z + r() * 300 - 120);
          const e = v3(org.x + r() * 600 - 300, org.y + r() * 600 - 300, org.z + r() * 300 - 120);
          const ext = r() < 0.3 ? 0 : 4 + r() * 20;
          const mn = v3(-ext, -ext, -ext * 0.5);
          const mx = v3(ext, ext, ext * 1.5);
          const a = moving.traceBox(s, e, mn, mx, MASK_SOLID);
          const b = fixed.traceBox(s, e, mn, mx, MASK_SOLID);
          expect(a.startsolid).toBe(b.startsolid);
          expect(a.allsolid).toBe(b.allsolid);
          expect(a.fraction).toBeCloseTo(b.fraction, 6);
          expect(moving.testBox(s, mn, mx, MASK_SOLID)).toBe(fixed.testBox(s, mn, mx, MASK_SOLID));
          expect(moving.pointContents(s)).toBe(fixed.pointContents(s));
        }
      }
    }
  });

  it('RigidBrush keeps the brush view in sync with its planes', () => {
    const b = brushFromBox(v3(-8, -8, -8), v3(8, 8, 8), CONTENTS_SOLID, 3);
    const rb = new RigidBrush(b);
    expect(rb.brush.sides.length).toBe(b.sides.length);
    const m = anglesToMatrix(qa(0, 45, 0));
    rb.update(m, 100, 0, 0);
    const view = rb.brush;
    expect(view.mins.x).toBeCloseTo(100 - 8 * Math.SQRT2, 9);
    expect(view.maxs.x).toBeCloseTo(100 + 8 * Math.SQRT2, 9);
    expect(view.sides.filter((s) => !s.bevel).length).toBe(6);
    expect(view.model).toBe(3);
  });
});
