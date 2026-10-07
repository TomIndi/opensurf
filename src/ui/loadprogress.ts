// Loading progress model (pure, unit tested): phase spans, labels and overall-progress mapping.
import type { LoadProgress } from '../game/api';

export type Phase = LoadProgress['phase'];

/** Overall progress span [start, end) of each phase (download dominates for catalog maps). */
export const PHASE_SPANS: Record<Exclude<Phase, 'done' | 'error'>, [number, number]> = {
  download: [0, 0.5],
  extract: [0.5, 0.57],
  parse: [0.57, 0.63],
  collision: [0.63, 0.71],
  geometry: [0.71, 0.79],
  textures: [0.79, 0.92],
  renderer: [0.92, 1],
};

export const PHASE_LABELS: Record<Phase, string> = {
  download: 'Downloading',
  extract: 'Extracting',
  parse: 'Reading BSP',
  collision: 'Building collision',
  geometry: 'Building geometry',
  textures: 'Decoding textures',
  renderer: 'Uploading to GPU',
  done: 'Ready',
  error: 'Failed to load',
};

export const STEPS: [Exclude<Phase, 'done' | 'error'>, string][] = [
  ['download', 'Download'],
  ['extract', 'Extract'],
  ['parse', 'BSP'],
  ['collision', 'Collision'],
  ['geometry', 'Geometry'],
  ['textures', 'Textures'],
  ['renderer', 'GPU'],
];

const MB = 1024 * 1024;

/**
 * Raw overall progress (0..1) for a progress report; `phaseFrac` is the in-phase fraction when known.
 * Returns null for done/error.
 */
export function rawProgress(p: LoadProgress): number | null {
  if (p.phase === 'done') return 1;
  if (p.phase === 'error') return null;
  const span = PHASE_SPANS[p.phase];
  if (!span) return null;
  const frac = p.total && p.total > 0 && p.loaded !== undefined ? Math.max(0, Math.min(1, p.loaded / p.total)) : 0;
  return span[0] + (span[1] - span[0]) * frac;
}

/** Rescales so a load that starts at a later phase (built-in map, local .bsp) still fills the bar from 0. */
export function rescaleProgress(raw: number, firstPhaseStart: number): number {
  if (firstPhaseStart >= 1) return 1;
  return Math.max(0, Math.min(1, (raw - firstPhaseStart) / (1 - firstPhaseStart)));
}

export function phaseText(p: LoadProgress): string {
  if (p.phase === 'download' && p.total && p.loaded !== undefined && p.total > 0 && /download/i.test(p.message)) {
    return `Downloading ${(p.loaded / MB).toFixed(1)} / ${(p.total / MB).toFixed(1)} MB`;
  }
  if (p.phase === 'download' && p.message) return p.message.replace(/…$|\.\.\.$/, '…');
  return PHASE_LABELS[p.phase] ?? p.message;
}

