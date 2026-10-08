// Reader for KSF's replay files (ksf.surf "replay_<game>_<map id>_<zone>_<player>_<date>.rec"), little endian:
//
//   int32 @ 8    frame count N; the frames are the LAST N * 40 bytes of the file
//   int32 @ 12   number of zone event blocks (the last one is usually junk)
//   int32 @ 16   on some files: the frame the run started (100 tick replays without a run-start event)
//   zone event i: int32 frame, type, index at 540 + 524 * i (524-byte blocks); the frames follow the last one, and
//                the block count says one more than there are (that "block" would overlap the first frame).
//                type 3 = left a start zone (index 1: the run start; on staged maps also each stage start, index =
//                stage), type 1 = checkpoint n (linear maps), type 2 = entered stage n's zone (staged maps, index n)
//                or the end (index 99)
//                type 3 = run start (index 1), 1 = stage / checkpoint n, 2 = end (index 99)
//   frame (40 bytes): int32 buttons (Source IN_* bits), float32 origin x y z (feet), angles pitch yaw roll,
//                velocity x y z
//
// Frames before the run start are the prestrafe in the start zone; a few frames follow the end, then two junk
// frames (teleports). On staged maps each stage teleport writes one marker frame at a made-up place near the map
// origin ((0, 0, 1000), (0, 0, 2000), ... (0, -27.4, 7000) on surf_kitsune): a frame far from both neighbours is such
// a marker and takes the next frame's position and view (otherwise the replay camera and the ghost would flash
// through the middle of the map at each stage). The tick interval isn't stored: it comes from the board (66 tick 0.015 s, 100 tick 0.01 s)
// and is checked against the motion in the frames (distance moved per frame / stored velocity). Coordinates are the
// map's own (KSF runs the same BSPs), so a replay plays on our copy of the map as-is. Everything is validated:
// garbage (sizes that don't add up, non-finite or absurd numbers inside the run) throws KsfReplayError.

export const KSF_FRAME_BYTES = 40;
export const KSF_ZONE_BLOCK_BASE = 540;
export const KSF_ZONE_BLOCK_BYTES = 524;
export const KSF_ZONE_START = 3;
export const KSF_ZONE_STAGE = 1;
export const KSF_ZONE_END = 2;
/** Index of the end event (type 2) of the course's end zone. */
export const KSF_END_INDEX = 99;
/** Known tick intervals (KSF CS:S 100 tick, 66 tick). */
export const KSF_KNOWN_TICK_INTERVALS: readonly number[] = [0.01, 0.015];
/** Largest replay accepted (frames): 4 hours at 100 tick. */
export const KSF_MAX_FRAMES = 1_440_000;
/** Coordinates / velocities beyond this are garbage (Source maps span ±16384). */
const MAX_COORD = 65536;
const MAX_VELOCITY = 100000;
/** A move longer than this between two frames is a teleport (end-of-file junk frames, stage teleport markers). */
export const KSF_TELEPORT_DISTANCE = 1500;

export interface KsfZoneEvent {
  frame: number;
  /** 3 run start, 1 stage / checkpoint, 2 end. */
  type: number;
  index: number;
}

export interface ParsedKsfReplay {
  /** Frames kept: 0 .. endFrame (the prestrafe and the run). */
  frameCount: number;
  /** Frames in the file. */
  totalFrames: number;
  /** Seconds per frame. */
  tickInterval: number;
  /** Frame of the run start (run time 0). */
  startFrame: number;
  /** Frame of the finish (the last frame kept). */
  endFrame: number;
  /** Where startFrame came from: the run-start event, the header, the expected time, or nothing (0). */
  startSource: 'event' | 'header' | 'time' | 'none';
  /** (endFrame - startFrame) * tickInterval. */
  time: number;
  /** Valid zone events, by frame. */
  events: KsfZoneEvent[];
  /** Teleport marker frames whose position / view were replaced by the next frame's (see the file comment). */
  markers: number[];
  /** Per frame: Source IN_* button bits. */
  buttons: Int32Array;
  /** Per frame: x, y, z (feet). */
  origins: Float32Array;
  /** Per frame: pitch, yaw, roll. */
  angles: Float32Array;
  /** Per frame: velocity x, y, z (u/s). */
  velocities: Float32Array;
}

export class KsfReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KsfReplayError';
  }
}

export interface KsfParseOptions {
  /** Seconds per tick of the board the replay comes from (checked against the motion in the frames). */
  tickInterval?: number;
  /** The record's time (s) from the leaderboard: locates the run start when the file doesn't say. */
  expectedTime?: number;
}

/**
 * Seconds per frame from the motion: median of (horizontal distance between consecutive frames) / (stored
 * horizontal speed) over fast frames. Null when there are too few moving frames.
 */
