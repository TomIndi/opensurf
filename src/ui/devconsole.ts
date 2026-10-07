// Source-style developer console: draggable/resizable window, colored output (console_.history + onOutput),
// input with autocomplete popup (console_.complete), Tab completion and command history.
import { console_, ConsoleLine, FCVAR_HIDDEN } from '../core/cvars';
import { isSilent } from './conutil';
import { clear, h, storageGet, storageSet } from './dom';
import { icon } from './icons';

const HISTORY_KEY = 'surf.ui.conHistory';
const GEOM_KEY = 'surf.ui.conGeom';
const MAX_DOM_LINES = 2000;
const MAX_SUGGESTIONS = 12;

export interface DevConsoleDeps {
  execute: (line: string) => void;
  onOpenChange: (open: boolean) => void;
}

export interface Suggestion {
  /** Text inserted into the input. */
  text: string;
  /** Current value for cvars. */
  value: string | null;
  help: string;
}

/** Autocomplete entries for a partial console line (pure apart from reading the console registry). */
export function suggestionsFor(partial: string, max = MAX_SUGGESTIONS): Suggestion[] {
  const p = partial.replace(/^\s+/, '');
  if (!p) return [];
  const out: Suggestion[] = [];
  for (const m of console_.complete(p)) {
    if (out.length >= max) break;
    const cv = !m.includes(' ') ? console_.getCvar(m) : undefined;
    const cmd = !cv ? console_.allCommands().find((c) => c.name === m) : undefined;
    if (cv && cv.flags & FCVAR_HIDDEN) continue;
    out.push({ text: m, value: cv ? cv.value : null, help: cv?.help ?? cmd?.help ?? '' });
  }
  return out;
}

export class DevConsole {
  readonly el: HTMLElement;
  private readonly output: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly popup: HTMLElement;
  private open = false;
  private rendered: ConsoleLine[] = [];
  private pending: ConsoleLine[] = [];
  private needsRebuild = true;
  private flushRaf = 0;
  private history: string[] = [];
  private histPos = -1;
  private histDraft = '';
  private suggestions: Suggestion[] = [];
  private sel = -1;
  private tabCycle = false;
  private suppressSuggest = false;

  constructor(private readonly deps: DevConsoleDeps) {
    this.output = h('div.devcon-output.selectable', { attrs: { role: 'log', 'aria-live': 'polite' } });
    this.input = h('input.devcon-input', {
      attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Console command' },
    }) as HTMLInputElement;
    this.popup = h('div.devcon-popup.hidden');
    const submit = h('button.btn.btn-sm.devcon-submit', { attrs: { type: 'button' }, text: 'Submit' });
    submit.addEventListener('click', () => this.submit());
    const closeBtn = h('button.btn.btn-ghost.btn-icon.btn-sm', { attrs: { type: 'button', title: 'Close (~)' } }, icon('close'));
    closeBtn.addEventListener('click', () => this.close());
    const title = h('div.devcon-title', null, icon('console'), h('span', { text: 'Console' }), h('span.devcon-hint', { text: '~ to toggle · Tab completes · ↑↓ history' }), closeBtn);
    this.el = h(
      'div.devcon.interactive.hidden',
      { attrs: { role: 'dialog', 'aria-label': 'Developer console' } },
      title,
      this.output,
      h('div.devcon-inputrow', null, h('span.devcon-prompt', { text: '>' }), this.input, submit),
      this.popup,
    );

    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('input', () => {
      this.histPos = -1;
      this.tabCycle = false;
      this.updateSuggestions();
    });
    this.el.addEventListener('mouseup', () => {
      const s = window.getSelection();
      if (this.open && (!s || s.isCollapsed)) this.input.focus();
    });
    this.makeDraggable(title);
    this.restoreGeometry();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.saveGeometry()) : null;
    ro?.observe(this.el);

