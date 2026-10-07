// Console commands (Source names: map, disconnect, retry, noclip, kill, setpos, setang, getpos, alias, toggle,
// incrementvar, cvarlist, find, help, echo, clear, status, say ...) and the SourceMod/SurfTimer chat commands
// (!r, !s, !b, !back, !saveloc, !tele, !prac, !noclip, !pb, !top, !mi, !replay, !ghost, !hide, !showkeys,
// !speed, !zones, !end, !help, !fov, !sens). Chat commands are also console commands as sm_<name>, like
// SourceMod registers them.
//
// Chat semantics follow SourceMod: "!cmd" is shown in chat and runs the command, "/cmd" runs it silently; a
// '!' or '/' word that is not a command is ordinary chat. Replies carry a SurfTimer-style "[Surf]" prefix.
import { QAngle, qa } from '../core/angles';
import {
  conPrint,
  console_,
  Cvar,
  FCVAR_ARCHIVE,
  FCVAR_CHEAT,
  FCVAR_HIDDEN,
  FCVAR_REPLICATED,
  registerCommand,
} from '../core/cvars';
import { Vec3, v3, v3clone } from '../core/vec3';
import { LoadedMap, ZoneDef, ZoneSource } from '../map/types';
import {
  FL_BASEVELOCITY,
  FL_DUCKING,
  MOVETYPE_NOCLIP,
  MOVETYPE_OBSERVER,
  PlayerState,
  VIEW_OFFSET_DUCK,
  VIEW_OFFSET_STAND,
} from '../physics/playertypes';
import type { ChatColor, ChatSegment, GameState, SoundApi, TimerState, UiApi } from './api';
import { addConfigProvider, loadSavedConfig, scheduleConfigSave } from './binds';
import type { IEntitySystem, IReplaySystem, ISurfTimer, RunRecord } from './contracts';
import { getCompletions } from './records';
import { formatRunTime } from './timer';
import { showZonesHelp } from './zoneeditor';
import type { ZoneEditor } from './zoneeditor';

// ------------------------------------------------------------------------------------------ host contracts

/** Optional extras of game/timer.ts SurfTimer used by the core (duck-typed: the contract is ISurfTimer). */
export interface TimerExtras {
  filterButtons(buttons: number): number;
  setReplay(replay: IReplaySystem | null): void;
  gotoEnd(group?: number): boolean;
  readonly currentGroup: number;
  readonly timerState: TimerState;
  dispose(): void;
  invalidateRecords(): void;
}
export type GameTimer = ISurfTimer & Partial<TimerExtras>;

/** Optional extras of game/entities.ts EntitySystem. */
export interface EntityExtras {
  pressUse(eye: Vec3, forward: Vec3): boolean;
  fireInput(target: string, input: string, param?: string, delay?: number): void;
  resetPlayerState(): void;
  playerClassname: string;
}
export type GameEntities = IEntitySystem & Partial<EntityExtras>;

/** A saved location (!saveloc): everything !tele restores. */
export interface Saveloc {
  origin: Vec3;
  angles: QAngle;
  velocity: Vec3;
  ducked: boolean;
  targetname: string;
  classname: string | null;
  gravity: number;
  speed: number;
}

/** The per-map state the commands work on. */
export interface CommandSession {
  readonly map: LoadedMap;
  readonly player: PlayerState;
  readonly timer: GameTimer;
  readonly entities: GameEntities;
  readonly replay: IReplaySystem;
  readonly zoneEditor: ZoneEditor | null;
  readonly tier: number | null;
  readonly savelocs: Saveloc[];
  /** Index of the saveloc !tele uses (the last saved or the last selected one). */
  savelocIndex: number;
}

/** What the commands need from the game (implemented by game/game.ts Game). */
export interface CommandContext {
  readonly state: GameState;
  readonly mapName: string | null;
  readonly ui: UiApi;
  readonly sound: SoundApi;
  readonly session: CommandSession | null;
  readonly spectating: boolean;
  loadMapByName(name: string): Promise<void>;
  retry(): Promise<void>;
  disconnect(): void;
  pause(): void;
  resume(): void;
  teleportPlayer(origin: Vec3, angles: QAngle | null, velocity: Vec3 | null): void;
  setViewAngles(pitch: number, yaw: number, roll?: number): void;
  getViewAngles(): QAngle;
  /** Watch the PB replay of a course. False if there is none. */
  startSpectate(group: number): boolean;
  /** Stop watching (respawns at the course start). */
  stopSpectate(): void;
  setNoclip(on: boolean): void;
  killPlayer(reason: string): void;
  /** Map names for `map` completion and `maps` (built-in ids + catalog). */
  mapNames(): Promise<string[]>;
}

// ------------------------------------------------------------------------------------------ chat helpers

/** SurfTimer-style chat prefix: [Surf]. */
export const CHAT_PREFIX: readonly ChatSegment[] = Object.freeze([
  { text: '[', color: 'grey' },
  { text: 'Surf', color: 'lime' },
  { text: '] ', color: 'grey' },
]);

export function reply(ctx: CommandContext, ...segments: ChatSegment[]): void {
  const line = [...CHAT_PREFIX, ...segments];
  ctx.ui.chat(line);
  chatToConsole(line);
}

/** Chat lines also go to the console, like CS:GO (plain text). */
export function chatToConsole(segments: readonly ChatSegment[]): void {
  conPrint(segments.map((s) => s.text).join(''));
}

function seg(text: string, color?: ChatColor): ChatSegment {
  return color ? { text, color } : { text };
}

export function playerName(): string {
  const c = console_.getCvar('name');
  return (c && c.value) || 'Player';
}

/** The CS:GO chat line of the local player ("Player : text"; team chat is prefixed like CS:GO). */
export function chatLine(text: string, team: boolean): ChatSegment[] {
  const out: ChatSegment[] = [];
  if (team) out.push({ text: '(Counter-Terrorist) ', color: 'team' });
  out.push({ text: playerName(), color: 'team' }, { text: ' : ', color: 'default' }, { text, color: 'default' });
  return out;
}

function courseName(group: number): string {
  return group > 0 ? `Bonus ${group}` : 'Main';
}

