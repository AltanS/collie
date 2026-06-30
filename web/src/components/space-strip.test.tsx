import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SpaceStrip } from "./space-strip";
import type { WorkspaceView } from "@/lib/types";

const ws: WorkspaceView = {
  workspaceId: "w1",
  number: 1,
  label: "anchorgenius",
  focused: false,
  activeTabId: "w1:t1",
  tabCount: 1,
  paneCount: 1,
};

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
