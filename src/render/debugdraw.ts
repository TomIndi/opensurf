// Debug geometry: wireframe boxes (triggers for r_drawtriggers, the zone editor) refreshed every frame from a
// preallocated buffer, and r_drawclips (player clip brushes as translucent volumes with outlines).
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  GLSL3,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { Vec3 } from '../core/vec3';
import { brushWindings } from '../physics/brushbuild';
import type { Brush } from '../physics/types';
import { CONTENTS_MONSTERCLIP, CONTENTS_PLAYERCLIP } from '../physics/types';
import { FLAT_FRAGMENT, FLAT_VERTEX } from './shaders';
import { srgbToLinear } from './worldmaterials';

export interface DebugBox {
  mins: Vec3;
  maxs: Vec3;
  color: [number, number, number];
}

/** The 12 edges of a box as 24 endpoints (indices into the 8 corners: bit 0 = x, bit 1 = y, bit 2 = z). */
export const BOX_EDGES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];

/** Writes box edges into position/colour arrays at vertex offset `v` (24 vertices); returns the next offset. */
export function writeBoxLines(pos: Float32Array, col: Float32Array, v: number, b: DebugBox): number {
  const x = [b.mins.x, b.maxs.x];
  const y = [b.mins.y, b.maxs.y];
  const z = [b.mins.z, b.maxs.z];
  const r = srgbToLinear(b.color?.[0] ?? 1);
  const g = srgbToLinear(b.color?.[1] ?? 1);
  const bl = srgbToLinear(b.color?.[2] ?? 1);
  for (let i = 0; i < 24; i++) {
    const c = BOX_EDGES[i];
    const o = (v + i) * 3;
    pos[o] = x[c & 1];
    pos[o + 1] = y[(c >> 1) & 1];
    pos[o + 2] = z[(c >> 2) & 1];
    col[o] = r;
    col[o + 1] = g;
    col[o + 2] = bl;
  }
  return v + 24;
}

function finiteBox(b: DebugBox): boolean {
  return (
    !!b &&
    !!b.mins &&
    !!b.maxs &&
    Number.isFinite(b.mins.x) &&
    Number.isFinite(b.mins.y) &&
    Number.isFinite(b.mins.z) &&
    Number.isFinite(b.maxs.x) &&
    Number.isFinite(b.maxs.y) &&
    Number.isFinite(b.maxs.z)
  );
}

/** Wireframe boxes: drawn normally plus faintly through walls. */
export class DebugBoxes {
  readonly root = new Group();
  private geometry = new BufferGeometry();
  private capacity = 0;
  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private readonly front: LineSegments;
  private readonly behind: LineSegments;
  private readonly matFront = new LineBasicMaterial({ vertexColors: true, transparent: false, depthTest: true, depthWrite: false });
  private readonly matBehind = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false });
  count = 0;

  constructor() {
    this.root.name = 'debug-boxes';
    this.front = new LineSegments(this.geometry, this.matFront);
    this.behind = new LineSegments(this.geometry, this.matBehind);
    this.front.frustumCulled = false;
    this.behind.frustumCulled = false;
    this.front.renderOrder = 20;
    this.behind.renderOrder = 21;
    this.root.add(this.front, this.behind);
    this.ensure(64);
  }

  private ensure(boxes: number): void {
    if (boxes <= this.capacity) return;
    let cap = Math.max(64, this.capacity);
    while (cap < boxes) cap *= 2;
    this.capacity = cap;
    this.pos = new Float32Array(cap * 24 * 3);
    this.col = new Float32Array(cap * 24 * 3);
    const g = new BufferGeometry();
    const pa = new BufferAttribute(this.pos, 3);
    const ca = new BufferAttribute(this.col, 3);
    pa.setUsage(DynamicDrawUsage);
    ca.setUsage(DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('color', ca);
    g.boundingSphere = new Sphere(new Vector3(), 1e9);
    g.setDrawRange(0, 0);
    this.geometry.dispose();
    this.geometry = g;
    this.front.geometry = g;
    this.behind.geometry = g;
  }

  set(boxes: readonly DebugBox[]): void {
    const list = boxes ?? [];
    this.ensure(list.length);
    let v = 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!finiteBox(b)) continue;
      v = writeBoxLines(this.pos, this.col, v, b);
      n++;
    }
    this.count = n;
    const pa = this.geometry.attributes.position as BufferAttribute;
    const ca = this.geometry.attributes.color as BufferAttribute;
    pa.clearUpdateRanges();
    ca.clearUpdateRanges();
    if (v > 0) {
      pa.addUpdateRange(0, v * 3);
      ca.addUpdateRange(0, v * 3);
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, v);
    this.root.visible = n > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.matFront.dispose();
    this.matBehind.dispose();
  }
}

