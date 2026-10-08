// Reader for KSF's replay files (ksf.surf "replay_<game>_<map id>_<zone>_<player>_<date>.rec"), little endian. The
// int32 at offset 0 is the format version: 2 (files up to about August 2026) or 3 (since then); anything else is
// rejected (KsfReplayError naming the version).
//
//   int32 @ 0    version (2 or 3)
//   int32 @ 4    2 or 3 (unknown)
//   int32 @ 8    frame count N
//   int32 @ 12   number of zone event blocks B
//   v2: the B event blocks from offset 16, then the N frames (40 bytes): 16 + 524 B + 40 N bytes. (A file whose
//       block count doesn't add up is read tolerantly: its frames are the last N * 40 bytes.)
//   v3: int32 @ 16 = 18 (unknown), int32 @ 20 = W (40): W words of the player's client settings follow (floats
//       m_yaw, m_pitch, sensitivity, ... then ints; not used), then the B event blocks (from 24 + 4 W = 184), then the
//       N frames (72 bytes): 24 + 4 W + 524 B + 72 N bytes.
//   Both: some files hold N + D frames: KSF's recorder wrote a block of D frames twice in a row, byte for byte (4000
//       frames, after the finish: surf_garden and surf_beyond 100 tick, v2 and v3). The copy is dropped, so frame k
//       is the k-th recorded tick that the events count (reading the last N frames instead put frames 4000 ticks
//       late at the start of the run).
//   event block (524 bytes): int32 frame, type, index, then a name ("player") at + 268. Block 0 is (0, 2, 1) "in the
//                start zone at frame 0" or the run start itself (v2 100 tick files without another start event: the
//                frame at offset 16). type 3 = left a start zone (index 1: the run start; on staged maps also each
//                stage start, index = stage), type 1 = checkpoint n (linear maps), type 2 = entered stage n's zone
//                (staged maps, index n; index 1 = the start zone) or the end (index 99)
//   frame (v2, 40 bytes): int32 buttons (Source IN_* bits), float32 origin x y z (feet), angles pitch yaw roll,
//                velocity x y z
//   frame (v3, 72 bytes): the v2 frame, then int32 flags (bit 0 FL_ONGROUND), int32 server tick (+1 per frame, may
//                repeat in a lag spike), int32 a second tick counter, float32 forwardmove, sidemove (±400 from the
//                buttons), 3 x int32 (unknown)
//
// Frames before the run start are the prestrafe in the start zone; a few frames follow the end, then two junk
// frames (teleports). On staged maps each stage teleport writes one marker frame at a made-up place near the map
// origin ((0, 0, 1000), (0, 0, 2000), ... (0, -27.4, 7000) on surf_kitsune): a frame far from both neighbours is such
// a marker and takes the next frame's position and view (otherwise the replay camera and the ghost would flash
// through the middle of the map at each stage). The tick interval isn't stored: it comes from the board (66 tick 0.015 s, 100 tick 0.01 s)
// and is checked against the motion in the frames (distance moved per frame / stored velocity). Coordinates are the
// map's own (KSF runs the same BSPs), so a replay plays on our copy of the map as-is. Everything is validated:
// garbage (sizes that don't add up, non-finite or absurd numbers inside the run) throws KsfReplayError.

/** Size of a v2 frame. */
export const KSF_FRAME_BYTES = 40;
/** Size of a v3 frame (the v2 frame + flags, tick counters, forward / side move and three unknown words). */
export const KSF_V3_FRAME_BYTES = 72;
/** Formats this reader knows (the int32 at offset 0). */
export const KSF_REPLAY_VERSIONS: readonly number[] = [2, 3];
/** Where the zone event blocks start in a v2 file (block 0 is at 16; this is block 1, the first one written by most runs). */
export const KSF_ZONE_BLOCK_BASE = 540;
export const KSF_ZONE_BLOCK_BYTES = 524;
const V2_BLOCKS_START = 16;
/** v3: the int32 word count of the settings block at 24 (40 in every file seen). */
const V3_SETTINGS_WORDS_OFFSET = 20;
const V3_SETTINGS_START = 24;
const V3_MAX_SETTINGS_WORDS = 4096;
/** v3: offset of the server tick counter in a frame (written by buildKsfReplay; the parser doesn't need it). */
const V3_TICK_OFFSET = 44;
/** At most this many v2 event blocks are looked at (a v2 block count that doesn't add up isn't trusted). */
const MAX_EVENT_BLOCKS = 1024;
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
  /** File format version (2 or 3). */
  version: number;
  /** Frames kept: 0 .. endFrame (the prestrafe and the run). */
  frameCount: number;
  /** Frames in the file (the header's count; a duplicated block in a v3 file is not counted). */
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

