import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NO_CURSOR } from "./cursor.ts";
import { FIRST_TAIL_ROWS } from "./files.ts";
import {
  isOpencodeSessionId,
  OpencodeTranscriptSource,
  opencodeJournal,
  opencodeKey,
  opencodeResets,
  opencodeResetsV2,
  parseOpencodeTranscript,
  splitOpencodeKey,
} from "./opencode.ts";
import { MAX_RESULT_CHARS, MAX_TEXT_CHARS } from "./text.ts";

// The Windows runner is ~10x slower on the sqlite fixtures (8 s against 0.25 s on Linux), past bun's 5 s
// default. The budget is per file: bun resets the default for the next test file.
setDefaultTimeout(process.platform === "win32" ? 30_000 : 5_000);

// Builders mirroring the verified on-disk shape (opencode 1.18.9, 2026-08-03): a message row's `data`
// json plus its parts' `data` json, composed by the source into one JSONL line per message.

/**
 * Any JSON document — what a row of an agent's on-disk log actually is, before the adapter parses
 * it. Object values admit `undefined` because `JSON.stringify` drops such a key entirely, which is
 * how the fixtures below express "this field is absent".
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

const SID = "ses_03969c19cffeJrZCPOT6zG8Bm7";

const line = (
  id: string,
  data: JsonValue,
  parts: JsonValue[],
  ts = 1785743162994,
): string => JSON.stringify({ id, ts, data, parts: parts.map((d, i) => ({ id: `prt_${id}_${i}`, data: d })) });

const userData = (created = 1785743162994) => ({
  role: "user",
  time: { created },
  agent: "build",
  model: { providerID: "openrouter", modelID: "x-ai/grok-4.5", variant: "medium" },
  summary: { diffs: [] },
});

const assistantData = (created = 1785743163208) => ({
  parentID: "msg_fc6963e72001DFecQ29CaIN5de",
  role: "assistant",
  mode: "build",
  agent: "build",
  variant: "medium",
  path: { cwd: "/repo", root: "/" },
  cost: 0.0147,
  time: { created },
});

const textPart = (text: string) => ({ type: "text", text, time: { start: 1, end: 2 } });
const reasoningPart = (text: string) => ({ type: "reasoning", text, time: { start: 1, end: 2 }, metadata: {} });
const toolPart = (tool: string, state: Record<string, JsonValue>) => ({
  type: "tool",
  tool,
  callID: "call_1",
  state,
});

// V2 (opencode 2.0.12, verified 2026-09-22): a message row's `data` carries no `role` — the row's
// `type` column does — and, for an assistant turn, the parts inline as `content`. Builders for the
// on-disk shapes the source composes from.

const v2UserData = (text: string, created = 1785743162994) => ({
  time: { created },
  text,
  files: [],
  agents: [],
});

const v2AssistantData = (created = 1785743163208, content: JsonValue[] = [textPart("I'll open the file.")]) => ({
  time: { created, streamed: created + 1, completed: created + 2 },
  agent: "build",
  model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" },
  content,
});

const v2CompactionData = (created = 1785743164000) => ({
  time: { created },
  status: "completed",
  reason: "manual",
  model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" },
  summary: "## Objective\nShip the fix.",
});

// The two on-disk schemas, as DDL: fixtures build one or both in a temp opencode.db, and the column
// sets are the ones the adapter's queries touch.
const V1_SCHEMA = [
  "create table session (id text primary key, parent_id text, title text, time_created integer, time_updated integer)",
  "create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)",
  "create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)",
] as const;

const V2_SCHEMA = [
  "create table session_v2 (id text primary key, parent_id text, title text, time_created integer, time_updated integer)",
  "create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)",
] as const;

/** A database at `path` with `schema` applied — the fixtures' one way to build a store. */
function openDb(path: string, schema: readonly string[]): Database {
  const db = new Database(path);
  for (const ddl of schema) db.run(ddl);
  return db;
}

describe("isOpencodeSessionId", () => {
  test.each([
    ["a reported session id", SID, true],
    ["another real one", "ses_0531ed10affel9vU6GggxXLdd5", true],
    ["a traversal attempt", "../../../etc/passwd", false],
    ["an id with a path glued on", `${SID}/../x`, false],
    ["a sql fragment", "ses_x' or 1=1 --", false],
    ["the wrong prefix", "msg_03969c19cffeJrZCPOT6zG8Bm7", false],
    ["too short", "ses_abc", false],
    ["empty", "", false],
  ])("%s → %s", (_label, value, expected) => {
    expect(isOpencodeSessionId(value)).toBe(expected);
  });
});

// The virtual key is this adapter's answer to "one database, many sessions" — the store caches by
// whatever resolve() returns, so the session id has to be IN it.
describe("the virtual key", () => {
  test("round-trips a db path and a session id", () => {
    const key = opencodeKey("/data/opencode/opencode.db", SID);
    expect(key).toBe(`/data/opencode/opencode.db#${SID}`);
    expect(splitOpencodeKey(key)).toEqual({ dbPath: "/data/opencode/opencode.db", sessionId: SID });
  });

  test("splits at the LAST '#', so a directory containing one still works", () => {
    expect(splitOpencodeKey(`/data/my#dir/opencode.db#${SID}`)).toEqual({
      dbPath: "/data/my#dir/opencode.db",
      sessionId: SID,
    });
  });

  test.each(["/no/hash/here", `#${SID}`, "/db#not-a-session"])("%s is not a key", (key) => {
    expect(splitOpencodeKey(key)).toBeNull();
  });
});

