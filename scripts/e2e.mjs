#!/usr/bin/env node
// End-to-end run of the real game in headless Chromium (npm run e2e).
//
// Starts the Vite dev server (with the map directories below served at /__maps/<name>.bsp), opens the game
// with ?autotest=1 (no pointer lock needed, never pauses on focus loss) and drives it through the UI and the
// window.__surf debug API (src/game/debugapi.ts). Every uncaught page error fails the run.
//
// Scenarios (E2E_ONLY=a,b,... runs a subset):
//   a  main menu, map browser (catalog count, built-in tab)
//   b  every built-in map: spawn in the start zone, keyboard input moves the player, leaving the start zone
//      starts the timer, the fail trigger teleports back, !r restarts
//   c  every real map in $SURF_TEST_MAPS via ?bsp=: load time, start-zone placement, not stuck, screenshots
//      at spawn + viewpoints, renderer stats, fps
//   d  surf smoke test on real ramps (deterministic runTicks): speed builds up, never stuck or in solid
//   e  chat and console: messagemode, !commands, /silent commands, console cvars/commands, a rebound
//      toggleconsole key
//   f  map switching (built-in -> real -> real -> real -> built-in) without errors or memory growth
//
// Environment:
//   SURF_TEST_MAPS        directory of .bsp files for c/d/f (those scenarios are skipped without it)
//   SURF_TEST_MAPS_LARGE  directory with more maps (surf_summer_ksf...), loaded in c only with E2E_LARGE=1
//   CHROMIUM_PATH         Chromium binary (default: /opt/pw-browsers/chromium-*/chrome-linux/chrome, then
//                         playwright's own)
//   E2E_OUT               screenshot + results directory (default: <tmp>/surf-e2e); files are E2E_PREFIX*.png
//   E2E_PREFIX            screenshot name prefix (default "integ-")
//   E2E_MAPS              comma list restricting the real maps of scenario c
//   E2E_HEADFUL=1         show the browser
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.env.E2E_OUT || join(tmpdir(), 'surf-e2e'));
const PREFIX = process.env.E2E_PREFIX ?? 'integ-';
const ONLY = new Set((process.env.E2E_ONLY || 'a,b,c,d,e,f').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const MAPS_DIR = process.env.SURF_TEST_MAPS && existsSync(process.env.SURF_TEST_MAPS) ? process.env.SURF_TEST_MAPS : null;
const LARGE_DIR = process.env.SURF_TEST_MAPS_LARGE && existsSync(process.env.SURF_TEST_MAPS_LARGE) ? process.env.SURF_TEST_MAPS_LARGE : null;
const VIEW = { width: 1280, height: 720 };
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------------------------------ bookkeeping

const failures = [];
const notes = [];
const results = { started: new Date().toISOString(), scenarios: {} };
let current = '';

function log(...a) {
  console.log(`[e2e${current ? ` ${current}` : ''}]`, ...a);
}
function check(cond, msg, detail) {
  if (cond) return true;
  const line = `${current}: ${msg}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`;
  failures.push(line);
  console.log(`  FAIL ${line}`);
  return false;
}
function note(msg) {
  notes.push(`${current}: ${msg}`);
  log(`note: ${msg}`);
}
const shotPath = (name) => join(OUT, `${PREFIX}${name}.png`);
async function shot(page, name) {
  const p = shotPath(name);
  await page.screenshot({ path: p });
  log(`screenshot ${p}`);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  if (existsSync(base)) {
    for (const d of readdirSync(base).sort().reverse()) {
      const p = join(base, d, 'chrome-linux', 'chrome');
      if (/^chromium-\d+$/.test(d) && existsSync(p)) return p;
    }
  }
  return undefined; // playwright's default
}

function listMaps(dir, only) {
  if (!dir) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.bsp'))
    .map((f) => basename(f, '.bsp'))
    .filter((n) => !only || only.includes(n))
    .sort();
}

// ------------------------------------------------------------------------------------------ page helpers

/** Opens a page that records uncaught errors (they fail the run) and console errors. */
async function openPage(browser, query = '') {
  const page = await browser.newPage({ viewport: VIEW });
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log(`  [pageerror] ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto(`${base}?autotest=1${query ? `&${query}` : ''}`);
  await page.waitForFunction(() => !!window.__surf, null, { timeout: 60000 });
  return { page, errors, consoleErrors };
}

const st = (page) => page.evaluate(() => window.__surf.state());

async function waitPlaying(page, timeout = 300000) {
  await page.waitForFunction(() => window.__surf?.state().state === 'playing', null, { timeout, polling: 100 });
}

/** Polls `fn` (evaluated in the page) until it returns truthy or the timeout passes; returns its last value. */
async function pollPage(page, fn, arg, timeout = 10000, every = 100) {
  const end = Date.now() + timeout;
  let v;
  for (;;) {
    v = await page.evaluate(fn, arg);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

const inBox = (o, z, m = 1) =>
  !!o && !!z && o.x >= z.mins.x - m && o.x <= z.maxs.x + m && o.y >= z.mins.y - m && o.y <= z.maxs.y + m && o.z >= z.mins.z - 40 && o.z <= z.maxs.z + m;

async function measureFps(page, ms = 3000) {
  return page.evaluate(
    (ms) =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const f = (t) => {
          n++;
          if (t - t0 < ms) requestAnimationFrame(f);
          else res((n * 1000) / (t - t0));
        };
        requestAnimationFrame(f);
      }),
    ms,
  );
}

async function heap(page) {
  return page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      if (typeof window.gc === 'function') window.gc();
      await new Promise((r) => setTimeout(r, 50));
    }
    const m = performance.memory;
    const info = window.__surf.renderInfo();
    return {
      heapMB: m ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : null,
      textures: info?.textures ?? null,
      geometries: info?.geometries ?? null,
      programs: info?.programs ?? null,
    };
  });
}

/** Holds a key (Playwright key name) for `ms` of real time. */
async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

// ------------------------------------------------------------------------------------------ scenarios

async function scenarioA(browser) {
  const { page, errors } = await openPage(browser);
  const r = {};
  await page.waitForSelector('.menu-screen:not(.hidden)', { timeout: 30000 });
  await sleep(800);
  await shot(page, 'a-menu');
  await page.click('nav.topnav button:has-text("Play")');
  await page.click('.browser .tab:has-text("All Maps")');
  const count = await pollPage(
    page,
    () => {
      const t = document.querySelector('.browser .result-count')?.textContent ?? '';
      return /\d+ of \d+/.test(t) ? t : '';
    },
    null,
    30000,
  );
  r.resultCount = count;
  const m = /(\d+) of (\d+)/.exec(count || '');
  r.catalogMaps = m ? Number(m[2]) : 0;
  check(r.catalogMaps === 932, 'map browser lists the 932 catalog maps', count);
  r.rows = await page.evaluate(() => document.querySelectorAll('.browser .pane-all .c-name').length);
  await sleep(300);
  await shot(page, 'a-browser-all');
  // search narrows the list
  await page.fill('.browser .search-input', 'utopia');
  const searched = await pollPage(page, () => document.querySelector('.browser .result-count')?.textContent ?? '', null, 5000);
  r.searchUtopia = searched;
  check(/^\d+ of 932$/.test(searched) && Number(searched.split(' ')[0]) < 932 && Number(searched.split(' ')[0]) > 0, 'search "utopia" filters the list', searched);
  await shot(page, 'a-browser-search');
  await page.fill('.browser .search-input', '');
  await page.click('.browser .tab:has-text("Built-in")');
  await sleep(300);
  r.builtinCards = await page.evaluate(() => [...document.querySelectorAll('.browser .builtin-card .card-name')].map((e) => e.textContent));
  check(r.builtinCards.length === 3, 'built-in tab shows 3 maps', r.builtinCards);
  await shot(page, 'a-browser-builtin');
  check(errors.length === 0, 'no uncaught page errors', errors);
  results.scenarios.a = r;
  return page; // scenario b continues from the built-in tab
}

async function scenarioB(browser, menuPage) {
  const r = {};
  const ids = ['surf_tutorial', 'surf_neon', 'surf_skyline'];
  const ctx = menuPage ? { page: menuPage, errors: [] } : await openPage(browser);
  const page = ctx.page;
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  for (const id of ids) {
    const m = {};
    r[id] = m;
    const t0 = Date.now();
    if (id === ids[0] && menuPage) {
      // through the UI: the built-in card
      await page.click(`.browser .builtin-card:has-text("${id}")`);
    } else {
      await page.evaluate((id) => void window.__surf.loadBuiltin(id), id);
    }
    await waitPlaying(page, 60000);
    m.loadMs = Date.now() - t0;
    await sleep(500);
    let s = await st(page);
    const zones = await page.evaluate(() => window.__surf.zones());
    const start = zones.find((z) => z.type === 'start' && z.group === 0);
    m.zones = zones.length;
    m.spawn = s.origin;
    check(!!start, `${id}: has a main start zone`);
    check(s.timer?.state === 'startzone', `${id}: timer in start zone at spawn`, s.timer?.state);
    check(inBox(s.origin, start), `${id}: player spawns inside the start zone`, { origin: s.origin, start });
    check(!(await page.evaluate(() => window.__surf.inSolid())), `${id}: not in solid at spawn`);
    await shot(page, `b-${id}-spawn`);
    // keyboard input moves the player (real-time frames, W held; software rendering runs at a few fps, so poll)
    const o0 = s.origin;
    await page.keyboard.down('w');
    const moved = await pollPage(
      page,
      (o0) => {
        const o = window.__surf.state().origin;
        const d = Math.hypot(o.x - o0.x, o.y - o0.y);
        return d > 30 ? d : 0;
      },
      o0,
      15000,
    );
    m.walked = r1(moved || 0);
    check(moved > 30, `${id}: holding W moves the player`, r1(moved || 0));
    // keep running until the timer starts (left the start zone)
    let running = await pollPage(page, () => window.__surf.state().timer?.state === 'running', null, 40000);
    if (!running) {
      // the spawn may face a wall: aim at the course (away from the start zone centre)
      s = await st(page);
      const cx = (start.mins.x + start.maxs.x) / 2;
      const cy = (start.mins.y + start.maxs.y) / 2;
      note(`${id}: W from spawn didn't leave the start zone; steering away from the zone centre`);
      await page.evaluate(([y]) => window.__surf.setAngles(0, y), [(Math.atan2(s.origin.y - cy, s.origin.x - cx) * 180) / Math.PI]);
      running = await pollPage(page, () => window.__surf.state().timer?.state === 'running', null, 40000);
    }
    check(!!running, `${id}: leaving the start zone starts the timer`);
    await sleep(700);
    s = await st(page);
    m.timerAfterLeave = s.timer?.time;
    m.speedAfterLeave = r1(s.speed);
    await shot(page, `b-${id}-running`);
    await page.keyboard.up('w');
    // fail: drop into the trigger_teleport under the player (the fail floor of this section)
    const trig = await page.evaluate(() => window.__surf.triggers());
    const here = (await st(page)).origin;
    const tps = trig.filter((t) => t.enabled && /teleport/.test(t.classname));
    m.teleportTriggers = tps.length;
    const below = tps.filter((t) => here.x >= t.mins.x && here.x <= t.maxs.x && here.y >= t.mins.y && here.y <= t.maxs.y && t.maxs.z < here.z);
    below.sort((a, b) => b.maxs.z - a.maxs.z);
    const fail = below[0];
    if (check(!!fail, `${id}: has a fail trigger_teleport`)) {
      const p = { x: (fail.mins.x + fail.maxs.x) / 2, y: (fail.mins.y + fail.maxs.y) / 2, z: Math.max(fail.mins.z, (fail.mins.z + fail.maxs.z) / 2 - 36) };
      await page.evaluate((p) => window.__surf.teleport(p.x, p.y, p.z), p);
      const back = await pollPage(
        page,
        (p) => {
          const o = window.__surf.state().origin;
          return o && Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z) > 128 ? o : null;
        },
        p,
        5000,
      );
      check(!!back, `${id}: falling into the fail trigger teleports the player back`);
      s = await st(page);
      m.afterFail = { state: s.timer?.state, origin: s.origin, inSolid: await page.evaluate(() => window.__surf.inSolid()) };
      check(!m.afterFail.inSolid, `${id}: not in solid after the fail teleport`);
      check(s.timer?.state === 'running' || s.timer?.state === 'startzone', `${id}: timer still running (or back at the start) after failing`, s.timer?.state);
      await sleep(300);
      await shot(page, `b-${id}-after-fail`);
    }
    // !r: back to the start zone, timer reset
    await page.evaluate(() => window.__surf.say('!r'));
    await sleep(300);
    s = await st(page);
    check(s.timer?.state === 'startzone' && inBox(s.origin, start), `${id}: !r returns to the start zone`, { state: s.timer?.state, origin: s.origin });
  }
  check(pageErrors.length === 0, 'no uncaught page errors', pageErrors);
  results.scenarios.b = r;
  await page.close();
}

