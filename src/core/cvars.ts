// Source-style console: cvars, concommands, aliases, command-line parsing and console output.
// Everything user-tunable (sensitivity, sv_airaccelerate, fov, binds...) goes through here so the
// developer console, chat "!commands", the settings menu and config persistence all agree.

export const FCVAR_NONE = 0;
/** Saved to the user's config (localStorage) — like FCVAR_ARCHIVE. */
export const FCVAR_ARCHIVE = 1 << 0;
/** Only changeable while sv_cheats is 1. */
export const FCVAR_CHEAT = 1 << 1;
/** Server/physics variable (sv_*). Changing it invalidates timer records (practice mode). */
export const FCVAR_REPLICATED = 1 << 2;
/** Hidden from cvarlist/autocomplete. */
export const FCVAR_HIDDEN = 1 << 3;

export interface CvarOptions {
  name: string;
  default: string | number | boolean;
  flags?: number;
  help?: string;
  min?: number;
  max?: number;
  onChange?: (cvar: Cvar, oldValue: string) => void;
}

export class Cvar {
  readonly name: string;
  readonly defaultValue: string;
  readonly flags: number;
  readonly help: string;
  readonly min?: number;
  readonly max?: number;
  private _value: string;
  private _num: number;
  private listeners: Array<(cvar: Cvar, oldValue: string) => void> = [];

  constructor(opts: CvarOptions) {
    this.name = opts.name.toLowerCase();
    this.defaultValue = toCvarString(opts.default);
    this.flags = opts.flags ?? 0;
    this.help = opts.help ?? '';
    this.min = opts.min;
    this.max = opts.max;
    this._value = this.defaultValue;
    this._num = parseFloat(this._value) || 0;
    if (opts.onChange) this.listeners.push(opts.onChange);
  }

  get value(): string {
    return this._value;
  }
  get num(): number {
    return this._num;
  }
  get int(): number {
    return Math.trunc(this._num);
  }
  get bool(): boolean {
    return this._num !== 0;
  }

  set(v: string | number | boolean): void {
    let s = toCvarString(v);
    const n = parseFloat(s);
    if (!Number.isNaN(n) && (this.min !== undefined || this.max !== undefined)) {
      let c = n;
      if (this.min !== undefined && c < this.min) c = this.min;
      if (this.max !== undefined && c > this.max) c = this.max;
      if (c !== n) s = String(c);
    }
    if (s === this._value) return;
    const old = this._value;
    this._value = s;
    this._num = parseFloat(s) || 0;
    for (const l of this.listeners) l(this, old);
    console_.emitChange(this, old);
  }

  reset(): void {
    this.set(this.defaultValue);
  }

