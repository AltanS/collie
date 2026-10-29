import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agyJournal, AgyTranscriptSource, createAgyReducer, parseAgyTranscript } from "./agy.ts";
import { NO_CURSOR } from "./cursor.ts";

// Synthetic content in the native 1.4.4-1.4.8 wire schema: no user conversation or credentials.
const ID = "11111111-2222-3333-4444-555555555555";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function integer(n: number): Buffer {
  let rem = n;
  const bytes: number[] = [];
  do {
    bytes.push((rem % 128) | (rem >= 128 ? 128 : 0));
    rem = Math.floor(rem / 128);
  } while (rem > 0);
  return Buffer.from(bytes);
}

function field(n: number, value: number | string | Uint8Array): Buffer {
  if (typeof value === "number") return Buffer.concat([integer(n * 8), integer(value)]);
  const data = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([integer(n * 8 + 2), integer(data.length), data]);
}

const message = (...fields: Buffer[]) => Buffer.concat(fields);

function step(type: number, body: Buffer, meta: Buffer = Buffer.alloc(0)): Buffer {
  return message(field(1, type), field(4, 3), field(5, message(field(1, field(1, 1792598450)), meta)), body);
}

const user = step(14, field(19, field(2, "Hello\n\n保留段落。")));
const answer = step(
  15,
  field(20, message(field(1, "A **native** reply."), field(3, "Check the facts."), field(8, "A **native** reply."))),
);
const tool = step(
  132,
  field(140, field(2, field(1, "Command exited with code 0."))),
  field(4, message(field(1, "call-1"), field(2, "run_command"), field(3, '{"CommandLine":"pwd"}'))),
);

function row(idx: number, type: number, payload: Uint8Array, format = 0): string {
  return JSON.stringify({ idx, type, format, payload: Buffer.from(payload).toString("base64") });
}

describe("AGY native steps", () => {
  test("preserves paragraphs, reasoning, answers and stable per-step identity without duplicate answers", () => {
    const entries = agyJournal([]).parse([row(0, 14, user), row(1, 15, answer), row(2, 132, tool)].join("\n"));
    expect(entries.map((entry) => entry.uuid)).toEqual(["agy-0", "agy-1", "agy-2"]);
    expect(entries[0]?.role).toBe("user");
    expect(entries[0]?.parts).toEqual([{ kind: "text", text: "Hello\n\n保留段落。" }]);
    expect(entries[0]?.ts).toBe("2026-10-21T16:00:50.000Z");
    expect(entries[1]?.parts).toEqual([
      { kind: "thinking", text: "Check the facts." },
      { kind: "text", text: "A **native** reply." },
    ]);
    expect(entries[2]?.parts[0]).toMatchObject({
      kind: "tool",
      id: "call-1",
      name: "run_command",
      result: { text: "Command exited with code 0." },
    });
  });

  test("renders compaction separately and native tool errors as failures", () => {
    const summary = step(23, field(30, field(5, "Earlier context.")));
    const error = Buffer.concat([tool, field(31, field(2, "file does not exist"))]);
    const entries = agyJournal([]).parse([row(3, 23, summary), row(4, 132, error)].join("\n"));
    expect(entries[0]).toMatchObject({ role: "summary", parts: [{ kind: "text", text: "Earlier context." }] });
    expect(entries[1]?.parts[0]).toMatchObject({ result: { text: "file does not exist", isError: true } });
  });

  test("supports historical tool step_types (5,7,8,9,17,21,33) and plumbing step_types (90,98,101,139) with 0 unknowns", () => {
    const reducer = createAgyReducer();
    const toolTypes = [
      [5, "write_to_file", '{"TargetFile":"/tmp/a.txt"}'],
      [7, "grep_search", '{"Query":"needle"}'],
      [8, "view_file", '{"AbsolutePath":"/tmp/a.txt"}'],
      [9, "list_dir", '{"DirectoryPath":"/tmp"}'],
      [17, "error_tool", '{"Reason":"bad"}'],
      [21, "run_command", '{"CommandLine":"ls"}'],
      [33, "search_web", '{"query":"collie"}'],
    ] as const;

    const added: string[] = [];
    let idx = 10;
    for (const [t, name, args] of toolTypes) {
      const payload = step(t, Buffer.alloc(0), field(4, message(field(1, `id-${t}`), field(2, name), field(3, args))));
      const res = reducer.push(row(idx++, t, payload));
      for (const e of res.added) {
        const part = e.parts[0];
        if (part?.kind === "tool") added.push(`${t}:${part.name}`);
      }
    }
    for (const plumbing of [90, 98, 101, 139]) {
      const payload = step(plumbing, Buffer.alloc(0));
      expect(reducer.push(row(idx++, plumbing, payload)).added).toEqual([]);
    }
    expect(added).toEqual([
      "5:write_to_file",
      "7:grep_search",
      "8:view_file",
      "9:list_dir",
      "17:error_tool",
      "21:run_command",
      "33:search_web",
    ]);
    expect(reducer.unknowns().rows.size).toBe(0);
  });

  test("declines truncated, malformed and unsupported records and counts new native types", () => {
    const reducer = createAgyReducer();
    for (const line of [
      "bad json",
      "null",
      row(-1, 14, user),
      row(0, 14, user, 1),
      row(0, 14, user.subarray(0, user.length - 1)),
      row(0, 14, Buffer.from([0])),
      JSON.stringify({ idx: 0, type: 14, format: 0, payload: "not base64!" }),
      row(0, 999, user),
    ]) {
      expect(reducer.push(line).added).toEqual([]);
    }
    expect(reducer.unknowns().rows.get("999")).toBe(1);
    expect(reducer.push(row(0, 14, user)).added).toHaveLength(1);
  });
});

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home() {
  const root = await mkdtemp(join(tmpdir(), "collie-agy-journal-"));
  temps.push(root);
  await mkdir(join(root, "conversations"));
  await mkdir(join(root, "presence"));
  return root;
}

