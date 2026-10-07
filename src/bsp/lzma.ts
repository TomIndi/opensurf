// LZMA1 decoder (range coder + LZ77 with literal/match/rep0..3/short-rep coding), written from the
// public description of the LZMA format. Used for CS:GO "LZMA" lumps, LZMA-compressed pakfile entries
// (ZIP method 14) and LZMA-compressed game lumps.
//
// The decoder writes straight into the output buffer and uses it as the dictionary (no circular window),
// which is both simpler and faster when the whole output fits in memory.

/** Thrown for malformed LZMA data. */
export class LzmaError extends Error {
  constructor(msg: string) {
    super(`LZMA: ${msg}`);
    this.name = 'LzmaError';
  }
}

// ---- probability model layout (one flat Uint16Array) ----
const NUM_STATES = 12;
const POS_BITS_MAX = 4;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1); // 128
const NUM_ALIGN_BITS = 4;
const MATCH_MIN_LEN = 2;

const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2; // 16 pos states * 8
const LEN_MID = LEN_LOW + (1 << POS_BITS_MAX) * 8;
const LEN_HIGH = LEN_MID + (1 << POS_BITS_MAX) * 8;
const LEN_CODER_SIZE = LEN_HIGH + 256;

const IS_MATCH = 0;
const IS_REP = IS_MATCH + (NUM_STATES << POS_BITS_MAX);
const IS_REP_G0 = IS_REP + NUM_STATES;
const IS_REP_G1 = IS_REP_G0 + NUM_STATES;
const IS_REP_G2 = IS_REP_G1 + NUM_STATES;
const IS_REP0_LONG = IS_REP_G2 + NUM_STATES;
const POS_SLOT = IS_REP0_LONG + (NUM_STATES << POS_BITS_MAX);
const SPEC_POS = POS_SLOT + 4 * 64;
const ALIGN = SPEC_POS + 1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX;
const LEN_CODER = ALIGN + (1 << NUM_ALIGN_BITS);
const REP_LEN_CODER = LEN_CODER + LEN_CODER_SIZE;
const LITERAL = REP_LEN_CODER + LEN_CODER_SIZE;

const PROB_INIT = 1024; // kBitModelTotal / 2
/** Sanity cap on a declared output size (corrupt headers must not trigger multi-GB allocations). */
const MAX_OUTPUT = 1 << 30;
const TOP = 0x1000000; // 2^24

/** Decoded lc/lp/pb and dictionary size from the 5-byte LZMA properties. */
export interface LzmaProps {
  lc: number;
  lp: number;
  pb: number;
  dictSize: number;
}

export function parseLzmaProps(props: Uint8Array): LzmaProps {
  if (props.length < 5) throw new LzmaError('properties must be 5 bytes');
  let d = props[0];
  if (d >= 9 * 5 * 5) throw new LzmaError(`bad properties byte ${d}`);
  const lc = d % 9;
  d = (d / 9) | 0;
  const lp = d % 5;
  const pb = (d / 5) | 0;
  const dictSize = (props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] << 24)) >>> 0;
  return { lc, lp, pb, dictSize };
}

// ---- slow-path helpers (lengths, distances, rep selection) ----
// They operate on a tiny Int32Array holding the coder state [range, code, inPos]; the main loop keeps the
// state in locals (registers) for literals and syncs it around calls to these helpers. (Closures capturing
// the locals would force them into a heap context, which is several times slower.)
// `range` and `code` hold uint32 bit patterns in int32 variables; unsigned comparisons use `>>> 0`.
const ST_RANGE = 0;
const ST_CODE = 1;
const ST_POS = 2;

function rcBit(st: Int32Array, src: Uint8Array, probs: Uint16Array, i: number): number {
  const prob = probs[i];
  let range = st[ST_RANGE];
  let code = st[ST_CODE];
  const bound = Math.imul(range >>> 11, prob);
  let b: number;
  if (code >>> 0 < bound >>> 0) {
    range = bound;
    probs[i] = prob + ((2048 - prob) >>> 5);
    b = 0;
  } else {
    range = (range - bound) | 0;
    code = (code - bound) | 0;
    probs[i] = prob - (prob >>> 5);
    b = 1;
  }
  if (range >>> 0 < TOP) {
    range <<= 8;
    code = (code << 8) | src[st[ST_POS]++];
  }
  st[ST_RANGE] = range;
  st[ST_CODE] = code;
  return b;
}

