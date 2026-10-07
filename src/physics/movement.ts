// Player movement: a clean-room re-creation of Source's CGameMovement as configured on CS:GO surf
// servers (SurfTimer config: sv_airaccelerate 150, sv_accelerate 10, sv_friction 5.2, sv_stopspeed 80,
// sv_gravity 800, sv_maxvelocity 3500, sv_air_max_wishspeed 30, sv_jump_impulse 301.993377,
// sv_stepsize 18, sv_autobunnyhopping 1, stamina off, knife speed 250).
//
// Written from the publicly described behaviour of the Quake/Source player movement model; no engine
// code was used. Everything is float64 and allocation-free per tick (module-level scratch vectors).
//
// Source behaviours reproduced (each one is something players can feel or rely on):
//  - Split gravity: half of the tick's gravity before the move (StartGravity), half after
//    (FinishGravity), so falls/jumps integrate exactly; the jump tick applies one extra half step
//    (CheckJumpButton calls FinishGravity) - jump apex is therefore slightly tick-rate dependent
//    (54.65 @64, 55.50 @100, 55.83 @128 units) exactly like CS:GO.
//  - Ducked/ducking jumps SET vz = impulse, standing jumps ADD it to the (slightly negative) vz.
//  - Friction with sv_stopspeed "control" and the surfaceFriction multiplier; friction is applied
//    after the jump check, so holding jump (autobhop) on the first ground tick keeps all speed.
//  - Accelerate (ground) with CS:GO's weapon-speed acceleration scale (sv_accelerate_use_weapon_speed 1:
//    the gain per tick uses max(wishspeed, weapon speed) so walking/ducked acceleration is as snappy as
//    running), capped by addspeed.
//  - AirAccelerate: the projection cap is sv_air_max_wishspeed (30) but the per-tick gain uses the
//    UNCAPPED wishspeed (accel * wishspeed * ft * surfaceFriction) - the core of air strafing/surfing.
//  - TryPlayerMove: 4 bumps, 5 clip planes, primal/original velocity, single-plane reflect for
//    airborne walkers (sv_bounce), multi-plane clipping, crease sliding along two planes, the
//    "moving back against the primal velocity -> stop" rule, allFraction == 0 -> stop, and CS:GO's
//    unswept stuck check on full-fraction moves.
//  - ClipVelocity with the second "adjust" pass (no bounce into the plane, no residual penetration).
//  - WalkMove: horizontal-only wishvel from view yaw, direct move, else StepMove (down vs up+18 slide,
//    farther horizontal result wins, steep landing -> down result), then StayOnGround (2 up, 18 down,
//    snap if the delta exceeds half a coord unit).
//  - CategorizePosition: NON_JUMP_VELOCITY 140, 2-unit hull probe, walkable normal.z >= 0.7,
//    TryTouchGroundInQuadrants fallback, and the m_surfaceFriction = 0.25 quirk when airborne and
//    moving up (vz in (0, 140]) - quarter air acceleration near jump apexes and while sliding up ramps.
//  - CheckVelocity per-axis clamp to sv_maxvelocity (diagonal speeds above 3500 are possible) and NaN
//    scrubbing.
//  - Ramps steeper than normal.z 0.7 are never ground: the player "surfs" them, the into-ramp velocity
//    is clipped away every tick (no bounce with sv_bounce 0) and gravity accelerates the slide.
//  - CategorizePosition does not snap the player down to the ground it finds (2007+ engine): after a
//    vertical landing the player may rest up to 2 units above the floor until StayOnGround runs on the next
//    ground move. Walking down an exactly-18-unit drop is just out of StayOnGround's reach (needs 18 + eps).
//  - Ducking: ground transition over vars.duckTime (spline-eased view 64 -> 46); instant hull switch in
//    the air where CS:GO shrinks/grows the hull around its center (origin +-9; CS:S used 18) - crouch
//    jumping reaches 9 units higher (63 @64 / 64 @128 tick, Valve's CS:GO Mapper's Reference); the camera
//    keeps its height at the switch and eases the rest. Unducking only when the standing hull fits; ducked
//    ground speed crop 0.34, eased in with the duck amount during the transition (CS:GO).
//  - Base velocity (conveyors / trigger_push): vertical part is consumed by StartGravity as an
//    acceleration, horizontal part is added for the move and removed afterwards.
//  - Water (CheckWater levels feet/waist/eyes, WaterMove, swim up, sink, water jump), noclip
//    (FullNoClipMove with sv_noclipspeed/sv_noclipaccelerate) and func_ladder climbing (LadderMove).
//  - CheckStuck: a player starting a tick inside solid is nudged out (unstuckPlayer) before moving;
//    a failed search is retried every STUCK_RETRY_TICKS (a move leaving the brush in one trace escapes).
//  - laggedMovement (player_speedmod) scales the simulated frametime.
//
// Beyond vanilla (switchable via movementOptions): the rampbug fix surf servers run - TryPlayerMove never
// zeroes the velocity just because the hull is embedded by a precision hair; it steps out and keeps going.
//
// Surf facts that fall out of the above (and are covered by tests/movement.test.ts): holding the strafe
// key into a ramp holds the surfer's height (the 30 u/s push is clipped into a slow climb) and keeps all
// along-ramp speed; releasing slides down the ramp at g*sin(slope); pressing into the ramp while sliding
// down brakes the slide; synced air strafing grows |v|^2 by exactly 30^2 per tick (faster at 128 tick).
import { Vec3, v3 } from '../core/vec3';
import {
  DUCK_HULL_MAXS,
  DUCK_HULL_MINS,
  FL_DUCKING,
  FL_INWATER,
  FL_ONGROUND,
  FL_WATERJUMP,
  HULL_MAXS,
  HULL_MINS,
  IN_DUCK,
  IN_JUMP,
  IN_SPEED,
  MOVETYPE_LADDER,
  MOVETYPE_NOCLIP,
  MOVETYPE_OBSERVER,
  MOVETYPE_WALK,
  MoveEvents,
  MoveVars,
  PlayerState,
  UserCmd,
  VIEW_OFFSET_DUCK,
  VIEW_OFFSET_STAND,
  newMoveEvents,
  resetMoveEvents,
} from './playertypes';
import {
  CONTENTS_LADDER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  DIST_EPSILON,
  MASK_PLAYERSOLID,
  MASK_WATER,
  TraceResult,
  TraceWorld,
  newTrace,
} from './types';

// ------------------------------------------------------------------------------------------ constants

/** Vertical speed above which the player can never be on ground (a jump is ~294). */
const NON_JUMP_VELOCITY = 140;
/** CategorizePosition sets the player airborne & leaving the ground when vz exceeds this before the move. */
const LEAVE_GROUND_VELOCITY = 250;
/** Planes with normal.z below this are too steep to stand on (surf ramps). */
const MIN_WALK_NORMAL = 0.7;
const MAX_BUMPS = 4;
const MAX_CLIP_PLANES = 5;
/** How far below the feet CategorizePosition probes for ground. */
const GROUND_PROBE = 2;
/** StayOnGround only snaps when the delta exceeds half a network coord unit (1/32). */
const STAY_ON_GROUND_MIN_DELTA = 0.5 * (1 / 32);
/** Player's own knife speed: the ground wish speed cap (CS:GO weapon max speed). */
const KNIFE_SPEED = 250;
/** BUNNYJUMP_MAX_SPEED_FACTOR for sv_enablebunnyhopping 0. */
const BUNNYJUMP_MAX_SPEED_FACTOR = 1.1;
/** Height difference between the standing and ducked hulls (72 - 54). */
const DUCK_HULL_DELTA = HULL_MAXS.z - DUCK_HULL_MAXS.z;
/**
 * CS:GO ducks/unducks around the hull center in the air: the origin moves by half the hull difference (9).
 * (CS:S/Source 2007 moves it by the full 18.) Matches Valve's CS:GO Mapper's Reference: jump-then-crouch
 * reaches 63 units at 64 tick / 64 at 128 = the standing jump apex (54.65 / 55.83) + 9.
 */
const AIR_DUCK_SHIFT = DUCK_HULL_DELTA * 0.5;
/** surfaceFriction while airborne and moving up (Source CategorizePosition quirk). */
const RISING_SURFACE_FRICTION = 0.25;

// water
const WATER_CONTENTS = CONTENTS_WATER | CONTENTS_SLIME;
const WATER_SWIM_UP_SPEED = 100;
const SLIME_SWIM_UP_SPEED = 80;
const WATER_SINK_SPEED = 60;
const WATER_WISH_SCALE = 0.8;
const WATERJUMP_HEIGHT = 8;
const WATERJUMP_PUSH = 256;
const WATERJUMP_AWAY = 50;
/** Seconds a water jump lasts (Source: 2000 ms). */
const WATERJUMP_TIME = 2;

