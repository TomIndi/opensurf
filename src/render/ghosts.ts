// Replay ghosts: a stylized translucent humanoid (capsule body + head, shorter when ducked, a bright visor on
// the facing side), a name label that stays readable at a distance and an optional additive trail that fades
// over ~1.5 s (like an env_spritetrail on a SurfTimer replay bot).
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CustomBlending,
  DoubleSide,
  GLSL3,
  Group,
  LinearFilter,
  Mesh,
  NormalBlending,
  OneFactor,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  FrontSide,
} from 'three';
import type { GhostState } from '../game/api';
import { GHOST_FRAGMENT, GHOST_VERTEX, TRAIL_FRAGMENT, TRAIL_VERTEX } from './shaders';
import { U, srgbToLinearVec } from './worldmaterials';

export const GHOST_STAND_HEIGHT = 72;
export const GHOST_DUCK_HEIGHT = 54;
export const TRAIL_SECONDS = 1.5;
const TRAIL_MAX = 256;
const TRAIL_HALF_WIDTH = 5;
const TRAIL_HEIGHT = 36;
/** A jump larger than this between frames is a teleport: the trail restarts. */
const TRAIL_TELEPORT = 640;

/** Body + head layout for a pose (world units above the feet). */
export function ghostPose(ducked: boolean): { bodyRadius: number; bodyLength: number; bodyCenter: number; headCenter: number; headRadius: number; height: number } {
  const height = ducked ? GHOST_DUCK_HEIGHT : GHOST_STAND_HEIGHT;
  const headRadius = 7.5;
  const headCenter = height - headRadius;
  const bodyRadius = 11.5;
  const bodyTop = headCenter - headRadius - 1.5;
  const bodyLength = Math.max(1, bodyTop - 2 * bodyRadius);
  return { bodyRadius, bodyLength, bodyCenter: bodyRadius + bodyLength / 2, headCenter, headRadius, height };
}

function capsuleZ(radius: number, length: number): BufferGeometry {
  const g = new CapsuleGeometry(radius, length, 6, 16, 1);
  g.rotateX(Math.PI / 2); // three.js capsules stand along +Y; ours along +Z
  return g;
}

interface TrailSample {
  x: number;
  y: number;
  z: number;
  t: number;
}

class GhostObject {
  readonly group = new Group();
  readonly body: Mesh;
  readonly head: Mesh;
  readonly label: Sprite;
  readonly trail: Mesh;
  private readonly material: ShaderMaterial;
  private readonly trailMaterial: ShaderMaterial;
  private readonly labelMaterial: SpriteMaterial;
  private labelTexture: CanvasTexture | null = null;
  private labelAspect = 4;
  private name = '';
  private ducked = false;
  /** Ring buffer of trail samples (preallocated: no per-frame allocation). */
  private readonly ring: TrailSample[] = Array.from({ length: TRAIL_MAX }, () => ({ x: 0, y: 0, z: 0, t: 0 }));
  private ringHead = 0; // index of the oldest sample
  private count = 0;
  private readonly trailPos: Float32Array;
  private readonly trailFade: Float32Array;
  private readonly trailSide: Float32Array;
  readonly forward = new Vector3(1, 0, 0);
  state: GhostState | null = null;

