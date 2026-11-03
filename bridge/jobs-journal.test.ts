import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maskJobList, maskSnapshotTitles } from "./answer-mask.ts";
import { JournalJobs, journalJobs, MAX_JOBS, RECENT_JOB_MS, recentJobs } from "./jobs-journal.ts";
import { claudeJournal } from "./journal/claude.ts";
import { LiveWindows, TICK_FLOOR_MS } from "./journal/live.ts";
import { piJournal } from "./journal/pi.ts";
import { TranscriptStore } from "./journal/store.ts";
import type { ToolCall } from "./journal/tool-call.ts";
import type { JournalAdapter, TranscriptEntry, TranscriptPart } from "./journal/types.ts";
import type { JsonValue } from "./json.ts";
import { HELD_FRESH_MS } from "./subagents-journal.ts";
import { QUIET_RUNNING_MS } from "./subagents.ts";
import type { AgentView } from "./types.ts";

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("journalJobs", () => {
  const card = (uuid: string, ts: string, call: ToolCall, id?: string): TranscriptEntry => {
    const part: TranscriptPart = { kind: "tool", name: "bash_background", summary: "", call };
    if (id !== undefined) part.id = id;
    return { uuid, ts, role: "assistant", parts: [part] };
  };
  const bg = (over: Partial<Extract<ToolCall, { kind: "execute" }>>): ToolCall => ({ kind: "execute", command: "bun test", background: true, ...over });

  test("lists the running jobs oldest first, then the ended ones newest first; a plain command is not a job", () => {
    const rows = journalJobs([
      card("b", iso(T0), bg({ description: "second", jobId: "job-2", ongoing: true, startedAt: T0 + 2000 })),
      card("a", iso(T0), bg({ description: "first   suite\nrun", jobId: "job-1", ongoing: true, startedAt: T0 + 1000 })),
      card("c", iso(T0), bg({ jobId: "job-3", startedAt: T0, endedAt: T0 + 5000, exitCode: 0 })),
      card("d", iso(T0), bg({ jobId: "job-4", startedAt: T0, endedAt: T0 + 9000 })),
      card("e", iso(T0), { kind: "execute", command: "ls", ongoing: true }),
      card("f", iso(T0), { kind: "task", summary: "an agent", ongoing: true }),
    ]);
    expect(rows).toEqual([
      { id: "job-1", label: "first suite run", command: "bun test", startedAt: iso(T0 + 1000) },
      { id: "job-2", label: "second", command: "bun test", startedAt: iso(T0 + 2000) },
      { id: "job-4", label: "", command: "bun test", startedAt: iso(T0), endedAt: iso(T0 + 9000) },
      { id: "job-3", label: "", command: "bun test", startedAt: iso(T0), exitCode: 0, endedAt: iso(T0 + 5000) },
    ]);
  });

  test("a job with no job id reads by its call id and its turn's time; an abandoned turn and an unended, unstarted call are skipped", () => {
    const plain = card("g", iso(T0), bg({ ongoing: true }), "call_1");
    const gone = { ...card("x", iso(T0), bg({ ongoing: true }), "call_2"), abandoned: true as const };
    const never = card("y", iso(T0), bg({}), "call_3");
    expect(journalJobs([plain, gone, never])).toEqual([{ id: "call_1", label: "", command: "bun test", startedAt: iso(T0) }]);
  });

  test("an ended job stays for RECENT_JOB_MS after its end and leaves after; a running one stays", () => {
    const rows = journalJobs([
      card("a", iso(T0), bg({ jobId: "run", ongoing: true, startedAt: T0 })),
      card("b", iso(T0), bg({ jobId: "end", startedAt: T0, endedAt: T0 + 1000, exitCode: 1 })),
    ]);
    expect(recentJobs(rows, T0 + 1000 + RECENT_JOB_MS).map((r) => r.id)).toEqual(["run", "end"]);
    expect(recentJobs(rows, T0 + 1001 + RECENT_JOB_MS).map((r) => r.id)).toEqual(["run"]);
  });

  test("caps the list", () => {
    const many = Array.from({ length: MAX_JOBS + 5 }, (_, i) => card(`u${i}`, iso(T0), bg({ ongoing: true }), `c${String(i).padStart(3, "0")}`));
    expect(recentJobs(journalJobs(many), T0)).toHaveLength(MAX_JOBS);
  });
});

// Gentle Shell's job shape, as bridge/journal/pi.test.ts has it: `bash_background` answers at once with
// `details.gentleJobs` and a `gentle-jobs.notice` row ends the job later.
const SID = "01a17262-0000-7000-8000-00000000f670";

type Row = Record<string, JsonValue>;