// ladders (CS:S func_ladder)
const LADDER_DISTANCE = 2;
const LADDER_JUMP_SPEED = 270;
const LADDER_MASK = MASK_PLAYERSOLID | CONTENTS_LADDER;
/** How far behind the player the overlapping-ladder probe starts. */
const LADDER_BACKTRACE = 48;

// ------------------------------------------------------------------------------------------ public api

/** SurfTimer's CS:GO surf server movement config. */
export function defaultMoveVars(): MoveVars {
  return {
    gravity: 800,
    accelerate: 10,
    airaccelerate: 150,
    friction: 5.2,
    stopspeed: 80,
    // sv_maxspeed. The player's own (knife) speed caps ground movement at 250 regardless; noclip uses
    // sv_maxspeed * sv_noclipspeed.
    maxspeed: 350,
    maxvelocity: 3500,
    airMaxWishspeed: 30,
    jumpImpulse: 301.993377,
    stepsize: 18,
    bounce: 0,
    autobhop: true,
    enableBunnyhopping: true,
    wateraccelerate: 10,
    waterfriction: 1,
    noclipspeed: 5,
    noclipaccelerate: 5,
    duckSpeedMultiplier: 0.34,
    walkSpeedMultiplier: 0.52,
    duckTime: 0.125,
    ladderSpeed: 200,
  };
}

const STAND_HULL: { mins: Vec3; maxs: Vec3 } = Object.freeze({ mins: HULL_MINS as Vec3, maxs: HULL_MAXS as Vec3 });
const DUCK_HULL: { mins: Vec3; maxs: Vec3 } = Object.freeze({ mins: DUCK_HULL_MINS as Vec3, maxs: DUCK_HULL_MAXS as Vec3 });

/** The collision hull for the player's current duck state (shared frozen objects - do not mutate). */
export function playerHull(ps: PlayerState): { mins: Vec3; maxs: Vec3 } {
  return ps.ducked ? DUCK_HULL : STAND_HULL;
}

// ------------------------------------------------------------------------------------------ scratch state
// playerMove is not re-entrant (no callbacks), so the per-call context and all temporaries live at module
// level: nothing is allocated per tick.

let W: TraceWorld;
let V: MoveVars;
let P: PlayerState;
let EV: MoveEvents;
/**
 * Per-call numeric state. Kept as fields of one object (initialized with non-integer values so V8 gives
 * them unboxed double representation) rather than module-level `let`s, which would box every double write.
 */
const M = {
  /** Effective frametime of this move (frametime * laggedMovement). */
  ft: 0.5,
  // CheckParameters results
  fmove: 0.5,
  smove: 0.5,
  umove: 0.5,
  /** mv->m_flMaxSpeed: player speed after the walk modifier. */
  maxspeed: 0.5,
  /** The player's own max speed (knife 250 / override), before walk/duck modifiers. */
  playerMaxspeed: 0.5,
  /**
   * Wish speed for accelerate/airAccelerate (doubles passed as arguments to or returned from non-inlined
   * functions are boxed by V8, so hot-path doubles travel through this object instead).
   */
  wishspeed: 0.5,
  /** Acceleration for accelerate(). */
  accel: 0.5,
  /** Overbounce for clipVelocity(). */
  overbounce: 0.5,
};

const dummyEvents = newMoveEvents();

// view vectors (roll ignored, like Source with sv_rollangle 0)
const FWD = v3();
const RIGHT = v3();

const trMove = newTrace();
const trAux = newTrace();
const trGround = newTrace();
const trQuad = newTrace();
const trTest = newTrace();

const wishvel = v3();
const wishdir = v3();
const endPos = v3();
const tmpPos = v3();
const primalVel = v3();
const originalVel = v3();
const newVel = v3();
const creaseDir = v3();
const clipPlanes: Vec3[] = [v3(), v3(), v3(), v3(), v3()];
const stepStartPos = v3();
const stepStartVel = v3();
const stepDownPos = v3();
const stepDownVel = v3();
const startOrigin = v3();
const quadMins = v3();
const quadMaxs = v3();
const ladderNormal = v3();
const ladderTmp = v3();
const ladderPerp = v3();
const ladderLateral = v3();

/** Ladder plane normal per player while on a ladder (Source m_vecLadderNormal). */
const ladderNormals = new WeakMap<PlayerState, Vec3>();

// ------------------------------------------------------------------------------------------ small helpers

function currentHull(): { mins: Vec3; maxs: Vec3 } {
  return P.ducked ? DUCK_HULL : STAND_HULL;
}

function tracePlayer(start: Vec3, end: Vec3, out: TraceResult): TraceResult {
  const h = P.ducked ? DUCK_HULL : STAND_HULL;
  return W.traceBox(start, end, h.mins, h.maxs, MASK_PLAYERSOLID, out);
}

/** Source's TestPlayerPosition: is the hull at `origin` inside (or touching) solid? */
function hullStuckAt(origin: Vec3, hull: { mins: Vec3; maxs: Vec3 }): boolean {
  const tr = W.traceBox(origin, origin, hull.mins, hull.maxs, MASK_PLAYERSOLID, trTest);
  return tr.startsolid || tr.allsolid || tr.fraction < 1;
}

function zeroVec(v: Vec3): void {
  v.x = 0;
  v.y = 0;
  v.z = 0;
}

function copyVec(out: Vec3, a: Vec3): void {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
}

/** Source AngleVectors (forward, right) for pitch/yaw with roll 0. */
function computeViewVectors(pitch: number, yaw: number): void {
  const p = ((Number.isFinite(pitch) ? pitch : 0) * Math.PI) / 180;
  const y = ((Number.isFinite(yaw) ? yaw : 0) * Math.PI) / 180;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sy = Math.sin(y);
  const cy = Math.cos(y);
  FWD.x = cp * cy;
  FWD.y = cp * sy;
  FWD.z = -sp;
  RIGHT.x = sy;
  RIGHT.y = -cy;
  RIGHT.z = 0;
}

/**
 * Horizontal wish velocity for walking/air moves: forward and right with z zeroed and renormalized,
 * combined with the move amounts, clamped to maxspeed. Fills wishvel/wishdir and M.wishspeed.
 */
function buildFlatWish(): void {
  let fx = FWD.x;
  let fy = FWD.y;
  let fl = Math.sqrt(fx * fx + fy * fy);
  if (fl > 0) {
    fx /= fl;
    fy /= fl;
  } else {
    fx = 0;
    fy = 0;
  }
  let rx = RIGHT.x;
  let ry = RIGHT.y;
  fl = Math.sqrt(rx * rx + ry * ry);
  if (fl > 0) {
    rx /= fl;
    ry /= fl;
  } else {
    rx = 0;
    ry = 0;
  }
  wishvel.x = fx * M.fmove + rx * M.smove;
  wishvel.y = fy * M.fmove + ry * M.smove;
  wishvel.z = 0;
  let wishspeed = Math.sqrt(wishvel.x * wishvel.x + wishvel.y * wishvel.y);
  if (wishspeed > 0) {
    wishdir.x = wishvel.x / wishspeed;
    wishdir.y = wishvel.y / wishspeed;
  } else {
    wishdir.x = 0;
    wishdir.y = 0;
  }
  wishdir.z = 0;
  if (wishspeed !== 0 && wishspeed > M.maxspeed) {
    const s = M.maxspeed / wishspeed;
    wishvel.x *= s;
    wishvel.y *= s;
    wishspeed = M.maxspeed;
  }
  M.wishspeed = wishspeed;
}

// ------------------------------------------------------------------------------------------ velocity

/** Per-axis clamp to sv_maxvelocity, NaN -> 0 (Source CheckVelocity). */
function checkVelocity(): void {
  const v = P.velocity;
  const max = V.maxvelocity;
  if (Number.isNaN(v.x)) v.x = 0;
  if (Number.isNaN(v.y)) v.y = 0;
  if (Number.isNaN(v.z)) v.z = 0;
  if (v.x > max) v.x = max;
  else if (v.x < -max) v.x = -max;
  if (v.y > max) v.y = max;
  else if (v.y < -max) v.y = -max;
  if (v.z > max) v.z = max;
  else if (v.z < -max) v.z = -max;
}

function gravityScale(): number {
  const g = P.gravityScale;
  return g && Number.isFinite(g) ? g : 1;
}

function startGravity(): void {
  const v = P.velocity;
  v.z -= gravityScale() * V.gravity * 0.5 * M.ft;
  v.z += P.baseVelocity.z * M.ft;
  P.baseVelocity.z = 0;
  checkVelocity();
}

function finishGravity(): void {
  if (P.waterJumpTime > 0) return;
  P.velocity.z -= gravityScale() * V.gravity * 0.5 * M.ft;
  checkVelocity();
}

