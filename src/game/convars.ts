// Every convar of the game, registered in one place (docs/ARCHITECTURE.md "Convars"), plus the derived values the
// simulation reads every tick: the movement vars (cached, rebuilt when an sv_* cvar changes), the tick interval
// (the `tickrate` cvar snapped to the CS:GO server presets) and the "custom physics" check that makes runs
// unranked.
//
// Flags follow Source: FCVAR_ARCHIVE = saved in the user's config (client preferences, crosshair, video, HUD),
// FCVAR_REPLICATED = server/physics variable (sv_*, tickrate: changing one mid-run puts the run in practice),
// FCVAR_CHEAT = needs sv_cheats 1.
import {
  console_,
  Cvar,
  FCVAR_ARCHIVE,
  FCVAR_CHEAT,
  FCVAR_NONE,
  FCVAR_REPLICATED,
  registerCvar,
} from '../core/cvars';
import { defaultMoveVars, movementOptions } from '../physics/movement';
import { MoveVars } from '../physics/playertypes';

const A = FCVAR_ARCHIVE;
const R = FCVAR_REPLICATED;
const C = FCVAR_CHEAT;

export interface CvarDef {
  name: string;
  def: string;
  flags: number;
  min?: number;
  max?: number;
  help: string;
}

/** The player's (knife) running speed: CS:GO caps the client move speed at the weapon speed. */
export const KNIFE_SPEED = 250;

/** Movement convars: a non-default value makes runs unranked ("custom physics"). */
export const PHYSICS_CVAR_DEFS: readonly CvarDef[] = [
  { name: 'sv_gravity', def: '800', flags: R, help: 'World gravity (units/s²).' },
  { name: 'sv_accelerate', def: '10', flags: R, help: 'Ground acceleration.' },
  { name: 'sv_airaccelerate', def: '150', flags: R, help: 'Air acceleration (CS:GO surf servers run 150).' },
  { name: 'sv_friction', def: '5.2', flags: R, min: 0, help: 'Ground friction.' },
  { name: 'sv_stopspeed', def: '80', flags: R, min: 0, help: 'Minimum stopping speed when on ground (friction control).' },
  { name: 'sv_maxspeed', def: '350', flags: R, min: 0, help: 'Maximum player speed (running is capped by the knife speed, 250).' },
  { name: 'sv_maxvelocity', def: '3500', flags: R, min: 0, help: 'Maximum speed on any axis.' },
  { name: 'sv_air_max_wishspeed', def: '30', flags: R, min: 0, help: 'Air strafe wish speed cap.' },
  { name: 'sv_jump_impulse', def: '301.993377', flags: R, min: 0, help: 'Initial upwards velocity of a jump.' },
  { name: 'sv_stepsize', def: '18', flags: R, min: 0, help: 'Maximum step height.' },
  { name: 'sv_bounce', def: '0', flags: R, min: 0, help: 'Bounce multiplier for collisions (0 = slide).' },
  { name: 'sv_autobunnyhopping', def: '1', flags: R, min: 0, max: 1, help: 'Holding jump re-jumps on landing.' },
  { name: 'sv_enablebunnyhopping', def: '1', flags: R, min: 0, max: 1, help: 'Allow speeds above the run speed (no bhop speed cap).' },
  { name: 'sv_wateraccelerate', def: '10', flags: R, min: 0, help: 'Water acceleration.' },
  { name: 'sv_waterfriction', def: '1', flags: R, min: 0, help: 'Water friction.' },
  { name: 'sv_noclipspeed', def: '5', flags: R, min: 0, help: 'Noclip speed multiplier.' },
  { name: 'sv_noclipaccelerate', def: '5', flags: R, min: 0, help: 'Noclip acceleration.' },
  { name: 'sv_rampbugfix', def: '1', flags: R, min: 0, max: 1, help: 'Rampbug fix (like surf servers): never lose speed to precision glitches on ramps.' },
  { name: 'surf_prespeed', def: '350', flags: R, min: 0, help: 'Speed cap when leaving a start zone (u/s, 0 = none).' },
];

