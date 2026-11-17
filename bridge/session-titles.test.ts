import { describe, expect, test } from "bun:test";

import { NO_CURSOR } from "./journal/cursor.ts";
import { NO_CHANGE, noQueue, noUnknowns } from "./journal/reduce.ts";
import type { JournalAdapter } from "./journal/types.ts";
import type { NameReading } from "./session-title.ts";
import type { RememberedTitles } from "./session-titles-store.ts";
import { mergeTitles, SessionTitleTracker } from "./session-titles.ts";
import type { AgentView } from "./types.ts";

// The title tracker on a fake clock and a fake source: the floor, the stat gate, the sticky names and
// the reap, as counting. Nothing here opens a file.

const NOW = 1_800_000_000_000;

interface FakeState {
  stat: { size: number; mtimeMs: number } | null;
  reading: NameReading | null;
  throws: boolean;
}

function fakeAdapter(agent: string) {
  const calls = { stat: 0, probe: 0 };
  const state: FakeState = {
    stat: { size: 10, mtimeMs: 100 },
    reading: { person: "migrate lodge", agent: "Lodge migration" },
    throws: false,
  };
  const adapter: JournalAdapter = {
    agent,
    source: {
      resolve: async () => "/logs/one.jsonl",
      stat: async () => {
        calls.stat++;
        return state.stat;
      },
      load: async () => ({ text: "", complete: true, size: 0, mtimeMs: 0 }),
      readSince: async () => ({ lines: [], cursor: NO_CURSOR, reset: false, fromStart: false }),
    },
    parse: () => [],
    reducer: () => ({ push: () => NO_CHANGE, unknowns: noUnknowns, queued: noQueue }),
    nameProbe: async () => {
      calls.probe++;
      if (state.throws) throw new Error("unreadable");
      return state.reading;
    },
  };
  return { adapter, calls, state };
}

const pane = (agent: string, session: string | undefined, paneId = "w1:p1"): AgentView => {
  const view: AgentView = {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "project",
    workspaceNumber: 1,
    tabId: "t1",
    agent,
    status: "working",
    cwd: "/p",
    focused: false,
    kind: "agent",
  };
  if (session !== undefined) view.agentSession = { kind: "id", value: session };
  return view;
};

function clock(start = NOW) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

describe("mergeTitles", () => {
  test("a read replaces, cleaned; a null clears; a missing field keeps the last name", () => {
    expect(mergeTitles({}, { person: "  🚀 migrate  lodge ", agent: "Auto" })).toEqual({ person: "🚀 migrate lodge", agent: "Auto" });
    expect(mergeTitles({ person: "old", agent: "Auto" }, { person: null })).toEqual({ agent: "Auto" });
    expect(mergeTitles({ person: "old", agent: "Auto" }, {})).toEqual({ person: "old", agent: "Auto" });
    // A name the normalizer reads as nothing (zero-width characters only) is no evidence, so the last one stands.
    expect(mergeTitles({ agent: "Auto" }, { agent: "\u200B\u2060" })).toEqual({ agent: "Auto" });
  });
});

