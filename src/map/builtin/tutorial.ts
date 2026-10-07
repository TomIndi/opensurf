// surf_tutorial - Tier 1, linear. A start room drops onto a long, wide, gently descending first ramp; then
// eight more ramps with growing gaps (straight follow-ups, a left/right zigzag, a transfer to a parallel
// ramp) lead to a big end platform. Four sections with checkpoints; falling sends you back to the start
// of the section you are in.
import { Vec3, v3 } from '../../core/vec3';
import { MapBuilder, RampRecord } from './builder';
import { BuiltCourse, Course, CourseRamp, CourseSection, RampChain, rampPoint } from './course';
import { addSectionVoid, rampZoneBox, stageDestination } from './parts';

export function buildTutorial(): BuiltCourse {
  const b = new MapBuilder('surf_tutorial', {
    sky: 'sky_day01_01',
    fog: { enabled: true, color: [0.66, 0.77, 0.9], start: 7000, end: 30000, maxDensity: 0.55 },
  });
  const FLOOR = 'builtin/floor_grey';
  const WALL = 'builtin/wall_grid';
  const SIDE = 'builtin/wall_dark';
  const Z0 = 7000;

  // ---------------------------------------------------------------- start room (spawn, start zone)
  const roomMin = v3(-640, -256, Z0);
  const roomMax = v3(0, 256, Z0 + 288);
  b.addRoom(roomMin, roomMax, { floor: FLOOR, wall: WALL, ceiling: 'builtin/wall_grey' }, [
    { side: '+x', a0: -224, a1: 224, z0: Z0, z1: Z0 + 240 },
  ]);
  b.addTopTrim(v3(-640, -256, Z0 - 16), v3(0, 256, Z0), 'builtin/glow_cyan', 6);
  const spawn = v3(-512, 0, Z0);
  b.addSpawn(spawn, 0);
  b.addDestination('tut_start', spawn, 0);
  b.addZone('start', v3(-624, -240, Z0), v3(-16, 240, Z0 + 160), { spawn: { origin: spawn, yaw: 0 } });

  // ---------------------------------------------------------------- ramps
  const w1 = 384;
  const chain = new RampChain(b, v3(-112, -w1 * 0.45, Z0 - 96), 0);
  const R: RampRecord[] = [];
  const mats = ['builtin/ramp_cyan', 'builtin/ramp_orange', 'builtin/ramp_green', 'builtin/ramp_purple'];
  // section 1: the long first ramp and a straight follow-up
  R.push(chain.straight({ gap: 0, drop: 0, length: 5200, descent: 7, side: 'left', width: w1, mat: mats[0], sideMat: SIDE, name: 'ramp 1' }));
  R.push(chain.straight({ gap: 320, drop: 380, length: 3200, descent: 7, side: 'left', width: 352, mat: mats[0], sideMat: SIDE, name: 'ramp 2' }));
  // section 2: left/right zigzag
  R.push(chain.straight({ gap: 448, shift: 800, drop: 440, length: 3200, descent: 7, side: 'right', width: 352, mat: mats[1], sideMat: SIDE, name: 'ramp 3' }));
  R.push(chain.straight({ gap: 576, shift: -800, drop: 500, length: 3200, descent: 7, side: 'left', width: 352, mat: mats[1], sideMat: SIDE, name: 'ramp 4' }));
  // section 3: transfer from ramp 5 to the parallel ramp 6
  R.push(chain.straight({ gap: 640, shift: 0, drop: 520, length: 3600, descent: 7, side: 'left', width: 352, mat: mats[2], sideMat: SIDE, name: 'ramp 5' }));
  const r5 = R[4];
  R.push(chain.straight({ gap: -1600, shift: 960, drop: 520, length: 3600, descent: 7, side: 'right', width: 352, mat: mats[2], sideMat: SIDE, name: 'ramp 6' }));
  // section 4: the long gaps
  R.push(chain.straight({ gap: 704, shift: 0, drop: 560, length: 3200, descent: 7, side: 'right', width: 352, mat: mats[3], sideMat: SIDE, name: 'ramp 7' }));
  R.push(chain.straight({ gap: 832, shift: 0, drop: 600, length: 3000, descent: 7, side: 'right', width: 352, mat: mats[3], sideMat: SIDE, name: 'ramp 8' }));

  // ---------------------------------------------------------------- end platform
  const last = R[R.length - 1];
  const endRidge = last.points[last.points.length - 1];
  const exitPoint = rampPoint(last, 'right', 3000, 0.45);
  const endTop = endRidge.z - 900;
  const endMin = v3(endRidge.x + 600, exitPoint.y - 640, endTop - 64);
  const endMax = v3(endRidge.x + 600 + 2048, exitPoint.y + 640, endTop);
  b.addBox(endMin, endMax, { top: 'builtin/floor_green', sides: SIDE, bottom: SIDE });
  b.addTopTrim(endMin, endMax, 'builtin/glow_green', 12);
  // backstop wall
  b.addBox(v3(endMax.x, endMin.y, endTop - 64), v3(endMax.x + 64, endMax.y, endTop + 512), { sides: WALL, top: WALL });
  b.addZone('end', v3(endMin.x, endMin.y, endTop), v3(endMax.x, endMax.y, endTop + 256));
  const finish = v3((endMin.x + endMax.x) / 2, exitPoint.y, endTop);

  // ---------------------------------------------------------------- sections, checkpoints, fail teleports
  const sectionRamps = [
    [{ ramp: R[0], face: 'left' as const }, { ramp: R[1], face: 'left' as const }],
    [{ ramp: R[2], face: 'right' as const }, { ramp: R[3], face: 'left' as const }],
    [{ ramp: R[4], face: 'left' as const, exitAt: 2400 }, { ramp: R[5], face: 'right' as const }],
    [{ ramp: R[6], face: 'right' as const }, { ramp: R[7], face: 'right' as const }],
  ];
  const sections: CourseSection[] = [];
  for (let s = 0; s < sectionRamps.length; s++) {
    const first = sectionRamps[s][0];
    let dest = 'tut_start';
    if (s > 0) {
      dest = `tut_cp${s}`;
      const d = stageDestination(first.ramp, first.face);
      b.addDestination(dest, d.origin, d.yaw);
      const zb = rampZoneBox(first.ramp, first.face);
      b.addZone('checkpoint', zb.mins, zb.maxs, { index: s });
    }
    sections.push({ name: s === 0 ? 'Start' : `Checkpoint ${s}`, dest, ramps: sectionRamps[s] as CourseRamp[], marker: s });
  }
  void r5;
  addSectionVoid(b, sections, endMin, endMax);

  const course: Course = { id: 'surf_tutorial', type: 'linear', sections, finish };
  return { map: b.build(), course, builder: b };
}

export type { Vec3 };
