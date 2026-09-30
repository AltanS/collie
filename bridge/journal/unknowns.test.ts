import { describe, expect, test } from "bun:test";

import { createClaudeReducer } from "./claude.ts";
import { createCodexReducer } from "./codex.ts";
import { createGrokReducer } from "./grok.ts";
import { createHermesReducer } from "./hermes.ts";
import { createOpencodeReducer } from "./opencode.ts";
import { createPiReducer } from "./pi.ts";
import {
  createUnknownCounter,
  describeUnknowns,
  UNKNOWN_NAMES_MAX,
  UNKNOWN_OVERFLOW,
  unknownCount,
  type RowReducer,
} from "./reduce.ts";
import { buildJournalRegistry, journalAgents } from "./registry.ts";

// ── THE GATE FOR "WHAT THIS READER DID NOT RECOGNISE" ───────────────────────────────────────────
//
// Spec M41/05. Each reducer counts the row kinds and content kinds it had no branch for, and the
// canary fails a run above zero, naming the type. Two properties are what make that gate worth
// having, and both are pinned here per adapter:
//
//   1. A corpus of the types the adapter HAS met counts nothing — including the ones it drops on
//      purpose, and including every kind of rubbish a tail read produces. A gate that cries on a
//      normal session is a gate somebody turns off.
//   2. A type the vendor ADDED is counted and NAMED, at whichever level it appeared: the row's own
//      kind, a role, or a content block.
//
// Nothing here reads a real session: every corpus is built in the test, for the reason spec M41/05
// declined recorded sessions as fixtures (a Claude JSONL carries file contents from every Read).

/** Any JSON document — the same local type every other test in this directory declares. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

const row = (o: Record<string, JsonValue>) => JSON.stringify(o);

/** Rubbish every corpus ends with, because a tail read produces all of it. None of it is a TYPE. */
const RUBBISH = ["", "   ", "12", "null", "true", '"a string"', "[1,2]", '{"no":"type"}', '{"type":"user","mess'];

/** Push every line and answer the tally. */
function tallyOf(reducer: RowReducer, lines: readonly string[]) {
  for (const line of [...lines, ...RUBBISH]) reducer.push(line);
  return reducer.unknowns();
}

/** The names a tally holds, sorted, so an assertion reads as an inventory. */
function names(counts: ReadonlyMap<string, number>): string[] {
  return [...counts.keys()].toSorted();
}

describe("claude", () => {
  const clean = [
    row({ type: "user", uuid: "u1", timestamp: "t", message: { role: "user", content: "hello" } }),
    row({
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "thinking", thinking: "hm" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
          // Dropped on purpose, and listed in CLAUDE_KNOWN for exactly that reason.
          { type: "image", source: { type: "base64", data: "x" } },
        ],
      },
    }),
    row({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    // The bookkeeping half of the inventory, one row each.
    ...["attachment", "queue-operation", "last-prompt", "atis-latch", "mode", "permission-mode", "custom-title", "agent-name", "ai-title", "file-history-snapshot", "file-history-delta", "cost-state", "fork-context-ref", "started", "result", "launched", "summary"].map((type) =>
      row({ type, uuid: "b" }),
    ),
    row({ type: "system", subtype: "compact_boundary", uuid: "s1" }),
    row({ type: "continued-in", continuedInSessionId: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9" }),
  ];

  test("the whole measured inventory counts nothing", () => {
    const tally = tallyOf(createClaudeReducer(), clean);
    expect(describeUnknowns(tally)).toBe("");
    expect(unknownCount(tally)).toBe(0);
  });

  test("a row type Claude Code adds is counted and named", () => {
    const tally = tallyOf(createClaudeReducer(), [...clean, row({ type: "time-travel", uuid: "z" }), row({ type: "time-travel", uuid: "z2" })]);
    expect(names(tally.rows)).toEqual(["time-travel"]);
    expect(tally.rows.get("time-travel")).toBe(2);
    expect(describeUnknowns(tally)).toBe("row types time-travel (2)");
  });

  test("a content block Claude Code adds is counted and named", () => {
    const tally = tallyOf(createClaudeReducer(), [
      row({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "web_search_result", url: "x" }] } }),
    ]);
    expect(names(tally.parts)).toEqual(["web_search_result"]);
    expect(describeUnknowns(tally)).toBe("part types web_search_result (1)");
  });
});

