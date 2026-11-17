import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accountTest } from "./accounts-skip.ts";
import type { JsonObject } from "./json.ts";
import { memoryAddedIo } from "./launchers-added.ts";
import {
  AccountStore,
  accountsFileIo,
  ACCOUNTS_FILE,
  ACCOUNTS_VERSION,
  coerceAccountRow,
  formatAccountsFile,
  MAX_ACCOUNTS,
  parseAccountsText,
  type AccountRecord,
} from "./accounts-store.ts";

const ID = "6f1c2a4e-3b5d-4c7e-9f00-112233445566";

function row(over: Partial<AccountRecord> = {}): AccountRecord {
  return { id: ID, harness: "claude", label: "Work", kind: "shared", dir: "/home/op/.claude-work", addedAt: 1, device: "pixel", ...over };
}

/** A row as the file holds it. */
function onDisk(r: AccountRecord, over: JsonObject = {}): JsonObject {
  return { ...r, ...over };
}

function idN(n: number): string {
  return `6f1c2a4e-3b5d-4c7e-9f00-${String(n).padStart(12, "0")}`;
}

describe("coerceAccountRow: a row is checked again when it is read", () => {
  accountTest("a good row reads back", () => {
    expect(coerceAccountRow(onDisk(row()))).toEqual(row());
  });

  const bad: [string, JsonObject][] = [
    ["a bad id", { id: "x" }],
    ["an unknown harness", { harness: "hermes" }],
    ["shared for a harness that does not share", { harness: "codex", kind: "shared" }],
    ["a quote in the folder", { dir: "/home/op/it's" }],
    ["a newline in the folder", { dir: "/home/op/a\nb" }],
    ["a relative folder", { dir: "rel/x" }],
    ["a ~ folder", { dir: "~/.claude-work" }],
    ["an uncleaned folder", { dir: "/home/op/.claude-work/" }],
    ["a label with a control character", { label: "Wo\u0007rk" }],
    ["an untrimmed label", { label: " Work" }],
    ["no device", { device: "" }],
    ["a kind of default", { kind: "default" }],
  ];
  for (const [what, over] of bad) {
    test(`drops ${what}`, () => {
      expect(coerceAccountRow(onDisk(row(), over))).toBeNull();
    });
  }
});

describe("parseAccountsText", () => {
  test("no file is empty; a torn file or another version refuses writes", () => {
    expect(parseAccountsText(null)).toEqual([]);
    expect(parseAccountsText("{")).toBeNull();
    expect(parseAccountsText(JSON.stringify({ version: 2, rows: [] }))).toBeNull();
  });

  accountTest("a second row with the same folder or the same label without case is dropped", () => {
    const text = formatAccountsFile([row(), row({ id: idN(2), label: "WORK", dir: "/home/op/.claude-b" }), row({ id: idN(3), label: "B" })]);
    expect(parseAccountsText(text)?.map((r) => r.id)).toEqual([ID]);
  });
});

describe("AccountStore", () => {
  accountTest("add, replay, the refusals, the cap and remove", async () => {
    const io = memoryAddedIo();
    const store = new AccountStore(io, () => {});
    expect(await store.add(row())).toEqual({ ok: true, row: row(), replayed: false });
    expect(await store.add(row({ label: "Other" }))).toMatchObject({ ok: true, replayed: true });
    expect(await store.add(row({ id: idN(2), label: "work", dir: "/home/op/.claude-x" }))).toEqual({ ok: false, reason: "label_taken" });
    // The same label for another harness is fine.
    expect(await store.add(row({ id: idN(3), harness: "codex", kind: "own", dir: "/home/op/.codex-work" }))).toMatchObject({ ok: true });
    expect(await store.add(row({ id: idN(4), label: "X", dir: "/home/op/.claude-work" }))).toEqual({ ok: false, reason: "folder_taken" });
    for (let n = 10; (await store.list()).length < MAX_ACCOUNTS; n++) {
      expect(await store.add(row({ id: idN(n), label: `A${n}`, dir: `/home/op/.claude-${n}` }))).toMatchObject({ ok: true });
    }
    expect(await store.add(row({ id: idN(99), label: "Full", dir: "/home/op/.claude-full" }))).toEqual({ ok: false, reason: "full" });
    expect(await store.remove(ID)).toEqual(row());
    expect(await store.remove(ID)).toBeNull();
    expect(store.cached().some((r) => r.id === ID)).toBe(false);
  });

  test("a bad file refuses every write and is not written over", async () => {
    const io = memoryAddedIo("not json");
    const store = new AccountStore(io, () => {});
    expect(await store.list()).toEqual([]);
    expect(await store.add(row())).toEqual({ ok: false, reason: "unwritable" });
    expect(await store.remove(ID)).toBe("unwritable");
    expect(io.text).toBe("not json");
  });

  accountTest("a listener hears a change, also one made by hand on disk", async () => {
    const io = memoryAddedIo();
    const store = new AccountStore(io, () => {});
    let heard = 0;
    store.onChange(() => heard++);
    await store.add(row());
    expect(heard).toBe(1);
    await io.write(formatAccountsFile([]));
    await store.list();
    expect(heard).toBe(2);
  });

  describe("on disk", () => {
    let dir = "";
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "collie-accounts-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("one owner-only file, no temp file left, and the version on it", async () => {
      const store = new AccountStore(accountsFileIo(dir), () => {});
      await store.add(row());
      expect(await readdir(dir)).toEqual([ACCOUNTS_FILE]);
      if (process.platform !== "win32") expect((await stat(join(dir, ACCOUNTS_FILE))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(join(dir, ACCOUNTS_FILE), "utf8"))).toEqual({ version: ACCOUNTS_VERSION, rows: [row()] });
    });

    test("no add, no file", async () => {
      const store = new AccountStore(accountsFileIo(dir), () => {});
      expect(await store.list()).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});
