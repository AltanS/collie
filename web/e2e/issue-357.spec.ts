import { expect, test } from "@playwright/test";

import { fixtureCrewSnapshot } from "@/test/handlers";
import { installApiStub, installCrewWorld, pinLocale } from "./fixtures/api";

test.use({ serviceWorkers: "block" });

test("failed member-scoped snapshot does not infer a mux failure from lead config", async ({ page }) => {
  await installApiStub(page);
  await installCrewWorld(page);
  await pinLocale(page, "en");
  let unavailable = false;
  await page.route((url) => url.pathname === "/api/snapshot", async (route) => {
    if (unavailable && new URL(route.request().url()).searchParams.get("host") === "workshop") {
      await route.fulfill({ status: 502, json: { error: "member unreachable" } });
      return;
    }
    await route.fulfill({ json: fixtureCrewSnapshot });
  });
  await page.goto("/?h=workshop");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).not.toBeVisible();
  unavailable = true;
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert").filter({ hasText: "Can't reach Collie" })).toBeVisible();
});

test("member pane outage with a muxless lead does not blame the member mux", async ({ page }) => {
  await installApiStub(page);
  await installCrewWorld(page);
  await pinLocale(page, "en");
  let unavailable = false;
  await page.route((url) => url.pathname === "/api/snapshot", async (route) => {
    await route.fulfill({ json: {
      ...fixtureCrewSnapshot,
      bridge: "disconnected",
      ts: 400_000,
      servers: fixtureCrewSnapshot.servers!.map((server) => server.id === "workshop"
        ? Object.assign({}, server, { reachable: !unavailable, lastSeenAt: unavailable ? 990 : 400_000, linkState: unavailable ? "reconnecting" : undefined })
        : server),
    } });
  });
  await page.route((url) => url.pathname === "/api/pane/w1%3Ap1", async (route) => {
    if (unavailable) await route.fulfill({ status: 503, json: { error: "member unreachable", code: "host_unreachable" } });
    else await route.fulfill({ json: { paneId: "w1:p1", text: "member pane is live", truncated: false, revision: 1 } });
  });
  await page.goto("/pane/w1%3Ap1?h=workshop");
  await expect(page.getByText("member pane is live", { exact: true })).toBeVisible();
  unavailable = true;
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert").filter({ hasText: "Can't reach Collie" })).toBeVisible();
  unavailable = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
});
