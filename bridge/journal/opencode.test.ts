import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      result: { text: "exit status 1", isError: true },
    });
  });

  test("a pending tool call has no result — it hasn't happened yet", () => {
    const entries = parseOpencodeTranscript(
      line("msg_b", assistantData(), [
        toolPart("bash", { status: "pending", input: { command: "sleep 5" } }),
      ]),
    );
    expect(entries[0]!.parts[0]).toEqual({ kind: "tool", name: "bash", summary: "sleep 5" });
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
    expect(entries[0]!.parts[0]).toEqual({ kind: "tool", name: "bash", summary: "sleep 5" });
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
