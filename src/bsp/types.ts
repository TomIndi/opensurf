// Parsed Source BSP (VBSP v19/v20/v21) structures. Produced by parseBsp() in ./reader.ts.
// Field names follow the public bspfile.h layout so the format documentation maps 1:1.
import { Vec3 } from '../core/vec3';

export const LUMP_ENTITIES = 0;
export const LUMP_PLANES = 1;
export const LUMP_TEXDATA = 2;
export const LUMP_VERTEXES = 3;
export const LUMP_VISIBILITY = 4;
export const LUMP_NODES = 5;
export const LUMP_TEXINFO = 6;
export const LUMP_FACES = 7;
export const LUMP_LIGHTING = 8;
export const LUMP_OCCLUSION = 9;
export const LUMP_LEAFS = 10;
export const LUMP_FACEIDS = 11;
export const LUMP_EDGES = 12;
export const LUMP_SURFEDGES = 13;
export const LUMP_MODELS = 14;
export const LUMP_WORLDLIGHTS = 15;
export const LUMP_LEAFFACES = 16;
export const LUMP_LEAFBRUSHES = 17;
export const LUMP_BRUSHES = 18;
export const LUMP_BRUSHSIDES = 19;
export const LUMP_AREAS = 20;
export const LUMP_AREAPORTALS = 21;
export const LUMP_DISPINFO = 26;
export const LUMP_ORIGINALFACES = 27;
export const LUMP_PHYSDISP = 28;
export const LUMP_PHYSCOLLIDE = 29;
export const LUMP_VERTNORMALS = 30;
export const LUMP_VERTNORMALINDICES = 31;
export const LUMP_DISP_LIGHTMAP_ALPHAS = 32;
export const LUMP_DISP_VERTS = 33;
export const LUMP_DISP_LIGHTMAP_SAMPLE_POSITIONS = 34;
export const LUMP_GAME_LUMP = 35;
export const LUMP_LEAFWATERDATA = 36;
export const LUMP_PRIMITIVES = 37;
export const LUMP_PRIMVERTS = 38;
export const LUMP_PRIMINDICES = 39;
export const LUMP_PAKFILE = 40;
export const LUMP_CLIPPORTALVERTS = 41;
export const LUMP_CUBEMAPS = 42;
export const LUMP_TEXDATA_STRING_DATA = 43;
export const LUMP_TEXDATA_STRING_TABLE = 44;
export const LUMP_OVERLAYS = 45;
export const LUMP_LEAFMINDISTTOWATER = 46;
export const LUMP_FACE_MACRO_TEXTURE_INFO = 47;
export const LUMP_DISP_TRIS = 48;
export const LUMP_LEAF_AMBIENT_INDEX_HDR = 51;
export const LUMP_LEAF_AMBIENT_INDEX = 52;
export const LUMP_LIGHTING_HDR = 53;
export const LUMP_WORLDLIGHTS_HDR = 54;
export const LUMP_LEAF_AMBIENT_LIGHTING_HDR = 55;
export const LUMP_LEAF_AMBIENT_LIGHTING = 56;
export const LUMP_FACES_HDR = 58;

// texinfo flags (SURF_*)
export const SURF_LIGHT = 0x0001;
export const SURF_SKY2D = 0x0002;
export const SURF_SKY = 0x0004;
export const SURF_WARP = 0x0008;
export const SURF_TRANS = 0x0010;
export const SURF_NOPORTAL = 0x0020;
export const SURF_TRIGGER = 0x0040;
export const SURF_NODRAW = 0x0080;
export const SURF_HINT = 0x0100;
export const SURF_SKIP = 0x0200;
export const SURF_NOLIGHT = 0x0400;
export const SURF_BUMPLIGHT = 0x0800;
export const SURF_NOSHADOWS = 0x1000;
export const SURF_NODECALS = 0x2000;
export const SURF_NOCHOP = 0x4000;
export const SURF_HITBOX = 0x8000;

export interface BspLumpInfo {
  offset: number;
  length: number;
  version: number;
  /** Uncompressed size for LZMA-compressed lumps (0 = not compressed). */
  fourCC: number;
}

export interface BspPlane {
  normal: Vec3;
  dist: number;
  type: number;
}

