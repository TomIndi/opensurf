// bsp-render tests: lightmap decoding/packing, displacement meshes, render batches, static props and the
// complete loadBspMap pipeline - synthetic maps first, then the real KSF maps when SURF_TEST_MAPS is set:
//   SURF_TEST_MAPS=/path/to/maps [SURF_TEST_MAPS_LARGE=/path/to/large] npx vitest run tests/geometry.test.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { angleVectors, qa } from '../src/core/angles';
import { Vec3, v3 } from '../src/core/vec3';
import { displacementSurface } from '../src/bsp/bspcollision';
import { buildDisplacementMesh, buildDisplacementMeshes, smoothDisplacementSeams } from '../src/bsp/displacement';
import { parseEntities } from '../src/bsp/entities';
import { RenderBuildStats, buildRenderBatches, inverseBilinear, parseOverlays } from '../src/bsp/geometry';
import {
  SkylinePacker,
  buildLightmapAtlas,
  decodeRgbExp32,
  faceLightmapOffset,
  lightmapUV,
  packRects,
  rgbExp32Channel,
  selectLightingSource,
} from '../src/bsp/lightmap';
import { fogFromKeyValues, loadBspMap, mapFog, mapNameFromFile, mapSky3D, mapSpawns, momentumZones } from '../src/bsp/loadmap';
import { buildMaterials, fallbackMaterial } from '../src/bsp/materials';
import { PakFile } from '../src/bsp/pakfile';
import {
  EMIT_POINT,
  EMIT_SKYLIGHT,
  EMIT_SPOTLIGHT,
  LeafAmbientLighting,
  PropLighting,
  buildMapProps,
  buildStaticProps,
  decodeStudioModel,
  entityPropInstances,
  parseStaticPropLump,
  parseWorldLights,
} from '../src/bsp/props';
import { parseBsp } from '../src/bsp/reader';
import {
  BspFace,
  BspFile,
  LUMP_FACES,
  LUMP_FACES_HDR,
  SURF_BUMPLIGHT,
  SURF_HINT,
  SURF_NODRAW,
  SURF_NOLIGHT,
  SURF_SKIP,
  SURF_SKY,
  SURF_TRIGGER,
} from '../src/bsp/types';
import type { BrushModelInfo, LightmapAtlas, LoadedMap, MapEntity, MaterialDef, RenderBatch } from '../src/map/types';
import { CollisionWorld } from '../src/physics/collision';
import { brushFromBox } from '../src/physics/brushbuild';
import { HULL_MAXS, HULL_MINS } from '../src/physics/playertypes';
import { CONTENTS_SOLID, MASK_PLAYERSOLID, newTrace } from '../src/physics/types';
import { buildBoxWorld } from './fixtures/bsp_synth';

// ============================================================================================ helpers

const close = (a: number, b: number, eps = 1e-5): boolean => Math.abs(a - b) <= eps;

/** Bilinear sample of the atlas at uv (clamped to the edge like ClampToEdge). */
function sampleAtlas(a: LightmapAtlas, u: number, v: number): [number, number, number] {
  const x = u * a.width - 0.5;
  const y = v * a.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const px = (xx: number, yy: number, c: number): number => {
    const cx = Math.max(0, Math.min(a.width - 1, xx));
    const cy = Math.max(0, Math.min(a.height - 1, yy));
    return a.data[(cy * a.width + cx) * 4 + c];
  };
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx;
    const bot = px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

function texel(a: LightmapAtlas, x: number, y: number): [number, number, number, number] {
  const o = (y * a.width + x) * 4;
  return [a.data[o], a.data[o + 1], a.data[o + 2], a.data[o + 3]];
}

function triNormal(P: Float32Array, a: number, b: number, c: number): Vec3 {
  const e1 = v3(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]);
  const e2 = v3(P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]);
  return v3(e1.y * e2.z - e1.z * e2.y, e1.z * e2.x - e1.x * e2.z, e1.x * e2.y - e1.y * e2.x);
}

/** Checks the generic RenderBatch invariants; returns a list of problems. */
function batchProblems(b: RenderBatch): string[] {
  const out: string[] = [];
  const nv = b.positions.length / 3;
  if (!Number.isInteger(nv)) out.push('positions length');
  if (b.normals.length !== nv * 3) out.push('normals length');
  if (b.uvs.length !== nv * 2) out.push('uvs length');
  if (b.lightmapUVs && b.lightmapUVs.length !== nv * 2) out.push('lightmapUVs length');
  if (b.alphas && b.alphas.length !== nv) out.push('alphas length');
  if (b.indices.length % 3 !== 0) out.push('indices length');
  for (let i = 0; i < b.indices.length; i++) if (b.indices[i] >= nv) {
    out.push('index out of range');
    break;
  }
  const finite = (arr: Float32Array | null, what: string) => {
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) {
      out.push(`${what} not finite`);
      return;
    }
  };
  finite(b.positions, 'position');
  finite(b.normals, 'normal');
  finite(b.uvs, 'uv');
  finite(b.lightmapUVs, 'lightmap uv');
  finite(b.alphas, 'alpha');
  if (b.lightmapUVs) for (const x of b.lightmapUVs) if (!(x >= 0 && x <= 1)) {
    out.push(`lightmap uv ${x} outside 0..1`);
    break;
  }
  if (b.alphas) for (const x of b.alphas) if (!(x >= 0 && x <= 1)) {
    out.push(`alpha ${x} outside 0..1`);
    break;
  }
  for (let i = 0; i < nv; i++) {
    const n = Math.hypot(b.normals[i * 3], b.normals[i * 3 + 1], b.normals[i * 3 + 2]);
    if (Math.abs(n - 1) > 1e-3) {
      out.push(`normal length ${n}`);
      break;
    }
    const x = b.positions[i * 3];
    const y = b.positions[i * 3 + 1];
    const z = b.positions[i * 3 + 2];
    if (x < b.mins.x || y < b.mins.y || z < b.mins.z || x > b.maxs.x || y > b.maxs.y || z > b.maxs.z) {
      out.push('vertex outside batch bounds');
      break;
    }
  }
  return out;
}

/**
 * Area-weighted fraction of triangles whose winding disagrees with their vertex normals. Slivers thinner than
 * half a unit are ignored: BSP faces carry T-junction vertices that are collinear with the fan origin, giving
 * zero-width fan triangles (in the engine too) whose orientation is numerically arbitrary; they cover no pixels.
 */
function backwardFraction(b: RenderBatch): number {
  let bad = 0;
  let total = 0;
  const P = b.positions;
  const N = b.normals;
  const edge = (i: number, j: number) => Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]);
  for (let k = 0; k < b.indices.length; k += 3) {
    const [i, j, l] = [b.indices[k], b.indices[k + 1], b.indices[k + 2]];
    const n = triNormal(P, i, j, l);
    const area = Math.hypot(n.x, n.y, n.z) / 2;
    const longest = Math.max(edge(i, j), edge(j, l), edge(l, i));
    if (longest === 0 || (2 * area) / longest < 0.5) continue;
    const vn = v3(N[i * 3] + N[j * 3] + N[l * 3], N[i * 3 + 1] + N[j * 3 + 1] + N[l * 3 + 1], N[i * 3 + 2] + N[j * 3 + 2] + N[l * 3 + 2]);
    total += area;
    if (n.x * vn.x + n.y * vn.y + n.z * vn.z < 0) bad += area;
  }
  return total ? bad / total : 0;
}

// ---------------------------------------------------------------- synthetic in-memory BSP builder

interface SynthFaceOpts {
  texinfo: number;
  /** Front normal of the face (= planes[planeNum].normal, as vbsp stores it; `side` is only the planeNum & 1 flag). */
  normal: Vec3;
  side?: number;
  lightOfs?: number;
  lmMins?: [number, number];
  lmSize?: [number, number];
  styles?: [number, number, number, number];
  dispInfo?: number;
}

/** Tiny in-memory BspFile builder (no binary encoding). Leaf 0 = empty area 1 (no nodes: pointLeaf -> 0). */
class SynthBsp {
  vertices: number[] = [];
  edges: number[] = [0, 0];
  surfedges: number[] = [];
  planes: BspFile['planes'] = [];
  faces: BspFace[] = [];
  texinfo: BspFile['texinfo'] = [];
  texdata: BspFile['texdata'] = [];
  texdataNames: string[] = [];
  models: BspFile['models'] = [];
  lighting: number[] = [];
  entitiesText = '{\n"classname" "worldspawn"\n}\n';

  addTexdata(name: string, w = 64, h = 64): number {
    this.texdata.push({ reflectivity: v3(0.5, 0.5, 0.5), nameStringTableID: this.texdata.length, width: w, height: h, viewWidth: w, viewHeight: h });
    this.texdataNames.push(name);
    return this.texdata.length - 1;
  }

  /** texture: s = x/scale (texels), lightmap: s = x/16 luxels by default (axis-aligned for floors). */
  addTexinfo(texData: number, flags = 0, tex: number[] = [1, 0, 0, 0, 0, 1, 0, 0], lm: number[] = [1 / 16, 0, 0, 0, 0, 1 / 16, 0, 0]): number {
    this.texinfo.push({ textureVecs: Float32Array.from(tex), lightmapVecs: Float32Array.from(lm), flags, texData });
    return this.texinfo.length - 1;
  }

  /** Adds a polygon face (points in the stored order) and returns its index. */
  addFace(points: Vec3[], o: SynthFaceOpts): number {
    const planeNum = this.planes.length;
    const d = o.normal.x * points[0].x + o.normal.y * points[0].y + o.normal.z * points[0].z;
    this.planes.push({ normal: o.normal, dist: d, type: 3 });
    const firstEdge = this.surfedges.length;
    const base = this.vertices.length / 3;
    for (const p of points) this.vertices.push(p.x, p.y, p.z);
    for (let i = 0; i < points.length; i++) {
      const e = this.edges.length / 2;
      this.edges.push(base + i, base + ((i + 1) % points.length));
      this.surfedges.push(e);
    }
    this.faces.push({
      planeNum,
      side: o.side ?? 0,
      onNode: 0,
      firstEdge,
      numEdges: points.length,
      texInfo: o.texinfo,
      dispInfo: o.dispInfo ?? -1,
      surfaceFogVolumeID: -1,
      styles: o.styles ?? [0, 255, 255, 255],
      lightOfs: o.lightOfs ?? -1,
      area: 0,
      lightmapTextureMinsInLuxels: o.lmMins ?? [0, 0],
      lightmapTextureSizeInLuxels: o.lmSize ?? [0, 0],
      origFace: -1,
      numPrims: 0,
      firstPrimID: 0,
      smoothingGroups: 0,
    });
    return this.faces.length - 1;
  }

  /** Appends lighting samples [r, g, b, exp][] and returns their byte offset. */
  addLighting(samples: number[][]): number {
    const ofs = this.lighting.length;
    for (const s of samples) this.lighting.push(s[0] & 255, s[1] & 255, s[2] & 255, s[3] & 255);
    return ofs;
  }

  addModel(firstFace: number, numFaces: number, mins = v3(-1024, -1024, -1024), maxs = v3(1024, 1024, 1024)): number {
    this.models.push({ mins, maxs, origin: v3(), headNode: -1, firstFace, numFaces });
    return this.models.length - 1;
  }

  build(o: { noLighting?: boolean } = {}): BspFile {
    const lighting = o.noLighting || !this.lighting.length ? null : Uint8Array.from(this.lighting);
    const nFaces = this.faces.length;
    const leafFaces = new Uint16Array(nFaces);
    for (let i = 0; i < nFaces; i++) leafFaces[i] = i;
    return {
      version: 20,
      mapRevision: 1,
      lumps: [],
      getLump: () => new Uint8Array(0),
      entitiesText: this.entitiesText,
      planes: this.planes,
      vertices: Float32Array.from(this.vertices),
      edges: Uint16Array.from(this.edges),
      surfedges: Int32Array.from(this.surfedges),
      faces: this.faces,
      texinfo: this.texinfo,
      texdata: this.texdata,
      texdataNames: this.texdataNames,
      brushes: [],
      brushSides: [],
      nodes: [],
      leafs: [
        {
          contents: 0,
          cluster: 0,
          area: 1,
          flags: 0,
          mins: v3(-4096, -4096, -4096),
          maxs: v3(4096, 4096, 4096),
          firstLeafFace: 0,
          numLeafFaces: this.models[0] ? this.models[0].numFaces : 0,
          firstLeafBrush: 0,
          numLeafBrushes: 0,
          leafWaterDataID: -1,
        },
      ],
      leafFaces,
      leafBrushes: new Uint16Array(0),
      models: this.models,
      lighting,
      lightingHDR: null,
      dispInfos: [],
      dispVerts: [],
      dispTris: new Uint16Array(0),
      pakfile: null,
      gameLumps: [],
      facesLump: LUMP_FACES,
      warnings: [],
    };
  }
}

function materialsFor(bsp: BspFile, patch: Record<string, Partial<MaterialDef>> = {}): Map<string, MaterialDef> {
  const m = new Map<string, MaterialDef>();
  bsp.texdataNames.forEach((n, i) => {
    const key = n.toLowerCase();
    const def = fallbackMaterial(key, undefined, bsp.texdata[i].width, bsp.texdata[i].height);
    Object.assign(def, patch[key] ?? {});
    m.set(key, def);
  });
  return m;
}

const quad = (x0: number, y0: number, x1: number, y1: number, z: number): Vec3[] => [v3(x0, y0, z), v3(x1, y0, z), v3(x1, y1, z), v3(x0, y1, z)];

// ============================================================================================ lightmap

