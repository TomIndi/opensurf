// Linked game content: the player's own CS:S / CS:GO install, picked once in Settings, supplies the stock
// textures (and other content) that maps reference but don't pack. Files are read lazily, straight from the
// player's disk; nothing is uploaded, copied or redistributed.
//
// Module singleton. The UI links a folder (File System Access API: a FileSystemDirectoryHandle, remembered in
// IndexedDB across visits; or the <input webkitdirectory> fallback: this visit only), the map loader reads
// getGameContent() / gameContentForLoad(). Status changes are broadcast to onGameContentChange listeners.
//
// Finding the VPKs is lazy: starting at the picked folder, only the entries of a few known directories are
// listed (the game root, "cstrike", "hl2", "csgo", Steam's "steamapps"/"common", the game folders' names) — never
// the whole install — and the numbered "_NNN.vpk" archives are opened only when a file inside them is read.
// The player may pick the game root ("Counter-Strike Source"), "cstrike", "steamapps/common", a Steam library...
import { BlobLike, GameContent, VpkSet, isKnownVpkBase, openGameContent, openGameContentFromFiles, parseVpkFileName } from './vpk';

export type GameContentState = 'none' | 'linked' | 'needs-permission' | 'error';

export interface GameContentStatus {
  state: GameContentState;
  /** Name of the linked (or remembered) folder, e.g. "Counter-Strike Source". */
  label?: string;
  /** VPK sets in use, in priority order: "csgo/pak01", "cstrike/cstrike_pak", "hl2/hl2_textures", "hl2/hl2_misc". */
  archives?: string[];
  /** Number of files indexed across those archives. */
  files?: number;
  /**
   * 'error': what went wrong (no game files found, folder gone...). 'linked': advice when content is partial
   * (e.g. only "cstrike" was picked, so the HL2 textures are missing). 'needs-permission': what to click.
   */
  message?: string;
  /** 'folder': a directory handle (remembered across visits); 'files': picked with <input webkitdirectory> (this visit only). */
  source?: 'folder' | 'files';
}

// ------------------------------------------------------------------------------------------ handle types

/** The parts of FileSystemFileHandle we use (structural, so tests can pass fakes). */
export interface GameFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<BlobLike>;
}

