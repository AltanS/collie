import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPiReducer,
  isBlobHash,
  isPiSessionId,
  parsePiTranscript,
  PiTranscriptSource,
  resolveBlobPath,
  resolveImageUrl,
} from "./pi.ts";
import { MAX_TEXT_CHARS } from "./text.ts";
import type { ToolCall } from "./tool-call.ts";
import type { TranscriptPart } from "./types.ts";

/**
 * Any JSON document — what a row of an agent's on-disk log actually is, before the adapter parses
 * it. Object values admit `undefined` because `JSON.stringify` drops such a key entirely, which is
 * how the fixtures below express "this field is absent".
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

// Row builders mirroring the verified on-disk shape (pi session logs, session format v3, 2026-07-29).
// Every row carries its own `id`, so unlike Codex there is nothing to synthesise for paging.
const row = (id: string, message: Record<string, JsonValue>) =>
  JSON.stringify({
    type: "message",
    id,
    parentId: "p0",
    timestamp: "2026-07-29T10:00:00.000Z",
    message,
  });

const speech = (id: string, role: "user" | "assistant", text: string) =>
  row(id, { role, content: [{ type: "text", text }] });

const header = () =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: "019f1827-bf99-7927-9684-76318de905b5",
    timestamp: "2026-07-29T10:00:00.000Z",
    cwd: "/repo",
  });

describe("isPiSessionId", () => {
  test.each([
    ["a v4 uuid", "715d7796-b4de-4f46-a11c-fbbdd8ca965b", true],
    ["a v7 uuid", "019f4665-7df0-7540-a64f-7068335f21af", true],
    ["a traversal attempt", "../../secrets", false],
  ])("%s → %s", (_label, value, expected) => {
    expect(isPiSessionId(value)).toBe(expected);
  });
});

describe("parsePiTranscript", () => {
  test("reads speech turns and ignores the session header", () => {
    const entries = parsePiTranscript(
      [header(), speech("a", "user", "go ahead"), speech("b", "assistant", "on it")].join("\n"),
    );
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["a", "user"],
      ["b", "assistant"],
    ]);
  });

  test.each([
    ["model_change", { type: "model_change", id: "m", modelId: "x", provider: "y" }],
    ["thinking_level_change", { type: "thinking_level_change", id: "t", thinkingLevel: "high" }],
  ])("%s is bookkeeping and renders nothing", (_label, r) => {
    expect(parsePiTranscript(JSON.stringify(r))).toEqual([]);
  });

  test("a thinking block renders — pi persists real reasoning text", () => {
    const entries = parsePiTranscript(
      row("a", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "**Identifying single subagent call**", thinkingSignature: "{}" },
        ],
      }),
    );
    expect(entries[0]!.parts).toEqual([
      { kind: "thinking", text: "**Identifying single subagent call**" },
    ]);
  });

  test("an image block in turn content renders as an image part", () => {
    const entries = parsePiTranscript(
      row("a", {
        role: "assistant",
        content: [
          { type: "image", data: "abcd1234", mimeType: "image/png" },
        ],
      }),
    );
    expect(entries[0]!.parts).toEqual([
      { kind: "image", url: "data:image/png;base64,abcd1234", mimeType: "image/png" },
    ]);
  });

  // A journal is an AGENT's own output, so a URL in it is untrusted content. A remote one would
  // make the phone fetch an arbitrary host on the agent's word, from a page inside the tailnet.
  test("a remote image URL contributes no part at all", () => {
    for (const data of ["http://evil.example/x.png", "https://evil.example/x.png"]) {
      const entries = parsePiTranscript(
        row("a", { role: "assistant", content: [{ type: "image", data, mimeType: "image/png" }] }),
      );
      expect(entries).toEqual([]);
    }
  });

  test("a toolResult with image content maps to imageUrl on the tool part", () => {
    const entries = parsePiTranscript(
      [
        row("a", {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_img", name: "screenshot", arguments: {} }],
        }),
        row("b", {
          role: "toolResult",
          toolCallId: "call_img",
          toolName: "screenshot",
          content: [{ type: "image", data: "base64data", mimeType: "image/webp" }],
        }),
      ].join("\n"),
    );
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      result: { imageUrl: "data:image/webp;base64,base64data" },
    });
  });
  test("a toolResult with blob:sha256: content maps to /api/blobs/<hash>", () => {
    const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const entries = parsePiTranscript(
      [
        row("a", {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_blob", name: "view", arguments: {} }],
        }),
        row("b", {
          role: "toolResult",
          toolCallId: "call_blob",
          toolName: "view",
          content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }],
        }),
      ].join("\n"),
    );
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      result: { imageUrl: `/api/blobs/${hash}` },
    });
  });

  test("a toolCall summarises from its arguments OBJECT (no JSON string, unlike codex)", () => {
    const entries = parsePiTranscript(
      row("a", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/repo/SKILL.md" } },
        ],
      }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      name: "read",
      summary: "/repo/SKILL.md",
    });
  });

  // pi puts a tool result in its OWN row (Claude nests it inside a user turn), linked by toolCallId.
  test("a toolResult row folds onto the call that produced it", () => {
    const entries = parsePiTranscript(
      [
        row("a", {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/x" } }],
        }),
        row("b", {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        }),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts[0]).toMatchObject({ kind: "tool", result: { text: "file contents" } });
  });

  test("an errored toolResult keeps its error flag", () => {
    const entries = parsePiTranscript(
      [
        row("a", {
          role: "assistant",
          content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }],
        }),
        row("b", {
          role: "toolResult",
          toolCallId: "c",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: "ENOENT" }],
        }),
      ].join("\n"),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ result: { text: "ENOENT", isError: true } });
  });

  test("an orphan toolResult is kept unattached so the window never drops output", () => {
    const entries = parsePiTranscript(
      row("b", {
        role: "toolResult",
        toolCallId: "gone",
        toolName: "read",
        content: [{ type: "text", text: "stranded" }],
      }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ kind: "tool", name: "read", result: { text: "stranded" } });
  });

  test("a clipped or partial line is skipped, not thrown on", () => {
    expect(parsePiTranscript(['{"type":"mess', speech("a", "user", "hi")].join("\n"))).toHaveLength(1);
  });
});

// The STRUCTURED call (tool-call.ts) beside `name`/`summary`. Rows are hand-written against the
// shapes read off 44 real pi sessions on 2026-09-29 — pi's `details.patch` unified diff, its
// `details.answer`, and the `Command exited with code N` tail it appends to a failed `bash`.
// pi's OTHER rows, and the branch chain. Every shape below was verified by driving pi 0.87.1's own
// `SessionManager` to write a session holding all of them, with no model call: `appendMessage` with
// `role: "bashExecution"`, `appendCustomMessageEntry` with `display` both ways, `appendCompaction`,
// `branch` and `branchWithSummary`. They are absent from one operator's 44 logs only because that
// operator never ran `/compact` and never rewound; absence in a habit is not absence in a format.
const plain = (id: string, parentId: string | null, body: Record<string, JsonValue>) =>
  JSON.stringify({ id, parentId, timestamp: "2026-09-30T12:00:00.000Z", ...body });
const msg = (id: string, parentId: string | null, message: Record<string, JsonValue>) =>
  plain(id, parentId, { type: "message", message });

describe("parsePiTranscript — pi's own history rows", () => {
  test("a compaction is a summary, because the model wrote it about its own history", () => {
    const log = plain("c1", "m1", { type: "compaction", summary: "What happened so far.", firstKeptEntryId: "m1", tokensBefore: 1234 });
    expect(parsePiTranscript(log)).toEqual([
      { uuid: "c1", ts: "2026-09-30T12:00:00.000Z", role: "summary", parts: [{ kind: "text", text: "What happened so far." }] },
    ]);
  });

  test("a branch summary is a summary too, and it is ON the branch it starts", () => {
    const log = [
      msg("m1", null, { role: "user", content: [{ type: "text", text: "one" }] }),
      plain("b1", "m1", { type: "branch_summary", summary: "The path not taken.", fromId: "m1" }),
    ].join("\n");
    const entries = parsePiTranscript(log);
    expect(entries.map((e) => [e.uuid, e.role, e.abandoned])).toEqual([
      ["m1", "user", undefined],
      ["b1", "summary", undefined],
    ]);
  });

  test("a compaction does NOT abandon the turns it summarised", () => {
    // Claude's and opencode's readers keep them on screen too, so pi must not differ.
    const log = [
      msg("m1", null, { role: "user", content: [{ type: "text", text: "one" }] }),
      plain("c1", "m1", { type: "compaction", summary: "so far", firstKeptEntryId: "m1", tokensBefore: 9 }),
      msg("m2", "c1", { role: "user", content: [{ type: "text", text: "two" }] }),
    ].join("\n");
    expect(parsePiTranscript(log).every((e) => e.abandoned === undefined)).toBe(true);
  });

  test("a custom message the operator was shown is a note; one they were not is dropped", () => {
    const log = [
      plain("x1", null, { type: "custom_message", customType: "probe", display: true, content: "shown" }),
      plain("x2", "x1", { type: "custom_message", customType: "probe", display: false, content: "hidden" }),
    ].join("\n");
    expect(parsePiTranscript(log)).toEqual([
      { uuid: "x1", ts: "2026-09-30T12:00:00.000Z", role: "note", parts: [{ kind: "text", text: "shown" }] },
    ]);
  });

  test("a custom message's content may be blocks instead of a string", () => {
    const log = plain("x1", null, { type: "custom_message", customType: "probe", display: true, content: [{ type: "text", text: "in a block" }] });
    expect(parsePiTranscript(log)[0]?.parts[0]).toEqual({ kind: "text", text: "in a block" });
  });

  test("a desk !command is a note carrying a bash tool call, never speech", () => {
    const log = msg("m1", null, { role: "bashExecution", command: "echo probe", output: "probe\n", exitCode: 0, cancelled: false, truncated: false });
    const entry = parsePiTranscript(log)[0];
    expect(entry?.role).toBe("note");
    expect(entry?.parts[0]).toMatchObject({
      kind: "tool",
      name: "bash",
      call: { kind: "execute", command: "echo probe", exitCode: 0 },
      // The output as pi wrote it, trailing newline and all, exactly as every other tool result here.
      result: { text: "probe\n" },
    });
  });

  test("a !command that failed or was cancelled reads as an error, not as a refusal", () => {
    const failed = msg("m1", null, { role: "bashExecution", command: "false", output: "", exitCode: 1, cancelled: false });
    const stopped = msg("m2", null, { role: "bashExecution", command: "sleep 9", output: "", exitCode: 0, cancelled: true });
    for (const log of [failed, stopped]) {
      const part = parsePiTranscript(log)[0]?.parts[0];
      expect(part?.kind).toBe("tool");
      if (part?.kind === "tool") {
        expect(part.result?.isError).toBe(true);
        expect(part.result?.denied).toBeUndefined();
      }
    }
  });

  test("pi's context injection is refused by name, not collapsed into the operator's speech", () => {
    // `content` is a STRING here, plus `sections` and `toolsAdded`, so it used to fall through to
    // `user` and yield nothing by accident. Now it is declined on purpose.
    const log = msg("m1", null, { role: "system", content: "tools added", sections: [], toolsAdded: ["bash"] });
    expect(parsePiTranscript(log)).toEqual([]);
  });
});

describe("parsePiTranscript — the branch chain", () => {
  test("a rewind marks the turns that left, and the new branch is clean", () => {
    const log = [
      msg("m1", null, { role: "user", content: [{ type: "text", text: "first" }] }),
      msg("m2", "m1", { role: "assistant", content: [{ type: "text", text: "one" }] }),
      msg("m3", "m2", { role: "user", content: [{ type: "text", text: "second" }] }),
      // The rewind: this row hangs off m1, not off m3.
      msg("m4", "m1", { role: "user", content: [{ type: "text", text: "again" }] }),
    ].join("\n");
    expect(parsePiTranscript(log).map((e) => [e.uuid, e.abandoned])).toEqual([
      ["m1", undefined],
      ["m2", true],
      ["m3", true],
      ["m4", undefined],
    ]);
  });

  test("a rewind BACK onto an abandoned turn clears its mark", () => {
    // The case no remove verb could express, and the reason this is a flag reported through
    // `changed` rather than a `removed` list (ADR 0073's addendum).
    const log = [
      msg("m1", null, { role: "user", content: [{ type: "text", text: "first" }] }),
      msg("m2", "m1", { role: "user", content: [{ type: "text", text: "left" }] }),
      msg("m3", "m1", { role: "user", content: [{ type: "text", text: "right" }] }),
      msg("m4", "m2", { role: "user", content: [{ type: "text", text: "back on left" }] }),
    ].join("\n");
    expect(parsePiTranscript(log).map((e) => [e.uuid, e.abandoned])).toEqual([
      ["m1", undefined],
      ["m2", undefined],
      ["m3", true],
      ["m4", undefined],
    ]);
  });

  test("the reducer names every turn whose mark it flipped", () => {
    const reducer = createPiReducer();
    reducer.push(msg("m1", null, { role: "user", content: [{ type: "text", text: "first" }] }));
    reducer.push(msg("m2", "m1", { role: "assistant", content: [{ type: "text", text: "one" }] }));
    reducer.push(msg("m3", "m2", { role: "user", content: [{ type: "text", text: "second" }] }));
    const rewind = reducer.push(msg("m4", "m1", { role: "user", content: [{ type: "text", text: "again" }] }));
    expect(rewind.added.map((e) => e.uuid)).toEqual(["m4"]);
    expect([...rewind.changed].toSorted()).toEqual(["m2", "m3"]);
  });

  test("the session header is not a link, so the first row is not a rewind", () => {
    // Its `id` is the SESSION's uuid and the first message's parent is `null`, not that id.
    const log = [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-30T12:00:00.000Z", cwd: "/tmp" }),
      msg("m1", null, { role: "user", content: [{ type: "text", text: "first" }] }),
      msg("m2", "m1", { role: "user", content: [{ type: "text", text: "second" }] }),
    ].join("\n");
    expect(parsePiTranscript(log).every((e) => e.abandoned === undefined)).toBe(true);
  });

  test("a row that draws nothing is still a link, so the branch after it survives", () => {
    // `model_change` renders nothing and is somebody's parent. If the chain skipped it, the next row
    // would look like a rewind and abandon the live branch.
    const log = [
      msg("m1", null, { role: "user", content: [{ type: "text", text: "first" }] }),
      plain("k1", "m1", { type: "model_change", model: "m" }),
      msg("m2", "k1", { role: "user", content: [{ type: "text", text: "second" }] }),
    ].join("\n");
    expect(parsePiTranscript(log).map((e) => [e.uuid, e.abandoned])).toEqual([
      ["m1", undefined],
      ["m2", undefined],
    ]);
  });

  test("a tail read that starts mid-conversation abandons nothing", () => {
    // The first row's parent is not in the chain, and nothing is held yet, so there is nothing to
    // mark. A window that opened in the middle must not paint its whole first screen as abandoned.
    const log = [
      msg("m9", "m8", { role: "user", content: [{ type: "text", text: "mid" }] }),
      msg("m10", "m9", { role: "assistant", content: [{ type: "text", text: "on" }] }),
    ].join("\n");
    expect(parsePiTranscript(log).every((e) => e.abandoned === undefined)).toBe(true);
  });

  test("a stop note leaves the branch with the turn it belongs to", () => {
    const log = [
      msg("m1", null, { role: "user", content: [{ type: "text", text: "first" }] }),
      msg("m2", "m1", { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" }),
      msg("m3", "m1", { role: "user", content: [{ type: "text", text: "again" }] }),
    ].join("\n");
    expect(parsePiTranscript(log).map((e) => [e.uuid, e.abandoned])).toEqual([
      ["m1", undefined],
      ["m2:stop", true],
      ["m3", undefined],
    ]);
  });
});

// A turn pi ENDED BADLY. Measured over 44 real sessions on 2026-09-30: 37 `error` rows, every one
// with zero content blocks, and 15 `aborted` rows, 10 of them empty and 5 carrying what the model got
// out first. All 52 carry `errorMessage`, which this reader dropped in silence until now. The empty
// case is the fault: the turn rendered nothing, so the failure was invisible.
describe("parsePiTranscript — a turn that ended badly", () => {
  test("an errored turn with no content is a note, where it used to be nothing at all", () => {
    const log = [
      row("m1", { role: "user", content: [{ type: "text", text: "go" }] }),
      row("m2", { role: "assistant", content: [], stopReason: "error", errorMessage: "API error: 529 overloaded" }),
    ].join("\n");
    const entries = parsePiTranscript(log);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      uuid: "m2:stop",
      role: "note",
      parts: [{ kind: "text", text: "API error: 529 overloaded" }],
    });
  });

  test("an aborted turn keeps what the model got out, and the note comes after it", () => {
    const log = row("m1", {
      role: "assistant",
      content: [{ type: "text", text: "starting" }],
      stopReason: "aborted",
      errorMessage: "Operation aborted",
    });
    const entries = parsePiTranscript(log);
    // Two entries off ONE row, which is why the note needs a uuid of its own.
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["m1", "assistant"],
      ["m1:stop", "note"],
    ]);
    expect(entries[0]?.parts[0]).toMatchObject({ kind: "text", text: "starting" });
  });

  test("the message is passed through as pi wrote it, with no prefix of ours", () => {
    const log = row("m1", { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" });
    const part = parsePiTranscript(log)[0]?.parts[0];
    expect(part).toEqual({ kind: "text", text: "boom" });
  });

  // NEGATIVE CONTROLS. A note under every turn would be worse than no note at all.
  test.each([["toolUse"], ["stop"]])("`%s` is a normal ending and says nothing", (reason) => {
    const log = row("m1", {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: reason,
      errorMessage: "ignored",
    });
    expect(parsePiTranscript(log).map((e) => e.uuid)).toEqual(["m1"]);
  });

  test("a bad ending with no message says nothing either", () => {
    const empty = row("m1", { role: "assistant", content: [], stopReason: "error" });
    const blank = row("m2", { role: "assistant", content: [], stopReason: "error", errorMessage: "   " });
    expect(parsePiTranscript(`${empty}\n${blank}`)).toEqual([]);
  });

  // The note takes the same clamp every other text part takes, `MAX_TEXT_CHARS`. The longest error
  // measured in 44 real sessions was 4,031 characters, well under it, so the cap is a bound against a
  // pathological provider rather than something the normal case meets.
  test("the longest error a real session held passes through whole", () => {
    const log = row("m1", { role: "assistant", content: [], stopReason: "error", errorMessage: "x".repeat(4031) });
    expect(parsePiTranscript(log)[0]?.parts[0]).toEqual({ kind: "text", text: "x".repeat(4031) });
  });

  test("a pathological one is clamped rather than carried", () => {
    const log = row("m1", { role: "assistant", content: [], stopReason: "error", errorMessage: "x".repeat(MAX_TEXT_CHARS + 500) });
    const part = parsePiTranscript(log)[0]?.parts[0];
    expect(part?.kind).toBe("text");
    if (part?.kind === "text") {
      expect(part.truncated).toBe(true);
      expect(part.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    }
  });
});

describe("parsePiTranscript — the structured call", () => {
  /** An assistant row holding one `toolCall` block. */
  const call = (id: string, name: string, args: Record<string, JsonValue>) =>
    row("a", { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });

  /** The `toolResult` row that answers it. */
  /** pi's `toolResult` message. A type alias rather than an interface, so it still satisfies the
   *  `row` builder's index signature, and the two optional keys stay ABSENT when not passed: a key
   *  holding `undefined` survives a deep compare. */
  type ResultRow = {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: { type: string; text: string }[];
    details?: JsonValue;
    isError?: boolean;
  };

  const result = (
    id: string,
    name: string,
    text: string,
    extra: { details?: JsonValue; isError?: boolean } = {},
  ) =>
    {
      // A key holding `undefined` survives a deep compare, so an absent option is an ABSENT key.
      const body: ResultRow = {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text }],
      };
      if (extra.details !== undefined) body.details = extra.details;
      if (extra.isError !== undefined) body.isError = extra.isError;
      return row("b", body);
    };

  const partOf = (...lines: string[]) => {
    const entries = parsePiTranscript(lines.join("\n"));
    // SAFETY: every caller below passes a `call(...)` row first, and pi's parser emits that row as
    // one entry whose first part is the tool part. A shape change here fails the assertions that
    // follow, not silently.
    return entries[0]!.parts[0] as Extract<TranscriptPart, { kind: "tool" }>;
  };

  test("a toolCall carries pi's own call id and its classified call", () => {
    const part = partOf(call("call_1", "read", { path: "/repo/x.ts", offset: 10, limit: 20 }));
    expect(part.id).toBe("call_1");
    expect(part.call).toEqual({ kind: "read", path: "/repo/x.ts", range: [10, 30] });
  });

  test("`name` and `summary` are untouched by the classified call", () => {
    const part = partOf(call("call_1", "read", { path: "/repo/SKILL.md" }));
    expect(part.name).toBe("read");
    expect(part.summary).toBe("/repo/SKILL.md");
  });

  test("an unrecognised tool degrades to `other` and keeps the row's own summary", () => {
    const part = partOf(call("call_1", "get_search_content", { responseId: "r1", urlIndex: 0 }));
    expect(part.call).toEqual({ kind: "other", name: "get_search_content", summary: part.summary });
  });

  test("an edit's `details.patch` becomes hunks plus added/removed counts", () => {
    const patch = [
      "--- /repo/x.ts",
      "+++ /repo/x.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      "",
    ].join("\n");
    const part = partOf(
      call("call_1", "edit", { path: "/repo/x.ts", oldText: "b = 2", newText: "b = 3" }),
      result("call_1", "edit", "Successfully replaced text in /repo/x.ts.", {
        details: { patch, diff: "- 2 const b = 2;", firstChangedLine: 2 },
      }),
    );
    expect(part.call).toEqual({
      kind: "edit",
      path: "/repo/x.ts",
      added: 2,
      removed: 1,
      diff: [
        {
          header: "@@ -1,3 +1,4 @@",
          lines: [" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;"],
        },
      ],
    });
  });

  test("a patch with several hunks keeps each one, headers as pi wrote them", () => {
    const patch = [
      "--- /repo/x.md",
      "+++ /repo/x.md",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+A",
      " b",
      "@@ -10,2 +10,2 @@ section",
      " c",
      "-d",
      "+D",
      "",
    ].join("\n");
    const part = partOf(
      call("call_1", "edit", { path: "/repo/x.md", edits: [] }),
      result("call_1", "edit", "Successfully replaced 2 block(s) in /repo/x.md.", { details: { patch } }),
    );
    // SAFETY: the call above is pi's `edit` tool, which `classifyToolCall` keys to `kind: "edit"`;
    // the very next assertion reads `.diff` and would fail on any other branch.
    const call1 = part.call as Extract<ToolCall, { kind: "edit" }>;
    expect(call1.diff?.map((h) => h.header)).toEqual(["@@ -1,2 +1,2 @@", "@@ -10,2 +10,2 @@ section"]);
    expect([call1.added, call1.removed]).toEqual([2, 2]);
  });

  test("an edit result carrying only pi's line-numbered `details.diff` fills no hunks", () => {
    // 157 of 190 real edit results looked like this. That string is a DISPLAY diff, not a unified
    // one, so reading it would invent hunk headers pi never wrote.
    const part = partOf(
      call("call_1", "edit", { path: "/repo/x.ts", oldText: "a", newText: "b" }),
      result("call_1", "edit", "Successfully replaced text in /repo/x.ts.", {
        details: { diff: "- 1 a\n+ 1 b", firstChangedLine: 1 },
      }),
    );
    expect(part.call).toEqual({ kind: "edit", path: "/repo/x.ts", added: 0, removed: 0 });
  });

  test("a failed bash takes its exit code off the status line pi appends", () => {
    const part = partOf(
      call("call_1", "bash", { command: "bun test" }),
      result("call_1", "bash", "1 fail\n\nCommand exited with code 1", { isError: true }),
    );
    expect(part.call).toEqual({ kind: "execute", command: "bun test", exitCode: 1 });
  });

  test("a bash that printed nothing still yields its code", () => {
    const part = partOf(
      call("call_1", "bash", { command: "false" }),
      result("call_1", "bash", "Command exited with code 7", { isError: true }),
    );
    expect(part.call).toMatchObject({ exitCode: 7 });
  });

  test("a bash with no status line and no error exited 0", () => {
    const part = partOf(
      call("call_1", "bash", { command: "echo hi" }),
      result("call_1", "bash", "hi"),
    );
    expect(part.call).toEqual({ kind: "execute", command: "echo hi", exitCode: 0 });
  });

  test.each([
    ["an abort", "Command aborted"],
    ["a timeout", "Command timed out after 180 seconds"],
  ])("%s carries no exit code — pi records none", (_label, text) => {
    const part = partOf(
      call("call_1", "bash", { command: "sleep 999" }),
      result("call_1", "bash", text, { isError: true }),
    );
    expect(part.call).toEqual({ kind: "execute", command: "sleep 999" });
  });

  test("an unanswered call is classified but never enriched", () => {
    const part = partOf(call("call_1", "bash", { command: "echo hi" }));
    expect(part.call).toEqual({ kind: "execute", command: "echo hi" });
  });

  test("`details.answer` joins the structured summary and leaves the part's own alone", () => {
    const part = partOf(
      call("call_1", "ask_user", { question: "Which color do you prefer?", options: ["Red", "Blue"] }),
      result("call_1", "ask_user", "The user picked: Blue", {
        details: { question: "Which color do you prefer?", options: ["Red", "Blue"], answer: "Blue", by: "phone" },
      }),
    );
    expect(part.summary).toBe("Which color do you prefer?");
    expect(part.call).toEqual({
      kind: "other",
      name: "ask_user",
      summary: "Which color do you prefer? → Blue",
    });
  });

  test("pi's own block wording marks the result denied, not merely failed", () => {
    const part = partOf(
      call("call_1", "bash", { command: "rm -rf /" }),
      result("call_1", "bash", "Tool execution was blocked", { isError: true }),
    );
    expect(part.result).toEqual({ text: "Tool execution was blocked", isError: true, denied: true });
  });

  test.each([
    ["an interrupt", "Operation aborted"],
    ["an extension's own wording", "Denied at the desk"],
    ["an ordinary failure", "ENOENT: no such file"],
  ])("%s is not a refusal — `denied` stays absent", (_label, text) => {
    const part = partOf(
      call("call_1", "read", { path: "/x" }),
      result("call_1", "read", text, { isError: true }),
    );
    expect(part.result).toEqual({ text, isError: true });
  });
});

