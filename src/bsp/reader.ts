// Source engine VBSP reader (v19/v20 CS:S-era maps, v21 CS:GO maps including LZMA-compressed lumps).
// Written from the public bspfile.h layout documentation (Valve Developer Wiki "Source BSP File Format").
//
// The whole file stays in the caller's ArrayBuffer: lumps are exposed as zero-copy views and numeric
// arrays (vertices, edges, surfedges, leaffaces, leafbrushes, disptris) are typed-array views whenever the
// lump is suitably aligned (little-endian hosts), otherwise small copies.
import { decodeSourceLzma, isSourceLzma, sourceLzmaActualSize } from './lzma';
import {
  BspBrush,
  BspBrushSide,
  BspDispInfo,
  BspDispVert,
  BspFace,
  BspFile,
  BspGameLump,
  BspLeaf,
  BspLumpInfo,
  BspModel,
  BspNode,
  BspPlane,
  BspTexData,
  BspTexInfo,
  LUMP_BRUSHES,
  LUMP_BRUSHSIDES,
  LUMP_DISPINFO,
  LUMP_DISP_TRIS,
  LUMP_DISP_VERTS,
  LUMP_EDGES,
  LUMP_ENTITIES,
  LUMP_FACES,
  LUMP_FACES_HDR,
  LUMP_GAME_LUMP,
  LUMP_LEAFBRUSHES,
  LUMP_LEAFFACES,
  LUMP_LEAFS,
  LUMP_LIGHTING,
  LUMP_LIGHTING_HDR,
  LUMP_MODELS,
  LUMP_NODES,
  LUMP_PAKFILE,
  LUMP_PLANES,
  LUMP_SURFEDGES,
  LUMP_TEXDATA,
  LUMP_TEXDATA_STRING_DATA,
  LUMP_TEXDATA_STRING_TABLE,
  LUMP_TEXINFO,
  LUMP_VERTEXES,
} from './types';

export class BspError extends Error {
  constructor(msg: string) {
    super(`BSP: ${msg}`);
    this.name = 'BspError';
  }
}

export const HEADER_LUMPS = 64;
/** ident(4) + version(4) + 64 lump headers(16) + mapRevision(4). */
export const BSP_HEADER_SIZE = 8 + HEADER_LUMPS * 16 + 4;
const IDENT_VBSP = 0x50534256; // "VBSP" little-endian
const IDENT_VBSP_BE = 0x56425350; // "VBSP" written big-endian (X360/PS3 maps)

// struct sizes (bytes)
const PLANE_SIZE = 20;
const FACE_SIZE = 56;
const TEXINFO_SIZE = 72;
const TEXDATA_SIZE = 32;
const BRUSH_SIZE = 12;
const BRUSHSIDE_SIZE = 8;
const NODE_SIZE = 32;
const LEAF_SIZE_V0 = 56; // with the 24-byte CompressedLightCube
const LEAF_SIZE_V1 = 32;
const MODEL_SIZE = 48;
const DISPINFO_SIZE = 176;
const DISPVERT_SIZE = 20;
const GAMELUMP_ENTRY_SIZE = 16;

/** Versions known to use the layout parsed here. */
const KNOWN_VERSIONS = new Set([19, 20, 21]);
/** Versions we attempt with a warning (the layouts we read are mostly unchanged). */
const TOLERATED_VERSIONS = new Set([17, 18, 22, 23, 24, 25]);

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const EMPTY = new Uint8Array(0);

export interface ParseBspOptions {
  /** Run index validation and append problems to `warnings` (default true; cost is a few ms). */
  validate?: boolean;
}

function dataView(d: Uint8Array): DataView {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}

function u16Array(d: Uint8Array, count: number): Uint16Array {
  if (LITTLE_ENDIAN_HOST && (d.byteOffset & 1) === 0) return new Uint16Array(d.buffer, d.byteOffset, count);
  const out = new Uint16Array(count);
  const v = dataView(d);
  for (let i = 0; i < count; i++) out[i] = v.getUint16(i * 2, true);
  return out;
}

function i32Array(d: Uint8Array, count: number): Int32Array {
  if (LITTLE_ENDIAN_HOST && (d.byteOffset & 3) === 0) return new Int32Array(d.buffer, d.byteOffset, count);
  const out = new Int32Array(count);
  const v = dataView(d);
  for (let i = 0; i < count; i++) out[i] = v.getInt32(i * 4, true);
  return out;
}

