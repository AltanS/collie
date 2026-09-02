import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentList } from "./agent-list";
import type { AgentStatus, AgentView } from "@/lib/types";

function agent(
  paneId: string,
  status: AgentStatus,
  over: Partial<AgentView> = {},
): AgentView {
  return {
    paneId,
    workspaceId: "w0",
    workspaceLabel: paneId,
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status,
    cwd: "/home/k/proj",
    focused: false,
    ...over,
  };
}

/** Section headings, in the order they render. Queried by role, because "needs you" is also the
 *  blocked STATUS_LABEL on every row's badge — matching on text alone catches both. */
const headings = () =>
  screen.getAllByRole("heading").map((el) => el.textContent?.toLowerCase() ?? "");

describe("AgentList — sections", () => {
  const herd = [
    agent("blocked", "blocked", { lastActiveAt: 500, lastSeenAt: 1 }),
    agent("unseen", "done", { lastActiveAt: 400, lastSeenAt: 1 }),
    agent("busy", "working", { lastActiveAt: 300, lastSeenAt: 1 }),
    agent("old", "idle", { lastActiveAt: 1, lastSeenAt: 200 }),
  ];

  it("renders the four sections in triage order, agents first", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} />);
    expect(headings()).toEqual([
      expect.stringContaining("needs you"),
      expect.stringContaining("ready · unseen"),
      expect.stringContaining("working"),
      expect.stringContaining("recent"),
    ]);
  });

  it("titles rows by project · tab, never by the agent name", () => {
    render(
      <AgentList
        agents={[agent("p", "idle", { workspaceLabel: "moonward_os", tabLabel: "fix-auth" })]}
        onOpen={vi.fn()}
      />,
    );
    // Rendered as separate spans so the tab survives truncation — assert both parts, and that the
    // row is still announced as one name.
    expect(screen.getByText("moonward_os")).toBeInTheDocument();
    expect(screen.getByText("fix-auth")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /moonward_os.*fix-auth/ })).toBeInTheDocument();
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
  });

  it("gives line 1's width to the pane title, and drops the space and tab to line 2", () => {
    render(
      <AgentList
        agents={[
          agent("p", "idle", {
            workspaceLabel: "moonward_os",
            tabLabel: "fix-auth",
            sessionName: "rewrite the loader",
          }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    // The title takes the fill and the weight on line 1 — it is the only fact unique to this row.
    expect(screen.getByText("rewrite the loader").className).toMatch(/flex-1/);
    expect(screen.getByText("rewrite the loader").closest("[data-slot]")).toHaveAttribute(
      "data-slot",
      "agent-row-title",
    );
    // The address — space then tab — sits on the line below.
    for (const part of ["moonward_os", "fix-auth"])
      expect(screen.getByText(part).closest("[data-slot]")).toHaveAttribute(
        "data-slot",
        "agent-row-detail",
      );
  });

  it("omits a section with no members rather than showing an empty heading", () => {
    render(<AgentList agents={[agent("only", "working", { lastActiveAt: 1 })]} onOpen={vi.fn()} />);
    expect(headings()).toEqual([expect.stringContaining("working")]);
  });

  it("says so when nothing needs you, rather than leaving an absence to interpret", () => {
    render(<AgentList agents={[agent("only", "working", { lastActiveAt: 1 })]} onOpen={vi.fn()} />);
    expect(screen.getByText(/nothing needs you/i)).toBeInTheDocument();
  });

  it("stays quiet about it when something DOES need you", () => {
    render(<AgentList agents={[agent("b", "blocked")]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/nothing needs you/i)).not.toBeInTheDocument();
  });

  it("drops the status pill inside triage sections — the heading already says it", () => {
    render(<AgentList agents={[agent("w", "working", { lastActiveAt: 1 })]} onOpen={vi.fn()} />);
    // The word survives for screen readers, but not as a pill on every row.
    const row = screen.getByRole("button", { name: /w/ });
    expect(row.querySelector(".sr-only")?.textContent).toBe("working");
  });

  it("opens the pane behind a tapped row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    // The whole PANE, not just its id: `w1:p1` names a different terminal on every machine in a
    // pack, and this list is one herd across all of them.
    const row = agent("p1", "blocked");
    render(<AgentList agents={[row]} onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: /p1/ }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(row);
  });

  it("shows the herd-empty placeholder, and suppresses it when asked", () => {
    const { rerender } = render(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} />);
    expect(screen.getByText(/no agents running/i)).toBeInTheDocument();
    rerender(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} emptyState={false} />);
    expect(screen.queryByText(/no agents running/i)).not.toBeInTheDocument();
  });

  it("says it's waiting when the bridge is down, rather than 'no agents'", () => {
    render(<AgentList agents={[]} bridge="disconnected" onOpen={vi.fn()} />);
    expect(screen.getByText(/waiting for herdr/i)).toBeInTheDocument();
  });

  // The cold-boot-offline bug: the herd is empty because the fetch failed, not because nothing is
  // running — and a cached snapshot still reports `bridge: "connected"`, so `bridge` alone would let
  // "No agents running." through. Only a real answer may make that claim.
  it("never claims an empty herd on a stale render", () => {
    render(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} error />);
    expect(screen.queryByText(/no agents running/i)).not.toBeInTheDocument();
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
  });

  it("dates the disconnected placeholder when the cache can date it", () => {
    const at = new Date(2026, 0, 2, 14, 32).getTime();
    render(<AgentList agents={[]} onOpen={vi.fn()} error lastSeenAt={at} />);
    expect(screen.getByText(/last seen/i)).toHaveTextContent(/\d{1,2}[:.]\d{2}/);
  });

  it("says only 'Disconnected' when it cannot date the data", () => {
    render(<AgentList agents={[]} onOpen={vi.fn()} error />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });
});

