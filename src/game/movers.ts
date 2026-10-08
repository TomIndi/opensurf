// Moving brush entities (func_door, func_rotating, func_movelinear, trains...): placement math, the entity
// hierarchy (parentname / SetParent: children follow their parent's rigid transform), Source pusher semantics
// for the player (riders are carried, a mover moving into the player pushes it, a push that can't place the
// player blocks the mover) and render interpolation. The mover entity classes themselves live in entities.ts;
// this module is the engine-side part they share. Implemented from public descriptions of Source behaviour.
//
// Placements are an origin plus Source Euler angles (pitch, yaw, roll), as entities place their brush models
// (bspcollision brushEntityPlacement). Geometry built at a "base" placement (the map as loaded) is shown /
// collided at a new placement through the rigid motion new * base^-1 (CollisionWorld.setModelTransform,
// RendererApi.setModelTransform).
import { QAngle, angleVectors, qa } from '../core/angles';
import { Vec3, v3 } from '../core/vec3';
import { MapEntity } from '../map/types';
import { CollisionWorld, anglesToMatrix, matrixToAngles, mulMatrix3 } from '../physics/collision';
import { playerHull, unstuckPlayer } from '../physics/movement';
import { MOVETYPE_LADDER, MOVETYPE_WALK, PlayerState } from '../physics/playertypes';
import { MASK_PLAYERSOLID } from '../physics/types';

// ------------------------------------------------------------------------------------------ placements

/** An origin + Source angles, with the rotation matrix kept in sync (row-major, columns forward/left/up). */
export class Pose {
  readonly origin: Vec3 = v3();
  readonly angles: QAngle = qa();
  readonly m = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  /** Sets origin and angles (and the matrix). */
  set(origin: Vec3, angles: QAngle): this {
    this.origin.x = origin.x;
    this.origin.y = origin.y;
    this.origin.z = origin.z;
    this.angles.pitch = angles.pitch;
    this.angles.yaw = angles.yaw;
    this.angles.roll = angles.roll;
    anglesToMatrix(angles, this.m);
    return this;
  }

  /** Sets origin and rotation matrix (angles derived from it). */
  setMatrix(origin: Vec3, m: ArrayLike<number>): this {
    this.origin.x = origin.x;
    this.origin.y = origin.y;
    this.origin.z = origin.z;
    for (let i = 0; i < 9; i++) this.m[i] = m[i];
    matrixToAngles(this.m, this.angles);
    return this;
  }

  copy(p: Pose): this {
    this.origin.x = p.origin.x;
    this.origin.y = p.origin.y;
    this.origin.z = p.origin.z;
    this.angles.pitch = p.angles.pitch;
    this.angles.yaw = p.angles.yaw;
    this.angles.roll = p.angles.roll;
    this.m.set(p.m);
    return this;
  }

  equals(p: Pose): boolean {
    const a = this.origin;
    const b = p.origin;
    if (a.x !== b.x || a.y !== b.y || a.z !== b.z) return false;
    for (let i = 0; i < 9; i++) if (this.m[i] !== p.m[i]) return false;
    return true;
  }

  /** World position of the local point `p`: m * p + origin. */
  apply(p: Vec3, out: Vec3): Vec3 {
    const m = this.m;
    const x = p.x;
    const y = p.y;
    const z = p.z;
    out.x = m[0] * x + m[1] * y + m[2] * z + this.origin.x;
    out.y = m[3] * x + m[4] * y + m[5] * z + this.origin.y;
    out.z = m[6] * x + m[7] * y + m[8] * z + this.origin.z;
    return out;
  }

  /** Local position of the world point `p`: m^T * (p - origin). */
  unapply(p: Vec3, out: Vec3): Vec3 {
    const m = this.m;
    const x = p.x - this.origin.x;
    const y = p.y - this.origin.y;
    const z = p.z - this.origin.z;
    out.x = m[0] * x + m[3] * y + m[6] * z;
    out.y = m[1] * x + m[4] * y + m[7] * z;
    out.z = m[2] * x + m[5] * y + m[8] * z;
    return out;
  }
}

const _m9 = new Float64Array(9);
const _v = v3();

/** out = parent o local: the world placement of a child placed at `local` relative to `parent`. */
export function composePose(parent: Pose, local: Pose, out: Pose): Pose {
  mulMatrix3(parent.m, local.m, _m9);
  parent.apply(local.origin, _v);
  return out.setMatrix(_v, _m9);
}

/** out = parent^-1 o world: the placement of `world` relative to `parent`. */
export function relativePose(parent: Pose, world: Pose, out: Pose): Pose {
  const p = parent.m;
  const w = world.m;
  // p^T * w
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) _m9[r * 3 + c] = p[r] * w[c] + p[3 + r] * w[3 + c] + p[6 + r] * w[6 + c];
  }
  parent.unapply(world.origin, _v);
  return out.setMatrix(_v, _m9);
}

