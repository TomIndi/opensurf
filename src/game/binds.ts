// Key bindings, Source style: key names ("w", "space", "mouse4", "mwheeldown", "kp_enter", ...) map to command
// lines; `bind`, `unbind`, `unbindall`, `binddefaults`, `key_listboundkeys`, `key_findbinding` work like in CS:GO.
//
// Config persistence (config.cfg equivalent): host_writeconfig stores the archived cvars that differ from their
// default, then `unbindall` + every bind (+ extra lines from providers, e.g. aliases), in localStorage via
// saveArchivedCvars(). Any bind/alias/archived-cvar change schedules a debounced save. At startup the saved
// config is executed, so the binds come back exactly as they were (including keys the user unbound). A default
// bind added in a later version (G = !undo) is bound on top of a config saved before it existed, unless that
// config binds the key to something else (`bind_defaults_version` in the config tells which defaults it knew).
import {
  conPrint,
  console_,
  FCVAR_ARCHIVE,
  FCVAR_HIDDEN,
  loadArchivedConfig,
  registerCommand,
  saveArchivedCvars,
  tokenizeCommandLine,
} from '../core/cvars';

// ------------------------------------------------------------------------------------------ key names

/** KeyboardEvent.code -> Source key name. Left and right modifiers share one name (like the binds UI). */
const CODE_TO_KEY: Readonly<Record<string, string>> = {
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

const MOUSE_KEYS = ['mouse1', 'mouse2', 'mouse3', 'mouse4', 'mouse5', 'mwheelup', 'mwheeldown'];

function buildKeyNames(): string[] {
  const out: string[] = [];
  for (let c = 97; c <= 122; c++) out.push(String.fromCharCode(c));
  for (let d = 0; d <= 9; d++) out.push(String(d));
  for (let f = 1; f <= 12; f++) out.push(`f${f}`);
  for (const v of Object.values(CODE_TO_KEY)) if (!out.includes(v)) out.push(v);
  out.push(...MOUSE_KEYS);
  return out;
}

/** Every bindable key name (keyboard, mouse buttons, wheel). */
export const KEY_NAMES: readonly string[] = buildKeyNames();
const KEY_SET: ReadonlySet<string> = new Set(KEY_NAMES);

/** Other spellings accepted by `bind`/`unbind` (Source's right-hand modifiers, a few friendly names). */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  rctrl: 'ctrl',
  lctrl: 'ctrl',
  control: 'ctrl',
  rshift: 'shift',
  lshift: 'shift',
  ralt: 'alt',
  lalt: 'alt',
  ';': 'semicolon',
  esc: 'escape',
  return: 'enter',
  delete: 'del',
  insert: 'ins',
  pageup: 'pgup',
  pagedown: 'pgdn',
  up: 'uparrow',
  down: 'downarrow',
  left: 'leftarrow',
  right: 'rightarrow',
  '~': '`',
  mwheel_up: 'mwheelup',
  mwheel_down: 'mwheeldown',
};

/** Canonical Source key name for a user-typed key name (case-insensitive), or null if it isn't a key. */
export function normalizeKeyName(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (KEY_SET.has(n)) return n;
  const a = KEY_ALIASES[n];
  return a ?? null;
}

/** KeyboardEvent.code -> Source key name (layout independent, like Source scan codes). Null if unsupported. */
export function codeToKeyName(code: string): string | null {
  if (!code) return null;
  const mapped = CODE_TO_KEY[code];
  if (mapped) return mapped;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^F([1-9]|1[0-2])$/.exec(code);
  if (m) return `f${m[1]}`;
  return null;
}

/** Source key name -> the KeyboardEvent.code values producing it (empty for mouse keys / unknown names). */
export function keyNameToCodes(name: string): string[] {
  const n = normalizeKeyName(name);
  if (!n) return [];
  const out: string[] = [];
  for (const [code, k] of Object.entries(CODE_TO_KEY)) if (k === n) out.push(code);
  if (/^[a-z]$/.test(n)) out.push(`Key${n.toUpperCase()}`);
  else if (/^[0-9]$/.test(n)) out.push(`Digit${n}`);
  else if (/^f([1-9]|1[0-2])$/.test(n)) out.push(`F${n.slice(1)}`);
  return out;
}

/** MouseEvent.button -> Source mouse key (0 left = mouse1, 2 right = mouse2, 1 middle = mouse3, 3/4 side buttons). */
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

/** Wheel direction -> mwheelup / mwheeldown (null for a purely horizontal scroll). */
export function wheelToKeyName(deltaY: number): string | null {
  if (deltaY < 0) return 'mwheelup';
  if (deltaY > 0) return 'mwheeldown';
  return null;
}

// ------------------------------------------------------------------------------------------ the bind table

