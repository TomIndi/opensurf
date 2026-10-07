// Built-in procedural maps (src/map/builtin): structure of the generated LoadedMap, geometry rules (surf faces,
// seams, spawns, zones, triggers, the void), and simulated runs with the real movement code, triggers and
// surf timer: the spec's literal first-ramp bot, a full autopilot run at 64/100/128 tick in several surfing
// styles, a run from every checkpoint/stage restart, every bonus (from !b N, and the spawn room's bonus
// teleporter), and a ballistic feasibility table of every gap.
import { beforeAll, describe, expect, it } from 'vitest';
import { QAngle, qa } from '../src/core/angles';
import { Vec3, v3 } from '../src/core/vec3';
import { EntitySystem } from '../src/game/entities';
import { RecordsStorage, setRecordsStorage } from '../src/game/records';
import { SurfTimer } from '../src/game/timer';
import { analyzeGaps, formatGapTable } from '../src/map/builtin/analysis';
import { Autopilot, AutopilotOptions } from '../src/map/builtin/autopilot';
import { MapBuilder, RAMP_MAX_NZ, RAMP_MIN_NZ, rampHeightFor } from '../src/map/builtin/builder';
import { BuiltCourse, RampChain, rampFrame, rampLength, rampPoint } from '../src/map/builtin/course';
import { BUILTIN_MAPS, buildBuiltinCourse, buildBuiltinMap } from '../src/map/builtin/index';
import { addSign, predictFlight, pushVector, signWidth } from '../src/map/builtin/parts';
import { LoadedMap } from '../src/map/types';
import { boxIntersectsBrush, CollisionWorld } from '../src/physics/collision';
import { brushWindings } from '../src/physics/brushbuild';
import { categorizePosition, defaultMoveVars, playerMove, unstuckPlayer } from '../src/physics/movement';
import {
  FL_BASEVELOCITY,
  HULL_MAXS,
  HULL_MINS,
  PlayerState,
  createPlayerState,
  newMoveEvents,
  newUserCmd,
} from '../src/physics/playertypes';
import { CONTENTS_SOLID, MASK_PLAYERSOLID, newTrace } from '../src/physics/types';

// ------------------------------------------------------------------------------------------ test harness

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

const noop = (): void => {};

/** A TimerHost around a built-in map: real entity system + surf timer, stubbed renderer/ui/sound. */
class Host {
  player: PlayerState;
  collision: CollisionWorld;
  renderer = {
    setModelVisible: noop,
    setModelAlpha: noop,
    setModelColor: noop,
    setZones: noop,
    setGhosts: noop,
    setSettings: noop,
    render: noop,
    resize: noop,
    setDebugBoxes: noop,
    stats: () => ({ drawCalls: 0, triangles: 0, textures: 0 }),
    loadMap: async () => {},
    unloadMap: noop,
  };
  ui = { chat: noop, hint: noop, centerPrint: noop, setLoading: noop, showMenu: noop, isTyping: () => false, toggleConsole: noop, openChat: noop, setScoreboardVisible: noop, updateHud: noop };
  sound = { unlock: noop, play: noop, setWind: noop, setMasterVolume: noop };
  moveVars = defaultMoveVars();
  time = 0;
  tickInterval: number;
  tickCount = 0;
  customPhysics = false;
  tier = 1;
  entities!: EntitySystem;
  timer!: SurfTimer;
  teleports: Vec3[] = [];
  chats: string[] = [];
  constructor(
    public map: LoadedMap,
    tick: number,
  ) {
    this.tickInterval = 1 / tick;
    this.collision = map.collision;
    this.player = createPlayerState(map.spawns[0].origin, map.spawns[0].angles);
  }
  teleportPlayer(origin: Vec3, angles: QAngle | null, velocity: Vec3 | null): void {
    const ps = this.player;
    ps.origin.x = origin.x;
    ps.origin.y = origin.y;
    ps.origin.z = origin.z;
    if (angles) {
      ps.viewAngles.pitch = angles.pitch;
      ps.viewAngles.yaw = angles.yaw;
      ps.viewAngles.roll = 0;
    }
    if (velocity) {
      ps.velocity.x = velocity.x;
      ps.velocity.y = velocity.y;
      ps.velocity.z = velocity.z;
    }
    unstuckPlayer(ps, this.collision);
    categorizePosition(ps, this.collision, this.moveVars);
    this.teleports.push({ ...origin });
  }
  killPlayer(): void {
    this.timer.onPlayerKilled();
  }
  chat(segs: { text: string }[]): void {
    this.chats.push(segs.map((s) => s.text).join(''));
  }
  print(): void {}
}

interface RunResult {
  finished: boolean;
  /** Fail teleports (back to the current or an earlier section). */
  fails: string[];
  time: number;
  pilot: Autopilot;
  host: Host;
  maxSpeed: number;
  /** Worst single-tick speed loss while surfing (landing impacts excluded). */
  worstSurfLoss: number;
  /** With `afterFinish`: the player came to rest on the end platform (no teleport after finishing). */
  restedAtEnd: boolean;
}

/** A host on a built map with the entity system and timer running, zones loaded, the player at the spawn. */
function newHost(bc: BuiltCourse, tick: number): Host {
  const host = new Host(bc.map, tick);
  host.entities = new EntitySystem(host as never);
  host.timer = new SurfTimer(host as never);
  host.entities.spawn();
  host.timer.setZones(bc.map.zones, 'builtin');
  return host;
}

/**
 * Runs the autopilot through a built map: the main course (from the start, or from section `section`'s restart
 * point) or bonus `group` (from its start, as after !b N).
 */
