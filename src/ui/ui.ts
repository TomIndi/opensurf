// The UI layer: implements UiApi for the game (HUD, chat, hints, loading, menus, console, scoreboard) and drives
// the menus, map browser and settings. Plain TypeScript DOM; styles live in src/styles/*.css.
import '../styles/base.css';
import '../styles/menu.css';
import '../styles/browser.css';
import '../styles/loading.css';
import '../styles/hud.css';
import '../styles/console.css';
import '../styles/settings.css';

import { console_, registerCommand } from '../core/cvars';
import type { ChatSegment, GameApi, HudState, LoadProgress, SoundApi, UiApi } from '../game/api';
import { getCatalogEntry } from '../maps/catalog';
import { Chat } from './chat';
import { cvarBool, cvarNum, ensureUiCvars } from './cvardefs';
import { DevConsole } from './devconsole';
import { h, isTextInput } from './dom';
import { Hud } from './hud';
import { icon } from './icons';
import { LoadingScreen } from './loading';
import { MainMenu } from './mainmenu';
import { MapBrowser } from './mapbrowser';
import { PauseMenu } from './pausemenu';
import { Scoreboard } from './scoreboard';
import { Settings } from './settings';

type MenuMode = 'main' | 'pause' | 'none';
type ToastKind = 'info' | 'error' | 'success';

export class Ui implements UiApi {
  private game: GameApi | null = null;
  readonly root: HTMLElement;
  readonly hud: Hud;
  readonly chatBox: Chat;
  readonly scoreboard: Scoreboard;
  readonly loading: LoadingScreen;
  readonly console: DevConsole;
  readonly browser: MapBrowser;
  readonly settings: Settings;
  readonly mainMenu: MainMenu;
  readonly pauseMenu: PauseMenu;
  private readonly toasts: HTMLElement;
  private readonly dropOverlay: HTMLElement;
  private readonly modalHost: HTMLElement;
  private modalClose: ((v: boolean) => void) | null = null;
  private menuMode: MenuMode = 'main';
  private lastHud: HudState | null = null;
  private pendingMap: { name: string; tier: number | null; type: string | null; hasZones: boolean } | null = null;
  private retry: (() => void) | null = null;
  private scoreboardTimer: ReturnType<typeof setInterval> | null = null;
  private dragDepth = 0;
  private wasLockedBeforeConsole = false;
  /** Show the "click to capture the mouse" prompt while playing without pointer lock. */
  lockHintEnabled = true;

