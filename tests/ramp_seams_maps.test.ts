// Getting stopped at the end of a ramp (opt-in, real maps + KSF world-record replays).
//
//   SURF_TEST_MAPS=<dir with surf_utopia_njv.bsp ...> SURF_TEST_KSF_REPLAYS=<dir> npx vitest run tests/ramp_seams_maps.test.ts
//
// SURF_TEST_KSF_REPLAYS holds KSF leaderboards as downloaded from
// https://ksf.surf/api/maps/<map>/records/zone/0/0?game=<css|css100t>&mode=0, saved as records_<map>_<board>.json, next to
// the replay files they list (https://ksf.surf/api/replays/<file>?game=<board>). Skipped unless both the map and at
// least one listed replay are there.
//
// User report: "I keep on getting stuck at the end of a ramp in utopia" - the ramp that runs into the box with the
// cyan/orange diamond frame (surf_utopia_njv, x -4142..-6144 at z ~2100-2700, both sides of the centre wall). The
// main ramp brush ends at x = -6112 against a 32-unit end cap whose sloped face lies 0.0161 units off the ramp's
// plane (proud on the y > 0 side, recessed on the y < 0 side) - less than DIST_EPSILON. A surfer hovers DIST_EPSILON
// above the ramp, i.e. inside the cap's epsilon shell, and the box trace (Quake 3's "missed" test, which counted a
// move ending within DIST_EPSILON of the cap's face as touching the cap) then stopped on the cap's vertical end face:
// horizontal speed dropped to ~0 at x = -6096. Every KSF replay slides across that seam at full speed (3440 u/s,
// hovering 0.031 above the ramp, 0.015 above the cap), as Source's rule (in front of a face at both ends of the move
// = the brush is never touched) says. Synthetic versions of these checks: ramp_seams.test.ts.
//
//  1. Replay differential: for every frame of every replay, our movement continues from the replay's state with the
//     replay's commands for 30 ticks; no window may be stopped at a ramp SEAM (helpers/ramp_diff.ts) while the real
//     run keeps its speed. Other differences (CS:S hull sizes, duck shifts, key-press timing) are only logged.
//  2. Sweep of the reported ramp end, both sides: lateral positions, speeds, yaw, strafe keys, landing or sliding
//     starts, 100 and 66 tick - never a seam stop.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseKsfReplay } from '../src/maps/ksfreplay';
import { CollisionWorld } from '../src/physics/collision';
import { LogWorld, SeamRunParams, Stop, classifyStop, loadCollisionWorld, replayStops, surfRun } from './helpers/ramp_diff';

const MAPS_DIR = process.env.SURF_TEST_MAPS;
const REPLAY_DIR = process.env.SURF_TEST_KSF_REPLAYS;
const isDir = (d: string | undefined): d is string => !!d && existsSync(d) && statSync(d).isDirectory();

interface ReplaySet {
  map: string;
  bsp: string;
  replays: { file: string; board: string; rank: number; path: string; time: number }[];
}

