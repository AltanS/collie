import { describe, expect, test } from "bun:test";

import { muxOk, muxUnsupported, type MuxSession } from "./mux/types.ts";
import {
  herdTagFor,
  SessionRegistry,
  sessionNameFor,
  type SessionFactory,
  type SessionParts,
  widenedPanes,
} from "./sessions.ts";
import type { EngineSnapshot } from "./state-engine.ts";
import type { AgentStatus, AgentView } from "./types.ts";

// sessions.ts is the multi-session core: the naming rule + a registry that spins one runtime per
// session the MULTIPLEXER reports. The naming rule gets table coverage; the registry is driven with
// a fake factory whose adapter answers `listSessions` (no real socket, no fs) so the
// spawn/list/dispose lifecycle is verified purely, per the repo's injected-fake convention (see
// state-engine.test.ts). Herdr's own socket layout is proved in bridge/mux/herdr/sessions.test.ts,
// which is where it moved with the capability (M22/02).

/**
 * Every member of {@link SessionParts} is a class with private fields, so no fake can ever *be* one
 * structurally. `Partial<T>` keeps the compiler checking each method a fake DOES supply against the
 * real class; only the "the rest is never reached" step is asserted.
 */
function stubPart<T>(impl: Partial<T>): T {
  // SAFETY: the registry only ever calls `engine.current()` and the `stop()`/`clearAll()` disposal
  // hooks — all implemented below. `herdr` is stored and handed back, never called, on these paths.
  return impl as T;
}

// ── the naming rule ───────────────────────────────────────────────────────────

describe("sessionNameFor", () => {
  const root = "/home/u/.config/herdr";
  test("the default socket under the config root is named 'default'", () => {
    expect(sessionNameFor(`${root}/herdr.sock`, root)).toBe("default");
  });

  test("a socket under sessions/<name> is named for its directory", () => {
    expect(sessionNameFor(`${root}/sessions/collie-demo/herdr.sock`, root)).toBe("collie-demo");
  });

  test("a named-session primary resolves to that name against its own root", () => {
    // The primary itself may be a named session (HERDR_SOCKET_PATH points at sessions/<name>).
    expect(sessionNameFor(`${root}/sessions/work/herdr.sock`, root)).toBe("work");
  });
});

describe("herdTagFor", () => {
  test("the primary keeps the bare collie:herd tag", () => {
    expect(herdTagFor(true, "default")).toBe("collie:herd");
  });
  test("a non-primary session tags collie:herd:<name>", () => {
    expect(herdTagFor(false, "collie-demo")).toBe("collie:herd:collie-demo");
  });
});

// ── SessionRegistry (fake factory) ─────────────────────────────────────────────

const agent = (paneId: string, status: AgentStatus): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "w1",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status,
  cwd: "/x",
  focused: false,
  kind: "agent",
});

/** A stand-in runtime: a controllable engine snapshot + stop/clearAll spies (no real socket). */
class FakeSession {
  readonly disposed = { engine: 0, poker: 0, notifications: 0 };
  snap: EngineSnapshot;
  constructor(
    bridge: "connected" | "disconnected",
    agents: AgentView[],
    /** What this session's adapter answers `listSessions` with, the registry's only discovery. */
    private readonly sessions: () => ReturnType<SessionParts["herdr"]["listSessions"]> = () =>
      Promise.resolve(muxOk([])),
  ) {
    this.snap = { agents, shellPanes: [], workspaces: [], tabs: [], bridge };
  }
  parts(): SessionParts {
    const engine = { current: () => this.snap, stop: () => void this.disposed.engine++ };
    const poker = { stop: () => void this.disposed.poker++ };
    const notifications = { clearAll: () => void this.disposed.notifications++ };
    return {
      herdr: stubPart<SessionParts["herdr"]>({ listSessions: () => this.sessions() }),
      engine: stubPart<SessionParts["engine"]>(engine),
      poker: stubPart<SessionParts["poker"]>(poker),
      notifications: stubPart<SessionParts["notifications"]>(notifications),
    };
  }
}

interface Harness {
  registry: SessionRegistry;
  fakes: Map<string, FakeSession>;
  spawns: string[];
  /** The endpoints the primary's adapter reports next time `refresh()` asks. */
  setSessions: (sessions: readonly MuxSession[]) => void;
  /** Make the primary's adapter refuse the capability, as tmux and zellij do. */
  refuse: () => void;
}

