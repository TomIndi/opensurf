// SurfTimer-style zone beams in the zone type's colour, gently pulsing. Two styles (r_drawzones 1 / 2):
//   'floor' (default) - the look of zone beams on CS:GO surf servers: a bright rectangle just above the zone's
//            floor with a soft glow, and short corner posts fading upward. Nothing crosses the view at eye
//            level in a spawn room.
//   'box'   - the whole box: the floor rectangle, corner posts fading upward and a faint top.
// Zones of other courses (bonuses while on the main course and vice versa) are dimmer.
import { BufferAttribute, BufferGeometry, CustomBlending, GLSL3, Mesh, OneFactor, ShaderMaterial, Sphere, Vector3 } from 'three';
import type { ZoneDef, ZoneType } from '../map/types';
import { BEAM_FRAGMENT, BEAM_VERTEX } from './shaders';
import { U, srgbToLinear } from './worldmaterials';

/** Zone colours (sRGB) like SurfTimer's defaults: start green, end red, stage cyan, checkpoint orange. */
export const ZONE_COLORS: Readonly<Record<ZoneType, [number, number, number]>> = {
  start: [0.1, 1.0, 0.25],
  end: [1.0, 0.12, 0.1],
  stage: [0.1, 0.85, 1.0],
  checkpoint: [1.0, 0.55, 0.08],
  stop: [0.62, 0.62, 0.66],
  speedstart: [0.62, 0.62, 0.66],
  teletostart: [0.62, 0.62, 0.66],
  validator: [0.62, 0.62, 0.66],
  checker: [0.62, 0.62, 0.66],
  antijump: [0.62, 0.62, 0.66],
  antiduck: [0.62, 0.62, 0.66],
  maxspeed: [0.62, 0.62, 0.66],
};

export function zoneColor(type: ZoneType | string): [number, number, number] {
  return (ZONE_COLORS as Record<string, [number, number, number]>)[type] ?? [0.62, 0.62, 0.66];
}

export interface BeamSegment {
  a: [number, number, number];
  b: [number, number, number];
  /** Linear RGB. */
  color: [number, number, number];
  intensity: number;
  /** Intensity factor at b (posts fade upward). */
  fade: number;
  width: number;
  /** 1: a soft glow band (no bright core) around a beam; 0 / absent: a beam. */
  soft?: number;
}

/** How zones are drawn (RenderSettings.zoneStyle): outline on the zone's floor, or the whole box. */
export type ZoneStyle = 'floor' | 'box';
export const DEFAULT_ZONE_STYLE: ZoneStyle = 'floor';

/** Intensities of the parts of a zone box. */
export const BEAM_BOTTOM = 1.0;
export const BEAM_POST = 0.75;
export const BEAM_POST_TOP_FADE = 0.15;
export const BEAM_TOP = 0.22;
export const INACTIVE_GROUP_DIM = 0.35;
/** Beam half-width in world units (SurfTimer beams are ~1-2 units wide). */
export const BEAM_HALF_WIDTH = 1.1;
/** Floor style: how far above the zone's bottom the rectangle runs (zones usually sit on a floor). */
export const FLOOR_BEAM_LIFT = 1;
/** Floor style: the soft glow band around the floor rectangle. */
export const BEAM_GLOW = 0.3;
export const BEAM_GLOW_HALF_WIDTH = 7;
/** Floor style: corner posts this tall (well below eye level, 64), fading out upward. */
export const FLOOR_POST_HEIGHT = 40;

