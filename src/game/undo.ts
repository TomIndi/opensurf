// Undo of an accidental restart: R (!r, restart the map) sits right next to T (!back, restart the stage), and a
// miss mid-run throws the run away. Before !r restarts a run in progress (a ranked run, a practice run with time
// on the clock, stage practice) the game keeps a snapshot of it; !undo (also !undorestart / !unrestart, the
// console command surf_undo, bound to G by default) puts it back exactly: the player where and how it was, the
// timer on the same run clock (the time in between counts like a pause: a ranked run stays ranked), the replay
// recording carrying on. The snapshot lives until a new run starts, another !r replaces it, the map changes or
// an undo uses it. Game.keepRunForUndo / Game.undoRestart (game.ts) take and apply it; this module holds the
// snapshot type, the plain-data copy helpers and the undo key lookup for the chat hint.
import { QAngle } from '../core/angles';
import { console_, tokenizeCommandLine } from '../core/cvars';
import type { PlayerState } from '../physics/playertypes';
import { binds, BindTable } from './binds';
import type { PlayerEntSnapshot } from './entities';
import type { TimerRunSnapshot } from './timer';

/** Chat command names of the undo (also sm_<name>); the first is the one the hints show. */
export const UNDO_CHAT_NAMES: readonly string[] = ['undo', 'undorestart', 'unrestart'];
/** The console command. */
export const UNDO_CONSOLE_COMMAND = 'surf_undo';

/** What !r keeps of the run it restarts (Session.undo). */
export interface RunUndoSnapshot {
  /** The whole PlayerState (a deep copy). */
  readonly player: PlayerState;
  /** The input view (the mouse view, which may be ahead of player.viewAngles until the next tick). */
  readonly view: QAngle;
  /** Session per-tick bookkeeping: the yaw of the last usercmd (strafe sync), last tick's jump (jump count), footsteps. */
  readonly lastCmdYaw: number;
  readonly lastJumped: boolean;
  readonly stepDistance: number;
  /** SurfTimer.snapshotRun(): the run, its clocks, splits, stats, zone contacts and replay recording. */
  readonly timer: TimerRunSnapshot;
  /** EntitySystem.snapshotPlayer(): targetname, classname, health, damage filter and trigger contacts. */
  readonly entities: PlayerEntSnapshot | null;
  /** The timer's runGeneration when it was taken: a new run since makes it stale. */
  readonly generation: number;
  /**
   * Set when a server/physics cvar changed after the restart: a ranked run comes back as practice (the same rule as
   * a change mid-run).
   */
  practiceReason: string | null;
}

type Plain = Record<string, unknown>;

function isObject(v: unknown): v is Plain {
  return v !== null && typeof v === 'object';
}

/** Values copied whole (replaced, never merged field by field). */
function isLeafContainer(v: Plain): boolean {
  return Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof Map || v instanceof Set;
}

/** A deep copy of plain data (objects, arrays, typed arrays, Maps, Sets, primitives). */
export function deepClone<T>(v: T): T {
  if (!isObject(v)) return v;
  if (ArrayBuffer.isView(v)) return (v as unknown as { slice(): T }).slice();
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as T;
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, deepClone(x)])) as T;
  if (v instanceof Set) return new Set([...v].map((x) => deepClone(x))) as T;
  const out: Plain = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out as T;
}

/**
 * Copies plain data `src` into `dst` in place: nested objects (origin, velocity, view angles...) are updated, not
 * replaced, so references to them stay valid. Every key of `src` is copied (fields added to PlayerState later
 * included).
 */
export function assignDeep(dst: object, src: object): void {
  const d = dst as Plain;
  const s = src as Plain;
  for (const k of Object.keys(s)) {
    const sv = s[k];
    const dv = d[k];
    if (isObject(sv) && isObject(dv) && !isLeafContainer(sv) && !isLeafContainer(dv)) assignDeep(dv, sv);
    else d[k] = deepClone(sv);
  }
}

const UNDO_SAY = new RegExp(`^[!/](${UNDO_CHAT_NAMES.join('|')})$`, 'i');
const UNDO_CONSOLE = new Set([UNDO_CONSOLE_COMMAND, ...UNDO_CHAT_NAMES.map((n) => `sm_${n}`)]);

/** Whether a command line (a bind) runs the undo: say !undo, say /undo, surf_undo, sm_undo, or an alias of one. */
export function runsUndo(line: string, depth = 0): boolean {
  if (depth > 8) return false;
  for (const argv of tokenizeCommandLine(line)) {
    const name = (argv[0] ?? '').toLowerCase();
    if (UNDO_CONSOLE.has(name)) return true;
    if ((name === 'say' || name === 'say_team') && UNDO_SAY.test(argv.slice(1).join(' ').trim())) return true;
    const alias = console_.getAlias(name);
    if (alias !== undefined && runsUndo(alias, depth + 1)) return true;
  }
  return false;
}

/** The key bound to the undo (the first in key order: letters first), or null when none is. */
export function undoKey(table: BindTable = binds): string | null {
  for (const [key, cmd] of table.entries()) if (runsUndo(cmd)) return key;
  return null;
}
