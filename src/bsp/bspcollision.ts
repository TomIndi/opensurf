// Collision geometry from a parsed BSP: convex brushes per brush model (world + brush entities),
// displacement collision as thin triangular prisms, and which brush entity classes are player-solid.
//
// Brush ownership follows the engine: a brush belongs to model N when a leaf of model N's BSP subtree
// references it. Brushes referenced by no leaf (vbsp occasionally emits some) never collide in the engine
// and are skipped here too.
import { QAngle, angleVectors, qa } from '../core/angles';
import { Vec3, v3, v3clone } from '../core/vec3';
import { BrushModelInfo, MapEntity } from '../map/types';
import { addBrushBevels, brushFromPlanes, computeBrushBounds } from '../physics/brushbuild';
import { Brush, BrushSide, CONTENTS_SOLID, Plane } from '../physics/types';
import { modelBrushIndices } from './bsptree';
import { parseEntities } from './entities';
import { BspFile } from './types';

// ------------------------------------------------------------------------------------------ brush models

export interface BuildBrushModelsOptions {
  /**
   * 'world' (default): every brush entity model is moved from model space to where its entity places it
   * (entity origin + angles, see brushEntityPlacement). vbsp stores brush entity geometry relative to the
   * entity origin, so without this all triggers/func_brushes would sit around the world origin.
   * 'model': raw model-space brushes as stored in the BSP.
   */
  space?: 'world' | 'model';
  /** Entities used for placement (default: parsed from bsp.entitiesText). */
  entities?: MapEntity[];
  /** Receives non-fatal problems (degenerate brushes etc.). */
  warnings?: string[];
}

/**
 * Bounds from the six axial planes vbsp always adds to a brush (as real sides or bevels). Used when the
 * winding-based bounds fail (sliver / zero-thickness brushes, which still block box traces in the engine).
 */
function axialBounds(sides: BrushSide[]): { mins: Vec3; maxs: Vec3 } | null {
  const lo = [-Infinity, -Infinity, -Infinity];
  const hi = [Infinity, Infinity, Infinity];
  let found = 0;
  for (const s of sides) {
    const n = s.plane.normal;
    const c = [n.x, n.y, n.z];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(c[(a + 1) % 3]) > 1e-6 || Math.abs(c[(a + 2) % 3]) > 1e-6) continue;
      if (c[a] > 0.999999) {
        hi[a] = Math.min(hi[a], s.plane.dist);
        found |= 1 << (a * 2 + 1);
      } else if (c[a] < -0.999999) {
        lo[a] = Math.max(lo[a], -s.plane.dist);
        found |= 1 << (a * 2);
      }
    }
  }
  if (found !== 63) return null;
  for (let a = 0; a < 3; a++) if (!(lo[a] <= hi[a])) return null;
  return { mins: v3(lo[0], lo[1], lo[2]), maxs: v3(hi[0], hi[1], hi[2]) };
}

/**
 * Brush object for BSP brush `index` (planes copied, BSP bevel flags kept - vbsp already wrote the bevel
 * sides, none are added). Bounds come from the face windings; when those are degenerate (sliver brushes)
 * the axial planes are used instead. Returns null for brushes without any usable volume.
 */
export function brushFromBsp(bsp: BspFile, index: number, model: number): Brush | null {
  const b = bsp.brushes[index];
  if (!b) return null;
  const sides: BrushSide[] = [];
  const end = Math.min(b.firstSide + b.numSides, bsp.brushSides.length);
  for (let i = b.firstSide; i < end; i++) {
    const s = bsp.brushSides[i];
    const p = bsp.planes[s.planeNum];
    if (!p) continue;
    sides.push({ plane: { normal: v3(p.normal.x, p.normal.y, p.normal.z), dist: p.dist }, bevel: s.bevel });
  }
  const brush: Brush = { sides, contents: b.contents, mins: v3(), maxs: v3(), model };
  if (sides.length === 0) return null;
  if (computeBrushBounds(brush)) return brush;
  const ab = axialBounds(sides);
  if (!ab) return null;
  brush.mins = ab.mins;
  brush.maxs = ab.maxs;
  return brush;
}