/** Where the parts of a file are (see the file comment). */
interface KsfLayout {
  blocksStart: number;
  framesStart: number;
  frameBytes: number;
  /** Frame k is file frame k before `dupAt`, k + `dupCount` from there on (a duplicated block of dupCount frames). */
  dupAt: number;
  dupCount: number;
}

/**
 * The file frame j where the `count` (> 1) frames from j repeat the `count` frames before it byte for byte, or -1.
 * The block must not be one frame over and over: v2 frames (no tick counter) of a player standing still are all the
 * same, and dropping some of them would shift everything before the real copy.
 */
function findDuplicateBlock(bytes: Uint8Array, framesStart: number, frameBytes: number, fileFrames: number, count: number): number {
  if (count < 2) return -1;
  const same = (a: number, b: number, frames: number) => {
    const oa = framesStart + a * frameBytes;
    const ob = framesStart + b * frameBytes;
    for (let i = 0, n = frames * frameBytes; i < n; i++) if (bytes[oa + i] !== bytes[ob + i]) return false;
    return true;
  };
  for (let j = count; j + count <= fileFrames; j++) {
    // cheap checks first: the block's first and last frames repeat, and differ from each other
    if (same(j - count, j, 1) && same(j - 1, j + count - 1, 1) && !same(j - count, j - 1, 1) && same(j - count, j, count)) return j;
  }
  return -1;
}

/**
 * The frames follow the event blocks: N of them, or N + D with a block of D frames written twice (KSF's recorder,
 * both versions: 4000 frames after the finish of some long runs). Null when there are more frames and no such block.
 */
function framesAfterBlocks(bytes: Uint8Array, blocksStart: number, framesStart: number, frameBytes: number, totalFrames: number): KsfLayout | null {
  const fileFrames = (bytes.byteLength - framesStart) / frameBytes;
  const layout = { blocksStart, framesStart, frameBytes, dupAt: totalFrames, dupCount: 0 };
  if (fileFrames === totalFrames) return layout;
  const dupCount = fileFrames - totalFrames;
  const dupAt = findDuplicateBlock(bytes, framesStart, frameBytes, fileFrames, dupCount);
  return dupAt < 0 ? null : { ...layout, dupAt, dupCount };
}

function v2Layout(bytes: Uint8Array, totalFrames: number, blockCount: number): KsfLayout {
  const size = bytes.byteLength;
  const framesStart = V2_BLOCKS_START + KSF_ZONE_BLOCK_BYTES * blockCount;
  const region = size - framesStart;
  if (blockCount >= 0 && region >= totalFrames * KSF_FRAME_BYTES && region % KSF_FRAME_BYTES === 0) {
    const layout = framesAfterBlocks(bytes, V2_BLOCKS_START, framesStart, KSF_FRAME_BYTES, totalFrames);
    if (layout) return layout;
  }
  // a block count that doesn't add up (or extra frames that aren't a copy): the frames are the last N
  const fromEnd = size - totalFrames * KSF_FRAME_BYTES;
  if (fromEnd < V2_BLOCKS_START) throw new KsfReplayError(`${totalFrames} frames don't fit in ${size} bytes`);
  return { blocksStart: V2_BLOCKS_START, framesStart: fromEnd, frameBytes: KSF_FRAME_BYTES, dupAt: totalFrames, dupCount: 0 };
}

