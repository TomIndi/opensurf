// Props: static props (the 'sprp' game lump) and entity-placed models (prop_dynamic, prop_physics...), decoded
// from the studio models (.mdl / .vvd / .vtx) the map packs, plus their lighting from vrad's leaf ambient cubes.
//
// sprp layout (public format documentation): int dictCount, dictCount x char[128] model names; int leafCount,
// leafCount x u16 leaves; int propCount, propCount x StaticPropLump_t. Every version starts with the same
// 56-byte v4 core (origin, angles, propType, firstLeaf, leafCount, solid, flags, skin, fade distances, lighting
// origin); later versions append fields (v5 forced fade scale, v6 DX levels, v7-v9 CPU/GPU levels + diffuse
// modulation colour, v10 flags (TF2/CS:S, 72 bytes) or CS:GO's 76-byte layout, v11 uniform scale). The record
// size is taken from the lump size.
//
// Models: only models whose .mdl, .vvd and .vtx (dx90, dx80 or sw) are all available are decoded - stock
// models live in the game's VPKs. LOD 0 triangles of the selected body group model of every body part are read
// from the VTX strip groups (indices -> VTX vertices -> origMeshVertID + mesh/model vertex offsets -> VVD
// vertices after the VVD LOD fixups). One RenderProp is produced per prop instance and material; instances of the
// same model/body/skin share their vertex arrays. Nothing here may break map loading: every model is decoded under
// try/catch.
//
// Lighting: props have no lightmaps; the engine lights models from its light cache: the ambient light cube vrad
// stored per leaf (LUMP_LEAF_AMBIENT_LIGHTING + index, or the cube embedded in version-0 leaves) plus the direct
// light of the compiled world lights. RenderProp.ambientCube carries that cube at the prop's lighting origin.
import type { QAngle } from '../core/angles';
import { Vec3 } from '../core/vec3';
import type { MapEntity, MaterialDef, RenderProp } from '../map/types';
import { pointLeaf } from './bsptree';
import { decodeRgbExp32 } from './lightmap';
import { BuildMaterialsOptions, MaterialFileSource, MaterialLoader, normalizeMaterialName } from './materials';
import { PakFile, normalizePakPath } from './pakfile';
import { CONTENTS_SOLID, TraceResult, newTrace } from '../physics/types';
import {
  BspFile,
  LUMP_LEAFS,
  LUMP_LEAF_AMBIENT_INDEX,
  LUMP_LEAF_AMBIENT_INDEX_HDR,
  LUMP_LEAF_AMBIENT_LIGHTING,
  LUMP_LEAF_AMBIENT_LIGHTING_HDR,
  LUMP_WORLDLIGHTS,
  LUMP_WORLDLIGHTS_HDR,
  SURF_SKY,
  SURF_SKY2D,
} from './types';

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
  /** Diffuse modulation RGBA 0..255 (v7-v9 and CS:GO layouts), null when the version has none. */
  diffuse: [number, number, number, number] | null;
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
    dictionary.push(cstr(data, o, 128));
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
    // diffuse modulation (color32 at 64): v7-v9, and the CS:GO layouts (v10 with 76+ bytes, v11+)
    const hasDiffuse = recordSize >= 68 && ((version >= 7 && version <= 9) || (version >= 10 && recordSize >= 76));
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
        diffuse: hasDiffuse ? [dv.getUint8(p + 64), dv.getUint8(p + 65), dv.getUint8(p + 66), dv.getUint8(p + 67)] : null,
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
  /**
   * Single-bone models: the root bone's pose at frame 0 of each sequence (by lower-case label; null = the bind
   * pose the vertices are stored in) and of sequence 0 (`defaultPose`, null when it is the bind pose). Animated entities
   * (prop_dynamic...) are drawn in that pose by the engine: e.g. models whose "idle" turns the root 90 degrees.
   */
  sequencePoses?: Map<string, RootPose | null>;
  defaultPose?: RootPose | null;
}

