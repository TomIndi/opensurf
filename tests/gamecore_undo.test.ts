// !undo / surf_undo (default bind G): an accidental !r (R next to T = !back) mid-run can be undone. !r keeps a
// snapshot of the run in progress; !undo puts the player, the view, the timer run (same clock: the time in between
// is like a pause), the trigger contacts and the replay recording back exactly, until a new run starts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { console_, cvar, execute } from '../src/core/cvars';
import { binds, DEFAULT_BINDS } from '../src/game/binds';
import { CHAT_COMMANDS } from '../src/game/commands';
import { registerConvars } from '../src/game/convars';
import type { Game, Session } from '../src/game/game';
import { FRAME_STRIDE, frameCount } from '../src/game/replay';
import { formatRunTime, type RunFinishEvent } from '../src/game/timer';
import { assignDeep, deepClone, runsUndo, UNDO_GRACE_SECONDS, undoKey } from '../src/game/undo';
import { brushFromBox } from '../src/physics/brushbuild';
import { playerHull } from '../src/physics/movement';
import { createPlayerState, MOVETYPE_LADDER } from '../src/physics/playertypes';
import { CONTENTS_LADDER, CONTENTS_SOLID, MASK_PLAYERSOLID } from '../src/physics/types';
import { ZoneDef } from '../src/map/types';
import { TestGame, loadedGame, makeTestMap, resetGlobals } from './gamecore_helpers';

const HINT = '[Surf] Restarted. Press G (or type !undo) to go back to your run.';
const NOTHING = '[Surf] Nothing to undo.';

let t: TestGame | null = null;

beforeEach(() => {
  registerConvars();
  resetGlobals();
});
afterEach(() => {
  t?.game.dispose();
  t = null;
  for (const c of console_.allCvars()) c.reset();
  execute('binddefaults');
});

function zone(type: ZoneDef['type'], index: number, x0: number, x1: number, group = 0): ZoneDef {
  return { type, group, index, mins: v3(x0, -256, 0), maxs: v3(x1, 256, 128) };
}

/** Linear: start, checkpoints at 500 / 900, end at 1400. */
const LINEAR_ZONES: ZoneDef[] = [
  { type: 'start', group: 0, index: 0, mins: v3(-128, -128, 0), maxs: v3(128, 128, 128) },
  zone('checkpoint', 1, 500, 600),
  zone('checkpoint', 2, 900, 1000),
  zone('end', 0, 1400, 1600),
];

/** Staged: start, stage 2 at 400, stage 3 at 800, end at 1400. */
const STAGED_ZONES: ZoneDef[] = [
  { type: 'start', group: 0, index: 0, mins: v3(-128, -128, 0), maxs: v3(128, 128, 128) },
  zone('stage', 2, 400, 600),
  zone('stage', 3, 800, 1000),
  zone('end', 0, 1400, 1600),
];

function runUntil(game: Game, pred: () => boolean, max = 5000): number {
  let n = 0;
  while (!pred() && n < max) {
    game.runTicks(1);
    n++;
  }
  if (!pred()) throw new Error(`condition not reached after ${max} ticks`);
  return n;
}

/** Everything !undo must bring back, as plain data. */
function runState(game: Game, s: Session) {
  return {
    player: structuredClone(s.player),
    view: game.getViewAngles(),
    hud: { ...s.timer.getHud() },
    stats: s.timer.getStats(),
    practice: s.timer.inPractice,
    group: s.group,
    frames: s.replay.recordedFrames,
    recording: s.replay.snapshotRecording(),
    targetname: s.entities.playerTargetname,
  };
}

/**
 * A ranked run on the linear map with jumps and strafes: past checkpoint 1, ducked and airborne, turning.
 * `atStart` runs in the start zone first.
 */
async function midRun(zones = LINEAR_ZONES, targetX = 700, atStart?: (game: Game) => void): Promise<{ game: Game; s: Session }> {
  t = await loadedGame(makeTestMap({ zones }));
  const game = t.game;
  const s = game.session!;
  atStart?.(game);
  game.executeCommand('+forward');
  runUntil(game, () => s.timer.getHud().state === 'running');
  // some jumps with air strafes (stats: jumps, strafes, sync)
  for (let i = 0; i < 2; i++) {
    game.dispatcher.tap('space');
    game.runTicks(1);
    game.executeCommand(i % 2 ? '+moveright' : '+moveleft');
    for (let k = 0; k < 6; k++) {
      const a = game.getViewAngles();
      game.setViewAngles(a.pitch, a.yaw + (i % 2 ? -0.4 : 0.4));
      game.runTicks(1);
    }
    game.executeCommand(i % 2 ? '-moveright' : '-moveleft');
    runUntil(game, () => s.player.onGround, 200);
  }
  game.setViewAngles(3, 0);
  runUntil(game, () => s.player.origin.x > targetX);
  // ducked and in the air when R is hit; map logic changed the player's gravity / speed
  game.executeCommand('+duck');
  game.dispatcher.tap('space');
  game.runTicks(12);
  s.player.gravityScale = 0.75;
  s.player.laggedMovement = 1.25;
  game.setViewAngles(-7.5, 12.25);
  game.executeCommand('-duck');
  game.executeCommand('-forward');
  return { game, s };
}