function findReplaySets(): ReplaySet[] {
  if (!isDir(MAPS_DIR) || !isDir(REPLAY_DIR)) return [];
  const sets = new Map<string, ReplaySet>();
  for (const f of readdirSync(REPLAY_DIR).sort()) {
    const m = /^records_(.+)_(css|css100t)\.json$/.exec(f);
    if (!m) continue;
    const [, map, board] = m;
    const bsp = join(MAPS_DIR, `${map}.bsp`);
    if (!existsSync(bsp)) continue;
    let list: { rank: number; file: string; time: number }[];
    try {
      list = JSON.parse(readFileSync(join(REPLAY_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    let set = sets.get(map);
    if (!set) sets.set(map, (set = { map, bsp, replays: [] }));
    for (const r of list) {
      const path = r && typeof r.file === 'string' ? join(REPLAY_DIR, r.file) : '';
      if (path && existsSync(path)) set.replays.push({ file: r.file, board, rank: r.rank, path, time: r.time });
    }
  }
  return [...sets.values()].filter((s) => s.replays.length > 0);
}

const SETS = findReplaySets();
const UTOPIA = SETS.find((s) => s.map === 'surf_utopia_njv');
const worlds = new Map<string, CollisionWorld>();
const world = (bsp: string) => {
  let w = worlds.get(bsp);
  if (!w) worlds.set(bsp, (w = loadCollisionWorld(bsp)));
  return w;
};

function describeStop(s: Stop): string {
  const c = s.cls;
  const f = (v: number[]) => v.map((x) => x.toFixed(4)).join(',');
  return (
    `${s.file} frame ${s.k} at (${s.pos.map((x) => x.toFixed(1)).join(',')}): ${s.h0.toFixed(0)} u/s -> ${s.ourMin.toFixed(0)} (real >= ${s.repMin.toFixed(0)}) at tick ${s.stopTick}` +
    (c.block ? `; blocked by brush ${c.block.brush} n=(${f(c.block.n)}) d=${c.block.d.toFixed(3)} frac=${c.block.fraction.toFixed(4)}` : '') +
    (c.ramp ? `; on ramp brush ${c.ramp.brush} n=(${f(c.ramp.n)}) d=${c.ramp.d.toFixed(4)}` : '') +
    (c.match ? `; seam step ${c.match.offset >= 0 ? '+' : ''}${c.match.offset.toFixed(4)}` : '')
  );
}

describe.skipIf(SETS.length === 0)('ramp seams vs KSF replays (SURF_TEST_MAPS + SURF_TEST_KSF_REPLAYS)', () => {
  for (const set of SETS) {
    it(`${set.map}: no replay window is stopped at a ramp seam (${set.replays.length} replays)`, () => {
      const w = world(set.bsp);
      const seam: Stop[] = [];
      const other: Stop[] = [];
      let windows = 0;
      for (const r of set.replays) {
        let rep;
        try {
          const buf = readFileSync(r.path);
          rep = parseKsfReplay(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
            tickInterval: r.board === 'css100t' ? 0.01 : 0.015,
            expectedTime: r.time,
          });
        } catch {
          continue; // a broken download
        }
        const res = replayStops(w, rep, `${r.board}#${r.rank}`);
        windows += res.windows;
        for (const s of res.stops) (s.cls.kind === 'seam' ? seam : other).push(s);
      }
      console.log(`[ramp seams] ${set.map}: ${windows} windows, ${seam.length} seam stops, ${other.length} other stops`);
      for (const s of other.slice(0, 10)) console.log(`  other: ${describeStop(s)}`);
      const byPlace = new Map<string, Stop[]>();
      for (const s of seam) {
        const key = `brush ${s.cls.block?.brush}`;
        byPlace.set(key, [...(byPlace.get(key) ?? []), s]);
      }
      const report = [...byPlace.values()].map((g) => `${g.length} x ${describeStop(g[0])}`);
      expect(report, `windows stopped at a ramp seam:\n${report.join('\n')}`).toEqual([]);
    });
  }

  it.skipIf(!UTOPIA)('surf_utopia_njv: the ramp into the diamond box keeps its speed over the end-cap seam (both sides, 100/66 tick)', () => {
    const w = world(UTOPIA!.bsp);
    const lw = new LogWorld(w);
    // the two ramps (sloped faces of brushes bsp2669 / bsp2674), surfed towards -x, ending at x = -6144
    const sides: { name: string; n: [number, number, number]; d: number; ys: number[] }[] = [
      { name: 'right (y > 0)', n: [0, 0.78086764, 0.62469655], d: 1704.13074, ys: [70, 150, 230, 310, 390, 470] },
      { name: 'left (y < 0)', n: [0, -0.78086907, 0.62469471], d: 1704.1261, ys: [-70, -150, -230, -310, -390, -470] },
    ];
    const stopped: string[] = [];
    let runs = 0;
    for (const side of sides)
      for (const y of side.ys)
        for (const speed of [900, 1733, 2500, 3500])
          for (const yaw of [-4, 0, 4])
            for (const key of ['into', 'none', 'away', 'fwd'] as const)
              for (const start of [
                // sliding (see SeamRunParams.slide) and landing
                { h: 0.03125, vn: 0, slide: true },
                { h: 2, vn: -150 },
              ])
                for (const dt of [0.01, 0.015]) {
                  const lead = Math.min(1800, speed * 0.25);
                  const x = -6144 + lead;
                  const z = (side.d - side.n[1] * y) / side.n[2];
                  const p: SeamRunParams = {
                    n: side.n,
                    d: side.d,
                    corner: [x, y, z],
                    dir: [-1, 0],
                    speed,
                    yaw,
                    h: start.h,
                    vn: start.vn,
                    slide: start.slide,
                    key,
                    dt,
                    ticks: Math.ceil((lead + 150) / (speed * 0.5) / dt),
                  };
                  runs++;
                  const out = surfRun(w, p);
                  if (!out) continue;
                  lw.log = [];
                  const o2 = surfRun(w, p, lw)!;
                  const cls = classifyStop(
                    lw.log.filter((t) => t.tick === o2.tick),
                    w,
                  );
                  lw.log = null;
                  if (cls.kind !== 'seam') continue;
                  stopped.push(
                    `${side.name} y=${y} ${speed} u/s yaw ${yaw} ${key} h=${start.h} vn=${start.vn} dt=${dt}: stopped at (${o2.pos.map((v) => v.toFixed(2)).join(',')}) by brush ${cls.block!.brush} n=(${cls.block!.n.join(',')}) d=${cls.block!.d} (seam step ${cls.match!.offset.toFixed(4)})`,
                  );
                }
    console.log(`[ramp seams] utopia box ramp end: ${stopped.length} of ${runs} runs stopped at the seam`);
    expect(stopped.slice(0, 20), `${stopped.length} of ${runs} runs stopped at the end-cap seam`).toEqual([]);
  });
});
