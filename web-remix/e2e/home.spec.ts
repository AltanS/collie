import { expect, test, type Locator, type Page } from "@playwright/test";

import { statusLabel, type SnapshotResponse } from "@web/lib/types";

import { homeHandlers, homeSnapshot } from "./home-api";
import { installRoutesApi, type RoutesStub } from "./routes-api";

// The dashboard, feature by feature (wave 2): rows and their chips, the frozen order, the needs-you
// switch, the hold menu and the Pinned group, the heading "+", a hidden machine's stand-in chip, the
// Crew and Files tabs, the update ribbon, and prefs that survive a reload.

let snap: SnapshotResponse;
let stub: RoutesStub;

test.beforeEach(async ({ page }) => {
  snap = homeSnapshot(Date.now());
  stub = await installRoutesApi(page, homeHandlers(() => snap));
});

const row = (page: Page, id: string, host?: string): Locator =>
  host === undefined
    ? page.locator(`[data-testid="pane-row"][data-pane-id="${id}"]`).filter({ hasNot: page.locator('[data-slot="host-chip"]') })
    : page.locator(`[data-testid="pane-row"][data-pane-id="${id}"]`).filter({ has: page.locator('[data-slot="host-chip"]') });

const listOrder = (scope: Locator): Promise<string[]> =>
  scope.locator('[data-testid="pane-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-pane-id") ?? ""));

/** The box once it has stopped moving (the update ribbon opens above the list after the first poll). */
async function settledBox(page: Page, target: Locator): Promise<{ x: number; y: number; width: number; height: number } | null> {
  let last = await target.boundingBox();
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(100);
    const now = await target.boundingBox();
    if (now !== null && last !== null && now.y === last.y && now.x === last.x) return now;
    last = now;
  }
  return last;
}

async function hold(page: Page, target: Locator): Promise<void> {
  await expect(page.getByTestId("update-ribbon")).toBeVisible();
  const box = await settledBox(page, target);
  if (box === null) throw new Error("no box to hold");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

async function nextPoll(page: Page): Promise<void> {
  await page.waitForRequest((r) => new URL(r.url()).pathname === "/api/snapshot", { timeout: 10_000 });
  await page.waitForTimeout(150);
}

test("rows render with their chips, tint and unseen slot", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("workspace-group")).toHaveCount(4);
  await expect(page.getByTestId("pane-row")).toHaveCount(7);
  // Cache chips in all three inks.
  await expect(row(page, "w1:p1").locator('[data-slot="cache-chip"]')).toHaveAttribute("data-tone", "warm");
  await expect(row(page, "w1:p1").locator('[data-slot="cache-chip"]')).toContainText("12m");
  await expect(row(page, "w1:p2").locator('[data-slot="cache-chip"]')).toHaveAttribute("data-tone", "expiring");
  await expect(row(page, "w1:p3").locator('[data-slot="cache-chip"]')).toHaveAttribute("data-tone", "cold");
  // The host chip names the peer only (the lead's own rows carry no host).
  await expect(row(page, "w1:p1", "peer").locator('[data-slot="host-chip"]')).toContainText("minibuch");
  await expect(page.locator('[data-slot="host-chip"]')).toHaveCount(1);
  // The blocked row wears the alarm tint; every row reserves the unseen slot.
  await expect(row(page, "w1:p1").locator(".bg-status-blocked\\/10")).toHaveCount(1);
  await expect(row(page, "w1:p3").locator(".bg-status-blocked\\/10")).toHaveCount(0);
  // The glide parts.
  await expect(row(page, "w1:p1").locator('[data-glide="name"]')).toHaveText("claude");
  expect(errors).toEqual([]);
});

