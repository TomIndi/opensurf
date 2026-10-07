// A scripted surfer that follows a Course: it surfs each ramp the way a player does (look along the ramp,
// tap the strafe key toward the ramp to hold a depth band), steers through the air toward the next ramp
// with plain air strafes, walks out of start/stage rooms and onto end platforms. The tests use it to prove
// every built-in map is completable with the real movement code, triggers and timer.
import { angleDiff, normalizeAngle } from '../../core/angles';
import { Vec3, v3 } from '../../core/vec3';
import { HULL_MAXS, HULL_MINS, PlayerState, UserCmd } from '../../physics/playertypes';
import { MASK_PLAYERSOLID, TraceWorld, newTrace } from '../../physics/types';
import { Course, CourseRamp, rampFrame, rampLength, rampPoint } from './course';

export type PilotMode = 'ground' | 'approach' | 'surf' | 'fly' | 'finish';

export interface PilotEvent {
  kind: 'land' | 'leave';
  /** Index into Autopilot.ramps. */
  ramp: number;
  speed: number;
  origin: Vec3;
  velocity: Vec3;
  time: number;
}

const RAD = 180 / Math.PI;

export class Autopilot {
  /** All course ramps in run order. */
  readonly ramps: (CourseRamp & { section: number })[] = [];
  /** Index of the ramp being surfed or approached. */
  cur = 0;
  /** True once the run left `cur` toward `cur + 1`. */
  leaving = false;
  mode: PilotMode = 'ground';
  holding = false;
  /** Last ramp index a landing was logged for. */
  private landed = -1;
  /** Contact with `cur` during the last think(). */
  contact = false;
  events: PilotEvent[] = [];
  time = 0;
  private readonly tr = newTrace();
  private readonly tmp = v3();

  constructor(
    readonly course: Course,
    readonly world: TraceWorld,
  ) {
    course.sections.forEach((s, si) => {
      for (const r of s.ramps) this.ramps.push({ ...r, section: si });
    });
  }

  /** Restart from the beginning of section `si` (after a fail teleport or a section restart). */
  resetToSection(si: number): void {
    const idx = this.ramps.findIndex((r) => r.section === si);
    this.cur = idx >= 0 ? idx : 0;
    this.landed = -1;
    this.leaving = false;
    this.holding = false;
    this.mode = 'ground';
  }

  /** Landing aim on ramp i. */
  landTarget(i: number): Vec3 {
    const r = this.ramps[i];
    const len = rampLength(r.ramp);
    const along = r.landAt ?? Math.min(len * 0.25, 500);
    return rampPoint(r.ramp, r.face, along, 0.45);
  }

  private touching(i: number, o: Vec3): boolean {
    const r = this.ramps[i];
    if (!r) return false;
    const f = rampFrame(r.ramp, r.face, o);
    if (f.along < -32 || f.along > f.length + 32) return false;
    const n = f.normal;
    const end = this.tmp;
    end.x = o.x - n.x * 3;
    end.y = o.y - n.y * 3;
    end.z = o.z - n.z * 3;
    this.world.traceBox(o, end, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, this.tr);
    if (this.tr.fraction >= 1 || this.tr.startsolid) return false;
    const hn = this.tr.plane.normal;
    return hn.x * n.x + hn.y * n.y + hn.z * n.z > 0.97;
  }

  /** Fills `cmd` (forward/side/buttons/view yaw) for the next tick from the player state. */
  think(ps: PlayerState, cmd: UserCmd, ft: number): void {
    this.time += ft;
    cmd.forwardmove = 0;
    cmd.sidemove = 0;
    cmd.upmove = 0;
    cmd.buttons = 0;
    cmd.viewangles.pitch = 0;
    cmd.viewangles.roll = 0;
    const o = ps.origin;
    const v = ps.velocity;
    const speed = Math.hypot(v.x, v.y);
    const vyaw = Math.atan2(v.y, v.x) * RAD;

    // ---- progress: landed on the next ramp?
    if (this.cur + 1 < this.ramps.length && this.touching(this.cur + 1, o)) {
      this.cur++;
      this.leaving = false;
    }
    const r = this.ramps[this.cur];
    this.contact = this.touching(this.cur, o);
    if (this.contact && this.landed !== this.cur) {
      this.landed = this.cur;
      this.log('land', ps);
    }

    if (ps.onGround) {
      // rooms, platforms, the end: walk toward where we want to go
      const target = this.leaving && this.cur === this.ramps.length - 1 ? this.course.finish : this.leaving ? this.landTarget(this.cur + 1) : this.landTarget(this.cur);
      this.mode = this.leaving && this.cur === this.ramps.length - 1 ? 'finish' : 'ground';
      cmd.viewangles.yaw = Math.atan2(target.y - o.y, target.x - o.x) * RAD;
      cmd.forwardmove = 450;
      return;
    }

    const f = rampFrame(r.ramp, r.face, o);
    const exitAt = r.exitAt ?? f.length;
    if (!this.leaving && f.along >= exitAt) {
      this.leaving = true;
      this.log('leave', ps);
    }

    if (this.contact && !this.leaving) {
      // ---- surf: look along the ramp (following the velocity a little), hold a depth band
      this.mode = 'surf';
      const frac = f.lateral / r.ramp.width;
      const band = r.band ?? [0.3, 0.55];
      if (frac > band[1]) this.holding = true;
      else if (frac < band[0]) this.holding = false;
      const tyaw = Math.atan2(f.tangent.y, f.tangent.x) * RAD;
      const outSign = r.face === 'left' ? 1 : -1;
      let rel = speed > 50 ? angleDiff(vyaw, tyaw) * outSign : 0;
      rel = Math.max(-5, Math.min(30, rel));
      cmd.viewangles.yaw = normalizeAngle(tyaw + rel * outSign);
      cmd.sidemove = this.holding ? (r.face === 'left' ? 450 : -450) : 0;
      return;
    }

    // ---- airborne: steer toward the next landing (or the finish)
    let target: Vec3;
    if (!this.leaving) {
      this.mode = 'approach';
      target = this.landTarget(this.cur);
    } else if (this.cur + 1 < this.ramps.length) {
      this.mode = 'fly';
      target = this.landTarget(this.cur + 1);
    } else {
      this.mode = 'finish';
      target = this.course.finish;
    }
    const want = Math.atan2(target.y - o.y, target.x - o.x) * RAD;
    if (speed < 60) {
      cmd.viewangles.yaw = want;
      cmd.forwardmove = 450;
      return;
    }
    const err = angleDiff(want, vyaw);
    cmd.viewangles.yaw = vyaw;
    if (Math.abs(err) > 1) cmd.sidemove = err > 0 ? -450 : 450;
  }

  private log(kind: 'land' | 'leave', ps: PlayerState): void {
    this.events.push({
      kind,
      ramp: this.cur,
      speed: Math.hypot(ps.velocity.x, ps.velocity.y),
      origin: { ...ps.origin },
      velocity: { ...ps.velocity },
      time: this.time,
    });
  }
}
