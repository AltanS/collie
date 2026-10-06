import { expect, test, type Page } from "@playwright/test";

import type { PaneHistoryResponse, SnapshotResponse, TranscriptEntry } from "@web/lib/types";

import { capture, CHAT_BODY, PANE_SNAPSHOT, PANES, stubPaneBridge, TERMINAL_TEXT } from "./pane-api";

// Pane parity with the React app (experiments/remix-v3/COMPARE.md): the statusline strip and the
// agents footer, Send's ink on an empty draft, the empty-mirror sentence under an unread-dialog card,
// the ⋮ sheet's rows, and the newest-reply card in the Terminal view.

const path = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;

async function useTerminal(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
}

const RULE = "─".repeat(60);
const LIMITS = "CTX:20% CACHE:100% LIMITS 5h:22%/1h:20m 7d:26%/5d:03h";

/** A Claude screen with an empty input box, a three-row statusline with limits, and two background agents. */
const STATUS_SCREEN = [
  "● Done with the fix.",
  "",
  RULE,
  "❯ ",
  RULE,
  `  ${LIMITS}`,
  "  [Opus·medium] ~/projects/acme on main*",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
  "",
  "  ● main",
  "  ◯ general-purpose  Running Benchmark command tests  2m 10s",
  "  ◯ worker:scout  Reviewing the test suite  41s",
].join("\n");

test("the statusline strip and the agents footer sit under the mirror, in the mirror's space", async ({ page }) => {
  await useTerminal(page);
  await stubPaneBridge(page, { [PANES.noLog]: STATUS_SCREEN });
  await page.goto(path(PANES.noLog));

  const strip = page.getByTestId("statusline");
  await expect(strip).toBeVisible();
  await expect(strip.locator(":scope > div")).toHaveText([LIMITS, "[Opus·medium] ~/projects/acme on main*", /bypass permissions on/u]);
  // The mirror no longer prints those rows: the strip is their one surface.
  await expect(page.getByTestId("pane-text")).not.toContainText("LIMITS");

  const footer = page.getByTestId("agents-footer");
  const toggle = page.getByTestId("agents-footer-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("general-purpose");
  await expect(toggle).toContainText("+1");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toContainText("● main");
  await expect(footer).toContainText("worker:scout");

  // Both bands sit above the chrome block, statusline first, inside one bottom region.
  const order = await page.locator('[data-slot="bottom-region"]').evaluate((region) =>
    [...region.querySelectorAll('[data-slot="statusline"], [data-slot="agents-footer"], [data-slot="chrome-block"]')].map((n) => n.getAttribute("data-slot")),
  );
  expect(order).toEqual(["statusline", "agents-footer", "chrome-block"]);
});

test("a long chat stays pinned to its tail when the statusline arrives under it", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.chat]: STATUS_SCREEN });
  const turns = Array.from({ length: 40 }, (_, i) => ({
    uuid: `t${String(i)}`,
    seq: 1_000_000 + i,
    ts: "2026-10-06T10:00:00.000Z",
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    parts: [{ kind: "text" as const, text: `Turn ${String(i)}: a line of prose long enough to wrap once on a phone screen.` }],
  }));
  await page.route("**/api/pane/*/chat*", (route) => route.fulfill({ json: { ...CHAT_BODY, upserts: turns, head: 1_000_039 } }));
  await page.goto(path(PANES.chat));
  await expect(page.getByTestId("statusline")).toBeVisible();
  await expect(page.getByTestId("chat-stream")).toContainText("Turn 39");
  await page.waitForTimeout(600);
  const gap = await page.getByTestId("chat-stream").evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight);
  expect(gap).toBeLessThan(2);
});

test("the statusline and the agents footer stand down while composing, and come back", async ({ page }) => {
  await useTerminal(page);
  await stubPaneBridge(page, { [PANES.noLog]: STATUS_SCREEN });
  await page.goto(path(PANES.noLog));
  await expect(page.getByTestId("agents-footer")).toBeVisible();
  await expect(page.getByTestId("statusline")).toBeVisible();

  // A soft keyboard: the visual viewport drops by 300 px (viewport.ts reads the drop).
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (vv === null) throw new Error("no visualViewport");
    Object.defineProperty(vv, "height", { configurable: true, get: () => window.innerHeight - 300 });
    vv.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  });
  await page.locator('[data-slot="chat-input"]').focus();
  await expect(page.getByTestId("agents-footer")).toHaveCount(0);
  await expect(page.getByTestId("statusline")).toHaveCount(0);

  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (vv === null) throw new Error("no visualViewport");
    Object.defineProperty(vv, "height", { configurable: true, get: () => window.innerHeight });
    vv.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  });
  await expect(page.getByTestId("agents-footer")).toBeVisible();
  await expect(page.getByTestId("statusline")).toBeVisible();
});

