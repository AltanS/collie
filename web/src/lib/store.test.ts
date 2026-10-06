import { FakeIDBFactory, uninstallFakeIndexedDB } from "@/test/fake-indexeddb";
import { rememberPairingExpiry } from "./pairing";
import {
  __resetStore,
  __storeIdle,
  clearStore,
  DEFAULT_TTL_MS,
  deletePaneRecords,
  deleteRecord,
  getRecord,
  listRecords,
  openStore,
  PANE_CAP_BYTES,
  planEviction,
  purge,
  putRecord,
  STORE_NAME,
  STORE_SCHEMA,
  storeStatus,
  TOTAL_CAP_BYTES,
  utf8Bytes,
} from "./store";
import { __resetWipe, wipeDevice } from "./wipe";

// The on-device store (ADR 0087, M46 spec 08). Pinned here: a record comes back with its fetch time,
// a page that starts again finds what the last one wrote, the lifetime, the per-pane cap, the total
// cap, the schema drop, the one wipe, the instance a record belongs to, the order of operations, the
// single persistence request, and the memory fallback when IndexedDB is unavailable, blocked, hung
// or full.

const T0 = 1_700_000_000_000;
let clock = T0;
let fake: FakeIDBFactory;

const PANE = { scope: undefined, paneId: "w1:p1" };

/** A value JSON cannot hold. */
interface Cyclic {
  self?: Cyclic;
}
const OTHER_PANE = { scope: undefined, paneId: "w1:p2" };

/** A JSON string value whose stored size is exactly `bytes`. */
function ofSize(bytes: number): string {
  return "x".repeat(bytes - 2); // the two quotes JSON adds
}

/** A fresh page: the module state goes, the database (the fake) stays. */
function newPage(instance?: string): void {
  __resetStore({ now: () => clock, instance });
}

beforeEach(() => {
  clock = T0;
  fake = new FakeIDBFactory().install();
  __resetWipe();
  newPage();
});

afterEach(() => {
  newPage();
  uninstallFakeIndexedDB();
  vi.useRealTimers();
});

describe("the on-device store", () => {
  it("opens on IndexedDB and gives a record back with its fetch time", async () => {
    expect(await openStore()).toBe("indexeddb");
    expect(await putRecord("snapshot", "lead", { agents: [1, 2] }, { fetchedAt: T0 - 5000 })).toBe(true);
    expect(await getRecord("snapshot", "lead")).toEqual({
      key: "lead",
      value: { agents: [1, 2] },
      fetchedAt: T0 - 5000,
      stale: true,
    });
    expect(storeStatus().mode).toBe("indexeddb");
  });

  it("reads a record as current only inside the freshness the caller names", async () => {
    await putRecord("snapshot", "lead", 1, { fetchedAt: T0 - 5000 });
    expect((await getRecord("snapshot", "lead", { staleAfterMs: 10_000 }))?.stale).toBe(false);
    expect((await getRecord("snapshot", "lead", { staleAfterMs: 1000 }))?.stale).toBe(true);
  });

  it("survives the page: a fresh page reads what the last one wrote", async () => {
    await putRecord("pane-text", "w1:p1", "hello", { pane: PANE });
    await __storeIdle();
    newPage();
    expect((await getRecord("pane-text", "w1:p1"))?.value).toBe("hello");
  });

  it("keeps each instance's records to itself", async () => {
    newPage("/a/");
    await putRecord("snapshot", "lead", "from a");
    newPage("/b/");
    expect(await getRecord("snapshot", "lead")).toBeNull();
    await putRecord("snapshot", "lead", "from b");
    newPage("/a/");
    expect((await getRecord("snapshot", "lead"))?.value).toBe("from a");
  });

  it("runs operations in the order they were called", async () => {
    void putRecord("pane-text", "w1:p1", "secret screen", { pane: PANE });
    void deletePaneRecords(PANE);
    expect(await getRecord("pane-text", "w1:p1")).toBeNull();
  });

  it("lists the live records of a kind, newest first", async () => {
    await putRecord("pane-text", "old", "a", { fetchedAt: T0 - 2000 });
    await putRecord("pane-text", "new", "b", { fetchedAt: T0 - 1000 });
    await putRecord("snapshot", "lead", "c");
    expect((await listRecords("pane-text")).map((r) => r.key)).toEqual(["new", "old"]);
  });

  it("deletes one record", async () => {
    await putRecord("snapshot", "lead", 1);
    await deleteRecord("snapshot", "lead");
    expect(await getRecord("snapshot", "lead")).toBeNull();
  });

  it("refuses a value that is not JSON, and keeps nothing older under its key", async () => {
    await putRecord("snapshot", "lead", { ok: true });
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    expect(await putRecord("snapshot", "lead", cyclic)).toBe(false);
    expect(await getRecord("snapshot", "lead")).toBeNull();
  });
});

