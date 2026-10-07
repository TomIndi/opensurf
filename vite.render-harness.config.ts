// Dev server for the renderer harness (render-harness.html): serves BSP files from $SURF_TEST_MAPS (and
// $SURF_TEST_MAPS_LARGE) at /__maps/<name>.bsp so the harness and the browser tests can load real maps.
//   SURF_TEST_MAPS=/path/to/maps npx vite --config vite.render-harness.config.ts
//   open http://localhost:5174/render-harness.html?bsp=/__maps/surf_utopia_njv.bsp
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

function mapFiles(): Plugin {
  const dirs = [process.env.SURF_TEST_MAPS, process.env.SURF_TEST_MAPS_LARGE].filter(Boolean) as string[];
  const handler = (req: { url?: string }, res: any, next: () => void) => {
    if (!req.url?.startsWith('/__maps/')) return next();
    let name = '';
    try {
      name = basename(decodeURIComponent(req.url.slice('/__maps/'.length).split('?')[0]));
    } catch {
      name = '';
    }
    for (const d of dirs) {
      const p = join(d, name);
      if (name && existsSync(p) && statSync(p).isFile()) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(p).size));
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(p).pipe(res);
        return;
      }
    }
    res.statusCode = 404;
    res.end('not found');
  };
  return {
    name: 'surf-render-harness-maps',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  root: resolve(__dirname),
  base: './',
  plugins: [mapFiles()],
  server: { port: 5174, strictPort: false },
  optimizeDeps: { exclude: ['node-unrar-js'] },
  build: {
    target: 'es2022',
    outDir: 'dist-render-harness',
    rollupOptions: { input: resolve(__dirname, 'render-harness.html') },
  },
});
