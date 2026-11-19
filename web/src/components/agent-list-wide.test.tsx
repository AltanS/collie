import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentView } from "@/lib/types";
import { AgentList } from "./agent-list";

// THE LIST'S LARGE-SCREEN FORM (ADR 0158): the same filters and rows as the phone's, as a band over a grid.

afterEach(cleanup);

function seat(ws: number, n: number, status: AgentView["status"], hint?: string): AgentView {
  const out: AgentView = {
    paneId: `w${ws}:p${n}`,
    workspaceId: `w${ws}`,
    workspaceLabel: `space-${ws}`,
    workspaceNumber: ws,
    tabId: `w${ws}:t1`,
    agent: n === 1 ? "claude" : "codex",
    status,
    cwd: `/home/you/space-${ws}`,
    focused: false,
    terminalTitle: `job ${ws}.${n}`,
  };
  if (hint !== undefined) out.hint = hint;
  return out;
}

const AGENTS = [seat(1, 1, "working"), seat(2, 1, "blocked", "approve the plan"), seat(3, 1, "idle"), seat(3, 2, "blocked", "pick a branch")];

function draw(props: { wide?: { columns: number }; needsYouOnly?: boolean; agents?: AgentView[] } = {}) {
  const { agents = AGENTS, ...rest } = props;
  return render(
    <MemoryRouter>
      <AgentList agents={agents} bridge="connected" onOpen={() => {}} onNeedsYouOnlyChange={() => {}} onOrderChange={() => {}} {...rest} />
    </MemoryRouter>,
  );
}

const band = () => document.querySelector<HTMLElement>('[data-slot="wide-waiting"]');

describe("AgentList with a grid", () => {
  it("draws every Space in a grid of the given columns and the control block as one row", () => {
    draw({ wide: { columns: 3 } });
    const grid = document.querySelector<HTMLElement>('[data-slot="wide-rows"]')!;
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, 384px)");
    expect(grid.querySelectorAll("[data-space]")).toHaveLength(3);
    // The summary line and the workspace filter share one row.
    const row = screen.getByRole("button", { name: /^Space / }).closest<HTMLElement>(".min-h-11")!;
    expect(within(row).getByRole("button", { name: /needs you/u })).toBeInTheDocument();
  });

  it("repeats each session that needs you in a band, in the list's order, and leaves every row in its Space", () => {
    draw({ wide: { columns: 3 } });
    const cards = within(band()!).getAllByRole("button");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("job 2.1");
    expect(cards[1]).toHaveTextContent("job 3.2");
    // The question is on the card, and the Spaces still hold both rows.
    expect(within(band()!).getByText("approve the plan")).toBeInTheDocument();
    const space3 = document.querySelector<HTMLElement>('[data-space$="w3"]')!;
    expect(within(space3).getAllByRole("button")).toHaveLength(2);
    expect(within(document.querySelector<HTMLElement>('[data-space$="w2"]')!).getByRole("button", { name: /job 2\.1/u })).toBeInTheDocument();
  });

  it("keeps the list in place order: a waiting Space is not moved up", () => {
    draw({ wide: { columns: 3 } });
    const order = [...document.querySelectorAll("[data-space]")].map((el) => el.getAttribute("data-space")!.split("\u0000").pop());
    expect(order).toEqual(["w1", "w2", "w3"]);
  });

  it("has no band with nothing waiting, and none while the needs-you switch already filters the grid", () => {
    draw({ wide: { columns: 3 }, agents: [seat(1, 1, "working"), seat(2, 1, "idle")] });
    expect(band()).toBeNull();
    cleanup();
    draw({ wide: { columns: 3 }, needsYouOnly: true });
    expect(band()).toBeNull();
  });

  it("draws the phone's list, with no grid and no band, when given no `wide`", () => {
    draw();
    expect(document.querySelector('[data-slot="wide-rows"]')).toBeNull();
    expect(band()).toBeNull();
    expect(document.querySelector('[data-slot="wide-dashboard"]')).toBeNull();
  });
});