function runCourse(
  bc: BuiltCourse,
  o: { tick?: number; pilot?: AutopilotOptions; section?: number; maxTime?: number; offset?: Vec3; group?: number; afterFinish?: number } = {},
): RunResult {
  const tick = o.tick ?? 100;
  const host = newHost(bc, tick);
  const course = o.group ? bc.bonuses[o.group - 1] : bc.course;
  host.timer.restart(course.group);
  const pilot = new Autopilot(course, bc.map.collision, o.pilot ?? {});
  const dests = course.sections.map((s) => bc.builder.destination(s.dest)!);
  if (o.section) {
    const d = dests[o.section];
    const off = o.offset ?? v3();
    host.teleportPlayer(v3(d.origin.x + off.x, d.origin.y + off.y, d.origin.z + off.z), qa(0, d.yaw, 0), v3());
    pilot.resetToSection(o.section);
  }
  host.teleports.length = 0;
  const ps = host.player;
  const cmd = newUserCmd();
  const ev = newMoveEvents();
  const ft = host.tickInterval;
  const fails: string[] = [];
  let finished = false;
  let maxSpeed = 0;
  let worstSurfLoss = 0;
  let prevSpeed = -1;
  const maxTicks = Math.round((o.maxTime ?? 150) / ft);
  let stopAt = maxTicks;
  let tpAtFinish = 0;
  for (let i = 0; i < stopAt; i++) {
    host.tickCount++;
    host.time = host.tickCount * ft;
    // base velocity hand-off (ARCHITECTURE tick order, step 2)
    if (!(ps.flags & FL_BASEVELOCITY)) {
      ps.velocity.x += ps.baseVelocity.x * (1 + ft * 0.5);
      ps.velocity.y += ps.baseVelocity.y * (1 + ft * 0.5);
      ps.velocity.z += ps.baseVelocity.z * (1 + ft * 0.5);
      ps.baseVelocity.x = ps.baseVelocity.y = ps.baseVelocity.z = 0;
    }
    ps.flags &= ~FL_BASEVELOCITY;
    pilot.think(ps, cmd, ft);
    playerMove(ps, cmd, host.collision, host.moveVars, ft, ev);
    const sp = Math.hypot(ps.velocity.x, ps.velocity.y, ps.velocity.z);
    maxSpeed = Math.max(maxSpeed, Math.hypot(ps.velocity.x, ps.velocity.y));
    const last = pilot.events[pilot.events.length - 1];
    const sinceLand = last && last.kind === 'land' ? pilot.time - last.time : 99;
    if (pilot.mode === 'surf' && !pilot.holding && sinceLand > 0.12 && prevSpeed >= 0) worstSurfLoss = Math.max(worstSurfLoss, prevSpeed - sp);
    prevSpeed = sp;
    const nTp = host.teleports.length;
    host.entities.tick();
    host.timer.tick();
    if (host.teleports.length > nTp) {
      const t = host.teleports[host.teleports.length - 1];
      let si = -1;
      dests.forEach((d, k) => {
        if (Math.hypot(d.origin.x - t.x, d.origin.y - t.y, d.origin.z - t.z) < 1) si = k;
      });
      const cur = pilot.ramps[pilot.cur]?.section ?? 0;
      if (si <= cur) fails.push(`t=${host.time.toFixed(2)} ramp "${pilot.ramps[pilot.cur]?.ramp.name}" (${pilot.mode}) -> section ${si}`);
      pilot.resetToSection(Math.max(0, si));
      prevSpeed = -1;
      if (fails.length > 3) break;
    }
    if (!finished && host.timer.getHud().state === 'finished') {
      finished = true;
      tpAtFinish = host.teleports.length;
      // keep going (the pilot walks to the finish point) to see where the run comes to rest
      stopAt = i + 1 + Math.round((o.afterFinish ?? 0) / ft);
    }
  }
  const restedAtEnd = finished && host.teleports.length === tpAtFinish && ps.onGround && Math.abs(ps.origin.z - course.finish.z) < 2 && Math.hypot(ps.velocity.x, ps.velocity.y) < 300;
  return { finished, fails, time: host.timer.getHud().time, pilot, host, maxSpeed, worstSurfLoss, restedAtEnd };
}

function hullFree(map: LoadedMap, p: Vec3): boolean {
  return !map.collision.testBox(p, HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID);
}

