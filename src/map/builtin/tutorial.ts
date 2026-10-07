// surf_tutorial - Tier 1, linear.
//
// A start room opens onto a long, wide, gently descending first ramp. Seven more ramps follow with
// growing gaps: a straight follow-up, a left/right zigzag across a corridor, a transfer to a parallel ramp
// and two long jumps, ending on a big platform. Four sections, each colour-coded and marked by a glowing gate
// with a checkpoint zone; falling sends you back to the start of the section you are in, where a drop-in
// (a steeper start that eases out) gives the speed back.
// Bonus 1 (yellow), off to the side: a drop-in, a ^ double ramp, an S-bend and a long finale - through the
// glowing alcove behind the spawn, or !b 1.
import { v3 } from '../../core/vec3';
import { MapBuilder, RampRecord } from './builder';
import { BuiltCourse, Course, CourseRamp, CourseSection, RampChain, rampLength, rampPoint } from './course';
import { addBackstop, addEndSign, addRampGate, addSign, addStartRoom, addVoidGrid, rampBottomInRect, rampZoneBox, stageDestination } from './parts';

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

  // ---------------------------------------------------------------- start room (spawn, start zone, bonus teleporter)
  const BONUS_GLOW = 'builtin/glow_yellow';
  addStartRoom(b, {
    door: v3(X0, 0, Z0),
    floor: FLOOR,
    wall: WALL,
    ceiling: 'builtin/wall_grey',
    trim: 'builtin/glow_cyan',
    dest: 'tut_start',
    group: 0,
    playerSpawn: true,
    alcove: { dest: 'tut_b1', glow: BONUS_GLOW },
    label: 'SURF TUTORIAL',
  });
  // the basics on the side walls of the start room, and a reminder floating over the first ramp
  addSign(b, 'HOLD A OR D INTO THE RAMP', v3(X0 - 320, -253, Z0 + 168), v3(0, 1, 0), 20, 'builtin/glow_cyan');
  addSign(b, 'NEVER PRESS W ON A RAMP', v3(X0 - 320, -253, Z0 + 128), v3(0, 1, 0), 20, 'builtin/glow_cyan');
  addSign(b, 'TYPE !R TO RESTART', v3(X0 - 320, 253, Z0 + 168), v3(0, -1, 0), 20, 'builtin/glow_cyan');
  addSign(b, '!B 1 OR BACK DOOR FOR BONUS', v3(X0 - 320, 253, Z0 + 128), v3(0, -1, 0), 20, BONUS_GLOW);

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
  // the first ramp's face is on your left: hold D (strafe right, toward the ridge) and look down the ramp
  const hint = rampPoint(R[0], 'left', 1100, 0.45);
  addSign(b, 'HOLD D', v3(hint.x, hint.y, Z0 + 140), v3(-1, 0, 0), 96, 'builtin/glow_cyan');
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
  addEndSign(b, endMin, endMax, v3(1, 0, 0), 'builtin/glow_green');
  addBackstop(b, endMin, endMax, v3(1, 0, 0), WALL);
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
      addRampGate(b, first.ramp, first.face, 64, glows[s], 16, `CP ${s}`);
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

  // ---------------------------------------------------------------- bonus 1
  // Off to the side (+y) of the main course, reached from the start room's back alcove or with !b 1: a drop-in,
  // a ^ double ramp, an S-bend (a left bend, a hop across onto a right bend) and a long finale.
  const BY = 7400;
  const BZ = 5600;
  const bonusRoom = addStartRoom(b, { door: v3(X0, BY, BZ), floor: FLOOR, wall: WALL, ceiling: 'builtin/wall_grey', trim: BONUS_GLOW, dest: 'tut_b1', group: 1, label: 'BONUS 1' });
  const BM = { mat: 'builtin/ramp_yellow', sideMat: SIDE, trimMat: TRIM, trimWidth: 6 };
  const bch = new RampChain(b, v3(X0 - 112, BY - w1 * 0.55, BZ - 96), 0);
  const B: RampRecord[] = [];
  B.push(bch.straight({ gap: 0, drop: 0, length: 3600, descent: 7, dropIn, side: 'left', width: w1, ...BM, name: 'bonus drop-in' }));
  B.push(bch.straight({ gap: 448, speed: 1000, land: 450, length: 3000, descent: 5, side: 'both', width: W, ...BM, name: 'bonus double ramp' }));
  B.push(bch.curve({ gap: 512, speed: 1150, land: 450, radius: 2800, angle: 60, segments: 14, descent: 4, nz: 0.58, side: 'left', width: W, ...BM, name: 'bonus left bend' }));
  B.push(bch.curve({ gap: 640, shift: 760, travel: 460, speed: 1100, land: 420, radius: 2800, angle: -60, segments: 14, descent: 4, nz: 0.58, side: 'right', width: W, ...BM, name: 'bonus right bend' }));
  B.push(bch.straight({ gap: 704, shift: -760, travel: 460, speed: 1200, land: 420, length: 3600, descent: 5, side: 'left', width: W, ...BM, name: 'bonus finale' }));
  const blast = B[B.length - 1];
  const bRidge = blast.points[blast.points.length - 1];
  const bExit = rampPoint(blast, 'left', rampLength(blast), 0.45);
  const bTop = bRidge.z - 900;
  const bEndMin = v3(bRidge.x + 576, bExit.y - 640, bTop - 64);
  const bEndMax = v3(bRidge.x + 576 + 1536, bExit.y + 640, bTop);
  b.addBox(bEndMin, bEndMax, { top: 'builtin/floor_yellow', sides: SIDE, bottom: SIDE });
  b.addTopTrim(bEndMin, bEndMax, BONUS_GLOW, 12);
  addEndSign(b, bEndMin, bEndMax, v3(1, 0, 0), BONUS_GLOW);
  addBackstop(b, bEndMin, bEndMax, v3(1, 0, 0), WALL);
  b.addZone('end', v3(bEndMin.x, bEndMin.y, bTop), v3(bEndMax.x, bEndMax.y, bTop + 1024), { group: 1 });
  const bonus: Course = {
    id: 'surf_tutorial bonus 1',
    type: 'linear',
    group: 1,
    sections: [
      {
        name: 'Bonus 1',
        dest: 'tut_b1',
        marker: 0,
        ramps: [
          { ramp: B[0], face: 'left' },
          { ramp: B[1], face: 'left' },
          { ramp: B[2], face: 'left' },
          { ramp: B[3], face: 'right' },
          { ramp: B[4], face: 'left' },
        ],
      },
    ],
    finish: v3((bEndMin.x + bEndMax.x) / 2, bExit.y, bTop),
  };
  const bRoomBox = { mins: v3(bonusRoom.mins.x - 32, bonusRoom.mins.y - 32, BZ - 16), maxs: v3(bonusRoom.maxs.x + 16, bonusRoom.maxs.y + 32, BZ + 304) };
  addVoidGrid(b, {
    x0: -16384,
    x1: 16384,
    y0: 4096,
    y1: 14336,
    cell: 512,
    floorZ: groundZ - 512,
    owners: [{ dest: 'tut_b1', pieces: B.map((r) => ({ ramp: r })), boxes: [{ mins: bEndMin, maxs: bEndMax }] }],
    ramps: B,
    boxes: [bRoomBox, { mins: bEndMin, maxs: bEndMax }],
  });

  const course: Course = { id: 'surf_tutorial', type: 'linear', group: 0, sections, finish };
  return { map: b.build(), course, bonuses: [bonus], builder: b };
}
