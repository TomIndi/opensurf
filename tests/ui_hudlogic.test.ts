import { describe, expect, it } from 'vitest';
import type { TimerHud } from '../src/game/api';
import { courseText, FpsMeter, FrameStats, HoldLatch, netGraphText, SpeedTrend, splitView, timerView } from '../src/ui/hudlogic';
import { PHASE_SPANS, phaseText, rawProgress, rescaleProgress } from '../src/ui/loadprogress';
import { clipNear } from '../src/ui/menubg';
import { hashString, mapThumbSvg, paletteFor, prng } from '../src/ui/thumbs';
import { SURF_TIPS, tipOrder } from '../src/ui/tips';

const T = (o: Partial<TimerHud> = {}): TimerHud => ({
  state: 'running',
  time: 47.12,
  stage: 3,
  stageCount: 8,
  stageTime: 12.3,
  checkpoint: 0,
  checkpointCount: 0,
  bonus: 0,
  pb: 83.45,
  wr: 79.66,
  mapType: 'staged',
  lastSplitDelta: null,
  lastSplitTime: 0,
  ...o,
});

describe('timer panel view', () => {
  it('SurfTimer states', () => {
    expect(timerView(T({ state: 'startzone' }))).toMatchObject({ main: 'Start Zone', cls: 'start', label: '' });
    expect(timerView(T({ state: 'startzone', bonus: 2 }))).toMatchObject({ main: 'Start Zone', label: 'Bonus 2', course: 'Bonus 2' });
    expect(timerView(T())).toMatchObject({ main: '00:47.12', cls: 'running', label: '' });
    expect(timerView(T({ state: 'finished', time: 83.45 }))).toMatchObject({ main: '01:23.45', cls: 'finished', label: 'Finished' });
    expect(timerView(T({ state: 'practice' }))).toMatchObject({ cls: 'practice', label: '[Practice]' });
    expect(timerView(T(), true)).toMatchObject({ cls: 'practice', label: '[Practice]' });
    expect(timerView(T({ state: 'stopped' }))).toMatchObject({ cls: 'stopped', label: 'Stopped' });
    expect(timerView(T({ state: 'disabled' }))).toMatchObject({ cls: 'disabled', main: 'No Timer' });
    // the box's WR is the KSF world record when known, else the local best
    expect(timerView(T({ wr: 60 }), false, 52.81).wr).toBe(timerView(T({ wr: 52.81 })).wr);
    expect(timerView(T({ wr: 60 }), false, null).wr).toBe(timerView(T({ wr: 60 })).wr);
    expect(timerView(T({ wr: null }), false, null).wr).toBe('None');
  });

  it('PB/WR text', () => {
    expect(timerView(T())).toMatchObject({ pb: '01:23.45', wr: '01:19.66' });
    expect(timerView(T({ pb: null, wr: 0 }))).toMatchObject({ pb: 'None', wr: 'None' });
  });

  it('course line: "Stage 3/8" or "Linear | CP 2/5"', () => {
    expect(courseText(T())).toBe('Stage 3/8');
    expect(courseText(T({ stage: 0 }))).toBe('Stage 1/8');
    expect(courseText(T({ stage: 12 }))).toBe('Stage 8/8');
    expect(courseText(T({ stageCount: 0, stage: 2 }))).toBe('Stage 2');
    expect(courseText(T({ mapType: 'linear', checkpoint: 2, checkpointCount: 5 }))).toBe('Linear | CP 2/5');
    expect(courseText(T({ mapType: 'linear' }))).toBe('Linear');
    expect(courseText(T({ bonus: 1 }))).toBe('Bonus 1');
  });

  it('split flash colours', () => {
    expect(splitView(-0.42)).toEqual({ text: '-0.42', cls: 'faster' });
    expect(splitView(1.5)).toEqual({ text: '+1.50', cls: 'slower' });
    expect(splitView(0)).toEqual({ text: '±0.00', cls: 'tie' });
    expect(splitView(null)).toBeNull();
  });
});

