import { describe, expect, test } from "bun:test";

import {
  ATTENTION_WINDOW_MS,
  StateEngine,
  terminalTitleIsStale,
  type EngineSnapshot,
} from "./state-engine.ts";
import { HerdrMux } from "./mux/herdr/adapter.ts";
import type { HerdrClient, PaneRead } from "./mux/herdr/client.ts";
import type { MuxAdapter, MuxPane } from "./mux/types.ts";
import { toPaneWire } from "./types.ts";
import type { AgentStatus } from "./types.ts";

// HerdrClient carries private socket fields, so no fake can ever *be* one structurally — every fake
// here implements only the handful of read methods the engine actually calls. This is the one place
// that gap is bridged: `Partial<HerdrClient>` keeps the compiler checking each method's signature
// against the real client (a renamed or re-typed method still breaks these tests), and only the
// "the rest is never reached" step is asserted.
//
// The engine talks the mux port, so the fake socket client is wrapped in the REAL Herdr adapter —
// the wire→port mapping the engine's views are built out of is exercised here rather than mocked.
function asMux(fake: Partial<HerdrClient>): MuxAdapter {
  // SAFETY: a StateEngine poll only ever reaches sessionSnapshot / listWorkspaces / listPanes /
  // listTabs, plus readPane for a claude pane's session-name scrape (whose failure the engine
  // already treats as "keep the cached name"). Nothing these tests drive reaches any other member,
  // so the missing ones are unobservable.
  return new HerdrMux(fake as HerdrClient);
}

// The state engine polls the multiplexer, shapes the snapshot, and fires status transitions (which
// drive push notifications). We exercise it with a fake whose returned panes change between polls.

interface FakePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  agent?: string | null;
  agent_status: AgentStatus;
  label?: string | null;
  revision: number;
  agent_session?: { source?: string; agent?: string; kind?: string; value?: string } | null;
  scroll?: {
    offset_from_bottom: number;
    max_offset_from_bottom: number;
    viewport_rows: number;
  } | null;
}

function pane(
  id: string,
  ws: string,
  status: AgentStatus,
  agent: string | null,
  label?: string | null,
): FakePane {
  const p: FakePane = {
    pane_id: id,
    terminal_id: "term",
    workspace_id: ws,
    tab_id: `${ws}:t1`,
    focused: false,
    cwd: "/home/you/demo",
    agent,
    agent_status: status,
    revision: 0,
  };
  // `label` is omitted entirely unless the caller passed one — absent and null are different cases
  // on the wire, and several tests assert on the key's absence.
  if (label !== undefined) p.label = label;
  return p;
}

interface FakeWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
}

interface FakeTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

const ws = (id: string, number: number): FakeWorkspace => ({
  workspace_id: id,
  number,
  label: id,
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: `${id}:t1`,
  agent_status: "idle",
});

class FakeHerdr {
  panes: FakePane[] = [];
  workspaces = [ws("w1", 1), ws("w2", 2)];
  tabs: FakeTab[] = [
    {
      tab_id: "w1:t1",
      workspace_id: "w1",
      number: 1,
      label: "1",
      focused: false,
      pane_count: 1,
      agent_status: "idle",
    },
  ];
  // The default path (herdr ≥ 0.7.2): one snapshot call carries workspaces + panes + tabs.
  sessionSnapshot() {
    return Promise.resolve({
      version: "0.7.2",
      protocol: 16,
      workspaces: this.workspaces,
      tabs: this.tabs,
      panes: this.panes,
    });
  }
  listWorkspaces() {
    return Promise.resolve(this.workspaces);
  }
  listPanes() {
    return Promise.resolve(this.panes);
  }
  listTabs() {
    return Promise.resolve(this.tabs);
  }
}

function makeEngine() {
  const herdr = new FakeHerdr();
  const engine = new StateEngine(asMux(herdr), 1500);
  const transitions: Array<{ pane: string; from: AgentStatus; to: AgentStatus }> = [];
  engine.onTransition((a, from, to) => transitions.push({ pane: a.paneId, from, to }));
  const removed: string[] = [];
  engine.onRemove((paneId) => removed.push(paneId));
  const poll = () => engine["poll"]();
  return { herdr, engine, transitions, removed, poll };
}

