// Speed -> wind sound parameters (pure, unit tested).
// The air-rush layer starts around 300 u/s (just above run speed), builds up through typical surf speeds and
// saturates around 3000 u/s (close to sv_maxvelocity 3500). Airborne is louder than sliding on the ground.

export const WIND_START = 300;
export const WIND_FULL = 3000;

export interface WindParams {
  /** 0..1 overall intensity. */
  level: number;
  /** Gain of the low "rumble" layer (lowpassed noise). */
  lowGain: number;
  /** Lowpass cutoff of the rumble layer, Hz. */
  lowCutoff: number;
  /** Gain of the high "rush/whistle" layer (bandpassed noise). */
  highGain: number;
  /** Centre frequency of the rush layer, Hz. */
  highFreq: number;
  highQ: number;
}

export function windIntensity(speed: number): number {
  if (!Number.isFinite(speed) || speed <= WIND_START) return 0;
  const t = Math.min(1, (speed - WIND_START) / (WIND_FULL - WIND_START));
  // ease-in at the bottom (no sudden onset), near-linear through the middle, soft saturation at the top
  return t * t * (3 - 2 * t) * 0.6 + t * 0.4;
}

export function windParams(speed: number, airborne: boolean): WindParams {
  const s = windIntensity(speed);
  const level = s * (airborne ? 1 : 0.5);
  return {
    level,
    lowGain: 0.32 * level,
    lowCutoff: 160 + 820 * s,
    highGain: 0.2 * Math.pow(level, 1.35),
    highFreq: 450 + 3100 * Math.pow(s, 1.15),
    highQ: 0.55 + 0.75 * s,
  };
}
