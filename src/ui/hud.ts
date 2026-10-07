// In-game HUD: SurfTimer-style timer panel, speedometer, showkeys, sidebar, cl_showpos/cl_showfps, hint box,
// center print and the CS:GO crosshair. update() runs every frame and only touches nodes whose value changed.
import { console_ } from '../core/cvars';
import type { HudState } from '../game/api';
import { cvarBool, cvarGetter, cvarNum, cvarStr } from './cvardefs';
import { ClassSwitch, ClassToggle, h, TextSlot } from './dom';
import { fmtPos, formatSpeed, formatTime } from './format';
import { FpsMeter, FrameStats, HoldLatch, netGraphText, SpeedTrend, splitView, timerView } from './hudlogic';
import { crosshairGeometry, drawCrosshair, readCrosshairParams } from './crosshair';

/** cl_hud_color palette (0 = default). */
export const HUD_COLORS = ['#7fc0ff', '#ffffff', '#9fd8ff', '#4c86ff', '#b07cff', '#ff5a5a', '#ff9f40', '#ffe25c', '#5ae05a', '#4fe3d8', '#ff79c8'];
export const HUD_COLOR_NAMES = ['Default', 'White', 'Light blue', 'Blue', 'Purple', 'Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Pink'];

const HUD_CVARS = new Set([
  'surf_hud_speed',
  'surf_hud_timer',
  'surf_showkeys',
  'cl_showpos',
  'cl_showfps',
  'surf_speedometer_color',
  'cl_hud_color',
  'hud_scaling',
  'net_graph',
]);

/** Renders the crosshair into a small canvas centred on the screen, pixel-aligned to device pixels. */
export class CrosshairView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private dirty = true;
  /** Override screen size (crosshair preview); null = window. */
  screenOverride: { w: number; h: number; dpr: number } | null = null;

  constructor(cls = 'hud-crosshair') {
    this.canvas = document.createElement('canvas');
    this.canvas.className = cls;
    this.ctx = this.canvas.getContext('2d');
    console_.onCvarChange((cv) => {
      if (cv.name === 'crosshair' || cv.name.startsWith('cl_crosshair')) this.dirty = true;
    });
    window.addEventListener('resize', () => (this.dirty = true));
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Redraws if a crosshair cvar or the viewport changed. */
  update(): void {
    if (!this.dirty || !this.ctx) return;
    this.dirty = false;
    const dpr = this.screenOverride?.dpr ?? (window.devicePixelRatio || 1);
    const sw = Math.round((this.screenOverride?.w ?? window.innerWidth) * dpr);
    const sh = Math.round((this.screenOverride?.h ?? window.innerHeight) * dpr);
    const p = readCrosshairParams(cvarGetter);
    const g = crosshairGeometry(p, sw, sh);
    if (!p.enabled || !g.bounds) {
      this.canvas.style.display = 'none';
      return;
    }
    this.canvas.style.display = '';
    // canvas covers the crosshair bounds (+1px margin), its top-left at an integer device pixel
    const x0 = g.bounds.x0 - 1;
    const y0 = g.bounds.y0 - 1;
    const w = g.bounds.x1 - g.bounds.x0 + 2;
    const hgt = g.bounds.y1 - g.bounds.y0 + 2;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== hgt) this.canvas.height = hgt;
    this.canvas.style.width = `${w / dpr}px`;
    this.canvas.style.height = `${hgt / dpr}px`;
    this.canvas.style.left = `${x0 / dpr}px`;
    this.canvas.style.top = `${y0 / dpr}px`;
    this.canvas.style.mixBlendMode = g.additive ? 'plus-lighter' : 'normal';
    this.ctx.clearRect(0, 0, w, hgt);
    drawCrosshair(this.ctx, g, x0, y0);
  }
}

interface KeyEls {
  forward: ClassToggle;
  back: ClassToggle;
  left: ClassToggle;
  right: ClassToggle;
  jump: ClassToggle;
  duck: ClassToggle;
  turnL: ClassToggle;
  turnR: ClassToggle;
}

