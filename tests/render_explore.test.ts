import { describe, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadBspMap } from '../src/bsp/loadmap';
import { SURF_SKY, SURF_SKY2D } from '../src/bsp/types';

import { appendFileSync } from 'node:fs';
const out = (...a: unknown[]) => appendFileSync('/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/explore.txt', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
const DIR = process.env.SURF_TEST_MAPS;
const NAMES = (process.env.MAPS ?? 'surf_utopia_njv').split(',');
describe.skipIf(!DIR)('explore', () => {
  for (const n of NAMES) it(n, async () => {
    const p = join(DIR!, n + '.bsp');
    if (!existsSync(p)) return;
    const buf = readFileSync(p);
    const map = await loadBspMap(n, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), undefined, { log: () => {} });
    const r = map.render;
    let tris = 0, sky = 0, disp = 0, decal = 0, lm = 0, alphas = 0;
    const areas = new Map<number, number>();
    for (const b of r.batches) {
      tris += b.indices.length / 3;
      if (b.surfFlags & (SURF_SKY | SURF_SKY2D)) sky++;
      if (b.isDisplacement) disp++;
      if (b.decal) decal++;
      if (b.lightmapUVs) lm++;
      if (b.alphas) alphas++;
      areas.set(b.area, (areas.get(b.area) ?? 0) + 1);
    }
    out(n, 'batches', r.batches.length, 'tris', tris, 'sky', sky, 'disp', disp, 'decal', decal, 'lm', lm, 'alphas', alphas, 'areas', [...areas.entries()].join(' '));
    out(' lightmap', r.lightmap?.width, r.lightmap?.height, 'sky', r.sky.name, !!r.sky.faces, r.sky.faces?.rt.width, 'sky3d', JSON.stringify(r.sky3d), 'fog', JSON.stringify(r.fog));
    out(' props', r.props?.length, 'cubemaps', r.cubemaps?.length, r.cubemaps?.filter(c => c.faces).length, 'materials', r.materials.size);
    const feats: Record<string, number> = {};
    const inc = (k: string) => (feats[k] = (feats[k] ?? 0) + 1);
    let texBytes = 0; const seen = new Set();
    for (const m of r.materials.values()) {
      if (m.translucent) inc('translucent'); if (m.additive) inc('additive'); if (m.alphaTest) inc('alphatest'); if (m.noCull) inc('nocull');
      if (m.unlit) inc('unlit'); if (m.isWater) inc('water'); if (m.isSky) inc('sky'); if (m.isTool) inc('tool'); if (m.scroll) inc('scroll');
      if (m.textureTransform) inc('tt'); if (m.frames) inc('frames'); if (m.image2) inc('image2'); if (m.detail) inc('detail'); if (m.envmap) inc('envmap');
      if (m.pattern) inc('pattern:' + m.pattern); inc('shader:' + m.shader);
      if (m.image && !seen.has(m.image.data)) { seen.add(m.image.data); texBytes += m.image.data.length; }
    }
    out(' feats', JSON.stringify(feats), 'texMB', (texBytes / 1e6).toFixed(1));
    const ents = map.entities.filter(e => /sky_camera|env_fog|info_player|light_env|func_water|env_sun|shadow_control|func_brush|func_illusionary|prop_|env_sprite|func_wall|func_door/.test(e.classname));
    const counts: Record<string, number> = {};
    for (const e of map.entities) counts[e.classname] = (counts[e.classname] ?? 0) + 1;
    out(' ents', JSON.stringify(counts));
    for (const e of ents.slice(0, 12)) out('  ', e.classname, e.targetname, JSON.stringify(e.origin), JSON.stringify(e.angles), e.model, JSON.stringify(e.kv).slice(0, 300));
    out(' spawns', JSON.stringify(map.spawns.slice(0, 2)), 'world', JSON.stringify(map.worldMins), JSON.stringify(map.worldMaxs));
    out(' warnings', map.warnings.slice(0, 10));
  });
});