/** The parts of FileSystemDirectoryHandle we use (structural, so tests can pass fakes). */
export interface GameDirectoryHandle {
  kind: 'directory';
  name: string;
  values?(): AsyncIterable<GameFileHandle | GameDirectoryHandle>;
  entries?(): AsyncIterable<[string, GameFileHandle | GameDirectoryHandle]>;
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** Where the picked directory handle is remembered (IndexedDB by default; replaceable for tests/other hosts). */
export interface GameContentHandleStore {
  load(): Promise<GameDirectoryHandle | null>;
  save(handle: GameDirectoryHandle): Promise<void>;
  clear(): Promise<void>;
}

// ------------------------------------------------------------------------------------------ folder walk

/** Directories descended into (lower-case). Anything else is never listed. */
const DESCEND = new Set([
  'cstrike',
  'hl2',
  'csgo',
  'game', // CS2's layout ("game/csgo"); its Source 2 VPKs are recognised and skipped
  'common',
  'steamapps',
  'steamlibrary',
  'steam',
  'counter-strike source',
  'counter-strike global offensive',
  'half-life 2',
]);
const MAX_DEPTH = 5;
const MAX_DIRS = 48;

async function* listDir(dir: GameDirectoryHandle): AsyncGenerator<GameFileHandle | GameDirectoryHandle> {
  if (typeof dir.values === 'function') {
    for await (const h of dir.values()) yield h;
  } else if (typeof dir.entries === 'function') {
    for await (const [, h] of dir.entries()) yield h;
  }
}

/**
 * A BlobLike over a file handle: getFile() runs on the first read (the numbered archives of an unused VPK are
 * never opened). A File snapshot goes stale when the game updates the file; reads then re-open it once.
 */
export function fileHandleBlob(fh: GameFileHandle): BlobLike {
  let file: Promise<BlobLike> | null = null;
  const get = (fresh: boolean): Promise<BlobLike> => {
    if (!fresh && file) return file;
    const p = Promise.resolve().then(() => fh.getFile());
    file = p;
    p.catch(() => {
      if (file === p) file = null;
    });
    return p;
  };
  return {
    slice(start?: number, end?: number) {
      return {
        async arrayBuffer() {
          try {
            return await (await get(false)).slice(start, end).arrayBuffer();
          } catch {
            return (await get(true)).slice(start, end).arrayBuffer();
          }
        },
      };
    },
  };
}

/** What a folder walk found. */
export interface GameFolderScan {
  sets: VpkSet[];
  /** Directories listed (for diagnostics/tests). */
  dirsListed: string[];
}

/**
 * Finds the known VPK sets (KNOWN_VPKS) below `root` (breadth first, at most MAX_DEPTH levels, only into the
 * directories named in DESCEND). Unreadable directories are skipped.
 */
export async function scanGameFolder(root: GameDirectoryHandle): Promise<GameFolderScan> {
  type Group = { base: string; location: string; dir: GameFileHandle | null; archives: Map<number, GameFileHandle> };
  const groups = new Map<string, Group>();
  const dirsListed: string[] = [];
  const queue: { dir: GameDirectoryHandle; path: string; depth: number }[] = [{ dir: root, path: root.name, depth: 0 }];
  while (queue.length && dirsListed.length < MAX_DIRS) {
    const { dir, path, depth } = queue.shift()!;
    dirsListed.push(path);
    try {
      for await (const h of listDir(dir)) {
        if (h.kind === 'file') {
          const parsed = parseVpkFileName(h.name);
          if (!parsed || !isKnownVpkBase(parsed.base)) continue;
          const key = `${path.toLowerCase()}/${parsed.base}`;
          let g = groups.get(key);
          if (!g) groups.set(key, (g = { base: parsed.base, location: path, dir: null, archives: new Map() }));
          if (parsed.index < 0) g.dir = h;
          else g.archives.set(parsed.index, h);
        } else if (h.kind === 'directory' && depth < MAX_DEPTH && DESCEND.has(h.name.toLowerCase())) {
          queue.push({ dir: h, path: `${path}/${h.name}`, depth: depth + 1 });
        }
      }
    } catch {
      // permission / IO error on one directory: keep what the others give
    }
  }
  const sets: VpkSet[] = [];
  for (const g of groups.values()) {
    if (!g.dir) continue;
    const blobs = new Map<number, BlobLike>();
    const archives = g.archives;
    sets.push({
      base: g.base,
      location: g.location,
      dirFile: fileHandleBlob(g.dir),
      getArchive: (i) => {
        let b = blobs.get(i);
        if (!b) {
          const fh = archives.get(i);
          if (!fh) return null;
          blobs.set(i, (b = fileHandleBlob(fh)));
        }
        return b;
      },
    });
  }
  return { sets, dirsListed };
}

// ------------------------------------------------------------------------------------------ persistence

const DB_NAME = 'surf-gamecontent';
const DB_STORE = 'handles';
const DB_KEY = 'folder';

function idbRequest<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction(DB_STORE, mode);
        const r = fn(tx.objectStore(DB_STORE));
        r.onsuccess = () => resolve((r.result as T) ?? null);
        r.onerror = () => resolve(null);
        tx.oncomplete = () => db.close();
        tx.onabort = () => db.close();
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

/** Default store: the directory handle in IndexedDB (handles are structured-cloneable; File objects are not kept). */
export const indexedDbHandleStore: GameContentHandleStore = {
  load: () => idbRequest<GameDirectoryHandle>('readonly', (s) => s.get(DB_KEY)),
  save: async (h) => {
    await idbRequest('readwrite', (s) => s.put(h, DB_KEY));
  },
  clear: async () => {
    await idbRequest('readwrite', (s) => s.delete(DB_KEY));
  },
};

// ------------------------------------------------------------------------------------------ singleton state

let store: GameContentHandleStore = indexedDbHandleStore;
let content: GameContent | null = null;
let status: GameContentStatus = { state: 'none' };
/** Remembered handle waiting for requestGameContentPermission(). */
let pendingHandle: GameDirectoryHandle | null = null;
let restoreAttempted = false;
/** Bumped by every link/unlink: results of superseded operations are dropped. */
let opSeq = 0;
let inflight: Promise<unknown> | null = null;
const listeners = new Set<(s: GameContentStatus) => void>();

function setStatus(next: GameContentStatus, nextContent: GameContent | null): GameContentStatus {
  content = nextContent;
  status = next;
  const snapshot = getGameContentStatus();
  for (const cb of [...listeners]) {
    try {
      cb(snapshot);
    } catch {
      // a broken listener must not break linking
    }
  }
  return snapshot;
}

function track<T>(p: Promise<T>): Promise<T> {
  inflight = p;
  const clear = () => {
    if (inflight === p) inflight = null;
  };
  p.then(clear, clear);
  return p;
}

const PICK_ADVICE = 'Pick your "Counter-Strike Source" or CS:GO game folder (in Steam: right-click the game → Manage → Browse local files).';

/** Advice for a partial link (e.g. "cstrike" alone has no HL2 textures). */
function adviceFor(gc: GameContent): string | undefined {
  const names = gc.archiveNames;
  const hasCss = names.includes('cstrike/cstrike_pak');
  const hasHl2 = names.includes('hl2/hl2_textures');
  if (hasCss && !hasHl2 && !names.includes('csgo/pak01')) {
    return 'The HL2 textures (hl2_textures) were not found, so some stock textures stay generated. Pick the "Counter-Strike Source" folder (the one containing both "cstrike" and "hl2") to include them.';
  }
  return undefined;
}

function linkedStatus(gc: GameContent, label: string, source: 'folder' | 'files'): GameContentStatus {
  const s: GameContentStatus = { state: 'linked', label, archives: gc.archiveNames, files: gc.fileCount, source };
  const advice = adviceFor(gc);
  if (advice) s.message = advice;
  return s;
}

function notFoundStatus(label: string, notes: string[], source: 'folder' | 'files'): GameContentStatus {
  const cs2 = notes.some((n) => /Counter-Strike 2/.test(n));
  const message = cs2
    ? `"${label}" only has Counter-Strike 2 (Source 2) files, which can't be used. ${PICK_ADVICE}`
    : `No CS:S or CS:GO game files (…_dir.vpk) found in "${label}". ${PICK_ADVICE}`;
  return { state: 'error', label, message, source };
}

function isDirectoryHandle(h: unknown): h is GameDirectoryHandle {
  return !!h && typeof h === 'object' && (h as GameDirectoryHandle).kind === 'directory' && typeof (h as GameDirectoryHandle).name === 'string';
}

async function openFromHandle(handle: GameDirectoryHandle): Promise<{ gc: GameContent | null; notes: string[] }> {
  const scan = await scanGameFolder(handle);
  const notes: string[] = [];
  const gc = await openGameContent(scan.sets, handle.name, notes);
  for (const n of notes) console.warn(`[gamecontent] ${n}`);
  return { gc, notes };
}

// ------------------------------------------------------------------------------------------ public API

/** The linked content (null when nothing is linked or access isn't granted yet). */
export function getGameContent(): GameContent | null {
  return content;
}

/** A copy of the current status. */
export function getGameContentStatus(): GameContentStatus {
  const s: GameContentStatus = { ...status };
  if (status.archives) s.archives = [...status.archives];
  return s;
}

/** Calls `cb` with the new status after every change. Returns the unsubscribe function. */
export function onGameContentChange(cb: (s: GameContentStatus) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** True when the browser has window.showDirectoryPicker (Chromium); otherwise use <input type=file webkitdirectory>. */
export function isGameFolderPickerSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * Opens the browser's folder picker (call from a click) and links the picked folder. Cancelling the picker
 * leaves the current link unchanged. Throws when the picker isn't supported (see isGameFolderPickerSupported).
 */
export async function pickGameContentFolder(): Promise<GameContentStatus> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<GameDirectoryHandle> }).showDirectoryPicker;
  if (typeof picker !== 'function') throw new Error('This browser has no folder picker: use linkGameContentFromFiles with <input webkitdirectory>.');
  let handle: GameDirectoryHandle;
  try {
    handle = await picker.call(window, { id: 'surf-game-content', mode: 'read' });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return getGameContentStatus();
    throw e;
  }
  return linkGameContentFromDirectoryHandle(handle);
}

