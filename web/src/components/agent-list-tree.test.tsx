import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentList } from "./agent-list";
import { currentPins, setPinned } from "@/lib/pins";
import { __resetTreeFolds, currentFolds } from "@/lib/tree-fold";
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
const rowButtons = () =>
  screen.getAllByRole("button").filter((b) => b.closest("section") !== null && b.dataset.slot !== "tree-toggle");
const NAMES = ["plain", "worker-a", "coord", "worker-b", "review"];
const names = () => rowButtons().map((b) => NAMES.find((n) => within(b).queryByText(n) !== null));
const indentOf = (row: HTMLElement) => row.closest("[data-slot=tree-row]")?.querySelector("[data-slot=tree-indent]") ?? null;

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

describe("AgentList — the tree order keeps pinned panes in the tree", () => {
  // The crew case that came back flat: both children of a coordinator pinned, and a worker under one of them.
  const herd = [
    agent("kilo", 1, { id: "c1", role: "coordinator" }),
    agent("lima", 1, { id: "la", parent: "c1", role: "coordinator" }),
    agent("mike", 1, { id: "lb", parent: "c1", role: "worker" }),
    agent("november", 2, { parent: "la", role: "worker" }),
    agent("oscar", 3),
  ];
  const pinned = (...ids: string[]) => {
    let now = 0;
    for (const id of ids) setPinned(herd.find((a) => a.paneId === id)!, true, herd, ++now);
    return currentPins();
  };
  afterEach(() => {
    for (const a of herd) setPinned(a, false, herd);
  });

  it("draws a pinned child in Pinned and again in its place under its starter", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} order="tree" onOrderChange={vi.fn()} pins={pinned("lima", "mike")} />);
    const tree = screen.getByRole("heading", { name: /who started whom/i }).closest("section")!;
    const rows = within(tree).getAllByRole("button").filter((b) => b.closest("section") === tree && b.dataset.slot !== "tree-toggle");
    const order = rows.map((b) => ["kilo", "lima", "mike", "november", "oscar"].find((n) => within(b).queryByText(n) !== null));
    expect(order).toEqual(["kilo", "lima", "november", "mike", "oscar"]);
    expect(indentOf(rows[1]!)).toHaveClass("w-4");
    expect(indentOf(rows[2]!)).toHaveClass("w-8");
    // The Pinned rows are plain rows, never indented, and they keep the DOM ids the jump reads.
    const pinnedRegion = screen.getByRole("region", { name: "Pinned" });
    for (const row of within(pinnedRegion).getAllByRole("button")) {
      expect(indentOf(row)).toBeNull();
    }
    // One element per id: the copy in the tree carries none.
    const ids = [...document.querySelectorAll("[id^=pane-row-]")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("AgentList — folding branches in the tree order", () => {
  const herd = [
    agent("papa", 1, { id: "c1", role: "coordinator" }),
    agent("quebec", 1, { id: "q1", parent: "c1", role: "coordinator" }),
    agent("romeo", 2, { parent: "q1", role: "worker" }),
    agent("sierra", 3, { parent: "c1", role: "worker" }),
    agent("tango", 4),
  ];
  herd[2]!.status = "blocked";
  const NAMES2 = ["papa", "quebec", "romeo", "sierra", "tango"];
  const shown = () =>
    rowButtons().map((b) => NAMES2.find((n) => within(b).queryByText(n, { selector: "[data-slot=crossfade-in], span" }) !== null));
  const toggle = (name: string) => screen.getByRole("button", { name: new RegExp(`^(Collapse|Expand) ${name}$`) });
  afterEach(() => __resetTreeFolds());

  it("puts a toggle on each row that starts a branch, and on no other row", () => {
    render(<AgentList agents={herd} onOpen={vi.fn()} order="tree" onOrderChange={vi.fn()} />);
    expect(screen.getAllByRole("button").filter((b) => b.dataset.slot === "tree-toggle").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Collapse papa",
      "Collapse quebec",
    ]);
    expect(toggle("papa")).toHaveAttribute("aria-expanded", "true");
  });

  it("folds a branch to its starter, which then counts what waits inside and what it hides", async () => {
    const user = userEvent.setup();
    render(<AgentList agents={herd} onOpen={vi.fn()} order="tree" onOrderChange={vi.fn()} />);
    await user.click(toggle("papa"));
    expect(shown()).toEqual(["papa", "tango"]);
    expect(toggle("papa")).toHaveAttribute("aria-expanded", "false");
    const summary = document.querySelector("[data-slot=fold-summary]")!;
    expect(summary).toHaveTextContent("1 inside waits on you, 3 more inside");
    expect(summary).toHaveTextContent("+3");
    expect(currentFolds().has("c1")).toBe(true);
  });

  it("opening a branch opens the folded branches down to the session that waits", async () => {
    const user = userEvent.setup();
    render(<AgentList agents={herd} onOpen={vi.fn()} order="tree" onOrderChange={vi.fn()} />);
    await user.click(toggle("quebec"));
    await user.click(toggle("papa"));
    expect(shown()).toEqual(["papa", "tango"]);
    await user.click(toggle("papa"));
    expect(shown()).toEqual(["papa", "quebec", "romeo", "sierra", "tango"]);
    expect(currentFolds().size).toBe(0);
  });

  it("a fold is remembered: a new list on this device opens folded", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AgentList agents={herd} onOpen={vi.fn()} order="tree" onOrderChange={vi.fn()} />);
    await user.click(toggle("quebec"));
    unmount();
    render(<AgentList agents={herd} onOpen={vi.fn()} order="tree" onOrderChange={vi.fn()} />);
    expect(shown()).toEqual(["papa", "quebec", "sierra", "tango"]);
  });
});
