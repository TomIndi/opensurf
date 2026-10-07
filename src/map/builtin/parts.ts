// Reusable pieces of the built-in maps: section start destinations, zone boxes around ramp starts,
// stage rooms and fail-teleport volumes.
import { Vec3, v3 } from '../../core/vec3';
import { MapBuilder, RampRecord } from './builder';
import { rampFrame, rampLength, rampPoint } from './course';

/** AABB of a set of ramps (their brushes). */
export function rampsBounds(ramps: RampRecord[]): { mins: Vec3; maxs: Vec3 } {
  const mins = v3(Infinity, Infinity, Infinity);
  const maxs = v3(-Infinity, -Infinity, -Infinity);
  for (const r of ramps) {
    for (const b of r.brushes) {
      mins.x = Math.min(mins.x, b.mins.x);
      mins.y = Math.min(mins.y, b.mins.y);
      mins.z = Math.min(mins.z, b.mins.z);
      maxs.x = Math.max(maxs.x, b.maxs.x);
      maxs.y = Math.max(maxs.y, b.maxs.y);
      maxs.z = Math.max(maxs.z, b.maxs.z);
    }
  }
  return { mins, maxs };
}

/** Yaw (degrees) of a ramp's first segment. */
export function rampStartYaw(r: RampRecord): number {
  const a = r.points[0];
  const b = r.points[1];
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/**
 * A spot hovering over the start of a ramp's surfed face (where a section/stage restart drops you in),
 * facing along the ramp: `along` units in, at `depth` (0 = ridge, 1 = bottom edge), `above` units up.
 */
export function stageDestination(r: RampRecord, face: 'left' | 'right', along = 192, depth = 0.4, above = 72): { origin: Vec3; yaw: number } {
  const p = rampPoint(r, face, along, depth);
  return { origin: v3(p.x, p.y, p.z + above), yaw: rampStartYaw(r) };
}

/**
 * Zone box around the start of a ramp: the first `len` units of its face, from below the bottom edge to
 * well above the ridge, so any run entering the ramp passes through it.
 */
export function rampZoneBox(r: RampRecord, face: 'left' | 'right', from = 0, len = 448): { mins: Vec3; maxs: Vec3 } {
  const pts = [rampPoint(r, face, from, 0), rampPoint(r, face, from + len, 0), rampPoint(r, face, from, 1), rampPoint(r, face, from + len, 1)];
  const mins = v3(Infinity, Infinity, Infinity);
  const maxs = v3(-Infinity, -Infinity, -Infinity);
  for (const p of pts) {
    mins.x = Math.min(mins.x, p.x);
    mins.y = Math.min(mins.y, p.y);
    mins.z = Math.min(mins.z, p.z);
    maxs.x = Math.max(maxs.x, p.x);
    maxs.y = Math.max(maxs.y, p.y);
    maxs.z = Math.max(maxs.z, p.z);
  }
  // cover the air above the face (the player's hull rides 16+ units off it) and a little beyond the edges
  mins.x -= 24;
  mins.y -= 24;
  maxs.x += 24;
  maxs.y += 24;
  mins.z -= 32;
  maxs.z += 256;
  return { mins, maxs };
}

/** Lowest point of a ramp's surfed face over its whole length (the bottom edge's lowest point). */
export function rampBottomZ(r: RampRecord): number {
  let z = Infinity;
  for (const rib of r.ribs) for (const p of rib) z = Math.min(z, p.z);
  return z;
}

/** Highest ridge point of a ramp. */
export function rampTopZ(r: RampRecord): number {
  let z = -Infinity;
  for (const p of r.points) z = Math.max(z, p.z);
  return z;
}

export { rampFrame, rampLength };

export interface RoomStyle {
  floor: string;
  wall: string;
  ceiling: string;
  trim?: string | null;
}

/**
 * A stage room: interior [mins, maxs] with a doorway in the wall on the `exit` side spanning the whole
 * interior width except `jamb` units each side (height `doorH`). Returns the doorway center at floor level.
 */
export function addStageRoom(b: MapBuilder, mins: Vec3, maxs: Vec3, exit: '+x' | '-x' | '+y' | '-y', style: RoomStyle, doorH = 224, jamb = 48): Vec3 {
  const alongX = exit === '+y' || exit === '-y';
  const a0 = (alongX ? mins.x : mins.y) + jamb;
  const a1 = (alongX ? maxs.x : maxs.y) - jamb;
  b.addRoom(mins, maxs, { floor: style.floor, wall: style.wall, ceiling: style.ceiling }, [{ side: exit, a0, a1, z0: mins.z, z1: mins.z + doorH }]);
  if (style.trim) b.addTopTrim(v3(mins.x, mins.y, mins.z - 16), v3(maxs.x, maxs.y, mins.z), style.trim, 6);
  const c = v3((mins.x + maxs.x) / 2, (mins.y + maxs.y) / 2, mins.z);
  if (exit === '+x') c.x = maxs.x;
  else if (exit === '-x') c.x = mins.x;
  else if (exit === '+y') c.y = maxs.y;
  else c.y = mins.y;
  return c;
}
