// End-to-end game core in headless Chromium: the real Ui + SoundSystem + Game (rAF loop, DOM input, pointer lock,
// chat, console, pause) with a stub renderer, served by Vite from a harness generated in a temp directory.
// Skipped when no Chromium is installed (CI) or with SURF_GAMECORE_BROWSER=0. With $SURF_TEST_MAPS it also plays
// a real KSF map loaded over HTTP.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function findChromium(): string | null {
  if (process.env.SURF_GAMECORE_BROWSER === '0') return null;
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
const KITSUNE = MAPS ? join(MAPS, 'surf_kitsune.bsp') : '';
/** Optional: directory for screenshots of the key moments (manual review). */
const SHOTS = process.env.SURF_GAMECORE_SHOTS ?? '';

const HARNESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><title>gamecore harness</title><link rel="icon" href="data:," />
<style>html,body{margin:0;height:100%;background:#06080c;overflow:hidden}#game-canvas{position:fixed;inset:0;width:100%;height:100%}</style>
</head><body><div id="app"></div><script type="module" src="./harness.ts"></script></body></html>`;

const HARNESS_TS = `
import { SoundSystem } from '@surf/audio/audio';
import { v3 } from '@surf/core/vec3';
import { Game } from '@surf/game/game';
import { brushFromBox } from '@surf/physics/brushbuild';
import { CollisionWorld } from '@surf/physics/collision';
import { CONTENTS_SOLID } from '@surf/physics/types';
import { Ui } from '@surf/ui/ui';

class StubRenderer {
  renders = 0; loads = 0; unloads = 0; zoneSets = 0; ghosts = 0; settings = {}; lastView = null; size = null;
  async loadMap() { this.loads++; }
  unloadMap() { this.unloads++; }
  setModelVisible() {} setModelAlpha() {} setModelColor() {}
  setZones() { this.zoneSets++; }
  setGhosts(g) { this.ghosts = g.length; }
  setSettings(s) { Object.assign(this.settings, s); }
  render(v) { this.renders++; this.lastView = JSON.parse(JSON.stringify(v)); }
  resize(w, h, dpr) { this.size = [w, h, dpr]; }
  setDebugBoxes() {}
  stats() { return { drawCalls: 0, triangles: 0, textures: 0 }; }
}

function testMap() {
  const box = (a, b) => brushFromBox(v3(...a), v3(...b), CONTENTS_SOLID, 0);
  const brushes = [box([-2048, -2048, -64], [2048, 2048, 0]), box([2048, -2048, -64], [2112, 2048, 1024]), box([-2112, -2048, -64], [-2048, 2048, 1024])];
  return {
    name: 'surf_browser_test', source: 'builtin', entities: [],
    models: [{ index: 0, mins: v3(-2112, -2112, -64), maxs: v3(2112, 2112, 1024), origin: v3(), brushes }],
    collision: new CollisionWorld(brushes), render: {},
    spawns: [{ origin: v3(0, 0, 0), angles: { pitch: 0, yaw: 0, roll: 0 } }],
    zones: [
      { type: 'start', group: 0, index: 0, mins: v3(-128, -128, 0), maxs: v3(128, 128, 128) },
      { type: 'end', group: 0, index: 0, mins: v3(1400, -256, 0), maxs: v3(1600, 256, 128) },
    ],
    zoneSource: 'builtin', worldMins: v3(-2112, -2112, -64), worldMaxs: v3(2112, 2112, 1024), warnings: [],
  };
}

const params = new URLSearchParams(location.search);
if (params.get('spylock')) {
  window.__lockCalls = [];
  HTMLCanvasElement.prototype.requestPointerLock = function (opts) { window.__lockCalls.push(opts ?? null); return Promise.resolve(); };
}
const root = document.getElementById('app');
const canvas = document.createElement('canvas');
canvas.id = 'game-canvas';
canvas.tabIndex = 0;
root.appendChild(canvas);
const uiRoot = document.createElement('div');
uiRoot.id = 'ui-root';
root.appendChild(uiRoot);
const renderer = new StubRenderer();
const sound = new SoundSystem();
const ui = new Ui(uiRoot, sound);
const game = new Game({ renderer, ui, sound, canvas, loaders: {
  buildBuiltin: async () => testMap(),
  builtinMaps: async () => [{ id: 'test', name: 'Browser test', tier: 1 }],
} });
ui.attachGame(game);
game.start();
window.__h = { game, ui, renderer };
`;

const LOADMAP_STUB = `
import { parseBsp } from '@surf/bsp/reader';
import { parseEntities } from '@surf/bsp/entities';
import { buildBrushModels, collectCollisionBrushes } from '@surf/bsp/bspcollision';
import { CollisionWorld } from '@surf/physics/collision';
import { v3 } from '@surf/core/vec3';
export async function loadBspMap(name, data, onProgress) {
  onProgress?.({ phase: 'parse', message: 'Reading BSP lumps' });
  const bsp = parseBsp(data);
  const entities = parseEntities(bsp.entitiesText);
  onProgress?.({ phase: 'collision', message: 'Building collision' });
  const models = buildBrushModels(bsp, { entities });
  const set = collectCollisionBrushes(bsp, entities, models);
  const collision = new CollisionWorld(set.brushes);
  for (const m of set.disabledModels) collision.setModelSolid(m, false);
  const spawns = entities.filter((e) => /^info_player_(terrorist|counterterrorist|start)$/.test(e.classname)).map((e) => ({ origin: { ...e.origin }, angles: { ...e.angles } }));
  return { name, source: 'bsp', version: bsp.version, entities, models, collision, render: {}, spawns, zones: [], zoneSource: 'none',
    worldMins: v3(-16384, -16384, -16384), worldMaxs: v3(16384, 16384, 16384), warnings: [] };
}
`;

const BUILTIN_STUB = `
export const BUILTIN_MAPS = [{ id: 'test', name: 'Browser test', description: 'stub', tier: 1, type: 'linear' }];
export function buildBuiltinMap() { throw new Error('stub'); }
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;

describe.skipIf(!chromiumPath)('game core in a real browser', () => {
  let server: any;
  let browser: any;
  let page: Page;
  let base = '';
  let tmpDir = '';
  const errors: string[] = [];
  const ev = <T>(fn: (arg: any) => T, arg?: unknown): Promise<T> => page.evaluate(fn, arg);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const state = (): Promise<any> => ev(() => (window as any).__surf.state());
  const shot = async (name: string): Promise<void> => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  async function open(p: Page, query: string): Promise<void> {
    await p.route(/fonts\.(googleapis|gstatic)\.com/, (r: any) => r.abort());
    p.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
    p.on('console', (m: any) => {
      if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::|404/.test(m.text())) errors.push(`console.error: ${m.text()}`);
    });
    await p.goto(`${base}/harness.html${query}`, { waitUntil: 'load' });
    await p.waitForFunction(() => (window as any).__h && (window as any).__surf, null, { timeout: 60000 });
  }

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surf-gamecore-'));
    tmpDir = dir;
    writeFileSync(join(dir, 'harness.html'), HARNESS_HTML);
    writeFileSync(join(dir, 'harness.ts'), HARNESS_TS);
    const alias: { find: string | RegExp; replacement: string }[] = [{ find: /^@surf\//, replacement: `${join(ROOT, 'src')}/` }];
    // modules owned by other tasks may not exist yet: stand-ins with the same exports
    if (!existsSync(join(ROOT, 'src/bsp/loadmap.ts'))) {
      writeFileSync(join(dir, 'loadmap-stub.ts'), LOADMAP_STUB);
      alias.push({ find: /^\.\.\/bsp\/loadmap$/, replacement: join(dir, 'loadmap-stub.ts') });
    }
    if (!existsSync(join(ROOT, 'src/map/builtin/index.ts'))) {
      writeFileSync(join(dir, 'builtin-stub.ts'), BUILTIN_STUB);
      alias.push({ find: /^\.\.\/map\/builtin\/index$/, replacement: join(dir, 'builtin-stub.ts') });
    }
    const { createServer } = await import('vite');
    server = await createServer({
      configFile: false,
      root: dir,
      base: '/',
      publicDir: join(ROOT, 'public'),
      logLevel: 'error',
      server: { port: 0, host: '127.0.0.1', strictPort: false, fs: { allow: [dir, ROOT, ...(MAPS ? [MAPS] : [])] } },
      optimizeDeps: { exclude: ['node-unrar-js'], entries: [join(dir, 'harness.html')] },
      resolve: { alias },
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await open(page, '?builtin=test&autotest=1');
    await page.waitForFunction(() => (window as any).__h.game.state === 'playing', null, { timeout: 60000 });
    await wait(200);
  }, 180000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('boots, autoloads the map from the URL and runs the rAF loop', async () => {
    const st = await state();
    expect(st.state).toBe('playing');
    expect(st.mapName).toBe('surf_browser_test');
    expect(st.timer.state).toBe('startzone');
    const r0 = await ev(() => (window as any).__h.renderer.renders);
    await wait(300);
    const r1 = await ev(() => (window as any).__h.renderer.renders);
    expect(r1 - r0).toBeGreaterThan(5);
    expect(await ev(() => (window as any).__h.renderer.size)).toEqual([1280, 720, 1]);
    // the real HUD is up
    expect(await ev(() => !document.querySelector('.hud')!.classList.contains('hud-hidden'))).toBe(true);
    expect(await ev(() => (window as any).__h.ui.lockHintEnabled)).toBe(false);
  });

  it('holding W runs forward; releasing stops; the HUD speedometer follows', async () => {
    await page.keyboard.down('w');
    await page.waitForFunction(() => (window as any).__surf.state().speed > 200, null, { timeout: 10000 });
    const st = await state();
    expect(st.speed).toBeGreaterThan(200);
    expect(await ev(() => (window as any).__h.ui.lastHud?.speed ?? (window as any).__h.game.getHud().speed)).toBeGreaterThan(200);
    expect(await ev(() => (window as any).__h.game.getHud().keys.forward)).toBe(true);
    await page.keyboard.up('w');
    await page.waitForFunction(() => (window as any).__surf.state().speed < 5, null, { timeout: 10000 });
    const st2 = await state();
    expect(st2.origin.x).toBeGreaterThan(30);
    expect(st2.speed).toBeLessThan(5);
    expect(await ev(() => (window as any).__h.game.getHud().keys.forward)).toBe(false);
  });

  it('the R bind (say !r) brings the player back to the start', async () => {
    await page.keyboard.press('r');
    await wait(100);
    const st = await state();
    expect(Math.abs(st.origin.x)).toBeLessThan(1);
    expect(st.timer.state).toBe('startzone');
  });

  it('mouse wheel jumps (scroll bhop) without pointer lock in autotest mode', async () => {
    await page.mouse.move(640, 360);
    await wait(50);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => (window as any).__surf.state().origin.z > 1, null, { timeout: 10000 });
    const st = await state();
    expect(st.origin.z).toBeGreaterThan(1);
    expect(await ev(() => (window as any).__h.game.input.isDown('jump'))).toBe(false);
    await page.waitForFunction(() => (window as any).__surf.state().onGround, null, { timeout: 10000 });
  });

  it('chat: Y opens it without typing "y"; keys are ignored while typing; !r runs', async () => {
    await page.keyboard.press('y');
    await wait(80);
    expect(await ev(() => (window as any).__h.ui.chatBox.isOpen)).toBe(true);
    expect(await ev(() => (document.querySelector('.chat-input') as HTMLInputElement).value)).toBe('');
    const before = await state();
    await page.keyboard.type('w!r');
    await wait(200);
    expect((await state()).origin.x).toBeCloseTo(before.origin.x, 3); // typing "w" doesn't move
    await page.keyboard.press('Enter');
    await wait(100);
    const lines = await ev(() => [...document.querySelectorAll('.chat-msg')].map((e) => e.textContent));
    expect(lines.some((l: string) => /Player\s*:\s*w!r/.test(l))).toBe(true);
    // chat a real command
    await page.keyboard.press('y');
    await wait(50);
    await page.keyboard.type('!mi');
    await page.keyboard.press('Enter');
    await wait(100);
    const lines2 = await ev(() => [...document.querySelectorAll('.chat-msg')].map((e) => e.textContent));
    expect(lines2.some((l: string) => l.includes('surf_browser_test') && l.includes('Tier 1') && l.includes('Linear'))).toBe(true);
    await shot('chat');
    expect(await state()).toMatchObject({ state: 'playing' });
  });

  it('console: ` opens it in game, commands run, ` closes it, the game keeps running', async () => {
    await page.keyboard.press('Backquote');
    await wait(80);
    expect(await ev(() => (window as any).__h.ui.console.isOpen)).toBe(true);
    expect(await ev(() => (document.querySelector('.devcon-input') as HTMLInputElement).value)).toBe('');
    await page.keyboard.type('getpos');
    await page.keyboard.press('Enter');
    await wait(80);
    expect(await ev(() => document.querySelector('.devcon-output')!.textContent)).toMatch(/setpos -?\d+\.\d{6} -?\d+\.\d{6} -?\d+\.\d{6};setang/);
    await page.keyboard.type('sv_gravity 400');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backquote');
    await wait(80);
    expect(await ev(() => (window as any).__h.ui.console.isOpen)).toBe(false);
    const st = await state();
    expect(st.state).toBe('playing');
    expect(await ev(() => (window as any).__surf.exec('sv_gravity'))).toEqual(['"sv_gravity" = "400" ( def. "800" )\n - World gravity (units/s²).']);
    await ev(() => (window as any).__surf.exec('sv_gravity 800'));
  });

  it('Tab shows the scoreboard while held', async () => {
    await page.keyboard.down('Tab');
    await wait(80);
    expect(await ev(() => !document.querySelector('.scoreboard')!.classList.contains('hidden'))).toBe(true);
    await page.keyboard.up('Tab');
    await wait(80);
    expect(await ev(() => document.querySelector('.scoreboard')!.classList.contains('hidden'))).toBe(true);
  });

  it('Escape pauses (pause menu) and resumes', async () => {
    await page.keyboard.press('Escape');
    await wait(120);
    await shot('paused');
    expect((await state()).state).toBe('paused');
    expect(await ev(() => !document.querySelector('.pause-menu, .pause')?.classList.contains('hidden'))).toBe(true);
    const t0 = (await state()).tick;
    await wait(200);
    expect((await state()).tick).toBe(t0);
    await page.keyboard.press('Escape');
    await wait(150);
    expect((await state()).state).toBe('playing');
  });

  it('a full run in the browser: leave the start, reach the end, PB in chat', async () => {
    await ev(() => (window as any).__surf.say('/r'));
    await page.keyboard.down('w');
    await page.waitForFunction(() => (window as any).__surf.state().timer.state === 'finished', null, { timeout: 15000 });
    await page.keyboard.up('w');
    await shot('finished');
    const lines = await ev(() => [...document.querySelectorAll('.chat-msg')].map((e) => e.textContent));
    expect(lines.some((l: string) => l.includes('finished surf_browser_test'))).toBe(true);
    expect(lines.some((l: string) => l.includes('NEW PERSONAL BEST'))).toBe(true);
    // the PB replay is available: !replay spectates it, jumping leaves
    await ev(() => (window as any).__surf.say('/replay'));
    await wait(300);
    expect((await state()).spectating).toBe(true);
    expect(await ev(() => (window as any).__h.game.getHud().spectating)).toBe('PB Replay');
    await page.keyboard.press('Space');
    await wait(100);
    expect((await state()).spectating).toBe(false);
  });

  it('clicking the canvas requests a raw pointer lock (normal mode)', async () => {
    const p2 = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await open(p2, '?builtin=test&spylock=1');
    await p2.waitForFunction(() => (window as any).__h.game.state === 'playing', null, { timeout: 60000 });
    await p2.mouse.click(400, 300);
    await wait(100);
    const calls = await p2.evaluate(() => (window as any).__lockCalls);
    expect(calls).toEqual([{ unadjustedMovement: true }]); // one request per click (the UI's own handler doesn't add a second)
    await p2.close();
  });

  it('real pointer lock: mouse look at CS:GO scale, Escape-style unlock pauses', async () => {
    const p3 = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await open(p3, '?builtin=test');
    await p3.waitForFunction(() => (window as any).__h.game.state === 'playing', null, { timeout: 60000 });
    await p3.mouse.move(400, 300);
    await p3.mouse.down();
    await p3.mouse.up();
    await wait(200);
    const locked = await p3.evaluate(() => document.pointerLockElement === document.getElementById('game-canvas'));
    if (!locked) {
      // headless builds without pointer lock support: nothing more to check here
      await p3.close();
      return;
    }
    const yaw0 = await p3.evaluate(() => (window as any).__surf.state().angles.yaw);
    await p3.mouse.move(500, 300, { steps: 5 }); // 100 counts right
    await wait(100);
    const yaw1 = await p3.evaluate(() => (window as any).__surf.state().angles.yaw);
    expect(yaw1 - yaw0).toBeCloseTo(-5.5, 1); // sensitivity 2.5 * m_yaw 0.022 * 100
    // the console takes the mouse without pausing; closing it captures the mouse again
    await p3.keyboard.press('Backquote');
    await wait(200);
    expect(await p3.evaluate(() => (window as any).__h.ui.console.isOpen)).toBe(true);
    expect(await p3.evaluate(() => document.pointerLockElement)).toBeNull();
    expect(await p3.evaluate(() => (window as any).__h.game.state)).toBe('playing');
    await p3.keyboard.press('Backquote');
    await wait(250);
    expect(await p3.evaluate(() => (window as any).__h.ui.console.isOpen)).toBe(false);
    expect(await p3.evaluate(() => document.pointerLockElement === document.getElementById('game-canvas'))).toBe(true);
    await p3.evaluate(() => document.exitPointerLock());
    await wait(150);
    expect(await p3.evaluate(() => (window as any).__h.game.state)).toBe('paused');
    await p3.close();
  });

  it.skipIf(!KITSUNE || !existsSync(KITSUNE))('plays a real KSF map loaded over HTTP (surf_kitsune)', async () => {
    const st = await ev((url: string) => (window as any).__surf.loadUrl(url), `/@fs${KITSUNE}`);
    expect(st.state).toBe('playing');
    expect(st.mapName).toBe('surf_kitsune');
    expect(st.timer.state).toBe('startzone');
    const lines = await ev(() => [...document.querySelectorAll('.chat-msg')].map((e) => e.textContent));
    expect(lines.some((l: string) => l.includes('Welcome to surf_kitsune'))).toBe(true);
    expect(lines.some((l: string) => l.includes('Zones: SurfTimer'))).toBe(true);
    await shot('kitsune-start');
    await page.keyboard.down('w');
    await wait(1500);
    await page.keyboard.up('w');
    await shot('kitsune-run');
    const after = await state();
    expect(after.timer.state === 'running' || after.timer.state === 'startzone').toBe(true);
    expect(Number.isFinite(after.origin.x)).toBe(true);
  });

  it('no page errors', () => {
    expect(errors).toEqual([]);
  });
});
