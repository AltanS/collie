import { expect, test, type Locator, type Page } from "@playwright/test";

import { askDecision } from "@/test/asks-fixtures";

import { installWorld, richSnapshot } from "./hitbox/world";

// THE ASKS PAGES, THE WHOLE FLOW (Asks build 2, 2026-11-23). The board, one ask, a pick that waits as a mark, a note, the
// keys that move between asks, one Send for one session, the context page, "Your own answer", and a refused Send. The
// bridge is the stub's: `/api/hill` answers two asks of one session and one of another, `/api/hill/answers` answers
// what each case says. The page's clock is Playwright's (`page.clock`), so the cache words never depend on the wall
// and nothing here waits on a fixed sleep: every wait is for something on the page.

test.use({ serviceWorkers: "block" });

const NOW = new Date("2026-11-23T12:00:00Z");
const AT = NOW.getTime();

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no asks route");
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewport; one project is enough");
  await page.clock.install({ time: NOW });
});

interface Sent {
  rid: string;
  answers: { id: string; intent: string }[];
}

const FIRST = askDecision({
  id: "ak_e2e000000001",
  title: "Keep the old answer route beside the new Send?",
  summary: "The phone can send all answers of a session at once now.",
  body: "The single answer route is used by every phone bundle.\n\nIf we drop it, an old bundle gets a 404.",
  address: "local/w1:p1",
  at: AT - 14 * 3_600_000,
  recommend: "keep",
  why: "A phone that did not reload would lose an answer.",
  files: [{ path: "docs/plan.md", heading: "Plan" }],
  root: "w1:p1",
});
const SECOND = askDecision({ id: "ak_e2e000000002", title: "Drop the flag?", address: "local/w1:p1", at: AT - 3_600_000 });
const OTHER = askDecision({ id: "ak_e2e000000003", title: "Which port for the preview?", address: "local/w2:p1", at: AT - 7_200_000 });

async function world(page: Page, answers?: (body: Sent) => { status: number; body: object }) {
  const control = await installWorld(page);
  await page.route("**/api/hill", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, rev: 1, open: [FIRST, SECOND, OTHER], closed: [] }) }));
  await page.route("**/api/hill/answers", async (route) => {
    const sent: Sent = route.request().postDataJSON();
    const made = answers?.(sent) ?? { status: 200, body: { rid: sent.rid, items: [{ id: FIRST.id, code: "ok", reason: null, state: "answered" }], delivery: "typed", at: AT } };
    await route.fulfill({ status: made.status, contentType: "application/json", body: JSON.stringify(made.body) });
  });
  return control;
}

async function openFirstAsk(page: Page) {
  await page.goto("/asks");
  await page.getByRole("button", { name: "Answer next" }).click();
  await expect(page.getByRole("heading", { name: FIRST.title })).toBeVisible();
}

const card = (page: Page, intent: string) => page.locator(`[data-slot="ask-card"][data-intent="${intent}"]`);

test("the board stands in cache order, and a row opens its ask", async ({ page }) => {
  await world(page);
  await page.goto("/asks");
  await expect(page.getByRole("heading", { name: "Asks", level: 1 })).toBeVisible();
  await expect(page.locator('[data-slot="asks-session"]')).toHaveCount(2);
  await expect(page.locator('[data-slot="asks-row"]')).toHaveCount(3);
  await page.getByRole("button", { name: /Drop the flag\?/u }).click();
  await expect(page).toHaveURL(/\/asks\/ask\/ak_e2e000000002/u);
  await expect(page.getByRole("heading", { name: "Drop the flag?" })).toBeVisible();
});

test("a pick waits as a mark: the card keeps its box, the sheet shows the note, Confirm sends nothing", async ({ page }) => {
  let posted = 0;
  await page.route("**/api/hill/answers", (route) => {
    posted += 1;
    return route.abort();
  });
  await world(page);
  await openFirstAsk(page);
  const box = async () => {
    const b = await card(page, "drop").boundingBox();
    expect(b).not.toBeNull();
    return b!;
  };
  // The page stands where a tap would leave it: Playwright scrolls a card that a bar half covers before it clicks.
  await card(page, "drop").scrollIntoViewIfNeeded();
  const before = await box();
  const below = await card(page, "own").boundingBox();
  await card(page, "drop").getByRole("button").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /Add a note/u }).click();
  await sheet.getByRole("textbox").fill("after the next minor");
  await sheet.getByRole("button", { name: "Confirm" }).click();
  await expect(sheet).toBeHidden();
  await expect(card(page, "drop")).toHaveAttribute("data-state", "answered");
  await expect(card(page, "drop").locator('[data-slot="ask-card-foot"]')).toHaveText("Note: after the next minor");
  const after = await box();
  expect(after).toEqual(before);
  expect(await card(page, "own").boundingBox()).toEqual(below);
  await expect(page.locator('[data-slot="ask-send-line"]')).toContainText("1 of 2 answered");
  expect(posted).toBe(0);
});

