import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isOpencodeSessionId,
  OpencodeTranscriptSource,
  opencodeKey,
  parseOpencodeTranscript,
  splitOpencodeKey,
} from "./opencode.ts";
import { MAX_RESULT_CHARS, MAX_TEXT_CHARS } from "./text.ts";

// Builders mirroring the verified on-disk shape (opencode 1.18.9, 2026-08-03): a message row's `data`
// json plus its parts' `data` json, composed by the source into one JSONL line per message.

const SID = "ses_03969c19cffeJrZCPOT6zG8Bm7";

const line = (
  id: string,
  data: unknown,
  parts: unknown[],
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
const toolPart = (tool: string, state: Record<string, unknown>) => ({
  type: "tool",
  tool,
  callID: "call_1",
  state,
});

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
    expect((entries[0]!.parts[0] as { text: string }).text).toHaveLength(MAX_TEXT_CHARS);
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

    const db = new Database(join(root, "opencode.db"));
    db.run(
      "create table session (id text primary key, parent_id text, title text, time_created integer, time_updated integer)",
    );
    db.run(
      "create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)",
    );
    db.run(
      "create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)",
    );
    db.run("insert into session values ('" + SID + "', null, 'root session', 1, 100)");
    // A subagent session — its rows are never queried, which is why no sidechain filtering exists.
    db.run("insert into session values ('" + SUB + "', '" + SID + "', 'subagent', 1, 100)");
    const msg = (id: string, created: number, data: unknown) =>
      db.run("insert into message values (?, ?, ?, ?, ?)", [id, SID, created, created, JSON.stringify(data)]);
    const part = (id: string, messageId: string, created: number, data: unknown) =>
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
    const outer = new Database(join(outside, "opencode.db"));
    outer.run("create table session (id text primary key, parent_id text, time_updated integer)");
    outer.run("insert into session values ('" + SID + "', null, 1)");
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
