// HUD assembly: turns the simulation state (player, timer, input, replay) into the HudState the UI draws every
// frame. Everything here is allocation-free on the per-frame path: the game keeps one HudState and refills it.
import { QAngle, normalizeAngle } from '../core/angles';
import { Vec3, v3 } from '../core/vec3';
import { IN_BACK, IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVELEFT, IN_MOVERIGHT, IN_SPEED } from '../physics/playertypes';
import { HudState, KeysHud, TimerHud } from './api';

/** Timer HUD for "no timer" (no map, or a map without zones). */
export function emptyTimerHud(): TimerHud {
  return {
    state: 'disabled',
    time: 0,
    stage: 0,
    stageCount: 0,
    stageTime: 0,
    checkpoint: 0,
    checkpointCount: 0,
    bonus: 0,
    pb: null,
    wr: null,
    mapType: 'linear',
    lastSplitDelta: null,
    lastSplitTime: 0,
  };
}

export function emptyKeys(): KeysHud {
  return { forward: false, back: false, left: false, right: false, jump: false, duck: false, walk: false, turn: 0 };
}

export function createHudState(): HudState {
  return {
    visible: false,
    mapName: '',
    tier: null,
    speed: 0,
    velocity: v3(),
    origin: v3(),
    angles: { pitch: 0, yaw: 0, roll: 0 },
    onGround: false,
    timer: emptyTimerHud(),
    keys: emptyKeys(),
    jumps: 0,
    strafes: 0,
    sync: 0,
    practice: false,
    noclip: false,
    spectating: null,
    now: 0,
  };
}

/** Horizontal speed (what surf HUDs show). */
export function horizontalSpeed(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

/** Pressed movement keys, from held +commands (or replay buttons). */
export interface KeyStates {
  forward: boolean;
  back: boolean;
  moveleft: boolean;
  moveright: boolean;
  jump: boolean;
  duck: boolean;
  speed: boolean;
}

/** Turn direction from a yaw change: yaw grows to the left, so a negative change is a right turn (+1). */
export function turnFromYawDelta(yawDelta: number): number {
  return yawDelta < 0 ? 1 : yawDelta > 0 ? -1 : 0;
}

export function fillKeys(out: KeysHud, k: KeyStates, turn: number): KeysHud {
  out.forward = k.forward;
  out.back = k.back;
  out.left = k.moveleft;
  out.right = k.moveright;
  out.jump = k.jump;
  out.duck = k.duck;
  out.walk = k.speed;
  out.turn = turn;
  return out;
}

/** Keys from usercmd button bits (replays). */
export function fillKeysFromButtons(out: KeysHud, buttons: number, turn: number): KeysHud {
  out.forward = (buttons & IN_FORWARD) !== 0;
  out.back = (buttons & IN_BACK) !== 0;
  out.left = (buttons & IN_MOVELEFT) !== 0;
  out.right = (buttons & IN_MOVERIGHT) !== 0;
  out.jump = (buttons & IN_JUMP) !== 0;
  out.duck = (buttons & IN_DUCK) !== 0;
  out.walk = (buttons & IN_SPEED) !== 0;
  out.turn = turn;
  return out;
}

export function copyTimerHud(out: TimerHud, t: TimerHud): TimerHud {
  out.state = t.state;
  out.time = t.time;
  out.stage = t.stage;
  out.stageCount = t.stageCount;
  out.stageTime = t.stageTime;
  out.checkpoint = t.checkpoint;
  out.checkpointCount = t.checkpointCount;
  out.bonus = t.bonus;
  out.pb = t.pb;
  out.wr = t.wr;
  out.mapType = t.mapType;
  out.lastSplitDelta = t.lastSplitDelta;
  out.lastSplitTime = t.lastSplitTime;
  return out;
}

/** Everything the HUD shows, gathered by the game each frame. */
export interface HudSource {
  visible: boolean;
  mapName: string;
  tier: number | null;
  /** The view (eye) position, as CS:GO's cl_showpos and getpos show it. */
  origin: Vec3;
  velocity: Vec3;
  angles: QAngle;
  onGround: boolean;
  /** Null when no timer (the HUD then shows a disabled timer). */
  timer: TimerHud | null;
  stats: { jumps: number; strafes: number; sync: number } | null;
  keys: KeyStates | null;
  /** Button bits used instead of `keys` (replay playback); ignored when `keys` is given. */
  buttons?: number;
  turn: number;
  practice: boolean;
  noclip: boolean;
  spectating: string | null;
  /** Overrides the speed derived from `velocity` (replay playback). */
  speed?: number;
  now: number;
}

/** Refills `out` from `src` (keeps nested objects so the UI may hold references between frames). */
export function updateHudState(out: HudState, src: HudSource): HudState {
  out.visible = src.visible;
  out.mapName = src.mapName;
  out.tier = src.tier;
  out.origin.x = src.origin.x;
  out.origin.y = src.origin.y;
  out.origin.z = src.origin.z;
  out.velocity.x = src.velocity.x;
  out.velocity.y = src.velocity.y;
  out.velocity.z = src.velocity.z;
  out.speed = src.speed !== undefined ? src.speed : horizontalSpeed(src.velocity);
  out.angles.pitch = src.angles.pitch;
  out.angles.yaw = normalizeAngle(src.angles.yaw);
  out.angles.roll = src.angles.roll;
  out.onGround = src.onGround;
  if (src.timer) copyTimerHud(out.timer, src.timer);
  else copyTimerHud(out.timer, EMPTY_TIMER);
  out.jumps = src.stats ? src.stats.jumps : 0;
  out.strafes = src.stats ? src.stats.strafes : 0;
  out.sync = src.stats ? src.stats.sync : 0;
  if (src.keys) fillKeys(out.keys, src.keys, src.turn);
  else fillKeysFromButtons(out.keys, src.buttons ?? 0, src.turn);
  out.practice = src.practice;
  out.noclip = src.noclip;
  out.spectating = src.spectating;
  out.now = src.now;
  return out;
}

const EMPTY_TIMER: TimerHud = Object.freeze(emptyTimerHud()) as TimerHud;