describe("the age limit", () => {
  it("reads a record past its lifetime as a miss, and drops it", async () => {
    await putRecord("snapshot", "lead", 1);
    clock = T0 + DEFAULT_TTL_MS + 1;
    expect(await getRecord("snapshot", "lead")).toBeNull();
    await __storeIdle();
    expect(fake.rows(STORE_NAME, "meta")).toEqual([]);
  });

  it("honours the lifetime the caller names", async () => {
    await putRecord("chat-tail", "w1:p1", [1], { ttlMs: 7 * DEFAULT_TTL_MS, pane: PANE });
    clock = T0 + 2 * DEFAULT_TTL_MS;
    expect((await getRecord("chat-tail", "w1:p1"))?.value).toEqual([1]);
  });

  it("counts age from fetchedAt, not from the write", async () => {
    await putRecord("snapshot", "lead", 1, { fetchedAt: T0 - DEFAULT_TTL_MS - 1 });
    expect(await getRecord("snapshot", "lead")).toBeNull();
  });

  it("purges expired records when a page opens the store", async () => {
    await putRecord("snapshot", "lead", 1);
    await putRecord("snapshot", "later", 2, { fetchedAt: T0 + DEFAULT_TTL_MS });
    await __storeIdle();
    clock = T0 + DEFAULT_TTL_MS + 1;
    newPage();
    await openStore();
    expect(fake.rows(STORE_NAME, "meta")).toHaveLength(1);
    expect(await purge()).toBe(0);
  });
});

describe("the per-pane cap", () => {
  it("evicts the pane's oldest record when its records together pass the cap", async () => {
    const half = Math.floor(PANE_CAP_BYTES / 2) + 10;
    await putRecord("pane-text", "w1:p1", ofSize(half), { pane: PANE, fetchedAt: T0 - 10 });
    await putRecord("chat-tail", "w1:p1", ofSize(half), { pane: PANE, fetchedAt: T0 });
    expect(await getRecord("pane-text", "w1:p1")).toBeNull();
    expect(await getRecord("chat-tail", "w1:p1")).not.toBeNull();
  });

  it("leaves other panes alone", async () => {
    const big = PANE_CAP_BYTES - 100;
    await putRecord("pane-text", "w1:p2", ofSize(big), { pane: OTHER_PANE, fetchedAt: T0 - 10 });
    await putRecord("pane-text", "w1:p1", ofSize(big), { pane: PANE });
    expect(await getRecord("pane-text", "w1:p2")).not.toBeNull();
  });

  it("refuses one record bigger than the cap, and drops the older copy under its key", async () => {
    await putRecord("pane-text", "w1:p1", "old screen", { pane: PANE });
    expect(await putRecord("pane-text", "w1:p1", ofSize(PANE_CAP_BYTES + 1), { pane: PANE })).toBe(false);
    expect(await getRecord("pane-text", "w1:p1")).toBeNull();
  });

  it("measures size as UTF-8 bytes of the JSON", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("❯")).toBe(3);
    expect(utf8Bytes("🐕")).toBe(4);
  });
});

describe("the total cap", () => {
  const meta = (id: string, size: number, fetchedAt: number, pane: string | null = null) => ({
    id,
    instance: "/",
    kind: "pane-text" as const,
    key: id,
    pane,
    fetchedAt,
    expiresAt: T0 + DEFAULT_TTL_MS,
    size,
    schema: STORE_SCHEMA,
  });

  it("evicts the least recently fetched records until the new one fits", () => {
    const quarter = TOTAL_CAP_BYTES / 4;
    const metas = [meta("a", quarter, 3), meta("b", quarter, 1), meta("c", quarter, 2), meta("d", quarter, 4)];
    expect(planEviction(metas, meta("e", quarter, 5), T0)).toEqual(["b"]);
    expect(planEviction(metas, meta("e", 2 * quarter, 5), T0)).toEqual(["b", "c"]);
  });

  it("never counts the record a write replaces, and drops the expired first", () => {
    const metas = [meta("a", TOTAL_CAP_BYTES, 1), { ...meta("old", 10, 1), expiresAt: T0 - 1 }];
    expect(planEviction(metas, meta("a", TOTAL_CAP_BYTES, 2), T0)).toEqual(["old"]);
  });

  it("holds the store under the cap through real writes", async () => {
    const big = PANE_CAP_BYTES - 100;
    const count = Math.ceil(TOTAL_CAP_BYTES / big) + 1;
    for (let i = 0; i < count; i++) {
      await putRecord("pane-text", `p${i}`, ofSize(big), { pane: { scope: undefined, paneId: `p${i}` }, fetchedAt: T0 + i });
    }
    expect(await getRecord("pane-text", "p0")).toBeNull();
    expect(await getRecord("pane-text", `p${count - 1}`)).not.toBeNull();
    const total = (await listRecords("pane-text")).reduce((sum, r) => sum + utf8Bytes(JSON.stringify(r.value)), 0);
    expect(total).toBeLessThanOrEqual(TOTAL_CAP_BYTES);
  });
});

