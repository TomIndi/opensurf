// BSP tree queries: point -> leaf, brush ownership per brush model, and BSP area per face.
import { Vec3 } from '../core/vec3';
import { BspFile } from './types';

/**
 * Leaf index containing point `p`, walking down from `headNode` (default: the world model's head node).
 * Front side (dot(n, p) - dist >= 0) is children[0], like the engine's point-in-leaf walk.
 * Returns -1 for an empty or corrupt tree.
 */
export function pointLeaf(bsp: BspFile, p: Vec3, headNode?: number): number {
  let node = headNode ?? (bsp.models.length > 0 ? bsp.models[0].headNode : 0);
  const nodes = bsp.nodes;
  const planes = bsp.planes;
  if (nodes.length === 0) return bsp.leafs.length > 0 ? 0 : -1;
  let guard = nodes.length + 1;
  while (node >= 0) {
    if (--guard < 0 || node >= nodes.length) return -1; // corrupt tree (cycle / bad index)
    const n = nodes[node];
    const pl = planes[n.planeNum];
    if (!pl) return -1;
    // Full dot product even for axial plane types: the stored normal of an axial plane may be negative.
    const d = pl.normal.x * p.x + pl.normal.y * p.y + pl.normal.z * p.z - pl.dist;
    node = d >= 0 ? n.children[0] : n.children[1];
  }
  return -node - 1;
}

/** Contents of the leaf containing `p` in the world tree (0 if out of range). */
export function pointLeafContents(bsp: BspFile, p: Vec3, headNode?: number): number {
  const leaf = pointLeaf(bsp, p, headNode);
  return leaf >= 0 && leaf < bsp.leafs.length ? bsp.leafs[leaf].contents : 0;
}

/**
 * Visits every leaf reachable from `headNode` (a node index, or a negative leaf reference -(leaf+1)).
 * Iterative (no recursion limits on deep trees); each leaf/node visited at most once.
 */
export function forEachLeaf(bsp: BspFile, headNode: number, cb: (leaf: number) => void): void {
  const nodes = bsp.nodes;
  const nLeafs = bsp.leafs.length;
  const seenNode = new Uint8Array(nodes.length);
  const stack: number[] = [headNode];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n < 0) {
      const leaf = -n - 1;
      if (leaf < nLeafs) cb(leaf);
      continue;
    }
    if (n >= nodes.length || seenNode[n]) continue;
    seenNode[n] = 1;
    const node = nodes[n];
    stack.push(node.children[1], node.children[0]);
  }
}

/**
 * Indices of the brushes referenced by the leaves of model `model`'s subtree (unique, ascending).
 * Model 0 is the world (including func_detail and other compile-time-merged brushes); every brush
 * entity ("*N") has its own subtree with its own brushes.
 */
export function modelBrushIndices(bsp: BspFile, model: number): number[] {
  const m = bsp.models[model];
  if (!m) return [];
  const nBrushes = bsp.brushes.length;
  const mark = new Uint8Array(nBrushes);
  const lb = bsp.leafBrushes;
  forEachLeaf(bsp, m.headNode, (leaf) => {
    const l = bsp.leafs[leaf];
    const end = Math.min(l.firstLeafBrush + l.numLeafBrushes, lb.length);
    for (let i = l.firstLeafBrush; i < end; i++) {
      const b = lb[i];
      if (b < nBrushes) mark[b] = 1;
    }
  });
  const out: number[] = [];
  for (let i = 0; i < nBrushes; i++) if (mark[i]) out.push(i);
  return out;
}

/**
 * Unique, ascending brush indices of every model in one pass (lists[m] = modelBrushIndices(bsp, m)).
 * Linear in the size of the trees, unlike calling modelBrushIndices once per model.
 */
export function allModelBrushIndices(bsp: BspFile): number[][] {
  const nBrushes = bsp.brushes.length;
  const stamp = new Int32Array(nBrushes).fill(-1);
  const seenNode = new Int32Array(bsp.nodes.length).fill(-1);
  const lb = bsp.leafBrushes;
  const nodes = bsp.nodes;
  const lists: number[][] = [];
  const stack: number[] = [];
  for (let m = 0; m < bsp.models.length; m++) {
    const list: number[] = [];
    stack.length = 0;
    stack.push(bsp.models[m].headNode);
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n < 0) {
        const l = bsp.leafs[-n - 1];
        if (!l) continue;
        const end = Math.min(l.firstLeafBrush + l.numLeafBrushes, lb.length);
        for (let i = l.firstLeafBrush; i < end; i++) {
          const b = lb[i];
          if (b < nBrushes && stamp[b] !== m) {
            stamp[b] = m;
            list.push(b);
          }
        }
        continue;
      }
      if (n >= nodes.length || seenNode[n] === m) continue;
      seenNode[n] = m;
      stack.push(nodes[n].children[1], nodes[n].children[0]);
    }
    list.sort((a, b) => a - b);
    lists.push(list);
  }
  return lists;
}

