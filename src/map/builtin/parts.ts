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

export interface VoidSpec {
  /** Slabs are cut along this axis from a0 to a1; the other axis spans [b0, b1]. */
  axis: 'x' | 'y';
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  /** Bottom of the trigger volumes. */
  floorZ: number;
  dest: string;
  /** Ramps whose bottoms the slabs must stay under. */
  ramps: RampRecord[];
  /** Other surfaces: lowest legit z over a rectangle (+Infinity = nothing there). */
  extra?: ((x0: number, x1: number, y0: number, y1: number) => number)[];
  /** Clearance below the lowest surface. */
  margin?: number;
  step?: number;
}

/** Box surface for VoidSpec.extra: `z` over the rectangle [mins, maxs] (e.g. a platform's underside). */
export function boxSurface(mins: Vec3, maxs: Vec3, z = mins.z): (x0: number, x1: number, y0: number, y1: number) => number {
  return (x0, x1, y0, y1) => (x1 < mins.x || x0 > maxs.x || y1 < mins.y || y0 > maxs.y ? Infinity : z);
}

/**
 * Fail teleports filling the void below a stretch of course: trigger_teleport slabs `step` units long along
 * `axis`, each topped `margin` units below the lowest surface over it, so a missed ramp is caught soon after
 * falling past it while nothing a run touches overlaps them. Slabs with nothing above them (gaps) take the
 * lower of their neighbours' heights. Returns the trigger model numbers.
 */
export function addVoidTeleports(b: MapBuilder, s: VoidSpec): number[] {
  const step = s.step ?? 512;
  const margin = s.margin ?? 96;
  const rect = (a: number, c: number): [number, number, number, number] =>
    s.axis === 'x' ? [a, c, s.b0, s.b1] : [s.b0, s.b1, a, c];
  const pieces: { a0: number; a1: number; top: number }[] = [];
  for (let a = s.a0; a < s.a1 - 1e-6; a += step) {
    const ae = Math.min(s.a1, a + step);
    const [x0, x1, y0, y1] = rect(a, ae);
    let top = Infinity;
    for (const r of s.ramps) top = Math.min(top, rampBottomInRect(r, x0, x1, y0, y1));
    for (const f of s.extra ?? []) top = Math.min(top, f(x0, x1, y0, y1));
    pieces.push({ a0: a, a1: ae, top });
  }
  for (let i = 0; i < pieces.length; i++) {
    if (Number.isFinite(pieces[i].top)) continue;
    let best = Infinity;
    for (let j = i - 1; j >= 0; j--) {
      if (Number.isFinite(pieces[j].top)) {
        best = Math.min(best, pieces[j].top);
        break;
      }
    }
    for (let j = i + 1; j < pieces.length; j++) {
      if (Number.isFinite(pieces[j].top)) {
        best = Math.min(best, pieces[j].top);
        break;
      }
    }
    pieces[i].top = best;
  }
  const merged: { a0: number; a1: number; top: number }[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.top - p.top) < 1e-6) last.a1 = p.a1;
    else merged.push({ ...p });
  }
  const out: number[] = [];
  for (const p of merged) {
    if (!Number.isFinite(p.top)) continue;
    const top = p.top - margin;
    if (top <= s.floorZ + 1) continue;
    const [x0, x1, y0, y1] = rect(p.a0, p.a1);
    out.push(b.addTeleport(v3(x0, y0, s.floorZ), v3(x1, y1, top), s.dest));
  }
  return out;
}

/**
 * Lowest z of a ramp's bottom edge(s) over the part of the ramp whose XY lies inside the rectangle
 * [x0, x1] x [y0, y1] (+Infinity when no part of the ramp is over it). Sampled every 32 units.
 */
