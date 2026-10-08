// KSF world records in the game, with an injected fake KSF client (no network): the WR line on map load, the HUD,
// !wr (and that !top / !wrcp / !wrb keep their behaviour), !wrreplay / !ksfreplay / !replay wr, !wrghost, the
// finish line vs the WR, board choice by tickrate, and the graceful "needs the local server" degradation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_, cvar } from '../src/core/cvars';
import { registerConvars } from '../src/game/convars';
import type { LoadedMap } from '../src/map/types';
import { type KsfBoard, type KsfClient, type KsfRecord, KsfService, KsfUnavailableError } from '../src/maps/ksf';
import { buildKsfReplay, KSF_ZONE_END, KSF_ZONE_START, type SyntheticKsfFrame } from '../src/maps/ksfreplay';
import { IN_DUCK, IN_FORWARD, IN_MOVERIGHT } from '../src/physics/playertypes';
import { loadedGame, makeGame, makeTestMap, resetGlobals, type TestGame } from './gamecore_helpers';

class FakeKsf implements KsfClient {
  calls: string[] = [];
  lists = new Map<string, KsfRecord[]>();
  files = new Map<string, Uint8Array>();
  unavailable = false;
  async fetchRecords(map: string, board: KsfBoard): Promise<KsfRecord[]> {
    this.calls.push(`records ${map} ${board}`);
    if (this.unavailable) throw new KsfUnavailableError();
    return this.lists.get(`${map}|${board}`) ?? [];
  }
  async fetchReplay(file: string, board: KsfBoard): Promise<ArrayBuffer> {
    this.calls.push(`replay ${file} ${board}`);
    if (this.unavailable) throw new KsfUnavailableError();
    const f = this.files.get(file);
    if (!f) throw new Error('no such replay');
    return f.slice().buffer;
  }
}

const MAP = 'surf_ksftest';
const FILE100 = 'replay_css100t_77_0_1_1700000000.rec';
const FILE66 = 'replay_css_77_0_2_1700000000.rec';

function rec(rank: number, time: number, name: string, file: string | null = null): KsfRecord {
  return { rank, name, steamId: `STEAM_0:0:${rank}`, country: 'Testland', time, completions: 3, date: 1700000000 + rank, recordId: rank, file };
}

/** A replay along +x from the test map's spawn: 50 prestrafe frames, a 300-frame run, at tick interval `ti`. */
function replayFile(ti: number): Uint8Array {
  const frames: SyntheticKsfFrame[] = [];
  for (let k = 0; k < 50; k++) frames.push({ buttons: 0, origin: [0, 0, 0], angles: [0, 0, 0], velocity: [0, 0, 0] });
  for (let k = 0; k <= 300; k++) {
    frames.push({ buttons: IN_FORWARD | IN_MOVERIGHT | (k > 100 ? IN_DUCK : 0), origin: [k * 400 * ti, 0, 0], angles: [5, 0, 0], velocity: [400, 0, 0] });
  }
  return buildKsfReplay(frames, [
    { frame: 50, type: KSF_ZONE_START, index: 1 },
    { frame: 350, type: KSF_ZONE_END, index: 99 },
  ]);
}

function fakeWithRecords(): FakeKsf {
  const f = new FakeKsf();
  f.lists.set(`${MAP}|100t`, [
    rec(1, 3.00412, 'tester', FILE100),
    rec(2, 3.1, 'second', null),
    rec(3, 3.2, 'third'),
    rec(4, 3.3, 'fourth'),
    rec(5, 3.4, 'fifth'),
    rec(6, 3.5, 'sixth'),
    rec(7, 3.6, 'seventh'),
  ]);
  f.lists.set(`${MAP}|66t`, [rec(1, 4.5, 'sixtysix', FILE66)]);
  f.files.set(FILE100, replayFile(0.01));
  f.files.set(FILE66, replayFile(0.015));
  return f;
}

