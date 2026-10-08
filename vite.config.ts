import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { defineConfig, type Plugin } from 'vite';
import {
  KSF_PROXY_HEADER,
  KSF_RECORDS_MAX_BYTES,
  KSF_RECORDS_TIMEOUT_MS,
  KSF_REPLAY_MAX_BYTES,
  KSF_REPLAY_TIMEOUT_MS,
  parseKsfProxyRequest,
} from './src/maps/ksfproxy.js';

/**
 * Dev/preview only: serves BSP files from $SURF_TEST_MAPS at /__maps/<name>.bsp so automated
 * browser tests can load real maps without hitting Google Drive (?bsp=/__maps/surf_kitsune.bsp).
 */
function testMaps(): Plugin {
  const dirs = [process.env.SURF_TEST_MAPS, process.env.SURF_TEST_MAPS_LARGE].filter(Boolean) as string[];
  const handler = (req: { url?: string }, res: any, next: () => void) => {
    if (!req.url?.startsWith('/__maps/')) return next();
    const name = basename(decodeURIComponent(req.url.slice('/__maps/'.length).split('?')[0]));
    for (const d of dirs) {
      const p = join(d, name);
      if (existsSync(p)) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(p).size));
        createReadStream(p).pipe(res);
        return;
      }
    }
    res.statusCode = 404;
    res.end('not found');
  };
  return {
    name: 'surf-test-maps',
    configureServer(server) {
      if (dirs.length) server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      if (dirs.length) server.middlewares.use(handler);
    },
  };
}

/**
 * Dev/preview: downloads catalog maps from Google Drive at /__drive/<fileId> (src/maps/downloader.ts). Drive
 * answers a web page's cross-site download with 403 and no CORS header, so the browser can't fetch the archives
 * itself; from the local server it is a plain download, streamed through.
 */
function driveProxy(): Plugin {
  const handler = async (req: { url?: string }, res: any, next: () => void) => {
    const m = /\/__drive\/([A-Za-z0-9_-]{10,128})(?:[?#]|$)/.exec(req.url ?? '');
    if (!m) return next();
    res.setHeader('x-surf-drive-proxy', '1');
    res.setHeader('Cache-Control', 'no-store');
    let up: Response;
    try {
      up = await fetch(`https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`);
    } catch (e) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(String((e as Error)?.message ?? e));
      return;
    }
    res.statusCode = up.status;
    res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/octet-stream');
    const len = up.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    if (!up.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(up.body as any);
    body.on('error', () => res.destroy());
    res.on('close', () => {
      if (!res.writableFinished) body.destroy();
    });
    body.pipe(res);
  };
  return {
    name: 'surf-drive-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

/**
 * Dev/preview: KSF world records (src/maps/ksf.ts). ksf.surf's API sends no CORS headers, so the page asks the local
 * server: /__ksf/records/<map>?game=<66t|100t> (the main course leaderboard, JSON) and /__ksf/replay/<file>?game=...
 * (a record's replay). Only URLs built from the validated map / file / board (src/maps/ksfproxy.ts) are fetched,
 * with a timeout and a size cap; nothing is stored.
 */
function ksfProxy(): Plugin {
  const handler = async (req: { url?: string; method?: string }, res: any, next: () => void) => {
    const route = parseKsfProxyRequest(req.url ?? '');
    if (!route) return next();
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
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'GET only');
    const records = route.kind === 'records';
    const maxBytes = records ? KSF_RECORDS_MAX_BYTES : KSF_REPLAY_MAX_BYTES;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), records ? KSF_RECORDS_TIMEOUT_MS : KSF_REPLAY_TIMEOUT_MS);
    res.on('close', () => {
      clearTimeout(timer);
      if (!res.writableFinished) ac.abort();
    });
    try {
      const up = await fetch(route.upstream, {
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
      fail(502, ac.signal.aborted ? 'ksf.surf took too long to answer' : String((e as Error)?.message ?? e));
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    name: 'surf-ksf-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [driveProxy(), ksfProxy(), testMaps()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ['node-unrar-js'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
  },
} as any);
