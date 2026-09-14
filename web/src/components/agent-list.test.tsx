import { render, screen } from "@testing-library/react";
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
/** One named tab of one named space — the group heading most of these cases assert on. */
const UI_WORK = { workspaceLabel: "collie-workspace", tabLabel: "UI work" } as const;

const headings = () =>
  screen.getAllByRole("heading").map((el) => el.textContent?.toLowerCase() ?? "");



describe("AgentList — two axes, urgency then place", () => {
  const herd = [
    agent("blocked", "blocked", { lastActiveAt: 500, lastSeenAt: 1 }),
    agent("unseen", "done", { lastActiveAt: 400, lastSeenAt: 1 }),
    agent("busy", "working", { lastActiveAt: 300, lastSeenAt: 1, ...UI_WORK }),
    agent("old", "idle", { lastActiveAt: 1, lastSeenAt: 200, ...UI_WORK }),
  ];

  it("puts the two attention sections on top, then one heading per place", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} />);
    expect(headings()).toEqual([
      expect.stringContaining("needs you"),
      expect.stringContaining("ready · unseen"),
      "collie-workspace › ui work",
    ]);
  });

  it("has no Working and no Recent heading left to fold or to sort", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: /^working$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^recent$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
  });

  it("keeps the place on line 2 of an urgent row — that group is by urgency, not by place", () => {
    render(
      <AgentList
        agents={[agent("p", "blocked", { workspaceLabel: "moonward_os", tabLabel: "fix-auth" })]}
        onOpen={vi.fn()}
      />,
    );
    // Rendered as separate spans so the tab survives truncation — assert both parts, and that the
    // row is still announced as one name.
    for (const part of ["moonward_os", "fix-auth"])
      expect(screen.getByText(part).closest("[data-slot]")).toHaveAttribute(
        "data-slot",
        "agent-row-detail",
      );
    expect(screen.getByRole("button", { name: /moonward_os.*fix-auth/ })).toBeInTheDocument();
  });

  it("drops line 2 from a place-grouped row — the heading above already says it", () => {
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
    const row = screen.getByRole("button", { name: /rewrite the loader/ });
    expect(row.querySelector('[data-slot="agent-row-detail"]')).toBeNull();
    // The title still takes line 1's fill and weight — it is the only fact unique to this row.
    expect(screen.getByText("rewrite the loader").className).toMatch(/flex-1/);
    expect(screen.getByText("rewrite the loader").closest("[data-slot]")).toHaveAttribute(
      "data-slot",
      "agent-row-title",
    );
  });

  it("states one height for every row of a group, so nothing in it can shift", () => {
    render(
      <AgentList
        agents={[
          agent("a", "idle", { sessionName: "alpha", hint: "a sentence the bridge composed" }),
          agent("b", "idle", { sessionName: "beta" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    for (const name of ["alpha", "beta"]) {
      const row = screen.getByRole("button", { name: new RegExp(name) });
      expect(row.firstElementChild?.className).toMatch(/min-h-11/);
    }
    // The hint is the one fact that would make two rows of a group different heights.
    expect(screen.queryByText(/a sentence the bridge composed/)).not.toBeInTheDocument();
  });

  it("says so when nothing needs you, rather than leaving an absence to interpret", () => {
    render(<AgentList agents={[agent("only", "working", { lastActiveAt: 1 })]} onOpen={vi.fn()} />);
    expect(screen.getByText(/nothing needs you/i)).toBeInTheDocument();
  });

  it("stays quiet about it when something DOES need you", () => {
    render(<AgentList agents={[agent("b", "blocked")]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/nothing needs you/i)).not.toBeInTheDocument();
  });

  it("drops the status pill on every row — the dot and the group say enough", () => {
    render(<AgentList agents={[agent("w", "working", { lastActiveAt: 1 })]} onOpen={vi.fn()} />);
    // The word survives for screen readers, but not as a pill on every row.
    const row = screen.getByRole("button", { name: /w/ });
    expect(row.querySelector(".sr-only")?.textContent).toBe("working");
  });

  it("opens the pane behind a tapped row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    // The whole PANE, not just its id: `w1:p1` names a different terminal on every machine in a
    // crew, and this list is one herd across all of them.
    const row = agent("p1", "blocked");
    render(<AgentList agents={[row]} onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: /p1/ }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(row);
  });
});

describe("AgentList — the place headings", () => {
  it("counts what is inside a group, in words, singular and plural", () => {
    const { rerender } = render(
      <AgentList
        agents={[agent("a", "idle", UI_WORK)]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("1 pane")).toBeInTheDocument();

    rerender(
      <AgentList
        agents={["a", "b", "c"].map((id) => agent(id, "idle", UI_WORK))}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("3 panes")).toBeInTheDocument();
  });

  it("heads an unnamed tab with the space alone — a positional label is not a name", () => {
    render(
      <AgentList
        agents={[agent("a", "idle", { workspaceLabel: "collie-workspace", tabLabel: "2" })]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["collie-workspace"]);
  });

  it("runs the groups by space number, then by the tab order the bridge sent", () => {
    render(
      <AgentList
        agents={[
          agent("c", "idle", {
            workspaceId: "w2",
            workspaceLabel: "two",
            workspaceNumber: 2,
            tabId: "w2:t1",
            tabLabel: "later",
          }),
          agent("b", "idle", {
            workspaceLabel: "one",
            tabId: "w0:t2",
            tabLabel: "second",
          }),
          agent("a", "idle", { workspaceLabel: "one", tabId: "w0:t1", tabLabel: "first" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["one › second", "one › first", "two › later"]);
  });
});

describe("AgentList — shells sit with their tab", () => {
  const shell = (paneId: string, over = {}) =>
    agent(paneId, "unknown", { kind: "shell", agent: "shell", ...over });

  it("puts a shell under its own tab's heading, after that tab's agents", () => {
    render(
      <AgentList
        agents={[agent("work", "idle", { ...UI_WORK, sessionName: "work" })]}
        shellPanes={[shell("logs", { ...UI_WORK, paneLabel: "logs" })]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["collie-workspace › ui work"]);
    expect(screen.getByText("2 panes")).toBeInTheDocument();
    const rows = screen.getAllByRole("button", { name: /work|logs/ });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("work"),
      expect.stringContaining("logs"),
    ]);
  });

  it("opens a group for a tab that holds nothing but shells", () => {
    render(
      <AgentList
        agents={[]}
        shellPanes={[
          shell("sh", { workspaceLabel: "collie-workspace", tabLabel: "logs", paneLabel: "tail -f" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual(["collie-workspace › logs"]);
    expect(screen.queryByText(/no agents running/i)).not.toBeInTheDocument();
  });
});

describe("AgentList — the empty herd", () => {
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

describe("AgentList — an older bridge with no timestamps", () => {
  it("still renders a coherent dashboard, with Ready·unseen simply absent", () => {
    render(
      <AgentList
        agents={[
          agent("b", "blocked"),
          agent("w", "working", { workspaceLabel: "collie-workspace" }),
          agent("d", "done", { workspaceLabel: "collie-workspace" }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(headings()).toEqual([expect.stringContaining("needs you"), "collie-workspace"]);
    expect(screen.queryByText(/ready · unseen/i)).not.toBeInTheDocument();
  });
});