function makeRegistry(opts: {
  configRoot?: string;
  primarySocketPath?: string;
  multiSession?: boolean;
  /** What the primary's adapter reports. Absent = nothing but the primary itself. */
  sessions?: readonly MuxSession[];
  /** The adapter declares the capability absent and refuses the call. */
  unsupported?: boolean;
  snapshots?: Record<string, { bridge: "connected" | "disconnected"; agents: AgentView[] }>;
} = {}): Harness {
  const configRoot = opts.configRoot ?? "/cfg/herdr";
  const primarySocketPath = opts.primarySocketPath ?? `${configRoot}/herdr.sock`;
  const fakes = new Map<string, FakeSession>();
  const spawns: string[] = [];
  let sessions: readonly MuxSession[] = opts.sessions ?? [];
  let refused = opts.unsupported ?? false;
  const answer = (): ReturnType<SessionParts["herdr"]["listSessions"]> =>
    Promise.resolve(refused ? muxUnsupported("listSessions", "test stub") : muxOk(sessions));

  const factory: SessionFactory = (name, _socketPath, _isPrimary) => {
    spawns.push(name);
    const s = opts.snapshots?.[name] ?? { bridge: "connected" as const, agents: [] };
    const fake = new FakeSession(s.bridge, s.agents, answer);
    fakes.set(name, fake);
    return fake.parts();
  };

  const registry = new SessionRegistry({
    configRoot,
    primarySocketPath,
    factory,
    multiSession: opts.multiSession ?? true,
  });

  return {
    registry,
    fakes,
    spawns,
    setSessions: (next) => (sessions = next),
    refuse: () => (refused = true),
  };
}

describe("SessionRegistry — construction & lookup", () => {
  test("spawns the primary eagerly and resolves it by absent/empty name and by its registry name", () => {
    const h = makeRegistry();
    expect(h.spawns).toEqual(["default"]);
    expect(h.registry.primary).toBe("default");
    const primary = h.registry.get();
    expect(primary?.isPrimary).toBe(true);
    expect(h.registry.get("")).toBe(primary); // empty string → primary, not a lookup miss
    expect(h.registry.get("default")).toBe(primary);
  });

  test("an unknown session name resolves to undefined (never a path)", () => {
    const h = makeRegistry();
    expect(h.registry.get("../../etc")).toBeUndefined();
    expect(h.registry.get("nope")).toBeUndefined();
  });

  test("a named-session primary keeps its own name and is still the default lookup", () => {
    const h = makeRegistry({ primarySocketPath: "/cfg/herdr/sessions/work/herdr.sock" });
    expect(h.registry.primary).toBe("work");
    expect(h.registry.get()?.name).toBe("work");
    expect(h.registry.get("work")).toBe(h.registry.get());
  });
});

describe("SessionRegistry — list()", () => {
  test("orders primary first then alphabetical, with per-session working/blocked counts", async () => {
    const h = makeRegistry({
      sessions: [
        { name: "default", endpoint: "/cfg/herdr/herdr.sock" },
        { name: "zeta", endpoint: "/cfg/herdr/sessions/zeta/herdr.sock" },
        { name: "alpha", endpoint: "/cfg/herdr/sessions/alpha/herdr.sock" },
      ],
      snapshots: {
        default: { bridge: "connected", agents: [agent("d1", "blocked"), agent("d2", "idle")] },
        alpha: { bridge: "connected", agents: [agent("a1", "working")] },
        zeta: { bridge: "connected", agents: [agent("z1", "blocked"), agent("z2", "working")] },
      },
    });
    await h.registry.refresh();
    expect(h.registry.list()).toEqual([
      { name: "default", isPrimary: true, reachable: true, agents: 2, working: 0, blocked: 1 },
      { name: "alpha", isPrimary: false, reachable: true, agents: 1, working: 1, blocked: 0 },
      { name: "zeta", isPrimary: false, reachable: true, agents: 2, working: 1, blocked: 1 },
    ]);
  });

  test("an unreachable session reports reachable:false and zeroed counts", async () => {
    const h = makeRegistry({
      sessions: [
        { name: "default", endpoint: "/cfg/herdr/herdr.sock" },
        { name: "down", endpoint: "/cfg/herdr/sessions/down/herdr.sock" },
      ],
      snapshots: {
        // Stale last-known agents, but the last poll failed → treated as unreachable with 0 counts.
        down: { bridge: "disconnected", agents: [agent("x1", "blocked")] },
      },
    });
    await h.registry.refresh();
    const down = h.registry.list().find((s) => s.name === "down");
    expect(down).toEqual({
      name: "down",
      isPrimary: false,
      reachable: false,
      agents: 0,
      working: 0,
      blocked: 0,
    });
  });
});

