// Collision geometry from a parsed BSP: convex brushes per brush model (world + brush entities),
// displacement collision as thin triangular prisms, and which brush entity classes are player-solid.
//
// Brush ownership follows the engine: a brush belongs to model N when a leaf of model N's BSP subtree
// references it. Brushes referenced by no leaf (vbsp occasionally emits some) never collide in the engine
// and are skipped here too.
import { QAngle, angleVectors, qa } from '../core/angles';
import { Vec3, v3, v3clone } from '../core/vec3';
import { BrushModelInfo, MapEntity } from '../map/types';
import { addBrushBevels, computeBrushBounds } from '../physics/brushbuild';
import { Brush, BrushSide, CONTENTS_SOLID, Plane } from '../physics/types';
import { allModelBrushIndices } from './bsptree';
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
        lo[a] = Math.max(lo[a], 0 - s.plane.dist); // 0 - d avoids -0
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

/** Row-major 3x3 rotation whose columns are Source's forward, left and up vectors: world = M * local. */
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
  const lists = allModelBrushIndices(bsp);
  for (let m = 0; m < bsp.models.length; m++) {
    const bm = bsp.models[m];
    let brushes: Brush[] = [];
    for (const bi of lists[m]) {
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
  if (opts.warnings) {
    if (degenerate > 0) opts.warnings.push(`${degenerate} of ${total} BSP brushes are degenerate (no volume) and were skipped`);
    const orphans = bsp.brushes.length - total;
    if (orphans > 0) {
      opts.warnings.push(`${orphans} BSP brushes are not referenced by any BSP leaf (the engine never collides with them); skipped`);
    }
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
  /**
   * Return compact PackedBrush objects (default true). Set false for plain Brush objects with ordinary
   * side arrays (~4x the memory).
   */
  packed?: boolean;
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
 * front, bottom `thickness` units below, three side walls) with the axial and edge bevels brushFromPlanes
 * would add (built analytically, see trianglePrismBrush), plus exact bounds. Contents come from the
 * dispinfo (CONTENTS_SOLID when unset); model 0. Displacements flagged "no hull collision" are skipped.
 * Heavy-displacement maps produce ~180k prisms: by default they are PackedBrush objects (~1.3 KB each).
 */
export function buildDisplacementBrushes(bsp: BspFile, opts: DisplacementBrushOptions = {}): Brush[] {
  const thickness = opts.thickness ?? 2;
  const store = opts.packed === false ? null : new SideStore();
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
      const n = prismSides(
        P[a], P[a + 1], P[a + 2],
        P[b], P[b + 1], P[b + 2],
        P[c], P[c + 1], P[c + 2],
        thickness,
        SCRATCH_SIDES,
        SCRATCH_BOUNDS,
      );
      if (n === 0) {
        degenerate++;
        continue;
      }
      const bb = SCRATCH_BOUNDS;
      const mins = v3(bb[0], bb[1], bb[2]);
      const maxs = v3(bb[3], bb[4], bb[5]);
      if (store) {
        const off = store.add(SCRATCH_SIDES, n);
        out.push(new PackedBrush(store.chunk, off, n, contents, 0, mins, maxs));
      } else {
        out.push({ sides: unpackSides(SCRATCH_SIDES, 0, n), contents, mins, maxs, model: 0 });
      }
    }
  }
  if (opts.warnings) {
    if (malformed) opts.warnings.push(`${malformed} displacements are malformed and have no collision`);
    if (degenerate) opts.warnings.push(`${degenerate} degenerate displacement triangles skipped`);
    if (skipped) opts.warnings.push(`${skipped} displacements flagged without hull collision`);
  }
  return out;
}

// Thin prism brushes are built analytically: the six vertices are known exactly, so the axial and edge
// bevels can be derived without the generic winding clipper. The result is the same plane set that
// brushFromPlanes() produces for the prism's five planes (verified in tests/bsp_collision.test.ts) but
// several times faster, which matters for maps with 100k+ displacement triangles. Tolerances mirror the
// generic builder's.
const BEVEL_MIN_EDGE = 0.01;
const BEVEL_MIN_CROSS = 1e-3;
const BEVEL_ON_EPSILON = 0.01;
const AXIAL_EPSILON = 1e-9;
const NORMAL_EPSILON = 1e-5;
const DIST_EQUAL_EPSILON = 0.01;

