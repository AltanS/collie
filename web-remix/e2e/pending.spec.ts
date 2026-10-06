import { expect, test, type Page, type Route } from "@playwright/test";

import { PANE_SNAPSHOT as SNAPSHOT, PANES, stubPaneBridge } from "./pane-api";

// Package P2 (docs: experiments/remix-v3/MOTION-GAPS.md, "Package 2"): first connect, the connection
// strip, the Collie mark's operator orbit, and the busy bar. Every request is answered by the spec
// (`page.route`); a write never reaches any bridge. Delays and failures are made in the browser.

declare global {
  interface Window {
    __samples: Sample[];
    __down?: number;
    __answerAt?: number;
  }
}

interface Sample {
  t: number;
  /** "Disconnected" or "No spaces yet." is on screen. */
  verdict: boolean;
  /** The static index.html splash or the app's own cover is up. */
  splash: boolean;
  /** The app's own cover has its mark turning fast. */
  splashLive: boolean;
  /** The header's mark is on the fast orbit. */
  live: boolean;
  /** The busy bar's computed opacity, or null when it is not in the document. */
  bar: number | null;
}

/** A frame-by-frame record of what is on screen, started before the page's own scripts. */
async function sampleFromTheStart(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorded: Sample[] = [];
    window.__samples = recorded;
    const take = (): void => {
      const text = document.body?.innerText ?? "";
      const bar = document.querySelector(".busy-bar");
      recorded.push({
        t: performance.now(),
        verdict: text.includes("Disconnected") || text.includes("No spaces yet."),
        splash: document.querySelector(".boot-splash, [data-slot='boot-splash']") !== null,
        splashLive: document.querySelector("[data-slot='boot-splash'] svg.cm-live") !== null,
        live: document.querySelector("header svg.cm-live") !== null,
        bar: bar instanceof HTMLElement ? Number(getComputedStyle(bar).opacity) : null,
      });
    };
    const loop = (): void => {
      take();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setInterval(take, 10);
    document.addEventListener("pointerdown", () => (window.__down = performance.now()), { capture: true });
  });
}

const samples = (page: Page): Promise<Sample[]> => page.evaluate(() => window.__samples);
async function untilPageTime(page: Page, ms: number): Promise<void> {
  await page.waitForFunction((at) => performance.now() >= at, ms);
}

type Handler = (route: Route, path: string) => Promise<boolean>;

/** The shared stub for the dashboard cases: `handler` may take a request over, else the stub answers. */
async function bridge(page: Page, handler: Handler): Promise<void> {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (await handler(route, path)) return;
    await route.fallback();
  });
}

const snapshotOnly = (path: string): boolean => path === "/api/snapshot";

test("first connect: the splash turns, and no verdict is drawn before the first snapshot answers", async ({ page }) => {
  await sampleFromTheStart(page);
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await page.evaluate(() => (window.__answerAt = performance.now()));
    await route.fulfill({ json: SNAPSHOT });
    return true;
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByTestId("pane-row").first()).toBeVisible({ timeout: 8000 });

  const all = await samples(page);
  const answeredAt = await page.evaluate(() => window.__answerAt ?? 0);
  expect(answeredAt).toBeGreaterThan(1500);
  const before = all.filter((s) => s.t < answeredAt);
  expect(before.length).toBeGreaterThan(20);
  // Never "Disconnected" and never "No spaces yet." until the bridge has said anything.
  expect(before.filter((s) => s.verdict)).toEqual([]);
  // A loading state is up the whole time: the static splash, then the app's cover with its mark turning.
  // (Samples before the parser reaches <body> have nothing to show yet; from the first one on, no gap.)
  const shown = before.slice(before.findIndex((s) => s.splash));
  expect(shown.length).toBeGreaterThan(20);
  expect(shown.every((s) => s.splash)).toBe(true);
  expect(before.some((s) => s.splashLive)).toBe(true);
  // It lets go once the snapshot lands.
  await expect(page.locator("[data-slot='boot-splash']")).toHaveCount(0);
});

