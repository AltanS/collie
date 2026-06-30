import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SpaceOverview } from "./space-overview";
import type { WorkspaceView } from "@/lib/types";

function ws(workspaceId: string, label: string, tabCount: number, paneCount: number): WorkspaceView {
  return {
    workspaceId,
    number: 1,
    label,
    focused: false,
    activeTabId: `${workspaceId}:t1`,
    tabCount,
    paneCount,
  };
}

describe("SpaceOverview", () => {
  it("shows an empty state when there are no spaces", () => {
    render(<SpaceOverview workspaces={[]} agents={[]} onOpen={vi.fn()} onNewSpace={vi.fn()} />);
    expect(screen.getByText(/no spaces yet/i)).toBeInTheDocument();
  });

  it("renders each space with its tab and pane counts (pluralized)", () => {
    render(
      <SpaceOverview
        workspaces={[ws("w1", "anchorgenius", 2, 3), ws("w2", "tgl", 1, 1)]}
        agents={[]}
        onOpen={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    expect(screen.getByText("anchorgenius")).toBeInTheDocument();
    expect(screen.getByLabelText("2 tabs")).toBeInTheDocument();
    expect(screen.getByLabelText("3 panes")).toBeInTheDocument();
    expect(screen.getByLabelText("1 tab")).toBeInTheDocument(); // singular
    expect(screen.getByLabelText("1 pane")).toBeInTheDocument();
  });

  it("opens a space when its card is tapped", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <SpaceOverview
        workspaces={[ws("w1", "anchorgenius", 2, 3)]}
        agents={[]}
        onOpen={onOpen}
        onNewSpace={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /anchorgenius/ }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("w1");
  });

  it("creates a new space from the header button", async () => {
    const user = userEvent.setup();
    const onNewSpace = vi.fn();
    render(<SpaceOverview workspaces={[]} agents={[]} onOpen={vi.fn()} onNewSpace={onNewSpace} />);
    await user.click(screen.getByRole("button", { name: /new space/i }));
    expect(onNewSpace).toHaveBeenCalledOnce();
  });
});
