import { describe, expect, it } from 'vitest';
import { GameContent, openGameContentFromFiles, parseVpkDirectory, VpkArchive } from '../src/maps/vpk';

/** Builds a small VPK: returns the _dir file and archive 000. */
function buildVpk(version: 1 | 2) {
  const files = [
    { ext: 'vtf', dir: 'materials/concrete', name: 'concretewall011', data: new Uint8Array([1, 2, 3, 4, 5, 6]), preload: 2, inDir: false },
    { ext: 'vmt', dir: 'materials/concrete', name: 'concretewall011', data: new TextEncoder().encode('"LightmappedGeneric" {}'), preload: 0, inDir: true },
    { ext: 'txt', dir: ' ', name: 'readme', data: new Uint8Array([9]), preload: 1, inDir: false },
  ];
  const archive: number[] = [];
  const dirData: number[] = [];
  const tree: number[] = [];
  const str = (s: string) => {
    for (const c of s) tree.push(c.charCodeAt(0));
    tree.push(0);
  };
  const u16 = (v: number) => tree.push(v & 255, (v >> 8) & 255);
  const u32 = (v: number) => tree.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const byExt = new Map<string, Map<string, typeof files>>();
  for (const f of files) {
    if (!byExt.has(f.ext)) byExt.set(f.ext, new Map());
    const m = byExt.get(f.ext)!;
    if (!m.has(f.dir)) m.set(f.dir, []);
    m.get(f.dir)!.push(f);
  }
  for (const [ext, dirs] of byExt) {
    str(ext);
    for (const [dir, list] of dirs) {
      str(dir);
      for (const f of list) {
        str(f.name);
        u32(0);
        u16(f.preload);
        const rest = f.data.slice(f.preload);
        if (f.inDir) {
          u16(0x7fff);
          u32(dirData.length);
          dirData.push(...rest);
        } else {
          u16(0);
          u32(archive.length);
          archive.push(...rest);
        }
        u32(rest.length);
        u16(0xffff);
        for (const b of f.data.slice(0, f.preload)) tree.push(b);
      }
      str('');
    }
    str('');
  }
  str('');
  const headerSize = version === 1 ? 12 : 28;
  const header = new Uint8Array(headerSize);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, 0x55aa1234, true);
  dv.setUint32(4, version, true);
  dv.setUint32(8, tree.length, true);
  if (version === 2) dv.setUint32(12, dirData.length, true);
  const dirFile = new Uint8Array(headerSize + tree.length + dirData.length);
  dirFile.set(header, 0);
  dirFile.set(tree, headerSize);
  dirFile.set(dirData, headerSize + tree.length);
  return { dirFile, archive: new Uint8Array(archive) };
}

describe('vpk', () => {
  for (const version of [1, 2] as const) {
    it(`parses and reads v${version} archives (preload, dir-stored, archive-stored)`, async () => {
      const { dirFile, archive } = buildVpk(version);
      const parsed = parseVpkDirectory(dirFile);
      expect(parsed.entries.size).toBe(3);
      expect([...parsed.entries.keys()].sort()).toEqual([
        'materials/concrete/concretewall011.vmt',
        'materials/concrete/concretewall011.vtf',
        'readme.txt',
      ]);
      const vpk = await VpkArchive.open('test', new Blob([dirFile]), (i) => (i === 0 ? new Blob([archive]) : null));
      expect(Array.from((await vpk.read('MATERIALS\\Concrete/ConcreteWall011.vtf'))!)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new TextDecoder().decode((await vpk.read('materials/concrete/concretewall011.vmt'))!)).toContain('LightmappedGeneric');
      expect(Array.from((await vpk.read('readme.txt'))!)).toEqual([9]);
      expect(await vpk.read('missing.vtf')).toBeNull();
      const gc = new GameContent([vpk], 'test');
      const many = await gc.readMany(['materials/concrete/concretewall011.vtf', 'nope.vtf']);
      expect(many.size).toBe(1);
    });
  }

  it('finds known VPK sets in a picked folder', async () => {
    const { dirFile, archive } = buildVpk(2);
    const files = new Map<string, Blob>([
      ['Counter-Strike Source/cstrike/cstrike_pak_dir.vpk', new Blob([dirFile])],
      ['Counter-Strike Source/cstrike/cstrike_pak_000.vpk', new Blob([archive])],
    ]);
    const gc = await openGameContentFromFiles(files);
    expect(gc).not.toBeNull();
    expect(gc!.has('materials/concrete/concretewall011.vtf')).toBe(true);
    expect(Array.from((await gc!.read('materials/concrete/concretewall011.vtf'))!)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
