// Ramp seams: the next brush along a surf ramp must not stop a hull sliding across unless its face really sticks
// out above the hull.
//
// User report: "I keep on getting stuck at the end of a ramp in utopia" - surf_utopia_njv, the ramp into the box with
// the cyan/orange diamond. The ramp brush ends at x = -6112 against a 32-unit end cap whose sloped face lies 0.0161
// units proud of the ramp's plane on the right (y > 0) side and 0.0161 recessed on the left. A surfer hovers
// DIST_EPSILON (1/32) above the ramp, so 0.015 above the cap: the hull never touches the cap. The box trace used
// Quake 3's "missed" test (a move that ends within DIST_EPSILON of a face counts as touching the brush), which grows
// every brush by DIST_EPSILON: the cap's vertical end face then stopped the player dead at x = -6096 in a third of
// the runs. Source's CM_ClipBoxToBrush skips a brush whenever the box is in front of one of its planes at both ends
// of the move (d1 > 0 && d2 > 0), and every KSF world-record replay slides across this seam at 3440 u/s.
// Second half of the same story: a move that starts inside the epsilon shells of a brush's top face and of its end
// face or edge bevel and crosses both. Source clamps both enter fractions to 0, so the reported face (and, against the
// ramp the hull rides, the reported brush) comes down to side and BSP order; taking the larger unclamped fraction
// picked the end face / bevel and stopped the player. The face the hull really crosses last - the top - is reported.
//
// The brushes below are copied plane by plane (bevels included) from the BSP (collision world indices 2598-2605,
// 2626-2627, 1160 / 2617 / 2620; centre walls 1161 / 1165). The real-map + replay version of these checks is
// ramp_seams_maps.test.ts.
import { describe, expect, it } from 'vitest';
import { Vec3, v3 } from '../src/core/vec3';
import { brushFromBox, computeBrushBounds } from '../src/physics/brushbuild';
import { CollisionWorld } from '../src/physics/collision';
import { defaultMoveVars, playerMove } from '../src/physics/movement';
import { HULL_MAXS, HULL_MINS, IN_MOVELEFT, createPlayerState, newMoveEvents, newUserCmd } from '../src/physics/playertypes';
import { Brush, CONTENTS_SOLID, DIST_EPSILON, MASK_PLAYERSOLID, TraceWorld, newTrace } from '../src/physics/types';
import { SeamRunParams, surfRun } from './helpers/ramp_diff';
import { mulberry32 } from './helpers/collision_ref';
import { RefWorld } from './helpers/movement_world';

const MINS = v3(HULL_MINS.x, HULL_MINS.y, HULL_MINS.z);
const MAXS = v3(HULL_MAXS.x, HULL_MAXS.y, HULL_MAXS.z);
const DETAIL_SOLID = 0x8000001; // CONTENTS_SOLID | CONTENTS_DETAIL, as the BSP has them

type Side = [nx: number, ny: number, nz: number, dist: number, bevel: 0 | 1];
function brushOf(sides: Side[], contents = DETAIL_SOLID): Brush {
  const b: Brush = {
    sides: sides.map(([x, y, z, dist, bevel]) => ({ plane: { normal: v3(x, y, z), dist }, bevel: bevel === 1 })),
    contents,
    mins: v3(),
    maxs: v3(),
    model: 0,
  };
  if (!computeBrushBounds(b)) throw new Error('degenerate brush');
  return b;
}

