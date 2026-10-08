// window.__surf: a small scripting surface for automated browser tests and debugging, plus the URL parameters
// that drive automated sessions:
//   ?map=<catalog name>   ?builtin=<id>   ?bsp=<url>   load that map at startup
//   ?autotest=1           no pointer lock needed, never pause when it is lost (headless browsers)
import { QAngle } from '../core/angles';
import { console_, ConsoleLine } from '../core/cvars';
import { v3 } from '../core/vec3';
import { brushWindings } from '../physics/brushbuild';
import { playerHull } from '../physics/movement';
import { CONTENTS_SOLID, MASK_PLAYERSOLID } from '../physics/types';
import type { GameState, TimerHud } from './api';
import type { Game } from './game';

export interface UrlOptions {
  map: string | null;
  builtin: string | null;
  bsp: string | null;
  autotest: boolean;
}

function truthy(v: string | null): boolean {
  return v !== null && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'no';
}

/** Parses the startup URL parameters (location.search). */
export function parseUrlOptions(search: string): UrlOptions {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search || '');
  } catch {
    p = new URLSearchParams();
  }
  const s = (k: string): string | null => {
    const v = p.get(k);
    return v !== null && v.trim() !== '' ? v.trim() : null;
  };
  return { map: s('map'), builtin: s('builtin'), bsp: s('bsp'), autotest: truthy(p.get('autotest')) };
}

export interface DebugVec {
  x: number;
  y: number;
  z: number;
}

export interface DebugState {
  state: GameState;
  mapName: string | null;
  origin: DebugVec | null;
  velocity: DebugVec | null;
  /** Horizontal speed (u/s). */
  speed: number;
  onGround: boolean;
  ducked: boolean;
  moveType: number;
  angles: QAngle;
  timer: TimerHud | null;
  tick: number;
  practice: boolean;
  spectating: boolean;
}

export interface SurfDebugApi {
  game: Game;
  /** A plain-object snapshot (serializable through Playwright's evaluate). */
  state(): DebugState;
  loadBuiltin(id: string): Promise<DebugState>;
  loadUrl(url: string): Promise<DebugState>;
  loadMap(name: string): Promise<DebugState>;
  setAngles(pitch: number, yaw: number): void;
  /** Teleports the player's feet to (x, y, z) with zero velocity. */
  teleport(x: number, y: number, z: number): void;
  /** Holds a +command ("forward" or "+forward") as if typed at the console; release() lets go. */
  press(cmd: string): void;
  release(cmd: string): void;
  /** Releases every button. */
  releaseAll(): void;
  /** Simulates n ticks immediately (use while paused for deterministic steps). Returns the number run. */
  runTicks(n: number): number;
  /** Runs a console line; returns the console output it produced. */
  exec(line: string): string[];
  /** Chat as the local player (handles !commands). */
  say(text: string): void;
  pause(): void;
  resume(): void;
  /** Sets the player's velocity (u/s). */
  setVelocity(x: number, y: number, z: number): void;
  /** True if the player hull at its current origin overlaps player-solid geometry (stuck). */
  inSolid(): boolean;
  /** The timer zones of the current map (plain objects). */
  zones(): DebugZone[];
  /** Trigger brush entities (bounds, classname, enabled). */
  triggers(): DebugTrigger[];
  /**
   * The largest surfable ramp faces of the world brushes (0.1 < normal.z < 0.7, steeper than walkable, at least
   * 64 units down the slope: no chamfer slivers), biggest first: centre of the face polygon, its outward normal,
   * extents and area. For automated surf tests on real maps.
   */
  findRamps(max?: number): DebugRamp[];
  /** Renderer diagnostics (when the renderer provides debugInfo()). */
  renderInfo(): unknown;
}

export interface DebugZone {
  type: string;
  group: number;
  index: number;
  mins: DebugVec;
  maxs: DebugVec;
}

export interface DebugTrigger {
  classname: string;
  enabled: boolean;
  mins: DebugVec;
  maxs: DebugVec;
}