// pi is the harness that reports a kind-`path` ref: its herdr integration prefers
// `agent_session_path` (an absolute path chosen by a process we don't control) over an id. That path
// is treated as hostile input, so containment is the security boundary and it needs real files.
describe("PiTranscriptSource — path refs are confined to the root", () => {
  const SID = "019f4665-7df0-7540-a64f-7068335f21af";

  /**
   * Everything lives under one `base` so cleanup takes the "outside" file with it:
   *   base/sessions/--repo--/<ts>_<uuid>.jsonl   the real log
   *   base/outside.jsonl                          a file the root must never reach
   *   base/sessions/--repo--/sneaky.jsonl → ../../outside.jsonl   a symlink out of the root
   */
  async function fixture() {
    const created = `${tmpdir()}/collie-pi-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    // Built with `join`: `resolve` answers with this platform's separators, and the tests compare
    // its answer to the fixture's own spelling of the path.
    const root = join(base, "sessions");
    const project = join(root, "--var-home-you-repo--");
    await mkdir(project, { recursive: true });
    const log = join(project, `2026-07-29T10-00-00-000Z_${SID}.jsonl`);
    await Bun.write(log, speech("a", "user", "hi"));
    const outside = join(base, "outside.jsonl");
    await Bun.write(outside, speech("z", "user", "secrets"));
    const sneaky = join(project, `2026-07-29T11-00-00-000Z_${OUTSIDE_SID}.jsonl`);
    await symlink(outside, sneaky);
    return { base, root, log, sneaky };
  }

  const OUTSIDE_SID = "ffffffff-1111-2222-3333-444444444444";

  test("resolves a path ref that really is inside the root", async () => {
    const { base, root, log } = await fixture();
    expect(await new PiTranscriptSource(root).resolve({ kind: "path", value: log })).toBe(log);
    await rm(base, { recursive: true, force: true });
  });

  test("refuses a path ref pointing outside the root", async () => {
    const { base, root, log } = await fixture();
    const escape = `${log}/../../../../etc/hosts`;
    expect(await new PiTranscriptSource(root).resolve({ kind: "path", value: escape })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  // Symlink resolution is the ENTIRE reason containment runs on realpaths rather than on the strings
  // we were handed: `..` traversal would be caught by plain normalisation, this would not. The file
  // sits inside the root, has a plausible session filename, and still must not be readable.
  test("refuses a symlink inside the root that points outside it", async () => {
    const { base, root, sneaky } = await fixture();
    const src = new PiTranscriptSource(root);
    expect(await src.resolve({ kind: "path", value: sneaky })).toBeNull();
    // …and the id fallback must not be a way around the same check.
    expect(await src.resolve({ kind: "id", value: OUTSIDE_SID })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("refuses a path ref that isn't a session log at all", async () => {
    const { base, root } = await fixture();
    expect(await new PiTranscriptSource(root).resolve({ kind: "path", value: "/etc/passwd" })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("resolves the id fallback by scanning the per-cwd directories", async () => {
    const { base, root, log } = await fixture();
    expect(await new PiTranscriptSource(root).resolve({ kind: "id", value: SID })).toBe(log);
    await rm(base, { recursive: true, force: true });
  });

  test("an unknown id resolves to null rather than guessing", async () => {
    const { base, root } = await fixture();
    const src = new PiTranscriptSource(root);
    expect(await src.resolve({ kind: "id", value: "ffffffff-ffff-ffff-ffff-ffffffffffff" })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});

// pi with more than one sessions root (a second PI_CODING_AGENT_DIR) — the same multi-home case
// CLAUDE_CONFIG_DIR raised for Claude (issue #92). pi is the interesting one because its ref is
// usually a free-form PATH: no root built that name, so every configured root is asked whether the
// file is its own, and the union of the roots is exactly the readable area — nothing wider.
describe("PiTranscriptSource — several sessions roots", () => {
  const A = "019f4665-7df0-7540-a64f-7068335f21af";
  const B = "019f4665-7df0-7540-a64f-7068335f21b0";

  async function fixture() {
    const created = `${tmpdir()}/collie-pi-roots-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    // `join`, for the same reason as the fixture above: compare like with like on every platform.
    const first = join(base, "first");
    const second = join(base, "second");
    await mkdir(join(first, "--repo--"), { recursive: true });
    await mkdir(join(second, "--side--"), { recursive: true });
    const logA = join(first, "--repo--", `2026-08-11T09-00-00-000Z_${A}.jsonl`);
    const logB = join(second, "--side--", `2026-08-11T10-00-00-000Z_${B}.jsonl`);
    await Bun.write(logA, speech("a", "user", "one"));
    await Bun.write(logB, speech("b", "user", "two"));
    const outside = join(base, "outside.jsonl");
    await Bun.write(outside, speech("z", "user", "secrets"));
    return { base, first, second, logA, logB, outside };
  }

  test("a single root string still refuses the other root's log", async () => {
    const { base, first, logB } = await fixture();
    const src = new PiTranscriptSource(first);
    expect(await src.resolve({ kind: "path", value: logB })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("a path ref resolves under whichever configured root really contains it", async () => {
    const { base, first, second, logA, logB } = await fixture();
    const src = new PiTranscriptSource([first, second]);
    expect(await src.resolve({ kind: "path", value: logA })).toBe(logA);
    expect(await src.resolve({ kind: "path", value: logB })).toBe(logB);
    await rm(base, { recursive: true, force: true });
  });

  test("a path outside EVERY root is still refused", async () => {
    const { base, first, second, outside } = await fixture();
    const src = new PiTranscriptSource([first, second]);
    expect(await src.resolve({ kind: "path", value: outside })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("the id fallback scans every root", async () => {
    const { base, first, second, logB } = await fixture();
    expect(await new PiTranscriptSource([first, second]).resolve({ kind: "id", value: B })).toBe(logB);
    await rm(base, { recursive: true, force: true });
  });
});

describe("resolveImageUrl — only this collie's own blobs and inline images", () => {
  const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("a blob reference becomes this collie's own route", () => {
    expect(resolveImageUrl(`blob:sha256:${hash}`)).toBe(`/api/blobs/${hash}`);
  });

  test("a blob reference whose hash is not 64 hex is dropped", () => {
    expect(resolveImageUrl("blob:sha256:../../etc/passwd")).toBeNull();
    expect(resolveImageUrl("blob:sha256:1234")).toBeNull();
  });

  test("an inline data image rides through, and a non-image data URL does not", () => {
    expect(resolveImageUrl("data:image/webp;base64,AAAA")).toBe("data:image/webp;base64,AAAA");
    expect(resolveImageUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  });

  test("http and https are dropped — a remote URL would make the phone call an arbitrary host", () => {
    expect(resolveImageUrl("http://evil.example/x.png", "image/png")).toBeNull();
    expect(resolveImageUrl("https://evil.example/x.png", "image/png")).toBeNull();
  });

  test("anything else is dropped, and a bare payload needs its own image mime type", () => {
    expect(resolveImageUrl("file:///etc/passwd")).toBeNull();
    expect(resolveImageUrl("//evil.example/x.png")).toBeNull();
    // No mime type is NOT guessed at as png: a guess here is a data URL nobody declared.
    expect(resolveImageUrl("AAAA")).toBeNull();
    expect(resolveImageUrl("AAAA", "text/plain")).toBeNull();
    expect(resolveImageUrl("AAAA", "image/gif")).toBe("data:image/gif;base64,AAAA");
  });
});

describe("resolveBlobPath", () => {
  const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("refuses non-hex or wrong length hashes", async () => {
    expect(isBlobHash("not-a-hash")).toBe(false);
    expect(isBlobHash("1234")).toBe(false);
    expect(isBlobHash(hash)).toBe(true);
    expect(await resolveBlobPath("not-a-hash", ["/tmp"])).toBeNull();
  });

  test("resolves candidate contained in sibling blobs directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "collie-pi-blob-"));
    const sessionsDir = join(base, "sessions");
    const blobsDir = join(base, "blobs");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(blobsDir, { recursive: true });
    const blobFile = join(blobsDir, hash);
    await Bun.write(blobFile, "pretend image data");

    const resolved = await resolveBlobPath(hash, [sessionsDir]);
    expect(resolved).toBe(blobFile);

    // Refuses when not present
    const otherHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(await resolveBlobPath(otherHash, [sessionsDir])).toBeNull();

    await rm(base, { recursive: true, force: true });
  });
});
