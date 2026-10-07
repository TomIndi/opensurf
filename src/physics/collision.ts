// Brush collision world: Source/Quake-style swept AABB traces against convex brushes, accelerated by a
// BVH over brush bounds. Everything the player movement touches lives here, so the hot paths are
// allocation-free and operate on flat typed arrays.
//
// Trace semantics follow the classic brush clipping algorithm (described publicly for Quake/Source):
// each brush plane is pushed out by the box half-extents, the box center is clipped against the
// resulting convex volume, and the reported fraction stops DIST_EPSILON short of the surface along the
// plane normal. Bevel planes are used for box traces only. A trace starting inside a brush reports
// startsolid (touching counts as inside); one that never leaves reports allsolid with fraction 0.
//
// Implemented from the algorithm descriptions; no engine code was used.
import { Vec3 } from '../core/vec3';
import { computeBrushBounds } from './brushbuild';
import { Brush, DIST_EPSILON, MASK_ALL, TraceResult, TraceWorld, newTrace } from './types';

/**
 * Extra slack added to every broad-phase box (BVH nodes and brush AABBs). Plane clipping with the
 * DIST_EPSILON offsets can register a hit slightly outside the expanded brush AABB (up to
 * DIST_EPSILON for box traces; a bit more near sharp edges for point traces, which ignore bevels).
 * Purely a culling margin: the exact result comes from the planes.
 */
const BROAD_MARGIN = 1.0;
/**
 * Float noise allowance for the "clearly in front of this plane" test. A box that ended a previous
 * move DIST_EPSILON off a surface and now slides parallel to it has d1 ~= d2 ~= DIST_EPSILON; rounding
 * could make d2 a hair below DIST_EPSILON while d1 - d2 is ~1e-15, which turns
 * (d1 - eps) / (d1 - d2) into an arbitrary fraction and stops the player mid-ramp (a "ramp bug").
 * Treating anything within 1e-6 of the epsilon shell as outside removes that failure mode while being
 * five orders of magnitude below anything observable.
 */
const CLIP_NOISE = 1e-6;
/** Boxes with extents smaller than this (length^2 < 1e-6) are traced as rays (like Source's Ray_t). */
const POINT_EXTENT_SQ = 1e-6;
const LEAF_MAX = 4;
const SAH_BINS = 16;

const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

interface Bvh {
  nodeBounds: Float64Array; // 6 per node: minx miny minz maxx maxy maxz
  /** 2 per node. Leaf: [firstSlot, count>0]. Internal: [rightChild, -(splitAxis+1)]; left child = node+1. */
  nodeInfo: Int32Array;
  nodeCount: number;
  /** order[slot] = index into the input arrays. */
  order: Int32Array;
  maxDepth: number;
}