/** Moves the world point `p` rigidly with a body that went from placement `from` to `to`. */
export function carryPoint(from: Pose, to: Pose, p: Vec3, out: Vec3): Vec3 {
  from.unapply(p, _v);
  return to.apply(_v, out);
}

// quaternion scratch (w, x, y, z)
const _qa = new Float64Array(4);
const _qb = new Float64Array(4);

function matrixToQuat(m: ArrayLike<number>, q: Float64Array): void {
  const tr = m[0] + m[4] + m[8];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q[0] = 0.25 * s;
    q[1] = (m[7] - m[5]) / s;
    q[2] = (m[2] - m[6]) / s;
    q[3] = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q[0] = (m[7] - m[5]) / s;
    q[1] = 0.25 * s;
    q[2] = (m[1] + m[3]) / s;
    q[3] = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q[0] = (m[2] - m[6]) / s;
    q[1] = (m[1] + m[3]) / s;
    q[2] = 0.25 * s;
    q[3] = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q[0] = (m[3] - m[1]) / s;
    q[1] = (m[2] + m[6]) / s;
    q[2] = (m[5] + m[7]) / s;
    q[3] = 0.25 * s;
  }
}

function quatToMatrix(q: Float64Array, m: Float64Array): void {
  const w = q[0];
  const x = q[1];
  const y = q[2];
  const z = q[3];
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y - w * z);
  m[2] = 2 * (x * z + w * y);
  m[3] = 2 * (x * y + w * z);
  m[4] = 1 - 2 * (x * x + z * z);
  m[5] = 2 * (y * z - w * x);
  m[6] = 2 * (x * z - w * y);
  m[7] = 2 * (y * z + w * x);
  m[8] = 1 - 2 * (x * x + y * y);
}

/** Placement between `a` (t = 0) and `b` (t = 1): origins lerped, rotations slerped (render interpolation). */
export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  _v.x = a.origin.x + (b.origin.x - a.origin.x) * k;
  _v.y = a.origin.y + (b.origin.y - a.origin.y) * k;
  _v.z = a.origin.z + (b.origin.z - a.origin.z) * k;
  let same = true;
  for (let i = 0; i < 9; i++) {
    if (a.m[i] !== b.m[i]) {
      same = false;
      break;
    }
  }
  if (same || k === 0 || k === 1) return out.setMatrix(_v, k === 1 ? b.m : a.m);
  matrixToQuat(a.m, _qa);
  matrixToQuat(b.m, _qb);
  let dot = _qa[0] * _qb[0] + _qa[1] * _qb[1] + _qa[2] * _qb[2] + _qa[3] * _qb[3];
  if (dot < 0) {
    dot = -dot;
    for (let i = 0; i < 4; i++) _qb[i] = -_qb[i];
  }
  let wa = 1 - k;
  let wb = k;
  if (dot < 0.9995) {
    const th = Math.acos(Math.min(1, dot));
    const s = Math.sin(th);
    wa = Math.sin((1 - k) * th) / s;
    wb = Math.sin(k * th) / s;
  }
  let len = 0;
  for (let i = 0; i < 4; i++) {
    _qa[i] = _qa[i] * wa + _qb[i] * wb;
    len += _qa[i] * _qa[i];
  }
  len = Math.sqrt(len) || 1;
  for (let i = 0; i < 4; i++) _qa[i] /= len;
  quatToMatrix(_qa, _m9);
  return out.setMatrix(_v, _m9);
}

// ------------------------------------------------------------------------------------------ keyvalue helpers

/**
 * Source SetMovedir: a move direction from an "angles"/"movedir" triple. Quake's special yaw values -1 (up) and
 * -2 (down) with zero pitch still work; otherwise the forward vector of the angles.
 */
export function moveDirFromAngles(a: QAngle): Vec3 {
  if (a.pitch === 0 && a.roll === 0) {
    if (a.yaw === -1) return v3(0, 0, 1);
    if (a.yaw === -2) return v3(0, 0, -1);
  }
  const f = v3();
  angleVectors(a, f);
  const fix = (x: number): number => (Math.abs(x) < 1e-12 ? 0 : x);
  return v3(fix(f.x), fix(f.y), fix(f.z));
}

/**
 * func_door travel distance (Source/Quake): the model's extent along the move direction, less 2 units of
 * overlap, less the lip.
 */
export function doorTravel(dir: Vec3, size: Vec3, lip: number): number {
  return Math.abs(dir.x * (size.x - 2)) + Math.abs(dir.y * (size.y - 2)) + Math.abs(dir.z * (size.z - 2)) - lip;
}

/** Moves `cur` towards `target` by at most `step` (>= 0). */
export function approach(cur: number, target: number, step: number): number {
  if (cur < target) return Math.min(target, cur + step);
  if (cur > target) return Math.max(target, cur - step);
  return cur;
}

