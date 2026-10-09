import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASES_FILE,
  BASES_VERSION,
  MAX_BASES,
  WorktreeBaseStore,
  coerceBases,
  memoryWorktreeBases,
} from "./worktree-bases.ts";

// The note a worktree create leaves about where it started from (ADR 0089, amended): one entry per
// checkout folder, 0600, a schema version, written only by a create and read tolerantly.

let stateDir = "";
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "collie-worktree-bases-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const silent = () => {};

describe("WorktreeBaseStore", () => {
  test("loading a missing file writes nothing", async () => {
    const store = new WorktreeBaseStore(stateDir, silent);
    await store.load();
    expect(await readdir(stateDir)).toEqual([]);
    expect(store.get("/r/.worktrees/x")).toBeUndefined();
  });

  test("a record writes one 0600 file with a version, holding the base and when, and nothing else", async () => {
    const store = new WorktreeBaseStore(stateDir, silent);
    await store.load();
    await store.record("/r/.worktrees/x", { base: "main", createdAt: 1234 });
    expect(await readdir(stateDir)).toEqual([BASES_FILE]);
    // NTFS has no 0600 mode bits; on Windows the state folder's access list keeps the file private.
    if (process.platform !== "win32") expect((await stat(join(stateDir, BASES_FILE))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(stateDir, BASES_FILE), "utf8"))).toEqual({
      version: BASES_VERSION,
      bases: { "/r/.worktrees/x": { base: "main", createdAt: 1234 } },
    });
  });

  test("a second store reads what the first wrote", async () => {
    const first = new WorktreeBaseStore(stateDir, silent);
    await first.record("/r/.worktrees/a", { base: "main", createdAt: 1 });
    await first.record("/r/.worktrees/b", { base: "feature/x", createdAt: 2 });
    const second = new WorktreeBaseStore(stateDir, silent);
    await second.load();
    expect(second.get("/r/.worktrees/a")).toEqual({ base: "main", createdAt: 1 });
    expect(second.get("/r/.worktrees/b")).toEqual({ base: "feature/x", createdAt: 2 });
  });

  test("the same folder again replaces its entry", async () => {
    const store = new WorktreeBaseStore(stateDir, silent);
    await store.record("/r/w", { base: "main", createdAt: 1 });
    await store.record("/r/w", { base: "dev", createdAt: 2 });
    expect(store.get("/r/w")).toEqual({ base: "dev", createdAt: 2 });
  });

  test("a broken file reads as empty and is not rewritten by loading", async () => {
    await writeFile(join(stateDir, BASES_FILE), "{not json");
    const store = new WorktreeBaseStore(stateDir, silent);
    await store.load();
    expect(store.get("/r/w")).toBeUndefined();
    expect(await readFile(join(stateDir, BASES_FILE), "utf8")).toBe("{not json");
  });

  test("a write that fails warns and keeps the entry in memory", async () => {
    const lines: string[] = [];
    // The state dir is a FILE, so the mkdir inside the write fails.
    const file = join(stateDir, "plain");
    await writeFile(file, "x");
    const store = new WorktreeBaseStore(file, (line) => lines.push(line));
    await store.record("/r/w", { base: "main", createdAt: 1 });
    expect(lines).toHaveLength(1);
    expect(store.get("/r/w")).toEqual({ base: "main", createdAt: 1 });
  });
});

describe("coerceBases", () => {
  test("keeps well-formed entries and drops the rest", () => {
    expect(
      coerceBases({
        version: BASES_VERSION,
        bases: {
          "/ok": { base: "main", createdAt: 5 },
          "/no-base": { createdAt: 5 },
          "/empty-base": { base: "", createdAt: 5 },
          "/no-time": { base: "main" },
          "/nan-time": { base: "main", createdAt: "5" },
          "/scalar": "main",
          "/null": null,
          "/array": [],
          "": { base: "main", createdAt: 5 },
        },
      }),
    ).toEqual({ "/ok": { base: "main", createdAt: 5 } });
  });

  test("a foreign or missing version, or a wrong shape, is empty", () => {
    expect(coerceBases({ version: 2, bases: { "/ok": { base: "main", createdAt: 5 } } })).toEqual({});
    expect(coerceBases({ bases: { "/ok": { base: "main", createdAt: 5 } } })).toEqual({});
    expect(coerceBases({ version: BASES_VERSION, bases: [] })).toEqual({});
    expect(coerceBases([])).toEqual({});
    expect(coerceBases("x")).toEqual({});
    expect(coerceBases(null)).toEqual({});
  });

  test("a __proto__ folder is dropped, never assigned", () => {
    const parsed = JSON.parse(`{"version":1,"bases":{"__proto__":{"base":"x","createdAt":1}}}`);
    const out = coerceBases(parsed);
    expect(Object.keys(out)).toEqual([]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  test("past MAX_BASES the oldest go first", () => {
    const bases: Record<string, { base: string; createdAt: number }> = {};
    for (let n = 0; n < MAX_BASES + 3; n++) bases[`/w${n}`] = { base: "main", createdAt: n };
    const kept = coerceBases({ version: BASES_VERSION, bases });
    expect(Object.keys(kept)).toHaveLength(MAX_BASES);
    expect(kept["/w0"]).toBeUndefined();
    expect(kept["/w2"]).toBeUndefined();
    expect(kept["/w3"]).toBeDefined();
    expect(kept[`/w${MAX_BASES + 2}`]).toBeDefined();
  });
});

describe("memoryWorktreeBases", () => {
  test("remembers for the life of the process and writes no file", async () => {
    const store = memoryWorktreeBases();
    expect(store.get("/r/w")).toBeUndefined();
    await store.record("/r/w", { base: "main", createdAt: 1 });
    expect(store.get("/r/w")).toEqual({ base: "main", createdAt: 1 });
    expect(store.get("constructor")).toBeUndefined();
  });
});
