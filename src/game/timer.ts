// The surf timer, modelled on SurfTimer/KSF servers.
//
// Zones are axis-aligned boxes touched by the player hull (like SurfTimer's zone triggers). Per course
// (group 0 = main, N = bonus N):
//  - start/speedstart: standing in it = "start zone" (clock at 0). Leaving it starts the run; horizontal
//    speed is capped to the zone's prespeed (or surf_prespeed) at that moment.
//  - stage N (staged maps): reaching it records a split vs the PB ("[Surf] Stage 3 | 00:42.123 (-0.231)").
//    !s N is SurfTimer's stage practice: the clock shows 0 while in stage N's zone, starts when leaving it, and
//    reaching stage N+1 (or the end after the last stage) reports "Stage N | 00:12.345 (PB -0.120)"; the best
//    time of every stage (stage practice or ranked runs) is kept per tickrate.
//  - checkpoint N (linear maps): same, "CP N".
//  - end: finishes the run, saves the record (unless practice/custom physics), PB messages and sounds.
//  - stop: stops the clock. teletostart: back to the course start. validator/checker: a checker sends the
//    player back to the stage start unless a validator was touched first this run. antijump/antiduck: strip
//    +jump/+duck (filterButtons). maxspeed: caps horizontal speed inside.
//
// Integration (game core):
//  - every tick after entities.tick(): timer.tick();
//  - before building/applying the usercmd: cmd.buttons = timer.filterButtons(cmd.buttons) and
//    timer.recordInput(...) for strafe stats;
//  - replays: either timer.setReplay(replaySystem) (the timer then begins/ends/cancels recordings itself; the
//    core only calls replay.recordTick each tick), or use the onRunStart / onRunFinish / onRunCancel callbacks.
//  - TimerHud.lastSplitTime is on the run clock (compare with TimerHud.time to show a split for a few seconds).
//  - host.killPlayer(reason) (trigger_hurt) should end in timer.onPlayerKilled().
//  - extras: gotoEnd() (!end), getStageSpawn(), currentGroup, timerState, invalidateRecords() (after records
//    were cleared/imported elsewhere), dispose() on map unload. SurfTimer servers spawn joining players in
//    the start zone: call restart(0) after setZones() on map load.
import { QAngle, qa } from '../core/angles';
import { console_ } from '../core/cvars';
import { Vec3, v3, v3clone } from '../core/vec3';
import { MapEntity, ZoneDef, ZoneSource } from '../map/types';
import { getCatalogEntry } from '../maps/catalog';
import { boxIntersectsBrush } from '../physics/collision';
import { playerHull } from '../physics/movement';
import {
  FL_BASEVELOCITY,
  HULL_MAXS,
  HULL_MINS,
  IN_DUCK,
  IN_JUMP,
  MOVETYPE_NOCLIP,
  MOVETYPE_OBSERVER,
  MOVETYPE_WALK,
} from '../physics/playertypes';
import { MASK_PLAYERSOLID, newTrace } from '../physics/types';
import { ChatColor, ChatSegment, SoundName, TimerHud, TimerState } from './api';
import { IReplaySystem, ISurfTimer, RunRecord, TimerHost } from './contracts';
import type { MapTeleportEvent } from './entities';
import { addRecord, addStageTime, getPersonalBest, getRecords, tickLabel } from './records';

// ------------------------------------------------------------------------------------------ formatting

function pad(n: number, w: number): string {
  const s = String(n);
  return s.length >= w ? s : '0'.repeat(w - s.length) + s;
}

/** Run clock with milliseconds, truncated like a stopwatch: "00:42.123", "1:02:03.456". */
export function formatRunTime(t: number): string {
  const ms = Number.isFinite(t) && t > 0 ? Math.floor(t * 1000 + 1e-6) : 0;
  const msPart = ms % 1000;
  const totalSec = (ms - msPart) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  return `${h > 0 ? `${h}:${pad(m, 2)}` : pad(m, 2)}:${pad(s, 2)}.${pad(msPart, 3)}`;
}

/** Split delta: "-0.231", "+1.234", "+1:02.345". */
export function formatSplitDelta(d: number): string {
  const sign = d < 0 ? '-' : '+';
  const ms = Math.floor(Math.abs(d) * 1000 + 1e-6);
  const msPart = ms % 1000;
  const totalSec = (ms - msPart) / 1000;
  if (totalSec < 60) return `${sign}${totalSec}.${pad(msPart, 3)}`;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  if (totalMin < 60) return `${sign}${totalMin}:${pad(s, 2)}.${pad(msPart, 3)}`;
  const m = totalMin % 60;
  return `${sign}${(totalMin - m) / 60}:${pad(m, 2)}:${pad(s, 2)}.${pad(msPart, 3)}`;
}

const PREFIX: readonly ChatSegment[] = Object.freeze([
  { text: '[', color: 'grey' },
  { text: 'Surf', color: 'lightblue' },
  { text: '] ', color: 'grey' },
]);

function deltaColor(d: number): ChatColor {
  return d < -0.0005 ? 'lightgreen' : d > 0.0005 ? 'lightred' : 'grey';
}

// ------------------------------------------------------------------------------------------ helpers

function isStartType(z: ZoneDef): boolean {
  return z.type === 'start' || z.type === 'speedstart';
}

function cvarNum(name: string, fallback: number): number {
  const c = console_.getCvar(name);
  return c ? c.num : fallback;
}

interface ZoneRt {
  def: ZoneDef;
  inside: boolean;
}

/** Duck-typed extras of game/entities.ts EntitySystem (the contract only guarantees IEntitySystem). */
interface EntityExtras {
  resetPlayerState?: () => void;
  addTeleportListener?: (cb: (ev: MapTeleportEvent) => void) => () => void;
}

export interface RunFinishEvent {
  group: number;
  time: number;
  /** Saved to the records (not practice, not custom physics). */
  ranked: boolean;
  isPb: boolean;
  /** 1-based rank among completions (0 = unknown / not ranked). */
  rank: number;
  total: number;
  record: RunRecord | null;
}

interface Spawn {
  origin: Vec3;
  angles: QAngle;
}

/** A map destination players are teleported to, and how many trigger_teleports aim at it. */
interface SpawnDest {
  origin: Vec3;
  yaw: number;
  refs: number;
  index: number;
}

/** Map destinations up to this far outside a zone's footprint count for its spawn (ing's start2: 110 units). */
const DEST_XY_PAD = 256;
/** ... and up to this far above its top (lt_omnific's stage 10 start hovers 124 units over the zone). */
const DEST_ABOVE = 512;
/** A destination this close to a spawn point gives its yaw (CS spawn rows face each other, not the course). */
const SPAWN_YAW_RADIUS = 1024;

// ------------------------------------------------------------------------------------------ the timer

export class SurfTimer implements ISurfTimer {
  readonly host: TimerHost;
  /** Called when a run starts (the player left the start zone). */
  onRunStart: ((group: number, practice: boolean) => void) | null = null;
  /** Called when a run reaches the end zone (after records are saved). */
  onRunFinish: ((ev: RunFinishEvent) => void) | null = null;
  /** Called when a run in progress is abandoned (restart, re-entering the start, stop zone, practice). */
  onRunCancel: (() => void) | null = null;