describe("SessionRegistry — ordered()", () => {
  // `all()` is INSERTION order, i.e. whichever session the multiplexer reported first, and it
  // changes as sessions come and go. That is fine for a fan-out, where order is not observable, and
  // wrong for anything a phone renders — a widened pane list would re-sort itself under the reader
  // (DESIGN.md §2). This is the order `list()` already published, factored out so the summaries and
  // the panes they describe cannot disagree.
  test("is primary-first then alphabetical, whatever order discovery found them in", async () => {
    const h = makeRegistry({
      sessions: [
        { name: "default", endpoint: "/cfg/herdr/herdr.sock" },
        { name: "zeta", endpoint: "/cfg/herdr/sessions/zeta/herdr.sock" },
        { name: "alpha", endpoint: "/cfg/herdr/sessions/alpha/herdr.sock" },
        { name: "mid", endpoint: "/cfg/herdr/sessions/mid/herdr.sock" },
      ],
    });
    await h.registry.refresh();
    expect(h.registry.ordered().map((rt) => rt.name)).toEqual(["default", "alpha", "mid", "zeta"]);
    // …and it is the SAME order the summaries publish. Two orders would put a pane under the wrong
    // heading the first time anything read them together.
    expect(h.registry.list().map((s) => s.name)).toEqual(h.registry.ordered().map((rt) => rt.name));
  });
});

describe("widenedPanes", () => {
  /** The narrowest thing the function's constraint accepts plus an id to tell two of them apart. */
  interface Pane {
    paneId: string;
    session?: string;
  }

  // EVERY pane is tagged, including the primary session's. The tempting alternative — tag only the
  // non-primary ones, so "absent means primary" — makes an untagged pane mean two different things
  // depending on whether the body was widened, while the client deliberately lets an untagged pane
  // match any scope so solo lookups stay exactly today's. Together those two rules let a primary
  // pane answer a lookup for a named session's identically-numbered pane. All, or none.
  test("stamps every pane with its own session, primary included", () => {
    expect(
      widenedPanes<Pane>([
        { name: "default", panes: [{ paneId: "w1:p1" }, { paneId: "w1:p2" }] },
        { name: "work", panes: [{ paneId: "w1:p1" }] },
      ]),
    ).toEqual([
      { paneId: "w1:p1", session: "default" },
      { paneId: "w1:p2", session: "default" },
      { paneId: "w1:p1", session: "work" },
    ]);
  });

  // The collision this exists to survive: `w1:p1` is a different pane in every session, exactly as
  // it is on every machine. After widening the two are distinguishable by the tag and by nothing
  // else — the ids are byte-identical.
  test("keeps colliding pane ids apart, and preserves the order it was given", () => {
    const out = widenedPanes<Pane>([
      { name: "work", panes: [{ paneId: "w1:p1" }] },
      { name: "default", panes: [{ paneId: "w1:p1" }] },
    ]);
    expect(out.map((p) => p.session)).toEqual(["work", "default"]);
    expect(new Set(out.map((p) => p.paneId)).size).toBe(1);
  });

  test("an empty session contributes nothing, and no sessions contribute an empty list", () => {
    expect(widenedPanes<Pane>([{ name: "quiet", panes: [] }])).toEqual([]);
    expect(widenedPanes<Pane>([])).toEqual([]);
  });

  // It COPIES. A pane in the registry's own snapshot must not gain a field because somebody asked
  // for a widened read — the next unwidened poll would then carry a session tag it never asked for.
  test("does not mutate the panes it was handed", () => {
    const pane: Pane = { paneId: "w1:p1" };
    widenedPanes<Pane>([{ name: "work", panes: [pane] }]);
    expect(pane).toEqual({ paneId: "w1:p1" });
  });
});

