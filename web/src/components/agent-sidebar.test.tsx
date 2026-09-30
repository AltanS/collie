import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThreadSidebar } from "./agent-sidebar";
import { paneRowKey } from "@/lib/hosts";
import { currentPins, setPinned } from "@/lib/pins";
import { fixtureAgents, fixtureCrewAgents, fixtureServers, fixtureShellPanes } from "@/test/handlers";
import type { AgentView, Launcher } from "@/lib/types";

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
    render(<ThreadSidebar agents={[]} currentPaneKey="" onSelect={vi.fn()} />);
    expect(screen.getByText("No agents running.")).toBeInTheDocument();
  });

  it("groups agents under their workspace, in the dashboard's order", () => {
    render(
      <ThreadSidebar agents={[idleAgent, ...fixtureAgents]} currentPaneKey="" onSelect={vi.fn()} />,
    );
    // One heading per workspace, by workspace number, whatever order the list arrived in. The triage
    // sections (Needs you, Working, Recent) are gone: they moved a row every time its status changed.
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      expect.stringContaining("webapp"),
      expect.stringContaining("collie"),
      expect.stringContaining("sandbox"),
    ]);
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("moves no row and no heading when a pane changes state (ADR 0063)", () => {
    // Before, an unread completion jumped from Recent up into "Ready · unseen" and dropped back once
    // read, and a blocked pane sat in "Needs you" above everything. Now every flip repaints only.
    const finished = { ...idleAgent, lastActiveAt: 200, lastSeenAt: 100 };
    const props = { currentPaneKey: "", onSelect: vi.fn() };
    const order = (c: HTMLElement) => ({
      headings: [...c.querySelectorAll("h3")].map((h) => h.firstChild?.textContent ?? h.textContent),
      rows: [...c.querySelectorAll("button[id^='switch-row-']")].map((b) => b.id),
    });
    const { container, rerender } = render(<ThreadSidebar {...props} agents={[...fixtureAgents, finished]} />);
    const before = order(container);
    expect(before.rows).toHaveLength(3);

    rerender(<ThreadSidebar {...props} agents={[...fixtureAgents, { ...finished, lastSeenAt: 300 }]} />);
    expect(order(container)).toEqual(before);

    const flipped = fixtureAgents.map((a) => ({ ...a, status: a.status === "blocked" ? ("working" as const) : ("blocked" as const) }));
    rerender(<ThreadSidebar {...props} agents={[...flipped, { ...finished, status: "blocked" as const }]} />);
    expect(order(container)).toEqual(before);
  });

  it("says nothing needs you, in the same slot, when no pane does", () => {
    render(<ThreadSidebar agents={[fixtureAgents[1]!, idleAgent]} currentPaneKey="" onSelect={vi.fn()} />);
    const line = screen.getByRole("button", { name: /nothing needs you/i });
    expect(line).toBeDisabled();
  });

  it("counts what needs you on one line and jumps to the first of it", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // The blocked pane sits in the LAST workspace, so the jump has to find it in display order.
    const blockedLast = { ...idleAgent, status: "blocked" as const };
    render(
      <ThreadSidebar agents={[{ ...fixtureAgents[0]!, status: "idle" }, blockedLast]} currentPaneKey="" onSelect={vi.fn()} />,
    );
    const line = screen.getByRole("button", { name: /1 needs you/i });
    await user.click(line);
    const target = screen.getByRole("button", { name: /sandbox/ });
    expect(target).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("lights the heading of a workspace that needs you, and only that one", () => {
    const { container } = render(
      <ThreadSidebar agents={[...fixtureAgents, idleAgent]} currentPaneKey="" onSelect={vi.fn()} />,
    );
    const lit = [...container.querySelectorAll("h3")].filter((h) => h.querySelector(".bg-status-blocked"));
    expect(lit.map((h) => h.textContent)).toEqual([expect.stringContaining("webapp")]);
  });

  it("keys a row by its full address, so two machines' `w1:p1` are two rows", () => {
    const lead = { ...fixtureAgents[0]!, host: "desk" };
    const peer = { ...fixtureAgents[0]!, host: "laptop" };
    const { container } = render(<ThreadSidebar agents={[lead, peer]} currentPaneKey="" onSelect={vi.fn()} />);
    const ids = [...container.querySelectorAll("button[id^='switch-row-']")].map((b) => b.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("runs machines in the servers list's order, the lead first", () => {
    const servers = [
      { id: "desk", name: "desk", isLead: true, reachable: true, protocol: "ok" as const, lastSeenAt: 0 },
      { id: "alpha", name: "alpha", isLead: false, reachable: true, protocol: "ok" as const, lastSeenAt: 0 },
    ];
    // The peer's pane arrives first and is blocked, which used to put its whole block on top.
    const peer = { ...fixtureAgents[0]!, host: "alpha", workspaceLabel: "peerproj" };
    const lead = { ...fixtureAgents[1]!, host: "desk", status: "idle" as const, workspaceNumber: 1 };
    render(<ThreadSidebar agents={[peer, lead]} servers={servers} currentPaneKey="" onSelect={vi.fn()} />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      expect.stringContaining("collie"),
      expect.stringContaining("peerproj"),
    ]);
  });

  it("marks the current pane with aria-current='page'", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneKey={paneRowKey(fixtureAgents[1]!)}
        onSelect={vi.fn()}
      />,
    );
    const current = screen.getByRole("button", { current: "page" });
    // w2:p1 lives in the "collie" workspace and has no name of its own, so line 1 is its agent word
    // and line 2 is its place. Same way round as every other list in the app (lib/pane-name.ts).
    expect(current).toHaveTextContent("collie");
    expect(current).toHaveTextContent("codex");
  });

  it("does not mark any pane current when the key matches nothing", () => {
    render(<ThreadSidebar agents={fixtureAgents} currentPaneKey="nope" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { current: "page" })).toBeNull();
  });

  it("keeps only the CURRENT HOST's row current, when two machines share a paneId", () => {
    // fixtureCrewAgents holds bluefin's own w1:p1 and workshop's w1:p1 — an id collision, on
    // purpose (test/handlers.ts). Comparing `paneId` alone would mark BOTH as current.
    render(
      <ThreadSidebar
        agents={fixtureCrewAgents}
        servers={fixtureServers}
        currentPaneKey={paneRowKey(fixtureCrewAgents[0]!)}
        onSelect={vi.fn()}
      />,
    );
    const current = screen.getAllByRole("button", { current: "page" });
    expect(current).toHaveLength(1);
    // bluefin's own w1:p1 sits in "webapp"; workshop's identically-numbered pane sits in
    // "moonward" and must stay unmarked.
    expect(current[0]).toHaveTextContent("claude");
    expect(screen.getByRole("heading", { name: /moonward/ }).closest("section")).not.toContainElement(
      current[0]!,
    );
  });

  it("fires onSelect with the tapped HOST's own pane, not the id alone, when a paneId is shared", async () => {
    // The unforgivable failure this exists to catch: tapping workshop's row must hand back
    // workshop's pane, never bluefin's identically-numbered one (home.tsx's dashboard `open`
    // guards the same failure the same way).
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ThreadSidebar
        agents={fixtureCrewAgents}
        servers={fixtureServers}
        currentPaneKey={paneRowKey(fixtureCrewAgents[0]!)}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /moonward/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(fixtureCrewAgents[2]);
  });

  it("fires onSelect with the pane when a thread is tapped", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneKey={paneRowKey(fixtureAgents[1]!)}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /webapp/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(fixtureAgents[0]);
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
        currentPaneKey=""
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("Shells")).toBeInTheDocument();
    // The shell row is titled by its space like every other row; the terminal glyph is what marks
    // it as a shell. It's the only pane in "sandbox" here, so the name is unambiguous.
    await user.click(screen.getByRole("button", { name: /sandbox/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(shellPane);
  });

  it("still renders shells when there are no agents (fresh space reachable)", () => {
    render(<ThreadSidebar agents={[]} shellPanes={[shellPane]} currentPaneKey="" onSelect={vi.fn()} />);
    expect(screen.queryByText("No agents running.")).toBeNull();
    expect(screen.getByText("Shells")).toBeInTheDocument();
  });

  it("is switch-only — no close control on any row", () => {
    render(<ThreadSidebar agents={[fixtureAgents[0]!]} currentPaneKey="" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("keeps the status palette on its marks: the lit heading, the counts, the Shells bullet", () => {
    const { container } = render(
      <ThreadSidebar
        agents={[...fixtureAgents, idleAgent]}
        shellPanes={[shellPane]}
        currentPaneKey=""
        onSelect={vi.fn()}
      />,
    );
    // The same status palette the badges use: the needs-you heading dot, the working count's dot, and
    // the Shells section's bullet.
    for (const cls of ["bg-status-blocked", "bg-status-working", "bg-status-unknown"]) {
      expect(container.getElementsByClassName(cls).length).toBeGreaterThan(0);
    }
  });
});

// The cache reading trails the pane's name in the switcher, same as it does on the dashboard row —
// but on its own, with no host chip and no session chip beside it (the row already says the pane's
// place on line 2).
describe("ThreadSidebar — the cache reading on each row", () => {
  const warmAgent: AgentView = {
    ...fixtureAgents[1]!,
    cache: {
      state: "warm",
      expiresAt: Date.now() + 12 * 60_000,
      ttlSeconds: 3600,
      ruleId: "claude.subscription",
      confidence: "documented",
    },
  };

  it("shows the cache chip's remaining time on a pane with a warm cache", () => {
    render(<ThreadSidebar agents={[warmAgent]} currentPaneKey="" onSelect={vi.fn()} />);
    expect(document.querySelector('[data-slot="cache-chip"]')).toHaveTextContent("12m");
  });

  it("shows no chip on a pane with no cache reading", () => {
    render(<ThreadSidebar agents={fixtureAgents} currentPaneKey="" onSelect={vi.fn()} />);
    expect(document.querySelector('[data-slot="cache-chip"]')).toBeNull();
  });

  it("never nests a button inside the row's own button", () => {
    const { container } = render(
      <ThreadSidebar agents={[warmAgent]} currentPaneKey="" onSelect={vi.fn()} />,
    );
    for (const row of container.querySelectorAll("button")) {
      expect(row.querySelector("button")).toBeNull();
    }
  });
});

// The "Switch pane" sheet sees the WHOLE herd, so the long tail of bare shells would bury the
// handful of agents you opened it to reach. That tail folds; a workspace group does not.
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
        currentPaneKey=""
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
    expect(screen.getByRole("heading", { name: /webapp/ })).toBeInTheDocument();
  });

  it("shows the shells again when expanded", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneKey=""
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
        currentPaneKey=""
        onSelect={vi.fn()}
        shellsOpen
        onShellsOpenChange={onShellsOpenChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /shells/i }));
    expect(onShellsOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("never offers a fold on a workspace group", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneKey=""
        onSelect={vi.fn()}
        shellsOpen
        onShellsOpenChange={vi.fn()}
      />,
    );
    // A workspace's handful of rows is not a tail to fold away; only Shells is expandable here.
    const expandable = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent);
    expect(expandable).toHaveLength(1);
    expect(expandable[0]).toMatch(/shells/i);
  });

  it("stays un-foldable when the parent wires nothing, as before", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        shellPanes={manyShells}
        currentPaneKey=""
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("scratch0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
  });
});

