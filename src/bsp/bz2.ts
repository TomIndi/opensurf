// bzip2 decompressor (for FastDL ".bsp.bz2" downloads), written from the public description of the format:
//
//   stream  := "BZh" level('1'..'9') block* end-of-stream
//   block   := 0x314159265359 (48 bits) blockCRC(32) randomised(1) origPtr(24)
//              symbol map, Huffman selectors (MTF coded), Huffman code lengths (delta coded),
//              Huffman coded MTF/RLE2 symbols (RUNA/RUNB zero-run coding), EOB
//   end     := 0x177245385090 (48 bits) combinedCRC(32), padding to a byte boundary
//
// Decoding a block: Huffman -> zero-run expansion + move-to-front inversion -> inverse Burrows-Wheeler
// transform -> optional de-randomisation (obsolete bzip2 0.9.0 feature) -> RLE1 expansion (4 equal bytes
// followed by a repeat count). Multiple concatenated streams are supported (pbzip2 / lbzip2 output).
// Bits are read MSB first.

export class Bzip2Error extends Error {
  constructor(msg: string) {
    super(`bzip2: ${msg}`);
    this.name = 'Bzip2Error';
  }
}

export interface Bunzip2Options {
  /** Verify block and stream CRCs (default true). */
  verifyCrc?: boolean;
}

const BLOCK_MAGIC_HI = 0x314159;
const BLOCK_MAGIC_LO = 0x265359;
const EOS_MAGIC_HI = 0x177245;
const EOS_MAGIC_LO = 0x385090;
const MAX_GROUPS = 6;
const MAX_ALPHA = 258;
const MAX_CODE_LEN = 20;
const GROUP_SIZE = 50;
const MAX_SELECTORS = 18002; // 2 + 900000 / GROUP_SIZE; extra selectors are read and ignored (like bzip2 1.0.8)
const RUNA = 0;
const RUNB = 1;
const FAST_BITS = 10;
const MTFA_SIZE = 4096;

// CRC-32 as used by bzip2: polynomial 0x04C11DB7, MSB-first (non-reflected), init/xorout 0xFFFFFFFF.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c;
  }
  return t;
})();

/** bzip2's CRC-32 of `data` (the value stored as a block CRC for a block with this output). */
export function bzip2Crc(data: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < data.length; i++) crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff];
  return ~crc >>> 0;
}

// The randomisation table of bzip2 0.9.0 "randomised" blocks (part of the file format).
// prettier-ignore
const R_NUMS = new Int16Array([
  619, 720, 127, 481, 931, 816, 813, 233, 566, 247, 985, 724, 205, 454, 863, 491,
  741, 242, 949, 214, 733, 859, 335, 708, 621, 574, 73, 654, 730, 472, 419, 436,
  278, 496, 867, 210, 399, 680, 480, 51, 878, 465, 811, 169, 869, 675, 611, 697,
  867, 561, 862, 687, 507, 283, 482, 129, 807, 591, 733, 623, 150, 238, 59, 379,
  684, 877, 625, 169, 643, 105, 170, 607, 520, 932, 727, 476, 693, 425, 174, 647,
  73, 122, 335, 530, 442, 853, 695, 249, 445, 515, 909, 545, 703, 919, 874, 474,
  882, 500, 594, 612, 641, 801, 220, 162, 819, 984, 589, 513, 495, 799, 161, 604,
  958, 533, 221, 400, 386, 867, 600, 782, 382, 596, 414, 171, 516, 375, 682, 485,
  911, 276, 98, 553, 163, 354, 666, 933, 424, 341, 533, 870, 227, 730, 475, 186,
  263, 647, 537, 686, 600, 224, 469, 68, 770, 919, 190, 373, 294, 822, 808, 206,
  184, 943, 795, 384, 383, 461, 404, 758, 839, 887, 715, 67, 618, 276, 204, 918,
  873, 777, 604, 560, 951, 160, 578, 722, 79, 804, 96, 409, 713, 940, 652, 934,
  970, 447, 318, 353, 859, 672, 112, 785, 645, 863, 803, 350, 139, 93, 354, 99,
  820, 908, 609, 772, 154, 274, 580, 184, 79, 626, 630, 742, 653, 282, 762, 623,
  680, 81, 927, 626, 789, 125, 411, 521, 938, 300, 821, 78, 343, 175, 128, 250,
  170, 774, 972, 275, 999, 639, 495, 78, 352, 126, 857, 956, 358, 619, 580, 124,
  737, 594, 701, 612, 669, 112, 134, 694, 363, 992, 809, 743, 168, 974, 944, 375,
  748, 52, 600, 747, 642, 182, 862, 81, 344, 805, 988, 739, 511, 655, 814, 334,
  249, 515, 897, 955, 664, 981, 649, 113, 974, 459, 893, 228, 433, 837, 553, 268,
  926, 240, 102, 654, 459, 51, 686, 754, 806, 760, 493, 403, 415, 394, 687, 700,
  946, 670, 656, 610, 738, 392, 760, 799, 887, 653, 978, 321, 576, 617, 626, 502,
  894, 679, 243, 440, 680, 879, 194, 572, 640, 724, 926, 56, 204, 700, 707, 151,
  457, 449, 797, 195, 791, 558, 945, 679, 297, 59, 87, 824, 713, 663, 412, 693,
  342, 606, 134, 108, 571, 364, 631, 212, 174, 643, 304, 329, 343, 97, 430, 751,
  497, 314, 983, 374, 822, 928, 140, 206, 73, 263, 980, 736, 876, 478, 430, 305,
  170, 514, 364, 692, 829, 82, 855, 953, 676, 246, 369, 970, 294, 750, 807, 827,
  150, 790, 288, 923, 804, 378, 215, 828, 592, 281, 565, 555, 710, 82, 896, 831,
  547, 261, 524, 462, 293, 465, 502, 56, 661, 821, 976, 991, 658, 869, 905, 758,
  745, 193, 768, 550, 608, 933, 378, 286, 215, 979, 792, 961, 61, 688, 793, 644,
  986, 403, 106, 366, 905, 644, 372, 567, 466, 434, 645, 210, 389, 550, 919, 135,
  780, 773, 635, 389, 707, 100, 626, 958, 165, 504, 920, 176, 193, 713, 857, 265,
  203, 50, 668, 108, 645, 990, 626, 197, 510, 357, 358, 850, 858, 364, 936, 638,
]);