describe("SessionTitleTracker", () => {
  test("reads a session's names and serves them by session id and by pane", async () => {
    const { adapter } = fakeAdapter("claude");
    const tracker = new SessionTitleTracker({ claude: adapter }, () => NOW);
    await tracker.refresh([pane("claude", "s1")]);
    expect(tracker.get("s1")).toEqual({ person: "migrate lodge", agent: "Lodge migration" });
    expect(tracker.forPane(pane("claude", "s1"))).toEqual({ person: "migrate lodge", agent: "Lodge migration" });
    expect(tracker.forPane(pane("claude", undefined))).toBeUndefined();
  });

  test("an alias reaches its adapter (omp reads pi's journal)", async () => {
    const { adapter } = fakeAdapter("pi");
    const tracker = new SessionTitleTracker({ pi: adapter }, () => NOW);
    await tracker.refresh([pane("omp", "s1")]);
    expect(tracker.get("s1")?.agent).toBe("Lodge migration");
  });

  test("under the floor nothing is read; past it an unchanged stat reads nothing either", async () => {
    const { adapter, calls } = fakeAdapter("claude");
    const c = clock();
    const tracker = new SessionTitleTracker({ claude: adapter }, c.now, { floorMs: 5000 });
    await tracker.refresh([pane("claude", "s1")]);
    await tracker.refresh([pane("claude", "s1")]);
    expect(calls).toEqual({ stat: 1, probe: 1 });
    c.advance(6000);
    await tracker.refresh([pane("claude", "s1")]);
    expect(calls).toEqual({ stat: 2, probe: 1 });
  });

  test("a moved file is read again; a read that names nothing keeps the last names", async () => {
    const { adapter, calls, state } = fakeAdapter("claude");
    const c = clock();
    const tracker = new SessionTitleTracker({ claude: adapter }, c.now, { floorMs: 0 });
    await tracker.refresh([pane("claude", "s1")]);
    state.stat = { size: 20, mtimeMs: 200 };
    state.reading = {};
    c.advance(1);
    await tracker.refresh([pane("claude", "s1")]);
    expect(calls.probe).toBe(2);
    expect(tracker.get("s1")).toEqual({ person: "migrate lodge", agent: "Lodge migration" });
  });

  test("a probe that throws keeps the names and is tried again on the next look", async () => {
    const { adapter, calls, state } = fakeAdapter("claude");
    const c = clock();
    const tracker = new SessionTitleTracker({ claude: adapter }, c.now, { floorMs: 0 });
    await tracker.refresh([pane("claude", "s1")]);
    state.stat = { size: 20, mtimeMs: 200 };
    state.throws = true;
    c.advance(1);
    await tracker.refresh([pane("claude", "s1")]);
    expect(tracker.get("s1")?.person).toBe("migrate lodge");
    state.throws = false;
    state.reading = { person: "renamed" };
    c.advance(1);
    await tracker.refresh([pane("claude", "s1")]);
    expect(calls.probe).toBe(3);
    expect(tracker.get("s1")?.person).toBe("renamed");
  });

  test("an adapter with no nameProbe is skipped whole", async () => {
    const { adapter, calls } = fakeAdapter("codex");
    const { nameProbe: _gone, ...bare } = adapter;
    const tracker = new SessionTitleTracker({ codex: bare }, () => NOW);
    await tracker.refresh([pane("codex", "s1")]);
    expect(calls.stat).toBe(0);
    expect(tracker.get("s1")).toBeUndefined();
  });

  test("forgets a session whose pane left, or now names another session, but only for its own mux session", async () => {
    const { adapter } = fakeAdapter("claude");
    const tracker = new SessionTitleTracker({ claude: adapter }, () => NOW, { floorMs: 0 });
    await tracker.refresh([pane("claude", "s1")], { session: "a" });
    await tracker.refresh([pane("claude", "s2", "w2:p1")], { session: "b" });
    // Session b's poll does not reap session a's entry.
    expect(tracker.get("s1")).toBeDefined();
    // The pane now names another harness session: the old one goes.
    await tracker.refresh([pane("claude", "s3")], { session: "a" });
    expect(tracker.get("s1")).toBeUndefined();
    expect(tracker.get("s3")).toBeDefined();
    // The pane left: its entry goes.
    await tracker.refresh([], { session: "b" });
    expect(tracker.get("s2")).toBeUndefined();
  });

  test("after a restart, a session whose tail lost its title rows keeps the name the store kept", async () => {
    const saved: Map<string, RememberedTitles>[] = [];
    const store = { load: async () => new Map<string, RememberedTitles>(), save: async (all: ReadonlyMap<string, RememberedTitles>) => void saved.push(new Map(all)) };
    const first = fakeAdapter("claude");
    const before = new SessionTitleTracker({ claude: first.adapter }, () => NOW, { store });
    await before.refresh([pane("claude", "s1")]);
    expect(saved.at(-1)?.get("s1")?.titles).toEqual({ person: "migrate lodge", agent: "Lodge migration" });

    // The bridge restarts. The tail now holds only the agent's newer title row, no `/rename` row.
    const second = fakeAdapter("claude");
    second.state.reading = { agent: "Lodge migration, part two" };
    const after = new SessionTitleTracker({ claude: second.adapter }, () => NOW, { store: { ...store, load: async () => saved.at(-1)! } });
    await after.restore();
    await after.refresh([pane("claude", "s1")]);
    expect(after.get("s1")).toEqual({ person: "migrate lodge", agent: "Lodge migration, part two" });
  });

  test("an unchanged read writes nothing back", async () => {
    let saves = 0;
    const store = { load: async () => new Map<string, RememberedTitles>(), save: async () => void saves++ };
    const { adapter, state } = fakeAdapter("claude");
    const c = clock();
    const tracker = new SessionTitleTracker({ claude: adapter }, c.now, { floorMs: 0, store });
    await tracker.refresh([pane("claude", "s1")]);
    state.stat = { size: 20, mtimeMs: 200 };
    c.advance(1);
    await tracker.refresh([pane("claude", "s1")]);
    expect(saves).toBe(1);
  });

  test("a refresh while the last one for the same session still runs returns at once", async () => {
    const { adapter, calls } = fakeAdapter("claude");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: JournalAdapter = { ...adapter, nameProbe: async (ref) => (await gate, adapter.nameProbe!(ref)) };
    const tracker = new SessionTitleTracker({ claude: slow }, () => NOW, { floorMs: 0 });
    const first = tracker.refresh([pane("claude", "s1")], { session: "a" });
    await tracker.refresh([pane("claude", "s1")], { session: "a" });
    // Another multiplexer session is not held up by session a's look.
    const other = tracker.refresh([pane("claude", "s2", "w2:p1")], { session: "b" });
    release();
    await Promise.all([first, other]);
    expect(calls.probe).toBe(2);
    expect(tracker.get("s1")).toBeDefined();
    expect(tracker.get("s2")).toBeDefined();
  });
});
