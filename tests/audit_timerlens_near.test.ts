import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { loadRealMap } from './gameworld_host';
import { v3 } from '../src/core/vec3';
import { MASK_PLAYERSOLID, newTrace } from '../src/physics/types';
import { HULL_MAXS, HULL_MINS } from '../src/physics/playertypes';
const DIR = process.env.SURF_TEST_MAPS ?? '';
const f = (n: number) => n.toFixed(0);
const Q: [string, number, number, number][] = [
  ['surf_rookie', 1456, -3552, -7008], ['surf_rookie', -10304, -9584, -415], ['surf_rookie', 8496, -2704, 2812],
  ['surf_kitsune', -2048, -14606, -8279], ['surf_beginner', -2320, 2000, 1869], ['surf_lt_omnific', -6394, 6121, -4640], ['surf_lt_omnific', -13216, 14048, -13248],
];
describe('near', () => {
  it('triggers near end positions', async () => {
    const maps = new Map<string, any>();
    for (const [name, x, y, z] of Q) {
      if (!existsSync(join(DIR, `${name}.bsp`))) continue;
      let map = maps.get(name);
      if (!map) { map = await loadRealMap(join(DIR, `${name}.bsp`)); maps.set(name, map); }
      const out: string[] = [];
      for (const e of map.entities) {
        if (!e.classname.startsWith('trigger_') || e.model <= 0) continue;
        const m = map.models[e.model];
        const dx = Math.max(m.mins.x - x, 0, x - m.maxs.x), dy = Math.max(m.mins.y - y, 0, y - m.maxs.y), dz = Math.max(m.mins.z - (z + 72), 0, z - m.maxs.z);
        const d = Math.hypot(dx, dy, dz);
        if (d < 400) out.push(`  d=${f(d)} #${e.index} ${e.classname} tgt=${e.kv.target ?? ''} filt=${e.kv.filtername ?? ''} dis=${e.kv.startdisabled ?? ''} name=${e.targetname} box=[${f(m.mins.x)},${f(m.mins.y)},${f(m.mins.z)}]-[${f(m.maxs.x)},${f(m.maxs.y)},${f(m.maxs.z)}] nbrush=${m.brushes.length}`);
      }
      const tr = newTrace();
      map.collision.traceBox(v3(x, y, z + 2), v3(x, y, z - 50), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
      console.log(`${name} @(${x},${y},${z}) floor n.z=${tr.plane.normal.z.toFixed(2)} frac=${tr.fraction.toFixed(2)}\n${out.join('\n')}`);
    }
  }, 120000);
});
