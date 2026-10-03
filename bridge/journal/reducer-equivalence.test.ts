import { describe, expect, test } from "bun:test";

import { KNOWN_HARNESS_NAMES } from "./registry.ts";
import { createLineFeeder, type RowReducer } from "./reduce.ts";
import { createClaudeReducer, parseClaudeTranscript } from "./claude.ts";
import { createCodexReducer, parseCodexTranscript } from "./codex.ts";
import { createGrokReducer, parseGrokTranscript } from "./grok.ts";
import { createHermesReducer, parseHermesTranscript } from "./hermes.ts";
import { createMuseReducer, parseMuseTranscript } from "./muse.ts";
import { createOpencodeReducer, parseOpencodeTranscript } from "./opencode.ts";
import { createPiReducer, parsePiTranscript } from "./pi.ts";
import type { TranscriptEntry } from "./types.ts";

// ── THE GATE FOR THE ROW REDUCER ────────────────────────────────────────────────────────────────
//
// A reducer is only worth having if it gives the same answer as the whole-file parser it replaces.
// This file is that proof, per adapter, three ways:
//
//   1. `parse(wholeText)`, which is what every other test in this directory already drives.
//   2. A fresh reducer fed one complete row at a time.
//   3. A fresh reducer fed the SAME bytes in random chunk sizes, so a cut can land mid-row, inside a
//      JSON string, or between the two characters of an escaped `\n`.
//
// Case 3 is the one that matters, and it is the only thing that proves a real tail is safe: a tail
// reads whatever bytes are on disk at that moment, not whatever rows are finished. Case 1 and 2 agree
// by construction (`parseWith` cuts on `\n` exactly as `parse` did), so a failure there means a
// reducer kept state it should not have. A failure in 3 means the line boundary is wrong.
//
// The chunk sizes are drawn from a SEEDED generator, so a failure names the seed and repeats.

/** A tiny LCG. Seeded, because a flaky equivalence failure is worse than no test at all. */
function chunker(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Split `text` into chunks of 1..max bytes, drawn from the seeded generator. */
function randomChunks(text: string, seed: number, max = 24): string[] {
  const next = chunker(seed);
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(next() * max);
    out.push(text.slice(at, at + size));
    at += size;
  }
  return out;
}

/** Everything a reducer added over a whole text, fed one complete row at a time. */
function byRow(make: () => RowReducer, text: string): TranscriptEntry[] {
  const reducer = make();
  const out: TranscriptEntry[] = [];
  for (const line of text.split("\n")) for (const e of reducer.push(line).added) out.push(e);
  return out;
}

/** Everything a reducer added over the same bytes arriving as torn chunks. */
function byChunks(make: () => RowReducer, text: string, seed: number): TranscriptEntry[] {
  const reducer = make();
  const feeder = createLineFeeder();
  const out: TranscriptEntry[] = [];
  for (const chunk of randomChunks(text, seed)) {
    for (const line of feeder.push(chunk)) for (const e of reducer.push(line).added) out.push(e);
  }
  // A reader at the end of its input flushes; a reader tailing a live file does not (see LineFeeder).
  for (const line of feeder.flush()) for (const e of reducer.push(line).added) out.push(e);
  return out;
}

/**
 * The three readings agree. Called per adapter with that adapter's own corpus.
 *
 * `toEqual` over the whole entry list is deliberate: a reducer that dropped a tool result, attached
 * it to the wrong call, or lost a part's enrichment would still produce the right NUMBER of turns.
 */
function expectEquivalent(make: () => RowReducer, parse: (text: string) => TranscriptEntry[], text: string): void {
  const whole = parse(text);
  expect(whole.length).toBeGreaterThan(0); // a corpus that parses to nothing proves nothing
  expect(byRow(make, text)).toEqual(whole);
  for (const seed of [1, 7, 4_242, 98_765, 0xc0_ffee]) {
    expect(byChunks(make, text, seed), `seed ${seed}`).toEqual(whole);
  }
}

