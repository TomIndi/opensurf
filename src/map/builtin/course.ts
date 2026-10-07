// Course descriptions of the built-in maps: which ramps a run uses in which order, where sections/stages
// begin (fail teleports) and where the run ends. Used by the autopilot (tests, map validation) and handy for
// debugging; the game itself only needs the LoadedMap.
import { Vec3, v3, v3clone } from '../../core/vec3';
import { LoadedMap } from '../types';
import { MapBuilder, RampPathOptions, RampRecord, RampSide, rampHeightFor } from './builder';

export interface CourseRamp {
  ramp: RampRecord;
  /** The face the run surfs (for '^' ramps: the side the line uses). */
  face: 'left' | 'right';
  /**
   * Along-ridge distance (from the ramp start) after which the run deliberately leaves the face (slides off
   * the bottom edge toward the next ramp: transfers). Default: the run leaves over the far end.
   */
  exitAt?: number;
  /** Where on this ramp an incoming run should aim to land: along-ridge distance from the start. */
  landAt?: number;
  /** Depth band (0 = ridge, 1 = bottom edge) the autopilot keeps on this ramp. */
  band?: [number, number];
}

export interface CourseSection {
  name: string;
  /** Teleport destination name used when failing in this section (and where a section restart begins). */
  dest: string;
  ramps: CourseRamp[];
  /** Checkpoint (linear) or stage (staged) number reached at the start of this section (0 = course start). */
  marker: number;
  /**
   * Run-up from the section start onto its first ramp: walk forward along `yaw` this many units before
   * dropping (0 = the destination hovers over the ramp).
   */
  runup?: number;
  /**
   * Staged maps: the stage's exit (a portal teleporting to the next stage room). After the section's last
   * ramp the run heads here instead of to the next section's first ramp.
   */
  exit?: Vec3;
}

export interface Course {
  id: string;
  type: 'linear' | 'staged';
  sections: CourseSection[];
  /** Where the run ends: a point on the end platform inside the end zone. */
  finish: Vec3;
}

export interface BuiltCourse {
  map: LoadedMap;
  course: Course;
  builder: MapBuilder;
}

// ---------------------------------------------------------------------------------------------- layout helper

/** Horizontal unit vector for a yaw in degrees. */
export function dirOf(yaw: number): Vec3 {
  const a = (yaw * Math.PI) / 180;
  return v3(Math.cos(a), Math.sin(a), 0);
}

/** Left (CCW) horizontal perpendicular of a yaw. */
export function leftOf(yaw: number): Vec3 {
  const a = (yaw * Math.PI) / 180;
  return v3(-Math.sin(a), Math.cos(a), 0);
}

export interface StraightSpec {
  /** Horizontal gap from the previous ridge end to this ridge start, along the new direction. */
  gap: number;
  /** Lateral shift of the new ridge start (+ = left of the new direction). */
  shift?: number;
  /**
   * Ridge drop from the previous ridge end to this ridge start. When omitted it is computed ballistically from
   * `speed` and `land`: a run leaving the previous ramp at `speed` (following its ridge descent, at the same
   * depth on the face) lands `land` units into this ramp.
   */
  drop?: number;
  /** Design exit speed of the previous ramp (for the automatic drop). */
  speed?: number;
  /** Design landing distance into this ramp (for the automatic drop; default max(400, gap)). */
  land?: number;
  /** Lateral distance the run travels across the gap (for the automatic drop; default |shift|). */
  travel?: number;
  /** Change of direction (degrees, + = left turn). */
  turn?: number;
  length: number;
  /** Ridge descent along the length, degrees (at the end of the ramp when `dropIn` is set). */
  descent: number;
  /**
   * Drop-in start: the ridge begins `dropIn.angle` degrees steep and eases to `descent` over the first
   * `dropIn.length` units (in `dropIn.steps` straight pieces), so a standing start picks up speed quickly.
   */
  dropIn?: { angle: number; length: number; steps?: number };
  side: RampSide;
  width: number;
  /** Surf face normal.z (sets the height for a level ridge). */
  nz?: number;
  mat?: string;
  sideMat?: string | null;
  trimMat?: string | null;
  name?: string;
}

/**
 * Places ramps relative to each other (a turtle walking the ridge line): each new ramp starts `gap` units
 * after the previous ridge end along its own direction, `drop` units lower.
 */
export class RampChain {
  /** End of the last ridge. */
  pos: Vec3;
  yaw: number;
  /** Ridge descent (degrees) of the last ramp. */
  lastDescent = 0;
  constructor(
    private readonly b: MapBuilder,
    start: Vec3,
    yaw: number,
  ) {
    this.pos = v3clone(start);
    this.yaw = yaw;
  }

