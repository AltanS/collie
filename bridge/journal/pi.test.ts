import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPiReducer,
  isBlobHash,
  isPiSessionId,
  parsePiTranscript,
  piJournal,
  PiTranscriptSource,
  piSessionFolderNames,
  resolveBlobPath,
  imageTooLargeNote,
  MAX_INLINE_IMAGE_CHARS,
  resolveImage,
  resolveImageUrl,
} from "./pi.ts";
import { LiveWindows, TICK_FLOOR_MS } from "./live.ts";
import { TranscriptStore } from "./store.ts";
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

  // OpenClaw writes pi's format with a user turn's `content` as a plain string, and walking block
  // lists alone dropped every one of them (#401). A blank string is still no turn.
  test("a user turn whose content is a string is one text part", () => {
    expect(parsePiTranscript(row("a", { role: "user", content: "Reply with only the word ready." }))).toEqual([
      { uuid: "a", ts: "2026-07-29T10:00:00.000Z", role: "user", parts: [{ kind: "text", text: "Reply with only the word ready." }] },
    ]);
    expect(parsePiTranscript(row("b", { role: "user", content: "  " }))).toEqual([]);
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
  test("a picture just under the cap is kept and one just over becomes a visible line, in a tool card and in a turn", () => {
    const fits = "A".repeat(MAX_INLINE_IMAGE_CHARS);
    const big = "A".repeat(MAX_INLINE_IMAGE_CHARS + 4);
    const note = "Picture too large to show here (3.0 MB)";
    const result = (data: string) =>
      parsePiTranscript(
        [
          row("a", { role: "assistant", content: [{ type: "toolCall", id: "call_big", name: "screenshot", arguments: {} }] }),
          row("b", {
            role: "toolResult",
            toolCallId: "call_big",
            toolName: "screenshot",
            content: [{ type: "text", text: "taken" }, { type: "image", data, mimeType: "image/png" }],
          }),
        ].join("\n"),
      )[0]!.parts[0];
    expect(result(fits)).toMatchObject({ result: { text: "taken", imageUrl: `data:image/png;base64,${fits}` } });
    const over = result(big);
    expect(over).toMatchObject({ result: { text: `taken\n${note}` } });
    expect(over).not.toHaveProperty("result.imageUrl");
    const turn = parsePiTranscript(row("c", { role: "assistant", content: [{ type: "image", data: big, mimeType: "image/png" }] }));
    expect(turn[0]!.parts).toEqual([{ kind: "text", text: note }]);
  });

  test("the too-large line carries the decoded size, and a huge value that is no picture says nothing", () => {
    expect(imageTooLargeNote(MAX_INLINE_IMAGE_CHARS * 2)).toBe("Picture too large to show here (6.0 MB)");
    const big = "A".repeat(MAX_INLINE_IMAGE_CHARS + 4);
    expect(resolveImage(big, "image/png")).toEqual({ note: "Picture too large to show here (3.0 MB)" });
    expect(resolveImage(`data:image/png;base64,${big}`)).toEqual({ note: expect.stringContaining("Picture too large") });
    expect(resolveImage(big, "text/plain")).toBeNull();
    expect(resolveImage(big)).toBeNull();
    expect(resolveImage(`data:text/html;base64,${big}`)).toBeNull();
    expect(resolveImage("https://evil.example/".padEnd(MAX_INLINE_IMAGE_CHARS + 4, "x"), "image/png")).toBeNull();
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

  // The shape OpenClaw's normaliser writes for an answered `ask_user` (journal/openclaw.ts): one list
  // of labels per question. A list that does not match the questions is left unread.
  test("a question call takes its answers from the result's details, one list per question", () => {
    const ask = { questions: [{ id: "q1", header: "Color", question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] }] };
    const answered = partOf(call("call_1", "ask_user", ask), result("call_1", "ask_user", "Color: Blue", { details: { answers: [["Blue"]] } }));
    expect(answered.call).toMatchObject({ kind: "question", answers: [["Blue"]] });
    const mismatched = partOf(call("call_1", "ask_user", ask), result("call_1", "ask_user", "x", { details: { answers: [["Red"], ["Blue"]] } }));
    expect(mismatched.call?.kind === "question" && mismatched.call.answers).toBeUndefined();
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

  test("OmO's `details.answers` fills the chosen label, in question order", () => {
    const q = "Pick a color for the Collie sandbox probe?";
    const part = partOf(
      call("call_1", "ask_user_question", {
        questions: [{
          id: "q1",
          header: "Color",
          question: q,
          options: [{ label: "Red", description: "Warm color." }, { label: "Green", description: "Cool color." }],
          multiSelect: false,
        }],
      }),
      result("call_1", "ask_user_question", "Color: Green", {
        details: { resolvedBy: "local_ui", answers: { [q]: "Green" }, unanswered: [], status: "answered" },
      }),
    );
    expect(part.call).toMatchObject({ kind: "question", answers: [["Green"]] });
  });

  test("OmO's `request_user_input` answers by the question's id", () => {
    const part = partOf(
      call("call_1", "request_user_input", {
        questions: [{
          id: "color",
          header: "Color",
          question: "Pick a color for the Collie sandbox probe?",
          options: [{ label: "Red", description: "Warm color." }, { label: "Blue", description: "Deep color." }],
          multiSelect: false,
        }],
      }),
      result("call_1", "request_user_input", "Color: Blue", {
        details: { resolvedBy: "local_ui", answers: { color: { answers: ["Blue"] } }, unanswered: [], status: "answered" },
      }),
    );
    expect(part.call).toMatchObject({ kind: "question", answers: [["Blue"]] });
  });

  test("a long, padded question still finds its answer, and a long typed answer is clamped", () => {
    const q = ` ${"Which one? ".repeat(60)}`;
    const part = partOf(
      call("call_1", "ask_user_question", {
        questions: [{ id: "q1", header: "Long", question: q, options: [{ label: "Red" }], multiSelect: false }],
      }),
      result("call_1", "ask_user_question", "Long: …", {
        details: { answers: { [q]: "x".repeat(1000) }, unanswered: [], status: "answered" },
      }),
    );
    // SAFETY: the call above carries a `questions` list, which `classifyToolCall` keys to `question`;
    // the assertions read `.answers` and fail on any other branch.
    const answers = (part.call as Extract<ToolCall, { kind: "question" }>).answers;
    expect(answers).toHaveLength(1);
    expect(answers?.[0]?.[0]?.length).toBeGreaterThan(0);
    expect(answers?.[0]?.[0]?.length).toBeLessThanOrEqual(200);
  });

  test("a dismissed OmO question records no answer", () => {
    const q = "Pick a color?";
    const part = partOf(
      call("call_1", "ask_user_question", {
        questions: [{ id: "q1", header: "Color", question: q, options: [{ label: "Red" }], multiSelect: false }],
      }),
      result("call_1", "ask_user_question", "cancelled", {
        details: { answers: {}, unanswered: ["q1"], status: "cancelled" },
      }),
    );
    expect(part.call).not.toHaveProperty("answers");
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

// pi names a new session before it writes the file (#526). Observed on pi 0.87.1 under Herdr: on
// launch and right after `/new`, `herdr pane get` reports `agent_session: {kind: "path", value:
// ".../--tmp-x--/2026-10-19T07-48-57-661Z_<uuid>.jsonl"}` while that folder holds no such file; pi
// writes it whole when the first reply is saved. Until then the pane is a new, EMPTY session.
describe("PiTranscriptSource — a session pi has not written yet", () => {
  const SID = "01a15322-94bd-773d-b89f-b80fc1885dd6";
  const OLD = "01a15322-2a49-773d-b89f-b80c14b8ba0c";

  async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-pi-new-")));
    const root = join(base, "sessions");
    const project = join(root, "--tmp-x--");
    await mkdir(project, { recursive: true });
    const old = join(project, `2026-10-19T07-48-30-410Z_${OLD}.jsonl`);
    await Bun.write(old, `${header()}\n${speech("a1", "user", "the old question")}\n`);
    const next = join(project, `2026-10-19T07-48-57-661Z_${SID}.jsonl`);
    return { base, root, project, old, next, clean: () => rm(base, { recursive: true, force: true }) };
  }

  test("resolve still answers null for it, and pending answers where the file will be", async () => {
    const f = await fixture();
    const src = new PiTranscriptSource(f.root);
    expect(await src.resolve({ kind: "path", value: f.next })).toBeNull();
    expect(await src.pending({ kind: "path", value: f.next })).toBe(f.next);
    // A file that exists is resolve's to answer, never pending's.
    expect(await src.pending({ kind: "path", value: f.old })).toBeNull();
    // An id names no place, so there is nothing to confine yet.
    expect(await src.pending({ kind: "id", value: SID })).toBeNull();
    await f.clean();
  });

  test("pending keeps resolve's confinement: pi's own name, a folder inside the root, nothing there", async () => {
    const f = await fixture();
    const src = new PiTranscriptSource(f.root);
    expect(await src.pending({ kind: "path", value: join(f.project, "notes.jsonl") })).toBeNull();
    expect(await src.pending({ kind: "path", value: join(f.project, `x_${SID}.txt`) })).toBeNull();
    // A folder outside every root, and one that does not exist.
    expect(await src.pending({ kind: "path", value: join(f.base, `t_${SID}.jsonl`) })).toBeNull();
    expect(await src.pending({ kind: "path", value: join(f.root, "--gone--", `t_${SID}.jsonl`) })).toBeNull();
    // A folder symlinked out of the root.
    await mkdir(join(f.base, "elsewhere"));
    await symlink(join(f.base, "elsewhere"), join(f.root, "--sneaky--"));
    expect(await src.pending({ kind: "path", value: join(f.root, "--sneaky--", `t_${SID}.jsonl`) })).toBeNull();
    // A dangling symlink where the log will be: never "empty", whatever it points at later.
    await symlink(join(f.base, "outside.jsonl"), f.next);
    expect(await src.pending({ kind: "path", value: f.next })).toBeNull();
    await f.clean();
  });

  test("the live window answers an empty session under a new tag, then reads the file when it appears", async () => {
    const f = await fixture();
    let now = 1_000_000;
    const live = new LiveWindows(new TranscriptStore(), () => now);
    const adapter = piJournal(f.root);

    const before = await live.window(adapter, { kind: "path", value: f.old }, { limit: 40 });
    expect(before?.upserts.map((e) => e.uuid)).toEqual(["a1"]);

    // `/new`: the ref moves to a file that is not there. Not "no log" (null): an empty session.
    const empty = await live.window(adapter, { kind: "path", value: f.next }, { limit: 40 });
    expect(empty).not.toBeNull();
    expect(empty?.upserts).toEqual([]);
    expect(empty?.hasOlder).toBe(false);
    expect(empty?.queued).toEqual([]);
    expect(empty?.lastPrompt).toBeUndefined();
    expect(empty?.session).toEqual(expect.any(String));
    expect(empty?.session).not.toBe(before?.session);
    expect(empty?.gen).not.toBe(before?.gen);

    // A poll while pi still has not written it: the same empty answer, a 304 on the wire.
    now += TICK_FLOOR_MS;
    const quiet = await live.window(adapter, { kind: "path", value: f.next }, { limit: 40, after: { gen: empty!.gen, rev: empty!.rev } });
    expect(quiet).toEqual(empty);

    // The first reply is saved: pi writes the header, the prompt and the reply at once.
    await Bun.write(
      f.next,
      `${header()}\n${speech("b1", "user", "a new question")}\n${speech("b2", "assistant", "a new answer")}\n`,
    );
    now += TICK_FLOOR_MS;
    const born = await live.window(adapter, { kind: "path", value: f.next }, { limit: 40, after: { gen: empty!.gen, rev: empty!.rev } });
    expect(born?.session).toBe(empty?.session);
    expect(born?.upserts.map((e) => e.uuid)).toEqual(["b1", "b2"]);
    expect(born?.hasOlder).toBe(false);
    await f.clean();
  });

  test("a path pi may not serve is still no log, not an empty session", async () => {
    const f = await fixture();
    const live = new LiveWindows(new TranscriptStore(), () => 0);
    const outside = join(f.base, `2026-10-19T07-48-57-661Z_${SID}.jsonl`);
    expect(await live.window(piJournal(f.root), { kind: "path", value: outside }, { limit: 40 })).toBeNull();
    await f.clean();
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

describe("PiTranscriptSource — a pane that names no session finds it by its folder (M79 spec 02)", () => {
  // A multiplexer without pi's Herdr integration (herdr-core, tmux, zellij) gives the pane's folder only.
  const ONE = "019f4665-7df0-7540-a64f-7068335f2101";
  const TWO = "019f4665-7df0-7540-a64f-7068335f2102";
  const OLD = "019f4665-7df0-7540-a64f-7068335f2103";

  /** pi's session row, as the first row (pi) or after Oh My Pi's 256-byte title row. */
  const sessionRow = (id: string, cwd: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-30T10:00:00.000Z", cwd });
  const ompTitle = JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-10-30T10:00:00.000Z", pad: " ".repeat(180) });

  async function fixture() {
    const created = `${tmpdir()}/collie-pi-discover-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    const places = { home: join(base, "home"), tmp: join(base, "tmp") };
    const piRoot = join(base, "pi-sessions");
    const ompRoot = join(base, "omp-sessions");
    /** Write one log into `root/folder`, its mtime `age` seconds ago. */
    const log = async (root: string, folder: string, id: string, head: string, age: number) => {
      const path = join(root, folder, `2026-10-30T10-00-00-000Z_${id}.jsonl`);
      await mkdir(join(root, folder), { recursive: true });
      await Bun.write(path, `${head}\n${speech("m1", "user", "hello")}\n`);
      const when = new Date(Date.now() - age * 1000);
      await utimes(path, when, when);
      return path;
    };
    return { base, places, piRoot, ompRoot, log };
  }

  test("pi: the one log filed for the pane's folder is the pane's session", async () => {
    const f = await fixture();
    const cwd = "/srv/lab/proj";
    const path = await f.log(f.piRoot, "--srv-lab-proj--", ONE, sessionRow(ONE, cwd), 5);
    const src = new PiTranscriptSource([f.ompRoot, f.piRoot], f.places);
    const ref = await src.discoverSession(cwd);
    expect(ref).toEqual({ kind: "id", value: ONE });
    expect(await src.resolve(ref ?? { kind: "id", value: "" })).toBe(path);
    await rm(f.base, { recursive: true, force: true });
  });

  test("omp: a home folder's log (`-<relative>`, title row first) and a temp folder's (`-tmp-<relative>`) both resolve", async () => {
    const f = await fixture();
    const inHome = join(f.places.home, ".cache", "lab");
    const inTmp = join(f.places.tmp, "lab");
    await f.log(f.ompRoot, "-.cache-lab", ONE, `${ompTitle}\n${sessionRow(ONE, inHome)}`, 5);
    await f.log(f.ompRoot, "-tmp-lab", TWO, `${ompTitle}\n${sessionRow(TWO, inTmp)}`, 5);
    const src = new PiTranscriptSource([f.ompRoot, f.piRoot], f.places);
    expect(await src.discoverSession(inHome)).toEqual({ kind: "id", value: ONE });
    expect(await src.discoverSession(inTmp)).toEqual({ kind: "id", value: TWO });
    await rm(f.base, { recursive: true, force: true });
  });

  test("a log whose session row names another cwd is skipped, even when it is newer", async () => {
    // `/srv/lab-proj` and `/srv/lab/proj` share the folder name `--srv-lab-proj--`.
    const f = await fixture();
    await f.log(f.piRoot, "--srv-lab-proj--", TWO, sessionRow(TWO, "/srv/lab-proj"), 1);
    await f.log(f.piRoot, "--srv-lab-proj--", ONE, sessionRow(ONE, "/srv/lab/proj"), 60);
    const src = new PiTranscriptSource(f.piRoot, f.places);
    expect(await src.discoverSession("/srv/lab/proj")).toEqual({ kind: "id", value: ONE });
    expect(await src.discoverSession("/srv/lab-proj")).toEqual({ kind: "id", value: TWO });
    expect(await src.discoverSession("/srv/elsewhere")).toBeNull();
    await rm(f.base, { recursive: true, force: true });
  });

  test("of two logs for one folder the newest written wins (a resumed session is being written)", async () => {
    const f = await fixture();
    const cwd = "/srv/proj";
    await f.log(f.piRoot, "--srv-proj--", OLD, sessionRow(OLD, cwd), 2);
    await f.log(f.piRoot, "--srv-proj--", ONE, sessionRow(ONE, cwd), 300);
    expect(await new PiTranscriptSource(f.piRoot, f.places).discoverSession(cwd)).toEqual({ kind: "id", value: OLD });
    await rm(f.base, { recursive: true, force: true });
  });

  test("a pi or omp neighbour in the folder, an unknown cwd or a relative one: no session", async () => {
    const f = await fixture();
    const cwd = "/srv/proj";
    await f.log(f.piRoot, "--srv-proj--", ONE, sessionRow(ONE, cwd), 5);
    const adapter = piJournal(f.piRoot);
    const src = new PiTranscriptSource(f.piRoot, f.places);
    expect(adapter.sharedFolderBlind).toBe(true);
    expect(await adapter.discover?.(cwd, { shared: true })).toBeNull();
    expect(await src.discoverSession(cwd, { shared: true })).toBeNull();
    expect(await src.discoverSession("")).toBeNull();
    expect(await src.discoverSession("srv/proj")).toBeNull();
    await rm(f.base, { recursive: true, force: true });
  });

  test("the folder names pi and Oh My Pi file a cwd under", () => {
    const places = { home: "/home/dev", tmp: "/tmp" };
    expect(piSessionFolderNames("/srv/a", places)).toEqual(["--srv-a--"]);
    expect(piSessionFolderNames("/home/dev/projects/x", places)).toEqual(["--home-dev-projects-x--", "-projects-x"]);
    expect(piSessionFolderNames("/home/dev", places)).toEqual(["--home-dev--", "-"]);
    expect(piSessionFolderNames("/tmp/lab", places)).toEqual(["--tmp-lab--", "-tmp-lab"]);
    expect(piSessionFolderNames("/tmp", places)).toEqual(["--tmp--", "-tmp"]);
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
    // The cap: one inline picture over MAX_INLINE_IMAGE_CHARS is dropped, a blob reference never counts.
    expect(resolveImageUrl("A".repeat(MAX_INLINE_IMAGE_CHARS + 4), "image/png")).toBeNull();
    expect(resolveImageUrl(`data:image/png;base64,${"A".repeat(MAX_INLINE_IMAGE_CHARS)}`)).toBeNull();
    expect(resolveImageUrl("A".repeat(MAX_INLINE_IMAGE_CHARS), "image/png")).not.toBeNull();
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
    // The resolver answers with the real path. On a Windows runner `tmpdir()` is an 8.3 short name
    // (`RUNNER~1`), so the expected value has to be the real path too.
    expect(resolved).toBe(await realpath(blobFile));

    // Refuses when not present
    const otherHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(await resolveBlobPath(otherHash, [sessionsDir])).toBeNull();

    await rm(base, { recursive: true, force: true });
  });
});

// A message sent while pi works. Measured 2026-10-09 (pi 0.87.1 sessions): pi keeps a steer or a
// follow-up in memory and writes NOTHING until it delivers the message, as an ordinary `message` row
// with `role: "user"` right after the tool result it waited for. So there is no special record to read,
// and the adapter must keep showing that row once. omp is the same adapter (registry.ts).
describe("parsePiTranscript — a message delivered while the agent works", () => {
  test("a steer after a tool result is one user turn, in order", () => {
    const entries = parsePiTranscript(
      [
        header(),
        msg("u1", null, { role: "user", content: [{ type: "text", text: "run the slow script" }] }),
        msg("a1", "u1", { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 20" } }] }),
        msg("r1", "a1", { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "done" }] }),
        msg("u2", "r1", { role: "user", content: [{ type: "text", text: "are you updating build artifacts ??" }] }),
        msg("a2", "u2", { role: "assistant", content: [{ type: "text", text: "No." }] }),
      ].join("\n"),
    );
    expect(entries.filter((e) => e.role === "user").map((e) => [e.uuid, e.parts[0]])).toEqual([
      ["u1", { kind: "text", text: "run the slow script" }],
      ["u2", { kind: "text", text: "are you updating build artifacts ??" }],
    ]);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

// Gentle Shell (gentle-pi 4.2.0) on pi 1.3.0: the row shapes below were read off real local sessions on
// 2026-10-16 (issue #461, ADR 0119).
describe("parsePiTranscript — Gentle Shell's tools", () => {
  /** A linear session: each row hangs off the one before, so nothing reads as a rewind. */
  const session = () => {
    const rows: string[] = [];
    let parent: string | null = null;
    const add = (id: string, body: Record<string, JsonValue>) => {
      rows.push(plain(id, parent, body));
      parent = id;
    };
    return {
      call(id: string, callId: string, name: string, args: Record<string, JsonValue>) {
        add(id, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] } });
      },
      result(id: string, callId: string, name: string, text: string, details: JsonValue, isError = false) {
        const message = { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], details };
        add(id, { type: "message", message: isError ? { ...message, isError: true } : message });
      },
      notice(id: string, customType: string, content: string, details: JsonValue) {
        add(id, { type: "custom_message", customType, content, display: true, details });
      },
      rows,
    };
  };
  const tools = (lines: string[]) =>
    parsePiTranscript(lines.join("\n")).flatMap((e) =>
      e.parts.flatMap((p) => (p.kind === "tool" ? [{ uuid: e.uuid, part: p }] : [])),
    );
  const todo = (tasks: { id: number; title: string; status: string }[]) => ({ gentleTodo: { tasks, nextId: tasks.length + 1, updatedTurn: 1 } });

  test("a `todo` update folds into the card its write drew, with the list from the result", () => {
    const s = session();
    s.call("a1", "c1", "todo", { action: "write", tasks: [{ title: "Parse", status: "in_progress" }, { title: "Ship" }] });
    s.result("r1", "c1", "todo", "Todo list written: 2 tasks", todo([{ id: 1, title: "Parse", status: "in_progress" }, { id: 2, title: "Ship", status: "pending" }]));
    s.call("a2", "c2", "todo", { action: "update", id: 1, status: "done" });
    s.result("r2", "c2", "todo", "#1 Parse → done", todo([{ id: 1, title: "Parse", status: "done" }, { id: 2, title: "Ship", status: "pending" }]));
    const drawn = tools(s.rows);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.uuid).toBe("a1");
    expect(drawn[0]?.part.call).toEqual({
      kind: "plan",
      name: "todo",
      tasks: [{ title: "Parse", status: "done" }, { title: "Ship", status: "pending" }],
    });
  });

  test("the fold names the card's turn as changed", () => {
    const s = session();
    s.call("a1", "c1", "todo", { action: "write", tasks: [{ title: "Parse" }] });
    s.result("r1", "c1", "todo", "written", todo([{ id: 1, title: "Parse", status: "pending" }]));
    s.call("a2", "c2", "todo", { action: "update", id: 1, status: "in_progress" });
    const reducer = createPiReducer();
    for (const line of s.rows) reducer.push(line);
    const folded = reducer.push(plain("r2", "a2", {
      type: "message",
      message: { role: "toolResult", toolCallId: "c2", toolName: "todo", content: [{ type: "text", text: "ok" }], details: todo([{ id: 1, title: "Parse", status: "in_progress" }]) },
    }));
    expect(folded.added).toEqual([]);
    expect([...folded.changed]).toEqual(["a1"]);
  });

  test("a second write opens a card of its own", () => {
    const s = session();
    s.call("a1", "c1", "todo", { action: "write", tasks: [{ title: "Old" }] });
    s.result("r1", "c1", "todo", "written", todo([{ id: 1, title: "Old", status: "pending" }]));
    s.call("a2", "c2", "todo", { action: "write", tasks: [{ title: "New" }] });
    s.result("r2", "c2", "todo", "written", todo([{ id: 1, title: "New", status: "pending" }]));
    expect(tools(s.rows).map((t) => t.uuid)).toEqual(["a1", "a2"]);
  });

  // 14 real `clear` calls (2026-10-16): the result's list is empty, and the next `add` starts a new list.
  test("a `clear` keeps the card's last list and lets the next `add` draw a card of its own", () => {
    const s = session();
    s.call("a1", "c1", "todo", { action: "write", tasks: [{ title: "Old" }] });
    s.result("r1", "c1", "todo", "written", todo([{ id: 1, title: "Old", status: "done" }]));
    s.call("a2", "c2", "todo", { action: "clear" });
    s.result("r2", "c2", "todo", "cleared", todo([]));
    s.call("a3", "c3", "todo", { action: "add", title: "New" });
    s.result("r3", "c3", "todo", "added", todo([{ id: 1, title: "New", status: "pending" }]));
    expect(tools(s.rows).map((t) => [t.uuid, t.part.call])).toEqual([
      ["a1", { kind: "plan", name: "todo", tasks: [{ title: "Old", status: "done" }] }],
      ["a3", { kind: "plan", name: "todo", tasks: [{ title: "New", status: "pending" }] }],
    ]);
  });

  test("a rewind past the held card lets the next update draw on the new branch", () => {
    const rows = [
      plain("a1", null, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "todo", arguments: { action: "write", tasks: [{ title: "Old" }] } }] } }),
      plain("r1", "a1", { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "todo", content: [{ type: "text", text: "ok" }], details: todo([{ id: 1, title: "Old", status: "pending" }]) } }),
      plain("u1", null, { type: "message", message: { role: "user", content: [{ type: "text", text: "start over" }] } }),
      plain("a2", "u1", { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "todo", arguments: { action: "update", id: 1, status: "done" } }] } }),
      plain("r2", "a2", { type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "todo", content: [{ type: "text", text: "ok" }], details: todo([{ id: 1, title: "Old", status: "done" }]) } }),
    ];
    const drawn = parsePiTranscript(rows.join("\n")).filter((e) => e.parts.some((p) => p.kind === "tool"));
    expect(drawn.map((e) => [e.uuid, e.abandoned === true])).toEqual([["a1", true], ["a2", false]]);
  });

  test("an update with no write before it draws its own card from the result", () => {
    const s = session();
    s.call("a1", "c1", "todo", { action: "update", id: 2, status: "done" });
    s.result("r1", "c1", "todo", "ok", todo([{ id: 2, title: "Ship", status: "done" }]));
    expect(tools(s.rows).map((t) => t.part.call)).toEqual([{ kind: "plan", name: "todo", tasks: [{ title: "Ship", status: "done" }] }]);
  });

  test("`ask_user_choice` takes its answer from `details.selection`, and a dismissal fills nothing", () => {
    const ask = { question: "Which?", options: [{ label: "Remove", value: "remove" }, { label: "Keep", value: "keep" }] };
    const s = session();
    s.call("a1", "c1", "ask_user_choice", ask);
    s.result("r1", "c1", "ask_user_choice", "Remove", { ...ask, selection: { value: "remove", label: "Remove", index: 1 } });
    s.call("a2", "c2", "ask_user_choice", ask);
    s.result("r2", "c2", "ask_user_choice", "User cancelled the choice", { ...ask, cancelled: true });
    const [answered, dismissed] = tools(s.rows).map((t) => t.part.call);
    expect(answered).toMatchObject({ kind: "question", answers: [["Remove"]] });
    expect(dismissed?.kind === "question" && dismissed.answers).toBeUndefined();
  });

  test("collie's own `ask_user` is a question card with its `details.answer`", () => {
    const s = session();
    s.call("a1", "c1", "ask_user", { question: "Which color do you prefer?", options: ["Red", "Blue"] });
    s.result("r1", "c1", "ask_user", "The user picked: Blue", { question: "Which color do you prefer?", options: ["Red", "Blue"], answer: "Blue", by: "phone" });
    const [only] = tools(s.rows);
    expect(only?.part.summary).toBe("Which color do you prefer?");
    expect(only?.part.call).toMatchObject({ kind: "question", name: "ask_user", answers: [["Blue"]] });
  });

  const agents = (taskId: string, status: string, mode = "background", agent = "gentle-ai-explore") => ({ gentleAgents: { taskId, agent, status, mode, cwd: "/repo" } });

  test("a background subagent is ongoing until its end notice, which a failure marks", () => {
    const s = session();
    s.call("a1", "c1", "subagent_run", { agent: "gentle-ai-explore", label: "Map it", task: "…", mode: "background" });
    s.result("r1", "c1", "subagent_run", "Started gentle-ai-explore in the background as task t-1.", agents("t-1", "queued"));
    const running = tools(s.rows)[0]?.part;
    expect(running?.call).toEqual({ kind: "task", agent: "gentle-ai-explore", summary: "Map it", ongoing: true });
    s.notice("n1", "gentle-agents.result", "Subagent gentle-ai-explore (task t-1, \"Map it\") failed.", agents("t-1", "failed"));
    const entries = parsePiTranscript(s.rows.join("\n"));
    const part = entries[0]?.parts[0];
    expect(part?.kind === "tool" && part.call).toEqual({ kind: "task", agent: "gentle-ai-explore", summary: "Map it" });
    expect(part?.kind === "tool" && part.result?.isError).toBe(true);
    // The notice is still drawn where it happened.
    expect(entries.at(-1)?.role).toBe("note");
  });

  test("a foreground subagent is finished when it returns", () => {
    const s = session();
    s.call("a1", "c1", "subagent_run", { agent: "gentle-ai-explore", label: "Map it", task: "…" });
    s.result("r1", "c1", "subagent_run", "The answer.", agents("t-1", "completed", "task"));
    expect(tools(s.rows)[0]?.part.call).toEqual({ kind: "task", agent: "gentle-ai-explore", summary: "Map it" });
  });

  test("`subagent_result` folds into its task's card and brings the answer", () => {
    const s = session();
    s.call("a1", "c1", "subagent_run", { agent: "gentle-ai-explore", label: "Map it", task: "…", mode: "background" });
    s.result("r1", "c1", "subagent_run", "Started.", agents("t-1", "queued"));
    s.call("a2", "c2", "subagent_result", { task_id: "t-1" });
    s.result("r2", "c2", "subagent_result", "The map.", agents("t-1", "completed"));
    const drawn = tools(s.rows);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.part.call).toEqual({ kind: "task", agent: "gentle-ai-explore", summary: "Map it" });
    expect(drawn[0]?.part.result?.text).toBe("The map.");
  });

  // Read off a real session (2026-10-15): a cancelled subagent has no end notice, only the status a
  // later `subagent_status` or `subagent_cancel` reports.
  test("a later status result that names the task ends its card", () => {
    const s = session();
    s.call("a1", "c1", "subagent_run", { agent: "gentle-ai-explore", label: "Map it", task: "…", mode: "background" });
    s.result("r1", "c1", "subagent_run", "Started.", agents("t-1", "queued"));
    s.call("a2", "c2", "subagent_status", { task_id: "t-1" });
    s.result("r2", "c2", "subagent_status", "cancelled", agents("t-1", "cancelled"));
    expect(tools(s.rows)[0]?.part.call).toEqual({ kind: "task", agent: "gentle-ai-explore", summary: "Map it" });
  });

  test("a `subagent_result` asked while the task still runs leaves it running", () => {
    const s = session();
    s.call("a1", "c1", "subagent_run", { agent: "gentle-ai-explore", label: "Map it", task: "…", mode: "background" });
    s.result("r1", "c1", "subagent_run", "Started.", agents("t-1", "queued"));
    s.call("a2", "c2", "subagent_result", { task_id: "t-1" });
    s.result("r2", "c2", "subagent_result", "Still running.", agents("t-1", "running"));
    expect(tools(s.rows)[0]?.part.call).toMatchObject({ ongoing: true });
  });

  test("`subagent_continue` takes its agent from the result", () => {
    const s = session();
    s.call("a1", "c1", "subagent_continue", { task_id: "t-1", label: "Fix it", prompt: "…" });
    s.result("r1", "c1", "subagent_continue", "Started.", agents("t-2", "queued", "background", "gentle-ai-worker"));
    expect(tools(s.rows)[0]?.part.call).toEqual({ kind: "task", agent: "gentle-ai-worker", summary: "Fix it", ongoing: true });
  });

  const job = (jobId: string, kind: string, status: string, exitCode: number | null, event: string | null = null) => {
    const gentleJobs = { jobId, kind, label: "suite", status, exitCode, outputPath: "/tmp/j.log" };
    return { gentleJobs: event === null ? gentleJobs : { ...gentleJobs, event } };
  };

  test("a background command is ongoing with no exit code until its notice gives one", () => {
    const s = session();
    s.call("a1", "c1", "bash_background", { command: "bun test", label: "suite" });
    s.result("r1", "c1", "bash_background", "Started background job job-1 (\"suite\").", job("job-1", "command", "running", null));
    expect(tools(s.rows)[0]?.part.call).toEqual({ kind: "execute", command: "bun test", description: "suite", background: true, ongoing: true });
    s.notice("n1", "gentle-jobs.notice", "Background job job-1 (\"suite\") exited with code 137 after 3s.", job("job-1", "command", "exited", 137));
    const part = tools(s.rows)[0]?.part;
    expect(part?.call).toEqual({ kind: "execute", command: "bun test", description: "suite", background: true, exitCode: 137 });
    expect(part?.result?.isError).toBe(true);
  });

  test("a monitor's events leave it running, and stopping it ends it", () => {
    const s = session();
    s.call("a1", "c1", "monitor", { command: "tail -f x", label: "watch", timeout_seconds: 60 });
    s.result("r1", "c1", "monitor", "Started monitor job-1.", job("job-1", "monitor", "running", null));
    s.notice("n1", "gentle-jobs.notice", "Monitor job-1 reported 2 new lines", job("job-1", "monitor", "running", null, "events"));
    expect(tools(s.rows)[0]?.part.call).toMatchObject({ ongoing: true });
    s.notice("n2", "gentle-jobs.notice", "Monitor job-1 reported 1 new line", job("job-1", "monitor", "stopped", null, "events"));
    const call = tools(s.rows)[0]?.part.call;
    expect(call).toEqual({ kind: "execute", command: "tail -f x", description: "watch", background: true });
    expect(tools(s.rows)[0]?.part.result?.isError).toBeUndefined();
  });
});

// The thinking level beside the model (#463). pi writes a `thinking_level_change` row when a session
// opens and on every change, and pi 1.3 also stamps `thinkingLevel` on each assistant message, so the
// newest of the two is the level the next turn runs at.
describe("the pi probe — the thinking level", () => {
  const SID = "019f1827-bf99-7927-9684-76318de905b5";
  const level = (id: string, thinkingLevel: string) =>
    JSON.stringify({ type: "thinking_level_change", id, parentId: "p0", timestamp: "2026-07-29T10:00:00.000Z", thinkingLevel });
  const answer = (id: string, extra: Record<string, JsonValue> = {}) =>
    row(id, {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 0 },
      ...extra,
    });

  async function probeOf(lines: readonly string[]) {
    const created = `${tmpdir()}/collie-pi-effort-${Math.floor(performance.now() * 1000)}`;
    const root = join(created, "sessions");
    const project = join(root, "--repo--");
    await mkdir(project, { recursive: true });
    const log = join(project, `2026-07-29T10-00-00-000Z_${SID}.jsonl`);
    await Bun.write(log, `${lines.join("\n")}\n`);
    const probe = await piJournal(root).cacheProbe?.({ kind: "path", value: await realpath(log) });
    await rm(created, { recursive: true, force: true });
    return probe;
  }

  test("the level row written when the session opened names the effort", async () => {
    const probe = await probeOf([header(), level("l1", "high"), answer("a1")]);
    expect(probe?.model).toBe("anthropic:claude-opus-5-5");
    expect(probe?.effort).toBe("high");
  });

  test("a level changed after the last turn is the one the next turn uses", async () => {
    const probe = await probeOf([header(), level("l1", "high"), answer("a1", { thinkingLevel: "high" }), level("l2", "low")]);
    expect(probe?.turnId).toBe("a1");
    expect(probe?.effort).toBe("low");
  });

  test("the turn's own thinkingLevel answers when no level row is in the window", async () => {
    const probe = await probeOf([answer("a1", { thinkingLevel: "xhigh" })]);
    expect(probe?.effort).toBe("xhigh");
  });

  test("a log that names no level reports no effort", async () => {
    const probe = await probeOf([header(), answer("a1")]);
    expect(probe?.model).toBe("anthropic:claude-opus-5-5");
    expect(probe?.effort).toBeUndefined();
  });
});

// Oh My Pi 18.6.1's background `task` jobs: the row shapes below copy a real session read on
// 2026-10-25 (key names exact; the words are the lab's). A spawn answers at once with
// `details.async` and `details.progress[]`; the end is an `async-result` notice or a `wait` result.
describe("parsePiTranscript — Oh My Pi's task jobs", () => {
  const session = () => {
    const rows: string[] = [];
    let parent: string | null = null;
    const add = (id: string, body: Record<string, JsonValue>) => {
      rows.push(plain(id, parent, body));
      parent = id;
    };
    return {
      spawn(id: string, callId: string, intent = "Count the lab files") {
        add(id, {
          type: "message",
          message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "task", arguments: { i: intent, context: "The lab.", tasks: [{ task: "count the files in the lab", name: "LabFix" }] } }] },
        });
        add(`${id}s`, { type: "custom", customType: "tool_execution_start", data: { toolCallId: callId, toolName: "task", startedAt: "2026-09-30T12:00:00.000Z", intent } });
      },
      started(id: string, callId: string, name: string, jobId = name) {
        add(id, {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: callId,
            toolName: "task",
            content: [{ type: "text", text: `Spawned agent \`${name}\` (job \`${jobId}\`).` }],
            details: {
              projectAgentsDir: null,
              results: [],
              totalDurationMs: 1,
              progress: [{ index: 0, id: name, agent: "task", agentSource: "bundled", status: "pending", task: "count the files in the lab", assignment: "count the files in the lab", recentTools: [], recentOutput: [], toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0 }],
              async: { state: "running", jobId, type: "task" },
            },
          },
        });
      },
      failedSpawn(id: string, callId: string) {
        add(id, {
          type: "message",
          message: { role: "toolResult", toolCallId: callId, toolName: "task", isError: true, content: [{ type: "text", text: "Missing `tasks`. Provide a `tasks` array." }], details: { projectAgentsDir: null, results: [], totalDurationMs: 0 } },
        });
      },
      asyncResult(id: string, jobId: string, label: string, status = "completed") {
        add(id, {
          type: "custom_message",
          customType: "async-result",
          content: `<system-notice>\nBackground job ${jobId} has ${status}.\n<task-result id="${jobId}" agent="task" status="${status}" duration="9.6s">\n12 files.\n</task-result>\n</system-notice>`,
          display: true,
          details: { meta: { source: { type: "report", value: "background job delivery" } }, jobs: [{ jobId, type: "task", label, durationMs: 9638 }] },
        });
      },
      wait(id: string, callId: string, jobs: { id: string; status: string; label: string }[]) {
        add(id, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "wait", arguments: { i: "Wait for the lab" } }] } });
        add(`${id}r`, {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: callId,
            toolName: "wait",
            content: [{ type: "text", text: "## Completed (1)" }],
            details: { op: "wait", meta: { source: { type: "report", value: "wait" } }, jobs: jobs.map((j) => ({ ...j, type: "task", durationMs: 55938, resultText: "<task-result>12 files.</task-result>" })) },
          },
        });
      },
      rows,
    };
  };
  const tasks = (lines: string[]) =>
    parsePiTranscript(lines.join("\n")).flatMap((e) => e.parts.flatMap((p) => (p.kind === "tool" && p.call?.kind === "task" ? [p] : [])));

  test("a spawn is ongoing under its job id, named by the progress row's agent", () => {
    const s = session();
    s.spawn("a1", "c1");
    s.started("r1", "c1", "LabFix");
    const [card] = tasks(s.rows);
    expect(card?.call).toEqual({ kind: "task", summary: "Count the lab files", agent: "task", jobId: "LabFix", ongoing: true });
    expect(card?.result?.isError).toBeUndefined();
  });

  test("an async-result notice ends it, and the notice is still drawn", () => {
    const s = session();
    s.spawn("a1", "c1");
    s.started("r1", "c1", "LabFix");
    s.asyncResult("n1", "LabFix", "LabFix");
    const entries = parsePiTranscript(s.rows.join("\n"));
    const [card] = tasks(s.rows);
    expect(card?.call).toEqual({ kind: "task", summary: "Count the lab files", agent: "task", jobId: "LabFix" });
    expect(card?.result?.isError).toBeUndefined();
    expect(entries.at(-1)?.role).toBe("note");
  });

  test("a wait result with a completed job ends it", () => {
    const s = session();
    s.spawn("a1", "c1");
    s.started("r1", "c1", "LabFix");
    s.wait("w1", "c2", [{ id: "LabFix", status: "completed", label: "LabFix" }]);
    expect(tasks(s.rows)[0]?.call).toEqual({ kind: "task", summary: "Count the lab files", agent: "task", jobId: "LabFix" });
  });

  test("a wait that reports a job still running leaves the card ongoing", () => {
    const s = session();
    s.spawn("a1", "c1");
    s.started("r1", "c1", "LabFix");
    s.wait("w1", "c2", [{ id: "LabFix", status: "running", label: "LabFix" }]);
    expect(tasks(s.rows)[0]?.call).toMatchObject({ ongoing: true });
  });

  test("a failed job marks the card's result as an error, from a wait or from the notice's own status", () => {
    const viaWait = session();
    viaWait.spawn("a1", "c1");
    viaWait.started("r1", "c1", "LabFix");
    viaWait.wait("w1", "c2", [{ id: "LabFix", status: "failed", label: "LabFix" }]);
    const [waited] = tasks(viaWait.rows);
    expect(waited?.call).not.toHaveProperty("ongoing");
    expect(waited?.result?.isError).toBe(true);

    const viaNotice = session();
    viaNotice.spawn("a1", "c1");
    viaNotice.started("r1", "c1", "LabFix");
    viaNotice.asyncResult("n1", "LabFix", "LabFix", "failed");
    const [noticed] = tasks(viaNotice.rows);
    expect(noticed?.call).not.toHaveProperty("ongoing");
    expect(noticed?.result?.isError).toBe(true);
  });

  test("a second job of one name settles by its `-2` job id, and leaves the first running", () => {
    const s = session();
    s.spawn("a1", "c1", "First lab count");
    s.started("r1", "c1", "LabFix");
    s.spawn("a2", "c2", "Second lab count");
    s.started("r2", "c2", "LabFix", "LabFix-2");
    s.asyncResult("n1", "LabFix-2", "LabFix");
    const [first, second] = tasks(s.rows);
    expect(first?.call).toMatchObject({ summary: "First lab count", jobId: "LabFix", ongoing: true });
    expect(second?.call).toEqual({ kind: "task", summary: "Second lab count", agent: "task", jobId: "LabFix-2" });
    s.asyncResult("n2", "LabFix", "LabFix");
    expect(tasks(s.rows)[0]?.call).not.toHaveProperty("ongoing");
  });

  test("a notice whose job id is unknown settles the card by its label", () => {
    const s = session();
    s.spawn("a1", "c1");
    s.started("r1", "c1", "LabFix", "lab-job-1");
    s.asyncResult("n1", "lab-job-9", "LabFix");
    expect(tasks(s.rows)[0]?.call).not.toHaveProperty("ongoing");
  });

  test("two same-named jobs ongoing: a notice for an unknown job id with their shared label ends neither", () => {
    const s = session();
    s.spawn("a1", "c1", "First lab count");
    s.started("r1", "c1", "LabFix");
    s.spawn("a2", "c2", "Second lab count");
    s.started("r2", "c2", "LabFix", "LabFix-2");
    s.asyncResult("n1", "LabFix-7", "LabFix");
    s.wait("w1", "c3", [{ id: "LabFix-9", status: "completed", label: "LabFix" }]);
    const [first, second] = tasks(s.rows);
    expect(first?.call).toMatchObject({ jobId: "LabFix", ongoing: true });
    expect(second?.call).toMatchObject({ jobId: "LabFix-2", ongoing: true });
  });

  test("a failed spawn (`isError`, no `async`) is never ongoing", () => {
    const s = session();
    s.spawn("a1", "c1");
    s.failedSpawn("r1", "c1");
    const [card] = tasks(s.rows);
    expect(card?.call).toEqual({ kind: "task", summary: "Count the lab files" });
    expect(card?.result?.isError).toBe(true);
  });

  test("the reducer names the card's turn when a later row ends it", () => {
    const s = session();
    s.spawn("a1", "c1");
    s.started("r1", "c1", "LabFix");
    const reducer = createPiReducer();
    for (const line of s.rows) reducer.push(line);
    const before = s.rows.length;
    s.asyncResult("n1", "LabFix", "LabFix");
    const reduction = reducer.push(s.rows[before]!);
    expect([...reduction.changed]).toContain("a1");
  });
});

