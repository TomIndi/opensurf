// BSP reader unit tests on synthetic maps (tests/fixtures/bsp_synth.ts). Real maps: bsp_maps.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BspError, faceVertexIndices, parseBsp, validateBsp } from '../src/bsp/reader';
import { LUMP_FACES, LUMP_FACES_HDR } from '../src/bsp/types';
import { BOX_ENTITIES, Rec, buildBoxWorld, pythonSourceLzma, writeBsp } from './fixtures/bsp_synth';

describe('reader: box world (v20)', () => {
  const { buffer } = buildBoxWorld();
  const bsp = parseBsp(buffer);

  it('reads the header', () => {
    expect(bsp.version).toBe(20);
    expect(bsp.mapRevision).toBe(7);
    expect(bsp.lumps.length).toBe(64);
    expect(bsp.warnings).toEqual([]);
    expect(validateBsp(bsp)).toEqual([]);
  });

  it('decodes planes, vertices, edges, surfedges', () => {
    expect(bsp.planes.length).toBe(19);
    expect(bsp.planes[0]).toEqual({ normal: { x: -1, y: 0, z: 0 }, dist: 512, type: 0 });
    expect(bsp.planes[5]).toEqual({ normal: { x: 0, y: 0, z: 1 }, dist: 0, type: 2 });
    expect(bsp.vertices.length).toBe(8 * 3);
    expect(Array.from(bsp.vertices.subarray(3, 6))).toEqual([512, -512, 0]);
    expect(bsp.edges.length).toBe(9 * 2);
    expect(Array.from(bsp.surfedges)).toEqual([1, 2, 3, 4, -8, -7, -6, -5]);
  });

  it('exposes aligned numeric lumps as zero-copy views', () => {
    expect(bsp.vertices.buffer).toBe(buffer);
    expect(bsp.edges.buffer).toBe(buffer);
    expect(bsp.surfedges.buffer).toBe(buffer);
    expect(bsp.getLump(1).buffer).toBe(buffer);
    expect(bsp.getLump(63).length).toBe(0);
    expect(bsp.getLump(-1).length).toBe(0);
  });

  it('decodes faces and face vertex order (positive and negative surfedges)', () => {
    expect(bsp.facesLump).toBe(LUMP_FACES);
    expect(bsp.faces.length).toBe(2);
    const f = bsp.faces[1];
    expect(f).toMatchObject({ planeNum: 5, side: 0, onNode: 1, firstEdge: 4, numEdges: 4, texInfo: 0, dispInfo: 0, surfaceFogVolumeID: -1 });
    expect(f.styles).toEqual([0, 255, 255, 255]);
    expect(f.lightOfs).toBe(-1);
    expect(f.area).toBe(4096);
    expect(f.lightmapTextureSizeInLuxels).toEqual([16, 16]);
    expect(faceVertexIndices(bsp, 0)).toEqual([0, 1, 2, 3]);
    expect(faceVertexIndices(bsp, 1)).toEqual([4, 7, 6, 5]);
  });

  it('decodes texinfo, texdata and material names', () => {
    expect(bsp.texinfo.length).toBe(1);
    expect(bsp.texinfo[0].textureVecs[0]).toBe(0.25);
    expect(bsp.texinfo[0].lightmapVecs[5]).toBe(1 / 16);
    expect(bsp.texdata[0]).toMatchObject({ width: 512, height: 256, nameStringTableID: 0 });
    expect(bsp.texdata[0].reflectivity.x).toBe(0.5);
    expect(bsp.texdataNames).toEqual(['DEV/DEV_MEASUREGENERIC01']);
  });

  it('decodes brushes and brush sides (bevel/thin bytes)', () => {
    expect(bsp.brushes).toEqual([
      { firstSide: 0, numSides: 6, contents: 1 },
      { firstSide: 6, numSides: 6, contents: 1 },
      { firstSide: 12, numSides: 7, contents: 0x40000000 },
    ]);
    expect(bsp.brushSides[18]).toEqual({ planeNum: 13, texInfo: 0, dispInfo: -1, bevel: true, thin: true });
    expect(bsp.brushSides[0].bevel).toBe(false);
  });

  it('decodes nodes, leafs (area/flags bitfield), leaffaces, leafbrushes, models', () => {
    expect(bsp.nodes[0]).toEqual({
      planeNum: 5,
      children: [-2, -1],
      mins: { x: -512, y: -512, z: -64 },
      maxs: { x: 512, y: 512, z: 512 },
      firstFace: 0,
      numFaces: 2,
      area: 1,
    });
    expect(bsp.leafs.length).toBe(6);
    expect(bsp.leafs[1]).toMatchObject({ contents: 0, cluster: 0, area: 1, flags: 3, firstLeafFace: 0, numLeafFaces: 2, leafWaterDataID: -1 });
    expect(Array.from(bsp.leafFaces)).toEqual([0, 1]);
    expect(Array.from(bsp.leafBrushes)).toEqual([0, 1, 2]);
    expect(bsp.models.length).toBe(3);
    expect(bsp.models[1]).toMatchObject({ headNode: 1, mins: { x: -16, y: -16, z: -16 } });
  });

  it('decodes displacements', () => {
    expect(bsp.dispInfos.length).toBe(1);
    expect(bsp.dispInfos[0]).toMatchObject({ power: 1, mapFace: 1, contents: 1, dispVertStart: 0, dispTriStart: 0, minTess: 0x80000000 | 0 });
    expect(bsp.dispVerts.length).toBe(9);
    expect(bsp.dispVerts[4]).toEqual({ vec: { x: 0, y: 0, z: 1 }, dist: 16, alpha: 0 });
    expect(bsp.dispTris.length).toBe(8);
  });

  it('exposes lighting, pakfile and game lumps (absolute offsets)', () => {
    expect(Array.from(bsp.lighting!)).toEqual([10, 20, 30, 0]);
    expect(bsp.lightingHDR).toBeNull();
    expect(new TextDecoder().decode(bsp.pakfile!.subarray(0, 4))).toBe('PK\x05\x06');
    expect(bsp.gameLumps.map((g) => [g.id, g.version, g.data.length])).toEqual([
      ['sprp', 6, 12],
      ['dprp', 4, 4],
    ]);
    expect(new TextDecoder().decode(bsp.gameLumps[0].data)).toBe('sprp-payload');
  });

  it('strips trailing NULs from the entity text', () => {
    expect(bsp.entitiesText).toBe(BOX_ENTITIES);
  });
});