/**
 * Classes whose spawn code turns the "angles" keyvalue into a movement direction and resets the entity's
 * own angles (Quake-style SetMovedir). Their models are never rotated.
 */
const MOVEDIR_CLASSES = new Set(['func_door', 'func_button', 'func_movelinear', 'func_conveyor', 'func_water_analog', 'momentary_door']);

/**
 * Where an entity puts its brush model: translation = entity origin; rotation = entity angles (SOLID_BSP
 * models are transformed by the entity's angles, e.g. a rotated trigger or func_rotating's start angle),
 * except for the move-direction classes above.
 */
export function brushEntityPlacement(ent: MapEntity): { origin: Vec3; angles: QAngle } {
  const angles = MOVEDIR_CLASSES.has(ent.classname) ? qa() : { ...ent.angles };
  return { origin: v3clone(ent.origin), angles };
}

/** Column-major rotation (forward, left, up) for Source angles: world = M * local. */
function rotationMatrix(a: QAngle): number[] {
  const f = v3();
  const r = v3();
  const u = v3();
  angleVectors(a, f, r, u);
  // columns: forward, left (= -right), up
  return [f.x, -r.x, u.x, f.y, -r.y, u.y, f.z, -r.z, u.z]; // row-major 3x3
}

/**
 * Returns a copy of `brush` moved from model space by `angles` (rotation about the model origin) then
 * `origin`. Pure translations keep the BSP bevels; rotations rebuild bevels and bounds.
 */
export function transformBrush(brush: Brush, origin: Vec3, angles: QAngle): Brush {
  const rotated = angles.pitch !== 0 || angles.yaw !== 0 || angles.roll !== 0;
  if (!rotated) {
    const sides = brush.sides.map((s) => {
      const n = s.plane.normal;
      return {
        plane: { normal: v3(n.x, n.y, n.z), dist: s.plane.dist + n.x * origin.x + n.y * origin.y + n.z * origin.z },
        bevel: s.bevel,
      };
    });
    return {
      sides,
      contents: brush.contents,
      model: brush.model,
      mins: v3(brush.mins.x + origin.x, brush.mins.y + origin.y, brush.mins.z + origin.z),
      maxs: v3(brush.maxs.x + origin.x, brush.maxs.y + origin.y, brush.maxs.z + origin.z),
    };
  }
  const m = rotationMatrix(angles);
  const sides: BrushSide[] = [];
  for (const s of brush.sides) {
    if (s.bevel) continue; // axis-dependent: rebuilt below
    const n = s.plane.normal;
    const nx = m[0] * n.x + m[1] * n.y + m[2] * n.z;
    const ny = m[3] * n.x + m[4] * n.y + m[5] * n.z;
    const nz = m[6] * n.x + m[7] * n.y + m[8] * n.z;
    sides.push({ plane: { normal: v3(nx, ny, nz), dist: s.plane.dist + nx * origin.x + ny * origin.y + nz * origin.z }, bevel: false });
  }
  const out: Brush = { sides, contents: brush.contents, model: brush.model, mins: v3(), maxs: v3() };
  addBrushBevels(out);
  if (!computeBrushBounds(out)) {
    // fall back to the rotated corners of the old bounds (conservative)
    const b = transformAabb(brush.mins, brush.maxs, origin, m);
    out.mins = b.mins;
    out.maxs = b.maxs;
  }
  return out;
}

function transformAabb(mins: Vec3, maxs: Vec3, origin: Vec3, m: number[] | null): { mins: Vec3; maxs: Vec3 } {
  const lo = v3(Infinity, Infinity, Infinity);
  const hi = v3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? maxs.x : mins.x;
    const y = i & 2 ? maxs.y : mins.y;
    const z = i & 4 ? maxs.z : mins.z;
    const wx = (m ? m[0] * x + m[1] * y + m[2] * z : x) + origin.x;
    const wy = (m ? m[3] * x + m[4] * y + m[5] * z : y) + origin.y;
    const wz = (m ? m[6] * x + m[7] * y + m[8] * z : z) + origin.z;
    lo.x = Math.min(lo.x, wx);
    lo.y = Math.min(lo.y, wy);
    lo.z = Math.min(lo.z, wz);
    hi.x = Math.max(hi.x, wx);
    hi.y = Math.max(hi.y, wy);
    hi.z = Math.max(hi.z, wz);
  }
  return { mins: lo, maxs: hi };
}

