import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEntities } from '../src/bsp/entities';
import { isProceduralImage, loadSky } from '../src/bsp/materials';
import { PakFile } from '../src/bsp/pakfile';
import { parseBsp } from '../src/bsp/reader';
import type { DecodedImage, LoadedMap, SkyDef } from '../src/map/types';
import { lightEnvSunDir, proceduralSkyParams, skyKind } from '../src/render/sky';
import {
  FaceBasis,
  GL_CUBE_BASIS,
  SKY_SUFFIXES,
  SOURCE_SKY_BASIS,
  buildGlCubeFaces,
  cubeToWorldDir,
  faceDirection,
  findSkySun,
  glFaceRemap,
  lookupDirection,
  skyBandColor,
  sourceSkyLookup,
  worldToCubeDir,
} from '../src/render/skymath';

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('sky face conventions', () => {
  it('Source faces look outward along their axis and are never mirrored (right x down = outward)', () => {
    const axes: Record<string, number[]> = { rt: [1, 0, 0], lf: [-1, 0, 0], bk: [0, 1, 0], ft: [0, -1, 0], up: [0, 0, 1], dn: [0, 0, -1] };
    for (const s of SKY_SUFFIXES) {
      const b = SOURCE_SKY_BASIS[s];
      expect(b.dir).toEqual(axes[s]);
      expect(dot(b.right, b.dir)).toBe(0);
      expect(dot(b.down, b.dir)).toBe(0);
      expect(dot(b.right, b.down)).toBe(0);
      expect(cross(b.right, b.down).map((x) => x + 0)).toEqual(b.dir.map((x) => x + 0));
    }
  });

  it('side faces are upright: image rows go down the world Z axis (level horizon)', () => {
    for (const s of ['rt', 'lf', 'bk', 'ft'] as const) expect(SOURCE_SKY_BASIS[s].down).toEqual([0, 0, -1]);
  });

  it('the side panorama is continuous: each side face continues to the right into the next one', () => {
    // turning right from +X: rt -> ft -> lf -> bk -> rt; the right edge of one is the left edge of the next
    const order = ['rt', 'ft', 'lf', 'bk'] as const;
    for (let i = 0; i < 4; i++) {
      const a = SOURCE_SKY_BASIS[order[i]];
      const b = SOURCE_SKY_BASIS[order[(i + 1) % 4]];
      for (const v of [0.1, 0.5, 0.9]) {
        const pa = faceDirection(a, 1, v);
        const pb = faceDirection(b, 0, v);
        expect(pa.map((x) => +x.toFixed(9))).toEqual(pb.map((x) => +x.toFixed(9)));
      }
    }
  });

  it('up/dn edges: the up image bottom row borders rt, its top row lf; dn top row borders rt', () => {
    const up = SOURCE_SKY_BASIS.up;
    const dn = SOURCE_SKY_BASIS.dn;
    const rt = SOURCE_SKY_BASIS.rt;
    const lf = SOURCE_SKY_BASIS.lf;
    for (const u of [0.2, 0.5, 0.8]) {
      expect(faceDirection(up, u, 1)).toEqual(faceDirection(rt, u, 0));
      expect(faceDirection(dn, u, 0)).toEqual(faceDirection(rt, u, 1));
      // lf's top edge runs the other way round
      expect(faceDirection(up, u, 0).map((x) => +x.toFixed(9))).toEqual(faceDirection(lf, 1 - u, 0).map((x) => +x.toFixed(9)));
    }
  });

  it('lookupDirection inverts faceDirection for both conventions', () => {
    for (const faces of [SKY_SUFFIXES.map((s) => SOURCE_SKY_BASIS[s]), GL_CUBE_BASIS as FaceBasis[]]) {
      for (let f = 0; f < 6; f++) {
        for (const [u, v] of [
          [0.13, 0.71],
          [0.5, 0.5],
          [0.95, 0.02],
        ]) {
          const d = faceDirection(faces[f], u, v);
          const k = 0.37; // any positive scale
          const l = lookupDirection(faces, d[0] * k, d[1] * k, d[2] * k);
          expect(l.face).toBe(f);
          expect(l.u).toBeCloseTo(u, 9);
          expect(l.v).toBeCloseTo(v, 9);
        }
      }
    }
  });

  it('the cube swizzle is its own inverse', () => {
    expect(cubeToWorldDir(...worldToCubeDir(1, 2, 3))).toEqual([1, 2, 3]);
    expect(worldToCubeDir(1, 2, 3)).toEqual([1, 3, 2]);
  });
});

