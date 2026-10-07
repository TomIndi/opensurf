// Animated main-menu background: a slow fly-through over stylized surf ramps (triangular prisms) above a
// misty void, drawn with Canvas2D. Cheap (≈30 polygons/frame), pauses when hidden, honours reduced motion.

interface Ramp {
  x: number;
  y: number;
  z: number;
  len: number;
  w: number;
  h: number;
  skew: number;
  tone: number;
}

interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
}

interface Streak {
  x: number;
  y: number;
  z: number;
}

type P3 = [number, number, number];

const FAR = 7000;
const NEAR = 12;

export interface MenuBgTheme {
  skyTop: string;
  skyMid: string;
  horizon: string;
  glow: string;
  rampLit: [number, number, number];
  rampDark: [number, number, number];
  edge: string;
  fog: [number, number, number];
}

export const DEFAULT_THEME: MenuBgTheme = {
  skyTop: '#03060c',
  skyMid: '#081325',
  horizon: '#173a63',
  glow: 'rgba(80, 160, 255, 0.35)',
  rampLit: [70, 128, 222],
  rampDark: [20, 40, 86],
  edge: 'rgba(170, 225, 255, 0.85)',
  fog: [14, 34, 62],
};

export class MenuBackground {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private ramps: Ramp[] = [];
  private stars: Star[] = [];
  private streaks: Streak[] = [];
  private raf = 0;
  private running = false;
  private last = 0;
  private time = 0;
  private camZ = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private seed = 1234567;
  private reduced = false;
  /** Speed multiplier (units/s ≈ 520 * speed). */
  speed = 1;
  /** Render once and stop (static backdrops). */
  still = false;

