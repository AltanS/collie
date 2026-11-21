import { expect, test, type Page } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";
import type { OfficialTricksReply, TricksReply, WireTrickInfo } from "@/lib/tricks/schema";

import { installApiStub } from "./fixtures/api";

// REMOVING A TRICK FROM ITS DETAILS PAGE (ADR 0168), in a real engine at 390 x 844 and at 1440 x 900: the last
// section of the page of a trick that is off offers Remove trick; the confirm (the sheet on a phone, a centred
// dialog on a large screen) starts on Cancel and Escape closes it; its Remove trick posts `{ rid }` once and the page
// leaves for the list, which no longer holds the trick, and the layout's live region says it was removed. A refusal stays on the page and says why in the row.

test.use({ serviceWorkers: "block" });

const KETTLE: WireTrickInfo = {
  host: "lodge",
  id: "kettle",
  name: "Kettle Watch",
  icon: "flask",
  on: false,
  state: "off",
  places: ["session", "belt"],
  description: "Says when the kettle in the build log is boiling.",
  about: "Kettle Watch reads one line of the build log every minute and draws how hot the kettle is.\n\nIt never writes a file.",
  run: "bun run kettle.ts",
  everyMs: 300_000,
  version: "1.2.0",
  provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "lodge/kettle-watch", sha: "3f2a91c0d1e2" },
};
const SHELF: WireTrickInfo = { host: "lodge", id: "shelf", name: "Shelf", icon: "file", on: false, state: "off", places: ["belt"], description: "Keeps a list of jars on a shelf.", provenance: { via: "cli", at: "2026-11-08T07:41:00Z" } };

/** The stub world. `answer` is what the remove route answers; after a 200 the list no longer holds the trick. */
async function stub(page: Page, answer: { status: number; body: object }): Promise<{ bodies: unknown[] }> {
  const bodies: unknown[] = [];
  let removed = false;
  await installApiStub(page);
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...fixtureSnapshot, tricksRev: removed ? 2 : 1 }) }));
  await page.route("**/api/tricks?*", (route) => {
    const reply: TricksReply = { rev: removed ? 2 : 1, tricks: removed ? [SHELF] : [KETTLE, SHELF], parts: [], present: [] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(reply) });
  });
  await page.route("**/api/tricks/official", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ tricks: [] } satisfies OfficialTricksReply) }));
  await page.route("**/api/tricks/lodge/kettle/remove", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (answer.status === 200) removed = true;
    await route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  return { bodies };
}

for (const size of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test.describe(`at ${String(size.width)} x ${String(size.height)}`, () => {
    test.use({ viewport: size });

    test("Remove trick asks once, starts on Cancel, and a yes leaves for the list without it", async ({ page }) => {
      const { bodies } = await stub(page, { status: 200, body: { rid: "x", code: "removed", id: "kettle" } });
      await page.goto("/settings/tricks");
      // The live region is mounted before anything is said, so its first words are heard.
      await expect(page.locator('[data-slot="status-live"]')).toHaveCount(1);
      await page.getByRole("link", { name: "About Kettle Watch" }).click();
      await expect(page).toHaveURL(/\/settings\/tricks\/lodge%3Akettle$/);
      const section = page.locator('[data-section="remove"]');
      await section.scrollIntoViewIfNeeded();
      await expect(section).toContainText("Delete this trick from this machine.");
      const open = section.getByRole("button", { name: "Remove trick" });
      const box = (await open.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      await open.click();
      const dialog = page.getByRole("dialog", { name: "Remove Kettle Watch?" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(bodies).toEqual([]);
      await open.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Remove trick" }).click();
      await expect(page).toHaveURL(/\/settings\/tricks$/);
      // "Removed Kettle Watch." goes to the status line (lib/status.ts); Settings draws none, so a screen reader hears it
      // from the layout's live region, which shows nothing. The trick leaving the list is the visible sign.
      const live = page.locator('[data-slot="status-live"]');
      await expect(live).toHaveAttribute("aria-live", "polite");
      await expect(live).toHaveText("Removed Kettle Watch.");
      await expect(page.getByRole("link", { name: "About Kettle Watch" })).toHaveCount(0);
      expect(bodies).toEqual([{ rid: expect.stringMatching(/^[0-9a-f-]{36}$/u) }]);
      // Back does not return to the page of the trick that is gone.
      await page.goBack();
      await expect(page).not.toHaveURL(/lodge%3Akettle/);
    });

    test("a run still going is refused: the page stays and the row says why", async ({ page }) => {
      await stub(page, { status: 409, body: { error: "running", message: "A run of this trick is still going. Try again in a few seconds.", rid: "x" } });
      await page.goto("/settings/tricks/lodge%3Akettle");
      const section = page.locator('[data-section="remove"]');
      await section.scrollIntoViewIfNeeded();
      await section.getByRole("button", { name: "Remove trick" }).click();
      await page.getByRole("dialog", { name: "Remove Kettle Watch?" }).getByRole("button", { name: "Remove trick" }).click();
      await expect(section).toContainText("A run of this trick is still going. Try again in a few seconds.");
      await expect(page).toHaveURL(/\/settings\/tricks\/lodge%3Akettle$/);
    });
  });
}
