import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { islandsOff } from "./fixtures";
import { PANE_SNAPSHOT, PANES, stubPaneBridge, type StubBridge } from "./pane-api";

// S3, islands and soft navigation (`experiments/remix-v3/ACTION-PLAN.md` B; REMIX3.md "Islands and soft
// navigation"). This file holds the browser checks of the islands document; the glide's two guards from
// research note 12 come first, because they hold for the static shell too.

test.use({ serviceWorkers: "block" });

const PANE_ROW = `[data-testid="pane-row"][data-pane-id="${PANES.plain}"]`;
const PANE_URL = new RegExp(`/pane/${encodeURIComponent(PANES.plain)}$`, "u");

declare global {
  interface Window {
    __collieGlideSkips?: { ua: number };
    __vtCount?: { started: number; skipped: number };
    __sameDocument?: boolean;
    __collieIslandRuns?: { runs: number };
    __collieRefusal?: { reason: string | null; href: string };
    __commit?: { clickAt: number; paneAt: number };
  }
}

test.describe("the glide's Navigation API guards (research note 12)", () => {
  test("without NavigateEvent.sourceElement there is no glide, and a row tap is a document load", async ({ page }) => {
    await page.addInitScript(() => {
      // The fake: a browser with view transitions but without the part of the Navigation API the
      // runtime's navigate() needs (Chrome 123 to 134, iOS 26.1 and older).
      Reflect.deleteProperty(NavigateEvent.prototype, "sourceElement");
      const start = document.startViewTransition;
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value(this: Document, ...args: Parameters<Document["startViewTransition"]>): ViewTransition {
          sessionStorage.setItem("vt-started", String(Number(sessionStorage.getItem("vt-started") ?? "0") + 1));
          return start.apply(this, args);
        },
      });
    });
    await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
    await page.goto("/");
    await expect(page.locator(PANE_ROW)).toBeVisible();
    expect(await page.evaluate(() => "sourceElement" in NavigateEvent.prototype)).toBe(false);
    await page.evaluate(() => (window.__sameDocument = true));
    await page.locator(PANE_ROW).click();
    await expect(page).toHaveURL(PANE_URL);
    await expect(page.getByTestId("pane-title")).toBeVisible();
    // A new document (the marker is gone), and no view transition was ever started for the move.
    expect(await page.evaluate(() => window.__sameDocument ?? false)).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem("vt-started"))).toBeNull();
  });

  test("a traverse the browser animates itself (hasUAVisualTransition) skips the back glide", async ({ page }) => {
    await page.addInitScript(() => {
      // The fake: every traverse says the browser already animated it, as Safari's swipe back does.
      Object.defineProperty(NavigateEvent.prototype, "hasUAVisualTransition", {
        configurable: true,
        get(this: NavigateEvent) {
          return this.navigationType === "traverse";
        },
      });
      const vt = { started: 0, skipped: 0 };
      window.__vtCount = vt;
      const start = document.startViewTransition;
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value(this: Document, ...args: Parameters<Document["startViewTransition"]>): ViewTransition {
          vt.started++;
          const transition = start.apply(this, args);
          const skip = transition.skipTransition.bind(transition);
          transition.skipTransition = () => {
            vt.skipped++;
            skip();
          };
          return transition;
        },
      });
    });
    await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
    await page.goto("/");
    await page.locator(PANE_ROW).click();
    await expect(page.getByTestId("pane-title")).toBeVisible();
    await page.waitForTimeout(800);
    const before = await page.evaluate(() => ({ ...(window.__vtCount ?? { started: 0, skipped: 0 }), ua: window.__collieGlideSkips?.ua ?? 0 }));
    // The in-app back arrow glides back with history.back(), a traverse.
    await page.getByTestId("header-home").click();
    await expect(page.locator(PANE_ROW)).toBeVisible();
    await expect(page).toHaveURL(/\/$/u);
    const after = await page.evaluate(() => ({ ...(window.__vtCount ?? { started: 0, skipped: 0 }), ua: window.__collieGlideSkips?.ua ?? 0 }));
    expect(after.ua).toBe(before.ua + 1);
    // The arrow started a glide, and it was skipped the moment the traverse said it was animated.
    expect(after.started - before.started).toBe(1);
    expect(after.skipped - before.skipped).toBe(after.started - before.started);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("glide"))).toBe(false);
  });
});

