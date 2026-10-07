// Movement tests: CS:GO surf-server movement behaviour, run against two collision worlds - the
// brute-force Source-semantics reference tracer in tests/helpers/movement_world.ts and the real BVH
// CollisionWorld (src/physics/collision.ts) - and at 64 / 100 / 128 tick where it matters.
import { describe, expect, it } from 'vitest';
import { qa } from '../src/core/angles';
import { Vec3, v3 } from '../src/core/vec3';
import { CollisionWorld } from '../src/physics/collision';
import * as movementModule from '../src/physics/movement';
import { categorizePosition, defaultMoveVars, playerHull, playerMove, unstuckPlayer } from '../src/physics/movement';
import {
  DUCK_HULL_MAXS,
  FL_DUCKING,
  FL_INWATER,
  FL_ONGROUND,
  FL_WATERJUMP,
  HULL_MAXS,
  HULL_MINS,
  IN_DUCK,
  IN_JUMP,
  IN_SPEED,
  MOVETYPE_LADDER,
  MOVETYPE_NOCLIP,
  MOVETYPE_WALK,
  MoveEvents,
  MoveVars,
  PlayerState,
  UserCmd,
  VIEW_OFFSET_DUCK,
  VIEW_OFFSET_STAND,
  createPlayerState,
  newMoveEvents,
  newUserCmd,
} from '../src/physics/playertypes';
import {
  Brush,
  CONTENTS_LADDER,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  DIST_EPSILON,
  MASK_PLAYERSOLID,
  TraceResult,
  TraceWorld,
} from '../src/physics/types';
import {
  RefWorld,
  boxBrush,
  floorBrush,
  mulberry32,
  prismXY,
  prismXZ,
  rotatedPrismXZ,
  stairs,
  surfRamp,
  waterBrush,
} from './helpers/movement_world';

// ------------------------------------------------------------------------------------------ harness

type TestWorld = TraceWorld & { testBox(origin: Vec3, mins: Vec3, maxs: Vec3, mask: number): boolean };

const WORLDS: { name: string; make: (b: Brush[]) => TestWorld }[] = [
  { name: 'ref', make: (b) => new RefWorld(b) },
  { name: 'collision', make: (b) => new CollisionWorld(b) },
];

const TICKS: { name: string; ft: number }[] = [
  { name: '64', ft: 1 / 64 },
  { name: '100', ft: 1 / 100 },
  { name: '128', ft: 1 / 128 },
];

const G = 800;
const J = 301.993377;

interface Input {
  fmove?: number;
  smove?: number;
  umove?: number;
  buttons?: number;
  yaw?: number;
  pitch?: number;
}

class Sim {
  ps: PlayerState;
  ev: MoveEvents = newMoveEvents();
  cmd: UserCmd = newUserCmd();
  vars: MoveVars = defaultMoveVars();
  t = 0;
  ticks = 0;
  constructor(
    public w: TestWorld,
    public ft: number,
    origin: Vec3,
    yaw = 0,
  ) {
    this.ps = createPlayerState(origin, qa(0, yaw, 0));
  }

  /** Drops the player straight down onto whatever is below (up to 512 units) and categorizes. */
  settle(): this {
    const h = playerHull(this.ps);
    const o = this.ps.origin;
    const tr = this.w.traceBox(o, v3(o.x, o.y, o.z - 512), h.mins, h.maxs, MASK_PLAYERSOLID);
    this.ps.origin = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
    categorizePosition(this.ps, this.w, this.vars);
    return this;
  }

  step(inp: Input = {}): MoveEvents {
    const c = this.cmd;
    c.forwardmove = inp.fmove ?? 0;
    c.sidemove = inp.smove ?? 0;
    c.upmove = inp.umove ?? 0;
    c.buttons = inp.buttons ?? 0;
    c.viewangles.yaw = inp.yaw ?? this.ps.viewAngles.yaw;
    c.viewangles.pitch = inp.pitch ?? this.ps.viewAngles.pitch;
    c.viewangles.roll = 0;
    playerMove(this.ps, c, this.w, this.vars, this.ft, this.ev);
    this.t += this.ft;
    this.ticks++;
    return this.ev;
  }

  /** Runs n ticks; `each` may return false to stop early. */
  run(n: number, input: (i: number) => Input = () => ({}), each?: (i: number, ev: MoveEvents) => boolean | void): void {
    for (let i = 0; i < n; i++) {
      const ev = this.step(input(i));
      if (each && each(i, ev) === false) break;
    }
  }

  get hspeed(): number {
    return Math.hypot(this.ps.velocity.x, this.ps.velocity.y);
  }
  get speed(): number {
    const v = this.ps.velocity;
    return Math.hypot(v.x, v.y, v.z);
  }
  inSolid(): boolean {
    const h = playerHull(this.ps);
    return this.w.testBox(this.ps.origin, h.mins, h.maxs, MASK_PLAYERSOLID);
  }
}

/** Expected discrete jump apex: vz during the first move is v0, then decreases by g*ft per tick. */
function discreteApex(v0: number, ft: number): number {
  let z = 0;
  let v = v0;
  let best = 0;
  for (let i = 0; i < 10000 && v > -1000; i++) {
    z += v * ft;
    best = Math.max(best, z);
    v -= G * ft;
  }
  return best;
}

/** A surf ramp's slanted face: unit normal and plane distance. */
function rampFace(x0: number, z0: number, normalZ: number): { n: Vec3; d: number } {
  const n = v3(-Math.sqrt(1 - normalZ * normalZ), 0, normalZ);
  return { n, d: n.x * x0 + n.z * z0 };
}

/** Distance of the player's hull from a plane, in the Source expanded-plane sense (0 = touching). */
function hullGap(o: Vec3, n: Vec3, d: number, ducked = false): number {
  const maxs = ducked ? DUCK_HULL_MAXS : HULL_MAXS;
  const mins = HULL_MINS;
  const ox = n.x < 0 ? maxs.x : mins.x;
  const oy = n.y < 0 ? maxs.y : mins.y;
  const oz = n.z < 0 ? maxs.z : mins.z;
  return o.x * n.x + o.y * n.y + o.z * n.z - (d - (ox * n.x + oy * n.y + oz * n.z));
}

