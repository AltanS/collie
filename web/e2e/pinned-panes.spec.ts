import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { ChangesResponse, SnapshotResponse } from "@/lib/types";
import { fixtureChanges, fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// A PANE CAN BE PINNED (ADR 0070, issue 286). A pinned pane leads the dashboard's Dashboard (with the needs-you switch on or off) and
// Changes lists and the switcher, under the summary line, in place order, and is listed once. The
// cases a real engine has to check: where the Pinned group lands on each tab, that the hold (and
// its right-click twin) opens the pane's own sheet instead of the pane, and that the row the
// operator pinned ends up in view and focused in its new place. 390x844, the phone.
//
// The fixture herd (src/test/handlers.ts): webapp (w1) holds a blocked claude pane; collie (w2)
// holds a working codex pane and a bare shell.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone case; the tablet run would repeat it");
  await installApiStub(page);
});

const footer = (page: Page) => page.getByRole("navigation", { name: en["home.tabs.aria"] });
const tab = (page: Page, name: RegExp) => footer(page).getByRole("button", { name });
/** The needs-you switch in the summary line's row (ADR 0085), the old Focus tab. */
const needsYou = (page: Page) => page.getByRole("button", { name: en["home.needsYouOnly"] });
const CHANGES = new RegExp(`^${en["files.title"]}$`, "u");
/** The summary line: the one button in the list that opens on a count of what needs you, or the all-clear. */
const summary = (page: Page) =>
  page.getByRole("main").getByRole("button", { name: /^(\d+ needs you|Nothing needs you)/u });
/** The Pinned group, a section named by its own heading. */
const pinnedGroup = (scope: Page | Locator) => scope.getByRole("region", { name: en["home.pinned.title"] });
/** A pane row by its agent: the tile's name, then the pane's own name. */
const AGENT_ROW = { claude: /^claude logo claude/u, codex: /^codex logo codex/u } as const;
const row = (scope: Page | Locator, agent: keyof typeof AGENT_ROW) =>
  scope.getByRole("button", { name: AGENT_ROW[agent] });
const mainRow = (page: Page, agent: keyof typeof AGENT_ROW) => row(page.getByRole("main"), agent);
/** The dashboard's headings, in the order the page draws them. */
const headings = (page: Page) => page.getByRole("main").getByRole("heading").allTextContents();

/** The pin hint (M38/02): its words, as this browser's primary pointer picks them, and its X. */
async function hintWords(page: Page) {
  const fine = await page.evaluate(() => matchMedia("(pointer: fine)").matches);
  return fine ? en["home.pinHint.rightClick"] : en["home.pinHint.hold"];
}
const hintLine = (page: Page, words: string) => page.getByRole("main").getByText(words, { exact: true });
const dismissHint = (page: Page) => page.getByRole("button", { name: en["home.pinHint.dismiss"] });
const HINT_FLAG = "collie:pin-hint:v1";

/** Open a row's pane menu with a right-click (the hold's `contextmenu` twin) and tap a row in it. */
async function viaMenu(page: Page, target: Locator, action: "paneActions.pin.label" | "paneActions.unpin.label") {
  await target.click({ button: "right" });
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: en[action] }).click();
  await expect(sheet).toHaveCount(0);
}

async function withSnapshot(page: Page, edit: (snap: SnapshotResponse) => void) {
  const snap: SnapshotResponse = structuredClone(fixtureSnapshot);
  edit(snap);
  await page.route("**/api/snapshot*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(snap) }),
  );
}

/** What the hold cases record in the page: each change of `data-holding`, timed from the press. */
interface HoldMark {
  t: number;
  holding: boolean;
  transform: string;
}