function currentGroup(timer: GameTimer): number {
  const g = timer.currentGroup;
  return typeof g === 'number' ? g : timer.getHud().bonus;
}

export const ZONE_SOURCE_NAMES: Readonly<Record<ZoneSource, string>> = {
  user: 'your zones',
  preset: 'SurfTimer',
  momentum: 'map triggers',
  builtin: 'built-in',
  heuristic: 'automatic (start zone only)',
  none: 'none',
};

/** Stage/checkpoint/bonus counts from zone definitions. */
export function zoneSummary(zones: readonly ZoneDef[]): { stages: number; checkpoints: number; bonuses: number[]; hasEnd: boolean } {
  let stages = 0;
  const cps = new Set<number>();
  const bonuses = new Set<number>();
  let hasEnd = false;
  for (const z of zones) {
    if (z.group === 0) {
      if (z.type === 'stage' && z.index > stages) stages = z.index;
      if (z.type === 'checkpoint') cps.add(z.index);
      if (z.type === 'end') hasEnd = true;
    } else if (z.type === 'start' || z.type === 'speedstart') bonuses.add(z.group);
  }
  return { stages, checkpoints: cps.size, bonuses: [...bonuses].sort((a, b) => a - b), hasEnd };
}

/** "Tier 3 | Staged (6 stages) | 2 bonuses | Zones: SurfTimer" */
export function mapInfoSegments(map: LoadedMap, tier: number | null, zones: readonly ZoneDef[], source: ZoneSource): ChatSegment[] {
  const sum = zoneSummary(zones);
  const out: ChatSegment[] = [seg(map.name, 'lightblue')];
  out.push(seg(' | ', 'grey'), seg(tier ? `Tier ${tier}` : 'Tier ?', tierColor(tier)));
  if (sum.stages > 0) out.push(seg(' | ', 'grey'), seg(`Staged (${sum.stages} stages)`));
  else out.push(seg(' | ', 'grey'), seg(sum.checkpoints ? `Linear (${sum.checkpoints} checkpoints)` : 'Linear'));
  if (sum.bonuses.length) out.push(seg(' | ', 'grey'), seg(sum.bonuses.length === 1 ? '1 bonus' : `${sum.bonuses.length} bonuses`));
  out.push(seg(' | ', 'grey'), seg('Zones: ', 'grey'), seg(ZONE_SOURCE_NAMES[source] ?? source, source === 'none' ? 'lightred' : 'default'));
  return out;
}

function tierColor(tier: number | null): ChatColor {
  if (!tier) return 'grey';
  if (tier <= 2) return 'lime';
  if (tier <= 3) return 'yellow';
  if (tier <= 4) return 'gold';
  if (tier <= 5) return 'orange';
  return 'lightred';
}

/** Levenshtein distance (small strings: chat command suggestions). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function parseIntArg(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

function parseNum(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtCoord(n: number): string {
  return (Object.is(n, -0) ? 0 : n).toFixed(6);
}

// ------------------------------------------------------------------------------------------ chat commands

interface ChatCommand {
  names: string[];
  /** Shown by !help: "!s <n>" style usage. */
  usage: string;
  help: string;
  /** Needs a loaded map. */
  map: boolean;
  run(ctx: CommandContext, args: string[], s: CommandSession | null): void;
}

function toggleCvar(ctx: CommandContext, name: string, label: string): void {
  const c = console_.getCvar(name);
  if (!c) return;
  c.set(c.bool ? 0 : 1);
  reply(ctx, seg(`${label} `), c.bool ? seg('enabled', 'lime') : seg('disabled', 'lightred'), seg('.'));
}

function saveLocation(ctx: CommandContext, s: CommandSession): void {
  if (s.savelocs.length >= 999) {
    reply(ctx, seg('Saveloc limit reached (999).', 'lightred'));
    return;
  }
  const ps = s.player;
  const a = ctx.getViewAngles();
  s.savelocs.push({
    origin: v3clone(ps.origin),
    angles: { pitch: a.pitch, yaw: a.yaw, roll: 0 },
    velocity: v3clone(ps.velocity),
    ducked: ps.ducked,
    targetname: s.entities.playerTargetname,
    classname: typeof s.entities.playerClassname === 'string' ? s.entities.playerClassname : null,
    gravity: ps.gravityScale,
    speed: ps.laggedMovement,
  });
  s.savelocIndex = s.savelocs.length - 1;
  reply(ctx, seg('Saved location '), seg(`#${s.savelocs.length}`, 'gold'), seg(' · '), seg('!tele', 'lightblue'), seg(' to teleport.'));
}

/** Teleports to saveloc `index` (0-based) in practice mode. */
export function teleportToSaveloc(ctx: CommandContext, s: CommandSession, index: number): boolean {
  const loc = s.savelocs[index];
  if (!loc) return false;
  if (ctx.spectating) ctx.stopSpectate();
  s.timer.enterPractice('saveloc');
  const ps = s.player;
  if (ps.moveType === MOVETYPE_NOCLIP || ps.moveType === MOVETYPE_OBSERVER) ctx.setNoclip(false);
  ps.ducked = loc.ducked;
  ps.ducking = false;
  ps.duckTimer = 0;
  ps.duckAmount = loc.ducked ? 1 : 0;
  ps.viewOffsetZ = loc.ducked ? VIEW_OFFSET_DUCK : VIEW_OFFSET_STAND;
  if (loc.ducked) ps.flags |= FL_DUCKING;
  else ps.flags &= ~FL_DUCKING;
  ps.gravityScale = loc.gravity;
  ps.laggedMovement = loc.speed;
  ps.baseVelocity.x = ps.baseVelocity.y = ps.baseVelocity.z = 0;
  ps.flags &= ~FL_BASEVELOCITY;
  s.entities.playerTargetname = loc.targetname;
  if (loc.classname !== null && typeof s.entities.playerClassname === 'string') s.entities.playerClassname = loc.classname;
  s.savelocIndex = index;
  ctx.teleportPlayer(loc.origin, loc.angles, loc.velocity);
  return true;
}