describe("parseOpencodeTranscript", () => {
  test("reads a user turn and an assistant turn", () => {
    const entries = parseOpencodeTranscript(
      [
        line("msg_a", userData(), [textPart("fix the types")]),
        line("msg_b", assistantData(), [textPart("I'll open the file.")]),
      ].join("\n"),
    );
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "fix the types" }]);
  });

  test("uuid IS the message id — opencode gives every message a stable primary key", () => {
    const entries = parseOpencodeTranscript(line("msg_a", userData(), [textPart("hi")]));
    expect(entries[0]!.uuid).toBe("msg_a");
  });

  test("ts comes from data.time.created", () => {
    const entries = parseOpencodeTranscript(line("msg_a", userData(1785743162994), [textPart("hi")]));
    expect(entries[0]!.ts).toBe(new Date(1785743162994).toISOString());
  });

  test("ts falls back to the row's time_created when the json carries no time", () => {
    const entries = parseOpencodeTranscript(
      line("msg_a", { role: "user" }, [textPart("hi")], 1700000000000),
    );
    expect(entries[0]!.ts).toBe(new Date(1700000000000).toISOString());
  });

  test("reasoning becomes a thinking part", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [reasoningPart("The user wants…"), textPart("JOURNAL PROBE OK")]),
    );
    expect(entries[0]!.parts).toEqual([
      { kind: "thinking", text: "The user wants…" },
      { kind: "text", text: "JOURNAL PROBE OK" },
    ]);
  });

  test("a completed tool call carries its result", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        toolPart("read", {
          status: "completed",
          input: { filePath: "/repo/sample.ts" },
          output: "export const x = 1\n",
        }),
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "read",
      summary: "/repo/sample.ts",
      id: "call_1",
      call: { kind: "read", path: "/repo/sample.ts" },
      result: { text: "export const x = 1\n" },
    });
  });

  test("an errored tool call flags isError and shows the error text", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        toolPart("bash", { status: "error", input: { command: "false" }, error: "exit status 1" }),
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      summary: "false",
      id: "call_1",
      call: { kind: "execute", command: "false" },
      result: { text: "exit status 1", isError: true },
    });
  });

  test("a pending tool call has no result — it hasn't happened yet", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        toolPart("bash", { status: "pending", input: { command: "sleep 5" } }),
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      summary: "sleep 5",
      id: "call_1",
      call: { kind: "execute", command: "sleep 5" },
    });
  });

  // V2 tool parts spell the name `name` (V1 spells it `tool`) and hold the result as a `content`
  // array where V1 wrote `state.output` — both shapes are pinned because both are on disk today.
  test("a V2 tool call reads its `name` and joins its content-array result", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        {
          type: "tool",
          id: "call_00_Ag99YRR4kyERibbscesO5674",
          name: "skill",
          executed: false,
          state: {
            status: "completed",
            input: { id: "opencode" },
            content: [
              { type: "text", text: "skill loaded" },
              { type: "text", text: "second line" },
            ],
          },
        },
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "skill",
      summary: "opencode",
      id: "call_00_Ag99YRR4kyERibbscesO5674",
      // `skill` is outside the nine kinds, so it is `other` — and still reads exactly as before.
      call: { kind: "other", name: "skill", summary: "opencode" },
      result: { text: "skill loaded\nsecond line" },
    });
  });

  test("a V2 errored tool call reads its sentence from the content array too", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        {
          type: "tool",
          id: "call_1",
          name: "bash",
          state: {
            status: "error",
            input: { command: "false" },
            content: [{ type: "text", text: "exit status 1" }],
          },
        },
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      summary: "false",
      id: "call_1",
      call: { kind: "execute", command: "false" },
      result: { text: "exit status 1", isError: true },
    });
  });

  // Upstream's `ToolStateError` (2.0.12, packages/schema/src/session-message.ts): `error` is a
  // `{type, message}` record and `content` is optional, so the message is the only sentence.
  test("a V2 errored tool call with no content shows its error record's message", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        {
          type: "tool",
          id: "call_1",
          name: "bash",
          state: {
            status: "error",
            input: { command: "false" },
            error: { type: "tool.execution", message: "command exited 1" },
          },
        },
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      summary: "false",
      id: "call_1",
      call: { kind: "execute", command: "false" },
      result: { text: "command exited 1", isError: true },
    });
  });

  test("a V2 running tool call has no result yet", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        {
          type: "tool",
          id: "call_1",
          name: "bash",
          state: { status: "running", input: { command: "sleep 5" } },
        },
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      summary: "sleep 5",
      id: "call_1",
      call: { kind: "execute", command: "sleep 5" },
    });
  });

  // The error branch's precedence is old behavior the V2 refactor must not disturb: a `state.error`
  // that IS a string wins over a non-empty output even when empty, because the key's presence is the
  // verdict. Pinned here since `toolErrorText` moved the logic.
  test("an empty state.error still wins over state.output", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        toolPart("bash", { status: "error", input: { command: "false" }, error: "", output: "noise" }),
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      summary: "false",
      id: "call_1",
      call: { kind: "execute", command: "false" },
      result: { text: "", isError: true },
    });
  });

  test("step-start / step-finish are bookkeeping and render nothing", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        { type: "step-start" },
        textPart("done"),
        { reason: "stop", type: "step-finish", tokens: { total: 8958 }, cost: 0.0147 },
      ]),
    );
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "done" }]);
  });

  test("an unknown part type is dropped rather than guessed at", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [{ type: "patch", hunks: [] }, textPart("done")]),
    );
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "done" }]);
  });

  // V2 composes a compaction as the `summary` role — the transcript vocabulary renders it set apart
  // from speech rather than as an assistant turn.
  test("a summary role renders (V2's compaction)", () => {
    const entries = parseOpencodeTranscript(
      line("msg_c", { role: "summary", time: { created: 1789482840361 } }, [textPart("## Objective")]),
    );
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([["msg_c", "summary"]]);
  });

  // Same rule and same rationale as codex.ts's `developer` guard: an unmodelled role is plumbing, and
  // rendering it as speech would put words in the operator's mouth.
  test.each(["system", "developer", "tool", undefined])("role %s renders nothing", (role) => {
    expect(parseOpencodeTranscript(line("msg_x", { role }, [textPart("plumbing")]))).toEqual([]);
  });

  test("a message whose parts are all skipped emits no entry", () => {
    const entries = parseOpencodeTranscript(
      [
        line("msg_a", assistantData(), [{ type: "step-start" }]),
        line("msg_b", assistantData(), [textPart("real")]),
      ].join("\n"),
    );
    expect(entries.map((e) => e.uuid)).toEqual(["msg_b"]);
  });

  test("a clipped or partial line is skipped, not thrown on", () => {
    const entries = parseOpencodeTranscript(
      ['{"id":"msg_a","ts":1785,"data":{"role":"us', line("msg_b", userData(), [textPart("hi")])].join("\n"),
    );
    expect(entries).toHaveLength(1);
  });

  test("a row whose data column wasn't json renders nothing rather than throwing", () => {
    expect(parseOpencodeTranscript(line("msg_a", null, [textPart("hi")]))).toEqual([]);
  });

  test("text and results are clamped", () => {
    const entries = parseOpencodeTranscript(
      [
        line("msg_a", userData(), [textPart("x".repeat(MAX_TEXT_CHARS + 10))]),
        line("msg_b", assistantData(), [
          toolPart("read", {
            status: "completed",
            input: { filePath: "/f" },
            output: "y".repeat(MAX_RESULT_CHARS + 10),
          }),
        ]),
      ].join("\n"),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ truncated: true });
    const first = entries[0]!.parts[0]!;
    expect(first.kind === "text" ? first.text : "").toHaveLength(MAX_TEXT_CHARS);
    expect(entries[1]!.parts[0]).toMatchObject({ result: { truncated: true } });
  });

  test("ansi escapes are stripped — nothing downstream interprets them", () => {
    const entries = parseOpencodeTranscript(
      line("msg_a", userData(), [textPart("\x1b[2mdim\x1b[0m text")]),
    );
    expect(entries[0]!.parts[0]).toEqual({ kind: "text", text: "dim text" });
  });
});

// The source needs a real database: it is the one adapter whose resolve/stat/load are SQL, and the
// containment check that protects the file (which also holds OAuth tokens) can only be exercised
// against real paths and a real symlink.
describe("OpencodeTranscriptSource", () => {
  const SUB = "ses_0531ed10affel9vU6GggxXLdd5";

  /**
   * base/data/opencode.db            the real database (root = base/data)
   * base/outside/opencode.db         a database no root may reach
   * base/tricky/opencode.db → ../outside/opencode.db   the right name, the wrong file
   */
  async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-")));
    const root = join(base, "data");
    await mkdir(root, { recursive: true });
    const outside = join(base, "outside");
    await mkdir(outside, { recursive: true });

    const db = openDb(join(root, "opencode.db"), V1_SCHEMA);
    db.run("insert into session values ('" + SID + "', null, 'root session', 1, 100)");
    // A subagent session — its rows are never queried, which is why no sidechain filtering exists.
    db.run("insert into session values ('" + SUB + "', '" + SID + "', 'subagent', 1, 100)");
    const msg = (id: string, created: number, data: JsonValue) =>
      db.run("insert into message values (?, ?, ?, ?, ?)", [id, SID, created, created, JSON.stringify(data)]);
    const part = (id: string, messageId: string, created: number, data: JsonValue) =>
      db.run("insert into part values (?, ?, ?, ?, ?, ?)", [
        id,
        messageId,
        SID,
        created,
        created,
        JSON.stringify(data),
      ]);
    msg("msg_b", 200, assistantData());
    msg("msg_a", 100, userData());
    part("prt_b2", "msg_b", 220, textPart("second"));
    part("prt_b1", "msg_b", 210, textPart("first"));
    part("prt_a1", "msg_a", 110, textPart("hello"));
    db.close();

    // A database sitting outside, reachable only through a symlinked root.
    const outer = openDb(join(outside, "opencode.db"), V1_SCHEMA);
    outer.run("insert into session values ('" + SID + "', null, 'outside', 1, 1)");
    outer.close();
    const tricky = join(base, "tricky");
    await mkdir(tricky, { recursive: true });
    await symlink(join(outside, "opencode.db"), join(tricky, "opencode.db"));

    return { base, root, tricky };
  }

  test("resolves a known session to the virtual key", async () => {
    const { base, root } = await fixture();
    const key = await new OpencodeTranscriptSource(root).resolve({ kind: "id", value: SID });
    expect(key).toBe(`${join(root, "opencode.db")}#${SID}`);
    await rm(base, { recursive: true, force: true });
  });

  test("a subagent session still resolves — the plugin never reports one, but nothing here lies", async () => {
    const { base, root } = await fixture();
    const key = await new OpencodeTranscriptSource(root).resolve({ kind: "id", value: SUB });
    expect(key).toBe(`${join(root, "opencode.db")}#${SUB}`);
    await rm(base, { recursive: true, force: true });
  });

  test.each([
    ["a path ref — opencode only ever reports an id", { kind: "path", value: "/etc/passwd" } as const],
    ["a malformed id", { kind: "id", value: "../../etc/passwd" } as const],
    ["a sql fragment", { kind: "id", value: "ses_x' or '1'='1" } as const],
    ["an unknown session", { kind: "id", value: "ses_ffffffffffffffffffffffff" } as const],
  ])("refuses %s", async (_label, ref) => {
    const { base, root } = await fixture();
    expect(await new OpencodeTranscriptSource(root).resolve(ref)).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("a missing database resolves to null, not a throw", async () => {
    const src = new OpencodeTranscriptSource(join(tmpdir(), "collie-opencode-nope"));
    expect(await src.resolve({ kind: "id", value: SID })).toBeNull();
  });

  // The database also holds OAuth tokens, so containment runs even though the path is a CONSTANT:
  // `opencode.db` itself can be a symlink, and then the fixed name points at another user's file.
  // Symlink resolution is the entire reason the check runs on realpaths.
  test("an opencode.db that symlinks out of the root fails containment", async () => {
    const { base, tricky } = await fixture();
    expect(await new OpencodeTranscriptSource(tricky).resolve({ kind: "id", value: SID })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("stat counts message + part rows and takes the newest touch", async () => {
    const { base, root } = await fixture();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: SID }))!;
    expect(await src.stat(key)).toEqual({ size: 5, mtimeMs: 220 });
    await rm(base, { recursive: true, force: true });
  });

  // The cache-validity contract: a streaming session must invalidate. Both halves move.
  test("stat moves when a part row is added", async () => {
    const { base, root } = await fixture();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: SID }))!;
    const before = (await src.stat(key))!;
    const db = new Database(join(root, "opencode.db"));
    db.run("insert into part values (?, ?, ?, ?, ?, ?)", [
      "prt_b3",
      "msg_b",
      SID,
      300,
      300,
      JSON.stringify(textPart("third")),
    ]);
    db.close();
    const after = (await src.stat(key))!;
    expect(after.size).toBe(before.size + 1);
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    await rm(base, { recursive: true, force: true });
  });

  test("stat of a non-key is null", async () => {
    expect(await new OpencodeTranscriptSource("/nope").stat("/not-a-key")).toBeNull();
  });

  test("load composes messages oldest-first with their parts in id order", async () => {
    const { base, root } = await fixture();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: SID }))!;
    const { text, complete, size, mtimeMs } = await src.load(key);
    expect(complete).toBe(true);
    expect(size).toBe(5);
    expect(mtimeMs).toBe(220);

    const entries = parseOpencodeTranscript(text);
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["msg_a", "user"],
      ["msg_b", "assistant"],
    ]);
    expect(entries[1]!.parts).toEqual([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    await rm(base, { recursive: true, force: true });
  });

  test("load of a non-key is empty rather than a throw", async () => {
    expect(await new OpencodeTranscriptSource("/nope").load("/not-a-key")).toEqual({
      text: "",
      complete: true,
      size: 0,
      mtimeMs: 0,
    });
  });
});