declare global {
  interface Window {
    holdLog?: HoldMark[];
    /** `performance.now()` of the press on the row under test. */
    holdAt?: number;
  }
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

test("Dashboard: a pinned pane leads under the summary line and is gone from its workspace group", async ({ page }) => {
  await page.goto("/");
  await expect(pinnedGroup(page)).toHaveCount(0);
  const s0 = await box(summary(page));

  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");

  await expect(pinnedGroup(page)).toBeVisible();
  await expect(row(pinnedGroup(page), "codex")).toBeVisible();
  // Listed once: the collie group keeps its shell and loses the codex row.
  await expect(mainRow(page, "codex")).toHaveCount(1);
  // Pinned is the first group, then the workspaces (Launch and Spaces trail under the Dashboard).
  expect((await headings(page)).slice(0, 3)).toEqual([en["home.pinned.title"], "webapp", "collie"]);
  // Under the summary line, which did not move.
  expect(await box(summary(page))).toEqual(s0);
  expect((await box(pinnedGroup(page))).y).toBeGreaterThan(s0.y + s0.height - 1);
  // The pinned row names its place on line 2, and a tap opens its own pane.
  await expect(row(pinnedGroup(page), "codex")).toContainText("collie");
  await row(pinnedGroup(page), "codex").click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w2:p1")}$`, "u"));
});

test("needs-you switch: an idle pinned pane still leads, and the workspace groups keep only what needs you", async ({ page }) => {
  // The orchestrator case: a pane opened many times an hour that is idle, not blocked.
  await withSnapshot(page, (snap) => {
    snap.agents.find((a) => a.paneId === "w2:p1")!.status = "idle";
  });
  await page.goto("/");
  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");

  await needsYou(page).click();
  await expect(needsYou(page)).toHaveAttribute("aria-pressed", "true");
  await expect(row(pinnedGroup(page), "codex")).toBeVisible();
  // webapp's blocked pane still shows in its group; collie has nothing that needs you.
  expect(await headings(page)).toEqual([en["home.pinned.title"], "webapp"]);
  await expect(mainRow(page, "claude")).toHaveCount(1);
  // Pins survive a reload: they are this device's own store.
  await page.reload();
  await expect(row(pinnedGroup(page), "codex")).toBeVisible();
});

test("Changes: pinned rows lead in place order, open the pane, and the workspace rows below are unchanged (A2)", async ({ page }) => {
  const clean: ChangesResponse = { workspaceId: "w2", available: true, root: "/home/you/collie", truncated: false, repos: [] };
  await page.route("**/api/workspace/*/changes*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]!);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(id === "w1" ? fixtureChanges : clean) });
  });
  await page.goto("/");
  // Pinned in the reverse of place order: collie's codex first, then webapp's claude.
  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");
  await viaMenu(page, mainRow(page, "claude"), "paneActions.pin.label");

  await tab(page, CHANGES).click();
  const pinnedRows = pinnedGroup(page).getByRole("button");
  await expect(pinnedRows).toHaveCount(2);
  await expect(pinnedRows.nth(0)).toHaveAccessibleName(AGENT_ROW.claude);
  await expect(pinnedRows.nth(1)).toHaveAccessibleName(AGENT_ROW.codex);

  // The workspace rows are as they were: both workspaces, with their counts.
  const list = page.getByRole("list", { name: en["home.changes.listAria"] });
  const rows = list.getByRole("button");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("webapp");
  await expect(rows.nth(0)).toContainText("5 files");
  await expect(rows.nth(1)).toContainText("collie");
  // The Pinned group sits above them, under the summary line.
  expect((await box(pinnedGroup(page))).y).toBeLessThan((await box(list)).y);

  // A pinned row on Changes is a pane, and a tap opens the pane.
  await pinnedRows.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w2:p1")}$`, "u"));
});

test("switcher: the Pinned section leads the sheet and each pane is listed once", async ({ page }) => {
  await page.goto("/");
  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");
  await mainRow(page, "claude").click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w1:p1")}$`, "u"));

  await page.getByRole("button", { name: en["chat.switcher.aria"] }).click();
  const sheet = page.getByRole("dialog", { name: en["chat.switcher.aria"] });
  await expect(pinnedGroup(sheet)).toBeVisible();
  await expect(row(pinnedGroup(sheet), "codex")).toBeVisible();
  // Pinned is the sheet's first section heading.
  const sections = await sheet.getByRole("heading", { level: 3 }).allTextContents();
  expect(sections[0]).toBe(en["home.pinned.title"]);
  // Each pane once: codex only under Pinned, claude only in its workspace.
  await expect(row(sheet, "codex")).toHaveCount(1);
  await expect(row(sheet, "claude")).toHaveCount(1);
  await row(pinnedGroup(sheet), "codex").click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w2:p1")}$`, "u"));
});