describe('reader: layout variants', () => {
  it('reads 56-byte (version 0) leafs', () => {
    const bsp = parseBsp(buildBoxWorld({ leafVersion: 0 }).buffer);
    expect(bsp.warnings).toEqual([]);
    expect(bsp.leafs.length).toBe(6);
    expect(bsp.leafs[1]).toMatchObject({ area: 1, flags: 3, numLeafFaces: 2 });
    expect(bsp.leafs[4]).toMatchObject({ firstLeafBrush: 2, numLeafBrushes: 1 });
  });

  it('falls back to the HDR face lump', () => {
    const bsp = parseBsp(buildBoxWorld({ hdrFacesOnly: true }).buffer);
    expect(bsp.facesLump).toBe(LUMP_FACES_HDR);
    expect(bsp.faces.length).toBe(2);
    expect(validateBsp(bsp)).toEqual([]);
  });

  it('copies unaligned lumps correctly', () => {
    const { buffer } = buildBoxWorld({ align: 1, pad: 1 });
    const bsp = parseBsp(buffer);
    expect(bsp.vertices.buffer).not.toBe(buffer); // had to copy
    expect(Array.from(bsp.vertices.subarray(3, 6))).toEqual([512, -512, 0]);
    expect(Array.from(bsp.surfedges)).toEqual([1, 2, 3, 4, -8, -7, -6, -5]);
    expect(Array.from(bsp.leafBrushes)).toEqual([0, 1, 2]);
    expect(bsp.gameLumps.length).toBe(2);
    expect(validateBsp(bsp)).toEqual([]);
  });

  it('treats v19 brush side bevel as a 16-bit field', () => {
    const { buffer, lumps } = buildBoxWorld({ version: 19 });
    const bsp = parseBsp(buffer);
    expect(bsp.brushSides[18]).toMatchObject({ bevel: true, thin: false });
    // bevel stored as 0x0100 (high byte only) still counts as a bevel in the old layout
    const sides = lumps.get(19)!.slice();
    sides[0 * 8 + 6] = 0;
    sides[0 * 8 + 7] = 1;
    const bsp2 = parseBsp(buildBoxWorld({ version: 19, override: { 19: { data: sides } } }).buffer);
    expect(bsp2.brushSides[0].bevel).toBe(true);
  });

  it('detects the Left 4 Dead 2 lump_t order', () => {
    const bsp = parseBsp(buildBoxWorld({ version: 21, l4d2Order: true }).buffer);
    expect(bsp.warnings!.some((w) => w.includes('Left 4 Dead 2'))).toBe(true);
    expect(bsp.planes.length).toBe(19);
    expect(validateBsp(bsp)).toEqual([]);
  });

  it('decompresses CS:GO LZMA lumps (entities fixture) and caches them', () => {
    const lz = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'bsp_lzma_entities.bin')));
    const text =
      '{\n"classname" "worldspawn"\n"skyname" "sky_day01_01"\n}\n{\n"classname" "info_player_start"\n"origin" "0 0 64"\n"angles" "0 90 0"\n}\n'.repeat(20);
    const bsp = parseBsp(buildBoxWorld({ version: 21, override: { 0: { data: lz, fourCC: text.length } } }).buffer);
    expect(bsp.version).toBe(21);
    expect(bsp.entitiesText).toBe(text);
    expect(bsp.getLump(0)).toBe(bsp.getLump(0)); // cached
    expect(bsp.warnings).toEqual([]);
  });

  const lzPlanes = pythonSourceLzma(buildBoxWorld().lumps.get(1)!);
  it.skipIf(!lzPlanes)('decompresses an LZMA planes lump (python3-generated)', () => {
    const plain = buildBoxWorld().lumps.get(1)!;
    const bsp = parseBsp(buildBoxWorld({ version: 21, override: { 1: { data: lzPlanes!, fourCC: plain.length } } }).buffer);
    expect(bsp.planes.length).toBe(19);
    expect(bsp.planes[5].normal.z).toBe(1);
    expect(validateBsp(bsp)).toEqual([]);
  });

  it('reads LZMA-compressed game lumps', () => {
    const lz = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'bsp_lzma_pattern.bin')));
    // directory with one compressed 'sprp' entry pointing at the LZMA blob, plus the terminating dummy entry
    const dirSize = 4 + 2 * 16;
    const base = buildBoxWorld();
    const lumpsNoGame = [...base.lumps.entries()].filter(([i]) => i !== 35).map(([index, data]) => ({ index, data, version: index === 10 ? 1 : 0 }));
    const provisional = writeBsp(lumpsNoGame);
    const gameOfs = Math.ceil(provisional.byteLength / 4) * 4;
    const dir = new Rec().i32(2);
    dir.u32(0x73707270).u16(1).u16(10).i32(gameOfs + dirSize).i32(20000);
    dir.u32(0).u16(0).u16(0).i32(gameOfs + dirSize + lz.length).i32(0);
    const game = new Uint8Array(dirSize + lz.length);
    game.set(dir.build(), 0);
    game.set(lz, dirSize);
    const bsp = parseBsp(writeBsp([...lumpsNoGame, { index: 35, data: game, version: 0 }]));
    expect(bsp.gameLumps.length).toBe(1);
    expect(bsp.gameLumps[0]).toMatchObject({ id: 'sprp', version: 10, flags: 1 });
    expect(bsp.gameLumps[0].data.length).toBe(20000);
    expect(bsp.gameLumps[0].data[9]).toBe(((9 * 7 + (9 >> 3)) ^ (9 >> 9)) & 255);
  });
});

