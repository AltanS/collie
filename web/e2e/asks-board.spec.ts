import { expect, test, type Page } from "@playwright/test";

import { askDecision } from "@/test/asks-fixtures";

import { installWorld, richSnapshot } from "./hitbox/world";

// THE ASKS LIST PAGE, v2 (Asks build 6, 2026-11-23): the Next up card with the one filled button, the Mode bell and
// its menu, "Send 1" in a card's foot, the 640 px column, a cold session without a fill, the cache clock on Playwright's
// clock, and the action "Answer the next ask" (the prefix and `a`), whose key cap shows on the button only while the
// prefix waits. The bridge is the stub's. Every wait is for something on the page.

test.use({ serviceWorkers: "block" });

const NOW = new Date("2026-11-23T12:00:00Z");
const AT = NOW.getTime();

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewport; one project is enough");
  await page.clock.install({ time: NOW });
});

const FIRST = askDecision({ id: "ak_b6000000001", title: "Keep the old answer route beside the new Send?", address: "local/w1:p1", at: AT - 14 * 3_600_000, recommend: "keep", why: "A phone that did not reload would lose an answer." });
const SECOND = askDecision({ id: "ak_b6000000002", title: "Drop the flag?", address: "local/w1:p1", at: AT - 3_600_000 });
const OTHER = askDecision({ id: "ak_b6000000003", title: "Which port for the preview?", address: "local/w2:p4", at: AT - 7_200_000 });

interface CrewBody {
  state: "here" | "quiet" | "away";
  at: number | null;
  by: string | null;
  told: number | null;
}

async function world(page: Page, opts: { cold?: boolean; crew?: CrewBody } = {}) {
  const control = await installWorld(page);
  control.body = () =>
    richSnapshot(1, (agents) =>
      agents.map((agent) => {
        if (agent.paneId === "w1:p1") return { ...agent, status: "idle", cache: { state: "warm", expiresAt: AT + 38.5 * 60_000, ttlSeconds: 300, ruleId: "e2e", confidence: "observed" } };
        if (agent.paneId === "w2:p4") return { ...agent, status: "idle", cache: opts.cold === false ? undefined : { state: "cold", ttlSeconds: 300, ruleId: "e2e", confidence: "observed" } };
        return agent;
      }),
    );
  await page.route("**/api/hill", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, rev: 1, open: [FIRST, SECOND, OTHER], closed: [], crewState: opts.crew }) }));
  return control;
}

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

const ANSWER = '[data-slot="asks-answer-next"]';
const HINT = '[data-slot="shortcut-hint"][data-action="answer_next_ask"]';

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const) {
  test.describe(`at ${size.width} px`, () => {
    test.use({ viewport: size });

    test("the page has exactly one filled button, Answer", async ({ page }) => {
      await world(page);
      await page.goto("/asks");
      await expect(page.locator(ANSWER)).toBeVisible();
      await expect(page.locator('button[class~="bg-primary"]')).toHaveCount(1);
      await expect(page.locator('button[class~="bg-primary"]')).toHaveText("Answer");
      // Nothing extra rides inside it: no key hint at rest.
      await expect(page.locator(ANSWER)).not.toContainText("Enter");
      await expect(page.locator(HINT)).toHaveCount(0);
    });

    test("the bell opens the Mode menu in its place, a row sets the state, and the header says it", async ({ page }) => {
      await world(page, { crew: { state: "here", at: null, by: null, told: null } });
      const posted: unknown[] = [];
      await page.route("**/api/hill/state", async (route) => {
        if (route.request().method() === "POST") {
          posted.push(route.request().postDataJSON());
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ state: "quiet", at: AT, by: "Pixel 9", told: null }) });
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ state: "here", at: null, by: null, told: null }) });
      });
      await page.goto("/asks");
      const bell = page.getByRole("button", { name: "Mode: Here" });
      await expect(bell).toBeVisible();
      await expect(bell).toHaveText("");
      await bell.click();
      const menu = page.getByRole("menu", { name: "How agents ask you" });
      await expect(menu).toBeVisible();
      await expect(bell).toHaveAttribute("aria-expanded", "true");
      const panel = page.locator("[data-presentation]");
      await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)).then(() => undefined));
      const panelBox = (await panel.boundingBox())!;
      const bellBox = (await bell.boundingBox())!;
      if (size.width >= 1000) {
        // Beside its button: below it, trailing edges together.
        await expect(panel).toHaveAttribute("data-presentation", "menu");
        expect(panelBox.y).toBeGreaterThanOrEqual(bellBox.y + bellBox.height - 1);
        expect(Math.abs(panelBox.x + panelBox.width - (bellBox.x + bellBox.width))).toBeLessThanOrEqual(12);
        expect(panelBox.width).toBeLessThanOrEqual(321);
      } else {
        // A bottom sheet: it stands on the window's foot and spans its width.
        await expect(panel).toHaveAttribute("data-presentation", "sheet");
        expect(Math.abs(panelBox.y + panelBox.height - size.height)).toBeLessThanOrEqual(2);
        expect(panelBox.width).toBeGreaterThanOrEqual(size.width - 2);
      }
      await menu.getByRole("menuitemradio", { name: /^Quiet/ }).click();
      await expect(page.getByRole("button", { name: "Mode: Quiet" })).toHaveText("Quiet");
      await expect(page.getByRole("menu")).toBeHidden();
      expect(posted).toEqual([{ state: "quiet" }]);
    });

    test("Send 1 in a card's foot opens the Send flow of that session", async ({ page }) => {
      await world(page);
      await page.addInitScript((drafts) => localStorage.setItem("collie:ask-drafts:v1", drafts), JSON.stringify({ [FIRST.id]: { intent: "keep", text: "", at: AT } }));
      await page.goto("/asks");
      const foot = page.locator('[data-slot="asks-session-foot"]');
      await expect(foot).toHaveCount(1);
      await expect(foot).toContainText("1 of 2 answered");
      await foot.getByRole("button", { name: "Send 1" }).click();
      const sheet = page.getByRole("dialog", { name: /Send to/u });
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('[data-slot="ask-send-message"]')).toContainText(`${FIRST.id} "${FIRST.title}": keep (Keep both routes)`);
    });
  });
}