  /** Point `along` units ahead, `left` units to the left and `up` units up from the cursor. */
  at(along: number, left = 0, up = 0, yaw = this.yaw): Vec3 {
    const d = dirOf(yaw);
    const l = leftOf(yaw);
    return v3(this.pos.x + d.x * along + l.x * left, this.pos.y + d.y * along + l.y * left, this.pos.z + up);
  }

  /** The ballistic drop for a gap (see StraightSpec.drop). */
  autoDrop(s: { gap: number; shift?: number; speed?: number; land?: number; travel?: number; descent: number }): number {
    if (!(s.speed && s.speed > 0)) throw new Error('RampChain: a ramp without `drop` needs a design `speed`');
    const land = s.land ?? Math.max(400, s.gap);
    const x = Math.hypot(s.gap + land, s.travel ?? Math.abs(s.shift ?? 0));
    const t = x / s.speed;
    const prevTan = Math.tan((this.lastDescent * Math.PI) / 180);
    const nextTan = Math.tan((s.descent * Math.PI) / 180);
    // fall of the run (ridge-following exit velocity + gravity) minus the next face's own descent until the landing
    return x * prevTan + 400 * t * t - land * nextTan;
  }

  straight(s: StraightSpec): RampRecord {
    this.yaw += s.turn ?? 0;
    const d = dirOf(this.yaw);
    const l = leftOf(this.yaw);
    const shift = s.shift ?? 0;
    const drop = s.drop ?? this.autoDrop(s);
    const start = v3(this.pos.x + d.x * s.gap + l.x * shift, this.pos.y + d.y * s.gap + l.y * shift, this.pos.z - drop);
    // ridge profile: optional drop-in pieces, then the constant descent
    const pts: Vec3[] = [start];
    let along = 0;
    let z = start.z;
    const pushTo = (len: number, deg: number): void => {
      along += len;
      z -= len * Math.tan((deg * Math.PI) / 180);
      pts.push(v3(start.x + d.x * along, start.y + d.y * along, z));
    };
    if (s.dropIn && s.dropIn.length > 0) {
      const steps = Math.max(1, s.dropIn.steps ?? 6);
      const piece = Math.min(s.dropIn.length, s.length) / steps;
      for (let i = 0; i < steps; i++) {
        // ease from dropIn.angle to descent (cosine ease-out)
        const t = (i + 0.5) / steps;
        const k = 0.5 + 0.5 * Math.cos(Math.PI * t);
        pushTo(piece, s.descent + (s.dropIn.angle - s.descent) * k);
      }
    }
    if (s.length - along > 1e-6) pushTo(s.length - along, s.descent);
    const end = pts[pts.length - 1];
    const rec = this.b.addRampPath({
      points: pts,
      width: s.width,
      height: rampHeightFor(s.width, s.nz ?? 0.5),
      side: s.side,
      mat: s.mat,
      sideMat: s.sideMat,
      trimMat: s.trimMat,
      name: s.name,
    });
    this.pos = v3clone(end);
    this.lastDescent = s.descent;
    return rec;
  }

  /**
   * A curved ramp: the ridge follows a circular arc of `radius` turning `angle` degrees (+ = left) in
   * `segments` pieces, descending `descent` degrees along its length, starting `gap` ahead / `drop` below.
   */
  curve(s: Omit<StraightSpec, 'length' | 'turn'> & { radius: number; angle: number; segments: number; turn?: number }): RampRecord {
    this.yaw += s.turn ?? 0;
    const d = dirOf(this.yaw);
    const l = leftOf(this.yaw);
    const shift = s.shift ?? 0;
    const drop = s.drop ?? this.autoDrop(s);
    const start = v3(this.pos.x + d.x * s.gap + l.x * shift, this.pos.y + d.y * s.gap + l.y * shift, this.pos.z - drop);
    const sign = s.angle >= 0 ? 1 : -1;
    // arc center lies to the turning side
    const c = v3(start.x + l.x * s.radius * sign, start.y + l.y * s.radius * sign, 0);
    const a0 = Math.atan2(start.y - c.y, start.x - c.x);
    const total = (Math.abs(s.angle) * Math.PI) / 180;
    const arcLen = total * s.radius;
    const fall = arcLen * Math.tan((s.descent * Math.PI) / 180);
    const pts: Vec3[] = [];
    for (let i = 0; i <= s.segments; i++) {
      const t = i / s.segments;
      const a = a0 + sign * total * t;
      pts.push(v3(c.x + Math.cos(a) * s.radius, c.y + Math.sin(a) * s.radius, start.z - fall * t));
    }
    const opts: RampPathOptions = {
      points: pts,
      width: s.width,
      height: rampHeightFor(s.width, s.nz ?? 0.5),
      side: s.side,
      mat: s.mat,
      sideMat: s.sideMat,
      trimMat: s.trimMat,
      name: s.name,
    };
    const rec = this.b.addRampPath(opts);
    this.pos = v3clone(pts[pts.length - 1]);
    this.yaw += s.angle;
    this.lastDescent = s.descent;
    return rec;
  }
}