describe('!undo after an accidental !r', () => {
  it('puts a ranked run back exactly; it finishes ranked with the right time, record and complete replay', async () => {
    const { game, s } = await midRun();
    expect(s.timer.getHud().state).toBe('running');
    expect(s.player.ducked).toBe(true);
    expect(s.player.onGround).toBe(false);
    const before = runState(game, s);
    expect(before.hud.checkpoint).toBe(1);
    expect(before.stats.jumps).toBeGreaterThan(0);
    expect(before.stats.strafes).toBeGreaterThan(0);
    expect(before.frames).toBeGreaterThan(100);

    // R instead of T
    game.dispatcher.keyDown('r');
    game.dispatcher.keyUp('r');
    expect(t!.ui.lastText()).toBe(HINT);
    expect(s.timer.getHud().state).toBe('startzone');
    expect(s.player.origin.x).toBeLessThan(128);
    expect(s.entities.playerTargetname).toBe('');
    // time passes in the start zone (the run clock doesn't)
    game.runTicks(150);
    expect(s.timer.getHud().state).toBe('startzone');

    // G
    game.dispatcher.keyDown('g');
    game.dispatcher.keyUp('g');
    const back = runState(game, s);
    expect(back.player).toEqual(before.player);
    expect(back.view).toEqual(before.view);
    expect(back.hud).toEqual(before.hud);
    expect(back.stats).toEqual(before.stats);
    expect(back.practice).toBe(false);
    expect(back.frames).toBe(before.frames);
    expect(back.recording).toEqual(before.recording);
    // no interpolation smear from the start zone
    expect(s.prevOrigin).toEqual(s.player.origin);
    expect(s.prevViewOffset).toBe(s.player.viewOffsetZ);
    expect(t!.ui.lastText()).toBe(`[Surf] Back to your run: CP 1 · ${formatRunTime(before.hud.time)}`);

    // the run goes on from the same clock and finishes ranked
    const finished: RunFinishEvent[] = [];
    game.on('runfinished', (e) => finished.push(e as RunFinishEvent));
    game.setViewAngles(0, 0);
    game.executeCommand('+forward');
    let n = 0;
    let cp2At = -1;
    while (s.timer.getHud().state !== 'finished' && n < 3000) {
      game.runTicks(1);
      n++;
      if (cp2At < 0 && s.timer.getHud().checkpoint === 2) cp2At = n;
    }
    game.executeCommand('-forward');
    expect(finished).toHaveLength(1);
    const ev = finished[0];
    expect(ev.ranked).toBe(true);
    expect(ev.isPb).toBe(true);
    // total = time before the restart + time after the undo
    expect(ev.time).toBeCloseTo(before.hud.time + n * 0.01, 9);
    const rec = s.timer.getRecords(0)[0];
    expect(rec.time).toBe(ev.time);
    expect(rec.checkpointSplits[1]).toBeCloseTo(before.hud.lastSplitTime, 9);
    expect(rec.checkpointSplits[2]).toBeCloseTo(before.hud.time + cp2At * 0.01, 9);
    expect(rec.jumps).toBeGreaterThanOrEqual(before.stats.jumps);
    // the saved replay is the whole run: the frames from before the restart, then the rest
    const pb = s.replay.getPb(0)!;
    expect(pb).not.toBeNull();
    expect(frameCount(pb)).toBe(before.frames + n - 1);
    expect(pb.frames.slice(0, before.frames * FRAME_STRIDE)).toEqual(before.recording!.frames);
    expect(Math.abs(frameCount(pb) - pb.time / 0.01)).toBeLessThanOrEqual(1);
  });

  it('is gone once a new run started; one "Nothing to undo." line per try', async () => {
    const { game, s } = await midRun();
    game.say('!r');
    expect(t!.ui.lastText()).toBe(HINT);
    game.executeCommand('+forward');
    runUntil(game, () => s.timer.getHud().state === 'running');
    game.runTicks(20);
    game.executeCommand('-forward');
    const hud = { ...s.timer.getHud() };
    const lines = t!.ui.chats.length;
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(NOTHING);
    expect(t!.ui.chats.length).toBe(lines + 2); // the echoed "!undo" and the answer
    expect(s.timer.getHud()).toEqual(hud); // the new run is untouched
    game.say('/undo');
    expect(t!.ui.lastText()).toBe(NOTHING);
    expect(t!.ui.chats.length).toBe(lines + 3);
  });

  it('one undo per restart; a second R in the start zone keeps the first run; another !r mid-run replaces it', async () => {
    const { game, s } = await midRun();
    const first = runState(game, s);
    game.say('!r');
    const hints = () => t!.ui.texts().filter((l) => l === HINT).length;
    expect(hints()).toBe(1);
    game.runTicks(10);
    game.say('!r'); // pressed twice: nothing in progress to keep, the first run stays undoable
    expect(hints()).toBe(1);
    game.say('!restart');
    game.say('!start');
    execute('sm_r');
    expect(hints()).toBe(1);
    execute('surf_undo');
    expect(runState(game, s).hud).toEqual(first.hud);
    expect(s.player).toEqual(first.player);
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(NOTHING); // used up

    // further into the same run, R again: the newer state is what comes back
    game.executeCommand('+forward');
    game.runTicks(50);
    game.executeCommand('-forward');
    const second = runState(game, s);
    expect(second.hud.time).toBeGreaterThan(first.hud.time);
    game.say('!r');
    game.say('!unrestart');
    expect(runState(game, s).hud).toEqual(second.hud);
    expect(s.player).toEqual(second.player);
  });

  it('only !r keeps a snapshot: !back, !s, !b, !tele and kill do not', async () => {
    const bonus: ZoneDef = { type: 'start', group: 1, index: 0, mins: v3(-128, 1000, 0), maxs: v3(128, 1200, 128) };
    const { game, s } = await midRun([...LINEAR_ZONES, bonus]);
    game.say('!back'); // (linear map: back to the start)
    expect(s.timer.getHud().state).toBe('startzone');
    expect(t!.ui.texts()).not.toContain(HINT);
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(NOTHING);

    for (const cmd of ['!s 1', '!b 1', 'kill']) {
      game.executeCommand('+forward');
      runUntil(game, () => s.timer.getHud().state === 'running');
      game.runTicks(30);
      game.executeCommand('-forward');
      expect(s.timer.getHud().time).toBeGreaterThan(0.2);
      if (cmd === 'kill') execute('kill');
      else game.say(cmd);
      expect(s.timer.getHud().state).toBe('startzone');
      expect(t!.ui.texts()).not.toContain(HINT);
      game.say('!undo');
      expect(t!.ui.lastText()).toBe(NOTHING);
    }
    game.say('!saveloc');
    game.executeCommand('+forward');
    runUntil(game, () => s.timer.getHud().state === 'running');
    game.runTicks(30);
    game.executeCommand('-forward');
    game.say('!tele');
    expect(t!.ui.texts()).not.toContain(HINT);
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(NOTHING);
  });

  it('keeps nothing without a run in progress (start zone, finished, stopped)', async () => {
    t = await loadedGame(makeTestMap({ zones: LINEAR_ZONES }));
    const game = t.game;
    const s = game.session!;
    game.say('!r');
    expect(t.ui.texts()).not.toContain(HINT);
    game.executeCommand('+forward');
    runUntil(game, () => s.timer.getHud().state === 'finished');
    game.executeCommand('-forward');
    game.say('!r');
    expect(t.ui.texts()).not.toContain(HINT);
    game.say('!undo');
    expect(t.ui.lastText()).toBe(NOTHING);
    // no map: still one short line
    game.disconnect();
    game.say('!undo');
    expect(t.ui.lastText()).toBe(NOTHING);
  });

  it('a practice run comes back as practice and finishes unsaved', async () => {
    t = await loadedGame(makeTestMap({ zones: LINEAR_ZONES }));
    const game = t.game;
    const s = game.session!;
    game.say('!prac');
    game.executeCommand('+forward');
    runUntil(game, () => s.timer.getHud().state === 'practice');
    game.runTicks(150);
    game.executeCommand('-forward');
    const before = runState(game, s);
    expect(before.practice).toBe(true);
    expect(before.hud.time).toBeGreaterThan(1);
    game.say('!r');
    expect(t.ui.lastText()).toBe(HINT);
    expect(s.timer.inPractice).toBe(false);
    game.runTicks(30);
    game.say('!undo');
    expect(t.ui.lastText()).toContain('(practice)');
    const back = runState(game, s);
    expect(back.hud).toEqual(before.hud);
    expect(back.practice).toBe(true);
    expect(back.player).toEqual(before.player);
    expect(back.frames).toBe(0); // practice isn't recorded
    game.executeCommand('+forward');
    const n = runUntil(game, () => s.timer.getHud().state === 'finished');
    game.executeCommand('-forward');
    expect(s.timer.getHud().time).toBeCloseTo(before.hud.time + n * 0.01, 9);
    expect(t.ui.texts().some((l) => l.includes('(practice — not saved)'))).toBe(true);
    expect(s.timer.getRecords(0)).toHaveLength(0);
  });

  it('a ranked run comes back as practice when a server cvar changed after the restart', async () => {
    const { game, s } = await midRun();
    game.say('!r');
    cvar('sv_airaccelerate').set(1000);
    cvar('sv_airaccelerate').set(150);
    game.say('!undo');
    expect(s.timer.inPractice).toBe(true);
    expect(s.timer.getHud().state).toBe('practice');
    expect(s.replay.recording).toBe(false);
  });

  it('staged map: the stage, its clock and the splits come back; the stage and the run finish right', async () => {
    const { game, s } = await midRun(STAGED_ZONES, 700);
    const before = runState(game, s);
    expect(before.hud.mapType).toBe('staged');
    expect(before.hud.stage).toBe(2);
    expect(before.hud.stageTime).toBeGreaterThan(0.2);
    game.say('!r');
    expect(s.timer.getHud().stage).toBe(1);
    game.runTicks(40);
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(`[Surf] Back to your run: Stage 2 · ${formatRunTime(before.hud.time)}`);
    expect(runState(game, s).hud).toEqual(before.hud);
    // !back now goes to stage 2's start (the restored stage)
    // on to stage 3: stage 2's own time counts the time before the restart
    game.setViewAngles(0, 0);
    game.executeCommand('+forward');
    const n = runUntil(game, () => s.timer.getHud().stage === 3);
    const stage2 = before.hud.stageTime + n * 0.01;
    expect(t!.ui.texts().some((l) => l.includes(`finished Stage 2 in ${formatRunTime(stage2)}`))).toBe(true);
    const at3 = s.timer.getHud().time;
    expect(at3).toBeCloseTo(before.hud.time + n * 0.01, 9);
    runUntil(game, () => s.timer.getHud().state === 'finished');
    game.executeCommand('-forward');
    const rec = s.timer.getRecords(0)[0];
    expect(rec).toBeDefined();
    expect(rec.stageSplits[2]).toBeCloseTo(before.hud.lastSplitTime, 9);
    expect(rec.stageSplits[3]).toBeCloseTo(at3, 9);
  });

  it('!back after an undo goes to the restored stage', async () => {
    const { game, s } = await midRun(STAGED_ZONES, 700);
    game.say('!r');
    game.say('!undo');
    game.say('!back');
    expect(s.timer.getHud().stage).toBe(2);
    expect(s.player.origin.x).toBeGreaterThan(400);
    expect(s.player.origin.x).toBeLessThan(600);
  });

  it('stage practice (!s N) comes back, timing the same stage', async () => {
    t = await loadedGame(makeTestMap({ zones: STAGED_ZONES }));
    const game = t.game;
    const s = game.session!;
    game.say('!s 2');
    expect(s.timer.getHud().state).toBe('practice');
    // still waiting in the stage's zone (clock at 0): that is stage practice too
    game.say('!r');
    expect(t.ui.lastText()).toBe(HINT);
    game.say('!undo');
    expect(s.timer.getHud()).toMatchObject({ state: 'practice', stage: 2, time: 0 });
    expect(s.player.origin.x).toBeGreaterThan(400);

    game.setViewAngles(0, 0);
    game.executeCommand('+forward');
    runUntil(game, () => s.player.origin.x > 700);
    game.executeCommand('-forward');
    const before = runState(game, s);
    expect(before.hud.time).toBeGreaterThan(0.1);
    game.say('!r');
    game.runTicks(25);
    game.say('!undo');
    expect(runState(game, s).hud).toEqual(before.hud);
    expect(s.timer.inPractice).toBe(true);
    game.executeCommand('+forward');
    const n = runUntil(game, () => s.timer.getHud().stage === 3);
    game.executeCommand('-forward');
    expect(t.ui.texts().some((l) => l.includes(`finished Stage 2 in ${formatRunTime(before.hud.time + n * 0.01)}`))).toBe(true);
  });

  it('!s N stage practice started after the restart makes the undo stale', async () => {
    const { game } = await midRun(STAGED_ZONES, 700);
    game.say('!r');
    game.say('!s 3');
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(NOTHING);
  });

  it('a bonus run comes back on its course', async () => {
    const bonus: ZoneDef = { type: 'start', group: 1, index: 0, mins: v3(-128, 1000, 0), maxs: v3(128, 1200, 128) };
    t = await loadedGame(makeTestMap({ zones: [...LINEAR_ZONES, bonus] }));
    const game = t.game;
    const s = game.session!;
    game.say('!b 1');
    game.setViewAngles(0, 0);
    game.executeCommand('+forward');
    runUntil(game, () => s.timer.getHud().state === 'running');
    game.runTicks(60);
    game.executeCommand('-forward');
    const before = runState(game, s);
    expect(before.group).toBe(1);
    expect(before.frames).toBeGreaterThan(50);
    game.say('!r');
    expect(s.group).toBe(0);
    game.say('!undo');
    expect(t.ui.lastText()).toBe(`[Surf] Back to your run: Bonus 1 · ${formatRunTime(before.hud.time)}`);
    const back = runState(game, s);
    expect(back.group).toBe(1);
    expect(back.hud).toEqual(before.hud);
    expect(back.recording).toEqual(before.recording);
  });

  it('a map change ends it', async () => {
    const { game } = await midRun();
    game.say('!r');
    await game.loadBuiltinMap('test');
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(NOTHING);
  });

  it('a zone change ends it', async () => {
    const { game, s } = await midRun();
    game.say('!r');
    s.timer.setZones(LINEAR_ZONES, 'user');
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(NOTHING);
  });

  it('while watching the PB replay: !r just leaves it; !undo leaves it without the respawn', async () => {
    t = await loadedGame(makeTestMap({ zones: LINEAR_ZONES }));
    const game = t.game;
    const s = game.session!;
    game.executeCommand('+forward');
    runUntil(game, () => s.timer.getHud().state === 'finished');
    game.say('!r');
    runUntil(game, () => s.timer.getHud().state === 'running');
    game.runTicks(100);
    game.executeCommand('-forward');
    const before = runState(game, s);
    game.say('!r');
    game.say('!replay');
    expect(game.spectating).toBe(true);
    game.say('!undo');
    expect(game.spectating).toBe(false);
    expect(runState(game, s).hud).toEqual(before.hud);
    expect(s.player).toEqual(before.player);
    // and !r while spectating doesn't take a snapshot
    game.say('!replay');
    const hints = t.ui.texts().filter((l) => l === HINT).length;
    game.say('!r');
    expect(game.spectating).toBe(false);
    expect(t.ui.texts().filter((l) => l === HINT).length).toBe(hints);
  });

  it('trigger contacts come back without StartTouch / EndTouch; the map-logic name too', async () => {
    const map = makeTestMap({
      zones: LINEAR_ZONES,
      models: { 1: { mins: [300, -512, 0], maxs: [1100, 512, 200] } },
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1"
          "OnStartTouch" "starts,Add,1,0,-1" "OnEndTouch" "ends,Add,1,0,-1"
          "OnTrigger" "!activator,AddOutput,targetname runner,0,-1" }
        { "classname" "math_counter" "targetname" "starts" }
        { "classname" "math_counter" "targetname" "ends" }`,
    });
    t = await loadedGame(map);
    const game = t.game;
    const s = game.session!;
    const ents = s.entities as typeof s.entities & { counterValue(n: string): number | null };
    game.executeCommand('+forward');
    runUntil(game, () => s.player.origin.x > 600);
    game.executeCommand('-forward');
    game.runTicks(2);
    expect(ents.counterValue('starts')).toBe(1);
    expect(ents.counterValue('ends')).toBe(0);
    expect(s.entities.playerTargetname).toBe('runner');
    const before = runState(game, s);
    game.say('!r');
    expect(s.entities.playerTargetname).toBe('');
    game.runTicks(20);
    game.say('!undo');
    expect(s.entities.playerTargetname).toBe('runner');
    expect(s.player).toEqual(before.player);
    game.runTicks(5);
    expect(ents.counterValue('starts')).toBe(1); // still inside: no new StartTouch
    expect(ents.counterValue('ends')).toBe(0);
    game.executeCommand('+forward');
    runUntil(game, () => s.player.origin.x > 1150);
    game.executeCommand('-forward');
    expect(ents.counterValue('starts')).toBe(1);
    expect(ents.counterValue('ends')).toBe(1); // the natural EndTouch when leaving it
  });
});

/** Goes on to the end zone (after an undo); the runfinished events. */
function finishRun(game: Game, s: Session): RunFinishEvent[] {
  const finished: RunFinishEvent[] = [];
  game.on('runfinished', (e) => finished.push(e as RunFinishEvent));
  game.setViewAngles(0, 0);
  game.executeCommand('+forward');
  runUntil(game, () => s.timer.getHud().state === 'finished');
  game.executeCommand('-forward');
  return finished;
}

interface PracticeRoute {
  name: string;
  /** In the start zone before the run (a saveloc doesn't make the run practice). */
  atStart?: (game: Game) => void;
  /** During the run, before the R. */
  before?: (game: Game) => void;
  /** Between the R and the G. */
  during: (game: Game, s: Session) => void;
  reason: string;
}

const PRACTICE_ROUTES: PracticeRoute[] = [
  {
    name: '!noclip on and off in the start zone',
    during: (game) => {
      game.say('!noclip');
      game.runTicks(20);
      game.say('!noclip');
    },
    reason: 'noclip',
  },
  {
    name: 'console noclip flying ahead, then kill',
    during: (game) => {
      execute('noclip');
      game.setViewAngles(0, 0);
      game.executeCommand('+forward');
      game.runTicks(60);
      game.executeCommand('-forward');
      execute('noclip');
      execute('kill');
    },
    reason: 'noclip',
  },
  {
    name: '!end, then kill',
    during: (game) => {
      game.say('!end');
      execute('kill');
    },
    reason: 'end',
  },
  {
    // (!end leaves the start zone without starting a run, so the !tele attempts don't start one either)
    name: '!end, three !tele to a saveloc of the run, then kill',
    before: (game) => game.say('!saveloc'),
    during: (game) => {
      game.say('!end');
      for (let i = 0; i < 3; i++) {
        game.say('!tele');
        game.runTicks(30);
      }
      execute('kill');
    },
    reason: 'end',
  },
  {
    name: '!tele to a saveloc in the start zone',
    atStart: (game) => game.say('!saveloc'),
    during: (game) => {
      game.say('!tele');
      game.runTicks(10);
    },
    reason: 'saveloc',
  },
  {
    name: 'setpos_exact in the start zone',
    during: (game) => {
      execute('setpos_exact 60 40 0');
      game.runTicks(10);
    },
    reason: 'setpos',
  },
  {
    name: '!prac in the start zone',
    during: (game) => {
      game.say('!prac');
      game.runTicks(10);
    },
    reason: '!prac',
  },
];

describe('!undo: the map keeps running while restarted', () => {
  it.each(PRACTICE_ROUTES)('practice in between ($name) brings a ranked run back as practice', async (route) => {
    const { game, s } = await midRun(LINEAR_ZONES, 700, route.atStart);
    route.before?.(game);
    const before = runState(game, s);
    expect(before.practice).toBe(false);
    game.say('!r');
    expect(t!.ui.lastText()).toBe(HINT);
    route.during(game, s);
    // (a kill or the start zone ends practice by itself: the run must still come back as practice)
    expect(s.timer.getHud().state).not.toBe('running');
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(`[Surf] Back to your run: CP 1 · ${formatRunTime(before.hud.time)} (practice)`);
    expect(t!.ui.texts().some((l) => l.includes(`Practice mode (${route.reason})`))).toBe(true);
    const back = runState(game, s);
    expect(back.practice).toBe(true);
    expect(back.hud.state).toBe('practice');
    expect(back.hud.time).toBe(before.hud.time);
    expect(back.player).toEqual(before.player);
    expect(s.replay.recording).toBe(false);
    const finished = finishRun(game, s);
    expect(finished).toHaveLength(1);
    expect(finished[0].ranked).toBe(false);
    expect(t!.ui.texts().some((l) => l.includes('(practice — not saved)'))).toBe(true);
    expect(s.timer.getRecords(0)).toHaveLength(0);
    expect(s.replay.getPb(0)).toBeNull();
  });

  it('!tele out of the start zone starts a practice run: nothing to undo then', async () => {
    const { game, s } = await midRun();
    game.say('!saveloc');
    game.say('!r');
    game.say('!tele');
    game.runTicks(5);
    expect(s.timer.getHud().state).toBe('practice');
    game.say('!undo');
    expect(t!.ui.lastText()).toBe(NOTHING);
  });

  it(`a ranked run stays ranked only within ${UNDO_GRACE_SECONDS} s restarted, counted over all its undos`, async () => {
    const { game, s } = await midRun();
    const before = runState(game, s);
    game.say('!r');
    game.runTicks(UNDO_GRACE_SECONDS * 100 - 100); // 4 s: in time
    game.say('!undo');
    expect(s.timer.inPractice).toBe(false);
    expect(s.timer.getHud().state).toBe('running');
    expect(s.timer.getHud().time).toBe(before.hud.time);
    expect(s.replay.recording).toBe(true);
    game.say('!r');
    game.runTicks(150); // 1.5 s more: 5.5 s for this run
    game.say('!undo');
    expect(t!.ui.texts().some((l) => l.includes('Practice mode (restarted for 5.5 s)'))).toBe(true);
    expect(t!.ui.lastText()).toBe(`[Surf] Back to your run: CP 1 · ${formatRunTime(before.hud.time)} (practice)`);
    expect(s.timer.inPractice).toBe(true);
    expect(s.player).toEqual(before.player);
    expect(s.replay.recording).toBe(false);
    expect(finishRun(game, s)[0].ranked).toBe(false);
    expect(s.timer.getRecords(0)).toHaveLength(0);

    // the next run has its own allowance
    game.say('!r');
    game.executeCommand('+forward');
    runUntil(game, () => s.timer.getHud().state === 'running');
    game.runTicks(40);
    game.executeCommand('-forward');
    game.say('!r');
    game.runTicks(300);
    game.say('!undo');
    expect(s.timer.getHud().state).toBe('running');
    expect(finishRun(game, s)[0].ranked).toBe(true);
    expect(s.timer.getRecords(0)).toHaveLength(1);
  });

  it('a long wait in one go brings stage practice back as plain practice (no stage time)', async () => {
    t = await loadedGame(makeTestMap({ zones: STAGED_ZONES }));
    const game = t.game;
    const s = game.session!;
    game.say('!s 2');
    game.setViewAngles(0, 0);
    game.executeCommand('+forward');
    runUntil(game, () => s.player.origin.x > 700);
    game.executeCommand('-forward');
    const before = runState(game, s);
    game.say('!r');
    game.runTicks(UNDO_GRACE_SECONDS * 100 + 100);
    game.say('!undo');
    expect(t.ui.texts().some((l) => l.includes(`Practice mode (restarted for ${(UNDO_GRACE_SECONDS + 1).toFixed(1)} s)`))).toBe(true);
    expect(s.timer.getHud()).toMatchObject({ state: 'practice', time: before.hud.time });
    expect(s.player).toEqual(before.player);
    game.executeCommand('+forward');
    runUntil(game, () => s.player.origin.x > 1100);
    game.executeCommand('-forward');
    expect(t.ui.texts().some((l) => l.includes('finished Stage 2'))).toBe(false);
  });

  /** Linear map with a func_door platform (x 250..450, y -100..100, 16 high) that slides 400 units along +y at 100 u/s. */
  async function onPlatform(): Promise<{ game: Game; s: Session }> {
    t = await loadedGame(
      makeTestMap({
        zones: LINEAR_ZONES,
        extra: [brushFromBox(v3(250, -100, 0), v3(450, 100, 16), CONTENTS_SOLID, 1)],
        models: { 1: { mins: [250, -100, 0], maxs: [450, 100, 16] } },
        entities: `{ "classname" "func_door" "targetname" "plat" "model" "*1" "origin" "350 0 8" "movedir" "0 90 0" "speed" "100" "wait" "-1" "lip" "-200" }`,
      }),
    );
    const game = t.game;
    const s = game.session!;
    game.setViewAngles(0, 0);
    game.executeCommand('+forward');
    runUntil(game, () => s.player.origin.x > 300);
    game.executeCommand('-forward');
    game.runTicks(80);
    expect(s.timer.getHud().state).toBe('running');
    expect(s.player.onGround).toBe(true);
    expect(s.player.groundModel).toBe(1);
    return { game, s };
  }

  it('standing on a platform that has not moved: back on it exactly', async () => {
    const { game, s } = await onPlatform();
    const before = runState(game, s);
    game.say('!r');
    game.runTicks(100);
    game.say('!undo');
    expect(s.player).toEqual(before.player);
    game.runTicks(5);
    expect(s.player.onGround).toBe(true);
    expect(s.player.groundModel).toBe(1);
  });

  it('riding a platform that moved on meanwhile: let go of it, with its speed of the moment', async () => {
    const { game, s } = await onPlatform();
    s.entities.fireInput!('plat', 'Open');
    game.runTicks(30);
    expect(s.player.groundModel).toBe(1);
    const y0 = s.player.origin.y;
    expect(y0).toBeGreaterThan(20); // carried
    const before = runState(game, s);
    game.say('!r');
    game.runTicks(420); // the platform got to its end and stopped
    game.say('!undo');
    const ps = s.player;
    expect(ps.origin).toEqual(before.player.origin);
    expect(ps.velocity).toEqual(before.player.velocity);
    expect(ps.onGround).toBe(false);
    expect(ps.groundModel).toBe(-1);
    expect(ps.baseVelocity.x).toBeCloseTo(0, 6);
    expect(ps.baseVelocity.y).toBeCloseTo(100, 6);
    expect(s.timer.getHud().state).toBe('running');
    // not carried by the platform's position now: off the edge with the platform's speed, onto the floor
    game.runTicks(1);
    expect(ps.origin.y).toBeGreaterThan(y0 + 0.5);
    expect(ps.origin.y).toBeLessThan(y0 + 2);
    game.runTicks(40);
    expect(ps.origin.z).toBeCloseTo(1 / 32, 9);
    expect(ps.onGround).toBe(true);
    expect(ps.origin.y).toBeGreaterThan(y0 + 15);
  });

  it('hanging on a ladder: back on it, still hanging with no input', async () => {
    t = await loadedGame(
      makeTestMap({
        zones: LINEAR_ZONES,
        extra: [brushFromBox(v3(304, -500, 0), v3(400, 500, 1000), CONTENTS_SOLID, 0), brushFromBox(v3(300, -32, 0), v3(304, 32, 600), CONTENTS_LADDER, 0)],
      }),
    );
    const game = t.game;
    const s = game.session!;
    game.setViewAngles(0, 0);
    game.executeCommand('+forward');
    runUntil(game, () => s.player.origin.z > 150);
    game.executeCommand('-forward');
    game.runTicks(20);
    expect(s.player.moveType).toBe(MOVETYPE_LADDER);
    expect(s.timer.getHud().state).toBe('running');
    const before = runState(game, s);
    game.say('!r');
    game.runTicks(50);
    game.say('!undo');
    expect(s.player).toEqual(before.player);
    game.runTicks(30);
    expect(s.player.moveType).toBe(MOVETYPE_LADDER);
    expect(s.player.origin.z).toBe(before.player.origin.z);
  });

  it('a wall that appeared at the spot meanwhile: out of it, not stuck inside', async () => {
    t = await loadedGame(
      makeTestMap({
        zones: LINEAR_ZONES,
        extra: [brushFromBox(v3(200, -200, 0), v3(800, 200, 4), CONTENTS_SOLID, 1)],
        models: { 1: { mins: [200, -200, 0], maxs: [800, 200, 4] } },
        entities: `{ "classname" "func_brush" "targetname" "slab" "model" "*1" "StartDisabled" "1" "solidity" "0" }`,
      }),
    );
    const game = t.game;
    const s = game.session!;
    const inSolid = () => {
      const h = playerHull(s.player);
      return s.collision.testBox(s.player.origin, h.mins, h.maxs, MASK_PLAYERSOLID);
    };
    game.setViewAngles(0, 0);
    game.executeCommand('+forward');
    runUntil(game, () => s.player.origin.x > 350);
    game.executeCommand('-forward');
    game.runTicks(80);
    expect(s.player.origin.z).toBe(1 / 32);
    expect(inSolid()).toBe(false);
    const before = runState(game, s);
    game.say('!r');
    s.entities.fireInput!('slab', 'Enable');
    game.runTicks(5);
    game.say('!undo');
    expect(inSolid()).toBe(false);
    expect(s.player.origin.z).toBeGreaterThanOrEqual(4);
    expect(s.player.origin.z).toBeLessThan(6);
    expect(s.player.origin.x).toBeCloseTo(before.player.origin.x, 6);
    expect(s.player.origin.y).toBeCloseTo(before.player.origin.y, 6);
    expect(s.prevOrigin).toEqual(s.player.origin);
    expect(s.timer.getHud().state).toBe('running');
  });
});

describe('snapshot helpers', () => {
  it('deepClone copies deeply; assignDeep copies back in place (references to nested vectors stay valid)', () => {
    const ps = createPlayerState(v3(1, 2, 3), { pitch: 4, yaw: 5, roll: 0 });
    ps.velocity.x = 300;
    const origin = ps.origin;
    const snap = deepClone(ps);
    expect(snap).toEqual(ps);
    expect(snap.origin).not.toBe(ps.origin);
    ps.origin.x = 99;
    ps.velocity.y = 5;
    ps.ducked = true;
    ps.viewAngles.yaw = 90;
    assignDeep(ps, snap);
    expect(ps).toEqual(snap);
    expect(ps.origin).toBe(origin);
    snap.origin.x = 7;
    expect(ps.origin.x).toBe(1);
    const m = deepClone({ a: new Map([[1, { x: 1 }]]), s: new Set([2]), f: new Float32Array([1, 2]) });
    expect(m.a.get(1)).toEqual({ x: 1 });
    expect(m.s.has(2)).toBe(true);
    expect([...m.f]).toEqual([1, 2]);
  });
});

describe('undo bind and hints', () => {
  it('G is bound to !undo by default; the hint names the key actually bound', async () => {
    expect(DEFAULT_BINDS.g).toBe('say !undo');
    expect(binds.get('g')).toBe('say !undo');
    expect(undoKey()).toBe('g');
    expect(runsUndo('say !undo')).toBe(true);
    expect(runsUndo('say "/undorestart"')).toBe(true);
    expect(runsUndo('echo hi; surf_undo')).toBe(true);
    expect(runsUndo('sm_unrestart')).toBe(true);
    expect(runsUndo('say !r')).toBe(false);
    expect(runsUndo('say !undo please')).toBe(false);

    const { game } = await midRun();
    execute('unbind g');
    execute('bind h "say !undo"');
    game.say('!r');
    expect(t!.ui.lastText()).toBe('[Surf] Restarted. Press H (or type !undo) to go back to your run.');
    game.say('!undo');
    execute('unbind h');
    execute('alias myundo "say /undo"');
    execute('bind mouse4 myundo');
    game.say('!r');
    expect(t!.ui.lastText()).toBe('[Surf] Restarted. Press MOUSE4 (or type !undo) to go back to your run.');
    game.say('!undo');
    execute('unbind mouse4');
    execute('alias myundo ""');
    game.say('!r');
    expect(t!.ui.lastText()).toBe('[Surf] Restarted. Type !undo to go back to your run.');
  });

  it('!help, sm_undo and the chat command list know it', async () => {
    t = await loadedGame();
    t.game.say('!help');
    expect(t.ui.texts().some((l) => l.includes('!undo undo !r'))).toBe(true);
    const cmd = CHAT_COMMANDS.find((c) => c.names.includes('undo'))!;
    expect(cmd.names).toEqual(['undo', 'undorestart', 'unrestart']);
    for (const n of ['surf_undo', 'sm_undo', 'sm_undorestart', 'sm_unrestart']) expect(console_.hasCommand(n), n).toBe(true);
    execute('sm_undo');
    expect(t.ui.lastText()).toBe(NOTHING);
  });
});