function finiteBox(z: ZoneDef): boolean {
  const v = [z.mins?.x, z.mins?.y, z.mins?.z, z.maxs?.x, z.maxs?.y, z.maxs?.z];
  return v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * The beam segments of a set of zones. 'box': 12 per zone (4 bottom, 4 posts, 4 top). 'floor' (default): 12
 * per zone - the 4 bottom beams, their 4 soft glow bands and 4 short posts fading out upward (no top edges).
 */
export function zoneSegments(zones: readonly ZoneDef[], activeGroup: number, style: ZoneStyle = DEFAULT_ZONE_STYLE): BeamSegment[] {
  const out: BeamSegment[] = [];
  const box = style === 'box';
  for (const z of zones) {
    if (!z || !finiteBox(z)) continue;
    const x0 = Math.min(z.mins.x, z.maxs.x);
    const x1 = Math.max(z.mins.x, z.maxs.x);
    const y0 = Math.min(z.mins.y, z.maxs.y);
    const y1 = Math.max(z.mins.y, z.maxs.y);
    const zb = Math.min(z.mins.z, z.maxs.z);
    const z1 = Math.max(z.maxs.z, z.mins.z);
    // just above the floor the zone usually sits on
    const z0 = Math.min(z1, zb + (box ? 0.5 : FLOOR_BEAM_LIFT));
    const srgb = zoneColor(z.type);
    const color: [number, number, number] = [srgbToLinear(srgb[0]), srgbToLinear(srgb[1]), srgbToLinear(srgb[2])];
    const dim = (z.group ?? 0) === activeGroup ? 1 : INACTIVE_GROUP_DIM;
    const corners: [number, number][] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i];
      const [bx, by] = corners[(i + 1) % 4];
      out.push({ a: [ax, ay, z0], b: [bx, by, z0], color, intensity: BEAM_BOTTOM * dim, fade: 1, width: BEAM_HALF_WIDTH });
    }
    if (!box) {
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i];
        const [bx, by] = corners[(i + 1) % 4];
        out.push({ a: [ax, ay, z0], b: [bx, by, z0], color, intensity: BEAM_GLOW * dim, fade: 1, width: BEAM_GLOW_HALF_WIDTH, soft: 1 });
      }
      const top = Math.min(z1, z0 + FLOOR_POST_HEIGHT);
      if (top - z0 > 1) {
        for (let i = 0; i < 4; i++) {
          const [ax, ay] = corners[i];
          out.push({ a: [ax, ay, z0], b: [ax, ay, top], color, intensity: BEAM_POST * dim, fade: 0, width: BEAM_HALF_WIDTH * 0.8 });
        }
      }
      continue;
    }
    if (z1 - z0 > 1) {
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i];
        out.push({ a: [ax, ay, z0], b: [ax, ay, z1], color, intensity: BEAM_POST * dim, fade: BEAM_POST_TOP_FADE, width: BEAM_HALF_WIDTH * 0.8 });
      }
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i];
        const [bx, by] = corners[(i + 1) % 4];
        out.push({ a: [ax, ay, z1], b: [bx, by, z1], color, intensity: BEAM_TOP * dim, fade: 1, width: BEAM_HALF_WIDTH * 0.7 });
      }
    }
  }
  return out;
}

