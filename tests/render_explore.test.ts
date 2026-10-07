import { it } from 'vitest';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBsp } from '../src/bsp/reader';
import { parseEntities } from '../src/bsp/entities';
const out = (...a: unknown[]) => appendFileSync('/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/explore.txt', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
it.skipIf(!process.env.SURF_TEST_MAPS)('ents', async () => {
  for (const n of (process.env.MAPS ?? 'surf_lt_omnific').split(',')) {
    const buf = readFileSync(join(process.env.SURF_TEST_MAPS!, n + '.bsp'));
    const bsp = parseBsp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ents = parseEntities(bsp.entitiesText);
    for (const e of ents) if (/info_teleport_destination|sky_camera|env_fog|water_lod|func_water/.test(e.classname)) out(n, e.classname, e.targetname, `${e.origin.x.toFixed(0)},${e.origin.y.toFixed(0)},${e.origin.z.toFixed(0)}`, `${e.angles.pitch},${e.angles.yaw}`);
  }
});