/** Binned-SAH BVH over AABBs (bmin/bmax: 3 per item). Depth-first node layout. */
function buildBvh(count: number, bmin: Float64Array, bmax: Float64Array): Bvh {
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const maxNodes = Math.max(1, 2 * count - 1);
  const nodeBounds = new Float64Array(maxNodes * 6);
  const nodeInfo = new Int32Array(maxNodes * 2);
  if (count === 0) return { nodeBounds, nodeInfo, nodeCount: 0, order, maxDepth: 0 };

  const cent = new Float64Array(count * 3);
  for (let i = 0; i < count * 3; i++) cent[i] = (bmin[i] + bmax[i]) * 0.5;

  // scratch for binning
  const binCount = new Int32Array(SAH_BINS);
  const binB = new Float64Array(SAH_BINS * 6);
  const rightArea = new Float64Array(SAH_BINS);
  const rightCount = new Int32Array(SAH_BINS);

  // task stack: start, end, parent (-1 = left child / root), depth
  let taskCap = 64;
  let tasks = new Int32Array(taskCap * 4);
  let tsp = 0;
  const pushTask = (s: number, e: number, parent: number, depth: number): void => {
    if (tsp + 4 > tasks.length) {
      taskCap *= 2;
      const nt = new Int32Array(taskCap * 4);
      nt.set(tasks);
      tasks = nt;
    }
    tasks[tsp++] = s;
    tasks[tsp++] = e;
    tasks[tsp++] = parent;
    tasks[tsp++] = depth;
  };
  pushTask(0, count, -1, 1);
  let nodeCount = 0;
  let maxDepth = 0;

  while (tsp > 0) {
    const depth = tasks[--tsp];
    const parent = tasks[--tsp];
    const end = tasks[--tsp];
    const start = tasks[--tsp];
    const node = nodeCount++;
    if (parent >= 0) nodeInfo[parent * 2] = node;
    if (depth > maxDepth) maxDepth = depth;

    // node bounds and centroid bounds
    let nminx = Infinity, nminy = Infinity, nminz = Infinity;
    let nmaxx = -Infinity, nmaxy = -Infinity, nmaxz = -Infinity;
    let cminx = Infinity, cminy = Infinity, cminz = Infinity;
    let cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
    for (let k = start; k < end; k++) {
      const i3 = order[k] * 3;
      if (bmin[i3] < nminx) nminx = bmin[i3];
      if (bmin[i3 + 1] < nminy) nminy = bmin[i3 + 1];
      if (bmin[i3 + 2] < nminz) nminz = bmin[i3 + 2];
      if (bmax[i3] > nmaxx) nmaxx = bmax[i3];
      if (bmax[i3 + 1] > nmaxy) nmaxy = bmax[i3 + 1];
      if (bmax[i3 + 2] > nmaxz) nmaxz = bmax[i3 + 2];
      const cx = cent[i3], cy = cent[i3 + 1], cz = cent[i3 + 2];
      if (cx < cminx) cminx = cx;
      if (cy < cminy) cminy = cy;
      if (cz < cminz) cminz = cz;
      if (cx > cmaxx) cmaxx = cx;
      if (cy > cmaxy) cmaxy = cy;
      if (cz > cmaxz) cmaxz = cz;
    }
    const o6 = node * 6;
    nodeBounds[o6] = nminx;
    nodeBounds[o6 + 1] = nminy;
    nodeBounds[o6 + 2] = nminz;
    nodeBounds[o6 + 3] = nmaxx;
    nodeBounds[o6 + 4] = nmaxy;
    nodeBounds[o6 + 5] = nmaxz;

    const n = end - start;
    const makeLeaf = (): void => {
      nodeInfo[node * 2] = start;
      nodeInfo[node * 2 + 1] = n;
    };
    if (n <= 2) {
      makeLeaf();
      continue;
    }

    // split axis = largest centroid extent
    const ext0 = cmaxx - cminx, ext1 = cmaxy - cminy, ext2 = cmaxz - cminz;
    let axis = 0;
    let cext = ext0;
    if (ext1 > cext) {
      axis = 1;
      cext = ext1;
    }
    if (ext2 > cext) {
      axis = 2;
      cext = ext2;
    }
    const cmin = axis === 0 ? cminx : axis === 1 ? cminy : cminz;

    let mid = -1;
    if (cext > 1e-9) {
      // ---- binned SAH along `axis`
      binCount.fill(0);
      for (let b = 0; b < SAH_BINS; b++) {
        binB[b * 6] = Infinity;
        binB[b * 6 + 1] = Infinity;
        binB[b * 6 + 2] = Infinity;
        binB[b * 6 + 3] = -Infinity;
        binB[b * 6 + 4] = -Infinity;
        binB[b * 6 + 5] = -Infinity;
      }
      const scale = SAH_BINS / cext;
      for (let k = start; k < end; k++) {
        const i = order[k];
        const i3 = i * 3;
        let b = ((cent[i3 + axis] - cmin) * scale) | 0;
        if (b >= SAH_BINS) b = SAH_BINS - 1;
        binCount[b]++;
        const b6 = b * 6;
        if (bmin[i3] < binB[b6]) binB[b6] = bmin[i3];
        if (bmin[i3 + 1] < binB[b6 + 1]) binB[b6 + 1] = bmin[i3 + 1];
        if (bmin[i3 + 2] < binB[b6 + 2]) binB[b6 + 2] = bmin[i3 + 2];
        if (bmax[i3] > binB[b6 + 3]) binB[b6 + 3] = bmax[i3];
        if (bmax[i3 + 1] > binB[b6 + 4]) binB[b6 + 4] = bmax[i3 + 1];
        if (bmax[i3 + 2] > binB[b6 + 5]) binB[b6 + 5] = bmax[i3 + 2];
      }
      // sweep from the right
      let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity;
      let rc = 0;
      for (let b = SAH_BINS - 1; b > 0; b--) {
        const b6 = b * 6;
        if (binCount[b] > 0) {
          if (binB[b6] < rx0) rx0 = binB[b6];
          if (binB[b6 + 1] < ry0) ry0 = binB[b6 + 1];
          if (binB[b6 + 2] < rz0) rz0 = binB[b6 + 2];
          if (binB[b6 + 3] > rx1) rx1 = binB[b6 + 3];
          if (binB[b6 + 4] > ry1) ry1 = binB[b6 + 4];
          if (binB[b6 + 5] > rz1) rz1 = binB[b6 + 5];
        }
        rc += binCount[b];
        rightCount[b] = rc;
        rightArea[b] = rc > 0 ? halfArea(rx1 - rx0, ry1 - ry0, rz1 - rz0) : 0;
      }
      // sweep from the left, evaluating split after bin b (left = bins <= b)
      let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity;
      let lc = 0;
      let bestCost = Infinity;
      let bestSplit = -1;
      for (let b = 0; b < SAH_BINS - 1; b++) {
        const b6 = b * 6;
        if (binCount[b] > 0) {
          if (binB[b6] < lx0) lx0 = binB[b6];
          if (binB[b6 + 1] < ly0) ly0 = binB[b6 + 1];
          if (binB[b6 + 2] < lz0) lz0 = binB[b6 + 2];
          if (binB[b6 + 3] > lx1) lx1 = binB[b6 + 3];
          if (binB[b6 + 4] > ly1) ly1 = binB[b6 + 4];
          if (binB[b6 + 5] > lz1) lz1 = binB[b6 + 5];
        }
        lc += binCount[b];
        const rcount = rightCount[b + 1];
        if (lc === 0 || rcount === 0) continue;
        const cost = lc * halfArea(lx1 - lx0, ly1 - ly0, lz1 - lz0) + rcount * rightArea[b + 1];
        if (cost < bestCost) {
          bestCost = cost;
          bestSplit = b;
        }
      }
      const parentArea = halfArea(nmaxx - nminx, nmaxy - nminy, nmaxz - nminz);
      // SAH (traversal cost 1, intersection cost 1): split only if it beats a leaf, or the leaf is too big
      if (bestSplit >= 0 && n <= LEAF_MAX && parentArea > 0 && 1 + bestCost / parentArea >= n) {
        makeLeaf();
        continue;
      }
      if (bestSplit >= 0) {
        // partition
        let i = start;
        let j = end - 1;
        while (i <= j) {
          const ii = order[i];
          let b = ((cent[ii * 3 + axis] - cmin) * scale) | 0;
          if (b >= SAH_BINS) b = SAH_BINS - 1;
          if (b <= bestSplit) {
            i++;
          } else {
            order[i] = order[j];
            order[j] = ii;
            j--;
          }
        }
        mid = i;
        if (mid === start || mid === end) mid = -1;
      }
    }
    if (mid < 0) {
      if (n <= LEAF_MAX) {
        makeLeaf();
        continue;
      }
      // median split along the axis (all centroids equal or SAH failed)
      const sub = Array.from(order.subarray(start, end));
      sub.sort((a, b) => cent[a * 3 + axis] - cent[b * 3 + axis]);
      for (let k = 0; k < n; k++) order[start + k] = sub[k];
      mid = start + (n >> 1);
    }
    nodeInfo[node * 2 + 1] = -(axis + 1);
    // Right child is created later (and patches nodeInfo[node*2]); left child is popped next => node+1.
    pushTask(mid, end, node, depth + 1);
    pushTask(start, mid, -1, depth + 1);
  }
  return { nodeBounds, nodeInfo, nodeCount, order, maxDepth };
}