  private zones: ZoneRt[] = [];
  private zoneDefs: ZoneDef[] = [];
  private _zoneSource: ZoneSource = 'none';
  private replay: IReplaySystem | null = null;

  private state: TimerState = 'disabled';
  private group = 0;
  private practice = false;
  private runTicks = 0;
  /**
   * Seconds on the run clock: the simulated time of the run's ticks, each counted at the tick interval in force
   * when it ran, so a tickrate change mid-run never rescales the time already run (the HUD can't jump). While the
   * tickrate stays the same it is exactly clockBase + (runTicks - clockBaseTicks) * clockInterval (no float drift).
   */
  private runTime = 0;
  private clockBase = 0;
  private clockBaseTicks = 0;
  private clockInterval = 0;
  private finishedTime = 0;
  private stage = 0;
  private stageStartTicks = 0;
  /** runTime when the current stage started. */
  private stageStartTime = 0;
  private checkpoint = 0;
  private stageSplits: number[] = [];
  private checkpointSplits: number[] = [];
  private lastSplitDelta: number | null = null;
  private lastSplitTime = 0;
  private validated = false;
  private recording = false;
  /** Finished, then entered the start zone: leaving it starts the next run. */
  private finishedInStart = false;
  /** Why practice mode is on ('!prac', 'noclip', 'saveloc', 'stage' ...). */
  private practiceReason = '';
  /**
   * !s N stage practice: the stage being timed; `armed` while the player is still in its start zone (the clock
   * shows 0 and starts on leaving it).
   */
  private stagePrac: { stage: number; armed: boolean } | null = null;

  // stats
  private jumps = 0;
  private strafes = 0;
  private lastStrafeSign = 0;
  private syncGood = 0;
  private syncTotal = 0;
  private speedSum = 0;
  private speedTicks = 0;
  private maxSpeed = 0;

  // zone effects
  private inAntiJump = false;
  private inAntiDuck = false;
  /** Bumped by every timer teleport: zone processing stops when it changes mid-pass. */
  private teleportGen = 0;

  // caches
  private readonly spawnCache = new Map<string, Spawn>();
  private destCache: MapEntity[] | null = null;
  private spawnDestCache: SpawnDest[] | null = null;
  /** Personal bests by `${group}|${tick}`. */
  private pbCache = new Map<string, RunRecord | null>();

  // heuristic stages (staged maps without stage zones)
  private heuristicStages = false;
  private seenDest = new Set<number>();
  private startDest = new Set<number>();
  private stageDest = new Map<number, Spawn>();
  private unsubscribeTeleports: (() => void) | null = null;
  private disposed = false;

  private readonly boxMins = v3();
  private readonly boxMaxs = v3();

  constructor(host: TimerHost) {
    this.host = host;
    this.subscribe();
  }

  /** Listens to map teleports (stage heuristics) once host.entities exists. */
  private subscribe(): void {
    if (this.unsubscribeTeleports || this.disposed) return;
    const ents = this.host.entities as unknown as EntityExtras | undefined;
    if (ents && typeof ents.addTeleportListener === 'function') {
      this.unsubscribeTeleports = ents.addTeleportListener((ev) => this.onMapTeleport(ev));
    }
  }

  /** Stop listening to the entity system (map unload). */
  dispose(): void {
    this.disposed = true;
    this.unsubscribeTeleports?.();
    this.unsubscribeTeleports = null;
  }

  /** Forget cached personal bests (call after records were cleared/imported elsewhere). */
  invalidateRecords(): void {
    this.pbCache.clear();
  }

  // ---------------------------------------------------------------- zones

  get zoneSource(): ZoneSource {
    return this._zoneSource;
  }

  setZones(zones: ZoneDef[], source: ZoneSource): void {
    this.subscribe();
    this.cancelRecording();
    this.zoneDefs = zones.map((z) => ({ ...z, mins: v3clone(z.mins), maxs: v3clone(z.maxs) }));
    this.zones = this.zoneDefs.map((def) => ({ def, inside: false }));
    this._zoneSource = zones.length ? source : 'none';
    this.spawnCache.clear();
    this.pbCache.clear();
    this.resetRunData();
    this.practice = false;
    this.lastSplitDelta = null;
    // heuristic stage counting for staged maps whose zones have no stages
    const type = getCatalogEntry(this.host.map.name)?.type ?? null;
    this.heuristicStages = (type === 'staged' || type === 'staged-linear') && !this.zoneDefs.some((z) => z.type === 'stage' && z.group === 0);
    this.startDest = new Set();
    for (const z of this.zoneDefs) {
      if (!isStartType(z) || z.group !== 0) continue;
      for (const e of this.teleportTargets()) if (nearZone(e.origin, z, 64, 64, 512)) this.startDest.add(e.index);
    }
    this.recomputeInside();
    const start = this.zones.find((z) => z.inside && isStartType(z.def));
    if (!this.zoneDefs.some(isStartType)) this.state = 'disabled';
    else if (start) {
      this.group = start.def.group;
      this.state = 'startzone';
    } else this.state = 'stopped';
  }

  getZones(): ZoneDef[] {
    return this.zoneDefs.map((z) => ({ ...z, mins: v3clone(z.mins), maxs: v3clone(z.maxs) }));
  }

  /** Attach the replay system: recordings then begin/end/cancel automatically with runs. */
  setReplay(replay: IReplaySystem | null): void {
    this.cancelRecording();
    this.replay = replay;
  }

  // ---------------------------------------------------------------- per tick

  tick(): void {
    if ((this.state === 'running' || this.state === 'practice') && !this.stagePrac?.armed) this.advanceRunClock();
    if (!this.zones.length) return;
    const ps = this.host.player;
    this.updateBox();
    const gen = this.teleportGen;
    // leaves first (leaving the start zone into an adjacent stage zone must start the run first)
    for (const z of this.zones) {
      if (z.inside && !this.overlaps(z.def)) {
        z.inside = false;
        this.onLeave(z.def);
        if (this.teleportGen !== gen) return;
      }
    }
    for (const z of this.zones) {
      if (!z.inside && this.overlaps(z.def)) {
        z.inside = true;
        this.onEnter(z.def);
        if (this.teleportGen !== gen) return;
      }
    }
    // in a start zone without having "entered" it (noclip turned off inside it, a saveloc teleport into it):
    // standing in a start zone always means "start zone" (SurfTimer never runs the clock there)
    this.checkInStart();
    // continuous zone effects
    this.inAntiJump = false;
    this.inAntiDuck = false;
    for (const z of this.zones) {
      if (!z.inside) continue;
      const t = z.def.type;
      if (t === 'antijump') this.inAntiJump = true;
      else if (t === 'antiduck') this.inAntiDuck = true;
      else if (t === 'maxspeed') this.capSpeed(z.def.prespeed !== undefined ? z.def.prespeed : cvarNum('surf_prespeed', 350));
    }
    if (this.inRun()) {
      const sp = Math.sqrt(ps.velocity.x * ps.velocity.x + ps.velocity.y * ps.velocity.y);
      this.speedSum += sp;
      this.speedTicks++;
      if (sp > this.maxSpeed) this.maxSpeed = sp;
    }
  }

