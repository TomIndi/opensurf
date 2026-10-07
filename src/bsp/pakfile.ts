// Reader for the BSP pakfile lump (LUMP_PAKFILE = 40): a plain ZIP archive embedded in the map that holds
// custom content (materials, textures, models, sounds...). Written from the public PKWARE APPNOTE layout:
//
//   [local file header + data]*  [central directory entries]*  [end of central directory record + comment]
//
// Almost every Source pakfile stores entries uncompressed (method 0). CS:GO-era tools may use LZMA (method 14,
// ZIP-LZMA layout) and generic ZIP tools deflate (method 8); all three are supported.
import { inflateSync } from 'fflate';
import { lzmaDecompress } from './lzma';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;

export const ZIP_STORED = 0;
export const ZIP_DEFLATE = 8;
export const ZIP_LZMA = 14;

/** One file of the archive, as described by its central directory entry. */
export interface PakEntry {
  /** Name as stored in the archive (slashes normalized to '/', case preserved). */
  name: string;
  /** Normalized lookup key: lower-case, '/' separators, no leading "./" or "/". */
  key: string;
  method: number;
  /** General purpose bit flags. */
  flags: number;
  compressedSize: number;
  size: number;
  crc32: number;
  /** Offset of the local file header inside the ZIP bytes. */
  localHeaderOffset: number;
}

/** Normalizes a path for pakfile lookups: lower-case, '\' → '/', no leading "./" or "/", no duplicate slashes. */
export function normalizePakPath(path: string): string {
  let p = path.trim().replace(/\\/g, '/').toLowerCase();
  p = p.replace(/\/{2,}/g, '/');
  for (;;) {
    if (p.startsWith('./')) p = p.slice(2);
    else if (p.startsWith('/')) p = p.slice(1);
    else break;
  }
  return p;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function utf8(bytes: Uint8Array, start: number, end: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
  } catch {
    return latin1(bytes, start, end);
  }
}

/**
 * Read-only view of a ZIP archive (the BSP pakfile). Lookups are case-insensitive and accept '\' separators.
 * Construction only parses the central directory; entry data is located and decompressed on read().
 * Never throws on malformed archives: an unreadable archive simply has no entries.
 */
export class PakFile {
  private readonly zip: Uint8Array;
  private readonly dv: DataView;
  private readonly byKey = new Map<string, PakEntry>();
  /** Offset added to every stored offset (non-zero when data was prepended to the archive). */
  private shift = 0;
  /** Problems found while parsing the directory (truncated entries, unsupported features). */
  readonly warnings: string[] = [];
  /** Archive comment (Source writes "XZP1 0" into pakfiles). */
  comment = '';

  constructor(zip: Uint8Array) {
    this.zip = zip;
    this.dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    try {
      this.parseDirectory();
    } catch (e) {
      this.warnings.push(`pakfile: ${(e as Error).message}`);
    }
  }

  /** Number of file entries. */
  get size(): number {
    return this.byKey.size;
  }

  /** Normalized (lower-case) paths of all files. */
  list(): string[] {
    return [...this.byKey.keys()];
  }

  /** All entries (original names, sizes, methods). */
  entries(): PakEntry[] {
    return [...this.byKey.values()];
  }

  has(path: string): boolean {
    return this.byKey.has(normalizePakPath(path));
  }

  /** Directory entry for `path`, or undefined. */
  entry(path: string): PakEntry | undefined {
    return this.byKey.get(normalizePakPath(path));
  }

  /**
   * Returns the uncompressed bytes of `path`, or null when the file is missing, encrypted, uses an unsupported
   * compression method or is corrupt. Stored entries are returned as views into the archive (no copy).
   */
  read(path: string): Uint8Array | null {
    const e = this.byKey.get(normalizePakPath(path));
    if (!e) return null;
    try {
      return this.readEntry(e);
    } catch {
      return null;
    }
  }

  /** read() decoded as text (UTF-8 when valid, otherwise Latin-1; a UTF-8 BOM is skipped). */
  readText(path: string): string | null {
    const d = this.read(path);
    if (!d) return null;
    let start = 0;
    if (d.length >= 3 && d[0] === 0xef && d[1] === 0xbb && d[2] === 0xbf) start = 3;
    let end = d.length;
    while (end > start && d[end - 1] === 0) end--;
    return utf8(d, start, end);
  }

  // ------------------------------------------------------------------ internals

  private findEocd(): number {
    const zip = this.zip;
    const last = zip.length - EOCD_SIZE;
    if (last < 0) return -1;
    const first = Math.max(0, last - MAX_COMMENT);
    // Prefer a record whose comment length reaches exactly the end of the data; otherwise accept the last
    // plausible one (archives with trailing padding).
    let fallback = -1;
    for (let p = last; p >= first; p--) {
      if (zip[p] !== 0x50 || zip[p + 1] !== 0x4b || zip[p + 2] !== 0x05 || zip[p + 3] !== 0x06) continue;
      const commentLen = this.dv.getUint16(p + 20, true);
      if (p + EOCD_SIZE + commentLen === zip.length) return p;
      if (fallback < 0 && p + EOCD_SIZE + commentLen <= zip.length) fallback = p;
    }
    return fallback;
  }

