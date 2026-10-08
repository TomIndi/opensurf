// CS:GO crosshair share codes ("CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"), written from the publicly documented format.
//
// The 25 characters (after "CSGO-", dashes removed) are the base-57 digits of one big number, least significant
// digit first, over the alphabet below (no 0/1/I/O/l/g, so codes are easy to read aloud). That number is 18 bytes,
// big-endian:
//
//   byte  0      checksum = sum(bytes 1..17) & 0xff
//   byte  1      format version (1)
//   byte  2      cl_crosshairgap × 10 (signed)
//   byte  3      cl_crosshair_outlinethickness × 2
//   bytes 4..6   cl_crosshaircolor_r / _g / _b
//   byte  7      cl_crosshairalpha
//   byte  8      cl_crosshair_dynamic_splitdist (bits 0-6) | cl_crosshair_recoil (bit 7, CS2)
//   byte  9      cl_fixedcrosshairgap × 10 (signed)
//   byte 10      cl_crosshaircolor (bits 0-2) | cl_crosshair_drawoutline (bit 3) | splitalpha_innermod × 10 (bits 4-7)
//   byte 11      splitalpha_outermod × 10 (bits 0-3) | cl_crosshair_dynamic_maxdist_splitratio × 10 (bits 4-7)
//   byte 12      cl_crosshairthickness × 10
//   byte 13      cl_crosshairstyle (bits 1-3) | cl_crosshairdot (bit 4) | cl_crosshairgap_useweaponvalue (bit 5)
//                | cl_crosshairusealpha (bit 6) | cl_crosshair_t (bit 7)          (bit 0 unused)
//   bytes 14,15  cl_crosshairsize × 10: low 8 bits in byte 14, high 5 bits in byte 15 (older codes: byte 15 = 0)
//   bytes 16,17  0
//
// Checked against a published example code whose checksum and values decode cleanly (tests/ui_crosshair.test.ts).

const ALPHABET = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
const BASE = 57n;
const DIGITS = 25;
const BYTES = 18;

/** A share code anywhere in a text (also matches inside "apply_crosshair_code CSGO-…"). */
export const SHARE_CODE_RE = /CSGO(?:-[A-Za-z0-9]{5}){5}/;

export interface CrosshairShareData {
  /** cl_crosshairgap */
  gap: number;
  /** cl_crosshair_outlinethickness */
  outlineThickness: number;
  red: number;
  green: number;
  blue: number;
  /** cl_crosshairalpha */
  alpha: number;
  /** cl_crosshair_dynamic_splitdist */
  splitDistance: number;
  /** cl_crosshair_recoil (CS2) */
  followRecoil: boolean;
  /** cl_fixedcrosshairgap */
  fixedGap: number;
  /** cl_crosshaircolor (0 red .. 4 cyan, 5 custom) */
  color: number;
  /** cl_crosshair_drawoutline */
  outline: boolean;
  /** cl_crosshair_dynamic_splitalpha_innermod */
  innerSplitAlpha: number;
  /** cl_crosshair_dynamic_splitalpha_outermod */
  outerSplitAlpha: number;
  /** cl_crosshair_dynamic_maxdist_splitratio */
  splitSizeRatio: number;
  /** cl_crosshairthickness */
  thickness: number;
  /** cl_crosshairstyle */
  style: number;
  /** cl_crosshairdot */
  dot: boolean;
  /** cl_crosshairgap_useweaponvalue */
  useWeaponGap: boolean;
  /** cl_crosshairusealpha */
  useAlpha: boolean;
  /** cl_crosshair_t */
  tStyle: boolean;
  /** cl_crosshairsize */
  size: number;
}

