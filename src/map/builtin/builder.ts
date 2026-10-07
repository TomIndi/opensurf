// MapBuilder: assembles a procedural surf map (brushes, render batches, entities, triggers, zones) into the
// same LoadedMap a real BSP produces, so the game, renderer and physics treat built-in maps exactly like
// downloaded ones.
//
// Conventions (Source): Z up, units = inches, player hull 32x32x72 with the origin at the feet.
//
// Surf ramps are triangular prisms extruded along a "ridge" polyline (the top edge). Consecutive segments
// of one ramp share their cross-section ("rib") vertices exactly, so seams have no step, gap or
// protruding edge for the player box to snag on. Every surf face is checked to have a normal.z in
// [RAMP_MIN_NZ, RAMP_MAX_NZ]: steep enough to never count as ground (< 0.7), shallow enough to be a
// comfortable classic 53-63 degree surf.
import { QAngle, qa } from '../../core/angles';
import { Vec3, v3, v3clone } from '../../core/vec3';
import { fallbackMaterial } from '../../bsp/materials';
import { brushFromBox, brushFromPlanes, brushFromPoints, brushWindings } from '../../physics/brushbuild';
import { CollisionWorld } from '../../physics/collision';
import { Brush, CONTENTS_SOLID, CONTENTS_TRIGGER_INTERNAL, Plane } from '../../physics/types';
import type {
  BrushModelInfo,
  FogDef,
  LoadedMap,
  MapEntity,
  MaterialDef,
  RenderBatch,
  SpawnPoint,
  ZoneDef,
  ZoneType,
} from '../types';

/**
 * Surf faces must stay within these normal.z bounds (ground is normal.z >= 0.7): 48-63 degree slopes. The
 * KSF maps themselves cluster around 0.62-0.65 (measured area-weighted over surf_utopia_njv, surf_kitsune,
 * surf_beginner, surf_rookie, surf_ing and surf_aircontrol_ksf: medians 0.615-0.655), so that is the default.
 */
export const RAMP_MIN_NZ = 0.45;
export const RAMP_MAX_NZ = 0.66;
/** The classic KSF ramp: normal.z 0.62, a 51.7 degree slope. */
export const DEFAULT_RAMP_NZ = 0.62;

export type RampSide = 'left' | 'right' | 'both';

/** Per-face materials of a box: null = not drawn (nodraw). */
export interface BoxMaterials {
  top?: string | null;
  bottom?: string | null;
  sides?: string | null;
}

export type MaterialSpec = string | null | BoxMaterials;

export interface RampOptions {
  /** Ridge (top edge) start, where the run enters the ramp. */
  start: Vec3;
  /** Ridge end, where the run leaves the ramp. Lower than `start` for a ramp that descends along its length. */
  end: Vec3;
  /** Horizontal run of EACH surf face, measured perpendicular to the ridge (the '^' ramp is 2x wide). */
  width: number;
  /** Vertical drop from the ridge to the bottom edge of the surf face(s). */
  height: number;
  /** Which side of the ridge (looking from start to end) carries the surf face; 'both' = classic ^ ramp. */
  side: RampSide;
  /** Surf face material. */
  mat?: string;
  /** Material of the caps, back wall and underside (default: `mat`). */
  sideMat?: string | null;
  /** Optional glowing trim material along the ridge and the bottom edge of every surf face (render only). */
  trimMat?: string | null;
  /** Trim strip width (default 10). */
  trimWidth?: number;
  /** Name for debugging / course descriptions. */
  name?: string;
}

export interface RampPathOptions extends Omit<RampOptions, 'start' | 'end'> {
  /** Ridge polyline (>= 2 points). Joints are mitered so neighbouring segments share their cross-section. */
  points: Vec3[];
}

/** What the builder remembers about every ramp (used by course descriptions, tests and bots). */
export interface RampRecord {
  name: string;
  side: RampSide;
  width: number;
  height: number;
  /** Ridge polyline. */
  points: Vec3[];
  /**
   * Cross-sections at every ridge point: ridge, then the bottom edge points of the surf face(s): for
   * 'left'/'right' [ridge, outerBottom, backBottom], for 'both' [ridge, leftBottom, rightBottom].
   */
  ribs: Vec3[][];
  brushes: Brush[];
  /** Surf face normals (all segments, both faces for '^' ramps). */
  surfNormals: Vec3[];
}

export interface TriggerRecord {
  classname: string;
  model: number;
  mins: Vec3;
  maxs: Vec3;
  entity: MapEntity;
}

interface RenderBrush {
  brush: Brush;
  /** Material for a side, or null to skip it. */
  mat: (normal: Vec3, sideIndex: number) => string | null;
}

/** A ramp surf face drawn straight from its ribs: smooth normals and continuous UVs across segments. */
interface RenderStrip {
  mat: string;
  /** Per rib: ridge point and face bottom point. */
  top: Vec3[];
  bottom: Vec3[];
  /** Per rib vertex normals (averaged over the neighbouring segments). */
  normals: Vec3[];
  /** Texture coordinates in world units: u along the ridge (shared by the whole rib), v down the face. */
  u: number[];
  vBottom: number[];
}

interface RenderPoly {
  points: Vec3[];
  normal: Vec3;
  mat: string;
  model: number;
}

interface BatchAcc {
  model: number;
  material: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  mins: Vec3;
  maxs: Vec3;
}

/** Texture repeat (world units per texture tile) by material pattern. */
function tileSizeFor(name: string): number {
  const n = name.toLowerCase();
  if (/(^|[/_])glow/.test(n)) return 128;
  if (/(^|[/_])ramp/.test(n)) return 512;
  if (/(^|[/_])floor/.test(n)) return 256;
  if (/(^|[/_])grid/.test(n)) return 512;
  if (/(^|[/_])wall/.test(n)) return 256;
  return 256;
}

