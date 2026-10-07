// BSP faces -> render batches (positions, normals, texture uvs, lightmap atlas uvs) with baked lightmaps.
//
// Which faces are drawn: every face of the world model and of each brush model an entity uses (the engine
// never draws a brush model without an entity), except faces whose texinfo is SURF_NODRAW / SURF_SKIP /
// SURF_HINT / SURF_TRIGGER or whose material is a tool texture. Sky faces (SURF_SKY / SURF_SKY2D or a sky
// material) are kept in their own batches with SURF_SKY in surfFlags: the renderer draws them as depth-only
// masks where the skybox shows through.
//
// Coordinates: positions and normals are in world space. Brush entity faces are stored in model space in the
// BSP; they are placed like their entity places them (origin + angles, see bspcollision's
// brushEntityPlacement), exactly like the collision brushes, so what you see is what you collide with.
// Texture and lightmap coordinates are computed from the model-space positions (the texinfo is model-relative).
//
// Triangles are counter-clockwise seen from the front (three.js' default front face). Polygon faces are fan
// triangulated; displacements use their own grid (see displacement.ts).
//
// Batching: one batch per (model, material, area, lightmapped?, displacement?, sky?) and, for the world model,
// per 2048-unit XY cell of the face centroid, so the renderer can frustum-cull large maps per batch (groups
// with fewer than cellSplitMinTriangles triangles are not split: that would only add draw calls). Faces of
// lightmapped materials without usable light data (lightOfs -1) point at a fullbright white block of the
// atlas (a face vrad left without samples renders fullbright in the engine); unlit materials, SURF_NOLIGHT
// faces (water, %compilenolight materials) and sky faces have lightmapUVs = null.
// Maps compiled without lighting return lightmap = null and no lightmap uvs at all.
import { angleVectors } from '../core/angles';
import type { LightmapAtlas, MapEntity, MaterialDef, RenderBatch } from '../map/types';
import { brushEntityPlacement } from './bspcollision';
import { faceAreas, pointLeaf } from './bsptree';
import { DisplacementMesh, buildDisplacementMesh, smoothDisplacementSeams } from './displacement';
import { parseEntities } from './entities';
import {
  LightmapBuild,
  LightmapRequest,
  buildLightmapAtlas,
  faceLightmapOffset,
  lightmapUV,
  selectLightingSource,
} from './lightmap';
import { fallbackMaterial, normalizeMaterialName } from './materials';
import { BspFile, SURF_HINT, SURF_NODRAW, SURF_NOLIGHT, SURF_SKIP, SURF_SKY, SURF_SKY2D, SURF_TRIGGER } from './types';

export interface BuildRenderOptions {
  /** Entities used to find and place brush models (default: parsed from bsp.entitiesText). */
  entities?: MapEntity[];
  /** 'world' (default): brush entity faces placed by their entity; 'model': raw model-space positions. */
  space?: 'world' | 'model';
  /** XY cell size used to split world-model batches for culling (default 2048; 0 = no split). */
  cellSize?: number;
  /**
   * World-model groups (same material/area/lighting/kind) with fewer triangles than this stay one batch
   * instead of being split per cell: splitting them would only add draw calls (default 512).
   */
  cellSplitMinTriangles?: number;
  /** Smallest cell batch (triangles); smaller cells are pooled into 4x4 super cells or the remainder (default 128). */
  cellMinTriangles?: number;
  /** Largest lightmap atlas side (default 4096). See lightmap.ts for the overflow handling. */
  maxLightmapSize?: number;
  /** Also build brush models no entity references (default false: the engine never draws those). */
  includeUnreferencedModels?: boolean;
  /** Weld displacement normals across seams (default true). */
  smoothDisplacementSeams?: boolean;
  /** Receives non-fatal problems (malformed faces, missing materials). */
  warnings?: string[];
  /** Filled with counts for diagnostics. */
  stats?: RenderBuildStats;
  /**
   * Lighting lump choice: 'auto' (default) pairs LDR faces with the LDR lighting lump (HDR when the map only
   * has HDR lighting); 'hdr' uses the HDR lighting (through the HDR face lump's offsets) whenever present.
   */
  lighting?: 'auto' | 'hdr';
  /**
   * Called for every lightmapped face once the atlas is built, with its rect (top-left = border texel, size
   * including the 1-texel border) and the samples stored per row/column. For diagnostics and tests.
   */
  onFaceLightmap?: (face: number, x: number, y: number, w: number, h: number, samplesW: number, samplesH: number) => void;
}

