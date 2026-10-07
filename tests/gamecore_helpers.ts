// Test doubles for the game-core tests: a recording renderer / UI / sound, a small box map with timer zones, and
// a Game wired to them with injected map loaders (no DOM, no network).
import { v3 } from '../src/core/vec3';
import type {
  ChatSegment,
  GhostState,
  HudState,
  LoadProgress,
  RenderSettings,
  RendererApi,
  SoundApi,
  SoundName,
  UiApi,
  ViewState,
} from '../src/game/api';
import { Game, MapLoaders } from '../src/game/game';
import { setRecordsStorage } from '../src/game/records';
import { parseEntities } from '../src/bsp/entities';
import { BrushModelInfo, LoadedMap, ZoneDef } from '../src/map/types';
import { setCatalog } from '../src/maps/catalog';
import { setZonesFile } from '../src/maps/zones';
import { brushFromBox } from '../src/physics/brushbuild';
import { CollisionWorld } from '../src/physics/collision';
import { Brush, CONTENTS_SOLID } from '../src/physics/types';

export class FakeRenderer implements RendererApi {
  loaded: LoadedMap | null = null;
  unloads = 0;
  renders: ViewState[] = [];
  zones: { zones: ZoneDef[]; group: number }[] = [];
  ghosts: GhostState[][] = [];
  settings: Partial<RenderSettings> = {};
  debugBoxes: { mins: unknown; maxs: unknown; color: [number, number, number] }[][] = [];
  resizes: [number, number, number][] = [];
  /** Delay (ms) for loadMap, to test aborts during upload (per map name, or for every map). */
  loadDelay: number | ((map: LoadedMap) => number) = 0;
  /** loadMap calls in flight (must never exceed 1: uploads are serialized). */
  inFlight = 0;
  maxInFlight = 0;
  uploads: string[] = [];
  failNext: Error | null = null;
  async loadMap(map: LoadedMap, onProgress?: (p: LoadProgress) => void): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      onProgress?.({ phase: 'renderer', message: 'uploading' });
      const d = typeof this.loadDelay === 'function' ? this.loadDelay(map) : this.loadDelay;
      if (d) await new Promise((r) => setTimeout(r, d));
      if (this.failNext) {
        const e = this.failNext;
        this.failNext = null;
        throw e;
      }
      this.loaded = map;
      this.uploads.push(map.name);
    } finally {
      this.inFlight--;
    }
  }
  unloadMap(): void {
    this.unloads++;
    this.loaded = null;
  }
  setModelVisible(): void {}
  setModelAlpha(): void {}
  setModelColor(): void {}
  setZones(zones: ZoneDef[], activeGroup: number): void {
    this.zones.push({ zones, group: activeGroup });
  }
  setGhosts(ghosts: GhostState[]): void {
    this.ghosts.push(ghosts);
  }
  setSettings(s: Partial<RenderSettings>): void {
    Object.assign(this.settings, s);
  }
  render(view: ViewState): void {
    this.renders.push({ origin: { ...view.origin }, angles: { ...view.angles }, fov: view.fov, time: view.time });
  }
  resize(w: number, h: number, dpr: number): void {
    this.resizes.push([w, h, dpr]);
  }
  setDebugBoxes(boxes: { mins: unknown; maxs: unknown; color: [number, number, number] }[]): void {
    this.debugBoxes.push([...boxes]);
  }
  stats() {
    return { drawCalls: 0, triangles: 0, textures: 0 };
  }
}

export class FakeUi implements UiApi {
  chats: ChatSegment[][] = [];
  hints: string[] = [];
  centers: string[] = [];
  loading: (LoadProgress | null)[] = [];
  menus: string[] = [];
  typing = false;
  consoleToggles = 0;
  chatOpens: boolean[] = [];
  scoreboard: boolean[] = [];
  huds = 0;
  lastHud: HudState | null = null;
  chat(segments: ChatSegment[]): void {
    this.chats.push(segments);
  }
  hint(text: string): void {
    this.hints.push(text);
  }
  centerPrint(text: string): void {
    this.centers.push(text);
  }
  setLoading(p: LoadProgress | null): void {
    this.loading.push(p);
  }
  showMenu(which: 'main' | 'pause' | 'none'): void {
    this.menus.push(which);
  }
  isTyping(): boolean {
    return this.typing;
  }
  toggleConsole(): void {
    this.consoleToggles++;
  }
  openChat(team?: boolean): void {
    this.chatOpens.push(!!team);
  }
  setScoreboardVisible(v: boolean): void {
    this.scoreboard.push(v);
  }
  updateHud(hud: HudState): void {
    this.huds++;
    this.lastHud = hud;
  }
  /** Chat lines as plain text. */
  texts(): string[] {
    return this.chats.map((l) => l.map((s) => s.text).join(''));
  }
  lastText(): string {
    const t = this.texts();
    return t[t.length - 1] ?? '';
  }
}

