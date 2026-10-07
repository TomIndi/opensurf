// Real-map tests. Set SURF_TEST_MAPS to a directory of .bsp files (CS:S v20 KSF maps were used during
// development); optionally SURF_TEST_MAPS_LARGE to a directory or file with very large maps. Skipped when
// unset, so CI without maps stays green.
//   SURF_TEST_MAPS=/path/to/maps npx vitest run tests/bsp_maps.test.ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBrushModels, buildDisplacementBrushes, brushEntityPlacement, displacementSurface, dispFlags, isSolidBrushEntity } from '../src/bsp/bspcollision';
import { allModelBrushIndices, brushModelMap, faceAreas, modelBrushIndices, pointLeaf } from '../src/bsp/bsptree';
import { parseEntities } from '../src/bsp/entities';
import { parseBsp, validateBsp } from '../src/bsp/reader';
import { BspFile } from '../src/bsp/types';
import { BrushModelInfo, MapEntity } from '../src/map/types';
import { CollisionWorld } from '../src/physics/collision';
import { Brush, CONTENTS_SOLID, MASK_PLAYERSOLID } from '../src/physics/types';

function listMaps(env: string | undefined): string[] {
  if (!env || !existsSync(env)) return [];
  if (statSync(env).isFile()) return env.endsWith('.bsp') ? [env] : [];
  return readdirSync(env)
    .filter((f) => f.toLowerCase().endsWith('.bsp'))
    .sort()
    .map((f) => join(env, f));
}

const MAPS = [...listMaps(process.env.SURF_TEST_MAPS), ...listMaps(process.env.SURF_TEST_MAPS_LARGE)];

