// SURF relay (the Worker's logic; worker/src/index.ts is the entry point): a Cloudflare Worker (free tier) that serves the dev / preview server's download routes to the static
// build (GitHub Pages), with CORS:
//
//   GET/HEAD /__drive/<fileId>                    -> Google Drive's direct download of a catalog map archive
//   GET/HEAD /__ksf/records/<map>?game=<66t|100t> -> ksf.surf's records of a map's main course (JSON)
//   GET/HEAD /__ksf/replay/<file>?game=<66t|100t> -> ksf.surf's replay file of a record
//
// Never an open proxy: the only upstream URLs ever fetched are built from a validated Drive id / map name / replay
// file name / board by the same helpers the dev server uses (src/maps/drive.ts, src/maps/ksfproxy.ts). Upstream
// status and type are passed on, bodies are streamed, with an answer timeout and a size cap. Answers carry the proxy
// marker header the clients look for (x-surf-drive-proxy / x-surf-ksf-proxy). CORS: only origins in ALLOWED_ORIGINS
// (comma-separated) get an Access-Control-Allow-Origin; a request from any other web origin is refused (403).
// Drive archives and replays never change: they are cached at Cloudflare's edge (and in the browser); record lists
// for a few minutes.
import { DRIVE_MAX_BYTES, DRIVE_PROXY_HEADER, DRIVE_PROXY_PREFIX, DRIVE_TIMEOUT_MS, driveDownloadUrl, parseDriveProxyPath } from '../../src/maps/drive';
import {
  KSF_PROXY_HEADER,
  KSF_PROXY_PREFIX,
  KSF_RECORDS_MAX_BYTES,
  KSF_RECORDS_TIMEOUT_MS,
  KSF_REPLAY_MAX_BYTES,
  KSF_REPLAY_TIMEOUT_MS,
  parseKsfProxyRequest,
} from '../../src/maps/ksfproxy';

export interface Env {
  /** Comma-separated origins allowed to read the relay's answers (wrangler.toml [vars]). */
  ALLOWED_ORIGINS?: string;
}

/** The part of Cloudflare's ExecutionContext the relay uses. */
export interface RelayContext {
  waitUntil(p: Promise<unknown>): void;
}

/** Cloudflare's default cache (absent in tests and on runtimes without the Cache API). */
interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

export const DEFAULT_ALLOWED_ORIGINS = 'https://tomindi.github.io,http://localhost:5173,http://localhost:4173';

/** Edge / browser cache lifetimes (s). */
export const IMMUTABLE_TTL = 7 * 24 * 3600;
export const BROWSER_IMMUTABLE_TTL = 24 * 3600;
export const RECORDS_TTL = 300;

const USER_AGENT = 'SURF relay (browser surf remake; github.com/TomIndi/opensurf)';
const EXPOSED = ['content-length', 'content-type', DRIVE_PROXY_HEADER, KSF_PROXY_HEADER].join(', ');

interface Route {
  kind: 'drive' | 'records' | 'replay';
  marker: string;
  upstream: string;
  /** Canonical cache key path (own host). */
  key: string;
  timeoutMs: number;
  maxBytes: number;
  /** Edge TTL; browsers get min(ttl, BROWSER_IMMUTABLE_TTL). */
  ttl: number;
  accept: string;
  fallbackType: string;
}

type Parsed = Route | { error: string; status: number; marker: string | null };

