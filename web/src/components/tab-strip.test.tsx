import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { TabStrip } from "./tab-strip";
import type { AgentStatus, AgentView, TabView } from "@/lib/types";

// What the eye reads on a cell: its text without the `aria-hidden` semibold copy each label keeps
// to reserve its width (`StableLabel` in tab-strip.tsx).
function visibleText(el: Element): string {
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[aria-hidden="true"]')) text += node.textContent ?? "";
  }
  return text;
}

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
      .map((button) => visibleText(button))
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

  // INK AND WEIGHT ARE THE ONLY MARK (option 3 of the 2026-09-23 top-bar deck): the open tab is
  // `text-foreground font-semibold`, the rest `text-muted-foreground font-medium`, and no cell draws
  // a border, an underline, a fill or a radius in either state. Every box-affecting class is
  // identical between the two states, and the weight change is held still by the label's semibold
  // copy. jsdom has no layout, so this pins the mechanism; `e2e/pane-top-bar.spec.ts` measures it.
  it("marks the open tab by ink and weight alone, with the box unchanged on selection", () => {
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
        .filter((c) => /^(h-|min-w-|px-|py-|p-|my-|rounded|border)/.test(c))
        .toSorted();

    const inactive = screen.getByRole("button", { name: "tab 2" });
    expect(inactive.className).toContain("text-muted-foreground");
    expect(inactive.className).toContain("font-medium");
    const inactiveBox = boxClasses(inactive);
    // No border and no radius at all: there is no box to reserve.
    expect(inactiveBox.filter((c) => /^(rounded|border)/.test(c))).toEqual([]);

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
    const active = screen.getByRole("button", { name: "tab 2" });
    expect(active).toHaveAttribute("aria-current", "true");
    expect(boxClasses(active)).toEqual(inactiveBox);
    expect(active.className).toContain("text-foreground");
    expect(active.className).toContain("font-semibold");
    expect(active.className).not.toMatch(/\bbg-primary\b|\bborder-b-2\b|outline-dashed/);
    // Rule E: the label reserves its semibold width in both states, so the weight change cannot
    // re-flow the row.
    expect(active.querySelector('[aria-hidden="true"].font-semibold')?.textContent).toBe("tab 2");
  });

  // NO HORIZONTAL RULE, AND NO HAIRLINE BETWEEN TABS EITHER. Altan, from the phone, on the row this
  // replaced: "the top tabs area has a lot of weird lines now. Completely remove horizontal borders
  // and just have vertical ones for tab items" — and then "the border left is weird": the `divide-x`
  // seam is gone too. The air between tabs is each tab's own padding, so the group has no gap.
  it("draws no horizontal rule of its own and no divider between tabs", () => {
    const { container } = render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected="w1:t1"
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    const nav = container.querySelector("nav")!;
    expect(nav.className).not.toMatch(/\bborder-[tb]\b/);
    expect(nav.className).toContain("bg-chrome");
    const group = nav.querySelector("div > div")!;
    expect(group.className).not.toContain("divide-x");
    expect(group.className).not.toContain("divide-border");
    const open = screen.getByRole("button", { name: "tab 1" });
    expect(open.className).not.toMatch(/\bborder\b/);
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
    expect(screen.getAllByRole("button", { name: "tab 1" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "tab 2" }));
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

// A POSITIONAL LABEL IS NOT A NAME (lib/pane-name.ts § tabTitle). Herdr labels an unnamed tab "1"
// and zellij calls it "Tab #2"; the tab reads its POSITION instead — "tab 1", "tab 3" — in a
// shade-lighter ink, on every surface alike. Only a tab with no label at all (no name, no digit)
// keeps the dot.
describe("TabStrip — a tab with no name of its own", () => {
  const strip = (label: string) =>
    render(
      <TabStrip
        workspaceId="w1"
        tabs={[{ ...tabs[0]!, label }]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

  it("draws its position, in the lighter ink, as the button's own spoken name", () => {
    strip("1");
    const tab = screen.getByRole("button", { name: "tab 1" });
    expect(visibleText(tab)).toBe("tab 1");
    expect(visibleText(tab.querySelector('[class*="text-muted-foreground"]')!)).toBe("tab 1");
    expect(tab.querySelector(".sr-only")).toBeNull();
  });

  it("treats zellij's own default the same way", () => {
    strip("Tab #3");
    expect(visibleText(screen.getByRole("button", { name: "tab 3" }))).toBe("tab 3");
  });

  it("draws a real name as text, with no dot and no positional ink standing in for it", () => {
    strip("review");
    const tab = screen.getByRole("button", { name: "review" });
    expect(visibleText(tab)).toBe("review");
    expect(tab.querySelector(".sr-only")).toBeNull();
    expect(tab.querySelector('[class*="text-muted-foreground"]')).toBeNull();
  });

  it("keeps the dot only for a tab with no label at all", () => {
    const { container } = strip("");
    const tab = screen.getByRole("button", { name: "" });
    expect(tab.querySelector(".sr-only")?.textContent).toBe("");
    expect(container.querySelector(".rounded-full")).not.toBeNull(); // the dot stands in its place
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
    fireEvent.contextMenu(screen.getByRole("button", { name: "tab 2" }));
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
    fireEvent.contextMenu(screen.getByRole("button", { name: "tab 2" }));
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
    fireEvent.contextMenu(screen.getByRole("button", { name: "tab 2" }));
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
    await user.click(screen.getByRole("button", { name: "tab 1" }));
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
    await user.click(screen.getByRole("button", { name: "tab 2" }));
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
    fireEvent.contextMenu(screen.getByRole("button", { name: "tab 2" })); // w1:t2, paneCount 1
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
    // An unseen tab carries the square, not a done dot: the square speaks "unseen".
    const { unmount } = strip([pane("w1:t1", "done", { lastActiveAt: 9, lastSeenAt: 1 })]);
    expect(screen.getByRole("button", { name: /code/ })).toHaveAccessibleName(/unseen/);
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

  // A CELL NAMES WHAT THE HEADER NAMES (lib/pane-name.ts § tabCellTitle). A one-pane tab reads its
  // pane's name, the word the pane header shows, so the open cell and the header agree. The tab's
  // own label stays where the tab is a real group, where it holds no pane, and where its sole pane
  // has only a kind to its name. And no brand tile any more: the header carries the agent's mark
  // once, and a tile on every cell made the belt read as a list of agents.
  const logos = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('[role="img"]')).map((n) => n.getAttribute("aria-label"));

  it("names a one-pane tab after its pane, the way the header does", () => {
    strip([pane("w1:t1", "working", { sessionName: "plumbing", terminalTitle: "plumbing" })]);
    const cell = screen.getByRole("button", { name: /plumbing/ });
    expect(cell).toHaveTextContent("plumbing");
    expect(cell).not.toHaveTextContent("code");
    expect(screen.queryByRole("button", { name: /code/ })).toBeNull();
  });

  it("keeps the tab label when the sole pane has only a kind to its name", () => {
    strip([pane("w1:t1", "idle")]);
    expect(screen.getByRole("button", { name: /code/ })).not.toHaveTextContent("claude");
  });

  it("keeps the tab label when the tab holds several panes", () => {
    strip([
      pane("w1:t1", "idle", { terminalTitle: "one" }),
      { ...pane("w1:t1", "working", { terminalTitle: "two" }), paneId: "w1:t1:p2" },
    ]);
    expect(screen.getByRole("button", { name: /code/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /one|two/ })).toBeNull();
  });

  it("draws no brand tile on any cell", () => {
    strip([pane("w1:t1", "idle", { terminalTitle: "one" })]);
    expect(logos(screen.getByRole("button", { name: /one/ }))).toEqual([]);
    expect(logos(screen.getByRole("button", { name: /empty/ }))).toEqual([]);
  });
});

// The "+" gives no feedback while a create is in flight — the operator taps it, nothing visibly
// happens for a beat, and taps again. `creatingTab` is the fix: the caller (agent-chat.tsx,
// space.tsx) computes it from the hook's `creatingTab` set for THIS workspace, and the button
// disables itself and swaps its icon for a spinner rather than staying a live-looking no-op.
describe("TabStrip new-tab busy state", () => {
  it("disables the '+' and shows a spinner while its Space is creating", () => {
    render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
        creatingTab
      />,
    );
    const button = screen.getByRole("button", { name: "New tab" });
    expect(button).toBeDisabled();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
  });

  it("stays enabled with a plain plus when not creating", () => {
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
    const button = screen.getByRole("button", { name: "New tab" });
    expect(button).toBeEnabled();
    expect(button.querySelector(".animate-spin")).toBeNull();
  });

  it("a tap while creating never reaches onNewTab", async () => {
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
        creatingTab
      />,
    );
    await user.click(screen.getByRole("button", { name: "New tab" }));
    expect(onNewTab).not.toHaveBeenCalled();
  });

  // The many-tabs defect (the whole reason `useRevealActive` exists): jsdom lays nothing out, so the
  // hook's own guard (`clientWidth === 0`) makes the MOUNT reveal a no-op here — that path is pinned
  // in `use-reveal-active.test.tsx` instead. What this proves is the WIRING: once the scroller has a
  // stubbed layout, a selection change that lands off-screen calls `scrollTo`, and one that lands
  // on-screen does not. Both buttons already exist in the DOM before the switch (only `aria-current`
  // toggles), so their rects can be stubbed ahead of the re-render that flips the selection.
  function stubRect(el: HTMLElement, rect: { left: number; right: number }): void {
    el.getBoundingClientRect = (): DOMRect => ({
      ...rect,
      top: 0,
      bottom: 0,
      width: rect.right - rect.left,
      height: 0,
      x: rect.left,
      y: 0,
      toJSON: () => ({}),
    });
  }

  it("scrolls the newly active tab into view on a selection change", () => {
    const { container, rerender } = render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={tabs[0]!.tabId}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    // SAFETY: TabStrip always renders one <nav> with one direct <div> scroller child (its own
    // structure — see the component's header comment on the -mx-4/px-4 pairing), so a render never
    // leaves this query unmatched.
    const scroller = container.querySelector<HTMLDivElement>("nav > div")!;
    Object.defineProperty(scroller, "clientWidth", { value: 100, configurable: true });
    scroller.scrollLeft = 0;
    stubRect(scroller, { left: 0, right: 100 });
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    const newlyActive = screen.getByRole("button", { name: "tab 2" });
    stubRect(newlyActive, { left: 300, right: 340 }); // well past the scroller's right edge

    rerender(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={tabs[1]!.tabId}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0]![0].left).toBeGreaterThan(0);
  });

  it("does not scroll when the newly active tab is already on screen", () => {
    const { container, rerender } = render(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={tabs[0]!.tabId}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );
    // SAFETY: TabStrip always renders one <nav> with one direct <div> scroller child (its own
    // structure — see the component's header comment on the -mx-4/px-4 pairing), so a render never
    // leaves this query unmatched.
    const scroller = container.querySelector<HTMLDivElement>("nav > div")!;
    Object.defineProperty(scroller, "clientWidth", { value: 100, configurable: true });
    scroller.scrollLeft = 0;
    stubRect(scroller, { left: 0, right: 100 });
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    const newlyActive = screen.getByRole("button", { name: "tab 2" });
    stubRect(newlyActive, { left: 20, right: 60 }); // comfortably inside the visible range

    rerender(
      <TabStrip
        workspaceId="w1"
        tabs={tabs}
        agents={[]}
        selected={tabs[1]!.tabId}
        onSelect={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