function load(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe.skipIf(MAPS.length === 0)('real maps', () => {
  for (const path of MAPS) {
    const name = basename(path, '.bsp');
    describe(name, () => {
      let bsp: BspFile;
      let ents: MapEntity[];
      let models: BrushModelInfo[];
      let parseMs = 0;

      beforeAll(() => {
        const buf = load(path);
        const t = performance.now();
        bsp = parseBsp(buf);
        parseMs = performance.now() - t;
        ents = parseEntities(bsp.entitiesText);
        models = buildBrushModels(bsp, { entities: ents });
        console.log(
          `[bsp] ${name}: v${bsp.version} parsed in ${parseMs.toFixed(0)} ms - ${bsp.planes.length} planes, ${bsp.faces.length} faces, ` +
            `${bsp.brushes.length} brushes, ${bsp.models.length} models, ${bsp.dispInfos.length} displacements, ${ents.length} entities`,
        );
      });
      afterAll(() => {
        // release the big buffers between maps
        bsp = undefined as unknown as BspFile;
        models = [];
        ents = [];
      });

      it('parses with sane counts, no warnings and valid cross references', () => {
        expect([19, 20, 21]).toContain(bsp.version);
        expect(bsp.warnings).toEqual([]);
        expect(validateBsp(bsp)).toEqual([]);
        expect(bsp.planes.length).toBeGreaterThan(100);
        expect(bsp.vertices.length / 3).toBeGreaterThan(100);
        expect(bsp.faces.length).toBeGreaterThan(100);
        expect(bsp.brushes.length).toBeGreaterThan(10);
        expect(bsp.nodes.length).toBeGreaterThan(10);
        expect(bsp.leafs.length).toBeGreaterThan(10);
        expect(bsp.models.length).toBeGreaterThan(0);
        expect(bsp.texdataNames.every((n) => n.length > 0)).toBe(true);
        expect(bsp.pakfile).not.toBeNull();
        expect(bsp.gameLumps.some((g) => g.id === 'sprp')).toBe(true);
        expect(parseMs).toBeLessThan(5000);
      });

      it('parses every entity of the lump', () => {
        const count = (bsp.entitiesText.match(/"classname"/gi) ?? []).length;
        expect(ents.length).toBe(count);
        expect(ents[0].classname).toBe('worldspawn');
        expect(ents.every((e) => e.classname.length > 0)).toBe(true);
        for (const e of ents) if (e.model >= 0) expect(e.model).toBeLessThan(bsp.models.length);
      });

      it('keeps world and brush entity brushes disjoint', () => {
        const owner = new Int32Array(bsp.brushes.length).fill(-1);
        let shared = 0;
        for (let m = 0; m < bsp.models.length; m++) {
          for (const b of modelBrushIndices(bsp, m)) {
            if (owner[b] >= 0) shared++;
            else owner[b] = m;
          }
        }
        expect(shared).toBe(0);
        expect(Array.from(brushModelMap(bsp))).toEqual(Array.from(owner));
        const lists = allModelBrushIndices(bsp);
        for (let m = 0; m < bsp.models.length; m++) expect(lists[m]).toEqual(modelBrushIndices(bsp, m));
        expect(modelBrushIndices(bsp, 0).length).toBeGreaterThan(0);
      });

      it('builds brush models: >= 99% of BSP brushes with a valid AABB', () => {
        let total = 0;
        for (let m = 0; m < bsp.models.length; m++) total += modelBrushIndices(bsp, m).length;
        let valid = 0;
        for (const m of models) {
          for (const b of m.brushes) {
            const ok =
              [b.mins.x, b.mins.y, b.mins.z, b.maxs.x, b.maxs.y, b.maxs.z].every(Number.isFinite) &&
              b.mins.x <= b.maxs.x &&
              b.mins.y <= b.maxs.y &&
              b.mins.z <= b.maxs.z;
            if (ok) valid++;
            expect(b.model).toBe(m.index);
          }
        }
        expect(valid / total).toBeGreaterThanOrEqual(0.99);
      });

      it('places brush entity models on their entities', () => {
        for (const e of ents) {
          if (e.model <= 0 || models[e.model].brushes.length === 0) continue;
          const p = brushEntityPlacement(e);
          if (p.angles.pitch || p.angles.yaw || p.angles.roll) continue;
          const lump = bsp.models[e.model];
          const placed = models[e.model];
          for (const k of ['x', 'y', 'z'] as const) {
            const want = (lump.mins[k] + lump.maxs[k]) / 2 + e.origin[k];
            expect(Math.abs((placed.mins[k] + placed.maxs[k]) / 2 - want)).toBeLessThan(1);
          }
        }
      });

      it('puts every spawn point in open space', () => {
        const spawns = ents.filter((e) => e.classname.startsWith('info_player_'));
        expect(spawns.length).toBeGreaterThan(0);
        for (const s of spawns) {
          const leaf = pointLeaf(bsp, { x: s.origin.x, y: s.origin.y, z: s.origin.z + 32 });
          expect(leaf).toBeGreaterThanOrEqual(0);
          expect(bsp.leafs[leaf].contents & CONTENTS_SOLID, `${s.classname} @ ${JSON.stringify(s.origin)}`).toBe(0);
        }
      });

      it('assigns a BSP area to (almost) every world face', () => {
        const areas = faceAreas(bsp);
        const w = bsp.models[0];
        let withArea = 0;
        for (let f = w.firstFace; f < w.firstFace + w.numFaces; f++) if (areas[f] >= 1) withArea++;
        expect(withArea / w.numFaces).toBeGreaterThan(0.99);
      });

      it('rebuilds displacements whose shared edges line up with their neighbours', () => {
        if (bsp.dispInfos.length === 0) return;
        let boundary = 0;
        const seen = new Map<string, number>();
        for (let i = 0; i < bsp.dispInfos.length; i++) {
          const s = displacementSurface(bsp, i);
          expect(s, `displacement ${i}`).not.toBeNull();
          const n = s!.size;
          for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
              if (r !== 0 && c !== 0 && r !== n - 1 && c !== n - 1) continue;
              boundary++;
              const o = (r * n + c) * 3;
              const key = `${Math.round(s!.positions[o] * 4)},${Math.round(s!.positions[o + 1] * 4)},${Math.round(s!.positions[o + 2] * 4)}`;
              seen.set(key, (seen.get(key) ?? 0) + 1);
            }
          }
        }
        let shared = 0;
        for (const v of seen.values()) if (v > 1) shared += v;
        if (bsp.dispInfos.length >= 50) expect(shared / boundary).toBeGreaterThan(0.8);
      });

      it('builds displacement collision', () => {
        const t = performance.now();
        const prisms = buildDisplacementBrushes(bsp);
        const ms = performance.now() - t;
        let tris = 0;
        for (let i = 0; i < bsp.dispInfos.length; i++) {
          if (dispFlags(bsp.dispInfos[i].minTess) & 4) continue;
          tris += 2 * (1 << bsp.dispInfos[i].power) ** 2;
        }
        console.log(`[bsp] ${name}: ${prisms.length} displacement prisms in ${ms.toFixed(0)} ms`);
        expect(prisms.length).toBeGreaterThanOrEqual(tris * 0.99);
        expect(prisms.length).toBeLessThanOrEqual(tris);
        if (name === 'surf_mesa_fixed') expect(prisms.length).toBeGreaterThan(100000);
      });

      it('collision world: no spawn starts stuck in solid', () => {
        const brushes: Brush[] = [];
        for (const b of models[0].brushes) brushes.push(b);
        for (const e of ents) if (e.model > 0 && isSolidBrushEntity(e)) for (const b of models[e.model].brushes) brushes.push(b);
        for (const b of buildDisplacementBrushes(bsp)) brushes.push(b);
        const world = new CollisionWorld(brushes);
        for (const s of ents) {
          if (!s.classname.startsWith('info_player_')) continue;
          const o = { x: s.origin.x, y: s.origin.y, z: s.origin.z + 1 };
          expect(world.testBox(o, { x: -16, y: -16, z: 0 }, { x: 16, y: 16, z: 72 }, MASK_PLAYERSOLID), `${s.classname} @ ${JSON.stringify(s.origin)}`).toBe(false);
        }
      });
    });
  }
});

