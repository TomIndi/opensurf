import { BufferAttribute, BufferGeometry, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Sphere, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { MAX_SORT_GROUPS, TranslucentSorter, groupFarness, groupTrianglesByPlane, sidePlanes, sphereInSidePlanes } from '../src/render/translucency';

/** n horizontal 100x100 quads stacked 8 units apart (z = 0, -8, -16, ...), like kitsune's glowing grid floors. */
function stackedLayers(n: number, big = false): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const z = k ? -8 * k : 0;
    const v = pos.length / 3;
    pos.push(-50, -50, z, 50, -50, z, 50, 50, z, -50, 50, z);
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(new BufferAttribute(big ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  const m = new Mesh(g, new MeshBasicMaterial({ transparent: true }));
  m.updateMatrixWorld(true);
  return m;
}

/** z of the layer each drawn triangle pair belongs to, in draw order. */
function drawnLayers(m: Mesh): number[] {
  const idx = m.geometry.index!;
  const pos = m.geometry.getAttribute('position');
  const out: number[] = [];
  for (let t = 0; t < idx.count; t += 6) out.push(Math.round(pos.getZ(idx.getX(t))) + 0);
  return out;
}

describe('translucent plane sorting', () => {
  it('groups triangles by plane (both windings of a plane are one layer)', () => {
    const m = stackedLayers(3);
    const pos = m.geometry.getAttribute('position').array;
    const idx = Array.from(m.geometry.index!.array);
    // flip the winding of the middle layer: still its own single plane
    [idx[7], idx[8]] = [idx[8], idx[7]];
    [idx[10], idx[11]] = [idx[11], idx[10]];
    const r = groupTrianglesByPlane(pos, idx);
    expect(r.groups).toHaveLength(3);
    expect(r.grouped).toHaveLength(idx.length);
    expect(new Set(r.grouped)).toEqual(new Set(idx));
    for (const g of r.groups) {
      expect(g.count).toBe(6);
      expect(g.min[2]).toBe(g.max[2]);
      expect(g.min[0]).toBe(-50);
      expect(g.max[0]).toBe(50);
    }
  });

  it('draws stacked layers far to near, also when seen edge-on at eye level', () => {
    const m = stackedLayers(5);
    const s = new TranslucentSorter();
    expect(s.add(m)).toBe(true);
    // eye above the stack: the lowest layer first
    s.update(new Vector3(0, -200, 64));
    expect(drawnLayers(m)).toEqual([-32, -24, -16, -8, 0]);
    // eye below: the top layer first
    s.update(new Vector3(0, -200, -300));
    expect(drawnLayers(m)).toEqual([0, -8, -16, -24, -32]);
    // eye inside the stack's height range, to the side: the farthest by height difference first
    s.update(new Vector3(0, -200, -12));
    const order = drawnLayers(m);
    expect(order.slice(0, 2)).toEqual([-32, 0]);
    expect(order.slice(-2).sort()).toEqual([-16, -8].sort());
  });

  it('rewrites the index buffer only when the order changes; skips hidden meshes', () => {
    const m = stackedLayers(4, true);
    const s = new TranslucentSorter();
    s.add(m);
    s.update(new Vector3(0, 0, 100));
    const n = s.rewrites;
    s.update(new Vector3(10, 5, 120));
    expect(s.rewrites).toBe(n);
    m.visible = false;
    s.update(new Vector3(0, 0, -100));
    expect(s.rewrites).toBe(n);
    m.visible = true;
    s.update(new Vector3(0, 0, -100));
    expect(s.rewrites).toBe(n + 1);
    expect(drawnLayers(m)).toEqual([0, -8, -16, -24]);
    expect(m.geometry.index!.array).toBeInstanceOf(Uint32Array);
  });

  it('ignores single-plane meshes and meshes without an index', () => {
    const s = new TranslucentSorter();
    expect(s.add(stackedLayers(1))).toBe(false);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    expect(s.add(new Mesh(g))).toBe(false);
    expect(s.count).toBe(0);
  });

  it('uses world-space boxes (3D skybox meshes are scaled about the sky camera)', () => {
    const m = stackedLayers(3);
    m.matrixAutoUpdate = false;
    m.matrix.copy(new Matrix4().makeScale(16, 16, 16).setPosition(1000, 0, 0));
    m.updateMatrixWorld(true);
    const s = new TranslucentSorter();
    s.add(m);
    const order = s.orderOf(m)!;
    expect(order.map((c) => Math.round(c.z)).sort((a, b) => a - b)).toEqual([-256, -128, 0]);
    expect(Math.round(order[0].x)).toBe(1000);
    s.update(new Vector3(1000, 0, 500));
    expect(drawnLayers(m)).toEqual([-16, -8, 0]); // object-space z, far (lowest) first
  });

  it('farness: box distance, ties broken by the centre', () => {
    const g = { start: 0, count: 3, x: 0, y: 0, z: 0, min: [-10, -10, 0] as [number, number, number], max: [10, 10, 0] as [number, number, number] };
    expect(groupFarness(g, 0, 0, 5)).toBeCloseTo(25 + 1e-4 * 25, 9);
    expect(groupFarness(g, 20, 0, 0)).toBeCloseTo(100 + 1e-4 * 400, 9);
    expect(groupFarness(g, 5, 0, 0)).toBeCloseTo(1e-4 * 25, 9); // inside the box's extent
  });

  it('caps the number of groups', () => {
    const m = stackedLayers(MAX_SORT_GROUPS + 300, true);
    const s = new TranslucentSorter();
    s.add(m);
    expect(s.orderOf(m)!.length).toBeLessThanOrEqual(MAX_SORT_GROUPS);
    // every triangle is still drawn exactly once
    s.update(new Vector3(0, 0, 1000));
    const idx = Array.from(m.geometry.index!.array);
    expect(idx.length).toBe((MAX_SORT_GROUPS + 300) * 6);
    expect(new Set(idx).size).toBe((MAX_SORT_GROUPS + 300) * 4);
  });

  /** Projection x view of a camera at `eye` looking at `target` (Z up). */
  function viewProj(eye: Vector3, target: Vector3): Matrix4 {
    const cam = new PerspectiveCamera(70, 16 / 9, 3, 1 << 20);
    cam.up.set(0, 0, 1);
    cam.position.copy(eye);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    return new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  /** The index list the sorter's current order stands for, rebuilt from scratch. */
  function expectedIndices(s: TranslucentSorter, m: Mesh): number[] {
    const st = (s as unknown as { meshes: { mesh: Mesh; order: Int32Array; views: ArrayLike<number>[] }[] }).meshes.find((x) => x.mesh === m)!;
    const out: number[] = [];
    for (const id of st.order) out.push(...Array.from(st.views[id]));
    return out;
  }

  it('skips meshes outside the view until they come into view, then sorts them', () => {
    const m = stackedLayers(4);
    const s = new TranslucentSorter();
    s.add(m);
    const eye = new Vector3(0, 0, 300);
    // looking up, away from the stack below
    s.update(eye, viewProj(eye, new Vector3(0, 0, 1000)));
    expect(s.rewrites).toBe(0);
    expect(drawnLayers(m)).toEqual([0, -8, -16, -24]); // the load order, not sorted for this eye yet
    // looking down at it from the same spot: sorted now (lowest first)
    s.update(eye, viewProj(eye, new Vector3(0, 0, 0)));
    expect(s.rewrites).toBe(1);
    expect(drawnLayers(m)).toEqual([-24, -16, -8, 0]);
  });

  it('does not re-sort while the eye stays put (the order depends on the eye position only)', () => {
    const m = stackedLayers(6);
    const s = new TranslucentSorter();
    s.add(m);
    const eye = new Vector3(0, -200, 64);
    s.update(eye);
    const order = drawnLayers(m);
    const n = s.rewrites;
    // a different view direction from the same spot: nothing to do
    s.update(eye, viewProj(eye, new Vector3(0, 0, 0)));
    s.update(eye, viewProj(eye, new Vector3(0, 100, -50)));
    expect(s.rewrites).toBe(n);
    expect(drawnLayers(m)).toEqual(order);
  });

  it('rewrites and uploads only the span of groups that moved', () => {
    const m = stackedLayers(40, true);
    const s = new TranslucentSorter();
    s.add(m);
    const idx = m.geometry.index!;
    s.update(new Vector3(0, -200, 1000)); // above: lowest first (reverses the load order)
    expect(Array.from(idx.array)).toEqual(expectedIndices(s, m));
    idx.clearUpdateRanges(); // as three.js does after uploading
    const before = s.uploaded;
    // the eye drops just below the layer at z = -8: only the top few layers swap places
    s.update(new Vector3(0, -200, -10));
    expect(Array.from(idx.array)).toEqual(expectedIndices(s, m));
    const ranges = idx.updateRanges;
    expect(ranges.length).toBe(1);
    expect(ranges[0].count).toBeLessThan(idx.count / 4);
    expect(ranges[0].start + ranges[0].count).toBe(idx.count); // the near (top) layers are drawn last
    expect(s.uploaded - before).toBe(ranges[0].count);
    // pending ranges of a mesh that is not drawn are merged, never dropped
    for (let k = 0; k < 30; k++) s.update(new Vector3(0, -200, k % 2 ? -100 - k : 500 + k));
    expect(idx.updateRanges.length).toBeLessThanOrEqual(8);
    expect(Array.from(idx.array)).toEqual(expectedIndices(s, m));
    const covered = new Uint8Array(idx.count);
    for (const r of idx.updateRanges) covered.fill(1, r.start, r.start + r.count);
    expect(covered.reduce((a, b) => a + b, 0)).toBeGreaterThan(idx.count / 2);
  });

  it('side-plane test: spheres beside or behind the view are out, overlapping ones in', () => {
    const planes = new Float64Array(16);
    sidePlanes(viewProj(new Vector3(0, 0, 0), new Vector3(100, 0, 0)), planes);
    expect(sphereInSidePlanes(planes, new Sphere(new Vector3(500, 0, 0), 10))).toBe(true);
    expect(sphereInSidePlanes(planes, new Sphere(new Vector3(-500, 0, 0), 10))).toBe(false); // behind
    expect(sphereInSidePlanes(planes, new Sphere(new Vector3(0, 800, 0), 10))).toBe(false); // to the left
    expect(sphereInSidePlanes(planes, new Sphere(new Vector3(100, 300, 0), 400))).toBe(true); // overlaps the edge
    expect(sphereInSidePlanes(planes, new Sphere(new Vector3(5000, 0, 4000), 10))).toBe(false); // above the top
  });
});
