import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as cp from "node:child_process";

import {
  createMcodeReducer,
  isMcodeSessionId,
  McodeTranscriptSource,
  mcodeJournal,
  parseMcodeArgv,
  parseMcodeTranscript,
} from "./mcode.ts";

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
    expect(resolved).toContain("2026/11/03");
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
    const lsof = spyOn(cp, "execFile").mockImplementation(
      // SAFETY: test mock casting — the mock only answers the one lsof call discovery makes.
      ((_file: string, _args: readonly string[], _opts: { timeout: number }, cb: (e: Error | null, r: { stdout: string }) => void) => {
        const log = join(root, "2026", "11", "03", `12-00-00-000-session_${Buffer.from(SID).toString("base64url")}`, "messages.jsonl");
        const observability = `/Users/x/.minimax/v2/observability/logs/sessions/${OTHER}/events.jsonl`;
        cb(null, { stdout: ["p10", "f3", `n${log}`, `n${observability}`].join("\n") });
        // SAFETY: test mock casting
        return undefined as never;
      }) as never,
    );
    try {
      const src = new McodeTranscriptSource(root);
      const ref = await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] });
      expect(ref).toEqual({ kind: "id", value: SID });
      expect(await src.resolve(ref!)).not.toBeNull();
    } finally {
      lsof.mockRestore();
    }
  });

  test("a process with no session file open means no session — never a past one", async () => {
    const root = await sessionRoot(SID);
    const lsof = spyOn(cp, "execFile").mockImplementation(
      // SAFETY: test mock casting
      ((_file: string, _args: readonly string[], _opts: { timeout: number }, cb: (e: Error | null, r: { stdout: string }) => void) => {
        cb(null, { stdout: ["p10", "f1", "n/etc/hosts"].join("\n") });
        // SAFETY: test mock casting
        return undefined as never;
      }) as never,
    );
    try {
      const src = new McodeTranscriptSource(root);
      expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] })).toBeNull();
      // No pid at all falls to the index, which holds only a stale row: still null.
      expect(await src.discoverSession(CWD)).toBeNull();
    } finally {
      lsof.mockRestore();
    }
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

  /** Silence lsof (no open files) for the test's duration. */
  async function withLsofEmpty(run: () => Promise<void>): Promise<void> {
    const lsof = spyOn(cp, "execFile").mockImplementation(
      // SAFETY: test mock casting
      ((_f: string, _a: readonly string[], _o: { timeout: number }, cb: (e: Error | null, r: { stdout: string }) => void) => {
        cb(null, { stdout: "" });
        // SAFETY: test mock casting
        return undefined as never;
      }) as never,
    );
    try {
      await run();
    } finally {
      lsof.mockRestore();
    }
  }

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
    await withLsofEmpty(async () => {
      const src = new McodeTranscriptSource(root, async () => startMs);
      expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] })).toBeNull();
      // An unreadable start time fails closed too.
      const blind = new McodeTranscriptSource(root, async () => null);
      expect(await blind.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] })).toBeNull();
    });
  });

  test("--continue binds to the past session in the index", async () => {
    const past = Date.now() - 45 * 60_000;
    const root = await indexedRoot({ updatedAtMs: past });
    const startMs = past + 60_000;
    await withLsofEmpty(async () => {
      const src = new McodeTranscriptSource(root, async () => startMs);
      for (const argv of [["mcode", "-c"], ["mcode", "--continue"]]) {
        expect(await src.discoverSession(CWD, { processes: [{ argv, pid: 10 }] })).toEqual({ kind: "id", value: SID });
      }
    });
  });

  test("--session <id> binds to that session directly", async () => {
    const root = await indexedRoot();
    await withLsofEmpty(async () => {
      const src = new McodeTranscriptSource(root, async () => null);
      expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode", "--session", SID], pid: 10 }] })).toEqual({
        kind: "id",
        value: SID,
      });
      expect(await src.discoverSession(CWD, { processes: [{ argv: [`--resume=${SID}`], pid: 10 }] })).toEqual({
        kind: "id",
        value: SID,
      });
    });
  });

  test("a bare --session (picker) answers null", async () => {
    const root = await indexedRoot();
    await withLsofEmpty(async () => {
      const src = new McodeTranscriptSource(root, async () => null);
      expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode", "--session"], pid: 10 }] })).toBeNull();
    });
  });

  test("a session updated after the process start stays bound between turns", async () => {
    const startMs = Date.now() - 10 * 60_000;
    // The index row was touched after the process started.
    const root = await indexedRoot({ updatedAtMs: startMs + 30_000 });
    await withLsofEmpty(async () => {
      const src = new McodeTranscriptSource(root, async () => startMs);
      expect(await src.discoverSession(CWD, { processes: [{ argv: ["mcode"], pid: 10 }] })).toEqual({ kind: "id", value: SID });
    });
  });

  test("shared-folder hints answer null without process hints", async () => {
    const root = await indexedRoot();
    expect(await new McodeTranscriptSource(root).discoverSession(CWD, { shared: true })).toBeNull();
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
