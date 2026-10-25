import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maskSubagentList } from "./answer-mask.ts";
import { claudeJournal } from "./journal/claude.ts";
import { LiveWindows, TICK_FLOOR_MS } from "./journal/live.ts";
import { piJournal } from "./journal/pi.ts";
import { TranscriptStore } from "./journal/store.ts";
import type { ToolCall } from "./journal/tool-call.ts";
import type { JournalAdapter, TranscriptEntry, TranscriptPart } from "./journal/types.ts";
import type { JsonValue } from "./json.ts";
import { HELD_FRESH_MS, JournalSubagents, ongoingSubagents } from "./subagents-journal.ts";
import { MAX_SUBAGENTS, QUIET_RUNNING_MS } from "./subagents.ts";
import type { AgentView } from "./types.ts";

// Oh My Pi 18.6.1's shape (a real session read on 2026-10-25; key names exact, words the lab's).
const SID = "01a17262-0000-7000-8000-00000000c011";
const TS = "2026-10-25T09:30:00.000Z";

type Row = Record<string, JsonValue>;
const line = (id: string, parentId: string | null, body: Row) => JSON.stringify({ id, parentId, timestamp: TS, ...body });

function ompLog() {
  const rows: string[] = [JSON.stringify({ type: "session", version: 3, id: SID, timestamp: TS, cwd: "/lab" })];
  let parent: string | null = null;
  const add = (id: string, body: Row) => {
    rows.push(line(id, parent, body));
    parent = id;
  };
  return {
    spawn(id: string, callId: string, intent: string, name: string, jobId = name) {
      add(id, {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "task", arguments: { i: intent, context: "The lab.", tasks: [{ task: "count the files in the lab", name }] } }] },
      });
      add(`${id}r`, {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "task",
          content: [{ type: "text", text: `Spawned agent \`${name}\` (job \`${jobId}\`).` }],
          details: {
            projectAgentsDir: null,
            results: [],
            totalDurationMs: 1,
            progress: [{ index: 0, id: name, agent: "task", agentSource: "bundled", status: "pending", task: "count the files in the lab", assignment: "count the files in the lab", recentTools: [], recentOutput: [], toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0 }],
            async: { state: "running", jobId, type: "task" },
          },
        },
      });
    },
    failedSpawn(id: string, callId: string) {
      add(id, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "task", arguments: { i: "Count nothing", context: "x" } }] } });
      add(`${id}r`, {
        type: "message",
        message: { role: "toolResult", toolCallId: callId, toolName: "task", isError: true, content: [{ type: "text", text: "Missing `tasks`." }], details: { projectAgentsDir: null, results: [], totalDurationMs: 0 } },
      });
    },
    asyncResult(id: string, jobId: string, label: string) {
      add(id, {
        type: "custom_message",
        customType: "async-result",
        content: `<system-notice>\nBackground job ${jobId} has completed.\n<task-result id="${jobId}" agent="task" status="completed" duration="9.6s">12 files.</task-result>\n</system-notice>`,
        display: true,
        details: { meta: { source: { type: "report", value: "background job delivery" } }, jobs: [{ jobId, type: "task", label, durationMs: 9638 }] },
      });
    },
    wait(id: string, callId: string, jobId: string, status: string) {
      add(id, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "wait", arguments: { i: "Wait" } }] } });
      add(`${id}r`, {
        type: "message",
        message: { role: "toolResult", toolCallId: callId, toolName: "wait", content: [{ type: "text", text: "done" }], details: { op: "wait", jobs: [{ id: jobId, type: "task", status, label: jobId, durationMs: 100 }] } },
      });
    },
    text: () => `${rows.join("\n")}\n`,
  };
}

const temps: string[] = [];
afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function lab() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "collie-omp-sub-")));
  temps.push(base);
  const root = join(base, "sessions");
  const project = join(root, "-lab");
  await mkdir(project, { recursive: true });
  const log = join(project, `2026-10-25T09-26-39-663Z_${SID}.jsonl`);
  return { root, log };
}

function pane(log: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "lab",
    workspaceNumber: 1,
    tabId: "t1",
    agent: "omp",
    agentSession: { kind: "path", value: log },
    status: "working",
    cwd: "/lab",
    focused: false,
    kind: "agent",
    ...over,
  };
}

/** A live window over a real log, a Chat poll that reads it, and the pill's reader over both. */
async function rig() {
  const { root, log } = await lab();
  let now = Date.now();
  const clock = () => now;
  const live = new LiveWindows(new TranscriptStore(), clock);
  const adapter = piJournal(root);
  const registry = { pi: adapter, claude: claudeJournal(root) } satisfies Record<string, JournalAdapter>;
  const pill = new JournalSubagents(registry, live, clock);
  const poll = async () => {
    now += TICK_FLOOR_MS;
    await live.window(adapter, { kind: "path", value: log }, { limit: 40 });
  };
  return { log, live, pill, poll, advance: (ms: number) => (now += ms), at: () => now };
}

