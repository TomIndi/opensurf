// Skybox conventions: how Source's six 2D-skybox images (suffixes rt, lf, bk, ft, up, dn) wrap around the
// Z-up world, and how they are re-arranged into a WebGL cube map (sampled with world directions).
//
// Source sky faces (each image is seen from inside the box, never mirrored; "right"/"down" are the world
// directions in which the image's columns / rows increase):
//
//   face  looks toward  image right  image down
//   rt    +X            -Y           -Z
//   lf    -X            +Y           -Z
//   bk    +Y            +X           -Z
//   ft    -Y            -X           -Z
//   up    +Z            -Y           +X        (the image's top edge borders lf, its bottom edge rt)
//   dn    -Z            -Y           -X        (the image's top edge borders rt)
//
// i.e. the side faces stand upright with their top row at the horizon's zenith side, and looking up (or down)
// while facing +X shows the up (dn) image upright. This is the same face order and orientation as a Source
// cubemap VTF (+X, -X, +Y, -Y, +Z, -Z = rt, lf, bk, ft, up, dn) for the four sides. The orientation is checked
// against real skies by tests/render_skymath.test.ts (pixel continuity across all twelve cube edges).
//
// WebGL cube maps use the RenderMan convention (face +X: right = -Z, down = -Y; ...), designed for a Y-up
// left-handed frame. Sampling the cube with the swizzled world direction (x, z, y) makes the GL faces
// +X, -X, +Z, -Z line up with rt, lf, bk, ft unchanged; up and dn need a rotation, which
// buildGlCubeFaces() performs by remapping texels.
import type { Vec3 } from '../core/vec3';
import type { DecodedImage, SkyDef } from '../map/types';

export const SKY_SUFFIXES = ['rt', 'lf', 'bk', 'ft', 'up', 'dn'] as const;
export type SkySuffix = (typeof SKY_SUFFIXES)[number];

export interface FaceBasis {
  /** Outward direction through the face centre. */
  dir: [number, number, number];
  /** World direction of increasing image column (u). */
  right: [number, number, number];
  /** World direction of increasing image row (v). */
  down: [number, number, number];
}

/** Source 2D skybox face orientations (see the table above). */
export const SOURCE_SKY_BASIS: Readonly<Record<SkySuffix, FaceBasis>> = {
  rt: { dir: [1, 0, 0], right: [0, -1, 0], down: [0, 0, -1] },
  lf: { dir: [-1, 0, 0], right: [0, 1, 0], down: [0, 0, -1] },
  bk: { dir: [0, 1, 0], right: [1, 0, 0], down: [0, 0, -1] },
  ft: { dir: [0, -1, 0], right: [-1, 0, 0], down: [0, 0, -1] },
  up: { dir: [0, 0, 1], right: [0, -1, 0], down: [1, 0, 0] },
  dn: { dir: [0, 0, -1], right: [0, -1, 0], down: [-1, 0, 0] },
};

/**
 * WebGL cube map faces in upload order (+X, -X, +Y, -Y, +Z, -Z), in the cube's own (GL) frame:
 * u = (sc / |ma| + 1) / 2 runs along `right`, v = (tc / |ma| + 1) / 2 along `down` (row 0 = first row uploaded).
 */
export const GL_CUBE_BASIS: readonly FaceBasis[] = [
  { dir: [1, 0, 0], right: [0, 0, -1], down: [0, -1, 0] },
  { dir: [-1, 0, 0], right: [0, 0, 1], down: [0, -1, 0] },
  { dir: [0, 1, 0], right: [1, 0, 0], down: [0, 0, 1] },
  { dir: [0, -1, 0], right: [1, 0, 0], down: [0, 0, -1] },
  { dir: [0, 0, 1], right: [1, 0, 0], down: [0, -1, 0] },
  { dir: [0, 0, -1], right: [-1, 0, 0], down: [0, -1, 0] },
];

/** World (Source, Z-up) direction -> the direction to sample a GL cube map built by buildGlCubeFaces(). */
export function worldToCubeDir(x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  out[0] = x;
  out[1] = z;
  out[2] = y;
  return out;
}

/** Inverse of worldToCubeDir (the swizzle is its own inverse). */
export function cubeToWorldDir(x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  out[0] = x;
  out[1] = z;
  out[2] = y;
  return out;
}

