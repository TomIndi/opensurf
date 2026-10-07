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

/**
 * The range decoder. `range` and `code` are kept as non-negative doubles holding uint32 values,
 * which keeps all comparisons unsigned without bit tricks.
 */
class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  pos: number;
  /** Number of bytes requested past the end of the input (treated as zeros). */
  overrun = 0;

  constructor(
    private readonly src: Uint8Array,
    start: number,
  ) {
    this.pos = start;
    // The first byte of an LZMA stream is always 0 (it is the carry byte of the encoder).
    const first = this.next();
    if (first !== 0) throw new LzmaError('stream does not start with a zero byte');
    for (let i = 0; i < 4; i++) this.code = this.code * 256 + this.next();
    if (this.code === this.range) throw new LzmaError('corrupted range coder state');
  }

  private next(): number {
    if (this.pos < this.src.length) return this.src[this.pos++];
    this.overrun++;
    if (this.overrun > 16) throw new LzmaError('unexpected end of input');
    return 0;
  }

  bit(probs: Uint16Array, i: number): number {
    const prob = probs[i];
    const bound = (this.range >>> 11) * prob;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = prob + ((2048 - prob) >>> 5);
      b = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[i] = prob - (prob >>> 5);
      b = 1;
    }
    if (this.range < TOP) {
      this.range *= 256;
      this.code = this.code * 256 + (this.pos < this.src.length ? this.src[this.pos++] : this.next());
    }
    return b;
  }

  /** `count` bits with fixed probability 1/2 (most significant first). count <= 26. */
  direct(count: number): number {
    let res = 0;
    for (let i = 0; i < count; i++) {
      this.range = Math.floor(this.range / 2);
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      res = res * 2 + b;
      if (this.range < TOP) {
        this.range *= 256;
        this.code = this.code * 256 + (this.pos < this.src.length ? this.src[this.pos++] : this.next());
      }
    }
    return res;
  }

  /** Bit-tree decode of `numBits` bits, MSB first, probabilities at base+1 .. base+2^numBits-1. */
  tree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(probs, base + m);
    return m - (1 << numBits);
  }

  /** Reverse bit-tree decode (LSB first). */
  reverseTree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(probs, base + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }

  /** True when the encoder flushed cleanly (code must be 0 at the end of a stream). */
  finishedOk(): boolean {
    return this.code === 0;
  }
}

function decodeLen(rc: RangeDecoder, probs: Uint16Array, base: number, posState: number): number {
  if (rc.bit(probs, base + LEN_CHOICE) === 0) return rc.tree(probs, base + LEN_LOW + posState * 8, 3);
  if (rc.bit(probs, base + LEN_CHOICE2) === 0) return 8 + rc.tree(probs, base + LEN_MID + posState * 8, 3);
  return 16 + rc.tree(probs, base + LEN_HIGH, 8);
}

/**
 * Decodes a raw LZMA1 stream.
 * @param props 5 bytes: lc/lp/pb byte + little-endian dictionary size.
 * @param data the compressed stream (starting with the range coder's zero byte).
 * @param outSize exact uncompressed size, or -1 if unknown (the stream must then end with an end marker).
 */
export function lzmaDecompress(props: Uint8Array, data: Uint8Array, outSize: number): Uint8Array {
  const { lc, lp, pb } = parseLzmaProps(props);
  const known = outSize >= 0;
  if (known && outSize === 0) return new Uint8Array(0);

  const probs = new Uint16Array(LITERAL + (0x300 << (lc + lp)));
  probs.fill(PROB_INIT);
  const rc = new RangeDecoder(data, 0);

  let out = new Uint8Array(known ? outSize : Math.max(4096, data.length * 4));
  let cap = known ? outSize : out.length;
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

  const grow = (need: number): void => {
    let n = cap * 2;
    while (n < need) n *= 2;
    const o = new Uint8Array(n);
    o.set(out.subarray(0, pos));
    out = o;
    cap = n;
  };

  while (pos < limit) {
    const posState = pos & pbMask;

    if (rc.bit(probs, IS_MATCH + (state << POS_BITS_MAX) + posState) === 0) {
      // ---- literal ----
      if (pos >= cap) grow(pos + 1);
      const prev = pos > 0 ? out[pos - 1] : 0;
      const base = LITERAL + 0x300 * (((pos & lpMask) << lc) + (prev >>> lcShift));
      let sym = 1;
      if (state >= 7) {
        // "Matched" literal: use the byte at rep0 as context until the first mismatching bit.
        let matchByte = out[pos - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const b = rc.bit(probs, base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(probs, base + sym);
      out[pos++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len: number;
    if (rc.bit(probs, IS_REP + state) !== 0) {
      // ---- repeated match ----
      if (pos === 0) throw new LzmaError('rep match at stream start');
      if (rc.bit(probs, IS_REP_G0 + state) === 0) {
        if (rc.bit(probs, IS_REP0_LONG + (state << POS_BITS_MAX) + posState) === 0) {
          // short rep: one byte from rep0
          if (pos >= cap) grow(pos + 1);
          state = state < 7 ? 9 : 11;
          out[pos] = out[pos - rep0 - 1];
          pos++;
          continue;
        }
      } else {
        let dist: number;
        if (rc.bit(probs, IS_REP_G1 + state) === 0) {
          dist = rep1;
        } else {
          if (rc.bit(probs, IS_REP_G2 + state) === 0) {
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
      len = decodeLen(rc, probs, REP_LEN_CODER, posState);
      state = state < 7 ? 8 : 11;
    } else {
      // ---- simple match ----
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = decodeLen(rc, probs, LEN_CODER, posState);
      state = state < 7 ? 7 : 10;

      const lenState = len < 3 ? len : 3;
      const posSlot = rc.tree(probs, POS_SLOT + lenState * 64, 6);
      if (posSlot < 4) {
        rep0 = posSlot;
      } else {
        const numDirectBits = (posSlot >>> 1) - 1;
        let dist = (2 | (posSlot & 1)) * 2 ** numDirectBits;
        if (posSlot < END_POS_MODEL_INDEX) {
          dist += rc.reverseTree(probs, SPEC_POS + dist - posSlot, numDirectBits);
        } else {
          dist += rc.direct(numDirectBits - NUM_ALIGN_BITS) * (1 << NUM_ALIGN_BITS);
          dist += rc.reverseTree(probs, ALIGN, NUM_ALIGN_BITS);
        }
        rep0 = dist;
      }
      if (rep0 === 0xffffffff) {
        sawEndMarker = true;
        break;
      }
      if (rep0 >= pos) throw new LzmaError(`match distance ${rep0 + 1} beyond output position ${pos}`);
    }

    len += MATCH_MIN_LEN;
    if (known && pos + len > limit) {
      // A well-formed stream never overshoots its declared size; be lenient and truncate.
      len = limit - pos;
    }
    if (pos + len > cap) grow(pos + len);
    let src = pos - rep0 - 1;
    const end = pos + len;
    if (rep0 + 1 >= len) {
      // non-overlapping: a block copy is safe
      out.copyWithin(pos, src, src + len);
      pos = end;
    } else {
      while (pos < end) out[pos++] = out[src++];
    }
  }

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
