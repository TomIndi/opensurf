// The SURF relay: a small Cloudflare Worker (worker/) serving the same /__drive/ and /__ksf/ routes as the dev /
// preview server, with CORS, so a static build (GitHub Pages) can download catalog maps and read KSF world records.
//
// Its base URL comes from the build (VITE_SURF_RELAY, e.g. https://opensurf-relay.<account>.workers.dev) or, for one
// page load, from a `?relay=<url>` URL parameter (`?relay=off` disables a built-in relay). The clients try the page's
// own server first (dev / preview), then the relay.

/** A relay base URL: http(s) origin plus an optional path, no query / hash / trailing slash. Null when invalid. */
export function normalizeRelayBase(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Relay base from a build value and a page URL's `?relay=` parameter ('off' / 'none' / '0' disables). */
export function resolveRelayBase(buildValue: unknown, search: string | null | undefined): string | null {
  let param: string | null = null;
  try {
    param = search ? new URLSearchParams(search).get('relay') : null;
  } catch {
    param = null;
  }
  if (param !== null) {
    if (/^(off|none|0|false)?$/i.test(param.trim())) return null;
    const p = normalizeRelayBase(param);
    if (p) return p;
  }
  return normalizeRelayBase(buildValue);
}

let override: { value: string | null } | null = null;

/** The relay base URL of this page, null when there is none. */
export function getRelayBase(): string | null {
  if (override) return override.value;
  const build = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_SURF_RELAY : undefined;
  const search = typeof location !== 'undefined' ? location.search : '';
  return resolveRelayBase(build, search);
}

/** Tests: force the relay base (undefined restores the default). */
export function setRelayBaseForTests(v: string | null | undefined): void {
  override = v === undefined ? null : { value: v === null ? null : normalizeRelayBase(v) };
}

/** Absolute relay URL of a proxy path ("./__drive/x" or "/__drive/x"). */
export function relayUrl(base: string, proxyPath: string): string {
  return `${base}/${proxyPath.replace(/^\.?\/+/, '')}`;
}
