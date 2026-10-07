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

/** Part of a ramp (along-ridge range) owned by a void-grid owner. */
export interface RampPiece {
  ramp: RampRecord;
  from?: number;
  to?: number;
}

export interface VoidOwner {
  /** Teleport destination for falls in this owner's cells. */
  dest: string;
  /** Course geometry that attracts cells to this owner (nearest owner wins). */
  pieces: RampPiece[];
  boxes?: { mins: Vec3; maxs: Vec3 }[];
}

export interface VoidGridSpec {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Cell size (default 512). */
  cell?: number;
  /** Bottom of the trigger volumes. */
  floorZ: number;
  owners: VoidOwner[];
  /** Every legit surface (all ramps and solid boxes runs can be on or fly over). */
  ramps: RampRecord[];
  boxes?: { mins: Vec3; maxs: Vec3 }[];
  /** Clearance below the lowest surface around a cell (default 96). */
  margin?: number;
  /** How many cells around an empty cell are searched for its height (default 3). */
  reach?: number;
}

/**
 * Fills the void under a whole map region with fail teleports. The region is cut into cells; each cell belongs
 * to the owner (section/stage) whose course geometry is nearest, and its trigger's top sits `margin` units
 * below the lowest legit surface over the cell - or, for cells with nothing above them (gaps, open air), below
 * the lowest surface within `reach` cells - so runs that fly over the void never touch it. Cells with equal
 * owner and height are merged into larger boxes. Returns the trigger model numbers.
 */
export function addVoidGrid(b: MapBuilder, s: VoidGridSpec): number[] {
  const cell = s.cell ?? 512;
  const margin = s.margin ?? 96;
  const reach = s.reach ?? 3;
  const nx = Math.max(1, Math.ceil((s.x1 - s.x0) / cell));
  const ny = Math.max(1, Math.ceil((s.y1 - s.y0) / cell));
  const top = new Float64Array(nx * ny).fill(Infinity);
  const owner = new Int32Array(nx * ny).fill(-1);
  // ---- lowest legit surface per cell
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx0 = s.x0 + i * cell;
      const cy0 = s.y0 + j * cell;
      const cx1 = Math.min(s.x1, cx0 + cell);
      const cy1 = Math.min(s.y1, cy0 + cell);
      let z = Infinity;
      for (const r of s.ramps) z = Math.min(z, rampBottomInRect(r, cx0, cx1, cy0, cy1));
      for (const bx of s.boxes ?? []) {
        if (bx.maxs.x < cx0 || bx.mins.x > cx1 || bx.maxs.y < cy0 || bx.mins.y > cy1) continue;
        z = Math.min(z, bx.mins.z);
      }
      top[j * nx + i] = z;
    }
  }
  // ---- empty cells: lowest surface within `reach` cells
  const filled = Float64Array.from(top);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (Number.isFinite(top[j * nx + i])) continue;
      let z = Infinity;
      for (let dj = -reach; dj <= reach; dj++) {
        for (let di = -reach; di <= reach; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          z = Math.min(z, top[jj * nx + ii]);
        }
      }
      filled[j * nx + i] = z;
    }
  }
  // ---- owners: nearest course geometry (sampled every 64 units along ridges and bottom edges)
  const samples: { x: number; y: number; o: number }[] = [];
  s.owners.forEach((ow, oi) => {
    for (const pc of ow.pieces) {
      const len = rampLength(pc.ramp);
      const from = Math.max(0, pc.from ?? 0);
      const to = Math.min(len, pc.to ?? len);
      for (let a = from; a <= to + 1e-6; a += 64) {
        for (const face of pc.ramp.side === 'right' ? (['right'] as const) : pc.ramp.side === 'left' ? (['left'] as const) : (['left', 'right'] as const)) {
          for (const depth of [0, 0.5, 1]) {
            const p = rampPoint(pc.ramp, face, Math.min(a, to), depth);
            samples.push({ x: p.x, y: p.y, o: oi });
          }
        }
      }
    }
    for (const bx of ow.boxes ?? []) {
      for (let x = bx.mins.x; x <= bx.maxs.x + 1e-6; x += 64) {
        for (let y = bx.mins.y; y <= bx.maxs.y + 1e-6; y += 64) samples.push({ x: Math.min(x, bx.maxs.x), y: Math.min(y, bx.maxs.y), o: oi });
      }
    }
  });
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = s.x0 + (i + 0.5) * cell;
      const cy = s.y0 + (j + 0.5) * cell;
      let best = -1;
      let bd = Infinity;
      for (const p of samples) {
        const d = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
        if (d < bd) {
          bd = d;
          best = p.o;
        }
      }
      owner[j * nx + i] = best;
    }
  }
  // ---- quantize heights (so neighbours merge) and greedily merge rectangles of equal owner + height
  const q = new Float64Array(nx * ny);
  for (let k = 0; k < q.length; k++) q[k] = Number.isFinite(filled[k]) ? Math.floor((filled[k] - margin) / 32) * 32 : NaN;
  const used = new Uint8Array(nx * ny);
  const out: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (used[k] || Number.isNaN(q[k]) || owner[k] < 0) continue;
      const o = owner[k];
      const h = q[k];
      const same = (ii: number, jj: number): boolean => {
        const kk = jj * nx + ii;
        return !used[kk] && owner[kk] === o && q[kk] === h;
      };
      let w = 1;
      while (i + w < nx && same(i + w, j)) w++;
      let hgt = 1;
      outer: while (j + hgt < ny) {
        for (let ii = i; ii < i + w; ii++) if (!same(ii, j + hgt)) break outer;
        hgt++;
      }
      for (let jj = j; jj < j + hgt; jj++) for (let ii = i; ii < i + w; ii++) used[jj * nx + ii] = 1;
      if (h <= s.floorZ + 1) continue;
      const mins = v3(s.x0 + i * cell, s.y0 + j * cell, s.floorZ);
      const maxs = v3(Math.min(s.x1, s.x0 + (i + w) * cell), Math.min(s.y1, s.y0 + (j + hgt) * cell), h);
      out.push(b.addTeleport(mins, maxs, s.owners[o].dest));
    }
  }
  return out;
}

