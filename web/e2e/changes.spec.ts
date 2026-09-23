import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { PaneChangesResponse } from "@/lib/types";
import { fixtureAgents, fixtureChanges, fixtureCleanChanges, fixtureCommit } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// THE CHANGES VIEW ON A SMALL PHONE (ADR 0065). The list and one file's diff at 375x812, the
// narrowest iPhone still sold, in a real engine: jsdom cannot say whether a long diff line wraps or
// pushes the page sideways, and that is the one layout claim this view makes. The API is the
// shared fixture (`src/test/handlers.ts`), routed by `fixtures/api.ts`.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no pane route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const PANE = fixtureAgents[0]!;

/** No box on the page is wider than the viewport: nothing scrolls sideways. */
async function noSidewaysScroll(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.scrollingElement!.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(width);
}

/**
 * The first answer's rows fade in and settle 3px (`count-arrive`, a transform), so a box measured
 * during those 200ms is where the rows are passing through, not where they sit. Wait it out.
 */
async function listSettled(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => !(a instanceof CSSAnimation && a.animationName === "count-arrive") || a.playState === "finished"),
  );
}

// EXPERIMENT (operator, 2026-09-23): the entry is a pill on the belt's pinned block, immediately
// left of the switcher mark, no longer a row in the pane menu.
test("the belt's Changes pill opens Changes, the list groups by repo, and a diff wraps", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}`);
  const pill = page.getByRole("button", { name: en["chat.changes.label"] });
  const switcher = page.getByRole("button", { name: en["chat.switcher.aria"] });
  await expect(pill).toBeVisible();
  const [p, s] = [(await pill.boundingBox())!, (await switcher.boundingBox())!];
  // Same box as the mark, on the same line, directly to its left: 37px square at the belt's default
  // 1.15 scale (it was 32px before the belt scaled, 2026-09-23).
  expect(p.width).toBe(37);
  expect(p.height).toBe(s.height);
  expect(p.y).toBe(s.y);
  expect(p.x + p.width).toBeLessThanOrEqual(s.x);
  expect(s.x - (p.x + p.width)).toBeLessThanOrEqual(8);
  expect(p.height).toBe(37);
  // The pane menu no longer carries it.
  await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: en["chat.changes.label"] })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await pill.click();

  await expect(page).toHaveURL(/\/changes$/);
  await expect(page.getByText("webapp · 3 files")).toBeVisible();
  await expect(page.getByText("api · 2 files")).toBeVisible();
  await listSettled(page);
  await noSidewaysScroll(page);

  // Every row is a 44px target.
  const row = page.getByRole("button", { name: /checkout\.tsx/ });
  const box = await row.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await row.click();
  await expect(page).toHaveURL(/\?repo=\.&path=src%2Froutes%2Fcheckout\.tsx$/);
  const long = page.getByText(/including shipping to/);
  await expect(long).toBeVisible();
  // The long line wraps inside the column rather than widening the page.
  const line = await long.boundingBox();
  expect(line!.x + line!.width).toBeLessThanOrEqual(375);
  expect(line!.height).toBeGreaterThan(20);
  await noSidewaysScroll(page);

  const next = page.getByRole("button", { name: en["changes.file.next"] });
  expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await next.click();
  await expect(page.getByText("return items.reduce((sum, item) => sum + item.price, 0);")).toBeVisible();

  // Next replaced the entry, so browser back lands on the list, not on the previous file.
  await page.goBack();
  await expect(page.getByText("webapp · 3 files")).toBeVisible();
  await expect(page).toHaveURL(/\/changes$/);
});

test("a binary file says so and draws no rows", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes?repo=.&path=public%2Flogo.png`);
  await expect(page.getByText(en["changes.file.binary"])).toBeVisible();
  await expect(page.getByRole("button", { name: en["changes.file.prev"] })).toBeEnabled();
});

