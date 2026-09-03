import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThreadSidebar } from "./agent-sidebar";
import { fixtureAgents } from "@/test/handlers";
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
        currentPaneId=""
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
        currentPaneId=""
        onSelect={vi.fn()}
        launchers={[peek]}
      />,
    );
    expect(screen.queryByText("Launch")).not.toBeInTheDocument();
    expect(screen.queryByText("rumen-peek")).not.toBeInTheDocument();
  });

  it("hides the section when no launchers are declared, even with onLaunch given", () => {
    render(
      <ThreadSidebar agents={fixtureAgents} currentPaneId="" onSelect={vi.fn()} onLaunch={vi.fn()} />,
    );
    expect(screen.queryByText("Launch")).not.toBeInTheDocument();
  });

  it("disables the row that is in flight and leaves the others tappable", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    render(
      <ThreadSidebar
        agents={fixtureAgents}
        currentPaneId=""
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
        currentPaneId=""
        onSelect={vi.fn()}
        launchers={[peek]}
        onLaunch={vi.fn()}
      />,
    );
    expect(screen.getByText("No agents running.")).toBeInTheDocument();
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("rumen-peek")).toBeInTheDocument();
  });
});