describe("StateEngine — transition detection", () => {
  test("does not fire a transition on the first sighting of a pane", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([]);
  });

  test("fires when an agent's status changes between polls", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll(); // first sighting — suppressed
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([{ pane: "w1:p1", from: "working", to: "blocked" }]);
  });

  test("prunes a vanished pane so its return is a fresh first sighting", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // first sighting
    herdr.panes = []; // pane closed
    await poll(); // pruned from prevStatus
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // reappears — must be treated as new, not a transition
    expect(transitions).toEqual([]);
  });
});

describe("StateEngine — removal events", () => {
  test("fires onRemove when a previously-seen agent pane vanishes", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // first sighting — now tracked
    herdr.panes = []; // pane closed
    await poll();
    expect(removed).toEqual(["w1:p1"]);
  });

  test("does not fire onRemove while a pane persists or merely changes status", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")]; // status change, still present
    await poll();
    expect(removed).toEqual([]);
  });

  test("does not fire onRemove for a vanished bare shell pane (never tracked)", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p2", "w1", "unknown", null)]; // shell pane, no agent
    await poll();
    herdr.panes = [];
    await poll();
    expect(removed).toEqual([]);
  });
});

describe("StateEngine — in-flight guard", () => {
  // A Herdr whose snapshot call hangs until released, so we can catch a second tick landing mid-poll.
  class GatedHerdr {
    starts = 0;
    private open: () => void = () => {};
    private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
    constructor(private readonly panes: FakePane[]) {}
    release() {
      this.open();
    }
    async sessionSnapshot() {
      this.starts++;
      await this.gate;
      return { version: "0.7.2", protocol: 16, workspaces: [ws("w1", 1)], tabs: [], panes: this.panes };
    }
  }

  test("skips a tick while the previous poll is still in flight", async () => {
    const herdr = new GatedHerdr([pane("w1:p1", "w1", "idle", "claude")]);
    const engine = new StateEngine(asMux(herdr), 1500);
    const poll = () => engine["poll"]();

    const first = poll(); // starts the poll, hangs on the gate
    await poll(); // second tick — must early-return, not start a second poll
    expect(herdr.starts).toBe(1);

    herdr.release();
    await first;
    expect(herdr.starts).toBe(1);
  });
});

describe("StateEngine — snapshot shaping", () => {
  test("preserves the tab order reported by Herdr", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.tabs = [
      { ...herdr.tabs[0]!, tab_id: "w1:t2", number: 2, label: "second" },
      { ...herdr.tabs[0]!, tab_id: "w1:t1", number: 1, label: "first" },
    ];

    await poll();

    expect(engine.current().tabs.map((tab) => tab.tabId)).toEqual(["w1:t2", "w1:t1"]);
  });

  test("splits agent panes from bare shell panes", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude"), pane("w1:p2", "w1", "unknown", null)];
    await poll();
    const snap = engine.current();
    expect(snap.agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(snap.shellPanes.map((a) => a.paneId)).toEqual(["w1:p2"]);
    expect(snap.shellPanes[0]!.agent).toBe("shell");
    expect(snap.bridge).toBe("connected");
  });

  test("threads a pane label through to the view when set, on agents and shells alike", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w1:p1", "w1", "idle", "claude", "deploy"),
      pane("w1:p2", "w1", "unknown", null, "logs"),
    ];
    await poll();
    const snap = engine.current();
    expect(snap.agents[0]!.paneLabel).toBe("deploy");
    expect(snap.shellPanes[0]!.paneLabel).toBe("logs");
  });

  test("leaves paneLabel absent when the pane has no label (or a null/empty one)", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w1:p1", "w1", "idle", "claude"), // no label field at all
      pane("w1:p2", "w1", "idle", "codex", null), // explicitly null
      pane("w1:p3", "w1", "idle", "codex", ""), // empty string → treated as unset
    ];
    await poll();
    for (const a of engine.current().agents) {
      expect(a.paneLabel).toBeUndefined();
      expect("paneLabel" in a).toBe(false);
    }
  });

  test("sorts agents by urgency (blocked first), then workspace number", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w2:p1", "w2", "idle", "claude"),
      pane("w1:p1", "w1", "blocked", "codex"),
      pane("w2:p2", "w2", "working", "claude"),
    ];
    await poll();
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1", "w2:p2", "w2:p1"]);
  });

  test("marks the bridge disconnected when a poll throws", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(engine.current().bridge).toBe("connected");
    herdr.sessionSnapshot = () => Promise.reject(new Error("socket down"));
    await poll();
    expect(engine.current().bridge).toBe("disconnected");
  });
});

