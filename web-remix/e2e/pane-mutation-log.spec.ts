import { expect, test, type Page } from "@playwright/test";

import { PANES, stubPaneBridge, TERMINAL_TEXT } from "./pane-api";

// A MUTATION STATE LOG for a row tap (research note 07, c.16: kody's no-flash e2e, here for the glide
// and the two-step pane mount). `pane-quiet` counts renders and `pane-two-step` holds the chrome block
// still; this one records what the DOM actually did, phase by phase, and asserts its SHAPE, so a change
// that lumps the mount back into one task, or that redraws the header on the second step, fails.
// What the log shows (Chromium, 2026-10-07): one batch for the route body, one for the header claim
// (published after commit), and the composer batch two paints later:
//
//   tap      the click
//   glide    `html.glide` goes on at the tap and off when the transition ends (reduced motion: never)
//   step 1   one batch adds the screen and the composer's STAND-IN (and removes the dashboard), and none
//            of the composer, the belt or the keys tray
//   header   the pane's identity claim lands after step 1, before step 2, in the one header
//   step 2   a LATER ANIMATION FRAME adds the composer and the belt and removes only the stand-ins
//
// Counts are logged for the failure message, never asserted as numbers: they move with every feature.

declare global {
  interface Window {
    __mlog: Entry[];
  }
}

interface Entry {
  /** What kind of record this is. */
  kind: "click" | "glide" | "dom";
  t: number;
  /** Animation frames seen so far: two entries in different frames are two paints apart. */
  frame: number;
  /** `glide`: whether `html.glide` is on. */
  on?: boolean;
  /** `dom`: the labelled elements added and removed (`data-slot` or `data-testid`), and element totals. */
  added?: string[];
  removed?: string[];
  addedN?: number;
  removedN?: number;
}

/** From the first byte of the document: a click marker, the `html.glide` class, and every DOM batch. */
async function logMutations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: Entry[] = [];
    window.__mlog = log;
    let frame = 0;
    const tick = (): void => {
      frame++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new MutationObserver((records) => {
      const added: string[] = [];
      const removed: string[] = [];
      let addedN = 0;
      let removedN = 0;
      for (const record of records) {
        for (const [nodes, into] of [
          [record.addedNodes, added],
          [record.removedNodes, removed],
        ] as const) {
          for (const node of nodes) {
            if (!(node instanceof Element) || node.tagName === "SCRIPT") continue;
            const all = [node, ...node.querySelectorAll("*")];
            if (into === added) addedN += all.length;
            else removedN += all.length;
            for (const el of all) {
              const label = el.getAttribute("data-slot") ?? el.getAttribute("data-testid");
              if (label !== null) into.push(label);
            }
          }
        }
      }
      if (addedN + removedN > 0) log.push({ kind: "dom", t: performance.now(), frame, added, removed, addedN, removedN });
    }).observe(document, { childList: true, subtree: true });
    let glide = false;
    const watchHtml = (): void => {
      new MutationObserver(() => {
        const on = /(^|\s)glide(\s|$)/u.test(document.documentElement.className);
        if (on !== glide) {
          glide = on;
          log.push({ kind: "glide", t: performance.now(), frame, on });
        }
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    };
    if (document.documentElement) watchHtml();
    else document.addEventListener("readystatechange", watchHtml, { once: true });
    document.addEventListener("click", () => log.push({ kind: "click", t: performance.now(), frame }), true);
  });
}

const log = (page: Page): Promise<Entry[]> => page.evaluate(() => window.__mlog);

/** The entries from the tap on, in order. */
function sinceTap(all: readonly Entry[]): Entry[] {
  const at = all.findIndex((e) => e.kind === "click");
  expect(at, "the tap was logged").toBeGreaterThanOrEqual(0);
  return all.slice(at);
}

const adds = (e: Entry, label: string): boolean => e.kind === "dom" && (e.added ?? []).includes(label);
const removes = (e: Entry, label: string): boolean => e.kind === "dom" && (e.removed ?? []).includes(label);

/** Why a shape check failed, in one line per entry. */
function describe(entries: readonly Entry[]): string {
  return entries
    .map((e) => (e.kind === "dom" ? `dom f${String(e.frame)} +${String(e.addedN)} -${String(e.removedN)}` : `${e.kind} f${String(e.frame)}${e.on === undefined ? "" : e.on ? " on" : " off"}`))
    .join(" | ");
}

