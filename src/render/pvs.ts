// PVS culling: like the engine, the main view draws only the geometry in clusters that the eye's cluster can
// see (the BSP's potentially visible sets, MapVisibility). Each mesh gets the set of clusters its triangles
// touch once at load (small groups of consecutive triangles - one batch or prop each - as boxes pushed down
// the BSP tree: a conservative superset), and whenever the eye moves into another cluster every mesh is
// switched on or off by testing that set against the eye cluster's PVS row. An eye in solid or outside the
// visibility data (noclip into a wall, the void) sees everything, like the engine.
//
// Culled meshes leave three.js layer 0 (the camera's layer) instead of changing `visible`, which belongs to the
// game's model state (func_brush toggles, faded brush entities).
import type { Mesh } from 'three';
import type { MapVisibility } from '../map/types';

/** Triangles per box when collecting a mesh's clusters (consecutive triangles come from one batch / prop). */
const CHUNK_TRIANGLES = 32;
/** Boxes are grown by this much and planes get this tolerance: faces on a node plane touch both sides. */
const EPS = 1;

/** Leaf containing a point in the world tree (-1 when the tree is broken). */
export function visLeaf(vis: MapVisibility, x: number, y: number, z: number): number {
  const ch = vis.nodeChildren;
  const pl = vis.nodePlanes;
  const nNodes = ch.length >> 1;
  let node = vis.headNode;
  let guard = nNodes + 1;
  while (node >= 0) {
    if (node >= nNodes || --guard < 0) return -1;
    const o = node * 4;
    const d = pl[o] * x + pl[o + 1] * y + pl[o + 2] * z - pl[o + 3];
    node = ch[node * 2 + (d >= 0 ? 0 : 1)];
  }
  return -node - 1;
}

/** Cluster of a point (-1: solid, outside the data, or no tree). */
export function visCluster(vis: MapVisibility, x: number, y: number, z: number): number {
  const leaf = visLeaf(vis, x, y, z);
  return leaf >= 0 && leaf < vis.leafCluster.length ? vis.leafCluster[leaf] : -1;
}

/**
 * Marks (in `mark`, one byte per cluster) the clusters of every leaf an axis-aligned box touches, and pushes newly
 * marked ones to `out`. `stack` is scratch space.
 */
export function boxClusters(
  vis: MapVisibility,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  mark: Uint8Array,
  out: number[],
  stack: number[],
): void {
  const ch = vis.nodeChildren;
  const pl = vis.nodePlanes;
  const nNodes = ch.length >> 1;
  stack.length = 0;
  stack.push(vis.headNode);
  let guard = 4 * (nNodes + vis.leafCluster.length) + 16;
  while (stack.length) {
    if (--guard < 0) return;
    const node = stack.pop()!;
    if (node < 0) {
      const leaf = -node - 1;
      const c = leaf < vis.leafCluster.length ? vis.leafCluster[leaf] : -1;
      if (c >= 0 && !mark[c]) {
        mark[c] = 1;
        out.push(c);
      }
      continue;
    }
    if (node >= nNodes) continue;
    const o = node * 4;
    const nx = pl[o];
    const ny = pl[o + 1];
    const nz = pl[o + 2];
    const d = pl[o + 3];
    // the box's extent along the plane normal
    const hi = (nx > 0 ? nx * maxX : nx * minX) + (ny > 0 ? ny * maxY : ny * minY) + (nz > 0 ? nz * maxZ : nz * minZ) - d;
    const lo = (nx > 0 ? nx * minX : nx * maxX) + (ny > 0 ? ny * minY : ny * maxY) + (nz > 0 ? nz * minZ : nz * maxZ) - d;
    if (hi >= -EPS) stack.push(ch[node * 2]);
    if (lo < EPS) stack.push(ch[node * 2 + 1]);
  }
}

interface CulledMesh {
  mesh: Mesh;
  /** Clusters the mesh's triangles touch (sorted). */
  clusters: Uint16Array | Uint32Array;
}