// ------------------------------------------------------------------------------------------------------
// CS:GO-style repack: a real v20 map rewritten as v21 with every lump LZMA-compressed (except the pakfile),
// fourCC = uncompressed size, and individually compressed game lumps (flag 1, filelen = uncompressed size,
// terminating dummy entry) - the layout CS:GO's compressed BSPs use. The parse must match the original.
const HAS_PYTHON = spawnSync('python3', ['-I', '-c', 'import lzma'], { encoding: 'utf8' }).status === 0;
const REPACK_SRC = MAPS.length ? (MAPS.find((m) => basename(m) === 'surf_beginner.bsp') ?? MAPS.slice().sort((a, b) => statSync(a).size - statSync(b).size)[0]) : null;

const REPACK_SCRIPT = `
import lzma, struct, sys
src, dst = sys.argv[1], sys.argv[2]
d = open(src, 'rb').read()
ident, version = struct.unpack_from('<4si', d, 0)
lumps = [struct.unpack_from('<iiii', d, 8 + i * 16) for i in range(64)]
rev = struct.unpack_from('<i', d, 8 + 64 * 16)[0]
def comp(data):
    raw = lzma.compress(data, format=lzma.FORMAT_RAW, filters=[{'id': lzma.FILTER_LZMA1, 'preset': 1, 'dict_size': 1 << 20}])
    return b'LZMA' + struct.pack('<II', len(data), len(raw)) + bytes([93]) + struct.pack('<I', 1 << 20) + raw
body = bytearray()
hdr = [(0, 0, 0, 0)] * 64
base = 8 + 64 * 16 + 4
def align():
    while (base + len(body)) % 4: body.append(0)
for i in sorted(range(64), key=lambda k: lumps[k][0]):
    ofs, ln, ver, cc = lumps[i]
    if ln <= 0 or i == 35: continue
    data = d[ofs:ofs + ln]
    align()
    pos = base + len(body)
    if i == 40:
        body += data; hdr[i] = (pos, len(data), ver, 0)
    else:
        c = comp(data); body += c; hdr[i] = (pos, len(c), ver, len(data))
# game lump last: directory + compressed payloads with absolute offsets
ofs, ln, ver, cc = lumps[35]
g = d[ofs:ofs + ln]
count = struct.unpack_from('<i', g, 0)[0]
ents = [struct.unpack_from('<IHHii', g, 4 + k * 16) for k in range(count)]
align()
gpos = base + len(body)
dirsize = 4 + (count + 1) * 16
blobs = []
cur = gpos + dirsize
for (gid, flags, gver, gofs, glen) in ents:
    c = comp(d[gofs:gofs + glen])
    blobs.append((gid, gver, cur, glen, c)); cur += len(c)
gl = bytearray(struct.pack('<i', count + 1))
for (gid, gver, at, glen, c) in blobs: gl += struct.pack('<IHHii', gid, 1, gver, at, glen)
gl += struct.pack('<IHHii', 0, 0, 0, cur, 0)
for b in blobs: gl += b[4]
body += gl
hdr[35] = (gpos, len(gl), ver, 0)
out = bytearray(b'VBSP' + struct.pack('<i', 21))
for h in hdr: out += struct.pack('<iiii', *h)
out += struct.pack('<i', rev)
out += body
open(dst, 'wb').write(out)
`;

