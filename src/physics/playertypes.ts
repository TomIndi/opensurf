// Player movement contracts (CS:GO / Source gamemovement model).
import { QAngle, qa } from '../core/angles';
import { Vec3, v3 } from '../core/vec3';

// ---- usercmd buttons (in_buttons.h values) ----
export const IN_ATTACK = 1 << 0;
export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;
export const IN_FORWARD = 1 << 3;
export const IN_BACK = 1 << 4;
export const IN_USE = 1 << 5;
export const IN_LEFT = 1 << 7;
export const IN_RIGHT = 1 << 8;
export const IN_MOVELEFT = 1 << 9;
export const IN_MOVERIGHT = 1 << 10;
export const IN_ATTACK2 = 1 << 11;
export const IN_RELOAD = 1 << 13;
export const IN_SCORE = 1 << 16;
/** +speed = walk (shift) in CS:GO. */
export const IN_SPEED = 1 << 17;

// ---- player flags ----
export const FL_ONGROUND = 1 << 0;
export const FL_DUCKING = 1 << 1;
export const FL_WATERJUMP = 1 << 3;
export const FL_INWATER = 1 << 9;
export const FL_BASEVELOCITY = 1 << 23;

export const MOVETYPE_WALK = 2;
export const MOVETYPE_NOCLIP = 8;
export const MOVETYPE_LADDER = 9;
export const MOVETYPE_OBSERVER = 10;
export type MoveType = typeof MOVETYPE_WALK | typeof MOVETYPE_NOCLIP | typeof MOVETYPE_LADDER | typeof MOVETYPE_OBSERVER;

// ---- CS:GO player hulls (origin at the feet) ----
export const HULL_MINS: Readonly<Vec3> = Object.freeze(v3(-16, -16, 0));
export const HULL_MAXS: Readonly<Vec3> = Object.freeze(v3(16, 16, 72));
export const DUCK_HULL_MINS: Readonly<Vec3> = Object.freeze(v3(-16, -16, 0));
export const DUCK_HULL_MAXS: Readonly<Vec3> = Object.freeze(v3(16, 16, 54));
export const VIEW_OFFSET_STAND = 64;
export const VIEW_OFFSET_DUCK = 46;

/** One tick of player input, as in Source's CUserCmd. */
export interface UserCmd {
  /** -450..450 (cl_forwardspeed). */
  forwardmove: number;
  /** -450..450 (cl_sidespeed), + = right. */
  sidemove: number;
  /** -320..320 (cl_upspeed), used by noclip/swimming. */
  upmove: number;
  buttons: number;
  viewangles: QAngle;
}

export function newUserCmd(): UserCmd {
  return { forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0, viewangles: qa() };
}

/** Movement convars. Defaults come from defaultMoveVars() (SurfTimer's CS:GO surf server config). */
export interface MoveVars {
  gravity: number; // sv_gravity 800
  accelerate: number; // sv_accelerate 10
  airaccelerate: number; // sv_airaccelerate 150
  friction: number; // sv_friction 5.2
  stopspeed: number; // sv_stopspeed 80
  /** Max ground wish speed (knife = 250). */
  maxspeed: number;
  maxvelocity: number; // sv_maxvelocity 3500
  airMaxWishspeed: number; // sv_air_max_wishspeed 30
  jumpImpulse: number; // sv_jump_impulse 301.993377
  stepsize: number; // sv_stepsize 18
  bounce: number; // sv_bounce 0
  autobhop: boolean; // sv_autobunnyhopping 1
  enableBunnyhopping: boolean; // sv_enablebunnyhopping 1
  wateraccelerate: number; // sv_wateraccelerate 10
  waterfriction: number; // sv_waterfriction 1
  noclipspeed: number; // sv_noclipspeed 5
  noclipaccelerate: number; // sv_noclipaccelerate 5
  /** Ground speed multiplier while ducked (CS:GO 0.34). */
  duckSpeedMultiplier: number;
  /** Ground speed multiplier while walking with +speed (CS:GO 0.52). */
  walkSpeedMultiplier: number;
  /** Seconds a full duck/unduck takes on the ground. */
  duckTime: number;
  /** sv_ladder_scale_speed etc. — speed on ladders. */
  ladderSpeed: number;
}

