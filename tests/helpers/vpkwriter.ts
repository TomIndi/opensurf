// Test-only writers: a VPK (v1/v2) builder and a minimal RGBA8888 VTF, for exercising the game content code
// without any real game files (written from the public format descriptions; see src/maps/vpk.ts).

export interface VpkFileSpec {
  /** "materials/concrete/concretewall011.vtf" */
  path: string;
  data: Uint8Array;
  /** Bytes stored in the directory tree (preload). */
  preload?: number;
  /** Store the rest after the tree in the _dir file (archive index 0x7fff). */
  inDir?: boolean;
  /** Numbered archive holding the data (default 0). */
  archive?: number;
}

export interface BuiltVpk {
  /** The "<name>_dir.vpk" file. */
  dir: Uint8Array;
  /** "<name>_NNN.vpk" files by index. */
  archives: Map<number, Uint8Array>;
}

/** Builds a VPK directory file and its numbered archives. */
export function buildVpk(files: VpkFileSpec[], version: 1 | 2 = 2): BuiltVpk {
  const tree: number[] = [];
  const dirData: number[] = [];
  const archives = new Map<number, number[]>();
  const str = (s: string) => {
    for (const c of s) tree.push(c.charCodeAt(0));
    tree.push(0);
  };
  const u16 = (v: number) => tree.push(v & 255, (v >> 8) & 255);
  const u32 = (v: number) => tree.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const byExt = new Map<string, Map<string, { name: string; f: VpkFileSpec }[]>>();
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const dir = slash >= 0 ? f.path.slice(0, slash) : ' ';
    const file = f.path.slice(slash + 1);
    const dot = file.lastIndexOf('.');
    const ext = dot >= 0 ? file.slice(dot + 1) : ' ';
    const name = dot >= 0 ? file.slice(0, dot) : file;
    if (!byExt.has(ext)) byExt.set(ext, new Map());
    const m = byExt.get(ext)!;
    if (!m.has(dir)) m.set(dir, []);
    m.get(dir)!.push({ name, f });
  }
  for (const [ext, dirs] of byExt) {
    str(ext);
    for (const [dir, list] of dirs) {
      str(dir);
      for (const { name, f } of list) {
        const preload = Math.min(f.preload ?? 0, f.data.length);
        str(name);
        u32(0); // crc (not checked)
        u16(preload);
        const rest = f.data.slice(preload);
        if (f.inDir) {
          u16(0x7fff);
          u32(dirData.length);
          for (const b of rest) dirData.push(b);
        } else {
          const idx = f.archive ?? 0;
          if (!archives.has(idx)) archives.set(idx, []);
          const a = archives.get(idx)!;
          u16(idx);
          u32(a.length);
          for (const b of rest) a.push(b);
        }
        u32(rest.length);
        u16(0xffff);
        for (const b of f.data.slice(0, preload)) tree.push(b);
      }
      str('');
    }
    str('');
  }
  str('');
  const headerSize = version === 1 ? 12 : 28;
  const out = new Uint8Array(headerSize + tree.length + dirData.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x55aa1234, true);
  dv.setUint32(4, version, true);
  dv.setUint32(8, tree.length, true);
  if (version === 2) dv.setUint32(12, dirData.length, true);
  out.set(tree, headerSize);
  out.set(dirData, headerSize + tree.length);
  const archOut = new Map<number, Uint8Array>();
  for (const [k, v] of archives) archOut.set(k, new Uint8Array(v));
  return { dir: out, archives: archOut };
}

/** A v7.2 VTF with one RGBA8888 mip of a solid colour (`rgba` 0..255). */
export function solidVtf(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const headerSize = 80;
  const out = new Uint8Array(headerSize + width * height * 4);
  const dv = new DataView(out.buffer);
  out.set([0x56, 0x54, 0x46, 0], 0);
  dv.setUint32(4, 7, true);
  dv.setUint32(8, 2, true);
  dv.setUint32(12, headerSize, true);
  dv.setUint16(16, width, true);
  dv.setUint16(18, height, true);
  dv.setUint32(20, 0, true); // flags
  dv.setUint16(24, 1, true); // frames
  dv.setUint16(26, 0, true); // first frame
  dv.setFloat32(32, rgba[0] / 255, true); // reflectivity
  dv.setFloat32(36, rgba[1] / 255, true);
  dv.setFloat32(40, rgba[2] / 255, true);
  dv.setFloat32(48, 1, true); // bump scale
  dv.setInt32(52, 0, true); // RGBA8888
  out[56] = 1; // mip count
  dv.setInt32(57, -1, true); // no low-res image
  out[61] = 0;
  out[62] = 0;
  dv.setUint16(63, 1, true); // depth
  for (let i = 0; i < width * height; i++) out.set(rgba, headerSize + i * 4);
  return out;
}

const te = new TextEncoder();
export const text = (s: string): Uint8Array => te.encode(s);

/** VPK file name of an archive index: "cstrike_pak_dir.vpk" (index -1) or "cstrike_pak_003.vpk". */
export function vpkFileName(base: string, index: number): string {
  return index < 0 ? `${base}_dir.vpk` : `${base}_${String(index).padStart(3, '0')}.vpk`;
}
