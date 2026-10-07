// In-game zone editor (console commands), for maps without presets or with zones that don't fit the build.
//
//   zone_edit                     toggle the editor (zone boxes drawn via getEditorDebugBoxes())
//   zone_add <type> [N] [group]   start a zone: start | end | stage N | checkpoint N | stop | teletostart |
//                                 speedstart | validator | checker | antijump | antiduck | maxspeed
//   zone_point                    first call: corner A at your feet; second: corner B (a flat box gets 128u of height)
//   zone_list / zone_delete <#>   list / remove zones of the working set
//   zone_setspawn [#]             where !r / !back put you for zone # (default: the start zone you stand in):
//                                 your current position and view
//   zone_prespeed <#> <u/s>       prespeed cap when leaving start zone # (0 = none)
//   zone_save                     store the working set as this map's user zones (they override presets)
//   zone_reset                    delete this map's user zones and re-resolve (preset / map / heuristic)
//   zone_export / zone_import <x> share zones (JSON or the compact "surfzones:..." code zone_export prints)
//
// Edits apply to the timer immediately; zone_save makes them permanent. The game core creates one ZoneEditor
// per loaded map and passes it to installZoneEditor(); the console commands are registered once.
import { conPrint, registerCommand } from '../core/cvars';
import { QAngle } from '../core/angles';
import { Vec3, v3 } from '../core/vec3';
import { LoadedMap, ZoneDef, ZoneSource, ZoneType } from '../map/types';
import { saveUserZones } from '../maps/zones';
import { ChatSegment } from './api';
import { ISurfTimer } from './contracts';
import { resolveZones, sanitizeZones } from './zoneresolve';

export interface ZoneEditorHost {
  readonly map: LoadedMap;
  readonly player: { origin: Vec3; viewAngles?: QAngle };
  /** Console output. */
  print(text: string): void;
}

const TYPES: ZoneType[] = [
  'start',
  'end',
  'stage',
  'checkpoint',
  'stop',
  'speedstart',
  'teletostart',
  'validator',
  'checker',
  'antijump',
  'antiduck',
  'maxspeed',
];

const INDEXED: ReadonlySet<ZoneType> = new Set<ZoneType>(['stage', 'checkpoint']);

const COLORS: Record<ZoneType, [number, number, number]> = {
  start: [0.2, 1.0, 0.3],
  speedstart: [0.2, 0.9, 0.65],
  end: [1.0, 0.25, 0.25],
  stage: [0.3, 0.6, 1.0],
  checkpoint: [1.0, 0.85, 0.2],
  stop: [1.0, 0.5, 0.1],
  teletostart: [0.8, 0.3, 1.0],
  validator: [0.4, 1.0, 1.0],
  checker: [1.0, 0.4, 0.7],
  antijump: [0.65, 0.65, 0.65],
  antiduck: [0.55, 0.55, 0.55],
  maxspeed: [0.9, 0.9, 0.5],
};
const PENDING_COLOR: [number, number, number] = [1, 1, 1];

/** Lines shown for the !zones chat command. */
export function zonesHelpLines(): string[] {
  return [
    'Zone editor (open the console with `):',
    'zone_edit - show zones / toggle the editor',
    'zone_add <start|end|stage N|checkpoint N|stop|teletostart> [bonus#] - begin a zone',
    'zone_point - set a corner at your feet (twice: opposite corners)',
    'zone_list, zone_delete <#> - list / remove zones',
    'zone_setspawn [#] - !r / !back spawn here (position + view)',
    'zone_prespeed <#> <u/s> - start zone speed cap (0 = none)',
    'zone_save - keep your zones for this map (they override presets)',
    'zone_reset - delete your zones for this map',
    'zone_export, zone_import <code> - share zones',
  ];
}

/** !zones: prints the editor usage to chat (first line highlighted). */
export function showZonesHelp(chat: (segments: ChatSegment[]) => void): void {
  const lines = zonesHelpLines();
  lines.forEach((l, i) => {
    const sp = l.indexOf(' - ');
    if (i === 0 || sp < 0) chat([{ text: l, color: i === 0 ? 'lightblue' : 'default' }]);
    else chat([{ text: l.slice(0, sp), color: 'gold' }, { text: l.slice(sp), color: 'default' }]);
  });
}

