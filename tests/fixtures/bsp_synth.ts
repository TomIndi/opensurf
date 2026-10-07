// Tiny VBSP writer for unit tests: builds a minimal but fully cross-referenced map in memory.
//
// Scene ("box world"):
//   model 0 (world): floor brush [-512,-512,-64]..[512,512,0] (6 axial sides + nothing else),
//     tree: node 0 splits at z = 0; front (z >= 0) = leaf 1 (empty, area 1, cluster 0, face 0),
//     back = leaf 0 (solid, brush 0). Face 0 = the floor's top quad; face 1 = a 64x64 quad carrying a
//     power-1 displacement whose centre vertex is raised by 16 units.
//   model 1 (func_brush "*1"): 32-unit cube centred on the model origin, tree node 1 splits at x = 0 so
//     the brush is referenced by both leaves 2 and 3. Entity origin "100 0 50".
//   model 2 (trigger_push "*2"): 64x16x16 box, entity origin "0 300 40", angles "0 90 0".
import { spawnSync } from 'node:child_process';

export interface SynthLump {
  index: number;
  data: Uint8Array;
  version?: number;
  fourCC?: number;
}

export interface WriteOptions {
  version?: number;
  mapRevision?: number;
  /** Lump alignment in the file (default 4; 1 = pack lumps back to back, unaligned). */
  align?: number;
  /** Write Left 4 Dead 2's lump_t field order {version, fileofs, filelen, fourCC}. */
  l4d2Order?: boolean;
  /** Bytes to insert before the first lump (to create odd offsets). */
  pad?: number;
}

export const HEADER_SIZE = 8 + 64 * 16 + 4;

/** Writes a BSP file. Game lump directory entries may reference `gameLumpPayloads` (appended at the end). */
export function writeBsp(lumps: SynthLump[], opts: WriteOptions = {}): ArrayBuffer {
  const align = opts.align ?? 4;
  let size = HEADER_SIZE + (opts.pad ?? 0);
  const placed: { l: SynthLump; ofs: number }[] = [];
  for (const l of lumps) {
    size = Math.ceil(size / align) * align;
    placed.push({ l, ofs: size });
    size += l.data.length;
  }
  const buf = new ArrayBuffer(size);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  u8.set([0x56, 0x42, 0x53, 0x50], 0); // VBSP
  dv.setInt32(4, opts.version ?? 20, true);
  for (const { l, ofs } of placed) {
    const o = 8 + l.index * 16;
    if (opts.l4d2Order) {
      dv.setInt32(o, l.version ?? 0, true);
      dv.setInt32(o + 4, ofs, true);
      dv.setInt32(o + 8, l.data.length, true);
    } else {
      dv.setInt32(o, ofs, true);
      dv.setInt32(o + 4, l.data.length, true);
      dv.setInt32(o + 8, l.version ?? 0, true);
    }
    dv.setInt32(o + 12, l.fourCC ?? 0, true);
    u8.set(l.data, ofs);
  }
  dv.setInt32(8 + 64 * 16, opts.mapRevision ?? 7, true);
  return buf;
}

/** Little-endian record builder. */
export class Rec {
  private bytes: number[] = [];
  private dv = new DataView(new ArrayBuffer(8));
  private push(n: number): this {
    for (let i = 0; i < n; i++) this.bytes.push(this.dv.getUint8(i));
    return this;
  }
  f32(v: number): this {
    this.dv.setFloat32(0, v, true);
    return this.push(4);
  }
  i32(v: number): this {
    this.dv.setInt32(0, v, true);
    return this.push(4);
  }
  u32(v: number): this {
    this.dv.setUint32(0, v, true);
    return this.push(4);
  }
  i16(v: number): this {
    this.dv.setInt16(0, v, true);
    return this.push(2);
  }
  u16(v: number): this {
    this.dv.setUint16(0, v, true);
    return this.push(2);
  }
  u8(v: number): this {
    this.bytes.push(v & 255);
    return this;
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.bytes.push(0);
    return this;
  }
  str(s: string): this {
    for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i) & 255);
    return this;
  }
  get length(): number {
    return this.bytes.length;
  }
  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export interface BoxWorldOptions extends WriteOptions {
  /** Leaf lump version: 1 (32-byte leafs, default) or 0 (56-byte leafs with ambient cube). */
  leafVersion?: number;
  /** Put the faces in LUMP_FACES_HDR only. */
  hdrFacesOnly?: boolean;
  /** Replace a lump's bytes with a pre-built (e.g. LZMA-compressed) payload. */
  override?: Record<number, { data: Uint8Array; fourCC?: number }>;
  /** dispinfo minTess (e.g. 0x80000000 | 4 = no hull collision). */
  dispMinTess?: number;
  entities?: string;
}

