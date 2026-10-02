import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { isMuseSessionId, museJournal, parseMuseTranscript, createMuseReducer } from "./muse.ts";
import type { JsonValue } from "../json.ts";

// Row builders mirroring the verified on-disk shape (bridge/journal/muse.ts header): the envelope
// fields the adapter reads plus the payload under test, nothing else.

const UUID_A = "01a0a28c-ba4b-76f2-a3d8-637a1b190f6a";
const UUID_B = "01a0a28c-ba4b-76f2-a3d8-637a1b190f6b";
const MICROS = 1790904354495081; // 2026-10-02T01:25:54.495Z

function row(id: string, payloadType: string, payload: JsonValue, recordedAt = MICROS): string {
  return JSON.stringify({
    schema_version: 1,
    id,
    stream: { kind: "session", id: UUID_A },
    sequence: 1,
    recorded_at: recordedAt,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  });
}

function accepted(id: string, blocks: JsonValue[]): string {
  return row(id, "runtime.user_intent.accepted", {
    surface: "main",
    semantic_kind: { kind: "chat" },
    model_messages: [{ role: "user", content: blocks }],
  });
}

function runEvent(id: string, event: JsonValue): string {
  return row(id, "runtime.session", { kind: "run", run_id: "run-1", event });
}

function taskEvent(id: string, event: JsonValue): string {
  return row(id, "runtime.session", { kind: "task", task_id: "task-1", event });
}

function textBlock(text: string): JsonValue {
  return { kind: "text", text };
}

describe("isMuseSessionId", () => {
  test.each([
    [UUID_A, true],
    [UUID_A.toUpperCase(), true],
    ["not-a-uuid", false],
    ["", false],
    ["../escape", false],
    ["/abs/path/session.jsonl", false],
    ["session.jsonl", false],
    [`${UUID_A}.json`, false],
    [`${UUID_A}\n${UUID_A}`, false],
  ])("%s -> %s", (value, expected) => {
    expect(isMuseSessionId(value)).toBe(expected);
  });
});

