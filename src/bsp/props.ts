// Static props: the 'sprp' game lump plus the studio models (.mdl / .vvd / .vtx) the map packs.
//
// sprp layout (public format documentation): int dictCount, dictCount x char[128] model names; int leafCount,
// leafCount x u16 leaves; int propCount, propCount x StaticPropLump_t. Every version starts with the same
// 56-byte v4 core (origin, angles, propType, firstLeaf, leafCount, solid, flags, skin, fade distances, lighting
// origin); later versions append fields (v5 forced fade scale, v6 DX levels, v7/v8 CPU/GPU levels + diffuse
// modulation, v9 X360 flag, v10/v11 extra flags / uniform scale), so the record size is taken from the lump
// size (and must be at least the size the version implies).
//
// Models: only props whose .mdl, .vvd and .vtx (dx90, dx80 or sw) are all packed are decoded - stock models
// live in the game's VPKs, which we don't have. LOD 0 triangles of body part models 0 are read from the VTX
// strip groups (indices -> VTX vertices -> origMeshVertID + mesh/model vertex offsets -> VVD vertices, after the
// VVD LOD fixups). One RenderProp is produced per prop instance and material; instances of the same model and
// skin share their vertex arrays. Nothing here may break map loading: every model is decoded under try/catch.
import type { QAngle } from '../core/angles';
import { Vec3 } from '../core/vec3';
import type { MaterialDef, RenderProp } from '../map/types';
import { BuildMaterialsOptions, MaterialFileSource, MaterialLoader, normalizeMaterialName } from './materials';
import { PakFile, normalizePakPath } from './pakfile';
import { BspFile } from './types';

// ------------------------------------------------------------------------------------------ sprp lump

export interface StaticPropInstance {
  /** Index into the dictionary. */
  propType: number;
  /** Model path as stored ("models/props/foo.mdl"). */
  model: string;
  origin: Vec3;
  angles: QAngle;
  solid: number;
  flags: number;
  skin: number;
  fadeMinDist: number;
  fadeMaxDist: number;
  lightingOrigin: Vec3;
  /** Uniform scale (v11+), 1 otherwise. */
  scale: number;
}

export interface StaticPropLump {
  version: number;
  dictionary: string[];
  leaves: Uint16Array;
  props: StaticPropInstance[];
  /** Bytes per prop record used to parse. */
  recordSize: number;
}

/** Minimum record size per sprp version. */
const MIN_RECORD: Record<number, number> = { 4: 56, 5: 60, 6: 64, 7: 68, 8: 68, 9: 72, 10: 72, 11: 76, 12: 76, 13: 76 };