function halfArea(dx: number, dy: number, dz: number): number {
  return dx * dy + dy * dz + dz * dx;
}

function boundsValid(b: Brush): boolean {
  const lo = b.mins;
  const hi = b.maxs;
  if (!lo || !hi) return false;
  return (
    Number.isFinite(lo.x) && Number.isFinite(lo.y) && Number.isFinite(lo.z) &&
    Number.isFinite(hi.x) && Number.isFinite(hi.y) && Number.isFinite(hi.z) &&
    lo.x <= hi.x && lo.y <= hi.y && lo.z <= hi.z
  );
}

/**
 * The collision world: all player-solid geometry of a map (world brushes, solid brush entities,
 * playerclips, water volumes...). Brush objects stay available as public data; queries run on a
 * flattened copy, so mutating a Brush after construction has no effect.
 */
export class CollisionWorld implements TraceWorld {
  readonly brushes: readonly Brush[];
  /** Index (into `brushes`) of the brush that produced the last traceBox/traceRay hit, or -1. Debug aid. */
  lastHitBrush = -1;

  // ---- per slot (BVH leaf order)
  private readonly slotCount: number;
  private readonly slotBrush: Int32Array;
  private readonly slotContents: Int32Array;
  private readonly slotModel: Int32Array;
  private readonly slotEnabled: Uint8Array;
  private readonly slotBounds: Float64Array; // 6 per slot
  private readonly slotSideStart: Int32Array; // slotCount + 1
  // ---- per side (grouped by slot, original side order within a brush)
  private readonly planes: Float64Array; // nx ny nz dist
  private readonly sideBevel: Uint8Array;
  // ---- BVH
  private readonly nodeBounds: Float64Array;
  private readonly nodeInfo: Int32Array;
  private readonly nodeCount: number;
  private readonly bvhDepth: number;
  private readonly stack: Int32Array;
  private queryStack: Int32Array;
  private queryBusy = false;
  // ---- models
  private readonly disabledModels = new Set<number>();
  private readonly modelSlots = new Map<number, number[]>();