/** Which cvar each field sets (booleans as 0/1). */
export const SHARE_CODE_CVARS: Readonly<Record<keyof CrosshairShareData, string>> = {
  gap: 'cl_crosshairgap',
  outlineThickness: 'cl_crosshair_outlinethickness',
  red: 'cl_crosshaircolor_r',
  green: 'cl_crosshaircolor_g',
  blue: 'cl_crosshaircolor_b',
  alpha: 'cl_crosshairalpha',
  splitDistance: 'cl_crosshair_dynamic_splitdist',
  followRecoil: 'cl_crosshair_recoil',
  fixedGap: 'cl_fixedcrosshairgap',
  color: 'cl_crosshaircolor',
  outline: 'cl_crosshair_drawoutline',
  innerSplitAlpha: 'cl_crosshair_dynamic_splitalpha_innermod',
  outerSplitAlpha: 'cl_crosshair_dynamic_splitalpha_outermod',
  splitSizeRatio: 'cl_crosshair_dynamic_maxdist_splitratio',
  thickness: 'cl_crosshairthickness',
  style: 'cl_crosshairstyle',
  dot: 'cl_crosshairdot',
  useWeaponGap: 'cl_crosshairgap_useweaponvalue',
  useAlpha: 'cl_crosshairusealpha',
  tStyle: 'cl_crosshair_t',
  size: 'cl_crosshairsize',
};

/** CS:GO's defaults for the fields (used for cvars that don't exist here when exporting). */
export const SHARE_CODE_DEFAULTS: Readonly<CrosshairShareData> = {
  gap: 1,
  outlineThickness: 1,
  red: 50,
  green: 250,
  blue: 50,
  alpha: 200,
  splitDistance: 7,
  followRecoil: false,
  fixedGap: 3,
  color: 1,
  outline: true,
  innerSplitAlpha: 1,
  outerSplitAlpha: 0.5,
  splitSizeRatio: 0.3,
  thickness: 0.5,
  style: 4,
  dot: false,
  useWeaponGap: false,
  useAlpha: true,
  tStyle: false,
  size: 5,
};

export type ShareCodeResult = { ok: true; data: CrosshairShareData; bytes: Uint8Array } | { ok: false; error: 'format' | 'checksum' };

/** Raw 18 bytes of a share code (no checksum check), or null if it isn't a well-formed code. */
export function shareCodeBytes(code: string): Uint8Array | null {
  const m = /^\s*CSGO((?:-[A-Za-z0-9]{5}){5})\s*$/.exec(code);
  if (!m) return null;
  const chars = m[1].replace(/-/g, '');
  let n = 0n;
  for (let i = chars.length - 1; i >= 0; i--) {
    const d = ALPHABET.indexOf(chars[i]);
    if (d < 0) return null;
    n = n * BASE + BigInt(d);
  }
  const out = new Uint8Array(BYTES);
  for (let i = BYTES - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return n === 0n ? out : null;
}

/** Share code text for 18 raw bytes (byte 0 must already hold the checksum). */
export function bytesToShareCode(bytes: ArrayLike<number>): string {
  let n = 0n;
  for (let i = 0; i < BYTES; i++) n = (n << 8n) | BigInt((bytes[i] ?? 0) & 0xff);
  let s = '';
  for (let i = 0; i < DIGITS; i++) {
    s += ALPHABET[Number(n % BASE)];
    n /= BASE;
  }
  return `CSGO-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}-${s.slice(20, 25)}`;
}

export function shareCodeChecksum(bytes: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 1; i < BYTES; i++) sum += bytes[i] ?? 0;
  return sum & 0xff;
}

const int8 = (b: number) => (b > 127 ? b - 256 : b);
/** n / div without float noise (0.30000000000000004). */
const tenth = (n: number, div = 10) => Math.round((n / div) * 1000) / 1000;

