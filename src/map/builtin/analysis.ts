// Gap feasibility for the built-in maps: given where and how fast a run left each ramp (from an autopilot
// run), a ballistic estimate (gravity 800, no air control) of whether the next ramp is reachable, how much
// height to spare there is, and the slowest exit that would still make it. Used by tests/builtin.test.ts to
// print a feasibility table and to check every gap has a safety margin.
import { Vec3, v3 } from '../../core/vec3';
import { HULL_MINS } from '../../physics/playertypes';
import type { PilotEvent } from './autopilot';
import { Autopilot } from './autopilot';
import { MapBuilder } from './builder';
import { rampFrame } from './course';
import { PushVolume, predictFlight, pushVector } from './parts';

export type GapKind = 'gap' | 'boost' | 'portal';

export interface GapReport {
  from: string;
  to: string;
  kind: GapKind;
  /** Horizontal speed and vertical velocity when leaving `from`. */
  exitSpeed: number;
  exitVz: number;
  /** Horizontal distance from the exit point to where the line of flight first reaches the next face. */
  gap: number;
  /** Height of the exit above the next face there (player origin vs the origin riding the face). */
  drop: number;
  /** Ballistic fall over the gap at the exit speed. */
  fall: number;
  /** drop - fall: > 0 means the run is still above the face when it gets there. */
  clearance: number;
  /** Slowest exit (same direction, ridge-following vertical speed) that still clears the gap. */
  minSpeed: number;
  /** exitSpeed / minSpeed. */
  margin: number;
  /** Where the run actually landed on the next ramp (along its ridge), or null. */
  landAlong: number | null;
  /** Length of the next ramp. */
  nextLength: number;
  ok: boolean;
}

const G = 800;

/** Push volumes of a built map's trigger_push entities. */
export function pushVolumes(b: MapBuilder): PushVolume[] {
  const out: PushVolume[] = [];
  for (const t of b.triggers) {
    if (t.classname !== 'trigger_push') continue;
    const a = (t.kv.pushdir ?? '0 0 0').split(/\s+/).map(Number);
    out.push({ mins: t.mins, maxs: t.maxs, push: pushVector(a[0] || 0, a[1] || 0, Number(t.kv.speed) || 0) });
  }
  return out;
}

function segBoxHit(a: Vec3, b: Vec3, mins: Vec3, maxs: Vec3): boolean {
  // slab test of the segment a-b (thickened by the player hull) against the box
  let t0 = 0;
  let t1 = 1;
  const lo = [mins.x - 16, mins.y - 16, mins.z - 72];
  const hi = [maxs.x + 16, maxs.y + 16, maxs.z];
  const pa = [a.x, a.y, a.z];
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (pa[k] < lo[k] || pa[k] > hi[k]) return false;
      continue;
    }
    let ta = (lo[k] - pa[k]) / d[k];
    let tb = (hi[k] - pa[k]) / d[k];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Feasibility of every ramp-to-ramp transition the run made. `events` are the autopilot's land/leave events of
 * one run (a full run or a section restart); `minMargin` is the required exitSpeed/minSpeed ratio.
 */
