// A foreground that trails (2026-11-24): where the multiplexer answers a pane's foreground from its last
// snapshot (herdr-core), an agent typed into the pane's shell sends its start edge before that snapshot names
// it. The router holds such an edge for the target's `foregroundLagMs` and applies it, in order with the later
// edges of the same process and with its own take time, once the foreground names the pid. A pid that never
// shows is dropped once after the bound; a target with no lag drops at once, as before.

import { describe, expect, test } from "bun:test";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import type { BeaconLiveness } from "../beacon/reader.ts";
import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "../beacon/types.ts";
import type { EdgeSpool } from "../beacon-io.ts";
import { EdgeRouter, HELD_EDGES_MAX, type DropReason, type EdgeTarget, type PlacedEdge, type SavedSource, type SourceStore } from "./edges.ts";

const PID = 4242;
const OTHER = 5151;
const SHELL = 3030;
const START = 777;
const SOCKET = "/run/mux.sock";
const LAG = 3000;
const T0 = 1_000_000;

function record(over: Partial<EdgeRecord> = {}): EdgeRecord {
  return { schemaVersion: EDGE_SCHEMA_VERSION, harness: "claude", event: "UserPromptSubmit", detail: null, pid: PID, pidStartTime: START, markers: [{ namespace: "mux", scope: SOCKET, pane: "w1:p1" }], at: T0, promptHash: null, ...over };
}

const startEdge = (over: Partial<EdgeRecord> = {}) => record({ event: "SessionStart", detail: "startup", source: "startup", session: "s1", model: "model-a", ...over });
const promptEdge = (over: Partial<EdgeRecord> = {}) => record({ event: "UserPromptSubmit", promptHash: "a".repeat(64), session: "s1", at: T0 + 10, ...over });

const matcher: BeaconMatcher = {
  namespace: "mux",
  scope: () => Promise.resolve(SOCKET),
  matches: (pane, m, s) => m.scope === s && m.pane === pane.paneId,
  notesWithoutHooks: { agentDetection: "-", agentSessionRef: "-" },
};
const alive: BeaconLiveness = { startTimeOf: (pid) => Promise.resolve(pid === PID || pid === OTHER || pid === SHELL ? START : null) };

class FakeSpool implements EdgeSpool {
  files: string[] = [];
  take(): Promise<readonly string[]> {
    const out = this.files;
    this.files = [];
    return Promise.resolve(out);
  }
}

/** A store that keeps nothing: the same as no store for these tests. */
const NO_STORE: SourceStore = { load: () => [], save: () => undefined };

interface RigOptions {
  readonly lag?: number;
  readonly store?: SourceStore;
}

/** One session, two panes; each pane's reported foreground is a list a test moves by hand. */
function rig(options: RigOptions = {}) {
  const spool = new FakeSpool();
  const clock = { now: T0 + 100 };
  const fg = new Map<string, number[]>([
    ["w1:p1", [SHELL]],
    ["w1:p2", [OTHER]],
  ]);
  const delivered: { paneId: string; edge: PlacedEdge }[] = [];
  const drops: { pid: number | null; reason: DropReason }[] = [];
  const foreign: number[] = [];
  const lines: string[] = [];
  const target: EdgeTarget = {
    session: "main",
    matcher,
    paneIds: () => ["w1:p1", "w1:p2"],
    foreground: (paneId) => Promise.resolve({ ok: true as const, value: (fg.get(paneId) ?? []).map((pid) => ({ argv: ["x"], pid })) }),
    foregroundLagMs: options.lag ?? 0,
    deliver: (paneId, edge) => void delivered.push({ paneId, edge }),
  };
  const r = new EdgeRouter({
    spool,
    store: options.store ?? NO_STORE,
    liveness: alive,
    targets: () => [target],
    onDrop: (rec, reason) => void drops.push({ pid: rec?.pid ?? null, reason }),
    onForeign: (_pane, pid) => void foreign.push(pid),
    log: (line) => void lines.push(line),
    now: () => clock.now,
  });
  const push = (rec: EdgeRecord) => void spool.files.push(JSON.stringify(rec));
  /** One take, `ms` later on the router's clock. */
  const tick = async (ms = 200) => {
    clock.now += ms;
    await r.tick();
  };
  const events = () => delivered.map((d) => `${d.paneId}:${d.edge.record.event}`);
  return { r, fg, clock, delivered, drops, foreign, lines, push, tick, events };
}

