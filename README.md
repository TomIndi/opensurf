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
maps for the game (Google Drive refuses downloads requested straight from a web page) and reads KSF world records
(ksf.surf sends no CORS headers). The static site in `dist/` plays the built-in maps and any map file you drop on it;
to download catalog maps and show world records it needs the **SURF relay** below.

### Playing on GitHub Pages

`.github/workflows/deploy.yml` builds and deploys the site on every push to `main` (Settings → Pages → Source:
"GitHub Actions"; the site is served from `https://<user>.github.io/<repo>/`). For a fully playable site:

1. Deploy the relay (a free Cloudflare Worker in `worker/`, see [`worker/README.md`](worker/README.md)): either
   `cd worker && npm install && npx wrangler login && npx wrangler deploy`, or add the repository secrets
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and let `.github/workflows/relay.yml` deploy it (on pushes to
   `main` touching `worker/**`, or by hand from the Actions tab). It prints its URL,
   `https://opensurf-relay.<your-subdomain>.workers.dev`.
2. Point the build at it: this repository's `deploy.yml` uses `https://opensurf-relay.tomasindi360.workers.dev` by
   default; the repository **variable** `SURF_RELAY_URL` (Settings → Secrets and variables → Actions → Variables)
   overrides it (e.g. in a fork). Re-run the Pages deployment: the build bakes it in as `VITE_SURF_RELAY`.
3. A fork served from another origin adds it to the relay's `ALLOWED_ORIGINS` (`worker/wrangler.toml`, or the
   repository variable `SURF_RELAY_ALLOWED_ORIGINS` for `relay.yml`).

