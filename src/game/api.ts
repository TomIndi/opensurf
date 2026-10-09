// Contracts between the game core, the UI layer, the renderer and audio.
// main.ts wires concrete implementations together; modules only depend on these interfaces.
import { QAngle } from '../core/angles';
import { Vec3 } from '../core/vec3';
import { ZoneDef } from '../map/types';

// ------------------------------------------------------------------ chat / hud

/** CS:GO chat colors as used by SourceMod surf plugins ({green}, {lightred}, ...), or any CSS color. */
export type ChatColor =
  | 'default'
  | 'white'
  | 'red'
  | 'lightred'
  | 'darkred'
  | 'green'
  | 'lightgreen'
  | 'lime'
  | 'olive'
  | 'blue'
  | 'lightblue'
  | 'darkblue'
  | 'purple'
  | 'orchid'
  | 'yellow'
  | 'gold'
  | 'orange'
  | 'grey'
  | 'grey2'
  | 'team'
  | string;

export interface ChatSegment {
  text: string;
  color?: ChatColor;
}

export type TimerState = 'disabled' | 'startzone' | 'running' | 'finished' | 'practice' | 'stopped';

export interface TimerHud {
  state: TimerState;
  /** Seconds on the clock (main course or bonus). */
  time: number;
  /** Current stage (1-based) on staged maps, 0 on linear maps. */
  stage: number;
  stageCount: number;
  /** Seconds in the current stage. */
  stageTime: number;
  /** Last checkpoint reached on linear maps (0 = none). */
  checkpoint: number;
  checkpointCount: number;
  /** 0 = main course, N = bonus N. */
  bonus: number;
  /** Personal best for the current course (seconds) or null. */
  pb: number | null;
  /** Best local record (acts as "WR") or null. */
  wr: number | null;
  mapType: 'linear' | 'staged';
  /** Last checkpoint/stage comparison vs PB in seconds (negative = faster), shown briefly. */
  lastSplitDelta: number | null;
  lastSplitTime: number;
  /**
   * Optional: what the last split compares, for the split flash: "Stage 2 00:12.345" (a completed stage: the delta
   * is vs your best time of that stage), "Stage 3" (run split vs the PB), "CP 2", "Finish".
   */
  lastSplitLabel?: string;
}

export interface KeysHud {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  duck: boolean;
  walk: boolean;
  /** Mouse turning direction this frame: -1 left, 0 none, 1 right. */
  turn: number;
}

/** The KSF world record of the map, for the HUD side panel and the pause menu. */
export interface KsfWrHud {
  /** Seconds. */
  time: number;
  /** Record holder. */
  name: string;
  /** Leaderboard: "66 tick" / "100 tick". */
  board: string;
}

export interface HudState {
  /** False while in menus or with cl_drawhud 0. */
  visible: boolean;
  mapName: string;
  tier: number | null;
  /** Horizontal speed in u/s. */
  speed: number;
  velocity: Vec3;
  origin: Vec3;
  angles: QAngle;
  onGround: boolean;
  timer: TimerHud;
  keys: KeysHud;
  /** Strafe statistics for the current run. */
  jumps: number;
  strafes: number;
  /** 0..100 strafe sync (% of air ticks where turning and strafing agree). */
  sync: number;
  practice: boolean;
  noclip: boolean;
  /** Replay/spectate target name if watching a replay. */
  spectating: string | null;
  /** Elapsed real time, for HUD animations. */
  now: number;
  /** Optional: the KSF world record of the map's main course (null / absent: none known, e.g. no local server). */
  ksfWr?: KsfWrHud | null;
}

export interface ScoreboardRow {
  name: string;
  time: number | null;
  rank: number;
  isBot: boolean;
  isLocal: boolean;
  style?: string;
}

export interface ScoreboardData {
  mapName: string;
  tier: number | null;
  rows: ScoreboardRow[];
}

export interface LoadProgress {
  phase: 'download' | 'extract' | 'parse' | 'collision' | 'geometry' | 'textures' | 'renderer' | 'done' | 'error';
  message: string;
  /** Bytes or items done / total, when known. */
  loaded?: number;
  total?: number;
  /**
   * Optional (game 'loadprogress' events and UiApi.setLoading): id of the load this report belongs to. It grows
   * with every load the game starts, so a new id means a new load (refresh the loading screen's header).
   */
  loadId?: number;
  /** Optional: the map being loaded (catalog / built-in / file name as far as known). */
  mapName?: string;
  /**
   * Optional, on phase 'error': the load failed but the map that was being played before it is back (the game
   * returns to 'playing' / 'paused'), so show the error briefly instead of an error screen.
   */
  recovered?: boolean;
}

