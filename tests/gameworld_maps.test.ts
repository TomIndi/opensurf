// Real KSF maps (CS:S VBSP v20) from $SURF_TEST_MAPS: entity spawning, trigger touching with real brushes,
// teleport destinations, I/O diagnostics, zone resolution against the SurfTimer presets, timer spawns.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { EntitySystem } from '../src/game/entities';
import { ReplaySystem } from '../src/game/replay';
import { setRecordsStorage } from '../src/game/records';
import { SurfTimer } from '../src/game/timer';
import { resolveZones } from '../src/game/zoneresolve';
import { LoadedMap } from '../src/map/types';
import { setZonesFile } from '../src/maps/zones';
import { IN_FORWARD, newUserCmd } from '../src/physics/playertypes';
import { hostForMap, loadRealMap, physicsTick } from './gameworld_host';

const DIR = process.env.SURF_TEST_MAPS ?? '';
/** Optional directory with very large maps (surf_summer_ksf.bsp, 323 MB). */
const DIR_LARGE = process.env.SURF_TEST_MAPS_LARGE ?? '';
const SUMMER = DIR_LARGE ? join(DIR_LARGE, 'surf_summer_ksf.bsp') : '';
const MAPS = ['surf_kitsune', 'surf_utopia_njv', 'surf_beginner', 'surf_rookie', 'surf_aircontrol_ksf', 'surf_mesa_fixed', 'surf_ing', 'surf_lt_omnific'];
const available = DIR ? MAPS.filter((m) => existsSync(join(DIR, `${m}.bsp`))) : [];

/** Inputs every surf map uses: they must never be reported as unknown. */
const COMMON_INPUTS = [
  'addoutput',
  'enable',
  'disable',
  'toggle',
  'trigger',
  'kill',
  'killhierarchy',
  'showhudhint',
  'hidehudhint',
  'modifyspeed',
  'add',
  'subtract',
  'setvalue',
  'setdamagefilter',
  'command',
  'alpha',
  'color',
  'teleport',
  'display',
  'cancelpending',
  'fireuser1',
  'playsound',
  'setparent',
];

const cache = new Map<string, LoadedMap>();
async function load(name: string): Promise<LoadedMap> {
  let m = cache.get(name);
  if (!m) {
    m = await loadRealMap(join(DIR, `${name}.bsp`));
    cache.set(name, m);
  }
  return m;
}

function brushCenter(m: LoadedMap, model: number): { x: number; y: number; z: number } | null {
  const b = m.models[model]?.brushes[0];
  if (!b) return null;
  return { x: (b.mins.x + b.maxs.x) / 2, y: (b.mins.y + b.maxs.y) / 2, z: (b.mins.z + b.maxs.z) / 2 };
}

beforeAll(() => {
  setRecordsStorage(null);
  const zonesPath = join(__dirname, '..', 'public', 'maps', 'zones.json');
  if (existsSync(zonesPath)) setZonesFile(JSON.parse(readFileSync(zonesPath, 'utf8')));
});

describe.skipIf(!SUMMER || !existsSync(SUMMER))('large map (surf_summer_ksf)', () => {
  it('Momentum timer triggers become zones; basevelocity boosters and classname filters spawn cleanly', async () => {
    const map = await loadRealMap(SUMMER);
    const z = await resolveZones(map);
    expect(z.source).toBe('momentum');
    expect(z.zones.filter((q) => q.type === 'stage')).toHaveLength(10);
    expect(z.zones.filter((q) => q.type === 'start' && q.group === 0)).toHaveLength(1);
    expect(z.zones.filter((q) => q.type === 'end' && q.group === 0)).toHaveLength(1);
    // the bonus the Momentum triggers lack comes from the map's zone_b1_start / zone_b1_end triggers
    expect(z.report.parts).toEqual(['Momentum timer triggers', 'map timer triggers (bonus 1)']);
    const b1 = z.zones.find((q) => q.type === 'start' && q.group === 1)!;
    expect(b1.mins).toEqual(map.models[map.entities.find((e) => e.targetname === 'zone_b1_start')!.model].mins);
    expect(z.zones.some((q) => q.type === 'end' && q.group === 1)).toBe(true);
    const host = hostForMap(map, map.spawns[0].origin);
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    const timer = new SurfTimer(host);
    timer.setZones(z.zones, z.source);
    timer.restart(0);
    host.advance();
    ents.tick();
    timer.tick();
    expect(timer.getHud()).toMatchObject({ mapType: 'staged', stageCount: 11 });
    expect(ents.diagnostics().unknownInputs.size).toBe(0);
    // !b 1: spawned standing in the bonus start zone
    timer.restart(1);
    host.advance();
    ents.tick();
    timer.tick();
    expect(timer.getHud()).toMatchObject({ state: 'startzone', bonus: 1 });
  });
});