// The context dot (.adr/0115, amended 2026-10-25). The tokens are the turn's own input-side counts;
// the log names no window, so the window comes from the catalog in the agent dir above `sessions`:
// pi's `models-store.json` or Oh My Pi's `models.db`. Lab names only.
describe("the pi probe — the context", () => {
  const SID = "019f1827-bf99-7927-9684-76318de905b5";
  const answer = (id: string, usage: Record<string, JsonValue>) =>
    row(id, {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      provider: "labrouter",
      model: "lab/model-one",
      usage,
    });
  const compaction = (id: string) =>
    JSON.stringify({ type: "compaction", id, parentId: "p0", timestamp: "2026-07-29T10:05:00.000Z", summary: "…" });

  async function probeOf(lines: readonly string[], catalog?: (agentDir: string) => Promise<void>) {
    const created = `${tmpdir()}/collie-pi-context-${Math.floor(performance.now() * 1000)}`;
    const root = join(created, "sessions");
    const project = join(root, "--repo--");
    await mkdir(project, { recursive: true });
    if (catalog !== undefined) await catalog(created);
    const log = join(project, `2026-07-29T10-00-00-000Z_${SID}.jsonl`);
    await Bun.write(log, `${lines.join("\n")}\n`);
    const probe = await piJournal(root).cacheProbe?.({ kind: "path", value: await realpath(log) });
    await rm(created, { recursive: true, force: true });
    return probe;
  }

  const store = (window: JsonValue) => async (agentDir: string) => {
    await Bun.write(
      join(agentDir, "models-store.json"),
      JSON.stringify({ labrouter: { models: [{ id: "lab/other", contextWindow: 1 }, { id: "lab/model-one", contextWindow: window }] } }),
    );
  };

  test("the tokens are input, cache read and cache write together", async () => {
    const probe = await probeOf([header(), answer("a1", { input: 10, output: 5, cacheRead: 900, cacheWrite: 90 })]);
    expect(probe?.contextTokens).toBe(1000);
  });

  test("with no catalog in the agent dir there is no window", async () => {
    const probe = await probeOf([header(), answer("a1", { input: 10, cacheRead: 900, cacheWrite: 90 })]);
    expect(probe?.contextTokens).toBe(1000);
    expect(probe?.contextWindow).toBeUndefined();
  });

  test("pi's models-store.json names the window for the turn's provider and model", async () => {
    const probe = await probeOf([header(), answer("a1", { input: 10, cacheRead: 900, cacheWrite: 90 })], store(400_000));
    expect(probe?.contextWindow).toBe(400_000);
  });

  test("a window that is not a whole positive number is no window", async () => {
    const probe = await probeOf([header(), answer("a1", { input: 10, cacheRead: 900 })], store("400000"));
    expect(probe?.contextTokens).toBe(910);
    expect(probe?.contextWindow).toBeUndefined();
  });

  test("Oh My Pi's models.db names the window from a variant row of the provider", async () => {
    const probe = await probeOf([header(), answer("a1", { input: 3, cacheRead: 0, cacheWrite: 1997 })], async (agentDir) => {
      const db = new Database(join(agentDir, "models.db"));
      db.run("create table model_cache (provider_id text primary key, version integer, models text not null)");
      db.run("insert into model_cache values (?, 1, ?)", ["labrouterx", JSON.stringify([{ id: "lab/model-one", contextWindow: 7 }])]);
      db.run("insert into model_cache values (?, 1, ?)", [
        "labrouter:pseudo-api",
        JSON.stringify([{ id: "lab/model-one", provider: "labrouter", contextWindow: 262_144 }]),
      ]);
      db.close();
    });
    expect(probe?.contextTokens).toBe(2000);
    expect(probe?.contextWindow).toBe(262_144);
  });

  test("a catalog that does not name the model gives no window", async () => {
    const probe = await probeOf([header(), answer("a1", { input: 10, cacheRead: 900 })], async (agentDir) => {
      await Bun.write(join(agentDir, "models-store.json"), JSON.stringify({ labrouter: { models: [{ id: "lab/other", contextWindow: 9 }] } }));
    });
    expect(probe?.contextWindow).toBeUndefined();
  });

  test("a compaction after the turn leaves the context unknown", async () => {
    const probe = await probeOf([header(), answer("a1", { input: 10, cacheRead: 900 }), compaction("c1")], store(400_000));
    expect(probe?.turnId).toBe("a1");
    expect(probe?.contextTokens).toBeUndefined();
  });

  test("a turn after the compaction measures the new context", async () => {
    const probe = await probeOf([header(), compaction("c1"), answer("a2", { input: 40, cacheRead: 0 })], store(400_000));
    expect(probe?.contextTokens).toBe(40);
    expect(probe?.contextWindow).toBe(400_000);
  });

  test("a failed turn's zeros are passed over for the turn before it", async () => {
    const failed = answer("a2", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const probe = await probeOf([header(), answer("a1", { input: 10, cacheRead: 900 }), failed], store(400_000));
    expect(probe?.turnId).toBe("a2");
    expect(probe?.contextTokens).toBe(910);
    expect(probe?.contextWindow).toBe(400_000);
  });

  test("a usage row with no input-side counts names no context", async () => {
    const probe = await probeOf([header(), answer("a1", { output: 5 })]);
    expect(probe?.contextTokens).toBeUndefined();
  });
});

// The session cost (PaneUsage.cost): the sum of message.usage.cost.total over every assistant row,
// kept incrementally. The row shape is Oh My Pi 18.6.1's and pi's own.
describe("the pi probe — the session cost", () => {
  const SID = "019f1827-bf99-7927-9684-76318de905b5";
  const cost = (total: number) => ({ input: 3e-7, output: 0.000175, cacheRead: 0.001, cacheWrite: 0.00002, total });
  const answer = (id: string, total: number | null) => {
    const counts = { input: 3, output: 350, cacheRead: 120_007, cacheWrite: 125 };
    const usage = total === null ? counts : { ...counts, cost: cost(total) };
    return row(id, { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "labrouter", model: "lab/model-one", usage });
  };
  const user = (id: string) => row(id, { role: "user", content: [{ type: "text", text: "hi" }], usage: { cost: cost(99) } });

  async function withLog<T>(run: (log: string, probe: () => Promise<number | undefined>) => Promise<T>): Promise<T> {
    const created = await mkdtemp(join(tmpdir(), "collie-pi-cost-"));
    try {
      const root = join(created, "sessions");
      const project = join(root, "--repo--");
      await mkdir(project, { recursive: true });
      const log = join(project, `2026-07-29T10-00-00-000Z_${SID}.jsonl`);
      await Bun.write(log, "");
      const journal = piJournal(root);
      const real = await realpath(log);
      return await run(real, async () => (await journal.cacheProbe?.({ kind: "path", value: real }))?.costUsd);
    } finally {
      await rm(created, { recursive: true, force: true });
    }
  }

  test("sums two assistant rows and an aborted zero row, and ignores other roles", async () => {
    await withLog(async (log, probe) => {
      const aborted = row("a3", { role: "assistant", content: [], usage: { input: 0, output: 0, cost: cost(0) } });
      await Bun.write(log, `${[header(), user("u1"), answer("a1", 0.001390995), answer("a2", 0.25), aborted].join("\n")}\n`);
      expect(await probe()).toBeCloseTo(0.251390995, 9);
    });
  });

  test("a log that states no cost, or only zeros, has no cost", async () => {
    await withLog(async (log, probe) => {
      await Bun.write(log, `${[header(), answer("a1", null)].join("\n")}\n`);
      expect(await probe()).toBeUndefined();
      await Bun.write(log, `${[header(), answer("a1", 0)].join("\n")}\n`);
      expect(await probe()).toBeUndefined();
    });
  });

  test("a new row adds to the sum, and a torn last line waits for its newline", async () => {
    await withLog(async (log, probe) => {
      await Bun.write(log, `${[header(), answer("a1", 0.5)].join("\n")}\n`);
      expect(await probe()).toBeCloseTo(0.5, 9);
      const next = answer("a2", 0.25);
      const handle = Bun.file(log);
      const before = await handle.text();
      await Bun.write(log, before + next.slice(0, 40));
      expect(await probe()).toBeCloseTo(0.5, 9);
      await Bun.write(log, `${before}${next}\n`);
      expect(await probe()).toBeCloseTo(0.75, 9);
      expect(await probe()).toBeCloseTo(0.75, 9);
    });
  });

  test("a file replaced by a shorter one starts the sum again", async () => {
    await withLog(async (log, probe) => {
      await Bun.write(log, `${[header(), answer("a1", 0.5), answer("a2", 0.5)].join("\n")}\n`);
      expect(await probe()).toBeCloseTo(1, 9);
      await Bun.write(log, `${[header(), answer("b1", 0.125)].join("\n")}\n`);
      expect(await probe()).toBeCloseTo(0.125, 9);
    });
  });

  test("reads a big log in one pass", async () => {
    await withLog(async (log, probe) => {
      const rows = Array.from({ length: 2000 }, (_, i) => answer(`a${i}`, 0.01));
      await Bun.write(log, `${[header(), ...rows].join("\n")}\n`);
      expect(await probe()).toBeCloseTo(20, 6);
    });
  });
});

describe("PiTranscriptSource: a log older than the harness process is not the pane's (M79 spec 06)", () => {
  const OLD = "019f4665-7df0-7540-a64f-7068335f2111";
  const NEW = "019f4665-7df0-7540-a64f-7068335f2112";
  const cwd = "/srv/stale";
  /** The old log started at 10:00:00 and was last written at 10:30:00. */
  const OLD_START = Date.parse("2026-10-30T10:00:00.000Z");
  const OLD_WRITTEN = Date.parse("2026-10-30T10:30:00.000Z");

  const sessionRow = (id: string) =>
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-30T10:00:00.000Z", cwd });

  async function fixture() {
    const created = `${tmpdir()}/collie-pi-stale-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    const places = { home: join(base, "home"), tmp: join(base, "tmp") };
    const root = join(base, "pi-sessions");
    /** One log named from its start time, last written at `writtenMs`. */
    const log = async (id: string, startMs: number, writtenMs: number) => {
      const stamp = new Date(startMs).toISOString().replaceAll(":", "-").replace(".", "-");
      const path = join(root, "--srv-stale--", `${stamp}_${id}.jsonl`);
      await mkdir(join(root, "--srv-stale--"), { recursive: true });
      await Bun.write(path, `${sessionRow(id)}\n`);
      await utimes(path, new Date(writtenMs), new Date(writtenMs));
    };
    /** A source whose pid 4242 started at `startMs`; any other pid is unreadable. */
    const source = (startMs: number | null) =>
      new PiTranscriptSource(root, places, { processStartMs: async (pid) => (pid === 4242 ? startMs : null) });
    return { base, log, source };
  }

  const withPid = { processes: [{ argv: ["pi"], pid: 4242 }] };

  test("an older log and a pid that started after it: no session", async () => {
    const f = await fixture();
    await f.log(OLD, OLD_START, OLD_WRITTEN);
    expect(await f.source(Date.parse("2026-10-30T12:00:00.000Z")).discoverSession(cwd, withPid)).toBeNull();
    await rm(f.base, { recursive: true, force: true });
  });

  test("the same log and a pid that started before it: the log", async () => {
    const f = await fixture();
    await f.log(OLD, OLD_START, OLD_WRITTEN);
    expect(await f.source(OLD_START - 60_000).discoverSession(cwd, withPid)).toEqual({ kind: "id", value: OLD });
    await rm(f.base, { recursive: true, force: true });
  });

  test("no pid, or a start that cannot be read: the newest log as before", async () => {
    const f = await fixture();
    await f.log(OLD, OLD_START, OLD_WRITTEN);
    const late = f.source(Date.parse("2026-10-30T12:00:00.000Z"));
    expect(await late.discoverSession(cwd)).toEqual({ kind: "id", value: OLD });
    expect(await late.discoverSession(cwd, { processes: [{ argv: ["pi"] }] })).toEqual({ kind: "id", value: OLD });
    expect(await f.source(null).discoverSession(cwd, withPid)).toEqual({ kind: "id", value: OLD });
    await rm(f.base, { recursive: true, force: true });
  });

  test("the slack admits a log that started one second after the process", async () => {
    const f = await fixture();
    const processStart = Date.parse("2026-10-30T12:00:00.000Z");
    await f.log(NEW, processStart + 1000, processStart + 1000);
    expect(await f.source(processStart).discoverSession(cwd, withPid)).toEqual({ kind: "id", value: NEW });
    await rm(f.base, { recursive: true, force: true });
  });

  test("the slack admits a log that started 4 s before the process and refuses one 6 s before", async () => {
    const f = await fixture();
    const processStart = Date.parse("2026-10-30T12:00:00.000Z");
    await f.log(NEW, processStart - 4000, processStart - 4000);
    expect(await f.source(processStart).discoverSession(cwd, withPid)).toEqual({ kind: "id", value: NEW });
    await rm(f.base, { recursive: true, force: true });
    const g = await fixture();
    await g.log(NEW, processStart - 6000, processStart - 6000);
    expect(await g.source(processStart).discoverSession(cwd, withPid)).toBeNull();
    await rm(g.base, { recursive: true, force: true });
  });

  test("an older log the harness is writing now (a resumed session) is still the pane's", async () => {
    const f = await fixture();
    const processStart = Date.parse("2026-10-30T12:00:00.000Z");
    await f.log(OLD, OLD_START, processStart + 20_000);
    expect(await f.source(processStart).discoverSession(cwd, withPid)).toEqual({ kind: "id", value: OLD });
    await rm(f.base, { recursive: true, force: true });
  });

  test("of an older and a newer log, the newer one is taken once the process has started between them", async () => {
    const f = await fixture();
    const processStart = Date.parse("2026-10-30T12:00:00.000Z");
    await f.log(OLD, OLD_START, OLD_WRITTEN);
    await f.log(NEW, processStart + 2000, processStart + 9000);
    expect(await f.source(processStart).discoverSession(cwd, withPid)).toEqual({ kind: "id", value: NEW });
    await rm(f.base, { recursive: true, force: true });
  });
});
