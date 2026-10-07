// Loads a Source BSP into the game's LoadedMap: collision, entities, materials, render batches + lightmaps,
// sky, 3D skybox, fog, spawn points and Momentum timer zones.
//
// Phases (each reported through onProgress and separated by a macrotask yield so the page stays responsive):
//   parse      parseBsp (zero-copy views into `data`) + entity lump
//   collision  brush models (brush entities placed in world space), CollisionWorld over world brushes, solid
//              brush entities and displacement triangles (native two-sided triangle collision; the legacy thin
//              prism brushes via opts.displacementCollision); brush entities that start disabled are made non-solid
//   textures   pakfile, materials (VMT/VTF or procedural stand-ins), 2D sky, baked cubemaps
//   geometry   face areas, render batches + lightmap atlas + info_overlay decals, props (static props and
//              model entities) packed in the map, lit like the engine's light cache (leaf ambient + world lights)
// followed by the cheap entity-derived data (sky_camera, env_fog_controller, spawns, zones, bounds).
//
// Nothing in the returned LoadedMap references `data`: every array is decoded or copied, so the (possibly
// several hundred MB) BSP buffer can be dropped once this resolves.
import type { QAngle } from '../core/angles';
import { Vec3, v3 } from '../core/vec3';
import type { LoadProgress } from '../game/api';
import type {
  BrushModelInfo,
  CubemapDef,
  FogDef,
  LoadedMap,
  MapEntity,
  MaterialDef,
  RenderProp,
  Sky3D,
  SkyDef,
  SpawnPoint,
  ZoneDef,
  ZoneSource,
} from '../map/types';
import { CollisionWorld } from '../physics/collision';
import { HULL_MAXS, HULL_MINS } from '../physics/playertypes';
import { MASK_PLAYERSOLID, newTrace } from '../physics/types';
import { buildBrushModels, collectCollisionBrushes, createCollisionWorld } from './bspcollision';
import { faceAreas, pointLeaf } from './bsptree';
import { parseEntities } from './entities';
import { BuildRenderOptions, RenderBuildStats, buildRenderBatches } from './geometry';
import { BuildMaterialsOptions, buildMaterials, fallbackMaterial, loadCubemaps, loadSky, normalizeMaterialName, proceduralSky } from './materials';
import { PakFile } from './pakfile';
import { selectLightingSource } from './lightmap';
import { buildMapProps } from './props';
import { parseBsp } from './reader';
import { BspFile } from './types';

export interface LoadBspOptions {
  /** Passed to buildMaterials (texture size limit, extra file sources such as linked game content, DXT...). */
  materials?: BuildMaterialsOptions;
  /** Render batch options (cell size, lightmap atlas limit...). */
  render?: Omit<BuildRenderOptions, 'entities' | 'warnings' | 'stats'>;
  /** Decode static props and prop_dynamic/prop_physics models packed in the map (default true). */
  props?: boolean;
  /** Largest prop texture size (default 512, or 1024 with materials.compressedTextures). */
  propTextureSize?: number;
  /** Decode baked env_cubemaps (default true). */
  cubemaps?: boolean;
  /** Timing/summary log (default console.info). Pass () => {} to silence. */
  log?: (msg: string) => void;
  /**
   * Displacement collision: 'triangles' (default) collides with the displacement triangles directly;
   * 'prisms' builds the legacy thin prism brush per triangle (several seconds and ~400 MB on
   * displacement-heavy maps; kept for comparison).
   */
  displacementCollision?: 'triangles' | 'prisms';
}

const SPAWN_CLASSES = ['info_player_terrorist', 'info_player_counterterrorist', 'info_player_start', 'info_player_deathmatch'];

/** Yields to the event loop (a macrotask, so rendering/input get a turn between heavy phases). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** "maps/Surf_Kitsune.bsp" -> "Surf_Kitsune" (directories and the .bsp / .bsp.bz2 extension removed). */
export function mapNameFromFile(name: string): string {
  let n = (name ?? '').replace(/\\/g, '/');
  n = n.slice(n.lastIndexOf('/') + 1);
  n = n.replace(/\.bz2$/i, '').replace(/\.bsp$/i, '');
  return n || 'unnamed';
}

function num(s: string | undefined, def: number): number {
  if (s === undefined) return def;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : def;
}