/** Triangles + outline edges of clip brushes (CONTENTS_PLAYERCLIP / MONSTERCLIP). */
export function clipBrushGeometry(brushes: readonly Brush[]): { tris: Float32Array; normals: Float32Array; lines: Float32Array; count: number } {
  const tris: number[] = [];
  const normals: number[] = [];
  const lines: number[] = [];
  let count = 0;
  for (const b of brushes) {
    if (!b || !(b.contents & (CONTENTS_PLAYERCLIP | CONTENTS_MONSTERCLIP))) continue;
    let ws: Vec3[][];
    try {
      ws = brushWindings(b);
    } catch {
      continue;
    }
    count++;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      const side = b.sides[i];
      if (!w || w.length < 3 || !side || side.bevel) continue;
      const n = side.plane.normal;
      for (let k = 1; k + 1 < w.length; k++) {
        for (const p of [w[0], w[k], w[k + 1]]) {
          tris.push(p.x, p.y, p.z);
          normals.push(n.x, n.y, n.z);
        }
      }
      for (let k = 0; k < w.length; k++) {
        const a = w[k];
        const c = w[(k + 1) % w.length];
        lines.push(a.x, a.y, a.z, c.x, c.y, c.z);
      }
    }
  }
  return { tris: new Float32Array(tris), normals: new Float32Array(normals), lines: new Float32Array(lines), count };
}

/** r_drawclips: player clips in translucent magenta (like CS:GO's clip brush view). */
export class ClipBrushes {
  readonly root = new Group();
  private built = false;
  private geos: BufferGeometry[] = [];
  private readonly fill = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FLAT_VERTEX,
    fragmentShader: FLAT_FRAGMENT,
    uniforms: { uColor: { value: new Vector3(srgbToLinear(0.95), srgbToLinear(0.2), srgbToLinear(0.85)) }, uOpacity: { value: 0.18 } },
    side: DoubleSide,
  });
  private readonly edge = new LineBasicMaterial({ color: 0xff55ee, transparent: true, opacity: 0.75, depthWrite: false });
  count = 0;

  constructor() {
    this.root.name = 'clip-brushes';
    this.root.visible = false;
    this.fill.transparent = true;
    this.fill.depthWrite = false;
    this.fill.blending = NormalBlending;
  }

  /** Shows/hides; builds the geometry from `brushes` on first show. */
  setVisible(on: boolean, brushes: () => readonly Brush[]): void {
    if (on && !this.built) {
      this.built = true;
      const g = clipBrushGeometry(brushes());
      this.count = g.count;
      if (g.tris.length) {
        const tg = new BufferGeometry();
        tg.setAttribute('position', new BufferAttribute(g.tris, 3));
        tg.setAttribute('normal', new BufferAttribute(g.normals, 3));
        tg.computeBoundingSphere();
        const lg = new BufferGeometry();
        lg.setAttribute('position', new BufferAttribute(g.lines, 3));
        lg.computeBoundingSphere();
        const m = new Mesh(tg, this.fill);
        m.renderOrder = 15;
        const l = new LineSegments(lg, this.edge);
        l.renderOrder = 16;
        this.root.add(m, l);
        this.geos.push(tg, lg);
        this.root.updateMatrixWorld(true);
      }
    }
    this.root.visible = on;
  }

  /** Drops the built geometry (map change). */
  reset(): void {
    for (const g of this.geos) g.dispose();
    this.geos = [];
    this.root.clear();
    this.built = false;
    this.count = 0;
  }

  dispose(): void {
    this.reset();
    this.fill.dispose();
    this.edge.dispose();
  }
}
