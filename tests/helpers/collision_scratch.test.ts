import { it } from 'vitest';
import { join } from 'node:path';
import { v3 } from '../../src/core/vec3';
import { CollisionWorld } from '../../src/physics/collision';
import { MASK_PLAYERSOLID, MASK_ALL, newTrace } from '../../src/physics/types';
import { readBspBrushes } from './collision_bsp';

const DIR = '/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/maps';
it('omnific spawns', () => {
  const bsp = readBspBrushes(join(DIR, 'surf_lt_omnific.bsp'))!;
  const w = new CollisionWorld(bsp.world);
  const tr = newTrace();
  let bad = 0;
  for (const sp of bsp.spawns) {
    w.traceBox(v3(sp.x, sp.y, sp.z + 1), v3(sp.x, sp.y, sp.z - 512), v3(-16, -16, 0), v3(16, 16, 72), MASK_PLAYERSOLID, tr);
    if (tr.fraction === 1 && !tr.startsolid) {
      bad++;
      const far = w.traceBox(v3(sp.x, sp.y, sp.z + 1), v3(sp.x, sp.y, sp.z - 20000), v3(-16, -16, 0), v3(16, 16, 72), MASK_ALL);
      if (bad < 4) console.log('spawn', JSON.stringify(sp), 'no ground within 512; far trace fraction', far.fraction, 'endz', far.endpos.z, 'contents', far.contents);
    }
  }
  console.log('spawns', bsp.spawns.length, 'without ground', bad);
  const re = /\{[^}]*"classname"\s+"info_player_(?:counter)?terrorist"[^}]*\}/g;
  const m = bsp.entities.match(re);
  console.log((m ?? []).slice(0, 2).join('\n'));
  // brush entities near first bad spawn
});
