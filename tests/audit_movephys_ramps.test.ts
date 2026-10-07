import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildBrushModels, collectCollisionBrushes } from '../src/bsp/bspcollision';
import { parseEntities } from '../src/bsp/entities';
import { parseBsp } from '../src/bsp/reader';
import { Vec3, v3 } from '../src/core/vec3';
import { brushWindings } from '../src/physics/brushbuild';
import { CollisionWorld } from '../src/physics/collision';
import { defaultMoveVars, movementOptions, playerMove } from '../src/physics/movement';
import { MOVETYPE_WALK, createPlayerState, newMoveEvents, newUserCmd } from '../src/physics/playertypes';
import { MASK_PLAYERSOLID, TraceResult, TraceWorld, newTrace } from '../src/physics/types';

const DIR = process.env.SURF_TEST_MAPS ?? '';
const MAPS = ['surf_utopia_njv', 'surf_kitsune', 'surf_mesa_fixed', 'surf_lt_omnific'];

class Spy implements TraceWorld {
  allsolid = 0;
  startsolid = 0;
  oddHits: string[] = [];
  rampN: Vec3 | null = null;
  hits = 0;
  tickHits: string[] = [];
  constructor(readonly w: CollisionWorld) {}
  traceBox(s: Vec3, e: Vec3, mn: Vec3, mx: Vec3, mask: number, out?: TraceResult): TraceResult {
    const t = this.w.traceBox(s, e, mn, mx, mask, out);
    if (s.x !== e.x || s.y !== e.y || s.z !== e.z) {
      if (t.allsolid) this.allsolid++;
      else if (t.startsolid) this.startsolid++;
      if (t.fraction < 1 && !t.allsolid) { this.hits++; const n = t.plane.normal; this.tickHits.push(`${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}@${t.fraction.toFixed(3)}`); }
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

describe.skipIf(!DIR)('audit ramps', () => {
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
      const ramps: { c: Vec3; n: Vec3; area: number }[] = [];
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
          if (ax < 128 * 128) continue;
          ramps.push({ c: v3(cx / ax, cy / ax, cz / ax), n: v3(n.x, n.y, n.z), area: ax });
        }
      }
      ramps.sort((a, b2) => b2.area - a.area);
      const vars = defaultMoveVars();
      const tr = newTrace();
      const hull = { mins: v3(-16, -16, 0), maxs: v3(16, 16, 72) };
      const out: string[] = [];
      let tested = 0;
      const agg = { ticks: 0, allsolid: 0, startsolid: 0, bigDrops: 0, kills: 0, dropSamples: [] as string[], fixDiff: 0 };
      for (const fix of [true, false]) {
        movementOptions.rampbugFix = fix;
        let tot = { ticks: 0, allsolid: 0, startsolid: 0, bigDrops: 0, kills: 0 };
        tested = 0;
        for (const r of ramps.slice(0, 120)) {
          const start = v3(r.c.x + r.n.x * 60, r.c.y + r.n.y * 60, r.c.z + r.n.z * 60 - 36 * r.n.z);
          const end = v3(start.x - r.n.x * 120, start.y - r.n.y * 120, start.z - r.n.z * 120);
          world.traceBox(start, end, hull.mins, hull.maxs, MASK_PLAYERSOLID, tr);
          if (tr.startsolid || tr.fraction >= 1) continue;
          const tn = tr.plane.normal;
          if (Math.abs(tn.x - r.n.x) + Math.abs(tn.y - r.n.y) + Math.abs(tn.z - r.n.z) > 1e-3) continue;
          tested++;
          let tx = -r.n.y, ty = r.n.x;
          const tl = Math.hypot(tx, ty);
          tx /= tl;
          ty /= tl;
          for (const sgn of [1, -1]) {
            for (const spd of [800, 2000, 3400]) {
              const spy = new Spy(world);
              const ps = createPlayerState(v3(tr.endpos.x, tr.endpos.y, tr.endpos.z));
              ps.moveType = MOVETYPE_WALK;
              ps.velocity = v3(tx * spd * sgn, ty * spd * sgn, 0);
              const yaw = (Math.atan2(ty * sgn, tx * sgn) * 180) / Math.PI;
              const rx = Math.sin((yaw * Math.PI) / 180), ry = -Math.cos((yaw * Math.PI) / 180);
              const smove = rx * -r.n.x + ry * -r.n.y > 0 ? 450 : -450;
              const ev = newMoveEvents();
              const cmd = newUserCmd();
              cmd.viewangles.yaw = yaw;
              cmd.sidemove = smove;
              let prev = Math.hypot(ps.velocity.x, ps.velocity.y, ps.velocity.z);
              for (let i = 0; i < 150; i++) {
                const a0 = spy.allsolid;
                spy.tickHits.length = 0;
                playerMove(ps, cmd, spy, vars, 0.01, ev);
                tot.ticks++;
                const v = ps.velocity;
                const s = Math.hypot(v.x, v.y, v.z);
                // contact with this ramp plane? (cheap: distance of the hull's support point to plane)
                if (!ps.onGround && prev > 300) {
                  if (s < 1) tot.kills++;
                  else if (s < prev - 40) {
                    tot.bigDrops++;
                    const rampish = spy.tickHits.length > 0 && spy.tickHits.every((h) => { const z = parseFloat(h.split(',')[2]); return z > 0.3 && z < 0.7; });
                    if (!rampish) { prev = s; if (ps.onGround) break; continue; }
                    if (agg.dropSamples.length < 40 && fix)
                      agg.dropSamples.push(
                        `${name} fix=${fix} tick ${i} speed ${prev.toFixed(0)}->${s.toFixed(0)} at ${ps.origin.x.toFixed(1)},${ps.origin.y.toFixed(1)},${ps.origin.z.toFixed(1)} ramp n=${r.n.x.toFixed(3)},${r.n.y.toFixed(3)},${r.n.z.toFixed(3)} lastHitBrush=${world.lastHitBrush} allsolidThisTick=${spy.allsolid - a0} hits=[${spy.tickHits.join(' ')}]`,
                      );
                  }
                }
                if (ps.onGround) break;
                prev = s;
              }
              tot.allsolid += spy.allsolid;
              tot.startsolid += spy.startsolid;
            }
          }
        }
        out.push(`${name} fix=${fix}: ramps ${tested} ticks ${tot.ticks} allsolid ${tot.allsolid} startsolid ${tot.startsolid} bigDrops ${tot.bigDrops} kills ${tot.kills}`);
      }
      movementOptions.rampbugFix = true;
      console.log(out.join('\n') + '\n' + agg.dropSamples.join('\n'));
    }, 600000);
  }
});