function v3Layout(bytes: Uint8Array, dv: DataView, totalFrames: number, blockCount: number): KsfLayout {
  const size = bytes.byteLength;
  const words = dv.getInt32(V3_SETTINGS_WORDS_OFFSET, true);
  if (!(words >= 0 && words <= V3_MAX_SETTINGS_WORDS)) throw new KsfReplayError(`bad v3 settings size ${words}`);
  if (!(blockCount >= 0 && blockCount <= size / KSF_ZONE_BLOCK_BYTES)) throw new KsfReplayError(`bad zone block count ${blockCount}`);
  const blocksStart = V3_SETTINGS_START + 4 * words;
  const framesStart = blocksStart + KSF_ZONE_BLOCK_BYTES * blockCount;
  const region = size - framesStart;
  if (region < totalFrames * KSF_V3_FRAME_BYTES || region % KSF_V3_FRAME_BYTES !== 0) {
    throw new KsfReplayError(`v3 replay: ${blockCount} zone blocks and ${totalFrames} frames of ${KSF_V3_FRAME_BYTES} bytes don't add up to ${size} bytes`);
  }
  // extra frames that aren't a copy: the first N
  return framesAfterBlocks(bytes, blocksStart, framesStart, KSF_V3_FRAME_BYTES, totalFrames) ?? { blocksStart, framesStart, frameBytes: KSF_V3_FRAME_BYTES, dupAt: totalFrames, dupCount: 0 };
}

