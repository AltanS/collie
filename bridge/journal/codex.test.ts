import { describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  codexCursor,
  codexToolOutput,
  CodexTranscriptSource,
  isCodexSessionId,
  parseCodexTranscript,
} from "./codex.ts";

// Row builders mirroring the verified on-disk shape (codex rollout logs, cli 0.32.0, 2026-07-29).
// `{timestamp,type,payload}` are the only top-level keys — note the absence of any per-row id, which
// is the whole reason this adapter synthesises a cursor.
const item = (payload: Record<string, unknown>, ts = "2026-07-29T10:00:00.000Z") =>
  JSON.stringify({ timestamp: ts, type: "response_item", payload });

const message = (role: "user" | "assistant", text: string) =>
  item({
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });

const event = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-07-29T10:00:00.000Z", type: "event_msg", payload });

const meta = () =>
  JSON.stringify({
    timestamp: "2026-07-29T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "116ee214-d563-4bcc-95f2-f03c5330d354", cwd: "/repo", cli_version: "0.32.0" },
  });

describe("isCodexSessionId", () => {
  test.each([
    ["a canonical uuid", "116ee214-d563-4bcc-95f2-f03c5330d354", true],
    ["a traversal attempt", "../../../etc/passwd", false],
    ["a uuid with a path glued on", "116ee214-d563-4bcc-95f2-f03c5330d354/../x", false],
    ["empty", "", false],
  ])("%s → %s", (_label, value, expected) => {
    expect(isCodexSessionId(value)).toBe(expected);
  });
});

describe("parseCodexTranscript", () => {
  test("reads a user turn and an assistant turn", () => {
    const entries = parseCodexTranscript(
      [meta(), message("user", "fix the types"), message("assistant", "I'll open the file.")].join("\n"),
    );
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "fix the types" }]);
    expect(entries[0]!.ts).toBe("2026-07-29T10:00:00.000Z");
  });

  // THE trap in this format: every turn is written twice, once per family. Parsing both renders the
  // whole conversation double.
  test("drops the event_msg family — the conversation is double-booked", () => {
    const entries = parseCodexTranscript(
      [
        message("user", "fix the types"),
        event({ type: "user_message", message: "fix the types" }),
        event({ type: "agent_message", message: "on it" }),
        event({ type: "token_count", info: {} }),
        message("assistant", "on it"),
      ].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.parts[0]).map((p) => (p as { text: string }).text)).toEqual([
      "fix the types",
      "on it",
    ]);
  });

  test("session_meta and other bookkeeping rows render nothing", () => {
    expect(parseCodexTranscript(meta())).toEqual([]);
  });

  // Live-verified against codex 0.145: three `developer` rows carrying injected system prompts
  // (permissions, multi-agent instructions) precede the first real turn. Mapping "not assistant" to
  // "user" — which the parser used to do — rendered those as things the operator had said.
  test.each(["developer", "system", "tool"])("a %s role is plumbing and renders nothing", (role) => {
    const entries = parseCodexTranscript(
      item({
        type: "message",
        role,
        content: [{ type: "input_text", text: "<permissions instructions>…" }],
      }),
    );
    expect(entries).toEqual([]);
  });

  test.each([
    ["world_state", { type: "world_state", state: {} }],
    ["turn_context", { type: "turn_context", cwd: "/repo" }],
  ])("the 0.145 row type %s renders nothing", (_label, payload) => {
    expect(parseCodexTranscript(item(payload))).toEqual([]);
  });

  test("a reasoning summary becomes a thinking part (unlike Claude, this one has text)", () => {
    const entries = parseCodexTranscript(
      item({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "**Inspecting TypeScript errors**" }],
        content: null,
        encrypted_content: "gAAAAA…",
      }),
    );
    expect(entries[0]!.parts).toEqual([
      { kind: "thinking", text: "**Inspecting TypeScript errors**" },
    ]);
  });

  test("an encrypted-only reasoning row renders nothing rather than an empty bubble", () => {
    const entries = parseCodexTranscript(
      item({ type: "reasoning", summary: [], content: null, encrypted_content: "gAAAAA…" }),
    );
    expect(entries).toEqual([]);
  });

  // `arguments` is a JSON STRING here (pi passes an object), and a shell call's `command` is an argv
  // ARRAY — both were places a naive reuse of the Claude summariser produced an empty line.
  test("a shell call summarises to its joined argv", () => {
    const entries = parseCodexTranscript(
      item({
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"], timeout_ms: 120000 }),
        call_id: "call_1",
      }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      name: "shell",
      summary: "bash -lc ls -la",
    });
  });

  test("malformed arguments still summarise to something", () => {
    const entries = parseCodexTranscript(
      item({ type: "function_call", name: "shell", arguments: '{"command": ["bash"', call_id: "c" }),
    );
    expect((entries[0]!.parts[0] as { summary: string }).summary).not.toBe("");
  });

  test("an output folds onto the call that produced it", () => {
    const entries = parseCodexTranscript(
      [
        item({ type: "function_call", name: "shell", arguments: "{}", call_id: "call_1" }),
        item({
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ output: "total 0\n", metadata: {} }),
        }),
      ].join("\n"),
    );
    // One entry, not two: the result attaches to its call rather than becoming its own turn.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      result: { text: "total 0\n" },
    });
  });

  test("an orphan output is kept unattached so the window never drops output", () => {
    const entries = parseCodexTranscript(
      item({ type: "function_call_output", call_id: "gone", output: '{"output":"stranded"}' }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ kind: "tool", name: "result" });
  });

  test("injected environment context is dropped, not rendered as something you said", () => {
    const entries = parseCodexTranscript(
      [
        message("user", "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"),
        message("user", "help me fix the typescript errors"),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts[0]).toMatchObject({ text: "help me fix the typescript errors" });
  });

  test("a clipped or partial line is skipped, not thrown on", () => {
    const entries = parseCodexTranscript(
      ['{"timestamp":"2026","type":"response_i', message("user", "hi")].join("\n"),
    );
    expect(entries).toHaveLength(1);
  });

  test("every entry gets a cursor, and identical rows still get distinct ones", () => {
    const dup = item({ type: "function_call", name: "shell", arguments: "{}", call_id: "c" });
    const entries = parseCodexTranscript([dup, dup].join("\n"));
    expect(entries).toHaveLength(2);
    expect(entries[0]!.uuid).not.toBe(entries[1]!.uuid);
    expect(entries.every((e) => e.uuid !== "")).toBe(true);
  });
});

