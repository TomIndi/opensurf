// Render meshes for displacement surfaces.
//
// Vertex reconstruction is the same as the collision code (bspcollision.displacementSurface): the base face
// is a quad whose corner closest to dispinfo.startPosition is corner 0 (winding order kept); the
// (2^power + 1)^2 grid is the bilinear patch over the corners - row r runs from corner 0 towards corner 1,
// column c from the corner0-corner1 edge towards the corner3-corner2 edge - plus each dispvert's
// vec * dist offset. Triangles alternate their diagonal like the engine (checkerboard by vertex index
// parity) and are wound counter-clockwise seen from the face's front.
//
// Texture coordinates come from the UNDISPLACED grid positions projected with the face's texinfo (the
// texture is stretched over the displaced surface). The lightmap is laid out over the grid itself: vertex
// (r, c) has luxel coordinates (c / (n-1) * w, r / (n-1) * h) for a face lightmap of (w+1) x (h+1) samples
// (verified on real maps: lighting is continuous across displacement seams only with this orientation).
// Normals are smooth (area-weighted triangle normals, optionally welded across neighbouring displacements);
// alphas (blend factor for WorldVertexTransition materials) are dispvert alpha / 255.
import { BspFile } from './types';

export interface DisplacementMesh {
  /** Displacement index. */
  disp: number;
  /** Base face index (dispinfo.mapFace). */
  face: number;
  /** Vertices per side (2^power + 1). */
  size: number;
  /** size*size displaced positions, xyz, row-major (see the file comment). */
  positions: Float64Array;
  /** The same grid without the displacement offsets (on the base face plane). */
  base: Float64Array;
  /** Smooth unit normals per vertex. */
  normals: Float32Array;
  /** Per-vertex blend alpha 0..1. */
  alphas: Float32Array;
  /** 2 * (size-1)^2 triangles, counter-clockwise seen from the front. */
  indices: Uint32Array;
  /** Front-facing normal of the base face (plane normal, flipped for back-side faces). */
  faceNormal: [number, number, number];
  /**
   * Per-vertex sums of the adjacent triangles' unnormalized (area-weighted) normals, kept for seam welding
   * (smoothDisplacementSeams); null once welded.
   */
  normalSums: Float64Array | null;
}

/**
 * Builds the render mesh of displacement `index`, or null when it is malformed (base face not a quad, power
 * outside 1..4, vertex range out of bounds).
 */
