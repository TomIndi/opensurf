// Player input, CS:GO style.
//
//  - Buttons are Source "kbuttons": +forward/-forward etc. A key bound to "+forward" runs `+forward <key>` on
//    press and `-forward <key>` on release; the button stays down while ANY key holds it (two keys bound to
//    +forward don't release each other). Typed at the console without a key, `+forward` holds until `-forward`.
//    A press also latches an "impulse" so a tap shorter than a tick still sets the button bit in the next
//    usercmd (this is what makes mouse-wheel jumping work: the wheel presses and releases +jump at once).
//  - Mouse: yaw -= dx · sensitivity · m_yaw, pitch += dy · sensitivity · m_pitch, pitch clamped to ±89, applied
//    every rendered frame (optional m_customaccel 1/2 and m_filter like Source). +left/+right/+lookup/+lookdown
//    turn at cl_yawspeed/cl_pitchspeed (× cl_anglespeedkey while +speed is held).
//  - The usercmd of each tick: forwardmove = cl_forwardspeed·(+forward) − cl_backspeed·(+back),
//    sidemove = cl_sidespeed·(+moveright − +moveleft), upmove = cl_upspeed·(+moveup − +movedown) (plus
//    +jump/+duck in noclip), button bits, view angles. Each (+button) is Source's KeyState amount: 1 held,
//    0.5 on the first tick after a press in the same frame, 0.25 for a tap that began and ended within that
//    frame (see KButton.keyState).
//  - DOM: pointer lock on canvas click (raw input when supported), keys/mouse buttons/wheel run their binds while
//    playing (ignored while the console/chat has focus), losing the pointer lock pauses the game. Whether the lock
//    got raw input (unadjustedMovement) is kept in InputDevice.rawInputActive; the first time a browser only gives
//    a plain lock, the console says so once, with the OS settings that keep sensitivity CS:GO-identical.
import { QAngle, normalizeAngle, qa } from '../core/angles';
import { conPrint, console_, registerCommand, tokenizeCommandLine } from '../core/cvars';
import {
  IN_ATTACK,
  IN_ATTACK2,
  IN_BACK,
  IN_DUCK,
  IN_FORWARD,
  IN_JUMP,
  IN_LEFT,
  IN_MOVELEFT,
  IN_MOVERIGHT,
  IN_RELOAD,
  IN_RIGHT,
  IN_SCORE,
  IN_SPEED,
  IN_USE,
  UserCmd,
} from '../physics/playertypes';
import type { UiApi } from './api';
import {
  BindTable,
  KEY_NAMES,
  binds as globalBinds,
  codeToKeyName,
  keyNameToCodes,
  mouseButtonToKeyName,
  wheelToKeyName,
} from './binds';

// ------------------------------------------------------------------------------------------ kbuttons

/** A Source kbutton: held by any number of keys (or "manually" from the console) plus edge impulses. */
export class KButton {
  readonly name: string;
  /** IN_* bit set in the usercmd while held (0 for view-only buttons like +left). */
  readonly bit: number;
  private readonly keys = new Set<string>();
  private manual = false;
  /** Pressed since the last usercmd was built. */
  impulseDown = false;
  /** Released since the last usercmd was built. */
  impulseUp = false;
  /**
   * Source kbutton impulse bits for the movement amount (KeyState): pressed / released since the last KeyState
   * read. Unlike the button-bit latch above they also expire at the end of every rendered frame (Source reads
   * KeyState every frame for its extra mouse sample), see keyState().
   */
  private moveImpulseDown = false;
  private moveImpulseUp = false;
  /** Called on down/up transitions. */
  onChange: ((down: boolean) => void) | null = null;

  constructor(name: string, bit: number) {
    this.name = name;
    this.bit = bit;
  }

  get down(): boolean {
    return this.manual || this.keys.size > 0;
  }

  /** Number of keys holding the button (tests / debugging). */
  get holders(): number {
    return this.keys.size + (this.manual ? 1 : 0);
  }

