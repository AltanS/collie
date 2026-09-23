import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { ChangesResponse, SnapshotResponse } from "@/lib/types";
import { fixtureChanges, fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// THE DASHBOARD'S FOOTER ON A SMALL PHONE (ADR 0066, tab renamed Focus by ADR 0068). Three tabs at
// 375x812: Panes, Focus, Changes. The claims a real engine has to check: a switch moves neither the
// footer nor the summary line, Focus shows only what needs you (and the all-clear when nothing
// does), and Changes lists the workspaces with their counts and taps through to one workspace's
// Changes.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const footer = (page: Page) => page.getByRole("navigation", { name: en["home.tabs.aria"] });
const tab = (page: Page, name: RegExp) => footer(page).getByRole("button", { name });
const PANES = new RegExp(`^${en["home.tabs.panes"]}$`, "u");
const FOCUS = new RegExp(`^${en["home.tabs.focus"]}`, "u");
const CHANGES = new RegExp(`^${en["changes.title"]}$`, "u");
/** The summary line: the one button in the list that opens on a count of what needs you, or the all-clear. */
const summary = (page: Page) => page.getByRole("main").getByRole("button", { name: /^(\d+ needs you|Nothing needs you)/u });

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** Answer each workspace's Changes on its own: webapp has the shared fixture, collie is clean. */
async function routeChanges(page: Page) {
  const clean: ChangesResponse = { workspaceId: "w2", available: true, root: "/home/you/collie", truncated: false, repos: [] };
  await page.route("**/api/workspace/*/changes*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]!);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(id === "w1" ? fixtureChanges : clean) });
  });
}

test("switching tabs moves neither the footer nor the summary line", async ({ page }) => {
  await routeChanges(page);
  await page.goto("/");
  await expect(tab(page, PANES)).toHaveAttribute("aria-current", "page");
  const f0 = await box(footer(page));
  const s0 = await box(summary(page));
  // The footer sits on the viewport's bottom edge.
  expect(Math.round(f0.y + f0.height)).toBe(812);

  for (const name of [FOCUS, CHANGES, PANES]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
    expect(await box(footer(page))).toEqual(f0);
    expect(await box(summary(page))).toEqual(s0);
  }
});