export class Hud {
  readonly el: HTMLElement;
  readonly crosshair = new CrosshairView();
  private readonly timerEl: HTMLElement;
  private readonly timerState: ClassSwitch;
  private readonly tLabel: TextSlot;
  private readonly tMain: TextSlot;
  private readonly tSpeed: TextSlot;
  private readonly tCourse: TextSlot;
  private readonly tPb: TextSlot;
  private readonly tWr: TextSlot;
  private readonly tTags: TextSlot;
  private readonly splitEl: HTMLElement;
  private readonly splitText: TextSlot;
  private readonly speedoEl: HTMLElement;
  private readonly speedo: TextSlot;
  private readonly speedoTrend: ClassSwitch;
  private readonly keysEl: HTMLElement;
  private readonly keys: KeyEls;
  private readonly sideEl: HTMLElement;
  private readonly sideTitle: TextSlot;
  private readonly sideRows: Record<string, TextSlot> = {};
  private sideWrNone!: ClassToggle;
  private sidePbNone!: ClassToggle;
  private readonly posEl: HTMLElement;
  private readonly posText: TextSlot;
  private readonly fpsEl: HTMLElement;
  private readonly fpsText: TextSlot;
  private readonly fpsColor: ClassSwitch;
  private readonly netEl: HTMLElement;
  private readonly netText: TextSlot;
  private readonly frames = new FrameStats(120);
  private readonly specEl: HTMLElement;
  private readonly specText: TextSlot;
  private readonly hintEl: HTMLElement;
  private readonly centerEl: HTMLElement;
  private readonly lockHint: HTMLElement;
  private lockHintOn = false;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private centerTimer: ReturnType<typeof setTimeout> | null = null;

  private cfg = { speed: true, timer: true, keys: true, showpos: 0, showfps: 0, speedColor: true, netgraph: 0 };
  private visible: boolean | null = null;
  private readonly trend = new SpeedTrend();
  private readonly holdJump = new HoldLatch(90);
  private readonly holdDuck = new HoldLatch(60);
  private readonly holdTurnL = new HoldLatch(110);
  private readonly holdTurnR = new HoldLatch(110);
  private readonly fps = new FpsMeter(0.5);
  private lastFrame = 0;
  private lastPosUpdate = 0;
  private lastSideUpdate = 0;
  private lastSplitKey = '';
  private splitHideAt = 0;
  private splitMap: string | null = null;
  private lastMap = '';

