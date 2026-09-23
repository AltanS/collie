import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { ChangesResponse } from "@/lib/types";
import { fixtureChanges } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// A TAP ON A CHANGES TAB ROW CARRIES ITS NUMBERS INTO THE SCREEN (operator, 2026-09-23). On a phone
// at 375x812: the workspace screen's header shows the row's own count on its first frame, the list
// waits on skeleton rows and then shows the real ones without moving the header, identical
// re-reads touch nothing, and the tap starts one view transition where the engine has them while
// the phone's own back starts none.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const CHANGES = new RegExp(`^${en["changes.title"]}$`, "u");
const tabRows = (page: Page) => page.getByRole("list", { name: en["home.changes.listAria"] }).getByRole("button");
const HEADER_COUNT = '[data-slot="header-row"] [data-slot="count-line"]';

/**
 * Answer each workspace's list: webapp (w1) has the shared fixture, collie is clean. While
 * `slow.ms` is set, every answer waits that long first.
 */
async function routeChanges(page: Page, slow: { ms: number }) {
  const clean: ChangesResponse = { workspaceId: "w2", available: true, root: "/home/you/collie", truncated: false, repos: [] };
  await page.route("**/api/workspace/*/changes*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]!);
    if (slow.ms > 0) await new Promise((r) => setTimeout(r, slow.ms));
    await route
      .fulfill({ contentType: "application/json", body: JSON.stringify(id === "w1" ? fixtureChanges : clean) })
      .catch(() => {});
  });
}

async function openTab(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: en["home.tabs.aria"] }).getByRole("button", { name: CHANGES }).click();
  await expect(tabRows(page).first()).toContainText("5 files");
}

interface Frame {
  count: string;
  state: string;
  skeleton: boolean;
  rows: boolean;
  top: number;
  left: number;
}

declare global {
  interface Window {
    /** One entry per animation frame in which the Changes header's count line was on screen. */
    glideFrames?: Frame[];
    /** How many view transitions the page started. */
    glideStarts?: number;
    /** Every DOM mutation since the quiet-beats observer was armed. */
    quietMutations?: string[];
  }
}