describe.skipIf(!available.length)('game world on real maps', () => {
  for (const name of available) {
    it(`${name}: triggers spawn, teleports resolve and fire with real brushes, no unknown common inputs`, async () => {
      const map = await load(name);
      const host = hostForMap(map, v3(0, 0, -100000));
      const ents = new EntitySystem(host);
      host.entities = ents;
      ents.spawn();
      const d0 = ents.diagnostics();
      expect(d0.triggers).toBeGreaterThan(0);

      // every trigger_teleport target that exists in the lump resolves through the entity system
      const names = new Set(map.entities.filter((e) => e.targetname).map((e) => e.targetname.toLowerCase()));
      let resolvable = 0;
      for (const e of map.entities) {
        if (e.classname !== 'trigger_teleport') continue;
        const t = (e.kv.target ?? '').toLowerCase();
        if (!names.has(t)) continue;
        resolvable++;
        expect(ents.findTarget(t), `${name}: target ${t}`).not.toBeNull();
      }
      expect(resolvable).toBeGreaterThan(0);

      // put the player inside each unfiltered, enabled, client trigger_teleport: it must teleport to its target
      let probed = 0;
      for (const e of map.entities) {
        if (e.classname !== 'trigger_teleport' || e.model <= 0) continue;
        const sf = parseInt(e.kv.spawnflags ?? '0', 10) || 0;
        if (!(sf & 1) || e.kv.filtername || e.kv.landmark || e.kv.startdisabled === '1' || e.targetname) continue;
        const dest = ents.findTarget(e.kv.target ?? '');
        const c = brushCenter(map, e.model);
        if (!dest || !c) continue;
        ents.onPlayerTeleported();
        ents.playerTargetname = '';
        host.setPos(c.x, c.y, c.z - 36);
        const before = host.teleports.length;
        host.advance();
        ents.tick();
        // (mappers often stack duplicate teleports: every overlapping one fires in that tick, like Source)
        const fired = host.teleports.slice(before);
        expect(fired.length, `${name}: trigger_teleport #${e.index} -> ${e.kv.target}`).toBeGreaterThan(0);
        expect(fired.map((t) => t.origin)).toContainEqual(dest.origin);
        probed++;
      }
      expect(probed).toBeGreaterThan(0);

      // touch every trigger once (fires their outputs through the I/O system), then run the queue a while
      for (const e of map.entities) {
        if (!e.classname.startsWith('trigger_') || e.model <= 0) continue;
        const c = brushCenter(map, e.model);
        if (!c) continue;
        ents.onPlayerTeleported();
        host.setPos(c.x, c.y, c.z - 36);
        host.advance();
        ents.tick();
      }
      for (let i = 0; i < 3000; i++) {
        host.advance();
        ents.tick();
      }
      const d = ents.diagnostics();
      for (const key of d.unknownInputs.keys()) {
        const input = key.slice(key.lastIndexOf('.') + 1);
        expect(COMMON_INPUTS, `${name}: unknown common input ${key}`).not.toContain(input);
      }
    });
  }

  it.skipIf(!available.includes('surf_kitsune'))('surf_kitsune: preset zones, start spawn inside the start zone, filters', async () => {
    const map = await load('surf_kitsune');
    const z = await resolveZones(map);
    expect(z.source).toBe('preset');
    expect(z.zones.filter((q) => q.type === 'stage')).toHaveLength(8);
    const host = hostForMap(map, map.spawns[0].origin);
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    const timer = new SurfTimer(host);
    timer.setZones(z.zones, z.source);
    const sp = timer.getStartSpawn(0);
    const red = ents.findTarget('red')!;
    // the info_teleport_destination inside the start zone, dropped onto the floor (z 816)
    expect(sp.origin.x).toBe(red.origin.x);
    expect(sp.origin.y).toBe(red.origin.y);
    expect(sp.origin.z).toBeCloseTo(816.03125, 3);
    expect(sp.angles.yaw).toBe(red.angles.yaw);
    timer.restart(0);
    host.advance();
    ents.tick();
    timer.tick();
    expect(timer.getHud()).toMatchObject({ state: 'startzone', stageCount: 9, mapType: 'staged' });
    // stage 2 spawn is the destination at the stage 2 start ("orange")
    const s2 = timer.getStageSpawn(0, 2)!;
    expect(s2).not.toBeNull();
    expect(s2.origin.z).toBeGreaterThan(-700);
  });

  for (const name of ['surf_beginner', 'surf_rookie', 'surf_kitsune'].filter((m) => available.includes(m))) {
    it(`${name}: stage teleports advance the timer through the preset stages`, async () => {
      setRecordsStorage(null);
      const map = await load(name);
      const z = await resolveZones(map);
      expect(z.source).toBe('preset');
      const host = hostForMap(map, map.spawns[0].origin);
      const ents = new EntitySystem(host);
      host.entities = ents;
      ents.spawn();
      const timer = new SurfTimer(host);
      timer.setZones(z.zones, z.source);
      const tick = (): void => {
        host.advance();
        ents.tick();
        timer.tick();
      };
      // no physics here: "fall" until a zone (or anything) is reached
      const fall = (until: () => boolean): void => {
        for (let i = 0; i < 200 && !until(); i++) {
          host.setPos(host.player.origin.x, host.player.origin.y, host.player.origin.z - 8);
          tick();
        }
      };
      timer.restart(0);
      tick();
      fall(() => timer.getHud().state === 'startzone');
      expect(timer.getHud().state).toBe('startzone');
      // leave the start zone upwards: the run starts
      const start = z.zones.find((q) => q.type === 'start' && q.group === 0)!;
      host.setPos((start.mins.x + start.maxs.x) / 2, (start.mins.y + start.maxs.y) / 2, start.maxs.z + 200);
      tick();
      expect(timer.getHud().state).toBe('running');
      const stages = z.zones.filter((q) => q.type === 'stage' && q.group === 0).sort((a, b) => a.index - b.index);
      const inside = (p: { x: number; y: number; z: number }, q: (typeof stages)[0]): boolean =>
        p.x >= q.mins.x - 16 && p.x <= q.maxs.x + 16 && p.y >= q.mins.y - 16 && p.y <= q.maxs.y + 16 && p.z >= q.mins.z - 72 && p.z <= q.maxs.z + 512;
      let reached = 0;
      for (const st of stages) {
        // a client trigger_teleport whose destination is in this stage's start zone but which is elsewhere
        const tp = map.entities.find((e) => {
          if (e.classname !== 'trigger_teleport' || e.model <= 0 || e.kv.filtername || e.kv.startdisabled === '1') return false;
          if (!((parseInt(e.kv.spawnflags ?? '0', 10) || 0) & 1)) return false;
          const d = ents.findTarget(e.kv.target ?? '');
          const c = brushCenter(map, e.model);
          return !!d && !!c && inside(d.origin, st) && !inside(c, st);
        });
        if (!tp) continue;
        const c = brushCenter(map, tp.model)!;
        ents.onPlayerTeleported();
        host.setPos(c.x, c.y, c.z - 36);
        tick(); // touch -> teleport to the stage start
        expect(host.teleports.at(-1)?.origin).toEqual(ents.findTarget(tp.kv.target ?? '')!.origin);
        fall(() => timer.getHud().stage === st.index); // drop into the stage zone -> split
        expect(timer.getHud().stage, `${name}: stage ${st.index} via trigger #${tp.index}`).toBe(st.index);
        expect(host.chatText().at(-1)).toMatch(new RegExp(`^\\[Surf\\] Stage ${st.index} \\| `));
        reached++;
      }
      expect(reached).toBeGreaterThan(stages.length / 2);
    });
  }

  it.skipIf(!available.includes('surf_kitsune'))('surf_kitsune with real movement: leave the start, fall into the fail teleport, back in the start zone', async () => {
    setRecordsStorage(null);
    const map = await load('surf_kitsune');
    const host = hostForMap(map, map.spawns[0].origin);
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    const timer = new SurfTimer(host);
    host.onKill = () => timer.onPlayerKilled();
    const replay = new ReplaySystem(map.name);
    timer.setReplay(replay);
    const z = await resolveZones(map);
    timer.setZones(z.zones, z.source);
    timer.restart(0);
    expect(timer.getHud().state).toBe('startzone');
    const cmd = newUserCmd();
    const states: string[] = [];
    let teleportsWhileRunning = 0;
    for (let i = 0; i < 1500; i++) {
      cmd.forwardmove = i > 50 ? 450 : 0;
      cmd.buttons = i > 50 ? IN_FORWARD : 0;
      const before = host.teleports.length;
      const wasRunning = timer.getHud().state === 'running';
      physicsTick(host, cmd, [ents, timer]);
      replay.recordTick(host.player.origin, host.player.viewAngles, host.player.ducked, cmd.buttons);
      if (wasRunning && host.teleports.length > before) teleportsWhileRunning++;
      const st = timer.getHud().state;
      if (states.at(-1) !== st) states.push(st);
    }
    // walked out of the start (run + recording), fell into the stage 1 fail teleport -> start zone again
    expect(states.slice(0, 3)).toEqual(['startzone', 'running', 'startzone']);
    expect(teleportsWhileRunning).toBeGreaterThan(0);
    expect(host.player.origin.z).toBeGreaterThan(700);
  });

  it.skipIf(!available.includes('surf_utopia_njv'))('surf_utopia_njv: zones resolve (alias preset or heuristic) and the start spawn is in the start area', async () => {
    const map = await load('surf_utopia_njv');
    const z = await resolveZones(map);
    expect(['preset', 'heuristic']).toContain(z.source);
    const starts = z.zones.filter((q) => q.type === 'start' && q.group === 0);
    expect(starts.length).toBeGreaterThan(0);
    const host = hostForMap(map, map.spawns[0].origin);
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    const timer = new SurfTimer(host);
    timer.setZones(z.zones, z.source);
    timer.restart(0);
    host.advance();
    ents.tick();
    timer.tick();
    // falls into / stands in the start zone
    for (let i = 0; i < 200 && timer.getHud().state !== 'startzone'; i++) {
      host.setPos(host.player.origin.x, host.player.origin.y, host.player.origin.z - 1);
      host.advance();
      ents.tick();
      timer.tick();
    }
    expect(timer.getHud().state).toBe('startzone');
  });

  it.skipIf(!available.includes('surf_kitsune'))('surf_kitsune through the full loader (src/bsp/loadmap.ts, when present)', async () => {
    const path = '../src/bsp/loadmap';
    let loadBspMap: ((name: string, data: ArrayBuffer) => Promise<LoadedMap>) | null = null;
    try {
      loadBspMap = (await import(/* @vite-ignore */ path)).loadBspMap ?? null;
    } catch {
      loadBspMap = null;
    }
    if (!loadBspMap) return; // bsp-render loader not available yet
    const buf = readFileSync(join(DIR, 'surf_kitsune.bsp'));
    const map = await loadBspMap('surf_kitsune', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const host = hostForMap(map, map.spawns[0].origin);
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    expect(ents.diagnostics().triggers).toBeGreaterThan(50);
    expect(ents.findTarget('red')).not.toBeNull();
    const z = await resolveZones(map);
    expect(z.source).toBe('preset');
  });

  it.skipIf(!available.includes('surf_lt_omnific'))('surf_lt_omnific: entity tick stays cheap with ~500 triggers', async () => {
    const map = await load('surf_lt_omnific');
    const host = hostForMap(map, map.spawns[0].origin);
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    for (let i = 0; i < 200; i++) {
      host.advance();
      ents.tick();
    }
    const t0 = performance.now();
    const N = 5000;
    for (let i = 0; i < N; i++) {
      host.player.origin.x += 0.5;
      host.advance();
      ents.tick();
    }
    const per = (performance.now() - t0) / N;
    expect(per).toBeLessThan(0.2); // ms per tick (typically ~0.01)
  });
});