// OpenCode with more than one data dir: each holds its own opencode.db, so a session is looked up in
// each in turn (the multi-home case of issue #92). The virtual key already carries the database path,
// so stat/load need no change — only resolve had to learn to ask more than one database.
describe("OpencodeTranscriptSource — several data dirs", () => {
  const OTHER_SID = "ses_0396aa19cffeJrZCPOT6zG8Bm8";

  async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-roots-")));
    const first = join(base, "first");
    const second = join(base, "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    for (const [dir, id] of [
      [first, SID],
      [second, OTHER_SID],
    ] as const) {
      const db = openDb(join(dir, "opencode.db"), V1_SCHEMA);
      db.run("insert into session values (?, null, 'session', 1, 1)", [id]);
      db.close();
    }
    return { base, first, second };
  }

  test("resolves a session from whichever database holds it", async () => {
    const { base, first, second } = await fixture();
    const src = new OpencodeTranscriptSource([first, second]);
    expect(await src.resolve({ kind: "id", value: SID })).toBe(`${join(first, "opencode.db")}#${SID}`);
    expect(await src.resolve({ kind: "id", value: OTHER_SID })).toBe(
      `${join(second, "opencode.db")}#${OTHER_SID}`,
    );
    await rm(base, { recursive: true, force: true });
  });

  test("a data dir with no database is skipped, not fatal", async () => {
    const { base, second } = await fixture();
    const src = new OpencodeTranscriptSource([join(base, "nothing-here"), second]);
    expect(await src.resolve({ kind: "id", value: OTHER_SID })).toBe(
      `${join(second, "opencode.db")}#${OTHER_SID}`,
    );
    await rm(base, { recursive: true, force: true });
  });

  test("a single root string behaves exactly as before", async () => {
    const { base, first } = await fixture();
    const src = new OpencodeTranscriptSource(first);
    expect(await src.resolve({ kind: "id", value: OTHER_SID })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});

// V2 (opencode 2.0.12, verified 2026-09-22): sessions live in `session_v2`, and each turn is ONE
// `session_message` row whose `data` carries the role-less message plus its inline `content`. This
// fixture deliberately has NO V1 tables, which is what proves stat/load never fall back to them.
describe("OpencodeTranscriptSource — the V2 store", () => {
  const V2_SID = "ses_f34fa06cfffepZ7TTIJqHH4SiU";

  async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-v2-")));
    const root = join(base, "data");
    await mkdir(root, { recursive: true });
    const db = openDb(join(root, "opencode.db"), V2_SCHEMA);
    const session = (id: string, parentId: string | null) =>
      db.run("insert into session_v2 values (?, ?, 'session', 1, 100)", [id, parentId]);
    const msg = (id: string, type: string, seq: number, created: number, updated: number, data: JsonValue) =>
      db.run("insert into session_message values (?, ?, ?, ?, ?, ?, ?)", [
        id,
        V2_SID,
        type,
        seq,
        created,
        updated,
        JSON.stringify(data),
      ]);
    return { base, root, db, session, msg };
  }

  test("resolves a V2 session to the virtual key", async () => {
    const { base, root, db, session } = await fixture();
    session(V2_SID, null);
    db.close();
    expect(await new OpencodeTranscriptSource(root).resolve({ kind: "id", value: V2_SID })).toBe(
      `${join(root, "opencode.db")}#${V2_SID}`,
    );
    await rm(base, { recursive: true, force: true });
  });

  test("stat counts session_message rows and takes the newest touch", async () => {
    const { base, root, db, session, msg } = await fixture();
    session(V2_SID, null);
    msg("msg_a", "user", 1, 10, 10, v2UserData("hi", 10));
    msg("msg_b", "assistant", 2, 20, 30, v2AssistantData(20));
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;
    expect(await src.stat(key)).toEqual({ size: 2, mtimeMs: 30 });
    await rm(base, { recursive: true, force: true });
  });

  // The cache-validity contract, V2 half: a streaming session bumps the assistant row's
  // `time_updated` (measured live, +497 ms over five seconds) and must invalidate.
  test("stat moves when a session_message row is added", async () => {
    const { base, root, db, session, msg } = await fixture();
    session(V2_SID, null);
    msg("msg_a", "user", 1, 10, 10, v2UserData("hi", 10));
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;
    const before = (await src.stat(key))!;
    const db2 = new Database(join(root, "opencode.db"));
    db2.run("insert into session_message values (?, ?, ?, ?, ?, ?, ?)", [
      "msg_b",
      V2_SID,
      "assistant",
      2,
      20,
      40,
      JSON.stringify(v2AssistantData(20, [textPart("streaming")])),
    ]);
    db2.close();
    const after = (await src.stat(key))!;
    expect(after.size).toBe(before.size + 1);
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    await rm(base, { recursive: true, force: true });
  });

  test("load composes rows in seq order, with roles from the type column", async () => {
    const { base, root, db, session, msg } = await fixture();
    session(V2_SID, null);
    // Inserted out of order: `seq` is what orders them, not insertion order or the id.
    msg("msg_c", "compaction", 3, 50, 50, v2CompactionData(50));
    msg("msg_a", "user", 1, 10, 10, v2UserData("fix the types", 10));
    msg("msg_b", "assistant", 2, 20, 30, v2AssistantData(20, [reasoningPart("The user wants…"), textPart("done")]));
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;
    const { text, complete, size, mtimeMs } = await src.load(key);
    expect(complete).toBe(true);
    expect(size).toBe(3);
    expect(mtimeMs).toBe(50);
    const entries = parseOpencodeTranscript(text);
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["msg_a", "user"],
      ["msg_b", "assistant"],
      ["msg_c", "summary"],
    ]);
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "fix the types" }]);
    expect(entries[1]!.parts).toEqual([
      { kind: "thinking", text: "The user wants…" },
      { kind: "text", text: "done" },
    ]);
    expect(entries[2]!.parts).toEqual([{ kind: "text", text: "## Objective\nShip the fix." }]);
    await rm(base, { recursive: true, force: true });
  });

  test("seq orders the turns even when time_created disagrees", async () => {
    const { base, root, db, session, msg } = await fixture();
    session(V2_SID, null);
    // seq 1 is NEWER by the clock than seq 2: the order the agent emitted them is `seq`, not time.
    msg("msg_first", "user", 1, 500, 500, v2UserData("first by seq", 500));
    msg("msg_second", "assistant", 2, 100, 100, v2AssistantData(100, [textPart("second by seq")]));
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;
    const { text } = await src.load(key);
    expect(parseOpencodeTranscript(text).map((e) => e.uuid)).toEqual(["msg_first", "msg_second"]);
    await rm(base, { recursive: true, force: true });
  });

  // A failed V2 turn has no content and keeps its reason in `error.message` (22 such rows live on
  // 2026-09-23). Dropping the row would skip over the failure in silence, so the reason renders.
  test("a failed turn renders its error message instead of vanishing", async () => {
    const { base, root, db, session, msg } = await fixture();
    session(V2_SID, null);
    msg("msg_a", "assistant", 1, 10, 10, {
      time: { created: 10, completed: 12 },
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      content: [],
      finish: "error",
      error: { type: "aborted", message: "Too many images in request: 32 > 30" },
    });
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;
    const entries = parseOpencodeTranscript((await src.load(key)).text);
    expect(entries.map((e) => [e.role, e.parts])).toEqual([
      ["assistant", [{ kind: "text", text: "Too many images in request: 32 > 30" }]],
    ]);
    await rm(base, { recursive: true, force: true });
  });

  // A key whose session row is gone (a stale store entry) reads as empty rather than throwing. The
  // V2-only fixture also proves no V1 table is touched on the way.
  test("a vanished session reads as empty, not a throw", async () => {
    const { base, root, db } = await fixture();
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = opencodeKey(join(root, "opencode.db"), V2_SID);
    expect(await src.stat(key)).toEqual({ size: 0, mtimeMs: 0 });
    expect(await src.load(key)).toEqual({ text: "", complete: true, size: 0, mtimeMs: 0 });
    await rm(base, { recursive: true, force: true });
  });

  test("unmodelled row types render nothing", async () => {
    const { base, root, db, session, msg } = await fixture();
    session(V2_SID, null);
    msg("msg_a", "system", 1, 10, 10, { time: { created: 10 }, text: "plumbing" });
    msg("msg_b", "synthetic", 2, 20, 20, { time: { created: 20 }, text: "plumbing" });
    msg("msg_c", "model-switched", 3, 30, 30, { time: { created: 30 }, model: { providerID: "p", id: "m" } });
    msg("msg_d", "user", 4, 40, 40, v2UserData("real", 40));
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;
    const { text } = await src.load(key);
    expect(parseOpencodeTranscript(text).map((e) => e.uuid)).toEqual(["msg_d"]);
    await rm(base, { recursive: true, force: true });
  });

  test("a subagent session still resolves — the plugin never reports one, but nothing here lies", async () => {
    const { base, root, db, session } = await fixture();
    const sub = "ses_0531ed10affel9vU6GggxXLdd5";
    session(V2_SID, null);
    session(sub, V2_SID);
    db.close();
    expect(await new OpencodeTranscriptSource(root).resolve({ kind: "id", value: sub })).toBe(
      `${join(root, "opencode.db")}#${sub}`,
    );
    await rm(base, { recursive: true, force: true });
  });
});

