import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildBrushModels, collectCollisionBrushes } from '../src/bsp/bspcollision';
import { parseEntities } from '../src/bsp/entities';
import { parseBsp } from '../src/bsp/reader';
import { Vec3, v3 } from '../src/core/vec3';
import { brushFromPlanes, brushWindings } from '../src/physics/brushbuild';
import { CollisionWorld } from '../src/physics/collision';
import { defaultMoveVars, movementOptions, playerMove } from '../src/physics/movement';
import { MOVETYPE_WALK, PlayerState, createPlayerState, newMoveEvents, newUserCmd } from '../src/physics/playertypes';
import { CONTENTS_SOLID, MASK_PLAYERSOLID, TraceResult, TraceWorld, newTrace } from '../src/physics/types';

const DIR = process.env.SURF_TEST_MAPS ?? '';
const MAPS = (process.env.AUDIT_MAPS ?? 'surf_utopia_njv,surf_kitsune,surf_mesa_fixed,surf_lt_omnific,surf_beginner,surf_rookie,surf_ing,surf_aircontrol_ksf').split(',');
const TICK = parseFloat(process.env.AUDIT_TICK ?? '0.01');

class Spy implements TraceWorld {
  log: string[] | null = null;
  allsolid = 0;
  hits: Vec3[] = [];
  constructor(readonly w: CollisionWorld) {}
  traceBox(s: Vec3, e: Vec3, mn: Vec3, mx: Vec3, mask: number, out?: TraceResult): TraceResult {
    const t = this.w.traceBox(s, e, mn, mx, mask, out);
    if (this.log) this.log.push(`  trace ${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)} -> ${e.x.toFixed(4)},${e.y.toFixed(4)},${e.z.toFixed(4)} hull ${mx.z} f=${t.fraction.toFixed(5)} ss=${t.startsolid} as=${t.allsolid} n=${t.plane.normal.x.toFixed(4)},${t.plane.normal.y.toFixed(4)},${t.plane.normal.z.toFixed(4)} d=${t.plane.dist.toFixed(4)}`);
    const moving = s.x !== e.x || s.y !== e.y || s.z !== e.z;
    const probe = s.x === e.x && s.y === e.y && Math.abs(s.z - e.z - 2) < 1e-9;
    if (moving && !probe && mn.x === -16 && mx.x === 16) {
      if (t.allsolid) this.allsolid++;
      if (t.fraction < 1 && !t.allsolid) this.hits.push(v3(t.plane.normal.x, t.plane.normal.y, t.plane.normal.z));
    }
    return t;
  }
  traceRay(s: Vec3, e: Vec3, mask: number, out?: TraceResult): TraceResult {
    return this.w.traceRay(s, e, mask, out);
  }
  pointContents(p: Vec3, mask?: number): number {
    return this.w.pointContents(p, mask);
  }
  testBox(o: Vec3, mn: Vec3, mx: Vec3, mask: number): boolean {
    return this.w.testBox(o, mn, mx, mask);
  }
}

function clonePs(ps: PlayerState): PlayerState {
  return JSON.parse(JSON.stringify(ps));
}

