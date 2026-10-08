// Valve Pak (VPK v1/v2) reader. Lets players who own CS:S / CS:GO point the game at their install
// folder so stock textures (and other content) referenced by maps load exactly like in game.
// Content is read lazily from the user's local files; nothing is uploaded or redistributed.
//
// Format (public documentation): a "<name>_dir.vpk" file holds a header (v1: 12 bytes, v2: 28 bytes) and a
// directory tree grouped extension → directory → file name (NUL-terminated strings, " " for "none"). Each file
// entry is { crc32, preloadBytes u16, archiveIndex u16, offset u32, length u32, 0xffff } followed by its preload
// bytes. archiveIndex 0x7fff means the data follows the tree inside the _dir file; any other index names the
// "<name>_NNN.vpk" archive holding it.
//
// Linking (picking a folder, remembering it, permissions) lives in ./gamecontent.ts.

export interface VpkEntry {
  crc: number;
  /** 0x7fff = stored in the _dir file after the tree. */
  archiveIndex: number;
  offset: number;
  length: number;
  preload: Uint8Array | null;
}

/** Anything with Blob-like slicing (File, Blob, or a lazy wrapper around a FileSystemFileHandle). */
export interface BlobLike {
  size?: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

const VPK_SIGNATURE = 0x55aa1234;
const DIR_ARCHIVE = 0x7fff;

export function normalizeVpkPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '').toLowerCase();
}

/** Parses a VPK directory tree. `bytes` must contain at least the header and the whole tree. */
export function parseVpkDirectory(bytes: Uint8Array): {
  entries: Map<string, VpkEntry>;
  dataOffset: number;
  version: number;
  /** Number of files per extension (lower-case, no dot; "" for files without one). */
  extensions: Map<string, number>;
} {
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
  const extensions = new Map<string, number>();
  for (;;) {
    const ext = readString();
    if (!ext) break;
    const extKey = ext === ' ' ? '' : ext.toLowerCase();
    let count = 0;
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
        if (p + preloadBytes > treeEnd) throw new Error('truncated VPK preload data');
        const preload = preloadBytes ? bytes.slice(p, p + preloadBytes) : null;
        p += preloadBytes;
        const path = (dir === ' ' ? '' : `${dir}/`) + (file === ' ' ? '' : file) + (ext === ' ' ? '' : `.${ext}`);
        entries.set(normalizeVpkPath(path), { crc, archiveIndex, offset, length, preload });
        count++;
      }
    }
    extensions.set(extKey, (extensions.get(extKey) ?? 0) + count);
  }
  return { entries, dataOffset: treeEnd, version, extensions };
}

export class VpkArchive {
  private constructor(
    readonly name: string,
    private readonly entries: Map<string, VpkEntry>,
    private readonly dirFile: BlobLike,
    private readonly dataOffset: number,
    private readonly getArchive: (index: number) => BlobLike | null,
    private readonly extensions: Map<string, number>,
  ) {}

  /**
   * @param name e.g. "cstrike/cstrike_pak"
   * @param dirFile the "<name>_dir.vpk" file
   * @param getArchive returns "<name>_NNN.vpk" for an archive index (or null if missing)
   */
  static async open(name: string, dirFile: BlobLike, getArchive: (index: number) => BlobLike | null): Promise<VpkArchive> {
    // Read the header to learn the tree size, then the tree.
    const head = new Uint8Array(await dirFile.slice(0, 28).arrayBuffer());
    if (head.byteLength < 12) throw new Error(`${name}: not a VPK directory file`);
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (dv.getUint32(0, true) !== VPK_SIGNATURE) throw new Error(`${name}: not a VPK directory file`);
    const version = dv.getUint32(4, true);
    const treeSize = dv.getUint32(8, true);
    const headerSize = version === 2 ? 28 : 12;
    const tree = new Uint8Array(await dirFile.slice(0, headerSize + treeSize).arrayBuffer());
    const { entries, dataOffset, extensions } = parseVpkDirectory(tree);
    return new VpkArchive(name, entries, dirFile, dataOffset, getArchive, extensions);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Number of files with extension `ext` ("vtf", "vmt"...). */
  countExtension(ext: string): number {
    return this.extensions.get(ext.replace(/^\./, '').toLowerCase()) ?? 0;
  }

  /** True when the archive holds Source 1 materials (.vmt / .vtf). Source 2 (CS2) VPKs hold .vmat_c / .vtex_c. */
  get hasSource1Materials(): boolean {
    return this.countExtension('vtf') + this.countExtension('vmt') > 0;
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
    if (data.byteLength !== e.length) return null; // archive shorter than the tree says (truncated / wrong file)
    if (!pre) return data;
    const out = new Uint8Array(pre.length + data.length);
    out.set(pre, 0);
    out.set(data, pre.length);
    return out;
  }
}

/** Several VPKs searched in priority order (e.g. cstrike_pak first, then hl2 textures). */
export class GameContent {
  constructor(
    readonly archives: VpkArchive[],
    readonly label: string,
  ) {}

  /** Archive names in priority order ("csgo/pak01", "cstrike/cstrike_pak", ...). */
  get archiveNames(): string[] {
    return this.archives.map((a) => a.name);
  }

  /** Total number of files across the archives. */
  get fileCount(): number {
    return this.archives.reduce((n, a) => n + a.size, 0);
  }