  /** `+cmd [key]`. Without a key (typed at the console) the button is held until a `-cmd` without key. */
  press(key?: string): void {
    const was = this.down;
    if (key === undefined || key === '') this.manual = true;
    else {
      if (this.keys.has(key)) return; // auto-repeat of a key already holding it
      this.keys.add(key);
    }
    if (!was) {
      this.impulseDown = true;
      this.moveImpulseDown = true;
      this.onChange?.(true);
    }
  }

  /**
   * `-cmd [key]`. With a key, only that key lets go (a release from a key that never pressed it is ignored,
   * like Source); without one (console) every holder is cleared.
   */
  release(key?: string): void {
    const was = this.down;
    if (key === undefined || key === '') {
      this.keys.clear();
      this.manual = false;
    } else if (!this.keys.delete(key)) return;
    if (was && !this.down) {
      this.impulseUp = true;
      this.moveImpulseUp = true;
      this.onChange?.(false);
    }
  }

  /** 1 while held, else 0 (keyboard turning, HUD). Movement amounts in usercmds come from keyState(). */
  get state(): number {
    return this.down ? 1 : 0;
  }

  /**
   * Source's KeyState: how much of the movement this button contributes to one usercmd, from whether it is held
   * and how it changed since the last read; then forgets those changes:
   *   held all along 1 · pressed and still held 0.5 · released 0 · pressed and released again 0.25 ·
   *   released and pressed again (held) 0.75.
   * So a tap shorter than a tick still strafes for one tick (at 0.25 · 450 = 112.5 the air wish speed is still
   * above the 30 u/s cap, i.e. a full-strength air strafe tick) instead of vanishing, and the first tick of a
   * press is a half one, like CS:GO. Impulses not read by a usercmd of the frame they happened in expire at the
   * frame's end (endFrame), as Source's per-frame extra mouse sample consumes them: at fps above the tickrate a
   * press in a frame without a tick reaches the next tick as "held all along".
   */
  keyState(): number {
    const down = this.down;
    const pressed = this.moveImpulseDown;
    const released = this.moveImpulseUp;
    this.moveImpulseDown = false;
    this.moveImpulseUp = false;
    if (pressed && released) return down ? 0.75 : 0.25;
    if (pressed) return down ? 0.5 : 0;
    if (released) return 0;
    return down ? 1 : 0;
  }

  /** Expires the KeyState impulses (end of a rendered frame). */
  clearMoveImpulses(): void {
    this.moveImpulseDown = false;
    this.moveImpulseUp = false;
  }

  /** Button bit for the next usercmd: held now, or pressed (even briefly) since the last usercmd. */
  get active(): boolean {
    return this.down || this.impulseDown;
  }

  clearImpulses(): void {
    this.impulseDown = false;
    this.impulseUp = false;
  }

  /** Lets go of everything (focus loss, pause). */
  reset(): void {
    const was = this.down;
    this.keys.clear();
    this.manual = false;
    this.impulseDown = false;
    this.impulseUp = false;
    this.moveImpulseDown = false;
    this.moveImpulseUp = false;
    if (was) this.onChange?.(false);
  }
}

export type ButtonName =
  | 'forward'
  | 'back'
  | 'moveleft'
  | 'moveright'
  | 'jump'
  | 'duck'
  | 'speed'
  | 'use'
  | 'attack'
  | 'attack2'
  | 'reload'
  | 'left'
  | 'right'
  | 'lookup'
  | 'lookdown'
  | 'moveup'
  | 'movedown'
  | 'showscores';

const BUTTON_BITS: Readonly<Record<ButtonName, number>> = {
  forward: IN_FORWARD,
  back: IN_BACK,
  moveleft: IN_MOVELEFT,
  moveright: IN_MOVERIGHT,
  jump: IN_JUMP,
  duck: IN_DUCK,
  speed: IN_SPEED,
  use: IN_USE,
  attack: IN_ATTACK,
  attack2: IN_ATTACK2,
  reload: IN_RELOAD,
  left: IN_LEFT,
  right: IN_RIGHT,
  lookup: 0,
  lookdown: 0,
  moveup: 0,
  movedown: 0,
  showscores: IN_SCORE,
};

export const BUTTON_NAMES = Object.keys(BUTTON_BITS) as ButtonName[];

