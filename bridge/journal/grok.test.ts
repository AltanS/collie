import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  extractUserQuery,
  GrokTranscriptSource,
  isGrokSessionId,
  parseGrokTranscript,
} from "./grok.ts";

const SID = "01a022f2-4cc2-7530-9af6-49009c6a024e";
const OTHER = "ffffffff-ffff-ffff-ffff-ffffffffffff";

describe("isGrokSessionId", () => {
  test("accepts the uuid Herdr reports", () => {
    expect(isGrokSessionId(SID)).toBe(true);
    expect(isGrokSessionId("bcb07539-aaaa-4bbb-8ccc-ddddeeeeffff")).toBe(true);
  });

  test("rejects anything that is not a uuid before it can touch the filesystem", () => {
    expect(isGrokSessionId("../etc/passwd")).toBe(false);
    expect(isGrokSessionId("chat_history.jsonl")).toBe(false);
    expect(isGrokSessionId("")).toBe(false);
  });
});

describe("extractUserQuery", () => {
  test("pulls the inner speech out of the envelope", () => {
    expect(extractUserQuery("<user_query>\nhi there\n</user_query>")).toBe("hi there");
  });

  test("returns null when the tag is absent — user_info dumps are not speech", () => {
    expect(extractUserQuery("<user_info>\nOS Version: macos\n</user_info>")).toBeNull();
  });
});

describe("parseGrokTranscript", () => {
  test("keeps a prompt_index user_query and drops system / synthetic users", () => {
    const log = [
      JSON.stringify({ type: "system", content: "You are Grok" }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_info>\nsecret\n</user_info>" }],
      }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<system-reminder>\nskills\n</system-reminder>" }],
        synthetic_reason: "system_reminder",
      }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_query>\nwhat changed?\n</user_query>" }],
        prompt_index: 0,
      }),
    ].join("\n");
    const entries = parseGrokTranscript(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.role).toBe("user");
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "what changed?" }]);
  });

  test("folds reasoning summary onto the next assistant and never emits encrypted_content", () => {
    const log = [
      JSON.stringify({
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Look up the harness." }],
        encrypted_content: "SECRETBLOB",
      }),
      JSON.stringify({
        type: "assistant",
        content: "Pi cannot use a Claude subscription today.",
        tool_calls: [{ id: "call-1", name: "read_file", arguments: '{"target_file":"SKILL.md"}' }],
      }),
      JSON.stringify({
        type: "tool_result",
        tool_call_id: "call-1",
        content: "---\nname: find-docs\n",
      }),
    ].join("\n");
    const entries = parseGrokTranscript(log);
    expect(entries).toHaveLength(1);
    const parts = entries[0]!.parts;
    expect(parts[0]).toEqual({ kind: "thinking", text: "Look up the harness." });
    expect(parts[1]).toEqual({
      kind: "text",
      text: "Pi cannot use a Claude subscription today.",
    });
    expect(parts[2]).toMatchObject({
      kind: "tool",
      name: "read_file",
      result: { text: "---\nname: find-docs\n" },
    });
    expect(JSON.stringify(entries)).not.toContain("SECRETBLOB");
  });

  test("skips a truncated trailing line rather than throwing", () => {
    const log = `${JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>ok</user_query>" }],
      prompt_index: 1,
    })}\n{"type":"assistant","content":`;
    expect(parseGrokTranscript(log)).toHaveLength(1);
  });

  test("a tool call carries grok's own call id and a structured call", () => {
    const log = JSON.stringify({
      type: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", name: "bash", arguments: '{"command":"bun test","description":"the suite"}' },
      ],
    });
    const [entry] = parseGrokTranscript(log);
    expect(entry!.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      summary: "bun test",
      id: "call-1",
      call: { kind: "execute", command: "bun test", description: "the suite" },
    });
  });

  test("a result folds the output text alone — no exit code, no refusal flag", () => {
    const log = [
      JSON.stringify({
        type: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "bash", arguments: '{"command":"false"}' }],
      }),
      JSON.stringify({ type: "tool_result", tool_call_id: "c1", content: "exit status 1" }),
    ].join("\n");
    const [entry] = parseGrokTranscript(log);
    // The whole part, not a subset: `toEqual` is what pins the ABSENCE of an `exitCode` on the call
    // and of `isError`/`denied` on the result. Grok's row carries none of the three.
    expect(entry!.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      summary: "false",
      id: "c1",
      call: { kind: "execute", command: "false" },
      result: { text: "exit status 1" },
    });
  });

  test("a read is classified, and a tool nobody knows degrades to `other`", () => {
    const log = [
      JSON.stringify({
        type: "assistant",
        content: "",
        tool_calls: [
          { id: "r1", name: "read_file", arguments: '{"path":"bridge/journal/grok.ts"}' },
          { id: "x1", name: "todo_write", arguments: '{"merge":false,"todos":"write the note"}' },
        ],
      }),
    ].join("\n");
    const [entry] = parseGrokTranscript(log);
    expect(entry!.parts[0]).toMatchObject({
      call: { kind: "read", path: "bridge/journal/grok.ts" },
    });
    expect(entry!.parts[1]).toMatchObject({
      call: { kind: "other", name: "todo_write", summary: "write the note" },
    });
  });

  test("backend_tool_call becomes a tool part named by tool_type", () => {
    const log = JSON.stringify({
      type: "backend_tool_call",
      kind: { tool_type: "web_search", action: { type: "search", query: "pi coding harness" } },
    });
    const [entry] = parseGrokTranscript(log);
    const part = entry!.parts[0]!;
    expect(part).toMatchObject({ kind: "tool", name: "web_search" });
    expect(part.kind === "tool" ? part.summary : "").toContain("pi coding harness");
    // A backend tool's `action` IS its input, so the same classifier reads it — and the row has no
    // call id, so the part carries none.
    expect(part).toEqual({
      kind: "tool",
      name: "web_search",
      summary: "pi coding harness",
      call: { kind: "search", query: "pi coding harness", where: "web" },
    });
  });
});

