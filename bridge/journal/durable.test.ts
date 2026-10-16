import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableLogs, logFileName } from "../durable/log.ts";
import type { DurableAsk, DurableEvent } from "../mux/durable/protocol.ts";
import { chatParams, LiveWindows } from "./live.ts";
import { createDurableReducer, DECIDED_IN_PROGRAM_TEXT, durableJournal, parseDurableLog, STOPPED_TEXT, TIMED_OUT_TEXT } from "./durable.ts";
import { adapterFor, buildJournalRegistry, KNOWN_HARNESS_NAMES } from "./registry.ts";
import { describeUnknowns, parseWith, unknownCount } from "./reduce.ts";
import { TranscriptStore } from "./store.ts";
import type { AgentSessionRef, TranscriptEntry } from "./types.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-durable-journal-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const PANE = "conv-01";
const ref: AgentSessionRef = { kind: "id", value: PANE };

const text = (id: string, body: string, kind: "user" | "reply" | "thinking" | "notice", ts?: string): DurableEvent => ({
  type: "item",
  item: { id, kind, text: body, ts },
});

const tool = (id: string, status: "running" | "done" | "failed" | "denied", output?: string): DurableEvent => ({
  type: "item",
  item: { id, kind: "tool", tool: { kind: "other", name: "write_note", summary: "path=/tmp/notes.txt", output }, status },
});

const ask = (id: string): DurableAsk => ({
  id,
  kind: "permission",
  toolCallId: "call-1",
  revision: 1,
  title: "write_note wants to write /tmp/notes.txt",
  itemId: "t1",
  options: [{ id: "allow", label: "Allow", effect: "allow" }],
});

/** A state dir, the logs under it, and the adapter reading them. */
async function rig() {
  const state = await tempDir();
  const dir = join(state, "durable");
  const logs = new DurableLogs(dir, () => Date.UTC(2026, 9, 12, 9, 30));
  const adapter = durableJournal([dir]);
  const store = new TranscriptStore();
  const page = async (limit = 200) => {
    const read = await store.page(adapter, ref, { limit });
    if (read === null) throw new Error("no log");
    return read;
  };
  return { state, dir, logs, adapter, store, page };
}

/** The text of an entry's first part. */
function firstText(entry: TranscriptEntry | undefined): string | undefined {
  const part = entry?.parts[0];
  return part !== undefined && (part.kind === "text" || part.kind === "thinking") ? part.text : undefined;
}

