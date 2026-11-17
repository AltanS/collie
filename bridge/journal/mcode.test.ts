import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createMcodeReducer,
  isMcodeSessionId,
  McodeTranscriptSource,
  mcodeJournal,
  parseMcodeArgv,
  parseMcodeTranscript,
} from "./mcode.ts";
import { createOpenFiles, MAX_OPEN_FILES_PIDS, type LsofRunner, type OpenFiles } from "./open-files.ts";

const SID = "mvs_eeeea151d98844409cc358330f9e61bd";
const OTHER = "mvs_abcdefabcdefabcdefabcdefabcdefab";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function writeSession(root: string, id: string, rows: readonly string[] = [userRow], time = "12-00-00-000"): Promise<string> {
  // SAFETY: Buffer.from of a validated id always encodes; base64url emits no path separators.
  const dir = join(root, "2026", "11", "03", `${time}-session_${Buffer.from(id).toString("base64url")}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, sessionId: id, createdAtMs: 0, updatedAtMs: 0, paths: {} }),
  );
  await writeFile(join(dir, "messages.jsonl"), rows.join("\n") + "\n");
  return dir;
}

/** One mcode message row. */
function row(message: { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; timestamp?: number; canonicalTextRange?: unknown }, messageId = "msg-1"): string {
  return JSON.stringify({ message_id: messageId, turn_id: "turn-1", message });
}

const userRow = row({ role: "user", content: [{ type: "text", text: "list the folder" }] }, "msg-user-1");
const assistantRow = row(
  {
    role: "assistant",
    timestamp: 1793749975159,
    content: [
      { type: "thinking", thinking: "Run ls." },
      { type: "text", text: "Here it is." },
      { type: "toolCall", id: "call_1", name: "shell_command", arguments: { command: "ls" } },
    ],
  },
  "msg-asst-1",
);
const resultRow = row(
  {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "shell_command",
    content: [{ type: "text", text: "file.ts\nREADME.md" }],
    isError: false,
    timestamp: 1793750003315,
  },
  "msg-tool-1",
);

describe("isMcodeSessionId", () => {
  test("accepts mvs_ ids and refuses path shapes", () => {
    expect(isMcodeSessionId(SID)).toBe(true);
    expect(isMcodeSessionId("../etc/passwd")).toBe(false);
    expect(isMcodeSessionId("messages.jsonl")).toBe(false);
    expect(isMcodeSessionId("")).toBe(false);
  });
});

describe("parseMcodeTranscript", () => {
  test("reads user, assistant parts and folds a tool result onto its call", () => {
    const entries = parseMcodeTranscript([userRow, assistantRow, resultRow].join("\n"));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      uuid: "msg-user-1",
      ts: "",
      role: "user",
      parts: [{ kind: "text", text: "list the folder" }],
    });
    const [asst] = entries.splice(1);
    expect(asst?.role).toBe("assistant");
    expect(asst?.parts[0]).toEqual({ kind: "thinking", text: "Run ls." });
    expect(asst?.parts[1]).toEqual({ kind: "text", text: "Here it is." });
    expect(asst?.parts[2]).toMatchObject({
      kind: "tool",
      name: "shell_command",
      summary: "ls",
      id: "call_1",
      call: { kind: "other", name: "shell_command", summary: "ls" },
      result: { text: "file.ts\nREADME.md" },
    });
  });

  test("marks a failed tool result as an error", () => {
    const failed = row(
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "shell_command",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      },
      "msg-tool-x",
    );
    const entries = parseMcodeTranscript([assistantRow, failed].join("\n"));
    const part = entries[0]?.parts[2];
    if (part?.kind !== "tool") throw new Error("expected a tool part");
    expect(part.result?.isError).toBe(true);
  });

  test("canonicalTextRange slices the spoken prompt out of the injected plumbing", () => {
    const plumbing = "<system-reminder>\nskills\n</system-reminder>\n\nwhy is this not chat?";
    const envelope = row(
      {
        role: "user",
        content: [{ type: "text", text: plumbing }],
        canonicalTextRange: { startOffset: plumbing.indexOf("why"), endOffset: plumbing.length },
      },
      "msg-canonical",
    );
    const [entry] = parseMcodeTranscript(envelope);
    expect(entry!.parts).toEqual([{ kind: "text", text: "why is this not chat?" }]);
  });

  test("a user row without canonicalTextRange keeps the whole text, and a bad range is ignored", () => {
    const plain = row({ role: "user", content: [{ type: "text", text: "just ask" }] }, "msg-plain");
    expect(parseMcodeTranscript(plain)[0]!.parts).toEqual([{ kind: "text", text: "just ask" }]);
    for (const range of [
      { startOffset: 5, endOffset: 2 }, // reversed
      { startOffset: -1, endOffset: 4 },
      { startOffset: 0, endOffset: 999 },
      "not an object",
      null,
    ]) {
      const bad = row(
        { role: "user", content: [{ type: "text", text: "just ask" }], canonicalTextRange: range },
        "msg-bad",
      );
      expect(parseMcodeTranscript(bad)[0]!.parts).toEqual([{ kind: "text", text: "just ask" }]);
    }
  });

  test("a result with no waiting call stands alone, and garbage rows are skipped", () => {
    const orphan = row(
      { role: "toolResult", toolCallId: "none", toolName: "t", content: [{ type: "text", text: "late" }] },
      "msg-orphan",
    );
    const entries = parseMcodeTranscript(["not json", "", '{"no":"message"}', orphan].join("\n"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts[0]).toMatchObject({ kind: "tool", result: { text: "late" } });
  });

  test("the reducer reports row and part types it has no branch for", () => {
    const reducer = createMcodeReducer();
    reducer.push(row({ role: "system", content: [{ type: "text", text: "plumbing" }] }, "msg-sys"));
    const tally = reducer.unknowns();
    expect(tally.rows.get("system")).toBe(1);
  });
});

describe("McodeTranscriptSource", () => {
  const CWD = "/Users/you/proj";

  /** A sessions root with one session folder, named the way mcode names it. */
  async function sessionRoot(id = SID): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "collie-mcode-")));
    dirs.push(root);
    await writeSession(root, id);
    return root;
  }

  test("resolves an id to its messages.jsonl under the dated folder", async () => {
    const root = await sessionRoot();
    const src = new McodeTranscriptSource(root);
    const resolved = await src.resolve({ kind: "id", value: SID });
    expect(resolved).toMatch(/messages\.jsonl$/);
    // The segments join with the host separator, so spell the expectation the same way.
    expect(resolved).toContain(join("2026", "11", "03"));
    expect(await src.resolve({ kind: "id", value: OTHER })).toBeNull();
    expect(await src.resolve({ kind: "id", value: "../escape" })).toBeNull();
    expect(await src.resolve({ kind: "path", value: "/etc/passwd" })).toBeNull();
  });

  test("a cached path replaced by a symlink out of the root is refused", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-mcode-")));
    dirs.push(base);
    const root = join(base, "sessions");
    const dir = await writeSession(root, SID);
    const log = join(dir, "messages.jsonl");

    const src = new McodeTranscriptSource(root);
    expect(await src.resolve({ kind: "id", value: SID })).toBe(log);

    const outside = join(base, "outside.jsonl");
    await writeFile(outside, "secrets\n");
    await rm(log);
    await symlink(outside, log);
    expect(await src.resolve({ kind: "id", value: SID })).toBeNull();
  });

  test("discovers the session the SQLite index names for the cwd", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-mcode-")));
    dirs.push(base);
    const root = join(base, "v2", "sessions");
    await writeSession(root, SID);
    await mkdir(join(root, "..", "sqlite"), { recursive: true });
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(root, "..", "sqlite", "runtime-state.sqlite"));
    db.run(
      "CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, workspace_dir TEXT, history_relative_dir TEXT, status TEXT, archived INTEGER, updated_at_ms INTEGER, created_at_ms INTEGER)",
    );
    // SAFETY: test fixture binding of literals this test just built.
    db.run("INSERT INTO local_runtime_sessions VALUES (?, ?, ?, 'started', 0, ?, ?)", [SID, CWD, "x", Date.now(), Date.now()]);
    db.close();

    const src = new McodeTranscriptSource(root);
    expect(await src.discoverSession(CWD)).toEqual({ kind: "id", value: SID });
  });

  test("binds to the session file the pane's process holds open (lsof)", async () => {
    const root = await sessionRoot(SID);
    // A stale index row would be the old answer; the live process decides now.
    // `lsof` is a POSIX tool and prints POSIX spellings, so the runner answers with `/` paths
    // even on Windows: the production regexes match what lsof itself would print.
    const log = [root, "2026", "11", "03", `12-00-00-000-session_${Buffer.from(SID).toString("base64url")}`, "messages.jsonl"].join("/");
    const observability = `/home/dev/.minimax/v2/observability/logs/sessions/${OTHER}/events.jsonl`;
    const asked: string[][] = [];
    const run: LsofRunner = async (args) => {
      asked.push([...args]);
      return ["p10", "f3", `n${log}`, `n${observability}`].join("\n");
    };
    const src = new McodeTranscriptSource(root, undefined, createOpenFiles(run));
    const ref = await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] });
    expect(ref).toEqual({ kind: "id", value: SID });
    expect(await src.resolve(ref!)).not.toBeNull();
    // The shared reader's question: the union of the pid's files and its group's (see open-files.ts).
    expect(asked).toEqual([["-nP", "-p", "10", "-g", "10", "-Fn"]]);
  });

  test("a process with no session file open means no session, never a past one", async () => {
    const root = await sessionRoot(SID);
    const run: LsofRunner = async () => ["p10", "f1", "n/etc/hosts"].join("\n");
    const src = new McodeTranscriptSource(root, undefined, createOpenFiles(run));
    expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] })).toBeNull();
    // No pid at all falls to the index, which holds only a stale row: still null.
    expect(await src.discoverSession(CWD)).toBeNull();
  });

  test("an lsof that fails answers no files, and a burst of requests forks it once per pid", async () => {
    const root = await sessionRoot(SID);
    let forks = 0;
    const run: LsofRunner = async () => {
      forks += 1;
      throw new Error("spawn lsof ENOENT");
    };
    const src = new McodeTranscriptSource(root, undefined, createOpenFiles(run));
    const hints = { processes: [{ argv: ["mcode"], pid: 10 }] };
    expect(await Promise.all([src.discoverSession(CWD, hints), src.discoverSession(CWD, hints), src.discoverSession(CWD, hints)])).toEqual([null, null, null]);
    expect(forks).toBe(1);
  });

  test("asks about at most MAX_OPEN_FILES_PIDS pids in one run", async () => {
    const root = await sessionRoot(SID);
    const asked: string[] = [];
    const run: LsofRunner = async (args) => {
      asked.push(args[2] ?? "");
      return "";
    };
    const src = new McodeTranscriptSource(root, undefined, createOpenFiles(run));
    const processes = Array.from({ length: MAX_OPEN_FILES_PIDS + 20 }, (_, i) => ({ argv: ["mcode"], pid: 100 + i }));
    await src.discoverSession(CWD, { processes });
    expect(asked).toHaveLength(MAX_OPEN_FILES_PIDS);
  });

  test("without pid hints only a recent started session in the index answers", async () => {
    // No index beside this root, and the disk walk is gone: discovery reads a live process or a
    // fresh index row, never the newest folder on disk.
    const root = await sessionRoot(SID);
    const src = new McodeTranscriptSource(root);
    expect(await src.discoverSession("")).toBeNull();
    expect(await src.discoverSession(CWD)).toBeNull();
    const empty = await realpath(await mkdtemp(join(tmpdir(), "collie-mcode-")));
    dirs.push(empty);
    expect(await new McodeTranscriptSource(empty).discoverSession(CWD)).toBeNull();
  });
});

describe("discoverSession pipeline", () => {
  const CWD = "/Users/you/proj";

  /** A sessions root plus its SQLite index, with one row naming `SID` for `CWD`. */
  async function indexedRoot(opts?: { updatedAtMs?: number; sessionId?: string }): Promise<string> {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-mcode-")));
    dirs.push(base);
    const root = join(base, "v2", "sessions");
    await writeSession(root, opts?.sessionId ?? SID);
    await mkdir(join(root, "..", "sqlite"), { recursive: true });
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(root, "..", "sqlite", "runtime-state.sqlite"));
    db.run(
      "CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, workspace_dir TEXT, history_relative_dir TEXT, status TEXT, archived INTEGER, updated_at_ms INTEGER, created_at_ms INTEGER)",
    );
    const at = opts?.updatedAtMs ?? Date.now();
    // SAFETY: test fixture binding of literals this test just built.
    db.run("INSERT INTO local_runtime_sessions VALUES (?, ?, ?, 'started', 0, ?, ?)", [opts?.sessionId ?? SID, CWD, "x", at, at]);
    db.close();
    return root;
  }

  /** A reader whose lsof finds no open files, with a cache of its own. */
  const noFiles = (): OpenFiles => createOpenFiles(async () => "");

  test("parseMcodeArgv reads the start intent off the argv", () => {
    expect(parseMcodeArgv(["mcode"])).toEqual({ kind: "fresh" });
    expect(parseMcodeArgv(["mcode", "-c"])).toEqual({ kind: "continue" });
    expect(parseMcodeArgv(["mcode", "--continue"])).toEqual({ kind: "continue" });
    expect(parseMcodeArgv(["mcode", "--session", "mvs_abc123"])).toEqual({ kind: "resume_id", sessionId: "mvs_abc123" });
    expect(parseMcodeArgv(["mcode", "--session=mvs_abc123"])).toEqual({ kind: "resume_id", sessionId: "mvs_abc123" });
    expect(parseMcodeArgv(["mcode", "--resume", "mvs_abc123"])).toEqual({ kind: "resume_id", sessionId: "mvs_abc123" });
    expect(parseMcodeArgv(["mcode", "--resume=mvs_abc123"])).toEqual({ kind: "resume_id", sessionId: "mvs_abc123" });
    expect(parseMcodeArgv(["mcode", "--session"])).toEqual({ kind: "resume_picker" });
    expect(parseMcodeArgv(["mcode", "--resume"])).toEqual({ kind: "resume_picker" });
    expect(parseMcodeArgv(["mcode", "--session", "-c"])).toEqual({ kind: "resume_picker" });
  });

  test("a fresh mcode process never inherits a past session from the index", async () => {
    // The session row predates the process: a pane opened on the welcome screen must stay blank.
    const past = Date.now() - 45 * 60_000;
    const root = await indexedRoot({ updatedAtMs: past });
    const startMs = past + 60_000; // process started after the session was last touched
    const src = new McodeTranscriptSource(root, async () => startMs, noFiles());
    expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] })).toBeNull();
    // An unreadable start time fails closed too.
    const blind = new McodeTranscriptSource(root, async () => null, noFiles());
    expect(await blind.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] })).toBeNull();
  });

  test("--continue binds to the past session in the index", async () => {
    const past = Date.now() - 45 * 60_000;
    const root = await indexedRoot({ updatedAtMs: past });
    const startMs = past + 60_000;
    const src = new McodeTranscriptSource(root, async () => startMs, noFiles());
    for (const argv of [["mcode", "-c"], ["mcode", "--continue"]]) {
      expect(await src.discoverSession(CWD, { processes: [{ argv, pid: 10 }] })).toEqual({ kind: "id", value: SID });
    }
  });

  test("--session <id> binds to that session directly", async () => {
    const root = await indexedRoot();
    const src = new McodeTranscriptSource(root, async () => null, noFiles());
    expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode", "--session", SID], pid: 10 }] })).toEqual({
      kind: "id",
      value: SID,
    });
    expect(await src.discoverSession(CWD, { processes: [{ argv: [`--resume=${SID}`], pid: 10 }] })).toEqual({
      kind: "id",
      value: SID,
    });
  });

  test("a bare --session (picker) answers null", async () => {
    const root = await indexedRoot();
    const src = new McodeTranscriptSource(root, async () => null, noFiles());
    expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode", "--session"], pid: 10 }] })).toBeNull();
  });

  test("a session updated after the process start stays bound between turns", async () => {
    const startMs = Date.now() - 10 * 60_000;
    // The index row was touched after the process started.
    const root = await indexedRoot({ updatedAtMs: startMs + 30_000 });
    const src = new McodeTranscriptSource(root, async () => startMs, noFiles());
    expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] })).toEqual({ kind: "id", value: SID });
  });

  test("shared-folder hints answer null without process hints", async () => {
    const root = await indexedRoot();
    expect(await new McodeTranscriptSource(root).discoverSession(CWD, { shared: true })).toBeNull();
  });

  test("in a shared folder only what names this pane answers, never the folder's index", async () => {
    // A row touched now, which the same folder answers without `shared`.
    const root = await indexedRoot();
    expect(await new McodeTranscriptSource(root).discoverSession(CWD)).toEqual({ kind: "id", value: SID });
    expect(await new McodeTranscriptSource(root).discoverSession(CWD, { shared: true })).toBeNull();
    const src = new McodeTranscriptSource(root, async () => Date.now() - 60_000, noFiles());
    // A fresh process: the index window since its start is the folder's answer, so it is withheld.
    expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }], shared: true })).toBeNull();
    // --continue means the folder's newest session, shared by every pane in it.
    expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode", "-c"], pid: 10 }], shared: true })).toBeNull();
    // The argv itself naming the session is this pane's own answer, so it stands.
    expect(
      await src.discoverSession(CWD, { processes: [{ argv: ["mcode", "--session", SID], pid: 10 }], shared: true }),
    ).toEqual({ kind: "id", value: SID });
  });

  test("a cleanly closed WAL index is still read, through readSqlite", async () => {
    if (process.platform === "win32") return; // a read-only folder is not enforced there
    const root = await indexedRoot();
    const dbPath = join(root, "..", "sqlite", "runtime-state.sqlite");
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath);
    db.run("pragma journal_mode=wal");
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    // What a clean exit leaves: the header still says WAL, and neither side file is there.
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    const folder = join(root, "..", "sqlite");
    await chmod(folder, 0o555);
    try {
      const src = new McodeTranscriptSource(root);
      expect(await src.discoverSession(CWD)).toEqual({ kind: "id", value: SID });
    } finally {
      await chmod(folder, 0o755);
    }
  });
});

describe("the committed mcode capture", () => {
  // fixtures/mcode/README.md says how MiniMax Code 0.7.7 wrote this session. It is the only place a
  // real envelope, a real canonicalTextRange and a real tool result are exercised together, so it
  // also pins that none of the injected plumbing reaches Chat or History.
  const entries = parseMcodeTranscript(
    readFileSync(join(import.meta.dir, "fixtures", "mcode", "messages.jsonl"), "utf8"),
  );

  test("reads the two turns, with the tool call joined to the result the session recorded", () => {
    expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    expect(entries[0]!.parts).toEqual([
      { kind: "text", text: "list the files in this folder and say what each one holds" },
    ]);
    const tool = entries[1]!.parts[0];
    expect(tool).toMatchObject({ kind: "tool", name: "bash", summary: "ls -la", call: { kind: "execute", command: "ls -la" } });
    if (tool?.kind !== "tool") throw new Error("expected a tool part");
    expect(tool.result?.text).toContain("README.md");
    expect(tool.result?.text).toContain("notes.txt");
    expect(entries[4]!.parts).toEqual([
      { kind: "text", text: "The folder holds two files: README.md, one line about the folder, and notes.txt." },
    ]);
  });

  test("the plumbing mcode injects into a user row never reaches a transcript entry", () => {
    const text = JSON.stringify(entries);
    for (const plumbing of ["system-reminder", "agent-context", "media-output-reminder", "mcode-tools-master"]) {
      expect(text).not.toContain(plumbing);
    }
    expect(entries[3]!.parts).toEqual([{ kind: "text", text: "thanks - what is in notes.txt?" }]);
  });
});

describe("mcodeJournal", () => {
  test("registers under agent 'mcode' with parse, reducer and discover wired", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "collie-mcode-")));
    dirs.push(root);
    const dir = join(root, "2026", "11", "03", `12-00-00-000-session_${Buffer.from(SID).toString("base64url")}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "messages.jsonl"), `${userRow}\n`);
    const adapter = mcodeJournal(root);
    expect(adapter.agent).toBe("mcode");
    expect(adapter.parse(assistantRow)).toEqual(parseMcodeTranscript(assistantRow));
    expect(adapter.discover).toBeDefined();
    const live = await adapter.source.readSince(
      (await adapter.source.resolve({ kind: "id", value: SID }))!,
      "",
    );
    expect(live.reset).toBe(true);
    expect(live.lines).toEqual([userRow]);
  });
});