  constructor() {
    // ---- timer panel
    const tLabelEl = h('div.ht-label');
    this.tLabel = new TextSlot(tLabelEl);
    const tMainEl = h('div.ht-main.tnum');
    this.tMain = new TextSlot(tMainEl);
    const tSpeedEl = h('b.tnum');
    this.tSpeed = new TextSlot(tSpeedEl, '0');
    const tCourseEl = h('span.ht-course');
    this.tCourse = new TextSlot(tCourseEl);
    const tPbEl = h('b.tnum');
    this.tPb = new TextSlot(tPbEl);
    const tWrEl = h('b.tnum');
    this.tWr = new TextSlot(tWrEl);
    const tTagsEl = h('span.ht-tags');
    this.tTags = new TextSlot(tTagsEl);
    this.splitEl = h('div.ht-split.tnum');
    this.splitText = new TextSlot(this.splitEl);
    this.timerEl = h(
      'div.hud-timer',
      null,
      this.splitEl,
      tLabelEl,
      tMainEl,
      h('div.ht-row', null, h('span.ht-speed', null, tSpeedEl, h('i', { text: ' u/s' })), h('span.ht-dot'), tCourseEl, tTagsEl),
      h('div.ht-rec', null, h('span', null, h('i', { text: 'PB ' }), tPbEl), h('span', null, h('i', { text: 'WR ' }), tWrEl)),
    );
    this.timerState = new ClassSwitch(this.timerEl);

    // ---- speedometer
    this.speedoEl = h('div.hud-speedo.tnum');
    this.speedo = new TextSlot(this.speedoEl, '0');
    this.speedoTrend = new ClassSwitch(this.speedoEl);

    // ---- showkeys
    const k = (label: string, cls = '') => h(`span.k${cls ? '.' + cls : ''}`, { text: label });
    const kw = k('W');
    const ka = k('A');
    const ks = k('S');
    const kd = k('D');
    const kduck = k('DUCK', 'wide');
    const kjump = k('JUMP', 'wide');
    const tl = h('span.turn.turn-l', { text: '◀' });
    const tr = h('span.turn.turn-r', { text: '▶' });
    this.keysEl = h('div.hud-keys', null, h('div.kr', null, kw), h('div.kr', null, tl, ka, ks, kd, tr), h('div.kr', null, kduck, kjump));
    this.keys = {
      forward: new ClassToggle(kw, 'on'),
      back: new ClassToggle(ks, 'on'),
      left: new ClassToggle(ka, 'on'),
      right: new ClassToggle(kd, 'on'),
      jump: new ClassToggle(kjump, 'on'),
      duck: new ClassToggle(kduck, 'on'),
      turnL: new ClassToggle(tl, 'on'),
      turnR: new ClassToggle(tr, 'on'),
    };

    // ---- sidebar
    const sideTitleEl = h('div.hs-title');
    this.sideTitle = new TextSlot(sideTitleEl);
    this.sideEl = h('div.hud-side', null, sideTitleEl);
    for (const [key, label] of [
      ['tier', 'Tier'],
      ['type', 'Type'],
      ['wr', 'Server record'],
      ['pb', 'Personal best'],
      ['stage', 'Stage time'],
      ['jumps', 'Jumps'],
      ['strafes', 'Strafes'],
      ['sync', 'Sync'],
    ]) {
      const v = h('b.tnum');
      this.sideRows[key] = new TextSlot(v);
      const row = h(`div.hs-row.hs-${key}`, null, h('span', { text: label }), v);
      if (key === 'wr') this.sideWrNone = new ClassToggle(row, 'none');
      if (key === 'pb') this.sidePbNone = new ClassToggle(row, 'none');
      this.sideEl.appendChild(row);
    }

    // ---- showpos / fps
    this.fpsEl = h('div.hud-fps.tnum');
    this.fpsText = new TextSlot(this.fpsEl);
    this.fpsColor = new ClassSwitch(this.fpsEl);
    this.posEl = h('div.hud-pos.tnum');
    this.posText = new TextSlot(this.posEl);

    // ---- net_graph (bottom right, CS:GO style)
    this.netEl = h('div.hud-netgraph.tnum');
    this.netText = new TextSlot(this.netEl);

    // ---- spectate banner / hint / center print
    this.specEl = h('div.hud-spec');
    const specTextEl = h('span');
    this.specText = new TextSlot(specTextEl);
    this.specEl.append(h('span.spec-tag', { text: 'Replay' }), specTextEl);
    this.hintEl = h('div.hud-hint');
    this.centerEl = h('div.hud-center');
    this.lockHint = h('div.hud-lockhint', null, h('span.kbd', { text: 'CLICK' }), ' to capture the mouse');

    this.el = h(
      'div.hud',
      null,
      this.crosshair.canvas,
      this.speedoEl,
      this.keysEl,
      this.timerEl,
      this.sideEl,
      h('div.hud-topleft', null, this.fpsEl, this.posEl),
      this.netEl,
      this.specEl,
      this.hintEl,
      this.centerEl,
      this.lockHint,
    );
    this.readConfig();
    console_.onCvarChange((cv) => {
      if (HUD_CVARS.has(cv.name)) this.readConfig();
    });
  }