/** CS:GO defaults plus the surf server conventions (docs/ARCHITECTURE.md "Default binds"). */
export const DEFAULT_BINDS: Readonly<Record<string, string>> = Object.freeze({
  w: '+forward',
  s: '+back',
  a: '+moveleft',
  d: '+moveright',
  space: '+jump',
  mwheeldown: '+jump',
  mwheelup: '+jump',
  ctrl: '+duck',
  shift: '+speed',
  e: '+use',
  tab: '+showscores',
  '`': 'toggleconsole',
  y: 'messagemode',
  u: 'messagemode2',
  r: 'say !r',
  t: 'say !back',
  g: 'say !undo',
  mouse4: 'say !saveloc',
  mouse5: 'say !tele',
  f2: 'say !prac',
  escape: 'cancelselect',
});

/**
 * Version of the default bind set: bumped when a default bind is added. A saved config records the version it was
 * written with (`bind_defaults_version`); the defaults added after it are bound when that config is loaded.
 */
export const BIND_DEFAULTS_VERSION = 2;

/** Default binds added after the first release: key -> the BIND_DEFAULTS_VERSION that added it. */
const ADDED_DEFAULT_BINDS: Readonly<Record<string, number>> = Object.freeze({ g: 2 });

export class BindTable {
  private readonly map = new Map<string, string>();
  /** Bumped on every change (consumers can cache derived data). */
  version = 0;

  constructor(defaults: Readonly<Record<string, string>> = DEFAULT_BINDS) {
    for (const [k, v] of Object.entries(defaults)) this.map.set(k, v);
  }

  get(key: string): string | undefined {
    const n = normalizeKeyName(key);
    return n ? this.map.get(n) : undefined;
  }

  /** Binds `key` (any accepted spelling). Returns false for an invalid key name. An empty command unbinds. */
  set(key: string, command: string): boolean {
    const n = normalizeKeyName(key);
    if (!n) return false;
    if (command === '') {
      this.delete(n);
      return true;
    }
    if (this.map.get(n) !== command) {
      this.map.set(n, command);
      this.version++;
    }
    return true;
  }

  delete(key: string): boolean {
    const n = normalizeKeyName(key);
    if (!n || !this.map.has(n)) return false;
    this.map.delete(n);
    this.version++;
    return true;
  }

  clear(): void {
    if (this.map.size) this.version++;
    this.map.clear();
  }

  resetToDefaults(): void {
    this.map.clear();
    for (const [k, v] of Object.entries(DEFAULT_BINDS)) this.map.set(k, v);
    this.version++;
  }

  get size(): number {
    return this.map.size;
  }

  /** [key, command] pairs in KEY_NAMES order (stable output for key_listboundkeys and the config). */
  entries(): [string, string][] {
    const out: [string, string][] = [];
    for (const k of KEY_NAMES) {
      const v = this.map.get(k);
      if (v !== undefined) out.push([k, v]);
    }
    return out;
  }

  /** Keys whose binding is `command` (compared case-insensitively, ignoring quotes and extra spaces). */
  keysFor(command: string): string[] {
    const want = normalizeCommandText(command);
    return this.entries()
      .filter(([, v]) => normalizeCommandText(v) === want)
      .map(([k]) => k);
  }
}

export function normalizeCommandText(cmd: string): string {
  return cmd.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The global bind table. */
export const binds = new BindTable();

/** `bind "<key>" "<command>"` (quotes so any key/command round-trips through the tokenizer). */
export function bindLine(key: string, command: string): string {
  return `bind "${key}" "${command}"`;
}

// ------------------------------------------------------------------------------------------ config persistence

const SAVE_DELAY_MS = 500;
const configProviders: Array<() => string[]> = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loadingConfig = false;

/** Adds lines (e.g. `alias` definitions) to the saved config after the binds. */
export function addConfigProvider(fn: () => string[]): void {
  configProviders.push(fn);
}

/** The non-cvar part of the config: `unbindall`, the default binds version, every bind, then provider lines. */
export function configExtraLines(): string[] {
  const lines = ['unbindall', `bind_defaults_version ${BIND_DEFAULTS_VERSION}`];
  for (const [k, v] of binds.entries()) lines.push(bindLine(k, v));
  for (const p of configProviders) {
    try {
      lines.push(...p());
    } catch (e) {
      console.error(e);
    }
  }
  return lines;
}

/** host_writeconfig: saves archived cvars + binds + provider lines now. */
export function writeConfig(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveArchivedCvars(configExtraLines());
}

/** Debounced writeConfig (binds/aliases/archived cvars changed). Ignored while the config itself is executing. */
export function scheduleConfigSave(delayMs = SAVE_DELAY_MS): void {
  if (loadingConfig) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeConfig();
  }, delayMs);
}

/** True when a debounced save is pending (tests). */
export function configSavePending(): boolean {
  return saveTimer !== null;
}

/**
 * Executes config text line by line. Lines whose command is unknown (a cvar from an older version...) are
 * skipped silently instead of printing "Unknown command" at startup. Returns the number of executed lines.
 */
export function execConfigText(text: string): number {
  let n = 0;
  const prev = loadingConfig;
  loadingConfig = true;
  try {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      for (const argv of tokenizeCommandLine(line)) {
        const name = argv[0]?.toLowerCase() ?? '';
        if (!name || (!console_.hasCommand(name) && !console_.getCvar(name) && console_.getAlias(name) === undefined)) continue;
        console_.executeArgv(argv);
        n++;
      }
    }
  } finally {
    loadingConfig = prev;
  }
  return n;
}