function rcTree(st: Int32Array, src: Uint8Array, probs: Uint16Array, base: number, numBits: number): number {
  let m = 1;
  for (let i = 0; i < numBits; i++) m = (m << 1) + rcBit(st, src, probs, base + m);
  return m - (1 << numBits);
}

function rcReverseTree(st: Int32Array, src: Uint8Array, probs: Uint16Array, base: number, numBits: number): number {
  let m = 1;
  let sym = 0;
  for (let i = 0; i < numBits; i++) {
    const b = rcBit(st, src, probs, base + m);
    m = (m << 1) + b;
    sym |= b << i;
  }
  return sym;
}

function rcDirect(st: Int32Array, src: Uint8Array, count: number): number {
  let range = st[ST_RANGE];
  let code = st[ST_CODE];
  let res = 0;
  for (let i = 0; i < count; i++) {
    range = range >>> 1;
    let b = 0;
    if (code >>> 0 >= range >>> 0) {
      code = (code - range) | 0;
      b = 1;
    }
    res = res * 2 + b;
    if (range >>> 0 < TOP) {
      range <<= 8;
      code = (code << 8) | src[st[ST_POS]++];
    }
  }
  st[ST_RANGE] = range;
  st[ST_CODE] = code;
  return res;
}

function growBuffer(out: Uint8Array, used: number, need: number): Uint8Array {
  let n = out.length * 2;
  while (n < need) n *= 2;
  const o = new Uint8Array(n);
  o.set(out.subarray(0, used));
  return o;
}

function rcLen(st: Int32Array, src: Uint8Array, probs: Uint16Array, base: number, posState: number): number {
  if (rcBit(st, src, probs, base + LEN_CHOICE) === 0) return rcTree(st, src, probs, base + LEN_LOW + posState * 8, 3);
  if (rcBit(st, src, probs, base + LEN_CHOICE2) === 0) return 8 + rcTree(st, src, probs, base + LEN_MID + posState * 8, 3);
  return 16 + rcTree(st, src, probs, base + LEN_HIGH, 8);
}

/**
 * Decodes a raw LZMA1 stream.
 * @param props 5 bytes: lc/lp/pb byte + little-endian dictionary size.
 * @param data the compressed stream (starting with the range coder's zero byte).
 * @param outSize exact uncompressed size, or -1 if unknown (the stream must then end with an end marker).
 *
 * Performance note: the range coder state lives in local variables and the bit decoder is written out
 * inline in every hot path (V8 cannot keep object fields in registers across calls), which makes this
 * noticeably faster than a method-based decoder.
 */
