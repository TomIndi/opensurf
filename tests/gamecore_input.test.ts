import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { qa } from '../src/core/angles';
import { console_, cvar, execute } from '../src/core/cvars';
import { BindTable } from '../src/game/binds';
import { registerConvars } from '../src/game/convars';
import {
  InputState,
  KButton,
  KeyDispatcher,
  MouseSettings,
  PITCH_LIMIT,
  applyMouseDelta,
  clampPitch,
  lerpAngles,
  readMouseSettings,
  registerButtonCommands,
} from '../src/game/input';
import {
  IN_ATTACK,
  IN_BACK,
  IN_DUCK,
  IN_FORWARD,
  IN_JUMP,
  IN_LEFT,
  IN_MOVELEFT,
  IN_MOVERIGHT,
  IN_SCORE,
  IN_SPEED,
  IN_USE,
  newUserCmd,
} from '../src/physics/playertypes';

let input: InputState;

beforeAll(() => {
  registerConvars();
});
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
});

function fresh(): InputState {
  input = new InputState();
  registerButtonCommands(input);
  return input;
}

function cmdOf(inp: InputState, noclip = false) {
  return inp.buildCmd(newUserCmd(), inp.view, { noclip });
}

const CSGO: MouseSettings = { sensitivity: 2.5, yaw: 0.022, pitch: 0.022, customAccel: 0, accelScale: 0.04, accelMax: 0, accelExponent: 1.05 };

describe('KButton (Source kbutton semantics)', () => {
  it('stays down while any key holds it', () => {
    const b = new KButton('forward', IN_FORWARD);
    b.press('w');
    b.press('uparrow');
    expect(b.down).toBe(true);
    expect(b.holders).toBe(2);
    b.release('w');
    expect(b.down).toBe(true); // the second key still holds +forward
    b.release('uparrow');
    expect(b.down).toBe(false);
  });

  it('ignores auto-repeat and releases from keys that never pressed it', () => {
    const b = new KButton('jump', IN_JUMP);
    b.press('space');
    b.press('space');
    expect(b.holders).toBe(1);
    b.release('mouse1');
    expect(b.down).toBe(true);
    b.release('space');
    expect(b.down).toBe(false);
  });

  it('console +cmd holds until a key-less -cmd, which clears every holder', () => {
    const b = new KButton('forward', IN_FORWARD);
    b.press();
    b.press('w');
    b.release('w');
    expect(b.down).toBe(true);
    b.press('w');
    b.release();
    expect(b.down).toBe(false);
    expect(b.holders).toBe(0);
  });

  it('latches a press impulse until the next usercmd (taps shorter than a tick count)', () => {
    const b = new KButton('jump', IN_JUMP);
    b.press('space');
    b.release('space');
    expect(b.down).toBe(false);
    expect(b.active).toBe(true);
    expect(b.state).toBe(0);
    b.clearImpulses();
    expect(b.active).toBe(false);
  });

  it('reports transitions once', () => {
    const b = new KButton('showscores', IN_SCORE);
    const seen: boolean[] = [];
    b.onChange = (d) => seen.push(d);
    b.press('tab');
    b.press('f1');
    b.release('tab');
    b.release('f1');
    b.press('tab');
    b.reset();
    expect(seen).toEqual([true, false, true, false]);
  });
});

describe('+/- console commands', () => {
  it('drive the buttons', () => {
    const inp = fresh();
    execute('+forward');
    expect(inp.isDown('forward')).toBe(true);
    execute('-forward');
    expect(inp.isDown('forward')).toBe(false);
    execute('+moveleft a; +moveleft leftarrow; -moveleft a');
    expect(inp.isDown('moveleft')).toBe(true);
    execute('-moveleft leftarrow');
    expect(inp.isDown('moveleft')).toBe(false);
    execute('+score');
    expect(inp.isDown('showscores')).toBe(true);
    execute('-showscores');
    expect(inp.isDown('showscores')).toBe(false);
  });
});

