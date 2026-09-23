import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { SnapshotResponse } from "@/lib/types";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// BACK GOES UP ONE LEVEL (ADR 0067). On an iPhone the edge swipe IS browser history back, so every
// case here drives `page.goBack()` as the swipe and asserts it lands one level up: never on the
// screen the operator just left sideways, never back down into a child they closed. 375x812, the
// narrowest iPhone still sold. The API is the shared fixture, routed by `fixtures/api.ts`.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no routes");
  test.skip(testInfo.project.name === "app-tablet", "a phone case; the tablet run would repeat it");
  await installApiStub(page);
});

const PANE_A = `/pane/${encodeURIComponent("w1:p1")}`;
const PANE_B = `/pane/${encodeURIComponent("w2:p1")}`;

/** The app path the page is on, mount-free: pathname plus query. */
function at(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

/** Wait for the app to settle on `path`. */
async function landed(page: Page, path: string) {
  await expect.poll(() => at(page)).toBe(path);
}

/** The dashboard, by the one control only it carries: the footer's views. */
const dashboard = (page: Page) => page.getByRole("navigation", { name: en["home.tabs.aria"] });

/** A pane row on the dashboard or in a space, by its agent name. */
const paneRow = (page: Page, agent: "claude" | "codex") =>
  page.getByRole("main").getByRole("button", { name: new RegExp(`^${agent} logo ${agent}`, "u") });

test("A: dashboard, pane A, switcher to pane B, then back is the dashboard", async ({ page }) => {
  await page.goto("/");
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);

  await page.getByRole("button", { name: en["chat.switcher.aria"] }).click();
  await page.getByRole("dialog", { name: en["chat.switcher.aria"] }).getByRole("button", { name: /^codex logo codex/u }).click();
  await landed(page, PANE_B);

  await page.goBack();
  await landed(page, "/");
  await expect(dashboard(page)).toBeVisible();
});

test("B: pane, History, X, then back is the pane's parent, never History again", async ({ page }) => {
  // A pane that has a transcript, so History is on offer.
  const withSession: SnapshotResponse = structuredClone(fixtureSnapshot);
  withSession.agents[0]!.hasSession = true;
  await page.route("**/api/snapshot*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(withSession) }),
  );
  await page.goto("/");
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);

  await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
  await page.getByRole("dialog").getByRole("button", { name: en["chat.history.label"] }).click();
  await landed(page, `${PANE_A}/history`);

  await page.getByRole("button", { name: en["history.closeAria"] }).click();
  await landed(page, PANE_A);

  await page.goBack();
  await landed(page, "/");
  await expect(dashboard(page)).toBeVisible();
});

test("settings, its back arrow, then back does not reopen settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: en["settings.title"] }).first().click();
  await landed(page, "/settings");

  await page.getByRole("button", { name: en["settings.nav.back"] }).click();
  await landed(page, "/");

  // The back arrow stepped back, so the dashboard is the first entry: a further back leaves the app
  // (or goes nowhere), and Settings is not waiting behind it.
  await page.goBack().catch(() => null);
  expect(at(page)).not.toMatch(/settings/u);
});

test("C: the dashboard's Changes tab, a workspace's Changes, then the header back is the dashboard", async ({ page }) => {
  await page.goto("/");
  await dashboard(page).getByRole("button", { name: new RegExp(`^${en["changes.title"]}$`, "u") }).click();
  await page.getByRole("list", { name: en["home.changes.listAria"] }).getByRole("button").first().click();
  await landed(page, "/space/w1/changes");

  await page.getByRole("button", { name: en["changes.backAria.dashboard"] }).click();
  await landed(page, "/");
  await expect(dashboard(page)).toBeVisible();
  await page.goBack().catch(() => null);
  expect(at(page)).not.toMatch(/changes/u);
});

test("D: dashboard, space, pane, header up is the space, then back is the dashboard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: /^working collie 2 panes/u }).click();
  await landed(page, "/space/w2");

  await paneRow(page, "codex").click();
  await landed(page, PANE_B);

  // The pane's up: the Collie mark in its header.
  await page.getByRole("button", { name: en["nav.home.aria.default"] }).click();
  await landed(page, "/space/w2");

  await page.goBack();
  await landed(page, "/");
  await expect(dashboard(page)).toBeVisible();
});

test("E: a cold deep link to a pane, then back is the dashboard", async ({ page }) => {
  // The installed app on iOS: `navigator.standalone`. A notification tap or a relaunch lands here.
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  await page.goto(PANE_A);
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toBeVisible();

  // A reload on the deep page does not seed a second time.
  const before = await page.evaluate(() => history.length);
  await page.reload();
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(before);

  await page.goBack();
  await landed(page, "/");
  await expect(dashboard(page)).toBeVisible();
});

test("E2: a deep link in a plain browser tab gets no seeded history", async ({ page }) => {
  // A desktop deep link opened in a new tab: not the installed app, no notification marker.
  await page.goto(PANE_A);
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toBeVisible();
  // The router's own stamp at index 0: nothing was put behind the entry.
  expect(await page.evaluate(() => JSON.stringify(history.state))).toContain('"idx":0');
});

test("E3: a window a notification opened is seeded, and loses its marker", async ({ page }) => {
  // `openWindow` in the service worker adds `from=notification` (lib/notification-open).
  await page.goto(`${PANE_A}?from=notification`);
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.search)).toBe("");
  await page.goBack();
  await landed(page, "/");
  await expect(dashboard(page)).toBeVisible();
});

test("a swipe back (POP) draws no slide of ours, the app's own up arrow still slides", async ({ page }) => {
  // The pane row and the pane's arrow glide instead where the engine has view transitions
  // (lib/glide.ts, e2e/pane-glide.spec.ts). The slide is what they fall back to, and what this case
  // pins, so the engine is taken away here.
  await page.addInitScript(() => Reflect.deleteProperty(Document.prototype, "startViewTransition"));
  const screen = page.locator("[data-slot='screen-transition']");
  await page.goto("/");
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  await expect(screen).toHaveClass(/slide-in-from-right/u);

  await page.goBack();
  await landed(page, "/");
  await expect(dashboard(page)).toBeVisible();
  await expect(screen).not.toHaveClass(/animate-in/u);

  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  await page.getByRole("button", { name: en["nav.home.aria.default"] }).click();
  await landed(page, "/");
  await expect(screen).toHaveClass(/slide-in-from-left/u);
});
