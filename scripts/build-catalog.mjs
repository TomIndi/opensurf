#!/usr/bin/env node
// Builds public/maps/catalog.json (every KSF CS:S surf map in the public archive linked from
// github.com/OuiSURF/Surf_Maps, with Google Drive file ids, KSF tiers and types) and
// public/maps/zones.json (timer zone presets converted from SurfTimer's ck_zones.sql, GPL-3.0).
//
// Usage: node scripts/build-catalog.mjs
// Behind a proxy with Node 22: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<ca.pem> node scripts/build-catalog.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'maps');

const DRIVE_FOLDERS = [
  { id: '17QJ-Wzk9eMHKZqX227HkPCg9_Vmrf9h-', label: 'A-K' },
  { id: '1f3Oe65BngrSxTPKHAt6MEwK0FTsDbUsO', label: 'L-Z' },
  { id: '12vSaC6NOh8lYMrVXrGZhJvhhs8zz8MrT', label: 'other' },
];
const KSF_SHEET_CSV =
  'https://docs.google.com/spreadsheets/d/1oXU6UXGPdgdqRiAjjD_5c1WfI6PY6ML4/export?format=csv&gid=1729788986';
const SURFTIMER_RAW = 'https://raw.githubusercontent.com/surftimer/SurfTimer/master/scripts/mysql-files';

/** Classic maps highlighted in the menu, in display order. */
const FEATURED = [
  'surf_utopia_njv',
  'surf_kitsune',
  'surf_mesa_fixed',
  'surf_beginner',
  'surf_rookie',
  'surf_aircontrol_ksf',
  'surf_ing',
  'surf_lt_omnific',
  'surf_summer_ksf',
  'surf_forbidden_ways_ksf',
  'surf_classics',
  'surf_fruits',
  'surf_calycate_ksf',
  'surf_lux',
  'surf_nyx',
  'surf_pantheon',
  'surf_zen',
  'surf_grassland',
  'surf_borderlands',
  'surf_4head',
  'surf_reprise',
  'surf_sanding_ksf',
  'surf_christmas',
  'surf_ace',
];

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Lists files of a public Drive folder through the embedded folder view. */
async function listDriveFolder(id) {
  const html = await get(`https://drive.google.com/embeddedfolderview?id=${id}`);
  const re = /<a href="https:\/\/drive\.google\.com\/file\/d\/([^/"]+)[^"]*"[^>]*>[\s\S]*?flip-entry-title">([^<]*)</g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ driveId: m[1], file: decodeHtml(m[2]).trim() });
  return out;
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(line.split(',').map((c) => c.trim()));
  }
  return rows;
}

/** Parses the INSERT rows of a mysqldump into arrays of values. */
function parseSqlInserts(sql, table) {
  const rows = [];
  const re = new RegExp(`INSERT INTO \`${table}\`[^V]*VALUES\\s*([\\s\\S]*?);\\s*$`, 'gm');
  let m;
  while ((m = re.exec(sql))) {
    const body = m[1];
    const tupleRe = /\(((?:[^()']|'(?:[^'\\]|\\.)*')*)\)/g;
    let t;
    while ((t = tupleRe.exec(body))) {
      const vals = [];
      const valRe = /'((?:[^'\\]|\\.)*)'|(NULL)|(-?[\d.eE+-]+)/g;
      let v;
      while ((v = valRe.exec(t[1]))) {
        if (v[1] !== undefined) vals.push(v[1].replace(/\\(.)/g, '$1'));
        else if (v[2]) vals.push(null);
        else vals.push(Number(v[3]));
      }
      rows.push(vals);
    }
  }
  return rows;
}

// SurfTimer zone types: Stop 0, Start 1, End 2, Stage 3, Checkpoint 4, Speed(start) 5, TeleToStart 6,
// Validator 7, Checker 8, NoBhop 9, NoCrouch 10, MaxSpeed 11. Stage zone number = zonetypeid + 2.
const ZONE_TYPES = ['stop', 'start', 'end', 'stage', 'checkpoint', 'speedstart', 'teletostart', 'validator', 'checker', 'antijump', 'antiduck', 'maxspeed'];

function round(n) {
  return Math.round(n * 100) / 100;
}

