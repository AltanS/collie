import { expect, test } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";
import type { SnapshotResponse, UpdateInfo, UpdatePeerLeg, UpdateRun } from "@/lib/types";

import { installApiStub } from "./fixtures/api";

// ── THE REPORTED BUG: a real phone, not jsdom ─────────────────────────────────────────────────────
//
// A screenshot off Altan's own phone showed the peer-failed band cut at the screen edge mid-word
// ("...no change for 20 minutes. See U"), with NO ellipsis — so `truncate` (ui/notice.tsx) was not
// in effect there at all. jsdom (`components/update-ribbon.test.tsx`) cannot show this: it never
// lays anything out, so a box that grew wider than the viewport reads exactly the same as one that
// didn't.
//
// THE CAUSE WAS ONE LEVEL UP FROM THE TRUNCATING SPAN: `ui/one-of.tsx`, the stacking primitive the
// band above the header shares with the composer's status slot. Its `[grid-area:1/1]` layers had
// no `min-w-0`, so the grid's single `auto` column sized itself to the widest layer's min-content
// width — which, for a `white-space: nowrap` run (what `truncate` sets), is the whole unbroken
// sentence, since nowrap forbids the line break that would otherwise give it a smaller one.
// Measured on this exact fixture at 375px before the fix: the column computed to 497px, the strip
// laid out at that width, and only the `overflow-hidden` ancestor two levels up
// (`ui/collapse.tsx`'s inner wrapper) clipped the excess — hard, past the ellipsis the strip's own
// `truncate` span never got a chance to draw, because the span was never forced narrower than its
// content in the first place. The fix is `min-w-0` on `ui/one-of.tsx`'s per-layer div.
test.use({ serviceWorkers: "block" });

/** 375x812 — the size the report was reproduced at. */
const IPHONE = { width: 375, height: 812 };

const PEER_REASON = "no change for 20 minutes";

const run: UpdateRun = {
  schema: 1,
  state: "done",
  from: "1.11.0",
  to: "1.12.0",
  startedAt: Date.now() - 40_000,
  updatedAt: Date.now() - 2_000,
  pid: 99,
  attempt: 0,
};

const peers: UpdatePeerLeg[] = [{ name: "minibuch", state: "unreachable", reason: PEER_REASON }];

const update: UpdateInfo = {
  current: "1.11.0",
  latest: "1.12.0",
  latestUrl: null,
  releaseAvailable: true,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: Date.now() - 60_000,
  run: { ...run, peers },
};

const snapshot: SnapshotResponse = { ...fixtureSnapshot, update };

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(IPHONE);
  await installApiStub(page);
  // Registered AFTER installApiStub, so Playwright checks it first (see fixtures/api.ts's own
  // header) — the one route this case answers differently from the default fixture world.
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
});

test("the peer-failed band stays inside a 375px phone, truncated, and the whole row navigates", async ({
  page,
}) => {
  await page.goto("/");

  const full = `Could not update minibuch: ${PEER_REASON}. See Updates.`;
  // The whole-surface overlay button `ui/notice.tsx` renders for this state (see
  // `components/update-ribbon.tsx`) — its accessible name is the row's full, untruncated copy.
  const band = page.getByRole("button", { name: full });
  await expect(band).toBeVisible();

  // 1. THE BAND'S OWN RIGHT EDGE NEVER PASSES THE VIEWPORT'S. This is the assertion a real engine
  // is needed for: jsdom has no boxes to measure. (The overlay's own box legitimately reaches a
  // few px above/below the visible strip — that is its 44px tap-floor reach, `-inset-y-[5.5px]` in
  // `ui/notice.tsx` — so only its horizontal edge is the fact this case is about.)
  const [bandBox, viewport] = await Promise.all([band.boundingBox(), page.viewportSize()]);
  expect(bandBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bandBox!.x + bandBox!.width).toBeLessThanOrEqual(viewport!.width + 0.5);

  // Nothing on the page may be wider than the viewport either — the failure mode was the BAND'S
  // ancestor chain (`ui/one-of.tsx`'s grid) growing past 375px, not just the band itself.
  const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(docWidth).toBeLessThanOrEqual(viewport!.width + 1);

  // 2. THE TEXT ELEMENT IS ACTUALLY TRUNCATING — overflowing its own box, clipped by an ellipsis —
  // rather than merely fitting because something upstream grew to accommodate it.
  const textBox = page.getByText(full);
  const metrics = await textBox.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    textOverflow: getComputedStyle(el).textOverflow,
    whiteSpace: getComputedStyle(el).whiteSpace,
    overflowX: getComputedStyle(el).overflowX,
  }));
  expect(metrics.textOverflow).toBe("ellipsis");
  expect(metrics.whiteSpace).toBe("nowrap");
  expect(metrics.overflowX).toBe("hidden");
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

  await page.screenshot({ path: "/tmp/band-375.png" });

  // 3. A CLICK ON THE BAND NAVIGATES to the page "See Updates" refers to.
  await band.click();
  await expect(page).toHaveURL(/\/settings\/updates$/);
});
