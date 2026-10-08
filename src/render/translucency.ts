// Back-to-front order inside translucent meshes.
//
// three.js sorts transparent meshes against each other (by the projected centre of their bounding spheres), but
// draws the triangles of one mesh in index order. A translucent batch often holds several parallel layers -
// stacked glowing grids, both panes of a window, the faces of a glass box - and blending those in the wrong order
// lets a far layer cover a near one. Source sorts translucent brush faces back to front; here every translucent
// mesh's triangles are grouped by plane once, and the groups are re-ordered by view depth whenever the camera
// changes their order (an index buffer rewrite + upload only then: usually a handful of times per second at most).
import { BufferAttribute, Mesh, Vector3 } from 'three';

/** One plane's triangles: a contiguous range of the grouped index list. */
export interface PlaneGroup {
  start: number;
  count: number;
  /** Centre of the group's triangles. */
  x: number;
  y: number;
  z: number;
  /** Bounds of the group's vertices. */
  min: [number, number, number];
  max: [number, number, number];
}

interface SortedMesh {
  mesh: Mesh;
  index: BufferAttribute;
  /** Indices grouped by plane (the source the draw order is assembled from). */
  base: Uint16Array | Uint32Array;
  groups: PlaneGroup[];
  /** Current draw order (group ids, first drawn first) and scratch space for the next one. */
  order: Int32Array;
  depth: Float64Array;
}

/** Most plane groups sorted per mesh: beyond that (curved translucent displacements...) groups are merged spatially. */
export const MAX_SORT_GROUPS = 1024;

/**
 * Groups a triangle list by plane: triangles whose (sign-normalized) normal and distance agree to ~0.5° and half
 * a unit share a group. Returns the grouped index list and the groups (centres in the positions' space).
 */
export function groupTrianglesByPlane(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): { grouped: number[]; groups: PlaneGroup[] } {
  const byKey = new Map<string, { tris: number[]; sx: number; sy: number; sz: number; n: number; min: [number, number, number]; max: [number, number, number] }>();
  const triCount = Math.floor(indices.length / 3);
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const e1x = positions[b] - ax;
    const e1y = positions[b + 1] - ay;
    const e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax;
    const e2y = positions[c + 1] - ay;
    const e2z = positions[c + 2] - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    let key: string;
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
      nz /= len;
      // a plane and its flipped copy are the same layer
      if (nx < -1e-6 || (Math.abs(nx) <= 1e-6 && (ny < -1e-6 || (Math.abs(ny) <= 1e-6 && nz < 0)))) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const d = nx * ax + ny * ay + nz * az;
      key = `${Math.round(nx * 100)},${Math.round(ny * 100)},${Math.round(nz * 100)},${Math.round(d * 2)}`;
    } else key = 'degenerate';
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { tris: [], sx: 0, sy: 0, sz: 0, n: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    g.tris.push(t);
    for (const v of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        const x = positions[v + k];
        if (x < g.min[k]) g.min[k] = x;
        if (x > g.max[k]) g.max[k] = x;
      }
    }
    g.sx += ax + (e1x + e2x) / 3;
    g.sy += ay + (e1y + e2y) / 3;
    g.sz += az + (e1z + e2z) / 3;
    g.n++;
  }
  const grouped: number[] = [];
  const groups: PlaneGroup[] = [];
  for (const g of byKey.values()) {
    const start = grouped.length;
    for (const t of g.tris) grouped.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
    groups.push({ start, count: grouped.length - start, x: g.sx / g.n, y: g.sy / g.n, z: g.sz / g.n, min: g.min, max: g.max });
  }
  return { grouped, groups };
}

/** Merges groups pairwise (nearest centres along the list sorted by x+y+z) until at most `max` remain. */
function capGroups(grouped: number[], groups: PlaneGroup[], max: number): { grouped: number[]; groups: PlaneGroup[] } {
  if (groups.length <= max) return { grouped, groups };
  const sorted = groups.slice().sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z));
  const per = Math.ceil(sorted.length / max);
  const out: number[] = [];
  const merged: PlaneGroup[] = [];
  for (let i = 0; i < sorted.length; i += per) {
    const part = sorted.slice(i, i + per);
    const start = out.length;
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const g of part) {
      for (let k = 0; k < g.count; k++) out.push(grouped[g.start + k]);
      x += g.x * g.count;
      y += g.y * g.count;
      z += g.z * g.count;
      w += g.count;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], g.min[k]);
        max[k] = Math.max(max[k], g.max[k]);
      }
    }
    merged.push({ start, count: out.length - start, x: x / w, y: y / w, z: z / w, min, max });
  }
  return { grouped: out, groups: merged };
}

const _p = new Vector3();
const _q = new Vector3();

