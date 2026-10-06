import { expect, test, type Page } from "@playwright/test";

import { en } from "@web/lib/i18n/messages/en";
import type { SnapshotResponse } from "@web/lib/types";

import { installRoutesApi, SNAPSHOT } from "./routes-api";
import { FRESH_DEVICE } from "./tour-seen";

// The first-run screen (src/tour/): a shell-level overlay, opened once from the Shell on a fresh device
// (web's `collie:tour:v1`, marked seen when it OPENS), dismissed by Skip, Escape, the backdrop or a footer
// door, and opened again by the Settings "Show the first screen again" row. The configs start every
// context with the tour already seen (tour-seen.ts); a case about the tour asks for a fresh one.

test.use({ serviceWorkers: "block" });

const KEY = "collie:tour:v1";
const stored = (page: Page): Promise<string | null> => page.evaluate((k) => localStorage.getItem(k), KEY);
const dialog = (page: Page) => page.getByRole("dialog", { name: en["tour.title"] });

const BLOCKED: SnapshotResponse = {
  ...SNAPSHOT,
  agents: SNAPSHOT.agents.map((a) => (a.paneId === "w1:p1" ? { ...a, status: "blocked" } : a)),
};

test.describe("a fresh device", () => {
  test.use({ storageState: FRESH_DEVICE });

  test("opens over the dashboard, states this install, and is marked seen on open", async ({ page }) => {
    await installRoutesApi(page);
    await page.goto("/");
    const tour = dialog(page);
    await expect(tour).toBeVisible();
    await expect(tour.getByRole("heading", { name: en["tour.title"] })).toBeVisible();
    await expect(tour.getByText(en["tour.setup"])).toBeVisible();
    await expect(tour.getByText("2 panes")).toBeVisible();
    await expect(tour.getByText(en["tour.setup.canType"])).toBeVisible();
    for (const key of ["tour.can.mirror", "tour.can.answer", "tour.can.type", "tour.can.harness", "tour.can.session", "tour.can.crew"] as const) {
      await expect(tour.getByText(en[key])).toBeVisible();
    }
    await expect(tour.getByTestId("tour-done")).toHaveText(en["tour.done.dashboard"]);
    // Marked seen the moment it opened, never on close.
    expect(await stored(page)).toBe("2");
  });

  test("Skip dismisses it, and it does not come back on a reload", async ({ page }) => {
    await installRoutesApi(page);
    await page.goto("/");
    await expect(dialog(page)).toBeVisible();
    await page.getByTestId("tour-skip").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/");
    await page.reload();
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
  });

  test("Escape dismisses it", async ({ page }) => {
    await installRoutesApi(page);
    await page.goto("/");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  });

  test("Tab stays inside the dialog", async ({ page }) => {
    await installRoutesApi(page);
    await page.goto("/");
    await expect(dialog(page)).toBeVisible();
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest("[role='dialog']") !== null)).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("[role='dialog']") !== null)).toBe(true);
  });

  test("a blocked pane turns the footer into the way to it", async ({ page }) => {
    await installRoutesApi(page, [
      (ctx) => (ctx.method === "GET" && ctx.url.pathname === "/api/snapshot" ? ctx.json(200, BLOCKED).then(() => true) : false),
    ]);
    await page.goto("/");
    const tour = dialog(page);
    await expect(tour.getByText(`${"2 panes"}, ${"1 needs you"}`)).toBeVisible();
    await tour.getByTestId("tour-done").click();
    await expect(page).toHaveURL(/\/pane\/w1%3Ap1$/u);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("a read-only device is told so, and the first card is the repair", async ({ page }) => {
    await installRoutesApi(page, [
      (ctx) =>
        ctx.method === "GET" && ctx.url.pathname === "/api/snapshot"
          ? ctx.json(200, { ...SNAPSHOT, device: { enforced: true, device: "d1", authorized: false } }).then(() => true)
          : false,
    ]);
    await page.goto("/");
    const tour = dialog(page);
    await expect(tour.getByText(en["tour.setup.readOnly"])).toBeVisible();
    await expect(tour.getByTestId("tour-card-pair")).toBeVisible();
  });
});

test("a device that has seen it is not shown it", async ({ page }) => {
  await installRoutesApi(page);
  await page.goto("/");
  await expect(page.getByTestId("home")).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(await stored(page)).toBe("2");
});

test("the Settings row writes 0 and opens it again over the dashboard", async ({ page }) => {
  await installRoutesApi(page);
  await page.goto("/settings/device");
  await expect(page.getByTestId("tour-card")).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByTestId("tour-card").getByRole("button", { name: en["settings.tour.button"] }).click();
  await expect(dialog(page)).toBeVisible();
  // Over the dashboard it describes, and marked seen again on open.
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  expect(await stored(page)).toBe("2");
  await page.getByTestId("tour-skip").click();
  await expect(dialog(page)).toHaveCount(0);
});
