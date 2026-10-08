// Loading screen: map art, name/tier, phase stepper, smooth progress bar, rotating tips, cancel/retry.
import type { LoadProgress } from '../game/api';
import { h, TextSlot } from './dom';
import { mapTypeName } from './format';
import { icon, logoMarkSvg } from './icons';
import { mapNameEl, tierPill } from './mapui';
import { setMapArt } from './thumbs';
import { SURF_TIPS, tipOrder } from './tips';

import { PHASE_LABELS, PHASE_SPANS, type Phase, phaseText, rawProgress, rescaleProgress, STEPS } from './loadprogress';

export { PHASE_LABELS, PHASE_SPANS, phaseText, rawProgress, rescaleProgress };

export interface LoadingDeps {
  onCancel: () => void;
  onRetry: (() => void) | null;
}

export class LoadingScreen {
  readonly el: HTMLElement;
  private readonly art: HTMLElement;
  private readonly title: HTMLElement;
  private readonly pills: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly phase: TextSlot;
  private readonly detail: TextSlot;
  private readonly pct: TextSlot;
  private readonly tip: HTMLElement;
  private readonly stepEls = new Map<Phase, HTMLElement>();
  private readonly cancelBtn: HTMLButtonElement;
  private readonly retryBtn: HTMLButtonElement;
  private visible = false;
  private mapName = '';
  private target = 0;
  private shown = 0;
  private firstStart = -1;
  private phaseStartTime = 0;
  private currentPhase: Phase | null = null;
  private currentSpan: [number, number] | null = null;
  private hasFraction = false;
  private raf = 0;
  private tipTimer: ReturnType<typeof setInterval> | null = null;
  private tipIdx = 0;
  private readonly tips = tipOrder(Date.now() & 0xffff);
  private failed = false;