  constructor(brushes: Brush[]) {
    this.brushes = brushes;
    // gather valid brushes
    const valid: number[] = [];
    for (let i = 0; i < brushes.length; i++) {
      const b = brushes[i];
      if (!b || !b.sides || b.sides.length === 0) continue;
      if (!boundsValid(b) && !computeBrushBounds(b)) continue;
      valid.push(i);
    }
    const count = valid.length;
    const bmin = new Float64Array(count * 3);
    const bmax = new Float64Array(count * 3);
    for (let k = 0; k < count; k++) {
      const b = brushes[valid[k]];
      bmin[k * 3] = b.mins.x;
      bmin[k * 3 + 1] = b.mins.y;
      bmin[k * 3 + 2] = b.mins.z;
      bmax[k * 3] = b.maxs.x;
      bmax[k * 3 + 1] = b.maxs.y;
      bmax[k * 3 + 2] = b.maxs.z;
    }
    const bvh = buildBvh(count, bmin, bmax);
    this.nodeBounds = bvh.nodeBounds;
    this.nodeInfo = bvh.nodeInfo;
    this.nodeCount = bvh.nodeCount;
    this.bvhDepth = bvh.maxDepth;
    this.stack = new Int32Array(bvh.maxDepth * 2 + 8);
    this.queryStack = new Int32Array(bvh.maxDepth * 2 + 8);

    // flatten in slot order
    this.slotCount = count;
    this.slotBrush = new Int32Array(count);
    this.slotContents = new Int32Array(count);
    this.slotModel = new Int32Array(count);
    this.slotEnabled = new Uint8Array(count);
    this.slotBounds = new Float64Array(count * 6);
    this.slotSideStart = new Int32Array(count + 1);
    let totalSides = 0;
    for (let k = 0; k < count; k++) totalSides += brushes[valid[k]].sides.length;
    this.planes = new Float64Array(totalSides * 4);
    this.sideBevel = new Uint8Array(totalSides);
    let s = 0;
    for (let slot = 0; slot < count; slot++) {
      const k = bvh.order[slot];
      const bi = valid[k];
      const b = brushes[bi];
      this.slotBrush[slot] = bi;
      this.slotContents[slot] = b.contents | 0;
      const model = b.model | 0;
      this.slotModel[slot] = model;
      this.slotEnabled[slot] = 1;
      let list = this.modelSlots.get(model);
      if (!list) {
        list = [];
        this.modelSlots.set(model, list);
      }
      list.push(slot);
      const o6 = slot * 6;
      this.slotBounds[o6] = bmin[k * 3];
      this.slotBounds[o6 + 1] = bmin[k * 3 + 1];
      this.slotBounds[o6 + 2] = bmin[k * 3 + 2];
      this.slotBounds[o6 + 3] = bmax[k * 3];
      this.slotBounds[o6 + 4] = bmax[k * 3 + 1];
      this.slotBounds[o6 + 5] = bmax[k * 3 + 2];
      this.slotSideStart[slot] = s;
      for (const side of b.sides) {
        const n = side.plane.normal;
        this.planes[s * 4] = n.x;
        this.planes[s * 4 + 1] = n.y;
        this.planes[s * 4 + 2] = n.z;
        this.planes[s * 4 + 3] = side.plane.dist;
        this.sideBevel[s] = side.bevel ? 1 : 0;
        s++;
      }
    }
    this.slotSideStart[count] = s;
  }

  /** BVH statistics (debugging / perf logging). */
  stats(): { brushes: number; sides: number; nodes: number; depth: number } {
    return { brushes: this.slotCount, sides: this.sideBevel.length, nodes: this.nodeCount, depth: this.bvhDepth };
  }

  // ------------------------------------------------------------------------------------------- models

