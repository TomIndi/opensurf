// A fake GameApi for the UI harness (ui-harness.html): animated HUD data, fake chat, simulated map loading and
// a minimal console command set (bind/unbind/binddefaults/...) when the real game-core isn't present.
import { qa } from '../core/angles';
import { console_, conPrint, FCVAR_ARCHIVE, registerCommand, saveArchivedCvars } from '../core/cvars';
import { v3 } from '../core/vec3';
import type { ChatSegment, GameApi, GameEvent, GameState, HudState, LoadProgress, ScoreboardData, UiApi } from '../game/api';
import type { ZoneDef } from '../map/types';
import { getCatalogEntry } from '../maps/catalog';

const MB = 1024 * 1024;

export const DEFAULT_BINDS: Record<string, string> = {
  w: '+forward',
  s: '+back',
  a: '+moveleft',
  d: '+moveright',
  space: '+jump',
  mwheeldown: '+jump',
  mwheelup: '+jump',
  ctrl: '+duck',
  shift: '+speed',
  e: '+use',
  tab: '+showscores',
  '`': 'toggleconsole',
  y: 'messagemode',
  u: 'messagemode2',
  r: 'say !r',
  t: 'say !back',
  mouse4: 'say !saveloc',
  mouse5: 'say !tele',
  f2: 'say !prac',
  escape: 'cancelselect',
};

export const SURF_PREFIX: ChatSegment[] = [
  { text: '[', color: 'grey' },
  { text: 'Surf', color: 'lime' },
  { text: '] ', color: 'grey' },
];

export function demoChatLines(map: string): ChatSegment[][] {
  return [
    [...SURF_PREFIX, { text: 'Welcome to ' }, { text: 'SURF', color: 'lightblue' }, { text: '! Type ' }, { text: '!help', color: 'gold' }, { text: ' for the command list.' }],
    [...SURF_PREFIX, { text: 'Map: ' }, { text: map, color: 'lightblue' }, { text: ' · Tier ' }, { text: '1', color: 'green' }, { text: ' · Staged (8 stages) · Zones by SurfTimer' }],
    [{ text: 'Player', color: 'team' }, { text: ': ' }, { text: 'anyone know the trick on stage 3?' }],
    [...SURF_PREFIX, { text: 'Player', color: 'team' }, { text: ' finished ' }, { text: 'Stage 2', color: 'yellow' }, { text: ' in ' }, { text: '00:21.37', color: 'gold' }, { text: ' (' }, { text: '-0.42', color: 'green' }, { text: ' PB)' }],
    [...SURF_PREFIX, { text: 'Practice mode enabled. ', color: 'yellow' }, { text: 'Type ' }, { text: '!r', color: 'gold' }, { text: ' to go back to the start zone.' }],
    [...SURF_PREFIX, { text: 'Player', color: 'team' }, { text: ' finished the map in ' }, { text: '01:22.91', color: 'gold' }, { text: ' and improved their PB by ' }, { text: '0.54s', color: 'lightgreen' }, { text: ' (rank ' }, { text: '#2', color: 'orange' }, { text: '/14)' }],
    [...SURF_PREFIX, { text: 'NEW SERVER RECORD', color: 'orchid' }, { text: ' on ' }, { text: map, color: 'purple' }, { text: ' — ' }, { text: '01:19.66', color: 'gold' }, { text: ' (' }, { text: '-0.34', color: 'lime' }, { text: ')' }],
    [...SURF_PREFIX, { text: 'Unknown command ', color: 'lightred' }, { text: '!tpo', color: 'red' }, { text: '. Did you mean ', color: 'lightred' }, { text: '!tp', color: 'darkred' }, { text: '?', color: 'lightred' }],
    [{ text: '*SPEC* ', color: 'grey2' }, { text: 'KitsuneFan', color: 'darkblue' }, { text: ': ' }, { text: 'nice run! ', color: 'default' }, { text: 'gg', color: 'olive' }],
  ];
}

export interface MockOptions {
  /** Fixed run time for deterministic screenshots (seconds); null = animated. */
  frozenTime: number | null;
}

