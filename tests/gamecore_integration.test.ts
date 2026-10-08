// Integration wiring between the game and the renderer/loaders: S3TC-aware BSP loading and runtime fog.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { registerConvars } from '../src/game/convars';
import type { RendererCapabilities } from '../src/game/api';
import type { BspLoadOptions } from '../src/game/game';
import type { FogDef, LoadedMap } from '../src/map/types';
import { FakeRenderer, makeGame, makeTestMap, resetGlobals } from './gamecore_helpers';

beforeEach(() => {
  registerConvars();
  resetGlobals();
});
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
});

class CapsRenderer extends FakeRenderer {
  fogs: (FogDef | null)[] = [];
  constructor(private readonly caps: RendererCapabilities) {
    super();
  }
  capabilities(): RendererCapabilities {
    return this.caps;
  }
  setFog(fog: FogDef | null): void {
    this.fogs.push(fog);
  }
}

function urlLoaders(map: LoadedMap, seen: (BspLoadOptions | undefined)[]) {
  return {
    fetchUrl: async () => new ArrayBuffer(8),
    extractArchive: async (data: ArrayBuffer) => ({ name: map.name, bsp: data }),
    loadBsp: async (_n: string, _d: ArrayBuffer, _p?: unknown, opts?: BspLoadOptions) => {
      seen.push(opts);
      return map;
    },
  };
}

describe('renderer capabilities -> BSP loading', () => {
  for (const s3tc of [true, false]) {
    it(`passes compressedTextures=${s3tc} when the renderer ${s3tc ? 'has' : 'lacks'} S3TC`, async () => {
      const map = makeTestMap({ name: 'surf_caps' });
      const seen: (BspLoadOptions | undefined)[] = [];
      const t = makeGame(map, urlLoaders(map, seen));
      // swap in a renderer with capabilities (the Game reads it at load time)
      const r = new CapsRenderer({ compressedTextures: s3tc, maxTextureSize: 4096 });
      (t.game as unknown as { renderer: FakeRenderer }).renderer = r;
      await t.game.loadMapUrl('/__maps/surf_caps.bsp');
      expect(t.game.state).toBe('playing');
      expect(seen).toHaveLength(1);
      expect(!!seen[0]?.compressedTextures).toBe(s3tc);
    });
  }

  it('renderers without capabilities() load the default way', async () => {
    const map = makeTestMap({ name: 'surf_nocaps' });
    const seen: (BspLoadOptions | undefined)[] = [];
    const t = makeGame(map, urlLoaders(map, seen));
    await t.game.loadMapUrl('/__maps/surf_nocaps.bsp');
    expect(t.game.state).toBe('playing');
    expect(seen[0]?.compressedTextures ?? false).toBe(false);
  });
});

describe('SetFogController -> renderer fog', () => {
  it('map logic switching the player fog reaches the renderer', async () => {
    const map = makeTestMap({
      name: 'surf_fog',
      entities: `{
"classname" "env_fog_controller"
"targetname" "fog_red"
"fogenable" "1"
"fogcolor" "255 0 0"
"fogstart" "100"
"fogend" "900"
"fogmaxdensity" "0.5"
"origin" "0 0 64"
}`,
    });
    const t = makeGame(map);
    const r = new CapsRenderer({ compressedTextures: false, maxTextureSize: 4096 });
    (t.game as unknown as { renderer: FakeRenderer }).renderer = r;
    await t.game.loadBuiltinMap('test');
    const s = t.game.session!;
    (s.entities as unknown as { fireInput(t: string, i: string, p?: string): void }).fireInput('!player', 'SetFogController', 'fog_red');
    t.game.runTicks(2);
    expect(r.fogs.length).toBeGreaterThan(0);
    const fog = r.fogs[r.fogs.length - 1]!;
    expect(fog.enabled).toBe(true);
    expect(fog.color[0]).toBeCloseTo(1, 5);
    expect(fog.color[1]).toBeCloseTo(0, 5);
    expect(fog.start).toBe(100);
    expect(fog.end).toBe(900);
    expect(fog.maxDensity).toBeCloseTo(0.5, 5);
  });
});
