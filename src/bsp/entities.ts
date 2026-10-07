// Entity lump parser: { "key" "value" ... } blocks -> MapEntity objects.
//
// Tokenizer rules (matching how the engine reads the lump): whitespace separates tokens; '{' and '}' are
// single-character tokens outside quotes; a quoted token runs to the next '"' (it may contain newlines and
// braces); unquoted tokens run to whitespace, '{', '}' or '"'; "//" outside quotes starts a comment.
// A malformed entity (missing value, unexpected '{') is closed at that point and parsing resumes at the
// next '{' so one broken entity can't swallow the rest of the map.
//
// Entity I/O: a keyvalue is an output connection when its key names an output (starts with "On", or is one
// of the few classic outputs without the prefix) and its value has the shape
// "target,input,param,delay,times" (comma separated) or the CS:GO form with ESC (0x1B) separators.
import { QAngle, qa } from '../core/angles';
import { Vec3, v3 } from '../core/vec3';
import { EntityOutput, MapEntity } from '../map/types';

/** Outputs whose names don't start with "On" (game_ui, math_counter, sensors...). Lower-case. */
const NON_ON_OUTPUTS = new Set([
  'outvalue',
  'outcolor',
  'outremainder',
  'pressedmoveleft',
  'pressedmoveright',
  'pressedforward',
  'pressedback',
  'pressedattack',
  'pressedattack2',
  'unpressedmoveleft',
  'unpressedmoveright',
  'unpressedforward',
  'unpressedback',
  'unpressedattack',
  'unpressedattack2',
  'xaxis',
  'yaxis',
  'attackaxis',
  'attack2axis',
  'playeron',
  'playeroff',
  'velocity',
  'angularvelocity',
  'position',
  'impacted',
  'gotcarryingplayer',
]);

const ESC = '\x1b';

type Token = { text: string; quoted: boolean } | null;

class Tokenizer {
  pos = 0;
  constructor(private readonly s: string) {}

  next(): Token {
    const s = this.s;
    const n = s.length;
    for (;;) {
      // skip whitespace / control characters (includes stray NULs)
      while (this.pos < n && s.charCodeAt(this.pos) <= 32) this.pos++;
      if (this.pos >= n) return null;
      // comments
      if (s.charCodeAt(this.pos) === 47 /* / */ && s.charCodeAt(this.pos + 1) === 47) {
        while (this.pos < n && s.charCodeAt(this.pos) !== 10) this.pos++;
        continue;
      }
      break;
    }
    const c = s.charCodeAt(this.pos);
    if (c === 123 /* { */ || c === 125 /* } */) {
      this.pos++;
      return { text: c === 123 ? '{' : '}', quoted: false };
    }
    if (c === 34 /* " */) {
      const start = this.pos + 1;
      let end = s.indexOf('"', start);
      if (end < 0) end = n;
      this.pos = Math.min(n, end + 1);
      return { text: s.slice(start, end), quoted: true };
    }
    const start = this.pos;
    while (this.pos < n) {
      const ch = s.charCodeAt(this.pos);
      if (ch <= 32 || ch === 123 || ch === 125 || ch === 34) break;
      this.pos++;
    }
    return { text: s.slice(start, this.pos), quoted: false };
  }
}

const isOpen = (t: Token): boolean => !!t && !t.quoted && t.text === '{';
const isClose = (t: Token): boolean => !!t && !t.quoted && t.text === '}';

/**
 * Parses an output keyvalue. Returns null when `value` doesn't look like a connection.
 * Comma form: target,input,param,delay,times (fields beyond the 5th are ignored like the engine does).
 */
export function parseOutputValue(event: string, value: string): EntityOutput | null {
  let parts: string[];
  if (value.includes(ESC)) parts = value.split(ESC);
  else {
    parts = value.split(',');
    if (parts.length < 4) return null; // need at least target,input,param,delay
  }
  if (parts.length < 2) return null;
  const delay = parseFloat(parts[3] ?? '');
  const times = parseInt(parts[4] ?? '', 10);
  return {
    event: event.toLowerCase(),
    target: (parts[0] ?? '').trim(),
    input: (parts[1] ?? '').trim(),
    param: parts[2] ?? '',
    delay: Number.isFinite(delay) ? delay : 0,
    // 0 / missing / garbage = unlimited, like the engine (Hammer writes -1 for "unlimited").
    timesToFire: Number.isFinite(times) && times !== 0 ? times : -1,
  };
}

