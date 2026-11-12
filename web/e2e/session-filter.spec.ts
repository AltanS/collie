import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { AgentView, SnapshotResponse, WorkspaceView } from "@/lib/types";
import { fixtureAgents, fixtureSnapshot } from "@/test/handlers";

import { installApiStub, pinLocale } from "./fixtures/api";

// THE SESSION FILTER (M97). Above five session rows a filter field leads the switcher (the Switch pane
// sheet on a phone, the sidebar on a large screen) and the Dashboard offers it behind a magnifier. What a
// real engine has to show: typing narrows the rows and marks the matched letters, Enter opens the first
// row shown, the Dashboard's query survives a visit to a session, and a row that stays does not move
// while its marks change. Roles and accessible names only, the locale pinned to English. Both projects:
// app-phone (390x844) and app-tablet (820x1180, the large-screen layout).
//
// The world: the fixture herd (webapp holds a claude pane, collie a codex pane and a shell) plus four
// idle claude panes, two in each of two more spaces, moonward and scratch, so the list holds seven sessions.

test.use({ serviceWorkers: "block" });

const FILTER = en["sessionFilter.placeholder"];
const MOON_ROWS = ["api server", "migrations"] as const;
const OTHER_ROWS = ["notes", "ideas"] as const;

function extra(n: number, pane: number, workspaceLabel: string, sessionName: string): AgentView {
  return {
    ...fixtureAgents[0]!,
    paneId: `w${n}:p${pane}`,
    workspaceId: `w${n}`,
    workspaceNumber: n,
    workspaceLabel,
    tabId: `w${n}:t1`,
    sessionName,
    status: "idle",
    cwd: `/home/you/${workspaceLabel}`,
  };
}

function space(n: number, label: string): WorkspaceView {
  return { workspaceId: `w${n}`, number: n, label, focused: false, activeTabId: `w${n}:t1`, tabCount: 1, paneCount: 2 };
}

async function sevenSessions(page: Page) {
  const snap: SnapshotResponse = structuredClone(fixtureSnapshot);
  snap.agents = [...snap.agents, extra(5, 1, "moonward", "api server"), extra(5, 2, "moonward", "migrations"), extra(6, 1, "scratch", "notes"), extra(6, 2, "scratch", "ideas")];
  snap.workspaces = [...snap.workspaces, space(5, "moonward"), space(6, "scratch")];
  await page.route("**/api/snapshot*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snap) }));
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  await pinLocale(page, "en");
  await installApiStub(page);
  await sevenSessions(page);
});

/**
 * The matched letters: `<mark>` has the ARIA 1.3 role `mark`, which Playwright's role engine computes
 * but its `AriaRole` type does not list yet.
 */
// SAFETY: `mark` is a role Playwright's engine resolves (these cases find marks with it in Chromium);
// only the string union of its role parameter is missing the name.
const MARK = "mark" as Parameters<Page["getByRole"]>[0];

/** A session row by the session's name. */
const row = (scope: Page | Locator, name: string) => scope.getByRole("button", { name: new RegExp(name, "u") });
const field = (scope: Page | Locator) => scope.getByRole("textbox", { name: FILTER });

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** The next painted frame: what a keystroke changed has been laid out by then. */
const nextFrame = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** A row's box once it has come to rest: the sheet eases its height when rows leave, so read until two frames agree. */
async function restingBox(page: Page, l: Locator) {
  let last = await box(l);
  await expect
    .poll(async () => {
      await nextFrame(page);
      const now = await box(l);
      const same = JSON.stringify(now) === JSON.stringify(last);
      last = now;
      return same;
    })
    .toBe(true);
  return last;
}

/** The switcher: the Switch pane sheet on a phone, the sidebar on a large screen. Opened from a pane. */
async function openSwitcher(page: Page, wide: boolean): Promise<Locator> {
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  if (wide) {
    const sidebar = page.getByRole("complementary", { name: en["wide.sidebar.label"] });
    await expect(sidebar).toBeVisible();
    return sidebar;
  }
  await page.getByRole("button", { name: en["chat.switcher.aria"] }).click();
  const sheet = page.getByRole("dialog", { name: en["chat.switcher.aria"] });
  await expect(sheet).toBeVisible();
  return sheet;
}

test("switcher: typing narrows the rows and marks the letters, a kept row does not move, Enter switches", async ({ page }, testInfo) => {
  const list = await openSwitcher(page, testInfo.project.name === "app-tablet");
  for (const name of [...MOON_ROWS, ...OTHER_ROWS]) await expect(row(list, name)).toBeVisible();

  await field(list).fill("moonwar");
  for (const name of MOON_ROWS) await expect(row(list, name)).toBeVisible();
  for (const name of OTHER_ROWS) await expect(row(list, name)).toHaveCount(0);
  await expect(list.getByRole(MARK).first()).toBeVisible();

  // One more letter keeps the same rows: the kept row repaints its marks and stays where it was.
  const kept = row(list, MOON_ROWS[1]);
  const before = await restingBox(page, kept);
  await field(list).press("End");
  await field(list).press("d");
  await expect(field(list)).toHaveValue("moonward");
  for (const name of OTHER_ROWS) await expect(row(list, name)).toHaveCount(0);
  await nextFrame(page);
  expect(await box(kept)).toEqual(before);

  await field(list).press("Enter");
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w5:p1")}$`, "u"));
});

test("Dashboard: the magnifier opens the field, the rows narrow, and the query survives a visit to a session", async ({ page }) => {
  await page.goto("/");
  const main = page.getByRole("main");
  const magnifier = page.getByRole("button", { name: en["sessionFilter.toggle"], exact: true });
  await expect(field(main)).toHaveCount(0);
  await magnifier.click();
  await expect(magnifier).toHaveAttribute("aria-pressed", "false");

  // The magnifier reads pressed while a query is set.
  // A Dashboard row draws the session's name, so a match there is marked (the space is the group's heading).
  await field(main).fill("migration");
  await expect(magnifier).toHaveAttribute("aria-pressed", "true");
  const kept = row(main, "migrations");
  await expect(kept).toBeVisible();
  for (const name of ["api server", ...OTHER_ROWS]) await expect(row(main, name)).toHaveCount(0);
  await expect(kept.getByRole(MARK).first()).toBeVisible();

  const before = await restingBox(page, kept);
  // The caret goes to the end first: a focus from the test may set it at the start.
  await field(main).press("End");
  await field(main).press("s");
  await expect(field(main)).toHaveValue("migrations");
  await nextFrame(page);
  expect(await box(kept)).toEqual(before);

  await kept.click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent("w5:p2")}$`, "u"));
  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
  await expect(field(page.getByRole("main"))).toHaveValue("migrations");
  await expect(magnifier).toHaveAttribute("aria-pressed", "true");
  for (const name of ["api server", ...OTHER_ROWS]) await expect(row(page.getByRole("main"), name)).toHaveCount(0);
});
