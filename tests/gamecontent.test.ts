// Linked game content (src/maps/gamecontent.ts) and its use by the map loader. No real game files and no real
// File System Access API: VPKs are written in-test (tests/helpers/vpkwriter.ts), directory handles are fakes.
// Real-map checks read BSPs from $SURF_TEST_MAPS (skipped when unset) and give them a synthetic VPK set holding
// stock materials those maps reference.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadProgress } from '../src/game/api';
import { loadBspMap } from '../src/bsp/loadmap';
import {
  AsyncMaterialFileSource,
  buildMaterials,
  isProceduralImage,
  loadSky,
  mapFileSource,
  MaterialFileSource,
  normalizeMaterialName,
  prefetchMaterialFiles,
} from '../src/bsp/materials';
import { normalizePakPath, PakFile } from '../src/bsp/pakfile';
import { parseBsp } from '../src/bsp/reader';
import {
  GameContentHandleStore,
  GameContentStatus,
  GameDirectoryHandle,
  GameFileHandle,
  gameContentForLoad,
  getGameContent,
  getGameContentStatus,
  linkGameContentFromDirectoryHandle,
  linkGameContentFromFiles,
  onGameContentChange,
  requestGameContentPermission,
  restoreGameContent,
  scanGameFolder,
  setGameContentHandleStore,
  unlinkGameContent,
} from '../src/maps/gamecontent';
import { GameContent, openGameContentFromFiles } from '../src/maps/vpk';
import { buildBoxWorld, Rec } from './fixtures/bsp_synth';
import { buildVpk, solidVtf, text, VpkFileSpec, vpkFileName } from './helpers/vpkwriter';

// ============================================================================ fakes

/** A fake folder tree: directories are objects, files are byte arrays. */
type Tree = { [name: string]: Tree | Uint8Array };

interface FakeFs {
  root: GameDirectoryHandle;
  /** "list:<path>" for every directory listed, "open:<path>" for every getFile(). */
  log: string[];
  permission: { query: PermissionState; request: PermissionState };
}

function fakeFs(name: string, tree: Tree): FakeFs {
  const fs: FakeFs = { root: null as unknown as GameDirectoryHandle, log: [], permission: { query: 'granted', request: 'granted' } };
  const file = (path: string, fname: string, data: Uint8Array): GameFileHandle => ({
    kind: 'file',
    name: fname,
    getFile: async () => {
      fs.log.push(`open:${path}`);
      return new Blob([data as Uint8Array<ArrayBuffer>]);
    },
  });
  const dir = (path: string, dname: string, t: Tree): GameDirectoryHandle => ({
    kind: 'directory',
    name: dname,
    async *values() {
      fs.log.push(`list:${path}`);
      for (const [k, v] of Object.entries(t)) {
        yield v instanceof Uint8Array ? file(`${path}/${k}`, k, v) : dir(`${path}/${k}`, k, v);
      }
    },
    queryPermission: async () => fs.permission.query,
    requestPermission: async () => fs.permission.request,
  });
  fs.root = dir(name, name, tree);
  return fs;
}

function memoryStore(): GameContentHandleStore & { handle: GameDirectoryHandle | null; saves: number; clears: number } {
  const s = {
    handle: null as GameDirectoryHandle | null,
    saves: 0,
    clears: 0,
    load: async () => s.handle,
    save: async (h: GameDirectoryHandle) => {
      s.handle = h;
      s.saves++;
    },
    clear: async () => {
      s.handle = null;
      s.clears++;
    },
  };
  return s;
}

/** VPK set files for a folder: "<base>_dir.vpk" + "<base>_NNN.vpk". */
function vpkFiles(base: string, files: VpkFileSpec[]): Tree {
  const v = buildVpk(files);
  const out: Tree = { [vpkFileName(base, -1)]: v.dir };
  for (const [i, a] of v.archives) out[vpkFileName(base, i)] = a;
  return out;
}

