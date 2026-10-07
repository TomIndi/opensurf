import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { EntitySystem } from '../src/game/entities';
import { setRecordsStorage } from '../src/game/records';
import { SurfTimer } from '../src/game/timer';
import { ZoneEditor, decodeZones, encodeZones, getEditorDebugBoxes, installZoneEditor, showZonesHelp } from '../src/game/zoneeditor';
import { heuristicZones, momentumZones, resolveZones, sanitizeZones, validateZones, zonePlausible } from '../src/game/zoneresolve';
import { ZoneDef } from '../src/map/types';
import { loadUserZones, saveUserZones, setZonesFile } from '../src/maps/zones';
import { MockHost, buildMap } from './gameworld_host';

class FakeLocalStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

const g = globalThis as { localStorage?: unknown };
const fakeLs = new FakeLocalStorage();
let hadLs = false;
let prevLs: unknown;
beforeAll(() => {
  hadLs = 'localStorage' in g;
  prevLs = g.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: fakeLs, configurable: true, writable: true });
});
afterAll(() => {
  if (hadLs) Object.defineProperty(globalThis, 'localStorage', { value: prevLs, configurable: true, writable: true });
  else delete g.localStorage;
});
beforeEach(() => {
  fakeLs.clear();
  setZonesFile(null);
  setRecordsStorage(null);
});

const FLOOR = { mins: [-20000, -20000, -64] as [number, number, number], maxs: [20000, 20000, 0] as [number, number, number], solid: true };
const SPAWNS = `
  { "classname" "info_player_counterterrorist" "origin" "0 0 0" "angles" "0 90 0" }
  { "classname" "info_player_counterterrorist" "origin" "64 0 0" }
  { "classname" "info_player_terrorist" "origin" "128 64 0" }
  { "classname" "info_player_terrorist" "origin" "9000 9000 0" }`;

function z(type: ZoneDef['type'], mins: [number, number, number], maxs: [number, number, number], extra: Partial<ZoneDef> = {}): ZoneDef {
  return { type, group: 0, index: 0, mins: v3(...mins), maxs: v3(...maxs), ...extra };
}

describe('sanitizeZones', () => {
  it('drops broken boxes, unknown types; normalizes order', () => {
    const out = sanitizeZones([
      z('start', [0, 0, 0], [0, 0, 0]), // all-zero placeholder
      z('end', [10, 10, 10], [0, 0, 0]), // inverted -> normalized
      z('stage', [0, 0, 0], [NaN, 1, 1], { index: 2 }),
      { ...z('start', [0, 0, 0], [1, 1, 1]), type: 'bogus' as ZoneDef['type'] },
      z('checkpoint', [0, 0, 0], [50000, 1, 1]), // larger than a map
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'end', mins: v3(0, 0, 0), maxs: v3(10, 10, 10) });
  });
});

describe('zone plausibility', () => {
  const { map } = buildMap({ world: [FLOOR], entities: `${SPAWNS}
    { "classname" "info_teleport_destination" "origin" "-5000 -5000 40" }` });

  it('accepts a start near a spawn, around a teleport destination, or with a floor under it', () => {
    expect(zonePlausible(map, z('start', [-100, -100, 0], [100, 100, 100]))).toBe(true);
    expect(zonePlausible(map, z('start', [-5100, -5100, 0], [-4900, -4900, 100]))).toBe(true);
    expect(zonePlausible(map, z('start', [12000, -12000, 0], [12200, -11800, 100]))).toBe(true);
  });

  it('rejects zones floating in the void or buried in solid', () => {
    expect(zonePlausible(map, z('start', [12000, -12000, 5000], [12200, -11800, 5100]))).toBe(false);
    expect(zonePlausible(map, z('start', [12000, -12000, -60], [12200, -11800, -10]))).toBe(false);
  });

  it('validateZones: presets need a plausible main-course start', () => {
    const good = [z('start', [-100, -100, 0], [100, 100, 100]), z('end', [0, 0, 0], [0, 0, 0])];
    expect(validateZones(map, good, true)).toHaveLength(1);
    const bonusOnly = [z('start', [-100, -100, 0], [100, 100, 100], { group: 1 })];
    expect(validateZones(map, bonusOnly, true)).toBeNull();
    expect(validateZones(map, bonusOnly, false)).toHaveLength(1);
    expect(validateZones(map, [z('end', [-100, -100, 0], [100, 100, 100])], false)).toBeNull();
    expect(validateZones(map, null, false)).toBeNull();
  });
});

