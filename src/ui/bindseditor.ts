// Binds editor: actions with two key slots each. Click a slot, press a key / mouse button / wheel to bind it
// (`bind <key> "<command>"`), Backspace/Delete clears, Esc cancels. Reads the current binds through the console.
import { console_ } from '../core/cvars';
import type { SoundApi } from '../game/api';
import { queryBinds } from './conutil';
import { persistConfigSoon } from './cvardefs';
import { clear, h } from './dom';
import { icon } from './icons';
import { allKeyNames, codeToKeyName, keyLabel, mouseButtonToKeyName, wheelToKeyName } from './keys';

export interface BindAction {
  label: string;
  command: string;
}

export const BIND_GROUPS: { group: string; items: BindAction[] }[] = [
  {
    group: 'Movement',
    items: [
      { label: 'Move forward', command: '+forward' },
      { label: 'Move back', command: '+back' },
      { label: 'Strafe left', command: '+moveleft' },
      { label: 'Strafe right', command: '+moveright' },
      { label: 'Jump', command: '+jump' },
      { label: 'Duck', command: '+duck' },
      { label: 'Walk', command: '+speed' },
      { label: 'Use', command: '+use' },
    ],
  },
  {
    group: 'Surf timer',
    items: [
      { label: 'Restart map  (!r)', command: 'say !r' },
      { label: 'Restart stage  (!back)', command: 'say !back' },
      { label: 'Save location  (!saveloc)', command: 'say !saveloc' },
      { label: 'Teleport to save  (!tele)', command: 'say !tele' },
      { label: 'Practice mode  (!prac)', command: 'say !prac' },
      { label: 'Noclip  (!noclip)', command: 'say !noclip' },
      { label: 'Watch PB replay  (!replay)', command: 'say !replay' },
    ],
  },
  {
    group: 'Communication',
    items: [
      { label: 'Chat', command: 'messagemode' },
      { label: 'Team chat', command: 'messagemode2' },
    ],
  },
  {
    group: 'Interface',
    items: [
      { label: 'Scoreboard', command: '+showscores' },
      { label: 'Developer console', command: 'toggleconsole' },
    ],
  },
];

/** Normalizes a bound command for comparison: lower-case, no quotes, single spaces. */
export function normalizeCommand(cmd: string): string {
  return cmd.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Default bind keys first (in the order of the CS:GO surf defaults), so a newly added key never jumps ahead of them. */
const PRIMARY_KEYS = ['w', 's', 'a', 'd', 'space', 'mwheeldown', 'mwheelup', 'ctrl', 'shift', 'e', 'tab', '`', 'y', 'u', 'r', 't', 'mouse4', 'mouse5', 'f2'];

/** Groups key -> command into command -> keys (keys in a stable, friendly order). */
export function keysByCommand(binds: Map<string, string>): Map<string, string[]> {
  const order = [...PRIMARY_KEYS, ...allKeyNames().filter((k) => !PRIMARY_KEYS.includes(k))];
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i < 0 ? 999 : i;
  };
  const out = new Map<string, string[]>();
  for (const [key, cmd] of binds) {
    const n = normalizeCommand(cmd);
    let list = out.get(n);
    if (!list) out.set(n, (list = []));
    list.push(key);
  }
  for (const list of out.values()) list.sort((a, b) => rank(a) - rank(b));
  return out;
}

export interface BindsEditorDeps {
  sound: SoundApi;
  toast: (msg: string, kind?: 'info' | 'error' | 'success') => void;
  confirm: (title: string, text: string, ok: string) => Promise<boolean>;
}

export class BindsEditor {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly other: HTMLElement;
  private binds = new Map<string, string>();
  private capture: { command: string; oldKey: string | null; slot: HTMLElement } | null = null;
  private readonly onKeyDown = (e: KeyboardEvent) => this.captureKey(e);
  private readonly onMouseDown = (e: MouseEvent) => this.captureMouse(e);
  private readonly onWheel = (e: WheelEvent) => this.captureWheel(e);

  constructor(private readonly deps: BindsEditorDeps) {
    this.list = h('div.binds-list');
    this.other = h('div.binds-other');
    const reset = h('button.btn.btn-sm', { attrs: { type: 'button' } }, icon('restart'), 'Reset to defaults');
    reset.addEventListener('click', async () => {
      if (!console_.hasCommand('binddefaults')) {
        deps.toast('binddefaults is not available', 'error');
        return;
      }
      const ok = await deps.confirm('Reset binds', 'Restore every key binding to the CS:GO surf defaults?', 'Reset');
      if (!ok) return;
      console_.execute('binddefaults');
      persistConfigSoon();
      this.refresh();
      deps.toast('Binds reset to defaults', 'success');
    });
    this.el = h(
      'div.set-col.binds',
      null,
      h('div.binds-top', null, h('p.set-group-desc', { text: 'Click a slot, then press a key, mouse button or scroll the wheel. Backspace clears the slot, Esc cancels. Binds are console binds: `bind <key> "<command>"` works too.' }), reset),
      this.list,
      this.other,
    );
  }

  get capturing(): boolean {
    return this.capture !== null;
  }

