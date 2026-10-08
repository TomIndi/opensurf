// Map browser: Featured classics, All maps (virtualized, search/tier/type/sort filters, cache management),
// Built-in maps and Local files (drag & drop / picker).
import type { GameApi, SoundApi } from '../game/api';
import { BUILTIN_MAPS, type BuiltinMapInfo } from '../map/builtin/list';
import { type CatalogEntry, loadCatalog, tierColor } from '../maps/catalog';
import { deleteCachedMap, driveViewUrl, listCachedMaps } from '../maps/downloader';
import { boardLabel, getKsfService, ksfMapPageUrl, ksfVideosUrl, type KsfWr } from '../maps/ksf';
import { cvarNum } from './cvardefs';
import { getCompletions, getPersonalBest, getRecords } from '../game/records';
import { clear, h, storageGet, storageSet } from './dom';
import { mapNameEl, tierPill } from './mapui';
import { formatTime, formatTimeMsShort, formatTimeShort, mapTypeName, prettyMapName, tierName } from './format';
import { icon } from './icons';
import { comparePopularity, filterMaps, type MapFilterOptions, type MapSort, type MapTypeFilter, tierCounts } from './mapfilter';
import { mapThumbSvg, setMapArt } from './thumbs';
import { VirtualList } from './virtual';

export type BrowserTab = 'featured' | 'all' | 'builtin' | 'local';

export interface MapBrowserDeps {
  getGame: () => GameApi | null;
  sound: SoundApi;
  toast: (msg: string, kind?: 'info' | 'error' | 'success') => void;
  confirm: (title: string, text: string, ok: string) => Promise<boolean>;
  /** A load failed (the promise rejected). */
  onLoadError: (name: string, message: string) => void;
  /** Called right before a load starts (the loading screen shows this name/tier); `retry` re-runs the load. */
  onLoadStart: (name: string, tier: number | null, retry: () => void, entry?: CatalogEntry) => void;
}

export const MAP_FILE_ACCEPT = '.bsp,.bz2,.rar,.zip';
const LAST_MAP_KEY = 'surf.ui.lastMap';
const TAB_KEY = 'surf.ui.browserTab';

export function lastPlayedMap(): { name: string; kind: 'catalog' | 'builtin' } | null {
  const raw = storageGet(LAST_MAP_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { name: string; kind: 'catalog' | 'builtin' };
    return typeof v?.name === 'string' ? v : null;
  } catch {
    return null;
  }
}

export class MapBrowser {
  readonly el: HTMLElement;
  private tab: BrowserTab = 'featured';
  private readonly tabs = new Map<BrowserTab, HTMLButtonElement>();
  private readonly panes = new Map<BrowserTab, HTMLElement>();
  private catalog: CatalogEntry[] = [];
  private catalogError: string | null = null;
  private catalogLoading: Promise<void> | null = null;
  private cached = new Set<string>();
  private filter: MapFilterOptions = { query: '', tiers: new Set(), type: 'all', sort: 'popular', cachedOnly: false, zonesOnly: false, cached: this.cached };
  private readonly search: HTMLInputElement;
  private readonly list: VirtualList<CatalogEntry>;
  private readonly details: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly chipsEl: HTMLElement;
  private readonly featuredGrid: HTMLElement;
  private readonly allTabCount: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private busy = false;
  /** The details pane's KSF request (a newer selection makes older answers stale). */
  private ksfSeq = 0;
  private ksfTimer: ReturnType<typeof setTimeout> | null = null;
  /** Called whenever the catalog finished (re)loading successfully. */
  onCatalogLoaded: (() => void) | null = null;