/** A rigid root-bone transform in model space: unit quaternion (x, y, z, w) and translation. */
export interface RootPose {
  q: [number, number, number, number];
  t: [number, number, number];
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
const BONE_SIZE = 216;
const ANIMDESC_SIZE = 100;
const SEQDESC_SIZE = 212;
// mstudioanim_t flags
const ANIM_RAWPOS = 0x01;
const ANIM_RAWROT = 0x02;
const ANIM_ANIMPOS = 0x04;
const ANIM_ANIMROT = 0x08;
const ANIM_DELTA = 0x10;
const ANIM_RAWROT2 = 0x20;
/** mstudioanimdesc_t flag: the newer frame-based animation encoding (not decoded: bind pose). */
const ANIMDESC_FRAMEANIM = 0x40;
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
 * Triangles (as model-relative vertex indices, i.e. mesh vertex base + origMeshVertID) of every LOD 0 mesh of
 * the chosen model of each body part, read from a .vtx with the given struct layout. out[part][mesh] = indices.
 */
function readVtxMeshes(vtx: Uint8Array, layout: VtxLayout, partModels: number[], meshesPerPart: number[][]): number[][][] {
  const dv = new DataView(vtx.buffer, vtx.byteOffset, vtx.byteLength);
  const len = vtx.length;
  const i32 = (o: number): number => {
    if (o < 0 || o + 4 > len) throw new Error('VTX read out of range');
    return dv.getInt32(o, true);
  };
  if (len < 36 || i32(0) !== 7) throw new Error('unsupported VTX version');
  const numBodyParts = i32(28);
  const bodyPartOffset = i32(32);
  if (numBodyParts !== partModels.length) throw new Error('VTX/MDL body part count mismatch');
  const out: number[][][] = [];
  for (let b = 0; b < numBodyParts; b++) {
    const bpo = bodyPartOffset + b * 8;
    const numModels = i32(bpo);
    const partMeshes: number[][] = [];
    const mi = partModels[b];
    if (mi >= 0 && mi < numModels) {
      const mo = bpo + i32(bpo + 4) + mi * 8;
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
          if (vertOffset < 0 || indexOffset < 0 || vertOffset + numVerts * 9 > len || indexOffset + numIndices * 2 > len) {
            throw new Error('VTX strip group out of range');
          }
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
            if (so < 0 || so + layout.stripSize > len) throw new Error('VTX strip out of range');
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
 * Decodes LOD 0 of a studio model from its .mdl, .vvd and .vtx bytes: for every body part, the model selected
 * by `body` (Source's body group value: part model = floor(body / part.base) % part.numModels; 0 = defaults).
 * Triangles are wound counter-clockwise around the vertex normals (front faces for three.js).
 */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/** Quaternion from Source RadianEuler angles (x = roll, y = pitch, z = yaw, radians). */
export function eulerToQuat(x: number, y: number, z: number): [number, number, number, number] {
  const sr = Math.sin(x * 0.5);
  const cr = Math.cos(x * 0.5);
  const sp = Math.sin(y * 0.5);
  const cp = Math.cos(y * 0.5);
  const sy = Math.sin(z * 0.5);
  const cy = Math.cos(z * 0.5);
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}

/**
 * Frame-0 root-bone poses of the sequences of a single-bone model (see StudioModel.sequencePoses), from the
 * public MDL layout: bone 0's bind pose and scales (mstudiobone_t), each sequence's first animation
 * (mstudioseqdesc_t -> anim index table -> mstudioanimdesc_t) and that animation's entry for bone 0
 * (mstudioanim_t: raw Quaternion48/64 and Vector48 values, or run-length encoded values scaled by the bone's
 * rotscale/posscale). Animations in external blocks (.ani) or the frame-based encoding keep the bind pose.
 */
function readSequencePoses(mdl: Uint8Array, dv: DataView): { byLabel: Map<string, RootPose>; first: RootPose | null } | null {
  const len = mdl.length;
  const ok = (o: number, n: number) => o >= 0 && o + n <= len;
  const i32 = (o: number): number => (ok(o, 4) ? dv.getInt32(o, true) : 0);
  const f32 = (o: number): number => (ok(o, 4) ? dv.getFloat32(o, true) : 0);
  const i16 = (o: number): number => (ok(o, 2) ? dv.getInt16(o, true) : 0);
  const u16 = (o: number): number => (ok(o, 2) ? dv.getUint16(o, true) : 0);
  if (i32(156) !== 1) return null; // single-bone models only (skinned rigs would need full posing)
  const b = i32(160);
  if (!ok(b, BONE_SIZE)) return null;
  const bindPos: [number, number, number] = [f32(b + 32), f32(b + 36), f32(b + 40)];
  const bindQuat: [number, number, number, number] = [f32(b + 44), f32(b + 48), f32(b + 52), f32(b + 56)];
  const bindRot = [f32(b + 60), f32(b + 64), f32(b + 68)];
  const posScale = [f32(b + 72), f32(b + 76), f32(b + 80)];
  const rotScale = [f32(b + 84), f32(b + 88), f32(b + 92)];
  const numAnims = i32(180);
  const animIndex = i32(184);
  const numSeq = i32(188);
  const seqIndex = i32(192);
  if (numSeq <= 0 || numSeq > 4096 || numAnims <= 0 || numAnims > 4096) return null;
  // first value of a run-length encoded mstudioanimvalue_t stream
  const rle0 = (at: number): number => (ok(at, 4) && mdl[at] > 0 ? i16(at + 2) : 0);
  const frame0 = (a: number): RootPose | null => {
    if (a < 0 || a >= numAnims) return null;
    const ao = animIndex + a * ANIMDESC_SIZE;
    if (!ok(ao, ANIMDESC_SIZE)) return null;
    if (i32(ao + 12) & ANIMDESC_FRAMEANIM) return null;
    let block = i32(ao + 52);
    let index = i32(ao + 56);
    const sectionIndex = i32(ao + 80);
    if (i32(ao + 84) > 0 && sectionIndex > 0) {
      block = i32(ao + sectionIndex);
      index = i32(ao + sectionIndex + 4);
    }
    if (block !== 0 || index <= 0) return null;
    let p = ao + index;
    for (let guard = 0; guard < 512 && ok(p, 4); guard++) {
      const bone = mdl[p];
      const fl = mdl[p + 1];
      const next = i16(p + 2);
      if (bone === 0) {
        const delta = (fl & ANIM_DELTA) !== 0;
        const d = p + 4;
        let q: [number, number, number, number] = delta ? [0, 0, 0, 1] : [bindQuat[0], bindQuat[1], bindQuat[2], bindQuat[3]];
        let t: [number, number, number] = delta ? [0, 0, 0] : [bindPos[0], bindPos[1], bindPos[2]];
        if (fl & ANIM_RAWROT2) {
          if (!ok(d, 8)) return null;
          const lo = dv.getUint32(d, true);
          const hi = dv.getUint32(d + 4, true);
          const xb = lo & 0x1fffff;
          const yb = ((lo >>> 21) | ((hi & 0x3ff) << 11)) >>> 0;
          const zb = (hi >>> 10) & 0x1fffff;
          const wneg = hi >>> 31;
          const x = (xb - 1048576) * (1 / 1048576.5);
          const y = (yb - 1048576) * (1 / 1048576.5);
          const z = (zb - 1048576) * (1 / 1048576.5);
          const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)) * (wneg ? -1 : 1);
          q = [x, y, z, w];
        } else if (fl & ANIM_RAWROT) {
          const x = (u16(d) - 32768) * (1 / 32768);
          const y = (u16(d + 2) - 32768) * (1 / 32768);
          const zw = u16(d + 4);
          const z = ((zw & 0x7fff) - 16384) * (1 / 16384);
          const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)) * (zw & 0x8000 ? -1 : 1);
          q = [x, y, z, w];
        } else if (fl & ANIM_ANIMROT) {
          const e = [0, 0, 0];
          for (let k = 0; k < 3; k++) {
            const off = i16(d + k * 2);
            e[k] = (delta ? 0 : bindRot[k]) + (off ? rle0(d + off) : 0) * rotScale[k];
          }
          q = eulerToQuat(e[0], e[1], e[2]);
        }
        if (fl & ANIM_RAWPOS) {
          const v = d + (fl & ANIM_RAWROT ? 6 : 0) + (fl & ANIM_RAWROT2 ? 8 : 0);
          t = [halfToFloat(u16(v)), halfToFloat(u16(v + 2)), halfToFloat(u16(v + 4))];
        } else if (fl & ANIM_ANIMPOS) {
          const v = d + (fl & ANIM_ANIMROT ? 6 : 0);
          for (let k = 0; k < 3; k++) {
            const off = i16(v + k * 2);
            t[k] = (delta ? 0 : bindPos[k]) + (off ? rle0(v + off) : 0) * posScale[k];
          }
        }
        const ql = Math.hypot(q[0], q[1], q[2], q[3]);
        if (!(ql > 1e-6) || !t.every(Number.isFinite)) return null;
        return { q: [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql], t };
      }
      if (!next) break;
      p += next;
    }
    // bone 0 not animated: bind pose
    return { q: [bindQuat[0], bindQuat[1], bindQuat[2], bindQuat[3]], t: [bindPos[0], bindPos[1], bindPos[2]] };
  };
  const byLabel = new Map<string, RootPose>();
  let first: RootPose | null = null;
  for (let sq = 0; sq < numSeq && sq < 512; sq++) {
    const so = seqIndex + sq * SEQDESC_SIZE;
    if (!ok(so, SEQDESC_SIZE)) break;
    const pose = frame0(i16(so + i32(so + 60)));
    if (sq === 0) first = pose;
    const label = cstr(mdl, so + i32(so + 4)).toLowerCase();
    if (pose && label && !byLabel.has(label)) byLabel.set(label, pose);
  }
  return { byLabel, first };
}

/** The studiohdr_t fields collision needs (see readStudioHeader). */
export interface StudioHeader {
  version: number;
  checksum: number;
  /** Hull box (the engine's model bounds), model space. */
  hullMin: Vec3;
  hullMax: Vec3;
  /** Clipping (view) box, model space; often zero. */
  viewMin: Vec3;
  viewMax: Vec3;
  flags: number;
  numBones: number;
  /** $contents (CONTENTS_SOLID by default). */
  contents: number;
}

/** Header fields of an .mdl (public studiohdr_t layout), or null when it isn't a studio model. */
export function readStudioHeader(mdl: Uint8Array): StudioHeader | null {
  if (mdl.length < 336 || cstr(mdl, 0, 4) !== 'IDST') return null;
  const dv = new DataView(mdl.buffer, mdl.byteOffset, mdl.byteLength);
  const vec = (o: number): Vec3 => ({ x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true) });
  const finite = (v: Vec3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  const h: StudioHeader = {
    version: dv.getInt32(4, true),
    checksum: dv.getInt32(8, true),
    hullMin: vec(104),
    hullMax: vec(116),
    viewMin: vec(128),
    viewMax: vec(140),
    flags: dv.getInt32(152, true),
    numBones: dv.getInt32(156, true),
    contents: dv.getInt32(332, true),
  };
  if (!finite(h.hullMin) || !finite(h.hullMax)) h.hullMin = h.hullMax = { x: 0, y: 0, z: 0 };
  if (!finite(h.viewMin) || !finite(h.viewMax)) h.viewMin = h.viewMax = { x: 0, y: 0, z: 0 };
  return h;
}

/** True when a pose is the identity (within float noise). */
function isIdentityPose(p: RootPose): boolean {
  const [x, y, z, w] = p.q;
  return Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4 && Math.abs(z) < 1e-4 && Math.abs(Math.abs(w) - 1) < 1e-4 && Math.hypot(p.t[0], p.t[1], p.t[2]) < 1e-3;
}

/**
 * The placement of a model drawn in `pose`: the entity transform (origin, Source angles, uniform scale) composed
 * with the root pose, as an origin + angles pair (Source MatrixAngles decomposition of R(angles) * R(pose)).
 */
export function composePose(origin: Vec3, angles: QAngle, scale: number, pose: RootPose): { origin: Vec3; angles: QAngle } {
  const d = Math.PI / 180;
  const sy = Math.sin(angles.yaw * d), cy = Math.cos(angles.yaw * d);
  const sp = Math.sin(angles.pitch * d), cp = Math.cos(angles.pitch * d);
  const sr = Math.sin(angles.roll * d), cr = Math.cos(angles.roll * d);
  // entity basis: columns forward, left, up (model x, y, z)
  const F = [cp * cy, cp * sy, -sp];
  const L = [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp];
  const U = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  const [x, y, z, w] = pose.q;
  // pose rotation matrix columns
  const c0 = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  const c1 = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  const c2 = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  const mul = (c: number[]) => [F[0] * c[0] + L[0] * c[1] + U[0] * c[2], F[1] * c[0] + L[1] * c[1] + U[1] * c[2], F[2] * c[0] + L[2] * c[1] + U[2] * c[2]];
  const f = mul(c0);
  const l = mul(c1);
  const u = mul(c2);
  const xy = Math.hypot(f[0], f[1]);
  let pitch: number;
  let yaw: number;
  let roll: number;
  if (xy > 0.001) {
    yaw = Math.atan2(f[1], f[0]);
    pitch = Math.atan2(-f[2], xy);
    roll = Math.atan2(l[2], u[2]);
  } else {
    yaw = Math.atan2(-l[0], l[1]);
    pitch = Math.atan2(-f[2], xy);
    roll = 0;
  }
  const t = mul(pose.t);
  return {
    origin: { x: origin.x + t[0] * scale, y: origin.y + t[1] * scale, z: origin.z + t[2] * scale },
    angles: { pitch: pitch / d, yaw: yaw / d, roll: roll / d },
  };
}

export function decodeStudioModel(name: string, mdl: Uint8Array, vvd: Uint8Array, vtx: Uint8Array, body = 0): StudioModel {
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

  // body parts -> selected model -> meshes (material, vertex base)
  const numBodyParts = i32(232);
  const bodyPartIndex = i32(236);
  if (numBodyParts < 0 || numBodyParts > 256) throw new Error('bad MDL body part count');
  const meshBases: number[][] = [];
  const meshMaterials: number[][] = [];
  const partModels: number[] = [];
  for (let b = 0; b < numBodyParts; b++) {
    const bpo = bodyPartIndex + b * BODYPART_SIZE;
    const numModels = i32(bpo + 4);
    const base = i32(bpo + 8);
    const modelIndex = bpo + i32(bpo + 12);
    const bases: number[] = [];
    const mats: number[] = [];
    const mi = numModels > 0 ? (base > 0 ? Math.floor(Math.max(0, body) / base) % numModels : 0) : -1;
    partModels.push(mi);
    if (mi >= 0) {
      const mo = modelIndex + mi * MODEL_SIZE;
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
      parts = readVtxMeshes(vtx, layout, partModels, meshBases);
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
        positions[i * 3] = verts.pos[v * 3];
        positions[i * 3 + 1] = verts.pos[v * 3 + 1];
        positions[i * 3 + 2] = verts.pos[v * 3 + 2];
        normals[i * 3] = verts.nrm[v * 3];
        normals[i * 3 + 1] = verts.nrm[v * 3 + 1];
        normals[i * 3 + 2] = verts.nrm[v * 3 + 2];
        uvs[i * 2] = verts.uv[v * 2];
        uvs[i * 2 + 1] = verts.uv[v * 2 + 1];
      }
      orientTriangles(positions, normals, indices);
      meshes.push({ materialRef: meshMaterials[b][m], positions, normals, uvs, indices });
    }
  }
  let sequencePoses: Map<string, RootPose | null> | undefined;
  let defaultPose: RootPose | null = null;
  try {
    const sp = readSequencePoses(mdl, dv);
    if (sp) {
      sequencePoses = new Map([...sp.byLabel].map(([k, p]) => [k, isIdentityPose(p) ? null : p]));
      defaultPose = sp.first && !isIdentityPose(sp.first) ? sp.first : null;
    }
  } catch {
    /* no animation data: the bind pose */
  }
  return { name, version, textures, cdMaterials, skinFamilies, meshes, sequencePoses, defaultPose };
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

// ------------------------------------------------------------------------------------------ lighting

const CUBE_BYTES = 24;
const AMBIENT_SAMPLE_BYTES = 28;

/** +x -x +y -y +z -z */
const CUBE_AXES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * The first point among `points` - then 16, 48 and 128 units away from them along the six axes - whose BSP
 * leaf is not solid, with that leaf. Props are often sunk into floors or embedded in walls and ceilings (light
 * fixtures, signs, supports), so their origin alone can be inside a brush.
 */
export function openPointNear(bsp: BspFile, points: Vec3[]): { point: Vec3; leaf: number } | null {
  for (const d of [0, 16, 48, 128]) {
    for (const p of points) {
      for (let k = 0; k < (d ? 6 : 1); k++) {
        const a = CUBE_AXES[k];
        const q = { x: p.x + a[0] * d, y: p.y + a[1] * d, z: p.z + a[2] * d };
        const leaf = pointLeaf(bsp, q);
        const l = leaf >= 0 ? bsp.leafs[leaf] : undefined;
        if (l && !(l.contents & 1)) return { point: q, leaf };
      }
    }
  }
  return null;
}

/**
 * vrad's per-leaf ambient light cubes (6 ColorRGBExp32 faces: +x -x +y -y +z -z), sampled at a point. Unlike
 * lightmaps (c * 2^e / 255), the cubes are stored for the engine's ColorRGBExp32ToVector, which has no /255:
 * c * 2^e is already linear light with 1 = fully lit.
 */
export class LeafAmbientLighting {
  private readonly index: Uint8Array | null = null;
  private readonly samples: Uint8Array | null = null;
  /** Version-0 leaves embed one cube each (leaf lump bytes, 56 per leaf, cube at +30). */
  private readonly leafCubes: Uint8Array | null = null;