function fmt(v: Vec3): string {
  return `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.z.toFixed(1)}`;
}

function describe(z: ZoneDef): string {
  const name = INDEXED.has(z.type) ? `${z.type} ${z.index}` : z.type;
  return `${name}${z.group ? ` (bonus ${z.group})` : ''}`;
}

/** Compact zone list for sharing: plain arrays, rounded to 0.01 units. */
function toPlain(zones: ZoneDef[]): unknown[] {
  const r = (n: number): number => Math.round(n * 100) / 100;
  return zones.map((z) => {
    const o: Record<string, unknown> = {
      type: z.type,
      group: z.group,
      index: z.index,
      mins: [r(z.mins.x), r(z.mins.y), r(z.mins.z)],
      maxs: [r(z.maxs.x), r(z.maxs.y), r(z.maxs.z)],
    };
    if (z.prespeed !== undefined) o.prespeed = z.prespeed;
    if (z.spawn) {
      o.spawn = {
        origin: [r(z.spawn.origin.x), r(z.spawn.origin.y), r(z.spawn.origin.z)],
        angles: [r(z.spawn.angles.pitch), r(z.spawn.angles.yaw), r(z.spawn.angles.roll)],
      };
    }
    return o;
  });
}

function vecFrom(x: unknown): Vec3 | null {
  if (Array.isArray(x) && x.length >= 3) {
    const v = v3(Number(x[0]), Number(x[1]), Number(x[2]));
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null;
  }
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    const v = v3(Number(o.x), Number(o.y), Number(o.z));
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null;
  }
  return null;
}

function fromPlain(list: unknown): ZoneDef[] {
  if (!Array.isArray(list)) return [];
  const out: ZoneDef[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const type = (typeof o.type === 'string' ? o.type : typeof o.t === 'string' ? o.t : '') as ZoneType;
    const mins = vecFrom(o.mins ?? o.a);
    const maxs = vecFrom(o.maxs ?? o.b);
    if (!TYPES.includes(type) || !mins || !maxs) continue;
    const z: ZoneDef = { type, group: Number(o.group ?? o.g) || 0, index: Number(o.index ?? o.i) || 0, mins, maxs };
    const p = o.prespeed ?? o.p;
    if (typeof p === 'number' && Number.isFinite(p)) z.prespeed = p;
    if (o.spawn && typeof o.spawn === 'object') {
      const s = o.spawn as Record<string, unknown>;
      const so = vecFrom(s.origin);
      const sa = vecFrom(s.angles);
      if (so && sa) z.spawn = { origin: so, angles: { pitch: sa.x, yaw: sa.y, roll: sa.z } };
    }
    out.push(z);
  }
  return sanitizeZones(out);
}

const CODE_PREFIX = 'surfzones:';

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Zones -> "surfzones:<base64url JSON>" (survives the console tokenizer: no quotes, spaces, ';' or '//'). */
export function encodeZones(zones: ZoneDef[]): string {
  return CODE_PREFIX + b64urlEncode(JSON.stringify(toPlain(zones)));
}

/**
 * Parses zone_import input: the compact code, JSON, or JSON whose quotes the console tokenizer removed
 * ([{type:start,group:0,...}]). Preset-style keys (t/g/i/a/b/p) are accepted too.
 */
export function decodeZones(text: string): ZoneDef[] {
  const s = text.trim();
  if (!s) return [];
  if (s.startsWith(CODE_PREFIX)) {
    try {
      return fromPlain(JSON.parse(b64urlDecode(s.slice(CODE_PREFIX.length))));
    } catch {
      return [];
    }
  }
  try {
    return fromPlain(JSON.parse(s));
  } catch {
    /* maybe the quotes were stripped */
  }
  try {
    const quoted = s.replace(/([A-Za-z_][A-Za-z0-9_]*)/g, (m) => (m === 'true' || m === 'false' || m === 'null' ? m : `"${m}"`));
    return fromPlain(JSON.parse(quoted));
  } catch {
    return [];
  }
}

