// A small synthetic LoadedMap exercising every renderer feature with known colours, for unit tests and the
// harness (?fixture=1): a lightmapped floor, walls, a sky ceiling (depth mask) under a skybox whose six faces
// are flat, distinct colours, a 3D-skybox block seen through the sky, a translucent pane, a water pool, a
// brush entity (model 1), a decal, a scrolling and an additive material, a displacement blend and props.
import { SURF_SKY } from '../bsp/types';
import type { Vec3 } from '../core/vec3';
import type { DecodedImage, LoadedMap, MaterialDef, RenderBatch, RenderProp } from '../map/types';
import { CollisionWorld } from '../physics/collision';

/** Flat sky face colours (sRGB bytes) by Source suffix. */
export const FIXTURE_SKY: Record<'rt' | 'lf' | 'bk' | 'ft' | 'up' | 'dn', [number, number, number]> = {
  rt: [255, 0, 0],
  lf: [0, 255, 0],
  bk: [0, 0, 255],
  ft: [255, 255, 0],
  up: [255, 255, 255],
  dn: [0, 0, 0],
};

export const FIXTURE_SKY3D = { origin: { x: 0, y: 0, z: -20000 }, scale: 16, area: 2 };

function solid(w: number, h: number, rgba: [number, number, number, number]): DecodedImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data, hasAlpha: rgba[3] < 255 };
}

function checker(n: number, a: [number, number, number], b: [number, number, number]): DecodedImage {
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const c = ((x >> 3) + (y >> 3)) & 1 ? a : b;
      data.set([c[0], c[1], c[2], 255], (y * n + x) * 4);
    }
  return { width: n, height: n, data, hasAlpha: false };
}

export function fixtureMaterial(name: string, over: Partial<MaterialDef> = {}): MaterialDef {
  return {
    name,
    shader: 'lightmappedgeneric',
    image: solid(4, 4, [200, 200, 200, 255]),
    fallbackColor: [0.78, 0.78, 0.78],
    width: 64,
    height: 64,
    translucent: false,
    additive: false,
    alphaTest: false,
    alphaTestRef: 0.5,
    alpha: 1,
    noCull: false,
    unlit: false,
    isWater: false,
    waterFogColor: null,
    isSky: false,
    isTool: false,
    scroll: null,
    ...over,
  };
}

