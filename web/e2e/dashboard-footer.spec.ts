import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { ChangesResponse, SnapshotResponse } from "@/lib/types";
import { fixtureChanges, fixtureSnapshot } from "@/test/handlers";

import { installApiStub, installCrewWorld, installMachinesWorld } from "./fixtures/api";

// THE DASHBOARD'S FOOTER ON A SMALL PHONE (ADR 0066, reshaped by ADR 0085). Two tabs at 375x812,
// Dashboard and Changes, and a Crew tab between them while a crew is configured. The claims a real
// engine has to check: a switch moves neither the footer nor the summary line, the needs-you switch
// in the summary line shows only what needs you (and the all-clear when nothing does), Crew exists
// only with a crew, and Changes lists the workspaces with their counts and taps through to one
// workspace's Changes.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const footer = (page: Page) => page.getByRole("navigation", { name: en["home.tabs.aria"] });
const tab = (page: Page, name: RegExp) => footer(page).getByRole("button", { name });
const DASHBOARD = new RegExp(`^${en["home.tabs.dashboard"]}`, "u");
const CREW = new RegExp(`^${en["crew.title"]}$`, "u");
/** The needs-you switch in the summary line's row (ADR 0085). */
const needsYou = (page: Page) => page.getByRole("button", { name: en["home.needsYouOnly"] });
const CHANGES = new RegExp(`^${en["files.title"]}$`, "u");
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
  await expect(tab(page, DASHBOARD)).toHaveAttribute("aria-current", "page");
  const f0 = await box(footer(page));
  const s0 = await box(summary(page));
  // The footer sits on the viewport's bottom edge.
  expect(Math.round(f0.y + f0.height)).toBe(812);

  for (const name of [CHANGES, DASHBOARD]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
    expect(await box(footer(page))).toEqual(f0);
    expect(await box(summary(page))).toEqual(s0);
  }
});

// A pinned pane (ADR 0070) leads every tab in a Pinned group, and that group sits UNDER the summary
// line, so the line and the footer still hold still across a switch with a pin set.
test("the needs-you switch moves neither the footer nor the summary line, and the row keeps its height", async ({ page }) => {
  await page.goto("/");
  const f0 = await box(footer(page));
  const s0 = await box(summary(page));
  const row0 = await box(needsYou(page).locator(".."));
  await needsYou(page).click();
  await expect(needsYou(page)).toHaveAttribute("aria-pressed", "true");
  expect(await box(footer(page))).toEqual(f0);
  expect(await box(summary(page))).toEqual(s0);
  expect(await box(needsYou(page).locator(".."))).toEqual(row0);
  // The switch is a 44px target.
  const target = await box(needsYou(page));
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
});

test("with a pane pinned, switching tabs still moves neither the footer nor the summary line", async ({ page }) => {
  await routeChanges(page);
  await page.goto("/");
  // Pin the collie codex pane through its own menu: the row's right-click is the hold's twin.
  await page.getByRole("main").getByRole("button", { name: /^codex logo codex/u }).click({ button: "right" });
  await page.getByRole("dialog").getByRole("button", { name: en["paneActions.pin.label"] }).click();
  const pinned = page.getByRole("region", { name: en["home.pinned.title"] });
  await expect(pinned).toBeVisible();
  const f0 = await box(footer(page));
  const s0 = await box(summary(page));

  for (const name of [CHANGES, DASHBOARD]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
    await expect(pinned).toBeVisible();
    expect(await box(footer(page))).toEqual(f0);
    expect(await box(summary(page))).toEqual(s0);
  }
});

