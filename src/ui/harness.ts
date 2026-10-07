// UI harness (ui-harness.html): runs the real Ui + SoundSystem against MockGame, with a painted fake game view.
// Scenes for screenshots: ?scene=menu|browser-featured|browser-all|loading|loading-error|hud|hud-start|chat|
// console|settings-crosshair|settings-binds|scoreboard|pause   (&t=<seconds> freezes the HUD clock)
import { console_, conPrint } from '../core/cvars';
import { SoundSystem } from '../audio/audio';
import { loadCatalog } from '../maps/catalog';
import { demoChatLines, MockGame } from './mockgame';
import { MenuBackground, type MenuBgTheme } from './menubg';
import { Ui } from './ui';

const DAY_THEME: MenuBgTheme = {
  skyTop: '#2f6fb8',
  skyMid: '#6aa6dc',
  horizon: '#cfe5f6',
  glow: 'rgba(255, 245, 220, 0.35)',
  rampLit: [190, 196, 204],
  rampDark: [104, 114, 128],
  edge: 'rgba(255, 255, 255, 0.9)',
  fog: [196, 222, 242],
};

declare global {
  interface Window {
    __harness?: {
      ui: Ui;
      game: MockGame;
      scene: (name: string) => Promise<void>;
      ready: boolean;
      cv: (name: string) => string | undefined;
      bindOf: (key: string) => string | null;
    };
  }
}

