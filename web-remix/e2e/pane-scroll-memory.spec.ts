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

/** The stub's herd: all `ROWS` panes, or (late-content test) only the few around the one the test opens. */
interface Herd {
  short: boolean;
}

/** The pane the late-content test opens, and the few panes the short herd keeps (the opened one included). */
const OPENED = 20;
const SHORT = [OPENED - 2, OPENED - 1, OPENED, OPENED + 1, OPENED + 2];

async function stubTallHerd(page: Page, herd: Herd = { short: false }): Promise<void> {
  const base = PANE_SNAPSHOT.agents[0]!;
  const all = Array.from({ length: ROWS }, (_, i) => ({ ...base, paneId: `w1:p${String(100 + i)}`, paneLabel: `agent ${String(i)}`, status: "idle" as const }));
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== "GET") return route.fulfill({ status: 405, json: { error: "read-only stub" } });
    if (url.pathname === "/api/snapshot") {
      const agents = herd.short ? SHORT.map((i) => all[i]!) : all;
      return route.fulfill({ json: { ...PANE_SNAPSHOT, ts: Date.now(), agents } });
    }
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

// LATE CONTENT (lib/scroll-restore.ts, ACTION-PLAN D.6): back onto a dashboard the store has shrunk
// to a few rows. The saved spot (600) is out of reach, so the scroller sits at its own end and KEEPS the
// spot; when the 40 rows return, the restore lands on 600 without a touch. A wheel before the rows
// return takes the scroller over: nothing is restored.

const rows = (page: Page) => page.locator('button[id^="pane-row-"]');

/** One poll now, as the page coming back to the foreground does. */
async function pollNow(page: Page): Promise<void> {
  const answered = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/snapshot");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await answered;
}

/** Scroll to 600, open a pane, shrink the herd while away, come back onto the short list. */
async function leaveAndReturnShort(page: Page, herd: Herd): Promise<void> {
  await stubTallHerd(page, herd);
  await page.goto("/");
  await expect(rows(page)).toHaveCount(ROWS);
  await page.getByTestId("home-scroller").evaluate((n) => {
    n.scrollTop = 600;
  });
  await expect.poll(() => homeTop(page)).toBe(600);
  await rows(page).nth(OPENED).click();
  await expect(page.getByTestId("pane-view")).toBeVisible();
  herd.short = true;
  await pollNow(page);
  await page.goBack();
  await expect(rows(page)).toHaveCount(SHORT.length);
  // The write clamped to the short list's own end; the spot (600) is out of reach.
  expect(await homeTop(page)).toBeLessThan(200);
}

test("a spot the short dashboard cannot reach yet is kept and lands when the rows return", async ({ page }) => {
  const herd: Herd = { short: false };
  await leaveAndReturnShort(page, herd);
  await page.waitForTimeout(300); // still short, nothing forced
  expect(await homeTop(page)).toBeLessThan(200);
  herd.short = false;
  await pollNow(page);
  await expect(rows(page)).toHaveCount(ROWS);
  await expect.poll(() => homeTop(page)).toBe(600);
});

test("the reader's wheel before the rows return cancels the restore", async ({ page }) => {
  const herd: Herd = { short: false };
  await leaveAndReturnShort(page, herd);
  await page.getByTestId("home-scroller").hover();
  await page.mouse.wheel(0, 5);
  herd.short = false;
  await pollNow(page);
  await expect(rows(page)).toHaveCount(ROWS);
  await page.waitForTimeout(600);
  expect(await homeTop(page)).toBeLessThan(200);
});