describe('ColorRGBExp32', () => {
  it('decodes c * 2^exp / 255 with a signed exponent', () => {
    const src = Uint8Array.from([255, 128, 0, 0, 255, 255, 255, 1, 255, 51, 0, 0xff, 10, 20, 30, 0x80]);
    const out = new Float32Array(12);
    for (let i = 0; i < 4; i++) decodeRgbExp32(src, i * 4, out, i * 3);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(128 / 255, 6);
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(2, 6); // exp +1
    expect(out[6]).toBeCloseTo(0.5, 6); // exp -1 (0xff)
    expect(out[7]).toBeCloseTo(51 / 255 / 2, 6);
    expect(out[9]).toBeCloseTo((10 * Math.pow(2, -128)) / 255, 40); // exp -128
    expect(rgbExp32Channel(255, 2)).toBeCloseTo(4, 6);
    expect(rgbExp32Channel(100, -3)).toBeCloseTo(100 / 8 / 255, 6);
  });
});

describe('rect packing', () => {
  it('SkylinePacker places rects without overlap inside the bin', () => {
    const p = new SkylinePacker(64, 64);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 9) + 1;
    for (let i = 0; i < 200; i++) {
      const w = rnd();
      const h = rnd();
      const r = p.insert(w, h);
      if (r) placed.push({ ...r, w, h });
    }
    expect(placed.length).toBeGreaterThan(40);
    const occ = new Uint8Array(64 * 64);
    for (const r of placed) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(64);
      expect(r.y + r.h).toBeLessThanOrEqual(64);
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        expect(occ[y * 64 + x]).toBe(0);
        occ[y * 64 + x] = 1;
      }
    }
    expect(p.insert(65, 1)).toBeNull();
    expect(p.insert(0, 3)).toBeNull();
  });

  it('packRects picks a power-of-two width, height multiple of 4, tight enough, no overlaps', () => {
    const ws: number[] = [];
    const hs: number[] = [];
    let seed = 3;
    const rnd = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % n) + 3;
    let area = 0;
    for (let i = 0; i < 3000; i++) {
      ws.push(rnd(30));
      hs.push(rnd(30));
      area += ws[i] * hs[i];
    }
    const r = packRects(ws, hs, 4096)!;
    expect(r).not.toBeNull();
    expect(Math.log2(r.width) % 1).toBe(0);
    expect(r.height % 4).toBe(0);
    expect(area / (r.width * r.height)).toBeGreaterThan(0.75); // packing efficiency
    const occ = new Uint8Array(r.width * r.height);
    for (let i = 0; i < ws.length; i++) {
      expect(r.x[i] + ws[i]).toBeLessThanOrEqual(r.width);
      expect(r.y[i] + hs[i]).toBeLessThanOrEqual(r.height);
      for (let y = r.y[i]; y < r.y[i] + hs[i]; y++) for (let x = r.x[i]; x < r.x[i] + ws[i]; x++) {
        if (occ[y * r.width + x]) throw new Error('overlap');
        occ[y * r.width + x] = 1;
      }
    }
    expect(packRects([5000], [4], 4096)).toBeNull();
    expect(packRects([64, 64], [64, 64], 64)).toBeNull();
  });
});

describe('lightmap atlas', () => {
  // two lightmaps: 3x2 and 2x2 samples with distinct values
  const data = Uint8Array.from([
    // face A, 3x2 (row 0 then row 1)
    10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0,
    40, 0, 0, 0, 50, 0, 0, 0, 60, 0, 0, 0,
    // face B, 2x2, exponent +1
    1, 2, 3, 1, 4, 5, 6, 1,
    7, 8, 9, 1, 10, 11, 12, 1,
  ]);
  const reqs = [
    { offset: 0, w: 3, h: 2 },
    { offset: 24, w: 2, h: 2 },
  ];

  it('stores every sample once at (rect + 1 + s, rect + 1 + t), replicates borders, has a white block', () => {
    const b = buildLightmapAtlas(data, reqs)!;
    const a = b.atlas;
    expect(a.data.length).toBe(a.width * a.height * 4);
    expect(b.reduction).toBe(1);
    // face A samples
    for (let t = 0; t < 2; t++) for (let s = 0; s < 3; s++) {
      const px = texel(a, b.rectX[0] + 1 + s, b.rectY[0] + 1 + t);
      expect(px[0]).toBeCloseTo((10 * (1 + s + 3 * t)) / 255, 6);
      expect(px[3]).toBe(1);
    }
    // borders: corners and edges copy the nearest sample
    expect(texel(a, b.rectX[0], b.rectY[0])[0]).toBeCloseTo(10 / 255, 6);
    expect(texel(a, b.rectX[0] + 4, b.rectY[0])[0]).toBeCloseTo(30 / 255, 6);
    expect(texel(a, b.rectX[0], b.rectY[0] + 3)[0]).toBeCloseTo(40 / 255, 6);
    expect(texel(a, b.rectX[0] + 4, b.rectY[0] + 3)[0]).toBeCloseTo(60 / 255, 6);
    expect(texel(a, b.rectX[0] + 2, b.rectY[0] + 3)[0]).toBeCloseTo(50 / 255, 6);
    // face B (exp +1)
    const pb = texel(a, b.rectX[1] + 2, b.rectY[1] + 2);
    expect(pb[0]).toBeCloseTo(20 / 255, 6);
    expect(pb[1]).toBeCloseTo(22 / 255, 6);
    expect(pb[2]).toBeCloseTo(24 / 255, 6);
    expect(pb[3]).toBe(1);
    // white block
    expect(sampleAtlas(a, b.whiteU, b.whiteV)).toEqual([1, 1, 1]);
    // all alpha 1
    for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(1);
  });

  it('lightmapUV hits sample texel centres exactly and stays inside the rect', () => {
    const b = buildLightmapAtlas(data, reqs)!;
    const a = b.atlas;
    const uv = new Float32Array(2);
    for (let t = 0; t < 2; t++) for (let s = 0; s < 3; s++) {
      lightmapUV(b, 0, 3, 2, s, t, uv, 0);
      expect(uv[0] * a.width).toBeCloseTo(b.rectX[0] + 1 + s + 0.5, 4);
      expect(uv[1] * a.height).toBeCloseTo(b.rectY[0] + 1 + t + 0.5, 4);
      expect(sampleAtlas(a, uv[0], uv[1])[0]).toBeCloseTo((10 * (1 + s + 3 * t)) / 255, 5);
    }
    // halfway between samples = average
    lightmapUV(b, 0, 3, 2, 0.5, 0, uv, 0);
    expect(sampleAtlas(a, uv[0], uv[1])[0]).toBeCloseTo(15 / 255, 5);
    // far outside: clamped half a texel beyond the edge samples (inside the border)
    lightmapUV(b, 0, 3, 2, -50, 99, uv, 0);
    expect(uv[0] * a.width).toBeCloseTo(b.rectX[0] + 1, 4);
    expect(uv[1] * a.height).toBeCloseTo(b.rectY[0] + 1 + 2, 4);
    expect(sampleAtlas(a, uv[0], uv[1])[0]).toBeCloseTo(40 / 255, 5);
    lightmapUV(b, 0, 3, 2, NaN, NaN, uv, 0);
    expect(Number.isFinite(uv[0]) && Number.isFinite(uv[1])).toBe(true);
  });

  it('overflow: resamples every lightmap at reduced density and keeps the uv mapping consistent', () => {
    // 40 lightmaps of 33x33 samples cannot fit a 64x64 atlas at full density
    const n = 40;
    const w = 33;
    const big = new Uint8Array(n * w * w * 4);
    for (let i = 0; i < n; i++) for (let t = 0; t < w; t++) for (let s = 0; s < w; s++) {
      const o = (i * w * w + t * w + s) * 4;
      big[o] = s * 7; // ramp in s
      big[o + 1] = t * 7; // ramp in t
      big[o + 2] = i;
    }
    const r = Array.from({ length: n }, (_, i) => ({ offset: i * w * w * 4, w, h: w }));
    const b = buildLightmapAtlas(big, r, 64)!;
    expect(b).not.toBeNull();
    expect(b.reduction).toBeGreaterThan(1);
    expect(b.atlas.width).toBeLessThanOrEqual(64);
    expect(b.atlas.height).toBeLessThanOrEqual(64);
    const uv = new Float32Array(2);
    for (const [s, t] of [
      [0, 0],
      [32, 32],
      [16, 8],
      [5.5, 30],
    ]) {
      lightmapUV(b, 7, w, w, s, t, uv, 0);
      const v = sampleAtlas(b.atlas, uv[0], uv[1]);
      // linear ramps survive bilinear resampling exactly
      expect(v[0]).toBeCloseTo((s * 7) / 255, 3);
      expect(v[1]).toBeCloseTo((t * 7) / 255, 3);
      expect(v[2]).toBeCloseTo(7 / 255, 5);
    }
  });

  it('faceLightmapOffset: style 0 slot, bump-mapped faces, range checks', () => {
    const sb = new SynthBsp();
    const td = sb.addTexdata('a');
    const ti = sb.addTexinfo(td);
    const tiBump = sb.addTexinfo(td, SURF_BUMPLIGHT);
    // 2x2 samples
    sb.addFace(quad(0, 0, 16, 16, 0), { texinfo: ti, normal: v3(0, 0, 1), lightOfs: 0, lmSize: [1, 1] });
    sb.addFace(quad(0, 0, 16, 16, 0), { texinfo: ti, normal: v3(0, 0, 1), lightOfs: 0, lmSize: [1, 1], styles: [32, 0, 255, 255] });
    sb.addFace(quad(0, 0, 16, 16, 0), { texinfo: tiBump, normal: v3(0, 0, 1), lightOfs: 0, lmSize: [1, 1], styles: [5, 0, 255, 255] });
    sb.addFace(quad(0, 0, 16, 16, 0), { texinfo: ti, normal: v3(0, 0, 1), lightOfs: 1000, lmSize: [1, 1] });
    sb.addFace(quad(0, 0, 16, 16, 0), { texinfo: ti, normal: v3(0, 0, 1), lightOfs: 0, lmSize: [-1, 1] });
    sb.addLighting(Array.from({ length: 200 }, () => [1, 1, 1, 0]));
    sb.addModel(0, 5);
    const bsp = sb.build();
    const src = selectLightingSource(bsp)!;
    expect(faceLightmapOffset(src, bsp, 0, 0)).toBe(0);
    expect(faceLightmapOffset(src, bsp, 1, 0)).toBe(16); // second style slot: 4 samples * 4 bytes
    expect(faceLightmapOffset(src, bsp, 2, SURF_BUMPLIGHT)).toBe(64); // bump: 4 lightmaps per style
    expect(faceLightmapOffset(src, bsp, 3, 0)).toBe(-1); // out of range
    expect(faceLightmapOffset(src, bsp, 4, 0)).toBe(-1); // bad size
    expect(faceLightmapOffset(src, bsp, 99, 0)).toBe(-1);
  });

  it('selectLightingSource pairs face lumps with lighting lumps', () => {
    const base = new SynthBsp();
    base.addTexdata('a');
    base.addModel(0, 0);
    const ldr = Uint8Array.from([1, 2, 3, 0]);
    const hdr = Uint8Array.from([4, 5, 6, 0, 7, 8, 9, 0]);
    const mk = (o: Partial<BspFile>) => ({ ...base.build(), ...o }) as BspFile;
    expect(selectLightingSource(mk({ lighting: ldr, lightingHDR: hdr }))!.data).toBe(ldr);
    expect(selectLightingSource(mk({ lighting: null, lightingHDR: null }))).toBeNull();
    const hdrFacesOnly = selectLightingSource(mk({ lighting: ldr, lightingHDR: hdr, facesLump: LUMP_FACES_HDR }))!;
    expect(hdrFacesOnly.data).toBe(hdr);
    expect(hdrFacesOnly.hdr).toBe(true);
    expect(selectLightingSource(mk({ lighting: null, lightingHDR: hdr, facesLump: LUMP_FACES_HDR }))!.data).toBe(hdr);
    expect(selectLightingSource(mk({ lighting: ldr, lightingHDR: null, facesLump: LUMP_FACES_HDR }))).toBeNull();
    // LDR faces + HDR-only lighting: offsets come from the HDR face lump (lightOfs at byte 20 of each face)
    const hdrFaceLump = new Uint8Array(56 * 2);
    new DataView(hdrFaceLump.buffer).setInt32(20, 4, true);
    new DataView(hdrFaceLump.buffer).setInt32(56 + 20, -1, true);
    const withFaces = mk({
      lighting: null,
      lightingHDR: hdr,
      faces: [{} as BspFace, {} as BspFace],
      getLump: (i: number) => (i === LUMP_FACES_HDR ? hdrFaceLump : new Uint8Array(0)),
    });
    const s = selectLightingSource(withFaces)!;
    expect(s.data).toBe(hdr);
    expect(Array.from(s.offsets!)).toEqual([4, -1]);
    // preferring HDR on a map with both
    const both = mk({ lighting: ldr, lightingHDR: hdr, faces: [{} as BspFace, {} as BspFace], getLump: (i: number) => (i === LUMP_FACES_HDR ? hdrFaceLump : new Uint8Array(0)) });
    expect(selectLightingSource(both, true)!.data).toBe(hdr);
    expect(selectLightingSource(both, false)!.data).toBe(ldr);
  });
});

// ============================================================================================ displacements

