// UX review fixes on the game-core side: `map <typo>` keeps the current map, a failed map change brings the old
// map back, load reports carry a load id, the pause menu keeps a ranked run going (CS:GO's ESC menu), hidden tabs
// and stalls make the run practice, raw input state + fallback advice, autoexec compatibility (silent cvars,
// exec / cfg_*), r_drawzones modes, the short welcome zone line, !rank / !wrcp and near-miss suggestions, and
// the PB ghost only after leaving the start zone.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_, ConsoleLine, cvar, execute, FCVAR_ARCHIVE, FCVAR_HIDDEN } from '../src/core/cvars';
import { LoadProgress } from '../src/game/api';
import { binds } from '../src/game/binds';
import { CfgStorage, listCfgs, readCfg, setCfgStorage, writeCfg } from '../src/game/cfgstore';
import { editDistance, suggestChatCommand } from '../src/game/commands';
import { COMPAT_CVAR_DEFS, registerConvars } from '../src/game/convars';
import { Game, renderSettingsFromCvars } from '../src/game/game';
import { InputDevice, InputState, KeyDispatcher, RAW_INPUT_FALLBACK_MESSAGE } from '../src/game/input';
import { CatalogEntry, setCatalog } from '../src/maps/catalog';
import { FakeRenderer, FakeSound, FakeUi, TestGame, loadedGame, makeGame, makeTestMap, resetGlobals } from './gamecore_helpers';

