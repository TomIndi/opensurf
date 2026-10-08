// UX review fixes on the timer side: SurfTimer stage completion lines (+ HUD split flash), the stage clock at 0
// inside a stage's zone, "Rank 1/1" (rank among players, not among your own runs), and runs interrupted because
// the game stopped simulating.
import { beforeEach, describe, expect, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { EntitySystem } from '../src/game/entities';
import { RecordsStorage, getStageBest, setRecordsStorage } from '../src/game/records';
import { SurfTimer } from '../src/game/timer';
import { ZoneDef } from '../src/map/types';
import { setCatalog } from '../src/maps/catalog';
import { MockHost } from './gameworld_host';

class MemStore implements RecordsStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

const FLOOR = { mins: [-20000, -20000, -64] as [number, number, number], maxs: [20000, 20000, 0] as [number, number, number], solid: true };

function zone(type: ZoneDef['type'], x0: number, x1: number, extra: Partial<ZoneDef> = {}): ZoneDef {
  return { type, group: 0, index: 0, mins: v3(x0, -200, 0), maxs: v3(x1, 200, 128), ...extra };
}

const STAGED: ZoneDef[] = [
  zone('start', -200, 200, { prespeed: 350 }),
  zone('stage', 1000, 1200, { index: 2 }),
  zone('stage', 2000, 2200, { index: 3 }),
  zone('end', 3000, 3200),
];

const LINEAR: ZoneDef[] = [zone('start', -200, 200), zone('checkpoint', 1000, 1200, { index: 1 }), zone('end', 3000, 3200)];

function world(zones: ZoneDef[], name = 'surf_ux') {
  const host = new MockHost({ name, world: [FLOOR] }, v3(0, 0, 0));
  const ents = new EntitySystem(host);
  host.entities = ents;
  ents.spawn();
  const timer = new SurfTimer(host);
  timer.setZones(zones, 'preset');
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      host.advance();
      ents.tick();
      timer.tick();
    }
  };
  const at = (x: number, ticks = 1): void => {
    host.setPos(x, 0, 0);
    tick(ticks);
  };
  return { host, timer, tick, at };
}

/** start -> stage 2 -> stage 3 -> end, `gaps` ticks out of the zones per stage (ticks inside each stage zone: 1). */
function run(w: ReturnType<typeof world>, gaps: [number, number, number]): void {
  w.at(0);
  w.at(300); // leave the start: run time 0
  w.at(500, gaps[0] - 1);
  w.at(1100); // stage 2
  w.at(1500, gaps[1]);
  w.at(2100); // stage 3
  w.at(2500, gaps[2]);
  w.at(3100); // end
}

beforeEach(() => {
  setRecordsStorage(new MemStore());
  setCatalog([]);
});

describe('stage completion feedback (SurfTimer stage times)', () => {
  it('reaching stage N+1 reports stage N in its own time vs the stage best; the end completes the last stage', () => {
    const w = world(STAGED);
    run(w, [100, 100, 200]);
    const l1 = w.host.chatText();
    // stage 1: from leaving the start; stage 2: from leaving its zone (one tick inside it) to stage 3
    expect(l1).toContain('[Surf] Player finished Stage 1 in 00:01.000 (first time)');
    expect(l1.indexOf('[Surf] Player finished Stage 1 in 00:01.000 (first time)')).toBe(l1.indexOf('[Surf] Stage 2 | 00:01.000') - 1);
    expect(l1).toContain('[Surf] Player finished Stage 2 in 00:01.000 (first time)');
    expect(l1).toContain('[Surf] Player finished Stage 3 in 00:02.000 (first time)');
    // the last stage's line comes right before the finish line
    const fin = l1.findIndex((l) => l.startsWith('[Surf] Player finished surf_ux in'));
    expect(fin).toBeGreaterThan(0);
    expect(l1[fin - 1]).toBe('[Surf] Player finished Stage 3 in 00:02.000 (first time)');
    expect(getStageBest('surf_ux', 0, 1, 100)?.time).toBeCloseTo(1, 9);
    expect(getStageBest('surf_ux', 0, 3, 100)?.time).toBeCloseTo(2, 9);

    // faster stage 2, slower stage 3: PB deltas per stage, and the HUD split flash gets the stage delta
    w.timer.restart();
    w.host.chats.length = 0;
    w.at(0);
    w.at(300);
    w.at(500, 99);
    w.at(1100);
    w.at(1500, 50); // stage 2 in 0.5 s
    w.at(2100);
    expect(w.host.chatText()).toContain('[Surf] Player finished Stage 2 in 00:00.500 (PB -0.500)');
    const line = w.host.chats.find((c) => c.map((s) => s.text).join('').includes('finished Stage 2'))!;
    expect(line.find((s) => s.text === '-0.500')?.color).toBe('lightgreen');
    const hud = w.timer.getHud();
    expect(hud.lastSplitDelta).toBeCloseTo(-0.5, 9);
    expect(hud.lastSplitLabel).toBe('Stage 2 00:00.500');
    expect(hud.lastSplitTime).toBeCloseTo(1.51, 9);
    // the run split (vs the PB's stage 3 split) is still printed after it
    expect(w.host.chatText().at(-1)).toBe('[Surf] Stage 3 | 00:01.510 (-0.500)');
    expect(getStageBest('surf_ux', 0, 2, 100)?.time).toBeCloseTo(0.5, 9);
    w.at(2500, 250);
    w.at(3100);
    expect(w.host.chatText()).toContain('[Surf] Player finished Stage 3 in 00:02.500 (PB +0.500)');
    expect(getStageBest('surf_ux', 0, 3, 100)?.time).toBeCloseTo(2, 9); // a slower stage keeps the best
    // at the finish the flash shows the run's delta again
    expect(w.timer.getHud().lastSplitLabel).toBe('Finish');
  });

  it('no stage lines in practice; custom physics says it is not saved', () => {
    const w = world(STAGED);
    w.timer.enterPractice('!prac');
    run(w, [10, 10, 10]);
    expect(w.host.chatText().some((l) => l.includes('finished Stage'))).toBe(false);
    const w2 = world(STAGED, 'surf_ux2');
    w2.host.customPhysics = true;
    run(w2, [10, 10, 10]);
    expect(w2.host.chatText()).toContain('[Surf] Player finished Stage 1 in 00:00.100 (custom physics: not saved)');
    expect(getStageBest('surf_ux2', 0, 1, 100)).toBeNull();
  });

  it('a stage without a best yet leaves the split flash to the run split', () => {
    const w = world(STAGED);
    run(w, [100, 100, 100]); // PB with stage splits
    w.timer.restart();
    // forget the stage bests but keep the PB run
    setRecordsStorage(new MemStore());
    w.timer.invalidateRecords();
    w.at(0);
    w.at(300);
    w.at(500, 79);
    w.at(1100); // stage 2 at 0.8 s; no PB here any more either
    expect(w.timer.getHud().lastSplitLabel).toBe('Stage 2');
    expect(w.timer.getHud().lastSplitDelta).toBeNull();
  });
});

