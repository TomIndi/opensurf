// The three.js renderer for SURF (RendererApi): Source-coordinate scenes (Z-up), the real map surfaces with
// lightmaps, the 2D skybox, the 3D skybox pass, fog, zones, ghosts and debug geometry.
//
// Frame (all into the scene framebuffer, scenetarget.ts: MSAA colour (mat_antialias) + a 32-bit float depth
// renderbuffer with reversed Z when the device has EXT_clip_control - no z-fighting across 32k-unit maps with a
// 3-unit near plane; otherwise a standard 24-bit depth buffer like the Source engine's own - Firefox has no
// EXT_clip_control, and the logarithmic alternative (opt-in: RendererOptions.logDepth) writes gl_FragDepth, which
// turns off early depth rejection and shades every hidden fragment):
//   1. clear
//   2. the main view's opaque surfaces: (2D sky cube first, see below), sky faces as depth-only masks, the opaque
//      world sorted by shader/material, brush entities, props, decals
//   3. the sky, when it is expensive, after the opaque world and only where it left the sky showing: the depth
//      buffer then has a stencil (see stencil.ts: cleared to STENCIL_SKY, sky faces keep it, every other opaque
//      surface writes 0, the sky draws only on STENCIL_SKY samples, which early stencil rejection makes cost only
//      what is seen of it). With a 3D skybox (sky_camera + r_3dsky) a sky pass runs between the opaque and the
//      translucent world: the depth of the sky samples is reset to the far plane, the 2D sky cube, then the skybox
//      area's surfaces scaled about the sky_camera (p' = (p - origin) * scale, seen from the main eye == the
//      engine's sky camera at origin + eye / scale) with the sky_camera fog, and finally the sky faces' depth is
//      restored so the translucent world is hidden behind them exactly as before. Without one, the procedural 2D
//      sky (clouds from two 5-octave noise sums per pixel) is the last opaque draw. A cube-map 2D
//      sky is one texture fetch per pixel: drawn first, everywhere, without a stencil, which (a test and write on
//      every opaque sample plus the bigger depth/stencil format, see scenetarget.ts) would cost about as much as
//      it saves. So is the 3D skybox, followed by a depth clear, on a device that can't multisample the
//      depth/stencil format like the depth-only one, or with r_skystencil 0
//   4. translucent surfaces back to front (meshes by three.js, the planes inside each translucent mesh by
//      translucency.ts), zones, ghosts, debug geometry
//   5. one MSAA resolve, then the blit to the canvas (render scale, sRGB output)
//
// At load, auditFaceOrientation (mapscene.ts) probes the collision world on both sides of sampled brush faces;
// if a large share face into solid (a loader emitting faces back to front), BSP surfaces are drawn without
// back-face culling so no wall disappears.
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  GLSL3,
  Matrix4,
  Mesh,
  NoBlending,
  NoToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Vec3 } from '../core/vec3';
import type { QAngle } from '../core/angles';
import type { GhostState, LoadProgress, RenderSettings, RendererApi, RendererCapabilities, ViewState } from '../game/api';
import type { FogDef, LoadedMap, ZoneDef } from '../map/types';
import { CONTENTS_SLIME, CONTENTS_WATER } from '../physics/types';
import { EYE_PULLBACK, applySourceView, createSourceCamera, sourceVerticalFov } from './camera';
import { ClipBrushes, DebugBoxes } from './debugdraw';
import { Ghosts } from './ghosts';
import { type FaceOrientationAudit, MapScene } from './mapscene';
import { SkyBox } from './sky';
import { BLIT_FRAGMENT, BLIT_VERTEX, FAR_QUAD_FRAGMENT, FAR_QUAD_VERTEX, MASK_FRAGMENT, MASK_VERTEX } from './shaders';
import { SceneTarget } from './scenetarget';
import { FAR_QUAD_DEPTH_FUNC, STENCIL_SKY, enableStencilRole, setStencilRole, stencilRole } from './stencil';
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
  /** Without EXT_clip_control, logarithmic depth instead of a standard depth buffer (more precision, much slower). */
  logDepth?: boolean;
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
  zoneStyle: 'floor',
  antialias: 4,
  novis: false,
  skyStencil: true,
};

