// Test harness for the game-world tests: a WorldHost/TimerHost with recording stubs, maps assembled from
// entity-lump text + box brushes, and a tick driver that mirrors the game loop order (docs/ARCHITECTURE.md).
import { readFileSync } from 'node:fs';
import { QAngle, qa } from '../src/core/angles';
import { Vec3, v3, v3clone } from '../src/core/vec3';
import { parseEntities } from '../src/bsp/entities';
import { BrushModelInfo, LoadedMap, MapEntity, SpawnPoint, ZoneDef, ZoneSource } from '../src/map/types';
import { CollisionWorld } from '../src/physics/collision';
import { brushFromBox } from '../src/physics/brushbuild';
import { categorizePosition, defaultMoveVars, playerMove } from '../src/physics/movement';
import {
  FL_BASEVELOCITY,
  MoveEvents,
  MoveVars,
  PlayerState,
  UserCmd,
  createPlayerState,
  newMoveEvents,
  newUserCmd,
} from '../src/physics/playertypes';
import { Brush, CONTENTS_SOLID } from '../src/physics/types';
import { ChatSegment, GhostState, LoadProgress, RenderSettings, RendererApi, SoundApi, SoundName, UiApi, HudState, ViewState } from '../src/game/api';
import { IEntitySystem, TimerHost } from '../src/game/contracts';

export interface Call {
  fn: string;
  args: unknown[];
}

export class MockRenderer implements RendererApi {
  calls: Call[] = [];
  visible = new Map<number, boolean>();
  alpha = new Map<number, number>();
  color = new Map<number, [number, number, number]>();
  async loadMap(_map: LoadedMap, _onProgress?: (p: LoadProgress) => void): Promise<void> {}
  unloadMap(): void {}
  setModelVisible(model: number, visible: boolean): void {
    this.calls.push({ fn: 'setModelVisible', args: [model, visible] });
    this.visible.set(model, visible);
  }
  setModelAlpha(model: number, alpha: number): void {
    this.calls.push({ fn: 'setModelAlpha', args: [model, alpha] });
    this.alpha.set(model, alpha);
  }
  setModelColor(model: number, rgb: [number, number, number]): void {
    this.calls.push({ fn: 'setModelColor', args: [model, rgb] });
    this.color.set(model, rgb);
  }
  setZones(_zones: ZoneDef[], _activeGroup: number): void {}
  setGhosts(_ghosts: GhostState[]): void {}
  setSettings(_s: Partial<RenderSettings>): void {}
  render(_view: ViewState): void {}
  resize(): void {}
  setDebugBoxes(): void {}
  stats(): { drawCalls: number; triangles: number; textures: number } {
    return { drawCalls: 0, triangles: 0, textures: 0 };
  }
}

export class MockUi implements UiApi {
  hints: { text: string; seconds?: number }[] = [];
  centers: { text: string; seconds?: number }[] = [];
  chats: ChatSegment[][] = [];
  chat(segments: ChatSegment[]): void {
    this.chats.push(segments);
  }
  hint(text: string, seconds?: number): void {
    this.hints.push({ text, seconds });
  }
  centerPrint(text: string, seconds?: number): void {
    this.centers.push({ text, seconds });
  }
  setLoading(): void {}
  showMenu(): void {}
  isTyping(): boolean {
    return false;
  }
  toggleConsole(): void {}
  openChat(): void {}
  setScoreboardVisible(): void {}
  updateHud(_hud: HudState): void {}
}

export class MockSound implements SoundApi {
  played: SoundName[] = [];
  unlock(): void {}
  play(name: SoundName): void {
    this.played.push(name);
  }
  setWind(): void {}
  setMasterVolume(): void {}
}

/** A CollisionWorld that records setModelSolid calls. */
export class SpyCollision extends CollisionWorld {
  solidCalls: [number, boolean][] = [];
  override setModelSolid(model: number, solid: boolean): void {
    this.solidCalls.push([model, solid]);
    super.setModelSolid(model, solid);
  }
}

export interface BoxModel {
  mins: [number, number, number];
  maxs: [number, number, number];
  /** Also add the brush to the collision world (solid brush entities). */
  solid?: boolean;
}