  constructor(
    private readonly shared: { stand: BufferGeometry; duck: BufferGeometry; head: BufferGeometry; time: U<number> },
  ) {
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: GHOST_VERTEX,
      fragmentShader: GHOST_FRAGMENT,
      uniforms: {
        uColor: { value: new Vector3(0.5, 0.8, 1) },
        uOpacity: { value: 1 },
        uTime: shared.time,
        uForward: { value: this.forward },
        uHeight: { value: GHOST_STAND_HEIGHT },
      },
      side: FrontSide,
    });
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.blending = NormalBlending;
    this.body = new Mesh(shared.stand, this.material);
    this.head = new Mesh(shared.head, this.material);
    this.body.name = 'ghost-body';
    this.head.name = 'ghost-head';
    this.group.add(this.body, this.head);
    this.labelMaterial = new SpriteMaterial({ transparent: true, depthWrite: false, depthTest: true, sizeAttenuation: true });
    this.label = new Sprite(this.labelMaterial);
    this.label.center.set(0.5, 0);
    this.label.name = 'ghost-label';
    this.group.add(this.label);

    this.trailPos = new Float32Array(TRAIL_MAX * 2 * 3);
    this.trailFade = new Float32Array(TRAIL_MAX * 2);
    this.trailSide = new Float32Array(TRAIL_MAX * 2);
    const tg = new BufferGeometry();
    tg.setAttribute('position', new BufferAttribute(this.trailPos, 3));
    tg.setAttribute('aFade', new BufferAttribute(this.trailFade, 1));
    tg.setAttribute('aSide', new BufferAttribute(this.trailSide, 1));
    const idx = new Uint16Array((TRAIL_MAX - 1) * 6);
    for (let i = 0; i < TRAIL_MAX - 1; i++) {
      const a = i * 2;
      idx.set([a, a + 1, a + 3, a, a + 3, a + 2], i * 6);
    }
    tg.setIndex(new BufferAttribute(idx, 1));
    tg.setDrawRange(0, 0);
    this.trailMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: TRAIL_VERTEX,
      fragmentShader: TRAIL_FRAGMENT,
      uniforms: { uColor: { value: new Vector3(0.5, 0.8, 1) }, uOpacity: { value: 0.9 } },
      side: DoubleSide,
    });
    this.trailMaterial.transparent = true;
    this.trailMaterial.depthWrite = false;
    this.trailMaterial.blending = CustomBlending;
    this.trailMaterial.blendSrc = OneFactor;
    this.trailMaterial.blendDst = OneFactor;
    this.trailMaterial.blendSrcAlpha = OneFactor;
    this.trailMaterial.blendDstAlpha = OneFactor;
    this.trail = new Mesh(tg, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.trail.name = 'ghost-trail';
    this.trail.matrixAutoUpdate = false;
  }

  apply(s: GhostState): void {
    this.state = s;
    const o = s.origin;
    const ok = !!o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
    this.group.visible = !!s.visible && ok;
    if (!ok) return;
    this.group.position.set(o.x, o.y, o.z);
    const yaw = ((s.angles?.yaw ?? 0) * Math.PI) / 180;
    this.forward.set(Math.cos(yaw), Math.sin(yaw), 0);
    const c = s.color ?? [0.5, 0.8, 1];
    srgbToLinearVec(c, this.material.uniforms.uColor.value as Vector3);
    srgbToLinearVec(c, this.trailMaterial.uniforms.uColor.value as Vector3);
    if (!!s.ducked !== this.ducked || this.body.userData.init !== true) {
      this.ducked = !!s.ducked;
      this.body.userData.init = true;
      const p = ghostPose(this.ducked);
      this.body.geometry = this.ducked ? this.shared.duck : this.shared.stand;
      this.body.position.set(0, 0, p.bodyCenter);
      this.head.position.set(0, 0, p.headCenter);
      this.label.position.set(0, 0, p.height + 6);
      (this.material.uniforms.uHeight as U<number>).value = p.height;
    }
    const name = s.name ?? '';
    if (name !== this.name) {
      this.name = name;
      this.drawLabel(name, c);
    }
    this.label.visible = name.length > 0;
    this.group.updateMatrixWorld(true);
  }

  private drawLabel(name: string, color: readonly number[]): void {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const font = '600 40px "Barlow Semi Condensed", "Segoe UI", Arial, sans-serif';
    ctx.font = font;
    const text = name.length > 32 ? `${name.slice(0, 31)}…` : name;
    const w = Math.ceil(ctx.measureText(text).width) + 36;
    const h = 60;
    canvas.width = Math.max(64, w);
    canvas.height = h;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(8, 12, 18, 0.55)';
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(r, 4);
    ctx.lineTo(canvas.width - r, 4);
    ctx.quadraticCurveTo(canvas.width - 4, 4, canvas.width - 4, r);
    ctx.lineTo(canvas.width - 4, h - r);
    ctx.quadraticCurveTo(canvas.width - 4, h - 4, canvas.width - r, h - 4);
    ctx.lineTo(r, h - 4);
    ctx.quadraticCurveTo(4, h - 4, 4, h - r);
    ctx.lineTo(4, r);
    ctx.quadraticCurveTo(4, 4, r, 4);
    ctx.fill();
    const cc = color.map((x) => Math.round(Math.max(0, Math.min(1, 0.35 + 0.65 * x)) * 255));
    ctx.fillStyle = `rgb(${cc[0]}, ${cc[1]}, ${cc[2]})`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillText(text, canvas.width / 2, h / 2 + 1);
    this.labelTexture?.dispose();
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    this.labelTexture = tex;
    this.labelMaterial.map = tex;
    this.labelMaterial.needsUpdate = true;
    this.labelAspect = canvas.width / canvas.height;
  }

  /** Per-frame: trail samples, label size. */
  update(time: number, cam: Vector3, pixelScale: number): void {
    const s = this.state;
    if (!s) return;
    const visible = this.group.visible;
    // label: ~16 world units tall up close, never smaller than ~14 px
    if (this.label.visible) {
      const d = cam.distanceTo(this.group.position);
      const h = Math.max(13, d * pixelScale * 14);
      this.label.scale.set(h * this.labelAspect, h, 1);
      this.label.updateMatrixWorld();
    }
    this.updateTrail(time, cam, visible && !!s.trail);
  }

  private sample(i: number): TrailSample {
    return this.ring[(this.ringHead + i) % TRAIL_MAX];
  }

  private pushSample(x: number, y: number, z: number, t: number): void {
    if (this.count === TRAIL_MAX) {
      this.ringHead = (this.ringHead + 1) % TRAIL_MAX;
      this.count--;
    }
    const s = this.ring[(this.ringHead + this.count) % TRAIL_MAX];
    s.x = x;
    s.y = y;
    s.z = z;
    s.t = t;
    this.count++;
  }

  private updateTrail(time: number, cam: Vector3, on: boolean): void {
    const geo = this.trail.geometry;
    if (!on) {
      this.count = 0;
      this.trail.visible = false;
      geo.setDrawRange(0, 0);
      return;
    }
    const p = this.group.position;
    const pz = p.z + TRAIL_HEIGHT;
    if (this.count) {
      const last = this.sample(this.count - 1);
      const jump = Math.hypot(p.x - last.x, p.y - last.y, pz - last.z);
      if (jump > TRAIL_TELEPORT || time < last.t) this.count = 0;
    }
    if (!this.count) this.pushSample(p.x, p.y, pz, time);
    else {
      const prev = this.sample(this.count - 1);
      if (time - prev.t >= 1 / 120 || Math.hypot(p.x - prev.x, p.y - prev.y, pz - prev.z) > 24) this.pushSample(p.x, p.y, pz, time);
      else {
        // keep the head of the trail glued to the ghost between samples
        prev.x = p.x;
        prev.y = p.y;
        prev.z = pz;
      }
    }
    while (this.count && time - this.sample(0).t > TRAIL_SECONDS) {
      this.ringHead = (this.ringHead + 1) % TRAIL_MAX;
      this.count--;
    }
    const n = this.count;
    if (n < 2) {
      this.trail.visible = false;
      geo.setDrawRange(0, 0);
      return;
    }
    for (let i = 0; i < n; i++) {
      const a = this.sample(Math.max(0, i - 1));
      const b = this.sample(Math.min(n - 1, i + 1));
      const c = this.sample(i);
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      let tz = b.z - a.z;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const vx = cam.x - c.x;
      const vy = cam.y - c.y;
      const vz = cam.z - c.z;
      let sx = ty * vz - tz * vy;
      let sy = tz * vx - tx * vz;
      let sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const age = Math.max(0, Math.min(1, (time - c.t) / TRAIL_SECONDS));
      const w = TRAIL_HALF_WIDTH * (0.35 + 0.65 * (1 - age));
      sx = (sx / sl) * w;
      sy = (sy / sl) * w;
      sz = (sz / sl) * w;
      const o = i * 6;
      this.trailPos[o] = c.x - sx;
      this.trailPos[o + 1] = c.y - sy;
      this.trailPos[o + 2] = c.z - sz;
      this.trailPos[o + 3] = c.x + sx;
      this.trailPos[o + 4] = c.y + sy;
      this.trailPos[o + 5] = c.z + sz;
      this.trailFade[i * 2] = 1 - age;
      this.trailFade[i * 2 + 1] = 1 - age;
      this.trailSide[i * 2] = -1;
      this.trailSide[i * 2 + 1] = 1;
    }
    const pa = geo.attributes.position as BufferAttribute;
    const fa = geo.attributes.aFade as BufferAttribute;
    const sa = geo.attributes.aSide as BufferAttribute;
    pa.clearUpdateRanges();
    pa.addUpdateRange(0, n * 6);
    pa.needsUpdate = true;
    fa.clearUpdateRanges();
    fa.addUpdateRange(0, n * 2);
    fa.needsUpdate = true;
    sa.clearUpdateRanges();
    sa.addUpdateRange(0, n * 2);
    sa.needsUpdate = true;
    geo.setDrawRange(0, (n - 1) * 6);
    this.trail.visible = true;
  }

  get trailSamples(): number {
    return this.count;
  }

  dispose(): void {
    this.material.dispose();
    this.trailMaterial.dispose();
    this.trail.geometry.dispose();
    this.labelMaterial.dispose();
    this.labelTexture?.dispose();
  }
}