export interface RenderBuildStats {
  /** Faces turned into geometry (polygons + displacements). */
  faces: number;
  /** Faces skipped as invisible (nodraw/skip/hint/trigger/tool). */
  invisible: number;
  /** Faces skipped because they are malformed. */
  malformed: number;
  skyFaces: number;
  displacements: number;
  litFaces: number;
  /** Lightmapped-material faces without light data (fullbright white block). */
  whiteFaces: number;
  /** Faces drawn without lightmap (unlit materials, sky, or no lighting in the map). */
  unlitFaces: number;
  batches: number;
  vertices: number;
  triangles: number;
  atlasWidth: number;
  atlasHeight: number;
  /** Lightmap density reduction (1 = full; see lightmap.ts overflow handling). */
  lightmapReduction: number;
}

const MODE_NONE = 0;
const MODE_LIT = 1;
const MODE_WHITE = 2;

const INVISIBLE_FLAGS = SURF_NODRAW | SURF_SKIP | SURF_HINT | SURF_TRIGGER;

interface Placement {
  /** Row-major 3x3 rotation (world = R * local + origin), or null for a pure translation. */
  rot: number[] | null;
  ox: number;
  oy: number;
  oz: number;
}

interface GroupInfo {
  model: number;
  material: string;
  area: number;
  mode: number;
  disp: boolean;
  tris: number;
}

interface BatchInfo {
  model: number;
  material: string;
  area: number;
  mode: number;
  disp: boolean;
  surfFlags: number;
  verts: number;
  idx: number;
}

/** Row-major rotation whose columns are Source's forward, left and up vectors (same as the collision code). */
function rotationMatrix(pitch: number, yaw: number, roll: number): number[] {
  const f = { x: 0, y: 0, z: 0 };
  const r = { x: 0, y: 0, z: 0 };
  const u = { x: 0, y: 0, z: 0 };
  angleVectors({ pitch, yaw, roll }, f, r, u);
  return [f.x, -r.x, u.x, f.y, -r.y, u.y, f.z, -r.z, u.z];
}

