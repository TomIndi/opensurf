import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCatalogEntry, setCatalog, type CatalogEntry } from '../src/maps/catalog';
import { getPresetZoneCandidates, getPresetZones, setZonesFile } from '../src/maps/zones';

const ROOT = join(__dirname, '..');
const catalog = JSON.parse(readFileSync(join(ROOT, 'public/maps/catalog.json'), 'utf8')) as { maps: CatalogEntry[] };
const zonesFile = JSON.parse(readFileSync(join(ROOT, 'public/maps/zones.json'), 'utf8'));

describe('catalog', () => {
  it('lists the KSF archive with tiers and drive ids', () => {
    expect(catalog.maps.length).toBeGreaterThan(900);
    setCatalog(catalog.maps);
    const utopia = getCatalogEntry('surf_utopia_njv');
    expect(utopia?.driveId).toBeTruthy();
    expect(utopia?.tier).toBe(1);
    expect(utopia?.featured).toBe(true);
    expect(getCatalogEntry('SURF_KITSUNE.bsp')?.name).toBe('surf_kitsune');
    for (const m of catalog.maps) {
      expect(m.name).toMatch(/^surf_/);
      expect(m.driveId).toMatch(/^[\w-]{20,}$/);
    }
  });
});

describe('zone presets', () => {
  it('converts SurfTimer zones (stage = typeid + 2) and resolves aliases', async () => {
    setZonesFile(zonesFile);
    const kitsune = await getPresetZones('surf_kitsune');
    expect(kitsune).not.toBeNull();
    const stages = kitsune!.filter((z) => z.type === 'stage' && z.group === 0).map((z) => z.index).sort((a, b) => a - b);
    expect(stages[0]).toBe(2);
    expect(kitsune!.some((z) => z.type === 'start' && z.group === 0)).toBe(true);
    expect(kitsune!.some((z) => z.type === 'end' && z.group === 0)).toBe(true);
    for (const z of kitsune!) {
      expect(z.mins.x).toBeLessThanOrEqual(z.maxs.x);
      expect(z.mins.z).toBeLessThanOrEqual(z.maxs.z);
    }
    const utopia = await getPresetZoneCandidates('surf_utopia_njv');
    expect(utopia[0]?.key).toBe('surf_utopia_v3');
  });
});

const ARCHIVES = process.env.SURF_TEST_ARCHIVES;
describe.skipIf(!ARCHIVES || !existsSync(ARCHIVES))('archive extraction', () => {
  it('extracts the BSP from a KSF .rar', async () => {
    const { extractMapArchive } = await import('../src/maps/downloader');
    const buf = readFileSync(join(ARCHIVES!, 'surf_kitsune.rar'));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const { name, bsp } = await extractMapArchive(ab, 'surf_kitsune.rar');
    expect(name).toBe('surf_kitsune');
    const sig = new TextDecoder().decode(new Uint8Array(bsp, 0, 4));
    expect(sig).toBe('VBSP');
    expect(bsp.byteLength).toBeGreaterThan(1_000_000);
  });
});