test("the order toggle ranks the list, and a poll never moves a row until the next tap", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("pane-row")).toHaveCount(7);
  await page.locator('[data-testid="pane-order-toggle"] [data-order="activity"]').click();
  const ranked = page.getByTestId("ranked-group");
  await expect(ranked).toBeVisible();
  await expect(page.getByTestId("workspace-group")).toHaveCount(0);
  const before = await listOrder(ranked);
  expect(before[0]).toBe("w1:p2"); // one minute ago, the newest
  // The poll: the oldest pane becomes the newest. Nothing moves.
  const now = Date.now();
  const oldest = snap.agents.find((a) => a.paneId === "w3:p1");
  if (oldest !== undefined) oldest.lastActiveAt = now;
  await nextPoll(page);
  await nextPoll(page);
  expect(await listOrder(ranked)).toEqual(before);
  // The operator's tap takes a new reading.
  await page.locator('[data-testid="pane-order-toggle"] [data-order="activity"]').click();
  await expect.poll(() => listOrder(ranked).then((o) => o[0])).toBe("w3:p1");
});

test("needs you filters the groups and keeps the counts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("workspace-group")).toHaveCount(4);
  const summary = await page.getByTestId("summary-line").innerText();
  await page.getByTestId("needs-you-switch").click();
  await expect(page.getByTestId("needs-you-switch")).toHaveAttribute("aria-pressed", "true");
  const groups = page.getByTestId("workspace-group");
  await expect(groups).not.toHaveCount(4);
  await expect(groups.filter({ hasText: "brand" })).toHaveCount(0);
  await expect(groups.filter({ hasText: "collie" })).toHaveCount(1);
  expect(await page.getByTestId("summary-line").innerText()).toBe(summary);
});

test("a hold opens the actions sheet, and Pin makes the Pinned group", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("pin-hint")).toBeVisible();
  await hold(page, row(page, "w3:p1"));
  const sheet = page.getByTestId("pane-actions-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("pane-action-rename")).toBeVisible();
  await expect(sheet.getByTestId("pane-action-close")).toBeVisible();
  await sheet.getByTestId("pane-action-pin").click();
  const pinned = page.getByTestId("pinned-group");
  await expect(pinned).toBeVisible();
  await expect(pinned.locator('[data-pane-id="w3:p1"]')).toHaveCount(1);
  await expect(page.getByTestId("pin-hint")).toHaveCount(0);
  // The pin and the retired hint are stored where web/ keeps them.
  const stored = await page.evaluate(() => [localStorage.getItem("collie:pins:v1"), localStorage.getItem("collie:pin-hint:v1")]);
  expect(stored[0]).toContain("w3:p1");
  expect(stored[1]).toBe("1");
});

test('the heading "+" posts a new tab and opens it', async ({ page }) => {
  await page.goto("/");
  const collie = page.getByTestId("workspace-group").filter({ hasText: "collie" });
  await collie.getByTestId("workspace-new-tab").click();
  await expect(page).toHaveURL(/\/pane\/w1%3Ap9$/u);
  const post = stub.writes().find((c) => c.path === "/api/tab");
  expect(post?.method).toBe("POST");
  expect(post?.body).toMatchObject({ workspaceId: "w1" });
});

test("a hidden machine folds into one stand-in chip, and a tap shows it again", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded") === null) {
      localStorage.setItem("collie:hidden-machines:v1", JSON.stringify(["peer"]));
      sessionStorage.setItem("seeded", "1");
    }
  });
  await page.goto("/");
  const chip = page.getByTestId("machine-chip");
  await expect(chip).toHaveCount(1);
  await expect(page.getByTestId("workspace-group").filter({ hasText: "infra" })).toHaveCount(0);
  await expect(page.getByTestId("workspace-group")).toHaveCount(3);
  await page.getByRole("button", { name: "Show minibuch's panes" }).click();
  await expect(chip).toHaveCount(0);
  await expect(page.getByTestId("workspace-group").filter({ hasText: "infra" })).toHaveCount(1);
});

test("the Crew and Files tabs render", async ({ page }) => {
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: /./u }).last();
  await tabs.getByRole("button", { name: "Crew" }).click();
  await expect(page.getByTestId("agent-list")).toHaveCount(0);
  await expect(page.locator("main")).toContainText("bluefin");
  await tabs.getByRole("button", { name: "Files" }).click();
  const files = page.getByTestId("files-tab");
  await expect(files).toBeVisible();
  await expect(files.getByTestId("files-row")).toHaveCount(4);
  await expect(files.locator('[data-slot="count-line"]').first()).not.toHaveAttribute("data-state", "loading");
  await expect(files.locator('[data-slot="count-line"]').first()).toContainText("+");
  await expect(files.getByTestId("files-row").first()).toHaveAttribute("data-glide-key", /\/space\/w1\/changes/u);
});

