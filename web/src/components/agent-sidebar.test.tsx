import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { matchPanes, PaneFilterField, shouldFilter, ThreadSidebar } from "./agent-sidebar";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

const idleAgent: AgentView = {
  paneId: "w3:p1",
  workspaceId: "w3",
  workspaceLabel: "sandbox",
  workspaceNumber: 3,
  tabId: "w3:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/sandbox",
  focused: false,
};

describe("ThreadSidebar", () => {
  it("renders an empty state when there are no agents", () => {
    render(<ThreadSidebar agents={[]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.getByText("No agents running.")).toBeInTheDocument();
  });

  it("groups agents into the same triage sections the dashboard uses", () => {
    render(
      <ThreadSidebar agents={[...fixtureAgents, idleAgent]} currentPaneId="" onSelect={vi.fn()} />,
    );
    // blocked → Needs you, working → Working, idle → Recent (lib/triage.ts)
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("Recent")).toBeInTheDocument();
  });

  it("omits groups that have no members", () => {
    // Only a blocked agent → no Working / Recent headers.
    render(<ThreadSidebar agents={[fixtureAgents[0]!]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("marks the current pane with aria-current='page'", () => {
    render(<ThreadSidebar agents={fixtureAgents} currentPaneId="w2:p1" onSelect={vi.fn()} />);
    const current = screen.getByRole("button", { current: "page" });
    // w2:p1 lives in the "collie" workspace. The row is titled by where the work IS, not by which
    // agent is doing it — "codex" is carried by the avatar (see paneTitle).
    expect(current).toHaveTextContent("collie");
    expect(current).not.toHaveTextContent("codex");
  });

  it("does not mark any pane current when the id matches nothing", () => {
    render(<ThreadSidebar agents={fixtureAgents} currentPaneId="nope" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { current: "page" })).toBeNull();
  });

  it("fires onSelect with the pane id when a thread is tapped", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ThreadSidebar agents={fixtureAgents} currentPaneId="w2:p1" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /webapp/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p1");
  });

  const shellPane: AgentView = {
    paneId: "w3:p2",
    workspaceId: "w3",
    workspaceLabel: "sandbox",
    workspaceNumber: 3,
    tabId: "w3:t2",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/sandbox",
    focused: false,
    kind: "shell",
  };

  it("lists bare shell panes under a Shells group and makes them selectable", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={[shellPane]}
        currentPaneId=""
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("Shells")).toBeInTheDocument();
    // The shell row is titled by its space like every other row; the terminal glyph is what marks
    // it as a shell. It's the only pane in "sandbox" here, so the name is unambiguous.
    await user.click(screen.getByRole("button", { name: /sandbox/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w3:p2");
  });

  it("still renders shells when there are no agents (fresh space reachable)", () => {
    render(<ThreadSidebar agents={[]} shellPanes={[shellPane]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.queryByText("No agents running.")).toBeNull();
    expect(screen.getByText("Shells")).toBeInTheDocument();
  });

  it("is switch-only — no close control on any row", () => {
    render(<ThreadSidebar agents={[fixtureAgents[0]!]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("gives each section a status-colored bullet from the shared group palette", () => {
    const { container } = render(
      <ThreadSidebar
        agents={[...fixtureAgents, idleAgent]}
        shellPanes={[shellPane]}
        currentPaneId=""
        onSelect={vi.fn()}
      />,
    );
    // One dot per section, colored by the same status palette the badges use.
    for (const cls of ["bg-status-blocked", "bg-status-working", "bg-status-idle", "bg-status-unknown"]) {
      expect(container.getElementsByClassName(cls).length).toBeGreaterThan(0);
    }
  });
});

// The "Switch pane" sheet sees the WHOLE herd, so it has the dashboard's original problem: the two
// long tails (Recent, and the bare shells) bury the handful of agents you opened it to reach.
describe("ThreadSidebar — folding the long tails", () => {
  const manyShells: AgentView[] = Array.from({ length: 12 }, (_, i) => ({
    paneId: `w3:s${i}`,
    workspaceId: "w3",
    workspaceLabel: `scratch${i}`,
    workspaceNumber: 3,
    tabId: "w3:t2",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/sandbox",
    focused: false,
    kind: "shell",
  }));

  it("folds Shells away, keeping the count and the agents visible", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneId=""
        onSelect={vi.fn()}
        shellsOpen={false}
        onShellsOpenChange={vi.fn()}
      />,
    );
    expect(screen.queryByText("scratch0")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /shells/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("(12)")).toBeInTheDocument();
    // The agents you came for are still there.
    expect(screen.getByText("webapp")).toBeInTheDocument();
  });

  it("shows the shells again when expanded", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneId=""
        onSelect={vi.fn()}
        shellsOpen
        onShellsOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText("scratch0")).toBeInTheDocument();
  });

  it("reports the Shells fold to its owner rather than keeping the state itself", async () => {
    const user = userEvent.setup();
    const onShellsOpenChange = vi.fn();
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneId=""
        onSelect={vi.fn()}
        shellsOpen
        onShellsOpenChange={onShellsOpenChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /shells/i }));
    expect(onShellsOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("folds Recent too, the same way the dashboard does", async () => {
    const user = userEvent.setup();
    const onRecentOpenChange = vi.fn();
    render(
      <ThreadSidebar
        agents={[...fixtureAgents, idleAgent]}
        currentPaneId=""
        onSelect={vi.fn()}
        recentOpen
        onRecentOpenChange={onRecentOpenChange}
      />,
    );
    expect(screen.getByText("sandbox")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /recent/i }));
    expect(onRecentOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("never offers a fold on the attention sections", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneId=""
        onSelect={vi.fn()}
        recentOpen
        onRecentOpenChange={vi.fn()}
        shellsOpen
        onShellsOpenChange={vi.fn()}
      />,
    );
    // fixtureAgents are blocked + working; only Shells should be expandable here.
    const expandable = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent);
    expect(expandable).toHaveLength(1);
    expect(expandable[0]).toMatch(/shells/i);
  });

  it("stays un-foldable when the parent wires nothing, as before", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneId=""
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("scratch0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
  });
});

// Three things the switcher has to get right once the herd is genuinely large. Measured on a real
// 58-pane herd before this: 1133px of content in a 543px sheet (2376px with the shells open), no
// filter, and — opening it from a shell — no "you are here" rendered anywhere at all.
describe("ThreadSidebar — at herd scale", () => {
  const manyAgents: AgentView[] = Array.from({ length: 10 }, (_, i) => ({
    paneId: `w9:p${i}`,
    workspaceId: "w9",
    workspaceLabel: "bighouse",
    workspaceNumber: 9,
    tabId: `w9:t${i}`,
    tabLabel: `chore-${i}`,
    agent: "claude",
    status: "idle",
    cwd: "/home/you/bighouse",
    focused: false,
    lastSeenAt: Date.now() - i * 1000,
  }));

  const manyShells: AgentView[] = Array.from({ length: 12 }, (_, i) => ({
    paneId: `w3:s${i}`,
    workspaceId: "w3",
    workspaceLabel: `scratch${i}`,
    workspaceNumber: 3,
    tabId: "w3:t2",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/sandbox",
    focused: false,
    kind: "shell",
  }));

  it("gets no filter on a herd small enough to just read", () => {
    expect(shouldFilter(fixtureAgents.length)).toBe(false);
  });

  it("gets a filter once the list is long enough to scroll", () => {
    expect(shouldFilter(manyAgents.length)).toBe(true);
  });

  it("narrows to the matching panes and drops the sections while filtering", () => {
    render(<ThreadSidebar agents={manyAgents} currentPaneId="" onSelect={vi.fn()} query="chore-7" />);
    expect(screen.getByText("chore-7")).toBeInTheDocument();
    expect(screen.queryByText("chore-6")).toBeNull();
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("matches on the space name too, not just the tab", () => {
    render(
      <ThreadSidebar
        agents={[...manyAgents, ...fixtureAgents]}
        currentPaneId=""
        onSelect={vi.fn()}
        query="webapp"
      />,
    );
    expect(screen.getByText("webapp")).toBeInTheDocument();
    expect(screen.queryByText("chore-0")).toBeNull();
  });

  it("says so rather than showing an empty list when nothing matches", () => {
    render(<ThreadSidebar agents={manyAgents} currentPaneId="" onSelect={vi.fn()} query="zzz" />);
    expect(screen.getByText(/No panes match/)).toBeInTheDocument();
  });

  it("leads with the space you're already in — the one thing the dashboard can't know", () => {
    render(
      <ThreadSidebar
        agents={manyAgents}
        currentPaneId="w9:p0"
        currentSpaceId="w9"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Here · bighouse")).toBeInTheDocument();
  });

  it("omits Here when the space holds nothing else to switch to", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneId="w1:p1"
        currentSpaceId="w1"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^Here/)).toBeNull();
  });

  it("hands a space bigger than the cap to the space route instead of growing the sheet", async () => {
    const user = userEvent.setup();
    const onOpenSpace = vi.fn();
    render(
      <ThreadSidebar
        agents={manyAgents}
        currentPaneId="w9:p0"
        currentSpaceId="w9"
        onOpenSpace={onOpenSpace}
        onSelect={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Open bighouse \(5 more\)/ }));
    expect(onOpenSpace).toHaveBeenCalledExactlyOnceWith("w9");
  });

  it("shows you where you are even when your section is folded shut", () => {
    // The regression: 34 shells collapse the group by default, so opening the switcher from a shell
    // rendered no aria-current anywhere — the row wasn't in the DOM to be marked.
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneId="w3:s7"
        onSelect={vi.fn()}
        shellsOpen={false}
        onShellsOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { current: "page" })).toHaveTextContent("scratch7");
  });

  it("still folds a section that does NOT hold the pane you're in", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
        shellsOpen={false}
        onShellsOpenChange={vi.fn()}
      />,
    );
    expect(screen.queryByText("scratch7")).toBeNull();
  });

  it("nominates the current row as where the sheet should open, exactly once", () => {
    const { container } = render(
      <ThreadSidebar
        agents={manyAgents}
        currentPaneId="w9:p3"
        currentSpaceId="w9"
        onSelect={vi.fn()}
      />,
    );
    // Present under Here AND under Recent — but only one may claim the focus/scroll target.
    expect(container.querySelectorAll("[data-autofocus]")).toHaveLength(1);
  });

  it("carries an age per row, like the dashboard listing the same panes", () => {
    render(<ThreadSidebar agents={manyAgents} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.getAllByText("now").length).toBe(manyAgents.length);
  });

  it("names each row's status for a screen reader, which the section heading no longer does", () => {
    render(
      <ThreadSidebar
        agents={manyAgents}
        currentPaneId="w9:p0"
        currentSpaceId="w9"
        onSelect={vi.fn()}
      />,
    );
    // Under "Here" the grouping is by space, so the row itself has to say what the pane is doing —
    // the section heading above it says "bighouse", not "Recent". The current pane shows up under
    // Here AND in its triage section, and both instances are truthfully the current page.
    for (const row of screen.getAllByRole("button", { current: "page" })) {
      expect(row).toHaveTextContent(/idle/i);
    }
  });
});

