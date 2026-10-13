import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isPrivateFile, privateTestDir } from "../mux/durable/fixture.ts";
import { HOST } from "../host.ts";
import { parseLogRow, type DurableAsk, type DurableEvent, type LogRow } from "../mux/durable/protocol.ts";
import { DurableLogs, durableLogDir, GAP_NOTICE, gapItemId, HOST_MAX_BYTES, LOG_KEEP_ITEMS, LOG_MAX_BYTES, logFileName, PaneLog } from "./log.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-durable-log-"));
  dirs.push(dir);
  return privateTestDir(dir);
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const text = (id: string, body: string, kind: "user" | "reply" | "thinking" | "notice" = "reply"): DurableEvent => ({
  type: "item",
  item: { id, kind, text: body },
});

const ask = (id: string, revision = 1): DurableAsk => ({
  id,
  kind: "permission",
  toolCallId: `call-${id}`,
  revision,
  title: "write_note wants to write /tmp/x",
  itemId: "tool-1",
  options: [{ id: "allow", label: "Allow", effect: "allow" }],
});

/** The rows after the header line. */
async function rows(path: string): Promise<LogRow[]> {
  const body = await readFile(path, "utf8");
  return body.split("\n").flatMap((line) => {
    const row = parseLogRow(line);
    return row === null ? [] : [row];
  });
}

const kinds = (list: readonly LogRow[]): string[] => list.map((row) => row.k);

const itemIds = (list: readonly LogRow[]): string[] => list.flatMap((row) => (row.k === "item" ? [row.item.id] : []));

/** The generation id in the header line, or null. */
async function generation(path: string): Promise<string | null> {
  const first = (await readFile(path, "utf8")).split("\n", 1)[0] ?? "";
  return /^\{"k":"gen","at":"[^"]+","id":"([0-9a-f-]{36})"\}$/.exec(first)?.[1] ?? null;
}

async function newLog(options: { now?: () => number } = {}): Promise<{ log: PaneLog; path: string; dir: string }> {
  const dir = await tempDir();
  const path = join(dir, "durable", logFileName("conv-01"));
  return { log: new PaneLog(path, options.now), path, dir };
}

describe("where the log lives", () => {
  test("one file per pane under the state dir, named by a reversible encoding of the pane id", () => {
    expect(durableLogDir("/state")).toBe(join("/state", "durable"));
    expect(logFileName("conv-01")).toBe(`${Buffer.from("conv-01").toString("base64url")}.jsonl`);
    // No id can name a different folder: the name holds no separator and no dot segment.
    for (const id of ["../etc/passwd", "a:b", "..", "x".repeat(128)]) {
      const name = logFileName(id);
      expect(name).not.toContain("/");
      expect(name).not.toContain("..");
      expect(name.endsWith(".jsonl")).toBe(true);
    }
    expect(logFileName("a")).not.toBe(logFileName("b"));
  });

  test("a new log is a private file in a private folder, and a pane with no events yet still has one", async () => {
    const { log, path } = await newLog();
    await log.ensure();
    expect(isPrivateFile(path)).toBe(true);
    expect(isPrivateFile(dirname(path))).toBe(true);
    // Only the header, which names the file's generation.
    expect(await rows(path)).toEqual([]);
    expect(await generation(path)).toMatch(/^[0-9a-f-]{36}$/);
  });

  // POSIX only: a mode (0755, 0644) widened by hand and put back. NTFS has no such mode; its access list
  // is read by the test above.
  test.skipIf(HOST.platform === "win32")("a folder and a file that were there with wider modes are made 0700 and 0600 when opened", async () => {
    const dir = await tempDir();
    const folder = join(dir, "durable");
    const path = join(folder, logFileName("conv-01"));
    await mkdir(folder, { mode: 0o755 });
    await chmod(folder, 0o755);
    await writeFile(path, "", { mode: 0o644 });
    await chmod(path, 0o644);
    await new PaneLog(path).ensure();
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a rewrite starts a new generation, and a reopen of the same file keeps the one it has", async () => {
    const dir = await tempDir();
    const path = join(dir, logFileName("conv-01"));
    const log = new PaneLog(path, () => 0, { maxBytes: 2000, keepItems: 3 });
    await log.apply([text("i1", "one")]);
    const before = await generation(path);
    await new PaneLog(path).ensure();
    expect(await generation(path)).toBe(before);
    await log.apply(Array.from({ length: 10 }, (_, n) => text(`i${String(n + 2)}`, "t".repeat(300))));
    expect(await generation(path)).not.toBe(before);
  });
});

