import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProbeTail } from "./journal/cache-probe.ts";
import type { RowReducer } from "./journal/reduce.ts";
import type { JournalAdapter, TranscriptEntry, TranscriptSource } from "./journal/types.ts";
import { parseJournalTodos, readClaudeTasks, TodoTracker } from "./todos.ts";
import type { AgentView } from "./types.ts";

const NOW = 1_800_000_000_000;
const SID = "1d8a30f9-fe99-4897-8c2b-0cb9b0e4d8cd";
const dir = mkdtempSync(join(tmpdir(), "collie-tasks-"));
const outside = mkdtempSync(join(tmpdir(), "collie-tasks-out-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function clock(start = NOW) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

function fakeJournal(agent = "claude") {
  const calls = { stat: 0, tail: 0, load: 0 };
  interface FakeState {
    stat: { size: number; mtimeMs: number } | null;
    loadText: string;
    entries: TranscriptEntry[];
  }
  const state: FakeState = {
    stat: { size: 10, mtimeMs: 100 },
    loadText: "",
    entries: [],
  };
  const source: TranscriptSource = {
    resolve: async () => "/logs/one.jsonl",
    stat: async () => {
      calls.stat++;
      return state.stat;
    },
    load: async () => {
      calls.load++;
      return { text: state.loadText, complete: true, size: state.loadText.length, mtimeMs: 300 };
    },
    readSince: async () => ({ lines: [], cursor: "", reset: true, fromStart: true }),
  };
  const adapter: JournalAdapter = {
    agent,
    source,
    parse: () => state.entries,
    reducer: (): RowReducer => {
      throw new Error("the todo tracker does not fold a live window");
    },
  };
  const tail = async (): Promise<ProbeTail | null> => {
    calls.tail++;
    return { path: "/logs/one.jsonl", lines: [], mtimeMs: 100 };
  };
  return { adapter, calls, state, tail };
}

const pane = (agent: string, session: string | undefined, over: Partial<AgentView> = {}): AgentView => {
  const view: AgentView = {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "project",
    workspaceNumber: 1,
    tabId: "t1",
    agent,
    status: "working",
    cwd: "/p",
    focused: false,
    kind: "agent",
    ...over,
  };
  if (session !== undefined) view.agentSession = { kind: "id", value: session };
  return view;
};

describe("readClaudeTasks", () => {
  test("reads numbered task JSON files in numeric order and skips deleted tasks", async () => {
    const sessionDir = join(dir, SID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "2.json"),
      JSON.stringify({
        id: "2",
        subject: "Second task",
        activeForm: "Working on second",
        status: "in_progress",
      }),
    );
    writeFileSync(
      join(sessionDir, "10.json"),
      JSON.stringify({
        id: "10",
        subject: "Tenth task",
        status: "pending",
      }),
    );
    writeFileSync(
      join(sessionDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "First task",
        status: "completed",
      }),
    );
    writeFileSync(
      join(sessionDir, "3.json"),
      JSON.stringify({
        id: "3",
        subject: "Deleted task",
        status: "deleted",
      }),
    );
    writeFileSync(join(sessionDir, ".highwatermark"), "10");

    expect(await readClaudeTasks(dir, SID)).toEqual([
      { id: "1", text: "First task", status: "completed" },
      { id: "2", text: "Second task", status: "in_progress", activeForm: "Working on second" },
      { id: "10", text: "Tenth task", status: "pending" },
    ]);
  });

  test("rejects non-uuid session ids and symlink escapes", async () => {
    const escapeId = "22222222-2222-2222-2222-222222222222";
    mkdirSync(join(outside, escapeId), { recursive: true });
    writeFileSync(join(outside, escapeId, "1.json"), JSON.stringify({ id: "1", subject: "leak", status: "pending" }));
    symlinkSync(join(outside, escapeId), join(dir, escapeId));

    expect(await readClaudeTasks(dir, "../etc")).toBeUndefined();
    expect(await readClaudeTasks(dir, "not-a-uuid")).toBeUndefined();
    expect(await readClaudeTasks(dir, escapeId)).toBeUndefined();
  });

  test("scans past 50 deleted task files to keep active tasks after them and returns an empty array when all are deleted", async () => {
    const manyId = "33333333-3333-3333-3333-333333333333";
    const sessionDir = join(dir, manyId);
    mkdirSync(sessionDir, { recursive: true });
    for (let i = 1; i <= 50; i++) {
      writeFileSync(
        join(sessionDir, `${String(i)}.json`),
        JSON.stringify({ id: String(i), subject: `Deleted ${String(i)}`, status: "deleted" }),
      );
    }
    expect(await readClaudeTasks(dir, manyId)).toEqual([]);

    writeFileSync(
      join(sessionDir, "51.json"),
      JSON.stringify({ id: "51", subject: "Fifty-first task", status: "pending" }),
    );
    expect(await readClaudeTasks(dir, manyId)).toEqual([
      { id: "51", text: "Fifty-first task", status: "pending" },
    ]);
  });
});