The relay only answers the game's own three routes (a validated Drive file id, a KSF map name or replay file),
streams the files through without storing anything but Cloudflare's edge cache, and only to the allowed origins.
`?relay=<url>` tries another relay for one page load, `?relay=off` disables it. Locally, `npm run dev` /
`npm run preview` keep using their own built-in proxy (the relay is only asked when the page's server has none).

### Maps

* **All ~930 KSF surf maps** (surf_utopia, surf_kitsune, surf_mesa, surf_beginner, …) are listed in the
  map browser with their KSF tier. Picking one downloads the original archive on demand from the public
  KSF map archive linked from [OuiSURF/Surf_Maps](https://github.com/OuiSURF/Surf_Maps) (through the local
  dev / preview server or the SURF relay), extracts the `.bsp` in the browser and caches it locally (IndexedDB) — nothing is
  re-hosted.
* Drop your own `.bsp`, `.bsp.bz2`, `.rar` or `.zip` onto the menu to play any Source surf map.
* Built-in original maps load instantly (no download) — good for a first run.

Textures packed inside a map are used as-is. Stock CS:S/CS:GO textures are not distributed with the
game, so surfaces that use them get a generated texture with the right average color, lit by the map's
own baked lightmaps.

### KSF world records

On catalog maps the game shows the KSF world record from [ksf.surf](https://ksf.surf) (fetched on demand through the
local dev / preview server or the SURF relay, never re-hosted): in the HUD side panel, the pause menu, a chat line when the map loads,
your finish line ("+1.234 vs KSF WR") and the map browser. `!wr` lists the WR and the top 5, `!wrreplay` (or
`!replay wr`) downloads the record's replay and lets you watch the real WR run on your copy of the map (type it again
to cancel while it downloads; a run you start meanwhile isn't interrupted), and `!wrghost` races it as a ghost. 100 tick (the default) reads KSF's 100 tick board, other tickrates the 66 tick one.
The map browser also links each map's record videos on YouTube (@ksfrecords). World records need `npm run dev` /
`npm run preview` or a static build with the SURF relay; without them the game just shows no WR.

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
| G | `!undo` undo an accidental restart (back to your run) |
| Mouse4 / Mouse5 | `!saveloc` / `!tele` (practice) |
| Y / U | chat |
| `` ` `` | developer console |
| Tab | scoreboard |

Sensitivity uses CS:GO units (`sensitivity`, `m_yaw 0.022`), so your CS:GO sensitivity carries over.
`bind`, `alias`, `cl_crosshair*` and most familiar console commands work.

Chat commands: `!r`, `!undo`, `!s <n>`, `!b <n>`, `!back`, `!saveloc`, `!tele`, `!prac`, `!noclip`, `!pb`, `!top`,
`!replay`, `!ghost`, `!wr`, `!wrreplay`, `!wrghost`, `!hide`, `!showkeys`, `!zones`, `!help`.

Hit R when you meant T? Press G (`!undo`, console `surf_undo`): you are back exactly where you were — position,
speed, view, stage, splits and the run clock, which stops while you're restarted. The map doesn't stop, though, so a
ranked run stays ranked (replay and all) only if you undo within 5 seconds (in total for the run) and don't noclip,
`!tele`, `!end` or otherwise practice in between; otherwise it comes back as practice. It works until you start a
new run.

ESC pauses the game (the world and the timer freeze; the run still counts when you resume).

## Physics

Movement follows Source's `CGameMovement` as configured on CS:GO surf servers (SurfTimer's `main.cfg`):
`sv_airaccelerate 150`, `sv_accelerate 10`, `sv_friction 5.2`, `sv_gravity 800`, `sv_maxvelocity 3500`,
30 u/s air wishspeed cap, knife speed 250, stamina disabled, autobhop on, tickrate 100 (64 / 85.3 / 102.4 /
128 selectable). Collision is box-vs-brush tracing against the map's own brushes, like the engine. The
code is an original implementation written from the publicly documented algorithms; no Valve source code
is used.

## Frame rate

The game runs at your monitor's refresh rate when the PC keeps up: a browser shows at most one frame per refresh,
so `fps_max 0` (Settings → Video → FPS limit: "Monitor refresh rate") means 60 fps on a 60 Hz screen and 144 on a
144 Hz one. `cl_showfps 1` shows the frame rate. When it stays below the refresh rate, the graphics card is usually
the limit. Settings → Video:

* **Graphics** shows the GPU the browser renders with, and a hint when that alone explains a low frame rate: the
  browser is drawing in software (hardware acceleration off), or running on integrated graphics on a PC that may
  have a dedicated card (Windows → Settings → System → Display → Graphics → the browser → *High performance*).
* **Anti-aliasing** (`mat_antialias`: 0 off, 2, 4 (default), 8; MSAA like CS:GO's multisampling, applied live,
  limited to what the GPU supports). Each step costs GPU time, most at high resolutions and on integrated graphics.
* **Render scale** (`r_renderscale` 0.25–1): the 3D view's resolution relative to the screen's (high-DPI and 4K
  screens render at their full native resolution otherwise).
* **Texture filtering** (`r_anisotropy`) and **3D skybox** (`r_3dsky`) cost a little GPU time too.

What the renderer does to keep frames cheap, like the Source engine: it draws only the parts of the map the BSP's
visibility data says can be seen from where you are (`r_novis 1` draws everything, for debugging), draws an expensive
sky (a 3D skybox, or the generated sky of maps whose sky textures aren't available) after the world and only where it
shows (`r_skystencil 0` draws it first, to compare), keeps translucent
surfaces sorted with as little work as possible, and uploads all map geometry while loading instead of mid-run.

## Development

* `npm test` — unit tests (set `SURF_TEST_MAPS=/path/to/bsps` to also run the real-map tests)
* `npm run typecheck`
* `npm run e2e` — end-to-end run of the real game in headless Chromium (playwright-core): menu and map browser,
  every built-in map (spawn, movement, timer start, fail teleport, `!r`), chat and console, and — with
  `SURF_TEST_MAPS` set — every real map in that folder (load time, start-zone placement, screenshots, fps),
  deterministic surf runs on their ramps and map switching without errors or memory growth. Screenshots and a
  `results.json` go to `$E2E_OUT` (default: a temp folder). Uses `/opt/pw-browsers/chromium-*` or `CHROMIUM_PATH`.
* `npm run catalog` — regenerate `public/maps/catalog.json` / `zones.json`
* `worker/` — the SURF relay (Cloudflare Worker); its unit tests run in `npm test` (`tests/relay_worker.test.ts`),
  `cd worker && npm install && npx wrangler dev` runs it locally on :8787 (`?relay=http://localhost:8787`)
* `docs/ARCHITECTURE.md` — module layout, contracts, the `window.__surf` debug API and the e2e scenarios

### URL parameters

| | |
|---|---|
| `?map=surf_kitsune` | load a map at startup (built-in id or catalog name) |
| `?builtin=surf_tutorial` | load a built-in map |
| `?bsp=<url>` | play a `.bsp` / `.bsp.bz2` / `.rar` / `.zip` from a URL; in dev, files from `$SURF_TEST_MAPS` are served at `/__maps/<name>.bsp` |
| `?relay=<url>` | use this SURF relay for the page load (`?relay=off`: none) instead of the build's `VITE_SURF_RELAY` |
| `?autotest=1` | automation: no pointer lock required, never auto-pauses |

`window.__surf` exposes a small scripting API (state snapshot, map loading, teleport, +commands, `runTicks`,
console `exec`, chat `say`) for tests and debugging — see `docs/ARCHITECTURE.md`.