export class ZoneEditor {
  readonly host: ZoneEditorHost;
  readonly timer: ISurfTimer;
  /** Editor mode: zone boxes are drawn and the pending corner follows the player. */
  active = false;
  private draft: ZoneDef[] | null = null;
  private pending: { type: ZoneType; group: number; index: number; a: Vec3 | null } | null = null;

  constructor(host: ZoneEditorHost, timer: ISurfTimer) {
    this.host = host;
    this.timer = timer;
  }

  private print(s: string): void {
    this.host.print(s);
  }

  private zones(): ZoneDef[] {
    return this.draft ?? this.timer.getZones();
  }

  private ensureDraft(): ZoneDef[] {
    if (!this.draft) this.draft = this.timer.getZones();
    return this.draft;
  }

  private apply(source: ZoneSource = 'user'): void {
    this.timer.setZones(this.ensureDraft(), source);
  }

  edit(on?: boolean): void {
    this.active = on ?? !this.active;
    if (!this.active) this.pending = null;
    this.print(this.active ? 'Zone editor on. zone_add <type> to begin a zone; !zones for help.' : 'Zone editor off.');
  }

  add(args: string[]): boolean {
    const type = (args[0] ?? '').toLowerCase() as ZoneType;
    if (!TYPES.includes(type)) {
      this.print(`usage: zone_add <${TYPES.join('|')}> [N] [group]`);
      return false;
    }
    let index = 0;
    let groupArg: string | undefined;
    const zones = this.zones();
    if (INDEXED.has(type)) {
      const n = parseInt(args[1] ?? '', 10);
      groupArg = args[2];
      const group = parseInt(groupArg ?? '0', 10) || 0;
      if (Number.isFinite(n)) index = n;
      else {
        // next free number for that course (stages start at 2: stage 1 begins at the start zone)
        let max = type === 'stage' ? 1 : 0;
        for (const z of zones) if (z.type === type && z.group === group && z.index > max) max = z.index;
        index = max + 1;
      }
      if (type === 'stage' && index < 2) {
        this.print('Stage zones are numbered from 2 (stage 1 begins at the start zone).');
        return false;
      }
    } else groupArg = args[1];
    const group = Math.max(0, parseInt(groupArg ?? '0', 10) || 0);
    this.pending = { type, group, index, a: null };
    if (!this.active) this.active = true;
    this.print(`New ${describe({ type, group, index, mins: v3(), maxs: v3() })} zone: stand at one corner and type zone_point.`);
    return true;
  }

  /** Sets corner A, or corner B (completing the pending zone). Returns the new zone when completed. */
  point(): ZoneDef | null {
    const p = this.pending;
    if (!p) {
      this.print('No zone in progress: zone_add <type> first.');
      return null;
    }
    const feet = this.host.player.origin;
    if (!p.a) {
      p.a = v3(feet.x, feet.y, feet.z);
      this.print(`Corner A at ${fmt(p.a)}. Walk to the opposite corner and type zone_point.`);
      return null;
    }
    const box = this.boxFrom(p.a, feet);
    if (box.maxs.x - box.mins.x < 1 || box.maxs.y - box.mins.y < 1) {
      this.print('Zone too thin: corner B must differ from corner A horizontally. Try zone_point again.');
      return null;
    }
    const z: ZoneDef = { type: p.type, group: p.group, index: p.index, mins: box.mins, maxs: box.maxs };
    const draft = this.ensureDraft();
    draft.push(z);
    this.pending = null;
    this.apply();
    this.print(`Added #${draft.length - 1} ${describe(z)}: ${fmt(z.mins)} -> ${fmt(z.maxs)}. zone_save to keep it.`);
    return z;
  }

  /** Box between two feet positions: a flat box (< 32 units tall) gets 128 units of height. */
  private boxFrom(a: Vec3, b: Vec3): { mins: Vec3; maxs: Vec3 } {
    const mins = v3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
    const maxs = v3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
    if (maxs.z - mins.z < 32) maxs.z += 128;
    return { mins, maxs };
  }

