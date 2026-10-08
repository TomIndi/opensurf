// Materials module tests: pakfile (ZIP), VTF decoding, KeyValues/VMT parsing, material building, procedural
// fallbacks and sky loading. Synthetic data is built in-test; real-map tests read BSPs from $SURF_TEST_MAPS
// (skipped when unset). Set SURF_DUMP_DIR to write a few decoded images as PNG for visual inspection:
//   SURF_TEST_MAPS=/path/to/maps SURF_DUMP_DIR=/tmp/tex npx vitest run tests/materials.test.ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { zipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildMaterials,
  classifyMaterial,
  compiledMapName,
  computeSurfaceHints,
  fallbackMaterial,
  generateProceduralImage,
  hashString,
  imageAverage,
  isProceduralImage,
  lastMaterialStats,
  loadCubemap,
  loadCubemaps,
  loadSky,
  mapFileSource,
  MaterialLoader,
  normalizeMaterialName,
  normalizeTextureName,
  prefetchMaterialFiles,
  proceduralSky,
  reflectivityToSrgb,
  stockSkyPalette,
} from '../src/bsp/materials';
import { PakFile, normalizePakPath } from '../src/bsp/pakfile';
import { parseBsp } from '../src/bsp/reader';
import { BspFile, BspTexData, BspTexInfo, SURF_NODRAW, SURF_NOLIGHT, SURF_SKY, SURF_TRANS, SURF_TRIGGER, SURF_WARP } from '../src/bsp/types';
import {
  evaluateConditional,
  parseKeyValues,
  parseTextureTransform,
  parseVmt,
  vmtBool,
  vmtNumber,
  vmtVector,
} from '../src/bsp/vmt';
import {
  VTF_FLAG_ENVMAP,
  VtfFormat,
  decodeVtf,
  decodeVtfFrames,
  decodeVtfThumbnail,
  extractVtfCompressed,
  linearToSrgb,
  parseVtfHeader,
  srgbToLinear,
  tonemapLinear,
  vtfFormatName,
  vtfImageRef,
  vtfImageSize,
  vtfPickMip,
} from '../src/bsp/vtf';
import type { DecodedImage, MaterialDef } from '../src/map/types';

// ============================================================================ helpers

const te = new TextEncoder();

/** Minimal PNG encoder (RGBA8, filter 0) for eyeballing decoded images. Test-only. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePng(img: DecodedImage): Uint8Array {
  const { width: w, height: h, data } = img;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    const tb = te.encode(type);
    out.set(tb, 4);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32([tb, body]));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

const DUMP = process.env.SURF_DUMP_DIR;
function dump(name: string, img: DecodedImage | null | undefined): void {
  if (!DUMP || !img) return;
  mkdirSync(DUMP, { recursive: true });
  writeFileSync(join(DUMP, name.replace(/[\\/:]+/g, '_') + '.png'), encodePng(img));
}

/** Hand-written ZIP writer (stored / custom-method entries) for pakfile edge cases. */
interface ZipEntrySpec {
  name: string;
  data: Uint8Array;
  method?: number;
  /** Raw payload for non-stored methods. */
  payload?: Uint8Array;
  flags?: number;
}
function writeZip(entries: ZipEntrySpec[], opts: { comment?: Uint8Array; prefix?: number } = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = opts.prefix ?? 0;
  if (opts.prefix) chunks.push(new Uint8Array(opts.prefix).fill(0xaa));
  const base = opts.prefix ?? 0;
  for (const e of entries) {
    const name = te.encode(e.name);
    const payload = e.payload ?? e.data;
    const method = e.method ?? 0;
    const crc = crc32([e.data]);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const localOffset = off - base; // offsets as if the prefix didn't exist (shifted archive)
    chunks.push(lh, payload);
    off += lh.length + payload.length;
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, localOffset, true);
    ch.set(name, 46);
    central.push(ch);
  }
  const cdStart = off - base;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(c);
    cdSize += c.length;
  }
  const comment = opts.comment ?? new Uint8Array(0);
  const eocd = new Uint8Array(22 + comment.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  chunks.push(eocd);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Builds a pakfile from text/binary files using fflate (stored entries, like Source's bspzip). */
function makePak(files: Record<string, string | Uint8Array>, level: 0 | 6 = 0): PakFile {
  const z: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [k, v] of Object.entries(files)) z[k] = [typeof v === 'string' ? te.encode(v) : v, { level }];
  return new PakFile(zipSync(z));
}

// ---- synthetic VTF writer

interface VtfSpec {
  minor?: number;
  width: number;
  height: number;
  format: number;
  mips?: number;
  frames?: number;
  flags?: number;
  depth?: number;
  firstFrame?: number;
  /** Number of faces actually written (defaults: 1, or 6/7 by the envmap rules). */
  faces?: number;
  lowRes?: boolean;
  /** Pixel generator: returns the bytes for one 2D image. */
  image: (mip: number, w: number, h: number, frame: number, face: number, slice: number) => Uint8Array;
}

function buildVtf(s: VtfSpec): Uint8Array {
  const minor = s.minor ?? 2;
  const mips = s.mips ?? 1;
  const frames = s.frames ?? 1;
  const depth = s.depth ?? 1;
  const flags = s.flags ?? 0;
  const envmap = (flags & VTF_FLAG_ENVMAP) !== 0;
  const firstFrame = s.firstFrame ?? 0;
  const faces = s.faces ?? (envmap ? (minor < 5 && firstFrame !== 0xffff ? 7 : 6) : 1);
  const lowResFormat = s.lowRes ? VtfFormat.DXT1 : -1;
  const lowResData = s.lowRes ? new Uint8Array(vtfImageSize(VtfFormat.DXT1, 16, 16)).fill(0x11) : new Uint8Array(0);
  const numRes = minor >= 3 ? (s.lowRes ? 2 : 1) : 0;
  const headerSize = minor >= 3 ? 80 + numRes * 8 : minor >= 2 ? 80 : 64;
  const imgs: Uint8Array[] = [];
  for (let m = mips - 1; m >= 0; m--) {
    const w = Math.max(1, s.width >> m);
    const h = Math.max(1, s.height >> m);
    const d = Math.max(1, depth >> m);
    for (let f = 0; f < frames; f++)
      for (let c = 0; c < faces; c++)
        for (let z = 0; z < d; z++) {
          const b = s.image(m, w, h, f, c, z);
          expect(b.length).toBe(vtfImageSize(s.format, w, h));
          imgs.push(b);
        }
  }
  const highSize = imgs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(headerSize + lowResData.length + highSize);
  const dv = new DataView(out.buffer);
  out.set([0x56, 0x54, 0x46, 0], 0);
  dv.setUint32(4, 7, true);
  dv.setUint32(8, minor, true);
  dv.setUint32(12, headerSize, true);
  dv.setUint16(16, s.width, true);
  dv.setUint16(18, s.height, true);
  dv.setUint32(20, flags, true);
  dv.setUint16(24, frames, true);
  dv.setUint16(26, firstFrame, true);
  dv.setFloat32(32, 0.25, true);
  dv.setFloat32(36, 0.5, true);
  dv.setFloat32(40, 0.75, true);
  dv.setFloat32(48, 1, true);
  dv.setInt32(52, s.format, true);
  out[56] = mips;
  dv.setInt32(57, lowResFormat, true);
  out[61] = s.lowRes ? 16 : 0;
  out[62] = s.lowRes ? 16 : 0;
  if (minor >= 2) dv.setUint16(63, depth, true);
  let p = headerSize;
  const lowOff = p;
  out.set(lowResData, p);
  p += lowResData.length;
  const highOff = p;
  for (const b of imgs) {
    out.set(b, p);
    p += b.length;
  }
  if (minor >= 3) {
    dv.setUint32(68, numRes, true);
    let r = 80;
    if (s.lowRes) {
      out.set([0x01, 0, 0, 0], r);
      dv.setUint32(r + 4, lowOff, true);
      r += 8;
    }
    out.set([0x30, 0, 0, 0], r);
    dv.setUint32(r + 4, highOff, true);
  }
  return out;
}

function solidRgba(w: number, h: number, rgba: number[]): Uint8Array {
  const b = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) b.set(rgba, i * 4);
  return b;
}

/** Fills an image of DXT1 blocks that all decode to one colour (c0 = c1 = rgb565, indices 0). */
function dxt1Solid(w: number, h: number, c565: number): Uint8Array {
  const n = Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2);
  const b = new Uint8Array(n * 8);
  for (let i = 0; i < n; i++) {
    b[i * 8] = c565 & 255;
    b[i * 8 + 1] = c565 >> 8;
    b[i * 8 + 2] = c565 & 255;
    b[i * 8 + 3] = c565 >> 8;
  }
  return b;
}

function px(img: DecodedImage, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(o, o + 4));
}

// ---- synthetic BspFile (only the fields the materials code reads)

function makeBsp(
  mats: { name: string; refl?: [number, number, number]; flags?: number; w?: number; h?: number }[],
  waterBrushMats: number[] = [],
  lumps: Record<number, Uint8Array> = {},
): BspFile {
  const texdata: BspTexData[] = mats.map((m, i) => ({
    reflectivity: { x: m.refl?.[0] ?? 0.2, y: m.refl?.[1] ?? 0.2, z: m.refl?.[2] ?? 0.2 },
    nameStringTableID: i,
    width: m.w ?? 512,
    height: m.h ?? 512,
    viewWidth: m.w ?? 512,
    viewHeight: m.h ?? 512,
  }));
  const texinfo: BspTexInfo[] = mats.map((m, i) => ({
    textureVecs: new Float32Array(8),
    lightmapVecs: new Float32Array(8),
    flags: m.flags ?? 0,
    texData: i,
  }));
  const brushes = waterBrushMats.map((t, i) => ({ firstSide: i, numSides: 1, contents: 0x20 }));
  const brushSides = waterBrushMats.map((t) => ({ planeNum: 0, texInfo: t, dispInfo: -1, bevel: false, thin: false }));
  return {
    version: 20,
    mapRevision: 1,
    lumps: [],
    getLump: (i: number) => lumps[i] ?? new Uint8Array(0),
    entitiesText: '',
    planes: [],
    vertices: new Float32Array(0),
    edges: new Uint16Array(0),
    surfedges: new Int32Array(0),
    faces: [],
    texinfo,
    texdata,
    texdataNames: mats.map((m) => m.name),
    brushes,
    brushSides,
    nodes: [],
    leafs: [],
    leafFaces: new Uint16Array(0),
    leafBrushes: new Uint16Array(0),
    models: [],
    lighting: null,
    lightingHDR: null,
    dispInfos: [],
    dispVerts: [],
    dispTris: new Uint16Array(0),
    pakfile: null,
    gameLumps: [],
  };
}

// ============================================================================ pakfile

describe('pakfile', () => {
  it('reads stored and deflated entries case-insensitively with normalized separators', () => {
    const z = zipSync({
      'materials/Concrete/Wall01.vmt': [te.encode('"LightmappedGeneric" {}'), { level: 0 }],
      'materials/big.txt': [te.encode('x'.repeat(5000)), { level: 6 }],
      'Sound/a.wav': [new Uint8Array([1, 2, 3]), { level: 0 }],
    });
    const pak = new PakFile(z);
    expect(pak.size).toBe(3);
    expect(pak.has('MATERIALS\\concrete\\WALL01.VMT')).toBe(true);
    expect(pak.has('./materials/concrete/wall01.vmt')).toBe(true);
    expect(pak.has('/materials/concrete/wall01.vmt')).toBe(true);
    expect(pak.readText('materials\\concrete\\wall01.vmt')).toBe('"LightmappedGeneric" {}');
    expect(pak.entry('materials/big.txt')!.method).toBe(8);
    expect(pak.readText('materials/BIG.txt')).toBe('x'.repeat(5000));
    expect(Array.from(pak.read('sound/a.wav')!)).toEqual([1, 2, 3]);
    expect(pak.read('nope')).toBeNull();
    expect(pak.list().sort()).toEqual(['materials/big.txt', 'materials/concrete/wall01.vmt', 'sound/a.wav']);
    expect(pak.entries().find((e) => e.key === 'materials/concrete/wall01.vmt')!.name).toBe('materials/Concrete/Wall01.vmt');
  });

  it('returns stored entries as views into the archive', () => {
    const z = zipSync({ 'a.bin': [new Uint8Array(100).fill(7), { level: 0 }] });
    const pak = new PakFile(z);
    const d = pak.read('a.bin')!;
    expect(d.length).toBe(100);
    expect(d.buffer).toBe(z.buffer);
  });

  it('handles archive comments, including one containing a fake EOCD signature', () => {
    const fake = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const comment = new Uint8Array([...te.encode('XZP1 0'), ...fake, ...new Uint8Array(20)]);
    const zip = writeZip([{ name: 'materials\\x.vmt', data: te.encode('hello') }], { comment });
    const pak = new PakFile(zip);
    expect(pak.size).toBe(1);
    expect(pak.readText('materials/x.vmt')).toBe('hello');
    expect(pak.comment.startsWith('XZP1 0')).toBe(true);
    // A comment of maximum length still works.
    const big = new Uint8Array(65535).fill(0x20);
    const pak2 = new PakFile(writeZip([{ name: 'a', data: te.encode('A') }], { comment: big }));
    expect(pak2.readText('a')).toBe('A');
  });

  it('compensates for data prepended to the archive', () => {
    const zip = writeZip(
      [
        { name: 'one.txt', data: te.encode('first') },
        { name: 'two.txt', data: te.encode('second') },
      ],
      { prefix: 37 },
    );
    const pak = new PakFile(zip);
    expect(pak.readText('one.txt')).toBe('first');
    expect(pak.readText('two.txt')).toBe('second');
  });

  it('decodes ZIP-LZMA (method 14) entries', () => {
    // Source "LZMA" header fixture → ZIP-LZMA layout: version(2) propsSize(2) props(5) stream.
    const src = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'bsp_lzma_pattern.bin')));
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const actual = dv.getUint32(4, true);
    const lzmaSize = dv.getUint32(8, true);
    const props = src.subarray(12, 17);
    const stream = src.subarray(17, 17 + lzmaSize);
    const payload = new Uint8Array(4 + 5 + stream.length);
    payload.set([9, 20, 5, 0], 0);
    payload.set(props, 4);
    payload.set(stream, 9);
    const expected = new Uint8Array(actual);
    for (let i = 0; i < actual; i++) expected[i] = ((i * 7 + (i >> 3)) ^ (i >> 9)) & 255;
    const zip = writeZip([{ name: 'materials/lz.bin', data: expected, method: 14, payload, flags: 2 }]);
    const pak = new PakFile(zip);
    const out = pak.read('materials/lz.bin');
    expect(out).not.toBeNull();
    expect(out!.length).toBe(actual);
    expect(Buffer.from(out!).equals(Buffer.from(expected))).toBe(true);
  });

  it.skipIf(spawnSync('python3', ['--version']).status !== 0)('reads archives written by Python zipfile (stored, deflate, LZMA)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surf-pak-'));
    try {
      const zipPath = join(dir, 'p.zip');
      const script = [
        'import sys, zipfile',
        'data = bytes(((i * 7 + (i >> 3)) ^ (i >> 9)) & 255 for i in range(70000))',
        'text = ("\\"LightmappedGeneric\\" { \\"$basetexture\\" \\"concrete/wall\\" }\\n" * 50).encode()',
        'with zipfile.ZipFile(sys.argv[1], "w") as z:',
        '    z.comment = b"XZP1 0"',
        '    z.writestr(zipfile.ZipInfo("materials/Stored.bin"), data, compress_type=zipfile.ZIP_STORED)',
        '    z.writestr("materials\\\\Deflated.vmt", text, compress_type=zipfile.ZIP_DEFLATED)',
        '    z.writestr("materials/lzma.bin", data, compress_type=zipfile.ZIP_LZMA)',
        '    z.writestr("materials/lzma_small.vmt", text, compress_type=zipfile.ZIP_LZMA)',
        '    z.writestr("materials/empty.txt", b"", compress_type=zipfile.ZIP_LZMA)',
      ].join('\n');
      const r = spawnSync('python3', ['-I', '-c', script, zipPath]);
      expect(r.status, String(r.stderr)).toBe(0);
      const pak = new PakFile(new Uint8Array(readFileSync(zipPath)));
      expect(pak.warnings).toEqual([]);
      expect(pak.comment).toBe('XZP1 0');
      const expected = new Uint8Array(70000);
      for (let i = 0; i < expected.length; i++) expected[i] = ((i * 7 + (i >> 3)) ^ (i >> 9)) & 255;
      const text = '"LightmappedGeneric" { "$basetexture" "concrete/wall" }\n'.repeat(50);
      expect(pak.entry('materials/lzma.bin')!.method).toBe(14);
      expect(Buffer.from(pak.read('materials/stored.bin')!).equals(Buffer.from(expected))).toBe(true);
      expect(Buffer.from(pak.read('MATERIALS/LZMA.BIN')!).equals(Buffer.from(expected))).toBe(true);
      expect(pak.readText('materials/deflated.vmt')).toBe(text);
      expect(pak.readText('materials/lzma_small.vmt')).toBe(text);
      expect(pak.read('materials/empty.txt')!.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws on malformed archives', () => {
    expect(new PakFile(new Uint8Array(0)).size).toBe(0);
    expect(new PakFile(new Uint8Array(10)).size).toBe(0);
    expect(new PakFile(te.encode('PK\x05\x06 garbage garbage garbage')).size).toBe(0);
    const good = writeZip([{ name: 'a.txt', data: te.encode('abc') }]);
    // Truncated: drop the middle (central directory remains, data gone).
    const trunc = new Uint8Array([...good.subarray(0, 10), ...good.subarray(good.length - 22 - 46 - 5)]);
    const p = new PakFile(trunc);
    expect(() => p.read('a.txt')).not.toThrow();
    // Random noise.
    let seed = 1;
    for (let k = 0; k < 50; k++) {
      const n = new Uint8Array(200 + k * 13);
      for (let i = 0; i < n.length; i++) n[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
      if (k % 5 === 0) n.set([0x50, 0x4b, 0x05, 0x06], n.length - 22);
      const pak = new PakFile(n);
      for (const f of pak.list()) expect(() => pak.read(f)).not.toThrow();
    }
  });

  it('skips encrypted entries, unknown methods and directories', () => {
    const zip = writeZip([
      { name: 'dir/', data: new Uint8Array(0) },
      { name: 'enc.txt', data: te.encode('secret'), flags: 1 },
      { name: 'bz.txt', data: te.encode('x'), method: 12, payload: new Uint8Array([1, 2, 3]) },
      { name: 'ok.txt', data: te.encode('fine') },
    ]);
    const pak = new PakFile(zip);
    expect(pak.has('dir/')).toBe(false);
    expect(pak.read('enc.txt')).toBeNull();
    expect(pak.read('bz.txt')).toBeNull();
    expect(pak.readText('ok.txt')).toBe('fine');
  });

  it('normalizes paths', () => {
    expect(normalizePakPath('.\\Materials\\\\Foo//Bar.VTF')).toBe('materials/foo/bar.vtf');
    expect(normalizePakPath('/./a')).toBe('a');
  });
});

