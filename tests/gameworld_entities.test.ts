import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { EntitySystem, MapTeleportEvent, nameMatches, parseAddOutput } from '../src/game/entities';
import { FL_BASEVELOCITY, FL_ONGROUND, MOVETYPE_NOCLIP, newUserCmd } from '../src/physics/playertypes';
import { MockHost, MapSpec, physicsTick, settle } from './gameworld_host';

const FLOOR = { mins: [-8000, -8000, -64] as [number, number, number], maxs: [8000, 8000, 0] as [number, number, number], solid: true };

function setup(spec: MapSpec, x = 0, y = 0, z = 1): { host: MockHost; ents: EntitySystem } {
  const host = new MockHost({ world: [FLOOR], ...spec }, v3(x, y, z));
  const ents = new EntitySystem(host);
  host.entities = ents;
  ents.spawn();
  return { host, ents };
}

function step(host: MockHost, ents: EntitySystem, n = 1): void {
  for (let i = 0; i < n; i++) {
    host.advance();
    ents.tick();
  }
}

const TRIG1: Record<number, { mins: [number, number, number]; maxs: [number, number, number] }> = {
  1: { mins: [-50, -50, 0], maxs: [50, 50, 100] },
};

describe('nameMatches (Source NameMatches)', () => {
  it('is case-insensitive and supports trailing wildcards only', () => {
    expect(nameMatches('Stage1', 'stage1')).toBe(true);
    expect(nameMatches('stage1', 'stage12')).toBe(false);
    expect(nameMatches('stage*', 'stage12')).toBe(true);
    expect(nameMatches('player_qr_t6_*', 'player_qr_t6_L')).toBe(true);
    expect(nameMatches('player_qr_t6_*', 'player_qr_t5_L')).toBe(false);
    expect(nameMatches('*', 'anything')).toBe(true);
    expect(nameMatches('', '')).toBe(true);
    expect(nameMatches('*', '')).toBe(true);
    expect(nameMatches('x', '')).toBe(false);
    expect(nameMatches('', 'x')).toBe(false);
    // engine quirk: everything after the first '*' is ignored
    expect(nameMatches('a*c', 'abd')).toBe(true);
  });
});

describe('parseAddOutput', () => {
  it('splits keyvalues at the first space, keeping the rest verbatim', () => {
    expect(parseAddOutput('targetname stage3')).toEqual({ kind: 'keyvalue', key: 'targetname', value: 'stage3' });
    expect(parseAddOutput('basevelocity 0 0 800')).toEqual({ kind: 'keyvalue', key: 'basevelocity', value: '0 0 800' });
    expect(parseAddOutput('targetname  ')).toEqual({ kind: 'keyvalue', key: 'targetname', value: ' ' });
    expect(parseAddOutput('gravity')).toBeNull();
  });
  it('parses output connections in colon and comma form', () => {
    const a = parseAddOutput('OnStartTouch !activator:AddOutput:targetname foo:0.5:1');
    expect(a).toEqual({
      kind: 'output',
      output: { event: 'onstarttouch', target: '!activator', input: 'AddOutput', param: 'targetname foo', delay: 0.5, timesToFire: 1 },
    });
    const b = parseAddOutput('OnTrigger relay,Trigger,,0,-1');
    expect(b?.kind).toBe('output');
    if (b?.kind === 'output') expect(b.output).toMatchObject({ event: 'ontrigger', target: 'relay', input: 'Trigger', delay: 0, timesToFire: -1 });
  });
});