// A machine that upgraded keeps both generations in the same opencode.db — V1 sessions in `session`
// and everything new in `session_v2`. Both must resolve, and each must be served by its own tables.
describe("OpencodeTranscriptSource — both generations side by side", () => {
  const V1_SID = "ses_03969c19cffeJrZCPOT6zG8Bm7";
  const V2_SID = "ses_f34fa06cfffepZ7TTIJqHH4SiU";

  async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-both-")));
    const root = join(base, "data");
    await mkdir(root, { recursive: true });
    const db = openDb(join(root, "opencode.db"), [...V1_SCHEMA, ...V2_SCHEMA]);
    db.run("insert into session values (?, null, 'session', 1, 100)", [V1_SID]);
    db.run("insert into message values ('msg_v1', ?, 10, 10, ?)", [V1_SID, JSON.stringify(userData(10))]);
    db.run("insert into part values ('prt_v1', 'msg_v1', ?, 10, 10, ?)", [V1_SID, JSON.stringify(textPart("v1 turn"))]);
    db.run("insert into session_v2 values (?, null, 'session', 1, 100)", [V2_SID]);
    db.run("insert into session_message values ('msg_v2', ?, 'user', 1, 10, 10, ?)", [
      V2_SID,
      JSON.stringify(v2UserData("v2 turn", 10)),
    ]);
    db.close();
    return { base, root };
  }

  test("each session resolves and reads through its own store", async () => {
    const { base, root } = await fixture();
    const src = new OpencodeTranscriptSource(root);
    const v1Key = (await src.resolve({ kind: "id", value: V1_SID }))!;
    const v2Key = (await src.resolve({ kind: "id", value: V2_SID }))!;
    expect(v1Key).toBe(`${join(root, "opencode.db")}#${V1_SID}`);
    expect(v2Key).toBe(`${join(root, "opencode.db")}#${V2_SID}`);

    // V1 counts message + part (2 rows); V2 counts session_message (1 row).
    expect(await src.stat(v1Key)).toEqual({ size: 2, mtimeMs: 10 });
    expect(await src.stat(v2Key)).toEqual({ size: 1, mtimeMs: 10 });

    const v1 = parseOpencodeTranscript((await src.load(v1Key)).text);
    const v2 = parseOpencodeTranscript((await src.load(v2Key)).text);
    expect(v1.map((e) => [e.uuid, e.role])).toEqual([["msg_v1", "user"]]);
    expect(v2.map((e) => [e.uuid, e.role])).toEqual([["msg_v2", "user"]]);
    expect(v1[0]!.parts).toEqual([{ kind: "text", text: "v1 turn" }]);
    expect(v2[0]!.parts).toEqual([{ kind: "text", text: "v2 turn" }]);
    await rm(base, { recursive: true, force: true });
  });
});

// OpenCode 1.18.x already ships an EMPTY `session_message` table (its foreign key points at
// `session`) but no `session_v2` (schema read from a live 1.18.32 install, 2026-09-24). The V1 path
// must still serve that database; the V2 table's presence alone must not flip the store.
describe("OpencodeTranscriptSource — an OpenCode 1.18 database", () => {
  const V1_18_SCHEMA = [
    ...V1_SCHEMA,
    "create table session_message (id text primary key, session_id text not null references session(id), type text not null, seq integer not null, time_created integer not null, time_updated integer not null, data text not null)",
  ] as const;

  test("reads the V1 tables, stat, load and probe alike", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-118-")));
    const db = openDb(join(base, "opencode.db"), V1_18_SCHEMA);
    db.run("insert into session values (?, null, 'session', 1, 100)", [SID]);
    db.run("insert into message values ('msg_a', ?, 10, 10, ?)", [SID, JSON.stringify(userData(10))]);
    db.run("insert into message values ('msg_b', ?, 20, 30, ?)", [
      SID,
      JSON.stringify({
        ...assistantData(20),
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
        tokens: { input: 5, cache: { read: 400, write: 0 } },
      }),
    ]);
    db.run("insert into part values ('prt_a1', 'msg_a', ?, 10, 10, ?)", [SID, JSON.stringify(textPart("hi"))]);
    db.run("insert into part values ('prt_b1', 'msg_b', ?, 20, 25, ?)", [SID, JSON.stringify(textPart("hello"))]);
    db.close();

    const journal = opencodeJournal(base);
    const key = (await journal.source.resolve({ kind: "id", value: SID }))!;
    expect(key).toBe(`${join(base, "opencode.db")}#${SID}`);
    expect(await journal.source.stat(key)).toEqual({ size: 4, mtimeMs: 30 });
    const entries = parseOpencodeTranscript((await journal.source.load(key)).text);
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["msg_a", "user"],
      ["msg_b", "assistant"],
    ]);
    const probe = await journal.cacheProbe?.({ kind: "id", value: SID });
    expect(probe?.cacheReadTokens).toBe(400);
    expect(probe?.model).toBe("anthropic:claude-sonnet-5");
    await rm(base, { recursive: true, force: true });
  });
});

// A session can exist in BOTH stores: the migration copied it into `session_v2`, and it may have kept
// running in V1 afterwards (measured live 2026-09-23: 30 ids in both, one with newer V1 rows). The
// newer store wins; a tie reads as V2.
describe("OpencodeTranscriptSource — a session in both stores", () => {
  const BOTH_SID = "ses_fd77b4bfeffetogMhV679jmzxa";

  async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-overlap-")));
    const root = join(base, "data");
    await mkdir(root, { recursive: true });
    const db = openDb(join(root, "opencode.db"), [...V1_SCHEMA, ...V2_SCHEMA]);
    db.run("insert into session values (?, null, 'session', 1, 100)", [BOTH_SID]);
    db.run("insert into session_v2 values (?, null, 'session', 1, 100)", [BOTH_SID]);
    return { base, root, db };
  }

  test("the newer V2 rows win", async () => {
    const { base, root, db } = await fixture();
    db.run("insert into message values ('msg_v1', ?, 10, 10, ?)", [BOTH_SID, JSON.stringify(userData(10))]);
    db.run("insert into part values ('prt_v1', 'msg_v1', ?, 10, 10, ?)", [
      BOTH_SID,
      JSON.stringify(textPart("v1 turn")),
    ]);
    db.run("insert into session_message values ('msg_v2', ?, 'user', 1, 50, 50, ?)", [
      BOTH_SID,
      JSON.stringify(v2UserData("v2 turn", 50)),
    ]);
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: BOTH_SID }))!;
    expect(await src.stat(key)).toEqual({ size: 1, mtimeMs: 50 });
    expect(parseOpencodeTranscript((await src.load(key)).text).map((e) => e.uuid)).toEqual(["msg_v2"]);
    await rm(base, { recursive: true, force: true });
  });

  test("a newer V1 tail wins — the migration's snapshot must not hide it", async () => {
    const { base, root, db } = await fixture();
    db.run("insert into message values ('msg_v1', ?, 100, 100, ?)", [BOTH_SID, JSON.stringify(userData(100))]);
    db.run("insert into part values ('prt_v1', 'msg_v1', ?, 100, 100, ?)", [
      BOTH_SID,
      JSON.stringify(textPart("v1 turn")),
    ]);
    db.run("insert into session_message values ('msg_v2', ?, 'user', 1, 50, 50, ?)", [
      BOTH_SID,
      JSON.stringify(v2UserData("v2 turn", 50)),
    ]);
    db.close();
    const src = new OpencodeTranscriptSource(root);
    const key = (await src.resolve({ kind: "id", value: BOTH_SID }))!;
    expect(await src.stat(key)).toEqual({ size: 2, mtimeMs: 100 });
    expect(parseOpencodeTranscript((await src.load(key)).text).map((e) => e.uuid)).toEqual(["msg_v1"]);
    await rm(base, { recursive: true, force: true });
  });
});

