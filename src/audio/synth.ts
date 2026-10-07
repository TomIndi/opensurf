// Procedural sound effects. Every game/UI sound is synthesized with WebAudio from oscillators and noise —
// no samples are shipped.
import type { SoundName } from '../game/api';

export interface Voice {
  ctx: BaseAudioContext;
  out: AudioNode;
  /** Mono white noise buffer (a few seconds). */
  noise: AudioBuffer;
  /** Frequency multiplier (opts.pitch). */
  pitch: number;
  /** Gain multiplier (opts.volume). */
  vol: number;
  /** Start time. */
  t: number;
  rand: () => number;
}

const MIN = 0.0001;

interface ToneOpts {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  /** Offset from voice start. */
  at?: number;
  dur: number;
  gain: number;
  attack?: number;
  /** Lowpass the oscillator (Hz). */
  lowpass?: number;
  detune?: number;
}

/** One oscillator with an attack + exponential decay envelope. */
export function tone(v: Voice, o: ToneOpts): void {
  const { ctx } = v;
  const t = v.t + (o.at ?? 0);
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f0 * v.pitch, t);
  if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1 * v.pitch), t + o.dur);
  if (o.detune) osc.detune.setValueAtTime(o.detune, t);
  const g = ctx.createGain();
  const attack = o.attack ?? 0.004;
  const peak = Math.max(MIN * 2, o.gain * v.vol);
  g.gain.setValueAtTime(MIN, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(MIN, t + Math.max(attack + 0.01, o.dur));
  let node: AudioNode = osc;
  if (o.lowpass) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lowpass;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(v.out);
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
}

interface NoiseOpts {
  at?: number;
  dur: number;
  gain: number;
  attack?: number;
  filter: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  rate?: number;
}

/** A filtered noise burst with attack + exponential decay. */
export function noise(v: Voice, o: NoiseOpts): void {
  const { ctx } = v;
  const t = v.t + (o.at ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = v.noise;
  src.playbackRate.value = (o.rate ?? 1) * Math.sqrt(v.pitch);
  const f = ctx.createBiquadFilter();
  f.type = o.filter;
  f.frequency.setValueAtTime(o.f0 * v.pitch, t);
  if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(10, o.f1 * v.pitch), t + o.dur);
  f.Q.value = o.q ?? 0.8;
  const g = ctx.createGain();
  const attack = o.attack ?? 0.003;
  g.gain.setValueAtTime(MIN, t);
  g.gain.exponentialRampToValueAtTime(Math.max(MIN * 2, o.gain * v.vol), t + attack);
  g.gain.exponentialRampToValueAtTime(MIN, t + Math.max(attack + 0.01, o.dur));
  src.connect(f);
  f.connect(g);
  g.connect(v.out);
  const maxOff = Math.max(0, v.noise.duration - o.dur - 0.1);
  src.start(t, v.rand() * maxOff, o.dur + 0.05);
}

/** Bell-like partials (chimes). */
function bell(v: Voice, f: number, at: number, gain: number, decay = 0.7): void {
  tone(v, { f0: f, at, dur: decay, gain, attack: 0.003 });
  tone(v, { f0: f * 2.0, at, dur: decay * 0.55, gain: gain * 0.35, attack: 0.002 });
  tone(v, { f0: f * 3.01, at, dur: decay * 0.3, gain: gain * 0.12, attack: 0.002 });
}