function database(root: string, id = ID) {
  const path = join(root, "conversations", `${id}.db`);
  const db = new Database(path);
  db.run("create table steps (idx integer primary key, step_type integer, step_format integer, step_payload blob)");
  db.run("insert into steps values (0,14,0,?)", [user]);
  db.run("insert into steps values (1,15,0,?)", [answer]);
  return { path, db };
}

describe("AGY read-only source and exact discovery", () => {
  test("reads the same transcript for Chat and History, including an in-place streaming edit", async () => {
    const root = await home();
    const { path, db } = database(root);
    try {
      const source = new AgyTranscriptSource(root);
      const resolved = await source.resolve({ kind: "id", value: ID });
      expect(resolved).toBe(await realpath(path));
      const first = await source.readSince(resolved!, NO_CURSOR);
      expect(first.reset).toBe(true);
      expect(first.fromStart).toBe(true);
      const parse = agyJournal([]).parse;
      expect(parse((await source.load(resolved!)).text)).toEqual(parse(first.lines.join("\n")));
      const edited = step(15, field(20, field(1, "The streamed reply is complete.")));
      db.run("update steps set step_payload = ? where idx = 1", [edited]);
      const next = await source.readSince(resolved!, first.cursor);
      expect(next.reset).toBe(true);
      expect(parse(next.lines.join("\n"))[1]).toMatchObject({
        uuid: "agy-1",
        parts: [{ kind: "text", text: "The streamed reply is complete." }],
      });
      expect(db.query("select count(*) as n from steps").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  test("a poll on an unchanged database reads nothing, and any commit reads the tail again", async () => {
    const root = await home();
    const { path, db } = database(root);
    try {
      const source = new AgyTranscriptSource(root);
      const key = (await source.resolve({ kind: "id", value: ID }))!;
      const first = await source.readSince(key, NO_CURSOR);
      expect(first.lines).toHaveLength(2);
      expect(first.cursor).not.toBe(NO_CURSOR);
      // Nothing moved: no rows, no reset, the same cursor.
      expect(await source.readSince(key, first.cursor)).toEqual({ lines: [], cursor: first.cursor, reset: false, fromStart: false });
      // A commit inside the same millisecond, the file the same size, still moves the version (the
      // header's change counter), so the edit is read.
      const size = statSync(path).size;
      db.run("update steps set step_payload = ? where idx = 1", [step(15, field(20, field(1, "Another reply.")))]);
      expect(statSync(path).size).toBe(size);
      const again = await source.readSince(key, first.cursor);
      expect(again.reset).toBe(true);
      expect(again.lines).toHaveLength(2);
      expect(again.cursor).not.toBe(first.cursor);
      // A cursor from another database is never taken for this one's.
      const other = database(root, "11111111-2222-4333-8444-555555555555");
      other.db.close();
      const otherKey = (await source.resolve({ kind: "id", value: "11111111-2222-4333-8444-555555555555" }))!;
      expect((await source.readSince(otherKey, again.cursor)).reset).toBe(true);
    } finally {
      db.close();
    }
  });

  test("rejects traversal, path refs, foreign keys and symlinks out of the root", async () => {
    const root = await home();
    const outside = await home();
    const { path, db } = database(outside);
    db.close();
    const source = new AgyTranscriptSource(root);
    await symlink(path, join(root, "conversations", `${ID}.db`));
    expect(await source.resolve({ kind: "id", value: ID })).toBeNull();
    expect(await source.resolve({ kind: "id", value: "../outside" })).toBeNull();
    expect(await source.resolve({ kind: "path", value: path })).toBeNull();
    expect(await source.stat(path)).toBeNull();
    expect((await source.load(path)).text).toBe("");
  });

  test("reads committed WAL rows instead of ignoring an active WAL", async () => {
    const root = await home();
    const { path, db } = database(root);
    try {
      db.run("pragma journal_mode=wal");
      db.run("update steps set step_payload = ? where idx = 1", [step(15, field(20, field(1, "Answer from WAL.")))]);
      const adapter = agyJournal(root);
      const resolved = await adapter.source.resolve({ kind: "id", value: ID });
      const data = await adapter.source.load(resolved ?? path);
      expect(adapter.parse(data.text)[1]?.parts).toEqual([{ kind: "text", text: "Answer from WAL." }]);
    } finally {
      db.close();
    }
  });

  test("does not deserialize stale main-DB bytes when a -wal file exists or header is not WAL 2, 2", async () => {
    const root = await home();
    const { path, db } = database(root);
    db.run("pragma journal_mode=wal");
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    await rm(`${path}-shm`, { force: true });
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    bytes[18] = 2;
    bytes[19] = 2;
    await writeFile(path, bytes);
    await writeFile(`${path}-wal`, "uncheckpointed");
    const convDir = join(root, "conversations");
    const { chmod } = await import("node:fs/promises");
    if (process.platform !== "win32") {
      await chmod(convDir, 0o555);
      try {
        const source = new AgyTranscriptSource(root);
        expect(await source.resolve({ kind: "id", value: ID })).toBeNull();
      } finally {
        await chmod(convDir, 0o755);
      }
    }

    await rm(`${path}-wal`, { force: true });
    bytes[18] = 3;
    bytes[19] = 3;
    await writeFile(path, bytes);
    const source = new AgyTranscriptSource(root);
    expect(await source.resolve({ kind: "id", value: ID })).toBeNull();

    // Non-open SQLite errors (e.g. SQLITE_ERROR on missing schema even when header bytes are 2, 2)
    // must not trigger Database.deserialize.
    const schemaPath = join(root, "conversations", `${OTHER}.db`);
    const schemaDb = new Database(schemaPath);
    schemaDb.run("pragma journal_mode=wal");
    schemaDb.run("create table unrelated (x integer)");
    schemaDb.run("pragma wal_checkpoint(truncate)");
    schemaDb.close();
    await rm(`${schemaPath}-shm`, { force: true });
    const schemaBytes = new Uint8Array(await Bun.file(schemaPath).arrayBuffer());
    schemaBytes[18] = 2;
    schemaBytes[19] = 2;
    await writeFile(schemaPath, schemaBytes);
    const spy = spyOn(Database, "deserialize");
    try {
      expect(await source.resolve({ kind: "id", value: OTHER })).toBeNull();
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("binds the process's lock, not newer neighbouring sessions or a stale --conversation argument", async () => {
    const root = await home();
    const { db } = database(root);
    db.close();
    const other = database(root, OTHER);
    other.db.close();
    const lock = join(root, "presence", `${ID}.lock`);
    await writeFile(lock, "");
    const adapter = agyJournal(root, () => Promise.resolve(`p42\nn${lock}\n`));
    const hints = {
      shared: true as const,
      processes: [{ pid: 42, argv: ["/bin/antigravity", "--conversation", OTHER] }],
    };
    expect(await adapter.discover!("/same-workspace", hints)).toEqual({ kind: "id", value: ID });
    expect(await adapter.discover!("/same-workspace", { processes: [] })).toBeNull();
    expect(
      await adapter.discover!("/same-workspace", { processes: [{ argv: ["agy", "--conversation", OTHER] }] }),
    ).toEqual({ kind: "id", value: OTHER });
  });

  test("fails closed on missing lsof, multiple locks and a foreign process's lock", async () => {
    const root = await home();
    const foreign = await home();
    const { db } = database(root);
    db.close();
    const hints = { processes: [{ pid: 42, argv: ["agy"] }] };
    expect(
      await agyJournal(root, () => Promise.reject(new Error("unavailable"))).discover!("/cwd", hints),
    ).toBeNull();
    const lock = join(root, "presence", `${ID}.lock`);
    const other = join(root, "presence", `${OTHER}.lock`);
    await writeFile(lock, "");
    await writeFile(other, "");
    expect(await agyJournal(root, () => Promise.resolve(`n${lock}\nn${other}\n`)).discover!("/cwd", hints)).toBeNull();
    const outside = join(foreign, "presence", `${ID}.lock`);
    await writeFile(outside, "");
    expect(await agyJournal(root, () => Promise.resolve(`n${outside}\n`)).discover!("/cwd", hints)).toBeNull();
  });
});

describe("AGY plaintext transcript.jsonl fallback", () => {
  test("falls back to brain/<uuid>/.system_generated/logs/transcript.jsonl when no populated .db exists", async () => {
    const root = await home();
    const logDir = join(root, "brain", ID, ".system_generated", "logs");
    await mkdir(logDir, { recursive: true });
    const jsonlPath = join(logDir, "transcript.jsonl");
    const wrappedUser =
      "<USER_REQUEST>\nHello from fallback\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>";
    await writeFile(
      jsonlPath,
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: wrappedUser, created_at: "2026-10-21T00:00:00Z" }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          content: "Fallback answer",
          tool_calls: [{ name: "view_file", args: { path: "/a.ts" } }],
          created_at: "2026-10-21T00:00:01Z",
        }),
        JSON.stringify({ step_index: 2, type: "GENERIC", content: "Tool output", created_at: "2026-10-21T00:00:02Z" }),
      ].join("\n") + "\n",
    );

    const source = new AgyTranscriptSource(root);
    const resolved = await source.resolve({ kind: "id", value: ID });
    expect(resolved).toBe(await realpath(jsonlPath));
    const loaded = await source.load(resolved!);
    const entries = parseAgyTranscript(loaded.text);
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["agy-0", "user"],
      ["agy-1", "assistant"],
      ["agy-2", "note"],
    ]);
    expect(entries[0]?.parts).toEqual([{ kind: "text", text: "Hello from fallback" }]);
  });
});
