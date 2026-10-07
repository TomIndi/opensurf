// Bootstrap: creates the renderer, audio, UI and game and wires them together.
import { SoundSystem } from './audio/audio';
import { Game } from './game/game';
import { Renderer } from './render/renderer';
import { Ui } from './ui/ui';

function fatal(message: string, err?: unknown): void {
  console.error(message, err);
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b0e13;color:#e6e9ef;font:16px system-ui,sans-serif;text-align:center;padding:24px;z-index:99999';
  el.textContent = message;
  document.body.appendChild(el);
}

function main(): void {
  const root = document.getElementById('app') ?? document.body;
  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas';
  canvas.tabIndex = 0;
  root.appendChild(canvas);
  const uiRoot = document.createElement('div');
  uiRoot.id = 'ui-root';
  root.appendChild(uiRoot);

  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    fatal('SURF needs WebGL 2. Enable hardware acceleration or try another browser.', e);
    return;
  }
  const sound = new SoundSystem();
  const ui = new Ui(uiRoot, sound);
  const game = new Game({ renderer, ui, sound, canvas });
  ui.attachGame(game);
  game.start();
}

main();