function f32Array(d: Uint8Array, count: number): Float32Array {
  if (LITTLE_ENDIAN_HOST && (d.byteOffset & 3) === 0) return new Float32Array(d.buffer, d.byteOffset, count);
  const out = new Float32Array(count);
  const v = dataView(d);
  for (let i = 0; i < count; i++) out[i] = v.getFloat32(i * 4, true);
  return out;
}

function fourCCString(id: number): string {
  // Game lump ids are written as an int whose most significant byte is the first character ('sprp').
  return String.fromCharCode((id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff);
}

function latin1(d: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i += 4096) {
    s += String.fromCharCode.apply(null, Array.from(d.subarray(i, Math.min(end, i + 4096))));
  }
  return s;
}

/** Decodes entity lump text: UTF-8 when valid, otherwise Latin-1 (old maps with Windows-1252 text). */
function decodeText(d: Uint8Array): string {
  let end = d.length;
  while (end > 0 && d[end - 1] === 0) end--;
  const bytes = d.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return latin1(bytes, 0, bytes.length);
  }
}

interface LumpOrderScore {
  lumps: BspLumpInfo[];
  score: number;
}

function readLumpHeaders(dv: DataView, fileSize: number, l4d2Order: boolean): LumpOrderScore {
  const lumps: BspLumpInfo[] = [];
  let score = 0;
  for (let i = 0; i < HEADER_LUMPS; i++) {
    const o = 8 + i * 16;
    const a = dv.getInt32(o, true);
    const b = dv.getInt32(o + 4, true);
    const c = dv.getInt32(o + 8, true);
    const fourCC = dv.getInt32(o + 12, true);
    // standard: {fileofs, filelen, version, fourCC}; Left 4 Dead 2: {version, fileofs, filelen, fourCC}
    const info: BspLumpInfo = l4d2Order
      ? { offset: b, length: c, version: a, fourCC }
      : { offset: a, length: b, version: c, fourCC };
    lumps.push(info);
    if (info.length > 0) {
      const ok =
        info.offset >= BSP_HEADER_SIZE && info.offset + info.length <= fileSize && info.version >= 0 && info.version < 0x100;
      score += ok ? 1 : -1;
    }
  }
  return { lumps, score };
}

/**
 * Parses a Source BSP. Lumps are decoded eagerly into the BspFile structures (except the lumps only reachable
 * through getLump), so callers never touch raw bytes for the common structures. Throws BspError for files
 * that are not (supported) VBSP files.
 */
