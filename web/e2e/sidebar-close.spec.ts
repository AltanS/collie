import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { AgentView, SnapshotResponse } from "@/lib/types";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// «хотелось бы не выходя из пространства иметь просто с боковой панели закрывать вкладку». The owner's
// laptop in a real browser: a right click on a sidebar row closes a pane and the operator stays in the
// space. The rules behind it are pinned in src/components/wide-layout-close.test.tsx.

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

const encoded = (paneId: string) => encodeURIComponent(paneId);
const addressOf = (paneId: string) => `/pane/${encoded(paneId)}`;

const FIRST = "w1:p1";
const SECOND = "w1:p2";
const THIRD = "w1:p3";

function paneOfFirstSpace(paneId: string, paneLabel: string): AgentView {
  return { ...fixtureSnapshot.agents[0]!, paneId, paneLabel };
}

/** A snapshot with three panes in the first space. A closed pane leaves it, as on a bridge. */
async function installThreePaneSpace(page: Page) {
  const closes: string[] = [];
  const space = [paneOfFirstSpace(FIRST, "first"), paneOfFirstSpace(SECOND, "second"), paneOfFirstSpace(THIRD, "third")];
  const others = fixtureSnapshot.agents.filter((agent) => agent.workspaceId !== space[0]!.workspaceId);
  const alive = (agent: AgentView) => !closes.includes(encoded(agent.paneId));

  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => {
      const snapshot: SnapshotResponse = { ...fixtureSnapshot, agents: [...space.filter(alive), ...others] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) });
    },
  );
  await page.route(
    (url) => /^\/api\/pane\/[^/]+\/close$/u.test(url.pathname),
    (route) => {
      expect(route.request().method()).toBe("POST");
      closes.push(new URL(route.request().url()).pathname.split("/")[3] ?? "");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    },
  );
  return closes;
}

function at(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

const sidebarRow = (page: Page, label: string) =>
  page.getByRole("complementary", { name: en["wide.sidebar.label"] }).locator("[data-pane-key]").filter({ hasText: label });

/** Right click on the row, then the two clicks of Close pane. */
async function closeFromRow(page: Page, label: string) {
  await sidebarRow(page, label).click({ button: "right" });
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: en["paneActions.close.label"] }).click();
  await sheet.getByRole("button", { name: en["paneActions.close.confirm"] }).click();
}

test.beforeEach(({ context: _context }, testInfo) => {
  test.skip(testInfo.project.name === "app-tablet", "the viewport is set here; the tablet run would repeat it");
});

test("@oracle:requirement @req:CLOSE-3 @req:CLOSE-5 a sidebar row closes a pane and the operator stays in the space", async ({ page }) => {
  await installApiStub(page);
  const closes = await installThreePaneSpace(page);
  await page.goto(addressOf(FIRST));
  await expect(sidebarRow(page, "second")).toBeVisible();

  // Another row: the close goes out once, its row leaves, the route stays on the pane.
  await closeFromRow(page, "second");
  await expect.poll(() => closes).toEqual([encoded(SECOND)]);
  await expect(sidebarRow(page, "second")).toHaveCount(0);
  expect(at(page)).toBe(addressOf(FIRST));

  // The pane on screen, by its own row: the route moves to the space's other pane, not home.
  await closeFromRow(page, "first");
  await expect.poll(() => closes).toEqual([encoded(SECOND), encoded(FIRST)]);
  await expect.poll(() => at(page)).toBe(addressOf(THIRD));
  await expect(sidebarRow(page, "third")).toBeVisible();
  await expect(page.locator('[data-slot="wide-layout"]')).toBeVisible();
});