function teleCommand(ctx: CommandContext, s: CommandSession, args: string[], step: number): void {
  if (!s.savelocs.length) {
    reply(ctx, seg('No saved locations. Use '), seg('!saveloc', 'lightblue'), seg(' first.'));
    return;
  }
  let idx = Math.min(Math.max(s.savelocIndex, 0), s.savelocs.length - 1);
  if (step !== 0) idx = Math.min(Math.max(idx + step, 0), s.savelocs.length - 1);
  else if (args[0] !== undefined) {
    const n = parseIntArg(args[0]);
    if (n === null || n < 1 || n > s.savelocs.length) {
      reply(ctx, seg(`Saveloc #${args[0]} doesn't exist (1 - ${s.savelocs.length}).`, 'lightred'));
      return;
    }
    idx = n - 1;
  }
  teleportToSaveloc(ctx, s, idx);
}

function noclipToggle(ctx: CommandContext, s: CommandSession): void {
  const on = s.player.moveType !== MOVETYPE_NOCLIP;
  ctx.setNoclip(on);
  reply(ctx, seg('Noclip '), on ? seg('enabled', 'lime') : seg('disabled', 'lightred'), seg('.'));
}

function showPb(ctx: CommandContext, s: CommandSession, group: number): void {
  const recs = s.timer.getRecords(group);
  const where = group > 0 ? `${s.map.name} Bonus ${group}` : s.map.name;
  if (!recs.length) {
    reply(ctx, seg("You haven't finished "), seg(where, 'gold'), seg(' yet.'));
    return;
  }
  const pb = recs[0];
  const total = Math.max(getCompletions(s.map.name, group), recs.length);
  reply(
    ctx,
    seg('Your PB on '),
    seg(where, 'gold'),
    seg(': '),
    seg(formatRunTime(pb.time), 'lime'),
    seg(` (${total} ${total === 1 ? 'completion' : 'completions'}, ${pb.jumps} jumps, ${Math.round(pb.sync)}% sync)`, 'grey'),
  );
}

function showTop(ctx: CommandContext, s: CommandSession, group: number): void {
  const recs: RunRecord[] = s.timer.getRecords(group);
  const where = group > 0 ? `${s.map.name} Bonus ${group}` : s.map.name;
  if (!recs.length) {
    reply(ctx, seg('No times on '), seg(where, 'gold'), seg(' yet.'));
    return;
  }
  reply(ctx, seg('Top times on '), seg(where, 'gold'), seg(':'));
  const best = recs[0].time;
  recs.slice(0, 10).forEach((r, i) => {
    const d = new Date(r.date);
    const date = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
    const segs: ChatSegment[] = [seg(`#${i + 1} `, i === 0 ? 'gold' : 'default'), seg(formatRunTime(r.time), i === 0 ? 'lime' : 'default')];
    if (i > 0) segs.push(seg(` (+${(r.time - best).toFixed(3)})`, 'lightred'));
    segs.push(seg(` · ${r.jumps} jumps · ${Math.round(r.sync)}% sync${date ? ` · ${date}` : ''}`, 'grey'));
    ctx.ui.chat(segs);
    chatToConsole(segs);
  });
}

function showMapInfo(ctx: CommandContext, s: CommandSession): void {
  reply(ctx, ...mapInfoSegments(s.map, s.tier, s.timer.getZones(), s.timer.zoneSource));
}

function setCvarFromChat(ctx: CommandContext, name: string, label: string, arg: string | undefined, fmt: (n: number) => string): void {
  const c = console_.getCvar(name);
  if (!c) return;
  const n = parseNum(arg);
  if (n === null) {
    reply(ctx, seg(`${label}: `), seg(c.value, 'lime'), seg(` (usage: !${name === 'fov_desired' ? 'fov' : 'sens'} <value>)`, 'grey'));
    return;
  }
  c.set(n);
  reply(ctx, seg(`${label} set to `), seg(fmt(c.num), 'lime'), seg('.'));
}

const HELP_LINES: ReadonlyArray<ReadonlyArray<[string, string]>> = [
  [['!r', 'restart'], ['!s <n>', 'stage'], ['!b <n>', 'bonus'], ['!back', 'stage start'], ['!end', 'end zone']],
  [['!saveloc', 'save'], ['!tele [n]', 'teleport'], ['!prac', 'practice'], ['!noclip', 'noclip']],
  [['!pb', 'personal best'], ['!top', 'top times'], ['!mi', 'map info'], ['!replay', 'watch PB']],
  [['!ghost', ''], ['!hide', ''], ['!showkeys', ''], ['!speed', ''], ['!fov <n>', ''], ['!sens <n>', ''], ['!zones', '']],
];

