import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { fill, installApiStub } from "./fixtures/api";

// THE OWNER'S FIVE TILES, in a real browser. «при закрытии и открытии браузера оставались те же
// проекты в которых я работал до закрытия браузера». One browser context is one browser: its pages
// share localStorage, and each page has a sessionStorage that closes with it. The move to a pane is
// always the app's own, by a click and never by `page.goto`, because a tile stands on the saved
// address and moves inside the app. The rules of a slot are pinned in src/lib/slots.test.ts.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(({ context: _context }, testInfo) => {
  test.skip(testInfo.project.name === "app-tablet", "a browser-storage case; the tablet run would repeat it");
});

const PANE_A = `/pane/${encodeURIComponent("w1:p1")}`;
const PANE_B = `/pane/${encodeURIComponent("w2:p1")}`;
const SESSION = "collie-demo";
const SCOPED = `?s=${SESSION}`;

type Agent = "claude" | "codex";

/** What one tile does before the browser closes, and the address it must come back to. */
interface Tile {
  readonly slot: number;
  readonly session?: string;
  readonly opens: Agent;
  readonly movesTo?: Agent;
  readonly address: string;
}

const TILES: readonly Tile[] = [
  { slot: 1, opens: "claude", address: PANE_A },
  { slot: 2, opens: "codex", address: PANE_B },
  { slot: 3, session: SESSION, opens: "claude", address: `${PANE_A}${SCOPED}` },
  { slot: 4, session: SESSION, opens: "codex", address: `${PANE_B}${SCOPED}` },
  // This tile changes pane once more: the slot must hold the last pane, not the first.
  { slot: 5, session: SESSION, opens: "claude", movesTo: "codex", address: `${PANE_B}${SCOPED}` },
];

/** The app path the page is on: pathname plus query. */
function at(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

async function landed(page: Page, path: string) {
  await expect.poll(() => at(page)).toBe(path);
}

/** A new tab with the API answered, at this address. */
async function openTab(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  await installApiStub(page);
  await page.goto(path);
  return page;
}

const paneRow = (page: Page, agent: Agent) =>
  page.getByRole("main").getByRole("button", { name: new RegExp(`^${agent} logo ${agent}`, "u") });

const paneSwitcher = (page: Page) => page.getByRole("button", { name: en["chat.switcher.aria"] });

/** The pane is on screen: the layout has rendered this address, not only the URL bar. */
async function paneShown(page: Page, address: string) {
  await landed(page, address);
  await expect(paneSwitcher(page)).toBeVisible();
}

async function switchSession(page: Page, session: string) {
  await page.getByRole("button", { name: fill(en["connection.session.aria"], { name: "default" }) }).click();
  await page.getByRole("dialog", { name: en["connection.session.title"] }).getByRole("button", { name: new RegExp(session, "u") }).click();
  await landed(page, `/?s=${session}`);
}

async function moveInsideApp(page: Page, tile: Tile) {
  if (tile.session !== undefined) await switchSession(page, tile.session);
  await paneRow(page, tile.opens).click();
  if (tile.movesTo === undefined) {
    await paneShown(page, tile.address);
    return;
  }
  await expect(paneSwitcher(page)).toBeVisible();
  await paneSwitcher(page).click();
  await page.getByRole("dialog", { name: en["chat.switcher.aria"] }).getByRole("button", { name: new RegExp(`^${tile.movesTo} logo ${tile.movesTo}`, "u") }).click();
  await paneShown(page, tile.address);
}

/** Every tile opens its slot while all the others are open, then each moves inside the app in turn. */
async function workInFiveTiles(context: BrowserContext) {
  const pages: Page[] = [];
  for (const tile of TILES) {
    const page = await openTab(context, `/slot/${tile.slot}`);
    await landed(page, "/");
    pages.push(page);
  }
  for (const [idx, tile] of TILES.entries()) await moveInsideApp(pages[idx]!, tile);
  await Promise.all(pages.map((page) => page.close()));
}

test("@oracle:requirement @req:SLOT-4 after a browser restart each of five tiles returns to its own pane", async ({ context }) => {
  await workInFiveTiles(context);

  for (const tile of TILES) {
    const page = await openTab(context, `/slot/${tile.slot}`);
    await paneShown(page, tile.address);
  }
});

test("@oracle:requirement @req:SLOT-4 going back from a restored tile does not return to /slot/n", async ({ context }) => {
  await workInFiveTiles(context);

  for (const tile of TILES) {
    const page = await openTab(context, "/settings");
    await page.goto(`/slot/${tile.slot}`);
    await paneShown(page, tile.address);
    await page.goBack();
    await landed(page, "/settings");
    await page.close();
  }

  // A tile opened directly has nothing before it: back leaves the app and never lands on the slot.
  for (const tile of TILES) {
    const page = await openTab(context, `/slot/${tile.slot}`);
    await paneShown(page, tile.address);
    await page.goBack();
    expect(page.url()).not.toContain("/slot/");
    await page.close();
  }
});

test("@oracle:requirement @req:SLOT-4 a restored tile keeps storing: the next restart returns its newer pane", async ({ context }) => {
  await workInFiveTiles(context);

  const restored = await openTab(context, "/slot/1");
  await paneShown(restored, PANE_A);
  await paneSwitcher(restored).click();
  await restored.getByRole("dialog", { name: en["chat.switcher.aria"] }).getByRole("button", { name: /^codex logo codex/u }).click();
  await paneShown(restored, PANE_B);
  await restored.close();

  const reopened = await openTab(context, "/slot/1");
  await paneShown(reopened, PANE_B);
  const other = await openTab(context, "/slot/3");
  await paneShown(other, `${PANE_A}${SCOPED}`);
});
