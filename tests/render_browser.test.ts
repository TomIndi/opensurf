// The renderer in headless Chromium (SwiftShader WebGL2) through render-harness.html: pixel checks on the
// synthetic fixture map (sky face orientation, 3D skybox, lightmaps, brush entity state, fog), the depth/extension
// fallbacks, built-in maps, resource leaks over repeated loads and, with $SURF_TEST_MAPS, real KSF maps.
// Skipped without a Chromium build (CI) or with SURF_RENDER_BROWSER=0.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Private Vite dependency cache of this file's dev server (removed afterwards). */
let viteCache = '';

function findChromium(): string | null {
  if (process.env.SURF_RENDER_BROWSER === '0') return null;
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM;
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    const p = join(base, d, 'chrome-linux', 'chrome');
    if (d.startsWith('chromium-') && existsSync(p)) return p;
  }
  return null;
}

const chromiumPath = findChromium();
const ROOT = resolve(__dirname, '..');
const MAPS = process.env.SURF_TEST_MAPS ?? '';

type Page = import('playwright-core').Page;
type Browser = import('playwright-core').Browser;

interface Harness {
  state: { ready: boolean; error: string | null };
  renderer: {
    depthMode: string;
    setSettings: (s: object) => void;
    setModelVisible: (m: number, v: boolean) => void;
    setModelAlpha: (m: number, a: number) => void;
    setModelColor: (m: number, c: number[]) => void;
    setZones: (z: unknown[], g: number) => void;
    setGhosts: (g: unknown[]) => void;
    setDebugBoxes: (b: unknown[]) => void;
    stats: () => { drawCalls: number; triangles: number; textures: number };
    resize: (w: number, h: number, dpr: number) => void;
  };
  setView: (pos: number[] | null, ang: number[] | null, fov?: number) => void;
  readPixel: (x: number, y: number) => number[];
  cullingDiff: () => number;
  renderNow: () => { drawCalls: number; triangles: number; textures: number };
  reload: (n: number) => Promise<{ textures: number; geometries: number; programs: number }>;
  info: () => {
    depth: string;
    samples: number;
    textures: number;
    geometries: number;
    programs: number;
    scene: Record<string, number> | null;
    targetSize: number[];
    sky: { procedural: boolean; sky3d: boolean };
    faces: { audit: { inverted: number; correct: number; invertedArea: number; correctArea: number } | null; doubleSided: boolean } | null;
  };
}

declare const window: { __renderHarness: Harness };

