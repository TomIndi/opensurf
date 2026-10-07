// LoadedMap -> three.js scene graph: one Mesh per RenderBatch (world, brush entities, decals, water, sky
// masks), merged static props, the 3D skybox group, per-model render state and animated materials.
//
// Nothing here needs a WebGL context (unit-testable in node); the Renderer uploads and draws the result.
import { BufferAttribute, BufferGeometry, Box3, Group, Matrix4, Mesh, ShaderMaterial, Sphere, Texture, Vector3 } from 'three';
import { angleVectors } from '../core/angles';
import type { Vec3 } from '../core/vec3';
import { SURF_SKY, SURF_SKY2D } from '../bsp/types';
import type { CubemapDef, LoadedMap, MaterialDef, RenderBatch, RenderProp } from '../map/types';
import { TextureCache } from './textures';
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

/** Opaque draw order groups (three.js sorts by renderOrder, then material, then depth). */
export const ORDER_SKY_MASK = -10;
export const ORDER_WORLD = 0;
export const ORDER_DECAL = 1;
/** Translucent decals go first among the translucent surfaces. */
export const ORDER_DECAL_TRANSLUCENT = -1;

export interface ModelEntry {
  model: number;
  meshes: Mesh[];
  materials: Set<ShaderMaterial>;
  uniforms: ModelUniforms;
  visible: boolean;
  alpha: number;
  color: [number, number, number];
}

export interface MapSceneStats {
  meshes: number;
  triangles: number;
  skyMasks: number;
  sky3dMeshes: number;
  propMeshes: number;
  propTriangles: number;
  decals: number;
  waterMeshes: number;
  materials: number;
}

export interface MapSceneOptions {
  textures: TextureCache;
  materials: SurfaceMaterials;
  shared: SharedUniforms;
  /** XY cell size used to split merged props for culling (default 2048). */
  propCellSize?: number;
}

interface Animated {
  material: ShaderMaterial;
  info: SurfMaterialInfo;
}

const _v = new Vector3();

