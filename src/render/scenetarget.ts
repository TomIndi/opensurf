// The scene framebuffer: the 3D view renders here (MSAA colour + depth renderbuffers), is resolved once per frame
// into a single-sample texture, and the blit pass draws that to the canvas (render scale, sRGB).
//
// three.js only gives a WebGLRenderTarget a 32-bit float depth buffer through a DepthTexture, which it then
// allocates (single-sample, never sampled here) next to the multisampled renderbuffer, and it resolves the MSAA
// buffer at the end of every render() call. This target owns its framebuffer instead: a DEPTH_COMPONENT32F
// renderbuffer (reversed Z; DEPTH_COMPONENT24 with the standard or logarithmic fallback), or DEPTH32F_STENCIL8 /
// DEPTH24_STENCIL8 when the renderer asks for a stencil (the sky drawn after the world, see stencil.ts), no depth
// texture, and three.js draws into it through a proxy render target bound with setRenderTargetFramebuffer, which
// never resolves. The renderer resolves once, after the last pass of the frame. Without MSAA the colour attachment
// is the resolve texture itself (no copy).
//
// The stencil is not free: Chrome on Windows (ANGLE's D3D11 backend) backs DEPTH32F_STENCIL8 with
// DXGI_FORMAT_D32_FLOAT_S8X24_UINT, a 64-bit-per-sample format, twice DEPTH_COMPONENT32F's D32_FLOAT (66 instead of
// 33 MB at 1920x1080 with 4x MSAA, and the bandwidth to match where the GPU stores it that way). So it is allocated
// only while the renderer asks for it, and only when it costs no anti-aliasing: a device that multisamples the
// depth-only format but not the depth/stencil one gets the depth-only buffer (and the renderer draws the sky first).
import { LinearFilter, SRGBColorSpace, UnsignedByteType, WebGLRenderTarget, type WebGLRenderer } from 'three';

/**
 * MSAA sample count for a requested count: the largest supported count <= requested, else the smallest supported
 * one above it; 0 (off) when nothing is supported or 0 was asked for.
 */
export function pickSamples(requested: number, supported: readonly number[]): number {
  const want = Number.isFinite(requested) ? Math.floor(requested) : 0;
  if (want <= 1) return 0;
  // (runs every frame: no temporary arrays)
  let best = 0;
  let smallestAbove = 0;
  for (let i = 0; i < supported.length; i++) {
    const s = supported[i];
    if (!Number.isFinite(s) || s <= 1) continue;
    if (s <= want) {
      if (s > best) best = s;
    } else if (smallestAbove === 0 || s < smallestAbove) smallestAbove = s;
  }
  return best || smallestAbove;
}

/** Sample counts a renderbuffer format supports (empty without multisampling). */
export function supportedSamples(gl: WebGL2RenderingContext, format: number): number[] {
  try {
    const r = gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES) as Int32Array | null;
    return r ? Array.from(r) : [];
  } catch {
    return [];
  }
}

/** The parts of WebGLRenderer used here that its type declarations leave out. */
interface ThreeInternals {
  properties: { get(o: object): { __webglFramebuffer?: WebGLFramebuffer; __webglTexture?: WebGLTexture } };
  state: { bindFramebuffer(target: number, fb: WebGLFramebuffer | null): boolean };
  setRenderTargetFramebuffer(target: WebGLRenderTarget, fb: WebGLFramebuffer | undefined): void;
}

export class SceneTarget {
  /** three.js handle on the scene framebuffer (render into it with setRenderTarget(proxy)). */
  readonly proxy: WebGLRenderTarget;
  /** Single-sample colour the blit pass samples. */
  readonly resolveTarget: WebGLRenderTarget;
  width = 1;
  height = 1;
  /** Samples in use (0 = no MSAA). */
  samples = 0;
  /** The depth buffer has a stencil (setup(..., stencil = true) and the device could give it). */
  stencil = false;
  /** Sample counts the colour and the depth-only buffer both support (descending as the driver lists them). */
  readonly supported: number[];
  /** Sample counts of the colour and the depth/stencil buffer. */
  private readonly supportedStencil: number[];
  /** The driver could not build a framebuffer with the depth/stencil format: never ask again. */
  private stencilBroken = false;
  private fbo: WebGLFramebuffer | null = null;
  private colorRb: WebGLRenderbuffer | null = null;
  private depthRb: WebGLRenderbuffer | null = null;
  private readonly depthFormat: number;
  private readonly stencilFormat: number;
  /** invalidateFramebuffer lists for the current attachments (rebuilt by setup: no per-frame allocation). */
  private invalidateMsaa: number[] = [];
  private invalidateDepth: number[] = [];