/** An axis-aligned quad as a batch (counter-clockwise seen from `normal`'s side). */
export function quadBatch(
  material: string,
  corners: [Vec3, Vec3, Vec3, Vec3],
  normal: Vec3,
  opts: { model?: number; area?: number; surfFlags?: number; lightmap?: [number, number, number, number] | null; decal?: boolean; alphas?: number[]; uvScale?: number } = {},
): RenderBatch {
  const positions = new Float32Array(12);
  const normals = new Float32Array(12);
  const uvs = new Float32Array(8);
  const uv = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const mins = { x: Infinity, y: Infinity, z: Infinity };
  const maxs = { x: -Infinity, y: -Infinity, z: -Infinity };
  corners.forEach((c, i) => {
    positions.set([c.x, c.y, c.z], i * 3);
    normals.set([normal.x, normal.y, normal.z], i * 3);
    uvs.set([uv[i][0] * (opts.uvScale ?? 1), uv[i][1] * (opts.uvScale ?? 1)], i * 2);
    mins.x = Math.min(mins.x, c.x);
    mins.y = Math.min(mins.y, c.y);
    mins.z = Math.min(mins.z, c.z);
    maxs.x = Math.max(maxs.x, c.x);
    maxs.y = Math.max(maxs.y, c.y);
    maxs.z = Math.max(maxs.z, c.z);
  });
  // orient CCW around the normal
  const e1 = [positions[3] - positions[0], positions[4] - positions[1], positions[5] - positions[2]];
  const e2 = [positions[6] - positions[0], positions[7] - positions[1], positions[8] - positions[2]];
  const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const ccw = cr[0] * normal.x + cr[1] * normal.y + cr[2] * normal.z >= 0;
  const indices = new Uint32Array(ccw ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
  const lm = opts.lightmap;
  return {
    model: opts.model ?? 0,
    material,
    positions,
    normals,
    uvs,
    lightmapUVs: lm ? new Float32Array([lm[0], lm[1], lm[2], lm[1], lm[2], lm[3], lm[0], lm[3]]) : null,
    alphas: opts.alphas ? new Float32Array(opts.alphas) : null,
    indices,
    surfFlags: opts.surfFlags ?? 0,
    area: opts.area ?? 1,
    isDisplacement: !!opts.alphas,
    mins,
    maxs,
    decal: opts.decal,
  };
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Box faces (inward-facing for a room, outward for a block). */
function boxBatches(material: string, mins: Vec3, maxs: Vec3, inward: boolean, opts: Parameters<typeof quadBatch>[3] = {}, skip: string[] = []): RenderBatch[] {
  const out: RenderBatch[] = [];
  const s = inward ? -1 : 1;
  const f = (k: string, c: [Vec3, Vec3, Vec3, Vec3], n: Vec3) => {
    if (!skip.includes(k)) out.push(quadBatch(material, c, { x: n.x * s, y: n.y * s, z: n.z * s }, opts));
  };
  const { x: x0, y: y0, z: z0 } = mins;
  const { x: x1, y: y1, z: z1 } = maxs;
  f('-z', [v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0)], v(0, 0, -1));
  f('+z', [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)], v(0, 0, 1));
  f('-x', [v(x0, y0, z0), v(x0, y1, z0), v(x0, y1, z1), v(x0, y0, z1)], v(-1, 0, 0));
  f('+x', [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)], v(1, 0, 0));
  f('-y', [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)], v(0, -1, 0));
  f('+y', [v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)], v(0, 1, 0));
  return out;
}

/** A unit cube prop (model space, centred at the origin, 16 units). */
function cubeProp(material: string, origin: Vec3, yaw: number, cube?: [number, number, number][]): RenderProp {
  const bs = boxBatches(material, v(-8, -8, -8), v(8, 8, 8), false);
  const positions = new Float32Array(bs.length * 12);
  const normals = new Float32Array(bs.length * 12);
  const uvs = new Float32Array(bs.length * 8);
  const indices = new Uint32Array(bs.length * 6);
  bs.forEach((b, i) => {
    positions.set(b.positions, i * 12);
    normals.set(b.normals, i * 12);
    uvs.set(b.uvs, i * 8);
    indices.set(Array.from(b.indices, (k) => k + i * 4), i * 6);
  });
  return { model: 'models/fixture/cube.mdl', origin, angles: { pitch: 0, yaw, roll: 0 }, positions, normals, uvs, indices, material, ambientCube: cube };
}

/**
 * The fixture map. Room: x/y in [-512, 512], z in [0, 384], ceiling = sky (z 384), spawn at the origin looking
 * +X. The lightmap atlas is 4x2: row 0 texels 0 = 0.25 (dim), 1 = 1.0, 2 = 2.0 (overbright), 3 = 0.5; row 1 = 4.0.
 */