describe("a held edge is applied once the foreground names its pid", () => {
  test("lag by one take: the start and the prompt of one process both apply, in order, as an unlagged run gives", async () => {
    const lagged = rig({ lag: LAG });
    lagged.push(startEdge());
    lagged.push(promptEdge());
    await lagged.tick();
    expect(lagged.delivered).toEqual([]);
    expect(lagged.drops).toEqual([]);
    expect(lagged.r.agentSessionOf("main", "w1:p1")).toBeUndefined();
    lagged.fg.set("w1:p1", [PID]);
    await lagged.tick();
    expect(lagged.events()).toEqual(["w1:p1:SessionStart", "w1:p1:UserPromptSubmit"]);
    expect(lagged.delivered.map((d) => d.edge.kind)).toEqual(["start", "prompt"]);

    const live = rig({ lag: LAG });
    live.fg.set("w1:p1", [PID]);
    live.push(startEdge());
    live.push(promptEdge());
    await live.tick();
    expect(live.events()).toEqual(lagged.events());
    for (const { r } of [lagged, live]) {
      expect(r.agentSessionOf("main", "w1:p1")).toEqual({ current: "s1", previous: null });
      expect(r.modelOf("main", "w1:p1")).toEqual({ model: "model-a", at: T0 });
      expect(r.noPromptYet("main", "w1:p1")).toBe(false);
      expect(r.hooksOf("main", "w1:p1")).toBe("live");
    }
    expect(lagged.drops).toEqual([]);
  });

  test("lag by several takes, edges arriving across them: order kept, each with the time it was first taken", async () => {
    const t = rig({ lag: LAG });
    t.push(startEdge());
    await t.tick();
    const firstTake = t.clock.now;
    t.push(promptEdge());
    await t.tick();
    const secondTake = t.clock.now;
    await t.tick();
    await t.tick();
    expect(t.delivered).toEqual([]);
    t.fg.set("w1:p1", [PID]);
    await t.tick();
    expect(t.events()).toEqual(["w1:p1:SessionStart", "w1:p1:UserPromptSubmit"]);
    expect(t.delivered.map((d) => d.edge.at)).toEqual([firstTake, secondTake]);
    expect(t.lines.some((line) => line.includes("event=SessionStart") && line.includes("held=800ms"))).toBe(true);
    // A later edge of the same process, now the foreground, places at once.
    t.push(record({ event: "Stop", at: T0 + 20 }));
    await t.tick();
    expect(t.events().at(-1)).toBe("w1:p1:Stop");
  });

  test("a held start alone sets the no-prompt-yet latch and the session, as a placed one does", async () => {
    const t = rig({ lag: LAG });
    t.push(startEdge());
    await t.tick();
    expect(t.r.noPromptYet("main", "w1:p1")).toBe(false);
    t.fg.set("w1:p1", [SHELL, PID]);
    await t.tick();
    expect(t.r.noPromptYet("main", "w1:p1")).toBe(true);
    expect(t.r.agentSessionOf("main", "w1:p1")).toEqual({ current: "s1", previous: null });
  });

  test("a held resume start keeps its session ahead of the prompt that follows", async () => {
    const t = rig({ lag: LAG });
    t.push(startEdge({ detail: "resume", source: "resume", session: "old" }));
    t.push(promptEdge({ session: "old" }));
    await t.tick();
    t.fg.set("w1:p1", [PID]);
    await t.tick();
    expect(t.events()).toEqual(["w1:p1:SessionStart", "w1:p1:UserPromptSubmit"]);
    expect(t.r.agentSessionOf("main", "w1:p1")).toEqual({ current: "old", previous: null });
    expect(t.r.noPromptYet("main", "w1:p1")).toBe(false);
  });
});

