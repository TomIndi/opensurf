// LoadedMap -> three.js scene graph: one Mesh per RenderBatch (world, brush entities, decals, water, sky
// masks), merged static props, the 3D skybox group, per-model render state and animated materials.
//
// Nothing here needs a WebGL context (unit-testable in node); the Renderer uploads and draws the result.
import {
  BufferAttribute,
  BufferGeometry,
  Box3,
  DataTexture,
  Group,
  Matrix4,
  Mesh,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Sphere,
  Texture,
  UnsignedByteType,
  Vector3,
} from 'three';
import { angleVectors } from '../core/angles';
import type { Vec3 } from '../core/vec3';
import { SURF_SKY, SURF_SKY2D } from '../bsp/types';
import type { CubemapDef, LoadedMap, MaterialDef, RenderBatch, RenderProp } from '../map/types';
import { CONTENTS_SOLID } from '../physics/types';
import { TextureCache } from './textures';
import { TranslucentSorter } from './translucency';
import {
  ModelUniforms,
  SharedUniforms,
  SurfMaterialInfo,
  SurfaceMaterials,
  SurfaceVariant,
  U,
  applyModelAlpha,
  createModelUniforms,
  scrollOffset,
  setModelTint,
  setUvTransform,
  srgbToLinear,
} from './worldmaterials';
import { rebaseUvs, uvRebaseStep } from './uvrebase';

/** Opaque draw order groups (three.js sorts by renderOrder, then material, then depth). */
export const ORDER_SKY_MASK = -10;
export const ORDER_WORLD = 0;
export const ORDER_DECAL = 1;
/** Translucent decals go first among the translucent surfaces. */
export const ORDER_DECAL_TRANSLUCENT = -1;

/** Merged brush-entity batches of one material (see MapScene: brush entities share draw calls). */
export interface MergedGroup {
  models: Set<number>;
  /** Draws the group's models that are visible and opaque (model alpha 1). */
  opaque: Mesh;
  /** Translucent copy (same geometry) drawing the models faded with rendermode/renderamt; null for materials that are translucent themselves (`opaque` then draws everything, blended). */
  faded: Mesh | null;
}

export interface ModelEntry {
  model: number;
  /** Meshes of this model alone (water, decals... and every batch when merging is off). */
  meshes: Mesh[];
  /** Merged groups containing this model's batches. */
  merged: MergedGroup[];
  materials: Set<ShaderMaterial>;
  uniforms: ModelUniforms;
  visible: boolean;
  alpha: number;
  color: [number, number, number];
}

export interface MapSceneStats {
  meshes: number;
  /** Merged brush-entity groups (each one or two meshes). */
  mergedGroups: number;
  triangles: number;
  skyMasks: number;
  sky3dMeshes: number;
  propMeshes: number;
  propTriangles: number;
  decals: number;
  waterMeshes: number;
  materials: number;
  /** Translucent meshes with several planes, kept in back-to-front order per frame. */
  sortedTranslucent: number;
}

export interface MapSceneOptions {
  textures: TextureCache;
  materials: SurfaceMaterials;
  shared: SharedUniforms;
  /** Largest merged prop mesh in triangles (default 16384). */
  propClusterTriangles?: number;
  /**
   * Merge brush-entity batches of the same material into one mesh whose per-vertex model index looks up the
   * model's runtime state (visible, alpha, colour) in a small texture (default true). Maps with hundreds of
   * func_illusionary / func_brush pieces then cost a few draw calls instead of hundreds.
   */
  mergeBrushEntities?: boolean;
  /**
   * Merge opaque world surfaces and sky masks of the same material into spatial clusters (default true): the
   * loader's per-cell batches are often tiny; fewer, larger meshes cut the draw calls several times over.
   */
  mergeWorld?: boolean;
  /** Largest merged surface cluster in triangles (default 16384). */
  clusterTriangles?: number;
  /**
   * Draw BSP surfaces (world, brush entities, overlays) without back-face culling: true / false, or 'auto'
   * (default) = only when auditFaceOrientation finds faces the loader emitted inside-out.
   */
  doubleSided?: boolean | 'auto';
}

interface Animated {
  material: ShaderMaterial;
  info: SurfMaterialInfo;
}

/** Batches merged into shared meshes: world surfaces, sky masks or brush entities (with the model state). */
interface MergeQueue {
  kind: 'world' | 'sky' | 'entity';
  batches: RenderBatch[];
  def: MaterialDef | null;
  v: SurfaceVariant | null;
  envKey: number;
  sky3d: boolean;
}

const _v = new Vector3();

/** Matrix mapping 3D-skybox space to the main view's space: p' = (p - origin) * scale. */
export function sky3dMatrix(origin: Vec3, scale: number, out: Matrix4 = new Matrix4()): Matrix4 {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 16;
  return out.set(s, 0, 0, -origin.x * s, 0, s, 0, -origin.y * s, 0, 0, s, -origin.z * s, 0, 0, 0, 1);
}

/** Centre of a batch's bounds (first vertex when the bounds are unusable). */
export function batchCenter(b: RenderBatch): Vec3 {
  if (validBox(b.mins, b.maxs)) return { x: (b.mins.x + b.maxs.x) / 2, y: (b.mins.y + b.maxs.y) / 2, z: (b.mins.z + b.maxs.z) / 2 };
  return { x: b.positions[0] ?? 0, y: b.positions[1] ?? 0, z: b.positions[2] ?? 0 };
}

/** Sky faces are depth-only masks. */
export function isSkyBatch(b: RenderBatch, def: MaterialDef | undefined): boolean {
  return (b.surfFlags & (SURF_SKY | SURF_SKY2D)) !== 0 || !!def?.isSky;
}

function validBox(mins: Vec3 | undefined, maxs: Vec3 | undefined): boolean {
  return (
    !!mins &&
    !!maxs &&
    [mins.x, mins.y, mins.z, maxs.x, maxs.y, maxs.z].every((x) => Number.isFinite(x)) &&
    maxs.x >= mins.x &&
    maxs.y >= mins.y &&
    maxs.z >= mins.z
  );
}