/** Squared distance from a point to a box (0 inside). */
function boxDist2(px: number, py: number, pz: number, min: readonly number[], max: readonly number[]): number {
  const dx = px < min[0] ? min[0] - px : px > max[0] ? px - max[0] : 0;
  const dy = py < min[1] ? min[1] - py : py > max[1] ? py - max[1] : 0;
  const dz = pz < min[2] ? min[2] - pz : pz > max[2] ? pz - max[2] : 0;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Sort key of a group seen from an eye (larger = farther = drawn earlier): squared distance to its bounding box,
 * ties (eye inside several boxes) broken by the distance to the centre.
 */
export function groupFarness(g: PlaneGroup, ex: number, ey: number, ez: number): number {
  const c = (g.x - ex) * (g.x - ex) + (g.y - ey) * (g.y - ey) + (g.z - ez) * (g.z - ez);
  return boxDist2(ex, ey, ez, g.min, g.max) + 1e-4 * c;
}

/** Keeps the plane groups of translucent meshes in back-to-front order for the current camera. */
export class TranslucentSorter {
  private readonly meshes: SortedMesh[] = [];
  /** Index buffer rewrites so far (diagnostics/tests). */
  rewrites = 0;

  get count(): number {
    return this.meshes.length;
  }

  /**
   * Registers a mesh (its world matrix must be final). Meshes whose triangles all lie in one plane need no
   * sorting and are ignored; returns whether the mesh was taken.
   */
  add(mesh: Mesh): boolean {
    const g = mesh.geometry;
    const index = g.index;
    const pos = g.getAttribute('position');
    if (!index || !pos || index.count < 6) return false;
    const r = groupTrianglesByPlane(pos.array as ArrayLike<number>, index.array as ArrayLike<number>);
    if (r.groups.length < 2) return false;
    const capped = capGroups(r.grouped, r.groups, MAX_SORT_GROUPS);
    // centres and boxes to world space (3D-skybox meshes are scaled about the sky camera)
    for (const gr of capped.groups) {
      _p.set(gr.x, gr.y, gr.z).applyMatrix4(mesh.matrixWorld);
      gr.x = _p.x;
      gr.y = _p.y;
      gr.z = _p.z;
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let corner = 0; corner < 8; corner++) {
        _q.set(corner & 1 ? gr.max[0] : gr.min[0], corner & 2 ? gr.max[1] : gr.min[1], corner & 4 ? gr.max[2] : gr.min[2]).applyMatrix4(mesh.matrixWorld);
        for (let k = 0; k < 3; k++) {
          const v = _q.getComponent(k);
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      gr.min = min;
      gr.max = max;
    }
    const arr = index.array as Uint16Array | Uint32Array;
    const base = arr instanceof Uint16Array ? Uint16Array.from(capped.grouped) : Uint32Array.from(capped.grouped);
    arr.set(base);
    index.needsUpdate = true;
    const n = capped.groups.length;
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    this.meshes.push({ mesh, index: index as BufferAttribute, base, groups: capped.groups, order, depth: new Float64Array(n) });
    return true;
  }

  /**
   * Re-orders every registered mesh far-to-near as seen from the eye; rewrites an index buffer only when its
   * order changed. No allocation.
   */
  update(eye: Vector3): void {
    for (const s of this.meshes) {
      if (!s.mesh.visible) continue;
      const { groups, order, depth } = s;
      const n = groups.length;
      for (let i = 0; i < n; i++) depth[i] = groupFarness(groups[i], eye.x, eye.y, eye.z);
      // insertion sort of the previous order (nearly sorted frame to frame): far (large depth) first
      let changed = false;
      for (let i = 1; i < n; i++) {
        const id = order[i];
        const d = depth[id];
        let j = i - 1;
        while (j >= 0 && depth[order[j]] < d) {
          order[j + 1] = order[j];
          j--;
        }
        if (j + 1 !== i) {
          order[j + 1] = id;
          changed = true;
        }
      }
      if (!changed) continue;
      const arr = s.index.array as Uint16Array | Uint32Array;
      let o = 0;
      for (let i = 0; i < n; i++) {
        const g = groups[order[i]];
        arr.set(s.base.subarray(g.start, g.start + g.count), o);
        o += g.count;
      }
      s.index.clearUpdateRanges();
      s.index.needsUpdate = true;
      this.rewrites++;
    }
  }

  /** Current draw order of a registered mesh as group centres (tests). */
  orderOf(mesh: Mesh): { x: number; y: number; z: number }[] | null {
    const s = this.meshes.find((m) => m.mesh === mesh);
    if (!s) return null;
    return Array.from(s.order, (i) => ({ x: s.groups[i].x, y: s.groups[i].y, z: s.groups[i].z }));
  }

  clear(): void {
    this.meshes.length = 0;
  }
}