export class MockGame implements GameApi {
  state: GameState = 'menu';
  mapName: string | null = null;
  private listeners = new Map<GameEvent, Set<(d?: unknown) => void>>();
  private runStart = performance.now();
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private binds = new Map<string, string>(Object.entries(DEFAULT_BINDS));
  timerState: HudState['timer']['state'] = 'running';
  practice = false;
  noclip = false;
  frozen: number | null;
  /** Split flash: set lastSplitTime to now to trigger. */
  private split = { delta: -0.42 as number | null, time: 1 };
  private hud: HudState;

  constructor(
    private readonly ui: UiApi,
    opts: Partial<MockOptions> = {},
  ) {
    this.frozen = opts.frozenTime ?? null;
    this.hud = {
      visible: false,
      mapName: '',
      tier: 1,
      speed: 0,
      velocity: v3(),
      origin: v3(),
      angles: qa(),
      onGround: false,
      timer: {
        state: 'running',
        time: 0,
        stage: 3,
        stageCount: 8,
        stageTime: 0,
        checkpoint: 0,
        checkpointCount: 0,
        bonus: 0,
        pb: 83.45,
        wr: 79.66,
        mapType: 'staged',
        lastSplitDelta: null,
        lastSplitTime: 0,
      },
      keys: { forward: false, back: false, left: false, right: false, jump: false, duck: false, walk: false, turn: 0 },
      jumps: 0,
      strafes: 0,
      sync: 0,
      practice: false,
      noclip: false,
      spectating: null,
      now: 0,
    };
    this.registerFallbackCommands();
  }

  on(event: GameEvent, cb: (data?: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(event: GameEvent, data?: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  setState(s: GameState): void {
    this.state = s;
    this.emit('statechange', s);
    if (s === 'paused') this.ui.showMenu('pause');
    else if (s === 'playing') this.ui.showMenu('none');
    else if (s === 'menu') this.ui.showMenu('main');
  }

  // ------------------------------------------------------------ loading simulation

  private simulateLoad(name: string, phases: LoadProgress[], stepMs: number): Promise<void> {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.mapName = name;
    this.setState('loading');
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (this.state !== 'loading') return resolve();
        if (i >= phases.length) {
          this.ui.setLoading({ phase: 'done', message: 'Ready' });
          this.ui.setLoading(null);
          this.emit('mapload', name);
          this.runStart = performance.now();
          this.setState('playing');
          for (const l of demoChatLines(name).slice(0, 2)) this.ui.chat(l);
          return resolve();
        }
        this.ui.setLoading(phases[i++]);
        this.loadTimer = setTimeout(step, stepMs);
      };
      step();
    });
  }

  /** Phases of a typical catalog load (download in 10 steps). */
  static catalogPhases(totalMb = 56.3): LoadProgress[] {
    const out: LoadProgress[] = [{ phase: 'download', message: 'Contacting Google Drive…' }];
    for (let i = 1; i <= 10; i++) {
      const loaded = (totalMb * MB * i) / 10;
      out.push({ phase: 'download', message: `Downloading ${(loaded / MB).toFixed(1)} / ${totalMb.toFixed(1)} MB`, loaded, total: totalMb * MB });
    }
    out.push(
      { phase: 'extract', message: 'Extracting map…' },
      { phase: 'parse', message: 'Reading BSP lumps' },
      { phase: 'collision', message: 'Building collision (18 412 brushes)' },
      { phase: 'geometry', message: 'Building geometry', loaded: 1, total: 2 },
      { phase: 'textures', message: 'Decoding textures 214 / 431', loaded: 214, total: 431 },
      { phase: 'textures', message: 'Decoding textures 431 / 431', loaded: 431, total: 431 },
      { phase: 'renderer', message: 'Uploading to GPU' },
    );
    return out;
  }

  loadCatalogMap(name: string): Promise<void> {
    return this.simulateLoad(name, MockGame.catalogPhases(), 350);
  }

  loadMapFile(file: File): Promise<void> {
    const name = file.name.replace(/\.(bz2|rar|zip)$/i, '').replace(/\.bsp$/i, '');
    return this.simulateLoad(name, MockGame.catalogPhases().slice(11), 300);
  }

