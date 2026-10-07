import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_, cvar, execute } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { CHAT_PREFIX } from '../src/game/commands';
import { registerConvars, tickInterval } from '../src/game/convars';
import { Game, MAX_TICKS_PER_FRAME, accumulateTicks, applyBaseVelocity, interpolateOrigin, renderSettingsFromCvars, triggerColor } from '../src/game/game';
import { FL_BASEVELOCITY, IN_JUMP, MOVETYPE_NOCLIP, VIEW_OFFSET_STAND, createPlayerState } from '../src/physics/playertypes';
import { FakeRenderer, FakeUi, loadedGame, makeGame, makeTestMap, resetGlobals } from './gamecore_helpers';

beforeEach(() => {
  registerConvars();
  resetGlobals();
});
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
});

/** Renders `count` frames at `fps` starting after `startMs`; returns the time of the last frame. */
function frames(game: Game, count: number, fps = 100, startMs = 1000): number {
  let t = startMs;
  for (let i = 0; i < count; i++) {
    t += 1000 / fps;
    game.frame(t);
  }
  return t;
}

describe('tick math', () => {
  it('accumulates real time into whole ticks', () => {
    let acc = 0;
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const r = accumulateTicks(acc, 1 / 60, 0.01);
      acc = r.acc;
      total += r.ticks;
      expect(r.ticks).toBeGreaterThanOrEqual(1);
      expect(r.ticks).toBeLessThanOrEqual(2);
    }
    expect(total).toBe(100); // one second at 100 tick
    expect(acc).toBeLessThan(0.01);
  });

  it('runs no tick for short frames and keeps the remainder', () => {
    const r = accumulateTicks(0, 0.004, 0.01);
    expect(r).toEqual({ ticks: 0, acc: 0.004 });
    const r2 = accumulateTicks(r.acc, 0.007, 0.01);
    expect(r2.ticks).toBe(1);
    expect(r2.acc).toBeCloseTo(0.001, 12);
  });

  it('is robust to floating point (0.1 s = exactly 10 ticks)', () => {
    let acc = 0;
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const r = accumulateTicks(acc, 0.01, 0.01);
      acc = r.acc;
      n += r.ticks;
    }
    expect(n).toBe(10);
  });

  it('caps the ticks per frame and drops the backlog', () => {
    const r = accumulateTicks(0, 0.5, 0.01);
    expect(r.ticks).toBe(MAX_TICKS_PER_FRAME);
    expect(r.acc).toBe(0);
    expect(accumulateTicks(0, NaN, 0.01).ticks).toBe(0);
    expect(accumulateTicks(0, -1, 0.01).ticks).toBe(0);
  });

  it('interpolates the render origin between ticks', () => {
    const out = v3();
    interpolateOrigin(out, v3(0, 0, 0), v3(10, -20, 4), 0.25);
    expect(out).toEqual({ x: 2.5, y: -5, z: 1 });
    interpolateOrigin(out, v3(0, 0, 0), v3(10, 0, 0), 7);
    expect(out.x).toBe(10);
  });

  it('converts a released base velocity into velocity (PhysicsSimulate)', () => {
    const ps = createPlayerState();
    ps.baseVelocity = v3(0, 0, 800);
    ps.flags |= FL_BASEVELOCITY; // a trigger_push touched us last tick: keep pushing via base velocity
    applyBaseVelocity(ps, 0.01);
    expect(ps.velocity.z).toBe(0);
    expect(ps.baseVelocity.z).toBe(800);
    expect(ps.flags & FL_BASEVELOCITY).toBe(0);
    // no trigger set the flag this time: the push is released into real velocity (+ half a tick)
    applyBaseVelocity(ps, 0.01);
    expect(ps.velocity.z).toBeCloseTo(800 * 1.005, 10);
    expect(ps.baseVelocity).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('render settings', () => {
  it('maps the video cvars', () => {
    cvar('mat_fullbright').set(1);
    cvar('r_anisotropy').set(4);
    const s = renderSettingsFromCvars();
    expect(s).toMatchObject({ fullbright: true, drawZones: true, drawTriggers: false, wireframe: false, brightness: 1, maxAnisotropy: 4, renderScale: 1, fogEnabled: true, drawSky3D: true, drawClips: false });
  });

  it('colors debug triggers by class (dimmed when disabled)', () => {
    expect(triggerColor('trigger_teleport', true)).toEqual([1, 0.35, 0.3]);
    const d = triggerColor('trigger_teleport', false);
    expect(d[0]).toBeCloseTo(0.35, 9);
    expect(triggerColor('trigger_teleport', false)).toBe(d); // cached
  });
});

describe('map loading', () => {
  it('loads a built-in map: loading -> playing, renderer, zones, spawn in the start zone', async () => {
    const t = makeGame();
    const states: string[] = [];
    t.game.on('statechange', (s) => states.push(String(s)));
    const loads: unknown[] = [];
    t.game.on('mapload', (n) => loads.push(n));
    expect(t.game.state).toBe('menu');
    await t.game.loadBuiltinMap('test');
    expect(states).toEqual(['loading', 'playing']);
    expect(loads).toEqual(['surf_gamecore_test']);
    expect(t.game.state).toBe('playing');
    expect(t.game.mapName).toBe('surf_gamecore_test');
    expect(t.renderer.loaded).toBe(t.map);
    expect(t.ui.menus).toContain('none');
    expect(t.ui.loading[t.ui.loading.length - 1]).toBeNull();
    const s = t.game.session!;
    expect(s.timer.zoneSource).toBe('builtin');
    expect(s.timer.getHud().state).toBe('startzone');
    expect(Math.abs(s.player.origin.x)).toBeLessThan(1);
    expect(s.player.origin.z).toBeGreaterThanOrEqual(0);
    expect(s.tier).toBe(2);
    expect(t.ui.texts().some((l) => l.includes('Welcome to surf_gamecore_test'))).toBe(true);
    expect(t.game.getZones()).toHaveLength(2);
  });

  it('reports load errors readably and returns to the menu', async () => {
    const t = makeGame(makeTestMap(), {
      buildBuiltin: async () => {
        throw new Error('the map file is corrupt');
      },
    });
    await t.game.loadBuiltinMap('test');
    expect(t.game.state).toBe('menu');
    expect(t.game.session).toBeNull();
    const last = t.ui.loading[t.ui.loading.length - 1];
    expect(last).toMatchObject({ phase: 'error', message: 'the map file is corrupt' });
    expect(t.ui.lastText()).toContain('the map file is corrupt');
    expect(t.ui.menus[t.ui.menus.length - 1]).toBe('main');
  });

  it('a catalog name that is not in the catalog is an error', async () => {
    const t = makeGame();
    await t.game.loadCatalogMap('surf_does_not_exist');
    expect(t.game.state).toBe('menu');
    expect(t.ui.loading[t.ui.loading.length - 1]).toMatchObject({ phase: 'error' });
  });

  it('`map <builtin id>` loads the built-in map', async () => {
    const t = makeGame();
    await t.game.loadMapByName('TEST');
    expect(t.game.state).toBe('playing');
  });

  it('disconnect aborts a load in flight (renderer upload)', async () => {
    const t = makeGame();
    t.renderer.loadDelay = 30;
    const p = t.game.loadBuiltinMap('test');
    await new Promise((r) => setTimeout(r, 5));
    expect(t.game.state).toBe('loading');
    t.game.disconnect();
    expect(t.game.state).toBe('menu');
    await p;
    expect(t.game.state).toBe('menu');
    expect(t.game.session).toBeNull();
    expect(t.renderer.loaded).toBeNull(); // the late upload was unloaded again
  });

  it('a newer load supersedes an older one', async () => {
    const a = makeTestMap({ name: 'surf_a' });
    const b = makeTestMap({ name: 'surf_b' });
    let calls = 0;
    const t = makeGame(a, {
      buildBuiltin: async (id) => {
        calls++;
        if (id === 'a') {
          await new Promise((r) => setTimeout(r, 30));
          return a;
        }
        return b;
      },
    });
    const pa = t.game.loadBuiltinMap('a');
    const pb = t.game.loadBuiltinMap('b');
    await Promise.all([pa, pb]);
    expect(calls).toBeLessThanOrEqual(2); // "a" is dropped as soon as it notices (here: before building)
    expect(t.game.mapName).toBe('surf_b');
    expect(t.game.state).toBe('playing');
    expect(t.renderer.loaded).toBe(b);
  });

  it('a slow upload that gets superseded never unloads the newer map', async () => {
    const a = makeTestMap({ name: 'surf_a' });
    const b = makeTestMap({ name: 'surf_b' });
    const t = makeGame(a, { buildBuiltin: async (id) => (id === 'a' ? a : b) });
    t.renderer.loadDelay = (m) => (m.name === 'surf_a' ? 40 : 1);
    const pa = t.game.loadBuiltinMap('a');
    await new Promise((r) => setTimeout(r, 10)); // A is uploading now
    const pb = t.game.loadBuiltinMap('b');
    await Promise.all([pa, pb]);
    expect(t.renderer.maxInFlight).toBe(1);
    expect(t.renderer.uploads).toEqual(['surf_a', 'surf_b']);
    expect(t.renderer.loaded).toBe(b);
    expect(t.game.mapName).toBe('surf_b');
    expect(t.game.state).toBe('playing');
  });

  it('a renderer upload failure is reported and leaves the renderer empty', async () => {
    const t = makeGame();
    t.renderer.failNext = new Error('WebGL: out of memory');
    await t.game.loadBuiltinMap('test');
    expect(t.game.state).toBe('menu');
    expect(t.ui.loading[t.ui.loading.length - 1]).toMatchObject({ phase: 'error', message: 'WebGL: out of memory' });
    expect(t.renderer.unloads).toBeGreaterThan(0);
    // and the next load works
    await t.game.loadBuiltinMap('test');
    expect(t.game.state).toBe('playing');
  });

  it('retry reloads the last map; disconnect unloads', async () => {
    const t = await loadedGame();
    const first = t.game.session;
    await t.game.retry();
    expect(t.game.session).not.toBe(first);
    expect(t.game.state).toBe('playing');
    t.game.disconnect();
    expect(t.game.state).toBe('menu');
    expect(t.game.session).toBeNull();
    expect(t.renderer.unloads).toBeGreaterThan(0);
    expect(t.game.mapName).toBeNull();
  });
});

describe('main loop', () => {
  it('runs ticks for the elapsed time (100 tick at 60 fps)', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.frame(1000);
    const before = s.tickCount;
    frames(t.game, 60, 60, 1000);
    expect(s.tickCount - before).toBeGreaterThanOrEqual(99);
    expect(s.tickCount - before).toBeLessThanOrEqual(100);
    expect(t.renderer.renders.length).toBeGreaterThanOrEqual(60);
    expect(t.ui.huds).toBeGreaterThanOrEqual(60);
  });

  it('follows the tickrate cvar', async () => {
    const t = await loadedGame();
    cvar('tickrate').set(128);
    const s = t.game.session!;
    t.game.frame(1000);
    const before = s.tickCount;
    frames(t.game, 100, 100, 1000);
    expect(s.tickCount - before).toBeGreaterThanOrEqual(127);
    expect(s.tickCount - before).toBeLessThanOrEqual(128);
    expect(tickInterval()).toBe(1 / 128);
  });

  it('host_timescale (cheat) scales simulated time', async () => {
    const t = await loadedGame();
    execute('host_timescale 0.5');
    expect(cvar('host_timescale').num).toBe(1); // blocked without sv_cheats
    execute('sv_cheats 1; host_timescale 0.5');
    const s = t.game.session!;
    t.game.frame(1000);
    const before = s.tickCount;
    frames(t.game, 100, 100, 1000);
    expect(s.tickCount - before).toBeGreaterThanOrEqual(49);
    expect(s.tickCount - before).toBeLessThanOrEqual(50);
    execute('sv_cheats 0');
    expect(cvar('host_timescale').num).toBe(1); // cheats off restores cheat cvars
  });

  it('interpolates the view across the ticks of one frame', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.frame(1000);
    const yaws: number[] = [];
    const tick = s.entities.tick.bind(s.entities);
    s.entities.tick = () => {
      yaws.push(s.player.viewAngles.yaw);
      tick();
    };
    t.game.input.addMouse(-400, 0); // 22 degrees left
    t.game.frame(1040); // 4 ticks in one 40 ms frame
    expect(yaws.length).toBe(4);
    const start = yaws[3] - 22;
    expect(yaws.map((y) => +(y - start).toFixed(6))).toEqual([5.5, 11, 16.5, 22]);
  });

  it('renders the eye position interpolated between the last two ticks', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.frame(1000);
    t.game.executeCommand('+forward');
    frames(t.game, 30, 100, 1000);
    t.game.frame(1300 + 5); // half a tick past
    const r = t.renderer.renders[t.renderer.renders.length - 1];
    const a = 0.5;
    expect(r.origin.x).toBeCloseTo(s.prevOrigin.x + (s.player.origin.x - s.prevOrigin.x) * a, 6);
    expect(r.origin.z).toBeCloseTo(s.player.origin.z + VIEW_OFFSET_STAND, 6);
    expect(r.fov).toBe(90);
    t.game.executeCommand('-forward');
  });

  it('paused: no ticks, still renders; resume continues', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.frame(1000);
    t.game.pause();
    expect(t.game.state).toBe('paused');
    expect(t.ui.menus[t.ui.menus.length - 1]).toBe('pause');
    const n = s.tickCount;
    const r = t.renderer.renders.length;
    frames(t.game, 20, 100, 1000);
    expect(s.tickCount).toBe(n);
    expect(t.renderer.renders.length).toBe(r + 20);
    t.game.resume();
    expect(t.game.state).toBe('playing');
    frames(t.game, 20, 100, 2000);
    expect(s.tickCount).toBeGreaterThan(n + 15);
  });

  it('pausing releases held buttons', async () => {
    const t = await loadedGame();
    t.game.executeCommand('+forward');
    t.game.pause();
    expect(t.game.input.isDown('forward')).toBe(false);
  });

  it('late renderer progress after the load does not bring the loading screen back', async () => {
    const t = makeGame();
    let late: ((p: { phase: 'textures'; message: string }) => void) | undefined;
    t.renderer.loadMap = async (map, onProgress) => {
      late = onProgress as typeof late;
      t.renderer.loaded = map;
    };
    await t.game.loadBuiltinMap('test');
    const n = t.ui.loading.length;
    late?.({ phase: 'textures', message: 'still streaming' });
    expect(t.ui.loading.length).toBe(n);
    expect(t.game.state).toBe('playing');
  });

  it('dispose detaches from the console', async () => {
    const t = await loadedGame();
    t.game.dispose();
    expect(t.game.state).toBe('menu');
    const before = Object.keys(t.renderer.settings).length;
    cvar('mat_fullbright').set(1);
    expect(Object.keys(t.renderer.settings).length).toBe(before);
    expect(t.renderer.settings.fullbright).toBeUndefined();
  });

  it('fps_max limits the rendered frames', async () => {
    const t = await loadedGame();
    cvar('fps_max').set(60);
    t.game.frame(1000);
    const r0 = t.renderer.renders.length;
    frames(t.game, 144, 144, 1000); // one second at 144 Hz
    const rendered = t.renderer.renders.length - r0;
    expect(rendered).toBeGreaterThanOrEqual(57);
    expect(rendered).toBeLessThanOrEqual(63);
  });
});

