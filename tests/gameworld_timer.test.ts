import { beforeEach, describe, expect, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { EntitySystem } from '../src/game/entities';
import { RecordsStorage, getRecords, setRecordsStorage } from '../src/game/records';
import { ReplaySystem } from '../src/game/replay';
import { SurfTimer, formatRunTime, formatSplitDelta, zoneFloorPoint } from '../src/game/timer';
import { ZoneDef } from '../src/map/types';
import { setCatalog } from '../src/maps/catalog';
import { IN_DUCK, IN_JUMP, MOVETYPE_NOCLIP, MOVETYPE_WALK } from '../src/physics/playertypes';
import { MapSpec, MockHost } from './gameworld_host';

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

const DESTS = `
  { "classname" "info_teleport_destination" "targetname" "s1" "origin" "0 0 0" "angles" "0 90 0" }
  { "classname" "info_teleport_destination" "targetname" "s2" "origin" "1100 0 0" "angles" "0 180 0" }
  { "classname" "info_player_counterterrorist" "origin" "-8000 0 0" "angles" "0 45 0" }`;

interface World {
  host: MockHost;
  ents: EntitySystem;
  timer: SurfTimer;
  tick(n?: number): void;
  at(x: number, ticks?: number, y?: number): void;
}

function world(zones: ZoneDef[], entities = DESTS, name = 'surf_test', models?: MapSpec['models']): World {
  const host = new MockHost({ name, world: [FLOOR], entities, models }, v3(0, 0, 0));
  const ents = new EntitySystem(host);
  host.entities = ents;
  ents.spawn();
  const timer = new SurfTimer(host);
  host.onKill = () => timer.onPlayerKilled();
  timer.setZones(zones, 'preset');
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      host.advance();
      ents.tick();
      timer.tick();
    }
  };
  const at = (x: number, ticks = 1, y = 0): void => {
    host.setPos(x, y, 0);
    tick(ticks);
  };
  return { host, ents, timer, tick, at };
}

/** Start -> stage 2 -> stage 3 -> end with `gap` ticks spent between zones. */
function run(w: World, gaps: [number, number, number]): void {
  w.at(0);
  w.at(300); // leave the start zone: run starts (time 0)
  w.at(500, gaps[0] - 1);
  w.at(1100); // stage 2
  w.at(1500, gaps[1] - 1);
  w.at(2100); // stage 3
  w.at(2500, gaps[2] - 1);
  w.at(3100); // end
}

beforeEach(() => {
  setRecordsStorage(new MemStore());
  setCatalog([]);
});

describe('formatting', () => {
  it('formats run times and deltas SurfTimer-style (truncated milliseconds)', () => {
    expect(formatRunTime(0)).toBe('00:00.000');
    expect(formatRunTime(42.123)).toBe('00:42.123');
    expect(formatRunTime(4712 * 0.01)).toBe('00:47.120');
    expect(formatRunTime(3723.4567)).toBe('1:02:03.456');
    expect(formatSplitDelta(-0.231)).toBe('-0.231');
    expect(formatSplitDelta(1.2345)).toBe('+1.234');
    expect(formatSplitDelta(62.5)).toBe('+1:02.500');
  });
});