test("hold: a hold on a row pins it, the row lands in view with focus, and Unpin returns it", async ({ page }) => {
  await page.goto("/");
  const codex = mainRow(page, "codex");
  const target = await box(codex);

  // A real hold: the finger down for longer than the 450ms threshold, then up. The pane must NOT open.
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/\/$/u);
  // B1: Pin to top leads the pane's own sheet, then the writes.
  const pin = sheet.getByRole("button", { name: en["paneActions.pin.label"] });
  const rename = sheet.getByRole("button", { name: en["paneActions.rename.label"] });
  expect((await box(pin)).y).toBeLessThan((await box(rename)).y);
  await pin.click();
  await expect(sheet).toHaveCount(0);

  // The row moved once, because the operator moved it, and it is under the eye and focused.
  const pinnedRow = row(pinnedGroup(page), "codex");
  await expect(pinnedRow).toBeFocused();
  await expect(pinnedRow).toBeInViewport();

  // The right-click twin opens the same sheet, which now reads Unpin; the row goes home, focused.
  await viaMenu(page, pinnedRow, "paneActions.unpin.label");
  // With the only pin gone there is no Pinned group, so the one codex row left is the one in collie.
  await expect(pinnedGroup(page)).toHaveCount(0);
  await expect(mainRow(page, "codex")).toHaveCount(1);
  await expect(mainRow(page, "codex")).toBeFocused();
  await expect(mainRow(page, "codex")).toBeInViewport();
});

test("hold: a held row shows the hold filling, moves nothing, and drops the look the moment it counts", async ({ page }) => {
  await page.goto("/");
  const codex = mainRow(page, "codex");
  const claude = mainRow(page, "claude");
  // Every change of the hold's mark, with the time since the press and the row's transform then. The
  // listener sits on the row itself, so it runs before React's handler (at the root) starts the timers.
  await codex.evaluate((el) => {
    window.holdLog = [];
    window.holdAt = 0;
    el.addEventListener("pointerdown", () => {
      window.holdAt = performance.now();
    });
    new MutationObserver(() =>
      window.holdLog?.push({
        t: performance.now() - (window.holdAt ?? 0),
        holding: el.hasAttribute("data-holding"),
        transform: getComputedStyle(el).transform,
      }),
    ).observe(el, { attributes: true, attributeFilter: ["data-holding"] });
  });
  const layout = () =>
    codex.evaluate((el: HTMLElement) => ({
      box: [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight],
      holding: el.hasAttribute("data-holding"),
      transform: getComputedStyle(el).transform,
      shadow: getComputedStyle(el).boxShadow,
    }));
  const rest = await layout();
  expect(rest).toMatchObject({ holding: false, transform: "none", shadow: "none" });
  const above = await box(claude);
  const target = await box(codex);

  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down();
  // Inside the fill: past the 150ms delay, short of the 450ms mark. One read, so nothing races it.
  await page.waitForTimeout(280);
  const held = await layout();
  expect(held.holding).toBe(true);
  // Pressed in and tinted, by a transform and a shadow only: the row's own box and the row above stay.
  expect(held.transform).not.toBe("none");
  expect(held.shadow).not.toBe("none");
  expect(held.box).toEqual(rest.box);
  expect(await box(claude)).toEqual(above);

  // The hold counts with the finger still down: the sheet opens, and the look has already gone.
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await layout()).toMatchObject({ holding: false, transform: "none", shadow: "none" });
  await page.mouse.up();

  const log = (await page.evaluate(() => window.holdLog)) ?? [];
  expect(log.map((e) => e.holding)).toEqual([true, false]);
  // A tap shorter than the delay would never see the mark, and it ends as the hold counts, at once.
  expect(log[0]!.t).toBeGreaterThanOrEqual(140);
  expect(log[1]!.t).toBeGreaterThanOrEqual(440);
  expect(log[1]!.transform).toBe("none");
});

test("hold: a tap on a row opens its pane and never shows the hold", async ({ page }) => {
  await page.goto("/");
  const codex = mainRow(page, "codex");
  await codex.evaluate((el) => {
    window.holdLog = [];
    new MutationObserver(() =>
      window.holdLog?.push({ t: 0, holding: el.hasAttribute("data-holding"), transform: "" }),
    ).observe(el, { attributes: true, attributeFilter: ["data-holding", "style"] });
  });
  await codex.click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w2:p1")}$`, "u"));
  expect(await page.evaluate(() => window.holdLog)).toEqual([]);
});

test("hold: unpinning an idle pane with the switch on takes it off the list and hands focus to the summary line", async ({ page }) => {
  await withSnapshot(page, (snap) => {
    for (const a of snap.agents) a.status = "idle";
  });
  await page.goto("/");
  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");
  await needsYou(page).click();
  await expect(row(pinnedGroup(page), "codex")).toBeVisible();

  await viaMenu(page, row(pinnedGroup(page), "codex"), "paneActions.unpin.label");
  await expect(mainRow(page, "codex")).toHaveCount(0);
  await expect(summary(page)).toBeFocused();
});