/** Extra command names for buttons (`+score` is Source's other name for `+showscores`). */
const BUTTON_ALIASES: Readonly<Record<string, ButtonName>> = { score: 'showscores', walk: 'speed' };

// ------------------------------------------------------------------------------------------ mouse math

export interface MouseSettings {
  sensitivity: number;
  yaw: number;
  pitch: number;
  /** m_customaccel: 0 off, 1 on, 2 on + extra m_yaw/m_pitch scaling. */
  customAccel: number;
  accelScale: number;
  accelMax: number;
  accelExponent: number;
}

export const PITCH_LIMIT = 89;

function cvNum(name: string, fallback: number): number {
  const c = console_.getCvar(name);
  if (!c) return fallback;
  const n = parseFloat(c.value);
  return Number.isFinite(n) ? n : fallback;
}

export function readMouseSettings(): MouseSettings {
  return {
    sensitivity: cvNum('sensitivity', 2.5),
    yaw: cvNum('m_yaw', 0.022),
    pitch: cvNum('m_pitch', 0.022),
    customAccel: Math.trunc(cvNum('m_customaccel', 0)),
    accelScale: cvNum('m_customaccel_scale', 0.04),
    accelMax: cvNum('m_customaccel_max', 0),
    accelExponent: cvNum('m_customaccel_exponent', 1.05),
  };
}

/**
 * Turns raw mouse counts into view angle changes (degrees), like CS:GO:
 * yaw −= dx · sens · m_yaw, pitch += dy · sens · m_pitch. With m_customaccel the sensitivity grows with the
 * movement of this frame: sens' = |d|^exponent · scale + sens (capped by m_customaccel_max when > 0); mode 2
 * additionally scales the counts by m_yaw / m_pitch. Returns the yaw change (positive = left turn).
 */
export function applyMouseDelta(angles: QAngle, dx: number, dy: number, s: MouseSettings): number {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  let mx: number;
  let my: number;
  if (s.customAccel === 1 || s.customAccel === 2) {
    const dist = Math.sqrt(dx * dx + dy * dy);
    let k = Math.pow(dist, s.accelExponent) * s.accelScale + s.sensitivity;
    if (s.accelMax > 0.0001 && k > s.accelMax) k = s.accelMax;
    mx = dx * k;
    my = dy * k;
    if (s.customAccel === 2) {
      mx *= s.yaw;
      my *= s.pitch;
    }
  } else {
    mx = dx * s.sensitivity;
    my = dy * s.sensitivity;
  }
  const dyaw = -mx * s.yaw;
  angles.yaw += dyaw;
  angles.pitch = clampPitch(angles.pitch + my * s.pitch);
  return dyaw;
}

export function clampPitch(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return p > PITCH_LIMIT ? PITCH_LIMIT : p < -PITCH_LIMIT ? -PITCH_LIMIT : p;
}

/** Linear interpolation of view angles (yaw is continuous, so no wrap handling is needed). */
export function lerpAngles(out: QAngle, a: QAngle, b: QAngle, t: number): QAngle {
  out.pitch = a.pitch + (b.pitch - a.pitch) * t;
  out.yaw = a.yaw + (b.yaw - a.yaw) * t;
  out.roll = a.roll + (b.roll - a.roll) * t;
  return out;
}

/**
 * Where tick `i` (1-based) of the `n` ticks simulated in one frame falls inside that frame, as a fraction 0..1
 * of the frame's simulated span (`span` = frame dt · host_timescale). The fixed-tick accumulator keeps
 * `leftover` seconds after the frame's last tick, so tick i ends (n − i) · interval + leftover before the end of
 * the frame. Sampling the view (which moves linearly between two frames' mouse samples) at that fraction gives
 * every tick the turn of its own slice of time: a constant mouse speed turns the same angle on every tick at
 * any fps (60 fps at 100 tick would otherwise alternate 1.5° / 3° per tick, 144 fps 1.25° / 2.5°), which is
 * what CS:GO's per-frame mouse sampling converges to at the high fps surfers play at. Without a usable span or
 * interval the ticks are spread evenly (i / n).
 */
