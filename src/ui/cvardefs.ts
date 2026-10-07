// The convars the UI and audio read (documented in docs/ARCHITECTURE.md; registered by game-core in
// src/game/convars.ts). ensureUiCvars() registers any that are still missing with the same name/default/flags,
// so the UI also works standalone (harness) — registerCvar returns the existing cvar when present.
import { console_, Cvar, FCVAR_ARCHIVE, FCVAR_CHEAT, FCVAR_REPLICATED, registerCvar, saveArchivedCvars } from '../core/cvars';
import { runSilently } from './conutil';

interface Def {
  name: string;
  def: string;
  flags: number;
  min?: number;
  max?: number;
  help?: string;
}

const A = FCVAR_ARCHIVE;
const R = FCVAR_REPLICATED;

/** Physics convars (non-default = unranked "custom physics"). Order = settings table order. */
export const PHYSICS_CVARS: Def[] = [
  { name: 'sv_airaccelerate', def: '150', flags: R, help: 'Air acceleration (surf servers: 150)' },
  { name: 'sv_accelerate', def: '10', flags: R, help: 'Ground acceleration' },
  { name: 'sv_friction', def: '5.2', flags: R, help: 'Ground friction' },
  { name: 'sv_gravity', def: '800', flags: R, help: 'World gravity' },
  { name: 'sv_maxvelocity', def: '3500', flags: R, help: 'Maximum speed on any axis' },
  { name: 'sv_maxspeed', def: '350', flags: R, help: 'Maximum run speed (knife speed caps at 250)' },
  { name: 'sv_air_max_wishspeed', def: '30', flags: R, help: 'Air strafe wish speed cap' },
  { name: 'sv_stopspeed', def: '80', flags: R, help: 'Friction control speed' },
  { name: 'sv_jump_impulse', def: '301.993377', flags: R, help: 'Jump velocity' },
  { name: 'sv_stepsize', def: '18', flags: R, help: 'Step height' },
  { name: 'sv_bounce', def: '0', flags: R, help: 'Bounce factor' },
  { name: 'sv_autobunnyhopping', def: '1', flags: R, help: 'Hold jump to bhop' },
  { name: 'sv_enablebunnyhopping', def: '1', flags: R, help: 'No bhop speed cap' },
  { name: 'sv_wateraccelerate', def: '10', flags: R, help: 'Water acceleration' },
  { name: 'sv_waterfriction', def: '1', flags: R, help: 'Water friction' },
  { name: 'sv_noclipspeed', def: '5', flags: R, help: 'Noclip speed' },
  { name: 'sv_noclipaccelerate', def: '5', flags: R, help: 'Noclip acceleration' },
  { name: 'sv_rampbugfix', def: '1', flags: R, help: 'Rampbug fix, like modern surf servers' },
  { name: 'surf_prespeed', def: '350', flags: R, help: 'Speed cap when leaving a start zone (0 = none)' },
];