// Findings from the first independent UX review pass, each pinned so the next change can't undo it.
describe("ThreadSidebar — filtering keeps the promises the sections make", () => {
  const spread: AgentView[] = [
    { paneId: "w5:p1", workspaceId: "w5", workspaceLabel: "orchard", workspaceNumber: 5, tabId: "w5:t1", tabLabel: "quiet", agent: "claude", status: "idle", cwd: "/o", focused: false, lastActiveAt: 5000 },
    { paneId: "w5:p2", workspaceId: "w5", workspaceLabel: "orchard", workspaceNumber: 5, tabId: "w5:t2", tabLabel: "busy", agent: "claude", status: "working", cwd: "/o", focused: false, lastActiveAt: 4000 },
    { paneId: "w5:p3", workspaceId: "w5", workspaceLabel: "orchard", workspaceNumber: 5, tabId: "w5:t3", tabLabel: "stuck", agent: "claude", status: "blocked", cwd: "/o", focused: false, lastActiveAt: 1000 },
  ];

  it("orders matches most-urgent-first, exactly like the sections do", () => {
    // The regression: `matches` was raw snapshot order, so typing put a blocked pane below idle ones
    // — the one thing the switcher and the dashboard are contractually forbidden to disagree about.
    expect(matchPanes(spread, "orchard").map((p) => p.tabLabel)).toEqual(["stuck", "busy", "quiet"]);
  });

  it("returns nothing for an empty query, so the caller shows its sections", () => {
    expect(matchPanes(spread, "   ")).toEqual([]);
  });

  it("offers a way out of a dead-end filter", async () => {
    const user = userEvent.setup();
    const onClearQuery = vi.fn();
    render(
      <ThreadSidebar
        agents={spread}
        currentPaneId=""
        onSelect={vi.fn()}
        query="zzz"
        onClearQuery={onClearQuery}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(onClearQuery).toHaveBeenCalledOnce();
  });

  it("announces the match count to a screen reader as it changes", () => {
    const { rerender } = render(
      <ThreadSidebar agents={spread} currentPaneId="" onSelect={vi.fn()} query="orchard" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("3 panes match");
    rerender(<ThreadSidebar agents={spread} currentPaneId="" onSelect={vi.fn()} query="stuck" />);
    expect(screen.getByRole("status")).toHaveTextContent("1 pane matches");
  });
});

describe("PaneFilterField", () => {
  it("says how much it is filtering", () => {
    render(<PaneFilterField value="" onChange={vi.fn()} total={61} />);
    expect(screen.getByLabelText("Filter panes")).toHaveAttribute("placeholder", "Filter 61 panes…");
  });

  it("keeps the phone keyboard sane — search mode, a 'go' key, no autocorrect", () => {
    render(<PaneFilterField value="" onChange={vi.fn()} total={61} />);
    const input = screen.getByLabelText("Filter panes");
    expect(input).toHaveAttribute("inputmode", "search");
    expect(input).toHaveAttribute("enterkeyhint", "go");
    expect(input).toHaveAttribute("autocorrect", "off");
  });

  it("offers no clear button until there is something to clear", () => {
    const { rerender } = render(<PaneFilterField value="" onChange={vi.fn()} total={61} />);
    expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();
    rerender(<PaneFilterField value="moon" onChange={vi.fn()} total={61} />);
    expect(screen.getByRole("button", { name: "Clear filter" })).toBeInTheDocument();
  });

  it("clears in one tap rather than seventeen backspaces", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PaneFilterField value="moonward_os · tou" onChange={onChange} total={61} />);
    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("");
  });

  it("commits on Enter when the query resolves to exactly one pane", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<PaneFilterField value="stuck" onChange={vi.fn()} total={61} onCommit={onCommit} />);
    await user.type(screen.getByLabelText("Filter panes"), "{Enter}");
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("does nothing on Enter while the query is ambiguous — selecting navigates you away", async () => {
    const user = userEvent.setup();
    render(<PaneFilterField value="orchard" onChange={vi.fn()} total={61} />);
    // No onCommit wired = more than one match; Enter must not guess which one you meant.
    await user.type(screen.getByLabelText("Filter panes"), "{Enter}");
    expect(screen.getByLabelText("Filter panes")).toHaveValue("orchard");
  });
});