/** Sets a geometry's bounds from a known AABB (or computes them from the positions). */
export function setBounds(g: BufferGeometry, mins?: Vec3, maxs?: Vec3): void {
  if (validBox(mins, maxs)) {
    g.boundingBox = new Box3(new Vector3(mins!.x, mins!.y, mins!.z), new Vector3(maxs!.x, maxs!.y, maxs!.z));
    const c = new Vector3();
    g.boundingBox.getCenter(c);
    g.boundingSphere = new Sphere(c, g.boundingBox.getSize(_v).length() / 2 + 1e-3);
  } else {
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
}

/** Index buffer in the smallest type that fits. */
export function indexAttribute(indices: Uint32Array, vertexCount: number): BufferAttribute {
  if (vertexCount <= 65535) {
    const a = new Uint16Array(indices.length);
    for (let i = 0; i < indices.length; i++) a[i] = indices[i];
    return new BufferAttribute(a, 1);
  }
  return new BufferAttribute(indices, 1);
}

/** Every index < vertexCount (malformed batches are skipped instead of reading out of bounds on the GPU). */
function indicesValid(indices: Uint32Array, vertexCount: number): boolean {
  for (let i = 0; i < indices.length; i++) if (indices[i] >= vertexCount) return false;
  return true;
}

/** Evaluates a prop light cube (+x, -x, +y, -y, +z, -z) for a world normal. */
export function evalAmbientCube(cube: readonly (readonly number[])[], nx: number, ny: number, nz: number, out: number[]): number[] {
  const x2 = nx * nx;
  const y2 = ny * ny;
  const z2 = nz * nz;
  const cx = nx >= 0 ? cube[0] : cube[1];
  const cy = ny >= 0 ? cube[2] : cube[3];
  const cz = nz >= 0 ? cube[4] : cube[5];
  for (let k = 0; k < 3; k++) out[k] = x2 * (cx?.[k] ?? 0) + y2 * (cy?.[k] ?? 0) + z2 * (cz?.[k] ?? 0);
  return out;
}

interface PropGroup {
  key: string;
  material: string;
  alpha: number;
  sky3d: boolean;
  envKey: number;
  props: RenderProp[];
  verts: number;
  idx: number;
}

/** Result of auditFaceOrientation. */
export interface FaceOrientationAudit {
  /** Triangles probed. */
  sampled: number;
  /** Front (by winding) in solid, back in open space: drawn inside-out. */
  inverted: number;
  /** Front in open space, back in solid. */
  correct: number;
  /** Open or solid on both sides (water, glass, thin or non-solid brushes): no verdict. */
  ambiguous: number;
  /** Surface area (units²) of the inverted / correct samples: big walls weigh more than slivers. */
  invertedArea: number;
  correctArea: number;
}

/**
 * Share of the decided sample area that must be inverted before BSP surfaces are drawn double-sided. Measured
 * on 8 KSF maps: 0-0.2% when faces are wound right (overlapping detail brushes, slivers), 16-50% when a
 * loader emits every dface_t.side = 1 face back to front.
 */
export const INVERTED_FACE_THRESHOLD = 0.05;

/**
 * Checks that the map's opaque brush surfaces face open space: for a spread-out sample of world triangles,
 * the solid contents just in front of and just behind each triangle (by its winding, which is what culling
 * uses). A Source BSP face always has the solid brush behind it and open space in front, so a loader that
 * emits some faces back to front (e.g. by misreading dface_t.side) shows up as a large "inverted" share -
 * with back-face culling those walls would simply vanish. Costs ~1 µs per sample.
 */
export function auditFaceOrientation(map: LoadedMap, maxSamples = 4096): FaceOrientationAudit {
  const out: FaceOrientationAudit = { sampled: 0, inverted: 0, correct: 0, ambiguous: 0, invertedArea: 0, correctArea: 0 };
  const world = map.collision as { pointContents?: (p: Vec3, mask?: number) => number } | null | undefined;
  const r = map.render;
  if (!world || typeof world.pointContents !== 'function' || !r?.batches) return out;
  const eligible = (b: RenderBatch): boolean => {
    if (!b || b.model !== 0 || b.isDisplacement || b.decal || (b.surfFlags & (SURF_SKY | SURF_SKY2D)) !== 0) return false;
    const d = r.materials.get(b.material);
    return !!d && !d.isTool && !d.isSky && !d.isWater && !d.translucent && !d.additive && !d.noCull;
  };
  let total = 0;
  for (const b of r.batches) if (eligible(b) && b.indices && b.positions) total += Math.floor(b.indices.length / 3);
  if (!total) return out;
  const stride = Math.max(1, Math.floor(total / Math.max(1, maxSamples)));
  const p: Vec3 = { x: 0, y: 0, z: 0 };
  const SOLID = CONTENTS_SOLID;
  const probe = (x: number, y: number, z: number): boolean => {
    p.x = x;
    p.y = y;
    p.z = z;
    try {
      return (world.pointContents!(p, SOLID) & SOLID) !== 0;
    } catch {
      return false;
    }
  };
  let k = 0;
  for (const b of r.batches) {
    if (!eligible(b) || !b.indices || !b.positions) continue;
    const P = b.positions;
    const I = b.indices;
    const nv = Math.floor(P.length / 3);
    for (let t = 0; t + 2 < I.length; t += 3, k++) {
      if (k % stride !== 0) continue;
      const a = I[t];
      const c1 = I[t + 1];
      const c2 = I[t + 2];
      if (a >= nv || c1 >= nv || c2 >= nv) continue;
      const ax = P[a * 3];
      const ay = P[a * 3 + 1];
      const az = P[a * 3 + 2];
      const e1x = P[c1 * 3] - ax;
      const e1y = P[c1 * 3 + 1] - ay;
      const e1z = P[c1 * 3 + 2] - az;
      const e2x = P[c2 * 3] - ax;
      const e2y = P[c2 * 3 + 1] - ay;
      const e2z = P[c2 * 3 + 2] - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 2)) continue; // slivers (area < 1 unit²) say nothing
      nx /= len;
      ny /= len;
      nz /= len;
      const cx = ax + (e1x + e2x) / 3;
      const cy = ay + (e1y + e2y) / 3;
      const cz = az + (e1z + e2z) / 3;
      const d = 1;
      const front = probe(cx + nx * d, cy + ny * d, cz + nz * d);
      const back = probe(cx - nx * d, cy - ny * d, cz - nz * d);
      out.sampled++;
      if (front && !back) {
        out.inverted++;
        out.invertedArea += len / 2;
      } else if (!front && back) {
        out.correct++;
        out.correctArea += len / 2;
      } else out.ambiguous++;
    }
  }
  return out;
}

