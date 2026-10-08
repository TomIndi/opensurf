// The three.js renderer for SURF (RendererApi): Source-coordinate scenes (Z-up), the real map surfaces with
// lightmaps, the 2D skybox, the 3D skybox pass, fog, zones, ghosts and debug geometry.
//
// Frame (all into one MSAA render target with a 32-bit float depth buffer and reversed Z when the device has
// EXT_clip_control - no z-fighting across 32k-unit maps with a 3-unit near plane; logarithmic depth otherwise):
//   1. clear
//   2. 3D skybox (when the map has a sky_camera and r_3dsky): the 2D sky cube, then the skybox area's surfaces
//      scaled about the sky_camera (p' = (p - origin) * scale, seen from the main eye == the engine's sky
//      camera at origin + eye / scale), with the sky_camera fog; then the depth is cleared
//   3. the main view: (2D sky cube when there is no 3D sky), sky faces as depth-only masks, opaque world
//      sorted by shader/material, brush entities, props, decals, then translucent surfaces back to front
//      (meshes by three.js, the planes inside each translucent mesh by translucency.ts), zones, ghosts, debug
//      geometry
//   4. resolve + blit to the canvas (render scale, sRGB output)
//
// At load, auditFaceOrientation (mapscene.ts) probes the collision world on both sides of sampled brush faces;
// if a large share face into solid (a loader emitting faces back to front), BSP surfaces are drawn without
// back-face culling so no wall disappears.
import {
  BufferAttribute,
  BufferGeometry,
  DepthTexture,
  FloatType,
  GLSL3,
  LinearFilter,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import type { Vec3 } from '../core/vec3';
import type { GhostState, LoadProgress, RenderSettings, RendererApi, ViewState } from '../game/api';
import type { FogDef, LoadedMap, ZoneDef } from '../map/types';
import { CONTENTS_SLIME, CONTENTS_WATER } from '../physics/types';
import { EYE_PULLBACK, applySourceView, createSourceCamera, sourceVerticalFov } from './camera';
import { ClipBrushes, DebugBoxes } from './debugdraw';
import { Ghosts } from './ghosts';
import { type FaceOrientationAudit, MapScene } from './mapscene';
import { SkyBox } from './sky';
import { BLIT_FRAGMENT, BLIT_VERTEX } from './shaders';
import { TextureCache } from './textures';
import { FogUniforms, SharedUniforms, SurfaceMaterials, U, createSharedUniforms, srgbToLinearVec } from './worldmaterials';
import { ZoneBeams } from './zones';

export interface RendererOptions {
  /** Pretend these WebGL extensions don't exist (tests of the fallback paths). */
  disableExtensions?: string[];
  /** MSAA samples of the scene target (default 4, clamped to the device; 0 = off). */
  samples?: number;
  /** Keep the drawing buffer (screenshots via toDataURL). */
  preserveDrawingBuffer?: boolean;
  /** Near plane (default 3). */
  near?: number;
  /** Back-face culling of BSP surfaces: 'auto' (default, see auditFaceOrientation), or forced on/off (debugging). */
  doubleSided?: boolean | 'auto';
}

export const DEFAULT_SETTINGS: RenderSettings = {
  fullbright: false,
  drawZones: true,
  drawTriggers: false,
  drawClips: false,
  wireframe: false,
  brightness: 1,
  maxAnisotropy: 8,
  renderScale: 1,
  fogEnabled: true,
  drawSky3D: true,
};

const FAR = 1 << 20;

function yieldFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Wraps a context so some extensions appear missing (for testing fallbacks). */
function hideExtensions(gl: WebGL2RenderingContext, names: string[]): void {
  if (!names.length) return;
  const hidden = new Set(names);
  const getExt = gl.getExtension.bind(gl);
  const getSup = gl.getSupportedExtensions.bind(gl);
  (gl as unknown as { getExtension: (n: string) => unknown }).getExtension = (n: string) => (hidden.has(n) ? null : getExt(n));
  (gl as unknown as { getSupportedExtensions: () => string[] | null }).getSupportedExtensions = () => (getSup() ?? []).filter((n) => !hidden.has(n));
}

export interface RendererDebugInfo {
  depth: 'reversed-float' | 'logarithmic';
  samples: number;
  targetSize: [number, number];
  canvasSize: [number, number];
  programs: number;
  geometries: number;
  textures: number;
  map: string | null;
  scene: MapScene['stats'] | null;
  sky: { procedural: boolean; name: string; sky3d: boolean };
  maxAnisotropy: number;
  s3tc: boolean;
  /** Brush face orientation audit (see auditFaceOrientation) and whether BSP surfaces are drawn double-sided. */
  faces: { audit: FaceOrientationAudit | null; doubleSided: boolean } | null;
}

export class Renderer implements RendererApi {
  readonly three: WebGLRenderer;
  readonly gl: WebGL2RenderingContext;
  readonly depthMode: 'reversed-float' | 'logarithmic';
  readonly camera: PerspectiveCamera;
  readonly settings: RenderSettings = { ...DEFAULT_SETTINGS };

  private readonly shared: SharedUniforms;
  private readonly worldScene = new Scene();
  private readonly skyScene = new Scene();
  private readonly blitScene = new Scene();
  private readonly blitCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blitMaterial: ShaderMaterial;
  private target: WebGLRenderTarget | null = null;
  private readonly samples: number;
  private readonly sky: SkyBox;
  private readonly zones: ZoneBeams;
  private readonly ghosts: Ghosts;
  private readonly debugBoxes: DebugBoxes;
  private readonly clips: ClipBrushes;
  private readonly pixelScale: U<number> = { value: 0.001 };
  private readonly caps: { maxAnisotropy: number; s3tc: boolean; maxTextureSize: number };

  private map: LoadedMap | null = null;
  private mapScene: MapScene | null = null;
  private textures: TextureCache | null = null;
  private materials: SurfaceMaterials | null = null;
  private loadToken = 0;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private contextLost = false;
  private readonly doubleSidedOption: boolean | 'auto';
  private lastStats = { drawCalls: 0, triangles: 0, textures: 0 };
  private sky3dActive = false;
  /** Water surfaces (bounds + fog) for the underwater view, and the one the eye is under (null = not underwater). */
  private waterSurfaces: WaterSurface[] = [];
  private underwater: WaterSurface | null = null;
  private readonly tmpVec = new Vector3();
  private readonly clearColor = new Vector3(0, 0, 0);

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL 2 is not available');
    hideExtensions(gl, opts.disableExtensions ?? []);
    this.gl = gl;
    const exts = new Set(gl.getSupportedExtensions() ?? []);
    const reversed = exts.has('EXT_clip_control');
    this.three = new WebGLRenderer({
      canvas,
      context: gl,
      antialias: false,
      powerPreference: 'high-performance',
      reversedDepthBuffer: reversed,
      logarithmicDepthBuffer: !reversed,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    } as ConstructorParameters<typeof WebGLRenderer>[0]);
    this.depthMode = reversed && this.three.capabilities.reversedDepthBuffer ? 'reversed-float' : 'logarithmic';
    this.three.outputColorSpace = SRGBColorSpace;
    this.three.toneMapping = NoToneMapping;
    this.three.autoClear = false;
    this.three.info.autoReset = false;
    this.three.sortObjects = true;
    this.three.setClearColor(0x000000, 1);

    const maxSamples = (gl.getParameter(gl.MAX_SAMPLES) as number) || 0;
    this.maxRenderbufferSize = (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 8192;
    this.samples = Math.max(0, Math.min(opts.samples ?? 4, maxSamples));
    this.caps = {
      maxAnisotropy: exts.has('EXT_texture_filter_anisotropic') ? Math.max(1, this.three.capabilities.getMaxAnisotropy()) : 1,
      s3tc: exts.has('WEBGL_compressed_texture_s3tc') && exts.has('WEBGL_compressed_texture_s3tc_srgb'),
      maxTextureSize: (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096,
    };

    this.camera = createSourceCamera(opts.near ?? 3, FAR);
    this.doubleSidedOption = opts.doubleSided ?? 'auto';
    this.shared = createSharedUniforms();
    this.sky = new SkyBox(this.shared);
    this.zones = new ZoneBeams(this.shared.uTime, this.pixelScale);
    this.ghosts = new Ghosts(this.shared.uTime);
    this.debugBoxes = new DebugBoxes();
    this.clips = new ClipBrushes();

    for (const s of [this.worldScene, this.skyScene, this.blitScene]) {
      s.matrixWorldAutoUpdate = false;
      s.matrixAutoUpdate = false;
    }
    this.worldScene.add(this.zones.mesh, this.ghosts.root, this.debugBoxes.root, this.clips.root);
    this.worldScene.updateMatrixWorld(true);

    const tri = new BufferGeometry();
    tri.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.blitMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: BLIT_VERTEX,
      fragmentShader: BLIT_FRAGMENT,
      uniforms: { tColor: { value: null } },
      depthTest: false,
      depthWrite: false,
    });
    const blit = new Mesh(tri, this.blitMaterial);
    blit.frustumCulled = false;
    this.blitScene.add(blit);

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.target?.dispose();
      this.target = null;
      this.ensureTarget();
    });

    const w = canvas.clientWidth || canvas.width || 1280;
    const h = canvas.clientHeight || canvas.height || 720;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.resize(w, h, dpr);
    this.arrangeScenes();
    this.applyFog();
  }

  // ------------------------------------------------------------------------------ targets / size

  /** Scene target size (canvas size x render scale, clamped to the device); stored in targetW/targetH. */
  private updateTargetSize(): void {
    const s = Math.max(0.25, Math.min(2, Number.isFinite(this.settings.renderScale) && this.settings.renderScale > 0 ? this.settings.renderScale : 1));
    const max = this.maxRenderbufferSize;
    this.targetW = Math.max(1, Math.min(max, Math.round(this.width * this.pixelRatio * s)));
    this.targetH = Math.max(1, Math.min(max, Math.round(this.height * this.pixelRatio * s)));
  }

  private targetW = 1;
  private targetH = 1;
  private maxRenderbufferSize = 8192;

  private ensureTarget(): void {
    this.updateTargetSize();
    const w = this.targetW;
    const h = this.targetH;
    if (this.target && this.target.width === w && this.target.height === h) return;
    if (this.target) {
      this.target.setSize(w, h);
      return;
    }
    const reversed = this.depthMode === 'reversed-float';
    const t = new WebGLRenderTarget(w, h, {
      samples: this.samples,
      type: UnsignedByteType,
      colorSpace: SRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthTexture: new DepthTexture(w, h, reversed ? FloatType : UnsignedIntType),
    });
    t.resolveDepthBuffer = false;
    t.resolveStencilBuffer = false;
    this.target = t;
    this.blitMaterial.uniforms.tColor.value = t.texture;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
    this.height = Math.max(1, Math.floor(Number.isFinite(height) ? height : 1));
    this.pixelRatio = Math.max(0.25, Math.min(4, Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1));
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(this.width, this.height, false);
    this.ensureTarget();
  }

  // ------------------------------------------------------------------------------ map

  async loadMap(map: LoadedMap, onProgress?: (p: LoadProgress) => void): Promise<void> {
    this.unloadMap();
    const token = ++this.loadToken;
    const report = (message: string, loaded?: number, total?: number) => {
      try {
        onProgress?.({ phase: 'renderer', message, loaded, total });
      } catch {
        // a broken progress callback must not break loading
      }
    };
    const aborted = () => token !== this.loadToken;
    report('Building the scene', 0, 1);
    const textures = new TextureCache(this.caps);
    textures.setAnisotropy(this.settings.maxAnisotropy);
    const materials = new SurfaceMaterials({ textures, shared: this.shared, alphaToCoverage: this.samples > 0 });
    materials.setWireframe(this.settings.wireframe);
    const scene = new MapScene(map, { textures, materials, shared: this.shared, doubleSided: this.doubleSidedOption });
    const cleanup = () => {
      scene.dispose();
      materials.dispose();
      textures.dispose();
    };
    try {
      let last = now();
      await scene.build(async (done, total) => {
        if (now() - last > 24) {
          report('Building the scene', done, total);
          await yieldFrame();
          last = now();
        }
        if (aborted()) throw new LoadAbortedError();
      });
      if (aborted()) throw new LoadAbortedError();
      const audit = scene.faceAudit;
      if (scene.doubleSided && audit && typeof console !== 'undefined') {
        console.warn(
          `[renderer] ${map.name}: ${audit.inverted} of ${audit.inverted + audit.correct} sampled brush faces are wound inside-out ` +
            `(the loader got their facing wrong); drawing BSP surfaces double-sided`,
        );
      }
      this.sky.setMap(map, textures);
      // install
      this.map = map;
      this.mapScene = scene;
      this.textures = textures;
      this.materials = materials;
      this.worldScene.add(scene.world);
      this.skyScene.add(scene.sky3d);
      this.waterSurfaces = waterSurfaces(map);
      this.underwater = null;
      this.arrangeScenes();
      this.applyFog();
      this.clips.reset();
      if (this.settings.drawClips) this.clips.setVisible(true, () => map.collision?.brushes ?? []);
      // upload textures in slices so the loading screen keeps animating
      const list = textures.textures();
      last = now();
      for (let i = 0; i < list.length; i++) {
        if (this.contextLost) break;
        this.three.initTexture(list[i]);
        if (now() - last > 30) {
          report('Uploading textures', i + 1, list.length);
          await yieldFrame();
          last = now();
          if (aborted()) throw new LoadAbortedError();
        }
      }
      report('Compiling shaders', 0, 1);
      if (!this.contextLost) {
        this.ensureTarget();
        this.three.setRenderTarget(this.target);
        try {
          await this.three.compileAsync(this.worldScene, this.camera);
          if (this.mapScene?.hasSky3d) await this.three.compileAsync(this.skyScene, this.camera);
        } finally {
          this.three.setRenderTarget(null);
        }
      }
      if (aborted()) throw new LoadAbortedError();
      report('Ready', 1, 1);
    } catch (e) {
      if (this.mapScene === scene) {
        this.unloadMap();
      } else cleanup();
      if (e instanceof LoadAbortedError) return;
      throw e;
    }
  }

  unloadMap(): void {
    this.loadToken++;
    const s = this.mapScene;
    if (s) {
      this.worldScene.remove(s.world);
      this.skyScene.remove(s.sky3d);
      s.dispose();
    }
    this.materials?.dispose();
    this.textures?.dispose();
    this.shared.skyCube.value = null;
    this.mapScene = null;
    this.materials = null;
    this.textures = null;
    this.map = null;
    this.waterSurfaces = [];
    this.underwater = null;
    this.clips.reset();
    this.clips.setVisible(false, () => []);
    this.arrangeScenes();
    this.applyFog();
  }

  setModelVisible(model: number, visible: boolean): void {
    if (!(model > 0)) return;
    this.mapScene?.setModelVisible(model, visible);
  }

  setModelAlpha(model: number, alpha: number): void {
    if (!(model > 0)) return;
    this.mapScene?.setModelAlpha(model, alpha);
  }

  setModelColor(model: number, rgb: [number, number, number]): void {
    if (!(model > 0)) return;
    this.mapScene?.setModelColor(model, rgb);
  }

  setZones(zones: ZoneDef[], activeGroup: number): void {
    this.zones.set(zones ?? [], Number.isFinite(activeGroup) ? activeGroup : 0);
    this.zones.setEnabled(this.settings.drawZones);
  }

  setGhosts(ghosts: GhostState[]): void {
    this.ghosts.set(ghosts ?? []);
  }

  setDebugBoxes(boxes: { mins: Vec3; maxs: Vec3; color: [number, number, number] }[]): void {
    this.debugBoxes.set(boxes ?? []);
  }

  setSettings(s: Partial<RenderSettings>): void {
    if (!s) return;
    const prev = { ...this.settings };
    for (const k of Object.keys(s) as (keyof RenderSettings)[]) {
      const v = s[k];
      if (v === undefined || v === null) continue;
      if (typeof DEFAULT_SETTINGS[k] === 'boolean') (this.settings as unknown as Record<string, boolean>)[k] = !!v;
      else if (typeof v === 'number' && Number.isFinite(v)) (this.settings as unknown as Record<string, number>)[k] = v;
    }
    const st = this.settings;
    this.shared.uFullbright.value = st.fullbright ? 1 : 0;
    this.shared.uBrightness.value = Math.max(0.05, Math.min(4, st.brightness));
    this.zones.setEnabled(st.drawZones);
    if (st.wireframe !== prev.wireframe) this.materials?.setWireframe(st.wireframe);
    if (st.maxAnisotropy !== prev.maxAnisotropy) this.textures?.setAnisotropy(st.maxAnisotropy);
    if (st.renderScale !== prev.renderScale) this.ensureTarget();
    if (st.drawClips !== prev.drawClips) {
      const map = this.map;
      this.clips.setVisible(st.drawClips && !!map, () => map?.collision?.brushes ?? []);
    }
    if (st.drawSky3D !== prev.drawSky3D || st.wireframe !== prev.wireframe) this.arrangeScenes();
    if (st.fogEnabled !== prev.fogEnabled) this.applyFog();
  }

  /** Puts the sky cube into the pass that draws first and decides whether the 3D skybox pass runs. */
  private arrangeScenes(): void {
    const s = this.mapScene;
    this.sky3dActive = !!s && s.hasSky3d && this.settings.drawSky3D && !this.settings.wireframe;
    const mesh = this.sky.mesh;
    mesh.removeFromParent();
    (this.sky3dActive ? this.skyScene : this.worldScene).add(mesh);
    mesh.visible = !this.settings.wireframe;
    if (s) {
      s.sky3d.visible = this.sky3dActive;
    }
  }

  private setFogUniforms(f: FogUniforms, fog: FogDef | null | undefined, scale: number): void {
    const on = !!fog && fog.enabled && this.settings.fogEnabled && fog.end > 0;
    if (!on || !fog) {
      f.uFog.value.set(0, 1, 0, 0);
      return;
    }
    srgbToLinearVec(fog.color, f.uFogColor.value);
    const start = Number.isFinite(fog.start) ? fog.start : 0;
    const end = Number.isFinite(fog.end) ? Math.max(fog.end, start + 1) : start + 1;
    const dens = Number.isFinite(fog.maxDensity) ? Math.max(0, Math.min(1, fog.maxDensity)) : 1;
    f.uFog.value.set(start, end, dens, 1);
    f.uFogScale.value = scale;
  }

  private applyFog(): void {
    const r = this.map?.render;
    const w = this.underwater;
    if (w) {
      // inside a water volume: everything fades into the water's fog colour within its fog range (like Source's
      // underwater view); the sky is fully fogged
      const fog: FogDef = { enabled: true, color: w.color, start: w.start, end: w.end, maxDensity: 1 };
      const keep = this.settings.fogEnabled;
      this.settings.fogEnabled = true;
      this.setFogUniforms(this.shared.world, fog, 1);
      this.setFogUniforms(this.shared.sky3d, fog, 1); // the 3D skybox is measured in world units here
      this.settings.fogEnabled = keep;
      srgbToLinearVec(w.color, this.tmpVec);
      this.sky.setOverlayFog(this.tmpVec, 1);
    } else {
      this.setFogUniforms(this.shared.world, r?.fog ?? null, 1);
      this.sky.setOverlayFog(null, 0);
      const s3 = r?.sky3d ?? null;
      this.setFogUniforms(this.shared.sky3d, s3?.fog ?? null, s3 && s3.scale > 0 ? 1 / s3.scale : 1 / 16);
    }
    this.sky.setFog(r?.fog ?? null, this.settings.fogEnabled);
  }

  // ------------------------------------------------------------------------------ frame

  render(view: ViewState): void {
    if (this.contextLost || !view) return;
    const t = Number.isFinite(view.time) ? view.time : 0;
    this.shared.uTime.value = t;
    const aspect = this.width / this.height;
    applySourceView(this.camera, view.origin, view.angles, view.fov, aspect, EYE_PULLBACK);
    const vfov = (sourceVerticalFov(view.fov) * Math.PI) / 180;
    this.pixelScale.value = (2 * Math.tan(vfov / 2)) / Math.max(1, this.targetH);
    if (this.mapScene) {
      this.mapScene.update(t);
      this.mapScene.sortTranslucent(this.camera.position);
    }
    this.updateUnderwater(view.origin);
    this.ghosts.update(t, this.tmpVec.copy(this.camera.position), this.pixelScale.value);

    const three = this.three;
    three.info.reset();
    this.ensureTarget();
    three.setRenderTarget(this.target);
    if (this.settings.wireframe) three.setClearColor(0x05070a, 1);
    else three.setClearColor(0x000000, 1);
    three.clear(true, true, false);
    if (this.sky3dActive) {
      three.render(this.skyScene, this.camera);
      three.clearDepth();
    }
    three.render(this.worldScene, this.camera);
    const calls = three.info.render.calls;
    const tris = three.info.render.triangles;
    three.setRenderTarget(null);
    three.render(this.blitScene, this.blitCamera);
    this.lastStats.drawCalls = calls;
    this.lastStats.triangles = tris;
    this.lastStats.textures = three.info.memory.textures;
  }

  /** Switches the fog to the water's when the eye enters a water volume (and back). */
  private updateUnderwater(eye: Vec3): void {
    const map = this.map;
    let w: WaterSurface | null = null;
    if (map && this.waterSurfaces.length && map.collision && typeof map.collision.pointContents === 'function') {
      let c = 0;
      try {
        c = map.collision.pointContents(eye, CONTENTS_WATER | CONTENTS_SLIME);
      } catch {
        c = 0;
      }
      if (c & (CONTENTS_WATER | CONTENTS_SLIME)) w = waterAbove(this.waterSurfaces, eye);
    }
    if (w !== this.underwater) {
      this.underwater = w;
      this.applyFog();
    }
  }

  /** True while the eye is inside a water volume (underwater fog active). */
  get isUnderwater(): boolean {
    return this.underwater !== null;
  }

  stats(): { drawCalls: number; triangles: number; textures: number } {
    return { ...this.lastStats };
  }

  /** Diagnostics for the harness and tests. */
  debugInfo(): RendererDebugInfo {
    const t = this.target;
    return {
      depth: this.depthMode,
      samples: this.samples,
      targetSize: t ? [t.width, t.height] : [0, 0],
      canvasSize: [this.gl.drawingBufferWidth, this.gl.drawingBufferHeight],
      programs: this.three.info.programs?.length ?? 0,
      geometries: this.three.info.memory.geometries,
      textures: this.three.info.memory.textures,
      map: this.map?.name ?? null,
      scene: this.mapScene ? { ...this.mapScene.stats } : null,
      sky: { procedural: this.sky.procedural, name: this.sky.name, sky3d: this.sky3dActive },
      maxAnisotropy: this.caps.maxAnisotropy,
      s3tc: this.caps.s3tc,
      faces: this.mapScene ? { audit: this.mapScene.faceAudit ? { ...this.mapScene.faceAudit } : null, doubleSided: this.mapScene.doubleSided } : null,
    };
  }

  /** The current map scene (tests / harness). */
  get scene(): MapScene | null {
    return this.mapScene;
  }

  /** Releases everything (the canvas can't be reused for another context afterwards). */
  dispose(): void {
    this.unloadMap();
    this.zones.dispose();
    this.ghosts.dispose();
    this.debugBoxes.dispose();
    this.clips.dispose();
    this.sky.dispose();
    this.blitMaterial.dispose();
    this.target?.dispose();
    this.target = null;
    this.three.dispose();
  }
}

