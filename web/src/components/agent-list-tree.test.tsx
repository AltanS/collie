import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentList } from "./agent-list";
import type { AgentView, PaneTree } from "@/lib/types";

// THE TREE ORDER on the dashboard (lib/pane-tree.ts): one list under one heading, each child under the
// pane that started it, indented, with its role beside the name; offered only while a pane is in a tree.

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

const headings = () => screen.getAllByRole("heading").map((el) => el.textContent?.toLowerCase() ?? "");
const rowButtons = () => screen.getAllByRole("button").filter((b) => b.closest("section") !== null);
const NAMES = ["plain", "worker-a", "coord", "worker-b", "review"];
const names = () => rowButtons().map((b) => NAMES.find((n) => within(b).queryByText(n) !== null));
const indentOf = (row: HTMLElement) => row.querySelector('[data-slot="tree-indent"]');

describe("AgentList — the tree order", () => {
  // Place order would draw these in workspace order: plain, worker-a, coord, worker-b, review.
  const herd = [
    agent("plain", 1),
    agent("worker-a", 2, { id: "wa", parent: "c1", role: "worker" }),
    agent("coord", 3, { id: "c1", role: "coordinator" }),
    agent("worker-b", 4, { id: "wb", parent: "c1", role: "worker" }),
    agent("review", 5, { parent: "wa", role: "reviewer" }),
  ];
  const props = { onOpen: vi.fn(), onOrderChange: vi.fn() };

  it("draws each child under its starter, the panes in no tree last, under one heading", () => {
    render(<AgentList agents={herd} {...props} order="tree" />);
    expect(headings()).toEqual(["who started whom(5)"]);
    expect(names()).toEqual(["coord", "worker-a", "review", "worker-b", "plain"]);
  });

  it("indents a child and names its role, and leaves a root and a plain pane as they were", () => {
    render(<AgentList agents={herd} {...props} order="tree" />);
    const [coord, workerA, review, , plain] = rowButtons();
    expect(indentOf(coord!)).toBeNull();
    expect(within(coord!).getByText("coordinator")).toBeInTheDocument();
    expect(indentOf(workerA!)).toHaveClass("w-4");
    expect(within(workerA!).getByText("worker")).toBeInTheDocument();
    expect(indentOf(review!)).toHaveClass("w-8");
    expect(indentOf(plain!)).toBeNull();
  });

  it("draws no indent and no role outside the tree order", () => {
    render(<AgentList agents={herd} {...props} order="place" />);
    for (const row of rowButtons()) expect(indentOf(row)).toBeNull();
    expect(screen.queryByText("coordinator")).toBeNull();
  });

  it("offers Tree in the select only while a pane is in a tree", async () => {
    const user = userEvent.setup();
    const onOrderChange = vi.fn();
    const { rerender } = render(<AgentList agents={herd} onOpen={vi.fn()} order="place" onOrderChange={onOrderChange} />);
    const select = screen.getByRole("combobox", { name: "Pane order" });
    await user.selectOptions(select, "tree");
    expect(onOrderChange).toHaveBeenCalledWith("tree");

    const untagged = herd.map((a) => agent(a.paneId, a.workspaceNumber));
    rerender(<AgentList agents={untagged} onOpen={vi.fn()} order="place" onOrderChange={onOrderChange} />);
    expect(within(screen.getByRole("combobox", { name: "Pane order" })).queryByRole("option", { name: "Tree" })).toBeNull();
  });

  it("keeps a chosen Tree in the select after the last tree is gone, drawn as place order", () => {
    const untagged = herd.map((a) => agent(a.paneId, a.workspaceNumber));
    render(<AgentList agents={untagged} {...props} order="tree" />);
    expect(within(screen.getByRole("combobox", { name: "Pane order" })).getByRole("option", { name: "Tree" })).toBeInTheDocument();
    expect(names()).toEqual(["plain", "worker-a", "coord", "worker-b", "review"]);
  });
});
