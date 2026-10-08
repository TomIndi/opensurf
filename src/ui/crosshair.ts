// CS:GO crosshair: cvar semantics, pixel geometry, drawing and "paste your config" parsing.
//
// Geometry (classic styles), in physical screen pixels, all integers:
//   bar length  = round(cl_crosshairsize      * screenHeight / 480)        (YRES-scaled)
//   thickness   = max(1, round(cl_crosshairthickness * screenHeight / 480))
//   distance    = round(4 + cl_crosshairgap)    — the gap is NOT resolution scaled (CS:GO quirk:
//                 the same gap looks tighter on higher resolutions); "gap -5" closes the cross.
//   Horizontal bars span y ∈ [cy - ⌊t/2⌋, cy - ⌊t/2⌋ + t); the inner ends sit at
//   innerLeft = cx - dist - ⌊t/2⌋ and innerRight = innerLeft + 2·dist + t, bars extend `length`
//   outward. Vertical bars mirror that. The dot is the t×t square at the centre.
//   Each rect is drawn as: black outline rect grown by cl_crosshair_outlinethickness, then the fill.
//   cl_crosshairusealpha 0 draws additively with alpha 200 (outline therefore invisible).
import { decodeCrosshairShareCode, SHARE_CODE_RE, shareDataToCommands } from './crosshaircode';

export interface CrosshairParams {
  enabled: boolean;
  /** 0 default, 1 default static, 2 classic, 3 classic dynamic, 4 classic static, 5 legacy. */
  style: number;
  size: number;
  thickness: number;
  gap: number;
  dot: boolean;
  outline: boolean;
  outlineThickness: number;
  /** 0 red, 1 green, 2 yellow, 3 blue, 4 cyan, 5 custom. */
  color: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  useAlpha: boolean;
  /** cl_crosshair_t: no top bar. */
  tStyle: boolean;
}

export const CROSSHAIR_DEFAULTS: CrosshairParams = {
  enabled: true,
  style: 4,
  size: 5,
  thickness: 0.5,
  gap: 1,
  dot: false,
  outline: true,
  outlineThickness: 1,
  color: 1,
  r: 50,
  g: 250,
  b: 50,
  alpha: 200,
  useAlpha: true,
  tStyle: false,
};

/** CS:GO cl_crosshaircolor presets 0..4 (5 = custom r/g/b). */
export const CROSSHAIR_PRESET_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [250, 50, 50],
  [50, 250, 50],
  [250, 250, 50],
  [50, 50, 250],
  [50, 250, 250],
];

export const CROSSHAIR_STYLE_NAMES = ['Default', 'Default Static', 'Classic', 'Classic Dynamic', 'Classic Static', 'Legacy'];

/** Every crosshair cvar the UI reads, with CS:GO defaults (string form). */
export const CROSSHAIR_CVARS: Readonly<Record<string, string>> = {
  crosshair: '1',
  cl_crosshairstyle: '4',
  cl_crosshairsize: '5',
  cl_crosshairthickness: '0.5',
  cl_crosshairgap: '1',
  cl_crosshairdot: '0',
  cl_crosshair_drawoutline: '1',
  cl_crosshair_outlinethickness: '1',
  cl_crosshaircolor: '1',
  cl_crosshaircolor_r: '50',
  cl_crosshaircolor_g: '250',
  cl_crosshaircolor_b: '50',
  cl_crosshairalpha: '200',
  cl_crosshairusealpha: '1',
};