describe("ongoingSubagents", () => {
  const card = (uuid: string, ts: string, call: ToolCall, id?: string): TranscriptEntry => {
    const part: TranscriptPart = { kind: "tool", name: "task", summary: "", call };
    if (id !== undefined) part.id = id;
    return { uuid, ts, role: "assistant", parts: [part] };
  };

  test("maps each ongoing task card to a row with no transcript, oldest first", () => {
    const rows = ongoingSubagents([
      card("b", "2026-10-25T09:31:00.000Z", { kind: "task", summary: "second   lab\ncount", agent: "task", jobId: "LabFix-2", ongoing: true }),
      card("a", "2026-10-25T09:30:00.000Z", { kind: "task", summary: "first", jobId: "LabFix", ongoing: true }),
      card("c", TS, { kind: "task", summary: "ended", jobId: "Done" }),
      card("d", TS, { kind: "execute", command: "sleep 9", ongoing: true }),
    ]);
    expect(rows).toEqual([
      { agentId: "LabFix", description: "first", transcript: false, startedAt: "2026-10-25T09:30:00.000Z" },
      { agentId: "LabFix-2", description: "second lab count", transcript: false, agentType: "task", startedAt: "2026-10-25T09:31:00.000Z" },
    ]);
  });

  test("a Gentle Shell card has no job id and reads by its tool call id; an abandoned turn is skipped", () => {
    const gentle = card("g", TS, { kind: "task", summary: "Map it", agent: "gentle-ai-explore", ongoing: true }, "call_1");
    const gone = { ...card("x", TS, { kind: "task", summary: "gone", ongoing: true }, "call_2"), abandoned: true as const };
    expect(ongoingSubagents([gentle, gone]).map((r) => r.agentId)).toEqual(["call_1"]);
  });

  test("caps the list", () => {
    const many = Array.from({ length: MAX_SUBAGENTS + 5 }, (_, i) => card(`u${i}`, TS, { kind: "task", summary: `job ${i}`, ongoing: true }, `c${String(i).padStart(3, "0")}`));
    expect(ongoingSubagents(many)).toHaveLength(MAX_SUBAGENTS);
  });
});

describe("JournalSubagents — the pill from a live Oh My Pi window", () => {
  test("a spawn shows a row, and the async-result notice clears it", async () => {
    const r = await rig();
    const log = ompLog();
    log.spawn("a1", "c1", "Count the lab files", "LabFix");
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.pill.get(pane(r.log))).toEqual([
      { agentId: "LabFix", agentType: "task", description: "Count the lab files", startedAt: TS, transcript: false },
    ]);

    log.asyncResult("n1", "LabFix", "LabFix");
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.pill.get(pane(r.log))).toBeUndefined();
  });

  test("a wait with a completed job clears it; a `-2` job settles by its own id", async () => {
    const r = await rig();
    const log = ompLog();
    log.spawn("a1", "c1", "First count", "LabFix");
    log.spawn("a2", "c2", "Second count", "LabFix", "LabFix-2");
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.pill.get(pane(r.log))?.map((s) => s.agentId)).toEqual(["LabFix", "LabFix-2"]);

    log.wait("w1", "c3", "LabFix-2", "completed");
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.pill.get(pane(r.log))?.map((s) => s.agentId)).toEqual(["LabFix"]);

    log.wait("w2", "c4", "LabFix", "failed");
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.pill.get(pane(r.log))).toBeUndefined();
  });

  test("a failed spawn never shows", async () => {
    const r = await rig();
    const log = ompLog();
    log.failedSpawn("a1", "c1");
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.pill.get(pane(r.log))).toBeUndefined();
  });

  test("answers from memory only: no poll, no row; a poll gone quiet past the bound, no row", async () => {
    const r = await rig();
    const log = ompLog();
    log.spawn("a1", "c1", "Count the lab files", "LabFix");
    await Bun.write(r.log, log.text());
    // Nobody has read the session's Chat: nothing is held, and the pill reads no file.
    expect(r.pill.get(pane(r.log))).toBeUndefined();
    expect(r.live.size()).toBe(0);
    await r.poll();
    expect(r.pill.get(pane(r.log))).toHaveLength(1);
    r.advance(HELD_FRESH_MS + 1);
    expect(r.pill.get(pane(r.log))).toBeUndefined();
  });

  test("a card whose log has been quiet past QUIET_RUNNING_MS no longer counts", async () => {
    const r = await rig();
    const log = ompLog();
    log.spawn("a1", "c1", "Count the lab files", "LabFix");
    await Bun.write(r.log, log.text());
    const old = (r.at() - QUIET_RUNNING_MS - 60_000) / 1000;
    await utimes(r.log, old, old);
    await r.poll();
    expect(r.pill.get(pane(r.log))).toBeUndefined();
  });

  test("a Claude pane and a pane with no session never read the journal list", async () => {
    const r = await rig();
    const log = ompLog();
    log.spawn("a1", "c1", "Count the lab files", "LabFix");
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.pill.get(pane(r.log, { agent: "claude" }))).toBeUndefined();
    expect(r.pill.get(pane(r.log, { agentSession: undefined }))).toBeUndefined();
    expect(r.pill.get(pane(r.log))).toHaveLength(1);
  });
});

describe("maskSubagentList — a journal row", () => {
  const key = `sk-test-placeholder-${"0".repeat(40)}`;

  test("masks the job id the agent chose, and leaves a Claude row's id alone", () => {
    const [journal, claude] = maskSubagentList([
      { agentId: `job ${key}`, description: `use ${key}`, transcript: false as const },
      { agentId: "a71a608a981ceee4a", description: "fine" },
    ]);
    expect(journal!.agentId).not.toContain(key);
    expect(journal!.description).not.toContain(key);
    expect(claude!.agentId).toBe("a71a608a981ceee4a");
  });
});