/**
 * Links a picked folder (FileSystemDirectoryHandle from showDirectoryPicker). On success the handle is
 * remembered (IndexedDB) so restoreGameContent() can reopen it on the next visit. On failure the status is
 * 'error' (with a message) and nothing is linked.
 */
export function linkGameContentFromDirectoryHandle(handle: FileSystemDirectoryHandle | GameDirectoryHandle): Promise<GameContentStatus> {
  const h = handle as unknown as GameDirectoryHandle;
  const seq = ++opSeq;
  restoreAttempted = true;
  return track(
    (async () => {
      try {
        const { gc, notes } = await openFromHandle(h);
        if (seq !== opSeq) return getGameContentStatus();
        if (!gc) {
          await store.clear().catch(() => undefined);
          return setStatus(notFoundStatus(h.name, notes, 'folder'), null);
        }
        pendingHandle = null;
        await store.save(h).catch(() => undefined);
        if (seq !== opSeq) return getGameContentStatus();
        return setStatus(linkedStatus(gc, h.name, 'folder'), gc);
      } catch (e) {
        if (seq !== opSeq) return getGameContentStatus();
        return setStatus({ state: 'error', label: h.name, message: `Could not read "${h.name}": ${(e as Error).message}`, source: 'folder' }, null);
      }
    })(),
  );
}

