import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { registerConvars } from '../src/game/convars';
import { setRecordsStorage } from '../src/game/records';
import { LoadedMap } from '../src/map/types';
import { setCatalog } from '../src/maps/catalog';
import { setZonesFile } from '../src/maps/zones';
import { loadBspMap } from '../src/bsp/loadmap';
import { MemStore, makeGame } from './gamecore_helpers';

const DIR = process.env.SURF_TEST_MAPS ?? '';
async function load(name: string): Promise<LoadedMap> {
  const buf = readFileSync(join(DIR, `${name}.bsp`));
  return loadBspMap(name, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}
beforeAll(() => {
  registerConvars();
  const root = join(__dirname, '..', 'public', 'maps');
  setZonesFile(JSON.parse(readFileSync(join(root, 'zones.json'), 'utf8')));
  setCatalog(JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')).maps);
});
afterEach(() => { for (const c of console_.allCvars()) c.reset(); });
const f = (n: number) => n.toFixed(0);

describe('audit fall', () => {
  for (const name of (process.env.AUDIT_MAPS ?? 'surf_lt_omnific').split(',')) {
    it(name, async () => {
      if (!existsSync(join(DIR, `${name}.bsp`))) return;
      setRecordsStorage(new MemStore());
      const map = await load(name);
      const t = makeGame(map, { buildBuiltin: async () => map, builtinMaps: async () => [] });
      await t.game.loadBuiltinMap(name);
      const g = t.game; const s = g.session!; const ps = s.player;
      const ents = s.entities as any;
      let tps = 0;
      ents.addTeleportListener(() => tps++);
      const zones = s.timer.getZones();
      const stages = [1, ...zones.filter((z) => z.type === 'stage' && z.group === 0).map((z) => z.index).sort((a, b) => a - b)];
      for (const n of stages) {
        g.say(n === 1 ? '/r' : `/s ${n}`);
        const sp = { ...ps.origin };
        tps = 0;
        // walk forward off the start and keep holding forward for 12 s without strafing
        g.executeCommand('+forward');
        let lowest = sp.z; let firstTp = -1; let longestFall = 0; let fall = 0; let tpOrigin = '';
        const t0 = tps;
        for (let i = 0; i < 1200; i++) {
          const before = tps;
          g.runTicks(1);
          if (tps > before && firstTp < 0) { firstTp = i; tpOrigin = `(${f(ps.origin.x)},${f(ps.origin.y)},${f(ps.origin.z)})`; }
          if (ps.velocity.z < -100 && !ps.onGround) fall++; else fall = 0;
          longestFall = Math.max(longestFall, fall);
          lowest = Math.min(lowest, ps.origin.z);
        }
        g.executeCommand('-forward');
        const h = s.timer.getHud();
        const d = Math.hypot(ps.origin.x - sp.x, ps.origin.y - sp.y, ps.origin.z - sp.z);
        console.log(`${name} stage ${n}: spawn (${f(sp.x)},${f(sp.y)},${f(sp.z)}) mapTeleports=${tps - t0} firstTp@${firstTp} -> ${tpOrigin} final (${f(ps.origin.x)},${f(ps.origin.y)},${f(ps.origin.z)}) dist=${f(d)} lowest=${f(lowest)} longestFallTicks=${longestFall} hud stage=${h.stage} state=${h.state} tn='${s.entities.playerTargetname}' vel=${f(Math.hypot(ps.velocity.x, ps.velocity.y, ps.velocity.z))}`);
      }
      g.disconnect();
    }, 600000);
  }
});