/** out = in clipped against the plane with overbounce M.overbounce (1 = slide); in and out may alias. */
function clipVelocity(inv: Vec3, n: Vec3, out: Vec3): void {
  const backoff = (inv.x * n.x + inv.y * n.y + inv.z * n.z) * M.overbounce;
  let ox = inv.x - n.x * backoff;
  let oy = inv.y - n.y * backoff;
  let oz = inv.z - n.z * backoff;
  // second pass: never leave a component moving into the plane
  const adjust = ox * n.x + oy * n.y + oz * n.z;
  if (adjust < 0) {
    ox -= n.x * adjust;
    oy -= n.y * adjust;
    oz -= n.z * adjust;
  }
  out.x = ox;
  out.y = oy;
  out.z = oz;
}

function friction(): void {
  if (P.waterJumpTime > 0) return;
  const v = P.velocity;
  const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (speed < 0.1) return;
  let drop = 0;
  if (P.onGround) {
    const fric = V.friction * P.surfaceFriction;
    const control = speed < V.stopspeed ? V.stopspeed : speed;
    drop += control * fric * M.ft;
  }
  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  if (newspeed !== speed) {
    const s = newspeed / speed;
    v.x *= s;
    v.y *= s;
    v.z *= s;
  }
}

/**
 * Ground/noclip acceleration. CS:GO scales the per-tick gain by the weapon speed (knife 250) rather
 * than the (walk/duck reduced) wish speed: sv_accelerate_use_weapon_speed 1.
 */
function accelerate(dir: Vec3): void {
  const wishspeed = M.wishspeed;
  const accel = M.accel;
  const v = P.velocity;
  const current = v.x * dir.x + v.y * dir.y + v.z * dir.z;
  const addspeed = wishspeed - current;
  if (addspeed <= 0) return;
  const scale = wishspeed > M.playerMaxspeed ? wishspeed : M.playerMaxspeed;
  let accelspeed = accel * M.ft * scale * P.surfaceFriction;
  if (accelspeed > addspeed) accelspeed = addspeed;
  v.x += accelspeed * dir.x;
  v.y += accelspeed * dir.y;
  v.z += accelspeed * dir.z;
}

/** Source AirAccelerate: projection capped at sv_air_max_wishspeed, gain uses the uncapped wishspeed. */
function airAccelerate(dir: Vec3): void {
  if (P.waterJumpTime > 0) return;
  const wishspeed = M.wishspeed;
  const accel = V.airaccelerate;
  const cap = V.airMaxWishspeed;
  const wishspd = wishspeed > cap ? cap : wishspeed;
  const v = P.velocity;
  const current = v.x * dir.x + v.y * dir.y + v.z * dir.z;
  const addspeed = wishspd - current;
  if (addspeed <= 0) return;
  let accelspeed = accel * wishspeed * M.ft * P.surfaceFriction;
  if (accelspeed > addspeed) accelspeed = addspeed;
  v.x += accelspeed * dir.x;
  v.y += accelspeed * dir.y;
  v.z += accelspeed * dir.z;
}

function addBaseVelocity(sign: number): void {
  const v = P.velocity;
  const b = P.baseVelocity;
  v.x += b.x * sign;
  v.y += b.y * sign;
  v.z += b.z * sign;
}

// ------------------------------------------------------------------------------------------ sliding

/** Behaviour switches beyond vanilla CS:GO, exported so the game can expose them as server cvars. */
export const movementOptions = {
  /**
   * Rampbug fix (what CS:GO surf servers run as plugins): when vanilla TryPlayerMove would zero the
   * velocity because the hull is embedded in a surface by a precision hair (allsolid sweep, or the CS:GO
   * stuck guard), step out to the nearest free spot within half a unit and keep the velocity instead.
   * Has no effect on any move vanilla handles without killing the velocity.
   */
  rampbugFix: true,
};

const NUDGE_STEPS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2];
/** +z first (floors/ramps are what players slide on), then the horizontal axes, then down. */
const NUDGE_DIRS = [0, 0, 1, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, -1];
const lastNormal = v3();
const nudgePos = v3();
const nudgeTest = v3();

/**
 * Moves `pos` to the nearest free hull position within half a unit: along the last clip plane's normal
 * first, then the axes. Returns false (pos untouched) if there is none.
 */
function nudgeFree(pos: Vec3, hull: { mins: Vec3; maxs: Vec3 }, useNormal: boolean): boolean {
  for (let s = 0; s < NUDGE_STEPS.length; s++) {
    const step = NUDGE_STEPS[s];
    if (useNormal) {
      nudgeTest.x = pos.x + lastNormal.x * step;
      nudgeTest.y = pos.y + lastNormal.y * step;
      nudgeTest.z = pos.z + lastNormal.z * step;
      if (!hullStuckAt(nudgeTest, hull)) {
        copyVec(pos, nudgeTest);
        return true;
      }
    }
    for (let d = 0; d < NUDGE_DIRS.length; d += 3) {
      nudgeTest.x = pos.x + NUDGE_DIRS[d] * step;
      nudgeTest.y = pos.y + NUDGE_DIRS[d + 1] * step;
      nudgeTest.z = pos.z + NUDGE_DIRS[d + 2] * step;
      if (!hullStuckAt(nudgeTest, hull)) {
        copyVec(pos, nudgeTest);
        return true;
      }
    }
  }
  return false;
}

/**
 * Source TryPlayerMove: moves the player by velocity * frametime, sliding along everything it hits.
 * Returns the "blocked" flags (1 = floor, 2 = wall/step, 4 = trapped).
 */
function tryPlayerMove(): number {
  const vel = P.velocity;
  const org = P.origin;
  const hull = currentHull();
  let blocked = 0;
  let numplanes = 0;
  let allFraction = 0;
  let timeLeft = M.ft;
  let haveLastNormal = false;
  copyVec(originalVel, vel);
  copyVec(primalVel, vel);

  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    if (vel.x === 0 && vel.y === 0 && vel.z === 0) break;
    endPos.x = org.x + vel.x * timeLeft;
    endPos.y = org.y + vel.y * timeLeft;
    endPos.z = org.z + vel.z * timeLeft;
    const tr = W.traceBox(org, endPos, hull.mins, hull.maxs, MASK_PLAYERSOLID, trMove);
    allFraction += tr.fraction;
    if (tr.allsolid) {
      // Trapped in solid: Source zeroes the velocity here. When the hull is merely embedded by a hair
      // (sub-epsilon precision error), that is the classic surf "rampbug"; like the rampbug fixes surf
      // servers run, step out to the nearest free spot and keep sliding with the velocity intact.
      if (movementOptions.rampbugFix && nudgeFree(org, hull, haveLastNormal)) continue;
      zeroVec(vel);
      return 4;
    }
    if (tr.fraction > 0) {
      if (tr.fraction === 1) {
        // CS:GO precision guard: a full sweep whose end box is nevertheless in solid is not taken.
        const st = W.traceBox(tr.endpos, tr.endpos, hull.mins, hull.maxs, MASK_PLAYERSOLID, trTest);
        if (st.startsolid || st.allsolid || st.fraction !== 1) {
          copyVec(nudgePos, tr.endpos);
          if (movementOptions.rampbugFix && nudgeFree(nudgePos, hull, haveLastNormal)) {
            copyVec(org, nudgePos);
            break;
          }
          zeroVec(vel);
          break;
        }
      }
      copyVec(org, tr.endpos);
      copyVec(originalVel, vel);
      numplanes = 0;
    }
    if (tr.fraction === 1) break;

    const n = tr.plane.normal;
    if (n.z > MIN_WALK_NORMAL) blocked |= 1;
    if (n.z === 0) blocked |= 2;
    timeLeft -= timeLeft * tr.fraction;

    if (numplanes >= MAX_CLIP_PLANES) {
      zeroVec(vel);
      break;
    }
    copyVec(clipPlanes[numplanes], n);
    numplanes++;
    copyVec(lastNormal, n);
    haveLastNormal = true;

    if (numplanes === 1 && P.moveType === MOVETYPE_WALK && !P.onGround) {
      // airborne, first impact: reflect/slide off this one plane only
      const p0 = clipPlanes[0];
      M.overbounce = p0.z > MIN_WALK_NORMAL ? 1 : 1 + V.bounce * (1 - P.surfaceFriction);
      clipVelocity(originalVel, p0, newVel);
      copyVec(vel, newVel);
      copyVec(originalVel, newVel);
    } else {
      let i = 0;
      for (; i < numplanes; i++) {
        M.overbounce = 1;
        clipVelocity(originalVel, clipPlanes[i], vel);
        let j = 0;
        for (; j < numplanes; j++) {
          if (j !== i) {
            const pj = clipPlanes[j];
            if (vel.x * pj.x + vel.y * pj.y + vel.z * pj.z < 0) break; // still moving into plane j
          }
        }
        if (j === numplanes) break; // this clip satisfies every plane
      }
      if (i === numplanes) {
        // no single plane works: slide along the crease of exactly two planes, else stop
        if (numplanes !== 2) {
          zeroVec(vel);
          break;
        }
        const a = clipPlanes[0];
        const b = clipPlanes[1];
        creaseDir.x = a.y * b.z - a.z * b.y;
        creaseDir.y = a.z * b.x - a.x * b.z;
        creaseDir.z = a.x * b.y - a.y * b.x;
        const cl = Math.sqrt(creaseDir.x * creaseDir.x + creaseDir.y * creaseDir.y + creaseDir.z * creaseDir.z);
        if (cl > 0) {
          creaseDir.x /= cl;
          creaseDir.y /= cl;
          creaseDir.z /= cl;
        }
        const d = creaseDir.x * vel.x + creaseDir.y * vel.y + creaseDir.z * vel.z;
        vel.x = creaseDir.x * d;
        vel.y = creaseDir.y * d;
        vel.z = creaseDir.z * d;
      }
      // turned back against the original direction: stop dead (avoids oscillation in sloped corners)
      if (vel.x * primalVel.x + vel.y * primalVel.y + vel.z * primalVel.z <= 0) {
        zeroVec(vel);
        break;
      }
    }
  }
  if (allFraction === 0) zeroVec(vel);
  return blocked;
}