describe("the durable journal adapter: chat shape", () => {
  test("each item kind is a turn Chat already draws, in the order the log holds them", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      text("u1", "write the summary", "user", "2026-10-12T09:00:00.000Z"),
      text("th1", "the user wants a file", "thinking"),
      text("n1", "context was compacted", "notice"),
      text("r1", "I will write it now.", "reply"),
    ]);
    const { entries, total, hasMore, fileTruncated } = await page();
    expect(total).toBe(4);
    expect(hasMore).toBe(false);
    expect(fileTruncated).toBe(false);
    expect(entries.map((entry) => [entry.uuid, entry.role, entry.parts[0]?.kind])).toEqual([
      ["u1", "user", "text"],
      ["th1", "assistant", "thinking"],
      ["n1", "note", "text"],
      ["r1", "assistant", "text"],
    ]);
    expect(firstText(entries[0])).toBe("write the summary");
    // The item's own ts wins; an item with none carries the moment the bridge logged it.
    expect(entries[0]?.ts).toBe("2026-10-12T09:00:00.000Z");
    expect(entries[1]?.ts).toBe("2026-10-12T09:30:00.000Z");
  });

  test("markdown, code and link items are assistant turns whose text Chat's markdown reader draws", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      { type: "item", item: { id: "m1", kind: "markdown", text: "# Triage\n\n- read\n- **write**" } },
      { type: "item", item: { id: "c1", kind: "code", lang: "ts", text: "const a = 1;" } },
      { type: "item", item: { id: "c2", kind: "code", text: "no language" } },
      { type: "item", item: { id: "l1", kind: "link", href: "https://colliepwa.dev/docs/", label: "The docs" } },
      { type: "item", item: { id: "l2", kind: "link", href: "https://colliepwa.dev/" } },
    ]);
    const { entries } = await page();
    expect(entries.map((entry) => [entry.uuid, entry.role, entry.parts[0]?.kind])).toEqual([
      ["m1", "assistant", "text"],
      ["c1", "assistant", "text"],
      ["c2", "assistant", "text"],
      ["l1", "assistant", "text"],
      ["l2", "assistant", "text"],
    ]);
    expect(firstText(entries[0])).toBe("# Triage\n\n- read\n- **write**");
    expect(firstText(entries[1])).toBe("```ts\nconst a = 1;\n```");
    expect(firstText(entries[2])).toBe("```\nno language\n```");
    expect(firstText(entries[3])).toBe("[The docs](https://colliepwa.dev/docs/)");
    expect(firstText(entries[4])).toBe("[https://colliepwa.dev/](https://colliepwa.dev/)");
  });

  test("a code line that looks like a fence cannot close the block early, and a long block is cut inside its fence", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      { type: "item", item: { id: "c1", kind: "code", lang: "md", text: "before\n```js\nnested\n```\n   ~~~\nafter" } },
      { type: "item", item: { id: "c2", kind: "code", text: "x".repeat(25_000) } },
    ]);
    const { entries } = await page();
    const lines = (firstText(entries[0]) ?? "").split("\n");
    // Only the opening and the closing lines are fence lines to the reader.
    expect(lines.filter((line) => /^\s*(```|~~~)/.test(line))).toEqual(["```md", "```"]);
    expect(lines).toContain("\u200b```js");
    const long = entries[1]?.parts[0];
    expect(long?.kind === "text" && long.truncated).toBe(true);
    expect(long?.kind === "text" && long.text.startsWith("```\n") && long.text.endsWith("\n```")).toBe(true);
  });

  test("a link label cannot reshape the link, and a target with parentheses stays one destination", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      { type: "item", item: { id: "l1", kind: "link", href: "https://en.wikipedia.org/wiki/Foo_(bar)", label: "a [b] c\nd" } },
    ]);
    expect(firstText((await page()).entries[0])).toBe("[a (b) c d](https://en.wikipedia.org/wiki/Foo_%28bar%29)");
  });

  test("a link row in a tampered log whose target is not https draws nothing", () => {
    const row = (href: string) => JSON.stringify({ k: "item", at: "2026-10-12T09:30:00.000Z", item: { id: "l1", kind: "link", href } });
    expect(parseDurableLog(row("javascript:alert(1)"))).toEqual([]);
    expect(parseDurableLog(row("http://example.com/"))).toEqual([]);
    expect(parseDurableLog(row("https://example.com/"))).toHaveLength(1);
  });

  test("a tool item is a tool part, and its status is its result: running none, done output, failed an error, denied a refusal", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [tool("t1", "running"), tool("t2", "done", "wrote 4 lines"), tool("t3", "failed", "EACCES"), tool("t4", "denied")]);
    const parts = (await page()).entries.map((entry) => entry.parts[0]);
    expect(parts.map((part) => part?.kind)).toEqual(["tool", "tool", "tool", "tool"]);
    const [running, done, failed, denied] = parts.map((part) => (part?.kind === "tool" ? part : undefined));
    expect(running).toMatchObject({ name: "write_note", summary: "path=/tmp/notes.txt", id: "t1", call: { kind: "other", name: "write_note" } });
    expect(running?.result).toBeUndefined();
    expect(done?.result).toEqual({ text: "wrote 4 lines" });
    expect(failed?.result).toEqual({ text: "EACCES", isError: true });
    expect(denied?.result).toEqual({ text: "", denied: true });
  });

  test("an item sent again with new content is one turn at its first place, in its latest version", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [text("u1", "go", "user"), tool("t1", "running"), text("r1", "working on it", "reply")]);
    await logs.apply(PANE, [tool("t1", "done", "ok"), text("r1", "all done", "reply")]);
    const { entries } = await page();
    expect(entries.map((entry) => entry.uuid)).toEqual(["u1", "t1", "r1"]);
    const part = entries[1]?.parts[0];
    expect(part?.kind === "tool" && part.result).toEqual({ text: "ok" });
    expect(firstText(entries[2])).toBe("all done");
  });

  test("an item without a ts of its own keeps the moment it first appeared when it changes", () => {
    const first = '{"k":"item","at":"2026-10-12T08:00:00.000Z","item":{"id":"r1","kind":"reply","text":"one"}}';
    const second = '{"k":"item","at":"2026-10-12T09:00:00.000Z","item":{"id":"r1","kind":"reply","text":"two"}}';
    const [entry] = parseDurableLog(`${first}\n${second}\n`);
    expect(entry?.ts).toBe("2026-10-12T08:00:00.000Z");
    expect(firstText(entry)).toBe("two");
  });

  test("an open ask, an ask closed and a state change draw nothing in Chat", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      text("u1", "go", "user"),
      { type: "state", state: "working" },
      tool("t1", "running"),
      { type: "ask", ask: ask("a1") },
      { type: "ask-closed", askId: "a1", by: "phone" },
      { type: "state", state: "idle" },
    ]);
    expect((await page()).entries.map((entry) => entry.uuid)).toEqual(["u1", "t1"]);
  });

  test("a question nobody tapped leaves one muted line: timed out or decided in the program, with its title", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      text("u1", "go", "user"),
      { type: "ask", ask: ask("a1") },
      { type: "ask-closed", askId: "a1", by: "timeout" },
      { type: "ask", ask: ask("a2") },
      { type: "ask-closed", askId: "a2", by: "program" },
      { type: "ask", ask: ask("a3") },
      { type: "ask-closed", askId: "a3", by: "phone" },
      { type: "ask", ask: ask("a4") },
      { type: "ask-closed", askId: "a4", by: "stopped" },
    ]);
    const entries = (await page()).entries;
    // The phone's own tap has its card, and a stop is the person's act: neither draws a line.
    expect(entries.map((entry) => [entry.uuid, entry.role])).toEqual([
      ["u1", "user"],
      ["ask-closed:a1", "note"],
      ["ask-closed:a2", "note"],
    ]);
    expect(firstText(entries[1])).toBe("Timed out before an answer: write_note wants to write /tmp/notes.txt");
    expect(firstText(entries[2])).toBe("Decided in the durable agent: write_note wants to write /tmp/notes.txt");
  });

  test("an older ask-closed row without a title draws the words alone, and the same row twice draws once", () => {
    const row = (askId: string, by: string) => JSON.stringify({ k: "ask-closed", at: "2026-10-15T09:00:00.000Z", askId, by });
    const entries = parseDurableLog(`${row("a1", "timeout")}\n${row("a2", "program")}\n${row("a1", "timeout")}\n${row("a3", "reset")}\n`);
    expect(entries.map((entry) => firstText(entry))).toEqual([TIMED_OUT_TEXT, DECIDED_IN_PROGRAM_TEXT]);
    expect(entries[0]?.ts).toBe("2026-10-15T09:00:00.000Z");
  });
});