export interface BspFace {
  planeNum: number;
  side: number;
  onNode: number;
  firstEdge: number;
  numEdges: number;
  texInfo: number;
  dispInfo: number;
  surfaceFogVolumeID: number;
  styles: [number, number, number, number];
  /** Byte offset into the lighting lump, -1 if unlit. */
  lightOfs: number;
  area: number;
  lightmapTextureMinsInLuxels: [number, number];
  lightmapTextureSizeInLuxels: [number, number];
  origFace: number;
  numPrims: number;
  firstPrimID: number;
  smoothingGroups: number;
}

export interface BspTexInfo {
  /** [sx, sy, sz, soffset, tx, ty, tz, toffset] in texels. */
  textureVecs: Float32Array;
  /** [sx, sy, sz, soffset, tx, ty, tz, toffset] in luxels. */
  lightmapVecs: Float32Array;
  flags: number;
  texData: number;
}

export interface BspTexData {
  /** Average linear color of the texture, computed by vbsp — great fallback color. */
  reflectivity: Vec3;
  nameStringTableID: number;
  width: number;
  height: number;
  viewWidth: number;
  viewHeight: number;
}

export interface BspBrush {
  firstSide: number;
  numSides: number;
  contents: number;
}

export interface BspBrushSide {
  planeNum: number;
  texInfo: number;
  dispInfo: number;
  bevel: boolean;
  thin: boolean;
}

export interface BspNode {
  planeNum: number;
  /** Negative child = -(leafIndex + 1). */
  children: [number, number];
  mins: Vec3;
  maxs: Vec3;
  firstFace: number;
  numFaces: number;
  area: number;
}

export interface BspLeaf {
  contents: number;
  cluster: number;
  area: number;
  flags: number;
  mins: Vec3;
  maxs: Vec3;
  firstLeafFace: number;
  numLeafFaces: number;
  firstLeafBrush: number;
  numLeafBrushes: number;
  leafWaterDataID: number;
}

export interface BspModel {
  mins: Vec3;
  maxs: Vec3;
  origin: Vec3;
  headNode: number;
  firstFace: number;
  numFaces: number;
}

export interface BspDispInfo {
  startPosition: Vec3;
  dispVertStart: number;
  dispTriStart: number;
  power: number;
  /** In v21 (CS:GO) the high bit flags a "flags" field: DISPINFO_FLAG_NO_PHYSICS_COLL etc. */
  minTess: number;
  smoothingAngle: number;
  contents: number;
  mapFace: number;
  lightmapAlphaStart: number;
  lightmapSamplePositionStart: number;
}

export interface BspDispVert {
  vec: Vec3;
  dist: number;
  alpha: number;
}

export interface BspGameLump {
  /** FourCC as a string, e.g. "sprp" (static props), "dprp" (detail props). */
  id: string;
  flags: number;
  version: number;
  data: Uint8Array;
}

export interface BspFile {
  version: number;
  mapRevision: number;
  lumps: BspLumpInfo[];
  /** Returns the (LZMA-decompressed if needed) bytes of lump `index` (empty if absent). */
  getLump(index: number): Uint8Array;

  entitiesText: string;
  planes: BspPlane[];
  vertices: Float32Array; // xyz triples
  edges: Uint16Array; // v0,v1 pairs
  surfedges: Int32Array;
  faces: BspFace[]; // LDR faces; falls back to HDR faces lump if LDR is empty
  texinfo: BspTexInfo[];
  texdata: BspTexData[];
  /** Material names indexed by texdata index (resolved through the string table). */
  texdataNames: string[];
  brushes: BspBrush[];
  brushSides: BspBrushSide[];
  nodes: BspNode[];
  leafs: BspLeaf[];
  leafFaces: Uint16Array;
  leafBrushes: Uint16Array;
  models: BspModel[];
  /** LDR lighting lump (ColorRGBExp32 samples) or null. */
  lighting: Uint8Array | null;
  /** HDR lighting lump or null. */
  lightingHDR: Uint8Array | null;
  dispInfos: BspDispInfo[];
  dispVerts: BspDispVert[];
  dispTris: Uint16Array;
  /** Raw ZIP bytes of the embedded pakfile, or null. */
  pakfile: Uint8Array | null;
  gameLumps: BspGameLump[];
  /**
   * Which lump `faces` came from: LUMP_FACES (7), or LUMP_FACES_HDR (58) for HDR-only compiles. When it is
   * LUMP_FACES_HDR the faces' lightOfs index `lightingHDR`, not `lighting`. (Optional; set by parseBsp.)
   */
  facesLump?: number;
  /** Non-fatal problems found while parsing/validating (unknown version, bad lump sizes, bad indices). */
  warnings?: string[];
}
