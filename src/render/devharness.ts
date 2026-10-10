// Renderer harness (render-harness.html): loads a map straight into the Renderer, no game/UI.
//
// URL parameters:
//   bsp=/__maps/<name>.bsp   load a BSP (served by vite.render-harness.config.ts from $SURF_TEST_MAPS)
//   builtin=<id>             load a built-in map
//   pos=x,y,z  ang=pitch,yaw[,roll]  fov=90   camera (default: first spawn, eye height 64)
//   spawn=N                  use spawn point N
//   time=T                   fixed animation time (deterministic screenshots)
//   fullbright=1 fog=0 sky3d=0 wire=1 scale=0.5 aniso=N brightness=B zones=0 clips=1   settings
//   zonestyle=floor|box      zone beams: floor outline (default) or the full box
//   demo=1                   demo zones + a ghost (with trail) in front of the camera
//   noext=EXT_a,EXT_b        pretend extensions are missing (fallback paths)
//   logdepth=1               without EXT_clip_control: logarithmic instead of standard depth
//   ds=auto|0|1              back-face culling of BSP surfaces (default auto: see auditFaceOrientation)
//   hud=0                    hide the info overlay
//   fly=1                    WASD + mouse (click to lock) fly camera; shift = fast
// window.__renderHarness exposes the renderer and helpers for automated tests.
import type { QAngle } from '../core/angles';
import { angleVectors } from '../core/angles';
import type { Vec3 } from '../core/vec3';
import type { GhostState, LoadProgress, ViewState } from '../game/api';
import type { LoadedMap, ZoneDef } from '../map/types';
import { DoubleSide, Material, Mesh, Raycaster, Triangle, Vector2, Vector3 } from 'three';
import { Renderer } from './renderer';

interface HarnessState {
  ready: boolean;
  error: string | null;
  loadMs: number;
  progress: LoadProgress[];
}

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = params.get(k);
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const flag = (k: string, d: boolean): boolean => {
  const v = params.get(k);
  if (v === null) return d;
  return v !== '0' && v !== 'false';
};
const vec = (k: string): number[] | null => {
  const v = params.get(k);
  if (!v) return null;
  const p = v.split(',').map((x) => parseFloat(x));
  return p.every((x) => Number.isFinite(x)) ? p : null;
};

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
if (!flag('hud', true)) hud.classList.add('hidden');

const state: HarnessState = { ready: false, error: null, loadMs: 0, progress: [] };
const noext = (params.get('noext') ?? '').split(',').filter(Boolean);
const ds = params.get('ds');
const renderer = new Renderer(canvas, {
  disableExtensions: noext,
  logDepth: flag('logdepth', false),
  preserveDrawingBuffer: flag('preserve', false),
  doubleSided: ds === null || ds === 'auto' ? 'auto' : ds !== '0' && ds !== 'false',
});
renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
window.addEventListener('resize', () => renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1));
renderer.setSettings({
  fullbright: flag('fullbright', false),
  fogEnabled: flag('fog', true),
  drawSky3D: flag('sky3d', true),
  wireframe: flag('wire', false),
  renderScale: num('scale', 1),
  maxAnisotropy: num('aniso', 8),
  brightness: num('brightness', 1),
  drawZones: flag('zones', true),
  drawClips: flag('clips', false),
  zoneStyle: params.get('zonestyle') === 'box' ? 'box' : 'floor',
});

const view: ViewState = { origin: { x: 0, y: 0, z: 64 }, angles: { pitch: 0, yaw: 0, roll: 0 }, fov: num('fov', 90), time: 0 };
let map: LoadedMap | null = null;
const fixedTime = params.has('time') ? num('time', 0) : null;
const t0 = performance.now();

function setView(pos: number[] | null, ang: number[] | null): void {
  if (pos) {
    view.origin.x = pos[0];
    view.origin.y = pos[1];
    view.origin.z = pos[2];
  }
  if (ang) {
    view.angles.pitch = ang[0] ?? 0;
    view.angles.yaw = ang[1] ?? 0;
    view.angles.roll = ang[2] ?? 0;
  }
}

function demoContent(): void {
  const f: Vec3 = { x: 0, y: 0, z: 0 };
  angleVectors({ pitch: 0, yaw: view.angles.yaw, roll: 0 }, f);
  const o = view.origin;
  const base = { x: o.x + f.x * 400, y: o.y + f.y * 400, z: o.z - 64 };
  const box = (cx: number, cy: number, z: number, s: number, h: number) => ({
    mins: { x: cx - s, y: cy - s, z },
    maxs: { x: cx + s, y: cy + s, z: z + h },
  });
  const zones: ZoneDef[] = [
    { type: 'start', group: 0, index: 0, ...box(o.x, o.y, o.z - 64, 160, 128) },
    { type: 'end', group: 0, index: 0, ...box(base.x + f.x * 600, base.y + f.y * 600, base.z, 128, 128) },
    { type: 'stage', group: 0, index: 2, ...box(base.x, base.y, base.z, 96, 128) },
    { type: 'checkpoint', group: 0, index: 1, ...box(base.x - f.y * 300, base.y + f.x * 300, base.z, 96, 128) },
    { type: 'start', group: 1, index: 0, ...box(base.x + f.y * 300, base.y - f.x * 300, base.z, 96, 128) },
  ];
  renderer.setZones(zones, 0);
  ghostBase = base;
}