  /**
   * Removes buttons blocked by the zone the player is in (antijump: +jump, antiduck: +duck). Call on the
   * usercmd before playerMove.
   */
  filterButtons(buttons: number): number {
    if (this.inAntiJump) buttons &= ~IN_JUMP;
    if (this.inAntiDuck) buttons &= ~IN_DUCK;
    return buttons;
  }

  recordInput(sidemove: number, _forwardmove: number, yawDelta: number, onGround: boolean, jumped: boolean): void {
    if (!this.inRun()) return;
    if (jumped) this.jumps++;
    if (onGround) return;
    const sign = sidemove > 0 ? 1 : sidemove < 0 ? -1 : 0;
    if (sign !== 0 && sign !== this.lastStrafeSign) {
      this.strafes++;
      this.lastStrafeSign = sign;
    }
    if (yawDelta !== 0 && Number.isFinite(yawDelta)) {
      this.syncTotal++;
      // yaw grows turning left; sidemove < 0 is a left strafe
      if ((yawDelta > 0 && sidemove < 0) || (yawDelta < 0 && sidemove > 0)) this.syncGood++;
    }
  }

  getStats(): { jumps: number; strafes: number; sync: number } {
    return { jumps: this.jumps, strafes: this.strafes, sync: this.syncTotal ? (this.syncGood / this.syncTotal) * 100 : 0 };
  }

  // ---------------------------------------------------------------- commands

  get inPractice(): boolean {
    return this.practice;
  }

  /** Current course (0 = main, N = bonus N). */
  get currentGroup(): number {
    return this.group;
  }

  /** Current timer state (also in getHud()). */
  get timerState(): TimerState {
    return this.state;
  }

  restart(group = 0): void {
    const g = group | 0;
    if (g !== 0 && !this.zoneDefs.some((z) => isStartType(z) && z.group === g)) {
      this.chat([{ text: `Bonus ${g} doesn't exist on this map.`, color: 'lightred' }]);
      return;
    }
    const sp = this.getStartSpawn(g);
    this.cancelRecording();
    this.resetPlayerModifiers();
    this.teleport(sp.origin, sp.angles);
    this.group = g;
    this.practice = false;
    this.practiceReason = '';
    this.stagePrac = null;
    this.resetRunData();
    this.lastSplitDelta = null;
    this.pbCache.clear();
    if (!this.zoneDefs.some(isStartType)) {
      this.state = 'disabled';
      return;
    }
    this.state = this.zones.some((z) => z.inside && isStartType(z.def) && z.def.group === g) ? 'startzone' : 'stopped';
  }

  restartStage(): void {
    if (!this.inRun() || !this.isStagedGroup(this.group) || this.stage <= 1) {
      this.restart(this.group);
      return;
    }
    const sp = this.getStageSpawn(this.group, this.stage);
    if (!sp) {
      this.restart(this.group);
      return;
    }
    const ps = this.host.player;
    ps.baseVelocity.x = ps.baseVelocity.y = ps.baseVelocity.z = 0;
    ps.flags &= ~FL_BASEVELOCITY;
    this.teleport(sp.origin, sp.angles);
    this.markStageStart();
    if (this.stagePrac) this.armStagePractice(this.stage);
  }

  gotoStage(stage: number): void {
    const n = stage | 0;
    if (n <= 1) {
      this.restart(this.group);
      return;
    }
    if (!this.isStagedGroup(this.group)) {
      this.chat([{ text: 'This course has no stages.', color: 'lightred' }]);
      return;
    }
    const sp = this.getStageSpawn(this.group, n);
    if (!sp) {
      this.chat([{ text: `Stage ${n} doesn't exist.`, color: 'lightred' }]);
      return;
    }
    this.cancelRecording();
    this.resetPlayerModifiers();
    this.teleport(sp.origin, sp.angles);
    this.resetRunData();
    this.practice = true;
    this.practiceReason = 'stage';
    this.state = 'practice';
    this.stage = n;
    // SurfTimer stage practice: the stage is timed from leaving its zone to reaching the next stage
    this.stagePrac = { stage: n, armed: false };
    this.armStagePractice(n);
    this.chat([
      { text: `Stage ${n}`, color: 'lightblue' },
      { text: ' (practice: the stage time starts when you leave the zone; !r restarts the run)', color: 'grey' },
    ]);
  }

  /** (Re)starts stage practice at stage n: clock at 0, waiting in the stage's zone (or running if not in it). */
  private armStagePractice(n: number): void {
    if (!this.stagePrac) return;
    this.stagePrac.stage = n;
    this.stage = n;
    this.stagePrac.armed = this.zones.some((z) => z.inside && z.def.type === 'stage' && z.def.group === this.group && z.def.index === n);
    this.resetRunClock();
  }

  /** !stop: stops the clock of the run in progress (SurfTimer sm_stop). False when nothing was running. */
  stopTimer(): boolean {
    if (!this.inRun()) return false;
    this.cancelRecording();
    this.stagePrac = null;
    this.state = 'stopped';
    this.chat([{ text: 'Timer stopped.', color: 'lightred' }]);
    return true;
  }

  /** !end: practice teleport to the course's end zone (floor under its center). False if there is none. */
  gotoEnd(group = this.group): boolean {
    const z = this.zoneDefs.find((d) => d.type === 'end' && d.group === (group | 0));
    if (!z) {
      this.chat([{ text: 'This course has no end zone.', color: 'lightred' }]);
      return false;
    }
    const sp = this.spawnForZone(z);
    this.cancelRecording();
    this.teleport(sp.origin, sp.angles);
    this.group = group | 0;
    this.practice = true;
    this.practiceReason = 'end';
    this.stagePrac = null;
    this.resetRunData();
    this.state = 'stopped';
    this.chat([{ text: 'Teleported to the end', color: 'lightblue' }, { text: ' (practice — type !r to restart)', color: 'grey' }]);
    return true;
  }

  onPlayerKilled(): void {
    if (this.inRun() && this.isStagedGroup(this.group) && this.stage > 1) this.restartStage();
    else this.restart(this.group);
  }

  enterPractice(reason: string): void {
    const wasRunning = this.state === 'running';
    this.practiceReason = reason;
    // stage practice ends: the clock goes on as a plain practice clock
    if (this.stagePrac) {
      this.stagePrac = null;
      this.state = 'practice';
    }
    if (!this.practice) {
      this.chat([
        { text: 'Practice mode', color: 'orange' },
        { text: reason ? ` (${reason})` : '', color: 'grey' },
        { text: ': runs are not saved. Type ', color: 'default' },
        { text: '!r', color: 'lightblue' },
        { text: ' to restart.', color: 'default' },
      ]);
    }
    this.practice = true;
    if (wasRunning) {
      this.state = 'practice';
      this.cancelRecording();
    }
  }

  // ---------------------------------------------------------------- HUD / records

