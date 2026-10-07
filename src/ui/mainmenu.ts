// Main menu: top bar (wordmark + PLAY / SETTINGS / CONTROLS / ABOUT), animated ramp background, home hero
// with featured classics, and the map browser / settings / help / about pages.
import type { CatalogEntry } from '../maps/catalog';
import type { SoundApi } from '../game/api';
import { clear, h } from './dom';
import { icon, type IconName, logoMarkSvg } from './icons';
import { lastPlayedMap, type MapBrowser } from './mapbrowser';
import { MenuBackground } from './menubg';
import type { Settings } from './settings';

export type MenuPage = 'home' | 'play' | 'settings' | 'help' | 'about';

export interface MainMenuDeps {
  sound: SoundApi;
  browser: MapBrowser;
  settings: Settings;
  openConsole: () => void;
  quickPlay: (name: string, kind: 'catalog' | 'builtin') => void;
}

const HOME_FEATURED = ['surf_utopia_njv', 'surf_kitsune', 'surf_mesa_fixed', 'surf_beginner', 'surf_summer_ksf', 'surf_lux', 'surf_ing', 'surf_rookie'];

export const DEFAULT_BINDS_HELP: [string, string][] = [
  ['W A S D', 'Move / strafe (never hold W while surfing)'],
  ['SPACE · WHEEL', 'Jump (auto bunnyhop)'],
  ['CTRL', 'Duck'],
  ['SHIFT', 'Walk'],
  ['R', 'Restart map (!r)'],
  ['T', 'Restart stage (!back)'],
  ['MOUSE 4 / 5', 'Save location / teleport (!saveloc / !tele)'],
  ['F2', 'Practice mode (!prac)'],
  ['Y / U', 'Chat / team chat'],
  ['TAB', 'Scoreboard'],
  ['~', 'Developer console (the ` key)'],
  ['ESC', 'Pause menu'],
];

export const CHAT_COMMANDS_HELP: [string, string][] = [
  ['!r  !restart', 'Restart the map'],
  ['!s <n>  !stage <n>', 'Go to stage n'],
  ['!b <n>  !bonus <n>', 'Go to bonus n'],
  ['!back  !stuck', 'Restart the current stage'],
  ['!saveloc  !cp', 'Save your position (practice)'],
  ['!tele  !tp', 'Teleport to the saved position'],
  ['!prac  !practice', 'Toggle practice mode'],
  ['!noclip', 'Noclip (practice mode)'],
  ['!pb  !top', 'Your best time / map top times'],
  ['!mi  !tier', 'Map info and tier'],
  ['!replay', 'Watch your PB replay'],
  ['!ghost', 'Toggle the PB ghost'],
  ['!hide  !showkeys  !speed', 'HUD toggles'],
  ['!fov <n>  !sens <n>', 'Field of view / sensitivity'],
  ['!zones', 'Zone editor (maps without zones)'],
  ['!help  !commands', 'List every command'],
];

export function brandEl(cls = 'brand'): HTMLElement {
  const el = h(`div.${cls}`);
  el.innerHTML = logoMarkSvg();
  el.appendChild(h('span.brand-word', { text: 'SURF' }));
  return el;
}

export class MainMenu {
  readonly el: HTMLElement;
  private readonly bg: MenuBackground;
  private readonly navButtons = new Map<MenuPage, HTMLButtonElement>();
  private readonly pages = new Map<MenuPage, HTMLElement>();
  private readonly strip: HTMLElement;
  private readonly heroActions: HTMLElement;
  private readonly stats: HTMLElement;
  private visible = false;
  private _page: MenuPage = 'home';