describe("StateEngine — snapshot vs legacy path", () => {
  const drivePoll = (engine: StateEngine) =>
    engine["poll"]();

  const snap = (panes: FakePane[]) => ({
    version: "0.7.2",
    protocol: 16,
    workspaces: [ws("w1", 1)],
    tabs: [],
    panes,
  });

  test("polls via session.snapshot and never touches the list calls when supported", async () => {
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => Promise.resolve(snap([pane("w1:p1", "w1", "idle", "claude")])),
      listWorkspaces: () => ((listCalls++), Promise.resolve([])),
      listPanes: () => ((listCalls++), Promise.resolve([])),
      listTabs: () => ((listCalls++), Promise.resolve([])),
    };
    const engine = new StateEngine(asMux(herdr), 1500);
    await drivePoll(engine);
    expect(listCalls).toBe(0);
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(engine.current().bridge).toBe("connected");
  });

  test("an unknown-variant error falls through to list calls in the SAME tick, then never retries snapshot", async () => {
    let snapCalls = 0;
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => {
        snapCalls++;
        return Promise.reject(
          new Error(
            "herdr session.snapshot: invalid_request: invalid request: unknown variant `session.snapshot`, expected one of `ping`",
          ),
        );
      },
      listWorkspaces: () => ((listCalls++), Promise.resolve([ws("w1", 1)])),
      listPanes: () => Promise.resolve([pane("w1:p1", "w1", "idle", "claude")]),
      listTabs: () => Promise.resolve([]),
    };
    const engine = new StateEngine(asMux(herdr), 1500);
    await drivePoll(engine);
    // Same-tick fallback: one snapshot attempt, then the list path, connected with real data.
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(1);
    expect(engine.current().bridge).toBe("connected");
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    // Permanent: the next tick goes straight to the list path, no wasted snapshot probe.
    await drivePoll(engine);
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(2);
  });

  test("a transient snapshot error does NOT fall back and keeps trying snapshot", async () => {
    let snapCalls = 0;
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => {
        snapCalls++;
        return Promise.reject(new Error("herdr session.snapshot: timed out after 5000ms"));
      },
      listWorkspaces: () => ((listCalls++), Promise.resolve([])),
      listPanes: () => Promise.resolve([]),
      listTabs: () => Promise.resolve([]),
    };
    const engine = new StateEngine(asMux(herdr), 1500);
    await drivePoll(engine);
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(0); // no fallback on a transient error
    expect(engine.current().bridge).toBe("disconnected");
    await drivePoll(engine);
    expect(snapCalls).toBe(2); // still on the snapshot path
    expect(listCalls).toBe(0);
  });
});