export function tickFraction(i: number, n: number, leftover = 0, interval = 0, span = 0): number {
  if (!(n > 0)) return 1;
  if (!(span > 0) || !(interval > 0) || !Number.isFinite(span) || !Number.isFinite(leftover)) return i / n;
  const w = 1 - (Math.max(0, leftover) + (n - i) * interval) / span;
  return w < 0 ? 0 : w > 1 ? 1 : w;
}

// ------------------------------------------------------------------------------------------ input state

/** How long the HUD keeps showing the last mouse turn direction (smooths frames without mouse samples). */
const TURN_HOLD_SECONDS = 0.05;

export interface CmdOptions {
  /** Noclip: +jump/+duck move up/down (cl_upspeed). */
  noclip: boolean;
}

/**
 * Buttons, view angles and usercmd building. No DOM: the InputDevice (or tests / the debug API) feed it.
 */
export class InputState {
  readonly buttons: Record<ButtonName, KButton>;
  /** Current view angles. Yaw is continuous within a frame (wrapped back into ±180 by endFrame). */
  readonly view: QAngle = qa();
  /** View angles at the start of the current frame: this frame's ticks interpolate from here to `view`. */
  readonly frameStart: QAngle = qa();
  /** Raw mouse counts accumulated since the last frame. */
  private mouseDx = 0;
  private mouseDy = 0;
  private lastFrameDx = 0;
  private lastFrameDy = 0;
  /** -1 left, 1 right, 0 none (HUD showkeys). */
  turn = 0;
  private turnHold = 0;

  constructor() {
    const b = {} as Record<ButtonName, KButton>;
    for (const n of BUTTON_NAMES) b[n] = new KButton(n, BUTTON_BITS[n]);
    this.buttons = b;
  }

  button(name: string): KButton | undefined {
    const n = name.toLowerCase();
    return (this.buttons as Record<string, KButton>)[n] ?? (BUTTON_ALIASES[n] ? this.buttons[BUTTON_ALIASES[n]] : undefined);
  }

  isDown(name: ButtonName): boolean {
    return this.buttons[name].down;
  }

  addMouse(dx: number, dy: number): void {
    if (Number.isFinite(dx)) this.mouseDx += dx;
    if (Number.isFinite(dy)) this.mouseDy += dy;
  }

  /** Throws away pending mouse movement (menus, pause). */
  discardMouse(): void {
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.lastFrameDx = 0;
    this.lastFrameDy = 0;
  }

  releaseAll(): void {
    for (const n of BUTTON_NAMES) this.buttons[n].reset();
  }

  /** Sets the view (teleports, setang): no interpolation from the old view. */
  setAngles(pitch: number, yaw: number, roll = 0): void {
    this.view.pitch = clampPitch(pitch);
    this.view.yaw = Number.isFinite(yaw) ? normalizeAngle(yaw) : 0;
    this.view.roll = Number.isFinite(roll) ? roll : 0;
    this.frameStart.pitch = this.view.pitch;
    this.frameStart.yaw = this.view.yaw;
    this.frameStart.roll = this.view.roll;
  }

  /**
   * Start of a rendered frame: remembers the frame's start angles, then applies the mouse movement since the
   * last frame and the keyboard turning for `dt` seconds. `mouse` null ignores the mouse (spectating).
   */
  beginFrame(dt: number, mouse: MouseSettings | null, filter = false): void {
    this.frameStart.pitch = this.view.pitch;
    this.frameStart.yaw = this.view.yaw;
    this.frameStart.roll = this.view.roll;
    let dx = this.mouseDx;
    let dy = this.mouseDy;
    this.mouseDx = 0;
    this.mouseDy = 0;
    const yaw0 = this.view.yaw;
    if (mouse) {
      if (filter) {
        const fx = (dx + this.lastFrameDx) * 0.5;
        const fy = (dy + this.lastFrameDy) * 0.5;
        this.lastFrameDx = dx;
        this.lastFrameDy = dy;
        dx = fx;
        dy = fy;
      } else {
        this.lastFrameDx = dx;
        this.lastFrameDy = dy;
      }
      if (dx !== 0 || dy !== 0) applyMouseDelta(this.view, dx, dy, mouse);
    }
    this.keyboardTurn(dt);
    const dyaw = this.view.yaw - yaw0;
    if (dyaw !== 0) {
      this.turn = dyaw < 0 ? 1 : -1;
      this.turnHold = TURN_HOLD_SECONDS;
    } else if (this.turnHold > 0) {
      this.turnHold -= dt;
      if (this.turnHold <= 0) this.turn = 0;
    } else this.turn = 0;
  }