test("Send wears the primary ink on an empty draft and stays enabled, as in web", async ({ page }) => {
  const bridge = await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto(path(PANES.chat));
  const send = page.getByTestId("composer-send");
  await expect(send).toBeVisible();
  await expect(page.locator('[data-slot="chat-input"]')).toHaveValue("");
  await expect(send).toBeEnabled();
  const ink = await send.evaluate((node) => {
    const probe = document.createElement("span");
    probe.className = "bg-primary";
    document.body.append(probe);
    const primary = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { bg: getComputedStyle(node).backgroundColor, opacity: getComputedStyle(node).opacity, primary };
  });
  expect(ink.bg).toBe(ink.primary);
  expect(ink.opacity).toBe("1");
  // A tap on an empty draft sends nothing.
  await send.click();
  await page.waitForTimeout(300);
  expect(bridge.writes.filter((w) => w.path === "reply")).toEqual([]);
});

test("an unread-dialog card has no '(no recent output)' under it; a blank screen still says it", async ({ page }) => {
  await useTerminal(page);
  // A Codex pane whose screen no grammar lifts (cards.test.ts: an unread dialog).
  const codexPane = "w1:p9";
  const snapshot: SnapshotResponse = {
    ...PANE_SNAPSHOT,
    agents: [...PANE_SNAPSHOT.agents, { ...PANE_SNAPSHOT.agents[0]!, paneId: codexPane, agent: "codex", hasSession: false, paneLabel: "ask" }],
  };
  const bridge = await stubPaneBridge(page, { [codexPane]: capture("codex--ask-notes-focused.txt") });
  await page.route("**/api/snapshot", (route) => route.fulfill({ json: { ...snapshot, ts: Date.now() } }));
  await page.goto(path(codexPane));

  await expect(page.getByTestId("unread-dialog-key")).toBeVisible();
  await expect(page.getByTestId("mirror-empty")).toHaveCount(0);

  // The terminal clears: now the raw screen is empty, and that is the one case for the sentence.
  bridge.setScreen(codexPane, "");
  await expect(page.getByTestId("mirror-empty")).toBeVisible({ timeout: 15_000 });
});

test("the ⋮ sheet lists web's rows in web's order: Copy output in, Raw terminal out", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto(path(PANES.chat));
  await expect(page.getByTestId("chat-stream")).toBeVisible();

  await page.getByTestId("header-menu").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const rows = sheet.locator("button").filter({ hasNotText: /^$/u });
  const labels = (await rows.allInnerTexts()).map((s) => s.trim()).filter((s) => s !== "");
  // web/src/components/pane-actions-sheet.tsx for a Chat-view pane with a session: no Find (the
  // mirror is not on screen), no Zen (off by default); then the write rows the stub's mux offers
  // (no mux named, so Focus reads "in the terminal").
  expect(labels).toEqual(["Conversation history", "Copy output", "Terminal view", "Pane settings", "Pin to top", "Rename", "Focus in the terminal", "Close pane"]);
  await expect(page.getByTestId("raw-mirror-toggle")).toHaveCount(0);

  await sheet.getByRole("button", { name: "Copy output" }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("12 tests passed");
});

/** A reply long enough that the mirror holds only its end. */
const REPLY_HEAD = "The opening paragraph explains the plan in plain words before any table appears on screen.";
const REPLY_TAIL = "The final sentence closes the reply and names the next step for the operator to take today.";
const REPLY: TranscriptEntry = {
  uuid: "r1",
  ts: "2026-10-06T10:00:00.000Z",
  role: "assistant",
  parts: [{ kind: "text", text: `${REPLY_HEAD}\n\n| Lane | State |\n| --- | --- |\n| dev | green |\n\n${REPLY_TAIL}` }],
};

test("the newest reply replaces the clipped rows with a Markdown card, and folds back to them", async ({ page }) => {
  await useTerminal(page);
  // The screen holds only the reply's end: its opening scrolled off the alternate screen.
  const screen = ["| dev | green |", "", REPLY_TAIL, "", "● Ran 1 shell command", "", RULE, "❯ ", RULE, "  [Opus] ~/repo on main"].join("\n");
  await stubPaneBridge(page, { [PANES.noLog]: screen });
  let reads = 0;
  await page.route("**/api/pane/*/history*", (route) => {
    reads++;
    const body: PaneHistoryResponse = { paneId: PANES.noLog, available: true, entries: [REPLY], hasMore: false, total: 1, fileTruncated: false };
    return route.fulfill({ json: body });
  });
  await page.goto(path(PANES.noLog));

  const card = page.getByTestId("latest-reply");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-open", "");
  await expect(card).toContainText(REPLY_HEAD);
  await expect(card.locator("table")).toBeVisible();
  // The rows the card covers are gone from the mirror; what came after the reply is still there.
  await expect(page.getByTestId("pane-text")).toContainText("Ran 1 shell command");
  await expect(page.getByTestId("pane-text")).not.toContainText(REPLY_TAIL);
  expect(reads).toBeGreaterThan(0);

  await card.getByRole("button", { expanded: true }).click();
  await expect(card).not.toHaveAttribute("data-open", "");
  await expect(page.getByTestId("pane-text")).toContainText(REPLY_TAIL);
});