/** Origin at horizontal (x, y) whose hull is `gap` away from the plane (n, d). */
function originAtGap(n: Vec3, d: number, x: number, y: number, gap: number): Vec3 {
  const ox = n.x < 0 ? HULL_MAXS.x : HULL_MINS.x;
  const oz = n.z < 0 ? HULL_MAXS.z : HULL_MINS.z;
  const expanded = d - (ox * n.x + oz * n.z);
  return v3(x, y, (expanded + gap - n.x * x - n.y * y) / n.z);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function yawOf(v: Vec3): number {
  return (Math.atan2(v.y, v.x) * 180) / Math.PI;
}

// ------------------------------------------------------------------------------------------ basics

describe('movement basics', () => {
  it('defaultMoveVars matches the SurfTimer CS:GO surf config', () => {
    const v = defaultMoveVars();
    expect(v.gravity).toBe(800);
    expect(v.accelerate).toBe(10);
    expect(v.airaccelerate).toBe(150);
    expect(v.friction).toBe(5.2);
    expect(v.stopspeed).toBe(80);
    expect(v.maxvelocity).toBe(3500);
    expect(v.airMaxWishspeed).toBe(30);
    expect(v.jumpImpulse).toBeCloseTo(301.993377, 6);
    expect(v.stepsize).toBe(18);
    expect(v.bounce).toBe(0);
    expect(v.autobhop).toBe(true);
    expect(v.enableBunnyhopping).toBe(true);
    expect(v.duckSpeedMultiplier).toBe(0.34);
    expect(v.walkSpeedMultiplier).toBe(0.52);
    expect(v.maxspeed).toBeGreaterThanOrEqual(250);
    // fresh object each call
    expect(defaultMoveVars()).not.toBe(v);
  });

  it('playerHull follows the duck state', () => {
    const ps = createPlayerState();
    expect(playerHull(ps).maxs.z).toBe(72);
    expect(playerHull(ps).mins.z).toBe(0);
    ps.ducked = true;
    expect(playerHull(ps).maxs.z).toBe(54);
    expect(playerHull(ps).maxs.x).toBe(16);
  });

  it('copies view angles from the command and resets events', () => {
    const w = new RefWorld([floorBrush(0)]);
    const s = new Sim(w, 0.01, v3(0, 0, 10)).settle();
    s.ev.jumped = true;
    s.ev.groundDistance = 99;
    s.step({ yaw: 33, pitch: -12 });
    expect(s.ps.viewAngles.yaw).toBe(33);
    expect(s.ps.viewAngles.pitch).toBe(-12);
    expect(s.ev.jumped).toBe(false);
    expect(s.ev.groundDistance).toBe(0);
  });

  it('laggedMovement scales the simulated time exactly', () => {
    const w = new RefWorld([floorBrush(0)]);
    const a = new Sim(w, 0.01, v3(0, 0, 500));
    a.ps.laggedMovement = 0.5;
    a.ps.velocity = v3(300, 100, 50);
    const b = new Sim(w, 0.005, v3(0, 0, 500));
    b.ps.velocity = v3(300, 100, 50);
    for (let i = 0; i < 80; i++) {
      a.step({ smove: 450, yaw: i });
      b.step({ smove: 450, yaw: i });
    }
    expect(a.ps.origin.x).toBeCloseTo(b.ps.origin.x, 9);
    expect(a.ps.origin.z).toBeCloseTo(b.ps.origin.z, 9);
    expect(a.ps.velocity.y).toBeCloseTo(b.ps.velocity.y, 9);
    // laggedMovement 0 freezes the player
    const c = new Sim(w, 0.01, v3(0, 0, 500));
    c.ps.laggedMovement = 0;
    c.ps.velocity = v3(300, 0, 0);
    c.run(10);
    expect(c.ps.origin).toEqual(v3(0, 0, 500));
  });
});

// ------------------------------------------------------------------------------------------ scenarios over both worlds

for (const W of WORLDS) {
  describe(`movement scenarios [${W.name} world]`, () => {
    // ---------------------------------------------------------------------------------- 1. jumping
    describe('1. jump', () => {
      for (const T of TICKS) {
        it(`apex, airtime and landing @${T.name} tick`, () => {
          const w = W.make([floorBrush(0)]);
          const s = new Sim(w, T.ft, v3(0, 0, 8)).settle();
          expect(s.ps.onGround).toBe(true);
          const z0 = s.ps.origin.z;
          let apex = 0;
          let jumps = 0;
          let lands = 0;
          let landT = -1;
          let landSpeed = 0;
          s.run(Math.ceil(1.5 / T.ft), (i) => ({ buttons: i === 0 ? IN_JUMP : 0 }), (i, ev) => {
            if (ev.jumped) jumps++;
            if (ev.landed) {
              lands++;
              if (landT < 0) {
                landT = s.t;
                landSpeed = ev.landSpeed;
              }
            }
            apex = Math.max(apex, s.ps.origin.z - z0);
          });
          expect(jumps).toBe(1);
          expect(lands).toBe(1);
          // Source: the standing jump adds the impulse to vz after StartGravity's half step, and the jump
          // tick gets an extra FinishGravity -> the first move uses J - g*ft.
          const expected = discreteApex(J - G * T.ft, T.ft);
          expect(apex).toBeCloseTo(expected, 6);
          expect(apex).toBeGreaterThan(54.5);
          expect(apex).toBeLessThan(57.01);
          expect(landT).toBeGreaterThan(0.72);
          expect(landT).toBeLessThan(0.76);
          expect(landSpeed).toBeGreaterThan(270);
          expect(landSpeed).toBeLessThan(302);
          expect(s.ps.onGround).toBe(true);
          expect(s.ps.velocity.z).toBe(0);
          // CategorizePosition grounds the player within 2 units without snapping it down (Source 2007+);
          // standing still, the player rests where the last fall step ended until StayOnGround runs.
          expect(s.ps.origin.z).toBeGreaterThanOrEqual(z0 - 1e-9);
          expect(s.ps.origin.z).toBeLessThan(z0 + 2);
          const rest = s.ps.origin.z;
          s.run(10);
          expect(s.ps.origin.z).toBe(rest);
          // the first ground move glues the player back down
          s.run(5, () => ({ fmove: 450 }));
          expect(s.ps.origin.z).toBeCloseTo(z0, 6);
        });
      }

      it('vertical velocity right after the jump tick is J - 1.5*g*ft', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        const ev = s.step({ buttons: IN_JUMP });
        expect(ev.jumped).toBe(true);
        expect(s.ps.onGround).toBe(false);
        expect(s.ps.velocity.z).toBeCloseTo(J - 1.5 * G * 0.01, 9);
        expect(s.ps.flags & FL_ONGROUND).toBe(0);
      });

      it('a ducked jump sets vz to the impulse: apex is the continuous 57 units', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.run(30, () => ({ buttons: IN_DUCK }));
        expect(s.ps.ducked).toBe(true);
        const z0 = s.ps.origin.z;
        let apex = 0;
        s.run(80, (i) => ({ buttons: IN_DUCK | (i === 0 ? IN_JUMP : 0) }), () => {
          apex = Math.max(apex, s.ps.origin.z - z0);
        });
        expect(apex).toBeCloseTo(discreteApex(J - (G * 0.01) / 2, 0.01), 6);
        expect(apex).toBeGreaterThan(56.98);
        expect(apex).toBeLessThanOrEqual((J * J) / (2 * G) + 1e-9);
      });
    });

    // ---------------------------------------------------------------------------------- 2. ground movement
    describe('2. ground acceleration and friction', () => {
      for (const T of TICKS) {
        it(`run / walk / duck speeds @${T.name} tick`, () => {
          const w = W.make([floorBrush(0)]);
          for (const mode of ['run', 'walk', 'duck'] as const) {
            const s = new Sim(w, T.ft, v3(0, 0, 8)).settle();
            const buttons = mode === 'walk' ? IN_SPEED : mode === 'duck' ? IN_DUCK : 0;
            let t250 = -1;
            let max = 0;
            s.run(Math.ceil(1 / T.ft), () => ({ fmove: 450, buttons }), () => {
              max = Math.max(max, s.hspeed);
              if (t250 < 0 && s.hspeed >= 249.999) t250 = s.t;
              expect(s.ps.onGround).toBe(true);
            });
            const target = mode === 'run' ? 250 : mode === 'walk' ? 130 : 85;
            expect(s.hspeed).toBeCloseTo(target, 6);
            // (pressing duck and forward together accelerates during the duck transition first)
            if (mode !== 'duck') expect(max).toBeLessThanOrEqual(target + 1e-6);
            if (mode === 'run') {
              expect(t250).toBeGreaterThan(0.1);
              expect(t250).toBeLessThan(0.16);
            }
            // release: friction brings the player to a stop
            let stopT = -1;
            const t0 = s.t;
            s.run(Math.ceil(1 / T.ft), () => ({ buttons }), () => {
              if (stopT < 0 && s.hspeed === 0) stopT = s.t - t0;
            });
            expect(stopT).toBeGreaterThan(0);
            if (mode === 'run') {
              expect(stopT).toBeGreaterThan(0.38);
              expect(stopT).toBeLessThan(0.44);
            } else {
              expect(stopT).toBeLessThan(0.32);
            }
            expect(s.ps.origin.z).toBeCloseTo(DIST_EPSILON, 6);
          }
        });
      }

      it('a floor tiled from many brushes: running and bhopping across seams never catches', () => {
        const tiles: Brush[] = [];
        for (let i = -20; i < 20; i++) for (let j = -2; j < 2; j++) tiles.push(boxBrush(v3(i * 64, j * 64, -64), v3((i + 1) * 64, (j + 1) * 64, 0)));
        const w = W.make(tiles);
        const s = new Sim(w, 0.01, v3(-1200, 10, 8), 0).settle();
        s.run(100, () => ({ fmove: 450, yaw: 0 }));
        expect(s.hspeed).toBeCloseTo(250, 6);
        s.run(200, () => ({ fmove: 450, yaw: 0 }), () => {
          expect(s.hspeed).toBeCloseTo(250, 6);
          expect(s.ps.onGround).toBe(true);
          expect(s.ps.origin.z).toBeCloseTo(DIST_EPSILON, 9);
        });
        // autobhop across the tiles keeps 600 exactly
        const b = new Sim(w, 0.01, v3(-1200, 10, 30));
        b.ps.velocity = v3(600, 0, 0);
        b.run(300, () => ({ buttons: IN_JUMP }), () => {
          expect(b.hspeed).toBeCloseTo(600, 9);
          expect(b.inSolid()).toBe(false);
        });
      });

      it('friction: one tick from 250 drops by speed*friction*ft; below stopspeed by stopspeed*friction*ft', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.ps.velocity = v3(250, 0, 0);
        s.step();
        expect(s.hspeed).toBeCloseTo(250 * (1 - 5.2 * 0.01), 9);
        s.ps.velocity = v3(0, 50, 0);
        s.step();
        expect(s.hspeed).toBeCloseTo(50 - 80 * 5.2 * 0.01, 9);
      });

      it('accelerate: first tick from rest gains accel*ft*250, never above the wish speed', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.step({ fmove: 450 });
        expect(s.hspeed).toBeCloseTo(10 * 0.01 * 250, 9);
        // ducked/walking players accelerate with the weapon (knife) speed too (CS:GO)
        const d = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        d.step({ fmove: 450, buttons: IN_SPEED });
        expect(d.hspeed).toBeCloseTo(25, 9);
        d.run(20, () => ({ fmove: 450, buttons: IN_SPEED }));
        expect(d.hspeed).toBeCloseTo(130, 9);
      });

      it('diagonal input is capped to maxspeed (no faster strafe-running)', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.run(100, () => ({ fmove: 450, smove: 450 }));
        expect(s.hspeed).toBeCloseTo(250, 6);
        expect(yawOf(s.ps.velocity)).toBeCloseTo(-45, 6);
      });

      it('groundDistance reports the horizontal distance walked', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.run(30, () => ({ fmove: 450 }));
        const x0 = s.ps.origin.x;
        const ev = s.step({ fmove: 450 });
        expect(ev.groundDistance).toBeCloseTo(s.ps.origin.x - x0, 9);
        expect(ev.groundDistance).toBeGreaterThan(2);
      });

      it('maxSpeedOverride replaces the knife speed', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.ps.maxSpeedOverride = 200;
        s.run(100, () => ({ fmove: 450 }));
        expect(s.hspeed).toBeCloseTo(200, 6);
      });
    });

    // ---------------------------------------------------------------------------------- 3. air strafing
    describe('3. air strafing', () => {
      for (const T of TICKS) {
        it(`synchronized strafing gains speed every tick @${T.name} tick`, () => {
          const w = W.make([floorBrush(-100000)]);
          const s = new Sim(w, T.ft, v3(0, 0, 0));
          s.ps.velocity = v3(400, 0, 0);
          let prev = s.hspeed;
          const n = Math.ceil(2 / T.ft);
          for (let i = 0; i < n; i++) {
            const right = i % 200 < 100; // change strafe direction like a real surfer
            s.step({ smove: right ? 450 : -450, yaw: yawOf(s.ps.velocity) });
            const sp = s.hspeed;
            // perpendicular wish direction is the optimal angle: |v|^2 grows by exactly 30^2
            expect(sp).toBeCloseTo(Math.sqrt(prev * prev + 900), 6);
            expect(sp).toBeGreaterThan(prev);
            prev = sp;
          }
          // |v|^2 grows by 30^2 per tick: more ticks per second = faster gain (128 tick strafes better)
          expect(prev).toBeCloseTo(Math.sqrt(400 * 400 + 900 * n), 6);
        });
      }

      it('W only in the air adds nothing once the projection exceeds 30', () => {
        const w = W.make([floorBrush(-100000)]);
        const s = new Sim(w, 0.01, v3(0, 0, 0));
        s.ps.velocity = v3(300, 0, 0);
        s.run(50, () => ({ fmove: 450, yaw: 0 }));
        expect(s.ps.velocity.x).toBeCloseTo(300, 9);
        expect(s.ps.velocity.y).toBeCloseTo(0, 9);
        // from rest: capped at exactly 30 along the wish direction
        const r = new Sim(w, 0.01, v3(0, 0, 0));
        r.step({ fmove: 450, yaw: 0 });
        expect(r.ps.velocity.x).toBeCloseTo(30, 9);
        r.run(50, () => ({ fmove: 450, yaw: 0 }));
        expect(r.ps.velocity.x).toBeCloseTo(30, 9);
      });

      it('strafing without turning caps the sideways component at 30', () => {
        const w = W.make([floorBrush(-100000)]);
        const s = new Sim(w, 0.01, v3(0, 0, 0));
        s.ps.velocity = v3(500, 0, 0);
        s.run(100, () => ({ smove: -450, yaw: 0 })); // -450 = left = +y at yaw 0
        expect(s.ps.velocity.y).toBeCloseTo(30, 9);
        expect(s.ps.velocity.x).toBeCloseTo(500, 9);
      });

      it('per-tick gain uses the uncapped wishspeed: one tick from rest against the motion', () => {
        const w = W.make([floorBrush(-100000)]);
        const s = new Sim(w, 0.01, v3(0, 0, 0));
        s.ps.velocity = v3(-1000, 0, 0);
        s.step({ fmove: 450, yaw: 0 });
        // addspeed = 30 + 1000, accelspeed = 150 * 250 * 0.01 = 375
        expect(s.ps.velocity.x).toBeCloseTo(-1000 + 375, 9);
      });
    });

    // ---------------------------------------------------------------------------------- 4. surfing
    describe('4. surf ramps', () => {
      const NZ = 0.5; // 60 degree ramp
      const ramp = (): Brush => surfRamp(0, 0, 4000, NZ, -30000, 30000);
      const face = rampFace(0, 0, NZ);

      for (const T of TICKS) {
        it(`resting on a 60deg ramp: never grounded, slides down gaining speed @${T.name} tick`, () => {
          const w = W.make([ramp()]);
          const s = new Sim(w, T.ft, originAtGap(face.n, face.d, 1200, 0, 0.5));
          expect(s.inSolid()).toBe(false);
          let contact = false;
          let prevTangential = 0;
          const n = face.n;
          s.run(Math.ceil(1 / T.ft), () => ({}), () => {
            expect(s.ps.onGround).toBe(false);
            const gap = hullGap(s.ps.origin, n, face.d);
            if (gap < 0.1) contact = true;
            if (contact) {
              expect(gap).toBeGreaterThan(0);
              expect(gap).toBeLessThan(0.1);
            }
            const v = s.ps.velocity;
            const vn = dot(v, n);
            const tangential = Math.hypot(v.x - n.x * vn, v.y - n.y * vn, v.z - n.z * vn);
            expect(tangential).toBeGreaterThanOrEqual(prevTangential - 1e-9);
            prevTangential = tangential;
            expect(s.inSolid()).toBe(false);
          });
          expect(contact).toBe(true);
          // along-slope acceleration is g * sin(60deg)
          expect(prevTangential).toBeGreaterThan(G * Math.sin(Math.acos(NZ)) * 0.97);
          expect(prevTangential).toBeLessThan(G * Math.sin(Math.acos(NZ)) * 1.01);
          expect(s.ps.velocity.x).toBeLessThan(0); // down the ramp is -x
        });

        it(`surfing along: strafe into the ramp keeps contact and height, letting go slides down faster @${T.name} tick`, () => {
          const w = W.make([ramp()]);
          const start = originAtGap(face.n, face.d, 1800, 0, 0.5);
          const s = new Sim(w, T.ft, start, 90);
          s.ps.velocity = v3(0, 1000, 0);
          let contact = false;
          const N = Math.ceil(2 / T.ft);
          s.run(N, () => ({ smove: 450, yaw: 90 }), () => {
            expect(s.ps.onGround).toBe(false);
            const gap = hullGap(s.ps.origin, face.n, face.d);
            if (gap < 0.1) contact = true;
            if (contact) {
              expect(gap).toBeGreaterThan(0);
              expect(gap).toBeLessThan(1);
            }
            // never pushed away from the ramp (no bounce)
            expect(dot(s.ps.velocity, face.n)).toBeLessThanOrEqual(1e-9);
            // nothing along the ramp is lost
            expect(s.ps.velocity.y).toBeCloseTo(1000, 6);
            expect(s.inSolid()).toBe(false);
          });
          expect(contact).toBe(true);
          // the 30 u/s into-ramp push, clipped by the ramp, holds the surfer up (a slow climb)
          expect(s.ps.origin.z).toBeGreaterThan(start.z - 1);
          expect(s.speed).toBeGreaterThan(1000);
          expect(s.speed).toBeLessThan(1002);
          // letting go: gravity slides the surfer down the ramp, gaining speed
          const free = new Sim(w, T.ft, start, 90);
          free.ps.velocity = v3(0, 1000, 0);
          free.run(N, () => ({ yaw: 90 }), () => {
            expect(free.ps.onGround).toBe(false);
            expect(free.ps.velocity.y).toBeCloseTo(1000, 6);
          });
          expect(free.ps.origin.z).toBeLessThan(start.z - 500);
          expect(free.speed).toBeGreaterThan(1400);
          expect(hullGap(free.ps.origin, face.n, face.d)).toBeLessThan(0.1);
        });

        it(`surfer pattern: look along the ramp, alternate hold-into-ramp and release @${T.name} tick`, () => {
          const w = W.make([ramp()]);
          const s = new Sim(w, T.ft, originAtGap(face.n, face.d, 2000, 0, 0.5), 90);
          s.ps.velocity = v3(0, 700, -100);
          const v0 = s.speed;
          const z0 = s.ps.origin.z;
          let contact = 0;
          let prevSpeed = s.speed;
          let prevOrigin = { ...s.ps.origin };
          const N = Math.ceil(4 / T.ft);
          s.run(
            N,
            () => ((s.t % 0.6) < 0.15 ? { smove: 450, yaw: 90 } : { yaw: 90 }),
            () => {
              expect(s.ps.onGround).toBe(false);
              if (hullGap(s.ps.origin, face.n, face.d) < 1) contact++;
              // never a dead stop or a stalled position
              if (prevSpeed > 100) expect(s.speed).toBeGreaterThan(1);
              const moved = Math.hypot(s.ps.origin.x - prevOrigin.x, s.ps.origin.y - prevOrigin.y, s.ps.origin.z - prevOrigin.z);
              expect(moved).toBeGreaterThan(prevSpeed * T.ft * 0.5);
              prevSpeed = s.speed;
              prevOrigin = { ...s.ps.origin };
              expect(s.ps.velocity.y).toBeCloseTo(700, 6);
            },
          );
          expect(contact).toBeGreaterThan(N * 0.95);
          // the releases let the surfer descend; each hold brakes the down-slope slide again
          // (pressing into the ramp cancels most of the accumulated down-slope speed)
          expect(s.ps.origin.z).toBeLessThan(z0 - 200);
          expect(s.speed).toBeGreaterThan(v0 - 50);
        });
      }

      it('a ramp built from many coplanar brushes: seams are invisible (no speed loss, no hitch)', () => {
        const segs: Brush[] = [];
        for (let k = 0; k < 40; k++) segs.push(surfRamp(0, 0, 4000, NZ, -2000 + k * 400, -2000 + (k + 1) * 400));
        const w = W.make(segs);
        const s = new Sim(w, 0.01, originAtGap(face.n, face.d, 1800, -1900, 0.5), 90);
        s.ps.velocity = v3(0, 2000, 0);
        let contact = 0;
        let prev = { ...s.ps.origin };
        s.run(300, () => ({ smove: 450, yaw: 90 }), () => {
          expect(s.ps.velocity.y).toBeCloseTo(2000, 6);
          expect(s.ps.origin.y - prev.y).toBeCloseTo(20, 6);
          if (hullGap(s.ps.origin, face.n, face.d) < 1) contact++;
          prev = { ...s.ps.origin };
          expect(s.inSolid()).toBe(false);
        });
        expect(s.ps.origin.y).toBeGreaterThan(-1900 + 5900);
        expect(contact).toBeGreaterThan(295);
      });

      it('velocity into the ramp is clipped away in one tick, no bounce, tangent preserved', () => {
        const w = W.make([ramp()]);
        const n = face.n;
        const s = new Sim(w, 0.01, originAtGap(n, face.d, 1500, 0, 0.5));
        s.ps.velocity = v3(-500 * n.x, 500, -500 * n.z);
        s.step();
        expect(s.ps.velocity.y).toBeCloseTo(500, 9);
        // only this tick's FinishGravity half step points into the ramp afterwards
        expect(dot(s.ps.velocity, n)).toBeCloseTo(-(G * 0.01 * 0.5) * n.z, 6);
        const gap = hullGap(s.ps.origin, n, face.d);
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThanOrEqual(DIST_EPSILON + 1e-6);
        expect(s.ps.onGround).toBe(false);
      });

      it('moving up a ramp (0 < vz <= 140) sets surfaceFriction 0.25 and quarters air acceleration', () => {
        const w = W.make([ramp()]);
        const n = face.n;
        const up = v3(n.z, 0, -n.x); // up-slope tangent
        const s = new Sim(w, 0.01, originAtGap(n, face.d, 1500, 0, DIST_EPSILON), 90);
        const k = 110 / up.z;
        s.ps.velocity = v3(up.x * k, 500, up.z * k);
        s.step({ yaw: 90 });
        expect(s.ps.velocity.z).toBeGreaterThan(0);
        expect(s.ps.velocity.z).toBeLessThanOrEqual(140);
        expect(s.ps.surfaceFriction).toBe(0.25);
        // counter-strafe along -y: the gain is 0.25 * 150 * 250 * ft instead of 375 * ft
        const vy = s.ps.velocity.y;
        s.step({ fmove: -450, yaw: 90 });
        expect(s.ps.velocity.y - vy).toBeCloseTo(-0.25 * 150 * 250 * 0.01, 6);
      });

      it('surfaceFriction quirk in open air: 0.25 only while 0 < vz <= 140', () => {
        const w = W.make([floorBrush(-100000)]);
        for (const [vz, expected] of [
          [100, 0.25],
          [300, 1],
          [-50, 1],
        ] as const) {
          const s = new Sim(w, 0.01, v3(0, 0, 0), 90);
          s.ps.velocity = v3(0, 500, vz);
          s.step({ yaw: 90 });
          expect(s.ps.surfaceFriction).toBe(expected);
          const vy = s.ps.velocity.y;
          s.step({ fmove: -450, yaw: 90 });
          expect(s.ps.velocity.y - vy).toBeCloseTo(-expected * 375, 6);
        }
      });

      it('ramp + wall crease: blocked by the wall, keeps sliding down along the crease, never in solid', () => {
        const wall = boxBrush(v3(-1000, 500, -1000), v3(5000, 600, 5000));
        const w = W.make([ramp(), wall]);
        const n = face.n;
        const s = new Sim(w, 0.01, originAtGap(n, face.d, 1500, 400, 0.5), 90);
        s.ps.velocity = v3(0, 800, -100);
        const z0 = s.ps.origin.z;
        s.run(100, () => ({ yaw: 90 }), () => {
          expect(s.inSolid()).toBe(false);
          expect(s.ps.origin.y).toBeLessThanOrEqual(500 - 16);
        });
        expect(s.ps.origin.y).toBeCloseTo(500 - 16 - DIST_EPSILON, 1);
        expect(Math.abs(s.ps.velocity.y)).toBeLessThan(1e-6);
        expect(s.ps.origin.z).toBeLessThan(z0 - 50);
        expect(s.speed).toBeGreaterThan(300);
      });
    });

    // ---------------------------------------------------------------------------------- 5. slopes
    describe('5. slopes', () => {
      it('normal.z 0.75 is walkable: lands grounded, stands still, walks up and down', () => {
        const w = W.make([floorBrush(0), surfRamp(0, 0, 600, 0.75, -2000, 2000)]);
        const s = new Sim(w, 0.01, v3(300, 0, 600)).settle();
        expect(s.ps.onGround).toBe(true);
        expect(s.ps.groundNormal.z).toBeCloseTo(0.75, 9);
        const o = { ...s.ps.origin };
        s.run(100);
        expect(s.ps.onGround).toBe(true);
        expect(s.ps.origin.x).toBeCloseTo(o.x, 9);
        expect(s.ps.origin.z).toBeCloseTo(o.z, 9);
        // walk up
        const z0 = s.ps.origin.z;
        s.run(80, () => ({ fmove: 450, yaw: 0 }));
        expect(s.ps.onGround).toBe(true);
        expect(s.ps.origin.z).toBeGreaterThan(z0 + 80);
        // walk down: StayOnGround keeps the player glued every tick
        s.run(150, () => ({ fmove: 450, yaw: 180 }), () => {
          expect(s.ps.onGround).toBe(true);
        });
        expect(s.ps.origin.z).toBeLessThan(z0);
      });

      it('normal.z 0.69 is too steep: not grounded, slides down', () => {
        const w = W.make([floorBrush(0), surfRamp(0, 0, 600, 0.69, -2000, 2000)]);
        const s = new Sim(w, 0.01, v3(300, 0, 700)).settle();
        expect(s.ps.onGround).toBe(false);
        const x0 = s.ps.origin.x;
        s.run(40, () => ({}), () => {
          expect(s.ps.onGround).toBe(false);
        });
        expect(s.ps.origin.x).toBeLessThan(x0 - 5);
        expect(s.ps.velocity.x).toBeLessThan(-100);
      });
    });

    // ---------------------------------------------------------------------------------- 6. stairs
    describe('6. stairs', () => {
      for (const T of TICKS) {
        it(`18-unit steps are climbed, 19-unit steps block @${T.name} tick`, () => {
          const w18 = W.make([floorBrush(0), ...stairs(64, 0, 18, 32, 6, 512)]);
          const s = new Sim(w18, T.ft, v3(0, 0, 8)).settle();
          let steps = 0;
          s.run(Math.ceil(2 / T.ft), () => ({ fmove: 450, yaw: 0 }), (_i, ev) => {
            if (ev.stepped) steps++;
            expect(s.inSolid()).toBe(false);
          });
          expect(s.ps.origin.z).toBeCloseTo(6 * 18 + DIST_EPSILON, 3);
          expect(s.ps.origin.x).toBeGreaterThan(64 + 6 * 32);
          expect(steps).toBeGreaterThanOrEqual(6);
          expect(s.ps.onGround).toBe(true);

          const w19 = W.make([floorBrush(0), ...stairs(64, 0, 19, 32, 6, 512)]);
          const b = new Sim(w19, T.ft, v3(0, 0, 8)).settle();
          b.run(Math.ceil(1 / T.ft), () => ({ fmove: 450, yaw: 0 }));
          expect(b.ps.origin.z).toBeCloseTo(DIST_EPSILON, 6);
          expect(b.ps.origin.x).toBeLessThan(64 - 16);
          expect(b.ps.origin.x).toBeGreaterThan(64 - 16 - 0.1);
        });
      }

      it('walking down 16-unit stairs stays grounded every tick (StayOnGround)', () => {
        const w = W.make([floorBrush(0), ...stairs(64, 0, 16, 32, 6, 512)]);
        const s = new Sim(w, 0.01, v3(64 + 6 * 32 + 100, 0, 200)).settle();
        expect(s.ps.origin.z).toBeCloseTo(96 + DIST_EPSILON, 6);
        s.run(150, () => ({ fmove: 450, yaw: 180 }), () => {
          expect(s.ps.onGround).toBe(true);
        });
        expect(s.ps.origin.z).toBeCloseTo(DIST_EPSILON, 6);
      });

      it('an exactly-18 drop is beyond StayOnGround (needs 18 + DIST_EPSILON): a short fall per step', () => {
        const w = W.make([floorBrush(0), ...stairs(64, 0, 18, 32, 6, 512)]);
        const s = new Sim(w, 0.01, v3(64 + 6 * 32 + 100, 0, 200)).settle();
        let airTicks = 0;
        s.run(250, () => ({ fmove: 450, yaw: 180 }), () => {
          if (!s.ps.onGround) airTicks++;
          expect(s.inSolid()).toBe(false);
        });
        expect(airTicks).toBeGreaterThan(0);
        expect(s.ps.origin.z).toBeCloseTo(DIST_EPSILON, 6);
      });

      it('no stepping up in the air (only clipping)', () => {
        const w = W.make([floorBrush(0), boxBrush(v3(100, -500, 0), v3(400, 500, 10))]);
        const s = new Sim(w, 0.01, v3(0, 0, 2));
        s.ps.velocity = v3(400, 0, -200);
        s.run(30);
        // fell against the 10-unit ledge's side instead of stepping onto it
        expect(s.ps.origin.x).toBeLessThan(100 - 16 + 1e-6);
      });
    });

    // ---------------------------------------------------------------------------------- 7. walls & creases
    describe('7. walls and corners', () => {
      it('ground wall slide: sliding along the wall, nothing into it', () => {
        const w = W.make([floorBrush(0), boxBrush(v3(200, -5000, 0), v3(300, 5000, 300))]);
        const s = new Sim(w, 0.01, v3(0, 0, 8), 45).settle();
        s.run(300, () => ({ fmove: 450, yaw: 45 }), () => {
          expect(s.inSolid()).toBe(false);
        });
        expect(s.ps.origin.x).toBeLessThanOrEqual(200 - 16);
        expect(s.ps.origin.x).toBeGreaterThan(200 - 16 - 0.1);
        expect(Math.abs(s.ps.velocity.x)).toBeLessThan(1e-6);
        expect(s.ps.velocity.y).toBeGreaterThan(150);
        expect(s.ps.origin.y).toBeGreaterThan(300);
      });

      it('airborne wall hit: exact slide, no bounce (sv_bounce 0)', () => {
        const w = W.make([boxBrush(v3(200, -5000, -5000), v3(300, 5000, 5000))]);
        const s = new Sim(w, 0.01, v3(180, 0, 0));
        s.ps.velocity = v3(1000, 500, 0);
        s.step();
        expect(s.ps.velocity.x).toBeCloseTo(0, 9);
        expect(s.ps.velocity.y).toBeCloseTo(500, 9);
        expect(s.ps.origin.x).toBeCloseTo(200 - 16 - DIST_EPSILON, 4);
      });

      it('concave 90deg corner: stops dead in the corner', () => {
        const w = W.make([
          floorBrush(0),
          boxBrush(v3(200, -5000, 0), v3(300, 5000, 300)),
          boxBrush(v3(-5000, 200, 0), v3(5000, 300, 300)),
        ]);
        const s = new Sim(w, 0.01, v3(0, 0, 8), 45).settle();
        s.run(300, () => ({ fmove: 450, yaw: 45 }), () => {
          expect(s.inSolid()).toBe(false);
        });
        expect(s.hspeed).toBeLessThan(1e-9);
        expect(s.ps.origin.x).toBeCloseTo(200 - 16 - DIST_EPSILON, 1);
        expect(s.ps.origin.y).toBeCloseTo(200 - 16 - DIST_EPSILON, 1);
      });

      it('acute V corner (crease of two planes): stops at the apex, ground and air', () => {
        const a = prismXY(
          [
            [0, 173.205],
            [300, 0],
            [400, 0],
            [400, 400],
            [0, 400],
          ],
          0,
          400,
        );
        const b = prismXY(
          [
            [0, -173.205],
            [0, -400],
            [400, -400],
            [400, 0],
            [300, 0],
          ],
          0,
          400,
        );
        const w = W.make([floorBrush(0), a, b]);
        const s = new Sim(w, 0.01, v3(0, 0, 8), 0).settle();
        s.run(300, () => ({ fmove: 450, yaw: 0 }), () => {
          expect(s.inSolid()).toBe(false);
        });
        const x = s.ps.origin.x;
        expect(s.hspeed).toBeLessThan(1e-6);
        s.run(50, () => ({ fmove: 450, yaw: 0 }));
        expect(s.ps.origin.x).toBeCloseTo(x, 6);
        // airborne into the V with a slight sideways component
        const air = new Sim(w, 0.01, v3(100, 5, 200));
        air.ps.velocity = v3(1500, 40, 0);
        air.run(30, () => ({}), () => {
          expect(air.inSolid()).toBe(false);
        });
        expect(air.hspeed).toBeLessThan(1);
      });
    });

    // ---------------------------------------------------------------------------------- 8. maxvelocity
    describe('8. sv_maxvelocity', () => {
      it('clamps each axis separately (diagonal can exceed 3500)', () => {
        const w = W.make([floorBrush(-100000)]);
        const s = new Sim(w, 0.01, v3(0, 0, 0));
        s.ps.velocity = v3(5000, -5000, 0);
        s.step();
        expect(s.ps.velocity.x).toBe(3500);
        expect(s.ps.velocity.y).toBe(-3500);
        expect(s.hspeed).toBeCloseTo(3500 * Math.SQRT2, 6);
      });

      it('terminal fall speed is 3500', () => {
        const w = W.make([floorBrush(-1e7)]);
        const s = new Sim(w, 0.01, v3(0, 0, 0));
        s.run(600, () => ({}), () => {
          expect(s.ps.velocity.z).toBeGreaterThanOrEqual(-3500);
        });
        expect(s.ps.velocity.z).toBe(-3500);
      });

      it('NaN velocity components are scrubbed', () => {
        const w = W.make([floorBrush(-100000)]);
        const s = new Sim(w, 0.01, v3(0, 0, 0));
        s.ps.velocity = v3(NaN, 100, 0);
        s.step({ fmove: NaN, yaw: NaN });
        expect(Number.isFinite(s.ps.velocity.x)).toBe(true);
        expect(Number.isFinite(s.ps.origin.x)).toBe(true);
        expect(s.ps.velocity.y).toBeCloseTo(100, 9);
      });
    });

    // ---------------------------------------------------------------------------------- 9. ducking
    describe('9. ducking', () => {
      for (const T of TICKS) {
        it(`ground duck transition over duckTime, hull switch at the end @${T.name} tick`, () => {
          const w = W.make([floorBrush(0)]);
          const s = new Sim(w, T.ft, v3(0, 0, 8)).settle();
          const z0 = s.ps.origin.z;
          const need = Math.ceil(s.vars.duckTime / T.ft - 1e-9);
          let prevView = VIEW_OFFSET_STAND;
          for (let k = 1; k <= need + 2; k++) {
            s.step({ buttons: IN_DUCK });
            if (k < need) {
              expect(s.ps.ducked).toBe(false);
              expect(s.ps.ducking).toBe(true);
              expect(s.ps.flags & FL_DUCKING).toBe(0);
              expect(s.ps.duckAmount).toBeCloseTo((k * T.ft) / s.vars.duckTime, 9);
              expect(s.ps.viewOffsetZ).toBeLessThan(prevView);
              expect(s.ps.viewOffsetZ).toBeGreaterThan(VIEW_OFFSET_DUCK);
            } else {
              expect(s.ps.ducked).toBe(true);
              expect(s.ps.ducking).toBe(false);
              expect(s.ps.flags & FL_DUCKING).toBe(FL_DUCKING);
              expect(s.ps.duckAmount).toBe(1);
              expect(s.ps.viewOffsetZ).toBe(VIEW_OFFSET_DUCK);
            }
            prevView = s.ps.viewOffsetZ;
            expect(s.ps.origin.z).toBeCloseTo(z0, 9);
          }
          // release: unduck transition back to standing
          s.run(need + 2, () => ({}));
          expect(s.ps.ducked).toBe(false);
          expect(s.ps.flags & FL_DUCKING).toBe(0);
          expect(s.ps.viewOffsetZ).toBe(VIEW_OFFSET_STAND);
          expect(s.ps.origin.z).toBeCloseTo(z0, 9);
        });
      }

      it('in-air duck shrinks the hull around its center (origin +9, CS:GO), camera eases; unduck mirrors it', () => {
        const w = W.make([floorBrush(-100000)]);
        const a = new Sim(w, 0.01, v3(0, 0, 500));
        const b = new Sim(w, 0.01, v3(0, 0, 500));
        a.step();
        b.step({ buttons: IN_DUCK });
        expect(b.ps.ducked).toBe(true);
        expect(b.ps.flags & FL_DUCKING).toBe(FL_DUCKING);
        expect(b.ps.origin.z - a.ps.origin.z).toBeCloseTo(9, 9);
        // the camera did not jump at the switch: eyes still level with the non-ducking player
        expect(b.ps.origin.z + b.ps.viewOffsetZ).toBeCloseTo(a.ps.origin.z + a.ps.viewOffsetZ, 9);
        let prevView = b.ps.viewOffsetZ;
        for (let i = 0; i < 20; i++) {
          a.step();
          b.step({ buttons: IN_DUCK });
          expect(b.ps.viewOffsetZ).toBeLessThanOrEqual(prevView);
          prevView = b.ps.viewOffsetZ;
        }
        expect(b.ps.viewOffsetZ).toBe(VIEW_OFFSET_DUCK);
        expect(b.ps.origin.z + b.ps.viewOffsetZ).toBeCloseTo(a.ps.origin.z + a.ps.viewOffsetZ - 9, 9);
        // release: back to the standing hull 9 lower, camera continuous again and easing up to 64
        a.step();
        b.step();
        expect(b.ps.ducked).toBe(false);
        expect(b.ps.origin.z).toBeCloseTo(a.ps.origin.z, 9);
        expect(b.ps.viewOffsetZ).toBeCloseTo(VIEW_OFFSET_DUCK + 9, 9);
        for (let i = 0; i < 20; i++) {
          a.step();
          b.step();
        }
        expect(b.ps.viewOffsetZ).toBe(VIEW_OFFSET_STAND);
        expect(b.ps.ducking).toBe(false);
      });

      for (const T of TICKS) {
        it(`crouch-jump reach matches Valve's CS:GO Mapper's Reference @${T.name} tick`, () => {
          // reachable block height = highest feet position, with the player starting on the floor
          const reach = (pattern: 'stand' | 'crouched' | 'jumpThenCrouch' | 'crouchThenJump'): number => {
            const w = W.make([floorBrush(0)]);
            const s = new Sim(w, T.ft, v3(0, 0, 8)).settle();
            s.run(5, () => ({ fmove: 450 })); // glued to the floor (DIST_EPSILON)
            s.ps.velocity = v3(0, 0, 0);
            if (pattern === 'crouched') s.run(40, () => ({ buttons: IN_DUCK }));
            const z0 = s.ps.origin.z - DIST_EPSILON;
            let best = 0;
            s.run(Math.ceil(1 / T.ft), (i) => {
              const duck =
                pattern === 'crouched' || (pattern === 'crouchThenJump' && i >= 0) || (pattern === 'jumpThenCrouch' && i >= 1);
              const jump = pattern === 'crouchThenJump' ? i === 1 : i === 0;
              return { buttons: (jump ? IN_JUMP : 0) | (duck ? IN_DUCK : 0) };
            }, () => {
              best = Math.max(best, s.ps.origin.z - z0);
            });
            return best;
          };
          const is128 = T.ft < 0.009;
          const is64 = T.ft > 0.015;
          const stand = reach('stand');
          const jumpThenCrouch = reach('jumpThenCrouch');
          // Mapper's Reference (64 / 128 tick): stand 54 / 55, jump-then-crouch 63 / 64
          if (is64) {
            expect(Math.floor(stand)).toBe(54);
            expect(Math.floor(jumpThenCrouch)).toBe(63);
          }
          if (is128) {
            expect(Math.floor(stand)).toBe(55);
            expect(Math.floor(jumpThenCrouch)).toBe(64);
          }
          expect(jumpThenCrouch - stand).toBeCloseTo(9, 6);
          // crouched / crouch-then-jump (reference 56 / 57 and 65 / 66): ducked jumps set vz = impulse
          const crouched = reach('crouched');
          const crouchThenJump = reach('crouchThenJump');
          expect(crouched).toBeGreaterThan(56.9);
          expect(crouched).toBeLessThan(57.1);
          expect(crouchThenJump - crouched).toBeCloseTo(9, 6);
        });
      }

      it('in-air unduck close above the ground puts the feet on the ground', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 200));
        s.step({ buttons: IN_DUCK });
        expect(s.ps.ducked).toBe(true);
        // fall until the ducked feet are a few units above the floor
        s.run(500, () => ({ buttons: IN_DUCK }), () => s.ps.origin.z > 10);
        expect(s.ps.onGround).toBe(false);
        s.step();
        expect(s.ps.ducked).toBe(false);
        expect(s.inSolid()).toBe(false);
        expect(s.ps.origin.z).toBeGreaterThanOrEqual(0);
        expect(s.ps.origin.z).toBeLessThan(1);
      });

      it('cannot unduck under a low ceiling; unducks after walking out', () => {
        const w = W.make([floorBrush(0), boxBrush(v3(-100, -500, 60), v3(100, 500, 300))]);
        const s = new Sim(w, 0.01, v3(-300, 0, 8)).settle();
        s.run(30, () => ({ buttons: IN_DUCK }));
        expect(s.ps.ducked).toBe(true);
        // crawl under the ceiling
        s.run(1000, () => ({ fmove: 450, yaw: 0, buttons: IN_DUCK }), () => s.ps.origin.x < 0);
        s.run(60, () => ({}), () => {
          expect(s.ps.ducked).toBe(true);
          expect(s.ps.viewOffsetZ).toBe(VIEW_OFFSET_DUCK);
          expect(s.ps.flags & FL_DUCKING).toBe(FL_DUCKING);
          expect(s.inSolid()).toBe(false);
        });
        // ducked ground speed while crawling out
        s.run(1000, () => ({ fmove: 450, yaw: 0 }), () => s.ps.origin.x < 100 + 16 + 1);
        expect(s.ps.ducked).toBe(true);
        s.run(40, () => ({ fmove: 450, yaw: 0 }));
        expect(s.ps.ducked).toBe(false);
        expect(s.ps.viewOffsetZ).toBe(VIEW_OFFSET_STAND);
      });

      it('cannot unduck in the air when there is no room above or below', () => {
        const w = W.make([floorBrush(0), boxBrush(v3(-500, -500, 60), v3(500, 500, 300))]);
        const s = new Sim(w, 0.01, v3(0, 0, 3));
        s.ps.ducked = true;
        s.ps.flags |= FL_DUCKING;
        s.ps.duckAmount = 1;
        s.ps.viewOffsetZ = VIEW_OFFSET_DUCK;
        expect(s.inSolid()).toBe(false);
        s.step();
        expect(s.ps.ducked).toBe(true);
        s.run(60);
        expect(s.ps.ducked).toBe(true);
        expect(s.ps.onGround).toBe(true);
        expect(s.inSolid()).toBe(false);
      });

      it('ducked speed: exactly 0.34 * 250 once ducked; the crop eases in during the duck transition', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.run(20, () => ({ buttons: IN_DUCK }));
        expect(s.ps.ducked).toBe(true);
        let max = 0;
        s.run(200, () => ({ fmove: 450, buttons: IN_DUCK }), () => {
          max = Math.max(max, s.hspeed);
        });
        expect(s.hspeed).toBeCloseTo(85, 9);
        expect(max).toBeLessThanOrEqual(85 + 1e-9);
        // pressing both at once: smaller burst than an uncropped transition would give
        const b = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        let bmax = 0;
        b.run(100, () => ({ fmove: 450, buttons: IN_DUCK }), () => {
          bmax = Math.max(bmax, b.hspeed);
        });
        expect(bmax).toBeLessThan(10 * 0.01 * 250 * Math.ceil(0.125 / 0.01));
        expect(b.hspeed).toBeCloseTo(85, 6);
        // no crop in the air (air acceleration does not care about ducking)
        const air = new Sim(w, 0.01, v3(0, 0, 500));
        air.step({ buttons: IN_DUCK });
        air.step({ fmove: 450, yaw: 0, buttons: IN_DUCK });
        expect(air.ps.velocity.x).toBeCloseTo(30, 9);
      });
    });

    // ---------------------------------------------------------------------------------- 10. bhop
    describe('10. bunnyhopping', () => {
      for (const T of TICKS) {
        it(`autobhop: re-jumps on the first ground tick, no friction, speed kept @${T.name} tick`, () => {
          const w = W.make([floorBrush(0)]);
          const s = new Sim(w, T.ft, v3(0, 0, 40));
          s.ps.velocity = v3(600, 0, 0);
          let lastLand = -10;
          let hops = 0;
          s.run(Math.ceil(3 / T.ft), () => ({ buttons: IN_JUMP }), (i, ev) => {
            if (ev.jumped) {
              expect(i).toBe(lastLand + 1);
              hops++;
            }
            if (ev.landed) lastLand = i;
            expect(s.hspeed).toBeCloseTo(600, 9);
          });
          expect(hops).toBeGreaterThanOrEqual(3);
        });
      }

      it('without autobhop holding jump does nothing on landing; release + press jumps', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 40));
        s.vars.autobhop = false;
        s.ps.velocity = v3(600, 0, 0);
        s.ps.oldButtons = IN_JUMP;
        let landed = -1;
        s.run(200, () => ({ buttons: IN_JUMP }), (i, ev) => {
          expect(ev.jumped).toBe(false);
          if (ev.landed) landed = i;
          return landed < 0 || i < landed + 10;
        });
        expect(landed).toBeGreaterThan(0);
        expect(s.hspeed).toBeLessThan(600 * 0.7);
        s.step();
        const ev = s.step({ buttons: IN_JUMP });
        expect(ev.jumped).toBe(true);
      });

      it('sv_enablebunnyhopping 0 caps the speed to 1.1 * maxspeed on jump', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.vars.enableBunnyhopping = false;
        s.ps.velocity = v3(600, 0, 0);
        s.step({ buttons: IN_JUMP });
        expect(s.hspeed).toBeCloseTo(275, 9);
      });
    });

    // ---------------------------------------------------------------------------------- 11. base velocity
    describe('11. base velocity', () => {
      it('(0,0,800) maintained by a trigger cancels gravity and lifts slightly; consumed each move', () => {
        const w = W.make([floorBrush(-100000)]);
        const s = new Sim(w, 0.01, v3(0, 0, 0));
        s.run(100, () => {
          s.ps.baseVelocity.z = 800;
          return {};
        }, () => {
          expect(s.ps.baseVelocity.z).toBe(0);
          expect(s.ps.velocity.z).toBeCloseTo(0, 9);
        });
        expect(s.ps.origin.z).toBeCloseTo(100 * 0.5 * 800 * 0.01 * 0.01, 9);
        const f = new Sim(w, 0.01, v3(0, 0, 0));
        f.run(100);
        expect(f.ps.origin.z).toBeLessThan(-30);
      });

      it('(0,0,1600) accelerates upward at 800 u/s^2', () => {
        const w = W.make([floorBrush(-100000)]);
        const s = new Sim(w, 0.01, v3(0, 0, 0));
        s.run(100, () => {
          s.ps.baseVelocity.z = 1600;
          return {};
        });
        expect(s.ps.velocity.z).toBeCloseTo(800, 6);
        // StartGravity applies the whole base.z*ft before the move (only gravity is split in halves)
        let z = 0;
        let vz = 0;
        for (let i = 0; i < 100; i++) {
          vz += -G * 0.005 + 1600 * 0.01;
          z += vz * 0.01;
          vz -= G * 0.005;
        }
        expect(s.ps.origin.z).toBeCloseTo(z, 6);
        expect(z).toBeCloseTo(408, 6);
      });

      it('horizontal base velocity (conveyor) moves a standing player without entering its velocity', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        const x0 = s.ps.origin.x;
        s.ps.baseVelocity.x = 300;
        s.run(100, () => ({}), () => {
          expect(s.hspeed).toBeLessThan(1e-9);
          expect(s.ps.baseVelocity.x).toBe(300);
        });
        expect(s.ps.origin.x - x0).toBeCloseTo(300, 6);
        expect(s.ps.onGround).toBe(true);
      });

      it('vertical base velocity alone does not unground (trigger_push must lift the player)', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.run(10, () => {
          s.ps.baseVelocity.z = 800;
          return {};
        });
        expect(s.ps.onGround).toBe(true);
      });
    });

    // ---------------------------------------------------------------------------------- 12. noclip
    describe('12. noclip', () => {
      it('flies through walls, never grounded, bounded speed, stops without input', () => {
        const w = W.make([floorBrush(0), boxBrush(v3(200, -5000, 0), v3(300, 5000, 1000))]);
        const s = new Sim(w, 0.01, v3(0, 0, 50));
        s.ps.moveType = MOVETYPE_NOCLIP;
        let max = 0;
        s.run(100, () => ({ fmove: 450, yaw: 0 }), () => {
          expect(s.ps.onGround).toBe(false);
          max = Math.max(max, s.speed);
        });
        expect(s.ps.origin.x).toBeGreaterThan(800);
        expect(max).toBeLessThanOrEqual(350 * 5 + 1e-6);
        expect(s.speed).toBeGreaterThan(1400);
        // up / down along the view and upmove
        const z = s.ps.origin.z;
        s.run(50, () => ({ umove: 320 }));
        expect(s.ps.origin.z).toBeGreaterThan(z + 100);
        s.run(100);
        expect(s.speed).toBe(0);
        // pitch makes forward vertical - straight down through the floor
        const z2 = s.ps.origin.z;
        s.run(100, () => ({ fmove: 450, pitch: 89 }));
        expect(s.ps.origin.z).toBeLessThan(z2 - 500);
        expect(s.ps.origin.z).toBeLessThan(0);
        expect(s.ps.onGround).toBe(false);
        // +speed halves the noclip speed
        const slow = new Sim(w, 0.01, v3(0, 0, 50));
        slow.ps.moveType = MOVETYPE_NOCLIP;
        slow.run(100, () => ({ fmove: 450, yaw: 0, buttons: IN_SPEED }));
        // (Source halves the input, not the sv_maxspeed * sv_noclipspeed cap)
        expect(slow.speed).toBeLessThan(450 * 5 * 0.5);
        expect(slow.speed).toBeGreaterThan(500);
        expect(slow.speed).toBeLessThan(s.speed + 1e-9 || 1e9);
        // back to walking: gravity again
        s.ps.moveType = MOVETYPE_WALK;
        s.ps.origin = v3(0, 0, 500);
        s.run(10);
        expect(s.ps.velocity.z).toBeLessThan(-50);
      });
    });

    // ---------------------------------------------------------------------------------- 13. water
    describe('13. water', () => {
      const pool = (): Brush[] => [floorBrush(-400), waterBrush(v3(-1000, -1000, -400), v3(1000, 1000, 0))];

      it('water levels from feet / waist / eyes', () => {
        const w = W.make(pool());
        const ps = createPlayerState(v3(0, 0, 20));
        categorizePosition(ps, w, defaultMoveVars());
        expect(ps.waterLevel).toBe(0);
        for (const [z, level] of [
          [-10, 1],
          [-50, 2],
          [-100, 3],
        ] as const) {
          ps.origin = v3(0, 0, z);
          categorizePosition(ps, w, defaultMoveVars());
          expect(ps.waterLevel).toBe(level);
          expect(ps.waterType & CONTENTS_WATER).toBe(CONTENTS_WATER);
          expect(ps.flags & FL_INWATER).toBe(FL_INWATER);
        }
      });

      it('sinks slowly without input (no gravity), swims up with jump', () => {
        const w = W.make(pool());
        const s = new Sim(w, 0.01, v3(0, 0, -200));
        s.run(300, () => ({}), () => {
          expect(s.ps.velocity.z).toBeGreaterThan(-60);
        });
        expect(s.ps.waterLevel).toBe(3);
        expect(s.ps.velocity.z).toBeCloseTo(-48, 0);
        const z = s.ps.origin.z;
        s.run(60, () => ({ buttons: IN_JUMP }));
        expect(s.ps.origin.z).toBeGreaterThan(z + 60);
        expect(s.ps.velocity.z).toBeGreaterThan(100);
      });

      it('swims along the view direction', () => {
        const w = W.make(pool());
        const s = new Sim(w, 0.01, v3(0, 0, -200));
        s.run(200, () => ({ fmove: 450, yaw: 0, pitch: 45 }));
        expect(s.ps.origin.x).toBeGreaterThan(150);
        expect(s.ps.origin.z).toBeLessThan(-250);
        expect(s.speed).toBeLessThanOrEqual(250 * 0.8 + 1e-6);
        expect(s.speed).toBeGreaterThan(150);
      });

      it('entering and leaving water fire events', () => {
        const w = W.make(pool());
        const s = new Sim(w, 0.01, v3(0, 0, 100));
        let entered = 0;
        let left = 0;
        s.run(100, () => ({}), (_i, ev) => {
          if (ev.enteredWater) entered++;
          if (ev.leftWater) left++;
        });
        expect(entered).toBe(1);
        expect(s.ps.waterLevel).toBeGreaterThan(0);
        s.ps.velocity = v3(0, 0, 900);
        s.run(30, () => ({}), (_i, ev) => {
          if (ev.leftWater) left++;
        });
        expect(left).toBe(1);
        expect(s.ps.waterLevel).toBe(0);
      });

      it('water jump pops the swimmer out onto a ledge', () => {
        const w = W.make([
          floorBrush(-400),
          waterBrush(v3(-1000, -1000, -400), v3(100, 1000, -8)),
          boxBrush(v3(100, -1000, -400), v3(1000, 1000, 0)),
        ]);
        const s = new Sim(w, 0.01, v3(0, 0, -50));
        let waterJumped = false;
        s.run(400, () => ({ fmove: 450, yaw: 0 }), () => {
          if (s.ps.flags & FL_WATERJUMP) waterJumped = true;
          expect(s.inSolid()).toBe(false);
        });
        expect(waterJumped).toBe(true);
        expect(s.ps.origin.x).toBeGreaterThan(100);
        expect(s.ps.onGround).toBe(true);
        expect(s.ps.origin.z).toBeCloseTo(DIST_EPSILON, 3);
      });
    });

    // ---------------------------------------------------------------------------------- ladders
    describe('ladders', () => {
      it('grabs a func_ladder, climbs at ladder speed, hangs without input, jumps off', () => {
        const w = W.make([
          floorBrush(0),
          boxBrush(v3(104, -500, 0), v3(200, 500, 1000)),
          boxBrush(v3(100, -32, 0), v3(104, 32, 600), CONTENTS_LADDER),
        ]);
        const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
        s.run(200, () => ({ fmove: 450, yaw: 0 }), () => s.ps.moveType !== MOVETYPE_LADDER);
        expect(s.ps.moveType).toBe(MOVETYPE_LADDER);
        s.run(5, () => ({ fmove: 450, yaw: 0 }));
        expect(s.ps.velocity.z).toBeCloseTo(200, 6);
        const z = s.ps.origin.z;
        s.run(50, () => ({ fmove: 450, yaw: 0 }));
        expect(s.ps.origin.z).toBeCloseTo(z + 100, 0);
        // hang: no gravity on a ladder
        const z2 = s.ps.origin.z;
        s.run(30);
        expect(s.ps.moveType).toBe(MOVETYPE_LADDER);
        expect(s.ps.origin.z).toBeCloseTo(z2, 6);
        // looking down + forward climbs down
        s.run(20, () => ({ fmove: 450, yaw: 0, pitch: 80 }));
        expect(s.ps.origin.z).toBeLessThan(z2);
        // jump off
        s.step({ buttons: IN_JUMP, yaw: 0 });
        expect(s.ps.moveType).toBe(MOVETYPE_WALK);
        expect(s.ps.velocity.x).toBeLessThan(-200);
        expect(s.inSolid()).toBe(false);
      });
    });

    // ---------------------------------------------------------------------------------- stuck handling
    describe('stuck handling', () => {
      it('unstuckPlayer nudges a player out of a floor; fails deep inside a solid', () => {
        const w = W.make([floorBrush(0), boxBrush(v3(500, -500, 0), v3(1500, 500, 1000))]);
        const ps = createPlayerState(v3(0, 0, -0.5));
        expect(unstuckPlayer(ps, w)).toBe(true);
        expect(w.testBox(ps.origin, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
        expect(ps.origin.z).toBeGreaterThan(0);
        expect(ps.origin.z).toBeLessThanOrEqual(2);
        const deep = createPlayerState(v3(1000, 0, 300));
        expect(unstuckPlayer(deep, w)).toBe(false);
        expect(deep.origin).toEqual(v3(1000, 0, 300));
        // free players are left alone
        const free = createPlayerState(v3(0, 0, 50));
        expect(unstuckPlayer(free, w)).toBe(true);
        expect(free.origin).toEqual(v3(0, 0, 50));
      });

      it('playerMove frees a player that starts the tick embedded (CheckStuck)', () => {
        const w = W.make([floorBrush(0)]);
        const s = new Sim(w, 0.01, v3(0, 0, -1));
        s.run(5, () => ({ fmove: 450 }), () => {
          expect(s.inSolid()).toBe(false);
        });
        expect(s.ps.onGround).toBe(true);
      });

      it('categorizePosition after a teleport: grounded within 2 units, vertical velocity cleared', () => {
        const w = W.make([floorBrush(0)]);
        const ps = createPlayerState(v3(0, 0, 1.5));
        ps.velocity = v3(100, 0, -300);
        categorizePosition(ps, w, defaultMoveVars());
        expect(ps.onGround).toBe(true);
        expect(ps.flags & FL_ONGROUND).toBe(FL_ONGROUND);
        expect(ps.velocity.z).toBe(0);
        expect(ps.groundModel).toBe(0);
        ps.origin = v3(0, 0, 3);
        categorizePosition(ps, w, defaultMoveVars());
        expect(ps.onGround).toBe(false);
        expect(ps.groundModel).toBe(-1);
      });

      it('ledge edge: ground found through the quadrant probes', () => {
        // a flat ledge plus a steep ramp: the hull mostly over the ramp still stands on the ledge corner
        const w = W.make([boxBrush(v3(-500, -500, -100), v3(0, 500, 0)), surfRamp(0, -1000, 1000, 0.3, -500, 500)]);
        const ps = createPlayerState(v3(10, 0, 0.5));
        categorizePosition(ps, w, defaultMoveVars());
        expect(ps.onGround).toBe(true);
        expect(ps.groundNormal.z).toBeCloseTo(1, 9);
      });
    });

    // ---------------------------------------------------------------------------------- 14. soak
    describe('14. soak', () => {
      for (const T of TICKS) {
        it(`30 s synced surf down a long ramp onto flat ground - finite, never in solid, no sticking @${T.name} tick`, () => {
          const NZ = 0.5;
          const w = W.make([floorBrush(0, 100000), surfRamp(0, 200, 2400, NZ, 0, 16000)]);
          const face = rampFace(0, 200, NZ);
          const s = new Sim(w, T.ft, originAtGap(face.n, face.d, 1000, 300, 1), 90);
          s.ps.velocity = v3(0, 900, 0);
          const rnd = mulberry32(99);
          let phase = 'strafe';
          let phaseEnd = 0;
          let rampTicks = 0;
          let landed = 0;
          let prevSpeed = s.speed;
          let prevAir = true;
          let prevOrigin = { ...s.ps.origin };
          let prevDucked = false;
          let maxSpeed = 0;
          const N = Math.ceil(30 / T.ft);
          s.run(
            N,
            () => {
              if (s.t >= phaseEnd) {
                const r = rnd();
                phase = r < 0.6 ? 'strafe' : r < 0.85 ? 'letgo' : 'duck';
                phaseEnd = s.t + 0.3 + rnd() * 1.5;
              }
              // a surfer looks along the ramp (+y) and holds the key toward it (+x = right)
              if (phase === 'letgo') return { yaw: 90 };
              return { smove: 450, yaw: 90, buttons: phase === 'duck' ? IN_DUCK : 0 };
            },
            (_i, ev) => {
              const o = s.ps.origin;
              const v = s.ps.velocity;
              expect(Number.isFinite(o.x + o.y + o.z + v.x + v.y + v.z)).toBe(true);
              expect(s.inSolid()).toBe(false);
              expect(Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z))).toBeLessThanOrEqual(3500);
              if (ev.landed) landed++;
              const air = !s.ps.onGround;
              if (air && o.y < 16000 && hullGap(o, face.n, face.d, s.ps.ducked) < 1) rampTicks++;
              // no sticking: never a dead stop or a stalled position while flying (an in-air duck/unduck
              // legitimately shifts the origin by 18, so those ticks are not compared)
              if (air && prevAir && prevSpeed > 100) {
                expect(s.speed).toBeGreaterThan(1);
                if (s.ps.ducked === prevDucked) {
                  const moved = Math.hypot(o.x - prevOrigin.x, o.y - prevOrigin.y, o.z - prevOrigin.z);
                  expect(moved).toBeGreaterThan(prevSpeed * T.ft * 0.5);
                }
              }
              prevSpeed = s.speed;
              prevAir = air;
              prevOrigin = { ...o };
              prevDucked = s.ps.ducked;
              maxSpeed = Math.max(maxSpeed, s.speed);
            },
          );
          expect(rampTicks).toBeGreaterThan(Math.ceil(3 / T.ft));
          expect(landed).toBeGreaterThanOrEqual(1);
          expect(maxSpeed).toBeGreaterThan(1200);
          expect(s.ps.onGround).toBe(true);
        });

        it(`30 s chaos input on the ramp - finite, never in solid, never a velocity kill in the air @${T.name} tick`, () => {
          const NZ = 0.5;
          const w = W.make([floorBrush(0, 100000), surfRamp(0, 200, 2400, NZ, 0, 16000), boxBrush(v3(-3000, 9000, 0), v3(3000, 9100, 600))]);
          const face = rampFace(0, 200, NZ);
          const s = new Sim(w, T.ft, originAtGap(face.n, face.d, 1000, 300, 1), 90);
          s.ps.velocity = v3(0, 900, 0);
          const rnd = mulberry32(1234);
          let input: Input = {};
          let prevSpeed = s.speed;
          let prevAir = true;
          s.run(
            Math.ceil(30 / T.ft),
            (i) => {
              if (i % 15 === 0) {
                const r = rnd();
                input = {
                  smove: r < 0.65 ? 450 : r < 0.8 ? -450 : 0,
                  fmove: rnd() < 0.15 ? 450 : 0,
                  yaw: yawOf(s.ps.velocity) + (rnd() - 0.5) * 60,
                  pitch: (rnd() - 0.5) * 60,
                  buttons: (rnd() < 0.2 ? IN_JUMP : 0) | (rnd() < 0.15 ? IN_DUCK : 0),
                };
              }
              return input;
            },
            () => {
              const o = s.ps.origin;
              const v = s.ps.velocity;
              expect(Number.isFinite(o.x + o.y + o.z + v.x + v.y + v.z)).toBe(true);
              expect(s.inSolid()).toBe(false);
              expect(Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z))).toBeLessThanOrEqual(3500);
              const air = !s.ps.onGround;
              if (air && prevAir && prevSpeed > 300) expect(s.speed).toBeGreaterThan(1);
              prevSpeed = s.speed;
              prevAir = air;
            },
          );
        });
      }

      it('fuzz: random boxes and ramps in every direction, random inputs - never in solid', () => {
        for (const seed of [1, 2, 3]) {
          const rnd = mulberry32(seed);
          const brushes: Brush[] = [floorBrush(0)];
          for (let i = 0; i < 40; i++) {
            const cx = (rnd() - 0.5) * 3000;
            const cy = (rnd() - 0.5) * 3000;
            if (rnd() < 0.5) {
              const sx = 20 + rnd() * 300;
              const sy = 20 + rnd() * 300;
              const z0 = rnd() < 0.5 ? 0 : rnd() * 300;
              brushes.push(boxBrush(v3(cx, cy, z0), v3(cx + sx, cy + sy, z0 + 10 + rnd() * 300)));
            } else {
              const h = 50 + rnd() * 600;
              const nz = 0.3 + rnd() * 0.65;
              const run = h / Math.tan(Math.acos(nz));
              const z0 = rnd() * 200;
              brushes.push(
                rotatedPrismXZ(
                  rnd() < 0.5
                    ? [
                        [cx, z0],
                        [cx + run, z0],
                        [cx + run, z0 + h],
                      ]
                    : [
                        [cx, z0],
                        [cx + 2 * run, z0],
                        [cx + run, z0 + h],
                      ],
                  cy,
                  cy + 100 + rnd() * 800,
                  rnd() * 360,
                  cx,
                  cy,
                ),
              );
            }
          }
          const w = W.make(brushes);
          const s = new Sim(w, 0.01, v3(0, 0, 1500));
          s.ps.velocity = v3(600, 300, 0);
          let input: Input = {};
          s.run(4000, (i) => {
            if (i % 10 === 0) {
              input = {
                fmove: rnd() < 0.6 ? 450 : 0,
                smove: rnd() < 0.5 ? (rnd() < 0.5 ? 450 : -450) : 0,
                yaw: rnd() * 360,
                buttons: (rnd() < 0.5 ? IN_JUMP : 0) | (rnd() < 0.15 ? IN_DUCK : 0),
              };
            }
            if (i % 700 === 0) {
              // re-launch from the sky now and then
              s.ps.origin = v3((rnd() - 0.5) * 2500, (rnd() - 0.5) * 2500, 1200);
              s.ps.velocity = v3((rnd() - 0.5) * 2000, (rnd() - 0.5) * 2000, 0);
              unstuckPlayer(s.ps, w);
              categorizePosition(s.ps, w, s.vars);
            }
            return input;
          }, () => {
            const o = s.ps.origin;
            expect(Number.isFinite(o.x + o.y + o.z)).toBe(true);
            if (s.inSolid()) throw new Error(`seed ${seed}: in solid at ${o.x} ${o.y} ${o.z} tick ${s.ticks}`);
          });
        }
      });
    });
  });
}

