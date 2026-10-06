// ── THE ON-DEVICE STORE IS ONE THING (ADR 0087, M46 spec 08) ─────────────────────────────────────
//
// Every piece of session content the phone keeps past a page's life lives here, in one IndexedDB
// database, `collie-store`. Today that is the pane-list snapshot and the last-seen pane text
// (lib/last-seen.ts); the Chat tail of each pane (spec 09) comes next. Drafts, the device token and
// the preferences stay in localStorage, because they need a synchronous read at boot. ADR 0087 holds
// the whole table of what the phone persists, and why each thing sits where it does.
//
// The rules, each enforced here and nowhere else:
//
//   - **Every record carries `fetchedAt`** (epoch ms, the moment the bridge answered with it) and the
//     **instance** it came from: the mount this app was served under (lib/base-path.ts). IndexedDB is
//     per origin, and two bridges can share an origin under two mounts (ADR 0052), so the mount is
//     the bridge identity a cold page knows before any fetch. A read only ever sees its own mount.
//   - **Every record has a lifetime**, 24 hours unless the caller says otherwise. An expired record
//     reads as a miss and is dropped.
//   - **Bounds.** The records of one pane share 256 KiB, the whole database holds 10 MiB, and a write
//     that would cross either evicts the least recently fetched records first. Size is the UTF-8
//     byte length of the record's JSON. A record that cannot fit is refused, and the older copy it
//     would have replaced goes too: a cache answering with older text than it was last handed is
//     worse than a miss.
//   - **A purge on open** drops every expired record, every record from another schema, and whatever
//     the total cap no longer allows. A schema bump that cannot migrate drops the database's
//     contents in the upgrade (`upgrade` below).
//   - **One wipe.** The store registers one cleaner with lib/wipe.ts under the name `store`. A pairing
//     that ends deletes the whole database; a password prompt (ADR 0017) drops that one pane's
//     records. Nothing else clears the store.
//   - **`navigator.storage.persist()` is asked once a page session**, on the first write. The answer
//     is recorded in `storeStatus()` and never shown: a refusal only means the browser may evict the
//     cache under storage pressure, which costs the operator nothing they can act on.
//   - **Nothing in the store may trigger an action** (spec 11). It holds text to draw, dated, and the
//     callers own that rule; the store hands out values and never interprets them.
//
// Only text the bridge already redacted reaches the store (spec 07 masks secrets before text leaves
// the machine), and the raw mirror never does: what is stored is what the phone was sent to draw.
//
// FAILURE IS SILENT AND SAFE. Every function is async and never rejects. IndexedDB can be missing (a
// non-DOM test, an old browser), blocked (private mode), hung (Safari's first-load bug), or full. In
// the first three cases the store runs on a memory map for the rest of the page session, with the
// same bounds, and `storeStatus().mode` says `memory`: the app works, nothing survives a restart, and
// nothing says so on screen. A full database refuses the write that does not fit and keeps the rest.
//
// ORDER. Every operation runs on one queue, in the order it was called. A pane's text written and
// then wiped for a password prompt is therefore gone, whatever the two transactions' timing.

import { basePath } from "@/lib/base-path";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { onWipe, type WipeContext } from "@/lib/wipe";

/** The one IndexedDB database the app opens. lib/storage-keys.test.ts holds its fate at unpair. */
export const STORE_NAME = "collie-store";

/**
 * The record schema. Bump it when a stored shape changes: the upgrade then drops every record, and
 * the purge drops any record still carrying the old number.
 */
export const STORE_SCHEMA = 1;

/** The lifetime of a record when the caller names none. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** What the records of one pane may hold together, in bytes of JSON. */
export const PANE_CAP_BYTES = 256 * 1024;

