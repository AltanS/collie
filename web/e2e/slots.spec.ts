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

const STATUS_WORDS = [
  en["status.label.blocked"],
  en["status.label.working"],
  en["status.label.idle"],
  en["status.label.done"],
  en["status.label.unknown"],
].join("|");

/** A row of the switcher or the wide sidebar: the mark on its logo may say the pane's status, so the name is "codex logo working codex ...". */
const sidebarRow = (agent: Agent) => ({ name: new RegExp(`^${agent} logo (?:(?:${STATUS_WORDS}) )?${agent}`, "u") });

const paneSwitcher = (page: Page) => page.getByRole("button", { name: en["chat.switcher.aria"] });

/** The wide layout has a pane rail instead of the switcher, and no phone header. */
const isWide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

/** The control only a drawn pane carries, in either layout. */
const paneControl = (page: Page, address: string) =>
  isWide(page)
    ? page.getByRole("button", { name: fill(en["chat.header.openPaneSettingsAria"], { name: address.startsWith(PANE_A) ? "claude" : "codex" }) })
    : paneSwitcher(page);

/** The pane is on screen: the layout has rendered this address, not only the URL bar. */
async function paneShown(page: Page, address: string) {
  await landed(page, address);
  await expect(paneControl(page, address)).toBeVisible();
}

/** A move from one pane to another by the app's own control for this layout. */
async function moveToPane(page: Page, agent: Agent) {
  const row = sidebarRow(agent);
  if (isWide(page)) {
    await page.getByRole("complementary", { name: en["wide.sidebar.label"] }).getByRole("button", row).click();
    return;
  }
  await paneSwitcher(page).click();
  await page.getByRole("dialog", { name: en["chat.switcher.aria"] }).getByRole("button", row).click();
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
  await expect(paneControl(page, tile.opens === "claude" ? PANE_A : PANE_B)).toBeVisible();
  await moveToPane(page, tile.movesTo);
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
  test.slow(); // fifteen page loads, see the budget note at "going back from a restored tile"
  await workInFiveTiles(context);

  for (const tile of TILES) {
    const page = await openTab(context, `/slot/${tile.slot}`);
    await paneShown(page, tile.address);
  }
});

const agentOf = (slot: number): Agent => (slot % 2 === 1 ? "claude" : "codex");
const addressOf = (slot: number) => (agentOf(slot) === "claude" ? PANE_A : PANE_B);

// Two tabs of one browser see each other's localStorage writes with a delay, so tiles that move in
// the same moment must not cost each other their address.
test("@oracle:requirement @req:SLOT-4 five tiles that move in the same moment each keep their own pane", async ({ context }) => {
  const pages = await Promise.all(TILES.map((tile) => openTab(context, `/slot/${tile.slot}`)));
  await Promise.all(pages.map((page) => landed(page, "/")));

  await Promise.all(TILES.map((tile, idx) => paneRow(pages[idx]!, agentOf(tile.slot)).click()));
  await Promise.all(TILES.map((tile, idx) => paneShown(pages[idx]!, addressOf(tile.slot))));
  await Promise.all(pages.map((page) => page.close()));

  for (const tile of TILES) {
    const page = await openTab(context, `/slot/${tile.slot}`);
    await paneShown(page, addressOf(tile.slot));
  }
});

test("@oracle:requirement @req:SLOT-4 going back from a restored tile does not return to /slot/n", async ({ context }) => {
  // Twenty page loads: 19 to 30 s measured on a loaded host, against a default budget of 30 s.
  // The two cases with fifteen page loads need the slow budget too: WebKit takes about 15 s idle and
  // over 30 s on a loaded runner (Chromium about 6 s). They carry test.slow() as well.
  // Open question, not fixed here: in CI this case once restored the first pane (w1) instead of the
  // last (w2) on its first attempt. The slot write runs in a passive effect (use-slot-memory.ts) and
  // the spec closes the page right after the URL shows, so a write may be lost under load.
  test.slow();
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
  await restored.getByRole("dialog", { name: en["chat.switcher.aria"] }).getByRole("button", sidebarRow("codex")).click();
  await paneShown(restored, PANE_B);
  await restored.close();

  const reopened = await openTab(context, "/slot/1");
  await paneShown(reopened, PANE_B);
  const other = await openTab(context, "/slot/3");
  await paneShown(other, `${PANE_A}${SCOPED}`);
});

// The owner's laptop: the wide layout, where the tiles really live.
test.describe("on the owner's laptop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("@oracle:requirement @req:SLOT-4 after a browser restart each of five wide tiles returns to its own pane", async ({ context }) => {
    test.slow(); // fifteen page loads, see the budget note at "going back from a restored tile"
    await workInFiveTiles(context);

    for (const tile of TILES) {
      const page = await openTab(context, `/slot/${tile.slot}`);
      await paneShown(page, tile.address);
    }
  });
});