describe("StateEngine — session name enrichment", () => {
  // A named claude input box: the rule above the ❯ prompt carries the /rename session name.
  const named = (name: string) => [`──────── ${name} ──`, "❯ "].join("\n");
  // An unnamed input box (plain rule) — no session name to extract.
  const plainBox = ["────────────────", "❯ "].join("\n");

  // A fake herdr that also serves per-pane text, so enrichSessionNames has something to read. The
  // production StateEngine short-circuits when `readPane` is absent (the other fakes here omit it),
  // which is exactly why those tests are unaffected by the enrichment step.
  class NameHerdr {
    panes: FakePane[] = [];
    texts = new Map<string, string>();
    // Every readPane call, verbatim. This read is only harmless because of WHICH source it asks for
    // and how few lines it wants; a fake that swallowed those arguments would let that regress with
    // every test still green.
    reads: Array<Parameters<HerdrClient["readPane"]>> = [];
    sessionSnapshot() {
      return Promise.resolve({ version: "0.7.2", protocol: 16, workspaces: [ws("w1", 1)], tabs: [], panes: this.panes });
    }
    readPane(...args: Parameters<HerdrClient["readPane"]>): Promise<PaneRead> {
      const [paneId] = args;
      this.reads.push(args);
      return Promise.resolve({ pane_id: paneId, text: this.texts.get(paneId) ?? "", truncated: false, revision: 0 });
    }
  }

  function makeNameEngine() {
    const herdr = new NameHerdr();
    const engine = new StateEngine(asMux(herdr), 1500);
    const poll = () => engine["poll"]();
    const agent = (id: string) => engine.current().agents.find((a) => a.paneId === id)!;
    return { herdr, engine, poll, agent };
  }

  test("threads a claude pane's /rename session name onto the view — claude-only", async () => {
    const { herdr, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude"), pane("w1:p2", "w1", "idle", "codex")];
    herdr.texts.set("w1:p1", named("my-feature"));
    herdr.texts.set("w1:p2", named("ignored")); // codex is never read, so never named
    await poll();
    expect(agent("w1:p1").sessionName).toBe("my-feature");
    expect(agent("w1:p2").sessionName).toBeUndefined();
  });

  // The scroll-jump guard. A `recent` read that wants more rows than the pane shows makes Herdr
  // harvest the pages above it, and on a full-screen agent that means scrolling the operator's pane
  // up and back — once per poll, per idle claude pane. Nothing in the types stops the source from
  // drifting back, and CI can't see the symptom: it only shows on a real terminal.
  test("reads the visible grid, never recent", async () => {
    const { herdr, poll } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("pinned"));
    await poll();
    // The count is not the safety-critical half — `visible` clamps to the viewport however large it
    // is — so it is pinned only to keep the whole call in one assertion. Change it freely, here too.
    expect(herdr.reads).toEqual([["w1:p1", "visible", 40, "text"]]);
  });

  test("leaves sessionName absent for an unnamed claude session (plain rule)", async () => {
    const { herdr, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", plainBox);
    await poll();
    expect(agent("w1:p1").sessionName).toBeUndefined();
    expect("sessionName" in agent("w1:p1")).toBe(false);
  });

  test("keeps the last-known name when a later poll can't see the input box (sticky)", async () => {
    const { herdr, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("kept"));
    await poll(); // learns it
    herdr.texts.set("w1:p1", "● Working…\n  ⎿  no input box in view"); // extractor → undefined
    await poll();
    expect(agent("w1:p1").sessionName).toBe("kept");
  });

  test("drops the cached name when the pane vanishes, so a reused id starts clean", async () => {
    const { herdr, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("old"));
    await poll(); // cached
    herdr.panes = [];
    await poll(); // pane gone → cache pruned
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", plainBox); // reappears, now unnamed
    await poll();
    expect(agent("w1:p1").sessionName).toBeUndefined();
  });

  test("a failing pane read never blanks the name or fails the poll", async () => {
    const { herdr, engine, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("safe"));
    await poll();
    herdr.readPane = () => Promise.reject(new Error("read down"));
    await poll();
    expect(agent("w1:p1").sessionName).toBe("safe"); // last-known kept
    expect(engine.current().bridge).toBe("connected"); // the poll itself still succeeded
  });
});

describe("StateEngine — poke / cadence / onUpdate", () => {
  test("onUpdate fires with the fresh snapshot after a successful poll, but not after a failed one", async () => {
    const { herdr, engine, poll } = makeEngine();
    const updates: EngineSnapshot[] = [];
    engine.onUpdate((s) => updates.push(s));
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(updates.length).toBe(1);
    expect(updates[0]!.agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    herdr.sessionSnapshot = () => Promise.reject(new Error("down"));
    await poll();
    expect(updates.length).toBe(1); // failed poll does not notify
  });

  // A snapshot call gated on a manual release, so a poke can land while a poll is in flight.
  class GatedSnapshot {
    calls = 0;
    readonly panes: FakePane[] = [];
    private open: () => void = () => {};
    private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
    release() {
      this.open();
    }
    async sessionSnapshot() {
      this.calls++;
      await this.gate;
      return { version: "0.7.2", protocol: 16, workspaces: [ws("w1", 1)], tabs: [], panes: this.panes };
    }
  }

  test("pokeNow queues exactly one follow-up poll when one is already in flight", async () => {
    const herdr = new GatedSnapshot();
    const engine = new StateEngine(asMux(herdr), 1500);
    // Mark started without the interval firing: drive polls by hand.
    engine["started"] = true;
    const poll = () => engine["poll"]();

    const first = poll(); // calls=1, hangs on the gate
    engine.pokeNow(); // in-flight → queue one follow-up
    engine.pokeNow(); // coalesced into the same single follow-up
    herdr.release();
    await first;
    await Promise.resolve(); // let the drained follow-up poll settle
    await Promise.resolve();
    expect(herdr.calls).toBe(2); // initial + one follow-up, not three
    engine["started"] = false;
  });

  test("pokeNow is a no-op once stopped", async () => {
    const herdr = new GatedSnapshot();
    const engine = new StateEngine(asMux(herdr), 1500);
    engine.pokeNow(); // never started → no-op
    expect(herdr.calls).toBe(0);
  });

  test("setCadence re-arms the interval only when started and changed", async () => {
    const { herdr, engine, poll } = makeEngine();
    const cadence = () => engine["cadenceMs"];
    const timer = () => engine["timer"];

    engine.setCadence(9000); // not started → no-op
    expect(cadence()).toBe(1500);

    // Connect first: a relax ordered before the engine has ever connected is PARKED, not applied
    // (pinned by its own test below), so re-arming has to be asked of a connected engine. This poll
    // runs BEFORE start(), whose own first poll would otherwise still be in flight and make this
    // one a no-op against the in-flight guard.
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();

    engine.start();
    expect(cadence()).toBe(1500);
    const before = timer();
    engine.setCadence(1500); // unchanged → no re-arm
    expect(timer()).toBe(before);
    engine.setCadence(12_000); // changed → re-arm
    expect(cadence()).toBe(12_000);
    expect(timer()).not.toBe(before);
    engine.stop();
  });

  // Relaxing is earned by a connected poll, never granted on the event watch's ack. The ack proves
  // a census answered; it does not prove `snapshot()` succeeded. Relaxing on it alone left a cold
  // start's missed first poll standing for a whole idle interval — 13.1 s, measured on zellij.
  test("a relax ordered before the first connected poll is parked until one lands", async () => {
    const { herdr, engine, poll } = makeEngine();
    const cadence = () => engine["cadenceMs"];
    engine["started"] = true;
    engine.setCadence(12_000); // never connected → parked; the fast cadence keeps retrying
    expect(cadence()).toBe(1500);
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(cadence()).toBe(12_000); // the first connected poll earns it
    engine.stop();
  });

  test("a tighten while a relax is parked discards the parked relax", async () => {
    const { engine, poll } = makeEngine();
    const cadence = () => engine["cadenceMs"];
    engine["started"] = true;
    engine.setCadence(12_000); // parked
    engine.setCadence(1500); // the watch flapped down → fast wins, and the parked relax dies
    await poll();
    expect(cadence()).toBe(1500); // connecting must NOT resurrect it
    engine.stop();
  });
});

// onTick backs the pack's peer sweep (PACK_PROTOCOL.md §10.1: "the peer sweep is a part of the
// existing poll, not a second timer"). Unlike onUpdate it must fire on BOTH outcomes — a lead whose
// own Herdr socket is down must still sweep its peers, so a local outage can never mask a peer's.
describe("StateEngine — onTick", () => {
  test("fires after a successful poll", async () => {
    const { herdr, engine, poll } = makeEngine();
    let calls = 0;
    engine.onTick(() => calls++);
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(calls).toBe(1);
  });

  test("fires after a FAILED poll too — a down local Herdr must not stall the peer sweep", async () => {
    const { herdr, engine, poll } = makeEngine();
    let calls = 0;
    engine.onTick(() => calls++);
    herdr.sessionSnapshot = () => Promise.reject(new Error("down"));
    herdr.listWorkspaces = () => Promise.reject(new Error("down"));
    await poll();
    expect(calls).toBe(1);
  });

  test("the unsubscribe function returned by onTick stops further calls", async () => {
    const { engine, poll } = makeEngine();
    let calls = 0;
    const unsubscribe = engine.onTick(() => calls++);
    await poll();
    expect(calls).toBe(1);
    unsubscribe();
    await poll();
    expect(calls).toBe(1); // unchanged — the listener no longer fires
  });

  test("a listener that throws does not break the poll loop: polling continues and other listeners still fire", async () => {
    const { herdr, engine, poll } = makeEngine();
    let otherCalls = 0;
    engine.onTick(() => {
      throw new Error("boom");
    });
    engine.onTick(() => otherCalls++);
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(otherCalls).toBe(1);
    // The poll loop itself is unharmed: a second poll still completes and updates the snapshot.
    await poll();
    expect(otherCalls).toBe(2);
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
  });

  test("zero listeners is a no-op — a solo instance registers none, and polling behaves exactly as before", async () => {
    const { herdr, engine, poll, transitions } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([{ pane: "w1:p1", from: "working", to: "blocked" }]);
    expect(engine.current().bridge).toBe("connected");
  });
});

// The two capability fields the pane detail view gates on. Both come straight off Herdr's pane
// record, and both must stay ABSENT rather than defaulting when the server doesn't report them —
// an older Herdr should read as "unknown", not as "zero scrollback" or "no transcript".
describe("StateEngine — pane capability fields", () => {
  test("keeps an id-kind agent session (claude, codex)", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    p.agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "abc-123" };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toEqual({ kind: "id", value: "abc-123" });
  });

  // The regression that kept pi journal-less: pi's herdr integration reports `agent_session_path`
  // in preference to an id, and this mapper used to keep ONLY kind "id" — so a pi pane arrived with
  // no session at all and its history could never be offered. Which kinds are meaningful is the
  // journal adapter's call now, not this function's.
  test("keeps a path-kind agent session (pi)", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "pi");
    p.agent_session = {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: "/home/you/.pi/agent/sessions/--repo--/2026-07-29T10-00-00-000Z_abc.jsonl",
    };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toEqual({
      kind: "path",
      value: "/home/you/.pi/agent/sessions/--repo--/2026-07-29T10-00-00-000Z_abc.jsonl",
    });
  });

  // Live-observed on a demo pane: Herdr keeps reporting the LAST session announced for a pane, so
  // relaunching it as a different harness leaves the previous agent's ref behind — a pane running
  // `pi` still advertised a `herdr:claude` id. Routing by pane agent would then hand pi's adapter a
  // Claude uuid.
  test("drops a session ref left behind by a different harness", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "pi");
    p.agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "abc-123" };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toBeUndefined();
  });

  test("keeps a ref from an older Herdr that reports no owning agent", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    p.agent_session = { kind: "id", value: "abc-123" };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toEqual({ kind: "id", value: "abc-123" });
  });

  test.each([
    ["an unrecognised session kind", { kind: "name", value: "my-session" }],
    ["a session with no value", { kind: "id" }],
    ["a session with an empty value", { kind: "id", value: "" }],
    ["no agent_session at all", undefined],
  ])("omits the session for %s", async (_label, session) => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    if (session) p.agent_session = session;
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toBeUndefined();
  });

  test("readableLines is scrollback depth PLUS the viewport (what a recent read can return)", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    p.scroll = { offset_from_bottom: 0, max_offset_from_bottom: 6895, viewport_rows: 51 };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.readableLines).toBe(6946);
  });

  test("an alt-screen pane reports just its viewport — the case that has no scrollback at all", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    p.scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 51 };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.readableLines).toBe(51);
  });

  test("omits readableLines when the server doesn't report scroll (older Herdr)", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(engine.current().agents[0]!.readableLines).toBeUndefined();
  });
});

