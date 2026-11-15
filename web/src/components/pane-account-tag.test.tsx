import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThreadSidebar } from "./agent-sidebar";
import type { AgentView } from "@/lib/types";

// The added account's label on a switcher row (M101): a word on the second line, after the place.
// A pane with no account draws the row it always drew.

const base: AgentView = {
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

describe("the switcher row's account tag", () => {
  it("draws the label on the place line for a session with an added account", () => {
    const pane: AgentView = { ...base, account: { id: "acc-work", label: "Work" } };
    render(<ThreadSidebar agents={[pane]} currentPaneKey="" onSelect={vi.fn()} />);
    const row = screen.getByRole("button", { name: /claude/i });
    expect(within(row).getByText("Work")).toHaveAttribute("data-slot", "pane-account");
  });

  it("draws no tag, and the same markup, for a session without one", () => {
    const { container, unmount } = render(<ThreadSidebar agents={[base]} currentPaneKey="" onSelect={vi.fn()} />);
    expect(container.querySelector('[data-slot="pane-account"]')).toBeNull();
    const html = container.innerHTML;
    unmount();
    const again = render(<ThreadSidebar agents={[{ ...base }]} currentPaneKey="" onSelect={vi.fn()} />);
    expect(again.container.innerHTML).toBe(html);
  });

  it("the filter finds a session by its account label", async () => {
    const others: AgentView[] = Array.from({ length: 6 }, (_, i) => ({
      ...base,
      paneId: `w${i + 4}:p1`,
      workspaceId: `w${i + 4}`,
      workspaceNumber: i + 4,
      workspaceLabel: `proj${i}`,
      tabId: `w${i + 4}:t1`,
    }));
    const tagged: AgentView = { ...base, account: { id: "acc-work", label: "Zebra" } };
    render(<ThreadSidebar agents={[tagged, ...others]} currentPaneKey="" onSelect={vi.fn()} />);
    await userEvent.type(within(screen.getByRole("search")).getByRole("textbox"), "zebra");
    const rows = screen.getAllByRole("button", { name: /claude/i });
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Zebra")).toBeInTheDocument();
  });
});
