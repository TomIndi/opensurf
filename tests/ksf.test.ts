// KSF world records: the replay file parser (synthetic files in KSF's layout), the conversion into our replays,
// board choice and fallback, the records JSON validation, the local proxy's route validation and the HTTP client
// (fake fetch). No network.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerConvars } from '../src/game/convars';
import { DUCKED_FLAG, FRAME_STRIDE, isTeleportStep, type ReplayData, ReplaySystem, replayFromKsf, sampleReplay, WR_GHOST_NAME } from '../src/game/replay';
import {
  boardForTickrate,
  createHttpKsfClient,
  formatKsfTime,
  formatKsfTimeShort,
  isKsfEligibleMap,
  type KsfBoard,
  type KsfClient,
  type KsfRecord,
  KsfService,
  KsfUnavailableError,
  ksfVideosUrl,
  otherBoard,
  parseKsfRecords,
} from '../src/maps/ksf';
import {
  isKsfBoard,
  isValidKsfMapName,
  isValidKsfReplayFile,
  KSF_PROXY_HEADER,
  ksfRecordsProxyPath,
  ksfRecordsUpstreamUrl,
  ksfReplayProxyPath,
  ksfReplayUpstreamUrl,
  parseKsfProxyRequest,
} from '../src/maps/ksfproxy';
import {
  buildKsfReplay,
  estimateTickInterval,
  KSF_FRAME_BYTES,
  KSF_ZONE_END,
  KSF_ZONE_STAGE,
  KSF_ZONE_START,
  type KsfZoneEvent,
  KsfReplayError,
  parseKsfReplay,
  type SyntheticKsfFrame,
} from '../src/maps/ksfreplay';
import { IN_DUCK, IN_FORWARD, IN_JUMP, IN_MOVELEFT, VIEW_OFFSET_STAND } from '../src/physics/playertypes';
import { formatTimeMs, formatTimeMsShort } from '../src/ui/format';

// ------------------------------------------------------------------------------------------ fixtures

/**
 * A synthetic run: `pre` frames standing in the start zone at (x0, 0, 0), then moving +x at `speed` u/s (positions
 * consistent with the tick interval `ti`), `post` frames after the end and two junk frames like real files.
 */
function syntheticRun(opts: { pre?: number; run?: number; post?: number; ti?: number; speed?: number; x0?: number; junk?: boolean } = {}): {
  frames: SyntheticKsfFrame[];
  start: number;
  end: number;
} {
  const pre = opts.pre ?? 40;
  const run = opts.run ?? 120;
  const post = opts.post ?? 5;
  const ti = opts.ti ?? 0.015;
  const speed = opts.speed ?? 1000;
  const x0 = opts.x0 ?? -13979.77;
  const frames: SyntheticKsfFrame[] = [];
  for (let k = 0; k < pre; k++) frames.push({ buttons: 0, origin: [x0, 272.2, 12800.03], angles: [26.7, 21.9, 0], velocity: [0, 0, 0] });
  for (let k = 0; k <= run + post; k++) {
    const buttons = IN_FORWARD | (k % 3 === 0 ? IN_JUMP : 0) | (k % 10 < 5 ? IN_DUCK : 0) | (k % 2 ? IN_MOVELEFT : 0);
    frames.push({ buttons, origin: [x0 + speed * ti * k, 272.2, 12800.03 - k], angles: [10, 90 + k * 0.1, 0], velocity: [speed, 0, -1 / ti] });
  }
  if (opts.junk !== false) {
    frames.push({ buttons: 4, origin: [0, 0, 5000], angles: [0, 0, 0], velocity: [0, 0, 0] });
    frames.push({ buttons: 4, origin: [-14096, 0, 12816], angles: [0, 0, 0], velocity: [0, 0, -6] });
  }
  return { frames, start: pre, end: pre + run };
}

function eventsFor(start: number, end: number, withStart = true): KsfZoneEvent[] {
  const ev: KsfZoneEvent[] = [];
  if (withStart) ev.push({ frame: start, type: KSF_ZONE_START, index: 1 });
  ev.push({ frame: start + 40, type: KSF_ZONE_STAGE, index: 2 }, { frame: start + 80, type: KSF_ZONE_STAGE, index: 3 }, { frame: end, type: KSF_ZONE_END, index: 99 });
  return ev;
}

function rec(time: number, name: string, file: string | null = null, rank = 0): KsfRecord {
  return { rank, name, steamId: '', country: 'Nowhere', time, completions: 1, date: 1784127388, recordId: 1, file };
}

