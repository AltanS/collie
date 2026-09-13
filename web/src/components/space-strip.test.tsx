import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SpaceStrip } from "./space-strip";
import type { AgentView, WorkspaceView } from "@/lib/types";

const ws: WorkspaceView = {
  workspaceId: "w1",
  number: 1,
  label: "anchorgenius",
  focused: false,
  activeTabId: "w1:t1",
  tabCount: 1,
  paneCount: 1,
};

function agent(partial: Partial<AgentView> & { paneId: string; status: AgentView["status"] }): AgentView {
  return {
    workspaceId: "w1",
    workspaceLabel: "ws",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    cwd: "/home/you/demo",
    focused: false,
    ...partial,
  };
}

describe("SpaceStrip", () => {
  it("leads with the 'All' chip when not drilled in (no onBack)", () => {
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("carries an accessible name, so the row of chips is not an unnamed run of buttons", () => {
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Spaces" })).toBeInTheDocument();
  });

  it("keeps that name in the drill-in too, so the strip is one height in both states", () => {
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected="w1"
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Spaces" })).toBeInTheDocument();
    expect(screen.getByText("Spaces")).toBeInTheDocument();
  });

  it("shows a Back button (and no 'All' chip) in the drill-in, returning to the dashboard", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected="w1"
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
        onBack={onBack}
      />,
    );
    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("still lets you switch to a sibling space from the drill-in", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected="w2"
        onSelect={onSelect}
        onNewSpace={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "anchorgenius" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1");
  });
});

// ── A blocked agent on one host must not colour another host's identically-numbered chip (#209) ──
describe("SpaceStrip — chip status is host-qualified", () => {
  it("does not paint a peer's own w1 chip with another host's blocked agent", () => {
    const agents: AgentView[] = [
      agent({ paneId: "w1:p1", host: "alpha", status: "blocked" }),
      agent({ paneId: "w1:p2", host: "beta", status: "idle" }),
    ];
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={agents}
        host="beta"
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    // Beta's own w1 is merely idle — the sr-only status word is absent from the chip altogether.
    expect(screen.queryByText(/needs you/i)).not.toBeInTheDocument();
  });

  it("still counts an untagged agent toward any host's chip — the un-widened solo case", () => {
    const agents: AgentView[] = [agent({ paneId: "w1:p9", status: "blocked" })]; // no host at all
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={agents}
        host="beta"
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    expect(screen.getByText(/needs you/i)).toBeInTheDocument();
  });
});