  onChange(fn: (cvar: Cvar, oldValue: string) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

function toCvarString(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

export type CommandHandler = (args: string[], argString: string) => void;

export interface CommandOptions {
  name: string;
  help?: string;
  flags?: number;
  handler: CommandHandler;
  /** Optional autocomplete provider for the console. */
  complete?: (partial: string) => string[];
}

export type ConsoleColor = 'default' | 'error' | 'warn' | 'info' | 'success' | 'echo';

export interface ConsoleLine {
  text: string;
  color: ConsoleColor;
}

/** Splits a command line into commands on ';' (outside quotes) and each into argv. */
export function tokenizeCommandLine(line: string): string[][] {
  const commands: string[][] = [];
  let args: string[] = [];
  let cur = '';
  let inQuote = false;
  let hasToken = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        inQuote = false;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"') {
      inQuote = true;
      hasToken = true;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') break; // comment
    if (c === ';' || c === '\n') {
      if (hasToken) args.push(cur);
      if (args.length) commands.push(args);
      args = [];
      cur = '';
      hasToken = false;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      if (hasToken) args.push(cur);
      cur = '';
      hasToken = false;
      continue;
    }
    cur += c;
    hasToken = true;
  }
  if (hasToken) args.push(cur);
  if (args.length) commands.push(args);
  return commands;
}

class ConsoleSystem {
  private cvars = new Map<string, Cvar>();
  private commands = new Map<string, CommandOptions>();
  private aliases = new Map<string, string>();
  private outputListeners: Array<(line: ConsoleLine) => void> = [];
  private changeListeners: Array<(cvar: Cvar, oldValue: string) => void> = [];
  readonly history: ConsoleLine[] = [];
  private aliasDepth = 0;

  registerCvar(opts: CvarOptions): Cvar {
    const key = opts.name.toLowerCase();
    const existing = this.cvars.get(key);
    if (existing) return existing;
    const cv = new Cvar(opts);
    this.cvars.set(key, cv);
    return cv;
  }

  registerCommand(opts: CommandOptions): void {
    this.commands.set(opts.name.toLowerCase(), opts);
  }

  getCvar(name: string): Cvar | undefined {
    return this.cvars.get(name.toLowerCase());
  }

  /** Returns the cvar or throws — use for cvars a module registered itself. */
  cvar(name: string): Cvar {
    const c = this.cvars.get(name.toLowerCase());
    if (!c) throw new Error(`unknown cvar ${name}`);
    return c;
  }

  hasCommand(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  allCvars(): Cvar[] {
    return [...this.cvars.values()];
  }

  allCommands(): CommandOptions[] {
    return [...this.commands.values()];
  }

  setAlias(name: string, value: string): void {
    this.aliases.set(name.toLowerCase(), value);
  }

  getAlias(name: string): string | undefined {
    return this.aliases.get(name.toLowerCase());
  }

  /** Executes a console line (may contain several ';'-separated commands). */
  execute(line: string, echo = false): void {
    if (echo) this.print(`] ${line}`, 'echo');
    for (const argv of tokenizeCommandLine(line)) this.executeArgv(argv);
  }

  executeArgv(argv: string[]): void {
    if (!argv.length) return;
    const name = argv[0].toLowerCase();
    const alias = this.aliases.get(name);
    if (alias !== undefined) {
      if (this.aliasDepth > 32) {
        this.print(`alias recursion limit hit in "${name}"`, 'error');
        return;
      }
      this.aliasDepth++;
      try {
        this.execute(alias);
      } finally {
        this.aliasDepth--;
      }
      return;
    }
    const cmd = this.commands.get(name);
    if (cmd) {
      if (cmd.flags && cmd.flags & FCVAR_CHEAT && !this.cheatsEnabled()) {
        this.print(`Can't use cheat command ${name} in multiplayer, unless the server has sv_cheats set to 1.`, 'warn');
        return;
      }
      const args = argv.slice(1);
      try {
        cmd.handler(args, args.map(quoteIfNeeded).join(' '));
      } catch (e) {
        this.print(`error in ${name}: ${(e as Error).message}`, 'error');
        console.error(e);
      }
      return;
    }
    const cv = this.cvars.get(name);
    if (cv) {
      if (argv.length === 1) {
        this.print(`"${cv.name}" = "${cv.value}" ( def. "${cv.defaultValue}" )${cv.help ? `\n - ${cv.help}` : ''}`);
        return;
      }
      if (cv.flags & FCVAR_CHEAT && !this.cheatsEnabled()) {
        this.print(`Can't change cheat cvar ${cv.name} in multiplayer, unless the server has sv_cheats set to 1.`, 'warn');
        return;
      }
      cv.set(argv.slice(1).join(' '));
      return;
    }
    this.print(`Unknown command "${argv[0]}"`, 'warn');
  }

  private cheatsEnabled(): boolean {
    const c = this.cvars.get('sv_cheats');
    return !c || c.bool;
  }

  print(text: string, color: ConsoleColor = 'default'): void {
    const line = { text, color };
    this.history.push(line);
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    for (const l of this.outputListeners) l(line);
  }

  onOutput(fn: (line: ConsoleLine) => void): () => void {
    this.outputListeners.push(fn);
    return () => {
      const i = this.outputListeners.indexOf(fn);
      if (i >= 0) this.outputListeners.splice(i, 1);
    };
  }

  onCvarChange(fn: (cvar: Cvar, oldValue: string) => void): () => void {
    this.changeListeners.push(fn);
    return () => {
      const i = this.changeListeners.indexOf(fn);
      if (i >= 0) this.changeListeners.splice(i, 1);
    };
  }

  /** @internal */
  emitChange(cvar: Cvar, old: string): void {
    for (const l of this.changeListeners) l(cvar, old);
  }

  /** Autocomplete for the console input. */
  complete(partial: string): string[] {
    const p = partial.toLowerCase();
    const out: string[] = [];
    const sp = p.indexOf(' ');
    if (sp > 0) {
      const cmd = this.commands.get(p.slice(0, sp));
      if (cmd?.complete) return cmd.complete(partial.slice(sp + 1)).map((s) => `${p.slice(0, sp)} ${s}`);
      return out;
    }
    for (const c of this.commands.values()) if (c.name.startsWith(p) && !((c.flags ?? 0) & FCVAR_HIDDEN)) out.push(c.name);
    for (const c of this.cvars.values()) if (c.name.startsWith(p) && !(c.flags & FCVAR_HIDDEN)) out.push(c.name);
    out.sort();
    return out.slice(0, 64);
  }
}

function quoteIfNeeded(s: string): string {
  return /[\s;]/.test(s) ? `"${s}"` : s;
}

/** The single global console instance. */
export const console_ = new ConsoleSystem();

// ---- convenience helpers ----
export const registerCvar = (o: CvarOptions): Cvar => console_.registerCvar(o);
export const registerCommand = (o: CommandOptions): void => console_.registerCommand(o);
export const cvar = (name: string): Cvar => console_.cvar(name);
export const execute = (line: string, echo = false): void => console_.execute(line, echo);
export const conPrint = (text: string, color: ConsoleColor = 'default'): void => console_.print(text, color);

// ---- archive persistence (config.cfg equivalent) ----
const CONFIG_KEY = 'surf.config.v1';

export function saveArchivedCvars(extraLines: string[] = []): void {
  const lines: string[] = [];
  for (const cv of console_.allCvars()) {
    if (cv.flags & FCVAR_ARCHIVE && cv.value !== cv.defaultValue) lines.push(`${cv.name} "${cv.value}"`);
  }
  lines.push(...extraLines);
  try {
    localStorage.setItem(CONFIG_KEY, lines.join('\n'));
  } catch {
    /* storage unavailable */
  }
}

export function loadArchivedConfig(): string | null {
  try {
    return localStorage.getItem(CONFIG_KEY);
  } catch {
    return null;
  }
}
