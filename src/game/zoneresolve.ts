// Picks the timer zones for a loaded map, by priority:
//   1. user zones (zone editor, localStorage)        -> 'user'
//   2. SurfTimer presets (exact name, then other builds of the same map) -> 'preset'
//   3. zones shipped with the map (built-in maps, Momentum trigger entities) -> map.zoneSource
//      (Momentum timer triggers are converted here too if the loader left map.zones empty)
//   4. a start zone around the spawn points (no end zone) -> 'heuristic'
// User and preset zones were made for some build of the map; they are only used when they fit THIS build:
// broken boxes are dropped and a plausible start zone must remain (a spawn point within ~2048 units of it,
// a teleport destination inside it, or a floor under its center where the player hull fits).
import { Vec3, v3 } from '../core/vec3';
import { LoadedMap, ZoneDef, ZoneSource, ZoneType } from '../map/types';
import { getPresetZoneCandidates, loadUserZones } from '../maps/zones';
import { HULL_MAXS, HULL_MINS } from '../physics/playertypes';
import { MASK_PLAYERSOLID, newTrace } from '../physics/types';

const ZONE_TYPES = new Set<ZoneType>([
  'start',
  'end',
  'stage',
  'checkpoint',
  'stop',
  'speedstart',
  'teletostart',
  'validator',
  'checker',
  'antijump',
  'antiduck',
  'maxspeed',
]);

/** Largest sane zone extent (Source maps are at most 32768 units across). */
const MAX_EXTENT = 32768;
/** A spawn this close to a start zone's center makes it plausible. */
const SPAWN_RADIUS = 2048;
/** Spawn points closer than this to each other belong to the same cluster. */
const CLUSTER_GAP = 256;

function finite(v: Vec3 | undefined): v is Vec3 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Drops unusable zones (unknown type, non-finite or zero-size boxes such as the all-zero placeholders in the
 * preset database) and normalizes the rest (min/max order, integer group/index). Returns copies.
 */
export function sanitizeZones(zones: readonly ZoneDef[]): ZoneDef[] {
  const out: ZoneDef[] = [];
  for (const z of zones) {
    if (!z || !ZONE_TYPES.has(z.type) || !finite(z.mins) || !finite(z.maxs)) continue;
    const mins = v3(Math.min(z.mins.x, z.maxs.x), Math.min(z.mins.y, z.maxs.y), Math.min(z.mins.z, z.maxs.z));
    const maxs = v3(Math.max(z.mins.x, z.maxs.x), Math.max(z.mins.y, z.maxs.y), Math.max(z.mins.z, z.maxs.z));
    const ex = maxs.x - mins.x;
    const ey = maxs.y - mins.y;
    const ez = maxs.z - mins.z;
    if (!(ex > 0 && ey > 0 && ez > 0)) continue;
    if (ex > MAX_EXTENT || ey > MAX_EXTENT || ez > MAX_EXTENT) continue;
    const d: ZoneDef = {
      type: z.type,
      group: Math.max(0, Math.trunc(Number(z.group) || 0)),
      index: Math.trunc(Number(z.index) || 0),
      mins,
      maxs,
    };
    if (z.prespeed !== undefined && Number.isFinite(z.prespeed)) d.prespeed = z.prespeed;
    if (z.spawn && finite(z.spawn.origin) && z.spawn.angles) {
      d.spawn = { origin: v3(z.spawn.origin.x, z.spawn.origin.y, z.spawn.origin.z), angles: { ...z.spawn.angles } };
    }
    out.push(d);
  }
  return out;
}

function center(z: ZoneDef): Vec3 {
  return v3((z.mins.x + z.maxs.x) / 2, (z.mins.y + z.maxs.y) / 2, (z.mins.z + z.maxs.z) / 2);
}

/**
 * Hull-fit floor test: traces the player hull down from the zone's top (or mid-height) at a few points of its
 * footprint; plausible when it lands within the zone's height range (or up to 128 units under it) on a spot
 * where the hull is free.
 */