describe("GrokTranscriptSource", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function sessionRoot(id = SID): Promise<{ root: string; log: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "collie-grok-")));
    dirs.push(root);
    const cwdDir = join(root, encodeURIComponent("/Users/you/proj"));
    const sess = join(cwdDir, id);
    await mkdir(sess, { recursive: true });
    const log = join(sess, "chat_history.jsonl");
    await writeFile(log, "{}\n");
    return { root, log };
  }

  test("resolves an id to chat_history.jsonl under the urlencoded cwd dir", async () => {
    const { root, log } = await sessionRoot();
    expect(await new GrokTranscriptSource(root).resolve({ kind: "id", value: SID })).toBe(log);
  });

  test("a path-kind ref is refused — grok reports ids", async () => {
    const { root, log } = await sessionRoot();
    expect(await new GrokTranscriptSource(root).resolve({ kind: "path", value: log })).toBeNull();
  });

  test("a missing session is null, not a throw", async () => {
    const { root } = await sessionRoot();
    expect(await new GrokTranscriptSource(root).resolve({ kind: "id", value: OTHER })).toBeNull();
  });

  test("an invalid id never touches the filesystem", async () => {
    const { root } = await sessionRoot();
    expect(
      await new GrokTranscriptSource(root).resolve({ kind: "id", value: "../etc/passwd" }),
    ).toBeNull();
  });

  // The cache memoises the scan, not the containment verdict. exists() on a cached path would
  // follow a symlink that replaced the file after the first resolve and serve whatever it pointed
  // at — which is the whole case containedRealpath exists to refuse.
  test("a cached path replaced by a symlink out of the root is refused", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-grok-")));
    dirs.push(base);
    const root = join(base, "sessions");
    const sess = join(root, encodeURIComponent("/Users/you/proj"), SID);
    await mkdir(sess, { recursive: true });
    const log = join(sess, "chat_history.jsonl");
    await writeFile(log, "{}\n");

    const src = new GrokTranscriptSource(root);
    expect(await src.resolve({ kind: "id", value: SID })).toBe(log);

    const outside = join(base, "outside.jsonl");
    await writeFile(outside, '{"type":"system","content":"secrets"}\n');
    await rm(log);
    await symlink(outside, log);

    expect(await src.resolve({ kind: "id", value: SID })).toBeNull();
  });
});

