// surf_tutorial - Tier 1, linear.
//
// A start room opens onto a long, wide, gently descending first ramp. Seven more ramps follow with
// growing gaps: a straight follow-up, a left/right zigzag across a corridor, a transfer to a parallel ramp
// and two long jumps, ending on a big platform. Four sections, each colour-coded and marked by a glowing gate
// with a checkpoint zone; falling sends you back to the start of the section you are in, where a drop-in
// (a steeper start that eases out) gives the speed back.
import { v3 } from '../../core/vec3';
import { MapBuilder, RampRecord } from './builder';
import { BuiltCourse, Course, CourseRamp, CourseSection, RampChain, rampPoint } from './course';
import { addRampGate, addVoidGrid, rampBottomInRect, rampZoneBox, stageDestination } from './parts';

export function buildTutorial(): BuiltCourse {
  const b = new MapBuilder('surf_tutorial', {
    sky: 'sky_day01_01',
    fog: { enabled: true, color: [0.68, 0.78, 0.9], start: 6000, end: 28000, maxDensity: 0.5 },
  });
  const FLOOR = 'builtin/floor_grey';
  const WALL = 'builtin/wall_grid';
  const SIDE = 'builtin/wall_dark';
  const TRIM = 'builtin/glow_white';
  /** Start room floor height and front wall x. */
  const Z0 = 6400;
  const X0 = -14900;

  // ---------------------------------------------------------------- start room (spawn, start zone)
  const roomMin = v3(X0 - 640, -256, Z0);
  const roomMax = v3(X0, 256, Z0 + 288);
  b.addRoom(roomMin, roomMax, { floor: FLOOR, wall: WALL, ceiling: 'builtin/wall_grey' }, [
    { side: '+x', a0: -208, a1: 208, z0: Z0, z1: Z0 + 240 },
  ]);
  b.addTopTrim(v3(roomMin.x, roomMin.y, Z0 - 16), v3(roomMax.x, roomMax.y, Z0), 'builtin/glow_cyan', 6);
  const spawn = v3(X0 - 512, 0, Z0 + 1);
  b.addSpawn(spawn, 0);
  b.addDestination('tut_start', spawn, 0);
  b.addZone('start', v3(roomMin.x + 16, roomMin.y + 16, Z0), v3(X0 - 16, roomMax.y - 16, Z0 + 160), { spawn: { origin: spawn, yaw: 0 } });

  // ---------------------------------------------------------------- ramps
  // Gap drops are ballistic (RampChain.autoDrop): `speed` is the exit speed a gap is designed for - the speed a
  // restart from the section's checkpoint (or the start) reaches there, minus a margin - and `land` is how far
  // into the next ramp such a run lands. Every gap is therefore makeable straight from a checkpoint restart;
  // faster (through) runs simply land deeper into the next ramp, which is long enough for them.
  const w1 = 384;
  const chain = new RampChain(b, v3(X0 - 112, -w1 * 0.55, Z0 - 96), 0);
  const R: RampRecord[] = [];
  const mats = ['builtin/ramp_cyan', 'builtin/ramp_orange', 'builtin/ramp_green', 'builtin/ramp_purple'];
  const glows = ['builtin/glow_cyan', 'builtin/glow_orange', 'builtin/glow_green', 'builtin/glow_purple'];
  const dropIn = { angle: 26, length: 1400, steps: 10 };
  const W = 352;
  // section 1: the long first ramp and a straight follow-up
  R.push(chain.straight({ gap: 0, drop: 0, length: 4200, descent: 7, side: 'left', width: w1, mat: mats[0], sideMat: SIDE, trimMat: TRIM, trimWidth: 6, name: 'ramp 1' }));
  R.push(chain.straight({ gap: 320, speed: 900, land: 400, length: 3000, descent: 5, side: 'left', width: W, mat: mats[0], sideMat: SIDE, trimMat: TRIM, trimWidth: 6, name: 'ramp 2' }));
  // section 2: left/right zigzag across a corridor
  R.push(chain.straight({ gap: 448, shift: 800, travel: 500, speed: 1100, land: 450, length: 3200, descent: 5, dropIn, side: 'right', width: W, mat: mats[1], sideMat: SIDE, trimMat: TRIM, trimWidth: 6, name: 'ramp 3' }));
  R.push(chain.straight({ gap: 576, shift: -800, travel: 500, speed: 790, land: 380, length: 3200, descent: 5, side: 'left', width: W, mat: mats[1], sideMat: SIDE, trimMat: TRIM, trimWidth: 6, name: 'ramp 4' }));
  // section 3: transfer from ramp 5 to the parallel ramp 6 (a bit lower, across a gap)
  R.push(chain.straight({ gap: 640, speed: 1060, land: 400, length: 3000, descent: 5, dropIn, side: 'left', width: W, mat: mats[2], sideMat: SIDE, trimMat: TRIM, trimWidth: 6, name: 'ramp 5' }));
  const r5 = R[R.length - 1];
  // ramp 6 starts 1400 units into ramp 5 (past its drop-in), 300 units below ramp 5's ridge there
  const r6drop = chain.pos.z - (rampPoint(r5, 'left', 1400, 0).z - 300);
  R.push(chain.straight({ gap: -1600, shift: 832, drop: r6drop, length: 3700, descent: 5, side: 'right', width: W, mat: mats[2], sideMat: SIDE, trimMat: TRIM, trimWidth: 6, name: 'ramp 6' }));
  // section 4: the long jumps
  R.push(chain.straight({ gap: 704, speed: 930, land: 400, length: 3200, descent: 5, dropIn, side: 'right', width: W, mat: mats[3], sideMat: SIDE, trimMat: TRIM, trimWidth: 6, name: 'ramp 7' }));
  R.push(chain.straight({ gap: 832, speed: 790, land: 400, length: 3600, descent: 5, side: 'right', width: W, mat: mats[3], sideMat: SIDE, trimMat: TRIM, trimWidth: 6, name: 'ramp 8' }));

  // ---------------------------------------------------------------- end platform
  const last = R[R.length - 1];
  const endRidge = last.points[last.points.length - 1];
  const exitPoint = rampPoint(last, 'right', 3600, 0.45);
  const endTop = endRidge.z - 900;
  const endMin = v3(endRidge.x + 576, exitPoint.y - 640, endTop - 64);
  const endMax = v3(endRidge.x + 576 + 1536, exitPoint.y + 640, endTop);
  b.addBox(endMin, endMax, { top: 'builtin/floor_green', sides: SIDE, bottom: SIDE });
  b.addTopTrim(endMin, endMax, 'builtin/glow_green', 12);
  // backstop wall
  b.addBox(v3(endMax.x, endMin.y, endTop - 64), v3(endMax.x + 64, endMax.y, endTop + 512), { sides: WALL, top: WALL });
  b.addZone('end', v3(endMin.x, endMin.y, endTop), v3(endMax.x, endMax.y, endTop + 1024));
  const finish = v3((endMin.x + endMax.x) / 2, exitPoint.y, endTop);

  // ---------------------------------------------------------------- sections, checkpoints, gates
  const sectionRamps: CourseRamp[][] = [
    [
      { ramp: R[0], face: 'left' },
      { ramp: R[1], face: 'left' },
    ],
    [
      { ramp: R[2], face: 'right' },
      { ramp: R[3], face: 'left' },
    ],
    [
      { ramp: R[4], face: 'left', exitAt: 1650 },
      { ramp: R[5], face: 'right' },
    ],
    [
      { ramp: R[6], face: 'right' },
      { ramp: R[7], face: 'right' },
    ],
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
      addRampGate(b, first.ramp, first.face, 64, glows[s]);
    }
    sections.push({ name: s === 0 ? 'Start' : `Checkpoint ${s}`, dest, ramps: sectionRamps[s], marker: s });
  }

  // ---------------------------------------------------------------- the void: fail teleports + ground far below
  const lowest = Math.min(...R.map((r) => rampBottomInRect(r, -1e9, 1e9, -1e9, 1e9)), endTop - 64);
  const groundZ = lowest - 1400;
  const owners = sections.map((s, i) => {
    const next = sections[i + 1]?.ramps[0].ramp;
    // missing the next section's first ramp (its first 448 units) sends you back to this section
    const pieces = [...s.ramps.map((c) => ({ ramp: c.ramp })), ...(next ? [{ ramp: next, to: 448 }] : [])];
    return { dest: s.dest, pieces, boxes: i === sections.length - 1 ? [{ mins: endMin, maxs: endMax }] : [] };
  });
  addVoidGrid(b, { x0: -16384, x1: 16384, y0: -4096, y1: 4096, cell: 512, floorZ: groundZ - 512, owners, ramps: R, boxes: [{ mins: endMin, maxs: endMax }] });
  // a wide, muted ground far below for a sense of height (fades into the haze)
  b.setMaterialColor('builtin/grid_ground', [0.36, 0.45, 0.52]);
  b.addBox(v3(-16384, -16384, groundZ - 64), v3(16384, 16384, groundZ), { top: 'builtin/grid_ground', sides: null, bottom: null });

  const course: Course = { id: 'surf_tutorial', type: 'linear', sections, finish };
  return { map: b.build(), course, builder: b };
}
