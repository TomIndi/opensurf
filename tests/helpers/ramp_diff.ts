// Replay differential + ramp-seam helpers for the opt-in real-map tests (tests/ramp_seams_maps.test.ts).
//
// The differential starts our movement from a KSF world-record replay's state (origin + velocity, standing or
// ducked from IN_DUCK) at frame k and simulates W ticks with the replay's own commands - frame k+1's buttons and
// view angles drive the move from frame k to k+1 (checked: in free flight one simulated tick lands within ~0.0003
// units of the next frame). A STOP is a window where our horizontal speed collapses while the real run keeps its
// speed. Each STOP is classified from the traces of its worst tick: a SEAM stop is a hit on a steep face of a
// brush that also has a face (nearly) coplanar with the surf ramp the player was touching in that tick - the
// next ramp segment's end face - which is never a real obstacle: the real runs slide straight across.
import { readFileSync } from 'node:fs';
import { buildBrushModels, collectCollisionBrushes, createCollisionWorld } from '../../src/bsp/bspcollision';
import { parseEntities } from '../../src/bsp/entities';
import { PakFile } from '../../src/bsp/pakfile';
import { buildPropCollision } from '../../src/bsp/phy';
import { parseBsp } from '../../src/bsp/reader';
import { Vec3, v3 } from '../../src/core/vec3';
import { ParsedKsfReplay } from '../../src/maps/ksfreplay';
import { CollisionWorld } from '../../src/physics/collision';
import { categorizePosition, defaultMoveVars, playerHull, playerMove } from '../../src/physics/movement';
import {
  FL_DUCKING,
  IN_BACK,
  IN_DUCK,
  IN_FORWARD,
  IN_MOVELEFT,
  IN_MOVERIGHT,
  MoveVars,
  PlayerState,
  UserCmd,
  VIEW_OFFSET_DUCK,
  createPlayerState,
  newMoveEvents,
  newUserCmd,
} from '../../src/physics/playertypes';
import { MASK_PLAYERSOLID, TraceResult, TraceWorld, newTrace } from '../../src/physics/types';

/** The map's collision world exactly as loadBspMap builds it (brushes, displacement triangles, prop hulls). */
export function loadCollisionWorld(path: string): CollisionWorld {
  const buf = readFileSync(path);
  const bsp = parseBsp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const entities = parseEntities(bsp.entitiesText);
  const models = buildBrushModels(bsp, { entities });
  const set = collectCollisionBrushes(bsp, entities, models, { displacements: 'triangles' });
  const pc = buildPropCollision(bsp, entities, bsp.pakfile ? [new PakFile(bsp.pakfile)] : [], {});
  for (const b of pc.brushes) set.brushes.push(b);
  return createCollisionWorld(set);
}

export interface TraceRec {
  tick: number;
  fraction: number;
  startsolid: boolean;
  allsolid: boolean;
  normal: [number, number, number];
  dist: number;
  /** CollisionWorld.lastHitBrush (index into world.brushes) */
  brush: number;
}

/** TraceWorld wrapper that records the hits (fraction < 1 or solid) of every trace while `log` is set. */
export class LogWorld implements TraceWorld {
  log: TraceRec[] | null = null;
  tick = 0;
  constructor(readonly w: CollisionWorld) {}
  traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number, out?: TraceResult): TraceResult {
    const tr = this.w.traceBox(start, end, mins, maxs, mask, out);
    if (this.log && (tr.fraction < 1 || tr.startsolid || tr.allsolid)) {
      this.log.push({
        tick: this.tick,
        fraction: tr.fraction,
        startsolid: tr.startsolid,
        allsolid: tr.allsolid,
        normal: [tr.plane.normal.x, tr.plane.normal.y, tr.plane.normal.z],
        dist: tr.plane.dist,
        brush: this.w.lastHitBrush,
      });
    }
    return tr;
  }
  pointContents(p: Vec3, mask?: number): number {
    return this.w.pointContents(p, mask);
  }
}

