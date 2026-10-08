// The dev / preview server's KSF proxy middleware (src/maps/ksfproxy.ts createKsfProxyHandler, mounted by
// vite.config.ts) on a real local http server, with an injected upstream fetch (no network): routing and validation,
// the proxy header, GET / HEAD only, pass-through of status / type / body, the size caps, the timeout and the upstream
// request aborted when the client goes away.
import { createServer, type IncomingHttpHeaders, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createKsfProxyHandler, KSF_PROXY_HEADER, type KsfProxyOptions } from '../src/maps/ksfproxy';

interface Upstream {
  calls: { url: string; init: RequestInit }[];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** An upstream that answers every request with `answer(url, signal)`. */
function upstream(answer: (url: string, signal: AbortSignal) => Promise<Response> | Response): Upstream {
  const calls: Upstream['calls'] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer(url, init.signal as AbortSignal);
    },
  };
}

/** Never answers; rejects like fetch when the signal aborts. */
function hang(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail);
  });
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** False when the server cut the connection before the end of the body. */
  complete: boolean;
  error?: string;
}

let server: Server | null = null;
let nextCalls = 0;

async function startProxy(up: Upstream, opts: KsfProxyOptions = {}): Promise<number> {
  const handler = createKsfProxyHandler({ ...opts, fetch: up.fetch });
  nextCalls = 0;
  server = createServer((req, res) => {
    void handler(req, res, () => {
      nextCalls++;
      res.statusCode = 299;
      res.end('next');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

function ask(port: number, path: string, method = 'GET', abortAfterMs?: number): Promise<Reply> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      let error: string | undefined;
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', (e) => (error = e.message));
      res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete, error }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), complete: false, error: e.message }));
    req.end();
    if (abortAfterMs !== undefined) setTimeout(() => req.destroy(), abortAfterMs);
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(async () => {
  const s = server;
  server = null;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const RECORDS = '/__ksf/records/surf_utopia_njv?game=100t';
const RECORDS_UP = 'https://ksf.surf/api/maps/surf_utopia_njv/records/zone/0/0?game=css100t&mode=0';
const FILE = 'replay_css_1145_0_812716_1784127388.rec';

describe('KSF proxy handler', () => {
  it('passes everything but /__ksf/ on, without asking upstream', async () => {
    const up = upstream(() => new Response('[]'));
    const port = await startProxy(up);
    for (const p of ['/', '/index.html', '/assets/x.js?u=/__ksf/records/surf_a', '/__drive/abcdefghijkl']) {
      const r = await ask(port, p);
      expect(r.status).toBe(299);
      expect(r.headers[KSF_PROXY_HEADER]).toBeUndefined();
    }
    expect(nextCalls).toBe(4);
    expect(up.calls).toEqual([]);
  });

  it('refuses invalid routes (400 / 404) and other methods (405), with the proxy header, never asking upstream', async () => {
    const up = upstream(() => new Response('[]'));
    const port = await startProxy(up);
    const cases: [string, string, number][] = [
      ['GET', '/__ksf/records/..%2F..%2Fetc?game=100t', 400],
      ['GET', '/__ksf/records/surf_utopia_njv?game=128t', 400],
      ['GET', '/__ksf/records/surf_utopia_njv', 400],
      ['GET', '/__ksf/replay/evil.rec?game=66t', 400],
      ['GET', '/__ksf/replay/https%3A%2F%2Fevil.example%2Fx?game=66t', 400],
      ['GET', '/__ksf/maps/surf_utopia_njv?game=66t', 404],
      ['GET', '/__ksf/records/a/b?game=66t', 404],
      ['POST', RECORDS, 405],
      ['DELETE', `/__ksf/replay/${FILE}?game=66t`, 405],
    ];
    for (const [method, path, status] of cases) {
      const r = await ask(port, path, method);
      expect([path, r.status]).toEqual([path, status]);
      expect(r.headers[KSF_PROXY_HEADER]).toBe('1');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['content-type']).toMatch(/^text\/plain/);
      if (status === 405) expect(r.headers.allow).toBe('GET, HEAD');
    }
    expect(up.calls).toEqual([]);
  });

  it('records: fetches only the URL built from the validated request and passes the answer on', async () => {
    const json = JSON.stringify([{ rank: 1, name: 'x', time: 53.364 }]);
    const up = upstream(() => new Response(json, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
    const port = await startProxy(up);
    const r = await ask(port, RECORDS);
    expect(r.status).toBe(200);
    expect(r.headers[KSF_PROXY_HEADER]).toBe('1');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.body.toString()).toBe(json);
    expect(up.calls.map((c) => c.url)).toEqual([RECORDS_UP]);
    const init = up.calls[0].init;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
    // the map is lower-cased, extra query parameters are ignored, a base path is fine
    await ask(port, '/surf/__ksf/records/SURF_Utopia_NJV?game=100t&x=https://evil.example');
    expect(up.calls[1].url).toBe(RECORDS_UP);
  });

  it('replays: a binary body is passed through byte for byte (several chunks), with its length', async () => {
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 255;
    const up = upstream(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let o = 0; o < bytes.length; o += 65536) c.enqueue(bytes.slice(o, o + 65536));
              c.close();
            },
          }),
          { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } },
        ),
    );
    const port = await startProxy(up);
    const r = await ask(port, `/__ksf/replay/${FILE}?game=66t`);
    expect(up.calls.map((c) => c.url)).toEqual([`https://ksf.surf/api/replays/${FILE}?game=css`]);
    expect(r.status).toBe(200);
    expect(r.complete).toBe(true);
    expect(r.headers['content-length']).toBe(String(bytes.length));
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.compare(r.body, Buffer.from(bytes))).toBe(0);
  });

  it('passes the upstream status on (an unknown map answers 404 with an HTML page)', async () => {
    const up = upstream(() => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    const port = await startProxy(up);
    const r = await ask(port, '/__ksf/records/surf_nothing_here?game=66t');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toBe('text/html');
    expect(r.headers[KSF_PROXY_HEADER]).toBe('1');
    expect(r.body.toString()).toBe('<html>404</html>');
  });

  it('HEAD: the headers without a body', async () => {
    const up = upstream(() => new Response('[1,2,3]', { headers: { 'content-type': 'application/json', 'content-length': '7' } }));
    const port = await startProxy(up);
    const r = await ask(port, RECORDS, 'HEAD');
    expect(r.status).toBe(200);
    expect(r.headers[KSF_PROXY_HEADER]).toBe('1');
    expect(r.headers['content-length']).toBe('7');
    expect(r.body.length).toBe(0);
  });

  it('size caps: a declared length over the cap is refused (502), a body growing past it is cut', async () => {
    let signal: AbortSignal | null = null;
    const declared = upstream((_u, s) => {
      signal = s;
      return new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '1001' } });
    });
    let port = await startProxy(declared, { recordsMaxBytes: 1000 });
    let r = await ask(port, RECORDS);
    expect(r.status).toBe(502);
    expect(r.body.toString()).toBe('ksf.surf answer too large');
    expect(r.headers[KSF_PROXY_HEADER]).toBe('1');
    expect(signal!.aborted).toBe(true);
    server!.closeAllConnections();
    server!.close();

    // no length: streamed until it passes the cap, then the connection is cut (the client never gets a full body)
    let pulled = 0;
    const streaming = upstream(
      (_u, s) => {
        signal = s;
        return new Response(
          new ReadableStream({
            pull(c) {
              pulled++;
              c.enqueue(new Uint8Array(400));
            },
          }),
          { headers: { 'content-type': 'application/octet-stream' } },
        );
      },
    );
    port = await startProxy(streaming, { replayMaxBytes: 1000 });
    r = await ask(port, `/__ksf/replay/${FILE}?game=100t`);
    // (cut before or after the headers got out: either way no complete answer)
    expect(r.complete).toBe(false);
    expect(r.body.length).toBeLessThanOrEqual(1000);
    expect(signal!.aborted).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it('timeout: 502 when ksf.surf does not answer in time; a stalled body is cut', async () => {
    let signal: AbortSignal | null = null;
    const slow = upstream((_u, s) => {
      signal = s;
      return hang(s);
    });
    let port = await startProxy(slow, { recordsTimeoutMs: 60 });
    const t0 = Date.now();
    let r = await ask(port, RECORDS);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.status).toBe(502);
    expect(r.body.toString()).toBe('ksf.surf took too long to answer');
    expect(r.headers[KSF_PROXY_HEADER]).toBe('1');
    expect(signal!.aborted).toBe(true);
    server!.closeAllConnections();
    server!.close();

    // the answer started, then nothing more: the timeout covers the whole transfer
    const stalled = upstream((_u, s) => {
      signal = s;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(100));
            s.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          },
        }),
        { headers: { 'content-type': 'application/octet-stream' } },
      );
    });
    port = await startProxy(stalled, { replayTimeoutMs: 80 });
    r = await ask(port, `/__ksf/replay/${FILE}?game=66t`);
    expect(r.complete).toBe(false);
    expect(signal!.aborted).toBe(true);
  });

  it('an upstream error is a 502 with its message', async () => {
    const up = upstream(() => Promise.reject(new TypeError('fetch failed')));
    const port = await startProxy(up);
    const r = await ask(port, RECORDS);
    expect(r.status).toBe(502);
    expect(r.body.toString()).toBe('ksf.surf: fetch failed');
    expect(r.headers[KSF_PROXY_HEADER]).toBe('1');
  });

  it('a client that goes away aborts the upstream request', async () => {
    let signal: AbortSignal | null = null;
    const up = upstream((_u, s) => {
      signal = s;
      return hang(s);
    });
    const port = await startProxy(up, { recordsTimeoutMs: 60_000 });
    const r = await ask(port, RECORDS, 'GET', 40);
    expect(r.status).toBe(0);
    await until(() => signal !== null && signal.aborted);
  });
});
