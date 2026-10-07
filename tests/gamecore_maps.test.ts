// The whole game core on real KSF maps ($SURF_TEST_MAPS): load -> entities -> SurfTimer preset zones -> spawn in
// the start zone -> the fixed-tick loop with input, triggers and timer. Skipped when the maps are unavailable.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { registerConvars } from '../src/game/convars';
import { setRecordsStorage } from '../src/game/records';
import { LoadedMap } from '../src/map/types';
import { setCatalog } from '../src/maps/catalog';
import { setZonesFile } from '../src/maps/zones';
import { loadRealMap } from './gameworld_host';
import { MemStore, makeGame } from './gamecore_helpers';

const DIR = process.env.SURF_TEST_MAPS ?? '';
const MAPS = ['surf_beginner', 'surf_utopia_njv', 'surf_kitsune', 'surf_rookie', 'surf_aircontrol_ksf', 'surf_mesa_fixed', 'surf_ing', 'surf_lt_omnific'];
const available = DIR ? MAPS.filter((m) => existsSync(join(DIR, `${m}.bsp`))) : [];

const cache = new Map<string, LoadedMap>();
async function load(name: string): Promise<LoadedMap> {
  let m = cache.get(name);
  if (!m) {
    m = await loadRealMap(join(DIR, `${name}.bsp`));
    cache.set(name, m);
  }
  return m;
}

beforeAll(() => {
  registerConvars();
  const root = join(__dirname, '..', 'public', 'maps');
  if (existsSync(join(root, 'zones.json'))) setZonesFile(JSON.parse(readFileSync(join(root, 'zones.json'), 'utf8')));
  if (existsSync(join(root, 'catalog.json'))) setCatalog(JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')).maps);
});
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
});

describe.skipIf(!available.length)('game core on real maps', () => {
  for (const name of available) {
    it(`${name}: loads, spawns in the start zone and simulates`, async () => {
      setRecordsStorage(new MemStore());
      const map = await load(name);
      const t = makeGame(map, { buildBuiltin: async () => map, builtinMaps: async () => [] });
      await t.game.loadCatalogMap(name).catch(() => undefined); // not loadable here (no download): falls back below
      await t.game.loadBuiltinMap(name);
      expect(t.game.state, name).toBe('playing');
      const s = t.game.session!;
      const hud = s.timer.getHud();
      const zones = s.timer.getZones();
      const hasStart = zones.some((z) => z.type === 'start' || z.type === 'speedstart');
      if (hasStart) expect(hud.state, `${name} spawns in its start zone (${s.timer.zoneSource})`).toBe('startzone');
      expect(t.renderer.loaded).toBe(map);

      // idle for a second: the player settles, nothing explodes
      const t0 = performance.now();
      t.game.runTicks(100);
      const o = s.player.origin;
      expect(Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z), name).toBe(true);
      // walk forward + strafe-jump for 3 seconds with turning: the full tick pipeline (triggers, timer, sounds)
      t.game.executeCommand('+forward; +jump');
      for (let i = 0; i < 300; i++) {
        if (i % 50 === 0) t.game.setViewAngles(0, t.game.getViewAngles().yaw + 30);
        t.game.runTicks(1);
      }
      t.game.executeCommand('-forward; -jump');
      const ms = (performance.now() - t0) / 400;
      if (process.env.SURF_REPORT_TIMINGS) console.log(`[timing] ${name}: ${ms.toFixed(3)} ms per tick (entities ${map.entities.length}, zones ${s.timer.zoneSource})`);
      expect(Number.isFinite(s.player.origin.x), name).toBe(true);
      expect(ms, `${name}: ${ms.toFixed(3)} ms per tick`).toBeLessThan(5);
      // !r always works and brings us back
      t.game.say('/r');
      if (hasStart) expect(s.timer.getHud().state, name).toBe('startzone');
      // frames render
      t.game.frame(1000);
      t.game.frame(1016);
      expect(t.renderer.renders.length, name).toBeGreaterThan(0);
      expect(t.ui.texts().some((l) => l.includes(`Welcome to ${map.name}`))).toBe(true);
      t.game.disconnect();
    });
  }

  it.skipIf(!available.includes('surf_kitsune'))('surf_kitsune: SurfTimer preset zones, staged, stage restarts', async () => {
    setRecordsStorage(new MemStore());
    const map = await load('surf_kitsune');
    const t = makeGame(map, { buildBuiltin: async () => map });
    await t.game.loadBuiltinMap('surf_kitsune');
    const s = t.game.session!;
    expect(s.timer.zoneSource).toBe('preset');
    expect(s.tier).toBeNull(); // built-in path: tier comes from the built-in list
    t.game.say('/mi');
    expect(t.ui.lastText()).toMatch(/Staged \(\d+ stages\)/);
    expect(t.game.getHud().timer.mapType).toBe('staged');
    // !s 2 goes to stage 2 in practice; !back returns there
    t.game.say('/s 2');
    const st2 = { ...s.player.origin };
    t.game.teleportPlayer({ x: st2.x + 200, y: st2.y, z: st2.z + 100 }, null, null);
    t.game.say('/back');
    expect(Math.hypot(s.player.origin.x - st2.x, s.player.origin.y - st2.y)).toBeLessThan(64);
    t.game.disconnect();
  });
});
