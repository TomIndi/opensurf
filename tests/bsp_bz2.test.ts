// bzip2 decoder tests: committed fixture (always runs) + vectors from Python's bz2 module (libbz2).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Bzip2Error, bunzip2, bzip2Crc, isBzip2 } from '../src/bsp/bz2';

const FIX = join(__dirname, 'fixtures');

function pattern(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ((i * 7 + (i >> 3)) ^ (i >> 9)) & 255;
  return out;
}

/** Content of tests/fixtures/bsp_bz2_sample.bz2. */
function sampleContent(): Uint8Array {
  const enc = new TextEncoder();
  const parts = [enc.encode('surf_utopia '.repeat(200)), pattern(3000), new Uint8Array(1000), enc.encode('A'.repeat(300)), enc.encode('end')];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('bz2: fixture and error handling', () => {
  const sample = new Uint8Array(readFileSync(join(FIX, 'bsp_bz2_sample.bz2')));

  it('decodes the committed fixture', () => {
    expect(isBzip2(sample)).toBe(true);
    expect(equalBytes(bunzip2(sample), sampleContent())).toBe(true);
  });

  it('computes bzip2 CRC-32 (MSB-first, poly 0x04C11DB7)', () => {
    expect(bzip2Crc(new TextEncoder().encode('123456789'))).toBe(0xfc891918); // CRC-32/BZIP2 check value
    expect(bzip2Crc(new Uint8Array(0))).toBe(0);
  });

  it('decodes concatenated streams and ignores trailing garbage', () => {
    const both = new Uint8Array(sample.length * 2 + 5);
    both.set(sample, 0);
    both.set(sample, sample.length);
    both.set([0, 0, 1, 2, 3], sample.length * 2);
    const out = bunzip2(both);
    const one = sampleContent();
    expect(out.length).toBe(one.length * 2);
    expect(equalBytes(out.subarray(0, one.length), one)).toBe(true);
    expect(equalBytes(out.subarray(one.length), one)).toBe(true);
  });

  it('detects CRC mismatches (and can skip verification)', () => {
    const bad = sample.slice();
    bad[10] ^= 0xff; // first byte of the block CRC (header 4 bytes + magic 6 bytes)
    expect(() => bunzip2(bad)).toThrow(/CRC/);
    expect(equalBytes(bunzip2(bad, { verifyCrc: false }), sampleContent())).toBe(true);
  });

  it('rejects non-bzip2 data, bad magic and truncated input', () => {
    expect(isBzip2(new TextEncoder().encode('BZh0'))).toBe(false);
    expect(() => bunzip2(new TextEncoder().encode('VBSP....'))).toThrow(Bzip2Error);
    const badMagic = sample.slice();
    badMagic[4] ^= 1;
    expect(() => bunzip2(badMagic)).toThrow(Bzip2Error);
    expect(() => bunzip2(sample.subarray(0, sample.length >> 1))).toThrow(Bzip2Error);
  });

  it('never hangs on corrupted block data', () => {
    for (let k = 0; k < 30; k++) {
      const bad = sample.slice();
      bad[20 + ((k * 97) % (bad.length - 30))] ^= 1 << k % 8;
      try {
        bunzip2(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(Bzip2Error);
      }
    }
  });
});

// ------------------------------------------------------------------------------- python-generated vectors

const HAS_PYTHON = spawnSync('python3', ['-I', '-c', 'import bz2'], { encoding: 'utf8' }).status === 0;

function getBits(buf: Uint8Array, bitPos: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const p = bitPos + i;
    v = v * 2 + ((buf[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return v;
}

function setBits(buf: Uint8Array, bitPos: number, n: number, value: number): void {
  for (let i = 0; i < n; i++) {
    const p = bitPos + i;
    const bit = Math.floor(value / 2 ** (n - 1 - i)) & 1;
    if (bit) buf[p >> 3] |= 0x80 >> (p & 7);
    else buf[p >> 3] &= ~(0x80 >> (p & 7));
  }
}

describe.skipIf(!HAS_PYTHON)('bz2: vectors from libbz2 (python3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surf-bz2-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const script = `
import bz2, random, struct, sys
out = sys.argv[1]
random.seed(99)
cases = {
  'empty': b'',
  'one': b'x',
  'run4': b'aaaa',
  'run5': b'aaaaa',
  'run255': b'q' * 255,
  'run259': b'b' * 259,
  'run260': b'b' * 260,
  'run1000': b'z' * 1000 + b'y',
  'runs': b''.join(bytes([random.randrange(3)]) * random.randrange(1, 600) for _ in range(2000)),
  'text': b'The quick brown fox jumps over the lazy dog.\\n' * 4000,
  'rand': bytes(random.getrandbits(8) for _ in range(150000)),
  'allbytes': bytes(range(256)) * 200,
  'floats': b''.join(struct.pack('<f', random.uniform(-4096, 4096) if i % 3 else float(i % 64)) for i in range(120000)),
}
for name, data in cases.items():
    for lvl in (1, 9):
        open(f'{out}/{name}_{lvl}.bz2', 'wb').write(bz2.compress(data, lvl))
    open(f'{out}/{name}.raw', 'wb').write(data)
a = bytes(random.getrandbits(8) for _ in range(1000)) + b'hello' * 100
b = b'world' * 3000
open(f'{out}/multi_1.bz2', 'wb').write(bz2.compress(a, 1) + bz2.compress(b, 9))
open(f'{out}/multi.raw', 'wb').write(a + b)
# a single-block stream large enough to cycle through the whole randomisation table
r = bytes(random.getrandbits(8) for _ in range(420000))
open(f'{out}/randomised_src.bz2', 'wb').write(bz2.compress(r, 9))
`;
  const gen = spawnSync('python3', ['-I', '-c', script, dir], { encoding: 'utf8' });

  it('python generated the vectors', () => {
    expect(gen.status, gen.stderr).toBe(0);
  });

  it('decodes every vector (multiple blocks at level 1, RLE edge cases, multiple streams)', () => {
    const files = readdirSync(dir).filter((f) => /_\d\.bz2$/.test(f));
    expect(files.length).toBe(13 * 2 + 1);
    for (const f of files) {
      const expected = new Uint8Array(readFileSync(join(dir, f.replace(/_\d\.bz2$/, '.raw'))));
      const out = bunzip2(new Uint8Array(readFileSync(join(dir, f))));
      expect(equalBytes(out, expected), f).toBe(true);
    }
  });

  it('handles randomised blocks exactly like libbz2', () => {
    // Set the "randomised" bit of the only block, decode it with our de-randomisation, patch both CRCs to
    // match our output and let libbz2 decode the same file: it only accepts it if its de-randomised output
    // (and therefore its rNums table and update rule) matches ours.
    const src = new Uint8Array(readFileSync(join(dir, 'randomised_src.bz2')));
    expect(getBits(src, 32, 24)).toBe(0x314159);
    const data = src.slice();
    const oldCrc = getBits(data, 80, 32);
    setBits(data, 112, 1, 1);
    const ours = bunzip2(data, { verifyCrc: false });
    const crc = bzip2Crc(ours);
    setBits(data, 80, 32, crc);
    // end-of-stream marker + combined CRC (= block CRC for a single block) sit in the last 11 bytes
    const totalBits = data.length * 8;
    let eos = -1;
    for (let p = totalBits - 87; p <= totalBits - 80; p++) {
      if (getBits(data, p, 24) === 0x177245 && getBits(data, p + 24, 24) === 0x385090 && getBits(data, p + 48, 32) === oldCrc) eos = p;
    }
    expect(eos).toBeGreaterThan(0);
    setBits(data, eos + 48, 32, crc);
    expect(equalBytes(bunzip2(data), ours)).toBe(true); // CRCs now verify
    const patched = join(dir, 'randomised_patched.bz2');
    writeFileSync(patched, data);
    const py = spawnSync(
      'python3',
      ['-I', '-c', 'import bz2,sys; sys.stdout.buffer.write(bz2.decompress(open(sys.argv[1],"rb").read()))', patched],
      { maxBuffer: 1 << 26 },
    );
    expect(py.status, String(py.stderr)).toBe(0);
    expect(equalBytes(new Uint8Array(py.stdout), ours)).toBe(true);
  });
});