describe("a pid that never becomes the foreground", () => {
  test("is dropped after the bound, with the usual line once, and its process is never held again", async () => {
    const t = rig({ lag: LAG });
    t.push(startEdge());
    t.push(promptEdge());
    await t.tick();
    for (let i = 0; i < 13; i += 1) await t.tick();
    expect(t.drops).toEqual([]);
    await t.tick(LAG);
    expect(t.delivered).toEqual([]);
    expect(t.drops).toEqual([
      { pid: PID, reason: "not-foreground" },
      { pid: PID, reason: "not-foreground" },
    ]);
    expect(t.foreign).toEqual([PID, PID]);
    expect(t.lines.filter((line) => line.includes("surface.edge.dropped"))).toEqual([`[surface] surface.edge.dropped reason=not-foreground event=SessionStart pid=${String(PID)}`]);
    // The next edge of that process drops in the same take it is taken.
    t.push(record({ event: "Stop", at: T0 + 20 }));
    await t.tick();
    expect(t.drops.length).toBe(3);
    expect(t.foreign.length).toBe(3);
    expect(t.r.hooksOf("main", "w1:p1")).toBe("none");
  });

  test("a target with no lag drops at once, as before", async () => {
    const t = rig();
    t.push(startEdge());
    await t.tick();
    expect(t.drops).toEqual([{ pid: PID, reason: "not-foreground" }]);
    t.fg.set("w1:p1", [PID]);
    await t.tick();
    expect(t.delivered).toEqual([]);
  });

  test("another refusal is not held: a dead pid drops at once", async () => {
    const t = rig({ lag: LAG });
    t.push(record({ pid: 9999 }));
    await t.tick();
    expect(t.drops).toEqual([{ pid: 9999, reason: "dead-pid" }]);
  });
});

describe("holding is bounded and local to one process", () => {
  test("an unrelated pane's edges, and another process, are not delayed", async () => {
    const t = rig({ lag: LAG });
    t.push(startEdge());
    t.push(record({ pid: OTHER, event: "SessionStart", source: "startup", session: "s2", markers: [{ namespace: "mux", scope: SOCKET, pane: "w1:p2" }] }));
    t.push(promptEdge());
    t.push(record({ pid: OTHER, event: "UserPromptSubmit", session: "s2", markers: [{ namespace: "mux", scope: SOCKET, pane: "w1:p2" }] }));
    await t.tick();
    expect(t.events()).toEqual(["w1:p2:SessionStart", "w1:p2:UserPromptSubmit"]);
    t.fg.set("w1:p1", [PID]);
    await t.tick();
    expect(t.events()).toEqual(["w1:p2:SessionStart", "w1:p2:UserPromptSubmit", "w1:p1:SessionStart", "w1:p1:UserPromptSubmit"]);
  });

  test("the cap: an edge past it is dropped, the held ones still apply in order", async () => {
    const t = rig({ lag: LAG });
    for (let i = 0; i <= HELD_EDGES_MAX; i += 1) t.push(record({ event: "PreToolUse", at: T0 + i }));
    await t.tick();
    expect(t.drops).toEqual([{ pid: PID, reason: "not-foreground" }]);
    t.fg.set("w1:p1", [PID]);
    await t.tick();
    expect(t.delivered.length).toBe(HELD_EDGES_MAX);
    expect(t.delivered.map((d) => d.edge.record.at)).toEqual(Array.from({ length: HELD_EDGES_MAX }, (_, i) => T0 + i));
  });

  test("a restart forgets a held edge: nothing is saved for it, and the new router applies only what it takes", async () => {
    let saved: readonly SavedSource[] = [];
    const store: SourceStore = { load: () => saved, save: (sources) => void (saved = sources) };
    const before = rig({ lag: LAG, store });
    before.push(startEdge());
    await before.tick();
    expect(saved).toEqual([]);
    const after = rig({ lag: LAG, store });
    after.fg.set("w1:p1", [PID]);
    await after.tick();
    expect(after.delivered).toEqual([]);
    after.push(promptEdge());
    await after.tick();
    expect(after.events()).toEqual(["w1:p1:UserPromptSubmit"]);
    expect(after.r.noPromptYet("main", "w1:p1")).toBe(false);
  });
});
