import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NO_CURSOR } from "./cursor.ts";
import { FIRST_TAIL_ROWS } from "./files.ts";
import {
  hermesJournal,
  HermesTranscriptSource,
  isHermesSessionId,
  parseHermesTranscript,
} from "./hermes.ts";

const SID = "20260909_154520_9e0b91";
const LOCAL_SID = "local-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Hermes session ids", () => {
  test("accepts Hermes ids and rejects path-shaped input", () => {
    expect(isHermesSessionId(SID)).toBe(true);
    expect(isHermesSessionId(LOCAL_SID)).toBe(true);
    expect(isHermesSessionId("../../state.db")).toBe(false);
    expect(isHermesSessionId("2026_bad")).toBe(false);
    expect(isHermesSessionId("local-abc")).toBe(false);
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

  test("opens a WAL-header state.db after -wal/-shm removal without SQLITE_CANTOPEN", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-wal-closed-"));
    const dbPath = join(root, "state.db");
    const db = new Database(dbPath);
    db.run("pragma journal_mode=wal");
    db.run("create table sessions (id text primary key, source text, started_at real, parent_session_id text)");
    db.run("create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)");
    db.run("insert into sessions (id, source, started_at, parent_session_id) values (?, 'cli', 1, null)", [SID]);
    db.run("insert into messages (id, session_id, role, content, timestamp) values (1, ?, 'user', 'wal closed turn', 1)", [SID]);
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    // Ensure header bytes 18-19 are 2, 2 (WAL mode) with no -wal/-shm on disk, matching ~/.hermes/state.db.
    const bytes = await readFile(dbPath);
    bytes[18] = 2;
    bytes[19] = 2;
    await writeFile(dbPath, bytes);
    // Make directory read-only so plain readonly open cannot create -shm and would fail with SQLITE_CANTOPEN.
    const { chmod } = await import("node:fs/promises");
    await chmod(root, 0o555);
    try {
      const source = new HermesTranscriptSource(root);
      const key = await source.resolve({ kind: "id", value: SID });
      expect(key).not.toBeNull();
      const loaded = await source.load(key!);
      expect(parseHermesTranscript(loaded.text)[0]?.parts[0]).toEqual({ kind: "text", text: "wal closed turn" });
    } finally {
      await chmod(root, 0o755);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not deserialize stale main-DB bytes when a -wal sidecar exists or header is not WAL 2, 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-wal-guard-"));
    const dbPath = join(root, "state.db");
    const db = new Database(dbPath);
    db.run("pragma journal_mode=wal");
    db.run("create table sessions (id text primary key, source text, started_at real, parent_session_id text)");
    db.run("create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)");
    db.run("insert into sessions (id, source, started_at, parent_session_id) values (?, 'cli', 1, null)", [SID]);
    db.run("insert into messages (id, session_id, role, content, timestamp) values (1, ?, 'user', 'stale main turn', 1)", [SID]);
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    await rm(`${dbPath}-shm`, { force: true });
    const bytes = await readFile(dbPath);
    bytes[18] = 2;
    bytes[19] = 2;
    await writeFile(dbPath, bytes);
    await writeFile(`${dbPath}-wal`, "uncheckpointed");
    const { chmod } = await import("node:fs/promises");
    if (process.platform !== "win32") {
      await chmod(root, 0o555);
      try {
        const source = new HermesTranscriptSource(root);
        expect(await source.resolve({ kind: "id", value: SID })).toBeNull();
      } finally {
        await chmod(root, 0o755);
      }
    }

    await rm(`${dbPath}-wal`, { force: true });
    bytes[18] = 3;
    bytes[19] = 3;
    await writeFile(dbPath, bytes);
    try {
      const source = new HermesTranscriptSource(root);
      expect(await source.resolve({ kind: "id", value: SID })).toBeNull();

      // Non-open SQLite errors (e.g. SQLITE_ERROR on missing table even when header bytes are 2, 2)
      // must not trigger Database.deserialize.
      const schemaRoot = await mkdtemp(join(tmpdir(), "collie-hermes-wal-schema-"));
      const schemaPath = join(schemaRoot, "state.db");
      const schemaDb = new Database(schemaPath);
      schemaDb.run("pragma journal_mode=wal");
      schemaDb.run("create table unrelated (x integer)");
      schemaDb.run("pragma wal_checkpoint(truncate)");
      schemaDb.close();
      await rm(`${schemaPath}-shm`, { force: true });
      const schemaBytes = await readFile(schemaPath);
      schemaBytes[18] = 2;
      schemaBytes[19] = 2;
      await writeFile(schemaPath, schemaBytes);
      const spy = spyOn(Database, "deserialize");
      try {
        expect(await new HermesTranscriptSource(schemaRoot).resolve({ kind: "id", value: SID })).toBeNull();
        expect(spy).toHaveBeenCalledTimes(0);
      } finally {
        spy.mockRestore();
        await rm(schemaRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("hermesJournal discover", () => {
  const schema = (db: Database) => {
    db.run(
      "create table sessions (id text primary key, source text, started_at real, parent_session_id text, cwd text)",
    );
    db.run(
      "create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)",
    );
  };

  async function lab(rows: readonly [id: string, cwd: string | null, startedAt: number][]) {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-discover-"));
    const db = new Database(join(root, "state.db"));
    schema(db);
    for (const [id, cwd, startedAt] of rows) {
      db.run("insert into sessions (id, source, started_at, cwd) values (?, 'cli', ?, ?)", [id, startedAt, cwd]);
    }
    db.close();
    return root;
  }

  test("finds the newest session whose cwd equals the pane's folder", async () => {
    const root = await lab([
      ["20261001_000000_aaaaaa", "/a", 1],
      ["20261002_000000_bbbbbb", "/b", 1],
      ["20261003_000000_cccccc", "/b", 2],
    ]);
    const adapter = hermesJournal([root]);
    await expect(adapter.discover?.("/b")).resolves.toEqual({ kind: "id", value: "20261003_000000_cccccc" });
    await expect(adapter.discover?.("/a")).resolves.toEqual({ kind: "id", value: "20261001_000000_aaaaaa" });
    await expect(adapter.discover?.("/nowhere")).resolves.toBeNull();
    await expect(adapter.discover?.("")).resolves.toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  test("a profile's own state.db is searched too", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-discover-profile-"));
    const defaultDb = new Database(join(root, "state.db"));
    schema(defaultDb);
    defaultDb.close();
    const profileDir = join(root, "profiles", "assistant");
    await mkdir(profileDir, { recursive: true });
    const profileDb = new Database(join(profileDir, "state.db"));
    schema(profileDb);
    profileDb.run("insert into sessions (id, source, started_at, cwd) values (?, 'cli', 1, ?)", [
      "20261001_000001_bbbbbb",
      "/work",
    ]);
    profileDb.close();

    const adapter = hermesJournal([root]);
    await expect(adapter.discover?.("/work")).resolves.toEqual({ kind: "id", value: "20261001_000001_bbbbbb" });
    await rm(root, { recursive: true, force: true });
  });

  test("newest wins ACROSS databases, not just within the first one that matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-discover-cross-db-"));
    const defaultDb = new Database(join(root, "state.db"));
    schema(defaultDb);
    defaultDb.run("insert into sessions (id, source, started_at, cwd) values (?, 'cli', 1, ?)", [
      "20261001_000000_aaaaaa",
      "/shared",
    ]);
    defaultDb.close();
    const profileDir = join(root, "profiles", "assistant");
    await mkdir(profileDir, { recursive: true });
    const profileDb = new Database(join(profileDir, "state.db"));
    schema(profileDb);
    profileDb.run("insert into sessions (id, source, started_at, cwd) values (?, 'cli', 2, ?)", [
      "20261002_000000_bbbbbb",
      "/shared",
    ]);
    profileDb.close();

    const adapter = hermesJournal([root]);
    await expect(adapter.discover?.("/shared")).resolves.toEqual({ kind: "id", value: "20261002_000000_bbbbbb" });
    await rm(root, { recursive: true, force: true });
  });

  test("foreground argv's explicit --resume names the pane's own session across a shared cwd, including python3 -c launcher", async () => {
    const root = await lab([
      ["20261001_000000_aaaaaa", "/same", 1],
      ["20261002_000000_bbbbbb", "/same", 2],
    ]);
    const adapter = hermesJournal([root]);
    await expect(
      adapter.discover?.("/same", { processes: [{ argv: ["hermes", "chat", "--resume", "20261001_000000_aaaaaa"] }] }),
    ).resolves.toEqual({ kind: "id", value: "20261001_000000_aaaaaa" });
    await expect(
      adapter.discover?.("/same", { processes: [{ argv: ["/usr/local/bin/hermes", "chat", "-r", "20261002_000000_bbbbbb"] }] }),
    ).resolves.toEqual({ kind: "id", value: "20261002_000000_bbbbbb" });
    await expect(
      adapter.discover?.("/same", {
        processes: [
          {
            argv: [
              "/Users/operator/.hermes/tools/python-3.14.7/bin/python3",
              "-I",
              "-c",
              "import sys\nfrom hermes_cli.main import main\nsys.exit(main())",
              "chat",
              "--resume",
              LOCAL_SID,
            ],
          },
        ],
      }),
    ).resolves.toEqual({ kind: "id", value: LOCAL_SID });
    await rm(root, { recursive: true, force: true });
  });

  test("a bare hermes with no --resume falls through to the cwd walk", async () => {
    const root = await lab([["20261001_000000_aaaaaa", "/same", 1]]);
    const adapter = hermesJournal([root]);
    await expect(
      adapter.discover?.("/same", { processes: [{ argv: ["hermes", "chat"] }] }),
    ).resolves.toEqual({ kind: "id", value: "20261001_000000_aaaaaa" });
    await rm(root, { recursive: true, force: true });
  });

  test("an unresolvable argv id still returns the ref so resolve() gates it", async () => {
    const root = await lab([["20261001_000000_aaaaaa", "/same", 1]]);
    const adapter = hermesJournal([root]);
    await expect(
      adapter.discover?.("/same", {
        processes: [{ argv: ["hermes", "chat", "--resume", "20269999_999999_zzzzzz"] }],
      }),
    ).resolves.toEqual({ kind: "id", value: "20269999_999999_zzzzzz" });
    await rm(root, { recursive: true, force: true });
  });

  test("declares sharedFolderBlind and returns null in a shared folder unless argv names a session", async () => {
    const root = await lab([
      ["20261001_000000_aaaaaa", "/same", 1],
      ["20261002_000000_bbbbbb", "/same", 2],
    ]);
    const adapter = hermesJournal([root]);
    expect(adapter.sharedFolderBlind).toBe(true);
    await expect(adapter.discover?.("/same", { shared: true })).resolves.toBeNull();
    await expect(
      adapter.discover?.("/same", { shared: true, processes: [{ argv: ["hermes", "chat"] }] }),
    ).resolves.toBeNull();
    await expect(
      adapter.discover?.("/same", {
        shared: true,
        processes: [{ argv: ["hermes", "--resume", "20261001_000000_aaaaaa"] }],
      }),
    ).resolves.toEqual({ kind: "id", value: "20261001_000000_aaaaaa" });
    await rm(root, { recursive: true, force: true });
  });
});
// Named profiles keep their own state.db under `profiles/<name>/` (`hermes profile use` makes one the
// default a bare `hermes` runs), so a pane's session may live in any of them.
describe("HermesTranscriptSource — profiles", () => {
  const SESSIONS = "create table sessions (id text primary key, source text, started_at real, parent_session_id text)";
  const MESSAGES =
    "create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)";

  async function sessionDb(dir: string, id: string, text: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const db = new Database(join(dir, "state.db"));
    db.run(SESSIONS);
    db.run(MESSAGES);
    db.run("insert into sessions (id, source, started_at, parent_session_id) values (?, 'cli', 1, null)", [id]);
    db.run("insert into messages (id, session_id, role, content, timestamp) values (1, ?, 'user', ?, 1)", [id, text]);
    db.close();
  }

  test("finds a session in a named profile's state.db as well as in the root's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-profiles-"));
    const inProfile = "20261016_101707_b9d200";
    await sessionDb(root, SID, "default profile turn");
    await sessionDb(join(root, "profiles", "assistant"), inProfile, "assistant profile turn");
    const source = new HermesTranscriptSource(root);

    const own = await source.resolve({ kind: "id", value: SID });
    expect(own).toBe(`${await realpath(join(root, "state.db"))}#${SID}`);
    const profiled = await source.resolve({ kind: "id", value: inProfile });
    expect(profiled).toBe(`${await realpath(join(root, "profiles", "assistant", "state.db"))}#${inProfile}`);
    const loaded = await source.load(profiled!);
    expect(parseHermesTranscript(loaded.text)[0]?.parts[0]).toEqual({ kind: "text", text: "assistant profile turn" });
    expect(await source.resolve({ kind: "id", value: "20261016_000000_000000" })).toBeNull();

    await rm(root, { recursive: true, force: true });
  });

  test("never opens a profile whose folder links outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-root-"));
    const outside = await mkdtemp(join(tmpdir(), "collie-hermes-outside-"));
    const id = "20261016_101707_b9d201";
    await sessionDb(outside, id, "not ours");
    await mkdir(join(root, "profiles"), { recursive: true });
    await symlink(outside, join(root, "profiles", "linked"));
    expect(await new HermesTranscriptSource(root).resolve({ kind: "id", value: id })).toBeNull();

    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
});

// The live read. Hermes' cursor is `max(messages.id)`, so this is where the two things that cursor
// CAN and CANNOT see are pinned: a new row arrives, and a row whose mutable state changed does not.
describe("HermesTranscriptSource — readSince", () => {
  const SCHEMA = [
    "create table sessions (id text primary key, source text, started_at real, parent_session_id text)",
    "create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)",
  ] as const;

  /** A temp `state.db` holding one session, plus the two verbs these tests drive it with. */
  async function lab(parent: string | null = null) {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-since-"));
    const db = new Database(join(root, "state.db"));
    for (const ddl of SCHEMA) db.run(ddl);
    db.run("insert into sessions (id, source, started_at, parent_session_id) values (?, 'tui', 1, ?)", [SID, parent]);
    return {
      root,
      db,
      session: (id: string, p: string | null = null) =>
        db.run("insert into sessions (id, source, started_at, parent_session_id) values (?, 'tui', 1, ?)", [id, p]),
      say: (id: number, text: string, session = SID) =>
        db.run("insert into messages (id, session_id, role, content, timestamp) values (?, ?, 'user', ?, ?)", [
          id,
          session,
          text,
          id,
        ]),
      clean: async () => {
        db.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  const texts = (lines: readonly string[]) =>
    lines.map((line) => parseHermesTranscript(line)[0]?.parts[0]).map((part) => (part?.kind === "text" ? part.text : null));

  test("a first read takes the turns and says the answer replaces nothing", async () => {
    const f = await lab();
    f.say(1, "older turn");
    f.say(2, "newer turn");
    const src = new HermesTranscriptSource(f.root);
    const key = await src.resolve({ kind: "id", value: SID });

    const first = await src.readSince(key!, NO_CURSOR);
    expect(texts(first.lines)).toEqual(["older turn", "newer turn"]);
    expect(first.reset).toBe(true);

    await f.clean();
  });

  test("a resume carries only the rows written since", async () => {
    const f = await lab();
    f.say(1, "older turn");
    const src = new HermesTranscriptSource(f.root);
    const key = await src.resolve({ kind: "id", value: SID });
    const first = await src.readSince(key!, NO_CURSOR);

    f.say(2, "newer turn");
    const next = await src.readSince(key!, first.cursor);
    expect(texts(next.lines)).toEqual(["newer turn"]);
    expect(next.reset).toBe(false);

    await f.clean();
  });

  test("a tick where nothing was written reads no rows and keeps the position", async () => {
    const f = await lab();
    f.say(1, "older turn");
    const src = new HermesTranscriptSource(f.root);
    const key = await src.resolve({ kind: "id", value: SID });
    const first = await src.readSince(key!, NO_CURSOR);

    const again = await src.readSince(key!, first.cursor);
    expect(again.lines).toEqual([]);
    expect(again.cursor).toBe(first.cursor);
    expect(again.reset).toBe(false);

    await f.clean();
  });

  // The hole, pinned rather than papered over. `active` is mutable per row, so a turn can leave the
  // conversation without any id moving, and an id cursor is blind to it by construction. The live
  // window's answer is a reset, which is a layer above this one; what belongs here is the truth.
  test("a row that stops being active is invisible to an id cursor", async () => {
    const f = await lab();
    f.say(1, "older turn");
    f.say(2, "newer turn");
    const src = new HermesTranscriptSource(f.root);
    const key = await src.resolve({ kind: "id", value: SID });
    const first = await src.readSince(key!, NO_CURSOR);
    expect(first.lines).toHaveLength(2);

    f.db.run("update messages set active = 0 where id = 2");
    const after = await src.readSince(key!, first.cursor);
    expect(after.lines).toEqual([]);
    // A whole read DOES see it, which is what a reset gets the caller.
    const whole = parseHermesTranscript((await src.load(key!)).text);
    expect(whole.map((e) => (e.parts[0]?.kind === "text" ? e.parts[0].text : null))).toEqual(["older turn"]);

    await f.clean();
  });

  test("a first read is bounded by rows, so a long session is not composed to be thrown away", async () => {
    // One transaction: a commit per row is one disk sync per row, which is seconds on Windows
    // (NTFS flushes are slow) and a load flake on a busy Linux runner. The rows are the same.
    const f = await lab();
    f.db.transaction(() => {
      for (let id = 1; id <= FIRST_TAIL_ROWS + 5; id++) f.say(id, `turn ${id}`);
    })();
    const src = new HermesTranscriptSource(f.root);
    const key = await src.resolve({ kind: "id", value: SID });

    const first = await src.readSince(key!, NO_CURSOR);
    expect(first.lines).toHaveLength(FIRST_TAIL_ROWS);
    // The NEWEST rows, in the order they were written.
    expect(texts(first.lines).at(0)).toBe("turn 6");
    expect(texts(first.lines).at(-1)).toBe(`turn ${FIRST_TAIL_ROWS + 5}`);

    // And the read after it resumes from the newest row, not from the window's edge.
    f.say(FIRST_TAIL_ROWS + 6, "one more");
    const next = await src.readSince(key!, first.cursor);
    expect(texts(next.lines)).toEqual(["one more"]);

    await f.clean();
  });

  // `fromStart` needs BOTH bounds to have stood down: the row limit did not bite, and the byte clip
  // dropped nothing. It is what the live window turns into "load older" (journal/live.ts § hasOlder),
  // so a wrong reading either offers turns that do not exist or hides turns that do.
  test("a short session's first read claims the start; a long one's does not", async () => {
    const short = await lab();
    short.say(1, "only turn");
    const one = new HermesTranscriptSource(short.root);
    const shortKey = await one.resolve({ kind: "id", value: SID });
    const shortRead = await one.readSince(shortKey!, NO_CURSOR);
    expect(shortRead.reset).toBe(true);
    expect(shortRead.fromStart).toBe(true);
    // And a resume after it never claims the start, whatever it carries.
    short.say(2, "another");
    expect((await one.readSince(shortKey!, shortRead.cursor)).fromStart).toBe(false);
    await short.clean();

    // One transaction: a commit per row is one disk sync per row, which is seconds on Windows
    // (NTFS flushes are slow) and a load flake on a busy Linux runner. The rows are the same.
    const long = await lab();
    long.db.transaction(() => {
      for (let id = 1; id <= FIRST_TAIL_ROWS + 5; id++) long.say(id, `turn ${id}`);
    })();
    const two = new HermesTranscriptSource(long.root);
    const longKey = await two.resolve({ kind: "id", value: SID });
    const longRead = await two.readSince(longKey!, NO_CURSOR);
    expect(longRead.reset).toBe(true);
    expect(longRead.fromStart).toBe(false);
    await long.clean();
  });

  test("a first read carries the ancestors a fork inherited", async () => {
    const f = await lab("20260101_000000_parent");
    f.session("20260101_000000_parent", null);
    f.say(1, "in the parent", "20260101_000000_parent");
    f.say(2, "in the fork");
    const src = new HermesTranscriptSource(f.root);
    const key = await src.resolve({ kind: "id", value: SID });

    expect(texts((await src.readSince(key!, NO_CURSOR)).lines)).toEqual(["in the parent", "in the fork"]);

    await f.clean();
  });

  test("a key it cannot split reports nothing new", async () => {
    expect(await new HermesTranscriptSource("/nope").readSince("/not-a-key", NO_CURSOR)).toEqual({
      lines: [],
      cursor: NO_CURSOR,
      reset: false,
      fromStart: false,
    });
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
