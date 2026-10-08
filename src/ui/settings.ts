// Settings: Game / Mouse / Video / Audio / Crosshair / HUD / Binds. Every control is bound to a cvar
// (read on build, set on input, refreshed through console_.onCvarChange) and changes are persisted.
import { console_, execute } from '../core/cvars';
import type { SoundApi } from '../game/api';
import {
  type GameContentStatus,
  getGameContentStatus,
  isGameFolderPickerSupported,
  linkGameContentFromFiles,
  onGameContentChange,
  pickGameContentFolder,
  requestGameContentPermission,
  restoreGameContent,
  unlinkGameContent,
} from '../maps/gamecontent';
import { BindsEditor } from './bindseditor';
import { deleteCfg, listCfgs } from './cfgfiles';
import { cvarGetter, cvarNum, cvarStr, customPhysicsActive, persistConfigSoon, PHYSICS_CVARS, setCvar } from './cvardefs';
import { clear, h, storageGet, storageSet } from './dom';
import { cmPer360, fmtNum } from './format';
import { CROSSHAIR_PRESET_COLORS, CROSSHAIR_STYLE_NAMES, crosshairGeometry, drawCrosshair, exportCrosshairConfig, parseCrosshairConfig, readCrosshairParams } from './crosshair';
import { encodeCrosshairShareCode, shareCodeErrorText, shareDataFromCvars } from './crosshaircode';
import { HUD_COLOR_NAMES, HUD_COLORS } from './hud';
import { icon, type IconName } from './icons';

export type SettingsTab = 'game' | 'mouse' | 'video' | 'audio' | 'crosshair' | 'hud' | 'binds';

/** Raw mouse input: active (unadjusted movement), unsupported (browser fell back to a plain lock), off, unknown. */
export type RawInputStatus = 'active' | 'unsupported' | 'off' | 'unknown';

export interface SettingsDeps {
  sound: SoundApi;
  toast: (msg: string, kind?: 'info' | 'error' | 'success') => void;
  confirm: (title: string, text: string, ok: string) => Promise<boolean>;
  /** Whether the pointer lock got raw (unadjusted) movement. */
  rawInputStatus?: () => RawInputStatus;
  /** Opens the .cfg import (file picker). */
  importCfg?: () => void;
  /** Runs `exec <name>`. */
  execCfg?: (name: string) => void;
}

const RAW_INPUT_TEXT: Record<RawInputStatus, string> = {
  active: 'Raw input: active — mouse counts reach the game unaccelerated, like CS:GO with m_rawinput 1.',
  unsupported:
    'Raw input: not supported by this browser — OS pointer speed and acceleration apply. For CS:GO-identical sensitivity turn off Windows “Enhance pointer precision” and keep display scaling at 100%, or play in Chrome / Edge.',
  off: 'Raw input: off — the OS pointer speed and acceleration apply.',
  unknown: 'Raw input: not checked yet — it is tested when the game captures the mouse.',
};

export const TICKRATE_PRESETS = ['64', '85.3', '100', '102.4', '128'];
const DPI_KEY = 'surf.ui.dpi';
const TAB_KEY = 'surf.ui.settingsTab';

type Refresher = () => void;

export class Settings {
  readonly el: HTMLElement;
  private readonly tabs = new Map<SettingsTab, HTMLButtonElement>();
  private readonly panes = new Map<SettingsTab, HTMLElement>();
  private readonly refreshers = new Map<string, Refresher[]>();
  private readonly anyRefreshers: Refresher[] = [];
  private tab: SettingsTab = 'game';
  private built = false;
  private readonly binds: BindsEditor;
  private previewCanvas: HTMLCanvasElement | null = null;
  /** Cvars controlled by each tab (for "Reset tab"). */
  private readonly tabCvars = new Map<SettingsTab, Set<string>>();
  private building: SettingsTab | null = null;
  private resetBtn!: HTMLButtonElement;
  private previewBg = 0;
  private previewZoom = 1;
  private cfgList: HTMLElement | null = null;
  private rawStatusEl: HTMLElement | null = null;

  constructor(private readonly deps: SettingsDeps) {
    this.binds = new BindsEditor({ sound: deps.sound, toast: deps.toast, confirm: deps.confirm });
    this.el = h('div.page-frame.panel.settings.interactive');
    const tabsEl = h('div.tabs');
    const tabDefs: [SettingsTab, string, IconName][] = [
      ['game', 'Game', 'game'],
      ['mouse', 'Mouse', 'mouse'],
      ['video', 'Video', 'monitor'],
      ['audio', 'Audio', 'sound'],
      ['crosshair', 'Crosshair', 'crosshair'],
      ['hud', 'HUD', 'hud'],
      ['binds', 'Binds', 'bind'],
    ];
    for (const [id, label, ic] of tabDefs) {
      const b = h('button.tab', { attrs: { type: 'button' } }, icon(ic), h('span', { text: label })) as HTMLButtonElement;
      b.addEventListener('click', () => this.show(id, true));
      b.addEventListener('mouseenter', () => deps.sound.play('ui_hover'));
      this.tabs.set(id, b);
      tabsEl.appendChild(b);
    }
    const body = h('div.settings-body');
    for (const [id] of tabDefs) {
      const pane = h(`div.set-pane.pane-${id}`);
      this.panes.set(id, pane);
      body.appendChild(pane);
    }
    this.resetBtn = h('button.btn.btn-sm.btn-ghost.settings-reset', { attrs: { type: 'button', title: 'Restore the defaults of every setting on this tab' } }, icon('restart'), 'Reset tab') as HTMLButtonElement;
    this.resetBtn.addEventListener('click', () => void this.resetTab());
    this.el.append(h('div.browser-head.settings-head', null, tabsEl, h('div.settings-note', null, icon('check'), 'Changes apply instantly and are saved'), this.resetBtn), body);
    console_.onCvarChange((cv) => {
      const list = this.refreshers.get(cv.name);
      if (list) for (const fn of list) fn();
      for (const fn of this.anyRefreshers) fn();
      if (cv.name === 'crosshair' || cv.name.startsWith('cl_crosshair')) this.drawPreview();
    });
    window.addEventListener('resize', () => this.drawPreview());
    document.addEventListener('pointerlockchange', () => this.refreshRawInput());
    const saved = storageGet(TAB_KEY) as SettingsTab | null;
    this.tab = saved && this.tabs.has(saved) ? saved : 'game';
  }

