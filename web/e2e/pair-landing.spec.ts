import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// ── The QR `collie pair` prints still lands on the pairing form ─────────────────────────────────
//
// `cli/pairing.ts` prints a QR for `/settings?pair=<code>`. Settings became an index of four
// sections, and the Paired-devices card moved to System, so a scan that stopped at the index found
// no form and dropped the code. The index now forwards a `pair` query to System (`src/router.tsx`,
// `pairLandingPath` in `src/lib/nav.ts`).
//
// THE TARGET IS `app`: a redirect is a router fact, and the playground mounts a `MemoryRouter`
// with no browser history to check (the same reason `e2e/m24-crew.spec.ts` gives for `/pack`).

// NO SERVICE WORKER, for the reason `e2e/issue-180.spec.ts` states: `page.route` cannot see a
// request the worker makes on the page's behalf.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("states"),
    "these cases drive the app bundle, not the playground",
  );
  await installApiStub(page);
});

test("a scanned pairing link lands on System with the code filled in", async ({ page }) => {
  await page.goto("/settings?pair=ABCD2345");

  await expect(page).toHaveURL(/\/settings\/system/);
  await expect(page.getByLabel(en["settings.devices.pair.codeLabel"])).toHaveValue("ABCD2345");
  await expect(page.getByLabel(en["settings.devices.pair.nameLabel"])).toBeFocused();
});

test("the forward leaves no history entry, so Back does not return to the index", async ({ page }) => {
  await page.goto("/");
  await page.goto("/settings?pair=ABCD2345");
  await expect(page).toHaveURL(/\/settings\/system/);

  // `replace`, not a push: Back to the index would forward to System again, forever.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("Settings without a code stays the index", async ({ page }) => {
  await page.goto("/settings");

  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("button", { name: new RegExp(en["settings.section.system.title"]) })).toBeVisible();
});