// ── The islands document (S3) ─────────────────────────────────────────────────────────────────────
//
// `e2e/serve.ts` draws `/` and `/pane/:paneId` as the bridge does once a spec posted a snapshot to
// `/__ssr` and the request carries `e2e-ssr=1`; a pane whose text was posted to `/__pane` gets its
// read in the document and its frames. The two panes used here run a harness with no session journal,
// so neither shows Chat and both are drawn as islands pages (ssr/islands-document.tsx).

// Another harness with no session journal, so its page is an islands page too (opencode would show Chat).
const SECOND = PANES.closing;
const SECOND_ROW = `[data-testid="pane-row"][data-pane-id="${SECOND}"]`;
const SCREENS = { [PANES.plain]: "ready\n> ", [SECOND]: "second pane\n> " } satisfies Record<string, string>;

async function islandsDocuments(context: BrowserContext, page: Page, baseURL: string, label?: string): Promise<StubBridge> {
  const agents = PANE_SNAPSHOT.agents.map((a) => (label !== undefined && a.paneId === PANES.plain ? { ...a, paneLabel: label } : a));
  const posted = await context.request.post(`${baseURL}/__ssr`, { data: { snapshot: { ...PANE_SNAPSHOT, agents, ts: Date.now() }, config: { push: false, vapidPublicKey: "" } } });
  expect(posted.status()).toBe(204);
  await context.request.post(`${baseURL}/__pane`, { data: { reset: true } });
  for (const [paneId, text] of Object.entries(SCREENS)) await context.request.post(`${baseURL}/__pane`, { data: { paneId, text } });
  await context.addCookies([{ name: "e2e-ssr", value: "1", url: baseURL }]);
  return stubPaneBridge(page, SCREENS);
}

/** The JS the page fetched so far: requests and decoded bytes (`e2e/serve.ts` does not compress). */
async function jsLoaded(page: Page): Promise<{ requests: number; bytes: number }> {
  return page.evaluate(() => {
    const js = performance.getEntriesByType("resource").filter((e): e is PerformanceResourceTiming => e instanceof PerformanceResourceTiming && /\.js(\?|$)/u.test(e.name));
    return { requests: js.length, bytes: js.reduce((sum, e) => sum + e.decodedBodySize, 0) };
  });
}

