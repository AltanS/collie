import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKiroReducer, kiroJournal, parseKiroTranscript } from "./kiro.ts";
import { KIRO_BUCKET, KIRO_FIXTURES, kiroSandbox, readKiroFixture, removeKiroSandboxes, writeKiroSession } from "./kiro-fixtures.ts";
import { parseWith, unknownCount } from "./reduce.ts";
import { MAX_RESULT_CHARS, MAX_TEXT_CHARS } from "./text.ts";
import type { JsonObject } from "../json.ts";
import type { TranscriptEntry, TranscriptPart, TranscriptSource } from "./types.ts";

const ID = "sess_11111111-2222-4333-8444-555555555555";
const OTHER_ID = "sess_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TS = "2026-10-01T12:00:00.000Z";
const adapter = { parse: parseKiroTranscript, reducer: createKiroReducer };

// Saved-session rows use this envelope; the payload is not an ACP streaming chunk.
function row(id: string, payload: JsonObject): string {
  return JSON.stringify({ id, timestamp: TS, payload });
}

function say(id: string, content: string): string {
  return row(id, { type: "assistant", operationType: "Say", content, executionId: "exec-1" });
}

function call(id: string, status = "completed", extra: JsonObject = {}): string {
  return row(`${id}-call`, { type: "tool_call", toolCallId: id, toolName: "execute_bash", kind: "execute", args: { command: "printf sample", description: "Print sample text" }, status, executionId: "exec-1", ...extra });
}

function result(id: string, content: string, extra: JsonObject = {}): string {
  return row(`${id}-result`, { type: "tool_result", toolCallId: id, content, success: true, executionId: "exec-1", ...extra });
}

function tools(entries: readonly TranscriptEntry[]): Extract<TranscriptPart, { kind: "tool" }>[] {
  return entries.flatMap((entry) => entry.parts.filter((part): part is Extract<TranscriptPart, { kind: "tool" }> => part.kind === "tool"));
}

function texts(entries: readonly TranscriptEntry[], role: TranscriptEntry["role"]): string[] {
  return entries.filter((entry) => entry.role === role).flatMap((entry) => entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])));
}

afterEach(removeKiroSandboxes);

/** A Kiro journal over `roots`. */
function journal(roots: readonly string[]): ReturnType<typeof kiroJournal> {
  return kiroJournal(roots);
}

async function sourceFixture(content: string): Promise<{ source: TranscriptSource; path: string; root: string; base: string }> {
  const base = await kiroSandbox();
  const root = join(base, "sessions");
  const path = await writeKiroSession(root, content, ID);
  const source = journal([root]).source;
  expect(await source.resolve({ kind: "id", value: ID })).toBe(path);
  return { source, path, root, base };
}

