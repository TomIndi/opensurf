import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { console_, cvar, FCVAR_ARCHIVE, FCVAR_CHEAT, FCVAR_REPLICATED } from '../src/core/cvars';
import {
  ALLOWED_TICKRATES,
  CVAR_DEFS,
  getMoveVars,
  isCustomPhysics,
  isPhysicsCvar,
  registerConvars,
  snapTickrate,
  tickInterval,
  tickRate,
  tickrateName,
} from '../src/game/convars';
import { defaultMoveVars, movementOptions } from '../src/physics/movement';

beforeAll(() => registerConvars());
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
});

/** The convar table of docs/ARCHITECTURE.md ("Convars"), name -> default. */
const DOCUMENTED: Record<string, string> = {
  sv_gravity: '800',
  sv_accelerate: '10',
  sv_airaccelerate: '150',
  sv_friction: '5.2',
  sv_stopspeed: '80',
  sv_maxspeed: '350',
  sv_maxvelocity: '3500',
  sv_air_max_wishspeed: '30',
  sv_jump_impulse: '301.993377',
  sv_stepsize: '18',
  sv_bounce: '0',
  sv_autobunnyhopping: '1',
  sv_enablebunnyhopping: '1',
  sv_wateraccelerate: '10',
  sv_waterfriction: '1',
  sv_noclipspeed: '5',
  sv_noclipaccelerate: '5',
  sv_cheats: '0',
  tickrate: '100',
  sensitivity: '2.5',
  m_yaw: '0.022',
  m_pitch: '0.022',
  m_rawinput: '1',
  m_customaccel: '0',
  zoom_sensitivity_ratio_mouse: '1',
  cl_forwardspeed: '450',
  cl_sidespeed: '450',
  cl_upspeed: '320',
  fov_desired: '90',
  cl_showpos: '0',
  cl_showfps: '0',
  net_graph: '0',
  cl_drawhud: '1',
  hud_scaling: '0.85',
  cl_hud_color: '0',
  cl_righthand: '1',
  volume: '0.5',
  snd_mute_losefocus: '1',
  fps_max: '0',
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
  mat_fullbright: '0',
  r_drawzones: '1',
  r_drawtriggers: '0',
  r_drawclips: '0',
  mat_wireframe: '0',
  r_brightness: '1',
  r_renderscale: '1',
  r_anisotropy: '8',
  mat_antialias: '4',
  fog_enable: '1',
  r_3dsky: '1',
  surf_hud_speed: '1',
  surf_hud_timer: '1',
  surf_showkeys: '1',
  surf_ghost: '1',
  surf_ghost_trail: '1',
  surf_prespeed: '350',
  surf_speedometer_color: '1',
  surf_chat_sounds: '1',
  // task extras
  name: 'Player',
  developer: '0',
  cl_yawspeed: '210',
  cl_pitchspeed: '225',
};

describe('registration', () => {
  it('registers every documented cvar with its default', () => {
    for (const [name, def] of Object.entries(DOCUMENTED)) {
      const c = console_.getCvar(name);
      expect(c, name).toBeDefined();
      expect(c!.defaultValue, name).toBe(def);
      expect(c!.value, name).toBe(def);
    }
  });

  it('is idempotent', () => {
    const before = console_.allCvars().length;
    registerConvars();
    expect(console_.allCvars().length).toBe(before);
  });

  it('every cvar has help text', () => {
    for (const d of CVAR_DEFS) expect(cvar(d.name).help.length, d.name).toBeGreaterThan(3);
  });

  it('marks sv_* and tickrate replicated, client prefs archived', () => {
    for (const name of Object.keys(DOCUMENTED)) {
      const c = cvar(name);
      if (name.startsWith('sv_') || name === 'tickrate') expect(c.flags & FCVAR_REPLICATED, name).toBeTruthy();
    }
    for (const name of ['sensitivity', 'm_yaw', 'fov_desired', 'cl_crosshairsize', 'cl_crosshaircolor', 'mat_fullbright', 'r_anisotropy', 'surf_showkeys', 'surf_ghost', 'cl_showpos', 'volume', 'name', 'cl_yawspeed', 'tickrate']) {
      expect(cvar(name).flags & FCVAR_ARCHIVE, name).toBeTruthy();
    }
    // physics must not be archived (a session with custom physics shouldn't stick), debug views neither
    for (const name of ['sv_airaccelerate', 'sv_gravity', 'sv_cheats', 'r_drawtriggers', 'developer']) {
      expect(cvar(name).flags & FCVAR_ARCHIVE, name).toBeFalsy();
    }
    expect(cvar('mat_wireframe').flags & FCVAR_CHEAT).toBeTruthy();
    expect(cvar('host_timescale').flags & FCVAR_CHEAT).toBeTruthy();
  });
});

describe('clamping', () => {
  it('clamps to min/max', () => {
    cvar('fov_desired').set(200);
    expect(cvar('fov_desired').value).toBe('130');
    cvar('fov_desired').set(10);
    expect(cvar('fov_desired').value).toBe('60');
    cvar('cl_crosshaircolor').set(9);
    expect(cvar('cl_crosshaircolor').num).toBe(5);
    cvar('sensitivity').set(-3);
    expect(cvar('sensitivity').num).toBe(0.0001);
    cvar('volume').set('1.5');
    expect(cvar('volume').num).toBe(1);
    cvar('hud_scaling').set(0.1);
    expect(cvar('hud_scaling').num).toBe(0.5);
    cvar('m_pitch').set(-0.022);
    expect(cvar('m_pitch').num).toBe(-0.022); // inverted mouse is allowed
  });

  it('keeps in-range values untouched', () => {
    cvar('sensitivity').set('1.75');
    expect(cvar('sensitivity').value).toBe('1.75');
    cvar('sv_airaccelerate').set(1000);
    expect(cvar('sv_airaccelerate').value).toBe('1000');
  });

  it('sanitizes the player name', () => {
    cvar('name').set('Bo"b\n');
    expect(cvar('name').value).toBe('Bob');
    cvar('name').set('   ');
    expect(cvar('name').value).toBe('Player');
    cvar('name').set('x'.repeat(50));
    expect(cvar('name').value).toBe('x'.repeat(32));
  });
});