  constructor(private readonly deps: LoadingDeps) {
    this.art = h('div.loading-art');
    this.title = h('div.loading-title');
    this.pills = h('div.loading-pills');
    this.fill = h('div.loading-fill');
    const phaseEl = h('span.loading-phase');
    this.phase = new TextSlot(phaseEl, '');
    const detailEl = h('span.loading-detail');
    this.detail = new TextSlot(detailEl, '');
    const pctEl = h('span.loading-pct.tnum');
    this.pct = new TextSlot(pctEl, '');
    const steps = h('div.loading-steps');
    for (const [id, label] of STEPS) {
      const s = h('div.loading-step', null, h('i'), h('span', { text: label }));
      this.stepEls.set(id, s);
      steps.appendChild(s);
    }
    this.tip = h('div.loading-tip-text');
    this.cancelBtn = h('button.btn.btn-ghost', { attrs: { type: 'button' } }, h('span.kbd', { text: 'ESC' }), 'Cancel') as HTMLButtonElement;
    this.cancelBtn.addEventListener('click', () => this.deps.onCancel());
    this.retryBtn = h('button.btn.btn-accent.hidden', { attrs: { type: 'button' } }, icon('refresh'), 'Retry') as HTMLButtonElement;
    this.retryBtn.addEventListener('click', () => this.deps.onRetry?.());
    const brand = h('div.loading-brand');
    brand.innerHTML = logoMarkSvg();
    brand.appendChild(h('span.brand-word', { text: 'SURF' }));
    this.el = h(
      'div.screen.loading-screen.interactive.hidden',
      null,
      this.art,
      h('div.loading-shade'),
      h('div.loading-top', null, brand),
      h(
        'div.loading-main',
        null,
        h('div.loading-kicker', { text: 'Loading map' }),
        this.title,
        this.pills,
        steps,
        h('div.loading-bar', null, this.fill),
        h('div.loading-status', null, h('div.loading-status-l', null, phaseEl, detailEl), pctEl),
      ),
      h(
        'div.loading-bottom',
        null,
        h('div.loading-tip', null, h('span.tip-label', { text: 'Tip' }), this.tip),
        h('div.loading-actions', null, this.retryBtn, this.cancelBtn),
      ),
    );
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  /** True once setMap() gave the screen a map name (cleared on hide). */
  get hasMap(): boolean {
    return this.mapName !== '';
  }

  /** The map name in the header ('' if none). */
  get currentMap(): string {
    return this.mapName;
  }

  /** The phase of the last progress report (null before the first one). */
  get currentPhaseName(): Phase | null {
    return this.currentPhase;
  }

  /** Sets the header (map name, tier, type). Call before/at the first progress report. */
  setMap(name: string, tier: number | null, type: string | null = null, hasZones = false): void {
    if (name === this.mapName && this.visible) {
      this.renderPills(tier, type, hasZones);
      return;
    }
    this.mapName = name;
    this.title.replaceChildren(name ? mapNameEl(name, 'map-title') : h('span', { text: 'Loading…' }));
    if (name) setMapArt(this.art, name);
    else this.art.innerHTML = '';
    this.renderPills(tier, type, hasZones);
  }

  private renderPills(tier: number | null, type: string | null, hasZones: boolean): void {
    this.pills.replaceChildren(
      ...(tier ? [tierPill(tier, true)] : []),
      ...(type ? [h('span.pill.soft', { text: mapTypeName(type) })] : []),
      ...(hasZones ? [h('span.pill.good', null, icon('flag'), 'Zones')] : []),
    );
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.resetProgress();
    this.nextTip(true);
    this.tipTimer = setInterval(() => this.nextTip(false), 7000);
    this.loop();
  }

  /**
   * A new load starts while the screen is already up (after a failed one, or superseding one in progress):
   * clears the error state, the steps and the bar. The header is set separately (setMap).
   */
  restart(): void {
    if (!this.visible) {
      this.show();
      return;
    }
    this.resetProgress();
  }

  private resetProgress(): void {
    this.failed = false;
    this.el.classList.remove('hidden', 'error');
    this.retryBtn.classList.add('hidden');
    this.cancelBtn.lastChild!.textContent = 'Cancel';
    this.target = 0;
    this.shown = 0;
    this.firstStart = -1;
    this.currentPhase = null;
    this.currentSpan = null;
    this.hasFraction = false;
    this.fill.style.transform = 'scaleX(0)';
    for (const s of this.stepEls.values()) s.classList.remove('done', 'active', 'skipped');
    this.phase.set('Preparing…');
    this.detail.set('');
    this.pct.set('0%');
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.add('hidden');
    if (this.tipTimer) clearInterval(this.tipTimer);
    this.tipTimer = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.mapName = '';
  }

  update(p: LoadProgress): void {
    if (!this.visible) this.show();
    if (p.phase === 'error') {
      this.failed = true;
      this.el.classList.add('error');
      this.phase.set(PHASE_LABELS.error);
      this.detail.set(p.message || 'Unknown error');
      this.retryBtn.classList.toggle('hidden', !this.deps.onRetry);
      this.cancelBtn.lastChild!.textContent = 'Back to menu';
      return;
    }
    this.failed = false;
    this.el.classList.remove('error');
    this.cancelBtn.lastChild!.textContent = 'Cancel';
    const raw = rawProgress(p);
    if (raw === null) return;
    if (p.phase !== 'done' && this.firstStart < 0) this.firstStart = PHASE_SPANS[p.phase][0];
    if (p.phase !== this.currentPhase) {
      this.currentPhase = p.phase;
      this.phaseStartTime = performance.now();
      this.currentSpan = p.phase === 'done' ? null : PHASE_SPANS[p.phase];
      const ci = p.phase === 'done' ? STEPS.length : STEPS.findIndex(([id]) => id === p.phase);
      STEPS.forEach(([id], i) => {
        const el = this.stepEls.get(id)!;
        const skipped = PHASE_SPANS[id][0] < this.firstStart;
        el.classList.toggle('active', i === ci);
        el.classList.toggle('skipped', skipped && i < ci);
        el.classList.toggle('done', !skipped && i < ci);
      });
    }
    this.hasFraction = !!(p.total && p.total > 0 && p.loaded !== undefined);
    const scaled = rescaleProgress(raw, Math.max(0, this.firstStart));
    this.target = Math.max(this.target, scaled);
    const label = phaseText(p);
    this.phase.set(label);
    const msg = p.message && p.message !== label && !label.startsWith(p.message.replace(/[.…]+$/, '')) ? p.message : '';
    this.detail.set(msg);
  }

  private nextTip(first: boolean): void {
    const t = SURF_TIPS[this.tips[this.tipIdx++ % this.tips.length]];
    if (first) {
      this.tip.textContent = t;
      return;
    }
    this.tip.classList.add('out');
    setTimeout(() => {
      this.tip.textContent = t;
      this.tip.classList.remove('out');
    }, 280);
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(() => {
      if (!this.visible) return;
      // creep inside phases without byte counts so the bar never looks frozen
      let target = this.target;
      if (!this.hasFraction && this.currentSpan && this.firstStart >= 0 && !this.failed) {
        const elapsed = (performance.now() - this.phaseStartTime) / 1000;
        const creep = (1 - Math.exp(-elapsed / 2.5)) * 0.85;
        const raw = this.currentSpan[0] + (this.currentSpan[1] - this.currentSpan[0]) * creep;
        target = Math.max(target, rescaleProgress(raw, this.firstStart));
      }
      this.shown += (target - this.shown) * 0.12;
      if (Math.abs(target - this.shown) < 0.0005) this.shown = target;
      this.fill.style.transform = `scaleX(${this.shown.toFixed(4)})`;
      this.pct.set(`${Math.floor(this.shown * 100)}%`);
      this.loop();
    });
  };
}