const VMT = (shader: string, params: Record<string, string>) =>
  text(`"${shader}"\n{\n${Object.entries(params).map(([k, v]) => `  "${k}" "${v}"`).join('\n')}\n}\n`);

/** A CS:S-like install: cstrike_pak (CS:S materials) + hl2_textures (VTFs) + hl2_misc (VMTs), plus clutter. */
function cssInstall(): Tree {
  return {
    bin: { 'engine.dll': new Uint8Array(8) },
    platform: { ...vpkFiles('platform_misc', [{ path: 'resource/x.res', data: text('x') }]) },
    cstrike: {
      maps: { 'de_dust2.bsp': new Uint8Array(4) },
      materials: { concrete: { 'loose.vtf': new Uint8Array(4) } },
      ...vpkFiles('cstrike_pak', [
        { path: 'materials/concrete/concretewall011.vmt', data: VMT('LightmappedGeneric', { $basetexture: 'concrete/concretewall011' }) },
        { path: 'materials/concrete/concretewall011.vtf', data: solidVtf(64, 32, [40, 200, 40, 255]), archive: 1 },
        { path: 'materials/custom/pakwall.vmt', data: VMT('LightmappedGeneric', { $basetexture: 'custom/pakwall' }) },
        { path: 'materials/custom/pakwall.vtf', data: solidVtf(8, 8, [0, 0, 255, 255]) },
      ]),
    },
    hl2: {
      ...vpkFiles('hl2_textures', [
        { path: 'materials/concrete/concretefloor028a.vtf', data: solidVtf(32, 32, [90, 90, 90, 255]) },
        { path: 'materials/wood/woodshingles002a.vtf', data: solidVtf(16, 64, [120, 80, 40, 255]), archive: 2 },
        ...['rt', 'lf', 'bk', 'ft', 'up', 'dn'].map((s) => ({ path: `materials/skybox/sky_test${s}.vtf`, data: solidVtf(16, 16, [60, 120, 230, 255]) })),
      ]),
      ...vpkFiles('hl2_misc', [{ path: 'materials/concrete/concretefloor028a.vmt', data: VMT('LightmappedGeneric', { $basetexture: 'concrete/concretefloor028a' }) }]),
      ...vpkFiles('hl2_sound_misc', [{ path: 'sound/x.wav', data: new Uint8Array(4) }]),
    },
  };
}

let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  store = memoryStore();
  setGameContentHandleStore(store);
});
afterEach(() => setGameContentHandleStore(null));

// ============================================================================ folder scan

describe('scanGameFolder', () => {
  it('finds the VPK sets from the game root without listing the rest of the install or opening archives', async () => {
    const fs = fakeFs('Counter-Strike Source', cssInstall());
    const scan = await scanGameFolder(fs.root);
    expect(scan.sets.map((s) => `${s.location}/${s.base}`).sort()).toEqual([
      'Counter-Strike Source/cstrike/cstrike_pak',
      'Counter-Strike Source/hl2/hl2_misc',
      'Counter-Strike Source/hl2/hl2_textures',
    ]);
    expect(fs.log.filter((l) => l.startsWith('list:')).sort()).toEqual([
      'list:Counter-Strike Source',
      'list:Counter-Strike Source/cstrike',
      'list:Counter-Strike Source/hl2',
    ]);
    expect(fs.log.filter((l) => l.startsWith('open:'))).toEqual([]);
  });

  it('accepts steamapps/common (only the CS folders are entered) and a Steam library root', async () => {
    const common: Tree = {
      'Counter-Strike Source': cssInstall(),
      'Portal 2': { portal2: { ...vpkFiles('pak01', [{ path: 'materials/p.vtf', data: new Uint8Array(1) }]) } },
      'dota 2 beta': { game: { dota: {} } },
    };
    const fs = fakeFs('common', common);
    const scan = await scanGameFolder(fs.root);
    expect(scan.sets.map((s) => s.base).sort()).toEqual(['cstrike_pak', 'hl2_misc', 'hl2_textures']);
    expect(fs.log.some((l) => l.includes('Portal 2') || l.includes('dota'))).toBe(false);
    const lib = fakeFs('SteamLibrary', { steamapps: { common, workshop: { content: {} } } });
    expect((await scanGameFolder(lib.root)).sets.length).toBe(3);
    expect(lib.log.some((l) => l.includes('workshop'))).toBe(false);
  });

  it('accepts the "cstrike" folder itself', async () => {
    const fs = fakeFs('cstrike', cssInstall().cstrike as Tree);
    const scan = await scanGameFolder(fs.root);
    expect(scan.sets.map((s) => s.base)).toEqual(['cstrike_pak']);
  });
});

