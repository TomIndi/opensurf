import { it } from 'vitest';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBspMap } from '../src/bsp/loadmap';
import { isProceduralImage } from '../src/bsp/materials';
const out = (...a: unknown[]) => appendFileSync('/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/explore.txt', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
it.skipIf(!process.env.SURF_TEST_MAPS)('mat', async () => {
  const n = process.env.MAP ?? 'surf_summer_ksf';
  const buf = readFileSync(join(process.env.SURF_TEST_MAPS!, n + '.bsp'));
  const map = await loadBspMap(n, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), undefined, { log: () => {} });
  const lm = map.render.lightmap!;
  for (const name of (process.env.MATS ?? '').split(',')) {
    const m = map.render.materials.get(name);
    if (!m) { out(name, 'missing'); continue; }
    const img = m.image;
    let avg = [0, 0, 0];
    if (img) { for (let i = 0; i < img.data.length; i += 4) for (let k = 0; k < 3; k++) avg[k] += img.data[i + k]; avg = avg.map(x => +(x / (img.data.length / 4)).toFixed(1)); }
    out(name, m.shader, 'img', img ? `${img.width}x${img.height}` : '-', 'proc', isProceduralImage(img), 'avg', JSON.stringify(avg), 'fb', JSON.stringify(m.fallbackColor), 'unlit', m.unlit, 'detail', !!m.detail, m.detail ? JSON.stringify({ s: m.detail.scale, b: m.detail.blendFactor, m: m.detail.blendMode }) : '', 'env', !!m.envmap);
    for (const b of map.render.batches) {
      if (b.material !== name || !b.lightmapUVs) continue;
      let s = 0, c = 0, mx = 0;
      for (let i = 0; i < b.lightmapUVs.length; i += 2) {
        const x = Math.min(lm.width - 1, Math.floor(b.lightmapUVs[i] * lm.width)), y = Math.min(lm.height - 1, Math.floor(b.lightmapUVs[i + 1] * lm.height));
        const v = lm.data[(y * lm.width + x) * 4]; s += v; c++; mx = Math.max(mx, v);
      }
      out('   batch lm avg', (s / c).toFixed(3), 'max', mx.toFixed(3), 'tris', b.indices.length / 3);
    }
  }
});
