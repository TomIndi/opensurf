// The convars the UI and audio read. They are defined and registered in ONE place, the game core's
// src/game/convars.ts (CVAR_DEFS: names, defaults, flags, limits, help; docs/ARCHITECTURE.md "Convars"); this
// module only re-exports those definitions (the physics ones in settings-table order) and registers them early
// (ensureUiCvars -> registerConvars, idempotent and first-wins), so the UI also works standalone (harness) and
// never reads a cvar before it exists.
import { console_, Cvar, FCVAR_ARCHIVE, FCVAR_CHEAT, registerCvar, saveArchivedCvars } from '../core/cvars';
import { CVAR_DEFS, isCustomPhysics, PHYSICS_CVAR_DEFS, registerConvars } from '../game/convars';
import { runSilently } from './conutil';

interface Def {
  name: string;
  def: string;
  flags: number;
  min?: number;
  max?: number;
  help?: string;
}

/** Settings-table order of the physics convars (any physics cvar not listed here follows at the end). */
const PHYSICS_ORDER = [
  'sv_airaccelerate',
  'sv_accelerate',
  'sv_friction',
  'sv_gravity',
  'sv_maxvelocity',
  'sv_maxspeed',
  'sv_air_max_wishspeed',
  'sv_stopspeed',
  'sv_jump_impulse',
  'sv_stepsize',
  'sv_bounce',
  'sv_autobunnyhopping',
  'sv_enablebunnyhopping',
  'sv_wateraccelerate',
  'sv_waterfriction',
  'sv_noclipspeed',
  'sv_noclipaccelerate',
  'sv_rampbugfix',
  'surf_prespeed',
];

function orderPhysics(defs: readonly Def[]): Def[] {
  const rank = (n: string) => {
    const i = PHYSICS_ORDER.indexOf(n);
    return i < 0 ? PHYSICS_ORDER.length : i;
  };
  return [...defs].sort((a, b) => rank(a.name) - rank(b.name));
}

/** Physics convars (non-default = unranked "custom physics"), from the game's definitions. Order = settings table order. */
export const PHYSICS_CVARS: readonly Def[] = orderPhysics(PHYSICS_CVAR_DEFS);

/** Every documented convar (the game's definitions). */
export const UI_CVARS: readonly Def[] = CVAR_DEFS;

/**
 * Cvars owned by the UI itself (not in the documented set). Registered in the Ui constructor — before the game
 * executes the saved config — so their saved values are restored.
 */
export const UI_OWNED_CVARS: Def[] = [{ name: 'cl_crosshair_t', def: '0', flags: FCVAR_ARCHIVE, help: 'T-style crosshair (no top line)' }];

export function registerUiOwnedCvars(): void {
  for (const d of UI_OWNED_CVARS) registerCvar({ name: d.name, default: d.def, flags: d.flags, min: d.min, max: d.max, help: d.help });
}

/**
 * Registers the documented cvars through the game's registerConvars() (idempotent; a cvar registered earlier is
 * kept as is). Called by the Ui constructor, so every cvar exists before the UI first reads one.
 */
export function ensureUiCvars(): void {
  registerConvars();
}

export function cvarStr(name: string, fallback = ''): string {
  return console_.getCvar(name)?.value ?? fallback;
}

export function cvarNum(name: string, fallback = 0): number {
  const c = console_.getCvar(name);
  if (!c) return fallback;
  const n = parseFloat(c.value);
  return Number.isFinite(n) ? n : fallback;
}

export function cvarBool(name: string, fallback = false): boolean {
  const c = console_.getCvar(name);
  return c ? c.bool : fallback;
}

export function cvarGetter(name: string): string | undefined {
  return console_.getCvar(name)?.value;
}

export type SetResult = 'ok' | 'cheat' | 'unknown';

/** Sets a cvar from a settings control, honouring FCVAR_CHEAT like the console does. */
export function setCvar(name: string, value: string | number | boolean): SetResult {
  const c: Cvar | undefined = console_.getCvar(name);
  if (!c) return 'unknown';
  if (c.flags & FCVAR_CHEAT && !cvarBool('sv_cheats', false)) return 'cheat';
  c.set(value);
  return 'ok';
}

/** True if any physics cvar (or host_timescale) differs from its default (runs become unranked): the game's check. */
export function customPhysicsActive(): boolean {
  return isCustomPhysics();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Persists archived cvars (and binds) — host_writeconfig when the game provides it. Debounced. */
export function persistConfigSoon(delay = 400): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistConfigNow();
  }, delay);
}

export function persistConfigNow(): void {
  if (console_.hasCommand('host_writeconfig')) runSilently(() => console_.executeArgv(['host_writeconfig']));
  else saveArchivedCvars();
}
