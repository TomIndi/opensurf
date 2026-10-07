import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoundName } from '../src/game/api';
import { noiseSamples, SoundSystem } from '../src/audio/audio';
import { MIN_INTERVAL, RECIPES, type Voice } from '../src/audio/synth';
import { WIND_FULL, WIND_START, windIntensity, windParams } from '../src/audio/wind';
import { console_, registerCvar } from '../src/core/cvars';

// ------------------------------------------------------------ a minimal fake WebAudio graph

class FakeParam {
  value = 0;
  events: { kind: string; v: number; t: number }[] = [];
  setValueAtTime(v: number, t: number) {
    this.check(v, t);
    this.events.push({ kind: 'set', v, t });
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.check(v, t);
    if (!(v > 0)) throw new Error(`exponential ramp to non-positive value ${v}`);
    this.events.push({ kind: 'exp', v, t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.check(v, t);
    this.events.push({ kind: 'lin', v, t });
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    this.check(v, t);
    if (!(tau > 0)) throw new Error('bad time constant');
    this.events.push({ kind: 'target', v, t });
    this.value = v;
    return this;
  }
  private check(v: number, t: number) {
    if (!Number.isFinite(v) || !Number.isFinite(t) || t < 0) throw new Error(`bad automation ${v} @ ${t}`);
  }
}

class FakeNode {
  outs: FakeNode[] = [];
  constructor(readonly ctx: FakeCtx) {
    ctx.nodes.push(this);
  }
  connect(n: FakeNode) {
    this.outs.push(n);
    return n;
  }
  disconnect() {
    this.outs = [];
  }
}
class FakeSource extends FakeNode {
  started: number | null = null;
  stopped: number | null = null;
  duration: number | null = null;
  start(t = 0, _offset = 0, duration?: number) {
    if (this.started !== null) throw new Error('started twice');
    this.started = t;
    if (duration !== undefined) this.duration = duration;
  }
  stop(t = 0) {
    this.stopped = t;
  }
}
class FakeOsc extends FakeSource {
  type = 'sine';
  frequency = new FakeParam();
  detune = new FakeParam();
}
class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  playbackRate = new FakeParam();
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeBiquad extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
}
class FakeComp extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}
class FakeBuffer {
  private data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number) {
    return this.data[c];
  }
  copyToChannel(src: Float32Array, c: number) {
    this.data[c].set(src);
  }
}
class FakeCtx {
  static instances: FakeCtx[] = [];
  nodes: FakeNode[] = [];
  currentTime = 1;
  sampleRate = 8000;
  state = 'running';
  destination: FakeNode;
  constructor() {
    this.destination = new FakeNode(this);
    FakeCtx.instances.push(this);
  }
  createOscillator() {
    return new FakeOsc(this);
  }
  createGain() {
    return new FakeGain(this);
  }
  createBiquadFilter() {
    return new FakeBiquad(this);
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createDynamicsCompressor() {
    return new FakeComp(this);
  }
  createBuffer(ch: number, len: number, sr: number) {
    return new FakeBuffer(ch, len, sr);
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

function reaches(from: FakeNode, to: FakeNode, seen = new Set<FakeNode>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.outs.some((n) => reaches(n, to, seen));
}

const ALL_SOUNDS: SoundName[] = [
  'jump',
  'land',
  'land_hard',
  'footstep',
  'teleport',
  'zone_start',
  'zone_leave',
  'checkpoint',
  'stage',
  'finish',
  'pb',
  'wr',
  'fail',
  'booster',
  'water_enter',
  'water_exit',
  'ui_hover',
  'ui_click',
  'ui_back',
  'chat',
];

describe('synthesized sound recipes', () => {
  it('there is a recipe for every SoundName', () => {
    expect(Object.keys(RECIPES).sort()).toEqual([...ALL_SOUNDS].sort());
  });

  for (const name of ALL_SOUNDS) {
    it(`${name}: valid graph, every source started and stopped, reaches the output`, () => {
      const ctx = new FakeCtx();
      const out = new FakeGain(ctx);
      const noise = new FakeBuffer(1, 8000 * 3, 8000);
      let seed = 7;
      const v: Voice = { ctx: ctx as never, out: out as never, noise: noise as never, pitch: 1.2, vol: 0.8, t: 2, rand: () => ((seed = (seed * 16807) % 2147483647) / 2147483647) };
      const len = RECIPES[name](v);
      expect(len).toBeGreaterThan(0);
      expect(len).toBeLessThan(3);
      const sources = ctx.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) {
        expect(s.started).not.toBeNull();
        expect(s.started!).toBeGreaterThanOrEqual(2);
        // must end on its own: explicit stop or a bounded buffer duration
        expect(s.stopped !== null || s.duration !== null).toBe(true);
        if (s.stopped !== null) expect(s.stopped).toBeLessThan(2 + 3);
        expect(reaches(s, out)).toBe(true);
      }
      // every gain envelope ends near silence (no stuck voices)
      for (const g of ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain && n !== out)) {
        const last = g.gain.events.at(-1);
        expect(last).toBeDefined();
        expect(last!.v).toBeLessThan(0.01);
      }
    });
  }
});

describe('wind', () => {
  it('is silent below ~300 u/s and saturates near 3000', () => {
    expect(windIntensity(0)).toBe(0);
    expect(windIntensity(WIND_START)).toBe(0);
    expect(windIntensity(WIND_START + 50)).toBeGreaterThan(0);
    expect(windIntensity(WIND_FULL)).toBeCloseTo(1, 6);
    expect(windIntensity(10000)).toBeCloseTo(1, 6);
    expect(windIntensity(Number.NaN)).toBe(0);
  });

  it('rises monotonically with speed; airborne is louder than on the ground', () => {
    let prev = windParams(0, true);
    for (let s = 100; s <= 3500; s += 100) {
      const p = windParams(s, true);
      expect(p.level).toBeGreaterThanOrEqual(prev.level);
      expect(p.highFreq).toBeGreaterThanOrEqual(prev.highFreq);
      expect(p.lowCutoff).toBeGreaterThanOrEqual(prev.lowCutoff);
      prev = p;
      expect(windParams(s, false).level).toBeLessThanOrEqual(p.level);
    }
    expect(windParams(2000, true).lowGain).toBeGreaterThan(windParams(2000, false).lowGain);
  });

  it('noise buffers loop seamlessly', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (const pink of [true, false]) {
      const s = noiseSamples(4000, 500, pink, rnd);
      expect(s.length).toBe(4000);
      let maxStep = 0;
      for (let i = 1; i < s.length; i++) maxStep = Math.max(maxStep, Math.abs(s[i] - s[i - 1]));
      expect(Math.abs(s[s.length - 1] - s[0])).toBeLessThanOrEqual(maxStep + 1e-6);
    }
  });
});