async function loadRealMap(page, name) {
  const t0 = Date.now();
  await page.evaluate((url) => void window.__surf.loadUrl(url), `/__maps/${name}.bsp`);
  await waitPlaying(page, 600000);
  return Date.now() - t0;
}

async function scenarioC(browser, maps) {
  const r = {};
  for (const name of maps) {
    const m = {};
    r[name] = m;
    log(`loading ${name}`);
    const t0 = Date.now();
    const { page, errors, consoleErrors } = await openPage(browser, `bsp=/__maps/${encodeURIComponent(name)}.bsp`);
    try {
      await waitPlaying(page, 600000);
    } catch (e) {
      check(false, `${name}: map loads`, String(e).slice(0, 200));
      await shot(page, `c-${name}-load-failed`);
      await page.close();
      continue;
    }
    m.loadMs = Date.now() - t0;
    await sleep(1500); // the welcome chat, textures settling
    const s = await st(page);
    const zones = await page.evaluate(() => window.__surf.zones());
    const start = zones.find((z) => z.type === 'start' && z.group === 0);
    m.zones = zones.length;
    m.zoneTypes = [...new Set(zones.map((z) => z.type))];
    m.spawn = s.origin;
    m.timerState = s.timer?.state;
    m.inStartZone = inBox(s.origin, start);
    m.inSolid = await page.evaluate(() => window.__surf.inSolid());
    check(!!start, `${name}: has a main start zone`);
    check(m.inStartZone && s.timer?.state === 'startzone', `${name}: spawns in the start zone`, { state: s.timer?.state, origin: s.origin, start });
    check(!m.inSolid, `${name}: not stuck in solid at spawn`);
    const info = await page.evaluate(() => window.__surf.renderInfo());
    m.render = info && {
      s3tc: info.s3tc,
      textures: info.textures,
      programs: info.programs,
      sky: info.sky,
      faces: info.faces?.audit ? { inverted: info.faces.audit.inverted, correct: info.faces.audit.correct, invertedAreaPct: r1((100 * info.faces.audit.invertedArea) / (info.faces.audit.invertedArea + info.faces.audit.correctArea)), doubleSided: info.faces.doubleSided } : null,
    };
    if (info?.faces?.audit) {
      const a = info.faces.audit;
      check(a.invertedArea / (a.invertedArea + a.correctArea) < 0.05 && !info.faces.doubleSided, `${name}: <5% of the face area inverted, single-sided culling`, m.render.faces);
    }
    m.fps = r1(await measureFps(page, 2500));
    const stats = await page.evaluate(() => window.__surf.game.renderer.stats());
    m.drawCalls = stats.drawCalls;
    m.triangles = stats.triangles;
    await shot(page, `c-${name}-spawn`);
    // viewpoints: turn around at the spawn, then fly to the biggest ramps (noclip: hovering camera)
    const yaw0 = s.angles.yaw;
    for (const turn of [90, 180]) {
      await page.evaluate((y) => window.__surf.setAngles(5, y), yaw0 + turn);
      await sleep(400);
      await shot(page, `c-${name}-spawn-yaw${turn}`);
    }
    const ramps = await page.evaluate(() => window.__surf.findRamps(6));
    m.ramps = ramps.length;
    await page.evaluate(() => window.__surf.exec('noclip'));
    let vp = 0;
    for (const ramp of ramps.slice(0, 2)) {
      // stand back from the ramp face, level with its middle, looking at it
      const hx = ramp.normal.x;
      const hy = ramp.normal.y;
      const hl = Math.hypot(hx, hy) || 1;
      const dist = 700;
      const eye = { x: ramp.center.x + (hx / hl) * dist, y: ramp.center.y + (hy / hl) * dist, z: ramp.center.z + 120 };
      await page.evaluate((e) => window.__surf.teleport(e.x, e.y, e.z - 64), eye);
      const yaw = (Math.atan2(-hy, -hx) * 180) / Math.PI;
      const pitch = (Math.atan2(eye.z - ramp.center.z, dist) * 180) / Math.PI;
      await page.evaluate(([p, y]) => window.__surf.setAngles(p, y), [pitch, yaw]);
      await sleep(500);
      await shot(page, `c-${name}-ramp${++vp}`);
    }
    await page.evaluate(() => window.__surf.say('/r'));
    m.pageErrors = errors.length;
    m.consoleErrors = consoleErrors.slice(0, 5);
    check(errors.length === 0, `${name}: no uncaught page errors`, errors);
    log(`${name}: load ${m.loadMs} ms, fps ${m.fps}, zones ${m.zones} ${m.zoneTypes.join('/')}, draw calls ${m.drawCalls}`);
    await page.close();
  }
  results.scenarios.c = r;
}

