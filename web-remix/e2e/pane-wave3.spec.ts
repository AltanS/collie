import { expect, test, type Page } from "@playwright/test";

import { capture, PANES, stubPaneBridge, TERMINAL_TEXT, UPLOAD_PATH } from "./pane-api";

// Wave 3 of the pane screen against the stub bridge: the header claim, the strips, the belt, the
// composer's send flow and attachments, the Keys tray queue, the wizard and multi-select cards, the
// chat gate and the auto-exit (ADR 0067).

const path = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;

async function useTerminal(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
}

test("the header claims the pane's identity and the ⋮ opens the actions sheet", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto(path(PANES.chat));

  const identity = page.locator('[data-slot="pane-identity"]');
  await expect(identity.getByTestId("pane-title")).toHaveText("fix flaky test");
  await expect(identity.getByTestId("pane-place")).toHaveText("collie");
  await expect(identity.locator('[data-glide="tile"] svg').first()).toBeVisible();
  await expect(identity.locator('[data-glide="dot"]')).toBeVisible();

  await page.getByTestId("header-menu").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Pin to top");
  await expect(sheet).toContainText("Terminal view");
  // No tab bar and no in-route header any more.
  await expect(page.locator('[role="tablist"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the strips fold to the summary and back, and the mirror returns to the same place", async ({ page }) => {
  await useTerminal(page);
  await stubPaneBridge(page, { [PANES.walk]: TERMINAL_TEXT });
  await page.goto(path(PANES.walk));

  const strips = page.locator('[data-slot="strips"]');
  await expect(strips).toBeVisible();
  const body = page.getByTestId("pane-scroller");
  await expect(page.getByTestId("pane-text")).toBeVisible();
  await page.waitForTimeout(600);
  const before = await body.boundingBox();

  await page.getByTestId("strips-fold").click();
  await expect(page.getByTestId("strips-summary")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("collie:strips-collapsed:v1"))).toBe("1");
  await page.waitForTimeout(500);
  const folded = await body.boundingBox();
  expect(folded!.y).toBeLessThan(before!.y);

  await page.getByTestId("strips-summary").click();
  await expect(page.getByTestId("strips-fold")).toBeVisible();
  await page.waitForTimeout(500);
  const after = await body.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
});

test("the belt scrolls sideways, and a vertical drag on it opens the pane switcher", async ({ page }) => {
  await useTerminal(page);
  await stubPaneBridge(page, { [PANES.walk]: TERMINAL_TEXT });
  await page.goto(path(PANES.walk));

  const belt = page.locator('[data-slot="actions-belt"]');
  await expect(belt).toBeVisible();
  const scroller = belt.locator("[data-belt-scroller], .overflow-x-auto").first();
  const width = await scroller.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  if (width.scroll > width.client) {
    await scroller.evaluate((el) => el.scrollBy({ left: 80 }));
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  }

  const box = await belt.boundingBox();
  const x = box!.x + box!.width / 3;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x, y - i * 20);
  await page.mouse.up();
  await expect(page.getByTestId("pane-switcher")).toBeVisible();
  await expect(page.getByTestId("switcher-row").first()).toBeVisible();
});

test("a send shows the check, holds the words in the Sent strip and says Sent", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto(path(PANES.plain));

  const box = page.locator('[data-slot="chat-input"]');
  await box.fill("run the tests");
  await page.getByTestId("composer-send").click();
  await expect.poll(() => stub.writes.filter((w) => w.path === "reply").length).toBe(1);
  await expect(page.getByTestId("composer-send")).toHaveAttribute("data-sent", "");
  await expect(page.getByTestId("sent-preview")).toContainText("run the tests");
  await expect(page.locator("header")).toContainText("Sent");
  await expect(box).toHaveValue("");
  // The draft store holds nothing for this pane after a verified send.
  await page.reload();
  await expect(page.locator('[data-slot="chat-input"]')).toHaveValue("");
});