interface WaterSurface {
  mins: Vec3;
  maxs: Vec3;
  color: [number, number, number];
  start: number;
  end: number;
}

/** Water surfaces of a map with their underwater fog ($fogcolor, $fogstart/$fogend). */
export function waterSurfaces(map: LoadedMap): WaterSurface[] {
  const out: WaterSurface[] = [];
  const r = map.render;
  if (!r) return out;
  for (const b of r.batches ?? []) {
    const d = b && r.materials.get(b.material);
    if (!d || !d.isWater || !b.mins || !b.maxs) continue;
    const c = d.waterFogColor ?? [d.fallbackColor[0] * 0.5, d.fallbackColor[1] * 0.55, d.fallbackColor[2] * 0.6];
    const range = d.waterFogRange;
    const start = range && Number.isFinite(range[0]) ? Math.max(0, range[0]) : 0;
    let end = range && Number.isFinite(range[1]) ? range[1] : 400;
    if (!(end > start + 1)) end = start + 400;
    out.push({ mins: b.mins, maxs: b.maxs, color: [c[0], c[1], c[2]], start, end });
  }
  return out;
}

/** The water surface above `p` (the eye is in a water volume): the lowest surface over p within its XY bounds. */
export function waterAbove(surfaces: readonly WaterSurface[], p: Vec3): WaterSurface | null {
  let best: WaterSurface | null = null;
  for (const w of surfaces) {
    if (p.x < w.mins.x - 1 || p.x > w.maxs.x + 1 || p.y < w.mins.y - 1 || p.y > w.maxs.y + 1) continue;
    if (w.maxs.z < p.z - 1) continue;
    if (!best || w.mins.z < best.mins.z) best = w;
  }
  return best ?? surfaces[0] ?? null;
}

class LoadAbortedError extends Error {
  constructor() {
    super('renderer load aborted');
  }
}