describe.skipIf(!DIR)('audit seams', () => {
  for (const name of MAPS) {
    const path = join(DIR, name + '.bsp');
    if (!existsSync(path)) continue;
    it(name, () => {
      const b = readFileSync(path);
      const bsp = parseBsp(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      const ents = parseEntities(bsp.entitiesText);
      const models = buildBrushModels(bsp, { entities: ents });
      const set = collectCollisionBrushes(bsp, ents, models);
      const world = new CollisionWorld(set.brushes);
      for (const m of set.disabledModels) world.setModelSolid(m, false);
      const ramps: { c: Vec3; n: Vec3; d: number; area: number }[] = [];
      for (const br of models[0].brushes) {
        if ((br.contents & MASK_PLAYERSOLID) === 0) continue;
        const ws = brushWindings(br);
        for (let i = 0; i < ws.length; i++) {
          const w = ws[i];
          if (w.length < 3 || br.sides[i].bevel) continue;
          const n = br.sides[i].plane.normal;
          if (n.z < 0.35 || n.z >= 0.7) continue;
          let ax = 0, cx = 0, cy = 0, cz = 0;
          for (let k = 1; k + 1 < w.length; k++) {
            const ux = w[k].x - w[0].x, uy = w[k].y - w[0].y, uz = w[k].z - w[0].z;
            const vx = w[k + 1].x - w[0].x, vy = w[k + 1].y - w[0].y, vz = w[k + 1].z - w[0].z;
            const a = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
            ax += a;
            cx += (a * (w[0].x + w[k].x + w[k + 1].x)) / 3;
            cy += (a * (w[0].y + w[k].y + w[k + 1].y)) / 3;
            cz += (a * (w[0].z + w[k].z + w[k + 1].z)) / 3;
          }
          if (ax < 64 * 64) continue;
          ramps.push({ c: v3(cx / ax, cy / ax, cz / ax), n: v3(n.x, n.y, n.z), d: br.sides[i].plane.dist, area: ax });
        }
      }
      ramps.sort((a, b2) => b2.area - a.area);
      const vars = defaultMoveVars();
      const tr = newTrace();
      const hull = { mins: v3(-16, -16, 0), maxs: v3(16, 16, 72) };
      let tested = 0;
      const st = { ticks: 0, onRamp: 0, seamTicks: 0, seamLoss: 0, maxLoss: 0, allsolid: 0, divergeOther: 0, gain: 0, samples: [] as string[] };
      for (const r of ramps.slice(0, 300)) {
        const start = v3(r.c.x + r.n.x * 60, r.c.y + r.n.y * 60, r.c.z + r.n.z * 60 - 36 * r.n.z);
        const end = v3(start.x - r.n.x * 120, start.y - r.n.y * 120, start.z - r.n.z * 120);
        world.traceBox(start, end, hull.mins, hull.maxs, MASK_PLAYERSOLID, tr);
        if (tr.startsolid || tr.fraction >= 1) continue;
        const tn = tr.plane.normal;
        if (Math.abs(tn.x - r.n.x) + Math.abs(tn.y - r.n.y) + Math.abs(tn.z - r.n.z) > 1e-3) continue;
        tested++;
        const idealCache = new Map<string, CollisionWorld>();
        const idealFor = (nx: number, ny: number, nz: number, d: number): CollisionWorld => {
          const key = `${nx},${ny},${nz},${d}`;
          let w = idealCache.get(key);
          if (!w) {
            w = new CollisionWorld([
              brushFromPlanes(
                [
                  { normal: v3(nx, ny, nz), dist: d },
                  { normal: v3(1, 0, 0), dist: 16000 },
                  { normal: v3(-1, 0, 0), dist: 16000 },
                  { normal: v3(0, 1, 0), dist: 16000 },
                  { normal: v3(0, -1, 0), dist: 16000 },
                  { normal: v3(0, 0, -1), dist: 16000 },
                ],
                CONTENTS_SOLID,
              )!,
            ]);
            idealCache.set(key, w);
          }
          return w;
        };
        const probe = newTrace();
        const pend = v3();
        let tx = -r.n.y, ty = r.n.x;
        const tl = Math.hypot(tx, ty);
        tx /= tl;
        ty /= tl;
        for (const sgn of [1, -1]) {
          for (const spd of [600, 1500, 3000]) {
            for (const pattern of [0, 1]) {
              const spy = new Spy(world);
              const ps = createPlayerState(v3(tr.endpos.x, tr.endpos.y, tr.endpos.z));
              ps.moveType = MOVETYPE_WALK;
              ps.velocity = v3(tx * spd * sgn, ty * spd * sgn, pattern ? 150 : 0);
              const yaw = (Math.atan2(ty * sgn, tx * sgn) * 180) / Math.PI;
              const rx = Math.sin((yaw * Math.PI) / 180), ry = -Math.cos((yaw * Math.PI) / 180);
              const smove = rx * -r.n.x + ry * -r.n.y > 0 ? 450 : -450;
              const ev = newMoveEvents();
              const ev2 = newMoveEvents();
              const cmd = newUserCmd();
              cmd.viewangles.yaw = yaw;
              for (let i = 0; i < Math.round(1.5 / TICK); i++) {
                cmd.sidemove = pattern === 0 ? smove : i % 30 < 20 ? smove : 0;
                const before = clonePs(ps);
                pend.x = ps.origin.x - r.n.x * 3;
                pend.y = ps.origin.y - r.n.y * 3;
                pend.z = ps.origin.z - r.n.z * 3;
                world.traceBox(ps.origin, pend, hull.mins, hull.maxs, MASK_PLAYERSOLID, probe);
                const probeOk = !probe.startsolid && probe.fraction < 1 && probe.plane.normal.x * r.n.x + probe.plane.normal.y * r.n.y + probe.plane.normal.z * r.n.z > 0.9999;
                const ideal = probeOk ? idealFor(probe.plane.normal.x, probe.plane.normal.y, probe.plane.normal.z, probe.plane.dist) : null;
                spy.hits.length = 0;
                const a0 = spy.allsolid;
                playerMove(ps, cmd, spy, vars, TICK, ev);
                st.ticks++;
                if (ps.onGround) break;
                if (!ideal) continue;
                // ideal step from the same state
                const ip = clonePs(before);
                const ispy = new Spy(ideal);
                playerMove(ip, cmd, ispy, vars, TICK, ev2);
                if ((globalThis as any).__dumped !== true && Math.hypot(ip.velocity.x, ip.velocity.y, ip.velocity.z) - Math.hypot(ps.velocity.x, ps.velocity.y, ps.velocity.z) > 4 && Math.hypot(ps.velocity.x, ps.velocity.y, ps.velocity.z) > 100 && spy.hits.every((h) => h.x * r.n.x + h.y * r.n.y + h.z * r.n.z > 0.999)) {
                  (globalThis as any).__dumped = true;
                  const rp = clonePs(before);
                  const rs = new Spy(world); rs.log = [];
                  playerMove(rp, cmd, rs, vars, TICK, newMoveEvents());
                  const ip2 = clonePs(before);
                  const is2 = new Spy(ideal); is2.log = [];
                  playerMove(ip2, cmd, is2, vars, TICK, newMoveEvents());
                  console.log('BEFORE ' + JSON.stringify(before) + ' cmd ' + JSON.stringify(cmd) + '\nREAL -> v ' + JSON.stringify(rp.velocity) + ' o ' + JSON.stringify(rp.origin) + ' sf ' + rp.surfaceFriction + '\n' + rs.log.join('\n') + '\nIDEAL -> v ' + JSON.stringify(ip2.velocity) + ' o ' + JSON.stringify(ip2.origin)+ ' sf ' + ip2.surfaceFriction + '\n' + is2.log.join('\n'));
                }
                const sR = Math.hypot(ps.velocity.x, ps.velocity.y, ps.velocity.z);
                const sI = Math.hypot(ip.velocity.x, ip.velocity.y, ip.velocity.z);
                st.onRamp++;
                if (spy.allsolid > a0) st.allsolid++;
                const allRampish = spy.hits.every((h) => h.x * r.n.x + h.y * r.n.y + h.z * r.n.z > 0.999);
                const loss = sI - sR;
                if (Math.abs(loss) > 0.5) {
                  if (allRampish) {
                    if (loss > 0) {
                      st.seamTicks++;
                      st.seamLoss += loss;
                      if (loss > st.maxLoss) st.maxLoss = loss;
                      if (st.samples.length < 10)
                        st.samples.push(
                          `${name} loss ${loss.toFixed(1)} (ideal ${sI.toFixed(0)} real ${sR.toFixed(0)}) at ${before.origin.x.toFixed(2)},${before.origin.y.toFixed(2)},${before.origin.z.toFixed(2)} n=${r.n.x.toFixed(4)},${r.n.y.toFixed(4)},${r.n.z.toFixed(4)} hits=${spy.hits.map((h) => `${h.x.toFixed(4)},${h.y.toFixed(4)},${h.z.toFixed(4)}`).join(' | ')}`,
                        );
                    } else st.gain += -loss;
                  } else st.divergeOther++;
                }
              }
            }
          }
        }
      }
      console.log(
        `${name} tick=${TICK}: ramps ${tested} ticks ${st.ticks} onRamp ${st.onRamp} allsolid ${st.allsolid} seamLossTicks ${st.seamTicks} totalSeamLoss ${st.seamLoss.toFixed(1)} maxLoss ${st.maxLoss.toFixed(1)} seamGain ${st.gain.toFixed(1)} divergeOther ${st.divergeOther}\n` +
          st.samples.join('\n'),
      );
    }, 900000);
  }
});
