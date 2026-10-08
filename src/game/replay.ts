// Run recording, PB replays and ghosts.
//
// A recording is one frame per tick: x, y, z, pitch, yaw, flags (FRAME_STRIDE floats, growable Float32Array).
// Frame 0 is the tick the timer started (run time 0); frame k is run time k / tickrate. flags packs the
// usercmd buttons (bits 0..17) and the ducked state (DUCKED_FLAG).
//
// The PB replay of each course is kept in memory and persisted in IndexedDB (db "surf", store "replays",
// key "map|group|tick"): like the records, replays belong to one tickrate (a 128-tick PB is never the ghost of
// a 64-tick run). Replays saved before the tick was part of the key ("map|group") are still found when their
// recorded tickrate matches. Everything works without IndexedDB (node tests, private windows): replays then
// live for the session only.
//
// KSF world record replays (maps/ksf.ts) use the same representation: replayFromKsf() converts a parsed KSF file
// (its own tick interval, so no resampling) with the start-zone prestrafe kept before run time 0 (`startFrame`) and
// the stored velocities (`velocities`, for the spectate speedometer). The WR replay is kept apart from the PBs
// (setWrReplay): it can be spectated (spectateData) and raced as a second ghost (wrGhostAt).
import { QAngle, angleDiff } from '../core/angles';
import { console_ } from '../core/cvars';
import { Vec3 } from '../core/vec3';
import type { ParsedKsfReplay } from '../maps/ksfreplay';
import { IN_DUCK, VIEW_OFFSET_DUCK, VIEW_OFFSET_STAND } from '../physics/playertypes';
import { GhostState } from './api';
import { IReplaySystem } from './contracts';
import { tickLabel } from './records';

export const FRAME_STRIDE = 6;
export const DUCKED_FLAG = 1 << 20;
const BUTTON_MASK = 0x3ffff;
const GHOST_COLOR: [number, number, number] = [0.25, 0.95, 1.0];
/** The KSF world record ghost: gold, apart from the cyan PB ghost. */
export const WR_GHOST_COLOR: [number, number, number] = [1.0, 0.72, 0.18];
export const WR_GHOST_NAME = 'KSF WR';
/**
 * Two consecutive frames farther apart than this (units) are a teleport (stage teleports, the end of a KSF replay):
 * samples between them snap to the nearer frame instead of sliding through the map. Far above any real per-tick
 * move (3500 u/s per axis at 64 tick is under 100 units).
 */
export const REPLAY_TELEPORT_DISTANCE = 1000;
const TELEPORT_SQ = REPLAY_TELEPORT_DISTANCE * REPLAY_TELEPORT_DISTANCE;
const DB_NAME = 'surf';
const STORE = 'replays';
const INITIAL_FRAMES = 4096;

export interface ReplayData {
  map: string;
  group: number;
  /** Run time in seconds. */
  time: number;
  /** Frames per second of `frames`. */
  tickrate: number;
  /** FRAME_STRIDE floats per frame. */
  frames: Float32Array;
  /** Date.now() when recorded. */
  date: number;
  /**
   * Optional: frames before the run started (the prestrafe in the start zone); frame `startFrame` is run time 0.
   * Absent / 0 for our own recordings (they start with the run).
   */
  startFrame?: number;
  /** Optional: velocity x, y, z per frame (u/s), e.g. stored by KSF replays; the speed then comes from it. */
  velocities?: Float32Array;
}

/** IndexedDB key of a PB replay: "surf_kitsune|0|100" (legacy keys without the tick: tickrate omitted). */
export function replayKey(map: string, group: number, tickrate?: number): string {
  const base = `${map.toLowerCase()}|${group | 0}`;
  return tickrate === undefined ? base : `${base}|${tickLabel(tickrate)}`;
}

/** Number of frames in a replay. */
export function frameCount(r: ReplayData): number {
  return Math.floor(r.frames.length / FRAME_STRIDE);
}

/** Replay duration in seconds (last frame time). */
export function replayDuration(r: ReplayData): number {
  const n = frameCount(r);
  return n > 1 && r.tickrate > 0 ? (n - 1) / r.tickrate : 0;
}

export interface ReplaySample {
  origin: Vec3;
  angles: QAngle;
  ducked: boolean;
  buttons: number;
  /** Horizontal speed (u/s): from the stored velocities when the replay has them, else the frame positions. */
  speed: number;
  /** The stored velocity at the sample (null when the replay doesn't store velocities). */
  velocity: Vec3 | null;
  /** Clamped sample time in seconds. */
  time: number;
  /** t was at or past the last frame. */
  finished: boolean;
}

