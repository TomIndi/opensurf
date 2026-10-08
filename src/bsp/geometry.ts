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
import type { Vec3 } from '../core/vec3';
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
import { fallbackMaterial, isProceduralImage, normalizeMaterialName } from './materials';
import { BspFile, LUMP_OVERLAYS, SURF_HINT, SURF_NODRAW, SURF_NOLIGHT, SURF_SKIP, SURF_SKY, SURF_SKY2D, SURF_TRIGGER } from './types';

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
  /** Build info_overlay decals (LUMP_OVERLAYS) as `decal` batches (default true). */
  overlays?: boolean;
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
  /** info_overlays turned into geometry / overlay fragments (one per overlay and face it covers). */
  overlays: number;
  overlayFragments: number;
  /** Overlays skipped because their material isn't available (not packed) or is a tool texture. */
  overlaysSkipped: number;
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
    overlays: 0,
    overlayFragments: 0,
    overlaysSkipped: 0,
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
      const sign = 1; // planes[planeNum] already faces the front: vbsp sets side = planeNum & 1 (planes come in negated pairs)
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
    const sign = 1; // planes[planeNum] already faces the front: vbsp sets side = planeNum & 1 (planes come in negated pairs)
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

  // ---- overlays (info_overlay decals projected onto world faces)
  if (opts.overlays !== false) {
    const faceReq = new Int32Array(nFaces).fill(-1);
    const faceMode = new Int8Array(nFaces).fill(-1);
    for (let r = 0; r < recFace.length; r++) {
      if (recModel[r] !== 0) continue;
      faceReq[recFace[r]] = recReq[r];
      faceMode[recFace[r]] = recMode[r];
    }
    let overlayBatches: RenderBatch[] = [];
    try {
      overlayBatches = buildOverlayBatches(bsp, {
        texMat,
        texMatName,
        dispMeshes,
        lm,
        faceReq,
        faceMode,
        faceArea,
        stats,
      });
    } catch (e) {
      warn(`overlays: ${(e as Error).message}`);
    }
    for (const b of overlayBatches) batches.push(b);
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

// ============================================================================================ overlays

/** One info_overlay as compiled into LUMP_OVERLAYS (doverlay_t, 352 bytes). */
export interface BspOverlay {
  id: number;
  texInfo: number;
  /** Faces the overlay was projected onto (world faces). */
  faces: number[];
  /** 0..3: overlays draw in this order on a surface. */
  renderOrder: number;
  /** Texture coordinate ranges: corners 0..3 get (u0,v0) (u0,v1) (u1,v1) (u1,v0). */
  u: [number, number];
  v: [number, number];
  /** Corner positions in the overlay basis (x along basisU, y along basisV). */
  points: [number, number][];
  origin: Vec3;
  basisU: Vec3;
  basisV: Vec3;
  normal: Vec3;
}

const OVERLAY_SIZE = 352;
const OVERLAY_MAX_FACES = 64;
/** How far overlay geometry is lifted off its surface (the renderer should add a depth bias as well). */
export const OVERLAY_LIFT = 0.25;

/**
 * Parses LUMP_OVERLAYS. The basis U vector is packed into the z components of the first three UV points, the
 * fourth point's z flags a flipped V axis; V = normal x U (negated when flipped).
 */
export function parseOverlays(bsp: BspFile): BspOverlay[] {
  let d: Uint8Array;
  try {
    d = bsp.getLump(LUMP_OVERLAYS);
  } catch {
    return [];
  }
  const out: BspOverlay[] = [];
  if (!d.length || d.length % OVERLAY_SIZE !== 0) return out;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let o = 0; o + OVERLAY_SIZE <= d.length; o += OVERLAY_SIZE) {
    const f = (k: number) => dv.getFloat32(o + k, true);
    const fc = dv.getUint16(o + 6, true);
    const count = Math.min(fc & 0x3fff, OVERLAY_MAX_FACES);
    const faces: number[] = [];
    for (let k = 0; k < count; k++) faces.push(dv.getInt32(o + 8 + k * 4, true));
    const points: [number, number][] = [];
    const z: number[] = [];
    for (let k = 0; k < 4; k++) {
      points.push([f(280 + k * 12), f(284 + k * 12)]);
      z.push(f(288 + k * 12));
    }
    const normal = { x: f(340), y: f(344), z: f(348) };
    const basisU = { x: z[0], y: z[1], z: z[2] };
    const flip = z[3] === 1 ? -1 : 1;
    const basisV = {
      x: (normal.y * basisU.z - normal.z * basisU.y) * flip,
      y: (normal.z * basisU.x - normal.x * basisU.z) * flip,
      z: (normal.x * basisU.y - normal.y * basisU.x) * flip,
    };
    out.push({
      id: dv.getInt32(o, true),
      texInfo: dv.getInt16(o + 4, true),
      faces,
      renderOrder: fc >> 14,
      u: [f(264), f(268)],
      v: [f(272), f(276)],
      points,
      origin: { x: f(328), y: f(332), z: f(336) },
      basisU,
      basisV,
      normal,
    });
  }
  return out;
}

