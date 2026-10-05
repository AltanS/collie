import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureServers } from "@/test/handlers";

import { fill, installApiStub, installCrewWorld } from "./fixtures/api";

// A CREW'S DASHBOARD CAN HIDE A MACHINE (issue #288, M40/01, Option A1). The Machines sheet carries
// a Show switch per machine; a hidden machine's workspaces leave the list, and one dimmed stand-in
// chip in the strip keeps its worst dot and brings it back. A filter, never an address: `?h=` and
// history stay as they were, and the summary line and the Dashboard badge keep counting every machine.
// Pins ignore the filter (ADR 0070). 390x844, the phone.
//
// The crew fixture (src/test/handlers.ts): the lead bluefin holds webapp (a blocked claude pane) and
// collie (a working codex pane and a shell); the peer workshop holds moonward (a blocked codex pane);
// attic is incompatible and holds nothing.

// No service worker, for the reason e2e/m24-crew.spec.ts gives: a worker claiming the page part way
// through would take the snapshot away from the fixture.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone case; the tablet run would repeat it");
  await installApiStub(page);
  await installCrewWorld(page);
});

const LEAD = fixtureServers[0]!.name;
const PEER = fixtureServers[1]!.name;

const headings = (page: Page) => page.getByRole("main").getByRole("heading").allTextContents();
const strip = (page: Page) => page.getByRole("navigation", { name: en["space.strip.title"] });
const standIn = (page: Page) => strip(page).getByRole("button", { name: fill(en["home.machineHidden.show"], { name: PEER }) });
const summary = (page: Page) => page.getByRole("main").getByRole("button", { name: /^\d+ needs you/u });
const dashboardTab = (page: Page) =>
  page.getByRole("navigation", { name: en["home.tabs.aria"] }).getByRole("button", { name: new RegExp(`^${en["home.tabs.dashboard"]}`, "u") });
const pinnedGroup = (page: Page) => page.getByRole("region", { name: en["home.pinned.title"] });

/** Open the Machines sheet from the dashboard header. */
async function openMachines(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: fill(en["connection.server.aria"], { name: LEAD }) }).click();
  return page.getByRole("dialog", { name: en["connection.server.title"] });
}

/** The Show switch on one machine's row: named by the column caption, then the machine. */
const showSwitch = (sheet: Locator, machine: string) =>
  sheet.getByRole("switch", { name: `${en["connection.server.show"]} ${machine}` });

/** Wait out the sheet's 200ms entrance: a box measured during the slide is where it passes through. */
async function sheetSettled(sheet: Locator): Promise<void> {
  await sheet.evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished));
  });
}

async function hidePeer(page: Page): Promise<void> {
  const sheet = await openMachines(page);
  await showSwitch(sheet, PEER).click();
  await expect(showSwitch(sheet, PEER)).toHaveAttribute("aria-checked", "false");
  // The switch is a filter, not an address: the sheet stays open and the URL stays on the lead.
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
}

test("hiding a machine drops its rows and chips, and its stand-in chip brings them back", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => headings(page)).toContain("moonward");
  const historyBefore = await page.evaluate(() => window.history.length);
  await expect(summary(page)).toHaveAccessibleName(/^2 needs you/u);

  // The addressed machine cannot be hidden, and says why.
  const sheet = await openMachines(page);
  await expect(showSwitch(sheet, LEAD)).toBeDisabled();
  await expect(showSwitch(sheet, LEAD)).toHaveAccessibleDescription(en["connection.server.showLocked"]);
  // Each switch owns a 44px cell beside its row: a tap 8px above the 24px track still flips it, and
  // never reaches the row, which would have navigated.
  await sheetSettled(sheet);
  const track = (await showSwitch(sheet, PEER).boundingBox())!;
  await page.mouse.click(track.x + track.width / 2, track.y - 8);
  await expect(showSwitch(sheet, PEER)).toHaveAttribute("aria-checked", "false");
  await page.mouse.click(track.x + track.width / 2, track.y + track.height + 8);
  await expect(showSwitch(sheet, PEER)).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL(/\/$/u);
  await page.keyboard.press("Escape");

  await hidePeer(page);

  // workshop's workspace left the list and the strip, and one dimmed stand-in chip took its place.
  await expect.poll(() => headings(page)).not.toContain("moonward");
  expect((await headings(page)).slice(0, 2)).toEqual(["webapp", "collie"]);
  await expect(strip(page).getByRole("button", { name: /moonward/u })).toHaveCount(0);
  await expect(standIn(page)).toBeVisible();
  await expect(standIn(page)).toContainText(PEER);
  await expect(standIn(page)).toHaveAccessibleDescription(/needs you/u);
  // Nothing is silenced: the summary line and the Dashboard badge still count the hidden machine.
  await expect(summary(page)).toHaveAccessibleName(/^2 needs you/u);
  await expect(dashboardTab(page)).toContainText("2");
  // No address changed and no history entry was added.
  await expect(page).toHaveURL(/\/$/u);
  expect(await page.evaluate(() => window.history.length)).toBe(historyBefore);

  // The choice is this device's: it survives a reload.
  await page.reload();
  await expect(standIn(page)).toBeVisible();
  await expect.poll(() => headings(page)).not.toContain("moonward");

  // The stand-in chip shows the machine again, in place.
  await standIn(page).click();
  await expect.poll(() => headings(page)).toContain("moonward");
  await expect(standIn(page)).toHaveCount(0);
  await expect(strip(page).getByRole("button", { name: /moonward/u })).toBeVisible();
  await expect(page).toHaveURL(/\/$/u);

  // And the sheet agrees.
  const again = await openMachines(page);
  await expect(showSwitch(again, PEER)).toHaveAttribute("aria-checked", "true");
});

test("a pinned pane on a hidden machine still leads the list", async ({ page }) => {
  await page.goto("/");
  // moonward's codex pane, on workshop: the codex row under the moonward heading, the last codex row
  // in place order (bluefin's collie comes first).
  const peerRow = page.getByRole("main").getByRole("button", { name: /^codex logo codex/u }).last();
  await peerRow.click({ button: "right" });
  const menu = page.getByRole("dialog");
  await menu.getByRole("button", { name: en["paneActions.pin.label"] }).click();
  await expect(menu).toHaveCount(0);
  await expect(pinnedGroup(page)).toBeVisible();

  await hidePeer(page);

  // The Pinned group leads, holding the hidden machine's pane; the machine's own group is gone.
  await expect.poll(() => headings(page)).not.toContain("moonward");
  expect((await headings(page)).slice(0, 3)).toEqual([en["home.pinned.title"], "webapp", "collie"]);
  await expect(pinnedGroup(page).getByRole("button", { name: /^codex logo codex/u })).toHaveCount(1);
  await expect(standIn(page)).toBeVisible();

  // Its tap still opens the pane on its own machine.
  await pinnedGroup(page).getByRole("button", { name: /^codex logo codex/u }).click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w1:p1")}\\?h=${PEER}$`, "u"));
});