export interface PlayerState {
  origin: Vec3;
  velocity: Vec3;
  /** Velocity added by trigger_push / conveyors; see FL_BASEVELOCITY handling in the game loop. */
  baseVelocity: Vec3;
  /** View angles of the last command processed. */
  viewAngles: QAngle;
  /** Current eye height above origin (VIEW_OFFSET_STAND .. VIEW_OFFSET_DUCK, interpolated while ducking). */
  viewOffsetZ: number;
  moveType: MoveType;
  flags: number;
  /** Mirrors FL_ONGROUND. */
  onGround: boolean;
  /** Normal of the ground plane while on ground. */
  groundNormal: Vec3;
  /** Brush model index of the ground (0 = world), -1 when airborne. */
  groundModel: number;
  /** True when using the duck hull. */
  ducked: boolean;
  /** True while a duck/unduck transition is in progress. */
  ducking: boolean;
  /** 0 = standing, 1 = fully ducked (drives the view height). */
  duckAmount: number;
  /** 0 = out of water, 1 = feet, 2 = waist, 3 = eyes submerged. */
  waterLevel: number;
  waterType: number;
  waterJumpTime: number;
  waterJumpVel: Vec3;
  /** Source's m_surfaceFriction (1 normally, 0.25 when moving up off a steep plane). */
  surfaceFriction: number;
  /** Entity gravity multiplier (trigger_gravity / AddOutput gravity). 1 = normal. */
  gravityScale: number;
  /** player_speedmod / m_flLaggedMovementValue: scales the simulated frametime. */
  laggedMovement: number;
  /** If > 0 overrides MoveVars.maxspeed (e.g. weapon speed changes). */
  maxSpeedOverride: number;
  /** Buttons held during the previous command (for jump edge detection). */
  oldButtons: number;
  /** Downward speed while airborne (for landing sounds/punch). */
  fallVelocity: number;
  /** Seconds remaining in the current duck transition (internal to movement). */
  duckTimer: number;
}

export function createPlayerState(origin: Vec3 = v3(), angles: QAngle = qa()): PlayerState {
  return {
    origin: { ...origin },
    velocity: v3(),
    baseVelocity: v3(),
    viewAngles: { ...angles },
    viewOffsetZ: VIEW_OFFSET_STAND,
    moveType: MOVETYPE_WALK,
    flags: 0,
    onGround: false,
    groundNormal: v3(0, 0, 1),
    groundModel: -1,
    ducked: false,
    ducking: false,
    duckAmount: 0,
    waterLevel: 0,
    waterType: 0,
    waterJumpTime: 0,
    waterJumpVel: v3(),
    surfaceFriction: 1,
    gravityScale: 1,
    laggedMovement: 1,
    maxSpeedOverride: 0,
    oldButtons: 0,
    fallVelocity: 0,
    duckTimer: 0,
  };
}

/** Things that happened during one playerMove() call (for sounds, view effects, stats). */
export interface MoveEvents {
  jumped: boolean;
  landed: boolean;
  /** Fall speed (positive, u/s) when landed. */
  landSpeed: number;
  enteredWater: boolean;
  leftWater: boolean;
  /** Took a stair step (for footstep cadence). */
  stepped: boolean;
  /** Distance moved on the ground this tick (for footstep cadence). */
  groundDistance: number;
}

export function newMoveEvents(): MoveEvents {
  return { jumped: false, landed: false, landSpeed: 0, enteredWater: false, leftWater: false, stepped: false, groundDistance: 0 };
}

export function resetMoveEvents(e: MoveEvents): MoveEvents {
  e.jumped = false;
  e.landed = false;
  e.landSpeed = 0;
  e.enteredWater = false;
  e.leftWater = false;
  e.stepped = false;
  e.groundDistance = 0;
  return e;
}