/** MSB-first bit reader. Reading past the end yields zero bits and counts the overrun. */
class BitReader {
  pos: number;
  buf = 0;
  count = 0;
  overrun = 0;

  constructor(
    readonly data: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }

  /** Reads n <= 24 bits. */
  bits(n: number): number {
    while (this.count < n) {
      let byte = 0;
      if (this.pos < this.data.length) byte = this.data[this.pos++];
      else this.overrun++;
      this.buf = (this.buf << 8) | byte;
      this.count += 8;
    }
    this.count -= n;
    return (this.buf >>> this.count) & ((1 << n) - 1);
  }

  bit(): number {
    return this.bits(1);
  }

  /** Discards bits up to the next byte boundary. */
  alignToByte(): void {
    this.count -= this.count & 7;
  }

  /** Byte position of the next unread whole byte (after alignToByte). */
  bytePos(): number {
    return this.pos - (this.count >> 3);
  }

  /** True once more than a few bytes were requested beyond the input. */
  exhausted(): boolean {
    return this.overrun > 4;
  }
}

/** Canonical Huffman decoding tables for one coding group. */
class HuffmanTable {
  /** FAST_BITS-bit prefix -> (symbol << 5) | length, or -1 when the code is longer than FAST_BITS. */
  readonly fast = new Int32Array(1 << FAST_BITS);
  /** limit[L] = one past the last canonical code of length L (codes of length L are < limit[L]). */
  readonly limit = new Int32Array(MAX_CODE_LEN + 2);
  /** firstCode[L] = first canonical code of length L. */
  readonly firstCode = new Int32Array(MAX_CODE_LEN + 2);
  /** base[L] = index in `perm` of the first symbol with length L. */
  readonly base = new Int32Array(MAX_CODE_LEN + 2);
  /** Symbols sorted by (code length, symbol). */
  readonly perm = new Uint16Array(MAX_ALPHA);
  minLen = 0;
  maxLen = 0;

  build(lengths: Uint8Array, alphaSize: number): void {
    let minLen = 32;
    let maxLen = 0;
    const counts = new Int32Array(MAX_CODE_LEN + 2);
    for (let i = 0; i < alphaSize; i++) {
      const l = lengths[i];
      counts[l]++;
      if (l < minLen) minLen = l;
      if (l > maxLen) maxLen = l;
    }
    this.minLen = minLen;
    this.maxLen = maxLen;
    // perm: symbols ordered by length, then by symbol value
    let p = 0;
    for (let l = minLen; l <= maxLen; l++) {
      this.base[l] = p;
      for (let i = 0; i < alphaSize; i++) if (lengths[i] === l) this.perm[p++] = i;
    }
    // canonical codes: consecutive within a length, doubled when moving to the next length
    let code = 0;
    for (let l = 1; l <= MAX_CODE_LEN; l++) {
      this.firstCode[l] = code;
      code += counts[l];
      this.limit[l] = code;
      if (code > 1 << l) throw new Bzip2Error('over-subscribed Huffman code');
      code <<= 1;
    }
    this.fast.fill(-1);
    for (let l = minLen; l <= Math.min(maxLen, FAST_BITS); l++) {
      let c = this.firstCode[l];
      const shift = FAST_BITS - l;
      for (let k = this.base[l], end = this.base[l] + counts[l]; k < end; k++, c++) {
        const entry = (this.perm[k] << 5) | l;
        const from = c << shift;
        this.fast.fill(entry, from, from + (1 << shift));
      }
    }
  }
}

