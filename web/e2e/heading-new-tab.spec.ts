import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureNewTab } from "@/test/handlers";

import { fill, installApiStub, installCrewWorld } from "./fixtures/api";

// A NEW TAB FROM THE WORKSPACE HEADING (M40/03, issue 290). Each workspace heading on the dashboard
// ends in a "+" that opens a new tab in that workspace and steps down into its fresh shell, as the
// tab strip's "+" does. The cases a real engine has to check: that the create goes to the heading's
// OWN machine (a crew's machines number their spaces from `w1` each, and the list holds them all),
// and that the 28px circle answers 44px of touch without reaching into the row below it, which is
// geometry jsdom never lays out. 390x844, the phone.
//
// The fixture herd (src/test/handlers.ts): webapp (w1) holds a blocked claude pane; collie (w2)
// holds a working codex pane and a bare shell. The crew world adds moonward, the peer workshop's own
// `w1`, beside the lead bluefin's webapp `w1`.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone case; the tablet run would repeat it");
  await installApiStub(page);
});

/** A workspace heading's "+", by the name it reads to a screen reader. */
const plus = (page: Page, workspace: string) =>
  page.getByRole("main").getByRole("button", { name: fill(en["home.group.newTab"], { name: workspace }) });

/** Tap a heading's "+" and hand back the create it sent. */
async function tapPlus(page: Page, workspace: string): Promise<Request> {
  const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/tab");
  await plus(page, workspace).click();
  return sent;
}

/** The path the new pane opens on: the fixture's fresh shell, as the router spells a pane id. */
const NEW_PANE = `/pane/${encodeURIComponent(fixtureNewTab.pane.paneId)}`;

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** Whether a touch at (x, y) lands on `target`: the topmost element there is it or inside it. */
function hits(target: Locator, x: number, y: number): Promise<boolean> {
  return target.evaluate((el, [px, py]) => {
    const top = document.elementFromPoint(px!, py!);
    return top !== null && el.contains(top);
  }, [x, y]);
}

test("a heading's '+' opens a new tab in that workspace and steps into its shell", async ({ page }) => {
  await page.goto("/");
  const sent = await tapPlus(page, "collie");

  // Solo: no machine and no session on the wire, as every solo request has always gone.
  expect(new URL(sent.url()).search).toBe("");
  expect(sent.postDataJSON()).toEqual({ workspaceId: "w2" });
  await expect(page).toHaveURL(new RegExp(`${NEW_PANE}$`, "u"));
  await expect(
    page.getByText(fill(en["space.create.ready"], { what: en["space.noun.tab"] }), { exact: true }).first(),
  ).toBeVisible();
});

test("the '+' answers 44px around its 28px circle and stops at the first row's top edge", async ({ page }) => {
  await page.goto("/");
  const button = plus(page, "webapp");
  const b = await box(button);
  expect(Math.round(b.width)).toBe(28);
  expect(Math.round(b.height)).toBe(28);

  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  // 8px past the circle on every side: 28 + 16 = 44.
  expect(await hits(button, cx, b.y - 7.5)).toBe(true);
  expect(await hits(button, cx, b.y + b.height + 7.5)).toBe(true);
  expect(await hits(button, b.x - 7.5, cy)).toBe(true);
  expect(await hits(button, b.x + b.width + 7.5, cy)).toBe(true);
  // And no further. Upward the probe stands a pixel clear, because Chromium's hit test snaps that
  // edge by up to a pixel (the box itself measures 44, from 8px above to 8px below); downward, the
  // side that faces the rows, the reach is exact.
  expect(await hits(button, cx, b.y - 9.5)).toBe(false);
  expect(await hits(button, cx, b.y + b.height + 8.5)).toBe(false);

  // The first row of the group starts after the hit box ends: a tap on its top pixel opens the pane.
  const row = page.getByRole("main").getByRole("button", { name: /^claude logo claude/u });
  const r = await box(row);
  expect(r.y).toBeGreaterThanOrEqual(b.y + b.height + 8);
  expect(await hits(button, cx, r.y + 0.5)).toBe(false);
  expect(await hits(row, cx, r.y + 0.5)).toBe(true);

  // Every heading row is the circle's height, drawn or not, and the circle sits on its middle.
  for (const name of ["webapp", "collie"]) {
    const headingRow = page.getByRole("heading", { name, exact: true }).locator("xpath=..");
    const h = await box(headingRow);
    expect(Math.round(h.height)).toBe(28);
  }
  const webappRow = await box(page.getByRole("heading", { name: "webapp", exact: true }).locator("xpath=.."));
  expect(Math.abs(webappRow.y + webappRow.height / 2 - cy)).toBeLessThan(0.51);
});

test("in a crew, each heading sends the create to its own machine, whatever the URL addresses", async ({ page }) => {
  await installCrewWorld(page);

  // The peer's heading, seen from the lead: the create and the step down both go to the peer.
  await page.goto("/");
  const peer = await tapPlus(page, "moonward");
  expect(new URL(peer.url()).searchParams.get("host")).toBe("workshop");
  expect(peer.postDataJSON()).toEqual({ workspaceId: "w1" });
  await expect(page).toHaveURL(new RegExp(`${NEW_PANE}\\?h=workshop$`, "u"));

  // The lead's `w1`, seen from the peer's URL: it goes to the lead, which the wire spells as no host.
  await page.goto("/?h=workshop");
  const lead = await tapPlus(page, "webapp");
  expect(new URL(lead.url()).searchParams.get("host")).toBeNull();
  expect(lead.postDataJSON()).toEqual({ workspaceId: "w1" });
  await expect(page).toHaveURL(new RegExp(`${NEW_PANE}$`, "u"));
});
