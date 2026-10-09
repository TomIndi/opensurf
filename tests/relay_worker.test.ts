// The SURF relay Cloudflare Worker (worker/src/index.ts, relay.ts) with a mocked upstream fetch (no network): routing and
// validation, the exact upstream URLs, CORS allow / deny and preflight, the proxy marker headers, status pass-through,
// HEAD, the size caps, the answer timeout and the edge cache.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/src/index';
import { DEFAULT_ALLOWED_ORIGINS, handleRequest, parseOrigins } from '../worker/src/relay';

const BASE = 'https://opensurf-relay.example.workers.dev';
const PAGES = 'https://tomindi.github.io';
const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUv_-xyz';

interface Call {
  url: string;
  init: RequestInit & { cf?: Record<string, unknown> };
}

let calls: Call[] = [];

function mockUpstream(answer: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  calls = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: u, init: init as Call['init'] });
    return answer(u, init);
  });
}

function get(path: string, init: { origin?: string | null; method?: string; headers?: Record<string, string> } = {}, env = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const origin = init.origin === undefined ? PAGES : init.origin;
  if (origin !== null) headers.Origin = origin;
  return handleRequest(new Request(BASE + path, { method: init.method ?? 'GET', headers }), env);
}

function bytes(n: number, fill = 7): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n).fill(fill);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('relay worker: routing and upstream URLs', () => {
  it('relays /__drive/<id> to Drive\'s direct download, streaming the body with the marker and CORS', async () => {
    mockUpstream(() => new Response(bytes(1000), { status: 200, headers: { 'content-type': 'application/x-rar', 'content-length': '1000' } }));
    const res = await get(`/__drive/${DRIVE_ID}`);
    expect(calls.map((c) => c.url)).toEqual([`https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download&confirm=t`]);
    expect(calls[0].init.method).toBe('GET');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-surf-drive-proxy')).toBe('1');
    expect(res.headers.get('content-type')).toBe('application/x-rar');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES);
    expect(res.headers.get('access-control-expose-headers')).toMatch(/content-length/);
    expect(res.headers.get('access-control-expose-headers')).toMatch(/x-surf-drive-proxy/);
    expect(res.headers.get('access-control-expose-headers')).toMatch(/x-surf-ksf-proxy/);
    expect(res.headers.get('vary')).toMatch(/Origin/);
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    // (no subrequest cache for Drive: it can't tell Drive's HTML quota page from the archive)
    expect(calls[0].init.cf).toBeUndefined();
  });

  it('relays KSF records and replays with the board translated (66t -> css, 100t -> css100t)', async () => {
    mockUpstream((u) =>
      u.includes('/records/')
        ? new Response('[{"rank":1}]', { headers: { 'content-type': 'application/json' } })
        : new Response(bytes(10), { headers: { 'content-type': 'application/octet-stream', 'content-length': '10' } }),
    );
    let res = await get('/__ksf/records/surf_Utopia_NJV?game=66t');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-surf-ksf-proxy')).toBe('1');
    expect(res.headers.get('x-surf-drive-proxy')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await res.text()).toBe('[{"rank":1}]');
    res = await get('/__ksf/records/surf_utopia_njv?game=100t');
    await res.arrayBuffer();
    res = await get('/__ksf/replay/replay_css_1145_0_812716_1784127388.rec?game=100t');
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES);
    expect((await res.arrayBuffer()).byteLength).toBe(10);
    res = await get('/__ksf/replay/replay_css_1145_0_812716_1784127388.rec?game=66t');
    await res.arrayBuffer();
    expect(calls.map((c) => c.url)).toEqual([
      'https://ksf.surf/api/maps/surf_utopia_njv/records/zone/0/0?game=css&mode=0',
      'https://ksf.surf/api/maps/surf_utopia_njv/records/zone/0/0?game=css100t&mode=0',
      'https://ksf.surf/api/replays/replay_css_1145_0_812716_1784127388.rec?game=css100t',
      'https://ksf.surf/api/replays/replay_css_1145_0_812716_1784127388.rec?game=css',
    ]);
    expect((calls[0].init.headers as Record<string, string>).accept).toBe('application/json');
    // ksf.surf answers: Cloudflare's subrequest cache, 5 min for record lists, a week for replays, errors never
    expect(calls[0].init.cf).toEqual({ cacheEverything: true, cacheTtlByStatus: { '200-299': 300, '300-599': -1 } });
    expect(calls[2].init.cf).toEqual({ cacheEverything: true, cacheTtlByStatus: { '200-299': 7 * 24 * 3600, '300-599': -1 } });
  });

  it('rejects anything but the exact route shapes, without fetching', async () => {
    mockUpstream(() => new Response('should not be fetched'));
    const cases: [string, number][] = [
      ['/__drive/short', 400],
      ['/__drive/has.dot.in.the.id', 400],
      ['/__drive/' + 'a'.repeat(129), 400],
      [`/__drive/${DRIVE_ID}/extra`, 400],
      ['/__drive/https%3A%2F%2Fevil.example%2Fx', 400],
      ['/__ksf/records/surf_a', 400],
      ['/__ksf/records/surf_a?game=css', 400],
      ['/__ksf/records/..%2Fsecret?game=66t', 400],
      ['/__ksf/records/%2e%2e?game=66t', 404], // (the URL parser resolves the dot segment: /__ksf/)
      ['/__ksf/replay/notareplay.txt?game=66t', 400],
      ['/__ksf/replay/replay_x.rec/more?game=66t', 404],
      ['/__ksf/other/surf_a?game=66t', 404],
      ['/__ksf/', 404],
      ['/https://evil.example/', 404],
      ['/proxy?url=https://ksf.surf/api/maps', 404],
      ['/favicon.ico', 404],
    ];
    for (const [path, status] of cases) {
      const res = await get(path);
      expect(res.status, path).toBe(status);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
    expect(calls).toEqual([]);
    // the routes' rejections still carry their marker (the client knows it reached the relay)
    expect((await get('/__drive/short')).headers.get('x-surf-drive-proxy')).toBe('1');
    expect((await get('/__ksf/records/surf_a')).headers.get('x-surf-ksf-proxy')).toBe('1');
    expect((await get('/favicon.ico')).headers.get('x-surf-ksf-proxy')).toBeNull();
    // health check
    const root = await get('/');
    expect(root.status).toBe(200);
    expect(await root.text()).toMatch(/SURF relay/);
  });

  it('only allows GET, HEAD and OPTIONS', async () => {
    mockUpstream(() => new Response('x'));
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await get(`/__drive/${DRIVE_ID}`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    }
    expect(calls).toEqual([]);
  });
});