/** Distance from `p` straight down (hull trace) to whatever is below, or Infinity. */
function floorBelow(map: LoadedMap, p: Vec3, depth = 4096): number {
  const tr = newTrace();
  map.collision.traceBox(p, v3(p.x, p.y, p.z - depth), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
  return tr.fraction < 1 ? p.z - tr.endpos.z : Infinity;
}

function insideBox(p: Vec3, mins: Vec3, maxs: Vec3, pad = 0): boolean {
  return p.x >= mins.x - pad && p.x <= maxs.x + pad && p.y >= mins.y - pad && p.y <= maxs.y + pad && p.z >= mins.z - pad && p.z <= maxs.z + pad;
}

beforeAll(() => {
  setRecordsStorage(new MemStore());
});

// ------------------------------------------------------------------------------------------ the maps

describe('built-in map list', () => {
  it('lists three original maps with tiers and types', () => {
    expect(BUILTIN_MAPS.map((m) => m.id)).toEqual(['surf_tutorial', 'surf_neon', 'surf_skyline']);
    for (const m of BUILTIN_MAPS) {
      expect(m.name).toBe(m.id);
      expect(m.description.length).toBeGreaterThan(20);
      expect([1, 2, 3]).toContain(m.tier);
    }
    expect(BUILTIN_MAPS.find((m) => m.id === 'surf_neon')!.type).toBe('staged');
    expect(BUILTIN_MAPS.find((m) => m.id === 'surf_tutorial')!.type).toBe('linear');
  });

  it('builds by id, with or without the surf_ prefix, and rejects unknown ids', () => {
    expect(buildBuiltinMap('tutorial').name).toBe('surf_tutorial');
    expect(buildBuiltinMap('SURF_NEON').name).toBe('surf_neon');
    expect(() => buildBuiltinMap('surf_nope')).toThrow(/Unknown built-in map/);
  });

  it('is deterministic: two builds produce identical geometry and entities', () => {
    const a = buildBuiltinMap('surf_skyline');
    const b = buildBuiltinMap('surf_skyline');
    expect(a.entities.map((e) => e.kv)).toEqual(b.entities.map((e) => e.kv));
    expect(a.models.length).toBe(b.models.length);
    expect(a.render.batches.length).toBe(b.render.batches.length);
    for (let i = 0; i < a.render.batches.length; i++) expect(Array.from(a.render.batches[i].positions)).toEqual(Array.from(b.render.batches[i].positions));
  });
});

for (const info of BUILTIN_MAPS) {
  describe(`${info.id} (tier ${info.tier}, ${info.type})`, () => {
    let bc: BuiltCourse;
    let map: LoadedMap;
    beforeAll(() => {
      const t0 = performance.now();
      bc = buildBuiltinCourse(info.id);
      map = bc.map;
      // generation is part of the loading screen: keep it quick
      expect(performance.now() - t0).toBeLessThan(5000);
    });

    it('is a complete LoadedMap', () => {
      expect(map.name).toBe(info.id);
      expect(map.source).toBe('builtin');
      expect(map.zoneSource).toBe('builtin');
      expect(map.warnings).toEqual([]);
      expect(map.collision).toBeInstanceOf(CollisionWorld);
      // worldspawn first, with a sky
      expect(map.entities[0].classname).toBe('worldspawn');
      expect(map.entities[0].kv.skyname).toBeTruthy();
      expect(map.render.sky.name).toBe(map.entities[0].kv.skyname);
      expect(map.render.sky.faces).toBeNull();
      expect(map.render.sky3d).toBeNull();
      expect(map.render.lightmap).toBeNull();
      expect(map.render.fog?.enabled).toBe(true);
      map.entities.forEach((e, i) => expect(e.index).toBe(i));
      // spawns mirror info_player_counterterrorist entities
      const cts = map.entities.filter((e) => e.classname === 'info_player_counterterrorist');
      expect(cts.length).toBe(map.spawns.length);
      expect(map.spawns.length).toBeGreaterThan(0);
      // models[0] is the world; collision holds exactly the world brushes
      expect(map.models[0].index).toBe(0);
      expect(map.models[0].brushes.length).toBeGreaterThan(10);
      expect(map.collision.brushes).toBe(map.models[0].brushes);
      for (const b of map.models[0].brushes) {
        expect(b.model).toBe(0);
        expect(b.contents).toBe(CONTENTS_SOLID);
      }
      // every brush entity "*N" has its model with brushes tagged N, and every model > 0 has an entity
      const brushEnts = map.entities.filter((e) => e.model > 0);
      expect(brushEnts.length).toBe(map.models.length - 1);
      for (const e of brushEnts) {
        expect(e.kv.model).toBe(`*${e.model}`);
        const m = map.models[e.model];
        expect(m.index).toBe(e.model);
        expect(m.brushes.length).toBeGreaterThan(0);
        for (const b of m.brushes) {
          expect(b.model).toBe(e.model);
          // trigger volumes never block movement
          expect(b.contents & MASK_PLAYERSOLID).toBe(0);
        }
      }
      // Source map limits
      for (const k of ['x', 'y', 'z'] as const) {
        expect(map.worldMins[k]).toBeGreaterThanOrEqual(-16384);
        expect(map.worldMaxs[k]).toBeLessThanOrEqual(16384);
        expect(map.worldMins[k]).toBeLessThan(map.worldMaxs[k]);
      }
      for (const m of map.models) {
        for (const b of m.brushes) {
          expect(insideBox(b.mins, map.worldMins, map.worldMaxs, 0.01)).toBe(true);
          expect(insideBox(b.maxs, map.worldMins, map.worldMaxs, 0.01)).toBe(true);
        }
      }
    });

    it('render batches are well formed, with planar world-space UVs and generated materials', () => {
      const r = map.render;
      expect(r.batches.length).toBeGreaterThan(3);
      let tris = 0;
      for (const b of r.batches) {
        expect(b.model).toBe(0);
        const m = r.materials.get(b.material)!;
        expect(m).toBeTruthy();
        expect(m.name).toBe(b.material);
        expect(b.material.startsWith('builtin/')).toBe(true);
        expect(m.image).not.toBeNull();
        expect(m.isTool || m.isSky).toBe(false);
        const nv = b.positions.length / 3;
        expect(b.normals.length).toBe(nv * 3);
        expect(b.uvs.length).toBe(nv * 2);
        expect(b.lightmapUVs).toBeNull();
        expect(b.indices.length % 3).toBe(0);
        for (const i of b.indices) expect(i).toBeLessThan(nv);
        for (let i = 0; i < nv; i++) {
          const nl = Math.hypot(b.normals[i * 3], b.normals[i * 3 + 1], b.normals[i * 3 + 2]);
          expect(nl).toBeCloseTo(1, 4);
          expect(Number.isFinite(b.uvs[i * 2]) && Number.isFinite(b.uvs[i * 2 + 1])).toBe(true);
          const x = b.positions[i * 3];
          const y = b.positions[i * 3 + 1];
          const z = b.positions[i * 3 + 2];
          expect(x >= b.mins.x - 0.01 && x <= b.maxs.x + 0.01 && y >= b.mins.y - 0.01 && y <= b.maxs.y + 0.01 && z >= b.mins.z - 0.01 && z <= b.maxs.z + 0.01).toBe(true);
        }
        // triangles face their normals (counter-clockwise from the front)
        for (let t = 0; t < b.indices.length; t += 3) {
          const [i0, i1, i2] = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
          const p = (i: number): Vec3 => v3(b.positions[i * 3], b.positions[i * 3 + 1], b.positions[i * 3 + 2]);
          const a = p(i0);
          const e1 = v3(p(i1).x - a.x, p(i1).y - a.y, p(i1).z - a.z);
          const e2 = v3(p(i2).x - a.x, p(i2).y - a.y, p(i2).z - a.z);
          const cx = e1.y * e2.z - e1.z * e2.y;
          const cy = e1.z * e2.x - e1.x * e2.z;
          const cz = e1.x * e2.y - e1.y * e2.x;
          const d = cx * b.normals[i0 * 3] + cy * b.normals[i0 * 3 + 1] + cz * b.normals[i0 * 3 + 2];
          expect(d).toBeGreaterThanOrEqual(-1e-3);
        }
        // UVs: one texture unit per world unit, divided by the material size (planar per face)
        for (let t = 0; t < Math.min(b.indices.length, 300); t += 3) {
          const i0 = b.indices[t];
          const i1 = b.indices[t + 1];
          const dp = Math.hypot(b.positions[i1 * 3] - b.positions[i0 * 3], b.positions[i1 * 3 + 1] - b.positions[i0 * 3 + 1], b.positions[i1 * 3 + 2] - b.positions[i0 * 3 + 2]);
          const du = Math.hypot((b.uvs[i1 * 2] - b.uvs[i0 * 2]) * m.width, (b.uvs[i1 * 2 + 1] - b.uvs[i0 * 2 + 1]) * m.height);
          // ramp faces use a continuous "ribbon" mapping along the ridge (nearly isometric on curves and
          // drop-ins); everything else is an exact planar projection
          if (/(^|[/_])ramp/.test(b.material)) expect(Math.abs(du - dp)).toBeLessThan(0.15 * dp + 1);
          else expect(du).toBeCloseTo(dp, 1);
        }
        tris += b.indices.length / 3;
      }
      expect(tris).toBeGreaterThan(200);
      expect(tris).toBeLessThan(100000);
      // glowing trims are unlit
      const glow = [...r.materials.values()].filter((m) => m.name.includes('glow'));
      expect(glow.length).toBeGreaterThan(0);
      for (const g of glow) expect(g.unlit).toBe(true);
      // trims lying on other surfaces are decal batches (depth-biased by the renderer); free-standing glowing
      // bars (gates, frames) are ordinary geometry
      const decals = r.batches.filter((b) => b.decal);
      expect(decals.length).toBeGreaterThan(0);
      for (const d of decals) expect(d.material).toMatch(/glow/);
      expect(r.batches.some((b) => !b.decal && /glow/.test(b.material))).toBe(true);
    });

    it('every world brush face is drawn or deliberately hidden; ramp faces are fully covered', () => {
      // the drawn triangle area of each ramp's surf faces equals the area of its windings
      let rampArea = 0;
      for (const r of bc.builder.ramps) {
        for (let k = 0; k + 1 < r.ribs.length; k++) {
          const faces = r.side === 'both' ? [[0, 1], [0, 2]] : [[0, 1]];
          for (const [ri, bi] of faces) {
            const q = [r.ribs[k][ri], r.ribs[k + 1][ri], r.ribs[k + 1][bi], r.ribs[k][bi]];
            for (const [a, b, c] of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
              const e1 = v3(b.x - a.x, b.y - a.y, b.z - a.z);
              const e2 = v3(c.x - a.x, c.y - a.y, c.z - a.z);
              rampArea += Math.hypot(e1.y * e2.z - e1.z * e2.y, e1.z * e2.x - e1.x * e2.z, e1.x * e2.y - e1.y * e2.x) / 2;
            }
          }
        }
      }
      let drawn = 0;
      for (const b of map.render.batches) {
        if (!/ramp/.test(b.material)) continue;
        for (let t = 0; t < b.indices.length; t += 3) {
          const ii = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
          const nz = b.normals[ii[0] * 3 + 2];
          if (!(nz > 0.05 && nz < 0.7)) continue;
          const p = ii.map((i) => v3(b.positions[i * 3], b.positions[i * 3 + 1], b.positions[i * 3 + 2]));
          const e1 = v3(p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z);
          const e2 = v3(p[2].x - p[0].x, p[2].y - p[0].y, p[2].z - p[0].z);
          drawn += Math.hypot(e1.y * e2.z - e1.z * e2.y, e1.z * e2.x - e1.x * e2.z, e1.x * e2.y - e1.y * e2.x) / 2;
        }
      }
      expect(drawn / rampArea).toBeGreaterThan(0.999);
      expect(drawn / rampArea).toBeLessThan(1.001);
    });

    it('surf faces are 48-63 degree ramps (normal.z within [RAMP_MIN_NZ, RAMP_MAX_NZ] - never ground), every segment exactly planar', () => {
      expect(bc.builder.ramps.length).toBeGreaterThanOrEqual(6);
      for (const r of bc.builder.ramps) {
        expect(r.surfNormals.length).toBeGreaterThan(0);
        for (const n of r.surfNormals) {
          expect(n.z).toBeGreaterThanOrEqual(0.4);
          expect(n.z).toBeLessThanOrEqual(0.69);
          expect(n.z).toBeGreaterThanOrEqual(RAMP_MIN_NZ - 1e-9);
          expect(n.z).toBeLessThanOrEqual(RAMP_MAX_NZ + 1e-9);
        }
        // collision: no brush face of a ramp is walkable, and each segment's surf face is one plane
        for (const b of r.brushes) {
          for (const sd of b.sides) if (!sd.bevel) expect(sd.plane.normal.z).toBeLessThan(0.7);
        }
        for (let k = 0; k + 1 < r.ribs.length; k++) {
          const faces = r.side === 'both' ? [[0, 1], [0, 2]] : [[0, 1]];
          for (const [ri, bi] of faces) {
            const q = [r.ribs[k][ri], r.ribs[k + 1][ri], r.ribs[k + 1][bi], r.ribs[k][bi]];
            const e1 = v3(q[1].x - q[0].x, q[1].y - q[0].y, q[1].z - q[0].z);
            const e2 = v3(q[3].x - q[0].x, q[3].y - q[0].y, q[3].z - q[0].z);
            const n = v3(e1.y * e2.z - e1.z * e2.y, e1.z * e2.x - e1.x * e2.z, e1.x * e2.y - e1.y * e2.x);
            const nl = Math.hypot(n.x, n.y, n.z);
            const d = ((q[2].x - q[0].x) * n.x + (q[2].y - q[0].y) * n.y + (q[2].z - q[0].z) * n.z) / nl;
            expect(Math.abs(d)).toBeLessThan(0.01);
          }
        }
      }
    });

    it('ramp collision matches the drawn ramps: faces solid right under the surface, open right above, nothing sticking out', () => {
      for (const r of bc.builder.ramps) {
        // the drawn (exact) segments
        const segs = r.ribs.slice(0, -1).map((_, k) => new MapBuilder('x').addHull([...r.ribs[k], ...r.ribs[k + 1]], null));
        // no collision brush of the ramp reaches outside the drawn segments (no invisible geometry)
        for (const b of r.brushes) {
          for (const w of brushWindings(b)) {
            for (const p of w) {
              let best = Infinity;
              for (const s of segs) {
                let out = -Infinity;
                for (const sd of s.sides) if (!sd.bevel) out = Math.max(out, p.x * sd.plane.normal.x + p.y * sd.plane.normal.y + p.z * sd.plane.normal.z - sd.plane.dist);
                best = Math.min(best, out);
              }
              expect(best, r.name).toBeLessThan(0.05);
            }
          }
        }
        // seams are buried: at every joint each collision brush reaches past the joint into its neighbour, so no
        // brush edge lies along the visible seam (where box traces could snag on an edge bevel)
        const inBrush = (b: (typeof r.brushes)[number], p: ReturnType<typeof v3>): boolean =>
          b.sides.every((sd) => sd.bevel || p.x * sd.plane.normal.x + p.y * sd.plane.normal.y + p.z * sd.plane.normal.z <= sd.plane.dist + 1e-6);
        if (r.points.length > 2) {
          expect(r.brushes.length).toBe(r.points.length - 1);
          let joint = 0;
          for (let k = 0; k + 2 < r.points.length; k++) {
            joint += Math.hypot(r.points[k + 1].x - r.points[k].x, r.points[k + 1].y - r.points[k].y);
            for (const face of r.side === 'both' ? (['left', 'right'] as const) : ([r.side] as const)) {
              for (const frac of [0.05, 0.5, 0.9]) {
                for (const [seg, da] of [[k, 6], [k + 1, -6]] as const) {
                  const q = rampPoint(r, face, joint + da, frac);
                  const n = rampFrame(r, face, q).normal;
                  expect(inBrush(r.brushes[seg], v3(q.x - n.x, q.y - n.y, q.z - n.z)), `${r.name} joint ${k + 1}`).toBe(true);
                }
              }
            }
          }
        }
        // the surf face is exactly where it is drawn
        // sample the middle of every segment (several spots on long single-segment ramps)
        const alongs: number[] = [];
        let acc = 0;
        for (let k = 0; k + 1 < r.points.length; k++) {
          const l = Math.hypot(r.points[k + 1].x - r.points[k].x, r.points[k + 1].y - r.points[k].y);
          const nSamples = Math.max(1, Math.floor(l / 400));
          for (let j = 0; j < nSamples; j++) alongs.push(acc + (l * (j + 0.5)) / nSamples);
          acc += l;
        }
        for (const face of r.side === 'both' ? (['left', 'right'] as const) : ([r.side] as const)) {
          for (const a of alongs) {
            for (const d of [0.1, 0.5, 0.9]) {
              const f = rampFrame(r, face, rampPoint(r, face, a, d));
              const p = rampPoint(r, face, a, d);
              const n = f.normal;
              expect(map.collision.pointContents(v3(p.x - n.x, p.y - n.y, p.z - n.z), MASK_PLAYERSOLID), `${r.name} @${a.toFixed(0)}`).not.toBe(0);
              expect(map.collision.pointContents(v3(p.x + n.x, p.y + n.y, p.z + n.z), MASK_PLAYERSOLID), `${r.name} @${a.toFixed(0)}`).toBe(0);
            }
          }
        }
      }
    });

    it('spawns, teleport destinations and zone spawns fit the standing hull, over a floor or a ramp', () => {
      for (const s of map.spawns) {
        expect(hullFree(map, s.origin)).toBe(true);
        expect(floorBelow(map, s.origin)).toBeLessThan(4);
      }
      const dests = map.entities.filter((e) => e.classname === 'info_teleport_destination');
      expect(dests.length).toBe(bc.course.sections.length + bc.bonuses.reduce((n, c) => n + c.sections.length, 0));
      for (const d of dests) {
        expect(hullFree(map, d.origin)).toBe(true);
        // a room floor right below, or a ramp face a short drop below
        expect(floorBelow(map, d.origin)).toBeLessThan(200);
      }
      for (const z of map.zones) if (z.spawn) expect(hullFree(map, z.spawn.origin)).toBe(true);
    });

    it('zones: non-degenerate, start covers the spawn, ordered checkpoints/stages at section starts, an end zone; each bonus has its own start and end', () => {
      for (const z of map.zones) {
        expect(z.group).toBeGreaterThanOrEqual(0);
        expect(z.group).toBeLessThanOrEqual(bc.bonuses.length);
        for (const k of ['x', 'y', 'z'] as const) expect(z.maxs[k] - z.mins[k]).toBeGreaterThanOrEqual(64);
      }
      const main = map.zones.filter((z) => z.group === 0);
      const start = main.filter((z) => z.type === 'start');
      expect(start.length).toBe(1);
      expect(insideBox(map.spawns[0].origin, start[0].mins, start[0].maxs)).toBe(true);
      expect(main.filter((z) => z.type === 'end').length).toBe(1);
      // every map has a bonus (zone group 1..N, in order), each just a start and an end zone
      expect(bc.bonuses.length).toBeGreaterThanOrEqual(1);
      bc.bonuses.forEach((bonus, k) => {
        expect(bonus.group).toBe(k + 1);
        const zs = map.zones.filter((z) => z.group === bonus.group);
        expect(zs.map((z) => z.type).sort()).toEqual(['end', 'start']);
        const bs = zs.find((z) => z.type === 'start')!;
        const d = bc.builder.destination(bonus.sections[0].dest)!;
        expect(bs.spawn).toBeTruthy();
        expect(bs.spawn!.origin).toEqual(d.origin);
        expect(insideBox(d.origin, bs.mins, bs.maxs)).toBe(true);
        expect(insideBox(bonus.finish, zs.find((z) => z.type === 'end')!.mins, zs.find((z) => z.type === 'end')!.maxs, 1)).toBe(true);
      });
      const marker = info.type === 'staged' ? 'stage' : 'checkpoint';
      const marks = main.filter((z) => z.type === marker).map((z) => z.index);
      const n = bc.course.sections.length;
      expect(marks).toEqual(info.type === 'staged' ? Array.from({ length: n - 1 }, (_, i) => i + 2) : Array.from({ length: n - 1 }, (_, i) => i + 1));
      expect(map.zones.some((z) => z.type === (info.type === 'staged' ? 'checkpoint' : 'stage'))).toBe(false);
      // each section's restart point lies in (or right above) its zone
      for (let s = 1; s < n; s++) {
        const d = bc.builder.destination(bc.course.sections[s].dest)!;
        const z = map.zones.find((zz) => zz.type === marker && zz.index === (info.type === 'staged' ? s + 1 : s))!;
        expect(insideBox(d.origin, z.mins, z.maxs, 48)).toBe(true);
      }
    });

    it('triggers: every trigger_teleport targets an existing destination; pushes are client triggers with a direction and speed', () => {
      const names = new Set(map.entities.filter((e) => e.classname === 'info_teleport_destination').map((e) => e.targetname));
      const tps = map.entities.filter((e) => e.classname === 'trigger_teleport');
      expect(tps.length).toBeGreaterThan(5);
      for (const t of tps) {
        expect(names.has(t.kv.target)).toBe(true);
        expect(Number(t.kv.spawnflags) & 1).toBe(1);
      }
      for (const p of map.entities.filter((e) => e.classname === 'trigger_push')) {
        expect(Number(p.kv.spawnflags) & 1).toBe(1);
        expect(Number(p.kv.speed)).toBeGreaterThan(0);
        expect(p.kv.pushdir.split(' ').length).toBe(3);
      }
      if (info.id === 'surf_neon') expect(map.entities.filter((e) => e.classname === 'trigger_push').length).toBeGreaterThanOrEqual(2);
    });

    it('the void under every ramp is a fail teleport to that section; nothing a run touches overlaps one', () => {
      const tps = map.entities.filter((e) => e.classname === 'trigger_teleport');
      const boxes = tps.map((e) => ({ dest: e.kv.target, b: map.models[e.model].brushes[0] }));
      const hit = (p: Vec3): string[] => {
        const lo = v3(p.x + HULL_MINS.x, p.y + HULL_MINS.y, p.z);
        const hi = v3(p.x + HULL_MAXS.x, p.y + HULL_MAXS.y, p.z + HULL_MAXS.z);
        return boxes.filter((x) => boxIntersectsBrush(lo, hi, x.b)).map((x) => x.dest);
      };
      // bonus sections: every fall in a bonus goes back to its start
      const bonusSections = new Set(bc.bonuses.flatMap((c) => c.sections));
      [...bc.course.sections, ...bonusSections].forEach((s, si) => {
        for (const cr of s.ramps) {
          const len = rampLength(cr.ramp);
          for (let a = len * 0.1; a < len * 0.95; a += len / 7) {
            // 1600 units below the face: inside this section's void
            const p = rampPoint(cr.ramp, cr.face, a, 0.5);
            const below = v3(p.x, p.y, p.z - cr.ramp.height - 1600);
            const h = hit(below);
            expect(h.length, `${cr.ramp.name} @${a.toFixed(0)}`).toBeGreaterThan(0);
            // staged maps: always this stage; linear maps: this section, or the previous one near a section start
            if (info.type === 'staged' || a > 900 || bonusSections.has(s)) expect(h, `${cr.ramp.name} @${a.toFixed(0)}`).toContain(s.dest);
            else expect(h.some((d) => d === s.dest || d === bc.course.sections[Math.max(0, si - 1)].dest)).toBe(true);
            // riding the face: no trigger at all
            const ride = v3(p.x, p.y, p.z + 32);
            expect(hit(ride)).toEqual([]);
          }
        }
      });
    });

    it('literal bot: drops onto the first ramp holding the strafe key toward it, looking down the ramp - stays on most of its length, exits > 600 u/s', () => {
      const first = bc.course.sections[0].ramps[0];
      const r = first.ramp;
      const tyaw = (Math.atan2(r.points[1].y - r.points[0].y, r.points[1].x - r.points[0].x) * 180) / Math.PI;
      for (const tick of [64, 100, 128]) {
        const sp = map.spawns[0];
        const ps = createPlayerState(sp.origin, sp.angles);
        const vars = defaultMoveVars();
        const cmd = newUserCmd();
        const ev = newMoveEvents();
        const ft = 1 / tick;
        const tr = newTrace();
        let airborne = false;
        let onRamp = 0;
        let contact = 0;
        let exitSpeed = 0;
        for (let i = 0; i < 40 / ft; i++) {
          cmd.viewangles.yaw = tyaw;
          if (!airborne) {
            // walk out of the start room until the floor ends
            cmd.forwardmove = 450;
            cmd.sidemove = 0;
            if (!ps.onGround && i > 5) airborne = true;
          } else {
            cmd.forwardmove = 0;
            cmd.sidemove = first.face === 'left' ? 450 : -450;
          }
          playerMove(ps, cmd, map.collision, vars, ft, ev);
          const f = rampFrame(r, first.face, ps.origin);
          if (airborne && f.along >= 0 && f.along <= f.length) {
            const n = f.normal;
            const o = ps.origin;
            map.collision.traceBox(o, v3(o.x - n.x * 2, o.y - n.y * 2, o.z - n.z * 2), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
            if (tr.fraction < 1) contact++;
            if (contact) onRamp++;
            expect(ps.onGround).toBe(false);
          }
          if (f.along > f.length) {
            exitSpeed = Math.hypot(ps.velocity.x, ps.velocity.y);
            break;
          }
        }
        expect(contact / onRamp, `contact @${tick}`).toBeGreaterThan(0.85);
        expect(exitSpeed, `exit speed @${tick}`).toBeGreaterThan(600);
      }
    });

    it('autopilot completes the whole map at 64/100/128 tick in several surfing styles, never failing', () => {
      const styles: AutopilotOptions[] = [{}, { style: 'coarse' }, { band: [0.15, 0.35] }, { band: [0.5, 0.75] }];
      const lines: string[] = [];
      for (const tick of [64, 100, 128]) {
        for (const p of styles) {
          const r = runCourse(bc, { tick, pilot: p, afterFinish: 3 });
          lines.push(`${tick} tick ${JSON.stringify(p)}: ${r.finished ? 'finished' : 'DNF'} in ${r.time.toFixed(2)} s, max ${r.maxSpeed.toFixed(0)} u/s, fails ${r.fails.length}`);
          expect(r.fails, `${tick} ${JSON.stringify(p)}`).toEqual([]);
          expect(r.finished, `${tick} ${JSON.stringify(p)}`).toBe(true);
          // ...and comes to rest on the end platform (the backstop catches fast arrivals)
          expect(r.restedAtEnd, `${tick} ${JSON.stringify(p)}`).toBe(true);
          // the run went through every checkpoint/stage in order
          const marks = r.host.chats.filter((c) => /^\[Surf\] (CP|Stage) \d+/.test(c)).map((c) => Number(/(\d+)/.exec(c.slice(7))![1]));
          const n = bc.course.sections.length;
          expect(marks).toEqual(info.type === 'staged' ? Array.from({ length: n - 1 }, (_, i) => i + 2) : Array.from({ length: n - 1 }, (_, i) => i + 1));
          // surfing never loses more than a little speed in one tick (no snags at ramp seams)
          expect(r.worstSurfLoss, `${tick} ${JSON.stringify(p)}`).toBeLessThan(60);
          expect(r.maxSpeed).toBeLessThan(3500);
          expect(r.time).toBeGreaterThan(15);
        }
      }
      console.log(`${info.id}:\n  ${lines.join('\n  ')}`);
    });

    it('every checkpoint/stage restart (zero speed at the section start) completes the rest of the map', () => {
      for (let s = 1; s < bc.course.sections.length; s++) {
        for (const tick of [64, 128]) {
          // dropped in from the destination, or from a little higher (different landing speeds)
          for (const off of [v3(), v3(0, 0, 48), v3(0, 0, 160)]) {
            const r = runCourse(bc, { section: s, tick, offset: off });
            expect(r.fails, `section ${s} @${tick} +${off.z}`).toEqual([]);
            expect(r.finished, `section ${s} @${tick} +${off.z}`).toBe(true);
          }
        }
      }
    });

    it('gap feasibility: every gap is crossable with margin from the previous exit speed (ballistic, g = 800)', () => {
      const tables: string[] = [];
      const check = (title: string, rows: ReturnType<typeof analyzeGaps>, minMargin: number): void => {
        tables.push(formatGapTable(title, rows));
        for (const g of rows) {
          expect(g.ok, `${title}: ${g.from} -> ${g.to}`).toBe(true);
          if (g.kind === 'gap') {
            expect(g.margin, `${title}: ${g.from} -> ${g.to}`).toBeGreaterThanOrEqual(minMargin);
            expect(g.clearance).toBeGreaterThan(0);
            // lands on the next ramp with room left to surf
            expect(g.landAlong!).toBeLessThan(g.nextLength - 300);
          }
        }
      };
      const full = runCourse(bc, {});
      expect(full.finished).toBe(true);
      const rows = analyzeGaps(full.pilot, full.pilot.events, bc.builder);
      expect(rows.length).toBe(full.pilot.ramps.length - 1);
      check(`${info.id}: full run`, rows, 1.3);
      for (let s = 1; s < bc.course.sections.length; s++) {
        const r = runCourse(bc, { section: s });
        const own = analyzeGaps(r.pilot, r.pilot.events, bc.builder).filter((g) => r.pilot.ramps.find((x) => x.ramp.name === g.from)!.section === s);
        check(`${info.id}: restart from ${bc.course.sections[s].name}`, own, 1.25);
      }
      console.log(tables.join('\n\n'));
    });

    it("the start room's back alcove is a teleporter to bonus 1: walking in puts you in the bonus start zone with the timer on bonus 1", () => {
      for (const tick of [64, 128]) {
        const host = newHost(bc, tick);
        host.timer.restart(0);
        expect(host.timer.getHud().bonus).toBe(0);
        const ps = host.player;
        const cmd = newUserCmd();
        const ev = newMoveEvents();
        const d = bc.builder.destination(bc.bonuses[0].sections[0].dest)!;
        let arrived = -1;
        for (let i = 0; i < 4 * tick && arrived < 0; i++) {
          host.tickCount++;
          host.time = host.tickCount / tick;
          // turn around and walk to the back wall
          cmd.viewangles.yaw = 180;
          cmd.forwardmove = 450;
          playerMove(ps, cmd, host.collision, host.moveVars, host.tickInterval, ev);
          const n = host.teleports.length;
          host.entities.tick();
          host.timer.tick();
          if (host.teleports.length > n) arrived = i;
        }
        expect(arrived, `@${tick}`).toBeGreaterThan(0);
        expect(Math.hypot(ps.origin.x - d.origin.x, ps.origin.y - d.origin.y, ps.origin.z - d.origin.z)).toBeLessThan(1);
        host.timer.tick();
        const hud = host.timer.getHud();
        expect(hud.bonus).toBe(1);
        expect(hud.state).toBe('startzone');
      }
    });

    it('bonus 1: the autopilot completes it from !b 1 at 64/100/128 tick in several styles, never failing, every gap with margin', () => {
      const styles: AutopilotOptions[] = [{}, { style: 'coarse' }, { band: [0.15, 0.35] }, { band: [0.5, 0.75] }];
      const lines: string[] = [];
      for (const bonus of bc.bonuses) {
        for (const tick of [64, 100, 128]) {
          for (const p of styles) {
            const r = runCourse(bc, { tick, pilot: p, group: bonus.group, afterFinish: 3 });
            const tag = `bonus ${bonus.group} @${tick} ${JSON.stringify(p)}`;
            lines.push(`${tag}: ${r.finished ? 'finished' : 'DNF'} in ${r.time.toFixed(2)} s, max ${r.maxSpeed.toFixed(0)} u/s`);
            expect(r.fails, tag).toEqual([]);
            expect(r.finished, tag).toBe(true);
            expect(r.restedAtEnd, tag).toBe(true);
            expect(r.host.timer.getHud().bonus, tag).toBe(bonus.group);
            expect(r.worstSurfLoss, tag).toBeLessThan(60);
            expect(r.time).toBeGreaterThan(10);
            if (tick === 100 && !p.style && !p.band) {
              const rows = analyzeGaps(r.pilot, r.pilot.events, bc.builder);
              expect(rows.length).toBe(r.pilot.ramps.length - 1);
              lines.push(formatGapTable(`${info.id} bonus ${bonus.group}`, rows));
              for (const g of rows) {
                expect(g.ok, `${tag}: ${g.from} -> ${g.to}`).toBe(true);
                if (g.kind === 'gap') {
                  expect(g.margin, `${tag}: ${g.from} -> ${g.to}`).toBeGreaterThanOrEqual(1.3);
                  expect(g.landAlong!).toBeLessThan(g.nextLength - 300);
                }
              }
            }
          }
        }
      }
      console.log(lines.join('\n'));
    });
  });
}

// ------------------------------------------------------------------------------------------ the builder

describe('MapBuilder ramps', () => {
  it('addRamp: a left/right ramp is a triangular prism with one surf face facing the given side', () => {
    for (const side of ['left', 'right'] as const) {
      const b = new MapBuilder('t');
      const h = rampHeightFor(320, 0.5);
      const r = b.addRamp({ start: v3(0, 0, 1000), end: v3(2000, 0, 1000), width: 320, height: h, side });
      expect(r.brushes.length).toBe(1);
      expect(r.surfNormals.length).toBe(1);
      const n = r.surfNormals[0];
      expect(n.z).toBeCloseTo(0.5, 9);
      expect(n.x).toBeCloseTo(0, 9);
      expect(Math.sign(n.y)).toBe(side === 'left' ? 1 : -1);
      // the ridge is the top edge, the face spans `width` sideways and `height` down
      const br = r.brushes[0];
      expect(br.maxs.z).toBeCloseTo(1000, 6);
      expect(br.mins.z).toBeCloseTo(1000 - h, 6);
      expect(br.maxs.y - br.mins.y).toBeCloseTo(320, 6);
      expect(br.maxs.x - br.mins.x).toBeCloseTo(2000, 6);
    }
  });

  it("addRamp: 'both' is the classic ^ ramp with two surf faces", () => {
    const b = new MapBuilder('t');
    const r = b.addRamp({ start: v3(0, 0, 0), end: v3(0, 3000, -300), width: 300, height: rampHeightFor(300, 0.55), side: 'both' });
    expect(r.surfNormals.length).toBe(2);
    expect(Math.sign(r.surfNormals[0].x)).toBe(-Math.sign(r.surfNormals[1].x));
    for (const n of r.surfNormals) expect(n.z).toBeLessThan(0.56);
  });

  it('rejects ramps that would be too flat (walkable) or too steep', () => {
    const b = new MapBuilder('t');
    expect(() => b.addRamp({ start: v3(), end: v3(1000, 0, 0), width: 400, height: 300, side: 'left' })).toThrow(/normal\.z/);
    expect(() => b.addRamp({ start: v3(), end: v3(1000, 0, 0), width: 100, height: 800, side: 'left' })).toThrow(/normal\.z/);
    expect(() => b.addRampPath({ points: [v3(), v3(1000, 0, 0), v3(1000, 1000, 0)], width: 300, height: 520, side: 'left' })).toThrow(/too sharply/);
  });

  it('segmented ramps: neighbouring segments share their cross-section exactly (no step at a seam)', () => {
    const b = new MapBuilder('t');
    const ch = new RampChain(b, v3(0, 0, 5000), 0);
    const r = ch.curve({ gap: 0, drop: 0, radius: 2000, angle: 120, segments: 24, descent: 6, side: 'left', width: 320 });
    expect(r.ribs.length).toBe(25);
    // every drawn segment touches the next one exactly along their shared rib edge
    const segWindings = r.ribs.slice(0, -1).map((_, k) => {
      const hull = new MapBuilder('x').addHull([...r.ribs[k], ...r.ribs[k + 1]], 'builtin/ramp_grey');
      return brushWindings(hull).flat();
    });
    for (let k = 0; k + 1 < segWindings.length; k++) {
      for (const p of r.ribs[k + 1]) {
        expect(segWindings[k].some((q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 1e-6)).toBe(true);
        expect(segWindings[k + 1].some((q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 1e-6)).toBe(true);
      }
    }
    // the curve turns the full angle and descends steadily
    expect(ch.yaw).toBeCloseTo(120, 9);
    const zs = r.points.map((p) => p.z);
    for (let k = 1; k < zs.length; k++) expect(zs[k]).toBeLessThan(zs[k - 1]);
  });

  it('segmented ramps: a hull sliding across the seams of a descending curve never snags (seam rampbug)', () => {
    // a 180 degree descending curve (inside face): surf along it from many starting offsets at three tick
    // rates; with exposed segment edges, epsilon ties at the seams kill most of the speed now and then
    const b = new MapBuilder('seams');
    const ch = new RampChain(b, v3(0, 0, 6000), 0);
    const r = ch.curve({ gap: 0, drop: 0, radius: 2400, angle: 180, segments: 36, descent: 5, side: 'left', width: 352 });
    const map = b.build();
    let worst = 0;
    let runs = 0;
    for (const tick of [64, 100, 128]) {
      for (let k = 0; k < 8; k++) {
        const ft = 1 / tick;
        const start = rampPoint(r, 'left', 300 + k * 37, 0.2 + 0.08 * k);
        const ps = createPlayerState(v3(start.x, start.y, start.z + 40), qa(0, 0, 0));
        // within what the curve's banking can turn (v^2 / R < g * tan(slope): ~1560 u/s here)
        ps.velocity = v3(800 + k * 80, 0, 0);
        const cmd = newUserCmd();
        const ev = newMoveEvents();
        const vars = defaultMoveVars();
        let prev = -1;
        let touching = 0;
        for (let i = 0; i < 12 / ft; i++) {
          const f = rampFrame(r, 'left', ps.origin);
          if (f.along > f.length - 200) break;
          const frac = f.lateral / r.width;
          const vOut = ps.velocity.x * f.out.x + ps.velocity.y * f.out.y;
          const hold = frac > 0.6 || (frac > 0.2 && vOut > -(frac - 0.4) * r.width * 1.5);
          const pushOff = !hold && frac < 0.2;
          cmd.viewangles.yaw = (Math.atan2(f.tangent.y, f.tangent.x) * 180) / Math.PI;
          cmd.sidemove = hold ? 450 : pushOff ? -450 : 0;
          playerMove(ps, cmd, map.collision, vars, ft, ev);
          const sp = Math.hypot(ps.velocity.x, ps.velocity.y, ps.velocity.z);
          if (i > 30 && prev > 0 && !hold && !pushOff) worst = Math.max(worst, prev - sp);
          if (i > 30) touching++;
          prev = sp;
          expect(ps.onGround).toBe(false);
        }
        expect(touching).toBeGreaterThan(200);
        runs++;
      }
    }
    expect(runs).toBe(24);
    expect(worst).toBeLessThan(40);
  });

  it('drop-in profiles ease from steep to the base descent along a straight ridge', () => {
    const b = new MapBuilder('t');
    const ch = new RampChain(b, v3(0, 0, 4000), 90);
    const r = ch.straight({ gap: 0, drop: 0, length: 3000, descent: 5, dropIn: { angle: 25, length: 1000, steps: 5 }, side: 'right', width: 320 });
    expect(r.points.length).toBe(7);
    const slopes: number[] = [];
    for (let k = 0; k + 1 < r.points.length; k++) {
      const a = r.points[k];
      const c = r.points[k + 1];
      expect(c.x).toBeCloseTo(0, 6); // straight along +y
      slopes.push((Math.atan2(a.z - c.z, Math.hypot(c.x - a.x, c.y - a.y)) * 180) / Math.PI);
    }
    for (let k = 1; k < slopes.length; k++) expect(slopes[k]).toBeLessThanOrEqual(slopes[k - 1] + 1e-9);
    expect(slopes[0]).toBeGreaterThan(20);
    expect(slopes[slopes.length - 1]).toBeCloseTo(5, 6);
    expect(rampLength(r)).toBeCloseTo(3000, 6);
  });

  it('autoDrop: a run leaving at the design speed lands `land` units into the next ramp (ballistic)', () => {
    for (const [speed, gap, land] of [[900, 400, 400], [1400, 800, 600], [2000, 1200, 500]]) {
      const b = new MapBuilder('t');
      const ch = new RampChain(b, v3(0, 0, 8000), 0);
      const A = ch.straight({ gap: 0, drop: 0, length: 2000, descent: 6, side: 'left', width: 320 });
      const B = ch.straight({ gap, speed, land, length: 3000, descent: 6, side: 'left', width: 320 });
      // leave A at depth 0.4 following its ridge descent; fall until the same depth on B
      const p0 = rampPoint(A, 'left', 2000, 0.4);
      const tan = Math.tan((6 * Math.PI) / 180);
      const f = predictFlight(p0, v3(speed, 0, -speed * tan), {
        untilZ: -1e9,
        tick: 1000,
        stop: (p) => p.x > B.points[0].x && p.z <= rampPoint(B, 'left', p.x - B.points[0].x, 0.4).z,
      });
      expect(f.pos.x - B.points[0].x).toBeGreaterThan(land - 25);
      expect(f.pos.x - B.points[0].x).toBeLessThan(land + 25);
    }
  });
});

describe('MapBuilder entities and output', () => {
  it('teleports, destinations, pushes and zones become entities, brush models and zone defs', () => {
    const b = new MapBuilder('surf_unit', { sky: 'sky_test', fog: { enabled: true, color: [0.1, 0.2, 0.3], start: 100, end: 2000, maxDensity: 0.5 } });
    b.addPlatform(v3(0, 0, 0), 512, 512, 'builtin/floor_dark');
    b.addSpawn(v3(0, 0, 0), 90);
    b.addDestination('dst', v3(100, 0, 0), 180);
    const tp = b.addTeleport(v3(-1000, -1000, -2000), v3(1000, 1000, -1000), 'dst');
    const push = b.addPush(v3(0, 0, 10), v3(64, 64, 200), qa(-90, 0, 0), 1500);
    b.addZone('start', v3(-200, -200, 0), v3(200, 200, 128), { prespeed: 350, spawn: { origin: v3(0, 0, 0), yaw: 90 } });
    const m = b.build();
    expect(tp).toBe(1);
    expect(push).toBe(2);
    expect(m.models.length).toBe(3);
    const ws = m.entities[0];
    expect(ws.classname).toBe('worldspawn');
    expect(ws.kv.skyname).toBe('sky_test');
    const fog = m.entities.find((e) => e.classname === 'env_fog_controller')!;
    expect(fog.kv.fogcolor).toBe('26 51 77');
    const t = m.entities.find((e) => e.classname === 'trigger_teleport')!;
    expect(t.model).toBe(1);
    expect(t.kv).toMatchObject({ model: '*1', target: 'dst', spawnflags: '1' });
    expect(m.models[1].brushes[0].maxs.z).toBe(-1000);
    const p = m.entities.find((e) => e.classname === 'trigger_push')!;
    expect(p.kv).toMatchObject({ model: '*2', pushdir: '-90 0 0', speed: '1500', spawnflags: '1' });
    const d = m.entities.find((e) => e.classname === 'info_teleport_destination')!;
    expect(d.targetname).toBe('dst');
    expect(d.origin).toEqual(v3(100, 0, 0));
    expect(d.angles.yaw).toBe(180);
    const sp = m.entities.filter((e) => e.classname.startsWith('info_player_'));
    expect(sp.map((e) => e.classname).sort()).toEqual(['info_player_counterterrorist', 'info_player_terrorist']);
    expect(m.spawns[0].angles.yaw).toBe(90);
    expect(m.zones[0]).toMatchObject({ type: 'start', group: 0, index: 0, prespeed: 350 });
    expect(m.zones[0].spawn!.angles.yaw).toBe(90);
    expect(m.render.fog).toEqual({ enabled: true, color: [0.1, 0.2, 0.3], start: 100, end: 2000, maxDensity: 0.5 });
    // trigger volumes are not part of the collision world
    expect(m.collision.brushes.length).toBe(1);
    expect(m.worldMins.z).toBe(-2000);
  });

  it('a teleport to a missing destination is a build error', () => {
    const b = new MapBuilder('t');
    b.addTeleport(v3(0, 0, 0), v3(10, 10, 10), 'nowhere');
    expect(() => b.build()).toThrow(/missing destination/);
  });

  it('rooms have floor, walls, ceiling and the requested doorway', () => {
    const b = new MapBuilder('t');
    b.addRoom(v3(-256, -256, 0), v3(256, 256, 256), { floor: 'builtin/floor_dark', wall: 'builtin/wall_grid', ceiling: 'builtin/wall_dark' }, [
      { side: '+x', a0: -64, a1: 64, z0: 0, z1: 200 },
    ]);
    const m = b.build();
    const inside = v3(0, 0, 1);
    expect(hullFree(m, inside)).toBe(true);
    const tr = newTrace();
    // walking out through the doorway is free, through a wall is blocked
    m.collision.traceBox(inside, v3(600, 0, 1), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    expect(tr.fraction).toBe(1);
    m.collision.traceBox(inside, v3(-600, 0, 1), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    expect(tr.fraction).toBeLessThan(1);
    m.collision.traceBox(v3(0, 150, 1), v3(600, 150, 1), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    expect(tr.fraction).toBeLessThan(1);
    m.collision.traceBox(inside, v3(0, 0, 400), HULL_MINS, HULL_MAXS, MASK_PLAYERSOLID, tr);
    expect(tr.fraction).toBeLessThan(1);
    expect(floorBelow(m, inside)).toBeLessThan(2);
    expect(m.render.materials.has('builtin/floor_dark')).toBe(true);
  });

  it('addSign draws glowing stroke-font text centred on the point and readable from the side it faces', () => {
    const b = new MapBuilder('sign');
    const h = 60;
    // an 'L' facing +x: read by someone looking along -x, whose right is +y
    addSign(b, 'L', v3(0, 0, 100), v3(1, 0, 0), h, 'builtin/glow_white');
    const m = b.build();
    const pts: Vec3[] = [];
    for (const bt of m.render.batches) {
      expect(bt.material).toBe('builtin/glow_white');
      expect(bt.decal).toBeFalsy();
      for (let i = 0; i < bt.positions.length; i += 3) pts.push(v3(bt.positions[i], bt.positions[i + 1], bt.positions[i + 2]));
    }
    const stroke = h / 9;
    const w = (h * 4) / 6;
    expect(signWidth('L', h)).toBeCloseTo(w, 9);
    for (const p of pts) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(stroke / 2 + 1e-3);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(w / 2 + stroke / 2 + 1e-3);
      expect(p.z).toBeGreaterThanOrEqual(100 - h / 2 - stroke / 2 - 1e-3);
      expect(p.z).toBeLessThanOrEqual(100 + h / 2 + stroke / 2 + 1e-3);
    }
    // the upright stroke is on the reader's left (-y), the foot runs to their right (+y)
    const upper = pts.filter((p) => p.z > 100 + stroke);
    const foot = pts.filter((p) => p.z < 100 - h / 2 + stroke);
    expect(Math.max(...upper.map((p) => p.y))).toBeCloseTo(-w / 2 + stroke / 2, 3);
    expect(Math.max(...foot.map((p) => p.y))).toBeCloseTo(w / 2, 3);
    // longer texts are centred too, and unknown characters are rejected
    expect(signWidth('CP 1', 96)).toBeCloseTo(4 * 64 + 3 * 32, 9);
    expect(() => addSign(new MapBuilder('x'), 'a~', v3(), v3(0, 1, 0), 32, 'builtin/glow_white')).toThrow(/glyph/);
    expect(() => addSign(new MapBuilder('x'), 'A', v3(), v3(0, 0, 1), 32, 'builtin/glow_white')).toThrow(/facing/);
  });

  it('predictFlight follows trigger_push semantics: the vertical push only acts while inside, the horizontal one is kept', () => {
    const push = { mins: v3(-1000, -1000, -1000), maxs: v3(1000, 1000, 1000), push: pushVector(-90, 0, 2000) };
    // inside the volume vz grows by (2000 - 800) u/s per second; the hull leaves its top (z 1000) after
    // sqrt(1000 / 600) s at 1200 * that u/s, then flies freely: apex 1000 + vz^2 / 1600
    const vOut = 1200 * Math.sqrt(1000 / 600);
    const f = predictFlight(v3(0, 0, 0), v3(0, 0, 0), { pushes: [push], untilZ: 1000 + (vOut * vOut) / 1600 - 50, maxT: 10, tick: 1000 });
    expect(f.boosted).toBe(true);
    expect(f.t).toBeGreaterThan(Math.sqrt(1000 / 600) + vOut / 800 - 0.05);
    const side = { mins: v3(0, -100, -100), maxs: v3(200, 100, 200), push: pushVector(0, 0, 500) };
    const g = predictFlight(v3(-100, 0, 0), v3(1000, 0, 0), { pushes: [side], untilZ: -200 });
    expect(g.vel.x).toBeGreaterThan(1490); // 1000 + 500 (+ the half-tick extra)
    expect(() => predictFlight(v3(), v3(100, 0, 0), { untilZ: 500, maxT: 1 })).toThrow(/never comes down/);
  });
});