describe("parseJournalTodos", () => {
  test("folds Claude TaskCreate, toolUseResult id assignment, and TaskUpdate in order", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "TaskCreate", input: { subject: "Step one", activeForm: "Doing one" } },
            { type: "tool_use", id: "call_2", name: "TaskCreate", input: { subject: "Step two" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: { task: { id: "6", subject: "Step one" } },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Task #6 created" }] },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: { task: { id: "7", subject: "Step two" } },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "Task #7 created" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_3", name: "TaskUpdate", input: { taskId: "6", status: "completed" } },
            { type: "tool_use", id: "call_4", name: "TaskUpdate", input: { taskId: "7", status: "in_progress", activeForm: "Running two" } },
          ],
        },
      }),
    ];

    expect(parseJournalTodos(lines)).toEqual([
      { id: "6", text: "Step one", status: "completed", activeForm: "Doing one" },
      { id: "7", text: "Step two", status: "in_progress", activeForm: "Running two" },
    ]);
  });

  test("starts a fresh batch when a new TaskCreate arrives after all prior tasks completed", () => {
    const previous = [
      { id: "1", text: "Old one", status: "completed" as const },
      { id: "2", text: "Old two", status: "completed" as const },
    ];
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_new", name: "TaskCreate", input: { subject: "New batch task" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: { task: { id: "3", subject: "New batch task" } },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_new", content: "Task #3 created" }] },
      }),
    ];

    expect(parseJournalTodos(lines, previous)).toEqual([
      { id: "3", text: "New batch task", status: "pending" },
    ]);
  });

  test("re-reading an overlapping tail when task 1 scrolled off does not drop task 1", () => {
    const previous = [
      { id: "1", text: "Step one", status: "completed" as const },
      { id: "2", text: "Step two", status: "completed" as const },
    ];
    // Task 1's TaskCreate scrolled out of the 64 KB tail; Task 2's TaskCreate and TaskUpdate are still in the tail.
    const overlappingTail = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_2", name: "TaskCreate", input: { subject: "Step two" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: { task: { id: "2", subject: "Step two" } },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "Task #2 created" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_4", name: "TaskUpdate", input: { taskId: "2", status: "completed" } }],
        },
      }),
    ];

    expect(parseJournalTodos(overlappingTail, previous)).toEqual([
      { id: "1", text: "Step one", status: "completed" },
      { id: "2", text: "Step two", status: "completed" },
    ]);
  });

  test("re-reading the same tail that contains a batch reset does not resurrect the completed earlier batch", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "TaskCreate", input: { subject: "Batch one" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: { task: { id: "1", subject: "Batch one" } },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Task #1 created" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_2", name: "TaskCreate", input: { subject: "Batch two" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: { task: { id: "2", subject: "Batch two" } },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "Task #2 created" }] },
      }),
    ];

    const first = parseJournalTodos(lines);
    expect(first).toEqual([{ id: "2", text: "Batch two", status: "pending" }]);
    expect(parseJournalTodos(lines, first)).toEqual([{ id: "2", text: "Batch two", status: "pending" }]);
  });

  test("does not leave a ghost task when a TaskCreate is read before its toolUseResult assigns the real id", () => {
    const createLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_A", name: "TaskCreate", input: { subject: "Unassigned yet" } }],
      },
    });
    const resultLine = JSON.stringify({
      type: "user",
      toolUseResult: { task: { id: "6", subject: "Unassigned yet" } },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_A", content: "Task #6 created" }] },
    });

    const pending = parseJournalTodos([createLine]);
    expect(pending).toHaveLength(1);
    expect(parseJournalTodos([createLine, resultLine], pending)).toEqual([
      { id: "6", text: "Unassigned yet", status: "pending" },
    ]);
  });

  test("clears previous tasks when TaskList returns an empty list or only deleted tasks", () => {
    const previous = [{ id: "1", text: "Still here", status: "pending" as const }];
    const emptyList = JSON.stringify({
      type: "user",
      toolUseResult: { tasks: [] },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tl_1", content: "No tasks" }] },
    });
    expect(parseJournalTodos([emptyList], previous)).toBeUndefined();

    const deletedList = JSON.stringify({
      type: "user",
      toolUseResult: { tasks: [{ id: "1", subject: "Still here", status: "deleted" }] },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tl_2", content: "No tasks" }] },
    });
    expect(parseJournalTodos([deletedList], previous)).toBeUndefined();
  });

  test("reads Claude TodoWrite, OpenCode todowrite, Codex update_plan, and Grok todo_write", () => {
    const claudeTodo = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tw_1",
            name: "TodoWrite",
            input: {
              todos: [
                { id: "a", content: "Write tests", status: "completed" },
                { id: "b", content: "Wire UI", status: "in_progress", activeForm: "Wiring UI" },
              ],
            },
          },
        ],
      },
    });
    expect(parseJournalTodos([claudeTodo])).toEqual([
      { id: "a", text: "Write tests", status: "completed" },
      { id: "b", text: "Wire UI", status: "in_progress", activeForm: "Wiring UI" },
    ]);

    const opencodeLine = JSON.stringify({
      id: "msg_1",
      ts: 1,
      data: { role: "assistant" },
      parts: [
        {
          id: "prt_1",
          data: {
            type: "tool",
            tool: "todowrite",
            state: {
              status: "completed",
              input: {
                todos: [
                  { id: "1", content: "Inspect DB", status: "completed" },
                  { id: "2", content: "Dropped item", status: "cancelled" },
                  { id: "3", content: "Ship dock", status: "pending" },
                ],
              },
            },
          },
        },
      ],
    });
    expect(parseJournalTodos([opencodeLine])).toEqual([
      { id: "1", text: "Inspect DB", status: "completed" },
      { id: "3", text: "Ship dock", status: "pending" },
    ]);

    const codexLine = JSON.stringify({
      timestamp: "2026-10-17T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "update_plan",
        call_id: "call_plan",
        arguments: JSON.stringify({
          explanation: "plan",
          plan: [
            { step: "Check types", status: "completed" },
            { step: "Run tests", status: "in_progress" },
          ],
        }),
      },
    });
    expect(parseJournalTodos([codexLine])).toEqual([
      { id: "1", text: "Check types", status: "completed" },
      { id: "2", text: "Run tests", status: "in_progress" },
    ]);

    const grokLines = [
      JSON.stringify({
        type: "assistant",
        content: "",
        tool_calls: [
          {
            id: "gk_1",
            name: "todo_write",
            arguments: JSON.stringify({
              merge: false,
              todos: [
                { id: "t1", content: "First", status: "in_progress" },
                { id: "t2", content: "Second", status: "pending" },
              ],
            }),
          },
        ],
      }),
      JSON.stringify({
        type: "assistant",
        content: "",
        tool_calls: [
          {
            id: "gk_2",
            name: "todo_write",
            arguments: JSON.stringify({
              merge: true,
              todos: [{ id: "t1", content: "First", status: "completed" }],
            }),
          },
        ],
      }),
    ];
    expect(parseJournalTodos(grokLines)).toEqual([
      { id: "t1", text: "First", status: "completed" },
      { id: "t2", text: "Second", status: "pending" },
    ]);
  });
});