describe('relay worker: CORS', () => {
  it('reflects allowed origins only, and refuses other web origins without fetching', async () => {
    mockUpstream(() => new Response('[]', { headers: { 'content-type': 'application/json' } }));
    for (const origin of ['http://localhost:5173', 'http://localhost:4173', PAGES]) {
      const res = await get('/__ksf/records/surf_a?game=66t', { origin });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
    for (const origin of ['https://evil.example', 'https://tomindi.github.io.evil.example', 'null', 'http://localhost:9999']) {
      const res = await get('/__ksf/records/surf_a?game=66t', { origin });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
    expect(calls.length).toBe(3);
    // no Origin (curl, a navigation): served, without CORS headers
    const plain = await get('/__ksf/records/surf_a?game=66t', { origin: null });
    expect(plain.status).toBe(200);
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('takes the allow-list from ALLOWED_ORIGINS', async () => {
    mockUpstream(() => new Response('[]'));
    const env = { ALLOWED_ORIGINS: ' https://fork.github.io/ , http://localhost:5173' };
    expect((await get('/__ksf/records/surf_a?game=66t', { origin: 'https://fork.github.io' }, env)).headers.get('access-control-allow-origin')).toBe(
      'https://fork.github.io',
    );
    expect((await get('/__ksf/records/surf_a?game=66t', { origin: PAGES }, env)).status).toBe(403);
    expect([...parseOrigins(undefined)]).toEqual(DEFAULT_ALLOWED_ORIGINS.split(','));
  });

  it('answers preflights', async () => {
    mockUpstream(() => new Response('x'));
    const res = await get(`/__drive/${DRIVE_ID}`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range, x-evil' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('range');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
    expect((await get(`/__drive/${DRIVE_ID}`, { method: 'OPTIONS', origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/__ksf/records/bad..name?game=66t', { method: 'OPTIONS' })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('relay worker: upstream answers', () => {
  it('passes the upstream status, type and body on (404 stays 404, errors are not cached)', async () => {
    mockUpstream(() => new Response('<html>nope</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    let res = await get('/__ksf/records/surf_nothing?game=66t');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('x-surf-ksf-proxy')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('<html>nope</html>');
    mockUpstream(() => new Response('quota', { status: 403, headers: { 'content-type': 'text/html' } }));
    res = await get(`/__drive/${DRIVE_ID}`);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-surf-drive-proxy')).toBe('1');
    // Drive's 200 HTML quota page: passed on, never cached
    mockUpstream(() => new Response('<html>quota exceeded</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    res = await get(`/__drive/${DRIVE_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 502 with the marker when the upstream is unreachable, 504 when it is too slow', async () => {
    mockUpstream(() => {
      throw new TypeError('fetch failed');
    });
    let res = await get('/__ksf/records/surf_a?game=66t');
    expect(res.status).toBe(502);
    expect(res.headers.get('x-surf-ksf-proxy')).toBe('1');
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES);
    expect(await res.text()).toMatch(/fetch failed/);

    vi.useFakeTimers();
    mockUpstream(
      (_u, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const p = get('/__ksf/records/surf_a?game=66t');
    await vi.advanceTimersByTimeAsync(10001);
    res = await p;
    expect(res.status).toBe(504);
    expect(await res.text()).toMatch(/too long/);
  });

  it('HEAD: the upstream headers without a body', async () => {
    let cancelled = false;
    mockUpstream(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(bytes(100));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/x-rar', 'content-length': '5000' } },
        ),
    );
    const res = await get(`/__drive/${DRIVE_ID}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('5000');
    expect(res.headers.get('x-surf-drive-proxy')).toBe('1');
    expect(res.body).toBeNull();
    expect(calls[0].init.method).toBe('GET');
    expect(cancelled).toBe(true);
  });

  it('caps the size: a declared length over the cap is refused, an undeclared body is cut', async () => {
    mockUpstream(() => new Response('small', { headers: { 'content-length': String(400 * 1024 * 1024) } }));
    let res = await get(`/__drive/${DRIVE_ID}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/too large/);
    mockUpstream(() => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) } }));
    expect((await get('/__ksf/records/surf_a?game=66t')).status).toBe(502);
    // 3 MB of records without a Content-Length: the stream errors past the 2 MB cap
    mockUpstream(() => {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent >= 3 * 1024 * 1024) return c.close();
            sent += 64 * 1024;
            c.enqueue(bytes(64 * 1024));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    res = await get('/__ksf/records/surf_a?game=66t');
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
    // under the cap: complete
    mockUpstream(() => new Response(new Blob([bytes(1500 * 1024)]).stream(), { headers: { 'content-type': 'application/json' } }));
    res = await get('/__ksf/records/surf_a?game=66t');
    expect((await res.arrayBuffer()).byteLength).toBe(1500 * 1024);
  });
});

describe('relay worker: edge cache', () => {
  it('stores immutable answers in caches.default and serves hits without fetching', async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {
      default: {
        async match(req: Request) {
          return store.get(req.url)?.clone();
        },
        async put(req: Request, res: Response) {
          store.set(req.url, new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers }));
        },
      },
    });
    mockUpstream(() => new Response(bytes(64), { headers: { 'content-type': 'application/octet-stream', 'content-length': '64' } }));
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    const req = () => new Request(`${BASE}/__ksf/replay/replay_css_1_0_2_3.rec?game=100t`, { headers: { Origin: PAGES } });
    let res = await worker.fetch(req(), {}, ctx);
    expect((await res.arrayBuffer()).byteLength).toBe(64);
    await Promise.all(pending);
    expect([...store.keys()]).toEqual([`${BASE}/__ksf/replay/replay_css_1_0_2_3.rec?game=100t`]);
    res = await worker.fetch(req(), {}, ctx);
    expect(res.headers.get('x-surf-relay-cache')).toBe('hit');
    expect(res.headers.get('x-surf-ksf-proxy')).toBe('1');
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES);
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
    expect((await res.arrayBuffer()).byteLength).toBe(64);
    expect(calls.length).toBe(1);
    // errors aren't stored
    mockUpstream(() => new Response('gone', { status: 404 }));
    res = await worker.fetch(new Request(`${BASE}/__ksf/replay/replay_css_9.rec?game=66t`), {}, ctx);
    expect(res.status).toBe(404);
    await Promise.all(pending);
    expect(store.size).toBe(1);
  });
});