// The operator's ask (2026-09-23): a List / Tree toggle and a Filter button at the top of the list.
// Tree order for the fixture: webapp public/logo.png, src/lib/cart.ts, src/routes/checkout.tsx; api
// server/handlers/orders.ts (a compacted chain), notes.md.
test("the tree folds, the filter narrows, and Previous / Next walk only what is shown", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await expect(page.getByText("webapp · 3 files")).toBeVisible();

  const tree = page.getByRole("radio", { name: en["changes.layout.tree"] });
  expect((await tree.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await tree.click();
  await expect(tree).toHaveAttribute("aria-checked", "true");

  // A chain of single folders is one row, and every folder starts open.
  const chain = page.getByRole("button", { name: "server/handlers, 1 file" });
  await expect(chain).toHaveAttribute("aria-expanded", "true");
  const src = page.getByRole("button", { name: "src, 2 files" });
  expect((await src.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await src.click();
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: /checkout\.tsx/ })).toHaveCount(0);
  await noSidewaysScroll(page);
  await src.click();
  await expect(page.getByRole("button", { name: /checkout\.tsx/ })).toBeVisible();

  // The filter row opens under the header and leaves the header where it was.
  const title = page.getByRole("heading", { name: en["changes.title"] });
  const before = (await title.boundingBox())!;
  await page.getByRole("button", { name: en["changes.filter.button"] }).click();
  const field = page.getByRole("textbox", { name: en["changes.filter.placeholder"] });
  await expect(field).toBeFocused();
  expect(await title.boundingBox()).toEqual(before);

  await field.fill("ORDERS");
  await expect(page.getByRole("button", { name: /orders\.ts/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /checkout\.tsx/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter files, 1 of 5 shown" })).toBeVisible();

  await field.fill("no-such-file");
  await expect(page.getByText(en["changes.filter.none"])).toBeVisible();
  // The overlay covers the "no match" screen's own Clear button, so its own Clear stays reachable.
  await page.getByRole("dialog", { name: en["changes.filter.button"] }).getByRole("button", { name: en["changes.filter.clear"] }).click();
  await expect(field).toHaveValue("");
  await expect(page.getByRole("button", { name: en["changes.filter.button"] })).toBeVisible();

  const modified = page.getByRole("button", { name: en["changes.status.M"], exact: true });
  expect((await modified.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await modified.click();
  await expect(modified).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("2 of 5 files")).toBeVisible();
  await expect(page.getByRole("button", { name: /cart\.ts/ })).toHaveCount(0);
  // With only routes/ left under src/, the chain compacts.
  await expect(page.getByRole("button", { name: "src/routes, 1 file" })).toBeVisible();
  await noSidewaysScroll(page);

  // The overlay floats over the list, so a row underneath it is reached only once it is closed —
  // Escape closes it and keeps the filter applied.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: en["changes.filter.button"] })).toHaveCount(0);

  // Previous / Next walk the two shown files, in tree order: logo.png, then checkout.tsx.
  await page.getByRole("button", { name: /checkout\.tsx/ }).click();
  await expect(page).toHaveURL(/path=src%2Froutes%2Fcheckout\.tsx$/);
  const prev = page.getByRole("button", { name: en["changes.file.prev"] });
  const next = page.getByRole("button", { name: en["changes.file.next"] });
  await expect(next).toBeDisabled();
  await prev.click();
  await expect(page).toHaveURL(/path=public%2Flogo\.png$/);
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();

  // Back to the list: the filter and the layout are still applied, though its own card stayed
  // closed (Escape closed it above, and coming back from a file reopens nothing on its own).
  await page.goBack();
  await expect(page).toHaveURL(/\/changes$/);
  await expect(page.getByRole("dialog", { name: en["changes.filter.button"] })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter files, 2 of 5 shown" })).toBeVisible();
  await expect(page.getByRole("button", { name: "src/routes, 1 file" })).toBeVisible();
  await expect(page.getByRole("button", { name: /notes\.md/ })).toHaveCount(0);

  // Reopen the card: the status chip it applied is still pressed.
  await page.getByRole("button", { name: "Filter files, 2 of 5 shown" }).click();
  await expect(page.getByRole("button", { name: en["changes.status.M"], exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// The operator's ask (2026-09-23, follow-up): the filter row floats OVER the list as a card, rather
// than pushing it down, so opening and closing it must move neither the header nor a single row.
test("opening and closing the filter never moves the list or the header", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await expect(page.getByText("webapp · 3 files")).toBeVisible();
  await listSettled(page);

  const title = page.getByRole("heading", { name: en["changes.title"] });
  const firstRow = page.getByRole("button", { name: /checkout\.tsx/ });
  const titleBefore = (await title.boundingBox())!;
  const rowBefore = (await firstRow.boundingBox())!;

  const expectRowUnmoved = async (state: string) => {
    const box = (await firstRow.boundingBox())!;
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(box[key] - rowBefore[key]),
        `${state}: row.${key} moved from ${rowBefore[key]} to ${box[key]}`,
      ).toBeLessThanOrEqual(0.5);
    }
  };

  await page.getByRole("button", { name: en["changes.filter.button"] }).click();
  await expect(page.getByRole("textbox", { name: en["changes.filter.placeholder"] })).toBeFocused();
  expect(await title.boundingBox()).toEqual(titleBefore);
  await expectRowUnmoved("opened");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: en["changes.filter.button"] })).toHaveCount(0);
  expect(await title.boundingBox()).toEqual(titleBefore);
  await expectRowUnmoved("closed");
});

// ADR 0065 rule 7: syntax colour arrives after the plain rows, and moves nothing. The highlighter's
// chunks are held at the network until the plain rows are measured, then let through.
test("a TypeScript diff takes syntax colour after it loads, and no row changes height", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await expect(page.getByText("webapp · 3 files")).toBeVisible();

  // Everything the app has fetched is in; from here every script request waits for the gate.
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const held: string[] = [];
  await page.route(/\.js(\?|$)/, async (route) => {
    held.push(route.request().url());
    await gate;
    await route.continue();
  });

  await page.getByRole("button", { name: /checkout\.tsx/ }).click();
  const long = page.getByText(/including shipping to/);
  await expect(long).toBeVisible();
  const diff = page.locator('[data-slot="diff"]');
  const measure = () =>
    diff.evaluate((el) => ({
      rows: [...el.children].map((row) => row.getBoundingClientRect().height),
      total: el.getBoundingClientRect().height,
    }));
  const inkOf = (word: string) =>
    diff.evaluate((el, w) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.textContent === w) return getComputedStyle(n.parentElement!).color;
      }
      return null;
    }, word);

  // Plain: the keyword is one text node inside the row's text, in the row's own ink.
  await expect(diff).not.toHaveAttribute("data-highlighted");
  expect(held.length).toBeGreaterThan(0);
  const before = await measure();
  const plainInk = await long.evaluate((el) => getComputedStyle(el).color);

  open();
  await expect(diff).toHaveAttribute("data-highlighted", "");
  // `const` now sits in its own span, in a colour that is not the row's text colour.
  const keywordInk = await inkOf("const");
  expect(keywordInk).not.toBeNull();
  expect(keywordInk).not.toBe(plainInk);
  expect(await measure()).toEqual(before);
  await noSidewaysScroll(page);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// Operator decision (2026-09-23): Changes covers the pane's WORKSPACE folder, and the header says
// which one. The space form asks the same list by workspace and returns to the space.
test("the header names the workspace and its folder, and the space form shows the same list", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await expect(page.getByText("webapp · 3 files")).toBeVisible();
  const folder = page.getByText("…/you/webapp");
  await expect(folder).toBeVisible();
  await expect(folder).toHaveAttribute("title", "/home/you/webapp");
  await noSidewaysScroll(page);

  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/workspace/")) asked.push(new URL(r.url()).pathname);
  });
  await page.goto(`/space/${encodeURIComponent(PANE.workspaceId)}/changes`);
  await expect(page.getByText("webapp · 3 files")).toBeVisible();
  await expect(page.getByText("…/you/webapp")).toBeVisible();
  expect(asked).toContain(`/api/workspace/${PANE.workspaceId}/changes`);
  await page.getByRole("button", { name: en["changes.backAria.workspace"] }).click();
  await expect(page).toHaveURL(new RegExp(`/space/${PANE.workspaceId}$`));
});