function hnorm(x: number, y: number): [number, number] {
  const l = Math.hypot(x, y);
  if (!(l > 1e-9)) throw new Error('MapBuilder: degenerate horizontal direction');
  return [x / l, y / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return v3(a.x - b.x, a.y - b.y, a.z - b.z);
}

function add(a: Vec3, b: Vec3): Vec3 {
  return v3(a.x + b.x, a.y + b.y, a.z + b.z);
}

function scale(a: Vec3, s: number): Vec3 {
  return v3(a.x * s, a.y * s, a.z * s);
}

function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z);
  if (!(l > 1e-12)) return v3();
  return v3(a.x / l, a.y / l, a.z / l);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function boxMatFn(spec: MaterialSpec): (n: Vec3) => string | null {
  if (spec === null || typeof spec === 'string') return () => spec;
  return (n) => {
    if (n.z > 0.7) return spec.top === undefined ? (spec.sides ?? null) : spec.top;
    if (n.z < -0.7) return spec.bottom === undefined ? (spec.sides ?? null) : spec.bottom;
    return spec.sides ?? null;
  };
}

/** Horizontal yaw (degrees) of a direction. */
export function yawOf(d: Vec3): number {
  return (Math.atan2(d.y, d.x) * 180) / Math.PI;
}

/** Ramp height that gives a straight (level) ramp of the given face width the requested normal.z. */
export function rampHeightFor(width: number, normalZ = DEFAULT_RAMP_NZ): number {
  return (width * Math.sqrt(1 - normalZ * normalZ)) / normalZ;
}

/**
 * Points along a horizontal arc for curved ramp ridges: center, radius, start/end angle (degrees, CCW from +x),
 * start/end height, `segments` pieces (segments + 1 points). Heights are interpolated linearly in angle.
 */
export function arcPoints(center: Vec3, radius: number, a0: number, a1: number, z0: number, z1: number, segments: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
    out.push(v3(center.x + Math.cos(a) * radius, center.y + Math.sin(a) * radius, z0 + (z1 - z0) * t));
  }
  return out;
}

export interface ZoneOptions {
  group?: number;
  index?: number;
  prespeed?: number;
  spawn?: { origin: Vec3; yaw: number };
}

export interface BuilderOptions {
  sky?: string;
  fog?: FogDef | null;
}

export class MapBuilder {
  readonly name: string;
  sky: string;
  fog: FogDef | null;

  private readonly worldBrushes: Brush[] = [];
  private readonly renderBrushes: RenderBrush[] = [];
  private readonly renderPolys: RenderPoly[] = [];
  private readonly renderStrips: RenderStrip[] = [];
  private readonly materialColors = new Map<string, [number, number, number]>();
  private readonly models: BrushModelInfo[] = [];
  private readonly entityKvs: { kv: Record<string, string>; model: number }[] = [];
  private readonly spawns: SpawnPoint[] = [];
  private readonly zones: ZoneDef[] = [];
  readonly ramps: RampRecord[] = [];
  readonly triggers: { classname: string; model: number; mins: Vec3; maxs: Vec3; kv: Record<string, string> }[] = [];
  private readonly destinations = new Map<string, { origin: Vec3; yaw: number }>();

  constructor(name: string, opts: BuilderOptions = {}) {
    this.name = name;
    this.sky = opts.sky ?? 'sky_day01_01';
    this.fog = opts.fog ?? null;
  }

  // ------------------------------------------------------------------------------------ world geometry

  /** Solid axis-aligned box (world brush). */
  addBox(mins: Vec3, maxs: Vec3, mat: MaterialSpec): Brush {
    const b = brushFromBox(mins, maxs, CONTENTS_SOLID, 0);
    if (!(b.maxs.x - b.mins.x > 0 && b.maxs.y - b.mins.y > 0 && b.maxs.z - b.mins.z > 0)) {
      throw new Error(`MapBuilder(${this.name}): degenerate box ${JSON.stringify([mins, maxs])}`);
    }
    this.worldBrushes.push(b);
    const fn = boxMatFn(mat);
    this.renderBrushes.push({ brush: b, mat: (n) => fn(n) });
    return b;
  }

  /** A solid convex brush from points (world brush), drawn with `mat`. */
  addHull(points: Vec3[], mat: MaterialSpec): Brush {
    const b = brushFromPoints(points, CONTENTS_SOLID, 0);
    if (!b) throw new Error(`MapBuilder(${this.name}): degenerate hull`);
    this.worldBrushes.push(b);
    const fn = boxMatFn(mat);
    this.renderBrushes.push({ brush: b, mat: (n) => fn(n) });
    return b;
  }

  /**
   * A platform whose walkable top is centered at `topCenter`: sizeX x sizeY, `thickness` deep.
   * Returns the brush.
   */
  addPlatform(topCenter: Vec3, sizeX: number, sizeY: number, mat: MaterialSpec, thickness = 32): Brush {
    return this.addBox(
      v3(topCenter.x - sizeX / 2, topCenter.y - sizeY / 2, topCenter.z - thickness),
      v3(topCenter.x + sizeX / 2, topCenter.y + sizeY / 2, topCenter.z),
      mat,
    );
  }