function showHelp(ctx: CommandContext): void {
  reply(ctx, seg('Chat commands ', 'lightblue'), seg('(also as console commands sm_<name>):', 'grey'));
  for (const line of HELP_LINES) {
    const segs: ChatSegment[] = [];
    line.forEach(([cmd, what], i) => {
      if (i) segs.push(seg('  '));
      segs.push(seg(cmd, 'gold'));
      if (what) segs.push(seg(` ${what}`, 'grey'));
    });
    ctx.ui.chat(segs);
    chatToConsole(segs);
  }
  const tail = [seg('Console: ', 'grey'), seg('`', 'gold'), seg(' — bind, alias, sv_airaccelerate, fov_desired, cl_showpos …', 'grey')];
  ctx.ui.chat(tail);
  chatToConsole(tail);
}

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  {
    names: ['r', 'restart'],
    usage: '!r',
    help: 'Restart the map (main course start).',
    map: true,
    run: (ctx, _a, s) => {
      if (ctx.spectating) ctx.stopSpectate();
      s!.timer.restart(0);
    },
  },
  {
    names: ['s', 'stage'],
    usage: '!s [n]',
    help: 'Go to stage n (practice), or restart the current stage.',
    map: true,
    run: (ctx, args, s) => {
      if (ctx.spectating) ctx.stopSpectate();
      if (args[0] === undefined) {
        s!.timer.restartStage();
        return;
      }
      const n = parseIntArg(args[0]);
      if (n === null || n < 1) {
        reply(ctx, seg('Usage: !s <stage number>', 'lightred'));
        return;
      }
      s!.timer.gotoStage(n);
    },
  },
  {
    names: ['b', 'bonus'],
    usage: '!b [n]',
    help: 'Go to the start of bonus n (default 1).',
    map: true,
    run: (ctx, args, s) => {
      const n = args[0] === undefined ? 1 : parseIntArg(args[0]);
      if (n === null || n < 1) {
        reply(ctx, seg('Usage: !b <bonus number>', 'lightred'));
        return;
      }
      if (ctx.spectating) ctx.stopSpectate();
      s!.timer.restart(n);
    },
  },
  {
    names: ['back', 'stuck'],
    usage: '!back',
    help: 'Restart the current stage (or the course on linear maps).',
    map: true,
    run: (ctx, _a, s) => {
      if (ctx.spectating) ctx.stopSpectate();
      s!.timer.restartStage();
    },
  },
  {
    names: ['saveloc', 'cp', 'checkpoint'],
    usage: '!saveloc',
    help: 'Save your position, view and velocity.',
    map: true,
    run: (ctx, _a, s) => {
      if (ctx.spectating) return;
      saveLocation(ctx, s!);
    },
  },
  {
    names: ['tele', 'tp', 'teleport', 'loadloc'],
    usage: '!tele [n]',
    help: 'Teleport to your last (or n-th) saved location (practice mode).',
    map: true,
    run: (ctx, args, s) => teleCommand(ctx, s!, args, 0),
  },
  {
    names: ['teleprev', 'prevloc'],
    usage: '!teleprev',
    help: 'Teleport to the previous saved location.',
    map: true,
    run: (ctx, args, s) => teleCommand(ctx, s!, args, -1),
  },
  {
    names: ['telenext', 'nextloc'],
    usage: '!telenext',
    help: 'Teleport to the next saved location.',
    map: true,
    run: (ctx, args, s) => teleCommand(ctx, s!, args, 1),
  },
  {
    names: ['prac', 'practice'],
    usage: '!prac',
    help: 'Practice mode: teleport to your saved location (or start practicing here).',
    map: true,
    run: (ctx, args, s) => {
      if (s!.savelocs.length) {
        teleCommand(ctx, s!, args, 0);
        return;
      }
      if (s!.timer.inPractice) {
        reply(ctx, seg('Already in practice mode. '), seg('!saveloc', 'lightblue'), seg(' saves a location, '), seg('!r', 'lightblue'), seg(' leaves.'));
        return;
      }
      s!.timer.enterPractice('!prac');
    },
  },
  {
    names: ['noclip', 'nc'],
    usage: '!noclip',
    help: 'Toggle noclip (practice mode).',
    map: true,
    run: (ctx, _a, s) => {
      if (ctx.spectating) return;
      noclipToggle(ctx, s!);
    },
  },
  {
    names: ['end'],
    usage: '!end',
    help: 'Teleport to the end zone (practice mode).',
    map: true,
    run: (ctx, _a, s) => {
      if (ctx.spectating) ctx.stopSpectate();
      const t = s!.timer;
      if (typeof t.gotoEnd === 'function') {
        t.gotoEnd(currentGroup(t));
        return;
      }
      reply(ctx, seg('This course has no end zone.', 'lightred'));
    },
  },
  {
    names: ['pb', 'mypb', 'prinfo'],
    usage: '!pb',
    help: 'Your personal best on this course.',
    map: true,
    run: (ctx, args, s) => {
      const g = args[0] !== undefined ? parseIntArg(args[0]) : null;
      showPb(ctx, s!, g !== null && g >= 0 ? g : currentGroup(s!.timer));
    },
  },
  {
    names: ['top', 'wr', 'maptop', 'records'],
    usage: '!top',
    help: 'Best times on this course.',
    map: true,
    run: (ctx, args, s) => {
      const g = args[0] !== undefined ? parseIntArg(args[0]) : null;
      showTop(ctx, s!, g !== null && g >= 0 ? g : currentGroup(s!.timer));
    },
  },
  {
    names: ['mi', 'tier', 'mapinfo', 'm'],
    usage: '!mi',
    help: 'Map info (tier, type, stages, bonuses, zones).',
    map: true,
    run: (ctx, _a, s) => showMapInfo(ctx, s!),
  },
  {
    names: ['replay', 'spec', 'watch'],
    usage: '!replay',
    help: 'Watch your PB replay of this course (again to stop).',
    map: true,
    run: (ctx, args, s) => {
      if (ctx.spectating) {
        ctx.stopSpectate();
        return;
      }
      const g = args[0] !== undefined ? parseIntArg(args[0]) : null;
      const group = g !== null && g >= 0 ? g : currentGroup(s!.timer);
      if (!ctx.startSpectate(group)) {
        reply(ctx, seg(`No replay for ${s!.map.name}${group > 0 ? ` Bonus ${group}` : ''} yet: finish the course to record one.`, 'lightred'));
        return;
      }
      reply(ctx, seg('Watching your '), seg(group > 0 ? `Bonus ${group} PB replay` : 'PB replay', 'gold'), seg('. Jump or '), seg('!r', 'lightblue'), seg(' to stop.'));
    },
  },
  {
    names: ['ghost'],
    usage: '!ghost',
    help: 'Toggle the PB ghost.',
    map: false,
    run: (ctx) => toggleCvar(ctx, 'surf_ghost', 'Ghost'),
  },
  {
    names: ['hide'],
    usage: '!hide',
    help: 'Hide other players and replay bots.',
    map: false,
    run: (ctx) => {
      const c = console_.getCvar('surf_hide');
      if (!c) return;
      c.set(c.bool ? 0 : 1);
      reply(ctx, seg('Other players are now '), c.bool ? seg('hidden', 'lightred') : seg('visible', 'lime'), seg('.'));
    },
  },
  {
    names: ['showkeys', 'keys'],
    usage: '!showkeys',
    help: 'Toggle the key display.',
    map: false,
    run: (ctx) => toggleCvar(ctx, 'surf_showkeys', 'Key display'),
  },
  {
    names: ['speed', 'speedometer', 'hidespeed'],
    usage: '!speed',
    help: 'Toggle the speedometer.',
    map: false,
    run: (ctx) => toggleCvar(ctx, 'surf_hud_speed', 'Speedometer'),
  },
  {
    names: ['zones', 'zone', 'zonemenu'],
    usage: '!zones',
    help: 'Zone editor help (zone_* console commands).',
    map: true,
    run: (ctx, _a, s) => {
      const ed = s!.zoneEditor;
      if (ed && !ed.active) ed.edit(true);
      showZonesHelp((segs) => reply(ctx, ...segs));
    },
  },
  {
    names: ['help', 'commands', 'cmds'],
    usage: '!help',
    help: 'List the chat commands.',
    map: false,
    run: (ctx) => showHelp(ctx),
  },
  {
    names: ['fov'],
    usage: '!fov <n>',
    help: 'Set the field of view (60 - 130).',
    map: false,
    run: (ctx, args) => setCvarFromChat(ctx, 'fov_desired', 'FOV', args[0], (n) => String(n)),
  },
  {
    names: ['sens', 'sensitivity'],
    usage: '!sens <n>',
    help: 'Set the mouse sensitivity.',
    map: false,
    run: (ctx, args) => setCvarFromChat(ctx, 'sensitivity', 'Sensitivity', args[0], (n) => String(n)),
  },
];