describe('trigger_teleport', () => {
  it('without landmark: moves to the destination, snaps view, zeroes velocity', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_teleport" "model" "*1" "target" "dest1" "spawnflags" "1" }
        { "classname" "info_teleport_destination" "targetname" "DEST1" "origin" "1000 200 64" "angles" "10 90 0" }`,
    });
    host.player.velocity.x = 900;
    host.player.viewAngles.yaw = 33;
    step(host, ents);
    expect(host.teleports).toHaveLength(1);
    expect(host.player.origin).toEqual(v3(1000, 200, 64));
    expect(host.player.viewAngles).toMatchObject({ pitch: 10, yaw: 90 });
    expect(host.player.velocity).toEqual(v3(0, 0, 0));
  });

  it('with landmark: keeps the offset, velocity and view', () => {
    const { host, ents } = setup(
      {
        models: TRIG1,
        entities: `
          { "classname" "trigger_teleport" "model" "*1" "target" "dest" "landmark" "lm" "spawnflags" "1" }
          { "classname" "info_landmark" "targetname" "lm" "origin" "0 0 0" }
          { "classname" "info_target" "targetname" "dest" "origin" "5000 0 1000" "angles" "0 180 0" }`,
      },
      10,
      -20,
      30,
    );
    host.player.velocity.x = 1200;
    host.player.viewAngles.yaw = 45;
    step(host, ents);
    expect(host.player.origin).toEqual(v3(5010, -20, 1030));
    expect(host.player.velocity.x).toBe(1200);
    expect(host.player.viewAngles.yaw).toBe(45);
    expect(host.teleports[0]).toMatchObject({ angles: null, velocity: null });
  });

  it('spawnflags without "clients" never teleport the player; missing destinations do nothing', () => {
    const { host, ents } = setup({
      models: { 1: TRIG1[1], 2: TRIG1[1] },
      entities: `
        { "classname" "trigger_teleport" "model" "*1" "target" "dest" "spawnflags" "0" }
        { "classname" "trigger_teleport" "model" "*2" "target" "nowhere" "spawnflags" "1" }
        { "classname" "info_target" "targetname" "dest" "origin" "5000 0 0" }`,
    });
    step(host, ents, 3);
    expect(host.teleports).toHaveLength(0);
  });

  it('StartDisabled + Enable input; Disable stops it', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_teleport" "targetname" "tp" "model" "*1" "target" "dest" "spawnflags" "1" "StartDisabled" "1" }
        { "classname" "info_target" "targetname" "dest" "origin" "5000 0 0" }`,
    });
    step(host, ents, 2);
    expect(host.teleports).toHaveLength(0);
    ents.fireInput('tp', 'Enable');
    step(host, ents); // the input is serviced at the end of this tick
    expect(host.teleports).toHaveLength(0);
    step(host, ents);
    expect(host.teleports).toHaveLength(1);
    ents.fireInput('tp', 'Disable');
    step(host, ents); // serviced at the end of this tick (the player is away at the destination)
    host.setPos(0, 0, 1);
    step(host, ents, 3);
    expect(host.teleports).toHaveLength(1);
    ents.fireInput('tp', 'Toggle');
    step(host, ents, 2);
    expect(host.teleports).toHaveLength(2);
  });

  it('filtered teleport passes once AddOutput targetname set the player name (one tick later)', () => {
    const { host, ents } = setup({
      models: { 1: TRIG1[1], 2: TRIG1[1] },
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1" "wait" "1" "OnStartTouch" "!activator,AddOutput,targetname X2,0,-1" }
        { "classname" "trigger_teleport" "model" "*2" "target" "dest" "spawnflags" "1" "filtername" "f_x2" }
        { "classname" "filter_activator_name" "targetname" "f_x2" "filtername" "x2" "Negated" "Allow entities that match criteria" }
        { "classname" "info_target" "targetname" "dest" "origin" "5000 0 0" }`,
    });
    expect(ents.playerTargetname).toBe('');
    step(host, ents);
    // the filter saw the old (empty) name during the touch; the AddOutput ran at the end of the tick
    expect(host.teleports).toHaveLength(0);
    expect(ents.playerTargetname).toBe('X2');
    step(host, ents);
    expect(host.teleports).toHaveLength(1);
  });

  it('negated filters and filter_activator_class (AddOutput classname)', () => {
    const { host, ents } = setup({
      models: { 1: TRIG1[1] },
      entities: `
        { "classname" "trigger_teleport" "model" "*1" "target" "dest" "spawnflags" "1" "filtername" "notbonus" }
        { "classname" "filter_activator_class" "targetname" "notbonus" "filterclass" "bonus_secret" "Negated" "1" }
        { "classname" "info_target" "targetname" "dest" "origin" "5000 0 0" }`,
    });
    ents.playerClassname = 'bonus_secret';
    step(host, ents, 2);
    expect(host.teleports).toHaveLength(0);
    ents.fireInput('!player', 'AddOutput', 'classname player');
    step(host, ents, 2);
    expect(host.teleports).toHaveLength(1);
  });

  it('wildcard negated name filters (player_qr_t6_*)', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_teleport" "model" "*1" "target" "dest" "spawnflags" "1" "filtername" "def" }
        { "classname" "filter_activator_name" "targetname" "def" "filtername" "player_qr_t6_*" "Negated" "1" }
        { "classname" "info_target" "targetname" "dest" "origin" "5000 0 0" }`,
    });
    ents.playerTargetname = 'player_qr_t6_L';
    step(host, ents);
    expect(host.teleports).toHaveLength(0);
    ents.playerTargetname = 'default';
    step(host, ents);
    expect(host.teleports).toHaveLength(1);
  });

  it('fires OnStartTouch then (next tick, away) OnEndTouch with the player as activator', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_teleport" "model" "*1" "target" "dest" "spawnflags" "1"
          "OnStartTouch" "counter,Add,1,0,-1" "OnEndTouch" "!activator,AddOutput,targetname left,0,-1" }
        { "classname" "math_counter" "targetname" "counter" "startvalue" "0" }
        { "classname" "info_target" "targetname" "dest" "origin" "5000 0 0" }`,
    });
    step(host, ents);
    expect(ents.counterValue('counter')).toBe(1);
    expect(ents.playerTargetname).toBe('');
    step(host, ents);
    expect(ents.playerTargetname).toBe('left');
  });

  it('notifies teleport listeners and keeps natural EndTouch when the host echoes onPlayerTeleported', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_teleport" "model" "*1" "target" "dest" "spawnflags" "1" "OnEndTouch" "!activator,AddOutput,targetname out,0,-1" }
        { "classname" "info_teleport_destination" "targetname" "dest" "origin" "5000 0 0" }`,
    });
    host.onTeleport = () => ents.onPlayerTeleported(); // a core that notifies on every teleport
    const seen: MapTeleportEvent[] = [];
    ents.addTeleportListener((e) => seen.push(e));
    step(host, ents, 2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ classname: 'trigger_teleport', destination: 'dest', seamless: false });
    expect(ents.playerTargetname).toBe('out');
  });

  it('trigger_teleport_relative offsets the player', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `{ "classname" "trigger_teleport_relative" "model" "*1" "teleportoffset" "100 0 50" "spawnflags" "1" }`,
    });
    host.player.velocity.x = 300;
    step(host, ents);
    expect(host.player.origin).toEqual(v3(100, 0, 51));
    expect(host.player.velocity.x).toBe(300);
  });
});

