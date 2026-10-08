// Regression tests for the game-world audit fixes (mock maps; the real-map counterparts are in
// tests/gameworld_zone_overrides.test.ts): zone validation of presets made for other builds, curated
// overrides, zones from the map's own timer triggers, spawn selection, practice in the start zone, stage
// practice (!s), records/replays per tickrate, logic_auto OnMultiNewRound and trigger_hurt cadence.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { EntitySystem } from '../src/game/entities';
import {
  RECORDS_STORAGE_KEY,
  RecordsStorage,
  addRecord,
  clearRecords,
  courseKey,
  exportRecords,
  getCompletions,
  getPersonalBest,
  getRecords,
  getStageBest,
  importRecords,
  setRecordsStorage,
  tickLabel,
} from '../src/game/records';
import { FRAME_STRIDE, ReplaySystem, replayKey } from '../src/game/replay';
import { SurfTimer, openExitYaw } from '../src/game/timer';
import {
  applyZoneOverrides,
  classifyTimerTrigger,
  describeZones,
  fillMissingZones,
  fitPresetToMap,
  getZoneReport,
  mapTriggerZones,
  resolveZones,
  sameZoneBox,
  zoneReachable,
} from '../src/game/zoneresolve';
import { RunRecord } from '../src/game/contracts';
import { ZoneDef } from '../src/map/types';
import { setCatalog } from '../src/maps/catalog';
import { getZoneOverrides, setZoneOverridesFile, setZonesFile } from '../src/maps/zones';
import { MOVETYPE_NOCLIP, MOVETYPE_WALK } from '../src/physics/playertypes';
import { MapSpec, MockHost, buildMap } from './gameworld_host';

class MemStore implements RecordsStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

type V3 = [number, number, number];
const FLOOR = { mins: [-20000, -20000, -64] as V3, maxs: [20000, 20000, 0] as V3, solid: true };

function z(type: ZoneDef['type'], mins: V3, maxs: V3, extra: Partial<ZoneDef> = {}): ZoneDef {
  return { type, group: 0, index: 0, mins: v3(...mins), maxs: v3(...maxs), ...extra };
}

/** Preset zones in zones.json form. */
function pz(t: ZoneDef['type'], g: number, i: number, a: V3, b: V3): { t: ZoneDef['type']; g: number; i: number; a: V3; b: V3 } {
  return { t, g, i, a, b };
}

beforeEach(() => {
  setRecordsStorage(new MemStore());
  setZonesFile(null);
  setZoneOverridesFile(null);
  setCatalog([]);
});
afterEach(() => {
  setZonesFile(null);
  setZoneOverridesFile(null);
});

// ------------------------------------------------------------------------------------------ zone resolution