describe('SurfTimer run flow', () => {
  it('start zone -> stages -> end -> PB, then faster/slower runs', () => {
    const w = world(STAGED);
    const starts: number[] = [];
    w.timer.onRunStart = (g) => starts.push(g);
    expect(w.timer.getHud().state).toBe('startzone');
    w.at(0);
    w.at(300);
    expect(w.timer.getHud()).toMatchObject({ state: 'running', time: 0, stage: 1, stageCount: 3, mapType: 'staged' });
    expect(starts).toEqual([0]);
    w.at(500, 99);
    expect(w.timer.getHud().time).toBeCloseTo(0.99, 9);
    w.at(1100);
    expect(w.timer.getHud()).toMatchObject({ stage: 2 });
    expect(w.host.chatText().at(-1)).toBe('[Surf] Stage 2 | 00:01.000');
    expect(w.host.sound.played).toContain('stage');
    w.at(1500, 99);
    w.at(2100);
    w.at(2500, 99);
    w.at(3100);
    const hud = w.timer.getHud();
    expect(hud.state).toBe('finished');
    expect(hud.time).toBeCloseTo(3, 9);
    expect(hud.pb).toBeCloseTo(3, 9);
    const lines = w.host.chatText();
    expect(lines).toContain('[Surf] Player finished surf_test in 00:03.000 | Rank 1/1');
    expect(lines.at(-1)).toBe('[Surf] NEW PERSONAL BEST!');
    expect(w.host.sound.played.at(-1)).toBe('pb');
    const recs = getRecords('surf_test', 0);
    expect(recs).toHaveLength(1);
    expect(recs[0].stageSplits[2]).toBeCloseTo(1, 9);
    expect(recs[0].stageSplits[3]).toBeCloseTo(2, 9);
    // frozen while finished
    w.at(3150, 50);
    expect(w.timer.getHud().time).toBeCloseTo(3, 9);

    // faster run: green splits, new PB
    w.timer.restart();
    expect(w.timer.getHud().state).toBe('startzone');
    run(w, [50, 100, 100]);
    const l2 = w.host.chatText();
    expect(l2).toContain('[Surf] Stage 2 | 00:00.500 (-0.500)');
    const split = w.host.chats.find((c) => c.some((s) => s.text === '-0.500'))!;
    expect(split.find((s) => s.text === '-0.500')?.color).toBe('lightgreen');
    expect(l2).toContain('[Surf] Player finished surf_test in 00:02.500 (-0.500) | Rank 1/1');
    expect(w.timer.getHud().lastSplitDelta).toBeCloseTo(-0.5, 9);

    // slower run: red, no PB
    w.timer.restart();
    run(w, [100, 100, 100]);
    const l3 = w.host.chatText();
    expect(l3).toContain('[Surf] Stage 2 | 00:01.000 (+0.500)');
    // SurfTimer's rank is among players (one on a local server), not among your own runs
    expect(l3.at(-1)).toBe('[Surf] Player finished surf_test in 00:03.000 (+0.500) | Rank 1/1');
    expect(w.host.sound.played.at(-1)).toBe('finish');
    expect(getRecords('surf_test', 0).map((r) => r.time)).toEqual([2.5, 3, 3].map((t) => expect.closeTo(t, 9)));
    expect(w.timer.getRecords(0)).toHaveLength(3);
  });

  it('the run clock is simulated time: a tickrate change mid-run does not rescale the time already run', () => {
    const w = world(STAGED);
    w.at(0);
    w.at(300); // run starts (time 0)
    w.at(500, 100); // 100 ticks at 100 tick = 1 s
    expect(w.timer.getHud().time).toBeCloseTo(1, 9);
    w.host.tickInterval = 1 / 64;
    expect(w.timer.getHud().time).toBeCloseTo(1, 9); // no jump to 100 / 64 s
    w.at(500, 64); // + 1 s at 64 tick
    expect(w.timer.getHud().time).toBeCloseTo(2, 9);
    w.at(1100); // stage 2 at 2 s + 1/64
    expect(w.host.chatText().at(-1)).toBe('[Surf] Stage 2 | 00:02.015');
    w.host.tickInterval = 0.01;
    w.at(1500, 50); // the stage clock starts on the tick that leaves the stage zone
    expect(w.timer.getHud().stageTime).toBeCloseTo(0.49, 9);
    expect(w.timer.getHud().time).toBeCloseTo(2 + 1 / 64 + 0.5, 9);
  });

  it('a finished run stays frozen in the start zone until the next run starts', () => {
    const w = world(STAGED);
    run(w, [10, 10, 10]);
    expect(w.timer.getHud().state).toBe('finished');
    const t = w.timer.getHud().time;
    w.at(0, 30); // e.g. the map teleports the player back to the start
    expect(w.timer.getHud()).toMatchObject({ state: 'finished', time: t });
    w.at(300);
    expect(w.timer.getHud()).toMatchObject({ state: 'running', time: 0 });
  });

  it('caps horizontal prespeed when leaving the start zone', () => {
    const w = world(STAGED);
    w.at(0);
    w.host.player.velocity.x = 600;
    w.host.player.velocity.y = 0;
    w.host.player.velocity.z = 250;
    w.at(300);
    expect(w.host.player.velocity.x).toBeCloseTo(350, 9);
    expect(w.host.player.velocity.z).toBe(250);
  });

  it('prespeed 0 means no cap; no cap without an end zone (SurfTimer)', () => {
    const w = world([zone('start', -200, 200, { prespeed: 0 }), zone('end', 3000, 3200)]);
    w.at(0);
    w.host.player.velocity.x = 900;
    w.at(300);
    expect(w.host.player.velocity.x).toBe(900);
    const w2 = world([zone('start', -200, 200)]);
    w2.at(0);
    w2.host.player.velocity.x = 900;
    w2.at(300);
    expect(w2.host.player.velocity.x).toBe(900);
  });

  it('re-entering the start zone resets the run; teleports into it from the map too', () => {
    const w = world(STAGED);
    w.at(0);
    w.at(300, 10);
    expect(w.timer.getHud().state).toBe('running');
    w.at(0);
    expect(w.timer.getHud()).toMatchObject({ state: 'startzone', time: 0 });
  });

  it('practice mode: run continues unranked, finish not saved, !r leaves practice', () => {
    const w = world(STAGED);
    w.at(0);
    w.at(300, 10);
    w.timer.enterPractice('saveloc');
    expect(w.timer.inPractice).toBe(true);
    expect(w.timer.getHud().state).toBe('practice');
    w.at(1100);
    w.at(2100);
    w.at(3100);
    expect(w.timer.getHud().state).toBe('finished');
    expect(getRecords('surf_test', 0)).toHaveLength(0);
    expect(w.host.chatText().at(-1)).toContain('practice');
    w.timer.restart();
    expect(w.timer.inPractice).toBe(false);
  });

  it('custom physics runs are not saved', () => {
    const w = world(STAGED);
    w.host.customPhysics = true;
    run(w, [10, 10, 10]);
    expect(w.timer.getHud().state).toBe('finished');
    expect(getRecords('surf_test', 0)).toHaveLength(0);
    expect(w.host.chatText().at(-1)).toContain('custom physics');
  });

  it('noclip never starts a run', () => {
    const w = world(STAGED);
    w.at(0);
    w.host.player.moveType = MOVETYPE_NOCLIP;
    w.at(300, 5);
    expect(w.timer.getHud().state).toBe('stopped');
  });
});