/**
 * Builds Brush objects for every brush model (index = model number, 0 = world). Brushes keep their BSP
 * contents (solid, player clip, water, trigger brushes, ...) and the BSP's own bevel planes.
 * By default brush entity models are returned in world space (see BuildBrushModelsOptions.space);
 * BrushModelInfo.origin is then the placement origin and mins/maxs are world-space bounds.
 */
export function buildBrushModels(bsp: BspFile, opts: BuildBrushModelsOptions = {}): BrushModelInfo[] {
  const space = opts.space ?? 'world';
  const placement = new Map<number, MapEntity>();
  if (space === 'world') {
    let ents = opts.entities;
    if (!ents) {
      try {
        ents = parseEntities(bsp.entitiesText);
      } catch {
        ents = [];
      }
    }
    for (const e of ents) if (e.model > 0 && !placement.has(e.model)) placement.set(e.model, e);
  }

  let degenerate = 0;
  let total = 0;
  const out: BrushModelInfo[] = [];
  for (let m = 0; m < bsp.models.length; m++) {
    const bm = bsp.models[m];
    let brushes: Brush[] = [];
    for (const bi of modelBrushIndices(bsp, m)) {
      total++;
      const br = brushFromBsp(bsp, bi, m);
      if (br) brushes.push(br);
      else degenerate++;
    }
    let mins = v3clone(bm.mins);
    let maxs = v3clone(bm.maxs);
    let origin = v3clone(bm.origin);
    const ent = m > 0 ? placement.get(m) : undefined;
    if (ent) {
      const p = brushEntityPlacement(ent);
      const rotated = p.angles.pitch !== 0 || p.angles.yaw !== 0 || p.angles.roll !== 0;
      if (rotated || p.origin.x !== 0 || p.origin.y !== 0 || p.origin.z !== 0) {
        brushes = brushes.map((b) => transformBrush(b, p.origin, p.angles));
      }
      origin = p.origin;
      if (brushes.length > 0) {
        // world-space bounds of the placed brushes
        mins = v3(Infinity, Infinity, Infinity);
        maxs = v3(-Infinity, -Infinity, -Infinity);
        for (const b of brushes) {
          mins.x = Math.min(mins.x, b.mins.x);
          mins.y = Math.min(mins.y, b.mins.y);
          mins.z = Math.min(mins.z, b.mins.z);
          maxs.x = Math.max(maxs.x, b.maxs.x);
          maxs.y = Math.max(maxs.y, b.maxs.y);
          maxs.z = Math.max(maxs.z, b.maxs.z);
        }
      } else {
        const b = transformAabb(bm.mins, bm.maxs, p.origin, rotated ? rotationMatrix(p.angles) : null);
        mins = b.mins;
        maxs = b.maxs;
      }
    }
    out.push({ index: m, mins, maxs, origin, brushes });
  }
  if (degenerate > 0 && opts.warnings) {
    opts.warnings.push(`${degenerate} of ${total} BSP brushes are degenerate (no volume) and were skipped`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ displacements

/** CS:GO-era dispinfo flags, stored in minTess when its high bit is set. */
export const DISPINFO_FLAG_MAGIC = 0x80000000 | 0;
export const DISP_FLAG_NO_PHYSICS_COLL = 0x2;
export const DISP_FLAG_NO_HULL_COLL = 0x4;
export const DISP_FLAG_NO_RAY_COLL = 0x8;

export interface DisplacementBrushOptions {
  /** Prism depth below each triangle (default 2 units). */
  thickness?: number;
  /**
   * Also skip displacements flagged "no physics collision". Default false: that flag only affects
   * VPhysics objects; player hull traces still collide (only "no hull collision" lets players through).
   */
  skipNoPhysics?: boolean;
  /** Receives non-fatal problems. */
  warnings?: string[];
}

/** Flags of a displacement (0 when the map has no flags field). */
export function dispFlags(minTess: number): number {
  return minTess & DISPINFO_FLAG_MAGIC ? minTess & 0x7fffffff : 0;
}

export interface DisplacementSurface {
  /** Displacement index. */
  index: number;
  /** Vertices per side ((1 << power) + 1). */
  size: number;
  /** size*size vertices, xyz, row-major; row r runs from corner0->corner1, column c towards corner3->corner2. */
  positions: Float64Array;
  /** Triangle vertex indices (2 * (size-1)^2 triangles), wound counter-clockwise seen from the surface's front. */
  triangles: Uint32Array;
}

/**
 * Rebuilds a displacement's final vertex grid and triangle list (Source's alternating-diagonal pattern).
 * Returns null when the displacement is malformed (base face isn't a quad, indices out of range).
 */
export function displacementSurface(bsp: BspFile, index: number): DisplacementSurface | null {
  const d = bsp.dispInfos[index];
  if (!d) return null;
  const face = bsp.faces[d.mapFace];
  if (!face || face.numEdges !== 4 || d.power < 1 || d.power > 4) return null;
  const size = (1 << d.power) + 1;
  if (d.dispVertStart < 0 || d.dispVertStart + size * size > bsp.dispVerts.length) return null;

  // base face corners in surfedge order
  const cx = [0, 0, 0, 0];
  const cy = [0, 0, 0, 0];
  const cz = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const se = bsp.surfedges[face.firstEdge + i];
    if (se === undefined) return null;
    const vi = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
    if (vi === undefined || vi * 3 + 2 >= bsp.vertices.length) return null;
    cx[i] = bsp.vertices[vi * 3];
    cy[i] = bsp.vertices[vi * 3 + 1];
    cz[i] = bsp.vertices[vi * 3 + 2];
  }
  // corner 0 = the one closest to startPosition; keep the winding order
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const dx = cx[i] - d.startPosition.x;
    const dy = cy[i] - d.startPosition.y;
    const dz = cz[i] - d.startPosition.z;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < best) {
      best = dd;
      start = i;
    }
  }
  const px = [0, 1, 2, 3].map((k) => cx[(start + k) & 3]);
  const py = [0, 1, 2, 3].map((k) => cy[(start + k) & 3]);
  const pz = [0, 1, 2, 3].map((k) => cz[(start + k) & 3]);

  const positions = new Float64Array(size * size * 3);
  const inv = 1 / (size - 1);
  for (let r = 0; r < size; r++) {
    const t = r * inv;
    // left edge corner0 -> corner1, right edge corner3 -> corner2
    const lx = px[0] + (px[1] - px[0]) * t;
    const ly = py[0] + (py[1] - py[0]) * t;
    const lz = pz[0] + (pz[1] - pz[0]) * t;
    const rx = px[3] + (px[2] - px[3]) * t;
    const ry = py[3] + (py[2] - py[3]) * t;
    const rz = pz[3] + (pz[2] - pz[3]) * t;
    for (let c = 0; c < size; c++) {
      const s = c * inv;
      const v = bsp.dispVerts[d.dispVertStart + r * size + c];
      const o = (r * size + c) * 3;
      positions[o] = lx + (rx - lx) * s + v.vec.x * v.dist;
      positions[o + 1] = ly + (ry - ly) * s + v.vec.y * v.dist;
      positions[o + 2] = lz + (rz - lz) * s + v.vec.z * v.dist;
    }
  }

  // Winding: the triangles below share the winding of (v00, v10, v01) on the flat base grid. Make them
  // counter-clockwise around the face's front normal.
  const plane = bsp.planes[face.planeNum];
  const sideSign = face.side ? -1 : 1;
  const fnx = plane.normal.x * sideSign;
  const fny = plane.normal.y * sideSign;
  const fnz = plane.normal.z * sideSign;
  const ux = px[1] - px[0];
  const uy = py[1] - py[0];
  const uz = pz[1] - pz[0];
  const vx = px[3] - px[0];
  const vy = py[3] - py[0];
  const vz = pz[3] - pz[0];
  const flip = (uy * vz - uz * vy) * fnx + (uz * vx - ux * vz) * fny + (ux * vy - uy * vx) * fnz < 0;

  const cells = size - 1;
  const triangles = new Uint32Array(cells * cells * 6);
  let t = 0;
  const emit = (a: number, b: number, c: number): void => {
    triangles[t++] = a;
    if (flip) {
      triangles[t++] = c;
      triangles[t++] = b;
    } else {
      triangles[t++] = b;
      triangles[t++] = c;
    }
  };
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      const i = r * size + c;
      if (i & 1) {
        // diagonal (r, c+1)-(r+1, c)
        emit(i, i + size, i + 1);
        emit(i + 1, i + size, i + size + 1);
      } else {
        // diagonal (r, c)-(r+1, c+1)
        emit(i, i + size, i + size + 1);
        emit(i, i + size + 1, i + 1);
      }
    }
  }
  return { index, size, positions, triangles };
}