describe('displacement meshes', () => {
  const bsp = parseBsp(buildBoxWorld().buffer);

  it('rebuilds the same vertices as the collision code, with an undisplaced base grid', () => {
    const m = buildDisplacementMesh(bsp, 0)!;
    const ref = displacementSurface(bsp, 0)!;
    expect(m.size).toBe(3);
    expect(m.face).toBe(1);
    expect(Array.from(m.positions)).toEqual(Array.from(ref.positions));
    expect(Array.from(m.indices)).toEqual(Array.from(ref.triangles));
    // corner 0 = startPosition (0,0,0); rows go towards corner 1 (0,64,0), columns towards corner 3 (64,0,0)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const k = (r * 3 + c) * 3;
      expect([m.base[k], m.base[k + 1], m.base[k + 2]]).toEqual([32 * c, 32 * r, 0]);
    }
    expect(m.positions[4 * 3 + 2]).toBe(16); // centre raised by 16
    expect(m.alphas.length).toBe(9);
  });

  it('winds triangles counter-clockwise around the front normal and computes smooth normals', () => {
    const m = buildDisplacementMesh(bsp, 0)!;
    const P = Float32Array.from(m.positions);
    for (let k = 0; k < m.indices.length; k += 3) {
      const n = triNormal(P, m.indices[k], m.indices[k + 1], m.indices[k + 2]);
      expect(n.z).toBeGreaterThan(0);
    }
    // centre vertex is the apex: its normal points straight up; corners tilt away from the centre
    expect(m.normals[4 * 3 + 2]).toBeCloseTo(1, 5);
    expect(m.normals[0]).toBeLessThan(0); // corner (0,0): tilted towards -x
    for (let i = 0; i < 9; i++) expect(Math.hypot(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2])).toBeCloseTo(1, 5);
  });

  it('alternates the diagonal like the engine (checkerboard by vertex index parity)', () => {
    const m = buildDisplacementMesh(bsp, 0)!;
    // quad (0,0): diagonal (0,0)-(1,1) -> vertices 0 and 4 shared by both triangles
    const t0 = Array.from(m.indices.subarray(0, 3));
    const t1 = Array.from(m.indices.subarray(3, 6));
    expect(t0).toContain(0);
    expect(t0).toContain(4);
    expect(t1).toContain(0);
    expect(t1).toContain(4);
    // quad (0,1) (vertex index 1 is odd): diagonal (0,2)-(1,1) -> vertices 2 and 4 shared
    const t2 = Array.from(m.indices.subarray(6, 9));
    const t3 = Array.from(m.indices.subarray(9, 12));
    expect(t2).toContain(2);
    expect(t2).toContain(4);
    expect(t3).toContain(2);
    expect(t3).toContain(4);
  });

  it('returns null for malformed displacements', () => {
    const broken = { ...bsp, dispInfos: [{ ...bsp.dispInfos[0], power: 7 }] } as BspFile;
    expect(buildDisplacementMesh(broken, 0)).toBeNull();
    const outOfRange = { ...bsp, dispInfos: [{ ...bsp.dispInfos[0], dispVertStart: 5 }] } as BspFile;
    expect(buildDisplacementMesh(outOfRange, 0)).toBeNull();
    expect(buildDisplacementMesh(bsp, 3)).toBeNull();
    expect(buildDisplacementMeshes(broken)).toEqual([null]);
  });

  it('welds normals across displacement seams', () => {
    // two copies of the bump side by side: at the shared edge (x = 64) a's normals tilt +x, b's tilt -x
    const a = buildDisplacementMesh(bsp, 0)!;
    const b = buildDisplacementMesh(bsp, 0)!;
    for (let i = 0; i < 9; i++) {
      b.positions[i * 3] += 64;
      b.base[i * 3] += 64;
    }
    const ia = (1 * 3 + 2) * 3; // a: row 1, column 2
    const ib = (1 * 3 + 0) * 3; // b: row 1, column 0
    expect(a.normals[ia]).toBeGreaterThan(0.1);
    expect(b.normals[ib]).toBeLessThan(-0.1);
    smoothDisplacementSeams([a, b]);
    for (const r of [0, 1, 2]) {
      const ja = (r * 3 + 2) * 3;
      const jb = (r * 3 + 0) * 3;
      expect(a.normals[ja]).toBeCloseTo(b.normals[jb], 6);
      expect(a.normals[ja + 1]).toBeCloseTo(b.normals[jb + 1], 6);
      expect(a.normals[ja + 2]).toBeCloseTo(b.normals[jb + 2], 6);
      expect(Math.hypot(a.normals[ja], a.normals[ja + 1], a.normals[ja + 2])).toBeCloseTo(1, 6);
    }
    expect(a.normals[ia]).toBeCloseTo(0, 6); // symmetric bumps: the seam normal is vertical in x
    // non-seam vertices untouched
    expect(a.normals[4 * 3 + 2]).toBeCloseTo(1, 5);
    expect(a.normals[3 * 3]).toBeLessThan(-0.1);
    expect(a.normalSums).toBeNull();
    // back-to-back surfaces (opposite normals) are not welded
    const c = buildDisplacementMesh(bsp, 0)!;
    const d = buildDisplacementMesh(bsp, 0)!;
    for (let i = 0; i < d.normals.length; i++) d.normals[i] = -d.normals[i];
    d.normalSums = d.normalSums!.map((x) => -x);
    const before = Array.from(c.normals);
    smoothDisplacementSeams([c, d]);
    expect(Array.from(c.normals)).toEqual(before);
  });
});

// ============================================================================================ render batches (synthetic)

describe('buildRenderBatches (synthetic map)', () => {
  /**
   * World: lit floor quad (64x64 at z=0, 5x5 luxels at 16 units), a NOLIGHT face, an unlit-material face,
   * a lightmapped face without light data, sky, nodraw, trigger, skip, hint, a tool-material face, a face
   * with a material missing from the material map. Model 1: a quad placed by a rotated func_brush; model 2:
   * unreferenced.
   */
  function scene() {
    const sb = new SynthBsp();
    const tdFloor = sb.addTexdata('dev/floor', 128, 64);
    const tdUnlit = sb.addTexdata('neon/glow');
    const tdSky = sb.addTexdata('tools/toolsskybox');
    const tdTool = sb.addTexdata('tools/toolsclip');
    const tdMissing = sb.addTexdata('custom/missing');
    const ti = sb.addTexinfo(tdFloor);
    const tiNoLight = sb.addTexinfo(tdFloor, SURF_NOLIGHT);
    const tiUnlit = sb.addTexinfo(tdUnlit);
    const tiSky = sb.addTexinfo(tdSky, SURF_SKY | SURF_NOLIGHT);
    const tiTool = sb.addTexinfo(tdTool);
    const tiMissing = sb.addTexinfo(tdMissing);
    const invisible = [SURF_NODRAW, SURF_TRIGGER, SURF_SKIP, SURF_HINT].map((f) => sb.addTexinfo(tdFloor, f));
    const lum = (s: number, t: number) => [10 + s * 40, 10 + t * 40, 100, 0];
    const samples: number[][] = [];
    for (let t = 0; t <= 4; t++) for (let s = 0; s <= 4; s++) samples.push(lum(s, t));
    const ofs = sb.addLighting(samples);
    // floor stored clockwise seen from above (like vbsp)
    const floorPts = quad(0, 0, 64, 64, 0).reverse();
    const fFloor = sb.addFace(floorPts, { texinfo: ti, normal: v3(0, 0, 1), lightOfs: ofs, lmSize: [4, 4] });
    const fNoLight = sb.addFace(quad(100, 0, 164, 64, 0), { texinfo: tiNoLight, normal: v3(0, 0, 1) });
    const fUnlit = sb.addFace(quad(200, 0, 264, 64, 0), { texinfo: tiUnlit, normal: v3(0, 0, 1), lightOfs: ofs, lmSize: [4, 4] });
    const fWhite = sb.addFace(quad(300, 0, 364, 64, 0), { texinfo: ti, normal: v3(0, 0, 1), lightOfs: -1 });
    const fSky = sb.addFace(quad(0, 0, 64, 64, 512), { texinfo: tiSky, normal: v3(0, 0, 1), side: 1 });
    for (const t of invisible) sb.addFace(quad(0, 0, 8, 8, 1), { texinfo: t, normal: v3(0, 0, 1) });
    sb.addFace(quad(0, 0, 8, 8, 2), { texinfo: tiTool, normal: v3(0, 0, 1) });
    const fMissing = sb.addFace(quad(500, 0, 564, 64, 0), { texinfo: tiMissing, normal: v3(0, 0, 1) });
    sb.addModel(0, sb.faces.length);
    // model 1: a 32x32 quad at z=0 in model space, facing +x (vertical wall): placed at (100, 0, 50) yaw 90
    const m1First = sb.faces.length;
    sb.addFace([v3(0, -16, -16), v3(0, 16, -16), v3(0, 16, 16), v3(0, -16, 16)], { texinfo: ti, normal: v3(1, 0, 0), lightOfs: ofs, lmSize: [4, 4] });
    sb.addModel(m1First, 1);
    const m2First = sb.faces.length;
    sb.addFace(quad(0, 0, 16, 16, 0), { texinfo: ti, normal: v3(0, 0, 1) });
    sb.addModel(m2First, 1);
    sb.entitiesText = `{
"classname" "worldspawn"
}
{
"classname" "func_brush"
"model" "*1"
"origin" "100 0 50"
"angles" "0 90 0"
}
`;
    return { sb, faces: { fFloor, fNoLight, fUnlit, fWhite, fSky, fMissing } };
  }

  function build(o: { noLighting?: boolean; options?: Parameters<typeof buildRenderBatches>[3] } = {}) {
    const { sb } = scene();
    const bsp = sb.build({ noLighting: o.noLighting });
    const materials = materialsFor(bsp, {
      'neon/glow': { unlit: true, shader: 'unlitgeneric' },
      'tools/toolsskybox': { isSky: true },
      'tools/toolsclip': { isTool: true },
    });
    materials.delete('custom/missing');
    const stats = {} as RenderBuildStats;
    const warnings: string[] = [];
    const rects: number[][] = [];
    const r = buildRenderBatches(bsp, materials, undefined, {
      stats,
      warnings,
      onFaceLightmap: (f, x, y, w, h, sw, sh) => rects.push([f, x, y, w, h, sw, sh]),
      ...o.options,
    });
    return { bsp, materials, stats, warnings, rects, faces: scene().faces, ...r };
  }

  it('keeps visible faces, drops nodraw/skip/hint/trigger/tool faces and unreferenced models', () => {
    const { batches, stats } = build();
    expect(stats.invisible).toBe(5);
    expect(stats.faces).toBe(7); // floor, nolight, unlit, white, sky, missing, model 1
    expect(batches.every((b) => b.model !== 2)).toBe(true);
    for (const b of batches) expect(batchProblems(b)).toEqual([]);
    const tris = batches.reduce((n, b) => n + b.indices.length / 3, 0);
    expect(tris).toBe(14);
    const withModel2 = build({ options: { includeUnreferencedModels: true } });
    expect(withModel2.batches.some((b) => b.model === 2)).toBe(true);
  });

  it('builds sky batches as SURF_SKY masks without lightmap', () => {
    const { batches } = build();
    const sky = batches.filter((b) => b.surfFlags & SURF_SKY);
    expect(sky.length).toBe(1);
    expect(sky[0].material).toBe('tools/toolsskybox');
    expect(sky[0].lightmapUVs).toBeNull();
    expect(backwardFraction(sky[0])).toBe(0);
    expect(sky[0].normals[2]).toBe(1); // side=1 does not flip: the plane already faces the front
  });

  it('computes texture uvs from the texinfo and winds triangles counter-clockwise from the front', () => {
    const { batches } = build();
    const floor = batches.find((b) => b.material === 'dev/floor' && b.model === 0 && b.lightmapUVs && b.mins.x === 0)!;
    expect(floor).toBeDefined();
    expect(backwardFraction(floor)).toBe(0);
    for (let i = 0; i < floor.positions.length / 3; i++) {
      // s = x (texels) / 128, t = y / 64
      expect(floor.uvs[i * 2]).toBeCloseTo(floor.positions[i * 3] / 128, 6);
      expect(floor.uvs[i * 2 + 1]).toBeCloseTo(floor.positions[i * 3 + 1] / 64, 6);
      expect(Array.from(floor.normals.subarray(i * 3, i * 3 + 3))).toEqual([0, 0, 1]);
    }
    for (const b of batches) expect(backwardFraction(b)).toBe(0);
  });

  it('maps every vertex to its luxel: the atlas sampled at the vertex lightmap uv equals the face sample', () => {
    const { batches, lightmap, rects, faces, bsp } = build();
    expect(lightmap).not.toBeNull();
    const floor = batches.find((b) => b.material === 'dev/floor' && b.model === 0 && b.lightmapUVs && b.mins.x === 0)!;
    const rect = rects.find((r) => r[0] === faces.fFloor)!;
    expect(rect[5]).toBe(5);
    expect(rect[6]).toBe(5);
    let checked = 0;
    for (let i = 0; i < floor.positions.length / 3; i++) {
      if (floor.positions[i * 3] > 64) continue; // the white face shares this batch
      checked++;
      const s = floor.positions[i * 3] / 16;
      const t = floor.positions[i * 3 + 1] / 16;
      const u = floor.lightmapUVs![i * 2];
      const v = floor.lightmapUVs![i * 2 + 1];
      // luxel centre
      expect(u * lightmap!.width).toBeCloseTo(rect[1] + 1 + s + 0.5, 3);
      expect(v * lightmap!.height).toBeCloseTo(rect[2] + 1 + t + 0.5, 3);
      const px = sampleAtlas(lightmap!, u, v);
      expect(px[0]).toBeCloseTo((10 + s * 40) / 255, 5);
      expect(px[1]).toBeCloseTo((10 + t * 40) / 255, 5);
      expect(px[2]).toBeCloseTo(100 / 255, 5);
    }
    expect(checked).toBe(4);
    expect(bsp.faces.length).toBeGreaterThan(0);
  });

  it('separates lit, fullbright-white and unlit faces into different batches', () => {
    const { batches, lightmap, stats } = build();
    expect(stats.litFaces).toBe(2); // floor + model 1
    expect(stats.whiteFaces).toBe(2); // lightOfs -1 face + the face whose material was missing (lightmapped fallback)
    // the lightOfs -1 face (x 300..364) shares the lit batch and samples the white block
    const white = batches.find((b) => b.maxs.x === 364)!;
    expect(white.lightmapUVs).not.toBeNull();
    let whites = 0;
    for (let i = 0; i < white.positions.length / 3; i++) {
      if (white.positions[i * 3] < 300) continue;
      whites++;
      expect(sampleAtlas(lightmap!, white.lightmapUVs![i * 2], white.lightmapUVs![i * 2 + 1])).toEqual([1, 1, 1]);
    }
    expect(whites).toBe(4);
    const noLight = batches.find((b) => b.mins.x === 100)!;
    expect(noLight.material).toBe('dev/floor');
    expect(noLight.lightmapUVs).toBeNull();
    expect(noLight.surfFlags & SURF_NOLIGHT).toBeTruthy();
    const unlit = batches.find((b) => b.material === 'neon/glow')!;
    expect(unlit.lightmapUVs).toBeNull();
    // the floor and the white face share material and lighting mode: same batch unless far apart
    expect(batches.filter((b) => b.material === 'dev/floor' && b.model === 0 && b.lightmapUVs).length).toBe(1);
  });

  it('adds procedural materials for names missing from the material map', () => {
    const { batches, materials, warnings } = build();
    expect(materials.has('custom/missing')).toBe(true);
    expect(batches.some((b) => b.material === 'custom/missing')).toBe(true);
    expect(warnings.some((w) => /missing/.test(w))).toBe(true);
    for (const b of batches) expect(materials.has(b.material)).toBe(true);
  });

  it('places brush entity faces in world space like their entity (origin + angles)', () => {
    const { batches } = build();
    const m1 = batches.find((b) => b.model === 1)!;
    expect(m1).toBeDefined();
    const f = v3();
    const r = v3();
    const u = v3();
    angleVectors(qa(0, 90, 0), f, r, u);
    const local = [v3(0, -16, -16), v3(0, 16, -16), v3(0, 16, 16), v3(0, -16, 16)];
    const expected = local.map((p) => v3(100 + f.x * p.x - r.x * p.y + u.x * p.z, 0 + f.y * p.x - r.y * p.y + u.y * p.z, 50 + f.z * p.x - r.z * p.y + u.z * p.z));
    const got: Vec3[] = [];
    for (let i = 0; i < m1.positions.length / 3; i++) got.push(v3(m1.positions[i * 3], m1.positions[i * 3 + 1], m1.positions[i * 3 + 2]));
    for (const e of expected) expect(got.some((g) => close(g.x, e.x, 1e-3) && close(g.y, e.y, 1e-3) && close(g.z, e.z, 1e-3))).toBe(true);
    // normal +x rotated by yaw 90 -> +y
    expect(m1.normals[0]).toBeCloseTo(0, 6);
    expect(m1.normals[1]).toBeCloseTo(1, 6);
    expect(backwardFraction(m1)).toBe(0);
    // texture coords computed in model space: x = 0 for all model-space vertices -> s = 0
    for (let i = 0; i < m1.uvs.length; i += 2) expect(m1.uvs[i]).toBe(0);
    // brush entity area: probed from the world leaf in front of it (leaf 0, area 1)
    expect(m1.area).toBe(1);
    // yaw 90: model x -> world y, model y -> world -x
    expect(m1.mins.x).toBeCloseTo(84, 3);
    expect(m1.maxs.x).toBeCloseTo(116, 3);
    expect(m1.mins.y).toBeCloseTo(0, 3);
    expect(m1.mins.z).toBeCloseTo(34, 3);
    expect(m1.maxs.z).toBeCloseTo(66, 3);
    // model-space option
    const ms = build({ options: { space: 'model' } }).batches.find((b) => b.model === 1)!;
    expect(ms.mins.x).toBe(0);
    expect(ms.maxs.x).toBe(0);
    expect(ms.area).toBe(-1);
  });

  it('returns no lightmap and no lightmap uvs for maps compiled without lighting', () => {
    const { batches, lightmap, stats } = build({ noLighting: true });
    expect(lightmap).toBeNull();
    expect(batches.every((b) => b.lightmapUVs === null)).toBe(true);
    expect(stats.litFaces).toBe(0);
    expect(stats.whiteFaces).toBe(0);
  });

  it('splits big world groups into XY cells (with small cells pooled) and computes per-batch bounds', () => {
    const sb = new SynthBsp();
    const td = sb.addTexdata('dev/floor');
    const ti = sb.addTexinfo(td);
    // 3 clusters of 50 quads: two dense clusters in cells (0,0) and (3,0), one sparse quad in cell (1,0)
    for (let i = 0; i < 50; i++) sb.addFace(quad(i * 10, 0, i * 10 + 8, 8, 0), { texinfo: ti, normal: v3(0, 0, 1) });
    for (let i = 0; i < 50; i++) sb.addFace(quad(6144 + i * 10, 0, 6144 + i * 10 + 8, 8, 0), { texinfo: ti, normal: v3(0, 0, 1) });
    sb.addFace(quad(2100, 0, 2108, 8, 0), { texinfo: ti, normal: v3(0, 0, 1) });
    sb.addModel(0, sb.faces.length);
    const bsp = sb.build({ noLighting: true });
    const mats = materialsFor(bsp);
    const split = buildRenderBatches(bsp, mats, undefined, { cellSplitMinTriangles: 50, cellMinTriangles: 20 }).batches;
    expect(split.length).toBe(3); // two cells + remainder (the lone quad)
    const byMin = split.map((b) => b.mins.x).sort((a, b) => a - b);
    expect(byMin).toEqual([0, 2100, 6144]);
    for (const b of split) expect(batchProblems(b)).toEqual([]);
    // below the split threshold: one batch
    expect(buildRenderBatches(bsp, mats, undefined, { cellSplitMinTriangles: 1000 }).batches.length).toBe(1);
    expect(buildRenderBatches(bsp, mats, undefined, { cellSize: 0 }).batches.length).toBe(1);
    // pooled small cells: with a high per-cell minimum everything ends up in the remainder
    expect(buildRenderBatches(bsp, mats, undefined, { cellSplitMinTriangles: 10, cellMinTriangles: 1000 }).batches.length).toBe(1);
  });

  it('skips malformed faces instead of throwing', () => {
    const { sb } = scene();
    sb.faces.push({ ...sb.faces[0], texInfo: 999 });
    sb.faces.push({ ...sb.faces[0], numEdges: 2 });
    sb.faces.push({ ...sb.faces[0], firstEdge: 1e6 });
    sb.models[0].numFaces = sb.faces.length; // world range now covers the bad faces (and models 1/2 faces)
    const bsp = sb.build();
    const stats = {} as RenderBuildStats;
    const r = buildRenderBatches(bsp, materialsFor(bsp), undefined, { stats });
    expect(stats.malformed).toBe(3);
    for (const b of r.batches) expect(batchProblems(b)).toEqual([]);
  });
});

