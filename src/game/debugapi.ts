// window.__surf: a small scripting surface for automated browser tests and debugging, plus the URL parameters
// that drive automated sessions:
//   ?map=<catalog name>   ?builtin=<id>   ?bsp=<url>   load that map at startup
//   ?autotest=1           no pointer lock needed, never pause when it is lost (headless browsers)
import { QAngle } from '../core/angles';
import { console_, ConsoleLine } from '../core/cvars';
import { v3 } from '../core/vec3';
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
  };
}

/** Installs window.__surf. */
export function installDebugApi(game: Game): SurfDebugApi {
  const api = createDebugApi(game);
  if (typeof window !== 'undefined') (window as unknown as { __surf?: SurfDebugApi }).__surf = api;
  return api;
}
