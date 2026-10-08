// surf_keep_momentum: teleports keep the speed. A map teleport that would stop the player (fails and stage
// transitions), a death and the timer's teletostart / checker zones give back the horizontal speed, pointed the way
// the player faces afterwards. Restarts the player asks for keep the stop; momentum runs are their own records style.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { momentumVelocity } from '../src/game/momentum';
import { courseKey, currentStyle, getPersonalBest, tickStyleText } from '../src/game/records';
import { loadedGame, makeTestMap, resetGlobals } from './gamecore_helpers';

const hspeed = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);

describe('momentum helpers', () => {
  it('momentumVelocity keeps the horizontal speed along the yaw and drops the vertical speed', () => {
    const v = momentumVelocity(v3(300, 400, -900), 90);
    expect(hspeed(v)).toBeCloseTo(500, 9);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo(500, 9);
    expect(v.z).toBe(0);
    const w = momentumVelocity(v3(1000, 0, 0), 225);
    expect(w.x).toBeCloseTo(-707.1068, 3);
    expect(w.y).toBeCloseTo(-707.1068, 3);
    expect(momentumVelocity(v3(NaN, 0, 0), 0)).toEqual(v3(0, 0, 0));
  });
});

describe('surf_keep_momentum in the game loop', () => {
  const setKeep = (v: string) => console_.getCvar('surf_keep_momentum')?.set(v);
  beforeEach(() => {
    resetGlobals();
    setKeep('1');
  });
  afterEach(() => setKeep('1'));

  // a fail teleport at x 600..664 back to (200, 0) facing +y; another one at y -600..-664 to a new place (-1500, 1500);
  // a lethal trigger_hurt at x -600..-664; the start zone is around the spawn (0, 0) facing +x.
  const map = () =>
    makeTestMap({
      models: {
        1: { mins: [600, -64, 0], maxs: [664, 64, 256] },
        2: { mins: [-64, -664, 0], maxs: [64, -600, 256] },
        3: { mins: [-664, -64, 0], maxs: [-600, 64, 256] },
      },
      entities: `
        { "classname" "trigger_teleport" "model" "*1" "target" "back" "spawnflags" "1" }
        { "classname" "info_teleport_destination" "targetname" "back" "origin" "200 0 0" "angles" "0 90 0" }
        { "classname" "trigger_teleport" "model" "*2" "target" "next" "spawnflags" "1" }
        { "classname" "info_teleport_destination" "targetname" "next" "origin" "-1500 1500 0" "angles" "0 180 0" }
        { "classname" "trigger_hurt" "model" "*3" "spawnflags" "1" "damage" "1000" }`,
    });

  /** Flies the player from `from` with `vel` until a teleport moves it (or 200 ticks pass). */
  function flyUntilTeleported(t: Awaited<ReturnType<typeof loadedGame>>, from: [number, number, number], vel: [number, number, number]) {
    const s = t.game.session!;
    // out of the start zone first (leaving it caps the speed to the prespeed), then the throw
    t.game.teleportPlayer(v3(...from), null, v3());
    t.game.runTicks(1);
    t.game.teleportPlayer(v3(...from), null, v3(...vel));
    let before = { ...s.player.velocity };
    for (let i = 0; i < 200; i++) {
      const o = { ...s.player.origin };
      before = { ...s.player.velocity };
      t.game.runTicks(1);
      const d = Math.hypot(s.player.origin.x - o.x, s.player.origin.y - o.y);
      if (d > 100) return { before, after: { ...s.player.velocity } };
    }
    throw new Error('never teleported');
  }

  it('a fail teleport back to where the player was keeps the speed, pointed the way the destination faces', async () => {
    const t = await loadedGame(map());
    const s = t.game.session!;
    const { before, after } = flyUntilTeleported(t, [300, 0, 64], [900, 0, 0]);
    expect(s.player.origin.x).toBeCloseTo(200, 0);
    expect(t.game.getViewAngles().yaw).toBeCloseTo(90, 6);
    expect(hspeed(after)).toBeGreaterThan(hspeed(before) - 1);
    expect(hspeed(after)).toBeLessThan(hspeed(before) + 1);
    expect(after.x).toBeCloseTo(0, 3);
    expect(after.y).toBeGreaterThan(890);
    expect(after.z).toBe(0);
  });

  it('surf_keep_momentum 0 keeps the stop (Source behaviour)', async () => {
    const t = await loadedGame(map());
    t.game.executeCommand('surf_keep_momentum 0');
    const { after } = flyUntilTeleported(t, [300, 0, 64], [900, 0, 0]);
    expect(after).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('a stage transition teleport (somewhere new) carries the speed into the next stage too', async () => {
    const t = await loadedGame(map());
    const s = t.game.session!;
    const { before, after } = flyUntilTeleported(t, [0, -300, 64], [0, -900, 0]);
    expect(s.player.origin.x).toBeCloseTo(-1500, 0);
    expect(hspeed(after)).toBeGreaterThan(hspeed(before) - 1);
    expect(after.x).toBeLessThan(-890); // the destination faces -x (yaw 180)
    expect(Math.abs(after.y)).toBeLessThan(1e-6);
  });

  it('a death respawns with the speed (facing the spawn direction); the start zone still caps it on the way out', async () => {
    const t = await loadedGame(map());
    const s = t.game.session!;
    const { before, after } = flyUntilTeleported(t, [-300, 0, 64], [-900, 0, 0]);
    // back in the start zone, moving the way the respawn faces
    expect(s.timer.getHud().state).toBe('startzone');
    const yaw = (t.game.getViewAngles().yaw * Math.PI) / 180;
    expect(hspeed(after)).toBeGreaterThan(hspeed(before) - 1);
    expect(after.x).toBeCloseTo(Math.cos(yaw) * hspeed(after), 6);
    expect(after.y).toBeCloseTo(Math.sin(yaw) * hspeed(after), 6);
    expect(after.z).toBe(0);
    // flying out of the start zone starts a run at the prespeed cap
    t.game.executeCommand('+jump');
    for (let i = 0; i < 40 && s.timer.getHud().state === 'startzone'; i++) t.game.runTicks(1);
    t.game.executeCommand('-jump');
    expect(s.timer.getHud().state).toBe('running');
    expect(hspeed(s.player.velocity)).toBeLessThanOrEqual(350 + 1e-6);
  });

  it('momentum runs are their own records style; the run stays ranked through teleports', async () => {
    const t = await loadedGame(map());
    const s = t.game.session!;
    expect(currentStyle()).toBe('momentum');
    expect(courseKey('surf_x', 0, 100)).toBe('surf_x|0|100m');
    expect(tickStyleText(100)).toBe('100 tick, momentum');
    t.game.teleportPlayer(v3(150, 0, 0), null, v3(250, 0, 0));
    t.game.runTicks(2);
    expect(s.timer.getHud().state).toBe('running');
    flyUntilTeleported(t, [400, 0, 64], [900, 0, 0]);
    expect(s.timer.getHud().state).toBe('running'); // still ranked
    // finish: the record is a momentum record, invisible to normal runs
    t.game.teleportPlayer(v3(1500, 0, 0), null, v3());
    t.game.runTicks(2);
    expect(s.timer.getHud().state).toBe('finished');
    expect(getPersonalBest('surf_gamecore_test', 0, 100)).not.toBeNull();
    t.game.executeCommand('surf_keep_momentum 0');
    expect(currentStyle()).toBe('');
    expect(courseKey('surf_x', 0, 100)).toBe('surf_x|0|100');
    expect(getPersonalBest('surf_gamecore_test', 0, 100)).toBeNull();
  });

  it('changing surf_keep_momentum mid-run puts the run in practice (it changes the records style)', async () => {
    const t = await loadedGame(map());
    const s = t.game.session!;
    t.game.teleportPlayer(v3(150, 0, 0), null, v3(250, 0, 0));
    t.game.runTicks(2);
    expect(s.timer.getHud().state).toBe('running');
    t.game.executeCommand('surf_keep_momentum 0');
    t.game.runTicks(1);
    expect(s.timer.getHud().state).toBe('practice');
  });

  it('!r and teleports the player asks for keep the stop', async () => {
    const t = await loadedGame(map());
    const s = t.game.session!;
    t.game.teleportPlayer(v3(300, 300, 64), null, v3(900, 0, 0));
    t.game.runTicks(1);
    t.game.say('!r');
    expect(s.player.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });
});