  list(): void {
    const zones = this.zones();
    if (!zones.length) {
      this.print('No zones.');
      return;
    }
    this.print(`${zones.length} zone(s) (${this.draft ? 'edited' : this.timer.zoneSource}):`);
    zones.forEach((z, i) => {
      const extra = z.prespeed !== undefined ? ` prespeed ${z.prespeed}` : '';
      this.print(`#${i} ${describe(z)}: ${fmt(z.mins)} -> ${fmt(z.maxs)}${extra}`);
    });
  }

  remove(i: number): boolean {
    const zones = this.ensureDraft();
    if (!Number.isInteger(i) || i < 0 || i >= zones.length) {
      this.print(`usage: zone_delete <0..${Math.max(0, zones.length - 1)}>`);
      return false;
    }
    const [z] = zones.splice(i, 1);
    this.apply();
    this.print(`Deleted #${i} ${describe(z)}. zone_save to keep the change.`);
    return true;
  }

  /** Sets the spawn of zone `i` (default: the start/stage zone the player stands in) to the player's position and view. */
  setSpawn(i?: number): boolean {
    const zones = this.ensureDraft();
    const o = this.host.player.origin;
    let idx = i ?? -1;
    if (idx < 0) {
      idx = zones.findIndex(
        (z) =>
          (z.type === 'start' || z.type === 'speedstart' || z.type === 'stage') &&
          o.x >= z.mins.x - 16 && o.x <= z.maxs.x + 16 && o.y >= z.mins.y - 16 && o.y <= z.maxs.y + 16 &&
          o.z >= z.mins.z - 72 && o.z <= z.maxs.z,
      );
    }
    if (!Number.isInteger(idx) || idx < 0 || idx >= zones.length) {
      this.print('zone_setspawn: stand in a start/stage zone or give its number (zone_list).');
      return false;
    }
    const a = this.host.player.viewAngles;
    zones[idx].spawn = { origin: v3(o.x, o.y, o.z), angles: { pitch: 0, yaw: a ? a.yaw : 0, roll: 0 } };
    this.apply();
    this.print(`Spawn of #${idx} ${describe(zones[idx])} set to ${fmt(o)}. zone_save to keep it.`);
    return true;
  }

  /** Prespeed cap of zone `i` (0 = no cap). */
  setPrespeed(i: number, value: number): boolean {
    const zones = this.ensureDraft();
    if (!Number.isInteger(i) || i < 0 || i >= zones.length || !Number.isFinite(value) || value < 0) {
      this.print('usage: zone_prespeed <#> <u/s>  (0 = no cap)');
      return false;
    }
    zones[i].prespeed = value;
    this.apply();
    this.print(`Prespeed of #${i} ${describe(zones[i])}: ${value || 'no cap'}. zone_save to keep it.`);
    return true;
  }

  save(): void {
    const zones = this.zones();
    saveUserZones(this.host.map.name, zones.length ? zones : null);
    this.draft = null;
    this.timer.setZones(zones, zones.length ? 'user' : 'none');
    this.print(`Saved ${zones.length} zone(s) for ${this.host.map.name}.`);
  }

  async reset(): Promise<void> {
    saveUserZones(this.host.map.name, null);
    this.draft = null;
    this.pending = null;
    const r = await resolveZones(this.host.map);
    this.timer.setZones(r.zones, r.source);
    this.print(`User zones deleted; using ${r.source} zones (${r.zones.length}).`);
  }

  exportZones(): string {
    const zones = this.zones();
    const code = encodeZones(zones);
    this.print(JSON.stringify(toPlain(zones)));
    this.print(`zone_import ${code}`);
    try {
      const nav = (globalThis as { navigator?: { clipboard?: { writeText(s: string): Promise<void> } } }).navigator;
      void nav?.clipboard?.writeText(`zone_import ${code}`).catch(() => undefined);
    } catch {
      /* no clipboard */
    }
    return code;
  }

  importZones(text: string): boolean {
    const zones = decodeZones(text);
    if (!zones.length) {
      this.print('zone_import: no valid zones found (paste the code or JSON from zone_export).');
      return false;
    }
    this.draft = zones;
    this.pending = null;
    saveUserZones(this.host.map.name, zones);
    this.apply();
    this.draft = null;
    this.print(`Imported and saved ${zones.length} zone(s).`);
    return true;
  }

