// Runtime map logic for Source maps: brush triggers touching the player, entity filters, the entity I/O
// event queue, logic entities and brush-entity toggles. Surf maps are built from these (stage teleports,
// boosters, targetname-filtered anti-skip teleports, timers, counters), so the behaviour follows the Source
// engine semantics described in the comments below. Implemented from scratch from those descriptions.
//
// Per tick (after playerMove, see docs/ARCHITECTURE.md):
//   1. touches: every enabled trigger whose brushes overlap the player hull (boxIntersectsBrush) gets
//      StartTouch (new contact) + Touch, in entity-lump order; triggers no longer overlapped get EndTouch
//      afterwards (the engine marks new touches during the move and checks for lost touches after it).
//   2. thinks: logic_timer, func_button return, ...
//   3. the I/O event queue: every event whose fire time has come, including 0-delay chains queued meanwhile.
//
// Outputs are queued even with delay 0 (like Source), so a filter evaluated during a touch sees the player's
// targetname as it was before this tick's AddOutputs. Teleports, pushes and gravity apply immediately.
import { QAngle, angleVectors, qa, qaClone } from '../core/angles';
import { Cvar, registerCvar } from '../core/cvars';
import { Vec3, v3, v3clone, v3parse } from '../core/vec3';
import { isSolidBrushEntity } from '../bsp/bspcollision';
import { parseOutputValue } from '../bsp/entities';
import { EntityOutput, MapEntity } from '../map/types';
import { boxIntersectsBrush } from '../physics/collision';
import { playerHull } from '../physics/movement';
import { FL_BASEVELOCITY, FL_ONGROUND, MOVETYPE_NOCLIP, MOVETYPE_OBSERVER } from '../physics/playertypes';
import { Brush, MASK_SOLID } from '../physics/types';
import { IEntitySystem, WorldHost } from './contracts';

// ------------------------------------------------------------------------------------------ constants

/** Time slack for "has this time come" checks (well below 0.001 s, the relay refire delay). */
const TIME_EPS = 1e-5;
/** Safety valve against I/O loops (a relay re-triggering itself with 0 delay): events per tick. */
const MAX_EVENTS_PER_TICK = 20000;

// trigger spawnflags (CBaseTrigger)
const SF_TRIGGER_ALLOW_CLIENTS = 0x01;
const SF_TRIGGER_ONLY_CLIENTS_IN_VEHICLES = 0x20;
const SF_TRIGGER_ALLOW_ALL = 0x40;
const SF_TRIGGER_ONLY_CLIENTS_OUT_OF_VEHICLES = 0x200;
// trigger_teleport
const SF_TELEPORT_PRESERVE_ANGLES = 0x20;
// trigger_push
const SF_PUSH_ONCE = 0x80;
// logic_relay
const SF_RELAY_REMOVE_ON_FIRE = 0x01;
const SF_RELAY_ALLOW_FAST_RETRIGGER = 0x02;
// logic_auto
const SF_AUTO_REMOVE_ON_FIRE = 0x01;
// logic_timer
const SF_TIMER_UPDOWN = 0x01;
// func_wall_toggle
const SF_WALL_START_OFF = 0x01;
// func_button
const SF_BUTTON_TOGGLE = 0x20;
const SF_BUTTON_TOUCH_ACTIVATES = 0x100;
const SF_BUTTON_USE_ACTIVATES = 0x400;
const SF_BUTTON_LOCKED = 0x800;
// env_hudhint / game_text
const SF_ALL_PLAYERS = 0x01;

const LOGIC_TIMER_MIN_INTERVAL = 0.01;
/** trigger_hurt applies damage every half second (damage keyvalue is per second): damage * 0.5 per hit. */
const HURT_INTERVAL = 0.5;
/** +use reach (CS player use radius). */
const USE_RANGE = 80;
const BOOSTER_SOUND_INTERVAL = 0.5;

/** Render modes that make renderamt act as alpha (kRenderTransColor .. kRenderWorldGlow, minus Environmental). */
const TRANSLUCENT_RENDERMODES = new Set([1, 2, 3, 4, 5, 7, 8, 9]);
const RENDERMODE_NONE = 10;

/** Brush entity classes the engine never draws (their brushes only define a volume). */
const HIDDEN_BRUSH_CLASSES = new Set([
  'func_buyzone',
  'func_bomb_target',
  'func_hostage_rescue',
  'func_precipitation',
  'func_dustmotes',
  'func_dustcloud',
  'func_smokevolume',
  'func_clip_vphysics',
  'func_occluder',
  'func_nav_blocker',
  'func_nav_avoid',
  'func_nav_prefer',
  'func_nav_avoidance_obstacle',
  'func_no_defuse',
  'func_nobuild',
  'func_vehicleclip',
  'func_ladder',
  'func_ladderendpoint',
  'func_areaportal',
  'func_areaportalwindow',
  'func_viscluster',
  'func_combine_ball_spawner',
  'func_bomb_target',
]);

/**
 * Inputs that are understood but have no gameplay effect here (sounds, particles, props, cameras, moving
 * brushes, vscript...). They are never reported as unknown.
 */
const SILENT_INPUTS = new Set([
  'playsound', 'stopsound', 'fadein', 'fadeout', 'volume', 'pitch', 'togglesound', 'enablesound', 'disablesound',
  'setparent', 'setparentattachment', 'setparentattachmentmaintainoffset', 'clearparent',
  'setdamagefilter', 'enabledamageforces', 'disabledamageforces', 'ignorefalldamage', 'ignorefalldamagewithoutreset',
  'strip', 'stripweaponsandsuit', 'startshake', 'stopshake', 'amplitude', 'frequency', 'fade',
  'turnon', 'turnoff', 'showsprite', 'hidesprite', 'togglesprite', 'colorredvalue', 'colorgreenvalue', 'colorbluevalue',
  'setscale', 'setanimation', 'setdefaultanimation', 'setplaybackrate', 'skin', 'setbodygroup', 'setmodel', 'setmodelscale',
  'start', 'stop', 'startforward', 'startbackward', 'reverse', 'stopatstartpos', 'setspeed', 'setspeeddir', 'setspeedreal',
  'setspeeddiraccel', 'setspeedforwardmodifier', 'teleporttopathtrack', 'setmaxspeed', 'resume', 'toggledirection',
  'use', 'forcespawn', 'forcespawnatentityorigin', 'setcamera', 'seton', 'setoff', 'setonandturnothersoff', 'changefov',
  'enablecollision', 'disablecollision', 'enablemotion', 'disablemotion', 'wake', 'sleep', 'break', 'sethealth', 'addhealth',
  'removehealth', 'enablepath', 'disablepath', 'togglepath', 'enablealternatepath', 'disablealternatepath',
  'togglealternatepath', 'inpass', 'setposition', 'setpositionimmediately', 'setlight', 'setpattern', 'fadetopattern',
  'enable', 'disable', 'toggle', 'open', 'close', 'lock', 'unlock', 'press', 'pressin', 'pressout', 'setposition',
  'runscriptfile', 'runscriptcode', 'callscriptfunction', 'addcontext', 'removecontext', 'clearcontext',
  'dispatcheffect', 'dispatchresponse', 'enableshadow', 'disableshadow', 'alternativesorting', 'setfogcolor',
  'setfogcolorsecondary', 'setstartdist', 'setenddist', 'setmaxdensity', 'setfarz', 'setangles', 'setcolorlerptime',
  'startfogtransition', 'setfogcontroller', 'setpostprocesscontroller', 'setcolorcorrectioncontroller', 'sparkonce',
  'startspark', 'stopspark', 'ignite', 'ignitelifetime', 'extinguish', 'becomeragdoll', 'sethudvisibility', 'setdsp',
  'showmessage', 'showhudhint', 'hidehudhint', 'display', 'command', 'modifyspeed', 'settext', 'settextcolor',
  'settextcolor2', 'setglowenabled', 'setglowdisabled', 'setglowcolor', 'teleport', 'setremotedestination', 'add',
  'subtract', 'setvalue', 'setvaluenofire', 'getvalue', 'enabledraw', 'disabledraw', 'alpha', 'color', 'shoot',
  'setteam', 'kill', 'killhierarchy', 'addoutput', 'fireuser1', 'fireuser2', 'fireuser3', 'fireuser4', 'outvalue',
  'setsequence', 'spawn', 'setattack', 'setintensity', 'clearcollision', 'setcollision', 'skipbehaviour',
  'setlightingorigin', 'setlightinghack', 'setrenderattribute', 'setdefaultfadecolor', 'setglowstyle', 'setglowrange',
  'disableflashlight', 'enableflashlight', 'setlocalorigin', 'setlocalangles', 'setabsorigin', 'setabsangles',
]);

/** Player keyvalues (AddOutput on !activator) that only affect the third-person model/HUD. */
const PLAYER_COSMETIC_KEYS = new Set([
  'rendermode', 'renderamt', 'rendercolor', 'renderfx', 'modelindex', 'model', 'skin', 'scale', 'modelscale', 'body',
  'disableshadows', 'disablereceiveshadows', 'max_health', 'friction', 'speed', 'maxspeed', 'teamnum', 'effects',
  'angles', 'angle', 'nextthink', 'damagefilter', 'parentname', 'spawnflags', 'responsecontext', 'solid', 'collisiongroup',
  'movetype', 'fademindist', 'fademaxdist', 'fadescale', 'shadowcastdist',
]);

/**
 * Classes that can affect gameplay but are not simulated (moving/breakable brushes stay where the map put
 * them; physics pushers do nothing). Reported in diagnostics() and, with `developer 1`, at spawn.
 */
const UNSIMULATED_GAMEPLAY_CLASSES = new Set([
  'func_door',
  'func_door_rotating',
  'func_movelinear',
  'func_rotating',
  'func_tracktrain',
  'func_tanktrain',
  'func_train',
  'func_plat',
  'func_platrot',
  'func_physbox',
  'func_physbox_multiplayer',
  'func_breakable',
  'func_breakable_surf',
  'func_conveyor',
  'func_pushable',
  'func_water_analog',
  'momentary_rot_button',
  'trigger_catapult',
  'trigger_wind',
  'trigger_playermovement',
  'trigger_apply_impulse',
  'trigger_impact',
  'point_push',
  'env_physexplosion',
  'game_ui',
  'env_entity_maker',
  'logic_measure_movement',
  'logic_script',
]);

// ------------------------------------------------------------------------------------------ helpers

/** Source FIELD_BOOLEAN keyvalue parsing: atoi(value) != 0 ("Allow entities that match criteria" is false). */
function kvBool(v: string | undefined): boolean {
  if (v === undefined) return false;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n !== 0;
}

