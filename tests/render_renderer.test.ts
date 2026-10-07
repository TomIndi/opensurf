import { describe, expect, it } from 'vitest';
import { buildFixtureMap } from '../src/render/fixtures';
import { DEFAULT_SETTINGS, Renderer, waterAbove, waterSurfaces } from '../src/render/renderer';

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
    });
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