// ---- surf_utopia_njv, the ramps into the diamond box (x -6144..-4142, both sides of the centre wall)
const RIGHT_RAMP = brushOf([
  [-1, 0, 0, 6112, 0],
  [1, 0, 0, -4142.2998046875, 0],
  [0, -1, 0, -32.01903533935547, 0],
  [0, 1, 0, 518.4212036132812, 1],
  [0, 0, -1, -2079.909912109375, 0],
  [0, 0, 1, 2655.909912109375, 0],
  [0, 0.7808676362037659, 0.6246965527534485, 1704.1307373046875, 0],
]);
const RIGHT_BOTTOM = brushOf([
  [-1, 0, 0, 6112, 0],
  [1, 0, 0, -4142.2998046875, 0],
  [0, -1, 0, -32.01903533935547, 0],
  [0, 1, 0, 544, 1],
  [0, 0, -1, -2047.9100341796875, 0],
  [0, 0, 1, 2079.909912109375, 0],
  [0, 0.781082272529602, 0.6244281530380249, 1703.681396484375, 0],
]);
/** The right end cap: its sloped face is 0.0161 PROUD of the ramp's plane. */
const RIGHT_CAP = brushOf([
  [-1, 0, 0, 6144, 0],
  [1, 0, 0, -6112, 0],
  [0, -1, 0, -32.040199279785156, 0],
  [0, 1, 0, 544.043701171875, 1],
  [0, 0, -1, -2047.9100341796875, 0],
  [0, 0, 1, 2687.910400390625, 1],
  [0, 0.7808676958084106, 0.6246964335441589, 1704.1468505859375, 0],
]);
/** The ramp's top 25 units along the centre wall (the cap is 0.051 proud of this one: a real step). */
const RIGHT_TOP = brushOf([
  [-1, 0, 0, 6112, 0],
  [1, 0, 0, -4142.2998046875, 0],
  [0, -1, 0, -32.01903533935547, 0],
  [0, 1, 0, 57.61960220336914, 1],
  [0, 0, -1, -2655.909912109375, 0],
  [0, 0, 1, 2687.910400390625, 1],
  [3.932028747044569e-8, 0.7808783650398254, 0.6246830821037292, 1704.095703125, 0],
]);
const LEFT_RAMP = brushOf([
  [-1, 0, 0, 6112, 0],
  [1, 0, 0, -4142.2998046875, 0],
  [0, -1, 0, 518.4202880859375, 1],
  [0, 1, 0, -32.019500732421875, 0],
  [0, 0, -1, -2079.909912109375, 0],
  [0, 0, 1, 2655.909912109375, 0],
  [0, -0.7808690667152405, 0.6246947050094604, 1704.1260986328125, 0],
]);
const LEFT_BOTTOM = brushOf([
  [-1, 0, 0, 6112, 0],
  [1, 0, 0, -4142.2998046875, 0],
  [0, -1, 0, 544, 1],
  [0, 1, 0, -32.019500732421875, 0],
  [0, 0, -1, -2047.9100341796875, 0],
  [0, 0, 1, 2079.909912109375, 0],
  [0, -0.7810699343681335, 0.6244435906410217, 1703.706298828125, 0],
]);
/** The left end cap: its sloped face is 0.0161 RECESSED from the ramp's plane. */
const LEFT_CAP = brushOf([
  [-1, 0, 0, 6144, 0],
  [1, 0, 0, -6112, 0],
  [0, -1, 0, 544, 1],
  [0, 1, 0, -32, 0],
  [0, 0, -1, -2047.9100341796875, 0],
  [0, 0, 1, 2687.910400390625, 1],
  [0, -0.7808690071105957, 0.62469482421875, 1704.1099853515625, 0],
]);
const LEFT_TOP = brushOf([
  [-1, 0, 0, 6112, 0],
  [1, 0, 0, -4142.2998046875, 0],
  [0, -1, 0, 57.6225700378418, 1],
  [0, 1, 0, -32.019500732421875, 0],
  [0, 0, -1, -2655.909912109375, 0],
  [0, 0, 1, 2687.910400390625, 1],
  [0, -0.7808462381362915, 0.6247232556343079, 1704.2021484375, 0],
]);
const CENTRE_WALL = brushFromBox(v3(-6080, -32, 1024), v3(-448, 32, 3328), CONTENTS_SOLID);
const CENTRE_WALL_END = brushFromBox(v3(-6144, -32, 1024), v3(-6080, 32, 5120), CONTENTS_SOLID);
const BOX_RAMPS = [RIGHT_RAMP, RIGHT_BOTTOM, RIGHT_CAP, RIGHT_TOP, LEFT_RAMP, LEFT_BOTTOM, LEFT_CAP, LEFT_TOP, CENTRE_WALL, CENTRE_WALL_END];

// ---- surf_utopia_njv, ramp at x -2158..-1646 (surfed towards -y): the end cap's sloped face has the ramp's plane
const Y_RAMP = brushOf([
  [-1, 0, 0, 2158.080078125, 0],
  [1, 0, 0, -1646.0792236328125, 1],
  [0, -1, 0, -12593.900390625, 0],
  [0, 1, 0, 13073.900390625, 0],
  [0, 0, -1, -3968, 0],
  [0, 0, 1, 4000, 0],
  [0.7808687090873718, 0, 0.6246951222419739, 1193.41796875, 0],
]);
const Y_CAP = brushOf([
  [-1, 0, 0, 2158.080078125, 0],
  [1, 0, 0, -1646.0792236328125, 1],
  [0, -1, 0, -12561.900390625, 0],
  [0, 1, 0, 12593.900390625, 0],
  [0, 0, -1, -3968, 0],
  [0, 0, 1, 4608, 1],
  [0.7808687090873718, 0, 0.6246951222419739, 1193.41796875, 0],
]);