describe("codexToolOutput", () => {
  test("unwraps the JSON envelope codex writes", () => {
    expect(codexToolOutput('{"output":"hello","metadata":{}}')).toBe("hello");
  });

  test("a non-JSON output is its own text rather than nothing", () => {
    expect(codexToolOutput("plain text")).toBe("plain text");
  });

  test("JSON without an output field falls back to the raw string", () => {
    expect(codexToolOutput('{"other":1}')).toBe('{"other":1}');
  });
});

describe("codexCursor", () => {
  test("is deterministic for the same row", () => {
    expect(codexCursor("a", new Map())).toBe(codexCursor("a", new Map()));
  });

  test("depends on content, not position — the point of hashing rather than counting", () => {
    const seen = new Map<string, number>();
    codexCursor("filler", seen);
    codexCursor("filler", seen);
    // "a" is the third row here but the first anywhere else; its cursor must not encode that.
    expect(codexCursor("a", seen)).toBe(codexCursor("a", new Map()));
  });
});

// The fs half. Codex's resolve is a targeted walk of date-partitioned directories, and it now walks
// EACH configured sessions root in turn (a second CODEX_HOME is the same multi-home case Claude's
// CLAUDE_CONFIG_DIR raised — issue #92). Real files, because containment runs on realpaths.
describe("CodexTranscriptSource — several sessions roots", () => {
  const A = "11111111-aaaa-bbbb-cccc-222222222222";
  const B = "33333333-dddd-eeee-ffff-444444444444";

  /**
   * base/a/2026/08/11/rollout-…-<A>.jsonl   the first home's log
   * base/b/2026/08/11/rollout-…-<B>.jsonl   the second home's log
   * base/outside.jsonl                      a file neither root may reach
   */
  async function fixture() {
    const created = `${tmpdir()}/collie-codex-roots-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    const a = `${base}/a`;
    const b = `${base}/b`;
    await mkdir(`${a}/2026/08/11`, { recursive: true });
    await mkdir(`${b}/2026/08/11`, { recursive: true });
    await Bun.write(`${a}/2026/08/11/rollout-2026-08-11T09-00-00-${A}.jsonl`, "{}\n");
    await Bun.write(`${b}/2026/08/11/rollout-2026-08-11T10-00-00-${B}.jsonl`, "{}\n");
    await Bun.write(`${base}/outside.jsonl`, "{}\n");
    return { base, a, b };
  }

  test("a single root string behaves exactly as before", async () => {
    const { base, a } = await fixture();
    const src = new CodexTranscriptSource(a);
    expect(await src.resolve({ kind: "id", value: A })).toEndWith(`${A}.jsonl`);
    expect(await src.resolve({ kind: "id", value: B })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("finds a session under whichever root holds it", async () => {
    const { base, a, b } = await fixture();
    const src = new CodexTranscriptSource([a, b]);
    expect(await src.resolve({ kind: "id", value: A })).toEndWith(`${A}.jsonl`);
    expect(await src.resolve({ kind: "id", value: B })).toEndWith(`${B}.jsonl`);
    await rm(base, { recursive: true, force: true });
  });

  test("a rollout symlinked out of its root is refused, and the next root still answers", async () => {
    const { base, a, b } = await fixture();
    await symlink(`${base}/outside.jsonl`, `${a}/2026/08/11/rollout-2026-08-11T11-00-00-${B}.jsonl`);
    const src = new CodexTranscriptSource([a, b]);
    expect(await src.resolve({ kind: "id", value: B })).toBe(
      `${b}/2026/08/11/rollout-2026-08-11T10-00-00-${B}.jsonl`,
    );
    await rm(base, { recursive: true, force: true });
  });
});
