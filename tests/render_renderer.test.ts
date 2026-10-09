import { describe, expect, it, vi } from 'vitest';
import { buildFixtureMap } from '../src/render/fixtures';
import { DEFAULT_SETTINGS, Renderer, gpuInfo, waterAbove, waterSurfaces } from '../src/render/renderer';
import { SceneTarget, pickSamples } from '../src/render/scenetarget';
import { FAR_QUAD_DEPTH_FUNC, enableStencilRole, setStencilRole, stencilRole } from '../src/render/stencil';
import { GreaterEqualDepth, MeshBasicMaterial, type WebGLRenderer } from 'three';

/** WebGL 2 constants the scene target uses. */
const GL = {
  RENDERBUFFER: 0x8d41,
  SAMPLES: 0x80a9,
  SRGB8_ALPHA8: 0x8c43,
  DEPTH_COMPONENT24: 0x81a6,
  DEPTH_COMPONENT32F: 0x8cac,
  DEPTH24_STENCIL8: 0x88f0,
  DEPTH32F_STENCIL8: 0x8cad,
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  TEXTURE_2D: 0x0de1,
  COLOR_BUFFER_BIT: 0x4000,
  NEAREST: 0x2600,
};

/**
 * A WebGL 2 context that records the scene target's depth renderbuffer allocations: sample counts per format, and
 * framebuffers that are incomplete with some depth formats.
 */
function fakeGl(samples: Record<number, number[]>, incomplete: number[] = []) {
  const depthFormats = [GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT32F, GL.DEPTH24_STENCIL8, GL.DEPTH32F_STENCIL8];
  const allocs: { format: number; samples: number }[] = [];
  const attachments: number[] = [];
  const invalidated: number[][] = [];
  let depth = 0;
  const store = (format: number, s: number) => {
    if (depthFormats.includes(format)) {
      depth = format;
      allocs.push({ format, samples: s });
    }
  };
  const gl = {
    ...GL,
    getInternalformatParameter: (_t: number, format: number) => new Int32Array(samples[format] ?? []),
    createFramebuffer: () => ({}),
    createRenderbuffer: () => ({}),
    deleteFramebuffer: () => {},
    deleteRenderbuffer: () => {},
    bindRenderbuffer: () => {},
    renderbufferStorageMultisample: (_t: number, s: number, format: number) => store(format, s),
    renderbufferStorage: (_t: number, format: number) => store(format, 0),
    framebufferRenderbuffer: (_t: number, attachment: number) => {
      if (attachment !== GL.COLOR_ATTACHMENT0) attachments.push(attachment);
    },
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => (incomplete.includes(depth) ? 0 : GL.FRAMEBUFFER_COMPLETE),
    isContextLost: () => false,
    blitFramebuffer: () => {},
    invalidateFramebuffer: (_t: number, list: number[]) => invalidated.push(list.slice()),
  } as unknown as WebGL2RenderingContext;
  const three = {
    initRenderTarget: () => {},
    properties: { get: () => ({}) },
    state: { bindFramebuffer: () => true },
    setRenderTargetFramebuffer: () => {},
  } as unknown as WebGLRenderer;
  return { gl, three, allocs, attachments, invalidated, last: () => allocs[allocs.length - 1] };
}

