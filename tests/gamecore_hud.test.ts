import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { registerConvars } from '../src/game/convars';
import { createDebugApi, parseUrlOptions } from '../src/game/debugapi';
import {
  createHudState,
  emptyTimerHud,
  fillKeysFromButtons,
  horizontalSpeed,
  turnFromYawDelta,
  updateHudState,
} from '../src/game/hud';
import { IN_BACK, IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVELEFT, IN_SPEED } from '../src/physics/playertypes';
import { loadedGame, resetGlobals } from './gamecore_helpers';

beforeEach(() => {
  registerConvars();
  resetGlobals();
});
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
});

describe('HUD assembly', () => {
  it('speed is the horizontal velocity', () => {
    expect(horizontalSpeed(v3(300, 400, -1000))).toBe(500);
  });

  it('turn direction: yaw decreasing = right', () => {
    expect(turnFromYawDelta(-1)).toBe(1);
    expect(turnFromYawDelta(2)).toBe(-1);
    expect(turnFromYawDelta(0)).toBe(0);
  });

  it('keys from replay buttons', () => {
    const k = fillKeysFromButtons(createHudState().keys, IN_FORWARD | IN_MOVELEFT | IN_JUMP | IN_SPEED, 1);
    expect(k).toEqual({ forward: true, back: false, left: true, right: false, jump: true, duck: false, walk: true, turn: 1 });
    expect(fillKeysFromButtons(createHudState().keys, IN_BACK | IN_DUCK, 0)).toMatchObject({ back: true, duck: true, forward: false });
  });

  it('fills every field and keeps nested objects', () => {
    const h = createHudState();
    const keepTimer = h.timer;
    const keepKeys = h.keys;
    const timer = { ...emptyTimerHud(), state: 'running' as const, time: 12.5, stage: 2, stageCount: 6, mapType: 'staged' as const, pb: 80 };
    updateHudState(h, {
      visible: true,
      mapName: 'surf_x',
      tier: 3,
      origin: v3(1, 2, 3),
      velocity: v3(30, 40, 50),
      angles: { pitch: 10, yaw: 370, roll: 0 },
      onGround: true,
      timer,
      stats: { jumps: 4, strafes: 12, sync: 87.5 },
      keys: { forward: true, back: false, moveleft: false, moveright: true, jump: false, duck: true, speed: false },
      turn: -1,
      practice: true,
      noclip: false,
      spectating: null,
      now: 42,
    });
    expect(h.timer).toBe(keepTimer);
    expect(h.keys).toBe(keepKeys);
    expect(h).toMatchObject({
      visible: true,
      mapName: 'surf_x',
      tier: 3,
      speed: 50,
      origin: { x: 1, y: 2, z: 3 },
      onGround: true,
      jumps: 4,
      strafes: 12,
      sync: 87.5,
      practice: true,
      now: 42,
      keys: { forward: true, right: true, duck: true, turn: -1, left: false },
      timer: { state: 'running', time: 12.5, stage: 2, stageCount: 6, pb: 80 },
    });
    expect(h.angles.yaw).toBeCloseTo(10, 9);
    // null timer/stats -> disabled timer, zero stats; speed override
    updateHudState(h, {
      visible: false,
      mapName: '',
      tier: null,
      origin: v3(),
      velocity: v3(),
      angles: { pitch: 0, yaw: 0, roll: 0 },
      onGround: false,
      timer: null,
      stats: null,
      keys: null,
      buttons: IN_JUMP,
      turn: 0,
      practice: false,
      noclip: false,
      spectating: 'PB Replay',
      speed: 1234,
      now: 0,
    });
    expect(h.timer.state).toBe('disabled');
    expect(h.jumps).toBe(0);
    expect(h.keys.jump).toBe(true);
    expect(h.speed).toBe(1234);
    expect(h.spectating).toBe('PB Replay');
  });
});

describe('URL options', () => {
  it('parses map / builtin / bsp / autotest', () => {
    expect(parseUrlOptions('?map=surf_utopia_njv&autotest=1')).toEqual({ map: 'surf_utopia_njv', builtin: null, bsp: null, autotest: true });
    expect(parseUrlOptions('?builtin=intro')).toMatchObject({ builtin: 'intro', autotest: false });
    expect(parseUrlOptions('?bsp=%2F__maps%2Fsurf_kitsune.bsp&autotest=0')).toMatchObject({ bsp: '/__maps/surf_kitsune.bsp', autotest: false });
    expect(parseUrlOptions('')).toEqual({ map: null, builtin: null, bsp: null, autotest: false });
    expect(parseUrlOptions('?map=&autotest=true')).toEqual({ map: null, builtin: null, bsp: null, autotest: true });
  });
});

describe('debug API', () => {
  it('drives the game deterministically', async () => {
    const t = await loadedGame();
    const api = createDebugApi(t.game);
    let st = api.state();
    expect(st.state).toBe('playing');
    expect(st.mapName).toBe('surf_gamecore_test');
    expect(st.timer?.state).toBe('startzone');
    api.pause();
    api.setAngles(0, 90);
    api.press('forward');
    expect(api.runTicks(100)).toBe(100);
    api.release('+forward');
    st = api.state();
    expect(st.state).toBe('paused');
    expect(st.origin!.y).toBeGreaterThan(150); // facing +y
    expect(Math.abs(st.origin!.x)).toBeLessThan(1e-6);
    expect(st.speed).toBeCloseTo(250, 0);
    expect(st.tick).toBeGreaterThanOrEqual(100);
    api.teleport(100, 100, 50);
    st = api.state();
    expect(st.origin).toMatchObject({ x: 100, y: 100 });
    expect(st.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(api.exec('echo hi; echo there')).toEqual(['hi', 'there']);
    api.press('jump');
    api.releaseAll();
    expect(t.game.input.isDown('jump')).toBe(false);
    api.say('/noclip');
    expect(api.state().moveType).toBe(8);
    const st2 = await api.loadBuiltin('test');
    expect(st2.state).toBe('playing');
    // JSON-serializable (Playwright evaluate)
    expect(JSON.parse(JSON.stringify(api.state())).mapName).toBe('surf_gamecore_test');
  });
});
