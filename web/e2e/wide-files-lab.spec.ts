import { mkdirSync } from "node:fs";

import { test, type Page } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { wideSnapshot } from "./fixtures/wide-herd";

// LAB (wide-files, step 1): screenshots of today and the three `?fw` proposals in every state, for the contact sheets.
// Runs only with WIDE_FILES_SHOTS set to the output folder. Removed with the lab switch.

const OUT = process.env.WIDE_FILES_SHOTS ?? "";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(OUT === "", "lab screenshots only");
  test.skip(testInfo.project.name !== "app-phone", "one project");
  await installApiStub(page);
});

/** The device's Files choice: Changes only (the list) or All files (the tree). */
async function changesOnly(page: Page, on: boolean) {
  await page.addInitScript((value) => {
    window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: value }));
  }, on);
}

const PANE = "/pane/w1%3Ap1/changes";

const STATES = {
  "tree-nothing": { path: `${PANE}/files`, arrange: (page: Page) => changesOnly(page, false) },
  "tree-file": { path: `${PANE}/files?path=src%2Fcart.ts`, arrange: (page: Page) => changesOnly(page, false) },
  "changes-diff": { path: `${PANE}?repo=.&path=src%2Froutes%2Fcheckout.tsx`, arrange: (page: Page) => changesOnly(page, true) },
  "space-changes": { path: "/space/w1/changes", arrange: (page: Page) => changesOnly(page, true) },
  "dashboard-files": {
    path: "/",
    arrange: async (page: Page) => {
      await page.addInitScript(() => {
        window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "changes" }));
      });
      const snapshot = wideSnapshot({ spaces: 3, blocked: ["w2:p1"], unseen: ["w3:p2"] });
      await page.route(
        (url) => url.pathname === "/api/snapshot",
        (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
      );
    },
  },
} satisfies Record<string, { path: string; arrange: (page: Page) => Promise<void> }>;

// `fw=0` is said too: the switch is kept for the tab, and a later visit must not inherit an earlier proposal.
const withLab = (path: string, fw: number) => `${path}${path.includes("?") ? "&" : "?"}fw=${String(fw)}`;

for (const [state, { path, arrange }] of Object.entries(STATES)) {
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
  ] as const) {
    for (const fw of [0, 1, 2, 3]) {
      test(`${state} ${String(width)} fw=${String(fw)}`, async ({ page }) => {
        mkdirSync(OUT, { recursive: true });
        await page.setViewportSize({ width, height });
        await arrange(page);
        await page.goto(withLab(path, fw));
        await page.locator('[data-slot="app-header"]').waitFor();
        // Let the reads land, the highlighter colour the diff and the collapses settle.
        await page.waitForTimeout(1800);
        await page.screenshot({ path: `${OUT}/${state}-${String(width)}-fw${String(fw)}.png` });
      });
    }
  }
}

test("a click in the tree opens the file beside it", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await changesOnly(page, false);
  for (const fw of [1, 2, 3]) {
    await page.goto(withLab(`${PANE}/files`, fw));
    await page.waitForTimeout(1200);
    if (fw !== 1) await page.getByRole("treeitem", { name: "src" }).click();
    else await page.getByRole("button", { name: /^src,/ }).click();
    await page.waitForTimeout(900);
    if (fw !== 1) await page.getByRole("treeitem", { name: "lib" }).click();
    else await page.getByRole("button", { name: /^lib,/ }).click();
    await page.waitForTimeout(900);
    if (fw !== 1) await page.locator('[data-tree-path="src/lib/cart.ts"]').click();
    else await page.getByRole("button", { name: /^cart\.ts,/ }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/click-1440-fw${String(fw)}.png` });
  }
});

test("phone 390 is unchanged under the switch", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [state, { path, arrange }] of Object.entries(STATES)) {
    if (state === "dashboard-files") continue;
    await arrange(page);
    for (const fw of [0, 3]) {
      await page.goto(withLab(path, fw));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/phone-${state}-390-fw${String(fw)}.png` });
    }
  }
});