/** A non-built-in map (as if dropped / loaded from a URL) named like a KSF map. */
function ksfMap(): LoadedMap {
  return { ...makeTestMap({ name: MAP }), source: 'bsp' };
}

async function urlGame(fake: FakeKsf): Promise<TestGame> {
  const map = ksfMap();
  const t = makeGame(map, {
    fetchUrl: async () => new ArrayBuffer(8),
    extractArchive: async () => ({ name: MAP, bsp: new ArrayBuffer(8) }),
    loadBsp: async () => map,
  });
  // the injected KSF service (Game deps are read at construction: swap it in like a test double)
  (t.game as unknown as { ksf: KsfService }).ksf = new KsfService(fake);
  await t.game.loadMapUrl(`/__maps/${MAP}.bsp`);
  await flush();
  return t;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

let t: TestGame;
const texts = () => t.ui.texts();
const tail = (n: number) => texts().slice(-n).join('\n');

beforeEach(() => {
  registerConvars();
  resetGlobals();
});
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
  t?.game.disconnect();
});

describe('KSF world records in game', () => {
  it('announces the WR on map load and shows it in the HUD', async () => {
    const fake = fakeWithRecords();
    t = await urlGame(fake);
    expect(texts()).toContain('[Surf] KSF WR 00:03.004 by tester (100 tick) - type !wrreplay to watch');
    expect(fake.calls).toEqual([`records ${MAP} 100t`]);
    expect(t.game.getHud().ksfWr).toEqual({ time: 3.00412, name: 'tester', board: '100 tick' });
  });

  it('!wr: WR, top 5 and the hint; !top / !wrcp / !wrb keep their behaviour', async () => {
    t = await urlGame(fakeWithRecords());
    t.ui.chats.length = 0;
    t.game.say('!wr');
    await flush();
    const out = texts();
    expect(out[0]).toBe('Player : !wr');
    expect(out[1]).toMatch(/^\[Surf\] KSF WR on surf_ksftest \(100 tick\): 00:03\.004 by tester on 2023-11-14 · Testland$/);
    expect(out.slice(2, 7).map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['#1 00:03.004', '#2 00:03.100', '#3 00:03.200', '#4 00:03.300', '#5 00:03.400']);
    expect(out[3]).toContain('(+0.096) second');
    expect(out.join('\n')).not.toContain('sixth');
    expect(out[7]).toContain('!wrreplay');
    expect(out[7]).toContain('ksf.surf');
    // the local commands are unchanged
    t.ui.chats.length = 0;
    t.game.say('/top');
    expect(t.ui.lastText()).toContain('No times on surf_ksftest at 100 tick yet');
    t.game.say('/wrcp');
    expect(t.ui.lastText()).toContain('is linear');
    t.game.say('/wrb');
    expect(t.ui.lastText()).toContain('This map has no bonus');
    t.game.say('/wr 1');
    expect(t.ui.lastText()).toContain('No times on surf_ksftest Bonus 1');
    // sm_ console twins exist
    expect(console_.hasCommand('sm_wr') && console_.hasCommand('sm_wrreplay') && console_.hasCommand('sm_ksfreplay') && console_.hasCommand('sm_wrghost')).toBe(true);
  });

  it('!wrreplay downloads the WR replay and spectates it with the replay HUD; again to stop', async () => {
    const fake = fakeWithRecords();
    t = await urlGame(fake);
    t.game.say('!wrreplay');
    await flush();
    expect(tail(2)).toBe('[Surf] Downloading the KSF WR replay of surf_ksftest…\n[Surf] Watching the KSF WR by tester (00:03.004, 100 tick). Jump or !r to stop.');
    expect(t.game.spectating).toBe(true);
    expect(fake.calls).toContain(`replay ${FILE100} 100t`);
    // the prestrafe first: start zone, clock at 0
    t.game.frame(1000);
    let hud = t.game.getHud();
    expect(hud.spectating).toBe('KSF WR · tester (100 tick)');
    expect(hud.timer.state).toBe('startzone');
    expect(hud.timer.time).toBe(0);
    // 0.5 s of prestrafe, then 1 s into the run: time from the run-start event, speed from the stored velocity,
    // keys from the stored buttons
    t.game.frame(2500);
    t.game.frame(2600);
    hud = t.game.getHud();
    expect(hud.timer.state).toBe('running');
    expect(hud.timer.time).toBeGreaterThan(0.9);
    expect(hud.timer.time).toBeLessThan(1.2);
    expect(hud.speed).toBeCloseTo(400, 3);
    expect(hud.keys.forward && hud.keys.right && hud.keys.duck).toBe(true);
    expect(hud.keys.left).toBe(false);
    // the end shows the record's official time
    t.game.frame(5600);
    hud = t.game.getHud();
    expect(hud.timer.time).toBeCloseTo(3.00412, 6);
    // !wrreplay again leaves (like !replay), back at the start
    t.game.say('/wrreplay');
    expect(t.game.spectating).toBe(false);
    expect(t.game.getHud().timer.state).toBe('startzone');
    // cached: no second download
    t.game.say('/ksfreplay');
    await flush();
    expect(t.game.spectating).toBe(true);
    expect(fake.calls.filter((c) => c.startsWith('replay')).length).toBe(1);
    expect(t.ui.lastText()).toContain('Watching the KSF WR');
    t.game.say('/r');
    expect(t.game.spectating).toBe(false);
    // !replay wr is the same
    t.game.say('/replay wr');
    await flush();
    expect(t.game.spectating).toBe(true);
    expect(t.game.getHud().spectating).toContain('KSF WR');
    t.game.say('/replay');
    expect(t.game.spectating).toBe(false);
    // the map browser's Watch WR (GameApi.watchKsfWr)
    t.game.watchKsfWr();
    await flush();
    expect(t.game.spectating).toBe(true);
    t.game.watchKsfWr(); // already watching: stays
    expect(t.game.spectating).toBe(true);
  });

  it('a WR without a replay file falls back to the best record with one', async () => {
    const fake = fakeWithRecords();
    fake.lists.set(`${MAP}|100t`, [rec(1, 2.9, 'noreplay', null), rec(2, 3.00412, 'tester', FILE100)]);
    t = await urlGame(fake);
    t.game.say('/wrreplay');
    await flush();
    expect(t.game.spectating).toBe(true);
    expect(tail(2)).toContain('Watching the KSF #2 by tester');
    expect(t.ui.lastText()).toContain('has no replay on ksf.surf');
  });

  it('!wrghost races the WR replay during a run (gold "KSF WR" ghost), next to the PB ghost', async () => {
    t = await urlGame(fakeWithRecords());
    t.game.say('/wrghost');
    await flush();
    expect(cvar('surf_ghost_wr').num).toBe(1);
    expect(t.ui.lastText()).toContain('KSF WR ghost enabled: tester (00:03.004, 100 tick) races you from the start zone.');
    // start a run: the ghost shows with the run clock
    t.game.executeCommand('+forward');
    t.game.runTicks(150);
    t.game.frame(1000);
    expect(t.game.getHud().timer.state).toBe('running');
    const ghosts = t.renderer.ghosts[t.renderer.ghosts.length - 1];
    const wr = ghosts.find((g) => g.id === 'ksf:wr');
    expect(wr).toBeDefined();
    expect(wr!.name).toBe('KSF WR');
    expect(wr!.origin.x).toBeGreaterThan(0);
    // !hide hides it; !wrghost again turns it off
    t.game.say('/hide');
    t.game.frame(1016);
    expect(t.renderer.ghosts[t.renderer.ghosts.length - 1]).toEqual([]);
    t.game.say('/hide');
    t.game.say('/wrghost');
    expect(cvar('surf_ghost_wr').num).toBe(0);
    expect(t.ui.lastText()).toContain('KSF WR ghost disabled');
    t.game.frame(1032);
    expect((t.renderer.ghosts[t.renderer.ghosts.length - 1] ?? []).some((g) => g.id === 'ksf:wr')).toBe(false);
    t.game.executeCommand('-forward');
  });

  it('the finish line compares the run with the KSF WR', async () => {
    t = await urlGame(fakeWithRecords());
    t.game.executeCommand('+forward');
    t.game.runTicks(800);
    t.game.executeCommand('-forward');
    const fin = texts().find((l) => l.includes(' finished surf_ksftest in '))!;
    expect(fin).toMatch(/\| Rank 1\/1 \| \+\d+\.\d{3} vs KSF WR$/);
  });

  it('the board follows the tickrate (66 tick for anything but 100), with a fallback', async () => {
    const fake = fakeWithRecords();
    t = await urlGame(fake);
    t.game.executeCommand('tickrate 64');
    await flush();
    expect(t.game.getHud().ksfWr).toEqual({ time: 4.5, name: 'sixtysix', board: '66 tick' });
    t.game.say('/wrreplay');
    await flush();
    expect(t.game.getHud().spectating).toBe('KSF WR · sixtysix (66 tick)');
    expect(fake.calls).toContain(`replay ${FILE66} 66t`);
    t.game.say('/r');
    // a map with 66 tick records only: the 100 tick board falls back
    fake.lists.delete(`${MAP}|100t`);
    const fake2 = new FakeKsf();
    fake2.lists.set(`${MAP}|66t`, [rec(1, 4.5, 'sixtysix', FILE66)]);
    t.game.disconnect();
    cvar('tickrate').set(100);
    t = await urlGame(fake2);
    expect(fake2.calls).toEqual([`records ${MAP} 100t`, `records ${MAP} 66t`]);
    expect(t.game.getHud().ksfWr?.board).toBe('66 tick');
    t.ui.chats.length = 0;
    t.game.say('/wr');
    await flush();
    expect(texts()[0]).toContain('(no 100 tick records)');
  });

  it('without the local server: no WR shown, the commands explain, !wr falls back to the local top', async () => {
    const fake = fakeWithRecords();
    fake.unavailable = true;
    t = await urlGame(fake);
    expect(texts().join('\n')).not.toContain('KSF WR');
    expect(t.game.getHud().ksfWr).toBeNull();
    t.ui.chats.length = 0;
    t.game.say('/wr');
    await flush();
    expect(texts()).toEqual(['[Surf] KSF world records need the local server (npm run dev / npm run preview)', '[Surf] No times on surf_ksftest at 100 tick yet.']);
    t.game.say('/wrreplay');
    await flush();
    expect(t.ui.lastText()).toBe('[Surf] KSF world records need the local server (npm run dev / npm run preview)');
    expect(t.game.spectating).toBe(false);
    t.game.say('/wrghost');
    await flush();
    expect(t.ui.lastText()).toContain('KSF WR ghost enabled. KSF world records need the local server');
    // asked once for the whole session
    expect(fake.calls.length).toBe(1);
  });

  it('never asks KSF about built-in maps', async () => {
    const fake = fakeWithRecords();
    t = await loadedGame();
    (t.game as unknown as { ksf: KsfService }).ksf = new KsfService(fake);
    await t.game.loadBuiltinMap('test');
    await flush();
    t.ui.chats.length = 0;
    t.game.say('/wr');
    t.game.say('/wrreplay');
    await flush();
    expect(fake.calls).toEqual([]);
    expect(texts().join('\n')).toContain('built-in maps have no world records');
    expect(t.game.getHud().ksfWr).toBeNull();
  });

  it('!help lists the KSF commands', async () => {
    t = await loadedGame();
    t.game.say('/help');
    const all = texts().join('\n');
    expect(all).toContain('!wr KSF world record');
    expect(all).toContain('!wrreplay');
    expect(all).toContain('!wrghost');
  });
});