// ============================================================================ link / status

describe('game content link state', () => {
  it('links a folder: status, priority order, lazy archives, remembered handle, listeners', async () => {
    const fs = fakeFs('Counter-Strike Source', cssInstall());
    const seen: GameContentStatus[] = [];
    const off = onGameContentChange((s) => seen.push(s));
    expect(getGameContentStatus()).toEqual({ state: 'none' });
    const st = await linkGameContentFromDirectoryHandle(fs.root);
    expect(st.state).toBe('linked');
    expect(st.label).toBe('Counter-Strike Source');
    expect(st.archives).toEqual(['cstrike/cstrike_pak', 'hl2/hl2_textures', 'hl2/hl2_misc']);
    expect(st.files).toBe(4 + 8 + 1);
    expect(st.source).toBe('folder');
    expect(st.message).toBeUndefined();
    expect(getGameContentStatus()).toEqual(st);
    expect(seen.at(-1)).toEqual(st);
    expect(store.handle).toBe(fs.root);
    // only the _dir files were opened; numbered archives open on first read
    expect(fs.log.filter((l) => l.startsWith('open:')).sort()).toEqual([
      'open:Counter-Strike Source/cstrike/cstrike_pak_dir.vpk',
      'open:Counter-Strike Source/hl2/hl2_misc_dir.vpk',
      'open:Counter-Strike Source/hl2/hl2_textures_dir.vpk',
    ]);
    const gc = getGameContent()!;
    const vtf = await gc.read('materials/wood/woodshingles002a.vtf');
    expect(vtf).not.toBeNull();
    expect(fs.log.filter((l) => l.startsWith('open:') && /_\d{3}\.vpk$/.test(l))).toEqual(['open:Counter-Strike Source/hl2/hl2_textures_002.vpk']);
    // status copies can't mutate the module state
    st.archives!.push('x');
    expect(getGameContentStatus().archives).toHaveLength(3);
    await unlinkGameContent();
    expect(getGameContentStatus()).toStrictEqual({ state: 'none' });
    expect(getGameContent()).toBeNull();
    expect(store.handle).toBeNull();
    expect(seen.at(-1)!.state).toBe('none');
    off();
    await linkGameContentFromDirectoryHandle(fs.root);
    expect(seen.at(-1)!.state).toBe('none'); // unsubscribed
  });

  it('advises picking the game root when only "cstrike" is linked', async () => {
    const st = await linkGameContentFromDirectoryHandle(fakeFs('cstrike', cssInstall().cstrike as Tree).root);
    expect(st.state).toBe('linked');
    expect(st.archives).toEqual(['cstrike/cstrike_pak']);
    expect(st.message).toMatch(/HL2 textures/);
  });

  it('reports folders without game files (and CS2-only folders) as errors and forgets them', async () => {
    await linkGameContentFromDirectoryHandle(fakeFs('Counter-Strike Source', cssInstall()).root);
    expect(store.handle).not.toBeNull();
    const st = await linkGameContentFromDirectoryHandle(fakeFs('Documents', { 'notes.txt': text('hi') }).root);
    expect(st.state).toBe('error');
    expect(st.label).toBe('Documents');
    expect(st.message).toMatch(/No CS:S or CS:GO game files/);
    expect(getGameContent()).toBeNull();
    expect(store.handle).toBeNull();
    const cs2 = fakeFs('Counter-Strike Global Offensive', {
      game: { csgo: vpkFiles('pak01', [{ path: 'materials/x.vmat_c', data: new Uint8Array(4) }]) },
    });
    const st2 = await linkGameContentFromDirectoryHandle(cs2.root);
    expect(st2.state).toBe('error');
    expect(st2.message).toMatch(/Counter-Strike 2/);
  });

  it('restores a remembered folder: granted → linked; prompt → needs-permission → requestGameContentPermission', async () => {
    expect((await restoreGameContent()).state).toBe('none');
    const fs = fakeFs('Counter-Strike Source', cssInstall());
    store.handle = fs.root;
    // granted
    let st = await restoreGameContent();
    expect(st.state).toBe('linked');
    expect(getGameContent()).not.toBeNull();
    // a fresh visit where the browser wants a click first
    setGameContentHandleStore(store);
    fs.permission.query = 'prompt';
    fs.permission.request = 'denied';
    st = await restoreGameContent();
    expect(st).toMatchObject({ state: 'needs-permission', label: 'Counter-Strike Source', source: 'folder' });
    expect(getGameContent()).toBeNull();
    expect(await gameContentForLoad()).toBeNull(); // loads go on with stand-ins
    st = await requestGameContentPermission();
    expect(st.state).toBe('needs-permission');
    expect(st.message).toMatch(/not granted/);
    fs.permission.request = 'granted';
    st = await requestGameContentPermission();
    expect(st.state).toBe('linked');
    expect(st.archives).toHaveLength(3);
    // restoring again keeps the current link
    expect((await restoreGameContent()).state).toBe('linked');
  });

  it('a remembered folder that is gone becomes an error but stays remembered', async () => {
    const gone: GameDirectoryHandle = {
      kind: 'directory',
      name: 'Counter-Strike Source',
      values() {
        throw Object.assign(new Error('A requested file or directory could not be found'), { name: 'NotFoundError' });
      },
      queryPermission: async () => 'granted',
    };
    store.handle = gone;
    const st = await restoreGameContent();
    expect(st.state).toBe('error');
    expect(store.handle).toBe(gone);
  });

  it('links <input webkitdirectory> files (only the known VPKs are used; not remembered)', async () => {
    const t = cssInstall();
    const files: File[] = [];
    const walk = (tree: Tree, path: string) => {
      for (const [k, v] of Object.entries(tree)) {
        if (v instanceof Uint8Array) {
          const f = new File([v as Uint8Array<ArrayBuffer>], k);
          Object.defineProperty(f, 'webkitRelativePath', { value: `${path}/${k}` });
          files.push(f);
        } else walk(v, `${path}/${k}`);
      }
    };
    walk(t, 'Counter-Strike Source');
    store.handle = fakeFs('old', {}).root;
    const st = await linkGameContentFromFiles(files);
    expect(st).toMatchObject({ state: 'linked', label: 'Counter-Strike Source', source: 'files', archives: ['cstrike/cstrike_pak', 'hl2/hl2_textures', 'hl2/hl2_misc'] });
    expect(store.handle).toBeNull();
    expect(await getGameContent()!.read('materials/custom/pakwall.vtf')).not.toBeNull();
    const none = await linkGameContentFromFiles([new File([new Uint8Array(1)], 'readme.txt')]);
    expect(none.state).toBe('error');
  });

  it('a newer link supersedes one still in progress; gameContentForLoad waits for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeFs('Slow', cssInstall());
    const origValues = slow.root.values!.bind(slow.root);
    slow.root.values = async function* () {
      await gate;
      yield* origValues();
    };
    const fast = fakeFs('cstrike', cssInstall().cstrike as Tree);
    const p1 = linkGameContentFromDirectoryHandle(slow.root);
    const p2 = linkGameContentFromDirectoryHandle(fast.root);
    const forLoad = gameContentForLoad();
    const restored = restoreGameContent(); // waits for the link instead of racing it
    expect((await p2).label).toBe('cstrike');
    expect(await restored).toMatchObject({ state: 'linked', label: 'cstrike' });
    release();
    await p1;
    expect(getGameContentStatus().label).toBe('cstrike');
    expect((await forLoad)!.archiveNames).toEqual(['cstrike/cstrike_pak']);
    expect(store.handle).toBe(fast.root);
  });
});

