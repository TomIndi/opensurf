import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { MASK_PLAYERSOLID, newTrace } from '../src/physics/types';
import { loadRealMap } from './gameworld_host';
const DIR = process.env.SURF_TEST_MAPS ?? '';
const f = (n: number) => n.toFixed(0);
describe('omni', () => {
  it('end area', async () => {
    const p = join(DIR, 'surf_lt_omnific.bsp');
    if (!existsSync(p)) return;
    const map = await loadRealMap(p);
    const w = map.collision;
    const tr = newTrace();
    const ray = (a: number[], b: number[]) => { w.traceRay(v3(a[0], a[1], a[2]), v3(b[0], b[1], b[2]), MASK_PLAYERSOLID, tr); return `${tr.startsolid ? 'SS ' : ''}end=(${f(tr.endpos.x)},${f(tr.endpos.y)},${f(tr.endpos.z)}) n=(${tr.plane.normal.x.toFixed(2)},${tr.plane.normal.y.toFixed(2)},${tr.plane.normal.z.toFixed(2)})`; };
    for (const c of [[-9731, -3078, -13519], [-9729, -11264, -13519]]) {
      for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) console.log('zone', c, d, ray(c, [c[0] + d[0] * 9000, c[1] + d[1] * 9000, c[2] + d[2] * 9000]));
    }
    // floor profile along the corridor
    for (let y = -11500; y <= -2800; y += 500) console.log('y', y, 'floor', ray([-9728, y, -12300], [-9728, y, -15000]));
    // which trigger brushes are near the end zones; list trigger_teleports whose brushes overlap a column above floor
    for (const e of map.entities) {
      if (e.classname !== 'trigger_teleport' || e.model <= 0) continue;
      for (const b of map.models[e.model].brushes) {
        if (b.maxs.x < -10100 || b.mins.x > -9400 || b.maxs.y < -11600 || b.mins.y > -2700 || b.maxs.z < -14400 || b.mins.z > -12200) continue;
        console.log(`tp #${e.index} -> ${e.kv.target} brush [${f(b.mins.x)},${f(b.mins.y)},${f(b.mins.z)}]-[${f(b.maxs.x)},${f(b.maxs.y)},${f(b.maxs.z)}]`);
      }
    }
  }, 60000);
});