describe("AgentList — the attention sections are pinned", () => {
  it("gives them no fold control at all", () => {
    render(
      <AgentList
        agents={[agent("b", "blocked"), agent("w", "working")]}
        onOpen={vi.fn()}
        recentOpen
        onRecentOpenChange={vi.fn()}
      />,
    );
    // Only Recent may fold — and it isn't rendered here, so nothing is expandable.
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
  });
});

describe("AgentList — Recent folds", () => {
  const herd = [
    agent("b", "blocked"),
    agent("r1", "idle", { lastSeenAt: 900 }),
    agent("r2", "idle", { lastSeenAt: 100 }),
  ];

  it("hides its rows when folded but keeps Needs you visible", () => {
    render(
      <AgentList agents={herd} onOpen={vi.fn()} recentOpen={false} onRecentOpenChange={vi.fn()} />,
    );
    expect(screen.queryByText(/^r1$/)).not.toBeInTheDocument();
    expect(headings()).toEqual([
      expect.stringContaining("needs you"),
      expect.stringContaining("recent"),
    ]);
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("reports the fold to its owner", async () => {
    const user = userEvent.setup();
    const onRecentOpenChange = vi.fn();
    render(
      <AgentList agents={herd} onOpen={vi.fn()} recentOpen onRecentOpenChange={onRecentOpenChange} />,
    );
    await user.click(screen.getByRole("button", { name: /recent/i }));
    expect(onRecentOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("withdraws the sort control while folded — sorting invisible rows does nothing", () => {
    const { rerender } = render(
      <AgentList
        agents={herd}
        onOpen={vi.fn()}
        recentOpen
        onRecentOpenChange={vi.fn()}
        recentDir="newest"
        onRecentDirChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /switch to oldest first/i })).toBeInTheDocument();

    rerender(
      <AgentList
        agents={herd}
        onOpen={vi.fn()}
        recentOpen={false}
        onRecentOpenChange={vi.fn()}
        recentDir="newest"
        onRecentDirChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /switch to oldest first/i })).not.toBeInTheDocument();
  });
});

describe("AgentList — the direction toggle", () => {
  const herd = [
    agent("fresh", "idle", { lastSeenAt: 900 }),
    agent("stale", "idle", { lastSeenAt: 100 }),
  ];

  it("orders Recent newest-first and flips on tap", async () => {
    const user = userEvent.setup();
    const onRecentDirChange = vi.fn();
    render(
      <AgentList
        agents={herd}
        onOpen={vi.fn()}
        recentDir="newest"
        onRecentDirChange={onRecentDirChange}
      />,
    );
    const rows = screen.getAllByRole("button", { name: /fresh|stale/ });
    expect(rows[0]!.textContent).toContain("fresh");

    await user.click(screen.getByRole("button", { name: /switch to oldest first/i }));
    expect(onRecentDirChange).toHaveBeenCalledExactlyOnceWith("oldest");
  });

  it("renders oldest-first when told to", () => {
    render(
      <AgentList agents={herd} onOpen={vi.fn()} recentDir="oldest" onRecentDirChange={vi.fn()} />,
    );
    const rows = screen.getAllByRole("button", { name: /fresh|stale/ });
    expect(rows[0]!.textContent).toContain("stale");
  });

  it("never reorders the pinned sections", () => {
    const attention = [
      agent("new", "blocked", { lastActiveAt: 900 }),
      agent("old", "blocked", { lastActiveAt: 100 }),
    ];
    for (const dir of ["newest", "oldest"] as const) {
      const { unmount } = render(
        <AgentList agents={attention} onOpen={vi.fn()} recentDir={dir} onRecentDirChange={vi.fn()} />,
      );
      const rows = screen.getAllByRole("button", { name: /new|old/ });
      expect(rows[0]!.textContent).toContain("new");
      unmount();
    }
  });

  it("shows no toggle when the parent doesn't wire one", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /switch to/i })).not.toBeInTheDocument();
  });
});

