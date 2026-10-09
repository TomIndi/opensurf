// KSF world records (ksf.surf): the WR and top times of a map's main course, and the replay files of the records.
//
// The browser can't read ksf.surf (no CORS headers): everything goes through the local dev / preview server's
// /__ksf/ routes (vite.config.ts, validated in maps/ksfproxy.ts) or, on static hosting, the same routes on the SURF
// relay (worker/, src/maps/relay.ts) when the build names one. Without either the client sees no proxy header and
// the service reports 'unavailable' once for the whole session: no WR is shown, and the commands explain what is
// needed. Data is fetched on demand and kept in memory for the session
// (record lists per map + board, a few parsed replays); nothing is re-hosted.
//
// Board: KSF runs CS:S 66 tick and 100 tick leaderboards. Our default tickrate (100) reads the 100 tick board, any
// other tickrate the 66 tick one; a map without records on that board falls back to the other.
import { BUILTIN_MAPS } from '../map/builtin/list';
import { getCatalogEntry } from './catalog';
import {
  isValidKsfMapName,
  isValidKsfReplayFile,
  KSF_BOARD_LABEL,
  KSF_PROXY_HEADER,
  KSF_TICK_INTERVAL,
  type KsfBoard,
  ksfRecordsProxyPath,
  ksfReplayProxyPath,
} from './ksfproxy';
import { parseKsfReplay, type ParsedKsfReplay } from './ksfreplay';
import { getRelayBase, relayUrl } from './relay';

export type { KsfBoard } from './ksfproxy';
export { KSF_BOARD_LABEL, KSF_TICK_INTERVAL } from './ksfproxy';

/** What the game says when there is no local server to reach ksf.surf. */
export const KSF_NEEDS_SERVER = 'KSF world records need the local server (npm run dev / npm run preview) or a SURF relay';

/** One leaderboard entry. */
export interface KsfRecord {
  rank: number;
  name: string;
  steamId: string;
  country: string;
  /** Seconds. */
  time: number;
  completions: number;
  /** Unix seconds (0 = unknown). */
  date: number;
  recordId: number;
  /** Replay file on ksf.surf, null when the record has none. */
  file: string | null;
}

export type KsfWr =
  | {
      status: 'ok';
      map: string;
      /** Board the records come from. */
      board: KsfBoard;
      /** Board of the tickrate (differs from `board` after a fallback). */
      preferred: KsfBoard;
      fallback: boolean;
      /** Rank order, WR first. */
      records: KsfRecord[];
      wr: KsfRecord;
    }
  | { status: 'none'; map: string; preferred: KsfBoard }
  | { status: 'unavailable'; map: string; message: string }
  | { status: 'error'; map: string; message: string };

/** The proxy isn't there (static hosting): KSF data can't be fetched in this session. */
export class KsfUnavailableError extends Error {
  constructor(message = KSF_NEEDS_SERVER) {
    super(message);
    this.name = 'KsfUnavailableError';
  }
}

/** Fetches raw KSF data (tests inject fakes). */
export interface KsfClient {
  /** Records of a map's main course on a board ([] when none). Throws KsfUnavailableError without the proxy. */
  fetchRecords(map: string, board: KsfBoard): Promise<KsfRecord[]>;
  /** A replay file. Throws KsfUnavailableError without the proxy. */
  fetchReplay(file: string, board: KsfBoard): Promise<ArrayBuffer>;
}

// ------------------------------------------------------------------------------------------ pure helpers

/** The board a tickrate plays on: 100 tick -> "100t", anything else -> "66t". */
export function boardForTickrate(tickrate: number): KsfBoard {
  return Number.isFinite(tickrate) && Math.abs(tickrate - 100) < 0.5 ? '100t' : '66t';
}

export function otherBoard(b: KsfBoard): KsfBoard {
  return b === '100t' ? '66t' : '100t';
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(CONTROL_CHARS, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
}

/** Validated leaderboard entries from ksf.surf's JSON (anything else: []), in rank order. */
export function parseKsfRecords(json: unknown): KsfRecord[] {
  if (!Array.isArray(json)) return [];
  const out: KsfRecord[] = [];
  for (const it of json.slice(0, 500)) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const time = num(o.time);
    if (!(time > 0 && time < 86400)) continue;
    const rank = num(o.rank);
    const date = num(o.date);
    const completions = num(o.completions);
    const recordId = num(o.record_id);
    out.push({
      rank: rank >= 1 ? Math.floor(rank) : 0,
      name: cleanText(o.name, 32) || '?',
      steamId: cleanText(o.steamID, 32),
      country: cleanText(o.country, 48),
      time,
      completions: completions >= 0 ? Math.floor(completions) : 0,
      date: date > 0 ? Math.floor(date) : 0,
      recordId: recordId > 0 ? Math.floor(recordId) : 0,
      file: isValidKsfReplayFile(o.file) ? (o.file as string) : null,
    });
  }
  out.sort((a, b) => a.time - b.time || (a.rank || 1e9) - (b.rank || 1e9));
  out.forEach((r, i) => {
    if (!r.rank) r.rank = i + 1;
  });
  return out;
}

