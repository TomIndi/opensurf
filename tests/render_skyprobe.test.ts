import { it } from 'vitest';
import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBsp } from '../src/bsp/reader';
import { parseEntities } from '../src/bsp/entities';
import { PakFile } from '../src/bsp/pakfile';
import { loadSky, isProceduralImage } from '../src/bsp/materials';
import { SKY_SUFFIXES, SOURCE_SKY_BASIS, FaceBasis, lookupDirection, findSkySun } from '../src/render/skymath';
const out = (...a: unknown[]) => appendFileSync('/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/skyprobe.txt', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
const DIR = process.env.SURF_TEST_MAPS;
it.skipIf(!DIR)('probe', () => {
  for (const f of readdirSync(DIR!)) {
    if (!f.endsWith('.bsp')) continue;
    const buf = readFileSync(join(DIR!, f));
    const bsp = parseBsp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ents = parseEntities(bsp.entitiesText);
    const ws = ents.find(e => e.classname === 'worldspawn');
    const le = ents.find(e => e.classname === 'light_environment');
    const pak = bsp.pakfile ? new PakFile(bsp.pakfile) : null;
    const sky = loadSky(ws?.kv.skyname ?? '', pak);
    const proc = sky.faces ? isProceduralImage(sky.faces.rt) : null;
    out(f, ws?.kv.skyname, 'faces', !!sky.faces, sky.faces?.rt.width, 'proc', proc, 'light_env', le ? JSON.stringify(le.kv) : '-');
    if (!sky.faces || proc) continue;
    const faces = sky.faces;
    // evaluate up/dn candidates
    const axes: [number, number, number][] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0]];
    const sample = (b: FaceBasis[], x: number, y: number, z: number) => {
      const l = lookupDirection(b, x, y, z);
      const img = faces[SKY_SUFFIXES[l.face]];
      const px = Math.min(img.width - 1, Math.max(0, Math.floor(l.u * img.width)));
      const py = Math.min(img.height - 1, Math.max(0, Math.floor(l.v * img.height)));
      const o = (py * img.width + px) * 4;
      return [img.data[o], img.data[o+1], img.data[o+2]];
    };
    const seamErr = (b: FaceBasis[], cap: 'up' | 'dn') => {
      // edges between the cap and the 4 sides: directions with |z| == max(|x|,|y|)
      const sz = cap === 'up' ? 1 : -1;
      const n = faces.rt.width;
      const eps = 1.5 / n;
      let e = 0, c = 0;
      for (let k = 0; k < 4; k++) {
        for (let i = 1; i < 200; i++) {
          const s = -1 + (2 * i) / 200;
          // side direction k: +X,-Y,-X,+Y
          const dx = [1, 0, -1, 0][k], dy = [0, -1, 0, 1][k];
          const px = dx + (dx === 0 ? s : 0), py = dy + (dy === 0 ? s : 0);
          const a = sample(b, px, py, sz * (1 - eps)); // side
          const bb = sample(b, px * (1 - eps), py * (1 - eps), sz); // cap
          e += Math.abs(a[0] - bb[0]) + Math.abs(a[1] - bb[1]) + Math.abs(a[2] - bb[2]); c++;
        }
      }
      return e / c;
    };
    const sideErr = (b: FaceBasis[]) => {
      const n = faces.rt.width; const eps = 1.5 / n; let e = 0, c = 0;
      for (const [x, y] of [[1,1],[1,-1],[-1,1],[-1,-1]]) for (let i = 1; i < 200; i++) {
        const z = -1 + (2 * i) / 200;
        const a = sample(b, x, y * (1 - eps), z), bb = sample(b, x * (1 - eps), y, z);
        e += Math.abs(a[0] - bb[0]) + Math.abs(a[1] - bb[1]) + Math.abs(a[2] - bb[2]); c++;
      }
      return e / c;
    };
    const base = SKY_SUFFIXES.map(s => SOURCE_SKY_BASIS[s]);
    out('  side seam err', sideErr(base).toFixed(2));
    for (const cap of ['up', 'dn'] as const) {
      const fi = SKY_SUFFIXES.indexOf(cap);
      const res: string[] = [];
      for (const r of axes) for (const d of axes) {
        if (r[0] * d[0] + r[1] * d[1] !== 0) continue;
        const b = base.slice();
        b[fi] = { dir: base[fi].dir, right: r, down: d };
        res.push(`${JSON.stringify(r)}/${JSON.stringify(d)}=${seamErr(b, cap).toFixed(2)}`);
      }
      out('  ', cap, 'chosen', seamErr(base, cap).toFixed(2), res.join(' '));
    }
    out('  sun', JSON.stringify(findSkySun(faces)));
  }
});
