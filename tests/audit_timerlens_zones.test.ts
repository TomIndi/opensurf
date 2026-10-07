import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { EntitySystem } from '../src/game/entities';
import { setRecordsStorage } from '../src/game/records';
import { SurfTimer } from '../src/game/timer';
import { resolveZones } from '../src/game/zoneresolve';
import { LoadedMap, ZoneDef } from '../src/map/types';
import { setZonesFile } from '../src/maps/zones';
import { setCatalog } from '../src/maps/catalog';
import { HULL_MAXS, HULL_MINS } from '../src/physics/playertypes';
import { MASK_PLAYERSOLID, newTrace } from '../src/physics/types';
import { hostForMap } from './gameworld_host';
import { loadBspMap } from '../src/bsp/loadmap';

const DIR = process.env.SURF_TEST_MAPS ?? '';
const OUT = '/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/out';
const MAPS = ['surf_kitsune', 'surf_utopia_njv', 'surf_beginner', 'surf_rookie', 'surf_aircontrol_ksf', 'surf_mesa_fixed', 'surf_ing', 'surf_lt_omnific'];

beforeAll(() => {
  setRecordsStorage(null);
  const root = join(__dirname, '..', 'public', 'maps');
  setZonesFile(JSON.parse(readFileSync(join(root, 'zones.json'), 'utf8')));
  setCatalog(JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')).maps);
});

function f(n: number): string { return n.toFixed(1); }
function zs(z: ZoneDef): string { return `${z.type} g${z.group} i${z.index} [${f(z.mins.x)},${f(z.mins.y)},${f(z.mins.z)}]-[${f(z.maxs.x)},${f(z.maxs.y)},${f(z.maxs.z)}]`; }

describe('audit zones', () => {
  for (const name of MAPS) {
    it(name, async () => {
      const p = join(DIR, `${name}.bsp`);
      if (!existsSync(p)) return;
      const buf = readFileSync(p);
      const map: LoadedMap = await loadBspMap(name, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      const lines: string[] = [];
      const z = await resolveZones(map);
      lines.push(`== ${name}: source=${z.source} n=${z.zones.length} spawns=${map.spawns.length} spawn0=${JSON.stringify(map.spawns[0])}`);
      const host = hostForMap(map, map.spawns[0].origin);
      const ents = new EntitySystem(host);
      host.entities = ents;
      ents.spawn();
      const timer = new SurfTimer(host);
      timer.setZones(z.zones, z.source);
      const tr = newTrace();
      const w = map.collision;
      const probe = (o: { x: number; y: number; z: number }): string => {
        const stuck = w.testBox(o, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
        w.traceBox(o, v3(o.x, o.y, o.z - 512), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
        return `stuck=${stuck} floorDist=${tr.fraction < 1 ? f(o.z - tr.endpos.z) : 'none'} n.z=${tr.fraction < 1 ? tr.plane.normal.z.toFixed(2) : '-'}`;
      };
      const inZone = (o: { x: number; y: number; z: number }, q: ZoneDef): boolean =>
        o.x + 16 > q.mins.x && o.x - 16 < q.maxs.x && o.y + 16 > q.mins.y && o.y - 16 < q.maxs.y && o.z + 72 > q.mins.z && o.z < q.maxs.z;
      for (const q of z.zones) {
        let extra = '';
        if (q.type === 'start' || q.type === 'stage' || q.type === 'end' || q.type === 'checkpoint') {
          const sp = q.type === 'start' ? timer.getStartSpawn(q.group) : q.type === 'stage' ? timer.getStageSpawn(q.group, q.index) : null;
          if (sp) extra = ` spawn=(${f(sp.origin.x)},${f(sp.origin.y)},${f(sp.origin.z)}) yaw=${f(sp.angles.yaw)} inZone=${inZone(sp.origin, q)} ${probe(sp.origin)}`;
          // floor at center
          const c = v3((q.mins.x + q.maxs.x) / 2, (q.mins.y + q.maxs.y) / 2, q.maxs.z);
          w.traceBox(c, v3(c.x, c.y, q.mins.z - 2048), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
          extra += ` | centerFloor=${tr.startsolid ? 'startsolid' : tr.fraction < 1 ? `${f(tr.endpos.z)} (below zone bottom by ${f(q.mins.z - tr.endpos.z)}) n.z=${tr.plane.normal.z.toFixed(2)}` : 'none'}`;
          // teleport destinations within
          const dests = map.entities.filter((e) => e.classname === 'info_teleport_destination' && e.origin.x >= q.mins.x - 16 && e.origin.x <= q.maxs.x + 16 && e.origin.y >= q.mins.y - 16 && e.origin.y <= q.maxs.y + 16 && e.origin.z >= q.mins.z - 64 && e.origin.z <= q.maxs.z + 512);
          extra += ` | dests=${dests.map((e) => `${e.targetname}@(${f(e.origin.x)},${f(e.origin.y)},${f(e.origin.z)}) yaw ${f(e.angles.yaw)}`).join('; ')}`;
        }
        lines.push(`  ${zs(q)}${extra}`);
      }
      writeFileSync(join(OUT, `zones_${name}.txt`), lines.join('\n') + '\n');
    }, 120000);
  }
});