describe('trigger_push', () => {
  const PUSH = `{ "classname" "trigger_push" "model" "*1" "pushdir" "0 90 0" "speed" "400" "spawnflags" "1" }`;

  it('sets base velocity + FL_BASEVELOCITY every touching tick', () => {
    const { host, ents } = setup({ models: TRIG1, entities: PUSH });
    host.advance();
    ents.tick();
    expect(host.player.baseVelocity.x).toBeCloseTo(0, 6);
    expect(host.player.baseVelocity.y).toBeCloseTo(400, 6);
    expect(host.player.flags & FL_BASEVELOCITY).toBeTruthy();
    expect(host.sound.played).toContain('booster');
  });

  it('overlapping pushes add up within a tick', () => {
    const { host, ents } = setup({
      models: { 1: TRIG1[1], 2: TRIG1[1] },
      entities: `${PUSH}
        { "classname" "trigger_push" "model" "*2" "pushdir" "0 0 0" "speed" "100" "spawnflags" "1" }`,
    });
    step(host, ents);
    expect(host.player.baseVelocity.x).toBeCloseTo(100, 6);
    expect(host.player.baseVelocity.y).toBeCloseTo(400, 6);
  });

  it('upward push lifts a grounded player off the ground by 1 unit', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `{ "classname" "trigger_push" "model" "*1" "pushdir" "-90 0 0" "speed" "1000" "spawnflags" "1" }`,
    });
    host.player.onGround = true;
    host.player.flags |= FL_ONGROUND;
    step(host, ents);
    expect(host.player.onGround).toBe(false);
    expect(host.player.flags & FL_ONGROUND).toBe(0);
    expect(host.player.origin.z).toBeCloseTo(2, 6);
    expect(host.player.baseVelocity.z).toBeCloseTo(1000, 6);
  });

  it('push once adds velocity directly and removes the trigger', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `{ "classname" "trigger_push" "targetname" "once" "model" "*1" "pushdir" "-90 0 0" "speed" "500" "spawnflags" "129" }`,
    });
    host.player.onGround = true;
    step(host, ents);
    expect(host.player.velocity.z).toBeCloseTo(500, 6);
    expect(host.player.onGround).toBe(false);
    expect(host.player.flags & FL_BASEVELOCITY).toBe(0);
    expect(ents.describe('once')).toBeNull(); // killed (no longer findable)
    step(host, ents);
    expect(host.player.velocity.z).toBeCloseTo(500, 6);
  });

  it('does not push noclipping players', () => {
    const { host, ents } = setup({ models: TRIG1, entities: PUSH });
    host.player.moveType = MOVETYPE_NOCLIP;
    step(host, ents);
    expect(host.player.baseVelocity.y).toBe(0);
  });

  it('with real movement: base velocity carries the player and turns into velocity on leaving', () => {
    const host = new MockHost(
      {
        world: [FLOOR],
        models: { 1: { mins: [-64, -64, 0], maxs: [64, 64, 128] } },
        entities: `{ "classname" "trigger_push" "model" "*1" "pushdir" "0 0 0" "speed" "800" "spawnflags" "1" }`,
      },
      v3(0, 0, 0.03125),
    );
    const ents = new EntitySystem(host);
    host.entities = ents;
    ents.spawn();
    settle(host);
    const cmd = newUserCmd();
    let maxX = 0;
    for (let i = 0; i < 40; i++) {
      physicsTick(host, cmd, [ents]);
      maxX = Math.max(maxX, host.player.origin.x);
    }
    // pushed out of the 64-unit trigger, then kept going with the converted velocity (friction slows it)
    expect(maxX).toBeGreaterThan(100);
    expect(host.player.baseVelocity.x).toBe(0);
  });
});

describe('trigger_multiple / trigger_once', () => {
  it('OnTrigger respects wait, -1 / trigger_once fire once', () => {
    const { host, ents } = setup({
      models: { 1: TRIG1[1], 2: TRIG1[1], 3: TRIG1[1] },
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1" "wait" "1" "OnTrigger" "c1,Add,1,0,-1" }
        { "classname" "trigger_multiple" "model" "*2" "spawnflags" "1" "wait" "-1" "OnTrigger" "c2,Add,1,0,-1" }
        { "classname" "trigger_once" "targetname" "t_once" "model" "*3" "spawnflags" "1" "OnTrigger" "c3,Add,1,0,-1" }
        { "classname" "math_counter" "targetname" "c1" }
        { "classname" "math_counter" "targetname" "c2" }
        { "classname" "math_counter" "targetname" "c3" }`,
    });
    step(host, ents, 50); // 0.5 s
    expect(ents.counterValue('c1')).toBe(1);
    step(host, ents, 51); // 1.01 s
    expect(ents.counterValue('c1')).toBe(2);
    expect(ents.counterValue('c2')).toBe(1);
    expect(ents.counterValue('c3')).toBe(1);
    expect(ents.describe('t_once')).toBeNull(); // removed after firing
  });

  it('OnTrigger default wait is 0.2 s', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1" "OnTrigger" "c,Add,1,0,-1" }
        { "classname" "math_counter" "targetname" "c" }`,
    });
    step(host, ents, 100); // 1 s -> fires at 0, .2, .4, .6, .8
    expect(ents.counterValue('c')).toBe(5);
  });

  it('player_speedmod via OnStartTouch / OnEndTouch', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1"
          "OnStartTouch" "speedmod,ModifySpeed,1.5,0,-1" "OnEndTouch" "speedmod,ModifySpeed,1,0,-1" }
        { "classname" "player_speedmod" "targetname" "speedmod" }`,
    });
    step(host, ents);
    expect(host.player.laggedMovement).toBe(1.5);
    host.setPos(500, 0, 1);
    step(host, ents);
    expect(host.player.laggedMovement).toBe(1);
  });

  it('onPlayerTeleported clears touches silently and StartTouch fires again', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1" "OnStartTouch" "c,Add,1,0,-1" "OnEndTouch" "e,Add,1,0,-1" }
        { "classname" "math_counter" "targetname" "c" }
        { "classname" "math_counter" "targetname" "e" }`,
    });
    step(host, ents, 3);
    expect(ents.counterValue('c')).toBe(1);
    ents.onPlayerTeleported(); // e.g. !r while standing in the trigger
    step(host, ents);
    expect(ents.counterValue('c')).toBe(2);
    expect(ents.counterValue('e')).toBe(0);
  });

  it('EndTouch fires when a trigger is disabled under the player', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_multiple" "targetname" "t" "model" "*1" "spawnflags" "1" "OnEndTouch" "e,Add,1,0,-1" }
        { "classname" "math_counter" "targetname" "e" }`,
    });
    step(host, ents);
    ents.fireInput('t', 'Disable');
    step(host, ents); // input serviced at the end of this tick
    step(host, ents); // no overlap -> EndTouch
    expect(ents.counterValue('e')).toBe(1);
  });

  it('TouchTest fires OnTouching / OnNotTouching', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_multiple" "targetname" "t" "model" "*1" "spawnflags" "1" "OnTouching" "yes,Add,1,0,-1" "OnNotTouching" "no,Add,1,0,-1" }
        { "classname" "math_counter" "targetname" "yes" }
        { "classname" "math_counter" "targetname" "no" }`,
    });
    step(host, ents);
    ents.fireInput('t', 'TouchTest');
    step(host, ents);
    step(host, ents);
    expect(ents.counterValue('yes')).toBe(1);
    host.setPos(900, 0, 1);
    step(host, ents);
    ents.fireInput('t', 'TouchTest');
    step(host, ents, 2);
    expect(ents.counterValue('no')).toBe(1);
  });
});

