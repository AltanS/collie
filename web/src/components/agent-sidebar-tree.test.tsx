import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThreadSidebar } from "./agent-sidebar";
import { currentPins, setPinned } from "@/lib/pins";
import { __resetTreeFolds } from "@/lib/tree-fold";
import type { AgentView, PaneTree } from "@/lib/types";

// THE TREE ORDER in the switcher and the large screen's sidebar: the same layout as the dashboard's
// (lib/pane-tree.ts), and the Tree segment only while a pane is in a tree.

function agent(paneId: string, workspaceNumber: number, tree?: PaneTree): AgentView {
  const view: AgentView = {
    paneId,
    workspaceId: `w${workspaceNumber}`,
    workspaceLabel: `space ${workspaceNumber}`,
    workspaceNumber,
    tabId: `w${workspaceNumber}:t1`,
    agent: "claude",
    status: "idle",
    cwd: "/home/k/proj",
    focused: false,
    sessionName: paneId,
  };
  if (tree !== undefined) view.tree = tree;
  return view;
}

const herd = [
  agent("alpha", 1),
  agent("bravo", 2, { id: "w1", parent: "c1", role: "worker" }),
  agent("charlie", 3, { id: "c1", role: "coordinator" }),
];
const NAMES = ["alpha", "bravo", "charlie"];
const indentOf = (row: HTMLElement) => row.closest("[data-slot=tree-row]")?.querySelector("[data-slot=tree-indent]") ?? null;
const rows = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("data-pane-key"));
const names = () => rows().map((b) => NAMES.find((n) => within(b).queryByText(n) !== null));

describe("ThreadSidebar — the tree order", () => {
  it("draws each child under its starter, indented, with its role", () => {
    render(<ThreadSidebar agents={herd} currentPaneKey="" onSelect={vi.fn()} order="tree" onOrderChange={vi.fn()} />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([expect.stringContaining("Who started whom")]);
    expect(names()).toEqual(["charlie", "bravo", "alpha"]);
    const [coord, worker] = rows();
    expect(indentOf(coord!)).toBeNull();
    expect(indentOf(worker!)).toHaveClass("w-4");
    expect(within(worker!).getByText("worker", { selector: "[data-slot=pane-badge] span" })).toBeInTheDocument();
  });

  it("offers the Tree segment only while a pane is in a tree", () => {
    const { rerender } = render(
      <ThreadSidebar agents={herd} currentPaneKey="" onSelect={vi.fn()} order="place" onOrderChange={vi.fn()} />,
    );
    expect(screen.getByRole("radio", { name: "Tree" })).toBeInTheDocument();
    const untagged = herd.map((a) => agent(a.paneId, a.workspaceNumber));
    rerender(<ThreadSidebar agents={untagged} currentPaneKey="" onSelect={vi.fn()} order="place" onOrderChange={vi.fn()} />);
    expect(screen.queryByRole("radio", { name: "Tree" })).toBeNull();
  });
});

describe("ThreadSidebar — the tree order keeps pinned panes in the tree", () => {
  afterEach(() => {
    for (const a of herd) setPinned(a, false, herd);
  });

  it("a pinned child stays indented under its starter, and Pinned keeps it too", () => {
    setPinned(herd[1]!, true, herd, 1);
    render(
      <ThreadSidebar agents={herd} currentPaneKey="" onSelect={vi.fn()} order="tree" onOrderChange={vi.fn()} pins={currentPins()} />,
    );
    // Pinned (bravo), then the tree: charlie > bravo, then alpha.
    expect(names()).toEqual(["bravo", "charlie", "bravo", "alpha"]);
    const all = rows();
    expect(indentOf(all[0]!)).toBeNull();
    expect(indentOf(all[2]!)).toHaveClass("w-4");
    expect(all[0]!.id).not.toBe("");
    expect(all[2]!.id).toBe("");
  });
});

describe("ThreadSidebar — folding branches in the tree order", () => {
  afterEach(() => __resetTreeFolds());

  it("folds a branch from its toggle, as the dashboard does", async () => {
    const user = userEvent.setup();
    render(<ThreadSidebar agents={herd} currentPaneKey="" onSelect={vi.fn()} order="tree" onOrderChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Collapse charlie" }));
    expect(names()).toEqual(["charlie", "alpha"]);
    expect(screen.getByRole("button", { name: "Expand charlie" })).toHaveAttribute("aria-expanded", "false");
  });
});
