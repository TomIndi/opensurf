import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, it } from 'vitest';
import { setRecordsStorage } from '../src/game/records';
import { resolveZones } from '../src/game/zoneresolve';
import { LoadedMap } from '../src/map/types';
import { setZonesFile } from '../src/maps/zones';
import { setCatalog } from '../src/maps/catalog';
import { loadRealMap } from './gameworld_host';

const DIR = process.env.SURF_TEST_MAPS ?? '';
const OUT = '/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/out';
const MAPS = ['surf_kitsune', 'surf_utopia_njv', 'surf_beginner', 'surf_rookie', 'surf_aircontrol_ksf', 'surf_mesa_fixed', 'surf_ing', 'surf_lt_omnific'];

beforeAll(() => {
  setRecordsStorage(null);
  const root = join(__dirname, '..', 'public', 'maps');
  setZonesFile(JSON.parse(readFileSync(join(root, 'zones.json'), 'utf8')));
  setCatalog(JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')).maps);
});
const f = (n: number) => n.toFixed(0);
describe('audit overlap', () => {
  for (const name of MAPS) {
    it(name, async () => {
      const p = join(DIR, `${name}.bsp`);
      if (!existsSync(p)) return;
      const map: LoadedMap = await loadRealMap(p);
      const z = await resolveZones(map);
      const lines: string[] = [`== ${name} (${z.source})`];
      const classes = new Map<string, number>();
      for (const e of map.entities) classes.set(e.classname, (classes.get(e.classname) ?? 0) + 1);
      lines.push('classes: ' + [...classes].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' '));
      for (const q of z.zones) {
        const over: string[] = [];
        for (const e of map.entities) {
          if (!e.classname.startsWith('trigger_') || e.model <= 0) continue;
          const m = map.models[e.model];
          if (!m) continue;
          if (m.maxs.x <= q.mins.x || m.mins.x >= q.maxs.x || m.maxs.y <= q.mins.y || m.mins.y >= q.maxs.y || m.maxs.z <= q.mins.z || m.mins.z >= q.maxs.z) continue;
          over.push(`#${e.index} ${e.classname} name=${e.targetname} tgt=${e.kv.target ?? ''} filt=${e.kv.filtername ?? ''} sf=${e.kv.spawnflags} dis=${e.kv.startdisabled ?? ''} box=[${f(m.mins.x)},${f(m.mins.y)},${f(m.mins.z)}]-[${f(m.maxs.x)},${f(m.maxs.y)},${f(m.maxs.z)}] outs=${e.outputs.map((o) => `${o.event}>${o.target}.${o.input}(${o.param})@${o.delay}`).join(',')}`);
        }
        lines.push(`  ${q.type} g${q.group} i${q.index} [${f(q.mins.x)},${f(q.mins.y)},${f(q.mins.z)}]-[${f(q.maxs.x)},${f(q.maxs.y)},${f(q.maxs.z)}]`);
        for (const o of over) lines.push('     ' + o);
      }
      writeFileSync(join(OUT, `overlap_${name}.txt`), lines.join('\n') + '\n');
    }, 120000);
  }
});
