// Movement on real KSF surf maps (CS:S VBSP). Set SURF_TEST_MAPS to a directory of .bsp files; skipped when
// unset. Builds the real CollisionWorld from the map's brushes (world, solid brush entities, displacements),
// then: spawns at every spawn point and walks around, and surfs the map's actual steep ramp faces with a
// "hold into the ramp / release" pattern - counting ticks in solid, velocity kills and stalls.
//   SURF_TEST_MAPS=/path/to/maps npx vitest run tests/helpers/movement_maps.test.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectCollisionBrushes, buildBrushModels } from '../../src/bsp/bspcollision';
import { parseEntities } from '../../src/bsp/entities';
import { parseBsp } from '../../src/bsp/reader';
import { Vec3, v3 } from '../../src/core/vec3';
import { qa } from '../../src/core/angles';
import { MapEntity } from '../../src/map/types';
import { brushWindings } from '../../src/physics/brushbuild';
import { CollisionWorld } from '../../src/physics/collision';
import { categorizePosition, defaultMoveVars, playerHull, playerMove, unstuckPlayer } from '../../src/physics/movement';
import { IN_DUCK, IN_JUMP, MOVETYPE_WALK, PlayerState, createPlayerState, newMoveEvents, newUserCmd } from '../../src/physics/playertypes';
import { MASK_PLAYERSOLID, newTrace } from '../../src/physics/types';
import { mulberry32 } from './movement_world';

function listMaps(env: string | undefined): string[] {
  if (!env || !existsSync(env) || !statSync(env).isDirectory()) return [];
  return readdirSync(env)
    .filter((f) => f.toLowerCase().endsWith('.bsp'))
    .sort()
    .map((f) => join(env, f));
}

const MAPS = listMaps(process.env.SURF_TEST_MAPS);
const FT = 0.01;

interface Ramp {
  c: Vec3;
  n: Vec3;
  area: number;
}

interface Stats {
  ticks: number;
  inSolid: number;
  kills: number;
  stalls: number;
  nan: number;
  notes: string[];
}

function newStats(): Stats {
  return { ticks: 0, inSolid: 0, kills: 0, stalls: 0, nan: 0, notes: [] };
}