/** Direction through image coordinate (u, v) in [0,1]² of a face (not normalized; the face is at distance 1). */
export function faceDirection(b: FaceBasis, u: number, v: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const s = 2 * u - 1;
  const t = 2 * v - 1;
  out[0] = b.dir[0] + s * b.right[0] + t * b.down[0];
  out[1] = b.dir[1] + s * b.right[1] + t * b.down[1];
  out[2] = b.dir[2] + s * b.right[2] + t * b.down[2];
  return out;
}

export interface FaceLookup {
  face: number;
  u: number;
  v: number;
}

/** Which face of `faces` a direction hits, and where (u, v in [0,1]). Faces must form a cube (one per axis sign). */
export function lookupDirection(faces: readonly FaceBasis[], x: number, y: number, z: number, out: FaceLookup = { face: 0, u: 0, v: 0 }): FaceLookup {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let axis: number;
  let sign: number;
  let ma: number;
  if (ax >= ay && ax >= az) {
    axis = 0;
    sign = x >= 0 ? 1 : -1;
    ma = ax;
  } else if (ay >= az) {
    axis = 1;
    sign = y >= 0 ? 1 : -1;
    ma = ay;
  } else {
    axis = 2;
    sign = z >= 0 ? 1 : -1;
    ma = az;
  }
  let face = -1;
  for (let i = 0; i < faces.length; i++) {
    if (faces[i].dir[axis] === sign) {
      face = i;
      break;
    }
  }
  if (face < 0 || ma === 0) {
    out.face = 0;
    out.u = 0.5;
    out.v = 0.5;
    return out;
  }
  const b = faces[face];
  const inv = 1 / ma;
  const s = (x * b.right[0] + y * b.right[1] + z * b.right[2]) * inv;
  const t = (x * b.down[0] + y * b.down[1] + z * b.down[2]) * inv;
  out.face = face;
  out.u = (s + 1) / 2;
  out.v = (t + 1) / 2;
  return out;
}

const SOURCE_FACES: FaceBasis[] = SKY_SUFFIXES.map((s) => SOURCE_SKY_BASIS[s]);

/** Source sky face + image coordinates seen along world direction (x, y, z). */
export function sourceSkyLookup(x: number, y: number, z: number, out?: FaceLookup): FaceLookup {
  return lookupDirection(SOURCE_FACES, x, y, z, out);
}

/**
 * For GL cube face `glFace` (0..5) of size n: which Source face it shows and the integer texel mapping
 * src = (ox + ax·i + bx·j, oy + ay·i + by·j) for destination texel (i, j).
 */
export interface FaceRemap {
  source: SkySuffix;
  ox: number;
  oy: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export function glFaceRemap(glFace: number, n: number): FaceRemap {
  const d = [0, 0, 0] as [number, number, number];
  const w = [0, 0, 0] as [number, number, number];
  const look: FaceLookup = { face: 0, u: 0, v: 0 };
  const texelOf = (i: number, j: number): [number, number, number] => {
    faceDirection(GL_CUBE_BASIS[glFace], (i + 0.5) / n, (j + 0.5) / n, d);
    cubeToWorldDir(d[0], d[1], d[2], w);
    sourceSkyLookup(w[0], w[1], w[2], look);
    return [look.face, Math.min(n - 1, Math.max(0, Math.floor(look.u * n))), Math.min(n - 1, Math.max(0, Math.floor(look.v * n)))];
  };
  const p00 = texelOf(0, 0);
  const p10 = n > 1 ? texelOf(1, 0) : p00;
  const p01 = n > 1 ? texelOf(0, 1) : p00;
  return {
    source: SKY_SUFFIXES[p00[0]],
    ox: p00[1],
    oy: p00[2],
    ax: p10[1] - p00[1],
    ay: p10[2] - p00[2],
    bx: p01[1] - p00[1],
    by: p01[2] - p00[2],
  };
}

/** Copies an n×n RGBA face through a remap. */
function remapFace(src: Uint8Array, n: number, m: FaceRemap): Uint8Array {
  const out = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    let sx = m.ox + m.bx * j;
    let sy = m.oy + m.by * j;
    let o = j * n * 4;
    for (let i = 0; i < n; i++) {
      const so = (sy * n + sx) * 4;
      out[o] = src[so];
      out[o + 1] = src[so + 1];
      out[o + 2] = src[so + 2];
      out[o + 3] = 255;
      o += 4;
      sx += m.ax;
      sy += m.ay;
    }
  }
  return out;
}