describe('SurfTimer restarts and spawns', () => {
  it('restart resets player modifiers and teleports to the start destination', () => {
    const w = world(STAGED);
    w.at(0);
    w.at(1500, 20);
    const ps = w.host.player;
    ps.gravityScale = 0.3;
    ps.laggedMovement = 2;
    ps.baseVelocity.x = 500;
    ps.velocity.x = 1000;
    ps.moveType = MOVETYPE_NOCLIP;
    w.ents.playerTargetname = 'X3';
    w.ents.playerClassname = 'bonus_secret';
    const cancels: number[] = [];
    w.timer.onRunCancel = () => cancels.push(1);
    w.timer.restart();
    expect(ps.origin).toEqual(v3(0, 0, 0));
    expect(ps.viewAngles.yaw).toBe(90);
    expect(ps.velocity).toEqual(v3(0, 0, 0));
    expect(ps.gravityScale).toBe(1);
    expect(ps.laggedMovement).toBe(1);
    expect(ps.baseVelocity).toEqual(v3(0, 0, 0));
    expect(ps.moveType).toBe(MOVETYPE_WALK);
    expect(w.ents.playerTargetname).toBe('');
    expect(w.ents.playerClassname).toBe('player');
    expect(w.timer.getHud().state).toBe('startzone');
    expect(cancels).toEqual([1]);
  });

  it('getStartSpawn: zone.spawn > destination inside > map spawn near > floor under the center', () => {
    const withSpawn = world([zone('start', -200, 200, { spawn: { origin: v3(5, 6, 7), angles: { pitch: 0, yaw: 33, roll: 0 } } })]);
    expect(withSpawn.timer.getStartSpawn(0)).toEqual({ origin: v3(5, 6, 7), angles: { pitch: 0, yaw: 33, roll: 0 } });

    const dest = world([zone('start', -200, 200)]);
    expect(dest.timer.getStartSpawn(0)).toEqual({ origin: v3(0, 0, 0), angles: { pitch: 0, yaw: 90, roll: 0 } });

    const spawnPt = world([zone('start', -8100, -7900)]);
    expect(spawnPt.timer.getStartSpawn(0)).toEqual({ origin: v3(-8000, 0, 0), angles: { pitch: 0, yaw: 45, roll: 0 } });

    const floor = world([zone('start', 5000, 5200)]);
    const sp = floor.timer.getStartSpawn(0);
    expect(sp.origin.x).toBeCloseTo(5100, 6);
    expect(sp.origin.y).toBeCloseTo(0, 6);
    expect(sp.origin.z).toBeGreaterThanOrEqual(0);
    expect(sp.origin.z).toBeLessThan(0.1);
  });

  it('zoneFloorPoint falls back to the zone bottom when there is no floor', () => {
    const w = world([zone('start', -200, 200)]);
    const p = zoneFloorPoint(w.host.collision, { type: 'start', group: 0, index: 0, mins: v3(0, 0, 5000), maxs: v3(100, 100, 5100) }, 100);
    expect(p).toEqual(v3(50, 50, 5001));
  });

  it('restartStage keeps the run and returns to the current stage start', () => {
    const w = world(STAGED);
    w.at(0);
    w.at(300, 10);
    w.at(1100);
    w.at(1500, 30);
    w.timer.restartStage();
    expect(w.host.player.origin).toEqual(v3(1100, 0, 0)); // the stage 2 destination
    expect(w.host.player.viewAngles.yaw).toBe(180);
    expect(w.timer.getHud()).toMatchObject({ state: 'running', stage: 2 });
    w.tick(5);
    expect(w.timer.getHud().time).toBeCloseTo(0.45, 9); // the clock kept running
    // stage 3 has no destination: floor under the zone's center
    w.at(2100);
    w.at(2500, 5);
    w.timer.restartStage();
    expect(w.host.player.origin.x).toBeCloseTo(2100, 6);
    expect(w.timer.getHud().stage).toBe(3);
  });

  it('!back on stage 1 / linear maps restarts the course', () => {
    const w = world(STAGED);
    w.at(0);
    w.at(500, 10);
    w.timer.restartStage();
    expect(w.timer.getHud().state).toBe('startzone');
  });

  it('gotoStage enters practice at the stage; gotoStage(1) restarts', () => {
    const w = world(STAGED);
    w.timer.gotoStage(3);
    expect(w.timer.inPractice).toBe(true);
    expect(w.timer.getHud()).toMatchObject({ state: 'practice', stage: 3 });
    expect(w.host.player.origin.x).toBeCloseTo(2100, 6);
    w.timer.gotoStage(9);
    expect(w.host.chatText().at(-1)).toContain("Stage 9 doesn't exist");
    w.timer.gotoStage(1);
    expect(w.timer.inPractice).toBe(false);
    expect(w.timer.getHud().state).toBe('startzone');
  });

  it('gotoEnd teleports to the end zone in practice', () => {
    const w = world(STAGED);
    expect(w.timer.gotoEnd()).toBe(true);
    expect(w.host.player.origin.x).toBeCloseTo(3100, 6);
    expect(w.timer.inPractice).toBe(true);
    w.tick();
    expect(w.timer.getHud().state).toBe('stopped'); // standing in the end zone does not finish anything
    expect(world([zone('start', -200, 200)]).timer.gotoEnd()).toBe(false);
  });

  it('onPlayerKilled (trigger_hurt): stage start on stage > 1, course start otherwise', () => {
    const ents = `${DESTS}
      { "classname" "trigger_hurt" "model" "*1" "damage" "1000" "spawnflags" "1" }`;
    const w = world(STAGED, ents, 'surf_test', { 1: { mins: [1400, -50, 0], maxs: [1600, 50, 100] } });
    w.at(0);
    w.at(300);
    w.at(1100);
    w.at(1500); // dies in stage 2
    expect(w.host.kills).toHaveLength(1);
    expect(w.host.player.origin).toEqual(v3(1100, 0, 0));
    expect(w.timer.getHud()).toMatchObject({ state: 'running', stage: 2 });
    w.timer.restart();
    w.at(0);
    w.at(300);
    w.timer.onPlayerKilled(); // stage 1
    expect(w.timer.getHud().state).toBe('startzone');
  });

  it('bonus courses: group switch, separate records, restart(N)', () => {
    const zones: ZoneDef[] = [
      ...STAGED,
      { type: 'start', group: 1, index: 0, mins: v3(-200, 4800, 0), maxs: v3(200, 5200, 128) },
      { type: 'end', group: 1, index: 0, mins: v3(1000, 4800, 0), maxs: v3(1200, 5200, 128) },
    ];
    const w = world(zones);
    w.at(0, 1, 5000);
    expect(w.timer.getHud()).toMatchObject({ state: 'startzone', bonus: 1, mapType: 'linear' });
    w.at(300, 50, 5000);
    w.at(1100, 1, 5000);
    expect(w.timer.getHud().state).toBe('finished');
    expect(getRecords('surf_test', 1)).toHaveLength(1);
    expect(getRecords('surf_test', 0)).toHaveLength(0);
    expect(w.host.chatText().some((l) => l.includes('surf_test Bonus 1 in 00:00.500'))).toBe(true);
    w.timer.restart(0);
    expect(w.timer.getHud().bonus).toBe(0);
    w.timer.restart(1);
    expect(w.host.player.origin.y).toBeCloseTo(5000, 6);
    expect(w.timer.getHud()).toMatchObject({ bonus: 1, state: 'startzone' });
    w.timer.restart(7);
    expect(w.host.chatText().at(-1)).toContain("Bonus 7 doesn't exist");
  });
});