/**
 * Links the files of an <input type="file" webkitdirectory> selection (browsers without showDirectoryPicker).
 * Only the known VPK files are kept (the browser lists the whole folder; nothing else is read). Not remembered
 * across visits: the files have to be picked again after a reload.
 */
export function linkGameContentFromFiles(files: FileList | ArrayLike<File> | Iterable<File>): Promise<GameContentStatus> {
  const seq = ++opSeq;
  restoreAttempted = true;
  const list: File[] = Array.from(files as ArrayLike<File>);
  return track(
    (async () => {
      const map = new Map<string, BlobLike>();
      let label = '';
      for (const f of list) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        if (!label) label = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
        const parsed = parseVpkFileName(rel.slice(rel.lastIndexOf('/') + 1));
        if (parsed && isKnownVpkBase(parsed.base)) map.set(rel, f);
      }
      label = label || 'selected files';
      try {
        const notes: string[] = [];
        const gc = await openGameContentFromFiles(map, { label, notes });
        for (const n of notes) console.warn(`[gamecontent] ${n}`);
        if (seq !== opSeq) return getGameContentStatus();
        // A files link replaces a remembered folder.
        pendingHandle = null;
        await store.clear().catch(() => undefined);
        if (seq !== opSeq) return getGameContentStatus();
        if (!gc) return setStatus(notFoundStatus(label, notes, 'files'), null);
        return setStatus(linkedStatus(gc, label, 'files'), gc);
      } catch (e) {
        if (seq !== opSeq) return getGameContentStatus();
        return setStatus({ state: 'error', label, message: `Could not read "${label}": ${(e as Error).message}`, source: 'files' }, null);
      }
    })(),
  );
}

/**
 * Re-opens the folder remembered from an earlier visit. Call once at startup. Resolves to 'linked' when read
 * access is still granted, 'needs-permission' when the browser wants a click first (then call
 * requestGameContentPermission() from a button), 'none' when nothing is remembered, 'error' when the folder
 * can't be read any more (moved, drive missing; it stays remembered). Doesn't replace a link made this visit.
 */