describe.skipIf(MAPS.length === 0)('movement on real maps', () => {
  for (const path of MAPS) {
    const name = basename(path, '.bsp');
    describe(name, () => {
      let world: CollisionWorld;
      let ents: MapEntity[];
      let ramps: Ramp[] = [];

      beforeAll(() => {
        const b = readFileSync(path);
        const bsp = parseBsp(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
        ents = parseEntities(bsp.entitiesText);
        const models = buildBrushModels(bsp, { entities: ents });
        const set = collectCollisionBrushes(bsp, ents, models);
        world = new CollisionWorld(set.brushes);
        for (const m of set.disabledModels) world.setModelSolid(m, false);
        // steep, large, player-solid world faces: the surf ramps
        for (const br of models[0].brushes) {
          if ((br.contents & MASK_PLAYERSOLID) === 0) continue;
          const ws = brushWindings(br);
          for (let i = 0; i < ws.length; i++) {
            const w = ws[i];
            if (w.length < 3 || br.sides[i].bevel) continue;
            const n = br.sides[i].plane.normal;
            if (n.z < 0.3 || n.z >= 0.7) continue;
            let ax = 0, ay = 0, az = 0, cx = 0, cy = 0, cz = 0;
            for (let k = 1; k + 1 < w.length; k++) {
              const ux = w[k].x - w[0].x, uy = w[k].y - w[0].y, uz = w[k].z - w[0].z;
              const vx = w[k + 1].x - w[0].x, vy = w[k + 1].y - w[0].y, vz = w[k + 1].z - w[0].z;
              const crx = uy * vz - uz * vy, cry = uz * vx - ux * vz, crz = ux * vy - uy * vx;
              const a = Math.hypot(crx, cry, crz) / 2;
              ax += a;
              cx += a * (w[0].x + w[k].x + w[k + 1].x) / 3;
              cy += a * (w[0].y + w[k].y + w[k + 1].y) / 3;
              cz += a * (w[0].z + w[k].z + w[k + 1].z) / 3;
            }
            void ay;
            void az;
            if (ax < 256 * 256) continue;
            ramps.push({ c: v3(cx / ax, cy / ax, cz / ax), n: v3(n.x, n.y, n.z), area: ax });
          }
        }
        ramps.sort((a, b) => b.area - a.area);
        console.log(`[movement] ${name}: ${set.brushes.length} collision brushes, ${ramps.length} ramp faces`);
      }, 180000);

      function inSolid(ps: PlayerState): boolean {
        const h = playerHull(ps);
        return world.testBox(ps.origin, h.mins, h.maxs, MASK_PLAYERSOLID);
      }

      it('spawn points: free, land on the ground, wander without entering solid', () => {
        const spawns = ents.filter((e) => e.classname === 'info_player_terrorist' || e.classname === 'info_player_counterterrorist').slice(0, 16);
        expect(spawns.length).toBeGreaterThan(0);
        const vars = defaultMoveVars();
        const st = newStats();
        let landedCount = 0;
        const rnd = mulberry32(7);
        for (const sp of spawns) {
          const ps = createPlayerState(v3(sp.origin.x, sp.origin.y, sp.origin.z + 1), qa(0, sp.angles.yaw, 0));
          expect(unstuckPlayer(ps, world)).toBe(true);
          categorizePosition(ps, world, vars);
          const ev = newMoveEvents();
          const cmd = newUserCmd();
          for (let i = 0; i < 300 && !ps.onGround; i++) playerMove(ps, cmd, world, vars, FT, ev);
          if (ps.onGround) landedCount++;
          for (let i = 0; i < 600; i++) {
            if (i % 25 === 0) {
              cmd.forwardmove = rnd() < 0.7 ? 450 : 0;
              cmd.sidemove = rnd() < 0.4 ? (rnd() < 0.5 ? 450 : -450) : 0;
              cmd.buttons = (rnd() < 0.3 ? IN_JUMP : 0) | (rnd() < 0.1 ? IN_DUCK : 0);
              cmd.viewangles.yaw = rnd() * 360;
            }
            playerMove(ps, cmd, world, vars, FT, ev);
            st.ticks++;
            if (!Number.isFinite(ps.origin.x + ps.origin.y + ps.origin.z)) st.nan++;
            if (inSolid(ps)) st.inSolid++;
          }
        }
        console.log(`[movement] ${name}: ${spawns.length} spawns, ${landedCount} landed, ${st.ticks} wander ticks, inSolid ${st.inSolid}`);
        expect(landedCount).toBeGreaterThan(spawns.length * 0.8);
        expect(st.nan).toBe(0);
        expect(st.inSolid).toBe(0);
      });

      it('surfs the real ramp faces: never in solid, no velocity kills', () => {
        const vars = defaultMoveVars();
        const st = newStats();
        const tr = newTrace();
        const hull = { mins: v3(-16, -16, 0), maxs: v3(16, 16, 72) };
        const sample = ramps.slice(0, 40);
        let tested = 0;
        for (const r of sample) {
          // drop onto the face along its normal
          const start = v3(r.c.x + r.n.x * 60, r.c.y + r.n.y * 60, r.c.z + r.n.z * 60 - 36 * r.n.z);
          const end = v3(start.x - r.n.x * 120, start.y - r.n.y * 120, start.z - r.n.z * 120);
          world.traceBox(start, end, hull.mins, hull.maxs, MASK_PLAYERSOLID, tr);
          if (tr.startsolid || tr.fraction >= 1) continue;
          const tn = tr.plane.normal;
          if (Math.abs(tn.x - r.n.x) + Math.abs(tn.y - r.n.y) + Math.abs(tn.z - r.n.z) > 1e-3) continue;
          tested++;
          const ps = createPlayerState(v3(tr.endpos.x, tr.endpos.y, tr.endpos.z));
          ps.moveType = MOVETYPE_WALK;
          // along the ramp, horizontally
          let tx = -r.n.y, ty = r.n.x;
          const tl = Math.hypot(tx, ty);
          tx /= tl;
          ty /= tl;
          for (const dirSign of [1, -1]) {
            ps.origin = v3(tr.endpos.x, tr.endpos.y, tr.endpos.z);
            ps.velocity = v3(tx * 900 * dirSign, ty * 900 * dirSign, 0);
            ps.onGround = false;
            ps.ducked = false;
            const yaw = (Math.atan2(ty * dirSign, tx * dirSign) * 180) / Math.PI;
            const rx = Math.sin((yaw * Math.PI) / 180), ry = -Math.cos((yaw * Math.PI) / 180);
            const intoX = -r.n.x, intoY = -r.n.y;
            const smove = rx * intoX + ry * intoY > 0 ? 450 : -450;
            const ev = newMoveEvents();
            const cmd = newUserCmd();
            cmd.viewangles.yaw = yaw;
            let prevSpeed = 900;
            let prevAir = true;
            let prev = { ...ps.origin };
            for (let i = 0; i < 200; i++) {
              cmd.sidemove = (i % 75) < 50 ? smove : 0;
              playerMove(ps, cmd, world, vars, FT, ev);
              st.ticks++;
              const o = ps.origin;
              if (!Number.isFinite(o.x + o.y + o.z)) {
                st.nan++;
                break;
              }
              if (inSolid(ps)) {
                st.inSolid++;
                if (st.notes.length < 5) st.notes.push(`in solid near ${o.x.toFixed(1)} ${o.y.toFixed(1)} ${o.z.toFixed(1)}`);
              }
              const v = ps.velocity;
              const speed = Math.hypot(v.x, v.y, v.z);
              const air = !ps.onGround;
              if (air && prevAir && prevSpeed > 100) {
                if (speed < 1) {
                  st.kills++;
                  if (st.notes.length < 5) st.notes.push(`kill near ${o.x.toFixed(1)} ${o.y.toFixed(1)} ${o.z.toFixed(1)} (ramp n ${r.n.x.toFixed(3)},${r.n.y.toFixed(3)},${r.n.z.toFixed(3)})`);
                }
                const moved = Math.hypot(o.x - prev.x, o.y - prev.y, o.z - prev.z);
                if (moved < prevSpeed * FT * 0.25) st.stalls++;
              }
              prevSpeed = speed;
              prevAir = air;
              prev = { ...o };
            }
          }
        }
        console.log(
          `[movement] ${name}: surfed ${tested} ramp faces, ${st.ticks} ticks, inSolid ${st.inSolid}, kills ${st.kills}, stalls ${st.stalls}` +
            (st.notes.length ? `\n  ${st.notes.join('\n  ')}` : ''),
        );
        expect(st.nan).toBe(0);
        expect(st.inSolid).toBe(0);
        expect(st.kills).toBe(0);
      });
    });
  }
});