/**
 * Displacement collision as one thin convex prism per triangle (top = triangle plane facing the surface's
 * front, bottom `thickness` units below, three side walls), with bevels and bounds from brushFromPlanes.
 * Contents come from the dispinfo (CONTENTS_SOLID when unset). Model 0.
 */
export function buildDisplacementBrushes(bsp: BspFile, opts: DisplacementBrushOptions = {}): Brush[] {
  const thickness = opts.thickness ?? 2;
  const out: Brush[] = [];
  let malformed = 0;
  let degenerate = 0;
  let skipped = 0;
  for (let di = 0; di < bsp.dispInfos.length; di++) {
    const d = bsp.dispInfos[di];
    const flags = dispFlags(d.minTess);
    if (flags & DISP_FLAG_NO_HULL_COLL || (opts.skipNoPhysics && flags & DISP_FLAG_NO_PHYSICS_COLL)) {
      skipped++;
      continue;
    }
    const surf = displacementSurface(bsp, di);
    if (!surf) {
      malformed++;
      continue;
    }
    const contents = d.contents !== 0 ? d.contents : CONTENTS_SOLID;
    const P = surf.positions;
    const T = surf.triangles;
    for (let k = 0; k < T.length; k += 3) {
      const a = T[k] * 3;
      const b = T[k + 1] * 3;
      const c = T[k + 2] * 3;
      const brush = prismBrush(
        P[a], P[a + 1], P[a + 2],
        P[b], P[b + 1], P[b + 2],
        P[c], P[c + 1], P[c + 2],
        thickness,
        contents,
      );
      if (brush) out.push(brush);
      else degenerate++;
    }
  }
  if (opts.warnings) {
    if (malformed) opts.warnings.push(`${malformed} displacements are malformed and have no collision`);
    if (degenerate) opts.warnings.push(`${degenerate} degenerate displacement triangles skipped`);
    if (skipped) opts.warnings.push(`${skipped} displacements flagged without hull collision`);
  }
  return out;
}