// Crew lists machines, so it carries none of the pane chrome (ADR 0085): the workspace and order selects, the summary
// line with its switch and the Pinned group filter and count panes, and sit above nothing here.
// Dashboard and Changes keep them, and a switch between those two still moves nothing.
test("the Crew tab starts with the machine cards, and Dashboard and Changes keep their summary line still", async ({ page }) => {
  await installCrewWorld(page);
  await installMachinesWorld(page);
  await routeChanges(page);
  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: /^codex logo codex/u }).first().click({ button: "right" });
  await page.getByRole("dialog").getByRole("button", { name: en["paneActions.pin.label"] }).click();
  const pinned = page.getByRole("region", { name: en["home.pinned.title"] });
  const workspaceSelect = page.getByRole("combobox", { name: en["home.workspaceFilter.aria"] });
  await expect(pinned).toBeVisible();
  await expect(workspaceSelect).toBeVisible();

  const f0 = await box(footer(page));
  const s0 = await box(summary(page));
  for (const name of [CHANGES, DASHBOARD]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
    expect(await box(footer(page))).toEqual(f0);
    expect(await box(summary(page))).toEqual(s0);
  }

  await tab(page, CREW).click();
  await expect(tab(page, CREW)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "workshop", exact: true })).toBeVisible();
  await expect(workspaceSelect).toHaveCount(0);
  await expect(pinned).toHaveCount(0);
  await expect(needsYou(page)).toHaveCount(0);
  await expect(summary(page)).toHaveCount(0);
  // The first machine card sits right under the header, with no 44px controls row above it.
  const main = await box(page.getByRole("main"));
  const card = await box(page.getByRole("button", { name: "bluefin", exact: true }));
  expect(card.y - main.y).toBeLessThan(40);
});

