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
  const m = /^\s*"?([^"=\s]+)"?\s*=\s*"(.*)"\s*$/.exec(text);
  if (!m) return null;
  return [m[1].toLowerCase(), m[2]];
}

/**
 * Reads the binding of each key by querying `bind <key>` silently. Works with any game-core that prints
 * Source-style bind output. Returns key -> command for bound keys.
 */
export function queryBinds(keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!console_.hasCommand('bind')) return out;
  for (const key of keys) {
    const quoted = key === '"' ? key : `"${key}"`;
    const lines = runSilently(() => console_.execute(`bind ${quoted}`));
    for (const l of lines) {
      for (const part of l.text.split('\n')) {
        const p = parseBindLine(part);
        if (p && p[0] === key.toLowerCase() && p[1] !== '') out.set(key, p[1]);
      }
    }
  }
  return out;
}
