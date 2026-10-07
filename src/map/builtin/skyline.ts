// surf_skyline - Tier 3, linear. Long, flowing ramps sweep left and right over a misty void at dusk, past
// the silhouettes of towers rising out of the fog. Narrower faces, sweeping curves and big gaps sized to
// the speed you carry. Four sections with checkpoints; a fall sends you back to the start of the section,
// where a drop-in gives the speed back. Bonus 1 (cyan), in the north half of the map: a 90 degree sweep, a
// drop onto a 180 degree U-turn and a hop across to the finale - through the alcove behind the spawn, or !b 1.
import { v3, Vec3 } from '../../core/vec3';
import { MapBuilder, RampRecord } from './builder';
import { BuiltCourse, Course, CourseRamp, CourseSection, RampChain, dirOf, rampLength, rampPoint } from './course';
import { addBackstop, addRampGate, addStartRoom, addVoidGrid, rampZoneBox, stageDestination } from './parts';

export function buildSkyline(): BuiltCourse {
  const b = new MapBuilder('surf_skyline', {
    sky: 'sky_dusk_skyline',
    fog: { enabled: true, color: [0.78, 0.55, 0.45], start: 3500, end: 24000, maxDensity: 0.8 },
  });
  const RAMP = 'builtin/ramp_white';
  const SIDE = 'builtin/wall_dark';
  const TRIM = 'builtin/glow_orange';
  const W = 320;
  const st = { mat: RAMP, sideMat: SIDE, trimMat: TRIM };
  const Z0 = 8400;
  const start = v3(-14200, -12600, Z0);

  // ---------------------------------------------------------------- start room
  const BONUS_GLOW = 'builtin/glow_cyan';
  addStartRoom(b, {
    door: start,
    floor: 'builtin/floor_grey',
    wall: 'builtin/wall_grey',
    ceiling: 'builtin/wall_dark',
    trim: TRIM,
    dest: 'sky_start',
    group: 0,
    playerSpawn: true,
    alcove: { dest: 'sky_b1', glow: BONUS_GLOW },
  });

  // ---------------------------------------------------------------- the course
  const dropIn = { angle: 26, length: 1400, steps: 10 };
  const ch = new RampChain(b, v3(start.x - 112, start.y - W * 0.55, Z0 - 96), 0);
  const R: RampRecord[] = [];
  // section 1: a long opener sweeping left
  R.push(ch.straight({ gap: 0, drop: 0, length: 4000, descent: 8, side: 'left', width: W, ...st, name: 'opener' }));
  R.push(ch.curve({ gap: 448, speed: 1000, land: 400, radius: 3400, angle: 75, segments: 15, descent: 4, nz: 0.56, side: 'left', width: W, ...st, name: 'left sweep' }));
  // section 2: a drop-in, then a long sweep back to the right (a lateral hop onto the other face)
  R.push(ch.straight({ gap: 512, speed: 1100, land: 420, length: 3600, descent: 5, dropIn, side: 'left', width: W, ...st, name: 'cp1 drop' }));
  R.push(ch.curve({ gap: 640, shift: 760, travel: 460, speed: 800, land: 420, radius: 3200, angle: -110, segments: 22, descent: 4, nz: 0.56, side: 'right', width: W, ...st, name: 'right sweep' }));
  // section 3: drop-in into a tight left hook, then a long straight
  R.push(ch.straight({ gap: 640, speed: 1100, land: 420, length: 3600, descent: 5, dropIn, side: 'right', width: W, ...st, name: 'cp2 drop' }));
  R.push(ch.curve({ gap: 704, shift: -760, travel: 460, speed: 820, land: 420, radius: 3400, angle: 95, segments: 19, descent: 4, nz: 0.56, side: 'left', width: W, ...st, name: 'left hook' }));
  // section 4: drop-in, a long straight and the big final gap onto the end platform
  R.push(ch.straight({ gap: 768, speed: 1100, land: 420, length: 4200, descent: 5, dropIn, side: 'left', width: W, ...st, name: 'cp3 drop' }));
  R.push(ch.straight({ gap: 960, speed: 820, land: 420, length: 4800, descent: 5, side: 'left', width: W, ...st, name: 'finale' }));

  // ---------------------------------------------------------------- end platform
  const last = R[R.length - 1];
  const ex = rampPoint(last, 'left', 4800, 0.42);
  const dir = v3(last.points[1].x - last.points[0].x, last.points[1].y - last.points[0].y, 0);
  const dl = Math.hypot(dir.x, dir.y);
  const fx = dir.x / dl;
  const fy = dir.y / dl;
  const endTop = ex.z - 900;
  const c = v3(ex.x + fx * 1600, ex.y + fy * 1600, endTop);
  const half = 900;
  const endMin = v3(c.x - half, c.y - half, endTop - 64);
  const endMax = v3(c.x + half, c.y + half, endTop);
  b.addBox(endMin, endMax, { top: 'builtin/floor_orange', sides: SIDE, bottom: SIDE });
  b.addTopTrim(endMin, endMax, TRIM, 16);
  addBackstop(b, endMin, endMax, v3(fx, fy, 0), 'builtin/wall_grey');
  b.addZone('end', v3(endMin.x, endMin.y, endTop), v3(endMax.x, endMax.y, endTop + 1024));
  const finish = v3(c.x, c.y, endTop);

  // ---------------------------------------------------------------- sections
  const sectionRamps: CourseRamp[][] = [
    [
      { ramp: R[0], face: 'left' },
      { ramp: R[1], face: 'left' },
    ],
    [
      { ramp: R[2], face: 'left' },
      { ramp: R[3], face: 'right' },
    ],
    [
      { ramp: R[4], face: 'right' },
      { ramp: R[5], face: 'left' },
    ],
    [
      { ramp: R[6], face: 'left' },
      { ramp: R[7], face: 'left' },
    ],
  ];
  const sections: CourseSection[] = [];
  for (let s = 0; s < sectionRamps.length; s++) {
    const first = sectionRamps[s][0];
    let dest = 'sky_start';
    if (s > 0) {
      dest = `sky_cp${s}`;
      const d = stageDestination(first.ramp, first.face);
      b.addDestination(dest, d.origin, d.yaw);
      const zb = rampZoneBox(first.ramp, first.face);
      b.addZone('checkpoint', zb.mins, zb.maxs, { index: s });
      addRampGate(b, first.ramp, first.face, 64, TRIM);
    }
    sections.push({ name: s === 0 ? 'Start' : `Checkpoint ${s}`, dest, ramps: sectionRamps[s], marker: s });
  }

  // ---------------------------------------------------------------- bonus 1 (cyan): sweep, U-turn, finale
  // In the empty north half of the map, reached from the start room's back alcove or with !b 1.
  const BZ = 8000;
  const bStart = v3(-14200, 9000, BZ);
  const bRoom = addStartRoom(b, { door: bStart, floor: 'builtin/floor_grey', wall: 'builtin/wall_grey', ceiling: 'builtin/wall_dark', trim: BONUS_GLOW, dest: 'sky_b1', group: 1 });
  const bst = { mat: RAMP, sideMat: SIDE, trimMat: BONUS_GLOW };
  const bch = new RampChain(b, v3(bStart.x - 112, bStart.y - W * 0.55, BZ - 96), 0);
  const B: RampRecord[] = [];
  B.push(bch.straight({ gap: 0, drop: 0, length: 3600, descent: 8, dropIn, side: 'left', width: W, ...bst, name: 'bonus drop-in' }));
  B.push(bch.curve({ gap: 448, speed: 1000, land: 400, radius: 3200, angle: 90, segments: 18, descent: 4, nz: 0.56, side: 'left', width: W, ...bst, name: 'bonus sweep' }));
  B.push(bch.curve({ gap: 576, shift: 440, travel: 200, speed: 1150, land: 420, radius: 2600, angle: -180, segments: 34, descent: 4, nz: 0.56, side: 'right', width: W, ...bst, name: 'bonus u-turn' }));
  B.push(bch.straight({ gap: 704, shift: -760, travel: 460, speed: 1000, land: 420, length: 3600, descent: 5, side: 'left', width: W, ...bst, name: 'bonus finale' }));
  const bLast = B[B.length - 1];
  const bEx = rampPoint(bLast, 'left', rampLength(bLast), 0.42);
  const bFwd = dirOf(bch.yaw);
  const bTop = bEx.z - 900;
  const bc = v3(bEx.x + bFwd.x * 1500, bEx.y + bFwd.y * 1500, bTop);
  const bEndMin = v3(bc.x - 768, bc.y - 768, bTop - 64);
  const bEndMax = v3(bc.x + 768, bc.y + 768, bTop);
  b.addBox(bEndMin, bEndMax, { top: 'builtin/floor_cyan', sides: SIDE, bottom: SIDE });
  b.addTopTrim(bEndMin, bEndMax, BONUS_GLOW, 16);
  addBackstop(b, bEndMin, bEndMax, bFwd, 'builtin/wall_grey');
  b.addZone('end', v3(bEndMin.x, bEndMin.y, bTop), v3(bEndMax.x, bEndMax.y, bTop + 1024), { group: 1 });
  const bonus: Course = {
    id: 'surf_skyline bonus 1',
    type: 'linear',
    group: 1,
    sections: [
      {
        name: 'Bonus 1',
        dest: 'sky_b1',
        marker: 0,
        ramps: [
          { ramp: B[0], face: 'left' },
          { ramp: B[1], face: 'left' },
          { ramp: B[2], face: 'right' },
          { ramp: B[3], face: 'left' },
        ],
      },
    ],
    finish: bc,
  };
  const bRoomBox = { mins: v3(bRoom.mins.x - 32, bRoom.mins.y - 32, BZ - 16), maxs: v3(bRoom.maxs.x + 16, bRoom.maxs.y + 32, BZ + 304) };

  // ---------------------------------------------------------------- the void: fail teleports, towers in the fog
  const all = [...R, ...B];
  const lowest = Math.min(...all.map((r) => Math.min(...r.ribs.flat().map((p) => p.z))), endMin.z, bEndMin.z);
  const floorZ = lowest - 1800;
  const owners = sections.map((s, i) => {
    const next = sections[i + 1]?.ramps[0].ramp;
    // missing the next section's first ramp sends you back to this section
    const pieces = [...s.ramps.map((r) => ({ ramp: r.ramp })), ...(next ? [{ ramp: next, to: 448 }] : [])];
    return { dest: s.dest, pieces, boxes: i === sections.length - 1 ? [{ mins: endMin, maxs: endMax }] : [] };
  });
  owners.push({ dest: 'sky_b1', pieces: B.map((r) => ({ ramp: r })), boxes: [bRoomBox, { mins: bEndMin, maxs: bEndMax }] });
  addVoidGrid(b, {
    x0: -16384,
    x1: 16384,
    y0: -16384,
    y1: 16384,
    cell: 768,
    floorZ: floorZ - 512,
    owners,
    ramps: all,
    boxes: [{ mins: endMin, maxs: endMax }, bRoomBox, { mins: bEndMin, maxs: bEndMax }],
  });
  addTowers(b, all, floorZ, [bRoomBox, { mins: bEndMin, maxs: bEndMax }, { mins: endMin, maxs: endMax }]);

  const course: Course = { id: 'surf_skyline', type: 'linear', group: 0, sections, finish };
  return { map: b.build(), course, bonuses: [bonus], builder: b };
}