  getHud(): TimerHud {
    const staged = this.isStagedGroup(this.group);
    const inRun = this.inRun();
    const pb = this.personalBest(this.group);
    return {
      state: this.state,
      time: this.currentTime(),
      stage: staged ? Math.max(1, this.stage) : 0,
      stageCount: staged ? this.stageCount(this.group) : 0,
      stageTime: inRun && staged ? Math.max(0, this.runTime - this.stageStartTime) : 0,
      checkpoint: staged ? 0 : this.checkpoint,
      checkpointCount: staged ? 0 : this.checkpointCount(this.group),
      bonus: this.group,
      pb: pb ? pb.time : null,
      wr: pb ? pb.time : null,
      mapType: staged ? 'staged' : 'linear',
      lastSplitDelta: this.lastSplitDelta,
      lastSplitTime: this.lastSplitTime,
    };
  }

  /** Records of the course at the tickrate being played (CS:GO leaderboards are per tickrate). */
  getRecords(group: number): RunRecord[] {
    return getRecords(this.host.map.name, group, this.tickrate());
  }

  /** Ticks per second of the simulation (records, replays and stage bests are kept per tickrate). */
  tickrate(): number {
    const ti = this.host.tickInterval;
    return ti > 0 ? 1 / ti : 100;
  }

  getStartSpawn(group: number): { origin: Vec3; angles: QAngle } {
    const key = `start:${group | 0}`;
    let sp = this.spawnCache.get(key);
    if (!sp) {
      sp = this.computeStartSpawn(group | 0);
      this.spawnCache.set(key, sp);
    }
    return { origin: v3clone(sp.origin), angles: { ...sp.angles } };
  }

  /** Where !back / !s N put the player for a stage (null if the stage doesn't exist). */
  getStageSpawn(group: number, stage: number): { origin: Vec3; angles: QAngle } | null {
    if (stage <= 1) return this.getStartSpawn(group);
    const hs = this.heuristicStages && group === 0 ? this.stageDest.get(stage) : undefined;
    if (hs) return { origin: v3clone(hs.origin), angles: { ...hs.angles } };
    const key = `stage:${group}:${stage}`;
    let sp = this.spawnCache.get(key);
    if (!sp) {
      const z = this.zoneDefs.find((d) => d.type === 'stage' && d.group === group && d.index === stage);
      if (!z) return null;
      sp = this.spawnForZone(z);
      this.spawnCache.set(key, sp);
    }
    return { origin: v3clone(sp.origin), angles: { ...sp.angles } };
  }

  // ---------------------------------------------------------------- zone events

  private onEnter(z: ZoneDef): void {
    switch (z.type) {
      case 'start':
      case 'speedstart':
        this.enterStart(z);
        return;
      case 'end':
        if (z.group === this.group && this.inRun()) {
          if (this.stagePrac) this.stagePracticeEnd();
          else this.finish();
        }
        return;
      case 'stage':
        if (z.group === this.group && this.inRun() && this.isStagedGroup(this.group)) {
          if (this.stagePrac) this.stagePracticeEnter(z.index);
          else if (z.index > this.stage) this.reachStage(z.index);
          else if (z.index === this.stage) this.markStageStart();
        }
        return;
      case 'checkpoint':
        if (z.group === this.group && this.inRun() && z.index > this.checkpoint) this.reachCheckpoint(z.index);
        return;
      case 'stop':
        // like teletostart, not course-specific: stops whatever run is in progress
        if (this.inRun()) {
          this.cancelRecording();
          this.state = 'stopped';
          this.chat([{ text: 'Timer stopped.', color: 'lightred' }]);
        }
        return;
      case 'teletostart':
        if (!this.noclip()) this.restart(this.group);
        return;
      case 'validator':
        if (z.group === this.group) this.validated = true;
        return;
      case 'checker':
        if (z.group === this.group && !this.validated && !this.noclip()) this.restartStage();
        return;
      default:
        return;
    }
  }

  private onLeave(z: ZoneDef): void {
    if (isStartType(z)) {
      const armed = this.state === 'startzone' || (this.state === 'finished' && this.finishedInStart);
      if (z.group === this.group && armed && !this.insideStart(this.group)) this.startRun(z);
    } else if (z.type === 'stage' && z.group === this.group && this.inRun()) {
      const sp = this.stagePrac;
      if (sp) {
        // stage practice: the stage clock starts when leaving the stage's zone (prespeed capped like a start)
        if (z.index === sp.stage && sp.armed && !this.insideStage(z.group, z.index)) {
          sp.armed = false;
          this.resetRunClock();
          if (!this.noclip()) this.capSpeed(z.prespeed !== undefined ? z.prespeed : cvarNum('surf_prespeed', 350));
        }
      } else if (z.index === this.stage) {
        // the stage clock starts when leaving the stage's start zone
        this.markStageStart();
      }
    }
  }

  /** Standing in a start zone that was never "entered" (see tick): make it count. */
  private checkInStart(): void {
    if (this.noclip()) return;
    let st: ZoneRt | null = null;
    for (const z of this.zones) {
      if (!z.inside || !isStartType(z.def)) continue;
      if (!st || (z.def.group === this.group && st.def.group !== this.group)) st = z;
    }
    if (!st) return;
    const armed = this.state === 'startzone' || (this.state === 'finished' && this.finishedInStart);
    if (!armed) this.enterStart(st.def);
    else if (this.state === 'startzone' && this.practice && this.practiceReason !== '!prac') this.practice = false;
  }

  private insideStage(group: number, index: number): boolean {
    return this.zones.some((z) => z.inside && z.def.type === 'stage' && z.def.group === group && z.def.index === index);
  }

  /** Stage practice: entering stage zone n. */
  private stagePracticeEnter(n: number): void {
    const sp = this.stagePrac;
    if (!sp) return;
    if (n === sp.stage) {
      // back at the stage's start (fail teleport, walked back): the stage clock restarts
      this.armStagePractice(n);
      return;
    }
    if (n < sp.stage) return;
    if (n === sp.stage + 1 && !sp.armed) this.reportStageTime(sp.stage, this.runTime);
    this.armStagePractice(n);
  }

  /** Stage practice: entering the course's end zone (completes the last stage). */
  private stagePracticeEnd(): void {
    const sp = this.stagePrac;
    if (!sp) return;
    const t = this.runTime;
    this.stagePrac = null;
    if (sp.armed || sp.stage !== this.stageCount(this.group)) {
      this.finish(); // skipped stages: a plain practice finish
      return;
    }
    this.reportStageTime(sp.stage, t);
    this.state = 'finished';
    this.finishedTime = t;
    this.finishedInStart = false;
  }

  /** "Stage 3 | 00:12.345 (PB -0.231)" and the stage best (not saved with custom physics). */
  private reportStageTime(n: number, t: number): void {
    const map = this.host.map.name;
    let prev = null as ReturnType<typeof addStageTime>['previous'];
    let improved = false;
    if (!this.host.customPhysics) {
      const r = addStageTime(map, this.group, n, t, this.tickrate());
      prev = r.previous;
      improved = r.improved;
    }
    const delta = prev ? t - prev.time : null;
    this.lastSplitDelta = delta;
    this.lastSplitTime = t;
    const segs: ChatSegment[] = [
      { text: `Stage ${n}`, color: 'lightblue' },
      { text: ' | ', color: 'grey' },
      { text: formatRunTime(t), color: 'default' },
    ];
    if (delta !== null) {
      segs.push({ text: ' (PB ', color: 'grey' }, { text: formatSplitDelta(delta), color: deltaColor(delta) }, { text: ')', color: 'grey' });
    } else if (!this.host.customPhysics) segs.push({ text: ' (first time)', color: 'grey' });
    else segs.push({ text: ' (custom physics: not saved)', color: 'grey' });
    this.chat(segs);
    this.play(improved && prev ? 'pb' : 'stage');
  }

