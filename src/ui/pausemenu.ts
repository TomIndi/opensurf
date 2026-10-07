// In-game pause menu (Esc / pointer-lock loss): Resume, Restart (!r), Settings, Change Map, Console, Disconnect.
import type { HudState, SoundApi } from '../game/api';
import { clear, h } from './dom';
import { formatTime, mapTypeName } from './format';
import { icon, type IconName } from './icons';
import { brandEl } from './mainmenu';
import type { MapBrowser } from './mapbrowser';
import { mapNameEl, tierPill } from './mapui';
import type { Settings } from './settings';

export type PausePage = 'root' | 'settings' | 'maps';

export interface PauseMenuDeps {
  sound: SoundApi;
  browser: MapBrowser;
  settings: Settings;
  resume: () => void;
  restart: () => void;
  disconnect: () => void;
  openConsole: () => void;
}

export class PauseMenu {
  readonly el: HTMLElement;
  private readonly mapEl: HTMLElement;
  private readonly runEl: HTMLElement;
  private readonly content: HTMLElement;
  private readonly items = new Map<string, HTMLButtonElement>();
  private visible = false;
  private _page: PausePage = 'root';

  constructor(private readonly deps: PauseMenuDeps) {
    this.mapEl = h('div.pause-map');
    this.runEl = h('div.pause-run');
    const nav = h('nav.pause-nav');
    const item = (id: string, label: string, ic: IconName, fn: () => void, cls = '', hint = '') => {
      const b = h(`button.menu-item${cls ? '.' + cls : ''}`, { attrs: { type: 'button' } }, icon(ic), h('span', { text: label }), hint ? h('span.hint', { text: hint }) : null) as HTMLButtonElement;
      b.addEventListener('click', fn);
      this.items.set(id, b);
      nav.appendChild(b);
      return b;
    };
    item('resume', 'Resume', 'resume', () => deps.resume(), 'primary', 'ESC');
    item('restart', 'Restart', 'restart', () => deps.restart(), '', '!r');
    nav.appendChild(h('div.pause-sep'));
    item('maps', 'Change map', 'map', () => this.setPage(this._page === 'maps' ? 'root' : 'maps'));
    item('settings', 'Settings', 'settings', () => this.setPage(this._page === 'settings' ? 'root' : 'settings'));
    item('console', 'Console', 'console', () => deps.openConsole(), '', '~');
    nav.appendChild(h('div.pause-sep'));
    item('disconnect', 'Disconnect', 'exit', () => deps.disconnect(), 'danger');
    this.content = h('div.pause-content');
    this.el = h(
      'div.screen.pause-screen.hidden',
      null,
      h('div.pause-shade'),
      h('div.pause-side', null, brandEl('pause-brand'), this.mapEl, this.runEl, nav, h('div.pause-foot', null, 'Game paused · ', h('span.kbd', { text: 'ESC' }), ' to resume')),
      this.content,
    );
  }

  get page(): PausePage {
    return this._page;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  show(mapName: string | null, tier: number | null, type: string | null, hud: HudState | null): void {
    this.visible = true;
    this.el.classList.remove('hidden');
    this.mapEl.replaceChildren(
      mapNameEl(mapName ?? 'No map', 'map-title'),
      h('div.pills', null, tierPill(tier, true), type ? h('span.pill.soft', { text: mapTypeName(type) }) : null),
    );
    this.renderRun(hud);
    this.setPage('root', false);
  }

  private runKey = '';

  /** Run info (PB / record / current run); cheap to call every frame — re-renders only on change. */
  renderRun(hud: HudState | null): void {
    if (!hud) return;
    const t = hud.timer;
    const key = `${t.pb}|${t.wr}|${t.stageCount}|${t.mapType}|${t.state}|${t.state === 'running' ? Math.floor(t.time * 100) : 0}`;
    if (key === this.runKey) return;
    this.runKey = key;
    clear(this.runEl);
    const row = (k: string, v: string) => [h('span', { text: k }), h('b', { text: v })];
    this.runEl.append(
      ...row('Personal best', t.pb ? formatTime(t.pb) : 'None'),
      ...row('Server record', t.wr ? formatTime(t.wr) : 'None'),
      ...(t.mapType === 'staged' && t.stageCount ? row('Stages', String(t.stageCount)) : []),
      ...(t.state === 'running' || t.state === 'practice' ? row('Current run', formatTime(t.time)) : []),
    );
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.add('hidden');
  }

  setPage(page: PausePage, sound = true): void {
    if (sound && page !== this._page) this.deps.sound.play(page === 'root' ? 'ui_back' : 'ui_click');
    this._page = page;
    this.items.get('maps')!.classList.toggle('active', page === 'maps');
    this.items.get('settings')!.classList.toggle('active', page === 'settings');
    clear(this.content);
    if (page === 'maps') {
      this.content.appendChild(this.deps.browser.el);
      void this.deps.browser.ensureData();
      this.deps.browser.show(this.deps.browser.currentTab, false);
    } else if (page === 'settings') {
      this.content.appendChild(this.deps.settings.el);
      this.deps.settings.show(this.deps.settings.currentTab, false);
    }
  }
}