  /** Boxes for renderer.setDebugBoxes while the editor is on (zones + the zone being drawn). */
  debugBoxes(): { mins: Vec3; maxs: Vec3; color: [number, number, number] }[] {
    if (!this.active) return [];
    const out = this.zones().map((z) => ({ mins: z.mins, maxs: z.maxs, color: COLORS[z.type] ?? PENDING_COLOR }));
    const p = this.pending;
    if (p && p.a) {
      const b = this.boxFrom(p.a, this.host.player.origin);
      out.push({ mins: b.mins, maxs: b.maxs, color: PENDING_COLOR });
    } else if (p) {
      const f = this.host.player.origin;
      out.push({ mins: v3(f.x - 2, f.y - 2, f.z), maxs: v3(f.x + 2, f.y + 2, f.z + 4), color: PENDING_COLOR });
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------ console glue

let activeEditor: ZoneEditor | null = null;
let commandsRegistered = false;

/** Makes `editor` the target of the zone_* console commands (null when no map is loaded). */
export function installZoneEditor(editor: ZoneEditor | null): void {
  activeEditor = editor;
  registerZoneCommands();
}

/** The editor currently receiving zone_* commands. */
export function getZoneEditor(): ZoneEditor | null {
  return activeEditor;
}

/** Debug boxes of the active editor (empty unless zone_edit is on). */
export function getEditorDebugBoxes(): { mins: Vec3; maxs: Vec3; color: [number, number, number] }[] {
  return activeEditor ? activeEditor.debugBoxes() : [];
}

function withEditor(fn: (e: ZoneEditor) => void): void {
  if (!activeEditor) {
    conPrint('No map loaded.', 'warn');
    return;
  }
  fn(activeEditor);
}

export function registerZoneCommands(): void {
  if (commandsRegistered) return;
  commandsRegistered = true;
  registerCommand({ name: 'zone_edit', help: 'Toggle the zone editor (zone boxes, zone_add/zone_point).', handler: () => withEditor((e) => e.edit()) });
  registerCommand({
    name: 'zone_add',
    help: 'zone_add <start|end|stage N|checkpoint N|stop|teletostart|...> [group] - begin a zone',
    handler: (args) => withEditor((e) => void e.add(args)),
    complete: (partial) => TYPES.filter((t) => t.startsWith(partial.toLowerCase())),
  });
  registerCommand({ name: 'zone_point', help: 'Set a corner of the zone being added at your feet.', handler: () => withEditor((e) => void e.point()) });
  registerCommand({ name: 'zone_list', help: 'List the zones.', handler: () => withEditor((e) => e.list()) });
  registerCommand({
    name: 'zone_delete',
    help: 'zone_delete <#> - remove a zone (see zone_list).',
    handler: (args) => withEditor((e) => void e.remove(parseInt(args[0] ?? '', 10))),
  });
  registerCommand({
    name: 'zone_setspawn',
    help: 'zone_setspawn [#] - !r / !back spawn at your position and view for that zone (default: the zone you stand in).',
    handler: (args) => withEditor((e) => void e.setSpawn(args[0] !== undefined ? parseInt(args[0], 10) : undefined)),
  });
  registerCommand({
    name: 'zone_prespeed',
    help: 'zone_prespeed <#> <u/s> - prespeed cap when leaving that start zone (0 = none).',
    handler: (args) => withEditor((e) => void e.setPrespeed(parseInt(args[0] ?? '', 10), parseFloat(args[1] ?? ''))),
  });
  registerCommand({ name: 'zone_save', help: "Save the zones as this map's user zones.", handler: () => withEditor((e) => e.save()) });
  registerCommand({
    name: 'zone_reset',
    help: "Delete this map's user zones (back to presets / map zones).",
    handler: () => withEditor((e) => void e.reset()),
  });
  registerCommand({ name: 'zone_export', help: 'Print the zones as JSON and as a zone_import code.', handler: () => withEditor((e) => void e.exportZones()) });
  registerCommand({
    name: 'zone_import',
    help: 'zone_import <code|json> - replace and save the zones.',
    handler: (args) => withEditor((e) => void e.importZones(args.join(' '))),
  });
}
