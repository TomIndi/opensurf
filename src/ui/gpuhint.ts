// Settings → Video → Graphics: which GPU the browser renders with, and advice when that alone explains a low
// frame rate (software rendering, or integrated graphics on a PC that may have a dedicated card: Chrome on
// Windows uses whichever GPU Windows assigns it, ignoring the page's high-performance request).

export type GpuClass = 'software' | 'integrated' | 'discrete' | 'unknown';

const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render driver|software rasterizer|\bwarp\b/i;
const DISCRETE = /nvidia|geforce|quadro|\brtx\b|\bgtx\b|radeon\s*(rx|pro|r[579]\b|hd\s*[5-9]\d{3})|\barc(\(tm\))?\s*(a|b)\d{3}/i;
// Intel's integrated families, AMD APUs ("AMD Radeon(TM) Graphics", "Radeon Vega 8 Graphics", "Radeon 780M")
const INTEGRATED = /intel|radeon\(tm\)\s*(\d{3}m\s*)?graphics|radeon\s*(\(tm\)\s*)?vega\s*\d+\s*graphics|radeon\s*\d{3}m\b|adreno|mali|powervr/i;

/** What kind of GPU a WebGL renderer string names. */
export function classifyGpu(renderer: string): GpuClass {
  const r = renderer ?? '';
  if (!r.trim()) return 'unknown';
  if (SOFTWARE.test(r)) return 'software';
  if (DISCRETE.test(r)) return 'discrete';
  if (/apple/i.test(r)) return 'unknown'; // Apple silicon: one GPU, nothing to switch
  if (INTEGRATED.test(r)) return 'integrated';
  return 'unknown';
}

/**
 * The GPU's name from a WebGL renderer string: ANGLE wraps it ("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060
 * (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)") with the vendor, a PCI id and the backend.
 */
export function gpuName(renderer: string): string {
  let r = (renderer ?? '').trim();
  const m = /^ANGLE \((.*)\)$/.exec(r);
  if (m) {
    const parts = m[1].split(', ');
    r = parts.length >= 2 ? parts[1] : parts[0];
    // Metal: "ANGLE Metal Renderer: Apple M1"
    r = r.replace(/^ANGLE Metal Renderer:\s*/, '');
  }
  return r
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+(Direct3D\d+|OpenGL|Vulkan|Metal).*$/i, '')
    .replace(/\s+vs_\d_\d.*$/i, '')
    .trim() || 'Unknown GPU';
}

/** Advice for a GPU class (null when there is nothing to fix there). */
export function gpuAdvice(cls: GpuClass): string | null {
  if (cls === 'software')
    return 'The browser draws without the graphics card (hardware acceleration is off or unavailable), so expect a low frame rate. Turn on “Use graphics acceleration when available” in the browser’s system settings and restart it.';
  if (cls === 'integrated')
    return 'The browser runs on integrated graphics. If this PC also has a dedicated graphics card (most gaming laptops), give the browser that one: Windows Settings → System → Display → Graphics → the browser → High performance, then restart the browser. Lower Render scale or Anti-aliasing for more FPS.';
  return null;
}