test("first connect: the static splash is on screen within 50 ms of the document arriving", async ({ page }) => {
  await sampleFromTheStart(page);
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ json: SNAPSHOT });
    return true;
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByTestId("pane-row").first()).toBeVisible();
  const first = await page.evaluate(() => {
    const [entry] = performance.getEntriesByType("navigation");
    const seen = window.__samples.find((s) => s.splash);
    return {
      arrived: entry instanceof PerformanceNavigationTiming ? entry.responseEnd : 0,
      splashAt: seen?.t ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(first.splashAt - first.arrived).toBeLessThan(50);
});

test("first connect, the bridge unreachable: the splash stays, then Not connected with Retry at 15 s", async ({ page }) => {
  test.setTimeout(40_000);
  await sampleFromTheStart(page);
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    await route.abort("connectionrefused");
    return true;
  });
  await page.goto("/", { waitUntil: "commit" });
  const splash = page.locator("[data-slot='boot-splash']");
  await expect(splash).toHaveAttribute("data-state", "connecting");
  await untilPageTime(page, 14_000);
  await expect(splash).toHaveAttribute("data-state", "connecting");
  await untilPageTime(page, 15_400);
  await expect(splash).toHaveAttribute("data-state", "lost");
  await expect(page.getByTestId("boot-retry")).toBeVisible();
  // Still and dim: a blooming mark would say we are still trying.
  await expect(splash.locator("svg")).toHaveClass(/opacity-40/u);
  await expect(splash.locator("svg.cm-live")).toHaveCount(0);
  expect((await samples(page)).filter((s) => s.verdict)).toEqual([]);
});

test("a 503 from the snapshot: the mark and the amber strip by 4.2 s, red with Retry and a still mark by 15.2 s", async ({ page }) => {
  test.setTimeout(40_000);
  await sampleFromTheStart(page);
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    await route.fulfill({ status: 503, json: { error: "unavailable" } });
    return true;
  });
  await page.goto("/", { waitUntil: "commit" });
  // An HTTP answer, even an error, ends the first connect: the dashboard shows what is true.
  await expect(page.getByTestId("herd-empty")).toBeVisible();
  await expect(page.locator("[data-slot='boot-splash']")).toHaveCount(0);

  const strip = page.getByTestId("connection-strip");
  await expect(strip).toHaveCount(0);
  await untilPageTime(page, 4_300);
  await expect(strip).toHaveAttribute("data-state", "amber");
  await expect(page.locator("header svg.cm-live")).toHaveCount(1);

  await untilPageTime(page, 15_300);
  await expect(strip).toHaveAttribute("data-state", "red");
  await expect(page.getByTestId("connection-retry")).toBeVisible();
  const mark = page.locator("header svg").first();
  await expect(mark).toHaveClass(/opacity-40/u);
  await expect(page.locator("header svg.cm-live")).toHaveCount(0);
});

test("a refused snapshot (401) draws the auth strip with a sign-in link, not the outage clock", async ({ page }) => {
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    await route.fulfill({ status: 401, json: { error: "sign in" } });
    return true;
  });
  await page.goto("/");
  const strip = page.getByTestId("connection-strip");
  await expect(strip).toHaveAttribute("data-state", "auth");
  await expect(strip.getByRole("link")).toHaveAttribute("href", /\/auth\/$/u);
});

test("recovery after a shown bar flashes the green strip for about 1.8 s", async ({ page }) => {
  test.setTimeout(40_000);
  let healthy = false;
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    if (healthy) await route.fulfill({ json: SNAPSHOT });
    else await route.fulfill({ status: 503, json: { error: "unavailable" } });
    return true;
  });
  await page.goto("/");
  const strip = page.getByTestId("connection-strip");
  await expect(strip).toHaveAttribute("data-state", "amber", { timeout: 8000 });
  healthy = true;
  // The beat is 6 s on a quiet herd; a focus re-check is the app's own "look now".
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(strip).toHaveAttribute("data-state", "green", { timeout: 8000 });
  await expect(strip).toHaveCount(0, { timeout: 5000 });
});

test("a tap that starts a read turns the mark fast within 50 ms, and lets go after the answer", async ({ page }) => {
  await sampleFromTheStart(page);
  await bridge(page, async (route, path) => {
    if (!/^\/api\/pane\/[^/]+$/u.test(path)) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fallback();
    await page.evaluate(() => (window.__answerAt = performance.now()));
    return true;
  });
  await page.goto("/");
  const row = page.locator(`[data-testid="pane-row"][data-pane-id="${PANES.plain}"]`);
  await expect(row).toBeVisible();
  await page.waitForTimeout(300);
  expect((await samples(page)).slice(-5).some((s) => s.live)).toBe(false);

  await row.hover();
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await expect(page.getByTestId("pane-title")).toBeVisible();
  // The prefetch and the screen's own read both start cold, so both are first reads and the orbit
  // runs to the LAST answer (about 400 ms after the second started).
  await expect(page.getByTestId("pane-text")).toContainText("ready");
  await page.waitForTimeout(700);
  const lastAnswer = await page.evaluate(() => window.__answerAt ?? 0);
  const all = await samples(page);
  const down = await page.evaluate(() => window.__down ?? 0);
  const firstLive = all.find((s) => s.t >= down && s.live);
  expect(firstLive, "the mark never went fast").toBeDefined();
  expect(firstLive!.t - down).toBeLessThan(50);
  // Gone within 100 ms of the last answer.
  expect(lastAnswer).toBeGreaterThan(down);
  expect(all.filter((s) => s.t > lastAnswer + 100).some((s) => s.live)).toBe(false);
  expect(all.some((s) => s.t > down && s.t < lastAnswer && s.live)).toBe(true);
});