describe('buildRenderBatches (box world with a displacement)', () => {
  const box = parseBsp(buildBoxWorld().buffer);

  it('emits the displacement as its own batch with alphas and base-grid texture coordinates', () => {
    const mats = buildMaterials(box, null);
    const r = buildRenderBatches(box, mats);
    const disp = r.batches.filter((b) => b.isDisplacement);
    expect(disp.length).toBe(1);
    const d = disp[0];
    expect(d.positions.length).toBe(9 * 3);
    expect(d.indices.length).toBe(8 * 3);
    expect(d.alphas).not.toBeNull();
    expect(batchProblems(d)).toEqual([]);
    expect(backwardFraction(d)).toBe(0);
    // texinfo: s = 0.25 * x, t = 0.25 * y (texels), texture 512x256; base grid = (32c, 32r, 0)
    for (let k = 0; k < 9; k++) {
      const c = k % 3;
      const row = Math.floor(k / 3);
      expect(d.uvs[k * 2]).toBeCloseTo((0.25 * 32 * c) / 512, 6);
      expect(d.uvs[k * 2 + 1]).toBeCloseTo((0.25 * 32 * row) / 256, 6);
    }
    expect(d.maxs.z).toBe(16);
    const flat = r.batches.filter((b) => !b.isDisplacement);
    expect(flat.length).toBe(1);
    expect(flat[0].alphas).toBeNull();
    // faces are unlit (lightOfs -1) in the box world but the map has a lighting lump: white block
    expect(r.lightmap).not.toBeNull();
    expect(d.lightmapUVs).not.toBeNull();
  });

  it('lays the face lightmap over the displacement grid: vertex (r, c) -> luxel (c/(n-1)*w, r/(n-1)*h)', () => {
    // give face 1 a 3x2 sample lightmap: s along columns (x), t along rows (y)
    const lighting = new Uint8Array(3 * 2 * 4);
    for (let t = 0; t < 2; t++) for (let s = 0; s < 3; s++) lighting.set([20 + 50 * s, 30 + 100 * t, 7, 0], (t * 3 + s) * 4);
    const faces = box.faces.map((f, i) => (i === 1 ? { ...f, lightOfs: 0, lightmapTextureSizeInLuxels: [2, 1] as [number, number] } : f));
    const bsp = { ...box, faces, lighting } as BspFile;
    const r = buildRenderBatches(bsp, buildMaterials(bsp, null));
    const d = r.batches.find((b) => b.isDisplacement)!;
    for (let k = 0; k < 9; k++) {
      const c = k % 3;
      const row = Math.floor(k / 3);
      const s = (c / 2) * 2;
      const t = (row / 2) * 1;
      const px = sampleAtlas(r.lightmap!, d.lightmapUVs![k * 2], d.lightmapUVs![k * 2 + 1]);
      // bilinear between samples
      expect(px[0]).toBeCloseTo((20 + 50 * s) / 255, 5);
      expect(px[1]).toBeCloseTo((30 + 100 * t) / 255, 5);
    }
  });
});

// ============================================================================================ props

