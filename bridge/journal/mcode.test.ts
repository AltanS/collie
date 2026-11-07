import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

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
function row(message: { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; timestamp?: number }, messageId = "msg-1"): string {
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
      "CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, workspace_dir TEXT, history_relative_dir TEXT, status TEXT, archived INTEGER, updated_at_ms INTEGER)",
    );
    // SAFETY: test fixture binding of literals this test just built.
    db.run("INSERT INTO local_runtime_sessions VALUES (?, ?, ?, 'idle', 0, 1)", [SID, CWD, "x"]);
    db.close();

    const src = new McodeTranscriptSource(root);
    expect(await src.discoverSession(CWD)).toEqual({ kind: "id", value: SID });
  });

  test("falls back to the newest messages.jsonl when the index says nothing", async () => {
    const root = await sessionRoot(SID);
    await writeSession(root, OTHER, [userRow], "11-00-00-000");
    const src = new McodeTranscriptSource(root);
    // No index beside this root: the disk walk answers the newest, and the test root holds one
    // session folder, so there is exactly one candidate and no ambiguity to refuse.
    const ref = await src.discoverSession(join(root, "anything-else"));
    expect(ref).toEqual({ kind: "id", value: SID });
    expect(await src.resolve(ref!)).not.toBeNull();
  });

  test("answers null with no hints, an empty cwd and an empty root", async () => {
    const root = await sessionRoot();
    const src = new McodeTranscriptSource(root);
    expect(await src.discoverSession("")).toBeNull();
    expect(await src.discoverSession(CWD)).toEqual({ kind: "id", value: SID });
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