  has(path: string): boolean {
    const p = normalizeVpkPath(path);
    return this.archives.some((a) => a.has(p));
  }

  /** The file from the first archive that has it and can read it (a missing _NNN archive falls through). */
  async read(path: string): Promise<Uint8Array | null> {
    const p = normalizeVpkPath(path);
    for (const a of this.archives) {
      if (!a.has(p)) continue;
      const d = await a.read(p);
      if (d) return d;
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

/** VPK sets we look for inside a picked game folder, in priority order ("<game dir>/<vpk base name>"). */
export const KNOWN_VPKS = [
  // CS:GO
  'csgo/pak01',
  // CS:S
  'cstrike/cstrike_pak',
  // HL2 base content used by CS:S maps (textures: VTFs; misc: VMTs, models)
  'hl2/hl2_textures',
  'hl2/hl2_misc',
];

const KNOWN_BASES = KNOWN_VPKS.map((k) => k.slice(k.indexOf('/') + 1));

/** "cstrike_pak_dir.vpk" → { base: "cstrike_pak", index: -1 }, "pak01_012.vpk" → { base: "pak01", index: 12 }. */
export function parseVpkFileName(fileName: string): { base: string; index: number } | null {
  const m = /^(.+)_(dir|\d{3})\.vpk$/i.exec(fileName.trim());
  if (!m) return null;
  return { base: m[1].toLowerCase(), index: m[2].toLowerCase() === 'dir' ? -1 : parseInt(m[2], 10) };
}

/** True for the VPK base names we use ("pak01", "cstrike_pak", "hl2_textures", "hl2_misc"). */
export function isKnownVpkBase(base: string): boolean {
  return KNOWN_BASES.includes(base.toLowerCase());
}

/** The KNOWN_VPKS name for a base name ("cstrike_pak" → "cstrike/cstrike_pak"). */
export function knownVpkName(base: string): string {
  const i = KNOWN_BASES.indexOf(base.toLowerCase());
  return i >= 0 ? KNOWN_VPKS[i] : base.toLowerCase();
}

/** One VPK set found on disk: its _dir file and a lookup of its numbered archives. */
export interface VpkSet {
  /** Base name ("cstrike_pak"). */
  base: string;
  /** Where it was found, for messages ("Counter-Strike Source/cstrike"). */
  location: string;
  dirFile: BlobLike;
  getArchive: (index: number) => BlobLike | null;
}

/**
 * Opens the known VPK sets among `sets` in priority order (KNOWN_VPKS). Sets that fail to open, duplicates of a
 * base already opened and Source 2 archives (CS2: no .vmt/.vtf files) are skipped with a message in `notes`.
 * Null when nothing usable remains.
 */
export async function openGameContent(sets: VpkSet[], label: string, notes?: string[]): Promise<GameContent | null> {
  const known = sets.filter((s) => isKnownVpkBase(s.base));
  known.sort((a, b) => KNOWN_BASES.indexOf(a.base) - KNOWN_BASES.indexOf(b.base));
  const archives: VpkArchive[] = [];
  const opened = new Set<string>();
  for (const s of known) {
    if (opened.has(s.base)) continue;
    try {
      const vpk = await VpkArchive.open(knownVpkName(s.base), s.dirFile, s.getArchive);
      if (!vpk.hasSource1Materials) {
        notes?.push(`${s.location}/${s.base}_dir.vpk has no Source 1 materials (Counter-Strike 2 content can't be used)`);
        continue;
      }
      archives.push(vpk);
      opened.add(s.base);
    } catch (e) {
      notes?.push(`${s.location}/${s.base}_dir.vpk: ${(e as Error).message}`);
    }
  }
  if (!archives.length) return null;
  return new GameContent(archives, label);
}

/**
 * Builds GameContent from a flat list of files (e.g. from <input webkitdirectory>). `files` maps relative
 * paths ("Counter-Strike Source/cstrike/cstrike_pak_dir.vpk") to blobs; files other than known VPKs are ignored.
 */
export async function openGameContentFromFiles(
  files: Map<string, BlobLike>,
  opts: { label?: string; notes?: string[] } = {},
): Promise<GameContent | null> {
  // Group by "<directory>/<base>" so two installs (or CS:GO's and CS2's pak01) never mix archives.
  const groups = new Map<string, { base: string; location: string; dir: BlobLike | null; archives: Map<number, BlobLike> }>();
  for (const [path, blob] of files) {
    const norm = path.replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    const parsed = parseVpkFileName(norm.slice(slash + 1));
    if (!parsed || !isKnownVpkBase(parsed.base)) continue;
    const location = slash >= 0 ? norm.slice(0, slash) : '';
    const key = `${location.toLowerCase()}/${parsed.base}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { base: parsed.base, location, dir: null, archives: new Map() }));
    if (parsed.index < 0) g.dir = blob;
    else g.archives.set(parsed.index, blob);
  }
  const sets: VpkSet[] = [];
  for (const g of groups.values()) {
    if (!g.dir) continue;
    const archives = g.archives;
    sets.push({ base: g.base, location: g.location, dirFile: g.dir, getArchive: (i) => archives.get(i) ?? null });
  }
  const label = opts.label ?? (sets.map((s) => knownVpkName(s.base)).join(', ') || 'game content');
  return openGameContent(sets, label, opts.notes);
}
