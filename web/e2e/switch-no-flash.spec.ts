import { expect, test, type Page, type Route } from "@playwright/test";

import { fixtureAgents, fixtureKiroChat, fixtureKiroSnapshot } from "@/test/handlers";

import { installApiStub, installPaneWorld, paneCapture } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// A SWITCH BETWEEN SESSIONS HAS NO EMPTY FRAME (operator, 2026-11-18: "when I switch session there are some
// white frames"). `DetailRoute` keys the pane screen by pane, so a switch builds the Chat body again, and its
// window used to start empty: from the first commit of the new pane until the Chat read came back, the reading
// area drew the page ground and nothing else (a near-white box in the light theme), 2 frames on a LAN and a dozen
// on a tailnet. Now the router keeps the old pane up until the new pane's first page of Chat is in hand
// (`lib/loaders.ts` warmChat), the Chat body starts from it (`lib/chat-held.ts`), and a page that is slower than
// the loader will wait for shows muted bars after 150 ms (`components/chat-pending.tsx`).
//
// The case samples the reading area on EVERY animation frame from the tap until the new pane's thread is up, and
// fails on any frame that has no thread block in it, and on any frame whose page ground is not the theme's own.

test.use({ serviceWorkers: "block" });

const FIRST = "w1:p1";
const SECOND = "w1:p2";

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "a phone-width case");
  await keepPhoneLayout(page);
});

/** Two Kiro panes in one tab, both with the same journal; the second answers after `delayMs`. */
async function twoPanes(page: Page, delayMs: number): Promise<void> {
  await installApiStub(page);
  const second = { ...fixtureAgents[0]!, paneId: SECOND, agent: "kiro", hasSession: true };
  const snapshot = { ...fixtureKiroSnapshot, agents: [...fixtureKiroSnapshot.agents, second] };
  const screen = paneCapture("kiro--v3-idle-w120");
  await installPaneWorld(page, { paneId: FIRST, snapshot, chat: fixtureKiroChat, screens: { idle: screen }, start: "idle" });
  const slow = async (body: string, route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ contentType: "application/json", body });
  };
  const paneRoute = (suffix: string) => (url: URL) => url.pathname === `/api/pane/${encodeURIComponent(SECOND)}${suffix}`;
  await page.route(paneRoute("/chat"), (route) => slow(JSON.stringify({ ...fixtureKiroChat, paneId: SECOND }), route));
  await page.route(paneRoute(""), (route) => slow(JSON.stringify({ paneId: SECOND, text: screen, truncated: false, revision: 1 }), route));
}

interface Frame {
  at: number;
  path: string;
  blocks: number;
  pending: number;
  ground: string;
}

/**
 * Sample the reading area on every animation frame for `ms`. Started before the tap and awaited after it, so the
 * frames of the whole switch are in the answer.
 */
function sampleFrames(page: Page, ms: number): Promise<Frame[]> {
  return page.evaluate(
    (duration) =>
      new Promise<Frame[]>((resolve) => {
        const frames: Frame[] = [];
        const t0 = performance.now();
        const tick = () => {
          const reading = document.querySelector('[data-slot="pane-reading"]');
          frames.push({
            at: Math.round(performance.now() - t0),
            path: decodeURIComponent(location.pathname),
            blocks: reading === null ? 0 : reading.querySelectorAll("[data-block]").length,
            pending: reading === null ? 0 : reading.querySelectorAll('[data-slot="chat-pending"]').length,
            ground: getComputedStyle(document.documentElement).backgroundColor,
          });
          if (performance.now() - t0 < duration) requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test("a switch to a pane whose thread is a moment away shows no empty frame", async ({ page }) => {
      await twoPanes(page, 150);
      await page.goto(`/pane/${encodeURIComponent(FIRST)}`);
      await expect(page.locator("[data-block]").first()).toBeVisible();
      const ground = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
      const sampling = sampleFrames(page, 1100);

      await page.getByRole("button", { name: /^kiro 2$/ }).tap();
      await expect(page).toHaveURL(new RegExp(encodeURIComponent(SECOND)));

      const seen = await sampling;
      const arrived = seen.findIndex((f) => f.path.endsWith(SECOND));
      expect(arrived, "the new pane was reached").toBeGreaterThan(-1);
      // From the first frame on the new pane to the end: a thread in every frame, the theme's own ground in every frame.
      const after = seen.slice(arrived);
      expect(after.filter((f) => f.blocks === 0), "frames with no thread in the reading area").toEqual([]);
      expect(after.filter((f) => f.ground !== ground)).toEqual([]);
      expect(after.filter((f) => f.pending > 0), "a fast switch shows no pending bars").toEqual([]);
      // And the frames before it were the old pane's thread, not a gap.
      expect(seen.slice(0, arrived).filter((f) => f.blocks === 0)).toEqual([]);
    });
  });
}

test("a thread that is slower than the switch will wait for shows pending bars after 150 ms, and the thread replaces them", async ({ page }) => {
  await twoPanes(page, 1500);
  await page.goto(`/pane/${encodeURIComponent(FIRST)}`);
  await expect(page.locator("[data-block]").first()).toBeVisible();
  const sampling = sampleFrames(page, 3500);

  await page.getByRole("button", { name: /^kiro 2$/ }).tap();
  await expect(page.locator('[data-slot="chat-pending"]')).toBeVisible({ timeout: 4000 });
  await expect(page.locator("[data-block]").first()).toBeVisible({ timeout: 4000 });
  await expect(page.locator('[data-slot="chat-pending"]')).toHaveCount(0);

  const seen = await sampling;
  const arrived = seen.findIndex((f) => f.path.endsWith(SECOND));
  const bare = seen.slice(arrived).filter((f) => f.blocks === 0 && f.pending === 0);
  // Bare frames exist only before the 150 ms, a handful at 60 Hz: never a long stretch of empty box.
  expect(bare.length).toBeLessThanOrEqual(15);
});

test("the bars hold still when the reader asked for less motion", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await context.newPage();
  await keepPhoneLayout(page);
  await twoPanes(page, 1500);
  await page.goto(`/pane/${encodeURIComponent(FIRST)}`);
  await expect(page.locator("[data-block]").first()).toBeVisible();
  await page.getByRole("button", { name: /^kiro 2$/ }).tap();
  // The loading view is the pane's silhouette (rows of bars, `chat-pending.tsx`), so a bar is no longer a direct child.
  // `.count-skeleton` is the class every bar carries, and the one the reduced-motion rule holds still.
  const bar = page.locator('[data-slot="chat-pending"] .count-skeleton').first();
  await expect(bar).toBeVisible({ timeout: 4000 });
  await expect(bar).toHaveCSS("animation-name", "none");
  await context.close();
});

