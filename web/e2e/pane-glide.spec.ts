import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// A PANE ROW GLIDES INTO THE PANE SCREEN, AND BACK (operator, 2026-09-23: "if we do one, we should do
// it right"). On a phone at 375x812: a tap on a dashboard or space row starts one view transition in
// which the row's dot, tile and name fly into the pane header (lib/glide.ts, the `pane` pair); the
// header's back arrow, the Collie mark, flies them back down into the row; the phone's own back
// starts none. The pane route's loader awaits a read, so the row starts that read on `pointerdown`
// (lib/pane-prefetch.ts), and a read not in within READY_WAIT_MS opens the pane the plain way, with
// the slide, and never holds a frozen screen.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const PANE_A = `/pane/${encodeURIComponent("w1:p1")}`;
const PANE_B = `/pane/${encodeURIComponent("w2:p1")}`;

/** A pane row on the dashboard or in a space, by its agent name. */
const paneRow = (page: Page, agent: "claude" | "codex") =>
  page.getByRole("main").getByRole("button", { name: new RegExp(`^${agent} logo ${agent}`, "u") });
/** The pane header's way up: the Collie mark. */
const backArrow = (page: Page) => page.getByRole("button", { name: en["nav.home.aria.default"] });
const screen = (page: Page) => page.locator("[data-slot='screen-transition']");
const paneName = (page: Page) => page.locator('[data-slot="pane-name"]');

async function landed(page: Page, path: string) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
}

/** One view transition, as the page saw it. A name is `<view-transition-name>@<side>`. */
interface PaneGlideRecord {
  startClasses: string;
  oldNames: string[];
  readyClasses?: string;
  newNames?: string[];
  pseudos?: string[];
  skipped?: boolean;
  done?: boolean;
  /** `performance.now()` at the start call, once ready, and once finished. */
  startAt: number;
  readyAt?: number;
  doneAt?: number;
}

/** One ResizeObserver callback entry: which element (by a stable tag), its size, and when. */
interface Resize {
  target: string;
  width: number;
  height: number;
  at: number;
}

declare global {
  interface Window {
    glideStarts?: number;
    paneGlides?: PaneGlideRecord[];
    resizes?: Resize[];
    /** `performance.now()` of every animation frame since `sampleFrames`. */
    frameTimes?: number[];
    /** The first frame that painted the pane header's name (`sampleFrames`). */
    paneAt?: number;
    /** When the tap's `pointerdown` and `click` reached the document (`tapTimes`). */
    tapTimes?: { down: number; click: number };
  }
}

/**
 * Count and record every view transition from the page's first script on (the changes-glide spec's
 * pattern), and every ResizeObserver callback, so a case can ask whether the transition made any
 * observed box report a new size.
 */
async function instrument(page: Page) {
  await page.addInitScript(
    ({ origin, destination }) => {
      window.glideStarts = 0;
      window.paneGlides = [];
      window.resizes = [];
      const tags = new WeakMap<Element, string>();
      let next = 0;
      const tag = (el: Element) => {
        let t = tags.get(el);
        if (t === undefined) {
          t = `${el.tagName.toLowerCase()}#${next++}`;
          tags.set(el, t);
        }
        return t;
      };
      const RO = window.ResizeObserver;
      window.ResizeObserver = class extends RO {
        constructor(cb: ResizeObserverCallback) {
          super((entries, observer) => {
            const at = performance.now();
            for (const e of entries) {
              window.resizes?.push({ target: tag(e.target), width: e.contentRect.width, height: e.contentRect.height, at });
            }
            cb(entries, observer);
          });
        }
      };
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
        const record: PaneGlideRecord = {
          startClasses: document.documentElement.className,
          oldNames: names(),
          startAt: performance.now(),
        };
        window.paneGlides?.push(record);
        void (async () => {
          try {
            await transition.ready;
          } catch {
            record.skipped = true;
            return;
          }
          record.readyAt = performance.now();
          record.readyClasses = document.documentElement.className;
          record.newNames = names();
          record.pseudos = document
            .getAnimations()
            .flatMap((a) => (a.effect instanceof KeyframeEffect && a.effect.pseudoElement ? [a.effect.pseudoElement] : []));
          record.skipped = false;
        })();
        void transition.finished.finally(() => {
          record.doneAt = performance.now();
          record.done = true;
        });
        return transition;
      };
    },
    { origin: "data-glide-origin", destination: "data-glide-destination" },
  );
}