export function rampBottomInRect(r: RampRecord, x0: number, x1: number, y0: number, y1: number): number {
  let z = Infinity;
  for (let k = 0; k + 1 < r.ribs.length; k++) {
    for (const bi of [0, 1, 2]) {
      // ridge points too (index 0): a ridge passing over the rectangle bounds the volume as well
      const a = r.ribs[k][bi];
      const b = r.ribs[k + 1][bi];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(len / 32));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const zz = bi === 0 ? a.z + (b.z - a.z) * t - r.height : a.z + (b.z - a.z) * t;
        if (zz < z) z = zz;
      }
    }
  }
  return z;
}

/**
 * Render-only glowing bar (an oriented box, no collision) from `a` to `b` with a square cross-section of
 * `size`: decoration for gates and signs.
 */
export function addGlowBar(b: MapBuilder, a: Vec3, c: Vec3, size: number, mat: string): void {
  const d = v3(c.x - a.x, c.y - a.y, c.z - a.z);
  const len = Math.hypot(d.x, d.y, d.z);
  if (!(len > 1e-6)) return;
  const f = v3(d.x / len, d.y / len, d.z / len);
  // two unit vectors perpendicular to the bar
  const ref = Math.abs(f.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
  let u = v3(f.y * ref.z - f.z * ref.y, f.z * ref.x - f.x * ref.z, f.x * ref.y - f.y * ref.x);
  const ul = Math.hypot(u.x, u.y, u.z);
  u = v3(u.x / ul, u.y / ul, u.z / ul);
  const w = v3(f.y * u.z - f.z * u.y, f.z * u.x - f.x * u.z, f.x * u.y - f.y * u.x);
  const h = size / 2;
  const corner = (p: Vec3, su: number, sw: number): Vec3 => v3(p.x + (u.x * su + w.x * sw) * h, p.y + (u.y * su + w.y * sw) * h, p.z + (u.z * su + w.z * sw) * h);
  const sides: [number, number, number, number, Vec3][] = [
    [1, -1, 1, 1, u],
    [-1, 1, -1, -1, v3(-u.x, -u.y, -u.z)],
    [-1, 1, 1, 1, w],
    [1, -1, -1, -1, v3(-w.x, -w.y, -w.z)],
  ];
  for (const [su0, su1, sw0, sw1, n] of sides) {
    b.addDecal([corner(a, su0, sw0), corner(c, su0, sw0), corner(c, su1, sw1), corner(a, su1, sw1)], n, mat, 0);
  }
  b.addDecal([corner(a, 1, 1), corner(a, -1, 1), corner(a, -1, -1), corner(a, 1, -1)], v3(-f.x, -f.y, -f.z), mat, 0);
  b.addDecal([corner(c, 1, 1), corner(c, -1, 1), corner(c, -1, -1), corner(c, 1, -1)], f, mat, 0);
}

/**
 * A glowing gate frame (render only) around the start of a ramp's surfed face at `along`: two posts and a
 * lintel, a little outside the face so runs pass through it untouched.
 */
export function addRampGate(b: MapBuilder, r: RampRecord, face: 'left' | 'right', along: number, mat: string, size = 16): void {
  const top = rampPoint(r, face, along, 0);
  const bottom = rampPoint(r, face, along, 1);
  const dx = bottom.x - top.x;
  const dy = bottom.y - top.y;
  const l = Math.hypot(dx, dy);
  const ox = dx / l;
  const oy = dy / l;
  const margin = 96;
  const hi = top.z + 320;
  const lo = bottom.z - 64;
  const pIn = v3(top.x - ox * margin, top.y - oy * margin, 0);
  const pOut = v3(bottom.x + ox * margin, bottom.y + oy * margin, 0);
  addGlowBar(b, v3(pIn.x, pIn.y, lo), v3(pIn.x, pIn.y, hi), size, mat);
  addGlowBar(b, v3(pOut.x, pOut.y, lo), v3(pOut.x, pOut.y, hi), size, mat);
  addGlowBar(b, v3(pIn.x, pIn.y, hi), v3(pOut.x, pOut.y, hi), size, mat);
}
