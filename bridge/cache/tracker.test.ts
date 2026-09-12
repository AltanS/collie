import { describe, expect, test } from "bun:test";

import type { AgentSessionRef, JournalAdapter, TranscriptSource } from "../journal/types.ts";
import type { AgentView } from "../types.ts";
import type { CacheProbe, CacheOverride } from "./engine.ts";
import { CacheTracker, type CacheRuleSource } from "./tracker.ts";

// The tracker on a FAKE CLOCK and a fake filesystem. Nothing here opens a file: `floorMs` and
// `opencodeFloorMs` are constructor options precisely so the two floors and the read gate are tested
// as counting, which is the only way to state "forty panes do not cost forty reads a second".

const NOW = 1_800_000_000_000;

/** A counting fake of the one seam the tracker uses: resolve, then stat, then the adapter's probe. */
function fakeAdapter(agent: string, over: { probeTier?: "subscription" } = {}) {
  const calls = { resolve: 0, stat: 0, probe: 0 };
  interface FakeState {
    path: string | null;
    stat: { size: number; mtimeMs: number } | null;
    probe: CacheProbe | null;
    statThrows: boolean;
    probeThrows: boolean;
  }
  const state: FakeState = {
    path: "/logs/one.jsonl",
    stat: { size: 10, mtimeMs: 100 },
    probe: null,
    statThrows: false,
    probeThrows: false,
  };
  const source: TranscriptSource = {
    resolve: async () => {
      calls.resolve++;
      return state.path;
    },
    stat: async () => {
      calls.stat++;
      if (state.statThrows) throw new Error("gone");
      return state.stat;
    },
    load: async () => ({ text: "", complete: true, size: 0, mtimeMs: 0 }),
  };
  const adapter: JournalAdapter = {
    agent,
    source,
    parse: () => [],
    cacheProbe: async (_ref: AgentSessionRef) => {
      calls.probe++;
      if (state.probeThrows) throw new Error("unreadable");
      const probe = state.probe;
      if (probe === null) return null;
      return over.probeTier === undefined ? probe : { ...probe, tier: over.probeTier };
    },
  };
  return { adapter, calls, state };
}

/** An adapter with no probe at all — grok and hermes, which ship no rule either. */
function probelessAdapter(agent: string): JournalAdapter {
  return {
    agent,
    source: {
      resolve: async () => "/logs/x.jsonl",
      stat: async () => ({ size: 1, mtimeMs: 1 }),
      load: async () => ({ text: "", complete: true, size: 0, mtimeMs: 0 }),
    },
    parse: () => [],
  };
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

const probe = (over: Partial<CacheProbe> = {}): CacheProbe => ({
  lastRequestAt: NOW - 60_000,
  turnId: "turn-1",
  cacheReadTokens: 9000,
  cacheCreationTokens: 100,
  evidence: "a transcript",
  ...over,
});

const noOverrides: CacheRuleSource = { overrides: async () => [] };

/** A clock the test moves by hand. */
function clock(start = NOW) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

describe("what the tracker looks at", () => {
  test("skips a harness with no cacheProbe — grok and hermes cost nothing", async () => {
    const registry = { grok: probelessAdapter("grok") };
    const tracker = new CacheTracker(registry, noOverrides, () => NOW);
    await tracker.refresh([pane("grok", "ses-1")]);
    expect(tracker.get("ses-1")).toBeUndefined();
  });

  test("skips a pane that named no session", async () => {
    const { adapter, calls } = fakeAdapter("claude");
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, () => NOW);
    await tracker.refresh([pane("claude", undefined)]);
    expect(calls.resolve).toBe(0);
  });

  test("resolves an alias: an omp pane reads through pi's adapter and pi's rules", async () => {
    const { adapter, state } = fakeAdapter("pi");
    state.probe = probe({ model: "anthropic:claude-opus-5" });
    const tracker = new CacheTracker({ pi: adapter }, noOverrides, () => NOW);
    await tracker.refresh([pane("omp", "ses-omp")]);
    expect(tracker.get("ses-omp")?.ruleId).toBe("pi.anthropic");
  });

  test("keys by the harness session id and never by the pane id", async () => {
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, () => NOW);
    await tracker.refresh([pane("claude", "ses-1", "w9:p9")]);
    expect(tracker.get("ses-1")).toBeDefined();
    expect(tracker.get("w9:p9")).toBeUndefined();
  });
});