describe('speedometer trend (surf_speedometer_color)', () => {
  const run = (tr: SpeedTrend, speeds: number[], dt = 1 / 60) => speeds.map((s) => tr.update(s, dt));

  it('gaining speed turns green, losing turns red, steady is white', () => {
    const tr = new SpeedTrend();
    // +3 u/s per frame at 60 fps = 180 u/s² (normal air strafe gain)
    const up = run(tr, Array.from({ length: 30 }, (_, i) => 800 + i * 3));
    expect(up.at(-1)).toBe('gain');
    const down = run(tr, Array.from({ length: 40 }, (_, i) => 887 - i * 3));
    expect(down.at(-1)).toBe('loss');
    const flat = run(tr, Array.from({ length: 60 }, () => 770));
    expect(flat.at(-1)).toBe('steady');
  });

  it('does not flicker on noise (hysteresis + smoothing)', () => {
    const tr = new SpeedTrend();
    const states = run(tr, Array.from({ length: 120 }, (_, i) => 1000 + (i % 2 ? 0.4 : -0.4)));
    expect(new Set(states)).toEqual(new Set(['steady']));
  });

  it('resets on teleports and stalled frames', () => {
    const tr = new SpeedTrend();
    run(tr, Array.from({ length: 30 }, (_, i) => 800 + i * 3));
    expect(tr.state).toBe('gain');
    expect(tr.update(3000, 1 / 60)).toBe('steady'); // +2000 in a frame = teleport/booster reset
    run(tr, Array.from({ length: 10 }, () => 3000));
    expect(tr.update(3000, 2)).toBe('steady'); // long stall
    expect(tr.update(Number.NaN, 1 / 60)).toBe('steady');
  });

  it('is frame-rate independent', () => {
    const a = new SpeedTrend();
    const b = new SpeedTrend();
    for (let i = 0; i < 60; i++) a.update(500 + i * 2, 1 / 60); // 120 u/s²
    for (let i = 0; i < 240; i++) b.update(500 + i * 0.5, 1 / 240);
    expect(a.accel).toBeCloseTo(b.accel, 0);
    expect(a.state).toBe(b.state);
  });
});

describe('fps meter', () => {
  it('averages over the window', () => {
    const m = new FpsMeter(0.5);
    let updated = 0;
    for (let i = 0; i < 100; i++) if (m.tick(1 / 144)) updated++;
    expect(updated).toBe(1);
    expect(m.fps).toBeCloseTo(144, 0);
    expect(m.tick(5)).toBe(false);
  });
});

describe('showkeys hold latch', () => {
  it('keeps one-frame taps visible for the hold time', () => {
    const l = new HoldLatch(90);
    expect(l.update(false, 0)).toBe(false);
    expect(l.update(true, 100)).toBe(true);
    expect(l.update(false, 107)).toBe(true);
    expect(l.update(false, 189)).toBe(true);
    expect(l.update(false, 191)).toBe(false);
    l.update(true, 300);
    l.reset();
    expect(l.update(false, 301)).toBe(false);
  });
});

describe('net_graph', () => {
  it('frame statistics', () => {
    const f = new FrameStats(4);
    expect(f.stddev()).toBe(0);
    for (const v of [10, 10, 10, 10]) f.push(v);
    expect(f.mean()).toBe(10);
    expect(f.stddev()).toBe(0);
    f.push(20); // window of 4: 10, 10, 10, 20 (ring buffer)
    expect(f.count).toBe(4);
    expect(f.mean()).toBe(12.5);
    expect(f.stddev()).toBeCloseTo(5, 6);
    f.push(-1);
    f.push(5000);
    expect(f.mean()).toBe(12.5);
  });

  it('CS:GO-like text', () => {
    const t = netGraphText(143.6, 0.42, 100);
    expect(t.split('\n')[0]).toBe('fps:  144  var: 0.4 ms  ping: 0 ms');
    expect(t).toContain('tick:100.0');
    expect(netGraphText(60, 1, 64)).toContain('tick: 64.0');
  });
});

