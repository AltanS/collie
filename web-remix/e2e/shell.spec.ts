import { expect, test, type Page } from "@playwright/test";

import { PANES, stubPaneBridge } from "./pane-api";

// The shell kit at the phone size: one header across screens (the mark is the same node and its
// animation never restarts), the pane's claim, the up control, the sheet's drag-dismiss, the hold,
// Collapse moving what is below it smoothly, and the slide with and without reduced motion.

// What the spec parks on the page between steps.
declare global {
  interface Window {
    __mark?: Element;
    __anim?: Animation;
    __hold?: string[];
    __tops?: number[];
    __vt?: number;
  }
}

const MARK_SVG = '[data-testid="header-home"] [data-slot="collie-mark"] svg';
const pane = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;

async function openHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("pane-row").first()).toBeVisible();
}

async function openPaneFromHome(page: Page, paneId: string): Promise<void> {
  await page.locator(`[data-testid="pane-row"][data-pane-id="${paneId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/pane/${encodeURIComponent(paneId)}$`, "u"));
  await expect(page.getByTestId("pane-title")).toBeVisible();
}

test("one header on home and pane: the mark node and its animation survive the navigation", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> ", [PANES.walk]: "x\n" });
  await openHome(page);
  await expect(page.locator('[data-slot="app-header"]')).toHaveCount(1);
  await expect(page.getByTestId("settings-gear")).toBeVisible();
  const before = await page.evaluate((sel) => {
    const svg = document.querySelector(sel);
    if (!(svg instanceof SVGSVGElement)) throw new Error("no mark");
    const anim = svg.getAnimations({ subtree: true })[0];
    if (!anim) throw new Error("the mark has no running animation");
    window.__mark = svg;
    window.__anim = anim;
    return Number(anim.currentTime);
  }, MARK_SVG);

  await openPaneFromHome(page, PANES.plain);
  await page.waitForTimeout(300);
  await expect(page.locator('[data-slot="app-header"]')).toHaveCount(1);
  const after = await page.evaluate((sel) => {
    const svg = document.querySelector(sel);
    const anim = window.__anim;
    return {
      sameNode: svg === window.__mark,
      sameAnimation: anim !== undefined && svg instanceof SVGSVGElement && svg.getAnimations({ subtree: true }).includes(anim),
      running: anim?.playState,
      time: Number(anim?.currentTime),
    };
  }, MARK_SVG);
  expect(after.sameNode).toBe(true);
  expect(after.sameAnimation).toBe(true);
  expect(after.running).toBe("running");
  expect(after.time).toBeGreaterThan(before + 250);
});

test("the pane claims the header: name and workspace, no gear, no tab bar; the mark goes up", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await openHome(page);
  await openPaneFromHome(page, PANES.plain);
  const header = page.locator('[data-slot="app-header"]');
  await expect(header.getByTestId("pane-title")).toHaveText("some-new-harness");
  await expect(header.getByTestId("pane-place")).toContainText("website");
  // The ⋮ draws only once the pane route passes `onOpen` (its menu sheet is a later screen).
  await expect(page.getByTestId("settings-gear")).toHaveCount(0);
  // No bottom Chat/Terminal tab bar on the pane any more.
  await expect(page.getByRole("navigation").getByRole("button", { name: "Terminal" })).toHaveCount(0);

  const up = page.getByTestId("header-home");
  await expect(up).toHaveAttribute("aria-label", /^Back to the/u);
  await up.click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByTestId("pane-row").first()).toBeVisible();
  await expect(page.getByTestId("settings-gear")).toBeVisible();
});

test("the override row's back arrow starts where the mark starts (web/ aligns both at the row's 16 px inset)", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await openHome(page);
  const markLeft = await page.locator('[data-testid="header-home"] [data-slot="collie-mark"]').evaluate((el) => el.getBoundingClientRect().left);
  expect(markLeft).toBe(16);
  await page.getByTestId("settings-gear").click();
  const back = page.getByTestId("header-back");
  await expect(back).toBeVisible();
  const backLeft = await back.evaluate((el) => el.getBoundingClientRect().left);
  // web/ draws the arrow as a plain size-11 button in a `pl-4` row, no negative margin.
  expect(backLeft).toBe(markLeft);
});

test("dashboard to pane slides in, the browser's own back does not", async ({ page }) => {
  // A row tap glides by default; the kill switch keeps this case on the plain screen slide.
  await page.addInitScript(() => {
    Object.assign(globalThis, { __collieGlide: false });
  });
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await openHome(page);
  await openPaneFromHome(page, PANES.plain);
  const screen = page.locator('[data-slot="screen-transition"]');
  await expect(screen).toHaveAttribute("data-move", "forward");
  expect(await screen.evaluate((el) => getComputedStyle(el).animationName)).not.toBe("none");
  await page.goBack();
  await expect(page.getByTestId("pane-row").first()).toBeVisible();
  await expect(screen).toHaveAttribute("data-move", "none");
});

test("a row tap on the dashboard runs the glide, a view transition, not the slide", async ({ page }) => {
  // Count the document's view transitions: only glideForwardWhenReady starts one on a row tap.
  await page.addInitScript(() => {
    window.__vt = 0;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (cb) => {
      window.__vt = (window.__vt ?? 0) + 1;
      return start(cb);
    };
  });
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await openHome(page);
  await openPaneFromHome(page, PANES.plain);
  expect(await page.evaluate(() => window.__vt)).toBeGreaterThanOrEqual(1);
  // The glide names its parts for one transition only, and clears them when it ends.
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-glide]")].filter((el) => el.style.viewTransitionName !== "").length))
    .toBe(0);
});

