// surf_neon - Tier 2, staged (4 stages). A dark world of black ramps outlined in glowing colours over a
// neon grid far below. Every stage starts in its own room whose doorway drops you onto the stage's first
// ramp, and ends in a glowing portal that takes you to the next stage room. Falling sends you back to the
// start of the current stage.
//   Stage 1 (cyan)   - warm-up: a long ramp, a straight follow-up, a classic ^ double ramp, a zigzag.
//   Stage 2 (pink)   - an up-ramp into a booster that launches you over a big gap.
//   Stage 3 (green)  - a long segmented curve: a 180 degree U-turn ramp.
//   Stage 4 (orange) - a zig-zag into a booster column that throws you across a long gap, then the final
//                      ramp onto the end platform.
//   Bonus 1 (red)    - a zig-zag onto an up-ramp, a booster launch and a banked 90 degree curve; through the
//                      glowing alcove behind the stage 1 spawn, or !b 1.
// Booster landings are placed with predictFlight (trigger_push semantics) for the weakest launch that still
// counts, so every launch between a slow, low exit and a fast, high one comes down on the landing ramp.
import { qa } from '../../core/angles';
import { Vec3, v3 } from '../../core/vec3';
import { MapBuilder, RampRecord, rampHeightFor } from './builder';
import { BuiltCourse, Course, CourseRamp, CourseSection, RampChain, dirOf, rampLength, rampPoint } from './course';
import { PushVolume, addBackstop, addBonusAlcove, addGlowBar, addStageRoom, addVoidGrid, bonusAlcoveOpening, predictFlight, pushVector } from './parts';

const STAGE_COLORS = ['cyan', 'pink', 'green', 'orange'];

interface StageCtx {
  b: MapBuilder;
  index: number;
  glow: string;
  /** Room door center at floor level (the room extends toward -x). */
  door: Vec3;
}

/** Blue-black ramp faces (custom colour, set in buildNeon). */
const RAMP = 'builtin/ramp_night';
const SIDE = 'builtin/wall_black';

/**
 * A stage room opening toward +x at `door` (optionally with a bonus teleporter alcove in its back wall).
 * Returns its spawn point and zone box.
 */
function stageRoom(c: StageCtx, alcove?: { dest: string; glow: string }): { spawn: Vec3; mins: Vec3; maxs: Vec3 } {
  const { b, door } = c;
  const mins = v3(door.x - 576, door.y - 240, door.z);
  const maxs = v3(door.x, door.y + 240, door.z + 288);
  const style = { floor: 'builtin/floor_dark', wall: 'builtin/grid_dark', ceiling: 'builtin/wall_black', trim: c.glow };
  addStageRoom(b, mins, maxs, '+x', style, 240, 48, alcove ? [bonusAlcoveOpening(door.y, door.z)] : []);
  if (alcove) addBonusAlcove(b, mins.x, door.y, door.z, alcove.dest, { floor: style.floor, wall: style.wall, glow: alcove.glow });
  // glowing door frame
  addGlowBar(b, v3(door.x + 8, door.y - 192, door.z), v3(door.x + 8, door.y - 192, door.z + 240), 12, c.glow);
  addGlowBar(b, v3(door.x + 8, door.y + 192, door.z), v3(door.x + 8, door.y + 192, door.z + 240), 12, c.glow);
  addGlowBar(b, v3(door.x + 8, door.y - 192, door.z + 240), v3(door.x + 8, door.y + 192, door.z + 240), 12, c.glow);
  return { spawn: v3(door.x - 448, door.y, door.z + 1), mins: v3(mins.x + 16, mins.y + 16, mins.z), maxs: v3(maxs.x - 16, maxs.y - 16, mins.z + 160) };
}

/**
 * A glowing portal frame across the flight path at `center`, for runs travelling along +x (`dir` 1) or -x
 * (`dir` -1), with a trigger_teleport filling it - reaching well below, so a run that drops short still gets in.
 */