  private enterStart(z: ZoneDef): void {
    if (this.noclip()) return;
    this.practice = false;
    this.practiceReason = '';
    this.stagePrac = null;
    if (this.state === 'finished' && z.group === this.group) {
      // the finish stays on screen (frozen) until the next run starts or !r
      this.finishedInStart = true;
      return;
    }
    if (this.inRun() || this.recording) this.cancelRecording();
    this.pbCache.clear();
    this.group = z.group;
    this.resetRunData();
    this.state = 'startzone';
  }

  private startRun(z: ZoneDef): void {
    if (this.noclip()) {
      this.state = 'stopped';
      return;
    }
    // SurfTimer: no cap in practice mode or on courses without an end zone
    const cap = z.prespeed !== undefined ? z.prespeed : cvarNum('surf_prespeed', 350);
    if (!this.practice && this.zoneDefs.some((d) => d.type === 'end' && d.group === z.group)) this.capSpeed(cap);
    this.resetRunData();
    this.state = this.practice ? 'practice' : 'running';
    this.stage = this.isStagedGroup(this.group) ? 1 : 0;
    this.stageSplits[1] = 0;
    this.seenDest = new Set(this.startDest);
    this.stageDest.clear();
    if (!this.practice && this.replay) {
      this.replay.beginRecording(this.group);
      this.recording = true;
    }
    this.onRunStart?.(this.group, this.practice);
  }

  private reachStage(n: number): void {
    const t = this.runTime;
    // the previous stage's own time (from leaving its zone) counts as a stage best on ranked runs
    if (!this.practice && !this.host.customPhysics && n === this.stage + 1 && this.stage >= 1) {
      addStageTime(this.host.map.name, this.group, this.stage, this.runTime - this.stageStartTime, this.tickrate());
    }
    this.stage = n;
    this.stageSplits[n] = t;
    this.markStageStart();
    if (this.practice) return;
    const pb = this.personalBest(this.group);
    const ref = pb && pb.stageSplits[n] !== undefined && pb.stageSplits[n] >= 0 ? pb.stageSplits[n] : null;
    const delta = ref !== null ? t - ref : null;
    this.lastSplitDelta = delta;
    this.lastSplitTime = t;
    this.chat([
      { text: `Stage ${n}`, color: 'lightblue' },
      { text: ' | ', color: 'grey' },
      { text: formatRunTime(t), color: 'default' },
      ...this.deltaSegments(delta),
    ]);
    this.play('stage');
  }

  private reachCheckpoint(n: number): void {
    const t = this.runTime;
    this.checkpoint = n;
    this.checkpointSplits[n] = t;
    if (this.practice) return;
    const pb = this.personalBest(this.group);
    const ref = pb && pb.checkpointSplits[n] !== undefined && pb.checkpointSplits[n] >= 0 ? pb.checkpointSplits[n] : null;
    const delta = ref !== null ? t - ref : null;
    this.lastSplitDelta = delta;
    this.lastSplitTime = t;
    this.chat([
      { text: `CP ${n}`, color: 'lightblue' },
      { text: ' | ', color: 'grey' },
      { text: formatRunTime(t), color: 'default' },
      ...this.deltaSegments(delta),
    ]);
    this.play('checkpoint');
  }

  private finish(): void {
    const time = this.runTime;
    const group = this.group;
    const practice = this.practice;
    this.state = 'finished';
    this.finishedTime = time;
    this.finishedInStart = false;
    const where = group > 0 ? `${this.host.map.name} Bonus ${group}` : this.host.map.name;
    if (practice || this.host.customPhysics) {
      this.cancelRecording();
      this.chat([
        { text: this.playerName(), color: 'lime' },
        { text: ' finished ', color: 'default' },
        { text: where, color: 'gold' },
        { text: ' in ', color: 'default' },
        { text: formatRunTime(time), color: 'lime' },
        { text: practice ? ' (practice — not saved)' : ' (custom physics — not saved)', color: 'grey' },
      ]);
      this.play('finish');
      this.onRunFinish?.({ group, time, ranked: false, isPb: false, rank: 0, total: 0, record: null });
      return;
    }
    const record: RunRecord = {
      map: this.host.map.name.toLowerCase(),
      group,
      time,
      stageSplits: this.splitArray(this.stageSplits),
      checkpointSplits: this.splitArray(this.checkpointSplits),
      jumps: this.jumps,
      strafes: this.strafes,
      sync: this.getStats().sync,
      tickrate: this.host.tickInterval > 0 ? Math.round((1 / this.host.tickInterval) * 1000) / 1000 : 0,
      date: Date.now(),
      avgSpeed: this.speedTicks ? this.speedSum / this.speedTicks : 0,
      maxSpeed: this.maxSpeed,
    };
    const prev = getPersonalBest(this.host.map.name, group, this.tickrate());
    const res = addRecord(record);
    this.pbCache.clear();
    const stages = this.stageCount(group);
    if (this.isStagedGroup(group) && this.stage === stages && stages > 1) {
      addStageTime(this.host.map.name, group, this.stage, this.runTime - this.stageStartTime, this.tickrate());
    }
    const delta = prev ? time - prev.time : null;
    this.lastSplitDelta = delta;
    this.lastSplitTime = time;
    const segs: ChatSegment[] = [
      { text: this.playerName(), color: 'lime' },
      { text: ' finished ', color: 'default' },
      { text: where, color: 'gold' },
      { text: ' in ', color: 'default' },
      { text: formatRunTime(time), color: 'lime' },
      ...this.deltaSegments(delta),
    ];
    if (res.rank > 0) {
      segs.push({ text: ' | Rank ', color: 'default' }, { text: `${res.rank}/${res.total}`, color: 'gold' });
    }
    this.chat(segs);
    if (res.isPb) {
      this.chat([{ text: 'NEW PERSONAL BEST!', color: 'gold' }]);
      this.play('pb');
    } else this.play('finish');
    if (this.replay && this.recording) {
      this.recording = false;
      void this.replay.endRecording(res.isPb, time);
    }
    this.onRunFinish?.({ group, time, ranked: true, isPb: res.isPb, rank: res.rank, total: res.total, record });
  }

  private deltaSegments(delta: number | null): ChatSegment[] {
    if (delta === null) return [];
    return [
      { text: ' (', color: 'grey' },
      { text: formatSplitDelta(delta), color: deltaColor(delta) },
      { text: ')', color: 'grey' },
    ];
  }

  // ---------------------------------------------------------------- heuristic stages

  private onMapTeleport(ev: MapTeleportEvent): void {
    if (!this.heuristicStages || this.group !== 0 || !this.inRun() || ev.seamless || ev.destinationIndex < 0) return;
    if (this.seenDest.has(ev.destinationIndex)) {
      // sent back to a known stage start (a fail): the stage clock restarts
      this.markStageStart();
      return;
    }
    this.seenDest.add(ev.destinationIndex);
    const ps = this.host.player;
    this.stage = Math.max(1, this.stage) + 1;
    this.stageDest.set(this.stage, { origin: v3clone(ev.origin), angles: { ...ps.viewAngles, roll: 0 } });
    this.stageSplits[this.stage] = this.runTime;
    this.markStageStart();
  }