export function lzmaDecompress(props: Uint8Array, data: Uint8Array, outSize: number): Uint8Array {
  const { lc, lp, pb } = parseLzmaProps(props);
  const known = outSize >= 0;
  if (outSize > MAX_OUTPUT) throw new LzmaError(`declared size ${outSize} exceeds the ${MAX_OUTPUT >> 20} MB limit`);
  if (known && outSize === 0) return new Uint8Array(0);
  if (data.length < 5) throw new LzmaError('truncated stream');

  const probs = new Uint16Array(LITERAL + (0x300 << (lc + lp)));
  probs.fill(PROB_INIT);

  // Input padded with zeros so the hot path never needs a bounds check; overruns are detected per symbol.
  const PAD = 32;
  const src = new Uint8Array(data.length + PAD);
  src.set(data);
  const srcEnd = data.length + 8;

  if (src[0] !== 0) throw new LzmaError('stream does not start with a zero byte');
  let range = -1; // 0xFFFFFFFF
  let code = (src[1] << 24) | (src[2] << 16) | (src[3] << 8) | src[4];
  let inPos = 5;
  if (code === -1) throw new LzmaError('corrupted range coder state');

  let out: Uint8Array = new Uint8Array(known ? outSize : Math.max(4096, data.length * 4));
  let cap = out.length;
  const limit = known ? outSize : Infinity;

  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  const lcShift = 8 - lc;

  let pos = 0;
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let sawEndMarker = false;
  let prob = 0;
  let bound = 0;
  const st = new Int32Array(3);

  while (pos < limit) {
    if (inPos > srcEnd) throw new LzmaError('unexpected end of input');
    const posState = pos & pbMask;

    // ---- isMatch bit (inlined) ----
    let pi = IS_MATCH + (state << POS_BITS_MAX) + posState;
    prob = probs[pi];
    bound = Math.imul(range >>> 11, prob);
    if (code >>> 0 < bound >>> 0) {
      range = bound;
      probs[pi] = prob + ((2048 - prob) >>> 5);
      if (range >>> 0 < TOP) {
        range <<= 8;
        code = (code << 8) | src[inPos++];
      }
      // ---- literal ----
      if (pos >= cap) {
        out = growBuffer(out, pos, pos + 1);
        cap = out.length;
      }
      const prev = pos > 0 ? out[pos - 1] : 0;
      const base = LITERAL + 0x300 * (((pos & lpMask) << lc) + (prev >>> lcShift));
      let sym = 1;
      if (state >= 7) {
        // "Matched" literal: the byte at rep0 is used as context until the first mismatching bit.
        let matchByte = out[pos - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          pi = base + ((1 + matchBit) << 8) + sym;
          prob = probs[pi];
          bound = Math.imul(range >>> 11, prob);
          let b: number;
          if (code >>> 0 < bound >>> 0) {
            range = bound;
            probs[pi] = prob + ((2048 - prob) >>> 5);
            b = 0;
          } else {
            range = (range - bound) | 0;
            code = (code - bound) | 0;
            probs[pi] = prob - (prob >>> 5);
            b = 1;
          }
          if (range >>> 0 < TOP) {
            range <<= 8;
            code = (code << 8) | src[inPos++];
          }
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) {
        pi = base + sym;
        prob = probs[pi];
        bound = Math.imul(range >>> 11, prob);
        if (code >>> 0 < bound >>> 0) {
          range = bound;
          probs[pi] = prob + ((2048 - prob) >>> 5);
          sym <<= 1;
        } else {
          range = (range - bound) | 0;
          code = (code - bound) | 0;
          probs[pi] = prob - (prob >>> 5);
          sym = (sym << 1) | 1;
        }
        if (range >>> 0 < TOP) {
          range <<= 8;
          code = (code << 8) | src[inPos++];
        }
      }
      out[pos++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    range = (range - bound) | 0;
    code = (code - bound) | 0;
    probs[pi] = prob - (prob >>> 5);
    if (range >>> 0 < TOP) {
      range <<= 8;
      code = (code << 8) | src[inPos++];
    }

    // ---- match: sync the coder state into `st` for the helpers ----
    st[ST_RANGE] = range;
    st[ST_CODE] = code;
    st[ST_POS] = inPos;
    let len: number;
    if (rcBit(st, src, probs, IS_REP + state) !== 0) {
      // ---- repeated match ----
      if (pos === 0) throw new LzmaError('rep match at stream start');
      if (rcBit(st, src, probs, IS_REP_G0 + state) === 0) {
        if (rcBit(st, src, probs, IS_REP0_LONG + (state << POS_BITS_MAX) + posState) === 0) {
          // short rep: a single byte from distance rep0
          range = st[ST_RANGE];
          code = st[ST_CODE];
          inPos = st[ST_POS];
          if (pos >= cap) {
        out = growBuffer(out, pos, pos + 1);
        cap = out.length;
      }
          state = state < 7 ? 9 : 11;
          out[pos] = out[pos - rep0 - 1];
          pos++;
          continue;
        }
      } else {
        let dist: number;
        if (rcBit(st, src, probs, IS_REP_G1 + state) === 0) {
          dist = rep1;
        } else {
          if (rcBit(st, src, probs, IS_REP_G2 + state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = rcLen(st, src, probs, REP_LEN_CODER, posState);
      state = state < 7 ? 8 : 11;
    } else {
      // ---- simple match ----
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = rcLen(st, src, probs, LEN_CODER, posState);
      state = state < 7 ? 7 : 10;

      const lenState = len < 3 ? len : 3;
      const posSlot = rcTree(st, src, probs, POS_SLOT + lenState * 64, 6);
      if (posSlot < 4) {
        rep0 = posSlot;
      } else {
        const numDirectBits = (posSlot >>> 1) - 1;
        // numDirectBits <= 30, so the shifted value fits 32 bits; >>> 0 reads it as unsigned
        let dist = ((2 | (posSlot & 1)) << numDirectBits) >>> 0;
        if (posSlot < END_POS_MODEL_INDEX) {
          dist += rcReverseTree(st, src, probs, SPEC_POS + dist - posSlot, numDirectBits);
        } else {
          dist += rcDirect(st, src, numDirectBits - NUM_ALIGN_BITS) * (1 << NUM_ALIGN_BITS);
          dist += rcReverseTree(st, src, probs, ALIGN, NUM_ALIGN_BITS);
        }
        rep0 = dist;
      }
      if (rep0 === 0xffffffff) {
        inPos = st[ST_POS];
        sawEndMarker = true;
        break;
      }
      if (rep0 >= pos) throw new LzmaError(`match distance ${rep0 + 1} beyond output position ${pos}`);
    }
    range = st[ST_RANGE];
    code = st[ST_CODE];
    inPos = st[ST_POS];

    len += MATCH_MIN_LEN;
    if (pos + len > limit) {
      // A well-formed stream never overshoots its declared size; be lenient and truncate.
      len = limit - pos;
    }
    if (pos + len > cap) {
      out = growBuffer(out, pos, pos + len);
      cap = out.length;
    }
    let from = pos - rep0 - 1;
    const end = pos + len;
    if (len > 32 && rep0 + 1 >= len) {
      // non-overlapping: a block copy is safe
      out.copyWithin(pos, from, from + len);
      pos = end;
    } else {
      while (pos < end) out[pos++] = out[from++];
    }
  }

  if (inPos > srcEnd) throw new LzmaError('unexpected end of input');
  if (!known) {
    if (!sawEndMarker) throw new LzmaError('stream without size ended without an end marker');
    return pos === out.length ? out : out.slice(0, pos);
  }
  return out;
}

/** Size of Source's lzma_header_t: id "LZMA", actualSize u32, lzmaSize u32, properties[5]. */
export const SOURCE_LZMA_HEADER_SIZE = 17;
const LZMA_ID = 0x414d5a4c; // "LZMA" read as little-endian u32

/** True if `buf` starts with Source's "LZMA" header id. */
export function isSourceLzma(buf: Uint8Array): boolean {
  return (
    buf.length >= SOURCE_LZMA_HEADER_SIZE &&
    buf[0] === 0x4c && // L
    buf[1] === 0x5a && // Z
    buf[2] === 0x4d && // M
    buf[3] === 0x41 // A
  );
}

/** Reads the actualSize field of a Source LZMA header (no decoding). */
export function sourceLzmaActualSize(buf: Uint8Array): number {
  if (!isSourceLzma(buf)) throw new LzmaError('missing "LZMA" header');
  return (buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24)) >>> 0;
}

/**
 * Decodes data wrapped in Valve's LZMA header (CS:GO compressed lumps, game lumps and pak entries):
 *   u32 id = "LZMA", u32 actualSize, u32 lzmaSize, u8 properties[5], then lzmaSize bytes of raw LZMA.
 */
export function decodeSourceLzma(buf: Uint8Array): Uint8Array {
  if (!isSourceLzma(buf)) throw new LzmaError('missing "LZMA" header');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const id = dv.getUint32(0, true);
  if (id !== LZMA_ID) throw new LzmaError('bad header id');
  const actualSize = dv.getUint32(4, true);
  const lzmaSize = dv.getUint32(8, true);
  const props = buf.subarray(12, 17);
  const avail = buf.length - SOURCE_LZMA_HEADER_SIZE;
  const data = buf.subarray(SOURCE_LZMA_HEADER_SIZE, SOURCE_LZMA_HEADER_SIZE + Math.min(lzmaSize, avail));
  return lzmaDecompress(props, data, actualSize);
}

/**
 * Decodes the classic ".lzma" (LZMA_Alone) container: properties[5], u64 uncompressed size
 * (all 0xFF = unknown, end marker required), then the raw stream.
 */
export function decodeLzmaAlone(buf: Uint8Array): Uint8Array {
  if (buf.length < 13) throw new LzmaError('truncated .lzma header');
  const props = buf.subarray(0, 5);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lo = dv.getUint32(5, true);
  const hi = dv.getUint32(9, true);
  let size: number;
  if (lo === 0xffffffff && hi === 0xffffffff) size = -1;
  else {
    size = hi * 0x100000000 + lo;
    if (size > Number.MAX_SAFE_INTEGER || hi >= 0x200000) throw new LzmaError('uncompressed size too large');
  }
  return lzmaDecompress(props, buf.subarray(13), size);
}