describe('gameplay', () => {
  it('holding +forward runs at 250 u/s and plays footsteps', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.executeCommand('+forward');
    t.game.runTicks(150);
    t.game.executeCommand('-forward');
    expect(s.player.velocity.x).toBeCloseTo(250, 0);
    expect(s.player.origin.x).toBeGreaterThan(200);
    expect(t.sound.played.filter((n) => n === 'footstep').length).toBeGreaterThan(2);
    const hud = t.game.getHud();
    expect(hud.visible).toBe(true);
    expect(hud.speed).toBeCloseTo(250, 0);
  });

  it('jump and landing sounds; mouse-wheel style jump taps', async () => {
    const t = await loadedGame();
    t.game.runTicks(5);
    t.game.dispatcher.tap('mwheeldown');
    t.game.runTicks(1);
    expect(t.sound.played).toContain('jump');
    expect(t.game.input.isDown('jump')).toBe(false); // released after the tick
    t.game.runTicks(80);
    expect(t.sound.played).toContain('land');
  });

  it('a full run: start zone -> running -> end zone -> PB, replay, ghost', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    const finished: unknown[] = [];
    t.game.on('runfinished', (e) => finished.push(e));
    expect(s.timer.getHud().state).toBe('startzone');
    t.game.executeCommand('+forward');
    t.game.runTicks(100);
    expect(s.timer.getHud().state).toBe('running');
    t.game.runTicks(700);
    t.game.executeCommand('-forward');
    expect(s.timer.getHud().state).toBe('finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ group: 0, ranked: true, isPb: true });
    expect(s.timer.getRecords(0)).toHaveLength(1);
    const pb = s.replay.getPb(0);
    expect(pb).not.toBeNull();
    // the replay covers the run: run time / tick interval frames
    expect(Math.abs(pb!.frames.length / 6 - pb!.time / 0.01)).toBeLessThanOrEqual(1);
    const finishLine = t.ui.chats.find((l) => l.map((x) => x.text).join('').includes('finished'))!;
    expect(finishLine.map((x) => x.text).join('')).toContain('surf_gamecore_test');
    expect(finishLine.slice(0, 3)).toEqual([...CHAT_PREFIX]); // the timer's prefix shown in the shared style

    // next attempt: the ghost runs with us
    t.game.say('!r');
    expect(s.timer.getHud().state).toBe('startzone');
    t.game.frame(5000);
    t.game.frame(5010);
    let g = t.renderer.ghosts[t.renderer.ghosts.length - 1];
    expect(g).toHaveLength(1);
    t.game.executeCommand('+forward');
    t.game.runTicks(100);
    t.game.frame(5020);
    g = t.renderer.ghosts[t.renderer.ghosts.length - 1];
    expect(g).toHaveLength(1);
    expect(g[0].origin.x).toBeGreaterThan(50);
    // !ghost off hides it
    t.game.say('/ghost');
    t.game.frame(5030);
    expect(t.renderer.ghosts[t.renderer.ghosts.length - 1]).toEqual([]);
    t.game.executeCommand('-forward');

    // the scoreboard shows the PB and the replay bot
    const sb = t.game.getScoreboard();
    expect(sb.rows[0]).toMatchObject({ isLocal: true, time: pb!.time });
    expect(sb.rows[1]).toMatchObject({ isBot: true });
  });

  it('changing a physics cvar mid-run puts the run in practice', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.executeCommand('+forward');
    t.game.runTicks(100);
    t.game.executeCommand('-forward');
    expect(s.timer.getHud().state).toBe('running');
    cvar('sv_airaccelerate').set(1000);
    expect(s.timer.inPractice).toBe(true);
    expect(s.customPhysics).toBe(true);
    expect(t.ui.texts()).toContain("Server cvar 'sv_airaccelerate' changed to 1000");
    const n = t.ui.chats.length;
    cvar('sv_airaccelerate').set(1000); // no change, no message
    cvar('sensitivity').set(1); // client cvars are not announced
    expect(t.ui.chats.length).toBe(n);
    cvar('tickrate').set('85.3333'); // canonicalized to 85.3: announced once
    expect(t.ui.texts().filter((l) => l.startsWith("Server cvar 'tickrate'"))).toEqual(["Server cvar 'tickrate' changed to 85.3"]);
  });

  it('spectates the PB replay; jumping leaves it and respawns at the start', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.executeCommand('+forward');
    t.game.runTicks(800);
    t.game.executeCommand('-forward');
    expect(s.replay.getPb(0)).not.toBeNull();
    t.game.say('!replay');
    expect(t.game.spectating).toBe(true);
    t.game.frame(10000);
    t.game.frame(11000);
    const hud = t.game.getHud();
    expect(hud.spectating).toBe('PB Replay');
    expect(hud.timer.time).toBeGreaterThan(0.5);
    const r = t.renderer.renders[t.renderer.renders.length - 1];
    expect(r.origin.x).toBeGreaterThan(100); // camera follows the replay
    const ticks = s.tickCount;
    t.game.frame(11500);
    expect(s.tickCount).toBe(ticks); // the player is frozen while spectating
    t.game.executeCommand('+jump');
    t.game.frame(11510);
    t.game.executeCommand('-jump');
    expect(t.game.spectating).toBe(false);
    expect(s.timer.getHud().state).toBe('startzone');
    // a jump key held when the replay starts doesn't end it; a new press does
    t.game.executeCommand('+jump');
    t.game.say('/replay');
    t.game.frame(12000);
    expect(t.game.spectating).toBe(true);
    t.game.executeCommand('-jump');
    t.game.dispatcher.tap('mwheelup');
    t.game.frame(12010);
    expect(t.game.spectating).toBe(false);
    expect(s.timer.getHud().state).toBe('startzone');
  });

  it('teleports reset the interpolation and re-categorize', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.teleportPlayer(v3(500, 500, 300), { pitch: 10, yaw: 90, roll: 0 }, v3(0, 0, 0));
    expect(s.prevOrigin).toEqual(s.player.origin);
    expect(s.player.onGround).toBe(false);
    expect(t.game.getViewAngles()).toMatchObject({ pitch: 10, yaw: 90 });
    t.game.runTicks(200);
    expect(s.player.onGround).toBe(true);
    expect(s.player.origin.z).toBeLessThan(3);
  });

  it('noclip flies with +forward and +jump, enters practice', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    execute('noclip');
    expect(s.player.moveType).toBe(MOVETYPE_NOCLIP);
    expect(s.timer.inPractice).toBe(true);
    t.game.executeCommand('+jump');
    t.game.runTicks(50);
    t.game.executeCommand('-jump');
    expect(s.player.origin.z).toBeGreaterThan(50);
    execute('noclip');
    expect(s.player.moveType).not.toBe(MOVETYPE_NOCLIP);
  });

  it('zones go to the renderer and are re-sent after zone edits; the editor draws boxes', async () => {
    const t = await loadedGame();
    t.game.frame(1000);
    expect(t.renderer.zones.length).toBe(1);
    expect(t.renderer.zones[0].zones).toHaveLength(2);
    t.game.frame(1010);
    expect(t.renderer.zones.length).toBe(1);
    execute('zone_delete 1');
    t.game.frame(1020);
    expect(t.renderer.zones.length).toBe(2);
    expect(t.renderer.zones[1].zones).toHaveLength(1);
    execute('zone_edit');
    t.game.frame(1030);
    expect(t.renderer.debugBoxes[t.renderer.debugBoxes.length - 1].length).toBeGreaterThanOrEqual(1);
    execute('zone_edit');
    t.game.frame(1040);
    expect(t.renderer.debugBoxes[t.renderer.debugBoxes.length - 1]).toEqual([]);
  });

  it('render cvars are forwarded on change', async () => {
    const t = await loadedGame();
    cvar('fog_enable').set(0);
    expect(t.renderer.settings.fogEnabled).toBe(false);
    cvar('r_brightness').set(1.5);
    expect(t.renderer.settings.brightness).toBe(1.5);
  });

  it('HUD: origin is the eye position (cl_showpos), like getpos', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    const hud = t.game.getHud();
    expect(hud.origin.x).toBeCloseTo(s.player.origin.x, 6);
    expect(hud.origin.z).toBeCloseTo(s.player.origin.z + s.player.viewOffsetZ, 6);
  });

  it('HUD: keys, visibility, practice and noclip flags', async () => {
    const t = await loadedGame();
    t.game.executeCommand('+moveleft; +jump');
    let hud = t.game.getHud();
    expect(hud.keys.left).toBe(true);
    expect(hud.keys.jump).toBe(true);
    expect(hud.keys.right).toBe(false);
    t.game.executeCommand('-moveleft; -jump');
    cvar('cl_drawhud').set(0);
    expect(t.game.getHud().visible).toBe(false);
    cvar('cl_drawhud').set(1);
    execute('noclip');
    hud = t.game.getHud();
    expect(hud.noclip).toBe(true);
    expect(hud.practice).toBe(true);
    t.game.disconnect();
    expect(t.game.getHud().visible).toBe(false);
  });

  it('+showscores toggles the scoreboard', async () => {
    const t = await loadedGame();
    t.game.dispatcher.keyDown('tab');
    t.game.dispatcher.keyUp('tab');
    expect(t.ui.scoreboard.slice(-2)).toEqual([true, false]);
  });

  it('cvar changes are announced once per frame', async () => {
    const t = await loadedGame();
    let n = 0;
    t.game.on('cvarschanged', () => n++);
    cvar('fov_desired').set(100);
    cvar('sensitivity').set(2);
    t.game.frame(1000);
    t.game.frame(1010);
    expect(n).toBe(1);
  });

  it('IN_JUMP reaches the movement for a tap shorter than a tick', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    t.game.runTicks(3);
    t.game.executeCommand('+jump');
    t.game.executeCommand('-jump');
    t.game.runTicks(1);
    expect(s.player.oldButtons & IN_JUMP).toBeTruthy();
    expect(s.player.velocity.z).toBeGreaterThan(250);
  });
});

