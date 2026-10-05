import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

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

test("a tap in the lower half of the pane name reaches Pane settings, not the cache sheet", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  const cache = page.locator('[data-slot="cache-chip"]');
  await expect(cache).toBeVisible();
  const name = page.locator('[data-slot="pane-name"]');
  // The name's tap target is the upper half of the header's layer (30px of the 60px row), not just
  // its text: the cache reach used to cut into its lower 10px.
  const nameButton = page.locator('[data-slot="pane-identity-name"]');
  const nameBox = (await nameButton.boundingBox())!;
  const cacheBox = (await cache.boundingBox())!;
  const x = cacheBox.x + cacheBox.width / 2;

  // The lower half of the name's tap target, straight above the cache chip.
  const settings = en["chat.header.openPaneSettingsAria"].replace("{name}", (await name.textContent()) ?? "");
  for (const y of [nameBox.y + nameBox.height * 0.6, nameBox.y + nameBox.height * 0.8, nameBox.y + nameBox.height - 1]) {
    expect(await buttonAt(page, x, y), `y=${y}`).toBe(settings);
  }

  // And the chip itself, and the strip of reach under it, still open the cache sheet.
  const chipLabel = (await cache.getAttribute("aria-label"))!;
  expect(await buttonAt(page, x, cacheBox.y + cacheBox.height / 2)).toBe(chipLabel);
  expect(await buttonAt(page, x, cacheBox.y + cacheBox.height + 10)).toBe(chipLabel);
});

test("a tap on the workspace line reaches the workspace link", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  await expect(page.locator('[data-slot="cache-chip"]')).toBeVisible();
  const place = (await page.locator('[data-slot="pane-place"]').boundingBox())!;
  const label = await page.locator('[data-slot="pane-identity"]').getAttribute("aria-label");
  expect(label).toContain("collie");

  expect(await buttonAt(page, place.x + place.width / 2, place.y + place.height / 2)).toBe(label);
});
