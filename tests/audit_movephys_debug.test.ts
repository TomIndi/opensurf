import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildBrushModels, collectCollisionBrushes } from '../src/bsp/bspcollision';
import { parseEntities } from '../src/bsp/entities';
import { parseBsp } from '../src/bsp/reader';
import { Vec3 } from '../src/core/vec3';
import { CollisionWorld } from '../src/physics/collision';
import { defaultMoveVars, playerMove } from '../src/physics/movement';
import { PlayerState, newMoveEvents } from '../src/physics/playertypes';
import { TraceResult, TraceWorld } from '../src/physics/types';

const DIR = process.env.SURF_TEST_MAPS ?? '';

class Spy implements TraceWorld {
  ps: PlayerState | null = null;
  log: string[] = [];
  constructor(readonly w: CollisionWorld) {}
  traceBox(s: Vec3, e: Vec3, mn: Vec3, mx: Vec3, mask: number, out?: TraceResult): TraceResult {
    const p = this.ps!;
    const pre = `   [v=${p.velocity.x.toFixed(3)},${p.velocity.y.toFixed(3)},${p.velocity.z.toFixed(3)} og=${p.onGround} sf=${p.surfaceFriction}]`;
    const t = this.w.traceBox(s, e, mn, mx, mask, out);
    this.log.push(`trace ${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)} -> ${e.x.toFixed(4)},${e.y.toFixed(4)},${e.z.toFixed(4)} mask=${mask} f=${t.fraction.toFixed(5)} ss=${t.startsolid} as=${t.allsolid} n=${t.plane.normal.x.toFixed(4)},${t.plane.normal.y.toFixed(4)},${t.plane.normal.z.toFixed(4)}` + pre);
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

describe.skipIf(!DIR)('audit debug', () => {
  it('rookie', () => {
    const b = readFileSync(join(DIR, 'surf_rookie.bsp'));
    const bsp = parseBsp(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const ents = parseEntities(bsp.entitiesText);
    const models = buildBrushModels(bsp, { entities: ents });
    const set = collectCollisionBrushes(bsp, ents, models);
    const world = new CollisionWorld(set.brushes);
    for (const m of set.disabledModels) world.setModelSolid(m, false);
    const before = JSON.parse(
      '{"origin":{"x":1660.5888102335084,"y":4063.9999999999995,"z":4521.81248745551},"velocity":{"x":0,"y":600,"z":0},"baseVelocity":{"x":0,"y":0,"z":0},"viewAngles":{"pitch":0,"yaw":0,"roll":0},"viewOffsetZ":64,"moveType":2,"flags":0,"onGround":false,"groundNormal":{"x":0,"y":0,"z":1},"groundModel":-1,"ducked":false,"ducking":false,"duckAmount":0,"waterLevel":0,"waterType":0,"waterJumpTime":0,"waterJumpVel":{"x":0,"y":0,"z":0},"surfaceFriction":1,"gravityScale":1,"laggedMovement":1,"maxSpeedOverride":0,"oldButtons":0,"fallVelocity":0,"duckTimer":0}',
    );
    const cmd = JSON.parse('{"forwardmove":0,"sidemove":-450,"upmove":0,"buttons":0,"viewangles":{"pitch":0,"yaw":90,"roll":0}}');
    const spy = new Spy(world);
    spy.ps = before;
    for (let i = 0; i < 3; i++) {
      spy.log.push(`--- tick ${i}`);
      playerMove(before, cmd, spy, defaultMoveVars(), 0.01, newMoveEvents());
      spy.log.push(`=> v=${JSON.stringify(before.velocity)} o=${JSON.stringify(before.origin)} og=${before.onGround}`);
    }
    // what is under/around?
    console.log(spy.log.join('\n'));
    const bi = world.brushIndexAt ? 0 : 0;
    void bi;
  });
});