/** Tower silhouettes rising out of the fog beside the course (well below and away from every ramp). */
function addTowers(b: MapBuilder, ramps: RampRecord[], floorZ: number, boxes: { mins: Vec3; maxs: Vec3 }[]): void {
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts: Vec3[] = [];
  for (const r of ramps) for (const rib of r.ribs) for (const p of rib) pts.push(p);
  // rooms and platforms count as course too (their corners and centre)
  for (const bx of boxes) {
    for (const x of [bx.mins.x, (bx.mins.x + bx.maxs.x) / 2, bx.maxs.x]) for (const y of [bx.mins.y, (bx.mins.y + bx.maxs.y) / 2, bx.maxs.y]) pts.push(v3(x, y, bx.mins.z));
  }
  const placed: { x: number; y: number; s: number }[] = [];
  for (let k = 0; k < 400 && placed.length < 46; k++) {
    const x = -15000 + rnd() * 30000;
    const y = -15000 + rnd() * 30000;
    const s = 300 + rnd() * 500;
    // keep clear of the course: at least 1400 units sideways from any ramp point
    let near = Infinity;
    let below = Infinity;
    for (const p of pts) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < near) near = d;
      if (d < 3000) below = Math.min(below, p.z);
    }
    if (near < 1400 + s) continue;
    if (placed.some((t) => Math.hypot(t.x - x, t.y - y) < t.s + s + 600)) continue;
    const top = Math.min(below - 1600, floorZ + 2000 + rnd() * 3500);
    if (top < floorZ + 600) continue;
    placed.push({ x, y, s });
    b.addBox(v3(x - s / 2, y - s / 2, floorZ - 2000), v3(x + s / 2, y + s / 2, top), { sides: 'builtin/grid_dark', top: 'builtin/wall_dark', bottom: null });
    b.addTopTrim(v3(x - s / 2, y - s / 2, top - 1), v3(x + s / 2, y + s / 2, top), 'builtin/glow_orange', 10);
  }
}