/** UserCmd of replay frame f: buttons, view angles, +forward/+back/+moveleft/+moveright -> +-450. */
export function cmdFromFrame(rep: ParsedKsfReplay, f: number, cmd: UserCmd = newUserCmd()): UserCmd {
  const b = rep.buttons[f];
  cmd.buttons = b;
  cmd.forwardmove = (b & IN_FORWARD ? 450 : 0) - (b & IN_BACK ? 450 : 0);
  cmd.sidemove = (b & IN_MOVERIGHT ? 450 : 0) - (b & IN_MOVELEFT ? 450 : 0);
  cmd.upmove = 0;
  cmd.viewangles.pitch = rep.angles[f * 3];
  cmd.viewangles.yaw = rep.angles[f * 3 + 1];
  cmd.viewangles.roll = 0;
  return cmd;
}

/** Player state at replay frame k (categorized like after a teleport). */
export function stateFromFrame(rep: ParsedKsfReplay, k: number, world: TraceWorld, vars: MoveVars): PlayerState {
  const o = rep.origins;
  const v = rep.velocities;
  const ps = createPlayerState(v3(o[k * 3], o[k * 3 + 1], o[k * 3 + 2]));
  ps.velocity.x = v[k * 3];
  ps.velocity.y = v[k * 3 + 1];
  ps.velocity.z = v[k * 3 + 2];
  if (rep.buttons[k] & IN_DUCK) {
    ps.ducked = true;
    ps.duckAmount = 1;
    ps.flags |= FL_DUCKING;
    ps.viewOffsetZ = VIEW_OFFSET_DUCK;
  }
  ps.oldButtons = k > 0 ? rep.buttons[k - 1] : 0;
  categorizePosition(ps, world, vars);
  return ps;
}

const stuckTr = newTrace();
export function hullStuck(ps: PlayerState, world: TraceWorld): boolean {
  const h = playerHull(ps);
  const r = world.traceBox(ps.origin, ps.origin, h.mins, h.maxs, MASK_PLAYERSOLID, stuckTr);
  return r.startsolid || r.allsolid || r.fraction < 1;
}

export interface Window {
  /** our horizontal speed per tick (0 = start) */
  ours: Float64Array;
  /** the replay's horizontal speed at the same frames */
  theirs: Float64Array;
  startStuck: boolean;
  end: [number, number, number];
}

const cmd = newUserCmd();
const ev = newMoveEvents();

/** W ticks from replay frame k at `dt` (default: the replay's tick interval). */
export function simWindow(world: TraceWorld, rep: ParsedKsfReplay, k: number, W: number, dt = rep.tickInterval, log?: LogWorld): Window {
  const vars = defaultMoveVars();
  const ps = stateFromFrame(rep, k, world, vars);
  const ours = new Float64Array(W + 1);
  const theirs = new Float64Array(W + 1);
  ours[0] = Math.hypot(ps.velocity.x, ps.velocity.y);
  theirs[0] = Math.hypot(rep.velocities[k * 3], rep.velocities[k * 3 + 1]);
  const startStuck = hullStuck(ps, world);
  const ratio = dt / rep.tickInterval;
  const last = rep.frameCount - 1;
  for (let i = 0; i < W; i++) {
    if (log) log.tick = i;
    cmdFromFrame(rep, Math.min(last, k + Math.round(i * ratio) + 1), cmd);
    playerMove(ps, cmd, log ?? world, vars, dt, ev);
    ours[i + 1] = Math.hypot(ps.velocity.x, ps.velocity.y);
    const rf = Math.min(last, k + Math.round((i + 1) * ratio));
    theirs[i + 1] = Math.hypot(rep.velocities[rf * 3], rep.velocities[rf * 3 + 1]);
  }
  return { ours, theirs, startStuck, end: [ps.origin.x, ps.origin.y, ps.origin.z] };
}

