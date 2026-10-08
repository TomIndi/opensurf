// Console helpers: running commands "silently" (capturing their output instead of showing it), used by the
// binds editor to query `bind <key>` and by settings persistence.
import { console_, ConsoleLine } from '../core/cvars';

let silentDepth = 0;

/** True while runSilently() is executing: the console view ignores output then. */
export function isSilent(): boolean {
  return silentDepth > 0;
}

/** Runs fn, capturing (and removing from console history) everything it prints. */
export function runSilently(fn: () => void): ConsoleLine[] {
  const captured: ConsoleLine[] = [];
  const off = console_.onOutput((l) => captured.push(l));
  silentDepth++;
  try {
    fn();
  } finally {
    silentDepth--;
    off();
  }
  if (captured.length) {
    const set = new Set(captured);
    const hist = console_.history;
    for (let i = hist.length - 1; i >= 0 && set.size; i--) {
      if (set.has(hist[i])) {
        set.delete(hist[i]);
        hist.splice(i, 1);
      }
    }
  }
  return captured;
}

/** Parses Source `bind <key>` output: `"w" = "+forward"` -> ['w', '+forward']; unbound -> null. */
export function parseBindLine(text: string): [string, string] | null {
  const m = /^\s*"?([^"=\s]+)"?\s*=\s*(?:"(.*)"|(\S.*?))\s*$/.exec(text);
  if (!m) return null;
  const value = m[2] ?? m[3] ?? '';
  return [m[1].toLowerCase(), value];
}

function parseBindOutput(lines: { text: string }[], into: Map<string, string>, only?: string): void {
  for (const l of lines) {
    for (const part of l.text.split('\n')) {
      const p = parseBindLine(part);
      if (p && p[1] !== '' && (only === undefined || p[0] === only)) into.set(p[0], p[1]);
    }
  }
}

/**
 * Reads the current key bindings through the console (works with any game-core that prints Source-style
 * bind output): `key_listboundkeys` when available (one command), otherwise `bind <key>` for each key.
 * Returns key -> command for bound keys.
 */
export function queryBinds(keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (console_.hasCommand('key_listboundkeys')) {
    parseBindOutput(runSilently(() => console_.execute('key_listboundkeys')), out);
    if (out.size) return out;
  }
  if (!console_.hasCommand('bind')) return out;
  for (const key of keys) {
    const quoted = key === '"' ? key : `"${key}"`;
    parseBindOutput(runSilently(() => console_.execute(`bind ${quoted}`)), out, key.toLowerCase());
  }
  return out;
}

/** True if `key` is bound to exactly `command` (e.g. a non-default key bound to toggleconsole). */
export function keyBoundTo(key: string, command: string): boolean {
  if (!console_.hasCommand('bind')) return false;
  const got = queryBinds([key]).get(key.toLowerCase());
  return got !== undefined && got.replace(/"/g, '').trim().toLowerCase() === command.toLowerCase();
}
