import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { __resetDashFilter } from "@/lib/dash-filter";
import { paneRowKey } from "@/lib/hosts";
import { workspaceGroupKey } from "@/lib/pane-groups";
import { __resetFoldedParents, toggleFoldedParent } from "@/lib/pane-tree";
import { dropSpaceLanding, peekSpaceLanding, queueSpaceLanding } from "@/lib/space-landing";
import type { AgentView } from "@/lib/types";
import { AgentList } from "./agent-list";

function pane(paneId: string, sessionName: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    sessionName,
    workspaceId: "w1",
    workspaceLabel: "workspace",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/workspace",
    focused: false,
    ...over,
  };
}

const field = () => screen.getByRole("textbox", { name: "Filter sessions" });
const fold = (name: string) => screen.getByRole("button", { name });
const names = (section: HTMLElement, expected: string[]) =>
  within(section).getAllByRole("button").flatMap((button) => expected.filter((name) => within(button).queryByText(name)));
const timed = (a: AgentView, at: number): AgentView => ({ ...a, lastActiveAt: at, lastSeenAt: at });

beforeEach(() => {
  __resetFoldedParents();
  __resetDashFilter();
});

afterEach(() => {
  dropSpaceLanding();
});

it("nests workers expanded by default and folds them without opening the parent", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const parent = pane("t1", "release-coordinator");
  const done = pane("t2", "audit-auth", { status: "done", parentPaneId: "t1", lastActiveAt: 200, lastSeenAt: 100 });
  const blocked = pane("t3", "check-migrations", { status: "blocked", parentPaneId: "t1" });
  render(<AgentList agents={[parent, done, blocked]} onOpen={onOpen} />);
  expect(screen.getByText("audit-auth")).toBeInTheDocument();
  expect(screen.getByText("check-migrations")).toBeInTheDocument();

  await user.click(fold("Collapse sub-agents (2)"));
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.queryByText("audit-auth")).toBeNull();
  expect(screen.queryByText("check-migrations")).toBeNull();
  const expand = fold("Expand sub-agents (2)");
  expect(within(expand).getByRole("img", { name: "needs you" })).toBeInTheDocument();
  await user.click(expand);
  expect(screen.getByText("audit-auth")).toBeInTheDocument();
});

it.each(["narrow", "wide"] as const)("shows folded Place matches and opens the first displayed row on %s", async (size) => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const parent = pane("t1", "api server");
  const child = pane("t2", "api worker", { parentPaneId: "t1", unpaned: true });
  const other = Array.from({ length: 4 }, (_, i) => pane(`other-${i}`, `other ${i}`));
  render(<AgentList agents={[child, ...other, parent]} onOpen={onOpen} filterEntry="always" wide={size === "wide" ? { columns: 2 } : undefined} />);
  await user.click(fold("Collapse sub-agents (1)"));
  expect(screen.queryByText("api worker")).toBeNull();

  await user.type(field(), "api");
  const rendered = screen.getAllByRole("button", { name: /api (server|worker)/i });
  expect(rendered.map((button) => button.textContent)).toEqual([expect.stringContaining("api server"), expect.stringContaining("api worker")]);
  expect(screen.getByText("2 of 6")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /sub-agents/i })).toBeNull();
  await user.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(parent, rendered[0]);

  await user.clear(field());
  expect(screen.queryByText("api worker")).toBeNull();
  expect(fold("Expand sub-agents (1)")).toBeInTheDocument();
});