  constructor(
    private readonly bsp: BspFile,
    hdr = false,
  ) {
    const lump = (i: number): Uint8Array => {
      try {
        return bsp.getLump(i);
      } catch {
        return new Uint8Array(0);
      }
    };
    const nLeafs = bsp.leafs.length;
    const usable = (idx: Uint8Array, smp: Uint8Array): boolean => {
      if (idx.length !== nLeafs * 4 || smp.length < AMBIENT_SAMPLE_BYTES) return false;
      for (let i = 0; i < Math.min(smp.length, 64 * AMBIENT_SAMPLE_BYTES); i++) if (smp[i]) return true;
      return false; // placeholder lump (all zeros)
    };
    let idx = lump(hdr ? LUMP_LEAF_AMBIENT_INDEX_HDR : LUMP_LEAF_AMBIENT_INDEX);
    let smp = lump(hdr ? LUMP_LEAF_AMBIENT_LIGHTING_HDR : LUMP_LEAF_AMBIENT_LIGHTING);
    if (!usable(idx, smp)) {
      // the other dynamic range is better than nothing
      idx = lump(hdr ? LUMP_LEAF_AMBIENT_INDEX : LUMP_LEAF_AMBIENT_INDEX_HDR);
      smp = lump(hdr ? LUMP_LEAF_AMBIENT_LIGHTING : LUMP_LEAF_AMBIENT_LIGHTING_HDR);
    }
    if (usable(idx, smp)) {
      this.index = idx;
      this.samples = smp;
    } else {
      const leafLump = lump(LUMP_LEAFS);
      if (nLeafs > 0 && leafLump.length === nLeafs * 56) this.leafCubes = leafLump;
    }
  }