// ADR 0065 rule 8, the operator's ask (2026-09-23): an open Changes screen re-reads every 5 s while
// the page is visible, so a change shows up without a tap on refresh. The page clock is installed
// before the app loads, so the 5 s pass in one step instead of on the wall clock.
test("the list re-reads on its own and shows a change without a tap", async ({ page }) => {
  await page.clock.install();
  let changed = false;
  const reads: string[] = [];
  const oneRepo: PaneChangesResponse = fixtureChanges.available
    ? { ...fixtureChanges, repos: fixtureChanges.repos.slice(0, 1) }
    : fixtureChanges;
  await page.route(/\/api\/pane\/[^/]+\/changes(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("path")) return route.fallback();
    reads.push(url.search);
    if (!changed) return route.fallback();
    return route.fulfill({ json: oneRepo });
  });

  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await expect(page.getByText("api · 2 files")).toBeVisible();
  await listSettled(page);
  const refresh = page.getByRole("button", { name: en["changes.refreshAria"] });
  const firstRow = page.getByRole("button", { name: /checkout\.tsx/ });
  const before = (await firstRow.boundingBox())!;
  expect(reads).toHaveLength(1);

  // The first beat reads the same list: nothing on screen moves.
  await page.clock.runFor(5000);
  await expect.poll(() => reads.length).toBe(2);
  expect(await firstRow.boundingBox()).toEqual(before);

  // The list changes; the next beat shows it, with no tap on refresh.
  changed = true;
  await page.clock.runFor(5000);
  await expect(page.getByText("api · 2 files")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /orders\.ts/ })).toHaveCount(0);
  await expect(firstRow).toBeVisible();
  await expect(refresh).toBeEnabled();
  expect(reads).toHaveLength(3);
});