// A TITLE OUTLIVES THE PROGRAM THAT WROTE IT (MUX_CONTRACT.md § traps).
//
// Live-observed on tmux: pane %3 was running a bare `bash`, and its title still read
// `✳ waiting for soak time - server performance` — the OSC title of a Claude that had exited hours
// earlier. tmux keeps a pane's title after the program goes away, so the two raw facts the adapter
// reports only mean something TOGETHER, which is what this rule reads. It marks; it never deletes.
describe("terminalTitleIsStale", () => {
  function muxPane(fields: Partial<MuxPane>): MuxPane {
    return {
      paneId: "%3",
      spaceId: "$0",
      spaceLabel: "collie",
      spaceNumber: 1,
      tabId: "@0",
      cwd: "/home/dev/collie",
      focused: false,
      alive: true,
      agent: "shell",
      status: "unknown",
      ...fields,
    };
  }

  test("a shell under a title the shell did not write is stale", () => {
    const left = muxPane({ foregroundCommand: "bash", terminalTitle: "✳ waiting for soak time" });
    expect(terminalTitleIsStale(left)).toBe(true);
  });

  test.each(["bash", "zsh", "fish", "sh", "dash", "nu", "pwsh", "/usr/bin/zsh", "BASH"])(
    "%s counts as a shell",
    (command) => {
      expect(terminalTitleIsStale(muxPane({ foregroundCommand: command, terminalTitle: "a task" }))).toBe(true);
    },
  );

  test("a program still running under its own title is not stale", () => {
    const live = muxPane({ foregroundCommand: "claude", terminalTitle: "✳ waiting for soak time" });
    expect(terminalTitleIsStale(live)).toBe(false);
  });

  test("a shell that titles the pane after itself is describing the present", () => {
    expect(terminalTitleIsStale(muxPane({ foregroundCommand: "bash", terminalTitle: "bash" }))).toBe(false);
  });

  test.each([
    ["no title", { foregroundCommand: "bash" }],
    ["an empty title", { foregroundCommand: "bash", terminalTitle: "   " }],
    // Herdr reports no foreground command at all, so no Herdr pane is ever marked stale: there is
    // nothing to read the emptiness as, and guessing would put a mark on a live agent's own title.
    ["no foreground command", { terminalTitle: "✳ waiting for soak time" }],
  ])("%s is never stale", (_label, fields) => {
    expect(terminalTitleIsStale(muxPane(fields))).toBe(false);
  });

  /** A multiplexer that reports exactly the panes it is handed. */
  function muxOf(panes: readonly MuxPane[]): MuxAdapter {
    // SAFETY: a poll over a herd of bare SHELLS reaches `snapshot()` and nothing else — the
    // session-name scrape runs only for a claude pane, and none of these is one. The members left
    // off are unobservable here.
    const stub: Partial<MuxAdapter> = {
      reachable: () => Promise.resolve(true),
      snapshot: () => Promise.resolve({ panes, spaces: [], tabs: [] }),
    };
    // SAFETY: see above — every member this poll can reach is present on `stub`.
    return stub as MuxAdapter;
  }

  test("the mark reaches the view, and the title itself goes on the wire untouched", async () => {
    const stale = muxPane({ foregroundCommand: "bash", terminalTitle: "✳ waiting for soak time" });
    const engine = new StateEngine(muxOf([stale]), 1500);
    await engine["poll"]();
    const view = engine.current().shellPanes[0]!;
    expect(view.terminalTitle).toBe("✳ waiting for soak time");
    expect(view.terminalTitleStale).toBe(true);
  });

  test("a live program's title reaches the view with the flag ABSENT, not false", async () => {
    const live = muxPane({ foregroundCommand: "claude", terminalTitle: "✳ waiting for soak time" });
    const engine = new StateEngine(muxOf([live]), 1500);
    await engine["poll"]();
    const view = engine.current().shellPanes[0]!;
    expect(view.terminalTitle).toBe("✳ waiting for soak time");
    // Absent, exactly as every other optional field on the wire is when it has nothing to say.
    expect("terminalTitleStale" in view).toBe(false);
  });
});