  loadBuiltinMap(id: string): Promise<void> {
    return this.simulateLoad(id, [
      { phase: 'geometry', message: 'Generating map' },
      { phase: 'renderer', message: 'Uploading to GPU' },
    ], 300);
  }

  disconnect(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.mapName = null;
    this.setState('menu');
  }

  pause(): void {
    if (this.state === 'playing') this.setState('paused');
  }

  resume(): void {
    if (this.state === 'paused') this.setState('playing');
  }

  executeCommand(line: string): void {
    console_.execute(line);
  }

  say(text: string): void {
    const t = text.trim();
    if (t.startsWith('!') || t.startsWith('/')) {
      const cmd = t.slice(1).split(/\s+/)[0].toLowerCase();
      if (cmd === 'r' || cmd === 'restart') {
        this.runStart = performance.now();
        this.practice = false;
        if (t.startsWith('!')) this.ui.chat([{ text: 'Player', color: 'team' }, { text: ': ' }, { text: t }]);
        this.ui.chat([...SURF_PREFIX, { text: 'Teleported to the ' }, { text: 'start zone', color: 'green' }, { text: '.' }]);
        return;
      }
      if (cmd === 'prac' || cmd === 'practice') {
        this.practice = !this.practice;
        this.ui.chat([...SURF_PREFIX, { text: this.practice ? 'Practice mode enabled.' : 'Practice mode disabled.', color: 'yellow' }]);
        return;
      }
      this.ui.chat([...SURF_PREFIX, { text: `Unknown command !${cmd}.`, color: 'lightred' }]);
      return;
    }
    this.ui.chat([{ text: 'Player', color: 'team' }, { text: ': ' }, { text: t }]);
  }

  bindOf(key: string): string | null {
    return this.binds.get(key.toLowerCase()) ?? null;
  }

  /** Triggers a split-delta flash on the HUD. */
  flashSplit(delta: number): void {
    this.split = { delta, time: performance.now() / 1000 };
  }

  getHud(): HudState {
    const h = this.hud;
    const now = performance.now() / 1000;
    const t = this.frozen ?? (performance.now() - this.runStart) / 1000;
    const inGame = this.state === 'playing';
    h.visible = inGame;
    h.mapName = this.mapName ?? '';
    const entry = this.mapName ? getCatalogEntry(this.mapName) : undefined;
    h.tier = entry?.tier ?? 1;
    const speed = Math.max(0, 1180 + 420 * Math.sin(t * 0.7) + 160 * Math.sin(t * 2.3));
    const yaw = 90 + 35 * Math.sin(t * 1.6);
    h.speed = speed;
    h.velocity.x = speed * Math.cos((yaw * Math.PI) / 180);
    h.velocity.y = speed * Math.sin((yaw * Math.PI) / 180);
    h.velocity.z = -120 * Math.sin(t * 1.1);
    h.origin.x = -2410.53 + t * 300;
    h.origin.y = 1288.12 + Math.sin(t) * 400;
    h.origin.z = 4096.03 - t * 20;
    h.angles.pitch = 12.4;
    h.angles.yaw = yaw;
    h.angles.roll = 0;
    h.onGround = false;
    const phase = Math.floor(t / 0.62) % 2;
    h.keys.left = phase === 0;
    h.keys.right = phase === 1;
    h.keys.forward = false;
    h.keys.back = false;
    h.keys.jump = Math.sin(t * 3) > 0.92;
    h.keys.duck = false;
    h.keys.turn = phase === 0 ? -1 : 1;
    const tm = h.timer;
    tm.state = this.practice ? 'practice' : this.timerState;
    tm.time = 47.12 + t;
    tm.stageTime = 12.3 + t;
    tm.lastSplitDelta = this.split.delta;
    tm.lastSplitTime = this.split.time;
    h.jumps = 14 + Math.floor(t / 3);
    h.strafes = 37 + Math.floor(t / 0.62);
    h.sync = 87.4;
    h.practice = this.practice;
    h.noclip = this.noclip;
    h.now = now;
    return h;
  }