export function parseOrigins(v: string | undefined): Set<string> {
  return new Set(
    (v ?? DEFAULT_ALLOWED_ORIGINS)
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

function route(url: URL): Parsed {
  const id = parseDriveProxyPath(url.pathname);
  if (id !== null) {
    if (!id) return { error: 'invalid Drive file id', status: 400, marker: DRIVE_PROXY_HEADER };
    return {
      kind: 'drive',
      marker: DRIVE_PROXY_HEADER,
      upstream: driveDownloadUrl(id),
      key: `${DRIVE_PROXY_PREFIX}${id}`,
      timeoutMs: DRIVE_TIMEOUT_MS,
      maxBytes: DRIVE_MAX_BYTES,
      ttl: IMMUTABLE_TTL,
      accept: '*/*',
      fallbackType: 'application/octet-stream',
    };
  }
  if (url.pathname.startsWith(KSF_PROXY_PREFIX)) {
    const r = parseKsfProxyRequest(url.pathname + url.search);
    if (!r) return { error: 'not found', status: 404, marker: null };
    if ('error' in r) return { ...r, marker: KSF_PROXY_HEADER };
    const records = r.kind === 'records';
    return {
      kind: r.kind,
      marker: KSF_PROXY_HEADER,
      upstream: r.upstream,
      key: records ? `${KSF_PROXY_PREFIX}records/${encodeURIComponent(r.map)}?game=${r.board}` : `${KSF_PROXY_PREFIX}replay/${encodeURIComponent(r.file)}?game=${r.board}`,
      timeoutMs: records ? KSF_RECORDS_TIMEOUT_MS : KSF_REPLAY_TIMEOUT_MS,
      maxBytes: records ? KSF_RECORDS_MAX_BYTES : KSF_REPLAY_MAX_BYTES,
      ttl: records ? RECORDS_TTL : IMMUTABLE_TTL,
      accept: records ? 'application/json' : 'application/octet-stream',
      fallbackType: records ? 'application/json' : 'application/octet-stream',
    };
  }
  return { error: 'not found', status: 404, marker: null };
}

function corsHeaders(h: Headers, origin: string | null, allowed: Set<string>): void {
  h.set('Vary', 'Origin');
  if (origin && allowed.has(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Expose-Headers', EXPOSED);
  }
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}

/** A body that errors once more than `max` bytes went through (only used when the length isn't declared). */
function capped(body: ReadableStream<Uint8Array>, max: number, onOver: () => void): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        total += chunk.byteLength;
        if (total > max) {
          onOver();
          ctl.error(new Error('upstream answer too large'));
          return;
        }
        ctl.enqueue(chunk);
      },
    }),
  );
}

function edgeCache(): EdgeCache | null {
  const c = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return c?.default ?? null;
}

/** Whether an upstream answer may be cached: a complete 200 that isn't Drive's HTML quota / interstitial page. */
function cacheable(r: Route, up: Response): boolean {
  if (up.status !== 200) return false;
  const type = up.headers.get('content-type') ?? '';
  return !(r.kind !== 'records' && /text\/html/i.test(type));
}

function browserCacheControl(r: Route): string {
  return r.ttl === IMMUTABLE_TTL ? `public, max-age=${BROWSER_IMMUTABLE_TTL}, immutable` : `public, max-age=${r.ttl}`;
}

