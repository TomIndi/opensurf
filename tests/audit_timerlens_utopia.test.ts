import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { HULL_MAXS, HULL_MINS } from '../src/physics/playertypes';
import { MASK_PLAYERSOLID, newTrace } from '../src/physics/types';
import { loadRealMap } from './gameworld_host';
const DIR = process.env.SURF_TEST_MAPS ?? '';
const f = (n: number) => n.toFixed(0);
describe('utopia', () => {
  it('end area', async () => {
    const p = join(DIR, 'surf_utopia_njv.bsp');
    if (!existsSync(p)) return;
    const map = await loadRealMap(p);
    const w = map.collision;
    const tr = newTrace();
    const ray = (a: [number, number, number], b: [number, number, number]) => {
      w.traceRay(v3(...a), v3(...b), MASK_PLAYERSOLID, tr);
      return `${tr.startsolid ? 'SS ' : ''}frac=${tr.fraction.toFixed(3)} end=(${f(tr.endpos.x)},${f(tr.endpos.y)},${f(tr.endpos.z)}) n=(${tr.plane.normal.x.toFixed(2)},${tr.plane.normal.y.toFixed(2)},${tr.plane.normal.z.toFixed(2)})`;
    };
    const c: [number, number, number] = [-14285, 25, -4383];
    console.log('zone center solid?', w.pointContents(v3(...c)));
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) console.log('from zone center dir', d, ray(c, [c[0] + d[0] * 8000, c[1] + d[1] * 8000, c[2] + d[2] * 8000]));
    const r: [number, number, number] = [-14000, 0, -6150];
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) console.log('from end room dir', d, ray(r, [r[0] + d[0] * 8000, r[1] + d[1] * 8000, r[2] + d[2] * 8000]));
    // scan a vertical column along x through the zone y=25
    for (let x = -14320; x <= -10000; x += 400) console.log('x', x, 'down from -4383:', ray([x, 25, -4383], [x, 25, -9000]), ' up:', ray([x, 25, -4383], [x, 25, 9000]));
    w.traceBox(v3(-14285, 25, -4383), v3(-14285, 25, -9000), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    console.log('hull drop from zone', tr.fraction, tr.endpos);
  }, 60000);
});
