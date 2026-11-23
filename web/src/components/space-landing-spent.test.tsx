import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDashFilter } from "@/lib/dash-filter";
import { groupPanesByWorkspace, workspaceGroupKey } from "@/lib/pane-groups";
import { dropSpaceLanding, peekSpaceLanding, queueSpaceLanding, type LandingFacts } from "@/lib/space-landing";
import type { AgentView } from "@/lib/types";

import { AgentList, workspacePrefKey } from "./agent-list";
import { SpaceLanding } from "./space-landing";

// A landing never outlives the navigation that asked for it: one whose next step was already tried is spent and is
// dropped, and one that has not landed when the Dashboard unmounts is dropped with it.

function seat(ws: number, n: number, status: AgentView["status"]): AgentView {
  return { paneId: `w${ws}:p${n}`, workspaceId: `w${ws}`, workspaceLabel: `space-${ws}`, workspaceNumber: ws, tabId: `w${ws}:t1`, agent: n === 1 ? "claude" : "codex", status, cwd: `/home/you/space-${ws}`, focused: false, terminalTitle: `job ${ws}.${n}` };
}
const AGENTS = [1, 2, 3, 4].flatMap((ws) => [seat(ws, 1, ws === 1 ? "blocked" : "working"), seat(ws, 2, "idle")]);
const GROUPS = groupPanesByWorkspace(AGENTS, [], { order: "fixed" });
const keyOf = (ws: number) => workspaceGroupKey(AGENTS.find((a) => a.workspaceId === `w${ws}`)!);
const prefOf = (ws: number) => workspacePrefKey(GROUPS.find((g) => g.label === `space-${ws}`)!);

beforeEach(() => {
  __resetDashFilter();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  dropSpaceLanding();
});

describe("a landing whose clear step does nothing", () => {
  it("is dropped, not kept for a later Dashboard visit", async () => {
    queueSpaceLanding(keyOf(3));
    // The space is hidden, and this host of the list gives no way to show it again (the callback is optional).
    await act(async () => {
      render(
        <MemoryRouter>
          <AgentList agents={AGENTS} bridge="connected" onOpen={() => {}} onOrderChange={() => {}} wide={{ columns: 2 }} hidden={[prefOf(3)]} filter={{ query: "", open: false, setQuery: () => {}, setOpen: () => {} }} />
        </MemoryRouter>,
      );
    });
    expect(peekSpaceLanding()).toBeNull();
  });
});

describe("the landing component", () => {
  const FACTS: LandingFacts = { exists: true, choiceExcludes: false, hiddenSpace: false, hiddenMachine: false, needsYouHides: false, queryHides: false, drawn: true };
  const NO_CLEAR = { workspaceChoice: () => {}, hiddenSpace: () => {}, hiddenMachine: () => {}, needsYouOnly: () => {}, query: () => {} };

  it("drops a landing that has not landed when it unmounts", () => {
    queueSpaceLanding(keyOf(3));
    // No row in the document to focus: the landing waits for the next commit.
    const view = render(<SpaceLanding facts={FACTS} clear={NO_CLEAR} columnId={null} rowId="pane-row-missing" />);
    expect(peekSpaceLanding()).toBe(keyOf(3));
    view.unmount();
    expect(peekSpaceLanding()).toBeNull();
  });

  it("drops a landing whose next step was already tried", () => {
    queueSpaceLanding(keyOf(3));
    const clear = vi.fn();
    const facts = { ...FACTS, hiddenSpace: true };
    const view = render(<SpaceLanding facts={facts} clear={{ ...NO_CLEAR, hiddenSpace: clear }} columnId={null} rowId={null} />);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(peekSpaceLanding()).toBe(keyOf(3));
    view.rerender(<SpaceLanding facts={facts} clear={{ ...NO_CLEAR, hiddenSpace: clear }} columnId={null} rowId={null} />);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(peekSpaceLanding()).toBeNull();
  });
});