  /**
   * A closed room around the interior box [mins, maxs] (floor at mins.z, ceiling at maxs.z) with walls
   * `thick` units thick, and rectangular openings: `side` is the wall ('+x', '-x', '+y', '-y'); the hole
   * is [a0, a1] along the wall's horizontal axis and [z0, z1] in height (absolute coordinates).
   */
  addRoom(
    mins: Vec3,
    maxs: Vec3,
    mats: { floor: string | null; wall: string | null; ceiling: string | null },
    openings: { side: '+x' | '-x' | '+y' | '-y'; a0: number; a1: number; z0: number; z1: number }[] = [],
    thick = 16,
  ): void {
    const t = thick;
    // floor and ceiling slabs span the full outer footprint
    this.addBox(v3(mins.x - t, mins.y - t, mins.z - t), v3(maxs.x + t, maxs.y + t, mins.z), { top: mats.floor, sides: mats.wall, bottom: mats.wall });
    this.addBox(v3(mins.x - t, mins.y - t, maxs.z), v3(maxs.x + t, maxs.y + t, maxs.z + t), { bottom: mats.ceiling, sides: mats.wall, top: mats.wall });
    const walls: { side: '+x' | '-x' | '+y' | '-y'; lo: Vec3; hi: Vec3 }[] = [
      { side: '-x', lo: v3(mins.x - t, mins.y - t, mins.z), hi: v3(mins.x, maxs.y + t, maxs.z) },
      { side: '+x', lo: v3(maxs.x, mins.y - t, mins.z), hi: v3(maxs.x + t, maxs.y + t, maxs.z) },
      { side: '-y', lo: v3(mins.x, mins.y - t, mins.z), hi: v3(maxs.x, mins.y, maxs.z) },
      { side: '+y', lo: v3(mins.x, maxs.y, mins.z), hi: v3(maxs.x, maxs.y + t, maxs.z) },
    ];
    for (const w of walls) {
      const holes = openings.filter((o) => o.side === w.side);
      const alongX = w.side === '-y' || w.side === '+y';
      let pieces: { lo: Vec3; hi: Vec3 }[] = [{ lo: w.lo, hi: w.hi }];
      for (const h of holes) {
        const next: { lo: Vec3; hi: Vec3 }[] = [];
        for (const p of pieces) next.push(...cutHole(p, alongX, h.a0, h.a1, h.z0, h.z1));
        pieces = next;
      }
      for (const p of pieces) this.addBox(p.lo, p.hi, mats.wall);
    }
  }

  /** A straight surf ramp. */
  addRamp(o: RampOptions): RampRecord {
    const { start, end, ...rest } = o;
    return this.addRampPath({ ...rest, points: [start, end] });
  }