  /** True when the map has ambient lighting data. */
  get available(): boolean {
    return !!(this.index || this.leafCubes);
  }

  /**
   * Ambient cube at `p` (linear RGB, 1 = fully lit), or null without data. Points in solid are moved to the
   * nearest open point (openPointNear); leaves without samples are retried a little higher.
   */
  sample(p: Vec3): [number, number, number][] | null {
    if (!this.available) return null;
    const open = openPointNear(this.bsp, [p]);
    if (!open) return null;
    const cube = this.leafCube(open.leaf, open.point);
    if (cube) return cube;
    // an open leaf without samples (vrad skips some): look a little higher
    for (const dz of [16, 48, 128]) {
      const q = { x: open.point.x, y: open.point.y, z: open.point.z + dz };
      const leaf = pointLeaf(this.bsp, q);
      const c = leaf >= 0 ? this.leafCube(leaf, q) : null;
      if (c) return c;
    }
    return null;
  }

  private leafCube(leaf: number, p: Vec3): [number, number, number][] | null {
    const l = this.bsp.leafs[leaf];
    if (!l || l.contents & 1) return null;
    const out: [number, number, number][] = [];
    const rgb = new Float32Array(3);
    if (this.leafCubes) {
      const base = leaf * 56 + 30;
      for (let f = 0; f < 6; f++) {
        decodeRgbExp32(this.leafCubes, base + f * 4, rgb, 0);
        out.push([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255]);
      }
      return out;
    }
    const idx = this.index!;
    const smp = this.samples!;
    const count = idx[leaf * 4] | (idx[leaf * 4 + 1] << 8);
    const first = idx[leaf * 4 + 2] | (idx[leaf * 4 + 3] << 8);
    if (!count) return null;
    const acc = new Float64Array(18);
    let wsum = 0;
    for (let i = 0; i < count; i++) {
      const o = (first + i) * AMBIENT_SAMPLE_BYTES;
      if (o + AMBIENT_SAMPLE_BYTES > smp.length) break;
      const sx = l.mins.x + ((l.maxs.x - l.mins.x) * smp[o + CUBE_BYTES]) / 255;
      const sy = l.mins.y + ((l.maxs.y - l.mins.y) * smp[o + CUBE_BYTES + 1]) / 255;
      const sz = l.mins.z + ((l.maxs.z - l.mins.z) * smp[o + CUBE_BYTES + 2]) / 255;
      const d2 = (sx - p.x) ** 2 + (sy - p.y) ** 2 + (sz - p.z) ** 2;
      const w = 1 / (d2 + 1);
      wsum += w;
      for (let f = 0; f < 6; f++) {
        decodeRgbExp32(smp, o + f * 4, rgb, 0);
        acc[f * 3] += rgb[0] * w;
        acc[f * 3 + 1] += rgb[1] * w;
        acc[f * 3 + 2] += rgb[2] * w;
      }
    }
    if (!(wsum > 0)) return null;
    for (let f = 0; f < 6; f++) out.push([(acc[f * 3] / wsum) * 255, (acc[f * 3 + 1] / wsum) * 255, (acc[f * 3 + 2] / wsum) * 255]);
    return out;
  }
}

/** emittype_t of dworldlight_t. */
export const EMIT_SURFACE = 0;
export const EMIT_POINT = 1;
export const EMIT_SPOTLIGHT = 2;
export const EMIT_SKYLIGHT = 3;
export const EMIT_QUAKELIGHT = 4;
export const EMIT_SKYAMBIENT = 5;

/** A compiled light (LUMP_WORLDLIGHTS[_HDR]); intensity is linear light in lightmap units (1 = fully lit). */
export interface WorldLight {
  type: number;
  origin: Vec3;
  intensity: Vec3;
  /** Spot/surface direction, or the direction sunlight travels for sky lights. */
  normal: Vec3;
  style: number;
  stopdot: number;
  stopdot2: number;
  exponent: number;
  radius: number;
  constantAttn: number;
  linearAttn: number;
  quadraticAttn: number;
}

/**
 * Parses a world light lump: 88-byte dworldlight_t records (CS:GO v21+ maps add a 12-byte shadow cast offset
 * after the normal: 100 bytes).
 */
export function parseWorldLights(data: Uint8Array, bspVersion: number): WorldLight[] {
  const out: WorldLight[] = [];
  if (!data.length) return out;
  const wide = data.length % 100 === 0 && (bspVersion >= 21 || data.length % 88 !== 0);
  const size = wide ? 100 : 88;
  if (data.length % size !== 0) return out;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const v = (o: number): Vec3 => ({ x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true) });
  const extra = wide ? 12 : 0;
  for (let o = 0; o + size <= data.length; o += size) {
    const t = o + 36 + extra; // after origin, intensity, normal (+ shadow offset)
    out.push({
      origin: v(o),
      intensity: v(o + 12),
      normal: v(o + 24),
      type: dv.getInt32(t + 4, true),
      style: dv.getInt32(t + 8, true),
      stopdot: dv.getFloat32(t + 12, true),
      stopdot2: dv.getFloat32(t + 16, true),
      exponent: dv.getFloat32(t + 20, true),
      radius: dv.getFloat32(t + 24, true),
      constantAttn: dv.getFloat32(t + 28, true),
      linearAttn: dv.getFloat32(t + 32, true),
      quadraticAttn: dv.getFloat32(t + 36, true),
    });
  }
  return out;
}

