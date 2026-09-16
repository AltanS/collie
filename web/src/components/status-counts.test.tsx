import { render, screen } from "@testing-library/react";

import { countStates, StatusCounts } from "./status-counts";
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

  it("spells every non-zero state, each on its own", () => {
    render(<StatusCounts panes={[pane("blocked"), pane("working"), pane("working")]} labelled />);
    expect(screen.getByText("1 needs you")).toBeInTheDocument();
    expect(screen.getByText("2 working")).toBeInTheDocument();
  });

  it("keeps the unseen mark decorative here too — the spelled word carries the meaning", () => {
    render(<StatusCounts panes={[pane("idle", { lastActiveAt: 200, lastSeenAt: 100 })]} labelled />);
    expect(screen.getByText("1 unseen")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "unseen" })).not.toBeInTheDocument();
  });
});