describe('trigger_hurt / trigger_gravity', () => {
  it('lethal damage kills immediately; health resets', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `{ "classname" "trigger_hurt" "model" "*1" "damage" "1000" "spawnflags" "1" }`,
    });
    step(host, ents);
    expect(host.kills).toHaveLength(1);
    expect(ents.playerHealth).toBe(100);
  });

  it('player damage filters (SetDamageFilter + filter_damage_type)', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_hurt" "targetname" "hurt" "model" "*1" "damage" "1000" "damagetype" "0" "spawnflags" "1" "StartDisabled" "1" }
        { "classname" "filter_damage_type" "targetname" "nofall" "damagetype" "32" "Negated" "1" }
        { "classname" "filter_damage_type" "targetname" "onlyfall" "damagetype" "32" "Negated" "0" }`,
    });
    ents.fireInput('!player', 'SetDamageFilter', 'onlyfall');
    ents.fireInput('hurt', 'Enable');
    step(host, ents, 3);
    expect(host.kills).toHaveLength(0); // generic damage blocked
    ents.fireInput('!player', 'SetDamageFilter', 'nofall'); // the usual surf "no fall damage" filter
    step(host, ents, 60);
    expect(host.kills.length).toBeGreaterThan(0);
  });

  it('small damage accumulates every half second', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `{ "classname" "trigger_hurt" "model" "*1" "damage" "20" "spawnflags" "1" }`,
    });
    step(host, ents);
    expect(ents.playerHealth).toBe(90);
    step(host, ents, 49);
    expect(ents.playerHealth).toBe(90);
    step(host, ents);
    expect(ents.playerHealth).toBe(80);
    step(host, ents, 500);
    expect(host.kills).toHaveLength(1);
  });

  it('trigger_gravity persists after leaving; AddOutput gravity on the player', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_gravity" "model" "*1" "gravity" "0.4" "spawnflags" "1" }
        { "classname" "logic_relay" "targetname" "r" "OnTrigger" "!activator,AddOutput,gravity 1.5,0,-1" }`,
    });
    step(host, ents);
    expect(host.player.gravityScale).toBeCloseTo(0.4, 6);
    host.setPos(900, 0, 1);
    step(host, ents);
    expect(host.player.gravityScale).toBeCloseTo(0.4, 6);
    ents.fireInput('r', 'Trigger');
    step(host, ents);
    expect(host.player.gravityScale).toBeCloseTo(1.5, 6);
  });
});