describe("a reply that grows (WIRE.md 7.15): partial and replace", () => {
  const grown = (id: string, body: string, partial = true): DurableEvent => ({
    type: "item",
    item: partial ? { id, kind: "reply", text: body, partial: true } : { id, kind: "reply", text: body },
  });

  test("a partial reply is a turn with partial set, and the final version replaces it in place: one turn, no flag", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [text("u1", "go", "user"), grown("r1", "Hel")]);
    let read = await page();
    expect(read.entries.map((entry) => [entry.uuid, entry.partial])).toEqual([["u1", undefined], ["r1", true]]);
    await logs.apply(PANE, [grown("r1", "Hello, wor")]);
    await logs.apply(PANE, [grown("r1", "Hello, world", false)]);
    read = await page();
    // ONE turn for the reply however many versions were written: the failure to look for is a second row.
    expect(read.entries.map((entry) => entry.uuid)).toEqual(["u1", "r1"]);
    expect(firstText(read.entries[1])).toBe("Hello, world");
    expect(read.entries[1]).not.toHaveProperty("partial");
  });

  test("thinking, markdown and notice carry partial too, and code and link never do", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      { type: "item", item: { id: "t", kind: "thinking", text: "hm", partial: true } },
      { type: "item", item: { id: "m", kind: "markdown", text: "# A", partial: true } },
      { type: "item", item: { id: "n", kind: "notice", text: "wait", partial: true } },
    ]);
    const { entries } = await page();
    expect(entries.map((entry) => entry.partial)).toEqual([true, true, true]);
    const code = parseDurableLog('{"k":"item","at":"2026-10-12T08:00:00.000Z","item":{"id":"c","kind":"code","text":"x","partial":true}}\n');
    expect(code[0]).not.toHaveProperty("partial");
  });

  test("the live window reports a growing reply as a change at the seq it already had, and the end clears the flag", async () => {
    const { logs, adapter, store } = await rig();
    let nowMs = 1_000_000;
    const live = new LiveWindows(store, () => nowMs);
    await logs.apply(PANE, [text("u1", "go", "user"), grown("r1", "Hel")]);
    const params = chatParams(new URL("http://x/api/pane/p/chat"));
    const first = await live.window(adapter, ref, params);
    expect(first?.upserts.map((entry) => [entry.uuid, entry.partial])).toEqual([["u1", undefined], ["r1", true]]);
    const seq = first?.upserts[1]?.seq;

    nowMs += 1000;
    await logs.apply(PANE, [grown("r1", "Hello, wor")]);
    const mid = await live.window(adapter, ref, { ...params, after: { gen: first?.gen ?? 0, rev: first?.rev ?? 0 } });
    expect(mid?.upserts.map((entry) => [entry.uuid, entry.seq, entry.partial])).toEqual([["r1", seq, true]]);

    nowMs += 1000;
    await logs.apply(PANE, [grown("r1", "Hello, world", false)]);
    const last = await live.window(adapter, ref, { ...params, after: { gen: mid?.gen ?? 0, rev: mid?.rev ?? 0 } });
    expect(last?.upserts).toHaveLength(1);
    expect(last?.upserts[0]).toMatchObject({ uuid: "r1", seq });
    expect(last?.upserts[0]).not.toHaveProperty("partial");
    expect(firstText(last?.upserts[0])).toBe("Hello, world");
  });

  test("a user line carries its request id, and gains it in place when it arrives later", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [text("u1", "hi", "user")]);
    expect((await page()).entries[0]).not.toHaveProperty("requestId");
    await logs.apply(PANE, [{ type: "item", item: { id: "u1", kind: "user", text: "hi", requestId: "req-1" } }]);
    const { entries } = await page();
    expect(entries.map((entry) => [entry.uuid, entry.requestId])).toEqual([["u1", "req-1"]]);
  });

  test("a partial flag that is not exactly true in a tampered log reads as a finished text", () => {
    const row = (flag: string) => `{"k":"item","at":"2026-10-12T08:00:00.000Z","item":{"id":"r1","kind":"reply","text":"x","partial":${flag}}}\n`;
    expect(parseDurableLog(row("true"))[0]?.partial).toBe(true);
    for (const flag of ['"yes"', "1", "false", "null"]) expect(parseDurableLog(row(flag))[0]).not.toHaveProperty("partial");
  });
});

