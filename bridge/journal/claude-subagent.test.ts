import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../json.ts";
import {
  claudeJournal,
  ClaudeTranscriptSource,
  createClaudeReducer,
  isAgentId,
  parseClaudeTranscript,
  readClaudeSubagent,
} from "./claude.ts";

const SESSION_ID = "fa52de65-e7ac-4f05-b746-cfe1eb44deb7";
const AGENT_ID = "af52a45b4a25847ac";

const assistantToolUse = (uuid: string, toolUseId: string, input: JsonObject) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: "2026-10-18T01:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Agent", input }],
    },
  });

const userToolResult = (
  uuid: string,
  toolUseId: string,
  text: string,
  toolUseResult?: JsonObject,
) => {
  const row: JsonObject = {
    type: "user",
    uuid,
    timestamp: "2026-10-18T01:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }],
    },
  };
  if (toolUseResult !== undefined) row.toolUseResult = toolUseResult;
  return JSON.stringify(row);
};

const userNotification = (uuid: string, xml: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-10-18T01:00:15.000Z",
    message: { role: "user", content: xml },
  });

describe("isAgentId", () => {
  test("accepts Claude subagent hex ids and rejects traversal or internal side files", () => {
    expect(isAgentId("a639123")).toBe(true);
    expect(isAgentId("af52a45b4a25847ac")).toBe(true);
    expect(isAgentId("acompact-ca8f91")).toBe(false);
    expect(isAgentId("aside_question-4ddba0f33846e65d")).toBe(false);
    expect(isAgentId("../secret")).toBe(false);
    expect(isAgentId("")).toBe(false);
  });
});

