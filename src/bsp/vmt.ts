// Valve KeyValues text parser and VMT (material) resolution, written from the public format description.
//
// KeyValues: `"key" "value"` pairs and `"key" { ... }` blocks; tokens may be quoted or bare; `//` comments;
// platform conditionals `[$X360]`, `[!$X360]`, `[$WIN32 || $OSX]` after a key or value. Keys are lower-cased,
// values keep their case. Duplicate scalar keys: last one wins; duplicate blocks are merged.
//
// VMT: the root key is the shader name. "patch" materials include another VMT and apply "insert" / "replace"
// blocks on top of it. Shader fallback blocks for a DX9-class PC ("<shader>_dx9", "<shader>_hdr_dx9",
// ">=dx90", ...) are merged into the root parameters; blocks for older hardware ("_dx8", "<dx90") are ignored.

export type KeyValues = { [key: string]: string | KeyValues };

export interface VmtInfo {
  /** Lower-cased shader name ("lightmappedgeneric", "unlitgeneric", "water", "patch" if the include is missing). */
  shader: string;
  /** Scalar parameters with lower-cased keys ("$basetexture", "%compilewater", ...). */
  params: Record<string, string>;
  /** The "proxies" block, or null. */
  proxies: KeyValues | null;
  /** For a "patch" whose include could not be read: the include path as written. */
  includeMissing?: string;
  /** For a "patch": the include chain that was resolved (paths as written), outermost first. */
  includes?: string[];
  /** The resolved material body (after patching, before fallback-block merging). */
  body?: KeyValues;
}

// ------------------------------------------------------------------ conditionals

/** Platform defines for a Windows PC client (what the PC game evaluates). */
const PLATFORM_DEFINES: Record<string, boolean> = {
  $win32: true,
  $win64: true,
  $windows: true,
  $x360: false,
  $ps3: false,
  $gameconsole: false,
  $osx: false,
  $linux: false,
  $posix: false,
  $deck: false,
};

/** Evaluates a KeyValues conditional such as "[$X360]", "[!$X360 && !$PS3]" or "[$WIN32||$OSX]". */
export function evaluateConditional(cond: string): boolean {
  let s = cond.trim();
  if (s.startsWith('[')) s = s.slice(1);
  if (s.endsWith(']')) s = s.slice(0, -1);
  // OR of ANDs (&& binds tighter).
  return s.split('||').some((conj) =>
    conj.split('&&').every((term) => {
      let t = term.trim().toLowerCase();
      let neg = false;
      while (t.startsWith('!')) {
        neg = !neg;
        t = t.slice(1).trim();
      }
      if (!t) return !neg;
      const v = PLATFORM_DEFINES[t] ?? false;
      return neg ? !v : v;
    }),
  );
}

// ------------------------------------------------------------------ tokenizer

const enum Tok {
  Eof,
  Str,
  Open,
  Close,
  Cond,
}

class Tokenizer {
  pos = 0;
  type: Tok = Tok.Eof;
  value = '';
  quoted = false;
  private peeked = false;