/** Wraps degrees into [0, 360). */
export function anglemod(a: number): number {
  const r = a % 360;
  return r < 0 ? r + 360 : r;
}

// ------------------------------------------------------------------------------------------ which entities move

/** Brush entity classes that move by themselves. */
export const MOVER_CLASSES: ReadonlySet<string> = new Set([
  'func_rotating',
  'func_door',
  'func_door_rotating',
  'func_movelinear',
  'func_water_analog',
  'func_tracktrain',
  'func_tanktrain',
  'func_train',
  'momentary_rot_button',
]);

/**
 * What can move on a map, decided at load: mover brush entities, everything parented to them (parentname,
 * transitively) and every entity an output re-parents (SetParent / SetParentAttachment...) together with its new
 * parent's hierarchy. `models` are brush model numbers, `entities` indices into `entities` (the
 * LoadedMap.entities array, as RenderProp.entity).
 */
export function movableEntitySets(entities: readonly MapEntity[]): { models: Set<number>; entities: Set<number> } {
  const byName = new Map<string, number[]>();
  entities.forEach((e, i) => {
    if (!e.targetname) return;
    const k = e.targetname.toLowerCase();
    let l = byName.get(k);
    if (!l) byName.set(k, (l = []));
    l.push(i);
  });
  const lookup = (name: string): number[] => {
    const n = name.split(',')[0].trim().toLowerCase();
    if (!n) return [];
    if (n.endsWith('*')) {
      const p = n.slice(0, -1);
      const out: number[] = [];
      for (const [k, l] of byName) if (k.startsWith(p)) out.push(...l);
      return out;
    }
    return byName.get(n) ?? [];
  };
  const moving = new Set<number>();
  entities.forEach((e, i) => {
    if (MOVER_CLASSES.has(e.classname.toLowerCase())) moving.add(i);
  });
  // runtime re-parenting: the target may end up under any parent named in the parameter
  const reparented = new Set<number>();
  const newParents = new Set<number>();
  for (const e of entities) {
    for (const o of e.outputs) {
      const inp = o.input.toLowerCase();
      if (!inp.startsWith('setparent')) continue;
      for (const t of lookup(o.target)) reparented.add(t);
      if (inp === 'setparent') for (const p of lookup(o.param)) newParents.add(p);
    }
  }
  for (const p of newParents) if (moving.has(p)) for (const t of reparented) moving.add(t);
  // parentname chains (children of anything moving move too)
  const parentOf = entities.map((e) => {
    const pn = e.kv.parentname;
    return pn ? lookup(pn)[0] ?? -1 : -1;
  });
  let changed = true;
  for (let pass = 0; changed && pass < 32; pass++) {
    changed = false;
    for (let i = 0; i < entities.length; i++) {
      if (moving.has(i)) continue;
      const p = parentOf[i];
      if (p >= 0 && moving.has(p)) {
        moving.add(i);
        changed = true;
      }
    }
  }
  const models = new Set<number>();
  for (const i of moving) if (entities[i].model > 0) models.add(entities[i].model);
  return { models, entities: moving };
}

// ------------------------------------------------------------------------------------------ the pusher

export type PushOutcome = 'none' | 'moved' | 'blocked';

/**
 * Source pusher semantics for the player and one moved solid brush model that went from placement `from` to
 * `to` (already applied to the collision world): a rider (standing on the model) or a player the model now
 * overlaps is moved rigidly with it (its origin follows the model's translation and rotation; the view is not
 * turned). When that leaves the player in solid, CheckStuck's small nudges are tried; if the player still
 * can't be placed it is put back and the push is 'blocked' (the caller stops or reverses the mover, or crushes
 * the player).
 */
export function pushPlayer(world: CollisionWorld, ps: PlayerState, model: number, from: Pose, to: Pose, riding: boolean, saved: Vec3): PushOutcome {
  if (ps.moveType !== MOVETYPE_WALK && ps.moveType !== MOVETYPE_LADDER) return 'none';
  const hull = playerHull(ps);
  if (!riding && !world.testModelBox(model, ps.origin, hull.mins, hull.maxs, MASK_PLAYERSOLID)) return 'none';
  saved.x = ps.origin.x;
  saved.y = ps.origin.y;
  saved.z = ps.origin.z;
  carryPoint(from, to, ps.origin, ps.origin);
  if (!world.testBox(ps.origin, hull.mins, hull.maxs, MASK_PLAYERSOLID)) return 'moved';
  // the hull doesn't turn with a rotating pusher, and a carried rider can be pushed into the world:
  // CheckStuck's nudges first
  if (unstuckPlayer(ps, world)) return 'moved';
  ps.origin.x = saved.x;
  ps.origin.y = saved.y;
  ps.origin.z = saved.z;
  return 'blocked';
}