  private parseDirectory(): void {
    const zip = this.zip;
    const dv = this.dv;
    if (zip.length < EOCD_SIZE) {
      if (zip.length > 0) this.warnings.push('pakfile: too small to be a ZIP archive');
      return;
    }
    const eocd = this.findEocd();
    if (eocd < 0) {
      this.warnings.push('pakfile: end of central directory not found');
      return;
    }
    const totalEntries = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const commentLen = dv.getUint16(eocd + 20, true);
    this.comment = latin1(zip, eocd + EOCD_SIZE, Math.min(zip.length, eocd + EOCD_SIZE + commentLen)).replace(/\0+$/, '');
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      this.warnings.push('pakfile: ZIP64 archives are not supported');
      return;
    }

    // Locate the central directory. If its stored offset doesn't point at a central entry but the directory
    // ends right before the EOCD record, the archive was shifted (bytes prepended): compensate.
    let cdStart = cdOffset;
    if (!this.sigAt(cdStart, SIG_CENTRAL) && totalEntries > 0) {
      const guess = eocd - cdSize;
      if (guess >= 0 && this.sigAt(guess, SIG_CENTRAL)) {
        this.shift = guess - cdOffset;
        cdStart = guess;
      } else {
        this.warnings.push('pakfile: central directory not found');
        return;
      }
    }

    let p = cdStart;
    const end = Math.min(zip.length, eocd);
    for (;;) {
      if (p + CENTRAL_SIZE > end || !this.sigAt(p, SIG_CENTRAL)) break;
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const crc32 = dv.getUint32(p + 16, true);
      const compressedSize = dv.getUint32(p + 20, true);
      const size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const fileCommentLen = dv.getUint16(p + 32, true);
      const localHeaderOffset = dv.getUint32(p + 42, true);
      const nameStart = p + CENTRAL_SIZE;
      if (nameStart + nameLen > zip.length) {
        this.warnings.push('pakfile: truncated central directory entry');
        break;
      }
      const raw = flags & 0x800 ? utf8(zip, nameStart, nameStart + nameLen) : latin1(zip, nameStart, nameStart + nameLen);
      p = nameStart + nameLen + extraLen + fileCommentLen;

      const name = raw.replace(/\\/g, '/');
      const key = normalizePakPath(name);
      if (!key || key.endsWith('/')) continue; // directory entry
      if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
        this.warnings.push(`pakfile: ZIP64 entry ${name} skipped`);
        continue;
      }
      // Later entries win (tools that append to the pakfile add newer copies at the end).
      this.byKey.set(key, { name, key, method, flags, compressedSize, size, crc32, localHeaderOffset });
    }
    if (totalEntries !== 0xffff && this.byKey.size === 0 && totalEntries > 0) {
      this.warnings.push('pakfile: no readable entries');
    }
  }

  private sigAt(p: number, sig: number): boolean {
    return p >= 0 && p + 4 <= this.zip.length && this.dv.getUint32(p, true) === sig;
  }

  private readEntry(e: PakEntry): Uint8Array | null {
    const zip = this.zip;
    const dv = this.dv;
    if (e.flags & 0x1) return null; // encrypted
    const lh = e.localHeaderOffset + this.shift;
    if (!this.sigAt(lh, SIG_LOCAL) || lh + LOCAL_SIZE > zip.length) return null;
    const nameLen = dv.getUint16(lh + 26, true);
    const extraLen = dv.getUint16(lh + 28, true);
    const dataStart = lh + LOCAL_SIZE + nameLen + extraLen;
    // Sizes come from the central directory (the local header may hold zeros when bit 3 is set).
    const avail = zip.length - dataStart;
    if (avail < 0) return null;

    switch (e.method) {
      case ZIP_STORED: {
        const n = Math.min(e.size, avail);
        if (n < e.size) return null;
        return zip.subarray(dataStart, dataStart + n);
      }
      case ZIP_DEFLATE: {
        const src = zip.subarray(dataStart, dataStart + Math.min(e.compressedSize, avail));
        if (e.size === 0) return new Uint8Array(0);
        const out = inflateSync(src, { out: new Uint8Array(e.size) });
        return out.length === e.size ? out : null;
      }
      case ZIP_LZMA: {
        // ZIP-LZMA: u8 major, u8 minor (LZMA SDK version), u16 propsSize, props[propsSize], raw LZMA stream.
        const n = Math.min(e.compressedSize, avail);
        if (n < 4) return null;
        const propsSize = dv.getUint16(dataStart + 2, true);
        if (propsSize < 5 || 4 + propsSize > n) return null;
        const props = zip.subarray(dataStart + 4, dataStart + 4 + propsSize);
        const stream = zip.subarray(dataStart + 4 + propsSize, dataStart + n);
        if (e.size === 0) return new Uint8Array(0);
        const out = lzmaDecompress(props, stream, e.size);
        return out.length === e.size ? out : null;
      }
      default:
        return null;
    }
  }
}
