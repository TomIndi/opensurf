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
  const sign = face.side ? -1 : 1;
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
  };
  const acc = accumulateNormals(mesh);
  finishNormals(mesh, acc);
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
  type Ref = { m: number; v: number };
  const groups = new Map<string, Ref[]>();
  const accs: Float64Array[] = meshes.map((m) => accumulateNormals(m));
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    const n = m.size;
    const P = m.positions;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (r !== 0 && r !== n - 1 && c !== 0 && c !== n - 1) continue;
        const v = r * n + c;
        const key = `${Math.round(P[v * 3] * q)},${Math.round(P[v * 3 + 1] * q)},${Math.round(P[v * 3 + 2] * q)}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push({ m: mi, v });
      }
    }
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let multi = false;
    for (let i = 1; i < g.length; i++) if (g[i].m !== g[0].m) multi = true;
    if (!multi) continue;
    // Sum only the contributions that face the same way as the first vertex (keeps back-to-back
    // displacements, e.g. both sides of a thin wall, apart).
    const a0 = accs[g[0].m];
    const o0 = g[0].v * 3;
    const ref = [a0[o0], a0[o0 + 1], a0[o0 + 2]];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    const members: Ref[] = [];
    for (const r of g) {
      const a = accs[r.m];
      const o = r.v * 3;
      if (a[o] * ref[0] + a[o + 1] * ref[1] + a[o + 2] * ref[2] < 0) continue;
      sx += a[o];
      sy += a[o + 1];
      sz += a[o + 2];
      members.push(r);
    }
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (!(len > 1e-12) || members.length < 2) continue;
    for (const r of members) {
      const N = meshes[r.m].normals;
      const o = r.v * 3;
      N[o] = sx / len;
      N[o + 1] = sy / len;
      N[o + 2] = sz / len;
    }
  }
}

/** Builds every displacement's mesh (null entries for malformed ones) and welds the seams. */
export function buildDisplacementMeshes(bsp: BspFile, smoothSeams = true): (DisplacementMesh | null)[] {
  const out: (DisplacementMesh | null)[] = [];
  for (let i = 0; i < bsp.dispInfos.length; i++) out.push(buildDisplacementMesh(bsp, i));
  if (smoothSeams) smoothDisplacementSeams(out.filter((m): m is DisplacementMesh => !!m));
  return out;
}