// ============================================================================ loader integration (synthetic map)

/** Box world (tests/fixtures/bsp_synth.ts) with our texdata names, a pakfile and a sky name. */
function boxMap(names: string[], pakFiles: Record<string, Uint8Array>, skyName = 'sky_test'): ArrayBuffer {
  const texdata = new Rec();
  const strings = new Rec();
  const table = new Rec();
  let ofs = 0;
  for (const n of names) {
    texdata.f32(0.3).f32(0.3).f32(0.3).i32(table.length / 4).i32(512).i32(512).i32(512).i32(512);
    table.i32(ofs);
    strings.str(`${n}\0`);
    ofs += n.length + 1;
  }
  const zip = zipSync(Object.fromEntries(Object.entries(pakFiles).map(([k, v]) => [k, [v, { level: 0 }]])) as never);
  return buildBoxWorld({
    entities: `{\n"classname" "worldspawn"\n"skyname" "${skyName}"\n}\n{\n"classname" "info_player_start"\n"origin" "0 0 1"\n}\n`,
    override: { 2: { data: texdata.build() }, 43: { data: strings.build() }, 44: { data: table.build() }, 40: { data: zip } },
  }).buffer;
}

const BOX_NAMES = ['CONCRETE/CONCRETEWALL011', 'CUSTOM/PAKWALL', 'maps/box/concrete/concretefloor028a_0_0_0', 'ramps/rampwall', 'STOCK/MISSING'];
const BOX_PAK: Record<string, Uint8Array> = {
  'materials/custom/pakwall.vmt': VMT('LightmappedGeneric', { $basetexture: 'custom/pakwall' }),
  'materials/custom/pakwall.vtf': solidVtf(16, 16, [255, 0, 0, 255]),
  'materials/maps/box/concrete/concretefloor028a_0_0_0.vmt': text('"patch" { "include" "materials/concrete/concretefloor028a.vmt" "insert" { "$envmap" "maps/box/c0_0_0" } }'),
  'materials/ramps/rampwall.vmt': VMT('LightmappedGeneric', { $basetexture: 'wood/woodshingles002a' }),
};

