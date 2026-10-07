// Local run records ("surf.records.v1" in localStorage): the 10 best runs per map + course (main course =
// group 0, bonus N = group N) + tickrate, sorted by time. The first entry is the personal best (and, offline,
// the local "world record"). A completion counter per course gives SurfTimer-like "Rank 3/27" messages.
// Like CS:GO, where every leaderboard belongs to a single-tickrate server, runs of different tickrates
// (64 / 85.3 / 100 / 102.4 / 128) never compete: the course key includes the tick ("surf_x|0|100"). Older
// files keyed "map|group" are split by each run's tickrate when loaded. Best stage times (stage practice
// with !s and stages of ranked runs) are kept per map + course + tickrate + stage as well.
//
// Storage falls back to memory when localStorage is unavailable (node tests, privacy mode, quota errors).
import { console_ } from '../core/cvars';
import { RunRecord } from './contracts';

export const RECORDS_STORAGE_KEY = 'surf.records.v1';
/** Runs kept per map + course. */
export const MAX_RECORDS_PER_COURSE = 10;

export interface RecordsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CourseEntry {
  /** Best runs, fastest first (at most MAX_RECORDS_PER_COURSE). */
  runs: RunRecord[];
  /** Every ranked completion ever saved for this course (>= runs.length). */
  completions: number;
}

/** Best time of one stage (stage practice or a stage of a ranked run). */
export interface StageBest {
  time: number;
  date: number;
}

interface RecordsFile {
  version: 1;
  /** Key: courseKey(map, group, tickrate). */
  courses: Record<string, CourseEntry>;
  /** Key: stageKey(map, group, stage, tickrate). */
  stages?: Record<string, StageBest>;
}

