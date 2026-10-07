import { it } from 'vitest';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBspMap } from '../src/bsp/loadmap';
const out = (...a: unknown[]) => appendFileSync('/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/explore.txt', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
it.skipIf(!process.env.SURF_TEST_MAPS)('props', async () => {
  const n = 'surf_lt_omnific';
  const buf = readFileSync(join(process.env.SURF_TEST_MAPS!, n + '.bsp'));
  const map = await loadBspMap(n, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), undefined, { log: () => {} });
  for (const p of map.render.props ?? []) {
    if (Math.abs(p.origin.y + 3600) < 700 && Math.abs(p.origin.x) < 800 && Math.abs(p.origin.z - 4040) < 300) {
      let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
      for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.positions[i+k]); mx[k] = Math.max(mx[k], p.positions[i+k]); }
      out(p.model, p.material, JSON.stringify(p.origin), JSON.stringify(p.angles), 'bbox', mn.map(x=>x.toFixed(0)).join(','), mx.map(x=>x.toFixed(0)).join(','), 'entity', p.entity, 'area', p.area);
    }
  }
});
