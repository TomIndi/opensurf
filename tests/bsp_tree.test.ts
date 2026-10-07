// BSP tree query tests on the synthetic box world.
import { describe, expect, it } from 'vitest';
import { allModelBrushIndices, brushModelMap, faceAreas, forEachLeaf, modelBrushIndices, pointLeaf, pointLeafContents } from '../src/bsp/bsptree';
import { parseBsp } from '../src/bsp/reader';
import { BspFile } from '../src/bsp/types';
import { buildBoxWorld } from './fixtures/bsp_synth';

describe('bsptree', () => {
  const bsp = parseBsp(buildBoxWorld().buffer);

  it('pointLeaf walks the world tree (front side wins on the plane)', () => {
    expect(pointLeaf(bsp, { x: 0, y: 0, z: 10 })).toBe(1);
    expect(pointLeaf(bsp, { x: 0, y: 0, z: -10 })).toBe(0);
    expect(pointLeaf(bsp, { x: 0, y: 0, z: 0 })).toBe(1);
    expect(pointLeafContents(bsp, { x: 5, y: 5, z: -1 })).toBe(1);
    expect(pointLeafContents(bsp, { x: 5, y: 5, z: 1 })).toBe(0);
  });

  it('pointLeaf accepts a head node or a leaf reference', () => {
    expect(pointLeaf(bsp, { x: 5, y: 0, z: 0 }, 1)).toBe(2);
    expect(pointLeaf(bsp, { x: -5, y: 0, z: 0 }, 1)).toBe(3);
    expect(pointLeaf(bsp, { x: 0, y: 0, z: 0 }, -5)).toBe(4);
  });

  it('pointLeaf terminates on a corrupt (cyclic) tree', () => {
    const cyclic = { ...bsp, nodes: [{ ...bsp.nodes[0], children: [0, 0] as [number, number] }] } as BspFile;
    expect(pointLeaf(cyclic, { x: 0, y: 0, z: 1 })).toBe(-1);
    let n = 0;
    forEachLeaf(cyclic, 0, () => n++);
    expect(n).toBe(0);
  });

  it('collects unique brushes per model subtree', () => {
    expect(modelBrushIndices(bsp, 0)).toEqual([0]);
    expect(modelBrushIndices(bsp, 1)).toEqual([1]); // referenced by two leaves, listed once
    expect(modelBrushIndices(bsp, 2)).toEqual([2]);
    expect(modelBrushIndices(bsp, 3)).toEqual([]);
    expect(Array.from(brushModelMap(bsp))).toEqual([0, 1, 2]);
    expect(allModelBrushIndices(bsp)).toEqual([[0], [1], [2]]);
  });

  it('visits each leaf of a subtree once', () => {
    const seen: number[] = [];
    forEachLeaf(bsp, 0, (l) => seen.push(l));
    expect(seen.sort()).toEqual([0, 1]);
    seen.length = 0;
    forEachLeaf(bsp, -4, (l) => seen.push(l));
    expect(seen).toEqual([3]);
  });

  it('assigns BSP areas to faces through leaffaces', () => {
    expect(Array.from(faceAreas(bsp))).toEqual([1, 1]);
    // a face referenced by no leaf gets -1; area 0 is replaced by a later non-zero area
    const custom = {
      ...bsp,
      faces: [...bsp.faces, bsp.faces[0]],
      leafs: [
        { ...bsp.leafs[0], area: 0, firstLeafFace: 0, numLeafFaces: 1 },
        { ...bsp.leafs[1], area: 5, firstLeafFace: 0, numLeafFaces: 2 },
      ],
    } as BspFile;
    expect(Array.from(faceAreas(custom))).toEqual([5, 5, -1]);
  });
});