export interface PushVolume {
  mins: Vec3;
  maxs: Vec3;
  /** Push velocity (pushdir * speed). */
  push: Vec3;
}

/**
 * Predicts a run's flight (player origin, standing hull, no air control) with Source's trigger_push
 * semantics: while the hull touches a push volume the base velocity is the push - its vertical part is
 * applied as an acceleration (StartGravity), the horizontal part moves the player - and once the player is
 * out, the remaining (horizontal) base velocity is added to the velocity. Stops when the run descends
 * through `untilZ` or after `maxT` seconds.
 */
export function predictFlight(
  start: Vec3,
  vel: Vec3,
  opts: { pushes?: PushVolume[]; untilZ: number; tick?: number; maxT?: number; gravity?: number; stop?: (p: Vec3, v: Vec3) => boolean },
): { pos: Vec3; vel: Vec3; t: number; boosted: boolean } {
  // (throws when the run never descends through untilZ: a design error)
  const ft = 1 / (opts.tick ?? 100);
  const g = opts.gravity ?? 800;
  const p = v3(start.x, start.y, start.z);
  const v = v3(vel.x, vel.y, vel.z);
  const bv = v3();
  let flag = false;
  let boosted = false;
  const maxT = opts.maxT ?? 10;
  let t = 0;
  while (t < maxT) {
    if (!flag && (bv.x || bv.y || bv.z)) {
      v.x += bv.x * (1 + ft * 0.5);
      v.y += bv.y * (1 + ft * 0.5);
      v.z += bv.z * (1 + ft * 0.5);
      bv.x = bv.y = bv.z = 0;
    }
    flag = false;
    v.z -= g * 0.5 * ft;
    v.z += bv.z * ft;
    bv.z = 0;
    const z0 = p.z;
    p.x += (v.x + bv.x) * ft;
    p.y += (v.y + bv.y) * ft;
    p.z += v.z * ft;
    v.z -= g * 0.5 * ft;
    t += ft;
    for (const pv of opts.pushes ?? []) {
      if (p.x + 16 <= pv.mins.x || p.x - 16 >= pv.maxs.x) continue;
      if (p.y + 16 <= pv.mins.y || p.y - 16 >= pv.maxs.y) continue;
      if (p.z + 72 <= pv.mins.z || p.z >= pv.maxs.z) continue;
      bv.x = pv.push.x + (flag ? bv.x : 0);
      bv.y = pv.push.y + (flag ? bv.y : 0);
      bv.z = pv.push.z + (flag ? bv.z : 0);
      flag = true;
      boosted = true;
    }
    if (v.z < 0 && z0 >= opts.untilZ && p.z < opts.untilZ) return { pos: p, vel: v, t, boosted };
    if (opts.stop && opts.stop(p, v)) return { pos: p, vel: v, t, boosted };
  }
  throw new Error(`predictFlight: the run never comes down through z=${opts.untilZ.toFixed(0)} (apex too low or too long)`);
}

/** Push velocity of a trigger_push with Hammer `pushdir` angles (pitch < 0 = upward) and `speed`. */
export function pushVector(pitch: number, yaw: number, speed: number): Vec3 {
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  return v3(Math.cos(p) * Math.cos(y) * speed, Math.cos(p) * Math.sin(y) * speed, -Math.sin(p) * speed);
}