  /** Re-reads HUD cvars (called on cvar changes and once the game has registered its cvars). */
  readConfig(): void {
    this.cfg.speed = cvarBool('surf_hud_speed', true);
    this.cfg.timer = cvarBool('surf_hud_timer', true);
    this.cfg.keys = cvarBool('surf_showkeys', true);
    this.cfg.showpos = cvarNum('cl_showpos', 0);
    this.cfg.showfps = cvarNum('cl_showfps', 0);
    this.cfg.speedColor = cvarNum('surf_speedometer_color', 1) !== 0;
    this.cfg.netgraph = cvarNum('net_graph', 0);
    this.netEl.classList.toggle('hidden', !this.cfg.netgraph);
    const scale = Math.max(0.5, Math.min(0.95, cvarNum('hud_scaling', 0.85)));
    this.el.style.setProperty('--hud-k', (scale / 0.85).toFixed(4));
    const ci = Math.trunc(cvarNum('cl_hud_color', 0));
    this.el.style.setProperty('--hud-color', HUD_COLORS[ci] ?? HUD_COLORS[0]);
    this.speedoEl.classList.toggle('hidden', !this.cfg.speed);
    this.timerEl.classList.toggle('hidden', !this.cfg.timer);
    this.sideEl.classList.toggle('hidden', !this.cfg.timer);
    this.keysEl.classList.toggle('hidden', !this.cfg.keys);
    this.posEl.classList.toggle('hidden', !this.cfg.showpos);
    this.fpsEl.classList.toggle('hidden', !this.cfg.showfps);
    if (!this.cfg.speedColor) this.speedoTrend.set('');
    this.crosshair.invalidate();
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('hud-hidden', !v);
    if (!v) this.trend.reset();
  }

  get isVisible(): boolean {
    return this.visible === true;
  }