export type GameState = 'menu' | 'loading' | 'playing' | 'paused';

export type GameEvent = 'statechange' | 'mapload' | 'loadprogress' | 'runfinished' | 'cvarschanged';

/** What the UI can ask the game to do. Implemented by game/game.ts. */
export interface GameApi {
  readonly state: GameState;
  /** Currently loaded map name or null. */
  readonly mapName: string | null;
  /** Loads a map from the catalog (downloads + caches if needed). */
  loadCatalogMap(name: string): Promise<void>;
  /** Loads a dropped/selected local file (.bsp, .bsp.bz2, .rar, .zip). */
  loadMapFile(file: File): Promise<void>;
  /** Loads a built-in procedural map by id. */
  loadBuiltinMap(id: string): Promise<void>;
  /** Back to the main menu. */
  disconnect(): void;
  pause(): void;
  resume(): void;
  /** Console line (may contain several commands). */
  executeCommand(line: string): void;
  /** Chat line from the local player; handles !commands / /commands like SourceMod. */
  say(text: string): void;
  getHud(): HudState;
  getScoreboard(): ScoreboardData;
  getZones(): ZoneDef[];
  on(event: GameEvent, cb: (data?: unknown) => void): () => void;
  /**
   * Optional: whether the mouse is captured with raw input (pointer lock with unadjustedMovement: no OS pointer
   * acceleration). null until the mouse was first captured; false when the browser only gave a plain pointer lock
   * (or m_rawinput is 0).
   */
  readonly rawInputActive?: boolean | null;
  /** Optional: what the 3D view renders with (Settings → Video → Graphics); null when unknown. */
  graphicsInfo?(): GraphicsInfo | null;
  /**
   * Optional: watch the KSF world record replay of the current map (like the `!wrreplay` chat command, whose
   * replies go to the chat; a replay already being watched is switched to the WR).
   */
  watchKsfWr?(): void;
}

/** The renderer's device and framebuffer (GameApi.graphicsInfo). */
export interface GraphicsInfo {
  /** GPU as the browser reports it (WebGL renderer string; '' when hidden). */
  renderer: string;
  vendor: string;
  /** MSAA samples in use (0 = off) and the counts the device supports. */
  samples: number;
  supportedSamples: number[];
  /** Size of the 3D view's framebuffer (canvas x devicePixelRatio x render scale) and of the canvas. */
  renderSize: [number, number];
  canvasSize: [number, number];
}

/** What the game can ask the UI to do. Implemented by ui/ui.ts. */
export interface UiApi {
  chat(segments: ChatSegment[]): void;
  /** Center hint box (env_hudhint, surf timer messages). */
  hint(text: string, seconds?: number): void;
  /** Big centered text (CS:GO's center print). */
  centerPrint(text: string, seconds?: number): void;
  setLoading(p: LoadProgress | null): void;
  showMenu(which: 'main' | 'pause' | 'none'): void;
  /** True while the console, chat input or a menu text field has focus (game ignores bound keys). */
  isTyping(): boolean;
  toggleConsole(): void;
  openChat(team?: boolean): void;
  setScoreboardVisible(visible: boolean): void;
  /** Called every rendered frame with fresh HUD data. */
  updateHud(hud: HudState): void;
}

// ------------------------------------------------------------------ audio

export type SoundName =
  | 'jump'
  | 'land'
  | 'land_hard'
  | 'footstep'
  | 'teleport'
  | 'zone_start'
  | 'zone_leave'
  | 'checkpoint'
  | 'stage'
  | 'finish'
  | 'pb'
  | 'wr'
  | 'fail'
  | 'booster'
  | 'water_enter'
  | 'water_exit'
  | 'ui_hover'
  | 'ui_click'
  | 'ui_back'
  | 'chat';

export interface SoundApi {
  /** Must be called from a user gesture to start WebAudio. */
  unlock(): void;
  play(name: SoundName, opts?: { volume?: number; pitch?: number }): void;
  /** Continuous air-rush sound driven by player speed (u/s) and whether airborne. */
  setWind(speed: number, airborne: boolean): void;
  setMasterVolume(v: number): void;
}