export function buildDisplacementMesh(bsp: BspFile, index: number): DisplacementMesh | null {
  const d = bsp.dispInfos[index];
  if (!d) return null;
  const face = bsp.faces[d.mapFace];
  if (!face || face.numEdges !== 4 || d.power < 1 || d.power > 4) return null;
  const size = (1 << d.power) + 1;
  if (d.dispVertStart < 0 || d.dispVertStart + size * size > bsp.dispVerts.length) return null;
  const plane = bsp.planes[face.planeNum];
  if (!plane) return null;

  const cx = [0, 0, 0, 0];
  const cy = [0, 0, 0, 0];
  const cz = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const se = bsp.surfedges[face.firstEdge + i];
    if (se === undefined) return null;
    const vi = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
    if (vi === undefined || vi * 3 + 2 >= bsp.vertices.length) return null;
    cx[i] = bsp.vertices[vi * 3];
    cy[i] = bsp.vertices[vi * 3 + 1];
    cz[i] = bsp.vertices[vi * 3 + 2];
  }
  // corner 0 = the corner closest to startPosition (first one on ties), winding order kept
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const dx = cx[i] - d.startPosition.x;
    const dy = cy[i] - d.startPosition.y;
    const dz = cz[i] - d.startPosition.z;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < best) {
      best = dd;
      start = i;
    }
  }
  const px = [0, 1, 2, 3].map((k) => cx[(start + k) & 3]);
  const py = [0, 1, 2, 3].map((k) => cy[(start + k) & 3]);
  const pz = [0, 1, 2, 3].map((k) => cz[(start + k) & 3]);

  const nv = size * size;
  const positions = new Float64Array(nv * 3);
  const base = new Float64Array(nv * 3);
  const alphas = new Float32Array(nv);
  const inv = 1 / (size - 1);
  for (let r = 0; r < size; r++) {
    const t = r * inv;
    const lx = px[0] + (px[1] - px[0]) * t;
    const ly = py[0] + (py[1] - py[0]) * t;
    const lz = pz[0] + (pz[1] - pz[0]) * t;
    const rx = px[3] + (px[2] - px[3]) * t;
    const ry = py[3] + (py[2] - py[3]) * t;
    const rz = pz[3] + (pz[2] - pz[3]) * t;
    for (let c = 0; c < size; c++) {
      const s = c * inv;
      const v = bsp.dispVerts[d.dispVertStart + r * size + c];
      const k = r * size + c;
      const o = k * 3;
      const bx = lx + (rx - lx) * s;
      const by = ly + (ry - ly) * s;
      const bz = lz + (rz - lz) * s;
      base[o] = bx;
      base[o + 1] = by;
      base[o + 2] = bz;
      positions[o] = bx + v.vec.x * v.dist;
      positions[o + 1] = by + v.vec.y * v.dist;
      positions[o + 2] = bz + v.vec.z * v.dist;
      const a = v.alpha / 255;
      alphas[k] = a > 0 ? (a < 1 ? a : 1) : 0;
    }
  }

  // Winding: (v00, v10, v01) has the winding of cross(corner1 - corner0, corner3 - corner0); make it
  // counter-clockwise around the front normal.
  const sign = 1; // planes[planeNum] already faces the front (vbsp: side = planeNum & 1)
  const fnx = plane.normal.x * sign;
  const fny = plane.normal.y * sign;
  const fnz = plane.normal.z * sign;
  const ux = px[1] - px[0];
  const uy = py[1] - py[0];
  const uz = pz[1] - pz[0];
  const vx = px[3] - px[0];
  const vy = py[3] - py[0];
  const vz = pz[3] - pz[0];
  const flip = (uy * vz - uz * vy) * fnx + (uz * vx - ux * vz) * fny + (ux * vy - uy * vx) * fnz < 0;

  const cells = size - 1;
  const indices = new Uint32Array(cells * cells * 6);
  let n = 0;
  const tri = (a: number, b: number, c: number): void => {
    indices[n++] = a;
    if (flip) {
      indices[n++] = c;
      indices[n++] = b;
    } else {
      indices[n++] = b;
      indices[n++] = c;
    }
  };
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      const i = r * size + c;
      if (i & 1) {
        tri(i, i + size, i + 1);
        tri(i + 1, i + size, i + size + 1);
      } else {
        tri(i, i + size, i + size + 1);
        tri(i, i + size + 1, i + 1);
      }
    }
  }

  const mesh: DisplacementMesh = {
    disp: index,
    face: d.mapFace,
    size,
    positions,
    base,
    normals: new Float32Array(nv * 3),
    alphas,
    indices,
    faceNormal: [fnx, fny, fnz],
    normalSums: null,
  };
  const acc = accumulateNormals(mesh);
  finishNormals(mesh, acc);
  mesh.normalSums = acc;
  return mesh;
}

/** Sum of the (area-weighted, unnormalized) normals of the triangles around each vertex. */
function accumulateNormals(m: DisplacementMesh): Float64Array {
  const P = m.positions;
  const I = m.indices;
  const acc = new Float64Array(P.length);
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3;
    const b = I[k + 1] * 3;
    const c = I[k + 2] * 3;
    const e1x = P[b] - P[a];
    const e1y = P[b + 1] - P[a + 1];
    const e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a];
    const e2y = P[c + 1] - P[a + 1];
    const e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const o of [a, b, c]) {
      acc[o] += nx;
      acc[o + 1] += ny;
      acc[o + 2] += nz;
    }
  }
  return acc;
}

/** Normalizes accumulated normals into m.normals (the face normal where they vanish). */
function finishNormals(m: DisplacementMesh, acc: Float64Array): void {
  const N = m.normals;
  for (let o = 0; o < acc.length; o += 3) {
    const x = acc[o];
    const y = acc[o + 1];
    const z = acc[o + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-12) {
      N[o] = x / len;
      N[o + 1] = y / len;
      N[o + 2] = z / len;
    } else {
      N[o] = m.faceNormal[0];
      N[o + 1] = m.faceNormal[1];
      N[o + 2] = m.faceNormal[2];
    }
  }
}