export interface StopClass {
  kind: 'seam' | 'other' | 'none';
  ramp?: { n: [number, number, number]; d: number; brush: number };
  block?: { n: [number, number, number]; d: number; brush: number; fraction: number };
  /** seam: the blocking brush's face coplanar with the ramp; offset = its dist - the ramp's (+ = proud) */
  match?: { d: number; offset: number };
}

/** Classifies the traces of a stop tick (see the file comment). */
export function classifyStop(traces: TraceRec[], world: CollisionWorld): StopClass {
  const hits = traces.filter((t) => t.fraction < 1 && !t.allsolid && t.brush >= 0);
  if (!hits.length) return { kind: 'none' };
  const isRamp = (n: [number, number, number]) => n[2] > 0.05 && n[2] < 0.7;
  const ramps = hits.filter((t) => isRamp(t.normal));
  const blocks = hits.filter((t) => Math.abs(t.normal[2]) < 0.7 && !ramps.some((r) => r.brush === t.brush && r.dist === t.dist));
  for (const b of blocks) {
    for (const r of ramps) {
      for (const s of world.brushes[b.brush].sides) {
        const n = s.plane.normal;
        if (n.x * r.normal[0] + n.y * r.normal[1] + n.z * r.normal[2] < 0.99999) continue;
        const off = s.plane.dist - r.dist;
        if (Math.abs(off) <= 0.0625) {
          return {
            kind: 'seam',
            ramp: { n: r.normal, d: r.dist, brush: r.brush },
            block: { n: b.normal, d: b.dist, brush: b.brush, fraction: b.fraction },
            match: { d: s.plane.dist, offset: off },
          };
        }
      }
    }
  }
  const b = blocks[0] ?? hits[hits.length - 1];
  return { kind: 'other', block: { n: b.normal, d: b.dist, brush: b.brush, fraction: b.fraction } };
}

export interface Stop {
  file: string;
  k: number;
  pos: [number, number, number];
  h0: number;
  ourMin: number;
  repMin: number;
  stopTick: number;
  cls: StopClass;
}

/**
 * Runs the differential over a replay's whole run (frames startFrame .. endFrame - W) and returns the STOP
 * windows: our horizontal speed falls below 60% of the start (or 300 u/s) while the replay stays above 80% (and
 * 300 u/s). Windows that start inside solid (hull differences) are skipped.
 */
export function replayStops(world: CollisionWorld, rep: ParsedKsfReplay, file: string, W = 30, stride = 1, dt = rep.tickInterval): { windows: number; stops: Stop[] } {
  const stops: Stop[] = [];
  const lw = new LogWorld(world);
  const ratio = dt / rep.tickInterval;
  const lastK = rep.endFrame - Math.ceil(W * ratio) - 2;
  let windows = 0;
  for (let k = rep.startFrame; k <= lastK; k += stride) {
    windows++;
    const r = simWindow(world, rep, k, W, dt);
    if (r.startStuck) continue;
    const h0 = r.ours[0];
    let ourMin = Infinity;
    let repMin = Infinity;
    for (let i = 1; i <= W; i++) {
      ourMin = Math.min(ourMin, r.ours[i]);
      repMin = Math.min(repMin, r.theirs[i]);
    }
    if (!(h0 > 200 && (ourMin < 0.6 * h0 || ourMin < 300) && repMin > 0.8 * h0 && repMin > 300)) continue;
    let stopTick = 0;
    let worst = -Infinity;
    for (let i = 0; i < W; i++) {
      const d = r.ours[i] - r.ours[i + 1] - Math.max(0, r.theirs[i] - r.theirs[i + 1]);
      if (d > worst) {
        worst = d;
        stopTick = i;
      }
    }
    lw.log = [];
    simWindow(world, rep, k, W, dt, lw);
    const cls = classifyStop(
      lw.log.filter((t) => t.tick === stopTick),
      world,
    );
    lw.log = null;
    const o = rep.origins;
    stops.push({ file, k, pos: [o[k * 3], o[k * 3 + 1], o[k * 3 + 2]], h0, ourMin, repMin, stopTick, cls });
  }
  return { windows, stops };
}

export type V3 = [number, number, number];