it.each(["activity", "cache"] as const)("keeps a child arriving after the %s freeze at the end of the flat list", (order) => {
  const parent = timed(pane("t1", "parent-P"), order === "activity" ? 900 : 100);
  const sibling = timed(pane("t3", "sibling-Q"), 500);
  const child = timed(pane("t2", "child-C", { parentPaneId: "t1" }), order === "activity" ? 9_999 : 1);
  const onOpen = vi.fn();
  const { rerender } = render(<AgentList agents={[parent, sibling]} onOpen={onOpen} order={order} />);
  const ranked = screen.getByRole("region", { name: order === "activity" ? /^Newest first/ : /^Going cold first/ });
  expect(names(ranked, ["parent-P", "sibling-Q"])).toEqual(["parent-P", "sibling-Q"]);
  rerender(<AgentList agents={[parent, sibling, child]} onOpen={onOpen} order={order} />);
  expect(names(ranked, ["parent-P", "sibling-Q", "child-C"])).toEqual(["parent-P", "sibling-Q", "child-C"]);
  expect(screen.queryByRole("button", { name: /sub-agents/i })).toBeNull();

  rerender(<AgentList agents={[parent, sibling, child]} onOpen={onOpen} order="place" />);
  expect(fold("Collapse sub-agents (1)")).toBeInTheDocument();
});

it("keeps Activity search and Enter ordered by rank when a child is newer than its parent", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const parent = timed(pane("t1", "api server"), 100);
  const child = timed(pane("t2", "api worker", { parentPaneId: "t1", unpaned: true }), 999);
  const other = Array.from({ length: 4 }, (_, i) => pane(`other-${i}`, `other ${i}`));
  render(<AgentList agents={[parent, child, ...other]} onOpen={onOpen} order="activity" filterEntry="always" />);
  await user.type(field(), "api{Enter}");
  const rendered = screen.getAllByRole("button", { name: /api (server|worker)/i });
  expect(rendered.map((button) => button.textContent)).toEqual([expect.stringContaining("api worker"), expect.stringContaining("api server")]);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(child, rendered[0]);
});

it("lands on the visible parent row when the space's first raw row is a folded child", async () => {
  const parent = pane("t1", "shell parent", { agent: "shell", kind: "shell", status: "unknown" });
  const child = pane("t2", "agent child", { parentPaneId: "t1" });
  toggleFoldedParent(paneRowKey(parent));
  queueSpaceLanding(workspaceGroupKey(parent));
  await act(async () => {
    render(<AgentList agents={[child]} shellPanes={[parent]} onOpen={vi.fn()} wide={{ columns: 2 }} />);
  });
  expect(screen.queryByText("agent child")).toBeNull();
  const parentRow = document.getElementById(`pane-row-${paneRowKey(parent).replace(/[^A-Za-z0-9_-]/gu, "_")}`);
  expect(parentRow).not.toBeNull();
  expect(document.activeElement).toBe(parentRow);
  expect(peekSpaceLanding()).toBeNull();
});

it("focuses the visible parent row when dismissing the pin hint over a folded first child", async () => {
  const user = userEvent.setup();
  const parent = pane("t1", "shell parent", { agent: "shell", kind: "shell", status: "unknown" });
  const child = pane("t2", "agent child", { parentPaneId: "t1" });
  const sibling1 = pane("t3", "sibling one");
  const sibling2 = pane("t4", "sibling two");
  toggleFoldedParent(paneRowKey(parent));
  render(<AgentList agents={[child, sibling1, sibling2]} shellPanes={[parent]} onOpen={vi.fn()} onHold={vi.fn()} />);
  expect(screen.queryByText("agent child")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Dismiss hint" }));
  const parentRow = document.getElementById(`pane-row-${paneRowKey(parent).replace(/[^A-Za-z0-9_-]/gu, "_")}`);
  expect(parentRow).not.toBeNull();
  expect(document.activeElement).toBe(parentRow);
});

it("hides the pin hint when folding drops visible rows below three", () => {
  const parent = pane("t1", "shell parent", { agent: "shell", kind: "shell", status: "unknown" });
  const child1 = pane("t2", "agent child one", { parentPaneId: "t1" });
  const child2 = pane("t3", "agent child two", { parentPaneId: "t1" });
  toggleFoldedParent(paneRowKey(parent));
  render(<AgentList agents={[child1, child2]} shellPanes={[parent]} onOpen={vi.fn()} onHold={vi.fn()} />);
  expect(screen.queryByText("agent child one")).toBeNull();
  expect(screen.queryByRole("button", { name: "Dismiss hint" })).toBeNull();
});
