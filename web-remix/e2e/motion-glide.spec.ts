import { expect, test, type Page } from "@playwright/test";

import { PANES, stubPaneBridge } from "./pane-api";
import { changesStub } from "./routes-changes-api";
import { installRoutesApi } from "./routes-api";

// Route motion (MOTION-GAPS.md, package 1): the row-to-header glide runs as a morph, not a frozen
// screen and a crossfade. Chromium runs no animation frames while a view transition's update callback
// is pending, so the glide holds frames (lib/store.ts `holdFrames`) and the arriving header draws on a
// timer inside the callback (REMIX3.md, "Frames during a view transition"). A sampler logs every
// animation frame and every 10 ms: the longest gap between two frames is the freeze a person sees.

test.use({ serviceWorkers: "block" });

interface Sample {
  t: number;
  raf: boolean;
  html: string;
  busy: number;
  anims: string[];
}

declare global {
  interface Window {
    __glideSamples?: Sample[];
    __glideT0?: number;
  }
}

/** Start the sampler for `ms`: one row per animation frame and per 10 ms tick. */
async function sample(page: Page, ms: number): Promise<void> {
  await page.evaluate((span) => {
    const log: Sample[] = [];
    window.__glideSamples = log;
    const t0 = performance.now();
    window.__glideT0 = t0;
    const take = (raf: boolean): void => {
      const bar = document.querySelector<HTMLElement>(".busy-bar");
      log.push({
        t: performance.now() - t0,
        raf,
        html: document.documentElement.className,
        busy: bar ? Number(getComputedStyle(bar).opacity) : 0,
        anims: document
          .getAnimations()
          .map((a) => (a instanceof CSSAnimation ? a.animationName : ""))
          .filter((n) => n.includes("glide")),
      });
    };
    const end = t0 + span;
    const frame = (): void => {
      take(true);
      if (performance.now() < end) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const tick = setInterval(() => {
      if (performance.now() >= end) clearInterval(tick);
      else take(false);
    }, 10);
  }, ms);
}

/** Press and release on `selector`'s first match, as a finger does; returns the release time. */
async function tap(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  return page.evaluate(() => performance.now() - (window.__glideT0 ?? 0));
}

interface Verdict {
  maxGap: number;
  crossfade: boolean;
  glideSeen: boolean;
  glideGoneAt: number | null;
  busyMax: number;
  anims: string[];
}

async function verdict(page: Page, from: number): Promise<Verdict> {
  const log = await page.evaluate(() => window.__glideSamples ?? []);
  const frames = log.filter((s) => s.raf && s.t >= from - 20).map((s) => s.t);
  const gaps = frames.slice(1).map((t, i) => t - (frames[i] ?? t));
  const glided = log.filter((s) => /(^|\s)glide(\s|$)/u.test(s.html));
  const last = glided.at(-1);
  return {
    maxGap: Math.max(0, ...gaps),
    crossfade: log.some((s) => s.html.includes("glide-crossfade")),
    glideSeen: glided.length > 0,
    glideGoneAt: last === undefined ? null : last.t - from,
    busyMax: Math.max(0, ...log.map((s) => s.busy)),
    anims: [...new Set(log.flatMap((s) => s.anims))],
  };
}

const PANE_ROW = `[data-testid="pane-row"][data-pane-id="${PANES.plain}"]`;

test("a pane row tap morphs the row into the header: no crossfade, no frame gap over 150 ms", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto("/");
  await expect(page.locator(PANE_ROW)).toBeVisible();
  await page.waitForTimeout(300);
  await sample(page, 1500);
  const up = await tap(page, PANE_ROW);
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent(PANES.plain)}$`, "u"));
  await page.waitForTimeout(1300);
  const v = await verdict(page, up);
  expect(v.glideSeen).toBe(true);
  expect(v.crossfade).toBe(false);
  expect(v.anims).toContain("-ua-view-transition-group-anim-glide-pane-name");
  expect(v.maxGap).toBeLessThan(150);
  expect(v.glideGoneAt).not.toBeNull();
  expect(v.glideGoneAt ?? Infinity).toBeLessThan(700);
  // The pending bar never shows for an instant navigation (it flashed for 40 ms at the end of the freeze).
  expect(v.busyMax).toBe(0);
  // The arriving screen drew from the prefetched read: the pane's text is there at once.
  await expect(page.locator('[data-slot="screen-transition"]')).toContainText("ready");
});

test("the pane's back arrow morphs the header back into its row", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto("/");
  await page.locator(PANE_ROW).click();
  await expect(page.getByTestId("pane-title")).toBeVisible();
  await page.waitForTimeout(800);
  await sample(page, 1200);
  const up = await tap(page, '[data-testid="header-home"]');
  await expect(page.locator(PANE_ROW)).toBeVisible();
  await page.waitForTimeout(900);
  const v = await verdict(page, up);
  expect(v.glideSeen).toBe(true);
  expect(v.crossfade).toBe(false);
  expect(v.anims).toContain("-ua-view-transition-group-anim-glide-pane-name");
  expect(v.maxGap).toBeLessThan(150);
});

test("a slow pane read gives up the glide and slides the pane in", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.route(`**/api/pane/${encodeURIComponent(PANES.plain)}*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fallback();
  });
  await page.goto("/");
  await expect(page.locator(PANE_ROW)).toBeVisible();
  await sample(page, 1200);
  await tap(page, PANE_ROW);
  const screen = page.locator('[data-slot="screen-transition"]');
  await expect(screen).toHaveAttribute("data-move", "forward");
  const enter = await screen.evaluate((el) =>
    el.getAnimations().map((a) => ({ name: a instanceof CSSAnimation ? a.animationName : "", duration: a.effect?.getTiming().duration })),
  );
  expect(enter).toContainEqual({ name: "enter", duration: 240 });
  await page.waitForTimeout(600);
  const v = await verdict(page, 0);
  expect(v.glideSeen).toBe(false);
});