export function decodeCrosshairShareCode(code: string): ShareCodeResult {
  const b = shareCodeBytes(code);
  if (!b) return { ok: false, error: 'format' };
  if (b[0] !== shareCodeChecksum(b)) return { ok: false, error: 'checksum' };
  const data: CrosshairShareData = {
    gap: tenth(int8(b[2])),
    outlineThickness: tenth(b[3], 2),
    red: b[4],
    green: b[5],
    blue: b[6],
    alpha: b[7],
    splitDistance: b[8] & 0x7f,
    followRecoil: (b[8] & 0x80) !== 0,
    fixedGap: tenth(int8(b[9])),
    color: b[10] & 7,
    outline: (b[10] & 8) !== 0,
    innerSplitAlpha: tenth(b[10] >> 4),
    outerSplitAlpha: tenth(b[11] & 0xf),
    splitSizeRatio: tenth(b[11] >> 4),
    thickness: tenth(b[12]),
    style: (b[13] & 0xf) >> 1,
    dot: (b[13] & 0x10) !== 0,
    useWeaponGap: (b[13] & 0x20) !== 0,
    useAlpha: (b[13] & 0x40) !== 0,
    tStyle: (b[13] & 0x80) !== 0,
    size: tenth(b[14] | ((b[15] & 0x1f) << 8)),
  };
  return { ok: true, data, bytes: b };
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : 0)));

export function encodeCrosshairShareCode(d: CrosshairShareData): string {
  const b = new Uint8Array(BYTES);
  const s8 = (v: number) => clampInt(v * 10, -128, 127) & 0xff;
  const size = clampInt(d.size * 10, 0, 0x1fff);
  b[1] = 1;
  b[2] = s8(d.gap);
  b[3] = clampInt(d.outlineThickness * 2, 0, 255);
  b[4] = clampInt(d.red, 0, 255);
  b[5] = clampInt(d.green, 0, 255);
  b[6] = clampInt(d.blue, 0, 255);
  b[7] = clampInt(d.alpha, 0, 255);
  b[8] = clampInt(d.splitDistance, 0, 127) | (d.followRecoil ? 0x80 : 0);
  b[9] = s8(d.fixedGap);
  b[10] = clampInt(d.color, 0, 7) | (d.outline ? 8 : 0) | (clampInt(d.innerSplitAlpha * 10, 0, 15) << 4);
  b[11] = clampInt(d.outerSplitAlpha * 10, 0, 15) | (clampInt(d.splitSizeRatio * 10, 0, 15) << 4);
  b[12] = clampInt(d.thickness * 10, 0, 255);
  b[13] = (clampInt(d.style, 0, 7) << 1) | (d.dot ? 0x10 : 0) | (d.useWeaponGap ? 0x20 : 0) | (d.useAlpha ? 0x40 : 0) | (d.tStyle ? 0x80 : 0);
  b[14] = size & 0xff;
  b[15] = size >> 8;
  b[0] = shareCodeChecksum(b);
  return bytesToShareCode(b);
}

/** Console lines (`name "value"`) that apply a decoded crosshair, in the order CS:GO lists them. */
export function shareDataToCommands(d: CrosshairShareData): string[] {
  return (Object.keys(SHARE_CODE_CVARS) as (keyof CrosshairShareData)[]).map((k) => {
    const v = d[k];
    return `${SHARE_CODE_CVARS[k]} "${typeof v === 'boolean' ? (v ? 1 : 0) : v}"`;
  });
}

/** The current crosshair as share-code fields (CS:GO defaults for cvars this game doesn't have). */
export function shareDataFromCvars(get: (name: string) => string | undefined): CrosshairShareData {
  const out = { ...SHARE_CODE_DEFAULTS } as Record<keyof CrosshairShareData, number | boolean>;
  for (const k of Object.keys(SHARE_CODE_CVARS) as (keyof CrosshairShareData)[]) {
    const raw = get(SHARE_CODE_CVARS[k]);
    if (raw === undefined) continue;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) continue;
    out[k] = typeof SHARE_CODE_DEFAULTS[k] === 'boolean' ? n !== 0 : n;
  }
  return out as unknown as CrosshairShareData;
}

export function shareCodeErrorText(error: 'format' | 'checksum'): string {
  return error === 'checksum' ? "That crosshair share code doesn't check out (checksum mismatch) — check it for typos" : 'That is not a valid crosshair share code';
}