function parseColor255(s: string | undefined, def: [number, number, number]): [number, number, number] {
  if (!s) return def;
  const p = s.trim().split(/[\s,]+/).map((x) => parseFloat(x));
  if (p.length < 3 || !p.slice(0, 3).every((x) => Number.isFinite(x))) return def;
  const c = (x: number) => Math.max(0, Math.min(1, x / 255));
  return [c(p[0]), c(p[1]), c(p[2])];
}

/** Fog from fog keyvalues (env_fog_controller / sky_camera): fogenable, fogcolor, fogstart, fogend, fogmaxdensity. */
export function fogFromKeyValues(kv: Record<string, string>): FogDef {
  return {
    enabled: (kv.fogenable ?? '0').trim() !== '0' && (kv.fogenable ?? '').trim() !== '',
    color: parseColor255(kv.fogcolor, [1, 1, 1]),
    start: num(kv.fogstart, 500),
    end: num(kv.fogend, 2000),
    maxDensity: Math.max(0, Math.min(1, num(kv.fogmaxdensity, 1))),
  };
}

/**
 * The map's fog: the env_fog_controller flagged "Master" (spawnflags 1) when there is one, else the first one
 * in the entity lump (that's the controller the engine gives players on spawn). Null without controllers.
 */
export function mapFog(entities: MapEntity[]): FogDef | null {
  const ctrls = entities.filter((e) => e.classname.toLowerCase() === 'env_fog_controller');
  if (!ctrls.length) return null;
  const master = ctrls.find((e) => ((parseInt(e.kv.spawnflags ?? '0', 10) || 0) & 1) !== 0);
  return fogFromKeyValues((master ?? ctrls[0]).kv);
}

/** 3D skybox parameters from the sky_camera entity (null without one). */
export function mapSky3D(bsp: BspFile, entities: MapEntity[]): Sky3D | null {
  const cam = entities.find((e) => e.classname.toLowerCase() === 'sky_camera');
  if (!cam) return null;
  let scale = num(cam.kv.scale, 16);
  if (!(scale > 0)) scale = 16;
  const leaf = pointLeaf(bsp, cam.origin);
  const area = leaf >= 0 && leaf < bsp.leafs.length ? bsp.leafs[leaf].area : -1;
  const hasFog = cam.kv.fogenable !== undefined || cam.kv.fogcolor !== undefined;
  return {
    origin: v3(cam.origin.x, cam.origin.y, cam.origin.z),
    scale,
    area,
    fog: hasFog ? fogFromKeyValues(cam.kv) : null,
  };
}

/**
 * Spawn points: info_player_terrorist, then counterterrorist, then info_player_start / deathmatch, in entity
 * order. The player is placed one unit above the spawn entity like the engine does. Spawns where the standing
 * hull is stuck in solid are moved to the end of the list. With no spawn entity at all, a spot on the floor of
 * the biggest open leaf is used.
 */
export function mapSpawns(bsp: BspFile, entities: MapEntity[], world: CollisionWorld, warnings?: string[]): SpawnPoint[] {
  const found: SpawnPoint[] = [];
  for (const cls of SPAWN_CLASSES) {
    for (const e of entities) {
      if (e.classname.toLowerCase() !== cls) continue;
      const o = e.origin;
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) continue;
      const angles: QAngle = { pitch: e.angles.pitch || 0, yaw: e.angles.yaw || 0, roll: 0 };
      found.push({ origin: v3(o.x, o.y, o.z + 1), angles });
    }
  }
  if (found.length) {
    const ok: SpawnPoint[] = [];
    const stuck: SpawnPoint[] = [];
    for (const s of found) {
      let blocked = false;
      try {
        blocked = world.testBox(s.origin, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
      } catch {
        blocked = false;
      }
      (blocked ? stuck : ok).push(s);
    }
    if (stuck.length && warnings) warnings.push(`${stuck.length} of ${found.length} spawn points are stuck in solid`);
    return [...ok, ...stuck];
  }
  const fb = fallbackSpawn(bsp, world);
  if (warnings) warnings.push('no spawn point entities; using a fallback spawn');
  return [fb];
}

