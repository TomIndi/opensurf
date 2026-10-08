// Map browser filtering/sorting (pure, unit tested).
import type { CatalogEntry } from '../maps/catalog';

export type MapSort = 'popular' | 'name' | 'tier' | 'tier-desc';
export type MapTypeFilter = 'all' | 'linear' | 'staged';

export interface MapFilterOptions {
  query: string;
  /** Selected tiers (empty = all). */
  tiers: ReadonlySet<number>;
  type: MapTypeFilter;
  sort: MapSort;
  cachedOnly: boolean;
  zonesOnly: boolean;
  /** Lower-case names of maps in the local cache. */
  cached: ReadonlySet<string>;
  /** Only maps with a local personal best. */
  completedOnly?: boolean;
  /** Lower-case names of maps with a local personal best. */
  completed?: ReadonlySet<string>;
}

export const DEFAULT_FILTER: MapFilterOptions = {
  query: '',
  tiers: new Set(),
  type: 'all',
  sort: 'popular',
  cachedOnly: false,
  zonesOnly: false,
  cached: new Set(),
};

/** Sort key for names: "surf_" prefix ignored, natural number ordering ("surf_2" < "surf_10"). */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/^surf_/, '');
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) : null;

export function compareNames(a: string, b: string): number {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (collator) return collator.compare(ka, kb) || (a < b ? -1 : a > b ? 1 : 0);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** True when every whitespace-separated query term occurs in the name (case-insensitive; '_' ~ ' '). */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const n = name.toLowerCase();
  const nSpaced = n.replace(/_/g, ' ');
  for (const term of q.split(/\s+/)) {
    if (!term) continue;
    if (!n.includes(term) && !nSpaced.includes(term)) return false;
  }
  return true;
}

/** Map type group: 'staged-linear' maps count as both staged and linear. */
export function matchesType(type: CatalogEntry['type'], filter: MapTypeFilter): boolean {
  if (filter === 'all') return true;
  if (type === 'staged-linear') return true;
  return type === filter;
}

export function filterMaps(entries: readonly CatalogEntry[], o: MapFilterOptions): CatalogEntry[] {
  const out = entries.filter(
    (e) =>
      matchesQuery(e.name, o.query) &&
      (o.tiers.size === 0 || (e.tier !== null && o.tiers.has(e.tier))) &&
      matchesType(e.type, o.type) &&
      (!o.cachedOnly || o.cached.has(e.name.toLowerCase())) &&
      (!o.zonesOnly || e.hasZones) &&
      (!o.completedOnly || !!o.completed?.has(e.name.toLowerCase())),
  );
  const q = o.query.trim().toLowerCase();
  out.sort((a, b) => {
    // exact / prefix matches first when searching
    if (q) {
      const ra = relevance(a.name, q);
      const rb = relevance(b.name, q);
      if (ra !== rb) return ra - rb;
    }
    if (o.sort === 'popular') {
      const d = comparePopularity(a, b);
      if (d) return d;
    } else if (o.sort !== 'name') {
      const ta = a.tier ?? 99;
      const tb = b.tier ?? 99;
      if (ta !== tb) return o.sort === 'tier' ? ta - tb : (b.tier ?? -1) - (a.tier ?? -1);
    }
    return compareNames(a.name, b.name);
  });
  return out;
}

/** Most popular first (CS:GO era); maps without a score after the scored ones, easier tiers first. */
export function comparePopularity(a: CatalogEntry, b: CatalogEntry): number {
  const pa = a.popularity ?? -1;
  const pb = b.popularity ?? -1;
  if (pa !== pb) return pb - pa;
  return (a.tier ?? 99) - (b.tier ?? 99);
}

function relevance(name: string, q: string): number {
  const n = name.toLowerCase();
  const k = nameKey(name);
  if (n === q || k === q) return 0;
  if (n.startsWith(q) || k.startsWith(q)) return 1;
  return 2;
}

/** Counts per tier (index 1..8, 0 = unknown) for the tier chips. */
export function tierCounts(entries: readonly CatalogEntry[]): number[] {
  const c = new Array(9).fill(0);
  for (const e of entries) c[e.tier && e.tier >= 1 && e.tier <= 8 ? e.tier : 0]++;
  return c;
}