describe("the schema version", () => {
  it("drops records another schema wrote when the store opens", async () => {
    await putRecord("snapshot", "lead", 1);
    await __storeIdle();
    const db = fake.databases.get(STORE_NAME);
    const rows = db?.stores.get("meta");
    for (const [id, row] of rows ?? []) rows?.set(id, Object.assign({}, row, { schema: STORE_SCHEMA - 1 }));
    newPage();
    expect(await getRecord("snapshot", "lead")).toBeNull();
    expect(fake.rows(STORE_NAME, "meta")).toEqual([]);
  });

  it("drops a database a newer build left behind and starts afresh", async () => {
    fake.databases.set(STORE_NAME, { version: STORE_SCHEMA + 1, stores: new Map([["meta", new Map()]]) });
    expect(await openStore()).toBe("indexeddb");
    expect(fake.deleted).toContain(STORE_NAME);
    expect(await putRecord("snapshot", "lead", 1)).toBe(true);
  });
});

describe("the wipe", () => {
  it("deletes the whole database when a pairing ends", async () => {
    await putRecord("snapshot", "lead", 1);
    await putRecord("pane-text", "w1:p1", "text", { pane: PANE });
    const report = await wipeDevice("unpair");
    expect(report.failed).toEqual([]);
    expect(fake.deleted).toContain(STORE_NAME);
    expect(await getRecord("snapshot", "lead")).toBeNull();
    expect(await getRecord("pane-text", "w1:p1")).toBeNull();
    // A fresh store opens after it, empty.
    expect(await putRecord("snapshot", "lead", 2)).toBe(true);
  });

  it("clearStore leaves no record of any kind, and the next put writes even an unchanged value", async () => {
    await putRecord("snapshot", "lead", { panes: 1 });
    await putRecord("pane-text", "w1:p1", "text", { pane: PANE });
    await putRecord("chat-tail", "w1:p1", ["block"], { pane: PANE });
    await putRecord("chat-tail", "w1:p2", ["other"], { pane: OTHER_PANE });
    // The unchanged-value skip is live: the same value again does not touch the database.
    const before = fake.puts;
    await putRecord("snapshot", "lead", { panes: 1 });
    expect(fake.puts).toBe(before);

    await clearStore();

    for (const kind of ["snapshot", "pane-text", "chat-tail"] as const) {
      expect(await listRecords(kind)).toEqual([]);
    }
    expect(fake.rows(STORE_NAME, "meta")).toEqual([]);
    expect(fake.rows(STORE_NAME, "body")).toEqual([]);

    // The map that drives the skip was reset with it: the same value is written again, not skipped,
    // so a live poll right after a clear puts exactly its own record back and nothing else.
    const afterClear = fake.puts;
    await putRecord("snapshot", "lead", { panes: 1 });
    expect(fake.puts).toBeGreaterThan(afterClear);
    expect((await getRecord("snapshot", "lead"))?.value).toEqual({ panes: 1 });
    expect(await listRecords("pane-text")).toEqual([]);
    expect(await listRecords("chat-tail")).toEqual([]);
  });

  it("drops one pane's records at a password prompt, and nothing else", async () => {
    await putRecord("snapshot", "lead", 1);
    await putRecord("pane-text", "w1:p1", "sudo", { pane: PANE });
    await putRecord("chat-tail", "w1:p1", ["block"], { pane: PANE });
    await putRecord("pane-text", "w1:p2", "other", { pane: OTHER_PANE });
    await wipeDevice("password", PANE);
    expect(await getRecord("pane-text", "w1:p1")).toBeNull();
    expect(await getRecord("chat-tail", "w1:p1")).toBeNull();
    expect((await getRecord("pane-text", "w1:p2"))?.value).toBe("other");
    expect((await getRecord("snapshot", "lead"))?.value).toBe(1);
  });

  it("clears the memory fallback too", async () => {
    uninstallFakeIndexedDB();
    newPage();
    await putRecord("snapshot", "lead", 1);
    await clearStore();
    expect(await getRecord("snapshot", "lead")).toBeNull();
  });
});

