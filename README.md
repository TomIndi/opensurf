# SURF

A browser remake of CS:GO surf servers. Source/CS:GO movement physics re-implemented from scratch,
the real classic KSF surf maps loaded straight from their BSP files, and a SurfTimer-style timer,
HUD, chat commands, console and binds — so it feels like joining your old surf server.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
```

Play through `npm run dev` or `npm run build && npm run preview`: the local server also downloads the catalog
maps for the game (Google Drive refuses downloads requested straight from a web page). The static site in `dist/`
(a GitHub Pages workflow is included — enable Pages with "GitHub Actions" as the source) plays the built-in maps
and any map file you drop on it, but can't download catalog maps by itself.

### Maps

* **All ~930 KSF surf maps** (surf_utopia, surf_kitsune, surf_mesa, surf_beginner, …) are listed in the
  map browser with their KSF tier. Picking one downloads the original archive on demand from the public
  KSF map archive linked from [OuiSURF/Surf_Maps](https://github.com/OuiSURF/Surf_Maps) (through the local
  dev / preview server), extracts the `.bsp` in the browser and caches it locally (IndexedDB) — nothing is
  re-hosted.
* Drop your own `.bsp`, `.bsp.bz2`, `.rar` or `.zip` onto the menu to play any Source surf map.
* Built-in original maps load instantly (no download) — good for a first run.

Textures packed inside a map are used as-is. Stock CS:S/CS:GO textures are not distributed with the
game, so surfaces that use them get a generated texture with the right average color, lit by the map's
own baked lightmaps.

### KSF world records

On catalog maps the game shows the KSF world record from [ksf.surf](https://ksf.surf) (fetched on demand through the
local dev / preview server, never re-hosted): in the HUD side panel, the pause menu, a chat line when the map loads,
your finish line ("+1.234 vs KSF WR") and the map browser. `!wr` lists the WR and the top 5, `!wrreplay` (or
`!replay wr`) downloads the record's replay and lets you watch the real WR run on your copy of the map, and
`!wrghost` races it as a ghost. 100 tick (the default) reads KSF's 100 tick board, other tickrates the 66 tick one.
The map browser also links each map's record videos on YouTube (@ksfrecords). World records need `npm run dev` /
`npm run preview`; the static site works without them.

### Timer zones

Start/end/stage/checkpoint/bonus zones come from SurfTimer's public zone database (GPL-3.0, see
`public/maps/ZONES_LICENSE.md`) for ~450 maps, from Momentum Mod timer entities when a map has them, or
from your own zones (`!zones` / `zone_*` console commands).

## Controls (CS:GO defaults)

| | |
|---|---|
| WASD | move / strafe |
| Space, mouse wheel | jump (`sv_autobunnyhopping 1`) |
| Ctrl / Shift | duck / walk |
| R | `!r` restart |
| T | `!back` restart stage |
| Mouse4 / Mouse5 | `!saveloc` / `!tele` (practice) |
| Y / U | chat |
| `` ` `` | developer console |
| Tab | scoreboard |

Sensitivity uses CS:GO units (`sensitivity`, `m_yaw 0.022`), so your CS:GO sensitivity carries over.
`bind`, `alias`, `cl_crosshair*` and most familiar console commands work.

Chat commands: `!r`, `!s <n>`, `!b <n>`, `!back`, `!saveloc`, `!tele`, `!prac`, `!noclip`, `!pb`, `!top`,
`!replay`, `!ghost`, `!wr`, `!wrreplay`, `!wrghost`, `!hide`, `!showkeys`, `!zones`, `!help`.

ESC pauses the game (the world and the timer freeze; the run still counts when you resume).

## Physics

Movement follows Source's `CGameMovement` as configured on CS:GO surf servers (SurfTimer's `main.cfg`):
`sv_airaccelerate 150`, `sv_accelerate 10`, `sv_friction 5.2`, `sv_gravity 800`, `sv_maxvelocity 3500`,
30 u/s air wishspeed cap, knife speed 250, stamina disabled, autobhop on, tickrate 100 (64 / 85.3 / 102.4 /
128 selectable). Collision is box-vs-brush tracing against the map's own brushes, like the engine. The
code is an original implementation written from the publicly documented algorithms; no Valve source code
is used.

## Development

* `npm test` — unit tests (set `SURF_TEST_MAPS=/path/to/bsps` to also run the real-map tests)
* `npm run typecheck`
* `npm run e2e` — end-to-end run of the real game in headless Chromium (playwright-core): menu and map browser,
  every built-in map (spawn, movement, timer start, fail teleport, `!r`), chat and console, and — with
  `SURF_TEST_MAPS` set — every real map in that folder (load time, start-zone placement, screenshots, fps),
  deterministic surf runs on their ramps and map switching without errors or memory growth. Screenshots and a
  `results.json` go to `$E2E_OUT` (default: a temp folder). Uses `/opt/pw-browsers/chromium-*` or `CHROMIUM_PATH`.
* `npm run catalog` — regenerate `public/maps/catalog.json` / `zones.json`
* `docs/ARCHITECTURE.md` — module layout, contracts, the `window.__surf` debug API and the e2e scenarios

### URL parameters

| | |
|---|---|
| `?map=surf_kitsune` | load a map at startup (built-in id or catalog name) |
| `?builtin=surf_tutorial` | load a built-in map |
| `?bsp=<url>` | play a `.bsp` / `.bsp.bz2` / `.rar` / `.zip` from a URL; in dev, files from `$SURF_TEST_MAPS` are served at `/__maps/<name>.bsp` |
| `?autotest=1` | automation: no pointer lock required, never auto-pauses |

`window.__surf` exposes a small scripting API (state snapshot, map loading, teleport, +commands, `runTicks`,
console `exec`, chat `say`) for tests and debugging — see `docs/ARCHITECTURE.md`.
