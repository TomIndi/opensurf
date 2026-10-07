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
```
### bsp render + loader (bsp-render)
```ts
// bsp/geometry.ts
export function buildRenderBatches(bsp: BspFile, materials: Map<string, MaterialDef>, areas?: Int32Array):
  { batches: RenderBatch[]; lightmap: LightmapAtlas | null };
// bsp/loadmap.ts
export async function loadBspMap(name: string, data: ArrayBuffer, onProgress?: (p: LoadProgress) => void): Promise<LoadedMap>;
```
### renderer (renderer)
```ts
// render/renderer.ts
export class Renderer implements RendererApi { constructor(canvas: HTMLCanvasElement); }
```
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
// map/builtin/index.ts
export interface BuiltinMapInfo { id: string; name: string; description: string; tier: number; type: 'linear' | 'staged'; }
export const BUILTIN_MAPS: BuiltinMapInfo[];
export function buildBuiltinMap(id: string): LoadedMap;
```
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
```

## Game loop & tick order (game-core)

Fixed tick (`tickrate` cvar, default 100; presets 64 / 85.3 / 100 / 102.4 / 128). Each rendered frame:
mouse deltas update view angles immediately (rendered at full refresh rate); then run N ticks for the
elapsed time. Within a frame with several ticks, view angles are interpolated from the previous frame's
angles to the current ones across the ticks (smooth strafes at low fps). Render interpolates the origin
between the last two ticks.

Per tick:
1. Build `UserCmd` from +commands state (forward/side 450 like cl_forwardspeed/cl_sidespeed).
2. **Base velocity** (CBasePlayer::PhysicsSimulate semantics): if `FL_BASEVELOCITY` was NOT set by a trigger
   during the previous tick, convert: `velocity += baseVelocity * (1 + frametime*0.5)`, `baseVelocity = 0`.
   Then clear `FL_BASEVELOCITY`.
3. `playerMove(...)` with `frametime = tickInterval * laggedMovement`.
4. Touch triggers: overlap of the player hull AABB with trigger brushes (`boxIntersectsBrush`), fire
   StartTouch / Touch / EndTouch (trigger_push sets base velocity + FL_BASEVELOCITY each Touch).
5. Entity I/O queue (delayed outputs), logic_timer etc.
6. Timer zones (enter/leave start, stages, checkpoints, end).
7. Replay recording.

## Convars (registered by game-core in `src/game/convars.ts`; UI/renderer/audio read them by name)

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

Video: `mat_fullbright 0`, `r_drawzones 1`, `r_drawtriggers 0`, `r_drawclips 0`, `mat_wireframe 0`,
`r_brightness 1`, `r_renderscale 1`, `r_anisotropy 8`, `fog_enable 1`, `r_3dsky 1`.

Surf/HUD: `surf_hud_speed 1`, `surf_hud_timer 1`, `surf_showkeys 1`, `surf_ghost 1`, `surf_ghost_trail 1`,
`surf_prespeed 350`, `surf_speedometer_color 1`, `surf_chat_sounds 1`.

## Commands

Console (Source names): `map <name>`, `disconnect`, `retry`, `noclip`, `kill`, `setpos x y z`, `setang p y r`,
`getpos`, `bind <key> "<cmd>"`, `unbind`, `unbindall`, `binddefaults`, `alias`, `echo`, `clear`, `cvarlist`, `find`,
`help`, `toggle <cvar> [a b ...]`, `incrementvar`, `say`, `say_team`, `toggleconsole`, `messagemode`,
`messagemode2`, `quit`, `status`, `host_writeconfig`, `+forward/-forward` etc.

Chat (SourceMod/SurfTimer style, also accept `/cmd` silently): `!r` `!restart`, `!s` `!stage [n]`, `!b` `!bonus [n]`,
`!back`/`!stuck` (restart current stage), `!saveloc`/`!cp`, `!tele`/`!tp`, `!prac`/`!practice`, `!noclip`,
`!pb`, `!top`, `!mi`/`!tier`, `!replay`, `!ghost`, `!hide`, `!showkeys`, `!speed`, `!zones` (zone editor),
`!end` (practice), `!help`/`!commands`, `!fov <n>`, `!sens <n>`.

Default binds (CS:GO + surf conventions): `w +forward`, `s +back`, `a +moveleft`, `d +moveright`,
`space +jump`, `mwheeldown +jump`, `mwheelup +jump`, `ctrl +duck`, `shift +speed`, `e +use`, `tab +showscores`,
`` ` `` `toggleconsole`, `y messagemode`, `u messagemode2`, `r "say !r"`, `t "say !back"`, `mouse4 "say !saveloc"`,
`mouse5 "say !tele"`, `escape` menu, `f2 "say !prac"`.
Key names follow Source: `a`..`z`, `0`..`9`, `space`, `ctrl`, `shift`, `alt`, `tab`, `enter`, `escape`,
`backspace`, `uparrow`…, `f1`..`f12`, `mouse1`..`mouse5`, `mwheelup`, `mwheeldown`, `kp_*`, `semicolon`, `` ` ``.

## Data flow

```
Drive (.rar) ─► maps/downloader (unrar wasm, IndexedDB cache) ─► bsp/loadmap ─► LoadedMap ─► game ─► renderer
                                                                  ▲                                  ▲
                                       maps/zones (SurfTimer presets)          built-in maps ─────────┘
```