describe("codex", () => {
  const item = (payload: Record<string, JsonValue>) => row({ timestamp: "t", type: "response_item", payload });
  const clean = [
    row({ timestamp: "t", type: "session_meta", payload: { id: "s", cwd: "/repo" } }),
    row({ timestamp: "t", type: "event_msg", payload: { type: "agent_message", message: "dropped" } }),
    row({ timestamp: "t", type: "token_usage_record", payload: {} }),
    row({ timestamp: "t", type: "turn_context", payload: {} }),
    row({ timestamp: "t", type: "world_state", payload: {} }),
    item({ type: "message", role: "user", content: [{ type: "input_text", text: "fix the types" }] }),
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] }),
    // Injected system prompts: a role the grammar refuses by name.
    item({ type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] }),
    item({ type: "function_call", name: "shell", arguments: '{"command":["ls"]}', call_id: "c1" }),
    item({ type: "function_call_output", call_id: "c1", output: '{"output":"ok","metadata":{"exit_code":0}}' }),
    // Dropped today, listed in CODEX_KNOWN with the gap written down beside it.
    item({ type: "custom_tool_call", name: "apply_patch", input: "***" }),
    item({ type: "custom_tool_call_output", call_id: "c2", output: "done" }),
  ];

  test("the whole measured inventory counts nothing", () => {
    expect(describeUnknowns(tallyOf(createCodexReducer(), clean))).toBe("");
  });

  test("both levels of 'what is this row' are counted: the envelope and the payload", () => {
    const tally = tallyOf(createCodexReducer(), [
      ...clean,
      row({ timestamp: "t", type: "rollout_meta", payload: {} }),
      item({ type: "web_search_call", action: {} }),
    ]);
    expect(names(tally.rows)).toEqual(["rollout_meta", "web_search_call"]);
  });

  test("a role and a content block are counted where they appear", () => {
    const tally = tallyOf(createCodexReducer(), [item({ type: "message", role: "tool", content: [{ type: "input_image", url: "x" }] })]);
    expect(names(tally.rows)).toEqual(["role:tool"]);
    expect(names(tally.parts)).toEqual(["input_image"]);
  });
});

describe("grok", () => {
  const clean = [
    row({ type: "system", content: "You are Grok" }),
    row({ type: "user", content: [{ type: "text", text: "<user_query>run it</user_query>" }], prompt_index: 1 }),
    row({ type: "reasoning", id: "rs1", summary: [{ type: "summary_text", text: "planning" }] }),
    row({ type: "assistant", content: "one", tool_calls: [{ id: "c1", name: "bash", arguments: '{"command":"ls"}' }] }),
    row({ type: "backend_tool_call", kind: { tool_type: "web_search", action: { query: "x" } } }),
    row({ type: "tool_result", tool_call_id: "c1", content: "exit 0" }),
  ];

  test("the header's own inventory counts nothing", () => {
    expect(describeUnknowns(tallyOf(createGrokReducer(), clean))).toBe("");
  });

  test("a new row type and a new content block are both counted", () => {
    const tally = tallyOf(createGrokReducer(), [...clean, row({ type: "memory", content: [{ type: "image_url", url: "x" }] })]);
    expect(names(tally.rows)).toEqual(["memory"]);
    expect(names(tally.parts)).toEqual(["image_url"]);
  });
});

describe("hermes", () => {
  const clean = [
    row({ id: 1, role: "user", content: "show history", timestamp: 1 }),
    row({ id: 2, role: "assistant", content: "one", reasoning: "read-only", timestamp: 2 }),
    row({ id: 3, role: "tool", tool_call_id: "c1", tool_name: "bash", content: "/home/you", timestamp: 3 }),
    // Hidden and inactive rows render nothing and are still roles this adapter has met.
    row({ id: 4, role: "assistant", content: "gone", timestamp: 4, active: 0, compacted: 0 }),
    row({ id: 5, role: "user", content: "hidden", timestamp: 5, display_kind: "hidden" }),
  ];

  test("the three modelled roles count nothing", () => {
    expect(describeUnknowns(tallyOf(createHermesReducer(), clean))).toBe("");
  });

  test("an unmodelled role is counted, where `rowEntry` only answers null", () => {
    const tally = tallyOf(createHermesReducer(), [...clean, row({ id: 6, role: "system", content: "prompt", timestamp: 6 })]);
    expect(names(tally.rows)).toEqual(["role:system"]);
  });

  test("its part tally is empty by format, never by omission", () => {
    // Hermes has no content discriminator at all: content is a column, and a tool call is a JSON
    // array with no type on it. There is nothing here a vendor could add a value to.
    const tally = tallyOf(createHermesReducer(), [...clean, row({ id: 7, role: "wat", content: "x", timestamp: 7 })]);
    expect(tally.parts.size).toBe(0);
  });
});

describe("opencode", () => {
  const line = (role: string, parts: JsonValue[]) =>
    row({ id: `msg_${role}`, ts: 1, data: { role, time: { created: 1 } }, parts: parts.map((d, i) => ({ id: `prt_${i}`, data: d })) });
  const clean = [
    line("user", [{ type: "text", text: "hi", time: { start: 1, end: 2 } }]),
    line("assistant", [
      { type: "step-start" },
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "one" },
      { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "ls" }, output: "ok" } },
      // The three this adapter drops today, each listed in OPENCODE_KNOWN with the gap beside it.
      { type: "patch", hash: "abc" },
      { type: "file", filename: "a.png" },
      { type: "compaction", auto: true },
      { type: "step-finish" },
    ]),
    line("summary", [{ type: "text", text: "compacted" }]),
  ];

  test("the whole measured inventory counts nothing", () => {
    expect(describeUnknowns(tallyOf(createOpencodeReducer(), clean))).toBe("");
  });

  test("a role and a part type OpenCode adds are counted and named", () => {
    const tally = tallyOf(createOpencodeReducer(), [...clean, line("assistant", [{ type: "snapshot", id: "s" }]), line("tool", [])]);
    expect(names(tally.rows)).toEqual(["role:tool"]);
    expect(names(tally.parts)).toEqual(["snapshot"]);
  });
});