function floorFits(map: LoadedMap, z: ZoneDef): boolean {
  const world = map.collision;
  if (!world) return false;
  const c = center(z);
  const qx = (z.maxs.x - z.mins.x) / 4;
  const qy = (z.maxs.y - z.mins.y) / 4;
  const points: [number, number][] = [
    [c.x, c.y],
    [c.x - qx, c.y - qy],
    [c.x + qx, c.y - qy],
    [c.x - qx, c.y + qy],
    [c.x + qx, c.y + qy],
  ];
  const tr = newTrace();
  for (const [x, y] of points) {
    const end = v3(x, y, z.mins.z - 128);
    for (const sz of [z.maxs.z, c.z]) {
      try {
        world.traceBox(v3(x, y, sz), end, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
      } catch {
        return false;
      }
      if (tr.startsolid || tr.allsolid) continue;
      if (tr.fraction >= 1) break; // nothing below this point
      const p = tr.endpos;
      if (p.z < z.mins.z - 128 || p.z > z.maxs.z) break;
      let stuck = false;
      try {
        stuck = world.testBox(p, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
      } catch {
        stuck = true;
      }
      if (!stuck) return true;
      break;
    }
  }
  return false;
}

/** Is this start zone believable on this build of the map? */
export function zonePlausible(map: LoadedMap, z: ZoneDef): boolean {
  const c = center(z);
  for (const s of map.spawns) {
    const dx = s.origin.x - c.x;
    const dy = s.origin.y - c.y;
    const dz = s.origin.z - c.z;
    if (dx * dx + dy * dy + dz * dz <= SPAWN_RADIUS * SPAWN_RADIUS) return true;
  }
  for (const e of map.entities) {
    if (e.classname.toLowerCase() !== 'info_teleport_destination') continue;
    const o = e.origin;
    if (o.x >= z.mins.x && o.x <= z.maxs.x && o.y >= z.mins.y && o.y <= z.maxs.y && o.z >= z.mins.z - 32 && o.z <= z.maxs.z + 512) return true;
  }
  return floorFits(map, z);
}

/**
 * Sanitized zones if they fit the map, else null. `group0` requires a plausible main-course start zone
 * (presets); otherwise any plausible start zone will do (user zones may cover only a bonus).
 */
export function validateZones(map: LoadedMap, zones: readonly ZoneDef[] | null | undefined, group0: boolean): ZoneDef[] | null {
  if (!zones || !zones.length) return null;
  const clean = sanitizeZones(zones);
  const starts = clean.filter((z) => (z.type === 'start' || z.type === 'speedstart') && (!group0 || z.group === 0));
  if (!starts.length) return null;
  return starts.some((z) => zonePlausible(map, z)) ? clean : null;
}

/**
 * Zones from Momentum Mod timer triggers (trigger_momentum_timer_start/stop/stage/checkpoint), as a safety
 * net when the loader did not already put them in map.zones. Boxes are the trigger models' bounds.
 */
export function momentumZones(map: LoadedMap): ZoneDef[] {
  const out: ZoneDef[] = [];
  for (const e of map.entities) {
    const cls = e.classname.toLowerCase();
    if (!cls.startsWith('trigger_momentum_timer_') || e.model <= 0) continue;
    const m = map.models[e.model];
    if (!m || !finite(m.mins) || !finite(m.maxs)) continue;
    const num = (k: string): number => {
      const n = parseInt(e.kv[k] ?? '', 10);
      return Number.isFinite(n) ? n : 0;
    };
    const group = Math.max(0, num('track_number'), num('bonus'));
    let type: ZoneType;
    let index = 0;
    if (cls === 'trigger_momentum_timer_start') type = 'start';
    else if (cls === 'trigger_momentum_timer_stop') type = 'end';
    else if (cls === 'trigger_momentum_timer_stage') {
      type = 'stage';
      index = num('stage') || num('zone_number');
      if (index < 2) continue;
    } else if (cls === 'trigger_momentum_timer_checkpoint') {
      type = 'checkpoint';
      index = num('checkpoint') || num('zone_number');
    } else continue;
    out.push({ type, group, index, mins: v3(m.mins.x, m.mins.y, m.mins.z), maxs: v3(m.maxs.x, m.maxs.y, m.maxs.z) });
  }
  return sanitizeZones(out);
}

/** A start zone around the main spawn cluster (xy +96, z -16..+128). No end zone. */
export function heuristicZones(map: LoadedMap): ZoneDef[] {
  const pts = map.spawns.map((s) => s.origin).filter(finite);
  if (!pts.length) return [];
  // single-linkage clusters
  const cluster = new Int32Array(pts.length).fill(-1);
  let nClusters = 0;
  for (let i = 0; i < pts.length; i++) {
    if (cluster[i] >= 0) continue;
    const id = nClusters++;
    cluster[i] = id;
    const stack = [i];
    while (stack.length) {
      const a = pts[stack.pop() as number];
      for (let j = 0; j < pts.length; j++) {
        if (cluster[j] >= 0) continue;
        const b = pts[j];
        if (Math.abs(a.x - b.x) <= CLUSTER_GAP && Math.abs(a.y - b.y) <= CLUSTER_GAP && Math.abs(a.z - b.z) <= CLUSTER_GAP) {
          cluster[j] = id;
          stack.push(j);
        }
      }
    }
  }
  const counts = new Array<number>(nClusters).fill(0);
  for (let i = 0; i < pts.length; i++) counts[cluster[i]]++;
  let best = 0;
  for (let c = 1; c < nClusters; c++) if (counts[c] > counts[best]) best = c;
  const mins = v3(Infinity, Infinity, Infinity);
  const maxs = v3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < pts.length; i++) {
    if (cluster[i] !== best) continue;
    const p = pts[i];
    mins.x = Math.min(mins.x, p.x);
    mins.y = Math.min(mins.y, p.y);
    mins.z = Math.min(mins.z, p.z);
    maxs.x = Math.max(maxs.x, p.x);
    maxs.y = Math.max(maxs.y, p.y);
    maxs.z = Math.max(maxs.z, p.z);
  }
  return [
    {
      type: 'start',
      group: 0,
      index: 0,
      mins: v3(mins.x - 96, mins.y - 96, mins.z - 16),
      maxs: v3(maxs.x + 96, maxs.y + 96, maxs.z + 128),
    },
  ];
}

/** Resolves the zones for `map` (see the priority list at the top of this file). */
export async function resolveZones(map: LoadedMap): Promise<{ zones: ZoneDef[]; source: ZoneSource }> {
  let user: ZoneDef[] | null = null;
  try {
    user = loadUserZones(map.name);
  } catch {
    user = null;
  }
  const u = validateZones(map, user, false);
  if (u) return { zones: u, source: 'user' };

  let candidates: { key: string; zones: ZoneDef[] }[] = [];
  try {
    candidates = await getPresetZoneCandidates(map.name);
  } catch {
    candidates = [];
  }
  for (const c of candidates) {
    const p = validateZones(map, c.zones, true);
    if (p) return { zones: p, source: 'preset' };
  }

  if (map.zones && map.zones.length) {
    const own = sanitizeZones(map.zones);
    if (own.length) return { zones: own, source: map.zoneSource && map.zoneSource !== 'none' ? map.zoneSource : 'builtin' };
  }
  const mom = momentumZones(map);
  if (mom.some((z) => z.type === 'start')) return { zones: mom, source: 'momentum' };

  const h = heuristicZones(map);
  if (h.length) return { zones: h, source: 'heuristic' };
  return { zones: [], source: 'none' };
}