class MemoryStorage implements RecordsStorage {
  private m = new Map<string, string>();
  getItem(key: string): string | null {
    return this.m.has(key) ? (this.m.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
}

let storageOverride: RecordsStorage | null = null;
const memoryStorage = new MemoryStorage();
let cache: RecordsFile | null = null;

/**
 * Replaces the storage backend (tests). `null` restores the default (localStorage when available, else memory).
 * Drops the parsed cache so the next read comes from the new backend.
 */
export function setRecordsStorage(storage: RecordsStorage | null): void {
  storageOverride = storage;
  cache = null;
}

function backend(): RecordsStorage {
  if (storageOverride) return storageOverride;
  try {
    const ls = (globalThis as { localStorage?: RecordsStorage }).localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch {
    /* access can throw (sandboxed iframes) */
  }
  return memoryStorage;
}

/** Default tickrate of runs that don't say (older records) and when no tickrate cvar exists. */
export const DEFAULT_TICKRATE = 100;

/** Canonical tickrate label: "64", "85.3", "100", "102.4", "128" (one decimal). */
export function tickLabel(tickrate: number): string {
  const t = Number.isFinite(tickrate) && tickrate > 0 ? tickrate : DEFAULT_TICKRATE;
  return String(Math.round(t * 10) / 10);
}

/** The tickrate the game currently simulates at (the `tickrate` cvar), for records of "this server". */
export function currentTickrate(): number {
  try {
    const c = console_.getCvar('tickrate');
    if (c && Number.isFinite(c.num) && c.num > 0) return c.num;
  } catch {
    /* no console */
  }
  return DEFAULT_TICKRATE;
}

/** Normalized course key: "surf_utopia_njv|0|100" (map, course, tickrate). */
export function courseKey(map: string, group: number, tickrate: number = currentTickrate()): string {
  return `${map.toLowerCase()}|${group | 0}|${tickLabel(tickrate)}`;
}

/** Stage best key: "surf_kitsune|0|100|s3". */
export function stageKey(map: string, group: number, stage: number, tickrate: number = currentTickrate()): string {
  return `${courseKey(map, group, tickrate)}|s${stage | 0}`;
}

/** Splits a course key into its parts (legacy "map|group" keys have no tick). */
function parseCourseKey(key: string): { map: string; group: number; tick: string | null } | null {
  const p = key.split('|');
  if (p.length < 2 || p.length > 3) return null;
  const group = Number(p[1]);
  if (!p[0] || !Number.isInteger(group) || group < 0) return null;
  return { map: p[0], group, tick: p.length === 3 ? p[2] : null };
}

function num(x: unknown, fallback = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

function numArray(x: unknown): number[] {
  if (!Array.isArray(x)) return [];
  return x.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : -1));
}

/** Validates/normalizes an untrusted record (imports, old storage). Returns null when unusable. */
export function sanitizeRecord(x: unknown): RunRecord | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Partial<RunRecord>;
  if (typeof r.map !== 'string' || !r.map) return null;
  const time = num(r.time, NaN);
  if (!(time > 0)) return null;
  const group = num(r.group, -1);
  if (!(group >= 0) || !Number.isInteger(group)) return null;
  return {
    map: r.map.toLowerCase(),
    group,
    time,
    stageSplits: numArray(r.stageSplits),
    checkpointSplits: numArray(r.checkpointSplits),
    jumps: Math.max(0, Math.round(num(r.jumps))),
    strafes: Math.max(0, Math.round(num(r.strafes))),
    sync: Math.min(100, Math.max(0, num(r.sync))),
    tickrate: num(r.tickrate, 0),
    date: num(r.date, 0),
    avgSpeed: Math.max(0, num(r.avgSpeed)),
    maxSpeed: Math.max(0, num(r.maxSpeed)),
  };
}

/** Adds an entry's runs to `file`, splitting them by tickrate (legacy entries mix tickrates). */
function mergeEntry(file: RecordsFile, key: string, entry: { runs?: unknown; completions?: unknown }): void {
  const parsedKey = parseCourseKey(key);
  if (!parsedKey || !Array.isArray(entry.runs)) return;
  const runs = entry.runs.map(sanitizeRecord).filter((r): r is RunRecord => !!r);
  const byKey = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const tick = parsedKey.tick ?? tickLabel(r.tickrate);
    const k = `${parsedKey.map}|${parsedKey.group}|${tick}`;
    let list = byKey.get(k);
    if (!list) byKey.set(k, (list = []));
    list.push(r);
  }
  // completions beyond the stored runs go to the tick with the most runs (the course's main tick)
  let extra = Math.max(0, Math.round(num(entry.completions)) - runs.length);
  const keys = [...byKey.keys()].sort((a, b) => (byKey.get(b) as RunRecord[]).length - (byKey.get(a) as RunRecord[]).length);
  for (const k of keys) {
    const list = byKey.get(k) as RunRecord[];
    const e = file.courses[k] ?? (file.courses[k] = { runs: [], completions: 0 });
    e.runs.push(...list);
    sortRuns(e.runs);
    if (e.runs.length > MAX_RECORDS_PER_COURSE) e.runs.length = MAX_RECORDS_PER_COURSE;
    e.completions += list.length + extra;
    extra = 0;
    e.completions = Math.max(e.completions, e.runs.length);
  }
}

function load(): RecordsFile {
  if (cache) return cache;
  let file: RecordsFile = { version: 1, courses: {}, stages: {} };
  try {
    const raw = backend().getItem(RECORDS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RecordsFile>;
      if (parsed && typeof parsed === 'object' && parsed.courses && typeof parsed.courses === 'object') {
        for (const [key, entry] of Object.entries(parsed.courses)) {
          if (!entry) continue;
          mergeEntry(file, key, entry);
        }
      }
      if (parsed && typeof parsed === 'object' && parsed.stages && typeof parsed.stages === 'object') {
        for (const [key, b] of Object.entries(parsed.stages)) {
          const t = num(b?.time, NaN);
          if (t > 0 && key.split('|').length === 4) (file.stages as Record<string, StageBest>)[key] = { time: t, date: num(b?.date, 0) };
        }
      }
    }
  } catch {
    file = { version: 1, courses: {}, stages: {} };
  }
  cache = file;
  return file;
}