describe('KeyDispatcher (binds with +/- semantics)', () => {
  function setup(table: Record<string, string>) {
    const inp = fresh();
    const t = new BindTable(table);
    const d = new KeyDispatcher(t);
    return { inp, t, d };
  }

  it('two keys bound to +forward do not release each other', () => {
    const { inp, d } = setup({ w: '+forward', uparrow: '+forward' });
    expect(d.keyDown('w')).toBe(true);
    expect(d.keyDown('uparrow')).toBe(true);
    d.keyUp('w');
    expect(inp.isDown('forward')).toBe(true);
    d.keyUp('uparrow');
    expect(inp.isDown('forward')).toBe(false);
  });

  it('unbound keys report false; key repeat is harmless', () => {
    const { inp, d } = setup({ space: '+jump' });
    expect(d.keyDown('k')).toBe(false);
    d.keyDown('space');
    d.keyDown('space');
    d.keyUp('space');
    expect(inp.isDown('jump')).toBe(false);
  });

  it('runs non-+ commands once on press and nothing on release', () => {
    const { d } = setup({ k: 'fov_desired 100' });
    d.keyDown('k');
    d.keyUp('k');
    expect(cvar('fov_desired').num).toBe(100);
  });

  it('handles several +commands in one bind', () => {
    const { inp, d } = setup({ space: '+jump; +duck' });
    d.keyDown('space');
    expect(inp.isDown('jump')).toBe(true);
    expect(inp.isDown('duck')).toBe(true);
    d.keyUp('space');
    expect(inp.isDown('jump')).toBe(false);
    expect(inp.isDown('duck')).toBe(false);
  });

  it('a key rebound while held releases what it pressed', () => {
    const { inp, t, d } = setup({ w: '+forward' });
    d.keyDown('w');
    t.set('w', '+back');
    d.keyUp('w');
    expect(inp.isDown('forward')).toBe(false);
    expect(inp.isDown('back')).toBe(false);
  });

  it('+aliases get their -twin on release', () => {
    const { inp, d } = setup({ mouse5: '+jt' });
    console_.setAlias('+jt', '+jump; +duck');
    console_.setAlias('-jt', '-jump; -duck');
    d.keyDown('mouse5');
    expect(inp.isDown('jump') && inp.isDown('duck')).toBe(true);
    d.keyUp('mouse5');
    expect(inp.isDown('jump') || inp.isDown('duck')).toBe(false);
  });

  it('mouse wheel taps: +jump now, -jump after the next tick (bhop scroll)', () => {
    const { inp, d } = setup({ mwheeldown: '+jump', space: '+jump' });
    d.tap('mwheeldown');
    d.tap('mwheeldown'); // a second notch before the tick: still one press
    expect(inp.isDown('jump')).toBe(true);
    let cmd = cmdOf(inp);
    expect(cmd.buttons & IN_JUMP).toBeTruthy();
    d.afterTick();
    expect(inp.isDown('jump')).toBe(false);
    cmd = cmdOf(inp);
    expect(cmd.buttons & IN_JUMP).toBe(0);
    // a held space survives a wheel release
    d.keyDown('space');
    d.tap('mwheeldown');
    cmdOf(inp);
    d.afterTick();
    expect(inp.isDown('jump')).toBe(true);
    expect(d.hasPendingTaps).toBe(false);
  });

  it('a tap released before any tick still sets the button for one usercmd', () => {
    const { inp, d } = setup({ space: '+jump' });
    d.keyDown('space');
    d.keyUp('space');
    expect(cmdOf(inp).buttons & IN_JUMP).toBeTruthy();
    expect(cmdOf(inp).buttons & IN_JUMP).toBe(0);
  });

  it('releaseAll lets go of everything', () => {
    const { inp, d } = setup({ w: '+forward', a: '+moveleft', mwheelup: '+jump' });
    d.keyDown('w');
    d.keyDown('a');
    d.tap('mwheelup');
    d.releaseAll();
    expect(inp.isDown('forward') || inp.isDown('moveleft') || inp.isDown('jump')).toBe(false);
    expect(d.isHeld('w')).toBe(false);
  });
});