  /** Builds all panes (lazily: cvars must be registered first). */
  build(): void {
    if (this.built) return;
    this.built = true;
    const build = (tab: SettingsTab, fn: (p: HTMLElement) => void) => {
      this.building = tab;
      this.tabCvars.set(tab, new Set());
      fn(this.panes.get(tab)!);
      this.building = null;
    };
    build('game', (p) => this.buildGame(p));
    build('mouse', (p) => this.buildMouse(p));
    build('video', (p) => this.buildVideo(p));
    build('audio', (p) => this.buildAudio(p));
    build('crosshair', (p) => this.buildCrosshair(p));
    build('hud', (p) => this.buildHud(p));
    this.panes.get('binds')!.appendChild(this.binds.el);
    this.show(this.tab, false);
  }

  show(tab: SettingsTab, user: boolean): void {
    this.build();
    if (user && tab !== this.tab) this.deps.sound.play('ui_click');
    this.tab = tab;
    storageSet(TAB_KEY, tab);
    for (const [id, b] of this.tabs) b.classList.toggle('active', id === tab);
    for (const [id, p] of this.panes) p.classList.toggle('active', id === tab);
    this.resetBtn.classList.toggle('hidden', tab === 'binds');
    if (tab === 'binds') this.binds.refresh();
    if (tab === 'crosshair') requestAnimationFrame(() => this.drawPreview());
    if (tab === 'mouse') this.refreshRawInput();
    if (tab === 'game') this.refreshCfgs();
  }

  get currentTab(): SettingsTab {
    return this.tab;
  }

  /** True while the binds editor waits for a key. */
  get capturing(): boolean {
    return this.binds.capturing;
  }

  cancelCapture(): boolean {
    return this.binds.cancelCapture();
  }

  // ------------------------------------------------------------ control builders

  private watch(name: string, fn: Refresher): void {
    if (this.building && console_.getCvar(name)) this.tabCvars.get(this.building)!.add(name);
    let list = this.refreshers.get(name);
    if (!list) this.refreshers.set(name, (list = []));
    list.push(fn);
    fn();
  }

  private changed(name: string, value: string | number | boolean): void {
    const r = setCvar(name, value);
    if (r === 'cheat') this.deps.toast(`${name} is cheat protected — set sv_cheats 1 first`, 'error');
    else if (r === 'unknown') this.deps.toast(`Unknown setting ${name}`, 'error');
    persistConfigSoon();
  }

  private group(parent: HTMLElement, title: string, desc?: string): HTMLElement {
    const g = h('section.set-group', null, h('h4', { text: title }), desc ? h('p.set-group-desc', { text: desc }) : null);
    parent.appendChild(g);
    return g;
  }

  private row(parent: HTMLElement, label: string, desc: string | null, control: HTMLElement, cvarName?: string): HTMLElement {
    const r = h(
      'div.set-row',
      null,
      h('div.set-label', null, h('div.set-name', { text: label }), desc ? h('div.set-desc', { text: desc }) : null, cvarName ? h('code.set-cvar', { text: cvarName }) : null),
      h('div.set-control', null, control),
    );
    parent.appendChild(r);
    return r;
  }

