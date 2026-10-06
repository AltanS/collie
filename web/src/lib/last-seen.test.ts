import {
  dropLegacyLastSeen,
  fitPaneText,
  loadLastPaneText,
  loadLastSnapshot,
  saveLastPaneText,
  saveLastSnapshot,
} from "./last-seen";
import {
  __resetStore,
  __storeIdle,
  deletePaneRecords,
  getRecord,
  PANE_CAP_BYTES,
  putRecord,
  REWRITE_AFTER_MS,
  utf8Bytes,
} from "@/lib/store";
import { paneScopeKey, scopeKey } from "@/lib/scope";
import { FakeIDBFactory, uninstallFakeIndexedDB } from "@/test/fake-indexeddb";
import { fixtureSnapshot } from "@/test/handlers";

// The last-seen cache is the loaders' door to the on-device store (lib/store.ts, ADR 0087). The
// store's own bounds and its wipe are pinned in store.test.ts; this file pins the two record kinds
// this module owns, and that they outlive the page, which sessionStorage did not.

let idb: FakeIDBFactory;

beforeEach(() => {
  idb = new FakeIDBFactory().install();
  __resetStore();
});

afterEach(() => {
  __resetStore();
  uninstallFakeIndexedDB();
});

describe("the write-through last-seen cache", () => {
  it("reads back a snapshot with the time it was fetched", async () => {
    const at = Date.now() - 60_000;
    saveLastSnapshot(undefined, fixtureSnapshot, at);
    const got = await loadLastSnapshot(undefined);
    expect(got?.at).toBe(at);
    expect(got?.value.agents).toHaveLength(fixtureSnapshot.agents.length);
  });

  it("keeps scopes and breadths apart", async () => {
    saveLastSnapshot(undefined, fixtureSnapshot);
    expect(await loadLastSnapshot({ session: "demo" })).toBeNull();
    expect(await loadLastSnapshot({ host: "bruno" })).toBeNull();
    expect(await loadLastSnapshot(undefined, true)).toBeNull();
  });

  it("reads back a pane mirror verbatim, newlines and all", async () => {
    const text = "line one\nline two\n\n❯ ";
    const at = Date.now() - 60_000;
    saveLastPaneText(undefined, "w1:p1", text, at);
    expect(await loadLastPaneText(undefined, "w1:p1")).toEqual({ at, value: text });
  });

  it("does not read back a mirror past the store's lifetime", async () => {
    saveLastPaneText(undefined, "w1:p1", "yesterday's screen", Date.now() - 25 * 60 * 60 * 1000);
    expect(await loadLastPaneText(undefined, "w1:p1")).toBeNull();
  });

  it("outlives the page: a fresh page reads back what the last one saw", async () => {
    saveLastSnapshot(undefined, fixtureSnapshot);
    saveLastPaneText(undefined, "w1:p1", "hello");
    await __storeIdle();
    __resetStore(); // the process is gone; IndexedDB is not
    expect((await loadLastSnapshot(undefined))?.value.bridge).toBe(fixtureSnapshot.bridge);
    expect((await loadLastPaneText(undefined, "w1:p1"))?.value).toBe("hello");
  });

  it("files pane text under its pane, so the per-pane cap and the password wipe reach it", async () => {
    saveLastPaneText({ host: "bruno" }, "w1:p1", "hello");
    expect(await getRecord("pane-text", paneScopeKey({ host: "bruno" }, "w1:p1"))).not.toBeNull();
    expect(await loadLastPaneText(undefined, "w1:p1")).toBeNull();
  });

  it("keeps the newest lines of a mirror past the per-pane cap", async () => {
    const line = `${"█".repeat(70)}\n`;
    const text = `FIRST LINE\n${line.repeat(Math.ceil(PANE_CAP_BYTES / 200))}LAST LINE`;
    saveLastPaneText(undefined, "w1:p1", text);
    const got = await loadLastPaneText(undefined, "w1:p1");
    expect(got?.value.endsWith("LAST LINE")).toBe(true);
    expect(got?.value.startsWith("█")).toBe(true); // cut at a line start
    expect(got?.value).not.toContain("FIRST LINE");
    expect(utf8Bytes(JSON.stringify(got?.value))).toBeLessThanOrEqual(PANE_CAP_BYTES);
  });

  it("two identical saves make one put, and a changed one writes again", async () => {
    const at = Date.now();
    saveLastPaneText(undefined, "w1:p1", "same screen", at);
    saveLastPaneText(undefined, "w1:p1", "same screen", at + 2000);
    saveLastSnapshot(undefined, fixtureSnapshot, at);
    saveLastSnapshot(undefined, fixtureSnapshot, at + 2000);
    await __storeIdle();
    expect(idb.puts).toBe(4); // one record each for the pane and the snapshot: a meta and a body
    // The skipped write leaves the first fetch's time: older than the truth, never younger.
    expect((await loadLastPaneText(undefined, "w1:p1"))?.at).toBe(at);

    saveLastPaneText(undefined, "w1:p1", "the screen moved", at + 4000);
    await __storeIdle();
    expect(idb.puts).toBe(6);
  });

  it("writes an unchanged value again once the rewrite window has passed", async () => {
    const at = Date.now() - REWRITE_AFTER_MS - 1000;
    saveLastPaneText(undefined, "w1:p1", "same screen", at);
    saveLastPaneText(undefined, "w1:p1", "same screen", at + REWRITE_AFTER_MS);
    await __storeIdle();
    expect(idb.puts).toBe(4);
    expect((await loadLastPaneText(undefined, "w1:p1"))?.at).toBe(at + REWRITE_AFTER_MS);
  });

  it("writes an unchanged value again after its record was deleted", async () => {
    const at = Date.now();
    saveLastPaneText(undefined, "w1:p1", "same screen", at);
    await deletePaneRecords({ scope: undefined, paneId: "w1:p1" });
    saveLastPaneText(undefined, "w1:p1", "same screen", at + 1000);
    expect((await loadLastPaneText(undefined, "w1:p1"))?.value).toBe("same screen");
  });

  it("leaves a mirror under the cap untouched", () => {
    expect(fitPaneText("a\nb")).toBe("a\nb");
  });

  // Every read is total: a record of the wrong shape reads as a miss or as text, never a throw. A
  // cache miss costs a stale render, an exception costs the whole boot this cache exists to save.
  it("treats a snapshot that is not an object as a miss", async () => {
    await putRecord("snapshot", scopeKey(), "not a snapshot");
    expect(await loadLastSnapshot(undefined)).toBeNull();
  });

  it("reads a pane record of the wrong shape as text, never as an object", async () => {
    await putRecord("pane-text", paneScopeKey(undefined, "w1:p1"), 42);
    expect((await loadLastPaneText(undefined, "w1:p1"))?.value).toBe("42");
  });

  it("works with no IndexedDB at all, for the life of the page", async () => {
    uninstallFakeIndexedDB();
    __resetStore();
    saveLastPaneText(undefined, "w1:p1", "hello");
    expect((await loadLastPaneText(undefined, "w1:p1"))?.value).toBe("hello");
  });

  it("deletes the 1.17 sessionStorage mirror and nothing else", () => {
    sessionStorage.setItem(`collie:last-snapshot:${scopeKey()}`, "{}");
    sessionStorage.setItem(`collie:last-pane:${paneScopeKey(undefined, "w1:p1")}`, "1\ntext");
    sessionStorage.setItem("something:else", "keep me");
    dropLegacyLastSeen();
    expect(sessionStorage.getItem(`collie:last-snapshot:${scopeKey()}`)).toBeNull();
    expect(sessionStorage.getItem(`collie:last-pane:${paneScopeKey(undefined, "w1:p1")}`)).toBeNull();
    expect(sessionStorage.getItem("something:else")).toBe("keep me");
    sessionStorage.clear();
  });
});