export function buildFixtureMap(opts: { fog?: boolean; withSky3d?: boolean } = {}): LoadedMap {
  const materials = new Map<string, MaterialDef>();
  const add = (m: MaterialDef) => materials.set(m.name, m);
  add(fixtureMaterial('fixture/floor', { image: checker(32, [220, 220, 220], [160, 160, 160]) }));
  add(fixtureMaterial('fixture/wall', { image: solid(4, 4, [180, 150, 120, 255]) }));
  add(fixtureMaterial('tools/toolsskybox', { isSky: true, image: null }));
  add(fixtureMaterial('tools/toolsclip', { isTool: true, image: null }));
  add(fixtureMaterial('fixture/glass', { translucent: true, alpha: 0.5, image: solid(4, 4, [120, 200, 255, 160]) }));
  add(fixtureMaterial('fixture/water', { isWater: true, translucent: true, alpha: 0.85, shader: 'water', waterFogColor: [0.1, 0.25, 0.3] }));
  add(fixtureMaterial('fixture/door', { image: solid(4, 4, [255, 128, 0, 255]) }));
  add(fixtureMaterial('fixture/decal', { translucent: true, unlit: true, image: solid(4, 4, [0, 0, 0, 200]), shader: 'unlitgeneric' }));
  add(fixtureMaterial('fixture/scroll', { unlit: true, scroll: [0.5, 0], shader: 'unlitgeneric' }));
  add(fixtureMaterial('fixture/additive', { additive: true, translucent: true, unlit: true, image: solid(4, 4, [255, 0, 255, 255]) }));
  add(
    fixtureMaterial('fixture/blend', {
      shader: 'worldvertextransition',
      image: solid(4, 4, [255, 0, 0, 255]),
      image2: solid(4, 4, [0, 0, 255, 255]),
      fallbackColor2: [0, 0, 1],
    }),
  );
  add(fixtureMaterial('fixture/sky3d', { unlit: true, image: solid(4, 4, [255, 0, 255, 255]), shader: 'unlitgeneric' }));
  add(fixtureMaterial('fixture/prop', { shader: 'vertexlitgeneric', image: solid(4, 4, [255, 255, 255, 255]) }));
  // texture orientation: 2x2 image, top-left red, top-right green, bottom-left blue, bottom-right white
  const orient = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  add(fixtureMaterial('fixture/orient', { unlit: true, shader: 'unlitgeneric', image: { width: 2, height: 2, data: orient, hasAlpha: false } }));

  // every lightmapped quad samples a single texel centre of the 4x2 atlas (row 0 at v = 0.25)
  const lm = (i: number): [number, number, number, number] => [(i + 0.5) / 4, 0.25, (i + 0.5) / 4, 0.25];
  const batches: RenderBatch[] = [];
  // floor: lightmap texel 1 (fully lit)
  batches.push(quadBatch('fixture/floor', [v(-512, -512, 0), v(512, -512, 0), v(512, 512, 0), v(-512, 512, 0)], v(0, 0, 1), { lightmap: lm(1), uvScale: 8 }));
  // walls (inward), lightmap texel 3 (half lit)
  batches.push(...boxBatches('fixture/wall', v(-512, -512, 0), v(512, 512, 384), true, { lightmap: lm(3) }, ['-z', '+z']));
  // sky ceiling with a hole... the whole ceiling is sky
  batches.push(quadBatch('tools/toolsskybox', [v(-512, -512, 384), v(512, -512, 384), v(512, 512, 384), v(-512, 512, 384)], v(0, 0, -1), { surfFlags: SURF_SKY }));
  // a clip brush face that must never be drawn
  batches.push(quadBatch('tools/toolsclip', [v(0, 0, 10), v(10, 0, 10), v(10, 10, 10), v(0, 10, 10)], v(0, 0, 1)));
  // translucent pane at x = 300 (y -100..100)
  batches.push(quadBatch('fixture/glass', [v(300, -100, 0), v(300, 100, 0), v(300, 100, 200), v(300, -100, 200)], v(-1, 0, 0)));
  // water pool at z = 2, x in [-400, -200]
  batches.push(quadBatch('fixture/water', [v(-400, -100, 2), v(-200, -100, 2), v(-200, 100, 2), v(-400, 100, 2)], v(0, 0, 1)));
  // brush entity (model 1): an orange block at y = 300
  batches.push(...boxBatches('fixture/door', v(-50, 250, 0), v(50, 350, 150), false, { model: 1, lightmap: lm(1) }));
  // decal on the floor
  batches.push(quadBatch('fixture/decal', [v(100, -50, 0.25), v(200, -50, 0.25), v(200, 50, 0.25), v(100, 50, 0.25)], v(0, 0, 1), { decal: true }));
  // scrolling + additive surfaces on the -y wall
  batches.push(quadBatch('fixture/scroll', [v(-300, -511, 50), v(-200, -511, 50), v(-200, -511, 150), v(-300, -511, 150)], v(0, 1, 0)));
  batches.push(quadBatch('fixture/additive', [v(-100, -511, 50), v(0, -511, 50), v(0, -511, 150), v(-100, -511, 150)], v(0, 1, 0)));
  // texture orientation quad on the -x wall, facing the spawn: uv (0,0) at its top-left as seen from the origin
  batches.push(quadBatch('fixture/orient', [v(-500, -50, 150), v(-500, 50, 150), v(-500, 50, 50), v(-500, -50, 50)], v(1, 0, 0)));
  // displacement blend
  batches.push(quadBatch('fixture/blend', [v(-500, 300, 1), v(-300, 300, 1), v(-300, 500, 1), v(-500, 500, 1)], v(0, 0, 1), { alphas: [0, 1, 1, 0], lightmap: lm(1) }));
  // 3D skybox content: a magenta block in area 2 around the sky camera; scaled x16 it appears far above the room
  if (opts.withSky3d !== false) {
    const o = FIXTURE_SKY3D.origin;
    batches.push(...boxBatches('fixture/sky3d', v(o.x - 40, o.y - 40, o.z + 60), v(o.x + 40, o.y + 40, o.z + 140), false, { area: FIXTURE_SKY3D.area }));
  }
  // row 1 is a decoy (4.0 = very overbright): sampling it would mean the atlas is flipped vertically
  const atlas = new Float32Array([0.25, 0.25, 0.25, 1, 1, 1, 1, 1, 2, 2, 2, 1, 0.5, 0.5, 0.5, 1, 4, 4, 4, 1, 4, 4, 4, 1, 4, 4, 4, 1, 4, 4, 4, 1]);
  const skyFace = (c: [number, number, number]) => solid(8, 8, [c[0], c[1], c[2], 255]);
  const props: RenderProp[] = [
    cubeProp('fixture/prop', v(-200, -200, 8), 0, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [1, 1, 1],
      [0, 0, 0],
    ]),
    cubeProp('fixture/prop', v(-200, -300, 8), 90),
  ];
  return {
    name: 'render_fixture',
    source: 'builtin',
    entities: [],
    models: [
      { index: 0, mins: v(-512, -512, 0), maxs: v(512, 512, 384), origin: v(0, 0, 0), brushes: [] },
      { index: 1, mins: v(-50, 250, 0), maxs: v(50, 350, 150), origin: v(0, 0, 0), brushes: [] },
    ],
    collision: new CollisionWorld([]),
    render: {
      batches,
      lightmap: { width: 4, height: 2, data: atlas },
      materials,
      sky: {
        name: 'fixture_sky',
        faces: {
          rt: skyFace(FIXTURE_SKY.rt),
          lf: skyFace(FIXTURE_SKY.lf),
          bk: skyFace(FIXTURE_SKY.bk),
          ft: skyFace(FIXTURE_SKY.ft),
          up: skyFace(FIXTURE_SKY.up),
          dn: skyFace(FIXTURE_SKY.dn),
        },
      },
      sky3d: opts.withSky3d === false ? null : { ...FIXTURE_SKY3D, fog: null },
      fog: opts.fog ? { enabled: true, color: [0.5, 0.5, 0.5], start: 0, end: 2000, maxDensity: 1 } : null,
      props,
      cubemaps: [],
    },
    spawns: [{ origin: v(0, 0, 0), angles: { pitch: 0, yaw: 0, roll: 0 } }],
    zones: [],
    zoneSource: 'none',
    worldMins: v(-512, -512, 0),
    worldMaxs: v(512, 512, 384),
    warnings: [],
  };
}