describe('SoundSystem', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is inert without WebAudio (node / before unlock)', () => {
    const s = new SoundSystem();
    expect(() => {
      s.unlock();
      s.play('jump');
      s.setWind(1500, true);
      s.setMasterVolume(0.3);
    }).not.toThrow();
  });

  it('drives the WebAudio graph: master volume from the volume cvar, wind, rate limiting, focus mute', () => {
    const listeners: Record<string, (() => void)[]> = {};
    const doc = { visibilityState: 'visible', hasFocus: () => true, addEventListener: (ev: string, fn: () => void) => (listeners[ev] ??= []).push(fn) };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', { AudioContext: FakeCtx, addEventListener: (ev: string, fn: () => void) => (listeners[ev] ??= []).push(fn) });
    const vol = registerCvar({ name: 'volume', default: '0.5' });
    const mute = registerCvar({ name: 'snd_mute_losefocus', default: '1' });
    const s = new SoundSystem();
    s.unlock();
    const ctx = FakeCtx.instances.at(-1)!;
    const gains = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain);
    const master = gains.find((g) => g.gain.value === 0.5)!;
    expect(master).toBeDefined();
    vol.set('0.2');
    expect(master.gain.events.at(-1)!.v).toBeCloseTo(0.2, 6);
    s.setMasterVolume(0.9);
    expect(master.gain.events.at(-1)!.v).toBeCloseTo(0.9, 6);

    // a looping wind source exists and follows speed
    const windSrc = ctx.nodes.find((n): n is FakeBufferSource => n instanceof FakeBufferSource && n.loop)!;
    expect(windSrc.started).not.toBeNull();
    s.setWind(2500, true);
    const lowGain = gains.find((g) => g.gain.events.some((e) => e.kind === 'target' && e.v === windParams(2500, true).lowGain));
    expect(lowGain).toBeDefined();

    // rate limiting: two footsteps in the same instant play once
    const before = ctx.nodes.length;
    s.play('footstep');
    const afterOne = ctx.nodes.length;
    s.play('footstep');
    expect(afterOne).toBeGreaterThan(before);
    expect(ctx.nodes.length).toBe(afterOne);
    ctx.currentTime += (MIN_INTERVAL.footstep ?? 0) + 0.01;
    s.play('footstep');
    expect(ctx.nodes.length).toBeGreaterThan(afterOne);

    // losing focus mutes (snd_mute_losefocus 1) and unmutes on focus
    const focusGain = gains.find((g) => g.gain.value === 1 && g !== master && reaches(g, ctx.destination) && g.outs[0] && !(g.outs[0] instanceof FakeGain))!;
    doc.visibilityState = 'hidden';
    for (const fn of listeners.visibilitychange ?? []) fn();
    expect(focusGain.gain.events.at(-1)!.v).toBe(0);
    const n0 = ctx.nodes.length;
    s.play('checkpoint');
    expect(ctx.nodes.length).toBe(n0); // muted: no new voices
    mute.set('0');
    expect(focusGain.gain.events.at(-1)!.v).toBe(1);
    doc.visibilityState = 'visible';
    console_.getCvar('volume')?.reset();
  });
});
