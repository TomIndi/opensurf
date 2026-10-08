// The game core: states (menu / loading / playing / paused), map loading orchestration, the fixed-tick main loop,
// the host services the world systems run on, rendering and HUD assembly.
//
// Each rendered frame (requestAnimationFrame):
//   1. mouse movement since the last frame turns the view immediately (rendered at full refresh rate);
//   2. the elapsed real time (× host_timescale) is accumulated and whole ticks are simulated (at most 10 per
//      frame); each tick's view angles are the previous frame's angles interpolated towards the current ones at
//      that tick's simulated time within the frame, so a steady mouse turn is the same angle on every tick at any
//      fps (smooth strafes at low fps, no 1x/2x alternation when fps and tickrate differ);
//   3. the camera renders the eye position interpolated between the last two ticks (alpha = leftover time), and
//      moving brushes (doors, rotators, trains) and the props on them are drawn interpolated the same way.
// Per tick (docs/ARCHITECTURE.md "Game loop & tick order"): movers (carry / push the player) -> usercmd -> base
// velocity -> zone button filters and strafe stats -> playerMove (+ ground mover velocity) -> +use -> entities
// (triggers, I/O) -> timer -> replay recording -> sounds.
//
// Pausing (ESC, the pause menu, losing the mouse capture, hiding the tab) freezes the world: physics, map logic,
// movers and the timer all stop, and resuming carries on exactly where the player was (the run still counts: the
// run clock only counts simulated ticks). Time the game didn't simulate (a hidden tab, a frame gap) is never
// caught up. A map change that was given up returns to the map with a ranked run turned into practice ("Timer
// stopped — run paused, it won't count"). The debug API's pause() is the same freeze (deterministic stepping
// with runTicks).
//
// !undo (an accidental !r, game/undo.ts): !r keeps a snapshot of the run in progress (Session.undo) that !undo puts
// back exactly - player, view, timer run (same clock: the time in between counts like a pause), trigger contacts,
// replay recording - until a new run starts, another !r, a map change or the undo itself.
//
// Map changes: `map <name>` checks the name first (built-in list, else the catalog) and only prints
// "map load failed: <name> not found" for an unknown one. While a new map downloads and parses, the current
// session is kept aside (not simulated); it is dropped when the new map is ready, or comes back (with the
// error in chat and console) when the load fails. Loading reports carry the load's id and map name
// (LoadProgress.loadId / mapName) so the loading screen can tell loads apart.
import { QAngle, angleDiff, angleVectors, normalizeAngle, qa } from '../core/angles';
import { conPrint, console_, Cvar, FCVAR_CHEAT, FCVAR_REPLICATED } from '../core/cvars';
import { Vec3, v3, v3clone, v3copy, v3dist } from '../core/vec3';
import { BUILTIN_MAPS } from '../map/builtin/list';
import { FogDef, LoadedMap, ZoneDef, ZoneSource } from '../map/types';
import { CatalogEntry, getCatalogEntry, loadCatalog } from '../maps/catalog';
import { extractMapArchive, fetchCatalogMap } from '../maps/downloader';
import { boardLabel, getKsfService, isKsfEligibleMap, type KsfBoard, type KsfRecord, ksfReplayRecord, type KsfService, type KsfWr } from '../maps/ksf';
import type { CollisionWorld } from '../physics/collision';
import { categorizePosition, playerMove, unstuckPlayer } from '../physics/movement';
import {
  FL_BASEVELOCITY,
  IN_DUCK,
  IN_SPEED,
  IN_USE,
  MOVETYPE_NOCLIP,
  MOVETYPE_OBSERVER,
  MOVETYPE_WALK,
  MoveEvents,
  MoveVars,
  PlayerState,
  UserCmd,
  createPlayerState,
  newMoveEvents,
  newUserCmd,
} from '../physics/playertypes';
import {
  ChatSegment,
  GameApi,
  GameEvent,
  GameState,
  GhostState,
  HudState,
  KsfWrHud,
  LoadProgress,
  RenderSettings,
  RendererApi,
  ScoreboardData,
  ScoreboardRow,
  SoundApi,
  TimerHud,
  UiApi,
  ViewState,
} from './api';
import { configSavePending, loadSavedConfig, registerBindCommands, writeConfig } from './binds';
import { execCfg } from './cfgstore';
import {
  CHAT_PREFIX,
  CommandContext,
  chatToConsole,
  CommandSession,
  GameEntities,
  GameTimer,
  Saveloc,
  handleSay,
  KsfReplayResult,
  ksfWrSegments,
  playerName,
  registerGameCommands,
  runChatCommand,
  welcomeMessage,
  zoneSourceText,
} from './commands';
import type { TimerHost } from './contracts';
import { getMoveVars, hostTimescale, isCustomPhysics, isPhysicsCvar, registerConvars, tickInterval } from './convars';
import { installDebugApi, parseUrlOptions } from './debugapi';
import { EntitySystem } from './entities';
import { createHudState, horizontalSpeed, turnFromYawDelta, updateHudState } from './hud';
import { InputDevice, InputState, KeyDispatcher, readMouseSettings, registerButtonCommands } from './input';
import { REPLAY_TELEPORT_DISTANCE, ReplayData, ReplaySystem, replayFromKsf, sampleReplay } from './replay';
import { formatSplitDelta, SurfTimer } from './timer';
import { assignDeep, deepClone, RunUndoSnapshot } from './undo';
import { ZoneEditor, getEditorDebugBoxes, installZoneEditor, registerZoneCommands } from './zoneeditor';
import { resolveZones } from './zoneresolve';


// ------------------------------------------------------------------------------------------ constants

/** At most this many ticks per rendered frame (a long hitch slows the game down instead of spiralling). */
export const MAX_TICKS_PER_FRAME = 10;
/** Longest real-time step a single frame may account for (tab switches, debugger pauses). */
const MAX_FRAME_DT = 0.25;
/** Landing faster than this plays the hard landing (CS:GO fall damage threshold). */
const HARD_LANDING_SPEED = 580;
const SOFT_LANDING_SPEED = 120;
/** Footsteps: one per this many units walked on the ground above FOOTSTEP_MIN_SPEED (CS:GO is silent at walk speed). */
const FOOTSTEP_STRIDE = 80;
const FOOTSTEP_MIN_SPEED = 150;
/** Seconds the PB replay rests on its last frame before looping while spectating. */
const SPECTATE_LOOP_PAUSE = 2;
/** Lowest effective fps_max (10 ticks per frame must cover 128 tick). */
const MIN_FPS_LIMIT = 30;
/**
 * BSPs larger than this drop the previous map before parsing instead of keeping it until the parse succeeded:
 * two of the biggest maps in memory at once could run the tab out of memory.
 */
const KEEP_PREVIOUS_MAX_BSP_BYTES = 128 * 1024 * 1024;

// ------------------------------------------------------------------------------------------ map loading back-ends

export interface BuiltinInfo {
  id: string;
  name: string;
  tier: number;
}

/** Map loading back-ends (the defaults import the real modules lazily; tests inject fakes). */
/** Loader options derived from the renderer's capabilities. */
export interface BspLoadOptions {
  /** Keep the VTFs' DXT mip chains (the renderer can upload S3TC): full-resolution textures, 4-8x less memory. */
  compressedTextures?: boolean;
}

export interface MapLoaders {
  loadBsp(name: string, data: ArrayBuffer, onProgress?: (p: LoadProgress) => void, opts?: BspLoadOptions): Promise<LoadedMap>;
  buildBuiltin(id: string): Promise<LoadedMap>;
  builtinMaps(): Promise<BuiltinInfo[]>;
  catalog(): Promise<CatalogEntry[]>;
  fetchCatalogMap(entry: CatalogEntry, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<{ name: string; bsp: ArrayBuffer }>;
  extractArchive(data: ArrayBuffer, fileName: string): Promise<{ name: string; bsp: ArrayBuffer }>;
  fetchUrl(url: string, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<ArrayBuffer>;
}

/** fetch() with download progress (Content-Length) and abort support. */
export async function fetchWithProgress(url: string, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  onProgress?.({ phase: 'download', message: `Downloading ${url}…` });
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} while downloading ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || typeof res.body.getReader !== 'function') return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    const now = Date.now();
    if (now - lastReport > 100) {
      lastReport = now;
      const mb = (n: number) => (n / 1048576).toFixed(1);
      onProgress?.({
        phase: 'download',
        message: total ? `Downloading ${mb(loaded)} / ${mb(total)} MB` : `Downloading ${mb(loaded)} MB`,
        loaded,
        total: total || undefined,
      });
    }
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  onProgress?.({ phase: 'download', message: 'Downloaded', loaded, total: loaded });
  return out.buffer;
}

export const defaultLoaders: MapLoaders = {
  async loadBsp(name, data, onProgress, opts) {
    const m = await import('../bsp/loadmap');
    return m.loadBspMap(name, data, onProgress, opts?.compressedTextures ? { materials: { compressedTextures: true } } : {});
  },
  async buildBuiltin(id) {
    const m = await import('../map/builtin/index');
    return m.buildBuiltinMap(id);
  },
  async builtinMaps() {
    return BUILTIN_MAPS.map((b: BuiltinInfo) => ({ id: b.id, name: b.name, tier: b.tier }));
  },
  catalog: () => loadCatalog(),
  fetchCatalogMap: (entry, onProgress, signal) => fetchCatalogMap(entry, onProgress, signal),
  extractArchive: (data, fileName) => extractMapArchive(data, fileName),
  fetchUrl: fetchWithProgress,
};

export type LoadRequest =
  | { kind: 'catalog'; name: string }
  | { kind: 'builtin'; id: string }
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string };

interface LoadToken {
  seq: number;
  abort: AbortController;
  name: string;
}

class LoadAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

/** The catalog entry for `name` (case-insensitive, ".bsp" optional) from a freshly loaded catalog list. */
function findCatalogEntry(list: readonly CatalogEntry[] | null | undefined, name: string): CatalogEntry | undefined {
  const n = name.toLowerCase().replace(/\.bsp$/, '');
  return getCatalogEntry(n) ?? list?.find((e) => e.name.toLowerCase() === n);
}