/** Little-endian byte writer for synthetic model files. */
class W {
  bytes: number[] = [];
  private dv = new DataView(new ArrayBuffer(8));
  at(o: number): this {
    while (this.bytes.length < o) this.bytes.push(0);
    return this;
  }
  i32(v: number, o?: number): this {
    this.dv.setInt32(0, v, true);
    return this.put(4, o);
  }
  u16(v: number, o?: number): this {
    this.dv.setUint16(0, v, true);
    return this.put(2, o);
  }
  i16(v: number, o?: number): this {
    this.dv.setInt16(0, v, true);
    return this.put(2, o);
  }
  f32(v: number, o?: number): this {
    this.dv.setFloat32(0, v, true);
    return this.put(4, o);
  }
  u8(v: number, o?: number): this {
    this.dv.setUint8(0, v);
    return this.put(1, o);
  }
  str(s: string, o?: number): this {
    if (o !== undefined) this.at(o);
    for (let i = 0; i < s.length; i++) this.write(o !== undefined ? o + i : this.bytes.length, s.charCodeAt(i));
    this.write(o !== undefined ? o + s.length : this.bytes.length, 0);
    return this;
  }
  private write(o: number, b: number): void {
    this.at(o);
    if (o === this.bytes.length) this.bytes.push(b);
    else this.bytes[o] = b;
  }
  private put(n: number, o?: number): this {
    const base = o ?? this.bytes.length;
    for (let i = 0; i < n; i++) this.write(base + i, this.dv.getUint8(i));
    return this;
  }
  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * A studio model with one body part holding `bodyModels` models; model k is a 32x32 quad at z = 10k facing +z
 * (normals +z), wound clockwise like Source models. Two textures / skin families (family 1 swaps Wall01 for
 * Wall02). With `fixups` the VVD stores model 0's vertices in the order [2, 3, 0, 1] and two LOD fixups restore
 * it. `v49` writes CS:GO's larger VTX strip structs.
 */
function synthModel(o: { fixups?: boolean; bodyModels?: number; v49?: boolean } | boolean = {}): { mdl: Uint8Array; vvd: Uint8Array; vtx: Uint8Array } {
  const opt = typeof o === 'boolean' ? { fixups: o } : o;
  const K = opt.bodyModels ?? 1;
  const corners = (k: number) => [v3(0, 0, 10 * k), v3(32, 0, 10 * k), v3(32, 32, 10 * k), v3(0, 32, 10 * k)];
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // ---- MDL
  const m = new W();
  m.str('IDST', 0).i32(opt.v49 ? 49 : 48, 4).i32(1234, 8).str('test/quad.mdl', 12);
  const BP = 408;
  const MODEL = BP + 16;
  const MESH = MODEL + 148 * K;
  const TEX = MESH + 116 * K;
  const CD = TEX + 64 * 2;
  const SKIN = CD + 4;
  const STR = SKIN + 8;
  m.i32(2, 204).i32(TEX, 208); // textures
  m.i32(1, 212).i32(CD, 216); // cdtextures
  m.i32(1, 220).i32(2, 224).i32(SKIN, 228); // 1 skin ref, 2 families
  m.i32(1, 232).i32(BP, 236); // body parts
  m.i32(0, BP).i32(K, BP + 4).i32(1, BP + 8).i32(MODEL - BP, BP + 12);
  for (let k = 0; k < K; k++) {
    const mo = MODEL + k * 148;
    const me = MESH + k * 116;
    m.str(`quad${k}`, mo).i32(1, mo + 72).i32(me - mo, mo + 76).i32(4, mo + 80).i32(k * 4 * 48, mo + 84);
    m.i32(0, me).i32(0, me + 4).i32(4, me + 8).i32(0, me + 12);
  }
  m.i32(STR - TEX, TEX); // texture 0 name relative to its struct
  m.i32(STR + 8 - (TEX + 64), TEX + 64); // texture 1
  m.i32(STR + 16, CD); // cd path relative to the header
  m.i16(0, SKIN).i16(1, SKIN + 2); // family 0: ref 0 -> texture 0, family 1: ref 0 -> texture 1
  m.str('Wall01', STR).str('Wall02', STR + 8).str('models\\test\\', STR + 16);
  m.at(STR + 48);
  m.i32(m.bytes.length, 76);
  // ---- VVD
  const v = new W();
  const nv = 4 * K;
  const stored = Array.from({ length: nv }, (_, i) => i);
  if (opt.fixups) [stored[0], stored[1], stored[2], stored[3]] = [2, 3, 0, 1];
  const nFix = opt.fixups ? 2 + (K > 1 ? 1 : 0) : 0;
  const fixStart = 64;
  const dataStart = fixStart + nFix * 12;
  v.str('IDSV', 0).i32(4, 4).i32(1234, 8).i32(1, 12).i32(nv, 16).i32(nFix, 48).i32(fixStart, 52).i32(dataStart, 56).i32(0, 60);
  if (opt.fixups) {
    v.i32(0, fixStart).i32(2, fixStart + 4).i32(2, fixStart + 8); // stored 2..3 = vertices 0, 1
    v.i32(0, fixStart + 12).i32(0, fixStart + 16).i32(2, fixStart + 20); // stored 0..1 = vertices 2, 3
    if (K > 1) v.i32(0, fixStart + 24).i32(4, fixStart + 28).i32(nv - 4, fixStart + 32); // the rest in order
  }
  for (let i = 0; i < nv; i++) {
    const vo = dataStart + i * 48;
    const id = stored[i];
    const c = corners(Math.floor(id / 4))[id % 4];
    const t = uvs[id % 4];
    v.f32(1, vo).u8(0, vo + 12).u8(1, vo + 15);
    v.f32(c.x, vo + 16).f32(c.y, vo + 20).f32(c.z, vo + 24);
    v.f32(0, vo + 28).f32(0, vo + 32).f32(1, vo + 36);
    v.f32(t[0], vo + 40).f32(t[1], vo + 44);
  }
  // ---- VTX (v7); strip group vertices reference the quad corners in order [3, 2, 1, 0]
  const SGS = opt.v49 ? 33 : 25;
  const SS = opt.v49 ? 35 : 27;
  const x = new W();
  x.i32(7, 0).i32(24, 4).u16(53, 8).u16(9, 10).i32(3, 12).i32(1234, 16).i32(1, 20).i32(0, 24).i32(1, 28).i32(36, 32);
  const BPV = 36;
  const MODELS = BPV + 8;
  x.i32(K, BPV).i32(MODELS - BPV, BPV + 4);
  let cur = MODELS + 8 * K;
  const groupVerts = [3, 2, 1, 0];
  const gi = (corner: number) => groupVerts.indexOf(corner);
  for (let k = 0; k < K; k++) {
    const mo = MODELS + k * 8;
    const LOD = cur;
    const MSH = LOD + 12;
    const SG = MSH + 9;
    const VERTS = SG + SGS;
    const IDX = VERTS + 4 * 9;
    const STRIP = IDX + 6 * 2;
    cur = STRIP + SS;
    x.i32(1, mo).i32(LOD - mo, mo + 4);
    x.i32(1, LOD).i32(MSH - LOD, LOD + 4).f32(0, LOD + 8);
    x.i32(1, MSH).i32(SG - MSH, MSH + 4).u8(0, MSH + 8);
    x.i32(4, SG).i32(VERTS - SG, SG + 4).i32(6, SG + 8).i32(IDX - SG, SG + 12).i32(1, SG + 16).i32(STRIP - SG, SG + 20).u8(0, SG + 24);
    if (opt.v49) x.i32(0, SG + 25).i32(0, SG + 29);
    groupVerts.forEach((orig, i) => x.u8(0, VERTS + i * 9).u8(0, VERTS + i * 9 + 1).u8(0, VERTS + i * 9 + 2).u8(1, VERTS + i * 9 + 3).u16(orig, VERTS + i * 9 + 4).u8(0, VERTS + i * 9 + 6).u8(0, VERTS + i * 9 + 7).u8(0, VERTS + i * 9 + 8));
    // clockwise seen from +z (Source winding): corners (0, 2, 1) and (0, 3, 2)
    [gi(0), gi(2), gi(1), gi(0), gi(3), gi(2)].forEach((q, i) => x.u16(q, IDX + i * 2));
    x.i32(6, STRIP).i32(0, STRIP + 4).i32(4, STRIP + 8).i32(0, STRIP + 12).i16(1, STRIP + 16).u8(1, STRIP + 18).i32(0, STRIP + 19).i32(0, STRIP + 23);
    if (opt.v49) x.i32(0, STRIP + 27).i32(0, STRIP + 31);
  }
  x.at(cur);
  return { mdl: m.build(), vvd: v.build(), vtx: x.build() };
}

function sprpLump(version: number, recordSize: number, props: { type: number; origin: number[]; angles: number[]; skin: number; scale?: number }[], names: string[]): Uint8Array {
  const w = new W();
  w.i32(names.length);
  for (const n of names) {
    const o = w.bytes.length;
    w.str(n, o);
    w.at(o + 128);
  }
  w.i32(2).u16(5).u16(6);
  w.i32(props.length);
  for (const p of props) {
    const o = w.bytes.length;
    w.f32(p.origin[0], o).f32(p.origin[1], o + 4).f32(p.origin[2], o + 8);
    w.f32(p.angles[0], o + 12).f32(p.angles[1], o + 16).f32(p.angles[2], o + 20);
    w.u16(p.type, o + 24).u16(0, o + 26).u16(1, o + 28).u8(6, o + 30).u8(0, o + 31).i32(p.skin, o + 32);
    w.f32(100, o + 36).f32(2000, o + 40).f32(1, o + 44).f32(2, o + 48).f32(3, o + 52);
    if (p.scale !== undefined) w.f32(p.scale, o + recordSize - 4);
    w.at(o + recordSize);
  }
  return w.build();
}

describe('static props', () => {
  it('parses sprp lumps of different versions / record sizes', () => {
    const props = [
      { type: 0, origin: [1, 2, 3], angles: [0, 90, 0], skin: 0 },
      { type: 1, origin: [-5, 6.5, 7], angles: [10, 20, 30], skin: 2 },
    ];
    for (const [ver, size] of [
      [4, 56],
      [5, 60],
      [6, 64],
      [7, 68],
      [10, 72],
      [10, 76],
    ]) {
      const l = parseStaticPropLump(sprpLump(ver, size, props, ['models/a.mdl', 'models/b.mdl']), ver);
      expect(l.recordSize).toBe(size);
      expect(l.dictionary).toEqual(['models/a.mdl', 'models/b.mdl']);
      expect(Array.from(l.leaves)).toEqual([5, 6]);
      expect(l.props.length).toBe(2);
      expect(l.props[1]).toMatchObject({ propType: 1, model: 'models/b.mdl', origin: { x: -5, y: 6.5, z: 7 }, angles: { pitch: 10, yaw: 20, roll: 30 }, skin: 2, solid: 6, scale: 1 });
      expect(l.props[1].lightingOrigin).toEqual({ x: 1, y: 2, z: 3 });
    }
    const v11 = parseStaticPropLump(sprpLump(11, 80, [{ ...props[0], scale: 2.5 }], ['models/a.mdl']), 11);
    expect(v11.props[0].scale).toBe(2.5);
    expect(() => parseStaticPropLump(new Uint8Array([1, 0, 0, 0]), 6)).toThrow();
    expect(parseStaticPropLump(sprpLump(6, 64, [], []), 6).props).toEqual([]);
  });

  for (const fixups of [false, true]) {
    it(`decodes a studio model's LOD 0 mesh (${fixups ? 'with' : 'without'} VVD fixups)`, () => {
      const { mdl, vvd, vtx } = synthModel(fixups);
      const model = decodeStudioModel('models/test/quad.mdl', mdl, vvd, vtx);
      expect(model.version).toBe(48);
      expect(model.textures).toEqual(['Wall01', 'Wall02']);
      expect(model.cdMaterials).toEqual(['models\\test\\']);
      expect(model.skinFamilies).toEqual([[0], [1]]);
      expect(model.meshes.length).toBe(1);
      const mesh = model.meshes[0];
      expect(mesh.indices.length).toBe(6);
      expect(mesh.positions.length).toBe(12);
      // every triangle is counter-clockwise around +z after orientation, and covers the quad
      let area = 0;
      for (let k = 0; k < 6; k += 3) {
        const n = triNormal(mesh.positions, mesh.indices[k], mesh.indices[k + 1], mesh.indices[k + 2]);
        expect(n.z).toBeGreaterThan(0);
        area += n.z / 2;
      }
      expect(area).toBeCloseTo(32 * 32, 3);
      // uvs follow their vertices
      for (let i = 0; i < 4; i++) {
        expect(mesh.uvs[i * 2]).toBe(mesh.positions[i * 3] / 32);
        expect(mesh.uvs[i * 2 + 1]).toBe(mesh.positions[i * 3 + 1] / 32);
        expect(mesh.normals[i * 3 + 2]).toBe(1);
      }
    });
  }

  it('rejects corrupt models', () => {
    const { mdl, vvd, vtx } = synthModel(false);
    expect(() => decodeStudioModel('x', mdl.subarray(0, 100), vvd, vtx)).toThrow();
    expect(() => decodeStudioModel('x', mdl, vvd.subarray(0, 30), vtx)).toThrow();
    const badVtx = vtx.slice();
    badVtx[0] = 6;
    expect(() => decodeStudioModel('x', mdl, vvd, badVtx)).toThrow();
    const badIdx = vtx.slice();
    new DataView(badIdx.buffer).setUint16(73 + 25 + 36, 9, true); // first index -> vertex 9 of 4
    expect(() => decodeStudioModel('x', mdl, vvd, badIdx)).toThrow();
  });

  it('builds RenderProps from packed models, sharing geometry between instances', () => {
    const { mdl, vvd, vtx } = synthModel(true);
    const pak = new PakFile(
      zipSync({ 'models/test/quad.mdl': mdl, 'models/test/quad.vvd': vvd, 'models/test/quad.dx90.vtx': vtx }, { level: 0 }),
    );
    const box = parseBsp(buildBoxWorld().buffer);
    const lump = sprpLump(
      6,
      64,
      [
        { type: 0, origin: [10, 20, 30], angles: [0, 45, 0], skin: 0 },
        { type: 0, origin: [-10, 0, 0], angles: [0, 0, 0], skin: 3 },
        { type: 1, origin: [0, 0, 0], angles: [0, 0, 0], skin: 0 },
      ],
      ['models/test/quad.mdl', 'models/stock/notpacked.mdl'],
    );
    const bsp = { ...box, gameLumps: [{ id: 'sprp', flags: 0, version: 6, data: lump }] } as BspFile;
    const materials = new Map<string, MaterialDef>();
    const warnings: string[] = [];
    const props = buildStaticProps(bsp, pak, materials, { warnings });
    expect(props.length).toBe(2);
    expect(props[0]).toMatchObject({ model: 'models/test/quad.mdl', origin: { x: 10, y: 20, z: 30 }, angles: { pitch: 0, yaw: 45, roll: 0 } });
    expect(props[0].material).toBe('models/test/wall01');
    expect(materials.has('models/test/wall01')).toBe(true);
    expect(props[0].positions).toBe(props[1].positions); // shared
    expect(warnings.some((w) => /not packed/.test(w))).toBe(true);
    // no sprp lump / no pak
    expect(buildStaticProps(box, pak, materials)).toEqual([]);
    expect(buildStaticProps(bsp, null, materials)).toEqual([]);
    // a broken model never throws
    const brokenPak = new PakFile(zipSync({ 'models/test/quad.mdl': mdl.subarray(0, 300), 'models/test/quad.vvd': vvd, 'models/test/quad.dx90.vtx': vtx }, { level: 0 }));
    const w2: string[] = [];
    expect(buildStaticProps(bsp, brokenPak, new Map(), { warnings: w2 })).toEqual([]);
    expect(w2.some((w) => /could not be decoded/.test(w))).toBe(true);
  });
});

describe('studio model variants', () => {
  it('selects body group models and reads CS:GO (v49) VTX layouts', () => {
    for (const v49 of [false, true]) {
      const { mdl, vvd, vtx } = synthModel({ bodyModels: 3, v49, fixups: true });
      for (const body of [0, 1, 2, 4]) {
        const model = decodeStudioModel('m', mdl, vvd, vtx, body);
        expect(model.meshes.length).toBe(1);
        const z = model.meshes[0].positions[2];
        expect(z).toBe(10 * (body % 3)); // part model = floor(body / base) % numModels, base 1
        for (let k = 0; k < 6; k += 3) {
          const n = triNormal(model.meshes[0].positions, model.meshes[0].indices[k], model.meshes[0].indices[k + 1], model.meshes[0].indices[k + 2]);
          expect(n.z).toBeGreaterThan(0);
        }
      }
    }
  });

  it('builds prop_dynamic-style entity props with skins, body groups, tint, alpha, scale and entity index', () => {
    const { mdl, vvd, vtx } = synthModel({ bodyModels: 2 });
    const pak = new PakFile(zipSync({ 'models/test/quad.mdl': mdl, 'models/test/quad.vvd': vvd, 'models/test/quad.dx90.vtx': vtx }, { level: 0 }));
    const box = parseBsp(buildBoxWorld().buffer);
    const ents = parseEntities(`{
"classname" "worldspawn"
}
{
"classname" "prop_dynamic"
"model" "models/test/quad.mdl"
"origin" "10 20 30"
"angles" "0 90 0"
"skin" "1"
"body" "1"
"modelscale" "2"
"rendercolor" "255 128 0"
"rendermode" "1"
"renderamt" "128"
}
{
"classname" "prop_physics_multiplayer"
"model" "models/test/quad.mdl"
"origin" "0 0 0"
}
{
"classname" "prop_dynamic"
"model" "models/test/quad.mdl"
"StartDisabled" "1"
}
{
"classname" "prop_dynamic"
"model" "models/test/quad.mdl"
"rendermode" "10"
}
{
"classname" "prop_dynamic"
"model" "models/test/quad.mdl"
"rendermode" "2"
"renderamt" "0"
}
{
"classname" "info_target"
"model" "models/test/quad.mdl"
}
`);
    const materials = new Map<string, MaterialDef>();
    const props = buildMapProps(box, ents, pak, materials);
    expect(props.length).toBe(2);
    const a = props.find((p) => p.entity === 1)!;
    expect(a.origin).toEqual({ x: 10, y: 20, z: 30 });
    expect(a.angles.yaw).toBe(90);
    expect(a.material).toBe('models/test/wall02'); // skin family 1
    expect(a.color).toEqual([1, 128 / 255, 0]);
    expect(a.alpha).toBeCloseTo(128 / 255, 6);
    expect(a.positions[2]).toBe(20); // body 1 -> model 1 at z 10, scaled x2
    expect(Math.max(...a.positions)).toBe(64);
    const b = props.find((p) => p.entity === 2)!;
    expect(b.material).toBe('models/test/wall01');
    expect(b.color).toBeUndefined();
    expect(b.alpha).toBeUndefined();
    expect(b.positions[2]).toBe(0);
    expect(materials.has('models/test/wall01') && materials.has('models/test/wall02')).toBe(true);
    expect(entityPropInstances(ents).length).toBe(2);
  });
});

describe('world lights and prop lighting', () => {
  /** 88-byte dworldlight_t (or 100 with the CS:GO shadow offset). */
  function worldLight(l: { type: number; origin: number[]; intensity: number[]; normal?: number[]; q?: number; stop?: [number, number] }, wide = false): number[] {
    const w = new W();
    w.f32(l.origin[0]).f32(l.origin[1]).f32(l.origin[2]);
    w.f32(l.intensity[0]).f32(l.intensity[1]).f32(l.intensity[2]);
    const n = l.normal ?? [0, 0, -1];
    w.f32(n[0]).f32(n[1]).f32(n[2]);
    if (wide) w.f32(0).f32(0).f32(0);
    w.i32(0).i32(l.type).i32(0);
    w.f32(l.stop?.[0] ?? 0).f32(l.stop?.[1] ?? 0).f32(1).f32(0);
    w.f32(0).f32(0).f32(l.q ?? 1);
    w.i32(0).i32(-1).i32(0);
    return w.bytes;
  }

  it('parses 88- and 100-byte world light records', () => {
    const one = { type: EMIT_POINT, origin: [1, 2, 3], intensity: [100, 50, 25] };
    const l88 = parseWorldLights(Uint8Array.from([...worldLight(one), ...worldLight({ ...one, type: EMIT_SKYLIGHT })]), 20);
    expect(l88.length).toBe(2);
    expect(l88[0]).toMatchObject({ type: EMIT_POINT, origin: { x: 1, y: 2, z: 3 }, intensity: { x: 100, y: 50, z: 25 }, quadraticAttn: 1 });
    expect(l88[1].type).toBe(EMIT_SKYLIGHT);
    const l100 = parseWorldLights(Uint8Array.from(worldLight(one, true)), 21);
    expect(l100.length).toBe(1);
    expect(l100[0]).toMatchObject({ type: EMIT_POINT, quadraticAttn: 1 });
    expect(parseWorldLights(new Uint8Array(13), 20)).toEqual([]);
  });

  /** Box world with an ambient sample in leaf 1 and the given world lights. */
  function litBox(lights: number[][], ambient = true): BspFile {
    const box = parseBsp(buildBoxWorld().buffer);
    const idx = new Uint8Array(box.leafs.length * 4);
    const smp = new Uint8Array(2 * 28);
    if (ambient) {
      idx.set([2, 0, 0, 0], 1 * 4); // leaf 1: 2 samples from 0
      // sample 0: all faces (10, 20, 30) * 2^-8 (stored like vrad: decoded without /255), at the leaf centre
      for (let f = 0; f < 6; f++) smp.set([10, 20, 30, 0xf8], f * 4);
      smp.set([128, 128, 128, 0], 24);
      // sample 1: +z face brighter, far corner of the leaf
      for (let f = 0; f < 6; f++) smp.set(f === 4 ? [40, 40, 40, 0xf8] : [10, 20, 30, 0xf8], 28 + f * 4);
      smp.set([255, 255, 255, 0], 28 + 24);
    }
    const wl = Uint8Array.from(lights.flat());
    const lumps: Record<number, Uint8Array> = { 52: idx, 56: smp, 15: wl };
    return { ...box, getLump: (i: number) => lumps[i] ?? box.getLump(i) } as BspFile;
  }

  it('decodes leaf ambient cubes (c * 2^e, inverse-distance weighted) and adds direct world lights', () => {
    const bsp = litBox([]);
    const amb = new LeafAmbientLighting(bsp);
    expect(amb.available).toBe(true);
    // leaf 1 spans [-512,-512,-64]..[512,512,512]; sample 0 at its centre (0,0,224)
    const c = amb.sample(v3(0, 0, 224))!;
    expect(c[0][0]).toBeCloseTo(10 / 256, 2);
    expect(c[0][2]).toBeCloseTo(30 / 256, 2);
    expect(c[4][0]).toBeLessThan(40 / 256);
    expect(c[4][0]).toBeGreaterThan(10 / 256);
    expect(amb.sample(v3(0, 0, -500))).toBeNull(); // solid leaf, and no samples above it within reach
    expect(amb.sample(v3(0, 0, -32))).not.toBeNull(); // sunk into the floor: retried a little higher
    // a point light 100 units above: 10000 / 100^2 = 1 on the +z face only
    const lit = new PropLighting(litBox([worldLight({ type: EMIT_POINT, origin: [0, 0, 324], intensity: [10000, 10000, 10000] })], false));
    const cube = lit.cube(v3(0, 0, 224))!;
    expect(cube[4][0]).toBeCloseTo(1, 3);
    expect(cube[5][0]).toBe(0);
    expect(cube[0][0]).toBe(0);
  });

  it('occludes local lights behind solid geometry and lets the sun through only to sky faces', () => {
    const light = worldLight({ type: EMIT_POINT, origin: [0, 0, 100], intensity: [10000, 10000, 10000] });
    // floor brush z in [-64, 0]: a light above the floor reaches a point above it but not one below the floor
    const world = new CollisionWorld([brushFromBox(v3(-512, -512, -64), v3(512, 512, 0), CONTENTS_SOLID)]);
    const pl = new PropLighting(litBox([light], false), world);
    expect(pl.cube(v3(0, 0, 50))![4][0]).toBeGreaterThan(1);
    const below = pl.cube(v3(0, 0, -200));
    expect(below === null || below[4][0] === 0).toBe(true);
    // spotlight cone: outside stopdot2 contributes nothing
    const spot = worldLight({ type: EMIT_SPOTLIGHT, origin: [0, 0, 100], intensity: [10000, 10000, 10000], normal: [1, 0, 0], stop: [0.9, 0.8] });
    expect(new PropLighting(litBox([spot], false)).cube(v3(0, 0, 50))![4][0]).toBe(0);
    // sun: the ray must end on a sky face (none in the box world) or leave the world
    const sun = worldLight({ type: EMIT_SKYLIGHT, origin: [0, 0, 0], intensity: [2, 2, 2], normal: [0, 0, -1] });
    const open = new PropLighting(litBox([sun], false), world);
    expect(open.cube(v3(0, 0, 50))![4][0]).toBeCloseTo(2, 5); // nothing above: reaches the sky
    const roofed = new PropLighting(litBox([sun], false), new CollisionWorld([brushFromBox(v3(-512, -512, 1000), v3(512, 512, 1100), CONTENTS_SOLID)]));
    expect(roofed.cube(v3(0, 0, 50))![4][0]).toBe(0); // the roof isn't a sky face
  });
});

describe('overlays', () => {
  /** doverlay_t bytes. */
  function overlayRecord(o: { texInfo: number; faces: number[]; u: [number, number]; v: [number, number]; points: [number, number][]; origin: number[]; basisU: number[]; flip: boolean; normal: number[] }): Uint8Array {
    const w = new W();
    w.i32(7).i16(o.texInfo).u16(o.faces.length);
    for (let i = 0; i < 64; i++) w.i32(o.faces[i] ?? 0);
    w.f32(o.u[0]).f32(o.u[1]).f32(o.v[0]).f32(o.v[1]);
    const z = [o.basisU[0], o.basisU[1], o.basisU[2], o.flip ? 1 : 0];
    for (let i = 0; i < 4; i++) w.f32(o.points[i][0]).f32(o.points[i][1]).f32(z[i]);
    w.f32(o.origin[0]).f32(o.origin[1]).f32(o.origin[2]);
    w.f32(o.normal[0]).f32(o.normal[1]).f32(o.normal[2]);
    return w.build();
  }

  it('inverseBilinear inverts the bilinear map of arbitrary quads', () => {
    const quads = [
      [[0, 0], [0, 10], [20, 10], [20, 0]],
      [[-5, -3], [-1, 7], [12, 9], [8, -2]],
      [[0, 0], [2, 9], [11, 13], [10, 1]],
    ];
    for (const q of quads) {
      const px = q.map((p) => p[0]);
      const py = q.map((p) => p[1]);
      for (const [a, b] of [[0, 0], [1, 1], [0.25, 0.75], [0.5, 0.5], [0.9, 0.1]]) {
        const x = (1 - a) * (1 - b) * px[0] + (1 - a) * b * px[1] + a * b * px[2] + a * (1 - b) * px[3];
        const y = (1 - a) * (1 - b) * py[0] + (1 - a) * b * py[1] + a * b * py[2] + a * (1 - b) * py[3];
        const [ra, rb] = inverseBilinear(px, py, x, y);
        expect(ra).toBeCloseTo(a, 6);
        expect(rb).toBeCloseTo(b, 6);
      }
    }
  });

  function overlayMap(record: Uint8Array) {
    const sb = new SynthBsp();
    const tdFloor = sb.addTexdata('dev/floor');
    const tdDecal = sb.addTexdata('overlays/arrow', 64, 64);
    const ti = sb.addTexinfo(tdFloor);
    const tiDecal = sb.addTexinfo(tdDecal);
    const samples: number[][] = [];
    for (let t = 0; t <= 4; t++) for (let s = 0; s <= 4; s++) samples.push([20 * s, 20 * t, 50, 0]);
    const ofs = sb.addLighting(samples);
    sb.addFace(quad(0, 0, 64, 64, 0).reverse(), { texinfo: ti, normal: v3(0, 0, 1), lightOfs: ofs, lmSize: [4, 4] });
    sb.addFace(quad(64, 0, 128, 64, 0).reverse(), { texinfo: ti, normal: v3(0, 0, 1), lightOfs: -1 });
    sb.addModel(0, 2);
    const bsp = sb.build();
    void tiDecal;
    const withLump = { ...bsp, getLump: (i: number) => (i === 45 ? record : new Uint8Array(0)) } as BspFile;
    const mats = materialsFor(withLump);
    // overlays need a real (non procedural) texture: like a packed VMT (procedural decal stand-ins count as tools)
    Object.assign(mats.get('overlays/arrow')!, { isTool: false, image: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]), hasAlpha: false } });
    return { bsp: withLump, mats };
  }

  it('parses LUMP_OVERLAYS: basis U from the z components, V = N x U (flipped by the flag)', () => {
    const rec = overlayRecord({ texInfo: 1, faces: [0, 1], u: [0, 1], v: [0, 1], points: [[-16, -16], [-16, 16], [16, 16], [16, -16]], origin: [32, 32, 0], basisU: [1, 0, 0], flip: false, normal: [0, 0, 1] });
    const { bsp } = overlayMap(rec);
    const [o] = parseOverlays(bsp);
    expect(o.faces).toEqual([0, 1]);
    expect(o.renderOrder).toBe(0);
    expect(o.basisU).toEqual({ x: 1, y: 0, z: 0 });
    expect(o.basisV).toEqual({ x: 0, y: 1, z: 0 });
    const flipped = parseOverlays(overlayMap(overlayRecord({ texInfo: 1, faces: [0], u: [0, 1], v: [0, 1], points: [[-16, -16], [-16, 16], [16, 16], [16, -16]], origin: [32, 32, 0], basisU: [1, 0, 0], flip: true, normal: [0, 0, 1] })).bsp)[0];
    expect(flipped.basisV.y).toBe(-1);
  });

  it('clips the overlay quad to its faces, lifts it off the surface, maps texture and lightmap coordinates', () => {
    // a 64x32 overlay centred on the seam between the two floor faces
    const rec = overlayRecord({ texInfo: 1, faces: [0, 1], u: [0, 1], v: [0, 1], points: [[-32, -16], [-32, 16], [32, 16], [32, -16]], origin: [64, 32, 0], basisU: [1, 0, 0], flip: false, normal: [0, 0, 1] });
    const { bsp, mats } = overlayMap(rec);
    const stats = {} as RenderBuildStats;
    const r = buildRenderBatches(bsp, mats, undefined, { stats });
    expect(stats.overlays).toBe(1);
    expect(stats.overlayFragments).toBe(2);
    const dec = r.batches.filter((b) => b.decal);
    expect(dec.length).toBe(1);
    const d = dec[0];
    expect(d.material).toBe('overlays/arrow');
    expect(batchProblems(d)).toEqual([]);
    expect(backwardFraction(d)).toBe(0);
    // covers x 32..96, y 16..48 at z = lift
    expect(d.mins.x).toBeCloseTo(32, 4);
    expect(d.maxs.x).toBeCloseTo(96, 4);
    expect(d.mins.y).toBeCloseTo(16, 4);
    expect(d.maxs.y).toBeCloseTo(48, 4);
    for (let i = 0; i < d.positions.length / 3; i++) {
      const x = d.positions[i * 3];
      const y = d.positions[i * 3 + 1];
      expect(d.positions[i * 3 + 2]).toBeCloseTo(0.25, 5);
      // texcoords: u from 0 at x=32 to 1 at x=96, v from 0 at y=16 to 1 at y=48
      expect(d.uvs[i * 2]).toBeCloseTo((x - 32) / 64, 5);
      expect(d.uvs[i * 2 + 1]).toBeCloseTo((y - 16) / 32, 5);
      // lightmap: the lit face's luxels (s = x/16) on the left, the white block on the right
      const px = sampleAtlas(r.lightmap!, d.lightmapUVs![i * 2], d.lightmapUVs![i * 2 + 1]);
      if (x < 63.9) {
        expect(px[0]).toBeCloseTo((20 * (x / 16)) / 255, 4);
        expect(px[1]).toBeCloseTo((20 * (y / 16)) / 255, 4);
      } else if (x > 64.1) expect(px).toEqual([1, 1, 1]);
    }
    // area covered = 64 * 32
    let area = 0;
    for (let k = 0; k < d.indices.length; k += 3) area += triNormal(d.positions, d.indices[k], d.indices[k + 1], d.indices[k + 2]).z / 2;
    expect(area).toBeCloseTo(64 * 32, 2);
    // can be disabled
    expect(buildRenderBatches(bsp, mats, undefined, { overlays: false }).batches.some((b) => b.decal)).toBe(false);
  });

  it('skips overlays whose material has no real texture', () => {
    const rec = overlayRecord({ texInfo: 1, faces: [0], u: [0, 1], v: [0, 1], points: [[-8, -8], [-8, 8], [8, 8], [8, -8]], origin: [32, 32, 0], basisU: [1, 0, 0], flip: false, normal: [0, 0, 1] });
    const { bsp } = overlayMap(rec);
    const stats = {} as RenderBuildStats;
    const r = buildRenderBatches(bsp, materialsFor(bsp), undefined, { stats });
    expect(r.batches.some((b) => b.decal)).toBe(false);
    expect(stats.overlaysSkipped).toBe(1);
  });

  it('drapes overlays over displacement surfaces', () => {
    const box = parseBsp(buildBoxWorld().buffer);
    const rec = overlayRecord({ texInfo: 0, faces: [1], u: [0, 1], v: [0, 1], points: [[-32, -32], [-32, 32], [32, 32], [32, -32]], origin: [32, 32, 50], basisU: [1, 0, 0], flip: false, normal: [0, 0, 1] });
    const bsp = { ...box, getLump: (i: number) => (i === 45 ? rec : box.getLump(i)) } as BspFile;
    const mats = buildMaterials(bsp, null);
    for (const m of mats.values()) Object.assign(m, { isTool: false, image: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]), hasAlpha: false } });
    const stats = {} as RenderBuildStats;
    const r = buildRenderBatches(bsp, mats, undefined, { stats });
    const d = r.batches.find((b) => b.decal)!;
    expect(stats.overlayFragments).toBe(8); // one per displacement triangle
    expect(batchProblems(d)).toEqual([]);
    expect(backwardFraction(d)).toBe(0);
    // every vertex sits on the displaced surface (lifted along its normal): highest point is the 16-unit peak
    expect(d.maxs.z).toBeGreaterThan(16);
    expect(d.maxs.z).toBeLessThan(16.5);
    let area = 0;
    for (let k = 0; k < d.indices.length; k += 3) area += triNormal(d.positions, d.indices[k], d.indices[k + 1], d.indices[k + 2]).z / 2;
    // projected area = the full 64x64 quad (+ a little: vertices are lifted along the tilted bump normals)
    expect(area / (64 * 64)).toBeGreaterThan(0.999);
    expect(area / (64 * 64)).toBeLessThan(1.01);
  });
});