/** All ghosts, keyed by GhostState.id. */
export class Ghosts {
  readonly root = new Group();
  private readonly objects = new Map<string, GhostObject>();
  private readonly shared: { stand: BufferGeometry; duck: BufferGeometry; head: BufferGeometry; time: U<number> };
  private readonly seen = new Set<string>();

  constructor(time: U<number>) {
    const stand = ghostPose(false);
    const duck = ghostPose(true);
    this.shared = {
      stand: capsuleZ(stand.bodyRadius, stand.bodyLength),
      duck: capsuleZ(duck.bodyRadius, duck.bodyLength),
      head: new SphereGeometry(stand.headRadius, 16, 12),
      time,
    };
    this.root.name = 'ghosts';
  }

  set(ghosts: readonly GhostState[]): void {
    this.seen.clear();
    for (const g of ghosts ?? []) {
      if (!g || typeof g.id !== 'string') continue;
      this.seen.add(g.id);
      let o = this.objects.get(g.id);
      if (!o) {
        o = new GhostObject(this.shared);
        this.objects.set(g.id, o);
        this.root.add(o.group, o.trail);
      }
      o.apply(g);
    }
    for (const [id, o] of this.objects) {
      if (this.seen.has(id)) continue;
      this.root.remove(o.group, o.trail);
      o.dispose();
      this.objects.delete(id);
    }
  }

  update(time: number, cam: Vector3, pixelScale: number): void {
    for (const o of this.objects.values()) o.update(time, cam, pixelScale);
  }

  get count(): number {
    return this.objects.size;
  }

  /** For tests/diagnostics. */
  get(id: string): { group: Group; trailSamples: number; trailVisible: boolean } | null {
    const o = this.objects.get(id);
    return o ? { group: o.group, trailSamples: o.trailSamples, trailVisible: o.trail.visible } : null;
  }

  dispose(): void {
    this.set([]);
    this.shared.stand.dispose();
    this.shared.duck.dispose();
    this.shared.head.dispose();
  }
}