// ---------------------------------------------------------------------------------------------- ramp geometry queries

export interface RampFrame {
  /** Segment index. */
  seg: number;
  /** Along-ridge distance from the ramp start (horizontal). */
  along: number;
  /** Total horizontal ridge length. */
  length: number;
  /** Horizontal unit tangent of the segment. */
  tangent: Vec3;
  /** Horizontal unit vector from the ridge toward the surfed face's bottom edge. */
  out: Vec3;
  /** Lateral distance from the ridge toward `out`. */
  lateral: number;
  /** Ridge height at this point. */
  ridgeZ: number;
  /** Outward surf face normal of this segment (for the given face). */
  normal: Vec3;
}

function horizLen(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Total horizontal ridge length of a ramp. */
export function rampLength(r: RampRecord): number {
  let s = 0;
  for (let i = 0; i + 1 < r.points.length; i++) s += horizLen(r.points[i], r.points[i + 1]);
  return s;
}

/** Local frame of a ramp at the horizontal position of `p` (clamped to the ramp's extent). */
export function rampFrame(r: RampRecord, face: 'left' | 'right', p: Vec3): RampFrame {
  const pts = r.points;
  const last = pts.length - 2;
  let best = 0;
  let bestT = 0;
  let bestD = Infinity;
  let rawT = 0;
  for (let i = 0; i <= last; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
    const tc = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + dx * tc), p.y - (a.y + dy * tc));
    if (d < bestD - 1e-9) {
      bestD = d;
      best = i;
      bestT = tc;
      rawT = t;
    }
  }
  // beyond the ends: extrapolate along the end segments
  if (best === 0 && rawT < 0) bestT = rawT;
  if (best === last && rawT > 1) bestT = rawT;
  const a = pts[best];
  const b = pts[best + 1];
  const segLen = horizLen(a, b);
  const tangent = v3((b.x - a.x) / segLen, (b.y - a.y) / segLen, 0);
  const left = v3(-tangent.y, tangent.x, 0);
  const out = face === 'left' ? left : v3(-left.x, -left.y, 0);
  let along = 0;
  for (let i = 0; i < best; i++) along += horizLen(pts[i], pts[i + 1]);
  along += bestT * segLen;
  const qx = a.x + (b.x - a.x) * bestT;
  const qy = a.y + (b.y - a.y) * bestT;
  const lateral = (p.x - qx) * out.x + (p.y - qy) * out.y;
  const ridgeZ = a.z + (b.z - a.z) * bestT;
  // face normal from the segment's ribs
  const rib0 = r.ribs[best];
  const rib1 = r.ribs[best + 1];
  const bi = r.side === 'both' ? (face === 'left' ? 1 : 2) : 1;
  const e1 = v3(rib1[0].x - rib0[0].x, rib1[0].y - rib0[0].y, rib1[0].z - rib0[0].z);
  const e2 = v3(rib0[bi].x - rib0[0].x, rib0[bi].y - rib0[0].y, rib0[bi].z - rib0[0].z);
  let nx = e1.y * e2.z - e1.z * e2.y;
  let ny = e1.z * e2.x - e1.x * e2.z;
  let nz = e1.x * e2.y - e1.y * e2.x;
  if (nz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const nl = Math.hypot(nx, ny, nz);
  return { seg: best, along, length: rampLength(r), tangent, out, lateral, ridgeZ, normal: v3(nx / nl, ny / nl, nz / nl) };
}

/** A point on the surfed face: `along` the ridge, `depth` (0 = ridge, 1 = bottom edge) down the face. */
export function rampPoint(r: RampRecord, face: 'left' | 'right', along: number, depth: number): Vec3 {
  const pts = r.points;
  let rem = Math.max(0, along);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const l = horizLen(a, b);
    if (rem <= l || i === pts.length - 2) {
      const t = Math.min(1, rem / l);
      const tx = (b.x - a.x) / l;
      const ty = (b.y - a.y) / l;
      const lx = face === 'left' ? -ty : ty;
      const ly = face === 'left' ? tx : -tx;
      const lat = r.width * depth;
      return v3(a.x + (b.x - a.x) * t + lx * lat, a.y + (b.y - a.y) * t + ly * lat, a.z + (b.z - a.z) * t - r.height * depth);
    }
    rem -= l;
  }
  return v3clone(pts[pts.length - 1]);
}
