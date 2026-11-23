import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDashFilter } from "@/lib/dash-filter";
import { paneRowKey } from "@/lib/hosts";
import { groupPanesByWorkspace, workspaceGroupKey } from "@/lib/pane-groups";
import { dropSpaceLanding, peekSpaceLanding, queueSpaceLanding } from "@/lib/space-landing";
import type { AgentView } from "@/lib/types";
import { AgentList, workspacePrefKey } from "./agent-list";

// OPEN THIS SPACE, ON A LARGE SCREEN (`open_space`): the Dashboard opens at one space. These cases draw the
// grid with a landing asked for and read where the focus and the scroll end up, and what the list had to
// clear to show the space. The place order and the controls are the page's own (agent-list-wide.test.tsx).

function seat(ws: number, n: number, status: AgentView["status"]): AgentView {
  return {
    paneId: `w${ws}:p${n}`,
    workspaceId: `w${ws}`,
    workspaceLabel: `space-${ws}`,
    workspaceNumber: ws,
    tabId: `w${ws}:t1`,
    agent: n === 1 ? "claude" : "codex",
    status,
    cwd: `/home/you/space-${ws}`,
    focused: false,
    terminalTitle: `job ${ws}.${n}`,
  };
}

// Four spaces of two: eight rows, above the five a list needs before it offers its filter field.
const AGENTS = [1, 2, 3, 4].flatMap((ws) => [seat(ws, 1, ws === 1 ? "blocked" : "working"), seat(ws, 2, "idle")]);
const GROUPS = groupPanesByWorkspace(AGENTS, [], { order: "fixed" });
const groupOf = (ws: number) => GROUPS.find((g) => g.label === `space-${ws}`)!;
const keyOf = (ws: number) => workspaceGroupKey(AGENTS.find((a) => a.workspaceId === `w${ws}`)!);
const prefOf = (ws: number) => workspacePrefKey(groupOf(ws));
const rowId = (pane: AgentView) => `pane-row-${paneRowKey(pane).replace(/[^A-Za-z0-9_-]/gu, "_")}`;

interface Start {
  isolated?: string[];
  hidden?: string[];
  needsYouOnly?: boolean;
  query?: string;
}
const seen = { isolated: new Array<string>(), hidden: new Array<string>(), needsYouOnly: false, query: "" };

/** The route's own state for the four things that narrow the list, and nothing else. */
function Harness({ start }: { start: Start }) {
  const [isolated, setIsolated] = useState(start.isolated ?? []);
  const [hidden, setHidden] = useState(start.hidden ?? []);
  const [needsYouOnly, setNeedsYouOnly] = useState(start.needsYouOnly ?? false);
  const [query, setQuery] = useState(start.query ?? "");
  const [open, setOpen] = useState(false);
  Object.assign(seen, { isolated, hidden, needsYouOnly, query });
  return (
    <MemoryRouter>
      <AgentList
        agents={AGENTS}
        bridge="connected"
        onOpen={() => {}}
        onOrderChange={() => {}}
        wide={{ columns: 2 }}
        isolated={isolated}
        onIsolate={setIsolated}
        hidden={hidden}
        onToggleHidden={(key) => setHidden((h) => (h.includes(key) ? h.filter((k) => k !== key) : [...h, key]))}
        needsYouOnly={needsYouOnly}
        onNeedsYouOnlyChange={setNeedsYouOnly}
        filter={{ query, open, setQuery, setOpen }}
      />
    </MemoryRouter>
  );
}

const scrolled = vi.fn();
beforeEach(() => {
  __resetDashFilter();
  Object.assign(seen, { isolated: [], hidden: [], needsYouOnly: false, query: "" });
  scrolled.mockClear();
  Element.prototype.scrollIntoView = scrolled;
});
afterEach(() => {
  cleanup();
  dropSpaceLanding();
});

async function land(ws: number, start: Start = {}) {
  queueSpaceLanding(keyOf(ws));
  await act(async () => {
    render(<Harness start={start} />);
  });
}

