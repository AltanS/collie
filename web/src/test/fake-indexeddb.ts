// A SMALL FAKE OF INDEXEDDB, for the tests of lib/store.ts and of the modules that write through it.
//
// jsdom has no IndexedDB and the repo carries no `fake-indexeddb` dependency. lib/store.ts uses a
// narrow slice of the API on purpose, and this file implements exactly that slice: `open` with an
// upgrade, `deleteDatabase`, object stores keyed by `keyPath: "id"`, and `get`, `getAll`, `put`,
// `delete` and `clear` inside a transaction that commits on its own once no request is pending.
//
// What it keeps from the real thing, because the store depends on it:
//   - Requests answer asynchronously, and a transaction stays open across a request's success
//     callback and the promise continuations it resolves. It commits on the next macrotask with
//     nothing pending.
//   - Transactions on one database run one at a time, in the order they were created, so a read
//     created after a write sees that write.
//   - A transaction that fails (an injected quota error) commits nothing.
//   - Values are structured clones, never shared references.
//   - The data lives on the factory, so a test that re-imports every module (a fresh page, through
//     `vi.resetModules()`) finds what the previous "page" wrote.
//
// What it leaves out: indexes, cursors, key ranges, out-of-line keys, parallel read transactions.

type Rows = Map<string, unknown>;
type Stores = Map<string, Rows>;

class FakeRequest<T = unknown> extends EventTarget {
  result: T | undefined = undefined;
  error: DOMException | null = null;

  succeed(value: T): void {
    this.result = value;
    this.dispatchEvent(new Event("success"));
  }

  fail(error: DOMException): void {
    this.error = error;
    this.dispatchEvent(new Event("error"));
  }
}

/** Options that let a test break the database on purpose. */
export interface FakeIndexedDBOptions {
  /** Every `open` fails, as a blocked IndexedDB in private mode does. */
  failOpen?: boolean;
  /** Every `open` never answers, as Safari's first-load bug did. */
  hangOpen?: boolean;
  /** A write that would take the database past this many characters of stored JSON fails. */
  quotaChars?: number;
}

interface DatabaseState {
  version: number;
  stores: Stores;
}

export class FakeIDBFactory {
  readonly databases = new Map<string, DatabaseState>();
  readonly connections: FakeDatabase[] = [];
  readonly deleted: string[] = [];
  /** How many `put` requests every transaction together made, committed or not. */
  puts = 0;
  options: FakeIndexedDBOptions;

  constructor(options: FakeIndexedDBOptions = {}) {
    this.options = options;
  }

  open(name: string, version: number): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    setTimeout(() => {
      if (this.options.hangOpen === true) return;
      if (this.options.failOpen === true) {
        request.fail(new DOMException("blocked", "InvalidStateError"));
        return;
      }
      const existing = this.databases.get(name);
      const oldVersion = existing?.version ?? 0;
      if (version < oldVersion) {
        request.fail(new DOMException("lower version", "VersionError"));
        return;
      }
      const state = existing ?? { version, stores: new Map() };
      this.databases.set(name, state);
      const db = new FakeDatabase(this, name, state);
      this.connections.push(db);
      if (version > oldVersion) {
        db.upgrading = true;
        request.result = db;
        request.dispatchEvent(Object.assign(new Event("upgradeneeded"), { oldVersion }));
        db.upgrading = false;
        state.version = version;
      }
      request.succeed(db);
    }, 0);
    return request;
  }

  deleteDatabase(name: string): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    setTimeout(() => {
      const open = this.connections.filter((c) => c.name === name && !c.closed);
      for (const connection of open) connection.dispatchEvent(new Event("versionchange"));
      if (open.some((c) => !c.closed)) request.dispatchEvent(new Event("blocked"));
      this.databases.delete(name);
      this.deleted.push(name);
      request.succeed(undefined);
    }, 0);
    return request;
  }

  /** Every row of one object store, for assertions. */
  rows(name: string, store: string): unknown[] {
    return [...(this.databases.get(name)?.stores.get(store)?.values() ?? [])];
  }

  /** Install this fake as the global `indexedDB`. */
  install(): this {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: this });
    return this;
  }
}

/** Remove the global `indexedDB` a fake installed. */
export function uninstallFakeIndexedDB(): void {
  Reflect.deleteProperty(globalThis, "indexedDB");
}

class FakeDatabase extends EventTarget {
  closed = false;
  upgrading = false;
  readonly factory: FakeIDBFactory;
  readonly name: string;
  readonly state: DatabaseState;
  private queue: FakeTransaction[] = [];
  private running = false;

  constructor(factory: FakeIDBFactory, name: string, state: DatabaseState) {
    super();
    this.factory = factory;
    this.name = name;
    this.state = state;
  }

  get objectStoreNames() {
    const names = [...this.state.stores.keys()];
    return { length: names.length, item: (i: number) => names[i] ?? null };
  }

  createObjectStore(name: string): void {
    if (!this.upgrading) throw new DOMException("not upgrading", "InvalidStateError");
    this.state.stores.set(name, new Map());
  }