/** Packed side layout: nx, ny, nz, dist, flags (bit 0 = bevel). */
const SIDE_STRIDE = 5;
/** Upper bound on prism sides: 5 real + 6 axial + 9 edges * 6 candidates. */
const MAX_PRISM_SIDES = 5 + 6 + 54;

/** Shared (frozen) unit normals for axial bevels: -x +x -y +y -z +z. */
const AXIAL_NORMALS: readonly Vec3[] = [
  Object.freeze(v3(-1, 0, 0)),
  Object.freeze(v3(1, 0, 0)),
  Object.freeze(v3(0, -1, 0)),
  Object.freeze(v3(0, 1, 0)),
  Object.freeze(v3(0, 0, -1)),
  Object.freeze(v3(0, 0, 1)),
];

// scratch buffers for prism construction
const PV = new Float64Array(18); // 6 vertices: 0..2 top, 3..5 bottom
// edges as vertex index pairs: three top edges (their bottom twins are vertex + 3), then the three
// vertical edges
const PE = [0, 1, 1, 2, 2, 0, 0, 3, 1, 4, 2, 5];
const REAL = new Float64Array(5 * 4); // top, bottom, 3 walls: nx ny nz dist
const SCRATCH_SIDES = new Float64Array(MAX_PRISM_SIDES * SIDE_STRIDE);
const SCRATCH_BOUNDS = new Float64Array(6);

function writeSide(out: Float64Array, n: number, x: number, y: number, z: number, d: number, bevel: number): number {
  const o = n * SIDE_STRIDE;
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = d;
  out[o + 4] = bevel;
  return n + 1;
}

/**
 * Computes the full side list (real sides, axial and edge bevels, in the generic builder's order: the six
 * axial planes first, then the remaining real sides, then edge bevels) of the thin prism under the
 * counter-clockwise triangle (a, b, c) into `out` (SIDE_STRIDE values per side) and its AABB into
 * `bounds` (minx miny minz maxx maxy maxz). Returns the side count, or 0 for degenerate triangles.
 */
