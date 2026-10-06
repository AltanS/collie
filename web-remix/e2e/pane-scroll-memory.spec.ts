import { expect, test, type Page, type Route } from "@playwright/test";

import { PANE_SNAPSHOT, TERMINAL_TEXT } from "./pane-api";

// Inner scroll memory across back and forward (lib/scroll.ts), now that the restore writes only a
// stored spot that differs and every navigation passes `resetScroll: false` (lib/navigate.ts). The
// dashboard holds 40 rows so its scroller scrolls; the runtime's scroll workaround sheet must never
// appear in `document.adoptedStyleSheets` on these moves (it would on any move with the flag on).

declare global {
  interface Window {
    __adoptedMax?: number;
  }
}

const ROWS = 40;

async function stubTallHerd(page: Page): Promise<void> {
  const base = PANE_SNAPSHOT.agents[0]!;
  const agents = Array.from({ length: ROWS }, (_, i) => ({ ...base, paneId: `w1:p${String(100 + i)}`, paneLabel: `agent ${String(i)}`, status: "idle" as const }));
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== "GET") return route.fulfill({ status: 405, json: { error: "read-only stub" } });
    if (url.pathname === "/api/snapshot") return route.fulfill({ json: { ...PANE_SNAPSHOT, ts: Date.now(), agents } });
    if (url.pathname === "/api/config") return route.fulfill({ json: { push: false, vapidPublicKey: "" } });
    const pane = /^\/api\/pane\/([^/]+)$/u.exec(url.pathname);
    if (pane) return route.fulfill({ json: { paneId: decodeURIComponent(pane[1]!), text: TERMINAL_TEXT, truncated: false, revision: 1 } });
    return route.fulfill({ status: 404, json: { error: "not stubbed" } });
  });
}

/** The most adopted stylesheets seen on any frame since the last call. */
async function watchAdopted(page: Page): Promise<void> {
  await page.evaluate(() => {
    let most = document.adoptedStyleSheets.length;
    window.__adoptedMax = most;
    const loop = (): void => {
      most = Math.max(most, document.adoptedStyleSheets.length);
      window.__adoptedMax = most;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

const adoptedMax = (page: Page): Promise<number> => page.evaluate(() => window.__adoptedMax ?? 0);
const homeTop = (page: Page): Promise<number> => page.getByTestId("home-scroller").evaluate((n) => n.scrollTop);

test("the dashboard comes back where the reader left it, on back and on forward", async ({ page }) => {
  await stubTallHerd(page);
  await page.goto("/");
  await expect(page.locator('button[id^="pane-row-"]')).toHaveCount(ROWS);
  await watchAdopted(page);
  const before = await adoptedMax(page);

  const scroller = page.getByTestId("home-scroller");
  await scroller.evaluate((n) => {
    n.scrollTop = 600;
  });
  await expect.poll(() => homeTop(page)).toBe(600);

  await page.locator('button[id^="pane-row-"]').nth(20).click();
  await expect(page.getByTestId("pane-view")).toBeVisible();
  await page.goBack();
  await expect(page.locator('button[id^="pane-row-"]').first()).toBeAttached();
  await expect.poll(() => homeTop(page)).toBe(600);

  await page.goForward();
  await expect(page.getByTestId("pane-view")).toBeVisible();
  await page.goBack();
  await expect.poll(() => homeTop(page)).toBe(600);

  expect(await adoptedMax(page)).toBe(before);
});
