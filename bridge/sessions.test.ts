import { describe, expect, test } from "bun:test";

import {
  deriveConfigRoot,
  discoverSessionSockets,
  herdTagFor,
  SessionRegistry,
  sessionNameFor,
  type SessionFactory,
  type SessionParts,
} from "./sessions.ts";
import type { EngineSnapshot } from "./state-engine.ts";
import type { AgentStatus, AgentView } from "./types.ts";

// sessions.ts is the multi-session core: pure path/name derivation + a registry that spins one
// runtime per herdr session. The path helpers get table coverage; the registry is driven with a fake
// factory (no real socket/fs) so spawn/list/dispose lifecycle is verified purely, per the repo's
// injected-fake convention (see state-engine.test.ts).

// ── pure path helpers ─────────────────────────────────────────────────────────

describe("deriveConfigRoot", () => {
  test("a default-session socket's config root is its own directory", () => {
    expect(deriveConfigRoot("/home/u/.config/herdr/herdr.sock")).toBe("/home/u/.config/herdr");
  });

  test("a named-session socket's config root is the prefix before /sessions/", () => {
    expect(deriveConfigRoot("/home/u/.config/herdr/sessions/demo/herdr.sock")).toBe(
      "/home/u/.config/herdr",
    );
  });
});

describe("sessionNameFor", () => {
  const root = "/home/u/.config/herdr";
  test("the default socket under the config root is named 'default'", () => {
    expect(sessionNameFor(`${root}/herdr.sock`, root)).toBe("default");
  });

  test("a socket under sessions/<name> is named for its directory", () => {
    expect(sessionNameFor(`${root}/sessions/collie-demo/herdr.sock`, root)).toBe("collie-demo");
  });

  test("a named-session HERDR_SOCKET_PATH resolves to that name via its derived root", () => {
    // The primary itself may be a named session (HERDR_SOCKET_PATH points at sessions/<name>).
    const sock = `${root}/sessions/work/herdr.sock`;
    expect(sessionNameFor(sock, deriveConfigRoot(sock))).toBe("work");
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

describe("discoverSessionSockets", () => {
  const root = "/cfg/herdr";

  test("finds the default socket plus each sessions/<name>/herdr.sock that exists", () => {
    const present = new Set([
      `${root}/herdr.sock`,
      `${root}/sessions/alpha/herdr.sock`,
      // 'zeta' dir exists but its socket does not (session cleanly stopped → socket removed).
    ]);
    const found = discoverSessionSockets(
      root,
      (dir) => (dir === `${root}/sessions` ? ["alpha", "zeta"] : []),
      (p) => present.has(p),
    );
    expect(found).toEqual([
      { name: "default", socketPath: `${root}/herdr.sock` },
      { name: "alpha", socketPath: `${root}/sessions/alpha/herdr.sock` },
    ]);
  });

  test("omits the default when its socket is absent (default session not running)", () => {
    const present = new Set([`${root}/sessions/only/herdr.sock`]);
    const found = discoverSessionSockets(
      root,
      () => ["only"],
      (p) => present.has(p),
    );
    expect(found).toEqual([{ name: "only", socketPath: `${root}/sessions/only/herdr.sock` }]);
  });

  test("returns nothing when no sockets exist", () => {
    expect(discoverSessionSockets(root, () => [], () => false)).toEqual([]);
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
  constructor(bridge: "connected" | "disconnected", agents: AgentView[]) {
    this.snap = { agents, shellPanes: [], workspaces: [], tabs: [], bridge };
  }
  parts(): SessionParts {
    const engine = { current: () => this.snap, stop: () => void this.disposed.engine++ };
    const poker = { stop: () => void this.disposed.poker++ };
    const notifications = { clearAll: () => void this.disposed.notifications++ };
    return {
      herdr: {} as unknown as SessionParts["herdr"],
      engine: engine as unknown as SessionParts["engine"],
      poker: poker as unknown as SessionParts["poker"],
      notifications: notifications as unknown as SessionParts["notifications"],
    };
  }
}

interface Harness {
  registry: SessionRegistry;
  fakes: Map<string, FakeSession>;
  spawns: string[];
  setDirs: (d: string[]) => void;
  setPresent: (paths: string[]) => void;
}

function makeRegistry(opts: {
  configRoot?: string;
  primarySocketPath?: string;
  multiSession?: boolean;
  sessionDirs?: string[];
  present?: string[];
  snapshots?: Record<string, { bridge: "connected" | "disconnected"; agents: AgentView[] }>;
} = {}): Harness {
  const configRoot = opts.configRoot ?? "/cfg/herdr";
  const primarySocketPath = opts.primarySocketPath ?? `${configRoot}/herdr.sock`;
  const fakes = new Map<string, FakeSession>();
  const spawns: string[] = [];
  let dirs = opts.sessionDirs ?? [];
  let present = new Set(opts.present ?? []);

  const factory: SessionFactory = (name, _socketPath, _isPrimary) => {
    spawns.push(name);
    const s = opts.snapshots?.[name] ?? { bridge: "connected" as const, agents: [] };
    const fake = new FakeSession(s.bridge, s.agents);
    fakes.set(name, fake);
    return fake.parts();
  };

  const registry = new SessionRegistry({
    configRoot,
    primarySocketPath,
    factory,
    multiSession: opts.multiSession ?? true,
    listSessionDirs: () => dirs,
    exists: (p) => present.has(p),
  });

  return {
    registry,
    fakes,
    spawns,
    setDirs: (d) => (dirs = d),
    setPresent: (paths) => (present = new Set(paths)),
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
      sessionDirs: ["zeta", "alpha"],
      present: [
        "/cfg/herdr/herdr.sock",
        "/cfg/herdr/sessions/zeta/herdr.sock",
        "/cfg/herdr/sessions/alpha/herdr.sock",
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
      sessionDirs: ["down"],
      present: ["/cfg/herdr/herdr.sock", "/cfg/herdr/sessions/down/herdr.sock"],
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

describe("SessionRegistry — refresh() lifecycle", () => {
  test("starts runtimes for newly-appeared sessions and does not respawn the primary", async () => {
    const h = makeRegistry({
      sessionDirs: ["demo"],
      present: ["/cfg/herdr/herdr.sock", "/cfg/herdr/sessions/demo/herdr.sock"],
    });
    await h.registry.refresh();
    // primary spawned at construction; demo spawned on refresh; default NOT respawned though present.
    expect(h.spawns).toEqual(["default", "demo"]);
    expect(h.registry.get("demo")?.name).toBe("demo");
    // Idempotent: a second refresh with the same fs spawns nothing new.
    await h.registry.refresh();
    expect(h.spawns).toEqual(["default", "demo"]);
  });

  test("disposes a session whose socket vanished (engine + poker stopped, notifications cleared)", async () => {
    const h = makeRegistry({
      sessionDirs: ["demo"],
      present: ["/cfg/herdr/herdr.sock", "/cfg/herdr/sessions/demo/herdr.sock"],
    });
    await h.registry.refresh();
    const demo = h.fakes.get("demo")!;
    // Socket removed (session stopped) → next refresh disposes it.
    h.setDirs([]);
    h.setPresent(["/cfg/herdr/herdr.sock"]);
    await h.registry.refresh();
    expect(demo.disposed).toEqual({ engine: 1, poker: 1, notifications: 1 });
    expect(h.registry.get("demo")).toBeUndefined();
  });

  test("never disposes the primary, even when discovery finds nothing", async () => {
    const h = makeRegistry({
      sessionDirs: ["demo"],
      present: ["/cfg/herdr/herdr.sock", "/cfg/herdr/sessions/demo/herdr.sock"],
    });
    await h.registry.refresh();
    const primaryFake = h.fakes.get("default")!;
    // Everything (including the default socket) goes away.
    h.setDirs([]);
    h.setPresent([]);
    await h.registry.refresh();
    expect(h.registry.get()?.name).toBe("default"); // primary still resolvable
    expect(primaryFake.disposed).toEqual({ engine: 0, poker: 0, notifications: 0 });
  });

  test("multi-session off pins to the primary — refresh never scans or spawns", async () => {
    const h = makeRegistry({
      multiSession: false,
      sessionDirs: ["demo"],
      present: ["/cfg/herdr/herdr.sock", "/cfg/herdr/sessions/demo/herdr.sock"],
    });
    await h.registry.refresh();
    expect(h.spawns).toEqual(["default"]); // demo never discovered
    expect(h.registry.get("demo")).toBeUndefined();
    expect(h.registry.list().map((s) => s.name)).toEqual(["default"]);
  });

  test("disposeAll stops every runtime including the primary", async () => {
    const h = makeRegistry({
      sessionDirs: ["demo"],
      present: ["/cfg/herdr/herdr.sock", "/cfg/herdr/sessions/demo/herdr.sock"],
    });
    await h.registry.refresh();
    const primaryFake = h.fakes.get("default")!;
    const demoFake = h.fakes.get("demo")!;
    h.registry.disposeAll();
    expect(primaryFake.disposed).toEqual({ engine: 1, poker: 1, notifications: 1 });
    expect(demoFake.disposed).toEqual({ engine: 1, poker: 1, notifications: 1 });
    expect(h.registry.get()).toBeUndefined();
  });
});
