import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { registerConvars } from '../src/game/convars';
import { setRecordsStorage } from '../src/game/records';
import { LoadedMap } from '../src/map/types';
import { setCatalog } from '../src/maps/catalog';
import { setZonesFile } from '../src/maps/zones';
import { loadBspMap } from '../src/bsp/loadmap';
import { HULL_MAXS, HULL_MINS } from '../src/physics/playertypes';
import { MASK_PLAYERSOLID } from '../src/physics/types';
import { MemStore, makeGame } from './gamecore_helpers';

const DIR = process.env.SURF_TEST_MAPS ?? '';
async function load(name: string): Promise<LoadedMap> {
  const buf = readFileSync(join(DIR, `${name}.bsp`));
  return loadBspMap(name, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}
beforeAll(() => {
  registerConvars();
  const root = join(__dirname, '..', 'public', 'maps');
  setZonesFile(JSON.parse(readFileSync(join(root, 'zones.json'), 'utf8')));
  setCatalog(JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')).maps);
});
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
});
const f = (n: number) => n.toFixed(1);
const hs = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);

async function game(name: string) {
  setRecordsStorage(new MemStore());
  const map = await load(name);
  const t = makeGame(map, { buildBuiltin: async () => map, builtinMaps: async () => [] });
  await t.game.loadBuiltinMap(name);
  return { t, s: t.game.session!, map };
}