const first = (ws: number) => AGENTS.find((a) => a.workspaceId === `w${ws}`)!;
// The key holds NUL characters, which a selector cannot carry.
const column = (ws: number) => [...document.querySelectorAll<HTMLElement>("[data-space]")].find((el) => el.getAttribute("data-space") === keyOf(ws)) ?? null;
const scrolledTo = () => scrolled.mock.contexts.map((el) => (el instanceof HTMLElement ? (el.getAttribute("data-space") ?? el.id) : ""));

describe("the Dashboard landed on a space", () => {
  it("brings the space's column into view and focuses the first row of that column", async () => {
    await land(3);
    expect(scrolledTo()).toContain(keyOf(3));
    expect(document.activeElement).toBe(document.getElementById(rowId(first(3))));
    expect(document.activeElement?.closest("[data-space]")).toBe(column(3));
    expect(peekSpaceLanding()).toBeNull();
    // Nothing was cleared that was not hiding it.
    expect(seen).toEqual({ isolated: [], hidden: [], needsYouOnly: false, query: "" });
  });

  it("does nothing when no space was asked for", async () => {
    await act(async () => {
      render(<Harness start={{}} />);
    });
    expect(scrolled).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("adds the space to a workspace choice that left it out, and keeps the spaces the choice named", async () => {
    await land(3, { isolated: [prefOf(1)] });
    expect(seen.isolated).toEqual([prefOf(1), prefOf(3)]);
    expect(column(2)).toBeNull();
    expect(document.activeElement).toBe(document.getElementById(rowId(first(3))));
  });

  it("leaves a workspace choice alone that already holds the space", async () => {
    await land(3, { isolated: [prefOf(3)] });
    expect(seen.isolated).toEqual([prefOf(3)]);
    expect(document.activeElement).toBe(document.getElementById(rowId(first(3))));
  });

  it("shows a hidden space again, and only that one", async () => {
    await land(3, { hidden: [prefOf(2), prefOf(3)] });
    expect(seen.hidden).toEqual([prefOf(2)]);
    expect(column(3)).not.toBeNull();
    expect(document.activeElement).toBe(document.getElementById(rowId(first(3))));
  });

  it("turns the needs-you switch off when none of the space's sessions needs you", async () => {
    await land(3, { needsYouOnly: true });
    expect(seen.needsYouOnly).toBe(false);
    expect(document.activeElement).toBe(document.getElementById(rowId(first(3))));
  });

  it("keeps the needs-you switch on for a space that has a session waiting on you", async () => {
    await land(1, { needsYouOnly: true });
    expect(seen.needsYouOnly).toBe(true);
    expect(document.activeElement).toBe(document.getElementById(rowId(first(1))));
  });

  it("clears the filter text that leaves the space no row, and keeps one that matches it", async () => {
    await land(3, { query: "space-1" });
    expect(seen.query).toBe("");
    expect(document.activeElement).toBe(document.getElementById(rowId(first(3))));
    cleanup();
    dropSpaceLanding();
    __resetDashFilter();
    await land(3, { query: "space-3" });
    expect(seen.query).toBe("space-3");
    expect(document.activeElement).toBe(document.getElementById(rowId(first(3))));
  });

  it("clears each of them in one visit when all of them hide the space", async () => {
    await land(3, { isolated: [prefOf(1)], needsYouOnly: true, query: "space-1" });
    expect(seen.isolated).toEqual([prefOf(1), prefOf(3)]);
    expect(seen.needsYouOnly).toBe(false);
    expect(seen.query).toBe("");
    expect(document.activeElement).toBe(document.getElementById(rowId(first(3))));
  });

  it("spends the ask on a space that is gone, and changes nothing", async () => {
    queueSpaceLanding(`gone\u0000\u0000w9`);
    await act(async () => {
      render(<Harness start={{ hidden: [prefOf(2)], needsYouOnly: true }} />);
    });
    expect(peekSpaceLanding()).toBeNull();
    expect(seen.hidden).toEqual([prefOf(2)]);
    expect(seen.needsYouOnly).toBe(true);
  });
});
