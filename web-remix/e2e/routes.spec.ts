import { expect, test } from "@playwright/test";

import { installRoutesApi } from "./routes-api";
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
    await expect(page.getByTestId("header-back")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 }).first()).not.toHaveText("");
    // One header, and the route drew none of its own.
    await expect(page.locator('[data-slot="app-header"]')).toHaveCount(1);
    await page.getByTestId("header-back").click();
    await expect(page).toHaveURL(level.up);
    expect(errors).toEqual([]);
  });
}