describe('audit game', () => {
  it.skip('beginner: prespeed + stages + fail + kill', async () => {
    if (!existsSync(join(DIR, 'surf_beginner.bsp'))) return;
    const { t, s } = await game('surf_beginner');
    const g = t.game;
    const ps = s.player;
    console.log('spawn', ps.origin, 'view', g.getViewAngles(), 'state', s.timer.getHud().state);
    g.runTicks(50);
    console.log('after settle', ps.origin, 'onGround', ps.onGround, s.timer.getHud().state);
    // prespeed test: give 700 u/s toward +y (yaw 90) while holding +forward
    ps.velocity.x = 0; ps.velocity.y = 700;
    g.executeCommand('+forward');
    let prevState = s.timer.getHud().state;
    for (let i = 0; i < 200; i++) {
      g.runTicks(1);
      const st = s.timer.getHud().state;
      if (st !== prevState) {
        console.log(`tick ${i}: ${prevState} -> ${st} speed=${f(hs(ps.velocity))} pos=${f(ps.origin.y)}`);
        prevState = st;
      }
      if (st === 'running' && i > 0) { g.runTicks(1); console.log('next tick speed', f(hs(ps.velocity))); break; }
    }
    g.executeCommand('-forward');
    // bhop inside start zone: !r, hold jump + forward and strafe with turn
    g.say('/r');
    g.runTicks(20);
    ps.velocity.x = 0; ps.velocity.y = 0;
    g.setViewAngles(0, 0);
    // jump in place a few times with high speed sideways inside zone (zone x -447..191)
    ps.velocity.x = -600;
    g.executeCommand('+jump');
    for (let i = 0; i < 40; i++) {
      g.runTicks(1);
      if (i % 5 === 0) console.log(`bhop tick ${i} speed=${f(hs(ps.velocity))} x=${f(ps.origin.x)} z=${f(ps.origin.z)} st=${s.timer.getHud().state} ground=${ps.onGround}`);
    }
    g.executeCommand('-jump');
    // stage flow
    g.say('/r');
    g.runTicks(5);
    // start a run by teleporting out of the zone upward (simulate leaving)
    g.teleportPlayer(v3(-128, 600, 330), null, null);
    g.runTicks(2);
    console.log('state after leaving', s.timer.getHud().state);
    // touch stage1->2 trigger #47 box=[-240,2000,-384]-[-16,2008,-144]
    g.teleportPlayer(v3(-128, 2004, -300), null, v3(0, 300, 0));
    g.runTicks(3);
    let h = s.timer.getHud();
    console.log('after stage2 teleport', ps.origin, 'stage', h.stage, 'time', f(h.time), 'stageTime', f(h.stageTime), 'last chat', t.ui.lastText());
    g.runTicks(100);
    // fail into #48 box=[1024,2144,-128]-[4032,4384,-120]
    g.teleportPlayer(v3(2000, 3000, -125), null, null);
    g.runTicks(3);
    h = s.timer.getHud();
    console.log('after stage2 fail', ps.origin, 'stage', h.stage, 'time', f(h.time), 'stageTime', f(h.stageTime), 'state', h.state);
    // trigger_hurt #105 box=[-392,4208,-32]-[-232,4656,16]
    g.teleportPlayer(v3(-300, 4400, -20), null, null);
    g.runTicks(3);
    h = s.timer.getHud();
    console.log('after hurt', ps.origin, 'stage', h.stage, 'time', f(h.time), 'state', h.state, 'health', (s.entities as any).playerHealth);
    console.log('chat:', t.ui.texts().slice(-6));
    t.game.disconnect();
  }, 120000);

  it('utopia_njv: end reachable?', async () => {
    if (!existsSync(join(DIR, 'surf_utopia_njv.bsp'))) return;
    const { t, s } = await game('surf_utopia_njv');
    const g = t.game;
    const ps = s.player;
    console.log('utopia spawn', ps.origin, g.getViewAngles(), s.timer.getHud().state, s.timer.zoneSource);
    g.runTicks(10);
    g.teleportPlayer(v3(-13000, 0, 12820), null, null); // leave start zone forward
    g.runTicks(3);
    console.log('utopia after leaving', s.timer.getHud().state);
    // land on the end ledge and walk into the back wall
    g.teleportPlayer(v3(-14000, 0, -6200), { pitch: 0, yaw: 180, roll: 0 }, v3(-300, 0, 0));
    g.executeCommand('+forward');
    const states: string[] = [];
    for (let i = 0; i < 400; i++) {
      g.runTicks(1);
      const st = s.timer.getHud().state;
      if (!states.length || !states[states.length-1].startsWith(st + '@')) states.push(`${st}@${i} x=${f(ps.origin.x)} y=${f(ps.origin.y)} z=${f(ps.origin.z)}`);
    }
    g.executeCommand('-forward');
    console.log('utopia end-ledge states', states, t.ui.texts().slice(-3));
    t.game.disconnect();
  }, 120000);

  it('lt_omnific + kitsune + rookie: !s N spawns', async () => {
    for (const name of (process.env.AUDIT_MAPS ?? 'surf_kitsune,surf_rookie').split(',')) {
      if (!existsSync(join(DIR, `${name}.bsp`))) continue;
      const { t, s, map } = await game(name);
      const g = t.game;
      const ps = s.player;
      const zones = s.timer.getZones();
      const stages = zones.filter((z) => z.type === 'stage' && z.group === 0).map((z) => z.index).sort((a, b) => a - b);
      for (const n of stages) {
        g.say(`/s ${n}`);
        const o0 = { ...ps.origin };
        const stuck0 = map.collision.testBox(ps.origin, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
        g.runTicks(60);
        const z = zones.find((q) => q.type === 'stage' && q.index === n)!;
        const inZ = ps.origin.x + 16 > z.mins.x && ps.origin.x - 16 < z.maxs.x && ps.origin.y + 16 > z.mins.y && ps.origin.y - 16 < z.maxs.y && ps.origin.z + 72 > z.mins.z && ps.origin.z < z.maxs.z;
        const h = s.timer.getHud();
        console.log(`${name} !s ${n}: tp=(${f(o0.x)},${f(o0.y)},${f(o0.z)}) stuckAtTp=${stuck0} after60=(${f(ps.origin.x)},${f(ps.origin.y)},${f(ps.origin.z)}) ground=${ps.onGround} inZone=${inZ} hudStage=${h.stage} state=${h.state} yaw=${f(g.getViewAngles().yaw)} tn='${s.entities.playerTargetname}' last='${t.ui.lastText()}'`);
      }
      t.game.disconnect();
    }
  }, 300000);
});