let ghostBase: Vec3 | null = null;
function demoGhost(t: number): void {
  if (!ghostBase) return;
  const g: GhostState = {
    id: 'pb',
    origin: { x: ghostBase.x + Math.cos(t * 1.3) * 160, y: ghostBase.y + Math.sin(t * 1.3) * 160, z: ghostBase.z },
    angles: { pitch: 0, yaw: ((t * 1.3 * 180) / Math.PI + 90) % 360, roll: 0 },
    ducked: Math.sin(t * 0.7) > 0.6,
    color: [0.35, 0.8, 1],
    name: 'PB  0:42.317',
    visible: true,
    trail: true,
  };
  renderer.setGhosts([g]);
}

async function loadMap(): Promise<void> {
  const bsp = params.get('bsp');
  const builtin = params.get('builtin');
  const onProgress = (p: LoadProgress) => {
    state.progress.push(p);
    hud.textContent = `${p.phase}: ${p.message}${p.total ? ` (${p.loaded ?? 0}/${p.total})` : ''}`;
  };
  const start = performance.now();
  if (bsp) {
    const res = await fetch(bsp);
    if (!res.ok) throw new Error(`fetch ${bsp}: ${res.status}`);
    const data = await res.arrayBuffer();
    const { loadBspMap } = await import('../bsp/loadmap');
    map = await loadBspMap(bsp, data, onProgress);
  } else if (builtin) {
    const mod = await import('../map/builtin/index');
    map = mod.buildBuiltinMap(builtin);
  } else if (flag('fixture', false)) {
    const { buildFixtureMap } = await import('./fixtures');
    map = buildFixtureMap({ fog: flag('fixturefog', false), withSky3d: flag('fixturesky3d', true) });
  }
  if (map) await renderer.loadMap(map, onProgress);
  state.loadMs = Math.round(performance.now() - start);
  const spawn = map?.spawns?.[Math.max(0, Math.min((map?.spawns.length ?? 1) - 1, num('spawn', 0)))];
  if (spawn) {
    setView([spawn.origin.x, spawn.origin.y, spawn.origin.z + 64], [spawn.angles.pitch, spawn.angles.yaw, 0]);
  }
  setView(vec('pos'), vec('ang'));
  if (flag('demo', false)) demoContent();
}

// ------------------------------------------------------------------------------ fly camera
const keys = new Set<string>();
if (flag('fly', true)) {
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('click', () => canvas.requestPointerLock?.());
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    view.angles.yaw -= e.movementX * 0.022 * 2.5;
    view.angles.pitch = Math.max(-89, Math.min(89, view.angles.pitch + e.movementY * 0.022 * 2.5));
  });
}