describe('mouse -> view angles', () => {
  it('100 counts at sensitivity 2.5 and m_yaw 0.022 turn 5.5 degrees', () => {
    const a = qa();
    const dyaw = applyMouseDelta(a, 100, 0, CSGO);
    expect(a.yaw).toBeCloseTo(-5.5, 10); // moving the mouse right turns right (yaw decreases)
    expect(dyaw).toBeCloseTo(-5.5, 10);
    applyMouseDelta(a, 0, 100, CSGO);
    expect(a.pitch).toBeCloseTo(5.5, 10); // mouse down looks down
    applyMouseDelta(a, -200, -100, CSGO);
    expect(a.yaw).toBeCloseTo(5.5, 10);
    expect(a.pitch).toBeCloseTo(0, 10);
  });

  it('reads the cvars', () => {
    cvar('sensitivity').set(1.2);
    cvar('m_yaw').set(0.0165);
    cvar('m_pitch').set(-0.022);
    const s = readMouseSettings();
    expect(s.sensitivity).toBe(1.2);
    expect(s.yaw).toBe(0.0165);
    const a = qa();
    applyMouseDelta(a, 1000, 10, s);
    expect(a.yaw).toBeCloseTo(-1000 * 1.2 * 0.0165, 9);
    expect(a.pitch).toBeCloseTo(-10 * 1.2 * 0.022, 9); // inverted
  });

  it('clamps pitch to ±89 and ignores non-finite deltas', () => {
    const a = qa();
    applyMouseDelta(a, 0, 100000, CSGO);
    expect(a.pitch).toBe(PITCH_LIMIT);
    applyMouseDelta(a, 0, -100000, CSGO);
    expect(a.pitch).toBe(-PITCH_LIMIT);
    expect(applyMouseDelta(a, NaN, 3, CSGO)).toBe(0);
    expect(a.yaw).toBe(0);
    expect(clampPitch(NaN)).toBe(0);
  });

  it('m_customaccel 1 grows the sensitivity with the movement; 2 rescales by m_yaw/m_pitch', () => {
    const accel: MouseSettings = { ...CSGO, customAccel: 1 };
    const a = qa();
    applyMouseDelta(a, 100, 0, accel);
    const k = Math.pow(100, 1.05) * 0.04 + 2.5;
    expect(a.yaw).toBeCloseTo(-100 * k * 0.022, 9);
    const capped = qa();
    applyMouseDelta(capped, 100, 0, { ...accel, accelMax: 3 });
    expect(capped.yaw).toBeCloseTo(-100 * 3 * 0.022, 9);
    const two = qa();
    applyMouseDelta(two, 100, 0, { ...CSGO, customAccel: 2 });
    expect(two.yaw).toBeCloseTo(-100 * k * 0.022 * 0.022, 12);
  });

  it('lerps angles', () => {
    const out = qa();
    lerpAngles(out, qa(0, 170, 0), qa(10, 200, 0), 0.5);
    expect(out).toEqual({ pitch: 5, yaw: 185, roll: 0 });
  });
});

describe('InputState frames and ticks', () => {
  it('applies the mouse at frame start and interpolates the frame\'s ticks', () => {
    const inp = fresh();
    inp.setAngles(0, 10);
    inp.addMouse(-200, 0); // 11 degrees left
    inp.beginFrame(1 / 60, CSGO);
    expect(inp.frameStart.yaw).toBe(10);
    expect(inp.view.yaw).toBeCloseTo(21, 9);
    const t = qa();
    const yaws = [1, 2, 3, 4].map((i) => inp.tickAngles(t, i, 4).yaw);
    expect(yaws.map((y) => +y.toFixed(6))).toEqual([12.75, 15.5, 18.25, 21]);
    expect(inp.turn).toBe(-1); // turning left
  });

  it('wraps yaw at frame end without a jump between the frame ends', () => {
    const inp = fresh();
    inp.setAngles(0, 175);
    inp.addMouse(-500, 0); // +27.5 degrees -> 202.5 (continuous)
    inp.beginFrame(0.01, CSGO);
    expect(inp.view.yaw).toBeCloseTo(202.5, 9);
    const mid = inp.tickAngles(qa(), 1, 2).yaw;
    expect(mid).toBeCloseTo(188.75, 9); // no wrap mid-frame: smooth interpolation
    inp.endFrame();
    expect(inp.view.yaw).toBeCloseTo(-157.5, 9);
    expect(inp.frameStart.yaw).toBeCloseTo(175 - 360, 9);
  });

  it('keeps the turn direction briefly for showkeys, then clears it', () => {
    const inp = fresh();
    inp.addMouse(10, 0);
    inp.beginFrame(0.01, CSGO);
    expect(inp.turn).toBe(1);
    inp.beginFrame(0.01, CSGO);
    expect(inp.turn).toBe(1); // held for ~50 ms
    for (let i = 0; i < 10; i++) inp.beginFrame(0.01, CSGO);
    expect(inp.turn).toBe(0);
  });

  it('ignores the mouse when given no settings (spectating) and discards pending movement', () => {
    const inp = fresh();
    inp.addMouse(100, 100);
    inp.beginFrame(0.01, null);
    expect(inp.view.yaw).toBe(0);
    inp.addMouse(100, 0);
    inp.discardMouse();
    inp.beginFrame(0.01, CSGO);
    expect(inp.view.yaw).toBe(0);
  });

  it('m_filter averages this frame with the last one', () => {
    const inp = fresh();
    inp.addMouse(100, 0);
    inp.beginFrame(0.01, CSGO, true);
    expect(inp.view.yaw).toBeCloseTo(-2.75, 9);
    inp.beginFrame(0.01, CSGO, true);
    expect(inp.view.yaw).toBeCloseTo(-5.5, 9);
  });

  it('+left / +right turn at cl_yawspeed, scaled by cl_anglespeedkey with +speed', () => {
    const inp = fresh();
    execute('+left');
    inp.beginFrame(0.5, null);
    expect(inp.view.yaw).toBeCloseTo(105, 9);
    execute('+speed');
    inp.beginFrame(0.5, null);
    expect(inp.view.yaw).toBeCloseTo(105 + 105 * 0.67, 9);
    execute('-left; -speed; +right');
    inp.beginFrame(1, null);
    expect(inp.view.yaw).toBeCloseTo(105 + 70.35 - 210, 9);
    execute('-right; +lookdown');
    inp.beginFrame(1, null);
    expect(inp.view.pitch).toBe(89);
    execute('-lookdown');
  });
});

