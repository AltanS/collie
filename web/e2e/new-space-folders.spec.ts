import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureNewSpace } from "@/test/handlers";

import { fill, installApiStub } from "./fixtures/api";

// FAVOURITE AND RECENT FOLDERS IN THE NEW-SPACE SHEET (M40/02, issue 289). The machine's bridge keeps
// the list and records Recent itself after a create that worked; the sheet reads it when it opens,
// offers each folder as a row that FILLS the Directory field, and stars one into Favourites. What a
// real engine has to show: the create request is exactly today's, the folder is under Recent the
// next time the sheet opens, a star moves it, a tap fills the field and sends no create, and the
// rows keep the 44px floor with the star a 44px square beside the text. Open now, the third section,
// lists the folders the snapshot's panes sit in, fills on a tap and stars through the same route.
// 390x844, the phone, in Chromium and in WebKit.
//
// The stub (e2e/fixtures/api.ts) stands in for the bridge with one FolderWorld per page, so the list
// starts empty in every case.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone case; the tablet run would repeat it");
  await installApiStub(page);
});

const FOLDER = "/home/you/src/collie";
const SHOWN = "~/src/collie";

const sheet = (page: Page) => page.getByRole("dialog");
const recent = (page: Page) => sheet(page).getByRole("list", { name: en["space.new.folders.recent"] });
const favourites = (page: Page) => sheet(page).getByRole("list", { name: en["space.new.folders.favourites"] });
const openNow = (page: Page) => sheet(page).getByRole("list", { name: en["space.new.folders.open"] });
const use = (shown: string) => fill(en["space.new.folders.use"], { path: shown });
const dirField = (page: Page) => sheet(page).getByPlaceholder(en["space.new.dir.placeholder"]);
const createButton = (page: Page) => sheet(page).getByRole("button", { name: en["space.new.create"] });

async function openSheet(page: Page): Promise<void> {
  await page.getByRole("button", { name: en["space.overview.new.aria"] }).click();
  await expect(dirField(page)).toBeVisible();
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

test("a created folder is under Recent next time, a star moves it, and a tap fills the field", async ({ page }) => {
  const creates: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/workspace") creates.push(r);
  });

  await page.goto("/");
  await openSheet(page);
  // Nothing recorded yet: the sheet is the one that shipped before the list.
  await expect(recent(page)).toHaveCount(0);
  await expect(favourites(page)).toHaveCount(0);

  // Create a space in a folder. The request is exactly today's: the list asks for nothing extra.
  await dirField(page).fill(FOLDER);
  await createButton(page).click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent(fixtureNewSpace.pane.paneId)}$`, "u"));
  expect(creates).toHaveLength(1);
  expect(creates[0]!.postData()).toBe(JSON.stringify({ cwd: FOLDER }));

  // Next time the sheet opens, the folder the bridge recorded is under Recent.
  await page.goto("/");
  await openSheet(page);
  const row = recent(page).getByRole("button", { name: fill(en["space.new.folders.use"], { path: SHOWN }) });
  await expect(row).toBeVisible();
  await expect(recent(page).getByRole("listitem")).toHaveCount(1);
  await expect(row).toContainText("collie");
  await expect(row).toContainText(SHOWN);

  // The row keeps the 44px floor and the star is a 44px square beside it.
  const star = recent(page).getByRole("button", { name: fill(en["space.new.folders.star"], { folder: SHOWN }) });
  const rowBox = await box(row);
  const starBox = await box(star);
  expect(rowBox.height).toBeGreaterThanOrEqual(44);
  expect(Math.round(starBox.width)).toBe(44);
  expect(Math.round(starBox.height)).toBe(44);
  expect(starBox.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width - 1);

  // A star moves it to Favourites, pressed; Recent has nothing left to show.
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  const unstar = favourites(page).getByRole("button", {
    name: fill(en["space.new.folders.unstar"], { folder: SHOWN }),
  });
  await expect(unstar).toHaveAttribute("aria-pressed", "true");
  await expect(recent(page)).toHaveCount(0);

  // A tap fills the field with the full path, moves to Create, and creates nothing.
  await favourites(page).getByRole("button", { name: fill(en["space.new.folders.use"], { path: SHOWN }) }).click();
  await expect(dirField(page)).toHaveValue(FOLDER);
  await expect(createButton(page)).toBeFocused();
  expect(creates).toHaveLength(1);

  // An unstar puts it back under Recent.
  await unstar.click();
  await expect(favourites(page)).toHaveCount(0);
  await expect(recent(page).getByRole("listitem")).toHaveCount(1);
});

test("a create in home records nothing", async ({ page }) => {
  await page.goto("/");
  await openSheet(page);
  await createButton(page).click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent(fixtureNewSpace.pane.paneId)}$`, "u"));
  await page.goto("/");
  // The sheet reads its list when it opens; wait for that answer before asserting on an absence.
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/folders");
  await openSheet(page);
  expect(await (await read).json()).toEqual({ recent: [], favourites: [], home: fixtureNewSpace.pane.cwd });
  await expect(recent(page)).toHaveCount(0);
});

test("Open now offers the folders the panes sit in: a tap fills, a star makes a favourite", async ({ page }) => {
  const sent: Request[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === "POST" && (path === "/api/workspace" || path === "/api/folders/star")) sent.push(r);
  });

  await page.goto("/");
  await openSheet(page);
  // The stub snapshot's panes: `webapp` in workspace 1, then `collie` in workspace 2 (an agent and a
  // shell, one row). Place order, each folder once, and no request of its own.
  await expect(openNow(page).getByRole("listitem")).toHaveCount(2);
  await expect(openNow(page).getByRole("button", { name: /^Use / })).toHaveText(["webapp~/webapp", "collie~/collie"]);

  // A tap fills the field with the full path, moves to Create, and creates nothing.
  await openNow(page).getByRole("button", { name: use("~/collie") }).click();
  await expect(dirField(page)).toHaveValue("/home/you/collie");
  await expect(createButton(page)).toBeFocused();

  // A star is the same route, naming the pane's folder; the folder then sits under Favourites.
  await openNow(page).getByRole("button", { name: fill(en["space.new.folders.star"], { folder: "~/webapp" }) }).click();
  const unstar = favourites(page).getByRole("button", {
    name: fill(en["space.new.folders.unstar"], { folder: "~/webapp" }),
  });
  await expect(unstar).toHaveAttribute("aria-pressed", "true");
  await expect(openNow(page).getByRole("listitem")).toHaveCount(1);
  expect(sent.map((r) => [new URL(r.url()).pathname, r.postData()])).toEqual([
    ["/api/folders/star", JSON.stringify({ folder: "/home/you/webapp", starred: true })],
  ]);
});