describe("a stop", () => {
  test("an input that settled unanswered with the reason aborted is a short note, \"stopped\", where it happened", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      text("u1", "write a long essay", "user"),
      text("r1", "Once upon", "reply"),
      { type: "settled", inputId: "in-1", requestId: "req-1", status: "unanswered", reason: "aborted" },
      text("u2", "never mind", "user"),
    ]);
    const { entries } = await page();
    expect(entries.map((entry) => entry.uuid)).toEqual(["u1", "r1", "settled:in-1", "u2"]);
    expect(entries[2]).toMatchObject({ role: "note", parts: [{ kind: "text", text: STOPPED_TEXT }] });
    expect(STOPPED_TEXT).toBe("stopped");
  });

  test("any other settled event draws nothing", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [
      text("u1", "go", "user"),
      { type: "settled", inputId: "in-1", status: "answered" },
      { type: "settled", inputId: "in-2", status: "unanswered", reason: "superseded" },
      { type: "settled", inputId: "in-3", status: "unanswered" },
    ]);
    expect((await page()).entries.map((entry) => entry.uuid)).toEqual(["u1"]);
  });

  test("a stop is drawn once however many times the log says it", () => {
    const row = '{"k":"settled","at":"2026-10-12T09:00:00.000Z","inputId":"in-1","status":"unanswered","reason":"aborted"}';
    expect(parseDurableLog(`${row}\n${row}\n`)).toHaveLength(1);
  });
});