/** The two-step mount, shared by the glided and the plain tap. Returns the two batches for more checks. */
function expectTwoStepMount(entries: readonly Entry[]) {
  const why = describe(entries);
  const step1 = entries.find((e) => adds(e, "chrome-block-standin"));
  const step2 = entries.find((e) => adds(e, "chrome-block"));
  expect(step1, `step 1 added the stand-in: ${why}`).toBeDefined();
  expect(step2, `step 2 added the composer block: ${why}`).toBeDefined();
  if (step1 === undefined || step2 === undefined) throw new Error(why);

  // Step 1: the screen and the stand-in, and nothing of the composer.
  expect(step1.added?.some((l) => l === "terminal-view" || l === "chat-view"), why).toBe(true);
  for (const later of ["chrome-block", "chat-input", "composer-send", "actions-belt", "keys-tray", "bottom-sheet"]) {
    expect(step1.added, `${later} is step two's: ${why}`).not.toContain(later);
  }

  // The header claim: the identity arrives after step 1 and before step 2, once, in the same header.
  const claim = entries.find((e) => adds(e, "pane-title"));
  expect(claim, `the pane's identity claimed the header: ${why}`).toBeDefined();
  expect(entries.indexOf(claim!), why).toBeGreaterThan(entries.indexOf(step1));
  expect(entries.indexOf(claim!), why).toBeLessThan(entries.indexOf(step2));
  expect(
    entries.filter((e) => adds(e, "pane-title")),
    `one identity, drawn once: ${why}`,
  ).toHaveLength(1);
  expect(
    entries.filter((e) => adds(e, "app-header")),
    `the header itself is never redrawn: ${why}`,
  ).toHaveLength(0);

  // Step 2: a later frame, the composer and the belt in, only the stand-in out of the chrome.
  expect(step2.frame, `step 2 is at least a paint after step 1: ${why}`).toBeGreaterThan(step1.frame);
  expect(step2.added, why).toContain("chat-input");
  expect(step2.added, why).toContain("actions-belt");
  expect(step2.added, `step two redraws no part of step one: ${why}`).not.toContain("pane-title");
  expect(step2.removed, why).toContain("chrome-block-standin");
  expect(step2.removed, `step two removes no header or screen: ${why}`).not.toContain("pane-title");
  expect(step2.removed?.some((l) => l === "terminal-view" || l === "chat-view"), why).toBe(false);
  return { step1, step2 };
}

async function openFromHome(page: Page): Promise<void> {
  await page.goto("/");
  const row = page.locator(`[data-testid="pane-row"][data-pane-id="${PANES.chat}"]`);
  await expect(row).toBeVisible();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__mlog.length = 0;
  });
  // A real press and release, as a finger does, so the glide's pointerdown prefetch runs.
  const box = await row.boundingBox();
  if (box === null) throw new Error("no row box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await expect(page.locator('[data-slot="chat-input"]')).toBeVisible();
  await expect(page.locator('[data-slot="chrome-block-standin"]')).toHaveCount(0);
  await page.waitForTimeout(700);
}

test.describe("the row tap's mutation log", () => {
  test.use({ serviceWorkers: "block" });

  test("with the glide: the glide wraps the two steps, and step two waits for the update callback", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
    await logMutations(page);
    await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
    await openFromHome(page);
    const entries = sinceTap(await log(page));
    const why = describe(entries);

    const { step1, step2 } = expectTwoStepMount(entries);
    const on = entries.findIndex((e) => e.kind === "glide" && e.on === true);
    const off = entries.findIndex((e) => e.kind === "glide" && e.on === false);
    expect(on, `the glide started at the tap: ${why}`).toBeGreaterThanOrEqual(0);
    expect(on, `glide on before the route drew: ${why}`).toBeLessThan(entries.indexOf(step1));
    expect(off, `the glide ended: ${why}`).toBeGreaterThan(on);
    // The route and the composer are both in before the transition is over: the morph ends on a finished screen.
    expect(entries.indexOf(step2), `step two is inside the glide: ${why}`).toBeLessThan(off);
    // The old dashboard left in step one's batch or before it, never after step two.
    const home = entries.findIndex((e) => removes(e, "home-scroller"));
    expect(home, `the dashboard left: ${why}`).toBeGreaterThanOrEqual(0);
    expect(home, why).toBeLessThanOrEqual(entries.indexOf(step1));
    // After step two the glide only ends: no further DOM batch adds a labelled part.
    const late = entries.slice(entries.indexOf(step2) + 1).filter((e) => e.kind === "dom" && (e.added ?? []).length > 0);
    expect(late.map((e) => e.added), `nothing labelled arrives after step two: ${why}`).toEqual([]);
  });

  test("reduced motion: no glide, and the same two steps", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
    await logMutations(page);
    await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
    await openFromHome(page);
    const entries = sinceTap(await log(page));
    expect(entries.some((e) => e.kind === "glide"), describe(entries)).toBe(false);
    expectTwoStepMount(entries);
  });
});