// ATTENTION — the one fact the bridge knows and the multiplexer cannot: is somebody looking?
//
// It is read by a censusing adapter's watch (mux/types.ts § MuxWatchOptions.attention), so getting
// it wrong is not visible as a failure: it is visible as a phone that feels slow, or as a host
// spending a process every 1.5 s for nobody. Both directions are pinned here.
describe("StateEngine — attention", () => {
  const NOW = 1_700_000_000_000;

  test("a bridge nobody has read is idle — a restart must not spend a fast census on an empty room", () => {
    const { engine } = makeEngine();
    expect(engine.attention(NOW)).toBe("idle");
  });

  test("a read makes it watched, and it stays watched for the whole window", () => {
    const { engine } = makeEngine();
    engine.noteAttention(NOW);
    expect(engine.attention(NOW)).toBe("watched");
    expect(engine.attention(NOW + ATTENTION_WINDOW_MS)).toBe("watched");
  });

  test("one millisecond past the window it is idle again", () => {
    const { engine } = makeEngine();
    engine.noteAttention(NOW);
    expect(engine.attention(NOW + ATTENTION_WINDOW_MS + 1)).toBe("idle");
  });

  test("a later read extends it — a phone polling every four seconds never flickers", () => {
    const { engine } = makeEngine();
    engine.noteAttention(NOW);
    engine.noteAttention(NOW + 4000);
    expect(engine.attention(NOW + ATTENTION_WINDOW_MS + 1)).toBe("watched");
  });
});