/** Source StepMove: compare sliding at ground level with sliding after stepping up stepsize. */
function stepMove(): void {
  const org = P.origin;
  const vel = P.velocity;
  copyVec(stepStartPos, org);
  copyVec(stepStartVel, vel);

  // slide move at the current height
  tryPlayerMove();
  copyVec(stepDownPos, org);
  copyVec(stepDownVel, vel);

  // reset, then move up a stair height
  copyVec(org, stepStartPos);
  copyVec(vel, stepStartVel);
  copyVec(tmpPos, org);
  tmpPos.z += V.stepsize + DIST_EPSILON;
  let tr = tracePlayer(org, tmpPos, trAux);
  if (!tr.startsolid && !tr.allsolid) copyVec(org, tr.endpos);

  // slide move up there
  tryPlayerMove();

  // and back down
  copyVec(tmpPos, org);
  tmpPos.z -= V.stepsize + DIST_EPSILON;
  tr = tracePlayer(org, tmpPos, trAux);

  // not on walkable ground up there: use the original attempt
  if (tr.fraction === 1 || tr.allsolid || tr.plane.normal.z < MIN_WALK_NORMAL) {
    copyVec(org, stepDownPos);
    copyVec(vel, stepDownVel);
    if (org.z - stepStartPos.z > 0.05) EV.stepped = true;
    return;
  }
  if (!tr.startsolid && !tr.allsolid) copyVec(org, tr.endpos);

  // which one went farther horizontally?
  const ddx = stepDownPos.x - stepStartPos.x;
  const ddy = stepDownPos.y - stepStartPos.y;
  const udx = org.x - stepStartPos.x;
  const udy = org.y - stepStartPos.y;
  if (ddx * ddx + ddy * ddy > udx * udx + udy * udy) {
    copyVec(org, stepDownPos);
    copyVec(vel, stepDownVel);
  } else {
    // stepped: keep the slide move's vertical velocity
    vel.z = stepDownVel.z;
  }
  if (org.z - stepStartPos.z > 0.05) EV.stepped = true;
}

/** Source StayOnGround: keep the player glued to slopes/stairs going down while walking. */
function stayOnGround(): void {
  const org = P.origin;
  copyVec(tmpPos, org);
  tmpPos.z += 2;
  // how far up can we go without getting stuck
  let tr = tracePlayer(org, tmpPos, trAux);
  copyVec(endPos, tr.endpos);
  // trace down from that known safe position
  copyVec(tmpPos, org);
  tmpPos.z -= V.stepsize;
  tr = tracePlayer(endPos, tmpPos, trAux);
  if (tr.fraction > 0 && tr.fraction < 1 && !tr.startsolid && tr.plane.normal.z >= MIN_WALK_NORMAL) {
    const delta = Math.abs(org.z - tr.endpos.z);
    if (delta > STAY_ON_GROUND_MIN_DELTA) copyVec(org, tr.endpos);
  }
}

// ------------------------------------------------------------------------------------------ ground

function setGround(tr: TraceResult | null): void {
  const was = P.onGround;
  if (tr) {
    if (!was) {
      // landing: the static world has no velocity to subtract (Source zeroes basevelocity.z here)
      P.baseVelocity.z = 0;
      EV.landed = true;
      EV.landSpeed = P.fallVelocity > 0 ? P.fallVelocity : 0;
    }
    P.onGround = true;
    P.flags |= FL_ONGROUND;
    copyVec(P.groundNormal, tr.plane.normal);
    P.groundModel = tr.model >= 0 ? tr.model : 0;
    // standing on something ends any water jump
    P.waterJumpTime = 0;
    P.flags &= ~FL_WATERJUMP;
    P.velocity.z = 0;
  } else {
    if (was) P.baseVelocity.z = 0;
    P.onGround = false;
    P.flags &= ~FL_ONGROUND;
    P.groundModel = -1;
  }
}

function isGroundHit(tr: TraceResult): boolean {
  return tr.fraction < 1 && !tr.allsolid && tr.plane.normal.z >= MIN_WALK_NORMAL;
}

/** Source TryTouchGroundInQuadrants: probe four quarter-footprint boxes; returns the hit or null. */
function touchGroundInQuadrants(origin: Vec3, point: Vec3): TraceResult | null {
  const h = currentHull();
  const mn = h.mins;
  const mx = h.maxs;
  for (let q = 0; q < 4; q++) {
    switch (q) {
      case 0: // -x -y
        quadMins.x = mn.x;
        quadMins.y = mn.y;
        quadMaxs.x = Math.min(0, mx.x);
        quadMaxs.y = Math.min(0, mx.y);
        break;
      case 1: // +x +y
        quadMins.x = Math.max(0, mn.x);
        quadMins.y = Math.max(0, mn.y);
        quadMaxs.x = mx.x;
        quadMaxs.y = mx.y;
        break;
      case 2: // -x +y
        quadMins.x = mn.x;
        quadMins.y = Math.max(0, mn.y);
        quadMaxs.x = Math.min(0, mx.x);
        quadMaxs.y = mx.y;
        break;
      default: // +x -y
        quadMins.x = Math.max(0, mn.x);
        quadMins.y = mn.y;
        quadMaxs.x = mx.x;
        quadMaxs.y = Math.min(0, mx.y);
        break;
    }
    quadMins.z = mn.z;
    quadMaxs.z = mx.z;
    const tr = W.traceBox(origin, point, quadMins, quadMaxs, MASK_PLAYERSOLID, trQuad);
    if (isGroundHit(tr)) return tr;
  }
  return null;
}

/** Source CategorizePosition: water level, ground entity and surface friction. */
function categorizeInternal(): void {
  P.surfaceFriction = 1;
  checkWater();
  if (P.moveType === MOVETYPE_NOCLIP || P.moveType === MOVETYPE_OBSERVER) {
    setGround(null);
    return;
  }
  const zvel = P.velocity.z;
  if (zvel > NON_JUMP_VELOCITY || (zvel > 0 && P.moveType === MOVETYPE_LADDER)) {
    setGround(null);
    return;
  }
  const org = P.origin;
  tmpPos.x = org.x;
  tmpPos.y = org.y;
  tmpPos.z = org.z - GROUND_PROBE;
  let ground: TraceResult | null = tracePlayer(org, tmpPos, trGround);
  if (!isGroundHit(ground)) {
    ground = touchGroundInQuadrants(org, tmpPos);
    if (!ground) {
      setGround(null);
      // moving up while not on ground (rising past a jump apex, sliding up a ramp): quarter friction,
      // which quarters air acceleration until the next categorization.
      if (P.velocity.z > 0) P.surfaceFriction = RISING_SURFACE_FRICTION;
      return;
    }
  }
  setGround(ground);
}

function checkFalling(): void {
  if (!P.onGround || P.fallVelocity <= 0) return;
  P.fallVelocity = 0;
}

// ------------------------------------------------------------------------------------------ water

const waterPoint = v3();

