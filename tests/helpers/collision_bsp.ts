// Minimal VBSP brush reader for collision tests on real maps (independent of the bsp-core module so the
// collision tests don't depend on it). Reads planes, brushes, brush sides, the model 0 tree and the
// entity lump. Only uncompressed lumps (CS:S v19/v20 maps) are supported.
import { readFileSync } from 'node:fs';
import { Vec3, v3 } from '../../src/core/vec3';
import { computeBrushBounds } from '../../src/physics/brushbuild';
import { Brush, BrushSide } from '../../src/physics/types';

export interface BspBrushes {
  version: number;
  /** All brushes of model 0 (world), with BSP-provided bevels; bounds computed from windings. */
  world: Brush[];
  /** Raw world brush count including degenerate ones that failed bounds. */
  rawWorldCount: number;
  spawns: Vec3[];
  entities: string;
}

export function readBspBrushes(path: string): BspBrushes | null {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x50534256) return null; // "VBSP"
  const version = dv.getInt32(4, true);
  const lump = (i: number) => {
    const o = 8 + i * 16;
    return { ofs: dv.getInt32(o, true), len: dv.getInt32(o + 4, true), ver: dv.getInt32(o + 8, true), fourCC: dv.getInt32(o + 12, true) };
  };
  for (const i of [0, 1, 5, 10, 14, 17, 18, 19]) if (lump(i).fourCC !== 0) return null; // LZMA lumps unsupported

  const pl = lump(1);
  const planes: { n: Vec3; d: number }[] = [];
  for (let o = pl.ofs; o + 20 <= pl.ofs + pl.len; o += 20) {
    planes.push({ n: v3(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)), d: dv.getFloat32(o + 12, true) });
  }
  const bl = lump(18);
  const sl = lump(19);
  const sideAt = (i: number): { plane: number; bevel: boolean } => {
    const o = sl.ofs + i * 8;
    return { plane: dv.getUint16(o, true), bevel: dv.getUint8(o + 6) !== 0 };
  };
  const nl = lump(5);
  const ll = lump(10);
  const leafSize = ll.ver === 0 ? 56 : 32;
  const lbl = lump(17);
  const ml = lump(14);
  const headNode = dv.getInt32(ml.ofs + 36, true);

  // walk the world tree
  const brushSet = new Set<number>();
  const stack = [headNode];
  while (stack.length) {
    const n = stack.pop()!;
    if (n < 0) {
      const leaf = -1 - n;
      const o = ll.ofs + leaf * leafSize;
      const first = dv.getUint16(o + 24, true);
      const num = dv.getUint16(o + 26, true);
      for (let k = 0; k < num; k++) brushSet.add(dv.getUint16(lbl.ofs + (first + k) * 2, true));
      continue;
    }
    const o = nl.ofs + n * 32;
    stack.push(dv.getInt32(o + 4, true), dv.getInt32(o + 8, true));
  }
  const world: Brush[] = [];
  const ids = [...brushSet].sort((a, b) => a - b);
  for (const bi of ids) {
    const o = bl.ofs + bi * 12;
    const firstSide = dv.getInt32(o, true);
    const numSides = dv.getInt32(o + 4, true);
    const contents = dv.getInt32(o + 8, true);
    const sides: BrushSide[] = [];
    for (let k = 0; k < numSides; k++) {
      const s = sideAt(firstSide + k);
      const p = planes[s.plane];
      sides.push({ plane: { normal: v3(p.n.x, p.n.y, p.n.z), dist: p.d }, bevel: s.bevel });
    }
    const brush: Brush = { sides, contents, mins: v3(), maxs: v3(), model: 0 };
    if (computeBrushBounds(brush)) world.push(brush);
  }

  const el = lump(0);
  const entities = new TextDecoder('latin1').decode(buf.subarray(el.ofs, el.ofs + el.len));
  const spawns: Vec3[] = [];
  const entRe = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = entRe.exec(entities))) {
    const body = m[1];
    const cls = /"classname"\s+"([^"]*)"/.exec(body)?.[1] ?? '';
    if (cls !== 'info_player_counterterrorist' && cls !== 'info_player_terrorist' && cls !== 'info_player_start') continue;
    const org = /"origin"\s+"([^"]*)"/.exec(body)?.[1];
    if (!org) continue;
    const [x, y, z] = org.trim().split(/\s+/).map(Number);
    spawns.push(v3(x, y, z));
  }
  return { version, world, rawWorldCount: ids.length, spawns, entities };
}
