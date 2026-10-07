// WebAudio sound system: synthesized effects (synth.ts) + continuous speed-driven wind.
// The AudioContext is created lazily in unlock() (browsers require a user gesture).
import { console_ } from '../core/cvars';
import type { SoundApi, SoundName } from '../game/api';
import { MIN_INTERVAL, RECIPES, Voice } from './synth';
import { windParams } from './wind';

type Ctx = AudioContext;

/**
 * Noise buffer that loops seamlessly: generate N+F samples of a continuous noise stream, then crossfade the
 * F extra samples into the start, so sample N-1 flows into sample 0 exactly like r[N-1] flows into r[N].
 */
export function noiseSamples(len: number, fade: number, pink: boolean, random: () => number = Math.random): Float32Array<ArrayBuffer> {
  const total = len + fade;
  const r = new Float32Array(new ArrayBuffer(total * 4));
  // Paul Kellet's economy pink filter (well-known public DSP recipe)
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < total; i++) {
    const w = random() * 2 - 1;
    if (pink) {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      r[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    } else r[i] = w * 0.5;
  }
  const out = r.slice(0, len);
  for (let i = 0; i < fade && i < len; i++) {
    const a = i / fade;
    out[i] = r[i] * a + r[len + i] * (1 - a);
  }
  return out;
}

function makeNoise(ctx: BaseAudioContext, seconds: number, channels: number, pink: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let ch = 0; ch < channels; ch++) buf.copyToChannel(noiseSamples(len, Math.min(4096, len >> 3), pink), ch);
  return buf;
}

export class SoundSystem implements SoundApi {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private focusGain: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private wind: {
    src: AudioBufferSourceNode;
    low: BiquadFilterNode;
    lowGain: GainNode;
    high: BiquadFilterNode;
    highGain: GainNode;
  } | null = null;
  private volume = 0.5;
  private volumeFromCvar = true;
  private muted = false;
  private lastPlay = new Map<SoundName, number>();
  private lastWindUpdate = 0;
  private lastWind = { speed: -1, airborne: false };
  private seed = 0x9e3779b9;

  constructor() {
    const vol = console_.getCvar('volume');
    if (vol) this.volume = clamp01(vol.num);
    console_.onCvarChange((cv) => {
      if (cv.name === 'volume' && this.volumeFromCvar) this.applyVolume(clamp01(cv.num));
      else if (cv.name === 'snd_mute_losefocus') this.updateFocusMute();
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this.updateFocusMute());
      window.addEventListener('blur', () => this.updateFocusMute());
      window.addEventListener('focus', () => this.updateFocusMute());
    }
  }

  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      this.build(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** True once the AudioContext exists and runs. */
  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private build(ctx: Ctx): void {
    const vol = console_.getCvar('volume');
    if (vol && this.volumeFromCvar) this.volume = clamp01(vol.num);
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.focusGain = ctx.createGain();
    this.focusGain.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);
    this.master.connect(this.focusGain);
    this.focusGain.connect(comp);
    comp.connect(ctx.destination);
    this.noiseBuf = makeNoise(ctx, 3, 1, false);

    // wind: decorrelated stereo pink noise through two filtered layers
    const windNoise = makeNoise(ctx, 6, 2, true);
    const src = ctx.createBufferSource();
    src.buffer = windNoise;
    src.loop = true;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 200;
    low.Q.value = 0.5;
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0;
    const high = ctx.createBiquadFilter();
    high.type = 'bandpass';
    high.frequency.value = 600;
    high.Q.value = 0.7;
    const highGain = ctx.createGain();
    highGain.gain.value = 0;
    src.connect(low);
    low.connect(lowGain);
    lowGain.connect(this.master);
    src.connect(high);
    high.connect(highGain);
    highGain.connect(this.master);
    src.start();
    this.wind = { src, low, lowGain, high, highGain };
    this.updateFocusMute();
  }

  private rand = (): number => {
    // xorshift32: cheap, deterministic enough for sound variation
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  };

  play(name: SoundName, opts?: { volume?: number; pitch?: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || !this.noiseBuf || ctx.state !== 'running') return;
    if (this.muted && name !== 'ui_click') return;
    const recipe = RECIPES[name];
    if (!recipe) return;
    const now = ctx.currentTime;
    const minGap = MIN_INTERVAL[name] ?? 0.015;
    const last = this.lastPlay.get(name) ?? -1;
    if (now - last < minGap) return;
    this.lastPlay.set(name, now);
    const vol = Math.max(0, Math.min(4, opts?.volume ?? 1));
    if (vol <= 0) return;
    const pitch = Math.max(0.25, Math.min(4, opts?.pitch ?? 1));
    const v: Voice = { ctx, out: this.sfx, noise: this.noiseBuf, pitch, vol, t: now + 0.005, rand: this.rand };
    try {
      recipe(v);
    } catch {
      /* never let a sound break the game */
    }
  }

  setWind(speed: number, airborne: boolean): void {
    const ctx = this.ctx;
    const w = this.wind;
    if (!ctx || !w) return;
    const now = ctx.currentTime;
    const changed = Math.abs(speed - this.lastWind.speed) > 4 || airborne !== this.lastWind.airborne;
    if (!changed && now - this.lastWindUpdate < 0.25) return;
    if (now - this.lastWindUpdate < 1 / 40 && airborne === this.lastWind.airborne) return;
    this.lastWindUpdate = now;
    this.lastWind.speed = speed;
    this.lastWind.airborne = airborne;
    const p = windParams(speed, airborne);
    w.lowGain.gain.setTargetAtTime(p.lowGain, now, 0.12);
    w.highGain.gain.setTargetAtTime(p.highGain, now, 0.15);
    w.low.frequency.setTargetAtTime(p.lowCutoff, now, 0.2);
    w.high.frequency.setTargetAtTime(p.highFreq, now, 0.2);
    w.high.Q.setTargetAtTime(p.highQ, now, 0.2);
  }

  setMasterVolume(v: number): void {
    this.applyVolume(clamp01(v));
  }

  private applyVolume(v: number): void {
    this.volume = v;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  private updateFocusMute(): void {
    if (typeof document === 'undefined') return;
    const c = console_.getCvar('snd_mute_losefocus');
    const muteOnBlur = c ? c.bool : true;
    const unfocused = document.visibilityState === 'hidden' || (typeof document.hasFocus === 'function' && !document.hasFocus());
    this.muted = muteOnBlur && unfocused;
    if (this.ctx && this.focusGain) this.focusGain.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.05);
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}
