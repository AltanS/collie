import { act, render, screen } from "@testing-library/react";

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

  it("spells every count in words while the line has room", () => {
    render(<StatusCounts panes={[pane("blocked"), pane("working"), pane("working")]} labelled />);
    expect(screen.getByText("1 needs you")).toBeInTheDocument();
    expect(screen.getByText("2 working")).toBeInTheDocument();
  });

  it("keeps the unseen mark decorative here too — the spelled word carries the meaning", () => {
    render(<StatusCounts panes={[pane("idle", { lastActiveAt: 200, lastSeenAt: 100 })]} labelled />);
    expect(screen.getByText("1 unseen")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "unseen" })).not.toBeInTheDocument();
  });

  it("omits a state with a zero count", () => {
    render(<StatusCounts panes={[pane("blocked"), pane("idle", { lastActiveAt: 1, lastSeenAt: 200 })]} labelled />);
    expect(screen.getAllByText(/\d+ /).map((el) => el.textContent)).toEqual(["1 needs you", "1 idle"]);
  });
});

// THE SUMMARY IS ONE LINE AT EVERY WIDTH (2026-10-07). jsdom has no layout, so the test gives the row
// one: every visible count is 18px of mark plus 7px a character, 8px apart, and the row's slot is a
// number the test chooses. What is asserted is the RULE, which rung the line stops on for a slot:
// every word, then the lowest-priority words go one by one, then all of them, then whole counts.
describe("StatusCounts — the summary stays one line (the degrade rule)", () => {
  // Four counts: needs you, unseen, working, idle. Widths per rung, words spelled for the first
  // N counts: 4 = 334px, 3 = 299, 2 = 243, 1 = 194, 0 = 124 (four bare counts).
  const four = [
    pane("blocked"),
    pane("done", { lastActiveAt: 200, lastSeenAt: 100 }),
    ...Array.from({ length: 7 }, () => pane("working")),
    pane("idle", { lastActiveAt: 1, lastSeenAt: 200 }),
    pane("idle", { lastActiveAt: 1, lastSeenAt: 200 }),
  ];
  let slot = 0;
  let observed: (() => void) | null = null;

  const isRow = (el: Element) => el.matches("span.tabular-nums.flex-1");
  beforeEach(() => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return isRow(this) ? slot : 0;
    });
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
      if (!isRow(this)) return 0;
      const shown = Array.from(this.children).filter((c) => !c.classList.contains("sr-only"));
      return shown.reduce((sum, c, i) => sum + 18 + 7 * (c.textContent?.length ?? 0) + (i === 0 ? 0 : 8), 0);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    observed = null;
  });

  /** What the row shows: each visible count's text, a word-less one as its bare number. */
  const visible = () =>
    Array.from(document.querySelectorAll("span.tabular-nums.flex-1 > span"))
      .filter((c) => !c.classList.contains("sr-only"))
      .map((c) => c.textContent);

  it("spells every word when the slot holds them", () => {
    slot = 340;
    render(<StatusCounts panes={four} labelled />);
    expect(visible()).toEqual(["1 needs you", "1 unseen", "7 working", "2 idle"]);
  });

  it("drops the lowest-priority word first: idle, then working, then unseen, and last needs you", () => {
    const rungs: [number, string[]][] = [
      [310, ["1 needs you", "1 unseen", "7 working", "2"]],
      [260, ["1 needs you", "1 unseen", "7", "2"]],
      [200, ["1 needs you", "1", "7", "2"]],
      [130, ["1", "1", "7", "2"]],
    ];
    for (const [width, shown] of rungs) {
      slot = width;
      const { unmount } = render(<StatusCounts panes={four} labelled />);
      expect(visible(), `slot ${width}`).toEqual(shown);
      unmount();
    }
  });

  it("then drops whole counts from the right, never a piece of one, and keeps them for a screen reader", () => {
    slot = 80;
    render(<StatusCounts panes={four} labelled />);
    expect(visible()).toEqual(["1", "1"]);
    const row = document.querySelector("span.tabular-nums.flex-1")!;
    expect(row).toHaveClass("flex-nowrap", "overflow-hidden", "min-w-0");
    // Off the row, still named in words.
    expect(row.querySelectorAll(".sr-only")).toHaveLength(2);
    expect(screen.getByLabelText("7 working")).toHaveClass("sr-only");
    expect(screen.getByLabelText("2 idle")).toHaveClass("sr-only");
  });

  it("names every bare count in words, so the button reads the same at every rung", () => {
    for (const width of [340, 200, 130, 80]) {
      slot = width;
      const { unmount } = render(<StatusSummaryLine panes={four} allClear={false} onJump={() => {}} />);
      expect(screen.getByRole("button", { name: /^1 needs you\s*1 unseen\s*7 working\s*2 idle$/ }), `slot ${width}`).toBeInTheDocument();
      unmount();
    }
  });

  it("gives the words back when the slot grows again", () => {
    slot = 130;
    render(<StatusCounts panes={four} labelled />);
    expect(visible()).toEqual(["1", "1", "7", "2"]);
    slot = 340;
    act(() => observed?.());
    expect(visible()).toEqual(["1 needs you", "1 unseen", "7 working", "2 idle"]);
  });

  it("is one nowrap row that clips and fills its button, and wraps nothing", () => {
    slot = 340;
    render(<StatusCounts panes={four} labelled />);
    const row = document.querySelector("span.tabular-nums.flex-1")!;
    expect(row).toHaveClass("flex-nowrap", "overflow-hidden", "min-w-0", "flex-1");
    expect(row).not.toHaveClass("flex-wrap");
    for (const piece of Array.from(row.children)) expect(piece).toHaveClass("shrink-0", "whitespace-nowrap");
  });

  it("measures two-digit counts in every state like any other width: five counts, one line", () => {
    const crowded = [
      ...Array.from({ length: 12 }, () => pane("blocked")),
      ...Array.from({ length: 11 }, () => pane("done", { lastActiveAt: 200, lastSeenAt: 100 })),
      ...Array.from({ length: 14 }, () => pane("working")),
      ...Array.from({ length: 10 }, () => pane("done", { lastActiveAt: 1, lastSeenAt: 200 })),
      ...Array.from({ length: 15 }, () => pane("idle", { lastActiveAt: 1, lastSeenAt: 200 })),
    ];
    slot = 284;
    render(<StatusCounts panes={crowded} labelled />);
    // Five counts do not fit with words; bare they do, and every one stays on the row.
    expect(visible()).toEqual(["12 needs you", "11", "14", "10", "15"]);
  });

  it("leaves the summary button reading every count in words", () => {
    slot = 340;
    render(<StatusSummaryLine panes={four} allClear={false} onJump={() => {}} />);
    expect(screen.getByRole("button")).toHaveClass("min-w-0", "max-w-full");
  });

  it("truncates the all-clear words too", () => {
    render(<StatusSummaryLine panes={[pane("working")]} allClear />);
    expect(screen.getByText("Nothing needs you")).toHaveClass("min-w-0", "truncate");
  });
});
