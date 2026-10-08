// CS:GO-style chat: colored lines bottom-left that fade after ~10 s, all visible while typing; messagemode
// ("Say :") / messagemode2 ("Say (Team) :") input with history.
import type { ChatSegment } from '../game/api';
import { normalizeSegments, resolveChatColor } from './chatcolors';
import { h, storageGet, storageSet } from './dom';

export const CHAT_FADE_SECONDS = 10;
const MAX_MESSAGES = 120;
const MAX_LEN = 127;
const HISTORY_KEY = 'surf.ui.chatHistory';

export interface ChatDeps {
  onSay: (text: string, team: boolean) => void;
  onOpenChange: (open: boolean) => void;
  playSound: () => void;
}

interface Msg {
  el: HTMLElement;
  time: number;
  faded: boolean;
}

export class Chat {
  readonly el: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly inputRow: HTMLElement;
  private readonly label: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly msgs: Msg[] = [];
  private open = false;
  private team = false;
  private history: string[] = [];
  private histPos = -1;
  private draft = '';
  private openedAt = 0;

  constructor(private readonly deps: ChatDeps) {
    this.feed = h('div.chat-feed');
    this.label = h('span.chat-label', { text: 'Say :' });
    this.input = h('input.chat-input', {
      attrs: { type: 'text', maxlength: MAX_LEN, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Chat message' },
    }) as HTMLInputElement;
    this.inputRow = h('div.chat-input-row', null, this.label, this.input);
    this.el = h('div.chat', null, this.feed, this.inputRow);
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => {
      // clicking elsewhere (or pointer lock loss) cancels typing like CS:GO
      if (this.open && performance.now() - this.openedAt > 150) this.close();
    });
    try {
      const raw = storageGet(HISTORY_KEY);
      if (raw) this.history = (JSON.parse(raw) as string[]).filter((s) => typeof s === 'string').slice(-50);
    } catch {
      this.history = [];
    }
    setInterval(() => this.fadeTick(), 500);
  }

  get isOpen(): boolean {
    return this.open;
  }

  add(segments: ChatSegment[]): void {
    const segs = normalizeSegments(segments);
    if (!segs.length) return;
    const line = h('div.chat-msg');
    for (const s of segs) {
      const span = document.createElement('span');
      span.textContent = s.text;
      const c = resolveChatColor(s.color);
      if (c !== '#FFFFFF') span.style.color = c;
      line.appendChild(span);
    }
    this.feed.appendChild(line);
    this.msgs.push({ el: line, time: performance.now(), faded: false });
    while (this.msgs.length > MAX_MESSAGES) this.msgs.shift()!.el.remove();
    this.feed.scrollTop = this.feed.scrollHeight;
    this.deps.playSound();
  }

  /** Keeps the newest lines in view (the feed can't scroll while the HUD is hidden). */
  scrollToBottom(): void {
    this.feed.scrollTop = this.feed.scrollHeight;
  }

  clear(): void {
    for (const m of this.msgs) m.el.remove();
    this.msgs.length = 0;
  }

  private fadeTick(): void {
    const now = performance.now();
    for (const m of this.msgs) {
      if (!m.faded && now - m.time > CHAT_FADE_SECONDS * 1000) {
        m.faded = true;
        m.el.classList.add('faded');
      }
    }
  }

  openInput(team: boolean): void {
    this.team = team;
    this.label.textContent = team ? 'Say (Team) :' : 'Say :';
    this.el.classList.toggle('team', team);
    if (this.open) {
      this.input.focus();
      return;
    }
    this.open = true;
    this.openedAt = performance.now();
    this.histPos = -1;
    this.draft = '';
    this.el.classList.add('open');
    this.input.value = '';
    this.feed.scrollTop = this.feed.scrollHeight;
    this.deps.onOpenChange(true);
    // focus after the opening key's own keypress has been dispatched (otherwise "y" lands in the box)
    setTimeout(() => {
      if (!this.open) return;
      this.input.value = '';
      this.input.focus();
    }, 0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('open');
    this.input.value = '';
    if (document.activeElement === this.input) this.input.blur();
    this.feed.scrollTop = this.feed.scrollHeight;
    this.deps.onOpenChange(false);
  }

  private submit(): void {
    const text = this.input.value.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    const team = this.team;
    this.close();
    if (!text) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
    storageSet(HISTORY_KEY, JSON.stringify(this.history));
    this.deps.onSay(text, team);
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        this.submit();
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!this.history.length) return;
        if (this.histPos < 0) {
          this.draft = this.input.value;
          this.histPos = this.history.length - 1;
        } else if (this.histPos > 0) this.histPos--;
        this.input.value = this.history[this.histPos];
        this.input.setSelectionRange(this.input.value.length, this.input.value.length);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (this.histPos < 0) return;
        if (this.histPos < this.history.length - 1) {
          this.histPos++;
          this.input.value = this.history[this.histPos];
        } else {
          this.histPos = -1;
          this.input.value = this.draft;
        }
        break;
      default:
        break;
    }
  }
}
