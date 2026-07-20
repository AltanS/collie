import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { TabStrip } from "./tab-strip";
import type { TabView } from "@/lib/types";

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