/** Surfs ramp candidates deterministically (paused game, runTicks); returns the per-ramp results. */
async function surfRamps(page, name, maxRamps = 4) {
  const ramps = await page.evaluate(() => window.__surf.findRamps(40));
  const out = [];
  await page.evaluate(() => window.__surf.pause());
  for (const ramp of ramps) {
    if (out.length >= maxRamps) break;
    // only long ramps (room to surf for 2 s)
    if (ramp.area < 200000) continue;
    const res = await page.evaluate((ramp) => {
      const S = window.__surf;
      const n = ramp.normal;
      const hl = Math.hypot(n.x, n.y) || 1;
      const tx = -n.y / hl;
      const ty = n.x / hl;
      const rr = 16 * Math.abs(n.x) + 16 * Math.abs(n.y) + 36 * Math.abs(n.z);
      // hull centre just off the face, a bit above the face centre
      const c = { x: ramp.center.x + n.x * (rr + 1), y: ramp.center.y + n.y * (rr + 1), z: ramp.center.z + n.z * (rr + 1) };
      S.releaseAll();
      if (S.state().moveType !== 2) S.exec('noclip'); // back to MOVETYPE_WALK
      S.teleport(c.x, c.y, c.z - 36);
      if (S.inSolid()) return { skipped: 'in solid at start' };
      const yaw = (Math.atan2(ty, tx) * 180) / Math.PI;
      S.setAngles(0, yaw);
      S.setVelocity(tx * 700, ty * 700, 0);
      // strafe into the ramp: right = (sin yaw, -cos yaw) = (ty, -tx); into the ramp = -n
      const rightInto = ty * -n.x + -tx * -n.y > 0;
      S.press(rightInto ? 'moveright' : 'moveleft');
      const speeds = [];
      let maxSpeed = 0;
      let inSolid = 0;
      let stuck = 0;
      let slowRun = 0;
      let ground = 0;
      const o0 = S.state().origin;
      let ticks = 0;
      for (let i = 0; i < 250; i++) {
        if (S.runTicks(1) !== 1) break;
        ticks++;
        const s = S.state();
        const v = s.velocity;
        const sp = Math.hypot(v.x, v.y, v.z);
        speeds.push(sp);
        if (sp > maxSpeed) maxSpeed = sp;
        if (S.inSolid()) inSolid++;
        if (s.onGround) ground++;
        slowRun = sp < 30 ? slowRun + 1 : 0;
        if (slowRun > 15) stuck++;
        // left the ramp (flew off / landed somewhere): stop measuring
        if (s.origin.z < ramp.minZ - 400) break;
      }
      S.release(rightInto ? 'moveright' : 'moveleft');
      const o1 = S.state().origin;
      return {
        start: o0,
        ticks,
        startSpeed: 700,
        maxSpeed: Math.round(maxSpeed),
        speedAt100: Math.round(speeds[Math.min(99, speeds.length - 1)] ?? 0),
        endSpeed: Math.round(speeds[speeds.length - 1] ?? 0),
        dropped: Math.round(o0.z - o1.z),
        travelled: Math.round(Math.hypot(o1.x - o0.x, o1.y - o0.y)),
        inSolid,
        stuck,
        groundTicks: ground,
        normalZ: Math.round(n.z * 1000) / 1000,
      };
    }, ramp);
    if (res.skipped) continue;
    out.push(res);
  }
  await page.evaluate(() => {
    window.__surf.say('/r');
    window.__surf.resume();
  });
  return out;
}