describe('SurfTimer special zones', () => {
  it('linear maps: checkpoints with splits', () => {
    const zones: ZoneDef[] = [
      zone('start', -200, 200),
      zone('checkpoint', 1000, 1200, { index: 1 }),
      zone('checkpoint', 2000, 2200, { index: 2 }),
      zone('end', 3000, 3200),
    ];
    const w = world(zones);
    run(w, [100, 100, 100]);
    expect(w.host.chatText()).toContain('[Surf] CP 1 | 00:01.000');
    expect(w.host.sound.played).toContain('checkpoint');
    w.timer.restart();
    run(w, [80, 100, 100]);
    expect(w.host.chatText()).toContain('[Surf] CP 1 | 00:00.800 (-0.200)');
    expect(w.host.chatText()).toContain('[Surf] CP 2 | 00:01.800 (-0.200)');
    const hud = w.timer.getHud();
    expect(hud).toMatchObject({ mapType: 'linear', stage: 0, checkpoint: 2, checkpointCount: 2 });
  });

  it('stop and teletostart zones', () => {
    const w = world([...STAGED, zone('stop', 1500, 1600), zone('teletostart', 2500, 2600)]);
    w.at(0);
    w.at(300, 10);
    w.at(1550);
    expect(w.timer.getHud().state).toBe('stopped');
    const t = w.timer.getHud().time;
    w.at(1800, 10);
    expect(w.timer.getHud().time).toBe(t);
    w.at(2550);
    expect(w.host.player.origin).toEqual(v3(0, 0, 0));
    expect(w.timer.getHud().state).toBe('startzone');
  });

  it('antijump/antiduck filter buttons, maxspeed caps speed', () => {
    const w = world([...STAGED, zone('antijump', 500, 600), zone('antiduck', 700, 800), zone('maxspeed', 900, 950, { prespeed: 400 })]);
    w.at(550);
    expect(w.timer.filterButtons(IN_JUMP | IN_DUCK)).toBe(IN_DUCK);
    w.at(750);
    expect(w.timer.filterButtons(IN_JUMP | IN_DUCK)).toBe(IN_JUMP);
    w.host.player.velocity.x = 1000;
    w.at(920);
    expect(w.host.player.velocity.x).toBeCloseTo(400, 9);
    w.at(1500);
    expect(w.timer.filterButtons(IN_JUMP | IN_DUCK)).toBe(IN_JUMP | IN_DUCK);
  });

  it('checker sends back unless a validator was touched this run', () => {
    const w = world([...STAGED, zone('validator', 1300, 1400), zone('checker', 1600, 1700)]);
    w.at(0);
    w.at(300, 5);
    w.at(1100);
    w.at(1650); // skipped the validator
    expect(w.host.player.origin).toEqual(v3(1100, 0, 0));
    w.at(1350);
    w.at(1650);
    expect(w.host.player.origin.x).toBe(1650);
  });

  it('two overlapping start zones: the run starts only when leaving both', () => {
    const w = world([zone('start', -200, 200), zone('start', 150, 400, { index: 1 }), zone('end', 3000, 3200)]);
    w.at(0);
    w.at(300);
    expect(w.timer.getHud().state).toBe('startzone');
    w.at(500);
    expect(w.timer.getHud().state).toBe('running');
  });

  it('can be constructed before the entity system exists', () => {
    const host = new MockHost({ world: [FLOOR], entities: DESTS }, v3(0, 0, 0));
    const timer = new SurfTimer(host); // host.entities not assigned yet
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    timer.setZones(STAGED, 'preset');
    timer.restart();
    expect(timer.getHud().state).toBe('startzone');
    timer.dispose();
  });

  it('no zones -> disabled; restart goes to the map spawn', () => {
    const w = world([]);
    expect(w.timer.getHud().state).toBe('disabled');
    expect(w.timer.zoneSource).toBe('none');
    w.timer.restart();
    expect(w.host.player.origin).toEqual(v3(-8000, 0, 0));
  });
});

