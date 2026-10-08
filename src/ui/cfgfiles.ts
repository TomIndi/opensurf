// User config files (CS:GO .cfg: autoexec.cfg, practice.cfg …) imported from disk or pasted into the console.
// Each one is stored as plain text in localStorage under `surf.cfg.<name>` (lower-case name, no extension); the
// game's `exec <name>` command reads the same key, and `autoexec` runs at startup like in CS:GO.

export const CFG_KEY_PREFIX = 'surf.cfg.';
/** CS:GO configs are a few KB; anything this big is not a config (and would eat the localStorage quota). */
export const MAX_CFG_BYTES = 256 * 1024;
/** `exec config` / `exec config_default` run the game's own saved settings, so imports can't take these names. */
export const RESERVED_CFG_NAMES: readonly string[] = ['config', 'config_default'];

export interface CfgInfo {
  name: string;
  /** Characters of text. */
  size: number;
  /** Non-empty lines that aren't just a // comment. */
  commands: number;
}

/**
 * Normalizes a config name the way `exec` resolves it: path and `.cfg` / `.txt` extension stripped, lower case,
 * only [a-z0-9_.-] (anything else becomes '_'). Null when nothing usable is left.
 */
export function normalizeCfgName(raw: string): string | null {
  let n = raw.trim().replace(/^.*[\\/]/, '').toLowerCase();
  n = n.replace(/(\.cfg|\.txt)+$/i, '');
  n = n.replace(/[^a-z0-9_.-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return n ? n.slice(0, 64) : null;
}

/** The name an imported file is saved under (reserved names get a `csgo_` prefix so they don't shadow ours). */
export function cfgNameForImport(fileName: string): string {
  const n = normalizeCfgName(fileName) ?? 'imported';
  return RESERVED_CFG_NAMES.includes(n) ? `csgo_${n}` : n;
}

export function cfgStorageKey(name: string): string {
  return `${CFG_KEY_PREFIX}${normalizeCfgName(name) ?? name}`;
}

/** Number of lines that would run (blank lines and // comments don't count). */
export function countCfgCommands(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const c = line.indexOf('//');
    if ((c >= 0 ? line.slice(0, c) : line).trim()) n++;
  }
  return n;
}

/** Why a text can't be imported as a config, or null if it can. */
export function cfgImportProblem(text: string): string | null {
  if (text.length > MAX_CFG_BYTES) return `too large (${Math.round(text.length / 1024)} KB; configs are limited to ${MAX_CFG_BYTES / 1024} KB)`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4096))) return 'not a text file';
  if (!countCfgCommands(text)) return 'it contains no commands';
  return null;
}

/** Minimal storage surface (localStorage in the browser, a Map in tests). */
export interface CfgStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): CfgStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadCfg(name: string, store: CfgStorage | null = defaultStorage()): string | null {
  try {
    return store?.getItem(cfgStorageKey(name)) ?? null;
  } catch {
    return null;
  }
}

/** Saves a config; returns false when storage is unavailable or full. */
export function saveCfg(name: string, text: string, store: CfgStorage | null = defaultStorage()): boolean {
  const n = normalizeCfgName(name);
  if (!n || !store) return false;
  try {
    store.setItem(`${CFG_KEY_PREFIX}${n}`, text.replace(/\r\n?/g, '\n'));
    return true;
  } catch {
    return false;
  }
}

export function deleteCfg(name: string, store: CfgStorage | null = defaultStorage()): void {
  try {
    store?.removeItem(cfgStorageKey(name));
  } catch {
    /* storage unavailable */
  }
}

/** Saved configs, autoexec first, then by name. */
export function listCfgs(store: CfgStorage | null = defaultStorage()): CfgInfo[] {
  const out: CfgInfo[] = [];
  if (!store) return out;
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k || !k.startsWith(CFG_KEY_PREFIX)) continue;
      const text = store.getItem(k) ?? '';
      out.push({ name: k.slice(CFG_KEY_PREFIX.length), size: text.length, commands: countCfgCommands(text) });
    }
  } catch {
    /* storage unavailable */
  }
  return out.sort((a, b) => (a.name === 'autoexec' ? -1 : b.name === 'autoexec' ? 1 : a.name.localeCompare(b.name)));
}