  constructor(private readonly deps: MainMenuDeps) {
    const bgWrap = h('div.menu-bg');
    this.bg = new MenuBackground(bgWrap);
    bgWrap.appendChild(h('div.menu-vignette'));

    const brand = brandEl();
    brand.addEventListener('click', () => this.setPage('home'));
    const nav = h('nav.topnav');
    const navDefs: [MenuPage, string, IconName][] = [
      ['play', 'Play', 'play'],
      ['settings', 'Settings', 'settings'],
      ['help', 'Controls', 'keyboard'],
      ['about', 'About', 'info'],
    ];
    for (const [id, label, ic] of navDefs) {
      const b = h('button', { attrs: { type: 'button' } }, icon(ic), h('span', { text: label })) as HTMLButtonElement;
      b.addEventListener('click', () => this.setPage(this._page === id ? 'home' : id));
      this.navButtons.set(id, b);
      nav.appendChild(b);
    }
    const conBtn = h('button.btn.btn-ghost.btn-icon', { attrs: { type: 'button', title: 'Developer console (~)' } }, icon('console'));
    conBtn.addEventListener('click', () => deps.openConsole());
    const fsBtn = h('button.btn.btn-ghost.btn-icon', { attrs: { type: 'button', title: 'Fullscreen' } }, icon('fullscreen'));
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else void document.documentElement.requestFullscreen?.().catch(() => undefined);
    });
    const topbar = h('header.topbar', null, brand, nav, h('div.topbar-right', null, conBtn, fsBtn));

    // ---- home
    this.heroActions = h('div.hero-actions');
    this.stats = h('div.hero-stats');
    this.strip = h('div.home-strip');
    const home = h(
      'section.page.page-home',
      null,
      h(
        'div.hero',
        null,
        h('div.wordmark', null, h('div.wm-lines', null, h('i'), h('i'), h('i')), h('span.wm-text', { text: 'SURF' }), h('span.wm-ramp')),
        h('div.hero-tag', { text: 'Classic CS:GO surf, right in your browser.' }),
        h('div.hero-sub', { text: 'Source movement · the original KSF maps · SurfTimer zones, HUD and commands' }),
        this.heroActions,
        this.stats,
      ),
      h(
        'div.home-featured',
        null,
        h(
          'div.section-head',
          null,
          h('span.h-title', { text: 'Featured classics' }),
          h('span.h-sub', { text: 'Downloaded on first play, then cached' }),
          h('button.link', { attrs: { type: 'button' }, text: 'Browse all maps →', on: { click: () => this.setPage('play') } }),
        ),
        this.strip,
      ),
    );
    this.renderHeroActions();
    this.renderStats(null);

    const play = h('section.page.page-play');
    const settings = h('section.page.page-settings');
    const help = h('section.page.page-help', null, this.buildHelp());
    const about = h('section.page.page-about', null, this.buildAbout());
    this.pages.set('home', home);
    this.pages.set('play', play);
    this.pages.set('settings', settings);
    this.pages.set('help', help);
    this.pages.set('about', about);

    const footer = h(
      'footer.menu-footer',
      null,
      h('span', { text: 'SURF · fan-made CS:GO surf remake · not affiliated with Valve or KSF' }),
      h('span', null, 'Press ', h('span.kbd', { text: '~' }), ' for the developer console'),
    );
    this.el = h('div.screen.menu-screen.hidden', null, bgWrap, topbar, h('main.menu-body', null, home, play, settings, help, about), footer);
  }

  get page(): MenuPage {
    return this._page;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  show(): void {
    if (!this.visible) {
      this.visible = true;
      this.el.classList.remove('hidden');
      this.bg.start();
      this.renderHeroActions();
    }
    this.setPage(this._page, false);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.add('hidden');
    this.bg.stop();
  }

  setPage(page: MenuPage, sound = true): void {
    if (sound && page !== this._page) this.deps.sound.play(page === 'home' ? 'ui_back' : 'ui_click');
    this._page = page;
    for (const [id, b] of this.navButtons) b.classList.toggle('active', id === page);
    for (const [id, p] of this.pages) p.classList.toggle('active', id === page);
    this.el.classList.toggle('on-page', page !== 'home');
    if (page === 'play') {
      const host = this.pages.get('play')!;
      if (this.deps.browser.el.parentElement !== host) host.appendChild(this.deps.browser.el);
      void this.deps.browser.ensureData();
      this.deps.browser.show(this.deps.browser.currentTab, false);
    } else if (page === 'settings') {
      const host = this.pages.get('settings')!;
      if (this.deps.settings.el.parentElement !== host) host.appendChild(this.deps.settings.el);
      this.deps.settings.show(this.deps.settings.currentTab, false);
    } else if (page === 'home') {
      void this.deps.browser.ensureData().then(() => this.renderStrip());
    }
  }

  /** Called when the catalog is available. */
  renderStrip(): void {
    const all = this.deps.browser.featuredEntries();
    this.renderStats(all.length ? this.deps.browser : null);
    clear(this.strip);
    if (!all.length) {
      for (let i = 0; i < 6; i++) this.strip.appendChild(h('div.map-card.skeleton'));
      return;
    }
    const byName = new Map(all.map((e) => [e.name, e]));
    const picked: CatalogEntry[] = [];
    for (const n of HOME_FEATURED) {
      const e = byName.get(n);
      if (e && picked.length < 6) picked.push(e);
    }
    for (const e of all) if (picked.length < 6 && !picked.includes(e)) picked.push(e);
    for (const e of picked) this.strip.appendChild(this.deps.browser.card(e));
  }

  private renderStats(browser: MapBrowser | null): void {
    clear(this.stats);
    const stat = (v: string, l: string) => h('div.hero-stat', null, h('b', { text: v }), h('span', { text: l }));
    const counts = browser?.catalogCounts();
    this.stats.append(
      stat(counts ? String(counts.total) : '930+', 'KSF maps'),
      stat(counts ? String(counts.zoned) : '450', 'with timer zones'),
      stat('100', 'tick'),
      stat('150', 'sv_airaccelerate'),
    );
  }

  private renderHeroActions(): void {
    clear(this.heroActions);
    const play = h('button.btn.btn-primary.btn-lg', { attrs: { type: 'button' } }, icon('play'), 'Play');
    play.addEventListener('click', () => this.setPage('play'));
    this.heroActions.appendChild(play);
    const last = lastPlayedMap();
    const quick = last ?? { name: 'surf_beginner', kind: 'catalog' as const };
    const qb = h('button.btn.btn-lg.btn-quick', { attrs: { type: 'button' } }, icon(last ? 'restart' : 'chevronRight'), h('span', { text: last ? 'Continue' : 'Quick start' }), h('span.quick-map', { text: quick.name }));
    qb.addEventListener('click', () => this.deps.quickPlay(quick.name, quick.kind));
    this.heroActions.appendChild(qb);
  }

  private buildHelp(): HTMLElement {
    const table = (rows: [string, string][], keyCls: 'kbd' | 'code') =>
      h(
        'table.kv-table',
        null,
        ...rows.map(([k, v]) =>
          h(
            'tr',
            null,
            h('td', null, ...(keyCls === 'kbd' ? k.split(' · ').flatMap((part, i) => [i ? ' ' : null, ...part.split(' / ').flatMap((x, j) => [j ? ' / ' : null, h('span.kbd', { text: x })])]) : [h('code', { text: k })])),
            h('td', { text: v }),
          ),
        ),
      );
    return h(
      'div.page-frame.panel.doc-page.interactive',
      null,
      h(
        'div.doc-grid',
        null,
        h('div.doc-card', null, h('h3', null, icon('keyboard'), 'Default controls'), table(DEFAULT_BINDS_HELP, 'kbd'), h('p', { attrs: { style: 'margin-top:.8rem' }, text: 'Rebind anything in Settings → Binds or with bind in the console. CS:GO key names and binds work as-is.' })),
        h('div.doc-card', null, h('h3', null, icon('timer'), 'Chat commands'), table(CHAT_COMMANDS_HELP, 'code'), h('p', { attrs: { style: 'margin-top:.8rem' }, text: 'Type them in chat (Y). /command works silently, like on SourceMod servers.' })),
        h(
          'div.doc-card',
          null,
          h('h3', null, icon('game'), 'Surfing 101'),
          h('p', { text: 'Surf ramps are steep slopes you slide along without ever standing on them. Hold the strafe key that pushes you into the ramp — A when the ramp rises to your left, D when it rises to your right — and never press W.' }),
          h('p', { text: 'In the air, strafe and turn your mouse smoothly in the same direction to gain speed (air strafing). Land high on each ramp and look slightly ahead.' }),
          h('p', { text: 'Tier 1–2 maps (surf_beginner, surf_utopia_njv, surf_kitsune) are where everybody starts. Use !saveloc / !tele to drill a hard section.' }),
        ),
        h(
          'div.doc-card',
          null,
          h('h3', null, icon('console'), 'Console'),
          h('p', null, 'Open with ', h('span.kbd', { text: '~' }), ' (the ` key). Familiar Source commands work: ', h('code', { text: 'bind' }), ', ', h('code', { text: 'alias' }), ', ', h('code', { text: ';' }), '-separated chains, ', h('code', { text: 'cvarlist' }), ', ', h('code', { text: 'find' }), ', ', h('code', { text: 'map' }), ', ', h('code', { text: 'retry' }), ', ', h('code', { text: 'noclip' }), ', ', h('code', { text: 'setpos' }), ', ', h('code', { text: 'cl_showpos 1' }), '.'),
          h('p', null, 'Paste your CS:GO crosshair (', h('code', { text: 'cl_crosshair*' }), ') and ', h('code', { text: 'sensitivity' }), ' straight from your autoexec — the units are identical.'),
          h('p', null, 'Physics convars (', h('code', { text: 'sv_airaccelerate' }), ', ', h('code', { text: 'sv_gravity' }), ' …) can be changed; non-default physics makes runs unranked.'),
        ),
      ),
    );
  }

  private buildAbout(): HTMLElement {
    const hero = h('div.about-hero');
    hero.innerHTML = logoMarkSvg();
    hero.appendChild(h('div', null, h('div.brand-word', { text: 'SURF' }), h('div.h-sub', { text: 'A browser remake of CS:GO surf servers' })));
    return h(
      'div.page-frame.panel.doc-page.interactive',
      null,
      hero,
      h(
        'div.doc-grid',
        null,
        h(
          'div.doc-card',
          null,
          h('h3', null, icon('map'), 'Maps'),
          h('p', null, 'The classic surf maps come from the public KSF surf map archive on Google Drive (linked from ', h('a', { attrs: { href: 'https://github.com/OuiSURF/Surf_Maps', target: '_blank', rel: 'noopener noreferrer' }, text: 'OuiSURF/Surf_Maps' }), '). They are downloaded on demand straight from the archive, extracted in your browser and cached locally — nothing is re-hosted. All maps belong to their authors.'),
          h('p', { text: 'Stock CS:S/CS:GO textures are not distributed; surfaces that use them get a generated texture with the right average colour, lit by the map’s own lightmaps.' }),
        ),
        h(
          'div.doc-card',
          null,
          h('h3', null, icon('flag'), 'Timer zones'),
          h('p', { text: 'Start, end, stage, checkpoint and bonus zones come from SurfTimer’s public zone database (GPL-3.0), from Momentum Mod timer entities when a map has them, or from your own zones made with !zones.' }),
        ),
        h(
          'div.doc-card',
          null,
          h('h3', null, icon('game'), 'Physics'),
          h('p', { text: 'Movement is a from-scratch re-implementation of Source’s player movement as configured on CS:GO surf servers (sv_airaccelerate 150, 100 tick, autobhop), with box-vs-brush collision against each map’s own BSP brushes. No Valve source code is used.' }),
        ),
        h(
          'div.doc-card',
          null,
          h('h3', null, icon('info'), 'Credits'),
          h('p', { text: 'Built with three.js, fflate and node-unrar-js. UI font: Barlow by Jeremy Tribby (SIL OFL). All sounds are synthesized live with WebAudio.' }),
          h('p', { text: 'SURF is a non-commercial fan project and is not affiliated with or endorsed by Valve Corporation, KSF or the SurfTimer authors. Counter-Strike and CS:GO are trademarks of Valve Corporation.' }),
        ),
      ),
    );
  }
}
