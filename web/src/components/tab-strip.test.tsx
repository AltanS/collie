import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TabStrip } from "./tab-strip";
import type { TabView } from "@/lib/types";

const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "1", focused: true, paneCount: 2 },
  { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "2", focused: false, paneCount: 1 },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "1", focused: false, paneCount: 1 },
];

describe("TabStrip", () => {
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

describe("TabStrip — long-press rename", () => {
  // A long-press on a chip reaches the DOM as a `contextmenu` event (Android Chrome / right-click);
  // with onRenamed wired it opens the rename sheet (prefilled with the tab's label).
  it("opens the rename sheet on a long-press (contextmenu) when onRenamed is wired", () => {
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
    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "2" }));
    expect(screen.getByPlaceholderText("name this tab")).toHaveValue("2");
  });

  it("stays inert on contextmenu when onRenamed is not wired", () => {
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
    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
  });

  // Tapping the already-selected tab is otherwise a no-op re-select; with actions wired it opens the
  // same rename sheet a long-press would, so the chip is never a dead tap.
  it("opens the rename sheet on a plain tap of the already-selected tab", async () => {
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
      />,
    );
    await user.click(screen.getByRole("button", { name: "1" }));
    expect(screen.getByPlaceholderText("name this tab")).toHaveValue("1");
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
      />,
    );
    await user.click(screen.getByRole("button", { name: "2" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:t2");
    expect(screen.queryByPlaceholderText("name this tab")).toBeNull();
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
