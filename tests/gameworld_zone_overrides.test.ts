// Real KSF maps ($SURF_TEST_MAPS, skipped when unset): the game-world audit fixes on the maps they came from.
//  - surf_utopia_njv: the surf_utopia_v3 alias preset's end hangs 1790 units over this build's end ledge; the
//    curated override (public/maps/zone_overrides.json) puts the end on the ledge, and a full game run finishes.
//  - surf_aircontrol_ksf / surf_ing: the end, checkpoints and bonuses the presets lack come from the map's own
//    timer triggers (end_trigger, cpN_trigger, bonusNstart/bonusNend).
//  - spawns: lt_omnific stage 10 (not the secret-trail landmark nook), surf_ing's !r facing the course, and
//    every start/stage spawn of kitsune/rookie/beginner/lt_omnific standing free, on ground, in its zone,
//    facing open space.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { registerConvars } from '../src/game/convars';
import { EntitySystem } from '../src/game/entities';
import { getRecords, getStageBest, setRecordsStorage } from '../src/game/records';
import { SurfTimer } from '../src/game/timer';
import { resolveZones, zoneReachable } from '../src/game/zoneresolve';
import { LoadedMap, ZoneDef } from '../src/map/types';
import { setZoneOverridesFile, setZonesFile } from '../src/maps/zones';
import { HULL_MAXS, HULL_MINS, IN_FORWARD, newUserCmd } from '../src/physics/playertypes';
import { MASK_PLAYERSOLID, newTrace } from '../src/physics/types';
import { MemStore, makeGame } from './gamecore_helpers';
import { MockHost, hostForMap, loadRealMap, physicsTick } from './gameworld_host';

const DIR = process.env.SURF_TEST_MAPS ?? '';
const has = (m: string): boolean => !!DIR && existsSync(join(DIR, `${m}.bsp`));
const ROOT = join(__dirname, '..', 'public', 'maps');
const ZONES = JSON.parse(readFileSync(join(ROOT, 'zones.json'), 'utf8'));
const OVERRIDES = JSON.parse(readFileSync(join(ROOT, 'zone_overrides.json'), 'utf8'));

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
  setZonesFile(ZONES);
  setZoneOverridesFile(OVERRIDES);
});
afterEach(() => {
  setZonesFile(ZONES);
  setZoneOverridesFile(OVERRIDES);
  for (const c of console_.allCvars()) c.reset();
});

interface W {
  host: MockHost;
  ents: EntitySystem;
  timer: SurfTimer;
  zones: ZoneDef[];
  tick(n?: number): void;
}

async function timerWorld(name: string): Promise<W> {
  setRecordsStorage(new MemStore());
  const map = await load(name);
  const z = await resolveZones(map);
  const host = hostForMap(map, map.spawns[0].origin);
  const ents = new EntitySystem(host);
  host.entities = ents;
  ents.spawn();
  const timer = new SurfTimer(host);
  host.onKill = () => timer.onPlayerKilled();
  timer.setZones(z.zones, z.source);
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      host.advance();
      ents.tick();
      timer.tick();
    }
  };
  return { host, ents, timer, zones: z.zones, tick };
}

function center(q: { mins: { x: number; y: number; z: number }; maxs: { x: number; y: number; z: number } }) {
  return v3((q.mins.x + q.maxs.x) / 2, (q.mins.y + q.maxs.y) / 2, (q.mins.z + q.maxs.z) / 2);
}