// THE PANE A DEAD AGENT LEFT BEHIND (M11/03) — a shell to the operator, a journal key to the bridge.
//
// The decorator stops naming an agent the moment its beacon expires, and hands the pane the harness
// that wrote the ref instead (`MuxPane.sessionAgent`). Two things have to hold at this layer: the
// pane sorts as a SHELL, and neither the ref nor its harness reaches the wire — a History affordance
// on a pane the herd calls a shell is the same ghost in a smaller shape.
describe("StateEngine — an expired agent's pane", () => {
  const deadAgentPane: MuxPane = {
    paneId: "%9",
    spaceId: "$0",
    spaceLabel: "collie",
    spaceNumber: 1,
    tabId: "@0",
    cwd: "/home/dev/collie",
    focused: false,
    alive: true,
    // What the decorator leaves: no agent, no status claim.
    agent: "shell",
    status: "unknown",
    agentSession: { kind: "id", value: "abc-123" },
    sessionAgent: "claude",
  };

  /** A multiplexer reporting exactly that one pane. */
  function engineOver(only: MuxPane): StateEngine {
    const stub: Partial<MuxAdapter> = {
      reachable: () => Promise.resolve(true),
      snapshot: () => Promise.resolve({ panes: [only], spaces: [], tabs: [] }),
    };
    // SAFETY: a poll over a herd of one SHELL reaches `reachable()` and `snapshot()` and nothing
    // else — the session-name scrape runs for claude panes only, and this pane names no agent at
    // all. Every member left off `stub` is unobservable here.
    return new StateEngine(stub as MuxAdapter, 1500);
  }

  test("it is listed as a shell, not as an agent of unknown status", async () => {
    const engine = engineOver(deadAgentPane);
    await engine["poll"]();
    const snap = engine.current();
    expect(snap.agents).toEqual([]);
    expect(snap.shellPanes.map((view) => view.paneId)).toEqual(["%9"]);
    expect(snap.shellPanes[0]!.kind).toBe("shell");
  });

  test("its journal key survives the poll, server-side", async () => {
    const engine = engineOver(deadAgentPane);
    await engine["poll"]();
    const view = engine.current().shellPanes[0]!;
    expect(view.agentSession).toEqual({ kind: "id", value: "abc-123" });
    expect(view.sessionAgent).toBe("claude");
  });

  test("and reaches the wire as a plain shell pane — no key, no History affordance", async () => {
    const engine = engineOver(deadAgentPane);
    await engine["poll"]();
    // `hasJournal` is the real registry's shape — it knows claude and nothing else — so the flag
    // would light if the strip keyed off the DEAD agent's harness instead of the pane's own.
    // Membership asked with `hasOwn`: an absent key, not an undefined value.
    const wire = toPaneWire(engine.current().shellPanes[0]!, (agent) => agent === "claude");
    expect(Object.hasOwn(wire, "agentSession")).toBe(false);
    expect(Object.hasOwn(wire, "sessionAgent")).toBe(false);
    expect(wire.hasSession).toBeUndefined();
  });
});