/** True when an audit says that many brush faces are drawn inside-out (by surface area of the decided samples). */
export function auditSaysInverted(a: FaceOrientationAudit): boolean {
  return a.inverted >= 16 && a.invertedArea > INVERTED_FACE_THRESHOLD * (a.invertedArea + a.correctArea);
}

/**
 * Water batches that have a coplanar partner facing the other way (vbsp's top face + $bottommaterial face of
 * the same water surface): those are drawn one-sided so each side shows its own material. Lone water
 * surfaces are drawn from both sides.
 */
export function pairedWaterBatches(batches: readonly RenderBatch[], materials: Map<string, MaterialDef>): Set<RenderBatch> {
  const water = batches.filter((b) => b && b.normals && b.normals.length >= 3 && validBox(b.mins, b.maxs) && materials.get(b.material)?.isWater);
  const out = new Set<RenderBatch>();
  // boxes overlap (1 unit tolerance): the two faces cover the same part of the same surface
  const overlap = (a: RenderBatch, b: RenderBatch) =>
    a.mins.x <= b.maxs.x + 1 &&
    b.mins.x <= a.maxs.x + 1 &&
    a.mins.y <= b.maxs.y + 1 &&
    b.mins.y <= a.maxs.y + 1 &&
    a.mins.z <= b.maxs.z + 1 &&
    b.mins.z <= a.maxs.z + 1;
  for (let i = 0; i < water.length; i++) {
    const a = water[i];
    for (let j = i + 1; j < water.length; j++) {
      const b = water[j];
      if (a.model !== b.model || !overlap(a, b)) continue;
      const dot = a.normals[0] * b.normals[0] + a.normals[1] * b.normals[1] + a.normals[2] * b.normals[2];
      if (dot < -0.9) {
        out.add(a);
        out.add(b);
      }
    }
  }
  return out;
}

/** True when a light cube carries no light at all (the loader found no lighting at the prop's origin). */
export function isEmptyCube(cube: readonly (readonly number[])[] | undefined | null): boolean {
  if (!cube || cube.length < 6) return true;
  let s = 0;
  for (let i = 0; i < 6; i++) for (let k = 0; k < 3; k++) s += Math.abs(cube[i]?.[k] ?? 0);
  return !(s > 1e-6);
}

/**
 * Light cube for props whose own cube is empty (lighting origin inside solid / outside the map): the average of
 * the map's other prop cubes, or a neutral light when none has light. A pitch-black prop is never right.
 */
export function fallbackCube(props: readonly RenderProp[]): [number, number, number][] {
  const acc: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let n = 0;
  for (const p of props) {
    const c = p?.ambientCube;
    if (!c || isEmptyCube(c)) continue;
    for (let i = 0; i < 6; i++) for (let k = 0; k < 3; k++) acc[i][k] += Math.min(4, Math.max(0, c[i][k] ?? 0));
    n++;
  }
  if (!n) return acc.map(() => [0.75, 0.75, 0.75]) as [number, number, number][];
  return acc.map((c) => [c[0] / n, c[1] / n, c[2] / n]) as [number, number, number][];
}

/**
 * Splits items into spatially coherent clusters of at most `maxTris` triangles and 65535 vertices (recursive
 * median splits along the longest axis of the item centres, balanced by triangle count). Single items larger
 * than the limits stay alone.
 */
export function kdClusters<T>(
  items: readonly T[],
  center: (t: T) => Vec3,
  tris: (t: T) => number,
  verts: (t: T) => number,
  maxTris: number,
): T[][] {
  const out: T[][] = [];
  const rec = (list: T[], depth: number): void => {
    let nt = 0;
    let nv = 0;
    for (const t of list) {
      nt += tris(t);
      nv += verts(t);
    }
    if (list.length <= 1 || depth >= 32 || (nt <= maxTris && nv <= 65535)) {
      if (list.length) out.push(list);
      return;
    }
    let mnx = Infinity;
    let mny = Infinity;
    let mnz = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    let mxz = -Infinity;
    for (const t of list) {
      const c = center(t);
      mnx = Math.min(mnx, c.x);
      mny = Math.min(mny, c.y);
      mnz = Math.min(mnz, c.z);
      mxx = Math.max(mxx, c.x);
      mxy = Math.max(mxy, c.y);
      mxz = Math.max(mxz, c.z);
    }
    const ex = mxx - mnx;
    const ey = mxy - mny;
    const ez = mxz - mnz;
    const axis: 'x' | 'y' | 'z' = ex >= ey && ex >= ez ? 'x' : ey >= ez ? 'y' : 'z';
    const sorted = list.slice().sort((a, b) => center(a)[axis] - center(b)[axis]);
    // split where half of the triangles are on each side
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += tris(sorted[i]);
      cut = i + 1;
      if (acc >= nt / 2) break;
    }
    rec(sorted.slice(0, cut), depth + 1);
    rec(sorted.slice(cut), depth + 1);
  };
  rec(items.slice(), 0);
  return out;
}

/**
 * Merges props into world-space geometry with per-vertex lighting (light cube x tint): one family per material,
 * alpha and pass, split into spatial clusters.
 */