/** Source CheckWater: water level from point contents at feet, waist and eyes. True when >= waist. */
function checkWater(): boolean {
  const h = currentHull();
  const org = P.origin;
  waterPoint.x = org.x + (h.mins.x + h.maxs.x) * 0.5;
  waterPoint.y = org.y + (h.mins.y + h.maxs.y) * 0.5;
  waterPoint.z = org.z + h.mins.z + 1;
  P.waterLevel = 0;
  P.waterType = 0;
  let cont = W.pointContents(waterPoint, MASK_WATER) & WATER_CONTENTS;
  if (cont) {
    P.waterType = cont;
    P.waterLevel = 1;
    waterPoint.z = org.z + (h.mins.z + h.maxs.z) * 0.5;
    cont = W.pointContents(waterPoint, MASK_WATER) & WATER_CONTENTS;
    if (cont) {
      P.waterLevel = 2;
      waterPoint.z = org.z + P.viewOffsetZ;
      cont = W.pointContents(waterPoint, MASK_WATER) & WATER_CONTENTS;
      if (cont) P.waterLevel = 3;
    }
  }
  if (P.waterLevel > 0) P.flags |= FL_INWATER;
  else P.flags &= ~FL_INWATER;
  return P.waterLevel > 1;
}

/** Source CheckWaterJump: pop out of the water over a ledge in front of the player. */
function checkWaterJump(): void {
  if (P.waterJumpTime > 0) return;
  const vel = P.velocity;
  if (vel.z < -180) return; // just jumped in
  let fx = FWD.x;
  let fy = FWD.y;
  const fl = Math.sqrt(fx * fx + fy * fy);
  if (fl === 0) return;
  fx /= fl;
  fy /= fl;
  const hs = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
  if (hs !== 0 && (vel.x * fx + vel.y * fy) / hs < 0) return; // backing up
  const h = currentHull();
  const org = P.origin;
  // waist-height probe (Source traces the hull from the hull center here)
  tmpPos.x = org.x + (h.mins.x + h.maxs.x) * 0.5;
  tmpPos.y = org.y + (h.mins.y + h.maxs.y) * 0.5;
  tmpPos.z = org.z + (h.mins.z + h.maxs.z) * 0.5;
  endPos.x = tmpPos.x + fx * 24;
  endPos.y = tmpPos.y + fy * 24;
  endPos.z = tmpPos.z;
  let tr = tracePlayer(tmpPos, endPos, trAux);
  if (tr.fraction >= 1) return;
  const nx = tr.plane.normal.x;
  const ny = tr.plane.normal.y;
  const nz = tr.plane.normal.z;
  // open at eye level?
  tmpPos.z = org.z + P.viewOffsetZ + WATERJUMP_HEIGHT;
  endPos.x = tmpPos.x + fx * 24;
  endPos.y = tmpPos.y + fy * 24;
  endPos.z = tmpPos.z;
  tr = tracePlayer(tmpPos, endPos, trAux);
  if (tr.fraction !== 1) return;
  // would we land on something standable?
  copyVec(tmpPos, endPos);
  endPos.z -= 1024;
  tr = tracePlayer(tmpPos, endPos, trAux);
  if (tr.fraction < 1 && tr.plane.normal.z >= MIN_WALK_NORMAL) {
    P.waterJumpVel.x = -nx * WATERJUMP_AWAY;
    P.waterJumpVel.y = -ny * WATERJUMP_AWAY;
    P.waterJumpVel.z = -nz * WATERJUMP_AWAY;
    vel.z = WATERJUMP_PUSH;
    P.oldButtons |= IN_JUMP;
    P.flags |= FL_WATERJUMP;
    P.waterJumpTime = WATERJUMP_TIME;
  }
}

function waterJump(): void {
  if (P.waterJumpTime > 10) P.waterJumpTime = 10;
  if (!(P.waterJumpTime > 0)) return;
  P.waterJumpTime -= M.ft;
  if (P.waterJumpTime <= 0 || P.waterLevel === 0) {
    P.waterJumpTime = 0;
    P.flags &= ~FL_WATERJUMP;
  }
  P.velocity.x = P.waterJumpVel.x;
  P.velocity.y = P.waterJumpVel.y;
}

/** Source WaterMove: 3D swimming with water friction and acceleration. */
function waterMove(cmd: UserCmd): void {
  const vel = P.velocity;
  wishvel.x = FWD.x * M.fmove + RIGHT.x * M.smove;
  wishvel.y = FWD.y * M.fmove + RIGHT.y * M.smove;
  wishvel.z = FWD.z * M.fmove + RIGHT.z * M.smove;
  if (cmd.buttons & IN_JUMP) {
    wishvel.z += M.playerMaxspeed; // swim straight up
  } else if (!M.fmove && !M.smove && !M.umove) {
    wishvel.z -= WATER_SINK_SPEED; // drift towards the bottom
  } else {
    // exaggerate upward movement along forward as well
    let up = M.fmove * FWD.z * 2;
    if (up < 0) up = 0;
    else if (up > M.playerMaxspeed) up = M.playerMaxspeed;
    wishvel.z += M.umove + up;
  }
  let wishspeed = Math.sqrt(wishvel.x * wishvel.x + wishvel.y * wishvel.y + wishvel.z * wishvel.z);
  if (wishspeed > 0) {
    wishdir.x = wishvel.x / wishspeed;
    wishdir.y = wishvel.y / wishspeed;
    wishdir.z = wishvel.z / wishspeed;
  } else zeroVec(wishdir);
  if (wishspeed > M.maxspeed) wishspeed = M.maxspeed;
  wishspeed *= WATER_WISH_SCALE;

  // water friction
  const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  let newspeed = 0;
  if (speed > 0) {
    newspeed = speed - M.ft * speed * V.waterfriction * P.surfaceFriction;
    if (newspeed < 0.1) newspeed = 0;
    const s = newspeed / speed;
    vel.x *= s;
    vel.y *= s;
    vel.z *= s;
  }
  // water acceleration
  if (wishspeed >= 0.1) {
    const addspeed = wishspeed - newspeed;
    if (addspeed > 0) {
      let accelspeed = V.wateraccelerate * wishspeed * M.ft * P.surfaceFriction;
      if (accelspeed > addspeed) accelspeed = addspeed;
      vel.x += accelspeed * wishdir.x;
      vel.y += accelspeed * wishdir.y;
      vel.z += accelspeed * wishdir.z;
    }
  }

  addBaseVelocity(1);
  const org = P.origin;
  tmpPos.x = org.x + vel.x * M.ft;
  tmpPos.y = org.y + vel.y * M.ft;
  tmpPos.z = org.z + vel.z * M.ft;
  const tr = tracePlayer(org, tmpPos, trAux);
  if (tr.fraction === 1) {
    copyVec(org, tr.endpos);
  } else if (!P.onGround) {
    tryPlayerMove();
  } else {
    stepMove();
  }
  addBaseVelocity(-1);
}

// ------------------------------------------------------------------------------------------ jumping

function preventBunnyJumping(): void {
  const cap = BUNNYJUMP_MAX_SPEED_FACTOR * M.playerMaxspeed;
  if (cap <= 0) return;
  const v = P.velocity;
  const spd = Math.sqrt(v.x * v.x + v.y * v.y);
  if (spd <= cap) return;
  const f = cap / spd;
  v.x *= f;
  v.y *= f;
}

/** Source/CS:GO CheckJumpButton. Returns true when a jump happened. */
function checkJumpButton(): boolean {
  if (P.waterJumpTime > 0) {
    P.waterJumpTime -= M.ft;
    if (P.waterJumpTime < 0) P.waterJumpTime = 0;
    return false;
  }
  if (P.waterLevel >= 2) {
    // swimming, not jumping
    setGround(null);
    if (P.waterType & CONTENTS_WATER) P.velocity.z = WATER_SWIM_UP_SPEED;
    else if (P.waterType & CONTENTS_SLIME) P.velocity.z = SLIME_SWIM_UP_SPEED;
    return false;
  }
  if (!P.onGround) {
    P.oldButtons |= IN_JUMP;
    return false;
  }
  // don't pogo stick (unless sv_autobunnyhopping)
  if ((P.oldButtons & IN_JUMP) !== 0 && !V.autobhop) return false;
  if (!V.enableBunnyhopping) preventBunnyJumping();

  setGround(null);
  const impulse = V.jumpImpulse;
  if (P.ducking || (P.flags & FL_DUCKING) !== 0) P.velocity.z = impulse;
  else P.velocity.z += impulse;
  // Source applies the rest of this tick's gravity right here
  finishGravity();
  P.oldButtons |= IN_JUMP;
  EV.jumped = true;
  return true;
}

// ------------------------------------------------------------------------------------------ walking

function walkMove(): void {
  const vel = P.velocity;
  const org = P.origin;
  buildFlatWish();

  vel.z = 0;
  M.accel = V.accelerate;
  accelerate(wishdir);
  vel.z = 0;

  addBaseVelocity(1);
  const spd = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  if (spd < 1) {
    zeroVec(vel);
    addBaseVelocity(-1);
    return;
  }
  const sx = org.x;
  const sy = org.y;

  // first try moving straight to the destination at the current height
  tmpPos.x = org.x + vel.x * M.ft;
  tmpPos.y = org.y + vel.y * M.ft;
  tmpPos.z = org.z;
  const tr = tracePlayer(org, tmpPos, trAux);
  if (tr.fraction === 1) {
    copyVec(org, tr.endpos);
    addBaseVelocity(-1);
    stayOnGround();
  } else if (P.waterJumpTime > 0) {
    addBaseVelocity(-1);
  } else {
    stepMove();
    addBaseVelocity(-1);
    stayOnGround();
  }
  const dx = org.x - sx;
  const dy = org.y - sy;
  EV.groundDistance += Math.sqrt(dx * dx + dy * dy);
}