function portal(c: StageCtx, center: Vec3, dir: 1 | -1, dest: string, halfW = 640, up = 448, down = 896): void {
  const { b } = c;
  const x = center.x;
  const y0 = center.y - halfW;
  const y1 = center.y + halfW;
  const z0 = center.z - down;
  const z1 = center.z + up;
  const g = c.glow;
  addGlowBar(b, v3(x, y0, z0), v3(x, y0, z1), 32, g);
  addGlowBar(b, v3(x, y1, z0), v3(x, y1, z1), 32, g);
  addGlowBar(b, v3(x, y0, z1), v3(x, y1, z1), 32, g);
  addGlowBar(b, v3(x, y0, z0), v3(x, y1, z0), 32, g);
  for (const k of [0.33, 0.66]) {
    const zz = z0 + (z1 - z0) * k;
    addGlowBar(b, v3(x, y0, zz), v3(x, y1, zz), 6, g);
  }
  // the volume starts a little before the frame and goes on behind it
  const xa = dir > 0 ? x - 64 : x - 192;
  const xb = dir > 0 ? x + 192 : x + 64;
  b.addTeleport(v3(xa, y0, z0), v3(xb, y1, z1), dest);
}

export function buildNeon(): BuiltCourse {
  const b = new MapBuilder('surf_neon', {
    sky: 'sky_night_neon',
    fog: { enabled: true, color: [0.05, 0.03, 0.1], start: 3000, end: 22000, maxDensity: 0.85 },
  });
  b.setMaterialColor(RAMP, [0.2, 0.21, 0.28]);
  const sections: CourseSection[] = [];
  const allRamps: RampRecord[] = [];
  const stageRamps: CourseRamp[][] = [];
  const doors: Vec3[] = [
    v3(-14200, -12500, 5600),
    v3(-14200, -6000, 5600),
    v3(-14200, 0, 5600),
    v3(-14200, 11000, 5600),
  ];
  const dests = ['neon_s1', 'neon_s2', 'neon_s3', 'neon_s4'];
  const BONUS_GLOW = 'builtin/glow_red';
  const rooms = doors.map((door, i) => {
    const ctx: StageCtx = { b, index: i, glow: `builtin/glow_${STAGE_COLORS[i]}`, door };
    const r = stageRoom(ctx, i === 0 ? { dest: 'neon_b1', glow: BONUS_GLOW } : undefined);
    const box = { mins: v3(r.mins.x - 32, r.mins.y - 32, door.z - 16), maxs: v3(door.x + 16, r.maxs.y + 32, door.z + 304) };
    b.addDestination(dests[i], r.spawn, 0);
    if (i === 0) {
      b.addSpawn(r.spawn, 0);
      b.addZone('start', r.mins, r.maxs, { spawn: { origin: r.spawn, yaw: 0 } });
    } else {
      b.addZone('stage', r.mins, r.maxs, { index: i + 1, spawn: { origin: r.spawn, yaw: 0 } });
    }
    return { ctx, box, ...r };
  });
  const ramp = (i: number) => ({ mat: RAMP, sideMat: SIDE, trimMat: `builtin/glow_${STAGE_COLORS[i]}` });
  const W = 352;

  // ================================================================ stage 1: warm-up
  {
    const c = rooms[0].ctx;
    const d = c.door;
    const ch = new RampChain(b, v3(d.x - 112, d.y - 384 * 0.55, d.z - 96), 0);
    const R1 = ch.straight({ gap: 0, drop: 0, length: 5000, descent: 7, side: 'left', width: 384, ...ramp(0), name: 's1 long ramp' });
    const R2 = ch.straight({ gap: 384, speed: 950, land: 480, length: 3000, descent: 6, side: 'left', width: W, ...ramp(0), name: 's1 ramp 2' });
    const R3 = ch.straight({ gap: 512, speed: 1150, land: 560, length: 3000, descent: 6, side: 'both', width: W, ...ramp(0), name: 's1 double ramp' });
    const R4 = ch.straight({ gap: 576, shift: 800, travel: 500, speed: 1300, land: 600, length: 3000, descent: 6, side: 'right', width: W, ...ramp(0), name: 's1 zig' });
    const exit = rampPoint(R4, 'right', 3000, 0.42);
    const pc = v3(exit.x + 900, exit.y, exit.z - 200);
    portal(c, pc, 1, dests[1]);
    stageRamps.push([
      { ramp: R1, face: 'left' },
      { ramp: R2, face: 'left' },
      { ramp: R3, face: 'left' },
      { ramp: R4, face: 'right' },
    ]);
    sections.push({ name: 'Stage 1', dest: dests[0], ramps: stageRamps[0], marker: 1, exit: pc });
    allRamps.push(R1, R2, R3, R4);
  }

  // ================================================================ stage 2: up-ramp + booster
  {
    const c = rooms[1].ctx;
    const d = c.door;
    const ch = new RampChain(b, v3(d.x - 112, d.y - W * 0.45, d.z - 96), 0);
    const R1 = ch.straight({ gap: 0, drop: 0, length: 3600, descent: 7, dropIn: { angle: 22, length: 960, steps: 8 }, side: 'left', width: W, ...ramp(1), name: 's2 drop-in' });
    const R2 = ch.straight({ gap: 448, speed: 1150, land: 520, length: 3200, descent: 6, side: 'left', width: W, ...ramp(1), name: 's2 ramp 2' });
    const R3 = ch.straight({ gap: 576, speed: 1400, land: 560, length: 2400, descent: -5, side: 'left', width: W, ...ramp(1), name: 's2 up-ramp' });
    // booster column over the top of the up-ramp: a strong, steep push launches you over the big gap
    const ridgeEnd = rampPoint(R3, 'left', 2400, 0);
    const exit3 = rampPoint(R3, 'left', 2400, 0.42);
    const boost: PushVolume = {
      mins: v3(ridgeEnd.x - 320, ridgeEnd.y - 64, ridgeEnd.z - R3.height),
      maxs: v3(ridgeEnd.x + 160, ridgeEnd.y + W + 64, ridgeEnd.z + 1600),
      push: pushVector(-78, 0, 2600),
    };
    b.addPush(boost.mins, boost.maxs, qa(-78, 0, 0), 2600);
    boosterFrame(b, boost.mins, boost.maxs, 'builtin/glow_yellow');
    // the landing ramp sits where a run leaving the up-ramp at ~1050 u/s comes down
    const fl = predictFlight(v3(exit3.x - 200, exit3.y, exit3.z + 20), v3(1050, 0, 90), { pushes: [boost], untilZ: exit3.z - 420 });
    const R4w = 384;
    const R4land = 920;
    ch.moveTo(v3(fl.pos.x - R4land, fl.pos.y - R4w * 0.42, fl.pos.z + R4land * Math.tan((7 * Math.PI) / 180) + 0.42 * rampHeight(R4w)), 0, 7);
    const R4 = ch.straight({ gap: 0, drop: 0, length: 4000, descent: 7, side: 'left', width: R4w, ...ramp(1), name: 's2 landing' });
    const R5 = ch.straight({ gap: 704, speed: 1500, land: 640, length: 3000, descent: 6, side: 'left', width: W, ...ramp(1), name: 's2 final' });
    const exit = rampPoint(R5, 'left', 3000, 0.42);
    const pc = v3(exit.x + 900, exit.y, exit.z - 200);
    portal(c, pc, 1, dests[2]);
    stageRamps.push([
      { ramp: R1, face: 'left' },
      { ramp: R2, face: 'left' },
      { ramp: R3, face: 'left' },
      { ramp: R4, face: 'left', landAt: R4land },
      { ramp: R5, face: 'left' },
    ]);
    sections.push({ name: 'Stage 2', dest: dests[1], ramps: stageRamps[1], marker: 2, exit: pc });
    allRamps.push(R1, R2, R3, R4, R5);
  }

  // ================================================================ stage 3: the U-turn curve
  {
    const c = rooms[2].ctx;
    const d = c.door;
    const ch = new RampChain(b, v3(d.x - 112, d.y - W * 0.45, d.z - 96), 0);
    const R1 = ch.straight({ gap: 0, drop: 0, length: 3600, descent: 7, dropIn: { angle: 22, length: 960, steps: 8 }, side: 'left', width: W, ...ramp(2), name: 's3 drop-in' });
    const R2 = ch.straight({ gap: 448, speed: 1150, land: 520, length: 2400, descent: 6, side: 'left', width: W, ...ramp(2), name: 's3 ramp 2' });
    const R3 = ch.curve({ gap: 576, speed: 1350, land: 560, radius: 2400, angle: 180, segments: 36, descent: 5, side: 'left', width: W, ...ramp(2), name: 's3 u-turn' });
    const R4 = ch.straight({ gap: 576, speed: 1500, land: 600, length: 3000, descent: 6, side: 'left', width: W, ...ramp(2), name: 's3 final' });
    const exit = rampPoint(R4, 'left', 3000, 0.42);
    // the U-turn sends the run back along -x
    const pc = v3(exit.x - 900, exit.y, exit.z - 200);
    portal(c, pc, -1, dests[3]);
    stageRamps.push([
      { ramp: R1, face: 'left' },
      { ramp: R2, face: 'left' },
      { ramp: R3, face: 'left' },
      { ramp: R4, face: 'left' },
    ]);
    sections.push({ name: 'Stage 3', dest: dests[2], ramps: stageRamps[2], marker: 3, exit: pc });
    allRamps.push(R1, R2, R3, R4);
  }

  // ================================================================ stage 4: booster finale
  let endMin = v3();
  let endMax = v3();
  let finish = v3();
  {
    const c = rooms[3].ctx;
    const d = c.door;
    const ch = new RampChain(b, v3(d.x - 112, d.y - W * 0.45, d.z - 96), 0);
    const R1 = ch.straight({ gap: 0, drop: 0, length: 3600, descent: 7, dropIn: { angle: 22, length: 960, steps: 8 }, side: 'left', width: W, ...ramp(3), name: 's4 drop-in' });
    const R2 = ch.straight({ gap: 512, shift: 800, travel: 500, speed: 1150, land: 560, length: 3200, descent: 6, side: 'right', width: W, ...ramp(3), name: 's4 zig' });
    const R3 = ch.straight({ gap: 576, shift: -800, travel: 500, speed: 1350, land: 600, length: 2800, descent: 6, side: 'left', width: W, ...ramp(3), name: 's4 zag' });
    // booster at the end of R3: a tall column of strong upward push that you fly through as you leave the
    // ramp, launching you high over a long gap onto R4
    const e3 = rampPoint(R3, 'left', 2800, 0.42);
    const r3end = rampPoint(R3, 'left', 2800, 0);
    const boost: PushVolume = {
      mins: v3(r3end.x - 96, r3end.y - 64, r3end.z - R3.height - 64),
      maxs: v3(r3end.x + 352, r3end.y + W + 96, r3end.z + 1400),
      push: pushVector(-75, 0, 3600),
    };
    b.addPush(boost.mins, boost.maxs, qa(-75, 0, 0), 3600);
    boosterFrame(b, boost.mins, boost.maxs, 'builtin/glow_yellow');
    // R4 is long and placed for the weakest launch (fast, low, falling exit: least time in the column), which
    // lands 400 units in; stronger launches simply land further down R4
    const fl = predictFlight(v3(e3.x - 100, e3.y, e3.z - 60), v3(1700, 0, -300), { pushes: [boost], untilZ: e3.z - 300 });
    const R4land = 400;
    ch.moveTo(v3(fl.pos.x - R4land, fl.pos.y - W * 0.42, fl.pos.z + R4land * Math.tan((6 * Math.PI) / 180) + 0.42 * rampHeight(W)), 0, 6);
    const R4 = ch.straight({ gap: 0, drop: 0, length: 5600, descent: 6, side: 'left', width: W, ...ramp(3), name: 's4 boosted landing' });
    const R5 = ch.straight({ gap: 704, speed: 1500, land: 640, length: 3200, descent: 6, side: 'left', width: W, ...ramp(3), name: 's4 final' });
    const ex = rampPoint(R5, 'left', 3200, 0.42);
    const top = ex.z - 800;
    endMin = v3(ex.x + 640, ex.y - 640, top - 64);
    endMax = v3(ex.x + 640 + 1536, ex.y + 640, top);
    b.addBox(endMin, endMax, { top: 'builtin/floor_dark', sides: SIDE, bottom: SIDE });
    b.addTopTrim(endMin, endMax, c.glow, 16);
    addBackstop(b, endMin, endMax, v3(1, 0, 0), 'builtin/grid_dark');
    b.addZone('end', v3(endMin.x, endMin.y, top), v3(endMax.x, endMax.y, top + 1024));
    finish = v3((endMin.x + endMax.x) / 2, ex.y, top);
    stageRamps.push([
      { ramp: R1, face: 'left' },
      { ramp: R2, face: 'right' },
      { ramp: R3, face: 'left' },
      { ramp: R4, face: 'left', landAt: 1600 },
      { ramp: R5, face: 'left' },
    ]);
    sections.push({ name: 'Stage 4', dest: dests[3], ramps: stageRamps[3], marker: 4 });
    allRamps.push(R1, R2, R3, R4, R5);
  }

  // ================================================================ bonus 1 (red): zig-zag, booster, banked curve
  // Beside stage 3 (same band of the map), reached from the stage 1 room's back alcove or with !b 1.
  const bonusRamps: CourseRamp[] = [];
  let bEndMin = v3();
  let bEndMax = v3();
  let bFinish = v3();
  const bDoor = v3(-2400, -1400, 5200);
  const bRoomCtx: StageCtx = { b, index: 4, glow: BONUS_GLOW, door: bDoor };
  const bRoom = stageRoom(bRoomCtx);
  b.addDestination('neon_b1', bRoom.spawn, 0);
  b.addZone('start', bRoom.mins, bRoom.maxs, { group: 1, spawn: { origin: bRoom.spawn, yaw: 0 } });
  const bRoomBox = { mins: v3(bRoom.mins.x - 32, bRoom.mins.y - 32, bDoor.z - 16), maxs: v3(bDoor.x + 16, bRoom.maxs.y + 32, bDoor.z + 304) };
  {
    const st = { mat: RAMP, sideMat: SIDE, trimMat: BONUS_GLOW };
    const ch = new RampChain(b, v3(bDoor.x - 112, bDoor.y - W * 0.45, bDoor.z - 96), 0);
    const R1 = ch.straight({ gap: 0, drop: 0, length: 3000, descent: 7, dropIn: { angle: 22, length: 960, steps: 8 }, side: 'left', width: W, ...st, name: 'b1 drop-in' });
    const R2 = ch.straight({ gap: 512, shift: 800, travel: 500, speed: 900, land: 560, length: 2600, descent: 6, side: 'right', width: W, ...st, name: 'b1 zig' });
    const R3 = ch.straight({ gap: 576, shift: -800, travel: 500, speed: 1100, land: 560, length: 2400, descent: -5, side: 'left', width: W, ...st, name: 'b1 up-ramp' });
    const ridgeEnd = rampPoint(R3, 'left', 2400, 0);
    const exit3 = rampPoint(R3, 'left', 2400, 0.42);
    const boost: PushVolume = {
      mins: v3(ridgeEnd.x - 320, ridgeEnd.y - 64, ridgeEnd.z - R3.height),
      maxs: v3(ridgeEnd.x + 160, ridgeEnd.y + W + 64, ridgeEnd.z + 1600),
      push: pushVector(-78, 0, 2600),
    };
    b.addPush(boost.mins, boost.maxs, qa(-78, 0, 0), 2600);
    boosterFrame(b, boost.mins, boost.maxs, 'builtin/glow_yellow');
    const fl = predictFlight(v3(exit3.x - 200, exit3.y, exit3.z + 20), v3(950, 0, 90), { pushes: [boost], untilZ: exit3.z - 420 });
    const R4w = 384;
    const R4land = 920;
    ch.moveTo(v3(fl.pos.x - R4land, fl.pos.y - R4w * 0.42, fl.pos.z + R4land * Math.tan((7 * Math.PI) / 180) + 0.42 * rampHeight(R4w)), 0, 7);
    const R4 = ch.straight({ gap: 0, drop: 0, length: 2800, descent: 7, side: 'left', width: R4w, ...st, name: 'b1 landing' });
    const R5 = ch.curve({ gap: 576, speed: 1550, land: 500, radius: 2400, angle: 90, segments: 18, descent: 4, nz: 0.56, side: 'left', width: W, ...st, name: 'b1 banked curve' });
    const ex = rampPoint(R5, 'left', rampLength(R5), 0.42);
    const fwd = dirOf(ch.yaw);
    const top = ex.z - 800;
    const c = v3(ex.x + fwd.x * 1500, ex.y + fwd.y * 1500, top);
    bEndMin = v3(c.x - 768, c.y - 768, top - 64);
    bEndMax = v3(c.x + 768, c.y + 768, top);
    b.addBox(bEndMin, bEndMax, { top: 'builtin/floor_dark', sides: SIDE, bottom: SIDE });
    b.addTopTrim(bEndMin, bEndMax, BONUS_GLOW, 16);
    addBackstop(b, bEndMin, bEndMax, fwd, 'builtin/grid_dark');
    b.addZone('end', v3(bEndMin.x, bEndMin.y, top), v3(bEndMax.x, bEndMax.y, top + 1024), { group: 1 });
    bFinish = c;
    bonusRamps.push(
      { ramp: R1, face: 'left' },
      { ramp: R2, face: 'right' },
      { ramp: R3, face: 'left' },
      { ramp: R4, face: 'left', landAt: R4land },
      { ramp: R5, face: 'left' },
    );
  }

  // ================================================================ void + neon grid floor
  const lowest = Math.min(...[...allRamps, ...bonusRamps.map((r) => r.ramp)].map((r) => Math.min(...r.ribs.flat().map((p) => p.z))), endMin.z, bEndMin.z);
  const floorZ = lowest - 1600;
  const bands: [number, number][] = [
    [-16000, -9000],
    [-9000, -3000],
    [-3000, 7000],
    [7000, 16000],
  ];
  sections.forEach((s, i) => {
    // the bonus shares stage 3's band: each cell falls back to whichever course is nearer
    const bonusHere = i === 2;
    const bonusBoxes = [bRoomBox, { mins: bEndMin, maxs: bEndMax }];
    addVoidGrid(b, {
      cell: 768,
      x0: -16000,
      x1: 16000,
      y0: bands[i][0],
      y1: bands[i][1],
      floorZ: floorZ - 512,
      owners: [
        { dest: s.dest, pieces: s.ramps.map((r) => ({ ramp: r.ramp })), boxes: [rooms[i].box] },
        ...(bonusHere ? [{ dest: 'neon_b1', pieces: bonusRamps.map((r) => ({ ramp: r.ramp })), boxes: bonusBoxes }] : []),
      ],
      ramps: [...s.ramps.map((r) => r.ramp), ...(bonusHere ? bonusRamps.map((r) => r.ramp) : [])],
      boxes: [rooms[i].box, ...(i === 3 ? [{ mins: endMin, maxs: endMax }] : []), ...(bonusHere ? bonusBoxes : [])],
    });
  });
  // the floor: black with a glowing grid
  b.addBox(v3(-16000, -16000, floorZ - 64), v3(16000, 16000, floorZ), { top: 'builtin/floor_black', sides: null, bottom: null });
  for (let k = -16000; k <= 16000; k += 2048) {
    b.addDecal([v3(k - 6, -16000, floorZ), v3(k + 6, -16000, floorZ), v3(k + 6, 16000, floorZ), v3(k - 6, 16000, floorZ)], v3(0, 0, 1), 'builtin/glow_purple', 1);
    b.addDecal([v3(-16000, k - 6, floorZ), v3(16000, k - 6, floorZ), v3(16000, k + 6, floorZ), v3(-16000, k + 6, floorZ)], v3(0, 0, 1), 'builtin/glow_purple', 1.5);
  }

  const course: Course = { id: 'surf_neon', type: 'staged', group: 0, sections, finish };
  const bonus: Course = { id: 'surf_neon bonus 1', type: 'linear', group: 1, sections: [{ name: 'Bonus 1', dest: 'neon_b1', ramps: bonusRamps, marker: 0 }], finish: bFinish };
  return { map: b.build(), course, bonuses: [bonus], builder: b };
}

function rampHeight(w: number): number {
  return rampHeightFor(w);
}

/** Glowing outline of a booster volume (render only): the four vertical edges and the top and bottom rims. */
function boosterFrame(b: MapBuilder, mins: Vec3, maxs: Vec3, mat: string): void {
  const xs = [mins.x, maxs.x];
  const ys = [mins.y, maxs.y];
  for (const x of xs) for (const y of ys) addGlowBar(b, v3(x, y, mins.z), v3(x, y, maxs.z), 10, mat);
  for (const z of [mins.z, maxs.z]) {
    addGlowBar(b, v3(mins.x, mins.y, z), v3(maxs.x, mins.y, z), 10, mat);
    addGlowBar(b, v3(mins.x, maxs.y, z), v3(maxs.x, maxs.y, z), 10, mat);
    addGlowBar(b, v3(mins.x, mins.y, z), v3(mins.x, maxs.y, z), 10, mat);
    addGlowBar(b, v3(maxs.x, mins.y, z), v3(maxs.x, maxs.y, z), 10, mat);
  }
}