// ------------------------------------------------------------------------------------------ engine-specific behaviour

describe('Source quirks not tied to a world implementation', () => {
  it('CS:GO precision guard: a full sweep that ends in solid is rejected and stops the player', () => {
    const base = new RefWorld([floorBrush(-100000)]);
    // a world whose swept traces never hit but whose unswept test says "stuck" beyond x = 10
    const liar: TraceWorld = {
      traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number, out?: TraceResult): TraceResult {
        const tr = base.traceBox(start, end, mins, maxs, mask, out);
        if (start.x === end.x && start.y === end.y && start.z === end.z && start.x > 10) {
          tr.startsolid = true;
          tr.allsolid = true;
          tr.fraction = 0;
        }
        return tr;
      },
      pointContents: (p, m) => base.pointContents(p, m),
    };
    const ps = createPlayerState(v3(9, 0, 0));
    ps.velocity = v3(500, 0, 0);
    const ev = newMoveEvents();
    playerMove(ps, newUserCmd(), liar, defaultMoveVars(), 0.01, ev);
    expect(ps.origin.x).toBe(9);
    expect(ps.velocity.x).toBe(0);
  });

  for (const W of WORLDS) {
    it(`rampbug fix: a hull embedded by a hair in a ramp keeps sliding instead of stopping dead [${W.name}]`, () => {
      const NZ = 0.5;
      const inner = W.make([surfRamp(0, 0, 4000, NZ, -30000, 30000)]);
      const face = rampFace(0, 0, NZ);
      const start = originAtGap(face.n, face.d, 1500, 0, -0.01); // 0.01 inside the ramp
      // hide the embedding from the tick-start CheckStuck so the slide sweep itself starts allsolid
      const world: TestWorld = {
        traceBox(s: Vec3, e: Vec3, mins: Vec3, maxs: Vec3, mask: number, out?: TraceResult): TraceResult {
          const same = s.x === e.x && s.y === e.y && s.z === e.z;
          const tr = inner.traceBox(s, e, mins, maxs, mask, out);
          if (same && s.x === start.x && s.y === start.y && s.z === start.z) {
            tr.startsolid = false;
            tr.allsolid = false;
            tr.fraction = 1;
          }
          return tr;
        },
        pointContents: (p, m) => inner.pointContents(p, m),
        testBox: (o, mn, mx, m) => inner.testBox(o, mn, mx, m),
      };
      const { movementOptions } = movementModule;
      for (const fix of [false, true]) {
        movementOptions.rampbugFix = fix;
        try {
          const ps = createPlayerState(v3(start.x, start.y, start.z));
          ps.velocity = v3(0, 1000, 0);
          playerMove(ps, newUserCmd(), world, defaultMoveVars(), 0.01, newMoveEvents());
          if (fix) {
            expect(ps.velocity.y).toBeCloseTo(1000, 6);
            expect(ps.origin.y).toBeGreaterThan(start.y + 9);
            expect(inner.testBox(ps.origin, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
            expect(hullGap(ps.origin, face.n, face.d)).toBeLessThan(0.6);
          } else {
            // vanilla Source/CS:GO: allsolid sweep -> velocity zeroed (the rampbug)
            expect(ps.velocity.y).toBe(0);
          }
        } finally {
          movementOptions.rampbugFix = true;
        }
      }
    });
  }

  it('a deeply embedded player stays cheap: the full unstuck search is throttled', () => {
    const inner = new CollisionWorld([boxBrush(v3(-1000, -1000, -1000), v3(1000, 1000, 1000))]);
    let traces = 0;
    const world: TraceWorld = {
      traceBox: (a, b, mn, mx, m, out) => {
        traces++;
        return inner.traceBox(a, b, mn, mx, m, out);
      },
      pointContents: (p, m) => inner.pointContents(p, m),
    };
    const ps = createPlayerState(v3(0, 0, 0));
    const ev = newMoveEvents();
    const cmd = newUserCmd();
    cmd.forwardmove = 450;
    for (let i = 0; i < 330; i++) playerMove(ps, cmd, world, defaultMoveVars(), 0.01, ev);
    // ~11 full searches (one per 33 ticks) instead of one every tick
    expect(traces / 330).toBeLessThan(250);
    expect(Number.isFinite(ps.origin.x)).toBe(true);
  });

  it('a move that leaves an embedding brush within one trace escapes it (startsolid ignores that brush)', () => {
    const w = new RefWorld([floorBrush(-1000), boxBrush(v3(-40, -500, 0), v3(40, 500, 200))]);
    const s = new Sim(w, 0.01, v3(51, 0, 100)); // hull overlaps the box by 5 units: too deep for the nudges
    expect(s.inSolid()).toBe(true);
    s.ps.velocity = v3(1000, 0, 0);
    s.step();
    expect(s.inSolid()).toBe(false);
    expect(s.ps.velocity.x).toBeCloseTo(1000, 6);
    // a slow move that stays inside is trapped (allsolid), exactly like Source
    const t = new Sim(w, 0.01, v3(51, 0, 100));
    t.ps.velocity = v3(100, 0, 0);
    t.step();
    expect(t.ps.velocity.x).toBe(0);
  });

  it('allsolid traces zero the velocity (trapped)', () => {
    const solid = new RefWorld([boxBrush(v3(-1000, -1000, -1000), v3(1000, 1000, 1000))]);
    const ps = createPlayerState(v3(0, 0, 0));
    ps.velocity = v3(300, 0, 0);
    playerMove(ps, newUserCmd(), solid, defaultMoveVars(), 0.01, newMoveEvents());
    expect(ps.velocity.x).toBe(0);
    expect(ps.origin.x).toBe(0);
  });

  it('a slope of normal.z exactly 0.7 is ground', () => {
    const nz = 0.7;
    const w = new RefWorld([surfRamp(0, 0, 1000, nz, -1000, 1000)]);
    const face = rampFace(0, 0, nz);
    const ps = createPlayerState(originAtGap(face.n, face.d, 500, 0, 0.5));
    categorizePosition(ps, w, defaultMoveVars());
    expect(ps.onGround).toBe(true);
    expect(ps.groundNormal.z).toBeCloseTo(0.7, 9);
  });

  it('ladder brushes are not player-solid: falling with no input passes through', () => {
    const w = new RefWorld([floorBrush(0), boxBrush(v3(-100, -100, 100), v3(100, 100, 140), CONTENTS_LADDER)]);
    const s = new Sim(w, 0.01, v3(0, 0, 300));
    s.run(200);
    expect(s.ps.onGround).toBe(true);
    expect(s.ps.origin.z).toBeLessThan(2);
    expect(s.ps.moveType).toBe(MOVETYPE_WALK);
  });

  it('walking into a ladder from any direction grabs it (Source uses the move direction)', () => {
    const w = new RefWorld([floorBrush(0), boxBrush(v3(100, -500, 0), v3(140, 500, 400), CONTENTS_LADDER)]);
    const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
    s.run(200, () => ({ fmove: -450, yaw: 180 }), () => s.ps.moveType !== MOVETYPE_LADDER);
    expect(s.ps.moveType).toBe(MOVETYPE_LADDER);
  });

  it('grabs a ladder volume the hull already overlaps', () => {
    const w = new RefWorld([floorBrush(0), boxBrush(v3(100, -500, 0), v3(104, 500, 400), CONTENTS_LADDER)]);
    // hull front at x = 102: inside the 4-unit ladder slab
    const s = new Sim(w, 0.01, v3(86, 0, 8)).settle();
    s.run(3, () => ({ fmove: 450, yaw: 0 }));
    expect(s.ps.moveType).toBe(MOVETYPE_LADDER);
    s.run(20, () => ({ fmove: 450, yaw: 0 }));
    expect(s.ps.origin.z).toBeGreaterThan(30);
  });

  it('performance: 10k surf ticks on the BVH world', () => {
    const NZ = 0.5;
    const brushes: Brush[] = [floorBrush(0)];
    for (let i = 0; i < 400; i++) brushes.push(boxBrush(v3(-5000 + (i % 20) * 500, -5000 + Math.floor(i / 20) * 500, 0), v3(-4900 + (i % 20) * 500, -4900 + Math.floor(i / 20) * 500, 100)));
    brushes.push(surfRamp(0, 200, 2400, NZ, 0, 200000));
    const w = new CollisionWorld(brushes);
    const face = rampFace(0, 200, NZ);
    const s = new Sim(w as TestWorld, 0.01, originAtGap(face.n, face.d, 1000, 300, 1), 90);
    s.ps.velocity = v3(0, 900, 0);
    const t0 = performance.now();
    s.run(10000, () => ({ smove: 450, yaw: 90 }));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(Number.isFinite(s.ps.origin.y)).toBe(true);
  });

  it('flags mirror state', () => {
    const w = new RefWorld([floorBrush(0)]);
    const s = new Sim(w, 0.01, v3(0, 0, 8)).settle();
    s.step();
    expect(s.ps.flags & FL_ONGROUND).toBe(FL_ONGROUND);
    s.step({ buttons: IN_JUMP });
    expect(s.ps.flags & FL_ONGROUND).toBe(0);
    expect(s.ps.groundModel).toBe(-1);
    void CONTENTS_SOLID;
  });
});