const FAR = 1 << 20;
/** Sky pass: the depth reset of the sky samples comes first, the depth restore of the sky faces last. */
const ORDER_SKY_RESET = -2_000_000;
/** The 2D sky cube: first in the main view or in the sky pass (after the depth reset)... */
const ORDER_SKY_CUBE = -1000;
/** ...or, a procedural sky without a 3D skybox, the last opaque draw of the main view (on the stencil's sky samples). */
const ORDER_SKY_LAST = 1_000_000;
const ORDER_SKY_RESTORE = 1_000_000_000;

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

/** Scene depth buffer: reversed-Z float (EXT_clip_control), standard 24-bit, or logarithmic (opt-in fallback). */
export type DepthMode = 'reversed-float' | 'standard' | 'logarithmic';

export interface RendererDebugInfo {
  depth: DepthMode;
  /** MSAA samples in use (0 = off), the count asked for (mat_antialias) and what the device supports. */
  samples: number;
  antialias: { requested: number; supported: number[] };
  /** GPU as the browser reports it (WEBGL_debug_renderer_info; '' when hidden). */
  gpu: { vendor: string; renderer: string };
  /** Visibility culling: the eye's cluster (-1: everything drawn) and the meshes it hides; null without vis data. */
  pvs: { cluster: number; culled: number; meshes: number } | null;
  targetSize: [number, number];
  canvasSize: [number, number];
  programs: number;
  geometries: number;
  textures: number;
  map: string | null;
  scene: MapScene['stats'] | null;
  /** sky3d: the 3D skybox is drawn; stencil: the sky is drawn after the opaque world, on its sky samples (stencil.ts). */
  sky: { procedural: boolean; name: string; sky3d: boolean; stencil: boolean };
  maxAnisotropy: number;
  s3tc: boolean;
  /** Brush face orientation audit (see auditFaceOrientation) and whether BSP surfaces are drawn double-sided. */
  faces: { audit: FaceOrientationAudit | null; doubleSided: boolean } | null;
}

export class Renderer implements RendererApi {
  readonly three: WebGLRenderer;
  readonly gl: WebGL2RenderingContext;
  readonly depthMode: DepthMode;
  readonly camera: PerspectiveCamera;
  readonly settings: RenderSettings = { ...DEFAULT_SETTINGS };

  private readonly shared: SharedUniforms;
  private readonly worldScene = new Scene();
  private readonly skyScene = new Scene();
  private readonly blitScene = new Scene();
  private readonly blitCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blitMaterial: ShaderMaterial;
  private readonly sceneTarget: SceneTarget;
  /** MSAA samples asked for (mat_antialias / RendererOptions.samples); sceneTarget.samples is what the device gave. */
  private requestedSamples: number;
  private readonly sky: SkyBox;
  /** 3D skybox maps: runs the sky pass between the opaque and the translucent world (see render()). */
  private readonly skyHook: Mesh;
  /** Sky pass helpers: depth reset of the sky samples, and the restore of the sky faces' depth afterwards. */
  private readonly skyReset: Mesh;
  private readonly skyRestore: Mesh;
  private readonly restoreMaskMaterial: ShaderMaterial;
  /** Copies of the main view's sky masks (sharing their geometry) that restore their depth after the sky pass. */
  private restoreMasks: { src: Mesh; copy: Mesh }[] = [];
  private readonly gpu: { vendor: string; renderer: string };
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
  /** The sky is placed for a scene target with a stencil: drawn after the opaque world, on its sky samples. */
  private skyStencil = false;
  /** The 3D skybox is drawn by the stencil-restricted sky pass after the opaque world (else first, everywhere). */
  private skyAfter = false;
  /** Water surfaces (bounds + fog) for the underwater view, and the one the eye is under (null = not underwater). */
  private waterSurfaces: WaterSurface[] = [];
  private underwater: WaterSurface | null = null;
  private readonly tmpVec = new Vector3();
  private readonly viewProjection = new Matrix4();
  private readonly clearColor = new Vector3(0, 0, 0);
  /** Runtime world fog (SetFogController) replacing the map's own; null = the map's fog. */
  private fogOverride: FogDef | null = null;

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
    const logDepth = !reversed && !!opts.logDepth;
    this.three = new WebGLRenderer({
      canvas,
      context: gl,
      antialias: false,
      powerPreference: 'high-performance',
      reversedDepthBuffer: reversed,
      logarithmicDepthBuffer: logDepth,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    } as ConstructorParameters<typeof WebGLRenderer>[0]);
    this.depthMode = reversed && this.three.capabilities.reversedDepthBuffer ? 'reversed-float' : logDepth ? 'logarithmic' : 'standard';
    this.three.outputColorSpace = SRGBColorSpace;
    this.three.toneMapping = NoToneMapping;
    this.three.autoClear = false;
    this.three.info.autoReset = false;
    this.three.sortObjects = true;
    this.three.setClearColor(0x000000, 1);