describe('presets of other builds are checked zone by zone (surf_utopia_njv / surf_utopia_v3)', () => {
  // the "njv" build: start floor at z 0 around the spawn, the end ledge at z -2000 (x 5000..5500)
  const LEDGE = { mins: [5000, -500, -2064] as V3, maxs: [5500, 500, -2000] as V3, solid: true };
  const spec: MapSpec = {
    name: 'surf_alias_njv',
    world: [{ mins: [-1000, -1000, -64], maxs: [1000, 1000, 0], solid: true }, LEDGE],
    entities: `{ "classname" "info_player_counterterrorist" "origin" "0 0 0" "angles" "0 0 0" }`,
  };
  // the "v3" preset: same start, but its end hangs 1800 units over this build's ledge; a checker in the void
  const V3_PRESET = [
    pz('start', 0, 0, [-200, -200, 0], [200, 200, 100]),
    pz('end', 0, 0, [5100, -100, -200], [5300, 100, -100]),
    pz('checker', 0, 0, [5100, -100, -9000], [5300, 100, -8900]),
  ];

  it('zoneReachable: floor within 256 units under the zone, or a teleport next to it', () => {
    const { map } = buildMap(spec);
    expect(zoneReachable(map, z('end', [5100, -100, -2000], [5300, 100, -1900]))).toBe(true);
    expect(zoneReachable(map, z('end', [5100, -100, -1800], [5300, 100, -1700]))).toBe(true); // 200 above the ledge
    expect(zoneReachable(map, z('end', [5100, -100, -200], [5300, 100, -100]))).toBe(false); // 1800 above
    const withTp = buildMap({
      ...spec,
      entities: `${spec.entities}
        { "classname" "trigger_teleport" "model" "*1" "target" "x" "spawnflags" "1" }`,
      models: { 1: { mins: [5100, -100, -260], maxs: [5300, 100, -210] } },
    }).map;
    expect(zoneReachable(withTp, z('end', [5100, -100, -200], [5300, 100, -100]))).toBe(true);
  });

  it('fitPresetToMap drops the unreachable end and checker but keeps the preset usable', () => {
    const { map } = buildMap(spec);
    const fit = fitPresetToMap(
      map,
      V3_PRESET.map((q) => z(q.t, q.a, q.b, { group: q.g, index: q.i })),
    );
    expect(fit.usable).toBe(true);
    expect(fit.complete).toBe(false);
    expect(fit.zones.map((q) => q.type)).toEqual(['start']);
    expect(fit.dropped.map((q) => q.type).sort()).toEqual(['checker', 'end']);
  });

  it('resolveZones: an incomplete alias preset gives way to the next build that fits completely', async () => {
    const { map } = buildMap(spec);
    setZonesFile({
      maps: {
        surf_alias_v3: V3_PRESET,
        surf_alias_v4: [pz('start', 0, 0, [-200, -200, 0], [200, 200, 100]), pz('end', 0, 0, [5050, -300, -2000], [5450, 300, -1900])],
      },
      aliases: { surf_alias_njv: ['surf_alias_v3', 'surf_alias_v4'] },
    });
    const r = await resolveZones(map);
    expect(r.source).toBe('preset');
    expect(r.zones.find((q) => q.type === 'end')?.mins).toEqual(v3(5050, -300, -2000));
    expect(r.report.parts[0]).toContain('surf_alias_v4');
  });

  it('resolveZones: without a fitting end, the end is dropped and the player is told', async () => {
    const { map } = buildMap(spec);
    setZonesFile({ maps: { surf_alias_v3: V3_PRESET }, aliases: { surf_alias_njv: ['surf_alias_v3'] } });
    const r = await resolveZones(map);
    expect(r.source).toBe('preset');
    expect(r.zones.map((q) => q.type)).toEqual(['start']);
    expect(r.report.parts[0]).toMatch(/surf_alias_v3; skipped end, checker: not on this build/);
    expect(r.report.notes.join(' ')).toMatch(/end zone\(s\) don't fit this build/);
    expect(getZoneReport('surf_alias_njv')).toBe(r.report);
  });

  it('curated overrides replace/add zones by type+group+index and remove preset zones; unreachable overrides are ignored', async () => {
    const { map } = buildMap(spec);
    setZonesFile({
      maps: { surf_alias_v3: [...V3_PRESET, pz('start', 0, 1, [-200, -200, 300], [200, 200, 400])] },
      aliases: { surf_alias_njv: ['surf_alias_v3'] },
    });
    setZoneOverridesFile({
      maps: {
        surf_alias_njv: {
          note: 'test',
          zones: [pz('end', 0, 0, [5000, -500, -2000], [5500, 500, -1744]), pz('end', 0, 1, [9000, 9000, 5000], [9100, 9100, 5100])],
          remove: [{ t: 'start', g: 0, i: 1 }],
        },
      },
    });
    const ov = await getZoneOverrides('SURF_ALIAS_NJV');
    expect(ov?.zones).toHaveLength(2);
    const r = await resolveZones(map);
    expect(r.zones.filter((q) => q.type === 'end')).toEqual([{ type: 'end', group: 0, index: 0, mins: v3(5000, -500, -2000), maxs: v3(5500, 500, -1744) }]);
    expect(r.zones.filter((q) => q.type === 'start').map((q) => q.index)).toEqual([0]);
    expect(r.report.parts.join(' + ')).toMatch(/curated fixes \(end\)/);
    expect(r.report.notes.join(' ')).toMatch(/Curated end zone \(group 0\) doesn't fit this build/);
    expect(r.report.notes.join(' ')).not.toMatch(/end zone\(s\) don't fit/);
  });

  it('applyZoneOverrides / describeZones', () => {
    const base = [z('start', [0, 0, 0], [1, 1, 1]), z('end', [0, 0, 0], [1, 1, 1]), z('checkpoint', [0, 0, 0], [1, 1, 1], { index: 2 })];
    const out = applyZoneOverrides(base, [z('end', [5, 5, 5], [6, 6, 6])], [{ type: 'checkpoint', group: 0, index: 2 }]);
    expect(out.map((q) => q.type)).toEqual(['start', 'end']);
    expect(out[1].mins).toEqual(v3(5, 5, 5));
    expect(describeZones([...base, z('stage', [0, 0, 0], [1, 1, 1], { index: 2 }), z('stage', [0, 0, 0], [1, 1, 1], { index: 3 }), z('start', [0, 0, 0], [1, 1, 1], { group: 2 })])).toBe(
      'start, end, stage 2-3, CP 2, bonus 2',
    );
  });
});

describe("the map's own timer triggers ('map' zone source)", () => {
  it('classifies conventional timer trigger names and rejects look-alikes', () => {
    const c = (n: string) => classifyTimerTrigger(n);
    expect(c('start_trigger')).toEqual({ type: 'start', group: 0 });
    expect(c('startzone')).toEqual({ type: 'start', group: 0 });
    expect(c('zone_start')).toEqual({ type: 'start', group: 0 });
    expect(c('surf_start')).toEqual({ type: 'start', group: 0 });
    expect(c('end_trigger')).toEqual({ type: 'end', group: 0 });
    expect(c('endzone')).toEqual({ type: 'end', group: 0 });
    expect(c('surf_end')).toEqual({ type: 'end', group: 0 });
    expect(c('cp3_trigger')).toEqual({ type: 'checkpoint', group: 0, index: 3 });
    expect(c('checkpoint12')).toEqual({ type: 'checkpoint', group: 0, index: 12 });
    expect(c('stage4_start')).toEqual({ type: 'stage', group: 0, index: 4 });
    expect(c('stage7')).toEqual({ type: 'stage', group: 0, index: 7 });
    expect(c('stage1_start')).toEqual({ type: 'start', group: 0 });
    expect(c('stage11_end')).toEqual({ type: 'stage-end', group: 0, index: 11 });
    expect(c('bonus1start')).toEqual({ type: 'start', group: 1 });
    expect(c('bonus2end')).toEqual({ type: 'end', group: 2 });
    expect(c('bonus_start')).toEqual({ type: 'start', group: 1 });
    expect(c('zone_b1_end')).toEqual({ type: 'end', group: 1 });
    expect(c('startbonus_trigger')).toEqual({ type: 'start', group: 1 });
    expect(c('endbonus_trigger')).toEqual({ type: 'end', group: 1 });
    for (const n of ['start', 'end', 'secret_trail_bonus_tm', 'ending_core_spawn_fade_tm', 'start_qr4n', 'nyro_t1_startzone', 'stage', 'cp', 'restart_trigger', 'endless', 's4', 'backstage2']) {
      expect(c(n), n).toBeNull();
    }
  });

  const TRIGGERS: MapSpec = {
    name: 'surf_triggers',
    world: [FLOOR],
    entities: `
      { "classname" "info_player_counterterrorist" "origin" "0 0 0" "angles" "0 0 0" }
      { "classname" "trigger_multiple" "targetname" "start_trigger" "model" "*1" }
      { "classname" "trigger_multiple" "targetname" "end_trigger" "model" "*2" }
      { "classname" "trigger_multiple" "targetname" "cp1_trigger" "model" "*3" }
      { "classname" "trigger_once" "targetname" "cp2_trigger" "model" "*4" }
      { "classname" "trigger_multiple" "targetname" "bonus1start" "model" "*5" }
      { "classname" "trigger_multiple" "targetname" "bonus1end" "model" "*6" }
      { "classname" "trigger_multiple" "targetname" "startbonus_trigger" "model" "*7" }
      { "classname" "trigger_teleport" "targetname" "endzone" "model" "*8" "target" "x" }
      { "classname" "trigger_multiple" "targetname" "stage1_start" "model" "*9" }`,
    models: {
      1: { mins: [-200, -200, 0], maxs: [200, 200, 128] },
      2: { mins: [5000, -200, 0], maxs: [5400, 200, 128] },
      3: { mins: [1000, -200, 0], maxs: [1100, 200, 128] },
      4: { mins: [2000, -200, 0], maxs: [2100, 200, 128] },
      5: { mins: [-200, 3000, 0], maxs: [200, 3400, 128] },
      6: { mins: [3000, 3000, 0], maxs: [3400, 3400, 128] },
      // a filtered "bonus" reusing the main start box: not a separate course
      7: { mins: [-210, -205, 0], maxs: [205, 200, 120] },
      8: { mins: [8000, 0, 0], maxs: [8100, 100, 100] },
      9: { mins: [-300, -300, 0], maxs: [300, 300, 128] },
    },
  };

  it('mapTriggerZones: trigger_multiple/trigger_once brushes only; stage1 yields to an explicit start', () => {
    const { map } = buildMap(TRIGGERS);
    const zones = mapTriggerZones(map);
    const key = (q: ZoneDef) => `${q.type}:${q.group}:${q.index}`;
    // startbonus_trigger (the main start box again) is dropped
    expect(zones.map(key).sort()).toEqual(['checkpoint:0:1', 'checkpoint:0:2', 'end:0:0', 'end:1:0', 'start:0:0', 'start:1:0'].sort());
    expect(zones.find((q) => q.type === 'start' && q.group === 0)?.mins).toEqual(v3(-200, -200, 0));
  });

  it("no preset: the map's triggers are the zones (source 'map')", async () => {
    const { map } = buildMap(TRIGGERS);
    const r = await resolveZones(map);
    expect(r.source).toBe('map');
    expect(describeZones(r.zones)).toBe('start, end, CP 1-2, bonus 1');
    expect(r.report.parts[0]).toMatch(/^map timer triggers/);
  });

  it('a preset without end/checkpoints/bonuses is completed from the map triggers (surf_aircontrol_ksf, surf_ing)', async () => {
    const { map } = buildMap(TRIGGERS);
    setZonesFile({ maps: { surf_triggers: [pz('start', 0, 0, [-180, -180, 0], [180, 180, 100]), pz('teletostart', 0, 0, [9000, 0, 0], [9100, 100, 100])] }, aliases: {} });
    const r = await resolveZones(map);
    expect(r.source).toBe('preset');
    // the preset's start stays; end + CPs from the map; bonus 1 (bonus1start/end; the startbonus_trigger copy of the main start is skipped)
    expect(r.zones.filter((q) => q.type === 'start' && q.group === 0)[0].mins).toEqual(v3(-180, -180, 0));
    expect(describeZones(r.zones)).toBe('start, end, CP 1-2, teletostart, bonus 1');
    expect(r.zones.filter((q) => q.group === 1 && q.type === 'start')).toHaveLength(1);
    expect(r.report.parts).toEqual(['SurfTimer preset', 'map timer triggers (end, CP 1-2, bonus 1)']);
  });

  it('fillMissingZones skips a map course whose start is the same space as an existing start', () => {
    const base = [z('start', [-200, -200, 0], [200, 200, 128])];
    const extra = [z('start', [-205, -200, 0], [200, 210, 100], { group: 1 }), z('end', [5000, 0, 0], [5100, 100, 100], { group: 1 })];
    expect(sameZoneBox(base[0], extra[0])).toBe(true);
    expect(fillMissingZones(base, extra).added).toEqual([]);
    // only the copy is dropped when the course has a start of its own
    const own = [...extra, z('start', [3000, 3000, 0], [3200, 3200, 100], { group: 1, index: 1 })];
    expect(fillMissingZones(base, own).added.map((q) => `${q.type}:${q.index}`)).toEqual(['end:0', 'start:1']);
    expect(fillMissingZones(base, [z('end', [5000, 0, 0], [5100, 100, 100])]).added).toHaveLength(1);
    // a course that has stages gets no checkpoints added
    const staged = [...base, z('stage', [1000, 0, 0], [1100, 100, 100], { index: 2 }), z('end', [9, 9, 9], [10, 10, 10])];
    expect(fillMissingZones(staged, [z('checkpoint', [3000, 0, 0], [3100, 100, 100], { index: 1 })]).added).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------ timer

interface World {
  host: MockHost;
  ents: EntitySystem;
  timer: SurfTimer;
  tick(n?: number): void;
  at(x: number, ticks?: number, y?: number, zz?: number): void;
}

function world(zones: ZoneDef[], entities = '', name = 'surf_fix', extraWorld: MapSpec['world'] = [], models?: MapSpec['models']): World {
  const host = new MockHost({ name, world: [FLOOR, ...(extraWorld ?? [])], entities, models }, v3(0, 0, 0));
  const ents = new EntitySystem(host);
  host.entities = ents;
  ents.spawn();
  const timer = new SurfTimer(host);
  host.onKill = () => timer.onPlayerKilled();
  timer.setZones(zones, 'preset');
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      host.advance();
      ents.tick();
      timer.tick();
    }
  };
  const at = (x: number, ticks = 1, y = 0, zz = 0): void => {
    host.setPos(x, y, zz);
    tick(ticks);
  };
  return { host, ents, timer, tick, at };
}

function zx(type: ZoneDef['type'], x0: number, x1: number, extra: Partial<ZoneDef> = {}): ZoneDef {
  return { type, group: 0, index: 0, mins: v3(x0, -200, 0), maxs: v3(x1, 200, 128), ...extra };
}

const LINEAR: ZoneDef[] = [zx('start', -200, 200, { prespeed: 350 }), zx('end', 3000, 3200)];
const STAGED: ZoneDef[] = [zx('start', -200, 200, { prespeed: 350 }), zx('stage', 1000, 1200, { index: 2 }), zx('stage', 2000, 2200, { index: 3 }), zx('end', 3000, 3200)];

describe('practice mode never sticks in the start zone', () => {
  it('noclip back into the start zone, noclip off: start zone (clock 0), the next run is ranked and saved', () => {
    const w = world(LINEAR);
    w.at(0);
    w.at(400); // run starts
    expect(w.timer.getHud().state).toBe('running');
    // noclip (Game.setNoclip: movetype + enterPractice)
    w.host.player.moveType = MOVETYPE_NOCLIP;
    w.timer.enterPractice('noclip');
    expect(w.timer.getHud().state).toBe('practice');
    w.at(0, 20); // fly back into the start zone while noclipping: nothing happens yet
    expect(w.timer.getHud().state).toBe('practice');
    w.host.player.moveType = MOVETYPE_WALK; // noclip off inside the zone
    w.tick(150);
    expect(w.timer.getHud()).toMatchObject({ state: 'startzone', time: 0 });
    expect(w.timer.inPractice).toBe(false);
    w.at(400);
    expect(w.timer.getHud().state).toBe('running');
    w.at(1000, 100);
    w.at(3100);
    expect(w.timer.getHud().state).toBe('finished');
    expect(w.host.chatText().some((l) => l.includes('practice — not saved'))).toBe(false);
    expect(getRecords('surf_fix', 0, 100)).toHaveLength(1);
  });

  it('a saveloc teleport into the start zone while standing in it clears practice; !prac stays explicit', () => {
    const w = world(LINEAR);
    w.at(0);
    expect(w.timer.getHud().state).toBe('startzone');
    w.timer.enterPractice('saveloc'); // teleportToSaveloc: practice first, then the teleport (inside the zone)
    w.host.teleportPlayer(v3(50, 0, 0), null, v3());
    w.tick();
    expect(w.timer.inPractice).toBe(false);
    w.at(400);
    expect(w.timer.getHud().state).toBe('running');
    // !prac typed in the start zone keeps practice: the run that follows is a practice run
    w.timer.restart();
    w.tick();
    w.timer.enterPractice('!prac');
    w.at(0, 10);
    expect(w.timer.inPractice).toBe(true);
    w.at(400);
    expect(w.timer.getHud().state).toBe('practice');
  });
});

describe('!s N stage practice (SurfTimer stage times)', () => {
  it('clock at 0 in the stage zone, timed from leaving it to the next stage; stage bests kept', () => {
    const w = world(STAGED, `{ "classname" "info_teleport_destination" "targetname" "s2" "origin" "1100 0 0" "angles" "0 0 0" }`);
    w.timer.gotoStage(2);
    expect(w.host.player.origin).toEqual(v3(1100, 0, 0));
    w.tick(50);
    expect(w.timer.getHud()).toMatchObject({ state: 'practice', stage: 2, time: 0, stageTime: 0 });
    w.at(1500); // leave stage 2's zone: the stage clock starts
    w.at(1600, 99);
    expect(w.timer.getHud().time).toBeCloseTo(0.99, 9);
    w.at(2100); // stage 3 reached
    expect(w.host.chatText().at(-1)).toBe('[Surf] Player finished Stage 2 in 00:01.000 (first time)');
    expect(getStageBest('surf_fix', 0, 2, 100)?.time).toBeCloseTo(1, 9);
    expect(w.timer.getHud()).toMatchObject({ state: 'practice', stage: 3, time: 0 });
    // back to stage 2, faster this time
    w.timer.restartStage(); // !back during stage 3 practice restarts stage 3
    expect(w.timer.getHud()).toMatchObject({ stage: 3, time: 0 });
    w.timer.gotoStage(2);
    w.at(1500);
    w.at(1600, 49);
    w.at(2100);
    expect(w.host.chatText().at(-1)).toBe('[Surf] Player finished Stage 2 in 00:00.500 (PB -0.500)');
    expect(getStageBest('surf_fix', 0, 2, 100)?.time).toBeCloseTo(0.5, 9);
    // last stage -> end zone completes stage 3
    w.at(2500);
    w.at(2600, 199);
    w.at(3100);
    expect(w.host.chatText().at(-1)).toBe('[Surf] Player finished Stage 3 in 00:02.000 (first time)');
    expect(w.timer.getHud()).toMatchObject({ state: 'finished', time: 2 });
    expect(getRecords('surf_fix', 0, 100)).toHaveLength(0); // no map record from practice
  });

  it('ranked runs store stage bests too; saveloc/noclip ends stage practice', () => {
    const w = world(STAGED);
    w.at(0);
    w.at(300);
    w.at(500, 99);
    w.at(1100);
    w.at(1300); // leave stage 2 zone
    w.at(1500, 149);
    w.at(2100);
    w.at(2300);
    w.at(2500, 49);
    w.at(3100);
    expect(w.timer.getHud().state).toBe('finished');
    expect(getStageBest('surf_fix', 0, 1, 100)?.time).toBeCloseTo(1, 9);
    expect(getStageBest('surf_fix', 0, 2, 100)?.time).toBeCloseTo(1.5, 9);
    expect(getStageBest('surf_fix', 0, 3, 100)?.time).toBeCloseTo(0.5, 9);
    w.timer.gotoStage(2);
    w.timer.enterPractice('saveloc');
    w.at(1500, 10);
    expect(w.timer.getHud().time).toBeCloseTo(0.1, 9);
    w.at(2100);
    expect(w.host.chatText().at(-1)).not.toMatch(/^\[Surf\] Stage 2 \|/);
  });

  it('!stop stops a run; nothing to stop in the start zone', () => {
    const w = world(LINEAR);
    w.at(0);
    expect(w.timer.stopTimer()).toBe(false);
    w.at(400, 10);
    expect(w.timer.stopTimer()).toBe(true);
    expect(w.timer.getHud().state).toBe('stopped');
    w.at(3100);
    expect(w.timer.getHud().state).toBe('stopped');
  });
});

describe('spawn selection', () => {
  const ZONE = z('stage', [-500, -500, 0], [500, 500, 100], { index: 2 });
  const zones = [z('start', [-9000, -100, 0], [-8800, 100, 100]), ZONE, z('end', [9000, 0, 0], [9100, 100, 100])];

  it('the most-referenced map destination wins; landmark-only entities are ignored; destinations up to 512 above count', () => {
    const w = world(
      zones,
      `
      { "classname" "info_teleport_destination" "targetname" "nook" "origin" "400 400 0" "angles" "0 0 0" }
      { "classname" "info_teleport_destination" "targetname" "real" "origin" "-300 0 224" "angles" "0 180 0" }
      { "classname" "trigger_teleport" "model" "*1" "target" "nook" "landmark" "lm" }
      { "classname" "trigger_teleport" "model" "*2" "target" "x" "landmark" "nook" }
      { "classname" "trigger_teleport" "model" "*3" "target" "real" }
      { "classname" "trigger_teleport" "model" "*4" "target" "real" }`,
      'surf_fix',
      [],
      { 1: { mins: [5000, 5000, 0], maxs: [5100, 5100, 100] }, 2: { mins: [6000, 5000, 0], maxs: [6100, 5100, 100] }, 3: { mins: [5000, 6000, -2000], maxs: [5100, 6100, -1900] }, 4: { mins: [5000, 7000, -2000], maxs: [5100, 7100, -1900] } },
    );
    const sp = w.timer.getStageSpawn(0, 2)!;
    expect(sp.origin.x).toBe(-300);
    expect(sp.origin.y).toBe(0);
    expect(sp.origin.z).toBeCloseTo(0.03125, 3); // dropped onto the zone's floor
    expect(sp.angles.yaw).toBe(180);
  });

  it('a destination inside a teleport (a relay booth) hands over to where that teleport sends the player; out-of-zone destinations are clamped in', () => {
    const w = world(
      zones,
      `
      { "classname" "info_teleport_destination" "targetname" "booth" "origin" "0 0 0" "angles" "0 0 0" }
      { "classname" "info_teleport_destination" "targetname" "booth_L" "origin" "-200 300 0" "angles" "0 225 0" }
      { "classname" "trigger_teleport" "model" "*1" "target" "booth_L" "filtername" "f" }
      { "classname" "trigger_teleport" "model" "*2" "target" "booth" }
      { "classname" "info_teleport_destination" "targetname" "outside" "origin" "-9000 300 0" "angles" "0 90 0" }`,
      'surf_fix',
      [],
      { 1: { mins: [-32, -32, 0], maxs: [32, 32, 100] }, 2: { mins: [5000, 5000, -2000], maxs: [5100, 5100, -1900] } },
    );
    const sp = w.timer.getStageSpawn(0, 2)!;
    expect([sp.origin.x, sp.origin.y, sp.angles.yaw]).toEqual([-200, 300, 225]);
    const st = w.timer.getStartSpawn(0);
    expect([st.origin.x, st.origin.y, st.angles.yaw]).toEqual([-9000 + 17, 100 - 17, 90]); // clamped into the start zone
  });

  it('CS spawn rows: the yaw comes from a nearby destination, else the open exit when the spawn faces a wall', () => {
    const wall = { mins: [-500, -700, 0] as V3, maxs: [500, -600, 200] as V3, solid: true };
    const w = world(
      [z('start', [-200, -200, 0], [200, 200, 100])],
      `{ "classname" "info_player_counterterrorist" "origin" "0 0 0" "angles" "0 270 0" }`,
      'surf_fix',
      [wall],
    );
    // facing the wall 600 units away... still open enough: kept
    expect(w.timer.getStartSpawn(0).angles.yaw).toBe(270);
    const near = { mins: [-500, -300, 0] as V3, maxs: [500, -250, 200] as V3, solid: true };
    const w2 = world([z('start', [-200, -200, 0], [200, 200, 100])], `{ "classname" "info_player_counterterrorist" "origin" "0 0 0" "angles" "0 270 0" }`, 'surf_fix', [near]);
    expect(w2.timer.getStartSpawn(0).angles.yaw).not.toBe(270);
    const w3 = world(
      [z('start', [-200, -200, 0], [200, 200, 100])],
      `{ "classname" "info_player_counterterrorist" "origin" "0 0 0" "angles" "0 270 0" }
       { "classname" "info_teleport_destination" "targetname" "d" "origin" "0 900 0" "angles" "0 45 0" }`,
      'surf_fix',
      [near],
    );
    expect(w3.timer.getStartSpawn(0).angles.yaw).toBe(45);
  });

  it('openExitYaw picks the open side of a walled platform', () => {
    const { collision } = buildMap({
      world: [
        FLOOR,
        { mins: [-300, -300, 0], maxs: [5000, -280, 200], solid: true },
        { mins: [-300, 280, 0], maxs: [5000, 300, 200], solid: true },
        { mins: [-300, -300, 0], maxs: [-280, 300, 200], solid: true },
      ],
    });
    // walled on -y, +y, -x: open towards +x (yaw 0); the spawn faced the -x wall
    expect(openExitYaw(collision, v3(0, 0, 0), 180)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------ records / replays per tickrate

function rec(time: number, tickrate: number, extra: Partial<RunRecord> = {}): RunRecord {
  return { map: 'surf_tick', group: 0, time, stageSplits: [], checkpointSplits: [], jumps: 0, strafes: 0, sync: 0, tickrate, date: 1000 + time, avgSpeed: 0, maxSpeed: 0, ...extra };
}

describe('records and PB replays are per tickrate (CS:GO leaderboards are per server tick)', () => {
  it('runs of different tickrates never compete', () => {
    expect(tickLabel(85.333)).toBe('85.3');
    expect(tickLabel(102.4)).toBe('102.4');
    expect(courseKey('SURF_Tick', 1, 128)).toBe('surf_tick|1|128');
    expect(addRecord(rec(50, 64)).isPb).toBe(true);
    const r128 = addRecord(rec(40, 128));
    expect(r128).toMatchObject({ isPb: true, rank: 1, total: 1, previousPb: null });
    expect(addRecord(rec(45, 64))).toMatchObject({ isPb: true, rank: 1, total: 2 });
    expect(getPersonalBest('surf_tick', 0, 64)?.time).toBe(45);
    expect(getPersonalBest('surf_tick', 0, 128)?.time).toBe(40);
    expect(getRecords('surf_tick', 0, 100)).toEqual([]);
    expect(getCompletions('surf_tick', 0, 64)).toBe(2);
    clearRecords('surf_tick', 0, 128);
    expect(getRecords('surf_tick', 0, 128)).toEqual([]);
    expect(getRecords('surf_tick', 0, 64)).toHaveLength(2);
    clearRecords('surf_tick', 0);
    expect(getRecords('surf_tick', 0, 64)).toEqual([]);
  });

  it('older files keyed map|group are split by each run tickrate; export/import keep the ticks and stage bests', () => {
    const store = new MemStore();
    store.setItem(
      RECORDS_STORAGE_KEY,
      JSON.stringify({ version: 1, courses: { 'surf_tick|0': { runs: [rec(30, 64), rec(20, 128), rec(25, 64), rec(10, 0)], completions: 9 } } }),
    );
    setRecordsStorage(store);
    expect(getRecords('surf_tick', 0, 64).map((r) => r.time)).toEqual([25, 30]);
    expect(getRecords('surf_tick', 0, 128).map((r) => r.time)).toEqual([20]);
    expect(getRecords('surf_tick', 0, 100).map((r) => r.time)).toEqual([10]); // unknown tick: the default 100
    expect(getCompletions('surf_tick', 0, 64)).toBe(7); // the extra completions go to the main tick
    const json = exportRecords('surf_tick');
    setRecordsStorage(new MemStore());
    expect(importRecords(json)).toBe(4);
    expect(getRecords('surf_tick', 0, 128).map((r) => r.time)).toEqual([20]);
  });

  it("the timer's PB, splits and !pb follow the simulation tickrate", () => {
    const w = world(LINEAR, '', 'surf_tick');
    w.host.tickInterval = 1 / 64;
    w.at(0);
    w.at(400);
    w.at(1000, 63);
    w.at(3100);
    expect(getRecords('surf_tick', 0, 64)).toHaveLength(1);
    expect(w.timer.getRecords(0)).toHaveLength(1);
    expect(w.timer.getHud().pb).toBeCloseTo(1, 6);
    w.host.tickInterval = 1 / 128; // another server: no PB there
    w.timer.restart();
    expect(w.timer.getRecords(0)).toHaveLength(0);
    expect(w.timer.getHud().pb).toBeNull();
  });

  it('PB replays are filed per tickrate; the ghost of a 128-tick PB is not shown at 64 tick', async () => {
    const r = new ReplaySystem('surf_tick');
    r.tickInterval = 1 / 128;
    r.beginRecording(0);
    for (let i = 0; i < 129; i++) r.recordTick(v3(i, 0, 0), { pitch: 0, yaw: 0, roll: 0 }, false, 0);
    await r.endRecording(true, 1);
    expect(r.getPb(0)?.frames.length).toBe(129 * FRAME_STRIDE);
    expect(r.ghostAt(0.5)).not.toBeNull();
    r.tickInterval = 1 / 64;
    expect(r.getPb(0)).toBeNull();
    expect(r.ghostAt(0.5)).toBeNull();
    expect(r.spectate(0)).toBe(false);
    expect(r.getPb(0, 128)).not.toBeNull();
    expect(replayKey('Surf_Tick', 0, 128)).toBe('surf_tick|0|128');
    expect(replayKey('surf_tick', 0)).toBe('surf_tick|0');
  });
});

// ------------------------------------------------------------------------------------------ entities

describe('entities', () => {
  it('logic_auto fires OnMultiNewRound at spawn (CS:GO round start)', () => {
    const host = new MockHost({
      world: [FLOOR],
      entities: `
        { "classname" "trigger_teleport" "targetname" "gate" "model" "*1" "target" "x" "spawnflags" "1" }
        { "classname" "logic_auto" "OnMultiNewRound" "gate,Disable,,0,-1" }`,
      models: { 1: { mins: [-100, -100, 0], maxs: [100, 100, 100] } },
    });
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    host.advance();
    ents.tick();
    expect(ents.debugTriggers()[0].enabled).toBe(false);
  });

  it('trigger_hurt deals damage * 0.5 every half second: damage 100 kills on the second hit', () => {
    const host = new MockHost(
      {
        world: [FLOOR],
        entities: `{ "classname" "trigger_hurt" "model" "*1" "damage" "100" "spawnflags" "1" }`,
        models: { 1: { mins: [-100, -100, 0], maxs: [100, 100, 100] } },
      },
      v3(0, 0, 0),
    );
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    host.advance();
    ents.tick();
    expect(host.kills).toHaveLength(0);
    expect(ents.playerHealth).toBe(50);
    for (let i = 0; i < 49; i++) {
      host.advance();
      ents.tick();
    }
    expect(host.kills).toHaveLength(0);
    host.advance();
    ents.tick();
    expect(host.kills).toHaveLength(1);
  });
});
