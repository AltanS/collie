import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureKiroChat, fixtureKiroHistory, fixtureKiroSnapshot, KIRO_PANE_ID } from "@/test/handlers";
import { installApiStub, installPaneWorld, paneCapture, pinLocale, type PaneStep, type PaneWorld } from "./fixtures/api";

// Real installed-CLI captures (kiro/APPROVAL_NOTES.md) drive the built UI, over the saved-session
// journal the bridge parses (`bridge/journal/kiro-journal-golden.test.ts`). Only what Vitest cannot
// show is here: the Chat and History screens, one Allow and one Deny on the built app, the refusal
// message, and the terminal-only card. The guard's walk and its successor cases are in
// `src/lib/prompt-action.test.ts`.

// No service worker: `page.route` does not see a request the worker makes for the page
// (`e2e/issue-180.spec.ts` has the whole story).
test.use({ serviceWorkers: "block" });

const PANE_URL = `/pane/${encodeURIComponent(KIRO_PANE_ID)}`;
const capture = (name: string): string => paneCapture(`kiro--v3-${name}`);
const ANSWER = "lab_after_compact";
const DECISIONS = /^(Allow|Deny|Always allow|Always deny)$/;

function kiroWorld(page: Page, screens: Readonly<Record<string, string>>, start: string, script: readonly PaneStep[] = []): Promise<PaneWorld> {
  return installPaneWorld(page, {
    paneId: KIRO_PANE_ID,
    snapshot: fixtureKiroSnapshot,
    chat: fixtureKiroChat,
    history: fixtureKiroHistory,
    screens,
    start,
    script,
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "Kiro cases exercise the shipped app only");
  await pinLocale(page, "en");
  // Keep the default paneView (Chat). Tool visibility makes the saved denied card inspectable.
  await page.addInitScript(() => window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ showToolCalls: true })));
  await installApiStub(page);
});

test("Kiro defaults to web Chat and offers read-only saved History without model context", async ({ page }) => {
  // Given: an installed-CLI idle frame and the saved-session journal.
  const world = await kiroWorld(page, { idle: capture("idle-w120") }, "idle");
  // When: the phone opens the pane without a paneView preference.
  await page.goto(PANE_URL);
  // Then: the journal answer is visible, with the denial intact and internal context hidden.
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(page.getByTitle("/home/operator/project/denied.txt").getByText("denied.txt", { exact: true })).toBeVisible();
  for (const privateText of [/shortened for the fixture/, /\[LIVE STEERING/, /\[STEERING steer-/]) {
    await expect(page.getByText(privateText)).toHaveCount(0);
  }
  await page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true }).click();
  await page.getByRole("button", { name: en["chat.history.label"], exact: true }).click();
  await expect(page).toHaveURL(`${PANE_URL}/history`);
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^fs_write .*denied\.txt$/ }).click();
  await expect(page.getByText("The user rejected this tool call.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Allow|Deny)$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: en["composer.send.sendAria"], exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder(en["composer.placeholder.reply"])).toHaveCount(0);
  expect(world.writes).toEqual([]);
});

test("Allow once from Chat's live card sends one Enter bound to the captured request", async ({ page }) => {
  // Given: the current capture has Allow selected.
  const world = await kiroWorld(page, { allow: capture("approval-allow-w120"), idle: capture("idle-w120") }, "allow", [
    { on: "allow", keys: ["Enter"], to: "idle" },
  ]);
  await page.goto(PANE_URL);
  // When: the user allows the pending command.
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  // Then: one Enter goes out, bound to that command, and no persistent choice was offered.
  await expect.poll(() => world.sent.length).toBe(1);
  expect(world.sent[0]?.keys).toEqual(["Enter"]);
  expect(world.sent[0]?.expected_prompt).toContain("printf collie_approve_once_probe");
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Always allow|Always deny)$/ })).toHaveCount(0);
});

test("Deny from Chat's live card walks to the Deny row, then sends Enter", async ({ page }) => {
  // Given: paired real captures of one request with Allow and Deny selected.
  const world = await kiroWorld(page, { allow: capture("approval-allow-w120"), deny: capture("approval-deny-w120"), idle: capture("idle-w120") }, "allow", [
    { on: "allow", keys: ["Down", "Down"], to: "deny" },
    { on: "deny", keys: ["Enter"], to: "idle" },
  ]);
  await page.goto(PANE_URL);
  // When: Deny is tapped in the built UI.
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  // Then: the arrows and the Enter go out as two writes, and the card closes.
  await expect.poll(() => world.sent.length).toBe(2);
  expect(world.sent.map((write) => write.keys)).toEqual([["Down", "Down"], ["Enter"]]);
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
});

test("a card whose request changed before the tap sends no key and says so", async ({ page }) => {
  // Given: the visible card names a pending read, but the next terminal read has another range.
  const initial = capture("read-allow-w120");
  const world = await kiroWorld(page, { initial, changed: initial.replace("(L1-1)", "(L2-2)") }, "initial");
  await page.goto(PANE_URL);
  const allow = page.getByRole("button", { name: "Allow", exact: true });
  await expect(allow).toBeVisible();
  world.show("changed");
  // When: the old card is tapped before the next poll redraws it.
  await allow.click();
  // Then: Chat says the menu changed, and nothing was written to the pane.
  await expect(page.getByText(en["chat.status.menuChanged"], { exact: true })).toBeVisible();
  expect(world.writes).toEqual([]);
});

test("an MCP request the preview cannot prove stays terminal-only", async ({ page }) => {
  // Given: a real MCP approval frame, whose full input the panel does not show.
  const world = await kiroWorld(page, { mcp: capture("mcp-allow-w120") }, "mcp");
  await page.goto(PANE_URL);
  // Then: Chat offers no decision; the terminal shows the request and still offers none.
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: DECISIONS })).toHaveCount(0);
  await page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true }).click();
  await page.getByRole("button", { name: en["chat.mode.terminal"], exact: true }).click();
  await expect(page.getByText("collie_echo/echo", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: DECISIONS })).toHaveCount(0);
  expect(world.writes).toEqual([]);
});
