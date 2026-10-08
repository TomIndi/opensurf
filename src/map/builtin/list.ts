// The built-in maps' metadata (id, name, description, tier, type). Kept apart from the builders in index.ts so
// UI code can list the maps without bundling the map geometry generators (which load on demand).

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
    description: 'Learn to surf: a long, wide first ramp, then straight follow-ups, a zigzag, a transfer and growing gaps. 3 checkpoints, 1 bonus.',
    tier: 1,
    type: 'linear',
  },
  {
    id: 'surf_neon',
    name: 'surf_neon',
    description: 'Glowing ramps in the dark: 4 stages with a long warm-up, an up-ramp into a booster, a 180 degree curve and a booster launch. 1 bonus.',
    tier: 2,
    type: 'staged',
  },
  {
    id: 'surf_skyline',
    name: 'surf_skyline',
    description: 'Long flowing ramps over a misty void at dusk: sweeping curves and big gaps. Linear, 3 checkpoints, 1 bonus.',
    tier: 3,
    type: 'linear',
  },
];
