// Moving brush entities (func_rotating, func_door[_rotating], func_movelinear, momentary_rot_button, trains on
// path_track), the entity hierarchy (parentname / SetParent / ClearParent) and Source pusher semantics for the
// player (riders carried, pushed players, blocked movers, crushing, ground velocity).
import { describe, expect, it } from 'vitest';
import { QAngle, angleVectors, qa } from '../src/core/angles';
import { Vec3, v3 } from '../src/core/vec3';
import { EntitySystem } from '../src/game/entities';
import { anglemod, lerpPose, movableEntitySets, Pose } from '../src/game/movers';
import { parseEntities } from '../src/bsp/entities';
import { categorizePosition, playerHull, playerMove } from '../src/physics/movement';
import { IN_JUMP, MoveEvents, newMoveEvents, newUserCmd, UserCmd } from '../src/physics/playertypes';
import { MASK_PLAYERSOLID } from '../src/physics/types';
import { MapSpec, MockHost, MockRenderer, applyBaseVelocity } from './gameworld_host';

type V3 = [number, number, number];
const FLOOR = { mins: [-8000, -8000, -64] as V3, maxs: [8000, 8000, 0] as V3, solid: true };

/** A renderer that records mover placements. */
class TransformRenderer extends MockRenderer {
  models = new Map<number, { origin: Vec3; angles: QAngle }>();
  ents = new Map<number, { origin: Vec3; angles: QAngle }>();
  setModelTransform(model: number, origin: Vec3, angles: QAngle): void {
    this.models.set(model, { origin: { ...origin }, angles: { ...angles } });
  }
  setEntityTransform(entity: number, origin: Vec3, angles: QAngle): void {
    this.ents.set(entity, { origin: { ...origin }, angles: { ...angles } });
  }
}

interface World {
  host: MockHost;
  ents: EntitySystem;
  r: TransformRenderer;
  ev: MoveEvents;
}

/** Players start 1/32 above the given height, where movement leaves them resting on a surface (touching counts as solid). */
const REST = 1 / 32;

function setup(spec: MapSpec, player: V3 = [5000, 5000, 0]): World {
  const host = new MockHost({ ...spec, world: [FLOOR, ...(spec.world ?? [])] }, v3(player[0], player[1], player[2] + REST));
  const r = new TransformRenderer();
  host.renderer = r;
  const ents = new EntitySystem(host);
  host.entities = ents;
  ents.spawn();
  categorizePosition(host.player, host.collision, host.moveVars);
  return { host, ents, r, ev: newMoveEvents() };
}

/** One game tick in the core's order: movers, base velocity, playerMove (+ ground velocity), entities. */
function tick(w: World, cmd: UserCmd = newUserCmd()): void {
  const { host, ents } = w;
  host.advance();
  ents.tickMovers();
  applyBaseVelocity(host.player, host.tickInterval);
  cmd.viewangles = { ...host.player.viewAngles };
  const wasOn = host.player.onGround;
  const wasGround = host.player.groundModel;
  playerMove(host.player, cmd, host.collision, host.moveVars, host.tickInterval, w.ev);
  ents.afterPlayerMove(wasOn, wasGround);
  ents.tick();
}

function run(w: World, seconds: number, cmd?: () => UserCmd): void {
  const n = Math.round(seconds / w.host.tickInterval);
  for (let i = 0; i < n; i++) tick(w, cmd ? cmd() : newUserCmd());
}

function inSolid(w: World): boolean {
  const h = playerHull(w.host.player);
  return w.host.collision.testBox(w.host.player.origin, h.mins, h.maxs, MASK_PLAYERSOLID);
}

const COUNTER = `{ "classname" "math_counter" "targetname" "count" "min" "0" "max" "100000" }`;

// ------------------------------------------------------------------------------------------ func_rotating

