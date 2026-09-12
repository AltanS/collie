import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CacheWatchStore,
  coerceCacheWatchFile,
  sentMarkOf,
  UNSEEN_GRACE_MS,
  watchIdOf,
  watchKeyOf,
} from "./watch.ts";

// The watch list's store: `notify-prefs.test.ts`'s shape, one directory down. The coercion is pure;
// the round trip, the permissions and both prunes are driven through a throwaway temp state dir.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-cache-watch-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const TS = 1_789_000_000_000;
const local = { ref: "id:abc" };
const peer = { host: "minibuch", session: "next", ref: "pane:%1" };

describe("watchKeyOf / watchIdOf", () => {
  test("the key carries all three parts, and two panes never collide", () => {
    expect(watchKeyOf(local)).not.toBe(watchKeyOf(peer));
    expect(watchKeyOf({ ref: "id:abc" })).toBe(watchKeyOf({ host: undefined, session: undefined, ref: "id:abc" }));
    // A session name containing the shape of a key must not be able to forge another pane's key.
    expect(watchKeyOf({ session: "a", ref: "b" })).not.toBe(watchKeyOf({ session: "a:b", ref: "" }));
  });

  test("the published id is short, stable and not the key", () => {
    const id = watchIdOf(watchKeyOf(local));
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).toBe(watchIdOf(watchKeyOf(local)));
    expect(id).not.toContain("abc");
  });
});

describe("coerceCacheWatchFile", () => {
  test("a missing, wrong-shaped or partial file reads as empty rather than throwing", () => {
    expect(coerceCacheWatchFile(undefined)).toEqual({ entries: [], sent: [] });
    expect(coerceCacheWatchFile(null)).toEqual({ entries: [], sent: [] });
    expect(coerceCacheWatchFile({ entries: "all of them" })).toEqual({ entries: [], sent: [] });
  });

  test("a row with no ref is dropped; an absent host or session stays ABSENT, never null", () => {
    const out = coerceCacheWatchFile({
      version: 1,
      entries: [{ label: "no ref" }, { ref: "id:a", label: "one", lastSeenAt: TS }, { ref: "" }],
      sent: [{ key: "k", expiresAt: TS }, { key: "bad" }],
    });
    expect(out.entries).toEqual([{ ref: "id:a", label: "one", lastSeenAt: TS }]);
    expect("host" in out.entries[0]!).toBe(false);
    expect(out.sent).toEqual([{ key: "k", expiresAt: TS }]);
  });
});