  /**
   * A surf ramp along a ridge polyline. Each segment is the convex hull of the cross-sections ("ribs") at
   * its two ends; interior ribs are mitered (bisector plane, widened by 1/cos of the half turn) and shared
   * by both neighbours, so the surf faces meet exactly.
   */
  addRampPath(o: RampPathOptions): RampRecord {
    const pts = o.points.map(v3clone);
    if (pts.length < 2) throw new Error(`MapBuilder(${this.name}): ramp needs >= 2 points`);
    if (!(o.width > 0 && o.height > 0)) throw new Error(`MapBuilder(${this.name}): ramp width/height must be > 0`);
    const n = pts.length;
    // horizontal unit directions of every segment
    const dirs: [number, number][] = [];
    for (let i = 0; i < n - 1; i++) dirs.push(hnorm(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
    for (let i = 1; i < n - 1; i++) {
      const c = dirs[i - 1][0] * dirs[i][0] + dirs[i - 1][1] * dirs[i][1];
      if (c < 0.7) throw new Error(`MapBuilder(${this.name}): ramp turns too sharply at point ${i}`);
    }
    // Every segment's surf face is an exact plane: through the ridge segment, spanned by the ridge direction and
    // the nominal cross-section edge (width out, height down). At a joint the face's bottom corner lies on the
    // line where the two neighbouring face planes meet, so both segments share that edge exactly - no fold
    // inside a face (a fold makes Source's multi-plane clipping eat speed) and no step at the seam. For level
    // curves this is the classic miter; for straight runs with changing descent, a vertical cross-section.
    const w = o.width;
    const h = o.height;
    const faceSides: (1 | -1)[] = o.side === 'left' ? [1] : o.side === 'right' ? [-1] : [1, -1];
    const faceBottoms: Vec3[][] = faceSides.map((sgn) => {
      const edges: Vec3[] = [];
      const normals: Vec3[] = [];
      for (let k = 0; k < n - 1; k++) {
        const D = sub(pts[k + 1], pts[k]);
        const e = v3(-dirs[k][1] * w * sgn, dirs[k][0] * w * sgn, -h);
        let nrm = norm(cross(D, e));
        if (nrm.z < 0) nrm = scale(nrm, -1);
        edges.push(e);
        normals.push(nrm);
      }
      const out: Vec3[] = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (i === 0 || i === n - 1) {
          out.push(add(p, edges[i === 0 ? 0 : n - 2]));
          continue;
        }
        const L = cross(normals[i - 1], normals[i]);
        const ll = Math.hypot(L.x, L.y, L.z);
        if (ll < 1e-9 || Math.abs(L.z) < 1e-6 * ll) {
          out.push(add(p, edges[i - 1]));
          continue;
        }
        out.push(add(p, scale(L, -h / L.z)));
      }
      return out;
    });
    const ribs: Vec3[][] = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (o.side === 'both') ribs.push([v3clone(p), faceBottoms[0][i], faceBottoms[1][i]]);
      else ribs.push([v3clone(p), faceBottoms[0][i], v3(p.x, p.y, p.z - h)]);
    }
    const mat = o.mat ?? 'builtin/ramp_grey';
    const sideMat = o.sideMat === undefined ? mat : o.sideMat;
    const rec: RampRecord = {
      name: o.name ?? `ramp${this.ramps.length + 1}`,
      side: o.side,
      width: o.width,
      height: o.height,
      points: pts,
      ribs,
      brushes: [],
      surfNormals: [],
    };
    const segs: Brush[] = [];
    for (let i = 0; i < n - 1; i++) {
      const b = brushFromPoints([...ribs[i], ...ribs[i + 1]], CONTENTS_SOLID, 0);
      if (!b) throw new Error(`MapBuilder(${this.name}): degenerate ramp segment ${i} of ${rec.name}`);
      for (const sd of b.sides) {
        if (sd.bevel) continue;
        const nz = sd.plane.normal.z;
        if (nz > 0.05 && nz < 0.7) {
          if (nz < RAMP_MIN_NZ - 1e-9 || nz > RAMP_MAX_NZ + 1e-9) {
            throw new Error(`MapBuilder(${this.name}): ${rec.name} surf face normal.z ${nz.toFixed(4)} outside [${RAMP_MIN_NZ}, ${RAMP_MAX_NZ}]`);
          }
          rec.surfNormals.push(v3clone(sd.plane.normal));
        } else if (nz >= 0.7) {
          throw new Error(`MapBuilder(${this.name}): ${rec.name} has a walkable top face (normal.z ${nz.toFixed(3)})`);
        }
      }
      segs.push(b);
      // the exact segment is what gets drawn - minus its surf faces (drawn as smooth strips below) and the caps
      // it shares with its neighbours (inside the ramp; drawn edge-on they would show as dark seam lines)
      const ws = brushWindings(b);
      const onRib = (w: Vec3[], rib: Vec3[]): boolean =>
        w.every((p) => rib.some((q) => Math.abs(p.x - q.x) < 0.05 && Math.abs(p.y - q.y) < 0.05 && Math.abs(p.z - q.z) < 0.05));
      const hidden = new Set<number>();
      b.sides.forEach((sd, k) => {
        if (sd.bevel || ws[k].length < 3) return;
        const nz = sd.plane.normal.z;
        if (nz > 0.05 && nz < 0.7) hidden.add(k);
        else if ((i > 0 && onRib(ws[k], ribs[i])) || (i < n - 2 && onRib(ws[k], ribs[i + 1]))) hidden.add(k);
      });
      this.renderBrushes.push({ brush: b, mat: (_nrm, k) => (hidden.has(k) ? null : sideMat) });
      if (o.trimMat) this.addRampTrim(ribs[i], ribs[i + 1], o.side, o.trimMat, o.trimWidth ?? 10);
    }
    // smooth surf strips (one per face)
    for (const bi of o.side === 'both' ? [1, 2] : [1]) {
      const top = ribs.map((r) => r[0]);
      const bottom = ribs.map((r) => r[bi]);
      const segN: Vec3[] = [];
      for (let k = 0; k < n - 1; k++) {
        let nn = norm(cross(sub(top[k + 1], top[k]), sub(bottom[k], top[k])));
        if (nn.z < 0) nn = scale(nn, -1);
        segN.push(nn);
      }
      const normals = top.map((_, k) => norm(add(segN[Math.max(0, k - 1)], segN[Math.min(n - 2, k)])));
      const u: number[] = [0];
      for (let k = 1; k < n; k++) u.push(u[k - 1] + Math.hypot(top[k].x - top[k - 1].x, top[k].y - top[k - 1].y, top[k].z - top[k - 1].z));
      const vBottom = top.map((t, k) => Math.hypot(bottom[k].x - t.x, bottom[k].y - t.y, bottom[k].z - t.z));
      this.renderStrips.push({ mat, top, bottom, normals, u, vBottom });
    }
    // Collision uses overlapping segments (see seamlessSegments): no brush edge at the visible seams.
    for (const b of segs.length > 1 ? seamlessSegments(segs, ribs) : segs) {
      this.worldBrushes.push(b);
      rec.brushes.push(b);
    }
    this.ramps.push(rec);
    return rec;
  }

  /** Glowing strips along the ridge and the bottom edge of each surf face of one segment (render only). */
  private addRampTrim(r0: Vec3[], r1: Vec3[], side: RampSide, mat: string, width: number): void {
    const faces: [number, number][] = side === 'both' ? [[0, 1], [0, 2]] : [[0, 1]];
    for (const [ri, bi] of faces) {
      const a0 = r0[ri];
      const a1 = r1[ri];
      const b0 = r0[bi];
      const b1 = r1[bi];
      // average outward normal of the quad a0 a1 b1 b0
      let nrm = norm(add(cross(sub(a1, a0), sub(b0, a0)), cross(sub(b0, b1), sub(a1, b1))));
      if (nrm.z < 0) nrm = scale(nrm, -1);
      const lift = scale(nrm, 0.6);
      const l0 = Math.hypot(b0.x - a0.x, b0.y - a0.y, b0.z - a0.z);
      const l1 = Math.hypot(b1.x - a1.x, b1.y - a1.y, b1.z - a1.z);
      const f0 = Math.min(0.45, width / l0);
      const f1 = Math.min(0.45, width / l1);
      const lerp = (p: Vec3, q: Vec3, t: number): Vec3 => v3(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t);
      // ridge strip and bottom strip
      this.addQuadOriented([a0, a1, lerp(a1, b1, f1), lerp(a0, b0, f0)], nrm, lift, mat);
      this.addQuadOriented([lerp(b0, a0, f0), lerp(b1, a1, f1), b1, b0], nrm, lift, mat);
    }
  }

  /** Render-only quad (any winding; it is oriented to face `normal`), offset by `lift`. */
  private addQuadOriented(q: Vec3[], normal: Vec3, lift: Vec3, mat: string, model = 0): void {
    const pts = q.map((p) => add(p, lift));
    const n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    if (dot(n, normal) < 0) pts.reverse();
    this.renderPolys.push({ points: pts, normal: v3clone(normal), mat, model });
  }