/** The glide records so far, once the `n`th (1-based) has finished. */
async function glidesDone(page: Page, n: number): Promise<PaneGlideRecord[]> {
  await expect.poll(() => page.evaluate((i) => window.paneGlides?.[i]?.done === true, n - 1)).toBe(true);
  return (await page.evaluate(() => window.paneGlides)) ?? [];
}

const starts = (page: Page) => page.evaluate(() => window.glideStarts ?? 0);
const supports = (page: Page) => page.evaluate(() => "startViewTransition" in document);

/** Nothing of a glide outlives it: no class on `<html>` and no inline name anywhere. */
async function expectNoGlideLeft(page: Page) {
  await expect(page.locator("html.glide")).toHaveCount(0);
  const named = await page.evaluate(
    () => [...document.querySelectorAll<HTMLElement>("*")].filter((el) => el.style.viewTransitionName !== "").length,
  );
  expect(named).toBe(0);
}

/** Record when the next `pointerdown` and `click` reach the document. */
async function tapTimes(page: Page) {
  await page.evaluate(() => {
    const t = { down: 0, click: 0 };
    window.tapTimes = t;
    document.addEventListener("pointerdown", () => (t.down = performance.now()), { capture: true, once: true });
    document.addEventListener("click", () => (t.click = performance.now()), { capture: true, once: true });
  });
}

