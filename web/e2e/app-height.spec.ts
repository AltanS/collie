import { expect, test } from "@playwright/test";

import { installApiStub } from "./fixtures/api";

// THE iOS HOME-SCREEN HEIGHT TOKEN, resolved by the engine (index.css, `--app-h-ios-standalone`).
// Playwright cannot emulate a home-screen launch or a safe-area inset, so this cannot show the
// iPhone case of #394 itself. What it does prove, in WebKit and Chromium alike: the engine accepts
// `min(100lvh, calc(100dvh + env(...)))`, and with no inset it resolves to the visible height, so
// the token can never make a browser tab or a correct WebKit taller than its viewport.

// NO SERVICE WORKER: `page.route` cannot see a request the worker makes for the page, so a worker
// that claims the page part way through takes `/api/*` away from the stub (see composer-clear.spec.ts).
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
});

test("the home-screen height token resolves to the viewport height", async ({ page }) => {
  await page.goto("/");
  const measured = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;top:0;width:1px;height:var(--app-h-ios-standalone)";
    document.body.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return { height, innerHeight: window.innerHeight };
  });
  expect(measured.height).toBeGreaterThan(0);
  expect(Math.abs(measured.height - measured.innerHeight)).toBeLessThanOrEqual(1);
});

test("the composer's belt ends inside the viewport", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  const belt = page.locator('[data-slot="composer-actions"]');
  await expect(belt).toBeVisible();
  const box = await belt.boundingBox();
  if (box === null) throw new Error("no box: the belt is not rendered");
  const innerHeight = await page.evaluate(() => window.innerHeight);
  expect(box.y + box.height).toBeLessThanOrEqual(innerHeight);
});