  constructor(
    private readonly three: WebGLRenderer,
    private readonly gl: WebGL2RenderingContext,
    floatDepth: boolean,
  ) {
    this.depthFormat = floatDepth ? gl.DEPTH_COMPONENT32F : gl.DEPTH_COMPONENT24;
    this.stencilFormat = floatDepth ? gl.DEPTH32F_STENCIL8 : gl.DEPTH24_STENCIL8;
    const color = supportedSamples(gl, gl.SRGB8_ALPHA8);
    const both = (format: number): number[] => {
      const depth = new Set(supportedSamples(gl, format));
      return color.filter((s) => depth.has(s));
    };
    this.supported = both(this.depthFormat);
    this.supportedStencil = both(this.stencilFormat);
    const opts = {
      type: UnsignedByteType,
      colorSpace: SRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      samples: 0,
    } as const;
    this.resolveTarget = new WebGLRenderTarget(1, 1, opts);
    this.proxy = new WebGLRenderTarget(1, 1, opts);
  }

  private get internals(): ThreeInternals {
    return this.three as unknown as ThreeInternals;
  }

  /**
   * Whether setup() would give a stencil for a sample count: only when the depth/stencil format multisamples like
   * the depth-only one (never trade anti-aliasing for the stencil).
   */
  stencilFor(samples: number): boolean {
    return !this.stencilBroken && pickSamples(samples, this.supportedStencil) === pickSamples(samples, this.supported);
  }

  /**
   * (Re)allocates for a size, sample count and depth format (with a stencil when `stencil` and stencilFor());
   * a no-op when nothing changed.
   */
  setup(width: number, height: number, samples: number, stencil = false): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const s = pickSamples(samples, this.supported);
    const st = stencil && this.stencilFor(samples);
    if (this.fbo && w === this.width && h === this.height && s === this.samples && st === this.stencil) return;
    this.release(true);
    this.width = w;
    this.height = h;
    this.samples = s;
    this.stencil = st;
    const gl = this.gl;
    const three = this.three;
    const format = st ? this.stencilFormat : this.depthFormat;
    const attachment = st ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
    this.invalidateMsaa = [gl.COLOR_ATTACHMENT0, attachment];
    this.invalidateDepth = [attachment];
    this.resolveTarget.setSize(w, h);
    this.proxy.setSize(w, h);
    three.initRenderTarget(this.resolveTarget);
    const fbo = gl.createFramebuffer();
    const depth = gl.createRenderbuffer();
    if (!fbo || !depth) return; // context lost
    this.fbo = fbo;
    this.depthRb = depth;
    this.internals.state.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    if (s > 0) {
      const color = gl.createRenderbuffer();
      this.colorRb = color;
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, gl.SRGB8_ALPHA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, format, w, h);
    } else {
      const tex = this.internals.properties.get(this.resolveTarget.texture).__webglTexture ?? null;
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, format, w, h);
    }
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, depth);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE || gl.isContextLost();
    this.internals.state.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete && st) {
      // a driver that lists the depth/stencil format but can't combine it with the colour: no stencil from now on
      console.warn(`[renderer] ${s}x MSAA framebuffer with a stencil incomplete; drawing the sky without it`);
      this.stencilBroken = true;
      this.release(true);
      this.setup(w, h, samples, false);
      return;
    }
    if (!complete && s > 0) {
      // a driver that lists the sample count but can't combine the attachments: no MSAA rather than no image
      console.warn(`[renderer] ${s}x MSAA framebuffer incomplete; anti-aliasing disabled`);
      this.supported.length = 0;
      this.supportedStencil.length = 0;
      this.release(true);
      this.setup(w, h, samples, stencil);
      return;
    }
    this.internals.setRenderTargetFramebuffer(this.proxy, fbo);
  }

  /**
   * Ends the frame's scene passes: resolves the multisampled colour into the resolve texture (without MSAA the
   * scene was drawn into it directly) and marks what is no longer needed as dead until the next clear (tiled GPUs
   * then skip storing it).
   */
  resolve(): void {
    if (!this.fbo) return;
    const gl = this.gl;
    const st = this.internals.state;
    st.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    if (this.samples > 0) {
      const dst = this.internals.properties.get(this.resolveTarget).__webglFramebuffer ?? null;
      st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
      gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, this.invalidateMsaa);
      st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    } else gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, this.invalidateDepth);
    st.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  /** Drops the GL objects (deleted unless the context was lost, when they are gone already). */
  release(deleteObjects: boolean): void {
    const gl = this.gl;
    if (deleteObjects) {
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.colorRb) gl.deleteRenderbuffer(this.colorRb);
      if (this.depthRb) gl.deleteRenderbuffer(this.depthRb);
    }
    this.fbo = null;
    this.colorRb = null;
    this.depthRb = null;
  }

  /** After a context restore: three.js forgot every GL object; build everything again on the next setup(). */
  lost(): void {
    this.release(false);
    this.resolveTarget.dispose();
  }

  dispose(): void {
    this.release(true);
    this.resolveTarget.dispose();
  }
}