  /** +left/+right (cl_yawspeed) and +lookup/+lookdown (cl_pitchspeed), scaled by cl_anglespeedkey with +speed. */
  keyboardTurn(dt: number): void {
    const b = this.buttons;
    const turning = b.left.down || b.right.down || b.lookup.down || b.lookdown.down;
    if (!turning || !(dt > 0)) return;
    let speed = dt;
    if (b.speed.down) speed *= cvNum('cl_anglespeedkey', 0.67);
    const yawSpeed = cvNum('cl_yawspeed', 210);
    const pitchSpeed = cvNum('cl_pitchspeed', 225);
    this.view.yaw += speed * yawSpeed * (b.left.state - b.right.state);
    this.view.pitch = clampPitch(this.view.pitch + speed * pitchSpeed * (b.lookdown.state - b.lookup.state));
  }

  /**
   * View angles for tick `i` (1-based) of the `n` ticks simulated in this frame: the view interpolated from the
   * frame start to now at the tick's own simulated time (see tickFraction; without timing, evenly by i/n).
   */
  tickAngles(out: QAngle, i: number, n: number, leftover = 0, interval = 0, span = 0): QAngle {
    return lerpAngles(out, this.frameStart, this.view, tickFraction(i, n, leftover, interval, span));
  }

  /**
   * End of a frame: expires the movement-key impulses no usercmd of this frame consumed (see KButton.keyState) and
   * wraps the continuous yaw back into ±180 (both endpoints, so nothing jumps).
   */
  endFrame(): void {
    for (const n of BUTTON_NAMES) this.buttons[n].clearMoveImpulses();
    const wrapped = normalizeAngle(this.view.yaw);
    const shift = wrapped - this.view.yaw;
    if (shift !== 0) {
      this.view.yaw = wrapped;
      this.frameStart.yaw += shift;
    }
  }

  /**
   * Builds the usercmd for one tick and consumes the button impulses (call exactly once per simulated tick).
   * `angles` is copied into cmd.viewangles (pitch clamped, yaw wrapped into ±180).
   */
  buildCmd(out: UserCmd, angles: QAngle, opts: CmdOptions): UserCmd {
    const b = this.buttons;
    const fwd = cvNum('cl_forwardspeed', 450);
    const back = cvNum('cl_backspeed', 450);
    const side = cvNum('cl_sidespeed', 450);
    const up = cvNum('cl_upspeed', 320);
    // KeyState fractions (Source): a sub-tick tap still moves for one tick, a fresh press is a half tick
    out.forwardmove = fwd * b.forward.keyState() - back * b.back.keyState();
    out.sidemove = side * (b.moveright.keyState() - b.moveleft.keyState());
    let upmove = up * (b.moveup.keyState() - b.movedown.keyState());
    if (opts.noclip) upmove += up * (b.jump.state - b.duck.state);
    out.upmove = upmove;
    let bits = 0;
    for (const n of BUTTON_NAMES) {
      const k = b[n];
      if (k.bit && k.active) bits |= k.bit;
      k.clearImpulses();
    }
    out.buttons = bits;
    out.viewangles.pitch = clampPitch(angles.pitch);
    out.viewangles.yaw = normalizeAngle(angles.yaw);
    out.viewangles.roll = angles.roll;
    return out;
  }
}

// ------------------------------------------------------------------------------------------ bind dispatch

/**
 * Runs key binds with Source +/- semantics. Each command of the binding that starts with '+' gets the key name
 * appended on press (`+jump space`), and its '-' twin runs with the same key on release. Bindings are
 * remembered at press time, so rebinding a held key still releases what it pressed.
 */
export class KeyDispatcher {
  private readonly held = new Map<string, string>();
  private pendingRelease: string[] = [];