/** All convars registered by the game core, in registration order. */
export const CVAR_DEFS: readonly CvarDef[] = [
  ...PHYSICS_CVAR_DEFS,
  { name: 'sv_cheats', def: '0', flags: R, min: 0, max: 1, help: 'Allow cheat commands and cvars (mat_wireframe, ent_fire, host_timescale).' },
  { name: 'tickrate', def: '100', flags: R | A, help: 'Simulation rate in ticks per second: 64 / 85.3 / 100 / 102.4 / 128 (snaps to the nearest).' },
  { name: 'host_timescale', def: '1', flags: C, min: 0.1, max: 10, help: 'Game speed multiplier (cheat; runs become unranked).' },

  // ---- client
  { name: 'name', def: 'Player', flags: A, help: 'Your player name (chat, records, scoreboard).' },
  { name: 'developer', def: '0', flags: FCVAR_NONE, min: 0, max: 2, help: 'Show developer messages (map logic diagnostics).' },
  { name: 'sensitivity', def: '2.5', flags: A, min: 0.0001, max: 1000, help: 'Mouse sensitivity (CS:GO units).' },
  { name: 'm_yaw', def: '0.022', flags: A, min: -1, max: 1, help: 'Mouse yaw factor (degrees per count at sensitivity 1).' },
  { name: 'm_pitch', def: '0.022', flags: A, min: -1, max: 1, help: 'Mouse pitch factor (negative inverts the mouse).' },
  { name: 'm_rawinput', def: '1', flags: A, min: 0, max: 1, help: 'Raw mouse input (no OS acceleration) when the browser supports it.' },
  { name: 'm_customaccel', def: '0', flags: A, min: 0, max: 2, help: 'Custom mouse acceleration: 0 off, 1 on, 2 on + rescale by m_yaw/m_pitch.' },
  { name: 'm_customaccel_scale', def: '0.04', flags: A, min: 0, help: 'Custom mouse acceleration amount.' },
  { name: 'm_customaccel_max', def: '0', flags: A, min: 0, help: 'Maximum accelerated sensitivity (0 = no limit).' },
  { name: 'm_customaccel_exponent', def: '1.05', flags: A, min: 1, help: 'Custom mouse acceleration exponent.' },
  { name: 'm_filter', def: '0', flags: A, min: 0, max: 1, help: 'Mouse filtering: average the mouse movement of the last two frames.' },
  { name: 'zoom_sensitivity_ratio_mouse', def: '1', flags: A, min: 0.001, max: 2, help: 'Sensitivity multiplier while zoomed.' },
  { name: 'cl_forwardspeed', def: '450', flags: A, min: 0, max: 10000, help: 'Forward move speed of +forward.' },
  { name: 'cl_backspeed', def: '450', flags: A, min: 0, max: 10000, help: 'Back move speed of +back.' },
  { name: 'cl_sidespeed', def: '450', flags: A, min: 0, max: 10000, help: 'Side move speed of +moveleft / +moveright.' },
  { name: 'cl_upspeed', def: '320', flags: A, min: 0, max: 10000, help: 'Up/down move speed (swimming, noclip).' },
  { name: 'cl_yawspeed', def: '210', flags: A, min: 0, help: 'Turn speed of +left / +right (degrees per second).' },
  { name: 'cl_pitchspeed', def: '225', flags: A, min: 0, help: 'Look speed of +lookup / +lookdown (degrees per second).' },
  { name: 'cl_anglespeedkey', def: '0.67', flags: A, min: 0, help: 'Keyboard turn speed multiplier while +speed is held.' },
  { name: 'fov_desired', def: '90', flags: A, min: 60, max: 130, help: 'Field of view: horizontal degrees at 4:3, like CS:GO (wider screens see more).' },
  { name: 'cl_showpos', def: '0', flags: A, min: 0, max: 2, help: 'Show position, angles and velocity.' },
  { name: 'cl_showfps', def: '0', flags: A, min: 0, max: 5, help: 'Show the frame rate.' },
  { name: 'net_graph', def: '0', flags: A, min: 0, max: 1, help: 'Show the performance graph (fps, tickrate).' },
  { name: 'cl_drawhud', def: '1', flags: A, min: 0, max: 1, help: 'Draw the HUD.' },
  { name: 'hud_scaling', def: '0.85', flags: A, min: 0.5, max: 0.95, help: 'HUD scale.' },
  { name: 'cl_hud_color', def: '0', flags: A, min: 0, max: 10, help: 'HUD color.' },
  { name: 'cl_righthand', def: '1', flags: A, min: 0, max: 1, help: 'Viewmodel hand (1 = right).' },
  { name: 'volume', def: '0.5', flags: A, min: 0, max: 1, help: 'Master volume.' },
  { name: 'snd_mute_losefocus', def: '1', flags: A, min: 0, max: 1, help: 'Mute the game when its tab loses focus.' },
  { name: 'fps_max', def: '0', flags: A, min: 0, max: 1000, help: 'Frame rate limiter (0 = display refresh rate).' },

  // ---- crosshair (CS:GO names and semantics)
  { name: 'crosshair', def: '1', flags: A, min: 0, max: 1, help: 'Draw the crosshair.' },
  { name: 'cl_crosshairstyle', def: '4', flags: A, min: 0, max: 5, help: 'Crosshair style (0 default .. 4 classic static, 5 legacy).' },
  { name: 'cl_crosshairsize', def: '5', flags: A, min: 0, max: 100, help: 'Crosshair line length.' },
  { name: 'cl_crosshairthickness', def: '0.5', flags: A, min: 0, max: 20, help: 'Crosshair line thickness.' },
  { name: 'cl_crosshairgap', def: '1', flags: A, min: -100, max: 100, help: 'Crosshair center gap.' },
  { name: 'cl_crosshairdot', def: '0', flags: A, min: 0, max: 1, help: 'Center dot.' },
  { name: 'cl_crosshair_drawoutline', def: '1', flags: A, min: 0, max: 1, help: 'Black outline around the crosshair.' },
  { name: 'cl_crosshair_outlinethickness', def: '1', flags: A, min: 0, max: 3, help: 'Outline thickness.' },
  { name: 'cl_crosshaircolor', def: '1', flags: A, min: 0, max: 5, help: 'Crosshair color: 0 red, 1 green, 2 yellow, 3 blue, 4 cyan, 5 custom.' },
  { name: 'cl_crosshaircolor_r', def: '50', flags: A, min: 0, max: 255, help: 'Custom crosshair red.' },
  { name: 'cl_crosshaircolor_g', def: '250', flags: A, min: 0, max: 255, help: 'Custom crosshair green.' },
  { name: 'cl_crosshaircolor_b', def: '50', flags: A, min: 0, max: 255, help: 'Custom crosshair blue.' },
  { name: 'cl_crosshairalpha', def: '200', flags: A, min: 0, max: 255, help: 'Crosshair alpha.' },
  { name: 'cl_crosshairusealpha', def: '1', flags: A, min: 0, max: 1, help: 'Use cl_crosshairalpha (0 = additive).' },

  // ---- video
  { name: 'mat_fullbright', def: '0', flags: A, min: 0, max: 1, help: 'Ignore lightmaps (fully lit world).' },
  { name: 'r_drawzones', def: '1', flags: A, min: 0, max: 1, help: 'Draw the timer zones.' },
  { name: 'r_drawtriggers', def: '0', flags: FCVAR_NONE, min: 0, max: 1, help: 'Draw trigger volumes (debug).' },
  { name: 'r_drawclips', def: '0', flags: FCVAR_NONE, min: 0, max: 1, help: 'Draw player clip brushes (debug).' },
  { name: 'mat_wireframe', def: '0', flags: C, min: 0, max: 1, help: 'Wireframe rendering (cheat).' },
  { name: 'r_brightness', def: '1', flags: A, min: 0.25, max: 4, help: 'Brightness multiplier.' },
  { name: 'r_renderscale', def: '1', flags: A, min: 0.25, max: 1, help: 'Resolution scale.' },
  { name: 'r_anisotropy', def: '8', flags: A, min: 1, max: 16, help: 'Anisotropic texture filtering.' },
  { name: 'fog_enable', def: '1', flags: A, min: 0, max: 1, help: 'Map fog.' },
  { name: 'r_3dsky', def: '1', flags: A, min: 0, max: 1, help: 'Draw the 3D skybox.' },

  // ---- surf / HUD
  { name: 'surf_hud_speed', def: '1', flags: A, min: 0, max: 1, help: 'Show the speedometer (!speed).' },
  { name: 'surf_hud_timer', def: '1', flags: A, min: 0, max: 1, help: 'Show the timer.' },
  { name: 'surf_showkeys', def: '1', flags: A, min: 0, max: 1, help: 'Show pressed movement keys (!showkeys).' },
  { name: 'surf_ghost', def: '1', flags: A, min: 0, max: 1, help: 'Race the ghost of your personal best (!ghost).' },
  { name: 'surf_ghost_trail', def: '1', flags: A, min: 0, max: 1, help: 'Draw a trail behind the ghost.' },
  { name: 'surf_hide', def: '0', flags: A, min: 0, max: 1, help: 'Hide other players and replay bots (!hide).' },
  { name: 'surf_speedometer_color', def: '1', flags: A, min: 0, max: 1, help: 'Color the speedometer by acceleration.' },
  { name: 'surf_chat_sounds', def: '1', flags: A, min: 0, max: 1, help: 'Play a sound for chat messages.' },
];