function gentleLog(start: number) {
  const rows: string[] = [JSON.stringify({ type: "session", version: 3, id: SID, timestamp: iso(start), cwd: "/lab" })];
  let parent: string | null = null;
  const add = (id: string, at: number, body: Row) => {
    rows.push(JSON.stringify({ id, parentId: parent, timestamp: iso(at), ...body }));
    parent = id;
  };
  const job = (jobId: string, status: string, exitCode: number | null) => ({ gentleJobs: { jobId, kind: "command", label: "suite", status, exitCode, outputPath: "/tmp/j.log" } });
  return {
    background(id: string, callId: string, jobId: string, command: string, at: number) {
      add(id, at, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash_background", arguments: { command, label: "suite" } }] } });
      add(`${id}r`, at, {
        type: "message",
        message: { role: "toolResult", toolCallId: callId, toolName: "bash_background", content: [{ type: "text", text: `Started background job ${jobId}.` }], details: job(jobId, "running", null) },
      });
    },
    exited(id: string, jobId: string, code: number, at: number) {
      add(id, at, {
        type: "custom_message",
        customType: "gentle-jobs.notice",
        content: `Background job ${jobId} exited with code ${code}.`,
        display: true,
        details: job(jobId, "exited", code),
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
  const base = await realpath(await mkdtemp(join(tmpdir(), "collie-jobs-")));
  temps.push(base);
  const root = join(base, "sessions");
  const project = join(root, "-lab");
  await mkdir(project, { recursive: true });
  return { root, log: join(project, `2026-11-03T10-00-00-000Z_${SID}.jsonl`) };
}

function pane(log: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "lab",
    workspaceNumber: 1,
    tabId: "t1",
    agent: "pi",
    agentSession: { kind: "path", value: log },
    status: "working",
    cwd: "/lab",
    focused: false,
    kind: "agent",
    ...over,
  };
}

/** A live window over a real log, a Chat poll that reads it, and the Jobs reader over both. */
async function rig() {
  const { root, log } = await lab();
  let now = Date.now();
  const clock = () => now;
  const live = new LiveWindows(new TranscriptStore(), clock);
  const adapter = piJournal(root);
  const registry = { pi: adapter, claude: claudeJournal(root) } satisfies Record<string, JournalAdapter>;
  const jobs = new JournalJobs(registry, live, clock);
  const poll = async () => {
    now += TICK_FLOOR_MS;
    await live.window(adapter, { kind: "path", value: log }, { limit: 40 });
  };
  return { log, live, jobs, poll, advance: (ms: number) => (now += ms), at: () => now };
}

describe("JournalJobs, the Jobs mark from a live pi window", () => {
  test("a background command shows as running, and its exit notice turns it into an ended row with its code", async () => {
    const r = await rig();
    const start = r.at() - 60_000;
    const log = gentleLog(start);
    log.background("a1", "c1", "job-1", "bun test", start);
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.jobs.get(pane(r.log))).toEqual([{ id: "job-1", label: "suite", command: "bun test", startedAt: iso(start) }]);

    log.exited("n1", "job-1", 137, start + 3000);
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.jobs.get(pane(r.log))).toEqual([
      { id: "job-1", label: "suite", command: "bun test", startedAt: iso(start), exitCode: 137, endedAt: iso(start + 3000) },
    ]);
  });

  test("an ended job leaves the list RECENT_JOB_MS after its end, while the Chat still polls", async () => {
    const r = await rig();
    const start = r.at() - 60_000;
    const log = gentleLog(start);
    log.background("a1", "c1", "job-1", "bun test", start);
    log.exited("n1", "job-1", 0, start + 1000);
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.jobs.get(pane(r.log))?.map((j) => j.exitCode)).toEqual([0]);
    // The log stays still and the clock moves: the window is applied at the read, not at the derive.
    r.advance(RECENT_JOB_MS);
    await r.poll();
    expect(r.jobs.get(pane(r.log))).toBeUndefined();
  });

  test("answers from memory only: no poll, no row; a poll gone quiet past the bound, no row", async () => {
    const r = await rig();
    const log = gentleLog(r.at());
    log.background("a1", "c1", "job-1", "bun test", r.at());
    await Bun.write(r.log, log.text());
    expect(r.jobs.get(pane(r.log))).toBeUndefined();
    expect(r.live.size()).toBe(0);
    await r.poll();
    expect(r.jobs.get(pane(r.log))).toHaveLength(1);
    r.advance(HELD_FRESH_MS + 1);
    expect(r.jobs.get(pane(r.log))).toBeUndefined();
  });

  test("a running job whose log has been quiet past QUIET_RUNNING_MS no longer counts", async () => {
    const r = await rig();
    const log = gentleLog(r.at());
    log.background("a1", "c1", "job-1", "bun test", r.at());
    await Bun.write(r.log, log.text());
    const old = (r.at() - QUIET_RUNNING_MS - 60_000) / 1000;
    await utimes(r.log, old, old);
    await r.poll();
    expect(r.jobs.get(pane(r.log))).toBeUndefined();
  });

  test("a pane with no session, or a harness with no journal, reads nothing; the field is absent, never `[]`", async () => {
    const r = await rig();
    const log = gentleLog(r.at());
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.jobs.get(pane(r.log))).toBeUndefined();
    log.background("a1", "c1", "job-1", "bun test", r.at());
    await Bun.write(r.log, log.text());
    await r.poll();
    expect(r.jobs.get(pane(r.log, { agentSession: undefined }))).toBeUndefined();
    expect(r.jobs.get(pane(r.log, { agent: "nojournal" }))).toBeUndefined();
    expect(r.jobs.get(pane(r.log))).toHaveLength(1);
  });
});

describe("maskJobList", () => {
  const key = `sk-test-placeholder-${"0".repeat(40)}`;

  test("masks the command, the label and the id, and leaves the code and the times", () => {
    const job = { id: `job ${key}`, label: `use ${key}`, command: `curl -H "Authorization: Bearer ${key}" x`, startedAt: iso(T0), exitCode: 1, endedAt: iso(T0 + 1) };
    const [masked] = maskJobList([job]);
    expect(masked!.command).not.toContain(key);
    expect(masked!.command.length).toBe(job.command.length);
    expect(masked!.label).not.toContain(key);
    expect(masked!.id).not.toContain(key);
    expect(masked).toMatchObject({ startedAt: job.startedAt, exitCode: 1, endedAt: job.endedAt });
    expect(job.command).toContain(key);
  });

  test("a member's snapshot gets its jobs masked on the lead", () => {
    const out = maskSnapshotTitles({
      agents: [{ jobs: [{ id: "job-1", label: "suite", command: `export KEY=${key}` }] }, {}],
      shellPanes: [],
    });
    expect(out.agents[0]!.jobs![0]!.command).not.toContain(key);
    expect(out.agents[1]!.jobs).toBeUndefined();
  });
});