export interface DebugRamp {
  center: DebugVec;
  normal: DebugVec;
  /** Level surfing direction: horizontal, in the face plane, following `axis`. */
  tangent: DebugVec;
  /** The face's long axis (its longest edge, in the face plane), pointing the way `tangent` goes. */
  axis: DebugVec;
  /** Extent of the face along `axis`, from the centre: [min, max] (min <= 0 <= max). */
  along: [number, number];
  /** Minimal width of the face polygon. */
  width: number;
  /** The face polygon. */
  points: DebugVec[];
  area: number;
  /** Lowest / highest z of the face. */
  minZ: number;
  maxZ: number;
}

function plusName(cmd: string): string {
  const c = cmd.trim().toLowerCase();
  return c.startsWith('+') || c.startsWith('-') ? c.slice(1) : c;
}

/** Builds the debug API object for a game (does not touch window). */
export function createDebugApi(game: Game): SurfDebugApi {
  const snapshot = (): DebugState => {
    const s = game.session;
    const ps = s?.player;
    const a = game.getViewAngles();
    return {
      state: game.state,
      mapName: game.mapName,
      origin: ps ? { x: ps.origin.x, y: ps.origin.y, z: ps.origin.z } : null,
      velocity: ps ? { x: ps.velocity.x, y: ps.velocity.y, z: ps.velocity.z } : null,
      speed: ps ? Math.sqrt(ps.velocity.x * ps.velocity.x + ps.velocity.y * ps.velocity.y) : 0,
      onGround: ps ? ps.onGround : false,
      ducked: ps ? ps.ducked : false,
      moveType: ps ? ps.moveType : 0,
      angles: { pitch: a.pitch, yaw: a.yaw, roll: a.roll },
      timer: s ? { ...s.timer.getHud() } : null,
      tick: s ? s.tickCount : 0,
      practice: s ? s.timer.inPractice : false,
      spectating: game.spectating,
    };
  };
  return {
    game,
    state: snapshot,
    loadBuiltin: async (id) => {
      await game.loadBuiltinMap(id);
      return snapshot();
    },
    loadUrl: async (url) => {
      await game.loadMapUrl(url);
      return snapshot();
    },
    loadMap: async (name) => {
      await game.loadMapByName(name);
      return snapshot();
    },
    setAngles: (pitch, yaw) => game.setViewAngles(pitch, yaw, 0),
    teleport: (x, y, z) => game.teleportPlayer(v3(x, y, z), null, v3()),
    press: (cmd) => console_.executeArgv([`+${plusName(cmd)}`]),
    release: (cmd) => console_.executeArgv([`-${plusName(cmd)}`]),
    releaseAll: () => {
      game.dispatcher.releaseAll();
      game.input.releaseAll();
    },
    runTicks: (n) => game.runTicks(Math.max(0, Math.floor(n))),
    exec: (line) => {
      const out: ConsoleLine[] = [];
      const off = console_.onOutput((l) => out.push(l));
      try {
        console_.execute(line);
      } finally {
        off();
      }
      return out.map((l) => l.text);
    },
    say: (text) => game.say(text),
    pause: () => game.pause(),
    resume: () => game.resume(),
    setVelocity: (x, y, z) => {
      const ps = game.session?.player;
      if (ps) {
        ps.velocity.x = x;
        ps.velocity.y = y;
        ps.velocity.z = z;
      }
    },
    inSolid: () => {
      const s = game.session;
      if (!s) return false;
      const h = playerHull(s.player);
      return s.collision.testBox(s.player.origin, h.mins, h.maxs, MASK_PLAYERSOLID);
    },
    zones: () =>
      game.getZones().map((z) => ({ type: z.type, group: z.group, index: z.index, mins: { ...z.mins }, maxs: { ...z.maxs } })),
    triggers: () => {
      const s = game.session;
      if (!s || typeof s.entities.debugTriggers !== 'function') return [];
      return s.entities.debugTriggers().map((t) => ({ classname: t.classname, enabled: t.enabled, mins: { ...t.mins }, maxs: { ...t.maxs } }));
    },
    findRamps: (max = 20) => {
      const s = game.session;
      if (!s) return [];
      const out: DebugRamp[] = [];
      for (const b of s.collision.brushes) {
        if (b.model !== 0 || !(b.contents & CONTENTS_SOLID)) continue;
        const ws = brushWindings(b);
        for (let i = 0; i < b.sides.length; i++) {
          const side = b.sides[i];
          const n = side.plane.normal;
          if (side.bevel || !(n.z > 0.1 && n.z < 0.7)) continue;
          const w = ws[i];
          if (!w || w.length < 3) continue;
          // polygon area and centroid (fan)
          let ax = 0;
          let ay = 0;
          let az = 0;
          let area = 0;
          let minZ = Infinity;
          let maxZ = -Infinity;
          for (let k = 1; k + 1 < w.length; k++) {
            const a = w[0];
            const p = w[k];
            const q = w[k + 1];
            const ux = p.x - a.x, uy = p.y - a.y, uz = p.z - a.z;
            const vx = q.x - a.x, vy = q.y - a.y, vz = q.z - a.z;
            const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
            const t = Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
            area += t;
            ax += ((a.x + p.x + q.x) / 3) * t;
            ay += ((a.y + p.y + q.y) / 3) * t;
            az += ((a.z + p.z + q.z) / 3) * t;
          }
          for (const p of w) {
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
          }
          if (!(area > 0)) continue;
          const center = { x: ax / area, y: ay / area, z: az / area };
          // the face's long axis (its longest edge, in-plane), its level surfing direction (horizontal, in-plane)
          // and its minimal width (rotating calipers over the edges)
          let ux = 0;
          let uy = 0;
          let uz = 0;
          let best = 0;
          let width = Infinity;
          for (let k = 0; k < w.length; k++) {
            const p = w[k];
            const q = w[(k + 1) % w.length];
            const ex = q.x - p.x;
            const ey = q.y - p.y;
            const ez = q.z - p.z;
            const l = Math.hypot(ex, ey, ez);
            if (!(l > 1e-6)) continue;
            if (l > best) {
              best = l;
              ux = ex / l;
              uy = ey / l;
              uz = ez / l;
            }
            // in-plane edge normal: n x e
            const qx = (n.y * ez - n.z * ey) / l;
            const qy = (n.z * ex - n.x * ez) / l;
            const qz = (n.x * ey - n.y * ex) / l;
            let far = 0;
            for (const r of w) far = Math.max(far, Math.abs((r.x - p.x) * qx + (r.y - p.y) * qy + (r.z - p.z) * qz));
            if (far < width) width = far;
          }
          const hl = Math.hypot(n.x, n.y) || 1;
          let tx = -n.y / hl;
          let ty = n.x / hl;
          // the level direction that follows the long axis
          if (tx * ux + ty * uy < 0) {
            tx = -tx;
            ty = -ty;
          }
          if (ux * tx + uy * ty < 0) {
            ux = -ux;
            uy = -uy;
            uz = -uz;
          }
          let lo = 0;
          let hi = 0;
          for (const p of w) {
            const d = (p.x - center.x) * ux + (p.y - center.y) * uy + (p.z - center.z) * uz;
            if (d < lo) lo = d;
            if (d > hi) hi = d;
          }
          out.push({
            center,
            normal: { x: n.x, y: n.y, z: n.z },
            tangent: { x: tx, y: ty, z: 0 },
            axis: { x: ux, y: uy, z: uz },
            along: [lo, hi],
            width: Number.isFinite(width) ? width : 0,
            points: w.map((p) => ({ x: p.x, y: p.y, z: p.z })),
            area,
            minZ,
            maxZ,
          });
        }
      }
      out.sort((a, b) => b.area - a.area);
      return out.filter((r) => r.width >= 64).slice(0, Math.max(0, max));
    },
    renderInfo: () => {
      const r = game.renderer as { debugInfo?: () => unknown };
      return typeof r.debugInfo === 'function' ? r.debugInfo() : null;
    },
  };
}

/** Installs window.__surf. */
export function installDebugApi(game: Game): SurfDebugApi {
  const api = createDebugApi(game);
  if (typeof window !== 'undefined') (window as unknown as { __surf?: SurfDebugApi }).__surf = api;
  return api;
}