export interface MapSpec {
  name?: string;
  /** Entity lump text ({ "classname" ... } blocks). Model "*N" refers to models[N]. */
  entities?: string;
  /** Brush models 1..N (index 0 is the world). */
  models?: Record<number, BoxModel>;
  /** World brushes (model 0). */
  world?: BoxModel[];
  spawns?: SpawnPoint[];
  zones?: ZoneDef[];
  zoneSource?: ZoneSource;
}

export function boxBrush(m: BoxModel, model: number): Brush {
  return brushFromBox(v3(...m.mins), v3(...m.maxs), CONTENTS_SOLID, model);
}

export function buildMap(spec: MapSpec): { map: LoadedMap; collision: SpyCollision } {
  const ents: MapEntity[] = spec.entities ? parseEntities(spec.entities) : [];
  const models: BrushModelInfo[] = [];
  const worldBrushes = (spec.world ?? []).map((w) => boxBrush(w, 0));
  models[0] = { index: 0, mins: v3(-16384, -16384, -16384), maxs: v3(16384, 16384, 16384), origin: v3(), brushes: worldBrushes };
  const maxModel = Math.max(0, ...Object.keys(spec.models ?? {}).map(Number));
  const collisionBrushes: Brush[] = [...worldBrushes];
  for (let i = 1; i <= maxModel; i++) {
    const m = spec.models?.[i];
    if (!m) {
      models[i] = { index: i, mins: v3(), maxs: v3(), origin: v3(), brushes: [] };
      continue;
    }
    const b = boxBrush(m, i);
    models[i] = { index: i, mins: v3(...m.mins), maxs: v3(...m.maxs), origin: v3(), brushes: [b] };
    if (m.solid) collisionBrushes.push(boxBrush(m, i));
  }
  const collision = new SpyCollision(collisionBrushes);
  const spawns =
    spec.spawns ??
    ents
      .filter((e) => e.classname.startsWith('info_player_'))
      .map((e) => ({ origin: v3clone(e.origin), angles: { ...e.angles } }));
  const map: LoadedMap = {
    name: spec.name ?? 'surf_test',
    source: 'bsp',
    entities: ents,
    models,
    collision,
    render: {} as LoadedMap['render'],
    spawns,
    zones: spec.zones ?? [],
    zoneSource: spec.zoneSource ?? 'none',
    worldMins: v3(-16384, -16384, -16384),
    worldMaxs: v3(16384, 16384, 16384),
    warnings: [],
  };
  return { map, collision };
}

export interface TeleportCall {
  origin: Vec3;
  angles: QAngle | null;
  velocity: Vec3 | null;
}

/** WorldHost + TimerHost implementation for tests. */
export class MockHost implements TimerHost {
  map: LoadedMap;
  player: PlayerState;
  collision: CollisionWorld;
  renderer = new MockRenderer();
  ui = new MockUi();
  sound = new MockSound();
  moveVars: MoveVars = defaultMoveVars();
  time = 0;
  tickInterval = 0.01;
  tickCount = 0;
  customPhysics = false;
  tier: number | null = null;
  entities!: IEntitySystem;
  chats: ChatSegment[][] = [];
  prints: string[] = [];
  kills: string[] = [];
  teleports: TeleportCall[] = [];
  /** setModelSolid calls (when the collision world is a SpyCollision). */
  get solidCalls(): [number, boolean][] {
    return (this.collision as SpyCollision).solidCalls ?? [];
  }
  /** Called from killPlayer (e.g. timer.onPlayerKilled). */
  onKill: (() => void) | null = null;
  /** Called from teleportPlayer after moving (e.g. to mimic a core that notifies entities). */
  onTeleport: (() => void) | null = null;

  constructor(spec: MapSpec, origin: Vec3 = v3(), angles: QAngle = qa()) {
    const { map, collision } = buildMap(spec);
    this.map = map;
    this.collision = collision;
    this.player = createPlayerState(origin, angles);
  }