/** localStorage-like store with key()/length (cfg_list enumerates it). */
class CfgStore implements CfgStorage {
  readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
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

let t: TestGame;
let cfgs: CfgStore;

beforeEach(async () => {
  registerConvars();
  resetGlobals();
  cfgs = new CfgStore();
  setCfgStorage(cfgs);
});
afterEach(() => {
  t?.game.dispose();
  for (const c of console_.allCvars()) c.reset();
  execute('binddefaults');
  setCfgStorage(null);
});

function capture(fn: () => void): string[] {
  const out: ConsoleLine[] = [];
  const off = console_.onOutput((l) => out.push(l));
  try {
    fn();
  } finally {
    off();
  }
  return out.map((l) => l.text);
}

async function captureAsync(fn: () => Promise<void>): Promise<string[]> {
  const out: ConsoleLine[] = [];
  const off = console_.onOutput((l) => out.push(l));
  try {
    await fn();
  } finally {
    off();
  }
  return out.map((l) => l.text);
}

function frames(game: Game, count: number, fps = 100, startMs = 1000): number {
  let ms = startMs;
  for (let i = 0; i < count; i++) {
    ms += 1000 / fps;
    game.frame(ms);
  }
  return ms;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Leaves the start zone with +forward: a ranked run in progress. */
function startRun(tg: TestGame): void {
  tg.game.executeCommand('+forward');
  tg.game.runTicks(100);
  tg.game.executeCommand('-forward');
  expect(tg.game.session!.timer.getHud().state).toBe('running');
}

const REMOTE: CatalogEntry = { name: 'surf_remote', driveId: 'x', tier: 3, type: 'linear', hasZones: false, featured: false };

describe('map <name> and failed map changes', () => {
  it('an unknown name is a console error: the map and the run go on, no state change, no loading screen', async () => {
    t = await loadedGame();
    const s = t.game.session!;
    startRun(t);
    const states: unknown[] = [];
    t.game.on('statechange', (st) => states.push(st));
    const loads = t.ui.loading.length;
    const out = await captureAsync(() => t.game.loadMapByName('surf_doesnotexist'));
    expect(out).toContain('map load failed: surf_doesnotexist not found');
    expect(t.game.session).toBe(s);
    expect(t.game.state).toBe('playing');
    expect(t.game.mapName).toBe('surf_gamecore_test');
    expect(states).toEqual([]);
    expect(t.ui.loading.length).toBe(loads);
    expect(s.timer.getHud().state).toBe('running');
    // the console command too (and `retry` still means the current map)
    const out2 = await captureAsync(async () => {
      execute('map surf_typo.bsp');
      await tick();
    });
    expect(out2).toContain('map load failed: surf_typo not found');
    expect(t.game.session).toBe(s);
    await t.game.retry();
    expect(t.game.mapName).toBe('surf_gamecore_test');
  });

  it('a download that fails brings the previous map back (run as practice), with the error in chat', async () => {
    setCatalog([REMOTE]);
    t = await loadedGame(makeTestMap(), {
      catalog: async () => [REMOTE],
      fetchCatalogMap: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const s = t.game.session!;
    startRun(t);
    const states: unknown[] = [];
    t.game.on('statechange', (st) => states.push(st));
    const reports: LoadProgress[] = [];
    t.game.on('loadprogress', (p) => reports.push(p as LoadProgress));
    await t.game.loadMapByName('SURF_REMOTE');
    expect(states).toEqual(['loading', 'playing']);
    expect(t.game.session).toBe(s);
    expect(t.game.mapName).toBe('surf_gamecore_test');
    expect(t.renderer.loaded).toBe(t.map); // never unloaded
    const last = reports[reports.length - 1];
    expect(last).toMatchObject({ phase: 'error', recovered: true, mapName: 'surf_remote' });
    expect(last.message).toContain('Network error');
    expect(reports.every((r) => r.loadId === last.loadId && r.mapName === 'surf_remote')).toBe(true);
    expect(t.ui.loading[t.ui.loading.length - 1]).toBeNull(); // no error screen
    expect(t.ui.texts().some((l) => l.includes("Couldn't load surf_remote"))).toBe(true);
    // the world stood still while loading: the run can't count any more
    expect(s.timer.inPractice).toBe(true);
    expect(t.ui.texts()).toContain("[Surf] Timer stopped — run paused, it won't count. Type !r to restart.");
    // and it simulates again
    const n = s.tickCount;
    frames(t.game, 20, 100, 5000);
    expect(s.tickCount).toBeGreaterThan(n + 15);
    // retry = the map being played
    await t.game.retry();
    expect(t.game.state).toBe('playing');
    expect(t.game.mapName).toBe('surf_gamecore_test');
  });

  it('a failed map change from the pause menu returns to the pause menu', async () => {
    setCatalog([REMOTE]);
    t = await loadedGame(makeTestMap(), {
      catalog: async () => [REMOTE],
      fetchCatalogMap: async () => {
        throw new Error('HTTP 404');
      },
    });
    t.game.pause();
    await t.game.loadCatalogMap('surf_remote');
    expect(t.game.state).toBe('paused');
    expect(t.ui.menus[t.ui.menus.length - 1]).toBe('pause');
  });

  it('a new map replaces the old one only once it is built; reports carry a growing load id and the map name', async () => {
    const a = makeTestMap({ name: 'surf_a' });
    const b = makeTestMap({ name: 'surf_b' });
    let release: () => void = () => undefined;
    t = makeGame(a, {
      buildBuiltin: async (id) => {
        if (id === 'b') await new Promise<void>((r) => (release = r));
        return id === 'a' ? a : b;
      },
      builtinMaps: async () => [
        { id: 'a', name: 'A', tier: 1 },
        { id: 'b', name: 'B', tier: 2 },
      ],
    });
    const reports: LoadProgress[] = [];
    t.game.on('loadprogress', (p) => reports.push(p as LoadProgress));
    await t.game.loadBuiltinMap('a');
    const first = t.game.session!;
    const idA = reports[reports.length - 1].loadId!;
    expect(reports.every((r) => r.mapName === 'surf_a' || r.mapName === 'a')).toBe(true);
    const unloads = t.renderer.unloads;
    const p = t.game.loadBuiltinMap('b');
    await tick();
    // loading: the old map is kept aside (not the current session), still in the renderer
    expect(t.game.state).toBe('loading');
    expect(t.game.session).toBeNull();
    expect(t.game.mapName).toBe('b');
    expect(t.renderer.loaded).toBe(a);
    expect(t.renderer.unloads).toBe(unloads);
    release();
    await p;
    expect(t.game.mapName).toBe('surf_b');
    expect(t.game.session).not.toBe(first);
    expect(t.renderer.loaded).toBe(b);
    const forB = reports.filter((r) => r.loadId !== idA);
    expect(forB.length).toBeGreaterThan(0);
    expect(forB.every((r) => r.loadId! > idA && r.mapName === 'b')).toBe(true);
    expect(forB[forB.length - 1]).toMatchObject({ phase: 'done' });
  });

  it('disconnect during a map change drops the kept map too', async () => {
    let release: () => void = () => undefined;
    const map = makeTestMap();
    t = makeGame(map, {
      buildBuiltin: async (id) => {
        if (id === 'slow') await new Promise<void>((r) => (release = r));
        return map;
      },
      builtinMaps: async () => [
        { id: 'test', name: 'T', tier: 1 },
        { id: 'slow', name: 'S', tier: 1 },
      ],
    });
    await t.game.loadBuiltinMap('test');
    const p = t.game.loadBuiltinMap('slow');
    await tick();
    t.game.disconnect();
    expect(t.game.state).toBe('menu');
    expect(t.renderer.loaded).toBeNull();
    release();
    await p;
    expect(t.game.state).toBe('menu');
    expect(t.game.session).toBeNull();
  });
});

describe('pause during a run (CS:GO ESC menu)', () => {
  it('in the start zone pausing freezes; mid-run the world keeps running with the keys released', async () => {
    t = await loadedGame();
    const s = t.game.session!;
    let now = frames(t.game, 1, 100, 1000);
    t.game.pause();
    expect(t.game.simulatingWhilePaused).toBe(false);
    let n = s.tickCount;
    now = frames(t.game, 20, 100, now);
    expect(s.tickCount).toBe(n);
    t.game.resume();

    t.game.executeCommand('+forward');
    t.game.runTicks(100);
    expect(s.timer.getHud().state).toBe('running');
    now = frames(t.game, 1, 100, now);
    t.game.pause();
    expect(t.game.state).toBe('paused');
    expect(t.ui.menus[t.ui.menus.length - 1]).toBe('pause');
    expect(t.game.input.isDown('forward')).toBe(false);
    expect(t.game.simulatingWhilePaused).toBe(true);
    n = s.tickCount;
    const time0 = s.timer.getHud().time;
    now = frames(t.game, 50, 100, now);
    expect(s.tickCount - n).toBeGreaterThanOrEqual(49);
    expect(s.timer.getHud().time - time0).toBeGreaterThan(0.45);
    expect(s.timer.getHud().state).toBe('running'); // still counts
    expect(s.timer.inPractice).toBe(false);
    // no movement input while paused: friction stops the player
    expect(Math.hypot(s.player.velocity.x, s.player.velocity.y)).toBeLessThan(5);
    t.game.resume();
    expect(t.game.state).toBe('playing');
  });

  it('a run that ends while paused freezes the world from then on', async () => {
    t = await loadedGame();
    const s = t.game.session!;
    startRun(t);
    let now = frames(t.game, 1, 100, 1000);
    t.game.pause();
    s.timer.restart(0); // e.g. a fail teleport back to the start
    const n = s.tickCount;
    now = frames(t.game, 20, 100, now);
    expect(s.tickCount).toBe(n);
  });

  it("the debug API's freeze stops the world even mid-run", async () => {
    t = await loadedGame();
    const s = t.game.session!;
    startRun(t);
    const now = frames(t.game, 1, 100, 1000);
    t.game.pause({ freeze: true });
    const n = s.tickCount;
    frames(t.game, 30, 100, now);
    expect(s.tickCount).toBe(n);
    expect(t.game.runTicks(5)).toBe(5);
    expect(s.timer.getHud().state).toBe('running');
    t.game.resume();
  });
});

describe('hidden tab / stalled frames', () => {
  it('hiding the page mid-run makes the run practice; the hidden time is not caught up', async () => {
    t = await loadedGame();
    const s = t.game.session!;
    startRun(t);
    const now = frames(t.game, 5, 100, 1000);
    t.game.onVisibilityChange(true);
    expect(s.timer.inPractice).toBe(true);
    expect(s.timer.getHud().state).toBe('practice');
    expect(t.ui.lastText()).toBe("[Surf] Timer stopped — run paused, it won't count. Type !r to restart.");
    t.game.onVisibilityChange(false);
    const n = s.tickCount;
    t.game.frame(now + 60000); // a minute later: the first frame back simulates nothing
    expect(s.tickCount).toBe(n);
    t.game.frame(now + 60010);
    expect(s.tickCount - n).toBeLessThanOrEqual(1);
  });

  it('hiding the page in the start zone or in practice changes nothing', async () => {
    t = await loadedGame();
    const s = t.game.session!;
    const chats = t.ui.chats.length;
    t.game.onVisibilityChange(true);
    expect(s.timer.getHud().state).toBe('startzone');
    expect(t.ui.chats.length).toBe(chats);
  });

  it('a frame gap over a second mid-run (the game stopped ticking) also makes it practice; not in autotest', async () => {
    t = await loadedGame();
    const s = t.game.session!;
    startRun(t);
    let now = frames(t.game, 5, 100, 1000);
    now += 300;
    t.game.frame(now); // a hitch: still ranked
    expect(s.timer.getHud().state).toBe('running');
    now += 1500;
    t.game.frame(now);
    expect(s.timer.getHud().state).toBe('practice');

    const u = await loadedGame();
    u.game.autotest = true;
    const su = u.game.session!;
    startRun(u);
    const m = frames(u.game, 5, 100, 1000);
    u.game.frame(m + 5000);
    u.game.onVisibilityChange(true);
    expect(su.timer.getHud().state).toBe('running');
    u.game.dispose();
  });

  it('Game.start() listens to visibilitychange', async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { window: g.window, document: g.document, raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
    const listeners = new Map<string, Array<() => void>>();
    const target = () => ({
      addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: () => void) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
    });
    const doc = { ...target(), hidden: false, pointerLockElement: null };
    g.window = { ...target(), location: { search: '' }, innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 };
    g.document = doc;
    g.requestAnimationFrame = () => 1;
    g.cancelAnimationFrame = () => undefined;
    try {
      const map = makeTestMap();
      const game = new Game({
        renderer: new FakeRenderer(),
        ui: new FakeUi(),
        sound: new FakeSound(),
        canvas: target() as unknown as HTMLCanvasElement,
        loaders: { buildBuiltin: async () => map, builtinMaps: async () => [{ id: 'test', name: 'T', tier: 1 }], catalog: async () => [] },
      });
      game.start();
      await game.loadBuiltinMap('test');
      const s = game.session!;
      game.executeCommand('+forward');
      game.runTicks(100);
      game.executeCommand('-forward');
      expect(s.timer.getHud().state).toBe('running');
      doc.hidden = true;
      for (const f of listeners.get('visibilitychange') ?? []) f();
      expect(s.timer.getHud().state).toBe('practice');
      game.dispose();
      expect(listeners.get('visibilitychange') ?? []).toHaveLength(0);
    } finally {
      g.window = saved.window;
      g.document = saved.document;
      g.requestAnimationFrame = saved.raf;
      g.cancelAnimationFrame = saved.caf;
    }
  });
});

describe('raw input', () => {
  type Lock = (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;
  function device(lock: Lock): InputDevice {
    return new InputDevice({
      canvas: { requestPointerLock: lock } as unknown as HTMLCanvasElement,
      ui: new FakeUi(),
      state: new InputState(),
      dispatcher: new KeyDispatcher(),
      isPlaying: () => true,
      onPointerLockLost: () => undefined,
      onEscape: () => undefined,
      onToggleConsole: () => undefined,
      autotest: false,
    });
  }
  const g = globalThis as Record<string, unknown>;
  let savedDoc: unknown;
  beforeEach(() => {
    savedDoc = g.document;
    g.document = { pointerLockElement: null };
  });
  afterEach(() => {
    g.document = savedDoc;
  });

  it('remembers whether the lock is raw; a fallback prints the advice once', async () => {
    const ok = device(() => Promise.resolve());
    expect(ok.rawInputActive).toBeNull();
    const out1 = await captureAsync(async () => {
      ok.requestPointerLock();
      await tick();
    });
    expect(ok.rawInputActive).toBe(true);
    expect(out1).toEqual([]);

    const calls: unknown[] = [];
    const rejecting = device((opts) => {
      calls.push(opts ?? null);
      return opts?.unadjustedMovement ? Promise.reject(new Error('NotSupportedError')) : Promise.resolve();
    });
    const out2 = await captureAsync(async () => {
      rejecting.requestPointerLock();
      await tick();
      rejecting.requestPointerLock();
      await tick();
    });
    expect(calls).toEqual([{ unadjustedMovement: true }, null, { unadjustedMovement: true }, null]);
    expect(rejecting.rawInputActive).toBe(false);
    expect(out2).toEqual([RAW_INPUT_FALLBACK_MESSAGE]);
    expect(RAW_INPUT_FALLBACK_MESSAGE).toMatch(/Enhance pointer precision/);
    expect(RAW_INPUT_FALLBACK_MESSAGE).toMatch(/100%/);

    // the pre-promise API (no unadjustedMovement support): a plain lock
    const old = device(() => undefined);
    const out3 = await captureAsync(async () => {
      old.requestPointerLock();
      await tick();
    });
    expect(old.rawInputActive).toBe(false);
    expect(out3).toEqual([RAW_INPUT_FALLBACK_MESSAGE]);
  });

  it('m_rawinput 0 is a plain lock without advice; the game reports null before any capture', async () => {
    execute('m_rawinput 0');
    const d = device(() => Promise.resolve());
    const out = await captureAsync(async () => {
      d.requestPointerLock();
      await tick();
    });
    expect(d.rawInputActive).toBe(false);
    expect(out).toEqual([]);
    t = makeGame();
    expect(t.game.rawInputActive).toBeNull();
  });
});

describe('autoexec compatibility', () => {
  it('common CS:GO client settings are stored silently (hidden, archived)', () => {
    t = makeGame();
    const lines = [
      'viewmodel_fov 68',
      'viewmodel_offset_x 2.5; viewmodel_offset_y 0; viewmodel_offset_z -1.5; viewmodel_presetpos 3; viewmodel_recoil 0',
      'cl_bob_lower_amt 5; cl_bobamt_lat 0.1; cl_bobamt_vert 0.1; cl_bobcycle 0.98',
      'r_drawviewmodel 0',
      'cl_draw_only_deathnotices 1',
      'cl_radar_always_centered 0; cl_radar_scale 0.4; cl_hud_radar_scale 1.15; cl_radar_rotate 1; cl_hud_bomb_under_radar 1',
      'cl_hud_playercount_pos 1; cl_hud_playercount_showcount 1; cl_teamid_overhead_always 1',
      'cl_autowepswitch 0; cl_disablefreezecam 1; cl_disablehtmlmotd 1',
      'rate 786432; cl_updaterate 128; cl_cmdrate 128; cl_interp 0; cl_interp_ratio 1',
      'snd_mixahead 0.05; snd_headphone_pan_exponent 2; snd_musicvolume 0; snd_setmixer Dialog vol 0.2',
      'joystick 0; gameinstructor_enable 0; mat_queue_mode 2; mat_monitorgamma 1.6; r_dynamic 0; fps_max_menu 60',
      'cl_showloadout 1; cl_righthand 0; net_graph 1; net_graphpos 2; net_graphheight 100',
      'buy ak47; slot1; +cl_show_team_equipment',
    ];
    const out = capture(() => {
      for (const l of lines) execute(l);
    });
    expect(out.filter((l) => /Unknown command/.test(l))).toEqual([]);
    expect(cvar('viewmodel_fov').value).toBe('68');
    expect(cvar('cl_radar_scale').value).toBe('0.4');
    expect(cvar('rate').value).toBe('786432');
    expect(cvar('cl_righthand').num).toBe(0);
    // hidden from completion / cvarlist, archived like CS:GO client settings
    expect(console_.complete('viewmodel_')).toEqual([]);
    expect(cvar('viewmodel_fov').flags & FCVAR_HIDDEN).toBeTruthy();
    expect(cvar('viewmodel_fov').flags & FCVAR_ARCHIVE).toBeTruthy();
    // no effect on the game: no compat cvar is a render or physics setting
    const before = renderSettingsFromCvars();
    execute('mat_monitorgamma 2.6');
    expect(renderSettingsFromCvars()).toEqual(before);
    expect(COMPAT_CVAR_DEFS.length).toBeGreaterThan(60);
  });

  it('exec runs a stored cfg like Source (comments, quotes, ;, aliases); missing ones say so', () => {
    t = makeGame();
    expect(capture(() => execute('exec autoexec'))).toContain("exec: couldn't exec autoexec");
    writeCfg(
      'autoexec',
      [
        '// my autoexec',
        'sensitivity "1.5" // a comment',
        'alias "+jt" "+jump"; alias "-jt" "-jump"',
        'bind "x" "say !r"',
        'bind k +jt',
        'viewmodel_fov 65',
        'not_a_command 1',
        'echo "done; really"',
        'unterminated "quote',
        'fov_desired 105',
        '',
      ].join('\r\n'),
    );
    const out = capture(() => execute('exec autoexec.cfg'));
    expect(cvar('sensitivity').num).toBe(1.5);
    expect(binds.get('x')).toBe('say !r');
    expect(binds.get('k')).toBe('+jt');
    expect(console_.getAlias('+jt')).toBe('+jump');
    expect(cvar('viewmodel_fov').value).toBe('65');
    expect(cvar('fov_desired').num).toBe(105); // an unclosed quote ends with its line
    expect(out).toContain('Unknown command "not_a_command"');
    expect(out).toContain('done; really');
    // cfg names: case, directories and .cfg don't matter; other characters map like the settings' .cfg import
    execute('fov_desired 90');
    execute('exec CFG/AutoExec.CFG');
    expect(cvar('fov_desired').num).toBe(105);
    writeCfg('my_config', 'fov_desired 95');
    execute('exec "My Config.cfg"');
    expect(cvar('fov_desired').num).toBe(95);
  });

  it('cfg_save / cfg_list / cfg_delete manage the stored cfgs (surf.cfg.<name>)', () => {
    t = makeGame();
    execute('cfg_save prac "sv_cheats 1; fov_desired 100"');
    expect(cfgs.getItem('surf.cfg.prac')).toBe('sv_cheats 1; fov_desired 100');
    execute('cfg_save binds bind j "say !back"');
    expect(readCfg('binds')).toBe('bind j "say !back"');
    execute('exec prac');
    expect(cvar('fov_desired').num).toBe(100);
    execute('exec binds');
    expect(binds.get('j')).toBe('say !back');
    expect(listCfgs()).toEqual(['binds', 'prac']);
    const list = capture(() => execute('cfg_list'));
    expect(list).toContain('prac.cfg (1 line)');
    expect(list).toContain('2 config files');
    execute('cfg_delete prac.cfg');
    expect(readCfg('prac')).toBeNull();
    expect(capture(() => execute('exec prac'))).toContain("exec: couldn't exec prac");
    expect(capture(() => execute('cfg_delete prac'))[0]).toContain('no config file');
    expect(console_.complete('exec b')).toEqual(['exec binds']);
  });

  it('a cfg that execs itself stops at a depth limit', () => {
    t = makeGame();
    writeCfg('loop', 'echo again; exec loop');
    const out = capture(() => execute('exec loop'));
    expect(out.filter((l) => l === 'again').length).toBeLessThanOrEqual(8);
    expect(out.some((l) => /too many nested execs/.test(l))).toBe(true);
  });

  it('autoexec runs at startup, after the saved config', () => {
    writeCfg('autoexec', 'fov_desired 110\nviewmodel_fov 68');
    t = makeGame();
    expect(cvar('fov_desired').num).toBe(110);
    expect(cvar('viewmodel_fov').value).toBe('68');
  });
});

describe('r_drawzones modes', () => {
  it('0 off, 1 floor outline (default), 2 full box', async () => {
    t = await loadedGame();
    expect(cvar('r_drawzones').num).toBe(1);
    expect(renderSettingsFromCvars()).toMatchObject({ drawZones: true, zoneStyle: 'floor' });
    execute('r_drawzones 2');
    expect(t.renderer.settings).toMatchObject({ drawZones: true, zoneStyle: 'box' });
    execute('r_drawzones 0');
    expect(t.renderer.settings).toMatchObject({ drawZones: false });
    execute('r_drawzones 5');
    expect(cvar('r_drawzones').num).toBe(2);
    execute('r_drawzones 1');
    expect(t.renderer.settings).toMatchObject({ drawZones: true, zoneStyle: 'floor' });
  });
});

describe('welcome line, !rank, !wrcp and suggestions', () => {
  it('the welcome line says where zones come from in a word; !mi keeps the details', async () => {
    t = await loadedGame();
    const welcome = t.ui.texts().find((l) => l.includes('| Tier'))!;
    expect(welcome).toBe('[Surf] surf_gamecore_test | Tier 2 | Linear | Zones: map');
    const none = await loadedGame(makeTestMap({ name: 'surf_nozones', zones: [] }));
    expect(none.ui.texts().find((l) => l.includes('| Tier'))).toBe('[Surf] surf_nozones | Tier 2 | Linear | Zones: none – type !zones');
    // (only an automatic start zone around the spawn: still "none", without a second line about it)
    expect(none.game.session!.timer.zoneSource).toBe('heuristic');
    expect(none.ui.texts().some((l) => l.includes('no timer zones') || l.includes('No end zone'))).toBe(false);
    none.game.dispose();
    t.ui.chats.length = 0;
    t.game.say('/mi');
    expect(t.ui.lastText()).toBe('[Surf] surf_gamecore_test | Tier 2 | Linear | Zones: built-in');
  });

  it('!rank / !mrank / !prank: Rank 1/1 with your PB and completions', async () => {
    t = await loadedGame();
    t.game.say('/rank');
    expect(t.ui.lastText()).toBe('[Surf] You are not ranked on surf_gamecore_test (100 tick) yet: finish it to get a rank.');
    const s = t.game.session!;
    t.game.executeCommand('+forward');
    for (let i = 0; i < 1200 && s.timer.getHud().state !== 'finished'; i++) t.game.runTicks(1);
    t.game.executeCommand('-forward');
    expect(t.ui.texts().find((l) => l.includes(' finished '))).toMatch(/\| Rank 1\/1$/);
    for (const cmd of ['/rank', '/mrank', '/prank']) {
      t.game.say(cmd);
      expect(t.ui.lastText()).toMatch(/^\[Surf\] Player is ranked 1\/1 on surf_gamecore_test \(100 tick\) \| PB 00:0\d\.\d{3} \| 1 completion$/);
    }
  });

  it('!wrcp / !cpr / !srcp / !stagetop list the stage times', async () => {
    t = await loadedGame();
    for (const cmd of ['/wrcp', '/cpr', '/srcp', '/stagetop', '/stages']) {
      t.game.say(cmd);
      expect(t.ui.lastText()).toBe('[Surf] surf_gamecore_test is linear (no stages).');
    }
  });

  it('suggestions only for near misses', async () => {
    t = await loadedGame();
    expect(suggestChatCommand('fob')).toBe('fov');
    expect(suggestChatCommand('bakc')).toBe('back'); // a transposition is one typo
    expect(suggestChatCommand('restrat')).toBe('restart');
    expect(suggestChatCommand('rnak')).toBe('rank');
    expect(suggestChatCommand('xyzzy')).toBeNull();
    expect(suggestChatCommand('zz')).toBeNull();
    expect(suggestChatCommand('wtf')).toBeNull();
    expect(editDistance('bakc', 'back')).toBe(1);
    t.game.say('!rank');
    expect(t.ui.texts().some((l) => l.includes('Unknown command'))).toBe(false);
    t.game.say('!ranking');
    expect(t.ui.lastText()).toContain('Unknown command !ranking.');
    expect(t.ui.lastText()).not.toContain('Did you mean !back');
  });
});