// THE PIN HINT (M38/02). The fixture herd is three pane rows (two agents and a shell), so a fresh
// device sees the hint on the Dashboard; the cases below retire it the two ways the spec allows.
test("hint: shows on the Dashboard with no pins, leaves on the first pin, and stays gone after a reload and an unpin", async ({ page }) => {
  await page.goto("/");
  const words = await hintWords(page);
  const line = hintLine(page, words);
  await expect(line).toBeVisible();
  // Under the summary line, in the place the Pinned group takes, and never with the switch on, or on Changes.
  const s0 = await box(summary(page));
  expect((await box(line)).y).toBeGreaterThan(s0.y + s0.height - 1);
  expect((await box(line)).y).toBeLessThan((await box(page.getByRole("heading", { name: "webapp" }))).y);
  await needsYou(page).click();
  await expect(hintLine(page, words)).toHaveCount(0);
  await needsYou(page).click();
  await tab(page, CHANGES).click();
  await expect(hintLine(page, words)).toHaveCount(0);
  await tab(page, /^Dashboard/u).click();
  await expect(line).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), HINT_FLAG)).toBeNull();

  // The first pin retires it: the Pinned group takes the place and the line slides shut.
  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");
  await expect(pinnedGroup(page)).toBeVisible();
  await expect(line).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), HINT_FLAG)).toBe("1");

  // Gone for good on this device: after a reload, and after the only pin is removed.
  await page.reload();
  await expect(pinnedGroup(page)).toBeVisible();
  await expect(line).toHaveCount(0);
  await viaMenu(page, row(pinnedGroup(page), "codex"), "paneActions.unpin.label");
  await expect(pinnedGroup(page)).toHaveCount(0);
  await page.reload();
  await expect(mainRow(page, "codex")).toBeVisible();
  await expect(line).toHaveCount(0);
});

test("hint: the X dismisses it for good, and the rows below close up without a jump", async ({ page }) => {
  await page.goto("/");
  const line = hintLine(page, await hintWords(page));
  await expect(line).toBeVisible();
  const heading = page.getByRole("heading", { name: "webapp" });
  const before = await box(heading);
  const notice = await box(page.getByRole("main").locator('[data-slot="notice"]'));

  // Every frame's heading position, from the tap until well past the 240ms collapse and its unmount.
  const frames = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const el = [...document.querySelectorAll("main h2")].find((h) => h.textContent === "webapp")!;
        const ys: number[] = [];
        const start = performance.now();
        const tick = () => {
          ys.push(el.getBoundingClientRect().y);
          if (performance.now() - start < 600) requestAnimationFrame(tick);
          else resolve(ys);
        };
        requestAnimationFrame(tick);
      }),
  );
  await dismissHint(page).click();
  const ys = await frames;
  await expect(line).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), HINT_FLAG)).toBe("1");
  // It closed up by exactly the box and the gap above it, so no 20px gap is left behind...
  const after = await box(heading);
  expect(after.y).toBeCloseTo(before.y - notice.height - 20, 0);
  // ...and it got there as a glide: positions in between, and the last step into its final place is
  // the tail of the ease, never the 20px gap dropping out when the box unmounts. (Not a per-frame
  // bound: a loaded runner drops frames, and the ease's first frames then cover more ground.)
  const final = ys.at(-1)!;
  expect(final).toBeCloseTo(after.y, 0);
  const between = new Set(ys.filter((y) => y < before.y - 0.5 && y > final + 0.5).map((y) => Math.round(y)));
  expect(between.size).toBeGreaterThanOrEqual(2);
  const last = ys.findLastIndex((y, i) => i > 0 && Math.abs(y - ys[i - 1]!) > 0.1);
  expect(Math.abs(ys[last]! - ys[last - 1]!)).toBeLessThan(12);

  await page.reload();
  await expect(mainRow(page, "codex")).toBeVisible();
  await expect(line).toHaveCount(0);
  await expect(pinnedGroup(page)).toHaveCount(0);
});

test.describe("hint with a mouse", () => {
  test.use({ hasTouch: false, isMobile: false });

  test("hint: a fine pointer is told to right-click", async ({ page }) => {
    await page.goto("/");
    const fine = await page.evaluate(() => matchMedia("(pointer: fine)").matches);
    test.skip(!fine, "this engine reports no fine pointer without touch emulation");
    await expect(hintLine(page, en["home.pinHint.rightClick"])).toBeVisible();
    await expect(hintLine(page, en["home.pinHint.hold"])).toHaveCount(0);
  });
});
