import { describe, expect, it } from 'vitest';
import {
  GameContent,
  VpkArchive,
  isKnownVpkBase,
  knownVpkName,
  openGameContent,
  openGameContentFromFiles,
  parseVpkDirectory,
  parseVpkFileName,
} from '../src/maps/vpk';
import { buildVpk, text } from './helpers/vpkwriter';

/** The original fixture: preload + archive-stored, dir-stored, and a file in the root directory. */
function sampleVpk(version: 1 | 2) {
  const { dir, archives } = buildVpk(
    [
      { path: 'materials/concrete/concretewall011.vtf', data: new Uint8Array([1, 2, 3, 4, 5, 6]), preload: 2 },
      { path: 'materials/concrete/concretewall011.vmt', data: text('"LightmappedGeneric" {}'), inDir: true },
      { path: 'readme.txt', data: new Uint8Array([9]), preload: 1 },
    ],
    version,
  );
  return { dirFile: dir, archive: archives.get(0) ?? new Uint8Array(0) };
}

const blob = (b: Uint8Array) => new Blob([b as Uint8Array<ArrayBuffer>]);

describe('vpk', () => {
  for (const version of [1, 2] as const) {
    it(`parses and reads v${version} archives (preload, dir-stored, archive-stored)`, async () => {
      const { dirFile, archive } = sampleVpk(version);
      const parsed = parseVpkDirectory(dirFile);
      expect(parsed.entries.size).toBe(3);
      expect([...parsed.entries.keys()].sort()).toEqual([
        'materials/concrete/concretewall011.vmt',
        'materials/concrete/concretewall011.vtf',
        'readme.txt',
      ]);
      expect(Object.fromEntries(parsed.extensions)).toEqual({ vtf: 1, vmt: 1, txt: 1 });
      const vpk = await VpkArchive.open('test', blob(dirFile), (i) => (i === 0 ? blob(archive) : null));
      expect(Array.from((await vpk.read('MATERIALS\\Concrete/ConcreteWall011.vtf'))!)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new TextDecoder().decode((await vpk.read('materials/concrete/concretewall011.vmt'))!)).toContain('LightmappedGeneric');
      expect(Array.from((await vpk.read('readme.txt'))!)).toEqual([9]);
      expect(await vpk.read('missing.vtf')).toBeNull();
      expect(vpk.countExtension('vtf')).toBe(1);
      expect(vpk.countExtension('.VMT')).toBe(1);
      expect(vpk.hasSource1Materials).toBe(true);
      const gc = new GameContent([vpk], 'test');
      const many = await gc.readMany(['materials/concrete/concretewall011.vtf', 'nope.vtf']);
      expect(many.size).toBe(1);
      expect(gc.fileCount).toBe(3);
      expect(gc.archiveNames).toEqual(['test']);
    });
  }

  it('finds known VPK sets in a picked folder', async () => {
    const { dirFile, archive } = sampleVpk(2);
    const files = new Map<string, Blob>([
      ['Counter-Strike Source/cstrike/cstrike_pak_dir.vpk', blob(dirFile)],
      ['Counter-Strike Source/cstrike/cstrike_pak_000.vpk', blob(archive)],
    ]);
    const gc = await openGameContentFromFiles(files);
    expect(gc).not.toBeNull();
    expect(gc!.has('materials/concrete/concretewall011.vtf')).toBe(true);
    expect(Array.from((await gc!.read('materials/concrete/concretewall011.vtf'))!)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(gc!.archiveNames).toEqual(['cstrike/cstrike_pak']);
  });

  it('parses VPK file names', () => {
    expect(parseVpkFileName('cstrike_pak_dir.vpk')).toEqual({ base: 'cstrike_pak', index: -1 });
    expect(parseVpkFileName('HL2_Textures_012.VPK')).toEqual({ base: 'hl2_textures', index: 12 });
    expect(parseVpkFileName('pak01_000.vpk')).toEqual({ base: 'pak01', index: 0 });
    expect(parseVpkFileName('pak01.vpk')).toBeNull();
    expect(parseVpkFileName('cstrike_pak_dir.vpk.bak')).toBeNull();
    expect(isKnownVpkBase('hl2_misc')).toBe(true);
    expect(isKnownVpkBase('hl2_sound_misc')).toBe(false);
    expect(knownVpkName('pak01')).toBe('csgo/pak01');
  });

  it('reads files spread over several numbered archives; a missing or short archive reads as null', async () => {
    const { dir, archives } = buildVpk([
      { path: 'materials/a.vtf', data: new Uint8Array([1, 1, 1]), archive: 0 },
      { path: 'materials/b.vtf', data: new Uint8Array([2, 2]), archive: 1 },
      { path: 'materials/c.vtf', data: new Uint8Array([3, 3, 3, 3]), archive: 2 },
    ]);
    const files = new Map<number, Blob>([
      [0, blob(archives.get(0)!)],
      [1, blob(archives.get(1)!)],
      [2, blob(archives.get(2)!.slice(0, 2))], // truncated
    ]);
    const vpk = await VpkArchive.open('x', blob(dir), (i) => files.get(i) ?? null);
    expect(Array.from((await vpk.read('materials/a.vtf'))!)).toEqual([1, 1, 1]);
    expect(Array.from((await vpk.read('materials/b.vtf'))!)).toEqual([2, 2]);
    expect(await vpk.read('materials/c.vtf')).toBeNull();
    const vpk2 = await VpkArchive.open('y', blob(dir), (i) => (i === 0 ? blob(archives.get(0)!) : null));
    expect(await vpk2.read('materials/b.vtf')).toBeNull();
  });

  it('GameContent searches archives in order and falls through when an archive file is missing', async () => {
    const one = buildVpk([
      { path: 'materials/shared.vtf', data: new Uint8Array([1]) },
      { path: 'materials/only1.vtf', data: new Uint8Array([11]) },
    ]);
    const two = buildVpk([
      { path: 'materials/shared.vtf', data: new Uint8Array([2]) },
      { path: 'materials/only2.vtf', data: new Uint8Array([22]) },
    ]);
    const a = await VpkArchive.open('a', blob(one.dir), (i) => (i === 0 ? blob(one.archives.get(0)!) : null));
    const b = await VpkArchive.open('b', blob(two.dir), (i) => (i === 0 ? blob(two.archives.get(0)!) : null));
    const gc = new GameContent([a, b], 'ab');
    expect(Array.from((await gc.read('materials/shared.vtf'))!)).toEqual([1]);
    expect(Array.from((await gc.read('materials/only2.vtf'))!)).toEqual([22]);
    // a's archive is gone (deleted mid-session): the shared file comes from b
    const aBroken = await VpkArchive.open('a', blob(one.dir), () => null);
    const gc2 = new GameContent([aBroken, b], 'ab');
    expect(Array.from((await gc2.read('materials/shared.vtf'))!)).toEqual([2]);
    expect(await gc2.read('materials/only1.vtf')).toBeNull();
  });

  it('opens sets in priority order, skips Source 2 (CS2) archives, unknown bases and duplicates', async () => {
    const mk = (files: { path: string; data: Uint8Array }[]) => {
      const v = buildVpk(files);
      return { dirFile: blob(v.dir), getArchive: (i: number) => (v.archives.has(i) ? blob(v.archives.get(i)!) : null) };
    };
    const css = mk([{ path: 'materials/x.vmt', data: text('"LightmappedGeneric" {}') }]);
    const hl2 = mk([{ path: 'materials/y.vtf', data: new Uint8Array([7]) }]);
    const cs2 = mk([{ path: 'materials/z.vmat_c', data: new Uint8Array([1]) }]);
    const other = mk([{ path: 'sound/a.wav', data: new Uint8Array([1]) }]);
    const notes: string[] = [];
    const gc = await openGameContent(
      [
        { base: 'hl2_textures', location: 'g/hl2', ...hl2 },
        { base: 'pak01', location: 'g/game/csgo', ...cs2 },
        { base: 'hl2_sound_misc', location: 'g/hl2', ...other },
        { base: 'cstrike_pak', location: 'g/cstrike', ...css },
        { base: 'cstrike_pak', location: 'h/cstrike', ...css },
      ],
      'g',
      notes,
    );
    expect(gc!.archiveNames).toEqual(['cstrike/cstrike_pak', 'hl2/hl2_textures']);
    expect(gc!.label).toBe('g');
    expect(notes.some((n) => /Counter-Strike 2/.test(n) && n.includes('g/game/csgo/pak01_dir.vpk'))).toBe(true);
    expect(await openGameContent([{ base: 'pak01', location: 'x', ...cs2 }], 'x')).toBeNull();
    // a broken _dir file is reported, not thrown
    const bad: string[] = [];
    expect(await openGameContent([{ base: 'cstrike_pak', location: 'x', dirFile: blob(new Uint8Array(40)), getArchive: () => null }], 'x', bad)).toBeNull();
    expect(bad[0]).toMatch(/not a VPK/);
  });

  it('openGameContentFromFiles never mixes the archives of two installs', async () => {
    const a = buildVpk([{ path: 'materials/a.vtf', data: new Uint8Array([1, 2, 3]) }]);
    const b = buildVpk([{ path: 'materials/b.vtf', data: new Uint8Array([4, 5]) }]);
    const files = new Map<string, Blob>([
      ['common/Counter-Strike Source/cstrike/cstrike_pak_dir.vpk', blob(a.dir)],
      ['common/Counter-Strike Source/cstrike/cstrike_pak_000.vpk', blob(a.archives.get(0)!)],
      ['backup/cstrike/cstrike_pak_000.vpk', blob(b.archives.get(0)!)], // orphan archive of another copy
      ['common/Counter-Strike Source/cstrike/maps/de_dust2.bsp', blob(new Uint8Array(4))],
    ]);
    const gc = await openGameContentFromFiles(files, { label: 'common' });
    expect(gc!.label).toBe('common');
    expect(Array.from((await gc!.read('materials/a.vtf'))!)).toEqual([1, 2, 3]);
    expect(gc!.has('materials/b.vtf')).toBe(false);
    expect(await openGameContentFromFiles(new Map([['x/readme.txt', blob(new Uint8Array(1))]]))).toBeNull();
  });
});