describe('SurfTimer stats, replay hooks, heuristic stages', () => {
  it('jumps, strafes and sync count only during runs', () => {
    const w = world(STAGED);
    w.timer.recordInput(-450, 0, 1, false, true); // not running
    w.at(0);
    w.at(300);
    w.timer.recordInput(0, 0, 0, true, true); // jump
    w.timer.recordInput(-450, 0, 2, false, false); // left strafe turning left: synced
    w.timer.recordInput(-450, 0, 1, false, false);
    w.timer.recordInput(450, 0, -1, false, false); // right strafe turning right: synced
    w.timer.recordInput(450, 0, 1, false, false); // turning the wrong way
    w.timer.recordInput(450, 0, 0, false, false); // no turn: not measured
    w.timer.recordInput(-450, 0, 0, true, false); // ground: ignored
    expect(w.timer.getStats()).toEqual({ jumps: 1, strafes: 2, sync: 75 });
  });

  it('attached ReplaySystem records the run and keeps the PB replay', () => {
    const w = world(STAGED);
    const replay = new ReplaySystem('surf_test');
    replay.tickInterval = 0.01;
    w.timer.setReplay(replay);
    const step = (x: number, n = 1): void => {
      for (let i = 0; i < n; i++) {
        w.at(x);
        replay.recordTick(w.host.player.origin, w.host.player.viewAngles, false, 0);
      }
    };
    step(0);
    step(300);
    expect(replay.recording).toBe(true);
    step(600, 99);
    step(1100);
    step(2100);
    step(3100);
    expect(replay.recording).toBe(false);
    const pb = replay.getPb(0)!;
    expect(pb).toBeTruthy();
    expect(pb.time).toBeCloseTo(1.02, 9);
    expect(pb.tickrate).toBeCloseTo(100, 6);
    expect(replay.ghostAt(0.5)!.origin.x).toBeCloseTo(600, 6);
    // a slower run doesn't replace it
    w.timer.restart();
    step(0);
    step(300);
    step(600, 200);
    step(1100);
    step(2100);
    step(3100);
    expect(replay.getPb(0)!.time).toBeCloseTo(1.02, 9);
    // a restart mid-run cancels the recording
    w.timer.restart();
    step(0);
    step(300, 5);
    expect(replay.recording).toBe(true);
    w.timer.restart();
    expect(replay.recording).toBe(false);
  });

  it('heuristic stages on staged maps without stage zones (new teleport destination = next stage)', () => {
    setCatalog([{ name: 'surf_heur', driveId: '', tier: 1, type: 'staged', hasZones: false, featured: false }]);
    const ents = `
      { "classname" "info_teleport_destination" "targetname" "d1" "origin" "0 0 0" }
      { "classname" "info_teleport_destination" "targetname" "d2" "origin" "5000 0 0" }
      { "classname" "info_teleport_destination" "targetname" "d3" "origin" "9000 0 0" }
      { "classname" "trigger_teleport" "model" "*1" "target" "d2" "spawnflags" "1" }
      { "classname" "trigger_teleport" "model" "*2" "target" "d2" "spawnflags" "1" }
      { "classname" "trigger_teleport" "model" "*3" "target" "d3" "spawnflags" "1" }`;
    const host = new MockHost(
      {
        name: 'surf_heur',
        world: [FLOOR],
        entities: ents,
        models: {
          1: { mins: [1000, -100, 0], maxs: [1100, 100, 100] },
          2: { mins: [6000, -100, 0], maxs: [6100, 100, 100] },
          3: { mins: [7000, -100, 0], maxs: [7100, 100, 100] },
        },
      },
      v3(0, 0, 0),
    );
    const es = new EntitySystem(host);
    host.entities = es;
    es.spawn();
    const timer = new SurfTimer(host);
    timer.setZones([zone('start', -200, 200)], 'heuristic');
    const at = (x: number): void => {
      host.setPos(x, 0, 0);
      host.advance();
      es.tick();
      timer.tick();
    };
    at(0);
    at(300);
    expect(timer.getHud()).toMatchObject({ mapType: 'staged', stage: 1 });
    at(1050); // -> d2: stage 2
    expect(timer.getHud().stage).toBe(2);
    at(6050); // fail -> d2 again
    expect(timer.getHud().stage).toBe(2);
    at(7050); // -> d3
    expect(timer.getHud().stage).toBe(3);
    timer.restartStage();
    expect(host.player.origin.x).toBe(9000);
  });
});