describe('entity I/O', () => {
  it('delays and times-to-fire', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_relay" "targetname" "r" "spawnflags" "2"
          "OnTrigger" "c,Add,1,0.5,-1" "OnTrigger" "once,Add,1,0,1" }
        { "classname" "math_counter" "targetname" "c" }
        { "classname" "math_counter" "targetname" "once" }`,
    });
    ents.fireInput('r', 'Trigger');
    step(host, ents);
    expect(ents.counterValue('once')).toBe(1);
    expect(ents.counterValue('c')).toBe(0);
    step(host, ents, 48); // t = 0.49
    expect(ents.counterValue('c')).toBe(0);
    step(host, ents, 2); // t = 0.51 (queued at t = 0.01 + 0.5)
    expect(ents.counterValue('c')).toBe(1);
    ents.fireInput('r', 'Trigger');
    step(host, ents, 60);
    expect(ents.counterValue('once')).toBe(1);
    expect(ents.counterValue('c')).toBe(2);
  });

  it('0-delay chains resolve within one tick; relays block refire until outputs fired', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_relay" "targetname" "a" "OnTrigger" "b,Trigger,,0,-1" }
        { "classname" "logic_relay" "targetname" "b" "OnTrigger" "c,Add,1,0,-1" }
        { "classname" "math_counter" "targetname" "c" }`,
    });
    ents.fireInput('a', 'Trigger');
    ents.fireInput('a', 'Trigger'); // same tick: the relay is waiting for refire
    step(host, ents);
    expect(ents.counterValue('c')).toBe(1);
    step(host, ents); // EnableRefire (0.001 s after the outputs) is serviced here
    ents.fireInput('a', 'Trigger');
    step(host, ents);
    expect(ents.counterValue('c')).toBe(2);
  });

  it('logic_relay Disable/Enable, CancelPending, only-once flag', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_relay" "targetname" "r" "OnTrigger" "c,Add,1,1,-1" }
        { "classname" "logic_relay" "targetname" "once" "spawnflags" "1" "OnTrigger" "c,Add,10,0,-1" }
        { "classname" "math_counter" "targetname" "c" }`,
    });
    ents.fireInput('r', 'Trigger');
    step(host, ents, 10);
    ents.fireInput('r', 'CancelPending');
    step(host, ents, 200);
    expect(ents.counterValue('c')).toBe(0);
    ents.fireInput('r', 'Disable');
    step(host, ents);
    ents.fireInput('r', 'Trigger');
    step(host, ents, 200);
    expect(ents.counterValue('c')).toBe(0);
    ents.fireInput('once', 'Trigger');
    step(host, ents, 2);
    ents.fireInput('once', 'Trigger');
    step(host, ents, 2);
    expect(ents.counterValue('c')).toBe(10);
    expect(ents.describe('once')).toBeNull();
  });

  it('wildcard targets, !self, Kill and classname fallback', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "math_counter" "targetname" "ctr_a" }
        { "classname" "math_counter" "targetname" "ctr_b" }
        { "classname" "logic_relay" "targetname" "r" "OnTrigger" "ctr_*,Add,2,0,-1" "OnTrigger" "!self,Kill,,0.1,-1" }
        { "classname" "logic_relay" "targetname" "p" "OnTrigger" "player,AddOutput,targetname via_class,0,-1" }`,
    });
    ents.fireInput('r', 'Trigger');
    ents.fireInput('p', 'Trigger');
    step(host, ents);
    expect(ents.counterValue('ctr_a')).toBe(2);
    expect(ents.counterValue('ctr_b')).toBe(2);
    expect(ents.playerTargetname).toBe('via_class');
    step(host, ents, 20);
    expect(ents.describe('r')).toBeNull();
  });

  it('same-delay outputs fire in reverse keyvalue order (Source)', () => {
    const { host, ents } = setup({
      entities: `{ "classname" "logic_relay" "targetname" "r"
        "OnTrigger" "!activator,AddOutput,targetname first,0,-1"
        "OnTrigger" "!activator,AddOutput,targetname second,0,-1" }`,
    });
    ents.fireInput('r', 'Trigger');
    step(host, ents);
    expect(ents.playerTargetname).toBe('first');
  });

  it('AddOutput adds output connections at runtime', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_relay" "targetname" "r" }
        { "classname" "math_counter" "targetname" "c" }`,
    });
    ents.fireInput('r', 'AddOutput', 'OnTrigger c:Add:5:0:1');
    step(host, ents);
    ents.fireInput('r', 'Trigger');
    step(host, ents, 2);
    ents.fireInput('r', 'Trigger');
    step(host, ents, 2);
    expect(ents.counterValue('c')).toBe(5);
  });

  it('logic_auto fires OnMapSpawn at spawn; !player targets are absent then', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_auto" "spawnflags" "1" "OnMapSpawn" "c,Add,3,0,-1" "OnNewGame" "!player,AddOutput,targetname early,0,-1" "OnMapSpawn" "late,Trigger,,1,-1" }
        { "classname" "logic_relay" "targetname" "late" "OnTrigger" "!player,AddOutput,targetname late,0,-1" }
        { "classname" "math_counter" "targetname" "c" }`,
    });
    expect(ents.counterValue('c')).toBe(3);
    expect(ents.playerTargetname).toBe('');
    step(host, ents, 101);
    expect(ents.playerTargetname).toBe('late');
  });

  it('player AddOutput: basevelocity, velocity, origin, health', () => {
    const { host, ents } = setup({ entities: `{ "classname" "logic_relay" "targetname" "r" }` });
    ents.fireInput('!player', 'AddOutput', 'basevelocity 0 0 800');
    ents.fireInput('!player', 'AddOutput', 'velocity 10 20 30');
    step(host, ents);
    expect(host.player.baseVelocity).toEqual(v3(0, 0, 800));
    expect(host.player.flags & FL_BASEVELOCITY).toBe(0); // the core converts it into velocity next tick
    expect(host.player.velocity).toEqual(v3(10, 20, 30));
    ents.fireInput('!player', 'AddOutput', 'origin 100 200 300');
    step(host, ents);
    expect(host.player.origin).toEqual(v3(100, 200, 300));
    expect(host.teleports.at(-1)).toMatchObject({ angles: null, velocity: null });
    ents.fireInput('!activator', 'SetHealth', '0');
    step(host, ents);
    expect(host.kills).toHaveLength(1);
    ents.fireInput('!activator', 'Kill');
    step(host, ents);
    expect(host.kills).toHaveLength(2);
    expect(ents.playerHealth).toBe(100);
  });
});

