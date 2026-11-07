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
  parseMcodeTranscript,
} from "./mcode.ts";

const SID = "mvs_eeeea151d98844409cc358330f9e61bd";
const OTHER = "mvs_abcdefabcdefabcdefabcdefabcdefab";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

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
