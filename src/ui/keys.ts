// Browser input -> Source key names (as used by `bind`), and pretty labels for the binds editor.

const CODE_MAP: Record<string, string> = {
  Space: 'space',
  ControlLeft: 'ctrl',
  ControlRight: 'ctrl',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  AltLeft: 'alt',
  AltRight: 'alt',
  MetaLeft: 'lwin',
  MetaRight: 'rwin',
  ContextMenu: 'app',
  Tab: 'tab',
  Enter: 'enter',
  Escape: 'escape',
  Backspace: 'backspace',
  CapsLock: 'capslock',
  ArrowUp: 'uparrow',
  ArrowDown: 'downarrow',
  ArrowLeft: 'leftarrow',
  ArrowRight: 'rightarrow',
  Insert: 'ins',
  Delete: 'del',
  Home: 'home',
  End: 'end',
  PageUp: 'pgup',
  PageDown: 'pgdn',
  Pause: 'pause',
  ScrollLock: 'scrolllock',
  NumLock: 'numlock',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: 'semicolon',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Numpad0: 'kp_ins',
  Numpad1: 'kp_end',
  Numpad2: 'kp_downarrow',
  Numpad3: 'kp_pgdn',
  Numpad4: 'kp_leftarrow',
  Numpad5: 'kp_5',
  Numpad6: 'kp_rightarrow',
  Numpad7: 'kp_home',
  Numpad8: 'kp_uparrow',
  Numpad9: 'kp_pgup',
  NumpadDecimal: 'kp_del',
  NumpadEnter: 'kp_enter',
  NumpadAdd: 'kp_plus',
  NumpadSubtract: 'kp_minus',
  NumpadMultiply: 'kp_multiply',
  NumpadDivide: 'kp_slash',
};

/** KeyboardEvent.code -> Source key name (layout independent, like Source scan codes). Null if unsupported. */
export function codeToKeyName(code: string): string | null {
  if (!code) return null;
  const mapped = CODE_MAP[code];
  if (mapped) return mapped;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^F([1-9]|1[0-2])$/.exec(code);
  if (m) return `f${m[1]}`;
  return null;
}

/** MouseEvent.button -> Source mouse key. */
export function mouseButtonToKeyName(button: number): string | null {
  switch (button) {
    case 0:
      return 'mouse1';
    case 1:
      return 'mouse3';
    case 2:
      return 'mouse2';
    case 3:
      return 'mouse4';
    case 4:
      return 'mouse5';
    default:
      return null;
  }
}

export function wheelToKeyName(deltaY: number): string | null {
  if (deltaY < 0) return 'mwheelup';
  if (deltaY > 0) return 'mwheeldown';
  return null;
}

const LABELS: Record<string, string> = {
  space: 'SPACE',
  ctrl: 'CTRL',
  shift: 'SHIFT',
  alt: 'ALT',
  tab: 'TAB',
  enter: 'ENTER',
  escape: 'ESC',
  backspace: 'BACKSPACE',
  capslock: 'CAPS LOCK',
  uparrow: '↑',
  downarrow: '↓',
  leftarrow: '←',
  rightarrow: '→',
  mouse1: 'MOUSE 1',
  mouse2: 'MOUSE 2',
  mouse3: 'MOUSE 3',
  mouse4: 'MOUSE 4',
  mouse5: 'MOUSE 5',
  mwheelup: 'WHEEL ↑',
  mwheeldown: 'WHEEL ↓',
  semicolon: ';',
  '`': '~',
  ins: 'INS',
  del: 'DEL',
  home: 'HOME',
  end: 'END',
  pgup: 'PG UP',
  pgdn: 'PG DN',
  lwin: 'WIN',
  rwin: 'WIN',
  app: 'MENU',
};

/** Pretty label for a Source key name ("mwheeldown" -> "WHEEL ↓", "kp_end" -> "NUMPAD 1"). */
export function keyLabel(name: string): string {
  const n = name.toLowerCase();
  if (LABELS[n]) return LABELS[n];
  if (n.startsWith('kp_')) {
    const kp: Record<string, string> = {
      kp_ins: '0',
      kp_end: '1',
      kp_downarrow: '2',
      kp_pgdn: '3',
      kp_leftarrow: '4',
      kp_5: '5',
      kp_rightarrow: '6',
      kp_home: '7',
      kp_uparrow: '8',
      kp_pgup: '9',
      kp_del: '.',
      kp_enter: 'ENTER',
      kp_plus: '+',
      kp_minus: '-',
      kp_multiply: '*',
      kp_slash: '/',
    };
    return `NUMPAD ${kp[n] ?? n.slice(3).toUpperCase()}`;
  }
  return n.toUpperCase();
}

/** All key names the binds editor queries (keyboard + mouse). */
export function allKeyNames(): string[] {
  const keys: string[] = [];
  for (let c = 97; c <= 122; c++) keys.push(String.fromCharCode(c));
  for (let d = 0; d <= 9; d++) keys.push(String(d));
  for (let f = 1; f <= 12; f++) keys.push(`f${f}`);
  const seen = new Set(keys);
  for (const v of Object.values(CODE_MAP)) {
    if (!seen.has(v)) {
      seen.add(v);
      keys.push(v);
    }
  }
  keys.push('mouse1', 'mouse2', 'mouse3', 'mouse4', 'mouse5', 'mwheelup', 'mwheeldown');
  return keys;
}