describe("parseMuseTranscript turns", () => {
  test("a user turn renders its text blocks verbatim, newlines intact", () => {
    const entries = parseMuseTranscript(
      accepted("row-1", [textBlock("first paragraph\n\nsecond paragraph")]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      uuid: "row-1",
      ts: "2026-10-02T01:25:54.495Z",
      role: "user",
      parts: [{ kind: "text", text: "first paragraph\n\nsecond paragraph" }],
    });
  });

  test("text blocks join across messages, image assets become marked placeholders", () => {
    const entries = parseMuseTranscript(
      accepted("row-1", [
        textBlock("check this"),
        { kind: "asset", asset: { media_type: "image/png", byte_length: 42 } },
      ]),
    );
    expect(entries[0]?.parts).toEqual([{ kind: "text", text: "check this\n\n[image attached]" }]);
  });

  test("run/started's prompt is not a second user turn", () => {
    const entries = parseMuseTranscript(
      [
        accepted("row-1", [textBlock("do it")]),
        runEvent("row-2", { kind: "started", prompt: "do it", run_id: "run-1" }),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.role).toBe("user");
  });

  test("assistant text and reasoning summaries render, deltas and encrypted rows do not", () => {
    const entries = parseMuseTranscript(
      [
        runEvent("row-1", { kind: "assistant_message_committed", message_id: "m1", text: "done" }),
        runEvent("row-2", { kind: "reasoning_summary_committed", message_id: "m0", text: "thinking" }),
        runEvent("row-3", { kind: "reasoning_summary_delta", message_id: "m0", text: "think" }),
        runEvent("row-4", {
          kind: "reasoning_committed",
          message_id: "m0",
          content: [{ kind: "encrypted", ciphertext: "zz" }],
        }),
      ].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: "assistant", parts: [{ kind: "text", text: "done" }] });
    expect(entries[1]).toMatchObject({
      role: "assistant",
      parts: [{ kind: "thinking", text: "thinking" }],
    });
  });

  test("empty speech rows are skipped", () => {
    const entries = parseMuseTranscript(
      [
        accepted("row-1", [textBlock("   ")]),
        runEvent("row-2", { kind: "assistant_message_committed", message_id: "m1", text: "" }),
      ].join("\n"),
    );
    expect(entries).toEqual([]);
  });

  test("a compaction install renders as a summary entry; other replacements do not", () => {
    const entries = parseMuseTranscript(
      [
        runEvent("row-1", {
          kind: "context_compaction_installed",
          replacement: { kind: "summary_text", text: "so far: everything" },
        }),
        runEvent("row-2", {
          kind: "context_compaction_installed",
          replacement: { kind: "future_kind", text: "not words" },
        }),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: "summary",
      parts: [{ kind: "text", text: "so far: everything" }],
    });
  });

  test("a subagent result renders as a note", () => {
    const entries = parseMuseTranscript(
      row("row-1", "subagent.control.result_ready", {
        kind: "control",
        record: { kind: "result_ready", subagent_id: "s1", summary: "findings", text: "findings!" },
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: "note",
      parts: [{ kind: "text", text: "findings!" }],
    });
  });

  test("structural rows are skipped without entries or unknowns", () => {
    const reducer = createMuseReducer();
    const marker = JSON.stringify({ retained_marker: { record_json: "{}" } });
    const frame = JSON.stringify({
      retained_frame: 1,
      children: [{ record_json: JSON.stringify({ payload_type: "permission.requested" }) }],
    });
    expect(reducer.push(marker)).toEqual({ added: [], changed: [] });
    expect(reducer.push(frame)).toEqual({ added: [], changed: [] });
    expect(reducer.push("")).toEqual({ added: [], changed: [] });
    expect(reducer.push("{oops")).toEqual({ added: [], changed: [] });
    expect(reducer.push("[1,2]")).toEqual({ added: [], changed: [] });
    expect(reducer.unknowns().rows.size).toBe(0);
    expect(reducer.unknowns().parts.size).toBe(0);
  });

  test("a transcript row without an id is skipped, never emitted unnamed", () => {
    const line = JSON.stringify({
      schema_version: 1,
      recorded_at: MICROS,
      payload_type: "runtime.session",
      payload: {
        kind: "run",
        event: { kind: "assistant_message_committed", message_id: "m1", text: "lost" },
      },
    });
    expect(parseMuseTranscript(line)).toEqual([]);
  });
});

function toolCalls(
  id: string,
  calls: { call_id?: string; name: string; args?: JsonValue }[],
): string {
  return runEvent(id, {
    kind: "assistant_tool_calls_committed",
    message_id: "m1",
    tool_calls: calls.map((c, i) => ({
      id: `fc_${i}`,
      call_id: c.call_id,
      name: c.name,
      args: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}),
    })),
  });
}

function batchResults(id: string, results: { tool_call_id: string; text: string }[]): string {
  return runEvent(id, { kind: "tool_result_batch_committed", message_id: "m1", results });
}