test("Focus shows only the panes that need you, and survives a reload", async ({ page }) => {
  await page.goto("/");
  // Both workspaces under Panes.
  await expect(page.getByRole("heading", { name: "webapp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "collie" })).toBeVisible();
  // One blocked pane (webapp), so the tab carries a red 1.
  await expect(tab(page, FOCUS)).toContainText("1");

  await tab(page, FOCUS).click();
  await expect(page.getByRole("heading", { name: "webapp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
  // The strip still offers every workspace: a filter removes rows, it never places.
  await expect(page.getByRole("navigation", { name: en["space.strip.title"] }).getByRole("button", { name: /collie/u })).toBeVisible();

  await page.reload();
  await expect(tab(page, FOCUS)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
});

test("Focus with nothing urgent shows the all-clear line, not an empty list", async ({ page }) => {
  const calm: SnapshotResponse = structuredClone(fixtureSnapshot);
  for (const a of calm.agents) a.status = "working";
  await page.route("**/api/snapshot*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(calm) }),
  );
  await page.goto("/");
  await tab(page, FOCUS).click();
  await expect(page.getByText(en["home.allClear"])).toBeVisible();
  await expect(page.getByRole("heading", { name: "webapp" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
  // No badge when nothing needs you.
  await expect(tab(page, FOCUS)).toHaveText(en["home.tabs.focus"]);
});

// The badge rule (ADR 0066): a red count means panes blocked on you; a finished pane you have not
// opened gets a quiet dot and no number; neither gets nothing. The mark is addressed by the tab's
// accessible name and its text, never by a class.
const named = (mark: string) => new RegExp(`^${en["home.tabs.focus"]}\\s*, ${mark}$`, "u");

async function withSnapshot(page: Page, edit: (snap: SnapshotResponse) => void) {
  const snap: SnapshotResponse = structuredClone(fixtureSnapshot);
  edit(snap);
  await page.route("**/api/snapshot*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(snap) }),
  );
}

test("Focus's badge: a red count only for blocked panes", async ({ page }) => {
  // One blocked pane (webapp) and one finished pane nobody opened: the count is 1, not 2.
  await withSnapshot(page, (snap) => {
    const other = snap.agents.find((a) => a.status !== "blocked")!;
    Object.assign(other, { status: "done", lastActiveAt: 2, lastSeenAt: 1 });
  });
  await page.goto("/");
  const focus = tab(page, FOCUS);
  // Chromium joins the word and the screen-reader span with a space: "Focus , 1 blocked".
  await expect(focus).toHaveAccessibleName(named("1 blocked"));
  const count = focus.getByText("1", { exact: true });
  await expect(count).toBeVisible();
  // Red: the badge wears the blocked status colour, the same token the status dot uses.
  const red = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-status-blocked)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  await expect(count).toHaveCSS("background-color", red);
});

test("Focus's badge: a quiet dot and no number when only finished panes wait unseen", async ({ page }) => {
  await withSnapshot(page, (snap) => {
    for (const a of snap.agents) a.status = "working";
    Object.assign(snap.agents[0]!, { status: "done", lastActiveAt: 2, lastSeenAt: 1 });
  });
  await page.goto("/");
  const focus = tab(page, FOCUS);
  await expect(focus).toHaveAccessibleName(named(en["home.tabs.unseen"]));
  await expect(focus).not.toContainText(/\d/u);
  // The dot is the unseen mark (ui/unseen-mark.tsx), drawn inside the icon's aria-hidden corner:
  // the tab's own name already says it, so a screen reader hears it once.
  const dot = focus.getByRole("img", { name: en["home.row.unseen"], includeHidden: true });
  await expect(dot).toBeVisible();
});

test("Focus's badge: nothing when no pane is blocked or unseen", async ({ page }) => {
  await withSnapshot(page, (snap) => {
    for (const a of snap.agents) a.status = "working";
  });
  await page.goto("/");
  const focus = tab(page, FOCUS);
  await expect(focus).toHaveAccessibleName(en["home.tabs.focus"]);
  await expect(focus).toHaveText(en["home.tabs.focus"]);
  await expect(focus.getByRole("img", { name: en["home.row.unseen"], includeHidden: true })).toHaveCount(0);
});

test("Changes lists each workspace with its counts and opens the workspace's Changes", async ({ page }) => {
  await routeChanges(page);
  await page.goto("/");
  await tab(page, CHANGES).click();
  const list = page.getByRole("list", { name: en["home.changes.listAria"] });
  const rows = list.getByRole("button");
  await expect(rows).toHaveCount(2);
  // fixtureChanges: five files over two repos, +10 −2.
  await expect(rows.nth(0)).toContainText("webapp");
  await expect(rows.nth(0)).toContainText("5 files");
  await expect(rows.nth(0)).toContainText("+10 −2");
  await expect(rows.nth(1)).toContainText("collie");
  await expect(rows.nth(1)).toContainText(en["home.changes.clean"]);

  await rows.nth(0).click();
  await expect(page).toHaveURL(/\/space\/w1\/changes$/u);
});

/** Like `routeChanges`, but every answer waits `ms` first, so the loading state can be seen. */
async function routeChangesSlowly(page: Page, ms: number) {
  const clean: ChangesResponse = { workspaceId: "w2", available: true, root: "/home/you/collie", truncated: false, repos: [] };
  await page.route("**/api/workspace/*/changes*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]!);
    await new Promise((r) => setTimeout(r, ms));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(id === "w1" ? fixtureChanges : clean) }).catch(() => {});
  });
}

const countLines = (page: Page) => page.getByRole("list", { name: en["home.changes.listAria"] }).locator('[data-slot="count-line"]');

test("Changes shows a skeleton first, then the numbers, and the row does not move", async ({ page }) => {
  await routeChangesSlowly(page, 1200);
  await page.goto("/");
  await tab(page, CHANGES).click();
  const rows = page.getByRole("list", { name: en["home.changes.listAria"] }).getByRole("button");
  const line = countLines(page).first();
  await expect(line).toHaveAttribute("data-state", "loading");
  await expect(line.locator(".count-skeleton")).toBeVisible();
  const before = await box(rows.first());
  await expect(rows.first()).toContainText("5 files");
  await expect(line).toHaveAttribute("data-state", "arrive");
  const after = await box(rows.first());
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(0.5);
  // The dimmed row arrives the same way.
  await expect(countLines(page).nth(1)).toHaveAttribute("data-state", "arrive");
  await expect(rows.nth(1)).toContainText(en["home.changes.clean"]);
});

test("Changes shows the last numbers at once when the tab is entered again", async ({ page }) => {
  await routeChangesSlowly(page, 300);
  await page.goto("/");
  await tab(page, CHANGES).click();
  const rows = page.getByRole("list", { name: en["home.changes.listAria"] }).getByRole("button");
  await expect(rows.first()).toContainText("5 files");
  await tab(page, PANES).click();
  await expect(tab(page, PANES)).toHaveAttribute("aria-current", "page");
  // The answers now take far longer than the check below waits: only the kept numbers can pass it.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await routeChangesSlowly(page, 5000);
  await tab(page, CHANGES).click();
  const first = await countLines(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  expect(first).toEqual(["still", "still"]);
  await expect(rows.first()).toContainText("5 files", { timeout: 500 });
  await expect(rows.nth(1)).toContainText(en["home.changes.clean"], { timeout: 500 });
});

test("with reduced motion the numbers replace the skeleton with no transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await routeChangesSlowly(page, 600);
  await page.goto("/");
  await tab(page, CHANGES).click();
  const line = countLines(page).first();
  const skeleton = line.locator(".count-skeleton");
  await expect(line).toHaveAttribute("data-state", "loading");
  expect(await skeleton.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  await expect(line).toHaveAttribute("data-state", "arrive");
  const style = await line.evaluate((e) => {
    const text = e.querySelector(".count-arrive")!;
    const bar = e.querySelector(".count-skeleton")!;
    return { text: getComputedStyle(text).animationName, bar: getComputedStyle(bar).transitionDuration, opacity: getComputedStyle(bar).opacity };
  });
  expect(style).toEqual({ text: "none", bar: "0s", opacity: "0" });
});
