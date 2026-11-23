// The pane's `noPromptYet` word on the wire: present and `true` in the one state the bridge knows
// ("a new conversation began and no prompt reached it"), and no key at all in every other state.

import { describe, expect, test } from "bun:test";

import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "./beacon/types.ts";
import type { BeaconLiveness } from "./beacon/reader.ts";
import type { BeaconMatcher } from "./beacon/decorate.ts";
import type { EdgeSpool } from "./beacon-io.ts";
import { EdgeRouter, type EdgeTarget } from "./surface/edges.ts";
import { toPaneWire, withNoPromptYet, type AgentView, type PaneWire } from "./types.ts";

const PID = 4242;
const START = 777;
const SOCKET = "/run/mux.sock";

const pane: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "work",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/work",
  focused: true,
  kind: "agent",
  agentSession: { kind: "id", value: "00000000-0000-4000-8000-000000000000" },
};

const record = (over: Partial<EdgeRecord>): EdgeRecord => ({
  schemaVersion: EDGE_SCHEMA_VERSION,
  harness: "claude",
  event: "Stop",
  detail: null,
  pid: PID,
  pidStartTime: START,
  markers: [{ namespace: "mux", scope: SOCKET, pane: "w1:p1" }],
  at: 1_000_000,
  promptHash: null,
  ...over,
});

const matcher: BeaconMatcher = {
  namespace: "mux",
  scope: () => Promise.resolve(SOCKET),
  matches: (p, m, s) => m.scope === s && m.pane === p.paneId,
  notesWithoutHooks: { agentDetection: "-", agentSessionRef: "-" },
};
const alive: BeaconLiveness = { startTimeOf: (pid) => Promise.resolve(pid === PID ? START : null) };

/** What the snapshot's pane step says for a pane after these edges: the router's word through the wire step. */
async function wireAfter(edges: Partial<EdgeRecord>[]): Promise<PaneWire> {
  const files: string[] = [];
  const spool: EdgeSpool = { take: () => Promise.resolve(files.splice(0)) };
  const target: EdgeTarget = { session: "main", matcher, paneIds: () => ["w1:p1"], deliver: () => undefined };
  const router = new EdgeRouter({ spool, liveness: alive, targets: () => [target], log: () => undefined, now: () => 1_000_500 });
  for (const edge of edges) {
    files.push(JSON.stringify(record(edge)));
    await router.tick();
  }
  const wire = toPaneWire(pane, (agent) => agent === "claude");
  return withNoPromptYet(wire, router.noPromptYet("main", "w1:p1"));
}

describe("the pane's noPromptYet word", () => {
  test("rides as true in the one known state, beside hasSession", async () => {
    const wire = await wireAfter([{ event: "SessionStart", source: "startup" }]);
    expect(wire.noPromptYet).toBe(true);
    expect(wire.hasSession).toBe(true);
  });

  test("is absent once a prompt reached the session", async () => {
    const wire = await wireAfter([{ event: "SessionStart", source: "startup" }, { event: "UserPromptSubmit" }]);
    expect("noPromptYet" in wire).toBe(false);
  });

  test("is absent where the bridge cannot say: a resumed start, no source, a late join, no hooks at all", async () => {
    const states: Partial<EdgeRecord>[][] = [[{ event: "SessionStart", source: "resume" }], [{ event: "SessionStart" }], [{ event: "Stop" }], []];
    for (const edges of states) expect("noPromptYet" in (await wireAfter(edges))).toBe(false);
  });

  test("a wire step with the word false returns the pane itself", () => {
    const wire = toPaneWire(pane, () => true);
    expect(withNoPromptYet(wire, false)).toBe(wire);
    expect(withNoPromptYet(wire, true)).toEqual({ ...wire, noPromptYet: true });
  });
});
