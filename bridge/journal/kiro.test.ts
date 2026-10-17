import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { kiroJournal } from "./kiro.ts";
import { FIRST_TAIL_BYTES, MAX_TRANSCRIPT_BYTES } from "./files.ts";
import { createLineFeeder, unknownCount } from "./reduce.ts";
import { MAX_RESULT_CHARS, MAX_TEXT_CHARS } from "./text.ts";
import type { JsonObject } from "../json.ts";
import type { TranscriptEntry, TranscriptPart, TranscriptSource } from "./types.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "kiro");
const ID = "sess_11111111-2222-4333-8444-555555555555";
const OTHER_ID = "sess_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BUCKET = "f59dfd564fb1cb64";
const TS = "2026-10-01T12:00:00.000Z";
const adapter = kiroJournal([]);

// Saved-session rows use this envelope; the payload is not an ACP streaming chunk.
function row(id: string, payload: JsonObject): string {
  return JSON.stringify({ id, timestamp: TS, payload });
}

function say(id: string, content: string): string {
  return row(id, { type: "assistant", operationType: "Say", content, executionId: "exec-1" });
}

function call(id: string, status = "executing", extra: JsonObject = {}): string {
  return row(`${id}-call`, { type: "tool_call", toolCallId: id, toolName: "execute_bash", kind: "execute", args: { command: "printf sample", description: "Print sample text" }, status, executionId: "exec-1", ...extra });
}

function result(id: string, content: string, extra: JsonObject = {}): string {
  return row(`${id}-result`, { type: "tool_result", toolCallId: id, content, success: true, executionId: "exec-1", ...extra });
}

function tool(entry: TranscriptEntry | undefined): Extract<TranscriptPart, { kind: "tool" }> {
  const part = entry?.parts[0];
  if (part?.kind !== "tool") throw new Error("Expected a tool entry");
  return part;
}

function visible(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.abandoned !== true);
}

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const base = await mkdtemp(join(FIXTURES, ".test-"));
  temporary.push(base);
  return base;
}

async function makeSession(root: string, content: string, id = ID, bucket = BUCKET): Promise<string> {
  const dir = join(root, bucket, id);
  await mkdir(dir, { recursive: true });
  // Session metadata in the shape kiro-cli 2.32.0 writes; rootPaths intentionally differs
  // from the frozen workspacePaths used to locate the bucket.
  // SAFETY: this synthetic fixture is a JSON object, checked in beside this test.
  const metadata = JSON.parse(await readFile(join(FIXTURES, "session.json"), "utf8")) as JsonObject;
  metadata.id = id;
  await writeFile(join(dir, "session.json"), JSON.stringify(metadata));
  const path = join(dir, "messages.jsonl");
  await writeFile(path, content);
  return path;
}

async function sourceFixture(content: string): Promise<{ source: TranscriptSource; path: string; root: string; base: string }> {
  const base = await sandbox();
  const root = join(base, "sessions");
  const path = await makeSession(root, content);
  const source = kiroJournal([root]).source;
  expect(await source.resolve({ kind: "id", value: ID })).toBe(path);
  return { source, path, root, base };
}

