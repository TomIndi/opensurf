// ReplaySystem persistence through a minimal in-memory IndexedDB (open/upgrade/version bump, get/put/delete).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '../src/core/vec3';
import { ReplaySystem, frameCount } from '../src/game/replay';

type Handler = ((ev?: unknown) => void) | null;

class FakeRequest<T> {
  result!: T;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeStore {
  constructor(
    private readonly data: Map<string, unknown>,
    private readonly keyPath: string,
    private readonly tx: FakeTx,
  ) {}
  get(key: string): FakeRequest<unknown> {
    const r = new FakeRequest<unknown>();
    queueMicrotask(() => {
      r.result = structuredClone(this.data.get(key));
      r.onsuccess?.();
      this.tx.done();
    });
    return r;
  }
  put(value: Record<string, unknown>): FakeRequest<unknown> {
    const r = new FakeRequest<unknown>();
    queueMicrotask(() => {
      this.data.set(String(value[this.keyPath]), structuredClone(value));
      r.onsuccess?.();
      this.tx.done();
    });
    return r;
  }
  delete(key: string): FakeRequest<unknown> {
    const r = new FakeRequest<unknown>();
    queueMicrotask(() => {
      this.data.delete(key);
      r.onsuccess?.();
      this.tx.done();
    });
    return r;
  }
}

class FakeTx {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  constructor(private readonly db: FakeDb) {}
  objectStore(name: string): FakeStore {
    const s = this.db.stores.get(name);
    if (!s) throw new Error(`no store ${name}`);
    return new FakeStore(s.data, s.keyPath, this);
  }
  done(): void {
    queueMicrotask(() => this.oncomplete?.());
  }
}

class FakeDb {
  stores = new Map<string, { keyPath: string; data: Map<string, unknown> }>();
  version = 1;
  onversionchange: Handler = null;
  closed = false;
  get objectStoreNames(): { contains(n: string): boolean } {
    return { contains: (n: string) => this.stores.has(n) };
  }
  createObjectStore(name: string, opts: { keyPath: string }): void {
    this.stores.set(name, { keyPath: opts.keyPath, data: new Map() });
  }
  transaction(store: string, _mode: string): FakeTx {
    if (this.closed) throw new Error('closed');
    if (!this.stores.has(store)) throw new Error(`no store ${store}`);
    return new FakeTx(this);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeIdb {
  dbs = new Map<string, FakeDb>();
  opens: (number | undefined)[] = [];
  open(name: string, version?: number): FakeRequest<FakeDb> {
    this.opens.push(version);
    const r = new FakeRequest<FakeDb>();
    queueMicrotask(() => {
      let db = this.dbs.get(name);
      const fresh = !db;
      if (!db) {
        db = new FakeDb();
        db.version = version ?? 1;
        this.dbs.set(name, db);
      }
      // reopen: a new connection object sharing the stores
      const conn = new FakeDb();
      conn.stores = db.stores;
      conn.version = db.version;
      const target = version ?? db.version;
      if (fresh || target > db.version) {
        db.version = target;
        conn.version = target;
        r.result = conn;
        r.onupgradeneeded?.();
      }
      r.result = conn;
      r.onsuccess?.();
    });
    return r;
  }
}

const g = globalThis as { indexedDB?: unknown };
const fake = new FakeIdb();

beforeAll(() => {
  // another module already created db "surf" (version 3) without a "replays" store
  const other = new FakeDb();
  other.version = 3;
  other.createObjectStore('something', { keyPath: 'k' });
  fake.dbs.set('surf', other);
  g.indexedDB = fake;
});

afterAll(() => {
  delete g.indexedDB;
});

describe('replay persistence (IndexedDB)', () => {
  it('creates the store with a version bump, saves the PB and loads it in a new session', async () => {
    const a = new ReplaySystem('surf_idb');
    a.beginRecording(0);
    for (let i = 0; i < 50; i++) a.recordTick(v3(i, 0, 0), { pitch: 0, yaw: i, roll: 0 }, false, 0);
    await a.endRecording(true, 0.5);
    expect(fake.dbs.get('surf')!.stores.has('replays')).toBe(true);
    expect(fake.dbs.get('surf')!.stores.has('something')).toBe(true);
    expect(fake.opens).toContain(4); // bumped from version 3

    const b = new ReplaySystem('surf_idb');
    expect(b.ghostAt(0)).toBeNull();
    expect(await b.loadPb('surf_idb', 0)).toBe(true);
    const pb = b.getPb(0)!;
    expect(frameCount(pb)).toBe(50);
    expect(pb.tickrate).toBeCloseTo(100, 6);
    expect(b.ghostAt(0.255)!.origin.x).toBeCloseTo(25.5, 4);
    expect(await b.loadPb('surf_idb', 1)).toBe(false);
    expect(await b.loadPb('other_map', 0)).toBe(false);

    await b.deletePb(0);
    const c = new ReplaySystem('surf_idb');
    expect(await c.loadPb('surf_idb', 0)).toBe(false);
  });
});