export const BOX_ENTITIES = `{
"classname" "worldspawn"
"skyname" "sky_test"
}
{
"classname" "info_player_start"
"origin" "0 0 1"
"angles" "0 90 0"
}
{
"classname" "func_brush"
"model" "*1"
"origin" "100 0 50"
"solidity" "0"
}
{
"classname" "trigger_push"
"model" "*2"
"origin" "0 300 40"
"angles" "0 90 0"
"pushdir" "0 90 0"
"speed" "500"
"OnStartTouch" "!activator,AddOutput,gravity 0.5,0,-1"
}
`;

/** Builds the box world described at the top of this file. */
export function buildBoxWorld(o: BoxWorldOptions = {}): { buffer: ArrayBuffer; lumps: Map<number, Uint8Array> } {
  const lumps = new Map<number, Uint8Array>();

  // planes: 0..5 floor box sides (-x +x -y +y -z +z), 6..11 cube1, 12..17 box2, 18 split x=0
  const planes = new Rec();
  const plane = (nx: number, ny: number, nz: number, d: number) => {
    const type = Math.abs(nx) === 1 ? 0 : Math.abs(ny) === 1 ? 1 : Math.abs(nz) === 1 ? 2 : 3;
    planes.f32(nx).f32(ny).f32(nz).f32(d).i32(type);
  };
  const boxPlanes = (mins: number[], maxs: number[]) => {
    plane(-1, 0, 0, -mins[0]);
    plane(1, 0, 0, maxs[0]);
    plane(0, -1, 0, -mins[1]);
    plane(0, 1, 0, maxs[1]);
    plane(0, 0, -1, -mins[2]);
    plane(0, 0, 1, maxs[2]);
  };
  boxPlanes([-512, -512, -64], [512, 512, 0]);
  boxPlanes([-16, -16, -16], [16, 16, 16]);
  boxPlanes([-32, -8, -8], [32, 8, 8]);
  plane(1, 0, 0, 0); // 18
  lumps.set(1, planes.build());

  // vertices: floor top quad 0..3, disp quad 4..7
  const verts = new Rec();
  for (const [x, y, z] of [
    [-512, -512, 0],
    [512, -512, 0],
    [512, 512, 0],
    [-512, 512, 0],
    [0, 0, 0],
    [64, 0, 0],
    [64, 64, 0],
    [0, 64, 0],
  ]) verts.f32(x).f32(y).f32(z);
  lumps.set(3, verts.build());

  // edges: 0 is the unused dummy edge (like vbsp), then quads
  const edges = new Rec();
  edges.u16(0).u16(0);
  for (const [a, b] of [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
  ]) edges.u16(a).u16(b);
  lumps.set(12, edges.build());
  const surf = new Rec();
  // face 0 uses edges 1..4 forwards; face 1 uses edges 5..8 backwards (negative surfedges) to cover both cases
  surf.i32(1).i32(2).i32(3).i32(4).i32(-8).i32(-7).i32(-6).i32(-5);
  lumps.set(13, surf.build());

  // faces (56 bytes)
  const faces = new Rec();
  const face = (planeNum: number, firstEdge: number, dispInfo: number, area: number) => {
    faces.u16(planeNum).u8(0).u8(1).i32(firstEdge).i16(4).i16(0).i16(dispInfo).i16(-1);
    faces.u8(0).u8(255).u8(255).u8(255).i32(-1).f32(area).i32(0).i32(0).i32(16).i32(16).i32(0).u16(0).u16(0).u32(0);
  };
  face(5, 0, -1, 1024 * 1024);
  face(5, 4, 0, 64 * 64);
  lumps.set(o.hdrFacesOnly ? 58 : 7, faces.build());

  // texinfo (72 bytes) + texdata (32) + strings
  const texinfo = new Rec();
  for (let k = 0; k < 8; k++) texinfo.f32(k === 0 || k === 5 ? 0.25 : 0);
  for (let k = 0; k < 8; k++) texinfo.f32(k === 0 || k === 5 ? 1 / 16 : 0);
  texinfo.i32(0).i32(0);
  lumps.set(6, texinfo.build());
  const texdata = new Rec();
  texdata.f32(0.5).f32(0.25).f32(0.125).i32(0).i32(512).i32(256).i32(512).i32(256);
  lumps.set(2, texdata.build());
  lumps.set(43, new Rec().str('DEV/DEV_MEASUREGENERIC01\0').build());
  lumps.set(44, new Rec().i32(0).build());

  // brushes + sides: brush 0 = sides 0..5, brush 1 = 6..11, brush 2 = 12..17 (with an extra bevel-flagged side)
  const brushes = new Rec();
  brushes.i32(0).i32(6).i32(1); // CONTENTS_SOLID
  brushes.i32(6).i32(6).i32(1);
  brushes.i32(12).i32(7).i32(0x40000000 | 0); // trigger-ish contents (hitbox bit), any value is kept verbatim
  lumps.set(18, brushes.build());
  const sides = new Rec();
  for (let p = 0; p < 18; p++) sides.u16(p).i16(0).i16(-1).u8(0).u8(0);
  sides.u16(13).i16(0).i16(-1).u8(1).u8(1); // brush 2's 7th side: duplicate +x plane flagged bevel + thin
  lumps.set(19, sides.build());

  // nodes: 0 (world, z split), 1 (model 1, x split), 2 (model 2, x split)
  const nodes = new Rec();
  const node = (planeNum: number, c0: number, c1: number, mins: number[], maxs: number[], firstFace: number, numFaces: number) => {
    nodes.i32(planeNum).i32(c0).i32(c1);
    for (const v of mins) nodes.i16(v);
    for (const v of maxs) nodes.i16(v);
    nodes.u16(firstFace).u16(numFaces).i16(1).i16(0);
  };
  node(5, -2, -1, [-512, -512, -64], [512, 512, 512], 0, 2); // front leaf 1, back leaf 0
  node(18, -3, -4, [-16, -16, -16], [16, 16, 16], 0, 0); // leafs 2 / 3
  node(18, -5, -6, [-32, -8, -8], [32, 8, 8], 0, 0); // leafs 4 / 5
  lumps.set(5, nodes.build());

  // leafs
  const leafVersion = o.leafVersion ?? 1;
  const leafs = new Rec();
  const leaf = (contents: number, cluster: number, area: number, flags: number, lf: number[], lb: number[]) => {
    leafs.i32(contents).i16(cluster).u16((area & 0x1ff) | ((flags & 0x7f) << 9));
    leafs.i16(-512).i16(-512).i16(-64).i16(512).i16(512).i16(512);
    leafs.u16(lf[0]).u16(lf[1]).u16(lb[0]).u16(lb[1]).i16(-1);
    if (leafVersion === 0) leafs.zeros(24);
    leafs.zeros(2);
  };
  leaf(1, -1, 0, 0, [0, 0], [0, 1]); // 0: solid, brush 0
  leaf(0, 0, 1, 3, [0, 2], [1, 0]); // 1: empty, area 1, faces 0 and 1
  leaf(1, -1, 0, 0, [0, 0], [1, 1]); // 2: model 1, brush 1
  leaf(1, -1, 0, 0, [0, 0], [1, 1]); // 3: model 1, brush 1 again
  leaf(1, -1, 0, 0, [0, 0], [2, 1]); // 4: model 2, brush 2
  leaf(0, -1, 0, 0, [0, 0], [3, 0]); // 5: empty
  lumps.set(10, leafs.build());
  lumps.set(16, new Rec().u16(0).u16(1).build());
  lumps.set(17, new Rec().u16(0).u16(1).u16(2).build());

  // models (48 bytes)
  const models = new Rec();
  const model = (mins: number[], maxs: number[], head: number, firstFace: number, numFaces: number) => {
    for (const v of mins) models.f32(v);
    for (const v of maxs) models.f32(v);
    models.f32(0).f32(0).f32(0).i32(head).i32(firstFace).i32(numFaces);
  };
  model([-512, -512, -64], [512, 512, 0], 0, 0, 2);
  model([-16, -16, -16], [16, 16, 16], 1, 0, 0);
  model([-32, -8, -8], [32, 8, 8], 2, 0, 0);
  lumps.set(14, models.build());

  // displacement on face 1: power 1 -> 3x3 vertices, centre raised by 16
  const disp = new Rec();
  disp.f32(0).f32(0).f32(0).i32(0).i32(0).i32(1).i32(o.dispMinTess ?? (0x80000000 | 0)).f32(0).i32(1).u16(1).u16(0).i32(-1).i32(-1);
  disp.zeros(176 - disp.length);
  lumps.set(26, disp.build());
  const dverts = new Rec();
  for (let i = 0; i < 9; i++) dverts.f32(0).f32(0).f32(1).f32(i === 4 ? 16 : 0).f32(0);
  lumps.set(33, dverts.build());
  lumps.set(48, new Rec().u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).build());

  // lighting (fake samples), pakfile (fake zip bytes)
  lumps.set(8, new Rec().u8(10).u8(20).u8(30).u8(0).build());
  lumps.set(40, new Rec().str('PK\x05\x06').zeros(18).build());

  // entities (trailing NULs like vbsp writes)
  lumps.set(0, new Rec().str((o.entities ?? BOX_ENTITIES) + '\0').build());

  // overrides (e.g. LZMA-compressed lumps)
  const fourCCs = new Map<number, number>();
  for (const [k, v] of Object.entries(o.override ?? {})) {
    lumps.set(Number(k), v.data);
    if (v.fourCC !== undefined) fourCCs.set(Number(k), v.fourCC);
  }

  // game lump: directory + one absolute-offset payload placed right after the directory
  const list: SynthLump[] = [];
  for (const [index, data] of lumps) {
    list.push({ index, data, version: index === 10 ? leafVersion : index === 7 || index === 58 ? 1 : 0, fourCC: fourCCs.get(index) });
  }
  // compute where the game lump will land to write absolute offsets: place it last
  const provisional = writeBsp(list, o);
  const gameDirSize = 4 + 2 * 16;
  const align = o.align ?? 4;
  const gameOfs = Math.ceil(provisional.byteLength / align) * align;
  const payload = new Rec().str('sprp-payload');
  const gl = new Rec();
  gl.i32(2);
  gl.u32(0x73707270).u16(0).u16(6).i32(gameOfs + gameDirSize).i32(payload.length); // 'sprp'
  gl.u32(0x64707270).u16(0).u16(4).i32(gameOfs + gameDirSize + payload.length).i32(4); // 'dprp'
  const glBytes = new Uint8Array(gameDirSize + payload.length + 4);
  glBytes.set(gl.build(), 0);
  glBytes.set(payload.build(), gameDirSize);
  glBytes.set([1, 2, 3, 4], gameDirSize + payload.length);
  list.push({ index: 35, data: glBytes });
  const buffer = writeBsp(list, o);
  lumps.set(35, glBytes);
  return { buffer, lumps };
}

/** Wraps data in Valve's LZMA header using python3's liblzma; null when python3 isn't available. */
export function pythonSourceLzma(data: Uint8Array): Uint8Array | null {
  const script = `
import lzma, struct, sys
data = sys.stdin.buffer.read()
raw = lzma.compress(data, format=lzma.FORMAT_RAW, filters=[{'id': lzma.FILTER_LZMA1, 'lc': 3, 'lp': 0, 'pb': 2, 'dict_size': 1 << 16}])
sys.stdout.buffer.write(b'LZMA' + struct.pack('<II', len(data), len(raw)) + bytes([93]) + struct.pack('<I', 1 << 16) + raw)
`;
  const r = spawnSync('python3', ['-I', '-c', script], { input: data, maxBuffer: 1 << 26 });
  if (r.status !== 0 || !r.stdout) return null;
  return new Uint8Array(r.stdout);
}