describe.skipIf(!REPACK_SRC || !HAS_PYTHON)('CS:GO-style LZMA repack of a real map', () => {
  it('parses the compressed v21 file identically to the original', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surf-v21-'));
    try {
      const dst = join(dir, 'repacked.bsp');
      const r = spawnSync('python3', ['-I', '-c', REPACK_SCRIPT, REPACK_SRC!, dst], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const a = parseBsp(load(REPACK_SRC!));
      const t = performance.now();
      const b = parseBsp(load(dst));
      console.log(`[bsp] ${basename(REPACK_SRC!)} repacked as v21+LZMA parsed in ${(performance.now() - t).toFixed(0)} ms`);
      expect(b.version).toBe(21);
      expect(b.warnings).toEqual([]);
      expect(b.lumps[1].fourCC).toBe(a.lumps[1].length); // compressed lumps carry their real size
      expect(b.entitiesText).toBe(a.entitiesText);
      expect(b.planes).toEqual(a.planes);
      expect(Array.from(b.vertices)).toEqual(Array.from(a.vertices));
      expect(Array.from(b.surfedges)).toEqual(Array.from(a.surfedges));
      expect(Array.from(b.edges)).toEqual(Array.from(a.edges));
      expect(b.faces).toEqual(a.faces);
      expect(b.texinfo).toEqual(a.texinfo);
      expect(b.texdataNames).toEqual(a.texdataNames);
      expect(b.brushes).toEqual(a.brushes);
      expect(b.brushSides).toEqual(a.brushSides);
      expect(b.nodes).toEqual(a.nodes);
      expect(b.leafs).toEqual(a.leafs);
      expect(Array.from(b.leafFaces)).toEqual(Array.from(a.leafFaces));
      expect(Array.from(b.leafBrushes)).toEqual(Array.from(a.leafBrushes));
      expect(b.models).toEqual(a.models);
      expect(b.dispInfos).toEqual(a.dispInfos);
      expect(b.dispVerts).toEqual(a.dispVerts);
      expect(Array.from(b.dispTris)).toEqual(Array.from(a.dispTris));
      expect(b.lighting?.length).toBe(a.lighting?.length);
      expect(Buffer.compare(Buffer.from(b.lighting ?? []), Buffer.from(a.lighting ?? []))).toBe(0);
      expect(b.pakfile?.length).toBe(a.pakfile?.length);
      expect(b.gameLumps.map((g) => [g.id, g.version, g.flags, g.data.length])).toEqual(a.gameLumps.map((g) => [g.id, g.version, 1, g.data.length]));
      for (let i = 0; i < a.gameLumps.length; i++) expect(Buffer.compare(Buffer.from(b.gameLumps[i].data), Buffer.from(a.gameLumps[i].data))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