export class FakeSound implements SoundApi {
  played: SoundName[] = [];
  wind: [number, boolean][] = [];
  unlock(): void {}
  play(name: SoundName): void {
    this.played.push(name);
  }
  setWind(speed: number, airborne: boolean): void {
    this.wind.push([speed, airborne]);
  }
  setMasterVolume(): void {}
}

function box(mins: [number, number, number], maxs: [number, number, number]): Brush {
  return brushFromBox(v3(...mins), v3(...maxs), CONTENTS_SOLID, 0);
}

export interface TestMapOptions {
  name?: string;
  /** Timer zones (default: start zone around the spawn, end zone at +x 1500). */
  zones?: ZoneDef[];
  /** Extra world brushes. */
  extra?: Brush[];
  /** Entity lump text ("model" "*N" refers to `models[N]`). */
  entities?: string;
  /** Brush models 1..N (trigger volumes; not solid). */
  models?: Record<number, { mins: [number, number, number]; maxs: [number, number, number] }>;
}

/**
 * A flat 4096² floor (top at z = 0) with walls, spawn at the origin facing +x, a start zone around the spawn
 * and an end zone 1500 units ahead.
 */
export function makeTestMap(opts: TestMapOptions = {}): LoadedMap {
  const brushes: Brush[] = [
    box([-2048, -2048, -64], [2048, 2048, 0]),
    box([-2112, -2048, -64], [-2048, 2048, 1024]),
    box([2048, -2048, -64], [2112, 2048, 1024]),
    box([-2048, -2112, -64], [2048, -2048, 1024]),
    box([-2048, 2048, -64], [2048, 2112, 1024]),
    ...(opts.extra ?? []),
  ];
  const collision = new CollisionWorld(brushes);
  const models: BrushModelInfo[] = [{ index: 0, mins: v3(-2112, -2112, -64), maxs: v3(2112, 2112, 1024), origin: v3(), brushes }];
  const maxModel = Math.max(0, ...Object.keys(opts.models ?? {}).map(Number));
  for (let i = 1; i <= maxModel; i++) {
    const m = opts.models?.[i];
    models[i] = m
      ? { index: i, mins: v3(...m.mins), maxs: v3(...m.maxs), origin: v3(), brushes: [brushFromBox(v3(...m.mins), v3(...m.maxs), CONTENTS_SOLID, i)] }
      : { index: i, mins: v3(), maxs: v3(), origin: v3(), brushes: [] };
  }
  const zones: ZoneDef[] = opts.zones ?? [
    { type: 'start', group: 0, index: 0, mins: v3(-128, -128, 0), maxs: v3(128, 128, 128) },
    { type: 'end', group: 0, index: 0, mins: v3(1400, -256, 0), maxs: v3(1600, 256, 128) },
  ];
  return {
    name: opts.name ?? 'surf_gamecore_test',
    source: 'builtin',
    entities: opts.entities ? parseEntities(opts.entities) : [],
    models,
    collision,
    render: {} as LoadedMap['render'],
    spawns: [{ origin: v3(0, 0, 0), angles: { pitch: 0, yaw: 0, roll: 0 } }],
    zones,
    zoneSource: 'builtin',
    worldMins: v3(-2112, -2112, -64),
    worldMaxs: v3(2112, 2112, 1024),
    warnings: [],
  };
}

export interface TestGame {
  game: Game;
  renderer: FakeRenderer;
  ui: FakeUi;
  sound: FakeSound;
  map: LoadedMap;
}

/** Fresh process-wide state for a test: in-memory records, no zone presets, an empty catalog. */
export class MemStore {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

export function resetGlobals(): void {
  setRecordsStorage(new MemStore());
  setZonesFile(null);
  setCatalog([]);
}

/** A Game around a test map (not started: drive it with game.frame() / game.runTicks()). */
export function makeGame(map: LoadedMap = makeTestMap(), loaders: Partial<MapLoaders> = {}): TestGame {
  const renderer = new FakeRenderer();
  const ui = new FakeUi();
  const sound = new FakeSound();
  const game = new Game({
    renderer,
    ui,
    sound,
    canvas: {} as HTMLCanvasElement,
    loaders: {
      buildBuiltin: async () => map,
      builtinMaps: async () => [{ id: 'test', name: 'Test map', tier: 2 }],
      catalog: async () => [],
      ...loaders,
    },
  });
  return { game, renderer, ui, sound, map };
}

/** makeGame + load the map as the built-in "test". */
export async function loadedGame(map: LoadedMap = makeTestMap(), loaders: Partial<MapLoaders> = {}): Promise<TestGame> {
  const t = makeGame(map, loaders);
  await t.game.loadBuiltinMap('test');
  return t;
}