/** Beam quads: 4 vertices / 6 indices per segment (see BEAM_VERTEX). */
export function beamGeometry(segs: readonly BeamSegment[]): BufferGeometry {
  const n = segs.length;
  const start = new Float32Array(n * 4 * 3);
  const end = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const color = new Float32Array(n * 4 * 4);
  const width = new Float32Array(n * 4);
  const fade = new Float32Array(n * 4);
  const soft = new Float32Array(n * 4);
  const pos = new Float32Array(n * 4 * 3);
  const index = new Uint32Array(n * 6);
  const CORNERS = [
    [0, -1],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  let minx = Infinity;
  let miny = Infinity;
  let minz = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  let maxz = -Infinity;
  for (let s = 0; s < n; s++) {
    const g = segs[s];
    for (let k = 0; k < 4; k++) {
      const v = s * 4 + k;
      start.set(g.a, v * 3);
      end.set(g.b, v * 3);
      pos.set(CORNERS[k][0] ? g.b : g.a, v * 3);
      corner[v * 2] = CORNERS[k][0];
      corner[v * 2 + 1] = CORNERS[k][1];
      color[v * 4] = g.color[0];
      color[v * 4 + 1] = g.color[1];
      color[v * 4 + 2] = g.color[2];
      color[v * 4 + 3] = g.intensity;
      width[v] = g.width;
      fade[v] = g.fade;
      soft[v] = g.soft ?? 0;
    }
    for (const p of [g.a, g.b]) {
      minx = Math.min(minx, p[0]);
      miny = Math.min(miny, p[1]);
      minz = Math.min(minz, p[2]);
      maxx = Math.max(maxx, p[0]);
      maxy = Math.max(maxy, p[1]);
      maxz = Math.max(maxz, p[2]);
    }
    const b = s * 4;
    index.set([b, b + 1, b + 2, b, b + 2, b + 3], s * 6);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('aStart', new BufferAttribute(start, 3));
  geo.setAttribute('aEnd', new BufferAttribute(end, 3));
  geo.setAttribute('aCorner', new BufferAttribute(corner, 2));
  geo.setAttribute('aColor', new BufferAttribute(color, 4));
  geo.setAttribute('aWidth', new BufferAttribute(width, 1));
  geo.setAttribute('aFade', new BufferAttribute(fade, 1));
  geo.setAttribute('aSoft', new BufferAttribute(soft, 1));
  geo.setIndex(new BufferAttribute(index, 1));
  if (n > 0) {
    const c = new Vector3((minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2);
    const r = Math.hypot(maxx - minx, maxy - miny, maxz - minz) / 2 + 64;
    geo.boundingSphere = new Sphere(c, r);
  } else geo.boundingSphere = new Sphere(new Vector3(), 0);
  return geo;
}

/** The zone beams object (one mesh, rebuilt when the zones change). */
export class ZoneBeams {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private key = '';
  private enabled = true;
  private style: ZoneStyle = DEFAULT_ZONE_STYLE;
  private zones: readonly ZoneDef[] = [];
  private group = 0;

  constructor(time: U<number>, pixelScale: U<number>) {
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: BEAM_VERTEX,
      fragmentShader: BEAM_FRAGMENT,
      uniforms: {
        uTime: time,
        uPixelScale: pixelScale,
        uMinPixels: { value: 1.8 },
        uPulse: { value: 0.12 },
        uOpacity: { value: 1 },
      },
    });
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.depthTest = true;
    this.material.blending = CustomBlending;
    this.material.blendSrc = OneFactor;
    this.material.blendDst = OneFactor;
    this.material.blendSrcAlpha = OneFactor;
    this.material.blendDstAlpha = OneFactor;
    this.mesh = new Mesh(new BufferGeometry(), this.material);
    this.mesh.name = 'zones';
    this.mesh.frustumCulled = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  /** Replaces the zones (cheap no-op when nothing changed). */
  set(zones: readonly ZoneDef[], activeGroup: number): void {
    this.zones = zones ?? [];
    this.group = activeGroup;
    const key = `${this.style}|${zoneKey(this.zones, activeGroup)}`;
    if (key === this.key) return;
    this.key = key;
    const segs = zoneSegments(this.zones, activeGroup, this.style);
    this.mesh.geometry.dispose();
    this.mesh.geometry = beamGeometry(segs);
    this.mesh.userData.segments = segs.length;
    this.refresh();
  }

  /** r_drawzones 1 / 2: outline on the zone floor or the full box (rebuilds the beams when it changes). */
  setStyle(style: ZoneStyle | undefined | null): void {
    const st: ZoneStyle = style === 'box' ? 'box' : 'floor';
    if (st === this.style) return;
    this.style = st;
    this.set(this.zones, this.group);
  }

  get zoneStyle(): ZoneStyle {
    return this.style;
  }

  /** r_drawzones. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.refresh();
  }

  private refresh(): void {
    this.mesh.visible = this.enabled && (this.mesh.userData.segments ?? 0) > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

function zoneKey(zones: readonly ZoneDef[], g: number): string {
  const parts: string[] = [String(g)];
  for (const z of zones ?? []) {
    if (!z) continue;
    parts.push(`${z.type}:${z.group}:${z.index}:${z.mins?.x},${z.mins?.y},${z.mins?.z},${z.maxs?.x},${z.maxs?.y},${z.maxs?.z}`);
  }
  return parts.join(';');
}