export function parseBsp(buf: ArrayBuffer, opts: ParseBspOptions = {}): BspFile {
  const fileSize = buf.byteLength;
  if (fileSize < BSP_HEADER_SIZE) throw new BspError(`file too small (${fileSize} bytes)`);
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  const warnings: string[] = [];

  const ident = dv.getUint32(0, true);
  if (ident !== IDENT_VBSP) {
    if (ident === IDENT_VBSP_BE) throw new BspError('big-endian console BSP (X360/PS3) is not supported');
    if (ident === 0x50534272) throw new BspError('Titanfall/Apex "rBSP" maps are not supported');
    if (ident === 0x50534249) throw new BspError('Quake/Quake 3 "IBSP" maps are not supported');
    if (ident === 29 || ident === 30) throw new BspError(`GoldSrc/Quake BSP (version ${ident}) is not supported`);
    throw new BspError('not a Source BSP (missing "VBSP" header)');
  }
  const version = dv.getInt32(4, true);
  if (!KNOWN_VERSIONS.has(version)) {
    if (!TOLERATED_VERSIONS.has(version)) throw new BspError(`unsupported VBSP version ${version}`);
    warnings.push(`untested VBSP version ${version}; parsing with the v20 layout`);
  }

  // Lump directory (detect Left 4 Dead 2's reordered lump_t).
  let { lumps, score } = readLumpHeaders(dv, fileSize, false);
  if (version >= 21) {
    const alt = readLumpHeaders(dv, fileSize, true);
    if (alt.score > score) {
      lumps = alt.lumps;
      score = alt.score;
      warnings.push('lump directory uses the Left 4 Dead 2 field order');
    }
  }
  const mapRevision = dv.getInt32(8 + HEADER_LUMPS * 16, true);

  const lumpValid: boolean[] = lumps.map((l, i) => {
    if (l.length <= 0) return false;
    if (l.offset < 0 || l.offset + l.length > fileSize) {
      warnings.push(`lump ${i} out of file bounds (offset ${l.offset}, length ${l.length}); ignored`);
      return false;
    }
    return true;
  });

  const decompressed = new Map<number, Uint8Array>();
  const getLump = (index: number): Uint8Array => {
    if (!(index >= 0 && index < HEADER_LUMPS) || !lumpValid[index]) return EMPTY;
    const cached = decompressed.get(index);
    if (cached) return cached;
    const l = lumps[index];
    const raw = bytes.subarray(l.offset, l.offset + l.length);
    if (!isSourceLzma(raw)) return raw;
    const out = decodeSourceLzma(raw);
    if (l.fourCC !== 0 && l.fourCC !== out.length) {
      warnings.push(`lump ${index}: LZMA size ${out.length} differs from header size ${l.fourCC}`);
    }
    decompressed.set(index, out);
    return out;
  };

  /** Lump bytes for an array of fixed-size records; warns when the size isn't a multiple. */
  const recordLump = (index: number, size: number, name: string): { d: Uint8Array; v: DataView; n: number } => {
    let d: Uint8Array;
    try {
      d = getLump(index);
    } catch (e) {
      warnings.push(`lump ${index} (${name}): ${(e as Error).message}`);
      d = EMPTY;
    }
    const n = Math.floor(d.length / size);
    if (d.length % size !== 0) warnings.push(`lump ${index} (${name}): size ${d.length} is not a multiple of ${size}`);
    return { d, v: dataView(d), n };
  };

  // ---- planes ----
  const planes: BspPlane[] = [];
  {
    const { v, n } = recordLump(LUMP_PLANES, PLANE_SIZE, 'planes');
    for (let i = 0; i < n; i++) {
      const o = i * PLANE_SIZE;
      planes.push({
        normal: { x: v.getFloat32(o, true), y: v.getFloat32(o + 4, true), z: v.getFloat32(o + 8, true) },
        dist: v.getFloat32(o + 12, true),
        type: v.getInt32(o + 16, true),
      });
    }
  }

  // ---- vertices / edges / surfedges ----
  const vertLump = recordLump(LUMP_VERTEXES, 12, 'vertexes');
  const vertices = f32Array(vertLump.d, vertLump.n * 3);
  const edgeLump = recordLump(LUMP_EDGES, 4, 'edges');
  const edges = u16Array(edgeLump.d, edgeLump.n * 2);
  const seLump = recordLump(LUMP_SURFEDGES, 4, 'surfedges');
  const surfedges = i32Array(seLump.d, seLump.n);

  // ---- faces (LDR lump, falling back to the HDR lump for HDR-only compiles) ----
  let facesLump = LUMP_FACES;
  if (getLumpLength(lumps, lumpValid, LUMP_FACES) === 0 && getLumpLength(lumps, lumpValid, LUMP_FACES_HDR) > 0) {
    facesLump = LUMP_FACES_HDR;
  }
  const faces: BspFace[] = [];
  {
    const { v, n } = recordLump(facesLump, FACE_SIZE, 'faces');
    for (let i = 0; i < n; i++) {
      const o = i * FACE_SIZE;
      faces.push({
        planeNum: v.getUint16(o, true),
        side: v.getUint8(o + 2),
        onNode: v.getUint8(o + 3),
        firstEdge: v.getInt32(o + 4, true),
        numEdges: v.getInt16(o + 8, true),
        texInfo: v.getInt16(o + 10, true),
        dispInfo: v.getInt16(o + 12, true),
        surfaceFogVolumeID: v.getInt16(o + 14, true),
        styles: [v.getUint8(o + 16), v.getUint8(o + 17), v.getUint8(o + 18), v.getUint8(o + 19)],
        lightOfs: v.getInt32(o + 20, true),
        area: v.getFloat32(o + 24, true),
        lightmapTextureMinsInLuxels: [v.getInt32(o + 28, true), v.getInt32(o + 32, true)],
        lightmapTextureSizeInLuxels: [v.getInt32(o + 36, true), v.getInt32(o + 40, true)],
        origFace: v.getInt32(o + 44, true),
        numPrims: v.getUint16(o + 48, true),
        firstPrimID: v.getUint16(o + 50, true),
        smoothingGroups: v.getUint32(o + 52, true),
      });
    }
  }

  // ---- texinfo / texdata / names ----
  const texinfo: BspTexInfo[] = [];
  {
    const { v, n } = recordLump(LUMP_TEXINFO, TEXINFO_SIZE, 'texinfo');
    for (let i = 0; i < n; i++) {
      const o = i * TEXINFO_SIZE;
      const textureVecs = new Float32Array(8);
      const lightmapVecs = new Float32Array(8);
      for (let k = 0; k < 8; k++) {
        textureVecs[k] = v.getFloat32(o + k * 4, true);
        lightmapVecs[k] = v.getFloat32(o + 32 + k * 4, true);
      }
      texinfo.push({ textureVecs, lightmapVecs, flags: v.getInt32(o + 64, true), texData: v.getInt32(o + 68, true) });
    }
  }
  const texdata: BspTexData[] = [];
  {
    const { v, n } = recordLump(LUMP_TEXDATA, TEXDATA_SIZE, 'texdata');
    for (let i = 0; i < n; i++) {
      const o = i * TEXDATA_SIZE;
      texdata.push({
        reflectivity: { x: v.getFloat32(o, true), y: v.getFloat32(o + 4, true), z: v.getFloat32(o + 8, true) },
        nameStringTableID: v.getInt32(o + 12, true),
        width: v.getInt32(o + 16, true),
        height: v.getInt32(o + 20, true),
        viewWidth: v.getInt32(o + 24, true),
        viewHeight: v.getInt32(o + 28, true),
      });
    }
  }
  const texdataNames: string[] = [];
  {
    const tableLump = recordLump(LUMP_TEXDATA_STRING_TABLE, 4, 'texdata string table');
    const table = i32Array(tableLump.d, tableLump.n);
    let strData: Uint8Array;
    try {
      strData = getLump(LUMP_TEXDATA_STRING_DATA);
    } catch (e) {
      warnings.push(`texdata string data: ${(e as Error).message}`);
      strData = EMPTY;
    }
    let bad = 0;
    for (const td of texdata) {
      const id = td.nameStringTableID;
      let name = '';
      if (id >= 0 && id < table.length && table[id] >= 0 && table[id] < strData.length) {
        const start = table[id];
        let end = start;
        while (end < strData.length && strData[end] !== 0) end++;
        name = latin1(strData, start, end);
      } else bad++;
      texdataNames.push(name);
    }
    if (bad) warnings.push(`${bad} texdata entries have no valid name`);
  }

  // ---- brushes / brush sides ----
  const brushes: BspBrush[] = [];
  {
    const { v, n } = recordLump(LUMP_BRUSHES, BRUSH_SIZE, 'brushes');
    for (let i = 0; i < n; i++) {
      const o = i * BRUSH_SIZE;
      brushes.push({ firstSide: v.getInt32(o, true), numSides: v.getInt32(o + 4, true), contents: v.getInt32(o + 8, true) });
    }
  }
  const brushSides: BspBrushSide[] = [];
  {
    // v20+: planenum u16, texinfo i16, dispinfo i16, bevel u8, thin u8. v19 and older: bevel is an i16.
    const oldLayout = version <= 19;
    const { v, n } = recordLump(LUMP_BRUSHSIDES, BRUSHSIDE_SIZE, 'brushsides');
    for (let i = 0; i < n; i++) {
      const o = i * BRUSHSIDE_SIZE;
      const b6 = v.getUint8(o + 6);
      const b7 = v.getUint8(o + 7);
      brushSides.push({
        planeNum: v.getUint16(o, true),
        texInfo: v.getInt16(o + 2, true),
        dispInfo: v.getInt16(o + 4, true),
        bevel: oldLayout ? (b6 | b7) !== 0 : b6 !== 0,
        thin: oldLayout ? false : b7 !== 0,
      });
    }
  }

  // ---- nodes / leafs ----
  const nodes: BspNode[] = [];
  {
    const { v, n } = recordLump(LUMP_NODES, NODE_SIZE, 'nodes');
    for (let i = 0; i < n; i++) {
      const o = i * NODE_SIZE;
      nodes.push({
        planeNum: v.getInt32(o, true),
        children: [v.getInt32(o + 4, true), v.getInt32(o + 8, true)],
        mins: { x: v.getInt16(o + 12, true), y: v.getInt16(o + 14, true), z: v.getInt16(o + 16, true) },
        maxs: { x: v.getInt16(o + 18, true), y: v.getInt16(o + 20, true), z: v.getInt16(o + 22, true) },
        firstFace: v.getUint16(o + 24, true),
        numFaces: v.getUint16(o + 26, true),
        area: v.getInt16(o + 28, true),
      });
    }
  }
  const leafs: BspLeaf[] = [];
  {
    const lumpVersion = lumps[LUMP_LEAFS].version;
    const len = getLumpLength(lumps, lumpValid, LUMP_LEAFS, getLump);
    // Lump version 0 leafs embed the ambient light cube (56 bytes); version 1 (v20+) moved it out (32 bytes).
    let leafSize = lumpVersion === 0 ? LEAF_SIZE_V0 : LEAF_SIZE_V1;
    if (len % leafSize !== 0) {
      const other = leafSize === LEAF_SIZE_V0 ? LEAF_SIZE_V1 : LEAF_SIZE_V0;
      if (len % other === 0) {
        warnings.push(`leaf lump version ${lumpVersion} but size fits ${other}-byte leafs; using ${other}`);
        leafSize = other;
      }
    }
    const { v, n } = recordLump(LUMP_LEAFS, leafSize, 'leafs');
    for (let i = 0; i < n; i++) {
      const o = i * leafSize;
      const areaFlags = v.getUint16(o + 6, true);
      leafs.push({
        contents: v.getInt32(o, true),
        cluster: v.getInt16(o + 4, true),
        area: areaFlags & 0x1ff,
        flags: (areaFlags >>> 9) & 0x7f,
        mins: { x: v.getInt16(o + 8, true), y: v.getInt16(o + 10, true), z: v.getInt16(o + 12, true) },
        maxs: { x: v.getInt16(o + 14, true), y: v.getInt16(o + 16, true), z: v.getInt16(o + 18, true) },
        firstLeafFace: v.getUint16(o + 20, true),
        numLeafFaces: v.getUint16(o + 22, true),
        firstLeafBrush: v.getUint16(o + 24, true),
        numLeafBrushes: v.getUint16(o + 26, true),
        leafWaterDataID: v.getInt16(o + 28, true),
      });
    }
  }
  const lfLump = recordLump(LUMP_LEAFFACES, 2, 'leaffaces');
  const leafFaces = u16Array(lfLump.d, lfLump.n);
  const lbLump = recordLump(LUMP_LEAFBRUSHES, 2, 'leafbrushes');
  const leafBrushes = u16Array(lbLump.d, lbLump.n);

  // ---- models ----
  const models: BspModel[] = [];
  {
    const { v, n } = recordLump(LUMP_MODELS, MODEL_SIZE, 'models');
    for (let i = 0; i < n; i++) {
      const o = i * MODEL_SIZE;
      models.push({
        mins: { x: v.getFloat32(o, true), y: v.getFloat32(o + 4, true), z: v.getFloat32(o + 8, true) },
        maxs: { x: v.getFloat32(o + 12, true), y: v.getFloat32(o + 16, true), z: v.getFloat32(o + 20, true) },
        origin: { x: v.getFloat32(o + 24, true), y: v.getFloat32(o + 28, true), z: v.getFloat32(o + 32, true) },
        headNode: v.getInt32(o + 36, true),
        firstFace: v.getInt32(o + 40, true),
        numFaces: v.getInt32(o + 44, true),
      });
    }
  }

  // ---- lighting ----
  const optionalLump = (index: number, name: string): Uint8Array | null => {
    try {
      const d = getLump(index);
      return d.length > 0 ? d : null;
    } catch (e) {
      warnings.push(`lump ${index} (${name}): ${(e as Error).message}`);
      return null;
    }
  };
  const lighting = optionalLump(LUMP_LIGHTING, 'lighting');
  const lightingHDR = optionalLump(LUMP_LIGHTING_HDR, 'HDR lighting');

  // ---- displacements ----
  const dispInfos: BspDispInfo[] = [];
  {
    const { v, n } = recordLump(LUMP_DISPINFO, DISPINFO_SIZE, 'dispinfo');
    for (let i = 0; i < n; i++) {
      const o = i * DISPINFO_SIZE;
      dispInfos.push({
        startPosition: { x: v.getFloat32(o, true), y: v.getFloat32(o + 4, true), z: v.getFloat32(o + 8, true) },
        dispVertStart: v.getInt32(o + 12, true),
        dispTriStart: v.getInt32(o + 16, true),
        power: v.getInt32(o + 20, true),
        minTess: v.getInt32(o + 24, true),
        smoothingAngle: v.getFloat32(o + 28, true),
        contents: v.getInt32(o + 32, true),
        mapFace: v.getUint16(o + 36, true),
        lightmapAlphaStart: v.getInt32(o + 40, true),
        lightmapSamplePositionStart: v.getInt32(o + 44, true),
        // + edge/corner neighbours and allowed-verts bitfield (not needed)
      });
    }
  }
  const dispVerts: BspDispVert[] = [];
  {
    const { v, n } = recordLump(LUMP_DISP_VERTS, DISPVERT_SIZE, 'dispverts');
    for (let i = 0; i < n; i++) {
      const o = i * DISPVERT_SIZE;
      dispVerts.push({
        vec: { x: v.getFloat32(o, true), y: v.getFloat32(o + 4, true), z: v.getFloat32(o + 8, true) },
        dist: v.getFloat32(o + 12, true),
        alpha: v.getFloat32(o + 16, true),
      });
    }
  }
  const dtLump = recordLump(LUMP_DISP_TRIS, 2, 'disptris');
  const dispTris = u16Array(dtLump.d, dtLump.n);

  // ---- pakfile ----
  const pakfile = optionalLump(LUMP_PAKFILE, 'pakfile');

  // ---- game lumps ----
  const gameLumps = readGameLumps(bytes, lumps[LUMP_GAME_LUMP], lumpValid[LUMP_GAME_LUMP], getLump, warnings);

  // ---- entities ----
  let entitiesText = '';
  try {
    entitiesText = decodeText(getLump(LUMP_ENTITIES));
  } catch (e) {
    warnings.push(`entity lump: ${(e as Error).message}`);
  }

  const bsp: BspFile = {
    version,
    mapRevision,
    lumps,
    getLump,
    entitiesText,
    planes,
    vertices,
    edges,
    surfedges,
    faces,
    texinfo,
    texdata,
    texdataNames,
    brushes,
    brushSides,
    nodes,
    leafs,
    leafFaces,
    leafBrushes,
    models,
    lighting,
    lightingHDR,
    dispInfos,
    dispVerts,
    dispTris,
    pakfile,
    gameLumps,
    facesLump,
    warnings,
  };
  if (opts.validate !== false) warnings.push(...validateBsp(bsp));
  return bsp;
}

