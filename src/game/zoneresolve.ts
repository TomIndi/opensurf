// Picks the timer zones for a loaded map, by priority:
//   1. user zones (zone editor, localStorage)        -> 'user' (used as they are)
//   2. SurfTimer presets (exact name, then other builds of the same map) -> 'preset'
//   3. zones shipped with the map (built-in maps, Momentum trigger entities) -> map.zoneSource
//      (Momentum timer triggers are converted here too if the loader left map.zones empty)
//   4. the map's own timer triggers, by their conventional names (start_trigger, endzone, cp3_trigger,
//      stage4_start, bonus1start, startbonus_trigger, zone_b1_end ...) -> 'map'
//   5. a start zone around the spawn points (no end zone) -> 'heuristic'
// Then, for 2-4:
//   - curated per-build fixes (public/maps/zone_overrides.json) replace/add zones by type+group+index;
//   - courses and zone types the chosen source lacks are filled from the map's timer triggers (Momentum or
//     named): a missing end zone, the checkpoints/stages of a course that has none, whole bonus courses.
// User and preset zones were made for some build of the map; they are only used when they fit THIS build:
// broken boxes are dropped and a plausible start zone must remain (a spawn point within ~2048 units of it,
// a teleport destination inside it, or a floor under its center where the player hull fits). Presets made
// for ANOTHER build (alias names) are checked zone by zone: a zone the player can't reach on this build (no
// floor or ramp within 256 units under it, no teleport trigger or destination next to it) is dropped, and the
// next build's preset is preferred when it fits completely.
import { conPrint } from '../core/cvars';
import { Vec3, v3 } from '../core/vec3';
import { LoadedMap, ZoneDef, ZoneSource, ZoneType } from '../map/types';
import { getPresetZoneCandidates, getZoneOverrides, loadUserZones } from '../maps/zones';
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
/** A zone is reachable when a floor/ramp is at most this far under it (or a teleport is next to it). */
export const ZONE_REACH = 256;
/** "Next to": a trigger_teleport brush within this distance of the zone box. */
const TELEPORT_NEAR = 64;