describe("CacheWatchStore", () => {
  test("asking the question does not create the file", async () => {
    const stateDir = await tempDir();
    const store = new CacheWatchStore({ stateDir }, () => TS);
    await store.load();
    expect(store.current()).toEqual([]);
    expect(store.has(watchKeyOf(local))).toBe(false);
    expect(await readdir(stateDir)).toEqual([]);
  });

  test("a toggle round-trips through disk and writes owner-only", async () => {
    const stateDir = await tempDir();
    const store = new CacheWatchStore({ stateDir }, () => TS);
    await store.set(peer, "collie · next", true);
    expect((await stat(join(stateDir, "cache-watch.json"))).mode & 0o777).toBe(0o600);

    const reloaded = new CacheWatchStore({ stateDir }, () => TS);
    await reloaded.load();
    expect(reloaded.current()).toEqual([
      { host: "minibuch", session: "next", ref: "pane:%1", label: "collie · next", lastSeenAt: TS },
    ]);
    expect(reloaded.has(watchKeyOf(peer))).toBe(true);
  });

  test("setting the same pane twice keeps one row, with the fresher label", async () => {
    const store = new CacheWatchStore({ stateDir: await tempDir() }, () => TS);
    await store.set(local, "old name", true);
    await store.set(local, "new name", true);
    expect(store.current().map((e) => e.label)).toEqual(["new name"]);
  });

  test("switching off removes the row", async () => {
    const store = new CacheWatchStore({ stateDir: await tempDir() }, () => TS);
    await store.set(local, "one", true);
    await store.set(local, "one", false);
    expect(store.current()).toEqual([]);
  });

  test("an id naming no entry is not an error, and leaves the list alone", async () => {
    const store = new CacheWatchStore({ stateDir: await tempDir() }, () => TS);
    await store.set(local, "one", true);
    await store.forget("deadbeef");
    expect(store.current()).toHaveLength(1);
    await store.forget(watchIdOf(watchKeyOf(local)));
    expect(store.current()).toEqual([]);
  });

  test("the list hands out an opaque id, and a pane id only when the pane is in sight", async () => {
    const store = new CacheWatchStore({ stateDir: await tempDir() }, () => TS);
    await store.set(local, "here", true);
    await store.set(peer, "there", true);
    const rows = store.list((entry) => (entry.ref === "id:abc" ? "w1:p1" : undefined));
    expect(rows).toEqual([
      { id: watchIdOf(watchKeyOf(local)), label: "here", paneId: "w1:p1" },
      { id: watchIdOf(watchKeyOf(peer)), label: "there", host: "minibuch", session: "next" },
    ]);
  });

  test("a sent mark survives a restart, and is pruned once its deadline has passed", async () => {
    const stateDir = await tempDir();
    let now = TS;
    const store = new CacheWatchStore({ stateDir }, () => now);
    await store.set(local, "one", true);
    const key = watchKeyOf(local);
    await store.markSent([{ key, expiresAt: TS + 300_000 }]);
    expect(store.sentMarks().has(sentMarkOf(key, TS + 300_000))).toBe(true);

    // The restart this persistence exists for: `make deploy` must not re-warn a deadline still ahead.
    const reloaded = new CacheWatchStore({ stateDir }, () => now);
    await reloaded.load();
    expect(reloaded.sentMarks().has(sentMarkOf(key, TS + 300_000))).toBe(true);

    // Past the deadline, the next save drops it — so the array is bounded by the cycles in flight.
    now = TS + 400_000;
    await reloaded.markSent([{ key, expiresAt: now + 300_000 }]);
    expect(reloaded.sentMarks().has(sentMarkOf(key, TS + 300_000))).toBe(false);
    expect(reloaded.sentMarks().size).toBe(1);
  });

  test("a mark for a pane nobody watches still survives — the global switch has no entry", async () => {
    const store = new CacheWatchStore({ stateDir: await tempDir() }, () => TS);
    await store.markSent([{ key: "global-only", expiresAt: TS + 60_000 }]);
    expect(store.sentMarks().has(sentMarkOf("global-only", TS + 60_000))).toBe(true);
  });

  test("an entry whose session is absent survives 24 hours, then goes", async () => {
    const stateDir = await tempDir();
    let now = TS;
    const store = new CacheWatchStore({ stateDir }, () => now);
    await store.set(local, "one", true);

    // A peer that rebooted, or a link that flapped: nearly a day unseen, and the row is still there.
    now = TS + UNSEEN_GRACE_MS - 1;
    await store.markSent([{ key: "x", expiresAt: now + 1000 }]);
    expect(store.current()).toHaveLength(1);

    // Seen again on a tick inside the grace — in memory, with no write of its own.
    store.seen([watchKeyOf(local)], now);
    now += UNSEEN_GRACE_MS - 1;
    await store.markSent([{ key: "y", expiresAt: now + 1000 }]);
    expect(store.current()).toHaveLength(1);

    // And past the grace with nothing refreshing it, the next save prunes it.
    now += UNSEEN_GRACE_MS + 1;
    await store.markSent([{ key: "z", expiresAt: now + 1000 }]);
    expect(store.current()).toEqual([]);
  });

  test("current() returns copies — a caller cannot mutate the store's rows", async () => {
    const store = new CacheWatchStore({ stateDir: await tempDir() }, () => TS);
    await store.set(local, "one", true);
    store.current()[0]!.label = "hijacked";
    expect(store.current()[0]!.label).toBe("one");
  });

  test("a file written by a newer build with unknown fields still loads what it can", async () => {
    const stateDir = await tempDir();
    await writeFile(
      join(stateDir, "cache-watch.json"),
      JSON.stringify({ version: 9, entries: [{ ref: "id:a", label: "l", lastSeenAt: TS, mood: "blue" }] }),
    );
    const store = new CacheWatchStore({ stateDir }, () => TS);
    await store.load();
    expect(store.current()).toEqual([{ ref: "id:a", label: "l", lastSeenAt: TS }]);
  });
});