test.describe("the islands document (S3)", () => {
  test("is marked, carries the islands and no client-rendered list, and loads less than half the JS of the full client", async ({ page, context, baseURL, browser }) => {
    await islandsDocuments(context, page, baseURL!);
    const answer = await page.goto("/");
    expect(answer?.headers()["x-collie-document"]).toBe("islands");
    expect(answer?.headers()["x-collie-build"]).toBeTruthy();
    await expect(page.locator(PANE_ROW)).toBeVisible();
    const atRow = await jsLoaded(page);
    await page.waitForTimeout(1_500);
    const settled = await jsLoaded(page);
    expect(await page.evaluate(() => window.__collieIslandRuns?.runs)).toBe(1);
    // The document keeps <html>'s class, style and lang across a soft navigation, and <body>'s app
    // its `inert` (ssr/islands-layout.tsx).
    expect(await page.locator("html").getAttribute("data-rmx-preserve-attrs")).toBe("class style lang");
    expect(await page.locator('[data-slot="app-body"]').getAttribute("data-rmx-preserve-attrs")).toBe("inert");

    const full = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const spa = await full.newPage();
    await islandsDocuments(full, spa, baseURL!);
    await islandsOff(full, baseURL!);
    await spa.goto("/");
    await expect(spa.locator(PANE_ROW)).toBeVisible();
    await spa.waitForTimeout(1_500);
    const whole = await jsLoaded(spa);
    await full.close();
    console.log(`islands JS: at first row ${String(atRow.requests)} requests ${String(Math.round(atRow.bytes / 1024))} KiB, settled ${String(settled.requests)} requests ${String(Math.round(settled.bytes / 1024))} KiB; full client ${String(whole.requests)} requests ${String(Math.round(whole.bytes / 1024))} KiB`);
    expect(settled.bytes).toBeLessThanOrEqual(whole.bytes / 2);
    expect(settled.requests).toBeLessThanOrEqual(14);
  });

  test("soft navigation: home to pane and back in one document, run() once, focus landed, <html> class kept", async ({ page, context, baseURL }) => {
    await islandsDocuments(context, page, baseURL!);
    await page.goto("/");
    await expect(page.locator(PANE_ROW)).toBeVisible();
    await page.evaluate(() => {
      window.__sameDocument = true;
      document.documentElement.classList.add("e2e-kept");
    });
    await page.locator(PANE_ROW).click();
    await expect(page).toHaveURL(PANE_URL);
    await expect(page.getByTestId("pane-title")).toBeVisible();
    await expect(page.getByTestId("pane-screen-island")).toContainText("ready");
    expect(await page.evaluate(() => window.__sameDocument ?? false)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.classList.contains("e2e-kept"))).toBe(true);
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null)).toBe(true);

    await page.goBack();
    await expect(page).toHaveURL(/\/$/u);
    await expect(page.locator(PANE_ROW)).toBeVisible();
    expect(await page.evaluate(() => window.__sameDocument ?? false)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.classList.contains("e2e-kept"))).toBe(true);
    expect(await page.evaluate(() => window.__collieIslandRuns?.runs)).toBe(1);
  });

  test("the composer keeps a draft per pane across soft navigations", async ({ page, context, baseURL }) => {
    await islandsDocuments(context, page, baseURL!);
    await page.goto("/");
    await page.locator(PANE_ROW).click();
    await expect(page).toHaveURL(PANE_URL);
    const box = page.locator('[data-slot="chat-input"]');
    await expect(box).toBeEnabled();
    await box.fill("draft for the first pane");
    await page.waitForTimeout(400);
    await page.goBack();
    await expect(page.locator(SECOND_ROW)).toBeVisible();
    await page.locator(SECOND_ROW).click();
    await expect(page.getByTestId("pane-screen-island")).toContainText("second pane");
    await expect(box).toBeEnabled();
    await expect(box).toHaveValue("");
    await page.goBack();
    await expect(page.locator(PANE_ROW)).toBeVisible();
    await page.locator(PANE_ROW).click();
    await expect(page).toHaveURL(PANE_URL);
    await expect(box).toHaveValue("draft for the first pane");
    expect(await page.evaluate(() => window.__collieIslandRuns?.runs)).toBe(1);
  });

  test("a prefetched tap does not wait: the pane is in the page within one frame (16 ms)", async ({ page, context, baseURL }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await islandsDocuments(context, page, baseURL!);
    await page.goto("/");
    const row = page.locator(PANE_ROW);
    await expect(row).toBeVisible();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const mark = { clickAt: 0, paneAt: 0 };
      window.__commit = mark;
      document.addEventListener("click", () => (mark.clickAt = performance.now()), true);
      new MutationObserver(() => {
        if (mark.clickAt > 0 && mark.paneAt === 0 && document.querySelector('[data-testid="pane-view"]') !== null) mark.paneAt = performance.now();
      }).observe(document.body, { childList: true, subtree: true });
    });
    // The press prefetches (islands/gestures.tsx); the tap comes once the answer is in.
    const box = await row.boundingBox();
    await page.mouse.move(box!.x + 40, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForResponse((r) => r.url().endsWith(`/pane/${encodeURIComponent(PANES.plain)}`));
    await page.waitForTimeout(200);
    await page.mouse.up();
    await expect(page.getByTestId("pane-view")).toBeVisible();
    const mark = await page.evaluate(() => window.__commit!);
    const commit = mark.paneAt - mark.clickAt;
    console.log(`islands: prefetched tap to pane in the page ${commit.toFixed(1)} ms`);
    expect(commit).toBeGreaterThan(0);
    expect(commit).toBeLessThan(16);
  });

  test("the home list follows the snapshot through its frame, not a document load", async ({ page, context, baseURL }) => {
    await islandsDocuments(context, page, baseURL!);
    await page.goto("/");
    await expect(page.locator(PANE_ROW)).toBeVisible();
    await page.evaluate(() => (window.__sameDocument = true));
    await islandsDocuments(context, page, baseURL!, "renamed by the beat");
    await expect(page.locator(PANE_ROW)).toContainText("renamed by the beat", { timeout: 15_000 });
    expect(await page.evaluate(() => window.__sameDocument ?? false)).toBe(true);
    const beats = await (await context.request.get(`${baseURL!}/__beats`)).json();
    expect(beats.beats).toBeGreaterThan(0);
  });
});

