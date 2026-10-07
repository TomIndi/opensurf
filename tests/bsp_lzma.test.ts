// LZMA decoder tests: committed fixtures (always run) + vectors generated with Python's lzma module
// (liblzma) at test time when python3 is available.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LzmaError,
  decodeLzmaAlone,
  decodeSourceLzma,
  isSourceLzma,
  lzmaDecompress,
  parseLzmaProps,
  sourceLzmaActualSize,
} from '../src/bsp/lzma';

const FIX = join(__dirname, 'fixtures');

/** Same generator as the one used to build tests/fixtures/bsp_lzma_pattern.bin. */
function pattern(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ((i * 7 + (i >> 3)) ^ (i >> 9)) & 255;
  return out;
}

const ENTITIES_TEXT =
  '{\n"classname" "worldspawn"\n"skyname" "sky_day01_01"\n}\n{\n"classname" "info_player_start"\n"origin" "0 0 64"\n"angles" "0 90 0"\n}\n'.repeat(20);

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIX, name)));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('lzma: Source "LZMA" header fixtures', () => {
  it('decodes a binary fixture (lc3 lp0 pb2)', () => {
    const buf = fixture('bsp_lzma_pattern.bin');
    expect(isSourceLzma(buf)).toBe(true);
    expect(sourceLzmaActualSize(buf)).toBe(20000);
    const out = decodeSourceLzma(buf);
    expect(equalBytes(out, pattern(20000))).toBe(true);
  });

  it('decodes a text fixture (lc0 lp2 pb0)', () => {
    const out = decodeSourceLzma(fixture('bsp_lzma_entities.bin'));
    expect(new TextDecoder().decode(out)).toBe(ENTITIES_TEXT);
  });

  it('decodes when the buffer is an unaligned view inside a larger buffer', () => {
    const src = fixture('bsp_lzma_pattern.bin');
    const big = new Uint8Array(src.length + 7);
    big.set(src, 3);
    const out = decodeSourceLzma(big.subarray(3, 3 + src.length));
    expect(equalBytes(out, pattern(20000))).toBe(true);
  });

  it('parses the properties byte', () => {
    const p = parseLzmaProps(new Uint8Array([93, 0, 0, 1, 0]));
    expect(p).toEqual({ lc: 3, lp: 0, pb: 2, dictSize: 65536 });
    expect(() => parseLzmaProps(new Uint8Array([225, 0, 0, 0, 0]))).toThrow(LzmaError);
    expect(() => parseLzmaProps(new Uint8Array([93]))).toThrow(LzmaError);
  });

  it('rejects data without the header and truncated streams', () => {
    expect(isSourceLzma(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(() => decodeSourceLzma(new TextEncoder().encode('PK\x03\x04 not lzma at all......'))).toThrow(LzmaError);
    const buf = fixture('bsp_lzma_pattern.bin');
    expect(() => decodeSourceLzma(buf.subarray(0, Math.floor(buf.length / 2)))).toThrow(LzmaError);
  });

  it('never hangs on corrupted input (throws or returns the declared size)', () => {
    const buf = fixture('bsp_lzma_pattern.bin');
    for (let k = 0; k < 40; k++) {
      const bad = buf.slice();
      for (let j = 0; j < 4; j++) bad[17 + 1 + ((k * 131 + j * 977) % (bad.length - 18))] ^= 0x5a + k;
      try {
        expect(decodeSourceLzma(bad).length).toBe(20000);
      } catch (e) {
        expect(e).toBeInstanceOf(LzmaError);
      }
    }
  });

  it('refuses absurd declared sizes instead of allocating them', () => {
    const buf = fixture('bsp_lzma_pattern.bin').slice();
    new DataView(buf.buffer).setUint32(4, 0xfffffff0, true); // actualSize ~4 GB
    expect(() => decodeSourceLzma(buf)).toThrow(/limit/);
  });

  it('returns an empty array for zero-sized output', () => {
    expect(lzmaDecompress(new Uint8Array([93, 0, 0, 1, 0]), new Uint8Array([0, 0, 0, 0, 0]), 0).length).toBe(0);
  });
});

const HAS_PYTHON = spawnSync('python3', ['-I', '-c', 'import lzma'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!HAS_PYTHON)('lzma: vectors from liblzma (python3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surf-lzma-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const script = `
import lzma, os, random, struct, sys
out = sys.argv[1]
random.seed(1234)
cases = {
  'text': (b'The quick brown fox jumps over the lazy dog. ' * 1500) + bytes(random.getrandbits(8) for _ in range(2000)),
  'rand': bytes(random.getrandbits(8) for _ in range(60000)),
  'zeros': bytes(300000),
  'runs': b''.join(bytes([random.randrange(4)]) * random.randrange(1, 300) + bytes(random.getrandbits(8) for _ in range(random.randrange(0, 40))) for _ in range(2500)),
  'one': b'x',
  'floats': b''.join(struct.pack('<f', random.uniform(-4096, 4096) if i % 3 else float(i % 64)) for i in range(40000)),
}
for name, data in cases.items():
    for (lc, lp, pb) in [(3, 0, 2), (0, 2, 0), (4, 0, 4), (1, 1, 1), (2, 2, 3), (0, 4, 4)]:
        for dict_size in (4096, 1 << 20):
            filt = [{'id': lzma.FILTER_LZMA1, 'lc': lc, 'lp': lp, 'pb': pb, 'dict_size': dict_size}]
            tag = f'{name}_{lc}{lp}{pb}_{dict_size}'
            raw = lzma.compress(data, format=lzma.FORMAT_RAW, filters=filt)
            props = bytes([(pb * 5 + lp) * 9 + lc]) + struct.pack('<I', dict_size)
            open(f'{out}/{tag}.src', 'wb').write(b'LZMA' + struct.pack('<II', len(data), len(raw)) + props + raw)
            if dict_size == 4096:
                open(f'{out}/{tag}.alone', 'wb').write(lzma.compress(data, format=lzma.FORMAT_ALONE, filters=filt))
            open(f'{out}/{tag}.raw', 'wb').write(data)
`;
  const gen = spawnSync('python3', ['-I', '-c', script, dir], { encoding: 'utf8' });

  it('python generated the vectors', () => {
    expect(gen.status, gen.stderr).toBe(0);
  });

  it('decodes every vector in the Source container (known size)', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.src'));
    expect(files.length).toBe(6 * 6 * 2);
    for (const f of files) {
      const expected = new Uint8Array(readFileSync(join(dir, f.replace('.src', '.raw'))));
      const out = decodeSourceLzma(new Uint8Array(readFileSync(join(dir, f))));
      expect(equalBytes(out, expected), f).toBe(true);
    }
  });

  it('decodes .lzma (LZMA_Alone) files with unknown size and an end marker', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.alone'));
    expect(files.length).toBe(6 * 6);
    for (const f of files) {
      const expected = new Uint8Array(readFileSync(join(dir, f.replace('.alone', '.raw'))));
      const out = decodeLzmaAlone(new Uint8Array(readFileSync(join(dir, f))));
      expect(equalBytes(out, expected), f).toBe(true);
    }
  });
});