// The commit view (ADR 0065, operator decision 2026-09-23): agents commit their own work, so the
// list goes empty right after the change worth reading. The empty list offers the last commit, a
// level down; its file is a level below that, and two swipes back land on the list again.
test("an empty list shows the last commit, its file, and back twice lands on the list", async ({ page }) => {
  await page.route(/\/api\/pane\/[^/]+\/changes(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("view") === "commit" || url.searchParams.has("path")) return route.fallback();
    return route.fulfill({ json: fixtureCleanChanges });
  });
  const list = `/pane/${encodeURIComponent(PANE.paneId)}/changes`;
  await page.goto(list);
  await expect(page.getByText(en["changes.empty"])).toBeVisible();
  const show = page.getByRole("button", { name: en["changes.commit.show"] });
  expect((await show.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await show.click();

  await expect(page).toHaveURL(/\/changes\/commit\?repo=\.$/);
  await expect(page.getByRole("heading", { name: en["changes.commit.title"] })).toBeVisible();
  if (!fixtureCommit.available) throw new Error("fixture");
  const subject = page.getByText(fixtureCommit.commit.subject);
  await expect(subject).toBeVisible();
  await expect(page.getByText(fixtureCommit.commit.shortHash)).toBeVisible();
  await noSidewaysScroll(page);

  await page.getByRole("button", { name: /checkout\.tsx/ }).click();
  await expect(page).toHaveURL(/\/changes\/commit\?repo=\.&path=src%2Froutes%2Fcheckout\.tsx$/);
  await expect(page.getByText(/including shipping to/)).toBeVisible();
  await noSidewaysScroll(page);

  await page.goBack();
  await expect(page).toHaveURL(/\/changes\/commit\?repo=\.$/);
  await expect(subject).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/changes$/);
  await expect(page.getByText(en["changes.empty"])).toBeVisible();
});