describe('logic_timer / math_counter / logic_case / logic_compare / logic_branch', () => {
  it('logic_timer fires every RefireTime; Disable/Enable/StartDisabled', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_timer" "targetname" "t" "RefireTime" "0.5" "OnTimer" "c,Add,1,0,-1" }
        { "classname" "logic_timer" "targetname" "t2" "RefireTime" "0.1" "StartDisabled" "1" "OnTimer" "d,Add,1,0,-1" }
        { "classname" "math_counter" "targetname" "c" }
        { "classname" "math_counter" "targetname" "d" }`,
    });
    step(host, ents, 100); // 1.0 s -> 0.5, 1.0
    expect(ents.counterValue('c')).toBe(2);
    expect(ents.counterValue('d')).toBe(0);
    ents.fireInput('t', 'Disable');
    ents.fireInput('t2', 'Enable');
    step(host, ents, 100);
    expect(ents.counterValue('c')).toBe(2);
    expect(ents.counterValue('d')).toBeGreaterThanOrEqual(9);
    expect(ents.counterValue('d')).toBeLessThanOrEqual(10);
    ents.fireInput('t', 'FireTimer');
    step(host, ents);
    expect(ents.counterValue('c')).toBe(3);
  });

  it('logic_timer oscillator alternates OnTimerHigh / OnTimerLow', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_timer" "spawnflags" "1" "RefireTime" "0.1" "OnTimerHigh" "h,Add,1,0,-1" "OnTimerLow" "l,Add,1,0,-1" }
        { "classname" "math_counter" "targetname" "h" }
        { "classname" "math_counter" "targetname" "l" }`,
    });
    step(host, ents, 41);
    expect(ents.counterValue('h')).toBe(2);
    expect(ents.counterValue('l')).toBe(2);
  });

  it('math_counter clamps, fires OnHitMax once, passes OutValue as the parameter', () => {
    const { host, ents } = setup({
      models: { 5: { mins: [1000, 1000, 0], maxs: [1100, 1100, 100], solid: true } },
      entities: `
        { "classname" "math_counter" "targetname" "c" "min" "0" "max" "3"
          "OnHitMax" "hits,Add,1,0,-1" "OutValue" "glass,Alpha,,0,-1" }
        { "classname" "math_counter" "targetname" "hits" }
        { "classname" "func_brush" "targetname" "glass" "model" "*5" "rendermode" "4" "renderamt" "0" }`,
    });
    expect(host.renderer.alpha.get(5)).toBe(0);
    for (let i = 0; i < 5; i++) ents.fireInput('c', 'Add', '1');
    step(host, ents);
    expect(ents.counterValue('c')).toBe(3);
    expect(ents.counterValue('hits')).toBe(1);
    expect(host.renderer.alpha.get(5)).toBeCloseTo(3 / 255, 6);
    ents.fireInput('c', 'Subtract', '1');
    ents.fireInput('c', 'Add', '1');
    step(host, ents);
    expect(ents.counterValue('hits')).toBe(2);
    ents.fireInput('c', 'SetValueNoFire', '10');
    step(host, ents);
    expect(ents.counterValue('c')).toBe(3);
    expect(ents.counterValue('hits')).toBe(2);
  });

  it('logic_case, logic_compare, logic_branch', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_case" "targetname" "lc" "Case01" "red" "Case02" "2" "OnCase01" "a,Add,1,0,-1" "OnCase02" "b,Add,1,0,-1" "OnDefault" "d,Add,1,0,-1" }
        { "classname" "logic_compare" "targetname" "cmp" "InitialValue" "1" "CompareValue" "5" "OnLessThan" "a,Add,10,0,-1" "OnEqualTo" "b,Add,10,0,-1" }
        { "classname" "logic_branch" "targetname" "br" "InitialValue" "0" "OnTrue" "d,Add,100,0,-1" "OnFalse" "d,Add,1000,0,-1" }
        { "classname" "math_counter" "targetname" "a" }
        { "classname" "math_counter" "targetname" "b" }
        { "classname" "math_counter" "targetname" "d" }`,
    });
    ents.fireInput('lc', 'InValue', 'RED');
    ents.fireInput('lc', 'InValue', '2.0');
    ents.fireInput('lc', 'InValue', 'blue');
    ents.fireInput('cmp', 'Compare');
    ents.fireInput('cmp', 'SetValueCompare', '5');
    ents.fireInput('br', 'Test');
    ents.fireInput('br', 'ToggleTest');
    step(host, ents);
    expect(ents.counterValue('a')).toBe(11);
    expect(ents.counterValue('b')).toBe(11);
    expect(ents.counterValue('d')).toBe(1101);
  });
});

describe('brush entities', () => {
  it('func_brush toggles collision and visibility; StartDisabled; solidity', () => {
    const { host, ents } = setup({
      models: {
        2: { mins: [100, 0, 0], maxs: [200, 100, 100], solid: true },
        3: { mins: [300, 0, 0], maxs: [400, 100, 100], solid: true },
        4: { mins: [500, 0, 0], maxs: [600, 100, 100], solid: true },
      },
      entities: `
        { "classname" "func_brush" "targetname" "wall" "model" "*2" "solidity" "0" }
        { "classname" "func_brush" "targetname" "hidden" "model" "*3" "solidity" "0" "StartDisabled" "1" }
        { "classname" "func_brush" "targetname" "always" "model" "*4" "solidity" "2" }`,
    });
    expect(host.solidCalls).toContainEqual([3, false]);
    expect(host.renderer.visible.get(3)).toBe(false);
    expect(host.collision.isModelSolid(3)).toBe(false);
    ents.fireInput('wall', 'Toggle');
    ents.fireInput('hidden', 'Enable');
    ents.fireInput('always', 'Disable');
    step(host, ents);
    expect(host.collision.isModelSolid(2)).toBe(false);
    expect(host.renderer.visible.get(2)).toBe(false);
    expect(host.collision.isModelSolid(3)).toBe(true);
    expect(host.renderer.visible.get(3)).toBe(true);
    expect(host.collision.isModelSolid(4)).toBe(true); // solidity 2: always solid
    expect(host.renderer.visible.get(4)).toBe(false);
  });

  it('func_wall_toggle, rendermode 10, render colour, triggers hidden, Kill', () => {
    const { host, ents } = setup({
      models: {
        1: TRIG1[1],
        2: { mins: [100, 0, 0], maxs: [200, 100, 100], solid: true },
        3: { mins: [300, 0, 0], maxs: [400, 100, 100] },
        4: { mins: [500, 0, 0], maxs: [600, 100, 100], solid: true },
      },
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1" }
        { "classname" "func_wall_toggle" "targetname" "jail" "model" "*2" }
        { "classname" "func_illusionary" "model" "*3" "rendermode" "10" "rendercolor" "255 0 0" }
        { "classname" "func_wall" "targetname" "w" "model" "*4" }`,
    });
    expect(host.renderer.visible.get(1)).toBe(false);
    expect(host.renderer.visible.get(3)).toBe(false);
    expect(host.renderer.color.get(3)).toEqual([1, 0, 0]);
    ents.fireInput('jail', 'Toggle');
    ents.fireInput('w', 'Kill');
    step(host, ents);
    expect(host.collision.isModelSolid(2)).toBe(false);
    expect(host.collision.isModelSolid(4)).toBe(false);
    expect(host.renderer.visible.get(4)).toBe(false);
    ents.fireInput('jail', 'Toggle');
    step(host, ents);
    expect(host.collision.isModelSolid(2)).toBe(true);
  });

  it('reapplyRender pushes the whole visual state again', () => {
    const { host, ents } = setup({
      models: { 1: TRIG1[1], 3: { mins: [300, 0, 0], maxs: [400, 100, 100], solid: true } },
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1" }
        { "classname" "func_brush" "targetname" "b" "model" "*3" "rendermode" "2" "renderamt" "128" }`,
    });
    ents.fireInput('b', 'Disable');
    step(host, ents);
    host.renderer.visible.clear();
    host.renderer.alpha.clear();
    ents.reapplyRender();
    expect(host.renderer.visible.get(1)).toBe(false);
    expect(host.renderer.visible.get(3)).toBe(false);
    expect(host.renderer.alpha.get(3)).toBeCloseTo(128 / 255, 6);
  });

  it('func_button: +use within reach fires OnPressed, returns after wait; locked buttons', () => {
    const { host, ents } = setup(
      {
        models: { 7: { mins: [60, -16, 40], maxs: [70, 16, 80], solid: true } },
        entities: `
          { "classname" "func_button" "targetname" "btn" "model" "*7" "spawnflags" "1025" "wait" "1"
            "OnPressed" "c,Add,1,0,-1" "OnOut" "o,Add,1,0,-1" "OnUseLocked" "l,Add,1,0,-1" }
          { "classname" "math_counter" "targetname" "c" }
          { "classname" "math_counter" "targetname" "o" }
          { "classname" "math_counter" "targetname" "l" }`,
      },
      0,
      0,
      0,
    );
    const eye = v3(0, 0, 64);
    expect(ents.pressUse(eye, v3(0, 1, 0))).toBe(false); // looking away
    expect(ents.pressUse(eye, v3(1, 0, -0.2))).toBe(true);
    step(host, ents);
    expect(ents.counterValue('c')).toBe(1);
    expect(ents.pressUse(eye, v3(1, 0, -0.2))).toBe(true); // already in: ignored
    step(host, ents, 101);
    expect(ents.counterValue('c')).toBe(1);
    expect(ents.counterValue('o')).toBe(1);
    ents.fireInput('btn', 'Lock');
    step(host, ents);
    ents.pressUse(eye, v3(1, 0, -0.2));
    step(host, ents);
    expect(ents.counterValue('l')).toBe(1);
    // out of reach
    host.setPos(-200, 0, 0);
    expect(ents.pressUse(v3(-200, 0, 64), v3(1, 0, 0))).toBe(false);
  });
});

describe('point_template', () => {
  it('removes template entities at load and ForceSpawn creates fixed-up copies', () => {
    const { host, ents } = setup({
      models: { 1: TRIG1[1], 5: { mins: [300, 0, 0], maxs: [400, 100, 100], solid: true } },
      entities: `
        { "classname" "point_template" "targetname" "tmpl" "Template01" "tp" "Template02" "wall" "Template03" "relay" "OnEntitySpawned" "spawned,Add,1,0,-1" }
        { "classname" "trigger_teleport" "targetname" "tp" "model" "*1" "target" "dest" "spawnflags" "1" }
        { "classname" "func_brush" "targetname" "wall" "model" "*5" }
        { "classname" "logic_relay" "targetname" "relay" "OnTrigger" "tp,Disable,,0,-1" }
        { "classname" "info_target" "targetname" "dest" "origin" "5000 0 0" }
        { "classname" "math_counter" "targetname" "spawned" }`,
    });
    expect(host.renderer.visible.get(5)).toBe(false);
    expect(host.collision.isModelSolid(5)).toBe(false);
    step(host, ents, 3);
    expect(host.teleports).toHaveLength(0); // the template teleport doesn't exist yet
    expect(ents.findTarget('tp')).toBeNull();
    ents.fireInput('tmpl', 'ForceSpawn');
    step(host, ents);
    expect(ents.counterValue('spawned')).toBe(1);
    expect(ents.describe('tp&0001')?.classname).toBe('trigger_teleport');
    expect(host.renderer.visible.get(5)).toBe(true);
    expect(host.collision.isModelSolid(5)).toBe(true);
    step(host, ents);
    expect(host.teleports).toHaveLength(1);
    // the copied relay targets the copied teleport
    ents.fireInput('relay&0001', 'Trigger');
    step(host, ents);
    host.setPos(0, 0, 1);
    step(host, ents, 3);
    expect(host.teleports).toHaveLength(1);
    expect(ents.describe('tp&0001')?.enabled).toBe(false);
    expect(ents.debugTriggers()).toHaveLength(1);
  });

  it('keeps template entities with "don\'t remove", keeps names with "preserve names"', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "point_template" "targetname" "keep" "spawnflags" "1" "Template01" "c1" }
        { "classname" "point_template" "targetname" "named" "spawnflags" "2" "Template01" "c2" }
        { "classname" "math_counter" "targetname" "c1" }
        { "classname" "math_counter" "targetname" "c2" }`,
    });
    expect(ents.counterValue('c1')).toBe(0);
    expect(ents.counterValue('c2')).toBeNull();
    ents.fireInput('named', 'ForceSpawn');
    step(host, ents);
    expect(ents.counterValue('c2')).toBe(0);
  });
});

