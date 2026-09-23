import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { ChangesResponse } from "@/lib/types";
import { fixtureChanges } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// A TAP ON A CHANGES TAB ROW CARRIES ITS NUMBERS INTO THE SCREEN (operator, 2026-09-23). On a phone
// at 375x812: the workspace screen's header shows the row's own count on its first frame, the list
// waits on skeleton rows and then shows the real ones without moving the header, identical
// re-reads touch nothing, and the tap starts one view transition where the engine has them while
// the phone's own back starts none. The header's back arrow runs the glide in reverse, from the
// header back down into the row, and crossfades without names when that row is off screen
// (lib/glide.ts).

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

/**
 * What one view transition looked like. A name is `<view-transition-name>@<side>`, the side being
 * the origin row's `data-glide-key` or `destination` for the header.
 */
interface GlideRecord {
  /** `<html>`'s classes right after the start call. */
  startClasses: string;
  /** The names on the page when the "before" picture is taken. */
  oldNames: string[];
  /** `<html>`'s classes, the names, and the running pseudo-element animations once it is ready. */
  readyClasses?: string;
  newNames?: string[];
  pseudos?: string[];
  skipped?: boolean;
  done?: boolean;
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
    /** One entry per view transition the page started, in order (`recordGlides`). */
    glides?: GlideRecord[];
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

/**
 * Count every `document.startViewTransition` call the page makes, from its first script on, and
 * record what each looked like at its start, once ready, and once finished (`GlideRecord`).
 */
async function countStarts(page: Page) {
  await page.addInitScript(
    ({ origin, destination }) => {
      window.glideStarts = 0;
      window.glides = [];
      if (!("startViewTransition" in document)) return;
      const names = () =>
        [...document.querySelectorAll<HTMLElement>("*")]
          .filter((el) => el.style.viewTransitionName !== "")
          .map((el) => {
            const row = el.closest<HTMLElement>(`[${origin}]`);
            const side = row?.dataset.glideKey ?? (el.closest(`[${destination}]`) ? "destination" : "other");
            return `${el.style.viewTransitionName}@${side}`;
          })
          .toSorted();
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (arg) => {
        window.glideStarts = (window.glideStarts ?? 0) + 1;
        const transition = start(arg);
        const record: GlideRecord = { startClasses: document.documentElement.className, oldNames: names() };
        window.glides?.push(record);
        void (async () => {
          try {
            await transition.ready;
          } catch {
            record.skipped = true;
            return;
          }
          record.readyClasses = document.documentElement.className;
          record.newNames = names();
          record.pseudos = document
            .getAnimations()
            .flatMap((a) => (a.effect instanceof KeyframeEffect && a.effect.pseudoElement ? [a.effect.pseudoElement] : []));
          record.skipped = false;
        })();
        void transition.finished.finally(() => {
          record.done = true;
        });
        return transition;
      };
    },
    // The engine's two side markers (lib/glide.ts), handed in: the init script runs in the page.
    { origin: "data-glide-origin", destination: "data-glide-destination" },
  );
}

/** The glide records so far, once the `n`th (1-based) has finished. */
async function glidesDone(page: Page, n: number): Promise<GlideRecord[]> {
  await expect.poll(() => page.evaluate((i) => window.glides?.[i]?.done === true, n - 1)).toBe(true);
  return (await page.evaluate(() => window.glides)) ?? [];
}

/** Nothing of a glide outlives it: no class on `<html>` and no inline name anywhere. */
async function expectNoGlideLeft(page: Page) {
  await expect(page.locator("html.glide")).toHaveCount(0);
  const named = await page.evaluate(
    () => [...document.querySelectorAll<HTMLElement>("*")].filter((el) => el.style.viewTransitionName !== "").length,
  );
  expect(named).toBe(0);
}

const backArrow = (page: Page) => page.getByRole("button", { name: en["changes.backAria.dashboard"] });
const W1 = "/space/w1/changes";

test("the tap starts one view transition, and the phone's own back starts none", async ({ page }) => {
  await countStarts(page);
  await routeChanges(page, { ms: 0 });
  await openTab(page);
  const supported = await page.evaluate(() => "startViewTransition" in document);
  await tabRows(page).first().click();
  await expect(page).toHaveURL(/\/space\/w1\/changes$/u);
  await expect(page.locator(HEADER_COUNT)).toContainText("5 files");
  expect(await page.evaluate(() => window.glideStarts)).toBe(supported ? 1 : 0);
  if (supported) {
    const [forward] = await glidesDone(page, 1);
    expect(forward!.startClasses.split(" ")).toEqual(expect.arrayContaining(["glide", "glide-changes"]));
    expect(forward!.startClasses.split(" ")).not.toContain("glide-back");
    expect(forward!.oldNames).toEqual([`glide-changes-count@${W1}`, `glide-changes-label@${W1}`]);
    expect(forward!.newNames).toEqual(["glide-changes-count@destination", "glide-changes-label@destination"]);
    expect(forward!.skipped).toBe(false);
  }
  await expectNoGlideLeft(page);

  // An unmarked POP, the phone's own back: no transition at all, the phone animates it alone.
  await page.goBack();
  await expect(tabRows(page).first()).toContainText("5 files");
  expect(await page.evaluate(() => window.glideStarts)).toBe(supported ? 1 : 0);
  await expectNoGlideLeft(page);
});

test("the header's back arrow glides the label and count back down into the tab row", async ({ page }) => {
  await countStarts(page);
  await routeChanges(page, { ms: 0 });
  await openTab(page);
  const supported = await page.evaluate(() => "startViewTransition" in document);
  await tabRows(page).first().click();
  await expect(page).toHaveURL(new RegExp(`${W1}$`, "u"));
  await expect(page.locator(HEADER_COUNT)).toContainText("5 files");
  if (supported) await glidesDone(page, 1);

  await backArrow(page).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(tabRows(page).first()).toContainText("5 files");
  expect(await page.evaluate(() => window.glideStarts)).toBe(supported ? 2 : 0);
  if (!supported) return;
  const back = (await glidesDone(page, 2))[1]!;
  expect(back.startClasses.split(" ")).toEqual(expect.arrayContaining(["glide", "glide-changes", "glide-back"]));
  // The header's two parts leave, and the very row that was tapped takes them.
  expect(back.oldNames).toEqual(["glide-changes-count@destination", "glide-changes-label@destination"]);
  expect(back.readyClasses).not.toContain("glide-crossfade");
  expect(back.newNames).toEqual([`glide-changes-count@${W1}`, `glide-changes-label@${W1}`]);
  expect(back.skipped).toBe(false);
  // Where the engine lists the transition's own animations, both parts fly as a pair of snapshots.
  if (back.pseudos!.length > 0) {
    expect(back.pseudos).toEqual(
      expect.arrayContaining([
        "::view-transition-group(glide-changes-label)",
        "::view-transition-new(glide-changes-label)",
        "::view-transition-new(glide-changes-count)",
      ]),
    );
  }
  await expectNoGlideLeft(page);
});

test("the back arrow crossfades without names when the tab row is off screen", async ({ page }) => {
  await countStarts(page);
  await routeChanges(page, { ms: 0 });
  await openTab(page);
  const supported = await page.evaluate(() => "startViewTransition" in document);
  test.skip(!supported, "no view transitions in this engine: covered by the plain-navigation cases");
  await tabRows(page).first().click();
  await expect(page.locator(HEADER_COUNT)).toContainText("5 files");
  await glidesDone(page, 1);
  // The phone turns, or the keyboard takes the bottom of the screen: the dashboard comes back too
  // short to show the row where scroll memory keeps the list.
  await page.setViewportSize({ width: 375, height: SHORT });

  await backArrow(page).click();
  await expect(page).toHaveURL(/\/$/u);
  const back = (await glidesDone(page, 2))[1]!;
  // The premise: the row really is out of sight in the arrived dashboard.
  expect(await rowOnScreen(page)).toBe(false);
  expect(back.startClasses.split(" ")).toEqual(expect.arrayContaining(["glide", "glide-back"]));
  expect(back.readyClasses).toContain("glide-crossfade");
  expect(back.newNames).toEqual([]);
  expect(back.pseudos!.filter((p) => p.startsWith("::view-transition-new(glide-changes-"))).toEqual([]);
  expect(back.skipped).toBe(false);
  await expectNoGlideLeft(page);
});

/** A viewport too short for the dashboard's scroller to show its first Changes row. */
const SHORT = 150;

/** Whether the first Changes row is wholly inside the viewport and the dashboard's scroller. */
async function rowOnScreen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-glide-origin="changes"]');
    if (!row) return false;
    const r = row.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    for (let p = row.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const c = p.getBoundingClientRect();
      top = Math.max(top, c.top);
      bottom = Math.min(bottom, c.bottom);
    }
    return r.height > 0 && r.top >= top && r.bottom <= bottom;
  });
}

test("with reduced motion the tap navigates with no view transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await countStarts(page);
  await routeChanges(page, { ms: 0 });
  await openTab(page);
  await tabRows(page).first().click();
  await expect(page.locator(HEADER_COUNT)).toContainText("5 files");
  expect(await page.evaluate(() => window.glideStarts)).toBe(0);
});
