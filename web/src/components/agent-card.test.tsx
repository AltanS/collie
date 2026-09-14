import { render, within } from "@testing-library/react";

import { AgentCard } from "./agent-card";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

// The row's ANATOMY, which is the thing that keeps getting re-argued: line 1 is the pane's NAME
// beside a small agent tile, line 2 is its PLACE, `space › tab`. One name, one place, the same way
// round on every surface (lib/pane-name.ts). Addressed through `data-slot` rather than class names:
// the classes are a layout decision and are meant to move; which line a fact lands on is the
// contract.

const agent = (over: Partial<AgentView> = {}): AgentView => ({ ...fixtureAgents[0]!, ...over });

const line1 = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="agent-row-title"]');
const line2 = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="agent-row-detail"]');

describe("AgentCard's two lines", () => {
  it("leads with the pane title and the agent tile, and puts space then tab beneath", () => {
    const { container } = render(
      <AgentCard agent={agent({ tabLabel: "review", sessionName: "rewrite the loader" })} onClick={() => {}} />,
    );

    const top = line1(container)!;
    expect(top).toHaveTextContent("rewrite the loader");
    // The tile is the agent's own mark, inline on line 1 — not a 36px column ahead of the text.
    expect(within(top).getByRole("img", { name: "claude logo" })).toBeInTheDocument();
    // The space and the tab are NOT on line 1; that is the whole change.
    expect(top).not.toHaveTextContent("webapp");
    expect(top).not.toHaveTextContent("review");

    // Space first, then the crumb, then the tab — in that order, in one line.
    expect(line2(container)).toHaveTextContent(/^webapp\s*›\s*review$/);
  });

  it("shows the space alone, with no separator, when there is no tab", () => {
    const { container } = render(
      <AgentCard agent={agent({ tabLabel: undefined, sessionName: "rewrite the loader" })} onClick={() => {}} />,
    );

    expect(line1(container)).toHaveTextContent("rewrite the loader");
    expect(line2(container)).toHaveTextContent("webapp");
    expect(line2(container)).not.toHaveTextContent("›");
  });

  it("NEVER leads with the place: a pane with no name of its own reads as its agent", () => {
    const { container } = render(<AgentCard agent={agent({ tabLabel: "review" })} onClick={() => {}} />);

    // The old rule promoted the tab to line 1 here, so one pane was called "review" on this screen
    // and something else on the next. The agent word is the floor, and the place stays on line 2.
    expect(line1(container)).toHaveTextContent("claude");
    expect(line2(container)).toHaveTextContent(/^webapp\s*›\s*review$/);
  });

  it("still shows the place beneath a pane that has neither a tab nor a name", () => {
    const { container } = render(<AgentCard agent={agent()} onClick={() => {}} />);

    expect(line1(container)).toHaveTextContent("claude");
    expect(line2(container)).toHaveTextContent("webapp");
  });

  // In a list already grouped under its space and tab, repeating them says nothing — so the pane's
  // own name takes line 1 and the path is all that is left for line 2. Same two shapes.
  it("leads with the pane's own name in a tab-scoped list", () => {
    const { container } = render(
      <AgentCard
        agent={agent({ tabLabel: "review", paneLabel: "logs", cwd: "/home/you/webapp/api" })}
        onClick={() => {}}
        scope="tab"
      />,
    );

    const top = line1(container)!;
    expect(top).toHaveTextContent("logs");
    expect(top).not.toHaveTextContent("webapp");
    expect(within(top).getByRole("img", { name: "claude logo" })).toBeInTheDocument();

    expect(line2(container)).toHaveTextContent("webapp/api");
    expect(line2(container)).not.toHaveTextContent("review");
  });
});

// A list already grouped by PLACE (lib/pane-groups.ts) has said the place in its heading, and the
// cwd is the same cwd on every row of one tab — so the row is one line, one stated height, and its
// address and cache reading ride at the end of that line instead of in the trailing column.
describe("AgentCard in a place group", () => {
  const row = (over: Partial<AgentView> = {}) =>
    render(
      <AgentCard
        agent={agent({ tabLabel: "review", paneLabel: "logs", cwd: "/home/you/webapp/api", ...over })}
        onClick={() => {}}
        scope="place"
        statusStyle="dot"
        density="row"
      />,
    );

  it("keeps line 1 and has no line 2 at all", () => {
    const { container } = row();
    expect(line1(container)).toHaveTextContent("logs");
    expect(line2(container)).toBeNull();
    // Not the cwd either: that is the `tab` scope's answer, and it is not this one.
    expect(container.textContent).not.toContain("webapp/api");
  });

  it("states the group's pitch rather than letting the tallest row set it", () => {
    const { container } = row();
    expect(container.querySelector("button")!.firstElementChild!.className).toMatch(/min-h-11/);
  });

  it("withholds the bridge's hint, which is the one fact that would change a row's height", () => {
    const { container } = row({ hint: "waiting on a build" });
    expect(container.textContent).not.toContain("waiting on a build");
  });

  it("takes the meta's inline layout, because the column is 41px and would set the height", () => {
    const { container } = row();
    const meta = container.querySelector<HTMLElement>('[data-slot="pane-meta"]')!;
    expect(meta.dataset.layout).toBe("inline");
  });

  it("leaves every other scope on the column", () => {
    for (const scope of ["herd", "tab"] as const) {
      const { container } = render(
        <AgentCard agent={agent()} onClick={() => {}} scope={scope} />,
      );
      const meta = container.querySelector<HTMLElement>('[data-slot="pane-meta"]')!;
      expect(meta.dataset.layout).toBeUndefined();
    }
  });
});