function prismSides(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  thickness: number,
  out: Float64Array,
  bounds: Float64Array,
): number {
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
  if (!(len > 1e-6) || !(thickness > 0)) return 0;
  nx /= len;
  ny /= len;
  nz /= len;

  PV[0] = ax; PV[1] = ay; PV[2] = az;
  PV[3] = bx; PV[4] = by; PV[5] = bz;
  PV[6] = cx; PV[7] = cy; PV[8] = cz;
  for (let i = 0; i < 9; i += 3) {
    PV[9 + i] = PV[i] - nx * thickness;
    PV[10 + i] = PV[i + 1] - ny * thickness;
    PV[11 + i] = PV[i + 2] - nz * thickness;
  }

  // real sides: top, bottom, three walls
  const top = (nx * (ax + bx + cx) + ny * (ay + by + cy) + nz * (az + bz + cz)) / 3;
  REAL[0] = nx; REAL[1] = ny; REAL[2] = nz; REAL[3] = top;
  REAL[4] = -nx; REAL[5] = -ny; REAL[6] = -nz; REAL[7] = -(top - thickness);
  for (let i = 0; i < 3; i++) {
    const p = i * 3;
    const q = ((i + 1) % 3) * 3;
    const ex = PV[q] - PV[p];
    const ey = PV[q + 1] - PV[p + 1];
    const ez = PV[q + 2] - PV[p + 2];
    // edge x normal points away from the interior of a CCW triangle
    let sx = ey * nz - ez * ny;
    let sy = ez * nx - ex * nz;
    let sz = ex * ny - ey * nx;
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (!(sl > 1e-9)) return 0;
    sx /= sl;
    sy /= sl;
    sz /= sl;
    const o = 8 + i * 4;
    REAL[o] = sx;
    REAL[o + 1] = sy;
    REAL[o + 2] = sz;
    REAL[o + 3] = sx * PV[p] + sy * PV[p + 1] + sz * PV[p + 2];
  }

  // bounds
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < 18; i += 3) {
    const x = PV[i], y = PV[i + 1], z = PV[i + 2];
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
    if (z < minz) minz = z;
    if (z > maxz) maxz = z;
  }
  if (!(maxx - minx > 1e-6 && maxy - miny > 1e-6 && maxz - minz > 1e-6)) return 0;
  bounds[0] = minx; bounds[1] = miny; bounds[2] = minz;
  bounds[3] = maxx; bounds[4] = maxy; bounds[5] = maxz;

  let n = 0;

  // axial planes first (-x +x -y +y -z +z): reuse an exactly axial real side at the extent, else a bevel
  let used = 0;
  for (let k = 0; k < 6; k++) {
    const axis = k >> 1;
    const dir = k & 1 ? 1 : -1;
    const extent = dir < 0 ? -bounds[axis] : bounds[3 + axis];
    let found = -1;
    let foundErr = Infinity;
    for (let i = 0; i < 5; i++) {
      if (used & (1 << i)) continue;
      const o = i * 4;
      const c0 = REAL[o + axis];
      const c1 = REAL[o + (axis === 0 ? 1 : 0)];
      const c2 = REAL[o + (axis === 2 ? 1 : 2)];
      if (Math.abs(c0 - dir) > AXIAL_EPSILON || Math.abs(c1) > AXIAL_EPSILON || Math.abs(c2) > AXIAL_EPSILON) continue;
      const err = Math.abs(REAL[o + 3] - extent);
      if (err <= DIST_EQUAL_EPSILON && err < foundErr) {
        found = i;
        foundErr = err;
      }
    }
    if (found >= 0) {
      used |= 1 << found;
      const o = found * 4;
      n = writeSide(out, n, REAL[o], REAL[o + 1], REAL[o + 2], REAL[o + 3], 0);
    } else {
      const an = AXIAL_NORMALS[k];
      n = writeSide(out, n, an.x, an.y, an.z, extent, 1);
    }
  }
  for (let i = 0; i < 5; i++) {
    if (used & (1 << i)) continue;
    const o = i * 4;
    n = writeSide(out, n, REAL[o], REAL[o + 1], REAL[o + 2], REAL[o + 3], 0);
  }

  // Edge bevels: planes through an edge, parallel to a world axis, supporting the prism. The bottom edges
  // are parallel to the top ones and yield the same candidate normals, so each top/bottom pair is
  // evaluated once and accepted when either edge of the pair touches the supporting plane.
  for (let e = 0; e < 12; e += 2) {
    const p = PE[e] * 3;
    const q = PE[e + 1] * 3;
    const pair = e < 6; // top edge with its parallel bottom edge (+9 doubles)
    const p1x = PV[p], p1y = PV[p + 1], p1z = PV[p + 2];
    const p2x = PV[q], p2y = PV[q + 1], p2z = PV[q + 2];
    let ex = p2x - p1x;
    let ey = p2y - p1y;
    let ez = p2z - p1z;
    const elen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (elen < BEVEL_MIN_EDGE) continue;
    ex /= elen;
    ey /= elen;
    ez /= elen;
    if (Math.abs(ex) < 1e-9) ex = 0;
    if (Math.abs(ey) < 1e-9) ey = 0;
    if (Math.abs(ez) < 1e-9) ez = 0;
    for (let axis = 0; axis < 3; axis++) {
      for (let dir = -1; dir <= 1; dir += 2) {
        // bevel normal = edge x (dir * axis)
        let bnx: number;
        let bny: number;
        let bnz: number;
        if (axis === 0) {
          bnx = 0;
          bny = ez * dir;
          bnz = -ey * dir;
        } else if (axis === 1) {
          bnx = -ez * dir;
          bny = 0;
          bnz = ex * dir;
        } else {
          bnx = ey * dir;
          bny = -ex * dir;
          bnz = 0;
        }
        const bl = Math.sqrt(bnx * bnx + bny * bny + bnz * bnz);
        if (bl < BEVEL_MIN_CROSS) continue;
        bnx /= bl;
        bny /= bl;
        bnz /= bl;
        if (Math.abs(bnx) > 1 - AXIAL_EPSILON || Math.abs(bny) > 1 - AXIAL_EPSILON || Math.abs(bnz) > 1 - AXIAL_EPSILON) continue;
        let dist = -Infinity;
        for (let k = 0; k < 18; k += 3) {
          const d = PV[k] * bnx + PV[k + 1] * bny + PV[k + 2] * bnz;
          if (d > dist) dist = d;
        }
        const lim = dist - BEVEL_ON_EPSILON;
        let touches = p1x * bnx + p1y * bny + p1z * bnz >= lim && p2x * bnx + p2y * bny + p2z * bnz >= lim;
        if (!touches && pair) {
          touches =
            PV[p + 9] * bnx + PV[p + 10] * bny + PV[p + 11] * bnz >= lim &&
            PV[q + 9] * bnx + PV[q + 10] * bny + PV[q + 11] * bnz >= lim;
        }
        if (!touches) continue;
        let dup = false;
        for (let k = 0; k < n; k++) {
          const o = k * SIDE_STRIDE;
          if (Math.abs(out[o] - bnx) < NORMAL_EPSILON && Math.abs(out[o + 1] - bny) < NORMAL_EPSILON && Math.abs(out[o + 2] - bnz) < NORMAL_EPSILON) {
            dup = true;
            break;
          }
        }
        if (dup || n >= MAX_PRISM_SIDES) continue;
        n = writeSide(out, n, bnx, bny, bnz, dist, 1);
      }
    }
  }
  return n;
}

