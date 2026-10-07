import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { loadRealMap } from './gameworld_host';
const DIR = process.env.SURF_TEST_MAPS ?? '';
const OUT = '/tmp/claude-0/-home-user-test/4cd66f7e-dee7-5b7c-8a96-78dcd13ebe7d/scratchpad/out';
const MAPS = ['surf_kitsune', 'surf_utopia_njv', 'surf_beginner', 'surf_rookie', 'surf_aircontrol_ksf', 'surf_mesa_fixed', 'surf_ing', 'surf_lt_omnific'];
const f = (n: number) => n.toFixed(0);
describe('dump', () => {
  for (const name of MAPS) it(name, async () => {
    const p = join(DIR, `${name}.bsp`);
    if (!existsSync(p)) return;
    const map = await loadRealMap(p);
    const lines: string[] = [];
    for (const e of map.entities) {
      if (['info_player_terrorist', 'info_player_counterterrorist', 'light', 'func_illusionary', 'func_detail'].includes(e.classname)) continue;
      const m = e.model > 0 ? map.models[e.model] : null;
      const box = m ? ` box=[${f(m.mins.x)},${f(m.mins.y)},${f(m.mins.z)}]-[${f(m.maxs.x)},${f(m.maxs.y)},${f(m.maxs.z)}]` : ` o=(${f(e.origin.x)},${f(e.origin.y)},${f(e.origin.z)}) ang=${e.angles.yaw}`;
      const kv = Object.entries(e.kv).filter(([k]) => !['classname', 'targetname', 'origin', 'model', 'angles', 'rendercolor', 'renderfx', 'disablereceiveshadows', 'disableshadows', 'hammerid', 'renderamt', 'rendermode', 'origin'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push(`#${e.index} ${e.classname} '${e.targetname}'${box} ${kv} ${e.outputs.map((o) => `[${o.event}>${o.target}.${o.input}(${o.param})@${o.delay}x${o.timesToFire}]`).join('')}`);
    }
    writeFileSync(join(OUT, `ents_${name}.txt`), lines.join('\n') + '\n');
  }, 60000);
});
