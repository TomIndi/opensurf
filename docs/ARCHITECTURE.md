# SURF — architecture & module contracts

A browser remake of CS:GO surf servers. Goal: an OG CS:GO surfer opens it and it *instantly clicks* —
identical movement feel (Source gamemovement, CS:GO surf-server convars), the real classic maps
(KSF CS:S surf maps loaded from their BSP files), and the surf-timer experience (zones, stages,
checkpoints, PBs, !r, replays, chat commands, console, binds).

Stack: TypeScript (strict) + Vite + three.js. Tests: vitest (`npm test`). Typecheck: `npm run typecheck`.
Run: `npm run dev`.

## Ground rules for every contributor (human or agent)

1. **Clean-room.** Never copy code from Valve sources (leaked or SDK) or from GPL projects. Implement
   from your knowledge of the algorithms and the public file-format documentation. Do not fetch the
   leaked `cstrike15_src` repository. The physics must *behave* like CS:GO; the code must be ours.
2. **Coordinates.** Everything (physics, maps, renderer) uses Source coordinates: Z-up, units = inches.
   The three.js camera uses `camera.up = (0,0,1)`; no axis conversion anywhere.
3. **Own your files.** Only edit the files your task owns (see the ownership table). The shared
   contracts (`src/core/*`, `src/physics/types.ts`, `src/physics/playertypes.ts`, `src/bsp/types.ts`,
   `src/map/types.ts`, `src/game/api.ts`, `src/game/contracts.ts`) may only receive *additive, optional* changes when truly
   necessary; log each one in `docs/CONTRACT_CHANGES.md` (who, what, why). Never rename/remove.
4. **No git commits** — the coordinator commits.
5. **Tests.** Put unit tests in `tests/<module>.test.ts`. Real-map tests must read BSPs from the
   directory in env `SURF_TEST_MAPS` and `skip` when it is unset/missing (CI has no maps). Never commit
   `.bsp`/`.rar` files.
6. **Performance.** Maps have up to ~100k faces, ~20k brushes, 50–300 MB BSPs. Avoid per-tick allocation in
   physics; avoid O(n²) in loaders.
7. Before finishing: `npm run typecheck` must pass for your files and your tests must pass.

## Module ownership

| Area | Files | Owner task |
|---|---|---|
| core math/console | `src/core/{vec3,angles,cvars}.ts` | coordinator (done) |
| collision | `src/physics/collision.ts`, `src/physics/brushbuild.ts`, `tests/collision.test.ts` | collision |
| movement | `src/physics/movement.ts`, `tests/movement.test.ts` | movement |
| BSP core | `src/bsp/{reader,lzma,bz2,entities,bsptree,bspcollision}.ts`, `tests/bsp*.test.ts` | bsp-core |
| materials | `src/bsp/{pakfile,vtf,vmt,materials}.ts`, `tests/materials.test.ts` | materials |
| BSP render geometry + loader | `src/bsp/{geometry,lightmap,displacement,loadmap,props}.ts`, `tests/geometry.test.ts` | bsp-render |
| renderer | `src/render/**` | renderer |
| game core | `src/game/{game,convars,binds,input,commands,debugapi,hud}.ts`, `tests/gamecore*.test.ts` | game-core |
| game world | `src/game/{entities,timer,zoneresolve,replay,zoneeditor,records}.ts`, `tests/gameworld*.test.ts` | game-world |
| UI + audio | `src/ui/**`, `src/audio/**`, `src/styles/**`, `index.html` | ui |
| built-in maps | `src/map/builtin/**`, `tests/builtin.test.ts` | builtin-maps |
| map catalog/downloads | `src/maps/**`, `scripts/build-catalog.mjs`, `public/maps/**` | coordinator |
| bootstrap | `src/main.ts` | integration |

## Contracts (exact exported signatures)

Types live in the contract files; signatures below are what other modules will import.