test("the keys move between asks without a new history entry, pick with a digit, and leave a field alone", async ({ page }) => {
  await world(page);
  await openFirstAsk(page);
  const length = await page.evaluate(() => window.history.length);
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/ak_e2e000000002/u);
  await expect(page.getByRole("heading", { name: SECOND.title })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page).toHaveURL(/ak_e2e000000001/u);
  await expect(page.getByRole("heading", { name: FIRST.title })).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(length);
  await page.keyboard.press("2");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Drop the old route");
  // A touch project draws the note closed even for a key; open it and write in it.
  await sheet.getByRole("button", { name: /Add a note/u }).click();
  const field = sheet.getByRole("textbox");
  await field.focus();
  await page.keyboard.type("jk2");
  await expect(field).toHaveValue("jk2");
  await expect(page).toHaveURL(/ak_e2e000000001/u);
  await page.keyboard.press("Enter");
  await expect(sheet).toBeHidden();
  await expect(card(page, "drop")).toHaveAttribute("data-state", "answered");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/asks(\?|$)/u);
});

test("Your own answer needs words, and a words field never moves its card", async ({ page }) => {
  await world(page);
  await openFirstAsk(page);
  await card(page, "own").getByRole("button").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await sheet.getByRole("textbox").fill("Ask me again on Monday");
  await sheet.getByRole("button", { name: "Confirm" }).click();
  await expect(card(page, "own")).toHaveAttribute("data-state", "answered");
  await expect(card(page, "own").locator('[data-slot="ask-card-text"]')).toHaveText("Ask me again on Monday");
});

test("one Send answers the session: the sheet shows the message, the marks clear after it", async ({ page }) => {
  const sentAnswers: Sent["answers"][] = [];
  await world(page, (sent) => {
    sentAnswers.push(sent.answers);
    return { status: 200, body: { rid: sent.rid, items: [{ id: FIRST.id, code: "ok", reason: null, state: "answered" }], delivery: "typed", at: AT } };
  });
  await openFirstAsk(page);
  await card(page, "keep").getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Review and send" }).click();
  const sheet = page.getByRole("dialog", { name: /Send to/u });
  await expect(sheet.locator('[data-slot="ask-send-message"]')).toContainText(`${FIRST.id} "${FIRST.title}": keep (Keep both routes)`);
  await sheet.getByRole("button", { name: "Send 1" }).click();
  await expect(sheet).toBeHidden();
  expect(sentAnswers).toEqual([[{ id: FIRST.id, intent: "keep" }]]);
  await expect(page.locator('[data-slot="ask-send-line"]')).toContainText("No answers yet");
});

test("a refused Send reads in plain words in the sheet and keeps the marks", async ({ page }) => {
  await world(page, () => ({ status: 409, body: { code: "not_answering", error: "away", machine: "workshop" } }));
  await openFirstAsk(page);
  await card(page, "keep").getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "Review and send" }).click();
  const sheet = page.getByRole("dialog", { name: /Send to/u });
  await sheet.getByRole("button", { name: "Send 1" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("workshop is not answering. Nothing was sent.");
  await expect(card(page, "keep")).toHaveAttribute("data-state", "answered");
});

test("the context page is a level below the ask, and Back to the answers returns to it", async ({ page }) => {
  await world(page);
  await openFirstAsk(page);
  await page.locator('[data-slot="ask-context-row"]').click();
  await expect(page).toHaveURL(/\/asks\/ask\/ak_e2e000000001\/context/u);
  await expect(page.getByRole("heading", { name: "Context for this ask" })).toBeVisible();
  await expect(page.getByText("The single answer route is used by every phone bundle.")).toBeVisible();
  await expect(page.getByText("docs/plan.md")).toBeVisible();
  await page.getByRole("button", { name: "Back to the answers" }).click();
  await expect(page).toHaveURL(/\/asks\/ask\/ak_e2e000000001(\?|$)/u);
  await expect(page.getByRole("heading", { name: FIRST.title })).toBeVisible();
});