/** bind_defaults_version of the config being executed (1: a config saved before the version was recorded). */
let configDefaultsVersion = BIND_DEFAULTS_VERSION;

/**
 * After a saved config of default-binds version `version` ran: the defaults added since are bound, except on a key
 * the config bound to something (its `unbindall` removed the defaults it didn't know about). Returns the keys bound.
 */
export function applyAddedDefaultBinds(version: number, table: BindTable = binds): string[] {
  const out: string[] = [];
  for (const [key, since] of Object.entries(ADDED_DEFAULT_BINDS)) {
    if (since <= version || table.get(key) !== undefined) continue;
    table.set(key, DEFAULT_BINDS[key]);
    out.push(key);
  }
  return out;
}

/** Executes the saved config (startup). Returns false when there is none. */
export function loadSavedConfig(): boolean {
  const text = loadArchivedConfig();
  if (!text) return false;
  configDefaultsVersion = 1;
  try {
    execConfigText(text);
    applyAddedDefaultBinds(configDefaultsVersion);
  } finally {
    configDefaultsVersion = BIND_DEFAULTS_VERSION;
  }
  return true;
}

// ------------------------------------------------------------------------------------------ commands

let commandsRegistered = false;
let archiveListenerInstalled = false;

function keyError(key: string): void {
  conPrint(`"${key}" isn't a valid key`, 'warn');
}

/** Registers bind/unbind/unbindall/binddefaults/key_listboundkeys/key_findbinding/host_writeconfig (idempotent). */
export function registerBindCommands(): void {
  if (commandsRegistered) return;
  commandsRegistered = true;
  const keyComplete = (partial: string): string[] => {
    const p = partial.replace(/"/g, '').toLowerCase();
    return KEY_NAMES.filter((k) => k.startsWith(p)).slice(0, 64);
  };
  registerCommand({
    name: 'bind',
    help: 'bind <key> [command] : attach a command to a key',
    complete: keyComplete,
    handler: (args) => {
      if (!args.length) {
        conPrint('bind <key> [command] : attach a command to a key');
        return;
      }
      const key = normalizeKeyName(args[0]);
      if (!key) {
        keyError(args[0]);
        return;
      }
      if (args.length === 1) {
        const b = binds.get(key);
        conPrint(b !== undefined ? `"${key}" = "${b}"` : `"${key}" is not bound`);
        return;
      }
      const cmd = args.slice(1).join(' ');
      binds.set(key, cmd);
      scheduleConfigSave();
    },
  });
  registerCommand({
    name: 'unbind',
    help: 'unbind <key> : remove commands from a key',
    complete: keyComplete,
    handler: (args) => {
      if (!args.length) {
        conPrint('unbind <key> : remove commands from a key');
        return;
      }
      const key = normalizeKeyName(args[0]);
      if (!key) {
        keyError(args[0]);
        return;
      }
      binds.delete(key);
      scheduleConfigSave();
    },
  });
  registerCommand({
    name: 'unbindall',
    help: 'Unbind all keys.',
    handler: () => {
      binds.clear();
      scheduleConfigSave();
    },
  });
  registerCommand({
    name: 'binddefaults',
    help: 'Restore the default key bindings (CS:GO + surf).',
    handler: () => {
      binds.resetToDefaults();
      scheduleConfigSave();
    },
  });
  registerCommand({
    name: 'key_listboundkeys',
    help: 'List bound keys with their bindings.',
    handler: () => {
      for (const [k, v] of binds.entries()) conPrint(`"${k}" = "${v}"`);
    },
  });
  registerCommand({
    name: 'key_findbinding',
    help: 'key_findbinding <substring> : find keys bound to commands containing the substring.',
    handler: (args) => {
      if (!args.length) {
        conPrint('usage:  key_findbinding substring');
        return;
      }
      const q = args.join(' ').toLowerCase();
      let found = 0;
      for (const [k, v] of binds.entries()) {
        if (v.toLowerCase().includes(q)) {
          conPrint(`"${k}" = "${v}"`);
          found++;
        }
      }
      if (!found) conPrint(`No keys bound to anything containing "${q}"`);
    },
  });
  registerCommand({
    name: 'bind_defaults_version',
    help: 'Written into the saved config: the version of the default binds it was saved with.',
    flags: FCVAR_HIDDEN,
    handler: (args) => {
      const v = parseInt(args[0] ?? '', 10);
      configDefaultsVersion = Number.isFinite(v) && v > 0 ? v : 1;
    },
  });
  registerCommand({
    name: 'host_writeconfig',
    help: 'Store current settings (archived cvars, binds, aliases).',
    handler: () => writeConfig(),
  });
  if (!archiveListenerInstalled) {
    archiveListenerInstalled = true;
    console_.onCvarChange((c) => {
      if (c.flags & FCVAR_ARCHIVE) scheduleConfigSave();
    });
  }
}