let lastFrame = performance.now();
let fps = 0;
function frame(): void {
  const nowMs = performance.now();
  const dt = Math.min(0.1, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  fps = fps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1;
  if (keys.size) {
    const f: Vec3 = { x: 0, y: 0, z: 0 };
    const r: Vec3 = { x: 0, y: 0, z: 0 };
    angleVectors(view.angles as QAngle, f, r);
    const speed = (keys.has('ShiftLeft') ? 3000 : 900) * dt;
    const k = (c: string) => (keys.has(c) ? 1 : 0);
    const fw = k('KeyW') - k('KeyS');
    const sd = k('KeyD') - k('KeyA');
    const up = k('Space') - k('ControlLeft');
    view.origin.x += (f.x * fw + r.x * sd) * speed;
    view.origin.y += (f.y * fw + r.y * sd) * speed;
    view.origin.z += (f.z * fw + r.z * sd + up) * speed;
  }
  view.time = fixedTime ?? (nowMs - t0) / 1000;
  if (flag('demo', false)) demoGhost(view.time);
  renderer.render(view);
  if (!hud.classList.contains('hidden') && state.ready) {
    const s = renderer.stats();
    const o = view.origin;
    hud.textContent =
      `${map?.name ?? '-'}  ${fps.toFixed(0)} fps  calls ${s.drawCalls}  tris ${s.triangles}  tex ${s.textures}\n` +
      `pos ${o.x.toFixed(0)} ${o.y.toFixed(0)} ${o.z.toFixed(0)}  ang ${view.angles.pitch.toFixed(1)} ${view.angles.yaw.toFixed(1)}  depth ${renderer.depthMode}`;
  }
  requestAnimationFrame(frame);
}

declare global {
  interface Window {
    __renderHarness: {
      state: HarnessState;
      renderer: Renderer;
      view: ViewState;
      map: () => LoadedMap | null;
      setView: (pos: number[] | null, ang: number[] | null, fov?: number) => void;
      renderNow: () => { drawCalls: number; triangles: number; textures: number };
      reload: (times: number) => Promise<{ textures: number; geometries: number; programs: number }>;
      info: () => ReturnType<Renderer['debugInfo']>;
      demo: () => void;
      readPixel: (fx: number, fy: number) => number[];
      cullingDiff: () => number;
      pick: (x: number, y: number) => { lm: number[] | null; name: string; model: unknown; point: number[]; distance: number; transparent: boolean }[];
    };
  }
}

window.__renderHarness = {
  state,
  renderer,
  view,
  map: () => map,
  setView: (pos, ang, fov) => {
    setView(pos, ang);
    if (fov) view.fov = fov;
  },
  renderNow: () => {
    renderer.render(view);
    return renderer.stats();
  },
  reload: async (times: number) => {
    for (let i = 0; i < times; i++) {
      if (!map) break;
      renderer.unloadMap();
      await renderer.loadMap(map);
      renderer.render(view);
    }
    const m = renderer.three.info.memory;
    return { textures: m.textures, geometries: m.geometries, programs: renderer.three.info.programs?.length ?? 0 };
  },
  info: () => renderer.debugInfo(),
  demo: () => demoContent(),
  readPixel: (fx: number, fy: number) => {
    // render, then read the canvas back before the frame is presented
    renderer.render(view);
    const gl = renderer.gl;
    const x = Math.min(gl.drawingBufferWidth - 1, Math.max(0, Math.floor(fx * gl.drawingBufferWidth)));
    const y = Math.min(gl.drawingBufferHeight - 1, Math.max(0, Math.floor((1 - fy) * gl.drawingBufferHeight)));
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px);
  },
  cullingDiff: () => {
    // fraction of pixels that change when back-face culling is switched off for every opaque map surface: ~0
    // when all faces are wound toward the viewer (or the renderer already draws them double-sided). Translucent
    // surfaces are left alone: a glass brush seen from below correctly shows only its downward face (like
    // Source); drawing its upward face from behind too adds a second glass layer, which isn't a lost wall.
    const gl = renderer.gl;
    const grab = (): Uint8Array => {
      renderer.render(view);
      const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const a = grab();
    const meshes = (renderer.scene?.meshes() ?? []).filter((m) => !(m.material as Material).transparent);
    const saved = meshes.map((m) => (m.material as Material).side);
    for (const m of meshes) {
      (m.material as Material).side = DoubleSide;
      (m.material as Material).needsUpdate = true;
    }
    const b = grab();
    meshes.forEach((m, i) => {
      (m.material as Material).side = saved[i];
      (m.material as Material).needsUpdate = true;
    });
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) diff++;
    }
    return diff / (a.length / 4);
  },
  pick: (x: number, y: number) => {
    const rc = new Raycaster();
    renderer.render(view);
    rc.setFromCamera(new Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1), renderer.camera);
    const meshes = renderer.scene?.meshes() ?? [];
    const hits = rc.intersectObjects(meshes, false).filter((x) => x.object.visible);
    return hits.slice(0, 6).map((h) => {
      const m = h.object as Mesh;
      let lm: number[] | null = null;
      const lmuv = m.geometry.getAttribute('lmuv');
      const atlas = map?.render.lightmap;
      if (lmuv && h.face && atlas) {
        // barycentric interpolation of the lightmap uv at the hit, then the nearest atlas texel
        const { a, b, c } = h.face;
        const pa = new Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as never, a);
        const pb = new Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as never, b);
        const pc = new Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as never, c);
        const bary = new Vector3();
        Triangle.getBarycoord(h.point, pa, pb, pc, bary);
        const u = lmuv.getX(a) * bary.x + lmuv.getX(b) * bary.y + lmuv.getX(c) * bary.z;
        const v = lmuv.getY(a) * bary.x + lmuv.getY(b) * bary.y + lmuv.getY(c) * bary.z;
        const tx = Math.min(atlas.width - 1, Math.floor(u * atlas.width));
        const ty = Math.min(atlas.height - 1, Math.floor(v * atlas.height));
        const o = (ty * atlas.width + tx) * 4;
        lm = [u, v, tx, ty, atlas.data[o], atlas.data[o + 1], atlas.data[o + 2]].map((x) => Math.round(x * 1000) / 1000);
      }
      return {
        lm,
        name: m.name,
        model: m.userData.model,
        point: [Math.round(h.point.x), Math.round(h.point.y), Math.round(h.point.z)],
        distance: Math.round(h.distance),
        transparent: (m.material as { transparent?: boolean }).transparent === true,
      };
    });
  },
};

loadMap()
  .then(() => {
    renderer.render(view);
    state.ready = true;
  })
  .catch((e: unknown) => {
    console.error(e);
    state.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    hud.textContent = `error: ${state.error}`;
    state.ready = true;
  });
requestAnimationFrame(frame);