describe("a closed pane", () => {
  test("the log is still found and read after the program closed the pane and the bridge restarted", async () => {
    const { dir, logs } = await rig();
    await logs.apply(PANE, [text("u1", "hello", "user"), text("r1", "hi", "reply")]);
    // Nothing of the pane is left but its file: a new adapter and a new store read it by the id alone.
    const later = durableJournal([dir]);
    const read = await new TranscriptStore().page(later, ref, { limit: 50 });
    expect(read?.entries.map((entry) => entry.uuid)).toEqual(["u1", "r1"]);
  });

  test("a pane the program trimmed from its view keeps the items the program no longer lists", async () => {
    const { logs, page } = await rig();
    await logs.apply(PANE, [text("old", "from long ago", "reply"), text("i2", "two", "reply")]);
    await logs.apply(PANE, [{ type: "reset" }, text("i2", "two", "reply"), text("i3", "three", "reply"), { type: "synced" }]);
    expect((await page()).entries.map((entry) => entry.uuid)).toEqual(["old", "i2", "i3"]);
  });
});

describe("the live window", () => {
  test("a first read holds the log, and an item that changes is reported in place at its seq", async () => {
    const { logs, adapter, store } = await rig();
    const live = new LiveWindows(store, () => nowMs);
    let nowMs = 1_000_000;
    await logs.apply(PANE, [text("u1", "go", "user"), tool("t1", "running")]);
    const params = chatParams(new URL("http://x/api/pane/p/chat"));

    const first = await live.window(adapter, ref, params);
    expect(first?.upserts.map((entry) => entry.uuid)).toEqual(["u1", "t1"]);
    const seq = first?.upserts[1]?.seq;

    nowMs += 1000;
    await logs.apply(PANE, [tool("t1", "done", "ok"), text("r1", "done", "reply")]);
    const after = { gen: first?.gen ?? 0, rev: first?.rev ?? 0 };
    const next = await live.window(adapter, ref, { ...params, after });
    expect(next?.gen).toBe(first?.gen);
    expect(next?.upserts.map((entry) => entry.uuid)).toEqual(["t1", "r1"]);
    expect(next?.upserts[0]?.seq).toBe(seq);
    const part = next?.upserts[0]?.parts[0];
    expect(part?.kind === "tool" && part.result).toEqual({ text: "ok" });
  });

  test("a rewritten log that shrank resets the window rather than extending it", async () => {
    const { dir, adapter, store } = await rig();
    const small = new DurableLogs(dir, () => 0, { maxBytes: 2000, keepItems: 2 });
    let nowMs = 1_000_000;
    const live = new LiveWindows(store, () => nowMs);
    await small.apply(PANE, [text("a", "a".repeat(300), "reply"), text("b", "b".repeat(300), "reply")]);
    const params = chatParams(new URL("http://x/api/pane/p/chat"));
    const first = await live.window(adapter, ref, params);
    expect(first?.upserts).toHaveLength(2);

    nowMs += 1000;
    await small.apply(PANE, Array.from({ length: 8 }, (_, n) => text(`c${String(n)}`, "c".repeat(300), "reply")));
    const next = await live.window(adapter, ref, { ...params, after: { gen: first?.gen ?? 0, rev: first?.rev ?? 0 } });
    expect(next?.gen).not.toBe(first?.gen);
    expect(next?.upserts.map((entry) => entry.uuid)).toEqual(["c6", "c7"]);
  });
});