// Herdr keeps the FIRST id a grok pane reported: `/resume` inside a running grok reports the resumed
// session with source `load`, and Herdr 0.9 drops it. Grok's own active_sessions.json names the
// session the process really holds, so reconcile swaps the stale id for it when the match is unique.
describe("GrokTranscriptSource.reconcile", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const CWD = "/Users/you/proj";
  const STALE = "00000000-0000-7000-8000-00000000a001";
  const RESUMED = "00000000-0000-7000-8000-00000000b002";
  const alive = (): boolean => true;

  async function grokHome(active: string | null): Promise<string> {
    const base = await realpath(await mkdtemp(join(tmpdir(), "collie-grok-")));
    dirs.push(base);
    await mkdir(join(base, "sessions"), { recursive: true });
    if (active !== null) await writeFile(join(base, "active_sessions.json"), active);
    return join(base, "sessions");
  }

  const row = (sessionId: string, cwd = CWD, pid = 4242) => ({
    session_id: sessionId,
    pid,
    cwd,
    opened_at: "2026-01-01T00:00:00.000000Z",
  });

  test("a stale reported id gives way to the one live session in the pane's cwd", async () => {
    const root = await grokHome(JSON.stringify([row(RESUMED)]));
    const src = new GrokTranscriptSource(root, alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: RESUMED });
  });

  test("a reported id grok still lists is kept", async () => {
    const root = await grokHome(JSON.stringify([row(STALE), row(RESUMED, "/elsewhere")]));
    const src = new GrokTranscriptSource(root, alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
  });

  test("two live sessions in the same cwd are ambiguous, so the reported id is kept", async () => {
    const root = await grokHome(JSON.stringify([row(RESUMED), row(OTHER, CWD, 4343)]));
    const src = new GrokTranscriptSource(root, alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
  });

  test("a session in another cwd is never borrowed", async () => {
    const root = await grokHome(JSON.stringify([row(RESUMED, "/elsewhere")]));
    const src = new GrokTranscriptSource(root, alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
  });

  test("a row whose process is gone is ignored", async () => {
    const root = await grokHome(JSON.stringify([row(RESUMED)]));
    const src = new GrokTranscriptSource(root, () => false);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
  });

  test("no active_sessions.json, or an unreadable one, keeps the reported id quietly", async () => {
    for (const active of [null, "not json", '{"session_id":"x"}', JSON.stringify([{ pid: "1" }])]) {
      const root = await grokHome(active);
      const src = new GrokTranscriptSource(root, alive);
      expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
    }
  });

  test("a row naming something other than a session uuid is never handed on", async () => {
    const root = await grokHome(JSON.stringify([row("../../etc")]));
    const src = new GrokTranscriptSource(root, alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
  });

  // A unique candidate proves nothing when part of the list could not be read: the unread part may
  // hold the reported id, and the candidate may belong to another pane in the same folder.
  test("a malformed row beside a valid candidate keeps the reported id", async () => {
    const root = await grokHome(JSON.stringify([{ ...row(STALE), pid: "4242" }, row(RESUMED, CWD, 4343)]));
    const src = new GrokTranscriptSource(root, alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
  });

  test("an unreadable list in one root keeps the reported id although another root has a candidate", async () => {
    for (const unreadable of ["not json", '{"session_id":"x"}']) {
      const broken = await grokHome(unreadable);
      const listed = await grokHome(JSON.stringify([row(RESUMED)]));
      const src = new GrokTranscriptSource([broken, listed], alive);
      expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
    }
  });

  test("a list that cannot be opened keeps the reported id although another root has a candidate", async () => {
    const broken = await grokHome(null);
    await mkdir(join(broken, "..", "active_sessions.json"));
    const listed = await grokHome(JSON.stringify([row(RESUMED)]));
    const src = new GrokTranscriptSource([broken, listed], alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
  });

  // Only a list known to be absent is skipped. Here stat itself fails (no search permission on the
  // folder), so the list may well hold the reported id. Where permissions do not bite (Windows, root)
  // the list reads and still names STALE, so the case passes there without proving anything.
  test("a list whose presence cannot be checked keeps the reported id although another root has a candidate", async () => {
    const hidden = await grokHome(JSON.stringify([row(STALE)]));
    const listed = await grokHome(JSON.stringify([row(RESUMED)]));
    const src = new GrokTranscriptSource([hidden, listed], alive);
    const home = join(hidden, "..");
    await chmod(home, 0o000);
    try {
      expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
    } finally {
      await chmod(home, 0o755);
    }
  });

  test("a list over 1 MiB is not read, so the reported id is kept", async () => {
    const padding = " ".repeat(1024 * 1024 + 1);
    const root = await grokHome(JSON.stringify([row(RESUMED)]) + padding);
    const src = new GrokTranscriptSource(root, alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: STALE });
  });

  test("a root with no list at all does not stop the swap from another root", async () => {
    const empty = await grokHome(null);
    const listed = await grokHome(JSON.stringify([row(RESUMED)]));
    const src = new GrokTranscriptSource([empty, listed], alive);
    expect(await src.reconcile({ kind: "id", value: STALE }, CWD)).toEqual({ kind: "id", value: RESUMED });
  });
});