  teleportPlayer(origin: Vec3, angles: QAngle | null, velocity: Vec3 | null): void {
    this.teleports.push({ origin: v3clone(origin), angles: angles ? { ...angles } : null, velocity: velocity ? v3clone(velocity) : null });
    const ps = this.player;
    ps.origin.x = origin.x;
    ps.origin.y = origin.y;
    ps.origin.z = origin.z;
    if (angles) {
      ps.viewAngles.pitch = angles.pitch;
      ps.viewAngles.yaw = angles.yaw;
      ps.viewAngles.roll = angles.roll;
    }
    if (velocity) {
      ps.velocity.x = velocity.x;
      ps.velocity.y = velocity.y;
      ps.velocity.z = velocity.z;
    }
    this.onTeleport?.();
  }

  killPlayer(reason: string): void {
    this.kills.push(reason);
    this.onKill?.();
  }

  chat(segments: ChatSegment[]): void {
    this.chats.push(segments);
  }

  print(text: string): void {
    this.prints.push(text);
  }

  /** Chat lines as plain text. */
  chatText(): string[] {
    return this.chats.map((s) => s.map((x) => x.text).join(''));
  }

  /** Advances the clock by one tick (call before the systems' tick()). */
  advance(): void {
    this.tickCount++;
    this.time = this.tickCount * this.tickInterval;
  }

  setPos(x: number, y: number, z: number): void {
    this.player.origin.x = x;
    this.player.origin.y = y;
    this.player.origin.z = z;
  }
}

/** Mirrors the core's base-velocity handling before playerMove (ARCHITECTURE "tick order" step 2). */
export function applyBaseVelocity(ps: PlayerState, frametime: number): void {
  if (!(ps.flags & FL_BASEVELOCITY)) {
    ps.velocity.x += ps.baseVelocity.x * (1 + frametime * 0.5);
    ps.velocity.y += ps.baseVelocity.y * (1 + frametime * 0.5);
    ps.velocity.z += ps.baseVelocity.z * (1 + frametime * 0.5);
    ps.baseVelocity.x = ps.baseVelocity.y = ps.baseVelocity.z = 0;
  }
  ps.flags &= ~FL_BASEVELOCITY;
}

/** One full game tick with real movement: base velocity, playerMove, then the given systems. */
export function physicsTick(host: MockHost, cmd: UserCmd = newUserCmd(), systems: { tick(): void }[] = [], ev: MoveEvents = newMoveEvents()): void {
  host.advance();
  applyBaseVelocity(host.player, host.tickInterval);
  cmd.viewangles = { ...host.player.viewAngles };
  playerMove(host.player, cmd, host.collision, host.moveVars, host.tickInterval, ev);
  for (const s of systems) s.tick();
}

export function settle(host: MockHost): void {
  categorizePosition(host.player, host.collision, host.moveVars);
}

// ------------------------------------------------------------------------------------------ real maps

/** Builds a LoadedMap (no render data) from a BSP file using the bsp-core modules. */
export async function loadRealMap(path: string): Promise<LoadedMap> {
  const { parseBsp } = await import('../src/bsp/reader');
  const { parseEntities: parse } = await import('../src/bsp/entities');
  const { buildBrushModels, collectCollisionBrushes } = await import('../src/bsp/bspcollision');
  const buf = readFileSync(path);
  const bsp = parseBsp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const entities = parse(bsp.entitiesText);
  const models = buildBrushModels(bsp, { entities });
  const set = collectCollisionBrushes(bsp, entities, models);
  const collision = new CollisionWorld(set.brushes);
  for (const m of set.disabledModels) collision.setModelSolid(m, false);
  const spawns: SpawnPoint[] = entities
    .filter((e) => e.classname === 'info_player_terrorist' || e.classname === 'info_player_counterterrorist' || e.classname === 'info_player_start')
    .map((e) => ({ origin: v3clone(e.origin), angles: { ...e.angles } }));
  const name = path.replace(/^.*[\\/]/, '').replace(/\.bsp$/i, '');
  return {
    name,
    source: 'bsp',
    version: bsp.version,
    entities,
    models,
    collision,
    render: {} as LoadedMap['render'],
    spawns,
    zones: [],
    zoneSource: 'none',
    worldMins: v3(-16384, -16384, -16384),
    worldMaxs: v3(16384, 16384, 16384),
    warnings: [],
  };
}

/** A MockHost around an already-built map. */
export function hostForMap(map: LoadedMap, origin: Vec3 = v3()): MockHost {
  const h = new MockHost({ name: map.name }, origin);
  h.map = map;
  h.collision = map.collision;
  return h;
}
