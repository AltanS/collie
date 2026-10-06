import { expect, test, type Page } from "@playwright/test";

import { en } from "@web/lib/i18n/messages/en";

import { installRoutesApi, type RoutesStub } from "./routes-api";
import { machinesStub, type MachinesStubState } from "./routes-machines-api";

// Wave 4, Machines and Machine detail: a card per machine (lead first), a tap into the machine's page,
// the Status and Alerts views in the URL, charts with a range, and the alert rules that post the WHOLE
// object. Back goes UP: machine to list, list to Settings. The bridge is routes-machines-api.ts.

test.use({ serviceWorkers: "block" });

let stub: RoutesStub;
let state: MachinesStubState;
const errors: string[] = [];

async function open(page: Page, path: string, over: Partial<MachinesStubState> = {}): Promise<void> {
  const machines = machinesStub(over);
  state = machines.state;
  stub = await installRoutesApi(page, [machines.handler]);
  await page.goto(path);
}

test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the list claims the header and shows the lead first", async ({ page }) => {
  await open(page, "/machines");
  await expect(page.getByTestId("header-back")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en["machines.title"]);
  const cards = page.getByTestId("machine-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toHaveAttribute("data-machine-id", "lead");
  await expect(cards.first()).toContainText("42%");
  await expect(cards.first()).toContainText(en["connection.host.lead"]);
  // Two sparks per live card; a machine that is not answering shows no numbers.
  await expect(cards.first().getByTestId("machine-spark")).toHaveCount(2);
  await expect(cards.nth(2).getByTestId("machine-spark")).toHaveCount(0);
});

test("a firing metric says so in words, and that line opens the Alerts view", async ({ page }) => {
  await open(page, "/machines");
  const lead = page.locator('[data-testid="machine-card"][data-machine-id="lead"]');
  await expect(lead).toContainText("Alert firing: CPU");
  await lead.getByRole("button", { name: /Alert firing/u }).click();
  await expect(page).toHaveURL(/\/machines\/lead\?tab=alerts$/u);
});

test("a card is a push to the machine, and back returns to the list, then to Settings", async ({ page }) => {
  await open(page, "/machines");
  await page.locator('[data-testid="machine-card"][data-machine-id="peer"]').getByRole("button", { name: "minibuch" }).click();
  await expect(page).toHaveURL(/\/machines\/peer$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("minibuch");
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/machines$/u);
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/settings$/u);
});

test("a 404 census says there is no machine list here", async ({ page }) => {
  await open(page, "/machines", { unavailable: true });
  await expect(page.getByTestId("machines-empty")).toContainText(en["machines.unavailable.title"]);
  await expect(page.getByTestId("machine-card")).toHaveCount(0);
});

test("an unknown machine id is its own sentence", async ({ page }) => {
  await open(page, "/machines/nobody");
  await expect(page.getByTestId("machines-empty")).toHaveAttribute("data-reason", "unknown");
});

test("the machine page shows its load now and four charts", async ({ page }) => {
  await open(page, "/machines/lead");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("bluefin");
  const now = page.getByTestId("machine-now");
  await expect(now).toContainText("42%");
  await expect(now).toContainText("/home");
  await expect(page.getByTestId("chart-card")).toHaveCount(4);
  await expect(page.getByTestId("chart-card").first().locator("svg[data-kind]")).toBeVisible();
});

test("the history is read once on open and sliced by the range, with no second request", async ({ page }) => {
  await open(page, "/machines/lead");
  await expect(page.getByTestId("chart-card").first().locator("svg[data-kind]")).toBeVisible();
  const reads = (): number => stub.calls.filter((c) => c.path === "/api/machines/lead/history").length;
  expect(reads()).toBe(1);
  await page.getByRole("radio", { name: en["machines.range.day"] }).click();
  await expect(page.getByRole("radio", { name: en["machines.range.day"] })).toHaveAttribute("aria-checked", "true");
  expect(reads()).toBe(1);
});

test("a failed history read says it will try again, in the card", async ({ page }) => {
  await open(page, "/machines/lead", { failHistory: true });
  await expect(page.getByTestId("chart-placeholder").first()).toContainText(en["machines.history.error"]);
});

test("the view is in the URL and a switch is sideways: back leaves the machine", async ({ page }) => {
  await open(page, "/machines/lead");
  await page.getByRole("tab", { name: new RegExp(en["machines.view.alerts"], "u") }).click();
  await expect(page).toHaveURL(/\/machines\/lead\?tab=alerts$/u);
  await expect(page.getByTestId("machine-alerts")).toBeVisible();
  // The Alerts segment carries the firing mark, in words to a screen reader.
  await expect(page.getByRole("tab", { name: new RegExp(en["machines.view.firing"], "u") })).toBeVisible();
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/machines$/u);
});

test("turning a rule on posts the WHOLE object, the other rules included", async ({ page }) => {
  await open(page, "/machines/lead?tab=alerts");
  const mem = page.locator('[data-testid="machine-alerts"] [data-metric="mem"]');
  await mem.getByRole("switch").click();
  await expect(page.getByText(en["machines.alerts.saved"], { exact: true }).first()).toBeVisible();
  const post = stub.writes().find((c) => c.path === "/api/machines/lead/alerts");
  expect(post?.method).toBe("POST");
  // SAFETY: the app posts a MachineAlerts object; the assertions below check each key it reads.
  const body = post?.body as Record<string, { above: number; forMin: number }>;
  expect(Object.keys(body).toSorted()).toEqual(["cpu", "mem"]);
  expect(body.cpu).toEqual({ above: 0.9, forMin: 10 });
  expect(state.alerts.lead?.mem).toBeDefined();
});

test("turning the last rule off drops only that metric", async ({ page }) => {
  await open(page, "/machines/lead?tab=alerts");
  await page.locator('[data-testid="machine-alerts"] [data-metric="cpu"]').getByRole("switch").click();
  await expect.poll(() => state.alerts.lead).toEqual({});
  expect(stub.writes()).toHaveLength(1);
});

test("a refused write says so and keeps the rules the bridge reported", async ({ page }) => {
  await open(page, "/machines/lead?tab=alerts");
  await page.route("**/api/machines/lead/alerts", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  const cpu = page.locator('[data-testid="machine-alerts"] [data-metric="cpu"]').getByRole("switch");
  await cpu.click();
  await expect(page.getByText(en["machines.alerts.failed"]).first()).toBeVisible();
  await expect(cpu).toHaveAttribute("aria-checked", "true");
});