    this.maxRenderbufferSize = (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 8192;
    this.requestedSamples = Math.max(0, opts.samples ?? 4);
    this.settings.antialias = this.requestedSamples;
    this.sceneTarget = new SceneTarget(this.three, gl, this.depthMode === 'reversed-float');
    this.gpu = gpuInfo(gl, exts);
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

    const tri = new BufferGeometry();
    tri.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    // sky pass (3D skybox maps): a hook first in the main view's translucent list runs it (no draw of its own)
    const hookGeo = new BufferGeometry();
    hookGeo.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    hookGeo.setDrawRange(0, 0);
    const hookMat = new ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: 'void main() {}' });
    hookMat.transparent = true;
    hookMat.depthTest = false;
    hookMat.depthWrite = false;
    hookMat.colorWrite = false;
    this.skyHook = new Mesh(hookGeo, hookMat);
    this.skyHook.name = 'sky-pass';
    this.skyHook.frustumCulled = false;
    this.skyHook.renderOrder = -1_000_000_000;
    this.skyHook.visible = false;
    this.skyHook.onBeforeRender = () => this.renderSkyPass();
    this.worldScene.add(this.skyHook);
    const farQuad = (transparent: boolean): Mesh => {
      const m = new ShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: FAR_QUAD_VERTEX,
        fragmentShader: FAR_QUAD_FRAGMENT,
        defines: { FAR_Z: this.depthMode === 'reversed-float' ? '0.0' : '1.0' },
        depthTest: true,
        depthWrite: true,
        depthFunc: FAR_QUAD_DEPTH_FUNC,
      });
      m.colorWrite = false;
      m.blending = NoBlending;
      m.transparent = transparent;
      setStencilRole(m, 'skyOnly');
      const q = new Mesh(tri, m);
      q.frustumCulled = false;
      q.matrixAutoUpdate = false;
      return q;
    };
    this.skyReset = farQuad(false);
    this.skyReset.name = 'sky-depth-reset';
    this.skyReset.renderOrder = ORDER_SKY_RESET;
    this.skyRestore = farQuad(true);
    this.skyRestore.name = 'sky-depth-restore';
    this.skyRestore.renderOrder = ORDER_SKY_RESTORE - 1;
    this.skyScene.add(this.skyReset, this.skyRestore);
    // the sky faces again, depth only, on the sky samples (after the 3D skybox's translucent surfaces)
    this.restoreMaskMaterial = new ShaderMaterial({ glslVersion: GLSL3, vertexShader: MASK_VERTEX, fragmentShader: MASK_FRAGMENT, side: DoubleSide });
    this.restoreMaskMaterial.colorWrite = false;
    this.restoreMaskMaterial.depthWrite = true;
    this.restoreMaskMaterial.blending = NoBlending;
    this.restoreMaskMaterial.transparent = true;
    this.restoreMaskMaterial.forceSinglePass = true;
    setStencilRole(this.restoreMaskMaterial, 'skyOnly');
    this.worldScene.updateMatrixWorld(true);
    this.skyScene.updateMatrixWorld(true);
    this.assignStencilRoles();

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
      this.sceneTarget.lost();
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
    const t = this.sceneTarget;
    const before = t.samples;
    t.setup(this.targetW, this.targetH, this.requestedSamples, this.wantsStencil());
    this.blitMaterial.uniforms.tColor.value = t.resolveTarget.texture;
    // alpha to coverage needs a multisampled target
    if ((before > 0) !== (t.samples > 0)) this.materials?.setAlphaToCoverage(t.samples > 0);
    if (t.stencil !== this.skyStencil) this.placeSky();
  }

  /**
   * Whether the sky is worth drawing after the opaque world with a stencil (see the frame description at the top):
   * for the 3D skybox, and for the procedural 2D sky (an expensive shader); a cube-map sky is drawn first.
   */
  private wantsStencil(): boolean {
    if (this.settings.skyStencil === false || this.settings.wireframe) return false;
    return this.sky3dActive || this.sky.procedural;
  }

  /** MSAA samples in use (0 = off). */
  get samples(): number {
    return this.sceneTarget.samples;
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
    const materials = new SurfaceMaterials({
      textures,
      shared: this.shared,
      alphaToCoverage: this.sceneTarget.samples > 0,
      reversedDepth: this.depthMode === 'reversed-float',
    });
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
      this.setupRestoreMasks(scene);
      this.assignStencilRoles();
      this.waterSurfaces = waterSurfaces(map);
      this.underwater = null;
      this.fogOverride = null;
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
        // the target decides the programs' output colour space; a frame rendered while compileAsync waits
        // resets it, so it is set right before each compile
        try {
          this.three.setRenderTarget(this.sceneTarget.proxy);
          await this.three.compileAsync(this.worldScene, this.camera);
          if (this.mapScene?.hasSky3d) {
            this.three.setRenderTarget(this.sceneTarget.proxy);
            await this.three.compileAsync(this.skyScene, this.camera);
          }
        } finally {
          this.three.setRenderTarget(null);
        }
      }
      if (aborted()) throw new LoadAbortedError();
      // geometry to the GPU now, not the first time each mesh comes into view (tens of MB at once on big maps)
      report('Uploading geometry', 0, 1);
      if (!this.contextLost) this.uploadGeometry();
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
    for (const r of this.restoreMasks) r.copy.removeFromParent();
    this.restoreMasks = [];
    this.materials?.dispose();
    this.textures?.dispose();
    this.shared.skyCube.value = null;
    this.mapScene = null;
    this.materials = null;
    this.textures = null;
    this.map = null;
    this.waterSurfaces = [];
    this.underwater = null;
    this.fogOverride = null;
    this.clips.reset();
    this.clips.setVisible(false, () => []);
    this.arrangeScenes();
    this.applyFog();
  }

  /** Map logic switched the player's fog (env_fog_controller via SetFogController); null = the map's own fog. */
  setFog(fog: FogDef | null): void {
    this.fogOverride = fog
      ? { enabled: !!fog.enabled, color: [fog.color[0], fog.color[1], fog.color[2]], start: fog.start, end: fog.end, maxDensity: fog.maxDensity }
      : null;
    this.applyFog();
  }

  /** Device capabilities the loader can prepare data for. */
  capabilities(): RendererCapabilities {
    return { compressedTextures: this.caps.s3tc, maxTextureSize: this.caps.maxTextureSize };
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

  setModelTransform(model: number, origin: Vec3, angles: QAngle): void {
    if (!(model > 0)) return;
    this.mapScene?.setModelTransform(model, origin, angles);
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
      if (k === 'zoneStyle') {
        if (v === 'floor' || v === 'box') this.settings.zoneStyle = v;
      } else if (typeof DEFAULT_SETTINGS[k] === 'boolean') (this.settings as unknown as Record<string, boolean>)[k] = !!v;
      else if (typeof v === 'number' && Number.isFinite(v)) (this.settings as unknown as Record<string, number>)[k] = v;
    }
    const st = this.settings;
    this.shared.uFullbright.value = st.fullbright ? 1 : 0;
    this.shared.uBrightness.value = Math.max(0.05, Math.min(4, st.brightness));
    this.zones.setStyle(st.zoneStyle);
    this.zones.setEnabled(st.drawZones);
    if (st.wireframe !== prev.wireframe) this.materials?.setWireframe(st.wireframe);
    if (st.maxAnisotropy !== prev.maxAnisotropy) this.textures?.setAnisotropy(st.maxAnisotropy);
    if (st.antialias !== prev.antialias && st.antialias !== undefined) {
      this.requestedSamples = Math.max(0, Math.min(16, Math.floor(st.antialias)));
      st.antialias = this.requestedSamples;
    }
    if (st.renderScale !== prev.renderScale || st.antialias !== prev.antialias) this.ensureTarget();
    if (st.drawClips !== prev.drawClips) {
      const map = this.map;
      this.clips.setVisible(st.drawClips && !!map, () => map?.collision?.brushes ?? []);
    }
    if (st.drawSky3D !== prev.drawSky3D || st.wireframe !== prev.wireframe || st.skyStencil !== prev.skyStencil) this.arrangeScenes();
    if (st.fogEnabled !== prev.fogEnabled) this.applyFog();
  }

  /** Decides whether the 3D skybox is drawn, sets the scene target up for the sky path and places the sky. */
  private arrangeScenes(): void {
    const s = this.mapScene;
    this.sky3dActive = !!s && s.hasSky3d && this.settings.drawSky3D && !this.settings.wireframe;
    this.sky.mesh.visible = !this.settings.wireframe;
    if (s) {
      s.sky3d.visible = this.sky3dActive;
    }
    this.ensureTarget();
    this.placeSky();
  }

  /**
   * Places the 2D sky cube for the current sky path (see the frame description at the top): with a 3D skybox the
   * first draw of the sky pass (after the opaque world, on the stencil's sky samples) or, without a stencil, of
   * the 3D skybox drawn before the main view; without one the last opaque draw of the main view (on the stencil's
   * sky samples) or, without a stencil, the first. Turns the materials' stencil tests on only while the target
   * has a stencil.
   */
  private placeSky(): void {
    const stencil = this.sceneTarget.stencil;
    this.skyStencil = stencil;
    this.skyAfter = this.sky3dActive && stencil;
    const mesh = this.sky.mesh;
    mesh.removeFromParent();
    (this.sky3dActive ? this.skyScene : this.worldScene).add(mesh);
    mesh.renderOrder = !this.sky3dActive && stencil ? ORDER_SKY_LAST : ORDER_SKY_CUBE;
    this.skyHook.visible = this.skyAfter;
    this.skyReset.visible = this.skyAfter;
    this.skyRestore.visible = this.skyAfter;
    if (!this.skyAfter) for (const r of this.restoreMasks) r.copy.visible = false;
    for (const root of [this.worldScene, this.skyScene]) {
      root.traverse((o) => {
        const mat = (o as Mesh).material;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) enableStencilRole(m, stencil);
      });
    }
  }

  /**
   * Stencil roles of everything drawn in the main view (see stencil.ts): surfaces that don't have one (overlays)
   * become occluders, so no opaque draw can be painted over by the sky. Map materials get theirs when created.
   */
  private assignStencilRoles(): void {
    this.worldScene.traverse((o) => {
      const mat = (o as Mesh).material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) if (!stencilRole(m)) setStencilRole(m, 'occluder');
    });
  }

  /** Copies of the main view's sky masks for the depth restore at the end of the sky pass. */
  private setupRestoreMasks(scene: MapScene): void {
    for (const r of this.restoreMasks) r.copy.removeFromParent();
    this.restoreMasks = [];
    for (const src of scene.world.children) {
      const m = src as Mesh;
      if (!m.isMesh || stencilRole(m.material as ShaderMaterial) !== 'skyMask') continue;
      const copy = new Mesh(m.geometry, this.restoreMaskMaterial);
      copy.name = 'sky-mask-restore';
      copy.matrixAutoUpdate = false;
      copy.renderOrder = ORDER_SKY_RESTORE;
      this.skyScene.add(copy);
      this.restoreMasks.push({ src: m, copy });
    }
  }

  /**
   * The sky pass (3D skybox maps), run by skyHook right after the main view's opaque surfaces: on the samples
   * still marked STENCIL_SKY, reset the depth to the far plane, draw the 2D sky cube and the 3D skybox (its own
   * opaque and translucent surfaces), then restore the depth of the sky faces so the main view's translucent
   * surfaces behind them stay hidden. three.js supports render() from onBeforeRender (its render state and list
   * are stacked); the proxy target never resolves, so this costs no extra MSAA resolve.
   */
  private renderSkyPass(): void {
    if (!this.skyAfter) return;
    for (const r of this.restoreMasks) {
      const src = r.src;
      r.copy.visible = src.visible && (src.material as ShaderMaterial).visible;
      r.copy.layers.mask = src.layers.mask; // culled by the visibility sets with it
      r.copy.matrixWorld.copy(src.matrixWorld);
    }
    this.three.render(this.skyScene, this.camera);
  }

  /**
   * Uploads every mesh's buffers and builds its vertex array now (a render with zero-length draw ranges and no
   * frustum culling), instead of on the frame each mesh first comes into view.
   */
  private uploadGeometry(): void {
    const saved: { mesh: Mesh; culled: boolean; visible: boolean; layers: number; count: number }[] = [];
    for (const root of [this.worldScene, this.skyScene]) {
      root.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh || !m.geometry) return;
        saved.push({ mesh: m, culled: m.frustumCulled, visible: m.visible, layers: m.layers.mask, count: m.geometry.drawRange.count });
        m.frustumCulled = false;
        m.geometry.drawRange.count = 0;
      });
    }
    // hidden brush entities and meshes out of the eye's visibility set too
    for (const e of saved) {
      e.mesh.visible = true;
      e.mesh.layers.mask = 0xffffffff;
    }
    const sky3d = this.mapScene?.sky3d;
    const sky3dVisible = sky3d?.visible ?? false;
    if (sky3d) sky3d.visible = true;
    const three = this.three;
    try {
      three.setRenderTarget(this.sceneTarget.proxy);
      three.render(this.worldScene, this.camera);
      three.render(this.skyScene, this.camera);
    } finally {
      three.setRenderTarget(null);
      // shared geometries (merged groups' opaque + faded meshes): restore in reverse
      for (let i = saved.length - 1; i >= 0; i--) {
        const e = saved[i];
        e.mesh.frustumCulled = e.culled;
        e.mesh.visible = e.visible;
        e.mesh.layers.mask = e.layers;
        e.mesh.geometry.drawRange.count = e.count;
      }
      if (sky3d) sky3d.visible = sky3dVisible;
      three.info.reset();
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
      this.setFogUniforms(this.shared.world, this.fogOverride ?? r?.fog ?? null, 1);
      this.sky.setOverlayFog(null, 0);
      const s3 = r?.sky3d ?? null;
      this.setFogUniforms(this.shared.sky3d, s3?.fog ?? null, s3 && s3.scale > 0 ? 1 / s3.scale : 1 / 16);
    }
    this.sky.setFog(this.fogOverride ?? r?.fog ?? null, this.settings.fogEnabled);
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
      this.mapScene.cullVisibility(this.camera.position, !this.settings.novis);
      this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      this.mapScene.sortTranslucent(this.camera.position, this.viewProjection);
    }
    this.updateUnderwater(view.origin);
    this.ghosts.update(t, this.tmpVec.copy(this.camera.position), this.pixelScale.value);

    const three = this.three;
    three.info.reset();
    this.ensureTarget();
    const st = this.sceneTarget;
    three.setRenderTarget(st.proxy);
    if (this.settings.wireframe) three.setClearColor(0x05070a, 1);
    else three.setClearColor(0x000000, 1);
    if (st.stencil) {
      three.state.buffers.stencil.setClear(STENCIL_SKY);
      three.clear(true, true, true);
    } else three.clear(true, true, false);
    if (this.sky3dActive && !this.skyAfter) {
      // no stencil for the sky pass: the 3D skybox first, everywhere, then the main view over it
      three.render(this.skyScene, this.camera);
      three.clearDepth();
    }
    // opaque surfaces (with the 3D skybox, the sky pass runs from skyHook after them), translucent surfaces
    three.render(this.worldScene, this.camera);
    const calls = three.info.render.calls;
    const tris = three.info.render.triangles;
    st.resolve();
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
    const t = this.sceneTarget;
    return {
      depth: this.depthMode,
      samples: t.samples,
      antialias: { requested: this.requestedSamples, supported: t.supported.slice() },
      gpu: { ...this.gpu },
      pvs: this.mapScene?.pvs ? { cluster: this.mapScene.pvs.eyeCluster, culled: this.mapScene.pvs.culled, meshes: this.mapScene.pvs.count } : null,
      targetSize: [t.width, t.height],
      canvasSize: [this.gl.drawingBufferWidth, this.gl.drawingBufferHeight],
      programs: this.three.info.programs?.length ?? 0,
      geometries: this.three.info.memory.geometries,
      textures: this.three.info.memory.textures,
      map: this.map?.name ?? null,
      scene: this.mapScene ? { ...this.mapScene.stats } : null,
      sky: { procedural: this.sky.procedural, name: this.sky.name, sky3d: this.sky3dActive, stencil: this.skyStencil },
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
    (this.skyHook.material as ShaderMaterial).dispose();
    this.skyHook.geometry.dispose();
    (this.skyReset.material as ShaderMaterial).dispose();
    (this.skyRestore.material as ShaderMaterial).dispose();
    this.restoreMaskMaterial.dispose();
    this.sceneTarget.dispose();
    this.three.dispose();
  }
}

/** GPU vendor / renderer strings (unmasked when the browser allows it). */
export function gpuInfo(gl: WebGL2RenderingContext, exts: Set<string>): { vendor: string; renderer: string } {
  try {
    if (exts.has('WEBGL_debug_renderer_info')) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
      if (ext) return { vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? ''), renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') };
    }
    return { vendor: String(gl.getParameter(gl.VENDOR) ?? ''), renderer: String(gl.getParameter(gl.RENDERER) ?? '') };
  } catch {
    return { vendor: '', renderer: '' };
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