test("reduced motion disables the slide", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await openHome(page);
  await openPaneFromHome(page, PANES.plain);
  const screen = page.locator('[data-slot="screen-transition"]');
  expect(await screen.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await screen.evaluate((el) => el.getAnimations().length)).toBe(0);
});

test("a long press shows data-holding, then dispatches app:longpress", async ({ page }) => {
  await stubPaneBridge(page, {});
  await openHome(page);
  const chip = page.getByRole("button", { name: /^(?:.* )?collie$/u }).first();
  await expect(chip).toBeVisible();
  await chip.evaluate((el) => {
    const seen: string[] = [];
    window.__hold = seen;
    el.addEventListener("app:longpress", () => seen.push(`press:${String(el.hasAttribute("data-holding"))}`));
  });
  const box = await chip.boundingBox();
  if (!box) throw new Error("no chip box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(chip).toHaveAttribute("data-holding", "");
  expect(await page.evaluate(() => window.__hold)).toEqual([]);
  // The event fires at 450 ms, and the look has ended by then (the handler saw no data-holding).
  await expect.poll(() => page.evaluate(() => window.__hold)).toEqual(["press:false"]);
  await page.mouse.up();
  // The chip's long-press action ran: the workspace is now hidden (the chip is struck through).
  await expect(page.locator("button.line-through", { hasText: "collie" })).toHaveCount(1);
});

test("Collapse moves what is below it over frames, never in one jump", async ({ page }) => {
  const stub = await stubPaneBridge(page, { [PANES.plain]: "ready\n> " }, { unpaired: true });
  await page.goto(pane(PANES.plain));
  const below = page.getByTestId("pane-text");
  await expect(below).toBeVisible();
  const start = await below.evaluate((el) => el.getBoundingClientRect().top);
  // Sample the top of the screen below the notice on every frame from the moment of the send.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="pane-text"]');
    const tops: number[] = [];
    window.__tops = tops;
    const t0 = performance.now();
    const tick = (): void => {
      if (el) tops.push(el.getBoundingClientRect().top);
      if (performance.now() - t0 < 900) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('[data-slot="chat-input"]').fill("hello");
  await page.getByTestId("composer-send").click();
  await expect.poll(() => stub.writes.length).toBe(1);
  await expect(page.getByTestId("pane-unpaired")).toBeVisible();
  await page.waitForTimeout(1000);
  const tops = await page.evaluate(() => window.__tops ?? []);
  const end = tops.at(-1) ?? start;
  const total = end - start;
  expect(total).toBeGreaterThan(20);
  const steps = new Set(tops.map((t) => Math.round(t))).size;
  expect(steps).toBeGreaterThanOrEqual(4);
  let biggest = 0;
  for (let i = 1; i < tops.length; i++) biggest = Math.max(biggest, Math.abs((tops[i] ?? 0) - (tops[i - 1] ?? 0)));
  expect(biggest).toBeLessThan(total * 0.6);
});

test.describe("the bottom sheet on touch", () => {
  test.use({ hasTouch: true });

  test("a drag under 90 px snaps back, past 90 px dismisses", async ({ page }) => {
    await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
    await page.route(/\/api\/pane\/[^/]+\/(reply|keys)$/u, (route) => route.fulfill({ status: 500, body: "the bridge fell over" }));
    await page.goto(pane(PANES.plain));
    await page.locator('[data-slot="chat-input"]').fill("hello");
    await page.getByTestId("composer-send").click();
    const status = page.locator('[data-slot="app-header"] [data-slot="header-status"]');
    await expect(status).toBeVisible();
    await status.locator("button").first().click();
    const sheet = page.getByTestId("bottom-sheet");
    await expect(sheet).toHaveAttribute("data-state", "open");
    await page.waitForTimeout(300); // the entrance

    const panel = sheet.locator('[data-slot="sheet-panel"]');
    const box = await panel.boundingBox();
    if (!box) throw new Error("no panel box");
    const cdp = await page.context().newCDPSession(page);
    const drag = async (distance: number): Promise<void> => {
      const x = box.x + box.width / 2;
      const y = box.y + 10;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let d = 10; d <= distance; d += 10) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + d }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };

    await drag(60);
    await page.waitForTimeout(400);
    await expect(sheet).toHaveAttribute("data-state", "open");
    expect(await panel.evaluate((el) => el.style.transform)).toBe("");

    await drag(130);
    await expect(sheet).toHaveCount(0);
  });
});

test("the browser's translator class on <html> shows the translation notice, and it leaves with the class", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await openHome(page);
  const notice = page.getByTestId("translation-notice");
  await expect(notice).toHaveCount(0);
  await page.evaluate(() => document.documentElement.classList.add("translated-ltr"));
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(/Translation is on/u);
  await page.evaluate(() => document.documentElement.classList.remove("translated-ltr"));
  await expect(notice).toHaveCount(0);
  await page.evaluate(() => document.documentElement.classList.add("translated-rtl"));
  await expect(notice).toBeVisible();
});
