import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaneStrip } from "./pane-strip";
import type { AgentView } from "@/lib/types";

function pane(paneId: string, agent: string, kind: "agent" | "shell" = "agent"): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent,
    status: "idle",
    cwd: "/home/proj",
    focused: false,
    kind,
  };
}

describe("PaneStrip", () => {
  it("renders nothing when the tab holds fewer than two panes", () => {
    const { container } = render(
      <PaneStrip panes={[pane("w1:p1", "claude")]} currentPaneId="w1:p1" onSelect={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every pane in the tab and marks the current one", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex"), pane("w1:p3", "shell", "shell")]}
        currentPaneId="w1:p2"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("shell")).toBeInTheDocument(); // shell panes show a "shell" label
    // The current pane (codex / w1:p2) is the one marked active.
    expect(screen.getByRole("button", { name: /codex/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /claude/ })).not.toHaveAttribute("aria-current");
  });

  it("fires onSelect with the pane id when a pane is tapped", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /codex/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2");
  });
});