describe('air strafing through the whole input pipeline', () => {
  /** Bhops forward then strafes for `frames` frames at 100 fps, turning `dx` counts per frame. Returns the final 2D speed. */
  async function strafe(side: '+moveleft' | '+moveright', dx: number, frames = 150) {
    const t = await loadedGame(makeTestMap({ zones: [
      { type: 'start', group: 0, index: 0, mins: v3(-1900, -128, 0), maxs: v3(-1700, 128, 128) },
      { type: 'end', group: 0, index: 0, mins: v3(1900, 1900, 0), maxs: v3(2000, 2000, 128) },
    ] }));
    const s = t.game.session!;
    t.game.teleportPlayer(v3(-1800, 0, 0), { pitch: 0, yaw: 0, roll: 0 }, v3());
    t.game.executeCommand('+forward');
    let now = 1000;
    for (let i = 0; i < 60; i++) t.game.frame((now += 10)); // run out of the start zone at 250 u/s
    t.game.executeCommand(`+jump; -forward; ${side}`); // autobhop + strafe
    const v0 = Math.hypot(s.player.velocity.x, s.player.velocity.y);
    for (let i = 0; i < frames; i++) {
      t.game.input.addMouse(dx, 0);
      t.game.frame((now += 10));
    }
    t.game.executeCommand(`-jump; ${side.replace('+', '-')}`);
    return { v0, v1: Math.hypot(s.player.velocity.x, s.player.velocity.y), t };
  }

  it('A + turning left (mouse left) gains speed, with ~100% sync', async () => {
    const { v0, v1, t } = await strafe('+moveleft', -20); // 1.1 degrees per tick to the left
    if (process.env.SURF_REPORT_TIMINGS) console.log(`[strafe] synced left: ${v0.toFixed(1)} -> ${v1.toFixed(1)} u/s`);
    expect(v0).toBeGreaterThan(240);
    expect(v1).toBeGreaterThan(v0 + 60);
    const hud = t.game.getHud();
    expect(hud.timer.state).toBe('running');
    expect(hud.sync).toBeGreaterThan(95);
    expect(hud.strafes).toBeGreaterThanOrEqual(1);
    expect(hud.jumps).toBeGreaterThan(0);
  });

  it('D + turning right gains speed too', async () => {
    const { v0, v1 } = await strafe('+moveright', 20);
    expect(v1).toBeGreaterThan(v0 + 60);
  });

  it('strafing against the turn gains nothing and has no sync', async () => {
    // a 66 degree counter-turn: only the first tick (wishdir perpendicular to the velocity) can add up to 30 u/s
    const { v0, v1, t } = await strafe('+moveleft', 40, 30);
    expect(v1).toBeLessThan(v0 + 31);
    expect(t.game.getHud().sync).toBeLessThan(5);
  });
});