describe('reader: errors and validation', () => {
  it('rejects files that are not Source BSPs', () => {
    expect(() => parseBsp(new ArrayBuffer(10))).toThrow(BspError);
    const goldsrc = new ArrayBuffer(2000);
    new DataView(goldsrc).setInt32(0, 30, true);
    expect(() => parseBsp(goldsrc)).toThrow(/GoldSrc/);
    const rbsp = new ArrayBuffer(2000);
    new Uint8Array(rbsp).set([0x72, 0x42, 0x53, 0x50]);
    expect(() => parseBsp(rbsp)).toThrow(/rBSP/);
    const random = new ArrayBuffer(2000);
    new Uint8Array(random).set([1, 2, 3, 4]);
    expect(() => parseBsp(random)).toThrow(/VBSP/);
  });

  it('rejects unknown versions and warns about tolerated ones', () => {
    expect(() => parseBsp(buildBoxWorld({ version: 99 }).buffer)).toThrow(/version 99/);
    const bsp = parseBsp(buildBoxWorld({ version: 22 }).buffer);
    expect(bsp.warnings!.some((w) => w.includes('version 22'))).toBe(true);
  });

  it('ignores lumps outside the file with a warning', () => {
    const { buffer } = buildBoxWorld();
    const dv = new DataView(buffer);
    dv.setInt32(8 + 40 * 16 + 4, buffer.byteLength * 2, true); // pakfile length
    const bsp = parseBsp(buffer);
    expect(bsp.pakfile).toBeNull();
    expect(bsp.warnings!.some((w) => w.includes('lump 40'))).toBe(true);
  });

  it('warns about record lumps with a bad size', () => {
    const planes = buildBoxWorld().lumps.get(1)!;
    const bad = new Uint8Array(planes.length + 3);
    bad.set(planes);
    const bsp = parseBsp(buildBoxWorld({ override: { 1: { data: bad } } }).buffer);
    expect(bsp.planes.length).toBe(19);
    expect(bsp.warnings!.some((w) => w.includes('not a multiple of 20'))).toBe(true);
  });

  it('reports out-of-range cross references', () => {
    const lb = new Rec().u16(0).u16(7).u16(2).build(); // brush 7 doesn't exist
    const bsp = parseBsp(buildBoxWorld({ override: { 17: { data: lb } } }).buffer);
    expect(validateBsp(bsp)).toEqual(['1/3 leafbrushes out of range']);
    expect(bsp.warnings).toContain('1/3 leafbrushes out of range');
    const quiet = parseBsp(buildBoxWorld({ override: { 17: { data: lb } } }).buffer, { validate: false });
    expect(quiet.warnings).toEqual([]);
  });
});