  getScoreboard(): ScoreboardData {
    return {
      mapName: this.mapName ?? '',
      tier: this.hud.tier,
      rows: [
        { name: 'Player', time: 83.45, rank: 2, isBot: false, isLocal: true, style: 'Normal' },
        { name: 'Server record (KitsuneFan)', time: 79.66, rank: 1, isBot: true, isLocal: false, style: 'Normal' },
        { name: 'PB replay', time: 83.45, rank: 2, isBot: true, isLocal: false, style: 'Normal' },
      ],
    };
  }

  getZones(): ZoneDef[] {
    return [];
  }

  // ------------------------------------------------------------ fallback console commands (harness only)

  private registerFallbackCommands(): void {
    const add = (name: string, help: string, handler: (args: string[]) => void, flags = 0) => {
      if (!console_.hasCommand(name)) registerCommand({ name, help, handler, flags });
    };
    add('bind', 'bind <key> [command]', (args) => {
      if (!args.length) return conPrint('bind <key> [command] : attach a command to a key');
      const key = args[0].toLowerCase();
      if (args.length === 1) {
        const b = this.binds.get(key);
        conPrint(b !== undefined ? `"${key}" = "${b}"` : `"${key}" is not bound`);
        return;
      }
      this.binds.set(key, args.slice(1).join(' '));
    });
    add('unbind', 'unbind <key>', (args) => {
      if (args[0]) this.binds.delete(args[0].toLowerCase());
    });
    add('unbindall', 'Unbind all keys', () => this.binds.clear());
    add('binddefaults', 'Restore the default binds', () => {
      this.binds = new Map(Object.entries(DEFAULT_BINDS));
    });
    add('key_listboundkeys', 'List bound keys', () => {
      for (const [k, v] of this.binds) conPrint(`"${k}" = "${v}"`);
    });
    add('host_writeconfig', 'Save the configuration', () => saveArchivedCvars([...this.binds].map(([k, v]) => `bind "${k}" "${v}"`)));
    add('echo', 'Echo text to the console', (args) => conPrint(args.join(' ')));
    add('say', 'Chat', (args) => this.say(args.join(' ')));
    add('say_team', 'Team chat', (args) => this.say(args.join(' ')));
    add('map', 'map <name>', (args) => {
      if (args[0]) void this.loadCatalogMap(args[0]);
    });
    add('disconnect', 'Back to the main menu', () => this.disconnect());
    add('cvarlist', 'List console variables', () => {
      const all = console_.allCvars().sort((a, b) => a.name.localeCompare(b.name));
      for (const c of all) conPrint(`${c.name.padEnd(32)} : ${c.value.padEnd(10)} : ${c.flags & FCVAR_ARCHIVE ? 'a' : ' '} : ${c.help}`);
      conPrint(`--------------\n${all.length} convars`, 'info');
    });
    add('find', 'find <text>', (args) => {
      const q = (args[0] ?? '').toLowerCase();
      for (const c of console_.allCvars()) if (c.name.includes(q) || c.help.toLowerCase().includes(q)) conPrint(`"${c.name}" = "${c.value}" - ${c.help}`);
    });
    add('help', 'help <command>', (args) => {
      const c = args[0] ? console_.getCvar(args[0]) : undefined;
      if (c) conPrint(`"${c.name}" = "${c.value}" ( def. "${c.defaultValue}" )\n - ${c.help}`);
      else conPrint('Type cvarlist or find <text> to search console variables.', 'info');
    });
    add('noclip', 'Toggle noclip', () => {
      this.noclip = !this.noclip;
      conPrint(this.noclip ? 'noclip ON' : 'noclip OFF');
    });
    add('getpos', 'Print position', () => {
      const h = this.getHud();
      conPrint(`setpos ${h.origin.x.toFixed(6)} ${h.origin.y.toFixed(6)} ${h.origin.z.toFixed(6)};setang ${h.angles.pitch.toFixed(6)} ${h.angles.yaw.toFixed(6)} 0.000000`);
    });
    add('status', 'Server status', () => {
      conPrint(`hostname: SURF Local Server\nversion : 0.1.0\nmap     : ${this.mapName ?? '<none>'}\nplayers : 1 humans, 0 bots (1 max)`);
    });
  }
}
