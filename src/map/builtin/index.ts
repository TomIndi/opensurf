// Built-in procedural surf maps: playable instantly (no download), for a first run, learning, and physics
// testing. Every map is an original design built from classic surf conventions (55-63 degree ramps, wide
// faces, drops onto ramps, transfers, gaps sized to the exit speed) and validated by an autopilot run with
// the real movement code (tests/builtin.test.ts).
import type { LoadedMap } from '../types';
import type { BuiltCourse } from './course';
import { buildNeon } from './neon';
import { buildSkyline } from './skyline';
import { buildTutorial } from './tutorial';

export interface BuiltinMapInfo {
  id: string;
  name: string;
  description: string;
  tier: number;
  type: 'linear' | 'staged';
}

export const BUILTIN_MAPS: BuiltinMapInfo[] = [
  {
    id: 'surf_tutorial',
    name: 'surf_tutorial',
    description: 'Learn to surf: a long, wide first ramp, then straight follow-ups, a zigzag, a transfer and growing gaps. 4 checkpoints.',
    tier: 1,
    type: 'linear',
  },
  {
    id: 'surf_neon',
    name: 'surf_neon',
    description: 'Glowing ramps in the dark: 4 stages with a long ramp, an up-ramp, a curved ramp and a booster.',
    tier: 2,
    type: 'staged',
  },
  {
    id: 'surf_skyline',
    name: 'surf_skyline',
    description: 'Long flowing ramps over a misty void at dusk: sweeping curves and big gaps. Linear, 3 checkpoints.',
    tier: 3,
    type: 'linear',
  },
];

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