async function cssContent(): Promise<GameContent> {
  const fs = fakeFs('Counter-Strike Source', cssInstall());
  const scan = await scanGameFolder(fs.root);
  const { openGameContent } = await import('../src/maps/vpk');
  return (await openGameContent(scan.sets, 'Counter-Strike Source'))!;
}

const quiet = { log: () => {} };

describe('loadBspMap with game content (synthetic map)', () => {
  it('resolves stock materials and the sky from game content; pakfile files win; progress is reported', async () => {
    const gameContent = await cssContent();
    const progress: LoadProgress[] = [];
    const map = await loadBspMap('box', boxMap(BOX_NAMES, BOX_PAK), (p) => progress.push(p), { ...quiet, gameContent });
    const M = map.render.materials;
    // only in the VPK (VMT in cstrike_pak, VTF in its archive 1)
    const wall = M.get('concrete/concretewall011')!;
    expect(isProceduralImage(wall.image)).toBe(false);
    expect([wall.image!.width, wall.image!.height]).toEqual([64, 32]);
    expect(Array.from(wall.image!.data.subarray(0, 4))).toEqual([40, 200, 40, 255]);
    // in both: the pakfile's copy is used
    const pakwall = M.get('custom/pakwall')!;
    expect([pakwall.image!.width, Array.from(pakwall.image!.data.subarray(0, 4))]).toEqual([16, [255, 0, 0, 255]]);
    // pak patch → include from hl2_misc → texture from hl2_textures
    const floor = M.get('maps/box/concrete/concretefloor028a_0_0_0')!;
    expect(isProceduralImage(floor.image)).toBe(false);
    expect(floor.image!.width).toBe(32);
    expect(floor.envmap).toBeDefined();
    // pak VMT whose texture is stock
    const ramp = M.get('ramps/rampwall')!;
    expect([ramp.image!.width, ramp.image!.height]).toEqual([16, 64]);
    // nowhere: procedural stand-in
    expect(isProceduralImage(M.get('stock/missing')!.image)).toBe(true);
    // sky faces from hl2_textures
    expect(map.render.sky.faces).not.toBeNull();
    expect(isProceduralImage(map.render.sky.faces!.rt)).toBe(false);
    expect(map.render.sky.faces!.rt.width).toBe(16);
    // "Reading game textures… n/m", ending with n = m
    const reads = progress.filter((p) => p.phase === 'textures' && /^Reading game textures… \d+\/\d+$/.test(p.message));
    expect(reads.length).toBeGreaterThan(0);
    const last = reads.at(-1)!;
    expect(last.loaded).toBe(last.total);
    expect(last.total).toBeGreaterThanOrEqual(10);
  });

  it('without game content nothing changes (stand-ins), with the linked singleton it is used by default', async () => {
    const data = boxMap(BOX_NAMES, BOX_PAK);
    const none = await loadBspMap('box', data.slice(0), undefined, { ...quiet, gameContent: null });
    expect(isProceduralImage(none.render.materials.get('concrete/concretewall011')!.image)).toBe(true);
    expect(isProceduralImage(none.render.materials.get('ramps/rampwall')!.image)).toBe(true);
    expect(none.render.materials.get('custom/pakwall')!.image!.width).toBe(16);
    expect(isProceduralImage(none.render.sky.faces!.rt)).toBe(true);
    // default = nothing linked
    const dflt = await loadBspMap('box', data.slice(0), undefined, quiet);
    expect(isProceduralImage(dflt.render.materials.get('concrete/concretewall011')!.image)).toBe(true);
    // link the folder: loads pick it up without any option
    await linkGameContentFromDirectoryHandle(fakeFs('Counter-Strike Source', cssInstall()).root);
    const linked = await loadBspMap('box', data.slice(0), undefined, quiet);
    expect(linked.render.materials.get('concrete/concretewall011')!.image!.width).toBe(64);
    await unlinkGameContent();
    const after = await loadBspMap('box', data.slice(0), undefined, quiet);
    expect(isProceduralImage(after.render.materials.get('concrete/concretewall011')!.image)).toBe(true);
  });

  it('a failing content source only costs the stand-ins', async () => {
    const broken: AsyncMaterialFileSource = { has: () => true, read: async () => Promise.reject(new Error('disk gone')) };
    const map = await loadBspMap('box', boxMap(BOX_NAMES, BOX_PAK), undefined, { ...quiet, gameContent: broken });
    expect(isProceduralImage(map.render.materials.get('concrete/concretewall011')!.image)).toBe(true);
    expect(map.render.materials.get('custom/pakwall')!.image!.width).toBe(16);
  });
});