/** Frame of run time 0 (after the prestrafe frames of a replay that has them), clamped to the replay. */
export function replayStartFrame(r: ReplayData): number {
  const n = frameCount(r);
  const s = r.startFrame !== undefined && r.startFrame > 0 ? Math.floor(r.startFrame) : 0;
  return n > 0 ? Math.min(s, n - 1) : 0;
}

/** Squared distance between the positions of frames p and q. */
function frameDistSq(f: Float32Array, p: number, q: number): number {
  const dx = f[q * FRAME_STRIDE] - f[p * FRAME_STRIDE];
  const dy = f[q * FRAME_STRIDE + 1] - f[p * FRAME_STRIDE + 1];
  const dz = f[q * FRAME_STRIDE + 2] - f[p * FRAME_STRIDE + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Whether frames k and k + 1 are a teleport (REPLAY_TELEPORT_DISTANCE). */
export function isTeleportStep(r: ReplayData, k: number): boolean {
  const n = frameCount(r);
  return k >= 0 && k + 1 < n && frameDistSq(r.frames, k, k + 1) > TELEPORT_SQ;
}

/**
 * Interpolated replay state at run time `t` seconds (clamped to the replay; negative times reach into the prestrafe
 * frames of a replay that has them). Null for an empty replay. Between two frames of a teleport the sample is the
 * nearer frame (no interpolation through the map).
 */
export function sampleReplay(r: ReplayData, t: number): ReplaySample | null {
  const n = frameCount(r);
  if (n === 0) return null;
  const f = r.frames;
  const rate = r.tickrate > 0 ? r.tickrate : 100;
  const start = replayStartFrame(r);
  let pos = start + (Number.isFinite(t) ? t : 0) * rate;
  if (pos < 0) pos = 0;
  const last = n - 1;
  const finished = pos >= last;
  if (pos > last) pos = last;
  const i0 = Math.min(Math.floor(pos), last);
  const j0 = Math.min(i0 + 1, last);
  let i = i0;
  let j = j0;
  let a = (pos - i) || 0;
  if (j > i && frameDistSq(f, i, j) > TELEPORT_SQ) {
    if (a < 0.5) j = i;
    else i = j;
    a = 0;
  }
  const oi = i * FRAME_STRIDE;
  const oj = j * FRAME_STRIDE;
  const origin = {
    x: f[oi] + (f[oj] - f[oi]) * a,
    y: f[oi + 1] + (f[oj + 1] - f[oi + 1]) * a,
    z: f[oi + 2] + (f[oj + 2] - f[oi + 2]) * a,
  };
  const pitch = f[oi + 3] + (f[oj + 3] - f[oi + 3]) * a;
  const yaw = f[oi + 4] + angleDiff(f[oj + 4], f[oi + 4]) * a;
  const flags = f[(a < 0.5 ? oi : oj) + 5] | 0;
  let speed = 0;
  let velocity: Vec3 | null = null;
  const vel = r.velocities;
  if (vel && vel.length >= n * 3) {
    // stored velocities (KSF replays)
    velocity = {
      x: vel[i * 3] + (vel[j * 3] - vel[i * 3]) * a,
      y: vel[i * 3 + 1] + (vel[j * 3 + 1] - vel[i * 3 + 1]) * a,
      z: vel[i * 3 + 2] + (vel[j * 3 + 2] - vel[i * 3 + 2]) * a,
    };
    speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
  } else {
    // speed from the surrounding frame pair (the last frame reuses the previous pair); a teleport pair takes the
    // pair before it (or after it), never the teleport distance
    let si = j0 > i0 ? i0 : Math.max(0, i0 - 1);
    if (si + 1 < n && frameDistSq(f, si, si + 1) > TELEPORT_SQ) {
      if (si > 0 && frameDistSq(f, si - 1, si) <= TELEPORT_SQ) si--;
      else if (si + 2 < n && frameDistSq(f, si + 1, si + 2) <= TELEPORT_SQ) si++;
      else si = -1;
    }
    if (si >= 0 && si + 1 < n) {
      const dx = f[(si + 1) * FRAME_STRIDE] - f[si * FRAME_STRIDE];
      const dy = f[(si + 1) * FRAME_STRIDE + 1] - f[si * FRAME_STRIDE + 1];
      speed = Math.sqrt(dx * dx + dy * dy) * rate;
    }
  }
  return {
    origin,
    angles: { pitch, yaw, roll: 0 },
    ducked: (flags & DUCKED_FLAG) !== 0,
    buttons: flags & BUTTON_MASK,
    speed,
    velocity,
    time: (pos - start) / rate,
    finished,
  };
}

/**
 * A KSF world record replay (maps/ksfreplay.ts) as a ReplayData: its own frame rate (no resampling), the prestrafe
 * before `startFrame`, the stored velocities and buttons; the ducked state (not stored) from IN_DUCK. `time` is the
 * official record time when given (sub-tick precise), else the frames' run time.
 */
export function replayFromKsf(p: ParsedKsfReplay, map: string, opts: { time?: number; date?: number } = {}): ReplayData {
  const n = p.frameCount;
  const frames = new Float32Array(n * FRAME_STRIDE);
  for (let k = 0; k < n; k++) {
    const o = k * FRAME_STRIDE;
    frames[o] = p.origins[k * 3];
    frames[o + 1] = p.origins[k * 3 + 1];
    frames[o + 2] = p.origins[k * 3 + 2];
    frames[o + 3] = p.angles[k * 3];
    frames[o + 4] = p.angles[k * 3 + 1];
    const b = p.buttons[k];
    frames[o + 5] = (b & BUTTON_MASK) | (b & IN_DUCK ? DUCKED_FLAG : 0);
  }
  const time = opts.time !== undefined && opts.time > 0 ? opts.time : p.time;
  return {
    map: map.toLowerCase(),
    group: 0,
    time,
    tickrate: 1 / p.tickInterval,
    frames,
    date: opts.date ?? 0,
    startFrame: p.startFrame,
    velocities: p.velocities.slice(0, n * 3),
  };
}

// ------------------------------------------------------------------------------------------ IndexedDB

interface StoredReplay {
  key: string;
  map: string;
  group: number;
  time: number;
  tickrate: number;
  date: number;
  frames: Float32Array | ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDbVersion(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

/** Opens db "surf" and makes sure the "replays" store exists (bumping the version if another module owns the db). */
function openDb(): Promise<IDBDatabase | null> {
  if (!idbAvailable()) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = (async () => {
      try {
        let db = await openDbVersion();
        if (!db.objectStoreNames.contains(STORE)) {
          const v = db.version + 1;
          db.close();
          db = await openDbVersion(v);
        }
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        return db;
      } catch {
        dbPromise = null;
        return null;
      }
    })();
  }
  return dbPromise;
}

async function idbGet(key: string): Promise<StoredReplay | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as StoredReplay | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(value: StoredReplay): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function fromStored(s: StoredReplay): ReplayData | null {
  const frames = s.frames instanceof Float32Array ? s.frames : s.frames instanceof ArrayBuffer ? new Float32Array(s.frames) : null;
  if (!frames || !(s.time > 0) || !(s.tickrate > 0)) return null;
  return { map: s.map, group: s.group | 0, time: s.time, tickrate: s.tickrate, frames, date: s.date || 0 };
}

// ------------------------------------------------------------------------------------------ the system

interface Recording {
  group: number;
  buf: Float32Array;
  count: number;
  tickrate: number;
}

function cvarNum(name: string, fallback: number): number {
  const c = console_.getCvar(name);
  return c && Number.isFinite(c.num) ? c.num : fallback;
}

export class ReplaySystem implements IReplaySystem {
  readonly mapName: string;
  /**
   * Seconds per recorded frame. When 0 (default) the `tickrate` cvar is used, and the frame rate is checked
   * against the finished run time (frames / time) when a recording ends.
   */
  tickInterval = 0;
  private rec: Recording | null = null;
  /** Buffer of the last finished/cancelled recording, reused by the next attempt. */
  private spare: Float32Array | null = null;
  /** PB replays by memKey(group, tick). */
  private readonly pbs = new Map<string, ReplayData>();
  private readonly loading = new Map<string, Promise<boolean>>();
  /** memKeys already looked up in IndexedDB (ghostAt loads the PB of a new tickrate once). */
  private readonly requested = new Set<string>();
  /** Course whose PB the ghost shows (set by beginRecording / loadPb). */
  private activeGroup = 0;
  private spec: ReplayData | null = null;
  /** The KSF world record replay of this map (setWrReplay), ghosted by wrGhostAt and spectated by spectateData. */
  private wr: ReplayData | null = null;

  constructor(mapName: string) {
    this.mapName = mapName.toLowerCase();
  }

  get recording(): boolean {
    return this.rec !== null;
  }

  get spectating(): boolean {
    return this.spec !== null;
  }

  /** Frames recorded so far in the current attempt. */
  get recordedFrames(): number {
    return this.rec ? this.rec.count : 0;
  }

  private memKey(group: number, tickrate: number = this.currentTickrate()): string {
    return `${group | 0}|${tickLabel(tickrate)}`;
  }

  /** The PB replay of a course at the tickrate (default: the current one) if loaded. */
  getPb(group: number, tickrate?: number): ReplayData | null {
    return this.pbs.get(this.memKey(group, tickrate)) ?? null;
  }

  /** Installs a PB replay directly (imports, tests). It belongs to the tickrate it was recorded at. */
  setPb(data: ReplayData): void {
    this.pbs.set(this.memKey(data.group, data.tickrate), data);
  }

  /** Ticks per second the game currently runs at (`tickInterval`, else the `tickrate` cvar). */
  currentTickrate(): number {
    if (this.tickInterval > 0) return 1 / this.tickInterval;
    const tr = cvarNum('tickrate', 100);
    return tr > 0 ? tr : 100;
  }

  beginRecording(group: number): void {
    const g = group | 0;
    this.activeGroup = g;
    const buf = this.rec?.buf ?? this.spare ?? new Float32Array(INITIAL_FRAMES * FRAME_STRIDE);
    this.spare = null;
    this.rec = { group: g, buf, count: 0, tickrate: this.currentTickrate() };
    if (!this.pbs.has(this.memKey(g))) void this.loadPb(this.mapName, g);
  }

  recordTick(origin: Vec3, angles: QAngle, ducked: boolean, buttons: number): void {
    const r = this.rec;
    if (!r) return;
    let o = r.count * FRAME_STRIDE;
    if (o + FRAME_STRIDE > r.buf.length) {
      const nb = new Float32Array(r.buf.length * 2);
      nb.set(r.buf);
      r.buf = nb;
    }
    const b = r.buf;
    b[o++] = origin.x;
    b[o++] = origin.y;
    b[o++] = origin.z;
    b[o++] = angles.pitch;
    b[o++] = angles.yaw;
    b[o] = (buttons & BUTTON_MASK) | (ducked ? DUCKED_FLAG : 0);
    r.count++;
  }

  async endRecording(saveAsPb: boolean, time: number): Promise<void> {
    const r = this.rec;
    this.rec = null;
    if (r) this.spare = r.buf;
    if (!r || !saveAsPb || r.count === 0 || !(time > 0)) return;
    let tickrate = r.tickrate;
    // Frames cover run time 0 .. time (the finish tick may or may not have been recorded): if the cvar-based
    // rate disagrees with the recording by more than 2 %, trust the recording.
    const measured = r.count / time;
    if (!(tickrate > 0) || Math.abs(measured - tickrate) / measured > 0.02) tickrate = measured;
    const data: ReplayData = {
      map: this.mapName,
      group: r.group,
      time,
      tickrate,
      frames: r.buf.slice(0, r.count * FRAME_STRIDE),
      date: Date.now(),
    };
    // filed under the tickrate the run was played at (the cvar when it started)
    const key = this.memKey(r.group, r.tickrate > 0 ? r.tickrate : tickrate);
    this.pbs.set(key, data);
    this.requested.add(key);
    await idbPut({ key: replayKey(data.map, data.group, r.tickrate > 0 ? r.tickrate : tickrate), ...data });
  }

  cancelRecording(): void {
    if (this.rec) this.spare = this.rec.buf;
    this.rec = null;
  }

  /** Loads the PB replay of map/group at the tickrate (default: the current one) from IndexedDB. */
  async loadPb(map: string, group: number, tickrate: number = this.currentTickrate()): Promise<boolean> {
    const g = group | 0;
    const m = map.toLowerCase();
    const mk = this.memKey(g, tickrate);
    if (m === this.mapName) {
      this.activeGroup = g;
      this.requested.add(mk);
    }
    if (m === this.mapName && this.pbs.has(mk)) return true;
    const pending = m === this.mapName ? this.loading.get(mk) : undefined;
    if (pending) return pending;
    const label = tickLabel(tickrate);
    const p = (async () => {
      let stored = await idbGet(replayKey(m, g, tickrate));
      if (!stored) {
        // replays saved before the tick was part of the key count for the tickrate they were recorded at
        const legacy = await idbGet(replayKey(m, g));
        if (legacy && legacy.tickrate > 0 && tickLabel(legacy.tickrate) === label) stored = legacy;
      }
      const data = stored ? fromStored(stored) : null;
      if (!data) return false;
      // a run saved meanwhile (endRecording) wins over the stored copy
      if (m === this.mapName && !this.pbs.has(mk)) this.pbs.set(mk, data);
      return true;
    })();
    if (m === this.mapName) {
      this.loading.set(mk, p);
      void p.finally(() => this.loading.delete(mk));
    }
    return p;
  }

  /** Forgets (and deletes from IndexedDB) the PB replay of a course at the tickrate (default: the current one). */
  async deletePb(group: number, tickrate: number = this.currentTickrate()): Promise<void> {
    this.pbs.delete(this.memKey(group, tickrate));
    await idbDelete(replayKey(this.mapName, group, tickrate));
    const legacy = await idbGet(replayKey(this.mapName, group));
    if (legacy && legacy.tickrate > 0 && tickLabel(legacy.tickrate) === tickLabel(tickrate)) await idbDelete(replayKey(this.mapName, group));
  }

  ghostAt(runTime: number): GhostState | null {
    const mk = this.memKey(this.activeGroup);
    const data = this.pbs.get(mk);
    if (!data) {
      // the tickrate changed: look up that tickrate's PB once
      if (!this.requested.has(mk)) void this.loadPb(this.mapName, this.activeGroup).catch(() => false);
      return null;
    }
    const s = sampleReplay(data, runTime);
    if (!s) return null;
    return {
      id: `pb:${data.group}`,
      origin: s.origin,
      angles: s.angles,
      ducked: s.ducked,
      color: [GHOST_COLOR[0], GHOST_COLOR[1], GHOST_COLOR[2]],
      name: data.group > 0 ? `PB Replay (Bonus ${data.group})` : 'PB Replay',
      visible: true,
      trail: cvarNum('surf_ghost_trail', 1) !== 0,
    };
  }

  spectate(group: number | null): boolean {
    if (group === null) {
      this.spec = null;
      return true;
    }
    const data = this.pbs.get(this.memKey(group));
    if (!data || frameCount(data) === 0) return false;
    this.activeGroup = group | 0;
    this.spec = data;
    return true;
  }

  /** Spectates any replay (the KSF WR); null stops. False for an empty replay. */
  spectateData(data: ReplayData | null): boolean {
    if (!data) {
      this.spec = null;
      return true;
    }
    if (frameCount(data) === 0) return false;
    this.spec = data;
    return true;
  }

  /**
   * First-person playback while spectating. `t` is seconds since the playback started (a replay with prestrafe
   * frames shows them first). `origin` is the EYE position (feet + view offset, ducked-aware), ready for
   * ViewState.origin; `time` is the run clock (clamped; negative during the prestrafe), `speed` horizontal u/s.
   */
  spectateView(t: number): { origin: Vec3; angles: QAngle; speed: number; time: number; finished: boolean } | null {
    if (!this.spec) return null;
    const rate = this.spec.tickrate > 0 ? this.spec.tickrate : 100;
    const s = sampleReplay(this.spec, t - replayStartFrame(this.spec) / rate);
    if (!s) return null;
    s.origin.z += s.ducked ? VIEW_OFFSET_DUCK : VIEW_OFFSET_STAND;
    return { origin: s.origin, angles: s.angles, speed: s.speed, time: s.time, finished: s.finished };
  }

  /** The replay being spectated (null when not spectating). */
  spectatedReplay(): ReplayData | null {
    return this.spec;
  }

  /** Installs (or with null, forgets) the KSF world record replay of this map (watching it carries on until left). */
  setWrReplay(data: ReplayData | null): void {
    this.wr = data && frameCount(data) > 0 ? data : null;
  }

  getWrReplay(): ReplayData | null {
    return this.wr;
  }

  /** The KSF WR ghost at `runTime` seconds into your run (main course; null without a WR replay). */
  wrGhostAt(runTime: number): GhostState | null {
    const data = this.wr;
    if (!data) return null;
    const s = sampleReplay(data, runTime);
    if (!s) return null;
    return {
      id: 'ksf:wr',
      origin: s.origin,
      angles: s.angles,
      ducked: s.ducked,
      color: [WR_GHOST_COLOR[0], WR_GHOST_COLOR[1], WR_GHOST_COLOR[2]],
      name: WR_GHOST_NAME,
      visible: true,
      trail: cvarNum('surf_ghost_trail', 1) !== 0,
    };
  }
}
