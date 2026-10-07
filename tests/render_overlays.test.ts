import { BufferAttribute, LineSegments, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { GhostState } from '../src/game/api';
import type { ZoneDef } from '../src/map/types';
import { brushFromBox } from '../src/physics/brushbuild';
import { CONTENTS_PLAYERCLIP, CONTENTS_SOLID } from '../src/physics/types';
import { BOX_EDGES, ClipBrushes, DebugBoxes, clipBrushGeometry, writeBoxLines } from '../src/render/debugdraw';
import { GHOST_DUCK_HEIGHT, GHOST_STAND_HEIGHT, Ghosts, TRAIL_SECONDS, ghostPose } from '../src/render/ghosts';
import { srgbToLinear } from '../src/render/worldmaterials';
import { BEAM_BOTTOM, BEAM_POST, BEAM_TOP, INACTIVE_GROUP_DIM, ZoneBeams, beamGeometry, zoneColor, zoneSegments } from '../src/render/zones';

const zone = (type: ZoneDef['type'], group = 0, mins = [0, 0, 0], maxs = [100, 50, 128]): ZoneDef => ({
  type,
  group,
  index: 0,
  mins: { x: mins[0], y: mins[1], z: mins[2] },
  maxs: { x: maxs[0], y: maxs[1], z: maxs[2] },
});

describe('zone beams', () => {
  it('SurfTimer colours: start green, end red, stage cyan, checkpoint orange, others grey', () => {
    const [r, g, b] = zoneColor('start');
    expect(g).toBeGreaterThan(r + 0.5);
    expect(g).toBeGreaterThan(b + 0.5);
    expect(zoneColor('end')[0]).toBeGreaterThan(0.9);
    expect(zoneColor('end')[1]).toBeLessThan(0.3);
    const s = zoneColor('stage');
    expect(s[2]).toBeGreaterThan(0.9);
    expect(s[1]).toBeGreaterThan(0.6);
    expect(s[0]).toBeLessThan(0.3);
    const c = zoneColor('checkpoint');
    expect(c[0]).toBeGreaterThan(0.9);
    expect(c[1]).toBeGreaterThan(0.3);
    expect(c[2]).toBeLessThan(0.2);
    const o = zoneColor('teletostart');
    expect(Math.max(...o) - Math.min(...o)).toBeLessThan(0.1);
    expect(zoneColor('unknown-type')).toEqual(o);
  });

  it('12 segments per box: bright floor rectangle, fading posts, faint top', () => {
    const segs = zoneSegments([zone('start')], 0);
    expect(segs).toHaveLength(12);
    const bottom = segs.filter((s) => s.a[2] === s.b[2] && s.a[2] < 10);
    const top = segs.filter((s) => s.a[2] === s.b[2] && s.a[2] > 100);
    const posts = segs.filter((s) => s.a[2] !== s.b[2]);
    expect(bottom).toHaveLength(4);
    expect(top).toHaveLength(4);
    expect(posts).toHaveLength(4);
    expect(bottom[0].intensity).toBe(BEAM_BOTTOM);
    expect(posts[0].intensity).toBe(BEAM_POST);
    expect(posts[0].fade).toBeLessThan(1);
    expect(top[0].intensity).toBe(BEAM_TOP);
    expect(bottom[0].intensity).toBeGreaterThan(top[0].intensity);
    // colour in linear space
    expect(bottom[0].color[1]).toBeCloseTo(srgbToLinear(zoneColor('start')[1]), 6);
    // the rectangle is closed
    const pts = bottom.flatMap((s) => [s.a.join(), s.b.join()]);
    for (const p of pts) expect(pts.filter((q) => q === p)).toHaveLength(2);
  });

  it('other courses are dimmer; flat and broken zones are handled', () => {
    const segs = zoneSegments([zone('start', 0), zone('start', 2)], 0);
    expect(segs[12].intensity).toBeCloseTo(BEAM_BOTTOM * INACTIVE_GROUP_DIM, 6);
    expect(zoneSegments([zone('end', 0, [0, 0, 0], [10, 10, 0])], 0)).toHaveLength(4);
    expect(zoneSegments([zone('end', 0, [NaN, 0, 0]), null as unknown as ZoneDef], 0)).toHaveLength(0);
    // swapped mins/maxs still give a proper box
    const sw = zoneSegments([zone('stage', 0, [100, 50, 128], [0, 0, 0])], 0);
    expect(sw).toHaveLength(12);
  });

  it('beam geometry: 4 vertices / 6 indices per segment with both endpoints', () => {
    const segs = zoneSegments([zone('start'), zone('end')], 0);
    const g = beamGeometry(segs);
    expect(g.getAttribute('aStart').count).toBe(segs.length * 4);
    expect(g.index!.count).toBe(segs.length * 6);
    expect(g.getAttribute('aCorner').getX(2)).toBe(1);
    expect(g.boundingSphere!.radius).toBeGreaterThan(50);
    expect(beamGeometry([]).index!.count).toBe(0);
  });

  it('ZoneBeams: rebuilds only on change, honours r_drawzones', () => {
    const zb = new ZoneBeams({ value: 0 }, { value: 0.001 });
    expect(zb.mesh.visible).toBe(false);
    zb.set([zone('start')], 0);
    const g1 = zb.mesh.geometry;
    expect(zb.mesh.visible).toBe(true);
    zb.set([zone('start')], 0);
    expect(zb.mesh.geometry).toBe(g1);
    zb.set([zone('start')], 1);
    expect(zb.mesh.geometry).not.toBe(g1);
    zb.setEnabled(false);
    expect(zb.mesh.visible).toBe(false);
    zb.setEnabled(true);
    expect(zb.mesh.visible).toBe(true);
    zb.set([], 0);
    expect(zb.mesh.visible).toBe(false);
    zb.dispose();
  });
});

const ghost = (over: Partial<GhostState> = {}): GhostState => ({
  id: 'pb',
  origin: { x: 0, y: 0, z: 0 },
  angles: { pitch: 0, yaw: 90, roll: 0 },
  ducked: false,
  color: [0.3, 0.8, 1],
  name: 'PB',
  visible: true,
  trail: true,
  ...over,
});

describe('ghosts', () => {
  it('pose heights match the player hull (72 standing, 54 ducked)', () => {
    const s = ghostPose(false);
    const d = ghostPose(true);
    expect(s.height).toBe(GHOST_STAND_HEIGHT);
    expect(d.height).toBe(GHOST_DUCK_HEIGHT);
    expect(s.headCenter + s.headRadius).toBeCloseTo(72, 6);
    expect(d.headCenter + d.headRadius).toBeCloseTo(54, 6);
    expect(s.bodyCenter + s.bodyLength / 2 + s.bodyRadius).toBeLessThan(s.headCenter);
  });

  it('creates, updates and removes ghosts by id', () => {
    const g = new Ghosts({ value: 0 });
    g.set([ghost(), ghost({ id: 'wr', origin: { x: 100, y: 0, z: 0 } })]);
    expect(g.count).toBe(2);
    const pb = g.get('pb')!;
    expect(pb.group.visible).toBe(true);
    g.set([ghost({ origin: { x: 5, y: 6, z: 7 }, ducked: true })]);
    expect(g.count).toBe(1);
    expect(g.get('wr')).toBeNull();
    expect(pb.group.position.toArray()).toEqual([5, 6, 7]);
    const body = pb.group.children.find((c) => c.name === 'ghost-body') as Mesh;
    const head = pb.group.children.find((c) => c.name === 'ghost-head') as Mesh;
    expect(head.position.z).toBeCloseTo(ghostPose(true).headCenter, 6);
    expect(body.position.z).toBeCloseTo(ghostPose(true).bodyCenter, 6);
    g.set([ghost({ visible: false })]);
    expect(pb.group.visible).toBe(false);
    g.set([ghost({ origin: { x: NaN, y: 0, z: 0 } })]);
    expect(pb.group.visible).toBe(false);
    g.dispose();
    expect(g.count).toBe(0);
  });

  it('the trail keeps ~1.5 s of samples, restarts after teleports and hides when off', () => {
    const g = new Ghosts({ value: 0 });
    const cam = new Vector3(0, -500, 100);
    let t = 0;
    for (let i = 0; i < 300; i++) {
      t = i / 100;
      g.set([ghost({ origin: { x: i * 10, y: 0, z: 0 } })]);
      g.update(t, cam, 0.001);
    }
    const info = g.get('pb')!;
    expect(info.trailVisible).toBe(true);
    // samples at 100 Hz for TRAIL_SECONDS
    expect(info.trailSamples).toBeGreaterThan(TRAIL_SECONDS * 100 - 5);
    expect(info.trailSamples).toBeLessThanOrEqual(TRAIL_SECONDS * 100 + 2);
    g.set([ghost({ origin: { x: 1e5, y: 0, z: 0 } })]);
    g.update(t + 0.01, cam, 0.001);
    expect(g.get('pb')!.trailSamples).toBe(1);
    expect(g.get('pb')!.trailVisible).toBe(false);
    g.set([ghost({ trail: false })]);
    g.update(t + 0.02, cam, 0.001);
    expect(g.get('pb')!.trailSamples).toBe(0);
    g.dispose();
  });
});

describe('debug draw', () => {
  it('box edges cover all 12 edges once', () => {
    const edges = new Set<string>();
    for (let i = 0; i < 24; i += 2) {
      const a = BOX_EDGES[i];
      const b = BOX_EDGES[i + 1];
      // an edge joins corners differing in exactly one bit
      expect([1, 2, 4]).toContain(a ^ b);
      edges.add([Math.min(a, b), Math.max(a, b)].join());
    }
    expect(edges.size).toBe(12);
    const pos = new Float32Array(72);
    const col = new Float32Array(72);
    expect(writeBoxLines(pos, col, 0, { mins: { x: 0, y: 0, z: 0 }, maxs: { x: 1, y: 2, z: 3 }, color: [1, 0, 0] })).toBe(24);
    expect(Math.max(...pos)).toBe(3);
    expect(col[0]).toBe(1);
  });

  it('DebugBoxes grows its buffer and draws only what was given', () => {
    const d = new DebugBoxes();
    const boxes = Array.from({ length: 200 }, (_, i) => ({ mins: { x: i, y: 0, z: 0 }, maxs: { x: i + 1, y: 1, z: 1 }, color: [0, 1, 0] as [number, number, number] }));
    d.set(boxes);
    expect(d.count).toBe(200);
    const line = d.root.children[0] as LineSegments;
    expect(line.geometry.drawRange.count).toBe(200 * 24);
    expect((line.geometry.getAttribute('position') as BufferAttribute).array.length).toBeGreaterThanOrEqual(200 * 72);
    d.set([{ mins: { x: NaN, y: 0, z: 0 }, maxs: { x: 1, y: 1, z: 1 }, color: [1, 1, 1] }]);
    expect(d.count).toBe(0);
    expect(d.root.visible).toBe(false);
    d.dispose();
  });

  it('clip brushes: player clip volumes only, built on demand', () => {
    const clip = brushFromBox({ x: 0, y: 0, z: 0 }, { x: 64, y: 64, z: 64 }, CONTENTS_PLAYERCLIP);
    const solid = brushFromBox({ x: 100, y: 0, z: 0 }, { x: 164, y: 64, z: 64 }, CONTENTS_SOLID);
    const g = clipBrushGeometry([clip, solid]);
    expect(g.count).toBe(1);
    expect(g.tris.length / 9).toBe(12); // 6 quads
    expect(g.lines.length / 6).toBe(24); // 4 edges per face
    const c = new ClipBrushes();
    let calls = 0;
    c.setVisible(false, () => (calls++, [clip]));
    expect(calls).toBe(0);
    c.setVisible(true, () => (calls++, [clip]));
    c.setVisible(true, () => (calls++, [clip]));
    expect(calls).toBe(1);
    expect(c.count).toBe(1);
    expect(c.root.visible).toBe(true);
    c.reset();
    expect(c.root.children).toHaveLength(0);
    c.dispose();
  });
});