/** A human-readable load error message. */
export function describeLoadError(e: unknown): string {
  if (e instanceof RangeError && /allocat|memory/i.test(e.message)) return `Out of memory (${e.message}). Close other tabs and retry.`;
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return `Network error (${e.message}). Check your connection and retry.`;
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------------------------------ tick math (pure)

/** Moving-brush hooks of game/entities.ts EntitySystem (duck-typed like the other entity extras). */
interface MoverHooks {
  /** Before playerMove: movers move, carrying / pushing the player. */
  tickMovers(): void;
  /** After playerMove: ground entity velocity when leaving / landing on a mover. */
  afterPlayerMove(wasOnGround: boolean, wasGroundModel: number): void;
  /** Every rendered frame: interpolated mover placements to the renderer. */
  applyRenderTransforms(alpha: number): void;
}

/**
 * Base velocity conversion (CBasePlayer::PhysicsSimulate semantics): if no trigger set FL_BASEVELOCITY during the
 * previous tick, the leftover base velocity becomes real velocity (with half a tick of extra push) and is
 * cleared; the flag is then cleared for this tick's triggers to set again.
 */
export function applyBaseVelocity(ps: PlayerState, frametime: number): void {
  if (!(ps.flags & FL_BASEVELOCITY)) {
    const k = 1 + frametime * 0.5;
    ps.velocity.x += ps.baseVelocity.x * k;
    ps.velocity.y += ps.baseVelocity.y * k;
    ps.velocity.z += ps.baseVelocity.z * k;
    ps.baseVelocity.x = 0;
    ps.baseVelocity.y = 0;
    ps.baseVelocity.z = 0;
  }
  ps.flags &= ~FL_BASEVELOCITY;
}

/**
 * Fixed-timestep accumulator: adds `dt` seconds and returns how many ticks of `interval` to run now (capped at
 * `maxTicks`, dropping the backlog beyond it) and the leftover time.
 */
export function accumulateTicks(acc: number, dt: number, interval: number, maxTicks = MAX_TICKS_PER_FRAME): { ticks: number; acc: number } {
  let a = acc + (dt > 0 && Number.isFinite(dt) ? dt : 0);
  if (!(interval > 0)) return { ticks: 0, acc: 0 };
  let n = Math.floor(a / interval + 1e-9);
  if (n > maxTicks) {
    n = maxTicks;
    a = n * interval;
  }
  a -= n * interval;
  if (a < 0) a = 0;
  return { ticks: n, acc: a };
}

/** Render interpolation: position between the previous and current tick. */
export function interpolateOrigin(out: Vec3, prev: Vec3, cur: Vec3, alpha: number): Vec3 {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  out.x = prev.x + (cur.x - prev.x) * a;
  out.y = prev.y + (cur.y - prev.y) * a;
  out.z = prev.z + (cur.z - prev.z) * a;
  return out;
}

// ------------------------------------------------------------------------------------------ render settings

const RENDER_CVARS: Readonly<Record<string, keyof RenderSettings>> = {
  mat_fullbright: 'fullbright',
  r_drawzones: 'drawZones',
  r_drawtriggers: 'drawTriggers',
  r_drawclips: 'drawClips',
  mat_wireframe: 'wireframe',
  r_brightness: 'brightness',
  r_anisotropy: 'maxAnisotropy',
  r_renderscale: 'renderScale',
  fog_enable: 'fogEnabled',
  r_3dsky: 'drawSky3D',
};

function renderSettingValue(field: keyof RenderSettings, c: Cvar): boolean | number {
  switch (field) {
    case 'brightness':
    case 'maxAnisotropy':
    case 'renderScale':
      return c.num;
    default:
      return c.bool;
  }
}

/**
 * The render settings a cvar drives (null if none). r_drawzones: 0 off, 1 outline on the zone floor (the look of
 * server zone beams), 2 the full box.
 */
export function renderSettingsForCvar(c: Cvar): Partial<RenderSettings> | null {
  if (c.name === 'r_drawzones') return { drawZones: c.num > 0, zoneStyle: c.num >= 2 ? 'box' : 'floor' };
  const field = RENDER_CVARS[c.name];
  if (!field) return null;
  return { [field]: renderSettingValue(field, c) } as Partial<RenderSettings>;
}

/** Every render setting from the cvars. */
export function renderSettingsFromCvars(): Partial<RenderSettings> {
  const out: Partial<RenderSettings> = {};
  for (const name of Object.keys(RENDER_CVARS)) {
    const c = console_.getCvar(name);
    const r = c ? renderSettingsForCvar(c) : null;
    if (r) Object.assign(out, r);
  }
  return out;
}

const TRIGGER_COLORS: Readonly<Record<string, [number, number, number]>> = {
  trigger_teleport: [1, 0.35, 0.3],
  trigger_push: [0.3, 0.6, 1],
  trigger_hurt: [1, 0.15, 0.55],
  trigger_gravity: [0.65, 0.35, 1],
  trigger_multiple: [1, 0.8, 0.2],
  trigger_once: [1, 0.65, 0.2],
  trigger_teleport_relative: [1, 0.5, 0.3],
  player_speedmod: [0.3, 1, 0.8],
};
const TRIGGER_DEFAULT_COLOR: [number, number, number] = [0.85, 0.85, 0.85];
const DISABLED_COLOR_CACHE = new Map<string, [number, number, number]>();

export function triggerColor(classname: string, enabled: boolean): [number, number, number] {
  const base = TRIGGER_COLORS[classname] ?? (classname.startsWith('func_') ? ([0.3, 1, 0.45] as [number, number, number]) : TRIGGER_DEFAULT_COLOR);
  if (enabled) return base;
  let d = DISABLED_COLOR_CACHE.get(classname);
  if (!d) {
    d = [base[0] * 0.35, base[1] * 0.35, base[2] * 0.35];
    DISABLED_COLOR_CACHE.set(classname, d);
  }
  return d;
}

/**
 * World systems format their own "[Surf] " prefix (the timer's is light blue); the host shows one consistent
 * SurfTimer-style prefix for every server message.
 */
export function unifyChatPrefix(segments: ChatSegment[]): ChatSegment[] {
  if (segments.length >= 3 && segments[0].text === '[' && segments[1].text === 'Surf' && segments[2].text === '] ') {
    return [...CHAT_PREFIX, ...segments.slice(3)];
  }
  return segments;
}

// ------------------------------------------------------------------------------------------ the per-map session

/** Everything that exists while a map is loaded: the player, the world systems, interpolation and saves. */
export class Session implements TimerHost, CommandSession {
  readonly map: LoadedMap;
  readonly player: PlayerState;
  readonly collision: CollisionWorld;
  readonly renderer: RendererApi;
  readonly ui: UiApi;
  readonly sound: SoundApi;
  readonly tier: number | null;
  readonly entities: GameEntities;
  readonly timer: GameTimer;
  readonly replay: ReplaySystem;
  readonly zoneEditor: ZoneEditor;
  readonly savelocs: Saveloc[] = [];
  savelocIndex = -1;
  /**
   * Simulation clock (s since map load, WorldHost.time). Monotonic: it advances by the tick interval in force
   * at each tick, so a tickrate change mid-map never rescales the time already simulated (delayed outputs,
   * logic_timers and trigger_hurt keep their schedule).
   */
  time = 0;
  tickCount = 0;
  /** Clock at the last tickrate change: time = clockBase + (tickCount - clockBaseTick) * clockInterval. */
  private clockBase = 0;
  private clockBaseTick = 0;
  private clockInterval = 0;
  /** Origin / eye height at the start of the latest tick (render interpolation). */
  readonly prevOrigin: Vec3;
  prevViewOffset: number;
  readonly cmd: UserCmd = newUserCmd();
  readonly ev: MoveEvents = newMoveEvents();
  lastJumped = false;
  lastCmdYaw = 0;
  stepDistance = 0;
  zonesDirty = true;
  zoneGroupSent = -1;
  ghostGroup = 0;
  /** How this map was loaded (`retry` reloads it). */
  request: LoadRequest | null = null;
  /** The KSF world record of the map (for the tickrate `ksfTickrate`), once known. */
  ksfWr: KsfWr | null = null;
  ksfTickrate = 0;
  /** HUD view of ksfWr (replaced, never mutated). */
  ksfHud: KsfWrHud | null = null;
  /** The KSF replay installed as the WR replay (s.replay.setWrReplay). */
  ksfReplay: { file: string; record: KsfRecord; data: ReplayData } | null = null;
  ksfReplayPending: { file: string; promise: Promise<ReplayData> } | null = null;
  /** Runs started on this map so far (ranked or practice): a pending !wrreplay doesn't take over a newer run. */
  runStarts = 0;
  /** The run the latest !r restarted, for !undo (null: nothing to undo). */
  undo: RunUndoSnapshot | null = null;
  private readonly game: Game;

  constructor(game: Game, map: LoadedMap, tier: number | null) {
    this.game = game;
    this.map = map;
    this.collision = map.collision;
    this.renderer = game.renderer;
    this.ui = game.ui;
    this.sound = game.sound;
    this.tier = tier;
    const sp = map.spawns[0];
    this.player = createPlayerState(sp ? sp.origin : v3(), sp ? sp.angles : qa());
    this.prevOrigin = v3clone(this.player.origin);
    this.prevViewOffset = this.player.viewOffsetZ;
    // order matters: the timer looks up host.entities when constructed
    this.entities = new EntitySystem(this);
    const timer = new SurfTimer(this);
    timer.onRunFinish = (ev) => game.emitEvent('runfinished', ev);
    timer.onRunStart = () => {
      this.runStarts++;
    };
    timer.finishExtras = (group, time) => game.ksfFinishSegments(this, group, time);
    this.timer = timer;
    this.replay = new ReplaySystem(map.name);
    timer.setReplay(this.replay);
    // the renderer gets the zones again whenever they change (zone editor, presets)
    const setZones = timer.setZones.bind(timer);
    timer.setZones = (zones, source) => {
      setZones(zones, source);
      this.zonesDirty = true;
    };
    this.zoneEditor = new ZoneEditor(this, timer);
  }

  get moveVars(): MoveVars {
    return getMoveVars();
  }

  /**
   * Starts the next tick of `ti` seconds: tickCount + 1 and the clock moves on by exactly one tick. While the
   * tickrate stays the same the clock is tickCount · ti from its last change (no float drift from summing).
   */
  advanceClock(ti: number): void {
    if (ti !== this.clockInterval) {
      this.clockBase = this.time;
      this.clockBaseTick = this.tickCount;
      this.clockInterval = ti;
    }
    this.tickCount++;
    this.time = this.clockBase + (this.tickCount - this.clockBaseTick) * ti;
  }

  get tickInterval(): number {
    return tickInterval();
  }

  get customPhysics(): boolean {
    return isCustomPhysics();
  }

  teleportPlayer(origin: Vec3, angles: QAngle | null, velocity: Vec3 | null): void {
    this.game.teleportInSession(this, origin, angles, velocity);
  }

  killPlayer(reason: string): void {
    this.game.killInSession(this, reason);
  }

  chat(segments: ChatSegment[]): void {
    const line = unifyChatPrefix(segments);
    this.ui.chat(line);
    chatToConsole(line);
  }

  print(text: string): void {
    conPrint(text);
  }

  /** Current course (0 = main, N = bonus N). */
  get group(): number {
    const g = this.timer.currentGroup;
    return typeof g === 'number' ? g : this.timer.getHud().bonus;
  }

  dispose(): void {
    try {
      this.timer.dispose?.();
    } catch (e) {
      console.error(e);
    }
    this.replay.cancelRecording();
    this.replay.spectate(null);
  }
}

// ------------------------------------------------------------------------------------------ the game

export interface GameDeps {
  renderer: RendererApi;
  ui: UiApi;
  sound: SoundApi;
  canvas: HTMLCanvasElement;
  /** Map loading back-ends (tests inject fakes). */
  loaders?: Partial<MapLoaders>;
  /** No pointer lock needed, never pause when it is lost (automated tests). Default: the ?autotest=1 URL flag. */
  autotest?: boolean;
  /** KSF world records (tests inject a fake client). Default: the shared service (maps/ksf.ts). */
  ksf?: KsfService;
}

/** The session kept aside while another map loads (it comes back if that load fails). */
interface SuspendedSession {
  session: Session;
  /** The state it comes back in ('playing' or 'paused'). */
  state: GameState;
  request: LoadRequest | null;
}

interface SpectateState {
  /** Your PB replay, or the KSF world record. */
  kind: 'pb' | 'wr';
  /** Banner / showpos name ("PB Replay", "KSF WR · name (66 tick)"). */
  label: string;
  group: number;
  /** Real time (s) at which replay time 0 is shown. */
  start: number;
  /** Real time when the replay reached its end (loop pause), or null. */
  finishedAt: number | null;
  lastYaw: number;
}

export class Game implements GameApi, CommandContext {
  readonly renderer: RendererApi;
  readonly ui: UiApi;
  readonly sound: SoundApi;
  readonly canvas: HTMLCanvasElement;
  readonly loaders: MapLoaders;
  readonly ksf: KsfService;
  readonly input = new InputState();
  readonly dispatcher = new KeyDispatcher();
  private device: InputDevice | null = null;
  private readonly windowCleanups: Array<() => void> = [];
  private offCvarChange: (() => void) | null = null;
  autotest: boolean;

  private _state: GameState = 'menu';
  private _session: Session | null = null;
  /** The previous map's session while a new map downloads and parses (see "Map changes" above). */
  private suspended: SuspendedSession | null = null;
  private loadingName: string | null = null;
  private loadSeq = 0;
  private currentLoad: LoadToken | null = null;
  private lastLoad: LoadRequest | null = null;
  private rendererLock: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<GameEvent, Set<(data?: unknown) => void>>();

  // loop
  private started = false;
  private raf = 0;
  private lastFrameMs = 0;
  private nextFrameMs = 0;
  private acc = 0;
  private alpha = 1;
  /** Seconds since the game started (performance clock). */
  private now = 0;
  private startMs = -1;
  private frameErrors = 0;
  private readonly systemErrors = new Map<string, number>();
  private cvarsChanged = false;
  private readonly announcedCvars = new Map<string, string>();

  // per-frame scratch
  private readonly tickAngles: QAngle = qa();
  private readonly hud: HudState = createHudState();
  private readonly view: ViewState = { origin: v3(), angles: qa(), fov: 90, time: 0 };
  private readonly debugBoxes: { mins: Vec3; maxs: Vec3; color: [number, number, number] }[] = [];
  private readonly ghostList: GhostState[] = [];
  private debugShown = false;
  private ghostShown = false;
  private spec: SpectateState | null = null;
  /**
   * The !wrreplay waiting for its download (one at a time). Spectating starts when the replay is there unless the
   * watch was cancelled (!wrreplay again, a PB replay, another map) or a run started meanwhile.
   */
  private ksfWatch: { session: Session; runStarts: number } | null = null;
  private readonly specVel = v3();
  private readonly fwd = v3();
  private readonly eye = v3();
  private readonly hudEye = v3();

  constructor(deps: GameDeps) {
    this.renderer = deps.renderer;
    this.ui = deps.ui;
    this.sound = deps.sound;
    this.canvas = deps.canvas;
    this.loaders = { ...defaultLoaders, ...(deps.loaders ?? {}) };
    this.ksf = deps.ksf ?? getKsfService();
    this.autotest = deps.autotest ?? false;
    registerConvars();
    registerBindCommands();
    registerButtonCommands(this.input);
    registerGameCommands(this);
    registerZoneCommands();
    this.input.buttons.showscores.onChange = (down) => this.ui.setScoreboardVisible(down);
    loadSavedConfig();
    // like CS:GO: config.cfg, then the user's autoexec.cfg (stored with cfg_save or added in the settings)
    try {
      execCfg('autoexec', true);
    } catch (e) {
      console.error(e);
    }
    this.offCvarChange = console_.onCvarChange((c, old) => this.onCvarChanged(c, old));
  }

  /** Stops everything and detaches from the global console (tests; a page has one game for its lifetime). */
  dispose(): void {
    this.stop();
    this.disconnect();
    this.offCvarChange?.();
    this.offCvarChange = null;
  }

  // ================================================================ GameApi

  get state(): GameState {
    return this._state;
  }

  get mapName(): string | null {
    return this._session?.map.name ?? this.loadingName;
  }

  get session(): Session | null {
    return this._session;
  }

  get spectating(): boolean {
    return this.spec !== null;
  }

  /** GameApi.rawInputActive: raw mouse input of the current pointer lock (null before the first capture). */
  get rawInputActive(): boolean | null {
    return this.device?.rawInputActive ?? null;
  }

  /** The world simulates this frame (paused = frozen). */
  private isLive(): boolean {
    return this._state === 'playing';
  }

  on(event: GameEvent, cb: (data?: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** @internal */
  emitEvent(event: GameEvent, data?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(data);
      } catch (e) {
        console.error(e);
      }
    }
  }

  executeCommand(line: string): void {
    console_.execute(line);
  }

  say(text: string): void {
    handleSay(this, text, false);
  }

  /**
   * Opens the pause menu and freezes the world (every key released) until resume(). `freeze` is accepted for the
   * debug API and tests; every pause is a freeze.
   */
  pause(_opts?: { freeze?: boolean }): void {
    if (this._state !== 'playing') return;
    this.dispatcher.releaseAll();
    this.input.releaseAll();
    this.setState('paused');
  }

  resume(): void {
    if (this._state !== 'paused') return;
    this.lastFrameMs = 0;
    this.input.discardMouse();
    this.setState('playing');
  }

  /**
   * The page was hidden or shown (visibilitychange). Hidden: the browser stops the frames, so the game pauses (the
   * pause menu is up when the player comes back); either way the time the page was hidden is never caught up.
   */
  onVisibilityChange(hidden: boolean): void {
    this.lastFrameMs = 0;
    this.acc = 0;
    if (!hidden) return;
    this.dispatcher.releaseAll();
    this.input.releaseAll();
    if (this.autotest) return;
    if (this._state === 'playing') this.pause();
  }

  disconnect(): void {
    const wasLoading = this._state === 'loading';
    this.abortLoad();
    this.dropSuspended();
    this.unloadSession();
    this.loadingName = null;
    if (wasLoading) this.ui.setLoading(null);
    this.setState('menu');
  }

  getHud(): HudState {
    return this.refreshHud();
  }

  getScoreboard(): ScoreboardData {
    const s = this._session;
    const rows: ScoreboardRow[] = [];
    if (s) {
      const group = s.group;
      const pb = s.timer.getRecords(group)[0] ?? null;
      rows.push({
        name: playerName(),
        time: pb ? pb.time : null,
        rank: pb ? 1 : 0,
        isBot: false,
        isLocal: true,
        style: isCustomPhysics() ? 'Custom' : 'Normal',
      });
      const rep = s.replay.getPb(group);
      if (rep) rows.push({ name: group > 0 ? `PB Replay (Bonus ${group})` : 'PB Replay', time: rep.time, rank: 1, isBot: true, isLocal: false, style: 'Normal' });
    }
    return { mapName: s?.map.name ?? '', tier: s?.tier ?? null, rows };
  }

  getZones() {
    return this._session ? this._session.timer.getZones() : [];
  }

  // ================================================================ map loading

  loadCatalogMap(name: string): Promise<void> {
    return this.runLoad({ kind: 'catalog', name }, name.replace(/\.bsp$/i, ''), async (token) => {
      this.progress(token, { phase: 'download', message: 'Loading the map catalog…' });
      const list = await this.loaders.catalog();
      this.check(token);
      const entry = findCatalogEntry(list, token.name);
      if (!entry) throw new Error(`"${token.name}" is not in the map catalog. Drop the .bsp file onto the menu to play it.`);
      token.name = entry.name;
      this.loadingName = entry.name;
      const got = await this.loaders.fetchCatalogMap(entry, (p) => this.progress(token, p), token.abort.signal);
      this.check(token);
      this.progress(token, { phase: 'parse', message: 'Reading the map…' });
      this.beforeParse(got.bsp);
      await yieldToBrowser();
      this.check(token);
      const map = await this.loaders.loadBsp(entry.name, got.bsp, (p) => this.progress(token, p), this.bspLoadOptions());
      return { map, tier: entry.tier };
    });
  }

  loadMapFile(file: File): Promise<void> {
    const base = file.name.replace(/^.*[\\/]/, '').replace(/\.(bz2|rar|zip)$/i, '').replace(/\.bsp$/i, '');
    return this.runLoad({ kind: 'file', file }, base, async (token) => {
      this.progress(token, { phase: 'extract', message: `Reading ${file.name}…` });
      const data = await file.arrayBuffer();
      this.check(token);
      this.progress(token, { phase: 'extract', message: `Extracting ${file.name}…` });
      await yieldToBrowser();
      const { name, bsp } = await this.loaders.extractArchive(data, file.name);
      this.check(token);
      token.name = name;
      this.loadingName = name;
      return this.parseBsp(token, name, bsp);
    });
  }

  loadBuiltinMap(id: string): Promise<void> {
    return this.runLoad({ kind: 'builtin', id }, id, async (token) => {
      this.progress(token, { phase: 'geometry', message: 'Generating the map…' });
      await yieldToBrowser();
      this.check(token);
      const map = await this.loaders.buildBuiltin(id);
      let tier: number | null = null;
      try {
        tier = (await this.loaders.builtinMaps()).find((b) => b.id === id)?.tier ?? null;
      } catch {
        /* list unavailable */
      }
      return { map, tier };
    });
  }

  /** Downloads a BSP (or archive) from a URL and plays it (?bsp=..., debug API). */
  loadMapUrl(url: string): Promise<void> {
    const file = decodeURIComponent(url.split(/[?#]/)[0].replace(/^.*\//, '')) || 'map.bsp';
    const base = file.replace(/\.(bz2|rar|zip)$/i, '').replace(/\.bsp$/i, '');
    return this.runLoad({ kind: 'url', url }, base, async (token) => {
      const data = await this.loaders.fetchUrl(url, (p) => this.progress(token, p), token.abort.signal);
      this.check(token);
      const { name, bsp } = await this.loaders.extractArchive(data, file);
      this.check(token);
      token.name = name;
      this.loadingName = name;
      return this.parseBsp(token, name, bsp);
    });
  }

  /**
   * `map <name>`: a built-in id/name, else a catalog map. Like CS:GO, an unknown name is only a console error
   * ("map load failed: <name> not found"): the current map (and run) stays as it is. `validate` false (the ?map=
   * URL parameter, where nobody sees the console) shows the loading screen's error for an unknown name instead.
   */
  async loadMapByName(name: string, validate = true): Promise<void> {
    const n = name.trim().replace(/^"+|"+$/g, '').replace(/^maps[\\/]/i, '').replace(/\.bsp$/i, '');
    if (!n) return;
    let builtin: BuiltinInfo | undefined;
    try {
      const list = await this.loaders.builtinMaps();
      builtin = list.find((b) => b.id.toLowerCase() === n.toLowerCase() || b.name.toLowerCase() === n.toLowerCase());
    } catch {
      /* no built-in maps */
    }
    if (builtin) return this.loadBuiltinMap(builtin.id);
    if (!validate) return this.loadCatalogMap(n);
    let entry: CatalogEntry | undefined;
    try {
      entry = findCatalogEntry(await this.loaders.catalog(), n);
    } catch (e) {
      conPrint(`map load failed: ${n} (the map catalog is unavailable: ${describeLoadError(e)})`, 'error');
      return;
    }
    if (!entry) {
      conPrint(`map load failed: ${n} not found`, 'error');
      return;
    }
    return this.loadCatalogMap(entry.name);
  }

  /** `retry`: loads the last requested map again. */
  async retry(): Promise<void> {
    const r = this.lastLoad;
    if (!r) {
      conPrint('retry: no map to reload.', 'warn');
      return;
    }
    switch (r.kind) {
      case 'catalog':
        return this.loadCatalogMap(r.name);
      case 'builtin':
        return this.loadBuiltinMap(r.id);
      case 'file':
        return this.loadMapFile(r.file);
      case 'url':
        return this.loadMapUrl(r.url);
    }
  }

  async mapNames(): Promise<string[]> {
    const out: string[] = [];
    try {
      out.push(...(await this.loaders.builtinMaps()).map((b) => b.id));
    } catch {
      /* none */
    }
    try {
      out.push(...(await this.loaders.catalog()).map((e) => e.name));
    } catch {
      /* offline */
    }
    return out;
  }

  private async parseBsp(token: LoadToken, name: string, bsp: ArrayBuffer): Promise<{ map: LoadedMap; tier: number | null }> {
    let tier: number | null = null;
    try {
      await this.loaders.catalog();
      tier = getCatalogEntry(name)?.tier ?? null;
    } catch {
      /* catalog unavailable: unknown tier */
    }
    this.check(token);
    this.progress(token, { phase: 'parse', message: 'Reading the map…' });
    this.beforeParse(bsp);
    await yieldToBrowser();
    this.check(token);
    const map = await this.loaders.loadBsp(name, bsp, (p) => this.progress(token, p), this.bspLoadOptions());
    return { map, tier };
  }

  /** A very large BSP is parsed without the previous map kept aside (memory). */
  private beforeParse(bsp: ArrayBuffer): void {
    if (bsp.byteLength > KEEP_PREVIOUS_MAX_BSP_BYTES) this.dropSuspended();
  }

  /** What the renderer can take: S3TC-capable devices get the maps' original DXT textures. */
  private bspLoadOptions(): BspLoadOptions {
    try {
      return { compressedTextures: !!this.renderer.capabilities?.().compressedTextures };
    } catch {
      return {};
    }
  }

  private async runLoad(req: LoadRequest, name: string, load: (token: LoadToken) => Promise<{ map: LoadedMap; tier: number | null }>): Promise<void> {
    this.abortLoad();
    // the current map stays aside (not simulated) until the new one is downloaded and parsed
    this.suspendSession();
    const token: LoadToken = { seq: ++this.loadSeq, abort: new AbortController(), name };
    this.currentLoad = token;
    this.lastLoad = req;
    this.loadingName = name;
    this.setState('loading');
    try {
      const { map, tier } = await load(token);
      this.check(token);
      // the new map is ready: the previous one goes now (its GPU memory before the new upload)
      this.dropSuspended();
      await this.finishLoad(token, map, tier, req);
    } catch (e) {
      this.loadFailed(token, e);
    }
  }

  private check(token: LoadToken): void {
    if (token.seq !== this.loadSeq || token.abort.signal.aborted) throw new LoadAborted();
  }

  /** A load report with the load's id and map name (LoadProgress.loadId / mapName). */
  private loadReport(token: LoadToken, p: LoadProgress): LoadProgress {
    return { ...p, loadId: token.seq, mapName: token.name };
  }

  private progress(token: LoadToken, p: LoadProgress): void {
    // late callbacks (a renderer still reporting after the map is up) must not bring the loading screen back
    if (token.seq !== this.loadSeq || this.currentLoad !== token) return;
    const r = this.loadReport(token, p);
    this.ui.setLoading(r);
    this.emitEvent('loadprogress', r);
  }

  /** Keeps the current session aside while a new map loads (nothing simulates or renders it meanwhile). */
  private suspendSession(): void {
    const s = this._session;
    if (!s) return;
    if (this.spec) this.stopSpectate();
    if (this.suspended) this.dropSuspended(); // (never both: a session only exists while nothing is suspended)
    s.undo = null; // (a map change ends what !undo could bring back, even one that fails and comes back)
    this.suspended = { session: s, state: this._state === 'paused' ? 'paused' : 'playing', request: s.request };
    this._session = null;
    installZoneEditor(null);
    this.dispatcher.releaseAll();
    this.input.releaseAll();
    this.ui.setScoreboardVisible(false);
    this.sound.setWind(0, false);
  }

  /** The new map is ready (or the player left): the suspended session is unloaded for good. */
  private dropSuspended(): void {
    const sus = this.suspended;
    if (!sus) return;
    this.suspended = null;
    this.unloadSession(sus.session);
  }

  /**
   * A load failed while another map was being played: that map comes back as it was. The world stood still
   * meanwhile, so a ranked run in progress goes on as practice.
   */
  private restoreSuspended(): boolean {
    const sus = this.suspended;
    if (!sus) return false;
    this.suspended = null;
    const s = sus.session;
    this._session = s;
    installZoneEditor(s.zoneEditor);
    if (sus.request) this.lastLoad = sus.request;
    s.zonesDirty = true;
    this.acc = 0;
    this.lastFrameMs = 0;
    this.input.discardMouse();
    try {
      s.timer.interruptRun?.();
    } catch (e) {
      console.error(e);
    }
    this.setState(sus.state);
    return true;
  }

  private abortLoad(): void {
    if (this.currentLoad) {
      this.currentLoad.abort.abort();
      this.currentLoad = null;
    }
    this.loadSeq++;
  }

  /**
   * Uploads a map to the renderer. Uploads are serialized: a superseded upload finishes (and unloads its map)
   * before the next one starts, so it can never unload a newer map.
   */
  private async uploadMap(token: LoadToken, map: LoadedMap): Promise<void> {
    const previous = this.rendererLock;
    let release!: () => void;
    this.rendererLock = new Promise<void>((r) => (release = r));
    try {
      await previous;
      this.check(token);
      this.progress(token, { phase: 'renderer', message: 'Uploading the map to the GPU…' });
      try {
        await this.renderer.loadMap(map, (p) => this.progress(token, p));
      } catch (e) {
        try {
          this.renderer.unloadMap();
        } catch {
          /* already broken */
        }
        throw e;
      }
      if (token.seq !== this.loadSeq) {
        // superseded while uploading: drop this map again (nobody else touched the renderer meanwhile)
        this.renderer.unloadMap();
        throw new LoadAborted();
      }
    } finally {
      release();
    }
  }

  private async finishLoad(token: LoadToken, map: LoadedMap, tier: number | null, req: LoadRequest | null = null): Promise<void> {
    await this.uploadMap(token, map);
    const s = new Session(this, map, tier);
    s.request = req;
    this._session = s;
    this.input.releaseAll();
    this.dispatcher.releaseAll();
    // map logic switching the player's fog (SetFogController) drives the renderer's world fog
    const ents = s.entities as GameEntities & { onFogController?: ((fog: FogDef) => void) | null };
    if ('onFogController' in ents) {
      ents.onFogController = (fog) => {
        if (this._session === s) this.renderer.setFog?.(fog);
      };
    }
    try {
      s.entities.spawn();
    } catch (e) {
      console.error(e);
      conPrint(`Map logic failed to start: ${describeLoadError(e)}`, 'error');
    }
    this.progress(token, { phase: 'renderer', message: 'Placing the timer zones…' });
    let zones: { zones: ZoneDef[]; source: ZoneSource } = { zones: [], source: 'none' };
    try {
      zones = await resolveZones(map);
    } catch (e) {
      console.error(e);
      conPrint(`Zones unavailable: ${describeLoadError(e)}`, 'warn');
    }
    if (token.seq !== this.loadSeq || this._session !== s) throw new LoadAborted();
    s.timer.setZones(zones.zones, zones.source);
    // SurfTimer spawns joining players in the start zone
    s.timer.restart(0);
    s.ghostGroup = 0;
    void s.replay.loadPb(map.name, 0).catch(() => false);
    installZoneEditor(s.zoneEditor);
    this.currentLoad = null;
    this.loadingName = null;
    this.acc = 0;
    this.lastFrameMs = 0;
    this.input.discardMouse();
    const ready = this.loadReport(token, { phase: 'done', message: 'Ready' });
    this.ui.setLoading(ready);
    this.emitEvent('loadprogress', ready);
    this.ui.setLoading(null);
    this.setState('playing');
    // show the HUD now (not next frame): the chat feed lives in it and the welcome lines follow
    this.ui.updateHud(this.refreshHud());
    this.emitEvent('mapload', map.name);
    for (const w of map.warnings ?? []) conPrint(`${map.name}: ${w}`, 'warn');
    conPrint(
      `Map ${map.name} loaded: ${map.entities.length} entities, ${map.models.length} brush models, zones: ${zoneSourceText(map, zones.source)} (${zones.zones.length})`,
      'info',
    );
    welcomeMessage(this, s);
    this.announceKsf(s);
  }

  private loadFailed(token: LoadToken, e: unknown): void {
    if (token.seq !== this.loadSeq) return; // superseded (disconnect / another load): nothing to report
    if (isAbortError(e)) return;
    console.error(e);
    const msg = describeLoadError(e);
    conPrint(`Failed to load ${token.name}: ${msg}`, 'error');
    this.currentLoad = null;
    this.loadingName = null;
    if (this.suspended) {
      // the map that was being played comes back (CS:GO keeps you on the server when a map change fails)
      const report = this.loadReport(token, { phase: 'error', message: msg, recovered: true });
      this.ui.setLoading(null);
      this.emitEvent('loadprogress', report);
      this.restoreSuspended();
      this.ui.chat([...CHAT_PREFIX, { text: `Couldn't load ${token.name}: ${msg}`, color: 'lightred' }]);
      return;
    }
    this.ui.chat([...CHAT_PREFIX, { text: `Couldn't load ${token.name}: ${msg}`, color: 'lightred' }]);
    this.unloadSession();
    const report = this.loadReport(token, { phase: 'error', message: msg });
    this.ui.setLoading(report);
    this.emitEvent('loadprogress', report);
    this.setState('menu');
  }

  /** Unloads a session (default: the current one) and clears what it showed in the renderer. */
  private unloadSession(s: Session | null = this._session): void {
    if (!s) return;
    if (s === this._session) {
      this.spec = null;
      installZoneEditor(null);
      this._session = null;
    }
    s.dispose();
    this.dispatcher.releaseAll();
    this.input.releaseAll();
    try {
      this.renderer.setGhosts([]);
      this.renderer.setDebugBoxes([]);
      this.renderer.setZones([], 0);
      this.renderer.unloadMap();
    } catch (e) {
      console.error(e);
    }
    this.ghostShown = false;
    this.debugShown = false;
    this.ui.setScoreboardVisible(false);
    this.sound.setWind(0, false);
  }

  private setState(st: GameState): void {
    if (this._state === st) return;
    this._state = st;
    this.ui.showMenu(st === 'menu' ? 'main' : st === 'paused' ? 'pause' : 'none');
    if (st !== 'playing') this.sound.setWind(0, false);
    this.emitEvent('statechange', st);
  }

  // ================================================================ host services

  /** @internal WorldHost.teleportPlayer of a session. */
  teleportInSession(s: Session, origin: Vec3, angles: QAngle | null, velocity: Vec3 | null): void {
    const ps = s.player;
    if (Number.isFinite(origin.x) && Number.isFinite(origin.y) && Number.isFinite(origin.z)) v3copy(ps.origin, origin);
    if (angles) {
      const yaw = Number.isFinite(angles.yaw) ? angles.yaw : 0;
      const pitch = Number.isFinite(angles.pitch) ? angles.pitch : 0;
      if (s === this._session) this.input.setAngles(pitch, yaw, 0);
      ps.viewAngles.pitch = this.input.view.pitch;
      ps.viewAngles.yaw = normalizeAngle(yaw);
      ps.viewAngles.roll = 0;
      s.lastCmdYaw = ps.viewAngles.yaw;
    }
    if (velocity) v3copy(ps.velocity, velocity);
    unstuckPlayer(ps, s.collision);
    categorizePosition(ps, s.collision, getMoveVars());
    v3copy(s.prevOrigin, ps.origin);
    s.prevViewOffset = ps.viewOffsetZ;
    s.stepDistance = 0;
  }

  /** @internal WorldHost.killPlayer of a session. */
  killInSession(s: Session, reason: string): void {
    if ((console_.getCvar('developer')?.num ?? 0) > 0) conPrint(`${playerName()} died (${reason})`);
    s.timer.onPlayerKilled();
  }

  // ================================================================ CommandContext

  teleportPlayer(origin: Vec3, angles: QAngle | null, velocity: Vec3 | null): void {
    const s = this._session;
    if (s) this.teleportInSession(s, origin, angles, velocity);
  }

  setViewAngles(pitch: number, yaw: number, roll = 0): void {
    this.input.setAngles(pitch, yaw, roll);
    const s = this._session;
    if (s) {
      s.player.viewAngles.pitch = this.input.view.pitch;
      s.player.viewAngles.yaw = this.input.view.yaw;
      s.player.viewAngles.roll = this.input.view.roll;
      s.lastCmdYaw = this.input.view.yaw;
    }
  }

  getViewAngles(): QAngle {
    const v = this.input.view;
    return { pitch: v.pitch, yaw: normalizeAngle(v.yaw), roll: v.roll };
  }

  setNoclip(on: boolean): void {
    const s = this._session;
    if (!s) return;
    const ps = s.player;
    const was = ps.moveType === MOVETYPE_NOCLIP || ps.moveType === MOVETYPE_OBSERVER;
    if (on === was) return;
    if (on) {
      ps.moveType = MOVETYPE_NOCLIP;
      s.timer.enterPractice('noclip');
    } else {
      ps.moveType = MOVETYPE_WALK;
      unstuckPlayer(ps, s.collision);
      categorizePosition(ps, s.collision, getMoveVars());
    }
  }

  killPlayer(reason: string): void {
    const s = this._session;
    if (s) this.killInSession(s, reason);
  }

  startSpectate(group: number): boolean {
    const s = this._session;
    if (!s) return false;
    if (!s.replay.spectate(group)) return false;
    const label = group > 0 ? `PB Replay (Bonus ${group})` : 'PB Replay';
    this.spec = { kind: 'pb', label, group, start: this.now, finishedAt: null, lastYaw: NaN };
    // watching the PB replay replaces a KSF WR replay still downloading
    this.ksfWatch = null;
    // only a new jump press leaves the replay (not a jump key that was already held)
    this.input.buttons.jump.clearImpulses();
    this.ghostShown = true; // force a setGhosts([]) next frame
    return true;
  }

  stopSpectate(respawn = true): void {
    const s = this._session;
    if (!this.spec || !s) {
      this.spec = null;
      return;
    }
    const group = this.spec.group;
    this.spec = null;
    s.replay.spectate(null);
    for (const k of Object.values(this.input.buttons)) k.clearImpulses();
    this.acc = 0;
    // back into the game at the course start, like re-joining a team on a surf server
    if (respawn) s.timer.restart(group);
  }

  // ================================================================ !undo (an accidental !r)

  /**
   * CommandContext.keepRunForUndo: !r calls it before restarting. When a run is in progress (a ranked run, a practice
   * run with time on the clock, stage practice) it keeps a snapshot for !undo, replacing an older one, and returns
   * true. Without a run in progress (or while watching a replay) nothing is taken and an earlier snapshot stays: a
   * second press of R in the start zone doesn't lose the run the first one restarted.
   */
  keepRunForUndo(): boolean {
    const s = this._session;
    if (!s || this.spec) return false;
    const t = s.timer;
    if (typeof t.snapshotRun !== 'function' || typeof t.restoreRun !== 'function' || typeof t.hasRunInProgress !== 'function') return false;
    if (!t.hasRunInProgress()) return false;
    const ents = s.entities;
    s.undo = {
      player: deepClone(s.player),
      view: { pitch: this.input.view.pitch, yaw: this.input.view.yaw, roll: this.input.view.roll },
      lastCmdYaw: s.lastCmdYaw,
      lastJumped: s.lastJumped,
      stepDistance: s.stepDistance,
      timer: t.snapshotRun(),
      entities: typeof ents.snapshotPlayer === 'function' ? ents.snapshotPlayer() : null,
      generation: t.runGeneration ?? 0,
      practiceReason: null,
    };
    return true;
  }

  /**
   * CommandContext.undoRestart (!undo, surf_undo): puts the run the latest !r restarted back exactly as it was - the
   * whole PlayerState (position, velocity, base velocity, view, duck, ground / water state, map-driven gravity and
   * speed), the view, the player's map-logic name and trigger contacts (no StartTouch / EndTouch storm), and the
   * timer run on the same clock (the time in between counts like a pause: a ranked run stays ranked, practice stays
   * practice; splits, stage, stats; the replay recording carries on). Consumes the snapshot. Returns the restored
   * run's timer HUD, or null when there is nothing to undo (no snapshot, a new run started since, the zones changed).
   */
  undoRestart(): TimerHud | null {
    const s = this._session;
    const snap = s?.undo ?? null;
    if (!s || !snap) return null;
    s.undo = null;
    const t = s.timer;
    if (typeof t.restoreRun !== 'function' || (t.runGeneration ?? 0) !== snap.generation) return null;
    if (!t.restoreRun(snap.timer)) return null;
    // (watching a replay meanwhile: leave it without the respawn)
    if (this.spec) this.stopSpectate(false);
    const ps = s.player;
    assignDeep(ps, snap.player);
    // no interpolation from the start zone: the camera is simply back
    v3copy(s.prevOrigin, ps.origin);
    s.prevViewOffset = ps.viewOffsetZ;
    this.input.setAngles(snap.view.pitch, snap.view.yaw, snap.view.roll);
    s.lastCmdYaw = snap.lastCmdYaw;
    s.lastJumped = snap.lastJumped;
    s.stepDistance = snap.stepDistance;
    if (snap.entities && typeof s.entities.restorePlayer === 'function') s.entities.restorePlayer(snap.entities);
    // a server cvar changed after the restart: like that change mid-run, a ranked run can't count any more
    if (snap.practiceReason && (t.timerState ?? t.getHud().state) === 'running') t.enterPractice(snap.practiceReason);
    // (a !wrreplay still downloading doesn't take over the run that came back)
    s.runStarts++;
    return t.getHud();
  }

  // ================================================================ KSF world records

  /** Whether the session's map may be on KSF (never the built-in maps). */
  private ksfEligible(s: Session): boolean {
    return isKsfEligibleMap(s.map.name, s.map.source === 'builtin' || s.request?.kind === 'builtin');
  }

  /** The tickrate the session's runs (and so its KSF board) use. */
  private sessionTickrate(s: Session): number {
    const t = s.timer.tickrate;
    if (typeof t === 'function') return t.call(s.timer);
    const ti = tickInterval();
    return ti > 0 ? 1 / ti : 100;
  }

  /** The KSF WR of a session's map for its tickrate (cached by the service); remembered on the session. */
  private async ksfFor(s: Session): Promise<KsfWr> {
    if (!this.ksfEligible(s)) return { status: 'unavailable', map: s.map.name, message: `${s.map.name} is not a KSF map (built-in maps have no world records).` };
    const tick = this.sessionTickrate(s);
    const res = await this.ksf.worldRecord(s.map.name, tick);
    if (res.status === 'ok' || res.status === 'none') this.setSessionKsf(s, res, tick);
    return res;
  }

  private setSessionKsf(s: Session, res: KsfWr, tick: number): void {
    s.ksfWr = res;
    s.ksfTickrate = tick;
    s.ksfHud = res.status === 'ok' ? { time: res.wr.time, name: res.wr.name, board: boardLabel(res.board) } : null;
    // the installed WR replay stays while it is still the one loadKsfWrReplay would pick (the WR's, or the fastest
    // record with a replay when the WR has none); another board (tickrate change) or no records drop it
    const pick = res.status === 'ok' ? ksfReplayRecord(res.records) : null;
    if (s.ksfReplay && s.ksfReplay.file !== pick?.file) {
      s.ksfReplay = null;
      s.replay.setWrReplay(null);
    }
  }

  /** CommandContext.ksfWorldRecord: the KSF WR of the current map. */
  async ksfWorldRecord(): Promise<KsfWr> {
    const s = this._session;
    if (!s) return { status: 'error', map: '', message: 'No map loaded.' };
    return this.ksfFor(s);
  }

  /** On map load: the WR line in chat (when the local server reaches KSF), and the WR ghost when it is on. */
  private announceKsf(s: Session): void {
    if (!this.ksfEligible(s)) return;
    void this.ksfFor(s).then((res) => {
      if (this._session !== s || res.status !== 'ok') return;
      s.chat([
        ...CHAT_PREFIX,
        ...ksfWrSegments(res),
        { text: ' - type ', color: 'default' },
        { text: '!wrreplay', color: 'gold' },
        { text: ' to watch', color: 'default' },
      ]);
      if (console_.getCvar('surf_ghost_wr')?.bool) void this.loadKsfWrReplay({ spectate: false }).catch(() => undefined);
    });
  }

  /** A tickrate change may mean the other KSF board: refresh the WR (and the WR ghost's replay). */
  private refreshKsf(s: Session): void {
    if (!s.ksfWr || !this.ksfEligible(s)) return;
    const tick = this.sessionTickrate(s);
    if (Math.abs(tick - s.ksfTickrate) < 1e-6) return;
    void this.ksfFor(s).then((res) => {
      if (this._session === s && res.status === 'ok' && console_.getCvar('surf_ghost_wr')?.bool) void this.loadKsfWrReplay({ spectate: false }).catch(() => undefined);
    });
  }

  /** A !wrreplay is waiting for its download on this map (Watch WR clicks are ignored meanwhile). */
  get ksfWatchPending(): boolean {
    return this.ksfWatch !== null && this.ksfWatch.session === this._session;
  }

  /** CommandContext.cancelKsfWatch: forgets the pending !wrreplay (the download carries on, cached); true if any. */
  cancelKsfWatch(): boolean {
    const had = this.ksfWatchPending;
    this.ksfWatch = null;
    return had;
  }

  /**
   * CommandContext.loadKsfWrReplay: downloads (once) the KSF WR replay of the current map, installs it as the WR
   * replay (ghost) and with `spectate` watches it. A WR without a replay file falls back to the fastest record
   * that has one. A watch is pending while the replay downloads (ksfWatchPending): when it arrives, spectating
   * starts only if the watch wasn't cancelled meanwhile (`cancelled`) and no run started since the request (else the
   * replay is just ready: `deferred`, it doesn't take over the run).
   */
  async loadKsfWrReplay(opts: { spectate: boolean; onDownload?: () => void }): Promise<KsfReplayResult> {
    const s = this._session;
    if (!s) return { ok: false, message: 'No map loaded.' };
    const watch = opts.spectate ? { session: s, runStarts: s.runStarts } : null;
    if (watch) this.ksfWatch = watch;
    // (a cancelled watch ends quietly, whatever happened to the download: the cancel was already answered)
    const cancelled = () => watch !== null && this.ksfWatch !== watch;
    const cancelledResult: KsfReplayResult = { ok: false, cancelled: true, message: 'The KSF WR replay was cancelled.' };
    try {
      const res = await this.ksfFor(s);
      if (cancelled()) return cancelledResult;
      if (res.status === 'unavailable') return { ok: false, message: res.message };
      if (res.status === 'error') return { ok: false, message: `Couldn't get the KSF records (${res.message}).` };
      if (res.status === 'none') return { ok: false, message: `No KSF records on ${s.map.name} yet.` };
      const rec = ksfReplayRecord(res.records);
      if (!rec) return { ok: false, message: `The KSF records of ${s.map.name} have no replays.` };
      let data: ReplayData;
      try {
        data = await this.ksfReplayData(s, res.board, rec, opts.onDownload);
      } catch (e) {
        if (cancelled()) return cancelledResult;
        throw e;
      }
      if (this._session !== s) return { ok: false, message: 'The map changed.' };
      const notWr = rec !== res.wr;
      const loaded = { ok: true as const, record: rec, board: res.board, fallback: res.fallback, notWr };
      if (!watch) return loaded;
      if (cancelled()) return cancelledResult;
      if (s.runStarts !== watch.runStarts) return { ...loaded, deferred: true };
      const label = `${notWr ? `KSF #${rec.rank}` : 'KSF WR'} · ${rec.name} (${boardLabel(res.board)})`;
      if (!this.startWrSpectate(data, label)) return { ok: false, message: "The KSF replay couldn't be played." };
      return loaded;
    } finally {
      if (watch && this.ksfWatch === watch) this.ksfWatch = null;
    }
  }

  /** The replay of a KSF record as ReplayData, installed as the session's WR replay (one download per file). */
  private ksfReplayData(s: Session, board: KsfBoard, rec: KsfRecord, onDownload?: () => void): Promise<ReplayData> {
    const file = rec.file!;
    if (s.ksfReplay && s.ksfReplay.file === file) return Promise.resolve(s.ksfReplay.data);
    if (s.ksfReplayPending && s.ksfReplayPending.file === file) return s.ksfReplayPending.promise;
    if (!this.ksf.hasReplay(rec)) onDownload?.();
    const promise = this.ksf.replay(rec, board).then((parsed) => {
      const data = replayFromKsf(parsed, s.map.name, { time: rec.time, date: rec.date * 1000 });
      // (a tickrate change meanwhile may have picked another record: only the current WR replay is installed)
      const cur = s.ksfWr?.status === 'ok' ? ksfReplayRecord(s.ksfWr.records) : null;
      if (!s.ksfReplay && cur?.file === file) {
        s.ksfReplay = { file, record: rec, data };
        s.replay.setWrReplay(data);
      }
      return data;
    });
    s.ksfReplayPending = { file, promise };
    const clear = () => {
      if (s.ksfReplayPending?.promise === promise) s.ksfReplayPending = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  /** GameApi.watchKsfWr: the map browser's "Watch WR" (the !wrreplay command, without toggling it off). */
  watchKsfWr(): void {
    // (already watching it, or already loading it: a second click changes nothing)
    if (!this._session || this.spec?.kind === 'wr' || this.ksfWatchPending) return;
    if (this.spec) this.stopSpectate();
    runChatCommand(this, 'wrreplay', []);
  }

  /** Spectates a KSF world record replay with the replay camera and HUD (leave like the PB replay). */
  startWrSpectate(data: ReplayData, label: string): boolean {
    const s = this._session;
    if (!s) return false;
    if (!s.replay.spectateData(data)) return false;
    this.spec = { kind: 'wr', label, group: 0, start: this.now, finishedAt: null, lastYaw: NaN };
    this.input.buttons.jump.clearImpulses();
    this.ghostShown = true;
    return true;
  }

  /** The end of the finish line: the run vs the KSF WR of the main course (" | +1.234 vs KSF WR"). */
  ksfFinishSegments(s: Session, group: number, time: number): ChatSegment[] {
    const r = s.ksfWr;
    if (group !== 0 || !r || r.status !== 'ok' || !(time > 0)) return [];
    const d = time - r.wr.time;
    return [
      { text: ' | ', color: 'grey' },
      { text: formatSplitDelta(d), color: d < 0 ? 'lightgreen' : d > 0 ? 'lightred' : 'grey' },
      { text: r.fallback ? ` vs KSF WR (${boardLabel(r.board)})` : ' vs KSF WR', color: 'grey' },
    ];
  }

  // ================================================================ cvars

  private onCvarChanged(c: Cvar, _old: string): void {
    this.cvarsChanged = true;
    const rs = renderSettingsForCvar(c);
    if (rs) {
      try {
        this.renderer.setSettings(rs);
      } catch (e) {
        console.error(e);
      }
    }
    if (c.name === 'sv_cheats' && !c.bool) {
      // like Source: turning cheats off restores every cheat cvar
      for (const cv of console_.allCvars()) if (cv.flags & FCVAR_CHEAT && cv.value !== cv.defaultValue) cv.reset();
    }
    const serverCvar = isPhysicsCvar(c.name) || c.name === 'tickrate' || c.name === 'host_timescale' || (c.flags & FCVAR_REPLICATED) !== 0;
    if (serverCvar) {
      // like a Source server announcing a notify cvar (once per value: canonicalizing setters re-emit)
      const fresh = this.announcedCvars.get(c.name) !== c.value;
      this.announcedCvars.set(c.name, c.value);
      if (fresh && this._session) this._session.chat([{ text: `Server cvar '${c.name}' changed to ${c.value}`, color: 'default' }]);
    }
    if (this._session) {
      if (c.name === 'tickrate') this.refreshKsf(this._session);
      else if (c.name === 'surf_ghost_wr' && c.bool && this._session.ksfWr?.status === 'ok') {
        // after the command that set it (!wrghost reports the download itself)
        queueMicrotask(() => void this.loadKsfWrReplay({ spectate: false }).catch(() => undefined));
      }
    }
    if (serverCvar && this._session) {
      // a server/physics change during a run: the run can't be ranked any more
      if (c.name !== 'sv_cheats') {
        const t = this._session.timer;
        const st = t.timerState ?? t.getHud().state;
        if (st === 'running') t.enterPractice(`${c.name} changed`);
        // ... nor the run an !undo would bring back
        const undo = this._session.undo;
        if (undo && !undo.practiceReason) undo.practiceReason = `${c.name} changed`;
      }
    }
  }

  // ================================================================ main loop

  start(): void {
    if (this.started) return;
    this.started = true;
    const hasWindow = typeof window !== 'undefined';
    const opts = parseUrlOptions(hasWindow ? window.location.search : '');
    if (opts.autotest) this.autotest = true;
    if (this.autotest) (this.ui as { lockHintEnabled?: boolean }).lockHintEnabled = false;
    try {
      this.renderer.setSettings(renderSettingsFromCvars());
    } catch (e) {
      console.error(e);
    }
    if (hasWindow) {
      this.device = new InputDevice({
        canvas: this.canvas,
        ui: this.ui,
        state: this.input,
        dispatcher: this.dispatcher,
        isPlaying: () => this._state === 'playing',
        onPointerLockLost: () => this.pause(),
        onEscape: () => {
          if (this._state === 'playing') this.pause();
        },
        onToggleConsole: () => this.ui.toggleConsole(),
        autotest: this.autotest,
      });
      this.device.attach();
      const resize = () => {
        try {
          this.renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
        } catch (e) {
          console.error(e);
        }
      };
      window.addEventListener('resize', resize);
      // a debounced config save must not be lost when the tab closes
      const flush = () => {
        if (configSavePending()) writeConfig();
      };
      const beforeUnload = (e: BeforeUnloadEvent) => {
        flush();
        // Ctrl (+duck) + W (+forward) is "close tab": ask before leaving a map mid-game
        if (!this.autotest && this._session && this._state === 'playing') {
          e.preventDefault();
          e.returnValue = '';
        }
      };
      window.addEventListener('pagehide', flush);
      window.addEventListener('beforeunload', beforeUnload);
      // a hidden tab gets no frames: a ranked run can't go on (and the hidden time is never caught up)
      const visibility = () => this.onVisibilityChange(typeof document !== 'undefined' && document.hidden);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
      this.windowCleanups.push(
        () => window.removeEventListener('resize', resize),
        () => window.removeEventListener('pagehide', flush),
        () => window.removeEventListener('beforeunload', beforeUnload),
        () => {
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
        },
      );
      resize();
      installDebugApi(this);
      const loop = (t: number) => {
        this.raf = requestAnimationFrame(loop);
        this.frame(t);
      };
      this.raf = requestAnimationFrame(loop);
    }
    if (opts.bsp) void this.loadMapUrl(opts.bsp);
    else if (opts.builtin) void this.loadBuiltinMap(opts.builtin);
    else if (opts.map) void this.loadMapByName(opts.map, false);
  }

  /** Stops the loop and input listeners (tests, hot reload). */
  stop(): void {
    if (this.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.device?.detach();
    this.device = null;
    for (const f of this.windowCleanups.splice(0)) f();
    this.started = false;
  }

  /** Captures the mouse (call from a user gesture). */
  requestPointerLock(): void {
    this.device?.requestPointerLock();
  }

  /** One rendered frame at `nowMs` (performance clock). Public for tests and the debug API. */
  frame(nowMs: number): void {
    try {
      this.frameInner(nowMs);
    } catch (e) {
      if (this.frameErrors++ < 5) console.error(e);
    }
  }

  private frameInner(nowMs: number): void {
    let fpsMax = console_.getCvar('fps_max')?.num ?? 0;
    // at least MIN_FPS_LIMIT: below it the per-frame tick cap would slow the simulation down
    if (fpsMax > 0 && fpsMax < MIN_FPS_LIMIT) fpsMax = MIN_FPS_LIMIT;
    if (fpsMax > 0 && this.lastFrameMs > 0) {
      const period = 1000 / fpsMax;
      if (nowMs < this.nextFrameMs - 0.75) return;
      this.nextFrameMs = Math.max(this.nextFrameMs + period, nowMs - period);
    } else this.nextFrameMs = nowMs;
    if (this.startMs < 0) this.startMs = nowMs;
    const gapMs = this.lastFrameMs > 0 ? nowMs - this.lastFrameMs : 0;
    let dt = gapMs / 1000;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    this.lastFrameMs = nowMs;
    this.now = (nowMs - this.startMs) / 1000;
    if (this.cvarsChanged) {
      this.cvarsChanged = false;
      this.emitEvent('cvarschanged');
    }
    const s = this._session;
    // a frame gap (a debugger, a frozen or throttled page) only loses that time: dt is capped, never caught up
    if (s && this.isLive()) this.simulateFrame(s, dt);
    else {
      this.input.discardMouse();
      this.dispatcher.afterTick();
    }
    const hud = this.refreshHud();
    if (s && (this._state === 'playing' || this._state === 'paused')) this.renderFrame(s, hud);
    this.ui.updateHud(hud);
    if (s && this.isLive() && this._session === s) {
      const v = this.spec ? this.specVel : s.player.velocity;
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      this.sound.setWind(speed, this.spec ? true : !s.player.onGround);
    }
  }

  private simulateFrame(s: Session, dt: number): void {
    const spectating = this.spec !== null;
    this.input.beginFrame(dt, spectating ? null : readMouseSettings(), (console_.getCvar('m_filter')?.num ?? 0) !== 0);
    if (spectating) {
      // a jump press leaves the replay
      if (this.input.buttons.jump.impulseDown) this.stopSpectate();
      this.dispatcher.afterTick();
      this.input.endFrame();
      return;
    }
    const ti = tickInterval();
    const span = dt * hostTimescale();
    const r = accumulateTicks(this.acc, span, ti);
    this.acc = r.acc;
    const n = r.ticks;
    for (let i = 1; i <= n; i++) {
      // each tick samples the view at its own simulated time within the frame (even per-tick turns at any fps)
      this.input.tickAngles(this.tickAngles, i, n, r.acc, ti, span);
      this.tickSession(s, this.tickAngles);
      this.dispatcher.afterTick();
      // (map logic or a command that paused / changed the map stops the frame's remaining ticks)
      if (this._session !== s || !this.isLive() || this.spec) break;
    }
    this.alpha = ti > 0 ? Math.min(1, Math.max(0, this.acc / ti)) : 1;
    this.input.endFrame();
  }

  /** Runs `n` ticks right now with the current input and view (deterministic stepping for tests). */
  runTicks(n: number): number {
    const s = this._session;
    if (!s || this.spec) return 0;
    let done = 0;
    for (let i = 0; i < n; i++) {
      this.tickSession(s, this.input.view);
      this.dispatcher.afterTick();
      done++;
      if (this._session !== s) break;
    }
    this.acc = 0;
    this.alpha = 1;
    return done;
  }

  /** One simulation tick (docs/ARCHITECTURE.md "Game loop & tick order"). */
  private tickSession(s: Session, angles: QAngle): void {
    const ps = s.player;
    const ti = tickInterval();
    const vars = getMoveVars();
    s.advanceClock(ti);
    v3copy(s.prevOrigin, ps.origin);
    s.prevViewOffset = ps.viewOffsetZ;
    const movers = s.entities as GameEntities & Partial<MoverHooks>;

    // 0. moving brushes (doors, rotators, trains) move first: they carry riders and push the player
    if (typeof movers.tickMovers === 'function') {
      try {
        movers.tickMovers();
      } catch (e) {
        this.systemError('movers', e);
      }
    }

    // 1. usercmd from the +commands
    const noclip = ps.moveType === MOVETYPE_NOCLIP || ps.moveType === MOVETYPE_OBSERVER;
    const cmd = this.input.buildCmd(s.cmd, angles, { noclip });
    // 2. base velocity (trigger_push) conversion
    applyBaseVelocity(ps, ti);
    // zone button filters (antijump / antiduck) and strafe statistics
    if (typeof s.timer.filterButtons === 'function') cmd.buttons = s.timer.filterButtons(cmd.buttons);
    const yawDelta = angleDiff(cmd.viewangles.yaw, s.lastCmdYaw);
    s.lastCmdYaw = cmd.viewangles.yaw;
    s.timer.recordInput(cmd.sidemove, cmd.forwardmove, yawDelta, ps.onGround, s.lastJumped);
    // 3. movement
    const oldButtons = ps.oldButtons;
    const wasOnGround = ps.onGround;
    const wasGroundModel = ps.groundModel;
    playerMove(ps, cmd, s.collision, vars, ti, s.ev);
    // leaving / landing on a moving brush keeps world momentum (ground entity velocity)
    if (typeof movers.afterPlayerMove === 'function') movers.afterPlayerMove(wasOnGround, wasGroundModel);
    s.lastJumped = s.ev.jumped;
    if (cmd.buttons & IN_USE && !(oldButtons & IN_USE) && typeof s.entities.pressUse === 'function') {
      angleVectors(cmd.viewangles, this.fwd);
      this.eye.x = ps.origin.x;
      this.eye.y = ps.origin.y;
      this.eye.z = ps.origin.z + ps.viewOffsetZ;
      try {
        s.entities.pressUse(this.eye, this.fwd);
      } catch (e) {
        this.systemError('entities.pressUse', e);
      }
    }
    // 4-5. triggers, entity I/O (a failing map entity must not stop the simulation)
    try {
      s.entities.tick();
    } catch (e) {
      this.systemError('entities', e);
    }
    if (this._session !== s) return; // map logic changed the map (unusual, but keep going safely)
    // 6. timer zones
    try {
      s.timer.tick();
    } catch (e) {
      this.systemError('timer', e);
    }
    // 7. replay recording
    const tstate = s.timer.timerState ?? s.timer.getHud().state;
    if (tstate === 'running') s.replay.recordTick(ps.origin, cmd.viewangles, ps.ducked, cmd.buttons);
    this.playMoveSounds(s, cmd);
  }

  /** Logs a world-system exception (the first few of each kind, so a broken map can't flood the console). */
  private systemError(system: string, e: unknown): void {
    const n = (this.systemErrors.get(system) ?? 0) + 1;
    this.systemErrors.set(system, n);
    if (n <= 3) {
      console.error(e);
      conPrint(`${system} error: ${describeLoadError(e)}${n === 3 ? ' (further errors are not shown)' : ''}`, 'error');
    }
  }

  private playMoveSounds(s: Session, cmd: UserCmd): void {
    const ev = s.ev;
    const ps = s.player;
    const snd = this.sound;
    try {
      if (ev.jumped) snd.play('jump');
      if (ev.landed) {
        if (ev.landSpeed > HARD_LANDING_SPEED) snd.play('land_hard');
        else if (ev.landSpeed > SOFT_LANDING_SPEED) snd.play('land');
      }
      if (ev.enteredWater) snd.play('water_enter');
      if (ev.leftWater) snd.play('water_exit');
      const walking = ps.moveType === MOVETYPE_WALK && ps.onGround && ps.waterLevel < 2;
      if (walking && horizontalSpeed(ps.velocity) > FOOTSTEP_MIN_SPEED && !(cmd.buttons & (IN_SPEED | IN_DUCK)) && !ps.ducked) {
        s.stepDistance += ev.groundDistance;
        if (s.stepDistance >= FOOTSTEP_STRIDE) {
          s.stepDistance %= FOOTSTEP_STRIDE;
          snd.play('footstep');
        }
      } else if (!ps.onGround) {
        // the first step after landing comes after half a stride
        s.stepDistance = FOOTSTEP_STRIDE * 0.5;
      }
    } catch {
      /* audio unavailable */
    }
  }

  // ================================================================ HUD + render

  private spectateSample(s: Session): { origin: Vec3; angles: QAngle; speed: number; time: number; finished: boolean; buttons: number } | null {
    const sp = this.spec;
    if (!sp) return null;
    let t = this.now - sp.start;
    let v = s.replay.spectateView(t);
    if (!v) return null;
    if (v.finished) {
      if (sp.finishedAt === null) sp.finishedAt = this.now;
      else if (this.now - sp.finishedAt >= SPECTATE_LOOP_PAUSE) {
        sp.start = this.now;
        sp.finishedAt = null;
        t = 0;
        v = s.replay.spectateView(0) ?? v;
      }
    }
    // velocity / buttons from the replay frames around t (stored velocities when the replay has them: KSF)
    const data = s.replay.spectatedReplay();
    let buttons = 0;
    if (data) {
      const b = sampleReplay(data, v.time);
      if (b?.velocity) {
        this.specVel.x = b.velocity.x;
        this.specVel.y = b.velocity.y;
        this.specVel.z = b.velocity.z;
      } else {
        const dtr = 1 / (data.tickrate > 0 ? data.tickrate : 100);
        const a = sampleReplay(data, v.time - dtr);
        if (a && b && b.time > a.time) {
          // (across a teleport the velocity from before it stays)
          if (v3dist(a.origin, b.origin) <= REPLAY_TELEPORT_DISTANCE) {
            const k = 1 / (b.time - a.time);
            this.specVel.x = (b.origin.x - a.origin.x) * k;
            this.specVel.y = (b.origin.y - a.origin.y) * k;
            this.specVel.z = (b.origin.z - a.origin.z) * k;
          }
        } else {
          this.specVel.x = this.specVel.y = this.specVel.z = 0;
        }
      }
      if (b) buttons = b.buttons;
    }
    return { origin: v.origin, angles: v.angles, speed: v.speed, time: v.time, finished: v.finished, buttons };
  }

  private refreshHud(): HudState {
    const s = this._session;
    const hud = this.hud;
    const drawHud = (console_.getCvar('cl_drawhud')?.num ?? 1) !== 0;
    if (!s) {
      updateHudState(hud, {
        visible: false,
        mapName: this.loadingName ?? '',
        tier: null,
        origin: ZERO,
        velocity: ZERO,
        angles: this.input.view,
        onGround: false,
        timer: null,
        stats: null,
        keys: null,
        turn: 0,
        practice: false,
        noclip: false,
        spectating: null,
        now: this.now,
      });
      return hud;
    }
    const ps = s.player;
    const visible = drawHud && (this._state === 'playing' || this._state === 'paused');
    const timerHud: TimerHud = s.timer.getHud();
    const spec = this.spec ? this.spectateSample(s) : null;
    if (spec) {
      // the replay's run clock: a KSF replay starts with its prestrafe in the start zone and ends on the record's
      // official time (finer than its ticks)
      const wr = this.spec!.kind === 'wr';
      const official = wr && spec.finished ? s.replay.spectatedReplay()?.time : undefined;
      const specTimer: TimerHud = {
        ...timerHud,
        state: spec.time < 0 ? 'startzone' : 'running',
        time: official !== undefined && official > 0 ? official : Math.max(0, spec.time),
        stage: 0,
        stageTime: 0,
        checkpoint: 0,
        lastSplitDelta: null,
        bonus: this.spec!.group,
      };
      const lastYaw = this.spec!.lastYaw;
      const turn = Number.isFinite(lastYaw) ? turnFromYawDelta(angleDiff(spec.angles.yaw, lastYaw)) : 0;
      this.spec!.lastYaw = spec.angles.yaw;
      updateHudState(hud, {
        visible,
        mapName: s.map.name,
        tier: s.tier,
        origin: spec.origin, // eye position, like cl_showpos
        velocity: this.specVel,
        angles: spec.angles,
        onGround: false,
        timer: specTimer,
        stats: null,
        keys: null,
        buttons: spec.buttons,
        turn,
        practice: false,
        noclip: false,
        spectating: this.spec!.label,
        speed: spec.speed,
        now: this.now,
        ksfWr: s.ksfHud,
      });
      return hud;
    }
    const b = this.input.buttons;
    // cl_showpos shows the view (eye) position in CS:GO, the same point getpos prints
    const eye = this.hudEye;
    interpolateOrigin(eye, s.prevOrigin, ps.origin, this.alpha);
    eye.z += s.prevViewOffset + (ps.viewOffsetZ - s.prevViewOffset) * this.alpha;
    updateHudState(hud, {
      visible,
      mapName: s.map.name,
      tier: s.tier,
      origin: eye,
      velocity: ps.velocity,
      angles: this.input.view,
      onGround: ps.onGround,
      timer: timerHud,
      stats: s.timer.getStats(),
      keys: {
        forward: b.forward.down,
        back: b.back.down,
        moveleft: b.moveleft.down,
        moveright: b.moveright.down,
        jump: b.jump.down,
        duck: b.duck.down,
        speed: b.speed.down,
      },
      turn: this.input.turn,
      practice: s.timer.inPractice,
      noclip: ps.moveType === MOVETYPE_NOCLIP || ps.moveType === MOVETYPE_OBSERVER,
      spectating: null,
      now: this.now,
      ksfWr: s.ksfHud,
    });
    return hud;
  }

  private renderFrame(s: Session, hud: HudState): void {
    const view = this.view;
    const ps = s.player;
    const spec = this.spec ? s.replay.spectateView(Math.max(0, this.now - this.spec.start)) : null;
    if (spec) {
      v3copy(view.origin, spec.origin);
      view.angles.pitch = spec.angles.pitch;
      view.angles.yaw = spec.angles.yaw;
      view.angles.roll = 0;
    } else {
      interpolateOrigin(view.origin, s.prevOrigin, ps.origin, this.alpha);
      view.origin.z += s.prevViewOffset + (ps.viewOffsetZ - s.prevViewOffset) * this.alpha;
      view.angles.pitch = this.input.view.pitch;
      view.angles.yaw = normalizeAngle(this.input.view.yaw);
      view.angles.roll = this.input.view.roll;
    }
    view.fov = console_.getCvar('fov_desired')?.num ?? 90;
    view.time = this.now;

    // zones (re-sent when they change or the course changes)
    const group = s.group;
    if (s.zonesDirty || group !== s.zoneGroupSent) {
      this.renderer.setZones(s.timer.getZones(), group);
      s.zonesDirty = false;
      s.zoneGroupSent = group;
    }
    // the ghost follows the PB replay of the current course
    if (group !== s.ghostGroup) {
      s.ghostGroup = group;
      void s.replay.loadPb(s.map.name, group).catch(() => false);
    }
    this.updateGhost(s, hud);
    this.updateDebugBoxes(s);
    // moving brushes and the props on them, between the last two ticks like the player
    const movers = s.entities as GameEntities & Partial<MoverHooks>;
    if (typeof movers.applyRenderTransforms === 'function') {
      try {
        movers.applyRenderTransforms(this.alpha);
      } catch (e) {
        this.systemError('movers', e);
      }
    }
    this.renderer.render(view);
  }

  private updateGhost(s: Session, hud: HudState): void {
    const shown = (console_.getCvar('surf_hide')?.num ?? 0) === 0 && !this.spec;
    const list = this.ghostList;
    list.length = 0;
    // the ghosts run with the run clock: hidden in the start zone (they would stand in your face while you
    // prestrafe), from the tick that leaves it at the same run time as you
    if (shown && hud.timer.state === 'running') {
      // the rendered player is between the previous and the current tick: (runTicks - 1 + alpha) ticks into the run
      const t = Math.max(0, hud.timer.time - (1 - this.alpha) * tickInterval());
      if ((console_.getCvar('surf_ghost')?.num ?? 1) !== 0) {
        const pb = s.replay.ghostAt(t);
        if (pb) list.push(pb);
      }
      // the KSF world record races the main course
      if ((console_.getCvar('surf_ghost_wr')?.num ?? 0) !== 0 && s.group === 0) {
        const wr = s.replay.wrGhostAt(t);
        if (wr) list.push(wr);
      }
    }
    if (list.length) {
      // (a fresh array: the renderer may keep it)
      this.renderer.setGhosts(list.slice());
      this.ghostShown = true;
    } else if (this.ghostShown) {
      this.renderer.setGhosts([]);
      this.ghostShown = false;
    }
  }

  private updateDebugBoxes(s: Session): void {
    const triggers = (console_.getCvar('r_drawtriggers')?.num ?? 0) !== 0;
    const editor = getEditorDebugBoxes();
    if (!triggers && !editor.length) {
      if (this.debugShown) {
        this.renderer.setDebugBoxes([]);
        this.debugShown = false;
      }
      return;
    }
    const boxes = this.debugBoxes;
    boxes.length = 0;
    if (triggers) {
      for (const t of s.entities.debugTriggers()) boxes.push({ mins: t.mins, maxs: t.maxs, color: triggerColor(t.classname, t.enabled) });
    }
    for (const b of editor) boxes.push(b);
    this.renderer.setDebugBoxes(boxes);
    this.debugShown = true;
  }
}

const ZERO: Vec3 = Object.freeze(v3()) as Vec3;
