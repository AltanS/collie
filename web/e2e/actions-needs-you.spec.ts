import { expect, test, type Locator } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureAgents, fixtureSnapshot } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

import { actionsButton } from "./fixtures/actions";
import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE ACTIONS SHEET LISTS THE PANES THAT NEED YOU FIRST. On a phone, with the soft keyboard open (the page
// shrinks to the room above it, `interactive-widget=resizes-content`), the block "Needs you" stands above
// "Recent" with every waiting pane in the Dashboard's order, and the field stays in view, the list scrolls and
// no row lies over another. 0, 1 and 6 waiting panes, at 390 and 360 px wide.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
  await keepPhoneLayout(page);
  await installApiStub(page);
});

/** `count` panes that wait for an answer, in Space w1 then w2, named so the order can be read from the rows. */
function waitingPanes(count: number): AgentView[] {
  return Array.from({ length: count }, (_, i) => ({
    ...fixtureAgents[0]!,
    paneId: `${i < 3 ? "w1" : "w2"}:p${String(10 + i)}`,
    workspaceId: i < 3 ? "w1" : "w2",
    workspaceLabel: i < 3 ? "webapp" : "collie",
    workspaceNumber: i < 3 ? 1 : 2,
    tabId: i < 3 ? "w1:t1" : "w2:t1",
    paneLabel: `waiting-${String(i + 1)}`,
    status: "blocked" as const,
  }));
}

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

for (const width of [390, 360]) {
  for (const count of [0, 1, 6]) {
    test(`at ${String(width)} px with ${String(count)} waiting, the keyboard open: the Needs you block leads and nothing overlaps`, async ({ page }) => {
      const waiting = waitingPanes(count);
      const calm: AgentView[] = [{ ...fixtureAgents[1]!, paneLabel: "calm-pane" }];
      await page.route("**/api/snapshot", (route) => route.fulfill({ json: { ...fixtureSnapshot, agents: [...calm, ...waiting] } }));
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await actionsButton(page).click();
      const palette = page.getByRole("dialog", { name: en["actions.title"] });
      await expect(palette).toBeVisible();
      const field = palette.getByRole("textbox", { name: en["actions.search.placeholder"] });
      await expect(field).toBeFocused();
      // The soft keyboard takes the lower half: the page is now 390 x 420.
      await page.setViewportSize({ width, height: 420 });
      await page.waitForTimeout(300);

      const block = palette.locator("section", { has: page.getByRole("heading", { name: en["status.section.needsYou"] }) });
      await expect(block).toHaveCount(count === 0 ? 0 : 1);

      const list = palette.locator('[data-slot="actions-palette-list"]');
      const fieldBox = await box(field);
      const listBox = await box(list);
      const panelBox = await box(palette);
      // The field is in view, whole, and the list starts below it.
      expect(fieldBox.y).toBeGreaterThanOrEqual(0);
      expect(fieldBox.y + fieldBox.height).toBeLessThanOrEqual(420);
      expect(listBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 1);
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(420);
      expect(panelBox.x).toBeGreaterThanOrEqual(0);
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(width);
      // The list scrolls inside itself.
      if (count === 6) expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

      if (count === 0) {
        await expect(palette.getByRole("heading", { name: en["status.section.needsYou"] })).toHaveCount(0);
        return;
      }
      // Above Recent and Suggested, and in the Dashboard's order: Space, tab, position.
      const headings = await palette.getByRole("heading").allTextContents();
      expect(headings.indexOf(en["status.section.needsYou"])).toBe(0);
      const rows = block.locator('[data-slot="pane-row"]');
      await expect(rows).toHaveCount(count);
      const names = await rows.evaluateAll((els) => els.map((el) => /waiting-\d/.exec(el.textContent ?? "")?.[0] ?? ""));
      expect(names).toEqual(waiting.map((p) => p.paneLabel));
      // No row lies over the next one.
      const boxes = await rows.evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      }));
      boxes.slice(1).forEach((b, i) => expect(b.top).toBeGreaterThanOrEqual(boxes[i]!.bottom - 1));
      // The first row is the highlighted one, and the last scrolls into reach.
      await expect(palette.locator('[data-highlighted="true"]')).toContainText(names[0]!);
      await rows.last().scrollIntoViewIfNeeded();
      await expect(rows.last()).toBeVisible();
    });
  }
}