describe('usercmd', () => {
  it('forward/side/up moves follow cl_*speed and the held buttons', () => {
    const inp = fresh();
    execute('+forward');
    let c = cmdOf(inp);
    expect(c.forwardmove).toBe(450);
    expect(c.buttons & IN_FORWARD).toBeTruthy();
    execute('+back');
    c = cmdOf(inp);
    expect(c.forwardmove).toBe(0);
    expect(c.buttons & (IN_FORWARD | IN_BACK)).toBe(IN_FORWARD | IN_BACK);
    execute('-forward');
    expect(cmdOf(inp).forwardmove).toBe(-450);
    execute('-back; +moveright');
    c = cmdOf(inp);
    expect(c.sidemove).toBe(450);
    expect(c.buttons & IN_MOVERIGHT).toBeTruthy();
    execute('+moveleft');
    c = cmdOf(inp);
    expect(c.sidemove).toBe(0);
    execute('-moveright');
    c = cmdOf(inp);
    expect(c.sidemove).toBe(-450);
    expect(c.buttons & IN_MOVELEFT).toBeTruthy();
    execute('-moveleft');
    cvar('cl_forwardspeed').set(300);
    cvar('cl_backspeed').set(200);
    execute('+forward');
    expect(cmdOf(inp).forwardmove).toBe(300);
    execute('-forward; +back');
    expect(cmdOf(inp).forwardmove).toBe(-200);
    execute('-back');
  });

  it('upmove: +moveup/+movedown always, +jump/+duck only in noclip', () => {
    const inp = fresh();
    execute('+jump');
    expect(cmdOf(inp).upmove).toBe(0);
    expect(cmdOf(inp, true).upmove).toBe(320);
    execute('-jump; +duck');
    expect(cmdOf(inp, true).upmove).toBe(-320);
    execute('-duck; +moveup');
    expect(cmdOf(inp).upmove).toBe(320);
    execute('-moveup');
  });

  it('sets the button bits', () => {
    const inp = fresh();
    execute('+jump; +duck; +speed; +use; +attack; +left; +showscores');
    const c = cmdOf(inp);
    for (const bit of [IN_JUMP, IN_DUCK, IN_SPEED, IN_USE, IN_ATTACK, IN_LEFT, IN_SCORE]) expect(c.buttons & bit).toBeTruthy();
    execute('-jump; -duck; -speed; -use; -attack; -left; -showscores');
    expect(cmdOf(inp).buttons).toBe(0);
  });

  it('copies normalized view angles', () => {
    const inp = fresh();
    const c = inp.buildCmd(newUserCmd(), { pitch: 95, yaw: 370, roll: 0 }, { noclip: false });
    expect(c.viewangles.pitch).toBe(89);
    expect(c.viewangles.yaw).toBeCloseTo(10, 9);
    const d = inp.buildCmd(newUserCmd(), { pitch: -5, yaw: -190, roll: 0 }, { noclip: false });
    expect(d.viewangles.yaw).toBeCloseTo(170, 9);
  });
});