class FakeClient implements KsfClient {
  calls: string[] = [];
  lists = new Map<string, KsfRecord[]>();
  files = new Map<string, Uint8Array>();
  unavailable = false;
  failing = false;
  async fetchRecords(map: string, board: KsfBoard): Promise<KsfRecord[]> {
    this.calls.push(`records ${map} ${board}`);
    if (this.unavailable) throw new KsfUnavailableError();
    if (this.failing) throw new Error('HTTP 502');
    return this.lists.get(`${map}|${board}`) ?? [];
  }
  async fetchReplay(file: string, board: KsfBoard): Promise<ArrayBuffer> {
    this.calls.push(`replay ${file} ${board}`);
    if (this.unavailable) throw new KsfUnavailableError();
    const f = this.files.get(file);
    if (!f) throw new Error('no such replay');
    return f.slice().buffer;
  }
}

// ------------------------------------------------------------------------------------------ the replay file

describe('KSF replay parser', () => {
  it('reads the layout: frame count at 8, frames at the end, zone events at 540 + 524 i', () => {
    const { frames, start, end } = syntheticRun();
    const file = buildKsfReplay(frames, eventsFor(start, end));
    const dv = new DataView(file.buffer);
    // the facts of real files, on the synthetic one
    expect(dv.getInt32(8, true)).toBe(frames.length);
    expect(dv.getInt32(12, true)).toBe(5); // 4 events + the block that overlaps the first frame
    const frameStart = file.byteLength - frames.length * KSF_FRAME_BYTES;
    expect(frameStart).toBe(540 + 524 * 4);
    expect(dv.getInt32(540, true)).toBe(start);
    expect(dv.getInt32(544, true)).toBe(KSF_ZONE_START);
    expect(dv.getInt32(548, true)).toBe(1);
    expect(dv.getFloat32(frameStart + 4, true)).toBeCloseTo(-13979.77, 2);

    const p = parseKsfReplay(file, { tickInterval: 0.015 });
    expect(p.totalFrames).toBe(frames.length);
    expect(p.startFrame).toBe(start);
    expect(p.startSource).toBe('event');
    expect(p.endFrame).toBe(end);
    expect(p.frameCount).toBe(end + 1); // post-finish and junk frames dropped
    expect(p.time).toBeCloseTo((end - start) * 0.015, 9);
    expect(p.tickInterval).toBe(0.015);
    // the junk "block" (the first frame read as an event) is not an event
    expect(p.events.map((e) => [e.frame, e.type, e.index])).toEqual([
      [start, 3, 1],
      [start + 40, 1, 2],
      [start + 80, 1, 3],
      [end, 2, 99],
    ]);
    // per-frame data
    const k = start + 7;
    expect(p.origins[k * 3]).toBeCloseTo(-13979.77 + 1000 * 0.015 * 7, 2);
    expect(p.angles[k * 3 + 1]).toBeCloseTo(90.7, 4);
    expect(p.velocities[k * 3]).toBe(1000);
    expect(p.buttons[k]).toBe(frames[k].buttons);
  });

  it('checks the tick interval against the motion (distance per frame / stored velocity)', () => {
    const r66 = syntheticRun({ ti: 0.015 });
    const r100 = syntheticRun({ ti: 0.01 });
    const f66 = buildKsfReplay(r66.frames, eventsFor(r66.start, r66.end));
    const f100 = buildKsfReplay(r100.frames, eventsFor(r100.start, r100.end));
    expect(parseKsfReplay(f66).tickInterval).toBe(0.015);
    expect(parseKsfReplay(f100).tickInterval).toBe(0.01);
    // a wrong board is corrected by the motion
    expect(parseKsfReplay(f66, { tickInterval: 0.01 }).tickInterval).toBe(0.015);
    expect(parseKsfReplay(f100, { tickInterval: 0.015 }).tickInterval).toBe(0.01);
    const p = parseKsfReplay(f100);
    expect(estimateTickInterval(p.origins, p.velocities, p.frameCount)).toBeCloseTo(0.01, 6);
    // too little motion to tell: the board's interval
    const still = syntheticRun({ run: 10, ti: 0.01 });
    expect(parseKsfReplay(buildKsfReplay(still.frames, eventsFor(still.start, still.end).filter((e) => e.frame <= still.end)), { tickInterval: 0.01 }).tickInterval).toBe(0.01);
  });

  it('run start without a start event: the header (offset 16), else the record time', () => {
    const { frames, start, end } = syntheticRun({ ti: 0.01 });
    const header = parseKsfReplay(buildKsfReplay(frames, eventsFor(start, end, false), { headerStart: start }), { tickInterval: 0.01 });
    expect(header.startFrame).toBe(start);
    expect(header.startSource).toBe('header');
    const fromTime = parseKsfReplay(buildKsfReplay(frames, eventsFor(start, end, false)), { tickInterval: 0.01, expectedTime: (end - start) * 0.01 + 0.002 });
    expect(fromTime.startFrame).toBe(start);
    expect(fromTime.startSource).toBe('time');
    const none = parseKsfReplay(buildKsfReplay(frames, eventsFor(start, end, false)), { tickInterval: 0.01 });
    expect(none.startFrame).toBe(0);
    expect(none.startSource).toBe('none');
    // an event that disagrees with the leaderboard time loses to it
    const off = parseKsfReplay(buildKsfReplay(frames, eventsFor(start - 20, end)), { tickInterval: 0.01, expectedTime: (end - start) * 0.01 });
    expect(off.startFrame).toBe(start);
  });

  it('staged maps: type 2 marks every stage reached, the end is type 2 index 99; type 3 every stage start', () => {
    const { frames, start, end } = syntheticRun({ run: 150 });
    const staged: KsfZoneEvent[] = [
      { frame: start, type: KSF_ZONE_START, index: 1 },
      { frame: start + 30, type: KSF_ZONE_END, index: 2 },
      { frame: start + 40, type: KSF_ZONE_START, index: 2 },
      { frame: start + 90, type: KSF_ZONE_END, index: 3 },
      { frame: start + 100, type: KSF_ZONE_START, index: 3 },
      { frame: end, type: KSF_ZONE_END, index: 99 },
    ];
    const p = parseKsfReplay(buildKsfReplay(frames, staged), { tickInterval: 0.015, expectedTime: (end - start) * 0.015 });
    expect(p.startFrame).toBe(start);
    expect(p.startSource).toBe('event');
    expect(p.endFrame).toBe(end);
    expect(p.events.length).toBe(6);
  });

  it('without an end event the trailing teleport frames are dropped', () => {
    const { frames, start, end } = syntheticRun({ post: 0 });
    const p = parseKsfReplay(buildKsfReplay(frames, [{ frame: start, type: KSF_ZONE_START, index: 1 }]), { tickInterval: 0.015 });
    expect(p.endFrame).toBe(end);
  });

  it('ignores implausible zone blocks and rejects garbage', () => {
    const { frames, start, end } = syntheticRun();
    const ev = [...eventsFor(start, end), { frame: 99999, type: 1, index: 5 }, { frame: 3, type: 7, index: 1 }];
    const p = parseKsfReplay(buildKsfReplay(frames, ev), { tickInterval: 0.015 });
    expect(p.events.length).toBe(4);
    // an absurd block count is clamped, not trusted
    expect(parseKsfReplay(buildKsfReplay(frames, eventsFor(start, end), { blockCount: 1e9 }), { tickInterval: 0.015 }).endFrame).toBe(end);

    expect(() => parseKsfReplay(new Uint8Array(20))).toThrow(KsfReplayError);
    const bad = buildKsfReplay(frames, eventsFor(start, end));
    const dv = new DataView(bad.buffer);
    const n = frames.length;
    dv.setInt32(8, -5, true);
    expect(() => parseKsfReplay(bad)).toThrow(/frame count/);
    dv.setInt32(8, n * 1000, true);
    expect(() => parseKsfReplay(bad)).toThrow(KsfReplayError);
    dv.setInt32(8, n, true);
    // a NaN inside the run is garbage; after the finish it doesn't matter
    const frameStart = bad.byteLength - n * KSF_FRAME_BYTES;
    dv.setFloat32(frameStart + (start + 3) * KSF_FRAME_BYTES + 4, NaN, true);
    expect(() => parseKsfReplay(bad)).toThrow(/garbage/);
    dv.setFloat32(frameStart + (start + 3) * KSF_FRAME_BYTES + 4, 0, true);
    dv.setFloat32(frameStart + (end + 2) * KSF_FRAME_BYTES + 4, NaN, true);
    expect(parseKsfReplay(bad, { tickInterval: 0.015 }).endFrame).toBe(end);
    // an end before the start: no run
    expect(() => parseKsfReplay(buildKsfReplay(frames, [{ frame: 10, type: KSF_ZONE_START, index: 1 }, { frame: 10, type: KSF_ZONE_END, index: 99 }]))).toThrow(/no run/);
  });

  it('stage teleport markers (a frame far from both neighbours) take the next frame\'s position and view', () => {
    // a staged run: stage 1 along +x at (-15000.., -11500, 400), a stage teleport to (-13312, -15072, -320) with
    // KSF's marker frame (0, 0, 1000) in between, stage 2 along +x; then a second teleport with a marker that isn't
    // exactly on the axis (surf_kitsune's (0, -27.41, 7000)); and one plain teleport without a marker
    const ti = 0.01;
    const frames: SyntheticKsfFrame[] = [];
    const move = (x: number, y: number, z: number, yaw: number) => frames.push({ buttons: IN_FORWARD, origin: [x, y, z], angles: [10, yaw, 0], velocity: [900, 0, -50] });
    for (let k = 0; k < 30; k++) move(-15000 + k * 9, -11500, 400, 91);
    const marker1 = frames.length;
    frames.push({ buttons: IN_FORWARD | IN_DUCK, origin: [0, 0, 1000], angles: [0, 0, 0], velocity: [900, 0, -58] });
    for (let k = 0; k < 30; k++) move(-13312 + k * 9, -15072, -320, 90);
    const marker2 = frames.length;
    frames.push({ buttons: IN_FORWARD, origin: [0, -27.41, 7000], angles: [0, 0, 0], velocity: [900, 0, -58] });
    for (let k = 0; k < 30; k++) move(8192 + k * 9, -512, 6624, 270);
    const plain = frames.length;
    for (let k = 0; k < 30; k++) move(-5120 + k * 9, -15072, -5312, 90);
    const end = frames.length - 1;
    const p = parseKsfReplay(
      buildKsfReplay(frames, [
        { frame: 0, type: KSF_ZONE_START, index: 1 },
        { frame: marker1 + 2, type: KSF_ZONE_END, index: 2 },
        { frame: end, type: KSF_ZONE_END, index: 99 },
      ]),
      { tickInterval: ti },
    );
    expect(p.markers).toEqual([marker1, marker2]);
    for (const m of [marker1, marker2]) {
      expect([...p.origins.slice(m * 3, m * 3 + 3)]).toEqual([...p.origins.slice((m + 1) * 3, (m + 2) * 3)]);
      expect([...p.angles.slice(m * 3, m * 3 + 3)]).toEqual([...p.angles.slice((m + 1) * 3, (m + 2) * 3)]);
    }
    // the tick's own buttons and velocity stay
    expect(p.buttons[marker1]).toBe(IN_FORWARD | IN_DUCK);
    expect(p.velocities[marker1 * 3 + 2]).toBeCloseTo(-58, 4);
    // the plain teleport is untouched (it is a real move: the replay snaps over it, see sampleReplay)
    expect(p.origins[plain * 3]).toBeCloseTo(-5120, 3);
    expect(p.origins[(plain - 1) * 3]).toBeCloseTo(8192 + 29 * 9, 3);
    // nothing of the run is near the map origin any more
    for (let k = 0; k < p.frameCount; k++) expect(Math.abs(p.origins[k * 3]) + Math.abs(p.origins[k * 3 + 1])).toBeGreaterThan(500);
    // ... and the replay never passes through it: every sample is at one of the two frames around a teleport
    const data = replayFromKsf(p, 'surf_kitsune');
    for (let t = 0; t <= p.time; t += ti / 4) {
      const smp = sampleReplay(data, t)!;
      expect(Math.abs(smp.origin.x) + Math.abs(smp.origin.y)).toBeGreaterThan(500);
    }
  });

  const realFile = process.env.SURF_TEST_KSF_REPLAY;
  it.skipIf(!realFile || !existsSync(realFile))('parses a real KSF replay ($SURF_TEST_KSF_REPLAY: surf_utopia_njv 66 tick WR)', () => {
    const p = parseKsfReplay(readFileSync(realFile!), { tickInterval: 0.015, expectedTime: 53.36414337158203 });
    expect(p.totalFrames).toBe(3881);
    expect(p.startFrame).toBe(310);
    expect(p.endFrame).toBe(3868);
    expect(p.time).toBeCloseTo(53.37, 2);
    expect(p.origins[0]).toBeCloseTo(-13979.8, 1);
    expect(p.origins[2]).toBeCloseTo(12800.03, 1);
    expect(p.markers).toEqual([]);
  });

  // a staged map's replay with stage teleport markers, e.g. surf_kitsune's 100 tick WR (not committed: KSF's data)
  const stagedFile = process.env.SURF_TEST_KSF_REPLAY_STAGED;
  it.skipIf(!stagedFile || !existsSync(stagedFile))('real staged replay: its stage teleport markers are removed ($SURF_TEST_KSF_REPLAY_STAGED)', () => {
    const p = parseKsfReplay(readFileSync(stagedFile!), { tickInterval: 0.01 });
    expect(p.markers.length).toBeGreaterThan(0);
    const data = replayFromKsf(p, 'staged');
    for (let k = 0; k < p.frameCount; k++) expect(Math.abs(p.origins[k * 3]) + Math.abs(p.origins[k * 3 + 1])).toBeGreaterThan(100);
    for (let t = 0; t <= p.time; t += p.tickInterval / 2) {
      const smp = sampleReplay(data, t)!;
      expect(Math.abs(smp.origin.x) + Math.abs(smp.origin.y)).toBeGreaterThan(100);
    }
  });
});

