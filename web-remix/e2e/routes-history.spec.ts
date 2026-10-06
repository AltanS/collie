import { expect, test, type Page } from "@playwright/test";

import { en } from "@web/lib/i18n/messages/en";

import { installRoutesApi, type RoutesStub } from "./routes-api";
import { historyStub, type HistoryMode } from "./routes-history-api";

// Wave 4, History: the whole transcript in one request, only the newest turns drawn, opened at the
// newest, growing upward on scroll, find and jump across turns not yet drawn. The route claims the header
// (ArrowLeft and h1) and back goes UP to the pane. Not polled. The bridge is routes-history-api.ts.

test.use({ serviceWorkers: "block" });

let stub: RoutesStub;
const errors: string[] = [];

async function open(page: Page, mode: HistoryMode = "long"): Promise<void> {
  stub = await installRoutesApi(page, [historyStub(mode)]);
  await page.goto("/pane/w1%3Ap1/history");
}

test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const turns = (page: Page) => page.locator("[data-turn]");

test("claims the header, and back goes up to the pane", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en["history.title"]);
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/pane\/w1%3Ap1$/u);
});

test("opens at the newest turn with a window of 60, and the whole count beside it", async ({ page }) => {
  await open(page);
  await expect(turns(page)).toHaveCount(60);
  await expect(page.locator('[data-turn="t89"]')).toBeInViewport();
  await expect(page.locator('[data-turn="t30"]')).toHaveCount(1);
  await expect(page.locator('[data-turn="t29"]')).toHaveCount(0);
  await expect(page.getByTestId("history-count")).toHaveText("60/90");
  await expect(page.getByTestId("history-load-older")).toBeVisible();
});

test("one request on open, and none while it is read", async ({ page }) => {
  await open(page);
  await expect(turns(page)).toHaveCount(60);
  const reads = (): number => stub.calls.filter((c) => c.path.endsWith("/history")).length;
  expect(reads()).toBe(1);
  const call = stub.calls.find((c) => c.path.endsWith("/history"));
  expect(call?.search).toBe("?limit=5000");
  await page.waitForTimeout(1_800);
  expect(reads()).toBe(1);
});

test("load older grows the window from memory and keeps the reading position", async ({ page }) => {
  await open(page);
  // The second turn of the window: the first one wears the day divider, which moves up to t0 on growth.
  const anchor = page.locator('[data-turn="t31"]');
  const before = await anchor.evaluate((el) => el.getBoundingClientRect().top);
  await page.getByTestId("history-load-older").evaluate((el) => {
    // Not a Playwright click: it scrolls the button into view, and a scroll near the top grows the window by itself.
    if (el instanceof HTMLElement) el.click();
  });
  await expect(turns(page)).toHaveCount(90);
  await expect(page.getByTestId("history-start")).toHaveText(en["history.startOfConversation"]);
  // Content arrived above the viewport and the turn the reader was on did not move.
  const after = await anchor.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThan(2);
  expect(stub.calls.filter((c) => c.path.endsWith("/history"))).toHaveLength(1);
});

test("scrolling to the top grows the window by itself", async ({ page }) => {
  await open(page);
  await expect(turns(page)).toHaveCount(60);
  await page.getByTestId("history-scroller").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(turns(page)).toHaveCount(90);
});

test("the steps of a turn are folded behind one line, and a tap brings them back", async ({ page }) => {
  await open(page);
  const turn = page.locator('[data-turn="t89"]');
  await expect(turn).toContainText("answer number 89");
  await expect(turn.getByTestId("hidden-tools")).toBeVisible();
  await expect(turn).not.toContainText("ls dir89");
  await turn.getByTestId("hidden-tools").click();
  await expect(turn).toContainText("ls dir89");
});

test("find reaches a turn that is not drawn yet, and a find shows tool output too", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: en["history.findAria"] }).click();
  const input = page.getByRole("searchbox");
  await expect(input).toBeFocused();
  await input.fill("number 3");
  // "question number 30" (user turn) and many answers: the first Next lands at the top of the thread.
  await expect(page.getByTestId("find-count")).toContainText("/");
  await page.keyboard.press("Enter");
  const first = page.locator("[data-turn].border-primary\\/60");
  await expect(first).toHaveCount(1);
  await expect(first).toHaveAttribute("data-turn", "t3");
  // t3 is inside the 60-turn window already; a query for turn 5's neighbour far above proves growth.
  await input.fill("question number 0");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-turn="t0"]')).toBeInViewport();
  await expect(turns(page).first()).toHaveAttribute("data-turn", "t0");
});

test("escape closes find and clears the query", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: en["history.findAria"] }).click();
  await page.getByRole("searchbox").fill("zzz");
  await expect(page.getByTestId("find-count")).toHaveText("0");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("find-bar")).toHaveCount(0);
});

test("the jump buttons walk the turns the reader wrote", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: en["history.prevMessageAria"] }).click();
  await expect(page.locator('[data-turn="t80"]')).toBeInViewport();
  await page.getByRole("button", { name: en["history.prevMessageAria"] }).click();
  await expect(page.locator('[data-turn="t70"]')).toBeInViewport();
  await page.getByRole("button", { name: en["history.nextMessageAria"] }).click();
  await expect(page.locator('[data-turn="t80"]')).toBeInViewport();
  // A user turn far above the window is reached by drawing back to it.
  for (let i = 0; i < 8; i++) await page.getByRole("button", { name: en["history.prevMessageAria"] }).click();
  await expect(page.locator('[data-turn="t0"]')).toBeInViewport();
});

test("a short conversation has no load-older button, only its start", async ({ page }) => {
  await open(page, "short");
  await expect(turns(page)).toHaveCount(5);
  await expect(page.getByTestId("history-load-older")).toHaveCount(0);
  await expect(page.getByTestId("history-start")).toBeVisible();
});

for (const [mode, key] of [
  ["disabled", "history.unavailable.disabled"],
  ["no-session", "history.unavailable.noSession"],
  ["no-log", "history.unavailable.noLog"],
  ["error", "history.unavailable.error"],
] as const) {
  test(`${mode} explains itself instead of showing a blank page`, async ({ page }) => {
    await open(page, mode);
    await expect(page.getByTestId("history-empty")).toHaveText(en[key]);
  });
}
