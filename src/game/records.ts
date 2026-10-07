// Local run records ("surf.records.v1" in localStorage): the 10 best runs per map + course (main course =
// group 0, bonus N = group N), sorted by time. The first entry is the personal best (and, offline, the local
// "world record"). A completion counter per course gives SurfTimer-like "Rank 3/27" messages.
//
// Storage falls back to memory when localStorage is unavailable (node tests, privacy mode, quota errors).
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

interface RecordsFile {
  version: 1;
  /** Key: courseKey(map, group). */
  courses: Record<string, CourseEntry>;
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

/** Normalized course key: "surf_utopia_njv|0". */
export function courseKey(map: string, group: number): string {
  return `${map.toLowerCase()}|${group | 0}`;
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

function load(): RecordsFile {
  if (cache) return cache;
  let file: RecordsFile = { version: 1, courses: {} };
  try {
    const raw = backend().getItem(RECORDS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RecordsFile>;
      if (parsed && typeof parsed === 'object' && parsed.courses && typeof parsed.courses === 'object') {
        for (const [key, entry] of Object.entries(parsed.courses)) {
          if (!entry || !Array.isArray(entry.runs)) continue;
          const runs = entry.runs.map(sanitizeRecord).filter((r): r is RunRecord => !!r);
          sortRuns(runs);
          if (runs.length > MAX_RECORDS_PER_COURSE) runs.length = MAX_RECORDS_PER_COURSE;
          file.courses[key] = { runs, completions: Math.max(runs.length, Math.round(num(entry.completions))) };
        }
      }
    }
  } catch {
    file = { version: 1, courses: {} };
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

/** The stored best runs of a course, fastest first (copies). */
export function getRecords(map: string, group: number): RunRecord[] {
  const e = load().courses[courseKey(map, group)];
  return e ? e.runs.map(cloneRecord) : [];
}

/** Personal best (the fastest stored run) or null. */
export function getPersonalBest(map: string, group: number): RunRecord | null {
  const e = load().courses[courseKey(map, group)];
  return e && e.runs.length ? cloneRecord(e.runs[0]) : null;
}

/** Number of ranked completions saved for the course (including runs that fell out of the top 10). */
export function getCompletions(map: string, group: number): number {
  return load().courses[courseKey(map, group)]?.completions ?? 0;
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
  const key = courseKey(rec.map, rec.group);
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

/** Clears all records, one map's, or one course's. */
export function clearRecords(map?: string, group?: number): void {
  const file = load();
  if (map === undefined) {
    file.courses = {};
  } else if (group === undefined) {
    const prefix = `${map.toLowerCase()}|`;
    for (const k of Object.keys(file.courses)) if (k.startsWith(prefix)) delete file.courses[k];
  } else {
    delete file.courses[courseKey(map, group)];
  }
  save();
}

/** JSON export of all records (or one map's): `{ "version": 1, "courses": { ... } }`. */
export function exportRecords(map?: string): string {
  const file = load();
  const out: RecordsFile = { version: 1, courses: {} };
  const prefix = map ? `${map.toLowerCase()}|` : '';
  for (const [k, e] of Object.entries(file.courses)) {
    if (prefix && !k.startsWith(prefix)) continue;
    out.courses[k] = { runs: e.runs.map(cloneRecord), completions: e.completions };
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
        k = courseKey(s.map, s.group);
      }
      if (k) completionsByKey.set(k, Math.max(completionsByKey.get(k) ?? 0, Math.round(num(e.completions))));
    }
  }
  if (!incoming.length) return 0;
  const file = load();
  let added = 0;
  for (const rec of incoming) {
    const key = courseKey(rec.map, rec.group);
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