describe('loading progress', () => {
  it('phases cover 0..1 in order without gaps', () => {
    const spans = Object.values(PHASE_SPANS);
    expect(spans[0][0]).toBe(0);
    expect(spans.at(-1)![1]).toBe(1);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBe(spans[i - 1][1]);
  });

  it('maps byte counts into the download span', () => {
    expect(rawProgress({ phase: 'download', message: '', loaded: 25, total: 100 })).toBeCloseTo(0.125, 6);
    expect(rawProgress({ phase: 'textures', message: '' })).toBe(PHASE_SPANS.textures[0]);
    expect(rawProgress({ phase: 'done', message: '' })).toBe(1);
    expect(rawProgress({ phase: 'error', message: 'x' })).toBeNull();
    expect(rawProgress({ phase: 'download', message: '', loaded: 500, total: 100 })).toBe(PHASE_SPANS.download[1]);
  });

  it('rescales loads that start late (built-in / local files)', () => {
    const start = PHASE_SPANS.geometry[0];
    expect(rescaleProgress(start, start)).toBe(0);
    expect(rescaleProgress(1, start)).toBe(1);
    expect(rescaleProgress(0.5, 0)).toBe(0.5);
  });

  it('phase text', () => {
    expect(phaseText({ phase: 'download', message: 'Downloading 12.4 / 56.3 MB', loaded: 12.4 * 1048576, total: 56.3 * 1048576 })).toBe('Downloading 12.4 / 56.3 MB');
    expect(phaseText({ phase: 'download', message: 'Contacting Google Drive...' })).toBe('Contacting Google Drive…');
    expect(phaseText({ phase: 'download', message: 'Downloaded 56.3 MB', loaded: 5, total: 5 })).toBe('Downloaded 56.3 MB');
    expect(phaseText({ phase: 'download', message: 'Loaded from cache', loaded: 5, total: 5 })).toBe('Loaded from cache');
    expect(phaseText({ phase: 'collision', message: 'whatever' })).toBe('Building collision');
    expect(phaseText({ phase: 'textures', message: '' })).toBe('Decoding textures');
    expect(phaseText({ phase: 'renderer', message: '' })).toBe('Uploading to GPU');
    expect(phaseText({ phase: 'extract', message: '' })).toBe('Extracting');
  });
});

describe('menu background clipping', () => {
  it('clips polygons against the near plane', () => {
    const quad: [number, number, number][] = [
      [0, 0, -10],
      [10, 0, -10],
      [10, 0, 100],
      [0, 0, 100],
    ];
    const c = clipNear(quad);
    expect(c.length).toBe(4);
    for (const p of c) expect(p[2]).toBeGreaterThanOrEqual(12 - 1e-9);
    expect(clipNear(quad.map(([x, y]) => [x, y, -5] as [number, number, number]))).toEqual([]);
    expect(clipNear(quad.map(([x, y]) => [x, y, 50] as [number, number, number])).length).toBe(4);
  });

  it('clips segments', () => {
    const s = clipNear([
      [0, 0, 0],
      [0, 0, 100],
    ]);
    expect(s[0][2]).toBe(12);
    expect(s[1][2]).toBe(100);
    expect(clipNear([[0, 0, 1], [0, 0, 2]])).toEqual([]);
  });
});

describe('map thumbnails & tips', () => {
  it('thumbnails are deterministic per name and themed by keywords', () => {
    const strip = (s: string) => s.replace(/id="t[0-9a-z]+/g, 'id="X').replace(/url\(#t[0-9a-z]+/g, 'url(#X');
    expect(strip(mapThumbSvg('surf_kitsune'))).toBe(strip(mapThumbSvg('surf_kitsune')));
    expect(strip(mapThumbSvg('surf_kitsune'))).not.toBe(strip(mapThumbSvg('surf_utopia_njv')));
    expect(paletteFor('surf_christmas').id).toBe('ice');
    expect(paletteFor('surf_mesa_fixed').id).toBe('desert');
    expect(paletteFor('surf_nyx').id).toBe('space');
    expect(paletteFor('surf_zen').id).toBe('forest');
    const svg = mapThumbSvg('surf_x');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect((svg.match(/<polygon/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // unique gradient ids per instance (multiple thumbs on one page)
    const id1 = /id="(t[0-9a-z]+)s"/.exec(mapThumbSvg('surf_x'))![1];
    const id2 = /id="(t[0-9a-z]+)s"/.exec(mapThumbSvg('surf_x'))![1];
    expect(id1).not.toBe(id2);
  });

  it('hash/prng are stable', () => {
    expect(hashString('surf_utopia_njv')).toBe(hashString('surf_utopia_njv'));
    const a = prng(42);
    const b = prng(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });

  it('tip order is a permutation', () => {
    const o = tipOrder(1234);
    expect(o.length).toBe(SURF_TIPS.length);
    expect([...o].sort((x, y) => x - y)).toEqual(SURF_TIPS.map((_, i) => i));
    expect(tipOrder(1234)).toEqual(o);
  });
});
