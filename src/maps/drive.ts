// Google Drive downloads of catalog maps: the validated file id and the URLs built from it. No DOM and no Node
// imports: shared by the browser client (src/maps/downloader.ts), the dev / preview server's /__drive/ route
// (vite.config.ts) and the Cloudflare Worker relay (worker/src/index.ts).

/** Response header of a Drive proxy (dev / preview server or relay); a static host answering the same path lacks it. */
export const DRIVE_PROXY_HEADER = 'x-surf-drive-proxy';
/** Path prefix of the proxy route. */
export const DRIVE_PROXY_PREFIX = '/__drive/';
/** Google Drive file ids: URL-safe base64 characters, 10-128 long. */
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
/** Upstream timeout until Drive starts answering (ms). */
export const DRIVE_TIMEOUT_MS = 30000;
/** Largest archive a relay passes on (the biggest catalog archives are well under 200 MB). */
export const DRIVE_MAX_BYTES = 320 * 1024 * 1024;

export function isValidDriveId(id: unknown): id is string {
  return typeof id === 'string' && DRIVE_ID_RE.test(id);
}

/** Drive's direct download of a file (skips the "can't scan for viruses" page). */
export function driveDownloadUrl(driveId: string): string {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveId)}&export=download&confirm=t`;
}

/** Relative URL of the proxy route (works under any Vite base path). */
export function driveProxyPath(driveId: string): string {
  return `.${DRIVE_PROXY_PREFIX}${encodeURIComponent(driveId)}`;
}

/** The Drive file id a request path asks for: null when it isn't a /__drive/ path, '' when the id is invalid. */
export function parseDriveProxyPath(pathname: string): string | null {
  if (!pathname.startsWith(DRIVE_PROXY_PREFIX)) return null;
  const id = pathname.slice(DRIVE_PROXY_PREFIX.length);
  return isValidDriveId(id) ? id : '';
}
