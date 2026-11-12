import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { ensureOwnerOnlyDir, isOwnerOnly, privateRoot } from "../owner-only.ts";
import { decision } from "./fixtures.ts";
import { DECISIONS_FILE, HILL_CLOSED_KEPT, hillDir, HillStore, pruned } from "./store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "hill-store-"));
  roots.push(root);
  return root;
}

describe("the decisions file", () => {
  test("no file: the revision is undefined and nothing is created until the first write", () => {
    const dir = hillDir(stateDir());
    const store = new HillStore(dir, () => 5000);
    expect(store.rev()).toBeUndefined();
    expect(store.list()).toEqual({ rev: 0, open: [], closed: [], closedTotal: 0 });
    expect(existsSync(dir)).toBe(false);
  });

  test("a write is atomic and owner-only: a 0700 folder, a 0600 file, no temp file left", () => {
    const state = stateDir();
    // Windows: the bridge gives the state dir an owner-only access list at start (M43 spec 04), and the
    // hill's folder inherits it. NTFS has no 0600 or 0700, so the check reads that list instead.
    if (HOST.platform === "win32") ensureOwnerOnlyDir(state, HOST, { root: privateRoot("state"), repair: true });
    const dir = hillDir(state);
    const store = new HillStore(dir, () => 5000);
    expect(store.put(decision("dc_aaaaaaaaaaa1"))).toBe(true);
    for (const [path, mode] of [[dir, 0o700], [join(dir, DECISIONS_FILE), 0o600]] as const) {
      if (HOST.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(mode);
      else expect(isOwnerOnly(path, HOST)).toEqual({ state: "private" });
    }
    expect(readdirSync(dir)).toEqual([DECISIONS_FILE]);
    const file = JSON.parse(readFileSync(join(dir, DECISIONS_FILE), "utf8"));
    expect(file.v).toBe(1);
    expect(file.decisions).toHaveLength(1);
  });

  test("the revision starts at the clock and moves on every change; a restart reads the file back", () => {
    const dir = hillDir(stateDir());
    let clock = 5000;
    const store = new HillStore(dir, () => clock);
    store.put(decision("dc_aaaaaaaaaaa1"));
    const first = store.rev()!;
    expect(first).toBe(5000);
    store.put(decision("dc_aaaaaaaaaaa1", { state: "withdrawn", closedAt: 1100, closedReason: "by the poster" }));
    expect(store.rev()).toBe(5001);
    clock = 9000;
    const again = new HillStore(dir, () => clock);
    expect(again.rev()).toBe(9000);
    expect(again.get("dc_aaaaaaaaaaa1")?.state).toBe("withdrawn");
  });

  test("a file that does not read is set aside as .bad-<ts>, and the store starts empty with one warning", () => {
    const dir = hillDir(stateDir());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DECISIONS_FILE), "{ not json");
    const warnings: string[] = [];
    const store = new HillStore(dir, () => 7000, (line) => warnings.push(line));
    expect(store.all()).toEqual([]);
    expect(store.rev()).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([`${DECISIONS_FILE}.bad-7000`]);
    // Another version is set aside too.
    writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ v: 2, decisions: [] }));
    const again = new HillStore(dir, () => 7001, () => undefined);
    expect(again.all()).toEqual([]);
    expect(readdirSync(dir).toSorted()).toEqual([`${DECISIONS_FILE}.bad-7000`, `${DECISIONS_FILE}.bad-7001`]);
  });

  test("an entry that fails its reader is not listed, the good ones are", () => {
    const dir = hillDir(stateDir());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ v: 1, decisions: [decision("dc_aaaaaaaaaaa1"), { v: 1, id: "dc_bad" }, 7] }));
    const store = new HillStore(dir, () => 1);
    expect(store.all().map((held) => held.id)).toEqual(["dc_aaaaaaaaaaa1"]);
    expect(store.list().open.map((held) => held.id)).toEqual(["dc_aaaaaaaaaaa1"]);
    expect(store.cleanlyLoaded()).toBe(true);
  });

  test("an entry a newer build wrote survives a load and every write, unchanged, and keeps its id taken", () => {
    const dir = hillDir(stateDir());
    mkdirSync(dir, { recursive: true });
    const newer = { ...decision("dc_newer0000001"), v: 2, mood: "a field this build does not know" };
    writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ v: 1, decisions: [decision("dc_aaaaaaaaaaa1"), newer] }));
    const store = new HillStore(dir, () => 1);
    expect(store.get("dc_newer0000001")).toBeUndefined();
    expect(store.taken("dc_newer0000001")).toBe(true);
    expect(store.taken("dc_aaaaaaaaaaa1")).toBe(true);
    expect(store.taken("dc_free00000001")).toBe(false);
    expect(store.put(decision("dc_aaaaaaaaaaa1", { state: "withdrawn", closedAt: 5, closedReason: "by the poster" }))).toBe(true);
    expect(store.put(decision("dc_bbbbbbbbbbb1"))).toBe(true);
    const file = JSON.parse(readFileSync(join(dir, DECISIONS_FILE), "utf8"));
    expect(file.decisions).toHaveLength(3);
    expect(file.decisions).toContainEqual(newer);
    // A restart of this build reads it as unread again; the build that wrote it reads it back.
    const again = new HillStore(dir, () => 2);
    expect(again.all().map((held) => held.id).toSorted()).toEqual(["dc_aaaaaaaaaaa1", "dc_bbbbbbbbbbb1"]);
    again.put(decision("dc_ccccccccccc1"));
    expect(JSON.parse(readFileSync(join(dir, DECISIONS_FILE), "utf8")).decisions).toContainEqual(newer);
  });

  test("the media keep set: every held id and every unread entry's id; none when an unread entry has no id", () => {
    const dir = hillDir(stateDir());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ v: 1, decisions: [decision("dc_aaaaaaaaaaa1"), { v: 2, id: "dc_newer0000001" }] }));
    expect([...(new HillStore(dir, () => 1).mediaKeep() ?? [])].toSorted()).toEqual(["dc_aaaaaaaaaaa1", "dc_newer0000001"]);
    writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ v: 1, decisions: [decision("dc_aaaaaaaaaaa1"), 7] }));
    expect(new HillStore(dir, () => 1).mediaKeep()).toBeNull();
  });

  test("a set-aside file, or one that cannot be read, leaves the store not cleanly loaded and keeps no media set", () => {
    const dir = hillDir(stateDir());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ v: 2, decisions: [] }));
    const aside = new HillStore(dir, () => 1, () => undefined);
    expect(aside.cleanlyLoaded()).toBe(false);
    expect(aside.mediaKeep()).toBeNull();
    // It stays so after the next write: the set-aside file may still name a folder.
    aside.put(decision("dc_aaaaaaaaaaa1"));
    expect(aside.mediaKeep()).toBeNull();
    expect(new HillStore(null).cleanlyLoaded()).toBe(true);
    expect(new HillStore(hillDir(stateDir())).cleanlyLoaded()).toBe(true);
  });

  test("every open decision is kept, and only the newest closed ones", () => {
    const closed = Array.from({ length: HILL_CLOSED_KEPT + 5 }, (_, n) =>
      decision(`dc_c${String(n).padStart(11, "0")}`, { state: "answered", closedAt: 2000 + n }),
    );
    const open = decision("dc_oooooooooooo", { at: 1 });
    const kept = pruned([open, ...closed]);
    expect(kept).toHaveLength(HILL_CLOSED_KEPT + 1);
    expect(kept[0]!.id).toBe("dc_oooooooooooo");
    expect(kept.some((held) => held.id === "dc_c00000000000")).toBe(false);
  });

  test("the list serves every open decision and the 20 newest closed, newest first", () => {
    const store = new HillStore(null, () => 1);
    store.put(decision("dc_oooooooooooo"));
    for (let n = 0; n < 25; n += 1) store.put(decision(`dc_c${String(n).padStart(11, "0")}`, { state: "expired", closedAt: 100 + n }));
    const list = store.list();
    expect(list.open.map((held) => held.id)).toEqual(["dc_oooooooooooo"]);
    expect(list.closed).toHaveLength(20);
    expect(list.closed[0]!.id).toBe("dc_c00000000024");
  });
});