describe("the floor", () => {
  test("does not even stat a session it looked at inside floorMs", async () => {
    const c = clock();
    const { adapter, calls, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, c.now, { floorMs: 5000 });
    const panes = [pane("claude", "ses-1")];
    await tracker.refresh(panes);
    expect(calls.stat).toBe(1);
    c.advance(4999);
    await tracker.refresh(panes);
    expect(calls.stat).toBe(1);
    c.advance(2);
    await tracker.refresh(panes);
    expect(calls.stat).toBe(2);
  });

  test("gives a query-backed adapter its own, longer floor", async () => {
    const c = clock();
    const { adapter, calls, state } = fakeAdapter("opencode");
    state.probe = probe({ model: "anthropic:claude-opus-5" });
    const tracker = new CacheTracker({ opencode: adapter }, noOverrides, c.now, {
      floorMs: 5000,
      opencodeFloorMs: 10_000,
    });
    const panes = [pane("opencode", "ses-oc")];
    await tracker.refresh(panes);
    c.advance(6000);
    await tracker.refresh(panes);
    expect(calls.stat).toBe(1);
    c.advance(5000);
    await tracker.refresh(panes);
    expect(calls.stat).toBe(2);
  });
});

describe("the read gate", () => {
  test("an unchanged stat reads no tail, and the reading still ages", async () => {
    const c = clock();
    const { adapter, calls, state } = fakeAdapter("claude");
    state.probe = probe({ lastRequestAt: NOW, observedTtlSeconds: undefined });
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, c.now, { floorMs: 1000 });
    const panes = [pane("claude", "ses-1")];
    await tracker.refresh(panes);
    expect(calls.probe).toBe(1);
    expect(tracker.get("ses-1")?.state).toBe("warm");

    // Nothing written, but enough clock to cross the 300 s window of the pessimistic claude.api rule.
    c.advance(400_000);
    await tracker.refresh(panes);
    expect(calls.probe).toBe(1);
    expect(calls.stat).toBe(2);
    expect(tracker.get("ses-1")?.state).toBe("cold");
  });

  test("a moved stat reads the tail again", async () => {
    const c = clock();
    const { adapter, calls, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, c.now, { floorMs: 1000 });
    const panes = [pane("claude", "ses-1")];
    await tracker.refresh(panes);
    c.advance(2000);
    state.stat = { size: 20, mtimeMs: 200 };
    await tracker.refresh(panes);
    expect(calls.probe).toBe(2);
  });

  test("an unchanged session keeps the model TTL its probe chose, rather than dropping to the tier rule", async () => {
    const c = clock();
    const { adapter, state } = fakeAdapter("codex");
    state.probe = probe({ model: "gpt-5.6-sol" });
    const tracker = new CacheTracker({ codex: adapter }, noOverrides, c.now, { floorMs: 1000 });
    const panes = [pane("codex", "ses-cx")];
    await tracker.refresh(panes);
    expect(tracker.get("ses-cx")?.ttlSeconds).toBe(1800);
    c.advance(2000);
    await tracker.refresh(panes);
    expect(tracker.get("ses-cx")?.ttlSeconds).toBe(1800);
  });
});

