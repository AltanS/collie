import { render, screen } from "@testing-library/react";

import { countStates, StatusCounts, StatusSummaryLine } from "./status-counts";
import type { AgentStatus, AgentView } from "@/lib/types";

/** A minimal pane. Only the fields `countStates`/`isUnseen` read are ever varied per case. */
function pane(status: AgentStatus, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "p",
    workspaceId: "w0",
    workspaceLabel: "w",
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status,
    cwd: "/home/k/proj",
    focused: false,
    ...over,
  };
}

describe("countStates", () => {
  it("counts a blocked pane under blocked, and nothing else", () => {
    expect(countStates([pane("blocked")])).toEqual({
      blocked: 1,
      unseen: 0,
      working: 0,
      done: 0,
      idle: 0,
    });
  });

  it("counts a settled pane as unseen, over its own done/idle status, when it finished after you last looked", () => {
    const doneUnseen = pane("done", { lastActiveAt: 200, lastSeenAt: 100 });
    const idleUnseen = pane("idle", { lastActiveAt: 200, lastSeenAt: 100 });
    expect(countStates([doneUnseen, idleUnseen])).toEqual({
      blocked: 0,
      unseen: 2,
      working: 0,
      done: 0,
      idle: 0,
    });
  });

  it("counts a settled pane under its own done/idle status once you've seen it", () => {
    const doneSeen = pane("done", { lastActiveAt: 100, lastSeenAt: 200 });
    const idleSeen = pane("idle", { lastActiveAt: 100, lastSeenAt: 200 });
    expect(countStates([doneSeen, idleSeen])).toEqual({
      blocked: 0,
      unseen: 0,
      working: 0,
      done: 1,
      idle: 1,
    });
  });

  it("counts a working pane under working", () => {
    expect(countStates([pane("working")]).working).toBe(1);
  });

  it("skips a shell pane entirely, whatever its status or timestamps", () => {
    const shell = pane("blocked", { kind: "shell" });
    const wouldBeUnseen = pane("done", { kind: "shell", lastActiveAt: 200, lastSeenAt: 100 });
    expect(countStates([shell, wouldBeUnseen])).toEqual({
      blocked: 0,
      unseen: 0,
      working: 0,
      done: 0,
      idle: 0,
    });
  });
});

describe("StatusCounts — numbers only (the default, for a workspace heading)", () => {
  it("renders nothing when nothing is counted", () => {
    const { container } = render(<StatusCounts panes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the bare number, with the word only in the accessible name", () => {
    render(<StatusCounts panes={[pane("blocked")]} />);
    const item = screen.getByLabelText("1 needs you");
    expect(item).toHaveTextContent("1");
    expect(item).not.toHaveTextContent("needs you");
  });

  it("orders the states shown by urgency, and omits every state with a zero count", () => {
    render(
      <StatusCounts
        panes={[
          pane("idle", { lastActiveAt: 1, lastSeenAt: 200 }), // idle, already seen
          pane("blocked"),
          pane("working"),
        ]}
      />,
    );
    const shown = screen.getAllByLabelText(/^\d+ /).map((el) => el.getAttribute("aria-label"));
    expect(shown).toEqual(["1 needs you", "1 working", "1 idle"]);
    expect(screen.queryByLabelText(/unseen|done/)).not.toBeInTheDocument();
  });

  it("counts unseen ahead of done and idle, with the square drawn but decorative", () => {
    render(<StatusCounts panes={[pane("done", { lastActiveAt: 200, lastSeenAt: 100 })]} />);
    expect(screen.getByLabelText("1 unseen")).toBeInTheDocument();
    expect(screen.queryByLabelText("1 done")).not.toBeInTheDocument();
    // The mark's own `role="img"` is not exposed here — the counter's own aria-label already says
    // "1 unseen", so the mark inside it is redundant and stays out of the accessibility tree.
    expect(screen.queryByRole("img", { name: "unseen" })).not.toBeInTheDocument();
  });

  it("keeps done and idle apart once both are seen", () => {
    render(
      <StatusCounts
        panes={[
          pane("done", { lastActiveAt: 1, lastSeenAt: 200 }),
          pane("idle", { lastActiveAt: 1, lastSeenAt: 200 }),
        ]}
      />,
    );
    expect(screen.getByLabelText("1 done")).toBeInTheDocument();
    expect(screen.getByLabelText("1 idle")).toBeInTheDocument();
  });
});

describe("StatusCounts — labelled (the dashboard's one summary line)", () => {
  it("spells the word in visible text, and carries no aria-label of its own", () => {
    render(<StatusCounts panes={[pane("blocked")]} labelled />);
    const item = screen.getByText("1 needs you");
    expect(item).not.toHaveAttribute("aria-label");
  });

  it("spells the first count in words and draws every later one bare, each still named in words", () => {
    render(<StatusCounts panes={[pane("blocked"), pane("working"), pane("working")]} labelled />);
    expect(screen.getByText("1 needs you")).toBeInTheDocument();
    expect(screen.queryByText("2 working")).not.toBeInTheDocument();
    const later = screen.getByLabelText("2 working");
    expect(later).toHaveTextContent("2");
    expect(later).not.toHaveTextContent("working");
  });

  it("keeps the unseen mark decorative here too — the spelled word carries the meaning", () => {
    render(<StatusCounts panes={[pane("idle", { lastActiveAt: 200, lastSeenAt: 100 })]} labelled />);
    expect(screen.getByText("1 unseen")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "unseen" })).not.toBeInTheDocument();
  });
});

