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
  // A card's CPU and memory each have their last half hour, named in one sentence.
  await expect(page.getByRole("img", { name: /^CPU, last 30 minutes: now 96%, peak \d+%\. Alert line at 90%\.$/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Memory, last 30 minutes: now 39%/u })).toBeVisible();
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
  // The card's live line says it; the visible face beside it is the same words with a check.
  await expect(page.getByRole("status").filter({ hasText: en["machines.alerts.saved"] })).toHaveText(en["machines.alerts.saved"]);
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
  await expect(page.getByRole("img", { name: /^CPU, last 30 minutes: now 34%/u })).toBeVisible();
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

test("the list asks for the half hour, a machine's page reads its day once, and no other page asks at all", async ({ page }) => {
  await installMachinesWorld(page);
  const asked: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/machines")) asked.push(`${url.pathname}${url.search}`);
  });
  await page.clock.install();

  await page.goto("/");
  await page.clock.runFor(30_000);
  await page.goto("/settings");
  await page.clock.runFor(30_000);
  expect(asked).toEqual([]);

  await page.goto("/machines");
  await expect(page.getByRole("button", { name: "bluefin", exact: true })).toBeVisible();
  expect(asked.every((a) => a === "/api/machines?spark=30")).toBe(true);

  asked.length = 0;
  await page.goto("/machines/bluefin");
  await expect(page.getByRole("img", { name: /^CPU, last hour:/u })).toBeVisible();
  expect(asked.filter((a) => a.includes("/history"))).toEqual(["/api/machines/bluefin/history"]);
  // A minute later the page asks only for what it has not seen.
  await page.clock.runFor(61_000);
  await expect.poll(() => asked.filter((a) => a.includes("/history")).length).toBe(2);
  expect(asked.filter((a) => a.includes("/history"))[1]).toMatch(/^\/api\/machines\/bluefin\/history\?since=\d+$/u);
});