export function mergeProps(
  props: readonly RenderProp[],
  opts: {
    sky3dArea: number;
    envIndex: (p: Vec3) => number;
    usesEnv: (material: string) => boolean;
    fallbackCube?: readonly (readonly number[])[];
    /** Largest merged mesh in triangles (default 16384); bigger families are split spatially. */
    maxClusterTriangles?: number;
  },
): { group: PropGroup; positions: Float32Array; normals: Float32Array; uvs: Float32Array; light: Float32Array; indices: Uint32Array; mins: Vec3; maxs: Vec3 }[] {
  const groups = new Map<string, PropGroup>();
  // pass 1: valid props per (material, alpha, pass) and their triangle totals
  const families = new Map<string, { props: RenderProp[]; tris: number; alpha: number; sky3d: boolean }>();
  for (const p of props) {
    if (!p || !p.positions || !p.indices || p.positions.length < 9 || p.indices.length < 3) continue;
    const o = p.origin;
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) continue;
    const sky3d = opts.sky3dArea >= 0 && p.area === opts.sky3dArea;
    const alpha = p.alpha !== undefined && p.alpha < 1 ? Math.round(Math.max(0, p.alpha) * 32) / 32 : 1;
    if (alpha <= 0) continue;
    const fk = `${p.material}|${alpha}|${sky3d ? 1 : 0}`;
    let fam = families.get(fk);
    if (!fam) families.set(fk, (fam = { props: [], tris: 0, alpha, sky3d }));
    fam.props.push(p);
    fam.tris += p.indices.length / 3;
  }
  // pass 2: big families are split into spatial clusters of at most maxTris triangles / 65535 vertices: few
  // draw calls, still frustum-cullable
  const maxTris = opts.maxClusterTriangles ?? 16384;
  for (const [fk, fam] of families) {
    for (const list of kdClusters(
      fam.props,
      (p) => p.origin,
      (p) => p.indices.length / 3,
      (p) => Math.floor(p.positions.length / 3),
      maxTris,
    )) {
      let nv = 0;
      let ni = 0;
      for (const p of list) {
        nv += Math.floor(p.positions.length / 3);
        ni += p.indices.length;
      }
      const key = `${fk}#${groups.size}`;
      groups.set(key, { key, material: list[0].material, alpha: fam.alpha, sky3d: fam.sky3d, envKey: -1, props: list, verts: nv, idx: ni });
    }
  }
  const out = [];
  const f = { x: 0, y: 0, z: 0 };
  const r = { x: 0, y: 0, z: 0 };
  const u = { x: 0, y: 0, z: 0 };
  const lc = [0, 0, 0];
  for (const g of groups.values()) {
    const positions = new Float32Array(g.verts * 3);
    const normals = new Float32Array(g.verts * 3);
    const uvs = new Float32Array(g.verts * 2);
    const light = new Float32Array(g.verts * 3);
    const indices = new Uint32Array(g.idx);
    const mins = { x: Infinity, y: Infinity, z: Infinity };
    const maxs = { x: -Infinity, y: -Infinity, z: -Infinity };
    let vb = 0;
    let ib = 0;
    for (const p of g.props) {
      angleVectors(p.angles, f, r, u);
      const nv = Math.floor(p.positions.length / 3);
      const tint = p.color ? [srgbToLinear(p.color[0]), srgbToLinear(p.color[1]), srgbToLinear(p.color[2])] : [1, 1, 1];
      const cube = p.ambientCube && !isEmptyCube(p.ambientCube) ? p.ambientCube : (opts.fallbackCube ?? null);
      for (let i = 0; i < nv; i++) {
        const x = p.positions[i * 3];
        const y = p.positions[i * 3 + 1];
        const z = p.positions[i * 3 + 2];
        // model x -> forward, y -> left (-right), z -> up
        const wx = p.origin.x + x * f.x - y * r.x + z * u.x;
        const wy = p.origin.y + x * f.y - y * r.y + z * u.y;
        const wz = p.origin.z + x * f.z - y * r.z + z * u.z;
        const o3 = (vb + i) * 3;
        positions[o3] = wx;
        positions[o3 + 1] = wy;
        positions[o3 + 2] = wz;
        if (wx < mins.x) mins.x = wx;
        if (wy < mins.y) mins.y = wy;
        if (wz < mins.z) mins.z = wz;
        if (wx > maxs.x) maxs.x = wx;
        if (wy > maxs.y) maxs.y = wy;
        if (wz > maxs.z) maxs.z = wz;
        let nx = 0;
        let ny = 0;
        let nz = 1;
        if (p.normals && p.normals.length >= (i + 1) * 3) {
          const a = p.normals[i * 3];
          const b = p.normals[i * 3 + 1];
          const c = p.normals[i * 3 + 2];
          nx = a * f.x - b * r.x + c * u.x;
          ny = a * f.y - b * r.y + c * u.y;
          nz = a * f.z - b * r.z + c * u.z;
          const l = Math.hypot(nx, ny, nz);
          if (l > 1e-8) {
            nx /= l;
            ny /= l;
            nz /= l;
          } else {
            nx = 0;
            ny = 0;
            nz = 1;
          }
        }
        normals[o3] = nx;
        normals[o3 + 1] = ny;
        normals[o3 + 2] = nz;
        if (p.uvs && p.uvs.length >= (i + 1) * 2) {
          uvs[(vb + i) * 2] = p.uvs[i * 2];
          uvs[(vb + i) * 2 + 1] = p.uvs[i * 2 + 1];
        }
        if (cube) evalAmbientCube(cube, nx, ny, nz, lc);
        else {
          lc[0] = 1;
          lc[1] = 1;
          lc[2] = 1;
        }
        light[o3] = lc[0] * tint[0];
        light[o3 + 1] = lc[1] * tint[1];
        light[o3 + 2] = lc[2] * tint[2];
      }
      for (let i = 0; i < p.indices.length; i++) {
        const k = p.indices[i];
        indices[ib + i] = k < nv ? vb + k : vb;
      }
      vb += nv;
      ib += p.indices.length;
    }
    // reflective props use the cubemap nearest to their group (one material instance per group, not per prop)
    if (opts.usesEnv(g.material)) g.envKey = opts.envIndex({ x: (mins.x + maxs.x) / 2, y: (mins.y + maxs.y) / 2, z: (mins.z + maxs.z) / 2 });
    out.push({ group: g, positions, normals, uvs, light, indices, mins, maxs });
  }
  return out;
}

