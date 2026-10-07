// InputDevice against a minimal fake DOM (node has no KeyboardEvent/MouseEvent): listeners are recorded per
// target and events are plain objects dispatched target -> window, honouring stopPropagation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_, execute } from '../src/core/cvars';
import { registerConvars } from '../src/game/convars';
import { InputDevice } from '../src/game/input';
import { TestGame, loadedGame, resetGlobals } from './gamecore_helpers';

type Listener = { fn: (e: unknown) => void; capture: boolean };

class FakeTarget {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: (e: unknown) => void, opts?: boolean | AddEventListenerOptions): void {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (e: unknown) => void, opts?: boolean | AddEventListenerOptions): void {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this.listeners.get(type) ?? [];
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  count(): number {
    let n = 0;
    for (const l of this.listeners.values()) n += l.length;
    return n;
  }
}

interface FakeEvent {
  type: string;
  code?: string;
  repeat?: boolean;
  button?: number;
  deltaY?: number;
  movementX?: number;
  movementY?: number;
  target?: unknown;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function ev(type: string, props: Partial<FakeEvent> = {}): FakeEvent {
  return {
    type,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...props,
  };
}

class FakeCanvas extends FakeTarget {
  lockRequests: unknown[] = [];
  rejectRaw = false;
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  requestPointerLock(opts?: { unadjustedMovement?: boolean }): Promise<void> {
    this.lockRequests.push(opts ?? null);
    if (opts?.unadjustedMovement && this.rejectRaw) return Promise.reject(new Error('NotSupportedError'));
    return Promise.resolve();
  }
}

class FakeDocument extends FakeTarget {
  pointerLockElement: unknown = null;
}

let win: FakeTarget;
let doc: FakeDocument;
let canvas: FakeCanvas;
let t: TestGame;
let device: InputDevice;
let pauses = 0;
let escapes = 0;
let consoles = 0;
const g = globalThis as Record<string, unknown>;

/** Dispatches on `target` (target phase) then on window (capture listeners first), like a bubbling event. */
function dispatch(target: FakeTarget, e: FakeEvent): FakeEvent {
  e.target = e.target ?? target;
  const run = (tg: FakeTarget, capture: boolean | null) => {
    for (const l of [...(tg.listeners.get(e.type) ?? [])]) if (capture === null || l.capture === capture) l.fn(e);
  };
  run(win, true);
  if (target !== win) run(target, null);
  if (!e.propagationStopped) run(win, false);
  return e;
}

function key(type: 'keydown' | 'keyup', code: string, repeat = false): FakeEvent {
  return dispatch(win, ev(type, { code, repeat }));
}

function setLocked(locked: boolean): void {
  doc.pointerLockElement = locked ? canvas : null;
  for (const l of doc.listeners.get('pointerlockchange') ?? []) l.fn(ev('pointerlockchange'));
}

function makeDevice(autotest = false): InputDevice {
  const d = new InputDevice({
    canvas: canvas as unknown as HTMLCanvasElement,
    ui: t.ui,
    state: t.game.input,
    dispatcher: t.game.dispatcher,
    isPlaying: () => t.game.state === 'playing',
    onPointerLockLost: () => {
      pauses++;
      t.game.pause();
    },
    onEscape: () => escapes++,
    onToggleConsole: () => consoles++,
    autotest,
  });
  d.attach();
  return d;
}

beforeEach(async () => {
  registerConvars();
  resetGlobals();
  win = new FakeTarget();
  doc = new FakeDocument();
  canvas = new FakeCanvas(doc);
  g.window = win;
  g.document = doc;
  pauses = escapes = consoles = 0;
  t = await loadedGame();
  execute('binddefaults');
  device = makeDevice();
});

afterEach(() => {
  device.detach();
  delete g.window;
  delete g.document;
  for (const c of console_.allCvars()) c.reset();
  t.game.disconnect();
});

describe('keyboard', () => {
  it('runs binds while playing and releases on keyup', () => {
    const e = key('keydown', 'KeyW');
    expect(e.defaultPrevented).toBe(true);
    expect(t.game.input.isDown('forward')).toBe(true);
    key('keydown', 'ArrowUp'); // unbound by default
    key('keyup', 'KeyW');
    expect(t.game.input.isDown('forward')).toBe(false);
  });

  it('two keys on +forward (Source semantics through the DOM)', () => {
    execute('bind uparrow +forward');
    key('keydown', 'KeyW');
    key('keydown', 'ArrowUp');
    key('keyup', 'KeyW');
    expect(t.game.input.isDown('forward')).toBe(true);
    key('keyup', 'ArrowUp');
    expect(t.game.input.isDown('forward')).toBe(false);
  });

  it('left and right modifiers share a bind', () => {
    key('keydown', 'ControlRight');
    expect(t.game.input.isDown('duck')).toBe(true);
    key('keyup', 'ControlRight');
    key('keydown', 'ShiftLeft');
    expect(t.game.input.isDown('speed')).toBe(true);
    key('keyup', 'ShiftLeft');
  });

  it('ignores keys while typing, but still releases held keys', () => {
    key('keydown', 'KeyA');
    t.ui.typing = true;
    const e = key('keydown', 'KeyD');
    expect(e.defaultPrevented).toBe(false);
    expect(t.game.input.isDown('moveright')).toBe(false);
    key('keyup', 'KeyA');
    expect(t.game.input.isDown('moveleft')).toBe(false);
  });

  it('ignores keys outside of playing (menus, pause)', () => {
    t.game.pause();
    key('keydown', 'KeyW');
    expect(t.game.input.isDown('forward')).toBe(false);
  });

  it('auto-repeat: consumed for held keys, ignored otherwise', () => {
    key('keydown', 'KeyW');
    const r = key('keydown', 'KeyW', true);
    expect(r.defaultPrevented).toBe(true);
    key('keyup', 'KeyW');
    const r2 = key('keydown', 'KeyS', true); // held since before we started listening
    expect(r2.defaultPrevented).toBe(false);
    expect(t.game.input.isDown('back')).toBe(false);
  });

  it('non-+ binds run once per press (r -> say !r)', () => {
    const s = t.game.session!;
    t.game.teleportPlayer({ x: 700, y: 0, z: 0 }, null, null);
    key('keydown', 'KeyR');
    key('keyup', 'KeyR');
    expect(Math.abs(s.player.origin.x)).toBeLessThan(1);
  });

  it('escape runs cancelselect (pause); unbound escape / ` still work', () => {
    key('keydown', 'Escape');
    expect(t.game.state).toBe('paused');
    t.game.resume();
    execute('unbind escape; unbind `');
    key('keydown', 'Escape');
    expect(escapes).toBe(1);
    key('keydown', 'Backquote');
    expect(consoles).toBe(1);
    execute('binddefaults');
    key('keydown', 'Backquote');
    expect(t.ui.consoleToggles).toBe(1); // the toggleconsole bind
  });

  it('window blur releases everything', () => {
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    for (const l of win.listeners.get('blur') ?? []) l.fn(ev('blur'));
    expect(t.game.input.isDown('forward') || t.game.input.isDown('jump')).toBe(false);
  });
});

describe('mouse and pointer lock', () => {
  it('a canvas click requests a raw pointer lock (falls back to a plain one)', async () => {
    const e = dispatch(canvas, ev('mousedown', { button: 0 }));
    expect(e.propagationStopped).toBe(true); // the UI's window handler must not request a second lock
    expect(canvas.lockRequests).toEqual([{ unadjustedMovement: true }]);
    await Promise.resolve();
    await Promise.resolve();
    canvas.lockRequests.length = 0;
    canvas.rejectRaw = true;
    dispatch(canvas, ev('mousedown', { button: 0 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(canvas.lockRequests).toEqual([{ unadjustedMovement: true }, null]);
  });

  it('m_rawinput 0 asks for a plain lock', () => {
    execute('m_rawinput 0');
    dispatch(canvas, ev('mousedown', { button: 0 }));
    expect(canvas.lockRequests).toEqual([null]);
  });

  it('mouse movement turns the view only while locked', () => {
    dispatch(doc as unknown as FakeTarget, ev('mousemove', { movementX: 100, movementY: 0 }));
    t.game.input.beginFrame(0.01, { sensitivity: 2.5, yaw: 0.022, pitch: 0.022, customAccel: 0, accelScale: 0, accelMax: 0, accelExponent: 1 });
    const yaw0 = t.game.input.view.yaw;
    setLocked(true);
    for (const l of doc.listeners.get('mousemove') ?? []) l.fn(ev('mousemove', { movementX: 100, movementY: 0 }));
    t.game.input.beginFrame(0.01, { sensitivity: 2.5, yaw: 0.022, pitch: 0.022, customAccel: 0, accelScale: 0, accelMax: 0, accelExponent: 1 });
    expect(t.game.input.view.yaw - yaw0).toBeCloseTo(-5.5, 9);
  });

  it('mouse buttons and the wheel run binds while locked', () => {
    const s = t.game.session!;
    dispatch(canvas, ev('mousedown', { button: 3 })); // not locked yet: nothing
    expect(s.savelocs).toHaveLength(0);
    setLocked(true);
    const e = dispatch(canvas, ev('mousedown', { button: 3 })); // mouse4 -> say !saveloc
    expect(e.defaultPrevented).toBe(true);
    dispatch(win, ev('mouseup', { button: 3 }));
    expect(s.savelocs).toHaveLength(1);
    const w = dispatch(win, ev('wheel', { deltaY: 100 }));
    expect(w.defaultPrevented).toBe(true);
    expect(t.game.input.isDown('jump')).toBe(true);
    t.game.runTicks(1);
    expect(t.game.input.isDown('jump')).toBe(false); // released after the tick
    expect(s.player.velocity.z).toBeGreaterThan(200); // the scroll jumped
  });

  it('losing the pointer lock pauses, unless the console/chat took it', () => {
    setLocked(true);
    t.ui.typing = true;
    setLocked(false);
    expect(pauses).toBe(0);
    expect(t.game.state).toBe('playing');
    t.ui.typing = false;
    setLocked(true);
    setLocked(false);
    expect(pauses).toBe(1);
    expect(t.game.state).toBe('paused');
  });

  it('autotest: no lock needed for mouse buttons/wheel, never pauses', () => {
    device.detach();
    device = makeDevice(true);
    dispatch(canvas, ev('mousedown', { button: 0 }));
    expect(canvas.lockRequests).toHaveLength(0);
    dispatch(win, ev('wheel', { deltaY: -5, target: canvas }));
    expect(t.game.input.isDown('jump')).toBe(true);
    setLocked(true);
    setLocked(false);
    expect(t.game.state).toBe('playing');
  });

  it('side buttons never navigate away while playing', () => {
    setLocked(true);
    const up = dispatch(win, ev('mouseup', { button: 3 }));
    expect(up.defaultPrevented).toBe(true);
    const aux = dispatch(win, ev('auxclick', { button: 4 }));
    expect(aux.defaultPrevented).toBe(true);
    t.game.pause();
    expect(dispatch(win, ev('auxclick', { button: 4 })).defaultPrevented).toBe(false); // menus: normal browser
  });

  it('fullscreen locks the keyboard (Ctrl+W reaches the game), except Escape', () => {
    const calls: unknown[] = [];
    let unlocks = 0;
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { keyboard: { lock: (codes?: string[]) => (calls.push(codes), Promise.resolve()), unlock: () => unlocks++ } },
    });
    try {
      (doc as unknown as { fullscreenElement: unknown }).fullscreenElement = canvas;
      for (const l of doc.listeners.get('fullscreenchange') ?? []) l.fn(ev('fullscreenchange'));
      expect(calls).toHaveLength(1);
      const codes = calls[0] as string[];
      expect(codes).toContain('KeyW');
      expect(codes).toContain('ControlLeft');
      expect(codes).toContain('Tab');
      expect(codes).not.toContain('Escape');
      (doc as unknown as { fullscreenElement: unknown }).fullscreenElement = null;
      for (const l of doc.listeners.get('fullscreenchange') ?? []) l.fn(ev('fullscreenchange'));
      expect(unlocks).toBe(1);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'navigator', desc);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it('detach removes every listener', () => {
    expect(win.count() + doc.count() + canvas.count()).toBeGreaterThan(5);
    device.detach();
    expect(win.count() + doc.count() + canvas.count()).toBe(0);
  });
});