describe('stage clock', () => {
  it('shows 0 while standing in the current stage zone, counts from leaving it', () => {
    const w = world(STAGED);
    w.at(0);
    w.at(300);
    w.at(500, 50);
    expect(w.timer.getHud().stageTime).toBeCloseTo(0.5, 9);
    w.at(1100); // stage 2 reached
    w.at(1100, 40); // standing in stage 2's zone: the run clock runs, the stage clock doesn't
    const hud = w.timer.getHud();
    expect(hud.state).toBe('running');
    expect(hud.stage).toBe(2);
    expect(hud.stageTime).toBe(0);
    expect(hud.time).toBeGreaterThan(0.9);
    w.at(1500); // leaves it: the stage clock starts from 0 (no jump back)
    expect(w.timer.getHud().stageTime).toBe(0);
    w.at(1500, 30);
    expect(w.timer.getHud().stageTime).toBeCloseTo(0.3, 9);
  });
});

describe('rank wording', () => {
  it('a finish says Rank 1/1 (rank among players), even for your 3rd best run', () => {
    const w = world(LINEAR);
    const lines = (): string[] => w.host.chatText().filter((l) => l.includes(' finished surf_ux'));
    const lin = (gap: number): void => {
      w.timer.restart();
      w.at(0);
      w.at(300);
      w.at(500, gap);
      w.at(1100);
      w.at(2000, gap);
      w.at(3100);
    };
    lin(100);
    lin(50);
    lin(150);
    expect(lines()).toHaveLength(3);
    for (const l of lines()) expect(l).toMatch(/\| Rank 1\/1$/);
    expect(lines().some((l) => /Rank [0-9]+\/[2-9]/.test(l))).toBe(false);
  });
});

describe('interrupted runs', () => {
  it('interruptRun puts a ranked run in practice with a chat line; nothing to do otherwise', () => {
    const w = world(STAGED);
    expect(w.timer.interruptRun()).toBe(false); // start zone
    w.at(0);
    w.at(300);
    w.at(500, 30);
    expect(w.timer.getHud().state).toBe('running');
    expect(w.timer.interruptRun()).toBe(true);
    expect(w.timer.getHud().state).toBe('practice');
    expect(w.timer.inPractice).toBe(true);
    expect(w.host.chatText().at(-1)).toBe("[Surf] Timer stopped — run paused, it won't count. Type !r to restart.");
    expect(w.timer.interruptRun()).toBe(false); // once
    // the run can't be saved any more
    w.at(1100);
    w.at(2100);
    w.at(3100);
    expect(w.host.chatText().at(-1)).toContain('(practice — not saved)');
    // !r: a fresh ranked run
    w.timer.restart();
    w.at(0);
    w.at(300);
    expect(w.timer.getHud().state).toBe('running');
  });
});