export interface SeamRunParams {
  /** ramp plane the player surfs */
  n: V3;
  d: number;
  /** contact corner of the hull on the ramp where the run starts */
  corner: V3;
  /** horizontal travel direction (unit) */
  dir: [number, number];
  speed: number;
  /** degrees off `dir` (rotated about the ramp normal's vertical) */
  yaw: number;
  /** height of the contact corner above the plane and the velocity component along the normal at the start */
  h: number;
  vn: number;
  /**
   * The start state of a tick while sliding on the ramp: the last move clipped the velocity parallel to the ramp
   * and FinishGravity then took half a tick of gravity off v.z (Source splits gravity around the move). Without it
   * (vn 0) the state is a teleport's: only half a tick of gravity reaches the first move, at 100 tick that is 0.025
   * units towards the ramp - less than the DIST_EPSILON hover - so the hull ends inside the epsilon shell (as in
   * Source: a move that stops short of a face is no hit), a state sliding never produces.
   */
  slide?: boolean;
  key: 'into' | 'none' | 'away' | 'fwd';
  dt: number;
  ticks: number;
}

/**
 * Surfs a ramp from a start state and returns the tick of the first one-tick collapse of the horizontal speed
 * (>= 35%) and the traces of that tick, or null when the speed holds for `ticks` ticks.
 */
export function surfRun(world: TraceWorld, p: SeamRunParams, lw?: LogWorld): { tick: number; pos: V3 } | null {
  const vars = defaultMoveVars();
  const [nx, ny, nz] = p.n;
  // hull corner touching the plane, relative to the feet origin
  const off: V3 = [nx > 0 ? -16 : 16, ny > 0 ? -16 : 16, 0];
  const ps = createPlayerState(v3(p.corner[0] - off[0] + nx * p.h, p.corner[1] - off[1] + ny * p.h, p.corner[2] + nz * p.h));
  const ya = (p.yaw * Math.PI) / 180;
  const hx = p.dir[0] * Math.cos(ya) - p.dir[1] * Math.sin(ya);
  const hy = p.dir[0] * Math.sin(ya) + p.dir[1] * Math.cos(ya);
  const vx = p.speed * hx;
  const vy = p.speed * hy;
  const vz = -(nx * vx + ny * vy) / nz;
  ps.velocity.x = vx + nx * p.vn;
  ps.velocity.y = vy + ny * p.vn;
  ps.velocity.z = vz + nz * p.vn;
  if (p.slide) ps.velocity.z -= 0.5 * vars.gravity * p.dt;
  const yawDeg = (Math.atan2(p.dir[1], p.dir[0]) * 180) / Math.PI;
  if (lw) lw.tick = -1;
  categorizePosition(ps, lw ?? world, vars);
  const right = [Math.sin((yawDeg * Math.PI) / 180), -Math.cos((yawDeg * Math.PI) / 180)];
  const intoIsRight = right[0] * -nx + right[1] * -ny > 0;
  const c = newUserCmd();
  if (p.key === 'into' || p.key === 'away') {
    const r = (p.key === 'into') === intoIsRight;
    c.buttons = r ? IN_MOVERIGHT : IN_MOVELEFT;
    c.sidemove = r ? 450 : -450;
  } else if (p.key === 'fwd') {
    c.buttons = IN_FORWARD;
    c.forwardmove = 450;
  }
  c.viewangles.pitch = 10;
  c.viewangles.yaw = yawDeg + p.yaw;
  const e = newMoveEvents();
  let prev = Math.hypot(ps.velocity.x, ps.velocity.y);
  for (let t = 0; t < p.ticks; t++) {
    if (lw) lw.tick = t;
    playerMove(ps, c, lw ?? world, vars, p.dt, e);
    const hs = Math.hypot(ps.velocity.x, ps.velocity.y);
    if (prev > 100 && hs < prev * 0.65) return { tick: t, pos: [ps.origin.x, ps.origin.y, ps.origin.z] };
    prev = hs;
  }
  return null;
}
