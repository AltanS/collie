import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
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
    expect(store.list()).toEqual({ rev: 0, open: [], closed: [] });
    expect(existsSync(dir)).toBe(false);
  });

  test.skipIf(HOST.platform === "win32")("a write is atomic and owner-only: a 0700 folder, a 0600 file, no temp file left", () => {
    const dir = hillDir(stateDir());
    const store = new HillStore(dir, () => 5000);
    expect(store.put(decision("dc_aaaaaaaaaaa1"))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, DECISIONS_FILE)).mode & 0o777).toBe(0o600);
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

  test("an entry that fails its reader is dropped, the good ones are kept", () => {
    const dir = hillDir(stateDir());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ v: 1, decisions: [decision("dc_aaaaaaaaaaa1"), { v: 1, id: "dc_bad" }, 7] }));
    const store = new HillStore(dir, () => 1);
    expect(store.all().map((held) => held.id)).toEqual(["dc_aaaaaaaaaaa1"]);
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