// ---- surf_utopia_njv, the Λ ramp inside the box near its exit (surfed towards -x): a player-clip shell (1160) over
// the concrete segments 2617 / 2620. 2620's top rises out of the clip's surface at a shallow angle (0.0155 above it
// where the hull meets 2620's start edge), and that edge has an axial bevel.
const BOX_CLIP = brushOf(
  [
    [-1, 0, 0, 13796.9013671875, 1],
    [1, 0, 0, -13136.697265625, 1],
    [0, -1, 0, 512, 1],
    [0, 1, 0, 512, 1],
    [0, 0, -1, -1797.52783203125, 1],
    [0, 0, 1, 2548.23193359375, 1],
    [-0.9659036993980408, 0, 0.2589017152786255, 13826.169921875, 0],
    [0.9659439921379089, 0, -0.25875115394592285, -13314.3896484375, 0],
    [0.16167476773262024, -0.7808667421340942, 0.603413999080658, -666.1876831054688, 0],
    [0.16167224943637848, 0.780874490737915, 0.6034045815467834, -666.1671142578125, 0],
    [-0.2588048279285431, 0, -0.9659296274185181, 1706.411865234375, 0],
    [0, -0.7701447606086731, 0.6378689408302307, 1625.4327392578125, 1],
    [0, 0.770152747631073, 0.6378593444824219, 1625.4188232421875, 1],
    [0.9514699578285217, -0.3077409863471985, 0, -12499.1748046875, 1],
    [0.9514676928520203, 0.30774810910224915, 0, -12499.140625, 1],
    [0.2588047981262207, 0, 0.9659295082092285, -1066.4097900390625, 1],
  ],
  0x8010000, // CONTENTS_PLAYERCLIP | CONTENTS_DETAIL
);
const BOX_SEG = brushOf([
  [-1, 0, 0, 13757.7021484375, 1],
  [1, 0, 0, -13144.8994140625, 1],
  [0, -1, 0, 486.3998107910156, 1],
  [0, 1, 0, 486.38970947265625, 1],
  [0, 0, -1, -1828.4395751953125, 1],
  [0, 0, 1, 2509.050537109375, 1],
  [0.16166087985038757, -0.7808700799942017, 0.6034133434295654, -666, 0],
  [0.16165940463542938, 0.7808746695518494, 0.6034078001976013, -665.98779296875, 0],
  [-0.9659163951873779, 0, 0.2588541805744171, 13794.248046875, 0],
  [0.9659180045127869, 0, -0.2588482201099396, -13314.2021484375, 0],
  [0.25878435373306274, 0, 0.9659351110458374, -1098.1131591796875, 0],
  [-0.25880351662635803, 0, -0.9659299850463867, 1674.3890380859375, 0],
  [0, -0.7701523900032043, 0.6378597617149353, 1620.130615234375, 1],
  [0.951435387134552, -0.3078480064868927, 0, -12498.6455078125, 1],
  [0, -1, 0, 486.61407470703125, 1],
  [0.9514340162277222, 0.3078521490097046, 0, -12498.6240234375, 1],
  [0, 0.7701570391654968, 0.6378541588783264, 1620.1234130859375, 1],
  [0, 1, 0, 486.6199035644531, 1],
]);
const BOX_END = brushOf([
  [-1, 0, 0, 13796.9013671875, 1],
  [1, 0, 0, -13600.2919921875, 1],
  [0, -1, 0, 512, 1],
  [0, 1, 0, 512, 1],
  [0, 0, -1, -1921.768798828125, 1],
  [0, 0, 1, 2548.23193359375, 1],
  [-0.9659036993980408, 0, 0.2589017152786255, 13826.169921875, 0],
  [0.16120165586471558, -0.7808744311332703, 0.6035305857658386, -659.4312133789062, 0],
  [0.16120165586471558, 0.7808744311332703, 0.6035305857658386, -659.4312744140625, 0],
  [0.9659425616264343, 0, -0.25875648856163025, -13794.33984375, 0],
  [-0.25805142521858215, 0, -0.9661311507225037, 1695.6282958984375, 0],
  [0, -0.770152747631073, 0.6378592848777771, 1625.418212890625, 1],
  [0, 0.770152747631073, 0.6378593444824219, 1625.4188232421875, 1],
  [0.2580549418926239, 0, 0.9661301374435425, -1055.6680908203125, 1],
  [0.9514662027359009, -0.30775266885757446, 0, -12940.220703125, 1],
  [0.9514662027359009, 0.3077526390552521, 0, -12940.220703125, 1],
  [-0.2580488324165344, 0, -0.9661317467689514, 1695.591064453125, 1],
]);

const RIGHT_N: [number, number, number] = [0, 0.7808676362037659, 0.6246965527534485];
const RIGHT_D = 1704.1307373046875;
const LEFT_N: [number, number, number] = [0, -0.7808690667152405, 0.6246947050094604];
const LEFT_D = 1704.1260986328125;

