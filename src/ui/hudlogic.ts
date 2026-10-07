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
