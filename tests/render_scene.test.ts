import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mesh, ShaderMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { LoadedMap, RenderProp } from '../src/map/types';
import { FIXTURE_SKY3D, buildFixtureMap } from '../src/render/fixtures';
import {
  MapScene,
  ORDER_DECAL,
  ORDER_DECAL_TRANSLUCENT,
  ORDER_SKY_MASK,
  evalAmbientCube,
  fallbackCube,
  indexAttribute,
  isEmptyCube,
  mergeProps,
  sky3dMatrix,
} from '../src/render/mapscene';
import { TextureCache } from '../src/render/textures';
import { SurfaceMaterials, createSharedUniforms, srgbToLinear } from '../src/render/worldmaterials';

const caps = { maxAnisotropy: 8, s3tc: false, maxTextureSize: 4096 };

async function build(map: LoadedMap) {
  const textures = new TextureCache(caps);
  const shared = createSharedUniforms();
  const materials = new SurfaceMaterials({ textures, shared });
  const scene = new MapScene(map, { textures, materials, shared });
  await scene.build();
  return { scene, textures, materials, shared };
}

const meshesNamed = (s: MapScene, name: string) => s.meshes().filter((m) => m.name === name);

describe('MapScene with the fixture map', () => {
  it('builds one mesh per drawable batch; tool faces are skipped', async () => {
    const map = buildFixtureMap();
    const { scene } = await build(map);
    const drawable = map.render.batches.filter((b) => b.material !== 'tools/toolsclip').length;
    expect(scene.stats.meshes - scene.stats.propMeshes).toBe(drawable);
    expect(meshesNamed(scene, 'tools/toolsclip')).toHaveLength(0);
    expect(scene.stats.triangles).toBeGreaterThan(0);
  });

  it('sky faces are depth-only masks drawn before the world', async () => {
    const { scene } = await build(buildFixtureMap());
    const sky = meshesNamed(scene, 'sky');
    expect(sky).toHaveLength(1);
    const m = sky[0].material as ShaderMaterial;
    expect(m.colorWrite).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(sky[0].renderOrder).toBe(ORDER_SKY_MASK);
    expect(scene.stats.skyMasks).toBe(1);
  });

  it('3D skybox batches go to the scaled sky group, not the world', async () => {
    const { scene } = await build(buildFixtureMap());
    expect(scene.hasSky3d).toBe(true);
    const sky3d = scene.sky3d.children as Mesh[];
    expect(sky3d.length).toBe(6);
    expect(sky3d.every((m) => m.name === 'fixture/sky3d')).toBe(true);
    expect(scene.world.children.some((m) => m.name === 'fixture/sky3d')).toBe(false);
    // p' = (p - origin) * scale
    const p = new Vector3(FIXTURE_SKY3D.origin.x + 10, FIXTURE_SKY3D.origin.y - 5, FIXTURE_SKY3D.origin.z + 100).applyMatrix4(sky3d[0].matrixWorld);
    expect(p.toArray().map((x) => Math.round(x))).toEqual([160, -80, 1600]);
    // the 3D sky's materials use the sky_camera fog set
    expect((sky3d[0].material as ShaderMaterial).uniforms.uFogScale).toBeDefined();
  });

  it('without a sky_camera everything is world', async () => {
    const { scene } = await build(buildFixtureMap({ withSky3d: false }));
    expect(scene.hasSky3d).toBe(false);
    expect(scene.sky3d.children).toHaveLength(0);
  });

  it('lightmapped batches carry lmuv; blends carry blendAlpha; bounds come from the batch', async () => {
    const { scene } = await build(buildFixtureMap());
    const floor = meshesNamed(scene, 'fixture/floor')[0];
    expect(floor.geometry.getAttribute('lmuv')).toBeTruthy();
    expect((floor.material as ShaderMaterial).defines.USE_LIGHTMAP).toBe('');
    expect(floor.geometry.boundingSphere!.radius).toBeCloseTo(Math.hypot(1024, 1024) / 2, 0);
    expect(floor.geometry.index!.array).toBeInstanceOf(Uint16Array);
    const blend = meshesNamed(scene, 'fixture/blend')[0];
    expect(blend.geometry.getAttribute('blendAlpha').count).toBe(4);
    expect((blend.material as ShaderMaterial).defines.USE_BLEND2).toBe('');
    const glass = meshesNamed(scene, 'fixture/glass')[0];
    expect(glass.geometry.getAttribute('lmuv')).toBeUndefined();
    expect((glass.material as ShaderMaterial).transparent).toBe(true);
  });

  it('decals are ordered after the opaque world', async () => {
    const { scene } = await build(buildFixtureMap());
    const d = meshesNamed(scene, 'fixture/decal')[0];
    expect([ORDER_DECAL, ORDER_DECAL_TRANSLUCENT]).toContain(d.renderOrder);
    expect((d.material as ShaderMaterial).polygonOffset).toBe(true);
    expect(scene.stats.decals).toBe(1);
  });

  it('brush entities: visibility, alpha and colour per model', async () => {
    const { scene } = await build(buildFixtureMap());
    const door = meshesNamed(scene, 'fixture/door');
    expect(door).toHaveLength(6);
    const mat = door[0].material as ShaderMaterial;
    expect(door.every((m) => m.material === mat)).toBe(true);
    // world materials are separate instances
    scene.setModelVisible(1, false);
    expect(door.every((m) => !m.visible)).toBe(true);
    scene.setModelVisible(1, true);
    expect(door.every((m) => m.visible)).toBe(true);
    scene.setModelAlpha(1, 0.5);
    expect(mat.transparent).toBe(true);
    expect(mat.uniforms.uAlpha.value).toBeCloseTo(0.5, 6);
    scene.setModelAlpha(1, 1);
    expect(mat.transparent).toBe(false);
    scene.setModelColor(1, [1, 0, 0.5]);
    expect(mat.uniforms.uTint.value.toArray().map((x: number) => +x.toFixed(4))).toEqual([1, 0, +srgbToLinear(0.5).toFixed(4)]);
    // unknown models are fine (state kept for later)
    scene.setModelVisible(77, false);
    scene.setModelAlpha(77, NaN);
    scene.setModelColor(77, [NaN, 2, -1] as [number, number, number]);
    expect(scene.models.get(77)!.color).toEqual([1, 1, 0]);
  });

  it('animates texture scroll', async () => {
    const { scene } = await build(buildFixtureMap());
    const m = meshesNamed(scene, 'fixture/scroll')[0].material as ShaderMaterial;
    scene.update(0.5);
    const e = m.uniforms.uUvTransform.value.elements;
    expect(e[6]).toBeCloseTo(0.25, 6); // u offset = 0.5/s * 0.5 s
    scene.update(3);
    expect(m.uniforms.uUvTransform.value.elements[6]).toBeCloseTo(0.5, 6);
  });

  it('merges props with their placement and light', async () => {
    const { scene } = await build(buildFixtureMap());
    expect(scene.stats.propMeshes).toBe(1);
    const prop = scene.meshes().find((m) => m.name.startsWith('prop:'))!;
    expect(prop.geometry.getAttribute('vlight')).toBeTruthy();
    expect((prop.material as ShaderMaterial).defines.USE_VERTEX_LIGHT).toBe('');
    expect(prop.geometry.attributes.position.count).toBe(48);
  });

  it('skips malformed batches instead of reading out of range', async () => {
    const map = buildFixtureMap();
    const bad = { ...map.render.batches[0], indices: new Uint32Array([0, 1, 99]) };
    const empty = { ...map.render.batches[0], positions: new Float32Array(0) };
    map.render.batches.push(bad, empty, undefined as never);
    const { scene } = await build(map);
    expect(scene.meshes().filter((m) => m.name === 'fixture/floor')).toHaveLength(1);
  });

  it('dispose releases geometry', async () => {
    const { scene, materials, textures } = await build(buildFixtureMap());
    const geos = scene.meshes().map((m) => m.geometry);
    let n = 0;
    for (const g of geos) g.addEventListener('dispose', () => n++);
    scene.dispose();
    materials.dispose();
    textures.dispose();
    expect(n).toBe(geos.length);
    expect(scene.meshes()).toHaveLength(0);
    scene.dispose(); // idempotent
  });
});

