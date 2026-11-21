import { expect, test, type Page } from "@playwright/test";

import type { SnapshotResponse } from "@/lib/types";

import { installApiStub } from "./fixtures/api";
import { wideSnapshot } from "./fixtures/wide-herd";

// THE SPACE'S NAME AND THE TABS SHARE ONE LINE AND NEVER OVERLAP. The bar of a large screen opens with the
// space's name (and, with two machines, " · machine"), then the tab row. A long name with a machine and
// five tabs once ran under the first tab: the folder look's first tab card reached 16px left of the row's
// own box, over the end of the name. Now the label keeps its own box and the tabs start after it, the
// machine gives way first, the name then ends in an ellipsis, and the label takes at most a third of the
// bar while tabs stand beside it.

test.use({ serviceWorkers: "block" });

const LONG = "nightly-evaluation-harness-workspace";

function crowded(): SnapshotResponse {
  const snapshot = wideSnapshot({ spaces: 4, crew: true });
  const tabs = [1, 2, 3, 4, 5].map((n) => ({ tabId: `w1:t${n}`, workspaceId: "w1", number: n, label: n === 1 ? "main" : `tab-${n}`, focused: n === 1, paneCount: 1, host: "lodge" }));
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((w) => (w.workspaceId === "w1" ? { ...w, label: LONG, tabCount: 5 } : w)),
    agents: snapshot.agents.map((a) => (a.workspaceId === "w1" ? { ...a, workspaceLabel: LONG } : a)),
    tabs: [...tabs, ...snapshot.tabs.filter((t) => t.workspaceId !== "w1")],
  };
}

async function open(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await installApiStub(page);
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(crowded()) }));
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="wide-layout"]')).toHaveAttribute("data-width-class", "expanded");
  await expect(page.locator('[data-slot="space-title"]')).toContainText("nightly");
}

test.beforeEach(async ({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "sets its own viewport; one project is enough");
});

for (const width of [1440, 1100]) {
  test(`at ${String(width)}px the space's name and the first tab never overlap, and the name takes the tap`, async ({ page }) => {
    await open(page, width);
    const m = await page.evaluate(() => {
      const label = document.querySelector('[data-slot="space-title"]')!;
      const nav = document.querySelector('[data-slot="space-header"] nav')!;
      const tab = nav.querySelector("button")!;
      const bar = document.querySelector('[data-slot="space-header"]')!.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      // The first tab's drawn box: the button and the folder card behind it, whichever reaches further left.
      const t = tab.getBoundingClientRect();
      const lefts = [t.left, ...[...tab.querySelectorAll("*")].map((e) => e.getBoundingClientRect().left)];
      const cx = l.left + l.width / 2;
      const cy = l.top + l.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const name = label.querySelector('[data-slot="space-title-name"]')!;
      const machine = label.querySelector('[data-slot="space-title-machine"]')!;
      return {
        nameCut: name.scrollWidth > name.clientWidth,
        machineWidth: machine.getBoundingClientRect().width,
        labelRight: l.right, labelWidth: l.width, tabLeft: Math.min(...lefts), barWidth: bar.width, hitIsLabel: hit !== null && label.contains(hit), title: label.getAttribute("title") };
    });
    // A visible gap, not only no overlap: flush against the folder card, the end of the line read as
    // running under the tab.
    expect(m.labelRight + 8).toBeLessThanOrEqual(m.tabLeft);
    // The machine gives way before the name loses a letter.
    if (m.nameCut) expect(m.machineWidth).toBeLessThanOrEqual(1);
    expect(m.hitIsLabel).toBe(true);
    expect(m.labelWidth).toBeLessThanOrEqual(m.barWidth / 3 + 1);
    expect(m.title).toContain(LONG);
  });
}