test("an attached photo uploads and drops its marker into the draft", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.plain]: "ready\n> " }, { stt: true });
  await page.goto(path(PANES.plain));

  const box = page.locator('[data-slot="chat-input"]');
  await box.fill("look at");
  await page.getByTestId("attach-photos").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) });
  await expect.poll(() => stub.writes.filter((w) => w.path === "upload").length).toBe(1);
  await expect(box).toHaveValue(/look at \[Image #1\]/u);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);

  await page.getByTestId("composer-send").click();
  await expect.poll(() => stub.writes.find((w) => w.path === "reply")?.body.text).toBe(`look at ${UPLOAD_PATH}`);
});

test("with STT on, an empty box offers the microphone as its primary action", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " }, { stt: true });
  await page.goto(path(PANES.plain));
  await expect(page.getByTestId("composer-mic")).toBeVisible();
  await page.locator('[data-slot="chat-input"]').fill("x");
  await expect(page.getByTestId("composer-send")).toBeVisible();
});

test("the Keys tray stages a chord and sends the queue as one call", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto(path(PANES.plain));
  await page.getByTestId("belt-pill-keys").click();
  const tray = page.getByTestId("keys-tray");
  await tray.getByTestId("key-mod-ctrl").click();
  await tray.getByTestId("key-mod-ctrl").click();
  await tray.locator('[data-testid^="key-"]:not([data-testid^="key-mod"]):not([data-testid^="key-queue"])').first().click();
  await tray.locator('[data-testid^="key-"]:not([data-testid^="key-mod"]):not([data-testid^="key-queue"])').nth(1).click();
  await expect(tray.getByTestId("key-queue")).toBeVisible();
  expect(stub.writes).toHaveLength(0);
  await tray.getByTestId("key-queue-send").click();
  await expect.poll(() => stub.writes.length).toBe(1);
  expect(stub.writes[0]!.path).toBe("keys");
  expect(stub.writes[0]!.body.keys!.length).toBe(2);
});

test("a wizard card tap posts the verified key", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.wizard]: capture("claude--wizard-q1.txt") });
  stub.onWrite(() => stub.setScreen(PANES.wizard, capture("claude--wizard-q2.txt")));
  await page.goto(path(PANES.wizard));
  const card = page.locator('[data-slot="dialog-card"]');
  await expect(card).toBeVisible();
  await card.getByTestId("dialog-option").filter({ hasText: "UI" }).first().click();
  await expect.poll(() => stub.writes.map((w) => w.body.keys)).toContainEqual(["2"]);
  expect(stub.writes.every((w) => w.path === "keys")).toBe(true);
});

test("a multi-select card tap toggles with one key", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.multi]: capture("claude--select-multiselect-single.txt") });
  await page.goto(path(PANES.multi));
  const card = page.locator('[data-slot="dialog-card"]');
  await card.getByTestId("multi-option").filter({ hasText: "Mushrooms" }).click();
  await expect.poll(() => stub.writes.map((w) => w.body.keys)).toEqual([["2"]]);
});

test("the chat gate draws the Terminal for a session whose log is missing", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.noLog]: TERMINAL_TEXT });
  await page.goto(path(PANES.noLog));
  await expect(page.getByTestId("pane-text")).toContainText("12 tests passed");
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-body", "terminal");
  await expect(page.getByTestId("chat-stream")).toHaveCount(0);
});

test("a pane closed elsewhere says so and goes up once", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.closing]: "ready\n> " });
  await page.goto(path(PANES.closing));
  await expect(page.getByTestId("pane-title")).toBeVisible();
  const seen = stub.snapshots();
  stub.closePane(PANES.closing);
  await expect.poll(() => stub.snapshots(), { timeout: 15_000 }).toBeGreaterThan(seen);
  await expect(page).toHaveURL(/\/$/u, { timeout: 15_000 });
  await expect(page.locator("body")).toContainText("Pane closed");
});
