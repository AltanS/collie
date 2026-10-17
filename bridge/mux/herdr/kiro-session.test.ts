import { describe, expect, test } from "bun:test";

import { resolveJournalRoots } from "../../config.ts";
import { adapterFor, buildJournalRegistry } from "../../journal/registry.ts";
import { toPaneWire, type AgentView } from "../../types.ts";
import { HerdrMux } from "./adapter.ts";
import { paneAgentSession, type WirePane, type WireSnapshot } from "./client.ts";
import { FakeHerdr } from "./fixture.ts";

// Herdr 0.9.5 `api schema --json`: custom reporters and hooks share AgentSessionInfo.
// Kiro's native reporter uses source "kiro-cli", agent "kiro", and an opaque id.
class ReportedHerdr extends FakeHerdr {
  constructor(private readonly report: WirePane["agent_session"]) {
    super();
  }

  override async sessionSnapshot(): Promise<WireSnapshot> {
    const snapshot = await super.sessionSnapshot();
    const first = snapshot.panes[0];
    if (first === undefined) throw new Error("fixture needs a pane");
    return { ...snapshot, panes: [{ ...first, agent: "kiro", agent_session: this.report }] };
  }
}

const SESSION = { source: "kiro-cli", agent: "kiro", kind: "id", value: "sess_custom-id" };

describe("Kiro native session reports", () => {
  test("custom-source session references reach the registered journal and only a presence flag reaches the browser", async () => {
    // Given: Herdr exposes the native reporter's session using its installed wire contract.
    const mux = new HerdrMux(new ReportedHerdr(SESSION), () => []);
    const registry = buildJournalRegistry(resolveJournalRoots({}, "/home/operator"));
    // When: the adapter translates the pane and the bridge makes its browser record.
    const pane = (await mux.snapshot()).panes[0];
    if (pane === undefined) throw new Error("missing pane");
    const view: AgentView = {
      paneId: pane.paneId,
      workspaceId: pane.spaceId,
      workspaceLabel: pane.spaceLabel,
      workspaceNumber: pane.spaceNumber,
      tabId: pane.tabId,
      agent: pane.agent,
      status: pane.status,
      cwd: pane.cwd,
      focused: pane.focused,
      agentSession: pane.agentSession,
    };
    const wire = toPaneWire(view, (agent) => adapterFor(registry, agent) !== undefined);
    // Then: no hook-source filter discards the ref, and no id or path leaves the bridge.
    expect(pane.agentSession).toEqual({ kind: "id", value: "sess_custom-id" });
    expect(adapterFor(registry, pane.agent)?.agent).toBe("kiro");
    expect(wire.hasSession).toBe(true);
    expect("agentSession" in wire).toBe(false);
    expect("sessionAgent" in wire).toBe(false);
  });

  test("a previous harness's reference is not handed to Kiro", async () => {
    // Given: Kiro occupies a pane with a stale Claude report.
    const mux = new HerdrMux(new ReportedHerdr({ ...SESSION, agent: "claude" }), () => []);
    // When: the adapter checks the report's owner.
    const pane = (await mux.snapshot()).panes[0];
    // Then: the agent stays Kiro but the stale ref is absent.
    expect(pane?.agent).toBe("kiro");
    expect(pane?.agentSession).toBeUndefined();
  });

  test("a missing report stays absent rather than guessing a session from the pane", async () => {
    const pane = (await new HerdrMux(new ReportedHerdr(undefined), () => []).snapshot()).panes[0];
    expect(pane?.agentSession).toBeUndefined();
  });

  test("custom-source path refs remain available to the journal that supports them", () => {
    expect(paneAgentSession({ source: "custom-reporter", agent: "pi", kind: "path", value: "/sessions/log.jsonl" }))
      .toEqual({ kind: "path", value: "/sessions/log.jsonl", agent: "pi" });
    expect(paneAgentSession({ ...SESSION, value: "" })).toBeNull();
    expect(paneAgentSession({ ...SESSION, kind: "resume_argv" })).toBeNull();
  });
});