/** Thin prism under the CCW triangle (a, b, c); null for degenerate triangles. */
function prismBrush(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  thickness: number,
  contents: number,
): Brush | null {
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(len > 1e-6)) return null;
  nx /= len;
  ny /= len;
  nz /= len;
  const mx = (ax + bx + cx) / 3;
  const my = (ay + by + cy) / 3;
  const mz = (az + bz + cz) / 3;
  const top = nx * mx + ny * my + nz * mz;
  const planes: Plane[] = [
    { normal: v3(nx, ny, nz), dist: top },
    { normal: v3(-nx, -ny, -nz), dist: -(top - thickness) },
  ];
  const xs = [ax, bx, cx];
  const ys = [ay, by, cy];
  const zs = [az, bz, cz];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const ex = xs[j] - xs[i];
    const ey = ys[j] - ys[i];
    const ez = zs[j] - zs[i];
    // edge x normal points away from the triangle interior for a CCW triangle
    let sx = ey * nz - ez * ny;
    let sy = ez * nx - ex * nz;
    let sz = ex * ny - ey * nx;
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (!(sl > 1e-9)) return null;
    sx /= sl;
    sy /= sl;
    sz /= sl;
    const dist = sx * xs[i] + sy * ys[i] + sz * zs[i];
    if (sx * mx + sy * my + sz * mz > dist) {
      // centroid in front: wrong orientation (shouldn't happen for a CCW triangle)
      sx = -sx;
      sy = -sy;
      sz = -sz;
      planes.push({ normal: v3(sx, sy, sz), dist: -dist });
    } else {
      planes.push({ normal: v3(sx, sy, sz), dist });
    }
  }
  return brushFromPlanes(planes, contents, 0);
}