async function relay(req: Request, r: Route, ctx: RelayContext | undefined): Promise<Response> {
  const cache = edgeCache();
  const cacheKey = new Request(new URL(r.key, req.url).toString(), { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('x-surf-relay-cache', 'hit');
        h.set('Cache-Control', browserCacheControl(r));
        if (req.method === 'HEAD' && hit.body) void hit.body.cancel().catch(() => undefined);
        return new Response(req.method === 'HEAD' ? null : hit.body, { status: hit.status, headers: h });
      }
    } catch {
      /* no cache: fetch */
    }
  }
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, r.timeoutMs);
  let up: Response;
  try {
    const init: RequestInit & { cf?: Record<string, unknown> } = {
      method: 'GET',
      signal: ac.signal,
      redirect: 'follow',
      headers: { accept: r.accept, 'user-agent': USER_AGENT },
    };
    // Cloudflare's subrequest cache for ksf.surf: replays for a week, record lists for a few minutes, errors never.
    // Not for Drive: its quota / interstitial page is an HTML 200 this cache can't tell apart (Drive archives go to
    // caches.default below, which checks the type).
    if (r.kind !== 'drive') init.cf = { cacheEverything: true, cacheTtlByStatus: { '200-299': r.ttl, '300-599': -1 } };
    up = await fetch(r.upstream, init);
  } catch (e) {
    const name = r.kind === 'drive' ? 'Google Drive' : 'ksf.surf';
    return text(timedOut ? 504 : 502, timedOut ? `${name} took too long to answer` : `${name}: ${String((e as Error)?.message ?? e)}`, {
      [r.marker]: '1',
    });
  } finally {
    clearTimeout(timer);
  }
  // (fetch decodes gzip / br: a Content-Length of an encoded body isn't the length passed on)
  const declared = up.headers.get('content-encoding') ? 0 : Number(up.headers.get('content-length')) || 0;
  if (declared > r.maxBytes) {
    void up.body?.cancel().catch(() => undefined);
    return text(502, `${r.kind === 'drive' ? 'Google Drive' : 'ksf.surf'} answer too large`, { [r.marker]: '1' });
  }
  const h = new Headers();
  h.set('Content-Type', up.headers.get('content-type') ?? r.fallbackType);
  if (declared) h.set('Content-Length', String(declared));
  h.set(r.marker, '1');
  const store = cacheable(r, up);
  h.set('Cache-Control', store ? browserCacheControl(r) : 'no-store');
  if (req.method === 'HEAD' || !up.body) {
    void up.body?.cancel().catch(() => undefined);
    return new Response(null, { status: up.status, headers: h });
  }
  // a declared length is enforced by the runtime; otherwise count
  let body: ReadableStream<Uint8Array> = declared ? up.body : capped(up.body, r.maxBytes, () => ac.abort());
  if (store && cache && ctx) {
    const [client, toCache] = body.tee();
    body = client;
    const ch = new Headers(h);
    ch.set('Cache-Control', `public, max-age=${r.ttl}`);
    ctx.waitUntil(cache.put(cacheKey, new Response(toCache, { status: 200, headers: ch })).catch(() => undefined));
  }
  return new Response(body, { status: up.status, headers: h });
}

/** The Worker's request handler (exported for tests). */
export async function handleRequest(req: Request, env: Env = {}, ctx?: RelayContext): Promise<Response> {
  const url = new URL(req.url);
  const allowed = parseOrigins(env.ALLOWED_ORIGINS);
  const origin = req.headers.get('Origin');
  const finish = (res: Response): Response => {
    const h = new Headers(res.headers);
    corsHeaders(h, origin, allowed);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  };
  if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    return finish(text(200, req.method === 'HEAD' ? '' : 'SURF relay: /__drive/<id>, /__ksf/records/<map>?game=<66t|100t>, /__ksf/replay/<file>?game=<66t|100t>\n'));
  }
  const r = route(url);
  if ('error' in r) return finish(text(r.status, r.error, r.marker ? { [r.marker]: '1' } : {}));
  // A page on another site may not use the relay (its answers would be unreadable anyway: don't spend the transfer)
  if (origin !== null && !allowed.has(origin)) return finish(text(403, 'origin not allowed', { [r.marker]: '1' }));
  if (req.method === 'OPTIONS') {
    const h = new Headers({ [r.marker]: '1', 'Cache-Control': 'no-store' });
    if (origin) {
      h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      const asked = req.headers.get('Access-Control-Request-Headers');
      // only headers a fetch of these routes might add
      const ok = (asked ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s === 'range' || s === 'accept' || s === 'cache-control');
      if (ok.length) h.set('Access-Control-Allow-Headers', ok.join(', '));
      h.set('Access-Control-Max-Age', '86400');
    }
    return finish(new Response(null, { status: 204, headers: h }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return finish(text(405, 'GET only', { Allow: 'GET, HEAD, OPTIONS', [r.marker]: '1' }));
  return finish(await relay(req, r, ctx));
}
