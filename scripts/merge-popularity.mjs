// Merges public/maps/popularity.json (CS:GO-era map popularity: score per map + the classics set, with the sources
// it was built from) into public/maps/catalog.json: `popularity` (0..100) on scored maps and `featured` = classic.
// Run after `npm run catalog` (which calls it) or on its own: `node scripts/merge-popularity.mjs`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'maps');

/** Applies the popularity file to catalog entries in place; returns { scored, classics } counts. */
export function mergePopularity(maps, pop) {
  const score = new Map((pop.ranking ?? []).map((r) => [String(r.name).toLowerCase(), Number(r.score)]));
  const classics = new Set((pop.classics ?? []).map((n) => String(n).toLowerCase()));
  let scored = 0;
  let featured = 0;
  for (const m of maps) {
    const k = m.name.toLowerCase();
    const s = score.get(k);
    if (Number.isFinite(s)) {
      m.popularity = Math.round(Math.max(0, Math.min(100, s)) * 10) / 10;
      scored++;
    } else delete m.popularity;
    m.featured = classics.has(k);
    if (m.featured) featured++;
  }
  return { scored, classics: featured };
}

function main() {
  const popPath = join(OUT, 'popularity.json');
  if (!existsSync(popPath)) {
    console.log('no popularity.json: catalog left as is');
    return;
  }
  const pop = JSON.parse(readFileSync(popPath, 'utf8'));
  const catPath = join(OUT, 'catalog.json');
  const cat = JSON.parse(readFileSync(catPath, 'utf8'));
  const r = mergePopularity(cat.maps, pop);
  writeFileSync(catPath, JSON.stringify(cat));
  console.log(`popularity: ${r.scored} maps scored, ${r.classics} classics`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
