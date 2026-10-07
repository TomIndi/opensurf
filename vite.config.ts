import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

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

export default defineConfig({
  base: './',
  plugins: [testMaps()],
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