// ============================================================================ VTF

describe('vtf: sizes and headers', () => {
  it('computes per-format image sizes', () => {
    expect(vtfImageSize(VtfFormat.DXT1, 1, 1)).toBe(8);
    expect(vtfImageSize(VtfFormat.DXT1, 4, 4)).toBe(8);
    expect(vtfImageSize(VtfFormat.DXT1, 5, 4)).toBe(16);
    expect(vtfImageSize(VtfFormat.DXT5, 2, 2)).toBe(16);
    expect(vtfImageSize(VtfFormat.DXT3, 1024, 1024)).toBe(1024 * 1024);
    expect(vtfImageSize(VtfFormat.DXT1, 1024, 512)).toBe(1024 * 512 / 2);
    expect(vtfImageSize(VtfFormat.BGRA8888, 3, 5)).toBe(60);
    expect(vtfImageSize(VtfFormat.BGR888, 3, 5)).toBe(45);
    expect(vtfImageSize(VtfFormat.RGBA16161616F, 2, 2)).toBe(32);
    expect(vtfImageSize(VtfFormat.I8, 7, 3)).toBe(21);
    expect(vtfImageSize(VtfFormat.ATI2N, 8, 8)).toBe(64);
    expect(vtfImageSize(VtfFormat.ATI1N, 8, 8)).toBe(32);
    expect(vtfImageSize(VtfFormat.RGBA8888, 4, 4, 3)).toBe(192);
    expect(vtfImageSize(-1, 16, 16)).toBe(0);
    expect(vtfImageSize(99, 16, 16)).toBe(-1);
    expect(vtfFormatName(VtfFormat.DXT5)).toBe('DXT5');
    expect(vtfFormatName(77)).toBe('UNKNOWN(77)');
  });

  for (const minor of [0, 1, 2, 3, 4, 5]) {
    it(`parses a v7.${minor} header with a low-res thumbnail`, () => {
      const data = buildVtf({
        minor,
        width: 64,
        height: 32,
        format: VtfFormat.BGRA8888,
        mips: 7,
        lowRes: true,
        image: (m, w, h) => solidRgba(w, h, [m * 10, 20, 30, 255]),
      });
      const h = parseVtfHeader(data)!;
      expect(h).not.toBeNull();
      expect(h.versionMinor).toBe(minor);
      expect(h.width).toBe(64);
      expect(h.height).toBe(32);
      expect(h.mipCount).toBe(7);
      expect(h.complete).toBe(true);
      expect(h.reflectivity[1]).toBeCloseTo(0.5);
      const img = decodeVtf(data)!;
      expect(img.width).toBe(64);
      expect(img.height).toBe(32);
      // BGRA bytes [0,20,30,255] → R=30, G=20, B=0.
      expect(px(img, 5, 5)).toEqual([30, 20, 0, 255]);
      expect(img.hasAlpha).toBe(false);
      const thumb = decodeVtfThumbnail(data)!;
      expect(thumb.width).toBe(16);
    });
  }

  it('picks the largest mip that fits maxSize (mips are stored smallest first)', () => {
    const data = buildVtf({
      width: 256,
      height: 128,
      format: VtfFormat.RGBA8888,
      mips: 9,
      image: (m, w, h) => solidRgba(w, h, [m, 255 - m, w & 255, 255]),
    });
    const h = parseVtfHeader(data)!;
    expect(vtfPickMip(h, 2048)).toBe(0);
    expect(vtfPickMip(h, 128)).toBe(1);
    expect(vtfPickMip(h, 100)).toBe(2);
    const a = decodeVtf(data)!;
    expect([a.width, a.height]).toEqual([256, 128]);
    expect(px(a, 0, 0)).toEqual([0, 255, 0, 255]);
    const b = decodeVtf(data, { maxSize: 64 })!;
    expect([b.width, b.height]).toEqual([64, 32]);
    expect(px(b, 3, 3)).toEqual([2, 253, 64, 255]);
    const c = decodeVtf(data, { maxSize: 1 })!;
    expect([c.width, c.height]).toEqual([1, 1]);
    expect(px(c, 0, 0)[0]).toBe(8);
  });

  it('box-downscales when no stored mip is small enough', () => {
    const data = buildVtf({
      width: 64,
      height: 64,
      format: VtfFormat.RGBA8888,
      mips: 1,
      image: (m, w, h) => {
        const b = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) b.set([(i & 1) * 200, 100, 50, 255], i * 4);
        return b;
      },
    });
    const img = decodeVtf(data, { maxSize: 16 })!;
    expect([img.width, img.height]).toEqual([16, 16]);
    expect(px(img, 4, 4)).toEqual([100, 100, 50, 255]);
  });

  it('selects frame 0 / face 0 / slice 0 in the mip → frame → face → slice layout', () => {
    const data = buildVtf({
      minor: 2,
      width: 8,
      height: 8,
      depth: 2,
      frames: 3,
      format: VtfFormat.RGB888,
      mips: 2,
      image: (m, w, h, f, c, z) => {
        const b = new Uint8Array(w * h * 3);
        for (let i = 0; i < w * h; i++) b.set([m * 100 + f * 10 + z, 7, 9], i * 3);
        return b;
      },
    });
    expect(px(decodeVtf(data)!, 1, 1)).toEqual([0, 7, 9, 255]);
    expect(px(decodeVtf(data, { frame: 2 })!, 1, 1)).toEqual([20, 7, 9, 255]);
    expect(px(decodeVtf(data, { frame: 1, slice: 1 })!, 1, 1)).toEqual([11, 7, 9, 255]);
    expect(px(decodeVtf(data, { maxSize: 4, frame: 1 })!, 0, 0)).toEqual([110, 7, 9, 255]);
    const frames = decodeVtfFrames(data)!;
    expect(frames.length).toBe(3);
    expect(frames.map((f) => px(f, 0, 0)[0])).toEqual([0, 10, 20]);
  });

  it('handles cube maps with 7 faces (< 7.5) and 6 faces (7.5 or firstFrame = 0xFFFF)', () => {
    const mk = (minor: number, firstFrame: number, faces: number) =>
      buildVtf({
        minor,
        width: 4,
        height: 4,
        flags: VTF_FLAG_ENVMAP,
        firstFrame,
        faces,
        format: VtfFormat.I8,
        mips: 3,
        image: (m, w, h, f, c) => new Uint8Array(w * h).fill(c * 30 + m),
      });
    const a = parseVtfHeader(mk(2, 0, 7))!;
    expect(a.faces).toBe(7);
    expect(a.complete).toBe(true);
    const b = parseVtfHeader(mk(5, 0, 6))!;
    expect(b.faces).toBe(6);
    const c = parseVtfHeader(mk(4, 0xffff, 6))!;
    expect(c.faces).toBe(6);
    // Mislabelled file: a 7.2 cube map that only stores 6 faces is detected from its size.
    const d = parseVtfHeader(mk(2, 0, 6))!;
    expect(d.faces).toBe(6);
    expect(d.complete).toBe(true);
    for (const data of [mk(2, 0, 7), mk(5, 0, 6), mk(2, 0, 6)]) {
      expect(px(decodeVtf(data)!, 0, 0)).toEqual([0, 0, 0, 255]);
      expect(px(decodeVtf(data, { face: 3 })!, 0, 0)).toEqual([90, 90, 90, 255]);
    }
  });

  it('rejects invalid data without throwing', () => {
    const good = buildVtf({ width: 16, height: 16, format: VtfFormat.DXT1, mips: 5, image: (m, w, h) => dxt1Solid(w, h, 0xffff) });
    expect(decodeVtf(new Uint8Array(0))).toBeNull();
    expect(decodeVtf(te.encode('VTF\0 too short'))).toBeNull();
    const bad = good.slice();
    bad[0] = 0x41;
    expect(decodeVtf(bad)).toBeNull();
    const badFmt = good.slice();
    new DataView(badFmt.buffer).setInt32(52, 1234, true);
    expect(decodeVtf(badFmt)).toBeNull();
    const p8 = good.slice();
    new DataView(p8.buffer).setInt32(52, VtfFormat.P8, true);
    expect(decodeVtf(p8)).toBeNull();
    // Truncated: the largest mip is missing → a smaller mip is returned.
    const trunc = good.subarray(0, good.length - 100);
    const t = decodeVtf(trunc);
    expect(t).not.toBeNull();
    expect(t!.width).toBeLessThan(16);
    // Header only.
    expect(decodeVtf(good.subarray(0, 80))).toBeNull();
    // Fuzz: random corruption never throws.
    let seed = 7;
    for (let k = 0; k < 300; k++) {
      const c = good.slice();
      for (let j = 0; j < 4; j++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        c[seed % 80] = seed >> 8;
      }
      expect(() => decodeVtf(c)).not.toThrow();
    }
  });
});

