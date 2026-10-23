import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  isMuseSessionId,
  museJournal,
  museSessionNameReader,
  parseMuseTranscript,
  createMuseReducer,
} from "./muse.ts";
import type { JsonValue } from "../json.ts";
import { RENAME_TITLE_MAX } from "../mux/durable/clean.ts";

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

/** The on-disk slash-command row: a bare `/name` under `record.command`, no args or output field. */
function commandInvoked(id: string, command: JsonValue): string {
  return row(id, "command.invoked", {
    kind: "command_invoked",
    record: { schema_version: 1, session_id: UUID_A, command },
  });
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

  test("text blocks join across messages; a digest asset stays marked in words, never typed pixels", () => {
    const digest = "b".repeat(64);
    const entries = parseMuseTranscript(
      accepted("row-1", [
        textBlock("check this"),
        { kind: "asset", asset: { media_type: "image/png", byte_length: 42, digest } },
      ]),
    );
    // The log carries no pixels and /api/blobs only serves pi/omp attachments, so the
    // deficit is a text marker — never a broken image part.
    expect(entries[0]?.parts).toEqual([{ kind: "text", text: "check this\n\n[image attached]" }]);
  });

  test("an image-only turn survives on its marker alone", () => {
    const digest = "c".repeat(64);
    const entries = parseMuseTranscript(
      accepted("row-1", [
        { kind: "asset", asset: { media_type: "image/png", byte_length: 42, digest } },
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "[image attached]" }],
    });
  });

  test("an inline user image with pixels renders them; an unloadable one contributes no part", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const entries = parseMuseTranscript(
      accepted("row-1", [
        textBlock("see"),
        { kind: "image", media_type: "image/png", base64_data: png },
        { kind: "image", media_type: "image/png", base64_data: "http://evil.example/x.png" },
      ]),
    );
    expect(entries[0]?.parts).toEqual([
      { kind: "text", text: "see" },
      { kind: "image", url: `data:image/png;base64,${png}`, mimeType: "image/png" },
    ]);
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

describe("parseMuseTranscript slash commands", () => {
  test("a command.invoked row renders once, as the operator's own line", () => {
    const entries = parseMuseTranscript(commandInvoked("row-1", "/model"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      uuid: "row-1",
      ts: "2026-10-02T01:25:54.495Z",
      role: "user",
      parts: [{ kind: "text", text: "/model" }],
    });
  });

  test("a command between turns does not double with the accepted prompt beside it", () => {
    const entries = parseMuseTranscript(
      [
        accepted("row-1", [textBlock("do it")]),
        commandInvoked("row-2", "/compact"),
        runEvent("row-3", { kind: "assistant_message_committed", message_id: "m1", text: "done" }),
      ].join("\n"),
    );
    expect(entries.map((e) => e.uuid)).toEqual(["row-1", "row-2", "row-3"]);
    expect(entries[1]).toMatchObject({ role: "user", parts: [{ kind: "text", text: "/compact" }] });
  });

  test("malformed command rows render nothing", () => {
    const entries = parseMuseTranscript(
      [
        commandInvoked("row-1", ""),
        commandInvoked("row-2", "   "),
        commandInvoked("row-3", "model"),
        commandInvoked("row-4", 42),
        row("row-5", "command.invoked", { kind: "command_invoked" }),
        row("row-6", "command.invoked", {}),
      ].join("\n"),
    );
    expect(entries).toEqual([]);
  });

  test("command_intake plumbing is not a slash command and renders nothing", () => {
    const entries = parseMuseTranscript(
      [
        row("row-1", "runtime.command_intake.received", {
          kind: "command_intake",
          record: { kind: "received", command_id: "c1", command: { kind: "session_start" } },
        }),
        row("row-2", "runtime.command_intake.settled", {
          kind: "command_intake",
          record: { kind: "settled", command_id: "c1", outcome: { kind: "accepted" } },
        }),
      ].join("\n"),
    );
    expect(entries).toEqual([]);
  });
});

describe("parseMuseTranscript plain-text results carry no exit code (data-absent)", () => {
  // On disk, a numeric exit code exists ONLY inside the JSON-envelope result text; the batch item
  // itself is {tool_call_index, tool_call_id, text} and nothing else. A plain-text result therefore
  // renders verbatim with no code and no error flag — pinned here so a future log format that DOES
  // record one shows up as a failing test instead of a silently missed field.
  test("a plain-text bash result renders verbatim, with no exitCode and no isError", () => {
    const entries = parseMuseTranscript(
      [
        runEvent("row-1", {
          kind: "assistant_tool_calls_committed",
          message_id: "m1",
          tool_calls: [
            { id: "fc_0", call_id: "call_1", name: "bash", args: JSON.stringify({ command: "ls" }) },
          ],
        }),
        runEvent("row-2", {
          kind: "tool_result_batch_committed",
          message_id: "m1",
          results: [{ tool_call_index: 0, tool_call_id: "call_1", text: "a\nb" }],
        }),
      ].join("\n"),
    );
    const part = entries[0]?.parts[0];
    expect(part).toMatchObject({ kind: "tool", result: { text: "a\nb" } });
    expect(part).not.toMatchObject({ result: { isError: true } });
    expect(part != null && part.kind === "tool" && part.call?.kind === "execute" ? part.call.exitCode : "n/a").toBeUndefined();
  });

  test("an envelope without exit_code (the cancelled shape) unwraps its output, still no code", () => {
    const entries = parseMuseTranscript(
      [
        runEvent("row-1", {
          kind: "assistant_tool_calls_committed",
          message_id: "m1",
          tool_calls: [
            { id: "fc_0", call_id: "call_1", name: "bash_input", args: JSON.stringify({ chars: "x" }) },
          ],
        }),
        runEvent("row-2", {
          kind: "tool_result_batch_committed",
          message_id: "m1",
          results: [
            {
              tool_call_index: 0,
              tool_call_id: "call_1",
              text: JSON.stringify({ terminal_status: "cancelled", terminal_reason: "stopped", output: "partial" }),
            },
          ],
        }),
      ].join("\n"),
    );
    const part = entries[0]?.parts[0];
    expect(part).toMatchObject({ kind: "tool", result: { text: "partial" } });
    expect(part).not.toMatchObject({ result: { isError: true } });
  });
});

describe("parseMuseTranscript plain-text harness verdicts carry error state (MUSE-29)", () => {
  // The harness answers a refused or failed call in plain text — no JSON envelope, and no sampled
  // row records a number beside it (bridge/journal/muse.ts) — with its own verdict prefix. Chat and
  // History derive the card state from result.isError/result.denied, so without these flags a
  // refusal or a failure renders as a success.
  test("a plain-text `tool denied:` command result is denied, never an error, with no exit code", () => {
    const text = "tool denied: approval aborted\nThe user rejected this action.";
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [{ call_id: "call_1", name: "bash", args: { command: "rm -rf /" } }]),
        batchResults("row-2", [{ tool_call_id: "call_1", text }]),
      ].join("\n"),
    );
    const part = entries[0]?.parts[0];
    expect(part).toMatchObject({
      kind: "tool",
      result: { text, denied: true },
      call: { kind: "execute", command: "rm -rf /" },
    });
    expect(part).not.toMatchObject({ result: { isError: true } });
    if (part?.kind === "tool" && part.call?.kind === "execute") {
      expect(part.call).not.toHaveProperty("exitCode");
    } else throw new Error("expected an execute call");
  });

  test("a plain-text `tool failed:` command result is an error, with no invented exit code", () => {
    const text = "tool failed: unmanaged shell backgrounding is not allowed; use bash session_id polling instead";
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [{ call_id: "call_1", name: "bash", args: { command: "sleep 999 &" } }]),
        batchResults("row-2", [{ tool_call_id: "call_1", text }]),
      ].join("\n"),
    );
    const part = entries[0]?.parts[0];
    expect(part).toMatchObject({ kind: "tool", result: { text, isError: true } });
    expect(part).not.toMatchObject({ result: { denied: true } });
    if (part?.kind === "tool" && part.call?.kind === "execute") {
      expect(part.call).not.toHaveProperty("exitCode");
    } else throw new Error("expected an execute call");
  });

  test("the verdict prefix is the harness's, not prose: a near-miss stays flagless", () => {
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [{ call_id: "call_1", name: "bash", args: { command: "ls" } }]),
        batchResults("row-2", [{ tool_call_id: "call_1", text: "a tool failed: oops" }]),
      ].join("\n"),
    );
    const part = entries[0]?.parts[0];
    expect(part).toMatchObject({ kind: "tool", result: { text: "a tool failed: oops" } });
    expect(part).not.toMatchObject({ result: { isError: true } });
    expect(part).not.toMatchObject({ result: { denied: true } });
  });

  test("an orphan `tool failed:` result keeps its error state unattached", () => {
    const text = "tool failed: No such file or directory (os error 2)";
    const entries = parseMuseTranscript(batchResults("row-9", [{ tool_call_id: "call_x", text }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: "assistant",
      parts: [{ kind: "tool", name: "result", result: { text, isError: true } }],
    });
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

describe("parseMuseTranscript edit diffs, question answers and image assets (#519)", () => {
  // Shapes below mirror the corpus measured 2026-10-18 (3,114 edit_file results,
  // 112 request_user_input calls, 37 user assets), sanitised — see muse.ts.
  const EDIT_TEXT = [
    "edited",
    "changed lines: lines 2-3",
    "--- original",
    "+++ updated",
    "@@",
    "-const oldValue = 1;",
    "+const newValue = 2;",
    "+const extra = 3;",
  ].join("\n");

  test("an edit_file batch diff enriches the edit call with hunks and counts, never `created`", () => {
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [
          { call_id: "call_1", name: "edit_file", args: { path: "/a/b.ts", find: "old", replace: "new" } },
        ]),
        batchResults("row-2", [{ tool_call_id: "call_1", text: EDIT_TEXT }]),
      ].join("\n"),
    );
    const call = entries[0]?.parts?.[0];
    expect(call).toMatchObject({
      kind: "tool",
      call: {
        kind: "edit",
        path: "/a/b.ts",
        added: 2,
        removed: 1,
        diff: [{ header: "@@", lines: ["-const oldValue = 1;", "+const newValue = 2;", "+const extra = 3;"] }],
      },
    });
    expect(call).not.toMatchObject({ call: { created: true } });
    if (call?.kind === "tool" && call.call?.kind === "edit") expect(call.call).not.toHaveProperty("created");
  });

  test("an edit_file result with no diff lines leaves the call unenriched", () => {
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [{ call_id: "call_1", name: "edit_file", args: { path: "/a/b.ts", find: "x", replace: "y" } }]),
        batchResults("row-2", [{ tool_call_id: "call_1", text: "error: find text not found" }]),
      ].join("\n"),
    );
    const part = entries[0]?.parts?.[0];
    expect(part).toMatchObject({ call: { kind: "edit", path: "/a/b.ts", added: 0, removed: 0 } });
    if (part?.kind === "tool" && part.call?.kind === "edit") expect(part.call).not.toHaveProperty("diff");
  });

  test("a write_file result pins the data absence: no diff and no `created` is fabricated from the content arg", () => {
    // Muse's write_file batch text is only "wrote N bytes to <path>": no diff and
    // nothing tells a new file from an overwrite (Claude's `originalFile` has no Muse
    // counterpart), so the call must stay at its classified 0/0 with neither field.
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [
          { call_id: "call_1", name: "write_file", args: { path: "/a/new.ts", content: "one\ntwo\n" } },
        ]),
        batchResults("row-2", [{ tool_call_id: "call_1", text: "wrote 8 bytes to /a/new.ts" }]),
      ].join("\n"),
    );
    const part = entries[0]?.parts?.[0];
    expect(part).toMatchObject({ call: { kind: "edit", path: "/a/new.ts", added: 0, removed: 0 } });
    if (part?.kind === "tool" && part.call?.kind === "edit") {
      expect(part.call).not.toHaveProperty("diff");
      expect(part.call).not.toHaveProperty("created");
    } else throw new Error("expected an edit call");
  });

  const QUESTION_ARGS = {
    questions: [
      {
        id: "fruit",
        header: "Fruit",
        question: "Which fruit?",
        options: [
          { label: "Apple", description: "round" },
          { label: "Banana" },
        ],
      },
      {
        id: "extras",
        header: "Extras",
        question: "Any extras?",
        options: [{ label: "Nuts" }, { label: "Honey" }],
        selection: { mode: "multiple", min_selections: 0, max_selections: 2 },
      },
      {
        id: "note",
        header: "Note",
        question: "Anything else?",
        options: [{ label: "Nothing" }],
      },
    ],
  };

  test("a request_user_input batch answer lands on the question call, keyed by question id not order", () => {
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [{ call_id: "call_1", name: "request_user_input", args: QUESTION_ARGS }]),
        batchResults("row-2", [
          {
            tool_call_id: "call_1",
            text: JSON.stringify({
              status: "answered",
              answers: [
                { id: "note", free_text: "extra napkins" },
                { id: "extras", selected_labels: ["Nuts", "Honey"] },
                { id: "fruit", selected_label: "Banana" },
              ],
            }),
          },
        ]),
      ].join("\n"),
    );
    expect(entries[0]?.parts?.[0]).toMatchObject({
      kind: "tool",
      call: {
        kind: "question",
        questions: [{ multiple: false }, { multiple: true }, { multiple: false }],
        answers: [["Banana"], ["Nuts", "Honey"], ["extra napkins"]],
      },
    });
  });

  test("an interrupted request_user_input carries no answers", () => {
    const entries = parseMuseTranscript(
      [
        toolCalls("row-1", [{ call_id: "call_1", name: "request_user_input", args: QUESTION_ARGS }]),
        batchResults("row-2", [
          {
            tool_call_id: "call_1",
            text: JSON.stringify({ status: "interrupted", answers: [{ id: "fruit", selected_label: "Apple" }] }),
          },
        ]),
      ].join("\n"),
    );
    const part = entries[0]?.parts?.[0];
    expect(part).toMatchObject({ call: { kind: "question" } });
    if (part?.kind === "tool" && part.call?.kind === "question") expect(part.call).not.toHaveProperty("answers");
    else throw new Error("expected a question call");
  });

  test("Muse's own [Image #n] marker stays verbatim and is not named twice", () => {
    const digest = "a".repeat(64);
    const entries = parseMuseTranscript(
      accepted("row-1", [
        textBlock("look at [Image #1] please"),
        {
          kind: "asset",
          asset: {
            schema_version: 1,
            algorithm: "sha256",
            digest,
            media_type: "image/png",
            byte_length: 42,
            width: 10,
            height: 10,
          },
        },
      ]),
    );
    expect(entries[0]?.parts).toEqual([{ kind: "text", text: "look at [Image #1] please" }]);
  });

  test("a user asset keeps its marker, never invented pixels: a hash and a path become no data URL", () => {
    // The log carries only a content digest (+ sometimes a since-deleted source_path);
    // no blob store exists under Muse's data dirs and /api/blobs only serves pi/omp
    // attachments, so the deficit stays a text marker — and no data URL is fabricated.
    const digest = "b".repeat(64);
    const entries = parseMuseTranscript(
      accepted("row-1", [
        textBlock("check this"),
        {
          kind: "asset",
          asset: {
            schema_version: 1,
            algorithm: "sha256",
            digest,
            media_type: "image/png",
            byte_length: 42,
            width: 10,
            height: 10,
            source_path: "/tmp/no-longer-there.png",
          },
        },
      ]),
    );
    expect(entries[0]?.parts).toEqual([{ kind: "text", text: "check this\n\n[image attached]" }]);
    expect(JSON.stringify(entries)).not.toContain("data:image");
  });

  test("a non-image mime contributes no part", () => {
    const textOnly = parseMuseTranscript(
      accepted("row-1", [
        textBlock("check this"),
        {
          kind: "asset",
          asset: { media_type: "video/mp4", byte_length: 42, digest: "d".repeat(64) },
        },
      ]),
    );
    expect(textOnly[0]?.parts).toEqual([{ kind: "text", text: "check this" }]);
  });

  test("an image asset with a missing or malformed digest keeps its marker", () => {
    const entries = parseMuseTranscript(
      accepted("row-1", [
        textBlock("check this"),
        { kind: "asset", asset: { media_type: "image/png", byte_length: 42 } },
        { kind: "asset", asset: { media_type: "image/png", byte_length: 42, digest: "xyz" } },
      ]),
    );
    expect(entries[0]?.parts).toEqual([
      { kind: "text", text: "check this\n\n[image attached]\n\n[image attached]" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("data:image");
    expect(
      parseMuseTranscript(
        accepted("row-2", [{ kind: "asset", asset: { media_type: "image/png", digest: "xyz" } }]),
      )[0]?.parts,
    ).toEqual([{ kind: "text", text: "[image attached]" }]);
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

  test("foreground argv names the pane's own session across a shared cwd", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-09-14", UUID_A, [metadataRow("/same")]);
    const { utimesSync } = await import("node:fs");
    utimesSync(
      join(root, "2026", "09", "14", UUID_A, "session.jsonl"),
      new Date("2026-09-14T00:00:00Z"),
      new Date("2026-09-14T00:00:00Z"),
    );
    sessionLog(root, "2026-10-02", UUID_B, [metadataRow("/same")]);
    const adapter = museJournal([root]);
    // Without argv both panes would read B; with it each reads its own.
    await expect(
      adapter.discover?.("/same", { processes: [{ argv: ["muse", "resume", UUID_A] }] }),
    ).resolves.toEqual({ kind: "id", value: UUID_A });
    await expect(
      adapter.discover?.("/same", {
        processes: [{ argv: ["/Users/op/.local/bin/muse-bin-1.4.4-R5419.1", "resume", UUID_B] }],
      }),
    ).resolves.toEqual({ kind: "id", value: UUID_B });
  });

  test.each([
    ["muse", "the bare launcher"],
    ["/usr/local/bin/muse", "a pathed launcher"],
    ["muse-bin-1.4.4-R5419.1", "a versioned binary"],
    ["C:\\tools\\muse.exe", "a Windows path"],
    ["MUSE-BIN-9.EXE", "an upper-case Windows binary"],
  ])("argv0 %s reads as Muse (%s)", async (argv0) => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/same")]);
    const adapter = museJournal([root]);
    await expect(
      adapter.discover?.("/same", { processes: [{ argv: [argv0, "resume", UUID_A] }] }),
    ).resolves.toEqual({ kind: "id", value: UUID_A });
  });

  const FALLBACKS: { label: string; argvs: string[][] }[] = [
    { label: "another harness", argvs: [["code", "resume", UUID_A]] },
    { label: "a lookalike binary", argvs: [["my-muse-wrapper", "resume", UUID_A]] },
    { label: "resume --last", argvs: [["muse", "resume", "--last"]] },
    { label: "a fresh muse with no resume", argvs: [["muse"]] },
    { label: "a malformed id", argvs: [["muse", "resume", "not-a-uuid"]] },
    { label: "a non-resume subcommand", argvs: [["muse", "export", UUID_A]] },
    { label: "an empty foreground group", argvs: [] },
  ];
  for (const { label, argvs } of FALLBACKS) {
    test(`falls back to newest-wins on ${label}`, async () => {
      const root = await fixtureRoot();
      sessionLog(root, "2026-09-14", UUID_A, [metadataRow("/same")]);
      const { utimesSync } = await import("node:fs");
      utimesSync(
        join(root, "2026", "09", "14", UUID_A, "session.jsonl"),
        new Date("2026-09-14T00:00:00Z"),
        new Date("2026-09-14T00:00:00Z"),
      );
      sessionLog(root, "2026-10-02", UUID_B, [metadataRow("/same")]);
      const adapter = museJournal([root]);
      const processes = argvs.map((argv) => ({ argv }));
      await expect(adapter.discover?.("/same", { processes })).resolves.toEqual({
        kind: "id",
        value: UUID_B,
      });
    });
  }

  test("an upper-case uuid from argv is lower-cased", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/same")]);
    const adapter = museJournal([root]);
    await expect(
      adapter.discover?.("/same", { processes: [{ argv: ["muse", "resume", UUID_A.toUpperCase()] }] }),
    ).resolves.toEqual({ kind: "id", value: UUID_A });
  });

  // #508: with another muse pane in the folder, the newest log may be that pane's.
  test("a shared folder with no argv session reads no session, never the newest log", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/same")]);
    sessionLog(root, "2026-10-02", UUID_B, [metadataRow("/same")]);
    const adapter = museJournal([root]);
    await expect(adapter.discover?.("/same", { shared: true })).resolves.toBeNull();
    await expect(
      adapter.discover?.("/same", { shared: true, processes: [{ argv: ["muse"] }] }),
    ).resolves.toBeNull();
    await expect(
      adapter.discover?.("/same", { shared: true, processes: [{ argv: ["muse", "resume", "--last"] }] }),
    ).resolves.toBeNull();
  });

  test("a shared folder still reads the session the pane's argv names", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/same")]);
    sessionLog(root, "2026-10-02", UUID_B, [metadataRow("/same")]);
    const adapter = museJournal([root]);
    await expect(
      adapter.discover?.("/same", { shared: true, processes: [{ argv: ["muse", "resume", UUID_A] }] }),
    ).resolves.toEqual({ kind: "id", value: UUID_A });
  });

  test("the first argv match wins", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/same")]);
    sessionLog(root, "2026-10-02", UUID_B, [metadataRow("/same")]);
    const adapter = museJournal([root]);
    await expect(
      adapter.discover?.("/same", {
        processes: [{ argv: ["muse", "resume", UUID_A] }, { argv: ["muse", "resume", UUID_B] }],
      }),
    ).resolves.toEqual({ kind: "id", value: UUID_A });
  });
});

