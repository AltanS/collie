import { expect, test } from "@playwright/test";

import { installRoutesApi, SNAPSHOT, type StubHandler } from "./routes-api";
import { changesStub } from "./routes-changes-api";
import { crewStub } from "./routes-crew-api";
import { historyStub } from "./routes-history-api";
import { machinesStub } from "./routes-machines-api";
import { settingsStub } from "./routes-settings-api";

// Wave 4, across routes: every route draws the Shell's ONE header with the override row (the size-11
// ArrowLeft and an h1, no Collie identity block), and the arrow goes UP one level on a cold deep link
// (ADR 0067: a replace onto the structural parent, never a push). The per-area specs
// (`routes-<area>.spec.ts`) cover each screen's own behaviour; this one covers what they share.

test.use({ serviceWorkers: "block" });

interface Level {
  name: string;
  path: string;
  up: RegExp;
}

const LEVELS: readonly Level[] = [
  { name: "crew", path: "/crew", up: /\/settings\/system$/u },
  { name: "machines", path: "/machines", up: /\/settings$/u },
  { name: "machine", path: "/machines/lead", up: /\/machines$/u },
  { name: "history", path: "/pane/w1%3Ap1/history", up: /\/pane\/w1%3Ap1$/u },
  { name: "pane changes", path: "/pane/w1%3Ap1/changes", up: /\/pane\/w1%3Ap1$/u },
  { name: "space changes", path: "/space/w1/changes", up: /\/space\/w1$/u },
  { name: "settings", path: "/settings", up: /\/$/u },
  { name: "settings alerts", path: "/settings/alerts", up: /\/settings$/u },
  { name: "settings system", path: "/settings/system", up: /\/settings$/u },
  { name: "settings device", path: "/settings/device", up: /\/settings$/u },
  { name: "settings appearance", path: "/settings/appearance", up: /\/settings$/u },
];

for (const level of LEVELS) {
  test(`${level.name}: override header, and back goes up`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await installRoutesApi(page, [crewStub("crew"), machinesStub().handler, historyStub("long"), changesStub(), settingsStub().handler]);
    await page.goto(level.path);
    // History keeps web's header (the mark goes up; the find bar alone takes the row over), the rest wear the arrow.
    const back = level.name === "history" ? "header-home" : "header-back";
    await expect(page.getByTestId(back)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 }).first()).not.toHaveText("");
    // One header, and the route drew none of its own.
    await expect(page.locator('[data-slot="app-header"]')).toHaveCount(1);
    await page.getByTestId(back).click();
    await expect(page).toHaveURL(level.up);
    expect(errors).toEqual([]);
  });
}

// The update ribbon is the Shell's, not a route's: web mounts it once in RootLayout, so every route starts
// below the same 33 px band when the snapshot reports a release. (Remix mounted it from home and space
// only, which put every other screen 33 px higher than web's.)
const OFFER: StubHandler = (ctx) => {
  if (ctx.method !== "GET" || ctx.url.pathname !== "/api/snapshot") return false;
  void ctx.json(200, {
    ...SNAPSHOT,
    update: { current: "1.17.0", latest: "1.17.1", latestUrl: null, releaseAvailable: true, majorAvailable: null, majorUrl: null, bridgeStale: false, checkedAt: null },
  });
  return true;
};

const RIBBON_ROUTES: readonly { name: string; path: string }[] = [
  { name: "home", path: "/" },
  { name: "space", path: "/space/w1" },
  { name: "pane", path: "/pane/w1%3Ap1" },
  ...LEVELS.map(({ name, path }) => ({ name, path })),
];

for (const route of RIBBON_ROUTES) {
  test(`${route.name}: the update ribbon draws above the header`, async ({ page }) => {
    await installRoutesApi(page, [OFFER, crewStub("crew"), machinesStub().handler, historyStub("long"), changesStub(), settingsStub().handler]);
    await page.goto(route.path);
    await expect(page.getByTestId("update-ribbon")).toContainText("1.17.1");
    // The header starts where the band ends: 33 px down on every route, web's measure at this width.
    await expect.poll(async () => (await page.locator("header").first().boundingBox())?.y).toBeCloseTo(33, 0);
  });
}
