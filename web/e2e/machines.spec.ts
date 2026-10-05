import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub, installMachinesWorld } from "./fixtures/api";

// THE MACHINES PAGES, END TO END. Settings, Machines, one machine, a CPU alert set, and back twice
// (ADR 0067): the arrow steps back onto the list, and the phone's edge swipe (`page.goBack`) onto
// Settings. The API is the shared fixture, with the four-machine census and alert rules that stick
// (`installMachinesWorld`), so the POST's body is what the case asserts on.
//
// NO SERVICE WORKER, for the reason `e2e/issue-180.spec.ts` states: `page.route` cannot see a request
// the worker makes on the page's behalf.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no routes");
  await installApiStub(page);
});

/** The app path the page is on: pathname plus query. */
function at(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

async function landed(page: Page, path: string) {
  await expect.poll(() => at(page)).toBe(path);
}

test("Settings to Machines to a machine, set a CPU alert, back twice", async ({ page }) => {
  const { posted } = await installMachinesWorld(page);

  await page.goto("/settings");
  await page.getByRole("button", { name: new RegExp(`^${en["settings.section.machines.title"]}`, "u") }).click();
  await landed(page, "/machines");
  await expect(page.getByRole("heading", { name: en["machines.title"], level: 1 })).toBeVisible();

  // Every machine of the crew is a card, and the firing one says so in words.
  await expect(page.getByText("Alert firing: CPU")).toBeVisible();
  await page.getByRole("button", { name: "workshop", exact: true }).click();
  await landed(page, "/machines/workshop");

  // The last hour first, then the day: three charts either way, each named in one sentence.
  await expect(page.getByRole("img", { name: /^CPU, last hour:/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Memory, last hour:/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Network, last hour:/u })).toBeVisible();
  await page.getByRole("radio", { name: en["machines.range.day"] }).click();
  await expect(page.getByRole("img", { name: /^CPU, last 24 hours:/u })).toBeVisible();

  // The 95% segment of the CPU threshold posts the WHOLE object: the memory rule rides along.
  await page.getByRole("radiogroup", { name: "CPU alert threshold" }).getByRole("radio", { name: "95%" }).click();
  await expect(page.getByText(en["machines.alerts.saved"], { exact: true })).toBeVisible();
  expect(posted).toEqual([
    {
      id: "workshop",
      body: { cpu: { above: 0.95, forMin: 10 }, mem: { above: 0.95, forMin: 30 } },
    },
  ]);
  await expect(
    page.getByRole("radiogroup", { name: "CPU alert threshold" }).getByRole("radio", { name: "95%" }),
  ).toHaveAttribute("aria-checked", "true");

  // Back twice: the arrow onto the list, the edge swipe onto Settings.
  await page.getByRole("button", { name: en["machines.nav.back"] }).click();
  await landed(page, "/machines");
  await page.goBack();
  await landed(page, "/settings");
});

test("a solo collie lists its one machine and opens it", async ({ page }) => {
  await page.goto("/machines");
  await expect(page.getByRole("meter", { name: en["machines.metric.cpu"] })).toBeVisible();
  await page.getByRole("button", { name: "this-machine", exact: true }).click();
  await landed(page, "/machines/local");
  await expect(page.getByRole("img", { name: /^CPU, last hour:/u })).toBeVisible();
});

test("a peer's 404 is one card, not an error", async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/api/machines",
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "this collie is not the lead of a crew", code: "crew.not_lead" }),
      }),
  );
  await page.goto("/machines");
  await expect(page.getByText(en["machines.unavailable.title"])).toBeVisible();
});
