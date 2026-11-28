import { renderHook } from "@testing-library/react";

import { useAgentTransitions } from "./use-transitions";
import { paneRowKey } from "@/lib/hosts";
import { setStatus } from "@/lib/status";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

vi.mock("@/lib/status", () => ({ setStatus: vi.fn() }));

const pane = (over: Partial<AgentView> = {}): AgentView => ({ ...fixtureAgents[0]!, ...over });

// Two machines in one crew, each with its own `w6:p1`.
const onA = (over: Partial<AgentView> = {}) =>
  pane({ host: "member-a", paneId: "w6:p1", workspaceLabel: "build", ...over });
const onB = (over: Partial<AgentView> = {}) =>
  pane({ host: "member-b", paneId: "w6:p1", workspaceLabel: "docs", ...over });

describe("useAgentTransitions", () => {
  beforeEach(() => vi.clearAllMocks());

  const render = (agents: AgentView[], openPaneKey: string | null = null) => {
    const hook = renderHook((a: AgentView[]) => useAgentTransitions(a, openPaneKey), { initialProps: agents });
    return (next: AgentView[]) => hook.rerender(next);
  };

  it("announces a pane that finishes, once", () => {
    const poll = render([pane({ paneId: "w1:p1", status: "working", workspaceLabel: "alpha" })]);
    poll([pane({ paneId: "w1:p1", status: "done", workspaceLabel: "alpha" })]);
    poll([pane({ paneId: "w1:p1", status: "done", workspaceLabel: "alpha" })]);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("claude is done · alpha", "success");
  });

  it("stays quiet when two machines expose the same pane id in different states", () => {
    const herd = () => [onA({ status: "done" }), onB({ status: "idle" })];
    const poll = render(herd());
    poll(herd());
    poll(herd());
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("still announces the one that finishes when its id collides with another machine's pane", () => {
    const poll = render([onA({ status: "working" }), onB({ status: "idle" })]);
    poll([onA({ status: "done" }), onB({ status: "idle" })]);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("claude is done · build", "success");
  });

  it("silences only the open pane, not another machine's pane with the same id", () => {
    const poll = render([onA({ status: "working" }), onB({ status: "working" })], paneRowKey(onB()));
    poll([onA({ status: "done" }), onB({ status: "done" })]);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("claude is done · build", "success");
  });

  it("suppresses foreground done notice for a child pane with a live parent while keeping blocked alerts", () => {
    const poll = render([
      pane({ paneId: "w1:p1", status: "working", workspaceLabel: "alpha" }),
      pane({ paneId: "w1:p2", status: "working", workspaceLabel: "alpha", parentPaneId: "w1:p1" }),
    ]);

    // Child finishes: no foreground done status.
    poll([
      pane({ paneId: "w1:p1", status: "working", workspaceLabel: "alpha" }),
      pane({ paneId: "w1:p2", status: "done", workspaceLabel: "alpha", parentPaneId: "w1:p1" }),
    ]);
    expect(setStatus).not.toHaveBeenCalled();

    // Child blocks: warn status still fires.
    poll([
      pane({ paneId: "w1:p1", status: "working", workspaceLabel: "alpha" }),
      pane({ paneId: "w1:p2", status: "blocked", workspaceLabel: "alpha", parentPaneId: "w1:p1" }),
    ]);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("claude needs you · alpha", "warn");

    // Normal parent without parentPaneId still announces done.
    poll([
      pane({ paneId: "w1:p1", status: "done", workspaceLabel: "alpha" }),
      pane({ paneId: "w1:p2", status: "blocked", workspaceLabel: "alpha", parentPaneId: "w1:p1" }),
    ]);
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenLastCalledWith("claude is done · alpha", "success");
  });
});
