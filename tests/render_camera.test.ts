import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { angleVectors } from '../src/core/angles';
import { applySourceView, createSourceCamera, horizontalFovAt, rigidInverse, sourceVerticalFov, viewMatrixWorld } from '../src/render/camera';

describe('Source fov', () => {
  it('fov 90 at 4:3 is 73.74 deg vertical (CS:GO)', () => {
    expect(sourceVerticalFov(90)).toBeCloseTo(73.7398, 3);
  });

  it('is Hor+: 16:9 sees 106.26 deg horizontally, 4:3 sees the fov itself', () => {
    expect(horizontalFovAt(90, 16 / 9)).toBeCloseTo(106.26, 1);
    expect(horizontalFovAt(90, 4 / 3)).toBeCloseTo(90, 6);
    expect(horizontalFovAt(75, 4 / 3)).toBeCloseTo(75, 6);
    expect(horizontalFovAt(90, 21 / 9)).toBeGreaterThan(horizontalFovAt(90, 16 / 9));
  });

  it('clamps nonsense', () => {
    expect(sourceVerticalFov(NaN)).toBeCloseTo(sourceVerticalFov(90), 6);
    expect(sourceVerticalFov(0)).toBeGreaterThan(0);
    expect(sourceVerticalFov(400)).toBeLessThan(180);
  });
});

function col(m: Matrix4, i: number): Vector3 {
  const e = m.elements;
  return new Vector3(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]);
}