/** The scene content of one loaded map. */
export class MapScene {
  /** Main view content (sky masks, world, brush entities, props, decals, water). */
  readonly world = new Group();
  /** 3D skybox content, already scaled/placed into the main view's space. */
  readonly sky3d = new Group();
  readonly hasSky3d: boolean;
  readonly models = new Map<number, ModelEntry>();
  readonly stats: MapSceneStats = {
    meshes: 0,
    mergedGroups: 0,
    triangles: 0,
    skyMasks: 0,
    sky3dMeshes: 0,
    propMeshes: 0,
    propTriangles: 0,
    decals: 0,
    waterMeshes: 0,
    materials: 0,
    sortedTranslucent: 0,
  };
  private readonly animated: Animated[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private lightmapTex: Texture | null = null;
  private readonly cubeTextures = new Map<number, Texture>();
  private readonly cubemaps: CubemapDef[];
  private readonly cubeTextureByName = new Map<string, number>();
  private disposed = false;
  /** Brush-entity batches waiting to be merged, by material/variant key. */
  private readonly mergeQueue = new Map<string, MergeQueue>();
  /** Model state texture: per model id, row 0 = (visible, alpha, -, -), row 1 = linear tint. */
  private modelState: DataTexture | null = null;
  private modelStateWidth = 1;
  readonly mergedGroups: MergedGroup[] = [];
  /** Face orientation audit of the map's brush surfaces (null when not run). */
  faceAudit: FaceOrientationAudit | null = null;
  /** BSP surfaces are drawn double-sided (see MapSceneOptions.doubleSided). */
  doubleSided = false;
  /** Water batches drawn one-sided (top + bottom face pairs). */
  private pairedWater: Set<RenderBatch> = new Set();
  /** Back-to-front plane order inside translucent meshes (see translucency.ts). */
  readonly sorter = new TranslucentSorter();

  constructor(
    readonly map: LoadedMap,
    private readonly opts: MapSceneOptions,
  ) {
    this.world.name = 'world';
    this.sky3d.name = 'sky3d';
    this.world.matrixAutoUpdate = false;
    this.sky3d.matrixAutoUpdate = false;
    const s3 = map.render?.sky3d ?? null;
    this.hasSky3d = !!s3 && s3.area >= 0 && Number.isFinite(s3.origin.x) && Number.isFinite(s3.origin.y) && Number.isFinite(s3.origin.z);
    if (this.hasSky3d && s3) sky3dMatrix(s3.origin, s3.scale, this.sky3d.matrix);
    this.cubemaps = (map.render?.cubemaps ?? []).filter((c) => c && c.faces && c.faces.length === 6 && c.faces[0].width > 0);
    this.cubemaps.forEach((c, i) => {
      if (c.texture) this.cubeTextureByName.set(c.texture.toLowerCase(), i);
    });
  }

  /** Builds everything; `yieldEvery` lets the caller keep the page responsive on huge maps. */
  async build(onStep?: (done: number, total: number) => Promise<void> | void): Promise<void> {
    const r = this.map.render;
    if (!r) return;
    const batches = (r.batches ?? []).filter((b) => !!b);
    const ds = this.opts.doubleSided ?? 'auto';
    if (ds === 'auto') {
      this.faceAudit = auditFaceOrientation(this.map);
      this.doubleSided = auditSaysInverted(this.faceAudit);
    } else this.doubleSided = ds;
    this.pairedWater = pairedWaterBatches(batches, r.materials);
    if (r.lightmap && r.lightmap.width > 0 && r.lightmap.height > 0 && r.lightmap.data && r.lightmap.data.length >= 4) {
      this.lightmapTex = this.opts.textures.lightmap(r.lightmap);
    }
    if (this.opts.mergeBrushEntities !== false) {
      let maxModel = 0;
      for (const b of batches) if (b.model > maxModel) maxModel = b.model;
      for (let i = 0; i < (this.map.models?.length ?? 0); i++) maxModel = Math.max(maxModel, i);
      this.createModelState(maxModel);
    }
    // Group draw submission by shader variant: material ids then follow program order (fewer program switches).
    const order = batches.map((b, i) => ({ b, i, k: this.variantSortKey(b) }));
    order.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
    const total = order.length + 1;
    let done = 0;
    for (const { b } of order) {
      this.addBatch(b);
      done++;
      if (onStep && (done & 31) === 0) await onStep(done, total);
    }
    this.flushMerged();
    this.addProps(r.props ?? []);
    done++;
    if (onStep) await onStep(done, total);
    this.world.updateMatrixWorld(true);
    this.sky3d.updateMatrixWorld(true);
    for (const m of this.meshes()) if ((m.material as ShaderMaterial).transparent) this.sorter.add(m);
    this.stats.sortedTranslucent = this.sorter.count;
    this.stats.materials = this.opts.materials.materials.length;
  }

  private variantSortKey(b: RenderBatch): string {
    const def = this.map.render.materials.get(b.material);
    if (!def) return 'z';
    if (isSkyBatch(b, def)) return '0';
    const lm = b.lightmapUVs ? 'L' : 'U';
    return `1${def.isWater ? 'W' : 'S'}${lm}${def.alphaTest ? 'A' : ''}${def.detail ? 'D' : ''}${def.envmap ? 'E' : ''}${b.alphas ? 'B' : ''}|${b.material}`;
  }

  private modelEntry(model: number): ModelEntry {
    let e = this.models.get(model);
    if (!e) {
      e = { model, meshes: [], merged: [], materials: new Set(), uniforms: createModelUniforms(), visible: true, alpha: 1, color: [1, 1, 1] };
      this.writeModelState(e);
      this.models.set(model, e);
    }
    return e;
  }

  private envIndexNear(p: Vec3): number {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.cubemaps.length; i++) {
      const o = this.cubemaps[i].origin;
      const d = (o.x - p.x) ** 2 + (o.y - p.y) ** 2 + (o.z - p.z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  private envFor(def: MaterialDef, center: Vec3): number {
    if (!def.envmap || !this.cubemaps.length) return -1;
    const name = (def.envmap.cubemap ?? '').toLowerCase();
    if (name && name !== 'env_cubemap') {
      const direct = this.cubeTextureByName.get(name) ?? this.cubeTextureByName.get(name.replace(/\.hdr$/, ''));
      if (direct !== undefined) return direct;
    }
    return this.envIndexNear(center);
  }

  private envTexture(i: number): Texture | null {
    if (i < 0 || i >= this.cubemaps.length) return null;
    let t = this.cubeTextures.get(i);
    if (!t) {
      const faces = this.cubemaps[i].faces!;
      const n = faces[0].width;
      const data = faces.map((f) => {
        if (f.width === n && f.height === n && f.data.length >= n * n * 4) return f.data;
        // resample odd faces to the first face's size (nearest)
        const out = new Uint8Array(n * n * 4);
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const sx = Math.min(f.width - 1, Math.floor(((x + 0.5) * f.width) / n));
            const sy = Math.min(f.height - 1, Math.floor(((y + 0.5) * f.height) / n));
            out.set(f.data.subarray((sy * f.width + sx) * 4, (sy * f.width + sx) * 4 + 4), (y * n + x) * 4);
          }
        }
        return out;
      });
      t = this.opts.textures.cube(data, n, true);
      this.cubeTextures.set(i, t);
    }
    return t;
  }

  private register(mesh: Mesh, model: number, mat: ShaderMaterial): void {
    if (model > 0) {
      const e = this.modelEntry(model);
      e.meshes.push(mesh);
      e.materials.add(mat);
    }
    const info = mat.userData.surf as SurfMaterialInfo | undefined;
    if (info && !info.isMask && (info.scroll || info.frames) && !this.animated.some((a) => a.material === mat)) {
      this.animated.push({ material: mat, info });
    }
  }

  private addBatch(b: RenderBatch): void {
    const r = this.map.render;
    const def = r.materials.get(b.material);
    const pos = b.positions;
    if (!pos || pos.length < 9 || !b.indices || b.indices.length < 3) return;
    const nv = Math.floor(pos.length / 3);
    if (!indicesValid(b.indices, nv)) return;
    const sky = isSkyBatch(b, def);
    if (!sky && (!def || def.isTool)) return;
    const s3 = r.sky3d;
    const inSky3d = this.hasSky3d && !!s3 && b.area === s3.area;
    const pass: 'world' | 'sky3d' = inSky3d ? 'sky3d' : 'world';
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    let material: ShaderMaterial;
    let order = ORDER_WORLD;
    if (sky && b.model === 0 && this.opts.mergeWorld !== false) {
      g.dispose();
      this.enqueue(`sky|${pass}`, { kind: 'sky', batches: [], def: null, v: null, envKey: -1, sky3d: inSky3d }, b);
      return;
    }
    if (sky) {
      material = this.opts.materials.skyMask(pass);
      order = ORDER_SKY_MASK;
    } else {
      const d = def!;
      g.setAttribute('normal', new BufferAttribute(b.normals && b.normals.length >= nv * 3 ? b.normals : defaultNormals(nv), 3));
      // a copy: the batch's own coordinates stay untouched (the map can be loaded again)
      const uvs = b.uvs && b.uvs.length >= nv * 2 ? b.uvs.slice(0, nv * 2) : new Float32Array(nv * 2);
      rebaseUvs(uvs, b.indices, nv, uvRebaseStep(d));
      g.setAttribute('uv', new BufferAttribute(uvs, 2));
      const lit = !!(this.lightmapTex && b.lightmapUVs && b.lightmapUVs.length >= nv * 2 && !d.unlit);
      if (lit) g.setAttribute('lmuv', new BufferAttribute(b.lightmapUVs!, 2));
      const blend = !!(b.alphas && b.alphas.length >= nv && (d.image2 || d.fallbackColor2));
      if (blend) g.setAttribute('blendAlpha', new BufferAttribute(b.alphas!, 1));
      const center = validBox(b.mins, b.maxs)
        ? { x: (b.mins.x + b.maxs.x) / 2, y: (b.mins.y + b.maxs.y) / 2, z: (b.mins.z + b.maxs.z) / 2 }
        : { x: pos[0], y: pos[1], z: pos[2] };
      // water reflects the nearest baked cubemap (Source's cheap water uses env_cubemap), else the sky
      const envKey = d.isWater ? this.envIndexNear(center) : this.envFor(d, center);
      const v: SurfaceVariant = {
        lightmap: lit ? this.lightmapTex : null,
        vertexLight: false,
        synthLight: !r.lightmap,
        blend,
        decal: !!b.decal,
        envCube: this.envTexture(envKey),
        pass,
        doubleSided: this.doubleSided || (d.isWater && !this.pairedWater.has(b)),
      };
      const key = [b.material, lit ? 'L' : 'U', blend ? 'B' : '', pass, envKey].join('|');
      if (b.model > 0 && this.modelState && !d.isWater && !b.decal) {
        // brush entity: merged with the other models' batches of this material (see flushMerged)
        g.dispose();
        this.modelEntry(b.model);
        this.enqueue(`E|${key}`, { kind: 'entity', batches: [], def: d, v, envKey, sky3d: inSky3d }, b);
        return;
      }
      const translucent = d.translucent || d.additive || d.alpha < 1;
      if (b.model === 0 && this.opts.mergeWorld !== false && !d.isWater && !b.decal && !translucent) {
        // opaque world surfaces: merged into spatial clusters per material (fewer draw calls)
        g.dispose();
        this.enqueue(`W|${key}`, { kind: 'world', batches: [], def: d, v, envKey, sky3d: inSky3d }, b);
        return;
      }
      const mu = b.model > 0 ? this.modelEntry(b.model).uniforms : null;
      material = this.opts.materials.get(d, v, b.model > 0 ? `m${b.model}` : '', mu, envKey);
      if (b.decal) {
        order = material.transparent ? ORDER_DECAL_TRANSLUCENT : ORDER_DECAL;
        this.stats.decals++;
      }
      if (d.isWater) this.stats.waterMeshes++;
    }
    g.setIndex(indexAttribute(b.indices, nv));
    setBounds(g, b.mins, b.maxs);
    const mesh = new Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.name = sky ? 'sky' : b.material;
    mesh.userData.model = b.model;
    (inSky3d ? this.sky3d : this.world).add(mesh);
    this.geometries.push(g);
    this.register(mesh, b.model, material);
    this.stats.meshes++;
    this.stats.triangles += b.indices.length / 3;
    if (sky) this.stats.skyMasks++;
    if (inSky3d) this.stats.sky3dMeshes++;
  }

  private createModelState(maxModel: number): void {
    const n = Math.max(1, maxModel + 1);
    const w = Math.min(n, 1024);
    const rows = Math.ceil(n / w) * 2;
    const data = new Uint8Array(w * rows * 4);
    for (let id = 0; id < n; id++) {
      const o = this.stateOffset(id, w);
      data.set([255, 255, 0, 255], o);
      data.set([255, 255, 255, 255], o + w * 4);
    }
    const t = new DataTexture(data, w, rows, RGBAFormat, UnsignedByteType);
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.colorSpace = NoColorSpace;
    t.needsUpdate = true;
    this.modelState = t;
    this.modelStateWidth = w;
  }

  /** Byte offset of model `id`'s row-0 texel (row 1, the tint, is one texture row below). */
  private stateOffset(id: number, w = this.modelStateWidth): number {
    return ((Math.floor(id / w) * 2) * w + (id % w)) * 4;
  }

  /** Writes a model's state into the state texture and refreshes its merged groups' draw flags. */
  private writeModelState(e: ModelEntry): void {
    const t = this.modelState;
    if (t && e.model >= 0) {
      const w = this.modelStateWidth;
      const data = t.image.data as Uint8Array;
      const o = this.stateOffset(e.model, w);
      if (o + w * 4 + 3 < data.length) {
        data[o] = e.visible ? 255 : 0;
        data[o + 1] = Math.round(e.alpha * 255);
        const tint = e.uniforms.uTint.value;
        data[o + w * 4] = Math.round(Math.max(0, Math.min(1, tint.x)) * 255);
        data[o + w * 4 + 1] = Math.round(Math.max(0, Math.min(1, tint.y)) * 255);
        data[o + w * 4 + 2] = Math.round(Math.max(0, Math.min(1, tint.z)) * 255);
        t.needsUpdate = true;
      }
    }
    for (const g of e.merged) this.refreshGroup(g);
  }

  /** Mesh visibility of a merged group: skip draws that would cull every vertex. */
  private refreshGroup(g: MergedGroup): void {
    let opaque = false;
    let faded = false;
    for (const id of g.models) {
      const m = this.models.get(id);
      const vis = !m || m.visible;
      const a = m ? m.alpha : 1;
      if (!vis || a <= 0) continue;
      if (a >= 1) opaque = true;
      else faded = true;
    }
    if (g.faded) {
      g.opaque.visible = opaque;
      g.faded.visible = faded;
    } else g.opaque.visible = opaque || faded;
  }

  private enqueue(key: string, init: MergeQueue, b: RenderBatch): void {
    let q = this.mergeQueue.get(key);
    if (!q) this.mergeQueue.set(key, (q = init));
    q.batches.push(b);
  }

  /** Builds the merged meshes queued by addBatch: per queue, spatial clusters of batches. */
  private flushMerged(): void {
    const maxTris = this.opts.clusterTriangles ?? 16384;
    for (const q of this.mergeQueue.values()) {
      const clusters = kdClusters(
        q.batches,
        batchCenter,
        (b) => b.indices.length / 3,
        (b) => Math.floor(b.positions.length / 3),
        maxTris,
      );
      for (const list of clusters) this.buildMerged(q, list);
    }
    this.mergeQueue.clear();
  }

  private buildMerged(q: MergeQueue, list: RenderBatch[]): void {
    let nv = 0;
    let ni = 0;
    for (const b of list) {
      nv += Math.floor(b.positions.length / 3);
      ni += b.indices.length;
    }
    const surface = q.kind !== 'sky';
    const lit = surface && !!q.v?.lightmap;
    const blend = surface && !!q.v?.blend;
    const positions = new Float32Array(nv * 3);
    const normals = surface ? new Float32Array(nv * 3) : null;
    const uvs = surface ? new Float32Array(nv * 2) : null;
    const lmuv = lit ? new Float32Array(nv * 2) : null;
    const alphas = blend ? new Float32Array(nv) : null;
    const modelIndex = q.kind === 'entity' ? new Float32Array(nv) : null;
    const indices = new Uint32Array(ni);
    const mins = { x: Infinity, y: Infinity, z: Infinity };
    const maxs = { x: -Infinity, y: -Infinity, z: -Infinity };
    const models = new Set<number>();
    let vb = 0;
    let ib = 0;
    for (const b of list) {
      const n = Math.floor(b.positions.length / 3);
      positions.set(b.positions.subarray(0, n * 3), vb * 3);
      if (normals) {
        if (b.normals && b.normals.length >= n * 3) normals.set(b.normals.subarray(0, n * 3), vb * 3);
        else for (let i = 0; i < n; i++) normals[(vb + i) * 3 + 2] = 1;
      }
      if (uvs && b.uvs && b.uvs.length >= n * 2) uvs.set(b.uvs.subarray(0, n * 2), vb * 2);
      if (lmuv && b.lightmapUVs) lmuv.set(b.lightmapUVs.subarray(0, n * 2), vb * 2);
      if (alphas && b.alphas) alphas.set(b.alphas.subarray(0, n), vb);
      if (modelIndex) modelIndex.fill(b.model, vb, vb + n);
      for (let i = 0; i < b.indices.length; i++) indices[ib + i] = b.indices[i] + vb;
      if (validBox(b.mins, b.maxs)) {
        mins.x = Math.min(mins.x, b.mins.x);
        mins.y = Math.min(mins.y, b.mins.y);
        mins.z = Math.min(mins.z, b.mins.z);
        maxs.x = Math.max(maxs.x, b.maxs.x);
        maxs.y = Math.max(maxs.y, b.maxs.y);
        maxs.z = Math.max(maxs.z, b.maxs.z);
      } else {
        for (let i = 0; i < n; i++) {
          mins.x = Math.min(mins.x, b.positions[i * 3]);
          mins.y = Math.min(mins.y, b.positions[i * 3 + 1]);
          mins.z = Math.min(mins.z, b.positions[i * 3 + 2]);
          maxs.x = Math.max(maxs.x, b.positions[i * 3]);
          maxs.y = Math.max(maxs.y, b.positions[i * 3 + 1]);
          maxs.z = Math.max(maxs.z, b.positions[i * 3 + 2]);
        }
      }
      models.add(b.model);
      vb += n;
      ib += b.indices.length;
    }
    // texture coordinates near zero (float precision across big faces, see uvrebase.ts)
    if (uvs && q.def) rebaseUvs(uvs, indices, nv, uvRebaseStep(q.def));
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    if (normals) g.setAttribute('normal', new BufferAttribute(normals, 3));
    if (uvs) g.setAttribute('uv', new BufferAttribute(uvs, 2));
    if (lmuv) g.setAttribute('lmuv', new BufferAttribute(lmuv, 2));
    if (alphas) g.setAttribute('blendAlpha', new BufferAttribute(alphas, 1));
    if (modelIndex) g.setAttribute('modelIndex', new BufferAttribute(modelIndex, 1));
    g.setIndex(indexAttribute(indices, nv));
    setBounds(g, mins, maxs);
    this.geometries.push(g);
    const parent = q.sky3d ? this.sky3d : this.world;
    const addMesh = (mat: ShaderMaterial, name: string, order: number): Mesh => {
      const mesh = new Mesh(g, mat);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = order;
      mesh.name = name;
      mesh.userData.model = q.kind === 'entity' ? -1 : 0;
      if (q.kind === 'entity') mesh.userData.models = models;
      parent.add(mesh);
      this.register(mesh, 0, mat);
      this.stats.meshes++;
      if (q.sky3d) this.stats.sky3dMeshes++;
      return mesh;
    };
    this.stats.triangles += ni / 3;
    if (q.kind === 'sky') {
      addMesh(this.opts.materials.skyMask(q.sky3d ? 'sky3d' : 'world'), 'sky', ORDER_SKY_MASK);
      this.stats.skyMasks++;
      return;
    }
    const def = q.def!;
    if (q.kind === 'world') {
      addMesh(this.opts.materials.get(def, q.v!, '', null, q.envKey), def.name, ORDER_WORLD);
      return;
    }
    const state = this.modelState!;
    const selfTranslucent = def.translucent || def.additive || def.alpha < 1;
    const mk = (modelPass: 0 | 1 | 2): Mesh => {
      const v: SurfaceVariant = { ...q.v!, modelState: state, modelStateWidth: this.modelStateWidth, modelPass };
      return addMesh(this.opts.materials.get(def, v, `merged${modelPass}`, null, q.envKey), def.name, ORDER_WORLD);
    };
    const group: MergedGroup = selfTranslucent ? { models, opaque: mk(2), faded: null } : { models, opaque: mk(0), faded: mk(1) };
    this.stats.mergedGroups++;
    this.mergedGroups.push(group);
    for (const id of models) this.modelEntry(id).merged.push(group);
    this.refreshGroup(group);
  }

  private addProps(props: readonly RenderProp[]): void {
    if (!props.length) return;
    const r = this.map.render;
    const s3 = r.sky3d;
    const merged = mergeProps(props, {
      sky3dArea: this.hasSky3d && s3 ? s3.area : -1,
      maxClusterTriangles: this.opts.propClusterTriangles,
      envIndex: (p) => this.envIndexNear(p),
      usesEnv: (m) => !!r.materials.get(m)?.envmap && this.cubemaps.length > 0,
      fallbackCube: fallbackCube(props),
    });
    for (const mg of merged) {
      const def = r.materials.get(mg.group.material);
      if (!def || def.isTool || def.isSky) continue;
      const nv = mg.positions.length / 3;
      if (nv < 3 || mg.indices.length < 3) continue;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(mg.positions, 3));
      g.setAttribute('normal', new BufferAttribute(mg.normals, 3));
      g.setAttribute('uv', new BufferAttribute(mg.uvs, 2));
      g.setAttribute('vlight', new BufferAttribute(mg.light, 3));
      g.setIndex(indexAttribute(mg.indices, nv));
      setBounds(g, mg.mins, mg.maxs);
      const pass: 'world' | 'sky3d' = mg.group.sky3d ? 'sky3d' : 'world';
      const v: SurfaceVariant = {
        lightmap: null,
        vertexLight: true,
        synthLight: false,
        blend: false,
        decal: false,
        envCube: this.envTexture(mg.group.envKey),
        pass,
        doubleSided: false,
      };
      let mu: ModelUniforms | null = null;
      let key = 'prop';
      if (mg.group.alpha < 1) {
        mu = createModelUniforms();
        mu.alpha = mg.group.alpha;
        key = `prop|a${mg.group.alpha}`;
      }
      const material = this.opts.materials.get(def, v, key, mu, mg.group.envKey);
      if (mu) applyModelAlpha(material, mu.alpha);
      const mesh = new Mesh(g, material);
      mesh.matrixAutoUpdate = false;
      mesh.name = `prop:${mg.group.material}`;
      (mg.group.sky3d ? this.sky3d : this.world).add(mesh);
      this.geometries.push(g);
      this.register(mesh, 0, material);
      this.stats.meshes++;
      this.stats.propMeshes++;
      const tris = mg.indices.length / 3;
      this.stats.triangles += tris;
      this.stats.propTriangles += tris;
      if (mg.group.sky3d) this.stats.sky3dMeshes++;
    }
  }

