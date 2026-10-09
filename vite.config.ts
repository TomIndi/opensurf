import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { defineConfig, type Plugin } from 'vite';
import { DRIVE_PROXY_HEADER, DRIVE_PROXY_PREFIX, driveDownloadUrl, isValidDriveId } from './src/maps/drive.js';
import { createKsfProxyHandler } from './src/maps/ksfproxy.js';

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
    const url = req.url ?? '';
    const at = url.indexOf(DRIVE_PROXY_PREFIX);
    const pathEnd = url.search(/[?#]/);
    if (at < 0 || (pathEnd >= 0 && at > pathEnd)) return next();
    const id = url.slice(at + DRIVE_PROXY_PREFIX.length, pathEnd >= 0 ? pathEnd : undefined);
    if (!isValidDriveId(id)) return next();
    res.setHeader(DRIVE_PROXY_HEADER, '1');
    res.setHeader('Cache-Control', 'no-store');
    let up: Response;
    try {
      up = await fetch(driveDownloadUrl(id));
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
 * (a record's replay). The handler (src/maps/ksfproxy.ts createKsfProxyHandler, unit-tested) only fetches URLs built
 * from the validated map / file / board, with a timeout and a size cap; nothing is stored.
 */
function ksfProxy(): Plugin {
  const handler = createKsfProxyHandler();
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
