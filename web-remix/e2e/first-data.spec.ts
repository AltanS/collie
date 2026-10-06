import { expect, test, type Page } from "@playwright/test";

import { en } from "@web/lib/i18n/messages/en";

import { PANES, stubPaneBridge, TERMINAL_TEXT } from "./pane-api";
import { changesStub } from "./routes-changes-api";
import { installRoutesApi } from "./routes-api";
import { settingsStub } from "./routes-settings-api";

// Package P3 (MOTION-GAPS.md): per-screen first data and motion polish. Every case runs against a
// stub (page.route), so nothing reaches a bridge. A gate holds one read open until the case opens it,
// so "from the first frame until the first text" is watched, not guessed from a timer.
//
//   - A pane never shows an empty screen box: a skeleton stands in from the first frame to the first text.
//   - The view is picked from the stored preference before any answer: Chat chosen never flashes the mirror.
//   - The sheet snaps back over 200 ms ease-out (web's `transform 0.2s ease-out`), not a 350 ms spring.
//   - The toast fades in over 200 ms on `ease`.
//   - A tool card's output folds through Collapse (a 240 ms grid-template-rows transition).
//   - Settings: the update check and the paired devices say they are loading, and the check button is busy.
//   - Changes: the list head's skeleton bars fade out in place, and are never unmounted.

test.use({ serviceWorkers: "block" });

const path = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;

/** A read that waits for `open()`: install it AFTER the stub so it is asked first, then falls through. */
async function hold(page: Page, pattern: RegExp): Promise<{ open: () => void }> {
  const gate = Promise.withResolvers<void>();
  await page.route(pattern, async (route) => {
    await gate.promise;
    await route.fallback();
  });
  return { open: () => gate.resolve() };
}

interface Frame {
  skeleton: boolean;
  skeletonKind: string | null;
  terminal: boolean;
  chat: boolean;
  text: boolean;
  empty: boolean;
  region: number;
}

interface ToastCall {
  duration: unknown;
  easing: unknown;
}
interface Run {
  property: string;
  ms: number;
}

declare global {
  interface Window {
    __firstDataFrames: Frame[];
    __firstDataToast: ToastCall[];
    __firstDataRuns: Run[];
  }
}