describe("a failed read drops the memo, never freezes it", () => {
  test("a stat that throws", async () => {
    const c = clock();
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, c.now, { floorMs: 1000 });
    const panes = [pane("claude", "ses-1")];
    await tracker.refresh(panes);
    expect(tracker.get("ses-1")).toBeDefined();
    c.advance(2000);
    state.statThrows = true;
    await tracker.refresh(panes);
    expect(tracker.get("ses-1")).toBeUndefined();
  });

  test("a log that has gone — resolve answers null", async () => {
    const c = clock();
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, c.now, { floorMs: 1000 });
    const panes = [pane("claude", "ses-1")];
    await tracker.refresh(panes);
    c.advance(2000);
    state.path = null;
    await tracker.refresh(panes);
    expect(tracker.get("ses-1")).toBeUndefined();
  });

  test("a probe that throws", async () => {
    const c = clock();
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, c.now, { floorMs: 1000 });
    const panes = [pane("claude", "ses-1")];
    await tracker.refresh(panes);
    c.advance(2000);
    state.stat = { size: 99, mtimeMs: 999 };
    state.probeThrows = true;
    await tracker.refresh(panes);
    expect(tracker.get("ses-1")).toBeUndefined();
  });

  test("a harness that has written nothing yet simply has no entry", async () => {
    const { adapter } = fakeAdapter("claude");
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, () => NOW);
    await tracker.refresh([pane("claude", "ses-1")]);
    expect(tracker.get("ses-1")).toBeUndefined();
  });

  test("refresh never throws, whatever the seam does", async () => {
    const { adapter, state } = fakeAdapter("claude");
    state.statThrows = true;
    const rules: CacheRuleSource = {
      overrides: async () => {
        throw new Error("unreadable config");
      },
    };
    const tracker = new CacheTracker({ claude: adapter }, rules, () => NOW);
    await tracker.refresh([pane("claude", "ses-1")]);
    expect(tracker.get("ses-1")).toBeUndefined();
  });
});

describe("forgetting", () => {
  test("reaps a session no pane names any more, on the next refresh", async () => {
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, () => NOW);
    await tracker.refresh([pane("claude", "ses-1")]);
    expect(tracker.get("ses-1")).toBeDefined();
    await tracker.refresh([]);
    expect(tracker.get("ses-1")).toBeUndefined();
  });

  test("forget drops exactly the keys it is handed", async () => {
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, noOverrides, () => NOW);
    await tracker.refresh([pane("claude", "ses-1")]);
    tracker.forget(["ses-other"]);
    expect(tracker.get("ses-1")).toBeDefined();
    tracker.forget(["ses-1"]);
    expect(tracker.get("ses-1")).toBeUndefined();
  });
});

describe("the operator override", () => {
  const override: CacheOverride = {
    ruleId: "claude.api",
    ttlSeconds: 7200,
    sourceUrl: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    retrieved: "2026-09-12",
  };

  test("moves the number and marks the reading", async () => {
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe();
    const tracker = new CacheTracker({ claude: adapter }, { overrides: async () => [override] }, () => NOW);
    await tracker.refresh([pane("claude", "ses-1")]);
    expect(tracker.get("ses-1")?.ttlSeconds).toBe(7200);
    expect(tracker.get("ses-1")?.overridden).toBe(true);
  });

  test("is still outranked by a TTL the transcript measured", async () => {
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe({
      observedTtlSeconds: {
        value: 3600,
        confidence: "observed",
        source: { url: "", title: "1h tokens written", publisher: "local telemetry", retrievedAt: "", kind: "observed" },
      },
    });
    const tracker = new CacheTracker({ claude: adapter }, { overrides: async () => [override] }, () => NOW);
    await tracker.refresh([pane("claude", "ses-1")]);
    expect(tracker.get("ses-1")?.ttlSeconds).toBe(3600);
    expect(tracker.get("ses-1")?.overridden).toBeUndefined();
  });

  test("a row for another rule id changes nothing", async () => {
    const { adapter, state } = fakeAdapter("claude");
    state.probe = probe();
    const other = { ...override, ruleId: "codex.api" };
    const tracker = new CacheTracker({ claude: adapter }, { overrides: async () => [other] }, () => NOW);
    await tracker.refresh([pane("claude", "ses-1")]);
    expect(tracker.get("ses-1")?.ttlSeconds).toBe(300);
  });
});

test("a subscription-tier probe takes the longer claude rule", async () => {
  const { adapter, state } = fakeAdapter("claude", { probeTier: "subscription" });
  state.probe = probe();
  const tracker = new CacheTracker({ claude: adapter }, noOverrides, () => NOW);
  await tracker.refresh([pane("claude", "ses-1")]);
  expect(tracker.get("ses-1")?.ruleId).toBe("claude.subscription");
  expect(tracker.get("ses-1")?.ttlSeconds).toBe(3600);
});