// ------------------------------------------------------------------ renderer

export interface ViewState {
  /** Eye position (origin + view offset), interpolated. */
  origin: Vec3;
  angles: QAngle;
  /** Source fov: horizontal degrees for a 4:3 aspect (default 90), like CS:GO's fov_cs_debug/90. */
  fov: number;
  /** Seconds since start, for animated materials. */
  time: number;
}

export interface GhostState {
  id: string;
  /** Feet position. */
  origin: Vec3;
  angles: QAngle;
  ducked: boolean;
  /** sRGB 0..1 */
  color: [number, number, number];
  name: string;
  visible: boolean;
  /** Draw a sprite trail behind the ghost. */
  trail: boolean;
}

export interface RenderSettings {
  fullbright: boolean;
  drawZones: boolean;
  drawTriggers: boolean;
  drawClips: boolean;
  wireframe: boolean;
  /** Brightness multiplier on top of lightmaps (mat_monitorgamma-like). */
  brightness: number;
  maxAnisotropy: number;
  /** 0..1 render scale (resolution scale). */
  renderScale: number;
  fogEnabled: boolean;
  drawSky3D: boolean;
  /** Optional: how zones are drawn when drawZones is on: outline on the zone's floor (default) or the full box. */
  zoneStyle?: 'floor' | 'box';
  /**
   * Optional: multisample anti-aliasing samples of the 3D view (mat_antialias: 0 off, 2, 4, 8; clamped to what the
   * device supports). Applied live.
   */
  antialias?: number;
  /** Optional: draw everything instead of only what the BSP's visibility sets say the eye's cluster can see (r_novis). */
  novis?: boolean;
  /**
   * Optional: draw an expensive sky (3D skybox, procedural sky) after the opaque world, only where it shows, with a
   * stencil (default true); false draws it first, everywhere, without one (r_skystencil 0: debug / GPU cost comparison).
   */
  skyStencil?: boolean;
}

export interface RendererApi {
  loadMap(map: import('../map/types').LoadedMap, onProgress?: (p: LoadProgress) => void): Promise<void>;
  unloadMap(): void;
  setModelVisible(model: number, visible: boolean): void;
  /** 0..1 alpha for brush entities with rendermode/renderamt. */
  setModelAlpha(model: number, alpha: number): void;
  setModelColor(model: number, rgb: [number, number, number]): void;
  setZones(zones: ZoneDef[], activeGroup: number): void;
  setGhosts(ghosts: GhostState[]): void;
  setSettings(s: Partial<RenderSettings>): void;
  render(view: ViewState): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** Debug lines/boxes (zone editor, triggers), cleared each frame by the caller. */
  setDebugBoxes(boxes: { mins: Vec3; maxs: Vec3; color: [number, number, number] }[]): void;
  stats(): { drawCalls: number; triangles: number; textures: number };
  /**
   * Optional: replaces the map's world fog at runtime (map logic `SetFogController`); null restores the map's
   * own fog. Reset by loadMap/unloadMap.
   */
  setFog?(fog: import('../map/types').FogDef | null): void;
  /** Optional: what the device supports, so the loader can prepare matching data (DXT textures with S3TC). */
  capabilities?(): RendererCapabilities;
  /**
   * Optional: places brush model `model` (a moving brush entity: func_door, func_rotating, trains, anything
   * parented to them) at its entity's current absolute `origin` + Source `angles`. The map's geometry was built
   * at the entity's spawn placement (bspcollision brushEntityPlacement); the renderer draws it moved by
   * placement * spawnPlacement^-1. The game sends render-interpolated placements every frame a mover moves.
   * Reset by loadMap/unloadMap.
   */
  setModelTransform?(model: number, origin: Vec3, angles: QAngle): void;
  /**
   * Optional: like setModelTransform for a model entity (prop_dynamic... parented to a mover): `entity` is its
   * index in LoadedMap.entities (RenderProp.entity), `origin`/`angles` its current absolute placement; its props
   * are drawn moved by placement * (the entity's spawn origin/angles)^-1.
   */
  setEntityTransform?(entity: number, origin: Vec3, angles: QAngle): void;
}

export interface RendererCapabilities {
  /** S3TC (DXT1/3/5, incl. sRGB) uploads: the loader may keep the VTFs' compressed mip chains. */
  compressedTextures: boolean;
  maxTextureSize: number;
}
