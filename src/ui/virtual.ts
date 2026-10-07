// Virtualized fixed-row-height list (map browser: ~930 maps). Only visible rows exist in the DOM.

/** Index range [start, end) of rows to render for a viewport, with `overscan` extra rows each side. */
export function visibleRange(scrollTop: number, viewHeight: number, rowHeight: number, count: number, overscan = 4): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewHeight)) / rowHeight);
  const start = Math.max(0, Math.min(count, first - overscan));
  const end = Math.max(start, Math.min(count, last + overscan));
  return { start, end };
}

/** scrollTop that makes row `index` fully visible (minimal scroll), or null if already visible. */
export function scrollToReveal(index: number, scrollTop: number, viewHeight: number, rowHeight: number): number | null {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewHeight) return bottom - viewHeight;
  return null;
}

export interface VirtualListOptions<T> {
  /** Creates an empty row element (reused for many items). */
  createRow: () => HTMLElement;
  /** Fills a row element for an item. */
  renderRow: (row: HTMLElement, item: T, index: number, selected: boolean) => void;
  /** Row height in CSS px (may depend on the root font size; re-read on resize). */
  rowHeight: () => number;
  onActivate?: (item: T, index: number) => void;
  onSelect?: (item: T | null, index: number) => void;
}

export class VirtualList<T> {
  readonly el: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private items: readonly T[] = [];
  private rows = new Map<number, HTMLElement>();
  private pool: HTMLElement[] = [];
  private rowH = 32;
  private raf = 0;
  private selected = -1;
  private resizeObs: ResizeObserver | null = null;

  constructor(private readonly opts: VirtualListOptions<T>) {
    this.el = document.createElement('div');
    this.el.className = 'vlist';
    this.el.tabIndex = 0;
    this.spacer = document.createElement('div');
    this.spacer.className = 'vlist-spacer';
    this.el.appendChild(this.spacer);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => {
        this.measure();
        this.schedule();
      });
      this.resizeObs.observe(this.el);
    }
  }

  setItems(items: readonly T[], keepSelection = false): void {
    const prev = this.selected >= 0 ? this.items[this.selected] : undefined;
    this.items = items;
    this.selected = keepSelection && prev !== undefined ? items.indexOf(prev) : -1;
    this.measure();
    // force every visible row to re-render
    for (const [, row] of this.rows) this.release(row);
    this.rows.clear();
    this.render();
  }

  getItems(): readonly T[] {
    return this.items;
  }

  get selectedIndex(): number {
    return this.selected;
  }

  select(index: number, reveal = true): void {
    if (index < -1 || index >= this.items.length) return;
    const old = this.selected;
    this.selected = index;
    for (const i of [old, index]) {
      const row = this.rows.get(i);
      if (row && i >= 0) this.opts.renderRow(row, this.items[i], i, i === this.selected);
    }
    if (reveal && index >= 0) {
      const st = scrollToReveal(index, this.el.scrollTop, this.el.clientHeight, this.rowH);
      if (st !== null) this.el.scrollTop = st;
    }
    this.opts.onSelect?.(index >= 0 ? this.items[index] : null, index);
  }

  /** Re-renders visible rows (e.g. cached badges changed). */
  refresh(): void {
    for (const [i, row] of this.rows) this.opts.renderRow(row, this.items[i], i, i === this.selected);
  }

  scrollToTop(): void {
    this.el.scrollTop = 0;
  }

  measure(): void {
    const h = this.opts.rowHeight();
    if (h > 0) this.rowH = h;
    this.spacer.style.height = `${this.items.length * this.rowH}px`;
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private release(row: HTMLElement): void {
    row.style.display = 'none';
    row.classList.remove('selected');
    this.pool.push(row);
  }

  render(): void {
    const { start, end } = visibleRange(this.el.scrollTop, this.el.clientHeight || 600, this.rowH, this.items.length, 6);
    for (const [i, row] of this.rows) {
      if (i < start || i >= end) {
        this.rows.delete(i);
        this.release(row);
      }
    }
    for (let i = start; i < end; i++) {
      if (this.rows.has(i)) continue;
      let row = this.pool.pop();
      if (!row) {
        row = this.opts.createRow();
        row.classList.add('vlist-row');
        row.addEventListener('click', () => {
          const idx = Number(row!.dataset.index);
          if (idx !== this.selected) this.select(idx, false);
        });
        row.addEventListener('dblclick', () => {
          const idx = Number(row!.dataset.index);
          if (idx >= 0 && idx < this.items.length) this.opts.onActivate?.(this.items[idx], idx);
        });
        this.el.appendChild(row);
      }
      row.dataset.index = String(i);
      row.style.display = '';
      row.style.transform = `translateY(${i * this.rowH}px)`;
      row.style.height = `${this.rowH}px`;
      this.opts.renderRow(row, this.items[i], i, i === this.selected);
      this.rows.set(i, row);
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.items.length) return;
    const page = Math.max(1, Math.floor(this.el.clientHeight / this.rowH) - 1);
    let next = this.selected;
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(this.items.length - 1, this.selected + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, this.selected - 1);
        break;
      case 'PageDown':
        next = Math.min(this.items.length - 1, Math.max(0, this.selected) + page);
        break;
      case 'PageUp':
        next = Math.max(0, this.selected - page);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.items.length - 1;
        break;
      case 'Enter':
        if (this.selected >= 0) this.opts.onActivate?.(this.items[this.selected], this.selected);
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (next !== this.selected) this.select(next);
  }

  destroy(): void {
    this.resizeObs?.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}