  private slider(name: string, o: { min: number; max: number; step: number; decimals?: number; format?: (v: number) => string; parse?: (s: string) => number; toCvar?: (v: number) => number; fromCvar?: (v: number) => number }): HTMLElement {
    const dec = o.decimals ?? 2;
    const toCvar = o.toCvar ?? ((v: number) => v);
    const fromCvar = o.fromCvar ?? ((v: number) => v);
    const range = h('input.slider', { attrs: { type: 'range', min: o.min, max: o.max, step: o.step } }) as HTMLInputElement;
    const num = h('input.input.num-input', { attrs: { type: 'text', inputmode: 'decimal', spellcheck: 'false' } }) as HTMLInputElement;
    const fmt = o.format ?? ((v: number) => fmtNum(v, dec));
    const setFill = (v: number) => range.style.setProperty('--fill', `${(Math.max(0, Math.min(1, (v - o.min) / (o.max - o.min))) * 100).toFixed(2)}%`);
    range.addEventListener('input', () => {
      const v = parseFloat(range.value);
      num.value = fmt(v);
      setFill(v);
      this.changed(name, fmtNum(toCvar(v), 6));
    });
    const commit = () => {
      const v = o.parse ? o.parse(num.value) : parseFloat(num.value);
      if (!Number.isFinite(v)) {
        num.value = fmt(fromCvar(cvarNum(name)));
        return;
      }
      this.changed(name, fmtNum(toCvar(v), 6));
      // re-format even when the value didn't change (or was clamped to the same value)
      num.value = fmt(fromCvar(cvarNum(name)));
    };
    num.addEventListener('change', commit);
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit();
        num.blur();
      }
    });
    this.watch(name, () => {
      const v = fromCvar(cvarNum(name));
      if (document.activeElement !== range) range.value = String(v);
      if (document.activeElement !== num) num.value = fmt(v);
      setFill(v);
    });
    return h('div.slider-wrap', null, range, num);
  }

  private toggle(name: string, opts: { invert?: boolean; on?: string; off?: string } = {}): HTMLElement {
    const input = h('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
    const sw = h('label.switch', null, input, h('span.knob'));
    const on = opts.on ?? '1';
    const off = opts.off ?? '0';
    input.addEventListener('change', () => {
      this.deps.sound.play('ui_click');
      const checked = opts.invert ? !input.checked : input.checked;
      this.changed(name, checked ? on : off);
    });
    this.watch(name, () => {
      const v = cvarNum(name) !== 0;
      input.checked = opts.invert ? !v : v;
    });
    return sw;
  }

  private select(name: string, options: [string, string][]): HTMLElement {
    const sel = h('select.select') as HTMLSelectElement;
    for (const [v, l] of options) sel.appendChild(h('option', { text: l, attrs: { value: v } }));
    sel.addEventListener('change', () => this.changed(name, sel.value));
    this.watch(name, () => {
      const cur = cvarStr(name);
      const match = options.find(([v]) => parseFloat(v) === parseFloat(cur) || v === cur);
      if (match) sel.value = match[0];
      else {
        let o = sel.querySelector('option[data-custom]') as HTMLOptionElement | null;
        if (!o) {
          o = h('option', { attrs: { 'data-custom': '1' } }) as HTMLOptionElement;
          sel.appendChild(o);
        }
        o.value = cur;
        o.textContent = `Custom (${cur})`;
        sel.value = cur;
      }
    });
    return sel;
  }

  private segmented(name: string, options: [string, string][]): HTMLElement {
    const el = h('div.segmented');
    const buttons: [string, HTMLButtonElement][] = [];
    for (const [v, l] of options) {
      const b = h('button', { text: l, attrs: { type: 'button' } }) as HTMLButtonElement;
      b.addEventListener('click', () => {
        this.deps.sound.play('ui_click');
        this.changed(name, v);
      });
      buttons.push([v, b]);
      el.appendChild(b);
    }
    this.watch(name, () => {
      const cur = parseFloat(cvarStr(name));
      for (const [v, b] of buttons) b.classList.toggle('active', Math.abs(parseFloat(v) - cur) < 1e-6);
    });
    return el;
  }

  private numberInput(name: string, decimals = 3): HTMLElement {
    const num = h('input.input.num-input', { attrs: { type: 'text', inputmode: 'decimal', spellcheck: 'false' } }) as HTMLInputElement;
    const commit = () => {
      const v = parseFloat(num.value);
      if (!Number.isFinite(v)) {
        num.value = cvarStr(name);
        return;
      }
      this.changed(name, fmtNum(v, 6));
      num.value = fmtNum(cvarNum(name), decimals);
    };
    num.addEventListener('change', commit);
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit();
        num.blur();
      }
    });
    this.watch(name, () => {
      if (document.activeElement !== num) num.value = fmtNum(cvarNum(name), decimals);
    });
    return num;
  }

  // ------------------------------------------------------------ panes

  private buildGame(p: HTMLElement): void {
    const inner = h('div.set-col');
    p.appendChild(inner);
    const server = this.group(inner, 'Server');
    this.row(server, 'Tickrate', 'Simulation rate. CS:GO surf servers (KSF, SurfTimer) run 100 tick.', this.segmented('tickrate', TICKRATE_PRESETS.map((t) => [t, t])), 'tickrate');

    const phys = this.group(inner, 'Physics', 'Movement convars, exactly as a CS:GO surf server sets them (SurfTimer main.cfg).');
    const warn = h('div.set-warning', null, icon('warning'), h('span', { text: 'Custom physics: runs are unranked and no personal bests or records are saved.' }));
    const presetSel = h('select.select') as HTMLSelectElement;
    presetSel.append(h('option', { text: 'CS:GO Surf — server default', attrs: { value: 'default' } }), h('option', { text: 'Custom', attrs: { value: 'custom' } }));
    presetSel.addEventListener('change', () => {
      if (presetSel.value === 'default') this.resetPhysics();
    });
    const refreshPreset = () => {
      const custom = customPhysicsActive();
      presetSel.value = custom ? 'custom' : 'default';
      warn.classList.toggle('hidden', !custom);
    };
    this.anyRefreshers.push(refreshPreset);
    this.row(phys, 'Preset', null, presetSel);
    phys.appendChild(warn);
    const grid = h('div.phys-grid');
    for (const d of PHYSICS_CVARS) {
      const cv = console_.getCvar(d.name);
      if (!cv) continue;
      const isBool = d.name === 'sv_autobunnyhopping' || d.name === 'sv_enablebunnyhopping' || d.name === 'sv_rampbugfix';
      const ctl = isBool ? this.toggle(d.name) : this.numberInput(d.name, 6);
      const defEl = h('span.phys-def');
      const cell = h('div.phys-cell', { attrs: { title: d.help ?? cv.help } }, h('code', { text: d.name }), defEl, ctl);
      this.watch(d.name, () => {
        const isDef = parseFloat(cv.value) === parseFloat(cv.defaultValue);
        defEl.textContent = isDef ? '' : `default ${cv.defaultValue}`;
        cell.classList.toggle('modified', !isDef);
      });
      grid.appendChild(cell);
    }
    phys.appendChild(grid);
    const resetBtn = h('button.btn.btn-sm', { attrs: { type: 'button' } }, icon('restart'), 'Reset physics to default');
    resetBtn.addEventListener('click', () => this.resetPhysics());
    phys.appendChild(h('div.set-actions', null, resetBtn));
    refreshPreset();

    const play = this.group(inner, 'Gameplay');
    this.row(play, 'Field of view', 'Horizontal degrees at 4:3, like CS:GO (default 90). Wider screens see more.', this.slider('fov_desired', { min: 60, max: 130, step: 1, decimals: 0 }), 'fov_desired');

    const cfg = this.group(inner, 'Config files', 'Bring your CS:GO autoexec.cfg and other configs: binds, sensitivity, crosshair and aliases work like in CS:GO. Run one with exec <name> in the console; autoexec.cfg runs every time the game starts.');
    const importBtn = h('button.btn.btn-sm', { attrs: { type: 'button' } }, icon('upload'), 'Import .cfg');
    importBtn.addEventListener('click', () => this.deps.importCfg?.());
    importBtn.classList.toggle('hidden', !this.deps.importCfg);
    this.cfgList = h('div.cfg-list');
    cfg.append(this.cfgList, h('div.set-actions', null, importBtn, h('span.muted.cfg-hint', { text: 'or drop .cfg files onto the game, or paste their lines into the console' })));
    this.refreshCfgs();
  }

  /** Re-lists the saved config files (Settings → Game). */
  refreshCfgs(): void {
    const list = this.cfgList;
    if (!list) return;
    const cfgs = listCfgs();
    if (!cfgs.length) {
      list.replaceChildren(h('div.cfg-empty.muted', { text: 'No config files imported yet.' }));
      return;
    }
    list.replaceChildren(
      ...cfgs.map((c) => {
        const exec = h('button.btn.btn-sm', { attrs: { type: 'button', title: `exec ${c.name}` } }, icon('play'), 'Exec');
        exec.addEventListener('click', () => {
          this.deps.execCfg?.(c.name);
          this.deps.toast(`Executed ${c.name}.cfg`, 'success');
        });
        exec.classList.toggle('hidden', !this.deps.execCfg);
        const del = h('button.btn.btn-sm.btn-ghost.btn-icon', { attrs: { type: 'button', title: `Delete ${c.name}.cfg` } }, icon('trash'));
        del.addEventListener('click', () => {
          void this.deps.confirm(`Delete ${c.name}.cfg`, `Remove the saved config ${c.name}.cfg? Settings it already applied stay as they are.`, 'Delete').then((ok) => {
            if (!ok) return;
            deleteCfg(c.name);
            this.refreshCfgs();
          });
        });
        return h(
          'div.cfg-item',
          null,
          h('code.cfg-file', { text: `${c.name}.cfg` }),
          h('span.cfg-meta.muted', { text: `${c.commands} command${c.commands === 1 ? '' : 's'}${c.name === 'autoexec' ? ' · runs at startup' : ''}` }),
          h('span.spacer'),
          exec,
          del,
        );
      }),
    );
  }

  /** Updates the raw input status line (Settings → Mouse). */
  refreshRawInput(): void {
    const el = this.rawStatusEl;
    if (!el) return;
    const st = this.deps.rawInputStatus?.() ?? 'unknown';
    el.textContent = RAW_INPUT_TEXT[st];
    el.className = `set-status raw-${st}`;
  }

  private async resetTab(): Promise<void> {
    const names = [...(this.tabCvars.get(this.tab) ?? [])];
    if (!names.length) return;
    const label = this.tabs.get(this.tab)?.textContent ?? this.tab;
    const ok = await this.deps.confirm(`Reset ${label}`, `Restore the default value of all ${names.length} ${label.toLowerCase()} settings?`, 'Reset');
    if (!ok) return;
    for (const n of names) console_.getCvar(n)?.reset();
    persistConfigSoon();
    this.deps.toast(`${label} settings reset to defaults`, 'success');
  }

  private resetPhysics(): void {
    for (const d of PHYSICS_CVARS) console_.getCvar(d.name)?.reset();
    persistConfigSoon();
    this.deps.toast('Physics reset to the CS:GO surf defaults', 'success');
  }

  private buildMouse(p: HTMLElement): void {
    const inner = h('div.set-col');
    p.appendChild(inner);
    const g = this.group(inner, 'Mouse', 'Sensitivity uses the same units as CS:GO — enter your CS:GO sensitivity and m_yaw and it feels identical.');
    this.row(g, 'Sensitivity', 'Same scale as CS:GO (degrees per count = sensitivity × m_yaw).', this.slider('sensitivity', { min: 0.1, max: 8, step: 0.01, decimals: 3 }), 'sensitivity');
    // cm/360 calculator (DPI is only used for the readout)
    const dpiInput = h('input.input.num-input', { attrs: { type: 'text', inputmode: 'numeric' } }) as HTMLInputElement;
    dpiInput.value = storageGet(DPI_KEY) ?? '800';
    const readout = h('span.cm360');
    const upd = () => {
      const dpi = parseFloat(dpiInput.value);
      const cm = cmPer360(cvarNum('sensitivity', 2.5), cvarNum('m_yaw', 0.022), dpi);
      readout.textContent = Number.isFinite(cm) ? `${cm.toFixed(1)} cm/360°  ·  ${(cm / 2.54).toFixed(1)} in/360°  ·  eDPI ${Math.round(dpi * cvarNum('sensitivity', 2.5))}` : '—';
    };
    dpiInput.addEventListener('input', () => {
      storageSet(DPI_KEY, dpiInput.value);
      upd();
    });
    this.watch('sensitivity', upd);
    this.watch('m_yaw', upd);
    this.row(g, 'Mouse DPI', 'Only used to show your cm/360.', h('div.dpi-wrap', null, dpiInput, readout));
    this.row(g, 'Yaw factor', 'Degrees per count horizontally (CS:GO default 0.022).', this.numberInput('m_yaw', 4), 'm_yaw');
    this.row(g, 'Pitch factor', 'Degrees per count vertically (CS:GO default 0.022).', this.numberInput('m_pitch', 4), 'm_pitch');
    const invert = h('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
    invert.addEventListener('change', () => {
      const v = Math.abs(cvarNum('m_pitch', 0.022)) * (invert.checked ? -1 : 1);
      this.changed('m_pitch', fmtNum(v, 6));
    });
    this.watch('m_pitch', () => (invert.checked = cvarNum('m_pitch', 0.022) < 0));
    this.row(g, 'Invert mouse', null, h('label.switch', null, invert, h('span.knob')));
    const rawRow = this.row(g, 'Raw input', 'Unaccelerated pointer-lock movement when the browser supports it.', this.toggle('m_rawinput'), 'm_rawinput');
    this.rawStatusEl = h('div.set-status');
    rawRow.querySelector('.set-label')?.appendChild(this.rawStatusEl);
    this.watch('m_rawinput', () => this.refreshRawInput());
    this.row(g, 'Mouse acceleration', 'Classic Source m_customaccel.', this.toggle('m_customaccel'), 'm_customaccel');
  }

  private buildVideo(p: HTMLElement): void {
    const inner = h('div.set-col');
    p.appendChild(inner);
    const d = this.group(inner, 'Display');
    const fs = h('button.btn.btn-sm', { attrs: { type: 'button' } }, icon('fullscreen'), 'Toggle fullscreen');
    fs.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else void document.documentElement.requestFullscreen?.().catch(() => undefined);
    });
    this.row(d, 'Fullscreen', null, fs);
    this.row(
      d,
      'Render scale',
      'Resolution of the 3D view. Lower for more FPS on slow GPUs.',
      this.slider('r_renderscale', { min: 0.25, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, parse: (s) => parseFloat(s) / (s.includes('%') || parseFloat(s) > 2 ? 100 : 1) }),
      'r_renderscale',
    );
    this.row(
      d,
      'FPS limit',
      null,
      this.select('fps_max', [
        ['0', 'Unlimited'],
        ['60', '60'],
        ['120', '120'],
        ['144', '144'],
        ['165', '165'],
        ['240', '240'],
        ['360', '360'],
      ]),
      'fps_max',
    );
    this.row(
      d,
      'Show FPS',
      null,
      this.select('cl_showfps', [
        ['0', 'Off'],
        ['1', 'On'],
      ]),
      'cl_showfps',
    );
    const q = this.group(inner, 'Quality');
    this.row(
      q,
      'Texture filtering',
      null,
      this.select('r_anisotropy', [
        ['1', 'Bilinear'],
        ['2', 'Anisotropic 2x'],
        ['4', 'Anisotropic 4x'],
        ['8', 'Anisotropic 8x'],
        ['16', 'Anisotropic 16x'],
      ]),
      'r_anisotropy',
    );
    this.row(q, 'Brightness', null, this.slider('r_brightness', { min: 0.5, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, parse: (s) => parseFloat(s) / (s.includes('%') || parseFloat(s) > 3 ? 100 : 1) }), 'r_brightness');
    this.row(q, 'Fog', 'Map fog (env_fog_controller).', this.toggle('fog_enable'), 'fog_enable');
    this.row(q, '3D skybox', 'Draw the map’s 3D skybox.', this.toggle('r_3dsky'), 'r_3dsky');
    this.row(q, 'Fullbright', 'Ignore lightmaps (mat_fullbright 1).', this.toggle('mat_fullbright'), 'mat_fullbright');
    this.buildGameContent(inner);
    const o = this.group(inner, 'Overlays');
    this.row(
      o,
      'Zone beams',
      'Timer zones (start, end, stages, checkpoints): beams on the floor like SurfTimer servers, or the full box.',
      this.segmented('r_drawzones', [
        ['0', 'Off'],
        ['1', 'Floor outline'],
        ['2', 'Full box'],
      ]),
      'r_drawzones',
    );
    this.row(o, 'Show triggers', 'Teleports, boosters and other trigger volumes.', this.toggle('r_drawtriggers'), 'r_drawtriggers');
    this.row(o, 'Show player clips', null, this.toggle('r_drawclips'), 'r_drawclips');
    this.row(o, 'Wireframe', 'Requires sv_cheats 1.', this.toggle('mat_wireframe'), 'mat_wireframe');
  }

  /** Video → Game textures: link the player's CS:S / CS:GO install for the stock textures maps don't pack. */
  private buildGameContent(parent: HTMLElement): void {
    const g = this.group(
      parent,
      'Game textures',
      'Maps use stock Counter-Strike textures they don’t pack. Link your Counter-Strike: Source or CS:GO install folder and they load exactly like in game — read from your disk, nothing is uploaded. Without it, generated stand-ins are used.',
    );
    const status = h('div.set-status.gc-status');
    const link = h('button.btn.btn-sm', { attrs: { type: 'button', title: 'Pick e.g. steamapps/common/Counter-Strike Source' } }, icon('upload'), 'Link game folder…') as HTMLButtonElement;
    const allow = h('button.btn.btn-sm.btn-accent', { attrs: { type: 'button' } }, icon('check'), 'Allow access') as HTMLButtonElement;
    const unlink = h('button.btn.btn-sm.btn-ghost', { attrs: { type: 'button' } }, icon('close'), 'Unlink') as HTMLButtonElement;
    // browsers without showDirectoryPicker: pick the folder's files (this visit only)
    const files = h('input.hidden', { attrs: { type: 'file', multiple: true, webkitdirectory: true } }) as HTMLInputElement;
    let busy = false;
    const render = (st: GameContentStatus) => {
      const text =
        busy && st.state !== 'linked'
          ? 'Reading the folder…'
          : st.state === 'linked'
            ? `Linked: ${st.label ?? 'game folder'}${st.archives?.length ? ` — ${st.archives.join(', ')}` : ''}${st.files ? ` (${st.files.toLocaleString('en-US')} files)` : ''}. Applies to maps loaded from now on.${st.message ? ` ${st.message}` : ''}`
            : st.state === 'needs-permission'
              ? (st.message ?? `Allow access to "${st.label ?? 'your game folder'}" to use its textures.`)
              : st.state === 'error'
                ? (st.message ?? 'The game folder could not be read.')
                : `Not linked. Pick the game folder, e.g. steamapps/common/Counter-Strike Source or Counter-Strike Global Offensive.${isGameFolderPickerSupported() ? '' : ' (This browser links it for this visit only.)'}`;
      status.textContent = text;
      status.className = `set-status gc-status gc-${busy && st.state !== 'linked' ? 'busy' : st.state}`;
      allow.classList.toggle('hidden', st.state !== 'needs-permission');
      unlink.classList.toggle('hidden', st.state === 'none' && !st.label);
      link.lastChild!.textContent = st.state === 'linked' ? 'Change folder…' : 'Link game folder…';
      link.disabled = allow.disabled = busy;
    };
    const run = async (fn: () => Promise<GameContentStatus>) => {
      busy = true;
      render(getGameContentStatus());
      try {
        const st = await fn();
        busy = false;
        render(st);
        if (st.state === 'linked') this.deps.toast(`Game textures linked from ${st.label ?? 'your game folder'} — they load with the next map`, 'success');
        else if (st.state === 'error' && st.message) this.deps.toast(st.message, 'error');
      } catch (e) {
        busy = false;
        render(getGameContentStatus());
        this.deps.toast(`Couldn't link the folder: ${(e as Error)?.message ?? e}`, 'error');
      }
    };
    link.addEventListener('click', () => {
      if (isGameFolderPickerSupported()) void run(() => pickGameContentFolder());
      else files.click();
    });
    files.addEventListener('change', () => {
      const list = files.files ? [...files.files] : [];
      files.value = '';
      if (list.length) void run(() => linkGameContentFromFiles(list));
    });
    allow.addEventListener('click', () => void run(() => requestGameContentPermission()));
    unlink.addEventListener('click', () => {
      void unlinkGameContent().then(() => this.deps.toast('Game folder unlinked — stand-in textures from the next map on', 'info'));
    });
    onGameContentChange((st) => render(st));
    render(getGameContentStatus());
    const r = this.row(g, 'CS:S / CS:GO folder', null, h('div.inline', null, allow, link, unlink, files));
    r.querySelector('.set-label')?.appendChild(status);
    // reopen the folder remembered from an earlier visit (one IndexedDB read; asks for nothing)
    void restoreGameContent().catch(() => undefined);
  }

  private buildAudio(p: HTMLElement): void {
    const inner = h('div.set-col');
    p.appendChild(inner);
    const g = this.group(inner, 'Audio', 'All sounds are synthesized in your browser.');
    this.row(g, 'Master volume', null, this.slider('volume', { min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, parse: (s) => parseFloat(s) / (s.includes('%') || parseFloat(s) > 1 ? 100 : 1) }), 'volume');
    this.row(g, 'Mute when unfocused', 'Silence the game when the tab or window loses focus.', this.toggle('snd_mute_losefocus'), 'snd_mute_losefocus');
    this.row(g, 'Chat sounds', 'Blip on new chat messages.', this.toggle('surf_chat_sounds'), 'surf_chat_sounds');
    const test = h('div.sound-tests');
    for (const [name, label] of [
      ['zone_leave', 'Timer start'],
      ['checkpoint', 'Checkpoint'],
      ['stage', 'Stage'],
      ['pb', 'Personal best'],
      ['wr', 'Record'],
      ['booster', 'Booster'],
    ] as const) {
      const b = h('button.btn.btn-sm', { attrs: { type: 'button' } }, icon('sound'), label);
      b.addEventListener('click', () => {
        this.deps.sound.unlock();
        this.deps.sound.play(name);
      });
      test.appendChild(b);
    }
    this.row(g, 'Test sounds', null, test);
  }

  private buildHud(p: HTMLElement): void {
    const inner = h('div.set-col');
    p.appendChild(inner);
    const g = this.group(inner, 'HUD');
    this.row(g, 'HUD scale', 'CS:GO hud_scaling (0.5 – 0.95).', this.slider('hud_scaling', { min: 0.5, max: 0.95, step: 0.01 }), 'hud_scaling');
    const colorSel = this.select(
      'cl_hud_color',
      HUD_COLOR_NAMES.map((n, i) => [String(i), n]),
    );
    const swatch = h('span.hud-swatch');
    this.watch('cl_hud_color', () => swatch.style.setProperty('background', HUD_COLORS[Math.trunc(cvarNum('cl_hud_color'))] ?? HUD_COLORS[0]));
    this.row(g, 'HUD color', null, h('div.inline', null, swatch, colorSel), 'cl_hud_color');
    this.row(g, 'Draw HUD', null, this.toggle('cl_drawhud'), 'cl_drawhud');
    const s = this.group(inner, 'Surf timer');
    this.row(s, 'Timer panel', 'SurfTimer-style timer, speed, stage and records.', this.toggle('surf_hud_timer'), 'surf_hud_timer');
    this.row(s, 'Speedometer', 'Large speed readout under the crosshair.', this.toggle('surf_hud_speed'), 'surf_hud_speed');
    this.row(s, 'Speedometer colors', 'Green while gaining speed, red while losing it.', this.toggle('surf_speedometer_color'), 'surf_speedometer_color');
    this.row(s, 'Show keys', 'Display WASD / jump / duck and mouse turning.', this.toggle('surf_showkeys'), 'surf_showkeys');
    this.row(s, 'PB ghost', 'Race a ghost of your personal best replay.', this.toggle('surf_ghost'), 'surf_ghost');
    this.row(s, 'Ghost trail', 'Draw a trail behind the ghost.', this.toggle('surf_ghost_trail'), 'surf_ghost_trail');
    this.row(s, 'Hide players', 'Hide other players and replay bots (!hide).', this.toggle('surf_hide'), 'surf_hide');
    const dbg = this.group(inner, 'Debug');
    this.row(
      dbg,
      'Net graph',
      'CS:GO net_graph: fps, frame time variance and tickrate.',
      this.select('net_graph', [
        ['0', 'Off'],
        ['1', 'On'],
      ]),
      'net_graph',
    );
    this.row(
      dbg,
      'Show position',
      'Source cl_showpos: position, angles and velocity.',
      this.select('cl_showpos', [
        ['0', 'Off'],
        ['1', 'On'],
      ]),
      'cl_showpos',
    );
  }

  // ------------------------------------------------------------ crosshair

  private buildCrosshair(p: HTMLElement): void {
    const canvas = h('canvas.xh-canvas') as HTMLCanvasElement;
    this.previewCanvas = canvas;
    const bgSeg = h('div.segmented.xh-bg');
    ['Sky', 'Ramp', 'Dark', 'Bright'].forEach((l, i) => {
      const b = h('button', { text: l, attrs: { type: 'button' } });
      if (i === this.previewBg) b.classList.add('active');
      b.addEventListener('click', () => {
        this.previewBg = i;
        for (const c of bgSeg.children) c.classList.remove('active');
        b.classList.add('active');
        this.drawPreview();
      });
      bgSeg.appendChild(b);
    });
    const zoomSeg = h('div.segmented.xh-zoom');
    [1, 2, 4].forEach((z) => {
      const b = h('button', { text: `${z}×`, attrs: { type: 'button' } });
      if (z === this.previewZoom) b.classList.add('active');
      b.addEventListener('click', () => {
        this.previewZoom = z;
        for (const c of zoomSeg.children) c.classList.remove('active');
        b.classList.add('active');
        this.drawPreview();
      });
      zoomSeg.appendChild(b);
    });
    const previewInfo = h('div.xh-info');
    const preview = h('div.xh-preview', null, h('div.xh-stage', null, canvas), h('div.xh-tools', null, bgSeg, zoomSeg, previewInfo));

    // paste / copy config or a CS:GO share code
    const ta = h('textarea.input.xh-paste', {
      attrs: { rows: 4, placeholder: 'CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx share code, or config lines:\ncl_crosshairsize 2; cl_crosshairgap -3; cl_crosshairthickness 0.5; cl_crosshaircolor 1 …', spellcheck: 'false' },
    }) as HTMLTextAreaElement;
    const apply = h('button.btn.btn-accent.btn-sm', { attrs: { type: 'button' } }, icon('check'), 'Apply');
    apply.addEventListener('click', () => {
      const parsed = parseCrosshairConfig(ta.value);
      // CS:GO configs also carry cl_crosshair_dynamic_* & co. which have no effect on a static crosshair
      const known = parsed.commands.filter((c) => console_.getCvar(c.split(' ')[0]));
      const unused = parsed.commands.length - known.length;
      if (!known.length) {
        const bad = parsed.shareCodeErrors[0];
        this.deps.toast(bad ? shareCodeErrorText(bad.error) : 'No crosshair share code or cl_crosshair* settings found in the pasted text', 'error');
        return;
      }
      for (const c of known) execute(c);
      persistConfigSoon();
      this.deps.sound.play('ui_click');
      const notes = [
        unused ? `${unused} not used here` : '',
        parsed.ignored.length ? `${parsed.ignored.length} other line${parsed.ignored.length === 1 ? '' : 's'} ignored` : '',
        parsed.shareCodeErrors.length ? `${parsed.shareCodeErrors.length} invalid share code${parsed.shareCodeErrors.length === 1 ? '' : 's'}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const what = parsed.shareCodes.length ? `Applied crosshair ${parsed.shareCodes[parsed.shareCodes.length - 1]}` : `Applied ${known.length} crosshair setting${known.length === 1 ? '' : 's'}`;
      this.deps.toast(`${what}${notes ? ` (${notes})` : ''}`, 'success');
    });
    const copy = h('button.btn.btn-sm', { attrs: { type: 'button', title: 'Copy your crosshair as cl_crosshair* config lines' } }, icon('copy'), 'Copy config');
    copy.addEventListener('click', () => {
      const text = exportCrosshairConfig(cvarGetter);
      ta.value = text;
      void navigator.clipboard?.writeText(text).then(
        () => this.deps.toast('Crosshair config copied to the clipboard', 'success'),
        () => undefined,
      );
    });
    const copyCode = h('button.btn.btn-sm', { attrs: { type: 'button', title: 'Copy your crosshair as a CS:GO share code' } }, icon('copy'), 'Copy code');
    copyCode.addEventListener('click', () => {
      const code = encodeCrosshairShareCode(shareDataFromCvars(cvarGetter));
      ta.value = code;
      void navigator.clipboard?.writeText(code).then(
        () => this.deps.toast(`Share code ${code} copied to the clipboard`, 'success'),
        () => undefined,
      );
    });
    const reset = h('button.btn.btn-sm.btn-ghost', { attrs: { type: 'button' } }, icon('restart'), 'Reset');
    reset.addEventListener('click', () => {
      for (const cv of console_.allCvars()) if (cv.name === 'crosshair' || cv.name.startsWith('cl_crosshair') || cv.name === 'cl_fixedcrosshairgap') cv.reset();
      persistConfigSoon();
    });
    const pasteBox = h(
      'div.xh-pastebox',
      null,
      h('div.xh-paste-title', null, h('b', { text: 'Paste your CS:GO crosshair' }), h('span.muted', { text: 'share code, config.cfg / autoexec lines or a generator one-liner' })),
      ta,
      h('div.set-actions', null, apply, copy, copyCode, reset),
    );
    const left = h('div.xh-left', null, preview, pasteBox);

    // controls
    const controls = h('div.xh-controls');
    const g = this.group(controls, 'Crosshair');
    this.row(g, 'Show crosshair', null, this.toggle('crosshair'), 'crosshair');
    this.row(g, 'Style', null, this.select('cl_crosshairstyle', CROSSHAIR_STYLE_NAMES.map((n, i) => [String(i), `${i} · ${n}`])), 'cl_crosshairstyle');
    this.row(g, 'Size', null, this.slider('cl_crosshairsize', { min: 0, max: 10, step: 0.5, decimals: 1 }), 'cl_crosshairsize');
    this.row(g, 'Thickness', null, this.slider('cl_crosshairthickness', { min: 0, max: 6, step: 0.1, decimals: 1 }), 'cl_crosshairthickness');
    this.row(g, 'Gap', null, this.slider('cl_crosshairgap', { min: -5, max: 5, step: 0.5, decimals: 1 }), 'cl_crosshairgap');
    this.row(g, 'Center dot', null, this.toggle('cl_crosshairdot'), 'cl_crosshairdot');
    if (console_.getCvar('cl_crosshair_t')) this.row(g, 'T style', 'No top line.', this.toggle('cl_crosshair_t'), 'cl_crosshair_t');
    this.row(g, 'Outline', null, this.toggle('cl_crosshair_drawoutline'), 'cl_crosshair_drawoutline');
    this.row(g, 'Outline thickness', null, this.slider('cl_crosshair_outlinethickness', { min: 0, max: 3, step: 0.5, decimals: 1 }), 'cl_crosshair_outlinethickness');
    const c = this.group(controls, 'Color');
    const colorBtns = h('div.xh-colors');
    const presetNames = ['Red', 'Green', 'Yellow', 'Blue', 'Cyan', 'Custom'];
    const btns: HTMLButtonElement[] = [];
    presetNames.forEach((n, i) => {
      const b = h('button.xh-color', { attrs: { type: 'button', title: n } }) as HTMLButtonElement;
      if (i < 5) {
        const [r, gg, bb] = CROSSHAIR_PRESET_COLORS[i];
        b.style.setProperty('--sw', `rgb(${r},${gg},${bb})`);
      } else b.classList.add('custom');
      b.appendChild(h('span', { text: n }));
      b.addEventListener('click', () => {
        this.deps.sound.play('ui_click');
        this.changed('cl_crosshaircolor', String(i));
      });
      btns.push(b);
      colorBtns.appendChild(b);
    });
    const rgbRows: HTMLElement[] = [];
    this.row(c, 'Preset', null, colorBtns, 'cl_crosshaircolor');
    rgbRows.push(this.row(c, 'Red', null, this.slider('cl_crosshaircolor_r', { min: 0, max: 255, step: 1, decimals: 0 }), 'cl_crosshaircolor_r'));
    rgbRows.push(this.row(c, 'Green', null, this.slider('cl_crosshaircolor_g', { min: 0, max: 255, step: 1, decimals: 0 }), 'cl_crosshaircolor_g'));
    rgbRows.push(this.row(c, 'Blue', null, this.slider('cl_crosshaircolor_b', { min: 0, max: 255, step: 1, decimals: 0 }), 'cl_crosshaircolor_b'));
    this.watch('cl_crosshaircolor', () => {
      const cur = Math.trunc(cvarNum('cl_crosshaircolor', 1));
      btns.forEach((b, i) => b.classList.toggle('active', i === cur));
      rgbRows.forEach((r) => r.classList.toggle('dim', cur !== 5));
    });
    this.row(c, 'Use alpha', 'Off = additive blending (CS:GO cl_crosshairusealpha 0).', this.toggle('cl_crosshairusealpha'), 'cl_crosshairusealpha');
    this.row(c, 'Alpha', null, this.slider('cl_crosshairalpha', { min: 0, max: 255, step: 1, decimals: 0 }), 'cl_crosshairalpha');

    p.append(left, controls);
    const infoUpd = () => {
      const dpr = window.devicePixelRatio || 1;
      previewInfo.textContent = `Actual size at ${Math.round(window.innerWidth * dpr)}×${Math.round(window.innerHeight * dpr)}`;
    };
    infoUpd();
    window.addEventListener('resize', infoUpd);
  }

  /** Draws the crosshair preview at its true in-game pixel size (optionally zoomed with nearest-neighbour). */
  private drawPreview(): void {
    const canvas = this.previewCanvas;
    if (!canvas || !canvas.isConnected || this.tab !== 'crosshair') return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width * dpr));
    const H = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paintPreviewBackground(ctx, W, H, this.previewBg);
    const params = readCrosshairParams(cvarGetter);
    if (!params.enabled) return;
    // geometry for the real screen, drawn at the preview centre
    const sw = Math.round(window.innerWidth * dpr);
    const sh = Math.round(window.innerHeight * dpr);
    const g = crosshairGeometry(params, sw, sh);
    if (!g.bounds) return;
    const z = this.previewZoom;
    const bw = g.bounds.x1 - g.bounds.x0 + 2;
    const bh = g.bounds.y1 - g.bounds.y0 + 2;
    const off = document.createElement('canvas');
    off.width = bw;
    off.height = bh;
    const octx = off.getContext('2d');
    if (!octx) return;
    drawCrosshair(octx, g, g.bounds.x0 - 1, g.bounds.y0 - 1);
    ctx.imageSmoothingEnabled = false;
    const dx = Math.round(W / 2 - (g.cx - (g.bounds.x0 - 1)) * z);
    const dy = Math.round(H / 2 - (g.cy - (g.bounds.y0 - 1)) * z);
    ctx.globalCompositeOperation = g.additive ? 'lighter' : 'source-over';
    ctx.drawImage(off, dx, dy, bw * z, bh * z);
    ctx.globalCompositeOperation = 'source-over';
  }

  refreshAll(): void {
    for (const list of this.refreshers.values()) for (const fn of list) fn();
    for (const fn of this.anyRefreshers) fn();
    this.drawPreview();
  }
}

function paintPreviewBackground(ctx: CanvasRenderingContext2D, W: number, H: number, kind: number): void {
  if (kind === 2) {
    ctx.fillStyle = '#15181d';
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (kind === 3) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#e9eef2');
    g.addColorStop(1, '#c9d2da');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, kind === 0 ? '#3b78c4' : '#1d2f4a');
  sky.addColorStop(0.55, kind === 0 ? '#9cc9ef' : '#4c6c92');
  sky.addColorStop(1, kind === 0 ? '#d7e8f5' : '#22344d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  if (kind === 1) {
    // a surf ramp seen from its side, so the crosshair sits on the ramp face
    ctx.fillStyle = '#7b8fa6';
    ctx.beginPath();
    ctx.moveTo(W * 0.05, H);
    ctx.lineTo(W * 0.62, H * 0.18);
    ctx.lineTo(W * 0.7, H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#4a5b70';
    ctx.beginPath();
    ctx.moveTo(W * 0.62, H * 0.18);
    ctx.lineTo(W * 1.05, H);
    ctx.lineTo(W * 0.7, H);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    for (const [x, y, r] of [
      [0.2, 0.3, 0.09],
      [0.27, 0.28, 0.07],
      [0.75, 0.22, 0.08],
      [0.82, 0.25, 0.06],
    ]) {
      ctx.beginPath();
      ctx.ellipse(W * x, H * y, W * r, H * r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
