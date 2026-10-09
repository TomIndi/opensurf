import { BufferAttribute, BufferGeometry, Matrix4, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { buildVisibility, decompressVisRow } from '../src/bsp/visibility';
import { LUMP_VISIBILITY, type BspFile } from '../src/bsp/types';
import type { MapVisibility } from '../src/map/types';
import { PvsCuller, boxClusters, visCluster, visLeaf } from '../src/render/pvs';

/**
 * A row of three rooms along x, split by the planes x = 0 and x = 100 (node 0: x >= 0 -> node 1, else leaf 0;
 * node 1: x >= 100 -> leaf 2, else leaf 1), clusters 0, 1, 2 and a solid leaf 3 (cluster -1) unused by the tree.
 * PVS: 0 sees 0-1, 1 sees all, 2 sees 1-2.
 */
function rooms(): MapVisibility {
  const pvs = new Uint8Array([0b011, 0b111, 0b110]);
  return {
    numClusters: 3,
    rowBytes: 1,
    pvs,
    headNode: 0,
    nodeChildren: new Int32Array([1, -1, -3, -2]),
    nodePlanes: new Float32Array([1, 0, 0, 0, 1, 0, 0, 100]),
    leafCluster: new Int32Array([0, 1, 2, -1]),
  };
}

/** A quad spanning x0..x1 at y = 0. */
function quad(x0: number, x1: number): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([x0, -10, 0, x1, -10, 0, x1, 10, 0, x0, 10, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new Mesh(g, new MeshBasicMaterial());
  m.updateMatrixWorld(true);
  return m;
}

describe('BSP visibility (PVS)', () => {
  it('decompresses run-length encoded rows (a zero byte is followed by a count of zero bytes)', () => {
    const out = new Uint8Array(6);
    expect(decompressVisRow(new Uint8Array([0xff, 0, 3, 0x81, 0x01]), 0, out)).toBe(true);
    expect(Array.from(out)).toEqual([0xff, 0, 0, 0, 0x81, 0x01]);
    expect(decompressVisRow(new Uint8Array([0xff, 0]), 0, out)).toBe(false); // truncated
  });

  it('reads LUMP_VISIBILITY and the world tree from a BSP', () => {
    // dvis_t: numclusters = 2, bitofs = [[20, 0], [21, 0]], rows: 0x01 (cluster 0 sees 0), 0x03 (1 sees 0 and 1)
    const lump = new Uint8Array(22);
    const dv = new DataView(lump.buffer);
    dv.setInt32(0, 2, true);
    dv.setInt32(4, 20, true);
    dv.setInt32(12, 21, true);
    lump[20] = 0x01;
    lump[21] = 0x03;
    const bsp = {
      getLump: (i: number) => (i === LUMP_VISIBILITY ? lump : new Uint8Array(0)),
      nodes: [{ planeNum: 0, children: [-1, -2] }],
      planes: [{ normal: { x: 0, y: 0, z: 1 }, dist: 5, type: 2 }],
      leafs: [{ cluster: 0 }, { cluster: 1 }, { cluster: -1 }],
      models: [{ headNode: 0 }],
    } as unknown as BspFile;
    const v = buildVisibility(bsp)!;
    expect(v.numClusters).toBe(2);
    expect(Array.from(v.pvs)).toEqual([1, 3]);
    expect(Array.from(v.leafCluster)).toEqual([0, 1, -1]);
    expect(visCluster(v, 0, 0, 10)).toBe(0);
    expect(visCluster(v, 0, 0, 0)).toBe(1);
    // no visibility data (not vis'd), corrupt offsets
    expect(buildVisibility({ ...bsp, getLump: () => new Uint8Array(0) } as unknown as BspFile)).toBeNull();
    dv.setInt32(12, 999, true);
    expect(buildVisibility(bsp)).toBeNull();
  });

  it('finds leaves and the clusters a box touches (faces on a node plane touch both sides)', () => {
    const v = rooms();
    expect(visLeaf(v, -50, 0, 0)).toBe(0);
    expect(visLeaf(v, 50, 0, 0)).toBe(1);
    expect(visLeaf(v, 150, 0, 0)).toBe(2);
    const mark = new Uint8Array(3);
    const out: number[] = [];
    boxClusters(v, -10, 0, 0, 10, 0, 0, mark, out, []);
    expect(out.sort()).toEqual([0, 1]);
    const out2: number[] = [];
    boxClusters(v, 100, 0, 0, 100, 5, 5, new Uint8Array(3), out2, []); // a wall on x = 100
    expect(out2.sort()).toEqual([1, 2]);
  });

  it('culls meshes the eye cluster cannot see, via the camera layer (visible stays the game state)', () => {
    const v = rooms();
    const pvs = new PvsCuller(v);
    const a = quad(-90, -60); // room 0
    const b = quad(20, 80); // room 1
    const c = quad(120, 180); // room 2
    const all = quad(-200, 300); // every room: never culled, not kept
    for (const m of [a, b, c]) expect(pvs.add(m)).toBe(true);
    expect(pvs.add(all)).toBe(false);
    expect(pvs.clustersOf(a)).toEqual([0]);
    expect(pvs.count).toBe(3);
    const shown = () => [a, b, c].map((m) => (m.layers.mask & 1) === 1);
    expect(pvs.update(-50, 0, 0)).toBe(true);
    expect(shown()).toEqual([true, true, false]);
    expect(pvs.culled).toBe(1);
    expect(pvs.update(-40, 0, 0)).toBe(false); // same cluster: nothing to do
    pvs.update(150, 0, 0);
    expect(shown()).toEqual([false, true, true]);
    pvs.update(50, 0, 0);
    expect(shown()).toEqual([true, true, true]);
    // r_novis, or an eye in solid / outside the data: everything
    pvs.update(150, 0, 0, false);
    expect(shown()).toEqual([true, true, true]);
    v.leafCluster[2] = -1;
    pvs.update(150, 0, 0);
    expect(shown()).toEqual([true, true, true]);
    expect(a.visible && b.visible && c.visible).toBe(true);
    pvs.clear();
    expect(pvs.count).toBe(0);
  });

  it('uses world-space positions', () => {
    const pvs = new PvsCuller(rooms());
    const m = quad(-90, -60);
    m.matrixAutoUpdate = false;
    m.matrix.copy(new Matrix4().makeTranslation(250, 0, 0)); // now in room 2
    m.updateMatrixWorld(true);
    pvs.add(m);
    expect(pvs.clustersOf(m)).toEqual([2]);
  });
});