// The pane-name reader (MUSE-36). A Muse session's user-given name lives only in its own log:
// the last `session.name.changed` row, and only when that change came from the user — every
// session also carries an automatic name (`icy-chromosphere` and friends) that Muse never paints
// or titles, so surfacing it would name every pane at random. The reader binds a pane to a log
// ONLY exactly — a reported ref or a `resume <uuid>` argv — never the cwd walk `discover` falls
// back to, because a name read off a neighbouring session's log is worse than no name.
function nameRow(sessionId: string, newName: string | null, source: "user" | "automatic"): string {
  return row(`name-${newName ?? "none"}-${source}`, "session.name.changed", {
    authority_id: "auth-1",
    operation_id: "op-1",
    session_id: sessionId,
    previous_name: null,
    new_name: newName,
    source,
  });
}

describe("museSessionNameReader", () => {
  test("reads the user-given name from the pane's own log, bound by resume argv", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [
      metadataRow("/a"),
      nameRow(UUID_A, "cerulean-mirach", "automatic"),
      nameRow(UUID_A, "landing-page", "user"),
    ]);
    const reader = museSessionNameReader([root]);
    await expect(reader(undefined, [{ argv: ["muse", "resume", UUID_A] }])).resolves.toBe("landing-page");
  });

  test("reads it from a reported ref with no foreground argv at all", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/a"), nameRow(UUID_A, "landing-page", "user")]);
    const reader = museSessionNameReader([root]);
    await expect(reader({ kind: "id", value: UUID_A }, undefined)).resolves.toBe("landing-page");
  });

  test("an automatic name alone is no name: the session reads unnamed", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [
      metadataRow("/a"),
      nameRow(UUID_A, "cerulean-mirach", "automatic"),
    ]);
    const reader = museSessionNameReader([root]);
    await expect(reader({ kind: "id", value: UUID_A }, undefined)).resolves.toBeNull();
  });

  test("no exact binding says nothing, however many named logs share the folder", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/same"), nameRow(UUID_A, "not-yours", "user")]);
    const reader = museSessionNameReader([root]);
    // A fresh `muse` (bare argv) names no session, and the reader takes no cwd to guess from.
    await expect(reader(undefined, [{ argv: ["muse"] }])).resolves.toBeUndefined();
    await expect(reader(undefined, undefined)).resolves.toBeUndefined();
  });

  test("a rename appended after the first read is picked up on the next one", async () => {
    const root = await fixtureRoot();
    const path = sessionLog(root, "2026-10-02", UUID_A, [
      metadataRow("/a"),
      nameRow(UUID_A, "first-name", "user"),
    ]);
    const reader = museSessionNameReader([root]);
    const ref = { kind: "id", value: UUID_A } as const;
    await expect(reader(ref, undefined)).resolves.toBe("first-name");
    appendFileSync(path, `${nameRow(UUID_A, "second-name", "user")}\n`);
    await expect(reader(ref, undefined)).resolves.toBe("second-name");
  });

  test("a torn final row is not read until its newline lands", async () => {
    const root = await fixtureRoot();
    const path = sessionLog(root, "2026-10-02", UUID_A, [
      metadataRow("/a"),
      nameRow(UUID_A, "first-name", "user"),
    ]);
    const reader = museSessionNameReader([root]);
    const ref = { kind: "id", value: UUID_A } as const;
    await expect(reader(ref, undefined)).resolves.toBe("first-name");
    appendFileSync(path, nameRow(UUID_A, "torn-name", "user")); // no newline yet
    await expect(reader(ref, undefined)).resolves.toBe("first-name");
    appendFileSync(path, "\n");
    await expect(reader(ref, undefined)).resolves.toBe("torn-name");
  });

  test("the last change wins: an automatic change after a user rename unnames the session", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [
      metadataRow("/a"),
      nameRow(UUID_A, "landing-page", "user"),
      nameRow(UUID_A, "fresh-auto", "automatic"),
    ]);
    const reader = museSessionNameReader([root]);
    await expect(reader({ kind: "id", value: UUID_A }, undefined)).resolves.toBeNull();
  });

  test("a name row naming another session is ignored", async () => {
    const root = await fixtureRoot();
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/a"), nameRow(UUID_B, "someone-else", "user")]);
    const reader = museSessionNameReader([root]);
    await expect(reader({ kind: "id", value: UUID_A }, undefined)).resolves.toBeNull();
  });

  test("an exact id with no log on disk says nothing, not unnamed", async () => {
    const root = await fixtureRoot();
    const reader = museSessionNameReader([root]);
    await expect(reader({ kind: "id", value: UUID_A }, undefined)).resolves.toBeUndefined();
  });

  // #533 shipped the name as the log wrote it, trimmed and nothing else. It is agent-written text
  // that reaches the pane header, the dashboard and a push title, so it is cleaned like a pane title.
  test("a hostile name comes back one capped line with no control character", async () => {
    const root = await fixtureRoot();
    const hostile = `\x1b[31mred\x1b[0m first\nsecond${"x".repeat(30_000)}`;
    sessionLog(root, "2026-10-02", UUID_A, [metadataRow("/a"), nameRow(UUID_A, hostile, "user")]);
    const reader = museSessionNameReader([root]);
    const name = await reader({ kind: "id", value: UUID_A }, undefined);
    expect(typeof name).toBe("string");
    const shown = name ?? "";
    expect(shown.startsWith("red first second")).toBe(true);
    const controls = [...shown].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
    expect(controls).toEqual([]);
    expect([...shown].length).toBe(RENAME_TITLE_MAX);
    expect(shown.endsWith("…")).toBe(true);
  });
});
