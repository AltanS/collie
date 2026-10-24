// Hook edges into the Surface (M56 spec 11): an edge is keyed to the harness pid and placed on one pane
// through the multiplexer markers; an edge no pane can take is logged and dropped; a placed edge goes
// into the pane's fold and asks for a fresh read; and no edge ever makes a free.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseEdge } from "../beacon/parse.ts";
import type { BeaconLiveness } from "../beacon/reader.ts";
import { EDGE_SCHEMA_VERSION, type BeaconMarker, type EdgeRecord } from "../beacon/types.ts";
import type { EdgeSpool } from "../beacon-io.ts";
import type { ForegroundProcess } from "../journal/types.ts";
import { muxOk, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import type { JsonValue } from "../json.ts";
import type { AgentView } from "../types.ts";
import { isFree, modalWord } from "../../web/src/lib/surface/surface.ts";
import { deliverEdge, EDGE_MAX_AGE_MS, EDGE_TAG, EdgeRouter, HOOK_LIVENESS_MS, kindOfEdge, modelAfter, placeEdge, type EdgeHoldInfo, type EdgeSinks, type EdgeTarget, type PlacedEdge, type SavedSource, type SourceStore } from "./edges.ts";
import { SurfaceShadow } from "./shadow.ts";

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const screen = (name: string): string => readFileSync(join(PANES, name), "utf8");
const IDLE = "claude-lab--idle-after-turn--w82.txt";
const RUNNING = "claude--working-esc-to-interrupt.txt";
const PERMISSION = "claude-lab--permission-bash--w82.txt";
/** Claude Code 2.1.309 after Escape before the first token: the prompt back in the box, no Interrupted row. */
const RESTORED = "claude--v2-1-309-stopped-prompt-restored--w120.txt";
/** The harness the fixtures were captured under. Test files may name it. */
const HARNESS = "claude";

const PID = 4242;
const START = 777;
const SOCKET = "/run/mux.sock";

function marker(pane: string, scope = SOCKET, namespace = "mux"): BeaconMarker {
  return { namespace, scope, pane };
}

function record(over: Partial<EdgeRecord> = {}): EdgeRecord {
  return { schemaVersion: EDGE_SCHEMA_VERSION, harness: HARNESS, event: "Stop", detail: null, pid: PID, pidStartTime: START, markers: [marker("w1:p1")], at: 1_000_000, promptHash: null, ...over };
}

function matcher(scope: string | null = SOCKET, namespace = "mux"): BeaconMatcher {
  return {
    namespace,
    scope: () => Promise.resolve(scope),
    matches: (pane, m, s) => m.scope === s && m.pane === pane.paneId,
    notesWithoutHooks: { agentDetection: "-", agentSessionRef: "-" },
  };
}

const alive: BeaconLiveness = { startTimeOf: (pid) => Promise.resolve(pid === PID ? START : null) };

function target(over: Partial<EdgeTarget> & { panes?: string[]; got?: { paneId: string; edge: PlacedEdge }[] } = {}): EdgeTarget {
  const got = over.got ?? [];
  const base: EdgeTarget = {
    session: over.session ?? "main",
    matcher: over.matcher ?? matcher(),
    paneIds: () => over.panes ?? ["w1:p1", "w1:p2"],
    deliver: over.deliver ?? ((paneId, edge) => void got.push({ paneId, edge })),
  };
  if (over.foreground === undefined) return base;
  return { ...base, foreground: over.foreground };
}

function foreground(pids: (number | undefined)[]): (paneId: string) => Promise<MuxOutcome<readonly ForegroundProcess[]>> {
  return () => Promise.resolve(muxOk(pids.map((pid) => (pid === undefined ? { argv: ["x"] } : { argv: ["x"], pid }))));
}

describe("placing an edge", () => {
  test("keys an edge to its pid and places it on the one pane its marker names", async () => {
    const placed = await placeEdge(record(), [target()], alive);
    expect(placed.kind === "placed" && placed.paneId).toBe("w1:p1");
  });

  test("drops an edge whose marker names no pane, or names one in another scope", async () => {
    expect(await placeEdge(record({ markers: [marker("w9:p9")] }), [target()], alive)).toEqual({ kind: "dropped", reason: "no-pane" });
    expect(await placeEdge(record({ markers: [marker("w1:p1", "/other.sock")] }), [target()], alive)).toEqual({ kind: "dropped", reason: "no-pane" });
    expect(await placeEdge(record(), [target({ matcher: matcher(null) })], alive)).toEqual({ kind: "dropped", reason: "no-pane" });
  });

  test("drops an edge two sessions both claim: ambiguity is absence", async () => {
    const placed = await placeEdge(record(), [target({ session: "a" }), target({ session: "b" })], alive);
    expect(placed).toEqual({ kind: "dropped", reason: "ambiguous" });
  });

  test("drops an edge whose pid is gone, or was reused by another process", async () => {
    expect(await placeEdge(record({ pid: 99 }), [target()], alive)).toEqual({ kind: "dropped", reason: "dead-pid" });
    expect(await placeEdge(record({ pidStartTime: 1 }), [target()], alive)).toEqual({ kind: "dropped", reason: "dead-pid" });
  });

  test("checks the pid against the pane's foreground where the multiplexer reports pids", async () => {
    expect((await placeEdge(record(), [target({ foreground: foreground([PID, 5]) })], alive)).kind).toBe("placed");
    expect(await placeEdge(record(), [target({ foreground: foreground([5, 6]) })], alive)).toEqual({ kind: "dropped", reason: "not-foreground" });
    // No pid reported (argv only): the marker and the live pid are the evidence.
    expect((await placeEdge(record(), [target({ foreground: foreground([undefined]) })], alive)).kind).toBe("placed");
  });

  test("maps the event to a kind through the edge's own harness profile", () => {
    expect(kindOfEdge(record({ event: "UserPromptSubmit" }))).toBe("prompt");
    expect(kindOfEdge(record({ event: "Notification", detail: "permission_prompt" }))).toBe("dialog");
    expect(kindOfEdge(record({ harness: "no-profile-here", event: "Stop" }))).toBe("reread");
  });
});

class FakeSpool implements EdgeSpool {
  files: string[] = [];
  take(): Promise<readonly string[]> {
    const out = this.files;
    this.files = [];
    return Promise.resolve(out);
  }
}

function router(targets: EdgeTarget[], liveness: BeaconLiveness = alive) {
  const spool = new FakeSpool();
  const lines: string[] = [];
  const drops: string[] = [];
  let clock = 1_000_000;
  const r = new EdgeRouter({
    spool,
    liveness,
    targets: () => targets,
    onDrop: (_record, reason) => drops.push(reason),
    log: (line) => lines.push(line),
    now: () => clock,
  });
  return { r, spool, lines, drops, advance: (ms: number) => (clock += ms) };
}

describe("the edge router", () => {
  test("logs each placed edge with its pid key, hands it to the pane, and the pane's hooks read live", async () => {
    const got: { paneId: string; edge: PlacedEdge }[] = [];
    const { r, spool, lines } = router([target({ got })]);
    expect(r.hooksOf("main", "w1:p1")).toBe("none");
    spool.files.push(JSON.stringify(record({ event: "UserPromptSubmit" })));
    await r.tick();
    expect(got.map((g) => [g.paneId, g.edge.kind])).toEqual([["w1:p1", "prompt"]]);
    expect(lines.some((line) => line.includes(EDGE_TAG) && line.includes(`pid=${String(PID)}`) && line.includes("event=UserPromptSubmit"))).toBe(true);
    expect(r.hooksOf("main", "w1:p1")).toBe("live");
    expect(r.hooksOf("main", "w1:p2")).toBe("none");
  });

  test("drops and counts garbage, an old edge and an unplaced pid, and logs the unplaced pid", async () => {
    const got: { paneId: string; edge: PlacedEdge }[] = [];
    const { r, spool, lines, drops } = router([target({ got })]);
    spool.files.push("not json", JSON.stringify(record({ at: 1_000_000 - EDGE_MAX_AGE_MS - 1 })), JSON.stringify(record({ pid: 99 })));
    await r.tick();
    expect(got).toEqual([]);
    expect(drops).toEqual(["unparsed", "old", "dead-pid"]);
    expect(lines.filter((line) => line.includes(`${EDGE_TAG}.dropped`))).toEqual([`[surface] ${EDGE_TAG}.dropped reason=dead-pid event=Stop pid=99`]);
  });

  test("an end edge closes the source; a gone pid closes it too and hands the pane one end edge", async () => {
    let living = true;
    const liveness: BeaconLiveness = { startTimeOf: () => Promise.resolve(living ? START : null) };
    const got: { paneId: string; edge: PlacedEdge }[] = [];
    const { r, spool, advance } = router([target({ got })], liveness);
    spool.files.push(JSON.stringify(record({ event: "SessionStart" })));
    await r.tick();
    expect(r.hooksOf("main", "w1:p1")).toBe("live");
    spool.files.push(JSON.stringify(record({ event: "SessionEnd" })));
    await r.tick();
    expect(r.hooksOf("main", "w1:p1")).toBe("none");

    spool.files.push(JSON.stringify(record({ event: "Stop" })));
    await r.tick();
    expect(r.hooksOf("main", "w1:p1")).toBe("live");
    living = false;
    advance(HOOK_LIVENESS_MS);
    await r.tick();
    expect(r.hooksOf("main", "w1:p1")).toBe("none");
    expect(got.map((g) => g.edge.kind)).toEqual(["start", "end", "stop", "end"]);
  });
});

class FakeMux {
  screens = new Map<string, { text: string; revision: number }>();
  /** While set, a read takes the screen as it is when the read starts and answers once this resolves. */
  hold: Promise<void> | null = null;
  reads = 0;
  set(paneId: string, name: string, revision: number): void {
    this.screens.set(paneId, { text: screen(name), revision });
  }
  readGrid = async (paneId: string, _request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    this.reads++;
    const s = this.screens.get(paneId);
    if (this.hold !== null) await this.hold;
    if (s === undefined) return { ok: false, reason: "gone", detail: "no such pane" };
    return { ok: true, value: { paneId, text: s.text, truncated: false, revision: s.revision } };
  };
}

function agent(paneId: string, harness: string = HARNESS): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1", agent: harness, status: "idle", cwd: "/x", focused: false };
}