const CHAT_BY_NAME = new Map<string, ChatCommand>();
for (const c of CHAT_COMMANDS) for (const n of c.names) CHAT_BY_NAME.set(n, c);

/** All chat command names (for completion and suggestions). */
export function chatCommandNames(): string[] {
  return [...CHAT_BY_NAME.keys()];
}

function suggest(name: string): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const n of CHAT_BY_NAME.keys()) {
    const d = editDistance(name, n);
    if (d < bestD || (d === bestD && best !== null && n.length < best.length)) {
      best = n;
      bestD = d;
    }
  }
  return bestD <= 2 ? best : null;
}

/** Runs chat command `name` (without prefix). Returns false if there is no such command. */
export function runChatCommand(ctx: CommandContext, name: string, args: string[]): boolean {
  const cmd = CHAT_BY_NAME.get(name.toLowerCase());
  if (!cmd) return false;
  const s = ctx.session;
  if (cmd.map && !s) {
    reply(ctx, seg('No map loaded.', 'lightred'));
    return true;
  }
  try {
    cmd.run(ctx, args, s);
  } catch (e) {
    console.error(e);
    reply(ctx, seg(`!${name} failed: ${(e as Error).message}`, 'lightred'));
  }
  return true;
}

/**
 * The local player's chat line (say / say_team / the chat box). "!cmd args" is echoed then run, "/cmd args"
 * runs silently; anything else (including unknown commands) is ordinary chat.
 */
export function handleSay(ctx: CommandContext, raw: string, team = false): void {
  const text = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (!text) return;
  const prefix = text[0];
  if ((prefix === '!' || prefix === '/') && text.length > 1 && text[1] !== ' ') {
    const parts = text.slice(1).split(/\s+/).filter(Boolean);
    const name = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);
    if (CHAT_BY_NAME.has(name)) {
      if (prefix === '!') echoChat(ctx, text, team);
      runChatCommand(ctx, name, args);
      return;
    }
    echoChat(ctx, text, team);
    if (/^[a-z][a-z0-9_]*$/.test(name)) {
      const hint = suggest(name);
      const segs: ChatSegment[] = [seg('Unknown command ', 'lightred'), seg(`${prefix}${name}`, 'red'), seg('.', 'lightred')];
      if (hint) segs.push(seg(' Did you mean ', 'lightred'), seg(`${prefix}${hint}`, 'gold'), seg('?', 'lightred'));
      segs.push(seg(' Type ', 'default'), seg('!help', 'lightblue'), seg('.', 'default'));
      reply(ctx, ...segs);
    }
    return;
  }
  echoChat(ctx, text, team);
}

function echoChat(ctx: CommandContext, text: string, team: boolean): void {
  ctx.ui.chat(chatLine(text, team));
  conPrint(`${team ? '(Counter-Terrorist) ' : ''}${playerName()} : ${text}`);
}

// ------------------------------------------------------------------------------------------ aliases

const aliasValues = new Map<string, string>();