    try {
      const raw = storageGet(HISTORY_KEY);
      if (raw) this.history = (JSON.parse(raw) as string[]).filter((s) => typeof s === 'string').slice(-100);
    } catch {
      this.history = [];
    }
    console_.onOutput((line) => {
      if (isSilent()) return;
      if (!this.needsRebuild) {
        this.pending.push(line);
        // too much output while closed: drop the queue and rebuild from console_.history on open
        if (this.pending.length > MAX_DOM_LINES) {
          this.needsRebuild = true;
          this.pending = [];
        }
      }
      if (this.open) this.scheduleFlush();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.el.classList.remove('hidden');
    this.flush();
    this.output.scrollTop = this.output.scrollHeight;
    this.deps.onOpenChange(true);
    setTimeout(() => {
      if (!this.open) return;
      // the toggle key's character must not land in the input
      if (this.input.value === '`' || this.input.value === '~') this.input.value = '';
      this.input.focus();
      this.updateSuggestions();
    }, 0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.add('hidden');
    this.hidePopup();
    if (document.activeElement === this.input) this.input.blur();
    this.deps.onOpenChange(false);
  }

  /** Re-syncs with console_.history (after `clear` or when lines were spliced out). */
  rebuild(): void {
    this.needsRebuild = true;
    if (this.open) this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushRaf) return;
    this.flushRaf = requestAnimationFrame(() => {
      this.flushRaf = 0;
      this.flush();
    });
  }

  private flush(): void {
    const hist = console_.history;
    // history cleared or rewritten behind our back -> rebuild from it
    if (!this.needsRebuild && this.rendered.length) {
      const last = this.rendered[this.rendered.length - 1];
      if (hist.lastIndexOf(last) < 0) this.needsRebuild = true;
    }
    // keep following new output only if the user hasn't scrolled up to read something
    const atBottom = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 40;
    const rebuilt = this.needsRebuild;
    if (rebuilt) {
      this.needsRebuild = false;
      this.pending = [];
      clear(this.output);
      this.rendered = [];
      this.appendLines(hist.slice(-MAX_DOM_LINES));
    } else if (this.pending.length) {
      const lines = this.pending;
      this.pending = [];
      this.appendLines(lines);
    }
    if (atBottom || rebuilt) this.output.scrollTop = this.output.scrollHeight;
  }

  private appendLines(lines: ConsoleLine[]): void {
    if (!lines.length) return;
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      const div = document.createElement('div');
      div.className = `cl cl-${l.color}`;
      div.textContent = l.text;
      frag.appendChild(div);
      this.rendered.push(l);
    }
    this.output.appendChild(frag);
    let extra = this.rendered.length - MAX_DOM_LINES;
    if (extra > 0) {
      this.rendered.splice(0, extra);
      while (extra-- > 0 && this.output.firstChild) this.output.removeChild(this.output.firstChild);
    }
  }

  // ------------------------------------------------------------ input