function airMove(): void {
  buildFlatWish();
  airAccelerate(wishdir);
  addBaseVelocity(1);
  tryPlayerMove();
  addBaseVelocity(-1);
}

function fullWalkMove(cmd: UserCmd): void {
  if (!checkWater()) startGravity();

  // leaping out of the water: just update the counters
  if (P.waterJumpTime > 0) {
    waterJump();
    tryPlayerMove();
    checkWater();
    return;
  }

  if (P.waterLevel >= 2) {
    if (P.waterLevel === 2) checkWaterJump();
    // falling again: not trying to jump out any more
    if (P.velocity.z < 0 && P.waterJumpTime > 0) P.waterJumpTime = 0;
    if (cmd.buttons & IN_JUMP) checkJumpButton();
    else P.oldButtons &= ~IN_JUMP;
    waterMove(cmd);
    categorizeInternal();
    if (P.onGround) P.velocity.z = 0;
    return;
  }

  if (cmd.buttons & IN_JUMP) checkJumpButton();
  else P.oldButtons &= ~IN_JUMP;

  // friction before base velocity, so conveyors don't slow a player standing still on them
  if (P.onGround) {
    P.velocity.z = 0;
    friction();
  }
  checkVelocity();

  if (P.onGround) walkMove();
  else airMove();

  categorizeInternal();
  checkVelocity();
  if (!checkWater()) finishGravity();
  if (P.onGround) P.velocity.z = 0;
  checkFalling();
}

// ------------------------------------------------------------------------------------------ noclip

function fullNoClipMove(cmd: UserCmd): void {
  const vel = P.velocity;
  const org = P.origin;
  const svMaxspeed = V.maxspeed > 0 ? V.maxspeed : KNIFE_SPEED;
  const maxspd = svMaxspeed * V.noclipspeed;
  let factor = V.noclipspeed;
  if (cmd.buttons & IN_SPEED) factor /= 2;
  const fm = M.fmove * factor;
  const sm = M.smove * factor;
  wishvel.x = FWD.x * fm + RIGHT.x * sm;
  wishvel.y = FWD.y * fm + RIGHT.y * sm;
  wishvel.z = FWD.z * fm + RIGHT.z * sm + M.umove * factor;
  let wishspeed = Math.sqrt(wishvel.x * wishvel.x + wishvel.y * wishvel.y + wishvel.z * wishvel.z);
  if (wishspeed > 0) {
    wishdir.x = wishvel.x / wishspeed;
    wishdir.y = wishvel.y / wishspeed;
    wishdir.z = wishvel.z / wishspeed;
  } else zeroVec(wishdir);
  if (wishspeed > maxspd) {
    const s = maxspd / wishspeed;
    wishvel.x *= s;
    wishvel.y *= s;
    wishvel.z *= s;
    wishspeed = maxspd;
  }
  P.surfaceFriction = 1;
  if (V.noclipaccelerate > 0) {
    M.wishspeed = wishspeed;
    M.accel = V.noclipaccelerate;
    accelerate(wishdir);
    const spd = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    if (spd < 1) {
      zeroVec(vel);
      return;
    }
    // bleed off speed (friction-like), at least a quarter of max speed worth
    const control = spd < maxspd / 4 ? maxspd / 4 : spd;
    const drop = control * V.friction * P.surfaceFriction * M.ft;
    let newspeed = spd - drop;
    if (newspeed < 0) newspeed = 0;
    const s = newspeed / spd;
    vel.x *= s;
    vel.y *= s;
    vel.z *= s;
  } else {
    copyVec(vel, wishvel);
  }
  checkVelocity();
  // just move: no collision at all
  org.x += vel.x * M.ft;
  org.y += vel.y * M.ft;
  org.z += vel.z * M.ft;
  if (V.noclipaccelerate < 0) zeroVec(vel);
}

// ------------------------------------------------------------------------------------------ ladders

/** Source LadderMove (func_ladder brushes with CONTENTS_LADDER). True while on a ladder. */
function ladderMove(cmd: UserCmd): boolean {
  if (P.moveType === MOVETYPE_NOCLIP || P.moveType === MOVETYPE_OBSERVER) return false;
  const stored = ladderNormals.get(P);
  const org = P.origin;
  if (P.moveType === MOVETYPE_LADDER && stored) {
    wishdir.x = -stored.x;
    wishdir.y = -stored.y;
    wishdir.z = -stored.z;
  } else if (M.fmove || M.smove) {
    wishdir.x = FWD.x * M.fmove + RIGHT.x * M.smove;
    wishdir.y = FWD.y * M.fmove + RIGHT.y * M.smove;
    wishdir.z = FWD.z * M.fmove + RIGHT.z * M.smove;
    const l = Math.sqrt(wishdir.x * wishdir.x + wishdir.y * wishdir.y + wishdir.z * wishdir.z);
    if (l === 0) return false;
    wishdir.x /= l;
    wishdir.y /= l;
    wishdir.z /= l;
  } else {
    return false; // not trying to move: no ladder behaviour
  }

  endPos.x = org.x + wishdir.x * LADDER_DISTANCE;
  endPos.y = org.y + wishdir.y * LADDER_DISTANCE;
  endPos.z = org.z + wishdir.z * LADDER_DISTANCE;
  const h = currentHull();
  let tr = W.traceBox(org, endPos, h.mins, h.maxs, LADDER_MASK, trAux);
  // (an allsolid result inside a ladder slab has no plane: not a usable hit)
  if (tr.fraction < 1 && !tr.allsolid && (tr.contents & CONTENTS_LADDER) !== 0 && tr.plane.normal.x * tr.plane.normal.x + tr.plane.normal.y * tr.plane.normal.y + tr.plane.normal.z * tr.plane.normal.z > 0.5) {
    copyVec(ladderNormal, tr.plane.normal);
  } else {
    // Ladder volumes are not player-solid, so the hull may already overlap one (the trace above then
    // starts inside it and ignores it). Find its face by sweeping toward it from behind the player.
    const overlap = W.traceBox(org, org, h.mins, h.maxs, CONTENTS_LADDER, trTest);
    if (!overlap.startsolid && !overlap.allsolid) return false;
    tmpPos.x = org.x - wishdir.x * LADDER_BACKTRACE;
    tmpPos.y = org.y - wishdir.y * LADDER_BACKTRACE;
    tmpPos.z = org.z - wishdir.z * LADDER_BACKTRACE;
    tr = W.traceBox(tmpPos, endPos, h.mins, h.maxs, CONTENTS_LADDER, trAux);
    const tn = tr.plane.normal;
    if (
      tr.fraction < 1 &&
      !tr.startsolid &&
      (tr.contents & CONTENTS_LADDER) !== 0 &&
      tn.x * wishdir.x + tn.y * wishdir.y + tn.z * wishdir.z < 0
    ) {
      copyVec(ladderNormal, tn);
    } else if (P.moveType === MOVETYPE_LADDER && stored) {
      // still inside the ladder volume: keep climbing with the known plane
      tmpPos.x = org.x + (h.mins.x + h.maxs.x) * 0.5;
      tmpPos.y = org.y + (h.mins.y + h.maxs.y) * 0.5;
      tmpPos.z = org.z + (h.mins.z + h.maxs.z) * 0.5;
      if ((W.pointContents(tmpPos, CONTENTS_LADDER) & CONTENTS_LADDER) === 0) return false;
      copyVec(ladderNormal, stored);
    } else {
      return false;
    }
  }

  P.moveType = MOVETYPE_LADDER;
  if (stored) copyVec(stored, ladderNormal);
  else ladderNormals.set(P, v3(ladderNormal.x, ladderNormal.y, ladderNormal.z));

  tmpPos.x = org.x;
  tmpPos.y = org.y;
  tmpPos.z = org.z + h.mins.z - 1;
  const onFloor = (W.pointContents(tmpPos, CONTENTS_SOLID) & CONTENTS_SOLID) !== 0 || P.onGround;

  const climb = V.ladderSpeed;
  const forwardSpeed = M.fmove > 0 ? climb : M.fmove < 0 ? -climb : 0;
  const rightSpeed = M.smove > 0 ? climb : M.smove < 0 ? -climb : 0;
  const vel = P.velocity;
  const n = ladderNormal;

  if (cmd.buttons & IN_JUMP) {
    // jump off the ladder
    P.moveType = MOVETYPE_WALK;
    vel.x = n.x * LADDER_JUMP_SPEED;
    vel.y = n.y * LADDER_JUMP_SPEED;
    vel.z = n.z * LADDER_JUMP_SPEED;
  } else if (forwardSpeed !== 0 || rightSpeed !== 0) {
    // intended velocity from the view
    const vx = FWD.x * forwardSpeed + RIGHT.x * rightSpeed;
    const vy = FWD.y * forwardSpeed + RIGHT.y * rightSpeed;
    const vz = FWD.z * forwardSpeed + RIGHT.z * rightSpeed;
    // perpendicular in the ladder plane: up x normal
    ladderPerp.x = -n.y;
    ladderPerp.y = n.x;
    ladderPerp.z = 0;
    const pl = Math.sqrt(ladderPerp.x * ladderPerp.x + ladderPerp.y * ladderPerp.y);
    if (pl > 0) {
      ladderPerp.x /= pl;
      ladderPerp.y /= pl;
    }
    // decompose into the ladder plane
    const into = vx * n.x + vy * n.y + vz * n.z;
    ladderLateral.x = vx - n.x * into;
    ladderLateral.y = vy - n.y * into;
    ladderLateral.z = vz - n.z * into;
    // turn velocity into the face of the ladder into vertical movement along it: normal x perp
    ladderTmp.x = n.y * ladderPerp.z - n.z * ladderPerp.y;
    ladderTmp.y = n.z * ladderPerp.x - n.x * ladderPerp.z;
    ladderTmp.z = n.x * ladderPerp.y - n.y * ladderPerp.x;
    vel.x = ladderLateral.x - into * ladderTmp.x;
    vel.y = ladderLateral.y - into * ladderTmp.y;
    vel.z = ladderLateral.z - into * ladderTmp.z;
    if (onFloor && into > 0) {
      // on the ground moving away from the ladder
      vel.x += n.x * climb;
      vel.y += n.y * climb;
      vel.z += n.z * climb;
    }
  } else {
    zeroVec(vel);
  }
  return true;
}

