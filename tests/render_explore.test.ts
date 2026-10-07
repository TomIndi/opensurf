import { it } from 'vitest';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBspMap } from '../src/bsp/loadmap';
const out = (...a: unknown[]) => appendFileSync('/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/explore.txt', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
const avg = (img: any) => { const s = [0, 0, 0, 0]; for (let i = 0; i < img.data.length; i += 4) for (let k = 0; k < 4; k++) s[k] += img.data[i + k]; return s.map(x => +(x / (img.data.length / 4)).toFixed(1)); };
it.skipIf(!process.env.SURF_TEST_MAPS)('cube', async () => {
  const n = 'surf_kitsune';
  const buf = readFileSync(join(process.env.SURF_TEST_MAPS!, n + '.bsp'));
  const map = await loadBspMap(n, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), undefined, { log: () => {} });
  for (const c of map.render.cubemaps ?? []) out(c.texture, c.faces?.map(avg).map(a => a.join(',')).join(' | '));
  const m = map.render.materials.get('grids/grid_red')!;
  out('grid img avg', avg(m.image), m.image!.width, 'mask', m.envmap?.maskImage ? avg(m.envmap.maskImage) : '-', JSON.stringify({ ...m.envmap, maskImage: undefined }));
});