export class PvsCuller {
  private readonly meshes: CulledMesh[] = [];
  /** Cluster the visibility was last applied for (-2 = never, -1 = everything shown). */
  private cluster = -2;
  /** Meshes currently culled (diagnostics). */
  culled = 0;
  private readonly mark: Uint8Array;
  private readonly stack: number[] = [];

  constructor(readonly vis: MapVisibility) {
    this.mark = new Uint8Array(vis.numClusters);
  }

  get count(): number {
    return this.meshes.length;
  }

  /** The eye's cluster at the last update (-1: everything shown). */
  get eyeCluster(): number {
    return this.cluster;
  }

  /**
   * Registers a mesh whose geometry and world matrix stay put. Meshes touching every cluster (or none: geometry
   * outside the visibility data) are never culled and are not kept. Returns whether the mesh was taken.
   */
  add(mesh: Mesh): boolean {
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    if (!pos) return false;
    const idx = g.index;
    const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
    if (triCount <= 0) return false;
    const e = mesh.matrixWorld.elements;
    const P = pos.array as ArrayLike<number>;
    const stride = (pos as { data?: { stride: number } }).data ? 0 : pos.itemSize;
    if (!stride) return false; // interleaved: not used for map geometry
    const I = idx ? (idx.array as ArrayLike<number>) : null;
    const out: number[] = [];
    for (let t0 = 0; t0 < triCount; t0 += CHUNK_TRIANGLES) {
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      const t1 = Math.min(triCount, t0 + CHUNK_TRIANGLES);
      for (let k = t0 * 3; k < t1 * 3; k++) {
        const v = (I ? I[k] : k) * stride;
        const lx = P[v];
        const ly = P[v + 1];
        const lz = P[v + 2];
        const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
        const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
        const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      if (!(minX <= maxX)) continue;
      boxClusters(this.vis, minX - EPS, minY - EPS, minZ - EPS, maxX + EPS, maxY + EPS, maxZ + EPS, this.mark, out, this.stack);
      if (out.length >= this.vis.numClusters) break;
    }
    for (const c of out) this.mark[c] = 0;
    if (!out.length || out.length >= this.vis.numClusters) return false;
    out.sort((a, b) => a - b);
    const clusters = this.vis.numClusters <= 65535 ? Uint16Array.from(out) : Uint32Array.from(out);
    this.meshes.push({ mesh, clusters });
    return true;
  }

  /** Clusters registered for a mesh (tests / diagnostics). */
  clustersOf(mesh: Mesh): number[] | null {
    const m = this.meshes.find((x) => x.mesh === mesh);
    return m ? Array.from(m.clusters) : null;
  }

  /**
   * Shows the meshes the eye's cluster can see and hides the others (`enabled` false: shows everything). Cheap
   * when the eye stays in its cluster. Returns whether anything changed.
   */
  update(x: number, y: number, z: number, enabled = true): boolean {
    const c = enabled ? visCluster(this.vis, x, y, z) : -1;
    if (c === this.cluster) return false;
    this.cluster = c;
    let culled = 0;
    if (c < 0) {
      for (const m of this.meshes) m.mesh.layers.enable(0);
    } else {
      const pvs = this.vis.pvs;
      const row = c * this.vis.rowBytes;
      for (const m of this.meshes) {
        const cl = m.clusters;
        let seen = false;
        for (let i = 0; i < cl.length; i++) {
          const k = cl[i];
          // (the eye's own cluster always counts, whatever the row says about itself)
          if (k === c || pvs[row + (k >> 3)] & (1 << (k & 7))) {
            seen = true;
            break;
          }
        }
        if (seen) m.mesh.layers.enable(0);
        else {
          m.mesh.layers.disable(0);
          culled++;
        }
      }
    }
    this.culled = culled;
    return true;
  }

  /** Shows every registered mesh again (and forgets the cluster). */
  reset(): void {
    for (const m of this.meshes) m.mesh.layers.enable(0);
    this.cluster = -2;
    this.culled = 0;
  }

  clear(): void {
    this.reset();
    this.meshes.length = 0;
  }
}

/** Whether a mesh is in the camera's layer (not culled by PvsCuller). */
export function inView(mesh: Mesh): boolean {
  return (mesh.layers.mask & 1) !== 0;
}