/** Byte length of a lump (decompressed size for LZMA lumps when `getLump` is given). */
function getLumpLength(
  lumps: BspLumpInfo[],
  valid: boolean[],
  index: number,
  getLump?: (i: number) => Uint8Array,
): number {
  if (!valid[index]) return 0;
  const l = lumps[index];
  if (l.fourCC > 0) {
    // CS:GO compressed lumps store the uncompressed size here.
    return getLump ? safeLength(getLump, index) : l.fourCC;
  }
  return l.length;
}

function safeLength(getLump: (i: number) => Uint8Array, index: number): number {
  try {
    return getLump(index).length;
  } catch {
    return 0;
  }
}

function readGameLumps(
  bytes: Uint8Array,
  info: BspLumpInfo,
  valid: boolean,
  getLump: (i: number) => Uint8Array,
  warnings: string[],
): BspGameLump[] {
  const out: BspGameLump[] = [];
  if (!valid) return out;
  let dir: Uint8Array;
  try {
    dir = getLump(LUMP_GAME_LUMP);
  } catch (e) {
    warnings.push(`game lump directory: ${(e as Error).message}`);
    return out;
  }
  if (dir.length < 4) return out;
  const dirCompressed = dir.buffer !== bytes.buffer;
  const v = dataView(dir);
  let count = v.getInt32(0, true);
  const maxCount = Math.floor((dir.length - 4) / GAMELUMP_ENTRY_SIZE);
  if (count < 0 || count > maxCount) {
    warnings.push(`game lump count ${count} exceeds the directory size; clamped to ${maxCount}`);
    count = Math.max(0, Math.min(count, maxCount));
  }
  for (let i = 0; i < count; i++) {
    const o = 4 + i * GAMELUMP_ENTRY_SIZE;
    const idNum = v.getUint32(o, true);
    const flags = v.getUint16(o + 4, true);
    const version = v.getUint16(o + 6, true);
    const fileofs = v.getInt32(o + 8, true);
    const filelen = v.getInt32(o + 12, true);
    if (idNum === 0) continue; // CS:GO writes a terminating dummy entry
    const id = fourCCString(idNum);
    // Offsets are absolute in the file. Some console/repacked maps use offsets relative to the game lump.
    let src: Uint8Array | null = null;
    let start = fileofs;
    if (!dirCompressed && fileofs >= 0 && fileofs + Math.max(filelen, 0) <= bytes.length) src = bytes;
    else if (fileofs >= 0 && fileofs - info.offset >= 0 && fileofs - info.offset + filelen <= dir.length) {
      src = dir;
      start = fileofs - info.offset;
    } else if (fileofs >= 0 && fileofs + filelen <= dir.length) {
      src = dir;
      start = fileofs;
      warnings.push(`game lump ${id}: using lump-relative offset`);
    }
    if (!src) {
      warnings.push(`game lump ${id}: data out of range (offset ${fileofs}, length ${filelen})`);
      continue;
    }
    let data: Uint8Array = src.subarray(start, start + Math.max(filelen, 0));
    // CS:GO: individually LZMA-compressed game lumps (flag 1). The directory length may be the
    // uncompressed size, so the compressed extent comes from the LZMA header itself.
    const head = src.subarray(start, Math.min(src.length, start + 17));
    if (isSourceLzma(head)) {
      try {
        const lzmaSize = dataView(head).getUint32(8, true);
        const full = src.subarray(start, Math.min(src.length, start + 17 + lzmaSize));
        const actual = sourceLzmaActualSize(full);
        data = decodeSourceLzma(full);
        if (data.length !== actual) warnings.push(`game lump ${id}: LZMA output size mismatch`);
      } catch (e) {
        warnings.push(`game lump ${id}: ${(e as Error).message}`);
        continue;
      }
    } else if (flags & 1) {
      warnings.push(`game lump ${id}: flagged compressed but has no LZMA header`);
    }
    out.push({ id, flags, version, data });
  }
  return out;
}