describe("SessionRegistry — refresh() lifecycle", () => {
  /** What a herdr adapter reports for a box running the default session plus one named `demo`. */
  const TWO: readonly MuxSession[] = [
    { name: "default", endpoint: "/cfg/herdr/herdr.sock" },
    { name: "demo", endpoint: "/cfg/herdr/sessions/demo/herdr.sock" },
  ];
  const ONE: readonly MuxSession[] = [{ name: "default", endpoint: "/cfg/herdr/herdr.sock" }];

  test("starts runtimes for newly-appeared sessions and does not respawn the primary", async () => {
    const h = makeRegistry({ sessions: TWO });
    await h.registry.refresh();
    // primary spawned at construction; demo spawned on refresh; default NOT respawned though listed.
    expect(h.spawns).toEqual(["default", "demo"]);
    expect(h.registry.get("demo")?.name).toBe("demo");
    // Idempotent: a second refresh with the same answer spawns nothing new.
    await h.registry.refresh();
    expect(h.spawns).toEqual(["default", "demo"]);
  });

  test("a discovered session is built against the endpoint the adapter reported", async () => {
    const h = makeRegistry({ sessions: TWO });
    await h.registry.refresh();
    expect(h.registry.get("demo")?.socketPath).toBe("/cfg/herdr/sessions/demo/herdr.sock");
  });

  test("disposes a session the multiplexer stopped reporting (engine + poker stopped, notifications cleared)", async () => {
    const h = makeRegistry({ sessions: TWO });
    await h.registry.refresh();
    const demo = h.fakes.get("demo")!;
    // The session stopped, so it is out of the answer → next refresh disposes it.
    h.setSessions(ONE);
    await h.registry.refresh();
    expect(demo.disposed).toEqual({ engine: 1, poker: 1, notifications: 1 });
    expect(h.registry.get("demo")).toBeUndefined();
  });

  test("never disposes the primary, even when discovery finds nothing", async () => {
    const h = makeRegistry({ sessions: TWO });
    await h.registry.refresh();
    const primaryFake = h.fakes.get("default")!;
    // An EMPTY list is a real answer: everything, the primary's own endpoint included, is gone.
    h.setSessions([]);
    await h.registry.refresh();
    expect(h.registry.get()?.name).toBe("default"); // primary still resolvable
    expect(primaryFake.disposed).toEqual({ engine: 0, poker: 0, notifications: 0 });
  });

  test("an adapter that declares the capability absent pins the registry to the primary", async () => {
    // tmux and zellij: the call is answered, with the contract's `unsupported`, and the registry
    // keeps exactly the session it was built with. Nothing is disposed and nothing is spawned.
    const h = makeRegistry({ sessions: TWO, unsupported: true });
    await h.registry.refresh();
    expect(h.spawns).toEqual(["default"]);
    expect(h.registry.get("demo")).toBeUndefined();
    expect(h.registry.list().map((s) => s.name)).toEqual(["default"]);
  });

  test("a refusal that arrives later leaves what is already running alone", async () => {
    const h = makeRegistry({ sessions: TWO });
    await h.registry.refresh();
    const demo = h.fakes.get("demo")!;
    h.refuse();
    await h.registry.refresh();
    // A refusal is not an empty list: it says "there is no list", so it cannot mean "dispose demo".
    expect(h.registry.get("demo")?.name).toBe("demo");
    expect(demo.disposed).toEqual({ engine: 0, poker: 0, notifications: 0 });
  });

  test("multi-session off pins to the primary, refresh asks nothing and spawns nothing", async () => {
    const h = makeRegistry({ multiSession: false, sessions: TWO });
    await h.registry.refresh();
    expect(h.spawns).toEqual(["default"]); // demo never discovered
    expect(h.registry.get("demo")).toBeUndefined();
    expect(h.registry.list().map((s) => s.name)).toEqual(["default"]);
  });

  test("disposeAll stops every runtime including the primary", async () => {
    const h = makeRegistry({ sessions: TWO });
    await h.registry.refresh();
    const primaryFake = h.fakes.get("default")!;
    const demoFake = h.fakes.get("demo")!;
    h.registry.disposeAll();
    expect(primaryFake.disposed).toEqual({ engine: 1, poker: 1, notifications: 1 });
    expect(demoFake.disposed).toEqual({ engine: 1, poker: 1, notifications: 1 });
    expect(h.registry.get()).toBeUndefined();
  });
});
