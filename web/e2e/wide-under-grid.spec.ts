import { expect, test, type Locator, type Page } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { wideSnapshot } from "./fixtures/wide-herd";

// THE PARTS UNDER THE GRID, CENTRED (ADR 0158, addendum 2026-11-23). On the large screen's Dashboard the stack under
// the grid of Spaces (Launch, the Spaces navigator, Programs, the Tricks Space, then the crew line, the update line
// and the build stamp) is one column of one Space's width, centred in the window on one centre line. The grid keeps
// its place: its boxes are the numbers the build before this change measured, same herd, same windows.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
  await installApiStub(page);
});

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  const snapshot = wideSnapshot({ spaces: 5, crew: true, blocked: ["w2:p1"], unseen: ["w4:p2"] });
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.goto("/");
  await expect(page.locator("[data-space]")).toHaveCount(5);
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** The grid's boxes as the build before the change drew them: x and width, in CSS px. */
const GRID_BEFORE = {
  1440: { rows: { x: 120, width: 1200 }, firstSpace: { x: 120, width: 384 }, band: { x: 120, width: 1200 }, command: { x: 96, width: 1248 } },
  2560: { rows: { x: 68, width: 2424 }, firstSpace: { x: 68, width: 384 }, band: { x: 68, width: 2424 }, command: { x: 44, width: 2472 } },
} as const;

for (const [width, height] of [
  [1440, 858],
  [2560, 1300],
] as const) {
  test(`at ${width} x ${height} the stack under the grid is one centred column and the grid has not moved`, async ({ page }) => {
    await open(page, width, height);

    const stack = [
      ...(await page.locator('[data-slot="wide-under-grid"]').all()),
      page.locator('[data-slot="wide-foot"]'),
      page.getByText(/^vp \d/),
    ];
    // Launch and Spaces, the foot lines and the stamp are all there to measure.
    expect(stack.length).toBeGreaterThanOrEqual(3);
    await page.getByText(/^vp \d/).scrollIntoViewIfNeeded();
    const boxes = await Promise.all(stack.map(box));
    const columns = boxes.slice(0, -2);
    for (const b of boxes) {
      // Equal gaps to the window's two edges, within 1px.
      expect(Math.abs(b.x - (width - (b.x + b.width)))).toBeLessThanOrEqual(1);
    }
    // One column: the wrappers share one x and one width, one Space wide.
    for (const b of columns) {
      expect(b.width).toBe(384);
      expect(Math.abs(b.x - columns[0]!.x)).toBeLessThanOrEqual(1);
    }

    const want = GRID_BEFORE[width];
    const rows = await box(page.locator('[data-slot="wide-rows"]').first());
    const first = await box(page.locator("[data-space]").first());
    const band = await box(page.locator('[data-slot="wide-waiting"]'));
    const command = await box(page.locator('[data-slot="wide-command-row"]'));
    expect({ x: rows.x, width: rows.width }).toEqual(want.rows);
    expect({ x: first.x, width: first.width }).toEqual(want.firstSpace);
    expect({ x: band.x, width: band.width }).toEqual(want.band);
    expect({ x: command.x, width: command.width }).toEqual(want.command);
    // A review shot of the stack, only when a folder is named: `SHOTS_DIR=<folder>`.
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/after-${width}.png` });
  });
}

test("at 390 x 844 the dashboard is the phone's column, as before", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(wideSnapshot({ spaces: 5, crew: true })) }),
  );
  await page.goto("/");
  await expect(page.locator("[data-space]")).toHaveCount(0);
  await expect(page.locator('[data-slot="wide-under-grid"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="wide-foot"]')).toHaveCount(0);
  const filter = await box(page.getByPlaceholder("Filter spaces…"));
  // The numbers the build before this change drew at 390px.
  expect(filter.x).toBe(55);
  expect(filter.width).toBe(304);
});