  constructor(private readonly deps: MapBrowserDeps) {
    this.el = h('div.page-frame.panel.browser.interactive');

    // ---- header: tabs + search
    const tabsEl = h('div.tabs');
    const mkTab = (id: BrowserTab, label: string, ic: Parameters<typeof icon>[0], extra?: HTMLElement) => {
      const b = h('button.tab', { attrs: { type: 'button' }, on: { click: () => this.show(id, true) } }, icon(ic), h('span', { text: label }), extra ?? null);
      b.addEventListener('mouseenter', () => deps.sound.play('ui_hover'));
      this.tabs.set(id, b);
      tabsEl.appendChild(b);
    };
    this.allTabCount = h('span.tab-count', { text: '' });
    mkTab('featured', 'Classics', 'star');
    mkTab('all', 'All Maps', 'list', this.allTabCount);
    mkTab('builtin', 'Built-in', 'cube');
    mkTab('local', 'Local File', 'upload');

    this.search = h('input.input.search-input', {
      attrs: { type: 'search', placeholder: 'Search maps…', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search maps' },
    });
    this.search.addEventListener('input', () => {
      this.filter.query = this.search.value;
      if (this.tab !== 'all' && this.search.value.trim()) this.show('all', false);
      this.applyFilter(true);
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        if (this.tab !== 'all') this.show('all', false);
        if (this.list.getItems().length) {
          if (e.key === 'Enter') {
            const i = Math.max(0, this.list.selectedIndex);
            this.playEntry(this.list.getItems()[i]);
          } else {
            this.list.el.focus();
            this.list.select(Math.max(0, this.list.selectedIndex));
          }
        }
      } else if (e.key === 'Escape' && this.search.value) {
        e.stopPropagation();
        this.search.value = '';
        this.filter.query = '';
        this.applyFilter(true);
      }
    });
    const head = h(
      'div.browser-head',
      null,
      tabsEl,
      h('label.search-box', null, icon('search'), this.search),
    );

    // ---- featured
    this.featuredGrid = h('div.card-grid');
    const featured = h('div.tab-pane.pane-featured', null, this.featuredGrid);

    // ---- all maps
    this.chipsEl = h('div.tier-chips');
    const typeSeg = this.segmented<MapTypeFilter>(
      [
        ['all', 'All'],
        ['linear', 'Linear'],
        ['staged', 'Staged'],
      ],
      'all',
      (v) => {
        this.filter.type = v;
        this.applyFilter(true);
      },
    );
    const sortSel = h('select.select.sort-select', { attrs: { 'aria-label': 'Sort' } }) as HTMLSelectElement;
    for (const [v, l] of [
      ['popular', 'Most played (CS:GO era)'],
      ['name', 'Name A–Z'],
      ['tier', 'Tier ↑'],
      ['tier-desc', 'Tier ↓'],
    ] as const) {
      sortSel.appendChild(h('option', { text: l, attrs: { value: v } }));
    }
    sortSel.addEventListener('change', () => {
      this.filter.sort = sortSel.value as MapSort;
      this.applyFilter(true);
    });
    const toggle = (label: string, ic: Parameters<typeof icon>[0], fn: (on: boolean) => void) => {
      const b = h('button.chip.toggle-chip', { attrs: { type: 'button', 'aria-pressed': 'false' } }, icon(ic), label);
      b.addEventListener('click', () => {
        const on = !b.classList.contains('active');
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
        fn(on);
      });
      return b;
    };
    this.countEl = h('span.result-count');
    const randomBtn = h('button.chip.random-chip', { attrs: { type: 'button', title: 'Pick a random map from the current filter' } }, icon('dice'), 'Random');
    randomBtn.addEventListener('click', () => {
      const items = this.list.getItems();
      if (!items.length) return;
      let i = Math.floor(Math.random() * items.length);
      if (items.length > 1 && i === this.list.selectedIndex) i = (i + 1) % items.length;
      this.list.select(i, true);
    });
    const toolbar = h(
      'div.all-toolbar',
      null,
      this.chipsEl,
      h('div.toolbar-sep'),
      typeSeg,
      sortSel,
      toggle('Downloaded', 'download', (on) => {
        this.filter.cachedOnly = on;
        this.applyFilter(true);
      }),
      toggle('Zoned', 'flag', (on) => {
        this.filter.zonesOnly = on;
        this.applyFilter(true);
      }),
      toggle('Completed', 'timer', (on) => {
        this.filter.completedOnly = on;
        this.filter.completed = completedSet(this.catalog);
        this.applyFilter(true);
      }),
      randomBtn,
      this.countEl,
    );
    this.list = new VirtualList<CatalogEntry>({
      createRow: () => this.createRow(),
      renderRow: (row, item, _i, selected) => this.renderRow(row, item, selected),
      rowHeight: () => remPx() * 2.45,
      onActivate: (item) => this.playEntry(item),
      onSelect: (item) => this.renderDetails(item),
    });
    const listHead = h(
      'div.list-head',
      null,
      h('span.c-name', { text: 'Map' }),
      h('span.c-tier', { text: 'Tier' }),
      h('span.c-type', { text: 'Type' }),
      h('span.c-zones', { text: 'Zones' }),
      h('span.c-pb', { text: 'Your PB' }),
      h('span.c-status', { text: 'Status' }),
      h('span.c-actions'),
    );
    this.details = h('aside.map-details');
    const all = h(
      'div.tab-pane.pane-all',
      null,
      toolbar,
      h('div.all-split', null, h('div.all-list', null, listHead, this.list.el), this.details),
    );

    // ---- built-in
    const builtin = h('div.tab-pane.pane-builtin', null, this.renderBuiltin());

    // ---- local file
    this.fileInput = h('input', { attrs: { type: 'file', accept: MAP_FILE_ACCEPT }, class: 'hidden' }) as HTMLInputElement;
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) void this.playFile(f);
    });
    const drop = h(
      'div.drop-zone',
      null,
      icon('upload', 'icon drop-icon'),
      h('div.drop-title', { text: 'Drop a map file here' }),
      h('div.drop-sub', { text: '.bsp  ·  .bsp.bz2  ·  .rar  ·  .zip' }),
      h('button.btn.btn-accent', { attrs: { type: 'button' }, on: { click: () => this.fileInput.click() } }, icon('upload'), 'Browse files…'),
      this.fileInput,
    );
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      drop.classList.remove('over');
      // the global drop handler in Ui loads the file
    });
    const local = h(
      'div.tab-pane.pane-local',
      null,
      drop,
      h(
        'div.local-notes',
        null,
        h('p', null, 'Play any Source-engine surf map: drop the ', h('b', { text: '.bsp' }), ' (or the FastDL ', h('b', { text: '.bsp.bz2' }), ', or a ', h('b', { text: '.rar' }), '/', h('b', { text: '.zip' }), ' from a map archive) anywhere on this window.'),
        h('p', { text: 'The file is read locally in your browser — nothing is uploaded. CS:S (v19/v20) and CS:GO (v21) BSPs are supported; textures packed into the map are used.' }),
        h('p', { text: 'Maps without SurfTimer zones can be zoned in-game with !zones.' }),
      ),
    );

    const body = h('div.browser-body', null, featured, all, builtin, local);
    this.panes.set('featured', featured);
    this.panes.set('all', all);
    this.panes.set('builtin', builtin);
    this.panes.set('local', local);
    this.el.append(head, body);

    const savedTab = storageGet(TAB_KEY) as BrowserTab | null;
    this.show(savedTab && this.tabs.has(savedTab) ? savedTab : 'featured', false);
    this.renderDetails(null);
  }

  /** Loads the catalog (once) and the cache list, then renders. */
  ensureData(): Promise<void> {
    void this.refreshCached();
    if (this.catalog.length) return Promise.resolve();
    if (!this.catalogLoading) {
      this.renderFeatured();
      this.catalogLoading = loadCatalog()
        .then((entries) => {
          this.catalog = entries;
          this.catalogError = null;
        })
        .catch((e: Error) => {
          this.catalogError = e.message || String(e);
        })
        .finally(() => {
          this.catalogLoading = null;
          this.allTabCount.textContent = this.catalog.length ? String(this.catalog.length) : '';
          this.search.placeholder = this.catalog.length ? `Search ${this.catalog.length} maps…` : 'Search maps…';
          this.renderChips();
          this.renderFeatured();
          this.applyFilter(false);
          if (this.catalog.length) this.onCatalogLoaded?.();
        });
    }
    return this.catalogLoading;
  }

  async refreshCached(): Promise<void> {
    try {
      const names = await listCachedMaps();
      this.cached.clear();
      for (const n of names) this.cached.add(n.toLowerCase());
    } catch {
      /* no IndexedDB */
    }
    if (this.filter.completedOnly) this.filter.completed = completedSet(this.catalog);
    if (this.filter.cachedOnly || this.filter.completedOnly) this.applyFilter(false);
    else this.list.refresh();
    this.renderFeatured();
    const sel = this.list.selectedIndex;
    this.renderDetails(sel >= 0 ? this.list.getItems()[sel] : null);
  }

  show(tab: BrowserTab, user: boolean): void {
    if (user && tab !== this.tab) this.deps.sound.play('ui_click');
    this.tab = tab;
    storageSet(TAB_KEY, tab);
    for (const [id, b] of this.tabs) b.classList.toggle('active', id === tab);
    for (const [id, p] of this.panes) p.classList.toggle('active', id === tab);
    if (tab === 'all') {
      this.list.measure();
      this.list.render();
    }
  }

  get currentTab(): BrowserTab {
    return this.tab;
  }

  focusSearch(): void {
    this.search.focus();
    this.search.select();
  }

  setQuery(q: string): void {
    this.search.value = q;
    this.filter.query = q;
    this.applyFilter(true);
  }

  // ------------------------------------------------------------ rendering

  private segmented<T extends string>(items: [T, string][], initial: T, onChange: (v: T) => void): HTMLElement {
    const el = h('div.segmented');
    for (const [v, label] of items) {
      const b = h('button', { text: label, attrs: { type: 'button' } });
      if (v === initial) b.classList.add('active');
      b.addEventListener('click', () => {
        for (const c of el.children) c.classList.remove('active');
        b.classList.add('active');
        onChange(v);
      });
      el.appendChild(b);
    }
    return el;
  }

  private renderChips(): void {
    clear(this.chipsEl);
    const counts = tierCounts(this.catalog);
    const allChip = h('button.chip', { text: 'All tiers', attrs: { type: 'button' } });
    allChip.classList.toggle('active', this.filter.tiers.size === 0);
    allChip.addEventListener('click', () => {
      this.filter.tiers = new Set();
      this.renderChips();
      this.applyFilter(true);
    });
    this.chipsEl.appendChild(allChip);
    for (let t = 1; t <= 8; t++) {
      const chip = h('button.chip.tier-chip', { attrs: { type: 'button', title: `${tierName(t)}: ${counts[t]} maps` } }, `T${t}`, h('span.chip-count', { text: String(counts[t]) }));
      chip.style.setProperty('--chip-color', tierColor(t));
      chip.classList.toggle('active', this.filter.tiers.has(t));
      chip.addEventListener('click', (e) => {
        const tiers = new Set(this.filter.tiers);
        if ((e as MouseEvent).shiftKey || (e as MouseEvent).ctrlKey) {
          if (tiers.has(t)) tiers.delete(t);
          else tiers.add(t);
        } else if (tiers.size === 1 && tiers.has(t)) tiers.clear();
        else if (tiers.has(t)) tiers.delete(t);
        else tiers.add(t);
        this.filter.tiers = tiers;
        this.renderChips();
        this.applyFilter(true);
      });
      this.chipsEl.appendChild(chip);
    }
  }

  private applyFilter(resetScroll: boolean): void {
    if (this.catalogError) {
      this.countEl.textContent = '';
      return;
    }
    const items = filterMaps(this.catalog, this.filter);
    this.list.setItems(items, true);
    if (resetScroll) this.list.scrollToTop();
    this.countEl.textContent = this.catalog.length ? `${items.length} of ${this.catalog.length}` : '';
    if (this.list.selectedIndex < 0 && items.length) this.list.select(0, false);
    else if (!items.length) this.renderDetails(null);
  }

  private createRow(): HTMLElement {
    const play = h('button.btn.btn-sm.btn-primary.row-play', { attrs: { type: 'button', title: 'Play' } }, icon('play'), 'Play');
    const row = h(
      'div.map-row',
      null,
      h('span.c-name'),
      h('span.c-tier'),
      h('span.c-type'),
      h('span.c-zones'),
      h('span.c-pb.tnum'),
      h('span.c-status'),
      h('span.c-actions', null, play),
    );
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(row.dataset.index);
      const item = this.list.getItems()[idx];
      if (item) this.playEntry(item);
    });
    return row;
  }

  private renderRow(row: HTMLElement, e: CatalogEntry, selected: boolean): void {
    row.classList.toggle('selected', selected);
    const [name, tier, type, zones, pbEl, status] = row.children as unknown as HTMLElement[];
    const pb = personalBest(e.name);
    pbEl.textContent = pb ? formatTimeShort(pb.time) : '';
    if (row.dataset.map === e.name) {
      // only cache status / PB may change
      this.renderStatus(status, e);
      return;
    }
    row.dataset.map = e.name;
    clear(name);
    name.appendChild(mapNameEl(e.name));
    clear(tier);
    tier.appendChild(tierPill(e.tier));
    type.textContent = e.type ? mapTypeName(e.type) : '—';
    clear(zones);
    if (e.hasZones) zones.appendChild(icon('check', 'icon ok'));
    else zones.appendChild(h('span.muted', { text: '—' }));
    this.renderStatus(status, e);
  }

  private renderStatus(el: HTMLElement, e: CatalogEntry): void {
    const isCached = this.cached.has(e.name.toLowerCase());
    if (el.dataset.cached === String(isCached)) return;
    el.dataset.cached = String(isCached);
    clear(el);
    el.appendChild(isCached ? h('span.status-dl', null, icon('download'), 'Downloaded') : h('span.status-cloud', null, icon('cloud'), 'Cloud'));
  }

  private renderDetails(e: CatalogEntry | null): void {
    const d = this.details;
    clear(d);
    if (!e) {
      if (this.catalogError) {
        d.appendChild(this.errorBox());
        return;
      }
      d.appendChild(h('div.details-empty', null, icon('map', 'icon big'), h('div', { text: this.catalogLoading ? 'Loading catalog…' : 'No map selected' })));
      return;
    }
    const isCached = this.cached.has(e.name.toLowerCase());
    const thumb = h('div.details-thumb');
    setMapArt(thumb, e.name);
    thumb.appendChild(h('div.details-thumb-name', null, h('div.pretty', { text: prettyMapName(e.name) })));
    const playBtn = h('button.btn.btn-primary.btn-lg.details-play', { attrs: { type: 'button' } }, icon('play'), isCached ? 'Play' : 'Download & Play');
    playBtn.addEventListener('click', () => this.playEntry(e));
    const actions = h('div.details-actions', null, playBtn);
    const ksfCell = h('td.ksf-wr', null);
    const ksfRow = h('tr.ksf-row', null, h('td', { text: 'KSF WR' }), ksfCell);
    const ksfBox = h('div.details-ksf');
    if (isCached) {
      const del = h('button.btn.btn-danger', { attrs: { type: 'button', title: 'Delete the downloaded copy' } }, icon('trash'), 'Delete download');
      del.addEventListener('click', () => void this.deleteCached(e.name));
      actions.appendChild(del);
    }
    if (e.driveId) {
      actions.appendChild(
        h('a.btn.btn-ghost', { attrs: { href: driveViewUrl(e.driveId), target: '_blank', rel: 'noopener noreferrer', title: 'Open the original archive on Google Drive' } }, icon('external'), 'Archive'),
      );
    }
    d.append(
      thumb,
      h('div.details-name', null, mapNameEl(e.name, 'map-title selectable')),
      h(
        'div.details-pills',
        null,
        tierPill(e.tier, true),
        h('span.pill.soft', { text: mapTypeName(e.type) }),
        e.hasZones ? h('span.pill.good', null, icon('flag'), 'Zones') : null,
        isCached ? h('span.pill.info', null, icon('download'), 'Downloaded') : null,
      ),
      h(
        'table.kv-table.details-info',
        null,
        h('tr', null, h('td', { text: 'Difficulty' }), h('td', { text: e.tier ? `${tierName(e.tier)} — ${tierBlurb(e.tier)}` : 'Unknown' })),
        h('tr', null, h('td', { text: 'Layout' }), h('td', { text: layoutBlurb(e.type) })),
        h('tr', null, h('td', { text: 'Timer zones' }), h('td', { text: e.hasZones ? 'SurfTimer zone preset' : 'None — create with !zones' })),
        h('tr', null, h('td', { text: 'Your best' }), h('td', null, pbText(e.name))),
        ksfRow,
        h('tr', null, h('td', { text: 'Source' }), h('td', { text: isCached ? 'Downloaded (stored in your browser)' : `KSF map archive · ${(e.archive ?? 'rar').toUpperCase()}` })),
      ),
      ksfBox,
      actions,
    );
    this.renderKsf(e, ksfRow, ksfCell, ksfBox);
  }

  /**
   * The KSF world record of the selected map (ksf.surf through the local server, cached for the session): the
   * "KSF WR 0:53.364 - name" row, Watch WR (loads the map, then spectates the WR replay), the KSF record videos on
   * YouTube and the credit. Without the local server only the videos link is shown.
   */
  private renderKsf(e: CatalogEntry, row: HTMLElement, cell: HTMLElement, box: HTMLElement): void {
    const seq = ++this.ksfSeq;
    if (this.ksfTimer) clearTimeout(this.ksfTimer);
    this.ksfTimer = null;
    const svc = getKsfService();
    const videos = h(
      'a.btn.btn-ghost.btn-sm.ksf-videos',
      { attrs: { href: ksfVideosUrl(e.name), target: '_blank', rel: 'noopener noreferrer', title: `KSF record videos of ${e.name} on YouTube` } },
      icon('external'),
      'WR videos',
    );
    const credit = () =>
      h('div.ksf-credit', null, 'World records from ', h('a', { attrs: { href: ksfMapPageUrl(e.name), target: '_blank', rel: 'noopener noreferrer' }, text: 'ksf.surf' }));
    const fill = (res: KsfWr) => {
      if (seq !== this.ksfSeq) return;
      clear(cell);
      clear(box);
      row.classList.toggle('hidden', res.status === 'unavailable');
      if (res.status === 'ok') {
        cell.append(
          h('b.ksf-time.tnum', { text: formatTimeMsShort(res.wr.time) }),
          h('span.ksf-holder', { text: ` - ${res.wr.name}` }),
          h('span.muted', { text: ` · ${boardLabel(res.board)}${res.fallback ? ` (no ${boardLabel(res.preferred)} records)` : ''}` }),
        );
        const watch = h(
          'button.btn.btn-sm.btn-accent.ksf-watch',
          { attrs: { type: 'button', title: `Load ${e.name} and watch the KSF world record replay` } },
          icon('play'),
          'Watch WR',
        );
        watch.addEventListener('click', () => this.watchWr(e));
        box.append(h('div.ksf-actions', null, watch, videos), credit());
      } else if (res.status === 'none') {
        cell.append(h('span.muted', { text: 'No KSF records yet' }));
        box.append(h('div.ksf-actions', null, videos), credit());
      } else if (res.status === 'error') {
        cell.append(h('span.muted', { text: `ksf.surf unreachable (${res.message})` }));
        box.append(h('div.ksf-actions', null, videos));
      } else box.append(h('div.ksf-actions', null, videos));
    };
    const tick = cvarNum('tickrate', 100);
    const known = svc.available === false ? ({ status: 'unavailable', map: e.name, message: '' } as KsfWr) : svc.peekWorldRecord(e.name, tick);
    if (known) {
      fill(known);
      return;
    }
    cell.append(h('span.muted', { text: 'Loading…' }));
    box.append(h('div.ksf-actions', null, videos));
    // (a short delay: arrowing through the list doesn't ask for every map on the way)
    this.ksfTimer = setTimeout(() => {
      this.ksfTimer = null;
      if (seq !== this.ksfSeq) return;
      void svc.worldRecord(e.name, tick).then(fill);
    }, 200);
  }

  /** Watch WR: spectate the KSF WR replay (loading the map first unless it is the one being played). */
  private watchWr(e: CatalogEntry): void {
    const game = this.deps.getGame();
    if (!game || this.busy) return;
    const playing = game.state === 'playing' || game.state === 'paused';
    const watch = () => {
      if (game.watchKsfWr) game.watchKsfWr();
      else game.say('/wrreplay');
    };
    if (playing && game.mapName?.toLowerCase() === e.name.toLowerCase()) {
      this.deps.sound.play('ui_click');
      if (game.state === 'paused') game.resume();
      watch();
      return;
    }
    this.playEntry(e, () => {
      if (game.state === 'playing' && game.mapName?.toLowerCase() === e.name.toLowerCase()) watch();
    });
  }

  private renderFeatured(): void {
    const grid = this.featuredGrid;
    clear(grid);
    if (this.catalogError) {
      grid.appendChild(this.errorBox());
      return;
    }
    if (!this.catalog.length) {
      for (let i = 0; i < 8; i++) grid.appendChild(h('div.map-card.skeleton'));
      return;
    }
    // the classics, most played first
    const featured = this.catalog.filter((e) => e.featured).sort((a, b) => comparePopularity(a, b) || a.name.localeCompare(b.name));
    for (const e of featured) grid.appendChild(this.card(e));
  }

  /** A map card (featured grids, home strip). */
  card(e: CatalogEntry): HTMLElement {
    const thumb = h('div.thumb');
    setMapArt(thumb, e.name);
    const isCached = this.cached.has(e.name.toLowerCase());
    const card = h(
      'button.map-card',
      { attrs: { type: 'button', title: `${e.name} — ${tierName(e.tier)}, ${mapTypeName(e.type)}` } },
      thumb,
      h('div.card-badges', null, isCached ? h('span.badge.badge-dl', { attrs: { title: 'Downloaded' } }, icon('download')) : null, e.hasZones ? h('span.badge.badge-zones', { attrs: { title: 'SurfTimer zones' } }, icon('flag')) : null),
      h('div.card-play', null, icon('play')),
      h(
        'div.card-info',
        null,
        mapNameEl(e.name, 'card-name'),
        h('div.card-meta', null, tierPill(e.tier), h('span.card-type', { text: mapTypeName(e.type) }), cardPb(e.name)),
      ),
    );
    card.style.setProperty('--tier-color', tierColor(e.tier));
    card.addEventListener('mouseenter', () => this.deps.sound.play('ui_hover'));
    card.addEventListener('click', () => this.playEntry(e));
    return card;
  }

  featuredEntries(): CatalogEntry[] {
    return this.catalog.filter((e) => e.featured).sort(comparePopularity);
  }

  catalogCounts(): { total: number; zoned: number } | null {
    if (!this.catalog.length) return null;
    return { total: this.catalog.length, zoned: this.catalog.filter((e) => e.hasZones).length };
  }

  findEntry(name: string): CatalogEntry | undefined {
    const n = name.toLowerCase();
    return this.catalog.find((e) => e.name.toLowerCase() === n);
  }

  findBuiltin(idOrName: string): BuiltinMapInfo | undefined {
    const n = idOrName.toLowerCase();
    return ((BUILTIN_MAPS ?? []) as BuiltinMapInfo[]).find((m: BuiltinMapInfo) => m.id.toLowerCase() === n || m.name.toLowerCase() === n);
  }

  private renderBuiltin(): HTMLElement {
    const grid = h('div.card-grid.builtin-grid');
    let maps: BuiltinMapInfo[] = [];
    try {
      maps = BUILTIN_MAPS ?? [];
    } catch {
      maps = [];
    }
    if (!maps.length) {
      grid.appendChild(h('div.details-empty', null, icon('cube', 'icon big'), h('div', { text: 'No built-in maps available' })));
      return grid;
    }
    for (const m of maps) {
      const thumb = h('div.thumb');
      thumb.innerHTML = mapThumbSvg(m.id + m.name);
      const card = h(
        'button.map-card.builtin-card',
        { attrs: { type: 'button' } },
        thumb,
        h('div.card-badges', null, h('span.badge.badge-instant', { text: 'INSTANT' })),
        h('div.card-play', null, icon('play')),
        h('div.card-info', null, h('span.card-name', { text: m.name }), h('div.card-desc', { text: m.description }), h('div.card-meta', null, tierPill(m.tier), h('span.card-type', { text: mapTypeName(m.type) }))),
      );
      card.style.setProperty('--tier-color', tierColor(m.tier));
      card.addEventListener('mouseenter', () => this.deps.sound.play('ui_hover'));
      card.addEventListener('click', () => this.playBuiltin(m));
      grid.appendChild(card);
    }
    return grid;
  }

  private errorBox(): HTMLElement {
    const retry = h('button.btn', { attrs: { type: 'button' } }, icon('refresh'), 'Retry');
    retry.addEventListener('click', () => {
      this.catalogError = null;
      void this.ensureData();
    });
    return h(
      'div.details-empty.error-box',
      null,
      icon('warning', 'icon big'),
      h('div', { text: `Couldn't load the map catalog (${this.catalogError}).` }),
      h('div.muted', { text: 'Built-in maps and local map files still work offline.' }),
      retry,
    );
  }

  // ------------------------------------------------------------ actions

  private async deleteCached(name: string): Promise<void> {
    const ok = await this.deps.confirm('Delete download', `Remove the downloaded copy of ${name} from this browser? It will be downloaded again next time you play it.`, 'Delete');
    if (!ok) return;
    try {
      await deleteCachedMap(name);
      this.deps.toast(`Deleted ${name} from the map cache`, 'success');
    } catch (e) {
      this.deps.toast(`Couldn't delete ${name}: ${(e as Error).message}`, 'error');
    }
    await this.refreshCached();
  }

  /** Plays a catalog map; `after` runs once it loaded. */
  playEntry(e: CatalogEntry, after?: () => void): void {
    const game = this.deps.getGame();
    if (!game || this.busy) return;
    this.deps.sound.play('ui_click');
    storageSet(LAST_MAP_KEY, JSON.stringify({ name: e.name, kind: 'catalog' }));
    this.deps.onLoadStart(e.name, e.tier, () => this.playEntry(e, after), e);
    this.run(() => game.loadCatalogMap(e.name), e.name, after);
  }

  playBuiltin(m: BuiltinMapInfo): void {
    const game = this.deps.getGame();
    if (!game || this.busy) return;
    this.deps.sound.play('ui_click');
    storageSet(LAST_MAP_KEY, JSON.stringify({ name: m.id, kind: 'builtin' }));
    this.deps.onLoadStart(m.name, m.tier, () => this.playBuiltin(m));
    this.run(() => game.loadBuiltinMap(m.id), m.name);
  }

  async playFile(f: File): Promise<void> {
    const game = this.deps.getGame();
    if (!game || this.busy) return;
    if (!/\.(bsp|bz2|rar|zip)$/i.test(f.name)) {
      this.deps.toast(`${f.name} is not a map file (.bsp, .bsp.bz2, .rar or .zip)`, 'error');
      return;
    }
    this.deps.sound.play('ui_click');
    const base = f.name.replace(/\.(bz2|rar|zip)$/i, '').replace(/\.bsp$/i, '');
    this.deps.onLoadStart(base, null, () => void this.playFile(f));
    this.run(() => game.loadMapFile(f), base);
  }

  private run(fn: () => Promise<void>, name: string, after?: () => void): void {
    this.busy = true;
    let p: Promise<void>;
    try {
      p = fn();
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      () => {
        void this.refreshCached();
        try {
          after?.();
        } catch (e) {
          console.error(e);
        }
      },
      (e: Error) => {
        if (e?.name !== 'AbortError') this.deps.onLoadError(name, String(e?.message ?? e));
      },
    ).finally(() => {
      this.busy = false;
    });
  }
}