async function seedCache(names: string[]): Promise<void> {
  // mark a few maps as downloaded in the same IndexedDB the downloader uses (harness only)
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.open('surf-maps', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('bsp')) req.result.createObjectStore('bsp', { keyPath: 'name' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('bsp', 'readwrite');
        for (const n of names) tx.objectStore('bsp').put({ name: n, data: new ArrayBuffer(16), size: 16, date: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const frozen = params.has('t') ? parseFloat(params.get('t')!) : null;
  const app = document.getElementById('app')!;
  // fake game view behind the HUD
  const view = document.createElement('div');
  view.id = 'game-view';
  view.style.cssText = 'position:absolute;inset:0';
  app.appendChild(view);
  const bg = new MenuBackground(view, DAY_THEME);
  bg.still = true;
  bg.step(3.2);
  bg.start();
  const canvas = bg.canvas;
  canvas.id = 'game-canvas';
  canvas.classList.remove('menu-bg-canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  bg.resize();
  const uiRoot = document.createElement('div');
  uiRoot.id = 'ui-root';
  app.appendChild(uiRoot);

  const sound = new SoundSystem();
  const ui = new Ui(uiRoot, sound);
  ui.lockHintEnabled = params.get('scene') === 'lockhint';
  const game = new MockGame(ui, { frozenTime: frozen });
  ui.attachGame(game);
  conPrint('SURF UI harness — MockGame attached', 'info');
  conPrint('Type cvarlist, find crosshair, bind, help …');

  await seedCache(['surf_utopia_njv', 'surf_kitsune', 'surf_beginner']);
  try {
    await loadCatalog();
  } catch (e) {
    console.warn('catalog unavailable', e);
  }

  const loop = () => {
    if (game.state === 'playing' || game.state === 'paused') ui.updateHud(game.getHud());
    else ui.updateHud({ ...game.getHud(), visible: false });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const startGame = (map = 'surf_utopia_njv') => {
    game.mapName = map;
    game.setState('playing');
    ui.setLoading(null);
  };
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const scene = async (name: string) => {
    await ui.browser.ensureData();
    await ui.browser.refreshCached();
    switch (name) {
      case 'menu':
        game.disconnect();
        ui.mainMenu.setPage('home', false);
        break;
      case 'browser-featured':
        game.disconnect();
        ui.mainMenu.setPage('play', false);
        ui.browser.show('featured', false);
        break;
      case 'browser-all':
        game.disconnect();
        ui.mainMenu.setPage('play', false);
        ui.browser.show('all', false);
        break;
      case 'browser-builtin':
        game.disconnect();
        ui.mainMenu.setPage('play', false);
        ui.browser.show('builtin', false);
        break;
      case 'browser-local':
        game.disconnect();
        ui.mainMenu.setPage('play', false);
        ui.browser.show('local', false);
        break;
      case 'loading':
      case 'loading-error': {
        game.disconnect();
        const entry = ui.browser.findEntry('surf_utopia_njv');
        game.state = 'loading';
        ui.loading.setMap('surf_utopia_njv', entry?.tier ?? 1, entry?.type ?? 'staged', entry?.hasZones ?? true);
        ui.setLoading({ phase: 'download', message: 'Downloading 12.4 / 56.3 MB', loaded: 12.4 * 1048576, total: 56.3 * 1048576 });
        if (name === 'loading-error') ui.setLoading({ phase: 'error', message: 'Google Drive answered HTTP 429. The file may be rate-limited; try again later.' });
        break;
      }
      case 'lockhint':
      case 'hint':
      case 'hud':
      case 'hud-start':
      case 'chat':
      case 'scoreboard':
      case 'showpos':
        startGame();
        game.timerState = name === 'hud-start' ? 'startzone' : 'running';
        if (name === 'showpos') {
          console_.execute('cl_showpos 1; cl_showfps 1');
        }
        if (name === 'chat') {
          for (const l of demoChatLines('surf_utopia_njv')) ui.chat(l);
          ui.openChat(false);
        }
        if (name === 'hud') {
          ui.chat(demoChatLines('surf_utopia_njv')[3]);
          await frame();
          game.flashSplit(-0.42);
        }
        if (name === 'scoreboard') ui.setScoreboardVisible(true);
        if (name === 'hint') {
          ui.hint('Hold A against the ramp — never press W while surfing');
          ui.centerPrint('STAGE 4');
        }
        break;
      case 'console':
        startGame();
        game.setState('paused');
        console_.execute('find crosshair');
        ui.console.show();
        await frame();
        ui.console.input.value = 'cl_cross';
        ui.console.input.dispatchEvent(new Event('input'));
        break;
      case 'settings-crosshair':
      case 'settings-binds':
      case 'settings-game':
      case 'settings-mouse':
      case 'settings-video':
      case 'settings-hud':
      case 'settings-audio':
        game.disconnect();
        ui.mainMenu.setPage('settings', false);
        ui.settings.show(name.slice('settings-'.length) as never, false);
        break;
      case 'pause':
        startGame();
        game.setState('paused');
        break;
      case 'pause-maps':
      case 'pause-settings':
        startGame();
        game.setState('paused');
        ui.pauseMenu.setPage(name === 'pause-maps' ? 'maps' : 'settings', false);
        break;
      case 'help':
      case 'about':
        game.disconnect();
        ui.mainMenu.setPage(name, false);
        break;
      default:
        break;
    }
    await frame();
  };

  // emulate the game's key binds (game-core's input layer does this in the real app)
  window.addEventListener('keydown', (e) => {
    if (ui.isTyping() || e.repeat) return;
    if (game.state !== 'playing') return;
    switch (e.code) {
      case 'KeyY':
        e.preventDefault();
        ui.openChat(false);
        break;
      case 'KeyU':
        e.preventDefault();
        ui.openChat(true);
        break;
      case 'Backquote':
        e.preventDefault();
        ui.toggleConsole();
        break;
      case 'Tab':
        e.preventDefault();
        ui.setScoreboardVisible(true);
        break;
      case 'Escape':
        game.pause();
        break;
      case 'KeyR':
        game.say('!r');
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Tab') ui.setScoreboardVisible(false);
  });

  window.__harness = { ui, game, scene, ready: true, cv: (n) => console_.getCvar(n)?.value, bindOf: (k) => game.bindOf(k) };
  const s = params.get('scene');
  if (s) await scene(s);
}

void main();