/** The ray casts lighting needs (CollisionWorld satisfies it). */
export interface RayCaster {
  traceRay(start: Vec3, end: Vec3, mask: number, out?: TraceResult): TraceResult;
  /** CollisionWorld's model switch: prop lighting turns the prop hulls (PROP_COLLISION_MODEL) off while it runs. */
  setModelSolid?(model: number, solid: boolean): void;
  isModelSolid?(model: number): boolean;
}

/**
 * The brush model number of prop collision hulls (bsp/phy.ts). Not a BSP model: negative, so the game treats a
 * prop like the world (static props belong to the world entity) - movement reports ground model 0 on it and
 * the entity system ignores it - while CollisionWorld.setModelSolid can still switch all prop hulls at once.
 */
export const PROP_COLLISION_MODEL = -2;

/**
 * Runs `fn` with the prop hulls of `world` non-solid: the engine's light cache traces light visibility against
 * the world only (and a prop's lighting origin is often inside its own hull).
 */
function withoutPropHulls<T>(world: RayCaster | null | undefined, fn: () => T): T {
  if (!world?.setModelSolid || !world.isModelSolid || !world.isModelSolid(PROP_COLLISION_MODEL)) return fn();
  world.setModelSolid(PROP_COLLISION_MODEL, false);
  try {
    return fn();
  } finally {
    world.setModelSolid(PROP_COLLISION_MODEL, true);
  }
}

const SKY_GRID = 2048;

/**
 * Light cubes for props, built the way the engine's light cache lights models: the leaf ambient cube plus the
 * direct contribution of every compiled light (point, spot, surface and sky/sun lights), each added to the cube
 * faces facing it (intensity * falloff * cos). Local lights need a clear ray (when a ray caster is given); the
 * sun needs a ray that reaches a sky face.
 */
export class PropLighting {
  private readonly ambient: LeafAmbientLighting;
  private readonly lights: WorldLight[];
  private readonly skyCells = new Map<string, number[]>();
  /** Sky faces: plane (nx ny nz d) + AABB (6), per face. */
  private readonly skyFaces: number[] = [];
  private readonly cache = new Map<string, [number, number, number][] | null>();
  private readonly tr: TraceResult = newTrace();

  constructor(
    private readonly bsp: BspFile,
    private readonly world: RayCaster | null = null,
    hdr = false,
  ) {
    this.ambient = new LeafAmbientLighting(bsp, hdr);
    let lights: WorldLight[] = [];
    try {
      lights = parseWorldLights(bsp.getLump(hdr ? LUMP_WORLDLIGHTS_HDR : LUMP_WORLDLIGHTS), bsp.version);
      if (!lights.length) lights = parseWorldLights(bsp.getLump(hdr ? LUMP_WORLDLIGHTS : LUMP_WORLDLIGHTS_HDR), bsp.version);
    } catch {
      lights = [];
    }
    this.lights = lights.filter((l) => l.type !== EMIT_SKYAMBIENT && l.type !== EMIT_QUAKELIGHT);
    if (world && this.lights.some((l) => l.type === EMIT_SKYLIGHT)) this.indexSkyFaces(bsp);
  }

