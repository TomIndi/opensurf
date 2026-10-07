import { beforeEach, describe, expect, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { RunRecord } from '../src/game/contracts';
import {
  MAX_RECORDS_PER_COURSE,
  RECORDS_STORAGE_KEY,
  RecordsStorage,
  addRecord,
  clearRecords,
  exportRecords,
  getCompletions,
  getPersonalBest,
  getRecords,
  importRecords,
  sanitizeRecord,
  setRecordsStorage,
} from '../src/game/records';
import { DUCKED_FLAG, FRAME_STRIDE, ReplaySystem, frameCount, replayDuration, sampleReplay } from '../src/game/replay';
import { IN_JUMP, VIEW_OFFSET_DUCK, VIEW_OFFSET_STAND } from '../src/physics/playertypes';

class MemStore implements RecordsStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

function rec(time: number, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    map: 'surf_utopia_njv',
    group: 0,
    time,
    stageSplits: [],
    checkpointSplits: [],
    jumps: 3,
    strafes: 10,
    sync: 80,
    tickrate: 100,
    date: 1000 + time,
    avgSpeed: 1200,
    maxSpeed: 2400,
    ...extra,
  };
}

let store: MemStore;
beforeEach(() => {
  store = new MemStore();
  setRecordsStorage(store);
});

describe('records', () => {
  it('keeps runs sorted by time with PB first, ranks and completions', () => {
    const a = addRecord(rec(50));
    expect(a).toMatchObject({ rank: 1, total: 1, isPb: true, previousPb: null, stored: true });
    const b = addRecord(rec(40));
    expect(b).toMatchObject({ rank: 1, total: 2, isPb: true, stored: true });
    expect(b.previousPb?.time).toBe(50);
    const c = addRecord(rec(45));
    expect(c).toMatchObject({ rank: 2, total: 3, isPb: false });
    expect(getRecords('surf_utopia_njv', 0).map((r) => r.time)).toEqual([40, 45, 50]);
    expect(getPersonalBest('SURF_UTOPIA_NJV', 0)?.time).toBe(40);
    expect(getCompletions('surf_utopia_njv', 0)).toBe(3);
    // equal time is not a PB
    expect(addRecord(rec(40, { date: 99999 })).isPb).toBe(false);
  });

  it('caps each course at the top 10', () => {
    for (let i = 0; i < 12; i++) addRecord(rec(100 + i));
    expect(getRecords('surf_utopia_njv', 0)).toHaveLength(MAX_RECORDS_PER_COURSE);
    const slow = addRecord(rec(500));
    expect(slow).toMatchObject({ rank: 0, stored: false, total: 13 });
    const fast = addRecord(rec(1));
    expect(fast).toMatchObject({ rank: 1, stored: true, total: 14 });
    expect(getRecords('surf_utopia_njv', 0).at(-1)?.time).toBe(108);
  });

  it('separates maps and courses; clear by course, map or all', () => {
    addRecord(rec(10));
    addRecord(rec(20, { group: 1 }));
    addRecord(rec(30, { map: 'surf_kitsune' }));
    expect(getRecords('surf_utopia_njv', 1).map((r) => r.time)).toEqual([20]);
    clearRecords('surf_utopia_njv', 1);
    expect(getRecords('surf_utopia_njv', 1)).toEqual([]);
    expect(getRecords('surf_utopia_njv', 0)).toHaveLength(1);
    clearRecords('surf_utopia_njv');
    expect(getRecords('surf_utopia_njv', 0)).toEqual([]);
    expect(getRecords('surf_kitsune', 0)).toHaveLength(1);
    clearRecords();
    expect(getRecords('surf_kitsune', 0)).toEqual([]);
  });

  it('persists to storage under surf.records.v1 and reloads', () => {
    addRecord(rec(42, { stageSplits: [0, 0, 10.5, 20.25] }));
    expect(store.m.has(RECORDS_STORAGE_KEY)).toBe(true);
    setRecordsStorage(store); // drop the cache, re-read from storage
    const r = getRecords('surf_utopia_njv', 0);
    expect(r[0].time).toBe(42);
    expect(r[0].stageSplits).toEqual([0, 0, 10.5, 20.25]);
    // corrupt storage -> empty
    store.m.set(RECORDS_STORAGE_KEY, '{nope');
    setRecordsStorage(store);
    expect(getRecords('surf_utopia_njv', 0)).toEqual([]);
  });

  it('exports and imports (merging, skipping duplicates and invalid runs)', () => {
    addRecord(rec(42));
    addRecord(rec(43));
    const json = exportRecords('surf_utopia_njv');
    setRecordsStorage(new MemStore());
    expect(importRecords(json)).toBe(2);
    expect(importRecords(json)).toBe(0); // duplicates
    expect(getRecords('surf_utopia_njv', 0).map((r) => r.time)).toEqual([42, 43]);
    expect(getCompletions('surf_utopia_njv', 0)).toBe(2);
    expect(importRecords('not json')).toBe(0);
    expect(importRecords(JSON.stringify([rec(41), { map: 'x', time: -1, group: 0 }]))).toBe(1);
    expect(getPersonalBest('surf_utopia_njv', 0)?.time).toBe(41);
  });

  it('sanitizeRecord rejects bad data and normalizes fields', () => {
    expect(sanitizeRecord(null)).toBeNull();
    expect(sanitizeRecord({ map: 'a', group: 0, time: 0 })).toBeNull();
    expect(sanitizeRecord({ map: 'a', group: -1, time: 5 })).toBeNull();
    const r = sanitizeRecord({ map: 'SURF_A', group: 2, time: 5, sync: 400, stageSplits: [1, 'x'] });
    expect(r).toMatchObject({ map: 'surf_a', group: 2, time: 5, sync: 100, stageSplits: [1, -1], jumps: 0 });
  });
});