async function scenarioD(browser, maps) {
  const r = {};
  const want = ['surf_utopia_njv', 'surf_kitsune', 'surf_beginner', 'surf_mesa_fixed'].filter((m) => maps.includes(m));
  for (const name of want) {
    const { page, errors } = await openPage(browser, `bsp=/__maps/${name}.bsp`);
    await waitPlaying(page, 600000);
    await sleep(500);
    const runs = await surfRamps(page, name);
    r[name] = runs;
    check(runs.length > 0, `${name}: found surfable ramps`);
    let gained = 0;
    for (const [i, run] of runs.entries()) {
      log(`${name} ramp ${i + 1}: nz ${run.normalZ} ticks ${run.ticks} speed 700 -> max ${run.maxSpeed} (end ${run.endSpeed}), dropped ${run.dropped}, travelled ${run.travelled}, inSolid ${run.inSolid}, stuck ${run.stuck}, ground ${run.groundTicks}`);
      check(run.inSolid === 0, `${name} ramp ${i + 1}: never in solid`, run.inSolid);
      check(run.stuck === 0, `${name} ramp ${i + 1}: never stuck`, run.stuck);
      check(run.groundTicks <= 2, `${name} ramp ${i + 1}: surfing, not standing on the ramp`, run.groundTicks);
      if (run.maxSpeed > run.startSpeed * 1.1) gained++;
    }
    check(gained > 0, `${name}: speed builds up while surfing down a ramp`, runs.map((x) => x.maxSpeed));
    // real-time: surf a bit and take a picture
    const ramp = (await page.evaluate(() => window.__surf.findRamps(1)))[0];
    if (ramp) {
      await page.evaluate((ramp) => {
        const S = window.__surf;
        const n = ramp.normal;
        const hl = Math.hypot(n.x, n.y) || 1;
        const tx = -n.y / hl;
        const ty = n.x / hl;
        const rr = 16 * Math.abs(n.x) + 16 * Math.abs(n.y) + 36 * Math.abs(n.z);
        S.teleport(ramp.center.x + n.x * (rr + 1), ramp.center.y + n.y * (rr + 1), ramp.center.z + n.z * (rr + 1) - 36);
        const yaw = (Math.atan2(ty, tx) * 180) / Math.PI;
        S.setAngles(8, yaw);
        S.setVelocity(tx * 900, ty * 900, 0);
        S.press(ty * -n.x + -tx * -n.y > 0 ? 'moveright' : 'moveleft');
      }, ramp);
      await sleep(600);
      await shot(page, `d-${name}-surfing`);
      await page.evaluate(() => window.__surf.releaseAll());
    }
    check(errors.length === 0, `${name}: no uncaught page errors`, errors);
    await page.close();
  }
  results.scenarios.d = r;
}

