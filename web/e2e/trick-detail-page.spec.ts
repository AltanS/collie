import { expect, test, type Page } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";
import type { OfficialTricksReply, TricksReply, WireTrickInfo } from "@/lib/tricks/schema";
import type { AgentView } from "@/lib/types";

import { installApiStub } from "./fixtures/api";

// A TRICK'S DETAILS PAGE (2026-11-21), in a real engine at 390 x 844 and at 1440 x 900: a tap on a name in
// Settings, Tricks and the Hill opens the page and Back returns to the list where it was; the header button of a trick's own
// page opens the same page and Back returns there; nothing on the page is wider than the window. The Remove section
// (ADR 0168) has its own spec, trick-remove.spec.ts.

test.use({ serviceWorkers: "block" });

/** Twelve made-up tricks, so the list scrolls on a phone. */
const MANY: WireTrickInfo[] = Array.from({ length: 12 }, (_, n) => ({
  host: "lodge",
  id: `shelf-${String(n + 1).padStart(2, "0")}`,
  name: `Shelf ${String(n + 1).padStart(2, "0")}`,
  icon: "file",
  on: false,
  state: "off" as const,
  places: ["belt" as const],
  description: "A made-up trick that keeps a list of jars on a shelf.",
  provenance: { via: "cli" as const, at: "2026-11-08T07:41:00Z" },
}));

const KETTLE: WireTrickInfo = {
  host: "lodge",
  id: "kettle",
  name: "Kettle Watch",
  icon: "flask",
  on: true,
  state: "ok",
  places: ["session", "belt"],
  description: "Says when the kettle in the build log is boiling.",
  about: "Kettle Watch reads one line of the build log every minute and draws how hot the kettle is.\n\nIt never writes a file.",
  run: "bun run kettle.ts",
  everyMs: 300_000,
  inputs: { globs: ["kettle.log"], crew: false },
  env: ["KETTLE_TOKEN"],
  warnings: [{ kind: "network", text: "This trick reaches the network." }],
  version: "1.2.0",
  fields: [{ key: "room", kind: "text", label: "Room", hint: "where the kettle stands" }],
  provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "lodge/kettle-watch", sha: "3f2a91c0d1e2" },
};

const PANE: AgentView = {
  paneId: "trick:lodge:kettle:kettle",
  workspaceId: "trick:lodge",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:lodge:kettle",
  agent: "kettle",
  status: "idle",
  cwd: "/home/me/.config/collie/tricks/kettle",
  focused: false,
  kind: "trick",
  paneLabel: "Kettle Watch",
  sessionName: "Kettle Watch",
  view: "lodge/kettle/kettle",
};

async function stub(page: Page): Promise<void> {
  await installApiStub(page);
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...fixtureSnapshot, agents: [...fixtureSnapshot.agents, PANE], tricksRev: 1 }) }));
  await page.route("**/api/tricks?*", (route) => {
    const reply: TricksReply = {
      rev: 1,
      tricks: [KETTLE, ...MANY],
      parts: [{ host: "lodge", trick: "kettle", part: "kettle", rev: 1, asOf: new Date().toISOString(), value: { at: "session", id: "kettle", name: "Kettle Watch", view: [{ kind: "para", text: "The kettle is warm." }] } }],
      present: ["lodge/kettle/kettle"],
    };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(reply) });
  });
  await page.route("**/api/tricks/official", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ tricks: [] } satisfies OfficialTricksReply) }));
}

/** How much wider than the window the page draws: 0 when nothing sticks out. */
async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const wide = Math.max(document.documentElement.scrollWidth, ...[...document.querySelectorAll("main")].map((el) => el.scrollWidth - el.clientWidth + window.innerWidth));
    return wide - window.innerWidth;
  });
}

/** The scroll of the column the list sits in. */
async function listScroll(page: Page): Promise<number> {
  return page.locator('main:has([data-testid="tricks-settings"])').evaluate((el) => el.scrollTop);
}

for (const size of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test.describe(`at ${String(size.width)} x ${String(size.height)}`, () => {
    test.use({ viewport: size });

    test("a name opens the details page, and Back returns to the list where it was", async ({ page }) => {
      await stub(page);
      await page.goto("/settings/tricks");
      const last = page.getByRole("link", { name: "About Shelf 12" });
      await last.scrollIntoViewIfNeeded();
      const before = await listScroll(page);
      if (size.width === 390) expect(before).toBeGreaterThan(0);
      await last.click();
      await expect(page).toHaveURL(/\/settings\/tricks\/lodge%3Ashelf-12$/);
      await expect(page.locator('[data-slot="trick-detail-name"]')).toHaveText("Shelf 12");
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // Back goes up a level; on a large screen the header's arrow is "Close Settings" and leaves Settings.
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/\/settings\/tricks$/);
      await expect.poll(() => listScroll(page)).toBe(before);
    });

    test("the full page of a trick with a program and settings is no wider than the window; on, its Remove waits", async ({ page }) => {
      await stub(page);
      await page.goto("/settings/tricks/lodge%3Akettle");
      await expect(page.locator('[data-slot="trick-detail-name"]')).toHaveText("Kettle Watch");
      await expect(page.locator('[data-section="settings"]')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await expect(page.getByRole("button", { name: "Remove trick" })).toBeDisabled();
    });

    test("the trick's own page opens its details from the header, and Back returns to the trick's page", async ({ page }) => {
      await stub(page);
      await page.goto("/trick/trick%3Alodge%3Akettle%3Akettle");
      const button = page.getByRole("button", { name: "Trick details" });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await button.click();
      await expect(page).toHaveURL(/\/settings\/tricks\/lodge%3Akettle$/);
      // Back goes up a level; on a large screen the header's arrow is "Close Settings" and leaves Settings.
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page).toHaveURL(/\/trick\/trick%3Alodge%3Akettle%3Akettle$/);
      await expect(page.getByText("The kettle is warm.")).toBeVisible();
    });
  });
}