/** The local personal best on the main course (records are best-effort: never let them break the browser). */
/** Lower-case names of catalog maps with a local personal best on any course. */
function completedSet(catalog: readonly CatalogEntry[]): Set<string> {
  const out = new Set<string>();
  try {
    for (const e of catalog) if (getRecords(e.name, 0).length) out.add(e.name.toLowerCase());
  } catch {
    /* records unavailable */
  }
  return out;
}

function personalBest(name: string): { time: number; completions: number } | null {
  try {
    const pb = getPersonalBest(name, 0);
    return pb ? { time: pb.time, completions: getCompletions(name, 0) } : null;
  } catch {
    return null;
  }
}

function pbText(name: string): HTMLElement {
  const pb = personalBest(name);
  if (!pb) return h('span.muted', { text: 'Not completed yet' });
  return h('span', null, h('b.pb-time.tnum', { text: formatTime(pb.time) }), ` · ${pb.completions} completion${pb.completions === 1 ? '' : 's'}`);
}

function cardPb(name: string): HTMLElement | null {
  const pb = personalBest(name);
  return pb ? h('span.card-pb.tnum', { text: `PB ${formatTimeShort(pb.time)}`, title: 'Your personal best' }) : null;
}

function remPx(): number {
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs : 16;
}

function tierBlurb(t: number): string {
  return ['', 'Very easy', 'Easy', 'Medium', 'Hard', 'Very hard', 'Death', 'Expert', 'Insane'][t] ?? '';
}

function layoutBlurb(type: CatalogEntry['type']): string {
  switch (type) {
    case 'linear':
      return 'Linear — one continuous run with checkpoints';
    case 'staged':
      return 'Staged — separate stages, !s to pick one';
    case 'staged-linear':
      return 'Staged-linear — stages connected without teleports';
    default:
      return 'Unknown';
  }
}