describe("append", () => {
  test("events become rows with a timestamp, in order", async () => {
    const { log, path } = await newLog({ now: () => Date.UTC(2026, 9, 12, 9, 30) });
    await log.apply([
      text("i1", "hello", "user"),
      { type: "state", state: "working" },
      text("i2", "hi"),
      { type: "ask", ask: ask("a1") },
      { type: "settled", inputId: "in1", requestId: "r1", status: "unanswered", reason: "aborted" },
    ]);
    const written = await rows(path);
    expect(kinds(written)).toEqual(["item", "state", "item", "ask", "settled"]);
    for (const row of written) expect(row.at).toBe("2026-10-12T09:30:00.000Z");
  });

  test("the same item appended twice is written once (idempotent on the item id)", async () => {
    const { log, path } = await newLog();
    expect(await log.apply([text("i1", "hello"), text("i1", "hello")])).toBe(1);
    expect(await log.apply([text("i1", "hello")])).toBe(0);
    expect(await rows(path)).toHaveLength(1);
  });

  test("a changed item is a new row for the same id: the latest version wins", async () => {
    const { log, path } = await newLog();
    await log.apply([
      { type: "item", item: { id: "t1", kind: "tool", tool: { kind: "other", name: "write_note", summary: "x" }, status: "running" } },
    ]);
    await log.apply([
      { type: "item", item: { id: "t1", kind: "tool", tool: { kind: "other", name: "write_note", summary: "x", output: "ok" }, status: "done" } },
    ]);
    const written = await rows(path);
    expect(written).toHaveLength(2);
    const latest = written[1];
    expect(latest?.k === "item" && latest.item.kind === "tool" && latest.item.status).toBe("done");
  });

  test("a state is written when it changes, a settled input once, an ask once per revision", async () => {
    const { log, path } = await newLog();
    await log.apply([
      { type: "state", state: "working" },
      { type: "state", state: "working" },
      { type: "state", state: "idle" },
      { type: "settled", inputId: "in1", status: "answered" },
      { type: "settled", inputId: "in1", status: "answered" },
      { type: "ask", ask: ask("a1", 1) },
      { type: "ask", ask: ask("a1", 1) },
      { type: "ask", ask: ask("a1", 2) },
      { type: "ask", ask: ask("a1", 1) },
    ]);
    expect(kinds(await rows(path))).toEqual(["state", "state", "settled", "ask", "ask"]);
  });

  test("an ask closed is written once, a close for an ask never seen is not, and a closed ask stays closed", async () => {
    const { log, path } = await newLog();
    await log.apply([
      { type: "ask", ask: ask("a1") },
      { type: "ask-closed", askId: "a1", by: "phone", waitedMs: 900 },
      { type: "ask-closed", askId: "a1", by: "phone" },
      { type: "ask-closed", askId: "ghost", by: "stopped" },
      { type: "ask", ask: ask("a1", 2) },
    ]);
    expect(kinds(await rows(path))).toEqual(["ask", "ask-closed"]);
  });

  test("a remove event removes nothing and writes nothing", async () => {
    const { log, path } = await newLog();
    await log.apply([text("i1", "keep me"), { type: "remove", id: "i1" }]);
    expect(await rows(path)).toHaveLength(1);
  });

  test("two applies at once keep their order", async () => {
    const { log, path } = await newLog();
    await Promise.all([log.apply([text("i1", "one")]), log.apply([text("i2", "two")]), log.apply([text("i3", "three")])]);
    expect(itemIds(await rows(path))).toEqual(["i1", "i2", "i3"]);
  });
});