  constructor(
    parent: HTMLElement,
    private theme: MenuBgTheme = DEFAULT_THEME,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'menu-bg-canvas';
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (let i = 0; i < 16; i++) this.ramps.push(this.spawn(this.rand() * FAR));
    for (let i = 0; i < 140; i++) this.stars.push({ x: this.rand(), y: this.rand() * 0.55, r: 0.3 + this.rand() * 1.1, a: 0.15 + this.rand() * 0.6 });
    for (let i = 0; i < 46; i++) this.streaks.push(this.spawnStreak(this.rand() * FAR));
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
      else if (this.running) this.loop();
    });
    this.resize();
  }

  private rand(): number {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  private spawn(zOffset: number): Ramp {
    // long surf ramps floating below the camera, staggered left/right like a surf map seen in flight
    const side = this.rand() < 0.5 ? -1 : 1;
    const w = 320 + this.rand() * 420;
    const h = w * (0.6 + this.rand() * 0.3);
    const peak = -160 - this.rand() * 520;
    return {
      x: side * (200 + this.rand() * 1500),
      y: peak - h,
      z: this.camZ + zOffset,
      len: 1600 + this.rand() * 2800,
      w,
      h,
      skew: (this.rand() - 0.5) * w * 0.2,
      tone: 0.85 + this.rand() * 0.3,
    };
  }

  private spawnStreak(zOffset: number): Streak {
    const a = this.rand() * Math.PI * 2;
    const r = 120 + this.rand() * 1400;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.6 + 100, z: this.camZ + zOffset };
  }

  setTheme(t: MenuBgTheme): void {
    this.theme = t;
    if (!this.running) this.draw();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(this.canvas.clientWidth || window.innerWidth));
    const h = Math.max(1, Math.round(this.canvas.clientHeight || window.innerHeight));
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (!this.running || this.still) this.draw();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    if (this.still || this.reduced) {
      this.draw();
      return;
    }
    this.loop();
  }

  stop(): void {
    this.running = false;
    this.pause();
  }

  private pause(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  private loop = (): void => {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((ts) => {
      this.raf = 0;
      if (!this.running) return;
      const dt = this.last ? Math.min(0.1, (ts - this.last) / 1000) : 0;
      this.last = ts;
      this.step(dt);
      this.draw();
      this.loop();
    });
  };

  /** Advances the simulation (exposed for deterministic screenshots). */
  step(dt: number): void {
    this.time += dt;
    this.camZ += dt * 520 * this.speed;
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      if (r.z + r.len < this.camZ - 50) this.ramps[i] = this.spawn(FAR * (0.75 + this.rand() * 0.25));
    }
    for (let i = 0; i < this.streaks.length; i++) {
      if (this.streaks[i].z < this.camZ + NEAR) this.streaks[i] = this.spawnStreak(FAR * (0.6 + this.rand() * 0.4));
    }
  }

  private draw(): void {
    const { ctx, theme: th } = this;
    const W = this.w;
    const H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const horizonY = H * 0.46;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, th.skyTop);
    sky.addColorStop(0.32, th.skyMid);
    sky.addColorStop(0.46, th.horizon);
    sky.addColorStop(0.62, th.skyMid);
    sky.addColorStop(1, th.skyTop);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    // stars
    for (const s of this.stars) {
      const tw = 0.6 + 0.4 * Math.sin(this.time * 1.3 + s.x * 40);
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = '#cfe4ff';
      ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
    }
    ctx.globalAlpha = 1;
    // horizon glow
    const cx = W * 0.5 + Math.sin(this.time * 0.11) * W * 0.04;
    const glow = ctx.createRadialGradient(cx, horizonY, 0, cx, horizonY, Math.max(W, H) * 0.6);
    glow.addColorStop(0, th.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // camera
    const f = Math.min(W, H * 1.6) * 0.75;
    const camX = Math.sin(this.time * 0.13) * 220;
    const camY = Math.sin(this.time * 0.21) * 50;
    const yaw = Math.sin(this.time * 0.09) * 0.07;
    const roll = Math.sin(this.time * 0.17) * 0.025;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const toCam = (p: P3): P3 => {
      const x = p[0] - camX;
      const y = p[1] - camY;
      const z = p[2] - this.camZ;
      const xr = x * cy - z * sy;
      const zr = x * sy + z * cy;
      return [xr * cr - y * sr, xr * sr + y * cr, zr];
    };
    const proj = (p: P3): [number, number] => [cx + (p[0] / p[2]) * f, horizonY - (p[1] / p[2]) * f];

    // speed streaks
    ctx.lineCap = 'round';
    for (const s of this.streaks) {
      const a = toCam([s.x, s.y, s.z]);
      const b = toCam([s.x, s.y, s.z + 260]);
      if (a[2] < NEAR || b[2] < NEAR) continue;
      const pa = proj(a);
      const pb = proj(b);
      const depth = a[2] / FAR;
      ctx.strokeStyle = `rgba(160, 210, 255, ${(0.22 * (1 - depth)).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.5, 1.6 * (1 - depth));
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
    }

    // ramps, far to near
    const order = this.ramps
      .map((r) => ({ r, d: Math.max(r.z - this.camZ, 0) + r.len * 0.25 }))
      .sort((a, b) => b.d - a.d);
    for (const { r } of order) this.drawRamp(r, toCam, proj, th);

    // bottom mist
    const mist = ctx.createLinearGradient(0, H * 0.6, 0, H);
    mist.addColorStop(0, 'rgba(6, 14, 28, 0)');
    mist.addColorStop(1, 'rgba(4, 8, 16, 0.85)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);
  }

  private drawRamp(r: Ramp, toCam: (p: P3) => P3, proj: (p: P3) => [number, number], th: MenuBgTheme): void {
    const { ctx } = this;
    const z0 = r.z;
    const z1 = r.z + r.len;
    const L0: P3 = [r.x - r.w / 2, r.y, z0];
    const R0: P3 = [r.x + r.w / 2, r.y, z0];
    const A0: P3 = [r.x + r.skew, r.y + r.h, z0];
    const L1: P3 = [L0[0], L0[1], z1];
    const R1: P3 = [R0[0], R0[1], z1];
    const A1: P3 = [A0[0], A0[1], z1];
    // the lit face is the one facing the camera's side
    const leftLit = r.x > 0;
    const faces: { pts: P3[]; lit: boolean; cap?: boolean }[] = [
      { pts: [L0, A0, A1, L1], lit: leftLit },
      { pts: [A0, R0, R1, A1], lit: !leftLit },
    ];
    // the ramp's near end (a triangle) when it is ahead of the camera
    if (z0 > this.camZ + NEAR) faces.push({ pts: [L0, A0, R0], lit: false, cap: true });
    for (const face of faces) {
      const cam = clipNear(face.pts.map(toCam));
      if (cam.length < 3) continue;
      const scr = cam.map(proj);
      // fog by depth range of the face
      let zmin = Infinity;
      let zmax = -Infinity;
      let nearPt = scr[0];
      let farPt = scr[0];
      cam.forEach((p, i) => {
        if (p[2] < zmin) {
          zmin = p[2];
          nearPt = scr[i];
        }
        if (p[2] > zmax) {
          zmax = p[2];
          farPt = scr[i];
        }
      });
      const base = face.cap ? capColor(th) : face.lit ? th.rampLit : th.rampDark;
      const c0 = fogMix(base, th.fog, zmin / FAR, r.tone);
      const c1 = fogMix(base, th.fog, zmax / FAR, r.tone);
      const grad = ctx.createLinearGradient(nearPt[0], nearPt[1], farPt[0], farPt[1]);
      grad.addColorStop(0, c0);
      grad.addColorStop(1, c1);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(scr[0][0], scr[0][1]);
      for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i][0], scr[i][1]);
      ctx.closePath();
      ctx.fill();
    }
    // glowing ridge line
    const ridge = clipNear([toCam(A0), toCam(A1)]);
    if (ridge.length === 2) {
      const a = proj(ridge[0]);
      const b = proj(ridge[1]);
      const fade = 1 - Math.min(1, ridge[0][2] / FAR);
      ctx.strokeStyle = th.edge;
      ctx.globalAlpha = 0.25 + 0.6 * fade;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function capColor(th: MenuBgTheme): [number, number, number] {
  return [Math.round((th.rampLit[0] + th.rampDark[0]) / 2), Math.round((th.rampLit[1] + th.rampDark[1]) / 2), Math.round((th.rampLit[2] + th.rampDark[2]) / 2)];
}

function fogMix(c: [number, number, number], fog: [number, number, number], depth: number, tone: number): string {
  const t = Math.max(0, Math.min(1, depth));
  const k = 1 - Math.pow(1 - t, 1.6);
  const mix = (a: number, b: number) => Math.round(a * tone * (1 - k) + b * k);
  return `rgb(${mix(c[0], fog[0])},${mix(c[1], fog[1])},${mix(c[2], fog[2])})`;
}

/** Clips a polygon (or a 2-point segment) against the camera near plane z >= NEAR. */
export function clipNear(pts: P3[]): P3[] {
  if (pts.length === 2) {
    const [a, b] = pts;
    if (a[2] >= NEAR && b[2] >= NEAR) return pts;
    if (a[2] < NEAR && b[2] < NEAR) return [];
    const t = (NEAR - a[2]) / (b[2] - a[2]);
    const c: P3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR];
    return a[2] < NEAR ? [c, b] : [a, c];
  }
  const out: P3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ina = a[2] >= NEAR;
    const inb = b[2] >= NEAR;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  }
  return out;
}
