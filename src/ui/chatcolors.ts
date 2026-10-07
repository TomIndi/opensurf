// CS:GO chat palette (as used by SourceMod surf plugins) and parsing of {color} tags / raw color bytes.
import type { ChatSegment } from '../game/api';

/** The CS:GO chat colors by SourceMod name. */
export const CHAT_COLORS: Readonly<Record<string, string>> = Object.freeze({
  default: '#FFFFFF',
  white: '#FFFFFF',
  red: '#FF4040',
  lightred: '#FF6E6E',
  darkred: '#B32020',
  green: '#40FF40',
  lightgreen: '#BEFF90',
  lime: '#A2FF47',
  olive: '#BFB250',
  blue: '#99CCFF',
  lightblue: '#5E98D9',
  darkblue: '#4B69FF',
  purple: '#B47BFF',
  orchid: '#E64AE6',
  yellow: '#ECE37A',
  gold: '#E4AE39',
  orange: '#F08149',
  grey: '#B0C3D9',
  gray: '#B0C3D9',
  grey2: '#C6D3E0',
  gray2: '#C6D3E0',
  bluegrey: '#C6D3E0',
  team: '#99CCFF',
  teamcolor: '#99CCFF',
});

/**
 * CS:GO raw chat color control bytes (\x01..\x10) -> palette names. \t, \n and \r (0x09, 0x0A, 0x0D) are
 * also color bytes in CS:GO, but in TS-generated text they are far more likely to be whitespace, so they are
 * treated as spaces instead (use {yellow} / {grey2} tags).
 */
const CONTROL_COLORS: Record<number, string> = {
  0x01: 'default',
  0x02: 'darkred',
  0x03: 'team',
  0x04: 'green',
  0x05: 'lightgreen',
  0x06: 'lime',
  0x07: 'red',
  0x08: 'grey',
  0x0b: 'blue',
  0x0c: 'darkblue',
  0x0e: 'orchid',
  0x0f: 'lightred',
  0x10: 'gold',
};

const CSS_COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;

/** Resolves a ChatColor (palette name or CSS color) to a CSS color. Unknown -> default white. */
export function resolveChatColor(color: string | undefined | null): string {
  if (!color) return CHAT_COLORS.default;
  const k = color.toLowerCase();
  const named = CHAT_COLORS[k];
  if (named) return named;
  if (CSS_COLOR_RE.test(color.trim())) return color.trim();
  // bare hex without '#'
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color}`;
  return CHAT_COLORS.default;
}

/**
 * Splits text containing SourceMod {color} tags and/or CS:GO control bytes into colored segments.
 * Unknown {tags} are kept literally. Empty segments are dropped.
 */
export function parseChatTags(text: string, baseColor = 'default'): ChatSegment[] {
  const out: ChatSegment[] = [];
  let color = baseColor;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, color });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      buf += ' ';
      continue;
    }
    if (ch >= 0x01 && ch <= 0x10 && CONTROL_COLORS[ch]) {
      flush();
      color = CONTROL_COLORS[ch];
      continue;
    }
    if (text[i] === '{') {
      const end = text.indexOf('}', i + 1);
      if (end > i + 1 && end - i <= 16) {
        const name = text.slice(i + 1, end).toLowerCase();
        if (CHAT_COLORS[name]) {
          flush();
          color = name;
          i = end;
          continue;
        }
      }
    }
    buf += text[i];
  }
  flush();
  return out;
}

/** Normalizes game-provided segments: expands inline tags, drops empties, strips other control chars. */
export function normalizeSegments(segments: ChatSegment[]): ChatSegment[] {
  const out: ChatSegment[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg.text !== 'string' || !seg.text) continue;
    const base = seg.color ?? 'default';
    // eslint-disable-next-line no-control-regex
    const hasTags = /[\x01-\x10]|\{[a-z0-9]+\}/i.test(seg.text);
    const parts = hasTags ? parseChatTags(seg.text, base) : [{ text: seg.text, color: base }];
    for (const p of parts) {
      // eslint-disable-next-line no-control-regex
      const t = p.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (t) out.push({ text: t, color: p.color });
    }
  }
  return out;
}

/** Plain text of a chat line (for logging to the console). */
export function segmentsToText(segments: ChatSegment[]): string {
  return segments.map((s) => s.text).join('');
}
