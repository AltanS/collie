import { expect, test } from "@playwright/test";

import { en } from "@web/lib/i18n/messages/en";

import { installRoutesApi } from "./routes-api";
import { crewStub, type CrewMode } from "./routes-crew-api";

// Wave 4, Crew: the formation draws the whole crew from `/api/crew`, a tap opens one member's sheet, and
// the sheet's two buttons only MOVE the operator. The page claims the header with the override row
// (ArrowLeft and h1), and back goes UP to Settings, System. The bridge is routes-crew-api.ts.

test.use({ serviceWorkers: "block" });

const errors: string[] = [];

test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function open(page: import("@playwright/test").Page, mode: CrewMode = "crew"): Promise<void> {
  await installRoutesApi(page, [crewStub(mode)]);
  await page.goto("/crew");
}

test("claims the header and draws one node per member", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("header-back")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en["crew.title"]);
  await expect(page.getByTestId("crew-node")).toHaveCount(3);
  await expect(page.locator('[data-testid="crew-node"][data-member-id="lead"]')).toBeVisible();
});

test("back goes up to Settings, System", async ({ page }) => {
  await open(page);
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/settings\/system$/u);
});

test("a tap opens the member's sheet with its facts, and closing leaves the page as it was", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="crew-node"][data-member-id="peer"]').click();
  const sheet = page.getByTestId("member-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("100.64.0.9:8788");
  // The member runs an older Collie than the lead, and says so in words.
  await expect(sheet).toContainText("1.16.0");
  await expect(sheet).toContainText(en["crew.member.versionDiffers"]);
  await expect(sheet).toContainText(en["crew.member.secretBehind"]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("member-sheet")).toHaveCount(0);
  await expect(page).toHaveURL(/\/crew$/u);
});

test("the keyboard opens a node too", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="crew-node"][data-member-id="far"]').focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("member-sheet");
  await expect(sheet).toBeVisible();
  // The lead's own reason for an unreachable member is printed verbatim.
  await expect(sheet).toContainText("connect ETIMEDOUT");
});

test("the lead's sheet names the deputy and the secret", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="crew-node"][data-member-id="lead"]').click();
  const sheet = page.getByTestId("member-sheet");
  await expect(sheet).toContainText("minibuch");
  await expect(sheet).toContainText(en["connection.host.lead"]);
});

test("the sheet's load button pushes the machine page, and back returns to the crew", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="crew-node"][data-member-id="peer"]').click();
  await page.getByRole("button", { name: en["machines.memberSheet.link"] }).click();
  await expect(page).toHaveURL(/\/machines\/peer$/u);
  // Something legitimate is behind (the crew page it was opened from), so back pops to it.
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/crew$/u);
  await expect(page.getByTestId("crew-node")).toHaveCount(3);
});

test("go to this machine switches the host and lands home", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="crew-node"][data-member-id="peer"]').click();
  await page.getByRole("button", { name: en["crew.sheet.goTo"] }).click();
  await expect(page).toHaveURL(/\/\?h=peer$/u);
  await expect(page.getByTestId("home")).toBeVisible();
});

test("a 404 says this collie is not leading a crew", async ({ page }) => {
  await open(page, "solo");
  await expect(page.getByTestId("crew-empty")).toContainText(en["crew.solo.title"]);
  await expect(page.getByTestId("crew-node")).toHaveCount(0);
});

test("a failed read is its own sentence, never the solo one", async ({ page }) => {
  await open(page, "error");
  await expect(page.getByTestId("crew-empty")).toContainText(en["crew.error.title"]);
  await expect(page.getByTestId("crew-empty")).not.toContainText(en["crew.solo.title"]);
});