/** Sample the header's count line on every frame from now on. */
async function sampleFrames(page: Page) {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    window.glideFrames = frames;
    const tick = () => {
      const line = document.querySelector<HTMLElement>('[data-slot="header-row"] [data-slot="count-line"]');
      if (line) {
        const r = line.getBoundingClientRect();
        frames.push({
          count: line.textContent ?? "",
          state: line.dataset.state ?? "",
          skeleton: document.querySelector('[data-slot="changes-skeleton"]') !== null,
          rows: document.querySelector('main [data-slot="list-group"] button') !== null,
          top: r.top,
          left: r.left,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test("the header shows the tab's numbers on its first frame, and the list's skeleton gives way without moving it", async ({
  page,
}) => {
  const slow = { ms: 0 };
  await routeChanges(page, slow);
  await openTab(page);
  const tabCount = (await tabRows(page).first().locator('[data-slot="count-line"]').textContent()) ?? "";
  expect(tabCount).toContain("5 files");
  expect(tabCount).toContain("+10 −2");

  slow.ms = 900;
  await sampleFrames(page);
  await tabRows(page).first().click();
  await expect(page).toHaveURL(/\/space\/w1\/changes$/u);
  await expect(page.getByRole("button", { name: /checkout\.tsx/ })).toBeVisible();
  await expect(page.locator('[data-slot="changes-skeleton"]')).toHaveCount(0);

  const frames = (await page.evaluate(() => window.glideFrames)) ?? [];
  expect(frames.length).toBeGreaterThan(2);
  // The first frame: the tab's own numbers, without motion, over a list still on its skeleton.
  expect(frames[0]).toMatchObject({ count: tabCount, state: "still", skeleton: true, rows: false });
  // Skeleton rows first, real rows after, and the header's count line never moved on the way.
  expect(frames.some((f) => f.skeleton)).toBe(true);
  expect(frames.at(-1)).toMatchObject({ skeleton: false, rows: true, count: tabCount, state: "still" });
  for (const f of frames) {
    expect(Math.abs(f.top - frames[0]!.top)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(f.left - frames[0]!.left)).toBeLessThanOrEqual(0.5);
  }
  // The rows arrive with the tab's fade: opacity and a 3px settle.
  const arrive = page.locator("main .count-arrive");
  await expect(arrive).toHaveCount(1);
  expect(await arrive.evaluate((e) => getComputedStyle(e).animationName)).toBe("count-arrive");
});

test("a first visit with nothing kept holds a skeleton in the header's count line too", async ({ page }) => {
  await routeChanges(page, { ms: 900 });
  await page.goto("/space/w1/changes");
  const line = page.locator(HEADER_COUNT);
  await expect(line).toHaveAttribute("data-state", "loading");
  await expect(page.locator('[data-slot="changes-skeleton"]')).toBeVisible();
  const before = (await line.boundingBox())!;
  await expect(line).toHaveAttribute("data-state", "arrive");
  await expect(line).toContainText("5 files");
  const after = (await line.boundingBox())!;
  for (const k of ["x", "y", "height"] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(0.5);
});

/** Advance the page clock in short steps with real time between them (see changes-poll.spec.ts). */
async function advance(page: Page, ms: number) {
  for (let t = 0; t < ms; t += 250) {
    await page.clock.runFor(250);
    await page.waitForTimeout(15);
  }
}

test("identical re-reads of the workspace screen change not one node", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  page.on("request", (r) => {
    if (/\/api\/workspace\/w1\/changes/u.test(r.url())) reads++;
  });
  await routeChanges(page, { ms: 0 });
  await page.goto("/space/w1/changes");
  await expect(page.getByRole("button", { name: /checkout\.tsx/ })).toBeVisible();
  await advance(page, 1000);
  await page.evaluate(() => {
    const seen: string[] = [];
    window.quietMutations = seen;
    new MutationObserver((l) => {
      for (const m of l) seen.push(`${m.type} on ${m.target.nodeName}`);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  for (let i = 0; i < 3; i++) {
    const before = reads;
    await advance(page, 5000);
    expect(reads).toBeGreaterThan(before);
  }
  expect(await page.evaluate(() => window.quietMutations)).toEqual([]);
});

/** Count every `document.startViewTransition` call the page makes, from its first script on. */
async function countStarts(page: Page) {
  await page.addInitScript(() => {
    window.glideStarts = 0;
    if (!("startViewTransition" in document)) return;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (arg) => {
      window.glideStarts = (window.glideStarts ?? 0) + 1;
      return start(arg);
    };
  });
}

test("the tap starts one view transition, and the phone's own back starts none", async ({ page }) => {
  await countStarts(page);
  await routeChanges(page, { ms: 0 });
  await openTab(page);
  const supported = await page.evaluate(() => "startViewTransition" in document);
  await tabRows(page).first().click();
  await expect(page).toHaveURL(/\/space\/w1\/changes$/u);
  await expect(page.locator(HEADER_COUNT)).toContainText("5 files");
  expect(await page.evaluate(() => window.glideStarts)).toBe(supported ? 1 : 0);
  // Nothing of the glide outlives it.
  await expect(page.locator("html.changes-glide")).toHaveCount(0);

  await page.goBack();
  await expect(tabRows(page).first()).toContainText("5 files");
  expect(await page.evaluate(() => window.glideStarts)).toBe(supported ? 1 : 0);
});

test("with reduced motion the tap navigates with no view transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await countStarts(page);
  await routeChanges(page, { ms: 0 });
  await openTab(page);
  await tabRows(page).first().click();
  await expect(page.locator(HEADER_COUNT)).toContainText("5 files");
  expect(await page.evaluate(() => window.glideStarts)).toBe(0);
});
