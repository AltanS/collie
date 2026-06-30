import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThreadSidebar } from "./agent-sidebar";
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

  it("groups agents into the triage sections it has members for", () => {
    render(
      <ThreadSidebar agents={[...fixtureAgents, idleAgent]} currentPaneId="" onSelect={vi.fn()} />,
    );
    // blocked → Needs you, working → Working, idle → Idle · done
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("Idle · done")).toBeInTheDocument();
  });

  it("omits groups that have no members", () => {
    // Only a blocked agent → no Working / Idle headers.
    render(<ThreadSidebar agents={[fixtureAgents[0]!]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("Idle · done")).toBeNull();
  });

  it("marks the current pane with aria-current='page'", () => {
    render(<ThreadSidebar agents={fixtureAgents} currentPaneId="w2:p1" onSelect={vi.fn()} />);
    const current = screen.getByRole("button", { current: "page" });
    // w2:p1 is the codex agent in the "collie" workspace.
    expect(current).toHaveTextContent("codex");
    expect(current).toHaveTextContent("collie");
  });

  it("does not mark any pane current when the id matches nothing", () => {
    render(<ThreadSidebar agents={fixtureAgents} currentPaneId="nope" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { current: "page" })).toBeNull();
  });

  it("fires onSelect with the pane id when a thread is tapped", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ThreadSidebar agents={fixtureAgents} currentPaneId="w2:p1" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /claude/ }));
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
    await user.click(screen.getByRole("button", { name: /shell/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w3:p2");
  });

  it("still renders shells when there are no agents (fresh space reachable)", () => {
    render(<ThreadSidebar agents={[]} shellPanes={[shellPane]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.queryByText("No agents running.")).toBeNull();
    expect(screen.getByText("Shells")).toBeInTheDocument();
  });

  it("shows no ✕ close control unless onClose is provided", () => {
    render(<ThreadSidebar agents={[fixtureAgents[0]!]} currentPaneId="" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Close / })).toBeNull();
  });

  it("closes a pane only after a two-tap confirm on its ✕", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    // fixtureAgents[0] is the blocked claude agent (paneId w1:p1).
    render(
      <ThreadSidebar agents={[fixtureAgents[0]!]} currentPaneId="" onSelect={vi.fn()} onClose={onClose} />,
    );
    await user.click(screen.getByRole("button", { name: "Close claude" }));
    expect(onClose).not.toHaveBeenCalled(); // first tap only arms the confirm
    await user.click(screen.getByRole("button", { name: "Confirm closing claude" }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith("w1:p1");
  });

  it("disables a row's ✕ while that pane is being closed", () => {
    render(
      <ThreadSidebar
        agents={[fixtureAgents[0]!]}
        currentPaneId=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        closingId="w1:p1"
      />,
    );
    expect(screen.getByRole("button", { name: "Close claude" })).toBeDisabled();
  });
});
