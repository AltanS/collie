import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../json.ts";
import {
  ClaudeTranscriptSource,
  createClaudeReducer,
  isAgentId,
  parseClaudeTranscript,
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