/**
 * The record whose replay is "the WR replay" of a leaderboard (rank order): the WR, or when the WR has no replay file
 * on ksf.surf the fastest record that has one. Null when no record has a replay.
 */
export function ksfReplayRecord(records: readonly KsfRecord[]): KsfRecord | null {
  return records.find((r) => r.file !== null) ?? null;
}

/**
 * Whether to ask KSF about a map: never for the built-in maps; catalog maps (KSF's own archive) and maps loaded by a
 * surf map name (a dropped surf_x.bsp may be on KSF: an empty answer just means it isn't).
 */
export function isKsfEligibleMap(name: string | null | undefined, builtin = false): boolean {
  if (!name || builtin) return false;
  const n = name.toLowerCase();
  if (BUILTIN_MAPS.some((b) => b.id.toLowerCase() === n || b.name.toLowerCase() === n)) return false;
  if (!isValidKsfMapName(n)) return false;
  return !!getCatalogEntry(n) || n.startsWith('surf_');
}

/** "00:53.364" style (ms, truncated). */
export function formatKsfTime(t: number): string {
  const ms = Number.isFinite(t) && t > 0 ? Math.floor(t * 1000 + 1e-6) : 0;
  const msPart = ms % 1000;
  const totalSec = (ms - msPart) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
  const p3 = (n: number) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}.${p3(msPart)}` : `${p2(m)}:${p2(s)}.${p3(msPart)}`;
}

/** "0:53.364" / "1:31.934" (map browser). */
export function formatKsfTimeShort(t: number): string {
  const s = formatKsfTime(t);
  return s.startsWith('0') && /^\d\d:/.test(s) ? s.slice(1) : s;
}

/** YouTube search of KSF's record videos for a map. */
export function ksfVideosUrl(map: string): string {
  return `https://www.youtube.com/@ksfrecords/search?query=${encodeURIComponent(map.toLowerCase())}`;
}

/** The map's page on ksf.surf. */
export function ksfMapPageUrl(map: string): string {
  return `https://ksf.surf/maps/${encodeURIComponent(map.toLowerCase())}`;
}

// ------------------------------------------------------------------------------------------ HTTP client

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function hasProxy(res: Response): boolean {
  return res.headers.get(KSF_PROXY_HEADER) !== null;
}

/**
 * The real client: the page's own server's /__ksf/ routes (dev / preview), else the relay's (`relay`, default
 * getRelayBase()). Once the relay answered it is used directly for the rest of the session.
 */