describe('point entities', () => {
  it('env_hudhint, game_text, point_servercommand say', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_multiple" "model" "*1" "spawnflags" "1"
          "OnStartTouch" "hint,ShowHudHint,,0,-1" "OnStartTouch" "txt,Display,,0,-1" "OnStartTouch" "srv,Command,say Stage 2 unlocked,0,-1"
          "OnStartTouch" "srv,Command,sv_airaccelerate 1000,0,-1" }
        { "classname" "env_hudhint" "targetname" "hint" "message" "Stage 1" }
        { "classname" "game_text" "targetname" "txt" "message" "Line1\\nLine2" "holdtime" "3" }
        { "classname" "point_servercommand" "targetname" "srv" }`,
    });
    step(host, ents);
    expect(host.ui.hints).toEqual([{ text: 'Stage 1', seconds: undefined }]);
    expect(host.ui.centers[0].text).toBe('Line1\nLine2');
    expect(host.chatText()).toEqual(['Console: Stage 2 unlocked']);
  });

  it('SetFogController on the player reports the env_fog_controller', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "env_fog_controller" "targetname" "fog_sea" "fogenable" "1" "fogcolor" "0 51 102" "fogstart" "100" "fogend" "2000" "fogmaxdensity" "0.8" }`,
    });
    const seen: unknown[] = [];
    ents.onFogController = (f) => seen.push(f);
    ents.fireInput('!player', 'SetFogController', 'fog_sea');
    ents.fireInput('!player', 'SetFogController', 'missing');
    step(host, ents);
    expect(seen).toEqual([{ name: 'fog_sea', enabled: true, color: [0, 0.2, 0.4], start: 100, end: 2000, maxDensity: 0.8 }]);
  });

  it('point_teleport moves the player (velocity kept)', () => {
    const { host, ents } = setup({
      entities: `{ "classname" "point_teleport" "targetname" "pt" "target" "!activator" "origin" "300 0 50" "angles" "0 45 0" }`,
    });
    host.player.velocity.x = 123;
    ents.fireInput('pt', 'Teleport');
    step(host, ents);
    expect(host.player.origin).toEqual(v3(300, 0, 50));
    expect(host.player.viewAngles.yaw).toBe(45);
    expect(host.player.velocity.x).toBe(123);
  });

  it('findTarget and debugTriggers', () => {
    const { host, ents } = setup({
      models: TRIG1,
      entities: `
        { "classname" "trigger_teleport" "targetname" "tp" "model" "*1" "target" "dest" "spawnflags" "1" "StartDisabled" "1" }
        { "classname" "info_teleport_destination" "targetname" "Dest" "origin" "1 2 3" "angles" "0 90 0" }`,
    });
    expect(ents.findTarget('dest')).toEqual({ origin: v3(1, 2, 3), angles: { pitch: 0, yaw: 90, roll: 0 } });
    expect(ents.findTarget('nope')).toBeNull();
    const dbg = ents.debugTriggers();
    expect(dbg).toHaveLength(1);
    expect(dbg[0]).toMatchObject({ classname: 'trigger_teleport', enabled: false, mins: v3(-50, -50, 0), maxs: v3(50, 50, 100) });
    ents.fireInput('tp', 'Kill');
    step(host, ents);
    expect(ents.debugTriggers()).toHaveLength(0);
  });
});

