import { expect, test, type Page } from "@playwright/test";

import type { AgentView, SnapshotResponse } from "@/lib/types";
import { fixtureAgents, fixtureSnapshot } from "@/test/handlers";
import { installApiStub } from "./fixtures/api";

// THE REPORT CARD TAKES NO SPACE (ADR 0123, DESIGN.md §2).
//
// After three sends in a row that fail for a reason that points at Collie, a card floats above the
// composer. It sits in the composer's floating column, which is absolutely placed: the field, the belt
// and the mirror above them must not move when it comes or goes. jsdom has no layout, so only a real
// engine can say so. This sends three times into a bridge that refuses each with `probe_failed`, and
// reads the field's box after the second refusal (its own notice already shown) and after the third,
// when the card arrives, then again after the cross. The composer box is read the same way.

test.use({ serviceWorkers: "block" });

const PANE: AgentView = {
  ...fixtureAgents[0]!,
  sendProtocol: true,
  surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
};
const WORLD: SnapshotResponse = { ...fixtureSnapshot, agents: [PANE], shellPanes: [] };

async function boxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box`);
  return box;
}

// A failed box send lets go of the box at the tap and puts the text back when the refusal comes (M104); the
// box then regrows over FLIP_MS (200 ms). A box is read only when it holds still: two reads 300 ms apart agree.
async function settledBox(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = await boxOf(page, selector);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(300);
    const next = await boxOf(page, selector);
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  throw new Error(`${selector} never held still`);
}

test("the report card floats over the mirror and moves neither the field nor the mirror", async ({ page }) => {
  let posts = 0;
  await installApiStub(page);
  await page.route((url) => url.pathname === "/api/snapshot", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORLD) }),
  );
  await page.route((url) => url.pathname === "/api/send", (route) => {
    posts += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ receipt: { outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] }, offers: ["keys"] }),
    });
  });
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}`);

  const FIELD = '[data-slot="composer-box"] textarea';
  const field = page.locator(FIELD).first();
  await expect(field).toBeVisible();
  await field.fill("run the tests");

  const send = page.getByRole("button", { name: "Send", exact: true });
  const sendOnce = async (n: number) => {
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(() => posts).toBe(n);
  };
  await sendOnce(1);
  await sendOnce(2);
  await expect(page.locator('[data-slot="report-card"]')).toHaveCount(0);
  const before = await settledBox(page, FIELD);
  const scrollerBefore = await settledBox(page, '[data-slot="composer-box"]');
  await sendOnce(3);
  const card = page.locator('[data-slot="report-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("Sending failed 3 times.");

  const withCard = await settledBox(page, FIELD);
  expect(withCard).toEqual(before);
  expect(await settledBox(page, '[data-slot="composer-box"]')).toEqual(scrollerBefore);
  // The card stands above the box, over the mirror's bottom edge.
  const cardBox = await boxOf(page, '[data-slot="report-card"]');
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(scrollerBefore.y);

  // `scroll: "none"` is a person's tap: it never scrolls anything to reach the cross. The default click
  // does, and on the tablet that moved the strip. The card is still settling for about 250 ms after it
  // comes (its y eases from 1028 to 976), so Playwright's first three tries find it "not stable", and its
  // fourth retry force-aligns the button with `scrollIntoView({ block: "start", inline: "start" })`,
  // which scrolls the strip's horizontal scroller by 360 px (the strip is wider than its pane column
  // there; on the phone it has nothing to scroll). The app does not do that: a real tap leaves the
  // strip at 0, and `none` fails the click if the cross is not reachable where it stands.
  await page.getByRole("button", { name: "Close the report offer" }).click({ scroll: "none" });
  await expect(card).toHaveCount(0);
  expect(await boxOf(page, FIELD)).toEqual(before);
  expect(posts).toBe(3);
});