describe("TodoTracker", () => {
  test("reads Claude task files while active and folds the final completion from the journal when task files are cleared", async () => {
    const c = clock();
    const sessionDir = join(dir, SID);
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "1.json"), JSON.stringify({ id: "1", subject: "First", status: "completed" }));
    writeFileSync(
      join(sessionDir, "2.json"),
      JSON.stringify({ id: "2", subject: "Second", activeForm: "Doing second", status: "in_progress" }),
    );

    let tailLines: string[] = [];
    const j = fakeJournal("claude");
    const tail = async (): Promise<ProbeTail | null> => ({
      path: "/logs/one.jsonl",
      lines: tailLines,
      mtimeMs: j.state.stat?.mtimeMs ?? 100,
    });
    const tracker = new TodoTracker({ claude: j.adapter }, c.now, { tasksDir: dir, tail });
    await tracker.refresh([pane("claude", SID)]);
    expect(tracker.get(pane("claude", SID))).toEqual([
      { id: "1", text: "First", status: "completed" },
      { id: "2", text: "Second", status: "in_progress", activeForm: "Doing second" },
    ]);

    // Claude Code removes <id>.json once the last task completes and records TaskUpdate in the journal.
    rmSync(join(sessionDir, "1.json"));
    rmSync(join(sessionDir, "2.json"));
    tailLines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "u2", name: "TaskUpdate", input: { taskId: "2", status: "completed" } }],
        },
      }),
    ];
    j.state.stat = { size: 50, mtimeMs: 200 };
    c.advance(6000);
    await tracker.refresh([pane("claude", SID)]);
    expect(tracker.get(pane("claude", SID))).toEqual([
      { id: "1", text: "First", status: "completed" },
      { id: "2", text: "Second", status: "completed", activeForm: "Doing second" },
    ]);
  });

  test("respects per-session floors (5 s for file-backed, 10 s for opencode) and reaps departed panes per session", async () => {
    const c = clock();
    const codex = fakeJournal("codex");
    const opencode = fakeJournal("opencode");
    opencode.state.loadText = JSON.stringify({
      id: "msg_1",
      ts: 1,
      data: { role: "assistant" },
      parts: [
        {
          id: "prt_1",
          data: {
            type: "tool",
            tool: "todowrite",
            state: {
              status: "completed",
              input: { todos: [{ id: "1", content: "OpenCode item", status: "in_progress" }] },
            },
          },
        },
      ],
    });
    const codexTail = async (): Promise<ProbeTail | null> => {
      codex.calls.tail++;
      return {
        path: "/logs/one.jsonl",
        lines: [
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "function_call",
              name: "update_plan",
              call_id: "c1",
              arguments: JSON.stringify({ plan: [{ step: "Codex step", status: "pending" }] }),
            },
          }),
        ],
        mtimeMs: 100,
      };
    };

    const tracker = new TodoTracker({ codex: codex.adapter, opencode: opencode.adapter }, c.now, { tail: codexTail });
    const pCodex = pane("codex", "cx-1", { paneId: "w1:p1" });
    const pOpen = pane("opencode", "oc-1", { paneId: "w1:p2" });

    await tracker.refresh([pCodex, pOpen], { session: "a" });
    expect(codex.calls).toEqual({ stat: 1, tail: 1, load: 0 });
    expect(opencode.calls).toEqual({ stat: 1, tail: 0, load: 1 });
    expect(tracker.get(pCodex)).toEqual([{ id: "1", text: "Codex step", status: "pending" }]);
    expect(tracker.get(pOpen)).toEqual([{ id: "1", text: "OpenCode item", status: "in_progress" }]);

    // At +6 s, codex is past its 5 s floor while opencode is still under its 10 s floor.
    c.advance(6000);
    await tracker.refresh([pCodex, pOpen], { session: "a" });
    expect(codex.calls.stat).toBe(2);
    expect(opencode.calls.stat).toBe(1);

    // At +11 s total, opencode passes its 10 s floor too.
    c.advance(5000);
    await tracker.refresh([pCodex, pOpen], { session: "a" });
    expect(opencode.calls.stat).toBe(2);

    // Refreshing another mux session does not reap session "a"'s entries.
    await tracker.refresh([], { session: "b" });
    expect(tracker.get(pCodex)).toBeDefined();

    // Refreshing session "a" with no panes reaps its departed entries.
    await tracker.refresh([], { session: "a" });
    expect(tracker.get(pCodex)).toBeUndefined();
    expect(tracker.get(pOpen)).toBeUndefined();
  });

  test("discovers a ref-less Grok pane by cwd once per floor and drops it when the pane leaves", async () => {
    const c = clock();
    const grok = fakeJournal("grok");
    const asked: string[] = [];
    const adapter: JournalAdapter = {
      ...grok.adapter,
      discover: async (cwd) => {
        asked.push(cwd);
        return { kind: "id", value: "gk-session" };
      },
    };
    const tail = async (): Promise<ProbeTail | null> => ({
      path: "/logs/grok.jsonl",
      lines: [
        JSON.stringify({
          type: "assistant",
          content: "",
          tool_calls: [
            {
              id: "g1",
              name: "todo_write",
              arguments: JSON.stringify({
                merge: false,
                todos: [{ id: "t1", content: "Discovered task", status: "in_progress" }],
              }),
            },
          ],
        }),
      ],
      mtimeMs: 100,
    });

    const tracker = new TodoTracker({ grok: adapter }, c.now, { tail });
    const refless = pane("grok", undefined);
    await tracker.refresh([refless], { session: "a" });
    expect(tracker.get(refless)).toEqual([{ id: "t1", text: "Discovered task", status: "in_progress" }]);
    expect(asked).toEqual(["/p"]);

    c.advance(1000);
    await tracker.refresh([refless], { session: "a" });
    expect(asked).toEqual(["/p"]);

    await tracker.refresh([], { session: "a" });
    expect(tracker.get(refless)).toBeUndefined();
  });

  test("invalidates discovered session when a ref-less pane changes harness or cwd, and only reads task files for explicit Claude session ids", async () => {
    const c = clock();
    const grok = fakeJournal("grok");
    const codex = fakeJournal("codex");
    const claude = fakeJournal("claude");
    const grokAdapter: JournalAdapter = {
      ...grok.adapter,
      discover: async () => ({ kind: "id", value: "gk-session" }),
    };
    const claudeDiscoveredId = "44444444-4444-4444-4444-444444444444";
    const claudeSessionDir = join(dir, claudeDiscoveredId);
    mkdirSync(claudeSessionDir, { recursive: true });
    writeFileSync(
      join(claudeSessionDir, "1.json"),
      JSON.stringify({ id: "1", subject: "Should not read for discovered ref", status: "pending" }),
    );
    const claudeAdapter: JournalAdapter = {
      ...claude.adapter,
      discover: async () => ({ kind: "id", value: claudeDiscoveredId }),
    };
    const tail = async (_source: TranscriptSource, ref: { value: string }): Promise<ProbeTail | null> => ({
      path: "/logs/one.jsonl",
      lines:
        ref.value === "gk-session"
          ? [
              JSON.stringify({
                type: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "g1",
                    name: "todo_write",
                    arguments: JSON.stringify({
                      merge: false,
                      todos: [{ id: "t1", content: "Grok task", status: "in_progress" }],
                    }),
                  },
                ],
              }),
            ]
          : [],
      mtimeMs: 100,
    });

    const tracker = new TodoTracker(
      { grok: grokAdapter, codex: codex.adapter, claude: claudeAdapter },
      c.now,
      { tasksDir: dir, tail },
    );
    await tracker.refresh([pane("grok", undefined)], { session: "a" });
    expect(tracker.get(pane("grok", undefined))).toEqual([{ id: "t1", text: "Grok task", status: "in_progress" }]);

    // Same paneId now runs a ref-less codex (no discover) or changes cwd: must not inherit Grok's discovered session.
    expect(tracker.get(pane("codex", undefined))).toBeUndefined();
    expect(tracker.get(pane("grok", undefined, { cwd: "/other" }))).toBeUndefined();
    await tracker.refresh([pane("codex", undefined)], { session: "a" });
    expect(tracker.get(pane("codex", undefined))).toBeUndefined();

    // A ref-less Claude pane whose session came from discover (not pane.agentSession) does not read tasksDir.
    await tracker.refresh([pane("claude", undefined)], { session: "a" });
    expect(tracker.get(pane("claude", undefined))).toBeUndefined();
  });

  test("gates Claude task file reads by per-file stat signature, clears todos when all task files are marked deleted, and survives a throwing tail", async () => {
    const c = clock();
    const statId = "55555555-5555-5555-5555-555555555555";
    const sessionDir = join(dir, statId);
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true });
    const file1 = join(sessionDir, "1.json");
    writeFileSync(file1, JSON.stringify({ id: "1", subject: "Initial", status: "in_progress" }));

    const j = fakeJournal("claude");
    let shouldThrow = false;
    const tail = async (): Promise<ProbeTail | null> => {
      j.calls.tail++;
      if (shouldThrow) throw new Error("disk error");
      return { path: "/logs/one.jsonl", lines: [], mtimeMs: 100 };
    };
    const tracker = new TodoTracker({ claude: j.adapter }, c.now, { tasksDir: dir, tail });

    // Concurrent refresh calls do not bypass the floor or double-probe.
    await Promise.all([tracker.refresh([pane("claude", statId)]), tracker.refresh([pane("claude", statId)])]);
    expect(j.calls.stat).toBe(1);
    expect(tracker.get(pane("claude", statId))).toEqual([{ id: "1", text: "Initial", status: "in_progress" }]);

    // Even when journal stat does not move, updating 1.json (changing size/mtime) updates the todos past the floor.
    writeFileSync(file1, JSON.stringify({ id: "1", subject: "Updated task text", status: "completed" }));
    c.advance(6000);
    await tracker.refresh([pane("claude", statId)]);
    expect(tracker.get(pane("claude", statId))).toEqual([{ id: "1", text: "Updated task text", status: "completed" }]);

    // Marking the task file deleted clears the pane's todos.
    writeFileSync(file1, JSON.stringify({ id: "1", subject: "Updated task text", status: "deleted" }));
    c.advance(6000);
    await tracker.refresh([pane("claude", statId)]);
    expect(tracker.get(pane("claude", statId))).toBeUndefined();

    // A throwing tail inside lookJournal does not reject refresh().
    j.state.stat = { size: 99, mtimeMs: 999 };
    shouldThrow = true;
    c.advance(6000);
    await expect(tracker.refresh([pane("claude", statId)])).resolves.toBeUndefined();
  });
});