function finite(v: Vec3 | undefined): v is Vec3 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function isStartType(z: ZoneDef): boolean {
  return z.type === 'start' || z.type === 'speedstart';
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

/** Sample columns of a zone's footprint: center, quarter points, corners inset by the hull half-width. */
function footprintPoints(z: ZoneDef): [number, number][] {
  const c = center(z);
  const qx = (z.maxs.x - z.mins.x) / 4;
  const qy = (z.maxs.y - z.mins.y) / 4;
  const ix = Math.min(16, (z.maxs.x - z.mins.x) / 2);
  const iy = Math.min(16, (z.maxs.y - z.mins.y) / 2);
  return [
    [c.x, c.y],
    [c.x - qx, c.y - qy],
    [c.x + qx, c.y - qy],
    [c.x - qx, c.y + qy],
    [c.x + qx, c.y + qy],
    [z.mins.x + ix, z.mins.y + iy],
    [z.maxs.x - ix, z.mins.y + iy],
    [z.mins.x + ix, z.maxs.y - iy],
    [z.maxs.x - ix, z.maxs.y - iy],
  ];
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
  const tr = newTrace();
  for (const [x, y] of footprintPoints(z).slice(0, 5)) {
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
 * Can a player get into this zone on this build of the map? True when, at some point of its footprint, the
 * player hull fits inside the zone and a floor or ramp lies at most `reach` units under the zone's bottom
 * (hull trace straight down), or when a trigger_teleport brush is next to the zone (fail/end teleports) or
 * a teleport destination is in/just above it. Used to check presets made for another build zone by zone:
 * e.g. surf_utopia_v3's end zone hangs 1790 units over surf_utopia_njv's end ledge.
 */
export function zoneReachable(map: LoadedMap, z: ZoneDef, reach = ZONE_REACH): boolean {
  const world = map.collision;
  if (!world) return true; // nothing to check against
  const c = center(z);
  const tr = newTrace();
  for (const [x, y] of footprintPoints(z)) {
    const end = v3(x, y, z.mins.z - reach);
    for (const sz of [z.maxs.z, c.z, z.mins.z + 1]) {
      try {
        world.traceBox(v3(x, y, sz), end, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
      } catch {
        return true;
      }
      if (tr.startsolid || tr.allsolid) continue; // the hull doesn't fit at this height
      if (tr.fraction < 1) return true; // floor/ramp within reach
      break; // open air down to `reach` under the zone: try the next column
    }
  }
  const pad = TELEPORT_NEAR;
  for (const e of map.entities) {
    const cls = e.classname.toLowerCase();
    if (cls === 'trigger_teleport' && e.model > 0) {
      const m = map.models[e.model];
      if (!m || !finite(m.mins) || !finite(m.maxs)) continue;
      if (
        m.mins.x <= z.maxs.x + pad &&
        m.maxs.x >= z.mins.x - pad &&
        m.mins.y <= z.maxs.y + pad &&
        m.maxs.y >= z.mins.y - pad &&
        m.mins.z <= z.maxs.z + pad &&
        m.maxs.z >= z.mins.z - pad
      )
        return true;
    } else if (cls === 'info_teleport_destination') {
      const o = e.origin;
      if (
        o.x >= z.mins.x - pad &&
        o.x <= z.maxs.x + pad &&
        o.y >= z.mins.y - pad &&
        o.y <= z.maxs.y + pad &&
        o.z >= z.mins.z - pad &&
        o.z <= z.maxs.z + 512
      )
        return true;
    }
  }
  return false;
}

/**
 * Sanitized zones if they fit the map, else null. `group0` requires a plausible main-course start zone
 * (presets); otherwise any plausible start zone will do (user zones may cover only a bonus).
 */
export function validateZones(map: LoadedMap, zones: readonly ZoneDef[] | null | undefined, group0: boolean): ZoneDef[] | null {
  if (!zones || !zones.length) return null;
  const clean = sanitizeZones(zones);
  const starts = clean.filter((z) => isStartType(z) && (!group0 || z.group === 0));
  if (!starts.length) return null;
  return starts.some((z) => zonePlausible(map, z)) ? clean : null;
}

/** Zone types whose loss makes a preset incomplete (the course can't be finished / split properly). */
const COURSE_TYPES = new Set<ZoneType>(['end', 'stage', 'checkpoint']);

export interface PresetFit {
  /** Zones that fit this build. */
  zones: ZoneDef[];
  /** Zones dropped because the player can't reach them on this build. */
  dropped: ZoneDef[];
  /** A plausible main-course start zone remains. */
  usable: boolean;
  /** No end/stage/checkpoint zone was dropped. */
  complete: boolean;
}

/**
 * Checks a preset made for another build of the map zone by zone (see zoneReachable; start zones also pass
 * when plausible). The preset is usable when a plausible main-course start zone remains.
 */
export function fitPresetToMap(map: LoadedMap, zones: readonly ZoneDef[]): PresetFit {
  const clean = sanitizeZones(zones);
  const kept: ZoneDef[] = [];
  const dropped: ZoneDef[] = [];
  for (const z of clean) {
    const ok = isStartType(z) ? zonePlausible(map, z) || zoneReachable(map, z) : zoneReachable(map, z);
    (ok ? kept : dropped).push(z);
  }
  const usable = kept.some((z) => isStartType(z) && z.group === 0 && zonePlausible(map, z));
  return { zones: kept, dropped, usable, complete: !dropped.some((z) => COURSE_TYPES.has(z.type)) };
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

// ------------------------------------------------------------------------------------------ named timer triggers

/** Classes a map's own timer zones are made of. */
const TIMER_TRIGGER_CLASSES = new Set(['trigger_multiple', 'trigger_once']);
const PRE = '(?:map|main|surf|timer|zone|trigger|course)_?';
const SUF = '(?:_?(?:zone|trigger|trig|timer))?';
const START_RE = new RegExp(`^(?:${PRE})?start${SUF}$`);
const END_RE = new RegExp(`^(?:${PRE})?(?:end|finish)${SUF}$`);
const CP_RE = new RegExp(`^(?:zone_?)?(?:cp|checkpoint)_?(\\d+)${SUF}$`);
const STAGE_RE = /^(?:zone_?)?stage_?(\d+)(?:_?(?:start|zone|trigger|trig|start_?zone|start_?trigger))?$/;
const STAGE_S_RE = /^(?:zone_?)?s(\d+)_?(?:start|start_?zone|start_?trigger)$/;
const STAGE_END_RE = /^(?:zone_?)?stage_?(\d+)_?(?:end|finish)(?:_?(?:zone|trigger|trig))?$/;
const BONUS_RE = new RegExp(`^(?:zone_?)?(?:bonus_?(\\d*)|b_?(\\d+))_?(start|end|finish)${SUF}$`);
const BONUS_RE2 = new RegExp(`^(start|end|finish)_?bonus_?(\\d*)${SUF}$`);

export type TriggerZoneKind =
  | { type: 'start' | 'end'; group: number }
  | { type: 'stage' | 'checkpoint'; group: number; index: number }
  | { type: 'stage-end'; group: number; index: number };

/**
 * Timer zone meaning of a trigger name used by map-based timers and timer plugins (null when it is not one):
 * start_trigger / startzone / zone_start / surf_start -> start; end_trigger / endzone / zone_end -> end;
 * cpN_trigger / checkpointN -> checkpoint N; stageN / stageN_start / sN_start -> stage N (stage 1 = start);
 * stageN_end -> end candidate; bonusNstart / bonusN_end / zone_bN_start / startbonus_trigger -> bonus N
 * (N defaults to 1). Bare "start"/"end" are too generic and not accepted.
 */
export function classifyTimerTrigger(rawName: string): TriggerZoneKind | null {
  const name = rawName.trim().toLowerCase();
  if (!name || name === 'start' || name === 'end' || name === 'finish') return null;
  let m: RegExpExecArray | null;
  if (START_RE.test(name)) return { type: 'start', group: 0 };
  if (END_RE.test(name)) return { type: 'end', group: 0 };
  if ((m = CP_RE.exec(name))) {
    const i = parseInt(m[1], 10);
    return i > 0 && i < 1000 ? { type: 'checkpoint', group: 0, index: i } : null;
  }
  if ((m = STAGE_END_RE.exec(name))) {
    const i = parseInt(m[1], 10);
    return i > 0 && i < 1000 ? { type: 'stage-end', group: 0, index: i } : null;
  }
  if ((m = STAGE_RE.exec(name) ?? STAGE_S_RE.exec(name))) {
    const i = parseInt(m[1], 10);
    if (!(i > 0 && i < 1000)) return null;
    return i === 1 ? { type: 'start', group: 0 } : { type: 'stage', group: 0, index: i };
  }
  if ((m = BONUS_RE.exec(name))) {
    const g = parseInt(m[1] || m[2] || '1', 10);
    if (!(g > 0 && g < 100)) return null;
    return { type: m[3] === 'start' ? 'start' : 'end', group: g };
  }
  if ((m = BONUS_RE2.exec(name))) {
    const g = parseInt(m[2] || '1', 10);
    if (!(g > 0 && g < 100)) return null;
    return { type: m[1] === 'start' ? 'start' : 'end', group: g };
  }
  return null;
}

/**
 * Zones from the map's own timer triggers (trigger_multiple / trigger_once brush entities with a conventional
 * timer name, see classifyTimerTrigger). Each brush of the trigger becomes a box (its model bounds when it
 * has many brushes). "stage1" triggers are the start when the map has no start trigger; a "stageN_end"
 * trigger is the end when it closes the last stage and the map has no end trigger.
 */
export function mapTriggerZones(map: LoadedMap): ZoneDef[] {
  const raw: { kind: TriggerZoneKind; boxes: [Vec3, Vec3][]; explicitStart: boolean }[] = [];
  for (const e of map.entities) {
    if (!TIMER_TRIGGER_CLASSES.has(e.classname.toLowerCase()) || e.model <= 0 || !e.targetname) continue;
    const kind = classifyTimerTrigger(e.targetname);
    if (!kind) continue;
    const m = map.models[e.model];
    if (!m || !finite(m.mins) || !finite(m.maxs)) continue;
    const boxes: [Vec3, Vec3][] = [];
    const brushes = m.brushes ?? [];
    if (brushes.length > 1 && brushes.length <= 8 && brushes.every((b) => finite(b.mins) && finite(b.maxs))) {
      for (const b of brushes) boxes.push([v3(b.mins.x, b.mins.y, b.mins.z), v3(b.maxs.x, b.maxs.y, b.maxs.z)]);
    } else boxes.push([v3(m.mins.x, m.mins.y, m.mins.z), v3(m.maxs.x, m.maxs.y, m.maxs.z)]);
    const n = e.targetname.toLowerCase();
    raw.push({ kind, boxes, explicitStart: kind.type === 'start' && !/^(?:zone_?)?(?:stage_?1|s1)(?:_|$)/.test(n) });
  }
  // stage1_start is the start only when there is no explicit start trigger
  const hasExplicitStart = raw.some((r) => r.kind.type === 'start' && r.kind.group === 0 && r.explicitStart);
  const hasEnd = raw.some((r) => r.kind.type === 'end' && r.kind.group === 0);
  let lastStage = 1;
  for (const r of raw) if (r.kind.type === 'stage' && r.kind.group === 0) lastStage = Math.max(lastStage, r.kind.index);
  const out: ZoneDef[] = [];
  const counters = new Map<string, number>();
  for (const r of raw) {
    let type: ZoneType;
    let index = 0;
    const k = r.kind;
    if (k.type === 'start') {
      if (k.group === 0 && !r.explicitStart && hasExplicitStart) continue;
      type = 'start';
    } else if (k.type === 'end') type = 'end';
    else if (k.type === 'stage-end') {
      if (hasEnd || k.index < lastStage) continue;
      type = 'end';
    } else if (k.type === 'stage' || k.type === 'checkpoint') {
      type = k.type;
      index = k.index;
    } else continue;
    for (const [mins, maxs] of r.boxes) {
      let idx = index;
      if (type === 'start' || type === 'end') {
        const key = `${type}|${k.group}`;
        idx = counters.get(key) ?? 0;
        counters.set(key, idx + 1);
      }
      out.push({ type, group: k.group, index: idx, mins, maxs });
    }
  }
  // a "bonus" whose start is the main start box (maps that filter one course two ways) is no course of its own
  const clean = sanitizeZones(out);
  const mainStarts = clean.filter((z) => z.group === 0 && isStartType(z));
  const kept = clean.filter((z) => !(z.group > 0 && isStartType(z) && mainStarts.some((m) => sameZoneBox(m, z))));
  return kept.filter((z) => z.group === 0 || kept.some((s) => s.group === z.group && isStartType(s)));
}

// ------------------------------------------------------------------------------------------ merging

function boxVolume(a: ZoneDef): number {
  return (a.maxs.x - a.mins.x) * (a.maxs.y - a.mins.y) * (a.maxs.z - a.mins.z);
}

/** The two boxes are (nearly) the same volume of space: 80 % of the smaller one is shared. */
export function sameZoneBox(a: ZoneDef, b: ZoneDef): boolean {
  const ix = Math.min(a.maxs.x, b.maxs.x) - Math.max(a.mins.x, b.mins.x);
  const iy = Math.min(a.maxs.y, b.maxs.y) - Math.max(a.mins.y, b.mins.y);
  const iz = Math.min(a.maxs.z, b.maxs.z) - Math.max(a.mins.z, b.mins.z);
  if (!(ix > 0 && iy > 0 && iz > 0)) return false;
  const small = Math.min(boxVolume(a), boxVolume(b));
  return small > 0 && (ix * iy * iz) / small >= 0.8;
}

/** Applies curated fixes: drops `remove` keys and zones replaced by an override (same type+group+index). */
export function applyZoneOverrides(
  base: readonly ZoneDef[],
  overrides: readonly ZoneDef[],
  remove: readonly { type: ZoneType; group: number; index: number }[] = [],
): ZoneDef[] {
  const key = (z: { type: ZoneType; group: number; index: number }): string => `${z.type}|${z.group}|${z.index}`;
  const gone = new Set([...remove.map(key), ...overrides.map(key)]);
  return [...base.filter((z) => !gone.has(key(z))), ...overrides];
}

/**
 * Fills what `base` lacks from map-derived zones (`extra`): whole courses (groups) without a start zone,
 * the end of a course that has none, and the checkpoints/stages of a course that has neither. A course in
 * `extra` whose start box is the same space as a start zone already present is skipped (maps that reuse the
 * main start/end triggers for a filtered "bonus" would otherwise put two courses in one box).
 */
export function fillMissingZones(base: readonly ZoneDef[], extra: readonly ZoneDef[]): { zones: ZoneDef[]; added: ZoneDef[] } {
  const out = [...base];
  const added: ZoneDef[] = [];
  const groups = [...new Set(extra.map((z) => z.group))].sort((a, b) => a - b);
  for (const g of groups) {
    const ex = extra.filter((z) => z.group === g);
    const have = out.filter((z) => z.group === g);
    let add: ZoneDef[] = [];
    if (!have.some(isStartType)) {
      // starts that are the same space as a start already present are copies, not a course of their own
      const copies = ex.filter((s) => isStartType(s) && out.some((o) => isStartType(o) && sameZoneBox(o, s)));
      const rest = ex.filter((q) => !copies.includes(q));
      if (!rest.some(isStartType)) continue;
      add = rest;
    } else {
      if (!have.some((z) => z.type === 'end')) add.push(...ex.filter((z) => z.type === 'end'));
      if (!have.some((z) => z.type === 'stage' || z.type === 'checkpoint')) add.push(...ex.filter((z) => z.type === 'stage' || z.type === 'checkpoint'));
    }
    for (const z of add) {
      out.push(z);
      added.push(z);
    }
  }
  return { zones: out, added };
}

/** "end, CP 1-5, bonus 1" style summary of zones (for the zone source report). */
export function describeZones(zones: readonly ZoneDef[]): string {
  const parts: string[] = [];
  const range = (ns: number[]): string => {
    const s = [...new Set(ns)].sort((a, b) => a - b);
    if (!s.length) return '';
    return s.length > 1 && s[s.length - 1] - s[0] === s.length - 1 ? `${s[0]}-${s[s.length - 1]}` : s.join(',');
  };
  const g0 = zones.filter((z) => z.group === 0);
  if (g0.some(isStartType)) parts.push('start');
  if (g0.some((z) => z.type === 'end')) parts.push('end');
  const st = g0.filter((z) => z.type === 'stage').map((z) => z.index);
  if (st.length) parts.push(`stage ${range(st)}`);
  const cp = g0.filter((z) => z.type === 'checkpoint').map((z) => z.index);
  if (cp.length) parts.push(`CP ${range(cp)}`);
  const other = [...new Set(g0.filter((z) => !isStartType(z) && !COURSE_TYPES.has(z.type)).map((z) => z.type))];
  parts.push(...other);
  const bonuses = [...new Set(zones.filter((z) => z.group > 0).map((z) => z.group))];
  if (bonuses.length) parts.push(`bonus ${range(bonuses)}`);
  return parts.join(', ');
}

// ------------------------------------------------------------------------------------------ heuristic

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

// ------------------------------------------------------------------------------------------ resolution

/** Where the zones of a map came from, for the console and !mi. */
export interface ZoneReport {
  map: string;
  source: ZoneSource;
  /** "SurfTimer preset surf_utopia_v3", "curated fixes (end)", "map triggers (end, CP 1-5)". */
  parts: string[];
  /** Problems worth telling the player (zones that don't fit this build, no end zone ...). */
  notes: string[];
}

export interface ResolvedZones {
  zones: ZoneDef[];
  source: ZoneSource;
  report: ZoneReport;
}

const reports = new Map<string, ZoneReport>();

/** The report of the last resolveZones() for this map (null if never resolved). */
export function getZoneReport(mapName: string): ZoneReport | null {
  return reports.get(mapName.toLowerCase()) ?? null;
}

function finishReport(map: LoadedMap, zones: ZoneDef[], source: ZoneSource, parts: string[], notes: string[], quiet = false): ResolvedZones {
  const report: ZoneReport = { map: map.name, source: zones.length ? source : 'none', parts, notes };
  reports.set(map.name.toLowerCase(), report);
  if (!quiet) {
    try {
      conPrint(`Zones: ${parts.length ? parts.join(' + ') : 'none'}`, 'info');
      for (const n of notes) conPrint(`Zones: ${n}`, 'warn');
    } catch {
      /* console unavailable */
    }
  }
  return { zones, source: report.source, report };
}

/** Resolves the zones for `map` (see the priority list at the top of this file). */
export async function resolveZones(map: LoadedMap): Promise<ResolvedZones> {
  const parts: string[] = [];
  const notes: string[] = [];
  let user: ZoneDef[] | null = null;
  try {
    user = loadUserZones(map.name);
  } catch {
    user = null;
  }
  const u = validateZones(map, user, false);
  if (u) return finishReport(map, u, 'user', ['your zones (zone editor)'], notes);

  let base: ZoneDef[] | null = null;
  let source: ZoneSource = 'none';

  // SurfTimer presets: the exact name as is; other builds zone by zone
  let candidates: { key: string; zones: ZoneDef[] }[] = [];
  try {
    candidates = await getPresetZoneCandidates(map.name);
  } catch {
    candidates = [];
  }
  const exactKey = map.name.toLowerCase();
  let fallback: { key: string; fit: PresetFit } | null = null;
  /** Preset zones of another build that don't fit this one. */
  let dropped: ZoneDef[] = [];
  for (const c of candidates) {
    if (c.key === exactKey) {
      const p = validateZones(map, c.zones, true);
      if (p) {
        base = p;
        parts.push('SurfTimer preset');
        break;
      }
      continue;
    }
    const fit = fitPresetToMap(map, c.zones);
    if (!fit.usable) continue;
    if (fit.complete) {
      base = fit.zones;
      dropped = fit.dropped;
      parts.push(`SurfTimer preset (${c.key}${fit.dropped.length ? `; skipped ${describeZones(fit.dropped)}: not on this build` : ''})`);
      fallback = null;
      break;
    }
    if (!fallback) fallback = { key: c.key, fit };
  }
  if (!base && fallback) {
    base = fallback.fit.zones;
    dropped = fallback.fit.dropped;
    parts.push(`SurfTimer preset (${fallback.key}; skipped ${describeZones(fallback.fit.dropped)}: not on this build)`);
  }
  if (base) source = 'preset';

  // built-in maps ship complete zones
  if (!base && map.zones && map.zones.length && map.zoneSource === 'builtin') {
    const own = sanitizeZones(map.zones);
    if (own.length) return finishReport(map, own, 'builtin', ['built-in'], notes, true);
  }

  // map-derived zones (fillers, or the base when there is no preset)
  let mom: ZoneDef[] = [];
  if (map.zones && map.zones.length && map.zoneSource === 'momentum') mom = sanitizeZones(map.zones);
  if (!mom.length) mom = momentumZones(map);
  const named = mapTriggerZones(map);

  if (!base && map.zones && map.zones.length) {
    const own = sanitizeZones(map.zones);
    if (own.length) {
      base = own;
      source = map.zoneSource && map.zoneSource !== 'none' ? map.zoneSource : 'builtin';
      parts.push(source === 'momentum' ? 'Momentum timer triggers' : source);
    }
  }
  if (!base && mom.some((z) => isStartType(z) && z.group === 0)) {
    base = mom;
    source = 'momentum';
    parts.push('Momentum timer triggers');
  }
  if (!base && named.some((z) => isStartType(z) && z.group === 0 && zonePlausible(map, z))) {
    base = named;
    source = 'map';
    parts.push(`map timer triggers (${describeZones(named)})`);
  }

  // curated fixes for this build
  let override = null as Awaited<ReturnType<typeof getZoneOverrides>>;
  try {
    override = await getZoneOverrides(map.name);
  } catch {
    override = null;
  }
  if (override) {
    const good: ZoneDef[] = [];
    for (const z of sanitizeZones(override.zones)) {
      if (zoneReachable(map, z)) good.push(z);
      else notes.push(`Curated ${z.type} zone (group ${z.group}) doesn't fit this build: ignored.`);
    }
    if (base || good.some((z) => isStartType(z) && z.group === 0)) {
      base = applyZoneOverrides(base ?? [], good, override.remove);
      if (source === 'none') source = 'preset';
      if (good.length || override.remove.length) parts.push(`curated fixes (${describeZones(good) || 'removals'})`);
    }
  }

  if (base) {
    // fill what the chosen source lacks from the map's own timer triggers
    for (const [extra, label] of [
      [mom, 'Momentum timer triggers'],
      [named, 'map timer triggers'],
    ] as const) {
      if (!extra.length || extra === base || (source === 'momentum' && extra === mom) || (source === 'map' && extra === named)) continue;
      const r = fillMissingZones(base, extra);
      if (r.added.length) {
        base = r.zones;
        parts.push(`${label} (${describeZones(r.added)})`);
      }
    }
    // course zones of the preset that are still missing after the fixes and fills
    const missing = dropped.filter(
      (d) => COURSE_TYPES.has(d.type) && !base!.some((z) => z.type === d.type && z.group === d.group && (d.type === 'end' || z.index === d.index)),
    );
    if (missing.length) notes.push(`The preset's ${describeZones(missing)} zone(s) don't fit this build of the map and were skipped.`);
    return finishReport(map, base, source, parts, notes);
  }

  const h = heuristicZones(map);
  if (h.length) {
    notes.push('No timer zones known for this map: start zone placed around the spawn points.');
    return finishReport(map, h, 'heuristic', ['automatic start zone'], notes);
  }
  return finishReport(map, [], 'none', [], notes);
}