function save(): void {
  if (!cache) return;
  try {
    backend().setItem(RECORDS_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* quota / unavailable: keep the in-memory copy */
  }
}

/** Fastest first; equal times keep the earlier run first. */
function sortRuns(runs: RunRecord[]): void {
  runs.sort((a, b) => a.time - b.time || a.date - b.date);
}

function cloneRecord(r: RunRecord): RunRecord {
  return { ...r, stageSplits: r.stageSplits.slice(), checkpointSplits: r.checkpointSplits.slice() };
}

/** The stored best runs of a course at a tickrate (default: the current one), fastest first (copies). */
export function getRecords(map: string, group: number, tickrate?: number): RunRecord[] {
  const e = load().courses[courseKey(map, group, tickrate)];
  return e ? e.runs.map(cloneRecord) : [];
}

/** Personal best (the fastest stored run at the tickrate, default: the current one) or null. */
export function getPersonalBest(map: string, group: number, tickrate?: number): RunRecord | null {
  const e = load().courses[courseKey(map, group, tickrate)];
  return e && e.runs.length ? cloneRecord(e.runs[0]) : null;
}

/** Number of ranked completions saved for the course at the tickrate (including runs that fell out of the top 10). */
export function getCompletions(map: string, group: number, tickrate?: number): number {
  return load().courses[courseKey(map, group, tickrate)]?.completions ?? 0;
}

/** Tickrates (labels) that have records for this course. */
export function recordTickrates(map: string, group: number): string[] {
  const prefix = `${map.toLowerCase()}|${group | 0}|`;
  return Object.keys(load().courses)
    .filter((k) => k.startsWith(prefix) && load().courses[k].runs.length)
    .map((k) => k.slice(prefix.length));
}

/** Best time of a stage (stage practice or a stage of a ranked run) at the tickrate, or null. */
export function getStageBest(map: string, group: number, stage: number, tickrate?: number): StageBest | null {
  const b = load().stages?.[stageKey(map, group, stage, tickrate)];
  return b ? { ...b } : null;
}

/**
 * Saves a stage time when it beats the stored best (or is the first). Returns the previous best (null if none)
 * and whether the time was saved.
 */
export function addStageTime(map: string, group: number, stage: number, time: number, tickrate?: number): { previous: StageBest | null; improved: boolean } {
  if (!(time > 0) || !Number.isFinite(time) || !(stage > 0)) return { previous: null, improved: false };
  const file = load();
  const stages = file.stages ?? (file.stages = {});
  const key = stageKey(map, group, stage, tickrate);
  const previous = stages[key] ? { ...stages[key] } : null;
  const improved = !previous || time < previous.time;
  if (improved) {
    stages[key] = { time, date: Date.now() };
    save();
  }
  return { previous, improved };
}

export interface AddRecordResult {
  /** 1-based position among all completions of the course (exact while the run is in the stored top 10), 0 if unknown. */
  rank: number;
  /** Completions of the course including this one. */
  total: number;
  /** Strictly faster than the previous personal best (or the first completion). */
  isPb: boolean;
  /** The personal best before this run, or null. */
  previousPb: RunRecord | null;
  /** The run made it into the stored top list. */
  stored: boolean;
}

/** Saves a finished ranked run. */
export function addRecord(record: RunRecord): AddRecordResult {
  const rec = sanitizeRecord(record);
  if (!rec) return { rank: 0, total: 0, isPb: false, previousPb: null, stored: false };
  const file = load();
  const key = courseKey(rec.map, rec.group, rec.tickrate || DEFAULT_TICKRATE);
  let entry = file.courses[key];
  if (!entry) entry = file.courses[key] = { runs: [], completions: 0 };
  const previousPb = entry.runs.length ? cloneRecord(entry.runs[0]) : null;
  const isPb = !previousPb || rec.time < previousPb.time;
  // position after runs with time <= rec.time (ties: the older run stays ahead)
  let pos = 0;
  while (pos < entry.runs.length && entry.runs[pos].time <= rec.time) pos++;
  entry.completions++;
  let stored = false;
  if (pos < MAX_RECORDS_PER_COURSE) {
    entry.runs.splice(pos, 0, rec);
    if (entry.runs.length > MAX_RECORDS_PER_COURSE) entry.runs.length = MAX_RECORDS_PER_COURSE;
    stored = true;
  }
  save();
  return { rank: stored ? pos + 1 : 0, total: entry.completions, isPb, previousPb, stored };
}

/** Clears all records, one map's, one course's (every tickrate), or one course's at one tickrate. */
export function clearRecords(map?: string, group?: number, tickrate?: number): void {
  const file = load();
  if (map === undefined) {
    file.courses = {};
    file.stages = {};
  } else {
    const prefix =
      group === undefined ? `${map.toLowerCase()}|` : tickrate === undefined ? `${map.toLowerCase()}|${group | 0}|` : `${courseKey(map, group, tickrate)}|`;
    const exact = group !== undefined && tickrate !== undefined ? courseKey(map, group, tickrate) : null;
    for (const k of Object.keys(file.courses)) if (k === exact || k.startsWith(prefix)) delete file.courses[k];
    for (const k of Object.keys(file.stages ?? {})) if (k.startsWith(prefix)) delete (file.stages as Record<string, StageBest>)[k];
  }
  save();
}

/** JSON export of all records (or one map's): `{ "version": 1, "courses": { ... }, "stages": { ... } }`. */
export function exportRecords(map?: string): string {
  const file = load();
  const out: RecordsFile = { version: 1, courses: {}, stages: {} };
  const prefix = map ? `${map.toLowerCase()}|` : '';
  for (const [k, e] of Object.entries(file.courses)) {
    if (prefix && !k.startsWith(prefix)) continue;
    out.courses[k] = { runs: e.runs.map(cloneRecord), completions: e.completions };
  }
  for (const [k, b] of Object.entries(file.stages ?? {})) {
    if (prefix && !k.startsWith(prefix)) continue;
    (out.stages as Record<string, StageBest>)[k] = { ...b };
  }
  return JSON.stringify(out);
}

/**
 * Merges records from exportRecords() output (or a plain RunRecord array). Duplicate runs (same map, course,
 * time and date) are skipped. Returns the number of runs added to the stored lists.
 */
export function importRecords(json: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return 0;
  }
  const incoming: RunRecord[] = [];
  const completionsByKey = new Map<string, number>();
  if (Array.isArray(parsed)) {
    for (const r of parsed) {
      const s = sanitizeRecord(r);
      if (s) incoming.push(s);
    }
  } else if (parsed && typeof parsed === 'object' && (parsed as RecordsFile).courses) {
    for (const e of Object.values((parsed as RecordsFile).courses)) {
      if (!e || !Array.isArray(e.runs)) continue;
      let k = '';
      for (const r of e.runs) {
        const s = sanitizeRecord(r);
        if (!s) continue;
        incoming.push(s);
        k = courseKey(s.map, s.group, s.tickrate || DEFAULT_TICKRATE);
      }
      if (k) completionsByKey.set(k, Math.max(completionsByKey.get(k) ?? 0, Math.round(num(e.completions))));
    }
    const st = (parsed as RecordsFile).stages;
    if (st && typeof st === 'object') {
      const file = load();
      const stages = file.stages ?? (file.stages = {});
      for (const [k, b] of Object.entries(st)) {
        const t = num(b?.time, NaN);
        if (!(t > 0) || k.split('|').length !== 4) continue;
        if (!stages[k] || t < stages[k].time) stages[k] = { time: t, date: num(b?.date, 0) };
      }
      save();
    }
  }
  if (!incoming.length) return 0;
  const file = load();
  let added = 0;
  for (const rec of incoming) {
    const key = courseKey(rec.map, rec.group, rec.tickrate || DEFAULT_TICKRATE);
    let entry = file.courses[key];
    if (!entry) entry = file.courses[key] = { runs: [], completions: 0 };
    if (entry.runs.some((r) => r.time === rec.time && r.date === rec.date)) continue;
    entry.runs.push(rec);
    sortRuns(entry.runs);
    const kept = entry.runs.indexOf(rec) < MAX_RECORDS_PER_COURSE;
    if (entry.runs.length > MAX_RECORDS_PER_COURSE) entry.runs.length = MAX_RECORDS_PER_COURSE;
    entry.completions++;
    if (kept) added++;
  }
  for (const [k, c] of completionsByKey) {
    const e = file.courses[k];
    if (e) e.completions = Math.max(e.completions, c, e.runs.length);
  }
  save();
  return added;
}