test.describe("the resolver refuses what is not this build's islands document (note 10, 6.3)", () => {
  const cases: { name: string; reason: string; answer: (route: import("@playwright/test").Route) => Promise<void> }[] = [
    { name: "a 5xx", reason: "status", answer: (route) => route.fulfill({ status: 502, body: "bad gateway" }) },
    { name: "a page without the marker (a proxy's page, the static shell after a 403)", reason: "not-a-document", answer: (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>proxy</title>" }) },
    { name: "another build", reason: "build-skew", answer: async (route) => {
      const real = await route.fetch();
      await route.fulfill({ response: real, headers: { ...real.headers(), "x-collie-build": "some-other-build" } });
    } },
    { name: "a fetch that fails", reason: "network", answer: (route) => route.abort("internetdisconnected") },
  ];
  for (const c of cases) {
    test(`${c.name} becomes a document load of the same URL`, async ({ page, context, baseURL }) => {
      await islandsDocuments(context, page, baseURL!);
      const logs: string[] = [];
      page.on("console", (msg) => logs.push(msg.text()));
      await page.goto("/");
      await expect(page.locator(PANE_ROW)).toBeVisible();
      let refused = 0;
      await page.route(`**/pane/${encodeURIComponent(PANES.plain)}`, async (route) => {
        const req = route.request();
        // Only the runtime's own fetch (prefetch or navigation): the document load after it goes through.
        if (req.headers()["x-remix-frame"] === "true" && req.headers()["x-remix-target"] === undefined) {
          refused++;
          return c.answer(route);
        }
        return route.continue();
      });
      await page.evaluate(() => (window.__sameDocument = true));
      await page.locator(PANE_ROW).click();
      await expect(page).toHaveURL(PANE_URL);
      await expect(page.getByTestId("pane-title")).toBeVisible();
      expect(refused).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.__sameDocument ?? false)).toBe(false);
      expect(logs.some((line) => line.includes(`Collie: ${c.reason}, loading`))).toBe(true);
    });
  }
});

test.describe("the islands document with JavaScript off", () => {
  test("rows are links to their panes and the header leads home", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await islandsDocuments(context, page, baseURL!);
    await page.goto("/");
    const row = page.locator(PANE_ROW);
    await expect(row).toBeVisible();
    expect(await row.evaluate((el) => el.tagName)).toBe("A");
    await row.click();
    await expect(page).toHaveURL(PANE_URL);
    await expect(page.getByTestId("pane-view")).toBeVisible();
    await expect(page.getByTestId("pane-title")).toBeVisible();
    await page.getByTestId("header-home").click();
    await expect(page).toHaveURL(/\/$/u);
    await expect(row).toBeVisible();
    await context.close();
  });
});
