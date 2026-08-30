import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { TabStrip } from "./tab-strip";
import type { AgentStatus, AgentView, TabView } from "@/lib/types";

const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "1", focused: true, paneCount: 2 },
  { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "2", focused: false, paneCount: 1 },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "1", focused: false, paneCount: 1 },
];

describe("TabStrip", () => {
  it("renders tabs in snapshot order even when their stable numbers differ", () => {
    render(
      <TabStrip
        workspaceId="w1"
        tabs={[
          { ...tabs[1]!, label: "Second" },
          { ...tabs[0]!, label: "First" },
        ]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    const renderedTabs = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((label) => label === "First" || label === "Second");
    expect(renderedTabs).toEqual(["Second", "First"]);
  });

  // The row draws no name any more — a folder tab announces itself by its shape, which is why the
  // operator asked for the word to go. The NAME is not the word: a run of buttons with no accessible
  // name is what LabelledStrip existed to prevent, so it moved to an aria-label and must stay.
  it("keeps its accessible name while drawing no visible label", () => {
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Tabs" })).toBeInTheDocument();
    expect(screen.queryByText("Tabs")).toBeNull();
  });

  // THE fault a folder tab ships with. The active tab gains a border on three sides and a fill; if
  // the inactive ones did not already reserve that box, every label to the right would jump on every
  // selection. jsdom has no layout, so this pins the mechanism instead of the pixels: the border and
  // padding classes are in the BASE string and therefore identical in both states, and only colour /
  // background classes differ. The measured proof is in the browser — a label's left edge, top edge
  // and width are the same to three decimals in both states at 390px.
  it("reserves the active tab's box in every state, so no label moves on selection", () => {
    const { rerender } = render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    const boxClasses = (el: Element) =>
      el.className
        .split(/\s+/)
        .filter((c) => /^(h-|min-w-|px-|py-|p-|border($|-)|rounded)/.test(c))
        .toSorted();

    const inactive = boxClasses(screen.getByRole("button", { name: "2" }));
    rerender(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected="w1:t2"
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    const active = screen.getByRole("button", { name: "2" });
    expect(active).toHaveAttribute("aria-current", "true");
    // Every box-affecting class is shared. The only difference is the border COLOUR — tailwind-merge
    // resolves `border-transparent` against `border-rule`, so exactly one of the two is present in
    // each state and the 1px border itself is in neither branch.
    const colour = (c: string) => c === "border-transparent" || c === "border-rule";
    expect(boxClasses(active).filter((c) => !colour(c))).toEqual(inactive.filter((c) => !colour(c)));
    expect(inactive.filter(colour)).toEqual(["border-transparent"]);
    expect(boxClasses(active).filter(colour)).toEqual(["border-rule"]);
    // Rule E: state may not change font weight, or the whole row re-flows.
    expect(active.className).toContain("font-medium");
  });

  it("shows All plus only this workspace's tabs, and reports selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={null}
        onSelect={onSelect}
        onNewTab={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    // w2's tab (also labelled "1") must be excluded, so there's exactly one "1".
    expect(screen.getAllByRole("button", { name: "1" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "2" }));
    expect(onSelect).toHaveBeenCalledWith("w1:t2");
  });

  it("creates a tab in the current workspace", async () => {
    const user = userEvent.setup();
    const onNewTab = vi.fn();
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={onNewTab}
      />,
    );
    await user.click(screen.getByRole("button", { name: /new tab/i }));
    expect(onNewTab).toHaveBeenCalledWith("w1");
  });
});

describe("TabStrip — long-press actions", () => {
  // A long-press on a chip reaches the DOM as a `contextmenu` event (Android Chrome / right-click);
  // with both actions wired it opens the actions sheet (rename / close), like the pane strip.
  it("opens the actions sheet on a long-press (contextmenu) when the actions are wired", () => {
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "2" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
  });

  it("stays inert on contextmenu when the actions are not wired", () => {
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "2" }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("stays inert when only onRenamed is wired (both callbacks are required)", () => {
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
        onRenamed={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "2" }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  // Tapping the already-selected tab is otherwise a no-op re-select; with actions wired it opens the
  // same actions sheet a long-press would, so the chip is never a dead tap.
  it("opens the actions sheet on a plain tap of the already-selected tab", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected="w1:t1"
        onSelect={onSelect}
        onNewTab={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "1" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still switches on a tap of a non-selected tab even with actions wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected="w1:t1"
        onSelect={onSelect}
        onNewTab={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "2" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:t2");
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  // The two-tap close wiring the call-site fallbacks hang off: long-press → Close tab → confirm hits
  // the bridge and fires the parent's onClosed with the tab id.
  it("closes a tab through a two-tap confirm and reports the closed tab id", async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    let url = "";
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected="w1:t1"
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={onClosed}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "2" })); // w1:t2, paneCount 1
    await user.click(screen.getByRole("button", { name: "Close tab" }));
    await user.click(screen.getByRole("button", { name: "Tap again to close 1 pane" }));

    await waitFor(() => expect(onClosed).toHaveBeenCalledExactlyOnceWith("w1:t2"));
    expect(url).toContain("/api/tab/w1%3At2/close");
  });

  // The tab label is user text — it must render as a plain text node, never markup (XSS boundary).
  it("renders a markup-looking tab label as literal text, injecting nothing", () => {
    const xss = "<img src=x onerror=alert(1)>";
    render(
      <TabStrip
        workspaceId="w1"
        tabs={[{ tabId: "w1:t1", workspaceId: "w1", number: 1, label: xss, focused: false, paneCount: 1 }]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: xss })).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("TabStrip — status on the chips", () => {
  const chipTabs: TabView[] = [
    { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "code", focused: false, paneCount: 1 },
    { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "empty", focused: false, paneCount: 0 },
  ];
  const pane = (tabId: string, status: AgentStatus, extra: Partial<AgentView> = {}): AgentView => ({
    paneId: `${tabId}:p1`,
    workspaceId: "w1",
    workspaceLabel: "ws",
    workspaceNumber: 1,
    tabId,
    agent: "claude",
    status,
    cwd: "/home/you/ws",
    focused: false,
    ...extra,
  });

  const strip = (agents: AgentView[]) =>
    render(
      <TabStrip
        workspaceId="w1"
        tabs={chipTabs}
        agents={agents}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

  it("says what's going on in a tab, in words as well as colour", () => {
    strip([pane("w1:t1", "blocked")]);
    expect(screen.getByRole("button", { name: /code/ })).toHaveTextContent("needs you");
  });

  it("reports the most urgent pane when a tab holds several", () => {
    strip([pane("w1:t1", "idle"), { ...pane("w1:t1", "blocked"), paneId: "w1:t1:p2" }]);
    expect(screen.getByRole("button", { name: /code/ })).toHaveTextContent("needs you");
  });

  it("distinguishes a finished-but-unseen tab from a working one", () => {
    const { unmount } = strip([pane("w1:t1", "done", { lastActiveAt: 9, lastSeenAt: 1 })]);
    expect(screen.getByRole("button", { name: /code/ })).toHaveTextContent("done");
    unmount();
    strip([pane("w1:t1", "working")]);
    expect(screen.getByRole("button", { name: /code/ })).toHaveTextContent("working");
  });

  it("says idle rather than staying silent about a quiet tab", () => {
    strip([pane("w1:t1", "idle")]);
    expect(screen.getByRole("button", { name: /code/ })).toHaveTextContent("idle");
  });

  it("reports nothing for a tab with no agents — empty is not idle", () => {
    strip([pane("w1:t1", "idle")]);
    const empty = screen.getByRole("button", { name: /empty/ });
    for (const word of ["idle", "working", "done", "needs you"]) {
      expect(empty).not.toHaveTextContent(word);
    }
  });

  // WHICH AGENT IS IN THERE — the operator's ask, and the reason it belongs on the tab rather than
  // only in the pane header: a space's tabs are exactly the dimension along which the answer changes,
  // so the header names one agent and switching tabs changes it with no warning in the row you came
  // from. The tile is drawn only when the tab's panes agree on ONE brand. Silence is the honest
  // answer in the other two cases and both are pinned below, because a mark is a claim about the
  // whole tab that only one pane in it would support.
  //
  // Read through the LOGO's own accessible name, not a class: AgentIcon labels itself "<agent> logo"
  // and the wrapper hides it from the tab's own name, so the query has to reach inside the button.
  const logos = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('[role="img"]')).map((n) => n.getAttribute("aria-label"));

  it("marks a tab with the agent it runs, when its panes agree on one", () => {
    strip([pane("w1:t1", "idle"), { ...pane("w1:t1", "working"), paneId: "w1:t1:p2" }]);
    expect(logos(screen.getByRole("button", { name: /code/ }))).toEqual(["claude logo"]);
    // …and it is not announced a second time: the tab already says its label and its status.
    expect(screen.getByRole("button", { name: /code/ }).getAttribute("aria-label")).toBeNull();
    expect(screen.getByRole("button", { name: /code/ })).not.toHaveTextContent("claude");
  });

  it("marks nothing when a tab runs two different agents", () => {
    strip([pane("w1:t1", "idle"), { ...pane("w1:t1", "idle"), paneId: "w1:t1:p2", agent: "codex" }]);
    expect(logos(screen.getByRole("button", { name: /code/ }))).toEqual([]);
    // The status is still counted over both panes — only the BRAND claim is withheld.
    expect(screen.getByRole("button", { name: /code/ })).toHaveTextContent("idle");
  });

  it("marks nothing on a tab with no agents at all", () => {
    strip([pane("w1:t1", "idle")]);
    expect(logos(screen.getByRole("button", { name: /empty/ }))).toEqual([]);
  });
});