test("the needs-you switch shows only the panes that need you, and survives a reload", async ({ page }) => {
  await page.goto("/");
  // Both workspaces with the switch off.
  await expect(page.getByRole("heading", { name: "webapp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "collie" })).toBeVisible();
  // One blocked pane (webapp), so the Dashboard tab carries a red 1.
  await expect(tab(page, DASHBOARD)).toContainText("1");

  await needsYou(page).click();
  await expect(page.getByRole("heading", { name: "webapp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
  // The select still offers every workspace: a filter removes rows, it never places.
  await expect(page.getByRole("combobox", { name: en["home.workspaceFilter.aria"] }).getByRole("option", { name: /^collie/u })).toBeAttached();
  // The mark stays on the Dashboard tab with the switch on.
  await expect(tab(page, DASHBOARD)).toContainText("1");

  await page.reload();
  await expect(needsYou(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
});

test("the needs-you switch hides the Spaces navigator, and Changes and Crew draw no switch", async ({ page }) => {
  await installCrewWorld(page);
  await routeChanges(page);
  await page.goto("/");
  const spaces = page.getByRole("button", { name: new RegExp(`^${en["space.overview.title"]}`, "u") });
  await expect(spaces).toBeVisible();
  await needsYou(page).click();
  await expect(spaces).toHaveCount(0);
  await tab(page, CHANGES).click();
  await expect(needsYou(page)).toHaveCount(0);
  await tab(page, CREW).click();
  await expect(needsYou(page)).toHaveCount(0);
  // Back on the Dashboard the switch is as it was left: on.
  await tab(page, DASHBOARD).click();
  await expect(needsYou(page)).toHaveAttribute("aria-pressed", "true");
});

test("a stored Focus tab opens the Dashboard with the switch on, once", async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("seeded") === null) {
      localStorage.setItem("seeded", "1");
      localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "focus" }));
    }
  });
  await page.goto("/");
  await expect(tab(page, DASHBOARD)).toHaveAttribute("aria-current", "page");
  await expect(needsYou(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
  // Turned off, it stays off after a reload: the migrated blob was written back.
  await needsYou(page).click();
  await page.reload();
  await expect(needsYou(page)).toHaveAttribute("aria-pressed", "false");
});

test("a solo Collie has no Crew tab; a crew has one, before Dashboard and Changes", async ({ page }) => {
  await page.goto("/");
  await expect(footer(page).getByRole("button")).toHaveCount(2);
  await expect(tab(page, CREW)).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await installApiStub(page);
  await installCrewWorld(page);
  await page.goto("/");
  await expect(footer(page).getByRole("button")).toHaveCount(3);
  // Crew, Dashboard, Changes: Dashboard is the default and sits in the middle.
  await expect(footer(page).getByRole("button").nth(0)).toHaveAccessibleName(CREW);
  await expect(footer(page).getByRole("button").nth(1)).toHaveAccessibleName(DASHBOARD);
  await expect(footer(page).getByRole("button").nth(2)).toHaveAccessibleName(CHANGES);
  await expect(tab(page, DASHBOARD)).toHaveAttribute("aria-current", "page");
  await tab(page, CREW).click();
  await expect(tab(page, CREW)).toHaveAttribute("aria-current", "page");
});

test("the needs-you switch with nothing urgent shows the all-clear line, not an empty list", async ({ page }) => {
  const calm: SnapshotResponse = structuredClone(fixtureSnapshot);
  for (const a of calm.agents) a.status = "working";
  await page.route("**/api/snapshot*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(calm) }),
  );
  await page.goto("/");
  await needsYou(page).click();
  await expect(page.getByText(en["home.allClear"])).toBeVisible();
  await expect(page.getByRole("heading", { name: "webapp" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
  // No badge when nothing needs you.
  await expect(tab(page, DASHBOARD)).toHaveText(en["home.tabs.dashboard"]);
});

// The badge rule (ADR 0066, on the Dashboard tab since ADR 0085): a red count means panes blocked on you; a finished pane you have not
// opened gets a quiet dot and no number; neither gets nothing. The mark is addressed by the tab's
// accessible name and its text, never by a class.
const named = (mark: string) => new RegExp(`^${en["home.tabs.dashboard"]}\\s*, ${mark}$`, "u");

async function withSnapshot(page: Page, edit: (snap: SnapshotResponse) => void) {
  const snap: SnapshotResponse = structuredClone(fixtureSnapshot);
  edit(snap);
  await page.route("**/api/snapshot*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(snap) }),
  );
}

test("The Dashboard badge: a red count only for blocked panes", async ({ page }) => {
  // One blocked pane (webapp) and one finished pane nobody opened: the count is 1, not 2.
  await withSnapshot(page, (snap) => {
    const other = snap.agents.find((a) => a.status !== "blocked")!;
    Object.assign(other, { status: "done", lastActiveAt: 2, lastSeenAt: 1 });
  });
  await page.goto("/");
  const dash = tab(page, DASHBOARD);
  // Chromium joins the word and the screen-reader span with a space: "Dashboard , 1 blocked".
  await expect(dash).toHaveAccessibleName(named("1 blocked"));
  const count = dash.getByText("1", { exact: true });
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

test("The Dashboard badge: a quiet dot and no number when only finished panes wait unseen", async ({ page }) => {
  await withSnapshot(page, (snap) => {
    for (const a of snap.agents) a.status = "working";
    Object.assign(snap.agents[0]!, { status: "done", lastActiveAt: 2, lastSeenAt: 1 });
  });
  await page.goto("/");
  const dash = tab(page, DASHBOARD);
  await expect(dash).toHaveAccessibleName(named(en["home.tabs.unseen"]));
  await expect(dash).not.toContainText(/\d/u);
  // The dot is the unseen mark (ui/unseen-mark.tsx), drawn inside the icon's aria-hidden corner:
  // the tab's own name already says it, so a screen reader hears it once.
  const dot = dash.getByRole("img", { name: en["home.row.unseen"], includeHidden: true });
  await expect(dot).toBeVisible();
});

test("The Dashboard badge: nothing when no pane is blocked or unseen", async ({ page }) => {
  await withSnapshot(page, (snap) => {
    for (const a of snap.agents) a.status = "working";
  });
  await page.goto("/");
  const dash = tab(page, DASHBOARD);
  await expect(dash).toHaveAccessibleName(en["home.tabs.dashboard"]);
  await expect(dash).toHaveText(en["home.tabs.dashboard"]);
  await expect(dash.getByRole("img", { name: en["home.row.unseen"], includeHidden: true })).toHaveCount(0);
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
  await tab(page, DASHBOARD).click();
  await expect(tab(page, DASHBOARD)).toHaveAttribute("aria-current", "page");
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