export const UI_CVARS: Def[] = [
  ...PHYSICS_CVARS,
  { name: 'sv_cheats', def: '0', flags: R },
  { name: 'tickrate', def: '100', flags: A, help: 'Server tickrate: 64 / 85.3 / 100 / 102.4 / 128' },
  // client
  { name: 'sensitivity', def: '2.5', flags: A, min: 0.0001, max: 1000, help: 'Mouse sensitivity (CS:GO units)' },
  { name: 'm_yaw', def: '0.022', flags: A },
  { name: 'm_pitch', def: '0.022', flags: A },
  { name: 'm_rawinput', def: '1', flags: A },
  { name: 'm_customaccel', def: '0', flags: A },
  { name: 'zoom_sensitivity_ratio_mouse', def: '1', flags: A },
  { name: 'cl_forwardspeed', def: '450', flags: A },
  { name: 'cl_sidespeed', def: '450', flags: A },
  { name: 'cl_upspeed', def: '320', flags: A },
  { name: 'fov_desired', def: '90', flags: A, min: 1, max: 179 },
  { name: 'cl_showpos', def: '0', flags: A },
  { name: 'cl_showfps', def: '0', flags: A },
  { name: 'net_graph', def: '0', flags: A },
  { name: 'cl_drawhud', def: '1', flags: A },
  { name: 'hud_scaling', def: '0.85', flags: A, min: 0.5, max: 0.95 },
  { name: 'cl_hud_color', def: '0', flags: A, min: 0, max: 10 },
  { name: 'cl_righthand', def: '1', flags: A },
  { name: 'volume', def: '0.5', flags: A, min: 0, max: 1 },
  { name: 'snd_mute_losefocus', def: '1', flags: A },
  { name: 'fps_max', def: '0', flags: A },
  // crosshair
  { name: 'crosshair', def: '1', flags: A },
  { name: 'cl_crosshairstyle', def: '4', flags: A, min: 0, max: 5 },
  { name: 'cl_crosshairsize', def: '5', flags: A },
  { name: 'cl_crosshairthickness', def: '0.5', flags: A },
  { name: 'cl_crosshairgap', def: '1', flags: A },
  { name: 'cl_crosshairdot', def: '0', flags: A },
  { name: 'cl_crosshair_drawoutline', def: '1', flags: A },
  { name: 'cl_crosshair_outlinethickness', def: '1', flags: A, min: 0, max: 3 },
  { name: 'cl_crosshaircolor', def: '1', flags: A, min: 0, max: 5 },
  { name: 'cl_crosshaircolor_r', def: '50', flags: A, min: 0, max: 255 },
  { name: 'cl_crosshaircolor_g', def: '250', flags: A, min: 0, max: 255 },
  { name: 'cl_crosshaircolor_b', def: '50', flags: A, min: 0, max: 255 },
  { name: 'cl_crosshairalpha', def: '200', flags: A, min: 0, max: 255 },
  { name: 'cl_crosshairusealpha', def: '1', flags: A },
  // video
  { name: 'mat_fullbright', def: '0', flags: A },
  { name: 'r_drawzones', def: '1', flags: A },
  { name: 'r_drawtriggers', def: '0', flags: 0 },
  { name: 'r_drawclips', def: '0', flags: 0 },
  { name: 'mat_wireframe', def: '0', flags: FCVAR_CHEAT },
  { name: 'r_brightness', def: '1', flags: A },
  { name: 'r_renderscale', def: '1', flags: A },
  { name: 'r_anisotropy', def: '8', flags: A },
  { name: 'fog_enable', def: '1', flags: A },
  { name: 'r_3dsky', def: '1', flags: A },
  // surf / hud
  { name: 'surf_hud_speed', def: '1', flags: A },
  { name: 'surf_hud_timer', def: '1', flags: A },
  { name: 'surf_showkeys', def: '1', flags: A },
  { name: 'surf_ghost', def: '1', flags: A },
  { name: 'surf_ghost_trail', def: '1', flags: A },
  { name: 'surf_hide', def: '0', flags: A, help: 'Hide other players and replay bots' },
  { name: 'surf_speedometer_color', def: '1', flags: A },
  { name: 'surf_chat_sounds', def: '1', flags: A },
];

/**
 * Cvars owned by the UI itself (not in the documented set). Registered in the Ui constructor — before the game
 * executes the saved config — so their saved values are restored.
 */
export const UI_OWNED_CVARS: Def[] = [{ name: 'cl_crosshair_t', def: '0', flags: A, help: 'T-style crosshair (no top line)' }];

export function registerUiOwnedCvars(): void {
  for (const d of UI_OWNED_CVARS) registerCvar({ name: d.name, default: d.def, flags: d.flags, min: d.min, max: d.max, help: d.help });
}

/** Registers documented cvars that nobody registered yet (no-op for existing ones). */
export function ensureUiCvars(): void {
  for (const d of UI_CVARS) {
    if (console_.getCvar(d.name)) continue;
    registerCvar({ name: d.name, default: d.def, flags: d.flags, min: d.min, max: d.max, help: d.help });
  }
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

/** True if any physics cvar (or host_timescale) differs from its default (runs become unranked). */
export function customPhysicsActive(): boolean {
  for (const name of [...PHYSICS_CVARS.map((d) => d.name), 'host_timescale']) {
    const c = console_.getCvar(name);
    if (c && Math.abs(parseFloat(c.value) - parseFloat(c.defaultValue)) > 1e-9) return true;
  }
  return false;
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