interface StreamState {
  tt: Uint32Array;
  mtfa: Uint8Array;
  mtfBase: Int32Array;
  /** Reusable per-block output buffer. */
  blockOut: Uint8Array;
}

/** True if the data starts with a bzip2 stream header ("BZh1".."BZh9"). */
export function isBzip2(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x42 && data[1] === 0x5a && data[2] === 0x68 && data[3] >= 0x31 && data[3] <= 0x39;
}

/**
 * Decompresses a complete .bz2 file (one or more concatenated streams). Throws Bzip2Error on corrupt input.
 * Trailing bytes after the last stream that do not start a new stream are ignored.
 */
export function bunzip2(data: Uint8Array, opts: Bunzip2Options = {}): Uint8Array {
  const verifyCrc = opts.verifyCrc !== false;
  if (!isBzip2(data)) throw new Bzip2Error('not a bzip2 stream (missing "BZh" header)');

  const chunks: Uint8Array[] = [];
  let total = 0;
  const st: StreamState = {
    tt: new Uint32Array(0),
    mtfa: new Uint8Array(MTFA_SIZE),
    mtfBase: new Int32Array(16),
    blockOut: new Uint8Array(1 << 20),
  };
  const br = new BitReader(data, 0);
  const tables: HuffmanTable[] = [];
  for (let i = 0; i < MAX_GROUPS; i++) tables.push(new HuffmanTable());

  let streamStart = 0;
  for (;;) {
    // ---- stream header ----
    br.pos = streamStart;
    br.buf = 0;
    br.count = 0;
    const level = data[streamStart + 3] - 0x30;
    br.pos = streamStart + 4;
    const blockMax = level * 100000;
    if (st.tt.length < blockMax) st.tt = new Uint32Array(blockMax);
    let combinedCrc = 0;

    for (;;) {
      const hi = br.bits(24);
      const lo = br.bits(24);
      if (hi === BLOCK_MAGIC_HI && lo === BLOCK_MAGIC_LO) {
        const storedCrc = ((br.bits(16) << 16) | br.bits(16)) >>> 0;
        const n = decodeBlock(br, st, tables, blockMax);
        if (verifyCrc) {
          const crc = bzip2Crc(st.blockOut.subarray(0, n));
          if (crc !== storedCrc) throw new Bzip2Error(`block CRC mismatch (stored ${hex(storedCrc)}, computed ${hex(crc)})`);
        }
        combinedCrc = (((combinedCrc << 1) | (combinedCrc >>> 31)) ^ storedCrc) >>> 0;
        if (n > 0) {
          chunks.push(st.blockOut.slice(0, n));
          total += n;
        }
      } else if (hi === EOS_MAGIC_HI && lo === EOS_MAGIC_LO) {
        const storedCombined = ((br.bits(16) << 16) | br.bits(16)) >>> 0;
        if (verifyCrc && storedCombined !== combinedCrc) {
          throw new Bzip2Error(`stream CRC mismatch (stored ${hex(storedCombined)}, computed ${hex(combinedCrc)})`);
        }
        break;
      } else {
        throw new Bzip2Error('bad block magic');
      }
      if (br.exhausted()) throw new Bzip2Error('unexpected end of data');
    }
    if (br.exhausted()) throw new Bzip2Error('unexpected end of data');

    // ---- another concatenated stream? ----
    br.alignToByte();
    const next = br.bytePos();
    if (next < data.length && isBzip2(data.subarray(next))) {
      streamStart = next;
      continue;
    }
    break;
  }

  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

/** Decodes one block (after its magic and CRC) into st.blockOut; returns the number of output bytes. */
function decodeBlock(br: BitReader, st: StreamState, tables: HuffmanTable[], blockMax: number): number {
  const randomised = br.bit();
  const origPtr = br.bits(24);

  // ---- symbol map: which byte values occur in the block ----
  const seqToUnseq = new Uint8Array(256);
  let nInUse = 0;
  const inUse16 = br.bits(16);
  for (let i = 0; i < 16; i++) {
    if (inUse16 & (0x8000 >>> i)) {
      const bits = br.bits(16);
      for (let j = 0; j < 16; j++) if (bits & (0x8000 >>> j)) seqToUnseq[nInUse++] = i * 16 + j;
    }
  }
  if (nInUse === 0) throw new Bzip2Error('block uses no symbols');
  const alphaSize = nInUse + 2;
  const EOB = nInUse + 1;

  // ---- selectors ----
  const nGroups = br.bits(3);
  if (nGroups < 2 || nGroups > MAX_GROUPS) throw new Bzip2Error(`bad number of Huffman groups ${nGroups}`);
  const nSelectorsRaw = br.bits(15);
  if (nSelectorsRaw < 1) throw new Bzip2Error('no selectors');
  const nSelectors = Math.min(nSelectorsRaw, MAX_SELECTORS);
  const selectors = new Uint8Array(nSelectors);
  const mtfGroups = [0, 1, 2, 3, 4, 5];
  for (let i = 0; i < nSelectorsRaw; i++) {
    let j = 0;
    while (br.bit()) {
      j++;
      if (j >= nGroups) throw new Bzip2Error('bad selector');
    }
    if (br.exhausted()) throw new Bzip2Error('unexpected end of data in selectors');
    if (i < nSelectors) {
      // inverse move-to-front over group numbers
      const v = mtfGroups[j];
      for (let k = j; k > 0; k--) mtfGroups[k] = mtfGroups[k - 1];
      mtfGroups[0] = v;
      selectors[i] = v;
    }
  }

  // ---- Huffman code lengths (delta coded) ----
  const lengths = new Uint8Array(MAX_ALPHA);
  for (let t = 0; t < nGroups; t++) {
    let curr = br.bits(5);
    for (let i = 0; i < alphaSize; i++) {
      for (;;) {
        if (curr < 1 || curr > MAX_CODE_LEN) throw new Bzip2Error('bad Huffman code length');
        if (!br.bit()) break;
        curr += br.bit() ? -1 : 1;
      }
      lengths[i] = curr;
    }
    tables[t].build(lengths, alphaSize);
  }

  // ---- Huffman + RLE2 (RUNA/RUNB) + MTF decoding into tt ----
  const tt = st.tt;
  const unzftab = new Int32Array(256);
  // Move-to-front list, stored as 16 windows of 16 entries inside a larger array so that moving entry
  // n to the front costs at most 15 shifts inside its window plus one hand-over per preceding window
  // (instead of n shifts). Window w holds logical positions 16w..16w+15 at mtfa[mtfBase[w] ..].
  const mtfa = st.mtfa;
  const mtfBase = st.mtfBase;
  for (let w = 15, k = MTFA_SIZE - 1; w >= 0; w--) {
    for (let j = 15; j >= 0; j--, k--) {
      const idx = w * 16 + j;
      mtfa[k] = idx < nInUse ? seqToUnseq[idx] : 0;
    }
    mtfBase[w] = MTFA_SIZE - (16 - w) * 16;
  }

  const data = br.data;
  const dataLen = data.length;
  let pos = br.pos;
  let buf = br.buf;
  let count = br.count;
  let overrun = 0;

  let groupNo = -1;
  let groupPos = 0;
  let table = tables[0];
  let fast = table.fast;
  let nblock = 0;
  let runLen = 0;
  let runWeight = 1;
  let inRun = false;

  for (;;) {
    // next Huffman symbol
    if (groupPos === 0) {
      groupNo++;
      if (groupNo >= nSelectors) throw new Bzip2Error('ran out of selectors');
      groupPos = GROUP_SIZE;
      table = tables[selectors[groupNo]];
      fast = table.fast;
    }
    groupPos--;
    while (count < MAX_CODE_LEN) {
      let byte = 0;
      if (pos < dataLen) byte = data[pos++];
      else if (++overrun > 8) throw new Bzip2Error('unexpected end of data in block');
      buf = (buf << 8) | byte;
      count += 8;
    }
    const peek = (buf >>> (count - MAX_CODE_LEN)) & 0xfffff;
    let sym: number;
    const e = fast[peek >>> (MAX_CODE_LEN - FAST_BITS)];
    if (e >= 0) {
      sym = e >>> 5;
      count -= e & 31;
    } else {
      let l = FAST_BITS + 1;
      const maxLen = table.maxLen;
      for (;;) {
        if (l > maxLen) throw new Bzip2Error('invalid Huffman code');
        const c = peek >>> (MAX_CODE_LEN - l);
        if (c < table.limit[l]) {
          sym = table.perm[table.base[l] + c - table.firstCode[l]];
          break;
        }
        l++;
      }
      count -= l;
    }

    if (sym <= RUNB) {
      // bijective base-2 run length of the symbol at the front of the MTF list
      if (!inRun) {
        inRun = true;
        runLen = 0;
        runWeight = 1;
      }
      runLen += sym === RUNA ? runWeight : runWeight << 1;
      runWeight <<= 1;
      if (runWeight > 1 << 21) throw new Bzip2Error('run too long');
      continue;
    }
    if (inRun) {
      inRun = false;
      if (nblock + runLen > blockMax) throw new Bzip2Error('block overflow');
      const uc = mtfa[mtfBase[0]];
      unzftab[uc] += runLen;
      if (runLen < 16) {
        for (let k = 0; k < runLen; k++) tt[nblock++] = uc;
      } else {
        tt.fill(uc, nblock, nblock + runLen);
        nblock += runLen;
      }
    }
    if (sym === EOB) break;

    // MTF index sym-1: move that entry to the front
    if (nblock >= blockMax) throw new Bzip2Error('block overflow');
    const nn = sym - 1;
    let uc: number;
    if (nn < 16) {
      // within the first window
      const b = mtfBase[0];
      let p = b + nn;
      uc = mtfa[p];
      while (p > b) {
        mtfa[p] = mtfa[p - 1];
        p--;
      }
      mtfa[b] = uc;
    } else {
      let w = nn >>> 4;
      let p = mtfBase[w] + (nn & 15);
      uc = mtfa[p];
      // close the gap inside window w, which then starts one slot later...
      while (p > mtfBase[w]) {
        mtfa[p] = mtfa[p - 1];
        p--;
      }
      mtfBase[w]++;
      // ...then every earlier window hands its last entry to the front of the next one
      while (w > 0) {
        mtfBase[w]--;
        mtfa[mtfBase[w]] = mtfa[mtfBase[w - 1] + 15];
        w--;
      }
      mtfBase[0]--;
      mtfa[mtfBase[0]] = uc;
      if (mtfBase[0] === 0) {
        // windows drifted to the start of the array: lay them out again at the end
        for (let ww = 15, k = MTFA_SIZE - 1; ww >= 0; ww--) {
          const base = mtfBase[ww];
          for (let j = 15; j >= 0; j--, k--) mtfa[k] = mtfa[base + j];
          mtfBase[ww] = k + 1;
        }
      }
    }
    unzftab[uc]++;
    tt[nblock++] = uc;
  }
  br.pos = pos;
  br.buf = buf;
  br.count = count;
  br.overrun += overrun;

  if (origPtr >= nblock && nblock > 0) throw new Bzip2Error('origPtr out of range');
  if (nblock === 0) return 0;

  // ---- inverse BWT: tt[i] = (next index << 8) | byte ----
  const cftab = new Int32Array(257);
  for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i];
  for (let i = 0; i < nblock; i++) {
    const uc = tt[i] & 0xff;
    tt[cftab[uc]++] |= i << 8;
  }

  // ---- walk the BWT chain, undo randomisation and RLE1 ----
  let out = st.blockOut;
  // Worst case RLE1 expansion is 4 bytes + count(255) per 5 input bytes; grow lazily instead.
  let o = 0;
  let tPos = tt[origPtr] >>> 8;
  let prev = -1;
  let same = 0;
  let rNToGo = 0;
  let rTPos = 0;
  for (let k = 0; k < nblock; k++) {
    tPos = tt[tPos];
    let ch = tPos & 0xff;
    tPos >>>= 8;
    if (randomised) {
      if (rNToGo === 0) {
        rNToGo = R_NUMS[rTPos];
        rTPos = (rTPos + 1) & 511;
      }
      rNToGo--;
      if (rNToGo === 1) ch ^= 1;
    }
    if (same === 4) {
      // ch is a repeat count for the previous byte
      if (o + ch > out.length) out = growOut(st, out, o, o + ch);
      out.fill(prev, o, o + ch);
      o += ch;
      same = 0;
      continue;
    }
    if (o >= out.length) out = growOut(st, out, o, o + 1);
    out[o++] = ch;
    if (ch === prev) same++;
    else {
      prev = ch;
      same = 1;
    }
  }
  return o;
}

function growOut(st: StreamState, out: Uint8Array, used: number, need: number): Uint8Array {
  let n = out.length * 2;
  while (n < need) n *= 2;
  const b = new Uint8Array(n);
  b.set(out.subarray(0, used));
  st.blockOut = b;
  return b;
}
