import { render, screen } from "@testing-library/react";
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