/** Materializes packed sides as BrushSide objects (axial bevels share frozen normals). */
function unpackSides(data: Float64Array, off: number, count: number): BrushSide[] {
  const sides: BrushSide[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = off + i * SIDE_STRIDE;
    const x = data[o];
    const y = data[o + 1];
    const z = data[o + 2];
    const bevel = data[o + 4] !== 0;
    let normal: Vec3 | null = null;
    if (bevel) {
      if (x === -1 && y === 0 && z === 0) normal = AXIAL_NORMALS[0];
      else if (x === 1 && y === 0 && z === 0) normal = AXIAL_NORMALS[1];
      else if (x === 0 && y === -1 && z === 0) normal = AXIAL_NORMALS[2];
      else if (x === 0 && y === 1 && z === 0) normal = AXIAL_NORMALS[3];
      else if (x === 0 && y === 0 && z === -1) normal = AXIAL_NORMALS[4];
      else if (x === 0 && y === 0 && z === 1) normal = AXIAL_NORMALS[5];
    }
    sides[i] = { plane: { normal: normal ?? v3(x, y, z), dist: data[o + 3] }, bevel };
  }
  return sides;
}

/**
 * Thin convex prism under the counter-clockwise triangle (a, b, c): top = triangle plane, bottom
 * `thickness` below it, three walls, plus axial and edge bevels. Null for degenerate triangles.
 */
export function trianglePrismBrush(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  thickness: number,
  contents: number,
  model = 0,
): Brush | null {
  const n = prismSides(ax, ay, az, bx, by, bz, cx, cy, cz, thickness, SCRATCH_SIDES, SCRATCH_BOUNDS);
  if (n === 0) return null;
  const b = SCRATCH_BOUNDS;
  return {
    sides: unpackSides(SCRATCH_SIDES, 0, n),
    contents,
    mins: v3(b[0], b[1], b[2]),
    maxs: v3(b[3], b[4], b[5]),
    model,
  };
}

/** The five real planes of the prism under triangle (a, b, c) (reference input for brushFromPlanes). */
export function trianglePrismPlanes(a: Vec3, b: Vec3, c: Vec3, thickness: number): Plane[] | null {
  const br = trianglePrismBrush(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, thickness, CONTENTS_SOLID);
  if (!br) return null;
  return br.sides.filter((s) => !s.bevel).map((s) => ({ normal: v3clone(s.plane.normal), dist: s.plane.dist }));
}