describe("async_launched subagent lifecycle in createClaudeReducer", () => {
  test("keeps an async_launched Agent call running without internal launch text until task-notification arrives", () => {
    const reducer = createClaudeReducer();

    const r1 = reducer.push(
      assistantToolUse("turn-1", "toolu_sub1", {
        subagent_type: "Explore",
        description: "Check CI failure",
        prompt: "Inspect solo-baseline.test.ts",
      }),
    );
    expect(r1.added).toHaveLength(1);
    const part = r1.added[0]!.parts[0]!;
    expect(part.kind).toBe("tool");
    if (part.kind !== "tool") throw new Error("expected tool part");
    expect(part.result).toBeUndefined();

    const r2 = reducer.push(
      userToolResult(
        "turn-2",
        "toolu_sub1",
        "Async agent launched successfully. (This tool result is internal metadata)",
        {
          isAsync: true,
          status: "async_launched",
          agentId: AGENT_ID,
        },
      ),
    );
    expect(r2.added).toHaveLength(0);
    expect([...r2.changed]).toEqual(["turn-1"]);
    expect(part.call).toEqual({
      kind: "task",
      agent: "Explore",
      summary: "Check CI failure",
      agentId: AGENT_ID,
    });
    expect(part.result).toBeUndefined();

    const r3 = reducer.push(
      userNotification(
        "turn-3",
        [
          "<task-notification>",
          `<task-id>${AGENT_ID}</task-id>`,
          "<tool-use-id>toolu_sub1</tool-use-id>",
          "<status>completed</status>",
          '<summary>Agent "Check CI failure" finished</summary>',
          "<result>Missing route in solo-baseline.test.ts:48.</result>",
          "</task-notification>",
        ].join("\n"),
      ),
    );
    expect(r3.added).toHaveLength(0);
    expect([...r3.changed]).toEqual(["turn-1"]);
    expect(part.result).toEqual({ text: "Missing route in solo-baseline.test.ts:48." });
  });

  test("marks the card as failed when task-notification reports a killed or failed status", () => {
    const entries = parseClaudeTranscript(
      [
        assistantToolUse("turn-1", "toolu_sub2", {
          subagent_type: "Plan",
          description: "Verify bundle",
        }),
        userToolResult("turn-2", "toolu_sub2", "Async agent launched successfully.", {
          isAsync: true,
          status: "async_launched",
          agentId: AGENT_ID,
        }),
        userNotification(
          "turn-3",
          [
            "<task-notification>",
            `<task-id>${AGENT_ID}</task-id>`,
            "<tool-use-id>toolu_sub2</tool-use-id>",
            "<status>killed</status>",
            '<summary>Agent "Verify bundle" was stopped</summary>',
            "</task-notification>",
          ].join("\n"),
        ),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("expected tool part");
    expect(part.result).toEqual({
      text: 'Agent "Verify bundle" was stopped',
      isError: true,
    });
  });

  test("folds a mid-turn task-notification delivered via queue-operation and queued_command attachment without a user row", () => {
    const notification = [
      "<task-notification>",
      `<task-id>${AGENT_ID}</task-id>`,
      "<tool-use-id>toolu_mid</tool-use-id>",
      "<status>completed</status>",
      '<summary>Agent "Demo subagent" finished</summary>',
      "<result>Mid-turn subagent report.</result>",
      "</task-notification>",
    ].join("\n");
    const entries = parseClaudeTranscript(
      [
        assistantToolUse("turn-1", "toolu_mid", {
          subagent_type: "general-purpose",
          description: "Demo subagent",
        }),
        userToolResult("turn-2", "toolu_mid", `Async agent launched.\nagentId: ${AGENT_ID}`, {
          isAsync: true,
          status: "async_launched",
          agentId: AGENT_ID,
        }),
        JSON.stringify({
          type: "queue-operation",
          operation: "enqueue",
          content: notification,
        }),
        JSON.stringify({
          type: "queue-operation",
          operation: "remove",
          reason: "absorbed_mid_turn",
          content: notification,
        }),
        JSON.stringify({
          type: "attachment",
          uuid: "att-1",
          attachment: {
            type: "queued_command",
            prompt: notification,
            commandMode: "task-notification",
            origin: { kind: "task-notification", producer: "session-task" },
          },
        }),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("expected tool part");
    expect(part.result).toEqual({
      text: "Mid-turn subagent report.",
    });
  });

  test("preserves synchronous completed Agent tool results while attaching agentId", () => {
    const entries = parseClaudeTranscript(
      [
        assistantToolUse("turn-1", "toolu_sync", {
          subagent_type: "Explore",
          description: "Sync agent",
        }),
        userToolResult("turn-2", "toolu_sync", "Synchronous final report.", {
          status: "completed",
          agentId: AGENT_ID,
        }),
      ].join("\n"),
    );
    const part = entries[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("expected tool part");
    expect(part.call).toEqual({
      kind: "task",
      agent: "Explore",
      summary: "Sync agent",
      agentId: AGENT_ID,
    });
    expect(part.result).toEqual({ text: "Synchronous final report." });
  });
});

describe("ClaudeTranscriptSource.resolveSubagent", () => {
  test("resolves a subagent jsonl inside the parent session folder and refuses symlinks outside the root", async () => {
    const base = join(tmpdir(), `collie-subagent-test-${Date.now()}`);
    const root = join(base, "projects");
    const outside = join(base, "outside.jsonl");
    const proj = join(root, "-Users-test-repo");
    const subDir = join(proj, SESSION_ID, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(proj, `${SESSION_ID}.jsonl`), '{"uuid":"u1","type":"user"}\n');
    const subFile = join(subDir, `agent-${AGENT_ID}.jsonl`);
    await writeFile(subFile, '{"uuid":"s1","type":"user","isSidechain":true}\n');
    await writeFile(outside, '{"uuid":"evil"}\n');
    const escapedId = "a1111111111111111";
    await symlink(outside, join(subDir, `agent-${escapedId}.jsonl`));

    try {
      const source = new ClaudeTranscriptSource(root);
      const resolved = await source.resolveSubagent({ kind: "id", value: SESSION_ID }, AGENT_ID);
      expect(resolved).not.toBeNull();
      expect(resolved?.endsWith(`agent-${AGENT_ID}.jsonl`)).toBe(true);

      expect(await source.resolveSubagent({ kind: "id", value: SESSION_ID }, "../etc")).toBeNull();
      expect(await source.resolveSubagent({ kind: "id", value: SESSION_ID }, escapedId)).toBeNull();

      const siblingSession = join(proj, "99999999-9999-4999-8999-999999999999.jsonl");
      await writeFile(siblingSession, "{\"uuid\":\"sibling\"}\n");
      const siblingEscapeId = "a2222222222222222";
      await symlink(siblingSession, join(subDir, `agent-${siblingEscapeId}.jsonl`));
      expect(await source.resolveSubagent({ kind: "id", value: SESSION_ID }, siblingEscapeId)).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── Containment, adversarially (PR 504 review) ──────────────────────────────────────────────────
//
// The route's only client-chosen input is `agentId`; the session id comes from the pane's own ref.
// Each case below is a way a path could leave the session's own `subagents/` folder, and each must
// answer null, which the route turns into `available: false`, the same answer as "no such file".
describe("ClaudeTranscriptSource.resolveSubagent — containment", () => {
  const SIBLING_ID = "11111111-2222-4333-8444-555555555555";
  const ref = { kind: "id", value: SESSION_ID } as const;

  async function lab(): Promise<{ base: string; root: string; proj: string; other: string; subDir: string }> {
    const base = join(tmpdir(), `collie-subagent-contain-${process.pid}-${Math.random().toString(16).slice(2)}`);
    const root = join(base, "projects");
    const proj = join(root, "-Users-test-repo");
    const other = join(root, "-Users-test-other");
    const subDir = join(proj, SESSION_ID, "subagents");
    await mkdir(subDir, { recursive: true });
    await mkdir(join(proj, SIBLING_ID, "subagents"), { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(proj, `${SESSION_ID}.jsonl`), '{"uuid":"u1","type":"user"}\n');
    await writeFile(join(proj, `${SIBLING_ID}.jsonl`), '{"uuid":"u2","type":"user"}\n');
    return { base, root, proj, other, subDir };
  }

  test("an agentId carrying a slash, a dot-dot, a backslash, a NUL or an encoded separator never resolves", async () => {
    const { base, root, subDir } = await lab();
    try {
      // A real file the traversal would land on if the id were joined unchecked.
      await writeFile(join(subDir, "agent-a1234567.jsonl"), '{"uuid":"s1"}\n');
      const source = new ClaudeTranscriptSource(root);
      for (const bad of [
        "a1234567/../a1234567",
        "../subagents/agent-a1234567",
        "a1234567/",
        "/etc/passwd",
        "a1234567\\..",
        "a1234567\u0000",
        "a1234567%2F..",
        "..",
        "a1234567.jsonl",
        "A123456Z",
        `a${"0".repeat(33)}`,
      ]) {
        expect(isAgentId(bad)).toBe(false);
        expect(await source.resolveSubagent(ref, bad)).toBeNull();
      }
      expect(await source.resolveSubagent(ref, "a1234567")).not.toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a symlinked agent file pointing at a sibling session's subagent log is refused", async () => {
    const { base, root, proj, subDir } = await lab();
    try {
      const siblingLog = join(proj, SIBLING_ID, "subagents", "agent-abbbbbbb.jsonl");
      await writeFile(siblingLog, '{"uuid":"sibling-sub"}\n');
      await symlink(siblingLog, join(subDir, "agent-abbbbbbb.jsonl"));
      expect(await new ClaudeTranscriptSource(root).resolveSubagent(ref, "abbbbbbb")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a symlinked agent file pointing into another project, or outside the root, is refused", async () => {
    const { base, root, other, subDir } = await lab();
    try {
      const otherProject = join(other, "notes.jsonl");
      await writeFile(otherProject, '{"uuid":"other-project"}\n');
      await symlink(otherProject, join(subDir, "agent-acccccc1.jsonl"));
      const outside = join(base, "outside.jsonl");
      await writeFile(outside, '{"uuid":"outside"}\n');
      await symlink(outside, join(subDir, "agent-acccccc2.jsonl"));
      const source = new ClaudeTranscriptSource(root);
      expect(await source.resolveSubagent(ref, "acccccc1")).toBeNull();
      expect(await source.resolveSubagent(ref, "acccccc2")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a symlinked subagents folder pointing at a sibling session's folder is refused", async () => {
    const { base, root, proj } = await lab();
    try {
      await rm(join(proj, SESSION_ID, "subagents"), { recursive: true });
      await writeFile(join(proj, SIBLING_ID, "subagents", "agent-adddddd1.jsonl"), '{"uuid":"sibling-sub"}\n');
      await symlink(join(proj, SIBLING_ID, "subagents"), join(proj, SESSION_ID, "subagents"));
      expect(await new ClaudeTranscriptSource(root).resolveSubagent(ref, "adddddd1")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a session folder that is itself a symlink out of the root is refused", async () => {
    const { base, root, proj } = await lab();
    try {
      const away = join(base, "away");
      await mkdir(join(away, "subagents"), { recursive: true });
      await writeFile(join(away, "subagents", "agent-aeeeeee1.jsonl"), '{"uuid":"away"}\n');
      await rm(join(proj, SESSION_ID), { recursive: true });
      await symlink(away, join(proj, SESSION_ID));
      expect(await new ClaudeTranscriptSource(root).resolveSubagent(ref, "aeeeeee1")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a session id reads the subagent folder beside its OWN log, never another project's", async () => {
    const { base, root, other } = await lab();
    try {
      // The other project holds a folder named after this session with a subagent log in it, but the
      // session's log lives in the first project: the read must not wander across.
      await mkdir(join(other, SESSION_ID, "subagents"), { recursive: true });
      await writeFile(join(other, SESSION_ID, "subagents", "agent-afffffff.jsonl"), '{"uuid":"wrong"}\n');
      expect(await new ClaudeTranscriptSource(root).resolveSubagent(ref, "afffffff")).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("readClaudeSubagent reports a small log as complete", async () => {
    const { base, root, subDir } = await lab();
    try {
      await writeFile(
        join(subDir, "agent-a7777777.jsonl"),
        `${JSON.stringify({ type: "user", uuid: "s1", isSidechain: true, message: { role: "user", content: "hi" } })}\n`,
      );
      const adapter = claudeJournal(root);
      const read = await readClaudeSubagent(adapter, ref, "a7777777");
      expect(read).not.toBeNull();
      expect(read!.fileTruncated).toBe(false);
      expect(read!.entries.length).toBe(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
