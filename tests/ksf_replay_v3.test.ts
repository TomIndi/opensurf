// KSF replay files, format version 3 (ksf.surf's recorder since about August 2026) next to version 2: the layout
// (client settings block, 72-byte frames), the same run decoding the same in both, KSF's duplicated frame block (both
// versions), unknown versions and garbage. No network; optional real files behind environment variables (see the end).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildKsfReplay,
  estimateTickInterval,
  KSF_FRAME_BYTES,
  KSF_V3_FRAME_BYTES,
  KSF_ZONE_END,
  KSF_ZONE_STAGE,
  KSF_ZONE_START,
  type KsfZoneEvent,
  KsfReplayError,
  parseKsfReplay,
  type SyntheticKsfFrame,
} from '../src/maps/ksfreplay';
import { IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVELEFT, IN_MOVERIGHT } from '../src/physics/playertypes';

/** `pre` frames standing in the start zone, then a run along +x (strafing left / right), `post` frames, 2 junk frames. */
function run(opts: { pre?: number; run?: number; post?: number; ti?: number } = {}): { frames: SyntheticKsfFrame[]; start: number; end: number } {
  const pre = opts.pre ?? 40;
  const len = opts.run ?? 150;
  const post = opts.post ?? 6;
  const ti = opts.ti ?? 0.015;
  const frames: SyntheticKsfFrame[] = [];
  for (let k = 0; k < pre; k++) frames.push({ buttons: 0, origin: [-330, 70.5, 320.03], angles: [28, 74.3, 0], velocity: [0, 0, 0] });
  for (let k = 0; k <= len + post; k++) {
    const buttons = (k % 40 < 20 ? IN_MOVELEFT : IN_MOVERIGHT) | (k % 7 === 0 ? IN_JUMP : 0) | (k % 9 < 3 ? IN_DUCK : 0);
    frames.push({ buttons, origin: [-88 + 1200 * ti * k, 274 + k * 0.5, 325 - k], angles: [10, 90 + k * 0.2, 0], velocity: [1200, 0.5 / ti, -1 / ti] });
  }
  frames.push({ buttons: 4, origin: [0, 0, 5000], angles: [0, 0, 0], velocity: [0, 0, 0] });
  frames.push({ buttons: 4, origin: [-330, 70.5, 320.03], angles: [0, 0, 0], velocity: [0, 0, -6] });
  return { frames, start: pre, end: pre + len };
}

function events(start: number, end: number): KsfZoneEvent[] {
  return [
    { frame: start, type: KSF_ZONE_START, index: 1 },
    { frame: start + 50, type: KSF_ZONE_END, index: 2 },
    { frame: start + 60, type: KSF_ZONE_START, index: 2 },
    { frame: start + 100, type: KSF_ZONE_STAGE, index: 3 },
    { frame: end, type: KSF_ZONE_END, index: 99 },
  ];
}

const sameFrames = (a: ReturnType<typeof parseKsfReplay>, b: ReturnType<typeof parseKsfReplay>) => {
  expect(a.frameCount).toBe(b.frameCount);
  expect([...a.origins]).toEqual([...b.origins]);
  expect([...a.angles]).toEqual([...b.angles]);
  expect([...a.velocities]).toEqual([...b.velocities]);
  expect([...a.buttons]).toEqual([...b.buttons]);
};

