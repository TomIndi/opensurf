// Valve Pak (VPK v1/v2) reader. Lets players who own CS:S / CS:GO point the game at their install
// folder so stock textures (and other content) referenced by maps load exactly like in game.
// Content is read lazily from the user's local files; nothing is uploaded or redistributed.

export interface VpkEntry {
  crc: number;
  /** 0x7fff = stored in the _dir file after the tree. */
  archiveIndex: number;
  offset: number;
  length: number;
  preload: Uint8Array | null;
}

/** Anything with Blob-like slicing (File, Blob). */
export interface BlobLike {
  size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

const VPK_SIGNATURE = 0x55aa1234;
const DIR_ARCHIVE = 0x7fff;

export function normalizeVpkPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '').toLowerCase();
}

/** Parses a VPK directory tree. `bytes` must contain at least the header and the whole tree. */
export function parseVpkDirectory(bytes: Uint8Array): { entries: Map<string, VpkEntry>; dataOffset: number; version: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || dv.getUint32(0, true) !== VPK_SIGNATURE) throw new Error('not a VPK directory file');
  const version = dv.getUint32(4, true);
  const treeSize = dv.getUint32(8, true);
  let headerSize: number;
  if (version === 1) headerSize = 12;
  else if (version === 2) headerSize = 28;
  else throw new Error(`unsupported VPK version ${version}`);
  const treeEnd = headerSize + treeSize;
  if (treeEnd > bytes.byteLength) throw new Error('truncated VPK tree');

  let p = headerSize;
  const readString = (): string => {
    let end = p;
    while (end < treeEnd && bytes[end] !== 0) end++;
    let s = '';
    for (let i = p; i < end; i++) s += String.fromCharCode(bytes[i]);
    p = end + 1;
    return s;
  };

  const entries = new Map<string, VpkEntry>();
  for (;;) {
    const ext = readString();
    if (!ext) break;
    for (;;) {
      const dir = readString();
      if (!dir) break;
      for (;;) {
        const file = readString();
        if (!file) break;
        if (p + 18 > treeEnd) throw new Error('truncated VPK entry');
        const crc = dv.getUint32(p, true);
        const preloadBytes = dv.getUint16(p + 4, true);
        const archiveIndex = dv.getUint16(p + 6, true);
        const offset = dv.getUint32(p + 8, true);
        const length = dv.getUint32(p + 12, true);
        // terminator 0xffff at p + 16
        p += 18;
        const preload = preloadBytes ? bytes.slice(p, p + preloadBytes) : null;
        p += preloadBytes;
        const path = (dir === ' ' ? '' : `${dir}/`) + (file === ' ' ? '' : file) + (ext === ' ' ? '' : `.${ext}`);
        entries.set(normalizeVpkPath(path), { crc, archiveIndex, offset, length, preload });
      }
    }
  }
  return { entries, dataOffset: treeEnd, version };
}

export class VpkArchive {
  private constructor(
    readonly name: string,
    private readonly entries: Map<string, VpkEntry>,
    private readonly dirFile: BlobLike,
    private readonly dataOffset: number,
    private readonly getArchive: (index: number) => BlobLike | null,
  ) {}

  /**
   * @param name e.g. "cstrike_pak"
   * @param dirFile the "<name>_dir.vpk" file
   * @param getArchive returns "<name>_NNN.vpk" for an archive index (or null if missing)
   */
  static async open(name: string, dirFile: BlobLike, getArchive: (index: number) => BlobLike | null): Promise<VpkArchive> {
    // Read the header to learn the tree size, then the tree.
    const head = new Uint8Array(await dirFile.slice(0, 28).arrayBuffer());
    const dv = new DataView(head.buffer);
    if (dv.getUint32(0, true) !== VPK_SIGNATURE) throw new Error(`${name}: not a VPK directory file`);
    const version = dv.getUint32(4, true);
    const treeSize = dv.getUint32(8, true);
    const headerSize = version === 2 ? 28 : 12;
    const tree = new Uint8Array(await dirFile.slice(0, headerSize + treeSize).arrayBuffer());
    const { entries, dataOffset } = parseVpkDirectory(tree);
    return new VpkArchive(name, entries, dirFile, dataOffset, getArchive);
  }