  deleteObjectStore(name: string): void {
    if (!this.upgrading) throw new DOMException("not upgrading", "InvalidStateError");
    this.state.stores.delete(name);
  }

  transaction(names: string | string[], mode: "readonly" | "readwrite" = "readonly"): FakeTransaction {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) if (!this.state.stores.has(n)) throw new DOMException(n, "NotFoundError");
    const tx = new FakeTransaction(this, list, mode);
    this.queue.push(tx);
    this.pump();
    return tx;
  }

  close(): void {
    this.closed = true;
  }

  /** Start the next queued transaction once the one before it has finished. */
  pump(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.running = true;
    next.start(() => {
      this.running = false;
      this.pump();
    });
  }
}

class FakeTransaction extends EventTarget {
  error: DOMException | null = null;
  readonly mode: "readonly" | "readwrite";
  private readonly db: FakeDatabase;
  private readonly names: string[];
  private working: Stores | null = null;
  private pending: (() => void)[] = [];
  private inFlight = 0;
  private done = false;
  private started = false;
  private finish: (() => void) | null = null;

  constructor(db: FakeDatabase, names: string[], mode: "readonly" | "readwrite") {
    super();
    this.db = db;
    this.names = names;
    this.mode = mode;
  }

  start(finish: () => void): void {
    this.finish = finish;
    this.started = true;
    // Copy on start, swap in on commit: a failed transaction leaves the database as it was.
    this.working = new Map(this.names.map((n) => [n, new Map(this.db.state.stores.get(n))]));
    const queued = this.pending;
    this.pending = [];
    for (const run of queued) run();
    this.maybeCommit();
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name)) throw new DOMException(name, "NotFoundError");
    return new FakeObjectStore(this, name);
  }

  abort(): void {
    if (this.done) return;
    this.done = true;
    this.error ??= new DOMException("aborted", "AbortError");
    this.dispatchEvent(new Event("abort"));
    this.finish?.();
  }

  /** Queue one request; it answers on a later macrotask. */
  request<T>(work: (stores: Stores) => T): FakeRequest<T> {
    if (this.done) throw new DOMException("finished", "TransactionInactiveError");
    const request = new FakeRequest<T>();
    this.inFlight += 1;
    const run = () => {
      setTimeout(() => {
        if (this.done || this.working === null) return;
        try {
          const value = work(this.working);
          this.inFlight -= 1;
          request.succeed(value);
        } catch (error) {
          this.inFlight -= 1;
          const failure = error instanceof DOMException ? error : new DOMException(String(error), "UnknownError");
          request.fail(failure);
          this.error = failure;
          this.dispatchEvent(new Event("error"));
          this.abort();
          return;
        }
        this.maybeCommit();
      }, 0);
    };
    if (this.started) run();
    else this.pending.push(run);
    return request;
  }

  write(): void {
    if (this.mode !== "readwrite") throw new DOMException("read only", "ReadOnlyError");
  }

  countPut(): void {
    this.db.factory.puts += 1;
  }

  private maybeCommit(): void {
    // Wait a macrotask: the promise continuations of the last success may queue another request.
    setTimeout(() => {
      if (this.done || this.inFlight > 0 || this.working === null) return;
      const quota = this.db.factory.options.quotaChars;
      if (quota !== undefined && this.mode === "readwrite") {
        let used = 0;
        for (const [name, rows] of this.db.state.stores) {
          const source = this.working.get(name) ?? rows;
          for (const row of source.values()) used += JSON.stringify(row).length;
        }
        if (used > quota) {
          this.error = new DOMException("quota", "QuotaExceededError");
          this.dispatchEvent(new Event("error"));
          this.abort();
          return;
        }
      }
      for (const [name, rows] of this.working) this.db.state.stores.set(name, rows);
      this.done = true;
      this.dispatchEvent(new Event("complete"));
      this.finish?.();
    }, 0);
  }
}

class FakeObjectStore {
  private readonly tx: FakeTransaction;
  private readonly name: string;

  constructor(tx: FakeTransaction, name: string) {
    this.tx = tx;
    this.name = name;
  }

  private rows(stores: Stores): Rows {
    const rows = stores.get(this.name);
    if (rows === undefined) throw new DOMException(this.name, "NotFoundError");
    return rows;
  }

  get(id: string): FakeRequest<unknown> {
    return this.tx.request((s) => structuredClone(this.rows(s).get(id)));
  }

  getAll(): FakeRequest<unknown[]> {
    return this.tx.request((s) => [...this.rows(s).values()].map((v) => structuredClone(v)));
  }

  put(value: { id: string }): FakeRequest<string> {
    this.tx.write();
    this.tx.countPut();
    const copy = structuredClone(value);
    return this.tx.request((s) => {
      this.rows(s).set(copy.id, copy);
      return copy.id;
    });
  }

  delete(id: string): FakeRequest<undefined> {
    this.tx.write();
    return this.tx.request((s) => {
      this.rows(s).delete(id);
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    this.tx.write();
    return this.tx.request((s) => {
      this.rows(s).clear();
      return undefined;
    });
  }
}
