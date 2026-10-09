// The BSP's potentially visible sets (LUMP_VISIBILITY, written by vvis) and the world tree, as MapVisibility.
//
// dvis_t: int numclusters; int bitofs[numclusters][2] (PVS, PAS byte offsets from the lump start); rows are
// run-length compressed: a zero byte is followed by a count of zero bytes, any other byte is literal.
import type { MapVisibility } from '../map/types';
import { LUMP_VISIBILITY, type BspFile } from './types';

/** Largest cluster count decompressed (rows x rows bits: 12000 clusters = 18 MB); larger maps draw without PVS. */
export const MAX_VIS_CLUSTERS = 12000;

/** Decompresses one run-length encoded visibility row into `out` (rowBytes long); false if the data ends early. */
export function decompressVisRow(data: Uint8Array, offset: number, out: Uint8Array): boolean {
  let o = 0;
  let i = offset;
  const n = out.length;
  while (o < n) {
    if (i >= data.length) return false;
    const b = data[i];
    if (b !== 0) {
      out[o++] = b;
      i++;
      continue;
    }
    if (i + 1 >= data.length) return false;
    let run = data[i + 1];
    i += 2;
    while (run-- > 0 && o < n) out[o++] = 0;
  }
  return true;
}

/** The map's visibility data, or null when it has none (not vis'd, corrupt, or too many clusters). */
export function buildVisibility(bsp: BspFile): MapVisibility | null {
  const lump = bsp.getLump(LUMP_VISIBILITY);
  if (!lump || lump.length < 4 || !bsp.nodes.length || !bsp.leafs.length) return null;
  const dv = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  const numClusters = dv.getInt32(0, true);
  if (!(numClusters > 0) || numClusters > MAX_VIS_CLUSTERS || 4 + numClusters * 8 > lump.length) return null;
  const rowBytes = (numClusters + 7) >> 3;
  const pvs = new Uint8Array(numClusters * rowBytes);
  for (let c = 0; c < numClusters; c++) {
    const ofs = dv.getInt32(4 + c * 8, true);
    if (ofs < 0 || ofs >= lump.length) return null;
    if (!decompressVisRow(lump, ofs, pvs.subarray(c * rowBytes, (c + 1) * rowBytes))) return null;
  }
  const nodes = bsp.nodes;
  const nodeChildren = new Int32Array(nodes.length * 2);
  const nodePlanes = new Float32Array(nodes.length * 4);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const pl = bsp.planes[n.planeNum];
    if (!pl) return null;
    nodeChildren[i * 2] = n.children[0];
    nodeChildren[i * 2 + 1] = n.children[1];
    nodePlanes[i * 4] = pl.normal.x;
    nodePlanes[i * 4 + 1] = pl.normal.y;
    nodePlanes[i * 4 + 2] = pl.normal.z;
    nodePlanes[i * 4 + 3] = pl.dist;
  }
  const leafCluster = new Int32Array(bsp.leafs.length);
  for (let i = 0; i < bsp.leafs.length; i++) {
    const c = bsp.leafs[i].cluster;
    leafCluster[i] = c >= 0 && c < numClusters ? c : -1;
  }
  const headNode = bsp.models.length > 0 ? bsp.models[0].headNode : 0;
  return { numClusters, pvs, rowBytes, headNode, nodeChildren, nodePlanes, leafCluster };
}