/** Strips version/author suffixes so different builds of the same map can be matched. */
export function baseMapName(name) {
  let s = name.toLowerCase().replace(/\.bsp$/, '');
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/_(ksf|njv|nbv|fix|fixed|final\d*|refix|rc\d*|beta\d*[a-z]?|alpha\d*|b\d+|a\d+|v\d+[a-z0-9]*|go|csgo|css|mom|new|remake|redux|hd|r\d+|x)$/, '')
      .replace(/[-_]+$/, '');
    if (s === before) break;
  }
  return s;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // ---- maps in the Drive archive
  const files = [];
  for (const f of DRIVE_FOLDERS) {
    const list = await listDriveFolder(f.id);
    console.log(`drive folder ${f.label}: ${list.length} files`);
    for (const e of list) files.push({ ...e, folder: f.label });
  }
  const maps = new Map();
  for (const f of files) {
    const m = /^(.+?)\.(rar|zip|7z|bz2|bsp)$/i.exec(f.file);
    if (!m) continue;
    const name = m[1].replace(/\.bsp$/i, '').toLowerCase();
    if (!name.startsWith('surf_')) continue;
    if (!maps.has(name)) maps.set(name, { name, driveId: f.driveId, archive: m[2].toLowerCase() });
  }
  console.log(`maps: ${maps.size}`);

  // ---- KSF tiers / types
  const tiers = new Map();
  try {
    const rows = parseCsv(await get(KSF_SHEET_CSV));
    for (const r of rows.slice(1)) {
      const [name, tier, type] = r;
      if (!name) continue;
      tiers.set(name.toLowerCase(), {
        tier: Number.isFinite(Number(tier)) && tier !== '' ? Number(tier) : null,
        type: type ? type.toLowerCase().replace(/\s+/g, '') : null,
      });
    }
    console.log(`ksf sheet rows: ${tiers.size}`);
  } catch (e) {
    console.warn(`ksf sheet unavailable: ${e.message}`);
  }

  // ---- SurfTimer zones + tiers
  const zoneSql = await get(`${SURFTIMER_RAW}/ck_zones.sql`);
  const zoneRows = parseSqlInserts(zoneSql, 'ck_zones');
  const zonesByMap = {};
  for (const r of zoneRows) {
    const [map, , ztype, ztypeid, ax, ay, az, bx, by, bz, , , zgroup, , , , , prespeed] = r;
    const type = ZONE_TYPES[ztype];
    if (!type || typeof map !== 'string') continue;
    const z = {
      t: type,
      g: zgroup | 0,
      i: type === 'stage' ? ztypeid + 2 : type === 'checkpoint' ? ztypeid + 1 : ztypeid,
      a: [round(Math.min(ax, bx)), round(Math.min(ay, by)), round(Math.min(az, bz))],
      b: [round(Math.max(ax, bx)), round(Math.max(ay, by)), round(Math.max(az, bz))],
    };
    if (type === 'start' || type === 'speedstart') z.p = prespeed ?? 350;
    (zonesByMap[map.toLowerCase()] ??= []).push(z);
  }
  console.log(`surftimer zone maps: ${Object.keys(zonesByMap).length}, zones: ${zoneRows.length}`);

  let stTiers = new Map();
  try {
    const tierRows = parseSqlInserts(await get(`${SURFTIMER_RAW}/ck_maptier.sql`), 'ck_maptier');
    stTiers = new Map(tierRows.map((r) => [String(r[0]).toLowerCase(), r[1]]));
  } catch (e) {
    console.warn(`ck_maptier unavailable: ${e.message}`);
  }

  // ---- match catalog names to zone presets
  const byBase = new Map();
  for (const zn of Object.keys(zonesByMap)) {
    const b = baseMapName(zn);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(zn);
  }
  const aliases = {};
  for (const name of maps.keys()) {
    if (zonesByMap[name]) continue;
    const cands = byBase.get(baseMapName(name));
    if (cands?.length) aliases[name] = cands.slice().sort();
  }

  const catalog = [];
  for (const m of [...maps.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const t = tiers.get(m.name) ?? tiers.get(baseMapName(m.name)) ?? null;
    const zoneKey = zonesByMap[m.name] ? m.name : aliases[m.name]?.[0];
    let tier = t?.tier ?? null;
    if (tier === null) {
      const st = stTiers.get(m.name) ?? (zoneKey ? stTiers.get(zoneKey) : undefined);
      if (typeof st === 'number' && st > 0) tier = st;
    }
    let type = t?.type ?? null;
    if (type && !['linear', 'staged', 'staged-linear'].includes(type)) type = null;
    if (!type && zoneKey) type = zonesByMap[zoneKey].some((z) => z.t === 'stage' && z.g === 0) ? 'staged' : 'linear';
    catalog.push({
      name: m.name,
      driveId: m.driveId,
      archive: m.archive,
      tier,
      type,
      hasZones: !!zoneKey,
      featured: FEATURED.includes(m.name),
    });
  }

  // Only ship zones for maps that are in the catalog (keeps the file small).
  const shippedZones = {};
  for (const c of catalog) {
    const key = zonesByMap[c.name] ? c.name : aliases[c.name]?.[0];
    if (key) shippedZones[key] = zonesByMap[key];
  }
  const shippedAliases = {};
  for (const [k, v] of Object.entries(aliases)) shippedAliases[k] = v.filter((n) => shippedZones[n]);

  writeFileSync(join(OUT, 'catalog.json'), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), source: 'https://github.com/OuiSURF/Surf_Maps', maps: catalog }));
  writeFileSync(
    join(OUT, 'zones.json'),
    JSON.stringify({
      license: 'GPL-3.0-only',
      source: 'https://github.com/surftimer/SurfTimer/blob/master/scripts/mysql-files/ck_zones.sql',
      format: 't=type g=group(0 main, N bonus) i=index(stage number / checkpoint number) a=mins b=maxs p=prespeed',
      maps: shippedZones,
      aliases: shippedAliases,
    }),
  );
  const withZones = catalog.filter((c) => c.hasZones).length;
  const withTier = catalog.filter((c) => c.tier !== null).length;
  console.log(`catalog: ${catalog.length} maps, ${withTier} with tier, ${withZones} with zone presets`);
  const missingFeatured = FEATURED.filter((f) => !maps.has(f));
  if (missingFeatured.length) console.warn(`featured maps not found: ${missingFeatured.join(', ')}`);
  // CS:GO-era popularity + classics (public/maps/popularity.json) replace the built-in featured list when present
  const { mergePopularity } = await import('./merge-popularity.mjs');
  const popPath = join(OUT, 'popularity.json');
  if (existsSync(popPath)) {
    const file = JSON.parse(readFileSync(join(OUT, 'catalog.json'), 'utf8'));
    const r = mergePopularity(file.maps, JSON.parse(readFileSync(popPath, 'utf8')));
    writeFileSync(join(OUT, 'catalog.json'), JSON.stringify(file));
    console.log(`popularity: ${r.scored} maps scored, ${r.classics} classics`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
