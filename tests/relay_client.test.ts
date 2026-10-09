// The clients' route order (src/maps/downloader.ts openDrive, src/maps/ksf.ts createHttpKsfClient): the page's own
// server's proxy (dev / preview) first, then the SURF relay when one is configured, then the old behaviour. Plus the
// relay base URL (src/maps/relay.ts). No network.
import { afterEach, describe, expect, it } from 'vitest';
import { openDrive } from '../src/maps/downloader';
import { createHttpKsfClient, KsfUnavailableError } from '../src/maps/ksf';
import { getRelayBase, normalizeRelayBase, relayUrl, resolveRelayBase, setRelayBaseForTests } from '../src/maps/relay';

const RELAY = 'https://opensurf-relay.example.workers.dev';
const ID = '1AbCdEfGhIjKlMnOpQrStUv_-xyz';

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fetch answering by URL; `null` means a network error. */
function fakeFetch(answer: (url: string) => Response | null) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = answer(url);
    if (!r) throw new TypeError('Failed to fetch');
    return r;
  };
  return { calls, fn };
}

const staticHost404 = () => new Response('<!doctype html>404', { status: 404, headers: { 'content-type': 'text/html' } });

afterEach(() => setRelayBaseForTests(undefined));

describe('relay base URL', () => {
  it('normalizes and validates', () => {
    expect(normalizeRelayBase('https://opensurf-relay.x.workers.dev/')).toBe('https://opensurf-relay.x.workers.dev');
    expect(normalizeRelayBase(' https://relay.example/sub/ ')).toBe('https://relay.example/sub');
    expect(normalizeRelayBase('https://relay.example/?q=1#h')).toBe('https://relay.example');
    expect(normalizeRelayBase('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeRelayBase('http://relay.example')).toBeNull();
    expect(normalizeRelayBase('javascript:alert(1)')).toBeNull();
    expect(normalizeRelayBase('https://user:pw@relay.example')).toBeNull();
    expect(normalizeRelayBase('')).toBeNull();
    expect(normalizeRelayBase(undefined)).toBeNull();
    expect(relayUrl(RELAY, './__drive/abc')).toBe(`${RELAY}/__drive/abc`);
    expect(relayUrl(RELAY, './__ksf/records/surf_a?game=66t')).toBe(`${RELAY}/__ksf/records/surf_a?game=66t`);
  });

  it('takes the build value unless the page URL overrides it', () => {
    expect(resolveRelayBase(RELAY, '')).toBe(RELAY);
    expect(resolveRelayBase(undefined, '')).toBeNull();
    expect(resolveRelayBase(RELAY, '?relay=https://other.example/')).toBe('https://other.example');
    expect(resolveRelayBase(undefined, '?map=surf_a&relay=http://localhost:8787')).toBe('http://localhost:8787');
    expect(resolveRelayBase(RELAY, '?relay=off')).toBeNull();
    expect(resolveRelayBase(RELAY, '?relay=')).toBeNull();
    // an invalid override doesn't drop the build's relay
    expect(resolveRelayBase(RELAY, '?relay=ftp://x')).toBe(RELAY);
    setRelayBaseForTests(RELAY + '/');
    expect(getRelayBase()).toBe(RELAY);
    setRelayBaseForTests(null);
    expect(getRelayBase()).toBeNull();
  });
});

describe('Drive downloads: route order', () => {
  it('uses the same-origin proxy when present (dev / preview)', async () => {
    const f = fakeFetch(() => new Response('rar', { headers: { 'x-surf-drive-proxy': '1' } }));
    const { res, source } = await openDrive(ID, { fetch: f.fn, relay: RELAY });
    expect(source).toBe('local');
    expect(await res.text()).toBe('rar');
    expect(f.calls.map((c) => c.url)).toEqual([`./__drive/${ID}`]);
  });

  it('falls back to the relay when the page has no proxy', async () => {
    const f = fakeFetch((u) => (u.startsWith('./') ? staticHost404() : new Response('rar', { headers: { 'x-surf-drive-proxy': '1' } })));
    const { res, source } = await openDrive(ID, { fetch: f.fn, relay: RELAY });
    expect(source).toBe('relay');
    expect(await res.text()).toBe('rar');
    expect(f.calls.map((c) => c.url)).toEqual([`./__drive/${ID}`, `${RELAY}/__drive/${ID}`]);
    expect(f.calls[1].init).toMatchObject({ mode: 'cors', credentials: 'omit' });
    // a relay error status (e.g. Drive unreachable) is still the relay's answer
    const g = fakeFetch((u) => (u.startsWith('./') ? null : new Response('down', { status: 502, headers: { 'x-surf-drive-proxy': '1' } })));
    expect((await openDrive(ID, { fetch: g.fn, relay: RELAY })).res.status).toBe(502);
  });

  it('explains a relay that is down or is not a relay', async () => {
    const down = fakeFetch(() => null);
    await expect(openDrive(ID, { fetch: down.fn, relay: RELAY })).rejects.toThrow(/relay .* could not be reached/);
    const wrong = fakeFetch(() => staticHost404());
    await expect(openDrive(ID, { fetch: wrong.fn, relay: RELAY })).rejects.toThrow(/is not a SURF relay/);
    // never Drive directly when a relay is configured
    expect(down.calls.some((c) => c.url.includes('google'))).toBe(false);
  });

  it('without a relay: Drive directly, and the explanation when the browser refuses it', async () => {
    const f = fakeFetch((u) => (u.startsWith('./') ? staticHost404() : new Response('rar')));
    const { source } = await openDrive(ID, { fetch: f.fn, relay: null });
    expect(source).toBe('direct');
    expect(f.calls[1].url).toBe(`https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`);
    const blocked = fakeFetch((u) => (u.startsWith('./') ? staticHost404() : null));
    await expect(openDrive(ID, { fetch: blocked.fn, relay: null })).rejects.toThrow(/npm run dev.*VITE_SURF_RELAY/s);
  });
});

describe('KSF client: route order', () => {
  const json = (proxy: boolean) =>
    new Response('[{"rank":1,"name":"a","time":50}]', { headers: { 'content-type': 'application/json', ...(proxy ? { 'x-surf-ksf-proxy': '1' } : {}) } });

  it('uses the same-origin proxy when present and keeps using it', async () => {
    const f = fakeFetch(() => json(true));
    const client = createHttpKsfClient(f.fn, RELAY);
    expect((await client.fetchRecords('surf_a', '66t'))[0].name).toBe('a');
    await client.fetchRecords('surf_b', '100t');
    expect(f.calls.map((c) => c.url)).toEqual(['./__ksf/records/surf_a?game=66t', './__ksf/records/surf_b?game=100t']);
  });

  it('falls back to the relay and remembers it', async () => {
    const f = fakeFetch((u) => (u.startsWith('./') ? staticHost404() : json(true)));
    const client = createHttpKsfClient(f.fn, RELAY);
    expect((await client.fetchRecords('surf_a', '66t'))[0].name).toBe('a');
    await client.fetchRecords('surf_b', '100t');
    expect(f.calls.map((c) => c.url)).toEqual([
      './__ksf/records/surf_a?game=66t',
      `${RELAY}/__ksf/records/surf_a?game=66t`,
      `${RELAY}/__ksf/records/surf_b?game=100t`,
    ]);
    expect(f.calls[1].init).toMatchObject({ mode: 'cors', credentials: 'omit' });
  });

  it('a relay that never answered: unavailable (with the relay named); one that stops answering: a retryable error', async () => {
    const dead = fakeFetch((u) => (u.startsWith('./') ? staticHost404() : null));
    const e = await createHttpKsfClient(dead.fn, RELAY)
      .fetchRecords('surf_a', '66t')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KsfUnavailableError);
    expect((e as Error).message).toContain(RELAY);
    let up = true;
    const flaky = fakeFetch((u) => (u.startsWith('./') ? staticHost404() : up ? json(true) : null));
    const client = createHttpKsfClient(flaky.fn, RELAY);
    await client.fetchRecords('surf_a', '66t');
    up = false;
    const e2 = await client.fetchRecords('surf_b', '66t').catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(Error);
    expect(e2).not.toBeInstanceOf(KsfUnavailableError);
  });

  it('without a relay: unavailable as before', async () => {
    const f = fakeFetch(() => staticHost404());
    await expect(createHttpKsfClient(f.fn, null).fetchRecords('surf_a', '66t')).rejects.toBeInstanceOf(KsfUnavailableError);
    expect(f.calls.length).toBe(1);
  });
});