function isOutputKey(lowerKey: string, value: string): boolean {
  if (value.includes(ESC)) return true;
  if (lowerKey.startsWith('on') || NON_ON_OUTPUTS.has(lowerKey)) {
    let commas = 0;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 44) commas++;
    return commas >= 3;
  }
  return false;
}

function parseVec(s: string | undefined): Vec3 {
  if (!s) return v3();
  const p = s.trim().split(/[\s,]+/);
  const x = parseFloat(p[0]);
  const y = parseFloat(p[1]);
  const z = parseFloat(p[2]);
  return v3(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0);
}

/**
 * Entity orientation:
 * - "angles" "pitch yaw roll" when present;
 * - otherwise "angle" is a yaw, with the Quake-era specials -1 = straight up (pitch -90) and -2 = straight
 *   down (pitch 90);
 * - lights (light, light_spot, light_environment, light_dynamic...) override the pitch with their "pitch" key.
 */
function entityAngles(classname: string, kv: Record<string, string>): QAngle {
  let a: QAngle;
  if (kv.angles !== undefined) {
    const v = parseVec(kv.angles);
    a = qa(v.x, v.y, v.z);
  } else if (kv.angle !== undefined) {
    const yaw = parseFloat(kv.angle) || 0;
    if (yaw === -1) a = qa(-90, 0, 0);
    else if (yaw === -2) a = qa(90, 0, 0);
    else a = qa(0, yaw, 0);
  } else a = qa();
  if (classname.startsWith('light') && kv.pitch !== undefined) {
    const p = parseFloat(kv.pitch);
    if (Number.isFinite(p)) a.pitch = p;
  }
  return a;
}

function makeEntity(index: number, kv: Record<string, string>, outputs: EntityOutput[]): MapEntity {
  const classname = kv.classname ?? '';
  let model = -1;
  const m = kv.model;
  if (m && m.charCodeAt(0) === 42 /* * */) {
    const n = parseInt(m.slice(1), 10);
    if (Number.isFinite(n) && n >= 0) model = n;
  }
  return {
    index,
    classname,
    targetname: kv.targetname ?? '',
    kv,
    outputs,
    origin: parseVec(kv.origin),
    angles: entityAngles(classname, kv),
    model,
  };
}

/** Parses the entity lump text. Keys are lower-cased; the last occurrence of a key wins. */
export function parseEntities(text: string): MapEntity[] {
  const out: MapEntity[] = [];
  const tk = new Tokenizer(text);
  let tok = tk.next();
  while (tok) {
    if (!isOpen(tok)) {
      // garbage between entities: skip to the next '{'
      tok = tk.next();
      continue;
    }
    const kv: Record<string, string> = {};
    const outputs: EntityOutput[] = [];
    tok = tk.next();
    for (;;) {
      if (!tok || isClose(tok)) {
        tok = tok ? tk.next() : null;
        break;
      }
      if (isOpen(tok)) break; // missing '}': the next entity starts here
      const key = tok.text;
      const valTok = tk.next();
      if (!valTok || isClose(valTok) || isOpen(valTok)) {
        // key without value: drop it and let the brace close/start an entity
        tok = valTok;
        continue;
      }
      const lower = key.toLowerCase();
      const value = valTok.text;
      if (lower === '__proto__') {
        tok = tk.next();
        continue;
      }
      if (isOutputKey(lower, value)) {
        const o = parseOutputValue(lower, value);
        if (o) outputs.push(o);
        else kv[lower] = value;
      } else {
        kv[lower] = value;
      }
      tok = tk.next();
    }
    out.push(makeEntity(out.length, kv, outputs));
  }
  return out;
}

/** Serializes entities back to entity-lump text (used by tools/tests; outputs use the comma form). */
export function serializeEntities(ents: MapEntity[]): string {
  const q = (s: string): string => `"${s.replace(/"/g, "'")}"`;
  let s = '';
  for (const e of ents) {
    s += '{\n';
    for (const k of Object.keys(e.kv)) s += `${q(k)} ${q(e.kv[k])}\n`;
    for (const o of e.outputs) {
      s += `${q(o.event)} ${q(`${o.target},${o.input},${o.param},${o.delay},${o.timesToFire}`)}\n`;
    }
    s += '}\n';
  }
  return s;
}