describe("reset", () => {
  test("a reset view upserts its items, and an item it no longer lists stays in the log", async () => {
    const { log, path } = await newLog();
    await log.apply([text("old", "from before the trim"), text("i2", "two")]);
    await log.apply([{ type: "reset" }, text("i2", "two, edited"), text("i3", "three"), { type: "state", state: "idle" }, { type: "synced" }]);
    expect(itemIds(await rows(path))).toEqual(["old", "i2", "i2", "i3"]);
  });

  test("a synced reset closes the asks it did not list, and keeps the ones it did", async () => {
    const { log, path } = await newLog();
    await log.apply([{ type: "ask", ask: ask("before-restart") }, { type: "ask", ask: ask("still-open") }]);
    await log.apply([{ type: "reset" }, { type: "ask", ask: ask("still-open") }, { type: "synced" }]);
    const closed = (await rows(path)).flatMap((row) => (row.k === "ask-closed" ? [[row.askId, row.by]] : []));
    expect(closed).toEqual([["before-restart", "reset"]]);
  });

  test("a trimmed reset whose first item the log never saw writes one gap notice in front of it", async () => {
    const { log, path } = await newLog();
    await log.apply([{ type: "reset" }, text("i90", "ninety"), text("i91", "ninety-one"), { type: "synced" }], 89);
    const list = await rows(path);
    expect(itemIds(list)).toEqual([gapItemId("i90"), "i90", "i91"]);
    const notice = list.find((row) => row.k === "item" && row.item.id === gapItemId("i90"));
    expect(notice?.k === "item" ? notice.item : null).toEqual({ id: gapItemId("i90"), kind: "notice", text: GAP_NOTICE });
    // The same reset again writes no second marker, and nor does a reopened log.
    await log.apply([{ type: "reset" }, text("i90", "ninety"), { type: "synced" }], 89);
    expect(await new PaneLog(path).apply([{ type: "reset" }, text("i90", "ninety"), { type: "synced" }], 89)).toBe(0);
    expect(itemIds(await rows(path)).filter((id) => id.startsWith("gap-"))).toHaveLength(1);
  });

  test("no gap notice when nothing was trimmed, or when the log already holds the first item", async () => {
    const { log, path } = await newLog();
    await log.apply([{ type: "reset" }, text("i1", "one"), { type: "synced" }], 0);
    await log.apply([{ type: "reset" }, text("i1", "one"), text("i2", "two"), { type: "synced" }], 5);
    expect(itemIds(await rows(path))).toEqual(["i1", "i2"]);
  });

  test("a gap id is a valid wire id whatever the first item id is", () => {
    expect(gapItemId("x".repeat(128))).toMatch(/^gap-[0-9a-f]{32}$/);
    expect(gapItemId("a")).not.toBe(gapItemId("b"));
  });

  test("a reset cut off before synced closes nothing", async () => {
    const { log, path } = await newLog();
    await log.apply([{ type: "ask", ask: ask("a1") }]);
    await log.apply([{ type: "reset" }, text("i1", "one")]);
    expect(kinds(await rows(path))).not.toContain("ask-closed");
  });
});

describe("a reopened log", () => {
  test("a new instance on the same file keeps what was written and writes nothing it already holds", async () => {
    const { log, path } = await newLog();
    await log.apply([text("i1", "one"), { type: "state", state: "working" }, { type: "ask", ask: ask("a1") }]);

    const reopened = new PaneLog(path);
    expect(await reopened.apply([text("i1", "one"), { type: "state", state: "working" }, { type: "ask", ask: ask("a1") }])).toBe(0);
    expect(await reopened.apply([text("i2", "two")])).toBe(1);
    expect(kinds(await rows(path))).toEqual(["item", "state", "ask", "item"]);
  });

  test("a torn last line is left alone and the next row starts on a line of its own", async () => {
    const { log, path } = await newLog();
    await log.apply([text("i1", "one")]);
    await appendFile(path, '{"k":"item","at":"2026');
    const reopened = new PaneLog(path);
    await reopened.apply([text("i2", "two")]);
    // The torn fragment is one unreadable line; both whole rows around it are read.
    expect(itemIds(await rows(path))).toEqual(["i1", "i2"]);
    const lines = (await readFile(path, "utf8")).split("\n");
    expect(lines.filter((line) => line.startsWith('{"k":"item","at":"2026')).length).toBe(3);
  });

  test("the log outlives the object that wrote it and the pane it describes", async () => {
    const dir = await tempDir();
    const logs = new DurableLogs(join(dir, "durable"));
    await logs.apply("conv-01", [text("i1", "one")]);
    // The program closes the pane and the bridge restarts: nothing but the folder is left.
    const after = new DurableLogs(join(dir, "durable"));
    expect(await readdir(join(dir, "durable"))).toEqual([logFileName("conv-01")]);
    expect(await after.apply("conv-01", [text("i1", "one")])).toBe(0);
  });

  test("one log per pane: two panes never share a file", async () => {
    const dir = await tempDir();
    const logs = new DurableLogs(join(dir, "durable"));
    await logs.apply("conv-01", [text("i1", "one")]);
    await logs.apply("conv-02", [text("i1", "other pane, same item id")]);
    expect((await readdir(join(dir, "durable"))).toSorted()).toEqual([logFileName("conv-01"), logFileName("conv-02")].toSorted());
    expect(logs.forPane("conv-01")).toBe(logs.forPane("conv-01"));
  });
});