  // ------------------------------------------------------------------------------ runtime state

  setModelVisible(model: number, visible: boolean): void {
    const e = this.modelEntry(model);
    e.visible = !!visible;
    for (const m of e.meshes) m.visible = e.visible;
    this.writeModelState(e);
  }

  setModelAlpha(model: number, alpha: number): void {
    const e = this.modelEntry(model);
    const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    e.alpha = a;
    e.uniforms.alpha = a;
    for (const m of e.materials) applyModelAlpha(m, a);
    this.writeModelState(e);
  }

  setModelColor(model: number, rgb: [number, number, number]): void {
    const e = this.modelEntry(model);
    const c: [number, number, number] = [0, 1, 2].map((i) => {
      const x = rgb?.[i];
      return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 1;
    }) as [number, number, number];
    e.color = c;
    setModelTint(e.uniforms, c);
    this.writeModelState(e);
  }

  /** Per-frame material animation (texture scroll, animated textures). */
  update(time: number): void {
    for (const a of this.animated) {
      const info = a.info;
      if (info.scroll) setUvTransform(info.uvTransform, info.transform, scrollOffset(info.scroll[0], time), scrollOffset(info.scroll[1], time));
      if (info.frames) {
        const n = info.frames.length;
        const f = Math.floor(time * info.frameRate) % n;
        (a.material.uniforms.map as U<Texture>).value = info.frames[f < 0 ? f + n : f];
      }
    }
  }

  /** Orders translucent geometry back to front for an eye position (call every frame). */
  sortTranslucent(eye: Vector3): void {
    this.sorter.update(eye);
  }

  /** All meshes (both passes). */
  meshes(): Mesh[] {
    const out: Mesh[] = [];
    for (const g of [this.world, this.sky3d]) for (const c of g.children) if ((c as Mesh).isMesh) out.push(c as Mesh);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.world.clear();
    this.sky3d.clear();
    this.models.clear();
    this.animated.length = 0;
    this.cubeTextures.clear();
    this.lightmapTex = null;
    this.modelState?.dispose();
    this.modelState = null;
    this.mergedGroups.length = 0;
    this.mergeQueue.clear();
    this.sorter.clear();
  }
}

function defaultNormals(n: number): Float32Array {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a[i * 3 + 2] = 1;
  return a;
}
