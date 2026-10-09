# SURF relay (Cloudflare Worker)

The static build of SURF (GitHub Pages) can't download catalog maps or read KSF world records by itself: Google
Drive answers a web page's cross-site download with 403 and no CORS header, and ksf.surf's API sends no CORS
headers. `npm run dev` / `npm run preview` relay them from Node; this Worker does the same for the static site.

It serves exactly the dev server's routes, and nothing else:

| Route | Upstream |
|---|---|
| `GET/HEAD /__drive/<fileId>` | `https://drive.usercontent.google.com/download?id=<fileId>&export=download&confirm=t` |
| `GET/HEAD /__ksf/records/<map>?game=<66t\|100t>` | `https://ksf.surf/api/maps/<map>/records/zone/0/0?game=<css\|css100t>&mode=0` |
| `GET/HEAD /__ksf/replay/<file>?game=<66t\|100t>` | `https://ksf.surf/api/replays/<file>?game=<css\|css100t>` |

Ids, map names, replay file names and boards are validated by the same code as the dev server
(`src/maps/drive.ts`, `src/maps/ksfproxy.ts`); only URLs built from them are fetched (never an open proxy). Upstream
status and body are streamed through with a timeout and a size cap; immutable files (map archives, replays) are
cached at Cloudflare's edge. Only the origins in `ALLOWED_ORIGINS` (`wrangler.toml`) may read the answers; other web
origins get 403. The free Workers plan (100k requests / day) is plenty.

## Deploy by hand

1. Create a free Cloudflare account (https://dash.cloudflare.com/sign-up). The first deploy asks you to pick a
   `workers.dev` subdomain if you have none yet.
2. From this directory:

   ```bash
   cd worker
   npm install
   npx wrangler login     # opens the browser once
   npx wrangler deploy
   ```

   It prints the relay's URL, e.g. `https://opensurf-relay.<your-subdomain>.workers.dev`. Opening it shows a one-line
   description; `https://…/__ksf/records/surf_utopia_njv?game=66t` shows JSON.

## Deploy from GitHub Actions

`.github/workflows/relay.yml` deploys this directory on pushes to `main` that touch `worker/**` (or the shared
validators), and from the Actions tab ("Run workflow"). It needs two repository secrets (Settings → Secrets and
variables → Actions → Secrets); without them the job is skipped with a notice:

* `CLOUDFLARE_API_TOKEN`: My Profile → API Tokens → Create Token → template "Edit Cloudflare Workers".
* `CLOUDFLARE_ACCOUNT_ID`: shown on the dashboard's Workers & Pages overview (right column).

The workflow's log prints the Worker's URL.

## Point the site at the relay

This repository's `.github/workflows/deploy.yml` uses `https://opensurf-relay.tomasindi360.workers.dev` unless the
repository **variable** `SURF_RELAY_URL` names another relay (Settings → Secrets and variables → Actions →
Variables); after changing either, re-run "Deploy to GitHub Pages" (or push): the build gets it as `VITE_SURF_RELAY`. Locally:
`VITE_SURF_RELAY=https://opensurf-relay.<sub>.workers.dev npm run build`. To try a relay without rebuilding, open the
site with `?relay=<url>` (`?relay=off` disables the built-in one for that page load).

The page always asks its own server first, so `npm run dev` / `npm run preview` keep using their local proxy.

## Allowed origins

`ALLOWED_ORIGINS` in `wrangler.toml` is a comma-separated list of `scheme://host[:port]` origins (default: the
upstream GitHub Pages site and the local dev / preview ports). A fork served from `https://<user>.github.io` adds that
origin there, or sets the repository variable `SURF_RELAY_ALLOWED_ORIGINS` (used by `relay.yml` as
`--var ALLOWED_ORIGINS:<value>`). Requests without an `Origin` header (curl) are served without CORS headers.

## Develop

* `npx wrangler dev` runs it on http://localhost:8787 (open the game with `?relay=http://localhost:8787`).
* Unit tests (no network) run with the game's: `npm test` at the repository root (`tests/relay_worker.test.ts`).
* `npm run check` bundles it without deploying.

Caching note: the Cache API (`caches.default`) only works on a custom domain, not on `workers.dev`; there, map
archives are fetched from Drive on each download (the browser keeps the extracted map in IndexedDB anyway), while
ksf.surf answers are still cached by Cloudflare's subrequest cache.