// fixtures/kiro holds sessions saved by kiro-cli 2.32.0 (fixtures/kiro/README.md).
describe("a saved Kiro session", () => {
  test("reads as the conversation the TUI showed, prompts and replies in order", async () => {
    // Given: a session with plain replies, a steered turn and a /compact.
    const entries = adapter.parse(await readKiroFixture("messages.jsonl"));
    // When: its user and assistant speech is listed.
    const said = texts(entries, "user");
    // Then: every prompt and the steering message are there once, and the steered reply shows the TUI's note.
    expect(said.map((text) => text.split(" ").slice(0, 3).join(" "))).toEqual(["Reply with exactly", "Run the shell", "Create a new", "Read the file", "In notes.txt, replace", "Write the numbers", "lab steer probe:", "Reply with exactly"]);
    expect(texts(entries, "assistant")).toContain("lab_plain_answer");
    expect(texts(entries, "assistant").some((text) => text.endsWith("Adjusted output to stop at 20 instead of 150 per user guidance") && !text.includes("[STEERING"))).toBe(true);
  });

  test("never shows what Kiro wrote for the model: context notes, the system prompt or the steering hand-off", async () => {
    // Given: the same session, which holds agent notes, a session_start and a synthetic user row.
    const entries = adapter.parse(await readKiroFixture("messages.jsonl"));
    // When: every text part is collected.
    const all = entries.flatMap((entry) => entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])));
    // Then: none of those bodies appears.
    expect(all.some((text) => text.includes("shortened for the fixture"))).toBe(false);
    expect(all.some((text) => text.includes("[LIVE STEERING"))).toBe(false);
  });

  test("tool cards carry the call's outcome: allowed, denied or failed", async () => {
    // Given: the session's shell call, denied write, failed read and allowed edit.
    const cards = tools(adapter.parse(await readKiroFixture("messages.jsonl")));
    // When: each card is found by its tool.
    const byName = (name: string) => cards.filter((card) => card.name === name);
    // Then: the result row landed on its call, with the flags the call row recorded.
    expect(byName("execute_bash")[0]?.result?.text).toContain("lab_shell_marker");
    expect(byName("fs_write")[0]?.result).toMatchObject({ denied: true, isError: true });
    expect(byName("read_file")[0]?.result?.isError).toBe(true);
    expect(byName("str_replace")[0]?.result?.isError).toBeUndefined();
    expect(byName("result")).toEqual([]);
  });

  test("/compact's summary is a summary entry, and the rows before it stay", async () => {
    // Given: the session, compacted near its end.
    const entries = adapter.parse(await readKiroFixture("messages.jsonl"));
    // When: the summary is found.
    const at = entries.findIndex((entry) => entry.role === "summary");
    // Then: there is one, with the turns before it kept and one turn after it.
    expect(entries.filter((entry) => entry.role === "summary")).toHaveLength(1);
    expect(texts(entries.slice(0, at), "assistant")).toContain("lab_plain_answer");
    expect(texts(entries.slice(at), "assistant")).toEqual(["lab_after_compact"]);
  });

  test("a sub-agent is one card holding its reply", async () => {
    // Given: a turn that asked for a sub-agent, after a failed first attempt.
    const cards = tools(adapter.parse(await readKiroFixture("subagent.jsonl")));
    // When: the sub-agent card is found.
    const sub = cards.find((card) => card.name === "subagent");
    // Then: it names the agent and holds its answer, and the failed attempt is an error card.
    expect(sub?.call).toMatchObject({ kind: "task", agent: "introspect" });
    expect(sub?.result?.text).toBe("lab_subagent_marker");
    expect(cards.find((card) => card.name === "invoke_sub_agent")?.result?.isError).toBe(true);
  });

  test("every row type kiro-cli 2.32.0 wrote is one the reader has decided about", async () => {
    // Given: both saved sessions.
    for (const name of ["messages.jsonl", "subagent.jsonl"]) {
      const reducer = adapter.reducer();
      // When: every row is read.
      parseWith(reducer, await readKiroFixture(name));
      // Then: nothing is counted as unknown.
      expect(unknownCount(reducer.unknowns())).toBe(0);
    }
  });

  test("after every row, the reducer's entries equal a whole parse of the rows so far", async () => {
    // Given: the saved session, fed one row at a time.
    const rows = (await readKiroFixture("messages.jsonl")).split("\n");
    const reducer = adapter.reducer();
    const entries: TranscriptEntry[] = [];
    for (const [index, line] of rows.entries()) {
      // When: the next row arrives.
      entries.push(...reducer.push(line).added);
      // Then: what it built equals a fresh parse of the same prefix.
      expect(entries).toEqual(adapter.parse(rows.slice(0, index + 1).join("\n")));
    }
  });
});