### physics/collision.ts (collision)
```ts
export class CollisionWorld implements TraceWorld {
  constructor(brushes: Brush[]);                      // builds a BVH over brush AABBs
  readonly brushes: readonly Brush[];
  setModelSolid(model: number, solid: boolean): void; // func_brush Enable/Disable
  isModelSolid(model: number): boolean;
  traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number, out?: TraceResult): TraceResult;
  traceRay(start: Vec3, end: Vec3, mask: number, out?: TraceResult): TraceResult;
  pointContents(p: Vec3, mask?: number): number;
  testBox(origin: Vec3, mins: Vec3, maxs: Vec3, mask: number): boolean; // TestPlayerPosition
  queryBox(mins: Vec3, maxs: Vec3, cb: (b: Brush) => void): void;      // enabled brushes overlapping AABB
}
/** Exact absolute-AABB vs convex brush overlap (uses bevel planes). Used for trigger touching. */
export function boxIntersectsBrush(boxMins: Vec3, boxMaxs: Vec3, brush: Brush): boolean;
```
### physics/brushbuild.ts (collision)
```ts
export function brushFromPlanes(planes: Plane[], contents: number, model?: number): Brush | null; // adds bevels + AABB
export function brushFromPoints(points: Vec3[], contents: number, model?: number): Brush | null;  // convex hull
export function brushFromBox(mins: Vec3, maxs: Vec3, contents: number, model?: number): Brush;
export function addBrushBevels(brush: Brush): void;        // axial + edge bevels (q3map-style), idempotent
export function computeBrushBounds(brush: Brush): boolean; // AABB from windings; false if degenerate
export function brushWindings(brush: Brush): Vec3[][];     // windings[i] for sides[i]; [] for bevels/degenerate. CCW seen from outside
```
### physics/movement.ts (movement)
```ts
export function defaultMoveVars(): MoveVars;
export function playerMove(ps: PlayerState, cmd: UserCmd, world: TraceWorld, vars: MoveVars, frametime: number, ev: MoveEvents): void;
export function playerHull(ps: PlayerState): { mins: Vec3; maxs: Vec3 };
export function categorizePosition(ps: PlayerState, world: TraceWorld, vars: MoveVars): void; // after teleports
export function unstuckPlayer(ps: PlayerState, world: TraceWorld): boolean;  // nudge out of solid; false if impossible
```
### bsp core (bsp-core)
```ts
// bsp/reader.ts
export function parseBsp(buf: ArrayBuffer): BspFile;   // v19/v20/v21(+CS:GO LZMA lumps)
// bsp/lzma.ts
export function lzmaDecompress(props: Uint8Array, data: Uint8Array, outSize: number): Uint8Array;
export function decodeSourceLzma(buf: Uint8Array): Uint8Array; // Source "LZMA" header (lumps & pak entries)
// bsp/bz2.ts
export function bunzip2(data: Uint8Array): Uint8Array;         // for .bsp.bz2 (FastDL)
// bsp/entities.ts
export function parseEntities(text: string): MapEntity[];
// bsp/bsptree.ts
export function pointLeaf(bsp: BspFile, p: Vec3, headNode?: number): number;
export function modelBrushIndices(bsp: BspFile, model: number): number[];
export function faceAreas(bsp: BspFile): Int32Array;           // BSP area per face, -1 if unknown
// bsp/bspcollision.ts
export function buildBrushModels(bsp: BspFile): BrushModelInfo[];        // all models, Brush objects w/ bevels + AABBs
export function buildDisplacementBrushes(bsp: BspFile): Brush[];        // disp collision as thin tri prisms (model 0)
export function isSolidBrushEntity(ent: MapEntity): boolean;            // player-solid brush entities
```
### materials (materials)
```ts
// bsp/pakfile.ts
export class PakFile { constructor(zip: Uint8Array); list(): string[]; has(path: string): boolean; read(path: string): Uint8Array | null; } // case-insensitive, '\' → '/'
// bsp/vtf.ts
export function decodeVtf(data: Uint8Array, opts?: { maxSize?: number }): DecodedImage | null;
// bsp/vmt.ts
export type KeyValues = { [key: string]: string | KeyValues };
export function parseKeyValues(text: string): KeyValues;   // keys lower-cased
export interface VmtInfo { shader: string; params: Record<string, string>; proxies: KeyValues | null }
export function parseVmt(text: string, readFile?: (path: string) => string | null): VmtInfo; // resolves "patch"/include
// bsp/materials.ts
export function normalizeMaterialName(name: string): string;
export function buildMaterials(bsp: BspFile, pak: PakFile | null): Map<string, MaterialDef>; // one per texdata name
export function fallbackMaterial(name: string, reflectivity?: Vec3, width?: number, height?: number): MaterialDef;
export function loadSky(skyName: string, pak: PakFile | null): SkyDef;
// Stock content from linked game files: fetches what buildMaterials/loadSky will read (VMTs, patch includes,
// base/blend/detail textures, envmap masks, sky faces) that the pakfile lacks; pass [mapFileSource(result)] as
// opts.extraSources (searched after the pakfile).
export async function prefetchMaterialFiles(bsp: BspFile, pak: PakFile | null, content: AsyncMaterialFileSource, opts?: PrefetchOptions | string): Promise<Map<string, Uint8Array>>;
```
Procedural stand-ins (stock textures nobody linked): fine grain plus a subtle family pattern (formwork panels and
tie holes on concrete walls, slabs on floors, ceiling tiles, planks, bricks...) whose average colour is the texdata
reflectivity. No large low-frequency blotches: tiled over big surf walls those read as fog or dirt.
### bsp render + loader (bsp-render)
Model entities (prop_dynamic, prop_physics…) are drawn the way the engine poses them: single-bone models in the
first frame of their starting sequence (`DefaultAnim`, else sequence 0; e.g. an "idle" that turns the root 90°), folded
into `RenderProp.origin/angles`. Static props keep the bind pose.
```ts
// bsp/geometry.ts
export function buildRenderBatches(bsp: BspFile, materials: Map<string, MaterialDef>, areas?: Int32Array):
  { batches: RenderBatch[]; lightmap: LightmapAtlas | null };
// bsp/loadmap.ts
export async function loadBspMap(name: string, data: ArrayBuffer, onProgress?: (p: LoadProgress) => void, opts?: LoadBspOptions): Promise<LoadedMap>;
```
Textures are searched in order: the map's pakfile, `opts.materials.extraSources`, the linked game content
(`opts.gameContent`, default: `gameContentForLoad()` from `maps/gamecontent.ts`; `null` = none), then procedural
stand-ins. With game content the textures phase first reports `{ phase: 'textures', message: 'Reading game textures… n/m',
loaded: n, total: m }` while it reads the files from the player's VPKs.
### renderer (renderer)
```ts
// render/renderer.ts
export class Renderer implements RendererApi { constructor(canvas: HTMLCanvasElement); }
// optional RendererApi members (game/api.ts), implemented by Renderer:
setFog?(fog: FogDef | null): void;              // runtime world fog (SetFogController); null = the map's own fog
capabilities?(): RendererCapabilities;          // { compressedTextures (S3TC), maxTextureSize }
```
The game asks `capabilities()` before loading a BSP and passes `loadBspMap(..., { materials: { compressedTextures: true } })`
when S3TC is available (the VTFs' DXT mip chains are uploaded as-is: full resolution, 4-8x less memory). Brush faces
are wound toward their front (`dface_t.side == planenum & 1`, the loader never flips them), so BSP surfaces are drawn
single-sided like the engine; the renderer's face audit (`debugInfo().faces`) falls back to double-sided drawing only
if a map's audited face area is mostly inverted.
### game (game-core; world systems per `src/game/contracts.ts`: `EntitySystem implements IEntitySystem` in entities.ts `constructor(host: WorldHost)`, `SurfTimer implements ISurfTimer` in timer.ts `constructor(host: TimerHost)`, `ReplaySystem implements IReplaySystem` in replay.ts `constructor(mapName: string)` — game-world)
```ts
// game/game.ts
export class Game implements GameApi {
  constructor(deps: { renderer: RendererApi; ui: UiApi; sound: SoundApi; canvas: HTMLCanvasElement });
  start(): void;  // begins the requestAnimationFrame loop
}
```
### UI + audio (ui)
```ts
// ui/ui.ts
export class Ui implements UiApi { constructor(root: HTMLElement, sound: SoundApi); attachGame(game: GameApi): void; }
// audio/audio.ts
export class SoundSystem implements SoundApi { constructor(); }
```
### built-in maps (builtin-maps)
```ts
// map/builtin/index.ts (re-exports the list)
export interface BuiltinMapInfo { id: string; name: string; description: string; tier: number; type: 'linear' | 'staged'; }
export const BUILTIN_MAPS: BuiltinMapInfo[];
export function buildBuiltinMap(id: string): LoadedMap;
```
The metadata lives in `map/builtin/list.ts` (no geometry code): the UI and the game import the list statically, the
builders (`index.ts`) are only loaded on demand through the game's dynamic `import()`, so they stay a separate chunk.
### map catalog (coordinator)
```ts
// maps/catalog.ts
export interface CatalogEntry { name: string; driveId: string; tier: number | null; type: 'linear' | 'staged' | 'staged-linear' | null; hasZones: boolean; featured: boolean; }
export async function loadCatalog(): Promise<CatalogEntry[]>;
export function getCatalogEntry(name: string): CatalogEntry | undefined;   // after loadCatalog()
// maps/downloader.ts
export async function fetchCatalogMap(entry: CatalogEntry, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<{ name: string; bsp: ArrayBuffer }>;
export async function extractMapArchive(data: ArrayBuffer, fileName: string): Promise<{ name: string; bsp: ArrayBuffer }>; // .bsp/.bz2/.rar/.zip
export async function listCachedMaps(): Promise<string[]>;
export async function deleteCachedMap(name: string): Promise<void>;
// maps/zones.ts
export async function getPresetZones(mapName: string): Promise<ZoneDef[] | null>;  // SurfTimer zone presets
export function loadUserZones(mapName: string): ZoneDef[] | null;
export function saveUserZones(mapName: string, zones: ZoneDef[] | null): void;
// maps/vpk.ts — VPK v1/v2 reader (lazy: only the _dir tree is read up front)
export class VpkArchive { static open(name, dirFile: BlobLike, getArchive: (i: number) => BlobLike | null): Promise<VpkArchive>; has(p): boolean; read(p): Promise<Uint8Array | null>; }
export class GameContent { archives: VpkArchive[]; label: string; archiveNames: string[]; fileCount: number; has(p): boolean; read(p): Promise<Uint8Array | null>; }
export async function openGameContentFromFiles(files: Map<string, BlobLike>, opts?: { label?: string; notes?: string[] }): Promise<GameContent | null>;
```
### Linked game content: "use textures from my CS:S / CS:GO install" (`maps/gamecontent.ts`)
KSF maps reference stock CS:S/HL2 materials (`CONCRETE/CONCRETEWALL011`, `wood/woodshingles002a`...) that aren't packed
in the BSP and can't be redistributed. A player who owns the game links their install once; its VPKs are then read
straight from their disk (nothing is uploaded or copied). Module singleton for the UI (Settings) and the loader:
```ts
type GameContentState = 'none' | 'linked' | 'needs-permission' | 'error';
interface GameContentStatus {
  state: GameContentState;
  label?: string;       // the linked folder's name, e.g. "Counter-Strike Source"
  archives?: string[];  // in priority order: "csgo/pak01", "cstrike/cstrike_pak", "hl2/hl2_textures", "hl2/hl2_misc"
  files?: number;       // files indexed in those archives
  message?: string;     // error text; advice when partial ("cstrike" picked without "hl2"); what to click for needs-permission
  source?: 'folder' | 'files';
}
isGameFolderPickerSupported(): boolean;          // window.showDirectoryPicker exists (Chromium)
pickGameContentFolder(): Promise<GameContentStatus>;   // call from a click: opens the picker, links (cancel = no change)
linkGameContentFromDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<GameContentStatus>; // remembered (IndexedDB)
linkGameContentFromFiles(files: FileList | File[]): Promise<GameContentStatus>;  // <input type=file webkitdirectory> fallback; this visit only
restoreGameContent(): Promise<GameContentStatus>;      // at startup: reopen the remembered folder
requestGameContentPermission(): Promise<GameContentStatus>; // call from a click when state is 'needs-permission'
unlinkGameContent(): Promise<void>;
getGameContent(): GameContent | null;
getGameContentStatus(): GameContentStatus;
onGameContentChange(cb: (s: GameContentStatus) => void): () => void;  // returns unsubscribe
gameContentForLoad(): Promise<GameContent | null>;     // the loader's default: waits for a link in progress, restores once
```
The player may pick the game root ("Counter-Strike Source"), "cstrike", "steamapps/common" or a Steam library: the walk
lists only the picked folder and known directories (cstrike, hl2, csgo, common, steamapps, the CS/HL2 game folders) and
opens the numbered `_NNN.vpk` archives only when a file inside them is read. A link that finds nothing (or only
Counter-Strike 2's Source 2 VPKs) is state 'error' with a message. Browsers usually want a click before reading a
remembered folder again: `restoreGameContent()` then resolves to 'needs-permission' and the UI shows a button that
calls `requestGameContentPermission()`. Maps load with stand-ins until content is linked; the next map load uses it.

## Game loop & tick order (game-core)

Fixed tick (`tickrate` cvar, default 100; presets 64 / 85.3 / 100 / 102.4 / 128). Each rendered frame:
mouse deltas update view angles immediately (rendered at full refresh rate); then run N ticks for the
elapsed time (× `host_timescale`, at most 10 per frame). Per-tick view angles are timestamped: tick i of the N
ticks of a frame samples the view interpolated from the frame's starting angles to its final angles at that tick's
own simulated time within the frame (`InputState.tickAngles` / `tickFraction`), so a steady mouse turn gives the same
angle change on every tick at any fps — no 1x/2x alternation when fps and tickrate differ, smooth strafes at low fps.
Render interpolates the origin between the last two ticks. The simulation clock (`WorldHost.time`) and the timer's
run/stage clocks accumulate the interval of each simulated tick, so a tickrate change never rescales time already
simulated.

Pause (ESC, `cancelselect`, losing the pointer lock, hiding the tab): freezes the world — physics, map logic,
movers, timer — until resume, and the run carries on and still counts (the run clock counts simulated ticks). A frame
gap only loses that time (dt is capped); a map change that failed and returned to the map turns a ranked run into
practice ("Timer stopped — run paused, it won't count"). Time the game didn't simulate is
never caught up. `map <name>` validates the name first (an unknown one is only `map load failed: <name> not found`
in the console); during a map change the current session is kept aside and comes back if the download/parse
fails (`LoadProgress.recovered`).

Per tick:
1. Build `UserCmd` from +commands state (forward/side 450 like cl_forwardspeed/cl_sidespeed).
2. **Base velocity** (CBasePlayer::PhysicsSimulate semantics): if `FL_BASEVELOCITY` was NOT set by a trigger
   during the previous tick, convert: `velocity += baseVelocity * (1 + frametime*0.5)`, `baseVelocity = 0`.
   Then clear `FL_BASEVELOCITY`.
3. `playerMove(ps, cmd, world, vars, tickInterval, ev)` — pass the RAW tick interval: playerMove multiplies by
   `ps.laggedMovement` internally (player_speedmod). playerMove also runs CheckStuck itself. After any teleport call
   `categorizePosition` (+ `unstuckPlayer`). `movementOptions.rampbugFix` (default on) can be exposed as `sv_rampbugfix`.
4. Touch triggers: overlap of the player hull AABB with trigger brushes (`boxIntersectsBrush`), fire
   StartTouch / Touch / EndTouch (trigger_push sets base velocity + FL_BASEVELOCITY each Touch).
5. Entity I/O queue (delayed outputs), logic_timer etc.
6. Timer zones (enter/leave start, stages, checkpoints, end).
7. Replay recording.

## Convars (registered by game-core in `src/game/convars.ts`; UI/renderer/audio read them by name)

`src/game/convars.ts` (`CVAR_DEFS`) is the single definition of every documented cvar (name, default, flags,
limits, help). `registerConvars()` is idempotent; the UI calls it from its constructor (`ui/cvardefs.ts`
re-exports the definitions for the settings screens), so every cvar exists before the UI first reads one and
before the saved config is executed.

Values match SurfTimer's shipped CS:GO `cfg/sourcemod/surftimer/main.cfg` (stamina disabled, `ck_auto_bhop 1`).

Physics (FCVAR_REPLICATED — non-default values put the run in an unranked "custom physics" style):
`sv_gravity 800`, `sv_accelerate 10`, `sv_airaccelerate 150`, `sv_friction 5.2`, `sv_stopspeed 80`,
`sv_maxspeed 350` (player still capped by knife speed 250), `sv_maxvelocity 3500`, `sv_air_max_wishspeed 30`,
`sv_jump_impulse 301.993377`, `sv_stepsize 18`, `sv_bounce 0`, `sv_autobunnyhopping 1`,
`sv_enablebunnyhopping 1`, `sv_wateraccelerate 10`, `sv_waterfriction 1`, `sv_noclipspeed 5`,
`sv_noclipaccelerate 5`, `sv_cheats 0`, `tickrate 100`.

Client: `sensitivity 2.5`, `m_yaw 0.022`, `m_pitch 0.022`, `m_rawinput 1`, `m_customaccel 0`, `zoom_sensitivity_ratio_mouse 1`,
`cl_forwardspeed 450`, `cl_sidespeed 450`, `cl_upspeed 320`, `fov_desired 90` (horizontal degrees at 4:3, CS:GO style),
`cl_showpos 0`, `cl_showfps 0`, `net_graph 0`, `cl_drawhud 1`, `hud_scaling 0.85`, `cl_hud_color 0`,
`cl_righthand 1`, `volume 0.5`, `snd_mute_losefocus 1`, `fps_max 0`.

Crosshair (CS:GO names/semantics): `crosshair 1`, `cl_crosshairstyle 4`, `cl_crosshairsize 5`,
`cl_crosshairthickness 0.5`, `cl_crosshairgap 1`, `cl_crosshairdot 0`, `cl_crosshair_drawoutline 1`,
`cl_crosshair_outlinethickness 1`, `cl_crosshaircolor 1` (0 red, 1 green, 2 yellow, 3 blue, 4 cyan, 5 custom),
`cl_crosshaircolor_r 50`, `cl_crosshaircolor_g 250`, `cl_crosshaircolor_b 50`, `cl_crosshairalpha 200`, `cl_crosshairusealpha 1`.

Video: `mat_fullbright 0`, `r_drawzones 1` (0 off, 1 floor outline, 2 full box → `RenderSettings.drawZones` /
`zoneStyle`), `r_drawtriggers 0`, `r_drawclips 0`, `mat_wireframe 0`,
`r_brightness 1`, `r_renderscale 1`, `r_anisotropy 8`, `fog_enable 1`, `r_3dsky 1`.

Surf/HUD: `surf_hud_speed 1`, `surf_hud_timer 1`, `surf_showkeys 1`, `surf_ghost 1`, `surf_ghost_trail 1`,
`surf_prespeed 350`, `surf_speedometer_color 1`, `surf_chat_sounds 1`.

Autoexec compatibility (`COMPAT_CVAR_DEFS`, hidden, archived where CS:GO archives them, no effect): `viewmodel_*`,
`cl_bob*`, `r_drawviewmodel`, `cl_draw_only_deathnotices`, `cl_radar_*`, `cl_hud_*` extras, `cl_teamid_overhead_*`,
netcode (`rate`, `cl_updaterate`, `cl_cmdrate`, `cl_interp*`), `snd_*`, `voice_*`, `joystick`, `mat_queue_mode`,
`mat_monitorgamma`, `fps_max_menu`, `net_graph*` ...; no-op commands such as `snd_setmixer`, `buy`, `slot1`.

## Commands

Console (Source names): `map <name>`, `disconnect`, `retry`, `noclip`, `kill`, `setpos x y z`, `setang p y r`,
`getpos`, `bind <key> "<cmd>"`, `unbind`, `unbindall`, `binddefaults`, `alias`, `echo`, `clear`, `cvarlist`, `find`,
`help`, `toggle <cvar> [a b ...]`, `incrementvar`, `say`, `say_team`, `toggleconsole`, `messagemode`,
`messagemode2`, `quit`, `status`, `host_writeconfig`, `+forward/-forward` etc. `exec <name>` runs a stored cfg
(localStorage `surf.cfg.<name>`, written by `cfg_save <name> "<cmds>"` or the settings' .cfg import; `cfg_list`,
`cfg_delete`); `autoexec` runs at startup after the saved config (`src/game/cfgstore.ts`).

Chat (SourceMod/SurfTimer style, also accept `/cmd` silently): `!r` `!restart`, `!s` `!stage [n]`, `!b` `!bonus [n]`,
`!back`/`!stuck` (restart current stage), `!saveloc`/`!cp`, `!tele`/`!tp`, `!prac`/`!practice`, `!noclip`,
`!pb`, `!top`, `!rank`/`!mrank`/`!prank` (Rank 1/1, PB, completions), `!stages`/`!wrcp`/`!cpr`/`!srcp`/`!stagetop`
(stage records), `!mi`/`!tier`, `!replay`, `!ghost`, `!hide`, `!showkeys`, `!speed`, `!zones` (zone editor),
`!end` (practice), `!help`/`!commands`, `!fov <n>`, `!sens <n>`. Unknown commands get a "Did you mean" only for a
near miss. Reaching stage N+1 prints the completed stage's own time vs its stage best ("Player finished Stage 2 in
00:12.345 (PB -0.123)", also the HUD split flash) before the run split; the end zone completes the last stage.

Default binds (CS:GO + surf conventions): `w +forward`, `s +back`, `a +moveleft`, `d +moveright`,
`space +jump`, `mwheeldown +jump`, `mwheelup +jump`, `ctrl +duck`, `shift +speed`, `e +use`, `tab +showscores`,
`` ` `` `toggleconsole`, `y messagemode`, `u messagemode2`, `r "say !r"`, `t "say !back"`, `mouse4 "say !saveloc"`,
`mouse5 "say !tele"`, `escape` menu, `f2 "say !prac"`.
Key names follow Source: `a`..`z`, `0`..`9`, `space`, `ctrl`, `shift`, `alt`, `tab`, `enter`, `escape`,
`backspace`, `uparrow`…, `f1`..`f12`, `mouse1`..`mouse5`, `mwheelup`, `mwheeldown`, `kp_*`, `semicolon`, `` ` ``.

## Collision notes

Box traces follow Source's brush clipping rules (DIST_EPSILON pull-back, startsolid/allsolid, bevel planes). The
enter fraction starts at a "never updated" sentinel (-9999, as in Source; Quake 3 used -1): a box that starts within
DIST_EPSILON of a face and moves into it is stopped at fraction 0 however small the move. With -1, moves shorter than
`DIST_EPSILON - gap` passed unchecked and a player sliding along a slightly slanted wall could creep into it.
Displacements collide as two-sided triangles (see `docs/CONTRACT_CHANGES.md`).

## Automation & debugging

URL parameters (parsed by `game/debugapi.ts`):

| parameter | effect |
|---|---|
| `?map=<name>` | load a built-in map or a catalog map at startup (like the `map` command) |
| `?builtin=<id>` | load a built-in map (`surf_tutorial`, `surf_neon`, `surf_skyline`) |
| `?bsp=<url>` | download and play a `.bsp` / `.bsp.bz2` / `.rar` / `.zip` from a URL (dev: `/__maps/<name>.bsp`) |
| `?autotest=1` | automated sessions: no pointer lock needed (mouse buttons/wheel work without it), never pause on focus or pointer-lock loss, no "click to capture" hint, a hidden tab or a slow frame never turns a run into practice |

`vite.config.ts` serves `$SURF_TEST_MAPS` / `$SURF_TEST_MAPS_LARGE` at `/__maps/<file>` in dev and preview.

`window.__surf` (`SurfDebugApi`, installed by `Game.start()`): `state()` (plain snapshot: game state, map, origin,
velocity, speed, ground, timer HUD, tick, practice), `loadBuiltin(id)`, `loadUrl(url)`, `loadMap(name)` (resolve once
playing or failed), `setAngles(pitch, yaw)`, `teleport(x, y, z)` (zero velocity), `setVelocity(x, y, z)`,
`press(cmd)` / `release(cmd)` / `releaseAll()` (+commands as from the console), `runTicks(n)` (simulate n ticks now
with the current input — pause first for deterministic stepping), `exec(line)` (returns the console output),
`say(text)`, `pause()` (a hard freeze, also mid-run, unlike the pause menu), `resume()`, `inSolid()`, `zones()`, `triggers()`, `findRamps(max)` (largest surfable world
ramp faces) and `renderInfo()` (renderer diagnostics: face audit, S3TC, GPU resources), plus `game` itself.

`npm run e2e` (`scripts/e2e.mjs`) starts the Vite dev server on a free port, opens the game in headless Chromium
(SwiftShader WebGL) and runs: (a) menu + map browser (932 catalog maps, search, built-in tab); (b) every built-in map:
spawn in the start zone, keyboard movement, leaving the start starts the timer, the fail trigger teleports back,
`!r`; (c) every map in `$SURF_TEST_MAPS` via `?bsp=`: load time, start-zone placement, not in solid, face audit,
screenshots at the spawn and ramp viewpoints, fps; (d) deterministic surf runs on the maps' biggest ramps (speed
builds, never stuck or in solid); (e) chat/console (messagemode, `!help`, silent `/r`, cvars, `getpos`, a rebound
`toggleconsole` key, scoreboard, pause); (f) map switching without page errors or JS-heap / GPU-resource growth;
(g) complete runs of every built-in map through the real input pipeline, steered by the map's autopilot
(`src/map/builtin/autopilot.ts` pressing +commands and setting view angles each tick): the timer finishes, the PB is
saved, `!replay` spectates the replay and the PB ghost shows on the next attempt; (h, opt-in `E2E_DOWNLOAD=1`, needs
the network) the catalog download path: `?map=surf_kitsune` fetched through the local server's Drive proxy
(`/__drive/<id>`, answered through Playwright routing by the real file fetched in Node; the page must never ask Drive
directly, which refuses cross-site downloads from pages) so the streamed download, unrar wasm and IndexedDB cache run
for real; behind an HTTPS proxy run with
`NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS`; `E2E_DOWNLOAD_ARCHIVE` names a local copy served when Node can't reach
Drive, always with `E2E_DOWNLOAD_OFFLINE=1`): the map plays, and a
reload loads it "from cache" without touching Drive. `E2E_PORT` pins the dev server port.
Any uncaught page error fails the run. Env: `SURF_TEST_MAPS`, `SURF_TEST_MAPS_LARGE` (+`E2E_LARGE=1`),
`CHROMIUM_PATH`, `E2E_OUT` (screenshots + `<prefix>results.json`), `E2E_PREFIX`, `E2E_ONLY=a,c`, `E2E_MAPS=...`.
SwiftShader renders a few fps at 1280x720, so real-time checks poll instead of assuming frame rates; scenario (c)
also reports the main-thread cost of the game's own frames (what limits fps on a real GPU). Each scenario (and each
real map) gets a fresh browser, and the dev server uses a private Vite dependency cache, so a dev server already
running on the tree (or the browser tests in `npm test`, which do the same) can't re-optimize dependencies under it.

## Data flow

```
Drive (.rar) ─► dev/preview server /__drive/<id> (vite.config.ts) ─► maps/downloader (unrar wasm, IndexedDB cache) ─► bsp/loadmap ─► LoadedMap ─► game ─► renderer
                                                                   ▲   ▲                               ▲
                                   maps/zones (SurfTimer presets) ─┘   │           built-in maps ──────┘
      player's CS:S / CS:GO VPKs ─► maps/gamecontent (stock textures) ─┘
```