  /** func_brush style Enable/Disable: disabled models are ignored by every query. */
  setModelSolid(model: number, solid: boolean): void {
    if (solid) this.disabledModels.delete(model);
    else this.disabledModels.add(model);
    const slots = this.modelSlots.get(model);
    if (slots) for (const slot of slots) this.slotEnabled[slot] = solid ? 1 : 0;
  }

  isModelSolid(model: number): boolean {
    return !this.disabledModels.has(model);
  }

  // ------------------------------------------------------------------------------------------- traces

  /**
   * Sweeps the box [mins, maxs] (relative to the origin) from start to end against enabled brushes whose
   * contents intersect `mask`. endpos is in the origin frame. Allocation-free when `out` is given.
   */
  traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number, out?: TraceResult): TraceResult {
    // Read every input before touching `out`: callers commonly pass out.endpos as the next start.
    const x0 = start.x;
    const y0 = start.y;
    const z0 = start.z;
    const x1 = end.x;
    const y1 = end.y;
    const z1 = end.z;
    // box center offset and half extents
    const ox = (mins.x + maxs.x) * 0.5;
    const oy = (mins.y + maxs.y) * 0.5;
    const oz = (mins.z + maxs.z) * 0.5;
    let ex = Math.abs(maxs.x - mins.x) * 0.5;
    let ey = Math.abs(maxs.y - mins.y) * 0.5;
    let ez = Math.abs(maxs.z - mins.z) * 0.5;
    const isPoint = ex * ex + ey * ey + ez * ez < POINT_EXTENT_SQ;
    if (isPoint) {
      ex = 0;
      ey = 0;
      ez = 0;
    }
    const sx = x0 + ox;
    const sy = y0 + oy;
    const sz = z0 + oz;
    const tx = x1 + ox;
    const ty = y1 + oy;
    const tz = z1 + oz;
    const dx = tx - sx;
    const dy = ty - sy;
    const dz = tz - sz;
    // inverse direction for slab tests (+-Infinity for 0 is handled by NaN-safe comparisons below)
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const bx = ex + BROAD_MARGIN;
    const by = ey + BROAD_MARGIN;
    const bz = ez + BROAD_MARGIN;

    const nodeBounds = this.nodeBounds;
    const nodeInfo = this.nodeInfo;
    const slotBounds = this.slotBounds;
    const slotContents = this.slotContents;
    const slotEnabled = this.slotEnabled;
    const slotSideStart = this.slotSideStart;
    const planes = this.planes;
    const sideBevel = this.sideBevel;
    const stack = this.stack;

    let best = 1;
    let hitSlot = -1;
    let hitSide = -1;
    let solidSlot = -1;
    let startsolid = false;
    let allsolid = false;

    let sp = 0;
    if (this.nodeCount > 0) stack[sp++] = 0;
    traverse: while (sp > 0) {
      const node = stack[--sp];
      // ---- node slab test against [0, best]
      {
        const o = node * 6;
        let tmin = 0;
        let tmax = best;
        let t1 = (nodeBounds[o] - bx - sx) * ix;
        let t2 = (nodeBounds[o + 3] + bx - sx) * ix;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (dx === 0 && (sx < nodeBounds[o] - bx || sx > nodeBounds[o + 3] + bx)) continue;
        t1 = (nodeBounds[o + 1] - by - sy) * iy;
        t2 = (nodeBounds[o + 4] + by - sy) * iy;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (dy === 0 && (sy < nodeBounds[o + 1] - by || sy > nodeBounds[o + 4] + by)) continue;
        t1 = (nodeBounds[o + 2] - bz - sz) * iz;
        t2 = (nodeBounds[o + 5] + bz - sz) * iz;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (dz === 0 && (sz < nodeBounds[o + 2] - bz || sz > nodeBounds[o + 5] + bz)) continue;
        if (tmin > tmax) continue;
      }
      const a = nodeInfo[node * 2];
      const b = nodeInfo[node * 2 + 1];
      if (b < 0) {
        // internal node: visit the child nearer to the start first
        const axis = -b - 1;
        const d = axis === 0 ? dx : axis === 1 ? dy : dz;
        if (d >= 0) {
          stack[sp++] = a;
          stack[sp++] = node + 1;
        } else {
          stack[sp++] = node + 1;
          stack[sp++] = a;
        }
        continue;
      }
      // ---- leaf: clip against each brush
      const slotEnd = a + b;
      for (let slot = a; slot < slotEnd; slot++) {
        if ((slotContents[slot] & mask) === 0 || slotEnabled[slot] === 0) continue;
        {
          const o = slot * 6;
          let tmin = 0;
          let tmax = best;
          let t1 = (slotBounds[o] - bx - sx) * ix;
          let t2 = (slotBounds[o + 3] + bx - sx) * ix;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dx === 0 && (sx < slotBounds[o] - bx || sx > slotBounds[o + 3] + bx)) continue;
          t1 = (slotBounds[o + 1] - by - sy) * iy;
          t2 = (slotBounds[o + 4] + by - sy) * iy;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dy === 0 && (sy < slotBounds[o + 1] - by || sy > slotBounds[o + 4] + by)) continue;
          t1 = (slotBounds[o + 2] - bz - sz) * iz;
          t2 = (slotBounds[o + 5] + bz - sz) * iz;
          if (t1 > t2) {
            const t = t1;
            t1 = t2;
            t2 = t;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (dz === 0 && (sz < slotBounds[o + 2] - bz || sz > slotBounds[o + 5] + bz)) continue;
          if (tmin > tmax) continue;
        }

        let enterfrac = -1;
        let leavefrac = 1;
        let startout = false;
        let getout = false;
        let lead = -1;
        let missed = false;
        const sEnd = slotSideStart[slot + 1];
        for (let s = slotSideStart[slot]; s < sEnd; s++) {
          if (isPoint && sideBevel[s] !== 0) continue;
          const p4 = s * 4;
          const nx = planes[p4];
          const ny = planes[p4 + 1];
          const nz = planes[p4 + 2];
          // plane pushed out by the box extents
          const dist =
            planes[p4 + 3] + (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
          const d1 = nx * sx + ny * sy + nz * sz - dist;
          const d2 = nx * tx + ny * ty + nz * tz - dist;
          if (d2 > 0) getout = true;
          if (d1 > 0) {
            startout = true;
            // completely in front of this face for the whole move: no contact with this brush
            if (d2 >= DIST_EPSILON - CLIP_NOISE || d2 >= d1) {
              missed = true;
              break;
            }
          } else if (d2 <= 0) {
            continue; // behind this face for the whole move
          }
          if (d1 > d2) {
            // entering
            const f = (d1 - DIST_EPSILON) / (d1 - d2);
            if (f > enterfrac) {
              enterfrac = f;
              lead = s;
            }
          } else {
            // leaving
            const f = (d1 + DIST_EPSILON) / (d1 - d2);
            if (f < leavefrac) leavefrac = f;
          }
        }
        if (missed) continue;
        if (!startout) {
          // the start position is inside this brush
          startsolid = true;
          if (solidSlot < 0) solidSlot = slot;
          if (!getout) {
            allsolid = true;
            solidSlot = slot;
            break traverse;
          }
          continue;
        }
        if (enterfrac < leavefrac && enterfrac > -1 && enterfrac < best) {
          best = enterfrac < 0 ? 0 : enterfrac;
          hitSlot = slot;
          hitSide = lead;
        }
      }
    }

    const tr = out ?? newTrace();
    const pn = tr.plane.normal;
    pn.x = 0;
    pn.y = 0;
    pn.z = 0;
    tr.plane.dist = 0;
    tr.startsolid = startsolid;
    tr.allsolid = false;
    tr.contents = 0;
    tr.model = -1;
    this.lastHitBrush = -1;
    const ep = tr.endpos;
    if (allsolid) {
      tr.allsolid = true;
      tr.fraction = 0;
      tr.contents = this.slotContents[solidSlot];
      tr.model = this.slotModel[solidSlot];
      ep.x = x0;
      ep.y = y0;
      ep.z = z0;
      return tr;
    }
    tr.fraction = best;
    if (hitSlot >= 0) {
      tr.contents = this.slotContents[hitSlot];
      tr.model = this.slotModel[hitSlot];
      const p4 = hitSide * 4;
      pn.x = planes[p4];
      pn.y = planes[p4 + 1];
      pn.z = planes[p4 + 2];
      tr.plane.dist = planes[p4 + 3];
      this.lastHitBrush = this.slotBrush[hitSlot];
    } else if (startsolid) {
      tr.contents = this.slotContents[solidSlot];
      tr.model = this.slotModel[solidSlot];
    }
    if (best === 1) {
      ep.x = x1;
      ep.y = y1;
      ep.z = z1;
    } else {
      ep.x = x0 + best * (x1 - x0);
      ep.y = y0 + best * (y1 - y0);
      ep.z = z0 + best * (z1 - z0);
    }
    return tr;
  }

  /** Point (ray) trace: bevel planes are ignored. */
  traceRay(start: Vec3, end: Vec3, mask: number, out?: TraceResult): TraceResult {
    return this.traceBox(start, end, ZERO, ZERO, mask, out);
  }

  // ------------------------------------------------------------------------------------------- queries

  /**
   * OR of the contents of all enabled brushes (matching `mask`) that strictly contain the point. Points
   * exactly on a face are outside (like a BSP tree walk, where on-plane points go to the front side).
   */
  pointContents(p: Vec3, mask: number = MASK_ALL): number {
    const px = p.x;
    const py = p.y;
    const pz = p.z;
    const nodeBounds = this.nodeBounds;
    const nodeInfo = this.nodeInfo;
    const slotBounds = this.slotBounds;
    const planes = this.planes;
    const sideBevel = this.sideBevel;
    const stack = this.stack;
    let result = 0;
    let sp = 0;
    if (this.nodeCount > 0) stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      if (
        px < nodeBounds[o] || px > nodeBounds[o + 3] ||
        py < nodeBounds[o + 1] || py > nodeBounds[o + 4] ||
        pz < nodeBounds[o + 2] || pz > nodeBounds[o + 5]
      )
        continue;
      const a = nodeInfo[node * 2];
      const b = nodeInfo[node * 2 + 1];
      if (b < 0) {
        stack[sp++] = a;
        stack[sp++] = node + 1;
        continue;
      }
      for (let slot = a, e = a + b; slot < e; slot++) {
        const c = this.slotContents[slot];
        if ((c & mask) === 0 || this.slotEnabled[slot] === 0 || (result & c) === c) continue;
        const so = slot * 6;
        if (
          px < slotBounds[so] || px > slotBounds[so + 3] ||
          py < slotBounds[so + 1] || py > slotBounds[so + 4] ||
          pz < slotBounds[so + 2] || pz > slotBounds[so + 5]
        )
          continue;
        let inside = true;
        for (let s = this.slotSideStart[slot], se = this.slotSideStart[slot + 1]; s < se; s++) {
          if (sideBevel[s] !== 0) continue;
          const p4 = s * 4;
          if (planes[p4] * px + planes[p4 + 1] * py + planes[p4 + 2] * pz - planes[p4 + 3] >= 0) {
            inside = false;
            break;
          }
        }
        if (inside) result |= c;
      }
    }
    return result & mask;
  }

  /**
   * True if the box [origin+mins, origin+maxs] is in solid for traces: exactly the condition under
   * which traceBox(origin, origin, ...) reports startsolid (touching a face counts as inside).
   */
  testBox(origin: Vec3, mins: Vec3, maxs: Vec3, mask: number): boolean {
    const cx = origin.x + (mins.x + maxs.x) * 0.5;
    const cy = origin.y + (mins.y + maxs.y) * 0.5;
    const cz = origin.z + (mins.z + maxs.z) * 0.5;
    let ex = Math.abs(maxs.x - mins.x) * 0.5;
    let ey = Math.abs(maxs.y - mins.y) * 0.5;
    let ez = Math.abs(maxs.z - mins.z) * 0.5;
    const isPoint = ex * ex + ey * ey + ez * ez < POINT_EXTENT_SQ;
    if (isPoint) {
      ex = 0;
      ey = 0;
      ez = 0;
    }
    const bx = ex + BROAD_MARGIN;
    const by = ey + BROAD_MARGIN;
    const bz = ez + BROAD_MARGIN;
    const nodeBounds = this.nodeBounds;
    const nodeInfo = this.nodeInfo;
    const slotBounds = this.slotBounds;
    const planes = this.planes;
    const sideBevel = this.sideBevel;
    const stack = this.stack;
    let sp = 0;
    if (this.nodeCount > 0) stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      if (
        cx < nodeBounds[o] - bx || cx > nodeBounds[o + 3] + bx ||
        cy < nodeBounds[o + 1] - by || cy > nodeBounds[o + 4] + by ||
        cz < nodeBounds[o + 2] - bz || cz > nodeBounds[o + 5] + bz
      )
        continue;
      const a = nodeInfo[node * 2];
      const b = nodeInfo[node * 2 + 1];
      if (b < 0) {
        stack[sp++] = a;
        stack[sp++] = node + 1;
        continue;
      }
      for (let slot = a, e = a + b; slot < e; slot++) {
        if ((this.slotContents[slot] & mask) === 0 || this.slotEnabled[slot] === 0) continue;
        const so = slot * 6;
        if (
          cx < slotBounds[so] - bx || cx > slotBounds[so + 3] + bx ||
          cy < slotBounds[so + 1] - by || cy > slotBounds[so + 4] + by ||
          cz < slotBounds[so + 2] - bz || cz > slotBounds[so + 5] + bz
        )
          continue;
        let inside = true;
        for (let s = this.slotSideStart[slot], se = this.slotSideStart[slot + 1]; s < se; s++) {
          if (isPoint && sideBevel[s] !== 0) continue;
          const p4 = s * 4;
          const nx = planes[p4];
          const ny = planes[p4 + 1];
          const nz = planes[p4 + 2];
          const dist =
            planes[p4 + 3] + (nx < 0 ? -nx : nx) * ex + (ny < 0 ? -ny : ny) * ey + (nz < 0 ? -nz : nz) * ez;
          if (nx * cx + ny * cy + nz * cz - dist > 0) {
            inside = false;
            break;
          }
        }
        if (inside) return true;
      }
    }
    return false;
  }

  /** Calls cb for every enabled brush whose AABB overlaps (or touches) [mins, maxs]. Any contents. */
  queryBox(mins: Vec3, maxs: Vec3, cb: (b: Brush) => void): void {
    // re-entrant: a callback may run another query
    let stack = this.queryStack;
    const ownStack = !this.queryBusy;
    if (!ownStack) stack = new Int32Array(this.queryStack.length);
    this.queryBusy = true;
    try {
      const nodeBounds = this.nodeBounds;
      const nodeInfo = this.nodeInfo;
      const slotBounds = this.slotBounds;
      const x0 = mins.x, y0 = mins.y, z0 = mins.z, x1 = maxs.x, y1 = maxs.y, z1 = maxs.z;
      let sp = 0;
      if (this.nodeCount > 0) stack[sp++] = 0;
      while (sp > 0) {
        const node = stack[--sp];
        const o = node * 6;
        if (
          x1 < nodeBounds[o] || x0 > nodeBounds[o + 3] ||
          y1 < nodeBounds[o + 1] || y0 > nodeBounds[o + 4] ||
          z1 < nodeBounds[o + 2] || z0 > nodeBounds[o + 5]
        )
          continue;
        const a = nodeInfo[node * 2];
        const b = nodeInfo[node * 2 + 1];
        if (b < 0) {
          stack[sp++] = a;
          stack[sp++] = node + 1;
          continue;
        }
        for (let slot = a, e = a + b; slot < e; slot++) {
          if (this.slotEnabled[slot] === 0) continue;
          const so = slot * 6;
          if (
            x1 < slotBounds[so] || x0 > slotBounds[so + 3] ||
            y1 < slotBounds[so + 1] || y0 > slotBounds[so + 4] ||
            z1 < slotBounds[so + 2] || z0 > slotBounds[so + 5]
          )
            continue;
          cb(this.brushes[this.slotBrush[slot]]);
        }
      }
    } finally {
      if (ownStack) this.queryBusy = false;
    }
  }
}