/** Vertex indices (into bsp.vertices / 3) of a face's polygon, in surfedge order. */
export function faceVertexIndices(bsp: BspFile, faceIndex: number, out: number[] = []): number[] {
  out.length = 0;
  const f = bsp.faces[faceIndex];
  if (!f) return out;
  for (let i = 0; i < f.numEdges; i++) {
    const se = bsp.surfedges[f.firstEdge + i];
    out.push(se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1]);
  }
  return out;
}

/**
 * Checks counts and cross-references between lumps. Returns human-readable problems (empty when the file
 * is consistent). Counts per category are aggregated so a broken lump produces one line, not thousands.
 */
export function validateBsp(bsp: BspFile): string[] {
  const problems: string[] = [];
  const nVerts = Math.floor(bsp.vertices.length / 3);
  const nEdges = Math.floor(bsp.edges.length / 2);
  const nSurf = bsp.surfedges.length;
  const nPlanes = bsp.planes.length;
  const nFaces = bsp.faces.length;
  const nTexinfo = bsp.texinfo.length;
  const nTexdata = bsp.texdata.length;
  const nBrushes = bsp.brushes.length;
  const nSides = bsp.brushSides.length;
  const nNodes = bsp.nodes.length;
  const nLeafs = bsp.leafs.length;
  const nDisp = bsp.dispInfos.length;
  const report = (what: string, bad: number, total: number): void => {
    if (bad > 0) problems.push(`${bad}/${total} ${what}`);
  };

  if (nPlanes === 0) problems.push('no planes');
  if (bsp.models.length === 0) problems.push('no models');
  if (nNodes === 0) problems.push('no nodes');
  if (nLeafs === 0) problems.push('no leafs');

  let bad = 0;
  for (let i = 0; i < bsp.edges.length; i++) if (bsp.edges[i] >= nVerts) bad++;
  report('edge vertex indices out of range', bad, bsp.edges.length);

  bad = 0;
  for (let i = 0; i < nSurf; i++) {
    const se = bsp.surfedges[i];
    if ((se < 0 ? -se : se) >= nEdges) bad++;
  }
  report('surfedges out of range', bad, nSurf);

  let badPlane = 0;
  let badEdges = 0;
  let badTex = 0;
  let badDisp = 0;
  let fewEdges = 0;
  for (const f of bsp.faces) {
    if (f.planeNum >= nPlanes) badPlane++;
    if (f.firstEdge < 0 || f.numEdges < 0 || f.firstEdge + f.numEdges > nSurf) badEdges++;
    else if (f.numEdges < 3) fewEdges++;
    if (f.texInfo < -1 || f.texInfo >= nTexinfo) badTex++;
    if (f.dispInfo < -1 || f.dispInfo >= nDisp) badDisp++;
  }
  report('faces with bad plane index', badPlane, nFaces);
  report('faces with surfedge range out of bounds', badEdges, nFaces);
  report('faces with fewer than 3 edges', fewEdges, nFaces);
  report('faces with bad texinfo', badTex, nFaces);
  report('faces with bad dispinfo', badDisp, nFaces);

  bad = 0;
  for (const t of bsp.texinfo) if (t.texData < -1 || t.texData >= nTexdata) bad++;
  report('texinfos with bad texdata index', bad, nTexinfo);
  if (bsp.texdataNames.length !== nTexdata) problems.push('texdata name count mismatch');

  bad = 0;
  for (const b of bsp.brushes) if (b.firstSide < 0 || b.numSides < 0 || b.firstSide + b.numSides > nSides) bad++;
  report('brushes with side range out of bounds', bad, nBrushes);

  bad = 0;
  let badSideTex = 0;
  for (const s of bsp.brushSides) {
    if (s.planeNum >= nPlanes) bad++;
    if (s.texInfo < -1 || s.texInfo >= nTexinfo) badSideTex++;
  }
  report('brush sides with bad plane index', bad, nSides);
  report('brush sides with bad texinfo', badSideTex, nSides);

  bad = 0;
  let badChild = 0;
  let badNodeFaces = 0;
  for (const n of bsp.nodes) {
    if (n.planeNum < 0 || n.planeNum >= nPlanes) bad++;
    for (const c of n.children) {
      if (c >= 0 ? c >= nNodes : -(c + 1) >= nLeafs) badChild++;
    }
    if (n.firstFace + n.numFaces > nFaces) badNodeFaces++;
  }
  report('nodes with bad plane index', bad, nNodes);
  report('node children out of range', badChild, nNodes * 2);
  report('nodes with face range out of bounds', badNodeFaces, nNodes);

  let badLF = 0;
  let badLB = 0;
  for (const l of bsp.leafs) {
    if (l.firstLeafFace + l.numLeafFaces > bsp.leafFaces.length) badLF++;
    if (l.firstLeafBrush + l.numLeafBrushes > bsp.leafBrushes.length) badLB++;
  }
  report('leafs with leafface range out of bounds', badLF, nLeafs);
  report('leafs with leafbrush range out of bounds', badLB, nLeafs);

  bad = 0;
  for (let i = 0; i < bsp.leafFaces.length; i++) if (bsp.leafFaces[i] >= nFaces) bad++;
  report('leaffaces out of range', bad, bsp.leafFaces.length);
  bad = 0;
  for (let i = 0; i < bsp.leafBrushes.length; i++) if (bsp.leafBrushes[i] >= nBrushes) bad++;
  report('leafbrushes out of range', bad, bsp.leafBrushes.length);

  bad = 0;
  for (const m of bsp.models) {
    const h = m.headNode;
    const headOk = h >= 0 ? h < nNodes : -(h + 1) < nLeafs;
    if (!headOk || m.firstFace < 0 || m.numFaces < 0 || m.firstFace + m.numFaces > nFaces) bad++;
  }
  report('models with bad head node or face range', bad, bsp.models.length);

  bad = 0;
  for (const d of bsp.dispInfos) {
    const p = d.power;
    if (p < 1 || p > 4 || d.mapFace >= nFaces) {
      bad++;
      continue;
    }
    const side = (1 << p) + 1;
    if (d.dispVertStart < 0 || d.dispVertStart + side * side > bsp.dispVerts.length) bad++;
    else if (bsp.dispTris.length > 0 && (d.dispTriStart < 0 || d.dispTriStart + 2 * (1 << p) * (1 << p) > bsp.dispTris.length)) bad++;
  }
  report('displacements with bad power/face/vertex range', bad, nDisp);

  return problems;
}
