import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE PANE HEADER'S THREE TAP TARGETS, measured in a real engine. The name line opens Pane settings,
// the workspace line opens the space, and the cache reading (a 12px chip) opens its sheet from a box
// that is only reached, never drawn: `before:` pseudo-element around the chip. That reach used to run
// 16px UP as well as down, over the lower half of the name line, so a tap there opened the cache
// sheet instead of Pane settings (1.17.0 review). The reach now hangs DOWN only. jsdom lays nothing
// out, so each probe here is `elementFromPoint`.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no pane route");
  await installApiStub(page);
  // One pane header and one cache chip: on app-tablet the large-screen sidebar's cards draw a chip
  // each too (ADR 0120).
  await keepPhoneLayout(page);
  // The cache chip is only a button when the pane carries a reading.
  const withCache = {
    ...fixtureSnapshot,
    agents: fixtureSnapshot.agents.map((a) =>
      Object.assign({}, a, {
        cache: { state: "warm", expiresAt: Date.now() + 40 * 60_000, ttlSeconds: 3600, ruleId: "claude-1h", confidence: "high" },
      }),
    ),
  };
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(withCache) }),
  );
});

/** The accessible name of whatever button sits under the point, or null. */
async function buttonAt(page: Page, x: number, y: number) {
  return page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest("button")?.getAttribute("aria-label") ?? null, [
    x,
    y,
  ] as const);
}

test("a tap anywhere on the pane's name reaches Pane settings, and the cache reading keeps its own reach inside the header", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  const cache = page.locator('[data-slot="cache-chip"]');
  await expect(cache).toBeVisible();
  const name = page.locator('[data-slot="pane-name"]');
  // On the phone with the tab row shown the space's door is that row's first cell (ADR 0171), so the name's tap
  // target is the header's whole 60px layer; the cache reading sits on it and takes its own taps back.
  const nameBox = (await name.boundingBox())!;
  const cacheBox = (await cache.boundingBox())!;
  const header = (await page.locator('header[data-slot="app-header"]').boundingBox())!;
  const x = cacheBox.x + cacheBox.width / 2;

  // The lower half of the name line, straight above the cache chip: the cache reach used to run 16px up and cut into
  // it (1.17.0 review). It reaches 4px up now, the gap between the two lines and no further.
  const settings = en["chat.header.openPaneSettingsAria"].replace("{name}", (await name.textContent()) ?? "");
  for (const y of [nameBox.y + nameBox.height * 0.6, nameBox.y + nameBox.height - 1]) {
    expect(await buttonAt(page, x, y), `y=${y}`).toBe(settings);
  }

  // The chip and the 4px of reach under it open the cache sheet; the reach ends inside the header, so the tab row
  // under it answers its own taps (it took the top 11px of New tab's 44px when it hung 16px down).
  const chipLabel = (await cache.getAttribute("aria-label"))!;
  expect(await buttonAt(page, x, cacheBox.y + cacheBox.height / 2)).toBe(chipLabel);
  expect(await buttonAt(page, x, cacheBox.y + cacheBox.height + 3)).toBe(chipLabel);
  expect(await buttonAt(page, x, cacheBox.y - 3)).toBe(chipLabel);
  expect(cacheBox.y + cacheBox.height + 4).toBeLessThanOrEqual(header.y + header.height);
  expect(await buttonAt(page, x, header.y + header.height + 2)).not.toBe(chipLabel);
});

test("the space's door is the tab row's first cell, 44px, and the place line no longer holds it", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  await expect(page.locator('[data-slot="cache-chip"]')).toBeVisible();
  const door = page.getByRole("navigation", { name: "Tabs" }).locator('[data-slot="pane-identity"]');
  const label = await door.getAttribute("aria-label");
  expect(label).toContain("collie");
  const box = (await door.boundingBox())!;
  expect(box.height).toBeCloseTo(44, 0);
  expect(await buttonAt(page, box.x + box.width / 2, box.y + box.height / 2)).toBe(label);
  // The header holds one door to the space, not two.
  await expect(page.locator('header [data-slot="pane-identity"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="pane-place"]')).toHaveText("");
});