/** Parses a 'sprp' game lump. Throws on truncated/corrupt data. */
export function parseStaticPropLump(data: Uint8Array, version: number): StaticPropLump {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  const need = (n: number): void => {
    if (o + n > data.length) throw new Error('sprp lump truncated');
  };
  need(4);
  const nDict = dv.getInt32(o, true);
  o += 4;
  if (nDict < 0 || nDict > 65536) throw new Error(`bad sprp dictionary count ${nDict}`);
  need(nDict * 128);
  const dictionary: string[] = [];
  for (let i = 0; i < nDict; i++) {
    let s = '';
    for (let k = 0; k < 128; k++) {
      const c = data[o + k];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    dictionary.push(s);
    o += 128;
  }
  need(4);
  const nLeaf = dv.getInt32(o, true);
  o += 4;
  if (nLeaf < 0) throw new Error(`bad sprp leaf count ${nLeaf}`);
  need(nLeaf * 2);
  const leaves = new Uint16Array(nLeaf);
  for (let i = 0; i < nLeaf; i++) leaves[i] = dv.getUint16(o + i * 2, true);
  o += nLeaf * 2;
  need(4);
  const nProps = dv.getInt32(o, true);
  o += 4;
  if (nProps < 0) throw new Error(`bad sprp prop count ${nProps}`);
  const props: StaticPropInstance[] = [];
  let recordSize = MIN_RECORD[version] ?? 56;
  if (nProps > 0) {
    const rest = data.length - o;
    const fromSize = Math.floor(rest / nProps);
    if (fromSize < 56) throw new Error(`sprp lump too small for ${nProps} props`);
    // trust the lump size when it is consistent (versions are reused with different layouts across games)
    if (rest % nProps === 0 || fromSize < recordSize) recordSize = fromSize;
    for (let i = 0; i < nProps; i++) {
      const p = o + i * recordSize;
      const propType = dv.getUint16(p + 24, true);
      // v11+ (CS:GO) end with a uniform scale
      const scale = version >= 11 && recordSize >= 76 ? dv.getFloat32(p + recordSize - 4, true) : 1;
      props.push({
        propType,
        model: dictionary[propType] ?? '',
        origin: { x: dv.getFloat32(p, true), y: dv.getFloat32(p + 4, true), z: dv.getFloat32(p + 8, true) },
        angles: { pitch: dv.getFloat32(p + 12, true), yaw: dv.getFloat32(p + 16, true), roll: dv.getFloat32(p + 20, true) },
        solid: dv.getUint8(p + 30),
        flags: dv.getUint8(p + 31),
        skin: dv.getInt32(p + 32, true),
        fadeMinDist: dv.getFloat32(p + 36, true),
        fadeMaxDist: dv.getFloat32(p + 40, true),
        lightingOrigin: { x: dv.getFloat32(p + 44, true), y: dv.getFloat32(p + 48, true), z: dv.getFloat32(p + 52, true) },
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      });
    }
  }
  return { version, dictionary, leaves, props, recordSize };
}

// ------------------------------------------------------------------------------------------ studio models

/** One decoded mesh of a studio model (LOD 0), in model space. */
export interface StudioMesh {
  /** Material index (skin reference) of the mesh. */
  materialRef: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface StudioModel {
  name: string;
  version: number;
  /** Texture (material) names, without directory. */
  textures: string[];
  /** $cdmaterials directories. */
  cdMaterials: string[];
  /** skinFamilies[family][materialRef] = texture index. */
  skinFamilies: number[][];
  meshes: StudioMesh[];
}

function cstr(d: Uint8Array, o: number, max = 256): string {
  let s = '';
  for (let i = 0; i < max && o + i < d.length; i++) {
    const c = d[o + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const MSTUDIOVERTEX_SIZE = 48;
const BODYPART_SIZE = 16;
const MODEL_SIZE = 148;
const MESH_SIZE = 116;
const TEXTURE_SIZE = 64;

/** LOD 0 vertices of a .vvd (fixups applied): position, normal, uv arrays. */
function readVvd(vvd: Uint8Array): { pos: Float32Array; nrm: Float32Array; uv: Float32Array; count: number } {
  const dv = new DataView(vvd.buffer, vvd.byteOffset, vvd.byteLength);
  if (vvd.length < 64 || cstr(vvd, 0, 4) !== 'IDSV') throw new Error('not a VVD file');
  const numLODs = dv.getInt32(12, true);
  const lod0Count = dv.getInt32(16, true);
  const numFixups = dv.getInt32(48, true);
  const fixupStart = dv.getInt32(52, true);
  const dataStart = dv.getInt32(56, true);
  if (numLODs < 1 || lod0Count < 0 || dataStart < 64 || dataStart > vvd.length) throw new Error('bad VVD header');
  // vertex id list for LOD 0
  let ids: Int32Array;
  if (numFixups > 0) {
    if (fixupStart < 0 || fixupStart + numFixups * 12 > vvd.length) throw new Error('bad VVD fixup table');
    const list: number[] = [];
    for (let i = 0; i < numFixups; i++) {
      const o = fixupStart + i * 12;
      const lod = dv.getInt32(o, true);
      const src = dv.getInt32(o + 4, true);
      const n = dv.getInt32(o + 8, true);
      if (lod < 0) continue; // fixups for LOD >= 0 apply to LOD 0
      for (let k = 0; k < n; k++) list.push(src + k);
    }
    ids = Int32Array.from(list);
  } else {
    ids = new Int32Array(lod0Count);
    for (let i = 0; i < lod0Count; i++) ids[i] = i;
  }
  const count = ids.length;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const o = dataStart + ids[i] * MSTUDIOVERTEX_SIZE;
    if (ids[i] < 0 || o + MSTUDIOVERTEX_SIZE > vvd.length) throw new Error('VVD vertex out of range');
    pos[i * 3] = dv.getFloat32(o + 16, true);
    pos[i * 3 + 1] = dv.getFloat32(o + 20, true);
    pos[i * 3 + 2] = dv.getFloat32(o + 24, true);
    nrm[i * 3] = dv.getFloat32(o + 28, true);
    nrm[i * 3 + 1] = dv.getFloat32(o + 32, true);
    nrm[i * 3 + 2] = dv.getFloat32(o + 36, true);
    uv[i * 2] = dv.getFloat32(o + 40, true);
    uv[i * 2 + 1] = dv.getFloat32(o + 44, true);
  }
  return { pos, nrm, uv, count };
}

interface VtxLayout {
  stripGroupSize: number;
  stripSize: number;
}

const VTX_LAYOUTS: VtxLayout[] = [
  { stripGroupSize: 25, stripSize: 27 }, // up to MDL v48 (CS:S, HL2, TF2)
  { stripGroupSize: 33, stripSize: 35 }, // MDL v49+ (CS:GO): + topology index fields
];

/**
 * Triangles (as model-relative vertex indices, i.e. mesh vertex offset + origMeshVertID) of every LOD 0 mesh of
 * body part `bp`, model 0, read from a .vtx with the given struct layout. Returns per-mesh index lists.
 */
function readVtxMeshes(vtx: Uint8Array, layout: VtxLayout, bodyParts: number, meshesPerPart: number[][]): number[][][] {
  const dv = new DataView(vtx.buffer, vtx.byteOffset, vtx.byteLength);
  const len = vtx.length;
  const i32 = (o: number): number => {
    if (o < 0 || o + 4 > len) throw new Error('VTX read out of range');
    return dv.getInt32(o, true);
  };
  if (len < 36 || i32(0) !== 7) throw new Error('unsupported VTX version');
  const numBodyParts = i32(28);
  const bodyPartOffset = i32(32);
  if (numBodyParts !== bodyParts) throw new Error('VTX/MDL body part count mismatch');
  const out: number[][][] = [];
  for (let b = 0; b < numBodyParts; b++) {
    const bpo = bodyPartOffset + b * 8;
    const numModels = i32(bpo);
    const modelOffset = bpo + i32(bpo + 4);
    const partMeshes: number[][] = [];
    if (numModels > 0) {
      const mo = modelOffset; // model 0
      const numLODs = i32(mo);
      if (numLODs < 1) throw new Error('VTX model without LODs');
      const lodo = mo + i32(mo + 4); // LOD 0
      const numMeshes = i32(lodo);
      const meshOffset = lodo + i32(lodo + 4);
      const mdlMeshes = meshesPerPart[b] ?? [];
      if (numMeshes !== mdlMeshes.length) throw new Error('VTX/MDL mesh count mismatch');
      for (let m = 0; m < numMeshes; m++) {
        const meo = meshOffset + m * 9;
        const numGroups = i32(meo);
        const groupOffset = meo + i32(meo + 4);
        const tris: number[] = [];
        const meshVertBase = mdlMeshes[m];
        for (let g = 0; g < numGroups; g++) {
          const sgo = groupOffset + g * layout.stripGroupSize;
          const numVerts = i32(sgo);
          const vertOffset = sgo + i32(sgo + 4);
          const numIndices = i32(sgo + 8);
          const indexOffset = sgo + i32(sgo + 12);
          const numStrips = i32(sgo + 16);
          const stripOffset = sgo + i32(sgo + 20);
          if (numVerts < 0 || numIndices < 0 || numStrips < 0) throw new Error('bad VTX strip group');
          if (vertOffset + numVerts * 9 > len || indexOffset + numIndices * 2 > len) throw new Error('VTX strip group out of range');
          const vert = (gi: number): number => {
            if (gi < 0 || gi >= numVerts) throw new Error('VTX index out of range');
            return meshVertBase + dv.getUint16(vertOffset + gi * 9 + 4, true);
          };
          const index = (k: number): number => {
            if (k < 0 || k >= numIndices) throw new Error('VTX strip index out of range');
            return dv.getUint16(indexOffset + k * 2, true);
          };
          for (let s = 0; s < numStrips; s++) {
            const so = stripOffset + s * layout.stripSize;
            if (so + layout.stripSize > len) throw new Error('VTX strip out of range');
            const sNumIndices = i32(so);
            const sIndexOffset = i32(so + 4);
            const sFlags = dv.getUint8(so + 18);
            if (sFlags & 2) {
              // triangle strip
              for (let k = 0; k + 2 < sNumIndices; k++) {
                const a = vert(index(sIndexOffset + k));
                const bb = vert(index(sIndexOffset + k + 1));
                const c = vert(index(sIndexOffset + k + 2));
                if (a === bb || bb === c || a === c) continue;
                if (k & 1) tris.push(bb, a, c);
                else tris.push(a, bb, c);
              }
            } else {
              for (let k = 0; k + 2 < sNumIndices; k += 3) {
                tris.push(vert(index(sIndexOffset + k)), vert(index(sIndexOffset + k + 1)), vert(index(sIndexOffset + k + 2)));
              }
            }
          }
        }
        partMeshes.push(tris);
      }
    }
    out.push(partMeshes);
  }
  return out;
}

/**
 * Decodes LOD 0 of a studio model (body part model 0 of each body part) from its .mdl, .vvd and .vtx bytes.
 * Triangles are wound counter-clockwise around the vertex normals (front faces for three.js).
 */
export function decodeStudioModel(name: string, mdl: Uint8Array, vvd: Uint8Array, vtx: Uint8Array): StudioModel {
  const dv = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength);
  const len = mdl.length;
  const i32 = (o: number): number => {
    if (o < 0 || o + 4 > len) throw new Error('MDL read out of range');
    return dv.getInt32(o, true);
  };
  if (len < 240 || cstr(mdl, 0, 4) !== 'IDST') throw new Error('not an MDL file');
  const version = i32(4);
  if (version < 44 || version > 53) throw new Error(`unsupported MDL version ${version}`);

  // textures, $cdmaterials, skin families
  const numTextures = i32(204);
  const textureIndex = i32(208);
  const textures: string[] = [];
  for (let i = 0; i < numTextures && i < 1024; i++) {
    const to = textureIndex + i * TEXTURE_SIZE;
    textures.push(cstr(mdl, to + i32(to)));
  }
  const numCd = i32(212);
  const cdIndex = i32(216);
  const cdMaterials: string[] = [];
  for (let i = 0; i < numCd && i < 64; i++) cdMaterials.push(cstr(mdl, i32(cdIndex + i * 4)));
  const numSkinRef = i32(220);
  const numSkinFamilies = i32(224);
  const skinIndex = i32(228);
  const skinFamilies: number[][] = [];
  for (let f = 0; f < numSkinFamilies && f < 256; f++) {
    const fam: number[] = [];
    for (let r = 0; r < numSkinRef && r < 1024; r++) {
      const o = skinIndex + (f * numSkinRef + r) * 2;
      fam.push(o >= 0 && o + 2 <= len ? dv.getInt16(o, true) : r);
    }
    skinFamilies.push(fam);
  }

  // body parts -> model 0 -> meshes (material, vertex base)
  const numBodyParts = i32(232);
  const bodyPartIndex = i32(236);
  if (numBodyParts < 0 || numBodyParts > 256) throw new Error('bad MDL body part count');
  const meshBases: number[][] = [];
  const meshMaterials: number[][] = [];
  for (let b = 0; b < numBodyParts; b++) {
    const bpo = bodyPartIndex + b * BODYPART_SIZE;
    const numModels = i32(bpo + 4);
    const modelIndex = bpo + i32(bpo + 12);
    const bases: number[] = [];
    const mats: number[] = [];
    if (numModels > 0) {
      const mo = modelIndex; // model 0
      const numMeshes = i32(mo + 72);
      const meshIndex = mo + i32(mo + 76);
      const vertexIndex = i32(mo + 84);
      const modelBase = Math.floor(vertexIndex / MSTUDIOVERTEX_SIZE);
      if (numMeshes < 0 || numMeshes > 4096) throw new Error('bad MDL mesh count');
      for (let m = 0; m < numMeshes; m++) {
        const meo = meshIndex + m * MESH_SIZE;
        mats.push(i32(meo));
        bases.push(modelBase + i32(meo + 12));
      }
    }
    meshBases.push(bases);
    meshMaterials.push(mats);
  }

  const verts = readVvd(vvd);
  let parts: number[][][] | null = null;
  let lastErr: unknown = null;
  const order = version >= 49 ? [VTX_LAYOUTS[1], VTX_LAYOUTS[0]] : [VTX_LAYOUTS[0], VTX_LAYOUTS[1]];
  for (const layout of order) {
    try {
      parts = readVtxMeshes(vtx, layout, numBodyParts, meshBases);
      // every referenced vertex must exist
      for (const p of parts) for (const t of p) for (const v of t) if (v < 0 || v >= verts.count) throw new Error('vertex out of range');
      break;
    } catch (e) {
      parts = null;
      lastErr = e;
    }
  }
  if (!parts) throw lastErr instanceof Error ? lastErr : new Error('unreadable VTX');

  const meshes: StudioMesh[] = [];
  for (let b = 0; b < parts.length; b++) {
    for (let m = 0; m < parts[b].length; m++) {
      const tris = parts[b][m];
      if (!tris.length) continue;
      // compact the vertices this mesh uses
      const remap = new Map<number, number>();
      const used: number[] = [];
      const indices = new Uint32Array(tris.length);
      for (let k = 0; k < tris.length; k++) {
        const v = tris[k];
        let r = remap.get(v);
        if (r === undefined) {
          r = used.length;
          remap.set(v, r);
          used.push(v);
        }
        indices[k] = r;
      }
      const positions = new Float32Array(used.length * 3);
      const normals = new Float32Array(used.length * 3);
      const uvs = new Float32Array(used.length * 2);
      for (let i = 0; i < used.length; i++) {
        const v = used[i];
        positions.set(verts.pos.subarray(v * 3, v * 3 + 3), i * 3);
        normals.set(verts.nrm.subarray(v * 3, v * 3 + 3), i * 3);
        uvs[i * 2] = verts.uv[v * 2];
        uvs[i * 2 + 1] = verts.uv[v * 2 + 1];
      }
      orientTriangles(positions, normals, indices);
      meshes.push({ materialRef: meshMaterials[b][m], positions, normals, uvs, indices });
    }
  }
  return { name, version, textures, cdMaterials, skinFamilies, meshes };
}

/**
 * Makes the triangles counter-clockwise around the vertex normals: Source models are wound the other way
 * (Direct3D's clockwise front faces), but rather than assume it, the majority vote of geometric vs vertex
 * normals decides whether to flip the whole mesh.
 */
function orientTriangles(P: Float32Array, N: Float32Array, I: Uint32Array): void {
  let agree = 0;
  let disagree = 0;
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3;
    const b = I[k + 1] * 3;
    const c = I[k + 2] * 3;
    const e1x = P[b] - P[a];
    const e1y = P[b + 1] - P[a + 1];
    const e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a];
    const e2y = P[c + 1] - P[a + 1];
    const e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const d = nx * (N[a] + N[b] + N[c]) + ny * (N[a + 1] + N[b + 1] + N[c + 1]) + nz * (N[a + 2] + N[b + 2] + N[c + 2]);
    if (d > 0) agree++;
    else if (d < 0) disagree++;
  }
  if (disagree > agree) {
    for (let k = 0; k < I.length; k += 3) {
      const t = I[k + 1];
      I[k + 1] = I[k + 2];
      I[k + 2] = t;
    }
  }
}

// ------------------------------------------------------------------------------------------ assembly

export interface StaticPropOptions {
  /** Material settings for prop materials (extra file sources, DXT passthrough...). */
  materials?: BuildMaterialsOptions;
  /**
   * Largest texture size for prop materials. Default 512 (1024 with compressedTextures): maps like
   * surf_summer_ksf pack ~900 prop textures, which would take ~420 MB as full-size RGBA.
   */
  maxTextureSize?: number;
  /** Use this material loader (shared caches) instead of creating one. */
  loader?: MaterialLoader;
  warnings?: string[];
}

function readFirst(sources: MaterialFileSource[], paths: string[]): Uint8Array | null {
  for (const p of paths) {
    for (const s of sources) {
      try {
        const d = s.read(p);
        if (d && d.length) return d;
      } catch {
        // try the next source
      }
    }
  }
  return null;
}

/**
 * RenderProps for the map's static props whose models are available (packed in the map or in
 * `extraSources`). Prop materials are added to `materials` (keyed by normalized name). Never throws for a
 * broken model; returns [] without a 'sprp' lump.
 */
export function buildStaticProps(
  bsp: BspFile,
  pak: PakFile | null,
  materials: Map<string, MaterialDef>,
  opts: StaticPropOptions = {},
): RenderProp[] {
  const lump = bsp.gameLumps.find((g) => g.id === 'sprp');
  if (!lump || lump.data.length < 12) return [];
  let parsed: StaticPropLump;
  try {
    parsed = parseStaticPropLump(lump.data, lump.version);
  } catch (e) {
    opts.warnings?.push(`static props: ${(e as Error).message}`);
    return [];
  }
  if (!parsed.props.length) return [];
  const extra = opts.materials?.extraSources;
  const sources: MaterialFileSource[] = [];
  if (pak) sources.push(pak);
  if (extra) sources.push(...extra);
  if (!sources.length) return [];

  let loader: MaterialLoader | null = opts.loader ?? null;
  const getLoader = (): MaterialLoader => {
    if (!loader) {
      const compressed = !!opts.materials?.compressedTextures;
      loader = new MaterialLoader(pak, {
        ...opts.materials,
        maxTextureSize: opts.maxTextureSize ?? Math.min(compressed ? 1024 : 512, opts.materials?.maxTextureSize ?? 2048),
      });
    }
    return loader;
  };

  const models = new Map<string, StudioModel | null>();
  let missing = 0;
  let broken = 0;
  const brokenNames: string[] = [];
  const loadModel = (path: string): StudioModel | null => {
    const key = normalizePakPath(path);
    if (models.has(key)) return models.get(key)!;
    let model: StudioModel | null = null;
    const base = key.replace(/\.mdl$/, '');
    const mdl = readFirst(sources, [key]);
    const vvd = mdl ? readFirst(sources, [`${base}.vvd`]) : null;
    const vtx = mdl ? readFirst(sources, [`${base}.dx90.vtx`, `${base}.dx80.vtx`, `${base}.sw.vtx`, `${base}.vtx`]) : null;
    if (mdl && vvd && vtx) {
      try {
        model = decodeStudioModel(key, mdl, vvd, vtx);
      } catch (e) {
        broken++;
        if (brokenNames.length < 5) brokenNames.push(`${key} (${(e as Error).message})`);
      }
    } else missing++;
    models.set(key, model);
    return model;
  };

  // per (model, skin, mesh): shared geometry + resolved material name
  const shared = new Map<string, { material: string; mesh: StudioMesh }[]>();
  const meshesFor = (model: StudioModel, skin: number): { material: string; mesh: StudioMesh }[] => {
    const fam = model.skinFamilies.length ? model.skinFamilies[Math.max(0, Math.min(skin, model.skinFamilies.length - 1))] : null;
    const key = `${model.name}|${fam ? Math.max(0, Math.min(skin, model.skinFamilies.length - 1)) : 0}`;
    const hit = shared.get(key);
    if (hit) return hit;
    const list: { material: string; mesh: StudioMesh }[] = [];
    for (const mesh of model.meshes) {
      const texIndex = fam && mesh.materialRef >= 0 && mesh.materialRef < fam.length ? fam[mesh.materialRef] : mesh.materialRef;
      const tex = model.textures[texIndex] ?? model.textures[mesh.materialRef] ?? '';
      let matName = '';
      try {
        const def = getLoader().loadModelMaterial(tex.replace(/\\/g, '/'), model.cdMaterials);
        matName = def.name;
        if (!materials.has(matName)) materials.set(matName, def);
      } catch {
        matName = normalizeMaterialName(tex) || 'models/missing';
      }
      list.push({ material: matName, mesh });
    }
    shared.set(key, list);
    return list;
  };

  // uniformly scaled copies (v11 props), shared per (mesh, scale)
  const scaled = new Map<StudioMesh, Map<number, Float32Array>>();
  const scaledPositions = (mesh: StudioMesh, scale: number): Float32Array => {
    let byScale = scaled.get(mesh);
    if (!byScale) scaled.set(mesh, (byScale = new Map()));
    let arr = byScale.get(scale);
    if (!arr) {
      arr = new Float32Array(mesh.positions.length);
      for (let i = 0; i < arr.length; i++) arr[i] = mesh.positions[i] * scale;
      byScale.set(scale, arr);
    }
    return arr;
  };

  const out: RenderProp[] = [];
  for (const p of parsed.props) {
    if (!p.model) continue;
    let model: StudioModel | null = null;
    try {
      model = loadModel(p.model);
    } catch {
      model = null;
    }
    if (!model) continue;
    let list: { material: string; mesh: StudioMesh }[];
    try {
      list = meshesFor(model, p.skin);
    } catch {
      continue;
    }
    for (const { material, mesh } of list) {
      if (!materials.has(material)) continue;
      out.push({
        model: model.name,
        origin: { x: p.origin.x, y: p.origin.y, z: p.origin.z },
        angles: { pitch: p.angles.pitch, yaw: p.angles.yaw, roll: p.angles.roll },
        positions: p.scale === 1 ? mesh.positions : scaledPositions(mesh, p.scale),
        normals: mesh.normals,
        uvs: mesh.uvs,
        indices: mesh.indices,
        material,
      });
    }
  }
  if (opts.warnings) {
    if (missing) opts.warnings.push(`${missing} static prop models are not packed in the map (not drawn)`);
    if (broken) opts.warnings.push(`${broken} static prop models could not be decoded: ${brokenNames.join(', ')}`);
  }
  return out;
}