describe('heuristicZones', () => {
  it('boxes the largest spawn cluster', () => {
    const { map } = buildMap({ world: [FLOOR], entities: SPAWNS });
    const h = heuristicZones(map);
    expect(h).toEqual([{ type: 'start', group: 0, index: 0, mins: v3(-96, -96, -16), maxs: v3(224, 160, 128) }]);
    expect(heuristicZones(buildMap({ world: [FLOOR] }).map)).toEqual([]);
  });
});

describe('momentumZones', () => {
  it('converts Momentum timer triggers when the loader left map.zones empty', async () => {
    const { map } = buildMap({
      name: 'surf_mom',
      world: [FLOOR],
      entities: `${SPAWNS}
        { "classname" "trigger_momentum_timer_start" "model" "*1" }
        { "classname" "trigger_momentum_timer_stage" "model" "*2" "stage" "2" }
        { "classname" "trigger_momentum_timer_stage" "model" "*3" "stage" "1" }
        { "classname" "trigger_momentum_timer_stop" "model" "*4" }`,
      models: {
        1: { mins: [-100, -100, 0], maxs: [100, 100, 100] },
        2: { mins: [1000, -100, 0], maxs: [1100, 100, 100] },
        3: { mins: [2000, -100, 0], maxs: [2100, 100, 100] },
        4: { mins: [3000, -100, 0], maxs: [3100, 100, 100] },
      },
    });
    const zones = momentumZones(map);
    expect(zones.map((q) => `${q.type}${q.index}`)).toEqual(['start0', 'stage2', 'end0']);
    expect(await resolveZones(map)).toMatchObject({ source: 'momentum' });
  });
});

describe('resolveZones priority', () => {
  const presetStart = { t: 'start' as const, g: 0, i: 0, a: [-100, -100, 0] as [number, number, number], b: [100, 100, 100] as [number, number, number], p: 350 };
  const voidStart = { t: 'start' as const, g: 0, i: 0, a: [15000, 15000, 9000] as [number, number, number], b: [15100, 15100, 9100] as [number, number, number] };

  it('user > preset > map zones > heuristic > none', async () => {
    const { map } = buildMap({
      name: 'surf_prio',
      world: [FLOOR],
      entities: SPAWNS,
      zones: [z('start', [-50, -50, 0], [50, 50, 50]), z('end', [500, 500, 0], [600, 600, 50])],
      zoneSource: 'momentum',
    });
    expect(await resolveZones(map)).toMatchObject({ source: 'momentum' });
    setZonesFile({ maps: { surf_prio: [presetStart] }, aliases: {} });
    const p = await resolveZones(map);
    expect(p.source).toBe('preset');
    expect(p.zones[0].prespeed).toBe(350);
    saveUserZones('surf_prio', [z('start', [-80, -80, 0], [80, 80, 80]), z('end', [700, 0, 0], [800, 100, 100])]);
    const u = await resolveZones(map);
    expect(u.source).toBe('user');
    expect(u.zones).toHaveLength(2);
    // invalid user zones fall back
    saveUserZones('surf_prio', [z('start', [15000, 15000, 9000], [15100, 15100, 9100])]);
    expect((await resolveZones(map)).source).toBe('preset');
    map.zones = [];
    setZonesFile(null);
    saveUserZones('surf_prio', null);
    expect(await resolveZones(map)).toMatchObject({ source: 'heuristic' });
    const empty = buildMap({ name: 'surf_none', world: [FLOOR] }).map;
    expect(await resolveZones(empty)).toMatchObject({ zones: [], source: 'none' });
  });

  it('tries other builds of the map when the exact preset does not fit', async () => {
    const { map } = buildMap({ name: 'surf_alias_b', world: [FLOOR], entities: SPAWNS });
    setZonesFile({ maps: { surf_alias_b: [voidStart], surf_alias_a: [presetStart] }, aliases: { surf_alias_b: ['surf_alias_a'] } });
    const r = await resolveZones(map);
    expect(r.source).toBe('preset');
    expect(r.zones[0].mins).toEqual(v3(-100, -100, 0));
  });
});