// Actions that drop the cache between turns (issue #236), from STRUCTURED fields only: a user
// message's `model`, and an assistant message's `mode: "compaction"` / `summary: true`. The shapes are
// the ones a live `opencode.db` carries; the values are made up.
describe("opencodeResets", () => {
  type Message = { [key: string]: JsonValue | undefined };
  const assistant = (at: number, providerID: string, modelID: string, over: Message = {}): Message => ({
    role: "assistant",
    providerID,
    modelID,
    time: { created: at - 10, completed: at },
    tokens: { input: 10, cache: { read: 900, write: 0 } },
    ...over,
  });
  const user = (at: number, providerID: string, modelID: string): Message => ({
    role: "user",
    time: { created: at },
    model: { providerID, modelID },
    // A USER message's `summary` is an object, so it must never read as a compaction.
    summary: { diffs: [] },
  });
  const ids = (events: readonly { ruleId: string }[]) => events.map((e) => e.ruleId);

  test("a user message on another model is a pending reset, newer than the turn", () => {
    const events = opencodeResets([user(3000, "x-ai", "grok-4.5"), assistant(2000, "google", "gemini-3.5-flash-lite")], 1);
    expect(ids(events)).toEqual(["opencode.reset.model"]);
    expect((events[0]?.at ?? 0) > 2000).toBe(true);
  });

  test("a user message on the SAME model is nothing", () => {
    expect(opencodeResets([user(3000, "google", "gemini-3.5-flash-lite"), assistant(2000, "google", "gemini-3.5-flash-lite")], 1)).toEqual([]);
  });

  test("a model change between two turns is the cause, not a warning", () => {
    const events = opencodeResets(
      [assistant(3000, "x-ai", "grok-4.5"), user(2500, "x-ai", "grok-4.5"), assistant(2000, "google", "gemini-3.5-flash-lite")],
      0,
    );
    expect(ids(events)).toEqual(["opencode.reset.model"]);
    expect((events[0]?.at ?? Infinity) <= 3000).toBe(true);
  });

  test("a compaction summary warns about the turn after it", () => {
    const events = opencodeResets([assistant(2000, "google", "gemini-3.5-flash-lite", { mode: "compaction", summary: true })], 0);
    expect(ids(events)).toEqual(["opencode.reset.compaction"]);
    expect((events[0]?.at ?? 0) > 2000).toBe(true);
  });

  test("a compaction before this turn explains it", () => {
    const events = opencodeResets(
      [assistant(3000, "google", "gemini-3.5-flash-lite"), assistant(2000, "google", "gemini-3.5-flash-lite", { mode: "compaction", summary: true })],
      0,
    );
    expect(ids(events)).toEqual(["opencode.reset.compaction"]);
    expect(events[0]?.at).toBe(2000);
  });

  test("a half-known model claims nothing", () => {
    expect(opencodeResets([user(3000, "x-ai", "grok-4.5"), assistant(2000, "google", "")], 1)).toEqual([]);
  });

  test("the probe carries them, off the one query it already runs", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-resets-")));
    const db = openDb(join(base, "opencode.db"), V1_SCHEMA);
    db.run("insert into session values (?, null, 'session', 1, 100)", [SID]);
    const msg = (id: string, created: number, data: Message) =>
      db.run("insert into message values (?, ?, ?, ?, ?)", [id, SID, created, created, JSON.stringify(data)]);
    msg("msg_a", 1990, assistant(2000, "google", "gemini-3.5-flash-lite"));
    msg("msg_b", 3000, user(3000, "x-ai", "grok-4.5"));
    db.close();
    const probe = await opencodeJournal(base).cacheProbe?.({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
    expect(probe?.lastRequestAt).toBe(2000);
    expect(ids(probe?.resets ?? [])).toEqual(["opencode.reset.model"]);
  });
});

// V2 records the two cache-dropping actions as their own rows instead of V1's inference: a
// `model-switched` row carries `previous` and the new `model`, and a `compaction` row's `summary`
// replaces the history. Shapes from a live opencode.db (2.0.12, 2026-09-22); values are made up.
describe("opencodeResetsV2", () => {
  type Message = { [key: string]: JsonValue | undefined };
  const assistant = (at: number, providerID: string, id: string): Message => ({
    type: "assistant",
    model: { providerID, id },
    time: { created: at - 10, completed: at },
    tokens: { input: 10, cache: { read: 900, write: 0 } },
  });
  const switched = (at: number, from: string, to: string): Message => ({
    type: "model-switched",
    time: { created: at },
    previous: { providerID: "p", id: from },
    model: { providerID: "p", id: to },
  });
  const compaction = (at: number): Message => ({ type: "compaction", time: { created: at }, summary: "…" });
  const ids = (events: readonly { ruleId: string }[]) => events.map((e) => e.ruleId);

  test("a model switch newer than the turn is pending, just after it", () => {
    const events = opencodeResetsV2([switched(3000, "a", "b"), assistant(2000, "p", "b")], 1);
    expect(ids(events)).toEqual(["opencode.reset.model"]);
    expect((events[0]?.at ?? 0) > 2000).toBe(true);
    expect(events[0]?.evidence).toBe("model p/a → p/b");
  });

  test("a compaction newer than the turn is pending", () => {
    const events = opencodeResetsV2([compaction(3000), assistant(2000, "p", "b")], 1);
    expect(ids(events)).toEqual(["opencode.reset.compaction"]);
    expect((events[0]?.at ?? 0) > 2000).toBe(true);
  });

  test("a compaction before the turn explains it, at its own time", () => {
    const events = opencodeResetsV2([assistant(3000, "p", "b"), compaction(2000)], 0);
    expect(ids(events)).toEqual(["opencode.reset.compaction"]);
    expect(events[0]?.at).toBe(2000);
  });

  test("a model switch before the turn explains it", () => {
    const events = opencodeResetsV2([assistant(3000, "p", "b"), switched(2000, "a", "b")], 0);
    expect(ids(events)).toEqual(["opencode.reset.model"]);
    expect(events[0]?.evidence).toBe("model p/a → p/b");
  });

  test("the newest of each kind wins among the pending rows", () => {
    const events = opencodeResetsV2(
      [switched(3000, "b", "c"), compaction(2500), assistant(2000, "p", "b")],
      2,
    );
    expect(ids(events)).toEqual(["opencode.reset.compaction", "opencode.reset.model"]);
    expect(events[1]?.evidence).toBe("model p/b → p/c");
  });

  test("a failed compaction claims nothing, before or after the turn", () => {
    const failed = (at: number): Message => ({ ...compaction(at), status: "failed" });
    expect(opencodeResetsV2([failed(3000), assistant(2000, "p", "b")], 1)).toEqual([]);
    expect(opencodeResetsV2([assistant(3000, "p", "b"), failed(2000)], 0)).toEqual([]);
  });

  test("no event rows around the turn is nothing", () => {
    expect(opencodeResetsV2([assistant(2000, "p", "b")], 0)).toEqual([]);
  });

  test("the V2 probe reads tokens, the nested model, and the explicit resets", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-v2-probe-")));
    const db = openDb(join(base, "opencode.db"), V2_SCHEMA);
    db.run("insert into session_v2 values (?, null, 'session', 1, 100)", [SID]);
    const msg = (id: string, type: string, seq: number, created: number, data: Message) =>
      db.run("insert into session_message values (?, ?, ?, ?, ?, ?, ?)", [
        id,
        SID,
        type,
        seq,
        created,
        created,
        JSON.stringify(data),
      ]);
    msg("msg_a", "assistant", 1, 1995, {
      time: { created: 1990, completed: 2000 },
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      tokens: { input: 10, cache: { read: 850, write: 0 } },
    });
    msg("msg_b", "compaction", 2, 2500, { time: { created: 2500 }, summary: "…" });
    msg("msg_c", "model-switched", 3, 3000, {
      time: { created: 3000 },
      previous: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      model: { providerID: "opencode-go", id: "kimi-k2" },
    });
    db.close();
    const probe = await opencodeJournal(base).cacheProbe?.({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
    expect(probe?.lastRequestAt).toBe(2000);
    expect(probe?.turnId).toBe("1995");
    expect(probe?.cacheReadTokens).toBe(850);
    expect(probe?.model).toBe("opencode-go:deepseek-v4.1-flash");
    expect(ids(probe?.resets ?? [])).toEqual(["opencode.reset.compaction", "opencode.reset.model"]);
  });

  // V2 interleaves `idle`/`synthetic`/`system` rows V1 never had; without the type filter they fill
  // the twelve-row window and the newest token-bearing turn falls out of it (measured live
  // 2026-09-23: one of 132 sessions), leaving the pane with no chip.
  test("the V2 window ignores bookkeeping rows and still finds the turn", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-v2-window-")));
    const db = openDb(join(base, "opencode.db"), V2_SCHEMA);
    db.run("insert into session_v2 values (?, null, 'session', 1, 100)", [SID]);
    const msg = (id: string, type: string, seq: number, created: number, data: Message) =>
      db.run("insert into session_message values (?, ?, ?, ?, ?, ?, ?)", [
        id,
        SID,
        type,
        seq,
        created,
        created,
        JSON.stringify(data),
      ]);
    msg("msg_a", "assistant", 1, 100, {
      time: { created: 90, completed: 100 },
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      tokens: { input: 10, cache: { read: 700, write: 0 } },
    });
    for (let i = 0; i < 15; i++) {
      msg(`evt_${i}`, i % 2 === 0 ? "idle" : "synthetic", 2 + i, 200 + i, {
        time: { created: 200 + i },
        text: "…",
      });
    }
    db.close();
    const probe = await opencodeJournal(base).cacheProbe?.({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
    expect(probe?.lastRequestAt).toBe(100);
    expect(probe?.cacheReadTokens).toBe(700);
  });
});

// OpenCode records what a call actually DID in its `state`, and the two generations disagree about
// where: V1 (1.18.9) keeps one unified-diff string in `state.metadata.diff`, V2 (2.0.12) keeps a
// FileDiff list in `state.metadata.files` with its own counts. Both are on disk today, so both are
// pinned. The V1 shapes below are the ones a real store holds, read read-only on 2026-09-29.
describe("parseOpencodeTranscript: the structured tool call", () => {
  const firstTool = (text: string) => {
    const parts = parseOpencodeTranscript(text).flatMap((e) => e.parts);
    const part = parts.find((p) => p.kind === "tool");
    // SAFETY: `find` on the `kind === "tool"` predicate returns that branch or nothing; the throw
    // rules out nothing, so the narrowing below is what the predicate already proved.
    if (part === undefined || part.kind !== "tool") throw new Error("no tool part in the log");
    return part;
  };

  const one = (part: JsonValue) => line("msg_b", assistantData(), [part]);

  test("a V1 edit takes its diff from metadata.diff, past the Index/--- preamble", () => {
    // The `---`/`+++` marker lines start with `-` and `+` and sit ABOVE the first `@@`, so a parser
    // that read them as diff lines would count two changes that never happened.
    const diff = [
      "Index: /repo/a.css",
      "===================================================================",
      "--- /repo/a.css",
      "+++ /repo/a.css",
      "@@ -1,2 +1,2 @@",
      " .a {",
      "-  gap: 2rem;",
      "+  gap: 3.5rem;",
    ].join("\n");
    expect(
      firstTool(
        one(
          toolPart("edit", {
            status: "completed",
            input: { filePath: "/repo/a.css", oldString: "2rem", newString: "3.5rem" },
            output: "done",
            metadata: { diff },
          }),
        ),
      ).call,
    ).toEqual({
      kind: "edit",
      path: "/repo/a.css",
      added: 1,
      removed: 1,
      diff: [{ header: "@@ -1,2 +1,2 @@", lines: [" .a {", "-  gap: 2rem;", "+  gap: 3.5rem;"] }],
    });
  });

  test("a V1 apply_patch reads its file list, names each file's first hunk and counts the lines", () => {
    // V1's rows carry no `additions`/`deletions`, so the patch itself is the count. `files` outranks
    // the `diff` beside it, which is only the first file's patch.
    expect(
      firstTool(
        one(
          toolPart("apply_patch", {
            status: "completed",
            input: { patch: "…" },
            output: "done",
            metadata: {
              diff: "@@ -1,1 +0,0 @@\n-gone\n",
              files: [
                {
                  filePath: "/repo/a.ts",
                  relativePath: "a.ts",
                  type: "delete",
                  patch: "--- /repo/a.ts\n+++ /repo/a.ts\n@@ -1,1 +0,0 @@\n-gone\n",
                },
                {
                  filePath: "/repo/b.ts",
                  relativePath: "b.ts",
                  type: "add",
                  patch: "@@ -0,0 +1,2 @@\n+new\n+lines\n",
                },
              ],
            },
          }),
        ),
      ).call,
    ).toEqual({
      kind: "edit",
      path: "",
      added: 2,
      removed: 1,
      diff: [
        { header: "a.ts @@ -1,1 +0,0 @@", lines: ["-gone"] },
        { header: "b.ts @@ -0,0 +1,2 @@", lines: ["+new", "+lines"] },
      ],
    });
  });

  test("a V1 write against nothing is marked created, which the input alone cannot say", () => {
    expect(
      firstTool(
        one(
          toolPart("write", {
            status: "completed",
            input: { filePath: "/repo/new.ts", content: "x" },
            output: "done",
            metadata: { exists: false, filepath: "/repo/new.ts" },
          }),
        ),
      ).call,
    ).toEqual({ kind: "edit", path: "/repo/new.ts", added: 0, removed: 0, created: true });
  });

  test("a write over an existing file is not created, and still counts nothing", () => {
    // OpenCode keeps no copy of what was there before a write, so there is no diff to fold and
    // `added`/`removed` stay 0 rather than being invented from the input's `content`.
    expect(
      firstTool(
        one(
          toolPart("write", {
            status: "completed",
            input: { filePath: "/repo/a.ts", content: "x\ny\n" },
            output: "done",
            metadata: { exists: true, filepath: "/repo/a.ts" },
          }),
        ),
      ).call,
    ).toEqual({ kind: "edit", path: "/repo/a.ts", added: 0, removed: 0 });
  });

  test("a command keeps its exit code, on a failure as well as a success", () => {
    expect(
      firstTool(
        one(
          toolPart("bash", {
            status: "error",
            input: { command: "false", description: "check" },
            error: "exit status 1",
            metadata: { exit: 1, output: "", truncated: false },
          }),
        ),
      ).call,
    ).toEqual({ kind: "execute", command: "false", description: "check", exitCode: 1 });
  });

  test("a grep keeps its match count and a glob its path count", () => {
    expect(
      firstTool(
        one(
          toolPart("grep", {
            status: "completed",
            input: { pattern: "TODO", path: "/repo" },
            output: "…",
            metadata: { matches: 7 },
          }),
        ),
      ).call,
    ).toEqual({ kind: "search", query: "TODO", where: "/repo", hits: 7 });

    expect(
      firstTool(
        one(
          toolPart("glob", {
            status: "completed",
            input: { pattern: "**/*.ts" },
            output: "…",
            metadata: { count: 12 },
          }),
        ),
      ).call,
    ).toEqual({ kind: "search", query: "**/*.ts", hits: 12 });
  });

  test("a V1 refusal is `denied`, and a real failure is not", () => {
    // Both wear `status: "error"`, so the status alone would tell the reader their command crashed
    // when in fact they said no to it themselves. These two sentences are from a real store.
    expect(
      firstTool(
        one(
          toolPart("bash", {
            status: "error",
            input: { command: "git push" },
            error: "The user rejected permission to use this specific tool call.",
          }),
        ),
      ).result,
    ).toEqual({
      text: "The user rejected permission to use this specific tool call.",
      isError: true,
      denied: true,
    });

    expect(
      firstTool(
        one(
          toolPart("edit", {
            status: "error",
            input: { filePath: "/repo/a.ts" },
            error: "Could not find oldString in the file. It must match exactly, including whitespace.",
          }),
        ),
      ).result,
    ).toEqual({
      text: "Could not find oldString in the file. It must match exactly, including whitespace.",
      isError: true,
    });
  });

  test("a V1 call interrupted by the operator is `denied` on the metadata flag alone", () => {
    expect(
      firstTool(
        one(
          toolPart("bash", {
            status: "error",
            input: { command: "sleep 500" },
            error: "stopped",
            metadata: { interrupted: true },
          }),
        ),
      ).result,
    ).toEqual({ text: "stopped", isError: true, denied: true });
  });

  test("a V2 edit reads the FileDiff list, taking the counts it is given", () => {
    // V2 states its own `additions`/`deletions`, so they are believed over the parsed lines: the
    // harness counted against the file it wrote.
    expect(
      firstTool(
        one({
          type: "tool",
          id: "call_9",
          name: "edit",
          state: {
            status: "completed",
            input: { path: "/repo/a.ts", oldString: "a", newString: "b" },
            content: [{ type: "text", text: "done" }],
            metadata: {
              files: [
                {
                  file: "/repo/a.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  patch: "@@ -1,1 +1,1 @@\n-const a = 1\n+const b = 1\n",
                },
              ],
            },
          },
        }),
      ).call,
    ).toEqual({
      kind: "edit",
      path: "/repo/a.ts",
      added: 1,
      removed: 1,
      diff: [{ header: "@@ -1,1 +1,1 @@", lines: ["-const a = 1", "+const b = 1"] }],
    });
  });

  test("a V2 FileDiff with status `added` marks the call created", () => {
    expect(
      firstTool(
        one({
          type: "tool",
          id: "call_9",
          name: "write",
          state: {
            status: "completed",
            input: { path: "/repo/new.ts", content: "x" },
            content: [{ type: "text", text: "done" }],
            metadata: {
              files: [{ file: "/repo/new.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+x\n" }],
            },
          },
        }),
      ).call,
    ).toEqual({
      kind: "edit",
      path: "/repo/new.ts",
      added: 1,
      removed: 0,
      diff: [{ header: "@@ -0,0 +1,1 @@", lines: ["+x"] }],
      created: true,
    });
  });

  test("a V2 error record naming a permission is `denied`; one naming the tool is not", () => {
    // V2's `error` is `{type, message}` and the type is an enum, so it is matched rather than the
    // prose. `tool.execution` is an ordinary failure and must stay one.
    const v2Error = (error: JsonValue) =>
      one({
        type: "tool",
        id: "call_9",
        name: "shell",
        state: { status: "error", input: { command: "git push" }, error },
      });

    expect(firstTool(v2Error({ type: "permission.rejected", message: "no" })).result).toEqual({
      text: "no",
      isError: true,
      denied: true,
    });
    expect(firstTool(v2Error({ type: "tool.execution", message: "command exited 1" })).result).toEqual({
      text: "command exited 1",
      isError: true,
    });
  });

  test("a running call already carries its structured form and its call id", () => {
    // The tail window opens mid-turn all the time. A call whose result has not arrived is not a call
    // the page can refuse to draw.
    const part = firstTool(one(toolPart("read", { status: "running", input: { filePath: "/repo/a.ts" } })));
    expect(part.call).toEqual({ kind: "read", path: "/repo/a.ts" });
    expect(part.id).toBe("call_1");
    expect(part.result).toBeUndefined();
  });

  // Input and metadata shapes verified on a real 1.18.x / 2.x store: `{questions:[{question, header,
  // options:[{label, description}], multiple?}]}` in, `metadata.answers: string[][]` out, and a
  // dismissal is `status: "error"` with the text "The user dismissed this question" and no metadata.
  describe("a question call", () => {
    const input = {
      questions: [
        {
          question: "Which color?",
          header: "Color choice",
          options: [
            { label: "Red", description: "The color red" },
            { label: "Blue", description: "The color blue" },
          ],
          multiple: false,
        },
      ],
    };
    const asked = [
      {
        header: "Color choice",
        question: "Which color?",
        multiple: false,
        options: [
          { label: "Red", description: "The color red" },
          { label: "Blue", description: "The color blue" },
        ],
      },
    ];

    test("a running one carries what was asked and no answers", () => {
      const part = firstTool(one(toolPart("question", { status: "running", input })));
      expect(part.call).toEqual({ kind: "question", name: "question", summary: "Which color?", questions: asked });
      expect(part.summary).toBe("Which color?");
      expect(part.result).toBeUndefined();
    });

    test("a completed one carries the chosen labels, one list per question", () => {
      const part = firstTool(
        one(
          toolPart("question", {
            status: "completed",
            input,
            output: 'User has answered your questions: "Which color?"="Blue".',
            metadata: { answers: [["Blue"]], truncated: false },
          }),
        ),
      );
      expect(part.call).toEqual({
        kind: "question",
        name: "question",
        summary: "Which color?",
        questions: asked,
        answers: [["Blue"]],
      });
    });

    test("a dismissed one is denied and has no answers", () => {
      const part = firstTool(
        one(toolPart("question", { status: "error", input, error: "The user dismissed this question" })),
      );
      expect(part.result).toEqual({ text: "The user dismissed this question", isError: true, denied: true });
      expect(part.call).toEqual({ kind: "question", name: "question", summary: "Which color?", questions: asked });
    });

    test("an answers field of the wrong shape is ignored", () => {
      const part = firstTool(
        one(toolPart("question", { status: "completed", input, output: "ok", metadata: { answers: ["Blue", 3] } })),
      );
      expect(part.call).not.toHaveProperty("answers");
    });
  });

  test("a tool outside the nine kinds is `other` and reads exactly as its row did", () => {
    const part = firstTool(one(toolPart("todowrite", { status: "completed", input: { todos: [] }, output: "ok" })));
    expect(part.call).toEqual({ kind: "other", name: "todowrite", summary: part.summary });
  });
});

// A patch tool names no file in its input, so the classified path arrives empty and the result is
// the only place a path exists. Verified against a real 1.18.9 store: every `apply_patch` call there
// classifies to an empty path.
describe("parseOpencodeTranscript: a single-file patch takes its path from the result", () => {
  const firstCall = (text: string) => {
    const part = parseOpencodeTranscript(text).flatMap((e) => e.parts).find((p) => p.kind === "tool");
    // SAFETY: `find` on the `kind === "tool"` predicate returns that branch or nothing; the throw
    // rules out nothing, so the narrowing below is what the predicate already proved.
    if (part === undefined || part.kind !== "tool") throw new Error("no tool part in the log");
    return part.call;
  };

  test("one file in the list names the call", () => {
    expect(
      firstCall(
        line("msg_b", assistantData(), [
          toolPart("apply_patch", {
            status: "completed",
            input: { patch: "…" },
            output: "done",
            metadata: {
              files: [{ filePath: "/repo/a.ts", relativePath: "a.ts", type: "update", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" }],
            },
          }),
        ]),
      ),
    ).toEqual({
      kind: "edit",
      path: "/repo/a.ts",
      added: 1,
      removed: 1,
      diff: [{ header: "@@ -1,1 +1,1 @@", lines: ["-a", "+b"] }],
    });
  });

  test("several files keep the empty path, and their names ride on the hunk headers", () => {
    expect(
      firstCall(
        line("msg_b", assistantData(), [
          toolPart("apply_patch", {
            status: "completed",
            input: { patch: "…" },
            output: "done",
            metadata: {
              files: [
                { filePath: "/repo/a.ts", relativePath: "a.ts", type: "update", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" },
                { filePath: "/repo/b.ts", relativePath: "b.ts", type: "update", patch: "@@ -2,1 +2,1 @@\n-c\n+d\n" },
              ],
            },
          }),
        ]),
      ),
    ).toEqual({
      kind: "edit",
      path: "",
      added: 2,
      removed: 2,
      diff: [
        { header: "a.ts @@ -1,1 +1,1 @@", lines: ["-a", "+b"] },
        { header: "b.ts @@ -2,1 +2,1 @@", lines: ["-c", "+d"] },
      ],
    });
  });

  test("a path the input DID name is never overwritten by the result", () => {
    expect(
      firstCall(
        line("msg_b", assistantData(), [
          toolPart("edit", {
            status: "completed",
            input: { filePath: "/repo/asked.ts" },
            output: "done",
            metadata: { files: [{ file: "/repo/other.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+x\n" }] },
          }),
        ]),
      ),
    ).toEqual({
      kind: "edit",
      path: "/repo/asked.ts",
      added: 1,
      removed: 0,
      diff: [{ header: "@@ -0,0 +1,1 @@", lines: ["+x"] }],
    });
  });
});


// The live read. OpenCode is the harness whose rows MOVE, so this is where the two facts that follow
// from it are pinned: the cursor counts `time_updated` rather than a row id, and a read therefore
// re-emits the turn it is standing on rather than dropping a row that shares a millisecond with it.
describe("OpencodeTranscriptSource — readSince, V1", () => {
  async function lab() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-since-")));
    const root = join(base, "data");
    await mkdir(root, { recursive: true });
    const db = openDb(join(root, "opencode.db"), V1_SCHEMA);
    db.run("insert into session values (?, null, 'root session', 1, 100)", [SID]);
    return {
      base,
      root,
      db,
      /** One message row and the one text part that makes it render. */
      turn: (id: string, created: number, updated: number, text: string) => {
        db.run("insert into message values (?, ?, ?, ?, ?)", [id, SID, created, updated, JSON.stringify(userData(created))]);
        db.run("insert into part values (?, ?, ?, ?, ?, ?)", [
          `prt_${id}`,
          id,
          SID,
          created,
          updated,
          JSON.stringify(textPart(text)),
        ]);
      },
      clean: async () => {
        db.close();
        await rm(base, { recursive: true, force: true });
      },
    };
  }

  const ids = (lines: readonly string[]) => lines.flatMap((row) => parseOpencodeTranscript(row).map((e) => e.uuid));

  async function opened(root: string) {
    const src = new OpencodeTranscriptSource(root);
    const key = await src.resolve({ kind: "id", value: SID });
    expect(key).not.toBeNull();
    return { src, key: key! };
  }

  test("a first read takes the turns and says the answer replaces nothing", async () => {
    const f = await lab();
    f.turn("msg_a", 10, 10, "hello");
    f.turn("msg_b", 20, 30, "and again");
    const { src, key } = await opened(f.root);

    const first = await src.readSince(key, NO_CURSOR);
    expect(ids(first.lines)).toEqual(["msg_a", "msg_b"]);
    expect(first.reset).toBe(true);

    await f.clean();
  });

  // `msg_a` comes back with it, and that is the `>=` comparison being honest rather than a bug: the
  // cursor stands ON the newest row it saw, because a row sharing that millisecond would otherwise be
  // lost for good. One row of overlap per read, and the caller replaces by uuid.
  test("a resume carries the turn that arrived since, and the one it was standing on", async () => {
    const f = await lab();
    f.turn("msg_a", 10, 10, "hello");
    const { src, key } = await opened(f.root);
    const first = await src.readSince(key, NO_CURSOR);

    f.turn("msg_b", 20, 30, "and again");
    const next = await src.readSince(key, first.cursor);
    expect(ids(next.lines)).toEqual(["msg_a", "msg_b"]);
    expect(next.reset).toBe(false);

    await f.clean();
  });

  // Not a defect, and the reason `stat` stays the pre-check: two rows can share a millisecond, so the
  // comparison has to be `>=`, and `>=` stands still on the row it last saw. The caller replaces that
  // turn by uuid, which it must do anyway for a reply that is still streaming.
  test("a read with nothing new re-emits the newest turn and nothing older", async () => {
    const f = await lab();
    f.turn("msg_a", 10, 10, "hello");
    f.turn("msg_b", 20, 30, "and again");
    const { src, key } = await opened(f.root);
    const first = await src.readSince(key, NO_CURSOR);

    const again = await src.readSince(key, first.cursor);
    expect(ids(again.lines)).toEqual(["msg_b"]);
    expect(again.reset).toBe(false);

    await f.clean();
  });

  // The clock that moves while a reply streams is the PART's, and the message row above it may not
  // move at all. A cursor that watched only the message row would freeze a streaming turn.
  test("a part touched while streaming brings its whole message back", async () => {
    const f = await lab();
    f.turn("msg_a", 10, 10, "hello");
    f.turn("msg_b", 20, 30, "and again");
    const { src, key } = await opened(f.root);
    const first = await src.readSince(key, NO_CURSOR);

    f.db.run("update part set time_updated = 50 where id = 'prt_msg_a'");
    const next = await src.readSince(key, first.cursor);
    expect(ids(next.lines)).toEqual(["msg_a", "msg_b"]);

    await f.clean();
  });

  test("a first read is bounded by rows, so a long session is not composed to be thrown away", async () => {
    // One transaction: a commit per row is one disk sync per row, which is seconds on Windows
    // (NTFS flushes are slow) and a load flake on a busy Linux runner. The rows are the same.
    const f = await lab();
    f.db.transaction(() => {
      for (let n = 1; n <= FIRST_TAIL_ROWS + 5; n++) f.turn(`msg_${String(n).padStart(4, "0")}`, n, n, `turn ${n}`);
    })();
    const { src, key } = await opened(f.root);

    const first = await src.readSince(key, NO_CURSOR);
    expect(first.lines).toHaveLength(FIRST_TAIL_ROWS);
    expect(ids(first.lines).at(0)).toBe("msg_0006");
    expect(ids(first.lines).at(-1)).toBe(`msg_${String(FIRST_TAIL_ROWS + 5).padStart(4, "0")}`);

    await f.clean();
  });

  // `fromStart` needs BOTH bounds to have stood down: the row limit did not bite, and the byte clip
  // dropped nothing. The live window turns it into "load older" (journal/live.ts § hasOlder), so a
  // wrong reading either offers turns that do not exist or hides turns that do. Counted over ROWS
  // READ and not lines composed, which is what a bookkeeping row the reader drops would break.
  test("a short session's first read claims the start; a long one's does not", async () => {
    const short = await lab();
    short.turn("msg_0001", 1, 1, "only turn");
    const one = await opened(short.root);
    const shortRead = await one.src.readSince(one.key, NO_CURSOR);
    expect(shortRead.reset).toBe(true);
    expect(shortRead.fromStart).toBe(true);
    // A resume never claims the start, whatever it carries — and this source always re-emits the row
    // it stands on, so the answer is non-empty and the reading still has to be false.
    const next = await one.src.readSince(one.key, shortRead.cursor);
    expect(next.lines.length).toBeGreaterThan(0);
    expect(next.fromStart).toBe(false);
    await short.clean();

    // One transaction: a commit per row is one disk sync per row, which is seconds on Windows
    // (NTFS flushes are slow) and a load flake on a busy Linux runner. The rows are the same.
    const long = await lab();
    long.db.transaction(() => {
      for (let n = 1; n <= FIRST_TAIL_ROWS + 5; n++) long.turn(`msg_${String(n).padStart(4, "0")}`, n, n, `turn ${n}`);
    })();
    const two = await opened(long.root);
    const longRead = await two.src.readSince(two.key, NO_CURSOR);
    expect(longRead.reset).toBe(true);
    expect(longRead.fromStart).toBe(false);
    await long.clean();
  });

  test("a key it cannot split reports nothing new", async () => {
    expect(await new OpencodeTranscriptSource("/nope").readSince("/not-a-key", NO_CURSOR)).toEqual({
      lines: [],
      cursor: NO_CURSOR,
      reset: false,
      fromStart: false,
    });
  });
});

describe("OpencodeTranscriptSource — readSince, V2", () => {
  const V2_SID = "ses_f34fa06cfffepZ7TTIJqHH4SiU";

  async function lab() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-opencode-since-v2-")));
    const root = join(base, "data");
    await mkdir(root, { recursive: true });
    const db = openDb(join(root, "opencode.db"), V2_SCHEMA);
    db.run("insert into session_v2 values (?, null, 'session', 1, 100)", [V2_SID]);
    return {
      base,
      root,
      db,
      row: (id: string, type: string, seq: number, updated: number, data: JsonValue) =>
        db.run("insert into session_message values (?, ?, ?, ?, ?, ?, ?)", [
          id,
          V2_SID,
          type,
          seq,
          seq,
          updated,
          JSON.stringify(data),
        ]),
      clean: async () => {
        db.close();
        await rm(base, { recursive: true, force: true });
      },
    };
  }

  const ids = (lines: readonly string[]) => lines.flatMap((row) => parseOpencodeTranscript(row).map((e) => e.uuid));

  test("a first read takes the turns, and a resume carries the new one", async () => {
    const f = await lab();
    f.row("msg_a", "user", 1, 10, v2UserData("hi", 10));
    const src = new OpencodeTranscriptSource(f.root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;

    const first = await src.readSince(key, NO_CURSOR);
    expect(ids(first.lines)).toEqual(["msg_a"]);
    expect(first.reset).toBe(true);

    f.row("msg_b", "assistant", 2, 40, v2AssistantData(20));
    // With the row the cursor stands on, exactly as in V1.
    expect(ids((await src.readSince(key, first.cursor)).lines)).toEqual(["msg_a", "msg_b"]);

    await f.clean();
  });

  // A `system` row is read and deliberately not shown. Its clock still has to count, or every later
  // read fetches it again — and drags the composed rows around it along too.
  test("a row that shows nothing still moves the cursor past itself", async () => {
    const f = await lab();
    f.row("msg_a", "user", 1, 10, v2UserData("hi", 10));
    f.row("msg_sys", "system", 2, 40, v2UserData("plumbing", 20));
    const src = new OpencodeTranscriptSource(f.root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;

    const first = await src.readSince(key, NO_CURSOR);
    expect(ids(first.lines)).toEqual(["msg_a"]);

    // Nothing was written in between, so the only row at or past the cursor is the invisible one.
    expect((await src.readSince(key, first.cursor)).lines).toEqual([]);

    await f.clean();
  });

  test("a first read is bounded by rows in this store too", async () => {
    // One transaction: a commit per row is one disk sync per row, which is seconds on Windows
    // (NTFS flushes are slow) and a load flake on a busy Linux runner. The rows are the same.
    const f = await lab();
    f.db.transaction(() => {
      for (let n = 1; n <= FIRST_TAIL_ROWS + 5; n++) {
        f.row(`msg_${String(n).padStart(4, "0")}`, "user", n, n, v2UserData(`turn ${n}`, n));
      }
    })();
    const src = new OpencodeTranscriptSource(f.root);
    const key = (await src.resolve({ kind: "id", value: V2_SID }))!;

    const first = await src.readSince(key, NO_CURSOR);
    expect(first.lines).toHaveLength(FIRST_TAIL_ROWS);
    expect(ids(first.lines).at(0)).toBe("msg_0006");

    await f.clean();
  });
});

// ── patch, file and the V1 compaction role (spec M41/12) ────────────────────
//
// Shapes measured 2026-10-01 against the local store, READ-ONLY: 34 `patch` parts of
// `{ hash, files }`, 5 `file` parts of `{ mime, filename, url, source }` with a `data:` url, and one
// `compaction` part that is a marker with no prose at all. Rows are built here; no store is a fixture.
const patchPart = (files: string[]) => ({ type: "patch", hash: "29d778d84269551f32b6739a38f8124f", files });
const filePart = (mime: string, url: string) => ({ type: "file", mime, filename: "shot.png", url, source: undefined });

describe("parseOpencodeTranscript — patch and file parts", () => {
  test("a patch reads as one edit naming every file it touched", () => {
    const entries = parseOpencodeTranscript(
      line("msg_a", assistantData(), [patchPart(["/repo/.tracker/00-INDEX.md", "/repo/src/a.ts"])]),
    );
    expect(entries).toHaveLength(1);
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("not a tool part");
    expect(part.name).toBe("patch");
    // The basenames, because a phone column cannot hold two absolute paths.
    expect(part.summary).toBe("00-INDEX.md, a.ts");
    // No hunks in the row, so no counts are invented.
    expect(part.call).toEqual({ kind: "edit", path: "/repo/.tracker/00-INDEX.md", added: 0, removed: 0 });
  });

  test("a patch with no files renders nothing", () => {
    const entries = parseOpencodeTranscript(line("msg_a", assistantData(), [patchPart([])]));
    expect(entries).toHaveLength(0);
  });

  test("an attached image becomes an image part", () => {
    const entries = parseOpencodeTranscript(
      line("msg_a", userData(), [filePart("image/png", "data:image/png;base64,AAAA")]),
    );
    expect(entries[0]!.parts).toEqual([
      { kind: "image", url: "data:image/png;base64,AAAA", mimeType: "image/png" },
    ]);
  });

  test("an http url on the agent's word never becomes a fetch the phone makes", () => {
    const entries = parseOpencodeTranscript(
      line("msg_a", userData(), [filePart("image/png", "http://evil.example/x.png"), textPart("look")]),
    );
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "look" }]);
  });

  test("a non-image attachment contributes no part", () => {
    const entries = parseOpencodeTranscript(
      line("msg_a", userData(), [filePart("application/pdf", "data:application/pdf;base64,AAAA"), textPart("read it")]),
    );
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "read it" }]);
  });
});

describe("parseOpencodeTranscript — V1 compaction is a summary, not speech", () => {
  test("mode compaction reads as the summary role", () => {
    const entries = parseOpencodeTranscript(
      line("msg_a", { ...assistantData(), mode: "compaction", agent: "compaction", summary: true }, [
        textPart("## Objective\nThe work so far."),
      ]),
    );
    expect(entries[0]!.role).toBe("summary");
  });

  test("the older summary flag reads the same way", () => {
    const entries = parseOpencodeTranscript(
      line("msg_a", { ...assistantData(), summary: true }, [textPart("earlier history")]),
    );
    expect(entries[0]!.role).toBe("summary");
  });

  test("a user turn's summary OBJECT is not a compaction", () => {
    // V1 writes `summary: { diffs: [] }` on an ordinary user message. Reading that as a compaction
    // would set every human turn apart from speech.
    const entries = parseOpencodeTranscript(line("msg_a", userData(), [textPart("hi")]));
    expect(entries[0]!.role).toBe("user");
  });

  test("an ordinary assistant turn stays speech", () => {
    const entries = parseOpencodeTranscript(line("msg_a", assistantData(), [textPart("on it")]));
    expect(entries[0]!.role).toBe("assistant");
  });
});
