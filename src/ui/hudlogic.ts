// Pure HUD logic (unit tested): timer panel text/state, speedometer trend colour, fps meter.
import type { TimerHud } from '../game/api';
import { formatDelta, formatTime } from './format';

export type TimerCls = 'disabled' | 'start' | 'running' | 'finished' | 'practice' | 'stopped';

export interface TimerView {
  /** Big text: the clock, or "Start Zone" / "No Timer". */
  main: string;
  /** Small label above the clock ('' = none). */
  label: string;
  cls: TimerCls;
  /** "Stage 3/8", "Linear | CP 2/5", "Bonus 1". */
  course: string;
  pb: string;
  wr: string;
}

export function courseText(t: TimerHud): string {
  if (t.bonus > 0) return `Bonus ${t.bonus}`;
  if (t.mapType === 'staged') {
    const n = Math.max(1, t.stage);
    return t.stageCount > 0 ? `Stage ${Math.min(n, t.stageCount)}/${t.stageCount}` : `Stage ${n}`;
  }
  return t.checkpointCount > 0 ? `Linear | CP ${Math.min(t.checkpoint, t.checkpointCount)}/${t.checkpointCount}` : 'Linear';
}

export function timerView(t: TimerHud, practice = false): TimerView {
  const course = courseText(t);
  const pb = t.pb !== null && t.pb > 0 ? formatTime(t.pb) : 'None';
  const wr = t.wr !== null && t.wr > 0 ? formatTime(t.wr) : 'None';
  const base = { course, pb, wr };
  switch (t.state) {
    case 'disabled':
      return { ...base, main: 'No Timer', label: 'no zones on this map', cls: 'disabled' };
    case 'startzone':
      return { ...base, main: 'Start Zone', label: t.bonus > 0 ? `Bonus ${t.bonus}` : '', cls: 'start' };
    case 'finished':
      return { ...base, main: formatTime(t.time), label: 'Finished', cls: 'finished' };
    case 'practice':
      return { ...base, main: formatTime(t.time), label: '[Practice]', cls: 'practice' };
    case 'stopped':
      return { ...base, main: formatTime(t.time), label: 'Stopped', cls: 'stopped' };
    case 'running':
    default:
      if (practice) return { ...base, main: formatTime(t.time), label: '[Practice]', cls: 'practice' };
      return { ...base, main: formatTime(t.time), label: '', cls: 'running' };
  }
}

export function splitView(delta: number | null): { text: string; cls: 'faster' | 'slower' | 'tie' } | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  const text = formatDelta(delta);
  if (text.startsWith('±')) return { text, cls: 'tie' };
  return { text, cls: delta < 0 ? 'faster' : 'slower' };
}

export type SpeedTrendState = 'gain' | 'loss' | 'steady';

/**
 * Speedometer colour (surf_speedometer_color): green while gaining speed, red while losing, white when steady.
 * Acceleration is smoothed with an exponential moving average and the state has hysteresis, so the colour
 * doesn't flicker frame to frame.
 */
export class SpeedTrend {
  /** Smoothed acceleration in u/s². */
  accel = 0;
  state: SpeedTrendState = 'steady';
  private last = -1;
  constructor(
    private readonly tau = 0.12,
    private readonly enter = 15,
    private readonly exit = 5,
  ) {}

  reset(speed = -1): void {
    this.last = speed;
    this.accel = 0;
    this.state = 'steady';
  }

  update(speed: number, dt: number): SpeedTrendState {
    if (!Number.isFinite(speed)) return this.state;
    if (this.last < 0 || !(dt > 0) || dt > 0.5 || Math.abs(speed - this.last) > 1200) {
      // first sample, stalled frame or teleport: start over
      this.reset(speed);
      return this.state;
    }
    const a = (speed - this.last) / dt;
    this.last = speed;
    const k = 1 - Math.exp(-dt / this.tau);
    this.accel += (a - this.accel) * k;
    const s = this.state;
    if (s === 'gain') {
      if (this.accel < this.exit) this.state = this.accel < -this.enter ? 'loss' : 'steady';
    } else if (s === 'loss') {
      if (this.accel > -this.exit) this.state = this.accel > this.enter ? 'gain' : 'steady';
    } else if (this.accel > this.enter) this.state = 'gain';
    else if (this.accel < -this.enter) this.state = 'loss';
    return this.state;
  }
}

/** Frames-per-second meter averaged over a window (cl_showfps). */
export class FpsMeter {
  private frames = 0;
  private acc = 0;
  fps = 0;
  constructor(private readonly window = 0.5) {}
  /** Returns true when `fps` was updated. */
  tick(dt: number): boolean {
    if (!(dt > 0) || dt > 1) return false;
    this.frames++;
    this.acc += dt;
    if (this.acc >= this.window) {
      this.fps = this.frames / this.acc;
      this.frames = 0;
      this.acc = 0;
      return true;
    }
    return false;
  }
}

/** Frame time statistics for net_graph (mean and standard deviation over a sliding window). */
export class FrameStats {
  private readonly buf: Float64Array;
  private n = 0;
  private i = 0;
  constructor(size = 120) {
    this.buf = new Float64Array(size);
  }
  push(dtMs: number): void {
    if (!(dtMs > 0) || dtMs > 1000) return;
    this.buf[this.i] = dtMs;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }
  get count(): number {
    return this.n;
  }
  mean(): number {
    if (!this.n) return 0;
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.buf[k];
    return s / this.n;
  }
  /** Standard deviation in ms ("var" in CS:GO's net_graph). */
  stddev(): number {
    if (this.n < 2) return 0;
    const m = this.mean();
    let s = 0;
    for (let k = 0; k < this.n; k++) s += (this.buf[k] - m) ** 2;
    return Math.sqrt(s / (this.n - 1));
  }
}

/** CS:GO-style net_graph text for a local game. */
export function netGraphText(fps: number, frameVarMs: number, tickrate: number): string {
  const f = String(Math.round(fps)).padStart(4);
  const tick = tickrate.toFixed(1).padStart(5);
  return `fps: ${f}  var: ${frameVarMs.toFixed(1)} ms  ping: 0 ms\nloss:   0%  choke:  0%\ntick:${tick}  up: ${Math.round(tickrate)}/s  cmd: ${Math.round(tickrate)}/s\nlocal server`;
}

/**
 * Keeps a momentary signal visible for a minimum time (showkeys: one-frame wheel jumps, per-frame mouse turn
 * direction that drops to 0 on frames without mouse movement).
 */
export class HoldLatch {
  private until = -Infinity;
  constructor(private readonly holdMs = 90) {}
  /** `now` in ms. Returns the displayed state. */
  update(active: boolean, now: number): boolean {
    if (active) this.until = now + this.holdMs;
    return active || now < this.until;
  }
  reset(): void {
    this.until = -Infinity;
  }
}
