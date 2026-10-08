import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../src/maps/catalog';
import { compareNames, DEFAULT_FILTER, filterMaps, type MapFilterOptions, matchesQuery, matchesType, tierCounts } from '../src/ui/mapfilter';
import { scrollToReveal, visibleRange } from '../src/ui/virtual';

const E = (name: string, tier: number | null, type: CatalogEntry['type'], hasZones = false, featured = false): CatalogEntry => ({ name, driveId: name, tier, type, hasZones, featured });

const maps: CatalogEntry[] = [
  E('surf_utopia_njv', 1, 'staged', true, true),
  E('surf_kitsune', 1, 'staged', true, true),
  E('surf_mesa_fixed', 1, 'linear', true, true),
  E('surf_10x', 3, 'linear'),
  E('surf_2pac', 2, 'linear', true),
  E('surf_abyss', 6, 'staged-linear', true),
  E('surf_unknown', null, null),
  E('surf_summer_ksf', 2, 'staged', true, true),
];

const F = (o: Partial<MapFilterOptions>): MapFilterOptions => ({ ...DEFAULT_FILTER, tiers: new Set(), cached: new Set(), ...o });
const names = (l: CatalogEntry[]) => l.map((e) => e.name);

describe('map filtering', () => {
  it('query matches all terms, case-insensitive, "_" ~ " "', () => {
    expect(matchesQuery('surf_utopia_njv', 'UTOPIA')).toBe(true);
    expect(matchesQuery('surf_utopia_njv', 'utopia njv')).toBe(true);
    expect(matchesQuery('surf_utopia_njv', 'utopia_njv')).toBe(true);
    expect(matchesQuery('surf_utopia_njv', 'utopia kitsune')).toBe(false);
    expect(matchesQuery('surf_x', '   ')).toBe(true);
  });

  it('staged-linear maps match both type filters', () => {
    expect(matchesType('staged-linear', 'linear')).toBe(true);
    expect(matchesType('staged-linear', 'staged')).toBe(true);
    expect(matchesType('linear', 'staged')).toBe(false);
    expect(matchesType(null, 'all')).toBe(true);
    expect(matchesType(null, 'linear')).toBe(false);
  });

  it('sorts by name ignoring the surf_ prefix with natural numbers', () => {
    expect(names(filterMaps(maps, F({ sort: 'name' })))).toEqual([
      'surf_2pac',
      'surf_10x',
      'surf_abyss',
      'surf_kitsune',
      'surf_mesa_fixed',
      'surf_summer_ksf',
      'surf_unknown',
      'surf_utopia_njv',
    ]);
    expect(compareNames('surf_a', 'b')).toBeLessThan(0);
  });

  it('sorts by CS:GO-era popularity by default: scored maps first, the rest by tier then name', () => {
    const pop = maps.map((m) => ({ ...m }));
    const set = (n: string, p: number) => (pop.find((m) => m.name === n)!.popularity = p);
    set('surf_kitsune', 97);
    set('surf_utopia_njv', 99);
    set('surf_abyss', 40);
    expect(DEFAULT_FILTER.sort).toBe('popular');
    expect(names(filterMaps(pop, F({})))).toEqual([
      'surf_utopia_njv',
      'surf_kitsune',
      'surf_abyss',
      'surf_mesa_fixed',
      'surf_2pac',
      'surf_summer_ksf',
      'surf_10x',
      'surf_unknown',
    ]);
    // a search still puts exact / prefix matches first
    expect(names(filterMaps(pop, F({ query: 'mesa' })))).toEqual(['surf_mesa_fixed']);
  });

  it('sorts by tier (unknown last) and tier descending', () => {
    expect(names(filterMaps(maps, F({ sort: 'tier' })))).toEqual([
      'surf_kitsune',
      'surf_mesa_fixed',
      'surf_utopia_njv',
      'surf_2pac',
      'surf_summer_ksf',
      'surf_10x',
      'surf_abyss',
      'surf_unknown',
    ]);
    expect(names(filterMaps(maps, F({ sort: 'tier-desc' })))[0]).toBe('surf_abyss');
    expect(names(filterMaps(maps, F({ sort: 'tier-desc' }))).at(-1)).toBe('surf_unknown');
  });

  it('filters by tiers, type, zones and cache', () => {
    // (name order: without popularity scores the default sort would order by tier)
    const F = (o: Partial<MapFilterOptions>): MapFilterOptions => ({ ...DEFAULT_FILTER, sort: 'name', tiers: new Set(), cached: new Set(), ...o });
    expect(names(filterMaps(maps, F({ tiers: new Set([2]) })))).toEqual(['surf_2pac', 'surf_summer_ksf']);
    expect(names(filterMaps(maps, F({ tiers: new Set([1, 6]), type: 'linear' })))).toEqual(['surf_abyss', 'surf_mesa_fixed']);
    expect(filterMaps(maps, F({ zonesOnly: true })).every((e) => e.hasZones)).toBe(true);
    expect(names(filterMaps(maps, F({ cachedOnly: true, cached: new Set(['surf_kitsune']) })))).toEqual(['surf_kitsune']);
    expect(names(filterMaps(maps, F({ completedOnly: true, completed: new Set(['surf_10x', 'surf_abyss']) })))).toEqual(['surf_10x', 'surf_abyss']);
    expect(filterMaps(maps, F({ completedOnly: true })).length).toBe(0);
  });

  it('puts exact and prefix matches first when searching', () => {
    const list = [E('surf_ace', 1, 'linear'), E('surf_grace', 2, 'linear'), E('surf_aces_high', 3, 'linear'), E('surf_space', 4, 'linear')];
    expect(names(filterMaps(list, F({ query: 'ace' })))).toEqual(['surf_ace', 'surf_aces_high', 'surf_grace', 'surf_space']);
  });

  it('counts tiers', () => {
    const c = tierCounts(maps);
    expect(c[1]).toBe(3);
    expect(c[2]).toBe(2);
    expect(c[0]).toBe(1);
    expect(c.reduce((a, b) => a + b, 0)).toBe(maps.length);
  });

  it('works on the real catalog', () => {
    const file = JSON.parse(readFileSync(join(__dirname, '../public/maps/catalog.json'), 'utf8')) as { maps: CatalogEntry[] };
    const all = file.maps;
    expect(all.length).toBeGreaterThan(900);
    expect(filterMaps(all, F({})).length).toBe(all.length);
    const t1 = filterMaps(all, F({ tiers: new Set([1]) }));
    expect(t1.length).toBe(tierCounts(all)[1]);
    expect(names(filterMaps(all, F({ query: 'utopia' })))).toContain('surf_utopia_njv');
    expect(all.filter((e) => e.featured).map((e) => e.name)).toEqual(expect.arrayContaining(['surf_utopia_njv', 'surf_kitsune', 'surf_mesa_fixed', 'surf_beginner']));
  });
});

describe('virtual list math', () => {
  it('computes the visible window with overscan', () => {
    expect(visibleRange(0, 400, 40, 1000, 0)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(0, 400, 40, 1000, 4)).toEqual({ start: 0, end: 14 });
    expect(visibleRange(1000, 400, 40, 1000, 4)).toEqual({ start: 21, end: 39 });
    expect(visibleRange(39_000, 400, 40, 1000, 4)).toEqual({ start: 971, end: 989 });
    expect(visibleRange(39_600, 400, 40, 1000, 4)).toEqual({ start: 986, end: 1000 });
    expect(visibleRange(0, 400, 40, 3, 4)).toEqual({ start: 0, end: 3 });
    expect(visibleRange(0, 400, 40, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(-50, 400, 40, 100, 0)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(10, 400, 0, 100)).toEqual({ start: 0, end: 0 });
  });

  it('scrolls minimally to reveal a row', () => {
    expect(scrollToReveal(5, 0, 400, 40)).toBeNull();
    expect(scrollToReveal(12, 0, 400, 40)).toBe(13 * 40 - 400);
    expect(scrollToReveal(2, 200, 400, 40)).toBe(80);
  });
});