describe('map logic inside the loop', () => {
  const triggerMap = () =>
    makeTestMap({
      models: {
        1: { mins: [300, -64, 0], maxs: [364, 64, 128] }, // teleport ahead of the start
        2: { mins: [-700, -64, 0], maxs: [-600, 64, 128] }, // booster behind the start
        3: { mins: [-64, 600, 0], maxs: [64, 700, 128] }, // void to the left
        4: { mins: [-1000, 900, 0], maxs: [-900, 1100, 128] }, // horizontal booster (+x)
      },
      entities: `
        { "classname" "trigger_teleport" "model" "*1" "target" "dest" "spawnflags" "1" }
        { "classname" "info_teleport_destination" "targetname" "dest" "origin" "-1500 -1500 0" "angles" "0 90 0" }
        { "classname" "trigger_push" "model" "*2" "spawnflags" "1" "speed" "3000" "pushdir" "-90 0 0" }
        { "classname" "trigger_push" "model" "*4" "spawnflags" "1" "speed" "1000" "pushdir" "0 0 0" }
        { "classname" "trigger_hurt" "model" "*3" "spawnflags" "1" "damage" "1000" }`,
    });

  it('a trigger_teleport moves the player without camera smear and snaps the view', async () => {
    const t = await loadedGame(triggerMap());
    const s = t.game.session!;
    t.game.executeCommand('+forward');
    let n = 0;
    while (s.player.origin.x > -1000 && n++ < 300) t.game.runTicks(1);
    t.game.executeCommand('-forward');
    expect(s.player.origin.x).toBeCloseTo(-1500, 0);
    expect(s.player.origin.y).toBeCloseTo(-1500, 0);
    expect(t.game.getViewAngles().yaw).toBeCloseTo(90, 6); // the input view follows the destination angles
    expect(s.player.velocity.x).toBe(0);
    // the frame right after the teleport renders at the destination (no lerp from the old position)
    t.game.frame(1000);
    const r = t.renderer.renders[t.renderer.renders.length - 1];
    expect(r.origin.x).toBeCloseTo(-1500, 0);
  });

  it('a vertical trigger_push accelerates the player up (StartGravity consumes base velocity z)', async () => {
    const t = await loadedGame(triggerMap());
    const s = t.game.session!;
    t.game.teleportPlayer(v3(-650, 0, 0), null, v3());
    t.game.runTicks(3);
    expect(s.player.onGround).toBe(false);
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      t.game.runTicks(1);
      peak = Math.max(peak, s.player.origin.z);
    }
    // net (3000 - 800) u/s² over the 128-unit trigger: ~750 u/s at its top, apex ~480
    expect(peak).toBeGreaterThan(420);
    expect(peak).toBeLessThan(540);
    expect(t.sound.played).toContain('booster');
  });

  it('a horizontal trigger_push hands its base velocity over as real velocity when the player leaves it', async () => {
    const t = await loadedGame(triggerMap());
    const s = t.game.session!;
    t.game.teleportPlayer(v3(-950, 1000, 0), null, v3());
    let left = -1;
    for (let i = 0; i < 100 && left < 0; i++) {
      t.game.runTicks(1);
      if (s.player.origin.x - 16 > -900) left = i;
    }
    expect(left).toBeGreaterThan(0);
    t.game.runTicks(1); // the tick after leaving: the base velocity is converted (+ half a tick)
    expect(s.player.baseVelocity.x).toBe(0);
    expect(s.player.velocity.x).toBeGreaterThan(900);
  });

  it('a lethal trigger_hurt respawns the player at the start', async () => {
    const t = await loadedGame(triggerMap());
    const s = t.game.session!;
    t.game.teleportPlayer(v3(0, 650, 0), null, v3());
    t.game.runTicks(3);
    expect(Math.abs(s.player.origin.y)).toBeLessThan(1);
    expect(s.timer.getHud().state).toBe('startzone');
  });

  it('a throwing world system is contained (logged, the loop goes on)', async () => {
    const t = await loadedGame();
    const s = t.game.session!;
    s.entities.tick = () => {
      throw new Error('broken entity');
    };
    const out: string[] = [];
    const off = console_.onOutput((l) => out.push(l.text));
    const err = console.error;
    console.error = () => undefined;
    try {
      t.game.executeCommand('+forward');
      t.game.runTicks(50);
      t.game.executeCommand('-forward');
    } finally {
      console.error = err;
      off();
    }
    expect(s.player.origin.x).toBeGreaterThan(20);
    expect(out.filter((l) => l.includes('broken entity'))).toHaveLength(3); // capped
    expect(out.some((l) => l.includes('further errors are not shown'))).toBe(true);
  });
});

describe('fakes', () => {
  it('are usable standalone', () => {
    expect(new FakeRenderer().stats().drawCalls).toBe(0);
    expect(new FakeUi().isTyping()).toBe(false);
  });
});