async function scenarioE(browser) {
  const r = {};
  const { page, errors } = await openPage(browser, 'builtin=surf_tutorial');
  await waitPlaying(page, 60000);
  await sleep(800);
  const chatCount = () => page.evaluate(() => document.querySelectorAll('.chat-msg').length);
  const chatText = () => page.evaluate(() => [...document.querySelectorAll('.chat-msg')].map((e) => e.textContent ?? ''));
  // ---- chat: messagemode (Y), !help
  const before = await chatCount();
  await page.keyboard.press('y');
  const open = await pollPage(page, () => document.querySelector('.chat')?.classList.contains('open'), null, 3000);
  check(!!open, 'Y opens the chat input');
  await sleep(100);
  await page.keyboard.type('!help');
  await shot(page, 'e-chat-typing');
  await page.keyboard.press('Enter');
  await sleep(300);
  const after = await chatCount();
  r.helpLines = after - before;
  check(after - before >= 2, '!help answers in the chat', after - before);
  check(!(await page.evaluate(() => document.querySelector('.chat')?.classList.contains('open'))), 'Enter closes the chat input');
  // typed while the chat was open: the game must not have moved (y/!help typed letters aren't binds)
  // ---- a normal chat line is echoed
  await page.keyboard.press('y');
  await sleep(100);
  await page.keyboard.type('hello from e2e');
  await page.keyboard.press('Enter');
  await sleep(200);
  check((await chatText()).some((t) => t.includes('hello from e2e')), 'a chat line is shown in the feed');
  // ---- /r is silent, !r echoes
  let s = await st(page);
  const n0 = await chatCount();
  await page.evaluate(() => window.__surf.say('/r'));
  await sleep(200);
  const lines = (await chatText()).slice(n0);
  check(!lines.some((t) => /: \/r$|: !r$/.test(t)), '/r restarts silently (no echo)', lines);
  // ---- !noclip / !r
  await page.evaluate(() => window.__surf.say('!noclip'));
  s = await st(page);
  r.noclip = { moveType: s.moveType, practice: s.practice };
  check(s.practice === true, '!noclip enters practice mode', s);
  await page.evaluate(() => window.__surf.say('!r'));
  await sleep(200);
  s = await st(page);
  check(s.timer?.state === 'startzone' && !s.practice, '!r leaves practice and returns to the start', { state: s.timer?.state, practice: s.practice });
  // ---- console: ` opens it, cvars and commands work
  await page.keyboard.press('Backquote');
  const conOpen = await pollPage(page, () => {
    const i = document.querySelector('.devcon-input');
    return !!i && document.activeElement === i;
  }, null, 3000);
  check(!!conOpen, '` opens the console with the input focused');
  const conOut = () => page.evaluate(() => document.querySelector('.devcon-output')?.textContent ?? '');
  const runCon = async (line) => {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
    await sleep(150);
  };
  await runCon('sv_airaccelerate');
  check(/sv_airaccelerate.*150/.test(await conOut()), 'console prints sv_airaccelerate 150');
  await runCon('cl_showpos 1');
  await runCon('getpos');
  check(/setpos/.test(await conOut()), 'getpos prints a setpos line');
  await runCon('bind f6 toggleconsole');
  await shot(page, 'e-console');
  // F6 (bound to toggleconsole) closes the console like `
  await page.keyboard.press('F6');
  const closedByF6 = await pollPage(page, () => !document.querySelector('.devcon-input') || document.activeElement !== document.querySelector('.devcon-input'), null, 2000);
  const conVisible = () => page.evaluate(() => {
    const el = document.querySelector('.devcon-input')?.closest('[class*="devcon"]')?.parentElement;
    const c = document.querySelector('.devcon-output');
    return !!c && c.getBoundingClientRect().height > 0 && getComputedStyle(c).visibility !== 'hidden' && !!c.offsetParent;
  });
  check(!!closedByF6 && !(await conVisible()), 'a key bound to toggleconsole (F6) closes the console');
  await page.keyboard.press('F6');
  await sleep(200);
  check(await conVisible(), 'F6 opens the console again');
  await page.keyboard.press('Backquote');
  await sleep(200);
  check(!(await conVisible()), '` closes the console');
  await page.evaluate(() => window.__surf.exec('unbind f6'));
  r.showpos = await page.evaluate(() => {
    const e = document.querySelector('.hud-pos');
    return !!e && !e.classList.contains('hidden') ? e.textContent : null;
  });
  check(!!r.showpos, 'cl_showpos 1 shows the position on the HUD', r.showpos);
  await shot(page, 'e-hud-showpos');
  await page.evaluate(() => window.__surf.exec('cl_showpos 0'));
  // ---- tab scoreboard
  await page.keyboard.down('Tab');
  await sleep(300);
  const sb = await page.evaluate(() => {
    const e = document.querySelector('.scoreboard');
    return !!e && e.getBoundingClientRect().height > 0 && !e.classList.contains('hidden');
  });
  await shot(page, 'e-scoreboard');
  await page.keyboard.up('Tab');
  check(sb, 'Tab shows the scoreboard');
  // ---- Escape pauses, the pause menu's Resume resumes
  await page.keyboard.press('Escape');
  await sleep(300);
  s = await st(page);
  check(s.state === 'paused', 'Escape opens the pause menu', s.state);
  await shot(page, 'e-pause');
  await page.keyboard.press('Escape');
  await sleep(300);
  s = await st(page);
  check(s.state === 'playing', 'Escape resumes', s.state);
  check(errors.length === 0, 'no uncaught page errors', errors);
  results.scenarios.e = r;
  await page.close();
}