/**
 * A compact, read-mostly Brush whose planes live in a shared Float64Array (SIDE_STRIDE doubles per side)
 * instead of three JS objects per side - about 4x less memory, which keeps maps with ~200k displacement
 * triangles in the low hundreds of MB. `sides` is materialized on every read (treat it as a snapshot);
 * assigning `sides` switches the brush to an ordinary array. Note: structured clone (postMessage) drops the
 * `sides` getter - convert with toJSON() before sending brushes to a worker.
 */
export class PackedBrush implements Brush {
  contents: number;
  model: number;
  mins: Vec3;
  maxs: Vec3;
  private own: BrushSide[] | null = null;

  constructor(
    private readonly data: Float64Array,
    private readonly offset: number,
    readonly sideCount: number,
    contents: number,
    model: number,
    mins: Vec3,
    maxs: Vec3,
  ) {
    this.contents = contents;
    this.model = model;
    this.mins = mins;
    this.maxs = maxs;
  }

  get sides(): BrushSide[] {
    return this.own ?? unpackSides(this.data, this.offset, this.sideCount);
  }

  set sides(v: BrushSide[]) {
    this.own = v;
  }

  /** Plain Brush shape for JSON (debug dumps), instead of the shared side store. */
  toJSON(): Brush {
    return { sides: this.sides, contents: this.contents, mins: this.mins, maxs: this.maxs, model: this.model };
  }
}

/** Chunked Float64 storage for packed sides. */
class SideStore {
  chunk = new Float64Array(0);
  private used = 0;
  constructor(private readonly chunkDoubles = 1 << 20) {}

  /** Copies `count` sides from `src` into `this.chunk` and returns their offset there. */
  add(src: Float64Array, count: number): number {
    const need = count * SIDE_STRIDE;
    if (this.used + need > this.chunk.length) {
      this.chunk = new Float64Array(Math.max(this.chunkDoubles, need));
      this.used = 0;
    }
    const off = this.used;
    const chunk = this.chunk;
    for (let i = 0; i < need; i++) chunk[off + i] = src[i];
    this.used += need;
    return off;
  }
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

// ------------------------------------------------------------------------------------------ assembly

export interface CollisionBrushSet {
  /** Brushes for `new CollisionWorld(brushes)`: world (all contents), solid brush entities, displacements. */
  brushes: Brush[];
  /** Brush entity models that must start non-solid: call `world.setModelSolid(model, false)` for each. */
  disabledModels: number[];
  /** Brush entity models whose brushes were added (solid classes). */
  solidModels: number[];
  warnings: string[];
}

/**
 * Collects everything the player collides with, the way the engine sees it: every world brush (solid,
 * player clip, window, grate, water, ladder... - CollisionWorld masks pick what each query needs), the
 * brushes of player-solid brush entities (already in world space when `models` came from
 * buildBrushModels' default), and displacement prisms. Triggers and other non-solid brush entities are left
 * to the entity system. `models` defaults to buildBrushModels(bsp, { entities }).
 */
export function collectCollisionBrushes(
  bsp: BspFile,
  entities: MapEntity[],
  models?: BrushModelInfo[],
  dispOpts: DisplacementBrushOptions = {},
): CollisionBrushSet {
  const warnings: string[] = [];
  const ms = models ?? buildBrushModels(bsp, { entities, warnings });
  const brushes: Brush[] = [];
  // loops instead of push(...array): spreading 100k+ elements overflows the call stack
  if (ms[0]) for (const b of ms[0].brushes) brushes.push(b);
  const disabledModels: number[] = [];
  const solidModels: number[] = [];
  const seen = new Set<number>();
  for (const e of entities) {
    if (e.model <= 0 || e.model >= ms.length || seen.has(e.model) || !isSolidBrushEntity(e)) continue;
    seen.add(e.model);
    solidModels.push(e.model);
    for (const b of ms[e.model].brushes) brushes.push(b);
    if (!brushEntityStartsEnabled(e)) disabledModels.push(e.model);
  }
  const dispWarnings: string[] = [];
  for (const b of buildDisplacementBrushes(bsp, { ...dispOpts, warnings: dispWarnings })) brushes.push(b);
  for (const w of dispWarnings) warnings.push(w);
  if (dispOpts.warnings) for (const w of dispWarnings) dispOpts.warnings.push(w);
  return { brushes, disabledModels, solidModels, warnings };
}