  /**
   * Render-only flat polygon (no collision), e.g. glowing trims and signs. Points are oriented to face
   * `normal` and pushed `lift` units along it.
   */
  addDecal(points: Vec3[], normal: Vec3, mat: string, lift = 0.5): void {
    const n = norm(normal);
    const pts = points.map((p) => add(p, scale(n, lift)));
    const c = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    if (dot(c, n) < 0) pts.reverse();
    this.renderPolys.push({ points: pts, normal: n, mat, model: 0 });
  }

  /** Render-only glowing outline of a box's top edges (a band `width` wide on the top face, inset). */
  addTopTrim(mins: Vec3, maxs: Vec3, mat: string, width = 8): void {
    const z = maxs.z;
    const up = v3(0, 0, 1);
    const w = width;
    this.addDecal([v3(mins.x, mins.y, z), v3(maxs.x, mins.y, z), v3(maxs.x, mins.y + w, z), v3(mins.x, mins.y + w, z)], up, mat);
    this.addDecal([v3(mins.x, maxs.y - w, z), v3(maxs.x, maxs.y - w, z), v3(maxs.x, maxs.y, z), v3(mins.x, maxs.y, z)], up, mat);
    this.addDecal([v3(mins.x, mins.y + w, z), v3(mins.x + w, mins.y + w, z), v3(mins.x + w, maxs.y - w, z), v3(mins.x, maxs.y - w, z)], up, mat);
    this.addDecal([v3(maxs.x - w, mins.y + w, z), v3(maxs.x, mins.y + w, z), v3(maxs.x, maxs.y - w, z), v3(maxs.x - w, maxs.y - w, z)], up, mat);
  }

  /**
   * Gives a built-in material a custom colour (sRGB 0..1) instead of the colour word in its name. The name must
   * not contain a colour word (e.g. "builtin/grid_sea").
   */
  setMaterialColor(name: string, srgb: [number, number, number]): void {
    this.materialColors.set(name, srgb);
  }

  // ------------------------------------------------------------------------------------ entities

  /** Adds a point entity (keyvalues are stored lower-cased). Returns the keyvalues for further edits. */
  addEntity(classname: string, kv: Record<string, string> = {}): Record<string, string> {
    const out: Record<string, string> = { classname };
    for (const k of Object.keys(kv)) out[k.toLowerCase()] = kv[k];
    out.classname = classname;
    this.entityKvs.push({ kv: out, model: -1 });
    return out;
  }

  /** Player spawn: info_player_counterterrorist (+ info_player_terrorist) at `origin` facing `yaw`. */
  addSpawn(origin: Vec3, yaw: number): void {
    const ang = `0 ${fmt(yaw)} 0`;
    this.addEntity('info_player_counterterrorist', { origin: vecStr(origin), angles: ang });
    this.addEntity('info_player_terrorist', { origin: vecStr(origin), angles: ang });
    this.spawns.push({ origin: v3clone(origin), angles: qa(0, yaw, 0) });
  }

  /** info_teleport_destination. */
  addDestination(name: string, origin: Vec3, yaw: number): void {
    if (this.destinations.has(name)) throw new Error(`MapBuilder(${this.name}): duplicate destination ${name}`);
    this.destinations.set(name, { origin: v3clone(origin), yaw });
    this.addEntity('info_teleport_destination', { targetname: name, origin: vecStr(origin), angles: `0 ${fmt(yaw)} 0` });
  }

  /** Where a destination is (for tests and course descriptions). */
  destination(name: string): { origin: Vec3; yaw: number } | null {
    const d = this.destinations.get(name);
    return d ? { origin: v3clone(d.origin), yaw: d.yaw } : null;
  }

  /** A brush trigger entity occupying the box: a new brush model "*N". Returns the model index. */
  addTrigger(classname: string, mins: Vec3, maxs: Vec3, kv: Record<string, string> = {}): number {
    const model = this.models.length + 1; // models[0] is the world, added at build()
    const b = brushFromBox(mins, maxs, CONTENTS_TRIGGER_INTERNAL, model);
    const info: BrushModelInfo = { index: model, mins: v3clone(b.mins), maxs: v3clone(b.maxs), origin: v3(), brushes: [b] };
    this.models.push(info);
    const out: Record<string, string> = { classname, model: `*${model}`, origin: '0 0 0', spawnflags: '1', startdisabled: '0' };
    for (const k of Object.keys(kv)) out[k.toLowerCase()] = kv[k];
    out.classname = classname;
    out.model = `*${model}`;
    this.entityKvs.push({ kv: out, model });
    this.triggers.push({ classname, model, mins: v3clone(b.mins), maxs: v3clone(b.maxs), kv: out });
    return model;
  }

  /** trigger_teleport to the info_teleport_destination `dest` (clients only: spawnflags 1). */
  addTeleport(mins: Vec3, maxs: Vec3, dest: string, name?: string): number {
    const kv: Record<string, string> = { target: dest, spawnflags: '1' };
    if (name) kv.targetname = name;
    return this.addTrigger('trigger_teleport', mins, maxs, kv);
  }

  /**
   * trigger_push: while touching, the player gets base velocity `speed` along `pushdir` ("pitch yaw roll"
   * angles as in Hammer). `once` makes it a one-shot impulse (spawnflags 128) that removes itself.
   */
  addPush(mins: Vec3, maxs: Vec3, pushdir: QAngle, speed: number, once = false): number {
    return this.addTrigger('trigger_push', mins, maxs, {
      pushdir: `${fmt(pushdir.pitch)} ${fmt(pushdir.yaw)} ${fmt(pushdir.roll)}`,
      speed: fmt(speed),
      spawnflags: String(1 | (once ? 128 : 0)),
    });
  }