  constructor(
    private readonly table: BindTable = globalBinds,
    private readonly exec: (argv: string[]) => void = (argv) => console_.executeArgv(argv),
  ) {}

  /** Key pressed. Returns true if the key has a binding (the event should then be consumed). */
  keyDown(key: string): boolean {
    if (this.held.has(key)) return true; // auto-repeat
    const binding = this.table.get(key);
    if (binding === undefined || binding === '') return false;
    this.held.set(key, binding);
    for (const argv of tokenizeCommandLine(binding)) {
      if (argv[0].startsWith('+') && argv.length === 1) this.exec([argv[0], key]);
      else this.exec(argv);
    }
    return true;
  }

  /** Key released: runs the '-' twin of every '+' command its press ran. */
  keyUp(key: string): void {
    const binding = this.held.get(key);
    if (binding === undefined) return;
    this.held.delete(key);
    for (const argv of tokenizeCommandLine(binding)) {
      if (!argv[0].startsWith('+')) continue;
      const minus = `-${argv[0].slice(1)}`;
      if (console_.hasCommand(minus) || console_.getAlias(minus) !== undefined) this.exec([minus, key]);
    }
  }

  /** A press whose release happens after the next simulated tick (mouse wheel "clicks"). */
  tap(key: string): boolean {
    const had = this.held.has(key);
    const bound = this.keyDown(key);
    if (bound && !had) this.pendingRelease.push(key);
    return bound;
  }

  /** Releases taps (call after each simulated tick, or at frame end while not simulating). */
  afterTick(): void {
    if (!this.pendingRelease.length) return;
    const keys = this.pendingRelease;
    this.pendingRelease = [];
    for (const k of keys) this.keyUp(k);
  }

  get hasPendingTaps(): boolean {
    return this.pendingRelease.length > 0;
  }

  isHeld(key: string): boolean {
    return this.held.has(key);
  }

  /** Releases every held key (focus loss, pause). */
  releaseAll(): void {
    this.pendingRelease = [];
    for (const k of [...this.held.keys()]) this.keyUp(k);
  }
}

// ------------------------------------------------------------------------------------------ +/- commands

let buttonCommandsRegistered = false;
let activeInput: InputState | null = null;

/** Registers +forward/-forward ... for every button (once), routed to `input` (the latest call wins). */
export function registerButtonCommands(input: InputState): void {
  activeInput = input;
  if (buttonCommandsRegistered) return;
  buttonCommandsRegistered = true;
  const names: string[] = [...BUTTON_NAMES, ...Object.keys(BUTTON_ALIASES)];
  for (const n of names) {
    registerCommand({
      name: `+${n}`,
      help: `Start ${n}.`,
      handler: (args) => activeInput?.button(n)?.press(args[0]),
    });
    registerCommand({
      name: `-${n}`,
      help: `Stop ${n}.`,
      handler: (args) => activeInput?.button(n)?.release(args[0]),
    });
  }
}

// ------------------------------------------------------------------------------------------ DOM glue

export interface InputDeviceDeps {
  canvas: HTMLCanvasElement;
  ui: UiApi;
  state: InputState;
  dispatcher: KeyDispatcher;
  /** Binds run only while this is true (the game is playing). */
  isPlaying(): boolean;
  /** The pointer lock was lost while playing (and not because the console/chat opened). */
  onPointerLockLost(): void;
  /** Unbound Escape / ` fallbacks (Source keeps them working even after unbindall). */
  onEscape(): void;
  onToggleConsole(): void;
  /** Automated tests: no pointer lock needed (mouse buttons/wheel work without it, no pause on unlock). */
  autotest: boolean;
}

/** KeyboardEvent codes of every bindable keyboard key except Escape (for navigator.keyboard.lock). */
export function lockableKeyCodes(): string[] {
  const out: string[] = [];
  for (const k of KEY_NAMES) {
    if (k === 'escape') continue;
    for (const c of keyNameToCodes(k)) if (!out.includes(c)) out.push(c);
  }
  return out;
}

type LockableCanvas = HTMLCanvasElement & {
  requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
};