/** Sample the pane's body region on every frame from the first one the pane view exists. */
async function sampleFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    window.__firstDataFrames = frames;
    const tick = (): void => {
      const view = document.querySelector('[data-testid="pane-view"]');
      if (view !== null) {
        const skeleton = document.querySelector('[data-slot="screen-skeleton"]');
        const bottom = document.querySelector('[data-slot="bottom-region"]');
        frames.push({
          skeleton: skeleton !== null,
          skeletonKind: skeleton?.getAttribute("data-kind") ?? null,
          terminal: document.querySelector('[data-testid="pane-scroller"]') !== null,
          chat: document.querySelector('[data-testid="chat-stream"]') !== null,
          text: document.querySelector('[data-testid="pane-text"]') !== null,
          empty: document.querySelector('[data-testid="mirror-empty"]') !== null,
          region: bottom === null ? -1 : Math.round(bottom.getBoundingClientRect().top * 10) / 10,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const frames = (page: Page): Promise<Frame[]> => page.evaluate(() => window.__firstDataFrames);

async function terminalPref(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
}

test("Terminal: a skeleton stands in from the first frame to the first text, and nothing under it moves", async ({ page }) => {
  await terminalPref(page);
  await sampleFrames(page);
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  const pane = await hold(page, /\/api\/pane\/[^/]+(\?|$)/u);
  await page.goto(path(PANES.chat));

  const skeleton = page.locator('[data-slot="screen-skeleton"]');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute("data-kind", "terminal");
  await expect(skeleton.locator(".count-skeleton").first()).toBeVisible();
  await page.waitForTimeout(300);
  pane.open();
  await expect(page.getByTestId("pane-text")).toContainText("✓ 12 tests passed");
  await expect(skeleton).toHaveCount(0);
  await page.waitForTimeout(300);

  const seen = await frames(page);
  expect(seen.length).toBeGreaterThan(10);
  // The screen region is never an empty box: every frame has the skeleton or the text (or the empty sentence).
  const bare = seen.filter((f) => !f.skeleton && !f.text && !f.empty);
  expect(bare).toEqual([]);
  expect(seen.some((f) => f.skeleton)).toBe(true);
  // The no-shift rule: the composer block's top edge is one value across the swap.
  const tops = new Set(seen.map((f) => f.region).filter((r) => r >= 0));
  expect([...tops]).toHaveLength(1);
});

test("Terminal skeleton keeps the breathing but not the motion under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await terminalPref(page);
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await hold(page, /\/api\/pane\/[^/]+(\?|$)/u);
  await page.goto(path(PANES.chat));
  const bar = page.locator('[data-slot="screen-skeleton"] .count-skeleton').first();
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});

test("Chat chosen: a chat skeleton until the first answer, and the Terminal never shows first", async ({ page }) => {
  await sampleFrames(page);
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  const chat = await hold(page, /\/api\/pane\/[^/]+\/chat/u);
  await page.goto(path(PANES.chat));

  const skeleton = page.locator('[data-slot="screen-skeleton"]');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute("data-kind", "chat");
  // The mirror read has long answered; the screen still shows the chat's skeleton, not the mirror.
  await page.waitForTimeout(800);
  await expect(page.getByTestId("pane-text")).toHaveCount(0);
  await expect(page.getByTestId("pane-scroller")).toHaveCount(0);
  chat.open();
  await expect(page.getByTestId("chat-stream")).toContainText("Fix the flaky poll test");
  await expect(skeleton).toHaveCount(0);

  const seen = await frames(page);
  expect(seen.filter((f) => f.terminal || f.text)).toEqual([]);
  expect(seen.filter((f) => !f.skeleton && !f.chat)).toEqual([]);
});

test("Chat chosen on a cold open: the snapshot is late too, and still no Terminal", async ({ page }) => {
  await sampleFrames(page);
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  const snapshot = await hold(page, /\/api\/snapshot/u);
  await page.goto(path(PANES.chat));
  await expect(page.locator('[data-slot="screen-skeleton"]')).toHaveAttribute("data-kind", "chat");
  await page.waitForTimeout(500);
  snapshot.open();
  await expect(page.getByTestId("chat-stream")).toContainText("Fix the flaky poll test");
  const seen = await frames(page);
  expect(seen.filter((f) => f.terminal || f.text)).toEqual([]);
});

test("a short pull on a sheet snaps back over 200 ms, ease-out", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto(path(PANES.chat));
  await expect(page.getByTestId("chat-stream")).toBeVisible();
  await page.getByTestId("header-menu").click();
  const panel = page.locator('[data-slot="sheet-panel"]').first();
  await expect(panel).toBeVisible();
  // Let the entrance finish, so the transition below is the snap-back and nothing else.
  await page.waitForTimeout(500);

  const result = await page.evaluate(async () => {
    const node = document.querySelector('[data-slot="sheet-panel"]');
    if (!(node instanceof HTMLElement)) throw new Error("no sheet panel");
    const touch = (y: number) => new Touch({ identifier: 1, target: node, clientX: 20, clientY: y });
    const fire = (type: string, y: number) =>
      node.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
    fire("touchstart", 300);
    fire("touchmove", 320);
    fire("touchmove", 340);
    // A finger is down for frames: the panel must have been drawn at its pulled place before release.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    fire("touchend", 340);
    const style = getComputedStyle(node);
    const moving = node.getAnimations().find((a) => a instanceof CSSTransition && a.transitionProperty === "transform");
    return {
      transition: node.style.transition,
      computed: style.transition,
      duration: moving?.effect?.getComputedTiming().duration ?? null,
      easing: moving?.effect?.getTiming().easing ?? null,
    };
  });
  expect(result.transition).toBe("transform 200ms ease-out");
  expect(result.computed).toMatch(/transform 0\.2s ease-out/u);
  expect(result.duration).toBe(200);
  expect(result.easing).toBe("ease-out");
});

test("a toast fades in over 200 ms on `ease`", async ({ page }) => {
  // Record the options of every WAAPI call made on the toast, so the check holds however fast the fade runs.
  await page.addInitScript(() => {
    const calls: ToastCall[] = [];
    window.__firstDataToast = calls;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      if (this.matches('[data-testid="status-toast"]')) {
        const timing = Object(options);
        calls.push({ duration: timing.duration, easing: timing.easing });
      }
      return animate.call(this, keyframes, options);
    };
  });
  await installRoutesApi(page, [settingsStub().handler]);
  // A refused write (answered in the browser, never sent) is the plainest way to a toast.
  await page.route("**/api/notifications/prefs", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ status: 500, body: "bridge says no" });
    return route.fallback();
  });
  await page.goto("/settings/alerts");
  const blocked = page.getByTestId("notify-card").getByRole("switch", { name: en["settings.notify.blocked.label"] });
  await expect(blocked).toBeEnabled();
  await blocked.click();
  await expect(page.getByTestId("status-toast")).toBeVisible();
  const calls = await page.evaluate(() => window.__firstDataToast);
  expect(calls).toContainEqual({ duration: 200, easing: "ease" });
});