  constructor(root: HTMLElement, private readonly sound: SoundApi) {
    this.root = root;
    root.classList.add('surf-ui');

    const toast = (msg: string, kind?: ToastKind) => this.toast(msg, kind);
    const confirm = (title: string, text: string, ok: string) => this.confirm(title, text, ok);

    this.hud = new Hud();
    this.chatBox = new Chat({
      // surf servers have a single team: team chat goes through say() as well
      onSay: (text) => this.game?.say(text),
      onOpenChange: (open) => {
        if (!open) this.relockIfPlaying();
      },
      playSound: () => {
        if (cvarBool('surf_chat_sounds', true)) this.sound.play('chat');
      },
    });
    this.hud.el.appendChild(this.chatBox.el);
    this.scoreboard = new Scoreboard();
    this.loading = new LoadingScreen({
      onCancel: () => this.cancelLoading(),
      onRetry: () => this.retry?.(),
    });
    this.console = new DevConsole({
      execute: (line) => {
        if (this.game) this.game.executeCommand(line);
        else console_.execute(line);
      },
      onOpenChange: (open) => this.onConsoleOpenChange(open),
    });
    this.browser = new MapBrowser({
      getGame: () => this.game,
      sound,
      toast,
      confirm,
      onLoadError: (name, message) => {
        // show it where the user is looking: on the loading screen if it is up, else as a toast
        if (this.loading.isVisible) {
          if (!this.loading.hasFailed) this.loading.update({ phase: 'error', message });
        } else this.toast(`Couldn't load ${name}: ${message}`, 'error', 7);
      },
      onLoadStart: (name, tier, retry, entry) => {
        this.pendingMap = { name, tier, type: entry?.type ?? null, hasZones: entry?.hasZones ?? false };
        this.retry = retry;
        this.loading.setMap(name, tier, entry?.type ?? null, entry?.hasZones ?? false);
      },
    });
    this.settings = new Settings({ sound, toast, confirm });
    this.mainMenu = new MainMenu({
      sound,
      browser: this.browser,
      settings: this.settings,
      openConsole: () => this.console.show(),
      quickPlay: (name, kind) => this.quickPlay(name, kind),
    });
    this.pauseMenu = new PauseMenu({
      sound,
      browser: this.browser,
      settings: this.settings,
      resume: () => this.resumeGame(),
      restart: () => {
        this.game?.say('!r');
        this.resumeGame();
      },
      disconnect: () => {
        this.sound.play('ui_back');
        this.game?.disconnect();
      },
      openConsole: () => this.console.show(),
    });
    this.toasts = h('div.toasts');
    this.dropOverlay = h('div.drop-overlay', null, h('div.drop-box', null, icon('upload'), h('div.drop-title', { text: 'Drop to play' }), h('div.muted', { text: '.bsp · .bsp.bz2 · .rar · .zip' })));
    this.modalHost = h('div.modal-layer');

    root.append(this.hud.el, this.scoreboard.el, this.mainMenu.el, this.pauseMenu.el, this.loading.el, this.console.el, this.modalHost, this.toasts, this.dropOverlay);

    this.installGlobalHandlers();
    this.showMenu('main');
  }

  // ================================================================ wiring

  attachGame(game: GameApi): void {
    this.game = game;
    ensureUiCvars();
    this.ensureCommands();
    this.hud.readConfig();
    this.settings.build();
    this.settings.refreshAll();
    game.on('statechange', () => this.syncState());
    game.on('mapload', () => {
      void this.browser.refreshCached();
      this.pendingMap = null;
    });
    // new PBs show up in the map browser
    game.on('runfinished', () => void this.browser.refreshCached());
    game.on('cvarschanged', () => {
      this.hud.readConfig();
      this.settings.refreshAll();
    });
    game.on('loadprogress', (d) => {
      const p = d as LoadProgress | undefined;
      if (p && typeof p === 'object' && 'phase' in p) this.setLoading(p);
    });
    this.syncState();
  }

  /** Registers UI-related commands the game didn't (so the console works standalone too). */
  private ensureCommands(): void {
    const add = (name: string, help: string, handler: (args: string[]) => void) => {
      if (!console_.hasCommand(name)) registerCommand({ name, help, handler });
    };
    add('toggleconsole', 'Show/hide the console', () => this.toggleConsole());
    add('showconsole', 'Show the console', () => this.console.show());
    add('hideconsole', 'Hide the console', () => this.console.close());
    add('messagemode', 'Open chat', () => this.openChat(false));
    add('messagemode2', 'Open team chat', () => this.openChat(true));
    add('clear', 'Clear the console', () => {
      console_.history.length = 0;
      this.console.rebuild();
    });
  }

  private syncState(): void {
    const g = this.game;
    if (!g) return;
    switch (g.state) {
      case 'menu':
        if (!this.loading.hasFailed) this.loading.hide();
        this.showMenu('main');
        break;
      case 'loading':
        if (!this.loading.isVisible) {
          this.prepareLoadingHeader();
          this.loading.show();
        }
        this.showMenu('none');
        break;
      case 'playing':
        this.loading.hide();
        this.showMenu('none');
        break;
      case 'paused':
        this.loading.hide();
        this.showMenu('pause');
        break;
    }
  }

