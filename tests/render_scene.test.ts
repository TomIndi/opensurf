import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DoubleSide, FrontSide, Mesh, ShaderMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { LoadedMap, RenderProp } from '../src/map/types';
import { FIXTURE_SKY3D, buildFixtureMap, fixtureMaterial, quadBatch } from '../src/render/fixtures';
import { SURF_SKY } from '../src/bsp/types';
import { brushFromBox } from '../src/physics/brushbuild';
import { CollisionWorld } from '../src/physics/collision';
import { CONTENTS_SOLID } from '../src/physics/types';
import {
  INVERTED_FACE_THRESHOLD,
  MapScene,
  ORDER_DECAL,
  ORDER_DECAL_TRANSLUCENT,
  ORDER_SKY_MASK,
  evalAmbientCube,
  fallbackCube,
  indexAttribute,
  isEmptyCube,
  mergeProps,
  auditFaceOrientation,
  auditSaysInverted,
  pairedWaterBatches,
  sky3dMatrix,
} from '../src/render/mapscene';
import { TextureCache } from '../src/render/textures';
import { SurfaceMaterials, createSharedUniforms, srgbToLinear } from '../src/render/worldmaterials';

const caps = { maxAnisotropy: 8, s3tc: false, maxTextureSize: 4096 };

async function build(map: LoadedMap, opts: { mergeBrushEntities?: boolean; mergeWorld?: boolean; doubleSided?: boolean | 'auto' } = {}) {
  const textures = new TextureCache(caps);
  const shared = createSharedUniforms();
  const materials = new SurfaceMaterials({ textures, shared });
  const scene = new MapScene(map, { textures, materials, shared, ...opts });
  await scene.build();
  return { scene, textures, materials, shared };
}

const meshesNamed = (s: MapScene, name: string) => s.meshes().filter((m) => m.name === name);