describe('view matrix', () => {
  const cases = [
    { pitch: 0, yaw: 0, roll: 0 },
    { pitch: 30, yaw: 45, roll: 0 },
    { pitch: -60, yaw: 200, roll: 0 },
    { pitch: 10, yaw: -75, roll: 15 },
    { pitch: 89, yaw: 123, roll: -30 },
  ];
  for (const a of cases) {
    it(`looks along Source's forward with Source's up (${a.pitch} ${a.yaw} ${a.roll})`, () => {
      const m = viewMatrixWorld({ x: 10, y: -20, z: 30 }, a, new Matrix4());
      const f = { x: 0, y: 0, z: 0 };
      const r = { x: 0, y: 0, z: 0 };
      const u = { x: 0, y: 0, z: 0 };
      angleVectors(a, f, r, u);
      // three.js cameras look down -Z, +X right, +Y up
      const right = col(m, 0);
      const up = col(m, 1);
      const back = col(m, 2);
      expect(right.x).toBeCloseTo(r.x, 6);
      expect(right.y).toBeCloseTo(r.y, 6);
      expect(right.z).toBeCloseTo(r.z, 6);
      expect(up.x).toBeCloseTo(u.x, 6);
      expect(up.y).toBeCloseTo(u.y, 6);
      expect(up.z).toBeCloseTo(u.z, 6);
      expect(-back.x).toBeCloseTo(f.x, 6);
      expect(-back.y).toBeCloseTo(f.y, 6);
      expect(-back.z).toBeCloseTo(f.z, 6);
      // a proper rotation (right-handed, no mirroring)
      expect(new Vector3().crossVectors(right, up).dot(back)).toBeCloseTo(1, 6);
      expect(col(m, 3).toArray()).toEqual([10, -20, 30]);
    });
  }

  it('yaw 0 looks at +X, yaw 90 at +Y, pitch 90 looks down (Source conventions)', () => {
    const m = new Matrix4();
    viewMatrixWorld({ x: 0, y: 0, z: 0 }, { pitch: 0, yaw: 0, roll: 0 }, m);
    expect(col(m, 2).x).toBeCloseTo(-1, 6);
    viewMatrixWorld({ x: 0, y: 0, z: 0 }, { pitch: 0, yaw: 90, roll: 0 }, m);
    expect(col(m, 2).y).toBeCloseTo(-1, 6);
    // pitch is clamped to 89 but still looks (almost) straight down
    viewMatrixWorld({ x: 0, y: 0, z: 0 }, { pitch: 90, yaw: 0, roll: 0 }, m);
    expect(-col(m, 2).z).toBeLessThan(-0.999);
    expect(-col(m, 2).z).toBeGreaterThan(-1);
    // screen up stays world up at zero roll: Z-up world, no axis conversion
    viewMatrixWorld({ x: 0, y: 0, z: 0 }, { pitch: 0, yaw: 37, roll: 0 }, m);
    expect(col(m, 1).z).toBeCloseTo(1, 6);
  });

  it('roll tilts the horizon (positive roll = right side down, like Source)', () => {
    const m = viewMatrixWorld({ x: 0, y: 0, z: 0 }, { pitch: 0, yaw: 0, roll: 20 }, new Matrix4());
    // Source's right vector z at roll r is -sin(r): rolling right lowers the right side
    expect(col(m, 0).z).toBeCloseTo(-Math.sin((20 * Math.PI) / 180), 6);
  });

  it('rigidInverse is the inverse', () => {
    const m = viewMatrixWorld({ x: 123, y: -456, z: 789 }, { pitch: 12, yaw: 34, roll: 5 }, new Matrix4());
    const inv = rigidInverse(m, new Matrix4());
    const id = new Matrix4().multiplyMatrices(m, inv);
    const e = id.elements;
    const ref = new Matrix4().identity().elements;
    for (let i = 0; i < 16; i++) expect(e[i]).toBeCloseTo(ref[i], 9);
    const inv2 = m.clone().invert();
    for (let i = 0; i < 16; i++) expect(inv.elements[i]).toBeCloseTo(inv2.elements[i], 9);
  });

  it('ignores non-finite input', () => {
    const m = viewMatrixWorld({ x: NaN, y: Infinity, z: 1 }, { pitch: NaN, yaw: NaN, roll: NaN }, new Matrix4());
    for (const v of m.elements) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('applySourceView', () => {
  it('sets matrices, fov and aspect; projects the forward point to the screen centre', () => {
    const cam = createSourceCamera(3, 1 << 20);
    expect(cam.up.toArray()).toEqual([0, 0, 1]);
    expect(cam.matrixAutoUpdate).toBe(false);
    applySourceView(cam, { x: 100, y: 200, z: 300 }, { pitch: 20, yaw: 135, roll: 0 }, 90, 16 / 9);
    expect(cam.fov).toBeCloseTo(73.7398, 3);
    expect(cam.aspect).toBeCloseTo(16 / 9, 9);
    expect(cam.position.toArray()).toEqual([100, 200, 300]);
    const f = { x: 0, y: 0, z: 0 };
    angleVectors({ pitch: 20, yaw: 135, roll: 0 }, f);
    const p = new Vector3(100 + f.x * 500, 200 + f.y * 500, 300 + f.z * 500);
    p.applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
    // a point to the right of the view lands on the right half of the screen; above -> top half
    const r = { x: 0, y: 0, z: 0 };
    const u = { x: 0, y: 0, z: 0 };
    angleVectors({ pitch: 20, yaw: 135, roll: 0 }, f, r, u);
    const q = new Vector3(100 + f.x * 500 + r.x * 50 + u.x * 30, 200 + f.y * 500 + r.y * 50 + u.y * 30, 300 + f.z * 500 + r.z * 50 + u.z * 30);
    q.applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    expect(q.x).toBeGreaterThan(0);
    expect(q.y).toBeGreaterThan(0);
  });

  it('the horizontal half-angle at 4:3 equals half the Source fov', () => {
    const cam = createSourceCamera(3, 1 << 20);
    applySourceView(cam, { x: 0, y: 0, z: 0 }, { pitch: 0, yaw: 0, roll: 0 }, 90, 4 / 3);
    // a point 45 deg to the right of forward lies on the right screen edge (NDC x = 1)
    const p = new Vector3(100, -100, 0).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    expect(p.x).toBeCloseTo(1, 6);
  });
});
