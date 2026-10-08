// Source view -> three.js camera. Source angles (pitch down-positive, yaw left-positive, roll) and Source's
// horizontal-at-4:3 field of view (CS:GO's fov semantics, Hor+ on wider screens).
import { Matrix4, PerspectiveCamera } from 'three';
import { QAngle, angleVectors } from '../core/angles';
import type { Vec3 } from '../core/vec3';

const DEG = Math.PI / 180;

/**
 * The renderer draws from 1/73 unit behind the eye. Map vertices sit on a 1/32-unit grid and so do eyes at
 * spawns and on flat ground; with an axis-aligned view (every spawn) whole rows of vertices then lie exactly in
 * the eye's plane (clip w = 0), which some rasterizers (SwiftShader) clip wrongly - the triangle smears across
 * the screen. The offset keeps |w| >= 0.0137 for such vertices and is far below anything visible.
 */
export const EYE_PULLBACK = 1 / 73;

/** Largest |pitch| the renderer accepts (the game clamps to 89 like cl_pitchup/cl_pitchdown). */
export const MAX_PITCH = 89;

/**
 * Vertical fov (degrees) for a Source fov: `hfov` is the horizontal angle of a 4:3 view, so the vertical angle
 * is fixed and wider screens see more to the sides (CS:GO: fov 90 -> 73.74 deg vertical, 106.26 deg
 * horizontal at 16:9).
 */
export function sourceVerticalFov(hfovDeg: number): number {
  const h = Math.min(170, Math.max(1, Number.isFinite(hfovDeg) ? hfovDeg : 90));
  return (2 * Math.atan(Math.tan((h * DEG) / 2) * 0.75)) / DEG;
}

/** Horizontal fov (degrees) actually seen at `aspect` (width / height) for a Source fov. */
export function horizontalFovAt(hfovDeg: number, aspect: number): number {
  const v = sourceVerticalFov(hfovDeg) * DEG;
  return (2 * Math.atan(Math.tan(v / 2) * aspect)) / DEG;
}

const fwd: Vec3 = { x: 0, y: 0, z: 0 };
const right: Vec3 = { x: 0, y: 0, z: 0 };
const up: Vec3 = { x: 0, y: 0, z: 0 };
const clamped: QAngle = { pitch: 0, yaw: 0, roll: 0 };

/**
 * Camera world matrix for a Source eye: three.js cameras look down their local -Z with +Y up and +X right,
 * so the columns are (right, up, -forward, origin). Writes into `out` (no allocation).
 */
export function viewMatrixWorld(origin: Vec3, angles: QAngle, out: Matrix4): Matrix4 {
  clamped.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Number.isFinite(angles.pitch) ? angles.pitch : 0));
  clamped.yaw = Number.isFinite(angles.yaw) ? angles.yaw : 0;
  clamped.roll = Number.isFinite(angles.roll) ? angles.roll : 0;
  angleVectors(clamped, fwd, right, up);
  const ox = Number.isFinite(origin.x) ? origin.x : 0;
  const oy = Number.isFinite(origin.y) ? origin.y : 0;
  const oz = Number.isFinite(origin.z) ? origin.z : 0;
  // Matrix4.set takes row-major arguments.
  out.set(right.x, up.x, -fwd.x, ox, right.y, up.y, -fwd.y, oy, right.z, up.z, -fwd.z, oz, 0, 0, 0, 1);
  return out;
}

/** Inverse of a rigid camera matrix (rotation transpose, rotated negated translation); no allocation. */
export function rigidInverse(m: Matrix4, out: Matrix4): Matrix4 {
  const e = m.elements;
  // column-major: e[0..2] = column 0 (right), e[4..6] = column 1 (up), e[8..10] = column 2, e[12..14] = origin
  const r00 = e[0];
  const r10 = e[1];
  const r20 = e[2];
  const r01 = e[4];
  const r11 = e[5];
  const r21 = e[6];
  const r02 = e[8];
  const r12 = e[9];
  const r22 = e[10];
  const tx = e[12];
  const ty = e[13];
  const tz = e[14];
  out.set(
    r00,
    r10,
    r20,
    -(r00 * tx + r10 * ty + r20 * tz),
    r01,
    r11,
    r21,
    -(r01 * tx + r11 * ty + r21 * tz),
    r02,
    r12,
    r22,
    -(r02 * tx + r12 * ty + r22 * tz),
    0,
    0,
    0,
    1,
  );
  return out;
}

/**
 * Points `camera` at a Source view: Z-up (camera.up = 0,0,1), world matrix from the eye and angles, vertical
 * fov from the Source fov, aspect from the viewport. The camera must have matrixAutoUpdate and
 * matrixWorldAutoUpdate off (the renderer maintains its matrices itself). `pullBack` moves the eye back along
 * the view direction by that many units (see EYE_PULLBACK).
 */
export function applySourceView(camera: PerspectiveCamera, origin: Vec3, angles: QAngle, fov: number, aspect: number, pullBack = 0): void {
  viewMatrixWorld(origin, angles, camera.matrixWorld);
  if (pullBack) {
    // move the eye back along the view direction (column 2 of the camera matrix is -forward)
    const e = camera.matrixWorld.elements;
    e[12] += e[8] * pullBack;
    e[13] += e[9] * pullBack;
    e[14] += e[10] * pullBack;
  }
  rigidInverse(camera.matrixWorld, camera.matrixWorldInverse);
  camera.position.set(camera.matrixWorld.elements[12], camera.matrixWorld.elements[13], camera.matrixWorld.elements[14]);
  const vfov = sourceVerticalFov(fov);
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 4 / 3;
  if (camera.fov !== vfov || camera.aspect !== a) {
    camera.fov = vfov;
    camera.aspect = a;
    camera.updateProjectionMatrix();
  }
}

/** A camera set up for Source views (Z-up, manual matrices). */
export function createSourceCamera(near: number, far: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(sourceVerticalFov(90), 16 / 9, near, far);
  cam.up.set(0, 0, 1);
  cam.matrixAutoUpdate = false;
  cam.matrixWorldAutoUpdate = false;
  return cam;
}