test("reduced motion: no glide and no slide", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto("/");
  await expect(page.locator(PANE_ROW)).toBeVisible();
  await sample(page, 800);
  await tap(page, PANE_ROW);
  await expect(page.getByTestId("pane-title")).toBeVisible();
  await page.waitForTimeout(400);
  const v = await verdict(page, 0);
  expect(v.glideSeen).toBe(false);
  expect(await page.locator('[data-slot="screen-transition"]').evaluate((el) => el.getAnimations().length)).toBe(0);
});

/** The dashboard on its Files tab, with the Changes segment on, against the wave-4 stub bridge. */
async function filesTab(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("collie:dash-prefs:v1") === null) {
      window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "changes", changesOnly: true }));
    }
  });
  await installRoutesApi(page, [changesStub()]);
  await page.goto("/");
  await expect(page.getByTestId("files-row").first()).toBeVisible();
  await page.waitForTimeout(300);
}

test("a Files row glides its label into the Changes header, and the back arrow glides it home", async ({ page }) => {
  await filesTab(page);
  await sample(page, 1300);
  const up = await tap(page, '[data-testid="files-row"]');
  await expect(page).toHaveURL(/\/space\/w1\/changes$/u);
  await expect(page.locator('[data-glide-destination="changes"] [data-glide="label"]')).toBeVisible();
  await page.waitForTimeout(1100);
  const forward = await verdict(page, up);
  expect(forward.glideSeen).toBe(true);
  expect(forward.crossfade).toBe(false);
  expect(forward.anims).toContain("-ua-view-transition-group-anim-glide-changes-label");
  expect(forward.maxGap).toBeLessThan(150);

  await sample(page, 1200);
  const back = await tap(page, '[data-testid="header-back"]');
  await expect(page.getByTestId("files-row").first()).toBeVisible();
  await page.waitForTimeout(900);
  const home = await page.evaluate(() => window.__glideSamples ?? []);
  expect(home.some((s) => s.html.includes("glide-back"))).toBe(true);
  const reverse = await verdict(page, back);
  expect(reverse.crossfade).toBe(false);
  expect(reverse.anims).toContain("-ua-view-transition-group-anim-glide-changes-label");
});