test("on a large screen the ask is one centred column and the keys still work", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await world(page);
  await page.goto(`/asks/ask/${FIRST.id}`);
  const screen = page.locator('[data-slot="ask-screen"]');
  await expect(screen).toBeVisible();
  const b = await screen.boundingBox();
  expect(b).not.toBeNull();
  expect(b!.width).toBeLessThanOrEqual(640);
  expect(Math.abs(b!.x + b!.width / 2 - 720)).toBeLessThanOrEqual(2);
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/ak_e2e000000002/u);
});

// THE CONFIRM SHEET STANDS WHOLE IN THE WINDOW (2026-11-23, after the first review shots showed only its title: they
// were taken while it still slid in). The panel's own box is read after its open animation has ended, never after a
// sleep: Confirm and Cancel end inside the window, on a phone the sheet leaves the chosen card in view above it, and
// that card wears the chosen look (`border-primary bg-primary/10`).
async function boxOf(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

const SHEET_WINDOWS = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

for (const { width, height } of SHEET_WINDOWS) {
  for (const kind of ["option", "option with its note open", "own answer"] as const) {
    test(`the confirm sheet is whole in the window: ${kind}, ${width} x ${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await world(page);
      await page.goto(`/asks/ask/${FIRST.id}`);
      await expect(page.getByRole("heading", { name: FIRST.title })).toBeVisible();
      const intent = kind === "own answer" ? "own" : "drop";
      await card(page, intent).scrollIntoViewIfNeeded();
      await card(page, intent).getByRole("button").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      if (kind === "option with its note open") await dialog.getByRole("button", { name: /Add a note/u }).click();
      const panel = page.locator("[data-presentation]");
      await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)).then(() => undefined));
      const confirm = dialog.getByRole("button", { name: "Confirm" });
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      const sheetBox = await boxOf(panel);
      expect(sheetBox.y).toBeGreaterThanOrEqual(0);
      expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(height);
      const confirmBox = await boxOf(confirm);
      expect(confirmBox.y).toBeGreaterThanOrEqual(sheetBox.y);
      expect(confirmBox.y + confirmBox.height).toBeLessThanOrEqual(height);
      const cancelBox = await boxOf(cancel);
      expect(cancelBox.y + cancelBox.height).toBeLessThanOrEqual(Math.min(height, sheetBox.y + sheetBox.height));
      if (width >= 1000) return;
      // A phone: the chosen card is marked and stands between the page's top and the sheet.
      const chosen = card(page, intent);
      await expect(chosen).toHaveAttribute("data-state", "picked");
      await expect(chosen.getByRole("button")).toHaveClass(/border-primary/u);
      await expect(chosen.getByRole("button")).toHaveClass(/bg-primary\/10/u);
      const chosenBox = await boxOf(chosen);
      const scrollBox = await boxOf(page.locator('[data-slot="ask-scroll"]'));
      expect(chosenBox.y).toBeGreaterThanOrEqual(scrollBox.y);
      expect(chosenBox.y + chosenBox.height).toBeLessThanOrEqual(sheetBox.y);
    });
  }
}

test("a session card on the board says its cache in words when the phone knows it", async ({ page }) => {
  const control = await world(page);
  control.body = () =>
    richSnapshot(1, (agents) =>
      agents.map((agent) => {
        if (agent.paneId === "w1:p1") return { ...agent, status: "idle", cache: { state: "warm", expiresAt: AT + 38.5 * 60_000, ttlSeconds: 300, ruleId: "e2e", confidence: "observed" } };
        if (agent.paneId === "w2:p4") return { ...agent, status: "idle", cache: { state: "cold", ttlSeconds: 300, ruleId: "e2e", confidence: "observed" } };
        return agent;
      }),
    );
  // The second session is a pane the herd holds (the stub's panes are w1:p1 to w4:p11).
  const cold = askDecision({ id: "ak_e2e000000004", title: "Which port for the preview?", address: "local/w2:p4", at: AT - 7_200_000 });
  await page.route("**/api/hill", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, rev: 1, open: [FIRST, cold], closed: [] }) }));
  await page.goto("/asks");
  const cards = page.locator('[data-slot="asks-session"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('[data-slot="asks-session-cache"]')).toHaveText("warm, 38 min left");
  await expect(cards.nth(1).locator('[data-slot="asks-session-cache"]')).toHaveText("cold");
});