async function scenarioF(browser, maps) {
  const r = { steps: [] };
  const real = ['surf_kitsune', 'surf_beginner', 'surf_utopia_njv'].filter((m) => maps.includes(m));
  const { page, errors } = await openPage(browser);
  const seq = [['builtin', 'surf_tutorial'], ...real.map((m) => ['bsp', m]), ...(real[0] ? [['bsp', real[0]]] : []), ['builtin', 'surf_tutorial']];
  for (const [kind, name] of seq) {
    const t0 = Date.now();
    if (kind === 'builtin') {
      await page.evaluate((id) => void window.__surf.loadBuiltin(id), name);
      await waitPlaying(page, 60000);
    } else await loadRealMap(page, name);
    const ms = Date.now() - t0;
    await sleep(800);
    const h = await heap(page);
    const s = await st(page);
    r.steps.push({ map: name, loadMs: ms, ...h, state: s.state });
    log(`switch -> ${name}: ${ms} ms, heap ${h.heapMB} MB, textures ${h.textures}, geometries ${h.geometries}, programs ${h.programs}`);
    check(s.state === 'playing' && s.mapName === name, `switch to ${name}`, s.mapName);
  }
  // the second load of the same map must not hold more than the first (+ slack)
  const same = (name) => r.steps.filter((x) => x.map === name);
  for (const name of new Set(seq.map((x) => x[1]))) {
    const v = same(name);
    if (v.length < 2) continue;
    const [a, b] = [v[0], v[v.length - 1]];
    if (a.heapMB !== null) check(b.heapMB <= a.heapMB * 1.25 + 20, `${name}: no JS heap growth across map switches`, `${a.heapMB} -> ${b.heapMB} MB`);
    check(b.textures <= a.textures + 2 && b.geometries <= a.geometries + 2, `${name}: no GPU resource growth across map switches`, { first: a, last: b });
  }
  await page.evaluate(() => window.__surf.game.disconnect());
  await sleep(300);
  const menu = await heap(page);
  r.menu = menu;
  log(`back in the menu: heap ${menu.heapMB} MB, textures ${menu.textures}, geometries ${menu.geometries}`);
  check(errors.length === 0, 'no uncaught page errors', errors);
  results.scenarios.f = r;
  await page.close();
}