describe('KSF replay format v3', () => {
  it('reads the layout: settings block at 24, event blocks from 24 + 4 W, 72-byte frames after them', () => {
    const { frames, start, end } = run();
    const file = buildKsfReplay(frames, events(start, end), { version: 3 });
    const dv = new DataView(file.buffer);
    // the facts of real v3 files, on the synthetic one
    expect(dv.getInt32(0, true)).toBe(3);
    expect(dv.getInt32(8, true)).toBe(frames.length);
    expect(dv.getInt32(12, true)).toBe(6); // block 0 + 5 events
    expect(dv.getInt32(16, true)).toBe(18);
    expect(dv.getInt32(20, true)).toBe(40);
    expect(dv.getFloat32(24, true)).toBeCloseTo(0.022, 6); // m_yaw
    const blocks = 24 + 4 * 40;
    expect([dv.getInt32(blocks, true), dv.getInt32(blocks + 4, true), dv.getInt32(blocks + 8, true)]).toEqual([0, 2, 1]);
    expect(dv.getInt32(blocks + 524, true)).toBe(start);
    const framesStart = blocks + 524 * 6;
    expect(file.byteLength).toBe(framesStart + frames.length * KSF_V3_FRAME_BYTES);
    const k = start + 21; // IN_MOVERIGHT: sidemove +400
    const o = framesStart + k * KSF_V3_FRAME_BYTES;
    expect(dv.getInt32(o, true)).toBe(frames[k].buttons);
    expect(dv.getFloat32(o + 4, true)).toBeCloseTo(frames[k].origin[0], 2);
    expect(dv.getInt32(o + 44, true) - dv.getInt32(o - KSF_V3_FRAME_BYTES + 44, true)).toBe(1); // tick counter
    expect(dv.getFloat32(o + 56, true)).toBe(400);

    const p = parseKsfReplay(file, { tickInterval: 0.015 });
    expect(p.version).toBe(3);
    expect(p.totalFrames).toBe(frames.length);
    expect(p.startFrame).toBe(start);
    expect(p.startSource).toBe('event');
    expect(p.endFrame).toBe(end);
    expect(p.frameCount).toBe(end + 1);
    expect(p.time).toBeCloseTo((end - start) * 0.015, 9);
    expect(p.tickInterval).toBe(0.015);
    expect(estimateTickInterval(p.origins, p.velocities, p.frameCount)).toBeCloseTo(0.015, 5);
    // block 0 is a real event ("in the start zone at frame 0"), never the finish
    expect(p.events.map((e) => [e.frame, e.type, e.index])).toEqual([[0, 2, 1], ...events(start, end).map((e) => [e.frame, e.type, e.index])]);
    expect(p.origins[k * 3]).toBeCloseTo(frames[k].origin[0], 2);
    expect(p.angles[k * 3 + 1]).toBeCloseTo(frames[k].angles[1], 4);
    expect(p.velocities[k * 3]).toBe(1200);
    expect(p.buttons[k]).toBe(frames[k].buttons);
  });

  it('the same run decodes the same from a v2 and a v3 file (66 and 100 tick, staged with a teleport marker)', () => {
    for (const ti of [0.015, 0.01]) {
      const { frames, start, end } = run({ ti });
      const v2 = parseKsfReplay(buildKsfReplay(frames, events(start, end)), { tickInterval: ti });
      const v3 = parseKsfReplay(buildKsfReplay(frames, events(start, end), { version: 3 }), { tickInterval: ti });
      expect(v2.version).toBe(2);
      expect(v3.version).toBe(3);
      sameFrames(v2, v3);
      expect([v3.startFrame, v3.endFrame, v3.time, v3.tickInterval]).toEqual([v2.startFrame, v2.endFrame, v2.time, v2.tickInterval]);
      // the motion alone tells the tick interval of a v3 file too
      expect(parseKsfReplay(buildKsfReplay(frames, events(start, end), { version: 3 })).tickInterval).toBe(ti);
    }
    // a stage teleport marker frame near the map origin
    const { frames, start, end } = run();
    const m = start + 55;
    frames[m] = { ...frames[m], origin: [0, 0, 7000] };
    const p = parseKsfReplay(buildKsfReplay(frames, events(start, end), { version: 3 }), { tickInterval: 0.015 });
    expect(p.markers).toEqual([m]);
    expect(p.origins[m * 3]).toBe(p.origins[(m + 1) * 3]);
  });

  it('without an end event: the trailing teleport frames are dropped (block 0, the start zone, is not the finish)', () => {
    const { frames, start, end } = run({ post: 0 });
    const p = parseKsfReplay(buildKsfReplay(frames, [{ frame: start, type: KSF_ZONE_START, index: 1 }], { version: 3 }), { tickInterval: 0.015 });
    expect(p.endFrame).toBe(end);
    expect(p.startFrame).toBe(start);
  });

  it('run start without a start event: block 0 (the header), else the record time', () => {
    const { frames, start, end } = run({ ti: 0.01 });
    const noStart = events(start, end).filter((e) => e.type !== KSF_ZONE_START);
    const header = parseKsfReplay(buildKsfReplay(frames, noStart, { version: 3, headerStart: start }), { tickInterval: 0.01 });
    expect([header.startFrame, header.startSource]).toEqual([start, 'header']);
    const fromTime = parseKsfReplay(buildKsfReplay(frames, noStart, { version: 3 }), { tickInterval: 0.01, expectedTime: (end - start) * 0.01 + 0.003 });
    expect([fromTime.startFrame, fromTime.startSource]).toEqual([start, 'time']);
  });

  it('rejects v3 files whose sizes don\'t add up, and garbage inside the run', () => {
    const { frames, start, end } = run();
    const ev = events(start, end);
    const good = buildKsfReplay(frames, ev, { version: 3 });
    // a v3 block count is exact: the frames' offset depends on it
    expect(() => parseKsfReplay(buildKsfReplay(frames, ev, { version: 3, blockCount: 7 }))).toThrow(/don't add up/);
    expect(() => parseKsfReplay(buildKsfReplay(frames, ev, { version: 3, blockCount: 1e9 }))).toThrow(/block count/);
    // the old reading of a v3 file (the last N * 40 bytes as v2 frames) is what produced nonsense near (0, 0, z)
    const asV2 = good.slice();
    new DataView(asV2.buffer).setInt32(0, 2, true);
    const wrong = (() => {
      try {
        return parseKsfReplay(asV2, { tickInterval: 0.015 });
      } catch {
        return null;
      }
    })();
    if (wrong) expect(wrong.origins[start * 3]).not.toBeCloseTo(frames[start].origin[0], 0);
    // a truncated file
    expect(() => parseKsfReplay(good.slice(0, good.byteLength - 10))).toThrow(KsfReplayError);
    expect(() => parseKsfReplay(good.slice(0, good.byteLength - KSF_V3_FRAME_BYTES))).toThrow(/don't add up/);
    // an absurd settings block
    const badWords = good.slice();
    new DataView(badWords.buffer).setInt32(20, -3, true);
    expect(() => parseKsfReplay(badWords)).toThrow(/settings size/);
    // a NaN inside the run
    const nan = good.slice();
    const framesStart = 24 + 4 * 40 + 524 * 6;
    new DataView(nan.buffer).setFloat32(framesStart + (start + 3) * KSF_V3_FRAME_BYTES + 8, NaN, true);
    expect(() => parseKsfReplay(nan)).toThrow(/garbage/);
  });

  it('rejects unknown format versions clearly', () => {
    const { frames, start, end } = run();
    for (const v of [0, 1, 4, 0x46534b]) {
      const file = buildKsfReplay(frames, events(start, end), { version: 3 });
      new DataView(file.buffer).setInt32(0, v, true);
      expect(() => parseKsfReplay(file)).toThrow(KsfReplayError);
      expect(() => parseKsfReplay(file)).toThrow(new RegExp(`version ${v} .*versions 2 and 3`));
    }
  });
});

describe("KSF's duplicated frame block", () => {
  // Real files (surf_garden / surf_beyond 100 tick, v2 and v3) hold N + 4000 frames: frames 4001 .. 8000 written a
  // second time after frame 8000. Here: 30 frames repeated after frame `at`.
  const dupCount = 30;
  for (const version of [2, 3] as const) {
    it(`v${version}: the copy is dropped, wherever it is (after the finish like the real ones, or inside the run)`, () => {
      // a long prestrafe standing still: in v2 (no tick counter) its frames repeat too, and must not be taken for the copy
      const { frames, start, end } = run({ pre: 3 * dupCount });
      const ref = parseKsfReplay(buildKsfReplay(frames, events(start, end), { version }), { tickInterval: 0.015 });
      for (const at of [end + 3, start + 70, dupCount]) {
        const file = buildKsfReplay(frames, events(start, end), { version, duplicate: { at, count: dupCount } });
        const frameBytes = version === 2 ? KSF_FRAME_BYTES : KSF_V3_FRAME_BYTES;
        expect(file.byteLength).toBe(buildKsfReplay(frames, events(start, end), { version }).byteLength + dupCount * frameBytes);
        const p = parseKsfReplay(file, { tickInterval: 0.015 });
        expect(p.totalFrames).toBe(frames.length);
        expect([p.startFrame, p.endFrame, p.time]).toEqual([ref.startFrame, ref.endFrame, ref.time]);
        sameFrames(p, ref);
      }
    });
  }

  it('extra frames that are not a copy: v2 reads the last N (as before), v3 the first N', () => {
    const { frames, start, end } = run();
    const extra = 5;
    for (const version of [2, 3] as const) {
      const base = buildKsfReplay(frames, events(start, end), { version });
      const frameBytes = version === 2 ? KSF_FRAME_BYTES : KSF_V3_FRAME_BYTES;
      const file = new Uint8Array(base.byteLength + extra * frameBytes);
      const framesStart = base.byteLength - frames.length * frameBytes;
      file.set(base.subarray(0, framesStart));
      // v2: the extra (distinct) frames before the run's; v3: after it
      const runAt = version === 2 ? framesStart + extra * frameBytes : framesStart;
      file.set(base.subarray(framesStart), runAt);
      const dv = new DataView(file.buffer);
      const extraAt = version === 2 ? framesStart : framesStart + frames.length * frameBytes;
      for (let i = 0; i < extra; i++) dv.setFloat32(extraAt + i * frameBytes + 4, 1000 + i, true);
      const p = parseKsfReplay(file, { tickInterval: 0.015 });
      sameFrames(p, parseKsfReplay(base, { tickInterval: 0.015 }));
    }
  });
});

// ------------------------------------------------------------------------------------------ real files (optional)

// A v3 file: surf_beginner 66 tick #4 (kusche, 45.725 s), https://ksf.surf/api/replays/replay_css_1019_0_348352_1789565017.rec?game=css
// (not committed: KSF's data)
const v3File = process.env.SURF_TEST_KSF_REPLAY_V3;
describe.skipIf(!v3File || !existsSync(v3File))('real KSF v3 replay ($SURF_TEST_KSF_REPLAY_V3: surf_beginner 66 tick #4)', () => {
  it('decodes the run: start / stage / end positions of the map, 45.73 s between the events', () => {
    const p = parseKsfReplay(readFileSync(v3File!), { tickInterval: 0.015, expectedTime: 45.72529602050781 });
    expect(p.version).toBe(3);
    expect(p.totalFrames).toBe(3497);
    expect([p.startFrame, p.startSource, p.endFrame]).toEqual([114, 'event', 3163]);
    expect(p.time).toBeCloseTo(45.735, 6);
    expect(estimateTickInterval(p.origins, p.velocities, p.frameCount)).toBeCloseTo(0.015, 4);
    const at = (k: number) => [...p.origins.slice(k * 3, k * 3 + 3)].map((x) => Math.round(x));
    // standing in the start zone, leaving it, entering stage 2's zone, the end zone (as in the v2 replays of the map)
    expect(at(0)).toEqual([-330, 70, 320]);
    expect(at(114)).toEqual([-88, 274, 325]);
    expect(at(266)).toEqual([2531, 2254, 662]);
    expect(at(3163)).toEqual([-5848, 7312, -656]);
    expect(p.events.filter((e) => e.type === KSF_ZONE_END).map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 99]);
  });
});

// A directory of replay_<css|css100t>_*.rec files (v2 and v3, e.g. downloaded from ksf.surf): every one parses and
// its run is physically consistent (board tick interval in the motion, steps that match the stored velocity, the
// run start near the first frame: a file whose frames are misplaced fails these).
const dir = process.env.SURF_TEST_KSF_REPLAY_DIR;
const dirFiles = dir && existsSync(dir) ? readdirSync(dir).filter((f) => /^replay_css(100t)?_.*\.rec$/.test(f)) : [];
describe.skipIf(!dirFiles.length)('real KSF replays ($SURF_TEST_KSF_REPLAY_DIR)', () => {
  it.each(dirFiles)('%s', (f) => {
    const ti = basename(f).startsWith('replay_css100t_') ? 0.01 : 0.015;
    const p = parseKsfReplay(readFileSync(join(dir!, f)), { tickInterval: ti });
    expect([2, 3]).toContain(p.version);
    expect(p.tickInterval).toBe(ti);
    expect(estimateTickInterval(p.origins, p.velocities, p.frameCount)! / ti).toBeCloseTo(1, 1);
    expect(p.time).toBeGreaterThan(5);
    const o = p.origins;
    const v = p.velocities;
    let bad = 0;
    for (let k = 1; k <= p.endFrame; k++) {
      const d = Math.hypot(o[k * 3] - o[k * 3 - 3], o[k * 3 + 1] - o[k * 3 - 2], o[k * 3 + 2] - o[k * 3 - 1]);
      const sp = Math.max(Math.hypot(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]), Math.hypot(v[k * 3 - 3], v[k * 3 - 2], v[k * 3 - 1]));
      if (d > sp * p.tickInterval * 1.5 + 2) bad++; // stage teleports, zone entries
    }
    expect(bad / p.endFrame).toBeLessThan(0.02);
    // the prestrafe is in the start zone, which the run start leaves
    const s = p.startFrame;
    expect(Math.hypot(o[s * 3] - o[0], o[s * 3 + 1] - o[1], o[s * 3 + 2] - o[2])).toBeLessThan(1500);
  });
});