// The switcher's own Launch section: the launcher's other home now that the pane header's rocket
// is gone. Same rows the deleted LaunchSheet drew; see agent-chat.test.tsx for how it's wired in.
describe("ThreadSidebar: Launch section", () => {
  const peek: Launcher = { command: "rumen-peek", label: "Runs & quota", cwd: "/home" };
  const quota: Launcher = { command: "showy-quota-peek", label: "Quota bars", cwd: "/home" };

  it("renders a row per launcher and fires onLaunch with the command when tapped", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneKey=""
        onSelect={vi.fn()}
        launchers={[peek, quota]}
        onLaunch={onLaunch}
      />,
    );
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("Runs & quota")).toBeInTheDocument();
    expect(screen.getByText("rumen-peek")).toBeInTheDocument();

    await user.click(screen.getByText("Quota bars"));
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith("showy-quota-peek");
  });

  it("hides the section entirely when onLaunch is not given, even with launchers declared", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneKey=""
        onSelect={vi.fn()}
        launchers={[peek]}
      />,
    );
    expect(screen.queryByText("Launch")).not.toBeInTheDocument();
    expect(screen.queryByText("rumen-peek")).not.toBeInTheDocument();
  });

  it("hides the section when no launchers are declared, even with onLaunch given", () => {
    render(
      <ThreadSidebar agents={fixtureAgents} currentPaneKey="" onSelect={vi.fn()} onLaunch={vi.fn()} />,
    );
    expect(screen.queryByText("Launch")).not.toBeInTheDocument();
  });

  it("disables the row that is in flight and leaves the others tappable", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneKey=""
        onSelect={vi.fn()}
        launchers={[peek, quota]}
        onLaunch={onLaunch}
        launching={new Set(["rumen-peek"])}
      />,
    );
    const busyRow = screen.getByText("Runs & quota").closest("button");
    expect(busyRow).toBeDisabled();

    await user.click(screen.getByText("Quota bars"));
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith("showy-quota-peek");
  });

  it("shows the Launch section together with the empty-panes text when there are no panes", () => {
    render(
      <ThreadSidebar
        agents={[]}
        currentPaneKey=""
        onSelect={vi.fn()}
        launchers={[peek]}
        onLaunch={vi.fn()}
      />,
    );
    expect(screen.getByText("No agents running.")).toBeInTheDocument();
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("rumen-peek")).toBeInTheDocument();
  });

  it("a pinned row's folder is shortened under home; an absent cwd reads \"here\"", () => {
    const top: Launcher = { command: "htop", label: "Top" };
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneKey=""
        onSelect={vi.fn()}
        launchers={[peek, top]}
        launchersHome="/home"
        onLaunch={vi.fn()}
      />,
    );
    // peek's cwd IS home, so it collapses to a bare "~" rather than the full path.
    expect(screen.getByText("~")).toBeInTheDocument();
    // top declares no cwd — beside this pane, wherever it is.
    expect(screen.getByText("here")).toBeInTheDocument();
  });

  it("a host that refuses writes disables every row and names the reason", () => {
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneKey=""
        onSelect={vi.fn()}
        launchers={[peek, quota]}
        onLaunch={vi.fn()}
        launchRefusal="laptop hasn't answered in a while"
      />,
    );
    const row = screen.getByText("Runs & quota").closest("button");
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute("title", "laptop hasn't answered in a while");
  });
});

