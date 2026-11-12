import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentList } from "./agent-list";
import { STILL_QUIET_MS } from "@/hooks/use-still-list";
import { __resetDashFilter } from "@/lib/dash-filter";
import type { AgentStatus, AgentView, TabView } from "@/lib/types";

// THE DASHBOARD'S LIST, HELD STILL UNDER A FINGER (hitbox proposal 2), through the real AgentList: a pane that
// arrives or leaves waits while a finger is down, a status changes in place, and the summary line is never held.

function agent(paneId: string, status: AgentStatus, name: string): AgentView {
  return {
    paneId,
    workspaceId: "w0",
    workspaceLabel: "work",
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status,
    cwd: "/home/k/proj",
    focused: false,
    sessionName: name,
  };
}

const rows = () => screen.getAllByRole("button").filter((b) => b.closest("section") !== null).map((b) => b.textContent ?? "");
const summary = () => document.getElementById("dash-summary-line")?.textContent ?? "";

function touch(type: "touchstart" | "touchend", el: Element, id: number): void {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, "changedTouches", { value: [{ identifier: id, target: el }] });
  act(() => {
    el.dispatchEvent(e);
  });
}

describe("AgentList held still under a finger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDashFilter();
  });
  afterEach(() => vi.useRealTimers());

  it("an arriving pane waits, a status changes in place, and the summary counts the live herd", () => {
    const a = agent("w0:p1", "idle", "alpha");
    const b = agent("w0:p2", "working", "beta");
    const { rerender, container } = render(<AgentList agents={[a, b]} onOpen={vi.fn()} />);
    const first = rows();
    expect(first).toHaveLength(2);

    touch("touchstart", container.querySelector("section")!, 1);
    // A poll: a new blocked pane arrives above, and beta changes to blocked.
    const arrived = agent("w0:p0", "blocked", "newcomer");
    rerender(<AgentList agents={[arrived, a, { ...b, status: "blocked" }]} onOpen={vi.fn()} />);

    const held = rows();
    expect(held).toHaveLength(2);
    expect(held.join("|")).not.toContain("newcomer");
    // The summary line reads the LIVE herd: two panes need you, though only one is drawn.
    expect(summary()).toMatch(/2/u);
    expect(held.some((r) => /needs you|blocked/iu.test(r))).toBe(true);

    touch("touchend", container.querySelector("section")!, 1);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS));
    expect(rows().join("|")).toContain("newcomer");
    expect(rows()).toHaveLength(3);
  });

  it("a pane that leaves stays under the finger and goes after it", () => {
    const a = agent("w0:p1", "idle", "alpha");
    const b = agent("w0:p2", "working", "beta");
    const c = agent("w0:p3", "idle", "gamma");
    const { rerender, container } = render(<AgentList agents={[a, b, c]} onOpen={vi.fn()} />);
    touch("touchstart", container.querySelector("section")!, 1);
    rerender(<AgentList agents={[a, c]} onOpen={vi.fn()} />);
    expect(rows()).toHaveLength(3);
    touch("touchend", container.querySelector("section")!, 1);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS));
    expect(rows()).toHaveLength(2);
  });

  it("a pane whose tab closes with it keeps its place while held: the tab list is held too", () => {
    const tab = (n: number): TabView => ({ tabId: `w0:t${String(n)}`, workspaceId: "w0", number: n, label: `tab ${String(n)}`, focused: false, paneCount: 1 });
    const inTab = (id: string, n: number, name: string): AgentView => ({ ...agent(id, "idle", name), tabId: `w0:t${String(n)}` });
    const a = inTab("w0:p1", 1, "alpha");
    const b = inTab("w0:p2", 2, "beta");
    const c = inTab("w0:p3", 3, "gamma");
    const { rerender, container } = render(<AgentList agents={[a, b, c]} tabs={[tab(1), tab(2), tab(3)]} onOpen={vi.fn()} />);
    const before = rows();
    touch("touchstart", container.querySelector("section")!, 1);
    // A poll that closes the middle tab with its pane.
    rerender(<AgentList agents={[a, c]} tabs={[tab(1), tab(3)]} onOpen={vi.fn()} />);
    expect(rows()).toEqual(before);
    touch("touchend", container.querySelector("section")!, 1);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS));
    expect(rows()).toHaveLength(2);
  });

  it("needs-you mode: a row whose status just turned idle stays and one that just began to need you waits", () => {
    const a = agent("w0:p1", "blocked", "alpha");
    const b = agent("w0:p2", "blocked", "beta");
    const c = agent("w0:p3", "idle", "gamma");
    const props = { onOpen: vi.fn(), needsYouOnly: true };
    const { rerender, container } = render(<AgentList agents={[a, b, c]} {...props} />);
    const names = () => rows().map((r) => ["alpha", "beta", "gamma"].find((n) => r.includes(n)));
    expect(names()).toEqual(["alpha", "beta"]);
    touch("touchstart", container.querySelector("section")!, 1);
    // A poll: alpha was answered (idle) and gamma now needs you. Unheld, alpha leaves and gamma joins, and beta slides up.
    rerender(<AgentList agents={[{ ...a, status: "idle" }, b, { ...c, status: "blocked" }]} {...props} />);
    expect(names()).toEqual(["alpha", "beta"]);
    // alpha is drawn with its LIVE status: it no longer says it needs you.
    expect(rows()[0]).not.toMatch(/needs you|blocked/iu);
    touch("touchend", container.querySelector("section")!, 1);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS));
    expect(names()).toEqual(["beta", "gamma"]);
  });

  it("a list nobody touches changes at once", () => {
    const a = agent("w0:p1", "idle", "alpha");
    const { rerender } = render(<AgentList agents={[a]} onOpen={vi.fn()} />);
    rerender(<AgentList agents={[agent("w0:p0", "idle", "newcomer"), a]} onOpen={vi.fn()} />);
    expect(rows()).toHaveLength(2);
  });
});
