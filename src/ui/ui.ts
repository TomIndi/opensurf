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
import { BUILTIN_MAPS } from '../map/builtin/list';
import { getCatalogEntry } from '../maps/catalog';
import { cfgImportProblem, cfgNameForImport, countCfgCommands, loadCfg, normalizeCfgName, saveCfg } from './cfgfiles';
import { Chat } from './chat';
import { cvarBool, cvarNum, ensureUiCvars, registerUiOwnedCvars } from './cvardefs';
import { DevConsole } from './devconsole';
import { keyBoundTo } from './conutil';
import { h, isTextInput } from './dom';
import { classifyGpu, gpuAdvice, gpuName } from './gpuhint';
import { Hud } from './hud';
import { icon } from './icons';
import { codeToKeyName } from './keys';
import { LoadingScreen } from './loading';
import { PHASE_SPANS } from './loadprogress';
import { MainMenu } from './mainmenu';
import { MapBrowser } from './mapbrowser';
import { PauseMenu } from './pausemenu';
import { Scoreboard } from './scoreboard';
import { type RawInputStatus, Settings } from './settings';

type MenuMode = 'main' | 'pause' | 'none';
type ToastKind = 'info' | 'error' | 'success';

/** Map names compare case-insensitively (Source map names, catalog lookups). */
const sameMap = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Order of the load phases (to tell a new load, which starts over, from the next step of the current one). */
function phaseRank(phase: LoadProgress['phase'] | null): number {
  if (!phase) return -1;
  if (phase === 'done') return 2;
  if (phase === 'error') return 3;
  return PHASE_SPANS[phase][0];
}

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
  /** The loading screen header last shown (name|tier|type|zones), to skip redundant re-renders. */
  private headerKey = '';
  /** loadId of the last tagged progress report (LoadProgress.loadId). */
  private loadId: number | undefined = undefined;
  /** loadId of the last recovered load failure already reported. */
  private recoveredId: number | undefined = undefined;
  /** Whether the UI's own pointer-lock request got unadjusted (raw) movement; null = not tried yet. */
  private uiRawInput: boolean | null = null;
  private cfgInput: HTMLInputElement | null = null;
  private scoreboardTimer: ReturnType<typeof setInterval> | null = null;
  private dragDepth = 0;
  private wasLockedBeforeConsole = false;
  /** Show the "click to capture the mouse" prompt while playing without pointer lock. */
  lockHintEnabled = true;

  constructor(root: HTMLElement, private readonly sound: SoundApi) {
    this.root = root;
    root.classList.add('surf-ui');
    // every cvar exists before the UI first reads one and before the game runs the saved config: the documented
    // ones from the game's single definition table (registerConvars, idempotent), plus the UI's own
    ensureUiCvars();
    registerUiOwnedCvars();
    // automated sessions (?autotest=1) play without pointer lock: no "click to capture" prompt
    try {
      if (/[?&]autotest=(1|true|yes)\b/i.test(location.search)) this.lockHintEnabled = false;
    } catch {
      /* no location */
    }

    const toast = (msg: string, kind?: ToastKind) => this.toast(msg, kind);
    const confirm = (title: string, text: string, ok: string) => this.confirm(title, text, ok);

    this.hud = new Hud();
    this.chatBox = new Chat({
      onSay: (text, team) => {
        if (!this.game) return;
        // GameApi.say has no team flag: messagemode2 goes through the say_team command when the game has it
        if (team && console_.hasCommand('say_team')) this.game.executeCommand(`say_team "${text.replace(/"/g, "''")}"`);
        else this.game.say(text);
      },
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
      onRetry: () => this.retryLoad(),
    });
    this.console = new DevConsole({
      execute: (line) => this.execLine(line),
      onOpenChange: (open) => this.onConsoleOpenChange(open),
      importCfg: () => this.pickCfgFile(),
      // a pasted config is most likely an autoexec; don't suggest overwriting a saved one
      importCfgText: (text) => void this.importCfgText(text, loadCfg('autoexec') === null ? 'autoexec' : 'pasted'),
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
        // a file (no catalog entry passed) may still be a catalog map: syncLoadingHeader looks it up
        this.pendingMap = { name, tier, type: entry?.type ?? null, hasZones: entry?.hasZones ?? false };
        this.retry = retry;
        this.syncLoadingHeader(name);
      },
    });
    this.settings = new Settings({
      sound,
      toast,
      confirm,
      rawInputStatus: () => this.rawInputStatus(),
      graphicsInfo: () => this.game?.graphicsInfo?.() ?? null,
      importCfg: () => this.pickCfgFile(),
      execCfg: (name) => this.execLine(`exec ${name}`),
    });
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
        // "/r" like SourceMod's silent trigger: restarting from the menu doesn't echo "!r" into the chat
        this.game?.say('/r');
        this.resumeGame();
      },
      disconnect: () => {
        this.sound.play('ui_back');
        this.game?.disconnect();
      },
      openConsole: () => this.console.show(),
    });
    this.toasts = h('div.toasts');
    this.dropOverlay = h(
      'div.drop-overlay',
      null,
      h('div.drop-box', null, icon('upload'), h('div.drop-title', { text: 'Drop to play' }), h('div.muted', { text: '.bsp · .bsp.bz2 · .rar · .zip' }), h('div.muted.drop-sub', { text: 'or a .cfg (autoexec…) to import it' })),
    );
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
      this.retry = null;
      // a new map starts with an empty chat feed (like the engine's HUD reset on level change); the map's
      // welcome lines follow this event
      this.chatBox.clear();
      this.warnSlowGpu();
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
        // entering 'loading' always means a new load; the screen may still show the previous (failed) one
        this.beginLoad(null, true);
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
      if (f && /\.(cfg|txt)$/i.test(f.name)) void this.importCfgFile(f);
      else if (f) void this.browser.playFile(f);
    });
  }

  private onKeyDownCapture(e: KeyboardEvent): void {
    if (this.settings.capturing) return; // the binds editor owns the keyboard
    let handled = false;
    const key = e.code !== 'Backquote' && this.console.isOpen && !e.repeat ? codeToKeyName(e.code) : null;
    if (key && keyBoundTo(key, 'toggleconsole')) {
      // like Source: whatever key toggleconsole is bound to also closes the console (the input eats bound keys)
      this.console.close();
      handled = true;
    } else if (e.code === 'Escape') {
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
      else this.resumeGame(true);
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
      // browsers without the promise-returning API (and options) can't do unadjusted movement
      if (raw && !(r && typeof (r as Promise<void>).then === 'function')) this.uiRawInput = false;
      if (r && typeof (r as Promise<void>).catch === 'function') {
        if (raw) (r as Promise<void>).then(() => (this.uiRawInput = true), () => undefined);
        (r as Promise<void>).catch((err: unknown) => {
          // NotSupportedError: no unadjusted movement here; other failures (no user gesture) say nothing about it
          if (raw && (err as { name?: string } | null)?.name === 'NotSupportedError') this.uiRawInput = false;
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

  /**
   * Resumes from the pause menu. A click (the Resume button) captures the mouse right away. Escape can't: browsers
   * don't count Escape as a user gesture and use it to leave the pointer lock, so a lock requested from it is
   * refused or dropped at once (and the drop paused the game again). After Escape the next key press or click
   * captures the mouse (InputDevice), with the "click to capture" hint up meanwhile.
   */
  private resumeGame(viaEscape = false): void {
    this.sound.play('ui_click');
    this.game?.resume();
    // deferred a tick so a game that does lock in resume() wins; requestLock() skips if already locked
    if (!viaEscape) setTimeout(() => this.relockIfPlaying(), 0);
  }

  private cancelLoading(): void {
    this.sound.play('ui_back');
    const failed = this.loading.hasFailed;
    this.loading.hide();
    this.pendingMap = null;
    if (this.game && (this.game.state === 'loading' || !failed)) this.game.disconnect();
    if (this.game?.state === 'menu' || !this.game) this.showMenu('main');
  }

  /** Retry on the loading screen: the map browser's own retry for its loads, else the game's `retry` command. */
  private retryLoad(): void {
    if (this.retry) this.retry();
    else if (this.game && console_.hasCommand('retry')) this.game.executeCommand('retry');
  }

  /**
   * The map a progress report belongs to: the name on the report when the game tags it, else the map the game is
   * loading, else the one the UI asked for.
   */
  private loadName(p: LoadProgress | null): string {
    if (p?.mapName) return p.mapName;
    const g = this.game;
    if (g && g.state === 'loading' && g.mapName) return g.mapName;
    return this.pendingMap?.name ?? '';
  }

  /**
   * Shows the loading screen for a load that is starting or progressing. A new load (the game entered 'loading',
   * a new load id, progress after a failure, or another map starting over) resets the steps, the bar and the
   * error state, and the header always follows the map being loaded.
   */
  private beginLoad(p: LoadProgress | null, stateEntered = false): void {
    const name = this.loadName(p);
    if (!this.loading.isVisible) {
      if (name) {
        this.adoptLoad(name);
        this.syncLoadingHeader(name);
      } else if (!this.loading.hasMap) this.loading.setMap('', null);
      this.loading.show();
      this.showMenu('none');
      this.noteLoadId(p);
      return;
    }
    if (p?.phase === 'error') return;
    const id = this.noteLoadId(p);
    const fresh =
      stateEntered ||
      id === 'new' ||
      this.loading.hasFailed ||
      (id === 'none' && !!p && !!name && this.loading.hasMap && !sameMap(name, this.loading.currentMap) && phaseRank(p.phase) <= phaseRank(this.loading.currentPhaseName));
    if (fresh) {
      this.loading.restart();
      if (name) this.adoptLoad(name);
    }
    this.syncLoadingHeader(name);
  }

  /** A load of `name` starts: the map browser's retry and header info only apply if it is the browser's load. */
  private adoptLoad(name: string): void {
    if (this.pendingMap && sameMap(this.pendingMap.name, name)) return;
    this.pendingMap = null;
    this.retry = null;
  }

  /** Remembers a tagged report's load id: 'new' when it changed, 'same', or 'none' for untagged reports. */
  private noteLoadId(p: LoadProgress | null): 'new' | 'same' | 'none' {
    const id = p?.loadId;
    if (id === undefined) return 'none';
    const changed = id !== this.loadId;
    this.loadId = id;
    return changed ? 'new' : 'same';
  }

  /**
   * Header of the loading screen (name, tier, type, zones) for the map being loaded. Tier/type come from what the
   * UI asked for, else the catalog (also for files and URLs of catalog maps — re-checked on every report, since the
   * game may load the catalog mid-load), else the built-in map list.
   */
  private syncLoadingHeader(name: string): void {
    if (!name) return;
    const pm = this.pendingMap && sameMap(this.pendingMap.name, name) ? this.pendingMap : null;
    const entry = getCatalogEntry(name);
    const builtin = BUILTIN_MAPS.find((b) => sameMap(b.id, name) || sameMap(b.name, name));
    const tier = pm?.tier ?? entry?.tier ?? builtin?.tier ?? null;
    const type = pm?.type ?? entry?.type ?? builtin?.type ?? null;
    const hasZones = pm?.hasZones || entry?.hasZones || false;
    const key = `${name}|${tier}|${type}|${hasZones}`;
    if (key === this.headerKey && this.loading.hasMap && sameMap(this.loading.currentMap, name)) return;
    this.headerKey = key;
    this.loading.setMap(name, tier, type, hasZones);
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

  // ================================================================ console lines, config files, raw input

  /** Runs a console line through the game (its commands and aliases), or the bare console without one. */
  private execLine(line: string): void {
    if (this.game) this.game.executeCommand(line);
    else console_.execute(line);
  }

  /** Opens the file picker for importing CS:GO .cfg files. */
  private pickCfgFile(): void {
    if (!this.cfgInput) {
      const input = h('input.hidden', { attrs: { type: 'file', accept: '.cfg,.txt,text/plain', multiple: true } }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        input.value = '';
        void (async () => {
          for (const f of files) await this.importCfgFile(f);
        })();
      });
      this.root.appendChild(input);
      this.cfgInput = input;
    }
    this.cfgInput.click();
  }

  /** Imports a .cfg file: saved as surf.cfg.<name> (asks first), then offers to exec it. */
  async importCfgFile(file: File): Promise<void> {
    if (file.size > 1024 * 1024) {
      this.toast(`${file.name} is too large to be a config file`, 'error');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      this.toast(`Couldn't read ${file.name}: ${(e as Error).message}`, 'error');
      return;
    }
    await this.importCfgText(text, cfgNameForImport(file.name), file.name);
  }

  /**
   * Imports config text (a dropped/picked .cfg, or several lines pasted into the console): a dialog shows what it
   * is and lets the user run it once, save it as cfg/<name>.cfg (`exec <name>`; autoexec runs at startup) or
   * save and exec it.
   */
  importCfgText(raw: string, suggestedName: string, fileName?: string): Promise<void> {
    const text = raw.replace(/^\uFEFF/, '');
    const problem = cfgImportProblem(text);
    if (problem) {
      this.toast(`Can't import ${fileName ?? 'that config'}: ${problem}`, 'error', 6);
      return Promise.resolve();
    }
    this.modalClose?.(false);
    const commands = countCfgCommands(text);
    return new Promise((resolve) => {
      const nameInput = h('input.input.cfg-name', { attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Config name' } }) as HTMLInputElement;
      nameInput.value = suggestedName;
      const note = h('div.cfg-note');
      const preview = h('pre.cfg-preview.selectable', { text: text.split(/\r?\n/).slice(0, 14).join('\n') + (text.split(/\r?\n/).length > 14 ? '\n…' : '') });
      const saveBtn = h('button.btn', { attrs: { type: 'button' }, text: 'Save' }) as HTMLButtonElement;
      const execBtn = h('button.btn.btn-accent', { attrs: { type: 'button' }, text: 'Save & exec' }) as HTMLButtonElement;
      const onceBtn = h('button.btn.btn-ghost', { attrs: { type: 'button', title: 'Run the lines now without saving them' }, text: 'Run once' }) as HTMLButtonElement;
      const cancel = h('button.btn.btn-ghost', { attrs: { type: 'button' }, text: 'Cancel' });
      const refresh = () => {
        const n = normalizeCfgName(nameInput.value);
        const reserved = n === 'config' || n === 'config_default';
        saveBtn.disabled = execBtn.disabled = !n || reserved;
        const exists = !!n && loadCfg(n) !== null;
        note.textContent = !n
          ? 'Enter a name.'
          : reserved
            ? `"${n}" is this game's own saved settings — choose another name.`
            : `Saved as cfg/${n}.cfg — run it with exec ${n}.${n === 'autoexec' ? ' autoexec.cfg also runs every time the game starts.' : ''}${exists ? ' Replaces the saved one.' : ''}`;
        note.classList.toggle('warn', exists || reserved || !n);
      };
      nameInput.addEventListener('input', refresh);
      refresh();
      const done = () => {
        if (this.modalClose !== done) return;
        this.modalClose = null;
        backdrop.remove();
        if (this.console.isOpen) this.console.input.focus();
        resolve();
      };
      const save = (exec: boolean) => {
        const n = normalizeCfgName(nameInput.value);
        if (!n) return;
        if (!saveCfg(n, text)) {
          this.toast("Couldn't save the config (browser storage unavailable or full)", 'error', 6);
          return;
        }
        done();
        console_.print(`Saved cfg/${n}.cfg (${commands} command${commands === 1 ? '' : 's'}).${exec ? '' : ` Type exec ${n} to run it.`}`, 'info');
        this.settings.refreshCfgs();
        if (exec) {
          this.execLine(`exec ${n}`);
          this.toast(`Saved and executed ${n}.cfg`, 'success');
        } else this.toast(`Saved ${n}.cfg — exec ${n} runs it`, 'success');
        this.sound.play('ui_click');
      };
      saveBtn.addEventListener('click', () => save(false));
      execBtn.addEventListener('click', () => save(true));
      onceBtn.addEventListener('click', () => {
        done();
        // line by line like exec (the console's tokenizer drops trailing // comments outside quotes)
        for (const line of text.split(/\r?\n|\r/)) {
          const l = line.trim();
          if (l && !l.startsWith('//')) this.execLine(l);
        }
        this.toast(`Ran ${commands} config line${commands === 1 ? '' : 's'}`, 'success');
      });
      cancel.addEventListener('click', () => done());
      nameInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !execBtn.disabled) save(true);
        else if (e.key === 'Escape') done();
      });
      const backdrop = h(
        'div.modal-backdrop',
        null,
        h(
          'div.modal.panel.cfg-modal',
          null,
          h('div.h-title', { text: fileName ? `Import ${fileName}` : 'Import config' }),
          h('p', { text: `${commands} command${commands === 1 ? '' : 's'} (binds, cvars, aliases…). Lines this game doesn't know are skipped with a console message, like in CS:GO.` }),
          preview,
          h('label.cfg-name-row', null, h('span', { text: 'cfg/' }), nameInput, h('span', { text: '.cfg' })),
          note,
          h('div.actions', null, onceBtn, h('span.spacer'), cancel, saveBtn, execBtn),
        ),
      );
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) done();
      });
      this.modalClose = done;
      this.modalHost.appendChild(backdrop);
      nameInput.focus();
      nameInput.select();
    });
  }

  /**
   * Whether mouse input is raw (unadjusted movement, no OS acceleration): the game's report of its pointer lock
   * when it gives one, else what the UI's own lock request found out.
   */
  rawInputStatus(): RawInputStatus {
    if (cvarNum('m_rawinput', 1) === 0) return 'off';
    const fromGame = this.game?.rawInputActive;
    const v = typeof fromGame === 'boolean' ? fromGame : this.uiRawInput;
    return v === true ? 'active' : v === false ? 'unsupported' : 'unknown';
  }

  /**
   * Once per page: integrated or software graphics alone explain a low frame rate (a gaming laptop's browser runs
   * on the integrated GPU unless Windows is told otherwise), so say so where it is seen, not only in Settings.
   */
  private warnSlowGpu(): void {
    if (this.gpuWarned) return;
    const info = this.game?.graphicsInfo?.() ?? null;
    if (!info?.renderer) return;
    const advice = gpuAdvice(classifyGpu(info.renderer));
    if (!advice) return;
    this.gpuWarned = true;
    this.toast(`Running on ${gpuName(info.renderer)}. ${advice}`, 'error', 15);
  }

  private gpuWarned = false;

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
    if (p.phase === 'error' && p.recovered) {
      // a map change failed but the previous map is back (CS:GO keeps you on the server): no error screen
      if (!this.loading.hasFailed) this.loading.hide();
      if (p.loadId === undefined || p.loadId !== this.recoveredId) {
        this.recoveredId = p.loadId;
        this.toast(`Couldn't load ${p.mapName || 'the map'}: ${p.message}`, 'error', 7);
      }
      return;
    }
    this.beginLoad(p);
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
    const wasVisible = this.hud.isVisible;
    this.hud.update(hud);
    // the feed can't scroll while hidden (menus, loading): show the newest lines when the HUD comes back
    if (!wasVisible && this.hud.isVisible) this.chatBox.scrollToBottom();
    this.hud.setLockHint(
      this.lockHintEnabled &&
        hud.visible &&
        this.game?.state === 'playing' &&
        !document.pointerLockElement &&
        !this.console.isOpen &&
        !this.chatBox.isOpen &&
        !hud.spectating,
    );
    if (this.pauseMenu.isVisible) {
      this.pauseMenu.renderRun(hud);
    }
  }
}