// ============================================================================ real maps

const MAPS_DIR = process.env.SURF_TEST_MAPS;
const mapPath = (n: string) => (MAPS_DIR ? join(MAPS_DIR, `${n}.bsp`) : '');
const haveMap = (n: string) => !!MAPS_DIR && existsSync(mapPath(n));
const readMap = (n: string): ArrayBuffer => {
  const b = readFileSync(mapPath(n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** GameContent over in-memory VPK sets: { base: files }. */
async function contentOf(sets: Record<string, VpkFileSpec[]>): Promise<GameContent> {
  const files = new Map<string, Blob>();
  const dirs: Record<string, string> = { cstrike_pak: 'cstrike', hl2_textures: 'hl2', hl2_misc: 'hl2', pak01: 'csgo' };
  for (const [base, list] of Object.entries(sets)) {
    const v = buildVpk(list);
    files.set(`game/${dirs[base]}/${vpkFileName(base, -1)}`, new Blob([v.dir as Uint8Array<ArrayBuffer>]));
    for (const [i, a] of v.archives) files.set(`game/${dirs[base]}/${vpkFileName(base, i)}`, new Blob([a as Uint8Array<ArrayBuffer>]));
  }
  return (await openGameContentFromFiles(files, { label: 'game' }))!;
}

describe('real maps with game content', () => {
  it.skipIf(!haveMap('surf_ing'))('surf_ing: stock textures and a pak patch of a stock material come from the VPKs, the packed sky wins', async () => {
    const sky = ['rt', 'lf', 'bk', 'ft', 'up', 'dn'].map((s) => ({ path: `materials/skybox/lakesky${s}.vtf`, data: solidVtf(32, 32, [100, 150, 220, 255]) }));
    const gameContent = await contentOf({
      cstrike_pak: [
        { path: 'materials/cs_italy/plasterwall01.vmt', data: VMT('LightmappedGeneric', { $basetexture: 'cs_italy/plasterwall01' }) },
        { path: 'materials/cs_italy/plasterwall01.vtf', data: solidVtf(128, 128, [200, 190, 170, 255]) },
      ],
      hl2_misc: [
        { path: 'materials/concrete/concretewall006a.vmt', data: VMT('LightmappedGeneric', { $basetexture: 'concrete/concretewall006a' }) },
        { path: 'materials/wood/woodshingles002a.vmt', data: VMT('LightmappedGeneric', { $basetexture: 'wood/woodshingles002a' }) },
        { path: 'materials/concrete/concretefloor028a.vmt', data: VMT('LightmappedGeneric', { $basetexture: 'concrete/concretefloor028a' }) },
      ],
      hl2_textures: [
        { path: 'materials/concrete/concretewall006a.vtf', data: solidVtf(256, 128, [128, 128, 120, 255]) },
        { path: 'materials/wood/woodshingles002a.vtf', data: solidVtf(64, 64, [110, 80, 50, 255]), archive: 1 },
        { path: 'materials/concrete/concretefloor028a.vtf', data: solidVtf(64, 128, [90, 90, 90, 255]) },
        ...sky,
      ],
    });
    const progress: string[] = [];
    const map = await loadBspMap('surf_ing', readMap('surf_ing'), (p) => progress.push(p.message), { ...quiet, gameContent });
    const M = map.render.materials;
    const size = (n: string) => {
      const m = M.get(n)!;
      expect(m, n).toBeDefined();
      expect(isProceduralImage(m.image), n).toBe(false);
      return [m.image!.width, m.image!.height];
    };
    expect(size('concrete/concretewall006a')).toEqual([256, 128]);
    expect(size('wood/woodshingles002a')).toEqual([64, 64]);
    expect(size('cs_italy/plasterwall01')).toEqual([128, 128]);
    // the map packs this cubemap patch; its include (and texture) are stock
    expect(size('maps/surf_ing/concrete/concretefloor028a_0_-8192_3360')).toEqual([64, 128]);
    // still missing from our VPKs: stand-ins
    expect(isProceduralImage(M.get('de_prodigy/ceiling01')!.image)).toBe(true);
    // surf_ing packs lakesky: the map's 1024px faces win over the VPKs' 32px ones
    expect(map.render.sky.faces!.rt.width).toBe(1024);
    expect(progress.some((m) => /^Reading game textures… \d+\/\d+$/.test(m))).toBe(true);
  });

  it.skipIf(!haveMap('surf_utopia_njv'))('surf_utopia_njv: materials packed in the map win over the VPKs', async () => {
    const gameContent = await contentOf({
      cstrike_pak: [
        { path: 'materials/concrete/concretewall011.vmt', data: VMT('LightmappedGeneric', { $basetexture: 'concrete/concretewall011' }) },
        { path: 'materials/concrete/concretewall011.vtf', data: solidVtf(8, 8, [0, 0, 255, 255]) },
        { path: 'materials/lights/white001.vmt', data: VMT('UnlitGeneric', { $basetexture: 'lights/white001' }) },
        { path: 'materials/lights/white001.vtf', data: solidVtf(16, 16, [255, 255, 250, 255]) },
      ],
    });
    const map = await loadBspMap('surf_utopia_njv', readMap('surf_utopia_njv'), undefined, { ...quiet, gameContent });
    const M = map.render.materials;
    const wall = M.get('concrete/concretewall011')!;
    expect(wall.image!.width).toBe(1024); // the pakfile's texture, not the VPK's 8x8
    const light = M.get('lights/white001')!;
    expect(isProceduralImage(light.image)).toBe(false);
    expect(light.image!.width).toBe(16);
    expect(light.unlit).toBe(true);
    expect(map.render.sky.faces!.rt.width).toBe(512); // packed sky_dustbowl_01
  });

  /**
   * A content source that "has" every stock material and texture (generated on the fly). After the prefetch,
   * buildMaterials/loadSky must never ask for a file the content has but the prefetch didn't fetch.
   */
  for (const name of ['surf_ing', 'surf_beginner', 'surf_kitsune']) {
    it.skipIf(!haveMap(name))(`${name}: the prefetch fetches everything buildMaterials and loadSky read`, async () => {
      const buf = readMap(name);
      const bsp = parseBsp(buf, { validate: false });
      const pak = bsp.pakfile ? new PakFile(bsp.pakfile) : null;
      const skyName = /"skyname"\s+"([^"]*)"/i.exec(bsp.entitiesText)?.[1] ?? '';
      const stock = (p: string) => p.startsWith('materials/') && !p.startsWith('materials/maps/') && (p.endsWith('.vmt') || p.endsWith('.vtf'));
      const reads: string[] = [];
      const content: AsyncMaterialFileSource = {
        has: (p) => stock(normalizePakPath(p)),
        read: async (p) => {
          const k = normalizePakPath(p);
          reads.push(k);
          if (!stock(k)) return null;
          if (k.endsWith('.vtf')) return solidVtf(4, 4, [128, 128, 128, 255]);
          const n = k.slice('materials/'.length, -4);
          return n.startsWith('skybox/')
            ? VMT('Sky', { $basetexture: n })
            : VMT('LightmappedGeneric', { $basetexture: n, $detail: 'detail/noise_detail_01', $envmap: 'env_cubemap', $envmapmask: `${n}_mask` });
        },
      };
      const got = await prefetchMaterialFiles(bsp, pak, content, { skyName });
      expect(new Set(reads).size).toBe(reads.length); // each file read once
      const src = mapFileSource(got);
      const missed = new Set<string>();
      const recording: MaterialFileSource = {
        read: (p) => {
          const d = src.read(p);
          const k = normalizePakPath(p);
          if (!d && stock(k) && !(pak && pak.has(k))) missed.add(k);
          return d;
        },
      };
      const M = buildMaterials(bsp, pak, { extraSources: [recording] });
      const sky = loadSky(skyName, pak, { extraSources: [recording] });
      expect([...missed]).toEqual([]);
      // every non-tool material is now a real texture
      for (const m of M.values()) {
        if (m.isTool || m.isSky || !m.image) continue;
        expect(isProceduralImage(m.image), m.name).toBe(false);
      }
      expect(sky.faces).not.toBeNull();
      // no HDR sky faces fetched when LDR ones exist
      expect([...got.keys()].filter((k) => k.startsWith('materials/skybox/') && k.includes('_hdr') && k.endsWith('.vtf'))).toEqual([]);
      const texdata = new Set(bsp.texdataNames.map(normalizeMaterialName));
      expect(texdata.size).toBeGreaterThan(0);
    });
  }
});