describe("finding the log", () => {
  test("only an id ref that passes the wire's id rule resolves, and only to a file under the root", async () => {
    const { dir, logs, adapter } = await rig();
    await logs.apply(PANE, [text("u1", "hi", "user")]);
    expect(await adapter.source.resolve(ref)).toBe(join(await realDir(dir), logFileName(PANE)));
    // A path ref (M55: the adapter names one program's log file) resolves inside the root, and only a log.
    expect(await adapter.source.resolve({ kind: "path", value: join(dir, logFileName(PANE)) })).toBe(join(await realDir(dir), logFileName(PANE)));
    expect(await adapter.source.resolve({ kind: "path", value: join(dir, "..", "elsewhere.jsonl") })).toBeNull();
    expect(await adapter.source.resolve({ kind: "path", value: join(dir, `${logFileName(PANE)}.cursor.json`) })).toBeNull();
    for (const value of ["../conv-01", "a/b", "has space", "", "x".repeat(200), "conv-99"]) {
      expect(await adapter.source.resolve({ kind: "id", value })).toBeNull();
    }
  });

  test("a log symlinked out of the root is not read", async () => {
    const { dir, adapter } = await rig();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.jsonl"), '{"k":"item","at":"x","item":{"id":"s","kind":"reply","text":"secret"}}\n');
    await mkdir(dir, { recursive: true });
    await symlink(join(outside, "secret.jsonl"), join(dir, logFileName("linked")));
    expect(await adapter.source.resolve({ kind: "id", value: "linked" })).toBeNull();
  });
});

async function realDir(dir: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(dir);
}

describe("the reducer", () => {
  test("junk lines add and change nothing", () => {
    const reducer = createDurableReducer();
    for (const line of ["", "   ", "not json", "42", "null", "[]", '{"k":"item"}', '{"k":"item","item":{"id":"x"}}', '{"k":"item","item":{"id":"","kind":"reply","text":"t"}}']) {
      expect(reducer.push(line)).toEqual({ added: [], changed: [] });
    }
  });

  test("parse is the reducer: one turn per item, in order of first appearance, with the latest content", () => {
    const rows = [
      '{"k":"item","at":"a","item":{"id":"x","kind":"reply","text":"v1"}}',
      '{"k":"item","at":"a","item":{"id":"y","kind":"user","text":"why"}}',
      '{"k":"item","at":"a","item":{"id":"x","kind":"reply","text":"second"}}',
    ].join("\n");
    const entries = parseDurableLog(rows);
    expect(entries.map((entry) => [entry.uuid, firstText(entry)])).toEqual([
      ["x", "second"],
      ["y", "why"],
    ]);
    expect(parseWith(createDurableReducer(), rows)).toEqual(entries);
  });

  test("a change to a known item is reported as changed, not added", () => {
    const reducer = createDurableReducer();
    expect(reducer.push('{"k":"item","at":"a","item":{"id":"x","kind":"reply","text":"v1"}}').added).toHaveLength(1);
    const again = reducer.push('{"k":"item","at":"a","item":{"id":"x","kind":"reply","text":"second"}}');
    expect(again.added).toEqual([]);
    expect(again.changed).toEqual(["x"]);
  });

  test("row kinds this adapter knows are not drift, and a kind it has never met is counted by name", () => {
    const reducer = createDurableReducer();
    for (const k of ["item", "ask", "ask-closed", "state", "settled"]) reducer.push(JSON.stringify({ k, at: "a" }));
    expect(unknownCount(reducer.unknowns())).toBe(0);
    reducer.push('{"k":"hologram","at":"a"}');
    expect(describeUnknowns(reducer.unknowns())).toBe("row types hologram (1)");
    expect(reducer.queued()).toEqual([]);
  });
});

describe("the journal registry", () => {
  const roots = { claude: [], codex: [], pi: [], opencode: [], grok: [], hermes: [], muse: [], openclaw: [] };

  test("durable is registered when a log root is named, under the agent name a durable pane reports", () => {
    const registry = buildJournalRegistry({ ...roots, durable: ["/state/durable"] });
    expect(adapterFor(registry, "durable")?.agent).toBe("durable");
  });

  test("without a log root there is no durable adapter, and it is never a harness name", () => {
    expect(adapterFor(buildJournalRegistry(roots), "durable")).toBeUndefined();
    expect(KNOWN_HARNESS_NAMES).not.toContain("durable");
  });
});