describe('prop helpers', () => {
  const cube: [number, number, number][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 0],
    [0.5, 0.5, 0.5],
    [0, 0, 0],
  ];
  it('ambient cube evaluation weights faces by squared normal components', () => {
    const out = [0, 0, 0];
    expect(evalAmbientCube(cube, 1, 0, 0, out)).toEqual([1, 0, 0]);
    expect(evalAmbientCube(cube, -1, 0, 0, out)).toEqual([0, 1, 0]);
    expect(evalAmbientCube(cube, 0, 0, 1, out)).toEqual([0.5, 0.5, 0.5]);
    const s = Math.SQRT1_2;
    const r = evalAmbientCube(cube, s, -s, 0, out);
    expect(r[0]).toBeCloseTo(1, 6);
    expect(r[1]).toBeCloseTo(0.5, 6);
  });

  it('empty cubes are replaced by the map average', () => {
    expect(isEmptyCube(undefined)).toBe(true);
    expect(isEmptyCube(cube.map(() => [0, 0, 0]))).toBe(true);
    expect(isEmptyCube(cube)).toBe(false);
    const props = [{ ambientCube: cube }, { ambientCube: cube.map(() => [0, 0, 0]) }, {}] as unknown as RenderProp[];
    expect(fallbackCube(props)).toEqual(cube);
    expect(fallbackCube([])[0]).toEqual([0.75, 0.75, 0.75]);
  });

  it('places model axes like Source (x forward, y left, z up) and rotates normals', () => {
    const mk = (yaw: number, pitch = 0): RenderProp => ({
      model: 'm',
      origin: { x: 100, y: 200, z: 300 },
      angles: { pitch, yaw, roll: 0 },
      positions: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
      normals: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      uvs: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]),
      material: 'mat',
      ambientCube: cube,
    });
    const opts = { sky3dArea: -1, cellSize: 2048, envIndex: () => -1, usesEnv: () => false };
    const [g] = mergeProps([mk(90)], opts);
    const P = Array.from(g.positions, (x) => Math.round(x * 1000) / 1000);
    // yaw 90: model +x -> world +y, model +y (left) -> world -x, z stays up
    expect(P.slice(0, 3)).toEqual([100, 210, 300]);
    expect(P.slice(3, 6)).toEqual([90, 200, 300]);
    expect(P.slice(6, 9)).toEqual([100, 200, 310]);
    const N = Array.from(g.normals, (x) => Math.round(x * 1000) / 1000 + 0);
    expect(N.slice(0, 3)).toEqual([0, 1, 0]);
    // light from the rotated normal: model +x faces world +y -> cube face +y = [0,0,1]
    expect(Array.from(g.light.slice(0, 3), (x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 0, 1]);
    // pitch 90: model forward points down
    const [d] = mergeProps([mk(0, 90)], opts);
    expect(Math.round(d.positions[2])).toBe(290);
  });

  it('groups by material, alpha, pass and cell; keeps 16-bit indices', () => {
    const base: RenderProp = {
      model: 'm',
      origin: { x: 0, y: 0, z: 0 },
      angles: { pitch: 0, yaw: 0, roll: 0 },
      positions: new Float32Array(3 * 30000),
      normals: new Float32Array(3 * 30000),
      uvs: new Float32Array(2 * 30000),
      indices: new Uint32Array([0, 1, 2]),
      material: 'a',
    };
    const opts = { sky3dArea: 5, cellSize: 2048, envIndex: () => -1, usesEnv: () => false };
    const groups = mergeProps(
      [
        base,
        base,
        base, // 90000 verts: must split
        { ...base, material: 'b' },
        { ...base, alpha: 0.5 },
        { ...base, area: 5 },
        { ...base, origin: { x: 5000, y: 0, z: 0 } },
        { ...base, alpha: 0 }, // invisible
        { ...base, origin: { x: NaN, y: 0, z: 0 } },
      ],
      opts,
    );
    expect(groups.every((g) => g.positions.length / 3 <= 65535)).toBe(true);
    expect(groups.find((g) => g.group.sky3d)).toBeTruthy();
    expect(groups.find((g) => g.group.alpha === 0.5)).toBeTruthy();
    expect(groups.filter((g) => g.group.material === 'b')).toHaveLength(1);
    const total = groups.reduce((s, g) => s + g.positions.length / 3, 0);
    expect(total).toBe(30000 * 7);
  });

  it('indexAttribute picks 16-bit indices when they fit', () => {
    expect(indexAttribute(new Uint32Array([0, 1, 2]), 3).array).toBeInstanceOf(Uint16Array);
    expect(indexAttribute(new Uint32Array([0, 1, 70000]), 70001).array).toBeInstanceOf(Uint32Array);
  });

  it('sky3dMatrix scales about the sky camera', () => {
    const m = sky3dMatrix({ x: 100, y: 0, z: -50 }, 16);
    expect(new Vector3(101, 2, -50).applyMatrix4(m).toArray()).toEqual([16, 32, 0]);
    const d = sky3dMatrix({ x: 0, y: 0, z: 0 }, 0);
    expect(d.elements[0]).toBe(16); // bad scale -> default 16
  });
});