test("a command's output folds in through Collapse, a 240 ms grid-rows transition", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto(path(PANES.chat));
  const stream = page.getByTestId("chat-stream");
  await expect(stream).toContainText("Fix the flaky poll test");
  await stream.locator('[data-slot="tool-group"]').click();
  const card = stream.locator('[data-slot="tool-card"][data-kind="execute"]');
  await expect(card).toBeVisible();
  await page.evaluate(() => {
    const runs: Run[] = [];
    window.__firstDataRuns = runs;
    document.addEventListener("transitionrun", (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-slot="tool-card"]') === null) return;
      runs.push({ property: event.propertyName, ms: Math.round(Number.parseFloat(getComputedStyle(target).transitionDuration) * 1000) });
    }, true);
  });
  await card.getByRole("button").first().click();
  await expect(card.locator('[data-slot="tool-output"]')).toContainText("bun test web/poll.test.ts");
  // The flip to 1fr comes two frames after the mount (Collapse's own start), so wait for the run.
  await expect
    .poll(() => page.evaluate(() => window.__firstDataRuns))
    .toContainEqual({ property: "grid-template-rows", ms: 240 });
});

test("the update check says it is loading, and its button is busy while it runs", async ({ page }) => {
  const stub = await installRoutesApi(page, []);
  const read = await hold(page, /\/api\/update\/check/u);
  await page.goto("/settings/updates");
  const pending = page.getByTestId("update-check-pending");
  await expect(pending).toBeVisible();
  expect(await pending.locator("svg.animate-spin").count()).toBe(1);
  read.open();
  await expect(pending).toHaveCount(0);
  await expect(page.getByTestId("update-check")).toContainText(en["settings.updateCard.upToDate"]);

  // The write is answered in the browser, never sent: after a hold the button is disabled with a spinner.
  const answer = Promise.withResolvers<void>();
  let posted = 0;
  await page.route("**/api/update/check", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted++;
    await answer.promise;
    return route.fulfill({ json: { current: "1.17.0", latest: "1.17.0", checkedAt: Date.now() } });
  });
  const button = page.getByTestId("update-check-button");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toContainText(en["settings.update.checking"]);
  await expect(button.locator("svg.animate-spin")).toHaveCount(1);
  answer.resolve();
  await expect(button).toBeEnabled();
  await expect(button).toContainText(en["settings.update.action"]);
  expect(posted).toBe(1);
  // Only the page's own reads reached the stub's own list; the POST never did.
  expect(stub.writes()).toEqual([]);
});

test("the paired devices card says it is loading until the registry answers", async ({ page }) => {
  await installRoutesApi(page, []);
  const registry = await hold(page, /\/api\/devices/u);
  await page.goto("/settings/system");
  const card = page.getByTestId("paired-devices");
  await expect(card.getByTestId("devices-loading")).toBeVisible();
  await expect(card).not.toContainText(en["settings.devices.description.open"]);
  registry.open();
  await expect(card.getByTestId("devices-loading")).toHaveCount(0);
  await expect(card).toContainText(en["settings.devices.description.open"]);
});

test("the Changes list head holds its skeleton bars in place and fades them out", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true })));
  await installRoutesApi(page, [changesStub()]);
  const list = await hold(page, /\/api\/pane\/[^/]+\/changes(\?|$)/u);
  await page.goto("/pane/w1:p1/changes");
  const head = page.locator('[data-slot="changes-head"]');
  await expect(head).toHaveAttribute("data-state", "loading");
  const bars = head.locator('[data-slot="count-skeleton"]');
  await expect(bars).toHaveCount(2);
  await expect(page.locator('[data-slot="changes-skeleton"]')).toBeVisible();
  list.open();
  await expect(head).toHaveAttribute("data-state", "ready");
  await expect(head.getByText(/2 changed files/u)).toBeVisible();
  // The bars stay mounted and fade (`.count-skeleton--done`); none leaves the flow.
  await expect(bars).toHaveCount(2);
  await expect(bars.first()).toHaveClass(/count-skeleton--done/u);
  await expect.poll(() => bars.first().evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
});
