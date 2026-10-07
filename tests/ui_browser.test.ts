// End-to-end UI test: serves ui-harness.html (real Ui + SoundSystem + MockGame) with Vite and drives it in
// headless Chromium. Skipped when no Chromium is installed (CI) or with SURF_UI_BROWSER=0.
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function findChromium(): string | null {
  if (process.env.SURF_UI_BROWSER === '0') return null;
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
type Browser = any;
type Server = any;

describe.skipIf(!chromiumPath)('UI in a real browser (harness)', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const ev = <T>(fn: (arg: any) => T, arg?: unknown): Promise<T> => page.evaluate(fn, arg);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    const { createServer } = await import('vite');
    // the built-in maps module belongs to another task; stub it if it isn't there yet
    const alias: { find: RegExp; replacement: string }[] = [];
    if (!existsSync(join(ROOT, 'src/map/builtin/index.ts'))) {
      const dir = mkdtempSync(join(tmpdir(), 'surf-ui-'));
      const stub = join(dir, 'builtin-stub.ts');
      writeFileSync(
        stub,
        `export const BUILTIN_MAPS = [{ id: 'surf_test', name: 'surf_test', description: 'stub', tier: 1, type: 'linear' }];
export function buildBuiltinMap() { throw new Error('stub'); }`,
      );
      alias.push({ find: /^\.\.\/map\/builtin\/index$/, replacement: stub });
    }
    server = await createServer({
      configFile: false,
      root: ROOT,
      base: './',
      logLevel: 'error',
      server: { port: 0, host: '127.0.0.1', strictPort: false, fs: { allow: [ROOT, tmpdir()] } },
      optimizeDeps: { exclude: ['node-unrar-js'] },
      resolve: { alias },
    });
    await server.listen();
    const port = server.httpServer.address().port;
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    // no network in tests: fail web fonts fast (fallback fonts are fine)
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r: any) => r.abort());
    page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m: any) => {
      if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push(`console.error: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/ui-harness.html?scene=menu`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__harness?.ready, null, { timeout: 60000 });
    await wait(300);
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('main menu renders the catalog-driven home page', async () => {
    expect(await ev(() => !document.querySelector('.menu-screen')!.classList.contains('hidden'))).toBe(true);
    expect(await ev(() => document.querySelectorAll('.home-strip .map-card:not(.skeleton)').length)).toBe(6);
    expect(await ev(() => document.querySelector('.hero-stat b')!.textContent)).toMatch(/^\d{3}$/);
  });

  it('map browser: search, keyboard play, loading screen, then HUD', async () => {
    await page.click('.hero-actions .btn-primary');
    expect(await ev(() => document.querySelector('.page-play')!.classList.contains('active'))).toBe(true);
    await page.click('.search-input');
    await page.keyboard.type('kitsune');
    await wait(150);
    const sel = await ev(() => [...document.querySelectorAll<HTMLElement>('.pane-all.active .map-row.selected')].find((r) => r.style.display !== 'none')?.querySelector('.c-name')?.textContent);
    expect(sel).toBe('surf_kitsune');
    await page.keyboard.press('Enter');
    await wait(250);
    expect(await ev(() => !document.querySelector('.loading-screen')!.classList.contains('hidden'))).toBe(true);
    expect(await ev(() => document.querySelector('.loading-title')!.textContent)).toBe('surf_kitsune');
    await page.waitForFunction(() => (window as any).__harness.game.state === 'playing', null, { timeout: 20000 });
    await wait(150);
    expect(await ev(() => document.querySelector('.loading-screen')!.classList.contains('hidden'))).toBe(true);
    expect(await ev(() => !document.querySelector('.hud')!.classList.contains('hud-hidden'))).toBe(true);
    expect(await ev(() => document.querySelector('.ht-main')!.textContent)).toMatch(/^\d\d:\d\d\.\d\d$/);
    expect(await ev(() => (document.querySelector('.hud-crosshair') as HTMLCanvasElement).width)).toBeGreaterThan(10);
  });

  it('crosshair canvas is pixel-exact (CS:GO classic geometry at 1600x900)', async () => {
    const px = await ev(() => {
      const c = document.querySelector('.hud-crosshair') as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let green = 0;
      let black = 0;
      const greenAt: string[] = [];
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i + 3] === 0) continue;
          if (d[i + 1] > 200 && d[i] < 100) {
            green++;
            greenAt.push(`${Math.round(r.left) + x},${Math.round(r.top) + y}`);
          } else if (d[i] < 10 && d[i + 1] < 10 && d[i + 2] < 10) black++;
        }
      return { green, black, alpha: d.find((_, i) => i % 4 === 3 && d[i] > 0), greenAt };
    });
    // size 5 -> round(5 * 900/480) = 9 px bars, thickness 1 px, gap distance 5: 4 bars x 9 px
    expect(px.green).toBe(36);
    // outline 1: each bar's 11x3 outline minus its own 9 px
    expect(px.black).toBe(4 * (11 * 3 - 9));
    expect(px.alpha).toBe(200);
    // left bar ends 5 px left of the centre column (800), top bar 5 px above the centre row (450)
    expect(px.greenAt).toContain('794,450');
    expect(px.greenAt).not.toContain('795,450');
    expect(px.greenAt).toContain('800,444');
    expect(px.greenAt).not.toContain('800,445');
    expect(px.greenAt).toContain('806,450');
    expect(px.greenAt).toContain('800,456');
  });

  it('chat: messagemode, no stray key, send, history, Esc cancels', async () => {
    await page.keyboard.press('y');
    await wait(80);
    expect(await ev(() => (window as any).__harness.ui.chatBox.isOpen)).toBe(true);
    expect(await ev(() => (document.querySelector('.chat-input') as HTMLInputElement).value)).toBe('');
    expect(await ev(() => (window as any).__harness.ui.isTyping())).toBe(true);
    await page.keyboard.type('hello world');
    await page.keyboard.press('Enter');
    await wait(80);
    expect(await ev(() => [...document.querySelectorAll('.chat-msg')].at(-1)?.textContent)).toBe('Player: hello world');
    await page.keyboard.press('y');
    await wait(50);
    await page.keyboard.press('ArrowUp');
    expect(await ev(() => (document.querySelector('.chat-input') as HTMLInputElement).value)).toBe('hello world');
    await page.keyboard.press('Escape');
    await wait(50);
    expect(await ev(() => !(window as any).__harness.ui.chatBox.isOpen && (window as any).__harness.game.state === 'playing')).toBe(true);
  });

  it('console: autocomplete, Tab, execute, history, clear', async () => {
    await page.keyboard.press('Backquote');
    await wait(80);
    expect(await ev(() => (window as any).__harness.ui.console.isOpen)).toBe(true);
    expect(await ev(() => (document.querySelector('.devcon-input') as HTMLInputElement).value)).toBe('');
    await page.keyboard.type('sensitiv');
    await wait(50);
    expect(await ev(() => [...document.querySelectorAll('.devcon-sug .sug-name')].map((e) => e.textContent))).toContain('sensitivity');
    await page.keyboard.press('Tab');
    expect(await ev(() => (document.querySelector('.devcon-input') as HTMLInputElement).value)).toBe('sensitivity ');
    await page.keyboard.type('3.25');
    await page.keyboard.press('Enter');
    await wait(80);
    expect(await ev(() => (window as any).__harness.cv('sensitivity'))).toBe('3.25');
    expect(await ev(() => document.querySelector('.devcon-output')!.textContent)).toContain('] sensitivity 3.25');
    await page.keyboard.press('ArrowUp');
    expect(await ev(() => (document.querySelector('.devcon-input') as HTMLInputElement).value)).toBe('sensitivity 3.25');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('clear');
    await page.keyboard.press('Enter');
    await wait(100);
    expect(await ev(() => document.querySelectorAll('.devcon-output .cl').length)).toBe(0);
    await page.keyboard.press('Backquote');
    await wait(50);
    expect(await ev(() => (window as any).__harness.ui.console.isOpen)).toBe(false);
  });

  it('scoreboard follows +showscores', async () => {
    await page.keyboard.down('Tab');
    await wait(80);
    expect(await ev(() => !document.querySelector('.scoreboard')!.classList.contains('hidden'))).toBe(true);
    expect(await ev(() => document.querySelectorAll('.sb-table tbody tr').length)).toBe(3);
    await page.keyboard.up('Tab');
    await wait(50);
    expect(await ev(() => document.querySelector('.scoreboard')!.classList.contains('hidden'))).toBe(true);
  });

  it('pause menu → settings: crosshair paste, slider, binds capture, Esc navigation', async () => {
    await page.keyboard.press('Escape');
    await wait(120);
    expect(await ev(() => (window as any).__harness.game.state)).toBe('paused');
    await page.locator('.pause-nav .menu-item', { hasText: 'Settings' }).click();
    await page.click('.settings .tab:has-text("Crosshair")');
    await page.fill('.xh-paste', 'cl_crosshairsize 2; cl_crosshairgap -3\ncl_crosshairdot "1"\nsensitivity 9');
    await page.click('.xh-pastebox .btn-accent');
    await wait(80);
    expect(await ev(() => ['cl_crosshairsize', 'cl_crosshairgap', 'cl_crosshairdot', 'sensitivity'].map((n) => (window as any).__harness.cv(n)))).toEqual(['2', '-3', '1', '3.25']);
    expect(await ev(() => (document.querySelector('.pane-crosshair .slider-wrap .num-input') as HTMLInputElement).value)).toBe('2');
    await ev(() => {
      const r = document.querySelector('.pane-crosshair .slider-wrap input[type=range]') as HTMLInputElement;
      r.value = '7';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await ev(() => (window as any).__harness.cv('cl_crosshairsize'))).toBe('7');

    await page.click('.settings .tab:has-text("Binds")');
    await wait(100);
    const row = (label: string) => page.locator('.bind-row', { hasText: label }).first();
    await row('Use').locator('.bind-slot').nth(1).click();
    expect(await ev(() => (window as any).__harness.ui.settings.capturing)).toBe(true);
    await page.keyboard.press('f');
    await wait(100);
    expect(await ev(() => (window as any).__harness.bindOf('f'))).toBe('+use');
    await row('Duck').locator('.bind-slot').nth(1).click();
    await wait(30);
    await page.mouse.wheel(0, 120);
    await wait(100);
    expect(await ev(() => (window as any).__harness.bindOf('mwheeldown'))).toBe('+duck');
    await row('Use').locator('.bind-slot').nth(1).click();
    await wait(30);
    await page.keyboard.press('Backspace');
    await wait(100);
    expect(await ev(() => (window as any).__harness.bindOf('f'))).toBeNull();
    await row('Walk').locator('.bind-slot').nth(1).click();
    await wait(30);
    await page.keyboard.press('Escape');
    await wait(80);
    expect(await ev(() => !(window as any).__harness.ui.settings.capturing && (window as any).__harness.ui.pauseMenu.page === 'settings')).toBe(true);
    await page.keyboard.press('Escape');
    await wait(80);
    expect(await ev(() => (window as any).__harness.ui.pauseMenu.page)).toBe('root');
    await page.keyboard.press('Escape');
    await wait(120);
    expect(await ev(() => (window as any).__harness.game.state)).toBe('playing');
  });

  it('disconnect, cancel a load with Esc, drop a file to play', async () => {
    await page.keyboard.press('Escape');
    await wait(100);
    await page.click('.menu-item.danger');
    await wait(120);
    expect(await ev(() => (window as any).__harness.game.state)).toBe('menu');
    await ev(() => {
      void (window as any).__harness.game.loadCatalogMap('surf_mesa_fixed');
    });
    await wait(150);
    await page.keyboard.press('Escape');
    await wait(120);
    expect(await ev(() => (window as any).__harness.game.state === 'menu' && document.querySelector('.loading-screen')!.classList.contains('hidden'))).toBe(true);
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array([0x56, 0x42, 0x53, 0x50])], 'surf_dropped.bsp'));
      return d;
    });
    await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
    expect(await ev(() => document.querySelector('.drop-overlay')!.classList.contains('show'))).toBe(true);
    await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
    await wait(150);
    expect(await ev(() => (window as any).__harness.game.state)).toBe('loading');
    expect(await ev(() => document.querySelector('.loading-title')!.textContent)).toBe('surf_dropped');
    await page.waitForFunction(() => (window as any).__harness.game.state === 'playing', null, { timeout: 20000 });
  });

  it('load failures: shown on the loading screen with Retry / Back, or as a toast', async () => {
    await ev(() => {
      const h = (window as any).__harness;
      h.game.disconnect();
      h.game.failNext = { message: 'Google Drive answered HTTP 429.', viaSetLoading: true };
    });
    await page.click('.hero-actions .btn-primary').catch(() => undefined);
    await ev(() => (window as any).__harness.ui.mainMenu.setPage('play', false));
    await page.click('.tab:has-text("Featured")');
    await page.locator('.pane-featured .map-card', { hasText: 'kitsune' }).first().click();
    await page.waitForFunction(() => document.querySelector('.loading-screen.error') !== null, null, { timeout: 10000 });
    expect(await ev(() => document.querySelector('.loading-detail')!.textContent)).toContain('HTTP 429');
    expect(await ev(() => document.querySelectorAll('.toast.error').length)).toBe(0);
    // retry runs the same load again (and succeeds)
    await page.click('.loading-actions .btn-accent');
    await page.waitForFunction(() => (window as any).__harness.game.state === 'playing', null, { timeout: 20000 });
    expect(await ev(() => (window as any).__harness.game.mapName)).toBe('surf_kitsune');
    // a bare rejection (no loading-screen error) becomes a toast
    await ev(() => {
      const h = (window as any).__harness;
      h.game.disconnect();
      h.game.failNext = { message: 'Network error', viaSetLoading: false };
    });
    await ev(() => (window as any).__harness.ui.mainMenu.setPage('play', false));
    await page.locator('.pane-featured .map-card', { hasText: 'beginner' }).first().click();
    await page.waitForFunction(() => document.querySelector('.toast.error') !== null, null, { timeout: 10000 });
    expect(await ev(() => document.querySelector('.toast.error')!.textContent)).toContain('Network error');
    expect(await ev(() => document.querySelector('.loading-screen')!.classList.contains('hidden'))).toBe(true);
    expect(await ev(() => !document.querySelector('.menu-screen')!.classList.contains('hidden'))).toBe(true);
  });

  it('updateHud is cheap enough to run every frame', async () => {
    const ms = await ev(() => {
      const h = (window as any).__harness;
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) h.ui.updateHud(h.game.getHud());
      return (performance.now() - t0) / 2000;
    });
    expect(ms).toBeLessThan(0.3);
  });

  it('no page errors', () => {
    expect(errors).toEqual([]);
  });
});