/**
 * Inverse bilinear mapping: (a, b) such that X = bilerp(P0..P3) with P0 at (0,0), P1 at (0,1), P2 at (1,1) and
 * P3 at (1,0). Exact for parallelograms; solves the quadratic for general quads.
 */
export function inverseBilinear(px: number[], py: number[], x: number, y: number): [number, number] {
  // X = A + a*e + b*f + a*b*g with A = P0, e = P3 - P0, f = P1 - P0, g = P0 - P3 + P2 - P1
  const ex = px[3] - px[0];
  const ey = py[3] - py[0];
  const fx = px[1] - px[0];
  const fy = py[1] - py[0];
  const gx = px[0] - px[3] + px[2] - px[1];
  const gy = py[0] - py[3] + py[2] - py[1];
  const hx = x - px[0];
  const hy = y - py[0];
  const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  const k2 = cross(gx, gy, fx, fy);
  const k1 = cross(ex, ey, fx, fy) + cross(hx, hy, gx, gy);
  const k0 = cross(hx, hy, ex, ey);
  const scale = Math.abs(cross(ex, ey, fx, fy)) + 1e-12;
  let b: number;
  if (Math.abs(k2) < 1e-9 * scale) {
    b = Math.abs(k1) > 1e-12 ? -k0 / k1 : 0;
  } else {
    const disc = Math.max(0, k1 * k1 - 4 * k0 * k2);
    const sq = Math.sqrt(disc);
    const b1 = (-k1 - sq) / (2 * k2);
    const b2 = (-k1 + sq) / (2 * k2);
    b = Math.abs(b1 - 0.5) <= Math.abs(b2 - 0.5) ? b1 : b2;
  }
  const denx = ex + gx * b;
  const deny = ey + gy * b;
  const a = Math.abs(denx) >= Math.abs(deny) ? (Math.abs(denx) > 1e-12 ? (hx - fx * b) / denx : 0) : (hy - fy * b) / deny;
  return [a, b];
}

/** Sutherland-Hodgman clip of polygon (xs, ys) against the convex polygon (cx, cy). */
function clipConvex(xs: number[], ys: number[], cx: number[], cy: number[]): { x: number[]; y: number[] } {
  let area = 0;
  for (let i = 0; i < cx.length; i++) {
    const j = (i + 1) % cx.length;
    area += cx[i] * cy[j] - cx[j] * cy[i];
  }
  const sign = area >= 0 ? 1 : -1;
  let inX = xs;
  let inY = ys;
  for (let i = 0; i < cx.length && inX.length; i++) {
    const j = (i + 1) % cx.length;
    const ax = cx[i];
    const ay = cy[i];
    const dx = cx[j] - ax;
    const dy = cy[j] - ay;
    if (dx === 0 && dy === 0) continue;
    const side = (x: number, y: number) => sign * (dx * (y - ay) - dy * (x - ax));
    const outX: number[] = [];
    const outY: number[] = [];
    for (let k = 0; k < inX.length; k++) {
      const l = (k + 1) % inX.length;
      const s0 = side(inX[k], inY[k]);
      const s1 = side(inX[l], inY[l]);
      if (s0 >= 0) {
        outX.push(inX[k]);
        outY.push(inY[k]);
      }
      if ((s0 >= 0) !== (s1 >= 0)) {
        const t = s0 / (s0 - s1);
        outX.push(inX[k] + (inX[l] - inX[k]) * t);
        outY.push(inY[k] + (inY[l] - inY[k]) * t);
      }
    }
    inX = outX;
    inY = outY;
  }
  return { x: inX, y: inY };
}

