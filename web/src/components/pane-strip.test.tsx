import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaneStrip } from "./pane-strip";
import type { AgentView } from "@/lib/types";

function pane(
  paneId: string,
  agent: string,
  kind: "agent" | "shell" = "agent",
  extra: Partial<AgentView> = {},
): AgentView {
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
    ...extra,
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

  it("shows Claude's /rename session name on a pill when no user label is set", () => {
    render(
      <PaneStrip
        panes={[
          pane("w1:p1", "claude", "agent", { sessionName: "auth-refactor" }),
          // A user label still wins over the session name.
          pane("w1:p2", "claude", "agent", { sessionName: "ignored", paneLabel: "deploy" }),
        ]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).toBeNull();
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

  // A long-press on a pill reaches the DOM as a `contextmenu` event (Android Chrome / right-click);
  // with the write actions wired it opens the actions sheet. This is the path the on-device bug broke.
  it("opens the actions sheet on a long-press (contextmenu) when actions are wired", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: /codex/ }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("stays inert on contextmenu when the write actions are not wired", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: /codex/ }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  // Tapping the already-active pill used to be a dead re-navigate (onSelect with the same id it's
  // already on). With actions wired, that tap now opens the same sheet a long-press would — so the
  // pill is never a dead tap.
  it("opens the actions sheet on a plain tap of the ACTIVE pill when actions are wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /claude/ }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still navigates on a tap of an INACTIVE pill even when actions are wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /codex/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2");
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("a tap of the ACTIVE pill still just re-selects (no-op) when actions are NOT wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /claude/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p1");
  });
});
