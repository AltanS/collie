import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub, installCrewWorld, installMachinesWorld } from "./fixtures/api";

// THE MACHINES PAGES, END TO END. Settings, Machines, one machine's Status, its Alerts view, a CPU alert
// set, and back twice (ADR 0067): the view switch replaced its entry, so the arrow steps back onto the
// list, not onto Status, and the phone's edge swipe (`page.goBack`) onto Settings. Then the dashboard's
// Crew tab: a card opens a machine, and Back returns to the tab. Tabs are picked by name, never by
// place: the dashboard's tab order is not this file's to know. The API is the shared fixture, with the
// four-machine census and alert rules that stick (`installMachinesWorld`), so the POST's body is what
// the case asserts on.
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

test("Settings to Machines to a machine, its Alerts view, set a CPU alert, back twice", async ({ page }) => {
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

  // Status first: a bar per disk, then the last hour, then the day, four charts each named in one
  // sentence.
  await expect(page.getByRole("tab", { name: en["machines.view.status"] })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("meter", { name: "Disk /srv/backups" })).toHaveAttribute("aria-valuenow", "89");
  await expect(page.getByRole("img", { name: /^CPU, last hour:/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Memory, last hour:/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Disk, last hour:/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Network, last hour:/u })).toBeVisible();
  await page.getByRole("radio", { name: en["machines.range.day"] }).click();
  await expect(page.getByRole("img", { name: /^CPU, last 24 hours:/u })).toBeVisible();

  // The rules are on the Alerts view, whose segment is marked while a rule fires.
  await page.getByRole("tab", { name: `${en["machines.view.alerts"]}, ${en["machines.view.firing"]}` }).click();
  await landed(page, "/machines/workshop?tab=alerts");
  await expect(page.getByRole("img", { name: /^CPU, last hour:/u })).toHaveCount(0);

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

  // Back twice: the arrow onto the list (the view switch replaced its entry), the edge swipe onto Settings.
  await page.getByRole("button", { name: en["machines.nav.back"] }).click();
  await landed(page, "/machines");
  await page.goBack();
  await landed(page, "/settings");
});

test("a card's firing line opens the machine on its Alerts view", async ({ page }) => {
  await installMachinesWorld(page);
  await page.goto("/machines");
  await page.getByRole("button", { name: /^Alert firing: CPU/u }).click();
  await landed(page, "/machines/workshop?tab=alerts");
  await expect(page.getByRole("switch", { name: "CPU alert" })).toBeChecked();
  await expect(page.getByText(en["machines.alerts.firingNow"])).toBeVisible();
  await page.getByRole("button", { name: en["machines.nav.back"] }).click();
  await landed(page, "/machines");
});

test("the dashboard's Crew tab: a card opens its machine, and Back returns to the tab", async ({ page }) => {
  await installCrewWorld(page);
  await installMachinesWorld(page);
  await page.goto("/");
  const tabs = page.locator('[data-slot="tab-bar"]');
  await tabs.getByRole("button", { name: en["crew.title"], exact: true }).click();
  await expect(tabs.getByRole("button", { name: en["crew.title"], exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "bluefin", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "workshop", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "workshop", exact: true }).click();
  await landed(page, "/machines/workshop");
  await expect(page.getByRole("img", { name: /^CPU, last hour:/u })).toBeVisible();

  await page.getByRole("button", { name: en["machines.nav.back"] }).click();
  await landed(page, "/");
  await expect(tabs.getByRole("button", { name: en["crew.title"], exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "workshop", exact: true })).toBeVisible();
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

  // The Alerts view draws no chart and reads no history, not even on the minute.
  await page.getByRole("tab", { name: en["machines.view.alerts"] }).click();
  await landed(page, "/machines/bluefin?tab=alerts");
  await page.clock.runFor(125_000);
  expect(asked.filter((a) => a.includes("/history"))).toHaveLength(2);
});

// FOUR SEGMENTS ON A 375 PX SCREEN. The duration row of an alert rule (5 | 10 | 30 | 60 minutes) gives
// each segment a quarter of the row, and a label that does not fit is cut to "30 m…" by `truncate`.
// A cut label is scrollWidth over clientWidth, so that is what this measures, in every catalog (the
// minutes string is one word in English, a Latin abbreviation in German and Spanish, a single
// character beside the number in Japanese and Korean). The 44 px tap height stays.
for (const locale of ["en", "de", "es", "ja", "ko", "zh", "zh-TW", "ru", "it", "fr", "pt", "tr"]) {
  test(`the alert duration row clips no label at 375 px, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.addInitScript((code) => localStorage.setItem("collie:locale:v1", code), locale);
    await installMachinesWorld(page);
    await page.goto("/machines/workshop?tab=alerts");
    const rows = page.locator("[data-slot='segmented']");
    await expect(rows.first()).toBeVisible();
    const measured = await rows.evaluateAll((groups) =>
      groups.flatMap((group) =>
        [...group.querySelectorAll("button")].map((b) => ({
          text: b.textContent ?? "",
          segments: group.querySelectorAll("button").length,
          clipped: b.scrollWidth > b.clientWidth,
          height: b.getBoundingClientRect().height,
        })),
      ),
    );
    expect(measured.some((m) => m.segments === 4)).toBe(true);
    for (const m of measured) {
      expect(m.clipped, `"${m.text}" is clipped`).toBe(false);
      expect(m.height).toBeGreaterThanOrEqual(44);
    }
  });
}

// THE CHARTS KEEP THEIR TYPE AND STROKES AT ANY WIDTH. They used to stretch a 360 unit viewBox to the
// column, so on an 820 px tablet the axis text and the lines were about 1.7 times what a phone shows.
// A chart is now drawn at its column's own pixel size, so one drawing unit is one CSS pixel at both, the
// axis label is the same height, and only the plot grows, up to a cap.
test("a chart's axis text is the same size at 390 and 820 px, and the plot height is capped", async ({ page }) => {
  await installMachinesWorld(page);
  const read = async (width: number) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/machines/workshop");
    const svg = page.getByRole("img", { name: /^CPU, last hour:/u });
    await expect(svg).toBeVisible();
    return svg.evaluate((el) => {
      if (!(el instanceof SVGSVGElement)) throw new Error("the chart is not an svg");
      const root = el;
      const label = [...root.querySelectorAll("text")].find((t) => t.textContent === "0%")!;
      const css = getComputedStyle(label);
      return {
        scale: root.getScreenCTM()!.a,
        labelHeight: label.getBoundingClientRect().height,
        fontSize: css.fontSize,
        svgHeight: root.getBoundingClientRect().height,
        svgWidth: root.getBoundingClientRect().width,
        columnWidth: root.parentElement!.getBoundingClientRect().width,
        stroke: getComputedStyle(root.querySelector("path[data-series='avg']")!).strokeWidth,
      };
    });
  };
  const phone = await read(390);
  const tablet = await read(820);
  expect(phone.scale).toBeCloseTo(1, 2);
  expect(tablet.scale).toBeCloseTo(1, 2);
  expect(tablet.fontSize).toBe(phone.fontSize);
  expect(tablet.labelHeight).toBeCloseTo(phone.labelHeight, 1);
  expect(tablet.stroke).toBe(phone.stroke);
  // The drawing fills its column, and the plot grows no taller than the cap.
  expect(Math.abs(tablet.svgWidth - tablet.columnWidth)).toBeLessThan(1);
  expect(tablet.svgWidth).toBeGreaterThan(phone.svgWidth);
  expect(phone.svgHeight).toBeLessThanOrEqual(155);
  expect(tablet.svgHeight).toBeLessThanOrEqual(200);
});
