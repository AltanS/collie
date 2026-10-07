import { expect, test } from "@playwright/test";

import { PANES, stubPaneBridge } from "./pane-api";

// S3, islands and soft navigation (`experiments/remix-v3/ACTION-PLAN.md` B; REMIX3.md "Islands and soft
// navigation"). This file holds the browser checks of the islands document; the glide's two guards from
// research note 12 come first, because they hold for the static shell too.

test.use({ serviceWorkers: "block" });

const PANE_ROW = `[data-testid="pane-row"][data-pane-id="${PANES.plain}"]`;
const PANE_URL = new RegExp(`/pane/${encodeURIComponent(PANES.plain)}$`, "u");

declare global {
  interface Window {
    __collieGlideSkips?: { ua: number };
    __vtCount?: { started: number; skipped: number };
    __sameDocument?: boolean;
  }
}

test.describe("the glide's Navigation API guards (research note 12)", () => {
  test("without NavigateEvent.sourceElement there is no glide, and a row tap is a document load", async ({ page }) => {
    await page.addInitScript(() => {
      // The fake: a browser with view transitions but without the part of the Navigation API the
      // runtime's navigate() needs (Chrome 123 to 134, iOS 26.1 and older).
      Reflect.deleteProperty(NavigateEvent.prototype, "sourceElement");
      const start = document.startViewTransition;
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value(this: Document, ...args: Parameters<Document["startViewTransition"]>): ViewTransition {
          sessionStorage.setItem("vt-started", String(Number(sessionStorage.getItem("vt-started") ?? "0") + 1));
          return start.apply(this, args);
        },
      });
    });
    await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
    await page.goto("/");
    await expect(page.locator(PANE_ROW)).toBeVisible();
    expect(await page.evaluate(() => "sourceElement" in NavigateEvent.prototype)).toBe(false);
    await page.evaluate(() => (window.__sameDocument = true));
    await page.locator(PANE_ROW).click();
    await expect(page).toHaveURL(PANE_URL);
    await expect(page.getByTestId("pane-title")).toBeVisible();
    // A new document (the marker is gone), and no view transition was ever started for the move.
    expect(await page.evaluate(() => window.__sameDocument ?? false)).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem("vt-started"))).toBeNull();
  });

  test("a traverse the browser animates itself (hasUAVisualTransition) skips the back glide", async ({ page }) => {
    await page.addInitScript(() => {
      // The fake: every traverse says the browser already animated it, as Safari's swipe back does.
      Object.defineProperty(NavigateEvent.prototype, "hasUAVisualTransition", {
        configurable: true,
        get(this: NavigateEvent) {
          return this.navigationType === "traverse";
        },
      });
      const vt = { started: 0, skipped: 0 };
      window.__vtCount = vt;
      const start = document.startViewTransition;
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value(this: Document, ...args: Parameters<Document["startViewTransition"]>): ViewTransition {
          vt.started++;
          const transition = start.apply(this, args);
          const skip = transition.skipTransition.bind(transition);
          transition.skipTransition = () => {
            vt.skipped++;
            skip();
          };
          return transition;
        },
      });
    });
    await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
    await page.goto("/");
    await page.locator(PANE_ROW).click();
    await expect(page.getByTestId("pane-title")).toBeVisible();
    await page.waitForTimeout(800);
    const before = await page.evaluate(() => ({ ...(window.__vtCount ?? { started: 0, skipped: 0 }), ua: window.__collieGlideSkips?.ua ?? 0 }));
    // The in-app back arrow glides back with history.back(), a traverse.
    await page.getByTestId("header-home").click();
    await expect(page.locator(PANE_ROW)).toBeVisible();
    await expect(page).toHaveURL(/\/$/u);
    const after = await page.evaluate(() => ({ ...(window.__vtCount ?? { started: 0, skipped: 0 }), ua: window.__collieGlideSkips?.ua ?? 0 }));
    expect(after.ua).toBe(before.ua + 1);
    // The arrow started a glide, and it was skipped the moment the traverse said it was animated.
    expect(after.started - before.started).toBe(1);
    expect(after.skipped - before.skipped).toBe(after.started - before.started);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("glide"))).toBe(false);
  });
});