// ============================================================================================ loader helpers

describe('loader helpers', () => {
  it('mapNameFromFile strips directories and extensions', () => {
    expect(mapNameFromFile('maps/surf_kitsune.bsp')).toBe('surf_kitsune');
    expect(mapNameFromFile('C:\\maps\\Surf_Utopia_NJV.BSP')).toBe('Surf_Utopia_NJV');
    expect(mapNameFromFile('surf_ing.bsp.bz2')).toBe('surf_ing');
    expect(mapNameFromFile('surf_mesa')).toBe('surf_mesa');
    expect(mapNameFromFile('')).toBe('unnamed');
  });

  const ent = (classname: string, kv: Record<string, string>, extra: Partial<MapEntity> = {}): MapEntity => ({
    index: 0,
    classname,
    targetname: kv.targetname ?? '',
    kv: { classname, ...kv },
    outputs: [],
    origin: v3(),
    angles: qa(),
    model: -1,
    ...extra,
  });

  it('fog from env_fog_controller: master first, defaults, colours in 0..1', () => {
    expect(mapFog([])).toBeNull();
    const a = ent('env_fog_controller', { fogenable: '1', fogcolor: '255 128 0', fogstart: '100', fogend: '900' });
    const b = ent('env_fog_controller', { fogenable: '0', fogcolor: '0 0 0', spawnflags: '1', fogmaxdensity: '0.5' });
    expect(mapFog([a])).toEqual({ enabled: true, color: [1, 128 / 255, 0], start: 100, end: 900, maxDensity: 1 });
    expect(mapFog([a, b])).toMatchObject({ enabled: false, maxDensity: 0.5 });
    expect(fogFromKeyValues({ fogcolor: 'garbage' })).toMatchObject({ enabled: false, color: [1, 1, 1] });
    expect(fogFromKeyValues({ fogenable: '1', fogmaxdensity: '7' }).maxDensity).toBe(1);
  });

  it('sky_camera -> Sky3D with its leaf area, default scale and fog', () => {
    const box = parseBsp(buildBoxWorld().buffer);
    expect(mapSky3D(box, [])).toBeNull();
    const cam = ent('sky_camera', { scale: '0', fogenable: '1', fogcolor: '10 20 30', fogstart: '1', fogend: '9216' }, { origin: v3(5, 5, 10) });
    const s = mapSky3D(box, [cam])!;
    expect(s.scale).toBe(16);
    expect(s.area).toBe(1); // leaf 1 (z >= 0)
    expect(s.origin).toEqual(v3(5, 5, 10));
    expect(s.fog).toMatchObject({ enabled: true, color: [10 / 255, 20 / 255, 30 / 255], start: 1, end: 9216 });
    expect(mapSky3D(box, [ent('sky_camera', { scale: '32' })])!).toMatchObject({ scale: 32, fog: null });
  });

  it('momentum timer triggers become zones (start/end/stages/checkpoints, tracks, spawns from lookangles)', () => {
    const model = (i: number, mins: Vec3, maxs: Vec3): BrushModelInfo => ({ index: i, mins, maxs, origin: v3(), brushes: [] });
    const models = [
      model(0, v3(-1000, -1000, -100), v3(1000, 1000, 1000)),
      model(1, v3(-64, -64, 0), v3(64, 64, 128)),
      model(2, v3(500, 0, 0), v3(600, 100, 100)),
      model(3, v3(700, 0, 0), v3(800, 100, 100)),
      model(4, v3(900, 0, 0), v3(950, 100, 100)),
      model(5, v3(0, 500, 0), v3(100, 600, 100)),
      model(6, v3(0, 0, 0), v3(0, 0, 0)), // degenerate
    ];
    const ents = [
      ent('trigger_momentum_timer_start', { lookangles: '0 270 0' }, { model: 1 }),
      ent('trigger_momentum_timer_stage', { stage: '2' }, { model: 2 }),
      ent('trigger_momentum_timer_stage', { stage: '1' }, { model: 3 }), // stage 1 = start zone: skipped
      ent('trigger_momentum_timer_checkpoint', { checkpoint: '3' }, { model: 4 }),
      ent('trigger_momentum_timer_stop', { track_number: '1' }, { model: 5 }),
      ent('trigger_momentum_timer_stop', {}, { model: 6 }),
      ent('trigger_multiple', {}, { model: 2 }),
    ];
    // floor brush under the start zone so a spawn can be found
    const world = new CollisionWorld([brushFromBox(v3(-512, -512, -64), v3(512, 512, 0), CONTENTS_SOLID)]);
    const z = momentumZones(ents, models, world);
    expect(z.map((x) => [x.type, x.group, x.index])).toEqual([
      ['start', 0, 0],
      ['stage', 0, 2],
      ['checkpoint', 0, 3],
      ['end', 1, 0],
    ]);
    expect(z[0].mins).toEqual(v3(-64, -64, 0));
    expect(z[0].spawn).toBeDefined();
    expect(z[0].spawn!.origin.z).toBeCloseTo(1 + 1 / 32, 3); // traces stop DIST_EPSILON above the floor
    expect(z[0].spawn!.angles.yaw).toBe(270);
    expect(z[1].spawn).toBeUndefined();
    expect(momentumZones(ents, models, null)[0].spawn).toBeUndefined();
  });

  it('spawns: T then CT then start/deathmatch, one unit up, stuck ones last, fallback when none', () => {
    const box = parseBsp(buildBoxWorld().buffer);
    const world = new CollisionWorld([brushFromBox(v3(-512, -512, -64), v3(512, 512, 0), CONTENTS_SOLID)]);
    const ents = [
      ent('info_player_start', {}, { origin: v3(0, 0, 0) }),
      ent('info_player_counterterrorist', {}, { origin: v3(10, 0, 0), angles: qa(5, 90, 3) }),
      ent('info_player_terrorist', {}, { origin: v3(20, 0, -40) }), // inside the floor: stuck
      ent('info_player_terrorist', {}, { origin: v3(30, 0, 0) }),
    ];
    const warnings: string[] = [];
    const s = mapSpawns(box, ents, world, warnings);
    expect(s.map((p) => p.origin.x)).toEqual([30, 10, 0, 20]);
    expect(s[0].origin.z).toBe(1);
    expect(s[1].angles).toEqual({ pitch: 5, yaw: 90, roll: 0 });
    expect(warnings.some((w) => /stuck/.test(w))).toBe(true);
    const fb = mapSpawns(box, [], world, warnings);
    expect(fb.length).toBe(1);
    expect(world.testBox(fb[0].origin, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
    expect(fb[0].origin.z).toBeCloseTo(1 + 1 / 32, 3);
  });
});

describe('loadBspMap (box world)', () => {
  it('assembles a complete LoadedMap, reports phases in order and yields to the event loop', async () => {
    const { buffer } = buildBoxWorld();
    const phases: string[] = [];
    let timerRan = false;
    const logs: string[] = [];
    const p = loadBspMap('maps/box_world.bsp', buffer, (pr) => phases.push(pr.phase), { log: (m) => logs.push(m) });
    expect(phases).toEqual(['parse']); // first report is synchronous
    setTimeout(() => (timerRan = true), 0);
    const map = await p;
    expect(timerRan).toBe(true);
    expect(phases).toEqual(['parse', 'collision', 'textures', 'geometry', 'geometry']); // + 'Loading props'
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/\[loadmap\] box_world: \d+ ms/);
    expect(map.name).toBe('box_world');
    expect(map.source).toBe('bsp');
    expect(map.version).toBe(20);
    expect(map.entities.length).toBe(4);
    expect(map.models.length).toBe(3);
    // collision: floor + solid func_brush (model 1) brushes + the displacement's 8 collision triangles
    // (native triangle collision by default); the trigger is not solid
    expect(map.collision.brushes.some((b) => b.model === 1)).toBe(true);
    expect(map.collision.brushes.some((b) => b.model === 2)).toBe(false);
    expect(map.collision.brushes.length).toBe(1 + 1);
    expect(map.collision.triangleCount).toBe(8);
    // the single spawn (0 0 1) is placed one unit up; the displacement bump next to it blocks the hull there
    expect(map.spawns.length).toBe(1);
    expect(map.spawns[0].origin).toEqual(v3(0, 0, 2));
    expect(map.spawns[0].angles.yaw).toBe(90);
    expect(map.collision.testBox(map.spawns[0].origin, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(true);
    expect(map.warnings.some((w) => /stuck/.test(w))).toBe(true);
    expect(map.zones).toEqual([]);
    expect(map.zoneSource).toBe('none');
    expect(map.render.batches.length).toBeGreaterThan(0);
    expect(map.render.sky.name).toBe('sky_test');
    expect(map.render.sky.faces).not.toBeNull(); // procedural stand-in for an unpacked sky
    expect(map.render.sky3d).toBeNull();
    expect(map.render.fog).toBeNull();
    expect(map.render.props).toEqual([]);
    for (const b of map.render.batches) expect(map.render.materials.has(b.material)).toBe(true);
    expect(map.worldMins.z).toBeLessThanOrEqual(-64);
    expect(map.worldMaxs.x).toBeGreaterThanOrEqual(512);
    // the fake sprp payload is reported, not fatal
    expect(map.warnings.some((w) => /static props/.test(w))).toBe(true);
  });

  it('spawn away from the displacement stands free with the floor right below', async () => {
    const ents = `{
"classname" "worldspawn"
"skyname" "sky_test"
}
{
"classname" "info_player_terrorist"
"origin" "-200 -200 0"
}
`;
    const map = await loadBspMap('x', buildBoxWorld({ entities: ents }).buffer, undefined, { log: () => {} });
    const s = map.spawns[0];
    expect(s.origin).toEqual(v3(-200, -200, 1));
    expect(map.collision.testBox(s.origin, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
    const tr = newTrace();
    map.collision.traceBox(s.origin, v3(-200, -200, -100), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    expect(tr.startsolid).toBe(false);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.endpos.z).toBeCloseTo(1 / 32, 4);
    expect(map.warnings.some((w) => /stuck/.test(w))).toBe(false);
  });

  it('makes func_brush models that start disabled non-solid', async () => {
    const ents = `{
"classname" "worldspawn"
}
{
"classname" "func_brush"
"model" "*1"
"origin" "100 0 50"
"StartDisabled" "1"
}
`;
    const map = await loadBspMap('x', buildBoxWorld({ entities: ents }).buffer, undefined, { log: () => {} });
    expect(map.collision.brushes.some((b) => b.model === 1)).toBe(true);
    expect(map.collision.isModelSolid(1)).toBe(false);
    expect(map.spawns.length).toBe(1); // fallback spawn
  });

  it('rejects files that are not BSPs', async () => {
    await expect(loadBspMap('x', new ArrayBuffer(2000), undefined, { log: () => {} })).rejects.toThrow(/BSP/);
  });
});

// ============================================================================================ real maps

function listMaps(env: string | undefined): string[] {
  if (!env || !existsSync(env)) return [];
  if (statSync(env).isFile()) return env.endsWith('.bsp') ? [env] : [];
  return readdirSync(env)
    .filter((f) => f.toLowerCase().endsWith('.bsp'))
    .sort()
    .map((f) => join(env, f));
}

const MAPS = listMaps(process.env.SURF_TEST_MAPS);
const LARGE = listMaps(process.env.SURF_TEST_MAPS_LARGE);

/** Measured spawn drops above 512 units: surf_lt_omnific's spawn room drops players 580 units to its floor. */
const SPAWN_DROP: Record<string, number> = { surf_lt_omnific: 1024 };

function readMap(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.byteLength === b.byteLength ? (b.buffer as ArrayBuffer) : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

describe.skipIf(MAPS.length + LARGE.length === 0)('real maps', () => {
  for (const path of [...MAPS, ...LARGE]) {
    const name = basename(path, '.bsp');
    describe(name, () => {
      let bsp: BspFile;
      let map: LoadedMap;
      let loadMs = 0;
      const rects: number[][] = [];

      beforeAll(async () => {
        const buf = readMap(path);
        const t = performance.now();
        map = await loadBspMap(name, buf, undefined, {
          render: { onFaceLightmap: (f, x, y, w, h, sw, sh) => rects.push([f, x, y, w, h, sw, sh]) },
        });
        loadMs = performance.now() - t;
        bsp = parseBsp(buf);
        console.log(`[geometry test] ${name}: loadBspMap ${loadMs.toFixed(0)} ms, ${map.render.batches.length} batches, ${map.render.props?.length ?? 0} props`);
      }, 120000);
      afterAll(() => {
        bsp = undefined as unknown as BspFile;
        map = undefined as unknown as LoadedMap;
        rects.length = 0;
      });

      it('loads within the time budget', () => {
        expect(loadMs).toBeLessThan(LARGE.includes(path) ? 30000 : 15000);
      });

      it('produces valid batches (no NaN, uvs in range, indices valid, bounds correct, front faces CCW)', () => {
        const batches = map.render.batches;
        expect(batches.length).toBeGreaterThan(0);
        const problems: string[] = [];
        let worst = 0;
        for (const b of batches) {
          for (const p of batchProblems(b)) problems.push(`${b.material}: ${p}`);
          if (!b.isDisplacement) worst = Math.max(worst, backwardFraction(b));
          expect(map.render.materials.has(b.material)).toBe(true);
        }
        expect(problems.slice(0, 10)).toEqual([]);
        // A few compiled faces are slightly concave (surf_beginner face 294, surf_rookie face 13761): fanning
        // them from vertex 0 - as the engine does - folds a triangle over; everything else must face front.
        expect(worst).toBeLessThan(0.001);
      });

      it('has sky batches flagged SURF_SKY without lightmap uvs', () => {
        const sky = map.render.batches.filter((b) => b.surfFlags & SURF_SKY);
        expect(sky.length).toBeGreaterThan(0);
        for (const b of sky) expect(b.lightmapUVs).toBeNull();
      });

      it('packs every lit face into the atlas: rects inside, no overlaps, exact luxels, replicated borders', () => {
        const lm = map.render.lightmap!;
        expect(lm).not.toBeNull();
        expect(lm.width).toBeLessThanOrEqual(4096);
        expect(lm.height).toBeLessThanOrEqual(4096);
        expect(lm.data.length).toBe(lm.width * lm.height * 4);
        expect(rects.length).toBeGreaterThan(0);
        const occ = new Uint8Array(lm.width * lm.height);
        const src = selectLightingSource(bsp)!;
        const dec = new Float32Array(3);
        let bad = 0;
        for (const [f, x, y, w, h, sw, sh] of rects) {
          expect(x >= 0 && y >= 0 && x + w <= lm.width && y + h <= lm.height).toBe(true);
          for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
            if (occ[yy * lm.width + xx]) bad++;
            occ[yy * lm.width + xx] = 1;
          }
          const face = bsp.faces[f];
          expect(sw).toBe(face.lightmapTextureSizeInLuxels[0] + 1);
          expect(sh).toBe(face.lightmapTextureSizeInLuxels[1] + 1);
          const ofs = faceLightmapOffset(src, bsp, f, bsp.texinfo[face.texInfo].flags);
          for (let t = 0; t < sh; t++) for (let s = 0; s < sw; s++) {
            decodeRgbExp32(src.data, ofs + (t * sw + s) * 4, dec, 0);
            const px = texel(lm, x + 1 + s, y + 1 + t);
            if (px[0] !== dec[0] || px[1] !== dec[1] || px[2] !== dec[2]) bad++;
          }
          // borders replicate the edge samples
          if (texel(lm, x, y + 1)[0] !== texel(lm, x + 1, y + 1)[0]) bad++;
          if (texel(lm, x + w - 1, y + h - 1)[1] !== texel(lm, x + w - 2, y + h - 2)[1]) bad++;
        }
        expect(bad).toBe(0);
      });

      it('samples polygon lightmaps continuously across face seams (luxel-centre mapping)', () => {
        const lm = map.render.lightmap!;
        const seen = new Map<string, number[]>();
        for (const b of map.render.batches) {
          if (!b.lightmapUVs || b.isDisplacement || b.decal) continue;
          for (let i = 0; i < b.positions.length / 3; i++) {
            const key =
              `${Math.round(b.positions[i * 3] * 8)},${Math.round(b.positions[i * 3 + 1] * 8)},${Math.round(b.positions[i * 3 + 2] * 8)}|` +
              `${Math.round(b.normals[i * 3] * 100)},${Math.round(b.normals[i * 3 + 1] * 100)},${Math.round(b.normals[i * 3 + 2] * 100)}`;
            const px = sampleAtlas(lm, b.lightmapUVs[i * 2], b.lightmapUVs[i * 2 + 1]);
            const v = px[0] + px[1] + px[2];
            const list = seen.get(key);
            if (list) list.push(v);
            else seen.set(key, [v]);
          }
        }
        let err = 0;
        let n = 0;
        for (const list of seen.values()) {
          for (const v of list.slice(1)) {
            err += Math.abs(v - list[0]) / (v + list[0] + 1e-3);
            n++;
          }
        }
        if (n < 100) return;
        console.log(`[geometry test] ${name}: polygon seam light error ${(err / n).toFixed(4)} over ${n} shared vertices`);
        // measured 0.005-0.043 on the KSF maps; shifting the uvs by half a texel is worse on the big samples
        // (utopia 0.0104 -> 0.013-0.015, omnific 0.0143 -> 0.023-0.026, mesa 0.0431 -> 0.047-0.049)
        expect(err / n).toBeLessThan(0.08);
      });

      it('lays displacement lightmaps out continuously across displacement seams', () => {
        const disp = map.render.batches.filter((b) => b.isDisplacement && b.lightmapUVs);
        if (!disp.length) return;
        const lm = map.render.lightmap!;
        // vertices at the same position in different displacements must sample (nearly) the same light
        const seen = new Map<string, [number, number, number][]>();
        for (const b of disp) {
          for (let i = 0; i < b.positions.length / 3; i++) {
            const key = `${Math.round(b.positions[i * 3] * 4)},${Math.round(b.positions[i * 3 + 1] * 4)},${Math.round(b.positions[i * 3 + 2] * 4)}`;
            const px = sampleAtlas(lm, b.lightmapUVs![i * 2], b.lightmapUVs![i * 2 + 1]);
            const list = seen.get(key);
            if (list) list.push(px);
            else seen.set(key, [px]);
          }
        }
        let err = 0;
        let n = 0;
        for (const list of seen.values()) {
          if (list.length < 2) continue;
          const a = list[0];
          for (const b of list.slice(1)) {
            const la = a[0] + a[1] + a[2];
            const lb = b[0] + b[1] + b[2];
            err += Math.abs(la - lb) / (la + lb + 1e-3);
            n++;
          }
        }
        if (n < 20) return;
        console.log(`[geometry test] ${name}: displacement seam light error ${(err / n).toFixed(4)} over ${n} shared vertices`);
        // the wrong orientation gives ~0.3-0.45 on real maps
        expect(err / n).toBeLessThan(0.08);
      });

      it('rebuilds displacements exactly like the collision code', () => {
        let checked = 0;
        for (let i = 0; i < bsp.dispInfos.length; i += Math.max(1, Math.floor(bsp.dispInfos.length / 200))) {
          const m = buildDisplacementMesh(bsp, i);
          const ref = displacementSurface(bsp, i);
          expect(!!m).toBe(!!ref);
          if (!m || !ref) continue;
          expect(m.positions).toEqual(ref.positions);
          expect(m.indices).toEqual(ref.triangles);
          checked++;
        }
        if (bsp.dispInfos.length) expect(checked).toBeGreaterThan(0);
        if (name === 'surf_mesa_fixed') expect(map.render.batches.filter((b) => b.isDisplacement).length).toBeGreaterThan(10);
      });

      it('spawns stand free and find ground below them (collision extracted end to end)', () => {
        expect(map.spawns.length).toBeGreaterThan(0);
        const tr = newTrace();
        const maxDrop = SPAWN_DROP[name] ?? 512;
        let worst = 0;
        for (const s of map.spawns) {
          expect(map.collision.testBox(s.origin, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID)).toBe(false);
          map.collision.traceBox(s.origin, v3(s.origin.x, s.origin.y, s.origin.z - maxDrop), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
          expect(tr.startsolid).toBe(false);
          expect(tr.fraction).toBeLessThan(1);
          worst = Math.max(worst, s.origin.z - tr.endpos.z);
        }
        console.log(`[geometry test] ${name}: ${map.spawns.length} spawns, largest drop to the ground ${worst.toFixed(1)} units`);
      });

      it('fills sky, fog, sky3d, zones, bounds and props consistently', () => {
        expect(map.render.sky.faces).not.toBeNull();
        const ents = parseEntities(bsp.entitiesText);
        const ws = ents.find((e) => e.classname === 'worldspawn')!;
        expect(map.render.sky.name).toBe(ws.kv.skyname ?? '');
        if (ents.some((e) => e.classname === 'sky_camera')) {
          expect(map.render.sky3d).not.toBeNull();
          expect(map.render.sky3d!.area).toBeGreaterThan(0);
          // the 3D skybox area has its own batches
          expect(map.render.batches.some((b) => b.area === map.render.sky3d!.area)).toBe(true);
        } else expect(map.render.sky3d).toBeNull();
        expect(map.render.fog === null).toBe(!ents.some((e) => e.classname === 'env_fog_controller'));
        const momentum = ents.filter((e) => e.classname.startsWith('trigger_momentum_timer_'));
        if (momentum.length) {
          expect(map.zoneSource).toBe('momentum');
          expect(map.zones.some((z) => z.type === 'start')).toBe(true);
          expect(map.zones.some((z) => z.type === 'end')).toBe(true);
          for (const z of map.zones) expect(z.maxs.x > z.mins.x && z.maxs.y > z.mins.y && z.maxs.z > z.mins.z).toBe(true);
        } else {
          expect(map.zones).toEqual([]);
          expect(map.zoneSource).toBe('none');
        }
        for (const s of map.spawns) {
          expect(s.origin.x).toBeGreaterThanOrEqual(map.worldMins.x);
          expect(s.origin.z).toBeLessThanOrEqual(map.worldMaxs.z);
        }
        for (const p of map.render.props ?? []) {
          expect(map.render.materials.has(p.material)).toBe(true);
          const nv = p.positions.length / 3;
          expect(p.normals.length).toBe(nv * 3);
          expect(p.uvs.length).toBe(nv * 2);
          for (let i = 0; i < p.indices.length; i++) if (p.indices[i] >= nv) throw new Error(`${p.model}: index out of range`);
          for (const x of p.positions) if (!Number.isFinite(x)) throw new Error(`${p.model}: NaN`);
        }
        expect(map.warnings.some((w) => /could not be decoded/.test(w))).toBe(false);
      });

      it('lights props with finite light cubes and links entity props to their entities', () => {
        const props = map.render.props ?? [];
        let lit = 0;
        for (const p of props) {
          if (p.entity !== undefined) {
            const e = map.entities[p.entity];
            expect(e && /^prop_|_prop$/.test(e.classname)).toBe(true);
          }
          if (!p.ambientCube) continue;
          lit++;
          expect(p.ambientCube.length).toBe(6);
          for (const c of p.ambientCube) for (const x of c) expect(Number.isFinite(x) && x >= 0).toBe(true);
          if (p.color) for (const x of p.color) expect(x >= 0 && x <= 1).toBe(true);
          if (p.alpha !== undefined) expect(p.alpha > 0 && p.alpha <= 1).toBe(true);
        }
        if (props.length) expect(lit / props.length).toBeGreaterThan(0.9);
        if (props.length) expect(props.filter((p) => p.area !== undefined).length / props.length).toBeGreaterThan(0.9);
        const sky3d = map.render.sky3d;
        if (sky3d && name === 'surf_lt_omnific') {
          // its 3dsb_* models stand in the 3D skybox
          const skyProps = props.filter((p) => p.area === sky3d.area);
          expect(skyProps.length).toBeGreaterThan(0);
          expect(skyProps.some((p) => /3dsb/.test(p.model))).toBe(true);
        }
        console.log(`[geometry test] ${name}: ${props.length} props (${props.filter((p) => p.entity !== undefined).length} from entities), ${lit} lit`);
      });

      it('drapes info_overlays with packed textures onto their faces', () => {
        const overlays = parseOverlays(bsp);
        const decals = map.render.batches.filter((b) => b.decal);
        if (!overlays.length) {
          expect(decals).toEqual([]);
          return;
        }
        const packed = overlays.filter((o) => {
          const m = map.render.materials.get(bsp.texdataNames[bsp.texinfo[o.texInfo].texData].toLowerCase());
          return m && !m.isTool && m.image;
        });
        if (packed.length) expect(decals.length).toBeGreaterThan(0);
        for (const d of decals) {
          expect(d.model).toBe(0);
          expect(map.render.materials.has(d.material)).toBe(true);
        }
        console.log(`[geometry test] ${name}: ${overlays.length} overlays, ${decals.length} decal batches, ${decals.reduce((n, d) => n + d.indices.length / 3, 0)} triangles`);
      });
    });
  }
});