describe('built-in maps', async () => {
  let mod: typeof import('../src/map/builtin/index') | null = null;
  try {
    mod = await import('../src/map/builtin/index');
  } catch {
    mod = null;
  }
  for (const info of mod?.BUILTIN_MAPS ?? []) {
    it(`${info.id}: synthetic lighting, no sky masks needed`, async () => {
      const map = mod!.buildBuiltinMap(info.id);
      const { scene } = await build(map);
      expect(scene.stats.meshes).toBeGreaterThan(0);
      const lit = scene.meshes().filter((m) => (m.material as ShaderMaterial).defines?.USE_SYNTH_LIGHT !== undefined);
      expect(lit.length).toBeGreaterThan(0);
      expect(scene.meshes().some((m) => m.geometry.getAttribute('lmuv'))).toBe(false);
    });
  }
});

const MAPS = process.env.SURF_TEST_MAPS ?? '';
describe.skipIf(!MAPS)('real maps', () => {
  for (const name of ['surf_utopia_njv', 'surf_kitsune', 'surf_mesa_fixed', 'surf_lt_omnific']) {
    it(name, async () => {
      const p = join(MAPS, `${name}.bsp`);
      if (!existsSync(p)) return;
      const { loadBspMap } = await import('../src/bsp/loadmap');
      const buf = readFileSync(p);
      const map = await loadBspMap(name, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), undefined, { log: () => {} });
      const t0 = performance.now();
      const { scene, materials, textures } = await build(map);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(20000);
      const tools = map.render.batches.filter((b) => map.render.materials.get(b.material)?.isTool && !(b.surfFlags & 6)).length;
      expect(scene.stats.meshes - scene.stats.propMeshes).toBe(map.render.batches.length - tools);
      // every lightmapped batch of a lit material got a lightmapped material
      for (const m of scene.meshes()) {
        const mat = m.material as ShaderMaterial;
        if (m.geometry.getAttribute('lmuv')) expect(mat.defines.USE_LIGHTMAP).toBe('');
        // bounds are finite
        expect(Number.isFinite(m.geometry.boundingSphere!.radius)).toBe(true);
      }
      if (map.render.sky3d && map.render.sky3d.area >= 0) expect(scene.stats.sky3dMeshes).toBeGreaterThan(0);
      // a material instance per (material, variant): far fewer than meshes
      expect(materials.materials.length).toBeLessThan(scene.stats.meshes + 2);
      expect(textures.count).toBeGreaterThan(0);
      scene.dispose();
      materials.dispose();
      textures.dispose();
    });
  }
});