  // ---------------------------------------------------------------- internals

  /** One tick of the run clock (see runTime). */
  private advanceRunClock(): void {
    const ti = this.host.tickInterval;
    if (ti !== this.clockInterval) {
      this.clockBase = this.runTime;
      this.clockBaseTicks = this.runTicks;
      this.clockInterval = ti;
    }
    this.runTicks++;
    this.runTime = this.clockBase + (this.runTicks - this.clockBaseTicks) * ti;
  }

  /** Run clock back to 0 (new run, stage practice start). */
  private resetRunClock(): void {
    this.runTicks = 0;
    this.runTime = 0;
    this.clockBase = 0;
    this.clockBaseTicks = 0;
    this.stageStartTicks = 0;
    this.stageStartTime = 0;
  }

  /** The current stage starts now (on the run clock). */
  private markStageStart(): void {
    this.stageStartTicks = this.runTicks;
    this.stageStartTime = this.runTime;
  }

  private inRun(): boolean {
    return this.state === 'running' || this.state === 'practice';
  }

  private noclip(): boolean {
    const mt = this.host.player.moveType;
    return mt === MOVETYPE_NOCLIP || mt === MOVETYPE_OBSERVER;
  }

  private isStagedGroup(group: number): boolean {
    if (this.zoneDefs.some((z) => z.type === 'stage' && z.group === group)) return true;
    return group === 0 && this.heuristicStages;
  }

  private stageCount(group: number): number {
    let n = 0;
    for (const z of this.zoneDefs) if (z.type === 'stage' && z.group === group && z.index > n) n = z.index;
    if (n === 0 && group === 0 && this.heuristicStages) return 0; // unknown
    return Math.max(1, n);
  }

  private checkpointCount(group: number): number {
    const s = new Set<number>();
    for (const z of this.zoneDefs) if (z.type === 'checkpoint' && z.group === group) s.add(z.index);
    return s.size;
  }

  private currentTime(): number {
    switch (this.state) {
      case 'running':
      case 'practice':
      case 'stopped':
        return this.runTime;
      case 'finished':
        return this.finishedTime;
      default:
        return 0;
    }
  }

  private personalBest(group: number): RunRecord | null {
    const tick = this.tickrate();
    const key = `${group}|${tickLabel(tick)}`;
    let pb = this.pbCache.get(key);
    if (pb === undefined) {
      pb = getPersonalBest(this.host.map.name, group, tick);
      this.pbCache.set(key, pb);
    }
    return pb;
  }

  private resetRunData(): void {
    this.resetRunClock();
    this.finishedTime = 0;
    this.finishedInStart = false;
    this.stage = this.isStagedGroup(this.group) ? 1 : 0;
    this.checkpoint = 0;
    this.stageSplits = [];
    this.checkpointSplits = [];
    this.validated = false;
    this.jumps = 0;
    this.strafes = 0;
    this.lastStrafeSign = 0;
    this.syncGood = 0;
    this.syncTotal = 0;
    this.speedSum = 0;
    this.speedTicks = 0;
    this.maxSpeed = 0;
  }

  private cancelRecording(): void {
    const wasInRun = this.inRun();
    if (this.recording) {
      this.recording = false;
      this.replay?.cancelRecording();
    }
    if (wasInRun) this.onRunCancel?.();
  }