export function analyzeGaps(pilot: Autopilot, events: PilotEvent[], builder: MapBuilder, minMargin = 1.1): GapReport[] {
  const out: GapReport[] = [];
  const pushes = pushVolumes(builder);
  for (let e = 0; e < events.length; e++) {
    const lv = events[e];
    if (lv.kind !== 'leave') continue;
    const i = lv.ramp;
    const A = pilot.ramps[i];
    const B = pilot.ramps[i + 1];
    if (!B) continue;
    const portal = A.section !== B.section && !!pilot.course.sections[A.section].exit;
    // the matching landing on the next ramp
    let land: PilotEvent | null = null;
    for (let k = e + 1; k < events.length; k++) {
      if (events[k].kind === 'land' && events[k].ramp === i + 1) {
        land = events[k];
        break;
      }
      if (events[k].kind === 'leave' || (events[k].kind === 'land' && events[k].ramp !== i + 1)) break;
    }
    const p0 = lv.origin;
    const v0 = lv.velocity;
    const vh = Math.hypot(v0.x, v0.y);
    const base = {
      from: A.ramp.name,
      to: B.ramp.name,
      exitSpeed: vh,
      exitVz: v0.z,
      landAlong: land ? rampFrame(B.ramp, B.face, land.origin).along : null,
      nextLength: rampFrame(B.ramp, B.face, B.ramp.points[0]).length,
    };
    if (portal) {
      out.push({ ...base, kind: 'portal', gap: 0, drop: 0, fall: 0, clearance: 0, minSpeed: 0, margin: Infinity, ok: true });
      continue;
    }
    const target = land ? land.origin : pilot.landTarget(i + 1);
    const boosted = pushes.some((pv) => segBoxHit(p0, target, pv.mins, pv.maxs) || segBoxHit(p0, v3(p0.x + v0.x * 0.5, p0.y + v0.y * 0.5, p0.z), pv.mins, pv.maxs));
    if (boosted) {
      // ballistic flight through the booster(s): does it come down on the next ramp's face?
      const len = base.nextLength;
      const hullOff = 28;
      let along: number | null = null;
      try {
        const f = predictFlight(p0, v0, {
          pushes,
          untilZ: -1e9,
          maxT: 8,
          stop: (p) => {
            const fr = rampFrame(B.ramp, B.face, p);
            if (fr.along < -200 || fr.lateral < -64 || fr.lateral > B.ramp.width + 64) return false;
            const faceZ = fr.ridgeZ - (fr.lateral / B.ramp.width) * B.ramp.height;
            return p.z < faceZ + hullOff;
          },
        });
        along = rampFrame(B.ramp, B.face, f.pos).along;
      } catch {
        along = null;
      }
      const ok = along !== null && along > 0 && along < len;
      out.push({ ...base, kind: 'boost', gap: 0, drop: 0, fall: 0, clearance: 0, minSpeed: 0, margin: ok ? Infinity : 0, ok });
      continue;
    }
    // walk the straight line of flight (exit -> landing) until it is over the next face
    const dx = target.x - p0.x;
    const dy = target.y - p0.y;
    const dist = Math.hypot(dx, dy);
    let entry: Vec3 | null = null;
    let entryDist = dist;
    for (let s = 0; s <= dist; s += 8) {
      const q = v3(p0.x + (dx / dist) * s, p0.y + (dy / dist) * s, 0);
      const fr = rampFrame(B.ramp, B.face, q);
      if (fr.along >= 0 && fr.lateral >= 0 && fr.lateral <= B.ramp.width) {
        entry = q;
        entryDist = s;
        break;
      }
    }
    if (!entry) entry = v3(target.x, target.y, 0);
    const fr = rampFrame(B.ramp, B.face, entry);
    const n = fr.normal;
    // a standing hull riding the face keeps its origin this far above the face (vertically)
    const off = (-HULL_MINS.x * (Math.abs(n.x) + Math.abs(n.y))) / n.z;
    const faceZ = fr.ridgeZ - (Math.max(0, Math.min(1, fr.lateral / B.ramp.width)) * B.ramp.height);
    const drop = p0.z - (faceZ + off);
    const gap = entryDist;
    const t = gap / Math.max(1, vh);
    const fall = -v0.z * t + (G / 2) * t * t;
    const clearance = drop - fall;
    const vzRatio = vh > 1 ? v0.z / vh : 0;
    const denom = drop + vzRatio * gap;
    const minSpeed = gap < 1 ? 0 : denom > 0 ? gap * Math.sqrt(G / 2 / denom) : Infinity;
    const margin = minSpeed > 0 ? vh / minSpeed : Infinity;
    const landed = base.landAlong !== null && base.landAlong >= -32 && base.landAlong <= base.nextLength;
    out.push({ ...base, kind: 'gap', gap, drop, fall, clearance, minSpeed, margin, ok: landed && clearance > 0 && margin >= minMargin });
  }
  return out;
}

/** Fixed-width text table of gap reports. */
export function formatGapTable(title: string, rows: GapReport[]): string {
  const head = ['from', 'to', 'kind', 'exit u/s', 'vz', 'gap', 'drop', 'fall', 'clear', 'min u/s', 'margin', 'land@', 'len', 'ok'];
  const cells = rows.map((r) => [
    r.from,
    r.to,
    r.kind,
    r.exitSpeed.toFixed(0),
    r.exitVz.toFixed(0),
    r.kind === 'gap' ? r.gap.toFixed(0) : '-',
    r.kind === 'gap' ? r.drop.toFixed(0) : '-',
    r.kind === 'gap' ? r.fall.toFixed(0) : '-',
    r.kind === 'gap' ? r.clearance.toFixed(0) : '-',
    r.kind === 'gap' ? r.minSpeed.toFixed(0) : '-',
    Number.isFinite(r.margin) ? r.margin.toFixed(2) : '-',
    r.landAlong === null ? '-' : r.landAlong.toFixed(0),
    r.nextLength.toFixed(0),
    r.ok ? 'yes' : 'NO',
  ]);
  const w = head.map((h, k) => Math.max(h.length, ...cells.map((c) => c[k].length)));
  const line = (c: string[]): string => c.map((x, k) => (k < 3 ? x.padEnd(w[k]) : x.padStart(w[k]))).join('  ');
  return [title, line(head), line(w.map((n) => '-'.repeat(n))), ...cells.map(line)].join('\n');
}