describe('zone editor', () => {
  function setup(): { host: MockHost; timer: SurfTimer; editor: ZoneEditor } {
    const host = new MockHost({ name: 'surf_edit', world: [FLOOR], entities: SPAWNS }, v3(0, 0, 0));
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    const timer = new SurfTimer(host);
    timer.setZones([], 'none');
    const editor = new ZoneEditor(host, timer);
    installZoneEditor(editor);
    return { host, timer, editor };
  }

  it('builds zones from two corners via console commands and applies them live', () => {
    const { host, timer } = setup();
    console_.execute('zone_add start');
    host.setPos(-100, -100, 0);
    console_.execute('zone_point');
    host.setPos(100, 120, 0);
    expect(getEditorDebugBoxes().at(-1)).toMatchObject({ mins: v3(-100, -100, 0), maxs: v3(100, 120, 128), color: [1, 1, 1] });
    console_.execute('zone_point');
    expect(timer.getZones()).toEqual([{ type: 'start', group: 0, index: 0, mins: v3(-100, -100, 0), maxs: v3(100, 120, 128) }]);
    expect(timer.zoneSource).toBe('user');
    console_.execute('zone_add stage');
    console_.execute('zone_point');
    host.setPos(300, 300, 200);
    console_.execute('zone_point');
    const st = timer.getZones()[1];
    expect(st).toMatchObject({ type: 'stage', index: 2, mins: v3(100, 120, 0), maxs: v3(300, 300, 200) });
    console_.execute('zone_add checkpoint 4 1');
    expect(getEditorDebugBoxes()).toHaveLength(3); // two zones + the feet marker
    console_.execute('zone_list');
    expect(host.prints.some((p) => p.includes('#1 stage 2'))).toBe(true);
    console_.execute('zone_delete 1');
    expect(timer.getZones()).toHaveLength(1);
    expect(loadUserZones('surf_edit')).toBeNull(); // not saved yet
    console_.execute('zone_save');
    expect(loadUserZones('surf_edit')).toHaveLength(1);
    console_.execute('zone_edit');
    expect(getEditorDebugBoxes()).toEqual([]);
  });

  it('zone_setspawn / zone_prespeed', () => {
    const { host, timer, editor } = setup();
    timer.setZones([z('start', [-100, -100, 0], [100, 100, 100])], 'preset');
    host.setPos(10, 20, 0);
    host.player.viewAngles.yaw = 135;
    console_.execute('zone_setspawn');
    expect(timer.getZones()[0].spawn).toEqual({ origin: v3(10, 20, 0), angles: { pitch: 0, yaw: 135, roll: 0 } });
    expect(timer.getStartSpawn(0).angles.yaw).toBe(135);
    console_.execute('zone_prespeed 0 500');
    expect(timer.getZones()[0].prespeed).toBe(500);
    host.setPos(5000, 5000, 0);
    expect(editor.setSpawn()).toBe(false);
    expect(editor.setPrespeed(3, 100)).toBe(false);
  });

  it('rejects bad input', () => {
    const { host, editor } = setup();
    expect(editor.add(['nonsense'])).toBe(false);
    expect(editor.add(['stage', '1'])).toBe(false);
    expect(editor.point()).toBeNull();
    expect(host.prints.at(-1)).toContain('zone_add');
    editor.add(['end']);
    editor.point();
    expect(editor.point()).toBeNull(); // same spot: too thin
    expect(editor.remove(5)).toBe(false);
  });

  it('export / import round trip, also with quotes stripped by the console tokenizer', () => {
    const { timer, editor } = setup();
    const zones = [z('start', [-100, -100, 0], [100, 100, 100], { prespeed: 400 }), z('end', [1000, 0, 0], [1100, 100, 100], { group: 1 })];
    timer.setZones(zones, 'preset');
    const code = editor.exportZones();
    expect(code.startsWith('surfzones:')).toBe(true);
    expect(code).not.toMatch(/[\s";]|\/\//);
    expect(decodeZones(code)).toEqual(sanitizeZones(zones));
    expect(encodeZones(decodeZones(code))).toBe(code);
    const stripped = '[{type:start,group:0,index:0,mins:[-1,-2,0],maxs:[5,6,7]}]';
    expect(decodeZones(stripped)).toEqual([z('start', [-1, -2, 0], [5, 6, 7])]);
    console_.execute(`zone_import ${code}`);
    expect(loadUserZones('surf_edit')).toHaveLength(2);
    expect(timer.getZones()[0].prespeed).toBe(400);
    expect(editor.importZones('garbage')).toBe(false);
  });

  it('zone_reset deletes user zones and re-resolves', async () => {
    const { timer, editor } = setup();
    saveUserZones('surf_edit', [z('start', [-80, -80, 0], [80, 80, 80])]);
    await editor.reset();
    expect(loadUserZones('surf_edit')).toBeNull();
    expect(timer.zoneSource).toBe('heuristic');
  });

  it('!zones help goes to chat', () => {
    const lines: string[] = [];
    showZonesHelp((segs) => lines.push(segs.map((s) => s.text).join('')));
    expect(lines[0]).toContain('Zone editor');
    expect(lines.some((l) => l.startsWith('zone_add'))).toBe(true);
  });
});
