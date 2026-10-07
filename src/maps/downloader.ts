// Downloads KSF surf maps straight from the public Google Drive archive (CORS-enabled download
// endpoint), extracts the BSP from .rar/.zip/.bz2 archives in the browser and caches the BSP in
// IndexedDB so each map is downloaded only once.
import { unzipSync } from 'fflate';
import { bunzip2 } from '../bsp/bz2';
import type { LoadProgress } from '../game/api';
import type { CatalogEntry } from './catalog';

const DB_NAME = 'surf-maps';
const STORE = 'bsp';

export function driveDownloadUrl(driveId: string): string {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveId)}&export=download&confirm=t`;
}

export function driveViewUrl(driveId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/view`;
}

// ---------------------------------------------------------------- IndexedDB cache

interface CachedMap {
  name: string;
  data: ArrayBuffer;
  size: number;
  date: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

async function getCached(name: string): Promise<ArrayBuffer | null> {
  const rec = await idb<CachedMap>('readonly', (s) => s.get(name.toLowerCase()));
  return rec?.data ?? null;
}

async function putCached(name: string, data: ArrayBuffer): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* ignore */
  }
  await idb('readwrite', (s) => s.put({ name: name.toLowerCase(), data, size: data.byteLength, date: Date.now() } satisfies CachedMap));
}

export async function listCachedMaps(): Promise<string[]> {
  const keys = await idb<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
  return (keys ?? []).map(String).sort();
}

export async function deleteCachedMap(name: string): Promise<void> {
  await idb('readwrite', (s) => s.delete(name.toLowerCase()));
}

// ---------------------------------------------------------------- download

const MB = 1024 * 1024;
const fmtMB = (n: number) => (n / MB).toFixed(1);

async function download(url: string, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(`Network error while downloading the map (${(e as Error).message}).`);
  }
  if (!res.ok) throw new Error(`Google Drive answered HTTP ${res.status}. The file may be rate-limited; try again later.`);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) {
    throw new Error('Google Drive returned a web page instead of the file (download quota exceeded or file moved). Try again later.');
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.({ phase: 'download', message: `Downloading ${fmtMB(buf.byteLength)} MB`, loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 80) {
      lastReport = now;
      onProgress?.({
        phase: 'download',
        message: total ? `Downloading ${fmtMB(loaded)} / ${fmtMB(total)} MB` : `Downloading ${fmtMB(loaded)} MB`,
        loaded,
        total: total || undefined,
      });
    }
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  onProgress?.({ phase: 'download', message: `Downloaded ${fmtMB(loaded)} MB`, loaded, total: loaded });
  return out.buffer;
}

// ---------------------------------------------------------------- extraction

function startsWith(b: Uint8Array, sig: number[]): boolean {
  if (b.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
  return true;
}

const SIG_VBSP = [0x56, 0x42, 0x53, 0x50];
const SIG_BZ2 = [0x42, 0x5a, 0x68];
const SIG_RAR = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];
const SIG_ZIP = [0x50, 0x4b, 0x03, 0x04];
const SIG_7Z = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

function baseName(path: string): string {
  const p = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return p.replace(/\.bz2$/i, '').replace(/\.bsp$/i, '').replace(/\.(rar|zip|7z)$/i, '').toLowerCase();
}

let unrarWasm: Promise<ArrayBuffer | undefined> | null = null;

async function getUnrarWasm(): Promise<ArrayBuffer | undefined> {
  if (typeof window === 'undefined') return undefined; // node: the library loads its own wasm
  if (!unrarWasm) {
    unrarWasm = (async () => {
      const { default: url } = await import('node-unrar-js/esm/js/unrar.wasm?url');
      const res = await fetch(url);
      return res.arrayBuffer();
    })();
  }
  return unrarWasm;
}

function pickBsp<T extends { name: string; size: number }>(files: T[], hint: string): T | undefined {
  const bsps = files.filter((f) => /\.bsp$/i.test(f.name));
  if (!bsps.length) return undefined;
  return bsps.find((f) => baseName(f.name) === hint) ?? bsps.sort((a, b) => b.size - a.size)[0];
}

/** Returns the BSP inside a downloaded/dropped file (.bsp, .bsp.bz2, .rar, .zip). */
export async function extractMapArchive(data: ArrayBuffer, fileName: string): Promise<{ name: string; bsp: ArrayBuffer }> {
  const bytes = new Uint8Array(data);
  const hint = baseName(fileName);
  if (startsWith(bytes, SIG_VBSP)) return { name: hint, bsp: data };
  if (startsWith(bytes, SIG_BZ2)) {
    const out = bunzip2(bytes);
    if (!startsWith(out, SIG_VBSP)) throw new Error('The .bz2 file does not contain a BSP map.');
    // bunzip2 returns an exact-size buffer at offset 0: no copy needed.
    const exact = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength;
    return { name: hint, bsp: (exact ? out.buffer : out.slice().buffer) as ArrayBuffer };
  }
  if (startsWith(bytes, SIG_RAR)) {
    const { createExtractorFromData } = await import('node-unrar-js');
    const wasmBinary = await getUnrarWasm();
    const extractor = await createExtractorFromData({ data, wasmBinary });
    const headers = [...extractor.getFileList().fileHeaders].map((h) => ({ name: h.name, size: h.unpSize }));
    const target = pickBsp(headers, hint);
    if (!target) throw new Error(`No .bsp file inside ${fileName}.`);
    const extracted = extractor.extract({ files: [target.name] });
    for (const f of extracted.files) {
      if (f.extraction) {
        const u = f.extraction;
        return { name: baseName(target.name), bsp: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer };
      }
    }
    throw new Error(`Could not extract ${target.name} from ${fileName}.`);
  }
  if (startsWith(bytes, SIG_ZIP)) {
    const files = unzipSync(bytes, { filter: (f) => /\.(bsp|bz2)$/i.test(f.name) });
    const list = Object.entries(files).map(([name, d]) => ({ name, size: d.byteLength, d }));
    const target = pickBsp(list, hint) ?? list.find((f) => /\.bsp\.bz2$/i.test(f.name));
    if (!target) throw new Error(`No .bsp file inside ${fileName}.`);
    const d = target.d;
    return extractMapArchive(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer, target.name);
  }
  if (startsWith(bytes, SIG_7Z)) throw new Error('.7z archives are not supported — extract the .bsp and drop it instead.');
  throw new Error(`${fileName} is not a BSP map or a supported archive (.bsp, .bsp.bz2, .rar, .zip).`);
}

/** Cache → download → extract → cache. */
export async function fetchCatalogMap(
  entry: CatalogEntry,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<{ name: string; bsp: ArrayBuffer }> {
  const cached = await getCached(entry.name);
  if (cached) {
    onProgress?.({ phase: 'download', message: 'Loaded from cache', loaded: cached.byteLength, total: cached.byteLength });
    return { name: entry.name, bsp: cached };
  }
  onProgress?.({ phase: 'download', message: 'Contacting Google Drive…' });
  const archive = await download(driveDownloadUrl(entry.driveId), onProgress, signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  onProgress?.({ phase: 'extract', message: 'Extracting map…' });
  await new Promise((r) => setTimeout(r, 0));
  const { bsp } = await extractMapArchive(archive, `${entry.name}.${entry.archive ?? 'rar'}`);
  void putCached(entry.name, bsp);
  return { name: entry.name, bsp };
}