describe('diagnostics', () => {
  let saved = '0';
  beforeEach(() => {
    saved = console_.getCvar('developer')?.value ?? '0';
  });
  afterEach(() => {
    console_.getCvar('developer')?.set(saved);
  });

  it('reports unknown inputs once (developer 1), never for silent/common ones', () => {
    const { host, ents } = setup({
      entities: `
        { "classname" "logic_relay" "targetname" "r" }
        { "classname" "prop_dynamic" "targetname" "prop" }`,
    });
    console_.getCvar('developer')!.set(1);
    ents.fireInput('r', 'Frobnicate');
    ents.fireInput('r', 'Frobnicate');
    ents.fireInput('prop', 'SetAnimation', 'open');
    ents.fireInput('prop', 'Enable');
    ents.fireInput('missing_target', 'Trigger');
    step(host, ents);
    const d = ents.diagnostics();
    expect(d.unknownInputs.get('logic_relay.frobnicate')).toBe(2);
    expect(d.unknownInputs.has('prop_dynamic.setanimation')).toBe(false);
    expect(d.missingTargets.get('missing_target')).toBe(1);
    expect(host.prints.filter((p) => p.includes('Frobnicate'))).toHaveLength(1);
  });

  it('prints nothing with developer 0', () => {
    const { host, ents } = setup({ entities: `{ "classname" "logic_relay" "targetname" "r" }` });
    console_.getCvar('developer')!.set(0);
    ents.fireInput('r', 'Bogus');
    step(host, ents);
    expect(host.prints).toHaveLength(0);
  });
});