describe("AgentList — timestamps on rows", () => {
  it("dates a Recent row by when you last used it", () => {
    const seen = Date.now() - 5 * 60 * 1000;
    render(<AgentList agents={[agent("p", "idle", { lastSeenAt: seen })]} onOpen={vi.fn()} />);
    expect(screen.getByText("5m")).toBeInTheDocument();
  });

  it("dates a Ready · unseen row by when it FINISHED, not when you last looked", () => {
    const finished = Date.now() - 2 * 60 * 1000;
    render(
      <AgentList
        agents={[agent("p", "done", { lastActiveAt: finished, lastSeenAt: finished - 60_000 })]}
        onOpen={vi.fn()}
      />,
    );
    const section = screen.getByText(/ready · unseen/i).closest("section")!;
    expect(within(section).getByText("2m")).toBeInTheDocument();
  });

  it("puts no age on a blocked row — it's noise beside 'needs you'", () => {
    render(
      <AgentList
        agents={[agent("p", "blocked", { lastActiveAt: Date.now() - 300_000, lastSeenAt: 1 })]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^\d+[mhd]$|^now$/)).not.toBeInTheDocument();
  });
});

describe("AgentList — an older bridge with no timestamps", () => {
  it("still renders a coherent dashboard, with Ready·unseen simply absent", () => {
    render(
      <AgentList
        agents={[agent("b", "blocked"), agent("w", "working"), agent("d", "done")]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual([
      expect.stringContaining("needs you"),
      expect.stringContaining("working"),
      expect.stringContaining("recent"),
    ]);
    expect(screen.queryByText(/ready · unseen/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+[mhd]$|^now$/)).not.toBeInTheDocument();
  });
});

describe("AgentList — the age column", () => {
  it("keeps the age off the end of the name when a row has no tab label", () => {
    // An unlabelled single-tab space returns tab: null. Without a flex filler on line 1 the age
    // butted against the name and read as part of it ("comm_cli 37m").
    render(
      <AgentList
        agents={[
          agent("p", "idle", {
            workspaceLabel: "comm_cli",
            sessionName: "rewrite the loader",
            lastSeenAt: Date.now() - 60_000,
          }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("rewrite the loader").className).toMatch(/flex-1/);
  });

  it("keeps the filler on the title when the row DOES have a tab", () => {
    // Same guard as above. The tab no longer competes for line 1's width at all — it is on line 2 —
    // so the title keeps the filler in both cases and nothing can butt the age.
    render(
      <AgentList
        agents={[
          agent("p", "idle", {
            workspaceLabel: "comm_cli",
            tabLabel: "main",
            sessionName: "rewrite the loader",
            lastSeenAt: 1,
          }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("rewrite the loader").className).toMatch(/flex-1/);
  });
});