/** Soft brass-ish note (saw through an enveloped lowpass) for fanfares. */
function brass(v: Voice, f: number, at: number, dur: number, gain: number): void {
  const { ctx } = v;
  const t = v.t + at;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f * v.pitch, t);
  const osc2 = ctx.createOscillator();
  osc2.type = 'sawtooth';
  osc2.frequency.setValueAtTime(f * v.pitch, t);
  osc2.detune.setValueAtTime(7, t);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(f * 1.2, t);
  lp.frequency.exponentialRampToValueAtTime(f * 6, t + 0.05);
  lp.frequency.exponentialRampToValueAtTime(f * 2.2, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(MIN, t);
  g.gain.exponentialRampToValueAtTime(gain * v.vol, t + 0.025);
  g.gain.setValueAtTime(gain * v.vol * 0.8, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(MIN, t + dur);
  osc.connect(lp);
  osc2.connect(lp);
  lp.connect(g);
  g.connect(v.out);
  osc.start(t);
  osc2.start(t);
  osc.stop(t + dur + 0.05);
  osc2.stop(t + dur + 0.05);
}

function bubble(v: Voice, at: number, f: number, gain: number): void {
  tone(v, { f0: f, f1: f * 1.9, at, dur: 0.05 + v.rand() * 0.04, gain, attack: 0.002 });
}

const note = (semitonesFromA4: number) => 440 * Math.pow(2, semitonesFromA4 / 12);
const C5 = note(3);
const E5 = note(7);
const G5 = note(10);
const C6 = note(15);
const E6 = note(19);
const G6 = note(22);

/** Sound recipes. Each returns its approximate length in seconds. */
export const RECIPES: Record<SoundName, (v: Voice) => number> = {
  jump(v) {
    noise(v, { dur: 0.07, gain: 0.22, filter: 'bandpass', f0: 1700, f1: 1100, q: 0.9 });
    tone(v, { f0: 150, f1: 85, dur: 0.09, gain: 0.2 });
    noise(v, { at: 0.01, dur: 0.11, gain: 0.05, filter: 'highpass', f0: 3200 });
    return 0.15;
  },
  land(v) {
    tone(v, { f0: 110, f1: 52, dur: 0.13, gain: 0.32 });
    noise(v, { dur: 0.09, gain: 0.28, filter: 'lowpass', f0: 900, f1: 300 });
    noise(v, { dur: 0.05, gain: 0.08, filter: 'bandpass', f0: 2400, q: 1.2 });
    return 0.15;
  },
  land_hard(v) {
    tone(v, { f0: 95, f1: 38, dur: 0.24, gain: 0.5 });
    noise(v, { dur: 0.16, gain: 0.42, filter: 'lowpass', f0: 1400, f1: 260 });
    noise(v, { at: 0.005, dur: 0.12, gain: 0.16, filter: 'bandpass', f0: 1300, f1: 700, q: 1.4 });
    noise(v, { at: 0.02, dur: 0.2, gain: 0.06, filter: 'highpass', f0: 2800 });
    return 0.3;
  },
  footstep(v) {
    const r = v.rand();
    const f = 1500 + r * 1100;
    noise(v, { dur: 0.03, gain: 0.1 + r * 0.04, filter: 'bandpass', f0: f, q: 1.1 });
    noise(v, { at: 0.004, dur: 0.07, gain: 0.12, filter: 'lowpass', f0: 650 + v.rand() * 250 });
    tone(v, { f0: 105 + v.rand() * 30, f1: 70, dur: 0.05, gain: 0.08 });
    return 0.09;
  },
  teleport(v) {
    tone(v, { type: 'sine', f0: 220, f1: 990, dur: 0.28, gain: 0.13, attack: 0.02 });
    tone(v, { type: 'triangle', f0: 660, f1: 1980, at: 0.04, dur: 0.24, gain: 0.05, attack: 0.02 });
    noise(v, { dur: 0.32, gain: 0.12, attack: 0.04, filter: 'bandpass', f0: 500, f1: 5000, q: 1.6 });
    return 0.35;
  },
  zone_start(v) {
    tone(v, { f0: 740, f1: 700, dur: 0.16, gain: 0.07, attack: 0.006 });
    tone(v, { f0: 1480, dur: 0.08, gain: 0.02 });
    return 0.18;
  },
  zone_leave(v) {
    tone(v, { f0: 880, dur: 0.06, gain: 0.08 });
    tone(v, { f0: 1320, at: 0.055, dur: 0.1, gain: 0.08 });
    return 0.16;
  },
  checkpoint(v) {
    bell(v, C6, 0, 0.13, 0.6);
    return 0.6;
  },
  stage(v) {
    bell(v, E5, 0, 0.11, 0.5);
    bell(v, note(11), 0.06, 0.11, 0.5);
    bell(v, note(14), 0.12, 0.12, 0.7);
    return 0.82;
  },
  finish(v) {
    const seq = [C5, E5, G5, C6];
    seq.forEach((f, i) => bell(v, f, i * 0.085, 0.11, 0.6));
    for (const f of [C5, E5, G5]) brass(v, f, 0.34, 0.9, 0.035);
    return 1.3;
  },
  pb(v) {
    const seq = [G5 / 2, C5, E5, G5, C6, E6];
    seq.forEach((f, i) => bell(v, f, i * 0.07, 0.1, 0.55));
    for (const f of [C5, E5, G5, C6]) brass(v, f, 0.42, 1.1, 0.03);
    for (let i = 0; i < 8; i++) tone(v, { f0: 2000 + v.rand() * 3000, at: 0.45 + i * 0.07, dur: 0.18, gain: 0.025 });
    return 1.6;
  },
  wr(v) {
    // two-chord "ta-daa" with sparkles and a bass hit
    for (const f of [G5 / 2, C5, E5]) brass(v, f, 0, 0.22, 0.04);
    for (const f of [C5, E5, G5, C6]) brass(v, f, 0.24, 1.5, 0.04);
    tone(v, { f0: 65.4, at: 0.24, dur: 1.2, gain: 0.25, attack: 0.01 });
    [C6, E6, G6, C6 * 2].forEach((f, i) => bell(v, f, 0.3 + i * 0.08, 0.07, 0.8));
    for (let i = 0; i < 14; i++) tone(v, { f0: 2500 + v.rand() * 4000, at: 0.35 + i * 0.08, dur: 0.2, gain: 0.02 });
    return 2.0;
  },
  fail(v) {
    tone(v, { type: 'square', f0: 330, f1: 300, dur: 0.16, gain: 0.05, lowpass: 1400 });
    tone(v, { type: 'square', f0: 247, f1: 196, at: 0.15, dur: 0.32, gain: 0.05, lowpass: 1200 });
    return 0.5;
  },
  booster(v) {
    noise(v, { dur: 0.42, gain: 0.2, attack: 0.05, filter: 'bandpass', f0: 280, f1: 2600, q: 1.3 });
    noise(v, { dur: 0.3, gain: 0.08, attack: 0.02, filter: 'lowpass', f0: 400 });
    tone(v, { f0: 60, f1: 95, dur: 0.3, gain: 0.1, attack: 0.03 });
    return 0.45;
  },
  water_enter(v) {
    noise(v, { dur: 0.35, gain: 0.3, filter: 'lowpass', f0: 3200, f1: 500 });
    noise(v, { at: 0.01, dur: 0.18, gain: 0.08, filter: 'highpass', f0: 2500 });
    for (let i = 0; i < 7; i++) bubble(v, 0.06 + v.rand() * 0.4, 380 + v.rand() * 900, 0.05);
    return 0.55;
  },
  water_exit(v) {
    noise(v, { dur: 0.2, gain: 0.14, filter: 'highpass', f0: 900 });
    noise(v, { dur: 0.16, gain: 0.08, filter: 'lowpass', f0: 1200 });
    for (let i = 0; i < 2; i++) bubble(v, 0.03 + v.rand() * 0.12, 600 + v.rand() * 600, 0.03);
    return 0.25;
  },
  ui_hover(v) {
    tone(v, { f0: 2600, dur: 0.025, gain: 0.018, attack: 0.002 });
    return 0.03;
  },
  ui_click(v) {
    tone(v, { type: 'triangle', f0: 1250, f1: 820, dur: 0.05, gain: 0.07, attack: 0.002 });
    noise(v, { dur: 0.012, gain: 0.03, filter: 'highpass', f0: 3000 });
    return 0.06;
  },
  ui_back(v) {
    tone(v, { type: 'triangle', f0: 760, f1: 470, dur: 0.08, gain: 0.06, attack: 0.002 });
    return 0.09;
  },
  chat(v) {
    tone(v, { f0: 1180, dur: 0.05, gain: 0.06, attack: 0.002 });
    tone(v, { f0: 1580, at: 0.05, dur: 0.08, gain: 0.05, attack: 0.002 });
    return 0.14;
  },
};

/** Minimum spacing between two plays of the same sound (seconds) — avoids stacking spam. */
export const MIN_INTERVAL: Partial<Record<SoundName, number>> = {
  footstep: 0.06,
  ui_hover: 0.03,
  jump: 0.05,
  land: 0.05,
  land_hard: 0.08,
  chat: 0.05,
  booster: 0.12,
  checkpoint: 0.05,
};