  private indexSkyFaces(bsp: BspFile): void {
    const m = bsp.models[0];
    if (!m) return;
    for (let f = m.firstFace; f < m.firstFace + m.numFaces && f < bsp.faces.length; f++) {
      const face = bsp.faces[f];
      const ti = bsp.texinfo[face.texInfo];
      if (!ti || !(ti.flags & (SURF_SKY | SURF_SKY2D))) continue;
      const pl = bsp.planes[face.planeNum];
      if (!pl) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < face.numEdges; k++) {
        const se = bsp.surfedges[face.firstEdge + k];
        const vi = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
        const x = bsp.vertices[vi * 3];
        const y = bsp.vertices[vi * 3 + 1];
        const z = bsp.vertices[vi * 3 + 2];
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        z0 = Math.min(z0, z);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        z1 = Math.max(z1, z);
      }
      if (!Number.isFinite(x0)) continue;
      const id = this.skyFaces.length / 10;
      this.skyFaces.push(pl.normal.x, pl.normal.y, pl.normal.z, pl.dist, x0 - 2, y0 - 2, z0 - 2, x1 + 2, y1 + 2, z1 + 2);
      for (let cx = Math.floor(x0 / SKY_GRID); cx <= Math.floor(x1 / SKY_GRID); cx++) {
        for (let cy = Math.floor(y0 / SKY_GRID); cy <= Math.floor(y1 / SKY_GRID); cy++) {
          const key = `${cx},${cy}`;
          const list = this.skyCells.get(key);
          if (list) list.push(id);
          else this.skyCells.set(key, [id]);
        }
      }
    }
  }

  /** True when `p` lies on a sky face. */
  private onSky(p: Vec3): boolean {
    const list = this.skyCells.get(`${Math.floor(p.x / SKY_GRID)},${Math.floor(p.y / SKY_GRID)}`);
    if (!list) return false;
    const S = this.skyFaces;
    for (const id of list) {
      const o = id * 10;
      if (p.x < S[o + 4] || p.y < S[o + 5] || p.z < S[o + 6] || p.x > S[o + 7] || p.y > S[o + 8] || p.z > S[o + 9]) continue;
      if (Math.abs(S[o] * p.x + S[o + 1] * p.y + S[o + 2] * p.z - S[o + 3]) <= 2) return true;
    }
    return false;
  }

  private visible(from: Vec3, to: Vec3): boolean {
    if (!this.world) return true;
    try {
      this.world.traceRay(from, to, CONTENTS_SOLID, this.tr);
    } catch {
      return true;
    }
    return !this.tr.startsolid && this.tr.fraction >= 0.999;
  }

  private sunVisible(from: Vec3, dir: Vec3): boolean {
    if (!this.world) return true;
    const end = { x: from.x + dir.x * 65536, y: from.y + dir.y * 65536, z: from.z + dir.z * 65536 };
    try {
      this.world.traceRay(from, end, CONTENTS_SOLID, this.tr);
    } catch {
      return true;
    }
    if (this.tr.startsolid) return false;
    if (this.tr.fraction >= 1) return true;
    return this.onSky(this.tr.endpos);
  }

  /** Light cube at `p` (faces +x -x +y -y +z -z, linear RGB, 1 = fully lit), or null without any light data. */
  cube(at: Vec3): [number, number, number][] | null {
    const key = `${Math.round(at.x / 4)},${Math.round(at.y / 4)},${Math.round(at.z / 4)}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    // light the nearest open point: traces from inside a brush would see no light at all
    const p = openPointNear(this.bsp, [at])?.point ?? at;
    const amb = this.ambient.sample(p);
    if (!amb && !this.lights.length) {
      this.cache.set(key, null);
      return null;
    }
    const cube: [number, number, number][] = amb ? amb.map((c) => [c[0], c[1], c[2]] as [number, number, number]) : CUBE_AXES.map(() => [0, 0, 0] as [number, number, number]);
    for (const l of this.lights) {
      const I = l.intensity;
      const maxI = Math.max(I.x, I.y, I.z);
      if (!(maxI > 0)) continue;
      let lx: number;
      let ly: number;
      let lz: number;
      let ratio: number;
      if (l.type === EMIT_SKYLIGHT) {
        lx = -l.normal.x;
        ly = -l.normal.y;
        lz = -l.normal.z;
        ratio = 1;
        if (!this.sunVisible(p, { x: lx, y: ly, z: lz })) continue;
      } else {
        const dx = l.origin.x - p.x;
        const dy = l.origin.y - p.y;
        const dz = l.origin.z - p.z;
        const d2 = Math.max(dx * dx + dy * dy + dz * dz, 64);
        const d = Math.sqrt(d2);
        if (l.radius > 0 && d > l.radius) continue;
        lx = dx / d;
        ly = dy / d;
        lz = dz / d;
        if (l.type === EMIT_SURFACE) {
          // emits along its normal with cosine falloff
          const c = -(l.normal.x * lx + l.normal.y * ly + l.normal.z * lz);
          if (c <= 0) continue;
          ratio = c / d2;
        } else {
          const denom = l.constantAttn + l.linearAttn * d + l.quadraticAttn * d2;
          ratio = 1 / (denom > 1e-6 ? denom : d2);
          if (l.type === EMIT_SPOTLIGHT) {
            const c = -(l.normal.x * lx + l.normal.y * ly + l.normal.z * lz);
            if (c <= l.stopdot2) continue;
            if (c < l.stopdot) ratio *= (c - l.stopdot2) / (l.stopdot - l.stopdot2);
            if (l.exponent !== 0 && l.exponent !== 1) ratio *= Math.pow(c, l.exponent);
          }
        }
        if (ratio * maxI < 1 / 512) continue;
        // stop a unit short of the light: lights often sit inside their fixture brush
        if (!this.visible(p, { x: l.origin.x - lx, y: l.origin.y - ly, z: l.origin.z - lz })) continue;
      }
      for (let j = 0; j < 6; j++) {
        const a = CUBE_AXES[j];
        const c = a[0] * lx + a[1] * ly + a[2] * lz;
        if (c <= 0) continue;
        cube[j][0] += I.x * ratio * c;
        cube[j][1] += I.y * ratio * c;
        cube[j][2] += I.z * ratio * c;
      }
    }
    this.cache.set(key, cube);
    return cube;
  }
}

// ------------------------------------------------------------------------------------------ assembly

export interface PropOptions {
  /** Material settings for prop materials (extra file sources, DXT passthrough...). */
  materials?: BuildMaterialsOptions;
  /**
   * Largest texture size for prop materials. Default 512 (1024 with compressedTextures): maps like
   * surf_summer_ksf pack ~900 prop textures, which would take ~420 MB as full-size RGBA.
   */
  maxTextureSize?: number;
  /** Use this material loader (shared caches) instead of creating one. */
  loader?: MaterialLoader;
  /** Prop lighting from the HDR lumps (match the lightmaps' choice). Default false (LDR). */
  hdrLighting?: boolean;
  /**
   * Ray caster (the map's CollisionWorld) for light visibility; without it every light reaches every prop. Prop
   * collision hulls (PROP_COLLISION_MODEL) are switched off while props are built.
   */
  world?: RayCaster | null;
  warnings?: string[];
}

/** Entity classes whose "model" keyvalue places a studio model in the world. */
const ENTITY_PROP_CLASSES = new Set([
  'prop_dynamic',
  'prop_dynamic_override',
  'prop_dynamic_ornament',
  'prop_physics',
  'prop_physics_override',
  'prop_physics_multiplayer',
  'prop_dynamic_glow',
  'dynamic_prop',
  'physics_prop',
  'prop_door_rotating',
]);

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

/** One prop placement (static prop or model entity). */
export interface PropInstance {
  model: string;
  origin: Vec3;
  angles: QAngle;
  skin: number;
  body: number;
  scale: number;
  lightingOrigin: Vec3;
  color: [number, number, number] | null;
  alpha: number;
  entity: number;
  /** Model entities: the starting sequence (DefaultAnim), null = sequence 0. Static props are drawn unposed. */
  sequence?: string | null;
}

/** Decodes models once per (model, body), resolves materials once per (model, body, skin), emits RenderProps. */
class PropBuilder {
  private readonly sources: MaterialFileSource[] = [];
  private loader: MaterialLoader | null;
  private readonly models = new Map<string, StudioModel | null>();
  private readonly shared = new Map<string, { material: string; mesh: StudioMesh }[]>();
  private readonly scaled = new Map<StudioMesh, Map<number, Float32Array>>();
  private readonly lighting: PropLighting;
  missing = 0;
  private readonly bsp: BspFile;
  broken = 0;
  readonly brokenNames: string[] = [];
  readonly out: RenderProp[] = [];

  constructor(
    bsp: BspFile,
    private readonly pak: PakFile | null,
    private readonly materials: Map<string, MaterialDef>,
    private readonly opts: PropOptions,
  ) {
    this.bsp = bsp;
    if (pak) this.sources.push(pak);
    if (opts.materials?.extraSources) this.sources.push(...opts.materials.extraSources);
    this.loader = opts.loader ?? null;
    this.lighting = new PropLighting(bsp, opts.world ?? null, !!opts.hdrLighting);
  }

  get hasSources(): boolean {
    return this.sources.length > 0;
  }

  private getLoader(): MaterialLoader {
    if (!this.loader) {
      const m = this.opts.materials;
      const compressed = !!m?.compressedTextures;
      this.loader = new MaterialLoader(this.pak, {
        ...m,
        maxTextureSize: this.opts.maxTextureSize ?? Math.min(compressed ? 1024 : 512, m?.maxTextureSize ?? 2048),
      });
    }
    return this.loader;
  }

  private loadModel(path: string, body: number): StudioModel | null {
    const key = normalizePakPath(path);
    const cacheKey = `${key}|${body}`;
    if (this.models.has(cacheKey)) return this.models.get(cacheKey)!;
    let model: StudioModel | null = null;
    const base = key.replace(/\.mdl$/, '');
    const mdl = readFirst(this.sources, [key]);
    const vvd = mdl ? readFirst(this.sources, [`${base}.vvd`]) : null;
    const vtx = mdl ? readFirst(this.sources, [`${base}.dx90.vtx`, `${base}.dx80.vtx`, `${base}.sw.vtx`, `${base}.vtx`]) : null;
    if (mdl && vvd && vtx) {
      try {
        model = decodeStudioModel(key, mdl, vvd, vtx, body);
      } catch (e) {
        this.broken++;
        if (this.brokenNames.length < 5) this.brokenNames.push(`${key} (${(e as Error).message})`);
      }
    } else this.missing++;
    this.models.set(cacheKey, model);
    return model;
  }

  private meshesFor(model: StudioModel, body: number, skin: number): { material: string; mesh: StudioMesh }[] {
    const nFam = model.skinFamilies.length;
    const family = nFam ? Math.max(0, Math.min(skin, nFam - 1)) : 0;
    const key = `${model.name}|${body}|${family}`;
    const hit = this.shared.get(key);
    if (hit) return hit;
    const fam = nFam ? model.skinFamilies[family] : null;
    const list: { material: string; mesh: StudioMesh }[] = [];
    for (const mesh of model.meshes) {
      const texIndex = fam && mesh.materialRef >= 0 && mesh.materialRef < fam.length ? fam[mesh.materialRef] : mesh.materialRef;
      const tex = model.textures[texIndex] ?? model.textures[mesh.materialRef] ?? '';
      let matName = '';
      try {
        const def = this.getLoader().loadModelMaterial(tex.replace(/\\/g, '/'), model.cdMaterials);
        matName = def.name;
        if (!this.materials.has(matName)) this.materials.set(matName, def);
      } catch {
        matName = normalizeMaterialName(tex) || 'models/missing';
      }
      if (!matName || !this.materials.has(matName)) continue;
      list.push({ material: matName, mesh });
    }
    this.shared.set(key, list);
    return list;
  }

  /** Area of the nearest open leaf at the lighting origin or the origin (see openPointNear); -1 if none. */
  private areaAt(origin: Vec3, lighting: Vec3): number {
    const open = openPointNear(this.bsp, [lighting, origin]);
    return open ? this.bsp.leafs[open.leaf].area : -1;
  }

  private scaledPositions(mesh: StudioMesh, scale: number): Float32Array {
    let byScale = this.scaled.get(mesh);
    if (!byScale) this.scaled.set(mesh, (byScale = new Map()));
    let arr = byScale.get(scale);
    if (!arr) {
      arr = new Float32Array(mesh.positions.length);
      for (let i = 0; i < arr.length; i++) arr[i] = mesh.positions[i] * scale;
      byScale.set(scale, arr);
    }
    return arr;
  }

  add(p: PropInstance): void {
    if (!p.model) return;
    let model: StudioModel | null = null;
    try {
      model = this.loadModel(p.model, p.body);
    } catch {
      model = null;
    }
    if (!model) return;
    let list: { material: string; mesh: StudioMesh }[];
    try {
      list = this.meshesFor(model, p.body, p.skin);
    } catch {
      return;
    }
    if (!list.length) return;
    let ambient: [number, number, number][] | null = null;
    try {
      ambient = this.lighting.cube(p.lightingOrigin);
    } catch {
      ambient = null;
    }
    const area = this.areaAt(p.origin, p.lightingOrigin);
    // animated entities are drawn in their starting sequence's first frame (static props: the bind pose)
    let origin: Vec3 = p.origin;
    let angles: QAngle = p.angles;
    if (p.entity >= 0) {
      const label = p.sequence ? p.sequence.trim().toLowerCase() : '';
      // DefaultAnim names a sequence of the model: its pose; otherwise (or unknown) sequence 0
      const pose = label && model.sequencePoses?.has(label) ? model.sequencePoses.get(label) : model.defaultPose;
      if (pose) ({ origin, angles } = composePose(p.origin, p.angles, p.scale, pose));
    }
    for (const { material, mesh } of list) {
      const rp: RenderProp = {
        model: model.name,
        origin: { x: origin.x, y: origin.y, z: origin.z },
        angles: { pitch: angles.pitch, yaw: angles.yaw, roll: angles.roll },
        positions: p.scale === 1 ? mesh.positions : this.scaledPositions(mesh, p.scale),
        normals: mesh.normals,
        uvs: mesh.uvs,
        indices: mesh.indices,
        material,
      };
      if (p.color) rp.color = [p.color[0], p.color[1], p.color[2]];
      if (p.alpha < 1) rp.alpha = p.alpha;
      if (p.entity >= 0) rp.entity = p.entity;
      if (area >= 0) rp.area = area;
      if (ambient) rp.ambientCube = ambient.map((c) => [c[0], c[1], c[2]] as [number, number, number]);
      this.out.push(rp);
    }
  }

  report(): void {
    const w = this.opts.warnings;
    if (!w) return;
    if (this.missing) w.push(`${this.missing} prop models are not packed in the map (not drawn)`);
    if (this.broken) w.push(`${this.broken} prop models could not be decoded: ${this.brokenNames.join(', ')}`);
  }
}

function parseRgb255(s: string | undefined): [number, number, number] | null {
  if (!s) return null;
  const p = s.trim().split(/[\s,]+/).map((x) => parseFloat(x));
  if (p.length < 3 || !p.slice(0, 3).every((x) => Number.isFinite(x))) return null;
  if (p[0] >= 255 && p[1] >= 255 && p[2] >= 255) return null;
  const c = (x: number) => Math.max(0, Math.min(1, x / 255));
  return [c(p[0]), c(p[1]), c(p[2])];
}

function staticInstances(bsp: BspFile, warnings?: string[]): PropInstance[] {
  const lump = bsp.gameLumps.find((g) => g.id === 'sprp');
  if (!lump || lump.data.length < 12) return [];
  let parsed: StaticPropLump;
  try {
    parsed = parseStaticPropLump(lump.data, lump.version);
  } catch (e) {
    warnings?.push(`static props: ${(e as Error).message}`);
    return [];
  }
  return parsed.props.map((p) => {
    const d = p.diffuse;
    const tinted = d && (d[0] < 255 || d[1] < 255 || d[2] < 255);
    return {
      model: p.model,
      origin: p.origin,
      angles: p.angles,
      skin: p.skin,
      body: 0,
      scale: p.scale,
      lightingOrigin: p.lightingOrigin,
      color: tinted ? [d![0] / 255, d![1] / 255, d![2] / 255] : null,
      alpha: d ? d[3] / 255 : 1,
      entity: -1,
    };
  });
}

/**
 * Model entities drawn like props: prop_dynamic / prop_physics variants with a .mdl model, unless they start
 * disabled, use rendermode 10 ("don't render") or are fully transparent. Skin, body ("body" / "SetBodyGroup"),
 * "modelscale", rendercolor and renderamt (with a translucent rendermode) are honoured; animations are not
 * (the reference pose is drawn).
 */
export function entityPropInstances(entities: MapEntity[]): PropInstance[] {
  const out: PropInstance[] = [];
  for (const e of entities) {
    const cls = e.classname.toLowerCase();
    if (!ENTITY_PROP_CLASSES.has(cls)) continue;
    const model = e.kv.model ?? '';
    if (!/\.mdl$/i.test(model)) continue;
    if ((e.kv.startdisabled ?? '0').trim() === '1') continue;
    const rendermode = parseInt(e.kv.rendermode ?? '0', 10) || 0;
    if (rendermode === 10) continue;
    const renderamt = Math.max(0, Math.min(255, parseFloat(e.kv.renderamt ?? '255')));
    const alpha = rendermode !== 0 && Number.isFinite(renderamt) ? renderamt / 255 : 1;
    if (alpha <= 0) continue;
    const scale = parseFloat(e.kv.modelscale ?? '1');
    const o = e.origin;
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) continue;
    out.push({
      model,
      origin: { x: o.x, y: o.y, z: o.z },
      angles: { pitch: e.angles.pitch || 0, yaw: e.angles.yaw || 0, roll: e.angles.roll || 0 },
      skin: parseInt(e.kv.skin ?? '0', 10) || 0,
      body: parseInt(e.kv.body ?? e.kv.setbodygroup ?? '0', 10) || 0,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      lightingOrigin: { x: o.x, y: o.y, z: o.z + 8 },
      color: parseRgb255(e.kv.rendercolor),
      alpha,
      entity: e.index,
      sequence: (e.kv.defaultanim ?? '').trim() || null,
    });
  }
  return out;
}

/**
 * RenderProps for the map's static props and model entities (see entityPropInstances) whose models are
 * available (packed in the map or in the material options' extraSources). Prop materials are added to
 * `materials` (keyed by normalized name). Never throws for a broken model.
 */
export function buildMapProps(
  bsp: BspFile,
  entities: MapEntity[],
  pak: PakFile | null,
  materials: Map<string, MaterialDef>,
  opts: PropOptions = {},
): RenderProp[] {
  const b = new PropBuilder(bsp, pak, materials, opts);
  if (!b.hasSources) return [];
  return withoutPropHulls(opts.world, () => {
    for (const p of staticInstances(bsp, opts.warnings)) b.add(p);
    for (const p of entityPropInstances(entities)) b.add(p);
    b.report();
    return b.out;
  });
}

/** RenderProps for the static props only (the 'sprp' game lump). */
export function buildStaticProps(bsp: BspFile, pak: PakFile | null, materials: Map<string, MaterialDef>, opts: PropOptions = {}): RenderProp[] {
  const b = new PropBuilder(bsp, pak, materials, opts);
  if (!b.hasSources) return [];
  return withoutPropHulls(opts.world, () => {
    for (const p of staticInstances(bsp, opts.warnings)) b.add(p);
    b.report();
    return b.out;
  });
}
