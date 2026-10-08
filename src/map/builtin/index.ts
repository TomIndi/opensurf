// Built-in procedural surf maps: playable instantly (no download), for a first run, learning, and physics
// testing. Every map is an original design built from classic surf conventions (48-63 degree ramps, wide
// faces, drops onto ramps, transfers, gaps sized to the exit speed, a bonus reached from the spawn room or
// with !b 1) and validated by autopilot runs with the real movement code (tests/builtin.test.ts).
import type { LoadedMap } from '../types';
import type { BuiltCourse } from './course';
import { BUILTIN_MAPS } from './list';
import { buildNeon } from './neon';
import { buildSkyline } from './skyline';
import { buildTutorial } from './tutorial';

// The list itself lives in list.ts (no geometry code) so the menu can show it without pulling the builders
// into the main bundle; buildBuiltinMap() is loaded on demand (dynamic import from the game).
export { BUILTIN_MAPS, type BuiltinMapInfo } from './list';

const BUILDERS: Record<string, () => BuiltCourse> = {
  surf_tutorial: buildTutorial,
  surf_neon: buildNeon,
  surf_skyline: buildSkyline,
};

/** Builds a built-in map together with its course description (used by tests and tools). */
export function buildBuiltinCourse(id: string): BuiltCourse {
  const key = id.trim().toLowerCase();
  const fn = BUILDERS[key] ?? BUILDERS[`surf_${key}`];
  if (!fn) throw new Error(`Unknown built-in map "${id}" (available: ${BUILTIN_MAPS.map((m) => m.id).join(', ')})`);
  return fn();
}

/** Builds a built-in map by id ("surf_tutorial", "surf_neon", "surf_skyline"; the "surf_" prefix is optional). */
export function buildBuiltinMap(id: string): LoadedMap {
  return buildBuiltinCourse(id).map;
}