describe("Kiro V3 grammar", () => {
  test("current source-shaped rows produce speech, thoughts, summaries and paired tool cards", async () => {
    // Given: a synthetic session with source-produced field names and lifecycle rows.
    const input = await readFile(join(FIXTURES, "messages.jsonl"), "utf8");
    // When: Collie parses its append log.
    const entries = visible(adapter.parse(input));
    // Then: internal prompts do not appear, and summary coverage does not erase speech.
    expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant", "assistant", "assistant", "summary", "assistant"]);
    expect(entries[0]).toMatchObject({ uuid: "input-1", ts: TS, parts: [{ kind: "text", text: "List the sample files." }] });
    expect(entries[1]?.parts).toEqual([{ kind: "thinking", text: "I will check the sample folder." }]);
    expect(tool(entries[2])).toMatchObject({ id: "read-1", name: "read_file", call: { kind: "read", path: "/example/sample.txt", range: [0, 10] }, result: { text: "sample-a\nsample-b" } });
    expect(tool(entries[3])).toMatchObject({ call: { kind: "task", agent: "checker" }, result: { text: "The sample names are valid." } });
    expect(entries[4]?.parts).toEqual([{ kind: "text", text: "The user asked for sample file names." }]);
  });

  test("client speech excludes msg0, notes, attachments and synthetic user provenance", () => {
    // Given: private model context next to a genuine prompt and a workflow notification.
    const input = [
      row("msg0", { type: "session_start", agentType: "chat", forcedRole: true, messageId: "msg0", content: "private system context" }),
      row("system", { type: "system", content: "private system text" }),
      row("agent-note", { type: "agent_note", content: "private session context" }),
      row("steering", { type: "steering_inclusion", documents: [{ id: "s", displayName: "s", content: "private steering" }] }),
      row("synthetic", { type: "user", content: "private envelope", _meta: { kiro: { syntheticUserMessageReason: null } } }),
      row("u", { type: "user", source: "chat", content: "Show the example.", contextItems: [{ content: "private file context" }], documents: [{ name: "sample.pdf", data: "synthetic", mimeType: "application/pdf" }], images: [{ data: "synthetic", mimeType: "image/png" }] }),
      row("notify", { type: "user", source: "steer", content: "[notification/info] Sample workflow finished." }),
    ].join("\n");
    // When: the journal is projected for the phone.
    const entries = adapter.parse(input);
    // Then: only client-visible prose and attachment placeholders survive.
    expect(entries.map((entry) => entry.uuid)).toEqual(["u", "notify"]);
    expect(entries[0]?.parts).toEqual([{ kind: "text", text: "Show the example." }, { kind: "text", text: "[image attached]" }, { kind: "text", text: "[document attached]" }]);
    expect(entries[1]?.role).toBe("note");
    expect(JSON.stringify(entries)).not.toContain("private");
    expect(JSON.stringify(entries)).not.toContain("data:");
  });

  test("persisted user displayText replaces model-facing content", () => {
    // Given: a prompt with a label the client saw and hidden model-facing prose.
    const input = row("label", { type: "user", content: "private model instruction", _meta: { kiro: { displayText: "Run the sample action." } } });
    // When: the journal shows the user's message.
    const entries = adapter.parse(input);
    // Then: it shows the label rather than private instruction text.
    expect(entries[0]?.parts).toEqual([{ kind: "text", text: "Run the sample action." }]);
    expect(JSON.stringify(entries)).not.toContain("private");
  });

  test("reasoning exposes only persisted display text, never envelopes or redacted content", () => {
    // Given: packed, empty, redacted, and textual reasoning rows.
    const rows = [
      row("packed", { type: "assistant", operationType: "Reasoning", content: "...", reasoningSignature: "private-signature" }),
      row("redacted", { type: "assistant", operationType: "Reasoning", content: "", reasoningRedactedContent: "private-redaction" }),
      row("thought", { type: "assistant", operationType: "Reasoning", content: "Check the example.", reasoningSignature: "private-signature" }),
      row("summary", { type: "assistant", operationType: "Summary", content: "Sample summary.", summaryReasoning: { text: "private packed reasoning", signature: "private-signature" } }),
    ];
    // When: the adapter parses these rows.
    const entries = adapter.parse(rows.join("\n"));
    // Then: the display text is present without private reconstruction fields.
    expect(entries.map((entry) => entry.uuid)).toEqual(["thought", "summary"]);
    expect(entries[0]?.parts).toEqual([{ kind: "thinking", text: "Check the example." }]);
    expect(JSON.stringify(entries)).not.toContain("private");
  });

  test("cumulative assistant updates change one stable entry", () => {
    // Given: two snapshots with the same source message id.
    const reducer = adapter.reducer();
    const initial = reducer.push(say("say-1", "Sample"));
    // When: its final persisted text arrives.
    const final = reducer.push(say("say-1", "Sample answer."));
    // Then: no duplicate bubble is added and the earlier object is updated.
    expect(final.added).toEqual([]);
    expect(final.changed).toEqual(["say-1"]);
    expect(initial.added[0]?.parts).toEqual([{ kind: "text", text: "Sample answer." }]);
  });

  test("tool lifecycle and repeated result rows update the original call rather than append chunks", () => {
    // Given: a tool call and its initial persisted output.
    const reducer = adapter.reducer();
    const initial = reducer.push(call("shell"));
    reducer.push(result("shell", "first"));
    // When: cumulative output and terminal status arrive.
    const update = reducer.push(result("shell", "first\nsecond"));
    const terminal = reducer.push(call("shell", "completed"));
    // Then: each update addresses one original call with the latest complete output.
    expect(update.added).toEqual([]);
    expect(update.changed).toEqual(["shell-call"]);
    expect(terminal.added).toEqual([]);
    expect(tool(initial.added[0])).toMatchObject({ name: "execute_bash", call: { kind: "execute", command: "printf sample" }, result: { text: "first\nsecond" } });
  });

  test("denied, policy-denied and failed calls preserve distinct flags", () => {
    // Given: tool statuses and their terminal output from the persistence schema.
    const rows = [call("denied", "denied"), result("denied", "Permission refused.", { success: false }), call("policy", "failed", { _meta: { kiro: { policyDenial: { effect: "deny" } } } }), result("policy", "Policy refused.", { success: false }), call("error", "failed"), result("error", "Sample command failed.", { success: false })];
    // When: the results join their calls.
    const entries = adapter.parse(rows.join("\n"));
    // Then: denial is explicit, while an ordinary failure never invents denial.
    expect(tool(entries[0]).result).toEqual({ text: "Permission refused.", isError: true, denied: true });
    expect(tool(entries[1]).result).toEqual({ text: "Policy refused.", isError: true, denied: true });
    expect(tool(entries[2]).result).toEqual({ text: "Sample command failed.", isError: true });
    expect(tool(adapter.parse(call("alone", "denied"))[0]).result).toEqual({ text: "", denied: true });
  });

  test("orphan results remain visible and a late call does not duplicate them", () => {
    // Given: a window beginning after the call, with output first.
    const reducer = adapter.reducer();
    const orphan = reducer.push(result("late", "sample output"));
    // When: a replayed call snapshot arrives later.
    const joined = reducer.push(call("late", "completed"));
    // Then: the same result entry receives its call identity and structure.
    expect(joined.added).toEqual([]);
    expect(joined.changed).toEqual(["late-result"]);
    expect(tool(orphan.added[0])).toMatchObject({ id: "late", name: "execute_bash", result: { text: "sample output" } });
  });

  test("sub-execution IDs keep nested calls from answering another scope's tool", () => {
    // Given: the same call id exists in two execution scopes.
    const rows = [call("same"), row("nested-tool", { type: "tool_call", toolCallId: "same", toolName: "read_file", kind: "read", args: { path: "/example/nested.txt" }, status: "completed", subExecutionId: "nested" }), result("same", "parent"), result("same", "child", { subExecutionId: "nested" })];
    // When: the scoped results arrive.
    const entries = adapter.parse(rows.join("\n"));
    // Then: each scope receives only its own result.
    expect(tool(entries[0]).result?.text).toBe("parent");
    expect(tool(entries[1]).result?.text).toBe("child");
  });

  test("malformed append rows are ignored and unknown grammar is reported by name", () => {
    // Given: broken JSON, scalars, malformed tools and future schema variants.
    const reducer = adapter.reducer();
    const rows = ["", "{broken", "null", "[]", "42", row("bad", { type: "tool_call", toolCallId: "x", args: [] }), row("bad-result", { type: "tool_result", toolCallId: "x", content: {}, success: true }), row("future", { type: "future_payload" }), row("future-part", { type: "assistant", operationType: "Future", content: "do not guess" })];
    // When: the reducer consumes every row.
    for (const line of rows) expect(reducer.push(line)).toEqual({ added: [], changed: [] });
    // Then: valid speech still works and the unknown inventory identifies drift.
    expect(reducer.push(say("valid", "Sample answer.")).added).toHaveLength(1);
    expect(unknownCount(reducer.unknowns())).toBe(2);
    expect(reducer.unknowns().rows.get("future_payload")).toBe(1);
    expect(reducer.unknowns().parts.get("Future")).toBe(1);
    expect(reducer.queued()).toEqual([]);
  });

  test("text, tool inputs and result strings retain the shared size bounds", () => {
    // Given: oversized persisted display strings.
    const long = "x".repeat(MAX_TEXT_CHARS + 100);
    const input = [say("large", long), call("large-tool", "completed", { args: { command: long } }), result("large-tool", long)].join("\n");
    // When: the adapter reads them.
    const entries = adapter.parse(input);
    // Then: all emitted bodies are capped and the cuts are flagged.
    expect(entries[0]?.parts[0]).toEqual({ kind: "text", text: long.slice(0, MAX_TEXT_CHARS), truncated: true });
    expect(tool(entries[1]).result).toEqual({ text: long.slice(0, MAX_RESULT_CHARS), truncated: true });
    const classified = tool(entries[1]).call;
    if (classified?.kind !== "execute") throw new Error("Expected execute call");
    expect(classified.command.length).toBe(MAX_TEXT_CHARS);
    expect(tool(entries[1]).summary.length).toBeLessThanOrEqual(201);
  });
});