const PHYSICS_NAMES: ReadonlySet<string> = new Set(PHYSICS_CVAR_DEFS.map((d) => d.name));

/** Tickrates of CS:GO surf servers. 85.333 (= 256/3) and 102.4 give exact binary tick intervals. */
export const ALLOWED_TICKRATES: readonly number[] = [64, 256 / 3, 100, 102.4, 128];
/** Display strings of ALLOWED_TICKRATES (the settings UI presets). */
export const TICKRATE_NAMES: readonly string[] = ['64', '85.3', '100', '102.4', '128'];

let registered = false;
let moveVarsCache: MoveVars | null = null;

/** Snaps any rate to the nearest allowed tickrate (ties go to the lower one). Non-numbers give 100. */
export function snapTickrate(rate: number): number {
  if (!Number.isFinite(rate)) return 100;
  let best = ALLOWED_TICKRATES[0];
  let bestD = Infinity;
  for (const t of ALLOWED_TICKRATES) {
    const d = Math.abs(t - rate);
    if (d < bestD - 1e-9) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/** The canonical cvar string of the allowed tickrate nearest to `rate` ("85.3" for 85.333). */
export function tickrateName(rate: number): string {
  const s = snapTickrate(rate);
  return TICKRATE_NAMES[ALLOWED_TICKRATES.indexOf(s)];
}

/** Ticks per second (snapped `tickrate`). */
export function tickRate(): number {
  const c = console_.getCvar('tickrate');
  return snapTickrate(c ? parseFloat(c.value) : 100);
}

/** Seconds per tick (1 / snapped `tickrate`). */
export function tickInterval(): number {
  return 1 / tickRate();
}

function num(name: string, fallback: number): number {
  const c = console_.getCvar(name);
  if (!c) return fallback;
  const n = parseFloat(c.value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The movement vars from the sv_* cvars (cached until one of them changes; the returned object is replaced, not
 * mutated, so holders of an old reference keep a consistent snapshot). Ground speed is capped by the knife
 * speed: maxspeed = min(sv_maxspeed, 250), which together with the client-side move scaling also gives CS:GO's
 * noclip speed (250 · sv_noclipspeed).
 */
export function getMoveVars(): MoveVars {
  if (moveVarsCache) return moveVarsCache;
  const d = defaultMoveVars();
  const v: MoveVars = {
    ...d,
    gravity: num('sv_gravity', d.gravity),
    accelerate: num('sv_accelerate', d.accelerate),
    airaccelerate: num('sv_airaccelerate', d.airaccelerate),
    friction: num('sv_friction', d.friction),
    stopspeed: num('sv_stopspeed', d.stopspeed),
    maxspeed: Math.min(num('sv_maxspeed', 350), KNIFE_SPEED),
    maxvelocity: num('sv_maxvelocity', d.maxvelocity),
    airMaxWishspeed: num('sv_air_max_wishspeed', d.airMaxWishspeed),
    jumpImpulse: num('sv_jump_impulse', d.jumpImpulse),
    stepsize: num('sv_stepsize', d.stepsize),
    bounce: num('sv_bounce', d.bounce),
    autobhop: num('sv_autobunnyhopping', 1) !== 0,
    enableBunnyhopping: num('sv_enablebunnyhopping', 1) !== 0,
    wateraccelerate: num('sv_wateraccelerate', d.wateraccelerate),
    waterfriction: num('sv_waterfriction', d.waterfriction),
    noclipspeed: num('sv_noclipspeed', d.noclipspeed),
    noclipaccelerate: num('sv_noclipaccelerate', d.noclipaccelerate),
    // CS:GO constants (not convars): ducked speed 34 %, walk 52 %, ~0.125 s duck (duck speed 8/s), ladders 200
    duckSpeedMultiplier: 0.34,
    walkSpeedMultiplier: 0.52,
    duckTime: d.duckTime,
    ladderSpeed: 200,
  };
  moveVarsCache = v;
  return v;
}

/** Forgets the cached movement vars (done automatically when a physics cvar changes). */
export function invalidateMoveVars(): void {
  moveVarsCache = null;
}

function differsFromDefault(c: Cvar): boolean {
  const a = parseFloat(c.value);
  const b = parseFloat(c.defaultValue);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) > 1e-9;
  return c.value !== c.defaultValue;
}

/**
 * True when a movement convar differs from the surf server default (or the game runs at a modified
 * host_timescale): runs are then unranked. The tickrate is a server choice, not custom physics (records keep
 * their tickrate).
 */
export function isCustomPhysics(): boolean {
  for (const d of PHYSICS_CVAR_DEFS) {
    const c = console_.getCvar(d.name);
    if (c && differsFromDefault(c)) return true;
  }
  const ts = console_.getCvar('host_timescale');
  return !!ts && differsFromDefault(ts);
}

/** Names of the physics convars (non-default = custom physics). */
export function isPhysicsCvar(name: string): boolean {
  return PHYSICS_NAMES.has(name.toLowerCase());
}

/** Speed multiplier of the simulation (host_timescale, only with sv_cheats 1). */
export function hostTimescale(): number {
  const ts = num('host_timescale', 1);
  return ts > 0 ? ts : 1;
}

function sanitizeName(c: Cvar): void {
  // quotes would break the saved config; Steam names are at most 32 characters
  let v = c.value.replace(/["\n\r\t]/g, '').trim();
  if (v.length > 32) v = v.slice(0, 32);
  if (!v) v = 'Player';
  if (v !== c.value) c.set(v);
}

/**
 * Registers every game convar (idempotent; a cvar that something else registered first is kept as is) and the
 * listeners that keep the derived values (movement vars, rampbug option, tickrate snapping) up to date.
 */
export function registerConvars(): void {
  if (registered) return;
  registered = true;
  for (const d of CVAR_DEFS) {
    registerCvar({ name: d.name, default: d.def, flags: d.flags, min: d.min, max: d.max, help: d.help });
  }
  const tick = console_.cvar('tickrate');
  tick.onChange((c) => {
    const canon = tickrateName(parseFloat(c.value));
    if (c.value !== canon) c.set(canon);
  });
  // a stored or default value that is not canonical (e.g. "85.333")
  const canon = tickrateName(parseFloat(tick.value));
  if (tick.value !== canon) tick.set(canon);

  console_.cvar('name').onChange((c) => sanitizeName(c));
  sanitizeName(console_.cvar('name'));

  const rb = console_.cvar('sv_rampbugfix');
  movementOptions.rampbugFix = rb.bool;
  rb.onChange((c) => {
    movementOptions.rampbugFix = c.bool;
  });

  console_.onCvarChange((c) => {
    if (PHYSICS_NAMES.has(c.name)) moveVarsCache = null;
  });
}