/** Matrix mapping 3D-skybox space to the main view's space: p' = (p - origin) * scale. */
export function sky3dMatrix(origin: Vec3, scale: number, out: Matrix4 = new Matrix4()): Matrix4 {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 16;
  return out.set(s, 0, 0, -origin.x * s, 0, s, 0, -origin.y * s, 0, 0, s, -origin.z * s, 0, 0, 0, 1);
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

/** Merges static props into world-space geometry with per-vertex lighting (one group per material/cell). */
export function mergeProps(
  props: readonly RenderProp[],
  opts: { sky3dArea: number; cellSize: number; envIndex: (p: Vec3) => number; usesEnv: (material: string) => boolean },
): { group: PropGroup; positions: Float32Array; normals: Float32Array; uvs: Float32Array; light: Float32Array; indices: Uint32Array; mins: Vec3; maxs: Vec3 }[] {
  const groups = new Map<string, PropGroup>();
  const cell = opts.cellSize > 0 ? opts.cellSize : 2048;
  for (const p of props) {
    if (!p || !p.positions || !p.indices || p.positions.length < 9 || p.indices.length < 3) continue;
    const o = p.origin;
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) continue;
    const sky3d = opts.sky3dArea >= 0 && p.area === opts.sky3dArea;
    const alpha = p.alpha !== undefined && p.alpha < 1 ? Math.round(Math.max(0, p.alpha) * 32) / 32 : 1;
    if (alpha <= 0) continue;
    const env = opts.usesEnv(p.material) ? opts.envIndex(o) : -1;
    const ck = `${Math.floor(o.x / cell)},${Math.floor(o.y / cell)},${Math.floor(o.z / (cell * 2))}`;
    const key = `${p.material}|${alpha}|${sky3d ? 1 : 0}|${env}|${ck}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, material: p.material, alpha, sky3d, envKey: env, props: [], verts: 0, idx: 0 }));
    const nv = Math.floor(p.positions.length / 3);
    // keep merged meshes below 65536 vertices (16-bit indices) where possible
    if (g.verts > 0 && g.verts + nv > 65535) {
      let n = 1;
      let k2 = `${key}#${n}`;
      while (groups.has(k2) && groups.get(k2)!.verts + nv > 65535) k2 = `${key}#${++n}`;
      g = groups.get(k2);
      if (!g) groups.set(k2, (g = { key: k2, material: p.material, alpha, sky3d, envKey: env, props: [], verts: 0, idx: 0 }));
    }
    g.props.push(p);
    g.verts += nv;
    g.idx += p.indices.length;
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
      const cube = p.ambientCube && p.ambientCube.length >= 6 ? p.ambientCube : null;
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
    triangles: 0,
    skyMasks: 0,
    sky3dMeshes: 0,
    propMeshes: 0,
    propTriangles: 0,
    decals: 0,
    waterMeshes: 0,
    materials: 0,
  };
  private readonly animated: Animated[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private lightmapTex: Texture | null = null;
  private readonly cubeTextures = new Map<number, Texture>();
  private readonly cubemaps: CubemapDef[];
  private readonly cubeTextureByName = new Map<string, number>();
  private disposed = false;

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
    if (r.lightmap && r.lightmap.width > 0 && r.lightmap.height > 0 && r.lightmap.data && r.lightmap.data.length >= 4) {
      this.lightmapTex = this.opts.textures.lightmap(r.lightmap);
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
    this.addProps(r.props ?? []);
    done++;
    if (onStep) await onStep(done, total);
    this.world.updateMatrixWorld(true);
    this.sky3d.updateMatrixWorld(true);
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
      e = { model, meshes: [], materials: new Set(), uniforms: createModelUniforms(), visible: true, alpha: 1, color: [1, 1, 1] };
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
    if (sky) {
      material = this.opts.materials.skyMask(pass);
      order = ORDER_SKY_MASK;
    } else {
      const d = def!;
      g.setAttribute('normal', new BufferAttribute(b.normals && b.normals.length >= nv * 3 ? b.normals : defaultNormals(nv), 3));
      g.setAttribute('uv', new BufferAttribute(b.uvs && b.uvs.length >= nv * 2 ? b.uvs : new Float32Array(nv * 2), 2));
      const lit = !!(this.lightmapTex && b.lightmapUVs && b.lightmapUVs.length >= nv * 2 && !d.unlit);
      if (lit) g.setAttribute('lmuv', new BufferAttribute(b.lightmapUVs!, 2));
      const blend = !!(b.alphas && b.alphas.length >= nv && (d.image2 || d.fallbackColor2));
      if (blend) g.setAttribute('blendAlpha', new BufferAttribute(b.alphas!, 1));
      const center = validBox(b.mins, b.maxs)
        ? { x: (b.mins.x + b.maxs.x) / 2, y: (b.mins.y + b.maxs.y) / 2, z: (b.mins.z + b.maxs.z) / 2 }
        : { x: pos[0], y: pos[1], z: pos[2] };
      const envKey = this.envFor(d, center);
      const v: SurfaceVariant = {
        lightmap: lit ? this.lightmapTex : null,
        vertexLight: false,
        synthLight: !r.lightmap,
        blend,
        decal: !!b.decal,
        envCube: this.envTexture(envKey),
        pass,
      };
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

  private addProps(props: readonly RenderProp[]): void {
    if (!props.length) return;
    const r = this.map.render;
    const s3 = r.sky3d;
    const merged = mergeProps(props, {
      sky3dArea: this.hasSky3d && s3 ? s3.area : -1,
      cellSize: this.opts.propCellSize ?? 2048,
      envIndex: (p) => this.envIndexNear(p),
      usesEnv: (m) => !!r.materials.get(m)?.envmap && this.cubemaps.length > 0,
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
  }

  setModelAlpha(model: number, alpha: number): void {
    const e = this.modelEntry(model);
    const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    e.alpha = a;
    e.uniforms.alpha = a;
    for (const m of e.materials) applyModelAlpha(m, a);
  }

  setModelColor(model: number, rgb: [number, number, number]): void {
    const e = this.modelEntry(model);
    const c: [number, number, number] = [0, 1, 2].map((i) => {
      const x = rgb?.[i];
      return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 1;
    }) as [number, number, number];
    e.color = c;
    setModelTint(e.uniforms, c);
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
  }
}

function defaultNormals(n: number): Float32Array {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a[i * 3 + 2] = 1;
  return a;
}