  private submit(): void {
    const line = this.input.value.trim();
    this.input.value = '';
    this.hidePopup();
    this.histPos = -1;
    if (!line) return;
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
    storageSet(HISTORY_KEY, JSON.stringify(this.history));
    console_.print(`] ${line}`, 'echo');
    const echo = console_.history[console_.history.length - 1];
    try {
      this.deps.execute(line);
    } catch (e) {
      console_.print(String((e as Error)?.message ?? e), 'error');
    }
    // if the game echoes the command itself too, keep a single "] cmd" line
    const hist = console_.history;
    const at = hist.lastIndexOf(echo);
    if (at >= 0 && hist[at + 1] && hist[at + 1].color === 'echo' && hist[at + 1].text === echo.text) {
      hist.splice(at + 1, 1);
      this.needsRebuild = true;
    }
    if (console_.history.length === 0) this.rebuild();
    else this.flush();
    this.output.scrollTop = this.output.scrollHeight;
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.code === 'Backquote' && !e.shiftKey) {
      e.preventDefault();
      this.close();
      return;
    }
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (this.sel >= 0 && this.suggestions[this.sel]) {
          this.accept(this.suggestions[this.sel].text);
          return;
        }
        this.submit();
        return;
      case 'Escape':
        e.preventDefault();
        if (this.sel >= 0) {
          this.sel = -1;
          this.hidePopup();
          return;
        }
        this.close();
        return;
      case 'Tab': {
        e.preventDefault();
        if (!this.suggestions.length) this.updateSuggestions();
        if (!this.suggestions.length) return;
        if (this.tabCycle) this.sel = (this.sel + (e.shiftKey ? -1 : 1) + this.suggestions.length) % this.suggestions.length;
        else this.sel = Math.max(0, this.sel);
        this.tabCycle = true;
        this.suppressSuggest = true;
        this.input.value = `${this.suggestions[this.sel].text} `;
        this.suppressSuggest = false;
        this.renderPopup();
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const up = e.key === 'ArrowUp';
        const usePopup = this.suggestions.length > 0 && this.histPos < 0 && this.input.value.trim() !== '';
        if (usePopup) {
          const n = this.suggestions.length;
          this.sel = this.sel < 0 ? (up ? n - 1 : 0) : (this.sel + (up ? -1 : 1) + n) % n;
          this.renderPopup();
          return;
        }
        this.historyNav(up);
        return;
      }
      case 'l':
        if (e.ctrlKey) {
          e.preventDefault();
          this.deps.execute('clear');
          this.rebuild();
        }
        return;
      default:
        return;
    }
  }

  private historyNav(up: boolean): void {
    if (!this.history.length) return;
    if (this.histPos < 0) {
      if (!up) return;
      this.histDraft = this.input.value;
      this.histPos = this.history.length - 1;
    } else if (up) this.histPos = Math.max(0, this.histPos - 1);
    else if (this.histPos < this.history.length - 1) this.histPos++;
    else {
      this.histPos = -1;
      this.input.value = this.histDraft;
      this.hidePopup();
      return;
    }
    this.input.value = this.history[this.histPos];
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.hidePopup();
  }

  private accept(text: string): void {
    this.input.value = `${text} `;
    this.sel = -1;
    this.tabCycle = false;
    this.input.focus();
    this.updateSuggestions();
  }

  private updateSuggestions(): void {
    if (this.suppressSuggest) return;
    const v = this.input.value;
    // after "cvar " (complete word + space) show nothing unless the command has an arg completer
    this.suggestions = v.trim() ? suggestionsFor(v) : [];
    if (this.suggestions.length === 1 && this.suggestions[0].text === v.trim() && v.endsWith(' ')) this.suggestions = [];
    this.sel = -1;
    this.renderPopup();
  }

  private renderPopup(): void {
    if (!this.suggestions.length) {
      this.hidePopup();
      return;
    }
    clear(this.popup);
    this.suggestions.forEach((s, i) => {
      const item = h(
        'div.devcon-sug',
        { attrs: { title: s.help } },
        h('span.sug-name', { text: s.text }),
        s.value !== null ? h('span.sug-value', { text: s.value }) : null,
        s.help ? h('span.sug-help', { text: s.help }) : null,
      );
      if (i === this.sel) item.classList.add('sel');
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.accept(s.text);
      });
      this.popup.appendChild(item);
    });
    this.popup.classList.remove('hidden');
    const selEl = this.popup.children[this.sel] as HTMLElement | undefined;
    selEl?.scrollIntoView({ block: 'nearest' });
  }

  private hidePopup(): void {
    this.popup.classList.add('hidden');
    this.suggestions = [];
    this.sel = -1;
  }

  // ------------------------------------------------------------ window geometry

  private makeDraggable(handle: HTMLElement): void {
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    const move = (e: MouseEvent) => {
      const x = Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
      const y = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy));
      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.el.classList.remove('dragging');
      this.saveGeometry();
    };
    handle.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      sx = e.clientX;
      sy = e.clientY;
      ox = r.left;
      oy = r.top;
      this.el.classList.add('dragging');
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  private saveGeometry(): void {
    if (!this.open) return;
    const r = this.el.getBoundingClientRect();
    if (r.width < 50) return;
    storageSet(
      GEOM_KEY,
      JSON.stringify({ x: r.left / window.innerWidth, y: r.top / window.innerHeight, w: r.width / window.innerWidth, h: r.height / window.innerHeight }),
    );
  }

  private restoreGeometry(): void {
    try {
      const raw = storageGet(GEOM_KEY);
      if (!raw) return;
      const g = JSON.parse(raw) as { x: number; y: number; w: number; h: number };
      if (![g.x, g.y, g.w, g.h].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return;
      this.el.style.left = `${(g.x * 100).toFixed(2)}vw`;
      this.el.style.top = `${(g.y * 100).toFixed(2)}vh`;
      this.el.style.width = `${(g.w * 100).toFixed(2)}vw`;
      this.el.style.height = `${(g.h * 100).toFixed(2)}vh`;
    } catch {
      /* ignore */
    }
  }
}