/** A standing spot on the floor of one of the biggest empty leaves (or the world centre as a last resort). */
function fallbackSpawn(bsp: BspFile, world: CollisionWorld): SpawnPoint {
  const leaves: { i: number; vol: number }[] = [];
  for (let i = 0; i < bsp.leafs.length; i++) {
    const l = bsp.leafs[i];
    if (l.contents & 1 || l.cluster < 0) continue;
    const vol = (l.maxs.x - l.mins.x) * (l.maxs.y - l.mins.y) * (l.maxs.z - l.mins.z);
    if (vol > 0) leaves.push({ i, vol });
  }
  leaves.sort((a, b) => b.vol - a.vol);
  const tr = newTrace();
  for (const { i } of leaves.slice(0, 64)) {
    const l = bsp.leafs[i];
    const c = v3((l.mins.x + l.maxs.x) / 2, (l.mins.y + l.maxs.y) / 2, (l.mins.z + l.maxs.z) / 2);
    try {
      if (world.testBox(c, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)) continue;
      world.traceBox(c, v3(c.x, c.y, c.z - 8192), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    } catch {
      continue;
    }
    if (tr.startsolid || tr.fraction >= 1 || tr.plane.normal.z < 0.7) continue;
    return { origin: v3(tr.endpos.x, tr.endpos.y, tr.endpos.z + 1), angles: { pitch: 0, yaw: 0, roll: 0 } };
  }
  const w = bsp.models[0];
  const center = w ? v3((w.mins.x + w.maxs.x) / 2, (w.mins.y + w.maxs.y) / 2, (w.mins.z + w.maxs.z) / 2) : v3();
  return { origin: center, angles: { pitch: 0, yaw: 0, roll: 0 } };
}

function finiteBox(m: BrushModelInfo | undefined): m is BrushModelInfo {
  return (
    !!m &&
    [m.mins.x, m.mins.y, m.mins.z, m.maxs.x, m.maxs.y, m.maxs.z].every((x) => Number.isFinite(x)) &&
    m.maxs.x > m.mins.x &&
    m.maxs.y > m.mins.y &&
    m.maxs.z > m.mins.z
  );
}

/**
 * A standing spot inside zone `z` (the floor under its centre, within the zone's height or up to 128 units
 * below it) facing `angles`, or undefined when the hull doesn't fit there.
 */
function zoneSpawn(world: CollisionWorld, z: ZoneDef, angles: QAngle): ZoneDef['spawn'] {
  const c = v3((z.mins.x + z.maxs.x) / 2, (z.mins.y + z.maxs.y) / 2, 0);
  const tr = newTrace();
  for (const sz of [z.maxs.z - HULL_MAXS.z - 1, (z.mins.z + z.maxs.z) / 2]) {
    const start = v3(c.x, c.y, Math.max(z.mins.z, sz));
    try {
      if (world.testBox(start, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)) continue;
      world.traceBox(start, v3(c.x, c.y, z.mins.z - 128), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    } catch {
      return undefined;
    }
    if (tr.startsolid || tr.fraction >= 1 || tr.plane.normal.z < 0.7) continue;
    const p = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z + 1);
    if (p.z > z.maxs.z) continue;
    return { origin: p, angles: { ...angles } };
  }
  return undefined;
}

/**
 * Timer zones from Momentum Mod triggers: trigger_momentum_timer_start -> 'start', _stop -> 'end',
 * _stage ("stage" key, 2..N) -> 'stage', _checkpoint ("checkpoint" key) -> 'checkpoint'. Boxes are the trigger
 * models' world-space bounds; the course is "track_number" (or "bonus"), 0 = main. Start/stage zones with
 * "lookangles" get a spawn on their floor facing that way (used for !r / !s restarts).
 */
export function momentumZones(entities: MapEntity[], models: BrushModelInfo[], world: CollisionWorld | null): ZoneDef[] {
  const out: ZoneDef[] = [];
  const int = (e: MapEntity, k: string): number => {
    const n = parseInt(e.kv[k] ?? '', 10);
    return Number.isFinite(n) ? n : 0;
  };
  for (const e of entities) {
    const cls = e.classname.toLowerCase();
    if (!cls.startsWith('trigger_momentum_timer_') || e.model <= 0) continue;
    const m = models[e.model];
    if (!finiteBox(m)) continue;
    const group = Math.max(0, int(e, 'track_number'), int(e, 'bonus'));
    let zone: ZoneDef;
    const box = { mins: v3(m.mins.x, m.mins.y, m.mins.z), maxs: v3(m.maxs.x, m.maxs.y, m.maxs.z) };
    if (cls === 'trigger_momentum_timer_start') zone = { type: 'start', group, index: 0, ...box };
    else if (cls === 'trigger_momentum_timer_stop') zone = { type: 'end', group, index: 0, ...box };
    else if (cls === 'trigger_momentum_timer_stage') {
      const index = int(e, 'stage') || int(e, 'zone_number');
      if (index < 2) continue; // stage 1 begins at the start zone
      zone = { type: 'stage', group, index, ...box };
    } else if (cls === 'trigger_momentum_timer_checkpoint') {
      zone = { type: 'checkpoint', group, index: int(e, 'checkpoint') || int(e, 'zone_number'), ...box };
    } else continue;
    if (world && (zone.type === 'start' || zone.type === 'stage') && e.kv.lookangles !== undefined) {
      const p = e.kv.lookangles.trim().split(/[\s,]+/).map((x) => parseFloat(x));
      if (p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        const sp = zoneSpawn(world, zone, { pitch: p[0], yaw: p[1], roll: 0 });
        if (sp) zone.spawn = sp;
      }
    }
    out.push(zone);
  }
  return out;
}

function worldBounds(models: BrushModelInfo[]): { mins: Vec3; maxs: Vec3 } {
  const mins = v3(Infinity, Infinity, Infinity);
  const maxs = v3(-Infinity, -Infinity, -Infinity);
  for (const m of models) {
    if (!finiteBox(m)) continue;
    mins.x = Math.min(mins.x, m.mins.x);
    mins.y = Math.min(mins.y, m.mins.y);
    mins.z = Math.min(mins.z, m.mins.z);
    maxs.x = Math.max(maxs.x, m.maxs.x);
    maxs.y = Math.max(maxs.y, m.maxs.y);
    maxs.z = Math.max(maxs.z, m.maxs.z);
  }
  if (!Number.isFinite(mins.x)) return { mins: v3(-1, -1, -1), maxs: v3(1, 1, 1) };
  return { mins, maxs };
}

/**
 * Loads a BSP map. `name` is the map name (a file name is accepted: path and .bsp are stripped). Throws
 * BspError for files that aren't Source maps; everything after parsing degrades gracefully (problems end up
 * in LoadedMap.warnings).
 */
export async function loadBspMap(
  name: string,
  data: ArrayBuffer,
  onProgress?: (p: LoadProgress) => void,
  opts: LoadBspOptions = {},
): Promise<LoadedMap> {
  const mapName = mapNameFromFile(name);
  const log = opts.log ?? ((m: string) => console.info(m));
  const warnings: string[] = [];
  const timings: string[] = [];
  const t0 = now();
  let tPhase = t0;
  const lap = (label: string): void => {
    const t = now();
    timings.push(`${label} ${Math.round(t - tPhase)}`);
    tPhase = t;
  };
  const progress = (phase: LoadProgress['phase'], message: string, step: number): void => {
    try {
      onProgress?.({ phase, message, loaded: step, total: 4 });
    } catch {
      // a broken progress callback must not break loading
    }
  };

  // ---------------------------------------------------------------- parse
  progress('parse', `Parsing ${mapName}.bsp (${(data.byteLength / 1048576).toFixed(1)} MB)`, 0);
  await yieldToEventLoop();
  tPhase = now();
  const bsp = parseBsp(data);
  for (const w of bsp.warnings ?? []) warnings.push(`bsp: ${w}`);
  let entities: MapEntity[] = [];
  try {
    entities = parseEntities(bsp.entitiesText);
  } catch (e) {
    warnings.push(`entities: ${(e as Error).message}`);
  }
  lap('parse');

  // ---------------------------------------------------------------- collision
  progress('collision', 'Building collision', 1);
  await yieldToEventLoop();
  tPhase = now();
  const models = buildBrushModels(bsp, { entities, warnings });
  const set = collectCollisionBrushes(bsp, entities, models, { displacements: opts.displacementCollision ?? 'triangles' });
  for (const w of set.warnings) warnings.push(w);
  const collision = createCollisionWorld(set);
  lap('collision');

  // ---------------------------------------------------------------- textures
  progress('textures', 'Loading textures', 2);
  await yieldToEventLoop();
  tPhase = now();
  let pak: PakFile | null = null;
  if (bsp.pakfile) {
    try {
      pak = new PakFile(bsp.pakfile);
      for (const w of pak.warnings) warnings.push(w);
    } catch (e) {
      warnings.push(`pakfile: ${(e as Error).message}`);
    }
  }
  let materials: Map<string, MaterialDef>;
  try {
    materials = buildMaterials(bsp, pak, opts.materials);
  } catch (e) {
    warnings.push(`materials: ${(e as Error).message}; using procedural materials`);
    materials = new Map();
    bsp.texdataNames.forEach((n, i) => {
      const key = normalizeMaterialName(n ?? '');
      const td = bsp.texdata[i];
      if (key && !materials.has(key)) materials.set(key, fallbackMaterial(key, td?.reflectivity, td?.width, td?.height));
    });
  }
  const worldspawn = entities.find((e) => e.classname.toLowerCase() === 'worldspawn');
  const skyName = (worldspawn?.kv.skyname ?? '').trim();
  let sky: SkyDef = { name: skyName, faces: null };
  try {
    sky = loadSky(skyName, pak, { extraSources: opts.materials?.extraSources });
  } catch (e) {
    warnings.push(`sky: ${(e as Error).message}`);
  }
  if (!sky.faces) {
    try {
      sky = { ...proceduralSky(skyName || 'sky_day01_01'), name: skyName };
    } catch {
      // keep faces null: the renderer draws its own sky colour
    }
  }
  let cubemaps: CubemapDef[] = [];
  if (opts.cubemaps !== false) {
    try {
      cubemaps = loadCubemaps(bsp, pak, { extraSources: opts.materials?.extraSources });
    } catch (e) {
      warnings.push(`cubemaps: ${(e as Error).message}`);
    }
  }
  lap('textures');

  // ---------------------------------------------------------------- geometry
  progress('geometry', 'Building geometry', 3);
  await yieldToEventLoop();
  tPhase = now();
  let areas: Int32Array | undefined;
  try {
    areas = faceAreas(bsp);
  } catch (e) {
    warnings.push(`face areas: ${(e as Error).message}`);
  }
  const stats = {} as RenderBuildStats;
  const { batches, lightmap } = buildRenderBatches(bsp, materials, areas, { ...opts.render, entities, warnings, stats });
  let props: RenderProp[] = [];
  if (opts.props !== false && bsp.gameLumps.length + entities.length > 0) {
    progress('geometry', 'Loading props', 3);
    await yieldToEventLoop();
    try {
      const hdrLighting = selectLightingSource(bsp, opts.render?.lighting === 'hdr')?.hdr ?? false;
      props = buildMapProps(bsp, entities, pak, materials, {
        warnings,
        materials: opts.materials,
        maxTextureSize: opts.propTextureSize,
        hdrLighting,
        world: collision,
      });
    } catch (e) {
      warnings.push(`props: ${(e as Error).message}`);
    }
  }
  lap('geometry');

  // ---------------------------------------------------------------- entity-derived data
  let sky3d: Sky3D | null = null;
  try {
    sky3d = mapSky3D(bsp, entities);
  } catch (e) {
    warnings.push(`sky_camera: ${(e as Error).message}`);
  }
  const fog = mapFog(entities);
  const spawns = mapSpawns(bsp, entities, collision, warnings);
  let zones: ZoneDef[] = [];
  try {
    zones = momentumZones(entities, models, collision);
  } catch (e) {
    warnings.push(`momentum zones: ${(e as Error).message}`);
  }
  const zoneSource: ZoneSource = zones.length ? 'momentum' : 'none';
  const bounds = worldBounds(models);
  lap('entities');

  const total = Math.round(now() - t0);
  log(
    `[loadmap] ${mapName}: ${total} ms (${timings.join(', ')} ms) - v${bsp.version}, ${bsp.faces.length} faces -> ` +
      `${stats.batches} batches / ${stats.triangles} tris, lightmap ${lightmap ? `${lightmap.width}x${lightmap.height}` : 'none'}, ` +
      `${set.brushes.length} collision brushes + ${collision.triangleCount} triangles, ${materials.size} materials, ${props.length} props, ${entities.length} entities, ` +
      `${spawns.length} spawns, ${zones.length} zones, ${warnings.length} warnings`,
  );

  return {
    name: mapName,
    source: 'bsp',
    version: bsp.version,
    entities,
    models,
    collision,
    render: {
      batches,
      lightmap,
      materials,
      sky,
      sky3d,
      fog,
      props,
      cubemaps,
    },
    spawns,
    zones,
    zoneSource,
    worldMins: bounds.mins,
    worldMaxs: bounds.maxs,
    warnings,
  };
}