  update(hud: HudState): void {
    const now = performance.now();
    const dt = this.lastFrame ? (now - this.lastFrame) / 1000 : 0;
    this.lastFrame = now;
    this.frames.push(dt * 1000);
    if (this.fps.tick(dt)) {
      const f = Math.round(this.fps.fps);
      if (this.cfg.showfps) {
        this.fpsText.set(`${f} fps${hud.mapName ? ` on ${hud.mapName}` : ''}`);
        this.fpsColor.set(f >= 60 ? 'fps-good' : f >= 30 ? 'fps-ok' : 'fps-bad');
      }
      if (this.cfg.netgraph) this.netText.set(netGraphText(this.fps.fps, this.frames.stddev(), cvarNum('tickrate', 100)));
    }
    this.setVisible(hud.visible);
    if (!hud.visible) return;
    this.crosshair.update();

    // ---- timer panel
    if (this.cfg.timer) {
      const tv = timerView(hud.timer, hud.practice);
      this.timerState.set(`st-${tv.cls}`);
      this.tLabel.set(tv.label);
      this.tMain.set(tv.main);
      this.tCourse.set(tv.course);
      this.tPb.set(tv.pb);
      this.tWr.set(tv.wr);
      this.tTags.set(hud.noclip ? 'NOCLIP' : '');
      // split flash: detect a new split by its (time, delta) pair, independent of the clock it uses
      const t = hud.timer;
      const key = t.lastSplitDelta === null ? '' : `${t.lastSplitTime}|${t.lastSplitDelta}`;
      if (hud.mapName !== this.splitMap) {
        // new map: remember the current split without flashing a stale one
        this.splitMap = hud.mapName;
        this.lastSplitKey = key;
      } else if (key !== this.lastSplitKey) {
        this.lastSplitKey = key;
        const sv = splitView(t.lastSplitDelta);
        if (sv) {
          this.splitText.set(sv.text);
          this.splitEl.className = `ht-split tnum show ${sv.cls}`;
          // restart the CSS animation
          void this.splitEl.offsetWidth;
          this.splitEl.classList.add('anim');
          this.splitHideAt = now + 3000;
        }
      }
      if (this.splitHideAt && now > this.splitHideAt) {
        this.splitHideAt = 0;
        this.splitEl.classList.remove('show', 'anim');
      }
    }
    this.tSpeed.set(formatSpeed(hud.speed));

    // ---- speedometer
    if (this.cfg.speed) {
      this.speedo.set(formatSpeed(hud.speed));
      if (this.cfg.speedColor) {
        const st = this.trend.update(hud.speed, dt);
        this.speedoTrend.set(`trend-${st}`);
      }
    }

    // ---- showkeys
    if (this.cfg.keys) {
      const k = hud.keys;
      this.keys.forward.set(k.forward);
      this.keys.back.set(k.back);
      this.keys.left.set(k.left);
      this.keys.right.set(k.right);
      this.keys.jump.set(this.holdJump.update(k.jump, now));
      this.keys.duck.set(this.holdDuck.update(k.duck, now));
      const left = this.holdTurnL.update(k.turn < 0, now);
      const right = this.holdTurnR.update(k.turn > 0, now);
      // a direction change wins immediately
      this.keys.turnL.set(left && !(k.turn > 0));
      this.keys.turnR.set(right && !(k.turn < 0));
    }

    // ---- sidebar (4 Hz is plenty)
    if (this.cfg.timer && (now - this.lastSideUpdate > 250 || hud.mapName !== this.lastMap)) {
      this.lastSideUpdate = now;
      this.lastMap = hud.mapName;
      const t = hud.timer;
      this.sideTitle.set(hud.mapName);
      this.sideRows.tier.set(hud.tier ? `T${hud.tier}` : '?');
      this.sideRows.type.set(t.mapType === 'staged' ? `Staged · ${t.stageCount || '?'} stages` : t.checkpointCount ? `Linear · ${t.checkpointCount} CPs` : 'Linear');
      this.sideRows.wr.set(t.wr ? formatTime(t.wr) : 'None');
      this.sideRows.pb.set(t.pb ? formatTime(t.pb) : 'None');
      this.sideWrNone.set(!t.wr);
      this.sidePbNone.set(!t.pb);
      this.sideRows.stage.set(t.mapType === 'staged' && (t.state === 'running' || t.state === 'practice') ? formatTime(t.stageTime) : '—');
      this.sideRows.jumps.set(String(hud.jumps));
      this.sideRows.strafes.set(String(hud.strafes));
      this.sideRows.sync.set(`${Math.round(hud.sync)}%`);
    }

    // ---- showpos (Source layout), ~20 Hz
    if (this.cfg.showpos && now - this.lastPosUpdate > 50) {
      this.lastPosUpdate = now;
      const o = hud.origin;
      const a = hud.angles;
      const v = hud.velocity;
      const vel = Math.hypot(v.x, v.y, v.z);
      this.posText.set(
        `name: ${hud.spectating ?? (cvarStr('name') || 'Player')}\npos:  ${fmtPos(o.x)} ${fmtPos(o.y)} ${fmtPos(o.z)}\nang:  ${fmtPos(a.pitch)} ${fmtPos(a.yaw)} ${fmtPos(a.roll)}\nvel:  ${fmtPos(vel)}`,
      );
    }

    // ---- spectate banner
    if (hud.spectating) {
      this.specEl.classList.add('show');
      this.specText.set(`Watching ${hud.spectating}`);
    } else this.specEl.classList.remove('show');
  }

  /** "Click to capture the mouse" prompt (pointer not locked while playing). */
  setLockHint(on: boolean): void {
    if (on === this.lockHintOn) return;
    this.lockHintOn = on;
    this.lockHint.classList.toggle('show', on);
  }

  hint(text: string, seconds = 4): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.remove('show');
    void this.hintEl.offsetWidth;
    this.hintEl.classList.toggle('show', !!text);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hintEl.classList.remove('show'), Math.max(0.5, seconds) * 1000);
  }

  centerPrint(text: string, seconds = 3): void {
    this.centerEl.textContent = text;
    this.centerEl.classList.remove('show');
    void this.centerEl.offsetWidth;
    this.centerEl.classList.toggle('show', !!text);
    if (this.centerTimer) clearTimeout(this.centerTimer);
    this.centerTimer = setTimeout(() => this.centerEl.classList.remove('show'), Math.max(0.5, seconds) * 1000);
  }
}