  private splitArray(src: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < src.length; i++) out.push(src[i] !== undefined && Number.isFinite(src[i]) ? src[i] : -1);
    return out;
  }

  private resetPlayerModifiers(): void {
    const ps = this.host.player;
    ps.gravityScale = 1;
    ps.laggedMovement = 1;
    ps.baseVelocity.x = ps.baseVelocity.y = ps.baseVelocity.z = 0;
    ps.flags &= ~FL_BASEVELOCITY;
    if (ps.moveType === MOVETYPE_NOCLIP || ps.moveType === MOVETYPE_OBSERVER) ps.moveType = MOVETYPE_WALK;
    const ents = this.host.entities as unknown as (EntityExtras & { playerTargetname: string }) | undefined;
    if (ents && typeof ents.resetPlayerState === 'function') ents.resetPlayerState();
    else if (ents) ents.playerTargetname = '';
  }

  private teleport(origin: Vec3, angles: QAngle): void {
    this.teleportGen++;
    this.host.teleportPlayer(origin, angles, v3());
    this.host.entities?.onPlayerTeleported();
    this.recomputeInside();
  }

  private updateBox(): void {
    const ps = this.host.player;
    const hull = playerHull(ps);
    this.boxMins.x = ps.origin.x + hull.mins.x;
    this.boxMins.y = ps.origin.y + hull.mins.y;
    this.boxMins.z = ps.origin.z + hull.mins.z;
    this.boxMaxs.x = ps.origin.x + hull.maxs.x;
    this.boxMaxs.y = ps.origin.y + hull.maxs.y;
    this.boxMaxs.z = ps.origin.z + hull.maxs.z;
  }

  private overlaps(z: ZoneDef): boolean {
    const a = this.boxMins;
    const b = this.boxMaxs;
    return a.x < z.maxs.x && b.x > z.mins.x && a.y < z.maxs.y && b.y > z.mins.y && a.z < z.maxs.z && b.z > z.mins.z;
  }

  /** Re-evaluates zone contact at the current position without firing zone events. */
  private recomputeInside(): void {
    this.updateBox();
    for (const z of this.zones) z.inside = this.overlaps(z.def);
  }

  private insideStart(group: number): boolean {
    return this.zones.some((z) => z.inside && isStartType(z.def) && z.def.group === group);
  }

  private capSpeed(cap: number): void {
    if (!(cap > 0)) return;
    const v = this.host.player.velocity;
    const sp = Math.sqrt(v.x * v.x + v.y * v.y);
    if (sp > cap) {
      const k = cap / sp;
      v.x *= k;
      v.y *= k;
    }
  }

  private playerName(): string {
    const c = console_.getCvar('name');
    return (c && c.value) || 'Player';
  }

  private chat(segments: ChatSegment[]): void {
    try {
      this.host.chat([...PREFIX, ...segments]);
    } catch (e) {
      console.error(e);
    }
  }

  private play(name: SoundName): void {
    try {
      this.host.sound.play(name);
    } catch {
      /* audio unavailable */
    }
  }

  // ---------------------------------------------------------------- spawn placement

  private computeStartSpawn(group: number): Spawn {
    const starts = this.zoneDefs
      .filter((z) => isStartType(z) && z.group === group)
      .sort((a, b) => a.index - b.index || (a.type === b.type ? 0 : a.type === 'start' ? -1 : 1));
    if (!starts.length) {
      const s = this.host.map.spawns[0];
      return s ? { origin: v3clone(s.origin), angles: { ...s.angles } } : { origin: v3(), angles: qa() };
    }
    // a start zone with an explicit spawn / map destination / spawn point wins over the others
    for (const z of starts) {
      const sp = this.entitySpawnForZone(z);
      if (sp) return sp;
    }
    return this.spawnForZone(starts[0]);
  }

  /** Teleport targets (info_teleport_destination + whatever trigger_teleports aim at), computed once per map. */
  private teleportTargets(): MapEntity[] {
    if (!this.destCache) {
      const targetNames = new Set<string>();
      for (const e of this.host.map.entities) {
        const c = e.classname.toLowerCase();
        if (c === 'trigger_teleport' && e.kv.target) targetNames.add(e.kv.target.toLowerCase());
      }
      this.destCache = this.host.map.entities.filter((e) => {
        const c = e.classname.toLowerCase();
        if (c === 'info_teleport_destination') return true;
        if (!e.targetname || e.model > 0 || c.startsWith('trigger_')) return false;
        return targetNames.has(e.targetname.toLowerCase());
      });
    }
    return this.destCache;
  }

  /**
   * Where the map itself puts players: entities that trigger_teleports send the player to, with the number of
   * (non-landmark) trigger_teleports aiming at each — a stage's fail teleports all aim at its real start, so
   * that one dominates. Landmark-only entities are left out: a teleport's `landmark`, and the targets of
   * landmark teleports (seamless passages keep the player's offset from the landmark, so the entity itself is
   * no place to stand: lt_omnific's "start_qr4n" sits in a secret-trail nook). info_teleport_destinations
   * nothing aims at stay as candidates with 0 references. A destination inside an enabled trigger_teleport is a
   * relay, not a place to stand (lt_omnific's stage starts: "checkem_t3" sits in a booth whose filtered
   * teleports send the player on to "checkem_t3_L" / "_R" in the stage): its references go to those targets.
   */
  private spawnDestinations(): SpawnDest[] {
    if (!this.spawnDestCache) {
      const map = this.host.map;
      const ents = map.entities;
      const refs = new Map<string, number>();
      const landmarkOnly = new Set<string>();
      const teleports: { target: string; landmark: boolean; model: number }[] = [];
      for (const e of ents) {
        if (e.classname.toLowerCase() !== 'trigger_teleport') continue;
        const t = (e.kv.target ?? '').toLowerCase();
        const lm = (e.kv.landmark ?? '').toLowerCase();
        if (e.model > 0 && e.kv.startdisabled !== '1') teleports.push({ target: t, landmark: !!lm, model: e.model });
        if (lm) {
          landmarkOnly.add(lm);
          if (t) landmarkOnly.add(t);
          continue;
        }
        if (t) refs.set(t, (refs.get(t) ?? 0) + 1);
      }
      const list: (SpawnDest & { name: string })[] = [];
      for (const e of ents) {
        const c = e.classname.toLowerCase();
        if (e.model > 0 || c.startsWith('trigger_')) continue;
        const name = (e.targetname ?? '').toLowerCase();
        const r = name ? (refs.get(name) ?? 0) : 0;
        if (r === 0 && (c !== 'info_teleport_destination' || (name && landmarkOnly.has(name)))) continue;
        list.push({ origin: v3clone(e.origin), yaw: e.angles.yaw, refs: r, index: e.index, name });
      }
      // relays: destinations a teleport would immediately move the player away from
      const relayed = new Map<string, number>();
      const bmins = v3();
      const bmaxs = v3();
      const kept = list.filter((d) => {
        bmins.x = d.origin.x + HULL_MINS.x;
        bmins.y = d.origin.y + HULL_MINS.y;
        bmins.z = d.origin.z + HULL_MINS.z;
        bmaxs.x = d.origin.x + HULL_MAXS.x;
        bmaxs.y = d.origin.y + HULL_MAXS.y;
        bmaxs.z = d.origin.z + HULL_MAXS.z;
        let relay = false;
        for (const t of teleports) {
          const m = map.models[t.model];
          if (!m || !(m.mins.x < bmaxs.x && m.maxs.x > bmins.x && m.mins.y < bmaxs.y && m.maxs.y > bmins.y && m.mins.z < bmaxs.z && m.maxs.z > bmins.z)) continue;
          if (!m.brushes.some((b) => boxIntersectsBrush(bmins, bmaxs, b))) continue;
          relay = true;
          if (!t.landmark && t.target && t.target !== d.name) relayed.set(t.target, (relayed.get(t.target) ?? 0) + Math.max(1, d.refs));
        }
        return !relay;
      });
      this.spawnDestCache = kept.map((d) => ({ origin: d.origin, yaw: d.yaw, refs: d.refs + (relayed.get(d.name) ?? 0), index: d.index }));
    }
    return this.spawnDestCache;
  }

  /**
   * zone.spawn; else the best map destination near the zone (footprint padded by 256 units, from 64 under its
   * bottom to 512 over its top; most-referenced first, then nearest), placed on the zone's floor at the point
   * of the footprint nearest to it and facing its yaw; else a CS spawn point in/near the zone (yaw from a
   * destination within 1024 units, else the zone's open exit: CS spawn rows face each other, not the course).
   */
  private entitySpawnForZone(z: ZoneDef): Spawn | null {
    if (z.spawn) return { origin: v3clone(z.spawn.origin), angles: { ...z.spawn.angles } };
    const cx = (z.mins.x + z.maxs.x) / 2;
    const cy = (z.mins.y + z.maxs.y) / 2;
    const cz = (z.mins.z + z.maxs.z) / 2;
    const dist2 = (p: Vec3): number => (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2;
    const dests = this.spawnDestinations()
      .filter((d) => nearZone(d.origin, z, DEST_XY_PAD, 64, DEST_ABOVE))
      .sort((a, b) => b.refs - a.refs || dist2(a.origin) - dist2(b.origin));
    for (const d of dests) {
      const o = this.placeInZone(d.origin, z);
      if (o) return { origin: o, angles: qa(0, d.yaw, 0) };
    }
    const spawns = this.host.map.spawns.filter((s) => nearZone(s.origin, z, 64, 64, 128)).sort((a, b) => dist2(a.origin) - dist2(b.origin));
    for (const s of spawns) {
      const o = this.placeInZone(s.origin, z);
      if (o) return { origin: o, angles: qa(0, this.spawnYaw(o, s.angles.yaw), 0) };
    }
    return null;
  }

  /**
   * A standing spot in zone `z` for an entity at `p`: p's xy clamped into the zone's footprint (hull inset),
   * dropped onto the floor (hull trace from p's height, else the zone's top/middle/bottom). The hull must touch
   * the zone there and stand on walkable ground; a zone without floor under it keeps p when p is inside it.
   */
  private placeInZone(p: Vec3, z: ZoneDef): Vec3 | null {
    const inset = 17;
    const clampAxis = (v: number, lo: number, hi: number): number => (hi - lo <= 2 * inset ? (lo + hi) / 2 : Math.min(Math.max(v, lo + inset), hi - inset));
    const x = clampAxis(p.x, z.mins.x, z.maxs.x);
    const y = clampAxis(p.y, z.mins.y, z.maxs.y);
    const w = this.host.collision;
    const tr = newTrace();
    const bottom = z.mins.z - 64;
    let sawFloor = false;
    const heights = [Math.min(p.z, z.maxs.z + DEST_ABOVE), z.maxs.z, (z.mins.z + z.maxs.z) / 2, z.mins.z + 1];
    for (let i = 0; i < heights.length; i++) {
      const sz = heights[i];
      try {
        w.traceBox(v3(x, y, sz), v3(x, y, bottom), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
      } catch {
        return null;
      }
      // an entity placed exactly on the floor inside the zone: keep it where the map put it
      if (i === 0 && tr.startsolid && x === p.x && y === p.y && nearZone(p, z, 0, 0, 0) && this.hullFits(p)) return v3clone(p);
      if (tr.startsolid || tr.allsolid || tr.fraction >= 1) continue;
      sawFloor = true;
      const f = tr.endpos;
      if (f.z >= z.maxs.z || f.z + HULL_MAXS.z <= z.mins.z) continue; // landed above/below the zone
      if (tr.plane.normal.z < 0.7) continue; // a ramp: the player would slide off
      return v3(f.x, f.y, f.z);
    }
    if (!sawFloor && nearZone(p, z, 0, 0, 0) && this.hullFits(p)) return v3clone(p);
    return null;
  }

  /** Yaw for a spawn without a destination yaw: a map destination's within 1024 units, else the open exit. */
  private spawnYaw(o: Vec3, fallbackYaw: number): number {
    let best: SpawnDest | null = null;
    let bestD = SPAWN_YAW_RADIUS * SPAWN_YAW_RADIUS;
    for (const d of this.spawnDestinations()) {
      const dd = (d.origin.x - o.x) ** 2 + (d.origin.y - o.y) ** 2 + (d.origin.z - o.z) ** 2;
      if (dd < bestD || (best && dd === bestD && d.refs > best.refs)) {
        bestD = dd;
        best = d;
      }
    }
    if (best) return best.yaw;
    return openExitYaw(this.host.collision, o, fallbackYaw);
  }

  /**
   * Spawn for a start/stage zone: its explicit spawn; a map destination near it; a CS spawn point in/near it;
   * the floor under its center (facing a nearby destination's yaw, else the open exit); its bottom center.
   */
  private spawnForZone(z: ZoneDef): Spawn {
    const ent = this.entitySpawnForZone(z);
    if (ent) return ent;
    const floor = findZoneFloor(this.host.collision, z);
    if (floor) {
      let yaw = 0;
      let nd = 2048 * 2048;
      for (const s of this.host.map.spawns) {
        const d = (s.origin.x - floor.x) ** 2 + (s.origin.y - floor.y) ** 2 + (s.origin.z - floor.z) ** 2;
        if (d < nd) {
          nd = d;
          yaw = s.angles.yaw;
        }
      }
      return { origin: floor, angles: qa(0, this.spawnYaw(floor, yaw), 0) };
    }
    return { origin: zoneFloorPoint(this.host.collision, z), angles: qa() };
  }

  /**
   * The hull fits at p or one unit above it (destinations are often placed exactly on the floor, which a
   * box test counts as touching; the host unsticks the player after teleporting).
   */
  private hullFits(p: Vec3): boolean {
    try {
      const w = this.host.collision;
      if (!w.testBox(p, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)) return true;
      return !w.testBox(v3(p.x, p.y, p.z + 1), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
    } catch {
      return true;
    }
  }
}

/** p inside the zone's footprint (padded by `xyPad`) and between `below` under its bottom and `above` over its top. */
export function nearZone(p: Vec3, z: ZoneDef, xyPad: number, below: number, above: number): boolean {
  return (
    p.x >= z.mins.x - xyPad &&
    p.x <= z.maxs.x + xyPad &&
    p.y >= z.mins.y - xyPad &&
    p.y <= z.maxs.y + xyPad &&
    p.z >= z.mins.z - below &&
    p.z <= z.maxs.z + above
  );
}

/**
 * Standing spot at the zone's center: traces the player hull down from the zone's top (then mid-height,
 * then bottom) to `depth` units below the zone and returns the landing point, or null when nothing is hit.
 */
export function findZoneFloor(
  world: Pick<TimerHost['collision'], 'traceBox' | 'testBox'>,
  z: ZoneDef,
  depth = 256,
): Vec3 | null {
  const cx = (z.mins.x + z.maxs.x) / 2;
  const cy = (z.mins.y + z.maxs.y) / 2;
  const tr = newTrace();
  const end = v3(cx, cy, z.mins.z - depth);
  for (const sz of [z.maxs.z, (z.mins.z + z.maxs.z) / 2, z.mins.z + 1]) {
    const start = v3(cx, cy, sz);
    try {
      world.traceBox(start, end, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    } catch {
      return null;
    }
    if (tr.allsolid || tr.startsolid) continue;
    if (tr.fraction < 1) return v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
  }
  return null;
}

/** findZoneFloor, or the zone's bottom center (+1) when there is no floor under it. */
export function zoneFloorPoint(
  world: Pick<TimerHost['collision'], 'traceBox' | 'testBox'>,
  z: ZoneDef,
  depth = 256,
): Vec3 {
  return findZoneFloor(world, z, depth) ?? v3((z.mins.x + z.maxs.x) / 2, (z.mins.y + z.maxs.y) / 2, z.mins.z + 1);
}

/** Open space ahead before the face of a spawn counts as blocked (a spawn row facing a wall or a pillar). */
const OPEN_AHEAD = 512;

/**
 * The yaw a standing player at `o` should face when the map gives none: `fallbackYaw` (a CS spawn point's)
 * while it has at least OPEN_AHEAD units of open space in front of it; otherwise the direction with the most
 * open space (horizontal hull traces in 32 directions up to `dist` units: the open side of a start platform is
 * its exit, walls are close). `fallbackYaw` also when every direction is (nearly) equally open, and wins ties.
 */
export function openExitYaw(
  world: Pick<TimerHost['collision'], 'traceBox'>,
  o: Vec3,
  fallbackYaw: number,
  dist = 4096,
  steps = 32,
): number {
  const tr = newTrace();
  const start = v3(o.x, o.y, o.z + 4);
  const end = v3();
  const lenAt = (yaw: number): number => {
    const r = (yaw * Math.PI) / 180;
    end.x = start.x + Math.cos(r) * dist;
    end.y = start.y + Math.sin(r) * dist;
    end.z = start.z;
    try {
      world.traceBox(start, end, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
      return tr.startsolid ? 0 : tr.fraction * dist;
    } catch {
      return 0;
    }
  };
  if (lenAt(fallbackYaw) >= OPEN_AHEAD) return fallbackYaw;
  let bestYaw = fallbackYaw;
  let bestLen = -1;
  let minLen = Infinity;
  const fb = ((fallbackYaw % 360) + 360) % 360;
  for (let i = 0; i < steps; i++) {
    const yaw = (i * 360) / steps;
    const len = lenAt(yaw);
    minLen = Math.min(minLen, len);
    const diff = Math.abs(((yaw - fb + 540) % 360) - 180);
    const bestDiff = Math.abs(((bestYaw - fb + 540) % 360) - 180);
    if (len > bestLen + 1 || (Math.abs(len - bestLen) <= 1 && diff < bestDiff)) {
      bestLen = len;
      bestYaw = yaw;
    }
  }
  if (bestLen - minLen < 64) return fallbackYaw;
  return bestYaw > 180 ? bestYaw - 360 : bestYaw;
}