/** Height of the hull's support corner (the one nearest the plane) above a plane. */
function hover(o: Vec3, n: Readonly<Vec3> | [number, number, number], d: number): number {
  const [nx, ny, nz] = Array.isArray(n) ? n : [n.x, n.y, n.z];
  const cx = o.x + (nx > 0 ? MINS.x : MAXS.x);
  const cy = o.y + (ny > 0 ? MINS.y : MAXS.y);
  const cz = o.z + (nz > 0 ? MINS.z : MAXS.z);
  return nx * cx + ny * cy + nz * cz - d;
}

/** Both tracers over the same brushes (the CollisionWorld's own copies: bevels it adds are shared). */
function worlds(brushes: Brush[]): { cw: CollisionWorld; ref: RefWorld } {
  const cw = new CollisionWorld(brushes);
  return { cw, ref: new RefWorld([...cw.brushes]) };
}

/** Surfs the box ramp towards -x from lateral contact coordinate y (on side n/d) and reports the first stop. */
function boxRampRun(
  w: TraceWorld,
  side: { n: [number, number, number]; d: number },
  y: number,
  speed: number,
  yaw: number,
  key: SeamRunParams['key'],
  start: { h: number; vn: number; slide?: boolean },
  dt: number,
) {
  const lead = Math.min(1800, speed * 0.25);
  const x = -6144 + lead;
  const z = (side.d - side.n[1] * y) / side.n[2];
  const p: SeamRunParams = {
    n: side.n,
    d: side.d,
    corner: [x, y, z],
    dir: [-1, 0],
    speed,
    yaw,
    h: start.h,
    vn: start.vn,
    slide: start.slide,
    key,
    dt,
    ticks: Math.ceil((lead + 150) / (speed * 0.5) / dt),
  };
  return surfRun(w, p);
}

