// User .cfg files (autoexec.cfg, practice.cfg ...), stored in localStorage as `surf.cfg.<name>` (name lower-case,
// without ".cfg"), and `exec <name>` running them like Source: line by line, `//` comments, quoted arguments,
// `;`-separated commands, aliases; unknown commands are reported like the engine does. The UI writes the same keys
// when a .cfg file is pasted or dropped (docs/CONTRACT_CHANGES.md). `autoexec` runs at startup after the saved
// config, like CS:GO's autoexec.cfg after config.cfg.
import { conPrint, console_ } from '../core/cvars';

/** localStorage key prefix of stored configs: `surf.cfg.autoexec`. */
export const CFG_STORAGE_PREFIX = 'surf.cfg.';
/** Nested exec depth (a cfg exec-ing itself must not hang the page). */
const MAX_EXEC_DEPTH = 8;
/** Largest stored cfg (characters): real autoexecs are a few KB. */
export const MAX_CFG_LENGTH = 256 * 1024;

export interface CfgStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

let override: CfgStorage | null = null;

/** Replaces the storage backend (tests); null restores localStorage. */
export function setCfgStorage(s: CfgStorage | null): void {
  override = s;
}

function storage(): CfgStorage | null {
  if (override) return override;
  try {
    const ls = (globalThis as { localStorage?: CfgStorage }).localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch {
    /* sandboxed: no storage */
  }
  return null;
}

/**
 * Canonical cfg name, the same one the UI's .cfg import stores under: without directories ("cfg/",
 * "csgo/cfg/") and the ".cfg" / ".txt" extension, lower-case, anything but [a-z0-9_.-] turned into '_', at most
 * 64 characters ("CFG/My Config.cfg" -> "my_config"). "" when nothing usable is left.
 */
export function normalizeCfgName(name: string): string {
  let n = name.trim().replace(/^"+|"+$/g, '').replace(/^.*[\\/]/, '').toLowerCase();
  n = n.replace(/(\.cfg|\.txt)+$/i, '');
  n = n.replace(/[^a-z0-9_.-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return n.slice(0, 64);
}

/** The stored text of cfg `name`, or null. */
export function readCfg(name: string): string | null {
  const n = normalizeCfgName(name);
  if (!n) return null;
  try {
    return storage()?.getItem(CFG_STORAGE_PREFIX + n) ?? null;
  } catch {
    return null;
  }
}

/** Stores cfg `name` (false when the name is invalid, the text too long or storage unavailable). */
export function writeCfg(name: string, text: string): boolean {
  const n = normalizeCfgName(name);
  const st = storage();
  if (!n || !st || text.length > MAX_CFG_LENGTH) return false;
  try {
    st.setItem(CFG_STORAGE_PREFIX + n, text);
    return true;
  } catch {
    return false;
  }
}

/** Deletes cfg `name`; false if there was none. */
export function deleteCfg(name: string): boolean {
  const n = normalizeCfgName(name);
  const st = storage();
  if (!n || !st) return false;
  try {
    if (st.getItem(CFG_STORAGE_PREFIX + n) === null) return false;
    st.removeItem(CFG_STORAGE_PREFIX + n);
    return true;
  } catch {
    return false;
  }
}

/** Names of the stored cfgs, sorted. */
export function listCfgs(): string[] {
  const st = storage();
  if (!st) return [];
  const out: string[] = [];
  try {
    const len = typeof st.length === 'number' ? st.length : 0;
    for (let i = 0; i < len && typeof st.key === 'function'; i++) {
      const k = st.key(i);
      if (k && k.startsWith(CFG_STORAGE_PREFIX)) out.push(k.slice(CFG_STORAGE_PREFIX.length));
    }
  } catch {
    return [];
  }
  return out.sort();
}

let depth = 0;

/**
 * Runs config text like Source's exec: each line on its own (an unclosed quote ends with its line), `//` comments,
 * quotes and `;` handled by the console tokenizer, aliases expanded. Returns the number of non-empty lines run.
 */
export function execCfgText(text: string): number {
  let n = 0;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    console_.execute(line);
    n++;
  }
  return n;
}

/**
 * `exec <name>`: runs a stored cfg (silently, like CS:GO). False (after printing "exec: couldn't exec <name>")
 * when there is none; `quiet` skips that message (startup autoexec).
 */
export function execCfg(name: string, quiet = false): boolean {
  const text = readCfg(name);
  if (text === null) {
    if (!quiet) conPrint(`exec: couldn't exec ${name}`, 'warn');
    return false;
  }
  if (depth >= MAX_EXEC_DEPTH) {
    conPrint(`exec: ${name}: too many nested execs (${MAX_EXEC_DEPTH})`, 'error');
    return false;
  }
  depth++;
  try {
    execCfgText(text);
  } finally {
    depth--;
  }
  return true;
}