describe('MapScene with the fixture map', () => {
  it('builds one mesh per drawable batch; tool faces are skipped', async () => {
    const map = buildFixtureMap();
    const { scene } = await build(map, { mergeBrushEntities: false, mergeWorld: false });
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
    expect(sky3d.length).toBe(1); // the block's 6 faces merged into one mesh
    expect(sky3d[0].geometry.index!.count).toBe(36);
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

  it('brush entities (unmerged): visibility, alpha and colour per model', async () => {
    const { scene } = await build(buildFixtureMap(), { mergeBrushEntities: false });
    const door = meshesNamed(scene, 'fixture/door');
    expect(door).toHaveLength(6);
    const mat = door[0].material as ShaderMaterial;
    expect(door.every((m) => m.material === mat)).toBe(true);
    expect(mat.defines.USE_MODEL_STATE).toBeUndefined();
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

  it('brush entities (merged): one draw for all models of a material, state in a texture', async () => {
    const map = buildFixtureMap();
    // a second brush entity with the same material
    const extra = map.render.batches.filter((b) => b.model === 1).map((b) => ({ ...b, model: 2, positions: b.positions.map((x, i) => (i % 3 === 0 ? x + 200 : x)) }));
    map.render.batches.push(...extra);
    const { scene } = await build(map);
    expect(scene.stats.mergedGroups).toBe(1);
    const group = scene.mergedGroups[0];
    expect([...group.models].sort()).toEqual([1, 2]);
    const opaque = group.opaque;
    const faded = group.faded!;
    expect(opaque.geometry).toBe(faded.geometry);
    expect(opaque.geometry.getAttribute('modelIndex').count).toBe(48);
    const om = opaque.material as ShaderMaterial;
    const fm = faded.material as ShaderMaterial;
    expect(om.defines.USE_MODEL_STATE).toBe('');
    expect(om.transparent).toBe(false);
    expect(fm.transparent).toBe(true);
    expect(om.uniforms.uModelPass.value).toBe(0);
    expect(fm.uniforms.uModelPass.value).toBe(1);
    expect(opaque.visible).toBe(true);
    expect(faded.visible).toBe(false);
    const tex = om.uniforms.modelState.value as { image: { data: Uint8Array; width: number }; version: number };
    const w = tex.image.width;
    const px = (id: number, row: number) => Array.from(tex.image.data.slice((row * w + id) * 4, (row * w + id) * 4 + 4));
    expect(px(1, 0).slice(0, 2)).toEqual([255, 255]);
    const v0 = tex.version;
    scene.setModelVisible(1, false);
    expect(px(1, 0)[0]).toBe(0);
    expect(tex.version).toBeGreaterThan(v0);
    expect(opaque.visible).toBe(true); // model 2 still drawn
    scene.setModelVisible(2, false);
    expect(opaque.visible).toBe(false); // nothing left to draw: skip the call
    scene.setModelVisible(1, true);
    scene.setModelVisible(2, true);
    scene.setModelAlpha(2, 0.5);
    expect(px(2, 0)[1]).toBe(128);
    expect(faded.visible).toBe(true);
    expect(opaque.visible).toBe(true);
    scene.setModelAlpha(2, 1);
    expect(faded.visible).toBe(false);
    scene.setModelColor(1, [1, 0, 0.5]);
    expect(px(1, 1).slice(0, 3)).toEqual([255, 0, Math.round(srgbToLinear(0.5) * 255)]);
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
    const opts = { sky3dArea: -1, envIndex: () => -1, usesEnv: () => false };
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

  it('groups by material, alpha and pass; splits big groups spatially; keeps 16-bit indices', () => {
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
    const opts = { sky3dArea: 5, envIndex: () => -1, usesEnv: () => false };
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

  it('splits big prop families into spatially coherent clusters of bounded size', () => {
    const tri = (x: number, y: number): RenderProp => ({
      model: 'm',
      origin: { x, y, z: 0 },
      angles: { pitch: 0, yaw: 0, roll: 0 },
      positions: new Float32Array(300 * 3),
      normals: new Float32Array(300 * 3),
      uvs: new Float32Array(300 * 2),
      indices: new Uint32Array(Array.from({ length: 300 }, (_, i) => i)), // 100 triangles
      material: 'rock',
    });
    const props: RenderProp[] = [];
    for (let i = 0; i < 40; i++) props.push(tri(i < 20 ? -8000 + i * 10 : 8000 + i * 10, 0));
    const groups = mergeProps(props, { sky3dArea: -1, envIndex: () => -1, usesEnv: () => false, maxClusterTriangles: 1000 });
    expect(groups.length).toBeGreaterThanOrEqual(4);
    for (const g of groups) {
      expect(g.indices.length / 3).toBeLessThanOrEqual(1000);
      // no cluster mixes the two far-apart halves
      expect(g.maxs.x - g.mins.x).toBeLessThan(1000);
    }
    expect(groups.reduce((n, g) => n + g.indices.length / 3, 0)).toBe(4000);
    // a small family stays one mesh
    expect(mergeProps(props.slice(0, 5), { sky3dArea: -1, envIndex: () => -1, usesEnv: () => false })).toHaveLength(1);
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

/**
 * A solid block (collision brush) whose 6 faces are drawn as quads; `flip` lists the faces emitted back to
 * front (as a loader that misreads dface_t.side would).
 */
function blockMap(flip: string[], extra: { water?: 'pair' | 'pair-inverted' | 'lone' } = {}): LoadedMap {
  const map = buildFixtureMap({ withSky3d: false });
  const v = (x: number, y: number, z: number) => ({ x, y, z });
  const materials = new Map([['block', fixtureMaterial('block')], ['water', fixtureMaterial('water', { isWater: true, translucent: true, waterFogColor: [0.1, 0.2, 0.3] })], ['water_beneath', fixtureMaterial('water_beneath', { isWater: true, translucent: true })], ['tools/toolsskybox', fixtureMaterial('tools/toolsskybox', { isSky: true })]]);
  const lo = v(-100, -100, 0);
  const hi = v(100, 100, 200);
  const faces: [string, [ReturnType<typeof v>, ReturnType<typeof v>, ReturnType<typeof v>, ReturnType<typeof v>], ReturnType<typeof v>][] = [
    ['-z', [v(lo.x, lo.y, lo.z), v(hi.x, lo.y, lo.z), v(hi.x, hi.y, lo.z), v(lo.x, hi.y, lo.z)], v(0, 0, -1)],
    ['+z', [v(lo.x, lo.y, hi.z), v(hi.x, lo.y, hi.z), v(hi.x, hi.y, hi.z), v(lo.x, hi.y, hi.z)], v(0, 0, 1)],
    ['-x', [v(lo.x, lo.y, lo.z), v(lo.x, hi.y, lo.z), v(lo.x, hi.y, hi.z), v(lo.x, lo.y, hi.z)], v(-1, 0, 0)],
    ['+x', [v(hi.x, lo.y, lo.z), v(hi.x, hi.y, lo.z), v(hi.x, hi.y, hi.z), v(hi.x, lo.y, hi.z)], v(1, 0, 0)],
    ['-y', [v(lo.x, lo.y, lo.z), v(hi.x, lo.y, lo.z), v(hi.x, lo.y, hi.z), v(lo.x, lo.y, hi.z)], v(0, -1, 0)],
    ['+y', [v(lo.x, hi.y, lo.z), v(hi.x, hi.y, lo.z), v(hi.x, hi.y, hi.z), v(lo.x, hi.y, hi.z)], v(0, 1, 0)],
  ];
  const batches = [];
  // many copies so the audit has enough samples (each copy is its own batch)
  for (let k = 0; k < 8; k++) {
    for (const [name, c, n] of faces) {
      const out = flip.includes(name) ? v(-n.x, -n.y, -n.z) : n;
      batches.push(quadBatch('block', c, out, { lightmap: null }));
    }
  }
  // a sky face and a tool-less translucent face never count
  batches.push(quadBatch('tools/toolsskybox', faces[1][1], v(0, 0, -1), { surfFlags: SURF_SKY }));
  const wq = [v(200, -50, 50), v(300, -50, 50), v(300, 50, 50), v(200, 50, 50)] as [ReturnType<typeof v>, ReturnType<typeof v>, ReturnType<typeof v>, ReturnType<typeof v>];
  if (extra.water === 'pair' || extra.water === 'pair-inverted') {
    batches.push(quadBatch('water', wq, v(0, 0, 1)));
    batches.push(quadBatch('water_beneath', wq, extra.water === 'pair' ? v(0, 0, -1) : v(0, 0, 1)));
  } else if (extra.water === 'lone') batches.push(quadBatch('water', wq, v(0, 0, 1)));
  map.render.batches = batches;
  map.render.materials = materials;
  map.render.props = [];
  map.render.lightmap = null;
  map.collision = new CollisionWorld([brushFromBox(lo, hi, CONTENTS_SOLID)]);
  return map;
}

describe('face orientation audit', () => {
  it('counts faces wound toward the solid side as inverted', () => {
    const good = auditFaceOrientation(blockMap([]));
    expect(good.inverted).toBe(0);
    expect(good.correctArea).toBeCloseTo(good.correct * 200 * 200 / 2, -2); // 200x200 quads split in two triangles
    expect(good.correct).toBe(good.sampled); // every block face has solid behind and air in front
    expect(auditSaysInverted(good)).toBe(false);
    // a third of the faces back to front - what a loader flipping dface_t.side faces produces
    const bad = auditFaceOrientation(blockMap(['-x', '+y']));
    expect(bad.inverted / (bad.inverted + bad.correct)).toBeCloseTo(1 / 3, 1);
    expect(auditSaysInverted(bad)).toBe(true);
    // a few stray faces stay below the threshold
    const audit = (inverted: number, correct: number, invertedArea = inverted * 100, correctArea = correct * 100) => ({ sampled: inverted + correct, inverted, correct, ambiguous: 0, invertedArea, correctArea });
    expect(auditSaysInverted(audit(40, 960))).toBe(false);
    expect(auditSaysInverted(audit(160, 840))).toBe(INVERTED_FACE_THRESHOLD < 0.16);
    expect(auditSaysInverted(audit(10, 0))).toBe(false); // too few to judge
    // weighted by area: many inverted slivers (overlapping detail brushes) don't outvote the walls
    expect(auditSaysInverted(audit(300, 700, 300 * 5, 700 * 2000))).toBe(false);
    expect(auditSaysInverted(audit(100, 900, 100 * 4000, 900 * 1000))).toBe(true);
  });

  it('samples a bounded number of triangles and copes without collision', () => {
    const a = auditFaceOrientation(blockMap([]), 10);
    expect(a.sampled).toBeLessThanOrEqual(12);
    expect(a.sampled).toBeGreaterThan(0);
    const m = blockMap([]);
    (m as { collision: unknown }).collision = null;
    expect(auditFaceOrientation(m)).toEqual({ sampled: 0, inverted: 0, correct: 0, ambiguous: 0, invertedArea: 0, correctArea: 0 });
    const t = blockMap([]);
    (t.collision as { pointContents: unknown }).pointContents = () => {
      throw new Error('boom');
    };
    expect(auditFaceOrientation(t).inverted).toBe(0);
  });

  it("'auto' draws BSP surfaces double-sided only when the audit finds inverted faces", async () => {
    const sides = (s: MapScene) => new Set(s.meshes().filter((m) => !(m.material as ShaderMaterial).userData.surf?.isMask).map((m) => (m.material as ShaderMaterial).side));
    const ok = await build(blockMap([]));
    expect(ok.scene.doubleSided).toBe(false);
    expect(ok.scene.faceAudit!.correct).toBeGreaterThan(0);
    expect(sides(ok.scene)).toEqual(new Set([FrontSide]));
    const bad = await build(blockMap(['-x', '+y']));
    expect(bad.scene.doubleSided).toBe(true);
    expect(sides(bad.scene)).toEqual(new Set([DoubleSide]));
    // forced either way
    expect(sides((await build(blockMap(['-x', '+y']), { doubleSided: false })).scene)).toEqual(new Set([FrontSide]));
    const forced = await build(blockMap([]), { doubleSided: true });
    expect(forced.scene.faceAudit).toBeNull();
    expect(sides(forced.scene)).toEqual(new Set([DoubleSide]));
  });

  it('water: top/bottom face pairs are one-sided, lone surfaces double-sided', async () => {
    const waterSide = (s: MapScene) => s.meshes().filter((m) => /water/.test(m.name)).map((m) => (m.material as ShaderMaterial).side);
    const pair = blockMap([], { water: 'pair' });
    expect(pairedWaterBatches(pair.render.batches, pair.render.materials).size).toBe(2);
    expect(waterSide((await build(pair)).scene)).toEqual([FrontSide, FrontSide]);
    // both faces pointing up (bottom face emitted inside-out): no pair, both visible from both sides
    const inv = blockMap([], { water: 'pair-inverted' });
    expect(pairedWaterBatches(inv.render.batches, inv.render.materials).size).toBe(0);
    expect(waterSide((await build(inv)).scene)).toEqual([DoubleSide, DoubleSide]);
    const lone = blockMap([], { water: 'lone' });
    expect(waterSide((await build(lone)).scene)).toEqual([DoubleSide]);
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
      // unmerged: exactly one mesh per drawable batch
      const flat = await build(map, { mergeBrushEntities: false, mergeWorld: false });
      const tools = map.render.batches.filter((b) => map.render.materials.get(b.material)?.isTool && !(b.surfFlags & 6)).length;
      expect(flat.scene.stats.meshes - flat.scene.stats.propMeshes).toBe(map.render.batches.length - tools);
      // merged: the same triangles in far fewer meshes
      expect(scene.stats.triangles).toBe(flat.scene.stats.triangles);
      expect(scene.stats.meshes).toBeLessThan(flat.scene.stats.meshes);
      const ids = new Set(map.render.batches.filter((b) => b.model > 0).map((b) => b.model));
      for (const g of scene.mergedGroups) for (const id of g.models) expect(ids.has(id)).toBe(true);
      flat.scene.dispose();
      flat.materials.dispose();
      flat.textures.dispose();
      // every lightmapped batch of a lit material got a lightmapped material
      for (const m of scene.meshes()) {
        const mat = m.material as ShaderMaterial;
        if (m.geometry.getAttribute('lmuv')) expect(mat.defines.USE_LIGHTMAP).toBe('');
        // bounds are finite
        expect(Number.isFinite(m.geometry.boundingSphere!.radius)).toBe(true);
      }
      if (map.render.sky3d && map.render.sky3d.area >= 0) expect(scene.stats.sky3dMeshes).toBeGreaterThan(0);
      // the face orientation audit decides most samples, quickly, and drives the culling mode
      const ta = performance.now();
      const audit = auditFaceOrientation(map);
      expect(performance.now() - ta).toBeLessThan(1000);
      expect(audit.inverted + audit.correct).toBeGreaterThan(audit.sampled * 0.5);
      expect(scene.faceAudit).toEqual(audit);
      expect(scene.doubleSided).toBe(auditSaysInverted(audit));
      // a material instance per (material, variant): far fewer than meshes
      expect(materials.materials.length).toBeLessThan(scene.stats.meshes + 2);
      expect(textures.count).toBeGreaterThan(0);
      scene.dispose();
      materials.dispose();
      textures.dispose();
    });
  }
});