test("the update ribbon shows for an available release", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("update-ribbon")).toBeVisible();
  await expect(page.getByTestId("update-ribbon")).toContainText("1.18.0");
});

test("prefs survive a reload: the cold open draws the same list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("pane-row")).toHaveCount(7);
  await page.locator('[data-testid="pane-order-toggle"] [data-order="cache"]').click();
  await page.getByTestId("needs-you-switch").click();
  await expect(page.getByTestId("needs-you-switch")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ranked-group").locator('[data-pane-id="w3:p1"]')).toHaveCount(0);
  const before = await listOrder(page.getByTestId("agent-list"));
  await page.reload();
  await expect(page.locator('[data-testid="pane-order-toggle"] [data-order="cache"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("needs-you-switch")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ranked-group")).toBeVisible();
  expect(await listOrder(page.getByTestId("agent-list"))).toEqual(before);
});

test("space rows are cards: a status pill ends the row and the working directory is line 2", async ({ page }) => {
  // A solo bridge: the dashboard fixture is a crew, whose lead's untagged panes the tab grouping cannot place.
  const crew = snap;
  snap = { ...crew, agents: crew.agents.filter((a) => a.host === undefined), workspaces: crew.workspaces.filter((w) => w.host === undefined), tabs: crew.tabs.filter((tab) => tab.host === undefined) };
  delete snap.servers;
  delete snap.sessions;
  await page.goto("/space/w1");
  const rows = page.getByTestId("space-view").getByTestId("pane-row");
  await expect(rows).toHaveCount(3);
  const blocked = rows.and(page.locator('[data-pane-id="w1:p1"]'));
  await expect(blocked.getByTestId("status-pill")).toHaveText(statusLabel("blocked"));
  for (const id of ["w1:p1", "w1:p2", "w1:p3"]) {
    const one = page.locator(`[data-testid="space-view"] [data-pane-id="${id}"]`);
    await expect(one.getByTestId("status-pill")).toBeVisible();
    // Line 2 is the path, in mono, and no status dot leads line 1 (the pill says it).
    await expect(one.locator('[data-slot="agent-row-detail"] span.font-mono')).toContainText("project");
    await expect(one.locator('[data-glide="dot"]')).toHaveCount(0);
  }
  // A card: bordered, rounded and shadowed, not a flat row in a bordered group.
  const card = blocked.locator("> div");
  await expect(card).toHaveClass(/rounded-xl/u);
  await expect(card).toHaveClass(/shadow-sm/u);
  await expect(page.getByTestId("space-view").locator('[data-slot="list-group"]')).toHaveCount(0);
  // The dashboard's own rows are still flat dot rows, with no pill.
  await page.goto("/");
  await expect(page.getByTestId("status-pill")).toHaveCount(0);
});

test("the space screen: strips, a held tab pill opens its sheet, and the tab '+' posts", async ({ page }) => {
  await page.goto("/space/w1");
  await expect(page.getByTestId("space")).toBeVisible();
  await expect(page.getByTestId("space-strip")).toBeVisible();
  const pills = page.getByTestId("tab-pill");
  await expect(pills).toHaveCount(2);
  await hold(page, pills.first());
  const sheet = page.getByTestId("tab-actions-sheet");
  await expect(sheet).toBeVisible();
  const close = sheet.getByTestId("tab-action-close");
  await close.click();
  await expect(close).toContainText("2"); // armed: the blast radius, two panes
  expect(stub.writes().filter((c) => c.path.startsWith("/api/tab/"))).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByTestId("space-new-tab").click();
  await expect(page).toHaveURL(/\/pane\/w1%3Ap9$/u);
  expect(stub.writes().some((c) => c.path === "/api/tab" && c.method === "POST")).toBe(true);
});