/** Nearest-neighbour resize to n×n (faces normally already share one square size). */
function squareFace(img: DecodedImage, n: number): Uint8Array {
  if (img.width === n && img.height === n && img.data.length >= n * n * 4) return img.data;
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / n));
    for (let x = 0; x < n; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / n));
      const s = (sy * img.width + sx) * 4;
      const o = (y * n + x) * 4;
      out[o] = img.data[s];
      out[o + 1] = img.data[s + 1];
      out[o + 2] = img.data[s + 2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * The six GL cube map faces (+X, -X, +Y, -Y, +Z, -Z) for a Source sky, as n×n RGBA8 (sRGB) images, to be
 * sampled with worldToCubeDir(direction).
 */
export function buildGlCubeFaces(faces: NonNullable<SkyDef['faces']>): { size: number; data: Uint8Array[] } {
  let n = 1;
  for (const s of SKY_SUFFIXES) n = Math.max(n, faces[s].width, faces[s].height);
  const square: Record<string, Uint8Array> = {};
  for (const s of SKY_SUFFIXES) square[s] = squareFace(faces[s], n);
  const data: Uint8Array[] = [];
  for (let f = 0; f < 6; f++) data.push(remapFace(square[glFaceRemap(f, n).source], n, glFaceRemap(f, n)));
  return { size: n, data };
}

/** Average colour (sRGB 0..1) of a band of directions: elevation in [lo, hi] (sin of elevation). */
export function skyBandColor(faces: NonNullable<SkyDef['faces']>, lo: number, hi: number, samples = 24): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let c = 0;
  const look: FaceLookup = { face: 0, u: 0, v: 0 };
  for (let k = 0; k < samples; k++) {
    const se = lo + ((hi - lo) * (k + 0.5)) / samples;
    const ce = Math.sqrt(Math.max(0, 1 - se * se));
    for (let a = 0; a < 32; a++) {
      const yaw = (a / 32) * Math.PI * 2;
      sourceSkyLookup(Math.cos(yaw) * ce, Math.sin(yaw) * ce, se, look);
      const img = faces[SKY_SUFFIXES[look.face]];
      const x = Math.min(img.width - 1, Math.max(0, Math.floor(look.u * img.width)));
      const y = Math.min(img.height - 1, Math.max(0, Math.floor(look.v * img.height)));
      const o = (y * img.width + x) * 4;
      r += img.data[o];
      g += img.data[o + 1];
      b += img.data[o + 2];
      c++;
    }
  }
  return c ? [r / c / 255, g / c / 255, b / c / 255] : [0.5, 0.6, 0.7];
}

/** Brightest direction of a sky (where the sun is drawn), or null if no clear maximum. */
export function findSkySun(faces: NonNullable<SkyDef['faces']>, minElevation = -0.05): Vec3 | null {
  let best = -1;
  let bx = 0;
  let by = 0;
  let bz = 0;
  let sum = 0;
  let cnt = 0;
  const d = [0, 0, 0] as [number, number, number];
  for (let fi = 0; fi < 6; fi++) {
    const s = SKY_SUFFIXES[fi];
    const img = faces[s];
    const step = Math.max(1, Math.floor(Math.min(img.width, img.height) / 64));
    for (let y = 0; y < img.height; y += step) {
      for (let x = 0; x < img.width; x += step) {
        const o = (y * img.width + x) * 4;
        const l = img.data[o] * 0.2126 + img.data[o + 1] * 0.7152 + img.data[o + 2] * 0.0722;
        sum += l;
        cnt++;
        faceDirection(SOURCE_SKY_BASIS[s], (x + 0.5) / img.width, (y + 0.5) / img.height, d);
        const len = Math.hypot(d[0], d[1], d[2]);
        if (d[2] / len < minElevation) continue;
        if (l > best) {
          best = l;
          bx = d[0] / len;
          by = d[1] / len;
          bz = d[2] / len;
        }
      }
    }
  }
  const mean = cnt ? sum / cnt : 0;
  if (best < 235 || best < mean * 1.6) return null;
  return { x: bx, y: by, z: bz };
}
