import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

  test("backend_tool_call becomes a tool part named by tool_type", () => {
    const log = JSON.stringify({
      type: "backend_tool_call",
      kind: { tool_type: "web_search", action: { type: "search", query: "pi coding harness" } },
    });
    const [entry] = parseGrokTranscript(log);
    expect(entry!.parts[0]).toMatchObject({ kind: "tool", name: "web_search" });
    expect((entry!.parts[0] as { summary: string }).summary).toContain("pi coding harness");
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
