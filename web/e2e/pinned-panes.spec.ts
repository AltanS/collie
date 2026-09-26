import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { ChangesResponse, SnapshotResponse } from "@/lib/types";
import { fixtureChanges, fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// A PANE CAN BE PINNED (ADR 0070, issue 286). A pinned pane leads the dashboard's Panes, Focus and
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
const FOCUS = new RegExp(`^${en["home.tabs.focus"]}`, "u");
const CHANGES = new RegExp(`^${en["changes.title"]}$`, "u");
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

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

test("Panes: a pinned pane leads under the summary line and is gone from its workspace group", async ({ page }) => {
  await page.goto("/");
  await expect(pinnedGroup(page)).toHaveCount(0);
  const s0 = await box(summary(page));

  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");

  await expect(pinnedGroup(page)).toBeVisible();
  await expect(row(pinnedGroup(page), "codex")).toBeVisible();
  // Listed once: the collie group keeps its shell and loses the codex row.
  await expect(mainRow(page, "codex")).toHaveCount(1);
  // Pinned is the first group, then the workspaces (Launch and Spaces trail under Panes).
  expect((await headings(page)).slice(0, 3)).toEqual([en["home.pinned.title"], "webapp", "collie"]);
  // Under the summary line, which did not move.
  expect(await box(summary(page))).toEqual(s0);
  expect((await box(pinnedGroup(page))).y).toBeGreaterThan(s0.y + s0.height - 1);
  // The pinned row names its place on line 2, and a tap opens its own pane.
  await expect(row(pinnedGroup(page), "codex")).toContainText("collie");
  await row(pinnedGroup(page), "codex").click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w2:p1")}$`, "u"));
});

test("Focus: an idle pinned pane still leads, and the workspace groups keep only what needs you", async ({ page }) => {
  // The orchestrator case: a pane opened many times an hour that is idle, not blocked.
  await withSnapshot(page, (snap) => {
    snap.agents.find((a) => a.paneId === "w2:p1")!.status = "idle";
  });
  await page.goto("/");
  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");

  await tab(page, FOCUS).click();
  await expect(tab(page, FOCUS)).toHaveAttribute("aria-current", "page");
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

test("hold: unpinning an idle pane on Focus takes it off the list and hands focus to the summary line", async ({ page }) => {
  await withSnapshot(page, (snap) => {
    for (const a of snap.agents) a.status = "idle";
  });
  await page.goto("/");
  await viaMenu(page, mainRow(page, "codex"), "paneActions.pin.label");
  await tab(page, FOCUS).click();
  await expect(row(pinnedGroup(page), "codex")).toBeVisible();

  await viaMenu(page, row(pinnedGroup(page), "codex"), "paneActions.unpin.label");
  await expect(mainRow(page, "codex")).toHaveCount(0);
  await expect(summary(page)).toBeFocused();
});
