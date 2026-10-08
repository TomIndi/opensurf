// Texture coordinates near zero.
//
// BSP texture coordinates are world-anchored: a face far from the map origin has u, v of tens to hundreds of
// texture repeats (surf_kitsune's spawn floor: up to +-124). Rasterizers interpolate u/w across a triangle in
// 32-bit floats, so on a huge floor triangle clipped by the near plane the far end's coordinates lose their
// low bits: thin grid lines break into torn, shimmering dashes in a band across the floor (SwiftShader shows it
// plainly; GPUs to a lesser degree). Shifting each connected piece of a mesh (a face, a displacement) by a
// whole number of texture repeats changes no texel - the textures wrap - but keeps the interpolated values
// small. The shift must stay on the lattice of every texture lookup made from the coordinates
// ($basetexturetransform, $texture2 transform, $detailscale, the water's half-scale lookup).
import type { MaterialDef } from '../map/types';

/** Largest lattice step tried for fractional texture transforms (e.g. a 0.25 scale needs a step of 4). */
const MAX_STEP = 64;

function integral(x: number): boolean {
  return Math.abs(x - Math.round(x)) < 1e-4;
}

/**
 * The smallest whole number of repeats n (1..64) such that shifting the coordinates by n leaves every texture
 * lookup of the material on whole repeats, or 0 when there is none (the coordinates are then left alone).
 */
export function uvRebaseStep(def: MaterialDef | null | undefined): number {
  const factors: number[] = [];
  const addTransform = (t: readonly number[] | null | undefined) => {
    if (t && t.length >= 6) factors.push(t[0], t[1], t[3], t[4]);
  };
  if (def) {
    addTransform(def.textureTransform);
    addTransform(def.textureTransform2);
    if (def.detail && def.detail.image) factors.push(def.detail.scale[0], def.detail.scale[1]);
    if (def.isWater) factors.push(0.5);
  }
  if (!factors.every((f) => Number.isFinite(f))) return 0;
  for (let n = 1; n <= MAX_STEP; n++) {
    if (factors.every((f) => integral(f * n))) return n;
  }
  return 0;
}

/**
 * Shifts the texture coordinates of every connected piece of an indexed mesh (vertices joined by triangles) by
 * a multiple of `step` repeats so the piece is centred near zero. In place; returns the number of pieces moved.
 * `step` 0 (see uvRebaseStep) does nothing.
 */
export function rebaseUvs(uvs: Float32Array, indices: ArrayLike<number>, vertexCount: number, step = 1): number {
  const n = Math.min(vertexCount, Math.floor(uvs.length / 2));
  if (!(step > 0) || n <= 0) return 0;
  // union-find over the vertices
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    if (a >= n || b >= n || c >= n) continue;
    union(a, b);
    union(a, c);
  }
  // bounds per piece
  const minU = new Float64Array(n).fill(Infinity);
  const maxU = new Float64Array(n).fill(-Infinity);
  const minV = new Float64Array(n).fill(Infinity);
  const maxV = new Float64Array(n).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const u = uvs[i * 2];
    const v = uvs[i * 2 + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    if (u < minU[r]) minU[r] = u;
    if (u > maxU[r]) maxU[r] = u;
    if (v < minV[r]) minV[r] = v;
    if (v > maxV[r]) maxV[r] = v;
  }
  const shiftU = new Float64Array(n);
  const shiftV = new Float64Array(n);
  let moved = 0;
  for (let i = 0; i < n; i++) {
    if (parent[i] !== i || !(minU[i] <= maxU[i])) continue;
    const su = Math.round((minU[i] + maxU[i]) / 2 / step) * step;
    const sv = Math.round((minV[i] + maxV[i]) / 2 / step) * step;
    shiftU[i] = su;
    shiftV[i] = sv;
    if (su !== 0 || sv !== 0) moved++;
  }
  if (!moved) return 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    uvs[i * 2] -= shiftU[r];
    uvs[i * 2 + 1] -= shiftV[r];
  }
  return moved;
}