describe('vtf: pixel formats', () => {
  const one = (format: number, bytes: number[], w = 1, h = 1, opts = {}) =>
    decodeVtf(buildVtf({ width: w, height: h, format, image: () => new Uint8Array(bytes) }), opts)!;

  it('decodes 8-bit RGB(A) orderings', () => {
    expect(px(one(VtfFormat.RGBA8888, [1, 2, 3, 4]), 0, 0)).toEqual([1, 2, 3, 4]);
    expect(px(one(VtfFormat.ABGR8888, [4, 3, 2, 1]), 0, 0)).toEqual([1, 2, 3, 4]);
    expect(px(one(VtfFormat.ARGB8888, [4, 1, 2, 3]), 0, 0)).toEqual([1, 2, 3, 4]);
    expect(px(one(VtfFormat.BGRA8888, [3, 2, 1, 4]), 0, 0)).toEqual([1, 2, 3, 4]);
    expect(px(one(VtfFormat.BGRX8888, [3, 2, 1, 0]), 0, 0)).toEqual([1, 2, 3, 255]);
    expect(px(one(VtfFormat.RGB888, [1, 2, 3]), 0, 0)).toEqual([1, 2, 3, 255]);
    expect(px(one(VtfFormat.BGR888, [3, 2, 1]), 0, 0)).toEqual([1, 2, 3, 255]);
    expect(one(VtfFormat.RGBA8888, [1, 2, 3, 4]).hasAlpha).toBe(true);
    expect(one(VtfFormat.RGBA8888, [1, 2, 3, 255]).hasAlpha).toBe(false);
  });

  it('decodes blue-screen formats (pure blue = transparent)', () => {
    const a = one(VtfFormat.RGB888_BLUESCREEN, [0, 0, 255, 10, 20, 30], 2, 1);
    expect(px(a, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(a, 1, 0)).toEqual([10, 20, 30, 255]);
    expect(a.hasAlpha).toBe(true);
    const b = one(VtfFormat.BGR888_BLUESCREEN, [255, 0, 0, 30, 20, 10], 2, 1);
    expect(px(b, 0, 0)[3]).toBe(0);
    expect(px(b, 1, 0)).toEqual([10, 20, 30, 255]);
  });

  it('decodes 16-bit packed formats', () => {
    // BGR565: R in the high 5 bits. 0xF800 = pure red.
    expect(px(one(VtfFormat.BGR565, [0x00, 0xf8]), 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(one(VtfFormat.BGR565, [0x1f, 0x00]), 0, 0)).toEqual([0, 0, 255, 255]);
    // RGB565: R in the low 5 bits.
    expect(px(one(VtfFormat.RGB565, [0x1f, 0x00]), 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(one(VtfFormat.RGB565, [0xe0, 0x07]), 0, 0)).toEqual([0, 255, 0, 255]);
    // BGRA5551: A in bit 15, R bits 10-14.
    expect(px(one(VtfFormat.BGRA5551, [0x00, 0xfc]), 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(one(VtfFormat.BGRA5551, [0x1f, 0x00]), 0, 0)).toEqual([0, 0, 255, 0]);
    expect(px(one(VtfFormat.BGRX5551, [0x1f, 0x00]), 0, 0)).toEqual([0, 0, 255, 255]);
    // BGRA4444: B low nibble of byte 0, G high nibble, R low nibble of byte 1, A high nibble.
    expect(px(one(VtfFormat.BGRA4444, [0x21, 0x43]), 0, 0)).toEqual([0x33, 0x22, 0x11, 0x44]);
  });

  it('decodes luminance / alpha / UV formats', () => {
    expect(px(one(VtfFormat.I8, [77]), 0, 0)).toEqual([77, 77, 77, 255]);
    expect(px(one(VtfFormat.IA88, [77, 10]), 0, 0)).toEqual([77, 77, 77, 10]);
    expect(px(one(VtfFormat.A8, [10]), 0, 0)).toEqual([255, 255, 255, 10]);
    expect(px(one(VtfFormat.UV88, [0, 0]), 0, 0)).toEqual([128, 128, 255, 255]);
    expect(px(one(VtfFormat.UVWQ8888, [0, 0x7f, 0x81, 0]), 0, 0)).toEqual([128, 255, 1, 255]);
  });

  it('decodes and tone-maps RGBA16161616F (half float, linear)', () => {
    // 1.0, 0.5, 0.0, alpha 1.0
    const img = one(VtfFormat.RGBA16161616F, [0x00, 0x3c, 0x00, 0x38, 0x00, 0x00, 0x00, 0x3c]);
    const p = px(img, 0, 0);
    expect(p[0]).toBe(Math.round(linearToSrgb(tonemapLinear(1)) * 255));
    expect(Math.abs(p[1] - Math.round(linearToSrgb(0.5) * 255))).toBeLessThanOrEqual(1);
    expect(p[2]).toBe(0);
    expect(p[3]).toBe(255);
    expect(img.hasAlpha).toBe(false);
    // Large HDR values stay below white thanks to the shoulder, negatives / NaN clamp to 0.
    const hot = px(one(VtfFormat.RGBA16161616F, [0x00, 0x4c, 0x00, 0xbc, 0x00, 0x7e, 0x00, 0x3c]), 0, 0);
    expect(hot[0]).toBe(255);
    expect(hot[1]).toBe(0);
    expect(hot[2]).toBe(0);
  });

  it('decodes RGBA16161616 and float formats', () => {
    const a = px(one(VtfFormat.RGBA16161616, [0xff, 0xff, 0, 0x80, 0, 0, 0xff, 0xff]), 0, 0);
    expect(a[0]).toBe(Math.round(linearToSrgb(tonemapLinear(1)) * 255));
    expect(a[2]).toBe(0);
    expect(a[3]).toBe(255);
    const f = new Uint8Array(12);
    new DataView(f.buffer).setFloat32(0, 0.25, true);
    new DataView(f.buffer).setFloat32(4, 0, true);
    new DataView(f.buffer).setFloat32(8, 0.5, true);
    const b = px(one(VtfFormat.RGB323232F, Array.from(f)), 0, 0);
    expect(Math.abs(b[0] - linearToSrgb(0.25) * 255)).toBeLessThan(1);
    expect(Math.abs(b[2] - linearToSrgb(0.5) * 255)).toBeLessThan(1);
  });

  it('decodes Valve compressed-HDR BGRA8888 (rgb * a * 16 / 255)', () => {
    // b=0,g=64,r=128,a=32 → linear r = 128/255 * 32*16/255 ≈ 1.008, g ≈ 0.504
    const img = one(VtfFormat.BGRA8888, [0, 64, 128, 32], 1, 1, { hdrCompressed: true });
    const p = px(img, 0, 0);
    expect(Math.abs(p[0] - linearToSrgb(tonemapLinear((128 / 255) * ((32 * 16) / 255))) * 255)).toBeLessThanOrEqual(1);
    expect(Math.abs(p[1] - linearToSrgb(tonemapLinear((64 / 255) * ((32 * 16) / 255))) * 255)).toBeLessThanOrEqual(1);
    expect(p[3]).toBe(255);
  });
});

describe('vtf: DXT block decoding', () => {
  // Rows of 2-bit indices, pixel 0 in the low bits.
  const row = (a: number, b: number, c: number, d: number) => a | (b << 2) | (c << 4) | (d << 6);

  it('DXT1 four-colour mode', () => {
    // c0 = red (0xF800) > c1 = blue (0x001F)
    const block = [0x00, 0xf8, 0x1f, 0x00, row(0, 1, 2, 3), row(3, 2, 1, 0), row(0, 0, 0, 0), row(1, 1, 1, 1)];
    const img = decodeVtf(buildVtf({ width: 4, height: 4, format: VtfFormat.DXT1, image: () => new Uint8Array(block) }))!;
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(img, 2, 0)).toEqual([170, 0, 85, 255]);
    expect(px(img, 3, 0)).toEqual([85, 0, 170, 255]);
    expect(px(img, 0, 1)).toEqual([85, 0, 170, 255]);
    expect(px(img, 2, 3)).toEqual([0, 0, 255, 255]);
    expect(img.hasAlpha).toBe(false);
  });

  it('DXT1 three-colour mode with punch-through alpha', () => {
    // c0 = blue (0x001F) <= c1 = red (0xF800)
    const block = [0x1f, 0x00, 0x00, 0xf8, row(0, 1, 2, 3), 0, 0, 0];
    for (const format of [VtfFormat.DXT1, VtfFormat.DXT1_ONEBITALPHA]) {
      const img = decodeVtf(buildVtf({ width: 4, height: 4, format, image: () => new Uint8Array(block) }))!;
      expect(px(img, 0, 0)).toEqual([0, 0, 255, 255]);
      expect(px(img, 1, 0)).toEqual([255, 0, 0, 255]);
      expect(px(img, 2, 0)).toEqual([128, 0, 128, 255]);
      expect(px(img, 3, 0)).toEqual([0, 0, 0, 0]);
      expect(img.hasAlpha).toBe(true);
    }
  });

  it('DXT3 explicit 4-bit alpha (colour block always 4-colour)', () => {
    const alpha = [0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe]; // nibbles 0..15 in pixel order
    // Colour block with c0 < c1 would be 3-colour in DXT1, but DXT3 always uses 4 colours.
    const color = [0x1f, 0x00, 0x00, 0xf8, row(3, 3, 3, 3), row(2, 2, 2, 2), 0, 0];
    const img = decodeVtf(buildVtf({ width: 4, height: 4, format: VtfFormat.DXT3, image: () => new Uint8Array([...alpha, ...color]) }))!;
    // p0 = blue, p1 = red → p2 = (2·p0 + p1)/3, p3 = (p0 + 2·p1)/3
    expect(px(img, 0, 0)).toEqual([170, 0, 85, 0]);
    expect(px(img, 1, 0)[3]).toBe(17);
    expect(px(img, 3, 3)[3]).toBe(255);
    expect(px(img, 0, 1)).toEqual([85, 0, 170, 4 * 17]);
    expect(img.hasAlpha).toBe(true);
  });

  it('DXT5 interpolated alpha, both modes', () => {
    const idx3 = (vals: number[]) => {
      // 16 3-bit indices → 6 bytes
      let lo = 0;
      let hi = 0;
      for (let i = 0; i < 8; i++) lo |= vals[i] << (3 * i);
      for (let i = 0; i < 8; i++) hi |= vals[i + 8] << (3 * i);
      return [lo & 255, (lo >> 8) & 255, (lo >> 16) & 255, hi & 255, (hi >> 8) & 255, (hi >> 16) & 255];
    };
    const color = [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]; // white
    // a0 = 255 > a1 = 0: 8-value mode
    const a = [255, 0, ...idx3([0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 1, 1, 1, 1])];
    const img = decodeVtf(buildVtf({ width: 4, height: 4, format: VtfFormat.DXT5, image: () => new Uint8Array([...a, ...color]) }))!;
    const alphas = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => px(img, i & 3, i >> 2)[3]);
    expect(alphas).toEqual([255, 0, 219, 182, 146, 109, 73, 36]);
    expect(px(img, 0, 0).slice(0, 3)).toEqual([255, 255, 255]);
    // a0 = 0 <= a1 = 200: 6-value mode with explicit 0 and 255
    const b = [0, 200, ...idx3([0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0])];
    const img2 = decodeVtf(buildVtf({ width: 4, height: 4, format: VtfFormat.DXT5, image: () => new Uint8Array([...b, ...color]) }))!;
    const alphas2 = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => px(img2, i & 3, i >> 2)[3]);
    expect(alphas2).toEqual([0, 200, 40, 80, 120, 160, 0, 255]);
  });

  it('handles images smaller than / not a multiple of a block', () => {
    const block = [0x00, 0xf8, 0x1f, 0x00, row(0, 1, 2, 3), row(1, 1, 1, 1), 0, 0];
    const img = decodeVtf(buildVtf({ width: 2, height: 2, format: VtfFormat.DXT1, image: () => new Uint8Array(block) }))!;
    expect([img.width, img.height]).toEqual([2, 2]);
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(img, 0, 1)).toEqual([0, 0, 255, 255]);
    // 6x5 → 2x2 blocks
    const data = buildVtf({ width: 6, height: 5, format: VtfFormat.DXT1, image: (m, w, h) => dxt1Solid(w, h, 0x07e0) });
    const g = decodeVtf(data)!;
    expect([g.width, g.height]).toEqual([6, 5]);
    expect(px(g, 5, 4)).toEqual([0, 255, 0, 255]);
  });

  const hasPillow = spawnSync('python3', ['-I', '-c', 'import PIL.Image']).status === 0;
  it.skipIf(!hasPillow)('matches an independent decoder (Pillow) on random DXT1/3/5 blocks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surf-dxt-'));
    try {
      let seed = 12345;
      const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 255;
      for (const [format, fourcc] of [
        [VtfFormat.DXT1, 'DXT1'],
        [VtfFormat.DXT3, 'DXT3'],
        [VtfFormat.DXT5, 'DXT5'],
      ] as [number, string][]) {
        const W = 64;
        const H = 32;
        const blocks = new Uint8Array(vtfImageSize(format, W, H));
        for (let i = 0; i < blocks.length; i++) blocks[i] = rand();
        // Force both colour modes (c0 > c1 and c0 <= c1) and both DXT5 alpha modes to appear.
        const bb = format === VtfFormat.DXT1 ? 8 : 16;
        for (let b = 0; b * bb < blocks.length; b++) {
          const c = b * bb + (bb - 8);
          if (b % 3 === 0) [blocks[c], blocks[c + 2]] = [blocks[c + 2], blocks[c]];
          if (b % 4 === 0) blocks[c + 1] = blocks[c + 3];
          if (format === VtfFormat.DXT5 && b % 2 === 0) [blocks[b * bb], blocks[b * bb + 1]] = [Math.min(blocks[b * bb], blocks[b * bb + 1]), Math.max(blocks[b * bb], blocks[b * bb + 1])];
        }
        const dds = new Uint8Array(128 + blocks.length);
        const dv = new DataView(dds.buffer);
        dds.set(te.encode('DDS '), 0);
        dv.setUint32(4, 124, true);
        dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, true);
        dv.setUint32(12, H, true);
        dv.setUint32(16, W, true);
        dv.setUint32(20, blocks.length, true);
        dv.setUint32(76, 32, true);
        dv.setUint32(80, 0x4, true);
        dds.set(te.encode(fourcc), 84);
        dv.setUint32(108, 0x1000, true);
        dds.set(blocks, 128);
        const ddsPath = join(dir, `${fourcc}.dds`);
        const rawPath = join(dir, `${fourcc}.raw`);
        writeFileSync(ddsPath, dds);
        const r = spawnSync('python3', ['-I', '-c', 'import sys; from PIL import Image; im = Image.open(sys.argv[1]); im.load(); open(sys.argv[2], "wb").write(im.convert("RGBA").tobytes())', ddsPath, rawPath]);
        expect(r.status, String(r.stderr)).toBe(0);
        const ref = new Uint8Array(readFileSync(rawPath));
        const ours = decodeVtf(buildVtf({ width: W, height: H, format, image: () => blocks }))!;
        expect(ref.length).toBe(ours.data.length);
        let maxDiff = 0;
        let off = 0;
        for (let i = 0; i < ref.length; i++) {
          const d = Math.abs(ref[i] - ours.data[i]);
          maxDiff = Math.max(maxDiff, d);
          if (d > 1) off++;
        }
        // Implementations may round the 1/3 and 2/3 interpolants differently; allow ±1.
        expect(off, `${fourcc}: ${off} channel values differ by more than 1 (max ${maxDiff})`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decodes a full DXT1 mip chain down to 1x1', () => {
    const data = buildVtf({ width: 64, height: 16, format: VtfFormat.DXT1, mips: 7, image: (m, w, h) => dxt1Solid(w, h, m === 6 ? 0xf800 : 0x001f) });
    const h = parseVtfHeader(data)!;
    expect(h.complete).toBe(true);
    expect(px(decodeVtf(data, { maxSize: 1 })!, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(decodeVtf(data, { maxSize: 2 })!, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('compressed mode: keeps the DXT mip chain and decodes a reduced RGBA fallback', () => {
    const data = buildVtf({ width: 64, height: 32, format: VtfFormat.DXT5, mips: 7, image: (m, w, h) => {
      const b = new Uint8Array(vtfImageSize(VtfFormat.DXT5, w, h));
      for (let i = 0; i < b.length; i += 16) b.set([255, 255, 0, 0, 0, 0, 0, 0, m * 8, 0xf8, m * 8, 0xf8, 0, 0, 0, 0], i);
      return b;
    } });
    const img = decodeVtf(data, { maxSize: 32, compressed: true, rgbaMaxSize: 8 })!;
    expect([img.width, img.height]).toEqual([8, 4]);
    expect(img.compressed).toBeDefined();
    const c = img.compressed!;
    expect(c.format).toBe('dxt5');
    expect([c.width, c.height]).toEqual([32, 16]);
    expect(c.mips.map((m) => [m.width, m.height])).toEqual([[32, 16], [16, 8], [8, 4], [4, 2], [2, 1], [1, 1]]);
    for (const m of c.mips) {
      expect(m.data.length).toBe(vtfImageSize(VtfFormat.DXT5, m.width, m.height));
      expect(m.data.buffer).not.toBe(data.buffer); // copies: the map buffer can be released
    }
    expect(c.mips[0].data[8]).toBe(8); // mip 1 (32x16) colour word
    // Non-DXT formats ignore the option; without the option nothing is attached.
    expect(decodeVtf(buildVtf({ width: 4, height: 4, format: VtfFormat.RGBA8888, image: (m, w, h) => solidRgba(w, h, [1, 2, 3, 4]) }), { compressed: true })!.compressed).toBeUndefined();
    expect(decodeVtf(data)!.compressed).toBeUndefined();
    expect(extractVtfCompressed(data)!.mips.length).toBe(7);
  });

  it('decodes ATI2N / ATI1N', () => {
    const blk = [128, 128, 0, 0, 0, 0, 0, 0];
    const a = decodeVtf(buildVtf({ width: 4, height: 4, format: VtfFormat.ATI2N, image: () => new Uint8Array([...blk, ...blk]) }))!;
    expect(px(a, 1, 1)).toEqual([128, 128, 255, 255]);
    const b = decodeVtf(buildVtf({ width: 4, height: 4, format: VtfFormat.ATI1N, image: () => new Uint8Array([90, 90, 0, 0, 0, 0, 0, 0]) }))!;
    expect(px(b, 2, 2)).toEqual([90, 90, 90, 255]);
  });
});

describe('vtf: colour helpers', () => {
  it('sRGB transfer functions round-trip', () => {
    for (const x of [0, 0.001, 0.0031308, 0.04, 0.2, 0.5, 0.8, 1]) expect(srgbToLinear(linearToSrgb(x))).toBeCloseTo(x, 5);
    expect(linearToSrgb(0.5)).toBeCloseTo(0.7354, 3);
    expect(linearToSrgb(-1)).toBe(0);
    expect(linearToSrgb(2)).toBe(1);
  });
  it('tone curve is identity below the knee, monotonic and < 1 above', () => {
    expect(tonemapLinear(0.5)).toBe(0.5);
    let prev = 0;
    for (let x = 0; x < 20; x += 0.05) {
      const t = tonemapLinear(x);
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeLessThanOrEqual(1);
      if (x < 4) expect(t).toBeLessThan(1);
      prev = t;
    }
  });
});

// ============================================================================ KeyValues / VMT

describe('keyvalues', () => {
  it('parses quoted and bare tokens, comments, nesting; lower-cases keys only', () => {
    const kv = parseKeyValues(`
      // leading comment
      "LightmappedGeneric"
      {
        "$BaseTexture" "Concrete\\Wall01"   // trailing comment
        $surfaceprop concrete
        "$Color" "[1 0.5 0.25]"
        $nocull 1//comment glued to a value
        "Proxies"
        {
          "TextureScroll" { "texturescrollvar" "$baseTextureTransform" "texturescrollrate" ".5" }
        }
      }`);
    const m = kv.lightmappedgeneric as Record<string, unknown>;
    expect(m['$basetexture']).toBe('Concrete\\Wall01');
    expect(m['$surfaceprop']).toBe('concrete');
    expect(m['$color']).toBe('[1 0.5 0.25]');
    expect(m['$nocull']).toBe('1');
    expect(((m.proxies as Record<string, unknown>).texturescroll as Record<string, string>).texturescrollvar).toBe('$baseTextureTransform');
  });

  it('duplicate keys: last scalar wins, blocks merge', () => {
    const kv = parseKeyValues(`"s" { "$a" "1" "$a" "2" "p" { "x" "1" } "p" { "y" "2" "x" "3" } }`);
    const s = kv.s as Record<string, unknown>;
    expect(s['$a']).toBe('2');
    expect(s.p).toEqual({ x: '3', y: '2' });
  });

  it('evaluates platform conditionals after values and before blocks', () => {
    const kv = parseKeyValues(`"s" {
      "$a" "pc" [!$X360]
      "$a" "x360" [$X360]
      "$b" "win" [$WIN32]
      "$c" "osx" [$OSX]
      "$d" "both" [$WIN32 || $OSX]
      "$e" "and" [!$X360 && !$PS3]
      "blk" [$X360] { "q" "1" }
      "blk2" [!$X360] { "q" "2" }
      "blk3" { "q" "3" } [$PS3]
    }`);
    const s = kv.s as Record<string, unknown>;
    expect(s['$a']).toBe('pc');
    expect(s['$b']).toBe('win');
    expect(s['$c']).toBeUndefined();
    expect(s['$d']).toBe('both');
    expect(s['$e']).toBe('and');
    expect(s.blk).toBeUndefined();
    expect(s.blk2).toEqual({ q: '2' });
    expect(s.blk3).toBeUndefined();
    expect(evaluateConditional('[$WINDOWS]')).toBe(true);
    expect(evaluateConditional('[!$GAMECONSOLE]')).toBe(true);
    expect(evaluateConditional('[$UNKNOWN]')).toBe(false);
  });

  it('is lenient with malformed input', () => {
    expect(parseKeyValues('')).toEqual({});
    expect(parseKeyValues('"a" { "b" "c"')).toEqual({ a: { b: 'c' } }); // unterminated block
    expect(parseKeyValues('"a" { "b" "unterminated\n "c" "d" }')).toEqual({ a: { b: 'unterminated', c: 'd' } });
    expect(parseKeyValues('} } "a" "b"')).toEqual({ a: 'b' });
    expect(parseKeyValues('"a" { "lonely" }')).toEqual({ a: { lonely: '' } });
    expect(parseKeyValues('﻿"x" "y"')).toEqual({ x: 'y' });
    expect(parseKeyValues('#include "foo.vmt"\n"x" { }')).toEqual({ x: {} });
    const proto = parseKeyValues('"__proto__" { "polluted" "1" }');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(proto)).toEqual(['__proto__']);
    // Deep nesting doesn't blow the stack.
    expect(() => parseKeyValues('"a" {'.repeat(5000) + '}'.repeat(5000))).not.toThrow();
  });
});

describe('vmt', () => {
  it('extracts shader, params and proxies', () => {
    const v = parseVmt(`"UnlitGeneric" { "$baseTexture" "neons/neon_green" "$Translucent" 1 "Proxies" { "AnimatedTexture" { "animatedtexturevar" "$basetexture" } } }`);
    expect(v.shader).toBe('unlitgeneric');
    expect(v.params['$basetexture']).toBe('neons/neon_green');
    expect(v.params['$translucent']).toBe('1');
    expect(v.proxies).not.toBeNull();
    expect((v.proxies!.animatedtexture as Record<string, string>).animatedtexturevar).toBe('$basetexture');
  });

  it('merges DX9 / HDR fallback blocks and DX-level conditional blocks, ignoring older hardware', () => {
    const v = parseVmt(`"LightmappedGeneric" {
      "$basetexture" "a"
      "$envmaptint" "[1 1 1]"
      "LightmappedGeneric_DX9" { "$bumpmap" "a_normal" }
      "LightmappedGeneric_DX8" { "$basetexture" "dx8" }
      "LightmappedGeneric_NoBump_DX8" { "$basetexture" "nobump" }
      "lightmappedgeneric_HDR_dx9" { "$envmaptint" "[.5 .5 .5]" }
      "<dx90" { "$fallbackmaterial" "x_dx80" }
      ">=dx90" { "$detail" "d" }
      "srgb?$selfillum" "1"
      "360?$color2" "[1 0 0]"
      "GPU>=2?$phong" "1"
      "GPU<1?$lowq" "1"
    }`);
    expect(v.params['$basetexture']).toBe('a');
    expect(v.params['$bumpmap']).toBe('a_normal');
    expect(v.params['$envmaptint']).toBe('[.5 .5 .5]');
    expect(v.params['$fallbackmaterial']).toBeUndefined();
    expect(v.params['$detail']).toBe('d');
    expect(v.params['$selfillum']).toBe('1');
    expect(v.params['$color2']).toBeUndefined();
    expect(v.params['$phong']).toBe('1');
    expect(v.params['$lowq']).toBeUndefined();
  });

  it('normalizes DX-specific root shader names', () => {
    expect(parseVmt('"UnlitGeneric_DX6" { "$basetexture" "a" }').shader).toBe('unlitgeneric');
    expect(parseVmt('"LightmappedGeneric_DX9" { "$basetexture" "a" "LightmappedGeneric_DX9" { "$basetexture" "b" } }').params['$basetexture']).toBe('a');
    expect(parseVmt('"Water_DX81" { }').shader).toBe('water');
    expect(parseVmt('"LightmappedGeneric_NoBump_DX8" { }').shader).toBe('lightmappedgeneric');
    expect(parseVmt('"LightmappedGeneric_HDR_DX9" { }').shader).toBe('lightmappedgeneric');
  });

  it('resolves patch includes (nested) with insert/replace', () => {
    const files: Record<string, string> = {
      'materials/glass/glasswindow001a.vmt': `"LightmappedGeneric" { "$baseTexture" "glass/glasswindow001a" "$translucent" 1 "$envmap" "env_cubemap" }`,
      'materials/maps/m/glass/glasswindow001a_1_2_3.vmt': `"patch" { "include" "materials/GLASS/GLASSWINDOW001A.vmt" "replace" { "$envmap" "maps/m/c1_2_3" } }`,
      'materials/maps/m/maps/m/glass/glasswindow001a_1_2_3_depth_16.vmt': `"patch" { "include" "materials\\maps\\m\\glass\\glasswindow001a_1_2_3.vmt" "insert" { "$waterdepth" "16" } }`,
    };
    const read = (p: string) => files[normalizePakPath(p)] ?? null;
    const v = parseVmt(files['materials/maps/m/maps/m/glass/glasswindow001a_1_2_3_depth_16.vmt'], read);
    expect(v.shader).toBe('lightmappedgeneric');
    expect(v.params['$basetexture']).toBe('glass/glasswindow001a');
    expect(v.params['$translucent']).toBe('1');
    expect(v.params['$envmap']).toBe('maps/m/c1_2_3');
    expect(v.params['$waterdepth']).toBe('16');
    expect(v.includes!.length).toBe(2);
    expect(v.includeMissing).toBeUndefined();
  });

  it('accepts include paths without "materials/" or ".vmt"', () => {
    const files: Record<string, string> = { 'materials/a/b.vmt': `"UnlitGeneric" { "$basetexture" "x" }` };
    const read = (p: string) => files[normalizePakPath(p)] ?? null;
    expect(parseVmt(`"patch" { "include" "a/b" }`, read).shader).toBe('unlitgeneric');
    expect(parseVmt(`"patch" { "include" "a\\B.vmt" }`, read).shader).toBe('unlitgeneric');
  });

  it('reports a missing include and keeps the patch params', () => {
    const v = parseVmt(`"patch" { "include" "materials/concrete/concretefloor039a.vmt" "insert" { "$envmap" "c" } }`, () => null);
    expect(v.shader).toBe('patch');
    expect(v.includeMissing).toBe('materials/concrete/concretefloor039a.vmt');
    expect(v.params['$envmap']).toBe('c');
  });

  it('stops include cycles', () => {
    const files: Record<string, string> = {
      'materials/a.vmt': `"patch" { "include" "materials/b.vmt" }`,
      'materials/b.vmt': `"patch" { "include" "materials/a.vmt" }`,
    };
    const v = parseVmt(files['materials/a.vmt'], (p) => files[normalizePakPath(p)] ?? null);
    expect(v.shader).toBe('patch');
    expect(v.includeMissing).toBeDefined();
  });

  it('parses values', () => {
    expect(vmtBool('1')).toBe(true);
    expect(vmtBool('0')).toBe(false);
    expect(vmtBool(' .5 ')).toBe(true);
    expect(vmtBool(undefined)).toBe(false);
    expect(vmtBool('true')).toBe(true);
    expect(vmtNumber('.75', 1)).toBe(0.75);
    expect(vmtNumber('abc', 1)).toBe(1);
    expect(vmtVector('{24 38 53}')!.map((x) => Math.round(x * 255))).toEqual([24, 38, 53]);
    expect(vmtVector('[ .95 1.0 .97 ]')).toEqual([0.95, 1, 0.97]);
    expect(vmtVector('[1 2]', 2)).toEqual([1, 2]);
    expect(vmtVector('0.5')).toEqual([0.5, 0.5, 0.5]);
    expect(vmtVector('[a b c]')).toBeNull();
  });

  it('parses texture transforms', () => {
    const m = parseTextureTransform('center 0 0 scale 1 2 rotate 0 translate 0 0')!;
    expect(m.map((x) => +x.toFixed(6))).toEqual([1, 0, 0, 0, 2, 0]);
    const s = parseTextureTransform('center .5 .5 scale 2 2 rotate 0 translate 0 0')!;
    // u' = 2u - 0.5
    expect(s[0] * 0.5 + s[1] * 0.5 + s[2]).toBeCloseTo(0.5);
    expect(s[0] * 1 + s[2]).toBeCloseTo(1.5);
    const r = parseTextureTransform('center .5 .5 scale 1 1 rotate 90 translate 0 0')!;
    // rotating (1, 0.5) by 90° around the centre gives (0.5, 1)
    expect(r[0] * 1 + r[1] * 0.5 + r[2]).toBeCloseTo(0.5);
    expect(r[3] * 1 + r[4] * 0.5 + r[5]).toBeCloseTo(1);
    const t = parseTextureTransform('translate .25 0')!;
    expect(t[2]).toBeCloseTo(0.25);
    expect(parseTextureTransform('garbage')).toBeNull();
  });
});

// ============================================================================ names, families, fallbacks

describe('material names and families', () => {
  it('normalizes material and texture names', () => {
    expect(normalizeMaterialName('CONCRETE/CONCRETEWALL011')).toBe('concrete/concretewall011');
    expect(normalizeMaterialName('materials\\Water\\water_well_beneath.vmt')).toBe('water/water_well_beneath');
    expect(normalizeMaterialName('/materials/a/b.VMT')).toBe('a/b');
    expect(normalizeMaterialName('maps/surf_x/glass/glasswindow001a_5120_0_-2048')).toBe('maps/surf_x/glass/glasswindow001a_5120_0_-2048');
    expect(normalizeTextureName('Concrete\\Wall01.vtf')).toBe('concrete/wall01');
  });

  it('classifies stock material names into families', () => {
    const cases: [string, string][] = [
      ['CONCRETE/CONCRETEWALL011', 'concrete'],
      ['concrete/concretefloor008a', 'concrete'],
      ['cs_italy/plasterwall01', 'plaster'],
      ['metal/metalhull010b', 'metal'],
      ['de_piranesi/pi_grnmetalt', 'metal'],
      ['cs_havana/woodm', 'wood'],
      ['wood/milflr003', 'wood'],
      ['de_chateau/intbrickk', 'brick'],
      ['tile/tilefloor016a', 'tile'],
      ['de_dust/rockwall01', 'stone'],
      ['cs_italy/stonewall02', 'stonewall'],
      ['nature/sandfloor010a', 'sand'],
      ['cs_havana/ground01grass', 'grass'],
      ['nature/dirtfloor005b', 'dirt'],
      ['nature/mudfloor005a', 'dirt'],
      ['de_piranesi/marblefloor06', 'marble'],
      ['props/carpetfloor008a', 'carpet'],
      ['glass/glasswindow007a', 'glass'],
      ['metal/metalgrate013b', 'grate'],
      ['metal/metalfence001a', 'fence'],
      ['halflife/{ladder2', 'ladder'],
      ['dev/dev_water2', 'water'],
      ['dev/dev_measuregeneric01', 'dev'],
      ['lights/white001', 'light'],
      ['cs_havana/white', 'flat'],
      ['kiiru/colors/color1', 'flat'],
      ['effects/combine_binocoverlay', 'generic'],
      ['de_cbble/grassdirt_blend', 'grass'],
      ['maps/surf_x/glass/glasswindow070a_0_-8192_3360', 'glass'],
      ['liquids/water_pretty1', 'water'],
      ['lights/white_neon', 'light'],
      ['nature/infblendgrassdirt001a', 'grass'],
      ['stone/stonewall050d', 'stonewall'],
      ['de_train/train_metalceiling_02', 'metal'],
      ['dev/dev_tvmonitornonoise', 'dev'],
      ['builtin/ramp_cyan', 'ramp'],
      ['builtin/wall_grid', 'grid'],
      ['builtin/floor_dark', 'floor'],
      ['builtin/glow_green', 'glow'],
    ];
    for (const [n, fam] of cases) expect([n, classifyMaterial(n)]).toEqual([n, fam]);
  });

  it('procedural images: average colour equals the target, tileable and deterministic', () => {
    const fams = ['concrete', 'plaster', 'metal', 'wood', 'brick', 'tile', 'stone', 'stonewall', 'grass', 'dirt', 'sand', 'marble', 'carpet', 'dev', 'light', 'water', 'flat', 'generic', 'grid', 'ramp', 'floor', 'wall', 'glow'] as const;
    for (const family of fams) {
      for (const color of [
        [0.5, 0.45, 0.4],
        [0.1, 0.12, 0.08],
        [0.93, 0.9, 0.88],
      ] as [number, number, number][]) {
        const img = generateProceduralImage({ family, color, seed: 1234, width: 128, height: 128 });
        const avg = imageAverage(img);
        for (let c = 0; c < 3; c++) expect(Math.abs(avg[c] - color[c]) * 255, `${family} ch${c}`).toBeLessThan(1.5);
        expect(img.hasAlpha).toBe(false);
      }
    }
    const a = generateProceduralImage({ family: 'brick', color: [0.5, 0.3, 0.2], seed: 42 });
    const b = generateProceduralImage({ family: 'brick', color: [0.5, 0.3, 0.2], seed: 42 });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    // Has visible structure (not flat).
    let min = 255;
    let max = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      min = Math.min(min, a.data[i]);
      max = Math.max(max, a.data[i]);
    }
    expect(max - min).toBeGreaterThan(30);
  });

  it('procedural noise tiles seamlessly (edge rows/columns are continuous)', () => {
    for (const family of ['concrete', 'grass', 'stone', 'marble', 'sand'] as const) {
      const img = generateProceduralImage({ family, color: [0.5, 0.5, 0.5], seed: 9, width: 128, height: 128 });
      // Compare the wrap-around difference against the typical neighbour difference.
      let wrap = 0;
      let inner = 0;
      for (let y = 0; y < 128; y++) {
        wrap += Math.abs(px(img, 127, y)[1] - px(img, 0, y)[1]);
        inner += Math.abs(px(img, 63, y)[1] - px(img, 64, y)[1]);
      }
      expect(wrap, family).toBeLessThan(inner * 2.5 + 128);
    }
  });

  it('alpha families: glass is translucent, grates are alpha-tested; average over opaque pixels', () => {
    const g = generateProceduralImage({ family: 'glass', color: [0.3, 0.4, 0.45], seed: 1 });
    expect(g.hasAlpha).toBe(true);
    let asum = 0;
    for (let i = 3; i < g.data.length; i += 4) asum += g.data[i];
    expect(asum / (g.data.length / 4) / 255).toBeGreaterThan(0.25);
    expect(asum / (g.data.length / 4) / 255).toBeLessThan(0.55);
    for (const family of ['grate', 'fence', 'ladder'] as const) {
      const img = generateProceduralImage({ family, color: [0.4, 0.42, 0.45], seed: 3 });
      expect(img.hasAlpha).toBe(true);
      let opaque = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        expect(img.data[i] === 0 || img.data[i] === 255).toBe(true);
        if (img.data[i] === 255) opaque++;
      }
      expect(opaque).toBeGreaterThan(0);
      expect(opaque).toBeLessThan(img.data.length / 4);
      const avg = imageAverage(img);
      expect(Math.abs(avg[0] - 0.4) * 255).toBeLessThan(1.5);
    }
  });

  it('fallbackMaterial: colour from reflectivity (linear → sRGB), flags from the name', () => {
    const refl = { x: 0.486, y: 0.431, z: 0.376 };
    const m = fallbackMaterial('CONCRETE/CONCRETEWALL011', refl, 1024, 1024);
    expect(m.name).toBe('concrete/concretewall011');
    expect(m.width).toBe(1024);
    const expected = reflectivityToSrgb(refl);
    expect(m.fallbackColor[0]).toBeCloseTo(expected[0], 6);
    expect(expected[0]).toBeCloseTo(linearToSrgb(0.486), 6);
    expect(m.image).not.toBeNull();
    expect(isProceduralImage(m.image)).toBe(true);
    const avg = imageAverage(m.image!);
    for (let c = 0; c < 3; c++) expect(Math.abs(avg[c] - expected[c]) * 255).toBeLessThan(1.5);
    expect(m.translucent || m.unlit || m.isTool || m.isSky || m.isWater).toBe(false);

    expect(fallbackMaterial('tools/toolsnodraw').isTool).toBe(true);
    expect(fallbackMaterial('TOOLS/TOOLSPLAYERCLIP').isTool).toBe(true);
    expect(fallbackMaterial('tools/toolsskybox').isSky).toBe(true);
    expect(fallbackMaterial('tools/toolsskybox').isTool).toBe(false);
    const black = fallbackMaterial('tools/toolsblack');
    expect(black.isTool).toBe(false);
    expect(black.unlit).toBe(true);
    expect(black.fallbackColor).toEqual([0, 0, 0]);
    expect(fallbackMaterial('skybox/sky_day01_01rt').isSky).toBe(true);
    const glass = fallbackMaterial('glass/glasswindow007a', { x: 0.18, y: 0.19, z: 0.2 });
    expect(glass.translucent).toBe(true);
    expect(glass.image!.hasAlpha).toBe(true);
    const grate = fallbackMaterial('metal/metalgrate013b');
    expect(grate.alphaTest).toBe(true);
    const light = fallbackMaterial('lights/white001', { x: 0, y: 0, z: 0 });
    expect(light.unlit).toBe(true);
    expect(light.fallbackColor[0]).toBeGreaterThan(0.9);
    const water = fallbackMaterial('nature/water_coast01');
    expect(water.isWater).toBe(true);
    expect(water.translucent).toBe(true);
    expect(water.alpha).toBeLessThan(1);
    expect(water.waterFogColor).not.toBeNull();
    // vbsp's neutral 0.2 grey reflectivity for water means "unknown": a blue-green is used instead.
    const grey = fallbackMaterial('dev/dev_water2', { x: 0.2, y: 0.2, z: 0.2 });
    expect(grey.isWater).toBe(true);
    expect(grey.fallbackColor[2]).toBeGreaterThan(grey.fallbackColor[0] + 0.1);
    expect(fallbackMaterial('decals/trashdecal01a').isTool).toBe(true);
    const spr = fallbackMaterial('sprites/light_glow03');
    expect([spr.translucent, spr.additive, spr.unlit]).toEqual([true, true, true]);
    expect(px(spr.image!, 32, 32)[3]).toBeGreaterThan(200);
    expect(px(spr.image!, 0, 0)[3]).toBe(0);
    expect(classifyMaterial('effects/lensflare01')).toBe('sprite');
    // Deterministic
    expect(Buffer.from(fallbackMaterial('a/b').image!.data).equals(Buffer.from(fallbackMaterial('A\\B').image!.data))).toBe(true);
  });

  it('fallbackMaterial: built-in names pick colour and pattern words', () => {
    const r = fallbackMaterial('builtin/ramp_cyan');
    expect(r.pattern).toBe('ramp');
    const avg = imageAverage(r.image!);
    expect(avg[2]).toBeGreaterThan(avg[0] + 0.3);
    expect(Math.abs(avg[1] - r.fallbackColor[1]) * 255).toBeLessThan(1.5);
    const g = fallbackMaterial('builtin/glow_green');
    expect(g.pattern).toBe('glow');
    expect(g.unlit).toBe(true);
    expect(g.fallbackColor[1]).toBeGreaterThan(g.fallbackColor[0]);
    expect(fallbackMaterial('builtin/floor_dark').pattern).toBe('floor');
    expect(fallbackMaterial('builtin/floor_dark').fallbackColor[0]).toBeLessThan(0.25);
    expect(fallbackMaterial('builtin/wall_grid').pattern).toBe('grid');
    for (const c of ['blue', 'red', 'orange', 'purple', 'pink', 'yellow', 'white', 'grey']) {
      const m = fallbackMaterial(`builtin/ramp_${c}`);
      expect(m.image).not.toBeNull();
      expect(m.unlit).toBe(false);
    }
  });

  it.skipIf(!DUMP)('dumps one image per family (SURF_DUMP_DIR)', () => {
    const fams = ['concrete', 'plaster', 'metal', 'wood', 'brick', 'tile', 'stone', 'stonewall', 'grass', 'dirt', 'sand', 'marble', 'carpet', 'glass', 'grate', 'fence', 'ladder', 'dev', 'light', 'water', 'flat', 'generic', 'grid', 'ramp', 'floor', 'wall', 'glow'] as const;
    const colors: Record<string, [number, number, number]> = { grass: [0.3, 0.42, 0.18], dirt: [0.42, 0.33, 0.24], sand: [0.74, 0.65, 0.48], brick: [0.56, 0.32, 0.25], wood: [0.5, 0.36, 0.23], water: [0.16, 0.3, 0.36], dev: [0.85, 0.5, 0.15] };
    fams.forEach((family, k) => {
      const img = generateProceduralImage({ family, color: colors[family] ?? [0.55, 0.53, 0.5], seed: 77, name: family });
      dump(`family_${String(k).padStart(2, '0')}_${family}`, img);
    });
  });

  it.skipIf(!DUMP)('dumps built-in map materials (SURF_DUMP_DIR)', () => {
    const names = ['ramp_cyan', 'ramp_orange', 'ramp_purple', 'floor_dark', 'floor_grey', 'wall_grid', 'wall_blue', 'glow_green', 'glow_red', 'grid_white', 'ramp_pink', 'wall_dark'];
    names.forEach((n, k) => dump(`builtin_${String(k).padStart(2, '0')}_${n}`, fallbackMaterial(`builtin/${n}`).image));
  });

  it('procedural images match non-square texture aspect', () => {
    const m = fallbackMaterial('concrete/x', undefined, 1024, 256);
    expect(m.image!.width / m.image!.height).toBe(4);
  });

  it('plain stand-ins have fine detail but no large low-frequency blotches (they read as fog when tiled)', () => {
    // Luma statistics: per-pixel spread (detail) vs the spread of 32x32 block means (blotches), both relative
    // to the mean. Stock textures' variation is mostly fine-scale; low-frequency clouds look like fog/dirt.
    const stats = (img: DecodedImage) => {
      const { width: W, height: H, data } = img;
      const lum = new Float64Array(W * H);
      for (let i = 0; i < W * H; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
      const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
      const sd = (xs: ArrayLike<number>) => {
        let m = 0;
        for (let i = 0; i < xs.length; i++) m += xs[i];
        m /= xs.length;
        let v = 0;
        for (let i = 0; i < xs.length; i++) v += (xs[i] - m) ** 2;
        return Math.sqrt(v / xs.length);
      };
      const B = 32;
      const blocks: number[] = [];
      for (let by = 0; by < H; by += B)
        for (let bx = 0; bx < W; bx += B) {
          let s = 0;
          for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) s += lum[y * W + x];
          blocks.push(s / (B * B));
        }
      return { detail: sd(lum) / mean, blotch: sd(blocks) / mean };
    };
    const cases: [string, number][] = [
      ['concrete/concretewall006a', 0.02],
      ['concrete/concretefloor007a', 0.02],
      ['de_prodigy/ceiling01', 0.02],
      ['concrete/concrete_a', 0.02],
      ['cs_italy/plasterwall01', 0.012],
      ['custom/something', 0.02],
      ['nature/dirtfloor005', 0.02],
      ['nature/grass001', 0.025],
      ['nature/sandfloor010a', 0.012],
      ['nature/rockwall001', 0.045],
    ];
    for (const [name, maxBlotch] of cases) {
      const fam = classifyMaterial(name);
      const img = generateProceduralImage({ family: fam, color: [0.5, 0.48, 0.45], seed: hashString(name), width: 256, height: 256, name });
      const s = stats(img);
      expect(s.detail, `${name} (${fam}) detail`).toBeGreaterThan(0.015);
      expect(s.blotch, `${name} (${fam}) blotches`).toBeLessThan(maxBlotch);
      expect(s.blotch / s.detail, `${name} (${fam}) low-frequency share`).toBeLessThan(0.5);
    }
  });
});

// ============================================================================ buildMaterials (synthetic)

function vtfSolid(w: number, h: number, rgba: number[], format = VtfFormat.RGBA8888, frames = 1): Uint8Array {
  return buildVtf({
    width: w,
    height: h,
    format,
    frames,
    image: (m, ww, hh, f) => {
      const c = [...rgba];
      c[0] = Math.min(255, c[0] + f * 20);
      if (format === VtfFormat.RGBA8888) return solidRgba(ww, hh, c);
      if (format === VtfFormat.BGRA8888) return solidRgba(ww, hh, [c[2], c[1], c[0], c[3]]);
      throw new Error('fmt');
    },
  });
}

describe('buildMaterials (synthetic map)', () => {
  const pakFiles: Record<string, string | Uint8Array> = {
    'materials/custom/wall.vmt': `"LightmappedGeneric" { "$basetexture" "Custom\\Wall" "$detail" "detail/noise" "$detailscale" "4" "$detailblendfactor" ".5" }`,
    'materials/custom/wall.vtf': vtfSolid(8, 8, [100, 150, 200, 255]),
    'materials/detail/noise.vtf': vtfSolid(4, 4, [128, 128, 128, 255]),
    'materials/custom/neon.vmt': `"UnlitGeneric" { "$basetexture" "custom/neon" "$alpha" ".75" "$additive" 1 }`,
    'materials/custom/neon.vtf': vtfSolid(4, 4, [0, 255, 0, 255]),
    'materials/custom/fence.vmt': `"LightmappedGeneric" { "$basetexture" "custom/fence" "$alphatest" 1 "$alphatestreference" ".3" "$nocull" 1 }`,
    'materials/custom/fence.vtf': vtfSolid(4, 4, [50, 50, 50, 0]),
    'materials/custom/masked.vmt': `"LightmappedGeneric" { "$basetexture" "custom/masked" "$selfillum" 1 }`,
    'materials/custom/masked.vtf': vtfSolid(4, 4, [200, 10, 10, 30]),
    'materials/custom/scroll.vmt': `"UnlitGeneric" { "$basetexture" "custom/neon" "Proxies" { "TextureScroll" { "texturescrollvar" "$baseTextureTransform" "texturescrollrate" 2 "texturescrollangle" 90 } } }`,
    'materials/custom/tinted.vmt': `"LightmappedGeneric" { "$basetexture" "custom/wall" "$color" "[1 0.5 0]" "$basetexturetransform" "center .5 .5 scale 2 2 rotate 0 translate 0 0" }`,
    'materials/custom/anim.vmt': `"UnlitGeneric" { "$basetexture" "custom/anim" "Proxies" { "AnimatedTexture" { "animatedtexturevar" "$basetexture" "animatedtextureframenumvar" "$frame" "animatedtextureframerate" 12 } } }`,
    'materials/custom/anim.vtf': vtfSolid(4, 4, [10, 20, 30, 255], VtfFormat.RGBA8888, 4),
    'materials/custom/blend.vmt': `"WorldVertexTransition" { "$basetexture" "custom/wall" "$basetexture2" "nature/grass_stock" }`,
    'materials/custom/water.vmt': `"Water" { "%compilewater" 1 "$fogcolor" "{24 38 53}" "$fogstart" "1" "$fogend" "300" "$normalmap" "dev/water_normal" "$envmap" "env_cubemap" }`,
    'materials/custom/water2.vmt': `"LightmappedGeneric" { "%compilewater" 1 "$fogcolor" "[0.1 0.2 0.3]" }`,
    'materials/custom/clip.vmt': `"LightmappedGeneric" { "$basetexture" "custom/wall" "%compileclip" 1 }`,
    'materials/custom/sky.vmt': `"LightmappedGeneric" { "%compilesky" 1 }`,
    'materials/custom/stockbase.vmt': `"LightmappedGeneric" { "$basetexture" "concrete/concretefloor039a" }`,
    'materials/custom/glassy.vmt': `"LightmappedGeneric" { "$basetexture" "glass/stockglass" "$translucent" 1 }`,
    'materials/glass/glasswindow001a.vmt': `"LightmappedGeneric" { "$baseTexture" "custom/wall" "$translucent" 1 }`,
    'materials/maps/m/glass/glasswindow001a_1_2_3.vmt': `"patch" { "include" "materials/GLASS/GLASSWINDOW001A.vmt" "replace" { "$envmap" "maps/m/c1_2_3" } }`,
    'materials/maps/m/metal/citadel_metalwall072a_1_2_3.vmt': `"patch" { "include" "materials/metal/citadel_metalwall072a.vmt" "replace" { "$envmap" "maps/m/c1_2_3" } }`,
    'materials/tools/toolsnodraw.vmt': `"LightmappedGeneric" { "$basetexture" "tools/toolsnodraw" "%compilenodraw" 1 }`,
    'materials/tools/toolsnodraw.vtf': vtfSolid(4, 4, [255, 200, 0, 255]),
    'materials/custom/shiny.vmt': `"LightmappedGeneric" { "$basetexture" "custom/masked" "$envmap" "env_cubemap" "$envmaptint" "[.5 .25 1]" "$basealphaenvmapmask" 1 "$envmapcontrast" 1 "$envmapsaturation" "[.5 .5 .5]" }`,
    'materials/custom/shinymask.vmt': `"LightmappedGeneric" { "$basetexture" "custom/wall" "$envmap" "Maps\\M\\c1_2_3" "$envmapmask" "custom/neon" }`,
    'materials/custom/shinynormal.vmt': `"LightmappedGeneric" { "$basetexture" "custom/wall" "$envmap" "env_cubemap" "$bumpmap" "custom/masked" "$normalmapalphaenvmapmask" 1 "$fresnelreflection" ".3" }`,
    'materials/custom/modulate.vmt': `"DecalModulate" { "$basetexture" "custom/modulate" "$decal" 1 }`,
    'materials/custom/modulate.vtf': buildVtf({ width: 2, height: 1, format: VtfFormat.RGBA8888, image: () => new Uint8Array([128, 128, 128, 255, 0, 0, 0, 255]) }),
    'materials/custom/decal.vmt': `"LightmappedGeneric" { "$basetexture" "custom/fence" "$decal" 1 }`,
    'materials/custom/refract.vmt': `"Refract" { "$normalmap" "x/y" "$refracttint" "[0.9 0.95 1]" "Proxies" { "TextureScroll" { "texturescrollvar" "$bumpTransform" "texturescrollrate" 1.3 "texturescrollangle" 270 } } }`,
  };
  const mats = [
    { name: 'CUSTOM/WALL', refl: [0.3, 0.3, 0.3] as [number, number, number] },
    { name: 'custom/neon' },
    { name: 'custom/fence' },
    { name: 'custom/masked' },
    { name: 'custom/scroll' },
    { name: 'custom/tinted' },
    { name: 'custom/anim' },
    { name: 'custom/blend' },
    { name: 'custom/water' },
    { name: 'custom/water2' },
    { name: 'custom/clip' },
    { name: 'custom/sky' },
    { name: 'custom/stockbase', refl: [0.184, 0.174, 0.153] as [number, number, number] },
    { name: 'custom/glassy' },
    { name: 'maps/m/glass/glasswindow001a_1_2_3' },
    { name: 'maps/m/metal/citadel_metalwall072a_1_2_3', refl: [0.2, 0.21, 0.22] as [number, number, number] },
    { name: 'TOOLS/TOOLSNODRAW', flags: SURF_NODRAW },
    { name: 'tools/toolstrigger', flags: SURF_TRIGGER | SURF_NOLIGHT },
    { name: 'TOOLS/TOOLSSKYBOX', flags: SURF_SKY | SURF_NOLIGHT },
    { name: 'tools/toolsblack' },
    { name: 'lights/white001', refl: [0, 0, 0] as [number, number, number], flags: SURF_NOLIGHT },
    { name: 'colour/neon/red_neon', refl: [0.9, 0.05, 0.05] as [number, number, number], flags: SURF_NOLIGHT },
    { name: 'dev/dev_waterbeneath2', flags: SURF_WARP | SURF_NOLIGHT },
    { name: 'nature/mystery_surface', flags: SURF_WARP | SURF_NOLIGHT },
    { name: 'effects/combine_binocoverlay', flags: SURF_TRANS | SURF_NOLIGHT, refl: [0.094, 0.245, 0.217] as [number, number, number] },
    { name: 'stock/odd_name', refl: [0.1, 0.2, 0.3] as [number, number, number] },
    { name: 'stock/on_water_brush' },
    { name: 'custom/wall' }, // duplicate (different case) → one entry
    { name: 'water/water_well_beneath.vmt' },
    { name: 'decals/trashdecal01a' },
    { name: 'custom/custom_sky_flag', flags: SURF_SKY },
    { name: 'custom/refract' },
    { name: 'maps/m/fake_trigger_name', flags: SURF_TRIGGER },
    { name: 'custom/modulate' },
    { name: 'custom/decal' },
    { name: 'custom/shiny' },
    { name: 'custom/shinymask' },
    { name: 'custom/shinynormal' },
  ];
  const bsp = makeBsp(mats, [26]);
  const pak = makePak(pakFiles);
  const M = buildMaterials(bsp, pak);
  const get = (n: string): MaterialDef => {
    const m = M.get(n);
    if (!m) throw new Error(`missing material ${n}`);
    return m;
  };

  it('creates one entry per normalized texdata name', () => {
    expect(M.size).toBe(mats.length - 1);
    expect(M.has('custom/wall')).toBe(true);
    expect(M.has('water/water_well_beneath')).toBe(true);
    for (const [k, v] of M) expect(v.name).toBe(k);
    const stats = lastMaterialStats()!;
    expect(stats.total).toBe(M.size);
    expect(stats.withImage).toBeGreaterThan(5);
  });

  it('decodes packed base textures and detail textures', () => {
    const w = get('custom/wall');
    expect(w.shader).toBe('lightmappedgeneric');
    expect(w.image).not.toBeNull();
    expect(isProceduralImage(w.image)).toBe(false);
    expect(px(w.image!, 0, 0)).toEqual([100, 150, 200, 255]);
    expect(w.fallbackColor.map((c) => Math.round(c * 255))).toEqual([100, 150, 200]);
    expect(w.width).toBe(512);
    expect(w.detail).toBeDefined();
    expect(w.detail!.scale).toEqual([4, 4]);
    expect(w.detail!.blendFactor).toBe(0.5);
    expect(w.detail!.blendMode).toBe(0);
    expect(w.translucent || w.unlit || w.alphaTest || w.isTool).toBe(false);
  });

  it('reads translucency, additive, alpha, alpha test, nocull, unlit/selfillum', () => {
    const n = get('custom/neon');
    expect(n.unlit).toBe(true);
    expect(n.alpha).toBe(0.75);
    expect(n.translucent).toBe(true);
    expect(n.additive).toBe(true);
    const f = get('custom/fence');
    expect(f.alphaTest).toBe(true);
    expect(f.alphaTestRef).toBeCloseTo(0.3);
    expect(f.noCull).toBe(true);
    expect(f.image!.hasAlpha).toBe(true);
    const m = get('custom/masked');
    expect(m.unlit).toBe(true);
    // Opaque material: alpha is a mask, not transparency.
    expect(m.image!.hasAlpha).toBe(false);
    expect(m.translucent).toBe(false);
  });

  it('reads TextureScroll, $color tint, $basetexturetransform and AnimatedTexture', () => {
    const s = get('custom/scroll');
    expect(s.scroll![0]).toBeCloseTo(0);
    expect(s.scroll![1]).toBeCloseTo(2);
    expect(get('custom/wall').scroll).toBeNull();
    const t = get('custom/tinted');
    expect(px(t.image!, 0, 0)).toEqual([100, 75, 0, 255]);
    expect(get('custom/wall').image!.data[1]).toBe(150); // shared texture not modified
    expect(t.textureTransform).toBeDefined();
    expect(t.textureTransform![0]).toBeCloseTo(2);
    const a = get('custom/anim');
    expect(a.frames!.length).toBe(4);
    expect(a.frameRate).toBe(12);
    expect(a.image).toBe(a.frames![0]);
    expect(px(a.frames![3], 0, 0)[0]).toBe(70);
  });

  it('WorldVertexTransition: second texture (procedural when not packed)', () => {
    const b = get('custom/blend');
    expect(b.shader).toBe('worldvertextransition');
    expect(px(b.image!, 0, 0)).toEqual([100, 150, 200, 255]);
    expect(b.image2).toBeDefined();
    expect(isProceduralImage(b.image2!)).toBe(true);
    expect(b.fallbackColor2).toBeDefined();
  });

  it('water: shader or %compilewater, fog colour in both notations, SURF_WARP fallback', () => {
    const w = get('custom/water');
    expect(w.isWater).toBe(true);
    expect(w.waterFogColor!.map((c) => Math.round(c * 255))).toEqual([24, 38, 53]);
    expect(w.waterFogRange).toEqual([1, 300]);
    expect(get('custom/water2').waterFogRange).toBeUndefined();
    expect(w.image).not.toBeNull();
    expect(w.isTool).toBe(false);
    const w2 = get('custom/water2');
    expect(w2.isWater).toBe(true);
    expect(w2.waterFogColor![1]).toBeCloseTo(0.2);
    const b = get('dev/dev_waterbeneath2');
    expect(b.isWater).toBe(true);
    expect(b.unlit).toBe(false);
    expect(get('nature/mystery_surface').isWater).toBe(true);
    expect(get('stock/on_water_brush').isWater).toBe(true);
    expect(get('water/water_well_beneath').isWater).toBe(true);
  });

  it('tools and sky', () => {
    expect(get('custom/clip').isTool).toBe(true);
    expect(get('custom/clip').image).toBeNull();
    expect(get('custom/sky').isSky).toBe(true);
    expect(get('tools/toolsnodraw').isTool).toBe(true);
    expect(get('tools/toolsnodraw').image).toBeNull();
    expect(get('tools/toolstrigger').isTool).toBe(true);
    expect(get('tools/toolsskybox').isSky).toBe(true);
    expect(get('tools/toolsskybox').isTool).toBe(false);
    expect(get('custom/custom_sky_flag').isSky).toBe(true);
    expect(get('maps/m/fake_trigger_name').isTool).toBe(true);
    const black = get('tools/toolsblack');
    expect(black.isTool).toBe(false);
    expect(black.unlit).toBe(true);
    expect(black.fallbackColor).toEqual([0, 0, 0]);
    expect(get('decals/trashdecal01a').isTool).toBe(true);
  });

  it('missing textures get procedural images named after the texture, coloured by reflectivity', () => {
    const s = get('custom/stockbase');
    expect(s.image).not.toBeNull();
    expect(isProceduralImage(s.image)).toBe(true);
    const exp = reflectivityToSrgb({ x: 0.184, y: 0.174, z: 0.153 });
    const avg = imageAverage(s.image!);
    for (let c = 0; c < 3; c++) expect(Math.abs(avg[c] - exp[c]) * 255).toBeLessThan(1.5);
    expect(s.image!.hasAlpha).toBe(false);
    const g = get('custom/glassy');
    expect(g.translucent).toBe(true);
    expect(g.image!.hasAlpha).toBe(true);
  });

  it('cubemap patch materials resolve through the include; missing includes use the include name', () => {
    const g = get('maps/m/glass/glasswindow001a_1_2_3');
    expect(g.shader).toBe('lightmappedgeneric');
    expect(g.translucent).toBe(true);
    expect(isProceduralImage(g.image)).toBe(false);
    const m = get('maps/m/metal/citadel_metalwall072a_1_2_3');
    expect(isProceduralImage(m.image)).toBe(true);
    // The cubemap patch proves the stock material reflects: kept with a metal-like tint.
    expect(m.envmap!.cubemap).toBe('maps/m/c1_2_3');
    expect(m.envmap!.tint[0]).toBeCloseTo(0.3);
    expect(m.isTool || m.translucent).toBe(false);
    const exp = reflectivityToSrgb({ x: 0.2, y: 0.21, z: 0.22 });
    expect(m.fallbackColor[2]).toBeCloseTo(exp[2], 6);
  });

  it('texinfo hints for missing VMTs: SURF_NOLIGHT → unlit, SURF_TRANS → translucent', () => {
    const l = get('lights/white001');
    expect(l.unlit).toBe(true);
    expect(l.isTool).toBe(false);
    expect(l.fallbackColor[0]).toBeGreaterThan(0.9);
    const n = get('colour/neon/red_neon');
    expect(n.unlit).toBe(true);
    expect(n.fallbackColor[0]).toBeGreaterThan(n.fallbackColor[1]);
    const e = get('effects/combine_binocoverlay');
    expect(e.translucent).toBe(true);
    expect(e.unlit).toBe(true);
    const o = get('stock/odd_name');
    expect(o.unlit || o.translucent || o.isWater || o.isTool).toBe(false);
  });

  it('refract shader: translucent tinted pane scrolling with the bump transform', () => {
    const r = get('custom/refract');
    expect(r.translucent).toBe(true);
    expect(r.alpha).toBeLessThan(1);
    expect(r.scroll![1]).toBeCloseTo(-1.3);
    expect(r.image).not.toBeNull();
  });

  it('$envmap reflection parameters and masks', () => {
    expect(get('custom/wall').envmap).toBeUndefined();
    const a = get('custom/shiny').envmap!;
    expect(a.cubemap).toBe('env_cubemap');
    expect(a.tint).toEqual([0.5, 0.25, 1]);
    expect(a.mask).toBe('basealpha');
    expect(a.contrast).toBe(1);
    expect(a.saturation).toBe(0.5);
    expect(a.fresnel).toBe(1);
    // The base alpha (the mask) survives in the data even though the opaque material reports hasAlpha=false.
    expect(get('custom/shiny').image!.hasAlpha).toBe(false);
    expect(px(get('custom/shiny').image!, 0, 0)[3]).toBe(30);
    const b = get('custom/shinymask').envmap!;
    expect(b.cubemap).toBe('maps/m/c1_2_3');
    expect(b.mask).toBe('texture');
    expect(px(b.maskImage!, 0, 0)).toEqual([0, 255, 0, 255]);
    const c = get('custom/shinynormal').envmap!;
    expect(c.mask).toBe('normalalpha');
    expect(px(c.maskImage!, 0, 0)).toEqual([30, 30, 30, 255]);
    expect(c.fresnel).toBeCloseTo(0.3);
    expect(get('custom/water').envmap).toBeUndefined(); // water reflections are the renderer's own
  });

  it('decals: $decal with alpha is translucent; DecalModulate becomes black with alpha = 1 - 2·src', () => {
    expect(get('custom/decal').translucent).toBe(true);
    const m = get('custom/modulate');
    expect(m.translucent).toBe(true);
    expect(px(m.image!, 0, 0)[3]).toBeLessThanOrEqual(1); // grey 128 → (almost) no change
    expect(px(m.image!, 1, 0)).toEqual([0, 0, 0, 255]); // black → fully darkening
  });

  it('works without a pakfile and with an extra source', () => {
    const none = buildMaterials(makeBsp([{ name: 'concrete/x' }, { name: 'tools/toolsclip' }]), null);
    expect(none.get('concrete/x')!.image).not.toBeNull();
    expect(none.get('tools/toolsclip')!.isTool).toBe(true);
    const extra = mapFileSource(
      new Map([
        ['materials/Concrete/X.vmt', te.encode('"LightmappedGeneric" { "$basetexture" "concrete/x" }')],
        ['materials/concrete/x.vtf', vtfSolid(4, 4, [1, 2, 3, 255])],
      ]),
    );
    const withExtra = buildMaterials(makeBsp([{ name: 'concrete/x' }]), null, { extraSources: [extra] });
    expect(px(withExtra.get('concrete/x')!.image!, 0, 0)).toEqual([1, 2, 3, 255]);
  });

  it('respects maxTextureSize and caches shared textures', () => {
    const big = makePak({
      'materials/a.vmt': '"LightmappedGeneric" { "$basetexture" "t" }',
      'materials/b.vmt': '"LightmappedGeneric" { "$basetexture" "T" }',
      'materials/t.vtf': buildVtf({ width: 64, height: 64, format: VtfFormat.DXT1, mips: 7, image: (m, w, h) => dxt1Solid(w, h, 0xffff) }),
    });
    const res = buildMaterials(makeBsp([{ name: 'a' }, { name: 'b' }]), big, { maxTextureSize: 16 });
    expect(res.get('a')!.image!.width).toBe(16);
    expect(res.get('a')!.image!.data).toBe(res.get('b')!.image!.data);
  });

  it('compressedTextures mode attaches DXT mips; tinted materials fall back to full RGBA', () => {
    const files = {
      'materials/c/a.vmt': '"LightmappedGeneric" { "$basetexture" "c/t" }',
      'materials/c/b.vmt': '"LightmappedGeneric" { "$basetexture" "c/t" "$color" "[1 0 0]" }',
      'materials/c/t.vtf': buildVtf({ width: 64, height: 64, format: VtfFormat.DXT1, mips: 7, image: (m, w, h) => dxt1Solid(w, h, 0xffff) }),
    };
    const res = buildMaterials(makeBsp([{ name: 'c/a' }, { name: 'c/b' }]), makePak(files), { compressedTextures: true, rgbaFallbackSize: 16 });
    const a = res.get('c/a')!;
    expect(a.image!.width).toBe(16);
    expect(a.image!.compressed!.format).toBe('dxt1');
    expect(a.image!.compressed!.width).toBe(64);
    expect(lastMaterialStats()!.compressedBytes).toBeGreaterThan(0);
    const b = res.get('c/b')!;
    expect(b.image!.compressed).toBeUndefined();
    expect(b.image!.width).toBe(64);
    expect(px(b.image!, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('computeSurfaceHints aggregates texinfo flags and water brushes', () => {
    const h = computeSurfaceHints(bsp);
    expect(h[16].andFlags & SURF_NODRAW).toBeTruthy();
    expect(h[26].onWaterBrush).toBe(true);
    expect(h[0].onWaterBrush).toBe(false);
  });
});

describe('MaterialLoader (model materials)', () => {
  const pak = makePak({
    'materials/models/props/crate/crate01.vmt': '"VertexLitGeneric" { "$basetexture" "models/props/crate/crate01" "$color2" "[0.5 1 1]" }',
    'materials/models/props/crate/crate01.vtf': vtfSolid(4, 4, [200, 100, 50, 255]),
    'materials/models/shared/metal.vmt': '"VertexLitGeneric" { "$basetexture" "models/shared/metal" "$translucent" 1 }',
    'materials/models/shared/metal.vtf': vtfSolid(4, 4, [10, 20, 30, 128]),
  });

  it('searches $cdmaterials directories in order, caches by name, tints with $color2', () => {
    const loader = new MaterialLoader(pak);
    const crate = loader.loadModelMaterial('Crate01', ['models\\props\\crate\\', 'models/shared/']);
    expect(crate.name).toBe('models/props/crate/crate01');
    expect(crate.shader).toBe('vertexlitgeneric');
    expect(px(crate.image!, 0, 0)).toEqual([100, 100, 50, 255]);
    const metal = loader.loadModelMaterial('metal', ['models/props/crate/', 'models/shared']);
    expect(metal.name).toBe('models/shared/metal');
    expect(metal.translucent).toBe(true);
    expect(metal.image!.hasAlpha).toBe(true);
    expect(loader.load('MODELS/SHARED/METAL')).toBe(metal);
    const missing = loader.loadModelMaterial('nothere', ['models/a/', 'models/b/']);
    expect(missing.name).toBe('models/a/nothere');
    expect(isProceduralImage(missing.image)).toBe(true);
    expect(loader.texture('models/shared/metal')).not.toBeNull();
    expect(loader.stats.total).toBe(3);
  });
});

// ============================================================================ sky (synthetic)

describe('loadSky (synthetic)', () => {
  const faceVtf = (rgb: number[], w = 8, h = 8) => buildVtf({ width: w, height: h, format: VtfFormat.BGR888, image: (m, ww, hh) => {
    const b = new Uint8Array(ww * hh * 3);
    for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) b.set([rgb[2], rgb[1], y === hh - 1 ? 200 : rgb[0]], (y * ww + x) * 3);
    return b;
  } });

  it('loads six faces via VMTs, resamples to a common size and applies transforms', () => {
    const files: Record<string, string | Uint8Array> = {
      'materials/skybox/sky_testbk.vmt': `"sky" { "$basetexture" "skybox/sky_testside" "$basetexturetransform" "center 0 0 scale 1 2 rotate 0 translate 0 0" }`,
      'materials/skybox/sky_testft.vmt': `"sky" { "$basetexture" "skybox/sky_testside" "$basetexturetransform" "center 0 0 scale 1 2 rotate 0 translate 0 0" }`,
      'materials/skybox/sky_testlf.vmt': `"sky" { "$basetexture" "skybox/sky_testside" "$basetexturetransform" "center 0 0 scale 1 2 rotate 0 translate 0 0" }`,
      'materials/skybox/sky_testrt.vmt': `"sky" { "$basetexture" "skybox/sky_testside" "$basetexturetransform" "center 0 0 scale 1 2 rotate 0 translate 0 0" }`,
      'materials/skybox/sky_testside.vtf': faceVtf([10, 20, 30], 16, 8),
      'materials/skybox/sky_testup.vmt': `"UnlitGeneric" { "$basetexture" "skybox/sky_testup" }`,
      'materials/skybox/sky_testup.vtf': faceVtf([100, 110, 120], 4, 4),
    };
    const sky = loadSky('sky_test', makePak(files));
    expect(sky.name).toBe('sky_test');
    expect(sky.faces).not.toBeNull();
    const f = sky.faces!;
    for (const k of ['rt', 'lf', 'bk', 'ft', 'up', 'dn'] as const) {
      expect([f[k].width, f[k].height]).toEqual([16, 16]);
      expect(f[k].hasAlpha).toBe(false);
    }
    // Top of the side face shows the texture, the lower half repeats its (clamped) last row.
    expect(px(f.rt, 3, 0)).toEqual([10, 20, 30, 255]);
    expect(px(f.rt, 3, 15)).toEqual([200, 20, 30, 255]);
    expect(px(f.rt, 3, 12)).toEqual([200, 20, 30, 255]);
    // dn synthesized from the bottom rows of the sides.
    expect(px(f.dn, 5, 5)).toEqual([200, 20, 30, 255]);
    expect(px(f.up, 8, 4)[1]).toBe(110);
  });

  it('falls back to default texture paths, HDR compressed textures and _hdr names; null when incomplete', () => {
    const files: Record<string, string | Uint8Array> = {};
    for (const s of ['rt', 'lf', 'bk', 'ft', 'up', 'dn']) files[`materials/skybox/plain${s}.vtf`] = faceVtf([50, 60, 70]);
    const plain = loadSky('plain', makePak(files));
    expect(plain.faces).not.toBeNull();
    expect(px(plain.faces!.lf, 0, 0)).toEqual([50, 60, 70, 255]);

    const hdr: Record<string, string | Uint8Array> = {};
    for (const s of ['rt', 'lf', 'bk', 'ft', 'up']) {
      hdr[`materials/skybox/h${s}.vmt`] = `"sky" { "$hdrcompressedtexture" "skybox/h_hdr${s}" "$basetexture" "skybox/missing" }`;
      // BGRA: b=0 g=0 r=128 a=32 → linear r ≈ 1.0
      hdr[`materials/skybox/h_hdr${s}.vtf`] = buildVtf({ width: 2, height: 2, format: VtfFormat.BGRA8888, image: (m, w, hh) => solidRgba(w, hh, [0, 0, 128, 32]) });
    }
    const hs = loadSky('h', makePak(hdr));
    expect(hs.faces).not.toBeNull();
    expect(px(hs.faces!.rt, 0, 0)[0]).toBeGreaterThan(230);
    expect(px(hs.faces!.rt, 0, 0)[3]).toBe(255);

    const hdrNamed: Record<string, string | Uint8Array> = {};
    for (const s of ['rt', 'lf', 'bk', 'ft', 'up', 'dn']) hdrNamed[`materials/skybox/day_hdr${s}.vtf`] = faceVtf([1, 2, 3]);
    expect(loadSky('day', makePak(hdrNamed)).faces).not.toBeNull();

    const incomplete: Record<string, string | Uint8Array> = {};
    for (const s of ['rt', 'lf', 'bk', 'ft']) incomplete[`materials/skybox/inc${s}.vtf`] = faceVtf([1, 2, 3]);
    expect(loadSky('inc', makePak(incomplete)).faces).toBeNull();
    expect(loadSky('', null).faces).toBeNull();
    expect(loadSky('sky_day01_01', null)).toEqual({ name: 'sky_day01_01', faces: null });
  });
});

describe('proceduralSky', () => {
  it('builds six seamless gradient faces with a palette from the name', () => {
    const sky = proceduralSky('sky_day01_01', 64);
    expect(sky.name).toBe('sky_day01_01');
    const f = sky.faces!;
    for (const k of ['rt', 'lf', 'bk', 'ft', 'up', 'dn'] as const) expect([f[k].width, f[k].height]).toEqual([64, 64]);
    const zenith = px(f.up, 32, 32);
    const horizon = px(f.rt, 32, 32);
    const below = px(f.dn, 32, 32);
    expect(zenith[2]).toBeGreaterThan(zenith[0] + 80); // deep blue overhead
    expect(horizon[0]).toBeGreaterThan(zenith[0]); // paler at the horizon
    expect(below[2]).toBeLessThan(horizon[2]);
    // Seams: the top edge of a side face matches the edge of the up face (both at 45° elevation).
    const sideTop = px(f.rt, 32, 0);
    const upEdge = px(f.up, 32, 0);
    for (let c = 0; c < 3; c++) expect(Math.abs(sideTop[c] - upEdge[c])).toBeLessThanOrEqual(6);
    expect(isProceduralImage(f.up)).toBe(true);
    expect(stockSkyPalette('sky_borealis01').zenith[2]).toBeLessThan(0.2);
    expect(stockSkyPalette('sky_dust').horizon[0]).toBeGreaterThan(0.8);
    expect(stockSkyPalette('whatever')).toEqual(stockSkyPalette('sky_day01_01'));
  });
});

describe('cubemaps', () => {
  const cube = (minor: number, color: (face: number) => number[]) =>
    buildVtf({ minor, width: 4, height: 4, flags: VTF_FLAG_ENVMAP, format: VtfFormat.RGBA8888, mips: 3, image: (m, w, h, f, face) => solidRgba(w, h, color(face)) });
  const lump = (samples: number[][]) => {
    const b = new Uint8Array(samples.length * 16);
    const dv = new DataView(b.buffer);
    samples.forEach((s, i) => s.forEach((v, k) => dv.setInt32(i * 16 + k * 4, v, true)));
    return b;
  };

  it('loadCubemap decodes 6 faces (7-face pre-7.5 layout), LDR first then HDR', () => {
    const pak = makePak({
      'materials/maps/m/c1_2_3.vtf': cube(4, (f) => [f * 40, 0, 0, 7]),
      'materials/maps/m/c9_9_9.hdr.vtf': buildVtf({ width: 2, height: 2, flags: VTF_FLAG_ENVMAP, format: VtfFormat.RGBA16161616F, minor: 5, image: (m, w, h) => {
        const b = new Uint8Array(w * h * 8);
        for (let i = 0; i < w * h; i++) b.set([0x00, 0x38, 0, 0, 0, 0, 0x00, 0x3c], i * 8); // r = 0.5
        return b;
      } }),
    });
    const faces = loadCubemap('maps/m/c1_2_3', pak)!;
    expect(faces.length).toBe(6);
    expect(faces.map((f) => px(f, 1, 1)[0])).toEqual([0, 40, 80, 120, 160, 200]);
    expect(px(faces[0], 0, 0)[3]).toBe(255);
    const hdr = loadCubemap('maps/m/c9_9_9', pak)!;
    expect(Math.abs(px(hdr[2], 0, 0)[0] - Math.round(linearToSrgb(0.5) * 255))).toBeLessThanOrEqual(1);
    expect(loadCubemap('maps/m/nothere', pak)).toBeNull();
  });

  it('loadCubemaps pairs LUMP_CUBEMAPS samples with packed textures; compiledMapName', () => {
    const pak = makePak({ 'materials/maps/surf_x_v2/c1_2_-3.vtf': cube(5, () => [9, 9, 9, 255]) });
    const bsp = makeBsp([{ name: 'concrete/a' }], [], { 42: lump([[1, 2, -3, 0], [100, 200, 300, 64]]) });
    expect(compiledMapName(bsp, pak)).toBe('surf_x_v2');
    const cms = loadCubemaps(bsp, pak);
    expect(cms.length).toBe(2);
    expect(cms[0]).toMatchObject({ origin: { x: 1, y: 2, z: -3 }, size: 0, texture: 'maps/surf_x_v2/c1_2_-3' });
    expect(cms[0].faces!.length).toBe(6);
    expect(cms[1].texture).toBe('maps/surf_x_v2/c100_200_300');
    expect(cms[1].size).toBe(64);
    expect(cms[1].faces).toBeNull();
    // Name from patched material names when nothing is packed; default cubemap when there are no samples.
    expect(compiledMapName(makeBsp([{ name: 'maps/surf_y/glass/g_1_2_3' }]), null)).toBe('surf_y');
    const def = makePak({ 'materials/maps/z/cubemapdefault.vtf': cube(5, () => [1, 2, 3, 255]) });
    const d = loadCubemaps(makeBsp([{ name: 'a' }]), def);
    expect(d.length).toBe(1);
    expect(d[0].texture).toBe('maps/z/cubemapdefault');
    expect(loadCubemaps(makeBsp([{ name: 'a' }]), null)).toEqual([]);
  });
});

// ============================================================================ prefetch (game content)

describe('prefetchMaterialFiles', () => {
  it('fetches VMTs, includes, textures and sky faces missing from the pak', async () => {
    const content = new Map<string, Uint8Array>([
      ['materials/concrete/concretefloor039a.vmt', te.encode('"LightmappedGeneric" { "$basetexture" "concrete/concretefloor039a" "$detail" "detail/d" }')],
      ['materials/concrete/concretefloor039a.vtf', vtfSolid(4, 4, [9, 8, 7, 255])],
      ['materials/detail/d.vtf', vtfSolid(4, 4, [128, 128, 128, 255])],
      ['materials/stock/a.vmt', te.encode('"LightmappedGeneric" { "$basetexture" "stock/a_tex" }')],
      ['materials/stock/a_tex.vtf', vtfSolid(4, 4, [1, 1, 1, 255])],
      ['materials/skybox/sky_xrt.vtf', vtfSolid(4, 4, [5, 5, 5, 255])],
      ['materials/unused.vtf', vtfSolid(4, 4, [5, 5, 5, 255])],
    ]);
    const reads: string[] = [];
    const src = {
      has: (p: string) => content.has(normalizePakPath(p)),
      read: async (p: string) => {
        reads.push(p);
        return content.get(normalizePakPath(p)) ?? null;
      },
    };
    const pak = makePak({ 'materials/maps/m/concrete/concretefloor039a_1_2_3.vmt': '"patch" { "include" "materials/concrete/concretefloor039a.vmt" }' });
    const bsp = makeBsp([{ name: 'maps/m/concrete/concretefloor039a_1_2_3' }, { name: 'stock/a' }, { name: 'stock/missing' }]);
    const got = await prefetchMaterialFiles(bsp, pak, src, 'sky_x');
    expect([...got.keys()].sort()).toEqual(
      [
        'materials/concrete/concretefloor039a.vmt',
        'materials/concrete/concretefloor039a.vtf',
        'materials/detail/d.vtf',
        'materials/skybox/sky_xrt.vtf',
        'materials/stock/a.vmt',
        'materials/stock/a_tex.vtf',
      ].sort(),
    );
    const M = buildMaterials(bsp, pak, { extraSources: [mapFileSource(got)] });
    expect(px(M.get('maps/m/concrete/concretefloor039a_1_2_3')!.image!, 0, 0)).toEqual([9, 8, 7, 255]);
    expect(M.get('maps/m/concrete/concretefloor039a_1_2_3')!.detail).toBeDefined();
    expect(px(M.get('stock/a')!.image!, 0, 0)).toEqual([1, 1, 1, 255]);
    expect(isProceduralImage(M.get('stock/missing')!.image)).toBe(true);
  });
});

describe('prefetchMaterialFiles (options)', () => {
  const fakeContent = (files: Record<string, Uint8Array | string>) => {
    const m = new Map<string, Uint8Array>();
    for (const [k, v] of Object.entries(files)) m.set(normalizePakPath(k), typeof v === 'string' ? te.encode(v) : v);
    const reads: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    return {
      reads,
      get maxInFlight() {
        return maxInFlight;
      },
      src: {
        has: (p: string) => m.has(normalizePakPath(p)),
        read: async (p: string) => {
          reads.push(normalizePakPath(p));
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
          return m.get(normalizePakPath(p)) ?? null;
        },
      },
    };
  };
  const tex = vtfSolid(4, 4, [10, 20, 30, 255]);

  it('reports progress, limits concurrency and stops on abort', async () => {
    const files: Record<string, Uint8Array | string> = {};
    const mats: { name: string }[] = [];
    for (let i = 0; i < 40; i++) {
      files[`materials/stock/m${i}.vmt`] = `"LightmappedGeneric" { "$basetexture" "stock/m${i}" }`;
      files[`materials/stock/m${i}.vtf`] = tex;
      mats.push({ name: `stock/m${i}` });
    }
    const c = fakeContent(files);
    const progress: [number, number][] = [];
    const got = await prefetchMaterialFiles(makeBsp(mats), null, c.src, { concurrency: 4, onProgress: (d, t) => progress.push([d, t]) });
    expect(got.size).toBe(80);
    expect(c.maxInFlight).toBeLessThanOrEqual(4);
    expect(progress.at(-1)).toEqual([80, 80]);
    for (let i = 1; i < progress.length; i++) expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0]);
    const ac = new AbortController();
    const c2 = fakeContent(files);
    const partial = await prefetchMaterialFiles(makeBsp(mats), null, c2.src, {
      concurrency: 2,
      signal: ac.signal,
      onProgress: (d) => {
        if (d === 10) ac.abort();
      },
    });
    expect(partial.size).toBeLessThan(20);
  });

  it('follows nested includes, envmap masks (also normal-map alpha) and skips textures of tool materials', async () => {
    const c = fakeContent({
      'materials/a/base.vmt': '"patch" { "include" "materials/a/mid.vmt" "insert" { "$envmap" "env_cubemap" "$envmapmask" "a/mask" } }',
      'materials/a/mid.vmt': '"patch" { "include" "a/root" "replace" { "$detail" "a/detail" } }',
      'materials/a/root.vmt': '"LightmappedGeneric" { "$basetexture" "a/root" "$bumpmap" "a/root_normal" }',
      'materials/a/root.vtf': tex,
      'materials/a/mask.vtf': tex,
      'materials/a/detail.vtf': tex,
      'materials/a/root_normal.vtf': tex,
      'materials/b/shiny.vmt': '"LightmappedGeneric" { "$basetexture" "b/shiny" "$envmap" "env_cubemap" "$bumpmap" "b/shiny_normal" "$normalmapalphaenvmapmask" "1" }',
      'materials/b/shiny.vtf': tex,
      'materials/b/shiny_normal.vtf': tex,
      'materials/b/plain.vmt': '"LightmappedGeneric" { "$basetexture" "b/plain" "$bumpmap" "b/plain_normal" }',
      'materials/b/plain.vtf': tex,
      'materials/b/plain_normal.vtf': tex,
      'materials/tools/toolsnodraw.vmt': '"LightmappedGeneric" { "$basetexture" "tools/toolsnodraw" }',
      'materials/tools/toolsnodraw.vtf': tex,
      'materials/c/clip.vmt': '"LightmappedGeneric" { "$basetexture" "c/clip" "%compileclip" "1" }',
      'materials/c/clip.vtf': tex,
    });
    const bsp = makeBsp([{ name: 'a/base' }, { name: 'b/shiny' }, { name: 'b/plain' }, { name: 'tools/toolsnodraw' }, { name: 'c/clip' }]);
    const got = await prefetchMaterialFiles(bsp, null, c.src, { detailTextures: true });
    expect([...got.keys()].sort()).toEqual(
      [
        'materials/a/base.vmt',
        'materials/a/mid.vmt',
        'materials/a/root.vmt',
        'materials/a/root.vtf',
        'materials/a/mask.vtf',
        'materials/a/detail.vtf',
        'materials/b/shiny.vmt',
        'materials/b/shiny.vtf',
        'materials/b/shiny_normal.vtf',
        'materials/b/plain.vmt',
        'materials/b/plain.vtf',
        'materials/tools/toolsnodraw.vmt',
        'materials/c/clip.vmt',
      ].sort(),
    );
    const M = buildMaterials(bsp, null, { extraSources: [mapFileSource(got)] });
    expect(isProceduralImage(M.get('a/base')!.image)).toBe(false);
    expect(M.get('a/base')!.envmap!.maskImage).not.toBeNull();
    expect(M.get('a/base')!.detail).toBeDefined();
    expect(M.get('b/shiny')!.envmap!.mask).toBe('normalalpha');
    expect(M.get('b/shiny')!.envmap!.maskImage).not.toBeNull();
    // without detail textures
    const c2 = fakeContent({ 'materials/a/root.vmt': '"LightmappedGeneric" { "$basetexture" "a/root" "$detail" "a/detail" }', 'materials/a/root.vtf': tex, 'materials/a/detail.vtf': tex });
    const got2 = await prefetchMaterialFiles(makeBsp([{ name: 'a/root' }]), null, c2.src, { detailTextures: false });
    expect([...got2.keys()].sort()).toEqual(['materials/a/root.vmt', 'materials/a/root.vtf']);
  });

  it('sky: LDR faces first, HDR textures only for faces without an LDR texture', async () => {
    const files: Record<string, Uint8Array | string> = {};
    for (const s of ['rt', 'lf', 'bk', 'ft', 'up', 'dn']) {
      files[`materials/skybox/sky_a${s}.vmt`] = `"Sky" { "$basetexture" "skybox/sky_a${s}" "$hdrcompressedtexture" "skybox/sky_a_hdr${s}" }`;
      files[`materials/skybox/sky_a_hdr${s}.vtf`] = tex;
      if (s !== 'up') files[`materials/skybox/sky_a${s}.vtf`] = tex;
    }
    const c = fakeContent(files);
    const pak = makePak({ 'materials/skybox/sky_alf.vtf': vtfSolid(4, 4, [1, 2, 3, 255]) });
    const got = await prefetchMaterialFiles(makeBsp([{ name: 'tools/toolsskybox' }]), pak, c.src, { skyName: 'sky_a' });
    const vtfs = [...got.keys()].filter((k) => k.endsWith('.vtf')).sort();
    // lf is packed in the map; up has no LDR texture so its HDR one is fetched
    expect(vtfs).toEqual(['materials/skybox/sky_a_hdrup.vtf', 'materials/skybox/sky_abk.vtf', 'materials/skybox/sky_adn.vtf', 'materials/skybox/sky_aft.vtf', 'materials/skybox/sky_art.vtf']);
    const sky = loadSky('sky_a', pak, { extraSources: [mapFileSource(got)] });
    expect(sky.faces).not.toBeNull();
    expect(px(sky.faces!.lf, 0, 0).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('never throws for a broken source; unreadable files are left out', async () => {
    const src = {
      has: (p: string) => {
        if (p.includes('boom')) throw new Error('has failed');
        return true;
      },
      read: async (p: string) => {
        if (p.endsWith('.vtf')) throw new Error('read failed');
        return te.encode(`"LightmappedGeneric" { "$basetexture" "x/y" }`);
      },
    };
    const got = await prefetchMaterialFiles(makeBsp([{ name: 'a/b' }, { name: 'boom/c' }]), null, src);
    expect([...got.keys()]).toEqual(['materials/a/b.vmt']);
  });
});

// ============================================================================ real maps

function listMaps(env: string | undefined): string[] {
  if (!env || !existsSync(env)) return [];
  if (statSync(env).isFile()) return env.endsWith('.bsp') ? [env] : [];
  return readdirSync(env)
    .filter((f) => f.toLowerCase().endsWith('.bsp'))
    .sort()
    .map((f) => join(env, f));
}

const MAPS = [...listMaps(process.env.SURF_TEST_MAPS), ...listMaps(process.env.SURF_TEST_MAPS_LARGE)];

function loadBsp(path: string): BspFile {
  const b = readFileSync(path);
  return parseBsp(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, { validate: false });
}

function skyNameOf(bsp: BspFile): string {
  const m = /"skyname"\s+"([^"]*)"/i.exec(bsp.entitiesText);
  return m ? m[1] : '';
}

describe.skipIf(MAPS.length === 0)('real maps', () => {
  const formatHistogram = new Map<string, number>();
  const failures: string[] = [];

  for (const path of MAPS) {
    const name = basename(path, '.bsp');
    describe(name, () => {
      let bsp: BspFile;
      let pak: PakFile;
      const getBsp = () => {
        if (!bsp) {
          bsp = loadBsp(path);
          pak = new PakFile(bsp.pakfile ?? new Uint8Array(0));
        }
        return { bsp, pak };
      };

      it('parses the pakfile', () => {
        const { pak } = getBsp();
        expect(pak.size).toBeGreaterThan(0);
        expect(pak.warnings).toEqual([]);
        for (const e of pak.entries()) expect(pak.read(e.key), e.name).not.toBeNull();
      });

      it('decodes every VTF in the pakfile without throwing', () => {
        const { pak } = getBsp();
        let ok = 0;
        let total = 0;
        let exactEnd = 0;
        const layoutOdd: string[] = [];
        const t0 = performance.now();
        for (const f of pak.list()) {
          if (!f.endsWith('.vtf')) continue;
          total++;
          const data = pak.read(f)!;
          const h = parseVtfHeader(data);
          const key = h ? `${vtfFormatName(h.format)} v7.${h.versionMinor}${h.faces > 1 ? ` x${h.faces}faces` : ''}` : 'BAD-HEADER';
          formatHistogram.set(key, (formatHistogram.get(key) ?? 0) + 1);
          let img: DecodedImage | null = null;
          expect(() => (img = decodeVtf(data, { maxSize: 512 }))).not.toThrow();
          if (img) ok++;
          else failures.push(`${name}: ${f} (${key}, complete=${h?.complete})`);
          if (h) {
            expect(h.complete, f).toBe(true);
            // Layout check: the last image of the largest mip must end exactly where the file ends.
            const last = vtfImageRef(h, data.length, 0, h.frames - 1, h.faces - 1, h.depth - 1);
            if (last && last.offset + last.size === data.length) exactEnd++;
            else layoutOdd.push(`${f} (${key}, ends ${last ? data.length - last.offset - last.size : '?'} bytes early)`);
          }
        }
        if (layoutOdd.length) console.log(`[materials] ${name}: VTFs not ending at their last image:\n  ${layoutOdd.join('\n  ')}`);
        expect(exactEnd).toBeGreaterThan(total * 0.95);
        console.log(`[materials] ${name}: decoded ${ok}/${total} VTFs in ${(performance.now() - t0).toFixed(0)} ms`);
        expect(ok).toBe(total);
      });

      it('parses every VMT', () => {
        const { pak } = getBsp();
        const shaders = new Map<string, number>();
        let n = 0;
        for (const f of pak.list()) {
          if (!f.endsWith('.vmt')) continue;
          const text = pak.readText(f)!;
          const info = parseVmt(text, (p) => pak.readText(p));
          n++;
          expect(info.shader, f).not.toBe('');
          shaders.set(info.shader, (shaders.get(info.shader) ?? 0) + 1);
        }
        console.log(`[materials] ${name}: ${n} VMTs, shaders ${JSON.stringify(Object.fromEntries(shaders))}`);
      });

      it('builds materials for every texdata name and loads the sky', () => {
        const { bsp, pak } = getBsp();
        const t0 = performance.now();
        const M = buildMaterials(bsp, pak);
        const ms = performance.now() - t0;
        const stats = lastMaterialStats()!;
        const names = new Set(bsp.texdataNames.map(normalizeMaterialName));
        expect(M.size).toBe(names.size);
        for (const n of names) expect(M.has(n), n).toBe(true);
        for (const m of M.values()) {
          if (!m.isTool && !m.isSky) expect(m.image, m.name).not.toBeNull();
          for (const c of m.fallbackColor) expect(c >= 0 && c <= 1, m.name).toBe(true);
          expect(m.width).toBeGreaterThan(0);
        }
        const t1 = performance.now();
        const skyName = skyNameOf(bsp);
        const sky = loadSky(skyName, pak);
        const skyMs = performance.now() - t1;
        console.log(
          `[materials] ${name}: ${M.size} materials in ${ms.toFixed(0)} ms (real ${stats.withImage}, procedural ${stats.procedural}, ` +
            `tools ${stats.tools}, sky ${stats.sky}, water ${stats.water}, vmt ${stats.withVmt}, missing includes ${stats.missingIncludes}; ` +
            `${(stats.imageBytes / 1048576).toFixed(1)} MB RGBA) — sky "${skyName}": ${sky.faces ? `${sky.faces.rt.width}px` : 'not packed'} in ${skyMs.toFixed(0)} ms`,
        );
        const t3 = performance.now();
        const cms = loadCubemaps(bsp, pak);
        console.log(
          `[materials] ${name}: ${cms.length} cubemaps (${cms.filter((c) => c.faces).length} packed, map name "${compiledMapName(bsp, pak)}") ` +
            `in ${(performance.now() - t3).toFixed(0)} ms; envmap materials ${[...M.values()].filter((m) => m.envmap).length}`,
        );
        if (DUMP) {
          cms.filter((c) => c.faces).slice(0, 2).forEach((c, k) => c.faces!.forEach((f, i) => dump(`${name}__cubemap${k}_face${i}`, f)));
        }
        const t2 = performance.now();
        buildMaterials(bsp, pak, { compressedTextures: true });
        const cs = lastMaterialStats()!;
        console.log(
          `[materials] ${name}: compressed mode ${(performance.now() - t2).toFixed(0)} ms — ${(cs.compressedBytes / 1048576).toFixed(1)} MB DXT + ` +
            `${(cs.imageBytes / 1048576).toFixed(1)} MB RGBA fallbacks`,
        );
        if (DUMP) {
          let i = 0;
          for (const m of M.values()) {
            if (!m.image || i++ > 40) continue;
            dump(`${name}__${isProceduralImage(m.image) ? 'proc' : 'real'}__${m.name}`, m.image);
          }
          if (sky.faces) for (const [k, f] of Object.entries(sky.faces)) dump(`${name}__sky_${k}`, f);
        }
      });
    });
  }

  it('reports the VTF format histogram', () => {
    console.log(`[materials] VTF formats: ${JSON.stringify(Object.fromEntries([...formatHistogram].sort((a, b) => b[1] - a[1])))}`);
    if (failures.length) console.log(`[materials] VTF failures:\n  ${failures.join('\n  ')}`);
    expect(failures).toEqual([]);
  });

  const utopia = MAPS.find((p) => basename(p) === 'surf_utopia_njv.bsp');
  it.skipIf(!utopia)('surf_utopia_njv: concrete textures, glass/water patches and sky_dustbowl_01 resolve', () => {
    const bsp = loadBsp(utopia!);
    const pak = new PakFile(bsp.pakfile!);
    const M = buildMaterials(bsp, pak);
    for (const n of ['concrete/concretewall011', 'concrete/computerwall001', 'concrete/computerwall002', 'concrete/computerwall005', 'concrete/concretewall002', 'concrete/concretewall001e']) {
      const m = M.get(n)!;
      expect(m, n).toBeDefined();
      expect(isProceduralImage(m.image), n).toBe(false);
      expect(m.image!.width).toBe(1024);
      expect(m.detail, n).toBeDefined();
      expect(m.translucent || m.unlit || m.isTool).toBe(false);
    }
    // vrad reflectivity is the texture's average *linear* colour: check our decode + transfer agrees.
    const idx = bsp.texdataNames.findIndex((n) => normalizeMaterialName(n) === 'concrete/concretewall011');
    const refl = bsp.texdata[idx].reflectivity;
    const img = M.get('concrete/concretewall011')!.image!;
    const lin = [0, 0, 0];
    for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) lin[c] += srgbToLinear(img.data[i + c] / 255);
    const npx = img.data.length / 4;
    expect(Math.abs(lin[0] / npx - refl.x)).toBeLessThan(0.03);
    expect(Math.abs(lin[1] / npx - refl.y)).toBeLessThan(0.03);
    expect(Math.abs(lin[2] / npx - refl.z)).toBeLessThan(0.03);
    dump('utopia_concretewall011', img);

    const glass = M.get('maps/surf_utopia_v3_njv/glass/glasswindow001a_5120_0_-2048')!;
    expect(glass.translucent).toBe(true);
    expect(isProceduralImage(glass.image)).toBe(false);
    expect(glass.textureTransform).toBeDefined();
    const water = M.get('maps/surf_utopia_v3_njv/water/water_well_-14096_0_-6152')!;
    expect(water.isWater).toBe(true);
    expect(water.waterFogColor!.map((c) => Math.round(c * 255))).toEqual([24, 38, 53]);
    expect(M.get('water/water_well_beneath')!.isWater).toBe(true);
    expect(M.get('tools/toolstrigger')!.isTool).toBe(true);
    expect(M.get('tools/toolsplayerclip')!.isTool).toBe(true);
    expect(M.get('tools/toolsinvisible')!.isTool).toBe(true);
    expect(M.get('tools/toolsskybox')!.isSky).toBe(true);
    expect(M.get('tools/toolsblack')!.unlit).toBe(true);
    expect(M.get('lights/white001')!.unlit).toBe(true);

    expect(skyNameOf(bsp)).toBe('sky_dustbowl_01');
    const sky = loadSky('sky_dustbowl_01', pak);
    expect(sky.faces).not.toBeNull();
    const f = sky.faces!;
    for (const k of ['rt', 'lf', 'bk', 'ft', 'up', 'dn'] as const) expect([f[k].width, f[k].height]).toEqual([512, 512]);
    // Side faces: sky in the upper half; the clamped horizon row continues below.
    const top = px(f.bk, 256, 10);
    expect(top[2]).toBeGreaterThan(top[0]); // blue-ish sky at the top
    expect(px(f.bk, 256, 400)).toEqual(px(f.bk, 256, 500));
    for (const [k, face] of Object.entries(f)) dump(`utopia_sky_${k}`, face);
  });

  const kitsune = MAPS.find((p) => basename(p) === 'surf_kitsune.bsp');
  it.skipIf(!kitsune)('surf_kitsune: neon/grid/scroll materials and the shared blacksky texture', () => {
    const bsp = loadBsp(kitsune!);
    const pak = new PakFile(bsp.pakfile!);
    const M = buildMaterials(bsp, pak);
    const neon = M.get('neons/neon_green')!;
    expect(neon.unlit).toBe(true);
    expect(isProceduralImage(neon.image)).toBe(false);
    const grid = M.get('grids/grid_red')!;
    expect(grid.translucent).toBe(true);
    expect(grid.alpha).toBeCloseTo(0.75);
    const rainbow = M.get('custom/rainbowscroll')!;
    expect(rainbow.scroll).not.toBeNull();
    expect(rainbow.scroll![1]).toBeCloseTo(1);
    expect(M.get('tools/toolsnodraw')!.isTool).toBe(true);
    // RAMPS/CONCRETEFLOOR039A packs a VMT pointing at the stock concrete texture → procedural.
    const ramp = M.get('ramps/concretefloor039a')!;
    expect(isProceduralImage(ramp.image)).toBe(true);
    const sky = loadSky(skyNameOf(bsp), pak);
    expect(sky.faces).not.toBeNull();
    dump('kitsune_ramp_proc', ramp.image);
    dump('kitsune_rainbow', rainbow.image);
    dump('kitsune_sky_ft', sky.faces!.ft);
  });

  const beginner = MAPS.find((p) => basename(p) === 'surf_beginner.bsp');
  it.skipIf(!beginner)('surf_beginner: nothing packed → every visible material is procedural', () => {
    const bsp = loadBsp(beginner!);
    const pak = new PakFile(bsp.pakfile!);
    const M = buildMaterials(bsp, pak);
    for (const m of M.values()) {
      if (m.isTool || m.isSky) continue;
      expect(isProceduralImage(m.image), m.name).toBe(true);
    }
    expect(M.get('dev/dev_water2')!.isWater).toBe(true);
    expect(M.get('dev/dev_waterbeneath2')!.isWater).toBe(true);
    expect(M.get('cs_havana/white')!.unlit).toBe(true);
    for (const n of ['nature/sandfloor010a', 'cs_havana/woodm', 'concrete/concretewall019a', 'de_dust/rockwall01', 'concrete/concretefloor008a', 'de_piranesi/marblefloor06', 'cs_italy/stonewall02', 'metal/metalhull010b', 'cs_havana/ground01grass']) {
      dump(`beginner_${n}`, M.get(n)!.image);
    }
  });
});

// ============================================================================ benchmark (opt-in)

describe.skipIf(!process.env.SURF_MATERIALS_BENCH)('benchmark', () => {
  it('procedural generation per family (256x256)', () => {
    const fams = ['concrete', 'plaster', 'metal', 'wood', 'brick', 'tile', 'stone', 'stonewall', 'grass', 'dirt', 'sand', 'marble', 'carpet', 'glass', 'grate', 'fence', 'ladder', 'dev', 'light', 'water', 'flat', 'generic'] as const;
    for (const f of fams) {
      generateProceduralImage({ family: f, color: [0.5, 0.5, 0.5], seed: 1 });
      const t = performance.now();
      for (let i = 0; i < 5; i++) generateProceduralImage({ family: f, color: [0.5, 0.5, 0.5], seed: i });
      console.log(`[bench] ${f}: ${((performance.now() - t) / 5).toFixed(1)} ms`);
    }
  });
});

describe.skipIf(!process.env.SURF_MATERIALS_BENCH)('benchmark: DXT', () => {
  it('decodes 1024x1024 DXT1/DXT5', () => {
    let seed = 5;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
    for (const format of [VtfFormat.DXT1, VtfFormat.DXT5]) {
      const data = buildVtf({ width: 1024, height: 1024, format, image: (m, w, h) => Uint8Array.from({ length: vtfImageSize(format, w, h) }, rand) });
      decodeVtf(data);
      const t = performance.now();
      for (let i = 0; i < 5; i++) decodeVtf(data);
      console.log(`[bench] ${vtfFormatName(format)} 1024²: ${((performance.now() - t) / 5).toFixed(1)} ms`);
    }
  });
});