/** Six n×n faces where every texel stores its own (face, x, y). */
function codedFaces(n: number): NonNullable<SkyDef['faces']> {
  const mk = (f: number): DecodedImage => {
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const o = (y * n + x) * 4;
        data[o] = f;
        data[o + 1] = x;
        data[o + 2] = y;
        data[o + 3] = 255;
      }
    return { width: n, height: n, data, hasAlpha: false };
  };
  return { rt: mk(0), lf: mk(1), bk: mk(2), ft: mk(3), up: mk(4), dn: mk(5) };
}

describe('GL cube map build', () => {
  it('sampling the GL cube with worldToCubeDir(dir) returns the Source sky texel seen along dir', () => {
    const n = 16;
    const faces = codedFaces(n);
    const cube = buildGlCubeFaces(faces);
    expect(cube.size).toBe(n);
    expect(cube.data).toHaveLength(6);
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      // deterministic pseudo-random directions
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b = Math.sin(i * 78.233) * 12345.6789;
      const c = Math.sin(i * 39.425) * 9876.54321;
      const d = [a - Math.floor(a) - 0.5, b - Math.floor(b) - 0.5, c - Math.floor(c) - 0.5];
      const src = sourceSkyLookup(d[0], d[1], d[2]);
      const sx = Math.floor(src.u * n);
      const sy = Math.floor(src.v * n);
      // stay away from texel borders (both lookups must pick the same texel)
      if (src.u * n - sx < 0.05 || src.u * n - sx > 0.95 || src.v * n - sy < 0.05 || src.v * n - sy > 0.95) continue;
      const g = worldToCubeDir(d[0], d[1], d[2]);
      const gl = lookupDirection(GL_CUBE_BASIS, g[0], g[1], g[2]);
      const gx = Math.min(n - 1, Math.floor(gl.u * n));
      const gy = Math.min(n - 1, Math.floor(gl.v * n));
      const o = (gy * n + gx) * 4;
      const px = cube.data[gl.face];
      expect([px[o], px[o + 1], px[o + 2]]).toEqual([src.face, sx, sy]);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('only up and dn are re-oriented; the sides copy straight through', () => {
    const n = 8;
    expect(glFaceRemap(0, n)).toMatchObject({ source: 'rt', ox: 0, oy: 0, ax: 1, ay: 0, bx: 0, by: 1 });
    expect(glFaceRemap(1, n)).toMatchObject({ source: 'lf', ax: 1, by: 1 });
    expect(glFaceRemap(4, n)).toMatchObject({ source: 'bk', ax: 1, by: 1 });
    expect(glFaceRemap(5, n)).toMatchObject({ source: 'ft', ax: 1, by: 1 });
    const up = glFaceRemap(2, n);
    const dn = glFaceRemap(3, n);
    expect(up.source).toBe('up');
    expect(dn.source).toBe('dn');
    expect(Math.abs(up.ax) + Math.abs(up.by)).toBe(0); // a 90 degree rotation swaps the axes
    expect(Math.abs(dn.ax) + Math.abs(dn.by)).toBe(0);
  });

  it('handles 1x1 faces and non-square input', () => {
    const one = codedFaces(1);
    expect(buildGlCubeFaces(one).size).toBe(1);
    const f = codedFaces(4);
    f.up = { width: 2, height: 2, data: new Uint8Array(16).fill(200), hasAlpha: false };
    const c = buildGlCubeFaces(f);
    expect(c.size).toBe(4);
    expect(c.data[2][0]).toBe(200);
  });
});

describe('sky helpers', () => {
  it('skyBandColor averages a band of elevations', () => {
    const faces = codedFaces(4);
    for (const s of SKY_SUFFIXES) faces[s].data.fill(s === 'up' ? 250 : s === 'dn' ? 10 : 128);
    const top = skyBandColor(faces, 0.9, 1);
    const bottom = skyBandColor(faces, -1, -0.9);
    expect(top[0]).toBeCloseTo(250 / 255, 2);
    expect(bottom[0]).toBeCloseTo(10 / 255, 2);
  });

  it('findSkySun locates a bright spot', () => {
    const n = 64;
    const faces = codedFaces(n);
    for (const s of SKY_SUFFIXES) {
      const d = faces[s].data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 90;
        d[i + 1] = 120;
        d[i + 2] = 160;
      }
    }
    // a sun on the bk (+Y) face, above the horizon
    const d = faces.bk.data;
    for (let y = 18; y < 22; y++)
      for (let x = 30; x < 34; x++) {
        const o = (y * n + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = 255;
      }
    const sun = findSkySun(faces)!;
    expect(sun).not.toBeNull();
    expect(sun.y).toBeGreaterThan(0.8);
    expect(sun.z).toBeGreaterThan(0.1);
    // uniform skies have no sun
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255;
    expect(findSkySun(codedFaces(8))).toBeNull();
  });

  it('sky kinds from names', () => {
    expect(skyKind('sky_borealis01')).toBe('night');
    expect(skyKind('sky_night_neon')).toBe('night');
    expect(skyKind('sky_dusk_skyline')).toBe('dusk');
    expect(skyKind('sky_day02_09')).toBe('dusk');
    expect(skyKind('militia_hdr')).toBe('overcast');
    expect(skyKind('sky_dust')).toBe('desert');
    expect(skyKind('sky_day01_01')).toBe('day');
    expect(proceduralSkyParams('sky_night_neon').stars).toBeGreaterThan(0);
    expect(proceduralSkyParams('sky_day01_01').stars).toBe(0);
  });

  it('light_environment: yaw is where the light travels, pitch -N puts the sun N degrees up', () => {
    const map = {
      entities: [{ classname: 'light_environment', angles: { pitch: -30, yaw: 90, roll: 0 }, kv: {} }],
    } as unknown as LoadedMap;
    const s = lightEnvSunDir(map)!;
    // light travels toward +Y and down: the sun is toward -Y, 30 degrees above the horizon
    expect(s.y).toBeCloseTo(-Math.cos(Math.PI / 6), 6);
    expect(s.z).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    expect(Math.abs(s.x)).toBeLessThan(1e-9);
    const down = lightEnvSunDir({ entities: [{ classname: 'light_environment', angles: { pitch: -90, yaw: 0, roll: 0 }, kv: {} }] } as unknown as LoadedMap)!;
    expect(down.z).toBeCloseTo(1, 6);
    expect(lightEnvSunDir({ entities: [] } as unknown as LoadedMap)).toBeNull();
  });
});

// --------------------------------------------------------------------------------------------- real skies

const MAPS = process.env.SURF_TEST_MAPS ?? '';

function realSky(name: string): { faces: NonNullable<SkyDef['faces']>; light: { pitch: number; yaw: number } | null } | null {
  const p = join(MAPS, `${name}.bsp`);
  if (!MAPS || !existsSync(p)) return null;
  const buf = readFileSync(p);
  const bsp = parseBsp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ents = parseEntities(bsp.entitiesText);
  const ws = ents.find((e) => e.classname === 'worldspawn');
  const pak = bsp.pakfile ? new PakFile(bsp.pakfile) : null;
  const sky = loadSky(ws?.kv.skyname ?? '', pak);
  if (!sky.faces || isProceduralImage(sky.faces.rt)) return null;
  const le = ents.find((e) => e.classname === 'light_environment');
  return { faces: sky.faces, light: le ? { pitch: le.angles.pitch, yaw: le.angles.yaw } : null };
}

/** Mean colour difference across the 4 edges between a cap face and the sides (nearest texels each side). */
function capSeamError(faces: NonNullable<SkyDef['faces']>, basis: FaceBasis[], cap: 'up' | 'dn'): number {
  const sample = (x: number, y: number, z: number) => {
    const l = lookupDirection(basis, x, y, z);
    const img = faces[SKY_SUFFIXES[l.face]];
    const px = Math.min(img.width - 1, Math.max(0, Math.floor(l.u * img.width)));
    const py = Math.min(img.height - 1, Math.max(0, Math.floor(l.v * img.height)));
    const o = (py * img.width + px) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  };
  const sz = cap === 'up' ? 1 : -1;
  const eps = 1.5 / faces.rt.width;
  let e = 0;
  let c = 0;
  for (let k = 0; k < 4; k++) {
    const dx = [1, 0, -1, 0][k];
    const dy = [0, -1, 0, 1][k];
    for (let i = 1; i < 200; i++) {
      const s = -1 + (2 * i) / 200;
      const px = dx + (dx === 0 ? s : 0);
      const py = dy + (dy === 0 ? s : 0);
      const a = sample(px, py, sz * (1 - eps));
      const b = sample(px * (1 - eps), py * (1 - eps), sz);
      e += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      c++;
    }
  }
  return e / c;
}

describe.skipIf(!MAPS)('real KSF skies', () => {
  const axes = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
  ];
  for (const map of ['surf_aircontrol_ksf', 'surf_mesa_fixed', 'surf_rookie', 'surf_ing', 'surf_beginner']) {
    it(`${map}: the chosen up/dn orientation is the seamless one of all 8`, () => {
      const sky = realSky(map);
      if (!sky) return;
      const base = SKY_SUFFIXES.map((s) => SOURCE_SKY_BASIS[s]);
      for (const cap of ['up', 'dn'] as const) {
        const fi = SKY_SUFFIXES.indexOf(cap);
        const chosen = capSeamError(sky.faces, base, cap);
        const others: number[] = [];
        for (const r of axes)
          for (const d of axes) {
            if (dot(r, d) !== 0) continue;
            const b = base.slice();
            b[fi] = { dir: base[fi].dir, right: r as [number, number, number], down: d as [number, number, number] };
            if (r.join() === base[fi].right.join() && d.join() === base[fi].down.join()) continue;
            others.push(capSeamError(sky.faces, b, cap));
          }
        const best = Math.min(...others);
        // caps that are a flat colour (no information) can't distinguish orientations
        if (best - chosen < 0.05 && best < 1) continue;
        expect(chosen).toBeLessThan(best);
      }
    });
  }

  it('surf_aircontrol_ksf: the sun painted in the sky is where light_environment says (sun opposite its yaw)', () => {
    const sky = realSky('surf_aircontrol_ksf');
    if (!sky || !sky.light) return;
    const painted = findSkySun(sky.faces)!;
    expect(painted).not.toBeNull();
    const fromLight = lightEnvSunDir({
      entities: [{ classname: 'light_environment', angles: { pitch: sky.light.pitch, yaw: sky.light.yaw, roll: 0 }, kv: {} }],
    } as unknown as LoadedMap)!;
    const h1 = Math.atan2(painted.y, painted.x);
    const h2 = Math.atan2(fromLight.y, fromLight.x);
    let dh = Math.abs(h1 - h2);
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    expect((dh * 180) / Math.PI).toBeLessThan(20);
  });
});
