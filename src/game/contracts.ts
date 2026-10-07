// Internal game-layer contracts between the game core (game.ts: loop, input, commands, HUD) and the
// game world systems (entities.ts: map logic/triggers, timer.ts: surf timer, replay.ts: ghosts/replays).
import { QAngle } from '../core/angles';
import { Vec3 } from '../core/vec3';
import { LoadedMap, ZoneDef, ZoneSource } from '../map/types';
import type { CollisionWorld } from '../physics/collision';
import { MoveVars, PlayerState } from '../physics/playertypes';
import { ChatSegment, GhostState, RendererApi, SoundApi, TimerHud, UiApi } from './api';

/** Services the game core provides to the world systems. */
export interface WorldHost {
  readonly map: LoadedMap;
  readonly player: PlayerState;
  readonly collision: CollisionWorld;
  readonly renderer: RendererApi;
  readonly ui: UiApi;
  readonly sound: SoundApi;
  /** Current movement vars (from sv_* cvars). */
  readonly moveVars: MoveVars;
  /** Simulation time in seconds since map load (advances by tick interval). */
  readonly time: number;
  /** Seconds per tick. */
  readonly tickInterval: number;
  /** Current tick number since map load. */
  readonly tickCount: number;
  /**
   * Moves the player. `angles` null keeps the view; `velocity` null keeps velocity.
   * Resets interpolation so the camera doesn't smear, re-categorizes ground/water, unsticks.
   */
  teleportPlayer(origin: Vec3, angles: QAngle | null, velocity: Vec3 | null): void;
  /** Lethal damage (trigger_hurt): the timer decides where to respawn. */
  killPlayer(reason: string): void;
  /** Chat line formatted SurfTimer-style. */
  chat(segments: ChatSegment[]): void;
  /** Developer/console message. */
  print(text: string): void;
}

/** Runtime map logic: triggers, filters, I/O, brush entity toggles. Implemented by game/entities.ts. */
export interface IEntitySystem {
  /** Instantiate entities from host.map, apply initial states, fire logic_auto/OnMapSpawn. */
  spawn(): void;
  /**
   * Called once per tick AFTER playerMove: computes trigger overlaps against the player hull,
   * fires StartTouch/Touch/EndTouch (teleports, pushes, outputs), runs the delayed I/O queue,
   * logic_timers etc.
   */
  tick(): void;
  /** Player's current targetname (changed by AddOutput targetname; read by filters). */
  playerTargetname: string;
  /** Called when the player is teleported by the timer (!r etc): clears touch state so EndTouch logic doesn't misfire. */
  onPlayerTeleported(): void;
  /** Trigger volumes for r_drawtriggers (absolute AABBs + classname). */
  debugTriggers(): { mins: Vec3; maxs: Vec3; classname: string; enabled: boolean }[];
  /** Find an entity origin/angles by targetname (teleport destinations etc.). */
  findTarget(name: string): { origin: Vec3; angles: QAngle } | null;
}

/** Things the timer needs on top of WorldHost. */
export interface TimerHost extends WorldHost {
  readonly entities: IEntitySystem;
  /** True if any FCVAR_REPLICATED physics cvar differs from default (run is "custom physics"). */
  readonly customPhysics: boolean;
  /** Map metadata from the catalog. */
  readonly tier: number | null;
}

export interface RunRecord {
  map: string;
  /** 0 main, N bonus. */
  group: number;
  time: number;
  /** Per-stage completion times (cumulative seconds at each stage start, index = stage number). */
  stageSplits: number[];
  /** Cumulative times at checkpoints (index = checkpoint number). */
  checkpointSplits: number[];
  jumps: number;
  strafes: number;
  sync: number;
  tickrate: number;
  date: number;
  /** Average speed and max speed for the run. */
  avgSpeed: number;
  maxSpeed: number;
}

/** The surf timer (SurfTimer/KSF-like). Implemented by game/timer.ts. */
export interface ISurfTimer {
  /** Install zones (already resolved by priority). */
  setZones(zones: ZoneDef[], source: ZoneSource): void;
  getZones(): ZoneDef[];
  readonly zoneSource: ZoneSource;
  /** Called every tick after entities.tick(). */
  tick(): void;
  /** !r (group 0) / !b N (group N). Teleports to that course's start. */
  restart(group?: number): void;
  /** !back / !stuck: restart the current stage (or the course on linear maps). */
  restartStage(): void;
  /** !s N: go to stage N (practice if N > current progress? SurfTimer allows and resets the timer). */
  gotoStage(stage: number): void;
  /** Player died (trigger_hurt): respawn at current stage start. */
  onPlayerKilled(): void;
  /** Saveloc/tele/noclip: timer stops and enters practice mode until restart. */
  enterPractice(reason: string): void;
  readonly inPractice: boolean;
  getHud(): TimerHud;
  /** Best records for the map (for !pb/!top/scoreboard). */
  getRecords(group: number): RunRecord[];
  /** Where (re)spawning at a course start puts the player. */
  getStartSpawn(group: number): { origin: Vec3; angles: QAngle };
  /** Strafe statistics for the HUD (current run). */
  getStats(): { jumps: number; strafes: number; sync: number };
  /** Feed per-tick input for strafe/sync stats (called by game before playerMove). */
  recordInput(sidemove: number, forwardmove: number, yawDelta: number, onGround: boolean, jumped: boolean): void;
}

/** Replays & ghosts. Implemented by game/replay.ts. */
export interface IReplaySystem {
  /** Start recording a run attempt (called when the timer starts). */
  beginRecording(group: number): void;
  /** Called every tick while recording. */
  recordTick(origin: Vec3, angles: QAngle, ducked: boolean, buttons: number): void;
  /** Stop recording; if `saveAsPb` the recording becomes the stored PB replay for (map, group). */
  endRecording(saveAsPb: boolean, time: number): Promise<void>;
  cancelRecording(): void;
  /** Load the PB replay for map/group (from IndexedDB) so it can be ghosted/spectated. */
  loadPb(map: string, group: number): Promise<boolean>;
  /** Ghost for the current frame: PB replay position at `runTime` seconds into the run (null if none). */
  ghostAt(runTime: number): GhostState | null;
  /** Spectate the PB replay in first person (null stops). Returns false if no replay. */
  spectate(group: number | null): boolean;
  readonly spectating: boolean;
  /** While spectating: the view to render for render time t (seconds since spectate started). */
  spectateView(t: number): { origin: Vec3; angles: QAngle; speed: number; time: number; finished: boolean } | null;
}
