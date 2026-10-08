// KSF (ksf.surf) world records through the local dev / preview server. ksf.surf's API sends no CORS headers, so a
// web page can't read it; vite.config.ts serves two strictly validated routes that fetch it from Node:
//
//   /__ksf/records/<map>?game=<board>   -> https://ksf.surf/api/maps/<map>/records/zone/0/0?game=<api game>&mode=0
//   /__ksf/replay/<file>?game=<board>   -> https://ksf.surf/api/replays/<file>?game=<api game>
//
// <board> is "66t" or "100t" (KSF's CS:S 66 tick and 100 tick servers). ksf.surf's own `game` values for them are
// "css" and "css100t" (an unknown value silently answers with the 66 tick board). Only URLs built here from the
// validated parts are ever fetched: never anything taken from the request as-is. No DOM and no Node imports: the
// validators are shared by the browser client (src/maps/ksf.ts) and the server, and the server's request handler
// (createKsfProxyHandler, mounted by vite.config.ts) takes Node's request / response structurally and an injectable
// fetch (unit tests).

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

// ------------------------------------------------------------------------------------------ the server handler

/** The parts of Node's IncomingMessage the handler reads. */
export interface KsfProxyIncoming {
  url?: string;
  method?: string;
}

/** The parts of Node's ServerResponse the handler uses. */
export interface KsfProxyOutgoing {
  statusCode: number;
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  readonly writableFinished: boolean;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array): boolean;
  end(data?: string): unknown;
  destroy(): unknown;
  on(event: 'close' | 'drain', cb: () => void): unknown;
  off(event: 'close' | 'drain', cb: () => void): unknown;
}

export interface KsfProxyOptions {
  /** Upstream fetch (default: the global fetch). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  recordsTimeoutMs?: number;
  replayTimeoutMs?: number;
  recordsMaxBytes?: number;
  replayMaxBytes?: number;
}

/**
 * The dev / preview server's /__ksf/ middleware: anything else goes to `next`. Every answer carries the proxy header
 * (KSF_PROXY_HEADER, how the client tells the proxy from a static host) and no-store. Invalid requests: 400 / 404;
 * not GET / HEAD: 405. The upstream status, type and body are passed on (a 404 stays a 404), with a timeout over the
 * whole transfer (502 before the answer started, else the connection is cut), a size cap (a declared length over it:
 * 502; a body growing past it: cut) and the upstream request aborted when the client goes away.
 */
export function createKsfProxyHandler(
  opts: KsfProxyOptions = {},
): (req: KsfProxyIncoming, res: KsfProxyOutgoing, next: () => void) => Promise<void> {
  const fetchFn = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return async (req, res, next) => {
    const route = parseKsfProxyRequest(req.url ?? '');
    if (!route) {
      next();
      return;
    }
    res.setHeader(KSF_PROXY_HEADER, '1');
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status: number, msg: string) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(msg);
    };
    if ('error' in route) return fail(route.status, route.error);
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return fail(405, 'GET only');
    }
    const records = route.kind === 'records';
    const maxBytes = records ? opts.recordsMaxBytes ?? KSF_RECORDS_MAX_BYTES : opts.replayMaxBytes ?? KSF_REPLAY_MAX_BYTES;
    const timeoutMs = records ? opts.recordsTimeoutMs ?? KSF_RECORDS_TIMEOUT_MS : opts.replayTimeoutMs ?? KSF_REPLAY_TIMEOUT_MS;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClose);
    try {
      const up = await fetchFn(route.upstream, {
        signal: ac.signal,
        headers: { accept: records ? 'application/json' : 'application/octet-stream', 'user-agent': 'SURF (browser surf remake; local dev server)' },
      });
      // (fetch decodes gzip/br: a Content-Length of an encoded body isn't the length passed on)
      const len = up.headers.get('content-encoding') ? 0 : Number(up.headers.get('content-length')) || 0;
      if (len > maxBytes) {
        ac.abort();
        return fail(502, 'ksf.surf answer too large');
      }
      res.statusCode = up.status;
      res.setHeader('Content-Type', up.headers.get('content-type') ?? (records ? 'application/json' : 'application/octet-stream'));
      if (len) res.setHeader('Content-Length', String(len));
      if (!up.body || req.method === 'HEAD') {
        if (up.body) void up.body.cancel().catch(() => undefined);
        res.end();
        return;
      }
      let total = 0;
      for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          ac.abort();
          res.destroy();
          return;
        }
        if (!res.write(chunk)) {
          await new Promise<void>((r) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              r();
            };
            res.on('drain', done);
            res.on('close', done);
          });
          if (res.destroyed) return;
        }
      }
      res.end();
    } catch (e) {
      if (res.destroyed) return;
      fail(502, timedOut ? 'ksf.surf took too long to answer' : `ksf.surf: ${String((e as Error)?.message ?? e)}`);
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
    }
  };
}