  /** A timer zone (start/end/stage/checkpoint...). */
  addZone(type: ZoneType, mins: Vec3, maxs: Vec3, o: ZoneOptions = {}): ZoneDef {
    const z: ZoneDef = {
      type,
      group: o.group ?? 0,
      index: o.index ?? 0,
      mins: v3(Math.min(mins.x, maxs.x), Math.min(mins.y, maxs.y), Math.min(mins.z, maxs.z)),
      maxs: v3(Math.max(mins.x, maxs.x), Math.max(mins.y, maxs.y), Math.max(mins.z, maxs.z)),
    };
    if (o.prespeed !== undefined) z.prespeed = o.prespeed;
    if (o.spawn) z.spawn = { origin: v3clone(o.spawn.origin), angles: qa(0, o.spawn.yaw, 0) };
    this.zones.push(z);
    return z;
  }

  // ------------------------------------------------------------------------------------ output

  build(): LoadedMap {
    // ---- entities: worldspawn first
    const ents: MapEntity[] = [];
    const world: Record<string, string> = {
      classname: 'worldspawn',
      skyname: this.sky,
      mapversion: '1',
      maxpropscreenwidth: '-1',
      detailvbsp: 'detail.vbsp',
      detailmaterial: 'detail/detailsprites',
    };
    const all = [{ kv: world, model: 0 }, ...this.entityKvs];
    if (this.fog && this.fog.enabled) {
      const c = this.fog.color.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(' ');
      all.push({
        kv: {
          classname: 'env_fog_controller',
          fogenable: '1',
          fogcolor: c,
          fogcolor2: c,
          fogstart: fmt(this.fog.start),
          fogend: fmt(this.fog.end),
          fogmaxdensity: fmt(this.fog.maxDensity),
          origin: '0 0 0',
        },
        model: -1,
      });
    }
    for (let i = 0; i < all.length; i++) {
      const kv = all[i].kv;
      ents.push({
        index: i,
        classname: kv.classname,
        targetname: kv.targetname ?? '',
        kv,
        outputs: [],
        origin: parseVec(kv.origin),
        angles: parseAngles(kv.angles),
        model: all[i].model > 0 ? all[i].model : -1,
      });
    }
    // every teleport must point at an existing destination
    for (const t of this.triggers) {
      if (t.classname === 'trigger_teleport' && !this.destinations.has(t.kv.target)) {
        throw new Error(`MapBuilder(${this.name}): trigger_teleport *${t.model} targets missing destination "${t.kv.target}"`);
      }
    }

    // ---- models
    const wmins = v3(Infinity, Infinity, Infinity);
    const wmaxs = v3(-Infinity, -Infinity, -Infinity);
    const grow = (lo: Vec3, hi: Vec3): void => {
      wmins.x = Math.min(wmins.x, lo.x);
      wmins.y = Math.min(wmins.y, lo.y);
      wmins.z = Math.min(wmins.z, lo.z);
      wmaxs.x = Math.max(wmaxs.x, hi.x);
      wmaxs.y = Math.max(wmaxs.y, hi.y);
      wmaxs.z = Math.max(wmaxs.z, hi.z);
    };
    for (const b of this.worldBrushes) grow(b.mins, b.maxs);
    const worldModel: BrushModelInfo = { index: 0, mins: v3clone(wmins), maxs: v3clone(wmaxs), origin: v3(), brushes: this.worldBrushes };
    for (const m of this.models) grow(m.mins, m.maxs);
    if (!Number.isFinite(wmins.x)) {
      wmins.x = wmins.y = wmins.z = -1;
      wmaxs.x = wmaxs.y = wmaxs.z = 1;
      worldModel.mins = v3clone(wmins);
      worldModel.maxs = v3clone(wmaxs);
    }
    const models: BrushModelInfo[] = [worldModel, ...this.models];

    // ---- render
    const materials = new Map<string, MaterialDef>();
    const material = (name: string): MaterialDef => {
      let m = materials.get(name);
      if (!m) {
        const tile = tileSizeFor(name);
        const c = this.materialColors.get(name);
        // the reflectivity fallback takes linear colour
        const refl = c ? v3(Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)) : undefined;
        m = fallbackMaterial(name, refl, tile, tile);
        materials.set(name, m);
      }
      return m;
    };
    const batches = new Map<string, BatchAcc>();
    const batchFor = (model: number, mat: string): BatchAcc => {
      const key = `${model}|${mat}`;
      let b = batches.get(key);
      if (!b) {
        b = {
          model,
          material: mat,
          positions: [],
          normals: [],
          uvs: [],
          indices: [],
          mins: v3(Infinity, Infinity, Infinity),
          maxs: v3(-Infinity, -Infinity, -Infinity),
        };
        batches.set(key, b);
      }
      return b;
    };
    const emitPoly = (model: number, matName: string, pts: Vec3[], n: Vec3): void => {
      if (pts.length < 3) return;
      const m = material(matName);
      const acc = batchFor(model, matName);
      const base = acc.positions.length / 3;
      const [tu, tv] = faceAxes(n);
      for (const p of pts) {
        acc.positions.push(p.x, p.y, p.z);
        acc.normals.push(n.x, n.y, n.z);
        acc.uvs.push(dot(p, tu) / m.width, dot(p, tv) / m.height);
        acc.mins.x = Math.min(acc.mins.x, p.x);
        acc.mins.y = Math.min(acc.mins.y, p.y);
        acc.mins.z = Math.min(acc.mins.z, p.z);
        acc.maxs.x = Math.max(acc.maxs.x, p.x);
        acc.maxs.y = Math.max(acc.maxs.y, p.y);
        acc.maxs.z = Math.max(acc.maxs.z, p.z);
      }
      for (let i = 1; i + 1 < pts.length; i++) acc.indices.push(base, base + i, base + i + 1);
    };
    for (const rb of this.renderBrushes) {
      const ws = brushWindings(rb.brush);
      for (let i = 0; i < rb.brush.sides.length; i++) {
        const sd = rb.brush.sides[i];
        if (sd.bevel || ws[i].length < 3) continue;
        const matName = rb.mat(sd.plane.normal, i);
        if (!matName) continue;
        emitPoly(rb.brush.model, matName, ws[i], sd.plane.normal);
      }
    }
    for (const st of this.renderStrips) {
      const m = material(st.mat);
      const acc = batchFor(0, st.mat);
      const base = acc.positions.length / 3;
      const n = st.top.length;
      for (let k = 0; k < n; k++) {
        for (const [p, v] of [
          [st.top[k], 0],
          [st.bottom[k], st.vBottom[k]],
        ] as [Vec3, number][]) {
          acc.positions.push(p.x, p.y, p.z);
          acc.normals.push(st.normals[k].x, st.normals[k].y, st.normals[k].z);
          acc.uvs.push(st.u[k] / m.width, v / m.height);
          acc.mins.x = Math.min(acc.mins.x, p.x);
          acc.mins.y = Math.min(acc.mins.y, p.y);
          acc.mins.z = Math.min(acc.mins.z, p.z);
          acc.maxs.x = Math.max(acc.maxs.x, p.x);
          acc.maxs.y = Math.max(acc.maxs.y, p.y);
          acc.maxs.z = Math.max(acc.maxs.z, p.z);
        }
      }
      for (let k = 0; k + 1 < n; k++) {
        const t0 = base + k * 2;
        const b0 = t0 + 1;
        const t1 = t0 + 2;
        const b1 = t0 + 3;
        // counter-clockwise seen from the face side
        const c = cross(sub(st.top[k + 1], st.top[k]), sub(st.bottom[k], st.top[k]));
        if (dot(c, st.normals[k]) >= 0) acc.indices.push(t0, t1, b1, t0, b1, b0);
        else acc.indices.push(t0, b1, t1, t0, b0, b1);
      }
    }
    for (const rp of this.renderPolys) {
      // shade and texture with the polygon's own plane (Newell normal), on the side of the requested normal
      let nn = newellNormal(rp.points);
      if (dot(nn, rp.normal) < 0) nn = scale(nn, -1);
      emitPoly(rp.model, rp.mat, rp.points, nn.x || nn.y || nn.z ? nn : rp.normal);
    }
    const out: RenderBatch[] = [];
    for (const acc of batches.values()) {
      out.push({
        model: acc.model,
        material: acc.material,
        positions: new Float32Array(acc.positions),
        normals: new Float32Array(acc.normals),
        uvs: new Float32Array(acc.uvs),
        lightmapUVs: null,
        alphas: null,
        indices: new Uint32Array(acc.indices),
        surfFlags: 0,
        area: -1,
        isDisplacement: false,
        mins: acc.mins,
        maxs: acc.maxs,
      });
    }