// Findings from the second independent UX review pass — semantics and information architecture.
describe("ThreadSidebar — the age explains the order, and the row says what it is", () => {
  const now = Date.now();
  // Deliberately opposed timestamps: `lastActiveAt` is ancient, `lastSeenAt` is fresh. Recent SORTS
  // on lastSeenAt, so a row dated by lastActiveAt prints an age that contradicts its own position.
  const staleActive: AgentView = {
    paneId: "w7:p1", workspaceId: "w7", workspaceLabel: "orchard", workspaceNumber: 7,
    tabId: "w7:t1", tabLabel: "pruning", agent: "claude", status: "idle", cwd: "/o", focused: false,
    lastActiveAt: now - 13 * 3600_000, lastSeenAt: now - 60_000,
  };
  const workingPane: AgentView = { ...staleActive, paneId: "w7:p2", tabLabel: "grafting", status: "working" };
  const shell: AgentView = {
    paneId: "w7:p3", workspaceId: "w7", workspaceLabel: "orchard", workspaceNumber: 7,
    tabId: "w7:t3", agent: "shell", status: "unknown", cwd: "/o", focused: false, kind: "shell",
    lastActiveAt: now - 15 * 3600_000, lastSeenAt: now - 120_000,
  };

  it("dates a Recent row by when you last SAW it — the key that section sorts on", () => {
    render(<ThreadSidebar agents={[staleActive]} currentPaneId="" onSelect={vi.fn()} />);
    // 1m ago, not 13h ago. The switcher printed 13h here while the dashboard printed 1m.
    expect(screen.getByRole("button", { name: /pruning/ })).toHaveTextContent("1m");
  });

  it("dates a Working row by when it last CHANGED — which is what that section sorts on", () => {
    render(<ThreadSidebar agents={[workingPane]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /grafting/ })).toHaveTextContent("13h");
  });

  it("dates a shell by when you last opened it — its lastActiveAt never moves", () => {
    render(<ThreadSidebar agents={[]} shellPanes={[shell]} currentPaneId="" onSelect={vi.fn()} />);
    // 2m, not the 15h that made 32 of 34 shell rows print an identical, meaningless age.
    expect(screen.getByRole("button", { name: /orchard/ })).toHaveTextContent("2m");
  });

  it("orders shells by when you last opened them, not alphabetically", () => {
    const older: AgentView = { ...shell, paneId: "w7:p4", workspaceLabel: "aaa-alphabetically-first", lastSeenAt: now - 9_000_000 };
    render(<ThreadSidebar agents={[]} shellPanes={[older, shell]} currentPaneId="" onSelect={vi.fn()} />);
    const rows = screen.getAllByRole("button").filter((b) => /orchard|aaa-alpha/.test(b.textContent ?? ""));
    expect(rows[0]).toHaveTextContent("orchard");
  });

  it("tells a screen reader a shell is a shell — the icon is decorative", () => {
    render(<ThreadSidebar agents={[]} shellPanes={[shell]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /shell/i })).toBeInTheDocument();
  });

  it("announces status AFTER the pane's name, the way the dashboard does", () => {
    render(<ThreadSidebar agents={[workingPane]} currentPaneId="" onSelect={vi.fn()} />);
    const name = screen.getByRole("button", { name: /grafting/ }).textContent ?? "";
    expect(name.indexOf("grafting")).toBeLessThan(name.toLowerCase().indexOf("working"));
  });

  it("drops the project inside Here — the heading already said it", () => {
    render(
      <ThreadSidebar
        agents={[staleActive, workingPane]}
        currentPaneId="w7:p1"
        currentSpaceId="w7"
        onSelect={vi.fn()}
      />,
    );
    const hereSection = screen.getByText("Here · orchard").closest("section")!;
    const firstRow = hereSection.querySelectorAll("button")[0]!;
    expect(firstRow).not.toHaveTextContent("orchard");
  });

  it("tells a screen reader that Here is a shortcut, not a separate set of panes", () => {
    render(
      <ThreadSidebar
        agents={[staleActive, workingPane]}
        currentPaneId="w7:p1"
        currentSpaceId="w7"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/also listed under its status below/)).toBeInTheDocument();
  });

  it("states an empty result once, not three times", () => {
    render(<ThreadSidebar agents={[staleActive]} currentPaneId="" onSelect={vi.fn()} query="zzz" />);
    // The visible sentence IS the live region; there is no second sr-only copy of the same fact.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("No panes match");
  });
});