test.describe("on a large screen", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the column is 640 px wide and the header keeps its sub line", async ({ page }) => {
    await world(page);
    await page.goto("/asks");
    await expect(page.locator(ANSWER)).toBeVisible();
    const column = await boxOf(page, '[data-slot="hill-scroll"] >> xpath=..');
    expect(Math.round(column.width)).toBe(640);
    expect(Math.abs(column.x + column.width / 2 - 720)).toBeLessThanOrEqual(2);
    await expect(page.locator('[data-slot="hill-count"]')).toHaveText("3 open in 2 sessions");
  });

  test("a cold session's card has no fill, a warm one does, and the cache clock follows the clock", async ({ page }) => {
    await world(page);
    await page.goto("/asks");
    const cards = page.locator('[data-slot="asks-session"]');
    await expect(cards).toHaveCount(2);
    const fill = (index: number) => cards.nth(index).evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(cards.nth(1)).toHaveAttribute("data-clock", "cold");
    expect(await fill(1)).toBe("rgba(0, 0, 0, 0)");
    expect(await fill(0)).not.toBe("rgba(0, 0, 0, 0)");
    const words = cards.nth(0).locator('[data-slot="asks-clock-words"]');
    await expect(words).toHaveText("38 min left");
    await expect(cards.nth(0).locator('[data-slot="asks-clock-fill"]')).toHaveCSS("width", /\d/u);
    await expect(cards.nth(1).locator('[data-slot="asks-clock-words"]')).toHaveText("cold");
    // Ten minutes go by on the page's clock: the words and the bar move with it.
    const before = (await cards.nth(0).locator('[data-slot="asks-clock-fill"]').boundingBox())!.width;
    await page.clock.fastForward(10 * 60_000);
    await expect(words).toHaveText("28 min left");
    await expect.poll(async () => (await cards.nth(0).locator('[data-slot="asks-clock-fill"]').boundingBox())!.width).toBeLessThan(before);
  });

  test("the action's key opens the Next up ask from the list page and from the Dashboard", async ({ page }) => {
    await world(page);
    await page.goto("/asks");
    await expect(page.locator(ANSWER)).toBeVisible();
    const question = (await page.locator('[data-slot="asks-next-question"]').textContent())!;
    await page.keyboard.press("Control+b");
    await page.keyboard.press("a");
    await expect(page).toHaveURL(/\/asks\/ask\/ak_b6/u);
    await expect(page.getByRole("heading", { name: question })).toBeVisible();

    // From the Dashboard: the keys are pressed until the asks have landed in the store, which is what offers the action.
    await page.goto("/");
    await expect(async () => {
      await page.keyboard.press("Control+b");
      await page.keyboard.press("a");
      await expect(page).toHaveURL(/\/asks\/ask\/ak_b6/u, { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: question })).toBeVisible();
  });

  test("the key cap shows on Answer only while the prefix waits, and the button's box does not change", async ({ page }) => {
    await world(page);
    await page.goto("/asks");
    await expect(page.locator(ANSWER)).toBeVisible();
    await expect(page.locator(HINT)).toHaveCount(0);
    const rest = await boxOf(page, ANSWER);
    await page.keyboard.press("Control+b");
    await expect(page.locator(HINT)).toHaveCount(1);
    await expect(page.locator(HINT)).toHaveText("a");
    expect(await boxOf(page, ANSWER)).toEqual(rest);
    // The cap sits on the button's top right corner, half over it.
    const cap = (await page.locator(HINT).boundingBox())!;
    expect(Math.abs(cap.x + cap.width / 2 - (rest.x + rest.width))).toBeLessThanOrEqual(14);
    await page.keyboard.press("Escape");
    await expect(page.locator(HINT)).toHaveCount(0);
    expect(await boxOf(page, ANSWER)).toEqual(rest);
  });
});
