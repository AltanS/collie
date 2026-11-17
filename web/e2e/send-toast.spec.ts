import { expect, test, type Locator, type Page } from "@playwright/test";

import type { AgentView, SnapshotResponse } from "@/lib/types";
import { fixtureAgents, fixtureSnapshot } from "@/test/handlers";
import { installApiStub } from "./fixtures/api";

// THE SENT TOAST TAKES NO SPACE (DESIGN.md §2).
//
// A send the pane has not echoed two seconds after the tap says so in a toast: "You sent: ...". It used to be a
// row of the footer above the belt, so the belt, the box and the mirror all moved when it came and again when it
// went. It floats now, in the composer's floating column over the mirror's bottom edge. jsdom has no layout,
// so only a real engine can say that nothing moves. This sends once into a bridge that takes the text, never
// changes the pane's text (so nothing echoes it), reads the box and the mirror before the toast, while it
// stands, and after it has gone.

test.use({ serviceWorkers: "block" });

const PANE: AgentView = {
  ...fixtureAgents[0]!,
  sendProtocol: true,
  surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
};
const WORLD: SnapshotResponse = { ...fixtureSnapshot, agents: [PANE], shellPanes: [] };

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.first().boundingBox();
  if (box === null) throw new Error("no box");
  return box;
}

// A box is read only when it holds still: two reads 300 ms apart agree (the box regrows over 200 ms after a send).
async function settledBox(page: Page, locator: Locator): Promise<Box> {
  let last = await boxOf(locator);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(300);
    const next = await boxOf(locator);
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  throw new Error("never held still");
}

test("the sent toast floats over the mirror and moves neither the box nor the mirror", async ({ page }) => {
  let posts = 0;
  await installApiStub(page);
  await page.route((url) => url.pathname === "/api/snapshot", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORLD) }),
  );
  await page.route((url) => url.pathname === "/api/send", (route) => {
    posts += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipt: { outcome: "sent", keys: [] }, offers: [] }) });
  });
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}`);

  const field = page.locator('[data-slot="composer-box"] textarea').first();
  await expect(field).toBeVisible();
  const composerBox = page.locator('[data-slot="composer-box"]');
  // The mirror: the box the floating column is pinned to the bottom of.
  const mirror = page.locator('[data-slot="draft-notice-slot"]').locator("..");
  const toast = page.locator('[data-slot="send-toast"]');

  await field.fill("run the tests");

  const tapped = Date.now();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  // The box lets go of the text at the tap and closes over about 200 ms; read it once it holds still, but before
  // the toast's two seconds are up.
  await page.waitForTimeout(600);
  const composerBefore = await boxOf(composerBox);
  const mirrorBefore = await boxOf(mirror);
  // Under two seconds from the tap: no toast.
  expect(Date.now() - tapped).toBeLessThan(1900);
  await expect(toast).toHaveCount(0);

  // Two seconds after the tap: the toast, over the mirror, above the box.
  await expect(toast).toBeVisible({ timeout: 4000 });
  await expect(toast).toContainText("You sent:");
  expect(Date.now() - tapped).toBeGreaterThanOrEqual(1900);
  const toastBox = await boxOf(toast);
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(composerBefore.y);
  expect(await boxOf(composerBox)).toEqual(composerBefore);
  expect(await boxOf(mirror)).toEqual(mirrorBefore);

  // It goes by itself (6 s after it showed): nothing moves then either.
  await expect(toast).toHaveCount(0, { timeout: 9000 });
  expect(await settledBox(page, composerBox)).toEqual(composerBefore);
  expect(await settledBox(page, mirror)).toEqual(mirrorBefore);
});