/** Record the time of every animation frame from now on. A frozen screen is a gap between two. */
async function sampleFrames(page: Page) {
  await page.evaluate(() => {
    const times: number[] = [];
    window.frameTimes = times;
    window.paneAt = undefined;
    const tick = (t: number) => {
      times.push(t);
      if (window.paneAt === undefined && document.querySelector('[data-slot="pane-name"]')) window.paneAt = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** The longest gap between two frames in `[from, to]`, in ms. */
async function longestFrameGap(page: Page, from: number, to: number): Promise<number> {
  return page.evaluate(
    ([a, b]) => {
      const t = (window.frameTimes ?? []).filter((x) => x >= a && x <= b);
      let gap = 0;
      for (let i = 1; i < t.length; i++) gap = Math.max(gap, t[i]! - t[i - 1]!);
      return gap;
    },
    [from, to] as const,
  );
}

const W1 = PANE_A;
const THREE = (side: string) => [`glide-pane-dot@${side}`, `glide-pane-name@${side}`, `glide-pane-tile@${side}`];

test("a dashboard row glides its dot, tile and name into the pane header, with no slide", async ({ page }, testInfo) => {
  await instrument(page);
  await page.goto("/");
  const supported = await supports(page);
  await expect(paneRow(page, "claude")).toBeVisible();
  await tapTimes(page);
  await sampleFrames(page);
  const tapAt = await page.evaluate(() => performance.now());
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  await expect(paneName(page)).toBeVisible();
  expect(await starts(page)).toBe(supported ? 1 : 0);
  if (!supported) return;
  const [forward] = await glidesDone(page, 1);
  expect(forward!.startClasses.split(" ")).toEqual(expect.arrayContaining(["glide", "glide-pane"]));
  expect(forward!.startClasses.split(" ")).not.toContain("glide-back");
  expect(forward!.oldNames).toEqual(THREE(W1));
  expect(forward!.newNames).toEqual(THREE("destination"));
  expect(forward!.readyClasses).not.toContain("glide-crossfade");
  expect(forward!.skipped).toBe(false);
  if (forward!.pseudos!.length > 0) {
    expect(forward!.pseudos).toEqual(
      expect.arrayContaining([
        "::view-transition-group(glide-pane-name)",
        "::view-transition-group(glide-pane-tile)",
        "::view-transition-group(glide-pane-dot)",
      ]),
    );
  }
  // The glide owns the move: the arriving screen wears no slide of ours.
  await expect(screen(page)).not.toHaveClass(/animate-in/u);
  // What the tap cost: the screen is still from the transition's start until it is ready, and the
  // read was already in, so that stretch is the render alone. Reported for the ADR.
  const frozen = forward!.readyAt! - forward!.startAt;
  const gap = await longestFrameGap(page, tapAt, forward!.doneAt!);
  const taps = await page.evaluate(() => window.tapTimes!);
  testInfo.annotations.push({
    type: "timing",
    description: `pointerdown→click ${Math.round(taps.click - taps.down)}ms, click→start ${Math.round(forward!.startAt - taps.click)}ms, start→ready ${Math.round(frozen)}ms, longest frame gap ${Math.round(gap)}ms`,
  });
  expect(frozen).toBeLessThan(400);
  await expectNoGlideLeft(page);
});

test("the heavy screen crossfades as one picture: no observed box reports a new size during the glide", async ({ page }, testInfo) => {
  await instrument(page);
  await page.goto("/");
  test.skip(!(await supports(page)), "no view transitions in this engine");
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  const [forward] = await glidesDone(page, 1);
  // Everything the pane screen observes (the mirror's scroller, the belt, the composer's box) may
  // report once, its first size, inside the transition. A second, different size for one element
  // inside that window would be the transition re-laying the screen out.
  const resizes = (await page.evaluate(() => window.resizes)) ?? [];
  const inside = resizes.filter((r) => r.at >= forward!.startAt && r.at <= forward!.doneAt!);
  const byTarget = new Map<string, Set<string>>();
  for (const r of inside) {
    const sizes = byTarget.get(r.target) ?? new Set<string>();
    sizes.add(`${Math.round(r.width)}x${Math.round(r.height)}`);
    byTarget.set(r.target, sizes);
  }
  for (const [target, sizes] of byTarget) expect(sizes.size, target).toBe(1);
  testInfo.annotations.push({
    type: "resizes",
    description: `${inside.length} callbacks on ${byTarget.size} boxes inside the transition, ${resizes.length} in all`,
  });
  // The composer is not focused by the glide (it never autofocuses on open).
  const focusedTextbox = await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA");
  expect(focusedTextbox).toBe(false);
});

test("the back arrow glides the header's parts back down into the very row, and the draft survives both ways", async ({
  page,
}) => {
  await instrument(page);
  await page.goto("/");
  const supported = await supports(page);
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  const box = page.getByRole("textbox", { name: en["composer.placeholder.reply"] });
  await box.fill("half a thought");
  if (supported) await glidesDone(page, 1);

  await backArrow(page).click();
  await landed(page, "/");
  await expect(paneRow(page, "claude")).toBeVisible();
  expect(await starts(page)).toBe(supported ? 2 : 0);
  if (supported) {
    const back = (await glidesDone(page, 2))[1]!;
    expect(back.startClasses.split(" ")).toEqual(expect.arrayContaining(["glide", "glide-pane", "glide-back"]));
    expect(back.oldNames).toEqual(THREE("destination"));
    expect(back.readyClasses).not.toContain("glide-crossfade");
    expect(back.newNames).toEqual(THREE(W1));
    expect(back.skipped).toBe(false);
    await expect(screen(page)).not.toHaveClass(/animate-in/u);
    await expectNoGlideLeft(page);
  }

  // Open it again: the composer still holds the draft the operator left.
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  await expect(box).toHaveValue("half a thought");
});

test("the phone's own back starts no transition", async ({ page }) => {
  await instrument(page);
  await page.goto("/");
  const supported = await supports(page);
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  if (supported) await glidesDone(page, 1);
  await page.goBack();
  await landed(page, "/");
  await expect(paneRow(page, "claude")).toBeVisible();
  expect(await starts(page)).toBe(supported ? 1 : 0);
  await expect(screen(page)).not.toHaveClass(/animate-in/u);
  await expectNoGlideLeft(page);
});

test("a space row glides into the pane, and the back arrow glides it back into the space's row", async ({ page }) => {
  await instrument(page);
  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: /^working collie 2 panes/u }).click();
  await landed(page, "/space/w2");
  const supported = await supports(page);
  const before = await starts(page);

  await paneRow(page, "codex").click();
  await landed(page, PANE_B);
  await expect(paneName(page)).toBeVisible();
  expect(await starts(page)).toBe(before + (supported ? 1 : 0));

  await backArrow(page).click();
  await landed(page, "/space/w2");
  await expect(paneRow(page, "codex")).toBeVisible();
  expect(await starts(page)).toBe(before + (supported ? 2 : 0));
  if (!supported) return;
  const all = await glidesDone(page, before + 2);
  const [forward, back] = all.slice(before);
  // A space row draws its status as a word, so it has no dot to send: the header's dot fades in on
  // its own, and on the way back fades out with no twin.
  expect(forward!.oldNames).toEqual([`glide-pane-name@${PANE_B}`, `glide-pane-tile@${PANE_B}`]);
  expect(forward!.newNames).toEqual(THREE("destination"));
  expect(back!.startClasses.split(" ")).toContain("glide-back");
  expect(back!.oldNames).toEqual(THREE("destination"));
  expect(back!.readyClasses).not.toContain("glide-crossfade");
  expect(back!.newNames).toEqual([`glide-pane-name@${PANE_B}`, `glide-pane-tile@${PANE_B}`]);
  await expectNoGlideLeft(page);
});

test("the back arrow crossfades without names when the row is off screen", async ({ page }) => {
  await instrument(page);
  await page.goto("/");
  test.skip(!(await supports(page)), "no view transitions in this engine");
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  await glidesDone(page, 1);
  // The phone turns, or the keyboard takes the bottom of the screen: the dashboard comes back too
  // short to show the row.
  await page.setViewportSize({ width: 375, height: 150 });
  await backArrow(page).click();
  await landed(page, "/");
  const back = (await glidesDone(page, 2))[1]!;
  expect(await rowOnScreen(page)).toBe(false);
  expect(back.startClasses.split(" ")).toEqual(expect.arrayContaining(["glide", "glide-back"]));
  expect(back.readyClasses).toContain("glide-crossfade");
  expect(back.newNames).toEqual([]);
  expect(back.skipped).toBe(false);
  await expectNoGlideLeft(page);
});

/** Whether the claude row is wholly inside the viewport and every clipping ancestor. */
async function rowOnScreen(page: Page): Promise<boolean> {
  return page.evaluate((key) => {
    const row = [...document.querySelectorAll<HTMLElement>('[data-glide-origin="pane"]')].find(
      (el) => el.dataset.glideKey === key,
    );
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
  }, W1);
}

test("a slow pane read opens the plain way, with the slide, and the screen never freezes", async ({ page }, testInfo) => {
  await instrument(page);
  // Registered after the stub, so it answers first: every pane read takes 500 ms.
  await page.route(/\/api\/pane\/[^/?]+(\?.*)?$/u, async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.fallback();
  });
  const reads: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/pane\/[^/?]+(\?.*)?$/u.test(r.url())) reads.push(r.headers()["x-collie-seen"] === "1" ? "seen" : "prefetch");
  });
  await page.goto("/");
  await expect(paneRow(page, "claude")).toBeVisible();
  await tapTimes(page);
  await sampleFrames(page);
  const tapAt = await page.evaluate(() => performance.now());
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  await expect(paneName(page)).toBeVisible();
  const arrivedAt = await page.evaluate(() => window.paneAt!);
  expect(await starts(page)).toBe(0);
  // The loader waited on the read the finger started, not on one of its own: one prefetch, and the
  // seen read after it.
  await expect.poll(() => reads).toEqual(["prefetch", "seen"]);
  const taps = await page.evaluate(() => window.tapTimes!);
  testInfo.annotations.push({
    type: "timing",
    description: `slow read: pointerdown→click ${Math.round(taps.click - taps.down)}ms, click→first pane frame ${Math.round(arrivedAt - taps.click)}ms`,
  });
  // The tap cost what the read cost, and no more than the wait on top: the pane's first frame comes
  // within the 500 ms read plus READY_WAIT_MS and a render.
  expect(arrivedAt - taps.down).toBeLessThan(500 + 120 + 200);
  await expect(screen(page)).toHaveClass(/slide-in-from-right/u);
  // Frames kept coming the whole time the read was out: the old screen stayed live.
  const gap = await longestFrameGap(page, tapAt, arrivedAt);
  testInfo.annotations.push({ type: "timing", description: `slow read: longest frame gap ${Math.round(gap)}ms` });
  expect(gap).toBeLessThan(150);
});

test("with reduced motion the tap and the back arrow navigate with no view transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await instrument(page);
  await page.goto("/");
  await paneRow(page, "claude").click();
  await landed(page, PANE_A);
  await backArrow(page).click();
  await landed(page, "/");
  expect(await starts(page)).toBe(0);
});
