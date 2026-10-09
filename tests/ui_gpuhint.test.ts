import { describe, expect, it } from 'vitest';
import { classifyGpu, gpuAdvice, gpuName } from '../src/ui/gpuhint';

describe('GPU hint (Settings → Video → Graphics)', () => {
  const cases: [string, ReturnType<typeof classifyGpu>, string][] = [
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete', 'NVIDIA GeForce RTX 3060'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'Intel(R) UHD Graphics 620'],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'Intel(R) Iris(R) Xe Graphics'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete', 'Intel(R) Arc(TM) A770 Graphics'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'AMD Radeon(TM) Graphics'],
    ['ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete', 'AMD Radeon RX 6700 XT'],
    ['ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'AMD Radeon 780M Graphics'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'software', 'Vulkan 1.3.0 (SwiftShader Device (Subzero))'],
    ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'software', 'Microsoft Basic Render Driver'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', 'unknown', 'Apple M1'],
    ['Mesa Intel(R) UHD Graphics 630 (CFL GT2)', 'integrated', 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'software', 'llvmpipe (LLVM 15.0.7, 256 bits)'],
    ['', 'unknown', 'Unknown GPU'],
  ];
  it.each(cases)('%s', (renderer, cls, name) => {
    expect(classifyGpu(renderer)).toBe(cls);
    expect(gpuName(renderer)).toBe(name);
  });

  it('advises only where the GPU itself explains low FPS', () => {
    expect(gpuAdvice('software')).toMatch(/graphics acceleration/);
    expect(gpuAdvice('integrated')).toMatch(/High performance/);
    expect(gpuAdvice('discrete')).toBeNull();
    expect(gpuAdvice('unknown')).toBeNull();
  });
});