/** Printed once when the browser gives a plain pointer lock although raw input (m_rawinput 1) was asked for. */
export const RAW_INPUT_FALLBACK_MESSAGE =
  'Raw mouse input is not available in this browser: mouse movement goes through OS pointer acceleration and display ' +
  'scaling. For CS:GO-identical sensitivity turn off "Enhance pointer precision" (Windows) / mouse acceleration ' +
  '(macOS), and keep display scaling at 100%. Chrome and Edge support raw input.';

function isPromise(x: unknown): x is Promise<void> {
  return !!x && typeof (x as Promise<void>).then === 'function';
}

export class InputDevice {
  private readonly deps: InputDeviceDeps;
  private attached = false;
  private wasLocked = false;
  private lockPending = false;
  private readonly cleanups: Array<() => void> = [];
  /**
   * Raw input of the latest pointer lock: true with unadjustedMovement (no OS acceleration), false for a plain lock
   * (the browser can't do raw input, or m_rawinput 0), null before the first lock.
   */
  rawInputActive: boolean | null = null;
  private rawAdviceShown = false;

  constructor(deps: InputDeviceDeps) {
    this.deps = deps;
  }

  get pointerLocked(): boolean {
    return typeof document !== 'undefined' && document.pointerLockElement === this.deps.canvas;
  }

