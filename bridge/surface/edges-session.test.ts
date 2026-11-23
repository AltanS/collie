// The agent session per hook source (2026-11-23): an edge of the session's own names the agent session the
// hook's payload named; the router keeps it per pane with the one the same process named just before, across
// the end and the start that `/clear` sends, and a new process starts with no previous one. The reminder of
// open asks reads it (bridge/hill/service.ts), so a second Claude process in the same pane is not the pane's.

import { describe, expect, test } from "bun:test";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseEdge } from "../beacon/parse.ts";
import type { BeaconLiveness } from "../beacon/reader.ts";
import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "../beacon/types.ts";
import type { EdgeSpool } from "../beacon-io.ts";
import { EdgeRouter, sessionAfter, type EdgeTarget, type SavedSource } from "./edges.ts";

const PID = 4242;
const OTHER = 5151;
const START = 777;
const SOCKET = "/run/mux.sock";

function record(over: Partial<EdgeRecord> = {}): EdgeRecord {
  return { schemaVersion: EDGE_SCHEMA_VERSION, harness: "claude", event: "UserPromptSubmit", detail: null, pid: PID, pidStartTime: START, markers: [{ namespace: "mux", scope: SOCKET, pane: "w1:p1" }], at: 1_000_000, promptHash: null, ...over };
}

const matcher: BeaconMatcher = {
  namespace: "mux",
  scope: () => Promise.resolve(SOCKET),
  matches: (pane, m, s) => m.scope === s && m.pane === pane.paneId,
  notesWithoutHooks: { agentDetection: "-", agentSessionRef: "-" },
};
const alive: BeaconLiveness = { startTimeOf: (pid) => Promise.resolve(pid === PID || pid === OTHER ? START : null) };
const target: EdgeTarget = { session: "main", matcher, paneIds: () => ["w1:p1"], deliver: () => undefined };

class FakeSpool implements EdgeSpool {
  files: string[] = [];
  take(): Promise<readonly string[]> {
    const out = this.files;
    this.files = [];
    return Promise.resolve(out);
  }
}

function rig(store?: { load(): readonly SavedSource[]; save(sources: readonly SavedSource[]): void }) {
  const spool = new FakeSpool();
  const r = store === undefined ? new EdgeRouter({ spool, liveness: alive, targets: () => [target], log: () => undefined, now: () => 1_000_500 }) : new EdgeRouter({ spool, store, liveness: alive, targets: () => [target], log: () => undefined, now: () => 1_000_500 });
  const feed = async (over: Partial<EdgeRecord>) => {
    spool.files.push(JSON.stringify(record(over)));
    await r.tick();
  };
  return { r, feed };
}

describe("sessionAfter", () => {
  const known = (agentSession: { current: string; previous: string | null } | undefined, pid = PID) => ({ pid, pidStartTime: START, agentSession });

  test("an edge that names one sets it; the same process naming another keeps the old as previous", () => {
    expect(sessionAfter(undefined, record({ session: "s1" }))).toEqual({ current: "s1", previous: null });
    expect(sessionAfter(known({ current: "s1", previous: null }), record({ session: "s1" }))).toEqual({ current: "s1", previous: null });
    expect(sessionAfter(known({ current: "s1", previous: null }), record({ session: "s2" }))).toEqual({ current: "s2", previous: "s1" });
  });

  test("an edge that names none keeps the same process's; a new process starts from its own edge", () => {
    expect(sessionAfter(known({ current: "s1", previous: "s0" }), record())).toEqual({ current: "s1", previous: "s0" });
    expect(sessionAfter(known({ current: "s1", previous: null }, OTHER), record())).toBeUndefined();
    expect(sessionAfter(known({ current: "s1", previous: null }, OTHER), record({ session: "s9" }))).toEqual({ current: "s9", previous: null });
  });
});

describe("the router keeps the pane's agent session", () => {
  test("a prompt names it; /clear (end with the old id, start with the new) keeps the old as previous", async () => {
    const { r, feed } = rig();
    expect(r.agentSessionOf("main", "w1:p1")).toBeUndefined();
    await feed({ event: "UserPromptSubmit", session: "s1" });
    expect(r.agentSessionOf("main", "w1:p1")).toEqual({ current: "s1", previous: null });
    await feed({ event: "SessionEnd", session: "s1", at: 1_000_100 });
    expect(r.agentSessionOf("main", "w1:p1")).toBeUndefined();
    await feed({ event: "SessionStart", source: "clear", session: "s2", at: 1_000_101 });
    expect(r.agentSessionOf("main", "w1:p1")).toEqual({ current: "s2", previous: "s1" });
  });

  test("another process on the pane (a claude -p the edges place) starts with no previous; a stop with none keeps it", async () => {
    const { r, feed } = rig();
    await feed({ event: "UserPromptSubmit", session: "s1" });
    await feed({ event: "Stop" });
    expect(r.agentSessionOf("main", "w1:p1")).toEqual({ current: "s1", previous: null });
    await feed({ event: "UserPromptSubmit", pid: OTHER, session: "nested" });
    expect(r.agentSessionOf("main", "w1:p1")).toEqual({ current: "nested", previous: null });
    await feed({ event: "UserPromptSubmit", session: "s1" });
    expect(r.agentSessionOf("main", "w1:p1")).toEqual({ current: "s1", previous: null });
  });

  test("an older emitter's edges name none: the bridge knows no session", async () => {
    const { r, feed } = rig();
    await feed({ event: "UserPromptSubmit" });
    expect(r.agentSessionOf("main", "w1:p1")).toBeUndefined();
  });

  test("a restart keeps the current session from the saved source, not the previous", async () => {
    let saved: readonly SavedSource[] = [];
    const store = { load: () => saved, save: (sources: readonly SavedSource[]) => void (saved = sources) };
    const { feed } = rig(store);
    await feed({ event: "UserPromptSubmit", session: "s1" });
    await feed({ event: "SessionStart", source: "resume", session: "s2" });
    await feed({ event: "Stop" });
    expect(saved[0]?.record.session).toBe("s2");
    const { r } = rig(store);
    await r.tick();
    expect(r.agentSessionOf("main", "w1:p1")).toEqual({ current: "s2", previous: null });
  });
});

describe("the edge file's session field", () => {
  test("kept when it has the shape; a malformed one drops the field, never the edge", () => {
    expect(parseEdge(JSON.stringify(record({ session: "0a1b-2c3d" })))?.session).toBe("0a1b-2c3d");
    for (const session of ["", "../x", "a b", 5, "x".repeat(200)]) {
      const parsed = parseEdge(JSON.stringify({ ...record(), session }));
      expect(parsed).not.toBeNull();
      expect(parsed?.session).toBeUndefined();
    }
  });
});