describe("Kiro history reduction", () => {
  test("checkpoint tombstones hide an inclusive suffix and report every changed entry", () => {
    // Given: two conversations followed by an inclusive checkpoint revert.
    const reducer = adapter.reducer();
    const first = reducer.push(row("first", { type: "user", content: "First." }));
    const second = reducer.push(row("second", { type: "user", content: "Second." }));
    const answer = reducer.push(say("answer", "Second answer."));
    // When: the second prompt and everything after it are reverted.
    const reverted = reducer.push(row("revert", { type: "tombstone", kind: "checkpoint_revert", effectiveFromMessageId: "second" }));
    // Then: hidden entries keep paging identities and the live client receives both changes.
    expect(reverted.changed.toSorted()).toEqual(["answer", "second"]);
    expect(first.added[0]?.abandoned).toBeUndefined();
    expect(second.added[0]?.abandoned).toBe(true);
    expect(answer.added[0]?.abandoned).toBe(true);
    expect(reducer.push(row("again", { type: "tombstone", kind: "checkpoint_revert", effectiveFromMessageId: "second" }))).toEqual({ added: [], changed: [] });
  });

  test("checkpoint rollback undoes an update to a call retained before the boundary", () => {
    // Given: a call before a boundary and a result afterward.
    const reducer = adapter.reducer();
    const original = reducer.push(call("retained"));
    reducer.push(say("boundary", "Work in progress."));
    reducer.push(result("retained", "obsolete output"));
    // When: the suffix starting at the boundary is reverted.
    const reverted = reducer.push(row("revert", { type: "tombstone", kind: "checkpoint_revert", effectiveFromMessageId: "boundary" }));
    // Then: old output disappears, and the retained call can accept a new result.
    expect(tool(original.added[0]).result).toBeUndefined();
    expect(reverted.changed).toContain("retained-call");
    reducer.push(result("retained", "new output"));
    expect(tool(original.added[0]).result?.text).toBe("new output");
  });

  test("summarization retains UI history and ignores nested compaction pairs", () => {
    // Given: a parent turn, an accidental nested compaction and a real parent compaction.
    const rows = [row("turn", { type: "turn_start", executionId: "parent" }), say("before", "Keep this visible."), row("nested-tombstone", { type: "tombstone", kind: "summarization", effectiveFromMessageId: "before" }), row("nested-summary", { type: "assistant", operationType: "Summary", executionId: "nested", content: "Child-only summary." }), row("parent-tombstone", { type: "tombstone", kind: "summarization", effectiveFromMessageId: "before" }), row("parent-summary", { type: "assistant", operationType: "Summary", executionId: "parent", content: "Parent summary." })];
    // When: the adapter replays the log.
    const entries = adapter.parse(rows.join("\n"));
    // Then: compaction does not hide old speech and nested repair hides only the child summary.
    expect(visible(entries).map((entry) => entry.uuid)).toEqual(["before", "parent-summary"]);
    expect(entries.find((entry) => entry.uuid === "nested-summary")?.abandoned).toBe(true);
  });

  test("checkpoint targets removed by nested-compaction repair are unknown targets", () => {
    // Given: a nested summary pair, which is dropped before checkpoints resolve.
    const rows = [row("parent", { type: "turn_start", executionId: "parent" }), say("before", "Before."), row("nested-t", { type: "tombstone", kind: "summarization", effectiveFromMessageId: "before" }), row("nested-s", { type: "assistant", operationType: "Summary", executionId: "child", content: "Child summary." }), say("after", "Still visible."), row("revert", { type: "tombstone", kind: "checkpoint_revert", effectiveFromMessageId: "nested-s" })];
    // When: the checkpoint tries to address the removed summary.
    const entries = adapter.parse(rows.join("\n"));
    // Then: it cannot remove a surviving suffix through a nonexistent target.
    expect(visible(entries).map((entry) => entry.uuid)).toEqual(["before", "after"]);
  });

  test("later turn evidence repairs summary classification just as whole history does", () => {
    // Given: a compaction pair before any evidence of top-level turns.
    const reducer = adapter.reducer();
    reducer.push(row("t", { type: "tombstone", kind: "summarization", effectiveFromMessageId: "outside" }));
    const summary = reducer.push(row("s", { type: "assistant", operationType: "Summary", executionId: "parent", content: "Summary." }));
    // When: another turn proves nesting, then the summary's own turn is found.
    expect(reducer.push(row("other-turn", { type: "turn_end", executionId: "other", stopReason: "end_turn" })).changed).toEqual(["s"]);
    expect(summary.added[0]?.abandoned).toBe(true);
    expect(reducer.push(row("parent-turn", { type: "turn_end", executionId: "parent", stopReason: "end_turn" })).changed).toEqual(["s"]);
    // Then: matching evidence restores the original summary entry.
    expect(summary.added[0]?.abandoned).toBeUndefined();
  });

  test("raw errors and internal metadata stay hidden but display errors and current recap are notes", () => {
    // Given: private error details and client-facing presentation state.
    const rows = [row("private-error", { type: "error", message: "private error", details: { raw: "private" } }), row("internal", { type: "session_metadata", key: "memoryExtractionWatermark", value: "private watermark" }), row("old-recap", { type: "session_metadata", key: "recap", value: { text: "Old recap." } }), row("display-error", { type: "session_metadata", key: "displayError", value: { message: "Sample request failed.", errorType: "model" } }), row("new-recap", { type: "session_metadata", key: "recap", value: { text: "Current recap." } })];
    // When: the display projection is built.
    const entries = adapter.parse(rows.join("\n"));
    // Then: only the latest recap and the display error survive.
    expect(visible(entries).map((entry) => entry.uuid)).toEqual(["display-error", "new-recap"]);
    expect(visible(entries).every((entry) => entry.role === "note")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("private");
  });

  test("revert badges do not replace a tool's genuine result", () => {
    // Given: current and legacy tool-revert records after a result.
    const rows = [call("edit"), result("edit", "original output"), row("badge", { type: "tool_revert", toolCallId: "edit" }), result("edit", "", { metadata: { reverted: true } })];
    // When: these records are reduced.
    const entries = adapter.parse(rows.join("\n"));
    // Then: the genuine output stays attached without another result entry.
    expect(entries).toHaveLength(1);
    expect(tool(entries[0]).result?.text).toBe("original output");
  });

  test("whole-history and chunk-fed reducers agree at every row boundary", async () => {
    // Given: realistic rows plus updates, malformed lines and checkpoint rollback.
    const input = (await readFile(join(FIXTURES, "messages.jsonl"), "utf8")) + [call("late"), result("late", "first"), result("late", "first\nsecond"), say("undo", "Remove me."), row("revert", { type: "tombstone", kind: "checkpoint_revert", effectiveFromMessageId: "undo" }), "{broken", say("last", "Final sample.")].join("\n") + "\n";
    // When: arbitrarily split chunks are fed through the shared line feeder.
    for (const size of [1, 7, 59, 257]) {
      const reducer = adapter.reducer();
      const feeder = createLineFeeder();
      const entries: TranscriptEntry[] = [];
      let prefix = "";
      for (let at = 0; at < input.length; at += size) {
        for (const line of feeder.push(input.slice(at, at + size))) {
          entries.push(...reducer.push(line).added);
          prefix += `${line}\n`;
          // Then: snapshots and incremental mutations produce the same entries.
          expect(entries).toEqual(adapter.parse(prefix));
        }
      }
      expect(entries).toEqual(adapter.parse(input));
      expect(unknownCount(reducer.unknowns())).toBe(0);
    }
  });
});

describe("Kiro contained filesystem source", () => {
  test("exact opaque IDs resolve under roots without newest-session guessing or rootPaths hashing", async () => {
    // Given: two sessions share a workspace, but their opaque IDs differ.
    const base = await sandbox();
    const root = join(base, "sessions");
    const expected = await makeSession(root, `${say("old", "Exact requested session.")}\n`);
    await makeSession(root, `${say("new", "Different session.")}\n`, OTHER_ID);
    const source = kiroJournal([join(base, "absent"), root]).source;
    // When: the pane supplies one exact ID.
    expect(await source.resolve({ kind: "id", value: ID })).toBe(expected);
    // Then: the growing membership hash is irrelevant and there is no cwd discovery fallback.
    expect(await kiroJournal([root]).discover?.("/example/alpha")).toBeNull();
    expect(await kiroJournal([root]).discover?.("/example/alpha", { processes: [] })).toBeNull();
    const digest = createHash("sha256").update(["/example/alpha", "/example/beta"].toSorted().join("\0")).digest("hex").slice(0, 16);
    expect(digest).toBe(BUCKET);
    expect(await source.resolve({ kind: "id", value: "unreported-session" })).toBeNull();
  });

  test("global and validated override IDs are supported", async () => {
    // Given: an override ID in the empty-workspace `_global` bucket.
    const base = await sandbox();
    const root = join(base, "sessions");
    const path = await makeSession(root, `${say("global", "Sample.")}\n`, "override_123", "_global");
    // When: the source resolves that opaque ID.
    const found = await kiroJournal([root]).source.resolve({ kind: "id", value: "override_123" });
    // Then: it finds the exact log without requiring the canonical sess_ prefix.
    expect(found).toBe(path);
  });

  test.each(["../escape", "/etc/passwd", "a/b", "a\\b", ".", "..", "workflows", "WORKFLOWS", ".index", "id\u0000suffix", "id\n", "x".repeat(129), ""])("refuses invalid ID %j before path work", async (value) => {
    // Given: an untrusted pane ID that is not a valid session ID.
    const source = kiroJournal([FIXTURES]).source;
    // When: resolution is requested.
    const found = await source.resolve({ kind: "id", value });
    // Then: no path is returned.
    expect(found).toBeNull();
  });

  test("newline-ended IDs and bucket names are refused even when matching directories exist", async () => {
    // Given: real directories that a regular expression's dollar anchor can match before a newline.
    const base = await sandbox();
    const root = join(base, "sessions");
    await makeSession(root, `${say("u", "Sample.")}\n`, "id\n");
    await makeSession(root, `${say("u", "Sample.")}\n`, ID, `${BUCKET}\n`);
    const source = kiroJournal([root]).source;
    // When: resolution encounters those names.
    expect(await source.resolve({ kind: "id", value: "id\n" })).toBeNull();
    // Then: neither shape is admitted as a safe filesystem segment.
    expect(await source.resolve({ kind: "id", value: ID })).toBeNull();
  });

  test("path refs and direct reads not authorized by resolution are refused", async () => {
    // Given: a real log but no opaque-ID resolution on this source.
    const base = await sandbox();
    const root = join(base, "sessions");
    const path = await makeSession(root, `${say("u", "Sample.")}\n`);
    const source = kiroJournal([root]).source;
    // When: a caller tries to use a path as authority.
    expect(await source.resolve({ kind: "path", value: path })).toBeNull();
    // Then: every filesystem entry point refuses it.
    expect(await source.stat(path)).toBeNull();
    await expect(source.load(path)).rejects.toThrow("unavailable");
    expect((await source.readSince(path, "")).lines).toEqual([]);
  });

  test("missing metadata, wrong identity and unsupported metadata version do not resolve", async () => {
    // Given: a log with a malformed or mismatched existence marker.
    const base = await sandbox();
    const root = join(base, "sessions");
    const path = await makeSession(root, `${say("u", "Sample.")}\n`);
    const metadata = join(root, BUCKET, ID, "session.json");
    const source = kiroJournal([root]).source;
    // When: the marker cannot establish the current V3 session identity.
    for (const data of ["{partial", JSON.stringify({ id: OTHER_ID, schemaVersion: "1.0.0", workspacePaths: [] }), JSON.stringify({ id: ID, schemaVersion: "3", workspacePaths: [] })]) {
      await writeFile(metadata, data);
      expect(await source.resolve({ kind: "id", value: ID })).toBeNull();
    }
    await rm(metadata);
    // Then: messages.jsonl alone is not a session.
    expect(await source.resolve({ kind: "id", value: ID })).toBeNull();
    expect(await source.stat(path)).toBeNull();
  });

  test.each(["bucket", "session", "metadata", "log"])("refuses an escaping %s symlink", async (level) => {
    // Given: one session tree symlinked outside its configured root.
    const base = await sandbox();
    const root = join(base, "sessions");
    const outside = join(base, "outside");
    const original = await makeSession(root, `${say("u", "Inside.")}\n`);
    const external = await makeSession(outside, `${say("u", "Outside.")}\n`);
    const local = level === "bucket" ? join(root, BUCKET) : level === "session" ? join(root, BUCKET, ID) : level === "metadata" ? join(root, BUCKET, ID, "session.json") : original;
    const target = level === "bucket" ? join(outside, BUCKET) : level === "session" ? join(outside, BUCKET, ID) : level === "metadata" ? join(outside, BUCKET, ID, "session.json") : external;
    await rename(local, `${local}-saved`);
    await symlink(target, local);
    // When: the pane's exact ID is resolved.
    const found = await kiroJournal([root]).source.resolve({ kind: "id", value: ID });
    // Then: string containment cannot authorize the real outside target.
    expect(found).toBeNull();
  });

  test("a symlink into another configured root is not contained by its building root", async () => {
    // Given: an ID whose path in root A actually points into root B.
    const base = await sandbox();
    const a = join(base, "a");
    const b = join(base, "b");
    const pathA = await makeSession(a, `${say("a", "A.")}\n`);
    const pathB = await makeSession(b, `${say("b", "B.")}\n`);
    await rm(pathA);
    await symlink(pathB, pathA);
    const source = kiroJournal([a, b]).source;
    // When: roots are searched in order.
    const found = await source.resolve({ kind: "id", value: ID });
    // Then: only B's own path can authorize its log.
    expect(found).toBe(pathB);
  });

  test("cached paths are rechecked on stat, load, readSince and resolution", async () => {
    // Given: a successfully resolved log and a cursor already in use.
    const { source, path, base } = await sourceFixture(`${say("u", "Inside.")}\n`);
    const initial = await source.readSince(path, "");
    const outside = join(base, "outside.jsonl");
    await writeFile(outside, `${say("other", "Outside.")}\n`);
    // When: the log is replaced by an outside symlink.
    await rename(path, `${path}-saved`);
    await symlink(outside, path);
    // Then: no cached authority bypasses current realpath containment.
    expect(await source.stat(path)).toBeNull();
    await expect(source.load(path)).rejects.toThrow("unavailable");
    expect((await source.readSince(path, initial.cursor)).lines).toEqual([]);
    expect(await source.resolve({ kind: "id", value: ID })).toBeNull();
  });

  test("a log symlink into a sibling session is refused even inside the configured root", async () => {
    // Given: two sessions inside one root.
    const { root, path } = await sourceFixture(`${say("u", "First.")}\n`);
    const sibling = await makeSession(root, `${say("u", "Sibling.")}\n`, OTHER_ID);
    await rename(path, `${path}-saved`);
    await symlink(sibling, path);
    // When: the original pane resolves its ID.
    const found = await kiroJournal([root]).source.resolve({ kind: "id", value: ID });
    // Then: parent-root containment alone does not cross-wire sibling content.
    expect(found).toBeNull();
  });

  test("child and workflow log paths never become opaque session resolution candidates", async () => {
    // Given: a parent and private child/workflow histories beside it.
    const { source, root, path } = await sourceFixture(`${say("parent", "Parent speech.")}\n`);
    await mkdir(join(root, BUCKET, ID, "sub-executions"));
    await writeFile(join(root, BUCKET, ID, "sub-executions", "child.jsonl"), `${say("child", "Child speech.")}\n`);
    await makeSession(root, `${say("workflow", "Workflow speech.")}\n`, "child", "workflows");
    // When: the parent log is read and a nonexistent top-level child ID is looked up.
    const loaded = await source.load(path);
    // Then: no recursive or newest-child walk combines those conversations.
    expect(adapter.parse(loaded.text).map((entry) => entry.uuid)).toEqual(["parent"]);
    expect(await source.resolve({ kind: "id", value: "child" })).toBeNull();
  });

  test("incremental reads hold valid-but-unterminated rows and skip malformed completed appends", async () => {
    // Given: one complete row and a final JSON object without its commit newline.
    const first = row("u", { type: "user", content: "Sample 😀 漢字." });
    const pending = say("a", "Complete after the newline.");
    const { source, path } = await sourceFixture(`${first}\n${pending}`);
    // When: the first read and History read occur during the torn append.
    const initial = await source.readSince(path, "");
    expect(initial.lines).toEqual([first]);
    expect(adapter.parse((await source.load(path)).text).map((entry) => entry.uuid)).toEqual(["u"]);
    await appendFile(path, `\n{malformed}\n${say("b", "Next.")}\n`);
    const next = await source.readSince(path, initial.cursor);
    // Then: only new complete bytes are read, and row parsing tolerates the malformed line.
    expect(next.reset).toBe(false);
    expect(next.lines).toEqual([pending, "{malformed}", say("b", "Next.")]);
    expect(adapter.parse(next.lines.join("\n")).map((entry) => entry.uuid)).toEqual(["a", "b"]);
    expect((await source.readSince(path, next.cursor)).lines).toEqual([]);
  });

  test.each(["shrink", "same-size", "larger-in-place", "replacement"])("%s rewrite resets rather than resumes old offsets", async (kind) => {
    // Given: a cursor on a prior log.
    const original = `${say("old", "An old sample answer.")}\n`;
    const { source, path } = await sourceFixture(original);
    const initial = await source.readSince(path, "");
    // When: storage is replaced or overwritten, not appended.
    const replacement = `${say("new", kind === "shrink" ? "Short." : kind === "same-size" ? "A nice sample answer." : "A much longer sample answer written over the original file.")}\n`;
    if (kind === "same-size") expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    if (kind === "replacement") {
      await writeFile(`${path}-replacement`, replacement);
      await rename(`${path}-replacement`, path);
    } else await writeFile(path, replacement);
    const next = await source.readSince(path, initial.cursor);
    // Then: the caller must rebuild with exactly the replacement conversation.
    expect(next.reset).toBe(true);
    expect(next.fromStart).toBe(true);
    expect(adapter.parse(next.lines.join("\n")).map((entry) => entry.uuid)).toEqual(["new"]);
  });

  test("an equal-size rewrite in the middle resets even when boundary samples agree", async () => {
    // Given: a large file whose first and last 256 bytes will stay unchanged.
    const prefix = `${say("prefix", "p".repeat(400))}\n`;
    const original = `${prefix}${say("middle", "old")}\n${say("suffix", "s".repeat(400))}\n`;
    const { source, path } = await sourceFixture(original);
    const initial = await source.readSince(path, "");
    // When: only the middle content is overwritten at the same file size.
    await writeFile(path, original.replace('"content":"old"', '"content":"new"'));
    const { utimes } = await import("node:fs/promises");
    await utimes(path, new Date("2026-01-01"), new Date("2026-01-01"));
    const next = await source.readSince(path, initial.cursor);
    // Then: changed mtime without growth forces a fresh window.
    expect(next.reset).toBe(true);
    expect(adapter.parse(next.lines.join("\n"))[1]?.parts).toEqual([{ kind: "text", text: "new" }]);
  });

  test("catching up across more than a live byte window resets to a bounded tail", async () => {
    // Given: a cursor whose unread gap grows beyond FIRST_TAIL_BYTES.
    const { source, path } = await sourceFixture(`${say("old", "Old.")}\n`);
    const initial = await source.readSince(path, "");
    // When: a large malformed row and a new complete turn are appended.
    await appendFile(path, `${"x".repeat(FIRST_TAIL_BYTES + 1)}\n${say("new", "New.")}\n`);
    const next = await source.readSince(path, initial.cursor);
    // Then: the old reducer must be discarded rather than holding the entire gap.
    expect(next.reset).toBe(true);
    expect(next.fromStart).toBe(false);
    expect(next.lines.join("\n").length).toBeLessThanOrEqual(FIRST_TAIL_BYTES);
    expect(adapter.parse(next.lines.join("\n")).map((entry) => entry.uuid)).toEqual(["new"]);
  });

  test("foreign or corrupt cursors reset and cannot select a different session", async () => {
    // Given: distinct source keys and a cursor from the first.
    const { source, path, root } = await sourceFixture(`${say("one", "One.")}\n`);
    const first = await source.readSince(path, "");
    const second = await makeSession(root, `${say("two", "Two.")}\n`, OTHER_ID);
    expect(await source.resolve({ kind: "id", value: OTHER_ID })).toBe(second);
    // When: the caller uses a foreign or malformed token.
    for (const cursor of [first.cursor, "bytes:-1:bad", "bytes:1e9:bad", "invalid"]) {
      const read = await source.readSince(second, cursor);
      // Then: the second key's own bounded first window is returned.
      expect(read.reset).toBe(true);
      expect(adapter.parse(read.lines.join("\n")).map((entry) => entry.uuid)).toEqual(["two"]);
    }
  });

  test("History and live reads are bounded tails with complete row boundaries", async () => {
    // Given: a sparse malformed first row larger than either shared byte cap.
    const { source, path } = await sourceFixture("");
    await truncate(path, MAX_TRANSCRIPT_BYTES + FIRST_TAIL_BYTES);
    await appendFile(path, `\n${say("newest", "Newest sample.")}\n`);
    // When: both reading surfaces open the large log.
    const live = await source.readSince(path, "");
    const loaded = await source.load(path);
    // Then: each keeps only the newest complete rows and declares the clipped prefix.
    expect(live.reset).toBe(true);
    expect(live.fromStart).toBe(false);
    expect(loaded.complete).toBe(false);
    expect(loaded.text.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(adapter.parse(loaded.text).map((entry) => entry.uuid)).toEqual(["newest"]);
    expect(adapter.parse(live.lines.join("\n"))).toEqual(adapter.parse(loaded.text));
  });

  test("source-fed live updates and History parsing agree across checkpoint and compaction appends", async () => {
    // Given: a small session read in append batches by the real filesystem source.
    const { source, path } = await sourceFixture(`${call("live")}\n`);
    let read = await source.readSince(path, "");
    const reducer = adapter.reducer();
    const entries: TranscriptEntry[] = [];
    for (const line of read.lines) entries.push(...reducer.push(line).added);
    // When: result updates, a summary, and an inclusive checkpoint arrive.
    const batches = [result("live", "first"), result("live", "first\nsecond"), row("compaction", { type: "tombstone", kind: "summarization", effectiveFromMessageId: "live-call" }), row("summary", { type: "assistant", operationType: "Summary", content: "Sample summary." }), say("removed", "Obsolete answer."), row("revert", { type: "tombstone", kind: "checkpoint_revert", effectiveFromMessageId: "removed" }), say("final", "Current answer.")];
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