function fullLadderMove(cmd: UserCmd): void {
  checkWater();
  if (cmd.buttons & IN_JUMP) checkJumpButton();
  else P.oldButtons &= ~IN_JUMP;
  addBaseVelocity(1);
  tryPlayerMove();
  addBaseVelocity(-1);
}

// ------------------------------------------------------------------------------------------ ducking

/** View height for P.duckAmount, eased with Source's SimpleSpline (3t^2 - 2t^3). */
function setDuckView(): void {
  const a = P.duckAmount;
  const t = a < 0 ? 0 : a > 1 ? 1 : a;
  const f = t * t * (3 - 2 * t);
  P.viewOffsetZ = VIEW_OFFSET_STAND + (VIEW_OFFSET_DUCK - VIEW_OFFSET_STAND) * f;
}

/**
 * Keeps the eye at world height `eyeZ` after an in-air hull switch moved the origin, by restarting the duck
 * view transition from the matching duck amount (the view then eases to its target over the remaining
 * duck time instead of snapping by the 9 units the origin moved).
 */
function keepEyeHeight(eyeZ: number): void {
  const view = eyeZ - P.origin.z;
  // invert view = 64 - 18 * smoothstep(a)
  const y = (VIEW_OFFSET_STAND - view) / (VIEW_OFFSET_STAND - VIEW_OFFSET_DUCK);
  if (y <= 0 || y >= 1 || !(V.duckTime > 0)) return; // out of range: keep the snapped view
  // (only the view/duck amount: P.ducking stays false, so jump and speed rules follow the hull alone)
  P.duckAmount = 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3);
  setDuckView();
}

/** Switch to the duck hull. In the air the hull shrinks around its center (origin up by 9). */
function finishDuck(inAir: boolean): void {
  let eyeZ = NaN;
  if (!P.ducked) {
    if (inAir) {
      const org = P.origin;
      eyeZ = org.z + P.viewOffsetZ;
      copyVec(tmpPos, org);
      tmpPos.z += AIR_DUCK_SHIFT;
      // the raised duck hull lies inside the old standing hull; fall back to the unraised one if not free
      if (!hullStuckAt(tmpPos, DUCK_HULL) || hullStuckAt(org, DUCK_HULL)) copyVec(org, tmpPos);
    }
    P.ducked = true;
  }
  P.flags |= FL_DUCKING;
  P.ducking = false;
  P.duckAmount = 1;
  P.duckTimer = 0;
  P.viewOffsetZ = VIEW_OFFSET_DUCK;
  if (inAir && eyeZ === eyeZ) keepEyeHeight(eyeZ);
  categorizeInternal();
}

/** Back to the standing hull (origin already validated by the caller; eyeZ NaN = no view easing). */
function finishUnduck(eyeZ: number): void {
  P.ducked = false;
  P.flags &= ~FL_DUCKING;
  P.ducking = false;
  P.duckAmount = 0;
  P.duckTimer = 0;
  P.viewOffsetZ = VIEW_OFFSET_STAND;
  if (eyeZ === eyeZ) keepEyeHeight(eyeZ);
  categorizeInternal();
}

/** On ground the standing hull must fit in place. */
function canUnduckOnGround(): boolean {
  return !hullStuckAt(P.origin, STAND_HULL);
}

/**
 * In the air the hull grows around its center: the standing hull at origin - 9 (9 more room below the
 * feet and above the head). Without room below, stand on what is there (sweep down from the origin, which
 * needs the full 18 above the ducked head); without room above, lower by the whole 18. False if no room.
 */
function tryUnduckInAir(): boolean {
  const org = P.origin;
  copyVec(tmpPos, org);
  tmpPos.z -= AIR_DUCK_SHIFT;
  if (!hullStuckAt(tmpPos, STAND_HULL)) {
    copyVec(org, tmpPos);
    return true;
  }
  const tr = W.traceBox(org, tmpPos, STAND_HULL.mins, STAND_HULL.maxs, MASK_PLAYERSOLID, trAux);
  if (!tr.startsolid && !tr.allsolid) {
    copyVec(org, tr.endpos);
    return true;
  }
  tmpPos.z = org.z - DUCK_HULL_DELTA;
  if (!hullStuckAt(tmpPos, STAND_HULL)) {
    copyVec(org, tmpPos);
    return true;
  }
  return false;
}

/** CS:GO-style duck state machine (see the module header). */
function duck(cmd: UserCmd): void {
  const holding = (cmd.buttons & IN_DUCK) !== 0;
  // fast path (nearly every tick): standing, not touching the duck key
  if (!holding && !P.ducked && !P.ducking && P.duckAmount === 0) {
    P.duckTimer = 0;
    return;
  }
  const inAir = !P.onGround;
  // HandleDuckingSpeedCrop: ducked players move at 34% on the ground. CS:GO eases the crop in with the
  // duck amount (no full-speed burst during the duck transition); fully ducked it is exactly 0.34.
  if (P.onGround && ((P.flags & FL_DUCKING) !== 0 || P.ducking)) {
    const amount = (P.flags & FL_DUCKING) !== 0 && !P.ducking ? 1 : P.duckAmount;
    const crop = 1 - (1 - V.duckSpeedMultiplier) * (amount < 0 ? 0 : amount > 1 ? 1 : amount);
    M.fmove *= crop;
    M.smove *= crop;
    M.umove *= crop;
  }
  const rate = V.duckTime > 0 ? M.ft / V.duckTime : Infinity;

  if (holding) {
    if (!P.ducked) {
      if (inAir || rate === Infinity) {
        finishDuck(inAir);
      } else {
        P.ducking = true;
        P.duckAmount = Math.min(1, P.duckAmount + rate);
        if (P.duckAmount >= 1) finishDuck(false);
        else setDuckView();
      }
    } else if (P.ducking || P.duckAmount < 1) {
      // pressed again during an unduck transition: go back down (hull is still ducked)
      P.duckAmount = Math.min(1, P.duckAmount + rate);
      if (P.duckAmount >= 1) {
        P.duckAmount = 1;
        P.ducking = false;
      }
      setDuckView();
    }
  } else if (P.ducked) {
    if (inAir) {
      const eyeZ = P.origin.z + P.viewOffsetZ;
      if (tryUnduckInAir()) finishUnduck(eyeZ);
      else {
        P.ducking = false;
        P.duckAmount = 1;
        P.viewOffsetZ = VIEW_OFFSET_DUCK;
      }
    } else if (canUnduckOnGround()) {
      P.ducking = true;
      P.duckAmount = Math.max(0, P.duckAmount - rate);
      if (P.duckAmount <= 0) finishUnduck(NaN);
      else setDuckView();
    } else {
      // still under something: stay fully ducked and retry every tick
      P.ducking = false;
      P.duckAmount = 1;
      P.viewOffsetZ = VIEW_OFFSET_DUCK;
    }
  } else if (P.ducking || P.duckAmount > 0) {
    // released before the duck completed: ease back up (standing hull all along)
    P.duckAmount = Math.max(0, P.duckAmount - rate);
    if (P.duckAmount <= 0) {
      P.duckAmount = 0;
      P.ducking = false;
      P.viewOffsetZ = VIEW_OFFSET_STAND;
    } else setDuckView();
  }

  if (P.ducking && V.duckTime > 0) {
    P.duckTimer = (holding ? 1 - P.duckAmount : P.duckAmount) * V.duckTime;
  } else P.duckTimer = 0;
}

