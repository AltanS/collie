import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureLaunchedTab } from "@/test/handlers";

import { fill, installApiStub, installLauncherWorld, type SentLaunch } from "./fixtures/api";

// THE "+" OFFERS YOUR AGENTS (M91). A workspace heading's "+" on the dashboard, and the "+" at the end
// of a space's tab row, open the New tab sheet when the machine has a launcher row to offer. A tap on a
// row posts `POST /api/launch` beside that workspace's pane and the phone lands in the new pane. What
// a real engine checks here and jsdom cannot: the sheet's rows keep the 44px tap floor, the last row
// sits clear of the screen's bottom edge, and the tap goes through the real sheet to the real route.
//
// The fixture herd (src/test/handlers.ts): webapp (w1) holds the blocked claude pane `w1:p1`.
// `installLauncherWorld` serves `fixtureLaunchersWithAgents`: Claude Code, Codex (not installed),
// the shell and an `htop` row.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  await installApiStub(page);
});

const NEW_PANE = `/pane/${encodeURIComponent(fixtureLaunchedTab.pane.paneId)}`;

const sheetOf = (page: Page, workspace: string) => page.getByRole("dialog", { name: fill(en["newTab.title"], { workspace }) });

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** The sheet's rows keep the tap floor, and the last one is on screen with air under it. */
async function expectReachable(page: Page, sheet: Locator) {
  const viewport = page.viewportSize()!;
  for (const name of [/Claude Code/u, /htop/u, new RegExp(en["newPage.shell.option"], "u"), new RegExp(en["newTab.more"], "u")]) {
    const b = await box(sheet.getByRole("button", { name }));
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  const more = sheet.getByRole("button", { name: en["newTab.more"] });
  await more.scrollIntoViewIfNeeded();
  const m = await box(more);
  expect(m.y + m.height).toBeLessThanOrEqual(viewport.height - 8);
}

/** The launch the stub received last. */
async function lastLaunch(launches: SentLaunch[]): Promise<SentLaunch> {
  await expect.poll(() => launches.length).toBe(1);
  return launches[0]!;
}

test("a dashboard heading's '+' opens the sheet, and an agent starts as a tab beside the workspace's pane", async ({ page }) => {
  const { launches } = await installLauncherWorld(page);
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: fill(en["home.group.newTab"], { name: "webapp" }) })
    .click();

  const sheet = sheetOf(page, "webapp");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(fill(en["newTab.folder"], { folder: "~/webapp" }))).toBeVisible();
  await expect(sheet.getByRole("button", { name: /Codex/u })).toBeDisabled();
  await expectReachable(page, sheet);

  await sheet.getByRole("button", { name: /Claude Code/u }).click();
  const sent = await lastLaunch(launches);
  expect(sent.host).toBeNull();
  expect(sent.body).toMatchObject({ harness: "claude", paneId: "w1:p1" });
  expect(sent.body.requestId).toEqual(expect.any(String));
  await expect(page).toHaveURL(new RegExp(`${NEW_PANE}$`, "u"));
  await expect(sheet).toBeHidden();
});

test("the space view's tab row '+' opens the same sheet, and a command row starts there", async ({ page }) => {
  const { launches } = await installLauncherWorld(page);
  await page.goto("/space/w1");
  await page.getByRole("button", { name: en["space.tabStrip.new.aria"], exact: true }).click();

  const sheet = sheetOf(page, "webapp");
  await expect(sheet).toBeVisible();
  await expectReachable(page, sheet);

  await sheet.getByRole("button", { name: /htop/u }).click();
  const sent = await lastLaunch(launches);
  expect(sent.body).toMatchObject({ command: "htop", paneId: "w1:p1" });
  await expect(page).toHaveURL(new RegExp(`${NEW_PANE}$`, "u"));
});