function shadowRig(version = "2.1.296") {
  const mux = new FakeMux();
  let clock = 1_000_000;
  const pending: { run: () => void; ms: number }[] = [];
  const counted: string[] = [];
  const shadow = new SurfaceShadow({
    mux,
    pollMs: 1000,
    compare: false,
    log: () => undefined,
    now: () => clock,
    version: () => Promise.resolve(version),
    schedule: (run, ms) => {
      const entry = { run, ms };
      pending.push(entry);
      return () => void pending.splice(pending.indexOf(entry), 1);
    },
    ledger: { read: () => undefined, edge: (_key, word) => void counted.push(word) },
  });
  /** Runs the fresh read an edge asked for, after the clock moved past its delay. */
  const reread = async (): Promise<void> => {
    const next = pending.shift();
    if (next === undefined) throw new Error("no fresh read was asked for");
    clock += next.ms;
    next.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { mux, shadow, pending, counted, reread, advance: (ms: number) => (clock += ms) };
}

describe("the hook target on the liveness tick", () => {
  test("a take calls keep once per liveness period, with no hooked pane too", async () => {
    let clock = 1_000_000;
    let kept = 0;
    const keeper = new EdgeRouter({ spool: new FakeSpool(), liveness: alive, targets: () => [target()], keep: () => void kept++, log: () => undefined, now: () => clock });
    await keeper.tick();
    await keeper.tick();
    expect(kept).toBe(1);
    clock += HOOK_LIVENESS_MS;
    await keeper.tick();
    expect(kept).toBe(2);
  });
});

describe("the start's model (a fresh pane names its model before its first message)", () => {
  test("a start edge's model stays on the pane's source over the later edges of the same pid, and leaves with it", async () => {
    const { r, spool, lines } = router([target()]);
    spool.files.push(JSON.stringify(record({ event: "SessionStart", model: "claude-sonnet-5-5", at: 1_000_100 })));
    await r.tick();
    expect(r.modelOf("main", "w1:p1")).toEqual({ model: "claude-sonnet-5-5", at: 1_000_100 });
    expect(lines.some((line) => line.includes("event=SessionStart") && line.endsWith("model=claude-sonnet-5-5"))).toBe(true);
    expect(r.modelOf("main", "w1:p2")).toBeUndefined();

    spool.files.push(JSON.stringify(record({ event: "Stop", at: 1_000_200 })));
    await r.tick();
    expect(r.modelOf("main", "w1:p1")).toEqual({ model: "claude-sonnet-5-5", at: 1_000_100 });

    // A /clear starts again in the same process, and its start names the model anew.
    spool.files.push(JSON.stringify(record({ event: "SessionStart", model: "claude-opus-5-5[1m]", at: 1_000_300 })));
    await r.tick();
    expect(r.modelOf("main", "w1:p1")).toEqual({ model: "claude-opus-5-5[1m]", at: 1_000_300 });

    spool.files.push(JSON.stringify(record({ event: "SessionEnd", at: 1_000_400 })));
    await r.tick();
    expect(r.modelOf("main", "w1:p1")).toBeUndefined();
  });

  test("another process in the pane does not inherit the model", () => {
    const known = { pid: PID, pidStartTime: START, model: { model: "claude-sonnet-5-5", at: 1 } };
    expect(modelAfter(known, record({ event: "Stop" }))).toEqual({ model: "claude-sonnet-5-5", at: 1 });
    expect(modelAfter(known, record({ event: "Stop", pid: PID + 1 }))).toBeUndefined();
    expect(modelAfter(known, record({ event: "Stop", pidStartTime: START + 1 }))).toBeUndefined();
    expect(modelAfter(undefined, record({ event: "SessionStart" }))).toBeUndefined();
  });

  test("the parse keeps a model name and drops a malformed one, never the edge", () => {
    const parse = (model: JsonValue) => parseEdge(JSON.stringify({ ...record({ event: "SessionStart" }), model }));
    expect(parse("claude-opus-5-5[1m]")?.model).toBe("claude-opus-5-5[1m]");
    for (const bad of ["opus\n5", "x".repeat(129), "", "   ", 42, null, { name: "opus" }, "\u001b[31mopus"]) {
      const edge = parse(bad);
      expect(edge?.event).toBe("SessionStart");
      expect(edge?.model).toBeUndefined();
    }
    expect(parse("m".repeat(128))?.model).toHaveLength(128);
  });

  test("a restarted bridge still knows the model, at the time its hook ran", async () => {
    const saved: SavedSource[][] = [];
    const store: SourceStore = { load: () => saved.at(-1) ?? [], save: (sources) => void saved.push([...sources]) };
    const spool = new FakeSpool();
    const first = new EdgeRouter({ spool, store, liveness: alive, targets: () => [target()], log: () => undefined, now: () => 1_000_500 });
    spool.files.push(JSON.stringify(record({ event: "SessionStart", model: "claude-sonnet-5-5", at: 1_000_100 })));
    await first.tick();
    spool.files.push(JSON.stringify(record({ event: "SessionStart", model: "claude-opus-5-5", at: 1_000_200 })));
    await first.tick();
    // The newest save holds the model of the newest start, with its own time.
    expect(saved.at(-1)?.map((s) => [s.record.model, s.modelAt])).toEqual([["claude-opus-5-5", 1_000_200]]);
    // A later edge that names none: the save that follows (if any) keeps the model and its time.
    spool.files.push(JSON.stringify(record({ event: "Stop", at: 1_000_300 })));
    await first.tick();
    const restarted = new EdgeRouter({ spool: new FakeSpool(), store, liveness: alive, targets: () => [target()], log: () => undefined, now: () => 2_000_000 });
    await restarted.tick();
    expect(restarted.modelOf("main", "w1:p1")).toEqual({ model: "claude-opus-5-5", at: 1_000_200 });
  });
});

describe("the start's model is the process's, never the pane id's", () => {
  // The model rides on the pane's hook source, which holds the pid and its start time. A pane id that a
  // new process takes over (after the old one died with no end edge, or across a bridge restart) never
  // shows the old process's model.
  const NEXT_PID = PID + 1;
  const NEXT_START = START + 50;

  test("a new process in the same pane id, after the old one died with no end edge, shows no model", async () => {
    let old = true;
    const liveness: BeaconLiveness = { startTimeOf: (pid) => Promise.resolve(pid === PID && old ? START : pid === NEXT_PID ? NEXT_START : null) };
    const { r, spool } = router([target()], liveness);
    spool.files.push(JSON.stringify(record({ event: "SessionStart", model: "claude-sonnet-5-5", at: 1_000_100 })));
    await r.tick();
    expect(r.modelOf("main", "w1:p1")?.model).toBe("claude-sonnet-5-5");
    // Killed: no SessionEnd. A new process's first edge in the same pane names no model.
    old = false;
    spool.files.push(JSON.stringify(record({ event: "UserPromptSubmit", pid: NEXT_PID, pidStartTime: NEXT_START, at: 1_000_200 })));
    await r.tick();
    expect(r.modelOf("main", "w1:p1")).toBeUndefined();
  });

  test("a dead process's model leaves at the next liveness check, before any new edge", async () => {
    let old = true;
    const liveness: BeaconLiveness = { startTimeOf: (pid) => Promise.resolve(pid === PID && old ? START : null) };
    const { r, spool, advance } = router([target()], liveness);
    spool.files.push(JSON.stringify(record({ event: "SessionStart", model: "claude-sonnet-5-5", at: 1_000_100 })));
    await r.tick();
    old = false;
    advance(HOOK_LIVENESS_MS);
    await r.tick();
    expect(r.modelOf("main", "w1:p1")).toBeUndefined();
  });

  test("a restarted bridge seeds no model for a pane id whose saved process is gone, though another runs there", async () => {
    const saved: SavedSource[][] = [];
    const store: SourceStore = { load: () => saved.at(-1) ?? [], save: (sources) => void saved.push([...sources]) };
    const spool = new FakeSpool();
    const first = new EdgeRouter({ spool, store, liveness: alive, targets: () => [target()], log: () => undefined, now: () => 1_000_500 });
    spool.files.push(JSON.stringify(record({ event: "SessionStart", model: "claude-sonnet-5-5", at: 1_000_100 })));
    await first.tick();
    expect(saved.at(-1)?.map((s) => s.record.model)).toEqual(["claude-sonnet-5-5"]);
    // After the restart the pane id holds another process; the saved pid is gone, or reused with another start.
    for (const liveness of [
      { startTimeOf: (pid: number) => Promise.resolve(pid === NEXT_PID ? NEXT_START : null) },
      { startTimeOf: (pid: number) => Promise.resolve(pid === PID ? NEXT_START : null) },
    ] satisfies BeaconLiveness[]) {
      const restartedSpool = new FakeSpool();
      const restarted = new EdgeRouter({ spool: restartedSpool, store: { load: () => saved.at(-1) ?? [], save: () => undefined }, liveness, targets: () => [target()], log: () => undefined, now: () => 2_000_000 });
      await restarted.tick();
      expect(restarted.modelOf("main", "w1:p1")).toBeUndefined();
      restartedSpool.files.push(JSON.stringify(record({ event: "Stop", pid: NEXT_PID, pidStartTime: NEXT_START, at: 2_000_100 })));
      await restarted.tick();
      expect(restarted.modelOf("main", "w1:p1")).toBeUndefined();
    }
  });
});

describe("the live sources across a restart", () => {
  class MemoryStore implements SourceStore {
    saved: readonly SavedSource[] = [];
    load(): readonly SavedSource[] {
      return this.saved;
    }
    save(sources: readonly SavedSource[]): void {
      this.saved = sources;
    }
  }

  test("a restarted bridge reads a hooked pane as live before its next event, and drops a dead pid", async () => {
    const store = new MemoryStore();
    // The first run takes one edge, and saves the pane's source.
    const firstSpool = new FakeSpool();
    const running = new EdgeRouter({ spool: firstSpool, store, liveness: alive, targets: () => [target()], log: () => undefined, now: () => 1_000_000 });
    firstSpool.files.push(JSON.stringify(record({ event: "SessionStart" })));
    await running.tick();
    expect(store.saved.map((s) => [s.session, s.paneId])).toEqual([["main", "w1:p1"]]);
    // A restart: the panes are not in a snapshot yet, then they are.
    let panes: string[] = [];
    const restarted = new EdgeRouter({ spool: new FakeSpool(), store, liveness: alive, targets: () => [target({ panes })], log: () => undefined, now: () => 1_000_500 });
    await restarted.tick();
    expect(restarted.hooksOf("main", "w1:p1")).toBe("none");
    panes = ["w1:p1", "w1:p2"];
    await restarted.tick();
    expect(restarted.hooksOf("main", "w1:p1")).toBe("live");
    // The same restart with the agent gone: nothing is seeded, and the store forgets it.
    const dead: BeaconLiveness = { startTimeOf: () => Promise.resolve(null) };
    const gone = new EdgeRouter({ spool: new FakeSpool(), store, liveness: dead, targets: () => [target()], log: () => undefined, now: () => 1_001_000 });
    await gone.tick();
    expect(gone.hooksOf("main", "w1:p1")).toBe("none");
    expect(store.saved).toEqual([]);
  });
});

describe("edges in the shadow", () => {
  test("never free: a Stop edge while the screen still shows the spinner keeps the turn running", async () => {
    const s = shadowRig();
    s.mux.set("w1:p1", RUNNING, 1);
    await s.shadow.observe([agent("w1:p1")]);
    s.advance(100);
    s.shadow.edge("w1:p1", "prompt", s.advance(0));
    await s.reread();
    expect(s.shadow.surfaceOf("w1:p1")?.turn).toBe("running");
    s.shadow.edge("w1:p1", "stop", s.advance(50));
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(false);
    await s.reread();
    expect(s.shadow.surfaceOf("w1:p1")?.turn).toBe("running");
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(false);
    // The screen agrees later: only a fresh read of an idle box makes the free.
    s.mux.set("w1:p1", IDLE, 2);
    await s.shadow.observe([agent("w1:p1")]);
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(true);
    expect(s.counted).toEqual(["prompt", "stop"]);
  });

  // Second live pass: Escape before the first token puts the prompt back into Claude Code's box, and no
  // Stop hook fires. Collie's own `stopped` receipt is the stop the hook did not send.
  test("a Stop receipt ends the prompt edge's block on a restored prompt; counted apart from the hooks' stop", async () => {
    const s = shadowRig("2.1.309");
    s.mux.set("w1:p1", RESTORED, 1);
    await s.shadow.observe([agent("w1:p1")]);
    s.shadow.edge("w1:p1", "prompt", s.advance(10));
    await s.reread();
    for (let i = 0; i < 6; i++) {
      s.advance(3000);
      await s.shadow.observe([agent("w1:p1")]);
    }
    expect(s.shadow.surfaceOf("w1:p1")).toMatchObject({ turn: "running", composer: "draft" });
    expect(s.shadow.stopSeen("w1:p1")).toBe(true);
    expect(s.shadow.surfaceOf("w1:p1")).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
    expect(s.pending).toHaveLength(0);
    expect(s.counted).toEqual(["prompt", "stop-receipt"]);
    expect(s.shadow.stopSeen("w1:p9")).toBe(false);
  });

  test("a Stop receipt never frees a screen that still reads running", async () => {
    const s = shadowRig();
    s.mux.set("w1:p1", RUNNING, 1);
    await s.shadow.observe([agent("w1:p1")]);
    s.shadow.edge("w1:p1", "prompt", s.advance(10));
    await s.reread();
    s.shadow.stopSeen("w1:p1");
    expect(s.shadow.surfaceOf("w1:p1")?.turn).toBe("running");
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(false);
  });

  test("never free: no edge kind frees a dialog on screen, and each edge asks for one fresh read", async () => {
    const s = shadowRig();
    s.mux.set("w1:p1", PERMISSION, 1);
    await s.shadow.observe([agent("w1:p1")]);
    for (const kind of ["stop", "start", "end", "reread", "dialog", "prompt"] as const) {
      s.shadow.edge("w1:p1", kind, s.advance(10));
      expect(s.pending).toHaveLength(1);
      await s.reread();
      expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(false);
    }
  });

  test("an edge on a young read keeps its verdict, a pane not read yet takes none (2026-10-17 flicker)", async () => {
    const s = shadowRig();
    expect(s.shadow.edge("w1:p9", "stop", 0)).toBe(false);
    s.mux.set("w1:p1", IDLE, 1);
    await s.shadow.observe([agent("w1:p1")]);
    s.shadow.edge("w1:p1", "reread", s.advance(10));
    expect(s.shadow.surfaceOf("w1:p1")?.reason).toBeUndefined();
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(true);
    await s.reread();
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(true);
  });

  test("an edge on a read older than two poll intervals marks it stale until the fresh read", async () => {
    const s = shadowRig();
    s.mux.set("w1:p1", IDLE, 1);
    await s.shadow.observe([agent("w1:p1")]);
    s.shadow.edge("w1:p1", "reread", s.advance(2001));
    expect(s.shadow.surfaceOf("w1:p1")?.reason).toBe("stale");
    await s.reread();
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(true);
  });

  test("a lost Stop: three free reads over ten seconds end the block, counted once", async () => {
    const s = shadowRig();
    s.mux.set("w1:p1", RUNNING, 1);
    await s.shadow.observe([agent("w1:p1")]);
    s.shadow.edge("w1:p1", "prompt", s.advance(10));
    await s.reread();
    s.mux.set("w1:p1", IDLE, 2);
    for (const step of [2000, 5000, 5000]) {
      s.advance(step);
      await s.shadow.observe([agent("w1:p1")]);
    }
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(true);
    expect(s.counted).toEqual(["prompt", "lost-stop"]);
  });

  test("a poll read that started before a Stop edge never replaces the fresh read: the dialog stays", async () => {
    const s = shadowRig();
    s.mux.set("w1:p1", RUNNING, 1);
    await s.shadow.observe([agent("w1:p1")]);
    // A poll starts reading while the screen is still idle, and its answer is slow.
    s.mux.set("w1:p1", IDLE, 2);
    let release = (): void => undefined;
    s.mux.hold = new Promise((resolve) => (release = resolve));
    const poll = s.shadow.observe([agent("w1:p1")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The Stop edge comes, and by its fresh read a permission dialog is up.
    s.shadow.edge("w1:p1", "stop", s.advance(100));
    s.mux.set("w1:p1", PERMISSION, 3);
    const next = s.pending.shift()!;
    s.advance(next.ms);
    next.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The fresh read waits for the poll read in flight, then reads the dialog.
    expect(s.mux.reads).toBe(2);
    s.mux.hold = null;
    release();
    await poll;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.mux.reads).toBe(3);
    expect(modalWord(s.shadow.surfaceOf("w1:p1")!.modal)).toBe("ask");
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(false);
  });
});

describe("codex: the notify edge (M56 spec 13)", () => {
  // The edge `collie beacon emit codex` writes (cli/codex-notify.ts): keyed to the TUI pid, with the
  // Herdr marker from the TUI's own environment, and the notify event's own name.
  const codexEdge = (over: Partial<EdgeRecord> = {}): EdgeRecord =>
    record({ harness: "codex", event: "agent-turn-complete", markers: [marker("w1:p1", SOCKET, "herdr")], ...over });

  test("codex: agent-turn-complete is a stop edge under the Codex profile", () => {
    expect(kindOfEdge(codexEdge())).toBe("stop");
    expect(kindOfEdge(codexEdge({ event: "approval-requested" }))).toBe("reread");
  });

  test("codex: the edge file parses with its dashed event name, and a dash at either end does not", () => {
    expect(parseEdge(JSON.stringify(codexEdge()))?.event).toBe("agent-turn-complete");
    expect(parseEdge(JSON.stringify(codexEdge({ event: "-turn" })))).toBeNull();
    expect(parseEdge(JSON.stringify(codexEdge({ event: "turn-" })))).toBeNull();
  });

  test("codex: the router places the edge on the one pane its marker names, logs it by pid, and the hooks read live", async () => {
    const got: { paneId: string; edge: PlacedEdge }[] = [];
    const { r, spool, lines } = router([target({ got, matcher: matcher(SOCKET, "herdr") })]);
    spool.files.push(JSON.stringify(codexEdge()));
    await r.tick();
    expect(got.map((g) => [g.paneId, g.edge.kind])).toEqual([["w1:p1", "stop"]]);
    expect(lines.some((line) => line.includes(EDGE_TAG) && line.includes(`pid=${String(PID)}`) && line.includes("event=agent-turn-complete"))).toBe(true);
    expect(r.hooksOf("main", "w1:p1")).toBe("live");
  });

  test("codex: a stop edge on a Codex turn that still runs keeps it running, and only an idle read makes the free", async () => {
    const s = shadowRig("0.159.2");
    s.mux.set("w1:p1", "codex--v0163-working-draft--w120.txt", 1);
    await s.shadow.observe([agent("w1:p1", "codex")]);
    expect(s.shadow.surfaceOf("w1:p1")?.turn).toBe("running");
    s.shadow.edge("w1:p1", "stop", s.advance(50));
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(false);
    await s.reread();
    expect(s.shadow.surfaceOf("w1:p1")?.turn).toBe("running");
    s.mux.set("w1:p1", "codex--v0162-idle.txt", 2);
    await s.shadow.observe([agent("w1:p1", "codex")]);
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(true);
  });

  test("codex: no edge frees a Codex approval on screen", async () => {
    const s = shadowRig("0.159.2");
    s.mux.set("w1:p1", "codex--v0156-approval-exec-2opt.txt", 1);
    await s.shadow.observe([agent("w1:p1", "codex")]);
    s.shadow.edge("w1:p1", "stop", s.advance(10));
    await s.reread();
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(false);
    expect(modalWord(s.shadow.surfaceOf("w1:p1")!.modal)).toBe("ask");
  });
});

describe("a subagent's edge is not the pane's (2026-10-17 field case)", () => {
  /** Sinks that fold into a real shadow and write down what reached the hold book and the counters. */
  const sinksOver = (s: ReturnType<typeof shadowRig>) => {
    const held: { paneId: string; kind: string; info: EdgeHoldInfo }[] = [];
    const unfolded: string[] = [];
    const prompts: string[] = [];
    const sinks: EdgeSinks = {
      fold: (paneId, kind, at) => s.shadow.edge(paneId, kind, at),
      unfolded: (_record, kind) => void unfolded.push(kind),
      promptEdge: (_paneId, hash) => void prompts.push(hash),
      hold: (paneId, kind, info) => void held.push({ paneId, kind, info }),
    };
    return { sinks, held, unfolded, prompts };
  };
  const placed = (over: Partial<EdgeRecord>, at: number): PlacedEdge => ({ kind: "tool", record: record({ event: "PostToolUse", tool: "Bash", inputHash: "abc", ...over }), at });

  test("a tool edge with `agent` set leaves the fold's verdict as it was, and still lands in the hold book", async () => {
    const s = shadowRig();
    const { sinks, held, unfolded } = sinksOver(s);
    s.mux.set("w1:p1", IDLE, 1);
    await s.shadow.observe([agent("w1:p1")]);
    const before = s.shadow.surfaceOf("w1:p1");
    // Old enough that an edge of the pane itself would make the read stale.
    const at = s.advance(2500);
    deliverEdge(sinks, "w1:p1", placed({ agent: "sub-1" }, at));
    expect(s.shadow.surfaceOf("w1:p1")).toEqual(before!);
    expect(isFree(s.shadow.surfaceOf("w1:p1")!)).toBe(true);
    expect(s.pending).toEqual([]);
    expect(s.counted).toEqual([]);
    expect(unfolded).toEqual([]);
    expect(held).toEqual([{ paneId: "w1:p1", kind: "tool", info: { tool: "Bash", agent: "sub-1", at: placed({}, 0).record.at, inputHash: "abc" } }]);
    // The same edge from the main session goes into the fold: on that old read it is stale.
    deliverEdge(sinks, "w1:p1", placed({}, at));
    expect(s.shadow.surfaceOf("w1:p1")?.reason).toBe("stale");
    expect(s.counted).toEqual(["tool"]);
    expect(held.map((row) => row.info.agent)).toEqual(["sub-1", null]);
  });

  test("a main-session edge no fold took is counted as unfolded; a prompt edge reaches the Send Protocol", () => {
    const s = shadowRig();
    const { sinks, unfolded, prompts } = sinksOver(s);
    deliverEdge(sinks, "w1:p9", { kind: "prompt", record: record({ event: "UserPromptSubmit", promptHash: "h1" }), at: 0 });
    expect(unfolded).toEqual(["prompt"]);
    expect(prompts).toEqual(["h1"]);
  });
});