describe('ramp seams: a brush is only touched when the hull really reaches it (Source CM_ClipBoxToBrush)', () => {
  it('a move ending inside the epsilon shell of a face that sticks out less than the hover passes the next brush', () => {
    // floor A (top z = 0) and the next brush B (top z = 0.016, i.e. less than DIST_EPSILON proud)
    const a = brushFromBox(v3(0, -500, -100), v3(1000, 500, 0), CONTENTS_SOLID);
    const b = brushFromBox(v3(1000, -500, -100), v3(1032, 500, 0.016), CONTENTS_SOLID);
    const { cw, ref } = worlds([a, b]);
    for (const w of [cw, ref]) {
      // hovering DIST_EPSILON above A = 0.0152 above B, moving towards B's top by a hair (float noise): passes B
      const s = v3(950, 0, DIST_EPSILON);
      const tr = w.traceBox(s, v3(1100, 0, DIST_EPSILON - 1e-6), MINS, MAXS, MASK_PLAYERSOLID, newTrace());
      expect(tr.fraction).toBe(1);
      expect(tr.startsolid).toBe(false);
      // gravity's share of a tick (0.05 units down) reaches A's plane: stopped at once on A, not on B
      const t2 = w.traceBox(s, v3(1100, 0, DIST_EPSILON - 0.05), MINS, MAXS, MASK_PLAYERSOLID, newTrace());
      expect(t2.fraction).toBe(0);
      expect(t2.plane.normal).toEqual(v3(0, 0, 1));
      expect(t2.plane.dist).toBe(0);
      // a hull that really is lower than B's top (hovering 0.005 above A) runs into B's end face
      const low = v3(950, 0, 0.005);
      const t3 = w.traceBox(low, v3(1100, 0, 0.005), MINS, MAXS, MASK_PLAYERSOLID, newTrace());
      expect(t3.fraction).toBeCloseTo((1000 - 16 - DIST_EPSILON - 950) / 150, 12);
      expect(t3.plane.normal).toEqual(v3(-1, 0, 0));
    }
    // the same with a recessed next brush and a hull inside A's epsilon shell
    const c = brushFromBox(v3(1000, -500, -100), v3(1032, 500, -0.016), CONTENTS_SOLID);
    const w2 = worlds([a, c]);
    for (const w of [w2.cw, w2.ref]) {
      for (const h of [0.001, 0.01, 0.02, DIST_EPSILON]) {
        const tr = w.traceBox(v3(950, 0, h), v3(1100, 0, h - 1e-6), MINS, MAXS, MASK_PLAYERSOLID, newTrace());
        expect(tr.fraction).toBe(1);
      }
    }
  });

  it('the same for triangle meshes (displacements): a triangle 0.016 proud of the one the hull slides on is passed', () => {
    const pos = new Float64Array([0, -500, 0, 1000, -500, 0, 1000, 500, 0, 0, 500, 0, 1000, -500, 0.016, 1100, -500, 0.016, 1100, 500, 0.016, 1000, 500, 0.016]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const w = new CollisionWorld([], { triangles: { positions: pos, indices: idx } });
    const s = v3(950, 0, DIST_EPSILON);
    const tr = w.traceBox(s, v3(1150, 0, DIST_EPSILON - 1e-6), MINS, MAXS, MASK_PLAYERSOLID);
    expect(tr.fraction).toBe(1);
    // a hull hovering lower than the second triangle meets its edge
    const t2 = w.traceBox(v3(950, 0, 0.005), v3(1150, 0, 0.005), MINS, MAXS, MASK_PLAYERSOLID);
    expect(t2.fraction).toBeLessThan(1);
    expect(t2.endpos.x).toBeLessThan(1000 - 16);
    // ending short of a triangle's face is no hit; reaching it is (pulled back to DIST_EPSILON)
    const t3 = w.traceBox(v3(500, 0, 10), v3(500, 0, 0.01), MINS, MAXS, MASK_PLAYERSOLID);
    expect(t3.fraction).toBe(1);
    const t4 = w.traceBox(v3(500, 0, 10), v3(500, 0, -1), MINS, MAXS, MASK_PLAYERSOLID);
    expect(t4.fraction).toBeLessThan(1);
    expect(t4.endpos.z).toBeCloseTo(DIST_EPSILON, 10);
    // rays too
    expect(w.traceRay(v3(500, 0, 10), v3(500, 0, 0.01), MASK_PLAYERSOLID).fraction).toBe(1);
    expect(w.traceRay(v3(500, 0, 10), v3(500, 0, -1), MASK_PLAYERSOLID).endpos.z).toBeCloseTo(DIST_EPSILON, 10);
  });

  it('utopia box ramp: one 66-tick move of the world-record line across the 0.016-proud end cap keeps its speed', () => {
    // our state one tick before the seam while following KSF 66t WR replay frames ~2031-2061 (holding +moveleft
    // into the ramp, jump held); the real run is at x = -6110.4 one tick later, still at 3440 u/s
    for (const w of Object.values(worlds(BOX_RAMPS))) {
      const ps = createPlayerState(v3(-6058.920980365514, 413.27084368165185, 2231.3970464177983));
      ps.velocity.x = -3450.4281304026103;
      ps.velocity.y = -274.15626312741233;
      ps.velocity.z = 336.69399417818784;
      const cmd = newUserCmd();
      cmd.buttons = 0x202; // IN_JUMP | IN_MOVELEFT
      cmd.sidemove = -450;
      cmd.viewangles.pitch = 10.252985;
      cmd.viewangles.yaw = -174.758514;
      expect(hover(ps.origin, RIGHT_N, RIGHT_D)).toBeCloseTo(DIST_EPSILON, 6);
      playerMove(ps, cmd, w, defaultMoveVars(), 0.015, newMoveEvents());
      expect(ps.origin.x).toBeLessThan(-6110);
      expect(ps.velocity.x).toBeLessThan(-3400);
    }
  });

  it('utopia y = 12594 ramp: a hull hovering 0.0307 above the ramp (CS:S float32 rounding) crosses the flush end cap', () => {
    // KSF 66t replay (rank 2) frames 1648 -> 1652 exactly as recorded: holding +moveright, 3462 u/s along -y
    const cmds: [number, number, number][] = [
      [1024, 17.340415954589844, -88.39026641845703],
      [1024, 17.633014678955078, -89.0370864868164],
      [512, 17.94101333618164, -89.17569732666016],
      [512, 18.27981185913086, -88.75988006591797],
    ];
    for (const w of Object.values(worlds([Y_RAMP, Y_CAP]))) {
      const ps = createPlayerState(v3(-1637.75048828125, 12658.11328125, 3977.637939453125));
      ps.velocity.x = 214.3513641357422;
      ps.velocity.y = -3462.269287109375;
      ps.velocity.z = -273.93914794921875;
      const h0 = hover(ps.origin, Y_RAMP.sides[6].plane.normal, Y_RAMP.sides[6].plane.dist);
      expect(h0).toBeGreaterThan(0);
      expect(h0).toBeLessThan(DIST_EPSILON);
      const cmd = newUserCmd();
      const vars = defaultMoveVars();
      const ev = newMoveEvents();
      for (const [buttons, pitch, yaw] of cmds) {
        cmd.buttons = buttons;
        cmd.sidemove = buttons === 1024 ? 450 : -450;
        cmd.viewangles.pitch = pitch;
        cmd.viewangles.yaw = yaw;
        playerMove(ps, cmd, w, vars, 0.015, ev);
        expect(Math.hypot(ps.velocity.x, ps.velocity.y)).toBeGreaterThan(3400);
      }
      expect(ps.origin.y).toBeLessThan(12593.9 + 16 - 100); // well past the seam
    }
  });

  it('utopia box ramp, both sides: sliding or landing on any line / speed / yaw / key crosses the end cap (100 and 66 tick)', () => {
    const { cw, ref } = worlds(BOX_RAMPS);
    const sides = [
      { name: 'right', n: RIGHT_N, d: RIGHT_D, ys: [70, 150, 230, 310, 390, 470] },
      { name: 'left', n: LEFT_N, d: LEFT_D, ys: [-70, -150, -230, -310, -390, -470] },
    ];
    const starts = [
      { h: DIST_EPSILON, vn: 0, slide: true },
      { h: 0.5, vn: -50 },
      { h: 2, vn: -150 },
    ];
    const stopped: string[] = [];
    const sourceStops: number[] = [];
    let runs = 0;
    for (const side of sides)
      for (const y of side.ys)
        for (const speed of [600, 1200, 1733, 2500, 3500])
          for (const yaw of [-4, 0, 4])
            for (const key of ['into', 'none', 'away', 'fwd'] as const)
              for (const start of starts)
                for (const dt of [0.01, 0.015]) {
                  runs++;
                  const out = boxRampRun(cw, side, y, speed, yaw, key, start, dt);
                  if (!out) continue;
                  // the Source reference tracer stops there as well: what CS:GO does (see the next test)
                  const r = boxRampRun(ref, side, y, speed, yaw, key, start, dt);
                  if (r && r.tick === out.tick && Math.abs(r.pos[0] - out.pos[0]) < 1e-6) {
                    sourceStops.push(out.pos[1] - 16);
                    continue;
                  }
                  stopped.push(`${side.name} y=${y} ${speed} u/s yaw ${yaw} ${key} h=${start.h} dt=${dt}: stopped at ${out.pos.map((c) => c.toFixed(3)).join(',')}`);
                }
    expect(runs).toBe(4320);
    expect(stopped.slice(0, 10), `${stopped.length} of ${runs} runs stopped`).toEqual([]);
    // Source's own stops: only lines that drift down onto the right ramp's bottom strip (corner y > 518.4)
    expect(sourceStops.length).toBeLessThan(runs * 0.005);
    for (const y of sourceStops) expect(y).toBeGreaterThan(518.42);
  });

  it('left side: a hull anywhere inside the epsilon shell of the ramp passes the recessed end cap', () => {
    // states Source produces too (a move that stops short of a face leaves the hull in its epsilon shell)
    const w = new CollisionWorld(BOX_RAMPS);
    const side = { n: LEFT_N, d: LEFT_D };
    const stopped: string[] = [];
    for (const h of [0.002, 0.005, 0.01, 0.02])
      for (const y of [-70, -230, -390, -470])
        for (const speed of [600, 1733, 3500])
          for (const key of ['into', 'none', 'fwd'] as const)
            for (const dt of [0.01, 0.015]) {
              const out = boxRampRun(w, side, y, speed, 0, key, { h, vn: 0, slide: true }, dt);
              if (out) stopped.push(`h=${h} y=${y} ${speed} ${key} dt=${dt}`);
            }
    expect(stopped).toEqual([]);
  });

  it('a hull that is really lower than the cap is stopped by it - in Source too (not a seam bug)', () => {
    const { cw, ref } = worlds(BOX_RAMPS);
    // hovering 0.005 above the right ramp = 0.011 below the cap's face (a soft landing can leave the hull there)
    for (const w of [cw, ref]) {
      const out = boxRampRun(w, { n: RIGHT_N, d: RIGHT_D }, 310, 1733, 0, 'none', { h: 0.005, vn: 0, slide: true }, 0.015);
      expect(out).not.toBeNull();
      expect(out!.pos[0]).toBeCloseTo(-6112 + 16 + DIST_EPSILON, 6);
    }
    // the ramp's bottom strip at its lower edge: there the cap's face is 0.033 above the strip's, more than the hover
    const bot = RIGHT_BOTTOM.sides[6].plane;
    const capFace = RIGHT_CAP.sides[6].plane;
    const y = 543.9;
    const o = v3(-6080, y + 16, (bot.dist - bot.normal.y * y) / bot.normal.z + DIST_EPSILON / bot.normal.z);
    expect(hover(o, bot.normal, bot.dist)).toBeCloseTo(DIST_EPSILON, 9);
    expect(hover(o, capFace.normal, capFace.dist)).toBeLessThan(0);
    for (const w of [cw, ref]) {
      const tr = w.traceBox(o, v3(o.x - 60, o.y, o.z), MINS, MAXS, MASK_PLAYERSOLID, newTrace());
      expect(tr.fraction).toBeLessThan(1);
      expect(tr.plane.normal).toEqual(v3(1, 0, 0));
      expect(tr.endpos.x).toBeCloseTo(-6112 + 16 + DIST_EPSILON, 9);
    }
    // Sliding down onto that strip: its plane dips below the ramp's, so the hull hovers 0.036 above the strip but
    // only 0.0149 above the cap's face, and a tick of gravity (0.11 units at 66 tick) carries it below the cap's face
    // plane. With the hull already inside the face's epsilon shell its pulled-back fraction is < 0 (Source: 0), so
    // the cap's end face, crossed at 0.008, is the hit - before the strip (0.04). CS:GO stops the same way here.
    const s = v3(-6095.658922, 538.426755, 2074.952769);
    const e = v3(-6133.036184, 542.53488, 2069.637633);
    expect(hover(s, capFace.normal, capFace.dist)).toBeGreaterThan(0);
    expect(hover(s, capFace.normal, capFace.dist)).toBeLessThan(DIST_EPSILON);
    expect(hover(e, capFace.normal, capFace.dist)).toBeLessThan(0);
    for (const w of [cw, ref]) {
      const tr = w.traceBox(s, e, MINS, MAXS, MASK_PLAYERSOLID, newTrace());
      expect(tr.fraction).toBeCloseTo(0.00829, 4);
      expect(tr.plane.normal).toEqual(v3(1, 0, 0));
    }
  });

  it('a move that starts inside the epsilon shells of a top face and of an edge bevel is stopped by the top face', () => {
    // The hull rides the box's clip brush and reaches the start edge of segment 2620, whose top is 0.0155 below the
    // hull (inside its epsilon shell) and whose edge bevel is 0.0157 away; this tick's move dips below the top's plane
    // (gravity) and crosses the bevel. Both pulled-back fractions are behind the start (Source: both 0); the box
    // really crosses the bevel's plane first (t 0.0015) and the top's last (t 0.12), so it lands on the top: the
    // velocity is clipped along the ramp. Taking the larger unclamped fraction picked the bevel: a dead stop.
    const s = v3(-13639.048311447179, 185.33055430939518, 2335.548083905655);
    const e = v3(-13650.641685006802, 186.24741448765968, 2337.251810390223);
    const top = BOX_END.sides[8].plane;
    const bevel = BOX_END.sides[15].plane;
    expect(hover(s, top.normal, top.dist)).toBeGreaterThan(0);
    expect(hover(s, top.normal, top.dist)).toBeLessThan(DIST_EPSILON);
    expect(hover(e, top.normal, top.dist)).toBeLessThan(0);
    for (const w of Object.values(worlds([BOX_END]))) {
      const tr = w.traceBox(s, e, MINS, MAXS, MASK_PLAYERSOLID, newTrace());
      expect(tr.fraction).toBe(0);
      expect(tr.plane.normal).toEqual(top.normal);
      expect(tr.plane.normal).not.toEqual(bevel.normal);
    }
  });

  it('a hull that stopped a move short of the cap\'s end face (inside its epsilon shell) still slides over the cap', () => {
    // The last move ended 2e-6 before the right cap's end face plane - no hit, it never reached it - hovering
    // DIST_EPSILON above the ramp (0.015 above the cap). This move (600 u/s at 100 tick: 6 units, plus 0.05 units of
    // gravity into the ramp) starts inside the epsilon shells of the ramp, the cap's top and the cap's end face and
    // enters all three. Source reports whichever comes first in its side and BSP order - the end face stops the
    // player dead. The cap's top is the face really crossed last (t 0.3 vs 0.0000003), so that is the contact.
    const y = 150;
    const z = (RIGHT_D - RIGHT_N[1] * y) / RIGHT_N[2];
    const s = v3(-6096 + 2e-6, y + 16 + RIGHT_N[1] * DIST_EPSILON, z + RIGHT_N[2] * DIST_EPSILON);
    const e = v3(s.x - 6, s.y, s.z - 0.05 / RIGHT_N[2]);
    const capTop = RIGHT_CAP.sides[6].plane;
    expect(hover(s, RIGHT_N, RIGHT_D)).toBeCloseTo(DIST_EPSILON, 7);
    expect(hover(s, capTop.normal, capTop.dist)).toBeGreaterThan(0.014);
    for (const w of Object.values(worlds(BOX_RAMPS))) {
      const tr = w.traceBox(s, e, MINS, MAXS, MASK_PLAYERSOLID, newTrace());
      expect(tr.fraction).toBe(0);
      expect(tr.plane.normal.x).toBe(0);
      expect(tr.plane.normal.z).toBeCloseTo(RIGHT_N[2], 4);
      // and the player keeps going
      const ps = createPlayerState(v3(s.x, s.y, s.z));
      ps.velocity.x = -600;
      ps.velocity.z = -4; // FinishGravity's half tick
      const cmd = newUserCmd();
      cmd.viewangles.pitch = 10;
      cmd.viewangles.yaw = 180;
      const ev = newMoveEvents();
      for (let t = 0; t < 10; t++) playerMove(ps, cmd, w, defaultMoveVars(), 0.01, ev);
      expect(ps.velocity.x).toBeLessThan(-590);
      expect(ps.origin.x).toBeLessThan(-6150);
    }
  });

  it('utopia box exit: surfing the clip brush onto the rising segment keeps the speed (100 tick)', () => {
    // our state while surfing the Λ ramp inside the box towards its exit, holding +moveleft into the ramp
    for (const w of Object.values(worlds([BOX_CLIP, BOX_SEG, BOX_END]))) {
      const ps = createPlayerState(v3(-13569.399012663083, 179.1960796854651, 2324.825420777047));
      ps.velocity.x = -1164.4131366778947;
      ps.velocity.y = 102.61874773263159;
      ps.velocity.z = 175.18479907285936;
      const cmd = newUserCmd();
      cmd.buttons = IN_MOVELEFT;
      cmd.sidemove = -450;
      cmd.viewangles.pitch = 10;
      cmd.viewangles.yaw = 174;
      const vars = defaultMoveVars();
      const ev = newMoveEvents();
      for (let t = 0; t < 15; t++) {
        playerMove(ps, cmd, w, vars, 0.01, ev);
        expect(Math.hypot(ps.velocity.x, ps.velocity.y), `tick ${t}`).toBeGreaterThan(1100);
      }
      expect(ps.origin.x).toBeLessThan(-13700);
    }
  });

  it('CollisionWorld traces match the Source reference tracer around the seams', () => {
    const rnd = mulberry32(2671);
    const { cw, ref } = worlds([...BOX_RAMPS, Y_RAMP, Y_CAP]);
    // single-brush reference tracers: when brushes tie on the fraction, either one's plane may be reported
    const single = cw.brushes.map((br) => new RefWorld([br]));
    const a = newTrace();
    const b = newTrace();
    const c = newTrace();
    let hits = 0;
    for (let i = 0; i < 20000; i++) {
      // a start on or near a ramp's surface close to its end cap, a short move in any direction (mostly along -x)
      const left = rnd() < 0.5;
      const n = left ? LEFT_N : RIGHT_N;
      const d = left ? LEFT_D : RIGHT_D;
      const y = (left ? -1 : 1) * (40 + rnd() * 500);
      const x = -6112 + 16 + (rnd() - 0.3) * 80;
      const h = [DIST_EPSILON, rnd() * 0.05, 0.0161 + (rnd() - 0.5) * 0.002, rnd() * 3][Math.floor(rnd() * 4)];
      const corner = v3(x - 16, y, (d - n[1] * y) / n[2]);
      const s = v3(corner.x + 16, corner.y - (n[1] > 0 ? -16 : 16) + n[1] * h, corner.z + n[2] * h);
      const len = rnd() * 60;
      const dir = v3(-1 + (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4);
      const dl = Math.hypot(dir.x, dir.y, dir.z);
      const e = v3(s.x + (dir.x / dl) * len, s.y + (dir.y / dl) * len, s.z + (dir.z / dl) * len);
      cw.traceBox(s, e, MINS, MAXS, MASK_PLAYERSOLID, a);
      ref.traceBox(s, e, MINS, MAXS, MASK_PLAYERSOLID, b);
      expect(a.startsolid, `trace ${i}`).toBe(b.startsolid);
      expect(a.allsolid, `trace ${i}`).toBe(b.allsolid);
      expect(Math.abs(a.fraction - b.fraction), `trace ${i}`).toBeLessThan(1e-9);
      if (a.fraction < 1 && !a.allsolid) {
        hits++;
        const firsts: unknown[] = [];
        for (const r of single) {
          r.traceBox(s, e, MINS, MAXS, MASK_PLAYERSOLID, c);
          if (!c.startsolid && c.fraction === b.fraction) firsts.push({ ...c.plane.normal });
        }
        expect(firsts, `trace ${i}`).toContainEqual({ ...a.plane.normal });
      }
    }
    expect(hits).toBeGreaterThan(2000);
  });
});