/** Defines (or with an empty value, clears) an alias; persisted with the config. */
export function setAlias(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (!n || /[\s;"]/.test(n)) return false;
  if (console_.hasCommand(n) || console_.getCvar(n)) return false;
  console_.setAlias(n, value);
  if (value === '') aliasValues.delete(n);
  else aliasValues.set(n, value);
  scheduleConfigSave();
  return true;
}

export function aliasList(): [string, string][] {
  return [...aliasValues.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ------------------------------------------------------------------------------------------ console helpers

export function cvarFlagsText(flags: number): string {
  const out: string[] = [];
  if (flags & FCVAR_ARCHIVE) out.push('a');
  if (flags & FCVAR_CHEAT) out.push('cheat');
  if (flags & FCVAR_REPLICATED) out.push('rep');
  return out.join(', ');
}

function cheatsOn(): boolean {
  const c = console_.getCvar('sv_cheats');
  return !c || c.bool;
}

function cheatBlocked(c: Cvar): boolean {
  if (c.flags & FCVAR_CHEAT && !cheatsOn()) {
    conPrint(`Can't change cheat cvar ${c.name} in multiplayer, unless the server has sv_cheats set to 1.`, 'warn');
    return true;
  }
  return false;
}

/** `toggle <cvar> [v1 v2 ...]`: 0 <-> 1, or cycle through the given values. */
export function toggleCommand(args: string[]): void {
  if (!args.length) {
    conPrint('Usage: toggle <cvar> [value1 value2 ...]');
    return;
  }
  const c = console_.getCvar(args[0]);
  if (!c) {
    conPrint(`toggle: unknown cvar "${args[0]}"`, 'warn');
    return;
  }
  if (cheatBlocked(c)) return;
  const values = args.slice(1);
  if (!values.length) {
    c.set(c.bool ? '0' : '1');
    return;
  }
  let i = values.findIndex((v) => v === c.value);
  if (i < 0) {
    const n = c.num;
    i = values.findIndex((v) => Number.isFinite(parseFloat(v)) && parseFloat(v) === n);
  }
  c.set(values[i < 0 ? 0 : (i + 1) % values.length]);
}

/** `incrementvar <cvar> <min> <max> <delta>`: adds delta, wrapping past max to min (and below min to max). */
export function incrementvarCommand(args: string[]): void {
  if (args.length < 4) {
    conPrint('Usage: incrementvar varName minValue maxValue delta');
    return;
  }
  const c = console_.getCvar(args[0]);
  if (!c) {
    conPrint(`incrementvar: unknown cvar "${args[0]}"`, 'warn');
    return;
  }
  if (cheatBlocked(c)) return;
  const min = parseFloat(args[1]);
  const max = parseFloat(args[2]);
  const delta = parseFloat(args[3]);
  if (![min, max, delta].every(Number.isFinite)) {
    conPrint('Usage: incrementvar varName minValue maxValue delta');
    return;
  }
  let v = c.num + delta;
  if (v > max + 1e-9) v = min;
  else if (v < min - 1e-9) v = max;
  c.set(String(Math.round(v * 1e6) / 1e6));
}

function cvarListCommand(args: string[]): void {
  const prefix = (args[0] ?? '').toLowerCase();
  const rows: string[] = [];
  for (const c of console_.allCvars()) {
    if (c.flags & FCVAR_HIDDEN || !c.name.startsWith(prefix)) continue;
    rows.push(`${c.name.padEnd(36)} : ${c.value.padEnd(10)} : ${cvarFlagsText(c.flags).padEnd(12)} : ${c.help}`);
  }
  for (const c of console_.allCommands()) {
    if ((c.flags ?? 0) & FCVAR_HIDDEN || !c.name.startsWith(prefix)) continue;
    rows.push(`${c.name.padEnd(36)} : ${'cmd'.padEnd(10)} : ${''.padEnd(12)} : ${c.help ?? ''}`);
  }
  rows.sort((a, b) => a.localeCompare(b));
  conPrint('cvar list\n--------------');
  if (rows.length) conPrint(rows.join('\n'));
  conPrint(`--------------\n${rows.length} total convars/concommands`, 'info');
}

function findCommand(args: string[]): void {
  if (!args.length) {
    conPrint('Usage:  find <string>');
    return;
  }
  const q = args.join(' ').toLowerCase();
  const out: string[] = [];
  for (const c of console_.allCvars()) {
    if (c.flags & FCVAR_HIDDEN) continue;
    if (c.name.includes(q) || c.help.toLowerCase().includes(q)) {
      const fl = cvarFlagsText(c.flags);
      out.push(`"${c.name}" = "${c.value}" ( def. "${c.defaultValue}" )${fl ? ` ${fl}` : ''}${c.help ? ` - ${c.help}` : ''}`);
    }
  }
  for (const c of console_.allCommands()) {
    if ((c.flags ?? 0) & FCVAR_HIDDEN) continue;
    if (c.name.includes(q) || (c.help ?? '').toLowerCase().includes(q)) out.push(`"${c.name}"${c.help ? ` - ${c.help}` : ''}`);
  }
  out.sort((a, b) => a.localeCompare(b));
  if (out.length) conPrint(out.join('\n'));
  else conPrint(`No cvars or commands containing "${q}"`);
}

function helpCommand(args: string[]): void {
  if (!args.length) {
    conPrint('help <command or cvar> : describe a command or console variable.\nType cvarlist [prefix] or find <text> to search; say !help lists the chat commands.');
    return;
  }
  const name = args[0].toLowerCase();
  const c = console_.getCvar(name);
  if (c) {
    const fl = cvarFlagsText(c.flags);
    conPrint(`"${c.name}" = "${c.value}" ( def. "${c.defaultValue}" )${c.min !== undefined ? ` min. ${c.min}` : ''}${c.max !== undefined ? ` max. ${c.max}` : ''}${fl ? `\n ${fl}` : ''}${c.help ? `\n - ${c.help}` : ''}`);
    return;
  }
  const cmd = console_.allCommands().find((x) => x.name === name);
  if (cmd) {
    conPrint(`"${cmd.name}"${cmd.help ? `\n - ${cmd.help}` : ''}`);
    return;
  }
  const al = console_.getAlias(name);
  if (al !== undefined) {
    conPrint(`"${name}" is an alias: ${al}`);
    return;
  }
  conPrint(`help:  no cvar or command named ${args[0]}`, 'warn');
}

function differencesCommand(): void {
  let n = 0;
  for (const c of console_.allCvars().sort((a, b) => a.name.localeCompare(b.name))) {
    if (c.value === c.defaultValue || c.flags & FCVAR_HIDDEN) continue;
    conPrint(`"${c.name}" = "${c.value}" ( def. "${c.defaultValue}" )`);
    n++;
  }
  conPrint(`${n} convars differ from their default`, 'info');
}

/** Source getpos output: "setpos x y z;setang pitch yaw roll" (feet position, so it round-trips with setpos). */
/**
 * CS:GO getpos output. `getpos` prints the EYE position ("setpos x y z;setang p y r", z = origin + view offset) and
 * `setpos` takes eye coordinates, so shared positions put you on the floor; the _exact variants use the origin.
 */
export function getposText(pos: Vec3, angles: QAngle, exact = false): string {
  const sp = exact ? 'setpos_exact' : 'setpos';
  const sa = exact ? 'setang_exact' : 'setang';
  return `${sp} ${fmtCoord(pos.x)} ${fmtCoord(pos.y)} ${fmtCoord(pos.z)};${sa} ${fmtCoord(angles.pitch)} ${fmtCoord(angles.yaw)} ${fmtCoord(angles.roll)}`;
}

/** CS:GO / browser commands that have no effect here; registered so pasted configs don't spam warnings. */
const NOOP_COMMANDS = [
  'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9', 'slot10', 'lastinv', 'invprev',
  'invnext', 'drop', 'buymenu', 'teammenu', 'autobuy', 'rebuy', 'use', 'player_ping', 'radio', 'radio1', 'radio2',
  'radio3', '+lookatweapon', '-lookatweapon', '+voicerecord', '-voicerecord', '+spray_menu', '-spray_menu',
  '+radialradio', '-radialradio', '+radialradio2', '-radialradio2', '+radialradio3', '-radialradio3', 'impulse',
  'snd_restart', 'r_cleardecals', 'clear_debug_overlays', 'cl_clearhinthistory', 'joy_advancedupdate', 'showbriefing',
];

// ------------------------------------------------------------------------------------------ registration

let ctxRef: CommandContext | null = null;
let registered = false;

/** The context commands run against (tests). */
export function commandContext(): CommandContext | null {
  return ctxRef;
}

function needMap(): CommandSession | null {
  const s = ctxRef?.session ?? null;
  if (!s) conPrint("Can't do that without a map loaded.", 'warn');
  return s;
}

/**
 * Registers every console + chat command (once); they act on `ctx` (the latest call wins, so tests can swap the
 * game).
 */
export function registerGameCommands(ctx: CommandContext): void {
  ctxRef = ctx;
  if (registered) return;
  registered = true;
  const c = (): CommandContext => ctxRef!;
  const reg = (name: string, help: string, handler: (args: string[]) => void, extra: { flags?: number; complete?: (p: string) => string[] } = {}) =>
    registerCommand({ name, help, handler: (args) => handler(args), ...extra });

  addConfigProvider(() => aliasList().map(([k, v]) => `alias "${k}" "${v}"`));

  // ---- maps / connection
  let mapNameCache: string[] = [];
  const refreshNames = () => {
    void c()
      .mapNames()
      .then((n) => {
        mapNameCache = n;
      })
      .catch(() => undefined);
  };
  const mapComplete = (partial: string): string[] => {
    if (!mapNameCache.length) refreshNames();
    const p = partial.toLowerCase();
    return mapNameCache.filter((n) => n.toLowerCase().startsWith(p)).slice(0, 64);
  };
  const mapHandler = (args: string[]) => {
    if (!args.length) {
      conPrint(`map <mapname> : load a map${c().mapName ? ` (current: ${c().mapName})` : ''}`);
      return;
    }
    void c().loadMapByName(args[0].replace(/\.bsp$/i, ''));
  };
  reg('map', 'map <mapname> : load a map (catalog name or built-in id)', mapHandler, { complete: mapComplete });
  reg('changelevel', 'changelevel <mapname> : change the map', mapHandler, { complete: mapComplete });
  reg('maps', 'maps [filter] : list the playable maps', (args) => {
    const q = (args[0] ?? '').toLowerCase().replace(/\*/g, '');
    void c()
      .mapNames()
      .then((names) => {
        mapNameCache = names;
        const list = names.filter((n) => n.toLowerCase().includes(q));
        if (list.length) conPrint(list.join('\n'));
        conPrint(`${list.length} maps`, 'info');
      })
      .catch((e: Error) => conPrint(`maps: ${e.message}`, 'error'));
  });
  reg('disconnect', 'Leave the map (back to the main menu).', () => c().disconnect());
  reg('retry', 'Reload the current map.', () => void c().retry());
  reg('reconnect', 'Reload the current map.', () => void c().retry());
  const quit = () => {
    c().disconnect();
    conPrint('Close the browser tab to quit.', 'info');
  };
  reg('quit', 'Leave the map (close the tab to quit).', quit);
  reg('exit', 'Leave the map (close the tab to quit).', quit);
  reg('status', 'Server and player status.', () => {
    const ctx = c();
    const s = ctx.session;
    const o = s?.player.origin;
    conPrint(
      [
        'hostname: SURF Local Server',
        'version : 1.0.0/surf (browser)',
        'udp/ip  : 127.0.0.1:27015 (local)',
        'os      : Browser',
        'type    : listen',
        `map     : ${ctx.mapName ?? '<none>'}${o ? ` at: ${Math.round(o.x)} x, ${Math.round(o.y)} y, ${Math.round(o.z)} z` : ''}`,
        `players : 1 humans, ${s && s.replay.spectating ? 1 : 0} bots (1 max)`,
        '# userid name                uniqueid            connected ping loss state  rate',
        `#      2 "${playerName()}"`.padEnd(30) + ' STEAM_1:0:0          00:00     0    0 active 786432',
      ].join('\n'),
    );
  });
  reg('version', 'Print the version.', () => conPrint('SURF 1.0.0 — CS:GO surf in the browser (Source movement, KSF maps, SurfTimer)'));

  // ---- player
  reg('noclip', 'Toggle noclip (puts the run in practice mode).', () => {
    const s = needMap();
    if (!s) return;
    const on = s.player.moveType !== MOVETYPE_NOCLIP;
    c().setNoclip(on);
    conPrint(on ? 'noclip ON' : 'noclip OFF');
  });
  const kill = () => {
    if (!needMap()) return;
    c().killPlayer('kill');
  };
  reg('kill', 'Kill yourself (respawn at the start).', kill);
  reg('explode', 'Kill yourself (respawn at the start).', kill);
  const setpos = (exact: boolean) => (args: string[]) => {
    const s = needMap();
    if (!s) return;
    const usage = `Usage:  ${exact ? 'setpos_exact' : 'setpos'} x y <z optional>`;
    if (args.length < 2) {
      conPrint(usage);
      return;
    }
    const ps = s.player;
    const x = parseNum(args[0]);
    const y = parseNum(args[1]);
    // setpos takes the eye position (what getpos prints); setpos_exact the origin
    const z = args[2] !== undefined ? parseNum(args[2]) : null;
    if (x === null || y === null || (args[2] !== undefined && z === null)) {
      conPrint(usage);
      return;
    }
    const oz = z === null ? ps.origin.z : exact ? z : z - ps.viewOffsetZ;
    s.timer.enterPractice('setpos');
    c().teleportPlayer(v3(x, y, oz), null, null);
  };
  reg('setpos', 'setpos x y [z] : move your eyes to a position, as printed by getpos (practice mode).', setpos(false));
  reg('setpos_exact', 'setpos_exact x y [z] : move your origin (feet) to a position (practice mode).', setpos(true));
  const setang = (args: string[]) => {
    if (args.length < 2) {
      conPrint('Usage:  setang pitch yaw <roll optional>');
      return;
    }
    const p = parseNum(args[0]);
    const y = parseNum(args[1]);
    const r = args[2] !== undefined ? parseNum(args[2]) : 0;
    if (p === null || y === null || r === null) {
      conPrint('Usage:  setang pitch yaw <roll optional>');
      return;
    }
    c().setViewAngles(p, y, r);
  };
  reg('setang', 'setang pitch yaw [roll] : set the view angles.', setang);
  reg('setang_exact', 'setang_exact pitch yaw [roll] : set the view angles.', setang);
  const getpos = (exact: boolean) => () => {
    const s = needMap();
    if (!s) return;
    const o = s.player.origin;
    conPrint(getposText(exact ? o : v3(o.x, o.y, o.z + s.player.viewOffsetZ), c().getViewAngles(), exact));
  };
  reg('getpos', 'Print your eye position and view as a setpos/setang command.', getpos(false));
  reg('getpos_exact', 'Print your origin and view as a setpos_exact/setang_exact command.', getpos(true));
  reg(
    'ent_fire',
    'ent_fire <target> <input> [parameter] [delay] : fire an input on map entities (cheat).',
    (args) => {
      const s = needMap();
      if (!s) return;
      if (args.length < 2) {
        conPrint('Usage:  ent_fire <target> <input> [parameter] [delay]');
        return;
      }
      if (typeof s.entities.fireInput !== 'function') {
        conPrint('ent_fire is not available.', 'warn');
        return;
      }
      s.entities.fireInput(args[0], args[1], args[2] ?? '', parseNum(args[3]) ?? 0);
    },
    { flags: FCVAR_CHEAT },
  );

  // ---- console utilities
  reg('echo', 'Echo text to the console.', (args) => conPrint(args.join(' ')));
  reg('clear', 'Clear the console.', () => {
    console_.history.length = 0;
  });
  reg('help', 'help <command or cvar> : describe it.', helpCommand);
  reg('cvarlist', 'cvarlist [prefix] : list console variables and commands.', cvarListCommand);
  reg('find', 'find <text> : find cvars and commands whose name or help contains the text.', findCommand);
  reg('differences', 'List the cvars that differ from their default.', differencesCommand);
  reg('toggle', 'toggle <cvar> [value1 value2 ...] : toggle a cvar or cycle through values.', toggleCommand);
  reg('incrementvar', 'incrementvar <cvar> <min> <max> <delta> : add delta, wrapping around.', incrementvarCommand);
  reg('alias', 'alias <name> <commands> : create a command alias (alias with no arguments lists them).', (args) => {
    if (!args.length) {
      const list = aliasList();
      conPrint('Current alias commands:');
      for (const [k, v] of list) conPrint(`${k} : ${v}`);
      return;
    }
    const name = args[0];
    if (!setAlias(name, args.slice(1).join(' '))) {
      conPrint(`Can't alias "${name}": that name is a command or cvar.`, 'warn');
    }
  });
  reg('unalias', 'unalias <name> : remove an alias.', (args) => {
    if (!args.length) {
      conPrint('Usage:  unalias <name>');
      return;
    }
    if (!aliasValues.has(args[0].toLowerCase())) {
      conPrint(`unalias: "${args[0]}" is not an alias`, 'warn');
      return;
    }
    setAlias(args[0], '');
  });
  reg('exec', 'exec <config> : run a saved config ("config").', (args) => {
    const name = (args[0] ?? '').toLowerCase().replace(/\.cfg$/, '');
    if (name === 'config' || name === 'config_default') {
      if (!loadSavedConfig()) conPrint('exec: no saved config yet (host_writeconfig saves one).', 'warn');
      return;
    }
    conPrint(`exec: couldn't exec ${args[0] ?? ''}`, 'warn');
  });

  // ---- UI
  reg('toggleconsole', 'Show/hide the console.', () => c().ui.toggleConsole());
  reg('messagemode', 'Open the chat.', () => c().ui.openChat(false));
  reg('messagemode2', 'Open the team chat.', () => c().ui.openChat(true));
  reg('cancelselect', 'Open or close the pause menu (Escape).', () => {
    const ctx = c();
    if (ctx.state === 'playing') ctx.pause();
    else if (ctx.state === 'paused') ctx.resume();
  });
  reg('gameui_activate', 'Show the pause menu.', () => c().pause());
  reg('gameui_hide', 'Hide the pause menu.', () => c().resume());

  // ---- chat
  reg('say', 'say <text> : chat (!cmd and /cmd run chat commands).', (args) => handleSay(c(), args.join(' '), false));
  reg('say_team', 'say_team <text> : team chat.', (args) => handleSay(c(), args.join(' '), true));
  const seen = new Set<string>();
  for (const cmd of CHAT_COMMANDS) {
    for (const n of cmd.names) {
      if (seen.has(n)) continue;
      seen.add(n);
      reg(`sm_${n}`, `${cmd.usage} — ${cmd.help}`, (args) => runChatCommand(c(), n, args));
    }
  }

  for (const n of NOOP_COMMANDS) if (!console_.hasCommand(n)) reg(n, 'No effect in surf.', () => undefined, { flags: FCVAR_HIDDEN });
}

/** The SurfTimer-style welcome lines shown when a map finishes loading. */
export function welcomeMessage(ctx: CommandContext, s: CommandSession): void {
  const zones = s.timer.getZones();
  reply(ctx, seg('Welcome to '), seg(s.map.name, 'lightblue'), seg('! Type '), seg('!help', 'gold'), seg(' for the commands.'));
  reply(ctx, ...mapInfoSegments(s.map, s.tier, zones, s.timer.zoneSource));
  const sum = zoneSummary(zones);
  if (!zones.length) reply(ctx, seg('This map has no timer zones: ', 'lightred'), seg('!zones', 'gold'), seg(' to create them.'));
  else if (!sum.hasEnd) reply(ctx, seg('No end zone found for this map: the timer only starts. ', 'orange'), seg('!zones', 'gold'), seg(' to add one.'));
}