    return {
      name: this.name,
      source: 'builtin',
      entities: ents,
      models,
      collision: new CollisionWorld(this.worldBrushes),
      render: {
        batches: out,
        lightmap: null,
        materials,
        sky: { name: this.sky, faces: null },
        sky3d: null,
        fog: this.fog ? { ...this.fog, color: [...this.fog.color] as [number, number, number] } : null,
      },
      spawns: this.spawns.map((s) => ({ origin: v3clone(s.origin), angles: { ...s.angles } })),
      zones: this.zones.map(cloneZone),
      zoneSource: 'builtin',
      worldMins: wmins,
      worldMaxs: wmaxs,
      warnings: [],
    };
  }
}

/**
 * Collision brushes for a multi-segment ramp that hide the segment seams from box traces. Each segment's
 * brush is extended past its interior caps into its neighbours (and trimmed by the neighbours' planes that
 * contain it), so a segment's own start/end edges end up buried under the neighbouring surface and the
 * visible seam is just the line where two face planes meet. Without this, a hull sliding across a seam can
 * land within DIST_EPSILON of the next segment's face and of the bevel through its exposed start edge at the
 * same time, and the epsilon back-off then picks the edge plane, which faces against the motion: the classic
 * surf "rampbug" that eats most of the player's speed.
 */