// ------------------------------------------------------------------------------------------ entity classes

/**
 * Brush entity classes that block player movement (their brushes go into the collision world).
 * The answer is about the class/flags, not the current toggle state: func_brush/func_wall_toggle that
 * start disabled still need their brushes in the world (see brushEntityStartsEnabled).
 *
 * Non-solid (false): func_illusionary, func_clip_vphysics (blocks physics props only), func_vehicleclip,
 * trigger_*, func_areaportal*, func_occluder, func_dustmotes, func_dustcloud, func_smokevolume,
 * func_precipitation, func_water_analog, func_buyzone, func_bomb_target, func_hostage_rescue, func_nav_*,
 * func_ladder, func_viscluster, func_no_defuse, func_fish_pool, and every unknown class.
 *
 * Solid unless a "not solid"/"passable" flag is set:
 * - func_brush: solidity "1" (never solid) -> false;
 * - func_door / func_door_rotating: spawnflags 4 (non-solid to player) or 8 (passable) -> false;
 * - func_rotating: spawnflags 64 (not solid) -> false;
 * - func_movelinear, func_train, func_tracktrain, func_tanktrain, func_pendulum: spawnflags 8 -> false;
 * - func_rot_button, momentary_rot_button: spawnflags 1 (not solid) -> false;
 * - func_conveyor: spawnflags 2 (not solid) -> false.
 * Always solid: func_wall, func_wall_toggle, func_breakable, func_breakable_surf, func_button,
 * func_physbox, func_physbox_multiplayer, func_reflective_glass, func_monitor, func_lod, func_plat,
 * func_platrot, func_guntarget, func_trackchange, func_trackautochange, func_lookdoor.
 */
export function isSolidBrushEntity(ent: MapEntity): boolean {
  const cls = ent.classname.toLowerCase();
  const flags = parseInt(ent.kv.spawnflags ?? '0', 10) || 0;
  switch (cls) {
    case 'func_brush':
      return (ent.kv.solidity ?? '0').trim() !== '1';
    case 'func_door':
    case 'func_door_rotating':
      return (flags & (4 | 8)) === 0;
    case 'func_rotating':
      return (flags & 64) === 0;
    case 'func_movelinear':
    case 'func_train':
    case 'func_tracktrain':
    case 'func_tanktrain':
    case 'func_pendulum':
      return (flags & 8) === 0;
    case 'func_rot_button':
    case 'momentary_rot_button':
      return (flags & 1) === 0;
    case 'func_conveyor':
      return (flags & 2) === 0;
    case 'func_wall':
    case 'func_wall_toggle':
    case 'func_breakable':
    case 'func_breakable_surf':
    case 'func_button':
    case 'func_physbox':
    case 'func_physbox_multiplayer':
    case 'func_reflective_glass':
    case 'func_monitor':
    case 'func_lod':
    case 'func_plat':
    case 'func_platrot':
    case 'func_guntarget':
    case 'func_trackchange':
    case 'func_trackautochange':
    case 'func_lookdoor':
      return true;
    default:
      return false;
  }
}

/**
 * Initial collision state of a solid brush entity (CollisionWorld.setModelSolid at spawn):
 * - func_brush: solidity "2" (always solid) -> true even when disabled; otherwise !StartDisabled;
 * - func_wall_toggle: spawnflags 1 ("starts invisible") -> false;
 * - anything else with StartDisabled "1" -> false.
 */
export function brushEntityStartsEnabled(ent: MapEntity): boolean {
  const cls = ent.classname.toLowerCase();
  const startDisabled = (ent.kv.startdisabled ?? '0').trim() === '1';
  if (cls === 'func_brush') {
    if ((ent.kv.solidity ?? '0').trim() === '2') return true;
    return !startDisabled;
  }
  if (cls === 'func_wall_toggle') {
    const flags = parseInt(ent.kv.spawnflags ?? '0', 10) || 0;
    return (flags & 1) === 0;
  }
  return !startDisabled;
}