function num(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

/** Reads the crosshair params from a cvar getter (returns the string value or undefined). */
export function readCrosshairParams(get: (name: string) => string | undefined): CrosshairParams {
  const d = CROSSHAIR_DEFAULTS;
  return {
    enabled: num(get('crosshair'), 1) !== 0,
    style: Math.trunc(num(get('cl_crosshairstyle'), d.style)),
    size: num(get('cl_crosshairsize'), d.size),
    thickness: num(get('cl_crosshairthickness'), d.thickness),
    gap: num(get('cl_crosshairgap'), d.gap),
    dot: num(get('cl_crosshairdot'), 0) !== 0,
    outline: num(get('cl_crosshair_drawoutline'), 1) !== 0,
    outlineThickness: num(get('cl_crosshair_outlinethickness'), d.outlineThickness),
    color: Math.trunc(num(get('cl_crosshaircolor'), d.color)),
    r: num(get('cl_crosshaircolor_r'), d.r),
    g: num(get('cl_crosshaircolor_g'), d.g),
    b: num(get('cl_crosshaircolor_b'), d.b),
    alpha: num(get('cl_crosshairalpha'), d.alpha),
    useAlpha: num(get('cl_crosshairusealpha'), 1) !== 0,
    tStyle: num(get('cl_crosshair_t'), 0) !== 0,
  };
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export function crosshairRgb(p: CrosshairParams): [number, number, number] {
  const preset = CROSSHAIR_PRESET_COLORS[p.color];
  if (preset && p.color >= 0 && p.color <= 4) return [preset[0], preset[1], preset[2]];
  return [clamp255(p.r), clamp255(p.g), clamp255(p.b)];
}

export interface CrossRect {
  /** Half-open integer pixel rect [x0, x1) × [y0, y1), relative to the screen's top-left. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: 'left' | 'right' | 'top' | 'bottom' | 'dot';
}

export interface CrosshairGeometry {
  cx: number;
  cy: number;
  rects: CrossRect[];
  barLength: number;
  thickness: number;
  distance: number;
  outline: number;
  rgb: [number, number, number];
  /** 0..1 */
  alpha: number;
  additive: boolean;
  /** Bounding box of everything drawn (including outlines). */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** Source's RoundFloatToInt: round half away from zero is close enough (SSE uses half-even). */
function roundInt(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/**
 * Computes the crosshair rectangles for a screen of `screenW`×`screenH` physical pixels.
 * Styles 0/1 (Default) ignore size/thickness/gap like CS:GO and use the stock look.
 */
export function crosshairGeometry(p: CrosshairParams, screenW: number, screenH: number): CrosshairGeometry {
  const cx = Math.floor(screenW / 2);
  const cy = Math.floor(screenH / 2);
  const isDefaultStyle = p.style === 0 || p.style === 1;
  const size = isDefaultStyle ? 5 : p.size;
  const thick = isDefaultStyle ? 0.5 : p.thickness;
  const gap = isDefaultStyle ? 1 : p.gap;
  const yres = screenH / 480;
  const barLength = Math.max(0, roundInt(size * yres));
  const thickness = Math.max(1, roundInt(thick * yres));
  const distance = roundInt(4 + gap);
  const half = Math.floor(thickness / 2);
  const rects: CrossRect[] = [];

  if (barLength > 0) {
    const innerLeft = cx - distance - half;
    const innerRight = innerLeft + 2 * distance + thickness;
    const y0 = cy - half;
    rects.push({ x0: innerLeft - barLength, y0, x1: innerLeft, y1: y0 + thickness, kind: 'left' });
    rects.push({ x0: innerRight, y0, x1: innerRight + barLength, y1: y0 + thickness, kind: 'right' });
    const innerTop = cy - distance - half;
    const innerBottom = innerTop + 2 * distance + thickness;
    const x0 = cx - half;
    if (!p.tStyle) rects.push({ x0, y0: innerTop - barLength, x1: x0 + thickness, y1: innerTop, kind: 'top' });
    rects.push({ x0, y0: innerBottom, x1: x0 + thickness, y1: innerBottom + barLength, kind: 'bottom' });
  }
  if (p.dot && !isDefaultStyle) {
    const x0 = cx - half;
    const y0 = cy - half;
    rects.push({ x0, y0, x1: x0 + thickness, y1: y0 + thickness, kind: 'dot' });
  }

  const additive = !p.useAlpha;
  const alpha = additive ? 200 / 255 : Math.max(0, Math.min(255, p.alpha)) / 255;
  const outline = p.outline && !isDefaultStyle ? Math.max(0, p.outlineThickness) : 0;

  let bounds: CrosshairGeometry['bounds'] = null;
  for (const r of rects) {
    const x0 = r.x0 - outline;
    const y0 = r.y0 - outline;
    const x1 = r.x1 + outline;
    const y1 = r.y1 + outline;
    if (!bounds) bounds = { x0, y0, x1, y1 };
    else {
      bounds.x0 = Math.min(bounds.x0, x0);
      bounds.y0 = Math.min(bounds.y0, y0);
      bounds.x1 = Math.max(bounds.x1, x1);
      bounds.y1 = Math.max(bounds.y1, y1);
    }
  }
  return { cx, cy, rects, barLength, thickness, distance, outline, rgb: crosshairRgb(p), alpha, additive, bounds };
}

/** Minimal 2D context surface used by drawCrosshair (lets tests use a fake). */
export interface CrosshairCtx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/**
 * Draws the crosshair. (ox, oy) is the screen position of the context's (0,0) pixel, so a small canvas
 * centred on the screen can be used. Rects with zero/negative area are skipped.
 */
export function drawCrosshair(ctx: CrosshairCtx, g: CrosshairGeometry, ox = 0, oy = 0): void {
  const [r, gg, b] = g.rgb;
  const fill = `rgb(${r},${gg},${b})`;
  ctx.globalAlpha = g.alpha;
  for (const rc of g.rects) {
    const w = rc.x1 - rc.x0;
    const hgt = rc.y1 - rc.y0;
    if (w <= 0 || hgt <= 0) continue;
    if (g.outline > 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(rc.x0 - g.outline - ox, rc.y0 - g.outline - oy, w + 2 * g.outline, hgt + 2 * g.outline);
    }
    ctx.fillStyle = fill;
    ctx.fillRect(rc.x0 - ox, rc.y0 - oy, w, hgt);
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ config paste / export

const CROSSHAIR_CMD_RE = /^(crosshair|cl_crosshair[a-z0-9_]*|cl_crosshair_[a-z0-9_]+|cl_fixedcrosshairgap)$/i;

export interface ParsedCrosshairConfig {
  /** Normalized `name "value"` console lines to execute. */
  commands: string[];
  /** Commands that were ignored (not crosshair cvars). */
  ignored: string[];
  /** Valid CS:GO share codes that were decoded into `commands`. */
  shareCodes: string[];
  /** Share codes that could not be decoded. */
  shareCodeErrors: { code: string; error: 'format' | 'checksum' }[];
}

/**
 * Extracts crosshair cvar assignments from pasted text: autoexec/config.cfg lines, ';'-separated one-liners,
 * quoted or unquoted values, // comments, and CS:GO crosshair share codes ("CSGO-xxxxx-…", alone or as
 * `apply_crosshair_code CSGO-…`), which expand to the cl_crosshair* cvars they encode. Only `crosshair`,
 * `cl_crosshair*` and `cl_fixedcrosshairgap` names are accepted, values must be numeric. Later assignments of the
 * same cvar win.
 */
export function parseCrosshairConfig(text: string): ParsedCrosshairConfig {
  const ignored: string[] = [];
  const shareCodes: string[] = [];
  const shareCodeErrors: ParsedCrosshairConfig['shareCodeErrors'] = [];
  const byName = new Map<string, string>();
  const set = (name: string, value: string) => {
    byName.delete(name); // keep last occurrence order
    byName.set(name, value);
  };
  const statements = text
    .split(/\r?\n/)
    .map((l) => {
      const c = l.indexOf('//');
      return c >= 0 ? l.slice(0, c) : l;
    })
    .flatMap((l) => l.split(';'));
  for (const raw of statements) {
    const st = raw.trim();
    if (!st) continue;
    const code = SHARE_CODE_RE.exec(st);
    if (code) {
      const r = decodeCrosshairShareCode(code[0]);
      if (!r.ok) {
        shareCodeErrors.push({ code: code[0], error: r.error });
        continue;
      }
      shareCodes.push(code[0]);
      for (const line of shareDataToCommands(r.data)) {
        const m = /^(\S+) "(.*)"$/.exec(line)!;
        set(m[1], m[2]);
      }
      continue;
    }
    const m = /^"?([A-Za-z0-9_]+)"?\s+"?\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*"?$/.exec(st);
    if (!m) {
      ignored.push(st);
      continue;
    }
    const name = m[1].toLowerCase();
    if (!CROSSHAIR_CMD_RE.test(name)) {
      ignored.push(st);
      continue;
    }
    set(name, String(parseFloat(m[2])));
  }
  return { commands: [...byName].map(([n, v]) => `${n} "${v}"`), ignored, shareCodes, shareCodeErrors };
}

/** Exports the current crosshair as a config one-liner (like crosshair generators). */
export function exportCrosshairConfig(get: (name: string) => string | undefined): string {
  const names = Object.keys(CROSSHAIR_CVARS);
  if (get('cl_crosshair_t') !== undefined) names.push('cl_crosshair_t');
  return names
    .map((n) => {
      const v = get(n);
      return v === undefined ? null : `${n} ${v}`;
    })
    .filter(Boolean)
    .join('; ');
}
