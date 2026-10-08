// KSF (ksf.surf) world records through the local dev / preview server. ksf.surf's API sends no CORS headers, so a
// web page can't read it; vite.config.ts serves two strictly validated routes that fetch it from Node:
//
//   /__ksf/records/<map>?game=<board>   -> https://ksf.surf/api/maps/<map>/records/zone/0/0?game=<api game>&mode=0
//   /__ksf/replay/<file>?game=<board>   -> https://ksf.surf/api/replays/<file>?game=<api game>
//
// <board> is "66t" or "100t" (KSF's CS:S 66 tick and 100 tick servers). ksf.surf's own `game` values for them are
// "css" and "css100t" (an unknown value silently answers with the 66 tick board). Only URLs built here from the
// validated parts are ever fetched: never anything taken from the request as-is. Pure functions (no DOM, no Node),
// shared by the Vite config and the browser client (src/maps/ksf.ts).

/** KSF leaderboard: CS:S 66 tick or 100 tick. */
export type KsfBoard = '66t' | '100t';

export const KSF_ORIGIN = 'https://ksf.surf';
/** Response header of the local proxy (a static host answering the same path doesn't send it). */
export const KSF_PROXY_HEADER = 'x-surf-ksf-proxy';
/** Path prefix of the proxy routes. */
export const KSF_PROXY_PREFIX = '/__ksf/';

/** ksf.surf's `game` query value of each board. */
export const KSF_API_GAME: Readonly<Record<KsfBoard, string>> = Object.freeze({ '66t': 'css', '100t': 'css100t' });
/** Seconds per tick of each board. */
export const KSF_TICK_INTERVAL: Readonly<Record<KsfBoard, number>> = Object.freeze({ '66t': 0.015, '100t': 0.01 });
/** UI label of each board. */
export const KSF_BOARD_LABEL: Readonly<Record<KsfBoard, string>> = Object.freeze({ '66t': '66 tick', '100t': '100 tick' });

/** Map names: letters, digits, "_", "." and "-", 1-64 characters, starting with a letter or digit (no "..", no "/"). */
export const KSF_MAP_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
/** Replay file names as ksf.surf lists them: "replay_css_1145_0_812716_1784127388.rec". */
export const KSF_REPLAY_FILE_RE = /^replay_[a-z0-9_]{1,120}\.rec$/i;

/** Upstream timeouts (ms). */
export const KSF_RECORDS_TIMEOUT_MS = 10000;
export const KSF_REPLAY_TIMEOUT_MS = 15000;
/** Largest upstream answers the proxy passes on (a records list is ~10 KB, a 30 min 100 tick replay ~7 MB). */
export const KSF_RECORDS_MAX_BYTES = 2 * 1024 * 1024;
export const KSF_REPLAY_MAX_BYTES = 48 * 1024 * 1024;

export function isKsfBoard(v: unknown): v is KsfBoard {
  return v === '66t' || v === '100t';
}

export function isValidKsfMapName(name: unknown): name is string {
  return typeof name === 'string' && KSF_MAP_RE.test(name) && !name.includes('..');
}

export function isValidKsfReplayFile(file: unknown): file is string {
  return typeof file === 'string' && KSF_REPLAY_FILE_RE.test(file);
}

/** ksf.surf's records of a map's main course (zone 0/0, normal style) on a board. */
export function ksfRecordsUpstreamUrl(map: string, board: KsfBoard): string {
  if (!isValidKsfMapName(map) || !isKsfBoard(board)) throw new Error('invalid KSF records request');
  return `${KSF_ORIGIN}/api/maps/${encodeURIComponent(map.toLowerCase())}/records/zone/0/0?game=${KSF_API_GAME[board]}&mode=0`;
}

/** ksf.surf's download of a replay file. */
export function ksfReplayUpstreamUrl(file: string, board: KsfBoard): string {
  if (!isValidKsfReplayFile(file) || !isKsfBoard(board)) throw new Error('invalid KSF replay request');
  return `${KSF_ORIGIN}/api/replays/${encodeURIComponent(file)}?game=${KSF_API_GAME[board]}`;
}

/** Relative URL of the proxy's records route (works under any Vite base path). */
export function ksfRecordsProxyPath(map: string, board: KsfBoard): string {
  return `./__ksf/records/${encodeURIComponent(map.toLowerCase())}?game=${board}`;
}

/** Relative URL of the proxy's replay route. */
export function ksfReplayProxyPath(file: string, board: KsfBoard): string {
  return `./__ksf/replay/${encodeURIComponent(file)}?game=${board}`;
}

export type KsfProxyRoute =
  | { kind: 'records'; map: string; board: KsfBoard; upstream: string }
  | { kind: 'replay'; file: string; board: KsfBoard; upstream: string };

export interface KsfProxyError {
  error: string;
  status: number;
}

/**
 * The proxy route a request URL asks for: null when it isn't a /__ksf/ request (the server passes it on), an error
 * (HTTP 400) when it is one with an invalid map / file / board, else the route with the only upstream URL it may
 * fetch.
 */
export function parseKsfProxyRequest(url: string): KsfProxyRoute | KsfProxyError | null {
  // (only in the path: a query string mentioning /__ksf/ is not a proxy request)
  const pathEnd = url.search(/[?#]/);
  const at = url.indexOf(KSF_PROXY_PREFIX);
  if (at < 0 || (pathEnd >= 0 && at > pathEnd)) return null;
  const rest = url.slice(at + KSF_PROXY_PREFIX.length);
  const q = rest.search(/[?#]/);
  const path = q < 0 ? rest : rest.slice(0, q);
  const query = q >= 0 && rest[q] === '?' ? rest.slice(q + 1).split('#')[0] : '';
  const parts = path.split('/');
  if (parts.length !== 2 || (parts[0] !== 'records' && parts[0] !== 'replay')) return { error: 'unknown KSF route', status: 404 };
  let name: string;
  try {
    name = decodeURIComponent(parts[1]);
  } catch {
    return { error: 'bad name', status: 400 };
  }
  let board: string | null = null;
  try {
    board = new URLSearchParams(query).get('game');
  } catch {
    board = null;
  }
  if (!isKsfBoard(board)) return { error: 'game must be 66t or 100t', status: 400 };
  if (parts[0] === 'records') {
    if (!isValidKsfMapName(name)) return { error: 'invalid map name', status: 400 };
    return { kind: 'records', map: name.toLowerCase(), board, upstream: ksfRecordsUpstreamUrl(name, board) };
  }
  if (!isValidKsfReplayFile(name)) return { error: 'invalid replay file name', status: 400 };
  return { kind: 'replay', file: name, board, upstream: ksfReplayUpstreamUrl(name, board) };
}