describe.skipIf(!has('surf_utopia_njv'))('surf_utopia_njv: end zone on this build', () => {
  it('the alias preset end is rejected (1790 units over the ledge); the curated end is the ledge, verified geometrically', async () => {
    const map = await load('surf_utopia_njv');
    setZoneOverridesFile(null);
    const raw = await resolveZones(map);
    expect(raw.zones.some((q) => q.type === 'end')).toBe(false);
    expect(raw.report.notes.join(' ')).toMatch(/end zone\(s\) don't fit this build/);
    setZoneOverridesFile(OVERRIDES);
    const r = await resolveZones(map);
    expect(r.source).toBe('preset');
    expect(r.report.parts.join(' + ')).toBe('SurfTimer preset (surf_utopia_v3; skipped end, checker: not on this build) + curated fixes (end)');
    const end = r.zones.filter((q) => q.type === 'end');
    expect(end).toHaveLength(1);
    expect(zoneReachable(map, end[0])).toBe(true);
    // the start that floated 251 units over the start floor is gone; the remaining one holds the 'start' destination
    const starts = r.zones.filter((q) => q.type === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].mins.z).toBe(12800);
    // the ledge: hull traces land at z -6224 across the zone's footprint (corners of the rounded ledge aside)
    const tr = newTrace();
    const e = end[0];
    let floor = 0;
    let total = 0;
    for (let x = e.mins.x + 32; x <= e.maxs.x - 32; x += 64) {
      for (let y = e.mins.y + 32; y <= e.maxs.y - 32; y += 64) {
        total++;
        map.collision.traceBox(v3(x, y, e.maxs.z), v3(x, y, e.mins.z - 512), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
        if (!tr.startsolid && tr.fraction < 1 && Math.abs(tr.endpos.z - -6224) < 1) floor++;
      }
    }
    expect(floor / total).toBeGreaterThan(0.85);
    // the back-wall return teleport (#141, target 'start') is at the zone's far side, at ledge height
    const tp = map.entities.find((q) => q.classname === 'trigger_teleport' && q.kv.target === 'start' && map.models[q.model].mins.z === -6224)!;
    expect(map.models[tp.model].maxs.x).toBeLessThanOrEqual(e.mins.x);
    expect(map.models[tp.model].maxs.z).toBeLessThan(e.maxs.z);
  });

  it('full game: leave the start, land on the end ledge -> finished and saved; walking into the back wall returns to the start', async () => {
    setRecordsStorage(new MemStore());
    const map = await load('surf_utopia_njv');
    const t = makeGame(map, { buildBuiltin: async () => map, builtinMaps: async () => [] });
    await t.game.loadBuiltinMap('surf_utopia_njv');
    const s = t.game.session!;
    expect(s.timer.getHud().state).toBe('startzone');
    t.game.say('/mi');
    expect(t.ui.texts().join('\n')).toMatch(/Zones: SurfTimer preset \(surf_utopia_v3; .*\) \+ curated fixes \(end\)/);
    t.game.executeCommand('+forward');
    for (let i = 0; i < 600 && s.timer.getHud().state !== 'running'; i++) t.game.runTicks(1);
    t.game.executeCommand('-forward');
    expect(s.timer.getHud().state).toBe('running');
    t.game.runTicks(100);
    // the final flight: from the hall towards the ledge (the last ramp's exit is far to the +x side)
    t.game.teleportPlayer(v3(-12600, 120, -5700), { pitch: 0, yaw: 180, roll: 0 }, v3(-1000, 0, 200));
    let landedAt = -1;
    for (let i = 0; i < 600 && s.timer.getHud().state === 'running'; i++) {
      t.game.runTicks(1);
      if (s.timer.getHud().state === 'finished') landedAt = i;
    }
    expect(landedAt).toBeGreaterThan(0);
    expect(s.timer.getHud().state).toBe('finished');
    expect(s.player.origin.x).toBeLessThan(-13800);
    expect(t.ui.texts().join('\n')).toMatch(/Player finished surf_utopia_njv in 00:0\d\.\d{3} \| Rank 1\/1/);
    expect(getRecords('surf_utopia_njv', 0, 100)).toHaveLength(1);
    // land, walk into the back wall's return teleport
    t.game.runTicks(50);
    expect(s.player.origin.z).toBeCloseTo(-6224, 0);
    t.game.setViewAngles(0, 180);
    t.game.executeCommand('+forward');
    for (let i = 0; i < 600 && s.player.origin.z < 0; i++) t.game.runTicks(1);
    t.game.executeCommand('-forward');
    expect(s.player.origin.z).toBeGreaterThan(12000);
    t.game.disconnect();
  });
});

describe.skipIf(!has('surf_aircontrol_ksf'))('surf_aircontrol_ksf: end and checkpoints from the map triggers', () => {
  it('the nbv preset (start only) gets end_trigger + cp1..cp5_trigger; the filtered bonus copy of the main course is not a bonus', async () => {
    const w = await timerWorld('surf_aircontrol_ksf');
    const map = w.host.map;
    expect(w.zones.filter((q) => q.type === 'checkpoint').map((q) => q.index).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(w.zones.filter((q) => q.type === 'end')).toHaveLength(1);
    expect(w.zones.some((q) => q.group > 0)).toBe(false);
    w.timer.restart(0);
    w.tick();
    expect(w.timer.getHud()).toMatchObject({ state: 'startzone', checkpointCount: 5 });
    const st = w.zones.find((q) => q.type === 'start')!;
    w.host.setPos(center(st).x, center(st).y, st.maxs.z + 200);
    w.tick();
    expect(w.timer.getHud().state).toBe('running');
    const trig = (name: string) => map.models[map.entities.find((q) => q.targetname === name)!.model];
    for (let n = 1; n <= 5; n++) {
      const b = trig(`cp${n}_trigger`);
      w.ents.onPlayerTeleported();
      w.host.setPos(center(b).x, center(b).y, center(b).z);
      w.tick(10);
      expect(w.host.chatText().some((l) => l.startsWith(`[Surf] CP ${n} | `)), `CP ${n}`).toBe(true);
    }
    const end = trig('end_trigger');
    w.ents.onPlayerTeleported();
    w.host.setPos(center(end).x, center(end).y, end.maxs.z - 100); // above the end room's floor teleport
    w.tick();
    expect(w.timer.getHud().state).toBe('finished');
    expect(getRecords('surf_aircontrol_ksf', 0, 100)).toHaveLength(1);
  });
});

describe.skipIf(!has('surf_ing'))('surf_ing: bonuses from the map triggers, !r facing the course', () => {
  it('!b 1 / !b 2 spawn in the bonus start zones; leaving starts the bonus run; bonusNend finishes it', async () => {
    const w = await timerWorld('surf_ing');
    const map = w.host.map;
    for (const g of [1, 2]) {
      w.timer.restart(g);
      w.tick();
      expect(w.timer.getHud(), `bonus ${g}`).toMatchObject({ state: 'startzone', bonus: g });
      const sp = w.timer.getStartSpawn(g);
      expect(map.collision.testBox(v3(sp.origin.x, sp.origin.y, sp.origin.z + 1), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
      const st = w.zones.find((q) => q.type === 'start' && q.group === g)!;
      w.host.setPos(center(st).x, center(st).y, st.maxs.z + 300);
      w.tick();
      expect(w.timer.getHud()).toMatchObject({ state: 'running', bonus: g });
      const end = w.zones.find((q) => q.type === 'end' && q.group === g)!;
      w.ents.onPlayerTeleported();
      w.host.setPos(center(end).x, center(end).y, center(end).z);
      w.tick();
      expect(w.timer.getHud().state).toBe('finished');
      expect(w.host.chatText().some((l) => l.includes(`finished surf_ing Bonus ${g} in`))).toBe(true);
    }
  });

  it("!r: on the start floor at the map's start destination, facing its yaw (270: the exit), not a CS spawn row facing the wall", async () => {
    const w = await timerWorld('surf_ing');
    const sp = w.timer.getStartSpawn(0);
    const start2 = w.host.map.entities.find((q) => q.targetname === 'start2')!;
    expect(sp.angles.yaw).toBe(270);
    expect(sp.origin.x).toBe(start2.origin.x);
    expect(sp.origin.z).toBeCloseTo(14944, 0);
    // walking forward leaves the start zone and drops off the ledge into the course
    w.timer.restart(0);
    const cmd = newUserCmd();
    cmd.forwardmove = 450;
    cmd.buttons = IN_FORWARD;
    for (let i = 0; i < 300 && w.timer.getHud().state !== 'running'; i++) physicsTick(w.host, cmd, [w.ents, w.timer]);
    expect(w.timer.getHud().state).toBe('running');
    for (let i = 0; i < 100; i++) physicsTick(w.host, cmd, [w.ents, w.timer]);
    expect(w.host.player.origin.z).toBeLessThan(14900);
  });
});

/** Standing checks for a spawn: hull free, on walkable ground, touching its zone, open space ahead. */
function checkSpawn(map: LoadedMap, sp: { origin: { x: number; y: number; z: number }; angles: { yaw: number } }, zone: ZoneDef, label: string): void {
  const w = map.collision;
  const o = sp.origin;
  const tr = newTrace();
  const free = !w.testBox(v3(o.x, o.y, o.z), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID) || !w.testBox(v3(o.x, o.y, o.z + 1), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
  expect(free, `${label}: hull free`).toBe(true);
  w.traceBox(v3(o.x, o.y, o.z + 1), v3(o.x, o.y, o.z - 4), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
  expect(tr.fraction < 1 && tr.plane.normal.z >= 0.7, `${label}: on ground`).toBe(true);
  const inside =
    o.x + 16 > zone.mins.x && o.x - 16 < zone.maxs.x && o.y + 16 > zone.mins.y && o.y - 16 < zone.maxs.y && o.z < zone.maxs.z && o.z + 72 > zone.mins.z;
  expect(inside, `${label}: in its zone`).toBe(true);
  const r = (sp.angles.yaw * Math.PI) / 180;
  w.traceBox(v3(o.x, o.y, o.z + 4), v3(o.x + Math.cos(r) * 2048, o.y + Math.sin(r) * 2048, o.z + 4), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
  expect(tr.startsolid ? 0 : tr.fraction * 2048, `${label}: open space ahead`).toBeGreaterThan(256);
}

describe('start and stage spawns on real maps', () => {
  it.skipIf(!has('surf_lt_omnific'))("lt_omnific stage 10: the stage's real start (qr_t4, target of its fail teleport), not the secret-trail landmark nook", async () => {
    const w = await timerWorld('surf_lt_omnific');
    const sp = w.timer.getStageSpawn(0, 10)!;
    const qr = w.host.map.entities.find((q) => q.targetname === 'qr_t4')!;
    expect([sp.origin.x, sp.origin.y, sp.angles.yaw]).toEqual([qr.origin.x, qr.origin.y, 180]);
    // !s 10 then +forward: the player walks out (it used to stop against a wall after 32 units)
    w.timer.gotoStage(10);
    const cmd = newUserCmd();
    cmd.forwardmove = 450;
    cmd.buttons = IN_FORWARD;
    for (let i = 0; i < 100; i++) physicsTick(w.host, cmd, [w.ents, w.timer]);
    expect(Math.hypot(w.host.player.origin.x - sp.origin.x, w.host.player.origin.y - sp.origin.y)).toBeGreaterThan(200);
  });

  for (const name of ['surf_kitsune', 'surf_rookie', 'surf_beginner', 'surf_lt_omnific', 'surf_utopia_njv', 'surf_aircontrol_ksf', 'surf_mesa_fixed', 'surf_ing']) {
    it.skipIf(!has(name))(`${name}: every start and stage spawn stands free, on ground, in its zone, facing open space`, async () => {
      const w = await timerWorld(name);
      const map = w.host.map;
      const groups = [...new Set(w.zones.filter((q) => q.type === 'start').map((q) => q.group))];
      for (const g of groups) {
        const sp = w.timer.getStartSpawn(g);
        const zs = w.zones.filter((q) => q.type === 'start' && q.group === g);
        const zone = zs.find((q) => sp.origin.x + 16 > q.mins.x && sp.origin.x - 16 < q.maxs.x && sp.origin.y + 16 > q.mins.y && sp.origin.y - 16 < q.maxs.y) ?? zs[0];
        checkSpawn(map, sp, zone, `${name} start ${g}`);
      }
      for (const st of w.zones.filter((q) => q.type === 'stage' && q.group === 0)) {
        const sp = w.timer.getStageSpawn(0, st.index)!;
        expect(sp, `${name} stage ${st.index}`).not.toBeNull();
        checkSpawn(map, sp, st, `${name} stage ${st.index}`);
      }
    });
  }
});

describe.skipIf(!has('surf_kitsune'))('surf_kitsune: !s stage practice', () => {
  it('stage 3: 0 while in the zone, timed from leaving it to stage 4', async () => {
    const w = await timerWorld('surf_kitsune');
    w.timer.gotoStage(3);
    w.tick(30);
    expect(w.timer.getHud()).toMatchObject({ state: 'practice', stage: 3, time: 0 });
    const s3 = w.zones.find((q) => q.type === 'stage' && q.index === 3)!;
    w.host.setPos(center(s3).x, center(s3).y, s3.maxs.z + 300); // out of the zone
    w.tick(250);
    expect(w.timer.getHud().time).toBeCloseTo(2.49, 6);
    const s4 = w.zones.find((q) => q.type === 'stage' && q.index === 4)!;
    w.ents.onPlayerTeleported();
    w.host.setPos(center(s4).x, center(s4).y, center(s4).z);
    w.tick();
    expect(w.host.chatText().at(-1)).toBe('[Surf] Stage 3 | 00:02.500 (first time)');
    expect(getStageBest('surf_kitsune', 0, 3, 100)?.time).toBeCloseTo(2.5, 6);
    expect(w.timer.getHud()).toMatchObject({ state: 'practice', stage: 4, time: 0 });
  });
});