export function restoreGameContent(): Promise<GameContentStatus> {
  restoreAttempted = true;
  if (content) return Promise.resolve(getGameContentStatus());
  // A link (or restore) in progress decides: wait for it instead of racing it.
  if (inflight) return inflight.then(getGameContentStatus, getGameContentStatus);
  const seq = opSeq;
  return track(
    (async () => {
      let handle: GameDirectoryHandle | null = null;
      try {
        const h = await store.load();
        handle = isDirectoryHandle(h) ? h : null;
      } catch {
        handle = null;
      }
      // Nothing remembered: leave the status alone (it may carry the error of a link attempt made this visit).
      if (seq !== opSeq || !handle) return getGameContentStatus();
      let perm: PermissionState = 'granted';
      try {
        if (typeof handle.queryPermission === 'function') perm = await handle.queryPermission({ mode: 'read' });
      } catch {
        perm = 'prompt';
      }
      if (seq !== opSeq) return getGameContentStatus();
      if (perm !== 'granted') {
        pendingHandle = handle;
        return setStatus(
          { state: 'needs-permission', label: handle.name, source: 'folder', message: `Allow access to "${handle.name}" to use your game's textures.` },
          null,
        );
      }
      return reopen(handle, seq);
    })(),
  );
}

async function reopen(handle: GameDirectoryHandle, seq: number): Promise<GameContentStatus> {
  try {
    const { gc, notes } = await openFromHandle(handle);
    if (seq !== opSeq) return getGameContentStatus();
    pendingHandle = null;
    if (!gc) return setStatus(notFoundStatus(handle.name, notes, 'folder'), null);
    return setStatus(linkedStatus(gc, handle.name, 'folder'), gc);
  } catch (e) {
    if (seq !== opSeq) return getGameContentStatus();
    return setStatus({ state: 'error', label: handle.name, message: `Could not read "${handle.name}": ${(e as Error).message}`, source: 'folder' }, null);
  }
}

/**
 * Asks the browser for read access to the remembered folder. Must be called from a user gesture (click) while
 * the status is 'needs-permission'. Resolves to 'linked' when granted, else stays 'needs-permission'.
 */
export function requestGameContentPermission(): Promise<GameContentStatus> {
  const handle = pendingHandle;
  if (!handle) return Promise.resolve(getGameContentStatus());
  const seq = ++opSeq;
  return track(
    (async () => {
      let perm: PermissionState = 'denied';
      try {
        perm = typeof handle.requestPermission === 'function' ? await handle.requestPermission({ mode: 'read' }) : 'granted';
      } catch {
        perm = 'denied';
      }
      if (seq !== opSeq) return getGameContentStatus();
      if (perm !== 'granted') {
        return setStatus(
          { state: 'needs-permission', label: handle.name, source: 'folder', message: `Access to "${handle.name}" was not granted. Click again to allow it, or link the folder again.` },
          null,
        );
      }
      return reopen(handle, seq);
    })(),
  );
}

/** Forgets the linked folder (and the remembered handle). */
export async function unlinkGameContent(): Promise<void> {
  ++opSeq;
  restoreAttempted = true;
  pendingHandle = null;
  setStatus({ state: 'none' }, null);
  await store.clear().catch(() => undefined);
}

/**
 * The content to use for a map load: waits for a link/restore in progress and, if nothing was attempted yet
 * this visit, tries restoreGameContent() first (cheap: one IndexedDB read). Never throws.
 */
export async function gameContentForLoad(): Promise<GameContent | null> {
  try {
    if (!restoreAttempted && !content && status.state === 'none') await restoreGameContent();
    while (inflight) {
      const p = inflight;
      await p.catch(() => undefined);
      if (inflight === p) break;
    }
  } catch {
    // fall through with whatever is linked
  }
  return content;
}

/**
 * Replaces where the directory handle is remembered (default: IndexedDB) and resets the module to "nothing
 * linked". For tests and non-browser hosts.
 */
export function setGameContentHandleStore(s: GameContentHandleStore | null): void {
  store = s ?? indexedDbHandleStore;
  ++opSeq;
  content = null;
  status = { state: 'none' };
  pendingHandle = null;
  restoreAttempted = false;
  inflight = null;
}