interface OverlayContext {
  texMat: MaterialDef[];
  texMatName: string[];
  dispMeshes: (DisplacementMesh | null)[];
  lm: LightmapBuild | null;
  faceReq: Int32Array;
  faceMode: Int8Array;
  faceArea: Int32Array;
  stats: RenderBuildStats;
}

interface OverlayAcc {
  material: string;
  area: number;
  lit: boolean;
  order: number;
  surfFlags: number;
  pos: number[];
  nrm: number[];
  uv: number[];
  lmuv: number[];
  idx: number[];
}

/**
 * Overlay fragments: the overlay quad (in its own basis) is clipped against each face it lists - projected
 * into the overlay plane - and the pieces are put back onto the face plane along the overlay normal (onto
 * every triangle for displacement faces). Texture coordinates come from the inverse bilinear position inside
 * the quad; lightmap coordinates from the face underneath, so overlays are lit like the surface they lie on.
 */
function buildOverlayBatches(bsp: BspFile, ctx: OverlayContext): RenderBatch[] {
  const overlays = parseOverlays(bsp);
  if (!overlays.length) return [];
  const world = bsp.models[0];
  if (!world) return [];
  const wFirst = world.firstFace;
  const wEnd = world.firstFace + world.numFaces;
  const accs = new Map<string, OverlayAcc>();
  const lm = ctx.lm;
  const lmOut = new Float32Array(2);

  for (const ov of overlays) {
    const ti = bsp.texinfo[ov.texInfo];
    const mat = ti ? ctx.texMat[ti.texData] : undefined;
    // decals without their real texture (stock content that isn't packed) would draw an opaque stand-in quad
    if (!ti || !mat || mat.isTool || mat.isSky || !mat.image || isProceduralImage(mat.image)) {
      ctx.stats.overlaysSkipped++;
      continue;
    }
    const matName = ctx.texMatName[ti.texData];
    const U = ov.basisU;
    const V = ov.basisV;
    const N = ov.normal;
    const O = ov.origin;
    const qx = ov.points.map((p) => p[0]);
    const qy = ov.points.map((p) => p[1]);
    let fragments = 0;

    for (const f of ov.faces) {
      if (!(f >= wFirst && f < wEnd)) continue;
      const face = bsp.faces[f];
      const plane = face ? bsp.planes[face.planeNum] : undefined;
      if (!face || !plane) continue;
      const sign = 1; // planes[planeNum] already faces the front: vbsp sets side = planeNum & 1 (planes come in negated pairs)
      const fnx = plane.normal.x * sign;
      const fny = plane.normal.y * sign;
      const fnz = plane.normal.z * sign;
      const mode = ctx.faceMode[f];
      const lit = !!lm && !mat.unlit;
      const key = `${matName}|${ctx.faceArea[f] ?? -1}|${lit ? 1 : 0}|${ov.renderOrder}`;
      let acc = accs.get(key);
      if (!acc) {
        acc = { material: matName, area: ctx.faceArea[f] ?? -1, lit, order: ov.renderOrder, surfFlags: 0, pos: [], nrm: [], uv: [], lmuv: [], idx: [] };
        accs.set(key, acc);
      }
      const A = acc;
      const fti = bsp.texinfo[face.texInfo];
      const lv = fti ? fti.lightmapVecs : null;
      const lmW = face.lightmapTextureSizeInLuxels[0] + 1;
      const lmH = face.lightmapTextureSizeInLuxels[1] + 1;

      /** Emits one clipped polygon lying on the plane (pnx, pny, pnz) . x = pd; luxel(x) gives its lightmap coords. */
      const emit = (
        px: number[],
        py: number[],
        pnx: number,
        pny: number,
        pnz: number,
        pd: number,
        normalAt: (x: number, y: number, z: number) => [number, number, number],
        luxel: (x: number, y: number, z: number) => [number, number] | null,
      ): void => {
        const denom = pnx * N.x + pny * N.y + pnz * N.z;
        if (Math.abs(denom) < 0.01) return;
        const base = A.pos.length / 3;
        for (let k = 0; k < px.length; k++) {
          const u = px[k];
          const v = py[k];
          // point on the overlay plane, then along the overlay normal onto the surface
          const ox = O.x + U.x * u + V.x * v;
          const oy = O.y + U.y * u + V.y * v;
          const oz = O.z + U.z * u + V.z * v;
          const t = (pd - (pnx * ox + pny * oy + pnz * oz)) / denom;
          const x = ox + N.x * t;
          const y = oy + N.y * t;
          const z = oz + N.z * t;
          const n = normalAt(x, y, z);
          A.pos.push(x + n[0] * OVERLAY_LIFT, y + n[1] * OVERLAY_LIFT, z + n[2] * OVERLAY_LIFT);
          A.nrm.push(n[0], n[1], n[2]);
          const [a, b] = inverseBilinear(qx, qy, u, v);
          A.uv.push(ov.u[0] + (ov.u[1] - ov.u[0]) * a, ov.v[0] + (ov.v[1] - ov.v[0]) * b);
          if (A.lit) {
            const req = ctx.faceReq[f];
            const lux = mode === MODE_LIT && req >= 0 ? luxel(x, y, z) : null;
            if (lux) {
              lightmapUV(lm!, req, lmW, lmH, lux[0], lux[1], lmOut, 0);
              A.lmuv.push(lmOut[0], lmOut[1]);
            } else A.lmuv.push(lm!.whiteU, lm!.whiteV);
          }
        }
        // fan, oriented counter-clockwise around the surface normal
        let qxN = 0;
        let qyN = 0;
        let qzN = 0;
        const P = A.pos;
        for (let k = 0; k < px.length; k++) {
          const i0 = (base + k) * 3;
          const i1 = (base + ((k + 1) % px.length)) * 3;
          qxN += (P[i0 + 1] - P[i1 + 1]) * (P[i0 + 2] + P[i1 + 2]);
          qyN += (P[i0 + 2] - P[i1 + 2]) * (P[i0] + P[i1]);
          qzN += (P[i0] - P[i1]) * (P[i0 + 1] + P[i1 + 1]);
        }
        const reverse = qxN * pnx + qyN * pny + qzN * pnz < 0;
        for (let k = 1; k + 1 < px.length; k++) {
          A.idx.push(base);
          if (reverse) A.idx.push(base + k + 1, base + k);
          else A.idx.push(base + k, base + k + 1);
        }
        A.surfFlags |= ti.flags;
        fragments++;
      };

      const toOverlay = (x: number, y: number, z: number): [number, number] => {
        const dx = x - O.x;
        const dy = y - O.y;
        const dz = z - O.z;
        return [dx * U.x + dy * U.y + dz * U.z, dx * V.x + dy * V.y + dz * V.z];
      };

      if (face.dispInfo >= 0) {
        const mesh = ctx.dispMeshes[face.dispInfo];
        if (!mesh) continue;
        const MP = mesh.positions;
        const MN = mesh.normals;
        const n = mesh.size;
        const I = mesh.indices;
        const qminX = Math.min(...qx);
        const qmaxX = Math.max(...qx);
        const qminY = Math.min(...qy);
        const qmaxY = Math.max(...qy);
        for (let k = 0; k < I.length; k += 3) {
          const vi = [I[k], I[k + 1], I[k + 2]];
          const cx: number[] = [];
          const cy: number[] = [];
          for (const v of vi) {
            const [u, w] = toOverlay(MP[v * 3], MP[v * 3 + 1], MP[v * 3 + 2]);
            cx.push(u);
            cy.push(w);
          }
          if (Math.max(...cx) < qminX || Math.min(...cx) > qmaxX || Math.max(...cy) < qminY || Math.min(...cy) > qmaxY) continue;
          const clipped = clipConvex(qx, qy, cx, cy);
          if (clipped.x.length < 3) continue;
          // triangle plane + barycentric helpers
          const ax = MP[vi[0] * 3];
          const ay = MP[vi[0] * 3 + 1];
          const az = MP[vi[0] * 3 + 2];
          const e1 = [MP[vi[1] * 3] - ax, MP[vi[1] * 3 + 1] - ay, MP[vi[1] * 3 + 2] - az];
          const e2 = [MP[vi[2] * 3] - ax, MP[vi[2] * 3 + 1] - ay, MP[vi[2] * 3 + 2] - az];
          let tnx = e1[1] * e2[2] - e1[2] * e2[1];
          let tny = e1[2] * e2[0] - e1[0] * e2[2];
          let tnz = e1[0] * e2[1] - e1[1] * e2[0];
          const tl = Math.hypot(tnx, tny, tnz);
          if (!(tl > 1e-9)) continue;
          tnx /= tl;
          tny /= tl;
          tnz /= tl;
          const td = tnx * ax + tny * ay + tnz * az;
          const d00 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2];
          const d01 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
          const d11 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
          const den = d00 * d11 - d01 * d01;
          const bary = (x: number, y: number, z: number): [number, number, number] => {
            const p = [x - ax, y - ay, z - az];
            const d20 = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2];
            const d21 = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
            const b1 = den ? (d11 * d20 - d01 * d21) / den : 0;
            const b2 = den ? (d00 * d21 - d01 * d20) / den : 0;
            return [1 - b1 - b2, b1, b2];
          };
          const normalAt = (x: number, y: number, z: number): [number, number, number] => {
            const w = bary(x, y, z);
            let nx = 0;
            let ny = 0;
            let nz = 0;
            for (let q = 0; q < 3; q++) {
              nx += MN[vi[q] * 3] * w[q];
              ny += MN[vi[q] * 3 + 1] * w[q];
              nz += MN[vi[q] * 3 + 2] * w[q];
            }
            const l = Math.hypot(nx, ny, nz) || 1;
            return [nx / l, ny / l, nz / l];
          };
          const luxel = (x: number, y: number, z: number): [number, number] => {
            const w = bary(x, y, z);
            let s = 0;
            let t = 0;
            for (let q = 0; q < 3; q++) {
              const row = Math.floor(vi[q] / n);
              const col = vi[q] % n;
              s += ((col / (n - 1)) * (lmW - 1)) * w[q];
              t += ((row / (n - 1)) * (lmH - 1)) * w[q];
            }
            return [s, t];
          };
          emit(clipped.x, clipped.y, tnx, tny, tnz, td, normalAt, luxel);
        }
        continue;
      }

      // polygon face
      if (face.numEdges < 3) continue;
      const cx: number[] = [];
      const cy: number[] = [];
      for (let k = 0; k < face.numEdges; k++) {
        const se = bsp.surfedges[face.firstEdge + k];
        const vi = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
        if (vi === undefined || vi * 3 + 2 >= bsp.vertices.length) {
          cx.length = 0;
          break;
        }
        const [u, w] = toOverlay(bsp.vertices[vi * 3], bsp.vertices[vi * 3 + 1], bsp.vertices[vi * 3 + 2]);
        cx.push(u);
        cy.push(w);
      }
      if (cx.length < 3) continue;
      const clipped = clipConvex(qx, qy, cx, cy);
      if (clipped.x.length < 3) continue;
      const fn: [number, number, number] = [fnx, fny, fnz];
      emit(
        clipped.x,
        clipped.y,
        fnx,
        fny,
        fnz,
        plane.dist * sign,
        () => fn,
        (x, y, z) =>
          lv
            ? [
                x * lv[0] + y * lv[1] + z * lv[2] + lv[3] - face.lightmapTextureMinsInLuxels[0],
                x * lv[4] + y * lv[5] + z * lv[6] + lv[7] - face.lightmapTextureMinsInLuxels[1],
              ]
            : null,
      );
    }
    if (fragments) {
      ctx.stats.overlays++;
      ctx.stats.overlayFragments += fragments;
    }
  }

  const out: RenderBatch[] = [];
  const list = [...accs.values()].filter((a) => a.idx.length).sort((a, b) => a.order - b.order);
  for (const a of list) {
    const positions = new Float32Array(a.pos);
    const mins = { x: Infinity, y: Infinity, z: Infinity };
    const maxs = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let i = 0; i < positions.length; i += 3) {
      mins.x = Math.min(mins.x, positions[i]);
      mins.y = Math.min(mins.y, positions[i + 1]);
      mins.z = Math.min(mins.z, positions[i + 2]);
      maxs.x = Math.max(maxs.x, positions[i]);
      maxs.y = Math.max(maxs.y, positions[i + 1]);
      maxs.z = Math.max(maxs.z, positions[i + 2]);
    }
    out.push({
      model: 0,
      material: a.material,
      positions,
      normals: new Float32Array(a.nrm),
      uvs: new Float32Array(a.uv),
      lightmapUVs: a.lit ? new Float32Array(a.lmuv) : null,
      alphas: null,
      indices: new Uint32Array(a.idx),
      surfFlags: a.surfFlags,
      area: a.area,
      isDisplacement: false,
      mins,
      maxs,
      decal: true,
    });
  }
  return out;
}
