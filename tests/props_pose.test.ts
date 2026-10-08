// Model entities are drawn in the first frame of their starting sequence (the root bone's animated pose), like
// the engine's prop_dynamic; static props keep the bind pose.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { angleVectors } from '../src/core/angles';
import { v3 } from '../src/core/vec3';
import { parseEntities } from '../src/bsp/entities';
import { PakFile } from '../src/bsp/pakfile';
import { buildMapProps, composePose, entityPropInstances, eulerToQuat, RootPose } from '../src/bsp/props';
import { parseBsp } from '../src/bsp/reader';

/** model point -> world with Source angles (x forward, y left, z up) */
function place(o: { x: number; y: number; z: number }, a: { pitch: number; yaw: number; roll: number }, p: number[]): number[] {
  const f = v3(), r = v3(), u = v3();
  angleVectors(a, f, r, u);
  return [o.x + p[0] * f.x - p[1] * r.x + p[2] * u.x, o.y + p[0] * f.y - p[1] * r.y + p[2] * u.y, o.z + p[0] * f.z - p[1] * r.z + p[2] * u.z];
}

function rotate(q: number[], p: number[]): number[] {
  const [x, y, z, w] = q;
  // v' = q v q*
  const ix = w * p[0] + y * p[2] - z * p[1];
  const iy = w * p[1] + z * p[0] - x * p[2];
  const iz = w * p[2] + x * p[1] - y * p[0];
  const iw = -x * p[0] - y * p[1] - z * p[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

describe('prop root pose', () => {
  it('composePose matches entity transform after the pose', () => {
    const poses: RootPose[] = [
      { q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], t: [0, 0, 0] },
      { q: eulerToQuat(0.3, -0.7, 1.9), t: [12, -5, 30] },
      { q: eulerToQuat(Math.PI / 2, 0, 0), t: [0, 0, 8] },
    ];
    const angles = [
      { pitch: 0, yaw: 90, roll: 0 },
      { pitch: 25, yaw: -130, roll: 40 },
      { pitch: -80, yaw: 10, roll: -15 },
    ];
    for (const pose of poses) {
      for (const a of angles) {
        const o = { x: 100, y: -50, z: 7 };
        const s = 1.5;
        const c = composePose(o, a, s, pose);
        for (const p of [[10, 0, 0], [0, 10, 0], [0, 0, 10], [3, -7, 11]]) {
          const posed = rotate(pose.q, p.map((x) => x * s));
          const want = place(o, a, [posed[0] + pose.t[0] * s, posed[1] + pose.t[1] * s, posed[2] + pose.t[2] * s]);
          const got = place(c.origin, c.angles, p.map((x) => x * s));
          for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k], 6);
        }
      }
    }
  });

  it('a +90 degree idle pose turns a yaw-90 entity to yaw 180', () => {
    const c = composePose({ x: 0, y: 0, z: 0 }, { pitch: 0, yaw: 90, roll: 0 }, 1, { q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], t: [0, 0, 0] });
    expect(c.angles.pitch).toBeCloseTo(0, 6);
    expect(Math.abs(c.angles.yaw)).toBeCloseTo(180, 6);
    expect(c.angles.roll).toBeCloseTo(0, 6);
  });

  const MAPS = process.env.SURF_TEST_MAPS;
  const omnific = MAPS ? join(MAPS, 'surf_lt_omnific.bsp') : '';
  it.skipIf(!omnific || !existsSync(omnific))('surf_lt_omnific: prop_dynamic signs are drawn in their idle pose (facing the walkways)', () => {
    const b = readFileSync(omnific);
    const bsp = parseBsp(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const ents = parseEntities(bsp.entitiesText);
    const pak = new PakFile(bsp.pakfile!);
    const props = buildMapProps(bsp, ents, pak, new Map());
    // sign_stage_a at (-3200, -448, 4160) yaw 90: its idle sequence turns the root +90 degrees -> yaw 180
    const inst = entityPropInstances(ents).find((p) => /sign_stage_a/.test(p.model) && Math.abs(p.origin.x + 3200) < 1 && Math.abs(p.origin.y + 448) < 1);
    expect(inst).toBeTruthy();
    const rp = props.find((p) => p.entity === inst!.entity);
    expect(rp).toBeTruthy();
    expect(Math.abs(rp!.angles.yaw)).toBeCloseTo(180, 3);
    // static props keep their own angles
    const stat = props.filter((p) => p.entity === undefined);
    for (const p of stat.slice(0, 50)) expect(Number.isFinite(p.angles.yaw)).toBe(true);
  });
});