// THE SLOT IS NARROW (2026-10-06): the controls beside the summary are 188px and `shrink-0`, which
// leaves 92px of line at 320 wide. jsdom has no layout, so the guard is the classes that make the
// browser keep ONE row: no wrap, clipped, every count `shrink-0`, the first count in words only
// while the row holds two counts or fewer.
describe("StatusCounts — the summary is one row, always", () => {
  const three = [pane("blocked"), pane("working"), pane("done", { lastActiveAt: 1, lastSeenAt: 200 })];

  it("is one nowrap row that clips, and may shrink inside its button", () => {
    render(<StatusCounts panes={three} labelled />);
    const row = screen.getByLabelText("1 needs you").closest("span.tabular-nums")!;
    expect(row).toHaveClass("flex-nowrap", "overflow-hidden", "min-w-0");
    expect(row).not.toHaveClass("flex-wrap");
  });

  it("keeps every count in one piece, so a number never cuts mid-digit", () => {
    render(<StatusCounts panes={three} labelled />);
    for (const piece of [screen.getByLabelText("1 needs you"), screen.getByLabelText("1 working"), screen.getByLabelText("1 done")]) {
      expect(piece).toHaveClass("shrink-0", "whitespace-nowrap");
    }
  });

  it("puts the word on the first count only while the row holds two counts or fewer", () => {
    render(<StatusCounts panes={[pane("blocked"), pane("working")]} labelled />);
    expect(screen.getByText("1 needs you")).toBeInTheDocument();
    expect(screen.getByLabelText("1 working")).not.toHaveTextContent("working");
  });

  it("draws every count bare once the row holds three, each still named in words", () => {
    render(<StatusCounts panes={three} labelled />);
    expect(screen.queryByText("1 needs you")).not.toBeInTheDocument();
    for (const name of ["1 needs you", "1 working", "1 done"]) {
      const piece = screen.getByLabelText(name);
      expect(piece).toHaveTextContent(/^1$/);
    }
  });

  it("leaves the summary button reading every count in words", () => {
    render(<StatusSummaryLine panes={three} allClear={false} onJump={() => {}} />);
    expect(screen.getByRole("button")).toHaveClass("min-w-0", "max-w-full");
    expect(screen.getByRole("button", { name: /^1 needs you\s*1 working\s*1 done$/ })).toBeInTheDocument();
  });

  it("truncates the all-clear words too", () => {
    render(<StatusSummaryLine panes={[pane("working")]} allClear />);
    expect(screen.getByText("Nothing needs you")).toHaveClass("min-w-0", "truncate");
  });
});