describe("persistence", () => {
  it("asks the browser to persist once, on the first write, and records the answer", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { ...navigator, storage: { persisted: async () => false, persist } });
    try {
      expect(storeStatus().persisted).toBeNull();
      await putRecord("snapshot", "a", 1);
      await putRecord("snapshot", "b", 2);
      await vi.waitFor(() => expect(storeStatus().persisted).toBe(true));
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not ask again when the store is already persisted", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { ...navigator, storage: { persisted: async () => true, persist } });
    try {
      await putRecord("snapshot", "a", 1);
      await vi.waitFor(() => expect(storeStatus().persisted).toBe(true));
      expect(persist).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("when IndexedDB is unavailable", () => {
  it("runs on memory when there is no IndexedDB at all", async () => {
    uninstallFakeIndexedDB();
    newPage();
    expect(await openStore()).toBe("memory");
    expect(await putRecord("snapshot", "lead", 1)).toBe(true);
    expect((await getRecord("snapshot", "lead"))?.value).toBe(1);
    expect(storeStatus()).toEqual({ mode: "memory", persisted: null, deleteBlocked: false });
  });

  it("runs on memory when the open is blocked, as in private mode", async () => {
    fake.options.failOpen = true;
    expect(await openStore()).toBe("memory");
    expect(await putRecord("snapshot", "lead", 1)).toBe(true);
    expect((await getRecord("snapshot", "lead"))?.value).toBe(1);
  });

  it("runs on memory when the open never answers", async () => {
    vi.useFakeTimers();
    fake.options.hangOpen = true;
    const opened = openStore();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await opened).toBe("memory");
  });

  it("refuses a write a full database cannot take, and keeps what it holds", async () => {
    await putRecord("snapshot", "lead", "kept");
    fake.options.quotaChars = 400;
    expect(await putRecord("pane-text", "w1:p1", ofSize(2000), { pane: PANE })).toBe(false);
    expect((await getRecord("snapshot", "lead"))?.value).toBe("kept");
    expect(await getRecord("pane-text", "w1:p1")).toBeNull();
  });

  it("memory mode keeps the same bounds", async () => {
    uninstallFakeIndexedDB();
    newPage();
    expect(await putRecord("pane-text", "w1:p1", ofSize(PANE_CAP_BYTES + 1), { pane: PANE })).toBe(false);
    await putRecord("snapshot", "lead", 1);
    clock = T0 + DEFAULT_TTL_MS + 1;
    expect(await getRecord("snapshot", "lead")).toBeNull();
  });
});

// M46 hardening: no record outlives the pairing it was saved under.
describe("the pairing's expiry caps every record", () => {
  afterEach(() => rememberPairingExpiry(null));

  it("a record saved an hour before the pairing ends reads as a miss once it has ended", async () => {
    rememberPairingExpiry(T0 + 60 * 60 * 1000);
    expect(await putRecord("snapshot", "lead", "herd", { ttlMs: DEFAULT_TTL_MS })).toBe(true);
    clock = T0 + 60 * 60 * 1000 - 1;
    expect((await getRecord("snapshot", "lead"))?.value).toBe("herd");
    clock = T0 + 60 * 60 * 1000;
    expect(await getRecord("snapshot", "lead")).toBeNull();
  });

  it("a cold open after the expiry reads nothing saved", async () => {
    rememberPairingExpiry(T0 + 1000);
    await putRecord("pane-text", "w1:p1", "text", { pane: PANE });
    // A new page, later: the expiry is read back from localStorage, the record has expired.
    clock = T0 + 5000;
    newPage();
    expect(await getRecord("pane-text", "w1:p1")).toBeNull();
  });

  it("a shorter ttl than the remaining pairing still wins", async () => {
    rememberPairingExpiry(T0 + DEFAULT_TTL_MS);
    await putRecord("snapshot", "lead", 1, { ttlMs: 1000 });
    clock = T0 + 1001;
    expect(await getRecord("snapshot", "lead")).toBeNull();
  });

  it("refuses a write once the pairing has already ended", async () => {
    rememberPairingExpiry(T0 - 1);
    expect(await putRecord("snapshot", "lead", 1)).toBe(false);
  });

  it("no known expiry leaves the ttl alone", async () => {
    rememberPairingExpiry(null);
    await putRecord("snapshot", "lead", 1);
    clock = T0 + DEFAULT_TTL_MS - 1;
    expect((await getRecord("snapshot", "lead"))?.value).toBe(1);
  });

  it("a new expiry is not hidden by the unchanged-value skip", async () => {
    rememberPairingExpiry(T0 + DEFAULT_TTL_MS);
    await putRecord("snapshot", "lead", 1);
    rememberPairingExpiry(T0 + 1000);
    await putRecord("snapshot", "lead", 1);
    clock = T0 + 1000;
    expect(await getRecord("snapshot", "lead")).toBeNull();
  });
});
