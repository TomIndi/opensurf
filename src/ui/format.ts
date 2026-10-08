// Pure formatting helpers for the HUD and menus (unit tested).

/** Whole centiseconds of a time in seconds, truncated like a stopwatch (robust to float noise). */
export function centis(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds * 100 + 1e-6);
}

/**
 * SurfTimer-style clock: "00:47.12", "12:03.40", "1:02:03.45" (hours only when needed).
 * Truncates (never rounds up) like a stopwatch.
 */
export function formatTime(seconds: number): string {
  const cs = centis(seconds);
  const c = cs % 100;
  const totalSec = (cs - c) / 100;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const hrs = (totalMin - m) / 60;
  const cc = c < 10 ? `0${c}` : `${c}`;
  const ss = s < 10 ? `0${s}` : `${s}`;
  const mm = m < 10 ? `0${m}` : `${m}`;
  return hrs > 0 ? `${hrs}:${mm}:${ss}.${cc}` : `${mm}:${ss}.${cc}`;
}

/** Millisecond clock (KSF records): "00:53.364", "1:02:03.456" (truncated). */
export function formatTimeMs(seconds: number): string {
  const ms = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000 + 1e-6) : 0;
  const m3 = ms % 1000;
  const totalSec = (ms - m3) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const hrs = (totalMin - m) / 60;
  const mmm = m3 < 10 ? `00${m3}` : m3 < 100 ? `0${m3}` : `${m3}`;
  const ss = s < 10 ? `0${s}` : `${s}`;
  const mm = m < 10 ? `0${m}` : `${m}`;
  return hrs > 0 ? `${hrs}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}

/** Compact millisecond time (map browser): "53.364" -> "0:53.364", "1:31.934", "1:02:03.456". */
export function formatTimeMsShort(seconds: number): string {
  const t = formatTimeMs(seconds);
  return /^0\d:/.test(t) ? t.slice(1) : t;
}

/** Compact time for tables: "47.12", "1:23.45", "1:02:03.45". */
export function formatTimeShort(seconds: number): string {
  const cs = centis(seconds);
  const c = cs % 100;
  const totalSec = (cs - c) / 100;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const hrs = (totalMin - m) / 60;
  const cc = c < 10 ? `0${c}` : `${c}`;
  if (hrs > 0) return `${hrs}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${cc}`;
  if (m > 0) return `${m}:${s < 10 ? '0' : ''}${s}.${cc}`;
  return `${s}.${cc}`;
}

/** Split delta vs PB: "-0.42" (faster) / "+1.03" / "+1:02.34"; a tie (under 0.01 s) prints "±0.00". */
export function formatDelta(delta: number): string {
  if (!Number.isFinite(delta)) return '';
  const sign = delta < 0 ? '-' : '+';
  const a = Math.abs(delta);
  if (centis(a) === 0) return '±0.00';
  return sign + formatTimeShort(a);
}

export function formatSpeed(speed: number): string {
  if (!Number.isFinite(speed) || speed < 0) return '0';
  return String(Math.round(speed));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Splits "surf_utopia_njv" into the dimmed prefix "surf_" and the rest. */
export function splitMapName(name: string): { prefix: string; rest: string } {
  const m = /^(surf_|bhop_|kz_|xc_)(.+)$/i.exec(name);
  return m ? { prefix: m[1], rest: m[2] } : { prefix: '', rest: name };
}

/** "surf_utopia_njv" -> "Utopia Njv" for headings. */
export function prettyMapName(name: string): string {
  const { rest } = splitMapName(name);
  return rest
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^(ksf|njv|v\d+|fix|fixed|tc|ez|gk|ce)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export function tierName(tier: number | null | undefined): string {
  return tier ? `Tier ${tier}` : 'Unknown tier';
}

export function mapTypeName(type: string | null | undefined): string {
  switch (type) {
    case 'linear':
      return 'Linear';
    case 'staged':
      return 'Staged';
    case 'staged-linear':
      return 'Staged / Linear';
    default:
      return 'Unknown';
  }
}

/** Source-style showpos number: 2 decimals, no "-0.00". */
export function fmtPos(v: number): string {
  const s = v.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/** Clamps and rounds a number to `decimals` places for settings inputs, trimming trailing zeros. */
export function fmtNum(v: number, decimals = 3): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** cm per 360° for a CS:GO-style sensitivity: counts = 360 / (m_yaw * sens), inches = counts / dpi. */
export function cmPer360(sensitivity: number, mYaw: number, dpi: number): number {
  if (sensitivity <= 0 || mYaw <= 0 || dpi <= 0) return Infinity;
  const counts = 360 / (mYaw * sensitivity);
  return (counts / dpi) * 2.54;
}
