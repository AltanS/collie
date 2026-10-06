import { expect, test } from "@playwright/test";

import { capture, PANES, stubPaneBridge, TERMINAL_TEXT } from "./pane-api";

// The B2 pane screen against a stub bridge: Chat draws its turns, Terminal draws the mirror rows, a
// permission capture lifts into a card whose taps POST the keys the harness module chose (a direct
// digit, and opencode's walk-verify-commit), the composer POSTs a reply, and a refused read shows the
// pairing notice.

const path = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;

test("Chat renders the session's turns and Terminal renders the mirror rows", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto(path(PANES.chat));

  await expect(page.getByTestId("pane-title")).toHaveText("fix flaky test");
  const stream = page.getByTestId("chat-stream");
  await expect(stream).toContainText("Fix the flaky poll test");
  await expect(stream.locator("strong")).toHaveText("the poll test");
  await expect(stream.locator('[data-slot="tool-card"][data-kind="execute"]')).toContainText("bun test web/poll.test.ts");
  await expect(stream).toContainText("Fixed: the test now waits for the poll.");

  // The view is the device pref `paneView` in collie:dash-prefs:v1 (ADR 0082), not a tab bar.
  await page.evaluate(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
  await page.reload();
  const screen = page.getByTestId("pane-text");
  await expect(screen).toContainText("✓ 12 tests passed");
  await expect(screen).toContainText("Done in 3.1s");
  await expect(screen.locator("[data-rows] > div, :scope > div")).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("a permission capture shows the card, and a tap POSTs the option's digit", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.permission]: capture("claude--permission-bash.txt") });
  stub.onWrite(() => stub.setScreen(PANES.permission, TERMINAL_TEXT));
  await page.goto(path(PANES.permission));

  const card = page.locator('[data-slot="dialog-card"]');
  await expect(card).toBeVisible();
  const options = card.getByTestId("dialog-option");
  await expect(options).toHaveCount(3);
  await options.filter({ hasText: /^3?\s*No/u }).click();

  await expect.poll(() => stub.writes.length).toBe(1);
  expect(stub.writes[0]!.path).toBe("keys");
  expect(stub.writes[0]!.body.keys).toEqual(["3"]);
  // The tap is bound to the region it was drawn from: the bridge re-checks it before it writes.
  expect(stub.writes[0]!.body.expected_prompt).toContain("Do you want to proceed?");
  await expect(card).toBeHidden();
});

test("a pointed list walks, reads the pointer back, then commits (ADR 0080)", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.walk]: capture("oc--permission-bash.txt") });
  stub.onWrite((write) => {
    if (write.body.keys?.[0] === "Right") stub.setScreen(PANES.walk, capture("oc--permission-bash--moved.txt"));
    else stub.setScreen(PANES.walk, TERMINAL_TEXT);
  });
  await page.goto(path(PANES.walk));

  const card = page.locator('[data-slot="dialog-card"]');
  await card.getByTestId("dialog-option").filter({ hasText: "Allow always" }).click();

  await expect.poll(() => stub.writes.map((w) => w.body.keys)).toEqual([["Right"], ["Enter"]]);
  expect(stub.writes.every((w) => w.path === "keys")).toBe(true);
});

test("the composer sends a reply", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto(path(PANES.plain));

  const box = page.locator('[data-slot="chat-input"]');
  await expect(box).toBeEnabled();
  await box.fill("run the tests");
  await page.getByTestId("composer-send").click();

  await expect.poll(() => stub.writes.length).toBe(1);
  expect(stub.writes[0]!.path).toBe("reply");
  expect(stub.writes[0]!.body).toMatchObject({ text: "run the tests", submit: true });
  await expect(box).toHaveValue("");
});

test("the keys row sends one special key", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto(path(PANES.plain));
  await page.getByTestId("keys-toggle").click();
  await page.getByTestId("key-esc").click();
  await expect.poll(() => stub.writes.map((w) => [w.path, w.body.keys])).toEqual([["keys", ["Escape"]]]);
});

test("a refused read shows the pairing notice", async ({ page }) => {
  await stubPaneBridge(page, {}, { refuse: 401 });
  await page.goto(path(PANES.plain));
  const notice = page.getByTestId("pane-unpaired");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Not paired");
  await expect(notice).toHaveAttribute("href", "/settings/device");
  await expect(page.locator('[data-slot="chat-input"]')).toBeDisabled();
});

test("a write refused as not paired shows the pairing notice", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.plain]: "ready\n> " }, { unpaired: true });
  await page.goto(path(PANES.plain));
  await expect(page.getByTestId("pane-unpaired")).toHaveCount(0);
  await page.locator('[data-slot="chat-input"]').fill("hello");
  await page.getByTestId("composer-send").click();
  await expect.poll(() => stub.writes.length).toBe(1);
  await expect(page.getByTestId("pane-unpaired")).toBeVisible();
  await expect(page.locator('[data-slot="chat-input"]')).toBeDisabled();
});