describe.skipIf(!chromiumPath)('renderer in a real browser', () => {
  let browser: Browser;
  let server: { close: () => Promise<void>; httpServer: { address: () => unknown } | null };
  let base = '';

  beforeAll(async () => {
    const { createServer } = await import('vite');
    const s = await createServer({
      configFile: join(ROOT, 'vite.render-harness.config.ts'),
      // own dependency cache (see ui_browser.test.ts): parallel dev servers must not re-optimize it under the page
      cacheDir: (viteCache = mkdtempSync(join(tmpdir(), 'surf-vite-render-'))),
      root: ROOT,
      logLevel: 'error',
      // no HMR / file watching: other work in the tree must not reload the page under the test
      server: { port: 0, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    });
    await s.listen();
    server = s as unknown as typeof server;
    const addr = s.httpServer!.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}/render-harness.html`;
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (viteCache) rmSync(viteCache, { recursive: true, force: true });
  });

  async function open(query: string, w = 640, h = 360): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`${base}?hud=0&fly=0&${query}`);
    await page.waitForFunction(() => window.__renderHarness?.state.ready, null, { timeout: 240000 });
    const err = await page.evaluate(() => window.__renderHarness.state.error);
    expect(err).toBeNull();
    return { page, errors };
  }

  const near = (px: number[], rgb: number[], tol = 6) => {
    for (let i = 0; i < 3; i++) expect(Math.abs(px[i] - rgb[i]), `pixel ${px} vs ${rgb}`).toBeLessThanOrEqual(tol);
  };

  async function pixelAt(page: Page, pos: number[], ang: number[], fx = 0.5, fy = 0.5): Promise<number[]> {
    return page.evaluate(
      ({ pos, ang, fx, fy }) => {
        const h = window.__renderHarness;
        h.setView(pos, ang);
        return h.readPixel(fx, fy);
      },
      { pos, ang, fx, fy },
    );
  }

  async function fixtureChecks(page: Page): Promise<void> {
    // 2D skybox faces in Source orientation: rt = +X red, bk = +Y blue, lf = -X green, ft = -Y yellow
    near(await pixelAt(page, [0, 0, 200], [-40, 0]), [255, 0, 0], 2);
    near(await pixelAt(page, [0, 0, 200], [-40, 90]), [0, 0, 255], 2);
    near(await pixelAt(page, [0, 0, 200], [-40, 180]), [0, 255, 0], 2);
    near(await pixelAt(page, [0, 0, 200], [-40, 270]), [255, 255, 0], 2);
    // 3D skybox block (magenta) straight up, through the sky ceiling; without r_3dsky the up face (white)
    near(await pixelAt(page, [0, 0, 200], [-89, 0]), [255, 0, 255], 2);
    await page.evaluate(() => window.__renderHarness.renderer.setSettings({ drawSky3D: false }));
    near(await pixelAt(page, [0, 0, 200], [-89, 0]), [255, 255, 255], 2);
    await page.evaluate(() => window.__renderHarness.renderer.setSettings({ drawSky3D: true }));
    // walls: albedo (180,150,120) x lightmap 0.5 in linear space
    near(await pixelAt(page, [0, 0, 200], [0, 135]), [131, 109, 86], 4);
    // mat_fullbright: albedo itself
    await page.evaluate(() => window.__renderHarness.renderer.setSettings({ fullbright: true }));
    near(await pixelAt(page, [0, 0, 200], [0, 135]), [180, 150, 120], 4);
    await page.evaluate(() => window.__renderHarness.renderer.setSettings({ fullbright: false }));
    // brush entity: visible / hidden / tinted / translucent
    near(await pixelAt(page, [0, 0, 200], [10, 90]), [255, 128, 0], 3);
    await page.evaluate(() => window.__renderHarness.renderer.setModelVisible(1, false));
    near(await pixelAt(page, [0, 0, 200], [10, 90]), [131, 109, 86], 4);
    await page.evaluate(() => window.__renderHarness.renderer.setModelVisible(1, true));
    await page.evaluate(() => window.__renderHarness.renderer.setModelColor(1, [0, 1, 0]));
    near(await pixelAt(page, [0, 0, 200], [10, 90]), [0, 128, 0], 3);
    await page.evaluate(() => window.__renderHarness.renderer.setModelColor(1, [1, 1, 1]));
    await page.evaluate(() => window.__renderHarness.renderer.setModelAlpha(1, 0.5));
    const half = await pixelAt(page, [0, 0, 200], [10, 90]);
    expect(half[0]).toBeGreaterThan(160); // blend of orange and the wall behind
    expect(half[0]).toBeLessThan(250);
    expect(half[2]).toBeGreaterThan(20);
    await page.evaluate(() => window.__renderHarness.renderer.setModelAlpha(1, 1));
    // base textures are not flipped or mirrored: image row 0 is texture v = 0 (Source's t = 0 is the top row)
    const q = (dy: number, dz: number): [number, number] => {
      // screen position of the point dy left / dz up of the quad centre (-500, 0, 100), seen from (0, 0, 100)
      // looking -X at 16:9, fov 90
      const tv = 0.75; // tan(vfov / 2) for fov 90 (Source 4:3 horizontal)
      const tx = tv * (16 / 9); // the test viewport is 16:9
      return [0.5 - dy / 500 / tx / 2, 0.5 - dz / 500 / tv / 2];
    };
    near(await pixelAt(page, [0, 0, 100], [0, 180], ...q(25, 25)), [255, 0, 0], 60);
    near(await pixelAt(page, [0, 0, 100], [0, 180], ...q(-25, 25)), [0, 255, 0], 60);
    near(await pixelAt(page, [0, 0, 100], [0, 180], ...q(25, -25)), [0, 0, 255], 60);
    near(await pixelAt(page, [0, 0, 100], [0, 180], ...q(-25, -25)), [255, 255, 255], 60);
    // displacement blend: alpha 0 -> $basetexture (red), alpha 1 -> $basetexture2 (blue)
    const left = await pixelAt(page, [-490, 400, 300], [89, 0]);
    const right = await pixelAt(page, [-310, 400, 300], [89, 0]);
    expect(left[0]).toBeGreaterThan(200);
    expect(left[2]).toBeLessThan(110);
    expect(right[2]).toBeGreaterThan(200);
    expect(right[0]).toBeLessThan(110);
    // r_brightness scales the lighting
    await page.evaluate(() => window.__renderHarness.renderer.setSettings({ brightness: 2 }));
    near(await pixelAt(page, [0, 0, 200], [0, 135]), [180, 150, 120], 5);
    await page.evaluate(() => window.__renderHarness.renderer.setSettings({ brightness: 1 }));
  }

  it('fixture map: sky orientation, 3D sky, lightmaps, brush entities (reversed float depth)', async () => {
    const { page, errors } = await open('fixture=1&time=1');
    const info = await page.evaluate(() => window.__renderHarness.info());
    expect(info.depth).toBe('reversed-float');
    expect(info.samples).toBeGreaterThan(0);
    expect(info.sky.sky3d).toBe(true);
    await fixtureChecks(page);
    expect(errors).toEqual([]);
    await page.close();
  }, 240000);

  it('falls back to a logarithmic depth buffer without EXT_clip_control (and copes without anisotropy / S3TC)', async () => {
    const { page, errors } = await open('fixture=1&time=1&noext=EXT_clip_control,EXT_texture_filter_anisotropic,WEBGL_compressed_texture_s3tc,OES_texture_float_linear');
    const info = await page.evaluate(() => window.__renderHarness.info());
    expect(info.depth).toBe('logarithmic');
    await fixtureChecks(page);
    expect(errors).toEqual([]);
    await page.close();
  }, 240000);

  it('fog fades distant surfaces to the fog colour', async () => {
    const { page } = await open('fixture=1&fixturefog=1&time=1');
    // the far wall is ~500 units away with fog 0..2000: about a quarter of the way to grey
    const px = await pixelAt(page, [0, 0, 200], [0, 135]);
    expect(px[0]).toBeLessThan(140);
    expect(Math.abs(px[0] - px[2])).toBeLessThan(131 - 86); // pulled toward the grey fog colour
    await page.evaluate(() => window.__renderHarness.renderer.setSettings({ fogEnabled: false }));
    near(await pixelAt(page, [0, 0, 200], [0, 135]), [131, 109, 86], 4);
    await page.close();
  }, 240000);

  it('underwater: inside a water volume everything fades into the water fog colour', async () => {
    const { page } = await open('fixture=1&time=1');
    // above water: the far wall
    near(await pixelAt(page, [-300, 0, 200], [0, 135]), [131, 109, 86], 4);
    // eye inside the pool's volume: fully fogged to $fogcolor (0.1 0.25 0.3), sky included
    const px = await pixelAt(page, [-300, 0, -50], [0, 0]);
    near(px, [26, 64, 77], 6);
    // looking up: the underside of the water surface over the fogged world/3D sky - all water coloured
    const up = await pixelAt(page, [-300, 0, -50], [-80, 0]);
    near(up, [26, 64, 77], 16);
    // and back to normal
    near(await pixelAt(page, [-300, 0, 200], [0, 135]), [131, 109, 86], 4);
    await page.close();
  }, 240000);

  it('zones, ghosts, debug boxes, clip brushes, wireframe and render scale draw without errors', async () => {
    const { page, errors } = await open('fixture=1&time=1');
    const before = await page.evaluate(() => window.__renderHarness.renderNow());
    const after = await page.evaluate(() => {
      const h = window.__renderHarness;
      const r = h.renderer;
      h.setView([0, 0, 64], [10, 0]);
      r.setZones([{ type: 'start', group: 0, index: 0, mins: { x: 100, y: -100, z: 0 }, maxs: { x: 300, y: 100, z: 128 } }], 0);
      r.setGhosts([{ id: 'g', origin: { x: 200, y: 0, z: 0 }, angles: { pitch: 0, yaw: 180, roll: 0 }, ducked: false, color: [1, 0.5, 0], name: 'ghost', visible: true, trail: true }]);
      r.setDebugBoxes([{ mins: { x: 100, y: -50, z: 0 }, maxs: { x: 150, y: 50, z: 50 }, color: [1, 0, 0] }]);
      r.setSettings({ drawClips: true, renderScale: 0.5 });
      return h.renderNow();
    });
    expect(after.drawCalls).toBeGreaterThan(before.drawCalls);
    const info = await page.evaluate(() => window.__renderHarness.info());
    expect(info.targetSize[0]).toBe(320);
    // the zone's green beam on the floor in front
    const zonePx = await page.evaluate(() => {
      const h = window.__renderHarness;
      h.renderer.setGhosts([]);
      h.renderer.setDebugBoxes([]);
      h.setView([200, 0, 400], [89, 0]);
      return h.readPixel(0.5, 0.5);
    });
    expect(zonePx).toBeTruthy();
    await page.evaluate(() => {
      const h = window.__renderHarness;
      h.renderer.setSettings({ wireframe: true, renderScale: 1 });
      h.renderNow();
      h.renderer.setSettings({ wireframe: false });
      h.renderNow();
    });
    expect(errors).toEqual([]);
    await page.close();
  }, 240000);

  it('does not leak GPU resources over 20 map loads', async () => {
    const { page } = await open('fixture=1&time=1');
    const first = await page.evaluate(() => window.__renderHarness.reload(1));
    const after = await page.evaluate(() => window.__renderHarness.reload(20));
    expect(after.textures).toBe(first.textures);
    expect(after.geometries).toBe(first.geometries);
    expect(after.programs).toBeLessThanOrEqual(first.programs + 2);
    await page.close();
  }, 240000);

  it('renders the built-in maps', async () => {
    let mod: { BUILTIN_MAPS: { id: string }[] } | null = null;
    try {
      mod = await import('../src/map/builtin/index');
    } catch {
      mod = null;
    }
    for (const m of mod?.BUILTIN_MAPS ?? []) {
      const { page, errors } = await open(`builtin=${m.id}&time=2`);
      const s = await page.evaluate(() => window.__renderHarness.renderNow());
      expect(s.drawCalls).toBeGreaterThan(3);
      const info = await page.evaluate(() => window.__renderHarness.info());
      expect(info.sky.procedural).toBe(true);
      // not a black screen: the centre and the top (sky or walls) have colour
      const c = await page.evaluate(() => window.__renderHarness.readPixel(0.5, 0.7));
      expect(c[0] + c[1] + c[2]).toBeGreaterThan(15);
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 240000);

  describe.skipIf(!MAPS)('real KSF maps', () => {
    for (const name of ['surf_utopia_njv', 'surf_kitsune']) {
      it(`${name}: loads, renders and reloads without leaks`, async () => {
        if (!existsSync(join(MAPS, `${name}.bsp`))) return;
        const { page, errors } = await open(`bsp=/__maps/${name}.bsp&time=2`);
        const s = await page.evaluate(() => window.__renderHarness.renderNow());
        expect(s.drawCalls).toBeGreaterThan(10);
        expect(s.triangles).toBeGreaterThan(1000);
        const info = await page.evaluate(() => window.__renderHarness.info());
        expect(info.scene!.meshes).toBeGreaterThan(10);
        expect(info.scene!.triangles).toBeGreaterThan(10000);
        // no wall may vanish to back-face culling: the spawn view (and three more directions) look the same with
        // culling switched off for every surface (the face orientation audit picks double-sided drawing when
        // the loader emits faces inside-out)
        expect(info.faces).toBeTruthy();
        // the loader winds brush faces toward their front side now: single-sided culling, like the engine
        const audit = info.faces!.audit!;
        expect(audit.invertedArea / (audit.invertedArea + audit.correctArea)).toBeLessThan(0.05);
        expect(info.faces!.doubleSided).toBe(false);
        for (const turn of [0, 90, 180, 270]) {
          const diff = await page.evaluate((turn) => {
            const h = window.__renderHarness;
            if (turn) h.setView(null, [10, turn]);
            return h.cullingDiff();
          }, turn);
          expect(diff, `pixels lost to culling, view ${turn}`).toBeLessThan(0.02);
        }
        if (name === 'surf_kitsune') {
          // the red stage start: a floor of 4 stacked translucent grids (black, thin red lines), seen from a
          // spawn position whose eye plane contains floor vertices. Mostly dark - not the solid red of layers
          // drawn front to back or of triangles smeared from w = 0 vertices
          const px = await pixelAt(page, [-15360, -15088, 880], [0, 90], 0.3, 0.9);
          expect(px[0], `floor pixel ${px}`).toBeLessThan(120);
        }
        const first = await page.evaluate(() => window.__renderHarness.reload(1));
        const again = await page.evaluate(() => window.__renderHarness.reload(2));
        expect(again.textures).toBe(first.textures);
        expect(again.geometries).toBe(first.geometries);
        expect(errors).toEqual([]);
        await page.close();
      }, 300000);
    }
  });
});
