// Source-style Euler angles (degrees). pitch: + looks down, yaw: + turns left (CCW seen from above), roll.
import { Vec3, v3parse } from './vec3';

export interface QAngle {
  pitch: number;
  yaw: number;
  roll: number;
}

export function qa(pitch = 0, yaw = 0, roll = 0): QAngle {
  return { pitch, yaw, roll };
}

export function qaCopy(out: QAngle, a: QAngle): QAngle {
  out.pitch = a.pitch;
  out.yaw = a.yaw;
  out.roll = a.roll;
  return out;
}

export function qaClone(a: QAngle): QAngle {
  return { pitch: a.pitch, yaw: a.yaw, roll: a.roll };
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Source's AngleVectors. forward = +X at yaw 0; right = -Y at yaw 0; up = +Z at pitch 0.
 * Any of the outputs may be omitted.
 */
export function angleVectors(a: QAngle, forward?: Vec3, right?: Vec3, up?: Vec3): void {
  const sy = Math.sin(a.yaw * DEG2RAD);
  const cy = Math.cos(a.yaw * DEG2RAD);
  const sp = Math.sin(a.pitch * DEG2RAD);
  const cp = Math.cos(a.pitch * DEG2RAD);
  const sr = Math.sin(a.roll * DEG2RAD);
  const cr = Math.cos(a.roll * DEG2RAD);
  if (forward) {
    forward.x = cp * cy;
    forward.y = cp * sy;
    forward.z = -sp;
  }
  if (right) {
    right.x = -1 * sr * sp * cy + -1 * cr * -sy;
    right.y = -1 * sr * sp * sy + -1 * cr * cy;
    right.z = -1 * sr * cp;
  }
  if (up) {
    up.x = cr * sp * cy + -sr * -sy;
    up.y = cr * sp * sy + -sr * cy;
    up.z = cr * cp;
  }
}

/** Source's VectorAngles (no roll). */
export function vectorAngles(v: Vec3, out: QAngle = qa()): QAngle {
  let yaw: number;
  let pitch: number;
  if (v.y === 0 && v.x === 0) {
    yaw = 0;
    pitch = v.z > 0 ? 270 : 90;
  } else {
    yaw = Math.atan2(v.y, v.x) * RAD2DEG;
    if (yaw < 0) yaw += 360;
    const tmp = Math.sqrt(v.x * v.x + v.y * v.y);
    pitch = Math.atan2(-v.z, tmp) * RAD2DEG;
    if (pitch < 0) pitch += 360;
  }
  out.pitch = pitch;
  out.yaw = yaw;
  out.roll = 0;
  return out;
}

/** Wraps an angle into (-180, 180]. */
export function normalizeAngle(a: number): number {
  a = a % 360;
  if (a > 180) a -= 360;
  else if (a <= -180) a += 360;
  return a;
}

/** Smallest signed difference a - b in degrees. */
export function angleDiff(a: number, b: number): number {
  return normalizeAngle(a - b);
}

/** Parses Source "pitch yaw roll" keyvalue strings. */
export function qaParse(s: string | undefined): QAngle {
  const v = v3parse(s);
  return qa(v.x, v.y, v.z);
}