  refresh(): void {
    this.binds = queryBinds(allKeyNames());
    this.render();
  }

  private render(): void {
    clear(this.list);
    if (!console_.hasCommand('bind')) {
      this.list.appendChild(h('div.set-warning', null, icon('warning'), 'Key binds are available once the game has started.'));
      return;
    }
    const byCmd = keysByCommand(this.binds);
    const known = new Set<string>();
    for (const g of BIND_GROUPS) {
      const sec = h('section.set-group', null, h('h4', { text: g.group }));
      for (const a of g.items) {
        const n = normalizeCommand(a.command);
        known.add(n);
        const keys = byCmd.get(n) ?? [];
        const slots = h('div.bind-slots');
        for (let i = 0; i < 2; i++) slots.appendChild(this.slot(a.command, keys[i] ?? null));
        slots.appendChild(keys.length > 2 ? h('span.bind-more', { text: `+${keys.length - 2}`, attrs: { title: `Also: ${keys.slice(2).map(keyLabel).join(', ')}` } }) : h('span.bind-more'));
        sec.appendChild(h('div.set-row.bind-row', null, h('div.set-label', null, h('div.set-name', { text: a.label }), h('code.set-cvar', { text: a.command })), h('div.set-control', null, slots)));
      }
      this.list.appendChild(sec);
    }
    // other binds (user's own)
    clear(this.other);
    const others = [...this.binds].filter(([, cmd]) => !known.has(normalizeCommand(cmd)) && normalizeCommand(cmd) !== 'cancelselect');
    if (others.length) {
      const sec = h('section.set-group', null, h('h4', { text: 'Other binds' }));
      for (const [key, cmd] of others) {
        const un = h('button.btn.btn-ghost.btn-icon.btn-sm', { attrs: { type: 'button', title: `unbind ${key}` } }, icon('close'));
        un.addEventListener('click', () => {
          console_.execute(`unbind "${key}"`);
          persistConfigSoon();
          this.refresh();
        });
        sec.appendChild(h('div.set-row.bind-row', null, h('div.set-label', null, h('div.set-name.mono', { text: cmd })), h('div.set-control', null, h('span.bind-slot.static', { text: keyLabel(key) }), un)));
      }
      this.other.appendChild(sec);
    }
  }

  private slot(command: string, key: string | null): HTMLElement {
    const b = h('button.bind-slot', { attrs: { type: 'button' }, text: key ? keyLabel(key) : '—' });
    if (!key) b.classList.add('empty');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startCapture(command, key, b);
    });
    return b;
  }

  private startCapture(command: string, oldKey: string | null, slot: HTMLElement): void {
    this.cancelCapture();
    this.deps.sound.play('ui_click');
    this.capture = { command, oldKey, slot };
    slot.classList.add('capturing');
    slot.textContent = 'Press a key…';
    // The click that opened the capture has fully dispatched (click comes after mouseup), and a keyboard
    // activation's keydown is already past the window capture phase, so listening right away is safe.
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('mousedown', this.onMouseDown, true);
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
  }

  /** Cancels a pending capture. Returns true if one was active. */
  cancelCapture(): boolean {
    if (!this.capture) return false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('mousedown', this.onMouseDown, true);
    window.removeEventListener('wheel', this.onWheel, true);
    this.capture = null;
    this.render();
    return true;
  }

  private finish(key: string | null): void {
    const c = this.capture;
    if (!c) return;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('mousedown', this.onMouseDown, true);
    window.removeEventListener('wheel', this.onWheel, true);
    this.capture = null;
    if (key === c.oldKey) {
      this.render();
      return;
    }
    if (c.oldKey) console_.execute(`unbind "${c.oldKey}"`);
    if (key) {
      const prev = this.binds.get(key);
      console_.execute(`bind "${key}" "${c.command}"`);
      if (prev && normalizeCommand(prev) !== normalizeCommand(c.command)) this.deps.toast(`${keyLabel(key)} was bound to "${prev}"`, 'info');
    }
    persistConfigSoon();
    this.deps.sound.play('ui_click');
    this.refresh();
  }

  private captureKey(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === 'Escape') {
      this.deps.sound.play('ui_back');
      this.cancelCapture();
      return;
    }
    if (e.code === 'Backspace' || e.code === 'Delete') {
      this.finish(null);
      return;
    }
    const k = codeToKeyName(e.code);
    if (k) this.finish(k);
  }

  private captureMouse(e: MouseEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    // swallow the click (and context menu) that follows this mousedown so it doesn't trigger UI under the cursor
    const swallow = (ev: Event) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.addEventListener('auxclick', swallow, { capture: true, once: true });
    window.addEventListener('contextmenu', swallow, { capture: true, once: true });
    setTimeout(() => {
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('auxclick', swallow, true);
      window.removeEventListener('contextmenu', swallow, true);
    }, 600);
    const k = mouseButtonToKeyName(e.button);
    if (k) this.finish(k);
  }

  private captureWheel(e: WheelEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    const k = wheelToKeyName(e.deltaY);
    if (k) this.finish(k);
  }
}