describe("forgetting closed decisions", () => {
  const stone = (id: string, over: Partial<{ requestId: string; key: string; digest: string | null; state: "answered" | "withdrawn"; closedAt: number }> = {}) => ({
    id,
    requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    key: "local/%1#aaaa",
    digest: "d".repeat(64),
    state: "answered" as const,
    closedAt: 1100,
    ...over,
  });

  test("a closed decision goes with a tombstone in the same file, the revision moves, and `dropped` hears the id", () => {
    const dir = hillDir(stateDir());
    const heard: string[][] = [];
    const store = new HillStore(dir, () => 5000, undefined, (ids) => heard.push([...ids]));
    store.put(decision("dc_aaaaaaaaaaa1", { state: "answered", closedAt: 1100 }), decision("dc_aaaaaaaaaaa2"));
    const rev = store.rev()!;
    expect(store.forget([stone("dc_aaaaaaaaaaa1")])).toEqual(["dc_aaaaaaaaaaa1"]);
    expect(store.rev()).toBeGreaterThan(rev);
    expect(store.all().map((d) => d.id)).toEqual(["dc_aaaaaaaaaaa2"]);
    expect(store.tombstone("dc_aaaaaaaaaaa1")?.state).toBe("answered");
    expect(store.taken("dc_aaaaaaaaaaa1")).toBe(true);
    expect(heard).toEqual([["dc_aaaaaaaaaaa1"]]);
    const file = JSON.parse(readFileSync(join(dir, DECISIONS_FILE), "utf8"));
    expect(file.decisions).toHaveLength(1);
    expect(file.cleared).toEqual([stone("dc_aaaaaaaaaaa1")]);
    // The tombstone holds none of the words.
    expect(JSON.stringify(file.cleared)).not.toContain("Ship it?");
  });

  test("a restart reads the tombstones back; a file with none carries no `cleared` key", () => {
    const dir = hillDir(stateDir());
    const store = new HillStore(dir, () => 5000);
    store.put(decision("dc_aaaaaaaaaaa1", { state: "answered", closedAt: 1100 }));
    expect(JSON.parse(readFileSync(join(dir, DECISIONS_FILE), "utf8")).cleared).toBeUndefined();
    store.forget([stone("dc_aaaaaaaaaaa1")]);
    const again = new HillStore(dir, () => 9000);
    expect(again.tombstone("dc_aaaaaaaaaaa1")).toEqual(stone("dc_aaaaaaaaaaa1"));
    expect(again.tombstoneOfRequest(stone("x").requestId, "local/%1#aaaa")?.id).toBe("dc_aaaaaaaaaaa1");
    expect(again.tombstoneOfRequest(stone("x").requestId, "local/%2#bbbb")).toBeUndefined();
  });

  test("an open decision, or an id the store does not hold, is never removed", () => {
    const store = new HillStore(null, () => 5000);
    store.put(decision("dc_aaaaaaaaaaa1"));
    const rev = store.rev();
    expect(store.forget([stone("dc_aaaaaaaaaaa1"), stone("dc_unknown00001")])).toEqual([]);
    expect(store.get("dc_aaaaaaaaaaa1")?.state).toBe("open");
    expect(store.tombstone("dc_aaaaaaaaaaa1")).toBeUndefined();
    expect(store.rev()).toBe(rev);
  });

  test("a failed write keeps memory as it was and answers null", () => {
    const root = stateDir();
    const dir = hillDir(root);
    const store = new HillStore(dir, () => 5000, () => undefined);
    store.put(decision("dc_aaaaaaaaaaa1", { state: "answered", closedAt: 1100 }));
    // A directory where the temp file goes makes the write fail.
    mkdirSync(join(dir, `${DECISIONS_FILE}.tmp`));
    expect(store.forget([stone("dc_aaaaaaaaaaa1")])).toBeNull();
    expect(store.get("dc_aaaaaaaaaaa1")).toBeDefined();
    expect(store.tombstone("dc_aaaaaaaaaaa1")).toBeUndefined();
  });

  test("the file keeps the newest 500 tombstones", () => {
    const store = new HillStore(null, () => 5000);
    for (let i = 0; i < 502; i += 1) {
      const id = `dc_${String(i).padStart(11, "0")}`;
      store.put(decision(id, { state: "answered", closedAt: 1100 }));
      store.forget([stone(id, { requestId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })]);
    }
    expect(store.tombstone("dc_00000000000")).toBeUndefined();
    expect(store.tombstone("dc_00000000001")).toBeUndefined();
    expect(store.tombstone("dc_00000000002")).toBeDefined();
    expect(store.tombstone("dc_00000000501")).toBeDefined();
  });

  test("the list counts every closed decision held, past the rows it serves", () => {
    const store = new HillStore(null, () => 5000);
    for (let i = 0; i < 25; i += 1) store.put(decision(`dc_${String(i).padStart(11, "0")}`, { state: "answered", closedAt: 1000 + i }));
    const list = store.list();
    expect(list.closed).toHaveLength(20);
    expect(list.closedTotal).toBe(25);
  });
});