describe('renderer helpers', () => {
  it('default settings match the convar defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
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
      antialias: 4,
    });
  });

  it('picks the MSAA sample count the device supports', () => {
    expect(pickSamples(4, [8, 4, 2])).toBe(4);
    expect(pickSamples(8, [8, 4, 2])).toBe(8);
    expect(pickSamples(2, [8, 4, 2])).toBe(2);
    expect(pickSamples(16, [8, 4, 2])).toBe(8); // the most there is
    expect(pickSamples(8, [4])).toBe(4);
    expect(pickSamples(2, [4])).toBe(4); // nothing as low: the smallest one
    expect(pickSamples(3, [8, 4, 2])).toBe(2);
    expect(pickSamples(0, [8, 4])).toBe(0);
    expect(pickSamples(1, [8, 4])).toBe(0);
    expect(pickSamples(4, [])).toBe(0); // no multisampling at all
    expect(pickSamples(NaN, [4])).toBe(0);
  });

  it('stencil roles; the far-plane quad passes the depth test in both depth modes', () => {
    const m = new MeshBasicMaterial();
    expect(stencilRole(m)).toBeUndefined();
    setStencilRole(m, 'skyOnly');
    expect(stencilRole(m)).toBe('skyOnly');
    setStencilRole(m, 'occluder');
    expect(m.stencilRef).toBe(0);
    expect(m.stencilWriteMask).toBe(0xff);
    // GEQUAL toward the far plane; three.js turns it into LEQUAL with a reversed depth buffer (far = 0)
    expect(FAR_QUAD_DEPTH_FUNC).toBe(GreaterEqualDepth);
  });

  it('stencil roles turn on and off with the scene target\'s stencil', () => {
    const m = setStencilRole(new MeshBasicMaterial(), 'skyOnly');
    enableStencilRole(m, false);
    expect(m.stencilWrite).toBe(false);
    expect(stencilRole(m)).toBe('skyOnly');
    enableStencilRole(m, true);
    expect(m.stencilWrite).toBe(true);
    const plain = new MeshBasicMaterial();
    enableStencilRole(plain, true); // no role: left alone
    expect(plain.stencilWrite).toBe(false);
  });

  it('scene target: a depth-only 32-bit float buffer unless a stencil is asked for', () => {
    const f = fakeGl({ [GL.SRGB8_ALPHA8]: [8, 4, 2], [GL.DEPTH_COMPONENT32F]: [8, 4, 2], [GL.DEPTH32F_STENCIL8]: [8, 4, 2] });
    const t = new SceneTarget(f.three, f.gl, true);
    t.setup(640, 360, 4);
    expect(f.last()).toEqual({ format: GL.DEPTH_COMPONENT32F, samples: 4 });
    expect(f.attachments.at(-1)).toBe(GL.DEPTH_ATTACHMENT);
    expect(t.stencil).toBe(false);
    t.resolve();
    expect(f.invalidated.at(-1)).toEqual([GL.COLOR_ATTACHMENT0, GL.DEPTH_ATTACHMENT]);
    // the 3D skybox's sky pass asks for a stencil: DEPTH32F_STENCIL8, same MSAA
    t.setup(640, 360, 4, true);
    expect(f.last()).toEqual({ format: GL.DEPTH32F_STENCIL8, samples: 4 });
    expect(f.attachments.at(-1)).toBe(GL.DEPTH_STENCIL_ATTACHMENT);
    expect(t.stencil).toBe(true);
    t.resolve();
    expect(f.invalidated.at(-1)).toEqual([GL.COLOR_ATTACHMENT0, GL.DEPTH_STENCIL_ATTACHMENT]);
    const n = f.allocs.length;
    t.setup(640, 360, 4, true); // unchanged: no reallocation
    expect(f.allocs.length).toBe(n);
    // and back
    t.setup(640, 360, 4, false);
    expect(f.last()).toEqual({ format: GL.DEPTH_COMPONENT32F, samples: 4 });
    expect(t.stencil).toBe(false);
    // the logarithmic-depth fallback: 24-bit formats
    const g = fakeGl({ [GL.SRGB8_ALPHA8]: [4], [GL.DEPTH_COMPONENT24]: [4], [GL.DEPTH24_STENCIL8]: [4] });
    const u = new SceneTarget(g.three, g.gl, false);
    u.setup(320, 180, 4);
    expect(g.last()).toEqual({ format: GL.DEPTH_COMPONENT24, samples: 4 });
    u.setup(320, 180, 4, true);
    expect(g.last()).toEqual({ format: GL.DEPTH24_STENCIL8, samples: 4 });
  });

  it('scene target: never trades anti-aliasing for the stencil', () => {
    // the depth/stencil format doesn't multisample (or not as much): depth-only, the MSAA asked for
    const f = fakeGl({ [GL.SRGB8_ALPHA8]: [8, 4, 2], [GL.DEPTH_COMPONENT32F]: [8, 4, 2], [GL.DEPTH32F_STENCIL8]: [4] });
    const t = new SceneTarget(f.three, f.gl, true);
    expect(t.supported).toEqual([8, 4, 2]);
    expect(t.stencilFor(4)).toBe(true);
    expect(t.stencilFor(8)).toBe(false);
    expect(t.stencilFor(0)).toBe(true);
    t.setup(640, 360, 8, true);
    expect(f.last()).toEqual({ format: GL.DEPTH_COMPONENT32F, samples: 8 });
    expect(t.stencil).toBe(false);
    t.setup(640, 360, 4, true);
    expect(f.last()).toEqual({ format: GL.DEPTH32F_STENCIL8, samples: 4 });
    expect(t.stencil).toBe(true);
    t.setup(640, 360, 0, true);
    expect(f.last()).toEqual({ format: GL.DEPTH32F_STENCIL8, samples: 0 });
    // none at all
    const g = fakeGl({ [GL.SRGB8_ALPHA8]: [4], [GL.DEPTH_COMPONENT32F]: [4] });
    const u = new SceneTarget(g.three, g.gl, true);
    u.setup(640, 360, 4, true);
    expect(g.last()).toEqual({ format: GL.DEPTH_COMPONENT32F, samples: 4 });
    expect(u.stencil).toBe(false);
    expect(u.samples).toBe(4);
  });

  it('scene target: an incomplete depth/stencil framebuffer falls back to depth-only, keeping MSAA', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const f = fakeGl(
        { [GL.SRGB8_ALPHA8]: [4], [GL.DEPTH_COMPONENT32F]: [4], [GL.DEPTH32F_STENCIL8]: [4] },
        [GL.DEPTH32F_STENCIL8],
      );
      const t = new SceneTarget(f.three, f.gl, true);
      t.setup(640, 360, 4, true);
      expect(f.last()).toEqual({ format: GL.DEPTH_COMPONENT32F, samples: 4 });
      expect(t.stencil).toBe(false);
      expect(t.samples).toBe(4);
      expect(warn).toHaveBeenCalledTimes(1);
      // not retried every frame
      const n = f.allocs.length;
      t.setup(640, 360, 4, true);
      t.setup(640, 360, 0, true);
      t.setup(640, 360, 4, true);
      expect(f.allocs.slice(n).map((a) => a.format)).toEqual([GL.DEPTH_COMPONENT32F, GL.DEPTH_COMPONENT32F]);
      expect(warn).toHaveBeenCalledTimes(1);
      // an incomplete multisampled framebuffer of any kind: no MSAA rather than no image
      const g = fakeGl({ [GL.SRGB8_ALPHA8]: [4], [GL.DEPTH_COMPONENT32F]: [4], [GL.DEPTH32F_STENCIL8]: [4] });
      let msaaBroken = true;
      const check = g.gl.checkFramebufferStatus;
      (g.gl as unknown as { checkFramebufferStatus: (t: number) => number }).checkFramebufferStatus = (x: number) =>
        msaaBroken && g.last().samples > 0 ? 0 : check(x);
      const u = new SceneTarget(g.three, g.gl, true);
      u.setup(640, 360, 4, true);
      // tried with the stencil, then depth-only, then without MSAA: the image is right, the sky drawn first
      expect(g.allocs.map((a) => [a.format, a.samples])).toEqual([
        [GL.DEPTH32F_STENCIL8, 4],
        [GL.DEPTH_COMPONENT32F, 4],
        [GL.DEPTH_COMPONENT32F, 0],
      ]);
      expect(u.samples).toBe(0);
      expect(u.stencil).toBe(false);
      msaaBroken = false;
      const m = g.allocs.length;
      u.setup(640, 360, 4, true); // stable afterwards
      expect(g.allocs.length).toBe(m);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the GPU name (unmasked when allowed)', () => {
    const gl = {
      VENDOR: 1,
      RENDERER: 2,
      getExtension: () => ({ UNMASKED_VENDOR_WEBGL: 10, UNMASKED_RENDERER_WEBGL: 11 }),
      getParameter: (p: number) => ({ 1: 'WebKit', 2: 'WebKit WebGL', 10: 'Google Inc. (NVIDIA)', 11: 'ANGLE (NVIDIA, GeForce)' })[p],
    } as unknown as WebGL2RenderingContext;
    expect(gpuInfo(gl, new Set(['WEBGL_debug_renderer_info']))).toEqual({ vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, GeForce)' });
    expect(gpuInfo(gl, new Set())).toEqual({ vendor: 'WebKit', renderer: 'WebKit WebGL' });
  });

  it('collects water surfaces with their underwater fog', () => {
    const map = buildFixtureMap();
    const ws = waterSurfaces(map);
    expect(ws).toHaveLength(1);
    expect(ws[0].color).toEqual([0.1, 0.25, 0.3]);
    expect(ws[0].start).toBe(0);
    expect(ws[0].end).toBeGreaterThan(ws[0].start);
    const water = map.render.materials.get('fixture/water')!;
    water.waterFogRange = [100, 50]; // inverted range: fixed up
    const w2 = waterSurfaces(map)[0];
    expect(w2.start).toBe(100);
    expect(w2.end).toBeGreaterThan(100);
  });

  it('picks the lowest water surface above the eye within its bounds', () => {
    const s = (z: number, x0: number, x1: number) => ({ mins: { x: x0, y: -10, z }, maxs: { x: x1, y: 10, z }, color: [z, 0, 0] as [number, number, number], start: 0, end: 100 });
    const list = [s(100, 0, 50), s(0, 0, 50), s(-50, 100, 200)];
    expect(waterAbove(list, { x: 10, y: 0, z: -20 })!.mins.z).toBe(0);
    expect(waterAbove(list, { x: 10, y: 0, z: 50 })!.mins.z).toBe(100);
    expect(waterAbove(list, { x: 150, y: 0, z: -100 })!.mins.z).toBe(-50);
    // nothing matches: fall back to the first surface (the eye is in water anyway)
    expect(waterAbove(list, { x: 1000, y: 0, z: 0 })).toBe(list[0]);
    expect(waterAbove([], { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('needs WebGL 2', () => {
    const canvas = { getContext: () => null, addEventListener: () => {} } as unknown as HTMLCanvasElement;
    expect(() => new Renderer(canvas)).toThrow(/WebGL 2/);
  });
});