describe("Kiro rows the saved sessions do not show", () => {
  test("a row type the reader has not met is counted by name, and malformed rows are skipped", () => {
    // Given: an unknown type, an unknown assistant operation and rows of no shape.
    const reducer = adapter.reducer();
    const log = [row("u1", { type: "new_kind" }), row("a1", { type: "assistant", operationType: "Whisper", content: "Hidden." }), "{", "[]", JSON.stringify({ payload: { type: "user", content: "No id." } }), say("a2", "Shown.")].join("\n");
    // When: the rows are read.
    const entries = parseWith(reducer, log);
    // Then: only the well-formed reply shows, and both new names are counted.
    expect(entries.map((entry) => entry.uuid)).toEqual(["a2"]);
    expect([...reducer.unknowns().rows]).toEqual([["new_kind", 1]]);
    expect([...reducer.unknowns().parts]).toEqual([["Whisper", 1]]);
  });

  test("a result with no call before it still shows as a card", () => {
    // Given: a result row whose call fell outside the window that was read.
    const entries = adapter.parse(result("late", "Output."));
    // Then: the output is kept on a card of its own.
    expect(tools(entries)).toMatchObject([{ name: "result", result: { text: "Output." } }]);
  });

  test("text, tool inputs and result strings keep the shared size bounds", () => {
    // Given: oversized speech, tool input and output.
    const huge = "x".repeat(MAX_RESULT_CHARS + MAX_TEXT_CHARS);
    const entries = adapter.parse([say("big", huge), call("c", "completed", { args: { command: huge } }), result("c", huge)].join("\n"));
    // When: the parts are read.
    const [speech] = entries[0]?.parts ?? [];
    const [card] = tools(entries);
    // Then: each is cut to its bound and marked as cut.
    expect(speech).toMatchObject({ kind: "text", truncated: true });
    expect(speech?.kind === "text" && speech.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(card?.result?.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(card?.result?.truncated).toBe(true);
  });
});

describe("Kiro contained filesystem source", () => {
  test("an exact session ID resolves, with no newest-session or cwd guess", async () => {
    // Given: two sessions share a workspace, but their opaque IDs differ.
    const base = await kiroSandbox();
    const root = join(base, "sessions");
    const expected = await writeKiroSession(root, `${say("old", "Exact requested session.")}\n`, ID);
    await writeKiroSession(root, `${say("new", "Different session.")}\n`, OTHER_ID);
    const source = journal([join(base, "absent"), root]).source;
    // When: the pane supplies one exact ID.
    expect(await source.resolve({ kind: "id", value: ID })).toBe(expected);
    // Then: there is no cwd discovery fallback.
    expect(await journal([root]).discover?.("/example/alpha")).toBeNull();
    expect(await journal([root]).discover?.("/example/alpha", { processes: [] })).toBeNull();
    expect(await source.resolve({ kind: "id", value: "unreported-session" })).toBeNull();
  });

  test("a session in folders of any plain name resolves; the sess_ and hex shapes are not required", async () => {
    // Given: a bucket and a session folder named unlike the ones kiro-cli writes.
    const base = await kiroSandbox();
    const root = join(base, "sessions");
    const path = await writeKiroSession(root, `${say("plain", "Sample.")}\n`, "custom_123", "bucket-a");
    // When: the source resolves that ID.
    const found = await journal([root]).source.resolve({ kind: "id", value: "custom_123" });
    // Then: it finds the log, because only the names' safety is checked.
    expect(found).toBe(path);
  });

  test.each(["../escape", "/etc/passwd", "a/b", "a\\b", ".", "..", ".index", "id\u0000suffix", "id\n", "x".repeat(129), ""])("refuses invalid ID %j before path work", async (value) => {
    // Given: an untrusted pane ID that is not a valid session ID.
    const source = journal([KIRO_FIXTURES]).source;
    // When: resolution is requested.
    const found = await source.resolve({ kind: "id", value });
    // Then: no path is returned.
    expect(found).toBeNull();
  });

  test("a newline-ended ID is refused even when a matching folder exists", async () => {
    // Given: a real session folder whose name a regular expression's dollar anchor can match before a newline.
    const base = await kiroSandbox();
    const root = join(base, "sessions");
    // Windows refuses a folder name that ends in a newline, so there the folder is not made and the ID is refused all the same.
    if (process.platform !== "win32") await writeKiroSession(root, `${say("u", "Sample.")}\n`, "id\n");
    // When: resolution is asked for that name.
    const found = await journal([root]).source.resolve({ kind: "id", value: "id\n" });
    // Then: it is not admitted as a safe path component.
    expect(found).toBeNull();
  });

  test("a path ref never resolves; only an opaque ID names a Kiro session", async () => {
    // Given: a real log inside the configured root.
    const base = await kiroSandbox();
    const root = join(base, "sessions");
    const path = await writeKiroSession(root, `${say("u", "Sample.")}\n`, ID);
    // When: a caller hands the source the log's path instead of its ID.
    const found = await journal([root]).source.resolve({ kind: "path", value: path });
    // Then: no path is returned.
    expect(found).toBeNull();
  });

  test.each(["bucket", "session", "log"])("refuses an escaping %s symlink", async (level) => {
    // Given: one session tree symlinked outside its configured root.
    const base = await kiroSandbox();
    const root = join(base, "sessions");
    const outside = join(base, "outside");
    const original = await writeKiroSession(root, `${say("u", "Inside.")}\n`, ID);
    const external = await writeKiroSession(outside, `${say("u", "Outside.")}\n`, ID);
    const local = level === "bucket" ? join(root, KIRO_BUCKET) : level === "session" ? join(root, KIRO_BUCKET, ID) : original;
    const target = level === "bucket" ? join(outside, KIRO_BUCKET) : level === "session" ? join(outside, KIRO_BUCKET, ID) : external;
    // The real entry moves out of the root, since any plain folder name is a candidate bucket.
    await rename(local, join(base, "saved"));
    await symlink(target, local);
    // When: the pane's exact ID is resolved.
    const found = await journal([root]).source.resolve({ kind: "id", value: ID });
    // Then: string containment cannot authorize the real outside target.
    expect(found).toBeNull();
  });

  test("a symlink into another configured root is not contained by its building root", async () => {
    // Given: an ID whose path in root A actually points into root B.
    const base = await kiroSandbox();
    const a = join(base, "a");
    const b = join(base, "b");
    const pathA = await writeKiroSession(a, `${say("a", "A.")}\n`, ID);
    const pathB = await writeKiroSession(b, `${say("b", "B.")}\n`, ID);
    await rm(pathA);
    await symlink(pathB, pathA);
    const source = journal([a, b]).source;
    // When: roots are searched in order.
    const found = await source.resolve({ kind: "id", value: ID });
    // Then: only B's own path can authorize its log.
    expect(found).toBe(pathB);
  });

  test("a cached session is checked again on the next resolution", async () => {
    // Given: a successfully resolved log.
    const { source, path, base } = await sourceFixture(`${say("u", "Inside.")}\n`);
    const outside = join(base, "outside.jsonl");
    await writeFile(outside, `${say("other", "Outside.")}\n`);
    // When: the log is replaced by an outside symlink.
    await rename(path, `${path}-saved`);
    await symlink(outside, path);
    // Then: the cached location does not bypass realpath containment.
    expect(await source.resolve({ kind: "id", value: ID })).toBeNull();
  });

  test("a sub-agent's own history is never read with the parent's or resolved as a session", async () => {
    // Given: a parent and a sub-agent history in its sub-executions folder.
    const { source, root, path } = await sourceFixture(`${say("parent", "Parent speech.")}\n`);
    await mkdir(join(root, KIRO_BUCKET, ID, "sub-executions"));
    await writeFile(join(root, KIRO_BUCKET, ID, "sub-executions", "child.jsonl"), `${say("child", "Child speech.")}\n`);
    // When: the parent log is read and the sub-agent's ID is looked up.
    const loaded = await source.load(path);
    // Then: no recursive or newest-child walk combines those conversations.
    expect(adapter.parse(loaded.text).map((entry) => entry.uuid)).toEqual(["parent"]);
    expect(await source.resolve({ kind: "id", value: "child" })).toBeNull();
  });

  // The reads are files.ts's shared readers, tested in read-since.test.ts; this checks that the source
  // reads the log resolve found, live and whole, and that the two agree.
  test("source-fed live updates and History parsing agree across result and compaction appends", async () => {
    // Given: a small session read in append batches by the real filesystem source.
    const { source, path } = await sourceFixture(`${call("live")}\n`);
    let read = await source.readSince(path, "");
    const reducer = adapter.reducer();
    const entries: TranscriptEntry[] = [];
    for (const line of read.lines) entries.push(...reducer.push(line).added);
    // When: the call's result, a compaction and a later reply arrive.
    const batches = [result("live", "first"), row("compaction", { type: "tombstone", kind: "summarization", effectiveFromMessageId: "live-call" }), row("summary", { type: "assistant", operationType: "Summary", content: "Sample summary." }), say("final", "Current answer.")];
    for (const batch of batches) {
      await appendFile(path, `${batch}\n`);
      read = await source.readSince(path, read.cursor);
      expect(read.reset).toBe(false);
      for (const line of read.lines) entries.push(...reducer.push(line).added);
      // Then: every live snapshot agrees with the same bounded whole-log reducer.
      expect(entries).toEqual(adapter.parse((await source.load(path)).text));
    }
  });
});