/**
 * Welds normals across displacement seams: border vertices of different displacements at the same position
 * (within `tolerance` units) whose normals face the same way get the normalized sum of their accumulated
 * triangle normals, so lighting/reflections don't show a crease where two displacements meet. Linear in the
 * number of border vertices.
 */
export function smoothDisplacementSeams(meshes: DisplacementMesh[], tolerance = 0.1): void {
  if (meshes.length < 2) return;
  const q = 1 / Math.max(1e-4, tolerance);
  // border vertex records: mesh, vertex, quantized position
  let count = 0;
  for (const m of meshes) count += 4 * (m.size - 1);
  const recMesh = new Int32Array(count);
  const recVert = new Int32Array(count);
  const qx = new Float64Array(count);
  const qy = new Float64Array(count);
  const qz = new Float64Array(count);
  const buckets = new Map<number, number[]>();
  let n = 0;
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    const sz = m.size;
    const P = m.positions;
    for (let r = 0; r < sz; r++) {
      for (let c = 0; c < sz; c++) {
        if (r !== 0 && r !== sz - 1 && c !== 0 && c !== sz - 1) continue;
        const v = r * sz + c;
        const x = Math.round(P[v * 3] * q);
        const y = Math.round(P[v * 3 + 1] * q);
        const z = Math.round(P[v * 3 + 2] * q);
        recMesh[n] = mi;
        recVert[n] = v;
        qx[n] = x;
        qy[n] = y;
        qz[n] = z;
        const h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) | 0;
        const b = buckets.get(h);
        if (b) b.push(n);
        else buckets.set(h, [n]);
        n++;
      }
    }
  }
  const sums = meshes.map((m) => m.normalSums ?? accumulateNormals(m));
  const members: number[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    // a bucket may hold several positions (hash collisions): group by exact quantized position
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i];
      if (a < 0) continue;
      members.length = 0;
      members.push(a);
      let multi = false;
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j];
        if (b < 0 || qx[b] !== qx[a] || qy[b] !== qy[a] || qz[b] !== qz[a]) continue;
        members.push(b);
        if (recMesh[b] !== recMesh[a]) multi = true;
        bucket[j] = -1;
      }
      if (!multi) continue;
      // Sum the contributions facing the same way as the first one (keeps back-to-back displacements, e.g.
      // both sides of a thin wall, apart).
      const s0 = sums[recMesh[a]];
      const o0 = recVert[a] * 3;
      const rx = s0[o0];
      const ry = s0[o0 + 1];
      const rz = s0[o0 + 2];
      let ax = 0;
      let ay = 0;
      let az = 0;
      let used = 0;
      for (let t = 0; t < members.length; t++) {
        const k = members[t];
        const S = sums[recMesh[k]];
        const o = recVert[k] * 3;
        if (S[o] * rx + S[o + 1] * ry + S[o + 2] * rz < 0) {
          members[t] = -1;
          continue;
        }
        ax += S[o];
        ay += S[o + 1];
        az += S[o + 2];
        used++;
      }
      const len = Math.sqrt(ax * ax + ay * ay + az * az);
      if (!(len > 1e-12) || used < 2) continue;
      for (const k of members) {
        if (k < 0) continue;
        const N = meshes[recMesh[k]].normals;
        const o = recVert[k] * 3;
        N[o] = ax / len;
        N[o + 1] = ay / len;
        N[o + 2] = az / len;
      }
    }
  }
  for (const m of meshes) m.normalSums = null;
}

/** Builds every displacement's mesh (null entries for malformed ones) and welds the seams. */
export function buildDisplacementMeshes(bsp: BspFile, smoothSeams = true): (DisplacementMesh | null)[] {
  const out: (DisplacementMesh | null)[] = [];
  for (let i = 0; i < bsp.dispInfos.length; i++) out.push(buildDisplacementMesh(bsp, i));
  if (smoothSeams) smoothDisplacementSeams(out.filter((m): m is DisplacementMesh => !!m));
  return out;
}