describe("parseMuseTranscript tool calls", () => {
  test("one row's calls share one entry; summaries come from the parsed args", () => {
    const entries = parseMuseTranscript(
      toolCalls("row-1", [
        { call_id: "call_1", name: "read_file", args: { path: "/a/b.ts" } },
        { call_id: "call_2", name: "bash", args: { command: "ls", description: "list" } },
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.parts).toMatchObject([
      { kind: "tool", name: "read_file", summary: "/a/b.ts", id: "call_1" },
      { kind: "tool", name: "bash", summary: "ls", id: "call_2" },
    ]);
  });

  test("unparseable args fall back to one line of the raw string", () => {
    const entries = parseMuseTranscript(
      runEvent("row-1", {
        kind: "assistant_tool_calls_committed",
        message_id: "m1",
        tool_calls: [{ id: "fc_0", call_id: "call_1", name: "bash", args: "not { json" }],
      }),
    );
    expect(entries[0]?.parts).toMatchObject([{ kind: "tool", summary: "not { json" }]);
  });

  test("a batch result attaches to its call and names the turn changed", () => {
    const reducer = createMuseReducer();
    reducer.push(toolCalls("row-1", [{ call_id: "call_1", name: "bash", args: { command: "ls" } }]));
    const out = reducer.push(batchResults("row-2", [{ tool_call_id: "call_1", text: "a\nb" }]));
    expect(out).toEqual({ added: [], changed: ["row-1"] });
    // The attachment is observable through the emitted entry's part.
  });

  test("a bash envelope unwraps to its output; a non-zero exit is an error with a code", () => {
    const reducer = createMuseReducer();
    const added = reducer.push(
      toolCalls("row-1", [{ call_id: "call_1", name: "bash", args: { command: "false" } }]),
    ).added;
    reducer.push(
      batchResults("row-2", [
        {
          tool_call_id: "call_1",
          text: JSON.stringify({ chunk_id: "x", command: "false", exit_code: 1, output: "nope" }),
        },
      ]),
    );
    const part = added[0]?.parts[0];
    expect(part).toMatchObject({
      kind: "tool",
      result: { text: "nope", isError: true },
      call: { kind: "execute", command: "false", exitCode: 1 },
    });
  });

  test("a zero exit is not an error", () => {
    const reducer = createMuseReducer();
    const added = reducer.push(
      toolCalls("row-1", [{ call_id: "call_1", name: "bash", args: { command: "true" } }]),
    ).added;
    reducer.push(
      batchResults("row-2", [
        {
          tool_call_id: "call_1",
          text: JSON.stringify({ command: "true", exit_code: 0, output: "yep" }),
        },
      ]),
    );
    const part = added[0]?.parts[0];
    expect(part).toMatchObject({ kind: "tool", result: { text: "yep" } });
    expect(part).not.toMatchObject({ result: { isError: true } });
  });

  test("a read_result summary unwraps only for read_result calls", () => {
    const reducer = createMuseReducer();
    reducer.push(
      toolCalls("row-1", [
        { call_id: "call_1", name: "subagent_read_result", args: { subagent_id: "s1" } },
        { call_id: "call_2", name: "web_search", args: { query: "q" } },
      ]),
    );
    const summary = JSON.stringify({ status: "ready", summary: "the findings" });
    reducer.push(
      batchResults("row-2", [
        { tool_call_id: "call_1", text: summary },
        { tool_call_id: "call_2", text: summary },
      ]),
    );
    // Re-parse to read the attached results (same rows, fresh reducer).
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [
          { call_id: "call_1", name: "subagent_read_result", args: { subagent_id: "s1" } },
          { call_id: "call_2", name: "web_search", args: { query: "q" } },
        ]),
        batchResults("row-2", [
          { tool_call_id: "call_1", text: summary },
          { tool_call_id: "call_2", text: summary },
        ]),
      ].join("\n"),
    );
    expect(entries[0]?.parts?.[0]).toMatchObject({ result: { text: "the findings" } });
    expect(entries[0]?.parts?.[1]).toMatchObject({ result: { text: summary } });
  });

  test("an orphan result is kept unattached, never dropped", () => {
    const entries = parseMuseTranscript(batchResults("row-9", [{ tool_call_id: "call_x", text: "late" }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: "assistant",
      parts: [{ kind: "tool", name: "result", result: { text: "late" } }],
    });
  });

  test("a refusal stands in as a denied stub until the batch overwrites it", () => {
    const reducer = createMuseReducer();
    const added = reducer.push(
      toolCalls("row-1", [{ call_id: "call_1", name: "bash", args: { command: "rm -rf /" } }]),
    ).added;
    const denied = reducer.push(
      row("row-2", "runtime.session", {
        kind: "approval",
        approval_id: "a1",
        event: { kind: "decision_applied", decision: "denied", tool_call_id: "call_1" },
      }),
    );
    expect(denied).toEqual({ added: [], changed: ["row-1"] });
    expect(added[0]?.parts[0]).toMatchObject({ result: { text: "", denied: true } });
    reducer.push(batchResults("row-3", [{ tool_call_id: "call_1", text: "refused by operator" }]));
    expect(added[0]?.parts[0]).toMatchObject({
      result: { text: "refused by operator", denied: true },
    });
  });

  test("an approval changes nothing", () => {
    const reducer = createMuseReducer();
    reducer.push(toolCalls("row-1", [{ call_id: "call_1", name: "bash", args: {} }]));
    const out = reducer.push(
      row("row-2", "runtime.session", {
        kind: "approval",
        approval_id: "a1",
        event: { kind: "decision_applied", decision: "approved", tool_call_id: "call_1" },
      }),
    );
    expect(out).toEqual({ added: [], changed: [] });
  });

  test("a failed task flags its call's result, via the lifecycle linkage", () => {
    const reducer = createMuseReducer();
    const added = reducer.push(
      toolCalls("row-1", [{ call_id: "call_1", name: "web_fetch", args: { url: "https://x" } }]),
    ).added;
    reducer.push(
      row("row-2", "tool_batch.effect.terminal", {
        record: { kind: "terminal", task_id: "task-1", call_id: "call_1" },
      }),
    );
    const failed = reducer.push(taskEvent("row-3", { kind: "failed", task_id: "task-1", reason: "HTTP 404" }));
    expect(failed).toEqual({ added: [], changed: ["row-1"] });
    expect(added[0]?.parts[0]).toMatchObject({ result: { text: "HTTP 404", isError: true } });
    reducer.push(batchResults("row-4", [{ tool_call_id: "call_1", text: "fetch failed: HTTP 404" }]));
    expect(added[0]?.parts[0]).toMatchObject({
      result: { text: "fetch failed: HTTP 404", isError: true },
    });
  });

  test("an image arriving before its batch is stashed, then attached with it", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [{ call_id: "call_1", name: "read_file", args: { path: "/a.png" } }]),
        runEvent("row-2", {
          kind: "tool_result_model_visible_content",
          message_id: "m1",
          call_id: "call_1",
          content: [{ kind: "image", path: "/a.png", media_type: "image/png", base64_data: png }],
        }),
        batchResults("row-3", [{ tool_call_id: "call_1", text: "a picture" }]),
      ].join("\n"),
    );
    expect(entries[0]?.parts?.[0]).toMatchObject({
      result: { text: "a picture", imageUrl: `data:image/png;base64,${png}` },
    });
  });

  test("an image arriving after its batch mutates the turn and names it changed", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const reducer = createMuseReducer();
    reducer.push(toolCalls("row-1", [{ call_id: "call_1", name: "read_file", args: {} }]));
    reducer.push(batchResults("row-2", [{ tool_call_id: "call_1", text: "a picture" }]));
    const out = reducer.push(
      runEvent("row-3", {
        kind: "tool_result_model_visible_content",
        message_id: "m1",
        call_id: "call_1",
        content: [{ kind: "image", path: "/a.png", media_type: "image/png", base64_data: png }],
      }),
    );
    expect(out).toEqual({ added: [], changed: ["row-1"] });
  });

  test("visible text alongside an image is not rendered twice", () => {
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [{ call_id: "call_1", name: "read_file", args: {} }]),
        runEvent("row-2", {
          kind: "tool_result_model_visible_content",
          message_id: "m1",
          call_id: "call_1",
          content: [{ kind: "text", text: "same words" }],
        }),
        batchResults("row-3", [{ tool_call_id: "call_1", text: "same words" }]),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.parts?.[0]).toMatchObject({ result: { text: "same words" } });
  });
});