function kvInt(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function kvNum(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseColor(v: string | undefined): [number, number, number] {
  if (!v) return [255, 255, 255];
  const p = v.trim().split(/[\s,]+/).map(Number);
  const c = (x: number | undefined): number => (Number.isFinite(x) ? Math.max(0, Math.min(255, x as number)) : 255);
  return [c(p[0]), c(p[1]), c(p[2])];
}

/**
 * Source's entity name matching (CBaseEntity::NameMatches): ASCII case-insensitive; a '*' in the query
 * matches the rest of the name (only trailing wildcards are supported, like the engine). An empty name
 * matches only "" and "*".
 */
export function nameMatches(query: string, name: string): boolean {
  if (!name) return query === '' || query.charCodeAt(0) === 42;
  const n = Math.min(query.length, name.length);
  let i = 0;
  for (; i < n; i++) {
    let a = query.charCodeAt(i);
    let b = name.charCodeAt(i);
    if (a === b) continue;
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) break;
  }
  if (i === query.length && i === name.length) return true;
  return query.charCodeAt(i) === 42; // '*'
}

export type AddOutputParsed =
  | { kind: 'keyvalue'; key: string; value: string }
  | { kind: 'output'; output: EntityOutput };

/**
 * Parses an AddOutput parameter. "key value" sets a keyvalue (the value is everything after the first
 * space, verbatim); "OnEvent target:input:param:delay:times" (CS:GO colon form) or the comma form adds an
 * output connection. Returns null for a malformed string (no space).
 */
export function parseAddOutput(param: string): AddOutputParsed | null {
  const sp = param.indexOf(' ');
  if (sp <= 0) return null;
  const key = param.slice(0, sp);
  const rest = param.slice(sp + 1);
  const lk = key.toLowerCase();
  if (rest.includes(':')) {
    const parts = rest.split(':');
    const delay = parseFloat(parts[3] ?? '');
    const times = parseInt(parts[4] ?? '', 10);
    return {
      kind: 'output',
      output: {
        event: lk,
        target: (parts[0] ?? '').trim(),
        input: (parts[1] ?? '').trim(),
        param: parts[2] ?? '',
        delay: Number.isFinite(delay) ? delay : 0,
        timesToFire: Number.isFinite(times) && times !== 0 ? times : -1,
      },
    };
  }
  if ((lk.startsWith('on') || lk === 'outvalue') && rest.includes(',')) {
    const o = parseOutputValue(lk, rest);
    if (o) return { kind: 'output', output: o };
  }
  return { kind: 'keyvalue', key, value: rest };
}

function dirFromAngles(s: string | undefined): Vec3 {
  const a = v3parse(s);
  const out = v3();
  angleVectors(qa(a.x, a.y, a.z), out);
  return out;
}

// ------------------------------------------------------------------------------------------ the player

/** The local player as an I/O participant (activator, filter subject, AddOutput target). */
export class PlayerEnt {
  readonly isPlayer = true;
  targetname = '';
  classname = 'player';
  health = 100;
  /** Damage filter entity name (SetDamageFilter); consulted by trigger_hurt. */
  damageFilter = '';
}

type Activator = Ent | PlayerEnt | null;
type AnyEnt = Ent | PlayerEnt;

interface QueuedEvent {
  time: number;
  seq: number;
  /** Target name (resolved when the event fires) or a direct entity. */
  target: string | Ent;
  input: string;
  param: string;
  activator: Activator;
  caller: Ent | null;
}

/** Binary min-heap ordered by (time, insertion order): same-time events fire FIFO like Source's queue. */
class EventQueue {
  private heap: QueuedEvent[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(e: Omit<QueuedEvent, 'seq'>): void {
    const ev = e as QueuedEvent;
    ev.seq = this.seq++;
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  peek(): QueuedEvent | undefined {
    return this.heap[0];
  }

  pop(): QueuedEvent | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0];
    const last = h.pop() as QueuedEvent;
    if (h.length) {
      h[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Removes every event matching `pred`; returns how many were removed. */
  removeWhere(pred: (e: QueuedEvent) => boolean): number {
    const before = this.heap.length;
    this.heap = this.heap.filter((e) => !pred(e));
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
    return before - this.heap.length;
  }

  clear(): void {
    this.heap.length = 0;
  }

  private less(a: QueuedEvent, b: QueuedEvent): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private siftDown(i: number): void {
    const h = this.heap;
    const n = h.length;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(h[l], h[m])) m = l;
      if (r < n && this.less(h[r], h[m])) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
}

/** The fog an env_fog_controller describes (player input SetFogController <name>). */
export interface FogControllerState {
  name: string;
  enabled: boolean;
  /** sRGB 0..1 (fogcolor). */
  color: [number, number, number];
  start: number;
  end: number;
  maxDensity: number;
}

/** Fired after a trigger_teleport moved the player (the timer uses it for stage heuristics). */
export interface MapTeleportEvent {
  /** Classname of the trigger (trigger_teleport, trigger_teleport_relative, point_teleport...). */
  classname: string;
  triggerName: string;
  /** Destination entity name and index (-1 for relative teleports / no entity). */
  destination: string;
  destinationIndex: number;
  origin: Vec3;
  /** Landmark/relative teleports keep velocity and view ("seamless"). */
  seamless: boolean;
}

// ------------------------------------------------------------------------------------------ entities

class Ent {
  readonly sys: EntitySystem;
  readonly index: number;
  classname: string;
  targetname: string;
  readonly kv: Record<string, string>;
  /** Connections by lower-case output name, in entity-lump order (Source fires same-time ones in reverse). */
  readonly outputs = new Map<string, EntityOutput[]>();
  origin: Vec3;
  angles: QAngle;
  readonly model: number;
  spawnflags: number;
  killed = false;
  /** Classes implemented here: their unknown inputs are worth reporting. */
  get modeled(): boolean {
    return false;
  }

  constructor(sys: EntitySystem, src: MapEntity) {
    this.sys = sys;
    this.index = src.index;
    this.classname = src.classname;
    this.targetname = src.targetname;
    this.kv = { ...src.kv };
    for (const o of src.outputs) this.addConnection({ ...o });
    this.origin = v3clone(src.origin);
    this.angles = qaClone(src.angles);
    this.model = src.model;
    this.spawnflags = kvInt(this.kv.spawnflags);
  }

  hasFlag(f: number): boolean {
    return (this.spawnflags & f) !== 0;
  }

  /** A MapEntity view of the current state (for helpers that take one). */
  srcLike(): MapEntity {
    return {
      index: this.index,
      classname: this.classname,
      targetname: this.targetname,
      kv: this.kv,
      outputs: [],
      origin: this.origin,
      angles: this.angles,
      model: this.model,
    };
  }

  addConnection(o: EntityOutput): void {
    const ev = o.event.toLowerCase();
    let l = this.outputs.get(ev);
    if (!l) this.outputs.set(ev, (l = []));
    l.push({ ...o, event: ev });
  }

  /** Initial state (all entities exist, names are indexed). */
  spawn(): void {}
  /** Cross-entity references (filters...). */
  activate(): void {}
  /** Periodic update for entities on the think list. */
  think(_now: number): void {}

  /** Keyvalue change through AddOutput (spawn values are read in spawn()). */
  keyValue(key: string, value: string): void {
    this.kv[key] = value;
    switch (key) {
      case 'targetname':
        this.sys.rename(this, value);
        break;
      case 'classname':
        this.classname = value;
        break;
      case 'origin':
        this.origin = v3parse(value);
        break;
      case 'angles': {
        const a = v3parse(value);
        this.angles = qa(a.x, a.y, a.z);
        break;
      }
      case 'spawnflags':
        this.spawnflags = kvInt(value);
        break;
    }
  }

  /** Class inputs; return false to fall through to the generic CBaseEntity inputs. Name is lower-case. */
  input(_name: string, _param: string, _activator: Activator, _caller: Ent | null): boolean {
    return false;
  }

  fire(event: string, activator: Activator, value?: string): void {
    this.sys.fireOutput(this, event, activator, value);
  }

  onKilled(): void {}
}

// ---------------------------------------------------------------- filters

class FilterEnt extends Ent {
  negated = false;
  override get modeled(): boolean {
    return true;
  }
  override spawn(): void {
    this.negated = kvBool(this.kv.negated);
  }
  override keyValue(key: string, value: string): void {
    super.keyValue(key, value);
    if (key === 'negated') this.negated = kvBool(value);
  }
  passes(e: AnyEnt, depth = 0): boolean {
    const r = this.test(e, depth);
    return this.negated ? !r : r;
  }
  protected test(_e: AnyEnt, _depth: number): boolean {
    return true;
  }
  override input(name: string, _param: string, activator: Activator): boolean {
    if (name === 'testactivator') {
      if (activator) this.fire(this.passes(activator) ? 'onpass' : 'onfail', activator);
      return true;
    }
    if (name === 'setnegated' || name === 'setnegate') {
      this.negated = kvBool(_param);
      return true;
    }
    return false;
  }
}

class FilterName extends FilterEnt {
  protected override test(e: AnyEnt): boolean {
    const f = this.kv.filtername ?? '';
    if (f.toLowerCase() === '!player') return e instanceof PlayerEnt;
    return nameMatches(f, e.targetname);
  }
}

class FilterClass extends FilterEnt {
  protected override test(e: AnyEnt): boolean {
    return nameMatches(this.kv.filterclass ?? '', e.classname);
  }
}

class FilterTeam extends FilterEnt {
  protected override test(e: AnyEnt): boolean {
    // The local player plays on CT (team 3); entities have no team.
    const team = e instanceof PlayerEnt ? 3 : 0;
    return kvInt(this.kv.filterteam) === team;
  }
}

/** filter_damage_type: only meaningful as a damage filter (passes everything as an activator filter). */
class FilterDamageType extends FilterEnt {
  /** Damage of `type` passes this filter (CFilterDamageType: exact type match, then negation). */
  passesDamage(type: number): boolean {
    const r = type === kvInt(this.kv.damagetype);
    return this.negated ? !r : r;
  }
}

class FilterMulti extends FilterEnt {
  private subs: FilterEnt[] = [];
  override activate(): void {
    this.subs = [];
    for (let i = 1; i <= 10; i++) {
      const n = this.kv[`filter${String(i).padStart(2, '0')}`];
      if (!n) continue;
      const f = this.sys.findFilter(n);
      if (f && f !== this) this.subs.push(f);
    }
  }
  protected override test(e: AnyEnt, depth: number): boolean {
    if (depth > 8 || !this.subs.length) return true;
    const or = kvInt(this.kv.filtertype) === 1;
    for (const f of this.subs) {
      const r = f.passes(e, depth + 1);
      if (or && r) return true;
      if (!or && !r) return false;
    }
    return !or;
  }
}

// ---------------------------------------------------------------- triggers

class BaseTrigger extends Ent {
  readonly brushes: Brush[];
  readonly mins: Vec3;
  readonly maxs: Vec3;
  enabled = true;
  filterName = '';
  filter: FilterEnt | null = null;
  /** Engine-level contact with the player (overlap last evaluated). */
  engineTouching = false;
  touchStamp = 0;
  /** Player is in this trigger's touching list (passed the filters at StartTouch). */
  filterTouching = false;

  override get modeled(): boolean {
    return true;
  }

  constructor(sys: EntitySystem, src: MapEntity, brushes: Brush[], mins: Vec3, maxs: Vec3) {
    super(sys, src);
    this.brushes = brushes;
    this.mins = mins;
    this.maxs = maxs;
  }

  override spawn(): void {
    this.enabled = !kvBool(this.kv.startdisabled);
    this.filterName = this.kv.filtername ?? '';
    this.sys.setModelVisible(this.model, false); // triggers are never drawn (EF_NODRAW)
  }

  override activate(): void {
    this.filter = this.filterName ? this.sys.findFilter(this.filterName) : null;
  }

  override keyValue(key: string, value: string): void {
    super.keyValue(key, value);
    if (key === 'filtername') {
      this.filterName = value;
      this.filter = value ? this.sys.findFilter(value) : null;
    }
  }

  /** CBaseTrigger::PassesTriggerFilters for the local player. */
  passes(p: PlayerEnt): boolean {
    const sf = this.spawnflags;
    if ((sf & (SF_TRIGGER_ALLOW_CLIENTS | SF_TRIGGER_ALLOW_ALL | SF_TRIGGER_ONLY_CLIENTS_OUT_OF_VEHICLES)) === 0) return false;
    if (sf & SF_TRIGGER_ONLY_CLIENTS_IN_VEHICLES && !(sf & SF_TRIGGER_ALLOW_ALL)) return false;
    return !this.filter || this.filter.passes(p);
  }

  overlaps(bmins: Vec3, bmaxs: Vec3): boolean {
    if (bmaxs.x <= this.mins.x || bmins.x >= this.maxs.x) return false;
    if (bmaxs.y <= this.mins.y || bmins.y >= this.maxs.y) return false;
    if (bmaxs.z <= this.mins.z || bmins.z >= this.maxs.z) return false;
    const bs = this.brushes;
    if (!bs.length) return true; // no brush data: the model box is the volume
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (bmaxs.x <= b.mins.x || bmins.x >= b.maxs.x) continue;
      if (bmaxs.y <= b.mins.y || bmins.y >= b.maxs.y) continue;
      if (bmaxs.z <= b.mins.z || bmins.z >= b.maxs.z) continue;
      if (boxIntersectsBrush(bmins, bmaxs, b)) return true;
    }
    return false;
  }

  startTouch(p: PlayerEnt): void {
    if (!this.passes(p)) return;
    const first = !this.filterTouching;
    this.filterTouching = true;
    this.fire('onstarttouch', p);
    if (first) this.fire('onstarttouchall', p);
  }

  touch(_p: PlayerEnt): void {}

  endTouch(p: PlayerEnt): void {
    // Source fires these even when the trigger was disabled (that is what ends the touch).
    if (!this.filterTouching) return;
    this.filterTouching = false;
    this.fire('onendtouch', p);
    this.fire('onendtouchall', p);
  }

  override input(name: string, _param: string, activator: Activator, _caller: Ent | null): boolean {
    switch (name) {
      case 'enable':
        this.enabled = true;
        return true;
      case 'disable':
        this.enabled = false;
        return true;
      case 'toggle':
        this.enabled = !this.enabled;
        return true;
      case 'touchtest':
        this.fire(this.filterTouching ? 'ontouching' : 'onnottouching', activator);
        return true;
      case 'starttouch':
      case 'endtouch':
        return true;
    }
    return false;
  }
}

/** trigger_multiple / trigger_once: OnTrigger on Touch, rate-limited by `wait` (-1 = once, then removed). */
class TriggerMultiple extends BaseTrigger {
  wait = 0.2;
  private nextTrigger = -Infinity;
  private spent = false;

  override spawn(): void {
    super.spawn();
    if (this.classname.toLowerCase() === 'trigger_once') this.wait = -1;
    else {
      this.wait = kvNum(this.kv.wait, 0);
      if (this.wait === 0) this.wait = 0.2;
    }
  }

  override keyValue(key: string, value: string): void {
    super.keyValue(key, value);
    if (key === 'wait') this.wait = kvNum(value, 0.2) || 0.2;
  }

  override touch(p: PlayerEnt): void {
    if (this.spent || !this.passes(p)) return;
    if (this.sys.now < this.nextTrigger - TIME_EPS) return; // still waiting for reset
    this.fire('ontrigger', p);
    if (this.wait > 0) this.nextTrigger = this.sys.now + this.wait;
    else {
      // fired once: stop touching now, remove shortly after (like the engine's deferred SUB_Remove)
      this.spent = true;
      this.sys.queueSelf(this, '__remove', 0.1);
    }
  }

  override input(name: string, param: string, activator: Activator, caller: Ent | null): boolean {
    if (name === '__remove') {
      this.sys.kill(this);
      return true;
    }
    return super.input(name, param, activator, caller);
  }
}

/** trigger_teleport: moves the player to `target` (optionally relative to `landmark`) on Touch. */
class TriggerTeleport extends BaseTrigger {
  override touch(p: PlayerEnt): void {
    if (!this.passes(p)) return;
    const sys = this.sys;
    // FindEntityByName(target) with the toucher as activator and caller
    const dest = sys.findFirst(this.kv.target ?? '', null, p, p);
    if (!dest) return;
    const ps = sys.host.player;
    const lmName = this.kv.landmark ?? '';
    const landmark = lmName ? sys.findFirst(lmName, null, p, p) : null;
    const d = sys.originOf(dest);
    const o = v3(d.x, d.y, d.z);
    let angles: QAngle | null = null;
    let velocity: Vec3 | null = null;
    if (landmark) {
      // keep the offset from the landmark, velocity and view ("seamless" teleports)
      const l = sys.originOf(landmark);
      o.x += ps.origin.x - l.x;
      o.y += ps.origin.y - l.y;
      o.z += ps.origin.z - l.z;
      if (kvBool(this.kv.uselandmarkangles)) angles = sys.viewAnglesOf(dest);
    } else if (!this.hasFlag(SF_TELEPORT_PRESERVE_ANGLES)) {
      // snap the view to the destination and stop the player
      angles = sys.viewAnglesOf(dest);
      velocity = v3();
    }
    sys.teleportFromMap(o, angles, velocity, {
      classname: this.classname,
      triggerName: this.targetname,
      destination: dest.targetname,
      destinationIndex: dest instanceof Ent ? dest.index : -1,
      origin: v3clone(o),
      seamless: !!landmark || this.hasFlag(SF_TELEPORT_PRESERVE_ANGLES),
    });
  }

  override input(name: string, param: string, activator: Activator, caller: Ent | null): boolean {
    if (name === 'setremotedestination') {
      this.kv.target = param;
      return true;
    }
    return super.input(name, param, activator, caller);
  }
}

/** trigger_teleport_relative: offsets the player by `teleportoffset`, keeping velocity and view. */
class TriggerTeleportRelative extends BaseTrigger {
  override touch(p: PlayerEnt): void {
    if (!this.passes(p)) return;
    const off = v3parse(this.kv.teleportoffset);
    const ps = this.sys.host.player;
    const o = v3(ps.origin.x + off.x, ps.origin.y + off.y, ps.origin.z + off.z);
    this.sys.teleportFromMap(o, null, null, {
      classname: this.classname,
      triggerName: this.targetname,
      destination: '',
      destinationIndex: -1,
      origin: v3clone(o),
      seamless: true,
    });
  }
}

/** trigger_push (CTriggerPush::Touch semantics): base velocity while touching, or a one-shot impulse. */
class TriggerPush extends BaseTrigger {
  speed = 100;
  dir = v3(1, 0, 0);
  private readonly push = v3();

  override spawn(): void {
    super.spawn();
    this.speed = kvNum(this.kv.speed, 0) || 100;
    this.dir = dirFromAngles(this.kv.pushdir);
  }

  override keyValue(key: string, value: string): void {
    super.keyValue(key, value);
    if (key === 'speed') this.speed = kvNum(value, 0) || 100;
    else if (key === 'pushdir') this.dir = dirFromAngles(value);
  }

  private canPush(): boolean {
    const mt = this.sys.host.player.moveType;
    return mt !== MOVETYPE_NOCLIP && mt !== MOVETYPE_OBSERVER;
  }

  override startTouch(p: PlayerEnt): void {
    super.startTouch(p);
    if (this.passes(p) && this.canPush()) this.sys.boosterSound();
  }

  override touch(p: PlayerEnt): void {
    if (!this.passes(p) || !this.canPush()) return;
    const ps = this.sys.host.player;
    const sp = this.speed;
    const d = this.dir;
    if (this.hasFlag(SF_PUSH_ONCE)) {
      // instant: transfer the velocity and remove the trigger
      ps.velocity.x += d.x * sp;
      ps.velocity.y += d.y * sp;
      ps.velocity.z += d.z * sp;
      if (d.z > 0) leaveGround(ps);
      this.sys.kill(this);
      return;
    }
    const push = this.push;
    push.x = d.x * sp;
    push.y = d.y * sp;
    push.z = d.z * sp;
    if (ps.flags & FL_BASEVELOCITY) {
      // another push already touched this tick: they add up
      push.x += ps.baseVelocity.x;
      push.y += ps.baseVelocity.y;
      push.z += ps.baseVelocity.z;
    }
    if (push.z > 0 && (ps.onGround || ps.flags & FL_ONGROUND)) {
      leaveGround(ps);
      ps.origin.z += 1;
    }
    ps.baseVelocity.x = push.x;
    ps.baseVelocity.y = push.y;
    ps.baseVelocity.z = push.z;
    ps.flags |= FL_BASEVELOCITY;
  }

  override input(name: string, param: string, activator: Activator, caller: Ent | null): boolean {
    if (name === 'setpushspeed' || name === 'setspeed') {
      const s = parseFloat(param);
      if (Number.isFinite(s)) this.speed = s;
      return true;
    }
    if (name === 'setpushdirection' || name === 'setpushdir') {
      this.dir = dirFromAngles(param);
      return true;
    }
    return super.input(name, param, activator, caller);
  }
}

function leaveGround(ps: WorldHost['player']): void {
  ps.onGround = false;
  ps.flags &= ~FL_ONGROUND;
  ps.groundModel = -1;
}

/**
 * trigger_hurt: `damage` per second, applied as damage * 0.5 every half second from the first touch (Source's
 * HurtThink); the hit that takes health to 0 asks the host to kill (a surf "void" trigger with 1000+ damage
 * kills on contact, a 100-damage one on its second hit half a second later).
 */
class TriggerHurt extends BaseTrigger {
  damage = 10;
  private nextHurt = -Infinity;

  override spawn(): void {
    super.spawn();
    this.damage = kvNum(this.kv.damage, 10);
  }

  override keyValue(key: string, value: string): void {
    super.keyValue(key, value);
    if (key === 'damage') this.damage = kvNum(value, this.damage);
  }

  override touch(p: PlayerEnt): void {
    if (!this.passes(p)) return;
    const now = this.sys.now;
    if (now < this.nextHurt - TIME_EPS) return;
    this.nextHurt = now + HURT_INTERVAL;
    if (!this.sys.playerTakesDamage(kvInt(this.kv.damagetype))) return;
    const dmg = this.damage * HURT_INTERVAL;
    if (dmg === 0) return;
    if (dmg < 0) {
      p.health = Math.min(100, p.health - dmg);
      return;
    }
    p.health -= dmg;
    this.fire('onhurt', p);
    this.fire('onhurtplayer', p);
    if (p.health <= 0) this.sys.killPlayer(`${this.classname} ${this.targetname}`.trim());
  }

  override input(name: string, param: string, activator: Activator, caller: Ent | null): boolean {
    if (name === 'setdamage') {
      this.damage = kvNum(param, this.damage);
      return true;
    }
    return super.input(name, param, activator, caller);
  }
}

/** trigger_gravity: sets the toucher's gravity scale (it persists after leaving, like Source). */
class TriggerGravity extends BaseTrigger {
  override touch(p: PlayerEnt): void {
    if (!this.passes(p)) return;
    this.sys.host.player.gravityScale = kvNum(this.kv.gravity, 1);
  }
}

// ---------------------------------------------------------------- logic

class LogicEnt extends Ent {
  override get modeled(): boolean {
    return true;
  }
}

class LogicRelay extends LogicEnt {
  disabled = false;
  private waitForRefire = false;

  override spawn(): void {
    this.disabled = kvBool(this.kv.startdisabled);
  }

  /** Fired by EntitySystem.spawn() after all entities exist. */
  fireSpawnOutput(): void {
    this.fire('onspawn', null);
  }

  override input(name: string, _param: string, activator: Activator): boolean {
    switch (name) {
      case 'trigger':
      case 'forcetrigger':
        if (name === 'trigger' && (this.disabled || this.waitForRefire)) return true;
        this.fire('ontrigger', activator);
        if (this.hasFlag(SF_RELAY_REMOVE_ON_FIRE)) this.sys.kill(this);
        else if (!this.hasFlag(SF_RELAY_ALLOW_FAST_RETRIGGER)) {
          // can't refire until the last output has fired
          this.waitForRefire = true;
          this.sys.queueSelf(this, 'enablerefire', this.maxDelay('ontrigger') + 0.001);
        }
        return true;
      case 'enablerefire':
        this.waitForRefire = false;
        return true;
      case 'cancelpending':
        this.sys.cancelPending(this);
        this.waitForRefire = false;
        return true;
      case 'enable':
        this.disabled = false;
        return true;
      case 'disable':
        this.disabled = true;
        return true;
      case 'toggle':
        this.disabled = !this.disabled;
        return true;
    }
    return false;
  }

  private maxDelay(event: string): number {
    let m = 0;
    for (const o of this.outputs.get(event) ?? []) if (o.delay > m) m = o.delay;
    return m;
  }
}

class LogicAuto extends LogicEnt {
  fireSpawn(): void {
    // A dedicated server loading a map: new game + map spawn (+ multiplayer new map), then CS:GO's first
    // round starts (OnMultiNewRound: CS:GO-era maps put their setup logic there).
    this.fire('onnewgame', null);
    this.fire('onmapspawn', null);
    this.fire('onmultinewmap', null);
    this.fire('onmultinewround', null);
    if (this.hasFlag(SF_AUTO_REMOVE_ON_FIRE)) this.sys.kill(this);
  }
}

class LogicTimer extends LogicEnt {
  disabled = false;
  refire = 1;
  useRandom = false;
  lower = 0;
  upper = 1;
  next = Infinity;
  private up = false;

  override spawn(): void {
    this.refire = Math.max(LOGIC_TIMER_MIN_INTERVAL, kvNum(this.kv.refiretime, 0));
    this.useRandom = kvBool(this.kv.userandomtime);
    this.lower = kvNum(this.kv.lowerrandombound, 0);
    this.upper = kvNum(this.kv.upperrandombound, 0);
    this.disabled = kvBool(this.kv.startdisabled);
    if (!this.disabled) this.next = this.sys.now + this.interval();
    this.sys.addThinker(this);
  }

  interval(): number {
    if (this.useRandom) {
      const lo = Math.min(this.lower, this.upper);
      const hi = Math.max(this.lower, this.upper);
      return Math.max(LOGIC_TIMER_MIN_INTERVAL, lo + Math.random() * (hi - lo));
    }
    return this.refire;
  }

  override think(now: number): void {
    if (this.disabled || this.killed) return;
    if (now >= this.next - TIME_EPS) {
      this.fireTimer();
      this.next = now + this.interval();
    }
  }

  private fireTimer(): void {
    if (this.hasFlag(SF_TIMER_UPDOWN)) {
      this.up = !this.up;
      this.fire(this.up ? 'ontimerhigh' : 'ontimerlow', this);
    } else this.fire('ontimer', this);
  }

  override keyValue(key: string, value: string): void {
    super.keyValue(key, value);
    if (key === 'refiretime') this.refire = Math.max(LOGIC_TIMER_MIN_INTERVAL, kvNum(value, this.refire));
  }

  override input(name: string, param: string): boolean {
    const now = this.sys.now;
    switch (name) {
      case 'enable':
        this.disabled = false;
        this.next = now + this.interval();
        return true;
      case 'disable':
        this.disabled = true;
        this.next = Infinity;
        return true;
      case 'toggle':
        return this.input(this.disabled ? 'enable' : 'disable', param);
      case 'firetimer':
        this.fireTimer();
        return true;
      case 'refiretime':
        this.refire = Math.max(LOGIC_TIMER_MIN_INTERVAL, kvNum(param, this.refire));
        if (!this.disabled) this.next = now + this.interval();
        return true;
      case 'resettimer':
        if (!this.disabled) this.next = now + this.interval();
        return true;
      case 'addtotimer':
        if (!this.disabled) this.next += kvNum(param, 0);
        return true;
      case 'subtractfromtimer':
        if (!this.disabled) this.next -= kvNum(param, 0);
        return true;
      case 'lowerrandombound':
        this.lower = kvNum(param, this.lower);
        return true;
      case 'upperrandombound':
        this.upper = kvNum(param, this.upper);
        return true;
    }
    return false;
  }
}

class MathCounter extends LogicEnt {
  value = 0;
  min = 0;
  max = 0;
  disabled = false;
  private hitMin = false;
  private hitMax = false;

  override spawn(): void {
    this.min = kvNum(this.kv.min, 0);
    this.max = kvNum(this.kv.max, 0);
    this.disabled = kvBool(this.kv.startdisabled);
    let v = kvNum(this.kv.startvalue, 0);
    if (this.hasRange()) v = Math.min(Math.max(v, Math.min(this.min, this.max)), Math.max(this.min, this.max));
    this.value = v;
  }

  private hasRange(): boolean {
    return this.min !== 0 || this.max !== 0;
  }

  /** Clamps, fires OnHitMax/OnHitMin on reaching a bound (once until it moves away), then OutValue. */
  private update(v: number, activator: Activator): void {
    if (this.hasRange()) {
      if (v >= this.max) {
        if (!this.hitMax) {
          this.hitMax = true;
          this.fire('onhitmax', activator);
        }
      } else this.hitMax = false;
      if (v <= this.min) {
        if (!this.hitMin) {
          this.hitMin = true;
          this.fire('onhitmin', activator);
        }
      } else this.hitMin = false;
      v = Math.min(Math.max(v, this.min), this.max);
    }
    this.value = v;
    this.fire('outvalue', activator, String(v));
  }

  override input(name: string, param: string, activator: Activator): boolean {
    const p = parseFloat(param);
    const arith = name === 'add' || name === 'subtract' || name === 'multiply' || name === 'divide' || name === 'setvalue';
    if (arith && this.disabled) return true;
    switch (name) {
      case 'add':
        if (Number.isFinite(p)) this.update(this.value + p, activator);
        return true;
      case 'subtract':
        if (Number.isFinite(p)) this.update(this.value - p, activator);
        return true;
      case 'multiply':
        if (Number.isFinite(p)) this.update(this.value * p, activator);
        return true;
      case 'divide':
        if (Number.isFinite(p) && p !== 0) this.update(this.value / p, activator);
        return true;
      case 'setvalue':
        if (Number.isFinite(p)) this.update(p, activator);
        return true;
      case 'setvaluenofire':
        if (Number.isFinite(p)) this.value = this.hasRange() ? Math.min(Math.max(p, this.min), this.max) : p;
        return true;
      case 'sethitmax':
      case 'setmaxvaluenofire':
        if (Number.isFinite(p)) {
          this.max = p;
          if (name === 'sethitmax' && this.hasRange()) this.update(this.value, activator);
        }
        return true;
      case 'sethitmin':
      case 'setminvaluenofire':
        if (Number.isFinite(p)) {
          this.min = p;
          if (name === 'sethitmin' && this.hasRange()) this.update(this.value, activator);
        }
        return true;
      case 'getvalue':
        this.fire('ongetvalue', activator, String(this.value));
        return true;
      case 'enable':
        this.disabled = false;
        return true;
      case 'disable':
        this.disabled = true;
        return true;
    }
    return false;
  }
}

class LogicCase extends LogicEnt {
  private shuffle: number[] = [];

  private cases(): number[] {
    const out: number[] = [];
    for (let i = 1; i <= 16; i++) if ((this.kv[`case${String(i).padStart(2, '0')}`] ?? '') !== '') out.push(i);
    return out;
  }

  private fireCase(i: number, activator: Activator): void {
    this.fire(`oncase${String(i).padStart(2, '0')}`, activator);
  }

  override input(name: string, param: string, activator: Activator): boolean {
    switch (name) {
      case 'invalue': {
        const pn = parseFloat(param);
        for (const i of this.cases()) {
          const c = this.kv[`case${String(i).padStart(2, '0')}`];
          const cn = parseFloat(c);
          if (c.toLowerCase() === param.toLowerCase() || (Number.isFinite(pn) && Number.isFinite(cn) && pn === cn)) {
            this.fireCase(i, activator);
            return true;
          }
        }
        this.fire('ondefault', activator, param);
        return true;
      }
      case 'pickrandom': {
        const cs = this.cases();
        if (cs.length) this.fireCase(cs[Math.floor(Math.random() * cs.length)], activator);
        return true;
      }
      case 'pickrandomshuffle': {
        if (!this.shuffle.length) {
          this.shuffle = this.cases();
          for (let i = this.shuffle.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.shuffle[i], this.shuffle[j]] = [this.shuffle[j], this.shuffle[i]];
          }
        }
        const c = this.shuffle.pop();
        if (c !== undefined) this.fireCase(c, activator);
        return true;
      }
    }
    return false;
  }
}

class LogicCompare extends LogicEnt {
  value = 0;
  compareValue = 0;

  override spawn(): void {
    this.value = kvNum(this.kv.initialvalue, 0);
    this.compareValue = kvNum(this.kv.comparevalue, 0);
  }

  private compare(activator: Activator): void {
    const v = String(this.value);
    if (this.value < this.compareValue) this.fire('onlessthan', activator, v);
    else if (this.value > this.compareValue) this.fire('ongreaterthan', activator, v);
    else this.fire('onequalto', activator, v);
    if (this.value !== this.compareValue) this.fire('onnotequalto', activator, v);
  }

  override input(name: string, param: string, activator: Activator): boolean {
    switch (name) {
      case 'setvalue':
        this.value = kvNum(param, this.value);
        return true;
      case 'setvaluecompare':
        this.value = kvNum(param, this.value);
        this.compare(activator);
        return true;
      case 'setcomparevalue':
        this.compareValue = kvNum(param, this.compareValue);
        return true;
      case 'compare':
        this.compare(activator);
        return true;
    }
    return false;
  }
}

class LogicBranch extends LogicEnt {
  value = false;

  override spawn(): void {
    this.value = kvBool(this.kv.initialvalue);
  }

  private test(activator: Activator): void {
    this.fire(this.value ? 'ontrue' : 'onfalse', activator);
  }

  override input(name: string, param: string, activator: Activator): boolean {
    switch (name) {
      case 'setvalue':
        this.value = kvBool(param);
        return true;
      case 'setvaluetest':
        this.value = kvBool(param);
        this.test(activator);
        return true;
      case 'toggle':
        this.value = !this.value;
        return true;
      case 'toggletest':
        this.value = !this.value;
        this.test(activator);
        return true;
      case 'test':
        this.test(activator);
        return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- point entities

class PointEnt extends Ent {
  override get modeled(): boolean {
    return true;
  }
}

/** player_speedmod: ModifySpeed scales the activating player's simulation speed (m_flLaggedMovementValue). */
class PlayerSpeedmod extends PointEnt {
  override input(name: string, param: string, activator: Activator): boolean {
    if (name !== 'modifyspeed') return false;
    const v = parseFloat(param);
    // only a player activator is affected (a multiplayer game has no "local player" fallback)
    if (activator instanceof PlayerEnt && Number.isFinite(v)) this.sys.host.player.laggedMovement = v;
    return true;
  }
}

/** point_servercommand / point_clientcommand: only "say ..." is meaningful offline (shown in chat). */
class PointCommand extends PointEnt {
  override input(name: string, param: string): boolean {
    if (name !== 'command') return false;
    const cmd = param.trim();
    const m = /^say(_team)?\s+(.*)$/i.exec(cmd);
    if (m) {
      const text = m[2].replace(/^"(.*)"$/, '$1');
      if (text) this.sys.host.chat([{ text: 'Console: ', color: 'lightred' }, { text }]);
    } else this.sys.devLog(`cmd:${cmd.split(/\s+/)[0]}`, `${this.classname}: ignored command "${cmd}"`);
    return true;
  }
}

class EnvHudHint extends PointEnt {
  override input(name: string, _param: string, activator: Activator): boolean {
    if (name !== 'showhudhint' && name !== 'hidehudhint') return false;
    if (!(activator instanceof PlayerEnt) && !this.hasFlag(SF_ALL_PLAYERS)) return true;
    if (name === 'showhudhint') this.sys.ui((ui) => ui.hint(this.kv.message ?? ''));
    else this.sys.ui((ui) => ui.hint('', 0));
    return true;
  }
}

class GameText extends PointEnt {
  override input(name: string, param: string, activator: Activator): boolean {
    if (name === 'settext') {
      this.kv.message = param;
      return true;
    }
    if (name !== 'display') return false;
    if (!(activator instanceof PlayerEnt) && !this.hasFlag(SF_ALL_PLAYERS)) return true;
    const msg = (this.kv.message ?? '').replace(/\\n/g, '\n');
    const hold = kvNum(this.kv.holdtime, 2) + kvNum(this.kv.fadein, 0) + kvNum(this.kv.fadeout, 0);
    if (msg) this.sys.ui((ui) => ui.centerPrint(msg, hold));
    return true;
  }
}

/** point_teleport: Teleport moves `target` to this entity's origin/angles (velocity kept). */
class PointTeleport extends PointEnt {
  override input(name: string, _param: string, activator: Activator, caller: Ent | null): boolean {
    if (name !== 'teleport') return false;
    const t = this.sys.findFirst(this.kv.target ?? '', this, activator, caller);
    if (t instanceof PlayerEnt) {
      this.sys.teleportFromMap(v3clone(this.origin), { pitch: this.angles.pitch, yaw: this.angles.yaw, roll: 0 }, null, {
        classname: this.classname,
        triggerName: this.targetname,
        destination: this.targetname,
        destinationIndex: this.index,
        origin: v3clone(this.origin),
        seamless: false,
      });
    } else if (t) {
      t.origin = v3clone(this.origin);
      t.angles = qaClone(this.angles);
    }
    return true;
  }
}

/** point_template spawnflags */
const SF_TEMPLATE_DONT_REMOVE = 0x01;
const SF_TEMPLATE_PRESERVE_NAMES = 0x02;

/**
 * point_template: its Template01..16 entities are removed at map load (unless "don't remove template
 * entities") and a fresh copy of them is created on every ForceSpawn, names suffixed "&NNNN" (with
 * references between them fixed up) unless "preserve entity names". Fires OnEntitySpawned.
 */
class PointTemplate extends PointEnt {
  templates: MapEntity[] = [];

  override input(name: string, _param: string, activator: Activator): boolean {
    if (name !== 'forcespawn') return false;
    this.sys.spawnTemplate(this, activator);
    return true;
  }
}

// ---------------------------------------------------------------- brush entities

const SOLIDITY_TOGGLE = 0;
const SOLIDITY_NEVER = 1;
const SOLIDITY_ALWAYS = 2;

class BrushEnt extends Ent {
  /** Not EF_NODRAW. */
  visible = true;
  rendermode = 0;
  renderamt = 255;
  color: [number, number, number] = [255, 255, 255];
  solidity = SOLIDITY_TOGGLE;
  private hiddenClass = false;
  private lcls = '';

  override get modeled(): boolean {
    return this.lcls === 'func_brush' || this.lcls === 'func_wall_toggle' || this.lcls === 'func_illusionary' || this.lcls === 'func_wall';
  }

  override spawn(): void {
    this.lcls = this.classname.toLowerCase();
    this.hiddenClass = HIDDEN_BRUSH_CLASSES.has(this.lcls) || this.lcls.startsWith('trigger_');
    this.rendermode = kvInt(this.kv.rendermode);
    this.renderamt = kvNum(this.kv.renderamt, 255);
    this.color = parseColor(this.kv.rendercolor);
    if (this.lcls === 'func_brush') {
      this.solidity = kvInt(this.kv.solidity);
      if (kvBool(this.kv.startdisabled)) this.turnOff(true);
    } else if (this.lcls === 'func_wall_toggle' && this.hasFlag(SF_WALL_START_OFF)) this.turnOff(true);
    this.applyRender(true);
  }

  turnOn(): void {
    this.visible = true;
    if (this.solidity !== SOLIDITY_NEVER) this.sys.setModelSolid(this.model, true);
    this.applyRender(false);
  }

  turnOff(initial = false): void {
    this.visible = false;
    if (this.solidity !== SOLIDITY_ALWAYS) this.sys.setModelSolid(this.model, false);
    if (!initial) this.applyRender(false);
  }

  get isOn(): boolean {
    return this.visible;
  }

  /** Pushes visibility/alpha/colour to the renderer (at spawn only non-default values). */
  applyRender(initial: boolean): void {
    const vis = !this.killed && this.visible && !this.hiddenClass && this.rendermode !== RENDERMODE_NONE;
    if (!initial || !vis) this.sys.setModelVisible(this.model, vis);
    const alpha = TRANSLUCENT_RENDERMODES.has(this.rendermode) ? Math.max(0, Math.min(1, this.renderamt / 255)) : 1;
    if (!initial || alpha !== 1) this.sys.setModelAlpha(this.model, alpha);
    const c = this.color;
    if (!initial || c[0] !== 255 || c[1] !== 255 || c[2] !== 255) this.sys.setModelColor(this.model, [c[0] / 255, c[1] / 255, c[2] / 255]);
  }

  override keyValue(key: string, value: string): void {
    super.keyValue(key, value);
    switch (key) {
      case 'rendermode':
        this.rendermode = kvInt(value);
        this.applyRender(false);
        break;
      case 'renderamt':
        this.renderamt = kvNum(value, this.renderamt);
        this.applyRender(false);
        break;
      case 'rendercolor':
        this.color = parseColor(value);
        this.applyRender(false);
        break;
      case 'solidity':
        this.solidity = kvInt(value);
        break;
    }
  }

  override input(name: string, param: string, _activator: Activator, _caller: Ent | null): boolean {
    const toggleable = this.lcls === 'func_brush' || this.lcls === 'func_wall_toggle';
    if (toggleable) {
      switch (name) {
        case 'enable':
        case 'turnon':
          this.turnOn();
          return true;
        case 'disable':
        case 'turnoff':
          this.turnOff();
          return true;
        case 'toggle':
          if (this.visible) this.turnOff();
          else this.turnOn();
          return true;
      }
    }
    switch (name) {
      case 'alpha':
        this.renderamt = kvNum(param, this.renderamt);
        this.applyRender(false);
        return true;
      case 'color':
        this.color = parseColor(param);
        this.applyRender(false);
        return true;
      case 'enabledraw':
        this.visible = true;
        this.applyRender(false);
        return true;
      case 'disabledraw':
        this.visible = false;
        this.applyRender(false);
        return true;
    }
    return false;
  }

  override onKilled(): void {
    this.sys.setModelSolid(this.model, false);
    this.sys.setModelVisible(this.model, false);
  }
}

/** func_button: +use / touch / Press. OnPressed + OnIn, then OnOut after `wait` seconds (-1 = stays in). */
class FuncButton extends BrushEnt {
  state: 'in' | 'out' = 'out';
  locked = false;
  wait = 3;
  private returnAt = Infinity;
  /** Touch-activated contact state. */
  touching = false;

  override get modeled(): boolean {
    return true;
  }

  override spawn(): void {
    super.spawn();
    this.locked = this.hasFlag(SF_BUTTON_LOCKED);
    this.wait = kvNum(this.kv.wait, 3);
    this.sys.addThinker(this);
  }

  get usable(): boolean {
    return this.hasFlag(SF_BUTTON_USE_ACTIVATES);
  }

  get touchActivates(): boolean {
    return this.hasFlag(SF_BUTTON_TOUCH_ACTIVATES);
  }

  press(activator: Activator): void {
    if (this.killed) return;
    if (this.locked) {
      this.fire('onuselocked', activator);
      return;
    }
    if (this.hasFlag(SF_BUTTON_TOGGLE)) {
      if (this.state === 'in') this.goOut(activator);
      else this.goIn(activator, true);
      return;
    }
    if (this.state === 'in') return;
    this.goIn(activator, true);
    this.returnAt = this.wait >= 0 ? this.sys.now + this.wait : Infinity;
  }

  private goIn(activator: Activator, pressed: boolean): void {
    this.state = 'in';
    if (pressed) this.fire('onpressed', activator);
    this.fire('onin', activator);
  }

  private goOut(activator: Activator): void {
    this.state = 'out';
    this.returnAt = Infinity;
    this.fire('onout', activator);
  }

  override think(now: number): void {
    if (this.state === 'in' && now >= this.returnAt - TIME_EPS) this.goOut(this);
  }

  override input(name: string, param: string, activator: Activator, caller: Ent | null): boolean {
    switch (name) {
      case 'lock':
        this.locked = true;
        return true;
      case 'unlock':
        this.locked = false;
        return true;
      case 'press':
        this.press(activator);
        return true;
      case 'pressin':
        if (this.state !== 'in') this.goIn(activator, true);
        return true;
      case 'pressout':
        if (this.state !== 'out') this.goOut(activator);
        return true;
    }
    return super.input(name, param, activator, caller);
  }
}

// ------------------------------------------------------------------------------------------ the system

function isIgnoredTriggerClass(cls: string): boolean {
  return cls.startsWith('trigger_momentum_') || cls === 'trigger_soundscape';
}

export interface EntityDiagnostics {
  entities: number;
  triggers: number;
  pendingEvents: number;
  /** "class.input" -> count of inputs nothing handles. */
  unknownInputs: Map<string, number>;
  /** Target names that matched no entity -> count. */
  missingTargets: Map<string, number>;
  /** Gameplay-relevant classes present in the map that are not simulated -> count. */
  unsimulatedClasses: Map<string, number>;
}

/**
 * The runtime entity world for one map. Construct with the game's WorldHost, call spawn() once after the
 * player exists, tick() every tick after playerMove.
 *
 * Extra API beyond IEntitySystem: `playerClassname`, `playerHealth`, `resetPlayerState()`,
 * `addTeleportListener()`, `pressUse(eye, forward)` (call on +use), `fireInput()` (console ent_fire),
 * `reapplyRender()` (after the renderer rebuilt its meshes), `onFogController` (SetFogController hook),
 * `diagnostics()`, `describe()`, `counterValue()`.
 *
 * spawn() pushes brush-entity visibility/alpha/colour to host.renderer, so call it once the renderer has the
 * map (or call reapplyRender() afterwards). Map-driven teleports go through host.teleportPlayer with velocity
 * zero (no landmark) or null (= keep; landmark / preserve-angles teleports) and angles null (= keep view).
 */
export class EntitySystem implements IEntitySystem {
  readonly host: WorldHost;
  readonly player = new PlayerEnt();
  /** Simulation time of the current tick (host.time). */
  now = 0;
  private readonly ents: Ent[] = [];
  private readonly triggers: BaseTrigger[] = [];
  private readonly buttons: FuncButton[] = [];
  private readonly thinkers: Ent[] = [];
  private readonly byName = new Map<string, Ent[]>();
  private readonly brushByModel = new Map<number, BrushEnt>();
  private readonly queue = new EventQueue();
  private touching: BaseTrigger[] = [];
  private readonly overlapList: BaseTrigger[] = [];
  private readonly endedScratch: BaseTrigger[] = [];
  /** Models of removed template entities (hidden until a ForceSpawn creates them). */
  private readonly hiddenModels = new Set<number>();
  /** Index for entities created at runtime (point_template). */
  private nextIndex = 0;
  private templateInstance = 0;
  private stamp = 0;
  private spawned = false;
  private readonly logged = new Set<string>();
  private readonly unknownInputs = new Map<string, number>();
  private readonly missingTargets = new Map<string, number>();
  private readonly unsimulated = new Map<string, number>();
  private readonly developer: Cvar;
  private readonly teleportListeners: Array<(ev: MapTeleportEvent) => void> = [];
  /**
   * Called when map logic switches the player's fog (`!activator SetFogController fog_sea`). The renderer
   * contract has no dynamic fog yet; the core may forward this when it does.
   */
  onFogController: ((fog: FogControllerState) => void) | null = null;
  private mapTeleportDepth = 0;
  /** False while spawn() runs the map-spawn logic: no client is connected yet in a real server. */
  private playerPresent = true;
  private lastBoosterSound = -Infinity;
  private readonly boxMins = v3();
  private readonly boxMaxs = v3();
  private debugList: { mins: Vec3; maxs: Vec3; classname: string; enabled: boolean }[] | null = null;

  constructor(host: WorldHost) {
    this.host = host;
    this.developer = registerCvar({ name: 'developer', default: 0, help: 'Show developer messages (map logic diagnostics).' });
  }

  // ---------------------------------------------------------------- IEntitySystem

  get playerTargetname(): string {
    return this.player.targetname;
  }
  set playerTargetname(v: string) {
    this.player.targetname = v;
  }

  /** The player's classname as seen by filter_activator_class (AddOutput classname changes it). */
  get playerClassname(): string {
    return this.player.classname;
  }
  set playerClassname(v: string) {
    this.player.classname = v;
  }

  /** Health tracked for trigger_hurt (100 = full). */
  get playerHealth(): number {
    return this.player.health;
  }

  /** Restores the player's map-logic state (timer restarts): targetname "", classname "player", full health. */
  resetPlayerState(): void {
    this.player.targetname = '';
    this.player.classname = 'player';
    this.player.health = 100;
  }

  spawn(): void {
    if (this.spawned) return;
    this.spawned = true;
    this.now = this.host.time;
    const mapEnts = this.host.map.entities;
    this.nextIndex = mapEnts.length;
    // point_template entities: collect templates; the removed ones don't exist until ForceSpawn
    const templateOf = new Map<number, MapEntity[]>();
    const removed = new Set<number>();
    for (const src of mapEnts) {
      if (src.classname.toLowerCase() !== 'point_template') continue;
      const names = new Set<string>();
      for (let i = 1; i <= 16; i++) {
        const n = src.kv[`template${String(i).padStart(2, '0')}`];
        if (n) names.add(n.toLowerCase());
      }
      const list = mapEnts.filter((e) => e !== src && e.targetname && names.has(e.targetname.toLowerCase()));
      templateOf.set(src.index, list);
      const sf = parseInt(src.kv.spawnflags ?? '0', 10) || 0;
      if (!(sf & SF_TEMPLATE_DONT_REMOVE)) for (const e of list) removed.add(e.index);
    }
    for (const src of mapEnts) {
      if (removed.has(src.index)) {
        // a template brush entity is not in the world until spawned
        if (src.model > 0) {
          this.hiddenModels.add(src.model);
          this.setModelVisible(src.model, false);
          this.setModelSolid(src.model, false);
        }
        continue;
      }
      const e = this.create(src);
      if (e instanceof PointTemplate) e.templates = templateOf.get(src.index) ?? [];
      this.ents.push(e);
      if (e.targetname) this.indexName(e);
      const cls = src.classname.toLowerCase();
      if (UNSIMULATED_GAMEPLAY_CLASSES.has(cls)) this.unsimulated.set(cls, (this.unsimulated.get(cls) ?? 0) + 1);
    }
    if (this.unsimulated.size) {
      const list = [...this.unsimulated].map(([c, n]) => (n > 1 ? `${c} x${n}` : c)).join(', ');
      this.devLog('unsimulated', `not simulated on this map: ${list}`);
    }
    for (const e of this.ents) e.spawn();
    for (const e of this.ents) e.activate();
    for (const e of this.ents) {
      if (e instanceof LogicAuto && !e.killed) e.fireSpawn();
      else if (e instanceof LogicRelay && !e.killed) e.fireSpawnOutput();
    }
    this.playerPresent = false;
    try {
      this.serviceQueue();
    } finally {
      this.playerPresent = true;
    }
  }

  tick(): void {
    if (!this.spawned) this.spawn();
    this.now = this.host.time;
    this.updateTouches();
    for (let i = 0; i < this.thinkers.length; i++) {
      const t = this.thinkers[i];
      if (!t.killed) t.think(this.now);
    }
    this.serviceQueue();
  }

  onPlayerTeleported(): void {
    // A map teleport in progress (host.teleportPlayer may notify us): keep the natural EndTouch.
    if (this.mapTeleportDepth > 0) return;
    for (const t of this.touching) {
      t.engineTouching = false;
      t.filterTouching = false;
    }
    this.touching = [];
    for (const b of this.buttons) b.touching = false;
  }

  debugTriggers(): { mins: Vec3; maxs: Vec3; classname: string; enabled: boolean }[] {
    // cached objects aligned with this.triggers (no per-frame allocation unless triggers were killed)
    if (!this.debugList) {
      this.debugList = this.triggers.map((t) => ({ mins: t.mins, maxs: t.maxs, classname: t.classname, enabled: t.enabled }));
    }
    const list = this.debugList;
    let anyKilled = false;
    for (let i = 0; i < this.triggers.length; i++) {
      const t = this.triggers[i];
      list[i].enabled = t.enabled && !t.killed;
      list[i].classname = t.classname;
      if (t.killed) anyKilled = true;
    }
    return anyKilled ? list.filter((_, i) => !this.triggers[i].killed) : list;
  }

  findTarget(name: string): { origin: Vec3; angles: QAngle } | null {
    const e = this.findFirst(name, null, null, null);
    if (!e) return null;
    if (e instanceof PlayerEnt) return { origin: v3clone(this.host.player.origin), angles: qaClone(this.host.player.viewAngles) };
    return { origin: v3clone(e.origin), angles: qaClone(e.angles) };
  }

  // ---------------------------------------------------------------- extra API

  /** Subscribe to map-driven teleports. Returns an unsubscribe function. */
  addTeleportListener(cb: (ev: MapTeleportEvent) => void): () => void {
    this.teleportListeners.push(cb);
    return () => {
      const i = this.teleportListeners.indexOf(cb);
      if (i >= 0) this.teleportListeners.splice(i, 1);
    };
  }

  /**
   * +use: presses the func_button the player looks at within reach (eye position + normalized view forward).
   * Returns true if a button was used.
   */
  pressUse(eye: Vec3, forward: Vec3): boolean {
    let bestDist = USE_RANGE;
    let best: FuncButton | null = null;
    const end = v3(eye.x + forward.x * USE_RANGE, eye.y + forward.y * USE_RANGE, eye.z + forward.z * USE_RANGE);
    try {
      const tr = this.host.collision.traceRay(eye, end, MASK_SOLID);
      if (tr.fraction < 1) {
        bestDist = tr.fraction * USE_RANGE;
        const hit = tr.model > 0 ? this.brushByModel.get(tr.model) : undefined;
        if (hit instanceof FuncButton && !hit.killed) best = hit;
      }
    } catch {
      /* no collision world */
    }
    if (!best) {
      for (const b of this.buttons) {
        if (b.killed) continue;
        const brushes = this.host.map.models[b.model]?.brushes ?? [];
        const t = rayBrushesDistance(eye, forward, bestDist + 1, brushes);
        if (t >= 0 && t <= bestDist + 1) {
          bestDist = t;
          best = b;
        }
      }
    }
    if (!best || !best.usable) return false;
    best.press(this.player);
    return true;
  }

  /**
   * Pushes every brush entity's current visibility/alpha/colour (and hidden triggers / removed templates) to
   * the renderer again: call after the renderer (re)built the map's meshes.
   */
  reapplyRender(): void {
    for (const m of this.hiddenModels) this.setModelVisible(m, false);
    for (const t of this.triggers) this.setModelVisible(t.model, false);
    for (const e of this.ents) if (e instanceof BrushEnt) e.applyRender(false);
  }

  /** Queues an input like an output would (console ent_fire). The player is the activator. */
  fireInput(target: string, input: string, param = '', delay = 0): void {
    this.queue.push({ time: this.now + delay, target, input, param, activator: this.player, caller: null });
  }

  diagnostics(): EntityDiagnostics {
    return {
      entities: this.ents.length,
      triggers: this.triggers.length,
      pendingEvents: this.queue.size,
      unknownInputs: new Map(this.unknownInputs),
      missingTargets: new Map(this.missingTargets),
      unsimulatedClasses: new Map(this.unsimulated),
    };
  }

  /** Classname/targetname/enabled state of an entity by name (tests, debugging). */
  describe(name: string): { classname: string; targetname: string; enabled?: boolean; killed: boolean; kv: Record<string, string> } | null {
    const e = this.findFirst(name, null, null, null);
    if (!e || e instanceof PlayerEnt) return null;
    const out: { classname: string; targetname: string; enabled?: boolean; killed: boolean; kv: Record<string, string> } = {
      classname: e.classname,
      targetname: e.targetname,
      killed: e.killed,
      kv: { ...e.kv },
    };
    if (e instanceof BaseTrigger) out.enabled = e.enabled;
    else if (e instanceof LogicRelay || e instanceof LogicTimer || e instanceof MathCounter) out.enabled = !e.disabled;
    else if (e instanceof BrushEnt) out.enabled = e.isOn;
    return out;
  }

  /** math_counter value by name (tests, debugging). */
  counterValue(name: string): number | null {
    const e = this.findFirst(name, null, null, null);
    return e instanceof MathCounter ? e.value : null;
  }

  // ---------------------------------------------------------------- internals used by entities

  /** @internal */
  addThinker(e: Ent): void {
    if (!this.thinkers.includes(e)) this.thinkers.push(e);
  }

  /** @internal Queues `input` on `e` itself (relay refire, deferred removal). */
  queueSelf(e: Ent, input: string, delay: number): void {
    this.queue.push({ time: this.now + delay, target: e, input, param: '', activator: e, caller: e });
  }

  /** @internal logic_relay CancelPending: drops queued events fired by `caller`. */
  cancelPending(caller: Ent): void {
    this.queue.removeWhere((ev) => ev.caller === caller);
  }

  /** @internal */
  fireOutput(ent: Ent, event: string, activator: Activator, value?: string): void {
    const list = ent.outputs.get(event);
    if (!list || !list.length) return;
    // Source keeps connections newest-first and fires them in list order: same-delay outputs run in
    // reverse keyvalue order (and outputs added by AddOutput run first).
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      this.queue.push({
        time: this.now + o.delay,
        target: o.target,
        input: o.input,
        param: o.param !== '' ? o.param : value ?? '',
        activator,
        caller: ent,
      });
      if (o.timesToFire > 0) {
        o.timesToFire--;
        if (o.timesToFire === 0) list.splice(i, 1);
      }
    }
  }

  /** @internal */
  rename(e: Ent, name: string): void {
    this.unindexName(e);
    e.targetname = name;
    if (name && !e.killed) this.indexName(e);
  }

  /** @internal */
  findFilter(name: string): FilterEnt | null {
    for (const e of this.findByName(name, null, null, null, false)) if (e instanceof FilterEnt) return e;
    return null;
  }

  /** @internal First match of FindEntityByName (no classname fallback). */
  findFirst(name: string, self: Ent | null, activator: Activator, caller: AnyEnt | null): AnyEnt | null {
    const r = this.findByName(name, self, activator, caller, false);
    return r.length ? r[0] : null;
  }

  /** @internal */
  originOf(e: AnyEnt): Vec3 {
    return e instanceof PlayerEnt ? this.host.player.origin : e.origin;
  }

  /** @internal View angles a teleport to `e` snaps to (no roll). */
  viewAnglesOf(e: AnyEnt): QAngle {
    const a = e instanceof PlayerEnt ? this.host.player.viewAngles : e.angles;
    return { pitch: a.pitch, yaw: a.yaw, roll: 0 };
  }

  /** @internal Teleport requested by map logic (keeps the natural EndTouch of the trigger we leave). */
  teleportFromMap(origin: Vec3, angles: QAngle | null, velocity: Vec3 | null, info: MapTeleportEvent): void {
    this.mapTeleportDepth++;
    try {
      this.host.teleportPlayer(origin, angles, velocity);
    } finally {
      this.mapTeleportDepth--;
    }
    for (const l of this.teleportListeners.slice()) {
      try {
        l(info);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** @internal point_template ForceSpawn: creates a fresh copy of the template's entities. */
  spawnTemplate(pt: PointTemplate, activator: Activator): void {
    if (!pt.templates.length) {
      pt.fire('onentityspawned', activator);
      return;
    }
    const preserve = pt.hasFlag(SF_TEMPLATE_PRESERVE_NAMES);
    const instance = ++this.templateInstance;
    const names = new Set(pt.templates.map((t) => t.targetname.toLowerCase()));
    const fix = (v: string): string => (!preserve && v && names.has(v.toLowerCase()) ? `${v}&${String(instance).padStart(4, '0')}` : v);
    const created: Ent[] = [];
    for (const src of pt.templates) {
      const kv: Record<string, string> = {};
      for (const [k, v] of Object.entries(src.kv)) kv[k] = k === 'classname' || k === 'model' ? v : fix(v);
      const copy: MapEntity = {
        index: this.nextIndex++,
        classname: src.classname,
        targetname: fix(src.targetname),
        kv,
        outputs: src.outputs.map((o) => ({ ...o, target: fix(o.target) })),
        origin: v3clone(src.origin),
        angles: qaClone(src.angles),
        model: src.model,
      };
      const e = this.create(copy);
      this.ents.push(e);
      if (e.targetname) this.indexName(e);
      created.push(e);
    }
    this.debugList = null;
    for (const e of created) if (e.model > 0) this.hiddenModels.delete(e.model);
    for (const e of created) e.spawn();
    for (const e of created) {
      e.activate();
      if (e instanceof BrushEnt) {
        // back in the world: drawn per its render state, solid if its class is
        e.applyRender(false);
        if (e.isOn && isSolidBrushEntity(e.srcLike())) this.setModelSolid(e.model, true);
      }
    }
    pt.fire('onentityspawned', activator);
  }

  /** @internal Would the player's damage filter (SetDamageFilter) let damage of `type` through? */
  playerTakesDamage(type: number): boolean {
    const name = this.player.damageFilter;
    if (!name) return true;
    const f = this.findFilter(name);
    if (f instanceof FilterDamageType) return f.passesDamage(type);
    return true;
  }

  /** @internal */
  killPlayer(reason: string): void {
    this.host.killPlayer(reason);
    this.player.health = 100; // the timer respawns the player
  }

  /** @internal */
  kill(e: Ent): void {
    if (e.killed) return;
    e.killed = true;
    this.unindexName(e);
    if (e instanceof BaseTrigger && e.engineTouching) {
      e.engineTouching = false;
      e.filterTouching = false;
      const i = this.touching.indexOf(e);
      if (i >= 0) this.touching.splice(i, 1);
    }
    e.onKilled();
  }

  /** @internal */
  boosterSound(): void {
    if (this.now - this.lastBoosterSound < BOOSTER_SOUND_INTERVAL) return;
    this.lastBoosterSound = this.now;
    try {
      this.host.sound.play('booster');
    } catch {
      /* audio unavailable */
    }
  }

  /** @internal */
  ui(fn: (ui: WorldHost['ui']) => void): void {
    try {
      fn(this.host.ui);
    } catch (e) {
      console.error(e);
    }
  }

  /** @internal */
  setModelVisible(model: number, visible: boolean): void {
    if (model <= 0) return;
    try {
      this.host.renderer.setModelVisible(model, visible);
    } catch {
      /* renderer not ready */
    }
  }

  /** @internal */
  setModelAlpha(model: number, alpha: number): void {
    if (model <= 0) return;
    try {
      this.host.renderer.setModelAlpha(model, alpha);
    } catch {
      /* renderer not ready */
    }
  }

  /** @internal */
  setModelColor(model: number, rgb: [number, number, number]): void {
    if (model <= 0) return;
    try {
      this.host.renderer.setModelColor(model, rgb);
    } catch {
      /* renderer not ready */
    }
  }

  /** @internal */
  setModelSolid(model: number, solid: boolean): void {
    if (model <= 0) return;
    try {
      this.host.collision.setModelSolid(model, solid);
    } catch {
      /* no collision world */
    }
  }

  /** @internal Developer message, printed once per key while `developer` is non-zero. */
  devLog(key: string, msg: string): void {
    if (this.logged.has(key) || !this.developer.bool) return;
    this.logged.add(key);
    this.host.print(`[entities] ${msg}`);
  }

  // ---------------------------------------------------------------- creation

  private create(src: MapEntity): Ent {
    const cls = src.classname.toLowerCase();
    if (cls.startsWith('trigger_') && !isIgnoredTriggerClass(cls) && src.model > 0) {
      const info = this.host.map.models[src.model];
      if (info) {
        const brushes = info.brushes ?? [];
        const mins = v3(Infinity, Infinity, Infinity);
        const maxs = v3(-Infinity, -Infinity, -Infinity);
        for (const b of brushes) {
          mins.x = Math.min(mins.x, b.mins.x);
          mins.y = Math.min(mins.y, b.mins.y);
          mins.z = Math.min(mins.z, b.mins.z);
          maxs.x = Math.max(maxs.x, b.maxs.x);
          maxs.y = Math.max(maxs.y, b.maxs.y);
          maxs.z = Math.max(maxs.z, b.maxs.z);
        }
        if (!brushes.length) {
          mins.x = info.mins.x;
          mins.y = info.mins.y;
          mins.z = info.mins.z;
          maxs.x = info.maxs.x;
          maxs.y = info.maxs.y;
          maxs.z = info.maxs.z;
        }
        if (mins.x <= maxs.x && mins.y <= maxs.y && mins.z <= maxs.z) {
          let t: BaseTrigger;
          switch (cls) {
            case 'trigger_teleport':
              t = new TriggerTeleport(this, src, brushes, mins, maxs);
              break;
            case 'trigger_teleport_relative':
              t = new TriggerTeleportRelative(this, src, brushes, mins, maxs);
              break;
            case 'trigger_push':
              t = new TriggerPush(this, src, brushes, mins, maxs);
              break;
            case 'trigger_multiple':
            case 'trigger_once':
              t = new TriggerMultiple(this, src, brushes, mins, maxs);
              break;
            case 'trigger_hurt':
              t = new TriggerHurt(this, src, brushes, mins, maxs);
              break;
            case 'trigger_gravity':
              t = new TriggerGravity(this, src, brushes, mins, maxs);
              break;
            default:
              t = new BaseTrigger(this, src, brushes, mins, maxs);
          }
          this.triggers.push(t);
          return t;
        }
      }
    }
    switch (cls) {
      case 'filter_activator_name':
        return new FilterName(this, src);
      case 'filter_activator_class':
        return new FilterClass(this, src);
      case 'filter_activator_team':
        return new FilterTeam(this, src);
      case 'filter_multi':
        return new FilterMulti(this, src);
      case 'filter_damage_type':
        return new FilterDamageType(this, src);
      case 'logic_relay':
        return new LogicRelay(this, src);
      case 'logic_auto':
        return new LogicAuto(this, src);
      case 'logic_timer':
        return new LogicTimer(this, src);
      case 'math_counter':
        return new MathCounter(this, src);
      case 'logic_case':
        return new LogicCase(this, src);
      case 'logic_compare':
        return new LogicCompare(this, src);
      case 'logic_branch':
        return new LogicBranch(this, src);
      case 'player_speedmod':
        return new PlayerSpeedmod(this, src);
      case 'point_servercommand':
      case 'point_clientcommand':
      case 'point_broadcastclientcommand':
        return new PointCommand(this, src);
      case 'env_hudhint':
        return new EnvHudHint(this, src);
      case 'game_text':
        return new GameText(this, src);
      case 'point_teleport':
        return new PointTeleport(this, src);
      case 'point_template':
        return new PointTemplate(this, src);
    }
    if (cls.startsWith('filter_')) return new FilterEnt(this, src); // damage type, mass, context...: accept
    if (src.model > 0) {
      const b = cls === 'func_button' || cls === 'func_rot_button' ? new FuncButton(this, src) : new BrushEnt(this, src);
      this.brushByModel.set(src.model, b);
      if (b instanceof FuncButton) this.buttons.push(b);
      return b;
    }
    return new Ent(this, src);
  }

  private indexName(e: Ent): void {
    const k = e.targetname.toLowerCase();
    let l = this.byName.get(k);
    if (!l) this.byName.set(k, (l = []));
    if (!l.includes(e)) {
      // keep entity-index order
      let i = l.length;
      while (i > 0 && l[i - 1].index > e.index) i--;
      l.splice(i, 0, e);
    }
  }

  private unindexName(e: Ent): void {
    if (!e.targetname) return;
    const k = e.targetname.toLowerCase();
    const l = this.byName.get(k);
    if (!l) return;
    const i = l.indexOf(e);
    if (i >= 0) l.splice(i, 1);
    if (!l.length) this.byName.delete(k);
  }

  /**
   * FindEntityByName: "!activator", "!caller", "!self", "!player"; trailing-'*' wildcards; case-insensitive.
   * The player (entity 1 in Source) comes first. With `classFallback` (the event queue), a name matching
   * nothing is retried as a classname.
   */
  private findByName(name: string, self: Ent | null, activator: Activator, caller: AnyEnt | null, classFallback: boolean): AnyEnt[] {
    if (!name) return [];
    if (name.charCodeAt(0) === 33 /* ! */) {
      switch (name.toLowerCase()) {
        case '!activator':
          return activator && !(activator instanceof Ent && activator.killed) ? [activator] : [];
        case '!caller':
          return caller && !(caller instanceof Ent && caller.killed) ? [caller] : [];
        case '!self':
          return self && !self.killed ? [self] : [];
        case '!player':
        case '!pvsplayer':
        case '!picker':
          return this.playerPresent ? [this.player] : [];
      }
      return [];
    }
    const out: AnyEnt[] = [];
    const pl = this.playerPresent;
    if (name.includes('*')) {
      if (pl && this.player.targetname && nameMatches(name, this.player.targetname)) out.push(this.player);
      for (const e of this.ents) if (!e.killed && e.targetname && nameMatches(name, e.targetname)) out.push(e);
    } else {
      if (pl && this.player.targetname && nameMatches(name, this.player.targetname)) out.push(this.player);
      const l = this.byName.get(name.toLowerCase());
      if (l) for (const e of l) if (!e.killed) out.push(e);
    }
    if (!out.length && classFallback) {
      if (pl && nameMatches(name, this.player.classname)) out.push(this.player);
      for (const e of this.ents) if (!e.killed && nameMatches(name, e.classname)) out.push(e);
    }
    return out;
  }

  // ---------------------------------------------------------------- touches

  private updateTouches(): void {
    const ps = this.host.player;
    const hull = playerHull(ps);
    const bmins = this.boxMins;
    const bmaxs = this.boxMaxs;
    bmins.x = ps.origin.x + hull.mins.x;
    bmins.y = ps.origin.y + hull.mins.y;
    bmins.z = ps.origin.z + hull.mins.z;
    bmaxs.x = ps.origin.x + hull.maxs.x;
    bmaxs.y = ps.origin.y + hull.maxs.y;
    bmaxs.z = ps.origin.z + hull.maxs.z;
    const stamp = ++this.stamp;
    const p = this.player;

    // engine-level overlaps at the post-move position (fixed for the whole pass, like the engine's enumerator)
    const list = this.overlapList;
    list.length = 0;
    const trigs = this.triggers;
    for (let i = 0; i < trigs.length; i++) {
      const t = trigs[i];
      if (!t.enabled || t.killed) continue;
      if (t.overlaps(bmins, bmaxs)) list.push(t);
    }

    // StartTouch (new contacts) + Touch
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.killed) continue;
      t.touchStamp = stamp;
      if (!t.engineTouching) {
        t.engineTouching = true;
        this.touching.push(t);
        t.startTouch(p);
        if (t.killed) continue;
      }
      t.touch(p);
    }

    // EndTouch for lost contacts (left, disabled or teleported away)
    if (this.touching.length) {
      let w = 0;
      const touching = this.touching;
      const ended = this.endedScratch;
      ended.length = 0;
      for (let i = 0; i < touching.length; i++) {
        const t = touching[i];
        if (t.killed) continue;
        if (t.touchStamp === stamp && t.engineTouching) touching[w++] = t;
        else ended.push(t);
      }
      touching.length = w;
      for (let i = 0; i < ended.length; i++) {
        const t = ended[i];
        t.engineTouching = false;
        t.endTouch(p);
      }
      ended.length = 0;
    }

    // touch-activated buttons (contact = hull expanded by one unit)
    if (this.buttons.length) {
      bmins.x -= 1;
      bmins.y -= 1;
      bmins.z -= 1;
      bmaxs.x += 1;
      bmaxs.y += 1;
      bmaxs.z += 1;
      for (const b of this.buttons) {
        if (b.killed || !b.touchActivates) continue;
        const brushes = this.host.map.models[b.model]?.brushes ?? [];
        let hit = false;
        for (const br of brushes) {
          if (boxIntersectsBrush(bmins, bmaxs, br)) {
            hit = true;
            break;
          }
        }
        if (hit && !b.touching) b.press(p);
        b.touching = hit;
      }
    }
  }

  // ---------------------------------------------------------------- I/O

  private serviceQueue(): void {
    const now = this.now;
    let n = 0;
    for (;;) {
      const ev = this.queue.peek();
      if (!ev || ev.time > now + TIME_EPS) break;
      if (++n > MAX_EVENTS_PER_TICK) {
        this.devLog('ioloop', `more than ${MAX_EVENTS_PER_TICK} I/O events in one tick (entity loop?); deferring the rest`);
        break;
      }
      this.queue.pop();
      this.dispatch(ev);
    }
  }

  private dispatch(ev: QueuedEvent): void {
    if (typeof ev.target !== 'string') {
      if (!ev.target.killed) this.acceptInput(ev.target, ev.input, ev.param, ev.activator, ev.caller);
      return;
    }
    const targets = this.findByName(ev.target, ev.caller, ev.activator, ev.caller, true);
    if (!targets.length) {
      if (ev.target.charCodeAt(0) !== 33) {
        const k = ev.target.toLowerCase();
        this.missingTargets.set(k, (this.missingTargets.get(k) ?? 0) + 1);
        if (this.developer.int >= 2) this.devLog(`missing:${k}`, `no entity named "${ev.target}" (input ${ev.input})`);
      }
      return;
    }
    for (const t of targets) this.acceptInput(t, ev.input, ev.param, ev.activator, ev.caller);
  }

  private acceptInput(target: AnyEnt, input: string, param: string, activator: Activator, caller: Ent | null): void {
    const name = input.toLowerCase();
    if (target instanceof PlayerEnt) {
      this.playerInput(name, param, input);
      return;
    }
    if (target.killed) return;
    if (target.input(name, param, activator, caller)) return;
    switch (name) {
      case 'addoutput': {
        const p = parseAddOutput(param);
        if (!p) this.devLog(`badaddoutput:${param}`, `AddOutput with a bad string "${param}" on ${target.classname}`);
        else if (p.kind === 'output') target.addConnection(p.output);
        else target.keyValue(p.key.toLowerCase(), p.value);
        return;
      }
      case 'kill':
        this.kill(target);
        return;
      case 'killhierarchy':
        this.killHierarchy(target, 0);
        return;
      case 'fireuser1':
      case 'fireuser2':
      case 'fireuser3':
      case 'fireuser4':
        target.fire(`onuser${name.charAt(8)}`, activator);
        return;
    }
    if (SILENT_INPUTS.has(name)) return;
    this.reportUnknown(target.classname, input, target.modeled);
  }

  private killHierarchy(e: Ent, depth: number): void {
    const name = e.targetname;
    this.kill(e);
    if (!name || depth > 16) return;
    for (const c of this.ents) {
      if (!c.killed && c.kv.parentname && nameMatches(c.kv.parentname, name)) this.killHierarchy(c, depth + 1);
    }
  }

  private reportUnknown(classname: string, input: string, modeled: boolean): void {
    const key = `${classname.toLowerCase()}.${input.toLowerCase()}`;
    this.unknownInputs.set(key, (this.unknownInputs.get(key) ?? 0) + 1);
    this.devLog(`unknown:${key}`, modeled ? `${classname}: unhandled input "${input}"` : `${classname}: class not simulated (input "${input}")`);
  }

  private playerInput(name: string, param: string, rawInput: string): void {
    switch (name) {
      case 'addoutput': {
        const p = parseAddOutput(param);
        if (p && p.kind === 'keyvalue') this.playerKeyValue(p.key.toLowerCase(), p.value);
        return;
      }
      case 'sethealth': {
        const h = parseFloat(param);
        if (Number.isFinite(h)) {
          this.player.health = h;
          if (h <= 0) this.killPlayer('sethealth');
        }
        return;
      }
      case 'kill':
      case 'killhierarchy':
        // the local player can't be removed: treat it as a death (the timer respawns the player)
        this.killPlayer('kill input');
        return;
      case 'setdamagefilter':
        this.player.damageFilter = param.trim();
        return;
      case 'setfogcontroller': {
        const f = this.findFirst(param.trim(), null, null, null);
        if (f instanceof Ent && f.classname.toLowerCase() === 'env_fog_controller' && this.onFogController) {
          const c = parseColor(f.kv.fogcolor);
          try {
            this.onFogController({
              name: f.targetname,
              enabled: kvBool(f.kv.fogenable),
              color: [c[0] / 255, c[1] / 255, c[2] / 255],
              start: kvNum(f.kv.fogstart, 0),
              end: kvNum(f.kv.fogend, 0),
              maxDensity: kvNum(f.kv.fogmaxdensity, 1),
            });
          } catch (e) {
            console.error(e);
          }
        }
        return;
      }
    }
    if (SILENT_INPUTS.has(name)) return;
    this.reportUnknown('player', rawInput, true);
  }

  private playerKeyValue(key: string, value: string): void {
    const ps = this.host.player;
    switch (key) {
      case 'targetname':
        this.player.targetname = value;
        return;
      case 'classname':
        this.player.classname = value;
        return;
      case 'gravity': {
        const g = parseFloat(value);
        ps.gravityScale = Number.isFinite(g) ? g : 0; // 0 = normal gravity (movement treats it as 1)
        return;
      }
      case 'basevelocity': {
        const v = v3parse(value);
        ps.baseVelocity.x = v.x;
        ps.baseVelocity.y = v.y;
        ps.baseVelocity.z = v.z;
        return;
      }
      case 'velocity': {
        const v = v3parse(value);
        ps.velocity.x = v.x;
        ps.velocity.y = v.y;
        ps.velocity.z = v.z;
        return;
      }
      case 'origin':
        this.teleportFromMap(v3parse(value), null, null, {
          classname: 'player',
          triggerName: '',
          destination: '',
          destinationIndex: -1,
          origin: v3parse(value),
          seamless: true,
        });
        return;
      case 'health': {
        const h = parseFloat(value);
        if (Number.isFinite(h)) {
          this.player.health = h;
          if (h <= 0) this.killPlayer('health');
        }
        return;
      }
    }
    if (PLAYER_COSMETIC_KEYS.has(key)) return;
    const k = `player.kv.${key}`;
    this.unknownInputs.set(k, (this.unknownInputs.get(k) ?? 0) + 1);
    this.devLog(`playerkv:${key}`, `player: AddOutput keyvalue "${key}" not simulated`);
  }
}

/** Distance along a ray (unit `dir`) to the nearest of `brushes` (real sides only), or -1. */
function rayBrushesDistance(o: Vec3, dir: Vec3, maxDist: number, brushes: Brush[]): number {
  let best = -1;
  for (const b of brushes) {
    let enter = 0;
    let exit = maxDist;
    let ok = true;
    for (const s of b.sides) {
      if (s.bevel) continue;
      const n = s.plane.normal;
      const denom = n.x * dir.x + n.y * dir.y + n.z * dir.z;
      const dist = n.x * o.x + n.y * o.y + n.z * o.z - s.plane.dist;
      if (denom === 0) {
        if (dist > 0) {
          ok = false;
          break;
        }
        continue;
      }
      const t = -dist / denom;
      if (denom < 0) {
        if (t > enter) enter = t;
      } else if (t < exit) exit = t;
      if (enter > exit) {
        ok = false;
        break;
      }
    }
    if (ok && (best < 0 || enter < best)) best = enter;
  }
  return best;
}