export function createHttpKsfClient(fetchFn: FetchFn = (i, init) => fetch(i, init), relay: string | null | undefined = undefined): KsfClient {
  const relayBase = relay === undefined ? getRelayBase() : relay;
  // once the relay answered, the page's own server (a static host) isn't asked again
  let route: 'relay' | null = null;
  const attempt = async (url: string, init: RequestInit): Promise<Response | null> => {
    try {
      const res = await fetchFn(url, init);
      if (hasProxy(res)) return res;
      if (res.body) void res.body.cancel().catch(() => undefined);
      return null;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      // the server didn't answer at all (offline static page / relay down): no proxy there
      return null;
    }
  };
  const open = async (path: string, timeoutMs: number): Promise<Response> => {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      if (route !== 'relay') {
        const res = await attempt(path, { signal: ac?.signal, credentials: 'same-origin' });
        if (res) return res;
      }
      if (relayBase) {
        const res = await attempt(relayUrl(relayBase, path), { signal: ac?.signal, mode: 'cors', credentials: 'omit' });
        if (res) {
          route = 'relay';
          return res;
        }
        // a relay that answered once and fails now is down for a while: retried later, not given up for the session
        if (route === 'relay') throw new Error('the KSF relay is not answering');
        throw new KsfUnavailableError(`KSF world records: the relay (${relayBase}) is not answering`);
      }
      throw new KsfUnavailableError();
    } catch (e) {
      if (e instanceof KsfUnavailableError) throw e;
      if ((e as Error)?.name === 'AbortError') throw new Error('ksf.surf took too long to answer');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    async fetchRecords(map, board) {
      const res = await open(ksfRecordsProxyPath(map, board), 16000);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(res.status === 400 ? 'invalid map name' : `ksf.surf answered HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      const text = await res.text();
      // an unknown map answers with an HTML page (or [])
      if (!/json/i.test(type) && !/^\s*\[/.test(text)) return [];
      try {
        return parseKsfRecords(JSON.parse(text));
      } catch {
        return [];
      }
    },
    async fetchReplay(file, board) {
      const res = await open(ksfReplayProxyPath(file, board), 30000);
      if (res.status === 404) throw new Error('ksf.surf has no such replay');
      if (!res.ok) throw new Error(`ksf.surf answered HTTP ${res.status}`);
      return res.arrayBuffer();
    },
  };
}

// ------------------------------------------------------------------------------------------ the service

const ERROR_RETRY_MS = 30000;
const MAX_REPLAYS = 6;

/** Cached access to KSF records and replays for the session. */
export class KsfService {
  private readonly lists = new Map<string, Promise<KsfRecord[]>>();
  private readonly done = new Map<string, KsfRecord[]>();
  private readonly failedAt = new Map<string, number>();
  private readonly replays = new Map<string, Promise<ParsedKsfReplay>>();
  private unavailable: string | null = null;

  constructor(private readonly client: KsfClient = createHttpKsfClient()) {}

  /** False once the proxy was found missing (static hosting), true once it answered, null before. */
  get available(): boolean | null {
    if (this.unavailable !== null) return false;
    return this.done.size > 0 ? true : null;
  }

  /** Records of a map on a board (cached; a failure is retried after a while). */
  records(map: string, board: KsfBoard): Promise<KsfRecord[]> {
    const m = map.toLowerCase();
    if (this.unavailable !== null) return Promise.reject(new KsfUnavailableError(this.unavailable));
    if (!isValidKsfMapName(m)) return Promise.resolve([]);
    const key = `${m}|${board}`;
    const cached = this.lists.get(key);
    if (cached) return cached;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < ERROR_RETRY_MS) return Promise.reject(new Error('ksf.surf is not answering (retrying shortly)'));
    const p = (async () => {
      const list = await this.client.fetchRecords(m, board);
      this.done.set(key, list);
      this.failedAt.delete(key);
      return list;
    })();
    this.lists.set(key, p);
    p.catch((e: unknown) => {
      if (this.lists.get(key) === p) this.lists.delete(key);
      if (e instanceof KsfUnavailableError) this.unavailable = e.message;
      else this.failedAt.set(key, Date.now());
    });
    return p;
  }

  /** The WR of a map for a tickrate: its board, else the other board (cached). Never throws. */
  async worldRecord(map: string, tickrate: number): Promise<KsfWr> {
    const m = map.toLowerCase();
    const preferred = boardForTickrate(tickrate);
    try {
      for (const board of [preferred, otherBoard(preferred)]) {
        const list = await this.records(m, board);
        if (list.length) return { status: 'ok', map: m, board, preferred, fallback: board !== preferred, records: list, wr: list[0] };
      }
      return { status: 'none', map: m, preferred };
    } catch (e) {
      if (e instanceof KsfUnavailableError) return { status: 'unavailable', map: m, message: e.message };
      return { status: 'error', map: m, message: (e as Error)?.message || String(e) };
    }
  }

  /** The WR from what is already cached (no request), null when not known yet. */
  peekWorldRecord(map: string, tickrate: number): KsfWr | null {
    const m = map.toLowerCase();
    const preferred = boardForTickrate(tickrate);
    const a = this.done.get(`${m}|${preferred}`);
    if (a === undefined) return null;
    if (a.length) return { status: 'ok', map: m, board: preferred, preferred, fallback: false, records: a, wr: a[0] };
    const other = otherBoard(preferred);
    const b = this.done.get(`${m}|${other}`);
    if (b === undefined) return null;
    if (b.length) return { status: 'ok', map: m, board: other, preferred, fallback: true, records: b, wr: b[0] };
    return { status: 'none', map: m, preferred };
  }

  /** Downloads and parses a record's replay (cached per file). */
  replay(record: KsfRecord, board: KsfBoard): Promise<ParsedKsfReplay> {
    if (this.unavailable !== null) return Promise.reject(new KsfUnavailableError(this.unavailable));
    const file = record.file;
    if (!file || !isValidKsfReplayFile(file)) return Promise.reject(new Error(`${record.name}'s record has no replay on ksf.surf`));
    const cached = this.replays.get(file);
    if (cached) {
      // most recently used last
      this.replays.delete(file);
      this.replays.set(file, cached);
      return cached;
    }
    const p = (async () => {
      const buf = await this.client.fetchReplay(file, board);
      return parseKsfReplay(buf, { tickInterval: KSF_TICK_INTERVAL[board], expectedTime: record.time });
    })();
    this.replays.set(file, p);
    p.catch((e: unknown) => {
      if (this.replays.get(file) === p) this.replays.delete(file);
      if (e instanceof KsfUnavailableError) this.unavailable = e.message;
    });
    while (this.replays.size > MAX_REPLAYS) {
      const oldest = this.replays.keys().next().value;
      if (oldest === undefined) break;
      this.replays.delete(oldest);
    }
    return p;
  }

  /** True when the replay of `record` was downloaded (or is downloading). */
  hasReplay(record: KsfRecord): boolean {
    return !!record.file && this.replays.has(record.file);
  }
}

let service: KsfService | null = null;

/** The session's KSF service (the real HTTP client unless one was installed). */
export function getKsfService(): KsfService {
  if (!service) service = new KsfService();
  return service;
}

/** Installs a service (tests: a fake client); null restores the default on next use. */
export function setKsfService(s: KsfService | null): void {
  service = s;
}

/** "66 tick" / "100 tick". */
export function boardLabel(b: KsfBoard): string {
  return KSF_BOARD_LABEL[b];
}