describe("createMuseReducer queue and unknowns", () => {
  test("queued bodies list until their drain, oldest-first on duplicates", () => {
    const reducer = createMuseReducer();
    expect(reducer.queued?.()).toEqual([]);
    reducer.push(runEvent("row-1", { kind: "inbox_item_queued", body: "first" }));
    reducer.push(runEvent("row-2", { kind: "inbox_item_queued", body: "second" }));
    expect(reducer.queued?.()).toEqual(["first", "second"]);
    reducer.push(
      runEvent("row-3", { kind: "inbox_item_drained", delivery_snapshot: { body: "first" } }),
    );
    expect(reducer.queued?.()).toEqual(["second"]);
    // A drain for a body never queued removes nothing.
    reducer.push(
      runEvent("row-4", { kind: "inbox_item_drained", delivery_snapshot: { body: "ghost" } }),
    );
    expect(reducer.queued?.()).toEqual(["second"]);
  });

  test("queued bodies are a snapshot: the caller cannot mutate the queue", () => {
    const reducer = createMuseReducer();
    reducer.push(runEvent("row-1", { kind: "inbox_item_queued", body: "held" }));
    const held = [...(reducer.queued?.() ?? [])];
    held.push("smuggled");
    expect(reducer.queued?.()).toEqual(["held"]);
  });
});