describe('replays', () => {
  function recordLine(r: ReplaySystem, n: number, dx = 10, yaw0 = 0, dyaw = 0): void {
    for (let i = 0; i < n; i++) r.recordTick(v3(i * dx, 0, 100), { pitch: i, yaw: yaw0 + i * dyaw, roll: 0 }, i % 2 === 1, i === 0 ? IN_JUMP : 0);
  }

  it('records frames, saves the PB and interpolates the ghost', async () => {
    const r = new ReplaySystem('surf_test');
    r.recordTick(v3(), { pitch: 0, yaw: 0, roll: 0 }, false, 0); // not recording: ignored
    r.beginRecording(0);
    recordLine(r, 3);
    expect(r.recordedFrames).toBe(3);
    await r.endRecording(true, 0.03); // finish tick not recorded: 3 frames over 0.03 s
    const pb = r.getPb(0)!;
    expect(frameCount(pb)).toBe(3);
    expect(pb.tickrate).toBeCloseTo(100, 9);
    expect(replayDuration(pb)).toBeCloseTo(0.02, 9);
    const g = r.ghostAt(0.005)!;
    expect(g.origin.x).toBeCloseTo(5, 6);
    expect(g.angles.pitch).toBeCloseTo(0.5, 6);
    expect(g).toMatchObject({ id: 'pb:0', name: 'PB Replay', visible: true });
    expect(g.color).toEqual([0.25, 0.95, 1.0]);
    expect(r.ghostAt(-1)!.origin.x).toBe(0);
    expect(r.ghostAt(99)!.origin.x).toBe(20);
    expect(r.ghostAt(0.0099)!.ducked).toBe(true); // nearest frame (1) is ducked
    expect(r.ghostAt(0.004)!.ducked).toBe(false);
  });

  it('interpolates yaw the short way across +-180', async () => {
    const r = new ReplaySystem('surf_test');
    r.beginRecording(0);
    r.recordTick(v3(), { pitch: 0, yaw: 170, roll: 0 }, false, 0);
    r.recordTick(v3(), { pitch: 0, yaw: -170, roll: 0 }, false, 0);
    await r.endRecording(true, 0.02);
    const yaw = r.ghostAt(0.005)!.angles.yaw;
    expect(Math.abs(Math.abs(yaw) - 180)).toBeLessThan(1e-6);
  });

  it('endRecording(false) and cancel keep the old PB; buffers grow', async () => {
    const r = new ReplaySystem('surf_test');
    r.beginRecording(0);
    recordLine(r, 5000, 1);
    await r.endRecording(true, 50);
    expect(frameCount(r.getPb(0)!)).toBe(5000);
    r.beginRecording(0);
    recordLine(r, 10);
    await r.endRecording(false, 0.1);
    expect(frameCount(r.getPb(0)!)).toBe(5000);
    r.beginRecording(0);
    recordLine(r, 10);
    r.cancelRecording();
    expect(r.recording).toBe(false);
    await r.endRecording(true, 1); // nothing recording: no-op
    expect(frameCount(r.getPb(0)!)).toBe(5000);
  });

  it('spectates in first person (eye height, speed, finished)', async () => {
    const r = new ReplaySystem('surf_test');
    expect(r.spectate(0)).toBe(false);
    r.beginRecording(0);
    recordLine(r, 3);
    await r.endRecording(true, 0.03);
    expect(r.spectate(0)).toBe(true);
    expect(r.spectating).toBe(true);
    const v0 = r.spectateView(0)!;
    expect(v0.origin.z).toBeCloseTo(100 + VIEW_OFFSET_STAND, 6);
    expect(v0.speed).toBeCloseTo(1000, 6);
    expect(v0.finished).toBe(false);
    const v1 = r.spectateView(0.01)!;
    expect(v1.origin.z).toBeCloseTo(100 + VIEW_OFFSET_DUCK, 6);
    const end = r.spectateView(5)!;
    expect(end.finished).toBe(true);
    expect(end.time).toBeCloseTo(0.02, 9);
    expect(end.origin.x).toBe(20);
    expect(end.speed).toBeCloseTo(1000, 6);
    expect(r.spectate(null)).toBe(true);
    expect(r.spectating).toBe(false);
    expect(r.spectateView(0)).toBeNull();
  });

  it('loadPb without IndexedDB: true only for replays in memory; ghost follows the course', async () => {
    const r = new ReplaySystem('surf_test');
    expect(await r.loadPb('surf_test', 0)).toBe(false);
    expect(r.ghostAt(1)).toBeNull();
    r.beginRecording(2);
    recordLine(r, 4);
    await r.endRecording(true, 0.04);
    expect(await r.loadPb('surf_test', 2)).toBe(true);
    expect(r.ghostAt(0)!.name).toBe('PB Replay (Bonus 2)');
    expect(await r.loadPb('surf_test', 0)).toBe(false);
    expect(r.ghostAt(0)).toBeNull(); // course 0 has no PB
  });

  it('sampleReplay packs buttons and handles empty replays', () => {
    const frames = new Float32Array(2 * FRAME_STRIDE);
    frames.set([0, 0, 0, 0, 0, IN_JUMP | DUCKED_FLAG, 10, 0, 0, 0, 90, 0]);
    const s = sampleReplay({ map: 'm', group: 0, time: 0.01, tickrate: 100, frames, date: 0 }, 0)!;
    expect(s.buttons).toBe(IN_JUMP);
    expect(s.ducked).toBe(true);
    expect(sampleReplay({ map: 'm', group: 0, time: 1, tickrate: 100, frames: new Float32Array(0), date: 0 }, 0)).toBeNull();
  });
});
