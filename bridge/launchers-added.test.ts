import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import {
  ADDED_FILE,
  ADDED_VERSION,
  AddedLauncherStore,
  addedFileIo,
  coerceAddedFile,
  coerceAddedRow,
  formatAddedFile,
  MAX_ADDED,
  memoryAddedIo,
  type AddedLauncher,
} from "./launchers-added.ts";

const dirs: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-added-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

let n = 0;
function uuid(): string {
  n++;
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function textRow(over: Partial<AddedLauncher> = {}): AddedLauncher {
  return {
    id: uuid(),
    kind: "command",
    source: "text",
    command: `htop -d ${n}`,
    label: "htop",
    noPrompts: false,
    device: "phone",
    via: "local",
    at: 1,
    ...over,
  };
}

function recipeRow(over: Partial<AddedLauncher> = {}): AddedLauncher {
  return {
    id: uuid(),
    kind: "agent",
    harness: "claude",
    source: "recipe",
    options: ["skip"],
    command: "claude --dangerously-skip-permissions",
    label: "Claude Code, no prompts",
    noPrompts: true,
    device: "phone",
    via: "local",
    at: 1,
    ...over,
  };
}

const quiet = () => {};

/** A value as it comes off disk: through JSON, so a typed row is read the way the store reads it. */
function j<T>(value: T): JsonValue {
  // SAFETY: `JSON.parse` of `JSON.stringify` output IS a JsonValue by construction.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

describe("coerceAddedRow: every row is checked again at read", () => {
  test("a good row of each source reads back as itself", () => {
    const a = textRow();
    const b = recipeRow();
    expect(coerceAddedRow(j(a))).toEqual(a);
    expect(coerceAddedRow(j(b))).toEqual(b);
  });

  test("a recipe row whose line no longer equals its rebuild is dropped", () => {
    expect(coerceAddedRow(j(recipeRow({ command: "claude --yolo" })))).toBeNull();
    expect(coerceAddedRow(j(recipeRow({ options: ["gone"] })))).toBeNull();
    // Its saved no-prompts must agree with the chips.
    expect(coerceAddedRow(j(recipeRow({ noPrompts: false })))).toBeNull();
  });

  test("a free line with a known flag can never be stored as prompting", () => {
    expect(coerceAddedRow(j(textRow({ command: "codex --yolo", noPrompts: false })))).toBeNull();
    expect(coerceAddedRow(j(textRow({ command: "codex --yolo", noPrompts: true })))).not.toBeNull();
  });

  test("the character rule, on the line and on the label", () => {
    expect(coerceAddedRow(j(textRow({ command: "htop\nrm -rf ~" })))).toBeNull();
    expect(coerceAddedRow(j(textRow({ command: "ls \u202Etxt" })))).toBeNull();
    expect(coerceAddedRow(j(textRow({ label: "a\u2028b" })))).toBeNull();
    expect(coerceAddedRow(j(textRow({ command: " htop" })))).toBeNull(); // not the trimmed form it was saved as
    expect(coerceAddedRow(j(textRow({ command: "x".repeat(201) })))).toBeNull();
  });

  test("shape errors drop the row", () => {
    expect(coerceAddedRow(j(textRow({ id: "nope" })))).toBeNull();
    expect(coerceAddedRow(j({ ...textRow(), kind: "script" }))).toBeNull();
    expect(coerceAddedRow(j(textRow({ device: "" })))).toBeNull();
    expect(coerceAddedRow(j({ ...textRow(), via: "elsewhere" }))).toBeNull();
    expect(coerceAddedRow(j(textRow({ kind: "agent" })))).toBeNull(); // an agent row names its harness
    expect(coerceAddedRow(j(textRow({ kind: "agent", harness: "bash" })))).toBeNull();
    expect(coerceAddedRow(j(textRow({ harness: "claude" })))).toBeNull(); // a command row names none
  });
});

describe("coerceAddedFile", () => {
  test("a foreign version or a non-object is not ours to write over", () => {
    expect(coerceAddedFile(j({ version: ADDED_VERSION + 1, rows: [] }))).toBeNull();
    expect(coerceAddedFile(j([]))).toBeNull();
    expect(coerceAddedFile(j({ version: ADDED_VERSION }))).toBeNull();
  });

  test("a bad row costs only itself; a repeated id or line keeps the first", () => {
    const a = textRow();
    const twin = { ...textRow(), command: a.command };
    expect(coerceAddedFile(j({ version: ADDED_VERSION, rows: [a, { junk: true }, twin, { ...a, label: "again" }] }))).toEqual([a]);
  });

  test("the cap holds on read", () => {
    const rows = Array.from({ length: MAX_ADDED + 5 }, () => textRow());
    expect(coerceAddedFile(j({ version: ADDED_VERSION, rows }))).toHaveLength(MAX_ADDED);
  });
});

describe("AddedLauncherStore on a real state dir", () => {
  test("nothing is written until the first add; the add is atomic and owner-only", async () => {
    const dir = await stateDir();
    const store = new AddedLauncherStore(addedFileIo(dir), quiet);
    expect(await store.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    const row = textRow();
    expect(await store.add(row)).toEqual({ ok: true, row, replayed: false });
    expect(await readdir(dir)).toEqual([ADDED_FILE]); // no temp file left behind
    expect((await stat(join(dir, ADDED_FILE))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, ADDED_FILE), "utf8"))).toEqual({ version: ADDED_VERSION, rows: [row] });
  });

  test("the same id answers the stored row and writes nothing", async () => {
    const io = memoryAddedIo();
    const store = new AddedLauncherStore(io, quiet);
    const row = textRow();
    await store.add(row);
    expect(await store.add({ ...row, command: "something else", label: "other" })).toEqual({ ok: true, row, replayed: true });
    expect(io.writes).toBe(1);
  });

  test("two adds of one id at once write one row", async () => {
    const io = memoryAddedIo();
    const store = new AddedLauncherStore(io, quiet);
    const row = textRow();
    const [a, b] = await Promise.all([store.add(row), store.add(row)]);
    expect([a, b].map((o) => o.ok && o.replayed)).toEqual([false, true]);
    expect(await store.list()).toEqual([row]);
  });

  test("a line already added, and the cap, are refusals", async () => {
    const store = new AddedLauncherStore(memoryAddedIo(), quiet);
    const first = textRow();
    await store.add(first);
    expect(await store.add(textRow({ command: first.command }))).toEqual({ ok: false, reason: "duplicate" });
    for (let i = 1; i < MAX_ADDED; i++) await store.add(textRow());
    expect(await store.list()).toHaveLength(MAX_ADDED);
    expect(await store.add(textRow())).toEqual({ ok: false, reason: "full" });
  });

  test("a bad file reads as empty and refuses every write", async () => {
    for (const text of ["{not json", JSON.stringify({ version: 99, rows: [] }), "[]"]) {
      const io = memoryAddedIo(text);
      const store = new AddedLauncherStore(io, quiet);
      expect(await store.list()).toEqual([]);
      expect(await store.add(textRow())).toEqual({ ok: false, reason: "unwritable" });
      expect(await store.remove(uuid())).toBe("unwritable");
      expect(io.text).toBe(text); // never written over
    }
  });

  test("rename and remove", async () => {
    const store = new AddedLauncherStore(memoryAddedIo(), quiet);
    const row = recipeRow();
    await store.add(row);
    expect(await store.rename(row.id, "Danger")).toEqual({ ...row, label: "Danger" });
    expect(await store.rename(uuid(), "x")).toBeNull();
    expect(await store.remove(uuid())).toBeNull();
    expect(await store.remove(row.id)).toEqual({ ...row, label: "Danger" });
    expect(await store.list()).toEqual([]);
  });

  test("removeWhere drops only what it picks", async () => {
    const store = new AddedLauncherStore(memoryAddedIo(), quiet);
    const mine = textRow({ device: "lost-phone" });
    const crew = textRow({ device: "lost-phone", via: "crew" });
    const other = textRow({ device: "tablet" });
    for (const r of [mine, crew, other]) await store.add(r);
    expect(await store.removeWhere((r) => r.device === "lost-phone" && r.via === "local")).toEqual([mine]);
    expect(await store.list()).toEqual([crew, other]);
  });

  test("a change made by another process is seen on the next read", async () => {
    const dir = await stateDir();
    const store = new AddedLauncherStore(addedFileIo(dir), quiet);
    const row = textRow();
    await store.add(row);
    expect(await store.list()).toEqual([row]);
    // `collie devices revoke` rewrites the file; a later mtime is the signal.
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(join(dir, ADDED_FILE), formatAddedFile([]), { mode: 0o600 });
    expect(await store.list()).toEqual([]);
  });
});
