// Timer zone presets (SurfTimer's ck_zones, GPL-3.0 data shipped in public/maps/zones.json) and
// user-made zones (zone editor, stored in localStorage).
import { v3 } from '../core/vec3';
import { ZoneDef, ZoneType } from '../map/types';
import { publicUrl } from './catalog';

interface PresetZone {
  t: ZoneType;
  g: number;
  i: number;
  a: [number, number, number];
  b: [number, number, number];
  p?: number;
}

interface ZonesFile {
  maps: Record<string, PresetZone[]>;
  aliases: Record<string, string[]>;
}

let zonesFile: Promise<ZonesFile | null> | null = null;

function loadZonesFile(): Promise<ZonesFile | null> {
  if (!zonesFile) {
    zonesFile = (async () => {
      try {
        const res = await fetch(publicUrl('maps/zones.json'));
        if (!res.ok) return null;
        return (await res.json()) as ZonesFile;
      } catch {
        return null;
      }
    })();
  }
  return zonesFile;
}

/** Installs a zones file directly (tests). */
export function setZonesFile(file: ZonesFile | null): void {
  zonesFile = Promise.resolve(file);
}

export function presetToZoneDef(z: PresetZone): ZoneDef {
  const def: ZoneDef = {
    type: z.t,
    group: z.g,
    index: z.i,
    mins: v3(z.a[0], z.a[1], z.a[2]),
    maxs: v3(z.b[0], z.b[1], z.b[2]),
  };
  if (z.p !== undefined) def.prespeed = z.p;
  return def;
}

/** All preset candidates for a map: the exact name first, then other builds of the same map. */
export async function getPresetZoneCandidates(mapName: string): Promise<{ key: string; zones: ZoneDef[] }[]> {
  const file = await loadZonesFile();
  if (!file) return [];
  const name = mapName.toLowerCase();
  const keys: string[] = [];
  if (file.maps[name]) keys.push(name);
  for (const k of file.aliases[name] ?? []) if (!keys.includes(k) && file.maps[k]) keys.push(k);
  return keys.map((key) => ({ key, zones: file.maps[key].map(presetToZoneDef) }));
}

/** SurfTimer zone preset for the map (best name match), or null. */
export async function getPresetZones(mapName: string): Promise<ZoneDef[] | null> {
  const c = await getPresetZoneCandidates(mapName);
  return c.length ? c[0].zones : null;
}

// ---------------------------------------------------------------- user zones

const USER_KEY = (map: string) => `surf.zones.user.v1.${map.toLowerCase()}`;

interface StoredZone {
  type: ZoneType;
  group: number;
  index: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  prespeed?: number;
  spawn?: { origin: [number, number, number]; angles: [number, number, number] };
}

export function loadUserZones(mapName: string): ZoneDef[] | null {
  try {
    const raw = localStorage.getItem(USER_KEY(mapName));
    if (!raw) return null;
    const list = JSON.parse(raw) as StoredZone[];
    if (!Array.isArray(list) || !list.length) return null;
    return list.map((z) => {
      const d: ZoneDef = {
        type: z.type,
        group: z.group | 0,
        index: z.index | 0,
        mins: v3(...z.mins),
        maxs: v3(...z.maxs),
      };
      if (z.prespeed !== undefined) d.prespeed = z.prespeed;
      if (z.spawn)
        d.spawn = {
          origin: v3(...z.spawn.origin),
          angles: { pitch: z.spawn.angles[0], yaw: z.spawn.angles[1], roll: z.spawn.angles[2] },
        };
      return d;
    });
  } catch {
    return null;
  }
}

export function saveUserZones(mapName: string, zones: ZoneDef[] | null): void {
  try {
    if (!zones || !zones.length) {
      localStorage.removeItem(USER_KEY(mapName));
      return;
    }
    const list: StoredZone[] = zones.map((z) => {
      const s: StoredZone = {
        type: z.type,
        group: z.group,
        index: z.index,
        mins: [z.mins.x, z.mins.y, z.mins.z],
        maxs: [z.maxs.x, z.maxs.y, z.maxs.z],
      };
      if (z.prespeed !== undefined) s.prespeed = z.prespeed;
      if (z.spawn)
        s.spawn = {
          origin: [z.spawn.origin.x, z.spawn.origin.y, z.spawn.origin.z],
          angles: [z.spawn.angles.pitch, z.spawn.angles.yaw, z.spawn.angles.roll],
        };
      return s;
    });
    localStorage.setItem(USER_KEY(mapName), JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}