/**
 * What one KIND of a pane's records may take of {@link PANE_CAP_BYTES}. A pane holds two kinds that
 * are written on every poll, its last-seen text and its Chat tail, and the cap evicts the older of
 * the two when they cross it together. Each writer fits its value into half, so the two together
 * always fit and neither write ever evicts the other: without it a full mirror and a full tail would
 * take turns deleting each other, once a poll.
 */
export const PANE_KIND_SHARE_BYTES = PANE_CAP_BYTES / 2;

/** What the whole store may hold, in bytes of JSON. */
export const TOTAL_CAP_BYTES = 10 * 1024 * 1024;

/** How long an open may take before the page gives up and runs on memory. */
const OPEN_TIMEOUT_MS = 3000;

/**
 * How long an unchanged value may go without being written again. A pane polled every two seconds
 * mostly repeats itself, so a write of the same value is skipped (see `lastWrites`) until this much
 * time has passed since the last real write. The bound keeps a skipped record's `fetchedAt` at most
 * this old, so its age reads older than the truth by at most this much and never younger, and an
 * unchanged pane that stays live never runs out its lifetime.
 */
export const REWRITE_AFTER_MS = 5 * 60 * 1000;

/** How long a database delete may take before the wipe reports it done anyway (its rows are gone). */
const DELETE_TIMEOUT_MS = 3000;

const META = "meta";
const BODY = "body";

/**
 * What the store holds. `snapshot` is the pane-list snapshot (spec 10), `pane-text` the last-seen
 * mirror of a pane, `chat-tail` the rendered Chat blocks of a pane (spec 09).
 */
export type RecordKind = "snapshot" | "pane-text" | "chat-tail";

/** The pane a record belongs to, for the per-pane cap and the password-prompt wipe. */
export interface RecordPane {
  scope: Scope | undefined;
  paneId: string;
}

export interface PutOptions {
  /** The record's lifetime, from `fetchedAt`. Defaults to {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
  /** When the bridge answered with this value. Defaults to now. */
  fetchedAt?: number;
  /** The pane this record belongs to. Records of one pane share {@link PANE_CAP_BYTES}. */
  pane?: RecordPane;
}

export interface GetOptions {
  /**
   * How old a record may be and still read as current. Defaults to 0: a stored record is a copy of
   * the past, so it reads as stale unless the caller says how fresh counts as fresh.
   */
  staleAfterMs?: number;
}

/** A record as a reader gets it. `value` is whatever was stored, unchecked: the caller narrows it. */
export interface StoredRecord {
  key: string;
  value: unknown;
  fetchedAt: number;
  stale: boolean;
}

/** Which backing the store runs on this page session, and what the browser said about persistence. */
export interface StoreStatus {
  mode: "unopened" | "indexeddb" | "memory";
  /** The answer to `navigator.storage.persist()`, or null before it was asked or where it can't be. */
  persisted: boolean | null;
}

// ── The record, as stored ────────────────────────────────────────────────────
//
// Two object stores. `meta` holds the small half of every record, so a write can weigh the whole
// database (one `getAll` over a few hundred small rows) without loading every value. `body` holds the
// value as its JSON string: the bytes that were measured are the bytes that are stored, and a read
// gets back plain JSON and never a structured-clone shape the writer did not mean.

interface Meta {
  id: string;
  instance: string;
  kind: RecordKind;
  key: string;
  /** The pane's key (lib/scope.ts `paneScopeKey`), or null for a record of no pane. */
  pane: string | null;
  fetchedAt: number;
  expiresAt: number;
  size: number;
  schema: number;
}

interface Body {
  id: string;
  json: string;
}

/** The operations one transaction offers. A read transaction may not call the writes. */
interface Tx {
  metas(): Promise<Meta[]>;
  meta(id: string): Promise<Meta | undefined>;
  body(id: string): Promise<Body | undefined>;
  put(meta: Meta, body: Body): void;
  remove(id: string): void;
  clearAll(): void;
}

