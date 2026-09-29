import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HermesTranscriptSource,
  isHermesSessionId,
  parseHermesTranscript,
} from "./hermes.ts";

const SID = "20260909_154520_9e0b91";

describe("Hermes session ids", () => {
  test("accepts Hermes ids and rejects path-shaped input", () => {
    expect(isHermesSessionId(SID)).toBe(true);
    expect(isHermesSessionId("../../state.db")).toBe(false);
    expect(isHermesSessionId("2026_bad")).toBe(false);
  });
});

describe("parseHermesTranscript", () => {
  test("renders user, assistant, reasoning, tool call, and tool result rows", () => {
    const text = [
      JSON.stringify({ id: 1, role: "user", content: "show history", timestamp: 1 }),
      JSON.stringify({
        id: 2,
        role: "assistant",
        content: "I will inspect it.",
        reasoning: "Need read-only history.",
        tool_calls: JSON.stringify([{ id: "call-1", function: { name: "terminal", arguments: '{"command":"pwd"}' } }]),
        timestamp: 2,
      }),
      JSON.stringify({
        id: 3,
        role: "tool",
        tool_call_id: "call-1",
        tool_name: "terminal",
        content: "/home/james",
        timestamp: 3,
      }),
    ].join("\n");

    expect(parseHermesTranscript(text)).toEqual([
      { uuid: "1", ts: "1970-01-01T00:00:01.000Z", role: "user", parts: [{ kind: "text", text: "show history" }] },
      {
        uuid: "2",
        ts: "1970-01-01T00:00:02.000Z",
        role: "assistant",
        parts: [
          { kind: "thinking", text: "Need read-only history." },
          { kind: "text", text: "I will inspect it." },
          {
            kind: "tool",
            name: "terminal",
            summary: "pwd",
            id: "call-1",
            call: { kind: "other", name: "terminal", summary: "pwd" },
          },
        ],
      },
      {
        uuid: "3",
        ts: "1970-01-01T00:00:03.000Z",
        role: "note",
        parts: [{ kind: "tool", name: "terminal", summary: "", id: "call-1", result: { text: "/home/james" } }],
      },
    ]);
  });
});

describe("HermesTranscriptSource", () => {
  test("resolves and reads one session from state.db read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-"));
    const db = new Database(join(root, "state.db"));
    db.run("create table sessions (id text primary key, source text, started_at real, parent_session_id text)");
    db.run("create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)");
    db.run("insert into sessions (id, source, started_at, parent_session_id) values (?, 'tui', 1, null)", [SID]);
    db.run("insert into messages (id, session_id, role, content, timestamp) values (1, ?, 'user', 'older turn', 1)", [SID]);
    db.close();

    const source = new HermesTranscriptSource(root);
    const key = await source.resolve({ kind: "id", value: SID });
    expect(key).toContain("#" + SID);
    const loaded = await source.load(key!);
    expect(parseHermesTranscript(loaded.text)[0]?.parts[0]).toEqual({ kind: "text", text: "older turn" });

    await rm(root, { recursive: true, force: true });
  });
});
// Hermes' `tool_calls` column is an OpenAI-shaped array, so the structured call comes from
// `function.arguments` and nothing else: the `tool` row that answers a call records only its text.
describe("parseHermesTranscript: the structured tool call", () => {
  /** One OpenAI-shaped entry of hermes' `tool_calls` column. `id` is absent on purpose in the test
   *  that pins an id-less call, so it is optional here rather than a second builder. */
  interface ToolCallRow {
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: unknown };
  }

  const assistantCall = (calls: ToolCallRow[]) =>
    JSON.stringify({ id: 2, role: "assistant", tool_calls: JSON.stringify(calls), timestamp: 2 });

  const firstTool = (text: string) => {
    const part = parseHermesTranscript(text).flatMap((e) => e.parts).find((p) => p.kind === "tool");
    // SAFETY: `find` on the `kind === "tool"` predicate returns that branch or nothing; the throw
    // rules out nothing, so the narrowing below is what the predicate already proved.
    if (part === undefined || part.kind !== "tool") throw new Error("no tool part in the rows");
    return part;
  };

  test("a read carries its path and its id", () => {
    const part = firstTool(
      assistantCall([{ id: "call-9", function: { name: "read_file", arguments: '{"path":"/src/a.ts"}' } }]),
    );
    expect(part.id).toBe("call-9");
    expect(part.call).toEqual({ kind: "read", path: "/src/a.ts" });
    // The one-line form is unchanged by the classification beside it.
    expect(part.summary).toBe("/src/a.ts");
  });

  test("an already-parsed arguments object classifies the same way", () => {
    // Hermes writes `arguments` as a JSON string, but a row carrying the object itself still reads.
    const part = firstTool(assistantCall([{ function: { name: "bash", arguments: { command: "ls -la" } } }]));
    expect(part.call).toEqual({ kind: "execute", command: "ls -la" });
  });

  test("a call with no id leaves the id absent rather than empty", () => {
    const part = firstTool(assistantCall([{ function: { name: "grep", arguments: '{"pattern":"todo"}' } }]));
    expect("id" in part).toBe(false);
    expect(part.call).toEqual({ kind: "search", query: "todo" });
  });

  test("Hermes' own tool names fall through to other, still carrying the summary", () => {
    const part = firstTool(assistantCall([{ function: { name: "terminal", arguments: '{"command":"pwd"}' } }]));
    expect(part.call).toEqual({ kind: "other", name: "terminal", summary: "pwd" });
  });

  test("a tool row keeps its id and carries no structured call", () => {
    // The row holds no input, and no column says what the call did — so a `call` here could only
    // invent an empty path or command. Absent is the honest answer, and `isError` stays absent too.
    const rows = parseHermesTranscript(
      JSON.stringify({
        id: 3,
        role: "tool",
        tool_call_id: "call-9",
        tool_name: "read_file",
        content: "const a = 1",
        timestamp: 3,
      }),
    );
    expect(rows[0]?.parts).toEqual([
      { kind: "tool", name: "read_file", summary: "", id: "call-9", result: { text: "const a = 1" } },
    ]);
  });

  test("a tool row with no tool_call_id leaves the id absent", () => {
    const rows = parseHermesTranscript(
      JSON.stringify({ id: 4, role: "tool", tool_name: "terminal", content: "done", timestamp: 4 }),
    );
    expect(rows[0]?.parts).toEqual([{ kind: "tool", name: "terminal", summary: "", result: { text: "done" } }]);
  });
});