describe('replay sampling across teleports', () => {
  /** Our own replay format: 20 frames along +x (10 units / tick at 100 tick), a teleport of 5000 units, 20 more. */
  function teleportReplay(): ReplayData {
    const frames = new Float32Array(40 * FRAME_STRIDE);
    for (let k = 0; k < 40; k++) {
      const o = k * FRAME_STRIDE;
      frames[o] = k < 20 ? k * 10 : 5000 + (k - 20) * 10;
      frames[o + 1] = 0;
      frames[o + 2] = 100;
      frames[o + 4] = k < 20 ? 0 : 180;
    }
    return { map: 'surf_t', group: 0, time: 0.39, tickrate: 100, frames, date: 0 };
  }

  it('snaps to the nearer frame instead of sliding through the map (PB replays and ghosts too)', () => {
    const r = teleportReplay();
    expect(isTeleportStep(r, 19)).toBe(true);
    expect(isTeleportStep(r, 18)).toBe(false);
    expect(isTeleportStep(r, 39)).toBe(false);
    // between frames 19 and 20
    const a = sampleReplay(r, 0.193)!;
    expect(a.origin.x).toBeCloseTo(190, 3);
    expect(a.angles.yaw).toBeCloseTo(0, 3);
    const b = sampleReplay(r, 0.197)!;
    expect(b.origin.x).toBeCloseTo(5000, 3);
    expect(b.angles.yaw).toBeCloseTo(180, 3);
    // the time stays the clock's
    expect(b.time).toBeCloseTo(0.197, 9);
    // the speed (from the frames: no stored velocities) never is the teleport distance
    expect(a.speed).toBeCloseTo(1000, 1);
    expect(b.speed).toBeCloseTo(1000, 1);
    // an ordinary step still interpolates
    expect(sampleReplay(r, 0.055)!.origin.x).toBeCloseTo(55, 3);
    // the ghost too
    const sys = new ReplaySystem('surf_t');
    sys.setPb(r);
    expect(sys.ghostAt(0.195)!.origin.x === 190 || sys.ghostAt(0.195)!.origin.x === 5000).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ into our replays

describe('KSF replay as a ReplayData', () => {
  registerConvars();
  const { frames, start, end } = syntheticRun({ ti: 0.015 });
  const parsed = parseKsfReplay(buildKsfReplay(frames, eventsFor(start, end)), { tickInterval: 0.015 });
  const data = replayFromKsf(parsed, 'surf_utopia_njv', { time: 1.79, date: 5 });

  it('keeps its own frame rate, the prestrafe, the buttons, ducking from IN_DUCK and the velocities', () => {
    expect(data.tickrate).toBeCloseTo(1 / 0.015, 9);
    expect(data.time).toBe(1.79);
    expect(data.startFrame).toBe(start);
    expect(data.frames.length).toBe((end + 1) * FRAME_STRIDE);
    const k = start + 5; // IN_DUCK on k % 10 < 5 of the run: run frame 5 is not ducked, 4 is
    expect(data.frames[k * FRAME_STRIDE + 5] & DUCKED_FLAG).toBe(0);
    expect(data.frames[(k - 1) * FRAME_STRIDE + 5] & DUCKED_FLAG).toBe(DUCKED_FLAG);
    // run time 0 is the start frame; negative times reach into the prestrafe
    const s0 = sampleReplay(data, 0)!;
    expect(s0.origin.x).toBeCloseTo(-13979.77, 2);
    expect(s0.time).toBe(0);
    const pre = sampleReplay(data, -0.3)!;
    expect(pre.time).toBeCloseTo(-0.3, 6);
    expect(pre.speed).toBe(0);
    const mid = sampleReplay(data, 0.5)!;
    expect(mid.origin.x).toBeCloseTo(-13979.77 + 500, 1);
    expect(mid.speed).toBeCloseTo(1000, 3); // the stored velocity
    expect(mid.velocity!.z).toBeCloseTo(-1 / 0.015, 3);
    expect(mid.buttons & IN_FORWARD).toBe(IN_FORWARD);
    const last = sampleReplay(data, 100)!;
    expect(last.finished).toBe(true);
    expect(last.time).toBeCloseTo((end - start) * 0.015, 6);
  });

  it('is spectated from the prestrafe and raced as a gold "KSF WR" ghost', () => {
    const r = new ReplaySystem('surf_utopia_njv');
    expect(r.wrGhostAt(0)).toBeNull();
    r.setWrReplay(data);
    const g = r.wrGhostAt(0.5)!;
    expect(g.id).toBe('ksf:wr');
    expect(g.name).toBe(WR_GHOST_NAME);
    expect(g.name).toBe('KSF WR');
    expect(g.color).toEqual([1, 0.72, 0.18]);
    expect(g.origin.x).toBeCloseTo(-13979.77 + 500, 1);
    // the PB ghost is separate
    expect(r.ghostAt(0.5)).toBeNull();
    expect(r.spectateData(data)).toBe(true);
    const v0 = r.spectateView(0)!;
    expect(v0.time).toBeCloseTo(-start * 0.015, 6); // the prestrafe first
    expect(v0.origin.z).toBeCloseTo(12800.03 + VIEW_OFFSET_STAND, 2);
    const v1 = r.spectateView(start * 0.015 + 0.5)!;
    expect(v1.time).toBeCloseTo(0.5, 6);
    expect(v1.speed).toBeCloseTo(1000, 3);
    // forgetting the WR replay (another board) removes the ghost; watching it carries on until left
    r.setWrReplay(null);
    expect(r.wrGhostAt(0.5)).toBeNull();
    expect(r.spectating).toBe(true);
    r.spectateData(null);
    expect(r.spectating).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ records, boards

describe('KSF records and boards', () => {
  it('board choice: 100 tick -> 100t, anything else -> 66t', () => {
    expect(boardForTickrate(100)).toBe('100t');
    expect(boardForTickrate(100.2)).toBe('100t');
    for (const t of [64, 66.67, 85.3, 102.4, 128, NaN]) expect(boardForTickrate(t)).toBe('66t');
    expect(otherBoard('66t')).toBe('100t');
    expect(otherBoard('100t')).toBe('66t');
  });

  it('validates ksf.surf JSON', () => {
    const list = parseKsfRecords([
      { rank: 2, name: 'T', steamID: 'STEAM_0:1:2', country: 'United Kingdom', time: 53.36993, completions: 24, date: 1670080358, record_id: 7, file: 'replay_css_1145_0_653341_1670080358.rec' },
      { rank: 1, name: ':(\u0007‮', time: 53.36414337158203, date: 1784127388, file: 'replay_css_1145_0_812716_1784127388.rec' },
      { rank: 3, name: 'x'.repeat(80), time: '53.4', file: '../../etc/passwd' },
      { rank: 4, name: 'bad', time: -1 },
      { rank: 5, name: 'nan', time: 'abc' },
      null,
      'garbage',
      { rank: 6, name: 'nofile', time: 60, file: null },
    ]);
    expect(list.map((r) => r.rank)).toEqual([1, 2, 3, 6]);
    expect(list[0].name).toBe(':(');
    expect(list[0].file).toBe('replay_css_1145_0_812716_1784127388.rec');
    expect(list[1].steamId).toBe('STEAM_0:1:2');
    expect(list[2].name.length).toBe(32);
    expect(list[2].time).toBeCloseTo(53.4, 9);
    expect(list[2].file).toBeNull(); // not a replay file name
    expect(list[3].file).toBeNull();
    expect(parseKsfRecords('<!DOCTYPE html>')).toEqual([]);
    expect(parseKsfRecords({ error: 'x' })).toEqual([]);
    expect(parseKsfRecords([])).toEqual([]);
  });

  it('the WR of the tickrate board, else the other board; cached; none', async () => {
    const c = new FakeClient();
    c.lists.set('surf_a|100t', [rec(50, 'hundred', 'replay_css100t_1_0_1_1.rec', 1)]);
    c.lists.set('surf_a|66t', [rec(51, 'sixty', 'replay_css_1_0_1_1.rec', 1)]);
    c.lists.set('surf_b|66t', [rec(70, 'only66', null, 1)]);
    const svc = new KsfService(c);
    const a100 = await svc.worldRecord('surf_A', 100);
    expect(a100.status === 'ok' && [a100.board, a100.wr.name, a100.fallback]).toEqual(['100t', 'hundred', false]);
    const a64 = await svc.worldRecord('surf_a', 64);
    expect(a64.status === 'ok' && [a64.board, a64.wr.name]).toEqual(['66t', 'sixty']);
    const b = await svc.worldRecord('surf_b', 100);
    expect(b.status === 'ok' && [b.board, b.preferred, b.fallback, b.wr.name]).toEqual(['66t', '100t', true, 'only66']);
    expect(await svc.worldRecord('surf_none', 100)).toEqual({ status: 'none', map: 'surf_none', preferred: '100t' });
    const calls = c.calls.length;
    await svc.worldRecord('surf_a', 100);
    await svc.worldRecord('surf_b', 100);
    expect(c.calls.length).toBe(calls); // cached per map + board
    expect(svc.peekWorldRecord('surf_b', 100)?.status).toBe('ok');
    expect(svc.peekWorldRecord('surf_unknown', 100)).toBeNull();
    expect(svc.available).toBe(true);
  });

  it('without the local server: unavailable once for the session; errors are retried later', async () => {
    const c = new FakeClient();
    c.unavailable = true;
    const svc = new KsfService(c);
    const r = await svc.worldRecord('surf_a', 100);
    expect(r.status).toBe('unavailable');
    expect(r.status === 'unavailable' && r.message).toContain('npm run dev / npm run preview');
    await svc.worldRecord('surf_b', 100);
    expect(c.calls.length).toBe(1);
    expect(svc.available).toBe(false);

    const c2 = new FakeClient();
    c2.failing = true;
    const svc2 = new KsfService(c2);
    expect((await svc2.worldRecord('surf_a', 100)).status).toBe('error');
    expect((await svc2.worldRecord('surf_a', 100)).status).toBe('error');
    expect(c2.calls.length).toBe(1); // not hammered right away
  });

  it('downloads and parses a replay once', async () => {
    const c = new FakeClient();
    const run = syntheticRun({ ti: 0.01 });
    c.files.set('replay_css100t_1_0_1_1.rec', buildKsfReplay(run.frames, eventsFor(run.start, run.end)));
    const svc = new KsfService(c);
    const r = rec((run.end - run.start) * 0.01, 'x', 'replay_css100t_1_0_1_1.rec', 1);
    const [p1, p2] = await Promise.all([svc.replay(r, '100t'), svc.replay(r, '100t')]);
    expect(p1).toBe(p2);
    expect(p1.tickInterval).toBe(0.01);
    expect(c.calls.filter((x) => x.startsWith('replay')).length).toBe(1);
    expect(svc.hasReplay(r)).toBe(true);
    await expect(svc.replay(rec(1, 'nofile'), '100t')).rejects.toThrow(/no replay/);
    // a failed download isn't cached
    const missing = rec(1, 'm', 'replay_css_9_0_9_9.rec');
    await expect(svc.replay(missing, '66t')).rejects.toThrow();
    expect(svc.hasReplay(missing)).toBe(false);
  });

  it('asks KSF about catalog / surf maps only, never the built-in maps', () => {
    expect(isKsfEligibleMap('surf_utopia_njv')).toBe(true);
    expect(isKsfEligibleMap('surf_whatever_dropped')).toBe(true);
    expect(isKsfEligibleMap('surf_tutorial')).toBe(false); // a built-in map id
    expect(isKsfEligibleMap('surf_x', true)).toBe(false);
    expect(isKsfEligibleMap('de_dust2')).toBe(false);
    expect(isKsfEligibleMap('../surf_x')).toBe(false);
    expect(isKsfEligibleMap(null)).toBe(false);
  });

  it('formats times and links', () => {
    expect(formatKsfTime(53.36414337158203)).toBe('00:53.364');
    expect(formatKsfTime(91.934898)).toBe('01:31.934');
    expect(formatKsfTime(3723.4567)).toBe('1:02:03.456');
    expect(formatKsfTimeShort(53.364)).toBe('0:53.364');
    expect(formatTimeMs(53.36414337158203)).toBe('00:53.364');
    expect(formatTimeMsShort(53.36414337158203)).toBe('0:53.364');
    expect(formatTimeMsShort(91.934898)).toBe('1:31.934');
    expect(ksfVideosUrl('surf_Utopia_njv')).toBe('https://www.youtube.com/@ksfrecords/search?query=surf_utopia_njv');
  });
});

// ------------------------------------------------------------------------------------------ the proxy

describe('KSF proxy routes', () => {
  it('builds the only upstream URLs it fetches (ksf.surf game values css / css100t)', () => {
    expect(ksfRecordsUpstreamUrl('surf_utopia_njv', '66t')).toBe('https://ksf.surf/api/maps/surf_utopia_njv/records/zone/0/0?game=css&mode=0');
    expect(ksfRecordsUpstreamUrl('surf_utopia_njv', '100t')).toBe('https://ksf.surf/api/maps/surf_utopia_njv/records/zone/0/0?game=css100t&mode=0');
    expect(ksfReplayUpstreamUrl('replay_css_1145_0_812716_1784127388.rec', '66t')).toBe('https://ksf.surf/api/replays/replay_css_1145_0_812716_1784127388.rec?game=css');
    expect(() => ksfRecordsUpstreamUrl('../x', '66t')).toThrow();
    expect(() => ksfReplayUpstreamUrl('x.rec', '66t')).toThrow();
    expect(ksfRecordsProxyPath('Surf_A', '100t')).toBe('./__ksf/records/surf_a?game=100t');
    expect(ksfReplayProxyPath('replay_css_1_0_1_1.rec', '66t')).toBe('./__ksf/replay/replay_css_1_0_1_1.rec?game=66t');
  });

  it('parses valid requests (also under a base path)', () => {
    expect(parseKsfProxyRequest('/__ksf/records/surf_utopia_njv?game=100t')).toEqual({
      kind: 'records',
      map: 'surf_utopia_njv',
      board: '100t',
      upstream: 'https://ksf.surf/api/maps/surf_utopia_njv/records/zone/0/0?game=css100t&mode=0',
    });
    expect(parseKsfProxyRequest('/surf/__ksf/replay/replay_css_1145_0_812716_1784127388.rec?game=66t')).toEqual({
      kind: 'replay',
      file: 'replay_css_1145_0_812716_1784127388.rec',
      board: '66t',
      upstream: 'https://ksf.surf/api/replays/replay_css_1145_0_812716_1784127388.rec?game=css',
    });
    expect(parseKsfProxyRequest('/__ksf/records/SURF_Mesa.v2-fix?game=66t')).toMatchObject({ map: 'surf_mesa.v2-fix' });
  });

  it('refuses anything else', () => {
    expect(parseKsfProxyRequest('/index.html')).toBeNull();
    expect(parseKsfProxyRequest('/__drive/abc')).toBeNull();
    expect(parseKsfProxyRequest('/index.html?next=/__ksf/records/surf_a?game=66t')).toBeNull();
    const bad = [
      '/__ksf/records/..?game=66t',
      '/__ksf/records/..%2F..%2Fetc?game=66t',
      '/__ksf/records/%2e%2e?game=66t',
      '/__ksf/records/surf_a%2Fb?game=66t',
      '/__ksf/records/surf%20a?game=66t',
      `/__ksf/records/${'a'.repeat(65)}?game=66t`,
      '/__ksf/records/?game=66t',
      '/__ksf/records/surf_a', // no board
      '/__ksf/records/surf_a?game=css',
      '/__ksf/records/surf_a?game=128t',
      '/__ksf/records/surf_a/extra?game=66t',
      '/__ksf/replay/evil.rec?game=66t',
      '/__ksf/replay/replay_x.exe?game=66t',
      '/__ksf/replay/replay_..%2Fx.rec?game=66t',
      '/__ksf/replay/https%3A%2F%2Fevil.example%2Freplay_a.rec?game=66t',
      '/__ksf/fetch/https://evil.example?game=66t',
      '/__ksf/records/%E0%A4%A?game=66t',
    ];
    for (const u of bad) {
      const r = parseKsfProxyRequest(u);
      expect(r && 'error' in r, u).toBe(true);
    }
  });

  it('exports the validators', () => {
    expect(isKsfBoard('66t') && isKsfBoard('100t')).toBe(true);
    expect(isKsfBoard('css')).toBe(false);
    expect(isValidKsfMapName('surf_utopia_njv')).toBe(true);
    expect(isValidKsfMapName('a'.repeat(64))).toBe(true);
    expect(isValidKsfMapName('a'.repeat(65))).toBe(false);
    expect(isValidKsfMapName('.hidden')).toBe(false);
    expect(isValidKsfMapName('a..b')).toBe(false);
    expect(isValidKsfReplayFile('replay_css100t_1145_0_8278_1642348016.rec')).toBe(true);
    expect(isValidKsfReplayFile('replay_css_1.rec.exe')).toBe(false);
    expect(isValidKsfReplayFile(null)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ the HTTP client

describe('KSF HTTP client', () => {
  const response = (body: BodyInit | null, init: ResponseInit & { proxy?: boolean } = {}) => {
    const headers = new Headers(init.headers);
    if (init.proxy !== false) headers.set(KSF_PROXY_HEADER, '1');
    return new Response(body, { status: init.status ?? 200, headers });
  };

  it('reads the proxy routes; a missing proxy header means no local server', async () => {
    const urls: string[] = [];
    let next: () => Response = () => response('[]', { headers: { 'content-type': 'application/json' } });
    const client = createHttpKsfClient(async (u) => {
      urls.push(u);
      return next();
    });
    next = () => response(JSON.stringify([{ rank: 1, name: 'a', time: 50 }]), { headers: { 'content-type': 'application/json' } });
    expect((await client.fetchRecords('surf_a', '100t'))[0].name).toBe('a');
    expect(urls[0]).toBe('./__ksf/records/surf_a?game=100t');
    // unknown maps: [] or ksf.surf's HTML 404
    next = () => response('<!DOCTYPE html><html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    expect(await client.fetchRecords('surf_a', '66t')).toEqual([]);
    next = () => response('<!DOCTYPE html><html></html>', { headers: { 'content-type': 'text/html' } });
    expect(await client.fetchRecords('surf_a', '66t')).toEqual([]);
    next = () => response('upstream down', { status: 502 });
    await expect(client.fetchRecords('surf_a', '66t')).rejects.toThrow(/502/);
    // a static host: index.html without the proxy header
    next = () => response('<!doctype html>', { proxy: false, headers: { 'content-type': 'text/html' } });
    await expect(client.fetchRecords('surf_a', '66t')).rejects.toBeInstanceOf(KsfUnavailableError);
    next = () => response('', { status: 404, proxy: false });
    await expect(client.fetchReplay('replay_css_1_0_1_1.rec', '66t')).rejects.toBeInstanceOf(KsfUnavailableError);
    next = () => response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } });
    expect(new Uint8Array(await client.fetchReplay('replay_css_1_0_1_1.rec', '66t'))).toEqual(new Uint8Array([1, 2, 3]));
    expect(urls[urls.length - 1]).toBe('./__ksf/replay/replay_css_1_0_1_1.rec?game=66t');
  });

  it('a page without any server (fetch fails) is the same as no proxy', async () => {
    const client = createHttpKsfClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.fetchRecords('surf_a', '66t')).rejects.toBeInstanceOf(KsfUnavailableError);
  });
});