  constructor(private readonly s: string) {
    if (s.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  peek(): Tok {
    if (!this.peeked) {
      this.read();
      this.peeked = true;
    }
    return this.type;
  }

  next(): Tok {
    if (this.peeked) {
      this.peeked = false;
      return this.type;
    }
    this.read();
    return this.type;
  }

  private read(): void {
    const s = this.s;
    const n = s.length;
    let p = this.pos;
    // whitespace and // comments
    for (;;) {
      while (p < n && s.charCodeAt(p) <= 32) p++;
      if (p + 1 < n && s.charCodeAt(p) === 47 && s.charCodeAt(p + 1) === 47) {
        while (p < n && s.charCodeAt(p) !== 10) p++;
        continue;
      }
      break;
    }
    this.quoted = false;
    if (p >= n) {
      this.pos = p;
      this.type = Tok.Eof;
      this.value = '';
      return;
    }
    const c = s[p];
    if (c === '{') {
      this.pos = p + 1;
      this.type = Tok.Open;
      this.value = '{';
      return;
    }
    if (c === '}') {
      this.pos = p + 1;
      this.type = Tok.Close;
      this.value = '}';
      return;
    }
    if (c === '"') {
      // Quoted string: no escape sequences (paths use backslashes). A missing closing quote ends at the line end.
      let q = p + 1;
      while (q < n && s[q] !== '"' && s[q] !== '\n') q++;
      this.value = s.slice(p + 1, q).replace(/\r$/, '');
      this.pos = q < n && s[q] === '"' ? q + 1 : q;
      this.type = Tok.Str;
      this.quoted = true;
      return;
    }
    if (c === '[' && p + 1 < n && (s[p + 1] === '$' || s[p + 1] === '!')) {
      let q = p + 1;
      while (q < n && s[q] !== ']' && s[q] !== '\n') q++;
      this.value = s.slice(p, q < n && s[q] === ']' ? q + 1 : q);
      this.pos = q < n && s[q] === ']' ? q + 1 : q;
      this.type = Tok.Cond;
      return;
    }
    // Bare token: ends at whitespace, a quote, a brace or a // comment.
    let q = p;
    while (q < n) {
      const ch = s.charCodeAt(q);
      if (ch <= 32 || ch === 34 || ch === 123 || ch === 125) break;
      if (ch === 47 && q + 1 < n && s.charCodeAt(q + 1) === 47) break;
      q++;
    }
    this.value = s.slice(p, q);
    this.pos = q;
    this.type = Tok.Str;
  }
}

function newKv(): KeyValues {
  return Object.create(null) as KeyValues;
}

function isBlock(v: string | KeyValues | undefined): v is KeyValues {
  return typeof v === 'object' && v !== null;
}

/** Deep-merges `src` into `dst` (scalars overwrite, blocks merge recursively). */
export function mergeKeyValues(dst: KeyValues, src: KeyValues): KeyValues {
  for (const k of Object.keys(src)) {
    const v = src[k];
    const cur = dst[k];
    if (isBlock(v)) {
      if (isBlock(cur)) mergeKeyValues(cur, v);
      else dst[k] = mergeKeyValues(newKv(), v);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

function cloneKv(src: KeyValues): KeyValues {
  return mergeKeyValues(newKv(), src);
}

const MAX_DEPTH = 64;

function parseBlock(t: Tokenizer, out: KeyValues, depth: number, topLevel: boolean): void {
  for (;;) {
    const tt = t.next();
    if (tt === Tok.Eof) return;
    if (tt === Tok.Close) {
      if (topLevel) continue; // stray '}' at the root: ignore
      return;
    }
    if (tt === Tok.Cond) continue; // stray conditional
    if (tt === Tok.Open) {
      // Anonymous block: merge its contents into the current one (lenient).
      if (depth < MAX_DEPTH) parseBlock(t, out, depth + 1, false);
      else skipBlock(t);
      continue;
    }
    const key = t.value.toLowerCase();
    if (!t.quoted && (key === '#include' || key === '#base')) {
      if (t.peek() === Tok.Str) t.next();
      continue;
    }

    let accepted = true;
    let vt = t.next();
    if (vt === Tok.Cond) {
      accepted = evaluateConditional(t.value);
      vt = t.next();
    }
    if (vt === Tok.Open) {
      const child = newKv();
      if (depth < MAX_DEPTH) parseBlock(t, child, depth + 1, false);
      else skipBlock(t);
      if (t.peek() === Tok.Cond) {
        t.next();
        accepted = accepted && evaluateConditional(t.value);
      }
      if (!accepted) continue;
      const cur = out[key];
      if (isBlock(cur)) mergeKeyValues(cur, child);
      else out[key] = child;
      continue;
    }
    if (vt === Tok.Str) {
      const value = t.value;
      if (t.peek() === Tok.Cond) {
        t.next();
        accepted = accepted && evaluateConditional(t.value);
      }
      if (accepted) out[key] = value;
      continue;
    }
    // Key without a value at the end of a block / file.
    if (accepted && !(key in out)) out[key] = '';
    if (vt === Tok.Close && !topLevel) return;
    if (vt === Tok.Eof) return;
  }
}

function skipBlock(t: Tokenizer): void {
  let depth = 1;
  while (depth > 0) {
    const tt = t.next();
    if (tt === Tok.Eof) return;
    if (tt === Tok.Open) depth++;
    else if (tt === Tok.Close) depth--;
  }
}

/** Parses KeyValues text. Never throws; malformed input yields whatever could be read. */
export function parseKeyValues(text: string): KeyValues {
  const root = newKv();
  try {
    parseBlock(new Tokenizer(text ?? ''), root, 0, true);
  } catch {
    // tokenizer is total; this is only a safety net
  }
  return root;
}

// ------------------------------------------------------------------ VMT

/** Simulated hardware for shader fallback blocks: DX9 SM3 (dxlevel 95), high GPU level, sRGB, HDR. */
const DX_LEVEL = 95;
const GPU_LEVEL = 3;

/** Evaluates DX-level block names like ">=dx90", "<dx90_20b", "dx9". Returns null if `name` isn't one. */
function dxLevelCondition(name: string): boolean | null {
  const m = /^(<=|>=|<|>|==|=)?\s*dx(\d+)(?:_20b)?$/.exec(name);
  if (!m) return null;
  let lvl = parseInt(m[2], 10);
  if (lvl < 10) lvl *= 10;
  switch (m[1]) {
    case '<':
      return DX_LEVEL < lvl;
    case '<=':
      return DX_LEVEL <= lvl;
    case '>':
      return DX_LEVEL > lvl;
    case '>=':
      return DX_LEVEL >= lvl;
    default:
      return Math.floor(DX_LEVEL / 10) === Math.floor(lvl / 10);
  }
}

/** Evaluates CS:GO-style "condition?" parameter prefixes ("srgb?", "gpu>=2?", "!srgb?", "lowqualitycsm?"). */
function paramCondition(cond: string): boolean {
  let c = cond.trim().toLowerCase();
  let neg = false;
  while (c.startsWith('!')) {
    neg = !neg;
    c = c.slice(1);
  }
  let v: boolean;
  const g = /^gpu\s*(<=|>=|<|>|==|=)\s*(\d+)$/.exec(c);
  if (g) {
    const n = parseInt(g[2], 10);
    v = g[1] === '<' ? GPU_LEVEL < n : g[1] === '<=' ? GPU_LEVEL <= n : g[1] === '>' ? GPU_LEVEL > n : g[1] === '>=' ? GPU_LEVEL >= n : GPU_LEVEL === n;
  } else if (c === 'srgb' || c === 'hdr' || c === 'srgb_pc') {
    v = true;
  } else {
    v = false; // ldr, lowqualitycsm, console-only flags, unknown conditions
  }
  return neg ? !v : v;
}

function firstBlockKey(kv: KeyValues): string | null {
  for (const k of Object.keys(kv)) if (isBlock(kv[k])) return k;
  return null;
}

function includeCandidates(inc: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  const p = inc.trim().replace(/\\/g, '/');
  add(p);
  let q = p.replace(/^\/+/, '');
  if (!/\.vmt$/i.test(q)) q += '.vmt';
  add(q);
  if (!/^materials\//i.test(q)) add(`materials/${q}`);
  return out;
}

interface Resolved {
  shader: string;
  body: KeyValues;
  includeMissing?: string;
  includes: string[];
}

function resolveVmt(text: string, readFile: ((path: string) => string | null) | undefined, depth: number): Resolved {
  const kv = parseKeyValues(text);
  const rootKey = firstBlockKey(kv);
  if (!rootKey) return { shader: '', body: newKv(), includes: [] };
  const shader = rootKey;
  const body = kv[rootKey] as KeyValues;
  if (shader !== 'patch') return { shader, body, includes: [] };

  const inc = typeof body.include === 'string' ? body.include : '';
  const insert = isBlock(body.insert) ? body.insert : null;
  const replace = isBlock(body.replace) ? body.replace : null;
  let incText: string | null = null;
  if (inc && readFile && depth < 8) {
    for (const c of includeCandidates(inc)) {
      try {
        incText = readFile(c);
      } catch {
        incText = null;
      }
      if (incText != null) break;
    }
  }
  if (incText == null) {
    const merged = newKv();
    if (insert) mergeKeyValues(merged, insert);
    if (replace) mergeKeyValues(merged, replace);
    return { shader: 'patch', body: merged, includeMissing: inc || undefined, includes: inc ? [inc] : [] };
  }
  const base = resolveVmt(incText, readFile, depth + 1);
  const merged = cloneKv(base.body);
  // "insert" adds parameters; "replace" overrides them. Both are applied as deep merges so a patch never
  // loses information even when its intent (add vs. override) doesn't match the base material.
  if (insert) mergeKeyValues(merged, insert);
  if (replace) mergeKeyValues(merged, replace);
  return { shader: base.shader, body: merged, includeMissing: base.includeMissing, includes: [inc, ...base.includes] };
}

/**
 * Parses a VMT and resolves "patch" includes through `readFile` (called with the include path as written, then
 * with normalized variants such as "materials/<path>.vmt"). Never throws.
 */
export function parseVmt(text: string, readFile?: (path: string) => string | null): VmtInfo {
  let r: Resolved;
  try {
    r = resolveVmt(text ?? '', readFile, 0);
  } catch {
    r = { shader: '', body: newKv(), includes: [] };
  }
  const shader = r.shader;
  const params: Record<string, string> = Object.create(null);
  let proxies: KeyValues | null = null;

  const applyScalars = (blk: KeyValues) => {
    for (const k of Object.keys(blk)) {
      const v = blk[k];
      if (isBlock(v)) {
        if (k === 'proxies') proxies = proxies ? mergeKeyValues(proxies, v) : cloneKv(v);
        continue;
      }
      const q = k.lastIndexOf('?');
      if (q > 0) {
        if (paramCondition(k.slice(0, q))) params[k.slice(q + 1)] = v;
        continue;
      }
      params[k] = v;
    }
  };

  applyScalars(r.body);
  // DX-level conditional blocks (">=dx90", "<dx90", ...) in file order.
  for (const k of Object.keys(r.body)) {
    const v = r.body[k];
    if (!isBlock(v)) continue;
    if (dxLevelCondition(k) === true) applyScalars(v);
  }
  // Shader fallback blocks for a DX9 PC with HDR enabled.
  if (shader && shader !== 'patch') {
    for (const suffix of ['_dx9', '_dx90', '_hdr_dx9']) {
      const blk = r.body[shader + suffix];
      if (isBlock(blk)) applyScalars(blk);
    }
  }
  const info: VmtInfo = { shader, params, proxies, body: r.body };
  if (r.includeMissing) info.includeMissing = r.includeMissing;
  if (r.includes.length) info.includes = r.includes;
  return info;
}

// ------------------------------------------------------------------ value helpers

/** Parses a VMT boolean/int ("1", "0", "true", ".5"). */
export function vmtBool(v: string | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'yes') return true;
  const n = parseFloat(s);
  return Number.isFinite(n) && n !== 0;
}

/** Parses a VMT number; returns `def` when missing or invalid. */
export function vmtNumber(v: string | undefined, def: number): number {
  if (v == null) return def;
  const n = parseFloat(v.trim().replace(/^\[\s*/, ''));
  return Number.isFinite(n) ? n : def;
}

/**
 * Parses a VMT colour/vector: "[r g b]" (floats, used as-is) or "{r g b}" (0–255 integers, divided by 255).
 * A single number expands to all components. Returns null when unparsable.
 */
export function vmtVector(v: string | undefined, size = 3): number[] | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s) return null;
  let scale = 1;
  let body = s;
  if (s.startsWith('{')) {
    scale = 1 / 255;
    body = s.slice(1, s.endsWith('}') ? -1 : undefined);
  } else if (s.startsWith('[')) {
    body = s.slice(1, s.endsWith(']') ? -1 : undefined);
  }
  const parts = body
    .trim()
    .split(/[\s,]+/)
    .filter((x) => x.length)
    .map((x) => parseFloat(x));
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
  if (parts.length === 1) return new Array(size).fill(parts[0] * scale);
  const out: number[] = [];
  for (let i = 0; i < size; i++) out.push((parts[i] ?? parts[parts.length - 1]) * scale);
  return out;
}

/**
 * Parses a texture transform string "center cx cy scale sx sy rotate deg translate tx ty" into a 2x3 matrix
 * [a, b, c, d, e, f] with u' = a*u + b*v + c, v' = d*u + e*v + f (Source's order: translate(-center), scale,
 * rotate, translate(center), translate). Returns null when nothing parsable is present.
 */
export function parseTextureTransform(v: string | undefined): [number, number, number, number, number, number] | null {
  if (v == null) return null;
  const toks = v.trim().toLowerCase().split(/\s+/);
  let cx = 0.5;
  let cy = 0.5;
  let sx = 1;
  let sy = 1;
  let rot = 0;
  let tx = 0;
  let ty = 0;
  let any = false;
  const num = (i: number, def: number) => {
    const n = parseFloat(toks[i]);
    return Number.isFinite(n) ? n : def;
  };
  for (let i = 0; i < toks.length; i++) {
    switch (toks[i]) {
      case 'center':
        cx = num(i + 1, cx);
        cy = num(i + 2, cy);
        i += 2;
        any = true;
        break;
      case 'scale':
        sx = num(i + 1, sx);
        sy = num(i + 2, sy);
        i += 2;
        any = true;
        break;
      case 'rotate':
        rot = num(i + 1, rot);
        i += 1;
        any = true;
        break;
      case 'translate':
        tx = num(i + 1, tx);
        ty = num(i + 2, ty);
        i += 2;
        any = true;
        break;
      default:
        break;
    }
  }
  if (!any) return null;
  const r = (rot * Math.PI) / 180;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  // M = T(t) * T(c) * R * S * T(-c)
  const a = cs * sx;
  const b = -sn * sy;
  const d = sn * sx;
  const e = cs * sy;
  const c = -(a * cx + b * cy) + cx + tx;
  const f = -(d * cx + e * cy) + cy + ty;
  return [a, b, c, d, e, f];
}