/** Parses a KSF replay (see the file comment). Throws KsfReplayError on anything that isn't one. */
export function parseKsfReplay(input: ArrayBuffer | Uint8Array, opts: KsfParseOptions = {}): ParsedKsfReplay {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const size = bytes.byteLength;
  if (size < 16 + 2 * KSF_FRAME_BYTES) throw new KsfReplayError(`not a KSF replay (${size} bytes)`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, size);
  const version = dv.getInt32(0, true);
  if (!KSF_REPLAY_VERSIONS.includes(version)) {
    throw new KsfReplayError(`unknown KSF replay format version ${version} (this reader knows versions ${KSF_REPLAY_VERSIONS.join(' and ')})`);
  }
  const totalFrames = dv.getInt32(8, true);
  if (!(totalFrames >= 2 && totalFrames <= KSF_MAX_FRAMES)) throw new KsfReplayError(`bad frame count ${totalFrames}`);
  const blockCount = dv.getInt32(12, true);
  const layout = version === 2 ? v2Layout(bytes, totalFrames, blockCount) : v3Layout(bytes, dv, totalFrames, blockCount);
  const { blocksStart, framesStart, frameBytes, dupAt, dupCount } = layout;

  // ---- zone events (only plausible ones: inside the replay, a known type)
  const events: KsfZoneEvent[] = [];
  // (a v3 block count is exact: the frames' offset depends on it)
  const maxBlocks = blockCount > 0 ? (version === 3 ? blockCount : Math.min(blockCount, MAX_EVENT_BLOCKS)) : 0;
  for (let i = 0; i < maxBlocks; i++) {
    const o = blocksStart + KSF_ZONE_BLOCK_BYTES * i;
    if (o + 12 > framesStart) break;
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
    const o = framesStart + (k < dupAt ? k : k + dupCount) * frameBytes;
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

  // ---- the finish: the end event (type 2, index 99; on staged maps type 2 also marks each stage reached, index 1
  // being the start zone itself), else the last frame before the trailing junk
  const ends = events.filter((e) => e.type === KSF_ZONE_END && e.index !== 1);
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

  // ---- the run start: the run-start event, else the header's start frame (block 0's frame), else from the
  // record's time
  let startFrame = 0;
  let startSource: ParsedKsfReplay['startSource'] = 'none';
  const starts = events.filter((e) => e.type === KSF_ZONE_START);
  const startEvent = starts.find((e) => e.index === 1) ?? starts[0];
  const headerStart = dv.getInt32(blocksStart, true);
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
    version,
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

export interface SyntheticKsfOptions {
  /** Block 0's frame (v2: offset 16; the run start of files without a start event). */
  headerStart?: number;
  /** The block count written at 12 (default: the events + block 0). */
  blockCount?: number;
  /** File format (default 2). */
  version?: 2 | 3;
  /** v3: the server tick of frame 0 (default 100000). */
  firstTick?: number;
  /** Writes the `count` frames before frame `at` a second time before it (KSF's duplicated block; not counted at 8). */
  duplicate?: { at: number; count: number };
}

/** IN_* bits of the movement keys (Source): forward, back, move left, move right. */
const IN_FORWARD_BIT = 1 << 3;
const IN_BACK_BIT = 1 << 4;
const IN_MOVELEFT_BIT = 1 << 9;
const IN_MOVERIGHT_BIT = 1 << 10;

/**
 * Builds a replay file in KSF's layout (tests and fixtures). Like real files, block 0 comes first (v2: at offset 16
 * holding `headerStart`; v3: (0, 2, 1), or `headerStart` when given), the events follow it (v2: at 540 + 524 i) and
 * the frames follow the last one; the block count includes block 0.
 */
export function buildKsfReplay(frames: SyntheticKsfFrame[], events: KsfZoneEvent[], opts: SyntheticKsfOptions = {}): Uint8Array {
  const version = opts.version ?? 2;
  const blocks: KsfZoneEvent[] =
    version === 2 || opts.headerStart !== undefined ? [{ frame: opts.headerStart ?? 0, type: 0, index: 0 }, ...events] : [{ frame: 0, type: KSF_ZONE_END, index: 1 }, ...events];
  const settingsWords = 40;
  const blocksStart = version === 2 ? V2_BLOCKS_START : V3_SETTINGS_START + 4 * settingsWords;
  const frameBytes = version === 2 ? KSF_FRAME_BYTES : KSF_V3_FRAME_BYTES;
  const dup = opts.duplicate ?? null;
  const fileFrames = frames.length + (dup ? dup.count : 0);
  const framesStart = blocksStart + KSF_ZONE_BLOCK_BYTES * blocks.length;
  const out = new Uint8Array(framesStart + fileFrames * frameBytes);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, version, true);
  dv.setInt32(4, 2, true);
  dv.setInt32(8, frames.length, true);
  dv.setInt32(12, opts.blockCount ?? blocks.length, true);
  if (version === 3) {
    dv.setInt32(16, 18, true);
    dv.setInt32(V3_SETTINGS_WORDS_OFFSET, settingsWords, true);
    // m_yaw, m_pitch, sensitivity like a real file's settings
    dv.setFloat32(V3_SETTINGS_START, 0.022, true);
    dv.setFloat32(V3_SETTINGS_START + 4, 0.022, true);
    dv.setFloat32(V3_SETTINGS_START + 8, 1, true);
  }
  blocks.forEach((e, i) => {
    const o = blocksStart + KSF_ZONE_BLOCK_BYTES * i;
    dv.setInt32(o, e.frame, true);
    dv.setInt32(o + 4, e.type, true);
    dv.setInt32(o + 8, e.index, true);
    if (version === 3) out.set([0x70, 0x6c, 0x61, 0x79, 0x65, 0x72], o + 268); // "player"
  });
  const firstTick = opts.firstTick ?? 100000;
  const write = (slot: number, k: number) => {
    const f = frames[k];
    const o = framesStart + slot * frameBytes;
    dv.setInt32(o, f.buttons, true);
    for (let c = 0; c < 3; c++) {
      dv.setFloat32(o + 4 + c * 4, f.origin[c], true);
      dv.setFloat32(o + 16 + c * 4, f.angles[c], true);
      dv.setFloat32(o + 28 + c * 4, f.velocity[c], true);
    }
    if (version === 3) {
      const move = (plus: number, minus: number) => (f.buttons & plus ? 400 : 0) - (f.buttons & minus ? 400 : 0);
      dv.setInt32(o + 40, f.velocity[2] === 0 ? 1 : 0, true);
      dv.setInt32(o + V3_TICK_OFFSET, firstTick + k, true);
      dv.setInt32(o + 48, firstTick + k - 50000, true);
      dv.setFloat32(o + 52, move(IN_FORWARD_BIT, IN_BACK_BIT), true);
      dv.setFloat32(o + 56, move(IN_MOVERIGHT_BIT, IN_MOVELEFT_BIT), true);
    }
  };
  let slot = 0;
  for (let k = 0; k < frames.length; k++) {
    if (dup && k === dup.at) for (let d = dup.at - dup.count; d < dup.at; d++) write(slot++, d);
    write(slot++, k);
  }
  return out;
}