  get size(): number {
    return this.entries.size;
  }

  has(path: string): boolean {
    return this.entries.has(normalizeVpkPath(path));
  }

  list(prefix = ''): string[] {
    const pre = normalizeVpkPath(prefix);
    const out: string[] = [];
    for (const k of this.entries.keys()) if (k.startsWith(pre)) out.push(k);
    return out;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const e = this.entries.get(normalizeVpkPath(path));
    if (!e) return null;
    const pre = e.preload;
    if (!e.length) return pre ? pre.slice() : new Uint8Array(0);
    let blob: BlobLike | null;
    let start: number;
    if (e.archiveIndex === DIR_ARCHIVE) {
      blob = this.dirFile;
      start = this.dataOffset + e.offset;
    } else {
      blob = this.getArchive(e.archiveIndex);
      start = e.offset;
    }
    if (!blob) return null;
    const data = new Uint8Array(await blob.slice(start, start + e.length).arrayBuffer());
    if (!pre) return data;
    const out = new Uint8Array(pre.length + data.length);
    out.set(pre, 0);
    out.set(data, pre.length);
    return out;
  }
}

/** Several VPKs searched in priority order (e.g. cstrike_pak first, then hl2 textures). */
export class GameContent {
  constructor(readonly archives: VpkArchive[], readonly label: string) {}

  has(path: string): boolean {
    return this.archives.some((a) => a.has(path));
  }

  async read(path: string): Promise<Uint8Array | null> {
    for (const a of this.archives) {
      if (a.has(path)) return a.read(path);
    }
    return null;
  }

  /** Reads many files concurrently; missing files are omitted. */
  async readMany(paths: Iterable<string>, concurrency = 16): Promise<Map<string, Uint8Array>> {
    const list = [...new Set([...paths].map(normalizeVpkPath))].filter((p) => this.has(p));
    const out = new Map<string, Uint8Array>();
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const p = list[i++];
        const d = await this.read(p);
        if (d) out.set(p, d);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return out;
  }
}

/** VPK sets we look for inside a picked game folder, in priority order. */
export const KNOWN_VPKS = [
  // CS:GO
  'csgo/pak01',
  // CS:S
  'cstrike/cstrike_pak',
  // HL2 base content used by CS:S maps
  'hl2/hl2_textures',
  'hl2/hl2_misc',
];

/**
 * Builds GameContent from a flat list of files (e.g. from <input webkitdirectory> or a recursive
 * walk of a FileSystemDirectoryHandle). `files` maps relative paths ("cstrike/cstrike_pak_dir.vpk") to blobs.
 */
export async function openGameContentFromFiles(files: Map<string, BlobLike>): Promise<GameContent | null> {
  const byLower = new Map<string, BlobLike>();
  for (const [k, v] of files) byLower.set(normalizeVpkPath(k), v);
  const archives: VpkArchive[] = [];
  const names: string[] = [];
  for (const base of KNOWN_VPKS) {
    // Accept the folder picked at any level: match by suffix.
    const dirKey = [...byLower.keys()].find((k) => k === `${base}_dir.vpk` || k.endsWith(`/${base}_dir.vpk`) || k === `${base.split('/')[1]}_dir.vpk`);
    if (!dirKey) continue;
    const prefix = dirKey.slice(0, -'_dir.vpk'.length);
    try {
      const vpk = await VpkArchive.open(base, byLower.get(dirKey)!, (idx) => byLower.get(`${prefix}_${String(idx).padStart(3, '0')}.vpk`) ?? null);
      archives.push(vpk);
      names.push(base);
    } catch (e) {
      console.warn(`VPK ${dirKey}: ${(e as Error).message}`);
    }
  }
  if (!archives.length) return null;
  return new GameContent(archives, names.join(', '));
}