  /** Mouse buttons, wheel and movement go to the game. */
  private get mouseActive(): boolean {
    return this.pointerLocked || (this.deps.autotest && this.deps.isPlaying());
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    const on = <K extends keyof WindowEventMap>(
      target: Window | Document | HTMLElement,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions | boolean,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    const c = this.deps.canvas;
    on(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    // releases are seen in the capture phase so a focused text field can't swallow them
    on(window, 'keyup', (e: KeyboardEvent) => this.onKeyUp(e), true);
    on(c, 'mousedown', (e: MouseEvent) => this.onCanvasMouseDown(e));
    on(window, 'mousedown', (e: MouseEvent) => this.onMouseDown(e));
    on(window, 'mouseup', (e: MouseEvent) => this.onMouseUp(e), true);
    on(window, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(document, 'mousemove', (e: MouseEvent) => this.onMouseMove(e));
    on(document, 'pointerlockchange', () => this.onLockChange());
    on(document, 'pointerlockerror', () => {
      this.lockPending = false;
    });
    on(window, 'blur', () => this.releaseAll());
    on(c, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    // mouse4/mouse5 are history back/forward in browsers: never navigate away mid-game
    on(window, 'auxclick', (e: MouseEvent) => {
      if ((e.button === 3 || e.button === 4) && this.deps.isPlaying()) e.preventDefault();
    });
    // fullscreen: the Keyboard Lock API lets the game receive Ctrl+W & co. (duck + forward!) instead of the browser
    on(document, 'fullscreenchange', () => this.updateKeyboardLock());
  }

  /** In fullscreen, lock every bindable key except Escape (Escape keeps leaving fullscreen / the pointer). */
  private updateKeyboardLock(): void {
    const kb = (globalThis.navigator as { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } } | undefined)?.keyboard;
    if (!kb || typeof kb.lock !== 'function') return;
    try {
      if (typeof document !== 'undefined' && document.fullscreenElement) {
        void kb.lock(lockableKeyCodes()).catch(() => undefined);
      } else kb.unlock?.();
    } catch {
      /* not allowed */
    }
  }

  detach(): void {
    for (const f of this.cleanups.splice(0)) f();
    this.attached = false;
  }

  releaseAll(): void {
    this.deps.dispatcher.releaseAll();
    this.deps.state.releaseAll();
  }

  /** Records whether the lock is raw; a plain lock that replaced a raw request prints the advice (once). */
  private setRawInput(active: boolean, fallback: boolean): void {
    this.rawInputActive = active;
    if (!active && fallback && !this.rawAdviceShown) {
      this.rawAdviceShown = true;
      conPrint(RAW_INPUT_FALLBACK_MESSAGE, 'warn');
    }
  }

  /** Captures the mouse (raw input when m_rawinput 1 and supported, falling back to a plain lock). */
  requestPointerLock(): void {
    if (this.pointerLocked || this.lockPending || typeof document === 'undefined') return;
    const canvas = this.deps.canvas as LockableCanvas;
    if (typeof canvas.requestPointerLock !== 'function') return;
    const raw = cvNum('m_rawinput', 1) !== 0;
    this.lockPending = true;
    const done = () => {
      this.lockPending = false;
    };
    const plain = () => {
      try {
        const r2 = canvas.requestPointerLock();
        const locked = () => {
          done();
          this.setRawInput(false, true);
        };
        if (isPromise(r2)) r2.then(locked, done);
        else locked();
      } catch {
        done();
      }
    };
    try {
      const r = raw ? canvas.requestPointerLock({ unadjustedMovement: true }) : canvas.requestPointerLock();
      if (isPromise(r)) {
        r.then(
          () => {
            done();
            this.setRawInput(raw, false);
          },
          () => {
            // unadjustedMovement unsupported (or refused): plain pointer lock
            if (raw) plain();
            else done();
          },
        );
      } else {
        // the pre-promise API (Firefox, older Safari) ignores the options: a plain lock
        done();
        this.setRawInput(false, raw);
      }
    } catch {
      if (raw) plain();
      else done();
    }
  }

  // ---------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.deps.isPlaying()) return;
    if (this.deps.ui.isTyping()) return;
    const key = codeToKeyName(e.code);
    if (!key) return;
    if (e.repeat && !this.deps.dispatcher.isHeld(key)) {
      // auto-repeat of a key pressed while typing / before playing: not ours
      return;
    }
    const bound = this.deps.dispatcher.keyDown(key);
    if (bound) {
      e.preventDefault();
      return;
    }
    // Source keeps Escape and the console key working even when unbound
    if (key === 'escape') {
      e.preventDefault();
      this.deps.onEscape();
    } else if (key === '`') {
      e.preventDefault();
      this.deps.onToggleConsole();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const key = codeToKeyName(e.code);
    if (key) this.deps.dispatcher.keyUp(key);
  }

  // ---------------------------------------------------------------- mouse

  private onCanvasMouseDown(e: MouseEvent): void {
    if (!this.deps.isPlaying() || this.pointerLocked || this.deps.autotest) return;
    if (e.button !== 0 || this.deps.ui.isTyping()) return;
    // the game owns clicks on its canvas: capture the mouse (one request per click)
    e.stopPropagation();
    e.preventDefault();
    this.requestPointerLock();
  }

  private onMouseDown(e: MouseEvent): void {
    if (!this.deps.isPlaying() || !this.mouseActive) return;
    if (!this.pointerLocked && e.target !== this.deps.canvas) return;
    const key = mouseButtonToKeyName(e.button);
    if (!key) return;
    if (this.deps.dispatcher.keyDown(key)) e.preventDefault();
  }

  private onMouseUp(e: MouseEvent): void {
    const key = mouseButtonToKeyName(e.button);
    if (key) this.deps.dispatcher.keyUp(key);
    // the side buttons navigate on release in Chromium; cancel that while playing
    if ((e.button === 3 || e.button === 4) && this.deps.isPlaying()) e.preventDefault();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.deps.isPlaying() || !this.mouseActive || this.deps.ui.isTyping()) return;
    const key = wheelToKeyName(e.deltaY);
    if (!key) return;
    e.preventDefault();
    this.deps.dispatcher.tap(key);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.pointerLocked) return;
    if (!this.deps.isPlaying()) return;
    // no mouse look while typing in the chat (or console): CS:GO freezes the view while messagemode is open
    if (this.deps.ui.isTyping()) return;
    this.deps.state.addMouse(e.movementX, e.movementY);
  }

  private onLockChange(): void {
    const locked = this.pointerLocked;
    this.lockPending = false;
    if (locked) {
      this.wasLocked = true;
      this.deps.state.discardMouse();
      return;
    }
    if (!this.wasLocked) return;
    this.wasLocked = false;
    this.deps.state.discardMouse();
    if (this.deps.autotest || !this.deps.isPlaying()) return;
    // the console / chat took the mouse: keep playing (CS:GO doesn't pause either)
    if (this.deps.ui.isTyping()) return;
    this.deps.onPointerLockLost();
  }
}