/**
 * The adapters this file covers, one name per line.
 *
 * Checked against the registry below rather than kept as a comment, so an eighth adapter cannot land
 * without a section here: the reducer is the seam a live tail reads through, and an adapter with no
 * equivalence proof is an adapter whose tail nobody has checked.
 */
const COVERED = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "grok",
  "hermes",
  "muse",
] as const;

test("every harness the registry knows has an equivalence section here", () => {
  expect([...KNOWN_HARNESS_NAMES].toSorted()).toEqual([...COVERED].toSorted());
});

// Rubbish every corpus below ends with, because a tail read produces all of it: a blank row, a
// scalar, a bare null, an object of the wrong shape, and a half-written final row with no newline.
const RUBBISH = ["", "12", "null", '"a string"', '{"type":"summary"}', '{"type":"user","mess'];

/**
 * Any JSON document — what a row of an agent's on-disk log actually is, before the adapter parses it.
 * The same local type every other test file in this directory declares, for the same reason: object
 * values admit `undefined` because `JSON.stringify` drops such a key, which is how a corpus below
 * says "this field is absent".
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

describe("claude: a reducer reads a torn stream the way the parser reads a whole file", () => {
  const row = (o: Record<string, JsonValue>) => JSON.stringify(o);
  const text = [
    row({ type: "user", uuid: "u1", timestamp: "2026-07-25T06:22:21.253Z", message: { role: "user", content: "hello" } }),
    // An escaped newline inside a string value, which is the only way a row can carry one: the chunk
    // splitter must never mistake the two characters `\` `n` for the byte 0x0A.
    row({
      type: "user",
      uuid: "u2",
      timestamp: "2026-07-25T06:22:22.000Z",
      message: { role: "user", content: "line one\nline two\ttabbed" },
    }),
    row({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-07-25T06:22:24.093Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I will read it." },
          { type: "text", text: "Reading the file." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/src/a.ts" } },
        ],
      },
    }),
    // THE ROW THIS WHOLE DESIGN IS ABOUT: it folds a result into a turn emitted two rows ago, and
    // carries the `toolUseResult` that says what the call actually did.
    row({
      type: "user",
      uuid: "u3",
      timestamp: "2026-07-25T06:22:25.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "const a = 1" }] },
      toolUseResult: { type: "text", file: { numLines: 1 } },
    }),
    // An orphan result, whose call fell outside the window.
    row({
      type: "user",
      uuid: "u4",
      timestamp: "2026-07-25T06:22:26.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "gone", content: "orphan output" }] },
    }),
    ...RUBBISH,
  ].join("\n");

  test("the three readings agree", () => {
    expectEquivalent(() => createClaudeReducer(), parseClaudeTranscript, text);
  });

  test("a result names the turn it changed, and never one it just added", () => {
    const reducer = createClaudeReducer();
    const rows = text.split("\n");
    const seen = rows.map((line) => reducer.push(line));
    // The assistant turn `a1` went out on its own row with no result yet.
    const call = seen.find((r) => r.added[0]?.uuid === "a1");
    expect(call?.changed).toEqual([]);
    // Two rows later the result lands, adds no turn of its own, and names `a1`.
    const fold = seen[3];
    expect(fold?.added).toEqual([]);
    expect(fold?.changed).toEqual(["a1"]);
    // The orphan is the other way round: a turn of its own, and nothing changed.
    expect(seen[4]?.added).toHaveLength(1);
    expect(seen[4]?.changed).toEqual([]);
  });

  test("the folded result is on the call, in the turn the caller already holds", () => {
    const reducer = createClaudeReducer();
    const held: TranscriptEntry[] = [];
    for (const line of text.split("\n")) for (const e of reducer.push(line).added) held.push(e);
    const tool = held.find((e) => e.uuid === "a1")?.parts.find((p) => p.kind === "tool");
    expect(tool?.kind === "tool" && tool.result?.text).toBe("const a = 1");
  });
});

describe("codex: a reducer reads a torn stream the way the parser reads a whole file", () => {
  const item = (payload: Record<string, JsonValue>, ts = "2026-07-29T10:00:00.000Z") =>
    JSON.stringify({ timestamp: ts, type: "response_item", payload });
  const say = (role: "user" | "assistant", text: string) =>
    item({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
  const text = [
    JSON.stringify({ timestamp: "2026-07-29T10:00:00.000Z", type: "session_meta", payload: { id: "s", cwd: "/repo" } }),
    say("user", "fix the types"),
    // Two IDENTICAL rows, which is what `codexCursor`'s occurrence map exists for: the second must
    // get its own uuid or a caller cannot tell the two turns apart. A reducer that lost that state
    // between rows would give them the same name, and the equivalence check is what proves it did not.
    say("assistant", "Looking."),
    say("assistant", "Looking."),
    say("assistant", "line one\nline two"),
    item({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls"] }), call_id: "call_1" }),
    item({ type: "function_call_output", call_id: "call_1", output: JSON.stringify({ output: "total 0\n", metadata: { exit_code: 0 } }) }),
    // An output whose call fell outside the window.
    item({ type: "function_call_output", call_id: "gone", output: JSON.stringify({ output: "orphan", metadata: {} }) }),
    JSON.stringify({ timestamp: "2026-07-29T10:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "dropped" } }),
    ...RUBBISH,
  ].join("\n");

  test("the three readings agree", () => {
    expectEquivalent(() => createCodexReducer(), parseCodexTranscript, text);
  });

  test("two identical rows keep two uuids, which is the carried state working", () => {
    const uuids = parseCodexTranscript(text).map((e) => e.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
  });
});

describe("grok: a reducer reads a torn stream the way the parser reads a whole file", () => {
  const text = [
    JSON.stringify({ type: "system", content: "You are Grok" }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>run the suite</user_query>" }], prompt_index: 1 }),
    JSON.stringify({ type: "assistant", content: "one\ntwo" }),
    JSON.stringify({ type: "assistant", content: "", tool_calls: [{ id: "c1", name: "bash", arguments: '{"command":"bun test"}' }] }),
    JSON.stringify({ type: "tool_result", tool_call_id: "c1", content: "exit status 1" }),
    JSON.stringify({ type: "tool_result", tool_call_id: "gone", content: "orphan" }),
    ...RUBBISH,
  ].join("\n");

  test("the three readings agree", () => {
    expectEquivalent(() => createGrokReducer(), parseGrokTranscript, text);
  });
});

describe("pi: a reducer reads a torn stream the way the parser reads a whole file", () => {
  const row = (id: string, message: Record<string, JsonValue>) =>
    JSON.stringify({ type: "message", id, parentId: "p0", timestamp: "2026-07-29T10:00:00.000Z", message });
  const text = [
    JSON.stringify({ type: "session", version: 3, id: "019f1827-bf99-7927-9684-76318de905b5", cwd: "/repo" }),
    row("m1", { role: "user", content: [{ type: "text", text: "read it" }] }),
    row("m2", { role: "assistant", content: [{ type: "text", text: "one\ntwo" }] }),
    row("m3", { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/x" } }] }),
    row("m4", { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file contents" }] }),
    row("m5", { role: "toolResult", toolCallId: "gone", toolName: "read", content: [{ type: "text", text: "orphan" }] }),
    ...RUBBISH,
  ].join("\n");

  test("the three readings agree", () => {
    expectEquivalent(() => createPiReducer(), parsePiTranscript, text);
  });
});

describe("opencode: a reducer reads a torn stream the way the parser reads a whole file", () => {
  const line = (id: string, data: JsonValue, parts: JsonValue[], ts = 1_785_743_162_994) =>
    JSON.stringify({ id, ts, data, parts: parts.map((d, i) => ({ id: `prt_${id}_${i}`, data: d })) });
  const text = [
    line("msg_a", { role: "user", time: { created: 1 }, agent: "build" }, [{ type: "text", text: "hi", time: { start: 1, end: 2 } }]),
    line("msg_b", { role: "assistant", time: { created: 2 }, path: { cwd: "/repo", root: "/" } }, [
      { type: "reasoning", text: "thinking", time: { start: 1, end: 2 }, metadata: {} },
      { type: "text", text: "one\ntwo", time: { start: 1, end: 2 } },
      // A tool part carries its own result INSIDE the composed line, which is why this adapter folds
      // nothing across rows (see the comment at `createOpencodeReducer`).
      { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "ls" }, output: "total 0" } },
    ]),
    ...RUBBISH,
  ].join("\n");

  test("the three readings agree", () => {
    expectEquivalent(() => createOpencodeReducer(), parseOpencodeTranscript, text);
  });
});

describe("muse: a reducer reads a torn stream the way the parser reads a whole file", () => {
  const row = (id: string, payloadType: string, payload: Record<string, JsonValue>) =>
    JSON.stringify({ schema_version: 1, id, recorded_at: 1790904354495081, payload_type: payloadType, payload });
  const text = [
    row("row-1", "runtime.user_intent.accepted", {
      model_messages: [{ role: "user", content: [{ kind: "text", text: "run it" }] }],
    }),
    row("row-2", "runtime.session", {
      kind: "run",
      run_id: "run-1",
      event: { kind: "assistant_message_committed", message_id: "m1", text: "one\ntwo" },
    }),
    row("row-3", "runtime.session", {
      kind: "run",
      run_id: "run-1",
      event: {
        kind: "assistant_tool_calls_committed",
        message_id: "m1",
        tool_calls: [{ id: "fc_0", call_id: "call_1", name: "bash", args: '{"command":"ls"}' }],
      },
    }),
    row("row-4", "runtime.session", {
      kind: "run",
      run_id: "run-1",
      event: {
        kind: "tool_result_batch_committed",
        message_id: "m1",
        results: [{ tool_call_id: "call_1", tool_call_index: 0, text: "total 0" }],
      },
    }),
    row("row-5", "runtime.session", {
      kind: "run",
      run_id: "run-1",
      event: {
        kind: "tool_result_batch_committed",
        message_id: "m1",
        results: [{ tool_call_id: "gone", tool_call_index: 0, text: "orphan" }],
      },
    }),
    ...RUBBISH,
  ].join("\n");

  test("the three readings agree", () => {
    expectEquivalent(() => createMuseReducer(), parseMuseTranscript, text);
  });
});

describe("hermes: a reducer reads a torn stream the way the parser reads a whole file", () => {
  const text = [
    JSON.stringify({ id: 1, role: "user", content: "show history", timestamp: 1 }),
    JSON.stringify({ id: 2, role: "assistant", content: "one\ntwo", reasoning: "read-only", timestamp: 2 }),
    JSON.stringify({
      id: 3,
      role: "assistant",
      content: "Running it.",
      tool_calls: JSON.stringify([{ id: "call-1", function: { name: "bash", arguments: '{"command":"pwd"}' } }]),
      timestamp: 3,
    }),
    JSON.stringify({ id: 4, role: "tool", tool_call_id: "call-1", tool_name: "bash", content: "/home/you", timestamp: 4 }),
    ...RUBBISH,
  ].join("\n");

  test("the three readings agree", () => {
    expectEquivalent(() => createHermesReducer(), parseHermesTranscript, text);
  });
});

describe("the line feeder", () => {
  test("holds a fragment until the row is complete", () => {
    const feeder = createLineFeeder();
    expect(feeder.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(feeder.push("2}")).toEqual([]);
    expect(feeder.push("\n")).toEqual(['{"b":2}']);
    expect(feeder.flush()).toEqual([]);
  });

  test("gives up its fragment only on flush, which is what a whole-file read does", () => {
    const feeder = createLineFeeder();
    expect(feeder.push('{"a":1}\n{"b":2}')).toEqual(['{"a":1}']);
    expect(feeder.flush()).toEqual(['{"b":2}']);
    expect(feeder.flush()).toEqual([]);
  });

  test("passes a run of empty rows through rather than swallowing them", () => {
    // `text.split("\n")` yields an empty string per blank row, and the reducers skip them. A feeder
    // that dropped them would still agree, but only by luck: nothing here may decide what a row means.
    expect(createLineFeeder().push("a\n\n\nb\n")).toEqual(["a", "", "", "b"]);
  });
});