describe('tickrate', () => {
  it('snaps to the CS:GO presets', () => {
    expect(snapTickrate(64)).toBe(64);
    expect(snapTickrate(66)).toBe(64);
    expect(snapTickrate(85.3)).toBeCloseTo(256 / 3, 9);
    expect(snapTickrate(90)).toBeCloseTo(256 / 3, 9);
    expect(snapTickrate(100)).toBe(100);
    expect(snapTickrate(101)).toBe(100);
    expect(snapTickrate(102)).toBe(102.4);
    expect(snapTickrate(128)).toBe(128);
    expect(snapTickrate(1000)).toBe(128);
    expect(snapTickrate(1)).toBe(64);
    expect(snapTickrate(NaN)).toBe(100);
    expect(ALLOWED_TICKRATES).toHaveLength(5);
  });

  it('canonicalizes the cvar and gives exact tick intervals', () => {
    expect(tickInterval()).toBe(0.01);
    cvar('tickrate').set('85.3333');
    expect(cvar('tickrate').value).toBe('85.3');
    expect(tickInterval()).toBe(0.01171875); // 3/256 s, exact in binary
    cvar('tickrate').set(102.4);
    expect(cvar('tickrate').value).toBe('102.4');
    expect(tickInterval()).toBe(0.009765625);
    cvar('tickrate').set(66);
    expect(cvar('tickrate').value).toBe('64');
    expect(tickInterval()).toBe(1 / 64);
    expect(tickRate()).toBe(64);
    cvar('tickrate').set('128');
    expect(tickInterval()).toBe(0.0078125);
    cvar('tickrate').set('banana');
    expect(cvar('tickrate').value).toBe('100');
    expect(tickrateName(85.33)).toBe('85.3');
  });
});

describe('movement vars', () => {
  it('match the movement defaults at server defaults, capped by knife speed', () => {
    const v = getMoveVars();
    const d = defaultMoveVars();
    expect(v.maxspeed).toBe(250); // min(sv_maxspeed 350, knife 250)
    expect({ ...v, maxspeed: d.maxspeed }).toEqual({ ...d, ladderSpeed: 200, duckSpeedMultiplier: 0.34, walkSpeedMultiplier: 0.52 });
    expect(v.duckSpeedMultiplier).toBe(0.34);
    expect(v.walkSpeedMultiplier).toBe(0.52);
    expect(v.ladderSpeed).toBe(200);
    expect(v.duckTime).toBeGreaterThan(0.1);
    expect(v.duckTime).toBeLessThanOrEqual(0.2);
    expect(v.autobhop).toBe(true);
    expect(v.enableBunnyhopping).toBe(true);
  });

  it('is cached and rebuilt when a physics cvar changes', () => {
    const a = getMoveVars();
    expect(getMoveVars()).toBe(a);
    cvar('sensitivity').set(3); // not physics
    expect(getMoveVars()).toBe(a);
    cvar('sv_airaccelerate').set(1000);
    const b = getMoveVars();
    expect(b).not.toBe(a);
    expect(b.airaccelerate).toBe(1000);
    expect(a.airaccelerate).toBe(150); // old snapshot untouched
    cvar('sv_autobunnyhopping').set(0);
    expect(getMoveVars().autobhop).toBe(false);
    cvar('sv_maxspeed').set(200);
    expect(getMoveVars().maxspeed).toBe(200);
    cvar('sv_gravity').set(400);
    expect(getMoveVars().gravity).toBe(400);
  });

  it('sv_rampbugfix drives the movement option', () => {
    expect(movementOptions.rampbugFix).toBe(true);
    cvar('sv_rampbugfix').set(0);
    expect(movementOptions.rampbugFix).toBe(false);
    cvar('sv_rampbugfix').set(1);
    expect(movementOptions.rampbugFix).toBe(true);
  });
});

describe('custom physics', () => {
  it('is off at the server defaults', () => {
    expect(isCustomPhysics()).toBe(false);
  });

  it('turns on for any non-default movement cvar or host_timescale', () => {
    for (const name of ['sv_airaccelerate', 'sv_gravity', 'sv_friction', 'sv_maxvelocity', 'sv_autobunnyhopping', 'sv_rampbugfix', 'surf_prespeed']) {
      const c = cvar(name);
      c.set(c.num + 1);
      if (c.value === c.defaultValue) c.set(0);
      expect(isCustomPhysics(), name).toBe(true);
      c.reset();
      expect(isCustomPhysics(), name).toBe(false);
    }
    cvar('host_timescale').set(0.5);
    expect(isCustomPhysics()).toBe(true);
  });

  it('numeric equality counts as default ("150.0" == "150")', () => {
    cvar('sv_airaccelerate').set('150.0');
    expect(isCustomPhysics()).toBe(false);
  });

  it('tickrate and client settings are not custom physics', () => {
    cvar('tickrate').set(128);
    cvar('sensitivity').set(1);
    cvar('fov_desired').set(110);
    expect(isCustomPhysics()).toBe(false);
    expect(isPhysicsCvar('sv_airaccelerate')).toBe(true);
    expect(isPhysicsCvar('SV_GRAVITY')).toBe(true);
    expect(isPhysicsCvar('tickrate')).toBe(false);
  });
});