/**
 * Exact overlap test of an absolute AABB against a convex brush, using the brush planes (bevels
 * included) pushed out by the box half-extents. Touching faces do not count as intersecting.
 * Used for trigger touching.
 */
export function boxIntersectsBrush(boxMins: Vec3, boxMaxs: Vec3, brush: Brush): boolean {
  const bm = brush.mins;
  const bM = brush.maxs;
  // axial separation first (also covers brushes that lack axial bevels)
  if (boxMaxs.x <= bm.x || boxMins.x >= bM.x) return false;
  if (boxMaxs.y <= bm.y || boxMins.y >= bM.y) return false;
  if (boxMaxs.z <= bm.z || boxMins.z >= bM.z) return false;
  const cx = (boxMins.x + boxMaxs.x) * 0.5;
  const cy = (boxMins.y + boxMaxs.y) * 0.5;
  const cz = (boxMins.z + boxMaxs.z) * 0.5;
  const ex = Math.abs(boxMaxs.x - boxMins.x) * 0.5;
  const ey = Math.abs(boxMaxs.y - boxMins.y) * 0.5;
  const ez = Math.abs(boxMaxs.z - boxMins.z) * 0.5;
  const sides = brush.sides;
  for (let i = 0; i < sides.length; i++) {
    const p = sides[i].plane;
    const n = p.normal;
    const dist = p.dist + Math.abs(n.x) * ex + Math.abs(n.y) * ey + Math.abs(n.z) * ez;
    if (n.x * cx + n.y * cy + n.z * cz - dist >= 0) return false;
  }
  return true;
}