test("an ordinary navigation never shows the busy bar", async ({ page }) => {
  await sampleFromTheStart(page);
  await bridge(page, async () => false);
  await page.goto("/");
  await page.locator(`[data-testid="pane-row"][data-pane-id="${PANES.plain}"]`).click();
  await expect(page.getByTestId("pane-title")).toBeVisible();
  await page.waitForTimeout(300);
  expect((await samples(page)).filter((s) => s.bar !== null)).toEqual([]);
});

test("a send holds the busy bar and the fast mark for the whole write, then lets both go", async ({ page }) => {
  await sampleFromTheStart(page);
  let wrote = 0;
  await bridge(page, async (route, path) => {
    if (route.request().method() !== "POST" || !path.endsWith("/reply")) return false;
    wrote = await page.evaluate(() => performance.now());
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fallback();
    return true;
  });
  await page.goto(`/pane/${encodeURIComponent(PANES.plain)}`);
  const box = page.locator('[data-slot="chat-input"]');
  await expect(box).toBeEnabled();
  await box.fill("run the tests");
  await page.getByTestId("composer-send").click();
  await expect.poll(() => wrote).toBeGreaterThan(0);

  await untilPageTime(page, wrote + 300);
  const mid = await page.evaluate(() => {
    const bar = document.querySelector(".busy-bar");
    return {
      bar: bar instanceof HTMLElement ? Number(getComputedStyle(bar).opacity) : null,
      live: document.querySelector("header svg.cm-live") !== null,
    };
  });
  expect(mid.bar).toBe(1);
  expect(mid.live).toBe(true);

  await untilPageTime(page, wrote + 1000);
  await expect(page.locator(".busy-bar")).toHaveCount(0);
  await expect(page.locator("header svg.cm-live")).toHaveCount(0);
});

test("a poll held 7 s shows the busy bar after 6 s and not before", async ({ page }) => {
  test.setTimeout(30_000);
  await sampleFromTheStart(page);
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    await new Promise((resolve) => setTimeout(resolve, 7000));
    await route.fulfill({ json: SNAPSHOT });
    return true;
  });
  await page.goto("/", { waitUntil: "commit" });
  await untilPageTime(page, 5_800);
  await expect(page.locator(".busy-bar")).toHaveCount(0);
  await untilPageTime(page, 6_400);
  expect(await page.evaluate(() => Number(getComputedStyle(document.querySelector(".busy-bar")!).opacity))).toBe(1);
  await expect(page.getByTestId("pane-row").first()).toBeVisible({ timeout: 4000 });
  await expect(page.locator(".busy-bar")).toHaveCount(0);
});

test("read-only banners: a device the bridge does not authorise sees the strip on home", async ({ page }) => {
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    await route.fulfill({ json: { ...SNAPSHOT, device: { enforced: true, device: null, authorized: false } } });
    return true;
  });
  await page.goto("/");
  await expect(page.getByTestId("read-only-banner")).toHaveAttribute("data-gate", "device");
});

test("the last-seen cache draws the herd the operator left when a cold boot cannot reach the bridge", async ({ page }) => {
  await bridge(page, async (route, path) => {
    if (!snapshotOnly(path)) return false;
    await route.fulfill({ json: SNAPSHOT });
    return true;
  });
  await page.goto("/");
  await expect(page.getByTestId("pane-row").first()).toBeVisible();
  // Same tab, bridge gone: sessionStorage survives the reload, the network does not.
  await page.unroute("**/api/**");
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.reload();
  await expect(page.getByTestId("pane-row").first()).toBeVisible({ timeout: 6000 });
  await expect(page.locator("[data-slot='boot-splash']")).toHaveCount(0);
});