interface Backend {
  mode: "indexeddb" | "memory";
  /** Run `work` in one transaction. Resolves with its result once the transaction committed. */
  run<T>(write: boolean, work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Delete the whole database, closing this page's connection first. */
  destroy(): Promise<void>;
  close(): void;
}

// ── Module state ─────────────────────────────────────────────────────────────

let connecting: Promise<Backend> | null = null;
let current: Backend | null = null;
let queue: Promise<unknown> = Promise.resolve();
let status: StoreStatus = { mode: "unopened", persisted: null };
let persistAsked = false;
let clock: () => number = () => Date.now();
let instanceOverride: string | null = null;
/**
 * What this page last wrote under each record id: a signature of the JSON, the lifetime it asked for,
 * and the write's `fetchedAt`. Only a signature, not the text, so the map stays a few bytes per pane.
 * Every path that deletes a record (a delete, an eviction, an expired read, the purge, the wipe)
 * forgets its entry, so a skip never stands in for a record that is gone.
 */
const lastWrites = new Map<string, { signature: string; ttl: number; fetchedAt: number }>();

/** FNV-1a over the UTF-16 code units, with the length beside it: cheap, and enough to spot a repeat. */
function signatureOf(json: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${json.length}:${hash.toString(36)}`;
}

/** The memory fallback's rows. Module scope: they live exactly as long as the page. */
const memoryMeta = new Map<string, Meta>();
const memoryBody = new Map<string, Body>();

function now(): number {
  return clock();
}

function instance(): string {
  if (instanceOverride !== null) return instanceOverride;
  try {
    return basePath();
  } catch {
    return "/"; // no document: a worker or a non-DOM test
  }
}

function recordId(inst: string, kind: RecordKind, key: string): string {
  return `${inst}\u0000${kind}\u0000${key}`;
}

function paneOf(pane: RecordPane): string {
  return paneScopeKey(pane.scope, pane.paneId);
}

/** UTF-8 byte length without allocating the encoded bytes. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4; // a surrogate pair is one 4-byte code point
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isLive(meta: Meta, at: number): boolean {
  return meta.schema === STORE_SCHEMA && meta.expiresAt > at;
}

// ── The bounds, as pure functions ────────────────────────────────────────────

/** Oldest fetch first; the id breaks a tie so the order is stable. */
function byAge(a: Meta, b: Meta): number {
  return a.fetchedAt - b.fetchedAt || (a.id < b.id ? -1 : 1);
}

/**
 * The records a write must delete so `incoming` fits: the expired and foreign-schema ones, then the
 * least recently fetched of its pane past the pane cap, then the least recently fetched anywhere past
 * the total cap. The record `incoming` replaces is never counted. Exported for the tests.
 */
export function planEviction(metas: readonly Meta[], incoming: Meta, at: number): string[] {
  const evict = new Set<string>();
  const kept: Meta[] = [];
  for (const meta of metas) {
    if (meta.id === incoming.id) continue;
    if (isLive(meta, at)) kept.push(meta);
    else evict.add(meta.id);
  }
  if (incoming.pane !== null) {
    const group = kept.filter((m) => m.pane === incoming.pane).toSorted(byAge);
    let size = group.reduce((sum, m) => sum + m.size, 0) + incoming.size;
    for (const meta of group) {
      if (size <= PANE_CAP_BYTES) break;
      evict.add(meta.id);
      size -= meta.size;
    }
  }
  const rest = kept.filter((m) => !evict.has(m.id)).toSorted(byAge);
  let total = rest.reduce((sum, m) => sum + m.size, 0) + incoming.size;
  for (const meta of rest) {
    if (total <= TOTAL_CAP_BYTES) break;
    evict.add(meta.id);
    total -= meta.size;
  }
  return [...evict];
}

/** The records a purge deletes: expired, foreign schema, then the oldest past the total cap. */
function planPurge(metas: readonly Meta[], at: number): string[] {
  const evict: string[] = [];
  const kept: Meta[] = [];
  for (const meta of metas) {
    if (isLive(meta, at)) kept.push(meta);
    else evict.push(meta.id);
  }
  let total = kept.reduce((sum, m) => sum + m.size, 0);
  for (const meta of kept.toSorted(byAge)) {
    if (total <= TOTAL_CAP_BYTES) break;
    evict.push(meta.id);
    total -= meta.size;
  }
  return evict;
}

// ── The memory backend ───────────────────────────────────────────────────────

function memoryBackend(): Backend {
  const tx: Tx = {
    metas: async () => [...memoryMeta.values()],
    meta: async (id) => memoryMeta.get(id),
    body: async (id) => memoryBody.get(id),
    put: (meta, body) => {
      memoryMeta.set(meta.id, meta);
      memoryBody.set(body.id, body);
    },
    remove: (id) => {
      memoryMeta.delete(id);
      memoryBody.delete(id);
    },
    clearAll: () => {
      memoryMeta.clear();
      memoryBody.clear();
    },
  };
  return {
    mode: "memory",
    run: (_write, work) => work(tx),
    destroy: async () => tx.clearAll(),
    close: () => {},
  };
}

// ── The IndexedDB backend ────────────────────────────────────────────────────

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb request failed")));
  });
}

/** Close a connection that opened after its open had already timed out. */
function closeLate(db: IDBDatabase): void {
  db.close();
}

function timeout<T>(work: Promise<T>, ms: number, onLate?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(new Error("indexeddb timed out"));
    }, ms);
  });
  const watchLate = async () => {
    try {
      const value = await work;
      if (late) onLate?.(value);
    } catch {
      // The race below reports it.
    }
  };
  void watchLate();
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Create the object stores. Every upgrade so far is a drop: no older schema exists to migrate from,
 * and a cache that cannot be read in the new shape is cheaper to refill than to translate. A future
 * schema that CAN migrate writes its step here instead of the drop.
 */
function upgrade(db: IDBDatabase): void {
  const names: string[] = [];
  for (let i = 0; i < db.objectStoreNames.length; i++) {
    const name = db.objectStoreNames.item(i);
    if (name !== null) names.push(name);
  }
  for (const name of names) db.deleteObjectStore(name);
  db.createObjectStore(META, { keyPath: "id" });
  db.createObjectStore(BODY, { keyPath: "id" });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(STORE_NAME, STORE_SCHEMA);
    request.addEventListener("upgradeneeded", () => upgrade(request.result));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb open failed")));
  });
}

function deleteDatabase(factory: IDBFactory): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(STORE_NAME);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb delete failed")));
  });
}

/** The operations of one IndexedDB transaction over the two object stores. */
function txOps(tx: IDBTransaction): Tx {
  const meta = tx.objectStore(META);
  const body = tx.objectStore(BODY);
  return {
    // SAFETY: both stores are written only by `put` below, with a `Meta` and a `Body`. A row of
    // another shape could only come from another schema, and the upgrade drops those before this
    // connection exists.
    metas: () => settle(meta.getAll() as IDBRequest<Meta[]>),
    // SAFETY: as above, the only writer of `meta` is `put`.
    meta: (id) => settle(meta.get(id) as IDBRequest<Meta | undefined>),
    // SAFETY: as above, the only writer of `body` is `put`.
    body: (id) => settle(body.get(id) as IDBRequest<Body | undefined>),
    put: (m, b) => {
      meta.put(m);
      body.put(b);
    },
    remove: (id) => {
      meta.delete(id);
      body.delete(id);
    },
    clearAll: () => {
      meta.clear();
      body.clear();
    },
  };
}

/** Run `work` in one transaction; resolve with its result once the transaction committed. */
function runTransaction<T>(db: IDBDatabase, write: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([META, BODY], write ? "readwrite" : "readonly");
    let result: { value: T } | null = null;
    tx.addEventListener("complete", () => {
      if (result === null) reject(new Error("indexeddb transaction ended early"));
      else resolve(result.value);
    });
    tx.addEventListener("error", () => reject(tx.error ?? new Error("indexeddb transaction failed")));
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("indexeddb transaction aborted")));
    const drive = async () => {
      try {
        result = { value: await work(txOps(tx)) };
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // already finished
        }
        reject(error);
      }
    };
    void drive();
  });
}

function idbBackend(factory: IDBFactory, db: IDBDatabase): Backend {
  const backend: Backend = {
    mode: "indexeddb",
    run: async (write, work) => {
      try {
        return await runTransaction(db, write, work);
      } catch (error) {
        // A connection the browser closed under us cannot start a transaction: reopen next call.
        if (error instanceof DOMException && error.name === "InvalidStateError") forget(backend);
        throw error;
      }
    },
    destroy: async () => {
      // Empty the rows first, so the content is gone even if the delete below is blocked by another
      // tab that will not let go of its connection.
      await backend.run(true, async (tx) => tx.clearAll()).catch(() => {});
      backend.close();
      await timeout(deleteDatabase(factory), DELETE_TIMEOUT_MS).catch(() => {});
    },
    close: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
  // Another tab is upgrading or deleting the database: let go of it, and reopen on the next call.
  db.addEventListener("versionchange", () => forget(backend));
  // The browser closed it under us (Safari does, on storage pressure): reopen on the next call.
  db.addEventListener("close", () => forget(backend));
  return backend;
}

function forget(backend: Backend): void {
  backend.close();
  if (current === backend) {
    current = null;
    connecting = null;
  }
}

function indexedDBFactory(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null; // a browser that throws on access when storage is blocked
  }
}

async function openWithRetry(factory: IDBFactory): Promise<IDBDatabase> {
  try {
    return await timeout(openDatabase(factory), OPEN_TIMEOUT_MS, closeLate);
  } catch (error) {
    // A database from a NEWER schema (a downgrade): it cannot be read, so it goes and a fresh one
    // takes its place.
    if (!(error instanceof DOMException) || error.name !== "VersionError") throw error;
    await timeout(deleteDatabase(factory), DELETE_TIMEOUT_MS);
    return timeout(openDatabase(factory), OPEN_TIMEOUT_MS, closeLate);
  }
}

async function connect(): Promise<Backend> {
  const factory = indexedDBFactory();
  let backend: Backend;
  if (factory === null) backend = memoryBackend();
  else {
    try {
      backend = idbBackend(factory, await openWithRetry(factory));
    } catch {
      backend = memoryBackend();
    }
  }
  current = backend;
  lastWrites.clear(); // a new connection may be a new, empty database
  status = { ...status, mode: backend.mode };
  await backend.run(true, purgeWork).catch(() => 0);
  return backend;
}

function backendFor(): Promise<Backend> {
  connecting ??= connect();
  return connecting;
}

/** Run one operation on the queue. It sees every earlier call's effect, and never rejects. */
function enqueue<T>(work: (backend: Backend) => Promise<T>, fallback: T): Promise<T> {
  const next = queue.then(async () => work(await backendFor())).catch(() => fallback);
  queue = next;
  return next;
}

async function purgeWork(tx: Tx): Promise<number> {
  const doomed = planPurge(await tx.metas(), now());
  for (const id of doomed) {
    tx.remove(id);
    lastWrites.delete(id);
  }
  return doomed.length;
}

function requestPersistence(): void {
  if (persistAsked) return;
  persistAsked = true;
  const storage = globalThis.navigator?.storage;
  if (storage?.persist === undefined) return;
  void (async () => {
    try {
      const already = (await storage.persisted?.()) === true;
      const granted = already || (await storage.persist());
      status = { ...status, persisted: granted };
    } catch {
      // Not answered. The cache works the same either way.
    }
  })();
}

// ── The API ──────────────────────────────────────────────────────────────────

/** Open the store (once a page session) and purge it. Resolves with the backing it runs on. */
export function openStore(): Promise<"indexeddb" | "memory"> {
  return enqueue(async (backend) => backend.mode, "memory");
}

/** Which backing the store runs on, and whether the browser agreed to persist it. */
export function storeStatus(): StoreStatus {
  return status;
}

/**
 * Store a value. Resolves true when it was written, false when it did not fit or the write failed.
 * A refused value also drops the older record under the same key.
 */
export function putRecord<T>(kind: RecordKind, key: string, value: T, options: PutOptions = {}): Promise<boolean> {
  registerStoreWipe();
  const fetchedAt = options.fetchedAt ?? now();
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const pane = options.pane === undefined ? null : paneOf(options.pane);
  const inst = instance();
  return enqueue(async (backend) => {
    const id = recordId(inst, kind, key);
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined; // a cycle or a BigInt: not JSON, not storable
    }
    const size = json === undefined ? Number.POSITIVE_INFINITY : utf8Bytes(json);
    const cap = pane === null ? TOTAL_CAP_BYTES : PANE_CAP_BYTES;
    if (json === undefined || size > cap || ttl <= 0) {
      lastWrites.delete(id);
      await backend.run(true, async (tx) => tx.remove(id));
      return false;
    }
    // The same value under the same lifetime, written recently: the stored record already says it.
    const signature = signatureOf(json);
    const last = lastWrites.get(id);
    if (
      last !== undefined &&
      last.signature === signature &&
      last.ttl === ttl &&
      fetchedAt >= last.fetchedAt &&
      fetchedAt - last.fetchedAt < REWRITE_AFTER_MS
    ) {
      return true;
    }
    const meta: Meta = {
      id,
      instance: inst,
      kind,
      key,
      pane,
      fetchedAt,
      expiresAt: fetchedAt + ttl,
      size,
      schema: STORE_SCHEMA,
    };
    const body: Body = { id, json };
    const written = await backend.run(true, async (tx) => {
      for (const doomed of planEviction(await tx.metas(), meta, now())) {
        tx.remove(doomed);
        lastWrites.delete(doomed);
      }
      tx.put(meta, body);
      return true;
    });
    lastWrites.set(id, { signature, ttl, fetchedAt });
    if (backend.mode === "indexeddb") requestPersistence();
    return written;
  }, false);
}

function toRecord(meta: Meta, body: Body, at: number, staleAfterMs: number): StoredRecord | null {
  try {
    const value: unknown = JSON.parse(body.json);
    return { key: meta.key, value, fetchedAt: meta.fetchedAt, stale: at - meta.fetchedAt >= staleAfterMs };
  } catch {
    return null;
  }
}

/** Read one record of this instance. A miss, an expired record or an unreadable one is null. */
export function getRecord(kind: RecordKind, key: string, options: GetOptions = {}): Promise<StoredRecord | null> {
  const inst = instance();
  return enqueue(async (backend) => {
    const id = recordId(inst, kind, key);
    const at = now();
    const found = await backend.run(false, async (tx) => {
      const meta = await tx.meta(id);
      if (meta === undefined || !isLive(meta, at)) return { meta, record: null };
      const body = await tx.body(id);
      return { meta, record: body === undefined ? null : toRecord(meta, body, at, options.staleAfterMs ?? 0) };
    });
    // A dead record found on the way is dropped, not kept for the purge.
    if (found.meta !== undefined && found.record === null) {
      lastWrites.delete(id);
      await backend.run(true, async (tx) => tx.remove(id));
    }
    return found.record;
  }, null);
}

/** Every live record of one kind for this instance, newest fetch first. */
export function listRecords(kind: RecordKind, options: GetOptions = {}): Promise<StoredRecord[]> {
  const inst = instance();
  return enqueue(async (backend) => {
    const at = now();
    return backend.run(false, async (tx) => {
      const metas = (await tx.metas())
        .filter((m) => m.instance === inst && m.kind === kind && isLive(m, at))
        .toSorted((a, b) => byAge(b, a));
      const out: StoredRecord[] = [];
      for (const meta of metas) {
        const body = await tx.body(meta.id);
        const record = body === undefined ? null : toRecord(meta, body, at, options.staleAfterMs ?? 0);
        if (record !== null) out.push(record);
      }
      return out;
    });
  }, []);
}

/** Delete one record of this instance. */
export function deleteRecord(kind: RecordKind, key: string): Promise<void> {
  const id = recordId(instance(), kind, key);
  return enqueue((backend) => {
    lastWrites.delete(id);
    return backend.run(true, async (tx) => tx.remove(id));
  }, undefined);
}

/**
 * Delete every record of one kind, on EVERY instance. The Chat tail setting calls it when the operator
 * turns the tail off: the setting lives in localStorage, which every mount on the origin shares, so
 * "keep nothing" is about the phone and not about one mount.
 */
export function deleteKind(kind: RecordKind): Promise<void> {
  return enqueue(
    (backend) =>
      backend.run(true, async (tx) => {
        for (const meta of await tx.metas()) {
          if (meta.kind !== kind) continue;
          tx.remove(meta.id);
          lastWrites.delete(meta.id);
        }
      }),
    undefined,
  );
}

/** Delete every record of one pane on this instance, of every kind: the password-prompt wipe. */
export function deletePaneRecords(pane: RecordPane): Promise<void> {
  const inst = instance();
  const target = paneOf(pane);
  return enqueue(
    (backend) =>
      backend.run(true, async (tx) => {
        for (const meta of await tx.metas()) {
          if (meta.instance === inst && meta.pane === target) {
            tx.remove(meta.id);
            lastWrites.delete(meta.id);
          }
        }
      }),
    undefined,
  );
}

/** Drop what has expired, what another schema wrote and what the total cap no longer allows. */
export function purge(): Promise<number> {
  return enqueue((backend) => backend.run(true, purgeWork), 0);
}

/**
 * Delete the whole database, every instance's records with it. The wipe calls this when a pairing
 * ends. The next call opens a fresh, empty store.
 */
export function clearStore(): Promise<void> {
  return enqueue(async (backend) => {
    lastWrites.clear();
    await backend.destroy();
    forget(backend);
  }, undefined);
}

// ── The one wipe hook ────────────────────────────────────────────────────────

function storeCleaner(context: WipeContext): Promise<void> {
  return context.reason === "password" ? deletePaneRecords(context.pane) : clearStore();
}

/**
 * Register the store's cleaner with the wipe routine. Runs when this module loads and again on every
 * write, so the hook is in place whenever the store holds anything, even after a test reset the
 * wipe's registry. Registering under the same name replaces, so this costs one map write.
 */
export function registerStoreWipe(): void {
  onWipe("store", storeCleaner);
}

registerStoreWipe();

// ── Test seams ───────────────────────────────────────────────────────────────

/** Resolves once every operation queued so far has finished. */
export async function __storeIdle(): Promise<void> {
  try {
    await queue;
  } catch {
    // enqueue never rejects; this only satisfies the type of `queue`.
  }
}

/**
 * Forget the connection, the memory rows, the queue and the status, so the next call opens afresh.
 * A test may pin the clock and the instance.
 */
export function __resetStore(options: { now?: () => number; instance?: string } = {}): void {
  current?.close();
  current = null;
  connecting = null;
  queue = Promise.resolve();
  status = { mode: "unopened", persisted: null };
  persistAsked = false;
  memoryMeta.clear();
  memoryBody.clear();
  lastWrites.clear();
  clock = options.now ?? (() => Date.now());
  instanceOverride = options.instance ?? null;
}