// ------------------------------------------------------------------------------------------ main

let base = '';
let server = null;
let browser = null;

async function main() {
  const { createServer } = await import('vite');
  server = await createServer({
    root: ROOT,
    configFile: join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    // no HMR / file watching: other work in the tree must not reload the page under test
    server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: { ignored: ['**/*'] } },
  });
  await server.listen();
  const addr = server.httpServer.address();
  base = `http://127.0.0.1:${addr.port}/`;
  log(`dev server ${base}; maps: ${MAPS_DIR ?? '(none: real-map scenarios skipped)'}`);
  const { chromium } = await import('playwright-core');
  const executablePath = findChromium();
  browser = await chromium.launch({
    executablePath,
    headless: !process.env.E2E_HEADFUL,
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  log(`chromium ${browser.version()} (${executablePath ?? 'playwright default'})`);

  const only = process.env.E2E_MAPS ? process.env.E2E_MAPS.split(',').map((s) => s.trim()) : null;
  const maps = listMaps(MAPS_DIR, only);
  const large = process.env.E2E_LARGE ? listMaps(LARGE_DIR, only) : [];
  const run = async (id, fn) => {
    if (!ONLY.has(id)) return;
    current = id;
    const t0 = Date.now();
    log('---- start');
    try {
      return await fn();
    } catch (e) {
      check(false, 'scenario crashed', String(e?.stack ?? e).slice(0, 600));
    } finally {
      log(`---- done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
  };
  const menuPage = await run('a', () => scenarioA(browser));
  await run('b', () => scenarioB(browser, ONLY.has('a') ? menuPage : null));
  if (maps.length) {
    await run('c', () => scenarioC(browser, [...maps, ...large]));
    await run('d', () => scenarioD(browser, maps));
  } else if (ONLY.has('c') || ONLY.has('d')) note('SURF_TEST_MAPS not set: scenarios c and d skipped');
  await run('e', () => scenarioE(browser));
  if (maps.length) await run('f', () => scenarioF(browser, maps));
  current = '';
}

let code = 0;
try {
  await main();
} catch (e) {
  console.error(e);
  failures.push(`setup: ${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  await browser?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
}
results.failures = failures;
results.notes = notes;
results.finished = new Date().toISOString();
writeFileSync(join(OUT, `${PREFIX}results.json`), JSON.stringify(results, null, 2));
console.log(`\n[e2e] results: ${join(OUT, `${PREFIX}results.json`)}`);
if (notes.length) console.log(`[e2e] notes:\n  ${notes.join('\n  ')}`);
if (failures.length) {
  console.log(`[e2e] ${failures.length} FAILED:\n  ${failures.join('\n  ')}`);
  code = 1;
} else console.log('[e2e] all checks passed');
process.exit(code);