export function estimateTickInterval(origins: Float32Array, velocities: Float32Array, frames: number): number | null {
  const n = Math.min(frames, Math.floor(origins.length / 3), Math.floor(velocities.length / 3));
  if (n < 3) return null;
  const stride = Math.max(1, Math.floor(n / 4000));
  const samples: number[] = [];
  for (let k = 0; k + 1 < n; k += stride) {
    const vx = (velocities[k * 3] + velocities[k * 3 + 3]) * 0.5;
    const vy = (velocities[k * 3 + 1] + velocities[k * 3 + 4]) * 0.5;
    const sp = Math.hypot(vx, vy);
    if (!(sp > 300)) continue;
    const d = Math.hypot(origins[k * 3 + 3] - origins[k * 3], origins[k * 3 + 4] - origins[k * 3 + 1]);
    const r = d / sp;
    if (r > 0 && r < 0.2) samples.push(r);
  }
  if (samples.length < 20) return null;
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

function nearestKnown(ti: number, tolerance: number): number | null {
  let best: number | null = null;
  for (const k of KSF_KNOWN_TICK_INTERVALS) {
    if (Math.abs(ti - k) / k <= tolerance && (best === null || Math.abs(ti - k) < Math.abs(ti - best))) best = k;
  }
  return best;
}

/** Parses a KSF replay (see the file comment). Throws KsfReplayError on anything that isn't one. */
export function parseKsfReplay(input: ArrayBuffer | Uint8Array, opts: KsfParseOptions = {}): ParsedKsfReplay {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const size = bytes.byteLength;
  if (size < 16 + 2 * KSF_FRAME_BYTES) throw new KsfReplayError(`not a KSF replay (${size} bytes)`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, size);
  const totalFrames = dv.getInt32(8, true);
  if (!(totalFrames >= 2 && totalFrames <= KSF_MAX_FRAMES)) throw new KsfReplayError(`bad frame count ${totalFrames}`);
  const frameStart = size - totalFrames * KSF_FRAME_BYTES;
  if (frameStart < 16) throw new KsfReplayError(`${totalFrames} frames don't fit in ${size} bytes`);

  // ---- zone events (only plausible ones: inside the replay, a known type)
  const blockCount = dv.getInt32(12, true);
  const events: KsfZoneEvent[] = [];
  const maxBlocks = blockCount > 0 ? Math.min(blockCount, 256) : 0;
  for (let i = 0; i < maxBlocks; i++) {
    const o = KSF_ZONE_BLOCK_BASE + KSF_ZONE_BLOCK_BYTES * i;
    if (o + 12 > frameStart) break;
    const frame = dv.getInt32(o, true);
    const type = dv.getInt32(o + 4, true);
    const index = dv.getInt32(o + 8, true);
    if (frame < 0 || frame >= totalFrames) continue;
    if (type !== KSF_ZONE_START && type !== KSF_ZONE_STAGE && type !== KSF_ZONE_END) continue;
    events.push({ frame, type, index });
  }
  events.sort((a, b) => a.frame - b.frame);

  // ---- frames
  const allOrigins = new Float32Array(totalFrames * 3);
  const allAngles = new Float32Array(totalFrames * 3);
  const allVel = new Float32Array(totalFrames * 3);
  const allButtons = new Int32Array(totalFrames);
  const finite = new Uint8Array(totalFrames);
  for (let k = 0; k < totalFrames; k++) {
    const o = frameStart + k * KSF_FRAME_BYTES;
    allButtons[k] = dv.getInt32(o, true);
    let ok = true;
    for (let c = 0; c < 3; c++) {
      const p = dv.getFloat32(o + 4 + c * 4, true);
      const a = dv.getFloat32(o + 16 + c * 4, true);
      const v = dv.getFloat32(o + 28 + c * 4, true);
      if (!(Math.abs(p) <= MAX_COORD) || !Number.isFinite(a) || !(Math.abs(v) <= MAX_VELOCITY)) ok = false;
      allOrigins[k * 3 + c] = p;
      allAngles[k * 3 + c] = a;
      allVel[k * 3 + c] = v;
    }
    finite[k] = ok ? 1 : 0;
  }

  // ---- the finish: the end event (type 2, index 99; on staged maps type 2 also marks each stage reached), else the
  // last frame before the trailing junk
  const ends = events.filter((e) => e.type === KSF_ZONE_END);
  const endEvent = ends.find((e) => e.index === KSF_END_INDEX) ?? ends[ends.length - 1];
  let endFrame: number;
  if (endEvent) endFrame = endEvent.frame;
  else {
    endFrame = totalFrames - 1;
    const jump = (k: number) =>
      !finite[k] ||
      Math.hypot(allOrigins[k * 3] - allOrigins[k * 3 - 3], allOrigins[k * 3 + 1] - allOrigins[k * 3 - 2], allOrigins[k * 3 + 2] - allOrigins[k * 3 - 1]) >
        KSF_TELEPORT_DISTANCE;
    let guard = 8;
    while (endFrame > 1 && guard-- > 0 && jump(endFrame)) endFrame--;
  }
  for (let k = 0; k <= endFrame; k++) if (!finite[k]) throw new KsfReplayError(`garbage in frame ${k}`);

  // ---- stage teleport markers: one frame far from both neighbours takes the next frame's origin and angles (its
  // buttons and velocity stay: they are the tick's own)
  const dist = (p: number, q: number) =>
    Math.hypot(allOrigins[q * 3] - allOrigins[p * 3], allOrigins[q * 3 + 1] - allOrigins[p * 3 + 1], allOrigins[q * 3 + 2] - allOrigins[p * 3 + 2]);
  const markers: number[] = [];
  for (let k = 1; k < endFrame; k++) {
    if (dist(k - 1, k) > KSF_TELEPORT_DISTANCE && dist(k, k + 1) > KSF_TELEPORT_DISTANCE) {
      allOrigins.copyWithin(k * 3, (k + 1) * 3, (k + 2) * 3);
      allAngles.copyWithin(k * 3, (k + 1) * 3, (k + 2) * 3);
      markers.push(k);
    }
  }

  // ---- tick interval: the board's, unless the motion clearly says it is the other known one
  const measured = estimateTickInterval(allOrigins, allVel, endFrame + 1);
  let ti = opts.tickInterval && opts.tickInterval > 0 ? opts.tickInterval : 0;
  if (measured !== null) {
    const known = nearestKnown(measured, 0.06);
    if (!ti) ti = known ?? (measured >= 0.002 && measured <= 0.05 ? measured : 0);
    else if (known !== null && Math.abs(measured - ti) / ti > 0.1) ti = known;
  }
  if (!ti) ti = 0.015;

  // ---- the run start: the run-start event, else the header's start frame, else from the record's time
  let startFrame = 0;
  let startSource: ParsedKsfReplay['startSource'] = 'none';
  const starts = events.filter((e) => e.type === KSF_ZONE_START);
  const startEvent = starts.find((e) => e.index === 1) ?? starts[0];
  const headerStart = dv.getInt32(16, true);
  if (startEvent) {
    startFrame = startEvent.frame;
    startSource = 'event';
  } else if (headerStart > 0 && headerStart < endFrame) {
    startFrame = headerStart;
    startSource = 'header';
  }
  const expected = opts.expectedTime;
  if (expected !== undefined && expected > 0 && Number.isFinite(expected)) {
    const ticks = Math.round(expected / ti);
    const off = Math.abs((endFrame - startFrame) * ti - expected);
    if (startSource === 'none' || off > Math.max(0.05, 3 * ti)) {
      const cand = endFrame - ticks;
      if (cand >= 0 && cand < endFrame) {
        startFrame = cand;
        startSource = 'time';
      }
    }
  }
  if (endFrame <= startFrame) throw new KsfReplayError('the replay has no run');

  const n = endFrame + 1;
  return {
    frameCount: n,
    totalFrames,
    tickInterval: ti,
    startFrame,
    endFrame,
    startSource,
    time: (endFrame - startFrame) * ti,
    events: events.filter((e) => e.frame <= endFrame),
    markers,
    buttons: allButtons.slice(0, n),
    origins: allOrigins.slice(0, n * 3),
    angles: allAngles.slice(0, n * 3),
    velocities: allVel.slice(0, n * 3),
  };
}

export interface SyntheticKsfFrame {
  buttons: number;
  origin: [number, number, number];
  angles: [number, number, number];
  velocity: [number, number, number];
}

/**
 * Builds a replay file in KSF's layout (tests and fixtures). Like real files, the frames start right after the last
 * zone event (at 540 + 524 * events) and the block count says one more than there are (that "block" is the first
 * frame); `headerStart` goes to offset 16.
 */
export function buildKsfReplay(frames: SyntheticKsfFrame[], events: KsfZoneEvent[], opts: { headerStart?: number; blockCount?: number } = {}): Uint8Array {
  const header = KSF_ZONE_BLOCK_BASE + KSF_ZONE_BLOCK_BYTES * events.length;
  const size = header + frames.length * KSF_FRAME_BYTES;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, 2, true);
  dv.setInt32(4, 2, true);
  dv.setInt32(8, frames.length, true);
  dv.setInt32(12, opts.blockCount ?? events.length + 1, true);
  dv.setInt32(16, opts.headerStart ?? 0, true);
  events.forEach((e, i) => {
    const o = KSF_ZONE_BLOCK_BASE + KSF_ZONE_BLOCK_BYTES * i;
    dv.setInt32(o, e.frame, true);
    dv.setInt32(o + 4, e.type, true);
    dv.setInt32(o + 8, e.index, true);
  });
  frames.forEach((f, k) => {
    const o = header + k * KSF_FRAME_BYTES;
    dv.setInt32(o, f.buttons, true);
    for (let c = 0; c < 3; c++) {
      dv.setFloat32(o + 4 + c * 4, f.origin[c], true);
      dv.setFloat32(o + 16 + c * 4, f.angles[c], true);
      dv.setFloat32(o + 28 + c * 4, f.velocity[c], true);
    }
  });
  return out;
}