function sessionLog(root: string, date: string, uuid: string, lines: string[]): string {
  const [year = "", month = "", day = ""] = date.split("-");
  const dir = join(root, year, month, day, uuid);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** Containment runs on realpaths, so the fixture root is realpathed before anything compares. */
async function fixtureRoot(): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(mkdtempSync(join(tmpdir(), "muse-journal-")));
}

function metadataRow(root: string): string {
  return row("meta-1", "runtime.session.metadata", {
    record: { kind: "metadata", workspace_root: root },
  });
}

describe("MuseTranscriptSource resolve", () => {
  test("resolves a session id to its log, newest date first", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-09-14", UUID_A, [metadataRow("/a")]);
    const newPath = sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/a")]);
    const source = museJournal([root]).source;
    await expect(source.resolve({ kind: "id", value: UUID_A })).resolves.toBe(newPath);
  });

  test("matches the uuid case-insensitively", async () => {
    const root = await fixtureRoot();
    const path = sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/a")]);
    const source = museJournal([root]).source;
    await expect(source.resolve({ kind: "id", value: UUID_A.toUpperCase() })).resolves.toBe(path);
  });

  test.each([
    [{ kind: "path", value: "/etc/passwd" } as const, "a path ref"],
    [{ kind: "id", value: "../escape" } as const, "a traversal id"],
    [{ kind: "id", value: UUID_B } as const, "an unknown id"],
  ])("resolve returns null for %s", async (ref) => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/a")]);
    const source = museJournal([root]).source;
    await expect(source.resolve(ref)).resolves.toBeNull();
  });

  test("never resolves into a subagent subtree", async () => {
    const root = await fixtureRoot();
    const sub = join(root, "2026", "10", "02", UUID_A, "subagent", UUID_B);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "session.jsonl"), `${metadataRow("/a")}\n`);
    const source = museJournal([root]).source;
    await expect(source.resolve({ kind: "id", value: UUID_B })).resolves.toBeNull();
  });

  test("a log symlinked out of its root is refused", async () => {
    const root = await fixtureRoot();
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, `${metadataRow("/a")}\n`);
    const dir = join(root, "2026", "10", "02", UUID_A);
    mkdirSync(dir, { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(dir, "session.jsonl"));
    const source = museJournal([join(root, "2026")]).source;
    await expect(source.resolve({ kind: "id", value: UUID_A })).resolves.toBeNull();
  });
});

describe("museJournal discover", () => {
  test("finds the newest session whose root equals the cwd", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-09-14", UUID_A, [metadataRow("/a")]);
    sessionLog(root, "2026-10-02", UUID_B, [metadataRow("/b")]);
    const adapter = museJournal([root]);
    await expect(adapter.discover?.("/b")).resolves.toEqual({ kind: "id", value: UUID_B });
    await expect(adapter.discover?.("/a")).resolves.toEqual({ kind: "id", value: UUID_A });
    await expect(adapter.discover?.("/nowhere")).resolves.toBeNull();
    await expect(adapter.discover?.("")).resolves.toBeNull();
  });

  test("two sessions sharing one cwd resolve to the newest", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-09-14", UUID_A, [metadataRow("/same")]);
    const { utimesSync } = await import("node:fs");
    const oldPath = join(root, "2026", "09", "14", UUID_A, "session.jsonl");
    const past = new Date("2026-09-14T00:00:00Z");
    utimesSync(oldPath, past, past);
    sessionLog(root, "2026-09-14", UUID_B, [metadataRow("/same")]);
    const adapter = museJournal([root]);
    await expect(adapter.discover?.("/same")).resolves.toEqual({ kind: "id", value: UUID_B });
  });

  test("a newer subagent log never shadows its session", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-09-14", UUID_A, [metadataRow("/same")]);
    const { utimesSync } = await import("node:fs");
    utimesSync(
      join(root, "2026", "09", "14", UUID_A, "session.jsonl"),
      new Date("2026-09-14T00:00:00Z"),
      new Date("2026-09-14T00:00:00Z"),
    );
    const sub = join(root, "2026", "10", "02", UUID_A, "subagent", UUID_B);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "session.jsonl"), `${metadataRow("/same")}\n`);
    const adapter = museJournal([root]);
    // The subagent log is newer and matches — and must still lose.
    await expect(adapter.discover?.("/same")).resolves.toEqual({ kind: "id", value: UUID_A });
  });
});