describe('func_rotating', () => {
  const BAR = { 1: { mins: [-100, -8, 0] as V3, maxs: [100, 8, 16] as V3, solid: true } };

  it('spins at maxspeed about Z when started on, and its brushes collide where it is', () => {
    const w = setup({
      entities: `{ "classname" "func_rotating" "targetname" "rot" "model" "*1" "origin" "0 0 8" "spawnflags" "1" "maxspeed" "90" }`,
      models: BAR,
    });
    run(w, 1);
    const st = w.ents.moverState('rot')!;
    expect(st.speed).toBe(90);
    expect(anglemod(st.angles.yaw)).toBeCloseTo(90, 6);
    // the bar now lies along y
    const c = w.host.collision;
    const down = (x: number, y: number) => c.traceRay(v3(x, y, 100), v3(x, y, 1), MASK_PLAYERSOLID).fraction;
    expect(down(0, 60)).toBeLessThan(1);
    expect(down(60, 0)).toBe(1);
    // the renderer got the placement
    expect(anglemod(w.r.models.get(1) ? 0 : 0)).toBe(0);
    w.ents.applyRenderTransforms(1);
    expect(anglemod(w.r.models.get(1)!.angles.yaw)).toBeCloseTo(90, 6);
  });

  it('ramps with Acc/Dcc by maxspeed * fanfriction% per tenth of a second, both ways', () => {
    const w = setup({
      entities: `{ "classname" "func_rotating" "targetname" "rot" "model" "*1" "origin" "0 0 8" "spawnflags" "17" "maxspeed" "100" "fanfriction" "10" }`,
      models: BAR,
    });
    run(w, 0.5);
    expect(w.ents.moverState('rot')!.speed).toBeCloseTo(50, 6);
    run(w, 1);
    expect(w.ents.moverState('rot')!.speed).toBe(100);
    w.ents.fireInput('rot', 'Stop');
    run(w, 0.01); // an ent_fire is delivered through the event queue at the end of the next tick
    run(w, 0.5);
    expect(w.ents.moverState('rot')!.speed).toBeCloseTo(50, 6);
    run(w, 1);
    expect(w.ents.moverState('rot')!.speed).toBe(0);
  });

  it('axis and reverse flags pick the Euler component and sign', () => {
    const w = setup({
      entities:
        `{ "classname" "func_rotating" "targetname" "x" "model" "*1" "origin" "0 0 8" "spawnflags" "7" "maxspeed" "30" }` +
        `{ "classname" "func_rotating" "targetname" "y" "model" "*2" "origin" "0 0 8" "spawnflags" "9" "maxspeed" "30" }`,
      models: { 1: { mins: [-8, -8, 0], maxs: [8, 8, 16] }, 2: { mins: [-8, -8, 0], maxs: [8, 8, 16] } },
    });
    run(w, 1);
    const x = w.ents.moverState('x')!.angles;
    const y = w.ents.moverState('y')!.angles;
    expect(x.roll).toBeCloseTo(-30, 6); // X axis, reversed
    expect(x.yaw).toBeCloseTo(0, 6);
    expect(y.pitch).toBeCloseTo(30, 6); // Y axis
  });

  it('Start / Stop / Toggle / Reverse / SetSpeed / StopAtStartPos', () => {
    const w = setup({
      entities: `{ "classname" "func_rotating" "targetname" "rot" "model" "*1" "origin" "0 0 8" "maxspeed" "90" }`,
      models: BAR,
    });
    run(w, 0.5);
    expect(w.ents.moverState('rot')!.speed).toBe(0);
    w.ents.fireInput('rot', 'Start');
    run(w, 0.5);
    expect(w.ents.moverState('rot')!.speed).toBe(90);
    w.ents.fireInput('rot', 'Reverse');
    run(w, 0.1);
    expect(w.ents.moverState('rot')!.speed).toBe(-90);
    w.ents.fireInput('rot', 'SetSpeed', '0.5');
    run(w, 0.1);
    expect(w.ents.moverState('rot')!.speed).toBe(-45);
    w.ents.fireInput('rot', 'Toggle');
    run(w, 0.1);
    expect(w.ents.moverState('rot')!.speed).toBe(0);
    w.ents.fireInput('rot', 'StartForward');
    run(w, 0.1);
    expect(w.ents.moverState('rot')!.speed).toBe(90);
    // stops exactly at the start angle when it next passes it
    w.ents.fireInput('rot', 'StopAtStartPos');
    run(w, 5);
    const st = w.ents.moverState('rot')!;
    expect(st.speed).toBe(0);
    expect(anglemod(st.angles.yaw + 1e-9)).toBeCloseTo(0, 6);
  });

  it('carries a player standing on it around its axis (the view does not turn)', () => {
    const w = setup(
      {
        entities: `{ "classname" "func_rotating" "targetname" "rot" "model" "*1" "origin" "0 0 8" "spawnflags" "1" "maxspeed" "90" }`,
        models: { 1: { mins: [-300, -300, 0], maxs: [300, 300, 16], solid: true } },
      },
      [200, 0, 16],
    );
    expect(w.host.player.onGround).toBe(true);
    expect(w.host.player.groundModel).toBe(1);
    run(w, 1);
    const o = w.host.player.origin;
    expect(o.x).toBeCloseTo(0, 0);
    expect(o.y).toBeCloseTo(200, 0);
    expect(o.z).toBeCloseTo(16 + REST, 3);
    expect(w.host.player.viewAngles.yaw).toBe(0);
    expect(inSolid(w)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ func_door

describe('func_door', () => {
  // a 16 x 64 x 128 door built at its entity origin (8, 0, 64)
  const DOOR = { 1: { mins: [0, -32, 0] as V3, maxs: [16, 32, 128] as V3, solid: true } };
  const door = (kv: string) => `{ "classname" "func_door" "targetname" "door" "model" "*1" "origin" "8 0 64" ${kv} }`;

  it('slides its size along movedir less 2 and lip, waits, returns; fires its outputs', () => {
    const w = setup({
      entities:
        COUNTER +
        door(`"movedir" "-90 0 0" "speed" "100" "wait" "1" "lip" "6" "OnOpen" "count,Add,1,0,-1" "OnFullyOpen" "count,Add,10,0,-1" "OnClose" "count,Add,100,0,-1" "OnFullyClosed" "count,Add,1000,0,-1"`),
      models: DOOR,
    });
    // travel = (128 - 2) - 6 = 120 units up at 100 u/s
    w.ents.fireInput('door', 'Open');
    run(w, 0.6);
    let st = w.ents.moverState('door')!;
    expect(st.state).toBe('opening');
    expect(st.origin.z).toBeCloseTo(64 + 59, 4);
    expect(w.ents.counterValue('count')).toBe(1);
    run(w, 0.7);
    st = w.ents.moverState('door')!;
    expect(st.state).toBe('open');
    expect(st.origin.z).toBeCloseTo(64 + 120, 6);
    expect(w.ents.counterValue('count')).toBe(11);
    run(w, 1.0); // wait 1 s
    expect(w.ents.moverState('door')!.state).toBe('closing');
    expect(w.ents.counterValue('count')).toBe(111);
    run(w, 1.3);
    st = w.ents.moverState('door')!;
    expect(st.state).toBe('closed');
    expect(st.origin.z).toBeCloseTo(64, 6);
    expect(w.ents.counterValue('count')).toBe(1111);
  });

  it('wait -1 and the Toggle (no auto return) flag stay open; Close / Toggle close it', () => {
    for (const kv of [`"wait" "-1"`, `"wait" "1" "spawnflags" "32"`]) {
      const w = setup({ entities: door(`"movedir" "0 90 0" "speed" "200" ${kv}`), models: DOOR });
      w.ents.fireInput('door', 'Open');
      run(w, 3);
      expect(w.ents.moverState('door')!.state).toBe('open');
      expect(w.ents.moverState('door')!.origin.y).toBeCloseTo(62, 6); // 64 - 2 along +y
      w.ents.fireInput('door', 'Toggle');
      run(w, 1);
      expect(w.ents.moverState('door')!.state).toBe('closed');
    }
  });

  it('spawnpos 1 starts open; the old "starts open" flag swaps its positions', () => {
    let w = setup({ entities: door(`"movedir" "-90 0 0" "spawnpos" "1" "wait" "-1"`), models: DOOR });
    expect(w.ents.moverState('door')!.state).toBe('open');
    expect(w.ents.moverState('door')!.origin.z).toBeCloseTo(64 + 126, 6);
    // its brushes are up there from the start
    expect(w.host.collision.pointContents(v3(8, 0, 64 + 126 + 10))).not.toBe(0);
    w = setup({ entities: door(`"movedir" "-90 0 0" "spawnflags" "1" "wait" "-1"`), models: DOOR });
    expect(w.ents.moverState('door')!.state).toBe('closed');
    expect(w.ents.moverState('door')!.origin.z).toBeCloseTo(64 + 126, 6);
    w.ents.fireInput('door', 'Open');
    run(w, 2);
    expect(w.ents.moverState('door')!.origin.z).toBeCloseTo(64, 6);
  });

  it('use-opens and touch-opens doors open for the player unless locked', () => {
    const w = setup(
      {
        entities: COUNTER + door(`"movedir" "-90 0 0" "spawnflags" "2304" "OnLockedUse" "count,Add,1,0,-1" "wait" "-1"`),
        models: DOOR,
      },
      [-40, 0, 0],
    );
    const eye = v3(-40, 0, 64);
    // locked (2048): +use only fires OnLockedUse
    expect(w.ents.pressUse(eye, v3(1, 0, 0))).toBe(true);
    run(w, 0.05);
    expect(w.ents.counterValue('count')).toBe(1);
    expect(w.ents.moverState('door')!.state).toBe('closed');
    w.ents.fireInput('door', 'Unlock');
    run(w, 0.05);
    expect(w.ents.pressUse(eye, v3(1, 0, 0))).toBe(true);
    run(w, 0.1);
    expect(w.ents.moverState('door')!.state).toBe('opening');

    const t = setup({ entities: door(`"movedir" "-90 0 0" "spawnflags" "1024" "wait" "-1"`), models: DOOR }, [-60, 0, 0]);
    expect(t.ents.moverState('door')!.state).toBe('closed');
    // walk into the door
    run(t, 1, () => {
      const c = newUserCmd();
      c.forwardmove = 250;
      return c;
    });
    expect(t.ents.moverState('door')!.state).not.toBe('closed');
  });

  it('pushes a player in its way; blocked against a wall it reverses (wait >= 0)', () => {
    const w = setup(
      {
        entities: COUNTER + door(`"movedir" "0 0 0" "speed" "100" "wait" "5" "lip" "-200" "OnBlockedOpening" "count,Add,1,0,-1"`),
        models: DOOR,
        world: [{ mins: [150, -500, 0], maxs: [200, 500, 300], solid: true }],
      },
      [60, 0, 0],
    );
    w.ents.fireInput('door', 'Open');
    let maxX = 0;
    for (let i = 0; i < 300; i++) {
      tick(w);
      maxX = Math.max(maxX, w.host.player.origin.x);
      expect(inSolid(w)).toBe(false);
    }
    // pushed up to the wall (150 - 16), then the door gave way
    expect(maxX).toBeGreaterThan(130);
    expect(maxX).toBeLessThanOrEqual(134 + 1e-6);
    expect(w.ents.counterValue('count')).toBeGreaterThanOrEqual(1);
    expect(['closing', 'closed']).toContain(w.ents.moverState('door')!.state);
    expect(w.host.kills.length).toBe(0);
  });

  it('crushes with dmg: a door that never returns keeps pushing until the player dies', () => {
    const w = setup(
      {
        entities: door(`"movedir" "0 0 0" "speed" "100" "wait" "-1" "lip" "-200" "dmg" "20"`),
        models: DOOR,
        world: [{ mins: [150, -500, 0], maxs: [200, 500, 300], solid: true }],
      },
      [60, 0, 0],
    );
    w.ents.fireInput('door', 'Open');
    run(w, 3);
    expect(w.host.kills.length).toBeGreaterThan(0);
    expect(w.host.kills[0]).toContain('func_door');
  });

  it('carries a rider up (elevator) without ever leaving it in solid', () => {
    const w = setup(
      {
        entities: `{ "classname" "func_door" "targetname" "lift" "model" "*1" "origin" "0 0 8" "movedir" "-90 0 0" "speed" "150" "wait" "-1" "lip" "-300" }`,
        models: { 1: { mins: [-128, -128, 0], maxs: [128, 128, 16], solid: true } },
      },
      [0, 0, 16],
    );
    expect(w.host.player.groundModel).toBe(1);
    w.ents.fireInput('lift', 'Open');
    for (let i = 0; i < 400; i++) {
      tick(w);
      expect(inSolid(w)).toBe(false);
    }
    // travel = 16 - 2 + 300 = 314
    expect(w.ents.moverState('lift')!.origin.z).toBeCloseTo(8 + 314, 4);
    expect(w.host.player.origin.z).toBeCloseTo(16 + 314, 1);
    expect(w.host.player.onGround).toBe(true);
    // and down again
    w.ents.fireInput('lift', 'Close');
    run(w, 3);
    expect(w.host.player.origin.z).toBeCloseTo(16, 1);
    expect(inSolid(w)).toBe(false);
  });

  it('an elevator crushing a rider into a ceiling stalls (no dmg) or kills (dmg)', () => {
    for (const dmg of [0, 50]) {
      const w = setup(
        {
          entities: `{ "classname" "func_door" "targetname" "lift" "model" "*1" "origin" "0 0 8" "movedir" "-90 0 0" "speed" "150" "wait" "-1" "lip" "-300" "dmg" "${dmg}" }`,
          models: { 1: { mins: [-128, -128, 0], maxs: [128, 128, 16], solid: true } },
          world: [{ mins: [-500, -500, 120], maxs: [500, 500, 140], solid: true }],
        },
        [0, 0, 16],
      );
      w.ents.fireInput('lift', 'Open');
      run(w, 2);
      if (dmg === 0) {
        expect(w.host.kills.length).toBe(0);
        // stalled with the player squeezed under the ceiling, never inside anything
        expect(w.host.player.origin.z + 72).toBeLessThanOrEqual(120 + 1e-6);
        expect(inSolid(w)).toBe(false);
      } else expect(w.host.kills.length).toBeGreaterThan(0);
    }
  });

  it('jumping off a moving platform keeps its velocity (ground entity velocity)', () => {
    const w = setup(
      {
        entities: `{ "classname" "func_door" "targetname" "plat" "model" "*1" "origin" "0 0 8" "movedir" "0 0 0" "speed" "200" "wait" "-1" "lip" "-3000" }`,
        models: { 1: { mins: [-128, -128, 0], maxs: [128, 128, 16], solid: true } },
      },
      [0, 0, 16],
    );
    w.ents.fireInput('plat', 'Open');
    run(w, 0.5);
    // riding: carried at the platform's speed with no velocity of its own
    expect(w.host.player.origin.x).toBeGreaterThan(80);
    expect(Math.abs(w.host.player.velocity.x)).toBeLessThan(1);
    const jump = newUserCmd();
    jump.buttons = IN_JUMP;
    tick(w, jump);
    expect(w.host.player.onGround).toBe(false);
    tick(w);
    expect(w.host.player.velocity.x).toBeGreaterThan(199);
    expect(w.host.player.velocity.x).toBeLessThan(203);
  });
});

describe('func_door_rotating', () => {
  it('turns `distance` degrees about its axis and back', () => {
    const w = setup({
      entities:
        `{ "classname" "func_door_rotating" "targetname" "d" "model" "*1" "origin" "0 0 0" "distance" "90" "speed" "90" "wait" "-1" }` +
        `{ "classname" "func_door_rotating" "targetname" "r" "model" "*2" "origin" "0 0 0" "distance" "45" "speed" "90" "wait" "-1" "spawnflags" "66" }`,
      models: { 1: { mins: [0, -4, 0], maxs: [64, 4, 100] }, 2: { mins: [0, -4, 0], maxs: [64, 4, 100] } },
    });
    w.ents.fireInput('d', 'Open');
    w.ents.fireInput('r', 'Open');
    run(w, 1.5);
    expect(w.ents.moverState('d')!.state).toBe('open');
    expect(w.ents.moverState('d')!.angles.yaw).toBeCloseTo(90, 6);
    expect(w.ents.moverState('r')!.angles.roll).toBeCloseTo(-45, 6);
    w.ents.fireInput('d', 'Close');
    run(w, 1.5);
    expect(w.ents.moverState('d')!.angles.yaw).toBeCloseTo(0, 6);
  });
});

// ------------------------------------------------------------------------------------------ movelinear & co

describe('func_movelinear', () => {
  it('SetPosition / Open / Close along movedir, OnFullyOpen / OnFullyClosed', () => {
    const w = setup({
      entities:
        COUNTER +
        `{ "classname" "func_movelinear" "targetname" "m" "model" "*1" "origin" "0 0 50" "movedir" "0 90 0" "movedistance" "200" "speed" "100" "startposition" "0.25" "OnFullyOpen" "count,Add,1,0,-1" "OnFullyClosed" "count,Add,10,0,-1" }`,
      models: { 1: { mins: [-16, -16, 34], maxs: [16, 16, 66] } },
    });
    // the map placed it at position 0.25: position 0 is 50 units back along -y
    w.ents.fireInput('m', 'SetPosition', '0.5');
    run(w, 1);
    expect(w.ents.moverState('m')!.origin.y).toBeCloseTo(50, 6);
    expect(w.ents.counterValue('count')).toBe(0);
    w.ents.fireInput('m', 'Open');
    run(w, 1.5);
    expect(w.ents.moverState('m')!.origin.y).toBeCloseTo(150, 6);
    expect(w.ents.counterValue('count')).toBe(1);
    w.ents.fireInput('m', 'Close');
    run(w, 2.5);
    expect(w.ents.moverState('m')!.origin.y).toBeCloseTo(-50, 6);
    expect(w.ents.counterValue('count')).toBe(11);
  });
});

describe('momentary_rot_button', () => {
  it('loops like the KSF fans: OnFullyClosed at position 1 -> SetPositionImmediately 0, SetPosition 1', () => {
    const w = setup({
      entities: `{ "classname" "momentary_rot_button" "targetname" "fan" "model" "*1" "origin" "0 0 0" "distance" "360" "speed" "360" "spawnflags" "1" "startposition" "0" "OnFullyClosed" "!self,SetPositionImmediately,0,0,-1" "OnFullyClosed" "!self,SetPosition,1,0.01,-1" }` +
        `{ "classname" "logic_auto" "OnMapSpawn" "fan,SetPosition,1,0,-1" }`,
      models: { 1: { mins: [-8, -64, -8], maxs: [8, 64, 8] } },
    });
    const yaws: number[] = [];
    for (let i = 0; i < 300; i++) {
      tick(w);
      yaws.push(anglemod(w.ents.moverState('fan')!.angles.yaw));
    }
    // ~one turn per second, three turns: it went round several times
    let wraps = 0;
    for (let i = 1; i < yaws.length; i++) if (yaws[i] < yaws[i - 1] - 180) wraps++;
    expect(wraps).toBeGreaterThanOrEqual(2);
  });
});

// ------------------------------------------------------------------------------------------ trains

describe('func_tracktrain / path_track', () => {
  const path =
    `{ "classname" "path_track" "targetname" "p1" "target" "p2" "origin" "0 0 100" }` +
    `{ "classname" "path_track" "targetname" "p2" "target" "p3" "origin" "400 0 100" "OnPass" "count,Add,1,0,-1" }` +
    `{ "classname" "path_track" "targetname" "p3" "origin" "400 400 100" "OnPass" "count,Add,10,0,-1" }`;
  const train = (kv: string) => `{ "classname" "func_tracktrain" "targetname" "t" "model" "*1" "origin" "1000 1000 1000" "target" "p1" ${kv} }`;
  const TRAIN = { 1: { mins: [968, 968, 984] as V3, maxs: [1032, 1032, 1016] as V3, solid: true } };

  it('starts on its first path_track and follows the path at its speed, firing OnPass', () => {
    const w = setup({ entities: COUNTER + path + train(`"speed" "200" "startspeed" "200" "spawnflags" "16"`), models: TRAIN });
    // teleported to p1 at spawn, brushes too
    expect(w.ents.moverState('t')!.origin).toEqual(v3(0, 0, 100));
    expect(w.host.collision.pointContents(v3(0, 0, 100))).not.toBe(0);
    run(w, 1);
    expect(w.ents.moverState('t')!.origin.x).toBeCloseTo(200, 3);
    run(w, 1.05);
    expect(w.ents.counterValue('count')).toBe(1);
    run(w, 3);
    const st = w.ents.moverState('t')!;
    expect(st.origin).toEqual(v3(400, 400, 100));
    expect(st.speed).toBe(0); // end of the path
    expect(st.node).toBe('p3');
    expect(w.ents.counterValue('count')).toBe(11);
    expect(st.angles.yaw).toBe(0); // fixed orientation
  });

  it('faces along the path when oriented, and clamps speeds to its max speed (SetSpeed is a ratio)', () => {
    const w = setup({ entities: COUNTER + path + train(`"speed" "0" "startspeed" "100"`), models: TRAIN });
    w.ents.fireInput('t', 'SetSpeed', '250');
    run(w, 0.1);
    expect(w.ents.moverState('t')!.speed).toBe(100);
    w.ents.fireInput('t', 'SetSpeed', '0.5');
    run(w, 0.1);
    expect(w.ents.moverState('t')!.speed).toBe(50);
    w.ents.fireInput('t', 'SetSpeedReal', '100');
    run(w, 4.5);
    expect(anglemod(w.ents.moverState('t')!.angles.yaw)).toBeCloseTo(90, 6); // p2 -> p3
    w.ents.fireInput('t', 'Stop');
    run(w, 0.5);
    const at = w.ents.moverState('t')!.origin;
    run(w, 0.5);
    expect(w.ents.moverState('t')!.origin).toEqual(at);
    w.ents.fireInput('t', 'StartBackward');
    run(w, 0.5); // still between p3 and p2 (stopped ~66 units past p2)
    expect(w.ents.moverState('t')!.origin.y).toBeLessThan(at.y);
    // facing the path's forward direction while backing up
    expect(anglemod(w.ents.moverState('t')!.angles.yaw)).toBeCloseTo(90, 6);
  });

  it('stops in front of a disabled path_track until EnablePath; a teleport node is jumped to', () => {
    const w = setup({
      entities:
        COUNTER +
        `{ "classname" "path_track" "targetname" "a" "target" "b" "origin" "0 0 100" }` +
        `{ "classname" "path_track" "targetname" "b" "target" "c" "origin" "100 0 100" "spawnflags" "1" }` +
        `{ "classname" "path_track" "targetname" "c" "target" "d" "origin" "200 0 100" }` +
        `{ "classname" "path_track" "targetname" "d" "target" "e" "origin" "3000 0 100" "spawnflags" "16" "OnPass" "count,Add,1,0,-1" }` +
        `{ "classname" "path_track" "targetname" "e" "origin" "3100 0 100" }` +
        `{ "classname" "func_tracktrain" "targetname" "t" "model" "*1" "origin" "0 0 100" "target" "a" "speed" "100" "startspeed" "100" "spawnflags" "16" }`,
      models: { 1: { mins: [-16, -16, 84], maxs: [16, 16, 116] } },
    });
    run(w, 1);
    expect(w.ents.moverState('t')!.origin.x).toBe(0);
    w.ents.fireInput('b', 'EnablePath');
    w.ents.fireInput('t', 'StartForward');
    run(w, 2.05);
    // reached c (x = 200) and jumped to d (x = 3000) instead of travelling there
    const st = w.ents.moverState('t')!;
    expect(st.origin.x).toBeGreaterThanOrEqual(3000);
    expect(w.ents.counterValue('count')).toBe(1);
    run(w, 2);
    expect(w.ents.moverState('t')!.origin.x).toBe(3100);
  });

  it('path_track speed changes the passing train speed (clamped); TeleportToPathTrack', () => {
    const w = setup({
      entities:
        `{ "classname" "path_track" "targetname" "a" "target" "b" "origin" "0 0 100" "speed" "60" }` +
        `{ "classname" "path_track" "targetname" "b" "target" "c" "origin" "100 0 100" "speed" "500" }` +
        `{ "classname" "path_track" "targetname" "c" "origin" "1000 0 100" }` +
        `{ "classname" "func_tracktrain" "targetname" "t" "model" "*1" "origin" "0 0 100" "target" "a" "speed" "100" "startspeed" "200" "spawnflags" "16" }`,
      models: { 1: { mins: [-16, -16, 84], maxs: [16, 16, 116] } },
    });
    run(w, 1.1);
    expect(w.ents.moverState('t')!.speed).toBe(200);
    w.ents.fireInput('t', 'TeleportToPathTrack', 'a');
    run(w, 0.02);
    expect(w.ents.moverState('t')!.origin.x).toBeLessThan(10);
  });

  it('an unblockable train crushes a player it cannot push', () => {
    const w = setup(
      {
        entities:
          `{ "classname" "path_track" "targetname" "a" "target" "b" "origin" "0 0 16" }` +
          `{ "classname" "path_track" "targetname" "b" "origin" "1000 0 16" }` +
          `{ "classname" "func_tracktrain" "targetname" "t" "model" "*1" "origin" "0 0 16" "target" "a" "speed" "200" "startspeed" "200" "spawnflags" "528" }`,
        models: { 1: { mins: [-32, -64, 0], maxs: [32, 64, 128], solid: true } },
        world: [{ mins: [300, -500, 0], maxs: [400, 500, 300], solid: true }],
      },
      [100, 0, 0],
    );
    run(w, 2);
    expect(w.host.kills.some((k) => k.includes('crushed'))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ hierarchy

describe('parenting (parentname / SetParent / ClearParent)', () => {
  it('children follow the parent: brush children collide, triggers touch, props are drawn there', () => {
    const map = `{ "classname" "path_track" "targetname" "a" "target" "b" "origin" "0 0 0" }
{ "classname" "path_track" "targetname" "b" "origin" "1000 0 0" }
{ "classname" "func_tracktrain" "targetname" "t" "model" "*1" "origin" "0 0 0" "target" "a" "speed" "100" "startspeed" "100" "spawnflags" "16" }
{ "classname" "func_door" "targetname" "door" "model" "*2" "origin" "0 100 32" "parentname" "t" "movedir" "-90 0 0" "wait" "-1" "speed" "100" }
{ "classname" "trigger_multiple" "targetname" "trig" "model" "*3" "origin" "0 -100 0" "parentname" "t" "spawnflags" "1" "OnStartTouch" "count,Add,1,0,-1" }
{ "classname" "prop_dynamic" "targetname" "prop" "model" "models/x.mdl" "origin" "0 0 64" "angles" "0 0 0" "parentname" "t" }
{ "classname" "info_target" "targetname" "dest" "origin" "50 0 0" "parentname" "t" }
${COUNTER}`;
    const w = setup(
      {
        entities: map,
        models: {
          1: { mins: [-16, -16, 0], maxs: [16, 16, 16], solid: true },
          2: { mins: [-8, 80, 0], maxs: [8, 120, 64], solid: true },
          3: { mins: [-32, -132, 0], maxs: [32, -68, 64] },
        },
      },
      [300, -100, 0],
    );
    const propIndex = parseEntities(map).findIndex((e) => e.targetname === 'prop');
    run(w, 1);
    // everything moved 100 units along x with the train
    expect(w.ents.placementOf('door')!.origin.x).toBeCloseTo(100, 3);
    expect(w.ents.placementOf('dest')!.origin.x).toBeCloseTo(150, 3); // built at x = 50
    expect(w.ents.findTarget('dest')!.origin.x).toBeCloseTo(150, 3);
    expect(w.host.collision.pointContents(v3(100, 100, 40))).not.toBe(0);
    expect(w.host.collision.pointContents(v3(0, 100, 40))).toBe(0);
    w.ents.applyRenderTransforms(1);
    expect(w.r.models.get(2)!.origin.x).toBeCloseTo(100, 3);
    expect(w.r.ents.get(propIndex)!.origin).toEqual(expect.objectContaining({ z: 64 }));
    expect(w.r.ents.get(propIndex)!.origin.x).toBeCloseTo(100, 3);
    // the door still opens relative to the train
    w.ents.fireInput('door', 'Open');
    run(w, 1);
    expect(w.ents.placementOf('door')!.origin.x).toBeCloseTo(200, 3);
    expect(w.ents.placementOf('door')!.origin.z).toBeGreaterThan(32 + 60);
    // the trigger reached the waiting player at x = 300
    expect(w.ents.counterValue('count')).toBe(0);
    run(w, 0.9);
    expect(w.ents.counterValue('count')).toBe(1);
  });

  it('a rotating parent swings its children around its axis; SetParent / ClearParent at runtime', () => {
    const w = setup({
      entities:
        `{ "classname" "func_rotating" "targetname" "rot" "model" "*1" "origin" "0 0 0" "spawnflags" "65" "maxspeed" "90" }` +
        `{ "classname" "func_brush" "targetname" "arm" "model" "*2" "origin" "100 0 0" "parentname" "rot" }` +
        `{ "classname" "func_brush" "targetname" "free" "model" "*3" "origin" "0 200 0" }` +
        `{ "classname" "logic_relay" "targetname" "attach" "OnTrigger" "free,SetParent,rot,0,-1" }`,
      models: {
        1: { mins: [-8, -8, -8], maxs: [8, 8, 8] },
        2: { mins: [90, -10, -10], maxs: [110, 10, 10], solid: true },
        3: { mins: [-10, 190, -10], maxs: [10, 210, 10], solid: true },
      },
    });
    run(w, 1);
    const arm = w.ents.placementOf('arm')!;
    expect(arm.origin.x).toBeCloseTo(0, 6);
    expect(arm.origin.y).toBeCloseTo(100, 6);
    expect(anglemod(arm.angles.yaw)).toBeCloseTo(90, 6);
    expect(w.host.collision.pointContents(v3(0, 100, 0))).not.toBe(0);
    expect(w.host.collision.pointContents(v3(100, 0, 0))).toBe(0);
    w.ents.fireInput('attach', 'Trigger');
    run(w, 0.01); // attached at the end of this tick (event queue)
    run(w, 1);
    // attached at yaw 90: another 90 degrees takes (0, 200) to (-200, 0)
    const free = w.ents.placementOf('free')!;
    expect(free.origin.x).toBeCloseTo(-200, 0);
    expect(free.origin.y).toBeCloseTo(0, 0);
    w.ents.fireInput('free', 'ClearParent');
    run(w, 0.02);
    const at = w.ents.placementOf('free')!.origin;
    run(w, 1);
    expect(w.ents.placementOf('free')!.origin).toEqual(at);
  });

  it('movableEntitySets: movers, their parentname children and SetParent targets', () => {
    const ents = parseEntities(
      `{ "classname" "func_rotating" "targetname" "rot" "model" "*1" }` +
        `{ "classname" "prop_dynamic" "targetname" "p" "parentname" "rot" "model" "m.mdl" }` +
        `{ "classname" "env_sprite" "parentname" "p" }` +
        `{ "classname" "func_brush" "targetname" "b" "model" "*2" }` +
        `{ "classname" "func_brush" "targetname" "still" "model" "*3" }` +
        `{ "classname" "logic_auto" "OnMapSpawn" "b,SetParent,rot,0,-1" }`,
    );
    const s = movableEntitySets(ents);
    expect([...s.models].sort()).toEqual([1, 2]);
    expect([...s.entities].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('render interpolation and determinism', () => {
  it('sends placements between the last two ticks', () => {
    const w = setup({
      entities: `{ "classname" "func_rotating" "targetname" "rot" "model" "*1" "origin" "0 0 0" "spawnflags" "65" "maxspeed" "100" }`,
      models: { 1: { mins: [-8, -8, -8], maxs: [8, 8, 8] } },
    });
    run(w, 0.5);
    w.ents.applyRenderTransforms(0.5);
    expect(w.r.models.get(1)!.angles.yaw).toBeCloseTo(49.5, 6);
    w.ents.applyRenderTransforms(1);
    expect(w.r.models.get(1)!.angles.yaw).toBeCloseTo(50, 6);
    const a = new Pose().set(v3(), qa(0, 10, 0));
    const b = new Pose().set(v3(10, 0, 0), qa(0, 30, 0));
    const m = lerpPose(a, b, 0.25, new Pose());
    expect(m.angles.yaw).toBeCloseTo(15, 9);
    expect(m.origin.x).toBeCloseTo(2.5, 12);
  });

  it('the same inputs give the same motion', () => {
    const go = () => {
      const w = setup(
        {
          entities: `{ "classname" "func_rotating" "targetname" "rot" "model" "*1" "origin" "0 0 8" "spawnflags" "17" "maxspeed" "120" "fanfriction" "7" }`,
          models: { 1: { mins: [-300, -300, 0], maxs: [300, 300, 16], solid: true } },
        },
        [150, 30, 16],
      );
      run(w, 3, () => {
        const c = newUserCmd();
        c.forwardmove = 100;
        return c;
      });
      return { ...w.host.player.origin, yaw: w.ents.moverState('rot')!.angles.yaw };
    };
    expect(go()).toEqual(go());
  });
});

// keep angleVectors import used for future checks
void angleVectors;
