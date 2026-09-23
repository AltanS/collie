import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { ChangesResponse, SnapshotResponse } from "@/lib/types";
import { fixtureChanges, fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// THE DASHBOARD'S FOOTER ON A SMALL PHONE (ADR 0066). Three tabs at 375x812: Panes, Needs you,
// Changes. The claims a real engine has to check: a switch moves neither the footer nor the summary
// line, Needs you shows only what needs you (and the all-clear when nothing does), and Changes lists
// the workspaces with their counts and taps through to one workspace's Changes.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const footer = (page: Page) => page.getByRole("navigation", { name: en["home.tabs.aria"] });
const tab = (page: Page, name: RegExp) => footer(page).getByRole("button", { name });
const PANES = new RegExp(`^${en["home.tabs.panes"]}$`, "u");
const NEEDS = new RegExp(`^${en["status.section.needsYou"]}`, "u");
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

  for (const name of [NEEDS, CHANGES, PANES]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
    expect(await box(footer(page))).toEqual(f0);
    expect(await box(summary(page))).toEqual(s0);
  }
});

test("Needs you shows only the panes that need you, and survives a reload", async ({ page }) => {
  await page.goto("/");
  // Both workspaces under Panes.
  await expect(page.getByRole("heading", { name: "webapp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "collie" })).toBeVisible();
  // One blocked pane (webapp), so the tab carries a 1.
  await expect(tab(page, NEEDS)).toContainText("1");

  await tab(page, NEEDS).click();
  await expect(page.getByRole("heading", { name: "webapp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
  // The strip still offers every workspace: a filter removes rows, it never places.
  await expect(page.getByRole("navigation", { name: en["space.strip.title"] }).getByRole("button", { name: /collie/u })).toBeVisible();

  await page.reload();
  await expect(tab(page, NEEDS)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
});

test("Needs you with nothing urgent shows the all-clear line, not an empty list", async ({ page }) => {
  const calm: SnapshotResponse = structuredClone(fixtureSnapshot);
  for (const a of calm.agents) a.status = "working";
  await page.route("**/api/snapshot*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(calm) }),
  );
  await page.goto("/");
  await tab(page, NEEDS).click();
  await expect(page.getByText(en["home.allClear"])).toBeVisible();
  await expect(page.getByRole("heading", { name: "webapp" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "collie" })).toHaveCount(0);
  // No badge when nothing needs you.
  await expect(tab(page, NEEDS)).toHaveText(en["status.section.needsYou"]);
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
