import { describe, expect, test } from "bun:test";

import { journalAgentOf, toPaneWire, type AgentView } from "./types.ts";

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "work",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "muse",
    status: "working",
    cwd: "/repo",
    focused: false,
    ...over,
  };
}

const REF = { kind: "id", value: "01a0a28c-ba4b-76f2-a3d8-637a1b190f6a" } as const;

describe("toPaneWire hasSession", () => {
  test("a reported ref plus an adapter offers History", () => {
    const wire = toPaneWire(pane({ agentSession: { ...REF } }), () => true);
    expect(wire.hasSession).toBe(true);
    expect("agentSession" in wire).toBe(false);
  });

  test("no ref and no discovery offers nothing, like every shell pane", () => {
    const wire = toPaneWire(pane({ agent: "shell" }), () => false);
    expect("hasSession" in wire).toBe(false);
  });

  test("no ref plus a discovering adapter offers History anyway", () => {
    const wire = toPaneWire(
      pane({ agent: "muse" }),
      (agent) => agent === "muse",
      (agent) => agent === "muse",
    );
    expect(wire.hasSession).toBe(true);
  });

  test("discovery without an adapter still offers nothing", () => {
    const wire = toPaneWire(
      pane({ agent: "muse" }),
      () => false,
      () => true,
    );
    expect("hasSession" in wire).toBe(false);
  });

  test("an exited agent's pane stays a shell pane: discovery keys off the live agent", () => {
    const wire = toPaneWire(
      pane({ agent: "shell", sessionAgent: "muse" }),
      (agent) => agent === "muse",
      (agent) => agent === "muse",
    );
    expect("hasSession" in wire).toBe(false);
  });
});

describe("journalAgentOf", () => {
  test("a live pane answers its agent; an exited one answers the harness that wrote the ref", () => {
    expect(journalAgentOf(pane({ agent: "muse" }))).toBe("muse");
    expect(journalAgentOf(pane({ agent: "shell", sessionAgent: "muse" }))).toBe("muse");
  });
});