/**
 * Brush index -> owning model for every brush (-1 = not referenced by any model tree). When a brush is
 * referenced from several model trees (never happens with vbsp output) the lowest model index wins.
 */
export function brushModelMap(bsp: BspFile): Int32Array {
  const owner = new Int32Array(bsp.brushes.length).fill(-1);
  const lists = allModelBrushIndices(bsp);
  for (let m = lists.length - 1; m >= 0; m--) for (const b of lists[m]) owner[b] = m;
  return owner;
}

/**
 * A point just in front of face `f` (the displaced surface's centre for displacement faces), or null for
 * malformed faces. Used to find the leaf/area of faces that no leaf lists.
 */
export function faceProbePoint(bsp: BspFile, f: number, offset = 2): Vec3 | null {
  const face = bsp.faces[f];
  if (!face || face.numEdges < 3) return null;
  const plane = bsp.planes[face.planeNum];
  if (!plane) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < face.numEdges; i++) {
    const se = bsp.surfedges[face.firstEdge + i];
    if (se === undefined) return null;
    const v = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
    if (v === undefined || v * 3 + 2 >= bsp.vertices.length) return null;
    x += bsp.vertices[v * 3];
    y += bsp.vertices[v * 3 + 1];
    z += bsp.vertices[v * 3 + 2];
  }
  x /= face.numEdges;
  y /= face.numEdges;
  z /= face.numEdges;
  const d = face.dispInfo >= 0 ? bsp.dispInfos[face.dispInfo] : undefined;
  if (d && d.power >= 1 && d.power <= 4) {
    // The bilinear base grid averages to the corner average, so the surface centre is that plus the mean
    // displacement offset.
    const side = (1 << d.power) + 1;
    const n = side * side;
    if (d.dispVertStart >= 0 && d.dispVertStart + n <= bsp.dispVerts.length) {
      let ox = 0;
      let oy = 0;
      let oz = 0;
      for (let i = 0; i < n; i++) {
        const dv = bsp.dispVerts[d.dispVertStart + i];
        ox += dv.vec.x * dv.dist;
        oy += dv.vec.y * dv.dist;
        oz += dv.vec.z * dv.dist;
      }
      x += ox / n;
      y += oy / n;
      z += oz / n;
    }
  }
  const s = face.side ? -offset : offset;
  return { x: x + plane.normal.x * s, y: y + plane.normal.y * s, z: z + plane.normal.z * s };
}

/**
 * BSP area per face, from the leaves that reference the face through leaffaces (-1 if no leaf references
 * it, e.g. brush entity faces). If leaves in several areas reference a face, the first non-zero area wins
 * (area 0 is the "outside / solid" area). World faces no leaf lists (displacement base faces) get the area
 * of the leaf just in front of their surface. This is the portal-flood area used to tell the 3D skybox
 * apart from the playable map - not dface_t.area, which is the face's surface area.
 */
export function faceAreas(bsp: BspFile): Int32Array {
  const areas = new Int32Array(bsp.faces.length).fill(-1);
  const lf = bsp.leafFaces;
  const nFaces = bsp.faces.length;
  for (const leaf of bsp.leafs) {
    const a = leaf.area;
    const end = Math.min(leaf.firstLeafFace + leaf.numLeafFaces, lf.length);
    for (let i = leaf.firstLeafFace; i < end; i++) {
      const f = lf[i];
      if (f >= nFaces) continue;
      const cur = areas[f];
      if (cur === -1 || (cur === 0 && a > 0)) areas[f] = a;
    }
  }
  // World faces that no leaf lists (displacement base faces, mainly): use the leaf just in front of the
  // (displaced) surface. Brush entity faces stay -1: they live in model space.
  const world = bsp.models[0];
  if (world) {
    const end = Math.min(world.firstFace + world.numFaces, nFaces);
    for (let f = Math.max(0, world.firstFace); f < end; f++) {
      if (areas[f] !== -1) continue;
      const p = faceProbePoint(bsp, f);
      if (!p) continue;
      const leaf = pointLeaf(bsp, p);
      if (leaf < 0 || leaf >= bsp.leafs.length) continue;
      const l = bsp.leafs[leaf];
      if (l.contents & 1 /* CONTENTS_SOLID */) continue;
      areas[f] = l.area;
    }
  }
  return areas;
}
