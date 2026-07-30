import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FirstmateOverview } from "./firstmate-overview";
import type { FirstmateStatus, SessionSummary } from "@/lib/types";

const primary: SessionSummary = {
  name: "default",
  isPrimary: true,
  reachable: true,
  agents: 1,
  working: 0,
  blocked: 0,
};
const other: SessionSummary = {
  name: "collie-demo",
  isPrimary: false,
  reachable: true,
  agents: 1,
  working: 0,
  blocked: 0,
};
const sessions: SessionSummary[] = [primary, other];

type ReadyFirstmate = Extract<FirstmateStatus, { state: "ready" | "stale" }>;

function ready(over: Partial<Omit<ReadyFirstmate, "state">> = {}, state: "ready" | "stale" = "ready"): FirstmateStatus {
  return {
    state,
    home: "click-web-terminal",
    generatedAt: new Date().toISOString(),
    decisions: [],
    inFlight: [],
    gates: [],
    landed: [],
    prs: [],
    prState: "ready",
    ...over,
  };
}

const headingTexts = () =>
  screen.getAllByRole("heading").map((el) => el.textContent?.toLowerCase() ?? "");

describe("FirstmateOverview — absence and cold states", () => {
  it("renders nothing when firstmate is absent (feature not configured)", () => {
    const { container } = render(
      <FirstmateOverview firstmate={undefined} sessions={sessions} onOpen={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a compact loading line, no sections", () => {
    render(<FirstmateOverview firstmate={{ state: "loading" }} sessions={sessions} onOpen={vi.fn()} />);
    expect(screen.getByText(/loading firstmate/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
  });

  it("shows a bounded, friendly line for an unavailable feed — never the raw reason", () => {
    render(
      <FirstmateOverview
        firstmate={{ state: "unavailable", reason: "command-failed" }}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(/firstmate couldn.t produce a report/i)).toBeInTheDocument();
    expect(screen.queryByText(/command-failed/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
  });

  it("says so, compactly, when the feed is ready but the fleet is quiet", () => {
    render(<FirstmateOverview firstmate={ready()} sessions={sessions} onOpen={vi.fn()} />);
    expect(screen.getByText("Nothing to report")).toBeInTheDocument();
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
  });
});

describe("FirstmateOverview — populated sections", () => {
  function populated(state: "ready" | "stale" = "ready"): FirstmateStatus {
    return ready(
      {
        decisions: [
          {
            id: "d1",
            summary: "Pick a migration strategy",
            owner: "damian",
            endpoint: { session: "default", paneId: "w1:p1" },
          },
        ],
        inFlight: [{ id: "f1", kind: "ship", state: "running", doing: "Implementing the dashboard" }],
        gates: [
          { id: "g1", title: "CI required checks", blockedBy: "lint", reason: "failing", owner: "ci" },
        ],
        prs: [
          {
            number: "42",
            repo: "click-web-terminal",
            task: "Firstmate dashboard",
            url: "https://github.com/org/repo/pull/42",
            review: "approved",
            mergeable: "clean",
            checks: "passing",
            endpoint: { session: "collie-demo", paneId: "w2:p1" },
          },
        ],
        landed: [{ id: "l1", what: "Shipped the OMP journal", owner: "damian" }],
      },
      state,
    );
  }

  it("renders every section in the contracted order: Needs you, In flight, Gates, PRs, Delivered", () => {
    render(<FirstmateOverview firstmate={populated()} sessions={sessions} onOpen={vi.fn()} />);
    expect(headingTexts()).toEqual(["needs you(1)", "in flight(1)", "gates(1)", "prs(1)", "delivered(1)"]);
  });

  it("omits a section with no members rather than an empty heading", () => {
    const data = populated();
    if (data.state === "ready") data.gates = [];
    render(<FirstmateOverview firstmate={data} sessions={sessions} onOpen={vi.fn()} />);
    expect(headingTexts()).toEqual(["needs you(1)", "in flight(1)", "prs(1)", "delivered(1)"]);
  });

  it("shows every row's content as plain text — the fleet summary, not chrome", () => {
    render(<FirstmateOverview firstmate={populated()} sessions={sessions} onOpen={vi.fn()} />);
    expect(screen.getByText("Pick a migration strategy")).toBeInTheDocument();
    expect(screen.getByText("Implementing the dashboard")).toBeInTheDocument();
    expect(screen.getByText("CI required checks")).toBeInTheDocument();
    expect(screen.getByText("Shipped the OMP journal")).toBeInTheDocument();
  });

  it("navigates a verified endpoint via panePath's session convention (primary → undefined)", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<FirstmateOverview firstmate={populated()} sessions={sessions} onOpen={onOpen} />);
    await user.click(screen.getByText("Pick a migration strategy"));
    expect(onOpen).toHaveBeenCalledWith("w1:p1", undefined);
  });

  it("navigates a non-primary endpoint with its session name", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<FirstmateOverview firstmate={populated()} sessions={sessions} onOpen={onOpen} />);
    await user.click(screen.getByText("Firstmate dashboard"));
    expect(onOpen).toHaveBeenCalledWith("w2:p1", "collie-demo");
  });

  it("leaves an unresolved task visible but unlinked — no button, no click target", () => {
    render(<FirstmateOverview firstmate={populated()} sessions={sessions} onOpen={vi.fn()} />);
    const row = screen.getByText("CI required checks");
    expect(row.closest("button")).toBeNull();
  });

  it("renders the PR's bridge-verified GitHub URL as a real external link", () => {
    render(<FirstmateOverview firstmate={populated()} sessions={sessions} onOpen={vi.fn()} />);
    const link = screen.getByRole("link", { name: /open pr #42 on github/i });
    expect(link).toHaveAttribute("href", "https://github.com/org/repo/pull/42");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("tags a stale feed as stale, visibly, without hiding its data", () => {
    render(<FirstmateOverview firstmate={populated("stale")} sessions={sessions} onOpen={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/stale/i);
    expect(screen.getByText("Pick a migration strategy")).toBeInTheDocument();
  });
});

describe("FirstmateOverview — PR enrichment state (independent of the base feed)", () => {
  it("stays 'Nothing to report' when PR enrichment is disabled and the fleet is otherwise quiet", () => {
    render(
      <FirstmateOverview
        firstmate={ready({ prState: "disabled" })}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("Nothing to report")).toBeInTheDocument();
    expect(screen.queryByText(/prs/i)).not.toBeInTheDocument();
  });

  it("shows PRs as checking, not as a confirmed 'no open PRs', while enrichment is loading", () => {
    render(
      <FirstmateOverview
        firstmate={ready({ prState: "loading" })}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("PRs")).toBeInTheDocument();
    expect(screen.getByText(/checking prs/i)).toBeInTheDocument();
    expect(screen.queryByText(/no open prs/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing to report")).not.toBeInTheDocument();
  });

  it("shows a fixed line, never subprocess detail, while enrichment is unavailable", () => {
    render(
      <FirstmateOverview
        firstmate={ready({ prState: "unavailable" })}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("PRs")).toBeInTheDocument();
    expect(screen.getByText(/couldn.t check prs/i)).toBeInTheDocument();
    expect(screen.queryByText("Nothing to report")).not.toBeInTheDocument();
  });

  it("shows the bridge's PR check summary even when there are currently zero open PRs", () => {
    render(
      <FirstmateOverview
        firstmate={ready({ prState: "ready", prSummary: "checked 1 repo, 0 open" })}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("PRs")).toBeInTheDocument();
    expect(screen.getByText("checked 1 repo, 0 open")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to report")).not.toBeInTheDocument();
  });

  it("tags stale PR enrichment independently of the base feed's own (fresh) state", () => {
    render(
      <FirstmateOverview
        firstmate={ready({
          prState: "stale",
          prs: [
            {
              number: "7",
              repo: "click-web-terminal",
              task: "Fix flaky test",
              url: "https://github.com/org/repo/pull/7",
              review: "pending",
              mergeable: "clean",
              checks: "pending",
            },
          ],
        })}
        sessions={sessions}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("PRs")).toBeInTheDocument();
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getByText("#7 · click-web-terminal")).toBeInTheDocument();
  });
});
