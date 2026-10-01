import { describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codexCursor,
  codexToolOutput,
  CodexTranscriptSource,
  isCodexSessionId,
  parseCodexTranscript,
} from "./codex.ts";

/**
 * Any JSON document — what a row of an agent's on-disk log actually is, before the adapter parses
 * it. Object values admit `undefined` because `JSON.stringify` drops such a key entirely, which is
 * how the fixtures below express "this field is absent".
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

// Row builders mirroring the verified on-disk shape (codex rollout logs, cli 0.32.0, 2026-07-29).
// `{timestamp,type,payload}` are the only top-level keys — note the absence of any per-row id, which
// is the whole reason this adapter synthesises a cursor.
const item = (payload: Record<string, JsonValue>, ts = "2026-07-29T10:00:00.000Z") =>
  JSON.stringify({ timestamp: ts, type: "response_item", payload });

const message = (role: "user" | "assistant", text: string) =>
  item({
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });

const event = (payload: Record<string, JsonValue>) =>
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
    expect(entries.map((e) => e.parts[0]).map((p) => (p?.kind === "text" ? p.text : p?.kind))).toEqual([
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
    const part = entries[0]!.parts[0]!;
    expect(part.kind).toBe("tool");
    expect(part.kind === "tool" ? part.summary : "").not.toBe("");
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

  // The structured `call`, which sits BESIDE `name`/`summary` and never replaces either. `arguments`
  // is a JSON string, so the classifier gets it parsed while the summary keeps its own reading.
  test("a shell call carries a structured execute call and its call_id", () => {
    const entries = parseCodexTranscript(
      item({
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"], workdir: "/repo" }),
        call_id: "call_1",
      }),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "shell",
      summary: "bash -lc ls -la",
      id: "call_1",
      call: { kind: "execute", command: "bash -lc ls -la" },
    });
  });

  test("a tool outside the nine kinds degrades to `other`, keeping its own line", () => {
    const entries = parseCodexTranscript(
      item({ type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [] }), call_id: "c" }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      name: "update_plan",
      call: { kind: "other", name: "update_plan" },
    });
  });

  // Malformed arguments lose the structure and keep the sentence — the classifier reads an empty
  // input rather than being handed the raw string.
  test("malformed arguments still classify, on an empty input", () => {
    const entries = parseCodexTranscript(
      item({ type: "function_call", name: "shell", arguments: '{"command": ["bash"', call_id: "c" }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ call: { kind: "execute", command: "" } });
  });

  // `metadata.exit_code` is the ONE structured fact the output row holds (153 of the 296 rows on a
  // real machine), and it rides in the raw `output` string that `codexToolOutput` unwraps away.
  test("the output's metadata.exit_code folds onto the execute call", () => {
    const entries = parseCodexTranscript(
      [
        item({ type: "function_call", name: "shell", arguments: '{"command":["bash","-lc","false"]}', call_id: "c" }),
        item({
          type: "function_call_output",
          call_id: "c",
          output: JSON.stringify({ output: "", metadata: { exit_code: 2, duration_seconds: 0.4 } }),
        }),
      ].join("\n"),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ call: { kind: "execute", exitCode: 2 } });
  });

  test.each([
    ["no metadata at all", JSON.stringify({ output: "total 0\n", metadata: {} })],
    ["a bare non-JSON output", "Plan updated"],
  ])("%s leaves the exit code absent rather than guessing one", (_label, output) => {
    const entries = parseCodexTranscript(
      [
        item({ type: "function_call", name: "shell", arguments: '{"command":["bash"]}', call_id: "c" }),
        item({ type: "function_call_output", call_id: "c", output }),
      ].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    // Absent, not `undefined`: a key holding `undefined` would survive this compare.
    expect(part.kind === "tool" ? part.call : null).toEqual({ kind: "execute", command: "bash" });
  });

  // Codex records no error flag on an output row, so a failure and a success are the same shape and
  // `isError` is never set. A refusal is different: Codex names it in the text.
  test.each([
    ["a rejected exec", "exec command rejected by user"],
    ["a rejected patch", "patch rejected by user"],
    ["an interrupted command", "aborted by user after 30.6s"],
    ["a refusal by the operator's own rule", "writing outside of the project; rejected by user approval settings"],
  ])("%s marks the result denied", (_label, output) => {
    const entries = parseCodexTranscript(
      [
        item({ type: "function_call", name: "shell", arguments: '{"command":["bash"]}', call_id: "c" }),
        item({ type: "function_call_output", call_id: "c", output }),
      ].join("\n"),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ result: { text: output, denied: true } });
  });

  // A sandbox block is an ordinary error: nobody was asked and nobody refused.
  test("a sandbox block is not a refusal", () => {
    const output = "failed in sandbox LinuxSeccomp with execution error: sandbox denied exec error, exit code: 2";
    const entries = parseCodexTranscript(
      [
        item({ type: "function_call", name: "shell", arguments: '{"command":["bash"]}', call_id: "c" }),
        item({ type: "function_call_output", call_id: "c", output }),
      ].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    expect(part.kind === "tool" ? part.result : null).toEqual({ text: output });
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
    // `join`, because `resolve` answers with this platform's separators and a test compares to it.
    const a = join(base, "a");
    const b = join(base, "b");
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
      join(b, "2026", "08", "11", `rollout-2026-08-11T10-00-00-${B}.jsonl`),
    );
    await rm(base, { recursive: true, force: true });
  });
});

// ── custom_tool_call: the shape codex reaches for most (spec M41/12) ─────────
//
// Rows built here from the grammar measured on 2026-10-01 over 53 `custom_tool_call` and 52
// `custom_tool_call_output` rows on one host. No recorded rollout is used as a fixture, ever: a real
// one carries the contents of every file the agent read.
const customCall = (callId: string, script: string) =>
  item({ type: "custom_tool_call", id: "ct_1", status: "completed", call_id: callId, name: "exec", input: script });

const customOut = (callId: string, output: JsonValue) =>
  item({ type: "custom_tool_call_output", id: "cto_1", call_id: callId, output });

const PREAMBLE = "Script completed\nWall time 0.1 seconds\nOutput:\n";

describe("parseCodexTranscript — custom_tool_call", () => {
  test("a custom call and its list output read as one structured execute", () => {
    const entries = parseCodexTranscript(
      [meta(), customCall("c1", "cat README.md"), customOut("c1", [
        { type: "input_text", text: PREAMBLE },
        { type: "input_text", text: "# canary\n" },
        { type: "input_text", text: "exit_code=0" },
      ])].join("\n"),
    );
    expect(entries).toHaveLength(1);
    const part = entries[0]!.parts[0]!;
    expect(part.kind).toBe("tool");
    if (part.kind !== "tool") throw new Error("not a tool part");
    expect(part.name).toBe("exec");
    expect(part.summary).toBe("cat README.md");
    // `exec` is not `execute`: without the name in tool-call.ts's table this classified as `other`,
    // and the command never showed.
    expect(part.call).toEqual({ kind: "execute", command: "cat README.md", exitCode: 0 });
    // The preamble is dropped and the trailer is read, so the result is the output and nothing else.
    expect(part.result?.text).toBe("# canary\n");
  });

  test("a non-zero trailer is the exit code", () => {
    const entries = parseCodexTranscript(
      [meta(), customCall("c1", "touch /x"), customOut("c1", [
        { type: "input_text", text: PREAMBLE },
        { type: "input_text", text: "touch: cannot touch '/x': Read-only file system\n" },
        { type: "input_text", text: "1" },
      ])].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("not a tool part");
    expect(part.call).toEqual({ kind: "execute", command: "touch /x", exitCode: 1 });
    expect(part.result?.text).toBe("touch: cannot touch '/x': Read-only file system\n");
  });

  test("a two-block output is all output — a number there is not an exit code", () => {
    const entries = parseCodexTranscript(
      [meta(), customCall("c1", "echo 42"), customOut("c1", [
        { type: "input_text", text: PREAMBLE },
        { type: "input_text", text: "42" },
      ])].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("not a tool part");
    expect(part.result?.text).toBe("42");
    expect(part.call).toEqual({ kind: "execute", command: "echo 42" });
  });

  test("a bare string output still reads, and a refusal is a refusal", () => {
    const entries = parseCodexTranscript(
      [meta(), customCall("c1", "rm -rf /"), customOut("c1", "aborted by user after 8.5s")].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("not a tool part");
    expect(part.result?.text).toBe("aborted by user after 8.5s");
    expect(part.result?.denied).toBe(true);
  });

  test("a preamble with nothing under it is kept — the script is still running", () => {
    const entries = parseCodexTranscript(
      [meta(), customCall("c1", "sleep 60"), customOut("c1", [
        { type: "input_text", text: "Script running with cell ID 4\nWall time 31.0 seconds\nOutput:\n" },
        { type: "input_text", text: "" },
      ])].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("not a tool part");
    expect(part.result?.text).toContain("Script running with cell ID 4");
  });

  test("an unrecognised preamble leaves the text whole rather than losing a line of it", () => {
    const entries = parseCodexTranscript(
      [meta(), customCall("c1", "ls"), customOut("c1", [
        { type: "input_text", text: "Some future header\n" },
        { type: "input_text", text: "a.ts\n" },
      ])].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("not a tool part");
    expect(part.result?.text).toBe("Some future header\n\na.ts\n");
  });

  test("a JSON-object input is still taken as itself", () => {
    const entries = parseCodexTranscript(
      [meta(), item({
        type: "custom_tool_call",
        call_id: "c1",
        name: "read",
        input: JSON.stringify({ path: "/repo/a.ts" }),
      })].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("not a tool part");
    expect(part.call).toEqual({ kind: "read", path: "/repo/a.ts" });
  });
});