describe("size cap", () => {
  test("past the cap the file is rewritten with the newest items, each in its latest version, oldest first", async () => {
    const dir = await tempDir();
    const path = join(dir, logFileName("conv-01"));
    const log = new PaneLog(path, () => Date.UTC(2026, 9, 12), { maxBytes: 4000, keepItems: 5 });
    for (let n = 1; n <= 4; n += 1) await log.apply([text(`i${String(n)}`, `m${String(n)}`)]);
    // i2 is edited: its latest version is what the rewrite keeps, at its first place.
    await log.apply([text("i2", "m2 edited")]);
    expect(await rows(path)).toHaveLength(5);

    const pad = "x".repeat(300);
    await log.apply(Array.from({ length: 16 }, (_, n) => text(`i${String(n + 5)}`, `${pad}${String(n + 5)}`)));

    expect(itemIds(await rows(path))).toEqual(["i16", "i17", "i18", "i19", "i20"]);
    expect((await stat(path)).size).toBeLessThan(4000);
  });

  test("the rewrite keeps the open asks, the last state and the settled lines after its oldest item, and drops the rest", async () => {
    const dir = await tempDir();
    const path = join(dir, logFileName("conv-01"));
    const log = new PaneLog(path, () => 0, { maxBytes: 6000, keepItems: 3 });
    await log.apply([
      { type: "settled", inputId: "ancient", status: "unanswered", reason: "aborted" },
      text("i1", "one"),
      { type: "ask", ask: ask("closed-ask") },
      { type: "ask-closed", askId: "closed-ask", by: "phone" },
      { type: "ask", ask: ask("open-ask") },
      { type: "state", state: "working" },
      text("i2", "two"),
      { type: "settled", inputId: "recent", status: "unanswered", reason: "aborted" },
      { type: "state", state: "waiting" },
      text("i3", "three"),
      text("i4", "four"),
    ]);
    // One write that passes the cap, so the rewrite runs once, on exactly this file.
    const pad = "y".repeat(400);
    await log.apply(Array.from({ length: 16 }, (_, n) => text(`i${String(n + 5)}`, pad)));

    const kept = await rows(path);
    expect(kinds(kept)).not.toContain("settled");
    expect(itemIds(kept)).toEqual(["i18", "i19", "i20"]);
    expect(kept.flatMap((row) => (row.k === "ask" ? [row.ask.id] : []))).toEqual(["open-ask"]);
    expect(kept.flatMap((row) => (row.k === "state" ? [row.state] : []))).toEqual(["waiting"]);
  });

  test("a settled line after the oldest kept item survives the rewrite in its place", async () => {
    const dir = await tempDir();
    const path = join(dir, logFileName("conv-01"));
    const log = new PaneLog(path, () => 0, { maxBytes: 3000, keepItems: 3 });
    const pad = "z".repeat(800);
    await log.apply([
      text("a", pad),
      text("b", pad),
      text("c", "c"),
      { type: "settled", inputId: "stop-1", status: "unanswered", reason: "aborted" },
      text("d", pad),
      text("e", pad),
    ]);
    const kept = await rows(path);
    expect(kept.map((row) => (row.k === "item" ? row.item.id : row.k))).toEqual(["c", "settled", "d", "e"]);
  });

  test("an item keeps the time it first appeared across a rewrite", async () => {
    const dir = await tempDir();
    const path = join(dir, logFileName("conv-01"));
    let clock = Date.UTC(2026, 9, 12, 8);
    const log = new PaneLog(path, () => clock, { maxBytes: 2000, keepItems: 3 });
    await log.apply([text("first", "no ts of its own")]);
    clock = Date.UTC(2026, 9, 12, 9);
    // The edit is a second row for the same id; the rewrite keeps one, stamped with the first.
    await log.apply([text("first", "no ts of its own, edited")]);
    await log.apply([text("big", "b".repeat(800)), text("big", "b".repeat(801)), text("last", "l".repeat(400))]);
    const kept = await rows(path);
    expect(itemIds(kept)).toEqual(["first", "big", "last"]);
    const first = kept[0];
    expect(first?.at).toBe("2026-10-12T08:00:00.000Z");
    expect(first?.k === "item" && first.item.kind !== "tool" && first.item.text).toBe("no ts of its own, edited");
  });

  test("a rewrite that keeps huge items stops at three quarters of the cap, so the next one is far away", async () => {
    const dir = await tempDir();
    const path = join(dir, logFileName("conv-01"));
    const log = new PaneLog(path, () => 0, { maxBytes: 4000, keepItems: 10 });
    for (let n = 1; n <= 8; n += 1) await log.apply([text(`i${String(n)}`, "h".repeat(1200))]);
    expect((await stat(path)).size).toBeLessThanOrEqual(3000);
    expect((await rows(path)).length).toBeGreaterThanOrEqual(1);
  });

  test("the rewrite is whole: no temporary file is left, and a reopened log reads the rewritten file", async () => {
    const dir = await tempDir();
    const path = join(dir, logFileName("conv-01"));
    const log = new PaneLog(path, () => 0, { maxBytes: 2000, keepItems: 3 });
    for (let n = 1; n <= 10; n += 1) await log.apply([text(`i${String(n)}`, "t".repeat(300))]);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const reopened = new PaneLog(path, () => 0, { maxBytes: 2000, keepItems: 3 });
    expect(await reopened.apply([text("i10", "t".repeat(300))])).toBe(0);
  });

  test("at the real cap (8 MiB) a rewrite keeps the newest 2000 items", async () => {
    expect(LOG_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(LOG_KEEP_ITEMS).toBe(2000);
    const { log, path } = await newLog();
    const body = "r".repeat(1400);
    const events: DurableEvent[] = [];
    for (let n = 1; n <= 6500; n += 1) events.push(text(`item-${String(n).padStart(5, "0")}`, `${body}${String(n)}`));
    await log.apply(events.slice(0, 3000));
    expect((await stat(path)).size).toBeLessThan(LOG_MAX_BYTES);
    await log.apply(events.slice(3000));

    const ids = itemIds(await rows(path));
    expect(ids).toHaveLength(2000);
    expect(ids[0]).toBe("item-04501");
    expect(ids.at(-1)).toBe("item-06500");
    expect((await stat(path)).size).toBeLessThan(LOG_MAX_BYTES);
  });
});

describe("the machine's byte cap", () => {
  test("the cap is 256 MiB", () => {
    expect(HOST_MAX_BYTES).toBe(256 * 1024 * 1024);
  });

  test("past the cap, the conversations written longest ago are deleted first, never the one being written", async () => {
    const dir = await tempDir();
    const folder = join(dir, "durable");
    const logs = new DurableLogs(folder, () => Date.now(), { maxBytes: LOG_MAX_BYTES, keepItems: LOG_KEEP_ITEMS }, 3000);
    const big = (id: string) => [text(id, "x".repeat(900))];
    await logs.apply("oldest", big("a"));
    await logs.apply("middle", big("b"));
    // Make their write times plainly ordered.
    await utimes(join(folder, logFileName("oldest")), new Date(1_000_000), new Date(1_000_000));
    await utimes(join(folder, logFileName("middle")), new Date(2_000_000), new Date(2_000_000));
    await logs.apply("newest", big("c"));
    await logs.apply("newest", big("d"));
    const left = (await readdir(folder)).toSorted();
    expect(left).not.toContain(logFileName("oldest"));
    expect(left).toContain(logFileName("newest"));
    // A pane whose log was deleted writes a fresh one on its next event.
    await logs.apply("oldest", big("e"));
    expect(await readdir(folder)).toContain(logFileName("oldest"));
  });
});

describe("a log written by something else", () => {
  test("rows that are not rows are skipped when the log is read back", async () => {
    const { path } = await newLog();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        "not json",
        '{"k":"mystery","at":"x"}',
        '{"k":"item","at":"2026-10-12T00:00:00.000Z","item":{"id":"i1","kind":"reply","text":"one"}}',
        '{"k":"item","at":1,"item":{"id":"i2"}}',
        "[]",
      ].join("\n") + "\n",
    );
    const log = new PaneLog(path);
    // The one good row is known, so the same item is not written again.
    expect(await log.apply([text("i1", "one")])).toBe(0);
  });
});