function finite3(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

/**
 * Builds the render batches and the lightmap atlas of a parsed BSP. `materials` is the map from
 * buildMaterials (keyed by normalized material name); names it lacks get a procedural fallback material added
 * to it, so every batch.material is a valid key. `areas` = faceAreas(bsp) (computed when omitted); brush
 * entity faces, which no leaf lists, get the area of the leaf in front of them.
 */
export function buildRenderBatches(
  bsp: BspFile,
  materials: Map<string, MaterialDef>,
  areas?: Int32Array,
  opts: BuildRenderOptions = {},
): { batches: RenderBatch[]; lightmap: LightmapAtlas | null } {
  const warn = (msg: string): void => {
    if (opts.warnings) opts.warnings.push(msg);
  };
  const space = opts.space ?? 'world';
  const cellSize = opts.cellSize ?? 2048;
  const splitMin = opts.cellSplitMinTriangles ?? 512;
  const cellMin = opts.cellMinTriangles ?? 128;
  const faces = bsp.faces;
  const nFaces = faces.length;
  const verts = bsp.vertices;
  const nVerts = Math.floor(verts.length / 3);
  const edges = bsp.edges;
  const surfedges = bsp.surfedges;

  let entities = opts.entities;
  if (!entities) {
    try {
      entities = parseEntities(bsp.entitiesText);
    } catch {
      entities = [];
    }
  }
  let faceArea = areas;
  if (!faceArea || faceArea.length !== nFaces) {
    try {
      faceArea = faceAreas(bsp);
    } catch {
      faceArea = new Int32Array(nFaces).fill(-1);
    }
  }

  // ---- materials per texdata
  const texMatName: string[] = [];
  const texMat: MaterialDef[] = [];
  let missingMaterials = 0;
  for (let i = 0; i < bsp.texdata.length; i++) {
    const name = normalizeMaterialName(bsp.texdataNames[i] ?? '') || `__texdata_${i}`;
    let m = materials.get(name);
    if (!m) {
      const td = bsp.texdata[i];
      m = fallbackMaterial(name, td?.reflectivity, td?.width, td?.height);
      materials.set(name, m);
      missingMaterials++;
    }
    texMatName.push(name);
    texMat.push(m);
  }
  if (missingMaterials) warn(`${missingMaterials} materials were missing from the material set; procedural fallbacks used`);

  // ---- models to draw and their placement
  const placement = new Map<number, Placement>();
  placement.set(0, { rot: null, ox: 0, oy: 0, oz: 0 });
  for (const e of entities) {
    if (e.model <= 0 || e.model >= bsp.models.length || placement.has(e.model)) continue;
    if (space === 'model') {
      placement.set(e.model, { rot: null, ox: 0, oy: 0, oz: 0 });
      continue;
    }
    const p = brushEntityPlacement(e);
    const rotated = p.angles.pitch !== 0 || p.angles.yaw !== 0 || p.angles.roll !== 0;
    const ok = finite3(p.origin.x, p.origin.y, p.origin.z) && finite3(p.angles.pitch, p.angles.yaw, p.angles.roll);
    placement.set(e.model, {
      rot: rotated && ok ? rotationMatrix(p.angles.pitch, p.angles.yaw, p.angles.roll) : null,
      ox: ok ? p.origin.x : 0,
      oy: ok ? p.origin.y : 0,
      oz: ok ? p.origin.z : 0,
    });
  }
  if (opts.includeUnreferencedModels) {
    for (let m = 1; m < bsp.models.length; m++) if (!placement.has(m)) placement.set(m, { rot: null, ox: 0, oy: 0, oz: 0 });
  }
  const modelList = [...placement.keys()].sort((a, b) => a - b);

  // ---- lighting
  const light = selectLightingSource(bsp, opts.lighting === 'hdr');

  // ---- displacement meshes (all at once, so seams can be welded)
  const dispMeshes: (DisplacementMesh | null)[] = new Array(bsp.dispInfos.length).fill(null);
  {
    const built: DisplacementMesh[] = [];
    const world = bsp.models[0];
    const wFirst = world ? world.firstFace : 0;
    const wEnd = world ? world.firstFace + world.numFaces : 0;
    let malformed = 0;
    for (let di = 0; di < bsp.dispInfos.length; di++) {
      const mf = bsp.dispInfos[di].mapFace;
      if (!(mf >= wFirst && mf < wEnd) || faces[mf]?.dispInfo !== di) continue; // unreferenced / not world
      let m: DisplacementMesh | null = null;
      try {
        m = buildDisplacementMesh(bsp, di);
      } catch {
        m = null;
      }
      if (m) {
        dispMeshes[di] = m;
        built.push(m);
      } else malformed++;
    }
    if (malformed) warn(`${malformed} displacements are malformed and are not drawn`);
    if (opts.smoothDisplacementSeams !== false) smoothDisplacementSeams(built);
  }

  // ---- pass 1: classify faces, assign batches, collect lightmap requests
  const recFace: number[] = [];
  const recModel: number[] = [];
  const recGroup: number[] = [];
  const recCellX: number[] = [];
  const recCellY: number[] = [];
  const recFlags: number[] = [];
  const recVerts: number[] = [];
  const recIdx: number[] = [];
  const recMode: number[] = [];
  const recReq: number[] = [];
  const requests: LightmapRequest[] = [];
  const groupIndex = new Map<string, number>();
  const groups: GroupInfo[] = [];
  const infos: BatchInfo[] = [];
  const stats: RenderBuildStats = {
    faces: 0,
    invisible: 0,
    malformed: 0,
    skyFaces: 0,
    displacements: 0,
    litFaces: 0,
    whiteFaces: 0,
    unlitFaces: 0,
    batches: 0,
    vertices: 0,
    triangles: 0,
    atlasWidth: 0,
    atlasHeight: 0,
    lightmapReduction: 1,
  };

  for (const model of modelList) {
    const bm = bsp.models[model];
    if (!bm) continue;
    const pl = placement.get(model)!;
    const first = Math.max(0, bm.firstFace);
    const end = Math.min(nFaces, bm.firstFace + bm.numFaces);
    for (let f = first; f < end; f++) {
      const face = faces[f];
      const ti = bsp.texinfo[face.texInfo];
      if (!ti) {
        stats.malformed++;
        continue;
      }
      const flags = ti.flags;
      const mat = texMat[ti.texData];
      if (!mat) {
        stats.malformed++;
        continue;
      }
      const sky = (flags & (SURF_SKY | SURF_SKY2D)) !== 0 || mat.isSky;
      if (!sky && ((flags & INVISIBLE_FLAGS) !== 0 || mat.isTool)) {
        stats.invisible++;
        continue;
      }
      const plane = bsp.planes[face.planeNum];
      if (!plane) {
        stats.malformed++;
        continue;
      }
      const isDisp = face.dispInfo >= 0;
      let nv: number;
      let ni: number;
      if (isDisp) {
        const mesh = model === 0 ? dispMeshes[face.dispInfo] : null;
        if (!mesh) {
          stats.malformed++;
          continue;
        }
        nv = mesh.size * mesh.size;
        ni = mesh.indices.length;
      } else {
        if (face.numEdges < 3 || face.firstEdge < 0 || face.firstEdge + face.numEdges > surfedges.length) {
          stats.malformed++;
          continue;
        }
        nv = face.numEdges;
        ni = (face.numEdges - 2) * 3;
      }
      // centroid (model space) + vertex index validation
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let bad = false;
      if (!isDisp) {
        for (let k = 0; k < face.numEdges; k++) {
          const se = surfedges[face.firstEdge + k];
          const e = se >= 0 ? se : -se;
          const vi = se >= 0 ? edges[e * 2] : edges[e * 2 + 1];
          if (vi === undefined || vi >= nVerts) {
            bad = true;
            break;
          }
          cx += verts[vi * 3];
          cy += verts[vi * 3 + 1];
          cz += verts[vi * 3 + 2];
        }
        if (bad) {
          stats.malformed++;
          continue;
        }
        cx /= face.numEdges;
        cy /= face.numEdges;
        cz /= face.numEdges;
      } else {
        const b = dispMeshes[face.dispInfo]!.base;
        const n = b.length / 3;
        for (let k = 0; k < b.length; k += 3) {
          cx += b[k];
          cy += b[k + 1];
          cz += b[k + 2];
        }
        cx /= n;
        cy /= n;
        cz /= n;
      }
      // world-space centroid
      const sign = face.side ? -1 : 1;
      let nx = plane.normal.x * sign;
      let ny = plane.normal.y * sign;
      let nz = plane.normal.z * sign;
      if (pl.rot) {
        const R = pl.rot;
        const x = R[0] * cx + R[1] * cy + R[2] * cz;
        const y = R[3] * cx + R[4] * cy + R[5] * cz;
        const z = R[6] * cx + R[7] * cy + R[8] * cz;
        cx = x;
        cy = y;
        cz = z;
        const tx = R[0] * nx + R[1] * ny + R[2] * nz;
        const ty = R[3] * nx + R[4] * ny + R[5] * nz;
        const tz = R[6] * nx + R[7] * ny + R[8] * nz;
        nx = tx;
        ny = ty;
        nz = tz;
      }
      cx += pl.ox;
      cy += pl.oy;
      cz += pl.oz;

      // area: from the leaves that list the face (faceAreas). Brush entity faces are only listed by the leaves
      // of their own model subtree (area 0, meaningless), so they take the area of the world leaf just in
      // front of them (-1 when that is solid).
      let area = faceArea[f] ?? -1;
      if (model > 0) {
        area = -1;
        if (space === 'world') {
          const leaf = pointLeaf(bsp, { x: cx + nx * 2, y: cy + ny * 2, z: cz + nz * 2 });
          const l = leaf >= 0 ? bsp.leafs[leaf] : undefined;
          if (l && !(l.contents & 1)) area = l.area;
        }
      }

      // lighting mode: lightmapped materials use their face lightmap, or the fullbright white block when the
      // face has no light data; unlit materials, SURF_NOLIGHT faces (water, %compilenolight) and sky: none
      let mode = MODE_NONE;
      let req = -1;
      if (light && !sky && !mat.unlit && !(flags & SURF_NOLIGHT)) {
        const ofs = faceLightmapOffset(light, bsp, f, flags);
        if (ofs >= 0) {
          mode = MODE_LIT;
          req = requests.length;
          requests.push({
            offset: ofs,
            w: face.lightmapTextureSizeInLuxels[0] + 1,
            h: face.lightmapTextureSizeInLuxels[1] + 1,
          });
        } else mode = MODE_WHITE;
      }

      const lit = mode !== MODE_NONE;
      const matName = texMatName[ti.texData];
      const key = `${model}|${matName}|${area}|${lit ? 1 : 0}|${isDisp ? 1 : 0}|${sky ? 1 : 0}`;
      let gi = groupIndex.get(key);
      if (gi === undefined) {
        gi = groups.length;
        groupIndex.set(key, gi);
        groups.push({ model, material: matName, area, mode, disp: isDisp, tris: 0 });
      }
      groups[gi].tris += ni / 3;

      recFace.push(f);
      recModel.push(model);
      recGroup.push(gi);
      recCellX.push(cellSize > 0 ? Math.floor(cx / cellSize) : 0);
      recCellY.push(cellSize > 0 ? Math.floor(cy / cellSize) : 0);
      recFlags.push(flags | (sky ? SURF_SKY : 0));
      recVerts.push(nv);
      recIdx.push(ni);
      recMode.push(mode);
      recReq.push(req);
      stats.faces++;
      if (sky) stats.skyFaces++;
      if (isDisp) stats.displacements++;
      if (mode === MODE_LIT) stats.litFaces++;
      else if (mode === MODE_WHITE) stats.whiteFaces++;
      else stats.unlitFaces++;
    }
  }

  // ---- batches: world-model groups big enough to matter are split by XY cell for culling. Cells with fewer
  // than cellMinTriangles triangles are pooled into 4x4-cell super cells, and what is still too small stays in
  // one remainder batch per group (tiny batches would only add draw calls).
  const recBatch = new Int32Array(recFace.length);
  {
    const split = (gi: number): boolean => cellSize > 0 && groups[gi].model === 0 && groups[gi].tris >= splitMin;
    const key0 = (r: number): string => `${recGroup[r]}|${recCellX[r]},${recCellY[r]}`;
    const key1 = (r: number): string => `${recGroup[r]}|${Math.floor(recCellX[r] / 4)},${Math.floor(recCellY[r] / 4)}`;
    const tris0 = new Map<string, number>();
    const tris1 = new Map<string, number>();
    for (let r = 0; r < recFace.length; r++) {
      if (!split(recGroup[r])) continue;
      const k = key0(r);
      tris0.set(k, (tris0.get(k) ?? 0) + recIdx[r] / 3);
    }
    for (let r = 0; r < recFace.length; r++) {
      if (!split(recGroup[r]) || tris0.get(key0(r))! >= cellMin) continue;
      const k = key1(r);
      tris1.set(k, (tris1.get(k) ?? 0) + recIdx[r] / 3);
    }
    const batchOf = new Map<string, number>();
    for (let r = 0; r < recFace.length; r++) {
      const gi = recGroup[r];
      let key = `${gi}`;
      if (split(gi)) {
        const k0 = key0(r);
        if (tris0.get(k0)! >= cellMin) key = `a${k0}`;
        else {
          const k1 = key1(r);
          if (tris1.get(k1)! >= cellMin) key = `b${k1}`;
        }
      }
      let bi = batchOf.get(key);
      if (bi === undefined) {
        const g = groups[gi];
        bi = infos.length;
        batchOf.set(key, bi);
        infos.push({ model: g.model, material: g.material, area: g.area, mode: g.mode, disp: g.disp, surfFlags: 0, verts: 0, idx: 0 });
      }
      recBatch[r] = bi;
      const info = infos[bi];
      info.surfFlags |= recFlags[r];
      info.verts += recVerts[r];
      info.idx += recIdx[r];
    }
  }

  // ---- lightmap atlas
  let lm: LightmapBuild | null = null;
  if (light) {
    lm = buildLightmapAtlas(light.data, requests, opts.maxLightmapSize ?? 4096);
    if (!lm) warn('lightmaps do not fit into the atlas; drawing the map fullbright');
    else {
      stats.atlasWidth = lm.atlas.width;
      stats.atlasHeight = lm.atlas.height;
      stats.lightmapReduction = lm.reduction;
      if (lm.reduction > 1) warn(`lightmap atlas overflow: lightmaps stored at 1/${lm.reduction} density`);
      if (opts.onFaceLightmap) {
        for (let r = 0; r < recFace.length; r++) {
          const q = recReq[r];
          if (q < 0) continue;
          opts.onFaceLightmap(recFace[r], lm.rectX[q], lm.rectY[q], lm.atlasW[q] + 2, lm.atlasH[q] + 2, lm.atlasW[q], lm.atlasH[q]);
        }
      }
    }
  }

  // ---- allocate batches
  const batches: RenderBatch[] = infos.map((b) => ({
    model: b.model,
    material: b.material,
    positions: new Float32Array(b.verts * 3),
    normals: new Float32Array(b.verts * 3),
    uvs: new Float32Array(b.verts * 2),
    lightmapUVs: lm && b.mode !== MODE_NONE ? new Float32Array(b.verts * 2) : null,
    alphas: b.disp ? new Float32Array(b.verts) : null,
    indices: new Uint32Array(b.idx),
    surfFlags: b.surfFlags,
    area: b.area,
    isDisplacement: b.disp,
    mins: { x: Infinity, y: Infinity, z: Infinity },
    maxs: { x: -Infinity, y: -Infinity, z: -Infinity },
  }));
  const vCursor = new Int32Array(batches.length);
  const iCursor = new Int32Array(batches.length);

  // ---- pass 2: fill
  const polyX: number[] = [];
  const polyY: number[] = [];
  const polyZ: number[] = [];
  for (let r = 0; r < recFace.length; r++) {
    const f = recFace[r];
    const face = faces[f];
    const pl = placement.get(recModel[r])!;
    const R = pl.rot;
    const batch = batches[recBatch[r]];
    const mode = lm ? recMode[r] : MODE_NONE;
    const req = recReq[r];
    const ti = bsp.texinfo[face.texInfo];
    const td = bsp.texdata[ti.texData];
    const mat = texMat[ti.texData];
    const tw = td && td.width > 0 ? td.width : mat.width > 0 ? mat.width : 1;
    const th = td && td.height > 0 ? td.height : mat.height > 0 ? mat.height : 1;
    const tv = ti.textureVecs;
    const lv = ti.lightmapVecs;
    const lmMinS = face.lightmapTextureMinsInLuxels[0];
    const lmMinT = face.lightmapTextureMinsInLuxels[1];
    const lmW = face.lightmapTextureSizeInLuxels[0] + 1;
    const lmH = face.lightmapTextureSizeInLuxels[1] + 1;
    const plane = bsp.planes[face.planeNum];
    const sign = face.side ? -1 : 1;
    const fnx = plane.normal.x * sign;
    const fny = plane.normal.y * sign;
    const fnz = plane.normal.z * sign;

    const P = batch.positions;
    const N = batch.normals;
    const UV = batch.uvs;
    const LM = batch.lightmapUVs;
    const I = batch.indices;
    const bi = recBatch[r];
    const v0 = vCursor[bi];
    let ic = iCursor[bi];
    const mins = batch.mins;
    const maxs = batch.maxs;

    const emitVertex = (k: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, bx: number, by: number, bz: number, ls: number, lt: number): void => {
      // texture coordinates from the (undisplaced) model-space position
      UV[k * 2] = (bx * tv[0] + by * tv[1] + bz * tv[2] + tv[3]) / tw;
      UV[k * 2 + 1] = (bx * tv[4] + by * tv[5] + bz * tv[6] + tv[7]) / th;
      if (LM) {
        if (mode === MODE_LIT) lightmapUV(lm!, req, lmW, lmH, ls, lt, LM, k * 2);
        else {
          LM[k * 2] = lm!.whiteU;
          LM[k * 2 + 1] = lm!.whiteV;
        }
      }
      let wx = x;
      let wy = y;
      let wz = z;
      if (R) {
        wx = R[0] * x + R[1] * y + R[2] * z;
        wy = R[3] * x + R[4] * y + R[5] * z;
        wz = R[6] * x + R[7] * y + R[8] * z;
        const tnx = R[0] * nx + R[1] * ny + R[2] * nz;
        const tny = R[3] * nx + R[4] * ny + R[5] * nz;
        const tnz = R[6] * nx + R[7] * ny + R[8] * nz;
        nx = tnx;
        ny = tny;
        nz = tnz;
      }
      wx += pl.ox;
      wy += pl.oy;
      wz += pl.oz;
      P[k * 3] = wx;
      P[k * 3 + 1] = wy;
      P[k * 3 + 2] = wz;
      N[k * 3] = nx;
      N[k * 3 + 1] = ny;
      N[k * 3 + 2] = nz;
      const fx = P[k * 3];
      const fy = P[k * 3 + 1];
      const fz = P[k * 3 + 2];
      if (fx < mins.x) mins.x = fx;
      if (fx > maxs.x) maxs.x = fx;
      if (fy < mins.y) mins.y = fy;
      if (fy > maxs.y) maxs.y = fy;
      if (fz < mins.z) mins.z = fz;
      if (fz > maxs.z) maxs.z = fz;
    };

    if (face.dispInfo >= 0) {
      const mesh = dispMeshes[face.dispInfo]!;
      const n = mesh.size;
      const MP = mesh.positions;
      const MB = mesh.base;
      const MN = mesh.normals;
      const inv = 1 / (n - 1);
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          const k = row * n + col;
          const o = k * 3;
          emitVertex(
            v0 + k,
            MP[o], MP[o + 1], MP[o + 2],
            MN[o], MN[o + 1], MN[o + 2],
            MB[o], MB[o + 1], MB[o + 2],
            col * inv * (lmW - 1),
            row * inv * (lmH - 1),
          );
        }
      }
      batch.alphas!.set(mesh.alphas, v0);
      const MI = mesh.indices;
      for (let k = 0; k < MI.length; k++) I[ic++] = v0 + MI[k];
      vCursor[bi] = v0 + n * n;
      iCursor[bi] = ic;
      continue;
    }

    // polygon
    const ne = face.numEdges;
    polyX.length = polyY.length = polyZ.length = 0;
    for (let k = 0; k < ne; k++) {
      const se = surfedges[face.firstEdge + k];
      const vi = se >= 0 ? edges[se * 2] : edges[-se * 2 + 1];
      polyX.push(verts[vi * 3]);
      polyY.push(verts[vi * 3 + 1]);
      polyZ.push(verts[vi * 3 + 2]);
    }
    // Newell normal of the polygon as stored; reverse when it opposes the face normal so triangles end up
    // counter-clockwise seen from the front (vbsp stores faces clockwise).
    let qx = 0;
    let qy = 0;
    let qz = 0;
    for (let k = 0; k < ne; k++) {
      const j = k + 1 === ne ? 0 : k + 1;
      qx += (polyY[k] - polyY[j]) * (polyZ[k] + polyZ[j]);
      qy += (polyZ[k] - polyZ[j]) * (polyX[k] + polyX[j]);
      qz += (polyX[k] - polyX[j]) * (polyY[k] + polyY[j]);
    }
    const reverse = qx * fnx + qy * fny + qz * fnz < 0;
    for (let k = 0; k < ne; k++) {
      const x = polyX[k];
      const y = polyY[k];
      const z = polyZ[k];
      const ls = x * lv[0] + y * lv[1] + z * lv[2] + lv[3] - lmMinS;
      const lt = x * lv[4] + y * lv[5] + z * lv[6] + lv[7] - lmMinT;
      emitVertex(v0 + k, x, y, z, fnx, fny, fnz, x, y, z, ls, lt);
    }
    for (let k = 1; k + 1 < ne; k++) {
      I[ic++] = v0;
      if (reverse) {
        I[ic++] = v0 + k + 1;
        I[ic++] = v0 + k;
      } else {
        I[ic++] = v0 + k;
        I[ic++] = v0 + k + 1;
      }
    }
    vCursor[bi] = v0 + ne;
    iCursor[bi] = ic;
  }

  for (const b of batches) {
    stats.vertices += b.positions.length / 3;
    stats.triangles += b.indices.length / 3;
  }
  stats.batches = batches.length;
  if (stats.malformed) warn(`${stats.malformed} malformed faces skipped`);
  if (opts.stats) Object.assign(opts.stats, stats);
  return { batches, lightmap: lm ? lm.atlas : null };
}