function seamlessSegments(segs: Brush[], ribs: Vec3[][]): Brush[] {
  const n = segs.length;
  const near = (p: Vec3, rib: Vec3[]): boolean => rib.some((q) => Math.abs(p.x - q.x) < 0.05 && Math.abs(p.y - q.y) < 0.05 && Math.abs(p.z - q.z) < 0.05);
  interface SegInfo {
    caps: (Plane | null)[]; // [start, end]
    other: Plane[];
    verts: Vec3[];
    len: number;
  }
  const info: SegInfo[] = segs.map((b, i) => {
    const ws = brushWindings(b);
    const caps: (Plane | null)[] = [null, null];
    const other: Plane[] = [];
    const verts: Vec3[] = [];
    b.sides.forEach((sd, k) => {
      if (sd.bevel || ws[k].length < 3) return;
      for (const p of ws[k]) verts.push(p);
      const plane = { normal: v3clone(sd.plane.normal), dist: sd.plane.dist };
      if (ws[k].every((p) => near(p, ribs[i]))) caps[0] = plane;
      else if (ws[k].every((p) => near(p, ribs[i + 1]))) caps[1] = plane;
      else other.push(plane);
    });
    const len = Math.hypot(ribs[i + 1][0].x - ribs[i][0].x, ribs[i + 1][0].y - ribs[i][0].y, ribs[i + 1][0].z - ribs[i][0].z);
    return { caps, other, verts, len };
  });
  // A neighbour plane may trim the extension only if it doesn't cut into this segment: strictly for surf planes;
  // the (possibly folded) back and bottom planes may shave up to a few units off this segment's underside.
  const contains = (pl: Plane, verts: Vec3[]): boolean => {
    const surf = pl.normal.z > 0.05 && pl.normal.z < 0.7;
    const tol = surf ? 0.01 : 4;
    return verts.every((v) => dot(v, pl.normal) <= pl.dist + tol);
  };
  const out: Brush[] = [];
  for (let i = 0; i < n; i++) {
    const me = info[i];
    const planes: Plane[] = me.other.map((p) => ({ normal: v3clone(p.normal), dist: p.dist }));
    for (let c = 0; c < 2; c++) {
      const cap = me.caps[c];
      if (!cap) continue;
      const nb = c === 0 ? i - 1 : i + 1;
      if (nb < 0 || nb >= n) {
        planes.push(cap); // a real end of the ramp
        continue;
      }
      const ext = Math.min(256, info[nb].len * 0.9);
      planes.push({ normal: v3clone(cap.normal), dist: cap.dist + ext });
      // keep the extension inside the neighbour: its side planes that don't cut this segment's own volume, and
      // its far cap (the ramp's real end, or its joint with the next segment)
      for (const pl of info[nb].other) if (contains(pl, me.verts)) planes.push(pl);
      const far = info[nb].caps[c === 0 ? 0 : 1];
      if (far && me.verts.every((v) => dot(v, far.normal) <= far.dist + 0.01)) planes.push(far);
    }
    const b = brushFromPlanes(planes, CONTENTS_SOLID, 0);
    // never lose the exact segment: fall back to it if anything went wrong
    out.push(b && b.mins.x <= segs[i].mins.x + 0.01 && b.maxs.x >= segs[i].maxs.x - 0.01 && b.mins.z <= segs[i].mins.z + 0.01 ? b : segs[i]);
  }
  return out;
}

/**
 * Texture axes of a face (world-space planar projection, one texture unit per world unit before the
 * division by the material size, never stretched): floors/ceilings use world x/y laid into the face plane;
 * walls and ramps use the face's horizontal tangent and its in-plane down-slope direction.
 */
function faceAxes(n: Vec3): [Vec3, Vec3] {
  if (Math.abs(n.z) >= 0.7) {
    // floors, ceilings, gentle slopes: u follows world x, v follows world -y (+y underneath), in the plane
    const t = norm(v3(1 - n.x * n.x, -n.x * n.y, -n.x * n.z));
    return [t, norm(cross(t, n))];
  }
  const t = norm(v3(-n.y, n.x, 0));
  let b = cross(n, t);
  if (b.z > 0) b = scale(b, -1);
  return [t, norm(b)];
}

/** Unit normal of a polygon by Newell's method (counter-clockwise = towards the viewer). */
function newellNormal(pts: Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    x += (a.y - b.y) * (a.z + b.z);
    y += (a.z - b.z) * (a.x + b.x);
    z += (a.x - b.x) * (a.y + b.y);
  }
  return norm(v3(x, y, z));
}

/** Splits a wall box around a rectangular hole ([a0, a1] along the wall, [z0, z1] up). */
function cutHole(p: { lo: Vec3; hi: Vec3 }, alongX: boolean, a0: number, a1: number, z0: number, z1: number): { lo: Vec3; hi: Vec3 }[] {
  const lo = p.lo;
  const hi = p.hi;
  const plo = alongX ? lo.x : lo.y;
  const phi = alongX ? hi.x : hi.y;
  const h0 = Math.max(plo, a0);
  const h1 = Math.min(phi, a1);
  const zz0 = Math.max(lo.z, z0);
  const zz1 = Math.min(hi.z, z1);
  if (!(h1 > h0 && zz1 > zz0)) return [p];
  const mk = (a: number, b: number, za: number, zb: number): { lo: Vec3; hi: Vec3 } =>
    alongX ? { lo: v3(a, lo.y, za), hi: v3(b, hi.y, zb) } : { lo: v3(lo.x, a, za), hi: v3(hi.x, b, zb) };
  const out: { lo: Vec3; hi: Vec3 }[] = [];
  if (h0 > plo) out.push(mk(plo, h0, lo.z, hi.z));
  if (h1 < phi) out.push(mk(h1, phi, lo.z, hi.z));
  if (zz0 > lo.z) out.push(mk(h0, h1, lo.z, zz0));
  if (zz1 < hi.z) out.push(mk(h0, h1, zz1, hi.z));
  return out;
}

function cloneZone(z: ZoneDef): ZoneDef {
  const out: ZoneDef = { type: z.type, group: z.group, index: z.index, mins: v3clone(z.mins), maxs: v3clone(z.maxs) };
  if (z.prespeed !== undefined) out.prespeed = z.prespeed;
  if (z.spawn) out.spawn = { origin: v3clone(z.spawn.origin), angles: { ...z.spawn.angles } };
  return out;
}

function fmt(x: number): string {
  const r = Math.round(x * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

function vecStr(p: Vec3): string {
  return `${fmt(p.x)} ${fmt(p.y)} ${fmt(p.z)}`;
}

function parseVec(s: string | undefined): Vec3 {
  if (!s) return v3();
  const p = s.trim().split(/\s+/).map(Number);
  return v3(p[0] || 0, p[1] || 0, p[2] || 0);
}

function parseAngles(s: string | undefined): QAngle {
  const v = parseVec(s);
  return qa(v.x, v.y, v.z);
}