// PINNED LEADS THE SWITCHER (ADR 0070): a Pinned section under the summary line, in the dashboard's
// place order, and each pinned pane leaves its workspace section or Shells, so it is listed once.
describe("ThreadSidebar — pinned panes", () => {
  const shell: AgentView = {
    paneId: "w2:p9",
    workspaceId: "w2",
    workspaceLabel: "collie",
    workspaceNumber: 2,
    tabId: "w2:t1",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/collie",
    focused: false,
    kind: "shell",
  };
  const agents = [...fixtureAgents, idleAgent];
  const herd = [...agents, shell];
  const pin = (...panes: AgentView[]) => {
    let now = 0;
    for (const p of panes) setPinned(p, true, herd, ++now);
    return currentPins();
  };
  const region = () => screen.getByRole("region", { name: "Pinned" });
  const rowIds = (c: HTMLElement) => [...c.querySelectorAll("button")].map((b) => b.textContent);

  it("renders as before with nothing pinned", () => {
    const { container, rerender } = render(
      <ThreadSidebar agents={agents} shellPanes={[shell]} currentPaneKey="" onSelect={vi.fn()} />,
    );
    const before = container.innerHTML;
    rerender(<ThreadSidebar agents={agents} shellPanes={[shell]} currentPaneKey="" onSelect={vi.fn()} pins={[]} />);
    expect(container.innerHTML).toBe(before);
    expect(screen.queryByRole("heading", { name: "Pinned" })).toBeNull();
  });

  it("leads with a Pinned section, under the summary line, in place order", () => {
    // Pinned last-first; the section still runs webapp (w1), collie (w2, the agent then its shell),
    // sandbox (w3).
    const pins = pin(idleAgent, shell, fixtureAgents[0]!, fixtureAgents[1]!);
    render(<ThreadSidebar agents={agents} shellPanes={[shell]} currentPaneKey="" onSelect={vi.fn()} pins={pins} />);
    const headingsInOrder = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headingsInOrder[0]).toBe("Pinned");
    const rows = within(region()).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("webapp"),
      expect.stringMatching(/codex.*collie/u),
      expect.stringContaining("shell"),
      expect.stringContaining("sandbox"),
    ]);
    const summary = screen.getByRole("button", { name: /needs you/i });
    expect(summary.compareDocumentPosition(region()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists each pane once: a pinned pane leaves its workspace section, and a pinned shell leaves Shells", () => {
    const pins = pin(fixtureAgents[1]!, shell);
    const { container } = render(
      <ThreadSidebar agents={agents} shellPanes={[shell]} currentPaneKey="" onSelect={vi.fn()} pins={pins} />,
    );
    // collie's one agent is pinned, so its section is gone; Shells had one shell, pinned, so it is gone too.
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.firstChild?.textContent ?? h.textContent)).toEqual([
      "Pinned",
      "webapp",
      "sandbox",
    ]);
    // Every pane of the herd is a row exactly once.
    expect(rowIds(container).filter((t) => t?.includes("codex"))).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(1 + herd.length);
  });

  it("jumps to the first urgent row in display order, which is in Pinned when a pinned pane needs you", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    const blockedLast = { ...idleAgent, status: "blocked" as const };
    const list = [{ ...fixtureAgents[0]!, status: "blocked" as const }, fixtureAgents[1]!, blockedLast];
    let now = 0;
    setPinned(blockedLast, true, list, ++now);
    render(<ThreadSidebar agents={list} currentPaneKey="" onSelect={vi.fn()} pins={currentPins()} />);
    await user.click(screen.getByRole("button", { name: /2 needs you/i }));
    expect(within(region()).getByRole("button")).toHaveFocus();
  });

  it("keeps the current pane marked inside Pinned", () => {
    const pins = pin(fixtureAgents[1]!);
    render(
      <ThreadSidebar agents={agents} currentPaneKey={paneRowKey(fixtureAgents[1]!)} onSelect={vi.fn()} pins={pins} />,
    );
    expect(within(region()).getByRole("button", { current: "page" })).toHaveTextContent("codex");
  });

  it("does not fold the Pinned section", () => {
    const pins = pin(fixtureAgents[1]!);
    render(<ThreadSidebar agents={agents} currentPaneKey="" onSelect={vi.fn()} pins={pins} />);
    const heading = screen.getByRole("heading", { level: 3, name: "Pinned" });
    expect(within(heading).queryByRole("button")).toBeNull();
  });
});