// ------------------------------------------------------------------------------------------ stuck

/** Nudge offsets, nearest first: +-1/32..+-2 on every axis combination, then up to 18 units up. */
const STUCK_OFFSETS: Float64Array = (() => {
  const vals = [0, 1 / 32, -1 / 32, 1 / 16, -1 / 16, 0.125, -0.125, 0.25, -0.25, 0.5, -0.5, 1, -1, 2, -2];
  const list: [number, number, number][] = [];
  for (const z of vals) for (const y of vals) for (const x of vals) if (x || y || z) list.push([x, y, z]);
  // prefer upward on ties (floors are far more common than ceilings), then deterministic order
  list.sort((a, b) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2] - (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]) || b[2] - a[2]);
  const up: [number, number, number][] = [];
  const hv = [0, 1, -1, 2, -2];
  for (let z = 3; z <= 18; z++) {
    const ring: [number, number, number][] = [];
    for (const y of hv) for (const x of hv) ring.push([x, y, z]);
    ring.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
    up.push(...ring);
  }
  const all = list.concat(up);
  const out = new Float64Array(all.length * 3);
  all.forEach((o, i) => {
    out[i * 3] = o[0];
    out[i * 3 + 1] = o[1];
    out[i * 3 + 2] = o[2];
  });
  return out;
})();

const stuckBase = v3();
const stuckTest = v3();
/** Ticks to wait after a failed full unstuck search before searching again. */
const STUCK_RETRY_TICKS = 32;
/** Per-player unstuck retry cooldown. */
const stuckState = new WeakMap<PlayerState, { cooldown: number }>();

/**
 * Source CheckStuck: if the player's hull at its origin is in solid, move it to the nearest free spot from
 * a fixed list of small offsets (then up to 18 units up). Returns true if the player ends up free.
 */
export function unstuckPlayer(ps: PlayerState, world: TraceWorld): boolean {
  W = world;
  const hull = playerHull(ps);
  if (!hullStuckAt(ps.origin, hull)) return true;
  copyVec(stuckBase, ps.origin);
  for (let i = 0; i < STUCK_OFFSETS.length; i += 3) {
    stuckTest.x = stuckBase.x + STUCK_OFFSETS[i];
    stuckTest.y = stuckBase.y + STUCK_OFFSETS[i + 1];
    stuckTest.z = stuckBase.z + STUCK_OFFSETS[i + 2];
    if (!hullStuckAt(stuckTest, hull)) {
      copyVec(ps.origin, stuckTest);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------------------------------ entry points

/**
 * Re-evaluates ground, water level and surface friction after the game moved the player (teleports,
 * respawns, setpos). Clears vertical velocity when the new position is on ground.
 */
export function categorizePosition(ps: PlayerState, world: TraceWorld, vars: MoveVars): void {
  W = world;
  V = vars;
  P = ps;
  EV = resetMoveEvents(dummyEvents);
  M.ft = 0;
  categorizeInternal();
  if (ps.ducked) ps.flags |= FL_DUCKING;
  else ps.flags &= ~FL_DUCKING;
}

/**
 * Runs one CGameMovement::PlayerMove for `cmd`.
 *
 * `frametime` is the tick interval; the effective simulated time is `frametime * ps.laggedMovement`
 * (player_speedmod / m_flLaggedMovementValue scales the frametime of the movement, like Source). Pass
 * the raw tick interval here - do not pre-multiply by laggedMovement.
 *
 * Only uses ps.baseVelocity (vertical part consumed by gravity, horizontal part added for the move);
 * converting a released base velocity into real velocity is the game loop's job.
 */
export function playerMove(
  ps: PlayerState,
  cmd: UserCmd,
  world: TraceWorld,
  vars: MoveVars,
  frametime: number,
  ev: MoveEvents,
): void {
  resetMoveEvents(ev);
  W = world;
  V = vars;
  P = ps;
  EV = ev;
  let lagged = ps.laggedMovement;
  if (Number.isNaN(lagged)) lagged = 1;
  if (!(lagged > 0)) lagged = 0;
  M.ft = (Number.isFinite(frametime) ? frametime : 0) * lagged;
  if (!(M.ft > 0)) M.ft = 0;

  ps.viewAngles.pitch = cmd.viewangles.pitch;
  ps.viewAngles.yaw = cmd.viewangles.yaw;
  ps.viewAngles.roll = cmd.viewangles.roll;
  computeViewVectors(cmd.viewangles.pitch, cmd.viewangles.yaw);
  copyVec(startOrigin, ps.origin);
  checkVelocity();
  const oldWaterLevel = ps.waterLevel;

  // ---- CheckParameters
  M.fmove = Number.isFinite(cmd.forwardmove) ? cmd.forwardmove : 0;
  M.smove = Number.isFinite(cmd.sidemove) ? cmd.sidemove : 0;
  M.umove = Number.isFinite(cmd.upmove) ? cmd.upmove : 0;
  M.playerMaxspeed = ps.maxSpeedOverride > 0 ? ps.maxSpeedOverride : Math.min(vars.maxspeed > 0 ? vars.maxspeed : KNIFE_SPEED, KNIFE_SPEED);
  M.maxspeed = M.playerMaxspeed;
  const noclip = ps.moveType === MOVETYPE_NOCLIP || ps.moveType === MOVETYPE_OBSERVER;
  if (!noclip) {
    if ((cmd.buttons & IN_SPEED) !== 0 && ps.onGround) M.maxspeed *= vars.walkSpeedMultiplier;
    const spd2 = M.fmove * M.fmove + M.smove * M.smove + M.umove * M.umove;
    if (spd2 !== 0 && spd2 > M.maxspeed * M.maxspeed) {
      const ratio = M.maxspeed / Math.sqrt(spd2);
      M.fmove *= ratio;
      M.smove *= ratio;
      M.umove *= ratio;
    }
  }

  // ---- CheckStuck (Source tries one nudge per 0.05 s; we search the whole table at once, and after a
  // failed search wait STUCK_RETRY_TICKS before searching again so a deeply embedded player stays cheap -
  // meanwhile the move runs normally: a trace that leaves the embedding brush is not blocked by it)
  if (ps.moveType === MOVETYPE_WALK || ps.moveType === MOVETYPE_LADDER) {
    if (hullStuckAt(ps.origin, currentHull())) {
      let st = stuckState.get(ps);
      if (st && st.cooldown > 0) st.cooldown--;
      else if (!unstuckPlayer(ps, world)) {
        if (!st) stuckState.set(ps, (st = { cooldown: 0 }));
        st.cooldown = STUCK_RETRY_TICKS;
      }
    }
  }

  // ---- where are we (walkers keep last tick's categorization unless launched upward)
  if (ps.moveType !== MOVETYPE_WALK) categorizeInternal();
  else if (ps.velocity.z > LEAVE_GROUND_VELOCITY) setGround(null);

  if (!ps.onGround) ps.fallVelocity = -ps.velocity.z;

  duck(cmd);

  if (!noclip) {
    if (!ladderMove(cmd) && ps.moveType === MOVETYPE_LADDER) {
      ps.moveType = MOVETYPE_WALK;
      ladderNormals.delete(ps);
    }
  }

  switch (ps.moveType) {
    case MOVETYPE_NOCLIP:
    case MOVETYPE_OBSERVER:
      fullNoClipMove(cmd);
      categorizeInternal();
      break;
    case MOVETYPE_LADDER:
      fullLadderMove(cmd);
      break;
    default:
      fullWalkMove(cmd);
      break;
  }

  // ---- FinishMove
  ps.oldButtons = cmd.buttons;
  if (oldWaterLevel === 0 && ps.waterLevel > 0) ev.enteredWater = true;
  else if (oldWaterLevel > 0 && ps.waterLevel === 0) ev.leftWater = true;
  if (ps.onGround) ps.flags |= FL_ONGROUND;
  else ps.flags &= ~FL_ONGROUND;
  if (ps.ducked) ps.flags |= FL_DUCKING;
  else ps.flags &= ~FL_DUCKING;
  const o = ps.origin;
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) {
    copyVec(o, startOrigin);
    zeroVec(ps.velocity);
  }
  checkVelocity();
}