  private installGlobalHandlers(): void {
    // WebAudio needs a user gesture
    const unlock = () => this.sound.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });

    window.addEventListener('keydown', (e) => this.onKeyDownCapture(e), true);

    // clicking the game view while playing captures the mouse (a map that finished loading asynchronously
    // can't take the pointer lock without a user gesture)
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || this.game?.state !== 'playing' || document.pointerLockElement || this.isTyping()) return;
      if (e.target === this.gameCanvas() || (e.target instanceof Node && !this.root.contains(e.target)) || e.target === this.root) this.requestLock();
    });

    // UI sounds via delegation
    const SOUND_SEL = '.btn, .menu-item, .tab, .topnav button, .chip, .segmented button, .bind-slot, .xh-color, .link';
    this.root.addEventListener('mouseover', (e) => {
      const t = (e.target as Element).closest?.(SOUND_SEL);
      if (t && !(e.relatedTarget instanceof Node && t.contains(e.relatedTarget))) this.sound.play('ui_hover');
    });
    this.root.addEventListener('click', (e) => {
      const t = (e.target as Element).closest?.(SOUND_SEL);
      if (t && !(t as HTMLButtonElement).disabled) this.sound.play('ui_click');
    });

    // drag & drop a map anywhere
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.dragDepth++;
      this.dropOverlay.classList.add('show');
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (!this.dragDepth) this.dropOverlay.classList.remove('show');
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.dragDepth = 0;
      this.dropOverlay.classList.remove('show');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.browser.playFile(f);
    });
  }

  private onKeyDownCapture(e: KeyboardEvent): void {
    if (this.settings.capturing) return; // the binds editor owns the keyboard
    let handled = false;
    if (e.code === 'Escape') {
      handled = this.handleEscape();
    } else if (e.code === 'Backquote' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const active = document.activeElement;
      if (this.console.isOpen) {
        this.console.close();
        handled = true;
      } else if ((!this.game || this.game.state !== 'playing') && !(active instanceof HTMLTextAreaElement) && !this.chatBox.isOpen) {
        this.console.show();
        handled = true;
      }
    } else if ((e.key === '/' && !e.ctrlKey && !e.metaKey) || ((e.ctrlKey || e.metaKey) && e.code === 'KeyF')) {
      // "/" or Ctrl+F: search maps whenever the map browser is on screen
      const active = document.activeElement;
      if (this.browser.el.isConnected && this.browser.el.offsetParent !== null && !(active instanceof HTMLElement && isTextInput(active)) && !this.console.isOpen) {
        this.browser.focusSearch();
        handled = true;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  private handleEscape(): boolean {
    if (this.modalClose) {
      this.modalClose(false);
      return true;
    }
    if (this.chatBox.isOpen) {
      this.chatBox.close();
      return true;
    }
    if (this.console.isOpen) {
      this.console.close();
      return true;
    }
    if (this.loading.isVisible) {
      this.cancelLoading();
      return true;
    }
    if (this.menuMode === 'pause') {
      if (this.pauseMenu.page !== 'root') this.pauseMenu.setPage('root');
      else this.resumeGame();
      return true;
    }
    if (this.menuMode === 'main') {
      const active = document.activeElement;
      if (active instanceof HTMLElement && isTextInput(active) && this.root.contains(active)) {
        active.blur();
        return true;
      }
      if (this.mainMenu.page !== 'home') {
        this.mainMenu.setPage('home');
        return true;
      }
    }
    return false;
  }

  // ================================================================ helpers

  private gameCanvas(): HTMLElement | null {
    return document.getElementById('game-canvas') ?? (document.querySelector('canvas:not(.menu-bg-canvas):not(.hud-crosshair):not(.xh-canvas)') as HTMLElement | null);
  }

  private requestLock(): void {
    const canvas = this.gameCanvas() as (HTMLElement & { requestPointerLock(opts?: { unadjustedMovement?: boolean }): Promise<void> | void }) | null;
    if (!canvas || document.pointerLockElement) return;
    try {
      const raw = cvarNum('m_rawinput', 1) !== 0;
      const r = canvas.requestPointerLock(raw ? { unadjustedMovement: true } : undefined);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          try {
            const r2 = canvas.requestPointerLock();
            if (r2 && typeof (r2 as Promise<void>).catch === 'function') (r2 as Promise<void>).catch(() => undefined);
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* not allowed without a gesture */
    }
  }

  private relockIfPlaying(): void {
    if (this.game?.state === 'playing' && !this.console.isOpen && !this.chatBox.isOpen) this.requestLock();
  }

  private onConsoleOpenChange(open: boolean): void {
    this.sound.play(open ? 'ui_click' : 'ui_back');
    if (open) {
      this.wasLockedBeforeConsole = !!document.pointerLockElement;
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (this.wasLockedBeforeConsole || this.game?.state === 'playing') {
      this.wasLockedBeforeConsole = false;
      this.relockIfPlaying();
    }
  }

  private resumeGame(): void {
    this.sound.play('ui_click');
    this.game?.resume();
    // resume happens on a click/key (user gesture): capture the mouse if the game didn't already
    setTimeout(() => this.relockIfPlaying(), 30);
  }

  private cancelLoading(): void {
    this.sound.play('ui_back');
    const failed = this.loading.hasFailed;
    this.loading.hide();
    this.pendingMap = null;
    if (this.game && (this.game.state === 'loading' || !failed)) this.game.disconnect();
    if (this.game?.state === 'menu' || !this.game) this.showMenu('main');
  }

  /** Fills the loading screen header from the map the UI asked for, or the game's current map name. */
  private prepareLoadingHeader(): void {
    if (this.loading.hasMap) return;
    const pm = this.pendingMap;
    const name = pm?.name ?? this.game?.mapName ?? '';
    if (!name) return;
    const entry = getCatalogEntry(name);
    this.loading.setMap(name, pm?.tier ?? entry?.tier ?? null, pm?.type ?? entry?.type ?? null, pm?.hasZones ?? entry?.hasZones ?? false);
  }

  private quickPlay(name: string, kind: 'catalog' | 'builtin'): void {
    if (!this.game) return;
    if (kind === 'builtin') {
      const m = this.browser.findBuiltin(name);
      if (m) this.browser.playBuiltin(m);
      else this.toast(`Built-in map ${name} is not available`, 'error');
      return;
    }
    void this.browser.ensureData().then(() => {
      const e = this.browser.findEntry(name);
      if (e) this.browser.playEntry(e);
      else this.toast(`${name} is not in the map catalog`, 'error');
    });
  }

  toast(msg: string, kind: ToastKind = 'info', seconds = 4.5): void {
    const el = h(`div.toast.${kind}`, null, icon(kind === 'error' ? 'warning' : kind === 'success' ? 'check' : 'info'), h('span', { text: msg }));
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 320);
    }, seconds * 1000);
  }

  confirm(title: string, text: string, ok: string): Promise<boolean> {
    this.modalClose?.(false);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        if (this.modalClose !== done) return;
        this.modalClose = null;
        backdrop.remove();
        resolve(v);
      };
      const okBtn = h('button.btn.btn-accent', { attrs: { type: 'button' }, text: ok });
      const cancel = h('button.btn.btn-ghost', { attrs: { type: 'button' }, text: 'Cancel' });
      okBtn.addEventListener('click', () => done(true));
      cancel.addEventListener('click', () => done(false));
      const backdrop = h('div.modal-backdrop', null, h('div.modal.panel', null, h('div.h-title', { text: title }), h('p', { text }), h('div.actions', null, cancel, okBtn)));
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) done(false);
      });
      this.modalClose = done;
      this.modalHost.appendChild(backdrop);
      okBtn.focus();
    });
  }

  // ================================================================ UiApi

  chat(segments: ChatSegment[]): void {
    this.chatBox.add(segments);
  }

  hint(text: string, seconds?: number): void {
    this.hud.hint(text, seconds);
  }

  centerPrint(text: string, seconds?: number): void {
    this.hud.centerPrint(text, seconds);
  }

  setLoading(p: LoadProgress | null): void {
    if (!p) {
      if (!this.loading.hasFailed) this.loading.hide();
      return;
    }
    if (!this.loading.isVisible) {
      this.prepareLoadingHeader();
      this.loading.show();
      this.showMenu('none');
    } else if (!this.loading.hasMap) this.prepareLoadingHeader();
    this.loading.update(p);
    // the loading screen itself shows the error (with Retry / Back); toast only if it is somehow hidden
    if (p.phase === 'error' && !this.loading.isVisible) this.toast(p.message || 'The map failed to load', 'error', 7);
    if (p.phase === 'done') setTimeout(() => {
      if (this.game?.state !== 'loading') this.loading.hide();
    }, 250);
  }

  showMenu(which: 'main' | 'pause' | 'none'): void {
    this.menuMode = which;
    if (which !== 'none') {
      this.settings.cancelCapture();
      // menus need the cursor: a locked pointer would send every click to the game canvas
      if (document.pointerLockElement) document.exitPointerLock();
    }
    if (which === 'main') {
      this.pauseMenu.hide();
      this.mainMenu.show();
      this.chatBox.close();
      this.setScoreboardVisible(false);
    } else if (which === 'pause') {
      this.mainMenu.hide();
      // repeated showMenu('pause') calls must not kick the user out of a sub page (settings / change map)
      if (!this.pauseMenu.isVisible) {
        const name = this.game?.mapName ?? this.lastHud?.mapName ?? null;
        const entry = name ? getCatalogEntry(name) : undefined;
        this.pauseMenu.show(name, entry?.tier ?? this.lastHud?.tier ?? null, entry?.type ?? this.lastHud?.timer.mapType ?? null, this.lastHud);
      }
      this.chatBox.close();
      this.setScoreboardVisible(false);
    } else {
      this.settings.cancelCapture();
      this.mainMenu.hide();
      this.pauseMenu.hide();
      // a menu button keeping focus would be re-activated by Space/Enter while playing (e.g. "Restart")
      const a = document.activeElement;
      if (a instanceof HTMLElement && this.root.contains(a) && !this.console.isOpen && !this.chatBox.isOpen) a.blur();
    }
  }

  isTyping(): boolean {
    if (this.console.isOpen || this.chatBox.isOpen || this.settings.capturing || this.modalClose) return true;
    const a = document.activeElement;
    return !!a && this.root.contains(a) && isTextInput(a);
  }

  toggleConsole(): void {
    this.console.toggle();
  }

  openChat(team?: boolean): void {
    const st = this.game?.state;
    if (this.game && st !== 'playing' && st !== 'paused') return;
    if (this.console.isOpen) return;
    this.chatBox.openInput(!!team);
  }

  setScoreboardVisible(visible: boolean): void {
    if (visible === this.scoreboard.isVisible) return;
    this.scoreboard.setVisible(visible);
    if (this.scoreboardTimer) clearInterval(this.scoreboardTimer);
    this.scoreboardTimer = null;
    if (visible && this.game) {
      const refresh = () => {
        try {
          if (this.game) this.scoreboard.render(this.game.getScoreboard());
        } catch {
          /* game not ready */
        }
      };
      refresh();
      this.scoreboardTimer = setInterval(refresh, 500);
    }
  }

  updateHud(hud: HudState): void {
    this.lastHud = hud;
    this.hud.update(hud);
    this.hud.setLockHint(
      this.lockHintEnabled &&
        hud.visible &&
        this.game?.state === 'playing' &&
        !document.pointerLockElement &&
        !this.console.isOpen &&
        !this.chatBox.isOpen &&
        !hud.spectating,
    );
    if (this.pauseMenu.isVisible) this.pauseMenu.renderRun(hud);
  }
}