// ── PLACE OR ACTIVITY (ADR 0071) ────────────────────────────────────────────────────────────────
// Place is the default and is the order every other case in this file already pins. What is pinned
// here is the alternative and, above all, its freeze: ADR 0063 allows an order the operator asks for
// ONLY while nothing moves under a thumb, so a poll that changes a clock must change no row.
describe("ThreadSidebar: the order toggle", () => {
  const timed = (pane: AgentView, lastActiveAt: number): AgentView => ({ ...pane, lastActiveAt });
  // webapp oldest, collie newest, sandbox between them — so place order and activity order disagree
  // on every row, and a passing case cannot be one that happens to match the arrival order.
  const herd = [timed(fixtureAgents[0]!, 100), timed(fixtureAgents[1]!, 900), timed(idleAgent, 500)];
  const names = () => [...document.querySelectorAll("button[id^='switch-row-']")].map((b) => b.textContent);
  const headings = () =>
    screen.getAllByRole("heading", { level: 3 }).map((h) => h.firstChild?.textContent ?? h.textContent);

  it("draws no control when the caller cannot store the answer", () => {
    render(<ThreadSidebar agents={herd} currentPaneKey="" onSelect={vi.fn()} />);
    expect(screen.queryByRole("radiogroup", { name: "Pane order" })).toBeNull();
  });

  it("offers Place and Activity, with Place selected by default", () => {
    render(<ThreadSidebar agents={herd} currentPaneKey="" onSelect={vi.fn()} onOrderChange={vi.fn()} />);
    const group = screen.getByRole("radiogroup", { name: "Pane order" });
    expect(within(group).getByRole("radio", { name: "Place" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Activity" })).not.toBeChecked();
  });

  it("reports a tap and changes nothing itself", async () => {
    // The pref lives in the caller (use-dash-prefs), so the toggle asks and does not decide: this
    // sheet and the Settings row write the one stored value.
    const user = userEvent.setup();
    const onOrderChange = vi.fn();
    render(<ThreadSidebar agents={herd} currentPaneKey="" onSelect={vi.fn()} onOrderChange={onOrderChange} />);
    await user.click(screen.getByRole("radio", { name: "Activity" }));
    expect(onOrderChange).toHaveBeenCalledWith("activity");
    expect(headings()).toEqual(["webapp", "collie", "sandbox"]);
  });

  it("keeps the workspace sections in place order", () => {
    render(<ThreadSidebar agents={herd} currentPaneKey="" onSelect={vi.fn()} order="place" onOrderChange={vi.fn()} />);
    expect(headings()).toEqual(["webapp", "collie", "sandbox"]);
  });

  it("folds the sections into one list, newest first, in activity order", () => {
    render(
      <ThreadSidebar
        agents={herd}
        shellPanes={fixtureShellPanes}
        currentPaneKey=""
        onSelect={vi.fn()}
        order="activity"
        onOrderChange={vi.fn()}
      />,
    );
    // ONE heading, and the workspace ones are gone: a workspace heading cannot answer "when did
    // anything last happen here".
    // One heading, carrying the row count the way Shells and Launch carry theirs.
    expect(headings()).toEqual([expect.stringContaining("Newest first")]);
    expect(names()).toEqual([
      expect.stringContaining("codex"),
      expect.stringContaining("sandbox"),
      expect.stringContaining("webapp"),
      // The shell arrives with no clock at all, so it ranks last rather than nowhere.
      expect.stringContaining("collie"),
    ]);
    // The Shells fold goes with the sections, and the tail it protected against is what now sinks.
    expect(screen.queryByRole("heading", { level: 3, name: /Shells/ })).toBeNull();
  });

  it("holds its order while a pane's clock moves under it", () => {
    // THE FREEZE. A poll that reports the oldest pane as the newest must repaint it and move nothing:
    // on this sheet a row that shifts under a moving thumb opens another terminal.
    const props = { currentPaneKey: "", onSelect: vi.fn(), order: "activity" as const, onOrderChange: vi.fn() };
    const { rerender } = render(<ThreadSidebar {...props} agents={herd} />);
    const before = names();
    rerender(<ThreadSidebar {...props} agents={[timed(fixtureAgents[0]!, 9_000), herd[1]!, herd[2]!]} />);
    expect(names()).toEqual(before);
  });

  it("re-reads the clock when the operator taps, and only then", () => {
    const props = { currentPaneKey: "", onSelect: vi.fn(), onOrderChange: vi.fn() };
    const { rerender } = render(<ThreadSidebar {...props} agents={herd} order="place" />);
    rerender(<ThreadSidebar {...props} agents={herd} order="activity" />);
    expect(names()[0]).toContain("codex");
  });

  it("still leads with Pinned in activity order", () => {
    // ADR 0070 outranks the sort: a pin is a place the operator chose, and this sheet is often opened
    // to reach exactly that row.
    let now = 0;
    setPinned(herd[0]!, true, herd, ++now);
    render(
      <ThreadSidebar
        agents={herd}
        currentPaneKey=""
        onSelect={vi.fn()}
        pins={currentPins()}
        order="activity"
        onOrderChange={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["Pinned", expect.stringContaining("Newest first")]);
    // The oldest pane of the three, first on the sheet, because it is pinned.
    expect(names()[0]).toContain("webapp");
  });
});