describe("pi", () => {
  const message = (id: string, m: Record<string, JsonValue>) => row({ type: "message", id, parentId: "p0", timestamp: "t", message: m });
  const clean = [
    row({ type: "session", version: 3, id: "019f1827-bf99-7927-9684-76318de905b5", cwd: "/repo" }),
    message("m1", { role: "user", content: [{ type: "text", text: "read it" }] }),
    message("m2", { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }] }),
    message("m3", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "contents" }] }),
    message("m4", { role: "bashExecution", command: "ls", output: "a.ts", exitCode: 0 }),
    message("m5", { role: "system", content: "injected context" }),
    message("m6", { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] }),
    row({ type: "compaction", id: "c9", parentId: "p0", summary: "so far" }),
    row({ type: "branch_summary", id: "c10", parentId: "p0", summary: "branch" }),
    row({ type: "custom_message", id: "c11", parentId: "p0", display: true, content: "a note" }),
    // An extension's own bookkeeping: `customType` + `data`, no `display`, nothing to show.
    row({ type: "custom", id: "c12", parentId: "p0", customType: "pi.todo", data: {} }),
    ...["model_change", "thinking_level_change", "usage", "label"].map((type) => row({ type, id: `k-${type}`, parentId: "p0" })),
  ];

  test("the whole measured inventory counts nothing", () => {
    expect(describeUnknowns(tallyOf(createPiReducer(), clean))).toBe("");
  });

  test("a new row type, a new role and a new block are each counted at their own level", () => {
    const tally = tallyOf(createPiReducer(), [
      ...clean,
      row({ type: "queue", id: "q1", parentId: "p0" }),
      message("m7", { role: "agentHandoff", content: [{ type: "audio", data: "x" }] }),
    ]);
    expect(names(tally.rows)).toEqual(["queue", "role:agentHandoff"]);
    expect(names(tally.parts)).toEqual(["audio"]);
    // The `user` fallback at the bottom of `draw` would otherwise swallow that role in silence.
    expect(tally.rows.get("role:agentHandoff")).toBe(1);
  });
});

describe("the counter itself", () => {
  test("a tally is a snapshot: a later row cannot change what a caller holds", () => {
    const reducer = createClaudeReducer();
    reducer.push(JSON.stringify({ type: "first-new", uuid: "a" }));
    const held = reducer.unknowns();
    reducer.push(JSON.stringify({ type: "second-new", uuid: "b" }));
    expect(names(held.rows)).toEqual(["first-new"]);
    expect(names(reducer.unknowns().rows)).toEqual(["first-new", "second-new"]);
  });

  test("the name list is bounded and the COUNT is not", () => {
    const reducer = createClaudeReducer();
    const over = UNKNOWN_NAMES_MAX + 8;
    for (let i = 0; i < over; i++) reducer.push(JSON.stringify({ type: `new-${i}`, uuid: "x" }));
    const tally = reducer.unknowns();
    // The first MAX names are kept — a format change shows up in the first rows that carry it — and
    // the rest are counted under one name rather than dropped.
    expect(tally.rows.size).toBe(UNKNOWN_NAMES_MAX + 1);
    expect(tally.rows.has("new-0")).toBe(true);
    expect(tally.rows.has(`new-${over - 1}`)).toBe(false);
    expect(tally.rows.get(UNKNOWN_OVERFLOW)).toBe(8);
    expect(unknownCount(tally)).toBe(over);
  });

  test("a value that is not a non-empty string is not a type", () => {
    const counter = createUnknownCounter({ rows: ["user"], roles: [], parts: [] });
    const notTypes: (JsonValue | undefined)[] = [undefined, null, "", 7, true, ["a"], { a: 1 }];
    for (const value of notTypes) counter.row(value);
    expect(counter.tally().rows.size).toBe(0);
  });

  test("describeUnknowns names both levels, commonest first", () => {
    const counter = createUnknownCounter({ rows: [], roles: [], parts: [] });
    counter.row("beta");
    counter.row("alpha");
    counter.row("alpha");
    counter.part("gamma");
    expect(describeUnknowns(counter.tally())).toBe("row types alpha (2), beta (1); part types gamma (1)");
  });
});

// A seventh adapter cannot land without a tally: the canary's gate reads every registered adapter's
// reducer, and one that answered nothing would be an agent whose drift nobody is watching.
test("every registered journal adapter's reducer answers a tally", () => {
  const registry = buildJournalRegistry({ claude: [], codex: [], pi: [], opencode: [], grok: [], hermes: [] });
  expect(journalAgents(registry)).toHaveLength(6);
  for (const [agent, adapter] of Object.entries(registry)) {
    const tally = adapter.reducer().unknowns();
    expect(tally.rows.size, agent).toBe(0);
    expect(tally.parts.size, agent).toBe(0);
  }
});
